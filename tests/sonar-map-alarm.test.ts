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

  it('embeds the device-location map inside the Auscultation Box detail card', () => {
    const map = read('src/renderer/src/components/DeviceLocationMap.vue')
    assert.match(map, /data-device-location-map/)
    assert.match(map, /data-device-location-tiles/)
    assert.match(map, /viewTiles/)
    assert.match(map, /offsetMapPoint/)
    assert.match(map, /alarmHorizontal/)
    const card = read('src/renderer/src/components/DeviceInstallationCard.vue')
    assert.match(card, /showMap\?: boolean/)
    assert.match(card, /<DeviceLocationMap/)
    const detail = read('src/renderer/src/views/DeviceDetailView.vue')
    assert.match(detail, /:show-map="device\.kind === 'auscultationBox'"/)
  })
  it('associates the selected device location map with Live monitoring', () => {
    const monitor = read('src/renderer/src/views/MonitorView.vue')
    assert.match(monitor, /import DeviceLocationMap/)
    const uses = monitor.match(/<DeviceLocationMap/g) ?? []
    assert.ok(uses.length >= 3, 'camera / voiceprint / gas-leak branches should embed the map')
  })

  it('explains and can repair the Live monitoring gaps for SN-16', () => {
    const panel = read('src/renderer/src/components/SonarOverviewPanel.vue')
    assert.match(panel, /data-sonar-enable-callback/)
    assert.match(panel, /setRealtimeCallback/)
    assert.match(panel, /data-sonar-sync-recordings/)
    assert.match(panel, /latestAlarmDirection/)
    assert.match(panel, /sonarUi\.realtimeOff/)
    assert.match(panel, /localRecordingContainer !== undefined/)
  })
  it('does not surface a single device AUTH_FAILED as a global Settings notice', () => {
    const store = read('src/renderer/src/stores/devices.ts')
    assert.match(store, /READ_ERROR_IDS\.status, result\.error\?\.code === 'AUTH_FAILED'/)
    assert.match(store, /READ_ERROR_IDS\.channels, result\.error\?\.code === 'AUTH_FAILED'/)
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
      const installUi = (catalogue as unknown as Record<string, Record<string, unknown>>).installUi
      assert.ok(installUi)
      for (const key of ['mapNoPoint', 'mapHint', 'openMap', 'mapRange', 'mapDirection', 'mapNoAzimuth']) {
        assert.equal(typeof installUi[key], 'string', `${locale} missing installUi.${key}`)
      }
      const sonarUi = (catalogue as unknown as Record<string, Record<string, unknown>>).sonarUi
      assert.ok(sonarUi)
      for (const key of ['realtimeOff', 'enableRealtime', 'waitingRealtime', 'fromLatestAlarm', 'syncRecordings', 'syncingRecordings', 'recordSyncDone']) {
        assert.equal(typeof sonarUi[key], 'string', `${locale} missing sonarUi.${key}`)
      }
      const e2Ui = (catalogue as unknown as Record<string, Record<string, unknown>>).e2Ui
      assert.ok(e2Ui)
      assert.equal(typeof e2Ui.outcomeDbThreshold, 'string', `${locale} missing outcomeDbThreshold`)
    }
  })
})
