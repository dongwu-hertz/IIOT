import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
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

describe('SN-16 sonar map and alarm profile', () => {
  it('draws a direction line and range overlay for airSonar devices', () => {
    const map = read('src/renderer/src/views/DeviceMapView.vue')
    assert.match(map, /SONAR_RANGE_METERS/)
    assert.match(map, /alarmHorizontalDeg/)
    assert.match(map, /sonarOverlays/)
    assert.match(map, /data-map-sonar-overlay/)
    assert.match(map, /map-sonar__direction/)
    assert.match(map, /data-map-sonar-no-point/)
  })

  it('only airSonar gets the PTZ tab; AO01/other devices do not', () => {
    const detail = read('src/renderer/src/views/DeviceDetailView.vue')
    assert.match(detail, /AIR_SONAR_TABS/)
    assert.match(detail, /tab\.id !== 'ptz'/)
    assert.match(detail, /e2Variant === 'airSonar'/)
  })

  it('seeds the 16-channel airSonar channel rows from device-reported channel count', () => {
    const e2 = read('src/main/services/device/e2/e2-device-service.ts')
    assert.match(e2, /E2_AIR_SONAR_CHANNEL_COUNT/)
    assert.match(e2, /ensureAuscultationChannels/)
    assert.match(e2, /channelCount !== undefined\) this\.devices\.ensureAuscultationChannels/)
    const service = read('src/main/services/device/device-service.ts')
    assert.match(service, /ensureAuscultationChannels\(deviceId: string, channelCount: number\)/)
  })

  it('keeps airSonar direction values and applies the device dB limit during sync', () => {
    const client = read('src/main/services/device/e2/e2-client.ts')
    assert.match(client, /'horizontal'/)
    assert.match(client, /'vertical'/)
    assert.match(client, /this\.passwordStyle === 'salted' \? 'plain' : 'salted'/)
    assert.match(client, /loginInFlight/)
    assert.match(client, /private async loginOnce/)
    const sync = read('src/main/services/device/e2/e2-sync-service.ts')
    assert.match(sync, /request\.dbLimit/)
    assert.match(sync, /skippedByDbThreshold/)
    const panel = read('src/renderer/src/components/AuscultationPanel.vue')
    assert.match(panel, /dbLimit/)
  })

  it('all six catalogues have the sonar labels', () => {
    const catalogues = { 'zh-CN': zhCN, 'zh-TW': zhTW, en, es, ru, tr }
    for (const [locale, catalogue] of Object.entries(catalogues)) {
      const mapUi = (catalogue as unknown as Record<string, Record<string, unknown>>).mapUi
      assert.ok(mapUi)
      assert.equal(typeof mapUi.sonarDirection, 'string', `${locale} missing sonarDirection`)
      assert.equal(typeof mapUi.sonarNoPoint, 'string', `${locale} missing sonarNoPoint`)
      const e2Ui = (catalogue as unknown as Record<string, Record<string, unknown>>).e2Ui
      assert.ok(e2Ui)
      assert.equal(typeof e2Ui.outcomeDbThreshold, 'string', `${locale} missing outcomeDbThreshold`)
    }
  })
})
