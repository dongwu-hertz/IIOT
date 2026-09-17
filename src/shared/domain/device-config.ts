/**
 * Device-configuration view models — the presentation contract.
 *
 * WHY THESE LIVE IN `shared/`
 * They were declared in the main-process services that produce them, which was
 * fine until `shared/ipc/contract.ts` needed to name them in `RendererApi`. A
 * TYPE-ONLY import across that boundary is not actually free: TypeScript follows
 * the file, and the file's runtime imports (`AppError`, the logger, protocol DTOs)
 * come with it. The renderer's project then had to compile main-process sources,
 * which quietly dissolved the process boundary the architecture rests on.
 *
 * Declaring the shapes here makes the dependency direction correct:
 *
 *     main service  ──implements──▶  shared view model  ◀──consumes──  renderer
 *
 * The services re-export these names, so existing imports keep working.
 *
 * NOTE: these are DATA shapes only. No behaviour, no protocol vocabulary — the
 * `dal*` / `dsy*` wire names are the mapper's business and never appear here.
 */

/** One alarm parameter profile, in presentation terms. */
export interface AlarmProfileConfig {
  /** Device-side id; absent for a profile that has not been created yet. */
  id?: number
  name: string
  /** 0 = 特征检测, 1 = AI 检测. */
  detectionType: number
  sensitivity: number
  interferenceSuppression: number
  /** SPL 过载 */
  splOverloadEnabled: boolean
  splOverloadThreshold: number
  /** SPL 突升 */
  splSurgeEnabled: boolean
  splSurgeThreshold: number
  /** SPL 突降 */
  splDropEnabled: boolean
  splDropThreshold: number
  /** SPL 稳定性 */
  splStabilityEnabled: boolean
  splStabilityThreshold: number
  /** 主频 */
  mainFrequencyEnabled: boolean
  mainFrequencyLower: number
  mainFrequencyUpper: number
  /** 频带能量比 */
  bandEnergyRatioEnabled: boolean
  bandEnergyRatioLower: number
  bandEnergyRatioUpper: number
  bandEnergyRatioThreshold: number
}

export interface ChannelConfigView {
  channelIndex: number
  name: string
  /** 0 = 麦克风, 1 = 传导 */
  sensorType: number
  enabled: boolean
  /** Alarm profile id this channel is bound to. */
  alarmProfileId: number
}

export interface NetworkConfigView {
  mode: string
  ip: string
  netmask: string
  gateway: string
  dns: string
  httpPort: number
  rtspPort: number
  tcpPort: number
}

export interface TimeConfigView {
  deviceTime: number
  ntpEnabled: boolean
  ntpServer: string
  /** Units unverified on the device; carried through unchanged when not edited. */
  ntpInterval: number
}

export interface Rs485ConfigView {
  baud: number
  dataBits: number
  mode: number
  portLeft: string
  /**
   * The WRITE endpoint expects this but the READ endpoint does not return it.
   * Carried as an empty string when unknown, and passed through verbatim on
   * write so an unedited field is not silently cleared.
   */
  portRight: string
  address: string
}

export interface ModbusConfigView {
  port: number
  type: number
  baud: number
  dataBits: number
  stopBits: number
  slaveId: number
}

export interface PushConfigView {
  featureEnabled: boolean
  featureUrl: string
  alarmEnabled: boolean
  alarmUrl: string
  graphEnabled: boolean
  graphUrl: string
  heatEnabled: boolean
  heatUrl: string
  heatInterval: number
  /** True when any channel points at a non-private address (data leaves the site). */
  targetsPublicAddress: boolean
}

export type NetworkChangeStage =
  | 'applying'
  | 'applied'
  | 'reconnecting'
  | 'connected'
  | 'verifying'
  | 'verified'
  | 'rolling-back'
  | 'rolled-back'
  | 'unreachable'

export interface NetworkChangeResult {
  /** True when the device answered on the new address and reports the new config. */
  success: boolean
  stage: NetworkChangeStage
  /** Address the device is now reachable at, when known. */
  address: string
  /** Human-readable outcome, suitable for showing directly. */
  message: string
  /** True when a rollback was attempted and succeeded. */
  rolledBack: boolean
  /** True when the device answers on neither address. */
  unreachable: boolean
  /** Network settings the device reports after the attempt. */
  observed?: NetworkConfigView
}
