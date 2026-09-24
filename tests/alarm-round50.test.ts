/**
 * 第 50 轮：业主 2026-09-26 的五条告警相关要求（守卫）。
 *
 * 五条原话：
 *   1. 「实时设备监测里面的声学相机下面的 告警信息：应该是有个统一的标题格，时间，告警等级，
 *      告警类型，声场强度，主频 这些。并且告警信息这个窗口的高度和左侧 PRPD 的相同，
 *      告警数量应该支持自动换页的功能。这个页面中卡片之间的距离以及卡片和边沿的距离
 *      应该是和设备管理里的卡片与边缘的距离一致的。」
 *   2. 「告警控制里面显示的是 200 个告警，这内容应该和软件整体右上角的告警 ICON 一致。」
 *   3. 「点击告警信息里告警详情，点击后应该跳到告警中心查看该条告警的详情内容，应该包含，
 *      音频，视频，文件等内容。」
 *   4. 「告警中心的告警详情应该占全部宽度，右侧的一个小的告警详情页面应该删除。」
 *   5. 「点击可以查看对应的告警详情。并且告警中心中应该支持非告警弹窗的问题。」
 *
 * WHY THIS FILE EXISTS（为什么每一条都钉"屏幕上成立"的那个形式）
 *   · 第 1 条的量都在 CSS 与模板结构里，源码字符串本身证明不了任何事 —— 所以断的是
 *     **列清单与顺序**、**表格用的是统一标题格（thead）**、**换页由每页行数算出来**、
 *     以及**两条 CSS 事实**（网格 `stretch` 让告警卡与 PRPD 等高、板子自己不再叠一层内边距）；
 *   · 第 2 条断的是"那个数字**不是**全部待处理条数，而是未确认条数"，两处（角标与标题右侧）
 *     都读同一个 computed；
 *   · 第 3 条断的是跳转目标（`/alarms` 带 `cameraAlarm=<eventId>`）与告警中心真的认这个参数；
 *   · 第 4 条断的是"详情不再是那一列的第二格"（工作区只有一列）与"那个 640px 的小弹窗没了"；
 *   · 第 5 条断的是"点行一定给详情"（两条分支都进全宽面板）与"告警中心这一屏会说自己正在看着"
 *     （`quietForNotifications` 的判据只有一处）。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { zhCN } from '../src/shared/i18n/messages/zh-CN'
import { zhTW } from '../src/shared/i18n/messages/zh-TW'
import { en } from '../src/shared/i18n/messages/en'
import { es } from '../src/shared/i18n/messages/es'
import { tr } from '../src/shared/i18n/messages/tr'
import { ru } from '../src/shared/i18n/messages/ru'
import { LOCALES } from '../src/shared/i18n/locales'

const projectRoot = path.resolve(__dirname, '..', '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

/** 去掉注释：断言的是代码，不是散文。 */
function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !(trimmed.startsWith('//') || trimmed.startsWith('*'))
    })
    .join('\n')
}

const CATALOGUES: Record<string, unknown> = { 'zh-CN': zhCN, 'zh-TW': zhTW, en, es, tr, ru }

function messageAt(locale: string, key: string): unknown {
  let cursor: unknown = CATALOGUES[locale]
  for (const part of key.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor
}

const monitorRaw = read('src/renderer/src/views/MonitorView.vue')
const monitorView = stripComments(monitorRaw)
const alarmsRaw = read('src/renderer/src/views/AlarmsView.vue')
const alarmsView = stripComments(alarmsRaw)
const cameraControl = stripComments(read('src/renderer/src/components/CameraControlPanel.vue'))
const shell = stripComments(read('src/renderer/src/components/AppShell.vue'))
const centerMode = stripComments(read('src/renderer/src/stores/alarmCenterMode.ts'))

/** 取一段源码（从 start 到 end 之间），找不到时直接失败并说清找的是什么。 */
function slice(source: string, start: string, end: string, what: string): string {
  const from = source.indexOf(start)
  assert.ok(from >= 0, `找不到 ${what} 的起点：${start}`)
  const to = source.indexOf(end, from + start.length)
  assert.ok(to > from, `找不到 ${what} 的终点：${end}`)
  return source.slice(from, to)
}

/**
 * 取一个顶层声明/规则块的正文。
 *
 * 为什么不用 `slice(..., '\n}', ...)`：`stripComments()` 会把块内上一段的注释尾部留下
 * 一行 `}` 之外的散字，而这种文件里每个块后面都跟着下一段的注释 —— 用 `\n}` 当终点
 * 会切到**下一个块**里去（这一条是写完测试第一次跑时踩到的，见 `alarm-round50` 那轮的记录）。
 * 这里改成"从起点数花括号配平"，对 CSS 规则块与函数体都成立。
 */
function block(source: string, start: string, what: string): string {
  const from = source.indexOf(start)
  assert.ok(from >= 0, `找不到 ${what} 的起点：${start}`)
  const open = source.indexOf('{', from + start.length - 1)
  assert.ok(open > from, `找不到 ${what} 的左花括号`)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(from, index + 1)
    }
  }
  assert.fail(`找不到 ${what} 的右花括号（花括号不配平）`)
}

// ---------------------------------------------------------------------------
// ① 告警信息：统一标题格 / 五列 / 等高 / 换页 / 与设备管理同样的间距
// ---------------------------------------------------------------------------

describe('① 声相机「告警信息」：统一标题格 + 五列 + 等高 + 换页 + 间距与设备管理一致', () => {
  const table = slice(monitorView, '<table class="camera-alarm-table">', '</table>', '告警信息表')

  it('有统一标题格（thead），列顺序就是业主给的那五个，最后多一格详情入口', () => {
    const header = slice(table, '<thead>', '</thead>', '表头')
    const labels = [...header.matchAll(/t\('([^']+)'\)/g)].map((match) => match[1])
    assert.deepEqual(
      labels,
      [
        'alarmsUi.columnTime',
        'alarmsUi.columnSeverity',
        'alarmsUi.columnType',
        'cameraAlarmUi.columnIntensity',
        'cameraAlarmUi.columnMainFrequency',
        'alarmsUi.menuDetail'
      ],
      '告警表的列与业主给的（时间 / 告警等级 / 告警类型 / 声场强度 / 主频）不一致'
    )
    // 时间 / 等级 / 类型三列复用告警中心的列名：同一件事在软件里只能有一个词。
    for (const key of ['alarmsUi.columnTime', 'alarmsUi.columnSeverity', 'alarmsUi.columnType']) {
      assert.ok(table.includes(`t('${key}')`), `告警表没有复用 ${key}`)
    }
  })

  it('每一行都渲染那五格，缺值写「—」而不是 0', () => {
    const body = slice(table, '<tbody>', '</tbody>', '表体')
    assert.match(body, /v-for="alarm in pagedCameraAlarms"/, '表体没有按页渲染')
    assert.match(body, /formatDateTime\(alarm\.at\)/, '时间那一格没有格式化')
    assert.match(body, /linkageSeverityOf\(alarm\)/, '等级那一格没有分档')
    assert.match(body, /cameraAlarmTypeText\(alarm\)/, '类型那一格没有走统一取证')
    assert.match(body, /linkageIntensityText\(t, alarm\)/, '声场强度那一格没有走统一取值')
    assert.match(body, /linkageFrequencyText\(t, alarm\)/, '主频那一格没有走统一取值')
    // 缺失值一律 `—`：设备没报这个量不等于它是 0（仓库里最反对的那种假话）。
    assert.equal(
      /linkageIntensityText\(t, alarm\) \|\| '—'/.test(body),
      true,
      '声场强度缺值没有写 —'
    )
    assert.equal(/linkageFrequencyText\(t, alarm\) \|\| '—'/.test(body), true, '主频缺值没有写 —')
  })

  it('换页由「每页固定行数」算出来，页码在设备切换时归零', () => {
    assert.match(
      monitorView,
      /const CAMERA_ALARM_PAGE_SIZE = \d+/,
      '没有每页行数常量 —— 换页就没有唯一的判据'
    )
    const pages = block(monitorView, 'const cameraAlarmPages = computed', '总页数')
    assert.match(pages, /Math\.ceil\(cameraLinkageAlarms\.value\.length \/ CAMERA_ALARM_PAGE_SIZE\)/, '总页数不是按每页行数算的')
    const clamp = block(monitorView, 'watch(cameraAlarmPages', '页码夹回')
    assert.match(clamp, /cameraAlarmPage\.value = pages/, '页码没有夹回范围（会停在一个空页上）')
    const paged = block(monitorView, 'const pagedCameraAlarms = computed', '当页切片')
    assert.match(paged, /slice\(start, start \+ CAMERA_ALARM_PAGE_SIZE\)/, '当页不是切片出来的')
    assert.match(monitorView, /watch\(selectedDeviceId, \(\) => \{\s*cameraAlarmPage\.value = 1/, '换设备时页码没有归 1')
    // 换页控件带稳定钩子（探针与将来的回归都靠它）。
    for (const hook of ['data-camera-alarm-pager', 'data-camera-alarm-page', 'data-action="camera-alarm-prev"', 'data-action="camera-alarm-next"']) {
      assert.ok(monitorView.includes(hook), `换页控件缺稳定钩子 ${hook}`)
    }
    assert.match(monitorView, /v-if="cameraAlarmPages > 1"/, '只有一页时也渲染换页控件')
  })

  it('告警卡与左侧 PRPD 等高：网格是 stretch，不是 start', () => {
    const grid = block(monitorView, '.camera-realtime-grid {', '实时网格')
    assert.match(grid, /align-items: stretch/, '实时网格不是 stretch —— 告警卡不会与 PRPD 等高')
    assert.equal(/align-items: start/.test(grid), false, '实时网格仍是 start，等高那一半没生效')
    // 告警卡自己必须是可撑开的列容器，否则 stretch 到的高度里面填不满。
    const card = block(monitorView, '.camera-alarm-history-card {', '告警卡')
    assert.match(card, /display: flex/, '告警卡不是 flex 列 —— 撑开的高度里内容铺不满')
  })

  it('间距与设备管理一致：板子不再叠一层内边距，卡片间隙仍是 --space-4', () => {
    const board = block(monitorView, '.camera-board {', '相机板子')
    assert.equal(
      /padding:/.test(board),
      false,
      '相机板子又有自己的 padding —— 它会与 .app-content 的内边距叠加，比设备管理页多出一圈'
    )
    assert.match(board, /--camera-card-gap: var\(--space-4\)/, '卡片间隙不是 --space-4')
    assert.match(board, /gap: var\(--camera-card-gap\)/, '板子没有用统一的卡片间隙')
    // 设备管理那张表内部就是 .card 的 16px 内边距；两页这一档必须同源。
    const mainCss = read('src/renderer/src/assets/main.css')
    assert.match(mainCss, /\.card \{[\s\S]*?padding: var\(--space-4\)/, '.card 的内边距不再是 --space-4')
  })
})

// ---------------------------------------------------------------------------
// ② 「告警控制」那个数字与右上角告警图标同口径
// ---------------------------------------------------------------------------

describe('② 告警控制角标 = 未确认口径（与右上角告警图标一致）', () => {
  it('角标数是「未确认」条数，不是这台设备在待处理列表里的全部条数', () => {
    const count = block(monitorView, 'const cameraAlarmUnacknowledgedCount = computed', '未确认条数')
    assert.match(count, /filter\(\(alarm\) => !alarm\.acknowledged\)/, '角标没有过滤未确认')
    assert.match(
      count,
      /cameraLinkageAlarms\.value\.filter/,
      '角标没有从当前设备的告警里取（它必须还是"这台设备"的口径）'
    )
  })

  it('两处（相机控制卡片 + 告警信息标题右侧）都读同一个 computed', () => {
    const uses = monitorView.match(/:alarm-count="cameraAlarmUnacknowledgedCount"/g) ?? []
    assert.equal(uses.length, 1, '相机控制卡片没有读未确认角标')
    assert.match(
      monitorView,
      /data-camera-alarm-count>\{\{ cameraAlarmUnacknowledgedCount \}\}/,
      '告警信息标题右侧的数字没有读同一个 computed'
    )
    // 相机控制面板把钩子挂出来了（探针与回归都靠它认这一格）。
    assert.ok(cameraControl.includes('data-camera-alarm-count'), '相机控制面板的角标没有稳定钩子')
  })

  it('顶栏铃铛数的就是未确认（两处口径同源，才不会一个说 200 一个说 3）', () => {
    const panel = stripComments(read('src/renderer/src/components/AlarmLinkagePanel.vue'))
    assert.match(
      panel,
      /bellCount = computed\(\(\) => deviceAlarmTotal\.value \+ linkage\.unacknowledgedCount\)/,
      '铃铛角标不再是「设备未确认 + 联动未确认」'
    )
    assert.match(
      stripComments(read('src/renderer/src/stores/alarmLinkage.ts')),
      /unacknowledged = computed\(\(\) => pending\.value\.filter\(\(item\) => !item\.acknowledged\)\)/,
      '联动的 unacknowledged 不是按未确认过滤的'
    )
  })
})

// ---------------------------------------------------------------------------
// ③ 点一行 → 告警中心里这一条的详情
// ---------------------------------------------------------------------------

describe('③ 告警信息的行 → 告警中心那一条的详情', () => {
  it('跳转带 device 与 cameraAlarm 两个参数（并落到 /alarms）', () => {
    const fn = slice(monitorView, 'function openCameraAlarmDetail', '\n}', '跳转函数')
    assert.match(fn, /path: '\/alarms'/, '没有跳到告警中心')
    assert.match(fn, /device: alarm\.deviceId/, '没有带上设备筛选')
    assert.match(fn, /cameraAlarm: alarm\.eventId/, '没有带上那一条告警的身份')
  })

  it('告警中心认这个参数：先读权威快照，再按 eventId 打开；找不到就如实说', () => {
    const mounted = slice(alarmsView, 'const cameraAlarmId =', 'const alarmCenter =', '深链处理')
    assert.match(mounted, /await linkage\.load\(\)/, '没有先读一次权威快照（首次进这一页时列表还是空的）')
    assert.match(mounted, /openCameraAlarmById\(cameraAlarmId\)/, '没有按 eventId 打开')
    assert.match(mounted, /notice\.value = t\('alarmsUi\.cameraAlarmNotFound'\)/, '找不到那条告警时没有如实说明')
    const open = slice(alarmsView, 'function openCameraAlarmById', '\n}', '按 id 打开')
    assert.match(open, /linkage\.pending\.find/, '没有在待处理列表里找权威记录')
    assert.match(open, /if \(!found\) return false/, '找不到时没有返回 false（会编一条记录出来）')
  })

  it('详情面板里音频 / 视频 / 文件三样都还在', () => {
    const detail = slice(alarmsView, 'class="card alarm-detail"', 'alarm-detail__empty', '全宽详情')
    // 音频：带本机录音的告警走 RecordingPlayer（无本机录音的那一条有专门的说明与出口）。
    assert.ok(alarmsView.includes('RecordingPlayer'), '丢了音频回放（RecordingPlayer）')
    assert.ok(alarmsView.includes('goSyncRecordings'), '丢了"去同步录音"的出口')
    // 视频：MP4 容器与本机联动录像各一条路。
    assert.ok(detail.includes('t(\'alarmsUi.videoTitle\')'), '详情里没有视频那一节')
    assert.ok(detail.includes('cameraDetailVideoUrl'), '相机告警的视频没有接进来')
    // 文件：抓图图片 + 去事件中心拿完整检测文件。
    assert.ok(detail.includes('t(\'alarmsUi.snapshotsTitle\')'), '详情里没有抓图那一节')
    assert.ok(detail.includes('t(\'alarmsUi.viewInEventCenter\')'), '没有去事件中心拿完整文件的出口')
  })
})

// ---------------------------------------------------------------------------
// ④ 详情占全部宽度；右侧那个小详情页删掉
// ---------------------------------------------------------------------------

describe('④ 告警中心的详情占全部宽度，右侧小详情页删除', () => {
  it('工作区只有一列（详情不再挤在右半边）', () => {
    const workspace = block(alarmsView, '.alarm-workspace {', '工作区')
    assert.match(workspace, /grid-template-columns: minmax\(0, 1fr\)/, '工作区不是一列')
    assert.equal(
      /0\.95fr|1\.05fr/.test(workspace),
      false,
      '工作区还是原来那个左右两列（详情又回到右半边了）'
    )
  })

  it('最大的那个详情弹窗（640px）已经不存在', () => {
    assert.equal(alarmsView.includes('width="640px"'), false, '相机告警那个 640px 的小详情弹窗还在')
    assert.equal(
      /camera-alarm-detail__grid/.test(alarmsView),
      false,
      '旧的相机详情栅格还在（它是那个小弹窗的正文）'
    )
  })

  it('详情不再 sticky 在半屏里，而是随页自然排布', () => {
    const detail = block(alarmsView, '.alarm-detail {', '详情面板')
    assert.equal(/position: sticky/.test(detail), false, '详情仍然 sticky（横过来之后会卡在半屏）')
    assert.equal(
      /max-height: calc\(100vh/.test(detail),
      false,
      '详情仍然限高在 100vh 那一条（它是"右边一列"时代的做法）'
    )
  })
})

// ---------------------------------------------------------------------------
// ⑤ 点行看详情 + 告警中心里不让非告警提示再打扰
// ---------------------------------------------------------------------------

describe('⑤ 点行看详情；告警中心里非告警提示不再打扰', () => {
  it('两类行点开都给详情，而且是同一张全宽面板（不会两处同时说话）', () => {
    const open = slice(alarmsView, 'function openUnified', '\n}', '点行')
    assert.match(open, /if \(row\.kind === 'box' && row\.box\)/, '盒子行没有分支')
    assert.match(open, /openDetail\(row\.box\)/, '盒子行点开不给详情')
    assert.match(open, /if \(row\.camera\)/, '相机行没有分支')
    assert.match(open, /cameraDetail\.value = row\.camera/, '相机行点开不给详情')
    // 两条分支互斥：只留一份详情。
    assert.match(open, /cameraDetail\.value = null/, '打开盒子详情时没有清掉相机详情')
    assert.match(open, /detail\.value = null/, '打开相机详情时没有清掉盒子详情')
  })

  it('告警中心这一屏会说自己"正在看着"，判据只有一处', () => {
    assert.match(centerMode, /const quietForNotifications = computed\(\(\) => onScreen\.value\)/, '没有可读的判据')
    assert.match(centerMode, /export const ALARM_CENTER_PATH = '\/alarms'/, '没有导出告警中心路径')
    assert.match(alarmsView, /onMounted\(\(\) => alarmCenter\.enter\(\)\)/, '告警中心挂载时没有说自己正在看着')
    assert.match(alarmsView, /onUnmounted\(\(\) => alarmCenter\.leave\(\)\)/, '告警中心卸载时没有撤销')
    // shell 里只允许读这一处判据，不许自己再写一遍 `route.path === '/alarms'`。
    assert.match(shell, /alarmCenter\.quietForNotifications/, 'shell 没有读那个判据')
    assert.equal(
      /route\.path === '\/alarms'|'\/alarms' === route\.path/.test(shell),
      false,
      'shell 自己又写了一遍告警中心的路径判断（同一件事的第二份实现）'
    )
  })

  it('只挡"持续催办"：新告警到达响一次那一条还在', () => {
    const repeat = slice(shell, 'watch(\n  () => linkage.unacknowledgedCount', 'watch(\n  () => alarmCenter.onScreen', '催办监听')
    assert.match(repeat, /alarmCenter\.quietForNotifications/, '催办那一条没有读判据')
    assert.match(repeat, /clearInterval\(alarmSoundTimer\)/, '进入告警中心时没有把正在跑的催办停掉')
    // 新告警响一次那一条（`watch(() => linkage.pending`）必须原样保留。
    const fresh = slice(shell, '() => linkage.pending,', 'watch(\n  () => linkage.unacknowledgedCount', '新告警发声')
    assert.match(fresh, /playAlarmPopupSound/, '新告警到达不再发声了（那是告警本身的通知，不能挡）')
    assert.equal(
      /quietForNotifications/.test(fresh),
      false,
      '新告警那一条也被挡了 —— 告警中心里就再也听不到新告警了'
    )
  })
})

// ---------------------------------------------------------------------------
// 六种语言的文案
// ---------------------------------------------------------------------------

describe('第 50 轮新增文案：六种语言齐全、占位符一致', () => {
  const cameraKeys = [
    'columnIntensity',
    'columnMainFrequency',
    'pageStatus',
    'openAlarmDetail'
  ]
  const alarmKeys = [
    'cameraEvidenceLoading',
    'cameraEvidenceNoVideo',
    'cameraActionsTitle',
    'cameraAlarmNotFound'
  ]

  it('cameraAlarmUi 与 alarmsUi 的新键在六种语言里都有值', () => {
    for (const locale of LOCALES) {
      for (const key of cameraKeys) {
        const value = messageAt(locale, `cameraAlarmUi.${key}`)
        assert.equal(typeof value, 'string', `${locale} 缺 cameraAlarmUi.${key}`)
        assert.ok(String(value).trim() !== '', `${locale} 的 cameraAlarmUi.${key} 是空的`)
        assert.equal(String(value).includes('@'), false, `${locale} 的 cameraAlarmUi.${key} 含裸 @`)
      }
      for (const key of alarmKeys) {
        const value = messageAt(locale, `alarmsUi.${key}`)
        assert.equal(typeof value, 'string', `${locale} 缺 alarmsUi.${key}`)
        assert.ok(String(value).trim() !== '', `${locale} 的 alarmsUi.${key} 是空的`)
        assert.equal(String(value).includes('@'), false, `${locale} 的 alarmsUi.${key} 含裸 @`)
      }
    }
  })

  it('换页读数的占位符在六种语言里一致（多了少了一个都会渲染出 {pages}）', () => {
    const placeholdersOf = (value: unknown): string[] => [
      ...new Set(String(value).match(/\{(\w+)\}/g) ?? [])
    ].sort()
    const reference = placeholdersOf(messageAt('zh-CN', 'cameraAlarmUi.pageStatus'))
    assert.deepEqual(
      reference,
      ['{pages}', '{page}'],
      `中文的 pageStatus 占位符变了：${JSON.stringify(messageAt('zh-CN', 'cameraAlarmUi.pageStatus'))}`
    )
    for (const locale of LOCALES) {
      assert.deepEqual(
        placeholdersOf(messageAt(locale, `cameraAlarmUi.pageStatus`)),
        reference,
        `${locale} 的 pageStatus 占位符与中文不一致：${JSON.stringify(messageAt(locale, 'cameraAlarmUi.pageStatus'))}`
      )
    }
  })

  it('角标 tooltip 说明的是"未确认"，六种语言一致改口', () => {
    // 改了数字的口径就必须改说话的方式，否则 tooltip 还在说"当前/最近"。
    for (const locale of LOCALES) {
      const value = String(messageAt(locale, 'cameraControlUi.activeRecentAlarms'))
      assert.ok(value.includes('{count}'), `${locale} 的 activeRecentAlarms 丢掉了 {count}`)
    }
    assert.ok(
      String(messageAt('zh-CN', 'cameraControlUi.activeRecentAlarms')).includes('未确认'),
      '中文 tooltip 没有说"未确认"'
    )
  })
})
