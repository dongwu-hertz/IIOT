/**
 * DeviceResult helpers — the renderer's single error-translation chokepoint.
 *
 * Spec section 14.2: "页面不得各自随意 try/catch 后展示原始异常".
 * Every IPC call resolves to a `DeviceResult<T>`; nothing rejects in normal
 * operation. These helpers are the ONLY place the renderer turns a failure into
 * a string, so the wording stays consistent across all views and a raw exception
 * can never reach the user.
 *
 * WHY TRANSLATION HAPPENS HERE AND NOT IN THE MAIN PROCESS
 * The main process already returns a stable `code` (see `shared/errors.ts`)
 * alongside its message. Because all 75+ call sites funnel through
 * `resultMessage`, translating by CODE at this one point localises every
 * main-process failure without touching the main process at all: no catalogue is
 * shipped into a process that renders no UI, and the language choice never has
 * to cross the IPC boundary.
 *
 * The main process's own message is still used, but only for failures whose text
 * originates on the DEVICE (`DEVICE_ERROR`) — that text is diagnostic and cannot
 * be translated by us, so it is surfaced as detail rather than discarded.
 */

import { i18n } from '@renderer/i18n'
import { DEFAULT_ERROR_MESSAGES, type AppErrorShape, type DeviceResult } from '@shared/errors'
import { useAppNoticesStore } from '@renderer/stores/appNotices'

/** 桥接失败在顶栏通知里的稳定 id（成功一次即撤掉，见 `callApi`）。 */
const BRIDGE_NOTICE_ID = 'app.bridge'

/**
 * Translate an error code.
 *
 * Falls back so a message always renders even when a main-process code has no
 * catalogue entry yet:
 *   1. the catalogue entry for the code
 *   2. the shared default authoring note for that code (Chinese, from
 *      `shared/errors.ts`) — better than showing nothing, and a visible signal
 *      during development that a translation is missing
 *   3. the generic failure text
 */
function translateCode(code: string | undefined): string {
  const key = code ?? 'UNKNOWN'
  const translated = i18n.global.t(`errors.${key}` as never)
  // vue-i18n returns the KEY itself when it is missing; that is how we detect a
  // gap rather than rendering a literal `errors.SOMETHING` to the user.
  if (typeof translated === 'string' && !translated.startsWith('errors.')) {
    return translated
  }
  const shared = DEFAULT_ERROR_MESSAGES[key as keyof typeof DEFAULT_ERROR_MESSAGES]
  return shared ?? i18n.global.t('errors.fallback')
}

/**
 * Human-readable message for an error shape.
 *
 * `DEVICE_ERROR` is special-cased: the device's own text is the most useful
 * thing we have, and inventing a generic sentence in its place would actively
 * hide the cause. It is shown as `deviceDetail` so the untranslatable part is
 * clearly marked as coming from the device.
 */
export function errorMessage(error?: AppErrorShape): string {
  if (!error) return i18n.global.t('errors.fallback')

  if (error.code === 'DEVICE_ERROR') {
    const detail = error.message?.trim()
    if (detail) return i18n.global.t('errors.deviceDetail', { detail })
    return translateCode(error.code)
  }

  /**
   * A lockout says HOW LONG TO WAIT, which the generic code message cannot.
   *
   * The delay is the only actionable part: "too many failed logins" without a
   * duration invites the user to keep hammering the button. It travels in `detail`
   * as `retryAfterSeconds=<n>` because the message itself is a main-process
   * authoring note in Chinese and must not be shown verbatim in another language.
   */
  if (error.code === 'AUTH_LOCKED') {
    const seconds = /retryAfterSeconds=(\d+)/.exec(error.detail ?? '')?.[1]
    return seconds
      ? i18n.global.t('errors.authLockedRetry', { seconds })
      : translateCode(error.code)
  }

  /**
   * 录像保存失败的两个具体结局（业主 20260921 批第 6 条）：空文件 / 文件不完整。
   * 目录消息直接说「该检查什么」；ffmpeg .stderr 尾巴经 `detail` 追加在括号里 —
   * 它是技术诊断（ffmpeg 只说英语），四语言共用。
   */
  if (error.code === 'RECORDING_EMPTY' || error.code === 'RECORDING_INCOMPLETE') {
    const detail = error.detail?.trim()
    const message = translateCode(error.code)
    return detail ? i18n.global.t('errors.withDetail', { message, detail }) : message
  }

  // An app-authored message still wins when the code is unknown or generic: it
  // is more specific than anything a catalogue keyed only by code can say.
  const message = error.message?.trim()
  if (message && (!error.code || error.code === 'UNKNOWN')) return message

  return translateCode(error.code)
}

/** Message for a failed result, including the code so support can triage. */
export function resultMessage<T>(result: DeviceResult<T>): string {
  if (result.success) return ''
  // 桥接失败（软件自身故障）只在顶栏通知里说一次；页面内的大字横幅对它保持沉默，
  // 否则一条「无法连接到主进程，请重启应用」会把整页内容顶下去（业主只要求标题栏提示）。
  if (result.error?.bridge === true) return ''
  return i18n.global.t('errors.withCode', {
    message: errorMessage(result.error),
    code: result.error?.code ?? 'UNKNOWN'
  })
}

/**
 * Unwrap a successful result or return `undefined`, never throwing.
 * Callers that need the failure text use `resultMessage` alongside it.
 */
export function unwrap<T>(result: DeviceResult<T>): T | undefined {
  return result.success ? result.data : undefined
}

/**
 * Defensive wrapper for an IPC call.
 *
 * The bridge itself may be absent (e.g. the renderer was loaded outside
 * Electron while iterating on styles) or a handler may throw before the main
 * process wraps it. Either way the UI gets a well-formed failure instead of an
 * unhandled rejection.
 */
export async function callApi<T>(
  operation: () => Promise<DeviceResult<T>>,
  fallbackMessage?: string
): Promise<DeviceResult<T>> {
  try {
    const result = await operation()
    if (result.success) {
      // 任何一次成功都证明桥是通的：把顶栏那条「无法连接到主进程」撤掉。
      useAppNoticesStore().clear(BRIDGE_NOTICE_ID)
    }
    return result
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const base = fallbackMessage ?? i18n.global.t('errors.bridgeUnavailable')
    // 顶栏通知说一遍（同 id 覆盖，不刷屏）；页面横幅由 `resultMessage` 的 bridge 分支沉默掉。
    useAppNoticesStore().report({
      id: BRIDGE_NOTICE_ID,
      kind: 'error',
      text: i18n.global.t('errors.bridgeUnavailableDetail', { message: base, detail })
    })
    return {
      success: false,
      error: {
        code: 'UNKNOWN',
        message: i18n.global.t('errors.bridgeUnavailableDetail', { message: base, detail }),
        bridge: true
      }
    }
  }
}
