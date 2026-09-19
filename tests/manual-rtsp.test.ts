/**
 * 手填 RTSP 地址给第三方相机（业主 2026-09-19 第 3 条：「② 能手填一个 RTSP 地址给第三方相机」）。
 *
 * WHY THIS FILE EXISTS
 * 这是第 10 批第 2 条「支持 RTSP 主动取流」那半句的读法确认：**不是**"无条件主动去拉本应用
 * 管理的设备"，而是给**第三方相机**手填一个地址。于是有三块必须钉住的东西：
 *
 *   1. **地址的形状判断**（`@shared/domain/rtsp-source`）：只判形状、不判可达性；
 *      口令永远打码；坏输入整条丢掉，而不是留一条永远报错的源；
 *   2. **墙的模型**：手填源与设备**共用同一套槽位**（`rtsp:` 前缀区分），一台/一条最多一格，
 *      删掉源时占用它的格一起清空，坏输入（指向不存在源的槽位）在规范化时被清掉；
 *   3. **主进程**：`startManual()` 走的是与设备那条路**完全分开**的分支 —— 它一次都不该
 *      去问设备解析器（`GET /system/video` 对一个第三方地址毫无意义）。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  MANUAL_RTSP_ID_BYTES,
  MANUAL_RTSP_MAX_LENGTH,
  MAX_MANUAL_RTSP_SOURCES,
  defaultManualRtspName,
  isManualRtspId,
  manualRtspIdFromBytes,
  maskRtspUrl,
  normaliseManualRtspSource,
  normaliseManualRtspSources,
  parseManualRtspUrl
} from '../src/shared/domain/rtsp-source'
import {
  addManualSource,
  buildCameraCells,
  clearCameraWallCells,
  createCameraWallModel,
  findCameraSlot,
  manualSourceById,
  manualSourcesOf,
  normaliseCameraWallModel,
  removeManualSource,
  setCameraWallLayout,
  updateManualSource,
  type CameraWallModel
} from '../src/renderer/src/lib/cameraWall'
import { RtspStreamService } from '../src/main/services/media/rtsp-stream'

const projectRoot = path.resolve(__dirname, '..', '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

/** 一条确定性的 id（16 字节 → `rtsp:` + 32 位十六进制）。 */
function idOf(byte: number): string {
  return manualRtspIdFromBytes(new Uint8Array(MANUAL_RTSP_ID_BYTES).fill(byte))
}

const SOURCE_A = { id: idOf(0x11), name: '大门', url: 'rtsp://192.168.1.64:554/live' }
const SOURCE_B = { id: idOf(0x22), name: '货梯', url: 'rtsp://10.0.0.9/live' }

// ---------------------------------------------------------------------------
// 1. 地址的形状
// ---------------------------------------------------------------------------

describe('手填 RTSP 地址：只判形状，不判可达性', () => {
  it('id 形状：`rtsp:` + 32 位小写十六进制', () => {
    const id = idOf(0xab)
    assert.equal(id, `rtsp:${'ab'.repeat(16)}`)
    assert.equal(id.length, 'rtsp:'.length + 32)
    assert.ok(isManualRtspId(id))
    assert.equal(isManualRtspId('rtsp:short'), false)
    assert.equal(isManualRtspId('rtsp:' + 'A'.repeat(32)), false, '大写不该被当成合法 id')
    assert.equal(isManualRtspId('dev-camera-1'), false)
    assert.equal(isManualRtspId(undefined), false)
  })

  it('合法地址：rtsp / rtsps、带端口 / 不带端口、带路径与查询、带用户名口令', () => {
    for (const good of [
      'rtsp://192.168.1.64:554/Streaming/Channels/101',
      'rtsp://192.168.1.64/live',
      'rtsps://cam.example.com:322/stream',
      'rtsp://admin:pass@192.168.1.64:554/live',
      'rtsp://192.168.1.64:554/live?channel=1'
    ]) {
      const parsed = parseManualRtspUrl(good)
      assert.equal(parsed.ok, true, good)
      assert.equal(parsed.url, good)
      assert.equal(parsed.issue, '')
    }
  })

  it('首尾空白被去掉（粘贴带进来的），中间的空格拒收', () => {
    assert.equal(parseManualRtspUrl('  rtsp://192.168.1.64/live  ').url, 'rtsp://192.168.1.64/live')
    const spaced = parseManualRtspUrl('rtsp://192.168.1.64/live stream')
    assert.equal(spaced.ok, false)
    assert.equal(spaced.issue, 'whitespace')
  })

  it('每一种形状问题都有自己的说法（不共用一句"地址无效"）', () => {
    const cases: Array<[unknown, string]> = [
      ['', 'empty'],
      ['   ', 'empty'],
      [undefined, 'empty'],
      [42, 'empty'],
      ['http://192.168.1.64/live', 'bad-scheme'],
      ['192.168.1.64/live', 'bad-scheme'],
      ['rtsp://', 'missing-host'],
      ['rtsp:///live', 'missing-host'],
      ['rtsp://host:0/live', 'bad-port'],
      ['rtsp://host:99999/live', 'bad-port'],
      ['rtsp://host:/live', 'bad-port'],
      ['rtsp://host:abc/live', 'bad-port'],
      ['rtsp://host/live\nmore', 'control-character'],
      [`rtsp://host/${'x'.repeat(MANUAL_RTSP_MAX_LENGTH)}`, 'too-long']
    ]
    for (const [input, issue] of cases) {
      const parsed = parseManualRtspUrl(input)
      assert.equal(parsed.ok, false, String(input))
      assert.equal(parsed.issue, issue, String(input))
    }
  })

  it('口令永远打码，用户名留着（它是操作员要核对的东西）', () => {
    assert.equal(
      maskRtspUrl('rtsp://admin:Hz@123456@192.168.1.64:554/live'),
      'rtsp://admin:***@192.168.1.64:554/live'
    )
    assert.equal(
      maskRtspUrl('rtsp://192.168.1.64:554/live'),
      'rtsp://192.168.1.64:554/live'
    )
    assert.equal(maskRtspUrl('rtsp://admin@192.168.1.64/live'), 'rtsp://admin@192.168.1.64/live')
  })

  it('默认名字取地址里的主机名（含端口），取不出来才回落', () => {
    assert.equal(defaultManualRtspName('rtsp://192.168.1.64:554/live'), '192.168.1.64:554')
    assert.equal(defaultManualRtspName('rtsp://admin:pass@10.0.0.9/live'), '10.0.0.9')
    assert.equal(defaultManualRtspName('nonsense'), 'RTSP')
  })

  it('规范化：坏地址整条丢掉，空名字用主机名补上', () => {
    assert.equal(normaliseManualRtspSource({ id: SOURCE_A.id, name: '', url: 'not-a-url' }), undefined)
    assert.equal(normaliseManualRtspSource({ id: 'nope', url: SOURCE_A.url }), undefined)
    const filled = normaliseManualRtspSource({ id: SOURCE_A.id, name: '  ', url: SOURCE_A.url })
    assert.equal(filled?.name, '192.168.1.64:554')

    const list = normaliseManualRtspSources([
      { id: SOURCE_A.id, name: 'A', url: SOURCE_A.url },
      { id: SOURCE_A.id, name: 'A 重复', url: SOURCE_A.url },
      { id: 'bad', name: 'B', url: SOURCE_B.url },
      null
    ])
    assert.equal(list.length, 1, '重复 id 与坏值都要丢掉')
    assert.equal(list[0]?.name, 'A')
  })

  it('上限：最多这么多条（多出来的在规范化时被截断）', () => {
    const many = Array.from({ length: MAX_MANUAL_RTSP_SOURCES + 3 }, (_, index) => ({
      id: manualRtspIdFromBytes(
        new Uint8Array(MANUAL_RTSP_ID_BYTES).map((_, at) => (at === 0 ? index : 0))
      ),
      name: `S${index}`,
      url: `rtsp://10.0.0.${index + 1}/live`
    }))
    assert.equal(normaliseManualRtspSources(many).length, MAX_MANUAL_RTSP_SOURCES)
  })
})

// ---------------------------------------------------------------------------
// 2. 墙的模型
// ---------------------------------------------------------------------------

describe('墙的模型：手填源与设备共用槽位', () => {
  function modelWithSources(): CameraWallModel {
    let model = createCameraWallModel(4)
    model = addManualSource(model, SOURCE_A)
    model = addManualSource(model, SOURCE_B)
    return model
  }

  it('加 / 改 / 删：与设备 id 在同一个数组里，但绝不互相顶掉', () => {
    let model = modelWithSources()
    assert.equal(manualSourcesOf(model).length, 2)
    assert.equal(manualSourceById(model, SOURCE_A.id)?.name, '大门')

    // 先放一台设备、再放一条手填源：两个槽位各归各的。
    model = { ...model, slots: ['dev-camera-1', SOURCE_A.id, null, null] }
    assert.equal(findCameraSlot(model, 'dev-camera-1'), 0)
    assert.equal(findCameraSlot(model, SOURCE_A.id), 1)

    // 改名字与地址。
    model = updateManualSource(model, SOURCE_A.id, { name: '大门 A', url: 'rtsp://10.1.1.1/live' })
    assert.equal(manualSourceById(model, SOURCE_A.id)?.name, '大门 A')
    assert.equal(manualSourceById(model, SOURCE_A.id)?.url, 'rtsp://10.1.1.1/live')

    // 改成坏地址 → **整条拒绝**（模型原样返回），不把一条能用的源改成永远报错的。
    const before = model
    model = updateManualSource(model, SOURCE_A.id, { url: 'http://nope' })
    assert.equal(model, before, '坏地址不该生效')

    // 删掉 SOURCE_B（它没占格）：只少一条源。
    const removedUnused = removeManualSource(model, SOURCE_B.id)
    assert.deepEqual(removedUnused.clearedSlots, [])
    assert.equal(manualSourcesOf(removedUnused.model).length, 1)
  })

  it('删掉一条**占着格**的源：那些格一起清空，出声标记也收回去', () => {
    let model = modelWithSources()
    model = { ...model, slots: [SOURCE_A.id, null, SOURCE_A.id, null], audioSlot: 2 }
    const removed = removeManualSource(model, SOURCE_A.id)
    assert.deepEqual(removed.clearedSlots, [0, 2])
    assert.deepEqual([...removed.model.slots], [null, null, null, null])
    assert.equal(removed.model.audioSlot, null)
    assert.equal(manualSourcesOf(removed.model).length, 1)
  })

  it('同一台/同一条最多一格：`findCameraSlot` 对手填 id 一样管用', () => {
    let model = modelWithSources()
    model = { ...model, slots: [SOURCE_A.id, null, null, null] }
    assert.equal(findCameraSlot(model, SOURCE_A.id), 0)
    assert.equal(findCameraSlot(model, SOURCE_B.id), -1)
  })

  it('规范化：指向不存在手填源的槽位被清掉（坏输入修成永远合法的模型）', () => {
    const normalised = normaliseCameraWallModel({
      layout: 4,
      slots: [SOURCE_A.id, 'dev-camera-1', null, null],
      audioSlot: 0,
      activeSlot: 0,
      manualSources: [SOURCE_A]
    })
    assert.deepEqual([...normalised.slots], [SOURCE_A.id, 'dev-camera-1', null, null])
    assert.equal(normalised.audioSlot, 0)

    const broken = normaliseCameraWallModel({
      layout: 4,
      slots: [SOURCE_B.id, null, null, null],
      audioSlot: 0,
      activeSlot: 0,
      manualSources: [SOURCE_A]
    })
    assert.deepEqual([...broken.slots], [null, null, null, null], '源不在列表里 → 槽位要清掉')
    assert.equal(broken.audioSlot, null, '槽位空了，出声标记也不能留着')
  })

  it('换档位不丢手填源（它们不是格子，是"可用的源"）', () => {
    let model = modelWithSources()
    model = { ...model, slots: [SOURCE_A.id, null, null, null] }
    const result = setCameraWallLayout(model, 1)
    assert.equal(manualSourcesOf(result.model).length, 2)
    assert.deepEqual([...result.model.slots], [SOURCE_A.id])
  })

  it('清空格子（离开画面墙）**不丢手填源** —— 它们是配置，不是会话', () => {
    /*
     * 这是第 11 批第 2 条带出来的一个真 bug：管理入口搬到实时监测页之后，"离开画面墙"
     * 那一趟（`clearAll`）如果照旧用 `createCameraWallModel()` 重建模型，手填源会被**当场删光**
     * —— 而它们在内存里没有第二份，界面也不会说任何话。清空的是会话（要停 ffmpeg），
     * 不是操作员刚填进去的地址。
     */
    let model = modelWithSources()
    model = { ...model, slots: [SOURCE_A.id, 'dev-camera-1', null, null], audioSlot: 0, activeSlot: 1 }
    const cleared = clearCameraWallCells(model, 4)

    // 交出去的是"清空之前占着格的那些 id"（调用方据此停会话）。
    assert.deepEqual(cleared.assigned, [SOURCE_A.id, 'dev-camera-1'])
    // 格子/出声格/当前格全归零，档位是调用方给的那一个。
    assert.deepEqual([...cleared.model.slots], [null, null, null, null])
    assert.equal(cleared.model.audioSlot, null)
    assert.equal(cleared.model.activeSlot, 0)
    assert.equal(cleared.model.layout, 4)
    // **两条源都还在**（顺序也不变）。
    assert.deepEqual(
      manualSourcesOf(cleared.model).map((source) => source.id),
      [SOURCE_A.id, SOURCE_B.id]
    )
    // 传进去的模型没有被就地改掉（纯函数：新对象）。
    assert.deepEqual([...model.slots], [SOURCE_A.id, 'dev-camera-1', null, null])
    // 交出去的那一份是**副本**：调用方之后改它不该影响原模型。
    assert.notEqual(cleared.model.manualSources, model.manualSources)
  })

  it('渲染模型：手填格显示自己的名字，状态只来自主进程那一路会话', () => {
    const model: CameraWallModel = { ...modelWithSources(), slots: [SOURCE_A.id, null, null, null] }

    // 还没开始 → idle（**不是**「设备已删除」：它压根不是设备）。
    const idle = buildCameraCells(model, { devices: [], states: {}, maxStreams: 4 })[0]
    assert.equal(idle?.deviceName, '大门')
    assert.equal(idle?.deviceId, SOURCE_A.id)
    assert.equal(idle?.status, 'idle')
    assert.equal(idle?.kind, null)

    // 主进程报 starting / playing → 带上回环地址。
    const playing = buildCameraCells(model, {
      devices: [],
      states: {
        [SOURCE_A.id]: {
          deviceId: SOURCE_A.id,
          status: 'playing',
          url: 'http://127.0.0.1:51000/token/stream.mp4',
          rtspUrl: maskRtspUrl(SOURCE_A.url)
        }
      },
      maxStreams: 4
    })[0]
    assert.equal(playing?.status, 'playing')
    assert.equal(playing?.url, 'http://127.0.0.1:51000/token/stream.mp4')

    // 主进程报错 → 把 ffmpeg 的原文带出来（那是唯一能回答"为什么连不上"的东西）。
    const failed = buildCameraCells(model, {
      devices: [],
      states: {
        [SOURCE_A.id]: {
          deviceId: SOURCE_A.id,
          status: 'error',
          error: 'rtsp://192.168.1.64:554/live: Connection refused'
        }
      },
      maxStreams: 4
    })[0]
    assert.equal(failed?.status, 'error')
    assert.match(String(failed?.messageText), /Connection refused/)
  })
})

// ---------------------------------------------------------------------------
// 3. 主进程：手填那一支一次都不问设备
// ---------------------------------------------------------------------------

interface ManualServiceOptions {
  probeOk?: boolean
  maxConcurrentStreams?: number
}

function manualService(options: ManualServiceOptions = {}): {
  service: RtspStreamService
  asked: string[]
} {
  const asked: string[] = []
  const service = new RtspStreamService({
    resolver: {
      getDevice: (id: string) => {
        asked.push(`getDevice:${id}`)
        throw new Error('手填源不该问设备')
      },
      getVideoConfig: async (id: string) => {
        asked.push(`getVideoConfig:${id}`)
        throw new Error('手填源不该问设备')
      }
    },
    spawn: (() => {
      throw new Error('这一组测试不该真的起 ffmpeg')
    }) as never,
    probe: (async () =>
      options.probeOk === false
        ? { ok: false, error: '内置 ffmpeg 不可用' }
        : { ok: true, path: 'ffmpeg' }) as never,
    firstByteTimeoutMs: 1_000,
    ...(options.maxConcurrentStreams !== undefined
      ? { maxConcurrentStreams: options.maxConcurrentStreams }
      : {})
  })
  return { service, asked }
}

describe('主进程 startManual：与设备那条路完全分开', () => {
  it('id 形状不对 → 明确拒绝（不是起一路然后失败）', async () => {
    const { service } = manualService()
    await assert.rejects(() => service.startManual('dev-camera-1', SOURCE_A.url), /id 形状不对/)
    service.dispose()
  })

  it('地址形状不对 → 明确拒绝', async () => {
    const { service } = manualService()
    await assert.rejects(() => service.startManual(SOURCE_A.id, 'http://nope'), /RTSP 地址不可用/)
    service.dispose()
  })

  it('ffmpeg 不可用：回 `ffmpeg-missing` 状态，而不是抛异常（那是一条要写在屏幕上的指令）', async () => {
    const { service, asked } = manualService({ probeOk: false })
    const state = await service.startManual(SOURCE_A.id, SOURCE_A.url)
    assert.equal(state.status, 'ffmpeg-missing')
    assert.equal(state.deviceId, SOURCE_A.id)
    assert.equal(state.rtspUrl, SOURCE_A.url, '这是打码之后的地址（本来就没有口令）')
    assert.deepEqual(asked, [], '手填这条路一次都不该去问设备')
    service.dispose()
  })

  it('并发预算满了：回 `limit-exceeded`，同样不抛异常', async () => {
    /*
     * 上限被夹进合法区间（`normaliseMaxConcurrentStreams(0)` = 1），所以"预算满"必须靠
     * **已经有一路在跑**才能构造，而那需要一整套假 ffmpeg（`tests/rtsp-stream.test.ts`
     * 里那份）。手填这一支与设备那一支**共用同一个预算判断**（`cameraStreamLimitReached`
     * + `cameraStreamLimitMessage`），那两段本身在 `tests/camera-wall.test.ts` 与
     * `tests/rtsp-stream.test.ts` 里逐条断言过，所以这里只钉"手填这条路也会走预算检查"
     * 这一件事：源码里那个判断必须在 `startManual()` 里、而且在建会话之前。
     */
    const source = read('src/main/services/media/rtsp-stream.ts')
    const start = source.slice(source.indexOf('async startManual('))
    const body = start.slice(0, start.indexOf('\n  /** Stop one camera'))
    assert.match(body, /cameraStreamLimitReached\(activeStreams, maxStreams\)/, '手填那一路没有预算检查')
    assert.ok(
      body.indexOf('cameraStreamLimitReached') < body.indexOf('new CameraLiveSession'),
      '预算检查排在建会话之后（那已经晚了）'
    )
    assert.match(body, /status: 'limit-exceeded'/, '预算满时没有回那个状态')
  })

  it('带口令的地址：状态里只有打码之后的地址', async () => {
    const { service, asked } = manualService({ probeOk: false })
    const state = await service.startManual(
      SOURCE_A.id,
      'rtsp://admin:secret@192.168.1.64:554/live'
    )
    assert.equal(state.rtspUrl, 'rtsp://admin:***@192.168.1.64:554/live')
    assert.equal(JSON.stringify(state).includes('secret'), false, '口令不许出现在状态里')
    assert.deepEqual(asked, [])
    service.dispose()
  })
})

// ---------------------------------------------------------------------------
// 4. 界面接线（源码守卫）
// ---------------------------------------------------------------------------

describe('界面接线（源码守卫）', () => {
  it('IPC：恰好给一个来源（设备 id 或手填地址），两个都给 / 都不给都拒掉', () => {
    const handlers = read('src/main/ipc/handlers.ts')
    assert.match(handlers, /const wantsManual = typeof input\?\.url === 'string'/, '没有判手填来源')
    assert.match(handlers, /wantsManual === wantsDevice/, '没有判"恰好给一个"')
    assert.match(handlers, /services\.cameraLive\.startManual\(/, '没有接上 startManual')
  })

  it('管理界面（业主第 11 批第 2 条：在实时监测页）：表单 + 列表 + 增改删，三件事都发得出去', () => {
    const sources = read('src/renderer/src/components/ManualRtspSources.vue')
    for (const hook of [
      'data-manual-rtsp-sources',
      'data-manual-rtsp-url',
      'data-manual-rtsp-name',
      'data-action="manual-rtsp-save"',
      'data-action="manual-rtsp-edit"',
      'data-action="manual-rtsp-remove"',
      'data-action="manual-rtsp-cancel-edit"',
      'data-manual-rtsp-row',
      'data-manual-rtsp-empty',
      'data-manual-rtsp-error'
    ]) {
      assert.ok(sources.includes(hook), `管理界面缺 ${hook}`)
    }
    assert.match(sources, /parseManualRtspUrl\(/, '没有用共享层的地址判据')
    assert.match(sources, /maskRtspUrl\(/, '列表里的地址没有打码')
    assert.match(sources, /crypto\.getRandomValues/, 'id 不是随机生成的')
    assert.match(sources, /manualNote/, '没有把"手册未说明"那两条口径写在界面上')
    // 删除之后要**停掉那一路会话**（源没了而 ffmpeg 还在读那个地址是一个没人看的进程）。
    assert.match(sources, /result\.toStop/, '删除之后没有去停会话')
    assert.match(sources, /window\.api\.cameraLive\.stop\(/, '没有真的调停流')
    // 管理界面**不碰画面格**：放进第几格是画面墙的事（两处各写一套迟早分叉）。
    assert.equal(
      /placeDevice/.test(sources),
      false,
      '管理界面自己往画面格里放东西了（落点规则应当只有画面墙那一处）'
    )
  })

  it('这一页真的挂在实时监测页上，而**画面墙那一侧没有入口了**', () => {
    const monitor = read('src/renderer/src/views/MonitorView.vue')
    assert.match(monitor, /import ManualRtspSources from '@renderer\/components\/ManualRtspSources\.vue'/, '实时监测页没有引入管理界面')
    assert.match(monitor, /<ManualRtspSources \/>/, '实时监测页没有挂上管理界面')
    // 挂在 `v-else` **之外**：一台设备都没有的机器照样能接一路第三方相机。
    // 判据：它是 `.page` 的**最后一个子节点**（后面只剩 `.page` 的收尾与 SFC 根标签）——
    // 也就是 `v-else` 那一块已经收完了。写 `lastIndexOf('</template>')` 会踩到根标签那个
    // （它在组件**之后**），所以这里认的是"后面还剩什么"。
    const tail = monitor.slice(monitor.indexOf('<ManualRtspSources />'))
    assert.match(
      tail,
      /^<ManualRtspSources \/>\s*<\/div>\s*<\/template>/,
      '管理界面不是 `.page` 的直接子节点（放进了"有设备才显示"的分支里）'
    )

    const wall = read('src/renderer/src/components/CameraVideoWall.vue')
    assert.equal(wall.includes('data-action="manual-rtsp-open"'), false, '画面墙上还留着手填入口')
    assert.equal(wall.includes('<ManualRtspDialog'), false, '画面墙还挂着那个对话框')
    assert.equal(
      /import ManualRtspDialog/.test(wall),
      false,
      '对话框组件已经删掉了，别处不要再引用它'
    )
    // 那个组件本身也不该再存在（搬走之后留着就是第二份实现）。
    assert.equal(
      fs.existsSync(path.join(projectRoot, 'src/renderer/src/components/ManualRtspDialog.vue')),
      false,
      'ManualRtspDialog.vue 还在（它的表单与列表已经搬到 ManualRtspSources.vue）'
    )
    // 但墙仍然**用得上**这些源：选择器里要列出它们，start 时要把地址传下去。
    assert.match(wall, /manualSuffix/, '选择器里的手填源没有标记')
    assert.match(
      wall,
      /manual \? \{ sourceId: manual\.id, url: manual\.url \} : \{ deviceId \}/,
      'start 时没有把地址传给主进程'
    )
  })

  it('store：手填源不进 localStorage（口令不能落盘），而且清空格子时留着它们', () => {
    const store = read('src/renderer/src/stores/liveWall.ts')
    assert.match(store, /const manualSources = computed\(\(\) => manualSourcesOf\(model\.value\)\)/)
    assert.match(store, /isManualRtspId\(deviceId\)\) continue/, 'syncDevices 会把手填格当已删设备清掉')
    assert.match(store, /manualSourcesOf\(model\.value\)/, '没有从模型里读手填源')
    // `clearAll` 走的是"保源清格"那一个纯函数，不是重建模型。
    assert.match(store, /clearCameraWallCells\(model\.value, layoutToKeep\)/, '清空格子会把源一起删掉')
    // 手填源**没有**被写进 localStorage（只有档位与视图对象写盘）。
    assert.equal(
      /localStorage\.setItem\([^)]*manual/i.test(store),
      false,
      '手填源被写进 localStorage 了（它常带口令）'
    )
  })
})
