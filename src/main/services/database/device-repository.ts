/**
 * Device repository — SQLite persistence for the Device domain model.
 *
 * The critical behaviour here is `upsertByIdentity`: a device is identified by
 * `device_uid`, not by IP (spec section 6, appendix C rule 5). When a user adds
 * a box that is already known but has moved to a new address, the correct
 * outcome is "update the connection address", never a second row.
 *
 * Since migration 3 a row also carries its `kind` (product family), because an
 * FA371 acoustic camera and an acoustic box share this table while sharing almost
 * nothing else. Both insert paths go through `writeDevice`, so the columns, the
 * channel seeding and the "identity wins over address" rule cannot drift apart.
 */

import type { Database as SqliteDatabase } from 'better-sqlite3'
import { newChannelId, newDeviceId, now, isFiniteNumber } from '@shared/utils/id'
import type {
  AddDeviceInput,
  Channel,
  ConnectionType,
  Device,
  DeviceInfo,
  DeviceInstallation,
  DeviceKind,
  DeviceStatus,
  SensorType,
  UpdateDeviceInput
} from '@shared/domain/models'
import { CHANNEL_COUNT, SensorType as SensorTypeEnum, isDeviceKind } from '@shared/domain/models'
import { hasInstallation } from '@shared/domain/device-installation'
import { isE2Variant, type E2Variant } from '@shared/domain/e2'
import { isPushSecret } from '@shared/domain/iot-ingest'

// ---------------------------------------------------------------------------
// Row shape + mapping
// ---------------------------------------------------------------------------

interface DeviceRow {
  id: string
  device_uid: string
  kind: string
  name: string
  ip_address: string | null
  http_port: number | null
  mac_address: string | null
  connection_type: string
  firmware_version: string | null
  fpga_version: string | null
  web_version: string | null
  status: string
  last_seen: number | null
  created_at: number
  updated_at: number
  auth_strategy: string | null
  /** v11：安装信息（点位 / 朝向 / 基准分贝），全可空。 */
  gis_latitude: number | null
  gis_longitude: number | null
  azimuth_deg: number | null
  sound_level_db: number | null
  /** v12：听诊盒子族的两代协议（`auscultation` / `airSonar`），NULL = 还没读到过。 */
  e2_variant: string | null
  /**
   * v15：设备推流秘钥（32 位小写十六进制），NULL = 还没生成过。
   *
   * **不进 `Device` 模型**：设备列表、设备详情、悬停卡片都不需要它，而把它塞进 `Device`
   * 就意味着它随每一次 `devices.list()` 过 IPC —— 一条只该在"添加/编辑设备"那个对话框里
   * 出现一次的凭据没有理由到处走。界面要它的时候走 `devices.ingestEndpoint(id)`。
   */
  push_secret: string | null
}

interface ChannelRow {
  id: string
  device_id: string
  channel_index: number
  channel_name: string
  sensor_type: number
  enabled: number
  alarm_profile_id: string | null
  created_at: number
  updated_at: number
}

/** snake_case row -> camelCase domain model. Optional fields only set when present. */
function toDevice(row: DeviceRow): Device {
  const device: Device = {
    id: row.id,
    deviceUid: row.device_uid,
    // Rows written before migration 3 are acoustic boxes by definition, but the
    // column is NOT NULL with that default so this is belt-and-braces: a value the
    // enum does not know would otherwise flow into the UI and route nowhere.
    kind: isDeviceKind(row.kind) ? row.kind : 'acousticBox',
    name: row.name,
    connectionType: row.connection_type as ConnectionType,
    status: row.status as DeviceStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
  if (row.ip_address !== null) device.ip = row.ip_address
  if (row.http_port !== null) device.httpPort = row.http_port
  if (row.mac_address !== null) device.mac = row.mac_address
  if (row.firmware_version !== null) device.firmwareVersion = row.firmware_version
  if (row.fpga_version !== null) device.fpgaVersion = row.fpga_version
  if (row.web_version !== null) device.webVersion = row.web_version
  if (row.last_seen !== null) device.lastSeen = row.last_seen
  /*
   * 安装信息（v11）：四项**只在真的有值时**才出现。全空就不给 `installation` ——
   * 一个四个字段都缺席的空对象会让"这台设备录过点位吗"变成一个看不出来的问题。
   */
  const installation: DeviceInstallation = {}
  if (row.gis_latitude !== null) installation.gisLatitude = row.gis_latitude
  if (row.gis_longitude !== null) installation.gisLongitude = row.gis_longitude
  if (row.azimuth_deg !== null) installation.azimuthDeg = row.azimuth_deg
  if (row.sound_level_db !== null) installation.soundLevelDb = row.sound_level_db
  if (hasInstallation(installation)) device.installation = installation
  /*
   * 听诊盒子族的代次（v12）：只认得出两代之一才给这一格。认不出的字符串（别人动过的库、
   * 以后多出来的一代）当"没读到过"处理 —— 界面据此不会给一台认不出的设备套上 PTZ 配置页。
   */
  if (isE2Variant(row.e2_variant)) device.e2Variant = row.e2_variant
  return device
}

/** Fallback label per family, so a camera is never named "Acoustic Box". */
function defaultNameFor(kind: DeviceKind, ip: string): string {
  if (kind === 'acousticCamera') return `Acoustic Camera ${ip}`
  if (kind === 'auscultationBox') return `Auscultation Box ${ip}`
  return `Acoustic Box ${ip}`
}

/**
 * 听诊盒子族的通道数：**恒为 1**。
 *
 * 依据是手册而不是推断：传输格式写着 "PCM FLOAT, with a channel count of 1"，而且整套接口
 * （`/workmode`、`/system`、`/alarm_log_all`）**没有任何按通道区分的参数**。业主对 FA110 的
 * 说法也是"同一时刻只有一路"。
 */
export const AUSCULTATION_CHANNEL_COUNT = 1

function toChannel(row: ChannelRow): Channel {
  const channel: Channel = {
    id: row.id,
    deviceId: row.device_id,
    channelIndex: row.channel_index,
    channelName: row.channel_name,
    sensorType: row.sensor_type as SensorType,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
  if (row.alarm_profile_id !== null) channel.alarmProfileId = row.alarm_profile_id
  return channel
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class DeviceRepository {
  constructor(private readonly db: SqliteDatabase) {}

  list(): Device[] {
    const rows = this.db
      .prepare<[], DeviceRow>(`SELECT * FROM devices ORDER BY created_at ASC`)
      .all()
    return rows.map(toDevice)
  }

  findById(id: string): Device | undefined {
    const row = this.db.prepare<[string], DeviceRow>(`SELECT * FROM devices WHERE id = ?`).get(id)
    return row ? toDevice(row) : undefined
  }

  /** Identity lookup — the de-duplication path. */
  findByUid(deviceUid: string): Device | undefined {
    const row = this.db
      .prepare<[string], DeviceRow>(`SELECT * FROM devices WHERE device_uid = ?`)
      .get(deviceUid)
    return row ? toDevice(row) : undefined
  }

  /**
   * Register a device, or refresh the connection address of an existing one.
   *
   * @returns the persisted device plus whether this call created it.
   */
  upsertByIdentity(
    input: AddDeviceInput,
    info: DeviceInfo
  ): { device: Device; created: boolean } {
    return this.writeDevice(input, 'acousticBox', {
      deviceUid: info.deviceUid,
      name: info.name,
      mac: info.mac,
      firmwareVersion: info.firmwareVersion,
      fpgaVersion: info.fpgaVersion,
      webVersion: info.webVersion,
      channelCount: info.channelCount
    })
  }

  /**
   * Register an acoustic camera, or refresh the address of one already known.
   *
   * Kept separate from `upsertByIdentity` because the camera has no `DeviceInfo`
   * to give: its open interface has no device-info endpoint, so the uid is minted
   * from the address (`camera-identity.ts`) and there are no channels to seed.
   * Making `DeviceInfo` optional would have blurred that into "a device whose
   * identity happened to be missing", which is a completely different situation.
   */
  upsertCamera(
    input: AddDeviceInput,
    identity: { deviceUid: string; name: string; firmwareVersion?: string }
  ): { device: Device; created: boolean } {
    return this.writeDevice(input, 'acousticCamera', {
      deviceUid: identity.deviceUid,
      name: identity.name,
      firmwareVersion: identity.firmwareVersion,
      // A camera exposes no channel list, so nothing is seeded and any rows left
      // over from a previous life as an acoustic box are explicitly cleared —
      // otherwise the UI would show eight phantom channels for a device that has
      // none, and they would look real.
      channelCount: 0
    })
  }

  /**
   * 登记一台听诊盒子 / 空气声呐（E2 / FA100 / FA110 / SN-16），或者刷新一台已知设备的地址。
   *
   * 与相机那一份分开的理由不同：**这一族有设备信息**（`GET /basic` 给
   * `dev_name` / `dev_type` / `dev_version` / `equip_number`），所以 uid 可能是**设备自己给的**
   * （`equip_number`）而不是我们编的。但它**没有通道表接口** —— 2023 版手册的传输格式写着
   * "通道数 1"，而 SN-16 空气声呐的 `dev_type` 是 `AS16`（16 路，`/realtime_chan` 1..16）。
   *
   * 所以通道行的条数**按设备回话里那个数**（`e2ChannelCountFromModel(dev_type)`，由探针算好
   * 传进来）；算不出来才是 1（2023 版的产品事实）。既不是 0（那会让界面显示"没有通道"，
   * 而它明明有一路音频），也不是恒等于 1（那会让一台 16 通道的声呐在设备表里显示 1 路，
   * 而同一条设备的详情页显示 16 —— 同一条事实两个答案）。
   *
   * ⚠️ `enabled` 是**本机默认值**（`seedChannels` 全给 1），不是设备事实：这一族没有任何
   * 按通道开关的接口。设备表里"已启用 x / y"那一截因此只说明本机认为它开着。
   */
  upsertAuscultation(
    input: AddDeviceInput,
    identity: {
      deviceUid: string
      name: string
      firmwareVersion?: string
      webVersion?: string
      channelCount?: number
    }
  ): { device: Device; created: boolean } {
    const channelCount = identity.channelCount ?? AUSCULTATION_CHANNEL_COUNT
    return this.writeDevice(input, 'auscultationBox', {
      deviceUid: identity.deviceUid,
      name: identity.name,
      firmwareVersion: identity.firmwareVersion,
      webVersion: identity.webVersion,
      channelCount
    })
  }

  /**
   * The single insert/update implementation behind every family.
   *
   * The rule it enforces is the one that matters: an existing `device_uid` is
   * ALWAYS updated in place, never inserted a second time, and the incoming
   * `kind` wins — a device that was added while misidentified can be corrected by
   * adding it again with the right family.
   */
  private writeDevice(
    input: AddDeviceInput,
    kind: DeviceKind,
    identity: {
      deviceUid: string
      name?: string
      mac?: string
      firmwareVersion?: string
      fpgaVersion?: string
      webVersion?: string
      channelCount?: number
    }
  ): { device: Device; created: boolean } {
    const timestamp = now()
    const existing = this.findByUid(identity.deviceUid)

    if (existing) {
      this.db
        .prepare(
          `UPDATE devices
              SET kind = ?, name = ?, ip_address = ?, http_port = ?, mac_address = ?,
                  firmware_version = ?, fpga_version = ?, web_version = ?,
                  status = 'ONLINE', last_seen = ?, updated_at = ?
            WHERE id = ?`
        )
        .run(
          kind,
          input.name?.trim() || identity.name || existing.name,
          input.ip,
          input.httpPort,
          identity.mac ?? existing.mac ?? null,
          identity.firmwareVersion ?? existing.firmwareVersion ?? null,
          identity.fpgaVersion ?? existing.fpgaVersion ?? null,
          identity.webVersion ?? existing.webVersion ?? null,
          timestamp,
          timestamp,
          existing.id
        )
      // Only ever on the camera path, and only to undo a previous mis-identification:
      // an address that used to hold an acoustic box would otherwise keep eight
      // phantom channels that the UI would present as real. The box path is left
      // alone deliberately — re-adding a known box refreshes its address, it does
      // not re-seed channels the user may have reconfigured.
      if (kind === 'acousticCamera') this.clearChannels(existing.id)
      // 听诊盒子同理，但结果不同：它的通道条数按设备回话里的那个数重来 —— 留着上一次的
      // 行数（例如一台 FA8 的 8 行）会让用户以为这台机器有 8 路。
      if (kind === 'auscultationBox') {
        this.clearChannels(existing.id)
        this.seedChannels(existing.id, identity.channelCount ?? AUSCULTATION_CHANNEL_COUNT, timestamp)
      }
      const refreshed = this.findById(existing.id)
      return { device: refreshed ?? existing, created: false }
    }

    const id = newDeviceId()
    const installation = input.installation ?? {}
    const run = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO devices (
             id, device_uid, kind, name, ip_address, http_port, mac_address,
             connection_type, firmware_version, fpga_version, web_version,
             status, last_seen, created_at, updated_at,
             gis_latitude, gis_longitude, azimuth_deg, sound_level_db
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'LAN', ?, ?, ?, 'ONLINE', ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          identity.deviceUid,
          kind,
          input.name?.trim() || identity.name || defaultNameFor(kind, input.ip),
          input.ip,
          input.httpPort,
          identity.mac ?? null,
          identity.firmwareVersion ?? null,
          identity.fpgaVersion ?? null,
          identity.webVersion ?? null,
          timestamp,
          timestamp,
          timestamp,
          // 安装信息（v11）：没填就是 NULL，不是 0 —— 见 `DeviceInstallation` 的注释。
          installation.gisLatitude ?? null,
          installation.gisLongitude ?? null,
          installation.azimuthDeg ?? null,
          installation.soundLevelDb ?? null
        )
      if (kind === 'acousticBox') this.seedChannels(id, identity.channelCount ?? CHANNEL_COUNT, timestamp)
      if (kind === 'auscultationBox') {
        this.seedChannels(id, identity.channelCount ?? AUSCULTATION_CHANNEL_COUNT, timestamp)
      }
    })
    run()

    const device = this.findById(id)
    if (!device) throw new Error(`Device insert failed for uid ${identity.deviceUid}`)
    return { device, created: true }
  }

  /** Drop channel rows, for a device whose family has no channels. */
  private clearChannels(deviceId: string): void {
    this.db.prepare(`DELETE FROM channels WHERE device_id = ?`).run(deviceId)
  }

  /** Materialise the CH1-CH8 rows so the UI never has to invent channel defaults. */
  seedChannels(deviceId: string, channelCount: number, timestamp = now()): void {
    const count = isFiniteNumber(channelCount) && channelCount > 0 ? channelCount : CHANNEL_COUNT
    const statement = this.db.prepare(
      `INSERT OR IGNORE INTO channels (
         id, device_id, channel_index, channel_name, sensor_type, enabled,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, 0, 1, ?, ?)`
    )
    const insertAll = this.db.transaction(() => {
      for (let index = 0; index < count; index += 1) {
        statement.run(newChannelId(), deviceId, index, `CH${index + 1}`, timestamp, timestamp)
      }
    })
    insertAll()
  }

  /**
   * 部分更新设备行。
   *
   * `installation` 是**按字段的**部分更新（业主 2026-09-17 第 1 条）：
   *   - 字段**缺席**（`undefined`）⇒ 不动库里那一列（"我只改了方位角"不该把点位清掉）；
   *   - 字段为 **`null`** ⇒ 明确清空这一列（界面上的"清除点位"）。
   * 这两者必须分开：把"没提到"当成"清空"会让一次改名顺手抹掉安装信息。
   */
  update(input: UpdateDeviceInput): Device | undefined {
    const existing = this.findById(input.id)
    if (!existing) return undefined

    const nextName = input.name?.trim() || existing.name
    const nextIp = input.ip?.trim() || existing.ip || null
    const nextPort = isFiniteNumber(input.httpPort) ? input.httpPort : existing.httpPort ?? null

    const current = existing.installation ?? {}
    const pick = (key: keyof DeviceInstallation): number | null => {
      const patch = input.installation as
        | Partial<Record<keyof DeviceInstallation, number | null>>
        | undefined
      if (patch === undefined || !(key in patch)) return current[key] ?? null
      const value = patch[key]
      return value === undefined ? current[key] ?? null : value
    }

    this.db
      .prepare(
        `UPDATE devices
            SET name = ?, ip_address = ?, http_port = ?, updated_at = ?,
                gis_latitude = ?, gis_longitude = ?, azimuth_deg = ?, sound_level_db = ?
          WHERE id = ?`
      )
      .run(
        nextName,
        nextIp,
        nextPort,
        now(),
        pick('gisLatitude'),
        pick('gisLongitude'),
        pick('azimuthDeg'),
        pick('soundLevelDb'),
        input.id
      )

    return this.findById(input.id)
  }

  /**
   * 记住听诊盒子族的代次（v12），**写回之后读回来核对**。
   *
   * 为什么要读回：业主的硬规矩是"每个写设备的操作必须读回验证"，这一条尤其适用 ——
   * 代次决定**界面给不给 PTZ 配置页**，而"写进去了但读出来是别的值"（写错列、老库没有这一列
   * 被静默忽略）在这里的后果是"空气声呐看不到 PTZ 页"，排查方向会跑到协议上去。
   *
   * 返回**从库里读回来的那一个值**（不是传入的值）：调用方拿它决定界面。若读回来的不等于
   * 传入的（写失败、写错列），调用方会看到不一致 —— 那才是要报出来的事。
   * 值没变就不写：设备详情页每次打开都会读一次状态，没必要每次都产生一次 UPDATE。
   */
  updateE2Variant(id: string, variant: E2Variant): E2Variant | undefined {
    const existing = this.findById(id)
    if (!existing) return undefined
    if (existing.e2Variant !== variant) {
      this.db
        .prepare(`UPDATE devices SET e2_variant = ?, updated_at = ? WHERE id = ?`)
        .run(variant, now(), id)
    }
    return this.findById(id)?.e2Variant
  }

  remove(id: string): boolean {
    // Channels / alarms / recordings cascade via foreign keys.
    const result = this.db.prepare(`DELETE FROM devices WHERE id = ?`).run(id)
    return result.changes > 0
  }

  // -------------------------------------------------------------------------
  // 推流秘钥（v15）
  // -------------------------------------------------------------------------

  /**
   * 秘钥 → 设备。接入服务收到一条推送时问的就是这一个问题。
   *
   * 只接受合法形状的秘钥：`push_secret` 列是 TEXT，而拿一个 `'a'` 去比也不会命中任何行 ——
   * 但更重要的是，先判形状意味着"秘钥不对"这个结论在**形状**上就已经成立，不必依赖库里刚好
   * 没有那一行（别人动过的库里可能真有一个奇怪的短串）。
   */
  findByPushSecret(secret: string): Device | undefined {
    if (!isPushSecret(secret)) return undefined
    const row = this.db
      .prepare<[string], DeviceRow>(`SELECT * FROM devices WHERE push_secret = ?`)
      .get(secret)
    return row ? toDevice(row) : undefined
  }

  /** 这台设备当前的秘钥；没生成过就是 `undefined`（不是空串）。 */
  getPushSecret(id: string): string | undefined {
    const row = this.db
      .prepare<[string], { push_secret: string | null }>(
        `SELECT push_secret FROM devices WHERE id = ?`
      )
      .get(id)
    const stored = row?.push_secret ?? null
    return stored !== null && isPushSecret(stored) ? stored : undefined
  }

  /**
   * 写入 / 轮换秘钥，**写完读回来核对**（与 `updateE2Variant` 同一条规矩）。
   *
   * 返回的是**从库里读回来的**那一个值：写错列、库里被触发器改掉、索引冲突导致没写进去，
   * 这三种情况都只能靠读回发现。调用方拿它决定界面显示什么，所以绝不能回传参值。
   */
  setPushSecret(id: string, secret: string): string | undefined {
    if (!isPushSecret(secret)) {
      throw new Error(
        `非法推流秘钥：${String(secret).length} 个字符（要求 32 位小写十六进制）`
      )
    }
    if (!this.findById(id)) return undefined
    this.db
      .prepare(`UPDATE devices SET push_secret = ?, updated_at = ? WHERE id = ?`)
      .run(secret, now(), id)
    return this.getPushSecret(id)
  }

  /** 有多少台设备已经有秘钥（设置页那张接入卡片要显示它）。 */
  countWithPushSecret(): number {
    const row = this.db
      .prepare<[], { total: number }>(
        `SELECT COUNT(*) AS total FROM devices WHERE push_secret IS NOT NULL`
      )
      .get()
    return row?.total ?? 0
  }

  /** Persist an online-probe outcome. Bumps lastSeen on success. */
  setStatus(id: string, status: DeviceStatus, lastSeen?: number): void {
    this.db
      .prepare(`UPDATE devices SET status = ?, last_seen = COALESCE(?, last_seen), updated_at = ? WHERE id = ?`)
      .run(status, lastSeen ?? null, now(), id)
  }

  /** Cache the version block so Device cards render instantly after a restart. */
  updateInfo(id: string, info: DeviceInfo): void {    this.db
      .prepare(
        `UPDATE devices
            SET name = COALESCE(NULLIF(?, ''), name),
                mac_address = COALESCE(?, mac_address),
                firmware_version = COALESCE(?, firmware_version),
                fpga_version = COALESCE(?, fpga_version),
                web_version = COALESCE(?, web_version),
                updated_at = ?
          WHERE id = ?`
      )
      .run(
        info.name || null,
        info.mac ?? null,
        info.firmwareVersion ?? null,
        info.fpgaVersion ?? null,
        info.webVersion ?? null,
        now(),
        id
      )
  }

  /**
   * Which token carrier this device accepted.
   *
   * Kept as a dedicated accessor rather than a field on the `Device` domain
   * model: it is an internal negotiation detail, not something the UI should
   * render or depend on. Caching it is what makes the auth probe a one-time
   * cost per device (spec section 19, risk 1).
   */
  getAuthStrategy(id: string): string | undefined {
    const row = this.db
      .prepare<[string], { auth_strategy: string | null }>(
        `SELECT auth_strategy FROM devices WHERE id = ?`
      )
      .get(id)
    return row?.auth_strategy ?? undefined
  }

  setAuthStrategy(id: string, strategyId: string): void {
    this.db
      .prepare(`UPDATE devices SET auth_strategy = ?, updated_at = ? WHERE id = ?`)
      .run(strategyId, now(), id)
  }

  countByStatus(): Record<DeviceStatus, number> {    const rows = this.db
      .prepare<[], { status: string; count: number }>(
        `SELECT status, COUNT(*) AS count FROM devices GROUP BY status`
      )
      .all()
    const result: Record<DeviceStatus, number> = { ONLINE: 0, OFFLINE: 0, UNKNOWN: 0 }
    for (const row of rows) {
      if (row.status in result) result[row.status as DeviceStatus] = row.count
    }
    return result
  }
}

// ---------------------------------------------------------------------------
// Channel repository
// ---------------------------------------------------------------------------

export class ChannelRepository {
  constructor(private readonly db: SqliteDatabase) {}

  listByDevice(deviceId: string): Channel[] {
    const rows = this.db
      .prepare<[string], ChannelRow>(
        `SELECT * FROM channels WHERE device_id = ? ORDER BY channel_index ASC`
      )
      .all(deviceId)
    return rows.map(toChannel)
  }

  /**
   * Replace the cached channel list with what the device reported
   * (spec 11.1, GET /get_passageway). Keeps local rows stable where possible so
   * that `alarm_profile_id` links survive a refresh.
   */
  replaceForDevice(
    deviceId: string,
    channels: ReadonlyArray<{
      channelIndex: number
      channelName: string
      sensorType?: SensorType
      enabled?: boolean
    }>
  ): Channel[] {
    const timestamp = now()
    const upsert = this.db.prepare(
      `INSERT INTO channels (
         id, device_id, channel_index, channel_name, sensor_type, enabled,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (device_id, channel_index) DO UPDATE SET
         channel_name = excluded.channel_name,
         sensor_type  = excluded.sensor_type,
         enabled      = excluded.enabled,
         updated_at   = excluded.updated_at`
    )

    const apply = this.db.transaction(() => {
      for (const channel of channels) {
        upsert.run(
          newChannelId(),
          deviceId,
          channel.channelIndex,
          channel.channelName,
          channel.sensorType ?? SensorTypeEnum.Microphone,
          channel.enabled === false ? 0 : 1,
          timestamp,
          timestamp
        )
      }
    })
    apply()

    return this.listByDevice(deviceId)
  }
}
