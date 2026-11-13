/**
 * E2 / 听诊盒子族的 HTTP 客户端 —— **「拉」通道**。
 *
 * 路径与字段全部来自两份手册（见 `@shared/domain/e2.ts` 的文件头），没有一条是猜的。
 * 分工同其它设备客户端：这一层只做**请求与收窄**，解码在域层，落库在上层的同步服务。
 *
 * ---------------------------------------------------------------------------
 * 认证：`POST /login` 拿 token，之后每个请求带 `Authorization: Bearer <token>`
 * ---------------------------------------------------------------------------
 * 手册写明两件事：口令要传 **MD5 之后的 32 位十六进制**；认证失败或 token 失效返回
 * **401**。所以：
 *   - MD5 在**主进程**算（`node:crypto`），明文口令不进任何日志、不进渲染层；
 *   - 401 触发**一次**重新登录再重试（与 FA8 客户端的 `attempt` 参数同一条做法）——
 *     设备重启后旧 token 会失效，而"重启后第一次同步失败一次"是没人愿意排查的现象。
 *
 * ---------------------------------------------------------------------------
 * 一条**没有**做的假设
 * ---------------------------------------------------------------------------
 * 手册没有写 token 的有效期，也没有写刷新接口。所以这里**不缓存过期时间**，
 * 只缓存 token 本身并在 401 时重新登录。任何"多久过期"的常量都会是编的。
 */

import { createHash } from 'node:crypto'
import { AppError, ErrorCodes } from '@shared/errors'
import {
  E2_ENDPOINTS_BY_VARIANT,
  E2_ALARM_LOG_RETENTION,
  E2_AIR_SONAR_AUDIO_NAME,
  e2FilePath,
  detectE2Variant,
  isE2WorkMode,
  parseE2Timestamp,
  type E2Variant,
  type E2WorkMode
} from '@shared/domain/e2'
import type { HttpTransport } from '../http-transport'
import { deviceLog } from '../../logging/logger'

/**
 * 口令摘要的两种写法。
 *
 * **两份手册不一致**：2023 版写 "MD5 encrypted password, 32 characters"（不加盐），
 * Air Sonar V3.2 写 "**lfxs** + MD5, 32-bit"。同一家厂商的 FA371 相机用的也是
 * `md5(password + 'lfxs')`，所以加盐那一版更像"手册终于写全了"，但**不能据此断定**
 * 老固件也吃加盐的。
 *
 * 处理方式不是挑一个，而是**两个都试**（`login()` 里先加盐、401 再试不加盐，并记住哪一次成的）：
 * 这是一处**文档互斥**的地方，猜错的代价是"永远登录不上"，而试两次的代价是一次多余的请求。
 * 真机验过之后应当把没用的那一条删掉 —— 记在 `docs/Ivms4200-UX-REFERENCE.md` §15.28。
 */
export type E2PasswordStyle = 'salted' | 'plain'

/** 厂商盐（与 FA371 同一个）。 */
const E2_PASSWORD_SALT = 'lfxs'

/**
 * SN-16 空气声呐的**端口布局**（2026-09-22 真机实测，192.168.110.234）：
 *   - **8888**：真正的 API 服务 —— `/login` **只在这里**；
 *   - **80**：nginx —— 网页、`/static_file/` 静态文件、以及**部分** GET 接口的反代
 *     （`/system`、`/alarm_log_all`、`/alarm_log` 能通，但 `/login` 回 nginx 的 404 HTML）。
 *
 * 手册（V3.2 第 5 章）通篇只写路径、没写端口，而软件默认填 80 —— 于是登录请求拿到一段
 * HTML 404 页面，表现为 `INVALID_RESPONSE`（"设备返回的数据格式无法识别"）。
 * 所以：登录 404 时回退到 8888 再试；静态文件在 API 端口不可用时回退到 80。
 */
const E2_API_FALLBACK_PORT = 8888

/** 口令 → 设备要的 32 位 MD5 十六进制（小写）。 */
export function e2PasswordDigest(password: string, style: E2PasswordStyle = 'salted'): string {
  const material = style === 'salted' ? `${password}${E2_PASSWORD_SALT}` : password
  return createHash('md5').update(material, 'utf8').digest('hex')
}

export interface E2Credentials {
  username: string
  password: string
}

export interface E2ClientOptions {
  transport: HttpTransport
  /** 形如 `http://192.168.2.190`（**不带**尾斜杠，也不带端口路径）。 */
  baseUrl: string
  credentials: E2Credentials
  timeoutMs?: number
  /**
   * 端口回退对（默认 `{ web: 80, api: 8888 }`，实测依据见 `E2_API_FALLBACK_PORT`）。
   * 存在的意义是**测试**：单测里的假设备监听的是随机端口，没法用 80/8888 复现
   * "登录在 404、换端口才通"的整台设备形状。生产代码不要传。
   */
  portPair?: { web: number; api: number }
}

/** `GET /workmode` 的收窄结果。 */
export interface E2WorkModeView {
  mode?: E2WorkMode
  /** 设备原样给的字符串（认不出时也要留证据，界面照实显示）。 */
  rawMode: string
  samplerate?: number
  audioStreamUrl?: string
  stftStreamUrl?: string
  stftPicHeight?: number
  stftPicWidth?: number
}

/** 一条告警日志（六种模式字段的并集；没有的字段就是设备没给）。 */
export interface E2AlarmLogEntry {
  id?: number
  /** 设备原文（`yyyy-MM-dd_HH-mm-SS`）。 */
  time: string
  /** 解出来的 epoch ms；解不出来就是 `undefined`（不猜）。 */
  timeMs?: number
  alarmReasons?: string
  alarmValue?: number
  savingPath?: string
  audioName?: string
  filesStatus?: number
  /** 该次告警的特征值（键名就是设备给的键名，原样透出）。 */
  values: Record<string, number>
  /**
   * 设备那一行的**原始 JSON**（原样字符串）。
   *
   * 为什么要留着整份：收窄成 `values` 之后，白名单之外的键就没了，而"设备多给了什么"
   * 恰恰是排查时最想知道的事。落库时它就写进 `alarms.device_raw`（见 `e2-sync-service.ts`）。
   */
  raw?: string
}

export interface E2AlarmLogPage {
  logsCount?: number
  logs: E2AlarmLogEntry[]
}

export interface E2AlarmLogQuery {
  startTime?: number
  endTime?: number
  startCol?: number
  colCount?: number
  /** 按告警类型筛：这些键的十六进制值按位或之后作为 `alarm_value`。 */
  alarmBits?: number
}

/** `GET /basic` 的设备基本信息。 */
export interface E2BasicInfo {
  devName?: string
  devType?: string
  devVersion?: string
  upgradeTime?: string
  webVersion?: string
  equipNumber?: string
}

/** `GET /hb_settings` 的心跳设置。 */
export interface E2HeartbeatSettings {
  isNotifyHeartbeat?: number
  notifyInterval?: number
  notifyUrl?: string
}

/** 告警特征值里可能出现的键（手册按模式列出；这里只是**收窄白名单**，不是枚举语义）。 */
const VALUE_KEYS: readonly string[] = [
  'db_value',
  'tde_ratio',
  'fde_ratio',
  'main_frequency',
  'hpss',
  'sc_ratio',
  'oeh_ratio',
  // Air Sonar：声源方向的水平/垂直方位角（手册字段名就是 horizontal/vertical）。
  'horizontal',
  'vertical'
]

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

export class E2Client {
  private readonly transport: HttpTransport
  private readonly credentials: E2Credentials
  private readonly timeoutMs: number
  private readonly portPair: { web: number; api: number }
  private baseUrl: string
  private token?: string
  /** 同一时间的多个请求只发一次登录；并发登录会让设备把前一个 token 作废。 */
  private loginInFlight?: Promise<string>
  /**
   * 这一台是**哪一代**（见 `@shared/domain/e2.ts` 的变体表）。
   *
   * `undefined` = 还没读过 `/system`（或读不懂）。**不默认成 `auscultation`**：
   * 默认一个变体就意味着用错的端点去查日志，而那会表现成"设备没有日志"。
   */
  private variant?: E2Variant
  /** 上一次登录用的是哪种口令摘要（两份手册不一致，见 `e2PasswordDigest`）。 */
  private passwordStyle?: E2PasswordStyle
  /**
   * 静态文件 / 网页所在的基地址 —— 实测与 API **不同端口**（API 8888、静态 80，见
   * `E2_API_FALLBACK_PORT` 的注释）。登录回退到 8888 成功时把原基地址记在这里。
   */
  private webBaseUrl?: string
  /** 静态文件实测成功的那个基地址（记住赢家，下一条文件不再挨个试）。 */
  private staticBaseUrl?: string

  constructor(options: E2ClientOptions) {
    this.transport = options.transport
    this.baseUrl = normaliseE2BaseUrl(options.baseUrl)
    this.credentials = options.credentials
    this.timeoutMs = options.timeoutMs ?? 8_000
    this.portPair = options.portPair ?? { web: 80, api: E2_API_FALLBACK_PORT }
  }

  get currentBaseUrl(): string {
    return this.baseUrl
  }

  /** 已经判定出来的变体（没判定过就是 `undefined`）。 */
  get resolvedVariant(): E2Variant | undefined {
    return this.variant
  }

  /** 上一次登录成功的口令写法（真机验过之后应当只留一种，见文档 §15.28）。 */
  get resolvedPasswordStyle(): E2PasswordStyle | undefined {
    return this.passwordStyle
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = normaliseE2BaseUrl(baseUrl)
    // 地址变了：token、变体与端口布局都可能不再适用（另一台设备），下一次调用重新判定。
    this.token = undefined
    this.variant = undefined
    this.webBaseUrl = undefined
    this.staticBaseUrl = undefined
  }

  invalidateToken(): void {
    this.token = undefined
  }

  /** 当前变体的端点表；还没判定时按 2023 版（唯一"文档写全了端点"的那一代）取。 */
  private get endpoints(): (typeof E2_ENDPOINTS_BY_VARIANT)[E2Variant] {
    return E2_ENDPOINTS_BY_VARIANT[this.variant ?? 'auscultation']
  }

  // -------------------------------------------------------------------------
  // 端点解析：**设备回话说了算**（2026-09-17 真机验证）
  // -------------------------------------------------------------------------

  /**
   * 已解析出来的端点（按用途记住赢家）。
   *
   * 为什么需要它：手册给的两代路径**不是每台设备都成立**。实测一台 V3.4.0 的 SN-16 空气声呐：
   * `/system` 的参数与告警字段都符合"第二代"，但 `/get_device_basic_params`、
   * `/get_all_alarms`、`/get_alarm_logs_conditional`、`/saving_alarm_file` **全都是 404**，
   * 它真正用的是 2023 版那一套路径（`/basic`、`/alarm_log_all`、`/alarm_log`），
   * 而文件是**静态路径** `/static_file/<saving_path><name>`。
   *
   * 所以每个用途都按"手册那条 → 另一条 → 静态文件"依次试，**404 才换下一条**，
   * 成功之后记住它。这与口令摘要那条既有做法是同一个思路（手册有歧义时，设备是权威）。
   */
  private readonly resolvedEndpoints = new Map<string, string>()

  private rememberEndpoint(kind: string, path: string): void {
    if (this.resolvedEndpoints.get(kind) === path) return
    this.resolvedEndpoints.set(kind, path)
    deviceLog().info('听诊盒子族端点已确认', { kind, path, variant: this.variant })
  }

  /** 某个用途已确认的路径（没有就是 `undefined`）。 */
  get resolvedEndpoint(): ReadonlyMap<string, string> {
    return this.resolvedEndpoints
  }

  /**
   * 登录用的候选基地址：当前地址 +（默认/80 端口时）8888 回退。
   *
   * 为什么只猜这两个端口：它们是**真机实测**出来的布局（见 `E2_API_FALLBACK_PORT`），
   * 别的端口不猜 —— 乱猜端口会让"地址填错了"变成"等一串超时"。
   */
  private loginBaseCandidates(): string[] {
    const bases = [this.baseUrl]
    const alternate = alternatePortBaseUrl(this.baseUrl, this.portPair.api, [
      this.portPair.web,
      this.portPair.api
    ])
    if (alternate !== undefined) bases.push(alternate)
    return bases
  }

  /**
   * 静态文件（`/static_file`）的候选基地址：记住的赢家 → 当前 API 地址 → 网页端口。
   *
   * 2026-09-22 实测：API 在 8888 时 `/static_file` 只在 80 的 nginx 上（8888 回 501）。
   */
  private staticFileBases(): string[] {
    const bases = [
      this.staticBaseUrl,
      this.baseUrl,
      this.webBaseUrl ??
        alternatePortBaseUrl(this.baseUrl, this.portPair.web, [this.portPair.web, this.portPair.api])
    ]
    return [...new Set(bases.filter((value): value is string => typeof value === 'string'))]
  }

  /** 一个用途的候选路径（按顺序）：先已确认的，再手册那条，最后另一代那条。 */
  private candidatePaths(kind: 'basic' | 'alarmLogAll' | 'alarmLogConditional'): string[] {
    const both = E2_ENDPOINTS_BY_VARIANT.auscultation
    const sonar = E2_ENDPOINTS_BY_VARIANT.airSonar
    const resolved = this.resolvedEndpoints.get(kind)
    const candidates = [
      resolved,
      this.endpoints[kind],
      this.variant === 'airSonar' ? both[kind] : sonar[kind]
    ]
    return [...new Set(candidates.filter((value): value is string => typeof value === 'string'))]
  }

  /**
   * 文件下载的候选（**只记路径，不记查询串**）。
   *
   * 这里踩过一个坑（写完当天就被单测抓住）：第一版把"成功的那条 URL"整个记住，于是下一条
   * 文件（`2.jpg`）会拿着上一条文件的 `?file_path=…1.jpg` 去下载 —— 设备老老实实回了
   * 200 和 **1.jpg 的字节**，结果是"每一张都下载成功、内容全是第一张"。
   * 路径是每个**端点**的属性，`file_path` 是每个**文件**的属性，两者不能一起记。
   *
   * 候选分两组；查询式接口是两代手册各一条，静态文件是实测到的那一种。
   * 静态文件**可能在另一个端口**（2026-09-22 实测：API 8888、静态 80），所以按
   * `staticFileBases()` 每个基地址各生成一条，URL 是完整的（`authorised()` 认得绝对地址）。
   */
  private fileCandidates(filePath: string): Array<{ key: string; url: string; base?: string }> {
    const both = E2_ENDPOINTS_BY_VARIANT.auscultation.alarmFile
    const sonar = E2_ENDPOINTS_BY_VARIANT.airSonar.alarmFile
    const query = (path: string): string =>
      `${path}?${new URLSearchParams({ file_path: filePath }).toString()}`
    const resolved = this.resolvedEndpoints.get('alarmFile')
    const apiPaths = [
      ...(resolved !== undefined && resolved !== '/static_file' ? [resolved] : []),
      this.endpoints.alarmFile,
      this.variant === 'airSonar' ? both : sonar
    ]
    const candidates = [...new Set(apiPaths)].map((path) => ({ key: path, url: query(path) }))
    // 静态文件那组**不需要 token**（它就是一个静态文件），但多带一个 Authorization 头没有影响。
    const staticCandidates = this.staticFileBases().map((base) => ({
      key: '/static_file',
      url: `${base}/static_file/${filePath}`,
      base
    }))
    const staticFirst = resolved === '/static_file'
    return staticFirst ? [...staticCandidates, ...candidates] : [...candidates, ...staticCandidates]
  }

  /**
   * 读一个 JSON 端点，404/501 时换下一条候选。
   *
   * 为什么 501 也算"没有这条"：2026-09-22 实测一台 SN-16，它对**不实现的端点**回
   * `501 Not Implemented`（空正文），而不是 404 —— 只认 404 的话回退链在第一条就断了。
   *
   * `query` 是查询串（`?a=b`，没有就传空串）：**候选之间只有路径不同**，所以查询串在这里
   * 拼接一次，避免每个候选各拼一遍（那种写法最容易两处不一致）。
   */
  private async callResolved<T>(
    kind: 'basic' | 'alarmLogAll' | 'alarmLogConditional',
    query: string,
    options: CallOptions
  ): Promise<T> {
    const candidates = this.candidatePaths(kind)
    for (const path of candidates) {
      try {
        const result = await this.call<T>(`${path}${query}`, 'GET', undefined, options)
        this.rememberEndpoint(kind, path)
        return result
      } catch (error) {
        // 只有"设备没有这条"才换下一条：400（参数错）、401（认证）都不该被"换个路径再试"掩盖。
        const missing = error instanceof AppError && /HTTP (404|501)/.test(error.message)
        if (!missing) throw error
      }
    }
    throw new AppError(
      ErrorCodes.DEVICE_ERROR,
      `设备上没有这个端点（${candidates.length} 条已知路径都回 404/501）`,
      kind
    )
  }

  // -------------------------------------------------------------------------
  // 认证
  // -------------------------------------------------------------------------

  /**
   * 登录并缓存 token。
   *
   * **口令摘要两种都试**（理由见 `e2PasswordDigest` 的注释）：先加盐（Air Sonar 手册的写法、
   * 也是同厂 FA371 的写法），401 再试不加盐（2023 版手册的写法）。两次都 401 才报认证失败。
   * 一旦某一种成功就记住它，后续重新登录只用那一种。
   *
   * **基地址也有候选**（2026-09-22 真机）：`/login` 只在 8888，而默认填的 80 是 nginx，
   * 它回一段 HTML 的 404。所以 404 时换候选基地址再试；成功就切换 `baseUrl` 并把原地址
   * 记成 `webBaseUrl`（静态文件还要用它）。
   *
   * 401/404 之外的状态码一律按"设备回了意外的东西"处理（`INVALID_RESPONSE`），
   * 不把它伪装成认证失败 —— 两者的排查方向完全不同。
   */
  async login(options: { signal?: AbortSignal } = {}): Promise<string> {
    if (this.loginInFlight) return this.loginInFlight
    const pending = this.loginOnce(options).finally(() => {
      this.loginInFlight = undefined
    })
    this.loginInFlight = pending
    return pending
  }

  private async loginOnce(options: { signal?: AbortSignal } = {}): Promise<string> {
    // 上一次成功的写法优先，但**不是唯一候选**：固件升级/设备恢复后摘要规则可能变，
    // 只试旧写法会把「换了一种正确写法」误报成 AUTH_FAILED。两种都试，成功者记住。
    const styles: E2PasswordStyle[] = this.passwordStyle
      ? [this.passwordStyle, this.passwordStyle === 'salted' ? 'plain' : 'salted']
      : ['salted', 'plain']
    const bases = this.loginBaseCandidates()

    let lastStatus = 0
    for (const base of bases) {
      let tryNextBase = false
      for (const style of styles) {
        const response = await this.transport.request({
          method: 'POST',
          url: `${base}${E2_ENDPOINTS_BY_VARIANT.auscultation.login}`,
          json: {
            username: this.credentials.username,
            password: e2PasswordDigest(this.credentials.password, style)
          },
          timeoutMs: this.timeoutMs,
          throwOnHttpError: false,
          ...(options.signal ? { signal: options.signal } : {})
        })
        lastStatus = response.status

        if (response.status === 401) continue

        // 404 = 这个端口上**没有登录服务**（nginx 的 HTML 错误页），换下一个候选基地址。
        if (response.status === 404 && bases.length > 1) {
          tryNextBase = true
          break
        }

        if (!response.ok) {
          throw new AppError(
            ErrorCodes.INVALID_RESPONSE,
            `登录返回意外状态 HTTP ${response.status}`,
            'login'
          )
        }

        const token = asString((response.json as Record<string, unknown> | undefined)?.token)
        if (token === undefined) {
          throw new AppError(ErrorCodes.INVALID_RESPONSE, '登录响应里没有 token', 'login')
        }
        if (base !== this.baseUrl) {
          deviceLog().info('听诊盒子登录在回退端口成功，切换 API 基地址', {
            from: this.baseUrl,
            to: base
          })
          this.webBaseUrl = this.baseUrl
          this.baseUrl = base
        }
        if (this.passwordStyle !== style) {
          deviceLog().info('听诊盒子登录成功', { baseUrl: this.baseUrl, passwordStyle: style })
        }
        this.passwordStyle = style
        this.token = token
        return token
      }
      if (!tryNextBase) {
        // 这个基地址上登录服务**在**、只是拒绝口令：换端口没有意义，如实报认证失败。
        throw new AppError(
          ErrorCodes.AUTH_FAILED,
          `设备拒绝登录（用户名或口令不正确，HTTP ${lastStatus}）`,
          'login'
        )
      }
    }

    throw new AppError(
      ErrorCodes.DEVICE_ERROR,
      `设备上没有登录接口（${bases.length} 个候选地址的 /login 都回 HTTP 404）`,
      'login'
    )
  }

  // -------------------------------------------------------------------------
  // 读：工作模式与参数
  // -------------------------------------------------------------------------

  /**
   * 读工作模式（`GET /workmode`）—— **只有 2023 版听诊盒子有这个端点**。
   *
   * Air Sonar V3.2 没有工作模式这个概念（它是单一用途的声学成像设备），它的 `/system` 里
   * 连 `work_mode` 字段都没有。所以这里**不假装**：变体已判定为 Air Sonar 时直接返回一个空视图
   * （`rawMode: ''`），上层据此显示"这一代没有工作模式"，而不是发一个必然 404 的请求
   * 让设备看起来像离线。
   */
  async getWorkMode(options: CallOptions = {}): Promise<E2WorkModeView> {
    if (this.variant === 'airSonar') return { rawMode: '' }
    const raw = await this.call<Record<string, unknown>>('/workmode', 'GET', undefined, options)
    const rawMode = typeof raw.work_mode === 'string' ? raw.work_mode : ''
    const view: E2WorkModeView = { rawMode }
    // 认不出的模式**保留原文**：设备可能出了第四种模式，界面要能看见它而不是显示空白。
    if (isE2WorkMode(rawMode)) view.mode = rawMode
    const samplerate = asNumber(raw.samplerate)
    if (samplerate !== undefined) view.samplerate = samplerate
    const audio = asString(raw.audio_stream_url)
    if (audio !== undefined) view.audioStreamUrl = audio
    const stft = asString(raw.stft_stream_url)
    if (stft !== undefined) view.stftStreamUrl = stft
    const height = asNumber(raw.stft_pic_height)
    if (height !== undefined) view.stftPicHeight = height
    const width = asNumber(raw.stft_pic_width)
    if (width !== undefined) view.stftPicWidth = width
    return view
  }

  /**
   * 读系统参数（`GET /system`），**并顺手判定变体**。
   *
   * 返回**设备原样给的键值对**（数值键收窄成 number、其余原样）：两代的参数集合不同，
   * 而"设备多给了什么 / 少给了什么"本身就是有用的信息 —— 按固定形状裁剪会把它丢掉。
   *
   * 判定放在这里而不是单独一次调用：`/system` 是两代**都有**的那个端点，而且它的内容就是
   * 判据（见 `detectE2Variant()`）。多打一次请求只为了判型号是浪费。
   */
  /**
   * SN-16 实时音频 WebSocket 的连接参数。
   *
   * 实测（192.168.110.234）：`/audio_stream` 在 **80 端口的 web 服务**上，
   * 10 Hz 推 4096 字节、单声道 16-bit 小端 PCM；handshake 的 token 用 query
   * 参数也能通过（与 `WebSocketStream` 的浏览器兼容写法一致）。
   */
  async audioStreamDescriptor(options: CallOptions = {}): Promise<{
    wsBaseUrl: string
    token: string
    sampleRate: number
  }> {
    await this.login(options)
    const source = this.webBaseUrl ?? this.baseUrl
    return {
      wsBaseUrl: source.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:'),
      token: this.token ?? '',
      sampleRate: 20_000
    }
  }
  async getSystem(options: CallOptions = {}): Promise<Record<string, unknown>> {
    const raw = await this.call<Record<string, unknown>>('/system', 'GET', undefined, options)
    const detected = detectE2Variant(raw)
    if (detected !== undefined && detected !== this.variant) {
      deviceLog().info('听诊盒子族变体已判定', {
        variant: detected,
        passwordStyle: this.passwordStyle
      })
      this.variant = detected
    }
    return raw
  }

  /**
   * 确保变体已知：没判过就读一次 `/system`（幂等）。
   *
   * **同步之前必须调它**。理由很具体：日志端点与文件下载路径都是按变体取的，而变体只在读过
   * `/system` 之后才知道 —— 不先调这一步，Air Sonar 会被当成 2023 版去查 `/alarm_log_all`，
   * 那台设备回 404，而"设备没有日志"看起来就是一个结论。
   */
  async ensureVariant(options: CallOptions = {}): Promise<E2Variant | undefined> {
    if (this.variant !== undefined) return this.variant
    try {
      await this.getSystem(options)
    } catch {
      // 读不到就保持 `undefined`（按文档最全的那一代取端点，并在上层如实报出来）。
    }
    return this.variant
  }

  /**
   * 写系统参数（`PUT /system`）。
   *
   * 手册的写示例是**整份参数一起发**（不是部分更新），所以调用方负责先读、改、再整体写回
   * （与 FA8 的读写习惯一致：那边也是 read-modify-write）。
   */
  async putSystem(
    params: Record<string, unknown>,
    options: CallOptions = {}
  ): Promise<void> {
    await this.call('/system', 'PUT', params, { ...options, allowEmptyResponse: true })
  }

  /**
   * 与球机（NVT）对时：`PUT /time_sync_with_nvt`（SN-16 手册列了这个端点）。
   *
   * **手册没有写这个端点的请求体**，所以这里发一个空对象，并把设备的原话交回上层
   * （界面照实说"请求被接受了，但手册未说明请求体，效果无法在软件侧核验"）。
   *
   * 为什么不走 `call()`：它要求回话是一个 JSON 对象，而一个"只回 200、没有回话"的端点
   * 完全合理（对时就是这种动作）。这里只看 HTTP 状态，把正文原样带回去。
   */
  async timeSyncWithNvt(
    options: CallOptions = {}
  ): Promise<{ status: number; text: string }> {
    const response = await this.authorised('/time_sync_with_nvt', 'PUT', {}, options)
    if (response.status === 401) {
      throw new AppError(ErrorCodes.AUTH_FAILED, '设备拒绝认证（token 无效）', '/time_sync_with_nvt')
    }
    if (!response.ok) {
      throw new AppError(
        ErrorCodes.DEVICE_ERROR,
        `设备返回 HTTP ${response.status}`,
        '/time_sync_with_nvt'
      )
    }
    const text =
      response.text ?? (response.json === undefined ? '' : JSON.stringify(response.json))
    return { status: response.status, text: text.slice(0, 200) }
  }

  // -------------------------------------------------------------------------
  // 读：告警日志
  // -------------------------------------------------------------------------

  /**
   * 分页取全部日志。
   *
   * 路径**按变体**取：2023 版是 `GET /alarm_log_all`，手册给第二代写的是 `GET /get_all_alarms`
   * （字段名与语义一致，只有路径换了）。所以这里必须先判定变体 —— 这也是为什么
   * `getSystem()` 会被上层先调一次。
   *
   * **但变体不足以保证路径对**（2026-09-17 真机）：一台 V3.4.0 的 SN-16 空气声呐，参数与
   * 告警字段都是第二代那一套，`/get_all_alarms` 却是 404，它用的是 `/alarm_log_all`。
   * 所以这里走 `callResolved()`：404 就换另一代那条，并把赢家记住。
   *
   * 手册的默认值有一处**自相矛盾**：2023 版 `col_count` 的说明写着 "default value is 1"，
   * 而参数示例那一栏写的是 2。所以这里**总是显式传** `start_col` 与 `col_count`，
   * 不去依赖任何默认值 —— 依赖一个自相矛盾的默认值会让"只回一条"看起来像设备没数据。
   */
  async listAlarmLogs(
    query: { startCol?: number; colCount?: number } = {},
    options: CallOptions = {}
  ): Promise<E2AlarmLogPage> {
    const params = new URLSearchParams()
    params.set('start_col', String(Math.max(1, Math.trunc(query.startCol ?? 1))))
    params.set('col_count', String(Math.max(1, Math.trunc(query.colCount ?? 100))))
    return this.readLogPage('alarmLogAll', `?${params.toString()}`, options)
  }

  /**
   * 按条件查日志：时间区间（+ 2023 版还支持按告警类型位或筛）。
   *
   * 两代的**查询参数不同**：2023 版有 `alarm_value`（按告警类型筛），手册给第二代写的
   * `get_alarm_logs_conditional` **只有** `start_time` / `end_time` / `start_col` / `col_count`
   * —— 所以当变体是第二代而调用方给了 `alarmBits` 时，这里**不静默丢掉**那个条件，
   * 而是照发（设备不认识就会忽略或回 400，两种都比"我们悄悄丢掉"好）。
   * 路径同样有 404 回退（理由见 `listAlarmLogs()`）。
   */
  async queryAlarmLogs(
    query: E2AlarmLogQuery = {},
    options: CallOptions = {}
  ): Promise<E2AlarmLogPage> {
    const params = new URLSearchParams()
    params.set('start_time', String(Math.max(0, Math.trunc(query.startTime ?? 0))))
    // 手册的默认上界就是 2000000000（秒），照抄；不自己挑一个"看起来更合理"的数。
    params.set('end_time', String(Math.max(0, Math.trunc(query.endTime ?? 2_000_000_000))))
    params.set('start_col', String(Math.max(1, Math.trunc(query.startCol ?? 1))))
    params.set('col_count', String(Math.max(1, Math.trunc(query.colCount ?? 100))))
    if (query.alarmBits !== undefined && query.alarmBits !== 0) {
      params.set('alarm_value', String(Math.trunc(query.alarmBits)))
    }
    return this.readLogPage('alarmLogConditional', `?${params.toString()}`, options)
  }

  /**
   * 两个日志接口的返回结构相同，收窄也共用一处。
   *
   * 两代**字段有交集但也有差异**：`id`/`time`/`db_value`/`tde_ratio`/`fde_ratio`/`saving_path`/
   * `files_status`/`logs_count` 都有；2023 版多 `alarm_value`（位图）与 `alarm_reasons`（文本），
   * Air Sonar 多 `horizontal`/`vertical`（声源方位角）且**没有**文件名（录音固定叫 `alarm.wav`）。
   * 这里按"有就收"处理，落库端按变体解释 —— 不认识一个键就丢掉才是错的。
   */
  private async readLogPage(
    kind: 'alarmLogAll' | 'alarmLogConditional',
    query: string,
    options: CallOptions
  ): Promise<E2AlarmLogPage> {
    const raw = await this.callResolved<Record<string, unknown>>(kind, query, options)
    const logsRaw = Array.isArray(raw.logs) ? raw.logs : []
    const logs: E2AlarmLogEntry[] = []
    for (const item of logsRaw) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      const time = typeof record.time === 'string' ? record.time : ''
      const entry: E2AlarmLogEntry = { time, values: {} }
      // 整份原文留着：白名单之外的键不该在落库时消失。
      try {
        entry.raw = JSON.stringify(record)
      } catch {
        // 循环引用之类：留不下就不留（`raw` 是可选的，落库时会退回收窄后的视图）。
      }
      /**
       * 时间另解一份：解不出来就**只有原文**（`timeMs` 缺席）。
       *
       * 界面据此把"设备时间没法解析"和"设备时间正常"分开显示 —— 拿 0 或"现在"兜底会让
       * 一条解不出来的告警排到时间轴两端，看起来像设备时钟坏了。
       */
      const parsed = parseE2Timestamp(time)
      if (parsed !== undefined) entry.timeMs = parsed.ms
      const id = asNumber(record.id)
      if (id !== undefined) entry.id = Math.trunc(id)
      const reasons = asString(record.alarm_reasons)
      if (reasons !== undefined) entry.alarmReasons = reasons
      const alarmValue = asNumber(record.alarm_value)
      if (alarmValue !== undefined) entry.alarmValue = Math.trunc(alarmValue)
      const savingPath = asString(record.saving_path)
      if (savingPath !== undefined) entry.savingPath = savingPath
      /**
       * 录音文件名：2023 版由设备给（`audio_name`），Air Sonar **固定 `alarm.wav`**
       * （手册写明了，接口里也没有这个名字的字段）。上层据此拼 `file_path`。
       */
      const audioName =
        asString(record.audio_name) ??
        (this.variant === 'airSonar' ? E2_AIR_SONAR_AUDIO_NAME : undefined)
      if (audioName !== undefined) entry.audioName = audioName
      const filesStatus = asNumber(record.files_status)
      if (filesStatus !== undefined) entry.filesStatus = Math.trunc(filesStatus)
      for (const key of VALUE_KEYS) {
        const value = asNumber(record[key])
        if (value !== undefined) entry.values[key] = value
      }
      logs.push(entry)
    }

    const logsCount = asNumber(raw.logs_count)
    return logsCount === undefined ? { logs } : { logsCount: Math.trunc(logsCount), logs }
  }

  /**
   * 设备保留多少条告警（手册写明 5000）。
   *
   * 放在客户端上是因为界面要能解释"为什么最早的告警文件没了" —— 那个数字来自手册，
   * 不是从设备读的，所以它是个常量而不是一个属性。
   */
  get alarmLogRetention(): number {
    return E2_ALARM_LOG_RETENTION
  }

  // -------------------------------------------------------------------------
  // 下载：文件（音频 / 时频谱图）
  // -------------------------------------------------------------------------

  /**
   * 下载一个告警文件。
   *
   * 路径**按变体**取：2023 版 `GET /alarm_files`，Air Sonar V3.2 `GET /saving_alarm_file`。
   * `file_path` **必须**带上 `saving_path`（两份手册都明确要求）。404 就是"文件已被保留策略
   * 清掉" —— 那是一种**预期状态**（`files_status` 会同步变成 0），所以抛一个专门的消息，
   * 让界面能说清"记录在、文件没了"，而不是笼统的"下载失败"。
   */
  async downloadAlarmFile(
    input: { savingPath: string; fileName: string; maxBytes?: number },
    options: CallOptions = {}
  ): Promise<Uint8Array> {
    const filePath = e2FilePath(input.savingPath, input.fileName)
    if (filePath === undefined) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '缺少告警文件路径或文件名')
    }
    /*
     * 候选路径，**设备回话说了算**（2026-09-17 / 2026-09-22 两次真机验证）：
     *   1. 这一代手册的 `GET /saving_alarm_file?file_path=`；
     *   2. 另一代的 `GET /alarm_files?file_path=`；
     *   3. **静态文件** `GET /static_file/<file_path>` —— 实测两台 SN-16 都是这个；
     *      而且它可能在**另一个端口**（API 8888、静态 80），每个候选基地址都会试到。
     * 静态路径那条**不需要 token**（它就是一个静态文件），但多带一个 Authorization 头
     * 对静态服务没有影响。
     */
    const candidates = this.fileCandidates(filePath)
    let lastStatus = 0
    for (const candidate of candidates) {
      const response = await this.authorised(candidate.url, 'GET', undefined, {
        ...options,
        binary: true,
        ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {})
      })
      lastStatus = response.status
      // 404/501 都是"这条路径在这台设备上不存在"，换下一条（501 的实测依据见 `callResolved()`）。
      if (response.status === 404 || response.status === 501) continue
      if (!response.ok) {
        throw new AppError(
          ErrorCodes.DEVICE_ERROR,
          `下载告警文件失败 (HTTP ${response.status})`,
          filePath
        )
      }
      const bytes = response.bytes
      if (bytes === undefined || bytes.byteLength === 0) {
        throw new AppError(ErrorCodes.INVALID_RESPONSE, '设备返回了空文件', filePath)
      }
      // 记住这一次成功的那条**路径**（不是带 file_path 的整条 URL）：同一台设备上后面的
      // 文件不再挨个试，但每条文件仍然用自己的 file_path。
      this.rememberEndpoint('alarmFile', candidate.key)
      // 静态文件还要记住**成功的基地址**：它与 API 可能不同端口（见 `staticFileBases()`）。
      if (candidate.key === '/static_file' && candidate.base !== undefined) {
        this.staticBaseUrl = candidate.base
      }
      return bytes
    }

    throw new AppError(
      ErrorCodes.NOT_IMPLEMENTED,
      `设备上没有这个告警文件（可能已被 5000 条保留策略清掉；所有已知下载路径都回 404/501，最后一条 HTTP ${lastStatus}）：${filePath}`,
      filePath
    )
  }

  // -------------------------------------------------------------------------
  // 其它（设备信息 / 心跳设置 / 改名 / 重启）
  // -------------------------------------------------------------------------

  async getBasic(options: CallOptions = {}): Promise<E2BasicInfo> {
    /*
     * 路径按变体，**404 就换另一代那条**（见 `callResolved()` 的注释）：
     * 手册给第二代写的是 `/get_device_basic_params`，而实测的一台 V3.4.0 SN-16 用的是 `/basic`。
     */
    const raw = await this.callResolved<Record<string, unknown>>('basic', '', options)
    const info: E2BasicInfo = {}
    const name = asString(raw.dev_name)
    if (name !== undefined) info.devName = name
    const type = asString(raw.dev_type)
    if (type !== undefined) info.devType = type
    const version = asString(raw.dev_version)
    if (version !== undefined) info.devVersion = version
    const upgrade = asString(raw.upgrade_time)
    if (upgrade !== undefined) info.upgradeTime = upgrade
    const web = asString(raw.web_version)
    if (web !== undefined) info.webVersion = web
    const equip = asString(raw.equip_number)
    if (equip !== undefined) info.equipNumber = equip
    return info
  }

  /** 改名（`PUT /basic`，两代都是这个路径，手册只允许 `dev_name` 一个字段）。 */
  async setDeviceName(name: string, options: CallOptions = {}): Promise<void> {
    await this.call('/basic', 'PUT', { dev_name: name }, options)
  }

  async getHeartbeatSettings(options: CallOptions = {}): Promise<E2HeartbeatSettings> {
    const raw = await this.call<Record<string, unknown>>(
      '/hb_settings',
      'GET',
      undefined,
      options
    )
    const settings: E2HeartbeatSettings = {}
    const enabled = asNumber(raw.is_notify_heartbeat)
    if (enabled !== undefined) settings.isNotifyHeartbeat = Math.trunc(enabled)
    const interval = asNumber(raw.notify_interval)
    if (interval !== undefined) settings.notifyInterval = Math.trunc(interval)
    const url = asString(raw.notify_url)
    if (url !== undefined) settings.notifyUrl = url
    return settings
  }

  /**
   * 写心跳设置（`PUT /hb_settings`）。
   *
   * **只发调用方点名的字段**：手册的写示例是三个字段一起给，但"把 `notify_url` 改成我们的
   * 地址"不该顺手把设备原来的 `notify_interval` 覆盖成我们猜的默认值。
   */
  async putHeartbeatSettings(
    patch: E2HeartbeatSettings,
    options: CallOptions = {}
  ): Promise<void> {
    const body: Record<string, unknown> = {}
    if (patch.isNotifyHeartbeat !== undefined) body.is_notify_heartbeat = patch.isNotifyHeartbeat
    if (patch.notifyInterval !== undefined) body.notify_interval = patch.notifyInterval
    if (patch.notifyUrl !== undefined) body.notify_url = patch.notifyUrl
    if (Object.keys(body).length === 0) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '心跳设置至少要给一个字段')
    }
    await this.call('/hb_settings', 'PUT', body, { ...options, allowEmptyResponse: true })
  }

  async reboot(options: CallOptions = {}): Promise<void> {
    await this.call('/reboot', 'PUT', undefined, { ...options, allowEmptyResponse: true })
  }

  // -------------------------------------------------------------------------
  // 请求管线
  // -------------------------------------------------------------------------

  /**
   * 带 token 的请求；401 时**重新登录一次**再重试。
   *
   * 只重试一次：第二次还 401 就是口令真的不对（或设备在踢我们），再试下去只会把
   * 设备锁上，而错误信息还是那一条。
   */
  private async authorised(
    path: string,
    method: 'GET' | 'POST' | 'PUT',
    body: unknown,
    options: CallOptions,
    attempt = 0
  ): Promise<Awaited<ReturnType<HttpTransport['request']>>> {
    if (this.token === undefined) await this.login(options)

    const response = await this.transport.request({
      method,
      // 绝对地址原样用（静态文件可能在另一个端口，见 `fileCandidates()`）；相对路径拼当前基地址。
      url: /^https?:\/\//i.test(path) ? path : `${this.baseUrl}${path}`,
      headers: { Authorization: `Bearer ${this.token ?? ''}` },
      ...(body === undefined ? {} : { json: body }),
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      throwOnHttpError: false,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.binary === true ? { binary: true } : {}),
      ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {})
    })

    if (response.status === 401 && attempt === 0) {
      deviceLog().warn('听诊盒子 token 失效，重新登录后重试一次', { path })
      this.token = undefined
      await this.login(options)
      return this.authorised(path, method, body, options, attempt + 1)
    }
    return response
  }

  /** 请求 + JSON 收窄。日志接口与参数接口都走它。 */
  private async call<T>(
    path: string,
    method: 'GET' | 'POST' | 'PUT',
    body: unknown,
    options: CallOptions
  ): Promise<T> {
    const response = await this.authorised(path, method, body, options)
    if (response.status === 401) {
      throw new AppError(ErrorCodes.AUTH_FAILED, '设备拒绝认证（token 无效）', path)
    }
    if (response.status === 400) {
      // 手册对日志接口写明：400 = 参数错误。这是**我们**发错了，不是设备坏了。
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '设备认为请求参数不合法 (HTTP 400)', path)
    }
    if (!response.ok) {
      throw new AppError(
        ErrorCodes.DEVICE_ERROR,
        `设备返回 HTTP ${response.status}`,
        path
      )
    }
    const json = response.json
    if (json === undefined || json === null) {
      if (options.allowEmptyResponse === true) return undefined as T
      throw new AppError(ErrorCodes.INVALID_RESPONSE, '设备没有返回 JSON', path)
    }
    if (typeof json !== 'object' || Array.isArray(json)) {
      throw new AppError(ErrorCodes.INVALID_RESPONSE, '设备返回的不是 JSON 对象', path)
    }
    return json as T
  }
}

interface CallOptions {
  timeoutMs?: number
  signal?: AbortSignal
  binary?: boolean
  maxBytes?: number
  /** 写端点可能只回 200、不回 JSON；此时返回 undefined 而不是 INVALID_RESPONSE。 */
  allowEmptyResponse?: boolean
}

/**
 * 规整基地址：接受 `192.168.2.190`、`http://192.168.2.190/`、
 * `http://192.168.2.190:8080`，统一成**没有尾斜杠**的形式。
 */
export function normaliseE2BaseUrl(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '') throw new AppError(ErrorCodes.VALIDATION_ERROR, '设备地址不能为空')
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  try {
    const url = new URL(withScheme)
    return `${url.protocol}//${url.host}`
  } catch {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `设备地址格式不正确: ${input}`)
  }
}

/**
 * 同一台主机**换端口**的基地址。
 *
 * 只在 `http:` 下、且当前端口属于已知端口对时才换算（https 的端口语义不同；
 * 用户显式填的其它端口也不替它猜 —— 那会把"地址错了"变成"等一串超时"）。
 * 目标是 80 时返回**无端口**形式。
 */
function alternatePortBaseUrl(
  baseUrl: string,
  targetPort: number,
  knownPorts: readonly number[]
): string | undefined {
  try {
    const url = new URL(baseUrl)
    if (url.protocol !== 'http:') return undefined
    const current = url.port === '' ? 80 : Number(url.port)
    if (current === targetPort) return undefined
    if (!knownPorts.includes(current)) return undefined
    url.port = targetPort === 80 ? '' : String(targetPort)
    return url.origin
  } catch {
    return undefined
  }
}
