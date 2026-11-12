import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

const projectRoot = path.resolve(__dirname, '..', '..')
function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

describe('alarm UI fixes', () => {
  it('map alarm points blink and the selected panel lists channel + time', () => {
    const map = read('src/renderer/src/views/DeviceMapView.vue')
    assert.match(map, /data-marker-blink/)
    assert.match(map, /@keyframes map-alarm-blink/)
    assert.match(map, /data-map-alarm-list/)
    assert.match(map, /t\('alarmsUi\.columnChannel'\)/)
    assert.match(map, /formatDateTime\(alarm\.timestamp\)/)
  })

  it('top-right alarm panel closes on route change or outside pointerdown', () => {
    const panel = read('src/renderer/src/components/AlarmLinkagePanel.vue')
    assert.match(panel, /route\.fullPath/)
    assert.match(panel, /onDocumentPointerDown/)
    assert.match(panel, /removeEventListener\('pointerdown'/)
  })

  it('AO01 alarm profile hides the SPL group', () => {
    const section = read('src/renderer/src/components/device-config/AlarmProfileSection.vue')
    assert.match(section, /hideSpl\?: boolean/)
    assert.match(section, /v-if="!hideSpl"/)
    assert.match(section, /if \(!props\.hideSpl\)/)
    const detail = read('src/renderer/src/views/DeviceDetailView.vue')
    assert.match(detail, /:hide-spl="isGasLeakDevice"/)
    assert.match(detail, /isGasLeakMonitor/)
  })

  it('camera alarm configuration retries a transient auth failure once', () => {
    const dialog = read('src/renderer/src/components/CameraAlarmDialog.vue')
    assert.match(dialog, /strategyResult\.error\?\.code === 'AUTH_FAILED'/)
    assert.match(dialog, /conditionResult\.error\?\.code === 'AUTH_FAILED'/)
    assert.match(dialog, /setTimeout\(resolve, 300\)/)
    assert.doesNotMatch(dialog, /const \[strategyResult, conditionResult\] = await Promise\.all/)
  })
})
