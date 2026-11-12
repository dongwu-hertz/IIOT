/**
 * AO01 气井泄漏监测装置：按接口文档的**真实形状**跑一遍自动识别 + 添加 + 通道表。
 *
 * WHY THIS FILE EXISTS
 * 业主 2026-11-12 给了一份 AO01 的接口文档（`/login` 用 msgBody + md5(密码+lfxs)，
 * `/get_devinfo` / `/get_passageway` / `/get_samplingrate` 的包络都与 AE08 同族）。
 * 这台设备不在现场网络里（192.168.110.200 当前不可达），所以先用文档里的**逐字段
 * 形状**做一次端到端回归：自动识别是否认得出、通道表是否按 dchEn 落库、设备名是否
 * 来自设备自己的 devname。
 *
 * 它证明的是「协议形状兼容」；真机的流格式与告警行仍需设备上线后抓包验证。
 */

import { strict as assert } from 'node:assert'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import { DeviceService } from '../src/main/services/device/device-service'
import { FetchHttpTransport } from '../src/main/services/device/http-transport'
import { MemoryCredentialStore } from '../src/main/services/device/credential-store'
import { ChannelRepository, DeviceRepository } from '../src/main/services/database/device-repository'
import { openDatabase } from '../src/main/services/database/schema'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao01-'))
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

interface FakeAo01 {
  port: number
  loginCount: () => number
  close(): Promise<void>
}

/** 文档里的 AO01 设备：只接受 `token:` 头，返回 msgBody 包络。 */
async function startAo01(): Promise<FakeAo01> {
  let logins = 0
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const send = (status: number, body: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }

    if (request.method === 'POST' && url.pathname === '/login') {
      logins += 1
      send(200, { result: 0, message: 'ok', msgBody: { token: 'AO01-TOKEN' } })
      return
    }
    // 文档：受保护接口要求会话；这里只接受 token 头（与 AE08 真机一致）。
    if (request.headers.token !== 'AO01-TOKEN') {
      send(401, { result: 2, message: 'auth failed' })
      return
    }
    if (url.pathname === '/get_devinfo') {
      send(200, {
        result: 0,
        message: 'ok',
        msgBody: {
          devname: 'AO01',
          dev_version: 'V1.0.0_20261101',
          dev_mac: '02:11:22:33:44:55',
          web_version: 'WEBV1.0.0'
        }
      })
      return
    }
    if (url.pathname === '/get_passageway') {
      send(200, {
        result: 0,
        message: 'ok',
        msgBody: {
          chinfoSize: 8,
          chinfoArray: [
            { dchAlarmPara: '1', dchEn: 0, dchId: 0, dchName: 'name1', dchSensorType: 0 },
            { dchAlarmPara: '1', dchEn: 0, dchId: 1, dchName: 'name2', dchSensorType: 1 },
            { dchAlarmPara: '1', dchEn: 0, dchId: 2, dchName: 'name3', dchSensorType: 0 },
            { dchAlarmPara: '1', dchEn: 0, dchId: 3, dchName: 'name4', dchSensorType: 0 },
            { dchAlarmPara: '1', dchEn: 1, dchId: 4, dchName: 'name5', dchSensorType: 0 },
            { dchAlarmPara: '1', dchEn: 0, dchId: 5, dchName: 'name6', dchSensorType: 0 },
            { dchAlarmPara: '1', dchEn: 0, dchId: 6, dchName: 'name7', dchSensorType: 0 },
            { dchAlarmPara: '1', dchEn: 1, dchId: 7, dchName: 'name8', dchSensorType: 1 }
          ]
        }
      })
      return
    }
    if (url.pathname === '/get_samplingrate') {
      send(200, { result: 0, message: 'ok', msgBody: { samplingrate: 96000 } })
      return
    }
    send(404, { result: 1, message: 'not found' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    port,
    loginCount: () => logins,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

let counter = 0
function createService(): { service: DeviceService; db: ReturnType<typeof openDatabase> } {
  counter += 1
  const db = openDatabase({ file: path.join(tempRoot, `db-${counter}.db`) })
  const service = new DeviceService({
    devices: new DeviceRepository(db),
    channels: new ChannelRepository(db),
    credentials: new MemoryCredentialStore(),
    transport: new FetchHttpTransport(3_000),
    settings: () => ({
      requestTimeoutMs: 3_000,
      healthCheckIntervalMs: 60_000,
      offlineFailureThreshold: 3,
      ringBufferSeconds: 10,
      preAlarmSeconds: 5,
      postAlarmSeconds: 5
    })
  })
  return { service, db }
}

describe('AO01 气井泄漏监测装置（接口文档形状）', () => {
  it('自动识别为声纹设备，并按 dchEn 落库 8 路通道（CH5 / CH8 启用）', async () => {
    const fake = await startAo01()
    try {
      const { service, db } = createService()
      try {
        const added = await service.add({
          ip: '127.0.0.1',
          httpPort: fake.port,
          username: 'admin',
          password: '123456'
        })

        assert.equal(added.kind, 'acousticBox')
        assert.equal(added.name, 'AO01')
        assert.equal(added.deviceUid, 'mac:02:11:22:33:44:55')
        assert.equal(new DeviceRepository(db).getAuthStrategy(added.id), 'token-header')

        const channels = service.getChannels(added.id)
        assert.equal(channels.length, 8)
        assert.deepEqual(
          channels.filter((channel) => channel.enabled).map((channel) => channel.channelIndex),
          [4, 7]
        )
        assert.equal(channels[4]?.channelName, 'name5')
        assert.equal(channels[7]?.channelName, 'name8')
        assert.equal(channels[7]?.sensorType, 1)
        assert.ok(fake.loginCount() >= 1)
      } finally {
        db.close()
      }
    } finally {
      await fake.close()
    }
  })
})