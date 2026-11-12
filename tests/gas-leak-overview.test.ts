import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { isGasLeakMonitor } from '../src/shared/domain/gas-leak'

describe('gas leak profile', () => {
  it('recognises AO01 only', () => {
    assert.equal(isGasLeakMonitor({ kind: 'acousticBox', name: 'AO01' }), true)
    assert.equal(isGasLeakMonitor({ kind: 'acousticBox', name: 'AE08' }), false)
    assert.equal(isGasLeakMonitor({ kind: 'acousticCamera', name: 'AO01' }), false)
  })
})

import fs from 'node:fs'
import path from 'node:path'
import { zhCN } from '../src/shared/i18n/messages/zh-CN'
import { zhTW } from '../src/shared/i18n/messages/zh-TW'
import { en } from '../src/shared/i18n/messages/en'
import { es } from '../src/shared/i18n/messages/es'
import { ru } from '../src/shared/i18n/messages/ru'
import { tr } from '../src/shared/i18n/messages/tr'

const projectRoot = path.resolve(__dirname, '..', '..')
function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}
const CATALOGUES = { 'zh-CN': zhCN, 'zh-TW': zhTW, en, es, ru, tr }
const REQUIRED_KEYS = ['title','badge','noLiveStream','alarmCount','latestAlarm','none','channels','sync','syncing','synced','syncFailed','goRecordings'] as const

describe('gas leak UI wiring', () => {
  it('MonitorView uses GasLeakMonitorPanel', () => {
    const monitor = read('src/renderer/src/views/MonitorView.vue')
    assert.match(monitor, /const isGasLeak = computed/)
    assert.match(monitor, /<GasLeakMonitorPanel :device-id="selectedDeviceId" :channels="channels" \/>/)
    assert.match(monitor, /<template v-else-if="isGasLeak">/)
  })

  it('panel uses recordings.syncDevice and MonitorRecordingTimeline', () => {
    const panel = read('src/renderer/src/components/GasLeakMonitorPanel.vue')
    assert.match(panel, /window\.api\.recordings\.syncDevice\(props\.deviceId\)/)
    assert.match(panel, /MonitorRecordingTimeline/)
    assert.match(panel, /data-gas-leak-panel/)
  })

  it('all six catalogues have the keys and placeholders', () => {
    for (const [locale, catalogue] of Object.entries(CATALOGUES)) {
      const gasLeak = (catalogue as unknown as Record<string, Record<string, unknown>>).gasLeakUi
      assert.ok(gasLeak, `${locale} missing gasLeakUi`)
      for (const key of REQUIRED_KEYS) {
        assert.equal(typeof gasLeak[key], 'string', `${locale} missing ${key}`)
        assert.ok(String(gasLeak[key]).trim() !== '', `${locale} empty ${key}`)
      }
      assert.deepEqual(String(gasLeak.synced).match(/\{(\w+)\}/g) ?? [], ['{count}'])
      assert.deepEqual(String(gasLeak.syncFailed).match(/\{(\w+)\}/g) ?? [], ['{reason}'])
    }
  })
})
