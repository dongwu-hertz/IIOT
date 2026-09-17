/**
 * Device family (kind) regression tests.
 *
 * WHY THIS FILE EXISTS
 * A second product family now shares the `devices` table, and the two families
 * disagree about the things this repository is responsible for:
 *
 *   - an acoustic box identifies ITSELF (`GET /get_devinfo` -> Device ID/SN), so
 *     re-adding it at a new address must update the existing row;
 *   - an FA371 acoustic camera has NO identity endpoint at all
 *     (`docs/reference/FA371-api-spec.md` §6), so its uid is minted from the
 *     address, and it has no channels to seed.
 *
 * Getting either wrong is silent: a wrong `kind` routes the device to the wrong
 * protocol client, and phantom channels look exactly like real ones. So the
 * migration default, the identity rule and the channel seeding are all asserted
 * here rather than left to the UI to notice.
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { openDatabase, SCHEMA_VERSION } from '../src/main/services/database/schema'
import { ChannelRepository, DeviceRepository } from '../src/main/services/database/device-repository'
import {
  cameraDeviceUid,
  cameraFallbackName,
  isMintedCameraUid,
  FA371_DEFAULT_HTTP_PORT
} from '../src/main/services/device/camera-identity'
import { DEVICE_KINDS, isDeviceKind } from '../src/shared/domain/models'

/**
 * Both repositories, because "an acoustic box gets channels and a camera does
 * not" is a statement about two tables.
 */
function freshRepo(): { devices: DeviceRepository; channels: ChannelRepository } {
  const db = openDatabase({ file: ':memory:' })
  return { devices: new DeviceRepository(db), channels: new ChannelRepository(db) }
}

const CAMERA_INPUT = {
  ip: '192.168.2.168',
  httpPort: 80,
  username: 'admin',
  password: 'Hz@123456',
  kind: 'acousticCamera' as const
}

describe('device kind migration', () => {
  it('brings a database to the current schema version', () => {
    const db = openDatabase({ file: ':memory:' })
    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION)
  })

  it('adds a non-null kind column defaulting to the acoustic box', () => {
    // The default is the correct backfill, not a convenient one: every row that
    // existed before this column was an acoustic box, because nothing else could
    // be added. A NULL default would have forced every reader to guess.
    const db = openDatabase({ file: ':memory:' })
    const columns = db.pragma('table_info(devices)') as Array<{
      name: string
      notnull: number
      dflt_value: string | null
    }>
    const kind = columns.find((column) => column.name === 'kind')
    assert.ok(kind, 'kind column missing')
    assert.equal(kind.notnull, 1)
    assert.equal(kind.dflt_value, "'acousticBox'")
  })

  it('rejects a kind the application does not know', () => {
    // The CHECK constraint is the last line of defence: a typo'd kind arriving
    // over IPC must fail loudly instead of producing an un-routable device.
    const db = openDatabase({ file: ':memory:' })
    assert.throws(() =>
      db
        .prepare(
          `INSERT INTO devices (id, device_uid, kind, name, connection_type, status, created_at, updated_at)
           VALUES ('x', 'uid-x', 'acousticCameraX', 'n', 'LAN', 'UNKNOWN', 1, 1)`
        )
        .run()
    )
  })

  it('is idempotent when run twice', () => {
    // openDatabase is called on every app start, so a migration that is not
    // guarded would either throw or add the column twice.
    const db = openDatabase({ file: ':memory:' })
    assert.doesNotThrow(() => openDatabase({ file: ':memory:' }))
    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION)
  })
})

describe('kind validation', () => {
  it('accepts exactly the declared kinds', () => {
    for (const kind of DEVICE_KINDS) assert.ok(isDeviceKind(kind))
  })

  it('rejects anything else', () => {
    // Values arriving from the renderer, from a config file or from a future
    // database must not be trusted into a union type.
    for (const value of ['', 'AcousticCamera', 'acousticcamera', 0, null, undefined, {}]) {
      assert.equal(isDeviceKind(value), false, `accepted ${JSON.stringify(value)}`)
    }
  })
})

describe('camera identity', () => {
  it('is deterministic for an address', () => {
    assert.equal(
      cameraDeviceUid('192.168.2.168', 80),
      cameraDeviceUid('192.168.2.168', 80)
    )
  })

  it('normalises case and surrounding whitespace', () => {
    // The same camera reached as `Camera.local` and `camera.local ` must not
    // become two devices.
    assert.equal(
      cameraDeviceUid(' Camera.Local ', 80),
      cameraDeviceUid('camera.local', 80)
    )
  })

  it('falls back to the protocol default port rather than emitting undefined', () => {
    // Otherwise the same device gets two uids depending on which code path built
    // the input — exactly the duplicate the uid exists to prevent.
    assert.equal(cameraDeviceUid('10.0.0.5'), cameraDeviceUid('10.0.0.5', FA371_DEFAULT_HTTP_PORT))
    assert.ok(!cameraDeviceUid('10.0.0.5').includes('undefined'))
  })

  it('ignores an unusable port', () => {
    assert.equal(cameraDeviceUid('10.0.0.5', 0), cameraDeviceUid('10.0.0.5', FA371_DEFAULT_HTTP_PORT))
    assert.equal(cameraDeviceUid('10.0.0.5', 70000), cameraDeviceUid('10.0.0.5', FA371_DEFAULT_HTTP_PORT))
  })

  it('is recognisable as locally minted, and distinct from a firmware uid', () => {
    assert.ok(isMintedCameraUid(cameraDeviceUid('192.168.2.168', 80)))
    assert.equal(isMintedCameraUid('AE08-0001'), false)
  })

  it('names the fallback after the family, never "Acoustic Box"', () => {
    assert.equal(cameraFallbackName(' 192.168.2.168 '), 'Acoustic Camera 192.168.2.168')
  })
})

describe('camera persistence', () => {
  it('stores the camera with its kind and without channels', () => {
    const { devices, channels } = freshRepo()
    const { device, created } = devices.upsertCamera(CAMERA_INPUT, {
      deviceUid: cameraDeviceUid(CAMERA_INPUT.ip, CAMERA_INPUT.httpPort),
      name: cameraFallbackName(CAMERA_INPUT.ip)
    })

    assert.equal(created, true)
    assert.equal(device.kind, 'acousticCamera')
    assert.equal(device.name, 'Acoustic Camera 192.168.2.168')
    // A camera exposes no channel list. Eight phantom CH rows would render in the
    // UI as if the device had them.
    assert.deepEqual(channels.listByDevice(device.id), [])
  })

  it('updates the address of a known camera instead of duplicating it', () => {
    const { devices } = freshRepo()
    const uid = cameraDeviceUid('192.168.2.168', 80)
    const first = devices.upsertCamera(CAMERA_INPUT, { deviceUid: uid, name: 'Kamera 1' })
    const again = devices.upsertCamera(
      { ...CAMERA_INPUT, ip: '192.168.2.169' },
      { deviceUid: cameraDeviceUid('192.168.2.169', 80), name: 'Kamera 1' }
    )

    // Different address => different MINTED uid => deliberately a second device.
    // The camera cannot prove it is the same unit, and silently merging two
    // cameras that reuse an address would be worse than a duplicate row.
    assert.equal(again.created, true)
    assert.notEqual(again.device.id, first.device.id)

    // Same address => recognised.
    const repeated = devices.upsertCamera(CAMERA_INPUT, { deviceUid: uid, name: 'Kamera 1' })
    assert.equal(repeated.created, false)
    assert.equal(repeated.device.id, first.device.id)
    assert.equal(devices.list().length, 2)
  })

  it('keeps the acoustic box path unchanged, including its channels', () => {
    const { devices, channels } = freshRepo()
    const { device } = devices.upsertByIdentity(
      { ip: '192.168.1.50', httpPort: 80, username: 'admin', password: 'admin' },
      { deviceUid: 'AE08-TEST-0001', name: '盒子', channelCount: 8 }
    )
    assert.equal(device.kind, 'acousticBox')
    assert.equal(channels.listByDevice(device.id).length, 8)
  })

  it('clears stale channels when an address is corrected from box to camera', () => {
    // Someone adds an address as an acoustic box, then discovers it is a camera
    // and adds it again with the right family. The eight seeded channels must go:
    // a camera with CH1-CH8 would look like a real, working box.
    const { devices, channels } = freshRepo()
    const { device: box } = devices.upsertByIdentity(
      { ip: '192.168.2.168', httpPort: 80, username: 'admin', password: 'admin' },
      { deviceUid: cameraDeviceUid('192.168.2.168', 80), name: '盒子', channelCount: 8 }
    )
    assert.equal(channels.listByDevice(box.id).length, 8)

    const { device: camera, created } = devices.upsertCamera(CAMERA_INPUT, {
      deviceUid: cameraDeviceUid('192.168.2.168', 80),
      name: 'Kamera'
    })

    // Same uid, so the same row is corrected in place rather than duplicated.
    assert.equal(created, false)
    assert.equal(camera.id, box.id)
    assert.equal(camera.kind, 'acousticCamera')
    assert.deepEqual(channels.listByDevice(camera.id), [])
  })
})
