/**
 * 「共 N 路通道」里的 N 到底数的是什么。
 *
 * WHY THIS FILE EXISTS
 * 通道墙上一条格子的来源有两种（`ChannelWallTileSource`）：声纹设备的一路通道，
 * 或一台声学相机。相机**没有通道** —— 这是产品的结构性事实，也是
 * `buildTiles()` 让一台相机固定占一格、`isOnlineChannelTile()` 拒绝把相机算成
 * 「在线通道」的同一条规矩。
 *
 * 但 `channelWall.summary`（「共 {count} 路通道」）原先数的是**格子**：8 路盒子 +
 * 1 台相机于是显示「共 9 路通道」，而设备上一共只有 8 路通道 —— 界面替设备说了
 * 一句它没说过的话。这一条测试把计数钉在「通道」上，而不是「格子」上。
 *
 * 断言的是纯函数 `channelTileCount()`（模板只负责把它的返回值填进词条），因为
 * 模板里的 `tiles.length` 在浏览器外无法断言 —— 这正是它当初写错却没人发现的原因。
 *
 * 中文注释是仓库约定（见 tests/channel-state.test.ts）。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { buildTiles, channelTileCount, type ChannelWallSource } from '../src/renderer/src/lib/channelWall'
import { SensorType, type Channel, type Device } from '../src/shared/domain/models'
import { zhCN } from '../src/shared/i18n/messages/zh-CN'
import { en } from '../src/shared/i18n/messages/en'
import { es } from '../src/shared/i18n/messages/es'
import { tr } from '../src/shared/i18n/messages/tr'

/** 一台设备（默认在线声纹盒子；相机用 `kind` 覆盖）。 */
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

function channel(deviceId: string, channelIndex: number, enabled: boolean): Channel {
  return {
    id: `${deviceId}:${channelIndex}`,
    deviceId,
    channelIndex,
    channelName: `name${channelIndex + 1}`,
    sensorType: SensorType.Microphone,
    enabled,
    createdAt: 0,
    updatedAt: 0
  } as unknown as Channel
}

/** 8 路盒子（前两路启用）+ 1 台相机，与真机现场的那一套一致。 */
function liveSource(): ChannelWallSource {
  return {
    devices: [device({ id: 'box' }), device({ id: 'cam', kind: 'acousticCamera', name: '相机 A' })],
    channels: {
      box: Array.from({ length: 8 }, (_, index) => channel('box', index, index < 2))
    }
  }
}

describe('通道墙的「共 N 路通道」', () => {
  it('相机格不算通道：8 路盒子 + 1 台相机 = 8，不是 9', () => {
    const tiles = buildTiles(liveSource())

    // 格子有 9 个（8 路通道 + 1 台相机），但通道只有 8 路。
    assert.equal(tiles.length, 9)
    assert.equal(tiles.filter((tile) => tile.source === 'cameraStream').length, 1)
    assert.equal(channelTileCount(tiles), 8)
  })

  it('只有相机时是 0 路通道（相机没有通道，这是事实不是缺数据）', () => {
    const tiles = buildTiles({
      devices: [device({ id: 'cam', kind: 'acousticCamera' })],
      channels: {}
    })
    assert.equal(tiles.length, 1)
    assert.equal(channelTileCount(tiles), 0)
  })

  it('只有盒子时等于盒子真的上报了几路通道', () => {
    const tiles = buildTiles({
      devices: [device({ id: 'box2' })],
      channels: { box2: [channel('box2', 0, true), channel('box2', 1, false)] }
    })
    assert.equal(channelTileCount(tiles), 2)
  })

  it('通道表还没读到的设备不产出格子，也不计入通道数', () => {
    const tiles = buildTiles({
      devices: [device({ id: 'box' }), device({ id: 'silent' })],
      channels: { box: [channel('box', 0, true)] }
    })
    assert.equal(tiles.length, 1)
    assert.equal(channelTileCount(tiles), 1)
  })

  it('空墙是 0', () => {
    assert.equal(channelTileCount([]), 0)
  })

  it('四种语言的词条都还在（key 不在时界面会显示裸 key）', () => {
    for (const catalogue of [zhCN, en, es, tr]) {
      assert.equal(typeof catalogue.channelWall.summary, 'string')
      assert.match(catalogue.channelWall.summary, /\{count\}/)
    }
  })
})
