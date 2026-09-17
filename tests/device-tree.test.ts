/**
 * 设备树模型的回归测试。
 *
 * WHY THIS FILE EXISTS
 * 「左栏能做展开拓扑、据此选择不同的设备」这件事，难点全在四个计算上：
 *   - 屏幕上到底显示哪些行（展开状态 × 筛选的合力）；
 *   - 每按一次方向键，焦点去哪一行（键盘导航不是「能 Tab 就行」）；
 *   - 每个节点的状态（设备在线/离线、通道启用/未启用/未知）；
 *   - 选中一个节点跳到哪个地址。
 * 它们全部住在 `src/renderer/src/lib/deviceTree.ts`（纯函数、零运行时依赖），
 * 所以可以在没有浏览器的情况下直接断言。**不测 Vue 模板**。
 *
 * 这里还钉住两条很容易被改坏的规矩：
 *   1. 通道状态**只**由 `lib/channelState.ts` 的 `channelState()` 判定：
 *      「设备没上报通道表」是 `unknown`，绝不是「已启用」；
 *   2. 筛选不改变树的拓扑（不伪造节点、不隐藏匹配设备的通道）。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  DEVICE_TREE_ROOT_ID,
  buildDeviceTree,
  channelNodeId,
  defaultExpandedIds,
  deviceIdOfNodeId,
  deviceNodeId,
  expandAllIds,
  flattenDeviceTree,
  isTreeKey,
  matchesDeviceFilter,
  monitorRouteForDevice,
  navigateTree,
  normaliseTreeFilter,
  pruneExpandedIds,
  selectedDeviceForRoute,
  selectableIds,
  streamNodeId,
  toggleExpanded,
  treeChannelLabel,
  treeChannelText,
  treeDeviceLabel,
  type DeviceTreeSource
} from '../src/renderer/src/lib/deviceTree'
import type { Channel, Device } from '../src/shared/domain/models'

// ---------------------------------------------------------------------------
// 夹俱
// ---------------------------------------------------------------------------

function box(id: string, status: Device['status'] = 'ONLINE'): Device {
  return {
    id,
    deviceUid: `uid-${id}`,
    kind: 'acousticBox',
    name: `声纹设备 ${id}`,
    ip: `192.168.1.${id.length}0`,
    connectionType: 'LAN',
    status,
    createdAt: 0,
    updatedAt: 0
  }
}

function camera(id: string, status: Device['status'] = 'ONLINE'): Device {
  return {
    id,
    deviceUid: `uid-${id}`,
    kind: 'acousticCamera',
    name: `声学相机 ${id}`,
    ip: '192.168.110.235',
    connectionType: 'LAN',
    status,
    createdAt: 0,
    updatedAt: 0
  }
}

/**
 * 一路通道夹俱。
 *
 * `enabled` 声明为 `unknown` 并强制转成 `Channel`：`lib/channelState.ts` 的解析器
 * 刻意比领域模型宽松（设备 JSON → 映射 → 数据库 → IPC 任何一环都可能给出
 * `1`/`'true'`/干脆没有），所以这里必须能造出「字段缺失」这种真实数据。
 */
function channel(index: number, enabled: unknown, name = ''): Channel {
  return {
    id: `ch-${index}`,
    deviceId: 'box-1',
    channelIndex: index,
    channelName: name,
    sensorType: 'microphone',
    enabled,
    createdAt: 0,
    updatedAt: 0
  } as unknown as Channel
}

/** 三台设备：一台箱子（有通道表）、一台箱子（通道表还没读到）、一台相机。 */
function source(overrides: Partial<DeviceTreeSource> = {}): DeviceTreeSource {
  return {
    devices: [box('box-1'), box('box-2'), camera('cam-1')],
    channels: {
      'box-1': [
        channel(0, true, '风机 A'),
        channel(1, false),
        // `enabled` 缺失：从未成功读到过，必须判成 unknown 而不是「已启用」。
        channel(2, undefined)
      ]
      // box-2 没有条目：通道表还没读到。
    },
    expanded: new Set([DEVICE_TREE_ROOT_ID, deviceNodeId('box-1'), deviceNodeId('box-2')]),
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// 拓扑
// ---------------------------------------------------------------------------

describe('设备树的拓扑', () => {
  it('根 -> 设备 -> 通道 / 相机流节点', () => {
    const tree = buildDeviceTree(source())
    assert.equal(tree.kind, 'root')
    assert.equal(tree.children.length, 3)

    const first = tree.children[0]
    assert.equal(first?.kind, 'device')
    assert.equal(first?.deviceId, 'box-1')
    assert.equal(first?.children.length, 3)
    assert.equal(first?.children[0]?.kind, 'channel')
    assert.equal(first?.children[0]?.channelLabel, 'CH1')
    assert.equal(first?.children[0]?.label, '风机 A')

    const last = tree.children[2]
    assert.equal(last?.kind, 'device')
    assert.equal(last?.deviceKind, 'acousticCamera')
    // 相机没有通道，只有一路实时视频。
    assert.equal(last?.children.length, 1)
    assert.equal(last?.children[0]?.kind, 'stream')
  })

  it('通道按通道号升序，标签是 CH1..CH8（0 基）', () => {
    const tree = buildDeviceTree(
      source({
        channels: { 'box-1': [channel(5, true), channel(0, true), channel(2, true)] }
      })
    )
    const indexes = tree.children[0]?.children.map((node) => node.channelIndex)
    assert.deepEqual(indexes, [0, 2, 5])
    assert.deepEqual(
      tree.children[0]?.children.map((node) => node.channelLabel),
      ['CH1', 'CH3', 'CH6']
    )
    assert.equal(treeChannelLabel(0), 'CH1')
    assert.equal(treeChannelLabel(7), 'CH8')
  })

  it('设备顺序就是设备列表的顺序（不按状态重排，树不能在操作员手底下洗牌）', () => {
    const tree = buildDeviceTree(
      source({
        devices: [box('box-1'), camera('cam-1', 'OFFLINE'), box('box-2')]
      })
    )
    assert.deepEqual(
      tree.children.map((node) => node.deviceId),
      ['box-1', 'cam-1', 'box-2']
    )
  })

  it('通道状态只走 channelState()：true/false/缺失 分别是对应状态', () => {
    const tree = buildDeviceTree(source())
    const states = tree.children[0]?.children.map((node) => node.channelState)
    assert.deepEqual(states, ['enabled', 'disabled', 'unknown'])
  })

  it('通道表还没读到的设备不伪造 CH1..CH8，只给一个 unknown 的说明行', () => {
    const tree = buildDeviceTree(source())
    const second = tree.children[1]
    assert.equal(second?.deviceId, 'box-2')
    assert.equal(second?.children.length, 1)
    const placeholder = second?.children[0]
    assert.equal(placeholder?.channelLabel, undefined)
    assert.equal(placeholder?.channelState, 'unknown')
    assert.equal(placeholder?.selectable, false)
  })

  it('只有设备行可以被选中（根与叶子都不导航）', () => {
    const tree = buildDeviceTree(source())
    const rows = flattenDeviceTree(source()).rows
    assert.deepEqual(selectableIds(rows), [
      deviceNodeId('box-1'),
      deviceNodeId('box-2'),
      deviceNodeId('cam-1')
    ])
    assert.equal(tree.selectable, false)
  })

  it('节点 id 是稳定且唯一的，并可以反解出设备 id', () => {
    const rows = flattenDeviceTree(source()).rows
    assert.equal(new Set(rows.map((row) => row.id)).size, rows.length)
    assert.equal(deviceIdOfNodeId(deviceNodeId('box-1')), 'box-1')
    assert.equal(deviceIdOfNodeId(channelNodeId('box-1', 3)), null)
    assert.equal(deviceIdOfNodeId(streamNodeId('cam-1')), null)
    assert.equal(deviceIdOfNodeId(undefined), null)
  })
})

// ---------------------------------------------------------------------------
// 展开 / 收起
// ---------------------------------------------------------------------------

describe('展开与收起', () => {
  it('根收起时只剩根这一行（收起的是子树，不是整棵树）', () => {
    const rows = flattenDeviceTree(source({ expanded: new Set() })).rows
    assert.deepEqual(
      rows.map((row) => row.id),
      [DEVICE_TREE_ROOT_ID]
    )
  })

  it('根展开但设备收起时：只有设备行，没有通道行', () => {
    const rows = flattenDeviceTree(source({ expanded: new Set([DEVICE_TREE_ROOT_ID]) })).rows
    assert.deepEqual(
      rows.map((row) => row.id),
      [DEVICE_TREE_ROOT_ID, deviceNodeId('box-1'), deviceNodeId('box-2'), deviceNodeId('cam-1')]
    )
  })

  it('展开一台设备：它的通道行紧接着它出现', () => {
    const rows = flattenDeviceTree(source()).rows
    const ids = rows.map((row) => row.id)
    const anchor = ids.indexOf(deviceNodeId('box-1'))
    assert.deepEqual(ids.slice(anchor, anchor + 4), [
      deviceNodeId('box-1'),
      channelNodeId('box-1', 0),
      channelNodeId('box-1', 1),
      channelNodeId('box-1', 2)
    ])
  })

  it('展开集合的增删是纯粹的（返回新数组，不改原数组）', () => {
    const original = [DEVICE_TREE_ROOT_ID]
    const added = toggleExpanded(original, deviceNodeId('box-1'))
    assert.deepEqual(original, [DEVICE_TREE_ROOT_ID])
    assert.deepEqual(added, [DEVICE_TREE_ROOT_ID, deviceNodeId('box-1')])
    assert.deepEqual(toggleExpanded(added, deviceNodeId('box-1')), [DEVICE_TREE_ROOT_ID])
  })

  it('默认展开所有设备；全部展开还包含根', () => {
    const devices = [box('box-1'), camera('cam-1')]
    assert.deepEqual(defaultExpandedIds(devices), [
      deviceNodeId('box-1'),
      deviceNodeId('cam-1')
    ])
    assert.deepEqual(expandAllIds(devices), [
      DEVICE_TREE_ROOT_ID,
      deviceNodeId('box-1'),
      deviceNodeId('cam-1')
    ])
  })

  it('从 localStorage 读回来的展开集合会剔掉已经不存在的节点（不会无限增长）', () => {
    const devices = [box('box-1')]
    const pruned = pruneExpandedIds(
      [DEVICE_TREE_ROOT_ID, deviceNodeId('box-1'), deviceNodeId('deleted')],
      devices
    )
    assert.deepEqual(pruned, [DEVICE_TREE_ROOT_ID, deviceNodeId('box-1')])
  })
})

// ---------------------------------------------------------------------------
// 筛选
// ---------------------------------------------------------------------------

describe('筛选', () => {
  it('按名称、地址、设备 id 与家族匹配，大小写与首尾空格不敏感', () => {
    const device = box('box-1')
    assert.equal(device.ip, '192.168.1.50')
    assert.equal(matchesDeviceFilter(device, '声纹'), true)
    assert.equal(matchesDeviceFilter(device, 'BOX-1'), true)
    assert.equal(matchesDeviceFilter(device, '  192.168.1.50 '), true)
    assert.equal(matchesDeviceFilter(device, 'uid-box-1'), true)
    assert.equal(matchesDeviceFilter(device, 'acousticbox'), true)
    assert.equal(matchesDeviceFilter(device, '相机'), false)
    assert.equal(matchesDeviceFilter(device, ''), true)
    assert.equal(normaliseTreeFilter('  AbC '), 'abc')
  })

  it('筛选只留下匹配的设备行，不匹配的整棵子树都不出现', () => {
    const rows = flattenDeviceTree(source({ filter: '声学相机' })).rows
    // 根行始终在（它是「设备拓扑」这个分组本身），其余不匹配的设备整棵子树消失。
    assert.deepEqual(
      rows.map((row) => row.id),
      [DEVICE_TREE_ROOT_ID, deviceNodeId('cam-1'), streamNodeId('cam-1')]
    )
  })

  it('筛选生效时匹配设备的通道**全部展开**（搜到了却看不到通道等于筛选失效）', () => {
    // 「风机」只出现在 box-1 的 CH1 通道名里，所以匹配到的是它的**设备行**。
    const rows = flattenDeviceTree(source({ filter: '风机' })).rows
    const ids = rows.map((row) => row.id)
    assert.deepEqual(ids, [
      DEVICE_TREE_ROOT_ID,
      deviceNodeId('box-1'),
      channelNodeId('box-1', 0),
      channelNodeId('box-1', 1),
      channelNodeId('box-1', 2)
    ])
  })

  it('一台都没匹配上时没有任何行（界面据此显示「没有匹配」而不是空白树）', () => {
    const rows = flattenDeviceTree(source({ filter: '不存在的设备' })).rows
    assert.deepEqual(rows, [])
  })

  it('筛选不改变树的拓扑：通道节点在筛选下依然由设备真实数据决定', () => {
    const filtered = buildDeviceTree(source({ filter: 'box-2' }))
    const second = filtered.children[1]
    // box-2 的通道表仍然没读到，所以仍然只有一个 unknown 的说明行。
    assert.equal(second?.children.length, 1)
    assert.equal(second?.children[0]?.channelState, 'unknown')
  })
})

// ---------------------------------------------------------------------------
// 键盘导航
// ---------------------------------------------------------------------------

describe('键盘导航', () => {
  const rows = flattenDeviceTree(source()).rows

  it('认识方向键/回车/空格/Home/End，别的键不拦', () => {
    assert.equal(isTreeKey('ArrowDown'), true)
    assert.equal(isTreeKey('Enter'), true)
    assert.equal(isTreeKey(' '), true)
    assert.equal(isTreeKey('Home'), true)
    assert.equal(isTreeKey('End'), true)
    assert.equal(isTreeKey('a'), false)
    assert.equal(isTreeKey('Tab'), false)
  })

  it('没有焦点时，第一次按方向键落在第一行', () => {
    assert.deepEqual(navigateTree(rows, null, 'ArrowDown'), {
      focusId: rows[0]?.id ?? null,
      action: 'none'
    })
  })

  it('上下移动，并在两端夹住（不会越界）', () => {
    const first = rows[0]?.id ?? null
    assert.equal(navigateTree(rows, first, 'ArrowUp').focusId, first)
    assert.equal(navigateTree(rows, first, 'ArrowDown').focusId, rows[1]?.id)
    const last = rows[rows.length - 1]?.id ?? null
    assert.equal(navigateTree(rows, last, 'ArrowDown').focusId, last)
  })

  it('Home / End 到首尾', () => {
    const middle = deviceNodeId('box-1')
    assert.equal(navigateTree(rows, middle, 'Home').focusId, rows[0]?.id)
    assert.equal(navigateTree(rows, middle, 'End').focusId, rows[rows.length - 1]?.id)
  })

  it('右键：收起时展开，已展开时进入第一个子行', () => {
    const collapsedRows = flattenDeviceTree(
      source({ expanded: new Set([DEVICE_TREE_ROOT_ID]) })
    ).rows
    const collapsed = navigateTree(collapsedRows, deviceNodeId('box-1'), 'ArrowRight')
    assert.equal(collapsed.action, 'toggle')
    assert.equal(collapsed.focusId, deviceNodeId('box-1'))

    const expanded = navigateTree(rows, deviceNodeId('box-1'), 'ArrowRight')
    assert.equal(expanded.action, 'none')
    assert.equal(expanded.focusId, channelNodeId('box-1', 0))
  })

  it('左键：展开时收起，已收起时回到父行', () => {
    const expanded = navigateTree(rows, deviceNodeId('box-1'), 'ArrowLeft')
    assert.equal(expanded.action, 'toggle')
    assert.equal(expanded.focusId, deviceNodeId('box-1'))

    const collapsedRows = flattenDeviceTree(
      source({ expanded: new Set([DEVICE_TREE_ROOT_ID]) })
    ).rows
    const back = navigateTree(collapsedRows, deviceNodeId('box-1'), 'ArrowLeft')
    assert.equal(back.focusId, DEVICE_TREE_ROOT_ID)

    // 通道叶子的左键回到它所属的设备。
    const leaf = navigateTree(rows, channelNodeId('box-1', 1), 'ArrowLeft')
    assert.equal(leaf.focusId, deviceNodeId('box-1'))
  })

  it('回车：设备行是「打开」，分支行是「展开/收起」，通道行什么都不做', () => {
    assert.deepEqual(navigateTree(rows, deviceNodeId('cam-1'), 'Enter'), {
      focusId: deviceNodeId('cam-1'),
      action: 'select'
    })
    assert.equal(navigateTree(rows, DEVICE_TREE_ROOT_ID, 'Enter').action, 'toggle')
    assert.equal(navigateTree(rows, channelNodeId('box-1', 0), 'Enter').action, 'none')
  })

  it('焦点行被筛选掉之后，下一次按键落在第一行（键盘不会失效）', () => {
    const narrow = flattenDeviceTree(source({ filter: '声学相机' })).rows
    const navigation = navigateTree(narrow, channelNodeId('box-1', 0), 'ArrowDown')
    assert.equal(navigation.focusId, narrow[0]?.id)
  })

  it('空树上任何按键都得到 null 焦点', () => {
    assert.deepEqual(navigateTree([], null, 'ArrowDown'), { focusId: null, action: 'none' })
    assert.deepEqual(navigateTree([], 'device:x', 'Enter'), { focusId: null, action: 'none' })
  })
})

// ---------------------------------------------------------------------------
// 选择 -> 路由
// ---------------------------------------------------------------------------

describe('选择与路由的双向同步', () => {
  it('选中一台设备跳转到它的监控页（查询串带设备 id）', () => {
    assert.deepEqual(monitorRouteForDevice('cam-1'), {
      path: '/monitor',
      query: { device: 'cam-1' }
    })
  })

  it('到达路由时：查询串优先', () => {
    const devices = [box('box-1'), camera('cam-1')]
    assert.equal(selectedDeviceForRoute('cam-1', 'box-1', devices), 'cam-1')
  })

  it('查询串缺失/无效时退回记住的那台，再退回第一台', () => {
    const devices = [box('box-1'), camera('cam-1')]
    assert.equal(selectedDeviceForRoute(undefined, 'cam-1', devices), 'cam-1')
    assert.equal(selectedDeviceForRoute('   ', 'cam-1', devices), 'cam-1')
    // 查询串指向一台已经不存在的设备（旧书签）：不能高亮一个不存在的节点。
    assert.equal(selectedDeviceForRoute('deleted', 'cam-1', devices), 'cam-1')
    assert.equal(selectedDeviceForRoute(undefined, '', devices), 'box-1')
    assert.equal(selectedDeviceForRoute(undefined, '', []), '')
  })

  it('查询串不是字符串（数组/对象）时被忽略，而不是崩掉', () => {
    const devices = [box('box-1')]
    assert.equal(selectedDeviceForRoute(['cam-1'], 'box-1', devices), 'box-1')
    assert.equal(selectedDeviceForRoute({ device: 'cam-1' }, '', devices), 'box-1')
  })
})

// ---------------------------------------------------------------------------
// 行的显示文字（这一轮：声学相机的地址不进树）
// ---------------------------------------------------------------------------

describe('设备树的行文字', () => {
  /**
   * 声学相机的兜底名**就是地址**。
   *
   * 这不是造出来的极端值：`main/services/device/camera-identity.ts` 说明 FA371 的开放
   * 接口没有身份端点，`device-service` 于是在操作员不给名字时写入
   * `Acoustic Camera <ip>`，uid 也从 `ip:port` 铸出来。所以「名字里带地址」在真相机的
   * 数据库里是**默认状态**，不是边缘情况。
   */
  it('名字就是地址时，相机行显示的是本地语言里的家族名，不是地址', () => {
    const fallback = '声学相机'
    assert.equal(
      treeDeviceLabel({ kind: 'acousticCamera', name: '192.168.110.235', ip: '192.168.110.235' }, fallback),
      fallback
    )
    // 真实的兜底写法：「Acoustic Camera 192.168.110.235」。
    assert.equal(
      treeDeviceLabel(
        { kind: 'acousticCamera', name: 'Acoustic Camera 192.168.110.235', ip: '192.168.110.235' },
        fallback
      ),
      fallback
    )
    // 首尾空格不改变判定。
    assert.equal(
      treeDeviceLabel(
        { kind: 'acousticCamera', name: '  Acoustic Camera 192.168.110.235  ', ip: '192.168.110.235' },
        fallback
      ),
      fallback
    )
  })

  it('操作员自己起过的名字原样显示 —— 哪怕名字里带着地址的一部分', () => {
    const fallback = '声学相机'
    assert.equal(
      treeDeviceLabel({ kind: 'acousticCamera', name: '3 号塔相机', ip: '192.168.110.235' }, fallback),
      '3 号塔相机'
    )
    // 以地址开头的名字不是「由地址推出来的」：只有**结尾**相同才算。
    assert.equal(
      treeDeviceLabel(
        { kind: 'acousticCamera', name: '192.168.110.235 旁的相机', ip: '192.168.110.235' },
        fallback
      ),
      '192.168.110.235 旁的相机'
    )
    // 声纹设备的默认名（`Acoustic Box <uid>`）不是地址，也不受影响。
    assert.equal(
      treeDeviceLabel({ kind: 'acousticBox', name: 'Acoustic Box AE08', ip: '192.168.1.50' }, '声纹设备'),
      'Acoustic Box AE08'
    )
  })

  it('没有地址、或名字为空时给出可读的文字，绝不给出空行', () => {
    assert.equal(
      treeDeviceLabel({ kind: 'acousticCamera', name: '相机 A', ip: '' }, '声学相机'),
      '相机 A'
    )
    assert.equal(
      treeDeviceLabel({ kind: 'acousticCamera', name: '', ip: '192.168.110.235' }, '声学相机'),
      '声学相机'
    )
    assert.equal(
      treeDeviceLabel({ kind: 'acousticCamera', name: '   ', ip: '192.168.110.235' }, '声学相机'),
      '声学相机'
    )
  })

  it('通道行文字是「通道号 + 通道名」，缺一个都不会多出一个空格', () => {
    assert.equal(treeChannelText('CH3', '风机 A'), 'CH3 风机 A')
    assert.equal(treeChannelText('CH3', ''), 'CH3')
    assert.equal(treeChannelText('CH3', undefined), 'CH3')
    assert.equal(treeChannelText(undefined, '风机 A'), '风机 A')
    assert.equal(treeChannelText(undefined, undefined), '')
  })
})
