/**
 * Fa371ApiClient —— FA371 在线声学相机（泄漏检测型）的 HTTP 客户端。
 *
 *   FA371 手册 §5.1（32 个接口的子集）
 *        -> [本文件] 认证 / 会话 / 请求封装 / 包络解包
 *        -> ./dto.ts 线上键名
 *        -> ./mappers.ts 域模型（本类**不**做映射，与 DeviceApiClient 一致）
 *
 * ---------------------------------------------------------------------------
 * 设计要点
 * ---------------------------------------------------------------------------
 * 1) **复用而不是重写**：HTTP 走 `../http-transport` 的 `HttpTransport`，
 *    认证派生与 Token 携带走 `../auth-strategy`（`derivePassword` = md5(明文+'lfxs')、
 *    `applyAuth`、`isAuthFailure` 全部来自那里）。本文件没有第二个 HTTP 层，
 *    也没有第二份口令派生实现。
 *
 * 2) **返回 PROTOCOL DTO，不返回域模型**：与 `DeviceApiClient` 相同的分工——
 *    映射是 `./mappers.ts` 的职责，本类只保证"发对了请求、解对了包络"。
 *
 * 3) **本类出现的线上键名只有包络字段** `ret` / `msg`（规格 §1 的通用返回字段），
 *    其余字段全部来自 `./dto.ts`。这是"固件字段名只允许出现在 DTO + mapper"
 *    这条规则下的最小例外，与 `DeviceApiClient.unwrap` 处理 `msgBody`/`result` 同理。
 *
 * ---------------------------------------------------------------------------
 * 手册未定义处（规格 §8）——本类如何显式建模，而不是猜
 * ---------------------------------------------------------------------------
 *   A1/A2 Token 携带方式：`FA371_AUTH_CANDIDATES`，按 §9.1 的实测优先级排序
 *        （裸 Authorization → Bearer → `token:` 自定义头），登录后逐条验证并采用
 *        第一条被接受的；结果通过 `onSessionEstablished` 交调用方持久化。
 *   A7 登录请求体形状：`FA371_LOGIN_ENVELOPE_CANDIDATES`（手册 §2.1 是裸对象，
 *        AE08 实测是 `msgBody` 包裹）。默认按手册发裸对象。
 *   C2 `/system/image` 的目标数量键名：`imagingTargetKey` 选项。
 *   C5 `PUT /system/video` 是否发只读的 `rtsp_connected_num`：选项显式控制，
 *        默认不发。
 *   C14 `GET /detect_logs` 的 `detect_id` 传参方式：`detectLogsQueryStyle` 选项。
 *   C22 策略诊断说明键名 `diagosisn` / `diagnosis`：`strategyDiagnosisKey` 选项。
 *   C24/C29/C30 三个 DELETE 的请求体形状：`idListBody` 选项。
 *   C25 `PUT /alarm_condition` 如何指定目标条件：`alarmConditionUpdateId` 选项。
 */

import { AppError, ErrorCodes } from '@shared/errors'
import { deviceLog } from '../../logging/logger'
import {
  applyAuth,
  findStrategy,
  isAuthFailure,
  type AuthSession,
  type AuthStrategy
} from '../auth-strategy'
import { buildUrl } from '../auth-resolver'
import { normaliseBaseUrl } from '../device-api-client'
import type { DeviceCredential } from '../credential-store'
import { MAX_BUFFERED_BYTES, type HttpTransport } from '../http-transport'
import {
  DEFAULT_FA371_ALARM_CONDITION_UPDATE_ID,
  DEFAULT_FA371_DETECT_LOGS_QUERY_STYLE,
  DEFAULT_FA371_ID_LIST_BODY,
  DEFAULT_FA371_IMAGING_TARGET_KEY,
  DEFAULT_FA371_LOGIN_ENVELOPE,
  DEFAULT_FA371_STRATEGY_DIAGNOSIS_KEY,
  FA371_ALARM_CONDITION_UPDATE_ID_CANDIDATES,
  FA371_DETECT_LOGS_QUERY_STYLE_CANDIDATES,
  FA371_ID_LIST_BODY_CANDIDATES,
  FA371_IMAGING_TARGET_KEY_CANDIDATES,
  FA371_LOGIN_ENVELOPE_CANDIDATES,
  FA371_NC_UPLOAD_FILE_FIELD,
  FA371_NC_UPLOAD_NOTES_FIELD,
  FA371_STRATEGY_DIAGNOSIS_KEY_CANDIDATES,
  type Fa371AckDto,
  type Fa371AcousticDto,
  type Fa371AcousticWriteDto,
  type Fa371AlarmConditionPageDto,
  type Fa371AlarmConditionUpdateIdStyleId,
  type Fa371AlarmConditionWriteDto,
  type Fa371AlarmStrategyCreateDto,
  type Fa371AlarmStrategyEnableWriteDto,
  type Fa371AlarmStrategyPageDto,
  type Fa371AlarmStrategyUpdateDto,
  type Fa371BasicInfoDto,
  type Fa371DetectLogsEnvelopeDto,
  type Fa371DetectStatusDto,
  type Fa371DetectLogsQueryStyleId,
  type Fa371DownloadedFile,
  type Fa371IdListBodyId,
  type Fa371ImagingDto,
  type Fa371ImagingTargetKeyId,
  type Fa371ImagingWriteDto,
  type Fa371LeakageDto,
  type Fa371LeakageWriteDto,
  type Fa371LoginEnvelopeId,
  type Fa371NcFilePageDto,
  type Fa371NcUploadDto,
  type Fa371RunModeDto,
  type Fa371RunModeWriteDto,
  type Fa371ScanAreaDto,
  type Fa371ScanAreaWriteDto,
  type Fa371StrategyDiagnosisKeyId,
  type Fa371SystemDto,
  type Fa371SystemTimeDto,
  type Fa371SystemTimeWriteDto,
  type Fa371TurnOnDetectDto,
  type Fa371UpgradeProgressDto,
  type Fa371VersionInfoDto,
  type Fa371VideoDto,
  type Fa371VideoWriteDto,
  type Fa371WorkModeWriteDto
} from './dto'
// 包络判定与路径拼接复用 mapper 的实现：本文件不重新实现"什么算成功"，
// 也不重新实现 `saving_path` 尾斜杠的规整（§5.1.18 缺口）。
import { fa371ErrorMessage, isFa371Success, joinDetectFilePath } from './mappers'

// ---------------------------------------------------------------------------
// 端点表（规格 §3 的接口清单，逐字照抄路径）
// ---------------------------------------------------------------------------

/**
 * 路径全部来自规格 §3 的总表（现已由 2026-09 的
 * `docs/reference/api-workflow.txt` 完整接口表确认），`snake_case` 原样保留——
 * 手册特意提醒不要改写成 camelCase / kebab-case（§3 路径拼写注意）。
 *
 * 两个例外，都在本文件里逐条标注了实测依据：
 *   - `alarmStrategyEnable`：新手册第 340–346 行的 `GET`/`PUT /alarm_strategy_enable`，
 *     旧手册漏掉了这一对接口（更正见 `docs/FA371-API-DELTA.md` §1）；
 *   - `versionInfo` / `basicInfo`：手册**未收录**、设备自带 Web 界面在用的只读接口，
 *     实测存在（见 `dto.ts` 里 `Fa371VersionInfoDto` / `Fa371BasicInfoDto` 的实测记录）。
 */
export const FA371_ENDPOINTS = {
  login: '/login',
  acoustic: '/system/acoustic',
  image: '/system/image',
  video: '/system/video',
  runMode: '/run_mode',
  leakage: '/system/leakage',
  scanArea: '/system/scan_area',
  turnOnDetect: '/turn_on_detect',
  turnOffDetect: '/turn_off_detect',
  /** §5.1.16：手册 URL 行给的是 `/system/detect_status`（以 Request method and URL 行为准）。 */
  detectStatus: '/system/detect_status',
  detectLogs: '/detect_logs',
  /** §5.1.18：`/detect_file/{saving_path}/{file_name}`，前缀如下。 */
  detectFile: '/detect_file',
  systemTime: '/system_time',
  /** §5.1.21：功能描述行误写 `/system_time`，实际路径是 `/time_set_manually`（§8.3 C20）。 */
  timeSetManually: '/time_set_manually',
  alarmStrategy: '/alarm_strategy',
  /** 新手册第 340–346 行：读启用中的策略（GET）/ 启停策略（PUT）。 */
  alarmStrategyEnable: '/alarm_strategy_enable',
  alarmCondition: '/alarm_condition',
  uploadNc: '/upload_nc',
  ncFileList: '/nc_filelist',
  ncFile: '/nc_file',
  /** 手册未收录、实测存在（只读）：固件/SDK 版本。 */
  versionInfo: '/dev_info',
  /** 手册未收录、实测存在（只读）：设备基础信息，含 Web 版本与上次升级时刻。 */
  basicInfo: '/basic',
  /**
   * **应用模式（局部放电 / 气体泄漏 / 机械异响）—— ⚠ 未文档化，实测可读也可写。**
   *
   * 这个路径**不在任何一份手册里**，§5.1 的 32 个接口清单里也没有它；它是从设备自带
   * Web 界面的 bundle 里读出来的（前端用 `on().then(e => e.data.work_mode)`，而 `on()`
   * 打的就是 `/system`）。所有 `*mode*` 猜想路径（`/system/work_mode`、`/system/app_mode`、
   * `/system/mode`、`/system/device_mode`、`/system/product_mode`）在真机上一律 404。
   *
   * 实测（`192.168.110.235`，`V0.5.1.6_251219`）：
   *   GET  `/system`                    → `200 {"msg":"SUCCESS","ret":200,"work_mode":1}`
   *   PUT  `/system` `{"work_mode":2}`  → `200 {"msg":"SUCCESS","ret":200}`，重读 `work_mode:2`
   *   PUT  `/system` `{"work_mode":3}`  → `200`，重读 `work_mode:3`
   *   PUT  `/system` `{"work_mode":1}`  → `200`，重读 `work_mode:1`
   *
   * **所以这是"实测存在"的接口，不是"受支持"的接口**：固件升级后它可能消失或改语义，
   * 而且它的响应形状没有任何手册保证。调用方必须按"未文档化"对待它 —— 写后重读
   * （见 `CameraControlService.writeWorkMode`），并且不得把它当成官方 API 引用。
   */
  system: '/system',

  // ---------------------------------------------------------------------------
  // 设备自带 Web 界面用的**未公开维护接口**（升级三件套）
  //
  // 三个路径都不在任何一份手册里，是从设备自带前端的 bundle
  // （`/static/js/main.<hash>.js`，2.26 MB，只读 GET 下来做的静态分析）里读出来的：
  //
  //   `function jn(e){return en('/reboot',e)}`  ← `en` 是 PUT 封装
  //   `function Dn(e){return Qt('/progress',e)}`← `Qt` 是 GET 封装（不是同一个 helper）
  //   `Nn`（上传封装）→ `Zt({url:'/upload', method:'post', timeout:18e5, ...})`
  //
  // 真机只读复核（`192.168.110.235`，本次）：
  //   `GET  /progress` → 200 `{"msg":"SUCCESS","ret":200,"upgrade_progress":-2.0}`
  //   `GET  /reboot`   → **404**（nginx 风格），即该路径由设备 API 处理而 GET 未实现；
  //                      `OPTIONS /reboot` → 204。两者都印证 `/reboot` 不是 SPA 兜底
  //                      路由（那些路径 GET 会回 200 + `index.html`）。
  //   `POST /upload` / `PUT /reboot` 的**实际行为没有调用过**（会改设备状态）。
  //
  // 所以这三条是"实测存在"的接口，不是"受支持"的接口：换一版固件它可能消失，
  // 调用方必须按未文档化接口对待（读不到就如实说，拿不准的地方不编数字）。
  // ---------------------------------------------------------------------------

  /** `POST /upload`：升级包（multipart/form-data）。实际发送在升级服务里，见其说明。 */
  upgradeUpload: '/upload',
  /** `PUT /reboot`：重启设备（bundle 里 `en('/reboot')` 是 PUT）。 */
  reboot: '/reboot',
  /** `GET /progress`：升级进度。 */
  upgradeProgress: '/progress'
} as const

/**
 * 认证探测用的验证端点。
 *
 * 选 `/system/detect_status`（§5.1.16）：GET、无参数、无副作用，
 * 且是全组唯一连 `ret`/`msg` 都不带的接口——只读一次就能判定 Token 是否被接受。
 * 注意不能沿用 `AuthStrategyResolver`：它把登录体包成 `msgBody` 并把验证端点写死为
 * `/get_devinfo`，两者都是 FA8/AE08 的实测形状，FA371 手册 §2.1 明确是裸登录体，
 * 且 §8.5 E10 说明本设备**没有**系统信息读取接口。
 */
export const FA371_VERIFY_PATH = FA371_ENDPOINTS.detectStatus

// ---------------------------------------------------------------------------
// Token 携带方式候选（规格 §2.2 + §8.1 A1/A2）
// ---------------------------------------------------------------------------

/**
 * FA371 的 Token 携带方式候选。
 *
 * 手册 §2.2 只说「attach token to the Authorization」，**没有说是否要 `Bearer ` 前缀**，
 * 也没说是否还需要额外的自定义头。这两条都是规格 §8.1 的 P0 风险项
 * （本项目其它设备曾因加了 `Bearer ` 前缀被拒）。所以这里给出一个具名候选集，
 * 由 `resolveSession()` 对真机逐条验证，胜出的 strategy id 交给调用方持久化。
 *
 * 复用 `auth-strategy.ts` 里已有的 strategy 定义（不复制、不 fork）：
 * 候选只保存 id，实际行为（carrier / buildLoginBody / extractToken）从那里取。
 */
export interface Fa371AuthCandidate {
  /** 对应 `auth-strategy.CANDIDATE_STRATEGIES` 的 strategy id。 */
  id: string
  /** 供 Protocol Lab 报告使用的中文说明。 */
  description: string
  /** 手册/规格出处。 */
  specRef: string
}

export const FA371_AUTH_CANDIDATES: readonly Fa371AuthCandidate[] = [
  {
    id: 'raw-auth-header',
    description: 'Authorization: <token>（无前缀，手册字面读法）',
    specRef: '规格 §2.2；§8.1 A1'
  },
  {
    id: 'bearer-header',
    description: 'Authorization: Bearer <token>',
    specRef: '规格 §8.1 A1（第一等风险项：本项目其它设备曾因加前缀被拒）'
  },
  {
    id: 'token-header',
    description: 'token: <token>（自定义头，手册未提及）',
    specRef: '规格 §8.1 A2'
  }
]

// ---------------------------------------------------------------------------
// 选项
// ---------------------------------------------------------------------------

export interface Fa371ApiClientOptions {
  transport: HttpTransport
  /** 形如 `http://192.168.2.168`（无尾斜杠）。缺端口时按手册默认 80。 */
  baseUrl: string
  credential: DeviceCredential
  /** 上次解析成功的 strategy id（持久化在设备记录里），优先尝试。 */
  preferredStrategyId?: string
  timeoutMs?: number
  /** 会话建立后回调，调用方据此持久化 strategy id（与 DeviceApiClient 同形）。 */
  onSessionEstablished?: (strategyId: string) => void
  /** 登录请求体封装（§2.1 裸对象 vs AE08 的 msgBody）。默认按手册：裸对象。 */
  loginEnvelope?: Fa371LoginEnvelopeId
  /** 写成像配置时"目标数量"的键名（§8.3 C2）。默认 `target_number`。 */
  imagingTargetKey?: Fa371ImagingTargetKeyId
  /** 写告警策略时诊断说明的键名（§8.3 C22）。默认 `diagosisn`。 */
  strategyDiagnosisKey?: Fa371StrategyDiagnosisKeyId
  /** 三个 DELETE 接口的请求体形状（§8.3 C24/C29/C30）。默认 `{"id":[...]}`。 */
  idListBody?: Fa371IdListBodyId
  /** `PUT /alarm_condition` 的目标条件标识方式（§8.3 C25）。默认带 `id`。 */
  alarmConditionUpdateId?: Fa371AlarmConditionUpdateIdStyleId
  /** `GET /detect_logs` 的 `detect_id` 传参方式（§8.3 C14）。默认 query。 */
  detectLogsQueryStyle?: Fa371DetectLogsQueryStyleId
}

/** 单次调用选项。 */
export interface Fa371CallOptions {
  timeoutMs?: number
  signal?: AbortSignal
  /** 二进制下载的缓冲上限。 */
  maxBytes?: number
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

export class Fa371ApiClient {
  private readonly transport: HttpTransport
  private readonly credential: DeviceCredential
  private readonly timeoutMs: number
  private readonly onSessionEstablished?: (strategyId: string) => void

  private baseUrl: string
  private preferredStrategyId?: string
  private session?: AuthSession
  private strategy?: AuthStrategy
  /** 合并并发登录：5 个并行调用不得打 5 次 `/login`。 */
  private loginInFlight?: Promise<void>

  // -- 手册未定义处的选择（构造时固定，实例上可读，便于日志与协议报告） ----

  /** 登录体封装候选（§2.1 / §8.1 A7）。 */
  readonly loginEnvelope: (typeof FA371_LOGIN_ENVELOPE_CANDIDATES)[number]
  /** 成像"目标数量"键名候选（§8.3 C2）。 */
  readonly imagingTargetKey: (typeof FA371_IMAGING_TARGET_KEY_CANDIDATES)[number]
  /** 策略诊断说明键名候选（§8.3 C22）。 */
  readonly strategyDiagnosisKey: (typeof FA371_STRATEGY_DIAGNOSIS_KEY_CANDIDATES)[number]
  /** id 数组请求体候选（§8.3 C24/C29/C30）。 */
  readonly idListBody: (typeof FA371_ID_LIST_BODY_CANDIDATES)[number]
  /** 告警条件更新标识候选（§8.3 C25）。 */
  readonly alarmConditionUpdateId: (typeof FA371_ALARM_CONDITION_UPDATE_ID_CANDIDATES)[number]
  /** 检测日志传参风格候选（§8.3 C14）。 */
  readonly detectLogsQueryStyle: (typeof FA371_DETECT_LOGS_QUERY_STYLE_CANDIDATES)[number]

  constructor(options: Fa371ApiClientOptions) {
    this.transport = options.transport
    this.credential = options.credential
    this.baseUrl = normaliseBaseUrl(options.baseUrl)
    this.timeoutMs = options.timeoutMs ?? 8_000
    if (options.preferredStrategyId) this.preferredStrategyId = options.preferredStrategyId
    if (options.onSessionEstablished) this.onSessionEstablished = options.onSessionEstablished

    this.loginEnvelope = findLoginEnvelope(options.loginEnvelope)
    this.imagingTargetKey = findImagingTargetKey(options.imagingTargetKey)
    this.strategyDiagnosisKey = findDiagnosisKey(options.strategyDiagnosisKey)
    this.idListBody = findIdListBody(options.idListBody)
    this.alarmConditionUpdateId = findAlarmConditionUpdateId(options.alarmConditionUpdateId)
    this.detectLogsQueryStyle = findDetectLogsQueryStyle(options.detectLogsQueryStyle)
  }

  // -------------------------------------------------------------------------
  // 会话
  // -------------------------------------------------------------------------

  get currentBaseUrl(): string {
    return this.baseUrl
  }

  /** 设备最终接受的 Token 携带方式；未登录时为 undefined。 */
  get resolvedStrategyId(): string | undefined {
    return this.strategy?.id
  }

  /** 指向新地址（例如设备换 IP 后）。 */
  setBaseUrl(baseUrl: string): void {
    this.baseUrl = normaliseBaseUrl(baseUrl)
  }

  /** 丢弃会话，下次调用重新认证（§2.3：手册未定义 Token 有效期，只定义了 401）。 */
  invalidateSession(): void {
    this.session = undefined
    this.strategy = undefined
  }

  /** 采用别处已解析好的会话，避免重复登录。 */
  adoptSession(session: AuthSession, strategy: AuthStrategy): void {
    this.session = session
    this.strategy = strategy
    this.preferredStrategyId = strategy.id
  }

  /**
   * 显式登录（`POST /login`）并解析出可用的 Token 携带方式。
   *
   * 语义上等于"强制重新认证"：先丢弃现有会话，再走一遍候选探测。
   */
  async login(options: Fa371CallOptions = {}): Promise<AuthSession> {
    this.invalidateSession()
    await this.ensureSession(options)
    const session = this.session
    if (!session) throw new AppError(ErrorCodes.AUTH_FAILED, 'FA371 登录未产生会话')
    return session
  }

  /** 若还没有会话就登录；并发调用合并为一次。 */
  async ensureSession(options: Fa371CallOptions = {}): Promise<void> {
    if (this.session && this.strategy) return
    if (this.loginInFlight) return this.loginInFlight

    const login = async (): Promise<void> => {
      const resolved = await this.resolveSession(options)
      this.session = resolved.session
      this.strategy = resolved.strategy
      this.preferredStrategyId = resolved.strategy.id
      this.onSessionEstablished?.(resolved.strategy.id)
    }

    this.loginInFlight = login().finally(() => {
      this.loginInFlight = undefined
    })
    return this.loginInFlight
  }

  /**
   * 当前会话的认证头。
   *
   * 供将来的 WebSocket 握手复用（规格 §8.4 D1：**握手是否需要 `Authorization`、
   * Token 是否走 query，手册完全未说明**）。本方法只把已解析成功的携带方式
   * 暴露出来，不对 WebSocket 做任何假设。
   */
  authHeaders(): Record<string, string> {
    if (!this.session || !this.strategy) return {}
    return applyAuth(this.session, this.strategy).headers
  }

  /** 探活：不抛异常，与 `DeviceApiClient.ping` 同形。 */
  async ping(options: Fa371CallOptions = {}): Promise<boolean> {
    try {
      await this.getDetectStatus(options)
      return true
    } catch {
      return false
    }
  }

  // -------------------------------------------------------------------------
  // 读取接口
  // -------------------------------------------------------------------------

  /** `GET /system/acoustic`（§5.1.2）。 */
  getAcousticConfig(options: Fa371CallOptions = {}): Promise<Fa371AcousticDto> {
    return this.call<Fa371AcousticDto>(FA371_ENDPOINTS.acoustic, 'GET', undefined, options)
  }

  /** `GET /system/image`（§5.1.4）。 */
  getImagingConfig(options: Fa371CallOptions = {}): Promise<Fa371ImagingDto> {
    return this.call<Fa371ImagingDto>(FA371_ENDPOINTS.image, 'GET', undefined, options)
  }

  /** `GET /system/video`（§5.1.6）。 */
  getVideoConfig(options: Fa371CallOptions = {}): Promise<Fa371VideoDto> {
    return this.call<Fa371VideoDto>(FA371_ENDPOINTS.video, 'GET', undefined, options)
  }

  /** `GET /run_mode`（§5.1.8）。 */
  getRunMode(options: Fa371CallOptions = {}): Promise<Fa371RunModeDto> {
    return this.call<Fa371RunModeDto>(FA371_ENDPOINTS.runMode, 'GET', undefined, options)
  }

  /**
   * `GET /system` —— 应用模式（局部放电 / 气体泄漏 / 机械异响）。
   *
   * **⚠ 端点未文档化**（不在任何一份手册里，见 `FA371_ENDPOINTS.system` 的实测记录）。
   * 本方法只保证"发对了请求、解对了包络"；值到名字的映射在 `mapWorkMode` 里，
   * 认不出的值不会被强制成某个模式。
   *
   * 与 `getRunMode` 的区别值得重申：那是**检测模式**（单次/巡航，手册 §5.1.8），
   * 这是**应用模式**（这台设备在做哪种应用，无手册）。
   */
  getWorkMode(options: Fa371CallOptions = {}): Promise<Fa371SystemDto> {
    return this.call<Fa371SystemDto>(FA371_ENDPOINTS.system, 'GET', undefined, options)
  }

  /** `GET /system/leakage`（§5.1.10）。 */
  getLeakageConfig(options: Fa371CallOptions = {}): Promise<Fa371LeakageDto> {
    return this.call<Fa371LeakageDto>(FA371_ENDPOINTS.leakage, 'GET', undefined, options)
  }

  /** `GET /system/scan_area`（§5.1.12）。 */
  getScanArea(options: Fa371CallOptions = {}): Promise<Fa371ScanAreaDto> {
    return this.call<Fa371ScanAreaDto>(FA371_ENDPOINTS.scanArea, 'GET', undefined, options)
  }

  /**
   * `GET /system/detect_status`（§5.1.16）。
   *
   * 这个接口**没有 `ret`/`msg`**，响应的唯一字段是 `detect_status`；
   * `unwrap()` 对缺失 `ret` 的响应按成功处理（见 mappers.isFa371Success）。
   */
  getDetectStatus(options: Fa371CallOptions = {}): Promise<Fa371DetectStatusDto> {
    return this.call<Fa371DetectStatusDto>(FA371_ENDPOINTS.detectStatus, 'GET', undefined, options)
  }

  /**
   * `GET /detect_logs`（§5.1.17）。
   *
   * §8.3 C14（P0）：手册同页给出两种互相矛盾的传参方式（Query Param vs 路径段），
   * 分页参数完全没写。默认按正文的 Query Param，可用 `detectLogsQueryStyle` 切换。
   */
  getDetectLogs(
    detectId = 1,
    options: Fa371CallOptions = {}
  ): Promise<Fa371DetectLogsEnvelopeDto> {
    const path = this.detectLogsQueryStyle.buildPath(Math.trunc(detectId))
    return this.call<Fa371DetectLogsEnvelopeDto>(path, 'GET', undefined, options)
  }

  /** `GET /system_time`（§5.1.20）：响应没有 `ret`/`msg`，且单位未说明（§8.3 C19）。 */
  getSystemTime(options: Fa371CallOptions = {}): Promise<Fa371SystemTimeDto> {
    return this.call<Fa371SystemTimeDto>(FA371_ENDPOINTS.systemTime, 'GET', undefined, options)
  }

  /** `GET /alarm_strategy?page=`（§5.1.22）。 */
  listAlarmStrategies(page = 1, options: Fa371CallOptions = {}): Promise<Fa371AlarmStrategyPageDto> {
    const target = `${FA371_ENDPOINTS.alarmStrategy}?page=${encodeURIComponent(String(Math.trunc(page)))}`
    return this.call<Fa371AlarmStrategyPageDto>(target, 'GET', undefined, options)
  }

  /** `GET /alarm_condition?page=`（§5.1.26）。 */
  listAlarmConditions(
    page = 1,
    options: Fa371CallOptions = {}
  ): Promise<Fa371AlarmConditionPageDto> {
    const target = `${FA371_ENDPOINTS.alarmCondition}?page=${encodeURIComponent(String(Math.trunc(page)))}`
    return this.call<Fa371AlarmConditionPageDto>(target, 'GET', undefined, options)
  }

  /** `GET /nc_filelist?page=`（§5.1.31，每页默认 10 条）。 */
  listNcFiles(page = 1, options: Fa371CallOptions = {}): Promise<Fa371NcFilePageDto> {
    const target = `${FA371_ENDPOINTS.ncFileList}?page=${encodeURIComponent(String(Math.trunc(page)))}`
    return this.call<Fa371NcFilePageDto>(target, 'GET', undefined, options)
  }

  // -------------------------------------------------------------------------
  // 配置写入
  // -------------------------------------------------------------------------

  /** `PUT /system/acoustic`（§5.1.3）。手册标 `non-essential`，支持只发部分字段。 */
  setAcousticConfig(body: Fa371AcousticWriteDto, options: Fa371CallOptions = {}): Promise<Fa371AckDto> {
    return this.call<Fa371AckDto>(FA371_ENDPOINTS.acoustic, 'PUT', body, options)
  }

  /**
   * `PUT /system/image`（§5.1.5）。
   *
   * §8.3 C2（P0）：目标数量的真实键名未知（字段表 `target_numbe` vs 示例
   * `target_number`）。`options.targetCount` 给出数值时，按 `targetCountKey`
   * （或构造时的 `imagingTargetKey`）落到对应键上；不给则原样发送 `body`。
   */
  setImagingConfig(
    body: Fa371ImagingWriteDto,
    options: Fa371CallOptions & {
      targetCount?: number
      targetCountKey?: Fa371ImagingTargetKeyId
    } = {}
  ): Promise<Fa371AckDto> {
    const payload: Fa371ImagingWriteDto = { ...body }
    if (options.targetCount !== undefined) {
      const candidate = findImagingTargetKey(options.targetCountKey ?? this.imagingTargetKey.id)
      candidate.apply(payload, options.targetCount)
    }
    return this.call<Fa371AckDto>(FA371_ENDPOINTS.image, 'PUT', payload, options)
  }

  /**
   * `PUT /system/video`（§5.1.7）。
   *
   * §8.3 C5：请求字段表**没有** `rtsp_connected_num`（只读计数），但手册示例发了它。
   * 默认不发送（发送一个陈旧的连接数可能被设备当真）；需要严格照抄示例时
   * 传 `includeRtspConnectedNum: true`。
   */
  setVideoConfig(
    body: Fa371VideoWriteDto,
    options: Fa371CallOptions & { includeRtspConnectedNum?: boolean } = {}
  ): Promise<Fa371AckDto> {
    const payload: Fa371VideoWriteDto = { ...body }
    if (options.includeRtspConnectedNum !== true) delete payload.rtsp_connected_num
    return this.call<Fa371AckDto>(FA371_ENDPOINTS.video, 'PUT', payload, options)
  }

  /** `PUT /run_mode`（§5.1.9）：`1` 单次检测 / `-1` 智能巡航。 */
  setRunMode(body: Fa371RunModeWriteDto, options: Fa371CallOptions = {}): Promise<Fa371AckDto> {
    return this.call<Fa371AckDto>(FA371_ENDPOINTS.runMode, 'PUT', body, options)
  }

  /**
   * `PUT /system` —— 切换应用模式。**⚠ 端点未文档化**（见 `FA371_ENDPOINTS.system`）。
   *
   * 只构造 `{work_mode}` 一个键，**不发**任何其它字段：这台设备的 `/system` 有没有
   * 部分字段更新语义完全没有文档，多发一个字段就是拿设备配置赌一次。
   *
   * 参数只接受 `1` / `2` / `3`（真机实测过的三个值）：一个猜出来的数字发过去，
   * 最好的结果是设备忽略它，最坏的结果是设备进入一个谁也不知道的状态。
   */
  setWorkMode(
    body: Fa371WorkModeWriteDto,
    options: Fa371CallOptions = {}
  ): Promise<Fa371AckDto> {
    return this.call<Fa371AckDto>(FA371_ENDPOINTS.system, 'PUT', { work_mode: body.work_mode }, options)
  }

  /**
   * `PUT /system/leakage`（§5.1.11）。支持部分字段；两个 `*_str` 是否可写未说明
   * （§8.3 C8），DTO 里也没有它们。
   */
  setLeakageConfig(
    body: Fa371LeakageWriteDto,
    options: Fa371CallOptions = {}
  ): Promise<Fa371AckDto> {
    return this.call<Fa371AckDto>(FA371_ENDPOINTS.leakage, 'PUT', body, options)
  }

  /**
   * `PUT /system/scan_area`（§5.1.13）。
   *
   * 手册要求**所有字段都必须发送**（DTO 因此是必填字段）。
   * 坐标系单位未验证（§8.3 C9/C10）——本方法原样透传调用方给出的数字，
   * 不做任何换算或裁剪，因为手册没有给出合法边界。
   */
  setScanArea(body: Fa371ScanAreaWriteDto, options: Fa371CallOptions = {}): Promise<Fa371AckDto> {
    return this.call<Fa371AckDto>(FA371_ENDPOINTS.scanArea, 'PUT', body, options)
  }

  // -------------------------------------------------------------------------
  // 检测任务（§5.1.14 – §5.1.16）
  // -------------------------------------------------------------------------

  /**
   * `POST /turn_on_detect`（§5.1.14）：**无请求体**。
   *
   * 返回的 `detect_id` 只在单次检测模式出现；`ret = -1` 表示当前没有可用策略
   * （`call()` 会把它变成 DEVICE_ERROR，`msg` 原样带出）。
   */
  startDetection(options: Fa371CallOptions = {}): Promise<Fa371TurnOnDetectDto> {
    return this.call<Fa371TurnOnDetectDto>(FA371_ENDPOINTS.turnOnDetect, 'POST', undefined, options)
  }

  /**
   * `POST /turn_off_detect`（§5.1.15）：请求体无、**响应无内容**
   * （检测结果改由 WebSocket §5.2.3 异步推送）。
   * §8.3 C12：HTTP 状态码语义、重复调用、未在检测中调用的行为手册都未说明。
   */
  stopDetection(options: Fa371CallOptions = {}): Promise<void> {
    return this.call<void>(FA371_ENDPOINTS.turnOffDetect, 'POST', undefined, options)
  }

  // -------------------------------------------------------------------------
  // 检测日志与结果文件（§5.1.17 – §5.1.19）
  // -------------------------------------------------------------------------

  /**
   * `DELETE /detect_logs`（§5.1.19）：请求体是 id 数组。
   * §8.3 C18：字段表标 string、示例是数组 `[2,3]`；这里的形状由 `idListBody` 决定。
   */
  async deleteDetectLogs(ids: readonly number[], options: Fa371CallOptions = {}): Promise<Fa371AckDto> {
    const payload = this.buildIdListBody(ids, 'detect_logs')
    return this.call<Fa371AckDto>(FA371_ENDPOINTS.detectLogs, 'DELETE', payload, options)
  }

  /**
   * `GET /detect_file/{saving_path}/{file_name}`（§5.1.18）：下载检测结果文件。
   *
   * §8.3 C17（P1）：`saving_path` 自带结尾 `/`（示例 `"...940/"`），直接相加会得到
   * 双斜杠；是否必须带 `Authorization` 手册未说明——本方法照常发送 Token，
   * 因为不能依赖设备"忘了校验"。
   *
   * 防御：FA8 家族出现过"未知路径返回 SPA 的 index.html + HTTP 200"这种最隐蔽的
   * 失败（见 `DeviceApiClient.downloadRecording` 的注释），所以这里显式识别 HTML
   * 响应并抛 INVALID_RESPONSE，而不是把一段 HTML 当图片交给上层。
   */
  async downloadDetectFile(
    savingPath: string,
    fileName: string,
    options: Fa371CallOptions = {}
  ): Promise<Fa371DownloadedFile> {
    if (!fileName || fileName.trim() === '') {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '检测结果文件名为空')
    }
    return this.fetchDetectFile(savingPath, fileName, options, 0)
  }

  /** `downloadDetectFile` 的实现体；`attempt` 保证 401 只重登一次。 */
  private async fetchDetectFile(
    savingPath: string,
    fileName: string,
    options: Fa371CallOptions,
    attempt: number
  ): Promise<Fa371DownloadedFile> {
    await this.ensureSession(options)
    const session = this.session
    const strategy = this.strategy
    if (!session || !strategy) throw new AppError(ErrorCodes.AUTH_FAILED, '设备会话不可用')

    const relative = joinDetectFilePath(savingPath, fileName)
    const path = `${FA371_ENDPOINTS.detectFile}/${encodePathSegments(relative)}`
    const auth = applyAuth(session, strategy)

    const response = await this.transport.request({
      method: 'GET',
      url: buildUrl(this.baseUrl + path, auth.query),
      headers: auth.headers,
      // 结果文件（图片/视频/bin/wav）可能几十 MB，给足超时与缓冲上限。
      timeoutMs: options.timeoutMs ?? 120_000,
      signal: options.signal,
      binary: true,
      maxBytes: options.maxBytes ?? MAX_BUFFERED_BYTES,
      throwOnHttpError: false
    })

    if (isAuthFailure(response.status)) {
      // 与 call() 一致：401 只重试一次，避免设备持续拒绝时无限递归。
      if (attempt === 0) {
        this.invalidateSession()
        return this.fetchDetectFile(savingPath, fileName, options, attempt + 1)
      }
      throw new AppError(ErrorCodes.AUTH_FAILED, '设备拒绝认证（下载结果文件）', relative)
    }

    if (!response.ok || !response.bytes) {
      throw new AppError(
        ErrorCodes.DEVICE_ERROR,
        `下载检测结果文件失败 (HTTP ${response.status})`,
        relative
      )
    }

    if (looksLikeHtmlPayload(response.bytes, response.contentType)) {
      throw new AppError(
        ErrorCodes.INVALID_RESPONSE,
        '检测结果文件下载返回的是 HTML 而不是媒体文件（路径可能不存在）',
        relative
      )
    }

    return { bytes: response.bytes, contentType: response.contentType, status: response.status }
  }

  // -------------------------------------------------------------------------
  // 系统时间（§5.1.20 / §5.1.21）
  // -------------------------------------------------------------------------

  /**
   * `PUT /time_set_manually`（§5.1.21）：请求体键名是 `time`（读用 `sys_time`）。
   *
   * §8.3 C20 提醒读写键名不对称；§8.2 B5 提醒 `time` 的单位未说明
   * （手册示例 `12345678`）。本方法**原样发送数值**，单位由调用方决定。
   */
  setSystemTime(
    body: Fa371SystemTimeWriteDto,
    options: Fa371CallOptions = {}
  ): Promise<Fa371AckDto> {
    return this.call<Fa371AckDto>(FA371_ENDPOINTS.timeSetManually, 'PUT', body, options)
  }

  // -------------------------------------------------------------------------
  // 告警策略（§5.1.22 – §5.1.25）
  // -------------------------------------------------------------------------

  /**
   * `POST /alarm_strategy`（§5.1.23）。
   *
   * §8.3 C22（P0）：诊断说明的键名 `POST` 是 `diagosisn`、`PUT` 是 `diagnosis`。
   * 传 `options.diagnosis` 时按 `diagnosisKey`（或构造时的 `strategyDiagnosisKey`）
   * 落到对应键；不传则原样发送 `body`（调用方可在 DTO 里自行填好）。
   * §8.3 C22 还指出：新建成功后如何拿到新策略 id 手册未说明——本方法只返回
   * `ret`/`msg`，id 需要调用方重新 `listAlarmStrategies()` 去认领。
   */
  createAlarmStrategy(
    body: Fa371AlarmStrategyCreateDto,
    options: Fa371CallOptions & {
      diagnosis?: string
      diagnosisKey?: Fa371StrategyDiagnosisKeyId
    } = {}
  ): Promise<Fa371AckDto> {
    const payload: Fa371AlarmStrategyCreateDto = { ...body }
    if (options.diagnosis !== undefined) {
      const candidate = findDiagnosisKey(options.diagnosisKey ?? this.strategyDiagnosisKey.id)
      candidate.apply(payload, options.diagnosis)
    }
    return this.call<Fa371AckDto>(FA371_ENDPOINTS.alarmStrategy, 'POST', payload, options)
  }

  /**
   * `PUT /alarm_strategy`（§5.1.25）。
   *
   * **已启用的策略不能被修改**（手册原文，`practical-guide.txt` 的排障表也重申：
   * "Strategy is enabled (locked) → First call `PUT /alarm_strategy_enable` to disable
   * it, then modify it."），设备以 `ret = -1` 拒绝 → 变成 `DEVICE_ERROR` 并由 `msg`
   * 说明原因。
   *
   * 启停策略**有**端点：`GET`/`PUT /alarm_strategy_enable`（见下面两个方法）。
   * 旧手册与旧规格曾断言"开放接口里完全缺失启停接口"（缺口 C33），
   * 该结论已被 2026-09 的新手册证伪，更正记录在 `docs/FA371-API-DELTA.md` §1。
   */
  updateAlarmStrategy(
    body: Fa371AlarmStrategyUpdateDto,
    options: Fa371CallOptions & { diagnosis?: string; diagnosisKey?: Fa371StrategyDiagnosisKeyId } = {}
  ): Promise<Fa371AckDto> {
    const payload: Fa371AlarmStrategyUpdateDto = { ...body }
    if (options.diagnosis !== undefined) {
      const candidate = findDiagnosisKey(options.diagnosisKey ?? this.strategyDiagnosisKey.id)
      candidate.apply(payload, options.diagnosis)
    }
    return this.call<Fa371AckDto>(FA371_ENDPOINTS.alarmStrategy, 'PUT', payload, options)
  }

  /**
   * `GET /alarm_strategy_enable` —— 读当前**启用中**的策略。
   *
   * 返回体与 `GET /alarm_strategy` 同形（`alarm_strategy_list`），真机实测
   * （`192.168.110.235`，`V0.5.1.6_251219`）：
   *   未启用任何策略 → `{"alarm_strategy_list":[],"msg":"SUCCESS","ret":200}`
   *   启用 id=1 之后 → 同一数组里出现完整的策略对象且 `switch:1`
   * 所以本方法直接返回 `Fa371AlarmStrategyPageDto`，映射沿用 `mapAlarmStrategyPage`。
   */
  getEnabledAlarmStrategies(options: Fa371CallOptions = {}): Promise<Fa371AlarmStrategyPageDto> {
    return this.call<Fa371AlarmStrategyPageDto>(FA371_ENDPOINTS.alarmStrategyEnable, 'GET', undefined, options)
  }

  /**
   * `PUT /alarm_strategy_enable` —— 启用/停用一条策略（新手册第 129–134 行）。
   *
   * 两条硬约束，调用方必须自己遵守（本方法只负责发对请求）：
   *   1. **设备同时只允许一条策略启用**（系统资源限制），所以启用 B 之前要先停用
   *      当前启用的 A —— 文档给的顺序就是"先停用、再启用"；
   *   2. `ret = -1` 的实测含义是"启用失败，当前启用的策略数量已达上限"
   *      （设备自带 Web 界面里就有这句文案），会由 `unwrap` 变成 `DEVICE_ERROR`。
   *
   * 请求体形状 `{switch, id}` 与设备自带 Web 界面完全一致（见 DTO 的说明），
   * 不是猜的。
   */
  setAlarmStrategyEnabled(
    body: Fa371AlarmStrategyEnableWriteDto,
    options: Fa371CallOptions = {}
  ): Promise<Fa371AckDto> {
    return this.call<Fa371AckDto>(FA371_ENDPOINTS.alarmStrategyEnable, 'PUT', body, options)
  }

  // -------------------------------------------------------------------------
  // 手册未收录、实测存在的只读接口（设备自带 Web 界面在用）
  // -------------------------------------------------------------------------

  /**
   * `GET /dev_info` —— 固件版本与 SDK 版本（只读）。
   *
   * 手册 §5.1 的接口清单里没有它，旧规格据此写过"系统信息读取只有 UI"（§8.5 E10）；
   * 实测该路径存在且返回 JSON。**不要**改成箱子的 `/get_devinfo`：那个在本设备上
   * 落到 SPA 兜底路由（HTTP 200 + `index.html`），`call()` 会把它当成路径不存在。
   */
  getVersionInfo(options: Fa371CallOptions = {}): Promise<Fa371VersionInfoDto> {
    return this.call<Fa371VersionInfoDto>(FA371_ENDPOINTS.versionInfo, 'GET', undefined, options)
  }

  /** `GET /basic` —— 设备基础信息，含 `web_version` 与 `upgrade_time`（只读，手册未收录）。 */
  getBasicInfo(options: Fa371CallOptions = {}): Promise<Fa371BasicInfoDto> {
    return this.call<Fa371BasicInfoDto>(FA371_ENDPOINTS.basicInfo, 'GET', undefined, options)
  }

  /**
   * `GET /progress` —— 设备自报的升级进度（只读，手册未收录）。
   *
   * 真机只读实测：`{"msg":"SUCCESS","ret":200,"upgrade_progress":-2.0}`，其中 `-2`
   * 的含义**没有文档**。本方法只保证"发对了请求、解对了包络"，不解释那个数字
   * （`CameraUpgradeProgress` 也是如此）。
   *
   * 未认证时设备回的是 **HTTP 200 + `{"msg":"No Auth","ret":401}`**（实测），
   * 所以不能只看状态码：`call()`/`unwrap()` 会按 `ret` 判成 `DEVICE_ERROR` 并带出
   * `msg` 原文，这正是要的。
   */
  getUpgradeProgress(options: Fa371CallOptions = {}): Promise<Fa371UpgradeProgressDto> {
    return this.call<Fa371UpgradeProgressDto>(FA371_ENDPOINTS.upgradeProgress, 'GET', undefined, options)
  }

  /**
   * `PUT /reboot` —— 重启设备。**⚠ 未文档化，且会中断设备上的一切。**
   *
   * 方法是**读 bundle 得到的**，不是猜的：`en('/reboot', e)` 里的 `en` 是 PUT 封装，
   * 而 GET 用的 `Qt` 是另一个 helper；真机上也复核过 `GET /reboot` → 404
   * （API 命名空间，不做 GET），与 SPA 兜底路由的形状不同。
   *
   * 设备重启时可能**在应答之前就断开连接**，那时会以 `NETWORK_ERROR` / `TIMEOUT`
   * 抛出。本方法不把那件事解释成什么，交给调用方（升级服务据此区分
   * "设备没回执"与"真的失败了"）。
   */
  reboot(options: Fa371CallOptions = {}): Promise<void> {
    return this.call<void>(FA371_ENDPOINTS.reboot, 'PUT', undefined, options)
  }

  /**
   * `DELETE /alarm_strategy`（§5.1.24）：请求体是 id 数组，
   * **手册没有给出字段名**（§8.3 C24，P0）→ 形状由 `idListBody` 候选决定。
   */
  async deleteAlarmStrategies(
    ids: readonly number[],
    options: Fa371CallOptions = {}
  ): Promise<Fa371AckDto> {
    const payload = this.buildIdListBody(ids, 'alarm_strategy')
    return this.call<Fa371AckDto>(FA371_ENDPOINTS.alarmStrategy, 'DELETE', payload, options)
  }

  // -------------------------------------------------------------------------
  // 告警条件（§5.1.26 – §5.1.29）
  // -------------------------------------------------------------------------

  /**
   * `POST /alarm_condition`（§5.1.27）。
   *
   * 开关语义（手册注意 7）：**只有 `*_switch` 打开的分支参与判定**。
   * `discharge_switch`/`discharge_logical_operator`/`discharge_type` 属于本接口与
   * PUT，读取侧没有（§8.3 C26 写读不对称）。
   */
  createAlarmCondition(
    body: Fa371AlarmConditionWriteDto,
    options: Fa371CallOptions = {}
  ): Promise<Fa371AckDto> {
    return this.call<Fa371AckDto>(FA371_ENDPOINTS.alarmCondition, 'POST', body, options)
  }

  /**
   * `PUT /alarm_condition`（§5.1.28）。
   *
   * §8.3 C25（P0，本规格最严重的缺口之一）：**请求字段表里没有 `id`**，
   * 无法从手册得知要修改哪一条条件。因此目标标识方式由候选决定：
   * 默认沿用 `PUT /alarm_strategy` 的先例发 `id`；`'none'` 严格照字段表发送
   * （调用方需自行确认设备如何定位）；`'alarm_condition_id'` 用读取侧的拼写。
   */
  async updateAlarmCondition(
    body: Fa371AlarmConditionWriteDto,
    options: Fa371CallOptions & {
      targetId?: number | string
      idStyle?: Fa371AlarmConditionUpdateIdStyleId
    } = {}
  ): Promise<Fa371AckDto> {
    const candidate = findAlarmConditionUpdateId(options.idStyle ?? this.alarmConditionUpdateId.id)
    const payload: Record<string, unknown> = { ...body }
    if (candidate.id !== 'none') {
      if (options.targetId === undefined) {
        throw new AppError(
          ErrorCodes.VALIDATION_ERROR,
          'PUT /alarm_condition 需要 targetId（手册未定义请求体里的 id 字段，见规格 §8.3 C25）'
        )
      }
      candidate.apply(payload, options.targetId)
    }
    return this.call<Fa371AckDto>(FA371_ENDPOINTS.alarmCondition, 'PUT', payload, options)
  }

  /** `DELETE /alarm_condition`（§5.1.29）：字段名同样缺失（§8.3 C29，P0）。 */
  async deleteAlarmConditions(
    ids: readonly number[],
    options: Fa371CallOptions = {}
  ): Promise<Fa371AckDto> {
    const payload = this.buildIdListBody(ids, 'alarm_condition')
    return this.call<Fa371AckDto>(FA371_ENDPOINTS.alarmCondition, 'DELETE', payload, options)
  }

  // -------------------------------------------------------------------------
  // 噪声比对文件（§5.1.30 – §5.1.32）
  // -------------------------------------------------------------------------

  /**
   * `POST /upload_nc`（§5.1.30）：`multipart/form-data`，字段 `nc_file` + `notes`。
   *
   * §8.3 C31（P1）：返回的 `ret`/`msg` 取值、**是否回传新文件 id 都未说明**，
   * 所以返回的是整个响应对象（`Fa371NcUploadDto` 带索引签名），
   * 调用方若需要 `noise_comparison_file_id`，只能用 `listNcFiles()` 反查。
   *
   * 不是 JSON 调用（`call()` 只发 JSON），因此直接走 transport。
   */
  async uploadNcFile(
    fileName: string,
    bytes: Uint8Array,
    notes: string,
    options: Fa371CallOptions = {}
  ): Promise<Fa371NcUploadDto> {
    if (!fileName || fileName.trim() === '') {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '比对文件名不能为空')
    }

    await this.ensureSession(options)
    const session = this.session
    const strategy = this.strategy
    if (!session || !strategy) throw new AppError(ErrorCodes.AUTH_FAILED, '设备会话不可用')

    const auth = applyAuth(session, strategy)
    const form = new FormData()
    // 复制出一段独立的 buffer：Uint8Array 视图可能背靠更大的 ArrayBuffer，
    // 直接交给 Blob 会把整个底层缓冲发出去。
    const payload = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer
    form.append(FA371_NC_UPLOAD_FILE_FIELD, new Blob([payload]), fileName)
    form.append(FA371_NC_UPLOAD_NOTES_FIELD, notes)

    const response = await this.transport.request({
      method: 'POST',
      url: buildUrl(this.baseUrl + FA371_ENDPOINTS.uploadNc, auth.query),
      headers: auth.headers,
      rawBody: form,
      // 比对文件是 bin 音频，可能较大；与固件上传同样的量级。
      timeoutMs: options.timeoutMs ?? 120_000,
      signal: options.signal,
      throwOnHttpError: false
    })

    if (!response.ok) {
      throw new AppError(
        ErrorCodes.DEVICE_ERROR,
        `上传比对文件失败 (HTTP ${response.status})`,
        fileName
      )
    }

    return this.unwrap<Fa371NcUploadDto>(response.json, FA371_ENDPOINTS.uploadNc)
  }

  /** `DELETE /nc_file`（§5.1.32）：字段名缺失（§8.3 C30，P0）；功能描述行是复制粘贴错误。 */
  async deleteNcFiles(ids: readonly number[], options: Fa371CallOptions = {}): Promise<Fa371AckDto> {
    const payload = this.buildIdListBody(ids, 'nc_file')
    return this.call<Fa371AckDto>(FA371_ENDPOINTS.ncFile, 'DELETE', payload, options)
  }

  // -------------------------------------------------------------------------
  // 内部：请求封装与包络解包
  // -------------------------------------------------------------------------

  /**
   * 发一个已认证请求，首用时解析认证，中途 401 时**透明地重新登录一次**。
   *
   * 401 的语义（§2.3）：认证失败或 Token 无效。手册**没有**定义 Token 有效期、
   * 刷新机制或登出接口，所以这里唯一合理的策略就是"重登一次再试"，
   * 第二次仍失败就明确报错（而不是无限重试把设备打死）。
   */
  private async call<T = unknown>(
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    body: unknown | undefined,
    options: Fa371CallOptions = {},
    attempt = 0
  ): Promise<T> {
    await this.ensureSession(options)

    const session = this.session
    const strategy = this.strategy
    if (!session || !strategy) {
      throw new AppError(ErrorCodes.AUTH_FAILED, '设备会话不可用')
    }

    const auth = applyAuth(session, strategy)
    const url = buildUrl(this.baseUrl + path, auth.query)
    let requestBody: unknown = body

    // body-credentials 之类的策略要求在每次请求里带上凭据，合并进来。
    if (auth.body) {
      requestBody =
        body && typeof body === 'object' ? { ...(body as object), ...auth.body } : { ...auth.body }
    }

    const response = await this.transport.request({
      method,
      url,
      headers: { ...auth.headers },
      json: requestBody,
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      signal: options.signal,
      throwOnHttpError: false
    })

    deviceLog().debug('FA371 call', {
      method,
      path,
      status: response.status,
      latencyMs: response.latencyMs,
      strategy: strategy.id
    })

    if (isAuthFailure(response.status)) {
      if (attempt === 0) {
        deviceLog().info('FA371 Token 被拒；重新登录一次', { path, status: response.status })
        this.invalidateSession()
        return this.call<T>(path, method, body, options, attempt + 1)
      }
      throw new AppError(ErrorCodes.AUTH_FAILED, `设备拒绝认证 (HTTP ${response.status})`, path)
    }

    if (!response.ok) {
      throw new AppError(
        ErrorCodes.DEVICE_ERROR,
        `设备返回 HTTP ${response.status} (${path})`,
        response.text?.slice(0, 300)
      )
    }

    /**
     * 200 + 网页 ≠ 设备响应。
     *
     * MEASURED on the real FA371 (192.168.110.235, 2026-09): every UNDEFINED path
     * answers `200 OK` with the web UI's `index.html` — the SPA's catch-all route
     * — not a 404. `GET /get_devinfo` is the concrete example: it looks like a
     * perfectly good response to anything that only checks the status code.
     *
     * Two things then go wrong if this is not caught here:
     *   1. `response.json` is `undefined`, and `unwrap` would hand `undefined` to
     *      the caller as a successful result — a read that "works" and returns
     *      nothing, which is far harder to debug than an error;
     *   2. `ret` is absent on such a body, and absence means success on three
     *      documented endpoints (§5.1.15/16/20), so the envelope check cannot
     *      catch it either.
     *
     * This project already learned the same lesson on the download path
     * (`looksLikeWave` rejects the SPA index.html that a wrong URL returns with
     * HTTP 200). Same trap, same answer: refuse the body explicitly.
     */
    const responseBody = response.text
    if (
      response.json === undefined &&
      typeof responseBody === 'string' &&
      looksLikeHtmlPayloadText(responseBody)
    ) {
      throw new AppError(
        ErrorCodes.INVALID_RESPONSE,
        `设备返回的是网页而不是接口响应 (${path})，该路径可能不存在`,
        responseBody.trim().slice(0, 200)
      )
    }

    return this.unwrap<T>(response.json, path)
  }

  /**
   * 解包响应。
   *
   * FA371 的返回字段与 `ret`/`msg` **平级**（规格 §5.1 的所有示例都是这样），
   * 所以这里不"取出 msgBody"，而是校验包络后把整个对象交给 DTO。
   *
   * 成功判定见 `mappers.isFa371Success`：
   *   - `ret` 缺失 → 成功（§5.1.15 / §5.1.16 / §5.1.20 三个接口本就不带 `ret`）；
   *   - `ret === 200` → 成功；
   *   - 其它任何数值（含 `-1`）→ 业务失败，抛 DEVICE_ERROR 并带出 `msg`。
   * §8.2 B3 说其余失败码未知，因此"非 200 即失败"是保守且安全的方向。
   */
  private unwrap<T>(payload: unknown, path: string): T {
    if (payload === null || payload === undefined) return undefined as T

    if (!isFa371Success(payload)) {
      const message = fa371ErrorMessage(payload) ?? '设备返回业务失败'
      const ret = (payload as Record<string, unknown>).ret
      throw new AppError(ErrorCodes.DEVICE_ERROR, `设备返回错误: ${message}`, `${path} ret=${String(ret)}`)
    }

    return payload as T
  }

  /** 三个 DELETE 接口共用的 id 数组请求体构造（§8.3 C24/C29/C30）。 */
  private buildIdListBody(ids: readonly number[], endpoint: string): unknown {
    if (ids.length === 0) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, `${endpoint} 需要至少一个 id`)
    }
    for (const id of ids) {
      if (!Number.isFinite(id) || !Number.isInteger(id)) {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, `${endpoint} 的 id 必须是整数`, String(id))
      }
    }
    return this.idListBody.build(ids)
  }

  /**
   * 逐候选登录 + 验证，返回第一条被设备接受的 Token 携带方式。
   *
   * 与 `AuthStrategyResolver` 的思路一致（探测而不是猜），但**不能复用它**：
   * 它把登录体包成 `msgBody`、把验证端点写死为 `/get_devinfo`，两者都是
   * FA8/AE08 的实测形状；FA371 手册 §2.1 是裸登录体，且没有系统信息接口。
   */
  private async resolveSession(options: Fa371CallOptions): Promise<{
    session: AuthSession
    strategy: AuthStrategy
  }> {
    const attempts: string[] = []
    let lastError: AppError | undefined

    for (const candidate of this.orderCandidates()) {
      const strategy = findStrategy(candidate.id)
      if (!strategy) continue

      try {
        const token = await this.loginWithStrategy(strategy, options)
        if (strategy.carrier.kind !== 'body' && !token) {
          attempts.push(`${candidate.id}: 登录成功但响应里没有可识别的 token 字段`)
          continue
        }

        const session: AuthSession = {
          strategyId: strategy.id,
          createdAt: Date.now(),
          credential: this.credential
        }
        if (token) session.token = token

        const verified = await this.verifySession(session, strategy, options)
        if (verified.ok) {
          deviceLog().info('FA371 认证方式已解析', {
            baseUrl: this.baseUrl,
            strategyId: strategy.id,
            carrier: candidate.description
          })
          return { session, strategy }
        }

        attempts.push(`${candidate.id}: 认证后 ${FA371_VERIFY_PATH} 返回 ${verified.status}`)
      } catch (error) {
        const appError = AppError.from(error)
        lastError = appError
        attempts.push(`${candidate.id}: ${appError.message}`)

        // 网络层失败与携带方式无关：设备不可达时再试其它头只是浪费用户时间。
        if (
          appError.code === ErrorCodes.NETWORK_ERROR ||
          appError.code === ErrorCodes.TIMEOUT ||
          appError.code === ErrorCodes.DEVICE_OFFLINE
        ) {
          break
        }
      }
    }

    deviceLog().warn('FA371 所有认证方式均失败', { baseUrl: this.baseUrl, attempts })

    throw new AppError(
      lastError?.code === ErrorCodes.NETWORK_ERROR || lastError?.code === ErrorCodes.TIMEOUT
        ? lastError.code
        : ErrorCodes.AUTH_FAILED,
      '认证失败：所有 Token 携带方式均被设备拒绝',
      attempts.join(' | ')
    )
  }

  /** 首选（上次成功）的候选排在最前，其余保持 §9.1 的实测优先级。 */
  private orderCandidates(): Fa371AuthCandidate[] {
    if (!this.preferredStrategyId) return [...FA371_AUTH_CANDIDATES]
    const preferred = FA371_AUTH_CANDIDATES.find(
      (candidate) => candidate.id === this.preferredStrategyId
    )
    if (!preferred) return [...FA371_AUTH_CANDIDATES]
    return [
      preferred,
      ...FA371_AUTH_CANDIDATES.filter((candidate) => candidate.id !== preferred.id)
    ]
  }

  /**
   * 用给定策略执行 `POST /login`。
   *
   * 请求体来自 `auth-strategy` 的 `buildLoginBody`（即 `md5(明文 + 'lfxs')`），
   * 外层封装按 `FA371_LOGIN_ENVELOPE_CANDIDATES`（默认手册 §2.1 的裸对象）。
   * 返回提取到的 Token；`body` 型策略不需要 Token。
   */
  private async loginWithStrategy(
    strategy: AuthStrategy,
    options: Fa371CallOptions
  ): Promise<string | undefined> {
    const body = this.loginEnvelope.wrap(strategy.buildLoginBody(this.credential))

    const response = await this.transport.request({
      method: 'POST',
      url: this.baseUrl + FA371_ENDPOINTS.login,
      json: body,
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      signal: options.signal,
      throwOnHttpError: false
    })

    // §8.1 A7：登录失败时的状态码手册未说明（401？200+ret？）。
    // 所以这里不假设 401，只要不是 2xx 就按登录被拒处理。
    if (!response.ok) {
      throw new AppError(
        ErrorCodes.AUTH_FAILED,
        `登录被设备拒绝 (HTTP ${response.status})`,
        response.text?.slice(0, 200)
      )
    }

    return strategy.extractToken(response.json)
  }

  /** 用一次只读请求验证候选携带方式是否真的被接受。 */
  private async verifySession(
    session: AuthSession,
    strategy: AuthStrategy,
    options: Fa371CallOptions
  ): Promise<{ ok: boolean; status: number }> {
    const auth = applyAuth(session, strategy)
    const response = await this.transport.request({
      method: 'GET',
      url: buildUrl(this.baseUrl + FA371_VERIFY_PATH, auth.query),
      headers: auth.headers,
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      signal: options.signal,
      throwOnHttpError: false
    })

    // 2xx 是必要不充分条件：一个对所有未认证请求都回空 200 的固件不能被当成
    // "会话可用"。要求响应至少是一个 JSON 对象（§5.1.16 正常返回 `{detect_status:N}`）。
    const payloadIsObject =
      response.json !== null && typeof response.json === 'object' && !Array.isArray(response.json)
    return { ok: response.ok && payloadIsObject, status: response.status }
  }
}

// ---------------------------------------------------------------------------
// 候选查找（给未定义的字符串时回落到默认值，而不是抛错——配置来自设备记录）
// ---------------------------------------------------------------------------

function findLoginEnvelope(id?: Fa371LoginEnvelopeId): (typeof FA371_LOGIN_ENVELOPE_CANDIDATES)[number] {
  return (
    FA371_LOGIN_ENVELOPE_CANDIDATES.find((candidate) => candidate.id === id) ??
    FA371_LOGIN_ENVELOPE_CANDIDATES.find(
      (candidate) => candidate.id === DEFAULT_FA371_LOGIN_ENVELOPE
    ) ??
    // 候选集非空，兜底只是让类型收窄成立。
    FA371_LOGIN_ENVELOPE_CANDIDATES[0]!
  )
}

function findImagingTargetKey(
  id?: Fa371ImagingTargetKeyId
): (typeof FA371_IMAGING_TARGET_KEY_CANDIDATES)[number] {
  return (
    FA371_IMAGING_TARGET_KEY_CANDIDATES.find((candidate) => candidate.id === id) ??
    FA371_IMAGING_TARGET_KEY_CANDIDATES.find(
      (candidate) => candidate.id === DEFAULT_FA371_IMAGING_TARGET_KEY
    ) ??
    FA371_IMAGING_TARGET_KEY_CANDIDATES[0]!
  )
}

function findDiagnosisKey(
  id?: Fa371StrategyDiagnosisKeyId
): (typeof FA371_STRATEGY_DIAGNOSIS_KEY_CANDIDATES)[number] {
  return (
    FA371_STRATEGY_DIAGNOSIS_KEY_CANDIDATES.find((candidate) => candidate.id === id) ??
    FA371_STRATEGY_DIAGNOSIS_KEY_CANDIDATES.find(
      (candidate) => candidate.id === DEFAULT_FA371_STRATEGY_DIAGNOSIS_KEY
    ) ??
    FA371_STRATEGY_DIAGNOSIS_KEY_CANDIDATES[0]!
  )
}

function findIdListBody(id?: Fa371IdListBodyId): (typeof FA371_ID_LIST_BODY_CANDIDATES)[number] {
  return (
    FA371_ID_LIST_BODY_CANDIDATES.find((candidate) => candidate.id === id) ??
    FA371_ID_LIST_BODY_CANDIDATES.find(
      (candidate) => candidate.id === DEFAULT_FA371_ID_LIST_BODY
    ) ??
    FA371_ID_LIST_BODY_CANDIDATES[0]!
  )
}

function findAlarmConditionUpdateId(
  id?: Fa371AlarmConditionUpdateIdStyleId
): (typeof FA371_ALARM_CONDITION_UPDATE_ID_CANDIDATES)[number] {
  return (
    FA371_ALARM_CONDITION_UPDATE_ID_CANDIDATES.find((candidate) => candidate.id === id) ??
    FA371_ALARM_CONDITION_UPDATE_ID_CANDIDATES.find(
      (candidate) => candidate.id === DEFAULT_FA371_ALARM_CONDITION_UPDATE_ID
    ) ??
    FA371_ALARM_CONDITION_UPDATE_ID_CANDIDATES[0]!
  )
}

function findDetectLogsQueryStyle(
  id?: Fa371DetectLogsQueryStyleId
): (typeof FA371_DETECT_LOGS_QUERY_STYLE_CANDIDATES)[number] {
  return (
    FA371_DETECT_LOGS_QUERY_STYLE_CANDIDATES.find((candidate) => candidate.id === id) ??
    FA371_DETECT_LOGS_QUERY_STYLE_CANDIDATES.find(
      (candidate) => candidate.id === DEFAULT_FA371_DETECT_LOGS_QUERY_STYLE
    ) ??
    FA371_DETECT_LOGS_QUERY_STYLE_CANDIDATES[0]!
  )
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/**
 * 逐段编码路径，保留 `/` 分隔符。
 * 整体 `encodeURIComponent` 会把 `/` 变成 `%2F`，设备就找不到文件了。
 */
function encodePathSegments(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

/**
 * 下载结果是不是一个 HTML 文档。
 *
 * 存在的理由是一个真实踩过的坑：FA8 家族对不存在的路径返回 SPA 的 `index.html`
 * 且 HTTP 200，调用方拿到的是"成功"却完全无法使用的数据。这里宁可误报一次，
 * 也不要把 HTML 当作声场图片存进用户的检测结果目录。
 */
function looksLikeHtmlPayload(bytes: Uint8Array, contentType: string): boolean {
  if (contentType.toLowerCase().includes('text/html')) return true
  return looksLikeHtmlPayloadText(new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 256)))
}

/**
 * Same test, on a body that was already decoded to text.
 *
 * The transport only decodes `text` when the content type is JSON, so a body that
 * reached here as text while `json` is `undefined` is by definition NOT JSON — the
 * question is whether it is a web page (see the guard in `call`).
 */
function looksLikeHtmlPayloadText(text: string): boolean {
  const prefix = text.trimStart().slice(0, 256).toLowerCase()
  return prefix.startsWith('<!doctype html') || prefix.startsWith('<html') || prefix.startsWith('<!doctype')
}
