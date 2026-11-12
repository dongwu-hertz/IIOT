import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { openDatabase } from '../src/main/services/database/schema'
import { DeviceRepository } from '../src/main/services/database/device-repository'
import { parseInstallation } from '../src/shared/domain/device-installation'
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

describe('floor plan deployment', () => {
  it('parses normalized floor coordinates and rejects out-of-range values', () => {
    const ok = parseInstallation({ floorX: '0.25', floorY: 0.75 })
    assert.equal(ok.ok, true)
    assert.deepEqual(ok.installation, { floorX: 0.25, floorY: 0.75 })
    assert.equal(parseInstallation({ floorX: -0.1 }).ok, false)
    assert.equal(parseInstallation({ floorY: 1.1 }).ok, false)
  })

  it('persists floor coordinates through the repository and clears with null', () => {
    const db = openDatabase({ file: ':memory:' })
    try {
      const repo = new DeviceRepository(db)
      const { device } = repo.insertPushDevice({
        ip: '',
        httpPort: 0,
        username: '',
        password: '',
        kind: 'pushDevice',
        name: 'floor-plan-device',
        installation: { floorX: 0.2, floorY: 0.3 }
      })
      assert.equal(device.installation?.floorX, 0.2)
      assert.equal(device.installation?.floorY, 0.3)
      const moved = repo.update({
        id: device.id,
        installation: { floorX: 0.8, floorY: 0.6 }
      })
      assert.equal(moved?.installation?.floorX, 0.8)
      assert.equal(moved?.installation?.floorY, 0.6)
      const cleared = repo.update({
        id: device.id,
        installation: { floorX: null, floorY: null }
      })
      assert.equal(cleared?.installation?.floorX, undefined)
      assert.equal(cleared?.installation?.floorY, undefined)
    } finally {
      db.close()
    }
  })

  it('has schema v21 and a floor-plan image store with no network fetch', () => {
    const schema = read('src/main/services/database/schema.ts')
    assert.match(schema, /version: 21/)
    assert.match(schema, /device-floor-position/)
    const store = read('src/renderer/src/lib/floorPlanStore.ts')
    assert.match(store, /indexedDB/)
    assert.doesNotMatch(store, /\bfetch\s*\(/)
    assert.doesNotMatch(store, /XMLHttpRequest/)
  })

  it('map page supports importing and dragging floor-plan devices and auto-fitting GIS', () => {
    const map = read('src/renderer/src/views/DeviceMapView.vue')
    assert.match(map, /loadFloorPlan\(/)
    assert.match(map, /data-map-floor-plan-image/)
    assert.match(map, /data-action="import-floor-plan"/)
    assert.match(map, /onMarkerPointerDown/)
    assert.match(map, /onFloorPointerUp/)
    assert.match(map, /fitAllDevices/)
    assert.match(map, /onLinkagePending/)
  })

  it('all six catalogues have floor-plan and fit-all labels', () => {
    const catalogues = { 'zh-CN': zhCN, 'zh-TW': zhTW, en, es, ru, tr }
    const keys = ['importButton', 'replaceButton', 'removeButton', 'modeFloor', 'modeGis', 'dragHint', 'imported', 'importFailed', 'storageFailed', 'removed', 'saved', 'saveFailed']
    for (const [locale, catalogue] of Object.entries(catalogues)) {
      const floorPlan = (catalogue as unknown as Record<string, Record<string, unknown>>).floorPlanUi
      assert.ok(floorPlan, `${locale} missing floorPlanUi`)
      for (const key of keys) {
        assert.equal(typeof floorPlan[key], 'string', `${locale} missing floorPlanUi.${key}`)
        assert.ok(String(floorPlan[key]).trim() !== '', `${locale} empty floorPlanUi.${key}`)
      }
      const mapUi = (catalogue as unknown as Record<string, Record<string, unknown>>).mapUi
      assert.ok(mapUi, `${locale} missing mapUi`)
      assert.equal(typeof mapUi.fitAll, 'string', `${locale} missing mapUi.fitAll`)
    }
  })
})
