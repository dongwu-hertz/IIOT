import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  latToWorldY,
  lonToWorldX,
  panMapCenter,
  worldXToLon,
  worldYToLat
} from '../src/shared/domain/map-tiles'
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

describe('map point picker', () => {
  it('Web Mercator round-trips a picked point', () => {
    const latitude = 31.2304
    const longitude = 121.4737
    const zoom = 14
    const x = lonToWorldX(longitude, zoom)
    const y = latToWorldY(latitude, zoom)
    assert.ok(Math.abs(worldXToLon(x, zoom) - longitude) < 1e-9)
    assert.ok(Math.abs(worldYToLat(y, zoom) - latitude) < 1e-6)
    const moved = panMapCenter({ latitude, longitude, zoom }, 120, 40)
    assert.notEqual(moved.longitude, longitude)
    assert.notEqual(moved.latitude, latitude)
  })

  it('picker reuses the map-tiles projection and never fetches directly', () => {
    const picker = read('src/renderer/src/components/MapPointPicker.vue')
    assert.match(picker, /viewTiles\(/)
    assert.match(picker, /projectToViewport\(/)
    assert.match(picker, /worldXToLon\(/)
    assert.match(picker, /worldYToLat\(/)
    assert.match(picker, /panMapCenter\(/)
    assert.match(picker, /@pointerdown="onPointerDown"/)
    assert.match(picker, /@contextmenu\.prevent="onContextMenu"/)
    assert.doesNotMatch(picker, /\bfetch\s*\(/)
    assert.doesNotMatch(picker, /XMLHttpRequest/)
  })

  it('both add and edit dialogs expose the map picker button', () => {
    for (const file of [
      'src/renderer/src/views/DevicesView.vue',
      'src/renderer/src/components/AddDeviceDialog.vue'
    ]) {
      const source = read(file)
      assert.match(source, /import MapPointPicker from '@renderer\/components\/MapPointPicker\.vue'/, file)
      assert.match(source, /data-action="pick-device-point"/, file)
      assert.match(source, /<MapPointPicker/, file)
    }
  })

  it('all six catalogues have the picker keys', () => {
    const catalogues = { 'zh-CN': zhCN, 'zh-TW': zhTW, en, es, ru, tr }
    const keys = ['title', 'hint', 'offlineHint', 'selected', 'zoomIn', 'zoomOut', 'confirm', 'pickButton']
    for (const [locale, catalogue] of Object.entries(catalogues)) {
      const picker = (catalogue as unknown as Record<string, Record<string, unknown>>).mapPickerUi
      assert.ok(picker, `${locale} missing mapPickerUi`)
      for (const key of keys) {
        assert.equal(typeof picker[key], 'string', `${locale} missing mapPickerUi.${key}`)
        assert.ok(String(picker[key]).trim() !== '', `${locale} empty mapPickerUi.${key}`)
      }
    }
  })
})
