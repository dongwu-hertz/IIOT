/**
 * 「实时检测无设备时显示该 IP 离线并显示上次内容」（业主 2026-09-18 第 10 批第 18 条）。
 *
 * WHY THIS FILE EXISTS
 * 这一条讲的是**没有活数据时屏幕上说什么**，而"没有活数据"有六种样子（没设备 / 离线 /
 * 等首帧 / 实时 / 数据停了 / 操作员自己停的），它们对操作员意味着完全不同的下一步。
 * 模板里写三个 `v-if` 很容易，难的是**六档的判据只有一处** —— 同一屏上徽标、提示条、
 * 图表角标各判一次，迟早会出现"提示条说离线、图表说等待数据"这种自相矛盾的界面。
 *
 * 所以判据抽成了 `@shared/domain/monitor-offline.ts` 的纯函数（这一份逐档断言），
 * store 那一边只负责"上次内容"的留存与过滤（`monitorUsesLastContent` 也在这里钉）。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  MONITOR_STALE_AFTER_MS,
  monitorShowsLastContent,
  monitorSourceState,
  monitorStaleBadgeKey,
  monitorUsesLastContent,
  type MonitorSourceState
} from '../src/shared/domain/monitor-offline'
import { zhCN } from '../src/shared/i18n/messages/zh-CN'
import { en } from '../src/shared/i18n/messages/en'
import { es } from '../src/shared/i18n/messages/es'
import { tr } from '../src/shared/i18n/messages/tr'

const projectRoot = path.resolve(__dirname, '..', '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

/**
 * 去注释那一份源码（HTML 注释 / 块注释 / 整行 `//`）。
 *
 * 反向断言（"某个键还在不在"）必须读它：这一轮的注释里**点名写了被删掉的键**
 * （"提示条那个键（sourceMessageKey）在……删掉了"），第一版就是被自己的注释绊红的。
 */
function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

const CATALOGUES: Record<string, { monitorUi: Record<string, unknown> }> = {
  'zh-CN': zhCN as unknown as { monitorUi: Record<string, unknown> },
  en: en as unknown as { monitorUi: Record<string, unknown> },
  es: es as unknown as { monitorUi: Record<string, unknown> },
  tr: tr as unknown as { monitorUi: Record<string, unknown> }
}

const ALL_STATES: MonitorSourceState[] = [
  'no-device',
  'device-offline',
  'waiting',
  'live',
  'stale',
  'stopped'
]

const NOW = 1_700_000_000_000

// ---------------------------------------------------------------------------
// 1. 六档判据
// ---------------------------------------------------------------------------

describe('六档状态：没有活数据时到底在说什么', () => {
  it('一台设备都没有 → 没有设备（**没有 IP 可说**）', () => {
    assert.equal(
      monitorSourceState({ hasDevice: false, sessionState: 'idle', now: NOW }),
      'no-device'
    )
  })

  it('设备离线 → 离线（哪怕主进程还留着上一帧：说"数据停了"会把排查引到推送上去）', () => {
    assert.equal(
      monitorSourceState({
        hasDevice: true,
        deviceStatus: 'OFFLINE',
        sessionState: 'running',
        lastFrameAt: NOW - 100,
        now: NOW
      }),
      'device-offline'
    )
    // `UNKNOWN`（还没探过）**不算离线**：那是"没读到"，不是"它不通"。
    assert.equal(
      monitorSourceState({
        hasDevice: true,
        deviceStatus: 'UNKNOWN',
        sessionState: 'running',
        now: NOW
      }),
      'waiting'
    )
  })

  it('在线但一帧都没来 → 等待（而不是"上次内容"：没有上次内容可显示）', () => {
    assert.equal(
      monitorSourceState({ hasDevice: true, deviceStatus: 'ONLINE', sessionState: 'running', now: NOW }),
      'waiting'
    )
    assert.equal(
      monitorSourceState({ hasDevice: true, deviceStatus: 'ONLINE', sessionState: 'starting', now: NOW }),
      'waiting'
    )
    // 会话没在跑又没有帧：说"已停止"。
    assert.equal(
      monitorSourceState({ hasDevice: true, deviceStatus: 'ONLINE', sessionState: 'idle', now: NOW }),
      'stopped'
    )
  })

  it('有帧且新鲜 → 实时；超过阈值 → 已停止更新', () => {
    assert.equal(
      monitorSourceState({
        hasDevice: true,
        deviceStatus: 'ONLINE',
        sessionState: 'running',
        lastFrameAt: NOW - 500,
        now: NOW
      }),
      'live'
    )
    assert.equal(
      monitorSourceState({
        hasDevice: true,
        deviceStatus: 'ONLINE',
        sessionState: 'running',
        lastFrameAt: NOW - MONITOR_STALE_AFTER_MS - 1,
        now: NOW
      }),
      'stale'
    )
    // 边界：正好等于阈值不算停（">" 而不是 ">="）。
    assert.equal(
      monitorSourceState({
        hasDevice: true,
        deviceStatus: 'ONLINE',
        sessionState: 'running',
        lastFrameAt: NOW - MONITOR_STALE_AFTER_MS,
        now: NOW
      }),
      'live'
    )
  })

  it('会话停了但帧还新鲜 → 已停止（那是"上次内容"，不是实时）', () => {
    assert.equal(
      monitorSourceState({
        hasDevice: true,
        deviceStatus: 'ONLINE',
        sessionState: 'idle',
        lastFrameAt: NOW - 100,
        now: NOW
      }),
      'stopped'
    )
  })

  it('哪些档要留在屏幕上（`live` 之外都留，否则屏幕会突然变空）', () => {
    const keep: Record<MonitorSourceState, boolean> = {
      'no-device': false,
      'device-offline': true,
      waiting: false,
      live: false,
      stale: true,
      stopped: true
    }
    for (const state of ALL_STATES) {
      assert.equal(monitorShowsLastContent(state), keep[state], state)
    }
  })

  it('角标键：只有"不是实时"的那三档才标"上次内容"', () => {
    /*
     * **提示条那一组断言在 2026-09-19 第 13 批第 1 条删掉了**：业主说那条弹窗
     * 「（192.168.110.90 离线 还没有收到过这台设备的任何数据）这个内容不用显示」，
     * 提示条整个撤掉，它的正文键（`offlineBanner` / `waitingBanner` / `staleBanner` /
     * `stoppedBanner`）也从四本目录里删了。角标留着并继续断言 —— 它说的是另一件事。
     */
    assert.equal(monitorStaleBadgeKey('live'), null)
    assert.equal(monitorStaleBadgeKey('waiting'), null)
    assert.equal(monitorStaleBadgeKey('no-device'), null)
    for (const state of ['device-offline', 'stale', 'stopped'] as MonitorSourceState[]) {
      assert.equal(monitorStaleBadgeKey(state), 'monitorUi.staleBadge', state)
    }
  })
})

// ---------------------------------------------------------------------------
// 2. 「上次内容」该不该显示
// ---------------------------------------------------------------------------

describe('上次内容：只对**同一个来源**、而且只在没有活数据时才显示', () => {
  const snapshot = { deviceId: 'dev-1', channelId: 2 }

  it('同设备同通道 + 非实时 → 显示', () => {
    for (const state of ['device-offline', 'stale', 'stopped'] as MonitorSourceState[]) {
      assert.equal(
        monitorUsesLastContent({ snapshot, deviceId: 'dev-1', channelId: 2, state }),
        true,
        state
      )
    }
  })

  it('实时 / 等待 / 无设备 → 不显示（在线且出帧时显示旧数据就是界面在说假话）', () => {
    for (const state of ['live', 'waiting', 'no-device'] as MonitorSourceState[]) {
      assert.equal(
        monitorUsesLastContent({ snapshot, deviceId: 'dev-1', channelId: 2, state }),
        false,
        state
      )
    }
  })

  it('换了通道或换了设备 → 不显示（那是别人的数据，画在一张图上比不画更糟）', () => {
    assert.equal(
      monitorUsesLastContent({ snapshot, deviceId: 'dev-1', channelId: 3, state: 'stale' }),
      false,
      '换了通道'
    )
    assert.equal(
      monitorUsesLastContent({ snapshot, deviceId: 'dev-2', channelId: 2, state: 'stale' }),
      false,
      '换了设备'
    )
    assert.equal(
      monitorUsesLastContent({ snapshot: null, deviceId: 'dev-1', channelId: 2, state: 'stale' }),
      false,
      '没有上次内容'
    )
  })
})

// ---------------------------------------------------------------------------
// 3. store：接线（源码守卫）
// ---------------------------------------------------------------------------

/**
 * 为什么这一节是**源码守卫**而不是"驱动 store"：
 * `stores/monitor.ts` 运行时要 `@renderer/*` 那些模块（结果翻译、通道读数、i18n）并用
 * `window.*`，而测试工程的 tsconfig 里没有 `@renderer/*` 的路径映射、`lib` 也不是 DOM
 * （仓库里别的 store 测试同样只读源码 —— 见 `tests/camera-view-store.test.ts`）。
 * 判据本身已经在第 1、2 节逐条断言过，这里守的是"store 真的用了那两个纯函数、
 * 而且把上次内容的生命周期接对了"。
 */
describe('监测 store：接线（源码守卫）', () => {
  const store = read('src/renderer/src/stores/monitor.ts')
  /*
   * 两份读法：`store` 原样（要看到全文件），`storeCode` 去注释。
   * 「某个键还在不在」这类**反向**断言必须读去注释那一份 —— 我在注释里点名写了
   * 被删掉的键（"提示条那个键（sourceMessageKey）在……删掉了"），第一版就是被自己的
   * 注释绊红的。
   */
  const storeCode = stripComments(store)

  it('状态判据只有一处：用的是共享层那两个纯函数', () => {
    assert.match(store, /monitorSourceState\(\{/, '没有用共享层的状态机')
    assert.match(store, /monitorUsesLastContent\(\{/, '没有用共享层那一句"该不该显示上次内容"')
    assert.match(store, /monitorStaleBadgeKey\(sourceState\.value\)/, '角标键没有跟状态走')
    // 提示条那个键（`sourceMessageKey`）在第 13 批第 1 条之后不该再出现。
    assert.equal(
      /sourceMessageKey/.test(storeCode),
      false,
      'store 里还留着已删掉的提示条键'
    )
  })

  it('清缓冲之前先把这一份存成"上次内容"（键是清除那一刻的设备与通道）', () => {
    const clear = store.slice(store.indexOf('function clearBuffers'), store.indexOf('function snapshotContent'))
    assert.match(clear, /lastContent\.value = snapshotContent\(\)/, '清之前没有留一份')
    const snapshot = store.slice(store.indexOf('function snapshotContent'))
    const body = snapshot.slice(0, snapshot.indexOf('\n  }'))
    assert.match(body, /deviceId: deviceId\.value/, '快照没带设备 id')
    assert.match(body, /channelId: channelId\.value/, '快照没带通道号')
    assert.match(body, /at: times\.length > 0 \? Math\.max\(\.\.\.times\) : Date\.now\(\)/, '快照没有"最后一次"的时刻')
  })

  it('换设备丢掉上次内容（它属于上一台设备）', () => {
    const select = store.slice(store.indexOf('function selectDevice'), store.indexOf('function channelFeatureOf'))
    assert.match(select, /lastContent\.value = null/, '换设备没有丢掉上次内容')
  })

  it('"现在"是走时的，而且定时器随订阅起停（1 秒一次，离开就停）', () => {
    assert.match(store, /const now = ref\(Date\.now\(\)\)/, '没有走时的 now')
    assert.match(store, /clockTimer = window\.setInterval\(/, '没有那个 1 秒定时器')
    assert.match(store, /window\.clearInterval\(clockTimer\)/, '订阅停掉时没有清定时器')
    // 定时器必须在 `unsubscribe()` 里被清（否则离开页面还在跑）。
    const unsub = store.slice(store.indexOf('function unsubscribe'), store.indexOf('let clockTimer'))
    assert.match(unsub, /window\.clearInterval\(clockTimer\)/, 'unsubscribe 没有清定时器')
  })

  it('设备状态由界面注入（store 不持有设备列表）', () => {
    assert.match(store, /function setDeviceStatus\(/, '没有注入设备状态的入口')
    assert.match(store, /const deviceStatus = ref<DeviceStatus \| undefined>/, '没有存设备状态')
  })
})

// ---------------------------------------------------------------------------
// 4. 界面接线（源码守卫）
// ---------------------------------------------------------------------------

describe('界面接线（源码守卫）', () => {
  const view = read('src/renderer/src/views/MonitorView.vue')
  /** 去注释那一份（反向断言读它，理由同 store 那一节）。 */
  const viewCode = stripComments(view)

  it('那条"没有活数据"的提示条**不在界面上了**（第 13 批第 1 条的原话）', () => {
    /*
     * 业主 2026-09-19：「实时监测里面如果有告警弹窗（192.168.110.90 离线 还没有收到过这台设备的
     * 任何数据）这个内容不用显示」。括号里那两句就是这条提示条在"离线且从来没收到过数据"时的正文，
     * 所以判据是**整条都不在**，而不是"换一句话"。
     */
    assert.equal(
      viewCode.includes('data-monitor-source-banner'),
      false,
      '那条提示条又回到界面上了（第 13 批第 1 条已撤掉）'
    )
    for (const key of ['offlineBanner', 'offlineNoContent', 'staleBanner', 'stoppedBanner']) {
      assert.equal(viewCode.includes(key), false, `视图里还引用着已删掉的 ${key}`)
    }
    // 「上次内容」角标留着（它说的是"你正在看的这份数据是什么"，不是那条弹窗）。
    assert.ok(viewCode.includes('data-monitor-stale-badge'), '"上次内容"角标被顺手删掉了')
  })

  it('设备状态是**注入**进 store 的（store 不持有设备列表）', () => {
    assert.match(view, /monitor\.setDeviceStatus\(device\?\.status\)/, '没有把在线状态告诉 store')
  })

  it('图表读的是 `content`（活的优先、没有活的用上次内容），不是活缓冲', () => {
    assert.match(view, /SpectrogramViewer :frames="monitor\.content\.spectrogramFrames"/, '时频图没走 content')
    assert.match(view, /:peak="monitor\.content\.audio\?\.peak"/, '电平表没走 content')
    assert.match(view, /monitor\.content\.features\.length/, '趋势图的空态没走 content')
    // 活的缓冲**不再**被界面直接读（除了 frameCount 那种"这一路收了多少帧"的诊断）。
    assert.equal(
      /:frames="monitor\.spectrogramFrames"/.test(view),
      false,
      '界面还在直接读活缓冲（掉线时图会突然变空）'
    )
  })

  it('角标只在那份内容真的存在时出现（从没推过数据的设备上不许写"上次内容"）', () => {
    assert.ok(view.includes('data-monitor-stale-badge'), '没有"上次内容"角标')
    assert.match(
      view,
      /v-if="monitor\.staleBadgeKey && monitor\.content\.fromLastContent"/,
      '角标没有跟"这份内容真的存在"绑在一起'
    )
    assert.match(view, /monitor\.staleBadgeKey/, '角标没有跟状态走')
  })

  it('留下的那条文案四语言齐全（删掉的那七条必须真的不在目录里）', () => {
    /*
     * 第 13 批第 1 条之后这一组只剩「上次内容」一条。判据两头都钉：
     *   ① 留下的那条四语言都在；
     *   ② 被删掉的那七条**四语言都不在** —— 留着就是死键，而"删了代码忘了删词条"
     *      会让下一个人以为界面上还有那条提示。
     */
    for (const locale of Object.keys(CATALOGUES)) {
      const value = CATALOGUES[locale]!.monitorUi.staleBadge
      assert.equal(typeof value, 'string', `${locale} 缺 monitorUi.staleBadge`)
      assert.ok(String(value).trim() !== '', `${locale} 的 staleBadge 是空的`)
      for (const key of [
        'offlineBanner',
        'offlineNoIp',
        'offlineLastContent',
        'offlineNoContent',
        'waitingBanner',
        'staleBanner',
        'stoppedBanner'
      ]) {
        assert.equal(
          CATALOGUES[locale]!.monitorUi[key],
          undefined,
          `${locale} 目录里还留着已删掉的 monitorUi.${key}`
        )
      }
    }
    assert.ok(String(CATALOGUES['zh-CN']!.monitorUi.staleBadge).includes('上次'))
  })
})
