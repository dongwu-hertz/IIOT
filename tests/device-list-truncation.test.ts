/**
 * 设备列表**不许被"单台刷新"截断**（2026-09-17 定位并修掉的缺陷）。
 *
 * WHY THIS FILE EXISTS
 * 现象（业主可见）：进过一次设备详情页之后，全应用的设备列表就只剩那一台 ——
 * 顶栏的"设备总数"变小、实时监测页的设备下拉里只剩一台、设备树上少了几台，而库里一台都没少。
 *
 * 成因链（三处代码各自都对，合起来错）：
 *   1. 主进程的 `DEVICE_REFRESH_STATUS`：**带 id 时只回那一台**
 *      （`return [services.devices.get(id)]`），不带 id 才回整份设备表；
 *   2. `stores/devices.ts` 的 `refreshStatus(id)` 原来一律 `devices.value = list`
 *      —— 把"一台"当成"整份"；
 *   3. `DeviceDetailView` 在**挂载时**就调 `refreshStatus(props.id)`（`refresh()` → 那一次
 *      `Promise.all`），所以"打开任意一台设备的详情页"就会触发。
 *
 * 所以守卫必须同时钉住这三件事：主进程的两种返回、store 的合并语义、以及详情页确实会调它。
 * 只钉其中一条，另外两条一改就又会出现同样的现象（而且不报错）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

const projectRoot = path.resolve(__dirname, '..', '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

/** 去掉注释：注释里会提到这些标识符，断言必须跑在**生效的代码**上。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

/** 取出一对标记之间的源码；找不到就断言失败（改名/删除必须报出来，不能静默通过）。 */
function between(source: string, open: string, close: string, label: string): string {
  const start = source.indexOf(open)
  assert.ok(start >= 0, `找不到 ${label} 的起点：${open}`)
  const end = source.indexOf(close, start + open.length)
  assert.ok(end > start, `找不到 ${label} 的终点：${close}`)
  return source.slice(start, end)
}

const store = stripComments(read('src/renderer/src/stores/devices.ts'))
const handlers = stripComments(read('src/main/ipc/handlers.ts'))
const detail = stripComments(read('src/renderer/src/views/DeviceDetailView.vue'))
const driver = read('scripts/demo-shot-driver.cjs')

describe('设备列表：单台刷新只能合并，不能整份替换', () => {
  it('store 的 refreshStatus 区分"带 id"与"不带 id"两种情况', () => {
    const body = between(store, 'async function refreshStatus', '\n  }', 'refreshStatus()')
    assert.ok(body.length > 0, '读不到 refreshStatus()')
    // 不带 id：整份替换（主进程回的就是整份）。
    assert.ok(
      /if \(id === undefined\) \{\s*devices\.value = list/.test(body),
      '不带 id 的全量刷新没有整份替换'
    )
    // 带 id：按 id 合并（主进程只回那一台）。
    assert.ok(
      body.includes('findIndex'),
      '带 id 的单台刷新没有按 id 合并 —— 全应用的设备列表会被这一台替换掉'
    )
    assert.equal(
      /else\s*\{?\s*devices\.value = list/.test(body),
      false,
      '带 id 的分支又出现了整份替换（缺陷回归）'
    )
  })

  it('主进程确实是"带 id 只回一台"（store 的合并语义就是为了它）', () => {
    const handler = between(
      handlers,
      'IpcChannels.DEVICE_REFRESH_STATUS',
      'IpcChannels.DEVICE_GET_INFO',
      'DEVICE_REFRESH_STATUS'
    )
    assert.ok(handler.length > 0, '找不到 DEVICE_REFRESH_STATUS 处理器')
    assert.ok(
      /if \(id\) \{[\s\S]*?return \[services\.devices\.get\(id\)\]/.test(handler),
      '主进程带 id 时不再只回一台 —— 那 store 那边的合并语义就要跟着改（两处必须同时改）'
    )
    assert.ok(
      /return services\.devices\.list\(\)/.test(handler),
      '主进程不带 id 时不再回整份列表'
    )
  })

  it('设备详情页在挂载时就会调它（所以"进一次详情页"就能触发）', () => {
    assert.ok(
      detail.includes('devices.refreshStatus(props.id)'),
      '设备详情页不再单台刷新（若确实删掉了，这条守卫与 store 的合并语义要一起复核）'
    )
    const mounted = between(detail, 'onMounted(async () => {', '\n})', 'onMounted')
    assert.ok(mounted.includes('await refresh()'), '详情页挂载时不再刷新 —— 触发条件变了')
  })

  it('探针里钉着"界面上的设备数不许少于库里的"（这条断言就是本缺陷的回归守卫）', () => {
    // 探针会经过一次详情页（切听诊盒子页签并同步），修复前下拉只有 1 台而库里有 3 台。
    assert.ok(
      driver.includes('实时监测页的设备下拉少于库里的设备数'),
      '探针丢掉了"界面设备数 vs 库里设备数"那条断言 —— 本缺陷会再次无声回归'
    )
    assert.ok(
      driver.includes('顶栏的设备总数少于库里的'),
      '探针丢掉了顶栏那个第二读数（它能把"下拉渲染错了"排除掉）'
    )
  })
})
