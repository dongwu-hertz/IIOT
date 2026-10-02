/**
 * 告警文案里的「泄漏量 / 泄漏价格」取舍（`lib/linkageText.ts`）。
 *
 * WHY THIS FILE EXISTS
 * 设备在局放/机械记录里会把 `data_1`（泄漏量）写成占位 0。本机 2026-10-03 的
 * `pending-alarms.json` 里，200 条历史联动记录有 147 条没有 `detect_mode` 的局放
 * 记录全部带着 `leakVolume: 0` —— 告警中心与铃铛面板因此显示「泄漏量 0」，
 * 看起来像在局放模式下报了漏气。规则只有一份（`leakMetricsForMode`），
 * 这里钉住展示端：占位的 0 不说，真实非零读数不丢，泄漏模式原样显示。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import type { PendingAlarmRecord } from '../src/shared/domain/alarm-linkage'
import { linkageMetricsText } from '../src/renderer/src/lib/linkageText'

/** 目录替身：只保留这几条断言用得到的键；未登记的键原样返回（能一眼看出漏配）。 */
const t = (key: string, params?: Record<string, unknown>): string => {
  const table: Record<string, string> = {
    'linkage.metricIntensity': '声场强度 {value} dB',
    'linkage.metricDf': '主频 {value} Hz',
    'linkage.metricVolume': '泄漏量 {value}',
    'linkage.metricLeakCost': '泄漏价格 {value}'
  }
  return (table[key] ?? key).replace('{value}', String(params?.value ?? ''))
}

function record(overrides: Partial<PendingAlarmRecord> = {}): PendingAlarmRecord {
  return {
    eventId: 'cam-1:1:1',
    deviceId: 'cam-1',
    deviceName: 'Acoustic Camera',
    at: 1_000,
    observedAt: 1_000,
    source: 'poll',
    actions: [],
    acknowledged: true,
    ...overrides
  }
}

describe('linkageMetricsText：泄漏量的显示取舍', () => {
  it('模式未知（老固件不回 detect_mode）时，占位的 0 不说成「泄漏量 0」', () => {
    const text = linkageMetricsText(t, record({ metrics: { soundmapIntensity: 26.45, leakVolume: 0 } }))
    assert.equal(text, '声场强度 26.45 dB')
    assert.ok(!text.includes('泄漏量'))
  })

  it('模式未知时非零读数保留 —— 老固件真实的泄漏记录不能丢', () => {
    const text = linkageMetricsText(t, record({ metrics: { leakVolume: 4.5, leakCost: 3 } }))
    assert.ok(text.includes('泄漏量 4.5'))
    assert.ok(text.includes('泄漏价格 3'))
  })

  it('模式明确是局放/机械时，data_1 再大也不当泄漏量显示', () => {
    for (const mode of [1, 3]) {
      const text = linkageMetricsText(
        t,
        record({ detectMode: mode, metrics: { alarmDb: 42, leakVolume: 5 } })
      )
      assert.ok(!text.includes('泄漏量'), `mode=${mode} 不应显示泄漏量`)
      assert.ok(text.includes('声场强度 42'), `mode=${mode} 的声场强度仍要显示`)
    }
  })

  it('泄漏模式（2）原样显示设备的读数，包括 0', () => {
    const text = linkageMetricsText(t, record({ detectMode: 2, metrics: { leakVolume: 0, leakCost: 0 } }))
    assert.equal(text, '泄漏量 0，泄漏价格 0')
  })
})