/**
 * Release metadata, inlined by the bundler from `package.json` at build time.
 *
 * `__RELEASE__` is substituted by `define` in `electron.vite.config.ts`. It is
 * declared here rather than read at runtime because the packaged application has
 * no dependable path back to `package.json`, and because the version shown in the
 * UI must be the same value electron-builder stamps into the installer.
 *
 * This module is the ONLY place the global is referenced, so the declaration and
 * the fallback live together. The fallback matters for the plain-Node test runner,
 * which compiles `src/shared` without the bundler's `define` and would otherwise
 * throw on an undeclared identifier.
 */

export interface ReleaseInfo {
  /** `package.json` version — matches the installer. */
  version: string
  /** Declared release date, `YYYY-MM-DD`. */
  releaseDate: string
  /** When this particular build was produced, `YYYY-MM-DD`. */
  buildDate: string
  /** Company website. */
  homepage: string
  /** Support address. */
  supportEmail: string
}

/** Injected by the bundler; absent under a bare `tsc` build. */
declare const __RELEASE__: ReleaseInfo | undefined

const FALLBACK: ReleaseInfo = {
  version: '0.0.0-dev',
  releaseDate: '',
  buildDate: '',
  homepage: 'https://www.hertzinno.com',
  supportEmail: 'info@hertzinno.com'
}

export const RELEASE: ReleaseInfo =
  typeof __RELEASE__ === 'object' && __RELEASE__ !== null ? __RELEASE__ : FALLBACK

/** `1.0.0` -> `v1.0.0`, for display. */
export function formatVersion(version = RELEASE.version): string {
  return version.startsWith('v') ? version : `v${version}`
}

/**
 * Parse a plain `YYYY-MM-DD` calendar date into a Date in the LOCAL zone.
 *
 * WHY NOT `new Date('2026-09-11')`
 * That form is specified as UTC midnight, so any locale-aware formatting of it
 * renders the PREVIOUS day for every user west of Greenwich — a build stamped
 * `2026-09-11` would read "10 sept 2026" in Mexico City. The fields are therefore
 * taken apart by hand and rebuilt in the user's own zone, which is what a calendar
 * date actually means here: the day the artifact was released, not an instant.
 *
 * This lives in the shared layer because it is pure and locale-free — it produces
 * a Date, never text. Rendering that Date is the renderer's job (an Intl-backed
 * `formatDate`), since only the renderer knows the active language. There is
 * deliberately no `formatReleaseDate` next to it any more.
 *
 * Returns `undefined` for anything that is not a plain date, so the caller can
 * fall back to the raw string rather than inventing a day.
 */
export function parsePlainDate(value: string | null | undefined): Date | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!match) return undefined
  const [, year, month, day] = match
  const date = new Date(Number(year), Number(month) - 1, Number(day))
  return Number.isNaN(date.getTime()) ? undefined : date
}
