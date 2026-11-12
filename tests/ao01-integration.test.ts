/**
 * AO01 气井泄漏监测装置：自动识别 + 添加 + 2 路通道表的端到端回归。
 *
 * 业主 2026-11-12 给了接口文档；当天设备 `192.168.110.200` 上线后实测：
 *
 *   - `/login` 的密码是**明文**（`{"msgBody":{"username":"admin","password":"123456"}}`），
 *     不是文档写的 `md5(明文 + 'lfxs')`；传哈希会得到 `result:3` 且没有 token。
 *   - `/get_devinfo` -> devname `AO01`、dev_mac、dev_version `v2.0.0.2025-11-04`。
 *   - `/get_passageway` -> **只有 2 路**（`chinfoSize:2`，ch1 启用、ch2 关闭），
 *     不是 AE08 的固定 8 路。
 *   - `/get_samplingrate` -> 48000。
 *
 * 这条用例把上述形状固定下来：自动识别必须认成 `acousticBox`，认证必须选中
 * `token-header-plaintext`，添加时 seed 的 8 路必须被设备真实的 2 路**替换掉**。
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

/** 真机复刻：明文口令；受保护接口只接受 `Authorization: <token>`；2 路通道。 */
async function startAo01(): Promise<FakeAo01> {
  let logins = 0
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const send = (status: number, body: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    const raw = await new Promise<string>((resolve) => {
      let text = ''
      request.on('data', (chunk) => { text += chunk })
      request.on('end', () => resolve(text))
    })

    if (request.method === 'POST' && url.pathname === '/login') {
      logins += 1
      let body: { msgBody?: { password?: unknown } } = {}
      try { body = JSON.parse(raw || '{}') } catch {}
      // 只认明文 123456；哈希版本必须被拒绝，才能证明候选策略真的分得开。
      if (body.msgBody?.password !== '123456') {
        send(200, { result: 3, message: 'Incorrect username or password.-2' })
        return
      }
      send(200, { result: 0, message: 'ok', msgBody: { token: 'AO01-TOKEN' } })
      return
    }
    // 真机只认 Authorization: <token>，token: 头会返回 Token is invalid。
    if (request.headers.authorization !== 'AO01-TOKEN') {
      send(401, { result: 2, message: 'auth failed' })
      return
    }
    if (url.pathname === '/get_devinfo') {
      send(200, {
        result: 0,
        message: 'ok',
        msgBody: {
          devname: 'AO01',
          dev_version: 'v2.0.0.2025-11-04',
          dev_mac: '02:11:22:33:44:55',
          web_version: 'V1.1.0.2026-11-02'
        }
      })
      return
    }
    if (url.pathname === '/get_passageway') {
      send(200, {
        result: 0,
        message: 'ok',
        msgBody: {
          chinfoSize: 2,
          chinfoArray: [
            { dchAlarmPara: 2, dchEn: 1, dchId: 0, dchName: 'ch1', dchSensorType: 0 },
            { dchAlarmPara: 2, dchEn: 0, dchId: 1, dchName: 'ch2', dchSensorType: 0 }
          ]
        }
      })
      return
    }
    if (url.pathname === '/get_samplingrate') {
      send(200, { result: 0, message: 'ok', msgBody: { samplingrate: 48000 } })
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

describe('AO01 气井泄漏监测装置（真机形状）', () => {
  it('自动识别为声纹设备，明文口令认证，2 路通道取代 seed 的 8 路', async () => {
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
        assert.equal(
          new DeviceRepository(db).getAuthStrategy(added.id),
          'raw-auth-header-plaintext'
        )

        const channels = service.getChannels(added.id)
        assert.equal(channels.length, 2)
        assert.deepEqual(channels.map((channel) => channel.channelIndex), [0, 1])
        assert.deepEqual(
          channels.filter((channel) => channel.enabled).map((channel) => channel.channelIndex),
          [0]
        )
        assert.equal(channels[0]?.channelName, 'ch1')
        assert.equal(channels[1]?.channelName, 'ch2')
        // 明文候选被真的试过（第一次哈希被拒，第二次明文成功）。
        assert.ok(fake.loginCount() >= 2)
      } finally {
        db.close()
      }
    } finally {
      await fake.close()
    }
  })
})