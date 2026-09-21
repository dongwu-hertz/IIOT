/**
 * Unified error model (spec section 14.2).
 *
 * Rule from the spec: "页面不得各自随意 try/catch 后展示原始异常"
 * (pages must not each invent their own try/catch and show raw exceptions).
 * Every failure that crosses the IPC boundary is normalised into a
 * `DeviceResult` carrying one of these stable codes, so the UI can render a
 * consistent, translatable message.
 */

export const ErrorCodes = {
  /** Device is known but currently unreachable (failed the online probe). */
  DEVICE_OFFLINE: 'DEVICE_OFFLINE',
  /** Request exceeded its deadline. */
  TIMEOUT: 'TIMEOUT',
  /** /login rejected the credentials, or the token was refused. */
  AUTH_FAILED: 'AUTH_FAILED',
  /**
   * The caller is authenticated but not ALLOWED to do this.
   *
   * Distinct from AUTH_FAILED on purpose: "you are not logged in" and "you are
   * logged in as an operator and this is an administrator action" need different
   * UI responses — the first should offer the login screen, the second must not,
   * because re-entering the same credentials would change nothing.
   */
  FORBIDDEN: 'FORBIDDEN',
  /** Device answered, but the payload did not match the expected protocol shape. */
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  /** Device answered with its own error status/message. */
  DEVICE_ERROR: 'DEVICE_ERROR',
  /** Local storage failure (SQLite, file write, path not writable). */
  STORAGE_ERROR: 'STORAGE_ERROR',
  /** Free disk space fell below the configured safety floor. */
  DISK_FULL: 'DISK_FULL',
  /** Transport-level failure before a response existed (DNS, TCP reset, TLS). */
  NETWORK_ERROR: 'NETWORK_ERROR',
  /** Caller input failed validation (bad IP, missing name, out-of-range port). */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /**
   * Account-management outcomes that need their OWN message in the UI.
   *
   * WHY NOT VALIDATION_ERROR
   * `errorMessage()` in the renderer translates by CODE, so every VALIDATION_ERROR
   * renders as the same generic "the input is invalid". That is exactly wrong for
   * these three: "this name is already taken", "you cannot remove the last
   * administrator" and "the password is too short" each need to tell the user what
   * to do next. They are also the rules only the main process can evaluate (the
   * renderer cannot know whether another account holds the name), so they cannot
   * simply be validated in the page the way the settings form validates its own
   * fields.
   */
  AUTH_USERNAME_TAKEN: 'AUTH_USERNAME_TAKEN',
  AUTH_LAST_ADMIN: 'AUTH_LAST_ADMIN',
  AUTH_PASSWORD_POLICY: 'AUTH_PASSWORD_POLICY',
  /**
   * Too many failed attempts: the account is temporarily locked.
   *
   * A dedicated code rather than reusing FORBIDDEN, and that is a real defect this
   * replaced: the renderer translates BY CODE, so a lockout rendered as "this
   * account is not allowed to perform that action" — the opposite of what
   * happened, and it hides the one thing the user needs to know (their password
   * was wrong; waiting a moment fixes it). The retry delay travels in `detail` as
   * `retryAfterSeconds=<n>`.
   */
  AUTH_LOCKED: 'AUTH_LOCKED',
  /** Capability exists in the UI but is not implemented for this device/repository. */
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  /** Anything genuinely unexpected. Should be rare; log with stack. */
  UNKNOWN: 'UNKNOWN'
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

export interface AppErrorShape {
  code: ErrorCode
  message: string
  /** Optional operator-facing detail. Must never contain credentials or tokens. */
  detail?: string
  /**
   * `true` = 渲染层桥接失败的兜底错误（`callApi` catch 那一支：IPC 未实现、
   * 主进程抛了未包装异常、或返回值无法结构化克隆）。它说的是「这个软件自己坏了」，
   * 不是「这台设备/这次操作坏了」——界面据此把它放进**顶栏通知**而不是页面内的大字横幅
   * （业主：「无法连接到主进程，请重启应用 这类的提示只需要在标题栏提示即可」）。
   */
  bridge?: boolean
}

/** Uniform envelope returned across every IPC boundary. */
export interface DeviceResult<T> {
  success: boolean
  data?: T
  error?: AppErrorShape
}

export function ok<T>(data: T): DeviceResult<T> {
  return { success: true, data }
}

export function fail<T = never>(
  code: ErrorCode,
  message: string,
  detail?: string
): DeviceResult<T> {
  return { success: false, error: detail ? { code, message, detail } : { code, message } }
}

/**
 * Typed application error. Thrown inside services, converted to a
 * `DeviceResult` at the IPC boundary by `toResult`.
 */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly detail?: string

  constructor(code: ErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.detail = detail
  }

  static from(error: unknown, fallbackCode: ErrorCode = ErrorCodes.UNKNOWN): AppError {
    if (error instanceof AppError) return error
    if (error instanceof Error) {
      return new AppError(fallbackCode, error.message, error.stack)
    }
    return new AppError(fallbackCode, String(error))
  }
}

/** Narrow an unknown thrown value into a serialisable shape. */
export function toErrorShape(error: unknown): AppErrorShape {
  if (error instanceof AppError) {
    return error.detail
      ? { code: error.code, message: error.message, detail: error.detail }
      : { code: error.code, message: error.message }
  }
  if (error instanceof Error) {
    return { code: ErrorCodes.UNKNOWN, message: error.message }
  }
  return { code: ErrorCodes.UNKNOWN, message: String(error) }
}

/** Wrap a promise-returning operation so it never rejects across IPC. */
export async function toResult<T>(operation: () => Promise<T>): Promise<DeviceResult<T>> {
  try {
    return ok(await operation())
  } catch (error) {
    return { success: false, error: toErrorShape(error) }
  }
}

/** Human-readable default message per code. UI may override with i18n. */
export const DEFAULT_ERROR_MESSAGES: Record<ErrorCode, string> = {
  DEVICE_OFFLINE: '设备当前离线，无法连接',
  TIMEOUT: '请求超时，设备未在规定时间内响应',
  AUTH_FAILED: '认证失败，请检查用户名和密码',
  FORBIDDEN: '当前账户没有执行该操作的权限',
  INVALID_RESPONSE: '设备返回的数据格式不符合预期',
  DEVICE_ERROR: '设备返回错误',
  STORAGE_ERROR: '本地存储读写失败',
  DISK_FULL: '磁盘剩余空间不足，已停止非必要录音',
  NETWORK_ERROR: '网络连接失败',
  VALIDATION_ERROR: '输入参数不合法',
  AUTH_USERNAME_TAKEN: '该用户名已被占用',
  AUTH_LAST_ADMIN: '必须保留至少一个管理员账户',
  AUTH_PASSWORD_POLICY: '密码不符合要求（至少 8 位，不能包含用户名，首尾不能有空格）',
  AUTH_LOCKED: '登录失败次数过多，请稍后重试',
  NOT_IMPLEMENTED: '该功能尚未实现',
  UNKNOWN: '发生未知错误'
}
