/**
 * Settings service.
 *
 * Two-tier configuration (spec 4.4):
 *   - Application config lives next to the install / in ProgramData.
 *   - The AUDIO STORAGE ROOT is user-chosen and must be movable to a large
 *     disk (D:\ E:\ ...). It is therefore stored as a first-class setting and
 *     never derived from the app directory.
 *
 * Backed by the `settings` table (spec 16.6) so there is exactly one
 * persistence mechanism for configuration, with a JSON envelope per key.
 */

import type { Database as SqliteDatabase } from 'better-sqlite3'
import { EventEmitter } from 'node:events'
import type { AppSettings, AppSettingsPatch } from '@shared/ipc/contract'
import {
  DEFAULT_MAX_CONCURRENT_CAMERA_STREAMS,
  MAX_CONCURRENT_CAMERA_STREAMS,
  MIN_CONCURRENT_CAMERA_STREAMS
} from '@shared/domain/camera-live'
import {
  cloneDefaults,
  normaliseAlarmLinkageConfig
} from './alarm-linkage-config'
import { isLegacyDefaultAlarmLinkageConfig } from '@shared/domain/alarm-linkage'
import {
  defaultAlarmSoundLibrary,
  normaliseAlarmSoundLibrary,
  type AlarmSoundLibrary
} from '@shared/domain/alarm-sound'
import {
  defaultIotIngestConfig,
  normaliseIotIngestConfig
} from '@shared/domain/iot-ingest'
import {
  defaultMapTilesConfig,
  normaliseMapServices,
  normaliseMapTilesConfig
} from '@shared/domain/map-tiles'
import { defaultRecorderConfig, normaliseRecorderConfig } from '@shared/domain/recorder-config'
import { appLog } from '../logging/logger'

/** Defaults applied on first run and used to fill any missing key. */
export const DEFAULT_SETTINGS: AppSettings = {
  storageRoot: '',
  retentionDays: 30,
  // 10 GB safety floor — spec 14.4.
  minFreeBytes: 10 * 1024 * 1024 * 1024,
  // spec 13.2: light health check every 5 s.
  healthCheckIntervalMs: 5_000,
  // spec 13.2: three consecutive failures before declaring OFFLINE.
  offlineFailureThreshold: 3,
  requestTimeoutMs: 8_000,
  // spec 4.3: 60 s ring, pre 10 s / post 20 s.
  preAlarmSeconds: 10,
  postAlarmSeconds: 20,
  ringBufferSeconds: 60,
  /**
   * 打开软件时，相机确实在工作就自动播放实时视频。
   *
   * **默认开启**（产品要求「软件打开如果是相机有在工作就自动播放视频」，默认关闭
   * 等于没做）。它仍然是一个可关的设置：自动播放会让相机打开一条 RTSP 连接。
   */
  autoPlayCameraLive: true,
  /**
   * 同时直播的相机路数上限（多路视频墙的预算）。
   *
   * 默认 4 而不是 16：每一路在主进程里都是一个 ffmpeg 子进程 + 一个回环服务 +
   * 一份缓冲，在渲染层还占一份解码。4 分屏正好一屏，而一台值班机同时解 16 路
   * 4 Mbit/s 的 H.264 会先卡住自己。上限可在设置页里改（1..16）。
   */
  maxConcurrentCameraStreams: DEFAULT_MAX_CONCURRENT_CAMERA_STREAMS,
  /**
   * 告警联动（产品要求「录像，弹窗，提示以及邮件触发」）。
   *
   * **引擎默认开启**（业主 2026-09-23：相机告警应默认弹窗+提示音），
   * 邮件仍然默认关闭：装完就往外发邮件的应用是缺陷。
   * 老装里「未自定义过的旧默认」由 VALIDATORS 里的迁移逻辑识别并升级。
   * 归一化规则集中在 `./alarm-linkage-config`，本文件只负责持久化。
   */
  alarmLinkage: cloneDefaults(),
  /**
   * 告警声音库（手册 §17.2.7，p185）。
   *
   * 与 `alarmLinkage` **分开放**，不是一个结构里的两半：
   *   - 联动配置管的是「告警发生时做哪四个动作」，声音库管的是「有哪几种告警声音、
   *     各自指向哪个 `.wav`」；
   *   - 手册把它们放在系统配置的两张不同标签页里（Alarm Sound 与 Email/Alarm）；
   *   - 界面上它们由两个不同的组件编辑、各自保存（各发一个键），因此互不覆盖。
   *
   * 归一出厂那一份见 `@shared/domain/alarm-sound`。
   */
  alarmSounds: defaultAlarmSoundLibrary(),
  /**
   * IoT 数据接入（业主 2026-09-19 第 1 条：HTTP 推流 + MQTT）。
   *
   * **默认关闭**：装完软件就在局域网里开一个监听端口是缺陷。归一出厂那一份见
   * `@shared/domain/iot-ingest` 的 `defaultIotIngestConfig()`（端口 8080 / 1883、
   * 绑定 `0.0.0.0` —— 只有设备连得上，接入才有意义）。
   */
  iotIngest: defaultIotIngestConfig(),

  /**
   * 连续录像（RTSP 取流存储）：默认**谁都不录**，切片 5 分钟。
   *
   * opt-in 是有意的：一路 2 Mbps 一天约 21 GB，装完就开始录会把用户的盘填满。
   */
  recorder: defaultRecorderConfig(),

  /**
   * 在线地图底图（业主 2026-09-19 追加第 1 条；**手册未说明**）。
   *
   * **默认关闭**：离线优先；关着时地图页仍走本机 SVG 网格，不出网。
   * 只允许 https 的 XYZ 模板、可选 key、启用时必须署名；规则见 @shared/domain/map-tiles。
   */
  mapTiles: defaultMapTilesConfig(),

  /**
   * 命名的 GIS 服务库（业主追加：设置里「添加 GIS 服务」）。
   *
   * 默认空库；`mapTiles` 仍是"当前生效的那一份"。条目逐条归一化（坏条目丢弃记日志，
   * 一条坏服务不作废整个库），规则见 `@shared/domain/map-tiles`。
   */
  mapServices: []
}

/**
 * 「恢复默认」的**范围**（手册 §17.2 第 5227 行：you can click Default Value to
 * restore the defaults of all the system configurations）。
 *
 * ---------------------------------------------------------------------------
 * 为什么这是一张显式白名单，而不是「`settings` 表里的一切」
 * ---------------------------------------------------------------------------
 * 这句话里的 "all the system configurations" 指的是**系统设置页上的配置项**，
 * 不包括设备列表、通道、录像/录音文件、告警记录与账号 —— 它们各自住在别的表里
 * （`devices` / `channels` / `recordings` / `alarms` / `users`），本服务从头到尾
 * 只写 `settings` 表，所以这条边界**在代码结构上**就成立，白名单只是把
 * 「哪些格会被写回默认值」写死，好让界面能逐项列出来给用户确认。
 *
 * `storageRoot` **在**这份清单里：它是手册意义上的系统配置项，而"恢复默认"的语义
 * 就是把它交回出厂那一份（平台默认的存储根）。它只改**设置里的那一格路径**，
 * 不动磁盘上任何已存在的文件——旧目录里的录音不会被删除，只是不再被指向。
 * 确认对话框必须把这一条写清楚（`settingsUi.restoreWarnStorage`）。
 *
 * 账号权限**不在这里**：权限存在 `app_meta`（见 `account-permission-store.ts`），
 * 一次「恢复默认」不会碰任何账户的权限。
 */
export const RESTORABLE_SETTING_KEYS = [
  'storageRoot',
  'retentionDays',
  'minFreeBytes',
  'healthCheckIntervalMs',
  'offlineFailureThreshold',
  'requestTimeoutMs',
  'preAlarmSeconds',
  'postAlarmSeconds',
  'ringBufferSeconds',
  'autoPlayCameraLive',
  'maxConcurrentCameraStreams',
  'alarmLinkage',
  'alarmSounds',
  'iotIngest',
  'mapTiles',
  'mapServices'
] as const satisfies readonly (keyof AppSettings)[]

export type RestorableSettingKey = (typeof RESTORABLE_SETTING_KEYS)[number]

/** Bounds enforced on every write so a bad value cannot brick the app. */
const VALIDATORS: {
  [K in keyof AppSettings]: (value: AppSettings[K]) => AppSettings[K] | undefined
} = {
  storageRoot: (value) => (typeof value === 'string' ? value : undefined),
  retentionDays: (value) =>
    typeof value === 'number' && value >= 1 && value <= 3650 ? Math.floor(value) : undefined,
  minFreeBytes: (value) =>
    typeof value === 'number' && value >= 0 && value <= 1024 ** 4 ? Math.floor(value) : undefined,
  healthCheckIntervalMs: (value) =>
    typeof value === 'number' && value >= 1_000 && value <= 300_000 ? Math.floor(value) : undefined,
  offlineFailureThreshold: (value) =>
    typeof value === 'number' && value >= 1 && value <= 20 ? Math.floor(value) : undefined,
  requestTimeoutMs: (value) =>
    typeof value === 'number' && value >= 500 && value <= 120_000 ? Math.floor(value) : undefined,
  preAlarmSeconds: (value) =>
    typeof value === 'number' && value >= 0 && value <= 120 ? Math.floor(value) : undefined,
  postAlarmSeconds: (value) =>
    typeof value === 'number' && value >= 0 && value <= 300 ? Math.floor(value) : undefined,
  ringBufferSeconds: (value) =>
    typeof value === 'number' && value >= 10 && value <= 600 ? Math.floor(value) : undefined,
  /**
   * 开机自动播放相机实时视频。
   *
   * 只接受真正的布尔值：字符串 `'false'` 是**真值**，而它正是从 JSON 里最容易被
   * 读到的东西。与其猜调用方的意思，不如拒绝（`update()` 会把它记进 `rejected`）。
   */
  autoPlayCameraLive: (value) => (typeof value === 'boolean' ? value : undefined),
  /**
   * 同时直播上限。
   *
   * 边界与 `normaliseMaxConcurrentStreams()` 是同一组常量：那个函数给渲染层与
   * `RtspStreamService` 用，这里的校验器必须和它给出同样的范围，否则「设置页允许
   * 写进去、主进程实际不认」会静默地漂移。区间外一律**拒绝**（进 `rejected`），
   * 不是夹取——把一个 99 悄悄改成 16，用户不会知道自己填错了。
   */
  maxConcurrentCameraStreams: (value) =>
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= MIN_CONCURRENT_CAMERA_STREAMS &&
    value <= MAX_CONCURRENT_CAMERA_STREAMS
      ? Math.floor(value)
      : undefined,
  /**
   * 告警联动：整块归一化，**永远返回一个合法的完整对象**。
   *
   * 与上面那些标量键不同，这一块是嵌套结构：一个坏字段不应该让整块配置
   * 作废（那会静默地把用户配好的 SMTP 主机也一起清掉）。所以归一化器
   * 逐字段回落到默认值，并把被修正的字段名交回来写日志。
   *
   * 归一化器同时把「只写字段」`email.smtpPassword` **摘出去**：它只会出现在
   * `update()` 的入参里，落到 `persist()` 的对象里永远没有它。
   */
  alarmLinkage: (value) => {
    const { config, issues, smtpPassword } = normaliseAlarmLinkageConfig(value)
    if (issues.length > 0) {
      appLog().warn('告警联动配置存在非法字段，已回落到默认值', { fields: issues })
    }
    if (smtpPassword !== undefined) pendingSecret.password = smtpPassword
    /**
     * 2026-09-23 默认值翻转为「引擎默认开启」后，老装里可能躺着一份
     * 「用户从未碰过联动设置、但 enabled:false 已随整包持久化落库」的记录。
     * 与旧出厂默认逐字段相等的配置升级到新默认；用户改过的任何字段都会让
     * 它不再相等，从而被原样保留（见 `isLegacyDefaultAlarmLinkageConfig`）。
     */
    if (isLegacyDefaultAlarmLinkageConfig(config)) {
      appLog().info('告警联动配置为旧出厂默认（用户未自定义），已升级为新默认（引擎默认开启）')
      return cloneDefaults()
    }
    return config
  },
  /**
   * 告警声音库（手册 §17.2.7）。
   *
   * 与 `alarmLinkage` 同一形状：整块归一化、**永远返回一个合法的完整对象**。
   * 归一化器同时把**非 `.wav` 的文件**清掉并交回字段名（手册第 5448 行的硬约束），
   * 所以一次绕过界面的写入也不会把 `.mp3` 存进设置表。
   */
  alarmSounds: (value) => {
    const { library, issues } = normaliseAlarmSoundLibrary(value)
    if (issues.length > 0) {
      appLog().warn('告警声音库存在非法字段，已回落到默认值', { fields: issues })
    }
    return library as AlarmSoundLibrary
  },
  /**
   * IoT 数据接入（业主 2026-09-19 第 1 条）。
   *
   * 与上面两块同一形状：**整块归一化、永远返回一个合法的完整对象**。逐字段回落的理由很
   * 具体：一个坏端口不该把用户配好的绑定地址一起清掉（那会让接入整个停掉，而用户只改错了
   * 一个数字）。
   *
   * `portConflict`（两个通道同端口）**不在这里改**：改哪一个都是猜测，服务那边会各自报告
   * 监听错误（`EADDRINUSE`），界面照实显示。
   */
  iotIngest: (value) => {
    const { config, issues } = normaliseIotIngestConfig(value)
    if (issues.length > 0) {
      appLog().warn('IoT 接入配置存在非法字段，已回落到默认值', { fields: issues })
    }
    return config
  },
  recorder: (value) => {
    const { config, issues } = normaliseRecorderConfig(value)
    if (issues.length > 0) {
      appLog().warn('连续录像配置存在非法字段，已归一', { fields: issues })
    }
    return config
  },

  /**
   * 在线地图底图（业主 2026-09-19 追加第 1 条）。
   *
   * 与其他嵌套块不同，这里**不逐字段回落**：XYZ 模板、key、署名是一组互相约束的值，
   * 一个坏字段就应当整键拒绝（`normaliseMapTilesConfig()` 返回 undefined），免得存进
   * 一份「开关开着但模板不可用」的配置 —— 那种状态在地图页就是一张空白底图。
   */
  mapTiles: (value) => {
    const config = normaliseMapTilesConfig(value)
    if (!config) {
      appLog().warn('地图底图配置不合法，整键拒绝', { field: 'mapTiles' })
    }
    return config
  },

  /**
   * 命名的 GIS 服务库（业主追加）。
   *
   * 与 `mapTiles` 的"整键拒绝"刻意不同：这里是一条**列表**，一条坏条目只丢那一条
   * （记日志），不让整个库作废 —— 与 `alarmLinkage` 逐字段回落同一哲学。
   */
  mapServices: (value) => {
    const { services, issues } = normaliseMapServices(value)
    if (issues.length > 0) {
      appLog().warn('GIS 服务库存在非法条目，已丢弃', { issues })
    }
    return services
  }
}

/**
 * 归一化过程中摘出来的 SMTP 口令（本次提交携带的那一个）。
 *
 * 模块级而不是实例级：`VALIDATORS` 是一个常量表，校验器没有 `this`。
 * 这个变量只活在一次 `update()` 调用期间——用完立刻清空，
 * 且它**只**被 `update()` 读取（读路径不会写它）。
 */
const pendingSecret: { password?: string } = {}

export interface SettingsServiceOptions {
  db: SqliteDatabase
  /** Resolved default storage root, injected so the service stays path-agnostic. */
  defaultStorageRoot: string
}

/** `update()` 的结果：新设置 + 被拒的键 + 本次提交携带的 SMTP 口令。 */
export interface SettingsUpdateResult {
  settings: AppSettings
  rejected: string[]
  /**
   * 只写字段 `alarmLinkage.email.smtpPassword` 在本次提交里的值。
   *
   * `undefined` = 本次没动口令；`''` = 明确删除。它**不在** `settings` 里，
   * 也永远不会被 `persist()` 写进 SQLite——调用方（IPC 层）负责把它交给
   * DPAPI/safeStorage 凭据库。
   */
  smtpPassword?: string
}

export class SettingsService extends EventEmitter {
  private readonly db: SqliteDatabase
  private readonly defaultStorageRoot: string
  private cache: AppSettings

  constructor(options: SettingsServiceOptions) {
    super()
    this.db = options.db
    this.defaultStorageRoot = options.defaultStorageRoot
    this.cache = this.load()
  }

  /** Full, validated settings object. Cheap: served from memory. */
  get(): AppSettings {
    return { ...this.cache }
  }

  getKey<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return this.cache[key]
  }

  /**
   * 告警联动配置的对外形态。
   *
   * 与 `get().alarmLinkage` 的唯一区别是 `email.smtpPasswordStored`：
   *
   *   1. 口令**不在设置表里**（它在 `credential.smtp` 这个 DPAPI 加密的凭据项里，
   *      见 `device/credential-store.ts` 的 `SMTP_SECRET_ID`），所以设置 JSON
   *      里不可能有它；
   *   2. 但界面必须能回答「我现在到底存没存口令」——否则用户会反复重填，
   *      或者以为存了其实没存；
   *   3. 因此这个布尔值由**主进程**在回给渲染层时填上。渲染层提交设置时带上
   *      的任何值都会被归一化器丢掉（`smtpPasswordStored: false`），
   *      所以它无法被伪造。
   */
  describeAlarmLinkage(passwordStored: boolean): AppSettings['alarmLinkage'] {
    const config = this.cache.alarmLinkage
    return {
      ...config,
      actions: { ...config.actions },
      recording: { ...config.recording },
      popup: { ...config.popup },
      notices: { ...config.notices },
      email: { ...config.email, smtpPasswordStored: passwordStored },
      runtime: { ...config.runtime, cooldown: { ...config.runtime.cooldown } }
    }
  }

  /**
   * Apply a partial update. Invalid values are rejected (and reported in the
   * returned `rejected` list) rather than silently coerced.
   */
  update(patch: AppSettingsPatch): SettingsUpdateResult {
    const rejected: string[] = []
    const next: AppSettings = { ...this.cache }

    /**
     * 清空上一次调用残留的口令。
     *
     * `pendingSecret` 是模块级的（校验器表是常量，拿不到 `this`），所以每次
     * 进来先清空，保证「上一次提交的口令」不会在这次被当成新的。
     */
    delete pendingSecret.password

    for (const rawKey of Object.keys(patch) as (keyof AppSettings)[]) {
      const value = patch[rawKey]
      if (value === undefined) continue
      const validator = VALIDATORS[rawKey] as
        | ((input: unknown) => AppSettings[typeof rawKey] | undefined)
        | undefined
      if (!validator) {
        rejected.push(String(rawKey))
        continue
      }
      const validated = validator(value)
      if (validated === undefined) {
        rejected.push(String(rawKey))
        continue
      }
      // Assignment through a widened record: TypeScript cannot correlate the
      // per-key validator with the per-key slot, but the runtime pairing is exact.
      ;(next as unknown as Record<string, unknown>)[rawKey] = validated
    }

    // An empty storage root means "fall back to the platform default".
    if (next.storageRoot.trim() === '') next.storageRoot = this.defaultStorageRoot

    const newPassword = pendingSecret.password
    delete pendingSecret.password

    this.persist(next)
    const previous = this.cache
    this.cache = next

    if (previous.storageRoot !== next.storageRoot) {
      this.emit('storage-root-changed', next.storageRoot, previous.storageRoot)
    }
    this.emit('changed', this.get())

    return {
      settings: this.get(),
      rejected,
      ...(newPassword !== undefined ? { smtpPassword: newPassword } : {})
    }
  }

  /**
   * 「恢复默认值」（手册 §17.2 第 5227 行 / 界面上的 Default Value 按钮）。
   *
   * ---------------------------------------------------------------------------
   * 它到底动了什么（这一段就是实现，不是注释里的承诺）
   * ---------------------------------------------------------------------------
   * 只写 `RESTORABLE_SETTING_KEYS` 那 16 个键，值取自 `DEFAULT_SETTINGS`，并把
   * `storageRoot` 落回平台默认。其余一切**不经过这里**：
   *
   *   - `devices` / `channels` / `recordings` / `alarms` / `users`：本类只持有
   *     `settings` 表的句柄，**没有**这些表的任何语句，所以「恢复默认会不会把设备
   *     删掉」这个问题在类型与 SQL 层面都不可能成立；
   *   - 账号权限：在 `app_meta`（`AccountPermissionStore`），本类不碰；
   *   - SMTP 口令：在 DPAPI/safeStorage 凭据库，本类不碰，也**不删** ——
   *     恢复默认会把 SMTP 主机/端口/收件人清回出厂值（默认是空的），
   *     而凭据库里那条口令留在原地。代价是「口令还在、配置没了」这个中间态；
   *     处理办法是**如实**在界面提示：`settingsUi.restoreNotice` 会说明
   *     「SMTP 口令仍保存在本机凭据库中，如需清除请重新保存一次邮件设置」。
   *     反过来在这个方法里去删凭据才是越界：这个服务拿不到凭据库，
   *     也不该为了一个界面按钮去改别的子系统持有的秘密。
   *
   * 返回值是**恢复之后从数据库读回来的**设置，不是内存里那份期望值 ——
   * 调用方（界面）因此拿到的是事实。
   */
  restoreDefaults(): SettingsUpdateResult {
    const rejected: string[] = []
    const next: AppSettings = { ...this.cache }

    for (const key of RESTORABLE_SETTING_KEYS) {
      const validated = VALIDATORS[key](DEFAULT_SETTINGS[key] as never)
      if (validated === undefined) {
        // 出厂默认值本身过不了校验器 = 这张表写错了。如实报出来，而不是悄悄跳过。
        rejected.push(String(key))
        continue
      }
      ;(next as unknown as Record<string, unknown>)[key] = validated
    }

    next.storageRoot = this.defaultStorageRoot
    delete pendingSecret.password

    // 整表先清空、再把完整的一份写回去：这样「默认值写成显式行」与「非默认行删掉」
    // 是同一件事，表里不会留下上一版才认识的键。
    const clear = this.db.prepare(`DELETE FROM settings`)
    const previous = this.cache
    const writeAll = this.db.transaction(() => {
      clear.run()
      this.persist(next)
    })
    writeAll()

    this.cache = next
    if (previous.storageRoot !== next.storageRoot) {
      this.emit('storage-root-changed', next.storageRoot, previous.storageRoot)
    }
    this.emit('changed', this.get())
    appLog().info('系统设置已恢复默认值', { keys: RESTORABLE_SETTING_KEYS.length })

    return { settings: this.load(), rejected }
  }

  /**
   * Read every key out of SQLite, falling back to defaults for missing rows. */
  private load(): AppSettings {
    const rows = this.db
      .prepare<[], { key: string; value: string | null }>(`SELECT key, value FROM settings`)
      .all()

    const stored = new Map<string, unknown>()
    for (const row of rows) {
      if (row.value === null) continue
      try {
        stored.set(row.key, JSON.parse(row.value))
      } catch {
        // A corrupt row degrades to the default rather than failing startup.
      }
    }

    const result: AppSettings = { ...DEFAULT_SETTINGS }
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
      const raw = stored.get(key)
      if (raw === undefined) continue
      const validator = VALIDATORS[key] as (input: unknown) => AppSettings[typeof key] | undefined
      const validated = validator(raw)
      if (validated !== undefined) {
        ;(result as unknown as Record<string, unknown>)[key] = validated
      }
    }

    if (!result.storageRoot || result.storageRoot.trim() === '') {
      result.storageRoot = this.defaultStorageRoot
    }
    // 读路径上的 `alarmLinkage` 校验同样会经过归一化器。设置表里不可能有口令
    // （`persist()` 从不写它），但保险起见在读完之后也清掉那个暂存位。
    delete pendingSecret.password
    return result
  }

  private persist(settings: AppSettings): void {
    const statement = this.db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`
    )
    const writeAll = this.db.transaction(() => {
      for (const key of Object.keys(settings) as (keyof AppSettings)[]) {
        statement.run(key, JSON.stringify(settings[key]))
      }
    })
    writeAll()
  }
}
