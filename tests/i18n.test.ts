/**
 * Catalogue parity and quality tests.
 *
 * WHY THIS EXISTS
 * A missing translation is silent at runtime: vue-i18n renders the key, the app
 * looks fine in the language the developer happens to use, and the gap surfaces
 * in front of a customer reading English, Spanish or Turkish.
 *
 * TypeScript already rejects a catalogue that is missing a KEY (each is typed
 * against `MessageSchema`). These tests cover what types cannot:
 *   - placeholder drift (`{count}` present in one language, `{sayi}` in another),
 *     which type-checks but renders a literal `{count}` to the user;
 *   - untranslated copy pasted from the reference locale;
 *   - a locale added to `LOCALES` but never wired into the i18n instance.
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { LOCALES, LOCALE_DESCRIPTORS, resolveLocale, isAppLocale } from '../src/shared/i18n/locales'
import { zhCN } from '../src/shared/i18n/messages/zh-CN'
import { en } from '../src/shared/i18n/messages/en'
import { es } from '../src/shared/i18n/messages/es'
import { tr } from '../src/shared/i18n/messages/tr'
import {
  AlarmType,
  ALARM_TYPE_KEYS,
  DETECTION_TYPE_KEYS,
  DEVICE_KINDS,
  RECORDING_TYPES,
  SENSOR_TYPE_KEYS
} from '../src/shared/domain/models'
import { STREAM_KINDS } from '../src/shared/domain/monitoring'
import { USER_ROLES } from '../src/shared/domain/auth'
import { DEFAULT_ERROR_MESSAGES } from '../src/shared/errors'
import { alarmTypeKey } from '../src/shared/domain/alarm-mask'
// The message compiler vue-i18n uses at runtime, for the syntax guard below.
import { compile } from '@intlify/core-base'
import { i18n, pageTitle, documentTitle } from '../src/renderer/src/i18n'

type Catalogue = Record<string, unknown>

const CATALOGUES: Record<string, Catalogue> = {
  'zh-CN': zhCN as unknown as Catalogue,
  en: en as unknown as Catalogue,
  es: es as unknown as Catalogue,
  tr: tr as unknown as Catalogue
}

/** Flatten to `a.b.c -> value`, which is the shape vue-i18n looks keys up by. */
function flatten(source: Catalogue, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, value] of Object.entries(source)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [nested, nestedValue] of flatten(value as Catalogue, path)) {
        out.set(nested, nestedValue)
      }
    } else {
      out.set(path, String(value))
    }
  }
  return out
}

const REFERENCE = flatten(CATALOGUES['zh-CN'] as Catalogue)

/** `{name}` and `{count}` style placeholders, in the order they appear. */
function placeholders(message: string): string[] {
  return [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string).sort()
}

describe('locale catalogue', () => {
  it('exposes a descriptor for every declared locale', () => {
    assert.equal(LOCALE_DESCRIPTORS.length, LOCALES.length)
    for (const locale of LOCALES) {
      assert.ok(
        LOCALE_DESCRIPTORS.some((descriptor) => descriptor.code === locale),
        `no descriptor for ${locale}`
      )
    }
  })

  it('names every language in its own language, not in the reference language', () => {
    // A picker that says "西班牙语" is useless to a Spanish speaker who is
    // looking at an interface they cannot read — which is exactly who needs it.
    const endonyms: Record<string, string> = {
      'zh-CN': '简体中文',
      en: 'English',
      es: 'Español',
      tr: 'Türkçe'
    }
    for (const descriptor of LOCALE_DESCRIPTORS) {
      assert.equal(descriptor.endonym, endonyms[descriptor.code])
    }
  })

  it('has a catalogue for every locale', () => {
    for (const locale of LOCALES) {
      assert.ok(CATALOGUES[locale], `missing catalogue for ${locale}`)
    }
  })

  it('defines the same key set in every language as the reference', () => {
    const referenceKeys = [...REFERENCE.keys()].sort()
    for (const locale of LOCALES) {
      const keys = [...flatten(CATALOGUES[locale] as Catalogue).keys()].sort()
      const missing = referenceKeys.filter((key) => !keys.includes(key))
      const extra = keys.filter((key) => !referenceKeys.includes(key))
      assert.deepEqual(missing, [], `${locale} is missing keys: ${missing.join(', ')}`)
      assert.deepEqual(extra, [], `${locale} has keys the reference lacks: ${extra.join(', ')}`)
    }
  })

  it('uses the same placeholders in every language', () => {
    // Placeholder drift is the classic i18n bug that type-checks cleanly: the
    // message renders, but the user sees a literal `{count}`.
    for (const locale of LOCALES) {
      const translated = flatten(CATALOGUES[locale] as Catalogue)
      for (const [key, referenceMessage] of REFERENCE) {
        const message = translated.get(key)
        if (message === undefined) continue
        assert.deepEqual(
          placeholders(message),
          placeholders(referenceMessage),
          `${locale} placeholder mismatch at ${key}: "${message}" vs "${referenceMessage}"`
        )
      }
    }
  })

  it('translatable messages are non-empty in every language', () => {
    for (const locale of LOCALES) {
      for (const [key, message] of flatten(CATALOGUES[locale] as Catalogue)) {
        assert.ok(message.trim().length > 0, `${locale}.${key} is empty`)
      }
    }
  })

  it('compiles every message in every language', () => {
    // REGRESSION GUARD for a bug class that type-checks, passes every other test
    // in this file, and then breaks the UI at runtime.
    //
    // vue-i18n compiles a message LAZILY, the first time that key is rendered, and
    // a compile error surfaces as an uncaught component error with a bare numeric
    // code and no call site (`SyntaxError: 17` cost a previous round real
    // debugging time; `SyntaxError: 10` was an `@`).
    //
    // WHY THIS DOES NOT USE `i18n.global.t()`
    // It was written that way first and it did NOT catch the bug: `t()` returned a
    // string for a message whose compilation fails, so the guard passed while the
    // application crashed. `compile()` with an `onError` collector reports the
    // error instead of hiding it, which is what makes the assertion meaningful.
    // (Verified by putting the bad string back: this test fails, `t()` did not.)
    //
    // The trap worth naming: `@` is the LINKED-MESSAGE sigil, so an e-mail address
    // — or the FA371 factory password `Hz@123456` — makes the message that
    // contains it unrenderable until it is written `{'@'}`.
    //
    // `@intlify/core-base` is the compiler vue-i18n itself uses. If this import
    // ever breaks on an upgrade, point it at `@intlify/message-compiler`'s
    // `baseCompile` — do NOT delete the check.
    const errors: number[] = []
    for (const locale of LOCALES) {
      const messages = flatten(CATALOGUES[locale] as Catalogue)
      for (const [key, message] of messages) {
        const found: Array<{ code: number; message: string }> = []
        // `key` and `locale` are part of the compiler context so a failure can be
        // reported against the message that caused it.
        compile(message, {
          key,
          locale,
          onError: (error) => found.push(error as never)
        })
        for (const error of found) {
          errors.push(error.code)
          assert.fail(
            `${locale}.${key} does not compile (code ${error.code}: ${error.message}): ${message}`
          )
        }
      }
    }
    assert.deepEqual(errors, [])
  })

  it('non-reference catalogues are actually translated', () => {
    // Catches a copy-paste of the reference file as a starting point and then
    // forgetting to translate it.
    //
    // Three kinds of message are legitimately identical across languages, and are
    // exempted by RULE rather than by a growing name list:
    //   - the product name, a proper noun;
    //   - pure format strings such as `{from} – {to}`, which contain no prose at
    //     all once the placeholders are removed;
    //   - technical identifiers such as `RS485 / Modbus`, whose ASCII letters are
    //     all uppercase (an abbreviation or product name, not a sentence).
    //
    // The uppercase test is deliberately narrow: it only exempts strings with no
    // lowercase ASCII letters, so ordinary English prose copied from a partially
    // translated file still fails.
    const identicalIsExpected = new Set(['app.title'])
    /**
     * Is the REFERENCE message prose that was supposed to be translated?
     *
     * The reference catalogue is Chinese, so the reliable signal is simply
     * "does it contain Chinese?". A reference string like `RS485 / Modbus`,
     * `SPL` or `FPGA` never contained Chinese prose — it is a protocol name,
     * abbreviation or product name that every language carries unchanged, so a
     * locale matching it byte-for-byte is correct rather than untranslated.
     *
     * Deriving this from the reference (not from the other locales) is what keeps
     * ordinary English text copied out of a half-translated file in scope: such a
     * key's reference IS Chinese, so it still fails.
     */
    const referenceIsProse = (message: string): boolean => /[\u4e00-\u9fff]/.test(message)
    for (const locale of LOCALES) {
      if (locale === 'zh-CN') continue
      const translated = flatten(CATALOGUES[locale] as Catalogue)
      const untranslated: string[] = []
      for (const [key, referenceMessage] of REFERENCE) {
        if (identicalIsExpected.has(key)) continue
        if (!referenceIsProse(referenceMessage)) continue
        if (translated.get(key) === referenceMessage) untranslated.push(key)
      }
      assert.deepEqual(
        untranslated,
        [],
        `${locale} still contains reference text at: ${untranslated.join(', ')}`
      )
    }
  })
})

/**
 * Domain enum coverage.
 *
 * REGRESSION GUARD for a whole class of defect that used to be invisible: the
 * shared layer once carried `ALARM_TYPE_LABELS`, `SENSOR_TYPE_LABELS`,
 * `STREAM_KIND_LABELS` and friends — Chinese `Record<Enum, string>` maps. They
 * rendered fine in the reference language and could not be translated at all, so
 * any page that imported one silently produced a Chinese label in an English UI.
 *
 * Those maps are gone; the shared layer now exposes stable KEYS (`alarmTypeKey()`,
 * `SENSOR_TYPE_KEYS`, `STREAM_KINDS`, …) and the renderer translates them. That
 * only works if every key actually exists in every catalogue, which is what these
 * tests check — for a widened enum too, since the key maps are total.
 */
describe('domain enum coverage', () => {
  /**
   * Assert a key resolves in EVERY catalogue.
   *
   * Checking all four rather than the reference is the point: the failure this
   * guards against is a key that exists in Chinese and nowhere else.
   */
  function assertAllLocalesHave(key: string): void {
    for (const locale of LOCALES) {
      const messages = flatten(CATALOGUES[locale] as Catalogue)
      assert.ok(messages.has(key), `${locale} has no message for ${key}`)
    }
  }

  it('names every alarm type', () => {
    const types = Object.values(AlarmType).filter(
      (value): value is AlarmType => typeof value === 'number'
    )
    assert.ok(types.length > 0)
    for (const type of types) assertAllLocalesHave(`alarms.type.${alarmTypeKey(type)}`)
  })

  it('names every sensor type', () => {
    for (const key of Object.values(SENSOR_TYPE_KEYS)) {
      assertAllLocalesHave(`domain.sensorType.${key}`)
    }
  })

  it('names every detection mode', () => {
    for (const key of Object.values(DETECTION_TYPE_KEYS)) {
      assertAllLocalesHave(`domain.detectionMode.${key}`)
    }
  })

  it('names every recording type', () => {
    for (const type of RECORDING_TYPES) assertAllLocalesHave(`domain.recordingType.${type}`)
  })

  it('names every stream kind', () => {
    for (const kind of STREAM_KINDS) assertAllLocalesHave(`domain.streamKind.${kind}`)
  })

  it('names every device kind', () => {
    // The Add Device dialog offers both families, so a kind without a name would
    // render as a raw `domain.deviceKind.*` key in four languages at once.
    for (const kind of DEVICE_KINDS) assertAllLocalesHave(`domain.deviceKind.${kind}`)
  })

  it('names every user role', () => {
    // The account dialog and the sidebar both show a role; an unmapped one would
    // leave an operator staring at `domain.userRole.operator`.
    for (const role of USER_ROLES) assertAllLocalesHave(`domain.userRole.${role}`)
  })

  it('translates every error code the renderer can receive', () => {
    // `lib/result.ts` translates BY CODE and falls back to the Chinese
    // DEFAULT_ERROR_MESSAGES when a code has no catalogue entry — so a code that
    // exists only in `shared/errors.ts` silently degrades an English UI to
    // Chinese. This makes that a test failure instead.
    for (const code of Object.keys(DEFAULT_ERROR_MESSAGES)) {
      assertAllLocalesHave(`errors.${code}`)
    }
  })

  it('keeps the label maps out of the shared layer', () => {
    // The keys maps must be keys. A future contributor reintroducing a Chinese
    // label under one of these names would pass every other test in this file.
    const keys = [
      ...Object.values(ALARM_TYPE_KEYS),
      ...Object.values(SENSOR_TYPE_KEYS),
      ...Object.values(DETECTION_TYPE_KEYS),
      ...RECORDING_TYPES,
      ...STREAM_KINDS,
      ...DEVICE_KINDS,
      ...USER_ROLES
    ]
    for (const key of keys) {
      assert.ok(/^[A-Za-z0-9_]+$/.test(key), `"${key}" is not a stable identifier`)
    }
  })
})

describe('locale resolution', () => {
  it('accepts an exact supported tag', () => {
    assert.equal(resolveLocale(['tr']), 'tr')
    assert.equal(resolveLocale(['es']), 'es')
  })

  it('falls back to the base language for a regional tag', () => {
    // Windows reports `tr-TR`, `es-419`, `zh-Hans-CN`; none of those are exact
    // matches, and treating them as unsupported would send every user to the
    // default language.
    assert.equal(resolveLocale(['tr-TR']), 'tr')
    assert.equal(resolveLocale(['es-419']), 'es')
    assert.equal(resolveLocale(['zh-Hans-CN']), 'zh-CN')
  })

  it('honours preference order', () => {
    assert.equal(resolveLocale(['fr-FR', 'es-ES', 'en-US']), 'es')
  })

  it('returns undefined when nothing matches', () => {
    assert.equal(resolveLocale(['fr-FR', 'de-DE']), undefined)
    assert.equal(resolveLocale([]), undefined)
  })

  it('guards invalid locale values', () => {
    assert.ok(isAppLocale('en'))
    assert.ok(!isAppLocale('EN'))
    assert.ok(!isAppLocale(null))
    assert.ok(!isAppLocale(42))
  })
})

/**
 * The page-title guard.
 *
 * REGRESSION TEST for a defect that cost real debugging time: the topbar read
 * `route.meta.titleKey` in a computed, and before the router finished its first
 * resolution that is `undefined`. vue-i18n does not report "undefined key" — it
 * throws a bare `SyntaxError: 17` with no call site, which surfaced as an
 * uncaught component error on every startup and pointed nowhere useful.
 *
 * `route.meta` for the router's START_LOCATION is an empty object, so passing
 * `undefined` through is exactly what the guard must survive.
 */
describe('page title guard', () => {
  it('does not throw when the route has no title key yet', () => {
    assert.doesNotThrow(() => pageTitle(undefined))
    assert.doesNotThrow(() => documentTitle(undefined))
  })

  it('falls back to the application name', () => {
    const appName = i18n.global.t('app.title')
    assert.equal(pageTitle(undefined), appName)
    // The caption must not become "App · App".
    assert.equal(documentTitle(undefined), appName)
  })

  it('rejects non-string keys rather than forwarding them to vue-i18n', () => {
    // A watch source or a mis-typed meta value can deliver an array or object.
    assert.equal(pageTitle(['zh-CN', 'app.nav.overview']), i18n.global.t('app.title'))
    assert.equal(pageTitle({}), i18n.global.t('app.title'))
    assert.equal(pageTitle(''), i18n.global.t('app.title'))
  })

  it('resolves a real key and composes the caption', () => {
    const appName = i18n.global.t('app.title')
    assert.equal(pageTitle('app.nav.overview'), i18n.global.t('app.nav.overview'))
    assert.equal(
      documentTitle('app.nav.overview'),
      `${i18n.global.t('app.nav.overview')} · ${appName}`
    )
  })
})
