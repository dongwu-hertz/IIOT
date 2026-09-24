/**
 * vue-i18n instance and locale-aware formatting.
 *
 * DESIGN NOTES
 *
 * 1. NO CROSS-PROCESS LANGUAGE STATE.
 *    The main process sends stable error CODES; translation happens here, in the
 *    single renderer-side chokepoint (`lib/result.ts`). Nothing has to tell the
 *    main process which language the user picked, and no catalogue is shipped
 *    into a process that renders no UI.
 *
 * 2. `fallbackLocale` IS THE REFERENCE LOCALE, NOT ENGLISH.
 *    Any key that exists only in the reference catalogue still renders readable
 *    text. Combined with the `MessageSchema` type on every catalogue, a missing
 *    key is a build error anyway — the fallback exists for the handful of
 *    runtime-only lookups (dynamic codes) that types cannot cover.
 *
 * 3. FORMATTING GOES THROUGH `Intl`, NOT THROUGH THE CATALOGUE.
 *    Spanish and Turkish do not format numbers or dates the way Chinese does:
 *    `1.234,5` versus `1,234.5`, and Turkish puts the month before the day. Those
 *    are locale DATA, not translatable strings, so they are delegated to the
 *    platform rather than hand-rolled into message templates.
 */

import { createI18n } from 'vue-i18n'
import { DEFAULT_LOCALE, type AppLocale } from '@shared/i18n/locales'
import type { MessageSchema } from '@shared/i18n/schema'
import { zhCN } from '@shared/i18n/messages/zh-CN'
import { zhTW } from '@shared/i18n/messages/zh-TW'
import { en } from '@shared/i18n/messages/en'
import { es } from '@shared/i18n/messages/es'
import { tr } from '@shared/i18n/messages/tr'
import { ru } from '@shared/i18n/messages/ru'

/**
 * Teach vue-i18n this project's catalogue shape.
 *
 * This augmentation is what makes `i18n.global.locale` a `WritableComputedRef`
 * (composition mode) instead of the bare `string` union, and what gives
 * `useI18n()` inside components full key autocompletion. Passing the generics to
 * `createI18n` alone does NOT achieve that — it types the messages but leaves
 * `.global.locale` as a plain value, which then fails to type-check on
 * assignment.
 */
declare module 'vue-i18n' {
  export interface DefineLocaleMessage extends MessageSchema {}
}

export const i18n = createI18n({
  // Composition API mode: `legacy: false` is what makes `useI18n()` inside
  // `<script setup>` return the global scope rather than a per-component one.
  legacy: false,
  locale: DEFAULT_LOCALE,
  fallbackLocale: DEFAULT_LOCALE,
  messages: {
    'zh-CN': zhCN,
    'zh-TW': zhTW,
    en,
    es,
    tr,
    ru
  },
  /**
   * Missing translations are prevented by types and by a test that compares the
   * catalogues key by key, so vue-i18n's own console warnings would only add
   * noise to the smoke test's console-error assertions.
   */
  missingWarn: false,
  fallbackWarn: false
})

/** The active locale's BCP 47 tag, for `Intl`. */
export function activeLocale(): AppLocale {
  return i18n.global.locale.value
}
/** Locale-aware date and time, e.g. `11/09/2026 19:04` or `2026/9/11 19:04`. */
export function formatDateTime(value: number | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(activeLocale(), {
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(date)
}

/** Locale-aware date without a time component. */
export function formatDate(value: number | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(activeLocale(), { dateStyle: 'medium' }).format(date)
}

/**
 * Locale-aware number with a bounded number of fraction digits.
 *
 * The default of 2 matches what the acoustics readouts want; callers that need
 * integer counts pass 0 rather than letting the default round a count to `3.00`.
 */
export function formatNumber(value: number, fractionDigits = 2): string {
  if (!Number.isFinite(value)) return '—'
  return new Intl.NumberFormat(activeLocale(), {
    minimumFractionDigits: 0,
    maximumFractionDigits: fractionDigits
  }).format(value)
}

/**
 * Locale-aware upper-casing.
 *
 * Turkish needs this specifically: the default `toUpperCase()` maps `i` to `I`,
 * but Turkish requires `İ`. Anywhere a label is upper-cased for display (section
 * headers, badges) must use this rather than `String.toUpperCase`.
 */
export function upperCaseForLocale(value: string): string {
  return value.toLocaleUpperCase(activeLocale())
}

/**
 * Build the window/document title for a page.
 *
 * Kept here rather than in the router because the title has to be rebuilt when
 * the LANGUAGE changes, not only when the route does. The router's `afterEach`
 * hook fires on navigation, so a language switch would otherwise leave the
 * window title in the previous language until the user navigated somewhere else.
 */
/**
 * Translate a route's page-title key, tolerating a missing key.
 *
 * WHY THIS GUARD EXISTS AT ALL, AND WHY IT IS NOT DEFENSIVE NOISE
 * Before the router completes its first resolution, `route.meta` is the empty
 * `START_LOCATION` meta and `titleKey` is `undefined`. Handing that to vue-i18n
 * throws a bare `SyntaxError: 17` — no call site, no key, nothing actionable —
 * which then surfaces as an uncaught component error on every startup. Both the
 * topbar heading and the window caption read the same key, so the guard lives
 * here once rather than being repeated (and eventually forgotten) at each call.
 */
export function pageTitle(pageTitleKey?: unknown): string {
  if (typeof pageTitleKey !== 'string' || pageTitleKey === '') {
    return i18n.global.t('app.title')
  }
  return i18n.global.t(pageTitleKey as never)
}

/** Window/document caption for a page: `"总览 · HAIS"`. */
export function documentTitle(pageTitleKey?: unknown): string {
  const appName = i18n.global.t('app.title')
  const page = pageTitle(pageTitleKey)
  // No real page title yet: the caption is just the product name, rather than
  // "HAIS · HAIS".
  return page === appName ? appName : `${page} · ${appName}`
}
