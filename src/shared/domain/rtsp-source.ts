/**
 * 手填的 RTSP 源（业主 2026-09-19 第 3 条：「② 能手填一个 RTSP 地址给第三方相机」）。
 *
 * ---------------------------------------------------------------------------
 * 这是第 10 批第 2 条「支持 RTSP 主动取流」那半句的**读法确认**
 * ---------------------------------------------------------------------------
 * 业主的原话把那一半钉死为「给**第三方相机**手填一个地址」，而不是"无条件主动去拉本应用
 * 管理的设备"（后者本来就走 `GET /system/video` 那条既有的路）。所以这一层管的是
 * **一个我们完全不认识的地址**：
 *   · 本机没有关于它的任何事实 —— 厂商、编码、通道、有没有声音，全都只能等 ffmpeg 连上
 *     去之后才知道；
 *   · 手册**没有**"第三方 RTSP 接入"这一节，所以下面的形状与限制是**我们定的**；
 *   · 它必须与"已登记设备"分开：那条路有凭据库、有 `rtsp_enabled` 这类设备事实可以问，
 *     这条路只有一串字符串。
 *
 * ---------------------------------------------------------------------------
 * 为什么在这里校验，而不是只让 ffmpeg 去失败
 * ---------------------------------------------------------------------------
 * 一个拼错的地址在 ffmpeg 那边要等到超时（几秒到十几秒）才变成一句
 * `Invalid data found when processing input`，而那句话不会告诉操作员"你把 `http://` 写成了
 * 前缀"或者"地址里有一个空格"。能在**输入的那一刻**说清楚的事就不该留给超时。
 * 反过来，**能连上但连不通**（端口不通、路径不对、要认证）仍然只能由 ffmpeg 回答 ——
 * 所以这里只做形状判断，不假装能判断可达性。
 */

/**
 * 手填源在墙上的 id 前缀。
 *
 * 为什么要有前缀：墙的槽位数组（`CameraWallModel.slots`）历史上只装**设备 id**，
 * 而"这一格到底是什么"必须能从槽位本身看出来（`buildCameraCells()` 只拿到槽位）。
 * 前缀让"这条槽位指向一个手填源"成为一个**纯字符串判断**，不需要把设备表也传进去。
 */
export const MANUAL_RTSP_PREFIX = 'rtsp:'

/** 一条手填源。 */
export interface ManualRtspSource {
  /** `rtsp:<32 位小写十六进制>`。 */
  id: string
  /** 界面上显示的名字（用户可改；默认取地址里的主机名）。 */
  name: string
  /**
   * 原样的地址（**可能含口令**）。
   *
   * 它只活在内存里：手填源与画面格分配一样**不写盘**（`stores/liveWall.ts` 的文件头写了
   * 为什么格子分配不持久化，同一条理由在这里更硬 —— 一个带口令的地址落进 localStorage
   * 就是一份明文凭据，而设备凭据走的是操作系统加密的凭据库）。
   */
  url: string
}

/** 一次最多几条手填源（防止 localStorage/内存里的列表无上限地长）。 */
export const MAX_MANUAL_RTSP_SOURCES = 8

/** 地址长度上限（超过这个长度的地址只可能是粘错了别的东西）。 */
export const MANUAL_RTSP_MAX_LENGTH = 512

/** 名字长度上限。 */
export const MANUAL_RTSP_NAME_MAX_LENGTH = 40

const MANUAL_ID_PATTERN = /^rtsp:[0-9a-f]{32}$/

export function isManualRtspId(value: unknown): value is string {
  return typeof value === 'string' && MANUAL_ID_PATTERN.test(value)
}

/**
 * 生成一条手填源的 id。
 *
 * 随机性从外面传进来（与设备推流秘钥同一套做法）：这个模块同时被渲染层编译，
 * `node:crypto` 在渲染进程里不存在。渲染层传 `crypto.getRandomValues()`。
 */
export function manualRtspIdFromBytes(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return `${MANUAL_RTSP_PREFIX}${hex}`
}

/** 手填源 id 需要多少个随机字节（16 字节 ⇒ 32 位十六进制，与推流秘钥同形）。 */
export const MANUAL_RTSP_ID_BYTES = 16

// ---------------------------------------------------------------------------
// 地址
// ---------------------------------------------------------------------------

/**
 * 把（可能带口令的）RTSP 地址里的口令打成 `***`。
 *
 * 判据是 authority 里**最后一个** `@` 之前的第一个 `:`：口令本身可能含 `@`（`p@ss`），
 * 也可能含 `:`；按最后一个 `@` 切分再按第一个 `:` 切分，是唯一不会切错的两步。
 * 与 `rtsp-stream.ts` 里那份**是同一个实现**（本模块是唯一定义处，那边重新导出）。
 */
export function maskRtspUrl(url: string): string {
  const parts = /^(rtsp[s]?:\/\/)([^/]*)([\s\S]*)$/i.exec(url)
  if (!parts) return url
  const scheme = parts[1] ?? ''
  const authority = parts[2] ?? ''
  const rest = parts[3] ?? ''
  const at = authority.lastIndexOf('@')
  if (at < 0) return url
  const userinfo = authority.slice(0, at)
  const host = authority.slice(at + 1)
  const colon = userinfo.indexOf(':')
  if (colon < 0) return url
  return `${scheme}${userinfo.slice(0, colon)}:***@${host}${rest}`
}

export type ManualRtspUrlIssue =
  | 'empty'
  | 'too-long'
  | 'bad-scheme'
  | 'missing-host'
  | 'whitespace'
  | 'control-character'
  | 'bad-port'

export interface ManualRtspUrlResult {
  ok: boolean
  /** 规范化之后的地址（去掉首尾空白）。`ok === false` 时是原样的输入。 */
  url: string
  /** 第一个问题；`ok === true` 时是空串。 */
  issue: ManualRtspUrlIssue | ''
}

/**
 * 校验一条手填地址。
 *
 * 只判**形状**（scheme / 主机 / 端口 / 有没有空白与控制字符），不判可达性 ——
 * 后者只有 ffmpeg 连一次才知道，假装能判会让操作员以为"校验通过 = 一定能播"。
 *
 * 只接受 `rtsp://` 与 `rtsps://`：这条路的名字就叫 RTSP，而放 `http://` 进来只会变成
 * 一句 ffmpeg 的 `Invalid data found`（那是"我们没拦住"，不是"设备有问题"）。
 */
export function parseManualRtspUrl(raw: unknown): ManualRtspUrlResult {
  if (typeof raw !== 'string') return { ok: false, url: '', issue: 'empty' }
  const url = raw.trim()
  if (url === '') return { ok: false, url, issue: 'empty' }
  if (url.length > MANUAL_RTSP_MAX_LENGTH) return { ok: false, url, issue: 'too-long' }
  // 控制字符（含换行/制表）与空白：地址里出现它们一定是粘贴带进来的，而不是地址的一部分。
  if (/[\u0000-\u001f\u007f]/.test(url)) return { ok: false, url, issue: 'control-character' }
  if (/\s/.test(url)) return { ok: false, url, issue: 'whitespace' }

  const scheme = /^(rtsp|rtsps):\/\//i.exec(url)
  if (!scheme) return { ok: false, url, issue: 'bad-scheme' }

  const authority = url.slice(scheme[0].length).split('/')[0] ?? ''
  const host = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority
  if (host === '') return { ok: false, url, issue: 'missing-host' }

  const colon = host.lastIndexOf(':')
  if (colon >= 0) {
    const port = host.slice(colon + 1)
    if (port === '' || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      return { ok: false, url, issue: 'bad-port' }
    }
  }
  return { ok: true, url, issue: '' }
}

/**
 * 默认名字：地址里的主机名（含端口）。
 *
 * 为什么不用"手填 1 / 手填 2"：屏幕上同时有好几格时，"哪一格是哪台"只能靠名字，
 * 而主机名（`192.168.1.64:554`）是现场唯一能对上号的东西。主机名取不出来时才回落
 * 到一个中性的「RTSP」。
 */
export function defaultManualRtspName(url: string): string {
  const parsed = parseManualRtspUrl(url)
  if (!parsed.ok) return 'RTSP'
  const scheme = /^(rtsp|rtsps):\/\//i.exec(parsed.url)
  const authority = parsed.url.slice(scheme ? scheme[0].length : 0).split('/')[0] ?? ''
  const host = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority
  return host.slice(0, MANUAL_RTSP_NAME_MAX_LENGTH) || 'RTSP'
}

/**
 * 规范化一条手填源（来路不明 —— 单测、旧状态、手工改坏的对象）。
 *
 * 名字为空时用地址里的主机名，地址不合法就**整条丢掉**（`undefined`）：一条连地址都不合法的
 * 手填源放到墙上只会得到一格永远报错的画面，而它在列表里还占着一个"可用"的位置。
 */
export function normaliseManualRtspSource(input: unknown): ManualRtspSource | undefined {
  if (input === null || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  if (!isManualRtspId(record.id)) return undefined
  const parsed = parseManualRtspUrl(record.url)
  if (!parsed.ok) return undefined
  const rawName = typeof record.name === 'string' ? record.name.trim() : ''
  const name = (rawName === '' ? defaultManualRtspName(parsed.url) : rawName).slice(
    0,
    MANUAL_RTSP_NAME_MAX_LENGTH
  )
  return { id: record.id, name, url: parsed.url }
}

/** 规范化整个列表：丢坏值、去重、截断到上限。 */
export function normaliseManualRtspSources(input: unknown): ManualRtspSource[] {
  if (!Array.isArray(input)) return []
  const out: ManualRtspSource[] = []
  const seen = new Set<string>()
  for (const item of input) {
    if (out.length >= MAX_MANUAL_RTSP_SOURCES) break
    const source = normaliseManualRtspSource(item)
    if (!source || seen.has(source.id)) continue
    seen.add(source.id)
    out.push(source)
  }
  return out
}
