/**
 * 视图对象在 store 里的两条**政策**，用源码守卫钉住。
 *
 * 为什么是源码守卫而不是行为测试
 *   `stores/liveWall.ts` 是 Pinia store，行为测试要拉起 Pinia 与一个 `window.localStorage` 桩；
 *   而这里真正要防止的是**将来某个人顺手加一行**：
 *     1. 「恢复视图时顺手把流拉起来」——那会绕过 `decideCameraAutoPlay()` 那条
 *        「一次进程一次尝试 / 操作员手动停止过就不再自动起」的规则，并在启动时静默拉起
 *        几路没人要的视频（正是 `stores/liveWall.ts` 文件头当初决定「格子分配不持久化」时要防的事）；
 *     2. 「磁盘上的值直接信」——视图数组来自 localStorage，必须逐项修补后才能用。
 *   这两条都是「代码里不该出现某种写法」，源码守卫是能长期生效的最直接形式（本仓库已有多处同样做法）。
 *
 * 守卫的**边界**（不夸大它的作用）：它只能证明这些字样不存在，证明不了运行时的完整行为。
 * 恢复绑定的**决定**逻辑本身在 `lib/cameraViewDivision.ts` 的 `bindViewToDevices()` 里，
 * 由 `tests/camera-view-division.test.ts` 逐条断言。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

const store = fs.readFileSync(
  path.join(process.cwd(), 'src/renderer/src/stores/liveWall.ts'),
  'utf8'
)

describe('视图对象：store 的两条政策', () => {
  it('store 绝不碰 cameraLive —— 恢复视图不可能拉起任何一路流', () => {
    // 注意：**提名字是允许的**。`liveWall.ts` 的注释里会出现 `cameraLive:state`（那是 IPC 频道名，
    // 用来说明状态从哪来），要求删掉有用注释来讨好测试是本末倒置。这里禁的是**真实的调用与导入**。
    assert.ok(
      !/from\s+['"]@renderer\/stores\/cameraLive['"]/.test(store),
      'store 不该导入 cameraLive store —— 一导入就离「顺手起流」只差一行'
    )
    assert.ok(!/window\.api\.cameraLive/.test(store), 'store 不该直接发 cameraLive IPC')
    assert.ok(!/\bcameraLive\s*\./.test(store), 'store 不该访问 cameraLive 的成员（例如 .start）')
    assert.ok(!store.includes('autoPlayIfWorking'), 'store 不该自己做自动起播判定')
  })

  it('视图用 hertzinno. 前缀的键落盘，与既有偏好同一套约定', () => {
    assert.ok(store.includes("'hertzinno.cameraWall.views'"), '视图键必须沿用 hertzinno. 前缀')
    assert.ok(store.includes("'hertzinno.cameraWall.layout'"), '档位键仍在（不要被顺手改掉）')
  })

  it('从磁盘读视图时必过 normaliseViews（坏值修补，不直接信）', () => {
    assert.ok(
      store.includes('normaliseViews(JSON.parse(raw))'),
      '读取路径必须经过 normaliseViews 修补'
    )
    assert.ok(/catch\s*\{[\s\S]{0,80}return \[\]/.test(store), '解析失败要回落到空列表而不是抛出去')
  })

  it('保存视图时把 5 套上限如实回报，而不是悄悄丢掉最旧的一套', () => {
    assert.ok(store.includes('MAX_CUSTOM_VIEWS'), '上限必须来自手册那个常量（p44，1495）')
    assert.ok(store.includes("'limit-reached'"), '达到上限要有可回报的原因')
    assert.ok(store.includes("'invalid-division'"), '分屏几何不合法也要有可回报的原因')
  })

  it('恢复只产出决定，明确写着尚未落到模型上', () => {
    // 这不是形式主义：现在的 CameraWallModel 档位是固定的 1|4|9|16，
    // 而 Joint 合并后的格子数可能不是平方数，所以「应用到墙上」确实还没做。
    assert.ok(store.includes('bindViewToDevices'), '恢复要用那个纯函数做解析')
    assert.ok(
      /还表达不了自定义分屏|表达不了/.test(store),
      '注释里必须写明模型尚未泛化，免得下一个人以为已经能应用'
    )
  })
})
