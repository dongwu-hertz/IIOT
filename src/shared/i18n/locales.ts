/**
 * Locale catalogue — the single source of truth for which languages exist.
 *
 * WHY A SHARED MODULE AND NOT JUST A LIST INSIDE i18n.ts
 * The set of supported languages is needed by more than the message catalogue:
 * the language switcher renders it, the settings store persists against it, and
 * tools validate it. Declaring it once means adding a language is one edit plus
 * one resource file, rather than a hunt for hard-coded `'en' | 'zh-CN'` unions.
 *
 * `endonym` is the language's name IN THAT LANGUAGE ("Español", not "Spanish").
 * A language picker that shows names in the current UI language is unusable for
 * exactly the person who needs it: someone looking for their own language in an
 * interface they cannot read.
 */

export const LOCALES = ['zh-CN', 'zh-TW', 'en', 'es', 'tr', 'ru'] as const

export type AppLocale = (typeof LOCALES)[number]

export interface LocaleDescriptor {
  /** BCP 47 tag, also used as the vue-i18n locale key. */
  readonly code: AppLocale
  /** Language name written in that language. */
  readonly endonym: string
  /** Alphabetical sort key for the picker (endonym, case-insensitive). */
  readonly shortLabel: string
}

export const LOCALE_DESCRIPTORS: readonly LocaleDescriptor[] = [
  { code: 'zh-CN', endonym: '简体中文', shortLabel: '中文' },
  { code: 'zh-TW', endonym: '繁體中文', shortLabel: '繁中' },
  { code: 'en', endonym: 'English', shortLabel: 'EN' },
  { code: 'es', endonym: 'Español', shortLabel: 'ES' },
  { code: 'tr', endonym: 'Türkçe', shortLabel: 'TR' },
  { code: 'ru', endonym: 'Русский', shortLabel: 'RU' }
]

/**
 * Default language.
 *
 * Chinese, because the product shipped that way and its existing users must not
 * be silently switched to another language by an upgrade. A first launch keeps
 * the previous behaviour; other languages are an explicit opt-in.
 */
export const DEFAULT_LOCALE: AppLocale = 'zh-CN'

/** Key used to remember the choice. Namespaced to avoid colliding with future keys. */
export const LOCALE_STORAGE_KEY = 'hertzinno.locale'

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

/**
 * Pick the best supported language for a platform-provided tag list.
 *
 * Tries an exact match first (`zh-CN`), then the base language (`zh`), so a
 * system set to `zh-Hans-CN` or `es-419` still lands somewhere sensible instead
 * of falling back to the default.
 */
export function resolveLocale(candidates: readonly string[]): AppLocale | undefined {
  for (const candidate of candidates) {
    if (isAppLocale(candidate)) return candidate
  }
  for (const candidate of candidates) {
    const base = candidate.toLowerCase().split('-')[0]
    const match = LOCALES.find((locale) => locale.toLowerCase().split('-')[0] === base)
    if (match) return match
  }
  return undefined
}
