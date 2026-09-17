/**
 * FA371 相机固件升级的单元测试。
 *
 * 这一项是"最危险的功能"：它把一个几十 MB 的固件包写进设备，写错了设备会变砖。
 * 所以这里测的不是"函数返回了什么"，而是三件**结构上**必须成立的事：
 *
 *   1. **multipart 报文的形状**：起一个本地 `node:http` 桩服务，让**真实的上传代码**
 *      把包发给它，然后在收到的**原始字节**上逐段断言 —— 字段名（一个空名字 +
 *      一个 `file`）、段的顺序、元数据 JSON、包字节、`Content-Length`。这是唯一能
 *      证明"报文对了"又不碰真机的办法（真机上跑一次就是一次刷机）。
 *   2. **进度是真字节数**：断言推出来的 `sentBytes` 单调不减、最后一个等于桩服务
 *      收到的字节数，并且一个 2 MB 的包产生了**多次**进度 —— 一次性把整个包写出去的
 *      实现在这条断言下活不下来（文件必须是流式读的）。
 *   3. **上传永远不会重启设备**：桩服务上不允许出现任何 `PUT /reboot`，假客户端的
 *      `reboot()` 计数必须保持 0。
 *
 * 另外覆盖文件名规则（设备自己那条 `_V<数字>.<数字>.<数字>`）、失败路径
 * （非 200、HTTP 200 但 `ret:401`、HTTP 200 却是网页、文件名不合格）与
 * `GET /progress` 的原样映射。
 */

import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import {
  CAMERA_UPGRADE_FILE_FIELD,
  CAMERA_UPGRADE_META_FIELD,
  CAMERA_UPGRADE_UPLOAD_PATH,
  CameraUpgradeService,
  buildUpgradeMultipartPlan,
  type CameraUpgradeOperations
} from '../src/main/services/device/fa371/camera-upgrade-service'
import {
  cameraUpgradeSuffix,
  isAcceptableCameraUpgradePackageName,
  type CameraUpgradeProgressEvent
} from '../src/shared/domain/camera-upgrade'
import type { Fa371UpgradeProgressDto } from '../src/main/services/device/fa371/dto'
import { AppError, ErrorCodes } from '../src/shared/errors'

// ---------------------------------------------------------------------------
// 临时文件（测试自己造包，绝不碰真机的升级包）
// ---------------------------------------------------------------------------

const workDir = mkdtempSync(path.join(tmpdir(), 'camera-upgrade-'))
after(() => rmSync(workDir, { recursive: true, force: true }))

/** 造一个内容确定的临时文件，返回路径与字节。 */
function makePackage(fileName: string, bytes: Buffer): { filePath: string; bytes: Buffer } {
  const filePath = path.join(workDir, fileName)
  writeFileSync(filePath, bytes)
  return { filePath, bytes }
}

/** 造一个 2 MB 的包：足够大，能证明上传是**分段**写出去的。 */
function makeLargePackage(fileName: string): { filePath: string; bytes: Buffer } {
  const bytes = Buffer.alloc(2 * 1024 * 1024)
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251
  return makePackage(fileName, bytes)
}

const REAL_PACKAGE_NAME = 'FE128_ROBOT_PLUS_upgrade_pkg_RK3568_v2.0.11'

// ---------------------------------------------------------------------------
// 本地桩服务：真实 socket，真实字节
// ---------------------------------------------------------------------------

interface StubRequest {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: Buffer
}

interface StubResponse {
  status: number
  body: string
  contentType: string
}

interface StubServer {
  url: string
  requests: StubRequest[]
  /** 改这一次请求要回的响应（默认 200 + `{"msg":"SUCCESS","ret":200}`）。 */
  state: StubResponse
  close(): Promise<void>
}

async function startStub(): Promise<StubServer> {
  const requests: StubRequest[] = []
  const state: StubResponse = {
    status: 200,
    body: '{"msg":"SUCCESS","ret":200}',
    contentType: 'application/json'
  }

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks)
      })
      response.writeHead(state.status, { 'Content-Type': state.contentType })
      response.end(state.body)
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object', '桩服务没有拿到端口')

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    state,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  }
}

// ---------------------------------------------------------------------------
// multipart 解析（在**收到的原始字节**上做，与设备后端做的事同一类）
// ---------------------------------------------------------------------------

interface ParsedPart {
  /** `Content-Disposition` 里的 `name`；空字段名会解析成空串。 */
  name: string
  filename?: string
  contentType?: string
  /** 段的原始头文本，用来断言段头本身。 */
  headerText: string
  value: Buffer
}

function parseMultipart(body: Buffer, boundary: string): ParsedPart[] {
  const delimiter = Buffer.from(`--${boundary}`)
  const positions: number[] = []
  let cursor = 0
  for (;;) {
    const found = body.indexOf(delimiter, cursor)
    if (found === -1) break
    positions.push(found)
    cursor = found + delimiter.length
  }

  const parts: ParsedPart[] = []
  for (let index = 0; index < positions.length - 1; index += 1) {
    const start = (positions[index] ?? 0) + delimiter.length
    const end = positions[index + 1] ?? 0
    let chunk = body.subarray(start, end)
    if (chunk.subarray(0, 2).toString('utf8') === '\r\n') chunk = chunk.subarray(2)
    if (chunk.subarray(chunk.length - 2).toString('utf8') === '\r\n') {
      chunk = chunk.subarray(0, chunk.length - 2)
    }

    const headerEnd = chunk.indexOf('\r\n\r\n')
    assert.ok(headerEnd > 0, 'multipart 的段没有头部终止符')
    const headerText = chunk.subarray(0, headerEnd).toString('utf8')
    const name = /name="([^"]*)"/.exec(headerText)?.[1] ?? ''
    const filename = /filename="([^"]*)"/.exec(headerText)?.[1]
    const contentType = /Content-Type: ([^\r\n]+)/.exec(headerText)?.[1]

    parts.push({
      name,
      ...(filename !== undefined ? { filename } : {}),
      ...(contentType !== undefined ? { contentType } : {}),
      headerText,
      value: chunk.subarray(headerEnd + 4)
    })
  }
  return parts
}

/** 从 `Content-Type` 头里取边界；没有边界说明报文根本没法解析。 */
function boundaryOf(headers: http.IncomingHttpHeaders): string {
  const header = String(headers['content-type'] ?? '')
  const match = /boundary=(.+)$/.exec(header)
  assert.ok(match, `Content-Type 里没有 multipart 边界：${header}`)
  return match[1] as string
}

// ---------------------------------------------------------------------------
// 假客户端（只满足 `CameraUpgradeOperations`，不碰真设备）
// ---------------------------------------------------------------------------

interface FakeClient extends CameraUpgradeOperations {
  rebootCalls: number
  sessionCalls: number
}

function createFakeClient(options: {
  baseUrl: string
  headers?: Record<string, string>
  progress?: Fa371UpgradeProgressDto
  rebootError?: unknown
}): FakeClient {
  const client: FakeClient = {
    currentBaseUrl: options.baseUrl,
    rebootCalls: 0,
    sessionCalls: 0,
    authHeaders: (): Record<string, string> => options.headers ?? {},
    ensureSession: async (): Promise<void> => {
      client.sessionCalls += 1
    },
    getUpgradeProgress: async (): Promise<Fa371UpgradeProgressDto> => options.progress ?? {},
    reboot: async (): Promise<void> => {
      client.rebootCalls += 1
      if (options.rebootError !== undefined) throw options.rebootError
    }
  }
  return client
}

// ---------------------------------------------------------------------------
// 设备自己的文件名规则
// ---------------------------------------------------------------------------

describe('升级包文件名规则（设备自己那条）', () => {
  it('接受以 _V<数字>.<数字>.<数字> 结尾的名字', () => {
    assert.equal(isAcceptableCameraUpgradePackageName(REAL_PACKAGE_NAME), true)
    assert.equal(cameraUpgradeSuffix(REAL_PACKAGE_NAME), 'v2.0.11')
    // 设备是先取最后一段再 toLowerCase 再匹配，所以大写 V 与多段数字都要过。
    assert.equal(isAcceptableCameraUpgradePackageName('FE128_upgrade_V2.0.11'), true)
    assert.equal(isAcceptableCameraUpgradePackageName('pkg_v10.20.30'), true)
  })

  it('拒绝两段版本号', () => {
    assert.equal(isAcceptableCameraUpgradePackageName('FE128_upgrade_pkg_v2.0'), false)
    assert.equal(cameraUpgradeSuffix('FE128_upgrade_pkg_v2.0'), 'v2.0')
  })

  it('拒绝缺少 V 的三段数字', () => {
    assert.equal(isAcceptableCameraUpgradePackageName('FE128_upgrade_pkg_2.0.11'), false)
  })

  it('拒绝没有后缀的压缩包名', () => {
    assert.equal(isAcceptableCameraUpgradePackageName('package.zip'), false)
    assert.equal(cameraUpgradeSuffix('package.zip'), 'package.zip')
  })

  it('拒绝根本没有后缀（无下划线、或下划线结尾）的名字', () => {
    assert.equal(isAcceptableCameraUpgradePackageName('firmware'), false)
    assert.equal(isAcceptableCameraUpgradePackageName('FE128_upgrade_'), false)
    assert.equal(cameraUpgradeSuffix('FE128_upgrade_'), '')
  })

  it('路径不参与判定（设备拿到的是文件名）', () => {
    assert.equal(isAcceptableCameraUpgradePackageName(`C:\\packages\\${REAL_PACKAGE_NAME}`), true)
  })
})

// ---------------------------------------------------------------------------
// 读包的事实
// ---------------------------------------------------------------------------

describe('升级包在本机的事实', () => {
  it('给出文件名、大小、sha256 与设备规则判定', async () => {
    const bytes = Buffer.from('fake-upgrade-payload', 'utf8')
    const { filePath } = makePackage(REAL_PACKAGE_NAME, bytes)
    const service = new CameraUpgradeService({ clientFor: () => createFakeClient({ baseUrl: 'http://127.0.0.1:1' }) })

    const pkg = await service.inspectPackage(filePath)

    assert.equal(pkg.fileName, REAL_PACKAGE_NAME)
    assert.equal(pkg.sizeBytes, bytes.length)
    assert.equal(pkg.suffix, 'v2.0.11')
    assert.equal(pkg.nameAccepted, true)
    // sha256 独立算一遍：界面拿它跟厂家发布的值核对，算错了等于白核对。
    assert.equal(pkg.sha256, createHash('sha256').update(bytes).digest('hex'))
    assert.equal(pkg.path, filePath)
  })

  it('文件名不合格时如实标记（不在这一步抛错，界面要能把它显示出来）', async () => {
    const { filePath } = makePackage('upgrade_v2.0', Buffer.from('x'))
    const service = new CameraUpgradeService({ clientFor: () => createFakeClient({ baseUrl: 'http://127.0.0.1:1' }) })

    const pkg = await service.inspectPackage(filePath)
    assert.equal(pkg.nameAccepted, false)
    assert.equal(pkg.suffix, 'v2.0')
  })

  it('路径不存在时报 VALIDATION_ERROR，而不是抛一个底层 ENOENT', async () => {
    const service = new CameraUpgradeService({ clientFor: () => createFakeClient({ baseUrl: 'http://127.0.0.1:1' }) })
    await assert.rejects(
      () => service.inspectPackage(path.join(workDir, 'nope_v1.0.0')),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.equal(error.code, ErrorCodes.VALIDATION_ERROR)
        return true
      }
    )
  })
})

// ---------------------------------------------------------------------------
// multipart 报文（本地桩服务上逐字节断言）
// ---------------------------------------------------------------------------

describe('上传报文（本地 node:http 桩服务）', () => {
  it('两个段：空字段名的元数据 + file 的包字节', async () => {
    const stub = await startStub()
    try {
      const { filePath, bytes } = makePackage(REAL_PACKAGE_NAME, Buffer.from('PK\u0003\u0004payload', 'binary'))
      const client = createFakeClient({ baseUrl: stub.url, headers: { Authorization: 'token-abc' } })
      const service = new CameraUpgradeService({ clientFor: () => client })

      const result = await service.upload('cam-1', filePath)

      assert.equal(stub.requests.length, 1, '一次上传只允许一个请求')
      const request = stub.requests[0]
      assert.ok(request)
      assert.equal(request.method, 'POST')
      assert.equal(request.url, CAMERA_UPGRADE_UPLOAD_PATH)
      assert.equal(request.headers.authorization, 'token-abc', '会话凭据必须带上')

      const boundary = boundaryOf(request.headers)
      assert.match(
        String(request.headers['content-type']),
        /^multipart\/form-data; boundary=/,
        'Content-Type 必须是 multipart/form-data 且带边界'
      )

      const parts = parseMultipart(request.body, boundary)
      assert.equal(parts.length, 2, `报文必须正好两段，实际 ${parts.length} 段`)

      const meta = parts[0]
      const file = parts[1]
      assert.ok(meta && file)

      // 第一段：**空字段名** + 元数据 JSON（设备自带前端就是 fd.append('', ...)）。
      assert.equal(CAMERA_UPGRADE_META_FIELD, '')
      assert.equal(meta.name, '', '元数据段的字段名必须是空串')
      assert.equal(meta.headerText, 'Content-Disposition: form-data; name=""')
      assert.equal(meta.value.toString('utf8'), `{"file_size":${bytes.length}}`)
      // 元数据段不带 Content-Type：浏览器对 FormData 里的字符串也不带。
      assert.equal(meta.contentType, undefined)

      // 第二段：`file` + 原始字节。
      assert.equal(CAMERA_UPGRADE_FILE_FIELD, 'file')
      assert.equal(file.name, 'file')
      assert.equal(file.filename, REAL_PACKAGE_NAME)
      assert.equal(file.contentType, 'application/octet-stream')
      assert.match(file.headerText, /^Content-Disposition: form-data; name="file"; filename="/)
      assert.equal(file.value.length, bytes.length)
      assert.ok(file.value.equals(bytes), '收到的包字节必须与文件完全一致')

      // 声明长度与实际长度必须一致：否则设备后端会在等一个永远不来的字节。
      assert.equal(Number(request.headers['content-length']), request.body.length)
      assert.equal(result.status, 200)
      assert.equal(result.sizeBytes, bytes.length)
      assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'))
      assert.equal(result.fileName, REAL_PACKAGE_NAME)
    } finally {
      await stub.close()
    }
  })

  it('段的顺序是"元数据在前、包在后"（与设备自带前端一致）', () => {
    const plan = buildUpgradeMultipartPlan({
      boundary: 'BOUNDARY',
      fileName: REAL_PACKAGE_NAME,
      sizeBytes: 7
    })
    const header = plan.header.toString('utf8')

    const metaIndex = header.indexOf('name=""')
    const fileIndex = header.indexOf('name="file"')
    assert.ok(metaIndex >= 0 && fileIndex > metaIndex, '元数据段必须排在文件段之前')
    assert.ok(header.startsWith('--BOUNDARY\r\n'), '起始块必须从一个边界行开始')
    // 元数据 JSON 就在起始块里，字节数原样。
    assert.match(header, /\r\n\r\n\{"file_size":7\}\r\n/)
    // 结束块：`\r\n--BOUNDARY--\r\n`
    assert.equal(plan.footer.toString('utf8'), '\r\n--BOUNDARY--\r\n')
    // 总长度 = 起始块 + 包 + 结束块。
    assert.equal(plan.contentLength, plan.header.length + 7 + plan.footer.length)
  })

  it('2 MB 的包是**分段**写出去的，进度是真实字节数', async () => {
    const stub = await startStub()
    try {
      const { filePath, bytes } = makeLargePackage(REAL_PACKAGE_NAME)
      const service = new CameraUpgradeService({
        clientFor: () => createFakeClient({ baseUrl: stub.url })
      })

      const events: CameraUpgradeProgressEvent[] = []
      const result = await service.upload('cam-1', filePath, (event) => events.push(event))

      assert.ok(events.length >= 4, `分段写出必须产生多次进度，实际只有 ${events.length} 次`)
      // 单调不减，且最后一个就是全部请求体。
      for (let index = 1; index < events.length; index += 1) {
        const previous = events[index - 1]
        const current = events[index]
        assert.ok(previous && current)
        assert.ok(current.sentBytes >= previous.sentBytes, '进度不得回退')
      }
      const last = events[events.length - 1]
      const first = events[0]
      assert.ok(first && last)
      assert.ok(first.sentBytes > 0)

      const request = stub.requests[0]
      assert.ok(request)
      assert.equal(last.sentBytes, request.body.length, '最后一次进度必须等于实际写出的字节数')
      assert.equal(last.totalBytes, request.body.length)
      assert.equal(last.packageBytes, bytes.length)
      assert.equal(last.percent, 100)
      assert.equal(last.deviceId, 'cam-1')
      // 每个事件的包大小都是同一个数字，界面不做算术。
      for (const event of events) {
        assert.equal(event.packageBytes, bytes.length)
        assert.equal(event.deviceId, 'cam-1')
      }
      assert.equal(result.status, 200)
    } finally {
      await stub.close()
    }
  })

  it('**上传永远不会重启设备**：桩服务上没有 PUT，假客户端的 reboot 一次都没被调用', async () => {
    const stub = await startStub()
    try {
      const { filePath } = makePackage(REAL_PACKAGE_NAME, Buffer.from('payload'))
      const client = createFakeClient({ baseUrl: stub.url })
      const service = new CameraUpgradeService({ clientFor: () => client })

      await service.upload('cam-1', filePath)

      assert.equal(client.rebootCalls, 0, '上传路径上不允许出现任何 reboot 调用')
      assert.equal(
        stub.requests.filter((request) => request.method === 'PUT').length,
        0,
        '上传期间不得向设备发出任何 PUT（重启是另一个显式动作）'
      )
      assert.equal(
        stub.requests.filter((request) => request.url.includes('reboot')).length,
        0,
        '上传期间不得碰 /reboot'
      )
      assert.equal(stub.requests.length, 1)
    } finally {
      await stub.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 失败路径
// ---------------------------------------------------------------------------

describe('上传失败路径', () => {
  it('非 200 应答变成带状态码的真实失败', async () => {
    const stub = await startStub()
    try {
      stub.state.status = 507
      stub.state.body = '{"msg":"no space left","ret":-1}'
      const { filePath } = makePackage(REAL_PACKAGE_NAME, Buffer.from('payload'))
      const service = new CameraUpgradeService({
        clientFor: () => createFakeClient({ baseUrl: stub.url })
      })

      await assert.rejects(
        () => service.upload('cam-1', filePath),
        (error: unknown) => {
          assert.ok(error instanceof AppError, `期望 AppError，实际是 ${String(error)}`)
          assert.equal(error.code, ErrorCodes.DEVICE_ERROR)
          assert.match(error.message, /507/)
          return true
        }
      )
    } finally {
      await stub.close()
    }
  })

  it('HTTP 200 但正文是 {"ret":401}（实测的未认证形状）必须报失败', async () => {
    const stub = await startStub()
    try {
      // 真机实测：未认证时设备回的是 **HTTP 200** + `{"msg":"No Auth","ret":401}`。
      // 只看状态码会把"根本没认证"报成"上传成功"。
      stub.state.status = 200
      stub.state.body = '{"msg":"No Auth","ret":401}'
      const { filePath } = makePackage(REAL_PACKAGE_NAME, Buffer.from('payload'))
      const service = new CameraUpgradeService({
        clientFor: () => createFakeClient({ baseUrl: stub.url })
      })

      await assert.rejects(
        () => service.upload('cam-1', filePath),
        (error: unknown) => {
          assert.ok(error instanceof AppError)
          assert.equal(error.code, ErrorCodes.DEVICE_ERROR)
          assert.match(error.message, /No Auth/)
          return true
        }
      )
    } finally {
      await stub.close()
    }
  })

  it('HTTP 200 但正文是网页（SPA 兜底）→ INVALID_RESPONSE', async () => {
    const stub = await startStub()
    try {
      stub.state.status = 200
      stub.state.body = '<!doctype html><html><body>index</body></html>'
      stub.state.contentType = 'text/html'
      const { filePath } = makePackage(REAL_PACKAGE_NAME, Buffer.from('payload'))
      const service = new CameraUpgradeService({
        clientFor: () => createFakeClient({ baseUrl: stub.url })
      })

      await assert.rejects(
        () => service.upload('cam-1', filePath),
        (error: unknown) => {
          assert.ok(error instanceof AppError)
          assert.equal(error.code, ErrorCodes.INVALID_RESPONSE)
          return true
        }
      )
    } finally {
      await stub.close()
    }
  })

  it('文件名不符合设备规则时**一个字节都不发**', async () => {
    const stub = await startStub()
    try {
      const { filePath } = makePackage('upgrade_v2.0', Buffer.from('payload'))
      const service = new CameraUpgradeService({
        clientFor: () => createFakeClient({ baseUrl: stub.url })
      })

      await assert.rejects(
        () => service.upload('cam-1', filePath),
        (error: unknown) => {
          assert.ok(error instanceof AppError)
          assert.equal(error.code, ErrorCodes.VALIDATION_ERROR)
          assert.match(error.message, /v2\.0/)
          return true
        }
      )
      assert.equal(stub.requests.length, 0, '设备会拒收的包不该白传几十 MB')
    } finally {
      await stub.close()
    }
  })

  it('设备不可达时报 NETWORK_ERROR，而不是把底层异常漏出去', async () => {
    // 起一个桩服务再关掉：那个端口一定是"拒绝连接"，比挑一个固定端口可靠。
    const stub = await startStub()
    const deadUrl = stub.url
    await stub.close()

    const service = new CameraUpgradeService({
      clientFor: () => createFakeClient({ baseUrl: deadUrl })
    })
    const { filePath } = makePackage(REAL_PACKAGE_NAME, Buffer.from('payload'))

    await assert.rejects(
      () => service.upload('cam-1', filePath),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.equal(error.code, ErrorCodes.NETWORK_ERROR)
        return true
      }
    )
  })
})

// ---------------------------------------------------------------------------
// GET /progress 与 PUT /reboot
// ---------------------------------------------------------------------------

describe('设备侧进度与重启', () => {
  it('GET /progress 的数值原样交出，不做任何换算', async () => {
    const service = new CameraUpgradeService({
      clientFor: () =>
        createFakeClient({
          baseUrl: 'http://127.0.0.1:1',
          // 真机只读实测（空闲）：{"msg":"SUCCESS","ret":200,"upgrade_progress":-2.0}
          progress: { ret: 200, msg: 'SUCCESS', upgrade_progress: -2 }
        })
    })

    const progress = await service.readProgress('cam-1')
    assert.equal(progress.raw, -2, '含义没有文档的数字必须原样给出')
    assert.equal(progress.deviceMessage, 'SUCCESS')
  })

  it('设备没回这个字段时保持缺省，不编 0', async () => {
    const service = new CameraUpgradeService({
      clientFor: () =>
        createFakeClient({ baseUrl: 'http://127.0.0.1:1', progress: { ret: 200, msg: 'SUCCESS' } })
    })

    const progress = await service.readProgress('cam-1')
    assert.equal(progress.raw, undefined)
    assert.equal(progress.deviceMessage, 'SUCCESS')
  })

  it('重启只有显式调用才发生，且拿到应答时如实标记', async () => {
    const client = createFakeClient({ baseUrl: 'http://127.0.0.1:1' })
    const service = new CameraUpgradeService({ clientFor: () => client })

    const result = await service.reboot('cam-1')
    assert.equal(client.rebootCalls, 1)
    assert.deepEqual(result, { deviceId: 'cam-1', acknowledged: true, connectionDropped: false })
  })

  it('设备在应答前断开 → connectionDropped，而不是报成失败', async () => {
    const service = new CameraUpgradeService({
      clientFor: () =>
        createFakeClient({
          baseUrl: 'http://127.0.0.1:1',
          rebootError: new AppError(ErrorCodes.NETWORK_ERROR, '无法连接到设备')
        })
    })

    const result = await service.reboot('cam-1')
    assert.equal(result.acknowledged, false)
    assert.equal(result.connectionDropped, true)
    assert.equal(result.deviceId, 'cam-1')
  })

  it('重启的其它失败照原样抛出（不吞成"已发出"）', async () => {
    const service = new CameraUpgradeService({
      clientFor: () =>
        createFakeClient({
          baseUrl: 'http://127.0.0.1:1',
          rebootError: new AppError(ErrorCodes.AUTH_FAILED, '设备拒绝认证')
        })
    })

    await assert.rejects(
      () => service.reboot('cam-1'),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.equal(error.code, ErrorCodes.AUTH_FAILED)
        return true
      }
    )
  })
})
