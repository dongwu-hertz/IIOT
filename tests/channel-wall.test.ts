/**
 * 通道墙的分屏 / 分页 / 图形逻辑与格子模型的回归测试。
 *
 * WHY THIS FILE EXISTS
 * 「通道墙支持 1、2、4、8 通道，可以切换显示不同的图形，没有通道在线就默认收起」
 * 这件事的难点不在画面，而在算数：
 *   - 8 档到底是不是真的有 8 个槽位；
 *   - 格子比一页多的时候，第二页只画剩下的那几个，而不是补一排空格；
 *   - **删掉一台设备后，停留在一个已经不存在的页码上怎么办** —— 这是分页最现实的
 *     故障：界面会显示“第 3 / 1 页”，然后一格都不画，看起来像通道全丢了；
 *   - **“有没有通道在线”到底怎么算** —— 它决定整面墙默认收不收起来，而“相机算不算”、
 *     “设备端明确关掉的算不算”各自都能让值班的人看错一屏；
 *   - **一格画不出选中的图形时是哪一种原因** —— 八种状态必须能分开，而它们的优先级
 *     只能有一处（画错优先级 = 界面说了一件没发生的事）；
 *   - **折线的几何** —— 坏帧、常量序列、点数不足，每一种都会把“没有数据”画成
 *     “有一条线”。
 * 这些都必须能在没有浏览器的情况下断言，所以计算全部住在
 * `src/renderer/src/lib/channelWall.ts`（纯函数、零运行时依赖），这里只测它。
 *
 * 另外断言 `channelWall.*` 这些 key 真的存在于四种语言里：模板拿到的只有 key，
 * key 不存在时用户看到的就是 `channelWall.prevPage` 这种裸 key。
 *
 * 中文注释是仓库约定（见 tests/channel-state.test.ts）。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  CHANNEL_GRAPH_KINDS,
  CHANNEL_WALL_LAYOUTS,
  DEFAULT_CHANNEL_GRAPH,
  DEFAULT_CHANNEL_WALL_LAYOUT,
  GRAPH_VIEW_HEIGHT,
  GRAPH_VIEW_PADDING,
  GRAPH_VIEW_WIDTH,
  buildTiles,
  channelGraphState,
  channelTileLabel,
  channelWallCollapsed,
  clampPage,
  defaultChannelWallCollapsed,
  graphGeometry,
  hasOnlineChannel,
  isChannelGraphKind,
  isChannelWallLayout,
  isOnlineChannelTile,
  layoutColumns,
  tileCount,
  tilelessDevices,
  totalPages,
  visibleTiles,
  type ChannelGraphFacts,
  type ChannelWallSource,
  type ChannelWallTile
} from '../src/renderer/src/lib/channelWall'
import { SensorType, type Channel, type Device } from '../src/shared/domain/models'
import { LOCALES } from '../src/shared/i18n/locales'
import { zhCN } from '../src/shared/i18n/messages/zh-CN'
import { en } from '../src/shared/i18n/messages/en'
import { es } from '../src/shared/i18n/messages/es'
import { tr } from '../src/shared/i18n/messages/tr'

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

function device(overrides: Partial<Device> & Pick<Device, 'id'>): Device {
  return {
    deviceUid: `uid-${overrides.id}`,
    kind: 'acousticBox',
    name: overrides.id,
    connectionType: 'LAN',
    status: 'ONLINE',
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

/**
 * 造一行通道。
 *
 * `enabled` 故意声明为 `unknown`：设备完全可能既没给 true 也没给 false，
 * 而“状态未知”就是那条路径（见 lib/channelState.ts）。为了把它造出来，
 * 这里只在返回值处做一次类型断言，被测逻辑本身仍然走真实类型。
 */
function channel(
  deviceId: string,
  channelIndex: number,
  enabled?: unknown,
  channelName = ''
): Channel {
  const row = {
    id: `${deviceId}:${channelIndex}`,
    deviceId,
    channelIndex,
    channelName,
    sensorType: SensorType.Microphone,
    enabled,
    createdAt: 0,
    updatedAt: 0
  }
  return row as unknown as Channel
}

/**
 * 造 n 个格子。
 *
 * 分页只关心“有多少格、顺序如何”，与设备/通道无关，所以这里直接造格子：
 * 用例失败时不会牵扯进构造器，定位更直接。构造器另有它自己的测试。
 */
function syntheticTiles(count: number): ChannelWallTile[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `box:dev:${index}`,
    deviceId: 'dev',
    deviceName: 'dev',
    deviceStatus: 'ONLINE' as const,
    kind: 'acousticBox' as const,
    source: 'boxChannel' as const,
    channelIndex: index,
    label: `CH${index + 1}`,
    channelName: '',
    state: 'enabled' as const
  }))
}

// ---------------------------------------------------------------------------
// 分屏档位
// ---------------------------------------------------------------------------

describe('分屏档位', () => {
  it('档位就是每页的槽位数', () => {
    assert.equal(tileCount(1), 1)
    assert.equal(tileCount(2), 2)
    assert.equal(tileCount(4), 4)
    assert.equal(tileCount(8), 8)
  })

  it('声明的档位与产品要求一致（1 / 2 / 4 / 8，顺序即控件顺序）', () => {
    // 产品原话：「总览中的通道墙应该支持 1、2、4、8 通道」。16 档这一轮被去掉：
    // AE08 只有 8 路通道，16 格里有半屏永远是空的。
    assert.deepEqual([...CHANNEL_WALL_LAYOUTS], [1, 2, 4, 8])
    assert.ok((CHANNEL_WALL_LAYOUTS as readonly number[]).includes(DEFAULT_CHANNEL_WALL_LAYOUT))
    assert.equal((CHANNEL_WALL_LAYOUTS as readonly number[]).includes(16), false)
  })

  it('列数分别是 1 列、2×1、2×2、4×2', () => {
    assert.equal(layoutColumns(1), 1)
    assert.equal(layoutColumns(2), 2)
    assert.equal(layoutColumns(4), 2)
    assert.equal(layoutColumns(8), 4)
    // 列数必须整除槽位数，否则最后一行会缺一块（2 档最容易被写成 1 列）。
    for (const layout of CHANNEL_WALL_LAYOUTS) {
      assert.equal(tileCount(layout) % layoutColumns(layout), 0, `${layout} 档列数不整除`)
    }
  })

  it('2 档是两列而不是一列（这一轮新加的档位）', () => {
    // 「2 通道」在界面上的意思是**并排两格**：一列两行只是把 1 分屏拉长，
    // 一个字都没有变多。列数由 `layoutColumns()` 同时喂给 CSS 与档位图标。
    assert.equal(layoutColumns(2), 2)
    assert.equal(tileCount(2), 2)
  })

  it('拒绝非法档位（localStorage 里可能是一个被改坏的值）', () => {
    assert.ok(isChannelWallLayout(1))
    assert.ok(isChannelWallLayout(2))
    assert.ok(isChannelWallLayout(4))
    assert.ok(isChannelWallLayout(8))
    // 16 是**上一版**的合法档位：旧版本写进 localStorage 的 16 现在必须被拒，
    // 否则分段控件会把一个不存在的档位显示成“已选中”。
    for (const bad of [0, 3, 16, 32, -4, 1.5, '4', null, undefined, NaN, {}]) {
      assert.equal(isChannelWallLayout(bad), false, `${String(bad)} 不该被当成合法档位`)
    }
  })
})

// ---------------------------------------------------------------------------
// 分页
// ---------------------------------------------------------------------------

describe('分页', () => {
  it('零格：仍然只有一页，且一页里没有任何格子', () => {
    const tiles: ChannelWallTile[] = []
    // 返回 1 而不是 0：界面上「第 1 / 0 页」是一句没有意义的话。
    assert.equal(totalPages(tiles, 4), 1)
    assert.deepEqual(visibleTiles(tiles, 4, 1), [])
    for (const layout of CHANNEL_WALL_LAYOUTS) {
      assert.equal(totalPages(tiles, layout), 1)
    }
    // 任何页码都夹回第 1 页，不会有第二条“空页”。
    for (const page of [1, 2, 3, 0, -1, 99, NaN]) {
      assert.equal(clampPage(page, tiles, 4), 1, `clampPage(${String(page)}) 应为 1`)
    }
  })

  it('不足一页：2 格在 4 分屏下就是一页', () => {
    const tiles = syntheticTiles(2)
    assert.equal(totalPages(tiles, 4), 1)
    assert.equal(visibleTiles(tiles, 4, 1).length, 2)
  })

  it('正好一页：4 格在 4 分屏下是一页，不多不少', () => {
    const tiles = syntheticTiles(4)
    assert.equal(totalPages(tiles, 4), 1)
    assert.equal(visibleTiles(tiles, 4, 1).length, 4)
  })

  it('超过一页：5 格在 4 分屏下是两页', () => {
    const tiles = syntheticTiles(5)
    assert.equal(totalPages(tiles, 4), 2)
    assert.equal(visibleTiles(tiles, 4, 1).length, 4)
    // 最后一页只画剩下的格子，不补空格位：空格会让操作员以为那几路通道丢了。
    assert.deepEqual(
      visibleTiles(tiles, 4, 2).map((tile) => tile.key),
      ['box:dev:4']
    )
  })

  it('超出范围的页码被夹到最后一页', () => {
    const tiles = syntheticTiles(9) // 4 分屏 -> 3 页
    assert.equal(totalPages(tiles, 4), 3)
    assert.equal(clampPage(4, tiles, 4), 3)
    assert.equal(clampPage(99, tiles, 4), 3)
    // 夹取后这一页必须真的有格子，否则就是“有页码、没内容”。
    assert.equal(visibleTiles(tiles, 4, 99).length, 1)
  })

  it('设备被删除、总格数变小时，停在最后一页的页码会回退', () => {
    // 这是本次改动最关键的一条：4 分屏、9 格（3 页）、当前第 3 页，
    // 此时删掉一台设备使总格数降到 3（只剩 1 页）。
    const before = syntheticTiles(9)
    assert.equal(totalPages(before, 4), 3)
    assert.equal(clampPage(3, before, 4), 3)

    const after = syntheticTiles(3)
    assert.equal(totalPages(after, 4), 1)
    assert.equal(clampPage(3, after, 4), 1)
    // 关键断言：回退后的那一页真的画得出东西，而不是「第 3 / 1 页 + 一片空白」。
    assert.equal(visibleTiles(after, 4, 3).length, 3)
  })

  it('格数变少但仍有多页时，只回退到新的最后一页', () => {
    const after = syntheticTiles(5) // 4 分屏 -> 2 页
    assert.equal(clampPage(3, after, 4), 2)
    assert.equal(clampPage(9, after, 4), 2)
    assert.equal(visibleTiles(after, 4, 9).length, 1)
  })

  it('切换到更大的档位后页码同样被夹取', () => {
    // 1 分屏下的第 5 页，换成 8 分屏后只有 1 页。
    const tiles = syntheticTiles(5)
    assert.equal(totalPages(tiles, 1), 5)
    assert.equal(clampPage(5, tiles, 1), 5)
    assert.equal(clampPage(5, tiles, 8), 1)
    assert.equal(visibleTiles(tiles, 8, 5).length, 5)
  })

  it('2 档每页两格：5 格是 3 页，最后一页只有一格', () => {
    // 这一轮新加的档位也要参与分页：2 档比 1 档少一半页数，比 4 档多一倍。
    const tiles = syntheticTiles(5)
    assert.equal(totalPages(tiles, 2), 3)
    assert.equal(visibleTiles(tiles, 2, 1).length, 2)
    assert.deepEqual(
      visibleTiles(tiles, 2, 3).map((tile) => tile.key),
      ['box:dev:4']
    )
  })

  it('8 档真的给出 8 个槽位', () => {
    const tiles = syntheticTiles(20)
    assert.equal(totalPages(tiles, 8), 3)
    const first = visibleTiles(tiles, 8, 1)
    assert.equal(first.length, tileCount(8))
    assert.equal(first.length, 8)
    // 第一页是前 8 个，第二页是接下来的 8 个，顺序不能乱。
    assert.equal(first[0]?.key, 'box:dev:0')
    assert.equal(first[7]?.key, 'box:dev:7')
    assert.deepEqual(
      visibleTiles(tiles, 8, 2).map((tile) => tile.key),
      ['box:dev:8', 'box:dev:9', 'box:dev:10', 'box:dev:11', 'box:dev:12', 'box:dev:13', 'box:dev:14', 'box:dev:15']
    )
    assert.deepEqual(
      visibleTiles(tiles, 8, 3).map((tile) => tile.key),
      ['box:dev:16', 'box:dev:17', 'box:dev:18', 'box:dev:19']
    )
  })

  it('页码先夹取再切片，调用方可以直接传一个过期的页码', () => {
    const tiles = syntheticTiles(6)
    // 第 2 页与一个越界的第 7 页在这里是同一页。
    assert.deepEqual(
      visibleTiles(tiles, 4, 7).map((tile) => tile.key),
      visibleTiles(tiles, 4, 2).map((tile) => tile.key)
    )
  })
})

// ---------------------------------------------------------------------------
// 格子模型与构造器
// ---------------------------------------------------------------------------

describe('buildTiles()', () => {
  it('通道标签是 0 基的 CH 编号', () => {
    assert.equal(channelTileLabel(0), 'CH1')
    assert.equal(channelTileLabel(7), 'CH8')
  })

  it('先按设备列表顺序，再按设备内的通道号升序', () => {
    const source: ChannelWallSource = {
      devices: [
        // 第一台是离线的，但它仍然排在第一位：通道墙不按状态重排。
        device({ id: 'box-a', name: 'A 号主变', status: 'OFFLINE' }),
        device({ id: 'cam', name: '声学相机', kind: 'acousticCamera' }),
        device({ id: 'box-b', name: 'B 号主变' })
      ],
      channels: {
        // 故意乱序，构造器必须自己排好。
        'box-a': [channel('box-a', 1, true), channel('box-a', 0, true)],
        'box-b': [channel('box-b', 0, false)],
        cam: []
      }
    }

    const tiles = buildTiles(source)
    assert.deepEqual(
      tiles.map((tile) => tile.key),
      ['box:box-a:0', 'box:box-a:1', 'camera:cam', 'box:box-b:0']
    )
    // 状态不影响顺序：离线设备的第一路仍然在第一格。
    assert.equal(tiles[0]?.deviceStatus, 'OFFLINE')
    assert.equal(tiles[0]?.label, 'CH1')
    assert.equal(tiles[1]?.label, 'CH2')
  })

  it('同一份数据必然产出同一个数组（分页因此稳定）', () => {
    const source: ChannelWallSource = {
      devices: [device({ id: 'box-a' })],
      channels: { 'box-a': [channel('box-a', 2, true), channel('box-a', 0, true)] }
    }
    assert.deepEqual(buildTiles(source), buildTiles(source))
  })

  it('不就地排序传入的通道数组（纯函数不得改动 store 里的数据）', () => {
    const rows = [channel('box-a', 3, true), channel('box-a', 1, true)]
    const before = rows.map((row) => row.channelIndex)
    const source: ChannelWallSource = { devices: [device({ id: 'box-a' })], channels: { 'box-a': rows } }

    assert.deepEqual(buildTiles(source).map((tile) => tile.channelIndex), [1, 3])
    assert.deepEqual(
      rows.map((row) => row.channelIndex),
      before,
      'buildTiles() 改动了传入的数组'
    )
  })

  it('通道状态一律走 channelState()，不在这里重判', () => {
    const source: ChannelWallSource = {
      devices: [device({ id: 'box-a', name: '一号' })],
      channels: {
        'box-a': [
          channel('box-a', 0, true, '高压侧'),
          channel('box-a', 1, false),
          channel('box-a', 2, undefined),
          // 松散载荷：`'true'` 不是字面量 true，必须归入“未知”，不能当成已启用。
          channel('box-a', 3, 'true')
        ]
      }
    }

    const tiles = buildTiles(source)
    assert.deepEqual(
      tiles.map((tile) => tile.state),
      ['enabled', 'disabled', 'unknown', 'unknown']
    )
    assert.equal(tiles[0]?.channelName, '高压侧')
    assert.equal(tiles[0]?.deviceName, '一号')
  })

  it('相机没有通道，固定占一格，并且不带通道状态', () => {
    const source: ChannelWallSource = {
      devices: [device({ id: 'cam', name: '相机', kind: 'acousticCamera' })],
      channels: { cam: [] }
    }

    const tiles = buildTiles(source)
    assert.equal(tiles.length, 1)
    assert.equal(tiles[0]?.source, 'cameraStream')
    assert.equal(tiles[0]?.kind, 'acousticCamera')
    // 给相机编一个通道状态会让徽标显示「状态未知」，而那句话在说“这一路通道的启用状态
    // 还没读到” —— 相机根本没有通道，所以这里必须是 undefined。
    assert.equal(tiles[0]?.state, undefined)
    assert.equal(tiles[0]?.channelIndex, undefined)
    assert.equal(tiles[0]?.label, '')
  })

  it('通道表还没读到的设备不产出任何格子（不凭空补 CH1…CH8）', () => {
    const source: ChannelWallSource = {
      // 一台设备都没有通道数据：声纹设备没有条目，另一台的通道表是空的。
      devices: [device({ id: 'box-a' }), device({ id: 'box-b' })],
      channels: { 'box-b': [] }
    }
    assert.deepEqual(buildTiles(source), [])
  })

  it('设备列表为空时产出空数组', () => {
    assert.deepEqual(buildTiles({ devices: [], channels: {} }), [])
  })
})

describe('tilelessDevices()', () => {
  it('只报出通道表还没读到的声纹设备，不报相机', () => {
    const source: ChannelWallSource = {
      devices: [
        device({ id: 'box-a' }),
        device({ id: 'cam', kind: 'acousticCamera' }),
        device({ id: 'box-b' })
      ],
      channels: { 'box-b': [channel('box-b', 0, true)] }
    }
    // 空通道表按“还没读到”处理：设备端返回了空表，也不该补出通道。
    assert.deepEqual(
      tilelessDevices(source).map((item) => item.id),
      ['box-a']
    )
  })

  it('通道表读回来之后就不再报', () => {
    const source: ChannelWallSource = {
      devices: [device({ id: 'box-a' })],
      channels: { 'box-a': [channel('box-a', 0, true)] }
    }
    assert.deepEqual(tilelessDevices(source), [])
  })
})

// ---------------------------------------------------------------------------
// 图形类型
// ---------------------------------------------------------------------------

describe('图形类型', () => {
  it('四档与产品要求一致（声纹图 / 声压线 / 频谱图 / 时谱图，顺序即控件顺序）', () => {
    assert.deepEqual([...CHANNEL_GRAPH_KINDS], ['voiceprint', 'spl', 'spectrum', 'spectrogram'])
    assert.ok((CHANNEL_GRAPH_KINDS as readonly string[]).includes(DEFAULT_CHANNEL_GRAPH))
  })

  it('默认图形就是这一轮之前的行为：相机格的声纹图', () => {
    // 默认值必须等于原行为，否则“这一轮只改了操作员主动切换之后的事”这句话就是假的：
    // 打开总览时相机格上原来显示什么，现在还得显示什么。
    assert.equal(DEFAULT_CHANNEL_GRAPH, 'voiceprint')
  })

  it('拒绝非法图形（localStorage 里可能是一个被改坏的值）', () => {
    for (const good of CHANNEL_GRAPH_KINDS) {
      assert.ok(isChannelGraphKind(good), `${good} 应该是合法图形`)
    }
    for (const bad of ['', 'SPL', 'spectrogram ', 'voiceprintData', 0, null, undefined, NaN, {}, ['spl']]) {
      assert.equal(isChannelGraphKind(bad), false, `${String(bad)} 不该被当成合法图形`)
    }
  })
})

// ---------------------------------------------------------------------------
// “有没有通道在线”与默认收起
// ---------------------------------------------------------------------------

/** 一格声纹通道；只有在线判定关心的那几个字段会被用到。 */
function boxTile(overrides: Partial<ChannelWallTile> = {}): ChannelWallTile {
  return {
    key: 'box:dev:0',
    deviceId: 'dev',
    deviceName: 'dev',
    deviceStatus: 'ONLINE',
    kind: 'acousticBox',
    source: 'boxChannel',
    channelIndex: 0,
    label: 'CH1',
    channelName: '',
    state: 'enabled',
    ...overrides
  }
}

/** 一格相机；相机没有通道（`state` / `channelIndex` 都是 undefined）。 */
function cameraTile(overrides: Partial<ChannelWallTile> = {}): ChannelWallTile {
  return {
    key: 'camera:cam',
    deviceId: 'cam',
    deviceName: 'cam',
    deviceStatus: 'ONLINE',
    kind: 'acousticCamera',
    source: 'cameraStream',
    label: '',
    channelName: '',
    ...overrides
  }
}

describe('“有没有通道在线”与默认收起', () => {
  it('零格：默认收起（产品要求「如果没有通道在线就可以默认收起」）', () => {
    assert.equal(hasOnlineChannel([]), false)
    assert.equal(defaultChannelWallCollapsed([]), true)
    assert.equal(channelWallCollapsed([], null), true)
  })

  it('只有相机格不算“有通道在线”：相机没有通道，而这面是通道墙', () => {
    // 把相机算进去，一面只有相机、一路通道都没有的墙就会永远展开 ——
    // 那恰好是产品要求收起的场景。
    const tiles = [cameraTile()]
    assert.equal(hasOnlineChannel(tiles), false)
    assert.equal(defaultChannelWallCollapsed(tiles), true)
  })

  it('有在线的声纹通道：默认展开', () => {
    const tiles = [cameraTile(), boxTile()]
    assert.equal(isOnlineChannelTile(tiles[1] as ChannelWallTile), true)
    assert.equal(hasOnlineChannel(tiles), true)
    assert.equal(defaultChannelWallCollapsed(tiles), false)
  })

  it('设备离线的通道不算在线', () => {
    const tiles = [boxTile({ deviceStatus: 'OFFLINE' })]
    assert.equal(isOnlineChannelTile(tiles[0] as ChannelWallTile), false)
    assert.equal(defaultChannelWallCollapsed(tiles), true)
  })

  it('设备端明确关掉的通道（disabled）不算在线', () => {
    const tiles = [boxTile({ state: 'disabled' })]
    assert.equal(isOnlineChannelTile(tiles[0] as ChannelWallTile), false)
    assert.equal(defaultChannelWallCollapsed(tiles), true)
  })

  it('状态未知（unknown）算在线：它只是还没读到，不是“不在线”', () => {
    // 把 unknown 当作不在线，会让一面真有通道的墙在刷新的一瞬间自己收起来 ——
    // 而“设备还没返回启用标志”不是“这一路没在线”。
    const tiles = [boxTile({ state: 'unknown' })]
    assert.equal(isOnlineChannelTile(tiles[0] as ChannelWallTile), true)
    assert.equal(defaultChannelWallCollapsed(tiles), false)
  })

  it('操作员表过态就听他的，默认行为不再接管', () => {
    const online = [boxTile()]
    const offline = [boxTile({ deviceStatus: 'OFFLINE' })]
    // 他收起了一面有在线通道的墙：那是他的选择。
    assert.equal(channelWallCollapsed(online, true), true)
    // 他展开了一面没有在线通道的墙：也一样算数（否则他永远看不到里面的通道表状态）。
    assert.equal(channelWallCollapsed(offline, false), false)
    // 没表过态（null）才回落到数据。
    assert.equal(channelWallCollapsed(online, null), false)
    assert.equal(channelWallCollapsed(offline, null), true)
  })
})

// ---------------------------------------------------------------------------
// 一格能不能画出选中的图形
// ---------------------------------------------------------------------------

/** 全假的图形事实，用例只覆盖自己关心的那几条。 */
function graphFacts(overrides: Partial<ChannelGraphFacts> = {}): ChannelGraphFacts {
  return {
    supported: true,
    ready: false,
    failed: false,
    matrixInsteadOfImage: false,
    otherSession: false,
    stale: false,
    awaitingFrames: false,
    monitored: true,
    ...overrides
  }
}

describe('一格能不能画出选中的图形', () => {
  it('没有这种载荷最优先：会话在不在、通不通都不改变结论', () => {
    // 相机没有时频通道、盒子没有图像：这是设备家族的**结构**事实，与实时状态无关。
    // 把它排在后面，就会出现“会话在别的设备上”这种更弱、且不解释根本原因的说法。
    const state = channelGraphState(
      graphFacts({
        supported: false,
        ready: true,
        failed: true,
        otherSession: true,
        stale: true,
        awaitingFrames: true,
        monitored: false
      })
    )
    assert.equal(state, 'no-such-data')
  })

  it('有真数据就是 ready', () => {
    assert.equal(channelGraphState(graphFacts({ ready: true })), 'ready')
    // ready 同样优先于任何“为什么没有”的原因（同一次渲染里数据到了、状态还是旧的）。
    assert.equal(channelGraphState(graphFacts({ ready: true, failed: true })), 'ready')
  })

  it('优先级固定：报错 > 不可显示 > 会话在别的设备上 > 停了 > 一帧都没有 > 没在监测', () => {
    // 每一条都比它后面的更接近“数据”：报错是这一路自己说的话，
    // 而“没在监测”只是说没有会话盯着这一格。
    assert.equal(channelGraphState(graphFacts({ failed: true })), 'error')
    assert.equal(
      channelGraphState(graphFacts({ failed: true, matrixInsteadOfImage: true })),
      'error'
    )
    assert.equal(
      channelGraphState(graphFacts({ matrixInsteadOfImage: true, otherSession: true })),
      'matrix-only'
    )
    assert.equal(channelGraphState(graphFacts({ otherSession: true, stale: true })), 'other-session')
    assert.equal(channelGraphState(graphFacts({ stale: true, awaitingFrames: true })), 'stale')
    assert.equal(
      channelGraphState(graphFacts({ awaitingFrames: true, monitored: false })),
      'no-frames'
    )
    assert.equal(channelGraphState(graphFacts({ monitored: false })), 'not-started')
  })

  it('会话在跑却一帧都没有：是 no-frames，不是 not-started', () => {
    // 「没在采集」与「在采集但一帧都没有」是两种故障，值班的人必须能分开。
    assert.equal(channelGraphState(graphFacts({ awaitingFrames: true })), 'no-frames')
    assert.equal(channelGraphState(graphFacts({ monitored: true })), 'no-frames')
    assert.equal(channelGraphState(graphFacts({ monitored: false })), 'not-started')
  })

  it('会话在跑、也收到过帧、却没有可画的数据：也不谎报 ready', () => {
    const state = channelGraphState(graphFacts({ monitored: true, awaitingFrames: false }))
    assert.notEqual(state, 'ready')
    assert.equal(state, 'no-frames')
  })
})

// ---------------------------------------------------------------------------
// 折线几何
// ---------------------------------------------------------------------------

/** 把 `points` 解回坐标，方便逐点断言。 */
function coords(points: string): Array<[number, number]> {
  return points
    .split(' ')
    .filter(Boolean)
    .map((pair) => {
      const [x, y] = pair.split(',')
      return [Number(x), Number(y)] as [number, number]
    })
}

describe('折线几何', () => {
  it('空序列：一个点都不画（绝不补一条零线）', () => {
    const geometry = graphGeometry([])
    assert.equal(geometry.points, '')
    assert.equal(geometry.count, 0)
    assert.equal(geometry.last, null)
  })

  it('点数不足两个：也不画（一个孤点不是曲线）', () => {
    const geometry = graphGeometry([42])
    assert.equal(geometry.points, '')
    assert.equal(geometry.count, 1)
    assert.equal(geometry.last, 42)
    assert.equal(geometry.min, 42)
    assert.equal(geometry.max, 42)
  })

  it('两个点：首尾分别贴住绘图区的左右内边', () => {
    const geometry = graphGeometry([0, 10])
    assert.equal(geometry.count, 2)
    const points = coords(geometry.points)
    assert.equal(points.length, 2)
    assert.equal(points[0]?.[0], GRAPH_VIEW_PADDING)
    assert.equal(points[1]?.[0], GRAPH_VIEW_WIDTH - GRAPH_VIEW_PADDING)
    // 最大值在顶部、最小值在底部。
    assert.equal(points[0]?.[1], GRAPH_VIEW_HEIGHT - GRAPH_VIEW_PADDING)
    assert.equal(points[1]?.[1], GRAPH_VIEW_PADDING)
  })

  it('非有限值被丢掉，而不是当作 0（坏帧不是“环境很安静”）', () => {
    const geometry = graphGeometry([1, NaN, 3, Infinity, -Infinity, 5])
    assert.equal(geometry.count, 3)
    assert.equal(geometry.min, 1)
    assert.equal(geometry.max, 5)
    assert.equal(geometry.last, 5)
    assert.equal(coords(geometry.points).length, 3)
  })

  it('常量序列画在正中间，而不是除零产生 NaN', () => {
    // “一直没变化”本身有信息量：0 dB 与“没有数据”不能长得一样，而一条 NaN 的线
    // 恰好就是“一格都画不出来”。
    const geometry = graphGeometry([7, 7, 7, 7])
    assert.equal(geometry.count, 4)
    assert.equal(geometry.min, 7)
    assert.equal(geometry.max, 7)
    const points = coords(geometry.points)
    assert.equal(points.length, 4)
    for (const [, y] of points) {
      assert.equal(y, GRAPH_VIEW_PADDING + (GRAPH_VIEW_HEIGHT - 2 * GRAPH_VIEW_PADDING) / 2)
    }
    assert.equal(geometry.points.includes('NaN'), false)
  })

  it('全部坐标落在绘图区里（含留白）', () => {
    const geometry = graphGeometry([-5, 0, 3.5, 1000, -1000])
    for (const [x, y] of coords(geometry.points)) {
      assert.ok(x >= 0 && x <= GRAPH_VIEW_WIDTH, `x 越界：${x}`)
      assert.ok(y >= 0 && y <= GRAPH_VIEW_HEIGHT, `y 越界：${y}`)
    }
  })
})

// ---------------------------------------------------------------------------
// 目录 key
// ---------------------------------------------------------------------------

const CATALOGUES: Record<string, Record<string, unknown>> = {
  'zh-CN': zhCN as unknown as Record<string, unknown>,
  en: en as unknown as Record<string, unknown>,
  es: es as unknown as Record<string, unknown>,
  tr: tr as unknown as Record<string, unknown>
}

/** 点号路径取值，用来断言 key 真的存在。 */
function messageAt(locale: string, key: string): unknown {
  let cursor: unknown = CATALOGUES[locale]
  for (const segment of key.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

/**
 * 通道墙在模板里用到的每一个 key。
 *
 * 后几条是复用既有目录的 key（数值标签、相机文案）：它们同样必须存在，
 * 否则英文界面会渲染出裸 key。把它们写在这里，是为了让“复用”也受到保护。
 */
const CHANNEL_WALL_KEYS = [
  'channelWall.title',
  'channelWall.summary',
  'channelWall.layoutLabel',
  'channelWall.layout1',
  'channelWall.layout2',
  'channelWall.layout4',
  'channelWall.layout8',
  'channelWall.prevPage',
  'channelWall.nextPage',
  'channelWall.pageIndicator',
  'channelWall.loading',
  'channelWall.empty',
  'channelWall.noChannelTable',
  'channelWall.cameraStreamLabel',
  'channelWall.cameraMatrixOnly',
  'channelWall.cameraOtherDevice',
  'channelWall.cameraStale',
  'channelWall.collapse',
  'channelWall.expand',
  'channelWall.collapsedNoChannel',
  'channelWall.graphLabel',
  'channelWall.graph.voiceprint',
  'channelWall.graph.spl',
  'channelWall.graph.spectrum',
  'channelWall.graph.spectrogram',
  'channelWall.graph.deviceHasNoData',
  'channelWall.graph.splCaption',
  'channelWall.graph.lineAxis',
  'channelWall.reason.notMonitored',
  'channelWall.reason.deviceOffline',
  'channelState.disabledHint',
  'channelState.unknownHint',
  'channelState.liveSilent',
  'metrics.spl',
  'metrics.mainFrequency',
  'cameraStreamUi.phaseNoFrames',
  'cameraStreamUi.phaseStale',
  'cameraStreamUi.phaseError',
  'cameraStreamUi.voiceprintAlt',
  'widgetsUi.spectrogramAlt'
]

describe('通道墙的目录 key', () => {
  it('四种语言里都存在', () => {
    for (const locale of LOCALES) {
      for (const key of CHANNEL_WALL_KEYS) {
        assert.equal(
          typeof messageAt(locale, key),
          'string',
          `${locale} 缺少 ${key}`
        )
      }
    }
  })

  it('档位文案覆盖每一个档位（分段控件不会有空格子）', () => {
    for (const layout of CHANNEL_WALL_LAYOUTS) {
      for (const locale of LOCALES) {
        assert.equal(
          typeof messageAt(locale, `channelWall.layout${layout}`),
          'string',
          `${locale} 缺少 channelWall.layout${layout}`
        )
      }
    }
    // 上一版的 16 档已经不再是合法档位，它的词条也必须一起退场：
    // 「键还在、档位没了」只会在下一次有人照着键名把 16 加回来时咬人。
    for (const locale of LOCALES) {
      assert.equal(
        messageAt(locale, 'channelWall.layout16'),
        undefined,
        `${locale} 还留着 channelWall.layout16（16 档已经不存在）`
      )
    }
  })

  it('图形文案覆盖每一种图形（切换器不会有空格子）', () => {
    for (const kind of CHANNEL_GRAPH_KINDS) {
      for (const locale of LOCALES) {
        assert.equal(
          typeof messageAt(locale, `channelWall.graph.${kind}`),
          'string',
          `${locale} 缺少 channelWall.graph.${kind}`
        )
      }
    }
  })

  it('消息里不含 @（vue-i18n 的链接消息标记会让消息编译失败）', () => {
    for (const locale of LOCALES) {
      for (const key of CHANNEL_WALL_KEYS) {
        const message = messageAt(locale, key)
        assert.ok(
          typeof message === 'string' && !message.includes('@'),
          `${locale}.${key} 含 @：${String(message)}`
        )
      }
    }
  })
})
