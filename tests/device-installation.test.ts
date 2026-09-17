/**
 * 安装信息（点位 GIS 经纬度 / 方位角 / 基准声压级）—— 业主 2026-09-17 第 1 条。
 *
 * WHY THIS FILE EXISTS
 * 这一条要成立，靠的是四层同时正确，而任何一层单独错都不会报错：
 *   1. **解析与范围**（`shared/domain/device-installation.ts`）：界面与主进程共用同一套判据；
 *   2. **落库形状**（schema v11 的四列）：`ALTER TABLE ADD COLUMN` 之后老行是 NULL，
 *      **不是 0** —— 0 是一个真实坐标，而"没录过"必须能与它分开；
 *   3. **写入与读回**（`DeviceRepository`）：业主的硬规矩是"每个写设备的操作必须读回验证"，
 *      所以这里写入之后**换一个仓库实例从库里读回来**再断言，而不是相信写入的返回值；
 *   4. **部分更新的语义**：`undefined` = 不动这一列，`null` = 清空这一列。把两者混起来，
 *      一次改名就会顺手抹掉点位（这条最隐蔽，也最难在界面上发现）。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import Database from 'better-sqlite3'

import {
  hasInstallation,
  isPointComplete,
  parseAzimuth,
  parseInstallation,
  parseInstallationNumber,
  parseLatitude,
  parseLongitude,
  parseSoundLevel
} from '../src/shared/domain/device-installation'
import { DEVICE_INSTALLATION_LIMITS } from '../src/shared/domain/models'
import type { AddDeviceInput } from '../src/shared/domain/models'
import { MIGRATIONS, SCHEMA_VERSION, runMigrations } from '../src/main/services/database/schema'
import { DeviceRepository } from '../src/main/services/database/device-repository'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'device-install-'))
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

let fileCounter = 0
function tempFile(tag: string): string {
  fileCounter += 1
  return path.join(tempRoot, `${tag}-${fileCounter}.db`)
}

/** 全新建库（跑到最新版本）。 */
function freshDb(tag = 'fresh'): InstanceType<typeof Database> {
  const db = new Database(tempFile(tag))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}

/** 只跑到 v10 的库（现场安装的形状：还没有这四列）。 */
function openV10(): InstanceType<typeof Database> {
  const db = new Database(tempFile('v10'))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  for (const migration of MIGRATIONS) {
    if (migration.version > 10) continue
    migration.up(db)
    db.pragma(`user_version = ${migration.version}`)
  }
  return db
}

/** 一台声纹设备的添加输入（只有 `installation` 与地址在这几条断言里有意义）。 */
function boxInput(ip: string, installation?: AddDeviceInput['installation']): AddDeviceInput {
  const input: AddDeviceInput = { ip, httpPort: 80, username: 'admin', password: 'x' }
  if (installation) input.installation = installation
  return input
}

// ---------------------------------------------------------------------------
// 1. 解析与范围
// ---------------------------------------------------------------------------

describe('安装信息：解析与范围', () => {
  it('空值一律是「没有填」，不是 0', () => {
    for (const empty of ['', '   ', null, undefined]) {
      assert.equal(parseInstallationNumber(empty), undefined, `空值 ${JSON.stringify(empty)} 被读成了数`)
      assert.deepEqual(parseLatitude(empty), { ok: true, value: undefined })
      assert.deepEqual(parseAzimuth(empty), { ok: true, value: undefined })
    }
    // 这一点是这一条功能的根：把空输入存成 0，界面上就会出现一个看起来像实测值的纬度 0。
    const parsed = parseInstallation({ gisLatitude: '', gisLongitude: '', azimuthDeg: '', soundLevelDb: '' })
    assert.equal(parsed.ok, true)
    assert.deepEqual(parsed.installation, {})
  })

  it('不是数字的文字被拒（而不是被读成 NaN 或 0）', () => {
    assert.equal(parseInstallationNumber('abc'), null)
    assert.equal(parseLatitude('abc').ok, false)
    assert.equal(parseSoundLevel('12dB').ok, false)
    assert.equal(parseInstallationNumber('12.5'), 12.5)
    assert.equal(parseInstallationNumber(12.5), 12.5)
  })

  it('纬度 [-90, 90]、经度 [-180, 180]（边界值算合法）', () => {
    const { latitudeMin, latitudeMax, longitudeMin, longitudeMax } = DEVICE_INSTALLATION_LIMITS
    assert.equal(parseLatitude(latitudeMin).ok, true)
    assert.equal(parseLatitude(latitudeMax).ok, true)
    assert.equal(parseLatitude(latitudeMax + 0.1).ok, false)
    assert.equal(parseLongitude(longitudeMin).ok, true)
    assert.equal(parseLongitude(longitudeMax).ok, true)
    assert.equal(parseLongitude(longitudeMax + 0.1).ok, false)
  })

  it('方位角是 [0, 360)：0 合法、360 被拒（0 = 正北，360 要写 0）', () => {
    assert.equal(parseAzimuth(0).ok, true)
    assert.equal(parseAzimuth(359.9).ok, true)
    assert.equal(parseAzimuth(360).ok, false)
    assert.equal(parseAzimuth(-0.1).ok, false)
    // 0 是**有值**：它表示正北，不能与"没填"混为一谈。
    assert.deepEqual(parseAzimuth(0), { ok: true, value: 0 })
  })

  it('基准声压级 [-50, 200] dB', () => {
    assert.equal(parseSoundLevel(-50).ok, true)
    assert.equal(parseSoundLevel(200).ok, true)
    assert.equal(parseSoundLevel(200.1).ok, false)
    assert.equal(parseSoundLevel(-50.1).ok, false)
  })

  it('四个字段一起解析：只填一半也算合法（点位那一格由 `isPointComplete` 单独说）', () => {
    const half = parseInstallation({ gisLatitude: '31.2304' })
    assert.equal(half.ok, true)
    assert.deepEqual(half.installation, { gisLatitude: 31.2304 })
    assert.equal(isPointComplete(half.installation), false, '只录了纬度却被当成一个完整点位')

    const full = parseInstallation({ gisLatitude: '31.2304', gisLongitude: '121.4737' })
    assert.equal(isPointComplete(full.installation), true)

    // 任一项越界 -> 一个字段都不写（`ok: false` 时 `installation` 只带已经算完的那几项）。
    const bad = parseInstallation({ gisLatitude: '31.2304', azimuthDeg: '400' })
    assert.equal(bad.ok, false)
    assert.equal(bad.reasonKey, 'installUi.errAzimuth')
    assert.deepEqual(bad.installation, { gisLatitude: 31.2304 }, '越界时把半份结果当成了可用结果')
  })

  it('`hasInstallation`：空对象与缺失是"没录过"，0 是"录过"', () => {
    assert.equal(hasInstallation(undefined), false)
    assert.equal(hasInstallation({}), false)
    assert.equal(hasInstallation({ azimuthDeg: 0 }), true, '方位角 0（正北）被当成了"没录过"')
    assert.equal(hasInstallation({ soundLevelDb: 0 }), true)
  })
})

// ---------------------------------------------------------------------------
// 2. schema v11
// ---------------------------------------------------------------------------

describe('schema v11：四列安装信息', () => {
  it('版本常量与迁移表的最高版本一致', () => {
    const highest = Math.max(...MIGRATIONS.map((migration) => migration.version))
    assert.equal(SCHEMA_VERSION, highest)
    assert.ok(SCHEMA_VERSION >= 11)
  })

  it('从 v10 升级：四列被加上，老行是 NULL（不是 0），数据一行不少', () => {
    const db = openV10()
    try {
      assert.equal(db.pragma('user_version', { simple: true }), 10)
      // 现场形状：一台没有安装信息的设备 + 一条通道。
      db.prepare(
        `INSERT INTO devices (id, device_uid, kind, name, ip_address, http_port, connection_type,
                              status, created_at, updated_at)
         VALUES ('dev-old', 'uid-old', 'acousticBox', 'AE08', '192.168.110.90', 80, 'LAN', 'ONLINE', 1, 1)`
      ).run()
      db.prepare(
        `INSERT INTO channels (id, device_id, channel_index, channel_name, sensor_type, enabled, created_at, updated_at)
         VALUES ('chn-old', 'dev-old', 0, 'name1', 0, 1, 1, 1)`
      ).run()

      runMigrations(db)

      assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION)
      const columns = db
        .prepare(`PRAGMA table_info(devices)`)
        .all() as Array<{ name: string; type: string; notnull: number }>
      for (const name of ['gis_latitude', 'gis_longitude', 'azimuth_deg', 'sound_level_db']) {
        const column = columns.find((entry) => entry.name === name)
        assert.ok(column, `v11 之后没有 ${name} 这一列`)
        assert.equal(column?.notnull, 0, `${name} 不许是 NOT NULL —— 没填必须是 NULL`)
      }

      // 老行的四列是 NULL 而不是 0。
      const row = db
        .prepare(`SELECT gis_latitude, gis_longitude, azimuth_deg, sound_level_db FROM devices WHERE id = 'dev-old'`)
        .get() as Record<string, unknown>
      assert.deepEqual(row, {
        gis_latitude: null,
        gis_longitude: null,
        azimuth_deg: null,
        sound_level_db: null
      })
      // 而且它在领域模型上**没有** `installation`（不是"四项都是 undefined 的对象"）。
      const device = new DeviceRepository(db).findById('dev-old')
      assert.equal(device?.installation, undefined)
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM channels`).get() as { n: number }).n, 1)
      assert.deepEqual(db.pragma('foreign_key_check'), [])
    } finally {
      db.close()
    }
  })

  it('迁移可重复执行（第二次是空操作）', () => {
    const db = freshDb('repeat')
    try {
      assert.equal(runMigrations(db), SCHEMA_VERSION)
      assert.equal(runMigrations(db), SCHEMA_VERSION)
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 3. 写入 / 读回 / 部分更新
// ---------------------------------------------------------------------------

describe('安装信息：写入之后从库里读回来', () => {
  it('四个值都写进去，换一个仓库实例读回来逐项相等', () => {
    const db = freshDb('roundtrip')
    try {
      new DeviceRepository(db).upsertByIdentity(
        boxInput('192.168.110.234', {
          gisLatitude: 31.2304,
          gisLongitude: 121.4737,
          azimuthDeg: 0,
          soundLevelDb: 63.5
        }),
        { deviceUid: 'uid-sonar', name: 'SN-16', channelCount: 16 }
      )

      // **另一个实例**读回来：相信写入返回值等于相信内存，不是读回验证。
      const reader = new DeviceRepository(db)
      const readBack = reader.findByUid('uid-sonar')
      assert.deepEqual(readBack?.installation, {
        gisLatitude: 31.2304,
        gisLongitude: 121.4737,
        azimuthDeg: 0,
        soundLevelDb: 63.5
      })
      // 按 id 再读一次，两份读回必须一致（列表走的是 `list()`，单台走的是 `findById()`）。
      const byId = readBack ? reader.findById(readBack.id) : undefined
      assert.deepEqual(byId?.installation, readBack?.installation)
    } finally {
      db.close()
    }
  })

  it('没填的项不出现（不是 0，也不是四项都 undefined 的空对象）', () => {
    const db = freshDb('partial')
    try {
      const repository = new DeviceRepository(db)
      repository.upsertByIdentity(boxInput('192.168.110.234', { azimuthDeg: 90 }), {
        deviceUid: 'uid-az',
        name: '只填方位角',
        channelCount: 8
      })
      const device = repository.findByUid('uid-az')
      assert.deepEqual(device?.installation, { azimuthDeg: 90 })

      repository.upsertByIdentity(boxInput('192.168.110.235'), {
        deviceUid: 'uid-none',
        name: '什么都没填',
        channelCount: 8
      })
      assert.equal(repository.findByUid('uid-none')?.installation, undefined)
    } finally {
      db.close()
    }
  })

  it('部分更新：`undefined` 不动那一列，`null` 清空那一列', () => {
    const db = freshDb('patch')
    try {
      const repository = new DeviceRepository(db)
      repository.upsertByIdentity(
        boxInput('192.168.110.234', {
          gisLatitude: 31.2304,
          gisLongitude: 121.4737,
          azimuthDeg: 45,
          soundLevelDb: 60
        }),
        { deviceUid: 'uid-patch', name: 'patch', channelCount: 8 }
      )
      const id = (repository.findByUid('uid-patch') as { id: string }).id

      // 只改方位角：另外三项必须原样在库里。
      repository.update({ id, installation: { azimuthDeg: 120 } })
      assert.deepEqual(repository.findById(id)?.installation, {
        gisLatitude: 31.2304,
        gisLongitude: 121.4737,
        azimuthDeg: 120,
        soundLevelDb: 60
      })

      // 清掉点位（两项都送 null）：方位角与声压级不许被顺手抹掉。
      repository.update({ id, installation: { gisLatitude: null, gisLongitude: null } })
      assert.deepEqual(repository.findById(id)?.installation, { azimuthDeg: 120, soundLevelDb: 60 })

      // 改名字**不带** installation 字段：四项一个都不许动。
      repository.update({ id, name: '改了名字' })
      assert.deepEqual(repository.findById(id)?.installation, { azimuthDeg: 120, soundLevelDb: 60 })
      assert.equal(repository.findById(id)?.name, '改了名字')
    } finally {
      db.close()
    }
  })

  it('四列全被清空之后，`installation` 从模型上消失', () => {
    const db = freshDb('clear')
    try {
      const repository = new DeviceRepository(db)
      repository.upsertByIdentity(boxInput('192.168.110.234', { soundLevelDb: 60 }), {
        deviceUid: 'uid-clear',
        name: 'clear',
        channelCount: 8
      })
      const id = (repository.findByUid('uid-clear') as { id: string }).id
      assert.deepEqual(repository.findById(id)?.installation, { soundLevelDb: 60 })

      repository.update({ id, installation: { soundLevelDb: null } })
      assert.equal(repository.findById(id)?.installation, undefined, '清空之后又出现了一个空对象')
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 4. 听诊盒子族的通道条数（同一台设备不许有两个答案）
// ---------------------------------------------------------------------------

describe('听诊盒子族：通道行数按设备回话走', () => {
  it('设备说是 16 路就 seed 16 行（不是恒等于 1）', () => {
    const db = freshDb('channels')
    try {
      const repository = new DeviceRepository(db)
      repository.upsertAuscultation(boxInput('192.168.110.234'), {
        deviceUid: 'uid-sn16',
        name: 'SN-16',
        channelCount: 16
      })
      const device = repository.findByUid('uid-sn16')
      assert.ok(device)
      const rows = db
        .prepare(`SELECT channel_index FROM channels WHERE device_id = ? ORDER BY channel_index`)
        .all(device?.id) as Array<{ channel_index: number }>
      assert.equal(rows.length, 16)
      assert.equal(rows[0]?.channel_index, 0)
      assert.equal(rows[15]?.channel_index, 15)
    } finally {
      db.close()
    }
  })

  it('设备说不出通道数才是 1（2023 版听诊盒子的产品事实）', () => {
    const db = freshDb('channels1')
    try {
      const repository = new DeviceRepository(db)
      repository.upsertAuscultation(boxInput('192.168.110.236'), {
        deviceUid: 'uid-e2',
        name: 'E2'
      })
      const device = repository.findByUid('uid-e2')
      const rows = db
        .prepare(`SELECT COUNT(*) AS n FROM channels WHERE device_id = ?`)
        .get(device?.id) as { n: number }
      assert.equal(rows.n, 1)
    } finally {
      db.close()
    }
  })
})
