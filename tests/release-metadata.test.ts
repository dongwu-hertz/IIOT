/**
 * Tests for the release-metadata helpers.
 *
 * WHY THE DATE PARSER IS WORTH TESTING
 * `new Date('2026-09-11')` is parsed as UTC midnight, so any Intl formatting of it
 * renders 2026-09-10 for every user west of Greenwich. A release date shown one
 * day early is small but it is exactly the kind of detail that makes a product
 * look unmaintained, and it is invisible to anyone testing in Asia.
 *
 * The date itself is parsed in the SHARED layer (`parsePlainDate`), which is pure
 * and locale-free, and rendered in the renderer by an Intl-backed `formatDate`:
 * only the renderer knows the active language, so `shared/release.ts` no longer
 * carries a formatter of its own. These tests run under whatever timezone the
 * machine has, which is the point: the parser must not depend on it.
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { RELEASE, formatVersion, parsePlainDate } from '../src/shared/release'

describe('RELEASE', () => {
  it('always exposes a usable shape, even without the bundler define', () => {
    // The plain-Node test runner compiles `src/shared` with `tsc`, which does not
    // substitute `__RELEASE__`. That must degrade to the fallback, never throw.
    assert.equal(typeof RELEASE.version, 'string')
    assert.ok(RELEASE.version.length > 0)
    assert.ok(RELEASE.homepage.startsWith('https://'))
    assert.ok(RELEASE.supportEmail.includes('@'))
  })

  it('carries a support address and a website', () => {
    assert.equal(RELEASE.supportEmail, 'info@hertzinno.com')
    assert.equal(RELEASE.homepage, 'https://www.hertzinno.com')
  })
})

describe('formatVersion', () => {
  it('prefixes a bare version with v', () => {
    assert.equal(formatVersion('1.0.0'), 'v1.0.0')
  })

  it('does not double-prefix an already-prefixed version', () => {
    assert.equal(formatVersion('v1.0.0'), 'v1.0.0')
  })

  it('passes through a prerelease tag', () => {
    assert.equal(formatVersion('1.2.3-beta.1'), 'v1.2.3-beta.1')
  })
})

describe('parsePlainDate', () => {
  it('keeps the calendar day in every timezone', () => {
    // THE REGRESSION. A UTC-midnight parse renders the previous day in any
    // negative-offset timezone, so this asserts the day survives the round trip.
    for (const zone of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Asia/Shanghai']) {
      const original = process.env.TZ
      try {
        process.env.TZ = zone
        const date = parsePlainDate('2026-09-11')
        assert.ok(date, `unparsed under ${zone}`)
        assert.equal(date.getFullYear(), 2026, `year under ${zone}`)
        assert.equal(date.getMonth(), 8, `month under ${zone}`)
        assert.equal(date.getDate(), 11, `day under ${zone}`)
      } finally {
        if (original === undefined) delete process.env.TZ
        else process.env.TZ = original
      }
    }
  })

  it('returns undefined for anything that is not a plain date', () => {
    // undefined rather than a bogus date: the caller then shows the raw string
    // instead of inventing a day, so a future date format cannot vanish silently.
    assert.equal(parsePlainDate(''), undefined)
    assert.equal(parsePlainDate(undefined), undefined)
    assert.equal(parsePlainDate(null), undefined)
    assert.equal(parsePlainDate('2026/09/11'), undefined)
    assert.equal(parsePlainDate('unknown'), undefined)
    assert.equal(parsePlainDate('2026-09-11T00:00:00Z'), undefined)
  })

  it('tolerates surrounding whitespace', () => {
    const date = parsePlainDate('  2026-09-11  ')
    assert.ok(date)
    assert.equal(date.getDate(), 11)
  })

  it('handles a leap day', () => {
    // A naive implementation that lets the Date constructor roll over would turn
    // 2024-02-29 into 2024-03-01 in a non-leap year; this pins the real value.
    const date = parsePlainDate('2024-02-29')
    assert.ok(date)
    assert.equal(date.getMonth(), 1)
    assert.equal(date.getDate(), 29)
  })
})
