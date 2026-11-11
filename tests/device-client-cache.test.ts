/**
 * 设备客户端**复用**回归（声纹盒子 / 声学相机）。
 *
 * WHY THIS FILE EXISTS
 * `DeviceService` 把三个家系的客户端缓存在 `runtime` 里，判据必须是「建客户端时
 * **传入的**归一化基地址」。两个客户端类（`DeviceApiClient` / `Fa371ApiClient`）
 * 都在构造函数里把 `ip:port` 归一化成 `http://ip`，而设备记录里的地址是裸的
 * `ip:port` —— 拿 `currentBaseUrl` 直接比**永远不相等**。
 *
 * 后果不是"慢一点"：健康检查、检测日志轮询、页面的每次操作都会 new 一个客户端、
 * 重新登录一次。2026-11-11 的真机日志里 8 分钟一台相机登录 171 次；相机内嵌
 * HTTP 栈被拖垮后，用户看到的是「认证失败」与「请求超时」，两台相机也无法同时上墙。
 *
 * 这组用例用**真的** `DeviceService` + 真的 HTTP 服务器（只把设备那一侧做成假的），
 * 断言"两次读配置只登录一次"。
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

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'device-client-cache-'))
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

interface FakeCamera {
  port: number
  loginCount: () => number
  close(): Promise<void>
}

/** 一台最小可用的声学相机：登录、`/system`（受保护）与 `/system/video`。 */
async function startFakeCamera(): Promise<FakeCamera> {
  let logins = 0
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const send = (status: number, body: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (request.method === 'POST' && url.pathname === '/login') {
      logins += 1
      send(200, { token: 'TEST-TOKEN' })
      return
    }
    // 真机实测：`/system/detect_status` 不带 token 也回 200（登录验证不能用它）。
    if (url.pathname === '/system/detect_status') {
      send(200, { detect_status: 0 })
      return
    }
    if (request.headers.authorization !== 'TEST-TOKEN') {
      send(200, { msg: 'No Auth', ret: 401 })
      return
    }
    if (url.pathname === '/system/video') {
      send(200, {
        ret: 200,
        msg: 'SUCCESS',
        rtsp_enabled: 1,
        video_port: 443,
        video_url: 'live'
      })
      return
    }
    send(200, { ret: 200, msg: 'SUCCESS' })
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

describe('DeviceService 客户端复用', () => {
  it('相机的两次 /system/video 只登录一次（不再每次调用都重登）', async () => {
    const fake = await startFakeCamera()
    try {
      const { service, db } = createService()
      try {
        const added = await service.add({
          name: 'Camera',
          ip: '127.0.0.1',
          httpPort: fake.port,
          username: 'admin',
          password: '123456',
          kind: 'acousticCamera'
        })
        // 添加时的探活本身登录一次（一次性客户端，不进入运行时缓存）。
        assert.equal(fake.loginCount(), 1)

        const first = await service.getCameraVideoConfig(added.id)
        assert.equal(first.rtspPort, 443)
        assert.equal(fake.loginCount(), 2, '第一次读配置应建立运行时客户端并登录一次')

        const second = await service.getCameraVideoConfig(added.id)
        assert.equal(second.rtspPath, 'live')
        assert.equal(fake.loginCount(), 2, '第二次必须复用同一个客户端，不得再登录')
      } finally {
        db.close()
      }
    } finally {
      await fake.close()
    }
  })
})