import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { openDatabase } from '../src/main/services/database/schema'
import { DeviceRepository } from '../src/main/services/database/device-repository'
import { AlarmRepository } from '../src/main/services/database/alarm-repository'
import { AlarmService } from '../src/main/services/alarm/alarm-service'

const projectRoot = path.resolve(__dirname, '..', '..')
function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

describe('gas-leak alarm integration', () => {
  it('records AO01 alerts as unacknowledged critical alarms (map red + notice)', () => {
    const db = openDatabase({ file: ':memory:' })
    try {
      const devices = new DeviceRepository(db)
      const { device } = devices.insertPushDevice({
        ip: '',
        httpPort: 0,
        username: '',
        password: '',
        kind: 'pushDevice',
        name: 'AO01',
        installation: { gisLatitude: 31.2, gisLongitude: 121.4 }
      })
      const service = new AlarmService({ alarms: new AlarmRepository(db) })
      const first = service.recordGasLeakAlarm({
        deviceId: device.id,
        channelId: 0,
        timestamp: 1_800_000_000_000,
        alertId: 43,
        raw: '{"dalId":43,"dalAbnoType":1}'
      })
      assert.equal(first.created, true)
      const duplicate = service.recordGasLeakAlarm({
        deviceId: device.id,
        channelId: 0,
        timestamp: 1_800_000_000_000,
        alertId: 43
      })
      assert.equal(duplicate.created, false)
      const page = service.query({ deviceId: device.id, acknowledged: false })
      assert.equal(page.total, 1)
      const alarm = page.items[0]
      assert.ok(alarm)
      assert.equal(alarm.alarmMask, 0)
      assert.equal(alarm.severity, 'critical')
      assert.equal(alarm.acknowledged, false)
    } finally {
      db.close()
    }
  })

  it('polls AO01 alertArray through the same linkage pipeline', () => {
    const deviceService = read('src/main/services/device/device-service.ts')
    assert.match(deviceService, /gasLeakAlerts\(deviceId: string\)/)
    assert.match(deviceService, /queryAlarmAudio/)
    assert.match(deviceService, /extractAlarmAudio/)
    assert.match(deviceService, /detectMode: 2/)
    const poll = read('src/main/services/linkage/detect-logs-poll-source.ts')
    assert.match(poll, /isGasLeakMonitor/)
    const linkage = read('src/main/services/linkage/alarm-linkage-service.ts')
    assert.match(linkage, /recordGasLeakAlarm/)
    assert.match(linkage, /candidate\.detectMode === 2/)
    const map = read('src/renderer/src/views/DeviceMapView.vue')
    assert.match(map, /onLinkagePending/)
  })

  it('recordings row icon is a real play button and selecting reloads playback', () => {
    const view = read('src/renderer/src/views/RecordingsView.vue')
    assert.match(view, /const playerNonce = ref\(0\)/)
    assert.match(view, /playerNonce\.value \+= 1/)
    assert.match(view, /class="recording-row__icon"/)
    assert.match(view, /@click\.stop="openPlayer\(recording\)"/)
    assert.match(view, /:auto-load="playerAutoPlay"/)
  })
})
