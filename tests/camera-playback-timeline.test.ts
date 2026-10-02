/**
 * S3 第一刀：相机本机录像时间轴 + 跨片段续播 + 缺口如实提示。
 *
 * 内核几何由 `playbackTimeline.ts` / `recordingTimeline.ts` 的单测覆盖；这里
 * 钉住的是接线：弹窗必须用时间轴、必须在 `ended` 时找下一段、大缺口必须停下来说，
 * 组件不能自己把空白画成「有录像」。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { zhCN } from '../src/shared/i18n/messages/zh-CN'
import { zhTW } from '../src/shared/i18n/messages/zh-TW'
import { en } from '../src/shared/i18n/messages/en'
import { ru } from '../src/shared/i18n/messages/ru'
import { es } from '../src/shared/i18n/messages/es'
import { tr } from '../src/shared/i18n/messages/tr'

const projectRoot = path.resolve(__dirname, '..', '..')
function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

const dialog = read('src/renderer/src/components/CameraRecordingPlaybackDialog.vue')
const timeline = read('src/renderer/src/components/VideoPlaybackTimeline.vue')

const CATALOGUES = { 'zh-CN': zhCN, 'zh-TW': zhTW, en, ru, es, tr } as const
const KEYS = ['playbackTimeline', 'playbackGap', 'playbackContinueNext', 'playbackLastSegment'] as const

describe('S3 相机回放：时间轴与跨片段续播', () => {
  it('弹窗渲染时间轴，并在视频 ended 时找下一段', () => {
    assert.ok(dialog.includes('<VideoPlaybackTimeline'), 'dialog does not render the timeline')
    assert.ok(dialog.includes('@ended="onVideoEnded"'), 'video has no ended handler')
    assert.ok(dialog.includes('@timeupdate="onVideoTimeUpdate"'), 'video has no timeupdate cursor')
    assert.ok(dialog.includes('nextSegmentStep('), 'dialog does not use the sequence helper')
    assert.ok(dialog.includes('AUTO_ADVANCE_GAP_TOLERANCE_MS'), 'no gap tolerance constant')
    assert.ok(dialog.includes('playbackGap'), 'large gap is not surfaced')
    assert.ok(dialog.includes('playbackContinueNext'), 'no explicit skip-over-gap action')
    assert.ok(dialog.includes('@loadedmetadata="onVideoLoadedMetadata"'), 'alarm seek is not wired')
    assert.ok(dialog.includes(':alarms="alarms"'), 'dialog does not pass alarm markers')
    assert.ok(dialog.includes(':trend-points="trendPoints"'), 'dialog does not pass trend points')
    assert.ok(dialog.includes('@alarm="jumpToAlarm"'), 'alarm marker has no jump handler')
    assert.ok(dialog.includes('window.api.alarms.query('), 'dialog does not query alarms')
    assert.ok(dialog.includes('window.api.trends.query('), 'dialog does not query trend data')
    assert.ok(dialog.includes('segmentForTime('), 'alarm jump does not use the segment resolver')
  })

  it('时间轴只画段和缺口，不自己造有录像的假象', () => {
    assert.ok(timeline.includes('placeSegments('), 'timeline does not use shared geometry')
    assert.ok(timeline.includes('ticksFor('), 'timeline has no time ticks')
    assert.ok(timeline.includes('timelineWindow('), 'timeline does not compute its window from segments')
    assert.ok(timeline.includes("emit('select'"), 'timeline does not expose segment selection')
    assert.ok(timeline.includes('vpt__segment'), 'timeline has no segment elements')
    assert.ok(timeline.includes('alarmMarks'), 'timeline does not render alarm markers')
    assert.ok(timeline.includes('trendMarks'), 'timeline does not render trend marks')
    assert.ok(timeline.includes("emit('alarm'"), 'timeline does not emit alarm clicks')
    assert.ok(timeline.includes('zoomWindow('), 'timeline cannot zoom')
    assert.ok(timeline.includes('panWindow('), 'timeline cannot pan')
  })

  it('六语言都有缺口/时间轴文案，占位符一致', () => {
    function placeholders(value: string): string[] {
      return [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort()
    }
    const catalogues = Object.entries(CATALOGUES)
    const reference = (CATALOGUES['zh-CN'] as { cameraNvrUi: Record<string, string> }).cameraNvrUi
    for (const key of KEYS) assert.equal(typeof reference[key], 'string', `zh-CN cameraNvrUi.${key} missing`)

    for (const [locale, catalogue] of catalogues) {
      const block = (catalogue as { cameraNvrUi: Record<string, string> }).cameraNvrUi
      for (const key of KEYS) {
        const value: string = block[key] ?? ''
        assert.equal(typeof value, 'string', `${locale} cameraNvrUi.${key} missing`)
        assert.equal(
          placeholders(value).join(','),
          placeholders(reference[key] ?? '').join(','),
          `${locale} cameraNvrUi.${key} placeholder mismatch`
        )
      }
    }
  })
})