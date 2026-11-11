/**
 * Tests for `ConfigService` — the read-modify-write contract.
 *
 * THE PROPERTY UNDER TEST
 * FA8 write endpoints REPLACE the whole object rather than patching it. Omitting
 * `dsySeriPortR` clears that serial port; an alarm profile submitted without its
 * thresholds resets them. So the invariant this suite protects is:
 *
 *     an edit to ONE field must leave EVERY other field byte-identical
 *
 * `PUT /set_passageway` is the one measured exception: its `chinfoArray` is a
 * SINGLE channel object keyed by `dchId` (the device's own UI posts one row, and
 * real hardware rejects any array shape with an integrity error), so only the
 * edited row is sent — but that row still carries the device's own values for the
 * fields the caller did not change.
 *
 * That is not obvious from any single method, and getting it wrong silently
 * reconfigures a device in a substation. The fake client below records exactly
 * what was submitted, so each test can assert on the whole payload rather than on
 * the one field it changed.
 *
 * Real device payloads are used verbatim (captured from an AE08 on
 * firmware 567E68F.2026-06-26_WEEK26), so a mapper regression shows up here.
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { ConfigService } from '../src/main/services/device/config-service'
import { AppError } from '../src/shared/errors'
import type { DeviceApiClient } from '../src/main/services/device/device-api-client'

// ---------------------------------------------------------------------------
// Fake client
// ---------------------------------------------------------------------------

/** Everything the fake client was asked to write, for assertion. */
interface Recorded {
  passageway?: Record<string, unknown>
  alarmSystem?: Record<string, unknown>
  deletedAlarmId?: number
  network?: Record<string, unknown>
  timeSet?: Record<string, unknown>
  rs485?: Record<string, unknown>
  modbus?: Record<string, unknown>
  samplingRate?: Record<string, unknown>
  deviceName?: Record<string, unknown>
}

/**
 * A stand-in for `DeviceApiClient` that serves captured device payloads and
 * records writes.
 *
 * Hand-written rather than auto-mocked so each response is a REAL payload: a
 * generated mock would encode our assumptions back at us, which is precisely the
 * failure this project has already hit twice.
 */
function fakeClient(options: { failOn?: string; passageway?: unknown } = {}): {
  client: DeviceApiClient
  written: Recorded
} {
  const written: Recorded = {}

  const guard = (name: string): void => {
    if (options.failOn === name) throw new Error(`simulated ${name} failure`)
  }

  const api = {
    async getPassageway() {
      // A test can override this with a different real capture (e.g. CH5/CH8 enabled).
      if (options.passageway !== undefined) return options.passageway
      // Verified AE08 payload, including the `chinfoArray` key the spec omits.
      return {
        chinfoArray: [
          { dchAlarmPara: 2, dchEn: 1, dchId: 0, dchName: 'name1', dchSensorType: 0 },
          { dchAlarmPara: 1, dchEn: 1, dchId: 1, dchName: 'name2', dchSensorType: 1 },
          { dchAlarmPara: 1, dchEn: 0, dchId: 2, dchName: 'name3', dchSensorType: 0 },
          { dchAlarmPara: 1, dchEn: 0, dchId: 3, dchName: 'name4', dchSensorType: 0 },
          { dchAlarmPara: 1, dchEn: 0, dchId: 4, dchName: 'name5', dchSensorType: 0 },
          { dchAlarmPara: 1, dchEn: 0, dchId: 5, dchName: 'name6', dchSensorType: 0 },
          { dchAlarmPara: 1, dchEn: 0, dchId: 6, dchName: 'name7', dchSensorType: 0 },
          { dchAlarmPara: 1, dchEn: 0, dchId: 7, dchName: 'name8', dchSensorType: 0 }
        ]
      }
    },
    async setPassageway(body: Record<string, unknown>) {
      guard('setPassageway')
      written.passageway = body
    },
    async getSamplingRate() {
      return { samplingrate: 96000 }
    },
    async setSamplingRate(body: Record<string, unknown>) {
      guard('setSamplingRate')
      written.samplingRate = body
    },
    async getAlarmSystem() {
      // Two profiles, including the firmware's misspelled/short field names.
      return {
        alarmparaArray: [
          {
            dalDeteSen: 10, dalDetecType: 0, dalFBETEn: 1, dalFBETLo: 15000, dalFBETThre: 0.5,
            dalFBETUp: 24000, dalId: 1, dalIntInhLeve: 10, dalMFLower: 10, dalMFUpper: 5000,
            dalMainFreqEn: 1, dalName: 'defPara1', dalSPLODEn: 1, dalSPLODThre: 120,
            dalSPLSDDEn: 0, dalSPLSDDThre: 20, dalSPLSIDEn: 0, dalSPLSIDThre: 20,
            dalSPLStaDetEN: 1, dalSPLStaDetThre: 150, dalSensitivity: 10
          },
          {
            dalDeteSen: 10, dalDetecType: 0, dalFBETEn: 0, dalFBETLo: 0, dalFBETThre: 0,
            dalFBETUp: 1, dalId: 2, dalIntInhLeve: 10, dalMFLower: 0, dalMFUpper: 1,
            dalMainFreqEn: 0, dalName: 'Test', dalSPLODEn: 1, dalSPLODThre: 20,
            dalSPLSDDEn: 0, dalSPLSDDThre: 0, dalSPLSIDEn: 1, dalSPLSIDThre: 2,
            dalSPLStaDetEN: 0, dalSPLStaDetThre: 0, dalSensitivity: 10
          },
          {
            // Not referenced by any channel, so it is genuinely unbound.
            dalDeteSen: 5, dalDetecType: 1, dalFBETEn: 1, dalFBETLo: 100, dalFBETThre: 1,
            dalFBETUp: 200, dalId: 3, dalIntInhLeve: 5, dalMFLower: 50, dalMFUpper: 500,
            dalMainFreqEn: 1, dalName: '未绑定配置', dalSPLODEn: 1, dalSPLODThre: 100,
            dalSPLSDDEn: 0, dalSPLSDDThre: 0, dalSPLSIDEn: 0, dalSPLSIDThre: 0,
            dalSPLStaDetEN: 0, dalSPLStaDetThre: 0, dalSensitivity: 5
          }
        ],
        alarmparaSize: 3
      }
    },
    async setAlarmSystem(body: Record<string, unknown>) {
      guard('setAlarmSystem')
      written.alarmSystem = body
    },
    async deleteAlarmSystem(body: { dalId: number }) {
      guard('deleteAlarmSystem')
      written.deletedAlarmId = body.dalId
    },
    async getNetwork() {
      return {
        dsyDNSAdder: '223.5.5.5', dsyHTTPPort: 80, dsyIPAdder: '192.168.110.90',
        dsyIPGateway: '192.168.110.1', dsyIPMask: '255.255.255.0', dsyIPMode: 'manual',
        dsyRTSPPort: 28003, dsyTCPPort: 28001
      }
    },
    async setNetwork(body: Record<string, unknown>) {
      guard('setNetwork')
      written.network = body
    },
    async getTimeSet() {
      return { cur_time: 1789104356236, dsyNTPAdder: 'cn.pool.ntp.org', dsyNTPEN: 0, dsyNTPInterval: 64 }
    },
    async setTimeSet(body: Record<string, unknown>) {
      guard('setTimeSet')
      written.timeSet = body
    },
    async getRs485() {
      // NOTE: no `dsySeriPortR` — the read endpoint omits it while the write
      // endpoint expects it. That asymmetry is the whole reason this test exists.
      return { dsySeriBaud: 9600, dsySeriDateBit: 8, dsySeriMode: 0, dsySeriPortL: '', dsySeriRserAddr: '' }
    },
    async setRs485(body: Record<string, unknown>) {
      guard('setRs485')
      written.rs485 = body
    },
    async getAvailableSerial() {
      return { all_available_dev: ['/dev/ttyS3', '/dev/ttyS0'], all_available_size: 2 }
    },
    async getModbusPara() {
      return {
        modbus_baud: 9600, modbus_crc: 0, modbus_dbit: 8, modbus_post: 502,
        modbus_sbit: 1, modbus_slave: 200, modbus_type: 0
      }
    },
    async setModbusPara(body: Record<string, unknown>) {
      guard('setModbusPara')
      written.modbus = body
    },
    async getPushConfig() {
      return {
        dsyAlarmInfoAdder: 'http://8.153.195.75:3000/api/v1/dt_abc/telemetry', dsyAlarmInfoEN: 1,
        dsyFeatDataAdder: 'http://8.153.195.75:3000/api/v1/dt_abc/telemetry', dsyFeatDataEN: 1,
        dsyGraphDataAdder: 'http://192.168.1.100:8080/push', dsyGraphDataEN: 0,
        dsyHeatAdder: '', dsyHeatContent: 'HEAT', dsyHeatEN: 0, dsyHeatInterval: 60,
        dsyManualRecordingAddr: '', dsyManualRecordingEN: 0
      }
    },
    async setDeviceName(body: Record<string, unknown>) {
      guard('setDeviceName')
      written.deviceName = body
    }
  }

  return { client: api as unknown as DeviceApiClient, written }
}

// ---------------------------------------------------------------------------

describe('ConfigService reads', () => {
  it('maps the real channel payload, including the chinfoArray key', async () => {
    const { client } = fakeClient()
    const channels = await new ConfigService(client).getChannels()

    assert.equal(channels.length, 8)
    assert.deepEqual(channels[0], {
      channelIndex: 0, name: 'name1', sensorType: 0, enabled: true, alarmProfileId: 2
    })
    // Conduction sensor survives.
    assert.equal(channels[1]?.sensorType, 1)
    // Disabled channels are reported as disabled, not dropped.
    assert.equal(channels[2]?.enabled, false)
    // Sorted ascending even if the device returns them out of order.
    assert.deepEqual(channels.map((channel) => channel.channelIndex), [0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('maps enabled CH5 / CH8 from the real device shape (dchEn on indexes 4 and 7)', async () => {
    // 业主 2026-11-11 的现场：只接了通道 5 和通道 8，设备把 dchEn=1 放在
    // dchId 4 / 7 上。映射层必须原样保留这个事实，不能把「前两路启用」当默认值。
    const passageway = {
      chinfoArray: [
        { dchAlarmPara: 1, dchEn: 0, dchId: 0, dchName: 'name1', dchSensorType: 0 },
        { dchAlarmPara: 1, dchEn: 0, dchId: 1, dchName: 'name2', dchSensorType: 1 },
        { dchAlarmPara: 1, dchEn: 0, dchId: 2, dchName: 'name3', dchSensorType: 0 },
        { dchAlarmPara: 1, dchEn: 0, dchId: 3, dchName: 'name4', dchSensorType: 0 },
        { dchAlarmPara: 1, dchEn: 1, dchId: 4, dchName: 'name5', dchSensorType: 0 },
        { dchAlarmPara: 1, dchEn: 0, dchId: 5, dchName: 'name6', dchSensorType: 0 },
        { dchAlarmPara: 1, dchEn: 0, dchId: 6, dchName: 'name7', dchSensorType: 0 },
        { dchAlarmPara: 1, dchEn: 1, dchId: 7, dchName: 'name8', dchSensorType: 1 }
      ]
    }
    const { client } = fakeClient({ passageway })
    const channels = await new ConfigService(client).getChannels()

    assert.deepEqual(
      channels.filter((channel) => channel.enabled).map((channel) => channel.channelIndex),
      [4, 7]
    )
    assert.equal(channels[4]?.name, 'name5')
    assert.equal(channels[7]?.name, 'name8')
    assert.equal(channels[7]?.sensorType, 1)
  })

  it('maps alarm profiles to friendly names, never the firmware vocabulary', async () => {
    const { client } = fakeClient()
    const profiles = await new ConfigService(client).getAlarmProfiles()

    assert.equal(profiles.length, 3)

    const first = profiles[0]
    assert.ok(first)
    assert.equal(first.id, 1)
    assert.equal(first.name, 'defPara1')
    assert.equal(first.splOverloadEnabled, true)
    assert.equal(first.splOverloadThreshold, 120)
    assert.equal(first.splSurgeEnabled, false)
    assert.equal(first.mainFrequencyEnabled, true)
    assert.equal(first.mainFrequencyLower, 10)
    assert.equal(first.mainFrequencyUpper, 5000)
    // A fractional threshold must not be truncated to an integer.
    assert.equal(first.bandEnergyRatioThreshold, 0.5)

    // The friendly objects must not carry any `dal*` key.
    assert.ok(
      !Object.keys(first).some((key) => key.startsWith('dal')),
      'a firmware field name leaked into the view model'
    )
  })

  it('maps the network payload and preserves real port values', async () => {
    const { client } = fakeClient()
    const network = await new ConfigService(client).getNetwork()

    assert.equal(network.ip, '192.168.110.90')
    assert.equal(network.netmask, '255.255.255.0')
    assert.equal(network.httpPort, 80)
    assert.equal(network.rtspPort, 28003)
    assert.equal(network.tcpPort, 28001)
    assert.equal(network.mode, 'manual')
  })

  it('maps Modbus using the firmware spelling of the port field', async () => {
    const { client } = fakeClient()
    const modbus = await new ConfigService(client).getModbus()
    // Exposed as `port` even though the wire field is `modbus_post`.
    assert.equal(modbus.port, 502)
    assert.equal(modbus.slaveId, 200)
  })

  it('flags a push target that leaves the site', async () => {
    const { client } = fakeClient()
    const push = await new ConfigService(client).getPushConfig()

    assert.equal(push.featureEnabled, true)
    assert.equal(push.graphEnabled, false)
    // Two channels point at a public address, so the aggregate flag must be set
    // even though one of them is disabled and another is private.
    assert.equal(push.targetsPublicAddress, true)
  })

  it('reports no public egress when every target is private', async () => {
    const { client } = fakeClient()
    // Override just the push reader.
    ;(client as unknown as { getPushConfig: () => Promise<unknown> }).getPushConfig = async () => ({
      dsyFeatDataAdder: 'http://192.168.1.10:8080/push', dsyFeatDataEN: 1,
      dsyAlarmInfoAdder: 'http://10.0.0.5:9000/a', dsyAlarmInfoEN: 1,
      dsyGraphDataAdder: 'http://172.16.4.4/x', dsyGraphDataEN: 1,
      dsyHeatAdder: '', dsyHeatEN: 0, dsyHeatInterval: 60
    })

    const push = await new ConfigService(client).getPushConfig()
    assert.equal(push.targetsPublicAddress, false)
  })
})

describe('ConfigService read-modify-write', () => {
  it('submits ONE channel object inside the msgBody envelope when editing one', async () => {
    const { client, written } = fakeClient()
    await new ConfigService(client).updateChannel(2, { name: '母线室' })

    /**
     * 设备实测的形状（源映射 + 真机值保持探针，见 `docs/PROTOCOL-FINDINGS.md` §5A.2）：
     * `{ "msgBody": { "chinfoArray": <单个通道对象> } }`。
     *
     * 数组（哪怕只有一个元素）会被固件答成
     * `Failed, Please check the integrity of the data format.`，
     * 所以这里必须同时断言「有信封」与「不是数组」—— 之前这一条断言的正是那个数组，
     * 等于把这个 bug 钉死在测试里。
     */
    const envelope = written.passageway?.msgBody as Record<string, unknown> | undefined
    assert.ok(envelope, 'the msgBody envelope was not submitted')
    const submitted = envelope.chinfoArray as Record<string, unknown>
    assert.ok(submitted && !Array.isArray(submitted), 'chinfoArray must be a single channel object')

    // The edit landed...
    assert.equal(submitted.dchId, 2)
    assert.equal(submitted.dchName, '母线室')
    // ...and the row still carries the DEVICE's own values for everything else.
    assert.equal(submitted.dchEn, 0, 'the device disabled-flag for this channel was lost')
    assert.equal(submitted.dchSensorType, 0)
    assert.equal(submitted.dchAlarmPara, 1)
  })

  it('carries the device own values for the fields the edit does not change', async () => {
    const { client, written } = fakeClient()
    await new ConfigService(client).updateChannel(0, { alarmProfileId: 1 })

    const submitted = (written.passageway?.msgBody as Record<string, unknown>)
      ?.chinfoArray as Record<string, unknown>
    assert.equal(submitted.dchAlarmPara, 1)
    assert.equal(submitted.dchName, 'name1')
    assert.equal(submitted.dchEn, 1)
    assert.equal(submitted.dchSensorType, 0)
    // `dchEn` is the wire spelling of a number, never a boolean.
    assert.equal(typeof submitted.dchEn, 'number')
  })

  it('keeps a disabled channel disabled when an unrelated field is edited', async () => {
    const { client, written } = fakeClient()
    // Channel 2 is reported with `dchEn: 0`; editing its alarm binding must not
    // re-enable it on the way past.
    await new ConfigService(client).updateChannel(2, { alarmProfileId: 1 })

    const submitted = (written.passageway?.msgBody as Record<string, unknown>)
      ?.chinfoArray as Record<string, unknown>
    assert.equal(submitted.dchId, 2)
    assert.equal(submitted.dchEn, 0, 'a disabled channel was re-enabled by an unrelated edit')
    assert.equal(submitted.dchSensorType, 0)
  })

  it('refuses to edit a channel the device did not report', async () => {
    const { client } = fakeClient()
    await assert.rejects(
      () => new ConfigService(client).updateChannel(99, { name: 'x' }),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.equal(error.code, 'VALIDATION_ERROR')
        return true
      }
    )
  })

  it('submits every alarm field when editing one', async () => {
    const { client, written } = fakeClient()
    const profiles = await new ConfigService(client).getAlarmProfiles()
    const target = profiles[0]
    assert.ok(target)

    await new ConfigService(client).saveAlarmProfile({ ...target, name: '改名', splOverloadThreshold: 99 })

    const submitted = (written.alarmSystem?.alarmparaArray as Array<Record<string, unknown>>)[0]
    assert.ok(submitted)
    assert.equal(submitted.dalName, '改名')
    assert.equal(submitted.dalSPLODThre, 99)
    // Untouched fields must survive: a profile is replaced wholesale.
    assert.equal(submitted.dalId, 1)
    assert.equal(submitted.dalMainFreqEn, 1)
    assert.equal(submitted.dalMFLower, 10)
    assert.equal(submitted.dalMFUpper, 5000)
    assert.equal(submitted.dalFBETThre, 0.5)
    assert.equal(submitted.dalSPLStaDetThre, 150)
    assert.equal(submitted.dalIntInhLeve, 10)
  })

  it('omits dalId when creating a profile, includes it when updating', async () => {
    const { client, written } = fakeClient()
    const service = new ConfigService(client)
    const existing = (await service.getAlarmProfiles())[0]
    assert.ok(existing)

    const blank = { ...existing, id: undefined, name: '新配置' }
    await service.saveAlarmProfile(blank)
    assert.ok(
      !('dalId' in ((written.alarmSystem?.alarmparaArray as Array<Record<string, unknown>>)[0] ?? {})),
      'dalId must be absent for a create, or the device updates instead of creating'
    )

    await service.saveAlarmProfile({ ...existing, id: 7, name: '更新' })
    assert.equal((written.alarmSystem?.alarmparaArray as Array<Record<string, unknown>>)[0]?.dalId, 7)
  })

  it('rejects an alarm profile with an inverted frequency band', async () => {
    const { client } = fakeClient()
    const profile = (await new ConfigService(client).getAlarmProfiles())[0]
    assert.ok(profile)

    await assert.rejects(
      () => new ConfigService(client).saveAlarmProfile({ ...profile, mainFrequencyLower: 900, mainFrequencyUpper: 100 }),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.match(error.message, /主频/)
        return true
      }
    )
  })

  it('refuses to delete an alarm profile that channels are bound to', async () => {
    const { client, written } = fakeClient()
    // Profile 1 is bound to channels 1-7 in the fixture.
    await assert.rejects(
      () => new ConfigService(client).deleteAlarmProfile(1),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.match(error.message, /CH2/, 'the message should name the bound channels')
        return true
      }
    )
    assert.equal(written.deletedAlarmId, undefined, 'a refused delete must not reach the device')
  })

  it('allows deleting a profile that no channel is bound to', async () => {
    const { client, written } = fakeClient()
    // Profile 2 IS bound (channel 0 uses it), so it must be refused; profile 3 is
    // referenced by nothing and must be deletable. Asserting both in one test
    // keeps the contrast explicit.
    await assert.rejects(() => new ConfigService(client).deleteAlarmProfile(2))
    assert.equal(written.deletedAlarmId, undefined, 'a refused delete reached the device')

    await new ConfigService(client).deleteAlarmProfile(3)
    assert.equal(written.deletedAlarmId, 3)
  })

  it('rejects deleting a profile the device does not have', async () => {
    const { client, written } = fakeClient()
    await assert.rejects(
      () => new ConfigService(client).deleteAlarmProfile(99),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.equal(error.code, 'VALIDATION_ERROR')
        return true
      }
    )
    assert.equal(written.deletedAlarmId, undefined)
  })

  it('carries dsySeriPortR through an RS485 write even though it cannot be read', async () => {
    const { client, written } = fakeClient()
    await new ConfigService(client).updateRs485({ baud: 19200 })

    // 信封是实测必需的（裸对象被答成 `Failed to set RS485 parameters.`）。
    const body = written.rs485?.msgBody as Record<string, unknown> | undefined
    assert.ok(body, 'the msgBody envelope was not submitted')

    // THE TRAP. The read endpoint omits portRight; rebuilding the payload from
    // the read response alone would send `undefined` and clear that port.
    assert.ok('dsySeriPortR' in body, 'dsySeriPortR was dropped from the write')
    assert.equal(body.dsySeriBaud, 19200)
    // Fields the caller did not edit are preserved.
    assert.equal(body.dsySeriDateBit, 8)
    assert.equal(body.dsySeriMode, 0)
    assert.equal(body.dsySeriRserAddr, '')
  })

  it('never sends modbus_crc, which is read-only', async () => {
    const { client, written } = fakeClient()
    await new ConfigService(client).updateModbus({ slaveId: 5 })

    const modbus = written.modbus?.msgBody as Record<string, unknown> | undefined
    assert.ok(modbus, 'the msgBody envelope was not submitted')
    assert.ok(!('modbus_crc' in modbus), 'modbus_crc is not part of the write payload')
    assert.equal(modbus.modbus_slave, 5)
    assert.equal(modbus.modbus_post, 502)
    assert.equal(modbus.modbus_baud, 9600)
  })

  it('validates the Modbus slave address range before writing', async () => {
    const { client, written } = fakeClient()
    await assert.rejects(
      () => new ConfigService(client).updateModbus({ slaveId: 300 }),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.equal(error.code, 'VALIDATION_ERROR')
        return true
      }
    )
    assert.equal(written.modbus, undefined, 'an invalid write must not reach the device')
  })

  it('syncs the clock to the host rather than echoing the device time back', async () => {
    const { client, written } = fakeClient()
    const before = Date.now()
    await new ConfigService(client).syncDeviceTime()
    const after = Date.now()

    // 信封是实测必需的（裸对象被答成 `Failed to set time parameters.`）。
    const timeSet = written.timeSet?.msgBody as Record<string, unknown> | undefined
    assert.ok(timeSet, 'the msgBody envelope was not submitted')

    const sent = Number(timeSet.cur_time)
    assert.ok(sent >= before && sent <= after, `clock value ${sent} is not the host time`)
    // NTP preferences are preserved.
    assert.equal(timeSet.dsyNTPAdder, 'cn.pool.ntp.org')
    assert.equal(timeSet.dsyNTPEN, 0)
    assert.equal(timeSet.dsyNTPInterval, 64)
  })

  it('rejects an empty device name', async () => {
    const { client, written } = fakeClient()
    await assert.rejects(
      () => new ConfigService(client).setDeviceName('   '),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.equal(error.code, 'VALIDATION_ERROR')
        return true
      }
    )
    assert.equal(written.deviceName, undefined)
  })

  it('trims the device name before sending, and wraps it in msgBody', async () => {
    const { client, written } = fakeClient()
    await new ConfigService(client).setDeviceName('  新名称  ')
    // 形状是设备实测的：裸 `{devname}` 会被答成 `Failed to modify device name.`
    // （`docs/PROTOCOL-FINDINGS.md` §5A.10）。
    const envelope = written.deviceName?.msgBody as Record<string, unknown> | undefined
    assert.ok(envelope, 'the msgBody envelope was not submitted')
    assert.equal(envelope.devname, '新名称')
    assert.ok(!('devname' in (written.deviceName ?? {})), 'devname leaked to the root of the body')
  })

  it('rejects a non-integer sample rate', async () => {
    const { client, written } = fakeClient()
    await assert.rejects(() => new ConfigService(client).setSampleRate(48.5))
    await assert.rejects(() => new ConfigService(client).setSampleRate(-1))
    assert.equal(written.samplingRate, undefined)
  })

  it('sends the sample rate in a msgBody envelope, not as a bare object', async () => {
    const { client, written } = fakeClient()
    await new ConfigService(client).setSampleRate(192000)
    // 裸 `{samplingrate}` 被设备答成 `Failed to set sampling rate.`；信封必需。
    assert.deepEqual(written.samplingRate, { msgBody: { samplingrate: 192000 } })
  })
})
