/**
 * Tests for the alarm bit-mask decoder (spec appendix B).
 *
 * This is the highest-value unit test in the project: the bit taxonomy is
 * safety-relevant (an operator reads these labels to judge a power transformer),
 * it is used by every alarm surface in the UI, and the spec mandates that it
 * exist in exactly one place.
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  ALARM_BIT_MASKS,
  ALARM_MASK_BITS,
  alarmTypeKey,
  decodeAlarmMask,
  hasAlarmType,
  primaryAlarmType,
  unknownAlarmBits
} from '../src/shared/domain/alarm-mask'
import { AlarmType, ALARM_TYPE_KEYS } from '../src/shared/domain/models'

describe('decodeAlarmMask', () => {
  it('returns an empty list for a zero mask', () => {
    assert.deepEqual(decodeAlarmMask(0), [])
  })

  it('decodes a single bit', () => {
    assert.deepEqual(decodeAlarmMask(1), [AlarmType.SPL])
    assert.deepEqual(decodeAlarmMask(1 << 13), [AlarmType.DCBias])
  })

  it('decodes multiple bits in ascending order regardless of input order', () => {
    // Bit0 (SPL) + Bit2 (Band Energy Ratio) + Bit7 (Overload)
    const mask = (1 << 0) | (1 << 2) | (1 << 7)
    assert.deepEqual(decodeAlarmMask(mask), [
      AlarmType.SPL,
      AlarmType.BandEnergyRatio,
      AlarmType.Overload
    ])
  })

  it('decodes every defined bit individually', () => {
    for (let bit = 0; bit < ALARM_MASK_BITS; bit += 1) {
      const decoded = decodeAlarmMask(1 << bit)
      assert.equal(decoded.length, 1, `bit ${bit} should decode to exactly one type`)
      assert.equal(decoded[0], bit)
    }
  })

  it('decodes the full mask to all 14 defined types', () => {
    const full = (1 << ALARM_MASK_BITS) - 1
    assert.equal(decodeAlarmMask(full).length, ALARM_MASK_BITS)
  })

  it('ignores undefined high bits rather than inventing types', () => {
    // Bit 20 is outside the V1 taxonomy.
    assert.deepEqual(decodeAlarmMask(1 << 20), [])
  })

  it('survives hostile input', () => {
    assert.deepEqual(decodeAlarmMask(-1), [])
    assert.deepEqual(decodeAlarmMask(Number.NaN), [])
    assert.deepEqual(decodeAlarmMask(Number.POSITIVE_INFINITY), [])
  })

  it('truncates a fractional mask instead of throwing', () => {
    assert.deepEqual(decodeAlarmMask(1.9), [AlarmType.SPL])
  })
})

describe('hasAlarmType', () => {
  it('tests a single bit without decoding', () => {
    const mask = (1 << 1) | (1 << 9)
    assert.equal(hasAlarmType(mask, AlarmType.MainFrequency), true)
    assert.equal(hasAlarmType(mask, AlarmType.SurfaceDischarge), true)
    assert.equal(hasAlarmType(mask, AlarmType.SPL), false)
  })

  it('is false for an empty mask', () => {
    assert.equal(hasAlarmType(0, AlarmType.SPL), false)
  })
})

describe('unknownAlarmBits', () => {
  it('reports bits above the defined taxonomy', () => {
    // Bit0 is known, Bit14 and Bit15 are not.
    const mask = (1 << 0) | (1 << 14) | (1 << 15)
    assert.deepEqual(unknownAlarmBits(mask), [14, 15])
  })

  it('returns nothing when the mask is fully understood', () => {
    assert.deepEqual(unknownAlarmBits(1 | 2 | 4), [])
  })
})

describe('primaryAlarmType', () => {
  it('picks the lowest set bit', () => {
    const mask = (1 << 3) | (1 << 0)
    assert.equal(primaryAlarmType(mask), AlarmType.SPL)
  })

  it('is undefined for an empty mask', () => {
    assert.equal(primaryAlarmType(0), undefined)
  })
})

describe('alarm keys', () => {
  const types = Object.values(AlarmType).filter(
    (value): value is AlarmType => typeof value === 'number'
  )

  it('has a stable key for every type', () => {
    for (const type of types) {
      assert.match(alarmTypeKey(type), /^[a-z_]+$/, `bad key for bit ${type}`)
    }
  })

  it('does not produce duplicate keys', () => {
    const keys = new Set(types.map((type) => alarmTypeKey(type)))
    assert.equal(keys.size, types.length)
  })

  it('is total over the taxonomy', () => {
    // A widened enum must be a type error here, not a blank cell in the UI: the
    // `Record<AlarmType, string>` annotation on ALARM_TYPE_KEYS is what enforces
    // that, and this assertion pins it at runtime too.
    for (const type of types) {
      assert.equal(typeof ALARM_TYPE_KEYS[type], 'string', `no key for bit ${type}`)
    }
  })
})

/**
 * NOTE: there is deliberately no label test here.
 *
 * Rendering a mask to text used to live in this module as a Chinese sentence
 * ("声压级异常 + 主频异常"), which made it impossible to show an English or
 * Turkish UI. Labels now come from the catalogues via `alarmTypeKey()`; the
 * guarantee that every bit has a localised name was moved to
 * `tests/i18n.test.ts` ("names every domain enum value"), where it covers all
 * four languages instead of one.
 */

describe('bit mask table', () => {
  it('assigns each type a distinct power-of-two mask', () => {
    const masks = Object.values(ALARM_BIT_MASKS)
    for (const mask of masks) {
      assert.equal(mask & (mask - 1), 0, `${mask} is not a power of two`)
    }
    assert.equal(new Set(masks).size, masks.length)
  })
})
