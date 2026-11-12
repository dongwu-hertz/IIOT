import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  DEVICE_ATTRIBUTE_MAX_COUNT,
  normaliseDepartment,
  normaliseDeviceAttributes,
  parseDeviceAttributes,
  serialiseDeviceAttributes
} from '../src/shared/domain/device-profile'
import { DeviceRepository } from '../src/main/services/database/device-repository'
import { openDatabase } from '../src/main/services/database/schema'
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

describe('device department and attributes', () => {
  it('trims department and drops blank values', () => {
    assert.equal(normaliseDepartment('  运维一部  '), '运维一部')
    assert.equal(normaliseDepartment('   '), undefined)
    assert.equal(normaliseDepartment(undefined), undefined)
    assert.equal(normaliseDepartment('x'.repeat(200))?.length, 100)
  })

  it('normalises attributes: blank keys, duplicates, trim, count cap', () => {
    const rows = normaliseDeviceAttributes([
      { key: '  资产编号 ', value: ' A-01 ' },
      { key: '资产编号', value: 'duplicate' },
      { key: '  ', value: 'ignored' },
      { key: '责任人', value: '张三' }
    ])
    assert.deepEqual(rows, [
      { key: '资产编号', value: 'A-01' },
      { key: '责任人', value: '张三' }
    ])

    const many = Array.from({ length: DEVICE_ATTRIBUTE_MAX_COUNT + 5 }, (_, index) => ({
      key: `k${index}`,
      value: `${index}`
    }))
    assert.equal(normaliseDeviceAttributes(many).length, DEVICE_ATTRIBUTE_MAX_COUNT)
  })

  it('parses bad JSON as empty; serialises empty as empty string', () => {
    assert.deepEqual(parseDeviceAttributes('not json'), [])
    assert.deepEqual(parseDeviceAttributes(''), [])
    assert.equal(serialiseDeviceAttributes([]), '')
    assert.equal(serialiseDeviceAttributes([{ key: '', value: 'x' }]), '')
    const encoded = serialiseDeviceAttributes([{ key: '资产编号', value: 'A-01' }])
    assert.deepEqual(parseDeviceAttributes(encoded), [{ key: '资产编号', value: 'A-01' }])
  })

  it('persists department/attributes through the repository and clears with null', () => {
    const db = openDatabase({ file: ':memory:' })
    try {
      const repo = new DeviceRepository(db)
      const { device } = repo.insertPushDevice({
        ip: '',
        httpPort: 0,
        username: '',
        password: '',
        kind: 'pushDevice',
        name: '测试设备',
        department: '  运维一部 ',
        attributes: [
          { key: '资产编号', value: 'A-01' },
          { key: '责任人', value: '张三' }
        ]
      })
      assert.equal(device.department, '运维一部')
      assert.deepEqual(device.attributes, [
        { key: '资产编号', value: 'A-01' },
        { key: '责任人', value: '张三' }
      ])

      const updated = repo.update({
        id: device.id,
        department: '生产部',
        attributes: [{ key: '资产编号', value: 'B-02' }]
      })
      assert.equal(updated?.department, '生产部')
      assert.deepEqual(updated?.attributes, [{ key: '资产编号', value: 'B-02' }])

      const cleared = repo.update({ id: device.id, department: null, attributes: null })
      assert.equal(cleared?.department, undefined)
      assert.equal(cleared?.attributes, undefined)
    } finally {
      db.close()
    }
  })

  it('device management edit dialog and detail card are wired', () => {
    const devicesView = read('src/renderer/src/views/DevicesView.vue')
    assert.match(devicesView, /data-device-department/)
    assert.match(devicesView, /data-device-attribute/)
    assert.match(devicesView, /normaliseDeviceAttributes/)
    assert.match(devicesView, /department: editForm\.value\.department\.trim\(\) \|\| null/)
    assert.match(devicesView, /attributes: normaliseDeviceAttributes\(editForm\.value\.attributes\)/)
    const detail = read('src/renderer/src/views/DeviceDetailView.vue')
    assert.match(detail, /DeviceProfileCard/)
    const schema = read('src/main/services/database/schema.ts')
    assert.match(schema, /version: 20/)
    assert.match(schema, /attributes_json/)
  })

  it('all six catalogues have the profile keys', () => {
    const catalogues = { 'zh-CN': zhCN, 'zh-TW': zhTW, en, es, ru, tr }
    const keys = ['profileSection', 'department', 'attributes', 'addAttribute', 'attributeKey', 'attributeValue', 'noAttributes']
    for (const [locale, catalogue] of Object.entries(catalogues)) {
      const devicesUi = (catalogue as unknown as Record<string, Record<string, unknown>>).devicesUi
      assert.ok(devicesUi, `${locale} missing devicesUi`)
      for (const key of keys) {
        assert.equal(typeof devicesUi[key], 'string', `${locale} missing devicesUi.${key}`)
        assert.ok(String(devicesUi[key]).trim() !== '', `${locale} empty devicesUi.${key}`)
      }
    }
  })
})
