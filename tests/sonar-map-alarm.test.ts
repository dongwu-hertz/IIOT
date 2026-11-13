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
    assert.match(map, /SONAR_SPREAD_DEG = 0\.5/)
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
    assert.match(detail, /:show-map="false"/)
    assert.doesNotMatch(detail, /device\\.kind === 'auscultationBox'/)
  })
  it('associates the selected device location map with Live monitoring', () => {
    const monitor = read('src/renderer/src/views/MonitorView.vue')
    assert.match(monitor, /import DeviceLocationMap/)
    const uses = monitor.match(/<DeviceLocationMap/g) ?? []
    assert.ok(uses.length >= 1, 'gas-leak branch should embed the map')
    const sonar = read('src/renderer/src/components/SonarOverviewPanel.vue')
    assert.match(sonar, /<DeviceLocationMap/)
    assert.match(sonar, /sector-width-deg="1"/)
  })

  it('explains and can repair the Live monitoring gaps for SN-16', () => {
    const panel = read('src/renderer/src/components/SonarOverviewPanel.vue')
    const monitor = read('src/renderer/src/views/MonitorView.vue')
    assert.match(panel, /data-sonar-sync-recordings/)
    assert.match(panel, /data-sonar-live-audio/)
    assert.match(panel, /data-sonar-ptz-preview/)
    assert.match(panel, /data-sonar-device-info/)
    assert.match(monitor, /data-sonar-settings-toggle/)
    assert.match(panel, /data-sonar-settings-panel/)
    assert.doesNotMatch(monitor, /data-sonar-view-toggle/)
    assert.match(panel, /data-sonar-ptz-mode-toggle/)
    assert.match(panel, /data-sonar-compass/)
    assert.match(panel, /data-sonar-calibration-input/)
    assert.match(panel, /sonar-device__audio-toolbar/)
    assert.match(panel, /data-sonar-audio-channel/)
    assert.doesNotMatch(panel, /data-sonar-device-status/)
    assert.match(panel, /data-sonar-alarm-detail/)
    assert.match(panel, /selectedDirection/)
    assert.match(panel, /calibratedDirectionOf/)
    assert.match(panel, /RecordingPlayer/)
    assert.doesNotMatch(panel, /data-sonar-history-apply/)
    assert.match(panel, /data-sonar-ptz-camera/)
    assert.doesNotMatch(panel, /sonar-map-preview-grid/)
    assert.match(panel, /startAudio\(props\.deviceId, audioChannel\.value\)/)
    assert.match(monitor, /channel-tabs--header/)
    assert.match(monitor, /monitor-head__status--voiceprint/)
    assert.match(monitor, /selectedDevice\?\.kind === 'acousticBox'/)
    assert.doesNotMatch(monitor, /data-monitor-session-badge/)
    assert.doesNotMatch(panel, /activeView/)
    const locationMap = read('src/renderer/src/components/DeviceLocationMap.vue')
    assert.match(locationMap, /data-location-zoom-in/)
    assert.match(locationMap, /data-location-auto/)
    assert.match(locationMap, /data-device-location-empty><\/div>/)
    assert.doesNotMatch(locationMap, /installUi\.mapNoPoint/)
    assert.doesNotMatch(locationMap, /installUi\.mapHint/)
    assert.match(panel, /startAudio/)
    const audioService = read('src/main/services/device/e2/e2-audio-stream-service.ts')
    assert.match(audioService, /audio_stream/)
    assert.match(audioService, /getInt16/)
    assert.match(panel, /calibratedDirectionOf/)
    assert.match(panel, /localRecordingContainer !== undefined/)
  })
  it('does not surface a single device AUTH_FAILED as a global Settings notice', () => {
    const store = read('src/renderer/src/stores/devices.ts')
    assert.match(store, /READ_ERROR_IDS\.status, result\.error\?\.code === 'AUTH_FAILED'/)
    assert.match(store, /READ_ERROR_IDS\.channels, result\.error\?\.code === 'AUTH_FAILED'/)
  })
  it('feeds SN-16 realtime SPL into trends and refreshes the curve', () => {
    const app = read('src/main/services/app-services.ts')
    assert.match(app, /iotIngest\.on\('e2-realtime'/)
    assert.match(app, /trends\.append\(deviceUid/)
    assert.match(app, /e2TrendLastFlushAt/)
    const query = read('src/main/services/trend/trend-query-service.ts')
    assert.match(query, /safeStorageSegment\(deviceUid\)/)
    const e2 = read('src/main/services/device/e2/e2-device-service.ts')
    assert.match(e2, /typeof value === 'boolean'/)
    const trends = read('src/renderer/src/views/TrendsView.vue')
    assert.match(trends, /startLiveRefresh/)
    assert.match(trends, /3_000/)
  })

  it('uses the real GIS map in Live monitoring and the Device location card', () => {
    const panel = read('src/renderer/src/components/SonarOverviewPanel.vue')
    assert.match(panel, /<DeviceLocationMap/)
    assert.match(panel, /import DeviceLocationMap/)
    const live = read('src/renderer/src/views/MonitorView.vue')
    assert.doesNotMatch(live, /:show-map="true"/)
    assert.match(live, /SonarOverviewPanel/)
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
