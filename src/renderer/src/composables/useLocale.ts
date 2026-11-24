/**
 * Language selection: read, persist, apply.
 *
 * WHY A MODULE-SCOPED SINGLETON RATHER THAN A PINIA STORE
 * The active locale is one value with no relations, no async data and no
 * cross-store dependencies. A store would add indirection without adding
 * anything, and the i18n instance is itself already a global singleton — the
 * locale must stay in step with it, so keeping both in one module makes that
 * coupling visible instead of spreading it over two files.
 *
 * RESOLUTION ORDER on first launch
 *   1. the user's previous explicit choice (localStorage)
 *   2. the product default (English)
 *
 * The product now defaults to English; the picker still offers Simplified and
 * Traditional Chinese immediately after it. OS language detection is deliberately
 * not used for the initial selection: a fresh installation must open in English
 * unless the operator explicitly chooses another language.
 */

import { ref, computed, readonly } from 'vue'
import { i18n } from '@renderer/i18n'
import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_DESCRIPTORS,
  LOCALE_STORAGE_KEY,
  isAppLocale,
  type AppLocale
} from '@shared/i18n/locales'

const current = ref<AppLocale>(DEFAULT_LOCALE)
let initialised = false

/** Persisted choice, tolerating a disabled or unavailable storage backend. */
function readStoredLocale(): AppLocale | undefined {
  try {
    const raw = window.localStorage.getItem(LOCALE_STORAGE_KEY)
    return isAppLocale(raw) ? raw : undefined
  } catch {
    // Private mode or a locked-down profile: fall through to detection.
    return undefined
  }
}

function writeStoredLocale(locale: AppLocale): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // Not being able to remember the choice must not break switching it.
  }
}

/**
 * Apply a locale to every sink that needs to agree on it.
 *
 * `document.documentElement.lang` is not cosmetic: it drives hyphenation, font
 * fallback selection and the browser's own spell/grammar behaviour. Leaving it
 * at `zh-CN` while rendering Turkish would produce subtly wrong line breaking.
 */
function apply(locale: AppLocale): void {
  current.value = locale
  i18n.global.locale.value = locale
  // 同步给主进程（告警弹窗文案在那里渲染，见 `main/services/ui-locale.ts`）。
  // 单向镜像、fire-and-forget：语言显示从来不依赖这次调用的结果。
  void window.api?.app?.setLocale?.(locale)
  try {
    document.documentElement.lang = locale
  } catch {
    // Non-DOM test environment.
  }
}

export function useLocale() {
  const setLocale = (locale: AppLocale): void => {
    if (!LOCALES.includes(locale)) return
    apply(locale)
    writeStoredLocale(locale)
  }

  /**
   * Resolve the startup language. Safe to call more than once; only the first
   * call does work, so it can live in the app shell without a guard at the call
   * site.
   */
  const initLocale = async (): Promise<void> => {
    if (initialised) return
    initialised = true

    const stored = readStoredLocale()
    apply(stored ?? DEFAULT_LOCALE)
  }

  return {
    locale: readonly(current),
    locales: LOCALE_DESCRIPTORS,
    setLocale,
    initLocale,
    isReady: computed(() => initialised)
  }
}
