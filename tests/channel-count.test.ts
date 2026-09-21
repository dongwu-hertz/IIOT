/**
 * 「界面该显示的通道数」的归因规则回归测试。
 *
 * WHY THIS FILE EXISTS
 * `resolveChannelCount()` 原本住在 `lib/channelWall.ts`，由通道墙的测试
 * （`tests/channel-wall-status.test.ts`）钉住。通道墙功能删除后，这个函数迁到
 * `lib/channelCount.ts`，而它的判定仍然由两个页面依赖：`DeviceDetailView.vue`
 * （设备详情概览里的通道数）与 `AddDeviceDialog.vue`（探测结果里的通道数）。
 * 「通道表是权威、等于协议常量的回报不可归因、相机的 0 是产品事实」这三条规则
 * 一旦被改松，界面就会重新显示一个我们没收到的数字（2 路盒子显示「通道数 8」
 * 就是那条旧缺陷），所以判定必须在没有浏览器的情况下可断言。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { resolveChannelCount } from '../src/renderer/src/lib/channelCount'
import { CHANNEL_COUNT } from '../src/shared/domain/models'

const projectRoot = path.resolve(__dirname, '..', '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

/** 源码守卫读的是「活的代码」而不是注释：注释里提到旧写法不算数。 */
function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*')
    })
    .join('\n')
}

describe('resolveChannelCount()：通道表是权威，设备回报只是兜底', () => {
  it('通道表两行就是 2 路 —— 2 路盒子原来显示「通道数 8」的那个缺陷', () => {
    const resolved = resolveChannelCount({ channelTableCount: 2, deviceReportedCount: 8 })
    assert.deepEqual(resolved, { count: 2, source: 'channelTable' })
  })

  it('通道表八行就是 8 路（真机 AE08）', () => {
    assert.deepEqual(resolveChannelCount({ channelTableCount: 8, deviceReportedCount: 8 }), {
      count: 8,
      source: 'channelTable'
    })
  })

  it('通道表还没读到、回报正好是协议常量：不显示数字（不能归因于设备）', () => {
    // `GET /get_devinfo` 实测没有通道数字段，`mapDeviceInfo()` 在缺失时会填
    // CHANNEL_COUNT，所以这个 8 完全可能是映射写的 —— 不显示它才是如实的。
    assert.deepEqual(resolveChannelCount({ deviceReportedCount: CHANNEL_COUNT }), {
      count: null,
      source: 'unreported'
    })
    assert.deepEqual(resolveChannelCount({ channelTableCount: 0, deviceReportedCount: 8 }), {
      count: null,
      source: 'unreported'
    })
  })

  it('回报一个不等于协议常量的值：那只能是设备报的，显示它', () => {
    assert.deepEqual(resolveChannelCount({ deviceReportedCount: 4 }), {
      count: 4,
      source: 'deviceReport'
    })
    assert.deepEqual(resolveChannelCount({ channelTableCount: null, deviceReportedCount: 2 }), {
      count: 2,
      source: 'deviceReport'
    })
  })

  it('什么都没读到：没有数字，来源是「未上报」', () => {
    assert.deepEqual(resolveChannelCount({}), { count: null, source: 'unreported' })
    assert.deepEqual(resolveChannelCount({ channelTableCount: null, deviceReportedCount: null }), {
      count: null,
      source: 'unreported'
    })
  })

  it('声学相机没有通道：0 是产品事实，不是「没读到」，也不是协议兜底', () => {
    // 主进程的 `syntheticCameraInfo()` 给相机的 `channelCount` 就是 0，那个 0 说的是
    // 「这台设备没有通道这个概念」。把它归进 `unreported` 会让界面写「设备未上报通道数」，
    // 那是另一件事（缺陷），而 `mapDeviceInfo()` 的协议常量 8 更不能出现在相机上。
    assert.deepEqual(resolveChannelCount({ deviceReportedCount: 0, deviceKind: 'acousticCamera' }), {
      count: 0,
      source: 'noChannels'
    })
    // 相机拿不到通道表，所以这条路就是它的正常路径。
    assert.deepEqual(
      resolveChannelCount({ channelTableCount: null, deviceReportedCount: 0, deviceKind: 'acousticCamera' }),
      { count: 0, source: 'noChannels' }
    )
    // 声纹设备的 0 仍然是「没有可信数字」：相机那条路绝不能外溢到它。
    assert.deepEqual(resolveChannelCount({ deviceReportedCount: 0, deviceKind: 'acousticBox' }), {
      count: null,
      source: 'unreported'
    })
    // 通道表优先于家族：相机将来若真有通道表，也以表为准。
    assert.deepEqual(
      resolveChannelCount({ channelTableCount: 2, deviceKind: 'acousticCamera' }),
      { count: 2, source: 'channelTable' }
    )
  })

  it('0 / 负数 / 小数 / NaN / 非有限值一律不算一个数', () => {
    for (const bad of [0, -1, -8, 2.5, NaN, Infinity, -Infinity]) {
      assert.deepEqual(
        resolveChannelCount({ channelTableCount: bad }),
        { count: null, source: 'unreported' },
        `${String(bad)} 被当成了一个通道数`
      )
      assert.deepEqual(
        resolveChannelCount({ deviceReportedCount: bad }),
        { count: null, source: 'unreported' },
        `${String(bad)} 被当成了一个通道数`
      )
    }
  })

  it('通道表永远是权威来源：设备回报更小也不采纳', () => {
    assert.deepEqual(resolveChannelCount({ channelTableCount: 8, deviceReportedCount: 2 }), {
      count: 8,
      source: 'channelTable'
    })
  })
})

describe('设备详情 / 添加设备：通道数的来源', () => {
  it('设备详情页用 resolveChannelCount()，并且把通道表放在前面', () => {
    const source = stripComments(read('src/renderer/src/views/DeviceDetailView.vue'))
    assert.match(source, /resolveChannelCount\(\{/)
    assert.match(source, /channelTableCount: config\.channels\.length/)
    // 旧写法（设备回报优先）不许回来。
    assert.equal(
      /channelCountFromDevice\.value \?\?/.test(source),
      false,
      '设备详情页又把设备回报的通道数排在通道表前面了'
    )
  })

  it('添加设备对话框不再直接渲染探测回来的通道数', () => {
    const source = stripComments(read('src/renderer/src/components/AddDeviceDialog.vue'))
    assert.match(source, /probeChannelCount\.count/)
    assert.equal(
      /probeInfo\?\.channelCount \?\? '—'/.test(source),
      false,
      '添加设备对话框又直接把设备回报的通道数渲染出来了'
    )
    assert.match(source, /t\('addDeviceUi\.channelCountUnreported'\)/)
  })
})
