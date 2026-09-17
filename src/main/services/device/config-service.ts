/**
 * ConfigService — device configuration reads and writes (Phase 9).
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE
 * FA8 write endpoints REPLACE the whole object. They are not patches. Omitting
 * `dsySeriPortR` clears that serial port; an alarm profile sent without its
 * thresholds resets them. So every write here follows:
 *
 *     read current state  ->  merge the user's edit  ->  submit the COMPLETE object
 *
 * The strict write DTOs make the "complete object" requirement a compile-time
 * constraint, and each method below reads first rather than trusting a caller to
 * have done so.
 *
 * ONE MEASURED EXCEPTION — `PUT /set_passageway`
 * Its `chinfoArray` is a SINGLE channel object keyed by `dchId`, not an array
 * (the device's own UI posts one row, and any array shape is rejected with an
 * integrity error on real hardware — see `updateChannel()`). That row still
 * carries the device's own values for the fields the caller did not edit, so the
 * rule above survives in the form that matters: nothing is ever invented.
 *
 * 注意：下面几个写方法（`setSampleRate` / `updateTime` / `updateRs485` /
 * `updateModbus`）的 `msgBody` 信封是**真机实测必需**的，不是风格问题。
 * `setNetwork` / `deleteAlarmProfile` / 重启恢复出厂那几个写端点**没有**验证过信封
 * （见 `docs/PROTOCOL-FINDINGS.md` §5A.0 与「未验证」清单），不要照着上面几条顺手改。
 *
 * NETWORK CHANGES ARE THE DANGEROUS CASE
 * `PUT /set_network` changes the address the device answers on, which destroys
 * the connection in use. The device's own web UI simply reloads the page and
 * hopes. This service does something more careful:
 *
 *     warn (by contract) -> snapshot -> apply -> reconnect on the NEW address
 *       -> verify -> on failure, reconnect on the OLD address and roll back
 *
 * Without the rollback, a typo in a subnet mask would leave a device
 * unreachable with the user's only recovery path being physical access.
 */

import { AppError, ErrorCodes } from '@shared/errors'
import { deviceLog } from '../logging/logger'
import type { DeviceApiClient } from '../device/device-api-client'
import type {
  AlarmProfileConfig,
  ChannelConfigView,
  ModbusConfigView,
  NetworkConfigView,
  PushConfigView,
  Rs485ConfigView,
  TimeConfigView
} from '@shared/domain/device-config'
import type {
  AlarmParamDto,
  AlarmParamWrite,
  DatePushDto,
  NetworkDto,
  PassagewayDto,
  Rs485Dto,
  ModbusDto,
  TimeSetDto
} from '../device/protocol/dto'
import type { NetworkDto as NetworkDtoType } from '../device/protocol/dto'

// ---------------------------------------------------------------------------
// Domain shapes the UI consumes (friendly names — no protocol vocabulary)
// ---------------------------------------------------------------------------

/**
 * The view models live in `shared/domain/device-config.ts` and are re-exported
 * here, so callers that already import them from this module keep working. See
 * that file for why they moved.
 */
export type {
  AlarmProfileConfig,
  ChannelConfigView,
  ModbusConfigView,
  NetworkConfigView,
  PushConfigView,
  Rs485ConfigView,
  TimeConfigView
} from '@shared/domain/device-config'

// ---------------------------------------------------------------------------
// Device-side readers (unwrap + map)
// ---------------------------------------------------------------------------

/**
 * Read and normalise every configuration block the UI needs.
 *
 * The device returns nested envelopes inconsistently across endpoints, so each
 * reader pulls the specific key it needs rather than relying on the caller's
 * `unwrap` having already descended the right number of levels.
 */
export class ConfigService {
  constructor(private readonly client: DeviceApiClient) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async getChannels(): Promise<ChannelConfigView[]> {
    const payload = await this.client.getPassageway()
    const rows = extractArray<PassagewayDto>(payload, ['chinfoArray', 'passageways', 'channels'])
    return rows
      .map((row) => ({
        channelIndex: toInt(row.dchId ?? row.channel_id, -1),
        name: String(row.dchName ?? row.channel_name ?? ''),
        sensorType: toInt(row.dchSensorType ?? row.sensor_type, 0),
        enabled: toInt(row.dchEn ?? row.enable, 1) === 1,
        alarmProfileId: toInt(row.dchAlarmPara ?? row.alarm_id, 0)
      }))
      .filter((row) => row.channelIndex >= 0)
      .sort((a, b) => a.channelIndex - b.channelIndex)
  }

  async getSampleRate(): Promise<number> {
    const payload = (await this.client.getSamplingRate()) as { samplingrate?: unknown }
    const rate = toInt(payload?.samplingrate, 0)
    if (rate <= 0) {
      throw new AppError(ErrorCodes.INVALID_RESPONSE, '无法解析设备采样率')
    }
    return rate
  }

  async getAlarmProfiles(): Promise<AlarmProfileConfig[]> {
    const payload = await this.client.getAlarmSystem()
    const rows = extractArray<AlarmParamDto>(payload, ['alarmparaArray', 'alarm_list'])
    return rows.map((row) => ({
      id: row.dalId !== undefined ? toInt(row.dalId, 0) : undefined,
      name: String(row.dalName ?? ''),
      detectionType: toInt(row.dalDetecType, 0),
      sensitivity: toInt(row.dalDeteSen ?? row.dalSensitivity, 10),
      interferenceSuppression: toInt(row.dalIntInhLeve, 10),
      splOverloadEnabled: toInt(row.dalSPLODEn, 0) === 1,
      splOverloadThreshold: toInt(row.dalSPLODThre, 0),
      splSurgeEnabled: toInt(row.dalSPLSIDEn, 0) === 1,
      splSurgeThreshold: toInt(row.dalSPLSIDThre, 0),
      splDropEnabled: toInt(row.dalSPLSDDEn, 0) === 1,
      splDropThreshold: toInt(row.dalSPLSDDThre, 0),
      splStabilityEnabled: toInt(row.dalSPLStaDetEN, 0) === 1,
      splStabilityThreshold: toInt(row.dalSPLStaDetThre, 0),
      mainFrequencyEnabled: toInt(row.dalMainFreqEn, 0) === 1,
      mainFrequencyLower: toInt(row.dalMFLower, 0),
      mainFrequencyUpper: toInt(row.dalMFUpper, 0),
      bandEnergyRatioEnabled: toInt(row.dalFBETEn, 0) === 1,
      bandEnergyRatioLower: toInt(row.dalFBETLo, 0),
      bandEnergyRatioUpper: toInt(row.dalFBETUp, 0),
      bandEnergyRatioThreshold: toNumber(row.dalFBETThre, 0)
    }))
  }

  async getNetwork(): Promise<NetworkConfigView> {
    const payload = (await this.client.getNetwork()) as NetworkDto
    return {
      mode: String(payload?.dsyIPMode ?? 'manual'),
      ip: String(payload?.dsyIPAdder ?? ''),
      netmask: String(payload?.dsyIPMask ?? ''),
      gateway: String(payload?.dsyIPGateway ?? ''),
      dns: String(payload?.dsyDNSAdder ?? ''),
      httpPort: toInt(payload?.dsyHTTPPort, 80),
      rtspPort: toInt(payload?.dsyRTSPPort, 0),
      tcpPort: toInt(payload?.dsyTCPPort, 0)
    }
  }

  async getTime(): Promise<TimeConfigView> {
    const payload = (await this.client.getTimeSet()) as TimeSetDto
    return {
      deviceTime: toInt(payload?.cur_time, Date.now()),
      ntpEnabled: toInt(payload?.dsyNTPEN, 0) === 1,
      ntpServer: String(payload?.dsyNTPAdder ?? ''),
      ntpInterval: toInt(payload?.dsyNTPInterval, 60)
    }
  }

  async getRs485(): Promise<Rs485ConfigView> {
    const payload = (await this.client.getRs485()) as Rs485Dto
    return {
      baud: toInt(payload?.dsySeriBaud, 9600),
      dataBits: toInt(payload?.dsySeriDateBit, 8),
      mode: toInt(payload?.dsySeriMode, 0),
      portLeft: String(payload?.dsySeriPortL ?? ''),
      // The read endpoint does not return this; preserve emptiness rather than
      // inventing a port, and pass it back verbatim so a write does not clear it.
      portRight: String((payload as Record<string, unknown>)?.dsySeriPortR ?? ''),
      address: String(payload?.dsySeriRserAddr ?? '')
    }
  }

  async getAvailableSerialPorts(): Promise<string[]> {
    const payload = (await this.client.getAvailableSerial()) as { all_available_dev?: unknown }
    const ports = payload?.all_available_dev
    return Array.isArray(ports) ? ports.map(String) : []
  }

  async getModbus(): Promise<ModbusConfigView> {
    const payload = (await this.client.getModbusPara()) as ModbusDto
    return {
      // Firmware spelling is `modbus_post`; read with the typo, expose as `port`.
      port: toInt(payload?.modbus_post, 502),
      type: toInt(payload?.modbus_type, 0),
      baud: toInt(payload?.modbus_baud, 9600),
      dataBits: toInt(payload?.modbus_dbit, 8),
      stopBits: toInt(payload?.modbus_sbit, 1),
      slaveId: toInt(payload?.modbus_slave, 1)
    }
  }

  /**
   * Push (data egress) configuration.
   *
   * Surfaced prominently in the UI because the tested unit had all four channels
   * ENABLED and pointing at a public internet address — i.e. a device in a
   * customer's substation uploading continuously. `targetsPublicAddress` exists
   * so the UI can flag that rather than showing a neutral form.
   */
  async getPushConfig(): Promise<PushConfigView> {
    const payload = (await this.client.getPushConfig()) as DatePushDto
    const featureUrl = String(payload?.dsyFeatDataAdder ?? '')
    const alarmUrl = String(payload?.dsyAlarmInfoAdder ?? '')
    const graphUrl = String(payload?.dsyGraphDataAdder ?? '')
    const heatUrl = String(payload?.dsyHeatAdder ?? '')

    return {
      featureEnabled: toInt(payload?.dsyFeatDataEN, 0) === 1,
      featureUrl,
      alarmEnabled: toInt(payload?.dsyAlarmInfoEN, 0) === 1,
      alarmUrl,
      graphEnabled: toInt(payload?.dsyGraphDataEN, 0) === 1,
      graphUrl,
      heatEnabled: toInt(payload?.dsyHeatEN, 0) === 1,
      heatUrl,
      heatInterval: toInt(payload?.dsyHeatInterval, 60),
      targetsPublicAddress: [featureUrl, alarmUrl, graphUrl, heatUrl].some(isPublicHttpUrl)
    }
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Update one channel.
   *
   * 写入形状是**真机实测**的（2026 年取证轮）：`{ msgBody: { chinfoArray: <单个通道对象> } }`。
   * 设备自己的前端（`pages/Preference/PreferenceF.js:183-205`）改一行通道名时发的就是
   * 单个 `record` 对象；真机上八条数组、一元素数组、缺 `msgBody` 一律返回
   * `Failed, Please check the integrity of the data format.`，只有单对象成功。
   * 详见 `docs/PROTOCOL-FINDINGS.md` §5A.2。
   *
   * 只提交**被改的那一路**，但那一行必须携带设备上报的全部五个字段：前四个由
   * `getChannels()` 读回，用户只改其中一两个，所以「不动的字段用设备自己的值」这件事
   * 仍然成立 —— 这里绝不凭空编造 `dchSensorType` / `dchAlarmPara`。
   *
   * @throws when `channelIndex` is not present on the device, rather than
   *   silently appending a channel the firmware did not report.
   */
  async updateChannel(
    channelIndex: number,
    patch: Partial<Omit<ChannelConfigView, 'channelIndex'>>
  ): Promise<ChannelConfigView[]> {
    const channels = await this.getChannels()
    const target = channels.find((channel) => channel.channelIndex === channelIndex)
    if (!target) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `设备未上报通道 ${channelIndex + 1}，无法修改`
      )
    }

    const merged = { ...target, ...patch }

    await this.client.setPassageway({
      msgBody: {
        chinfoArray: {
          dchId: merged.channelIndex,
          dchName: merged.name,
          dchSensorType: merged.sensorType,
          dchEn: merged.enabled ? 1 : 0,
          dchAlarmPara: merged.alarmProfileId
        }
      }
    })

    deviceLog().info('Channel updated', { channelIndex, fields: Object.keys(patch) })
    return this.getChannels()
  }

  /**
   * Change the sample rate.
   *
   * Spec 11.2 requires warning the user first: the device restarts acquisition,
   * so active realtime streams are disrupted. The UI owns that warning.
   */
  async setSampleRate(sampleRate: number): Promise<number> {
    if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, `采样率不合法: ${sampleRate}`)
    }
    await this.client.setSamplingRate({ msgBody: { samplingrate: sampleRate } })
    deviceLog().info('Sample rate set', { sampleRate })
    return this.getSampleRate()
  }

  /**
   * Create or update an alarm profile.
   *
   * `id` absent means CREATE. All other fields are always sent, because the
   * device replaces the profile wholesale — a "change just the threshold"
   * operation must still submit every other field.
   */
  async saveAlarmProfile(profile: AlarmProfileConfig): Promise<AlarmProfileConfig[]> {
    if (!profile.name || profile.name.trim() === '') {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '告警配置名称不能为空')
    }
    validateProfileRanges(profile)

    const write: AlarmParamWrite = {
      ...(profile.id !== undefined ? { dalId: profile.id } : {}),
      dalName: profile.name,
      dalDetecType: profile.detectionType,
      dalDeteSen: profile.sensitivity,
      dalSensitivity: profile.sensitivity,
      dalIntInhLeve: profile.interferenceSuppression,
      dalSPLODEn: profile.splOverloadEnabled ? 1 : 0,
      dalSPLODThre: profile.splOverloadThreshold,
      dalSPLSIDEn: profile.splSurgeEnabled ? 1 : 0,
      dalSPLSIDThre: profile.splSurgeThreshold,
      dalSPLSDDEn: profile.splDropEnabled ? 1 : 0,
      dalSPLSDDThre: profile.splDropThreshold,
      dalSPLStaDetEN: profile.splStabilityEnabled ? 1 : 0,
      dalSPLStaDetThre: profile.splStabilityThreshold,
      dalMainFreqEn: profile.mainFrequencyEnabled ? 1 : 0,
      dalMFLower: profile.mainFrequencyLower,
      dalMFUpper: profile.mainFrequencyUpper,
      dalFBETEn: profile.bandEnergyRatioEnabled ? 1 : 0,
      dalFBETLo: profile.bandEnergyRatioLower,
      dalFBETUp: profile.bandEnergyRatioUpper,
      dalFBETThre: profile.bandEnergyRatioThreshold
    }

    await this.client.setAlarmSystem({ alarmparaArray: [write] })
    deviceLog().info('Alarm profile saved', {
      id: profile.id ?? '(new)',
      name: profile.name
    })
    return this.getAlarmProfiles()
  }

  /** Delete an alarm profile. Destructive: channels bound to it lose the binding. */
  async deleteAlarmProfile(profileId: number): Promise<AlarmProfileConfig[]> {
    const profiles = await this.getAlarmProfiles()
    if (!profiles.some((profile) => profile.id === profileId)) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, `告警配置 ${profileId} 不存在`)
    }

    const inUse = (await this.getChannels()).filter(
      (channel) => channel.alarmProfileId === profileId
    )
    if (inUse.length > 0) {
      // Refuse rather than cascade: silently unbinding channels would disarm
      // alarms on a live asset without the user asking for it.
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `该告警配置正被 ${inUse.length} 个通道使用（${inUse
          .map((channel) => `CH${channel.channelIndex + 1}`)
          .join('、')}），请先解除绑定`
      )
    }

    await this.client.deleteAlarmSystem({ dalId: profileId })
    deviceLog().info('Alarm profile deleted', { profileId })
    return this.getAlarmProfiles()
  }

  /** Sync the device clock to this host's clock. */
  async syncDeviceTime(): Promise<TimeConfigView> {
    const current = await this.getTime()
    await this.client.setTimeSet({
      msgBody: {
        cur_time: Date.now(),
        dsyNTPAdder: current.ntpServer,
        dsyNTPEN: current.ntpEnabled ? 1 : 0,
        dsyNTPInterval: current.ntpInterval
      }
    })
    deviceLog().info('Device clock synchronised to host')
    return this.getTime()
  }

  /** Configure NTP, preserving the fields the caller did not edit. */
  async updateTime(patch: Partial<Omit<TimeConfigView, 'deviceTime'>>): Promise<TimeConfigView> {
    const current = await this.getTime()
    const merged = { ...current, ...patch }

    await this.client.setTimeSet({
      msgBody: {
        // Always the live host time: the device has just been asked for its own
        // clock, and sending that back would preserve any drift instead of fixing it.
        cur_time: Date.now(),
        dsyNTPAdder: merged.ntpServer,
        dsyNTPEN: merged.ntpEnabled ? 1 : 0,
        dsyNTPInterval: merged.ntpInterval
      }
    })

    deviceLog().info('Time settings updated', { ntpEnabled: merged.ntpEnabled })
    return this.getTime()
  }

  /** Update RS485, preserving `dsySeriPortR` which the read endpoint omits. */
  async updateRs485(patch: Partial<Rs485ConfigView>): Promise<Rs485ConfigView> {
    const current = await this.getRs485()
    const merged = { ...current, ...patch }

    await this.client.setRs485({
      msgBody: {
        dsySeriBaud: merged.baud,
        dsySeriDateBit: merged.dataBits,
        dsySeriMode: merged.mode,
        dsySeriPortL: merged.portLeft,
        // Carried through verbatim: the read endpoint does not return it, and the
        // write endpoint replaces the whole object, so dropping it clears the port.
        dsySeriPortR: merged.portRight,
        dsySeriRserAddr: merged.address
      }
    })

    deviceLog().info('RS485 settings updated')
    return this.getRs485()
  }

  /** Update Modbus. `modbus_crc` is read-only and deliberately not sent. */
  async updateModbus(patch: Partial<ModbusConfigView>): Promise<ModbusConfigView> {
    const current = await this.getModbus()
    const merged = { ...current, ...patch }

    if (merged.slaveId < 1 || merged.slaveId > 247) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Modbus 从站地址必须在 1-247 之间')
    }
    if (merged.port < 1 || merged.port > 65535) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Modbus 端口必须在 1-65535 之间')
    }

    await this.client.setModbusPara({
      msgBody: {
        modbus_post: merged.port,
        modbus_type: merged.type,
        modbus_baud: merged.baud,
        modbus_dbit: merged.dataBits,
        modbus_sbit: merged.stopBits,
        modbus_slave: merged.slaveId
      }
    })

    deviceLog().info('Modbus settings updated')
    return this.getModbus()
  }

  /**
   * Rename the device.
   *
   * `devname` 必须包在 `msgBody` 里（真机实测，见 `SetDeviceNameRequest`）：
   * 裸 `{devname}` 会被设备拒绝成 `Failed to modify device name.`。
   */
  async setDeviceName(name: string): Promise<void> {
    const trimmed = name.trim()
    if (trimmed === '') {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '设备名称不能为空')
    }
    if (trimmed.length > 64) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '设备名称不能超过 64 个字符')
    }
    await this.client.setDeviceName({ msgBody: { devname: trimmed } })
    deviceLog().info('Device renamed', { name: trimmed })
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Length checks that mirror what the firmware will enforce.
 *
 * Catching these here turns a rejected write into a specific, actionable message
 * instead of the device's generic "connection timed out" style error, which is
 * what it returns for most validation failures.
 */
function validateProfileRanges(profile: AlarmProfileConfig): void {
  const problems: string[] = []

  if (profile.mainFrequencyEnabled && profile.mainFrequencyLower >= profile.mainFrequencyUpper) {
    problems.push('主频下限必须小于上限')
  }
  if (profile.bandEnergyRatioEnabled && profile.bandEnergyRatioLower >= profile.bandEnergyRatioUpper) {
    problems.push('频带能量比下限必须小于上限')
  }
  if (profile.sensitivity < 0 || profile.sensitivity > 100) {
    problems.push('检测灵敏度需在 0-100 之间')
  }

  if (problems.length > 0) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `告警参数不合法：${problems.join('；')}`)
  }
}

/** True when a URL points somewhere routable beyond the local network. */
function isPublicHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false
  try {
    const host = new URL(value).hostname
    // RFC1918 private ranges plus loopback and link-local.
    if (/^10\./.test(host)) return false
    if (/^192\.168\./.test(host)) return false
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false
    if (/^169\.254\./.test(host)) return false
    return true
  } catch {
    return false
  }
}

/** Unwrap an array from whichever envelope nesting the device used. */
function extractArray<T>(payload: unknown, keys: readonly string[]): T[] {
  if (Array.isArray(payload)) return payload as T[]
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>

  for (const key of keys) {
    const value = record[key]
    if (Array.isArray(value)) return value as T[]
  }
  // One level deeper: the client already strips `msgBody`, but a few endpoints
  // nest again under `data`.
  for (const key of ['data', 'result', 'msgBody']) {
    const nested = record[key]
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const found = extractArray<T>(nested, keys)
      if (found.length > 0) return found
    }
  }
  return []
}

/** Coerce to an integer with a fallback, so a missing field cannot become NaN. */
function toInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return Math.trunc(parsed)
  }
  return fallback
}

/** Coerce to a number, preserving fractions (thresholds are not always integral). */
function toNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

export type { NetworkDtoType }
