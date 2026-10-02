/**
 * S2 设置项的契约测试：默认值与合法边界。
 *
 * 纯策略的删除判据由 `retention.test.ts` / `storage-retention-sweep.test.ts`
 * 钉住；这一条只回答「配额与保留比例能不能按预期写进设置表」。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { openDatabase } from '../src/main/services/database/schema'
import {
  DEFAULT_SETTINGS,
  SettingsService
} from '../src/main/services/settings/settings-service'

const GB = 1024 ** 3

describe('S2 storage quota settings', () => {
  it('factory defaults: 50 GB quota and 10% permanent-alarm reserve', () => {
    assert.equal(DEFAULT_SETTINGS.storageQuotaBytes, 50 * GB)
    assert.equal(DEFAULT_SETTINGS.retentionAlarmReserveRatio, 0.1)
  })

  it('0 is a legal quota meaning unlimited; invalid values are rejected, not coerced', () => {
    const db = openDatabase({ file: ':memory:' })
    try {
      const settings = new SettingsService({ db, defaultStorageRoot: 'C:\\hz-test' })

      const unlimited = settings.update({
        storageQuotaBytes: 0,
        retentionAlarmReserveRatio: 0
      })
      assert.deepEqual(unlimited.rejected, [])
      assert.equal(unlimited.settings.storageQuotaBytes, 0)
      assert.equal(unlimited.settings.retentionAlarmReserveRatio, 0)

      const rejected = settings.update({
        storageQuotaBytes: -1,
        retentionAlarmReserveRatio: 2
      })
      assert.deepEqual(rejected.rejected, ['storageQuotaBytes', 'retentionAlarmReserveRatio'])
      assert.equal(rejected.settings.storageQuotaBytes, 0, 'rejected value must not touch the stored one')
      assert.equal(rejected.settings.retentionAlarmReserveRatio, 0)
    } finally {
      db.close()
    }
  })

  it('existing installs without the new key start unlimited, not 50 GB', () => {
    const db = openDatabase({ file: ':memory:' })
    try {
      db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run('retentionDays', JSON.stringify(7))
      const settings = new SettingsService({ db, defaultStorageRoot: 'C:\\hz-test' })

      assert.equal(settings.get().retentionDays, 7, 'old settings still load')
      assert.equal(settings.get().storageQuotaBytes, 0, 'an upgrade must not start deleting old recordings')
      assert.equal(settings.get().retentionAlarmReserveRatio, 0.1)
    } finally {
      db.close()
    }
  })
})
