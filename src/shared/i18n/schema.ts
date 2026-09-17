/**
 * The shape of a message catalogue, derived from the Chinese reference locale.
 *
 * WHY TYPE THE CATALOGUE AT ALL
 * A missing translation is invisible at runtime: vue-i18n falls back to the key,
 * so the UI shows `device.status.online` and nobody notices until a customer
 * does. Declaring the catalogue's SHAPE once — from the reference locale — turns
 * that into a compile error for any `en.ts` / `es.ts` / `tr.ts` that drops or
 * renames a key.
 *
 * The type is derived from `zh-CN` rather than declared by hand so the reference
 * locale cannot drift from its own type. `zh-CN.ts` is annotated with the
 * literal interface below, which is what anchors the chain.
 */

import type { zhCN } from './messages/zh-CN'

/**
 * Widened shape of the reference catalogue.
 *
 * `zhCN` is declared `as const`-free on purpose: the literal strings are
 * irrelevant to the contract, only the key structure and the fact that each leaf
 * is a string. Widening keeps the other locales free to use their own text.
 */
export type MessageSchema = DeepStringify<typeof zhCN>

/**
 * Rewrites `typeof zhCN` so every leaf becomes `string`.
 *
 * Needed because the reference locale's own values are literal types; without
 * this, `en.ts` would be forced to contain the Chinese text verbatim.
 */
type DeepStringify<T> = {
  [K in keyof T]: T[K] extends string
    ? string
    : T[K] extends readonly (infer U)[]
      ? readonly DeepStringify<U>[]
      : T[K] extends object
        ? DeepStringify<T[K]>
        : T[K]
}
