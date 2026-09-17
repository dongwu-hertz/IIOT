/**
 * 离线点位图的**投影**（业主 2026-09-17 第 8 批第 2 条）。
 *
 * WHY THIS FILE EXISTS
 * 这张图没有地图库兜底：坐标全是我们自己算的。算错的表现**不是报错**，而是"看起来像一张图
 * 但相对位置是错的" —— 现场两台设备明明一东一西，图上却是南北向排开。所以这里钉三件事：
 *
 *   1. **相对方位是真的**：北在上、东在右，而且经度按 `cos(纬度)` 压缩（北纬 31° 上
 *      1° 经度的地面距离只有 1° 纬度的 ~0.857 倍）；
 *   2. **等比**：x 与 y 用的是同一个 px/度（经度折过之后），所以图上的夹角等于现场的夹角；
 *   3. **没有点位 / 只有一个点**这两种情况不会把图画坏（不画在原点、不除零飞去画布外）。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  MIN_SPAN_DEG,
  deviceMapLayout,
  hasMapPoint,
  mapBounds,
  mapGridSteps
} from '../src/shared/domain/device-map'

const SHANGHAI = { latitude: 31.2304, longitude: 121.4737 }

describe('点位图：边界', () => {
  it('一台设备都没有点位 ⇒ 没有边界（界面那时说"没有可画的点位"）', () => {
    assert.equal(mapBounds([{ id: 'a', name: 'A' }]), undefined)
    assert.equal(mapBounds([]), undefined)
  })

  it('经纬度只有一半的点位**不算点位**（半坐标画不出位置）', () => {
    assert.equal(hasMapPoint({ id: 'a', name: 'A', latitude: 31.2 }), false)
    assert.equal(hasMapPoint({ id: 'a', name: 'A', longitude: 121.4 }), false)
    assert.equal(hasMapPoint({ id: 'a', name: 'A', latitude: 31.2, longitude: 121.4 }), true)
    const layout = deviceMapLayout(
      [
        { id: 'a', name: 'A', latitude: 31.2 },
        { id: 'b', name: 'B', latitude: 31.2, longitude: 121.4 }
      ],
      400,
      300
    )
    assert.deepEqual(layout.markers.map((marker) => marker.id), ['b'])
    assert.deepEqual(layout.withoutPoint.map((device) => device.id), ['a'])
  })

  it('单个点（或重合的点）用最小视野撑开，不出现零宽/零高的边界', () => {
    const bounds = mapBounds([{ id: 'a', name: 'A', ...SHANGHAI }])
    assert.ok(bounds)
    /*
     * 容差 1e-12：`centre ± span/2` 再相减会有浮点尾差（121.47395 − 121.47345 比 0.0005
     * 小 1.2e-14）。断言写 `>= MIN_SPAN_DEG` 会被这个尾差判失败 —— 那是断言太严，
     * 不是边界算错了（下面"单点落在正中"那条才是真正在验它）。
     */
    assert.ok((bounds?.maxLat ?? 0) - (bounds?.minLat ?? 0) >= MIN_SPAN_DEG - 1e-12)
    assert.ok((bounds?.maxLon ?? 0) - (bounds?.minLon ?? 0) >= MIN_SPAN_DEG - 1e-12)
    // 点落在正中间附近（撑开之后中心就是它）。
    const layout = deviceMapLayout([{ id: 'a', name: 'A', ...SHANGHAI }], 400, 300)
    const marker = layout.markers[0]
    assert.ok(marker)
    assert.ok(Math.abs((marker?.x ?? 0) - 200) < 1, '单点没有落在水平中间：' + marker?.x)
    assert.ok(Math.abs((marker?.y ?? 0) - 150) < 1, '单点没有落在垂直中间：' + marker?.y)
  })
})

describe('点位图：投影（北在上、东在右、经度按纬度压缩）', () => {
  const west = { id: 'w', name: '西', latitude: 31.23, longitude: 121.4 }
  const east = { id: 'e', name: '东', latitude: 31.23, longitude: 121.5 }
  const north = { id: 'n', name: '北', latitude: 31.3, longitude: 121.45 }
  const south = { id: 's', name: '南', latitude: 31.16, longitude: 121.45 }

  it('东边的点 x 更大，北边的点 y 更小', () => {
    const layout = deviceMapLayout([west, east, north, south], 600, 400)
    const byId = new Map(layout.markers.map((marker) => [marker.id, marker]))
    assert.ok((byId.get('e')?.x ?? 0) > (byId.get('w')?.x ?? 0), '东边的点没有画在右边')
    assert.ok((byId.get('n')?.y ?? 0) < (byId.get('s')?.y ?? 0), '北边的点没有画在上面')
  })

  it('**等比**：同样的地面距离在图上画成同样的长度（经度折过 cos(纬度)）', () => {
    /*
     * 取一个正方形的地面范围：0.1° 纬度（≈11.1 km）与 0.1/cos(31.23°)≈0.1169° 经度
     * （同样≈11.1 km）。等比的话两者在图上应该一样长（±1px 取整误差）。
     */
    const latCentre = 31.23
    const halfLat = 0.05
    const halfLon = halfLat / Math.cos((latCentre * Math.PI) / 180)
    const layout = deviceMapLayout(
      [
        { id: 'bl', name: 'BL', latitude: latCentre - halfLat, longitude: 121.45 - halfLon },
        { id: 'tr', name: 'TR', latitude: latCentre + halfLat, longitude: 121.45 + halfLon }
      ],
      800,
      800
    )
    const bl = layout.markers.find((marker) => marker.id === 'bl')
    const tr = layout.markers.find((marker) => marker.id === 'tr')
    assert.ok(bl && tr)
    const dx = (tr?.x ?? 0) - (bl?.x ?? 0)
    const dy = (bl?.y ?? 0) - (tr?.y ?? 0)
    assert.ok(Math.abs(dx - dy) <= 1, `正方形的地面范围画成了 ${dx}×${dy}（不等比）`)
  })

  it('画布太小时不留负空间：标记仍然落在画布内', () => {
    const layout = deviceMapLayout([west, east, north, south], 40, 30, 28)
    for (const marker of layout.markers) {
      assert.ok(marker.x >= 0 && marker.x <= 40, `x 越界：${marker.x}`)
      assert.ok(marker.y >= 0 && marker.y <= 30, `y 越界：${marker.y}`)
    }
  })
})

describe('点位图：网格刻度', () => {
  it('按视野取"好看的步长"，条数有限', () => {
    const steps = mapGridSteps({ minLat: 31.2, maxLat: 31.3, minLon: 121.4, maxLon: 121.5 })
    assert.ok(steps.lat.length > 1 && steps.lat.length <= 6, JSON.stringify(steps.lat))
    assert.ok(steps.lon.length > 1 && steps.lon.length <= 6, JSON.stringify(steps.lon))
    // 刻度落在边界内，而且间隔一致。
    const gaps = steps.lat.slice(1).map((value, index) => Number((value - (steps.lat[index] ?? 0)).toFixed(6)))
    assert.equal(new Set(gaps).size, 1, JSON.stringify(steps.lat))
  })

  it('跨大范围的视野也能给出刻度（步长随视野放大）', () => {
    const steps = mapGridSteps({ minLat: 20, maxLat: 40, minLon: 100, maxLon: 130 })
    assert.ok(steps.lat.length >= 3 && steps.lat.length <= 6, JSON.stringify(steps.lat))
    assert.ok(steps.lon.length >= 3 && steps.lon.length <= 6, JSON.stringify(steps.lon))
  })
})
