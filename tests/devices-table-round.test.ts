/**
 * 这一批（设备管理表格 / 自动识别机型 / 点位 / 三种实时检测）的界面与目录回归守卫。
 *
 * WHY THIS FILE EXISTS
 * 这一批的六件事里，只有三件能在纯单测里证明（见 `device-installation.test.ts`：解析、落库、
 * 读回）。剩下的都长在**源码结构**上，而它们全都是"改错了不会报错"的那种：
 *   ② 添加设备里**不能再出现选机型** —— 留着那张机型卡，界面就仍然在让操作员做判断题；
 *   ③ 设备表的列清单与顺序是业主给的，多一列少一列都不会有单元失败；
 *   ④ 双击 IP 打开浏览器 —— 接成单击打开，是"想选设备却弹出浏览器"这种只有人点得出来的错；
 *   ⑤ 三种机型三支内容 —— 声呐误落回声纹那一支时会去开 `/features_stream`，一台健康设备
 *      显示成"监测起不来"（这与相机那一支当初的错误一模一样）；
 *   ⑥ 下拉的宽度与位置是量出来的（顶栏那一格的 50%、靠右、紧挨设备数量）。
 *
 * 几何与真实窗口里的行为由 `scripts/demo-shot-driver.cjs` 在真窗口里量（那是另一层，
 * 分工见 `page-layout.test.ts` 的文件头）；这里钉的是"下一手改动会不会把它悄悄改回去"。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { zhCN } from '../src/shared/i18n/messages/zh-CN'
import { en } from '../src/shared/i18n/messages/en'
import { es } from '../src/shared/i18n/messages/es'
import { tr } from '../src/shared/i18n/messages/tr'

const projectRoot = path.resolve(__dirname, '..', '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

/** 去掉注释：注释里会提到被删掉的东西（那是文档，不是渲染出来的内容）。 */
function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

/** 只留 SFC 的 `<template>` 块（"画在屏幕上"与"脚本里算过"是两件事）。 */
function templateBlock(source: string): string {
  const open = source.indexOf('<template>')
  const close = source.lastIndexOf('</template>')
  return open >= 0 && close > open ? source.slice(open, close) : ''
}

/** 取出一对标记之间的源码；找不到就失败（改名/删除必须报出来，不能静默通过）。 */
function between(source: string, open: string, close: string, label: string): string {
  const start = source.indexOf(open)
  assert.ok(start >= 0, `找不到 ${label} 的起点：${open}`)
  const end = source.indexOf(close, start + open.length)
  assert.ok(end > start, `找不到 ${label} 的终点：${close}`)
  return source.slice(start, end)
}

/** 取一个标记所在的整个 `<button …>…</button>`（属性顺序会变，所以从标记往前找 `<button`）。 */
function buttonAround(source: string, marker: string): string {
  const at = source.indexOf(marker)
  assert.ok(at > 0, `找不到 ${marker}`)
  const start = Math.max(0, source.lastIndexOf('<button', at))
  const end = source.indexOf('</button>', at)
  assert.ok(end > start, `${marker} 之后找不到 </button>`)
  return source.slice(start, end)
}

const CATALOGUES: Record<string, unknown> = { 'zh-CN': zhCN, en, es, tr }

function messageAt(locale: string, key: string): string | undefined {
  let cursor: unknown = CATALOGUES[locale]
  for (const part of key.split('.')) {
    if (!cursor || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return typeof cursor === 'string' ? cursor : undefined
}

const devicesView = read('src/renderer/src/views/DevicesView.vue')
const devicesViewTemplate = templateBlock(devicesView)
const devicesViewCode = stripComments(devicesViewTemplate)
const monitorView = read('src/renderer/src/views/MonitorView.vue')
const monitorViewTemplate = templateBlock(monitorView)
const monitorViewCode = stripComments(monitorViewTemplate)
const addDialog = read('src/renderer/src/components/AddDeviceDialog.vue')
const addDialogTemplate = templateBlock(addDialog)
const topbar = read('src/renderer/src/components/AppTopbar.vue')

// ---------------------------------------------------------------------------
// ③ 设备表：列清单与顺序
// ---------------------------------------------------------------------------

describe('设备表：一列一个事实，顺序按业主给的清单', () => {
  /*
   * 列清单由业主在 2026-09-18 第 8 条**重给**（上一版是 2026-09-17 的八列）：
   * 序号 / 设备名称 / IP地址 / 设备类型 / 状态 / 告警数量 / 通道数 / 查看 / 设置 / 删除。
   * 差别逐条：多了「序号」；「设备IP」→「IP地址」、「是否在线」→「状态」、
   * 「设备通道」→「通道数」；「配置」拆成「设置」与「删除」两个图标列。
   */
  it('表头正好是那十列，且顺序一致', () => {
    const head = between(devicesViewCode, '<thead>', '</thead>', '设备表表头')
    const keys = [...head.matchAll(/t\('([\w.]+)'\)/g)].map((match) => match[1])
    assert.deepEqual(keys, [
      'devicesUi.indexColumn',
      'devices.name',
      'devicesUi.ipColumn',
      'addDeviceUi.kindLabel',
      'devicesUi.onlineColumn',
      'devicesUi.alarmCountColumn',
      'devicesUi.channelColumn',
      'devicesUi.viewColumn',
      'devicesUi.settingColumn',
      'devicesUi.deleteColumn'
    ])
  })

  it('列名逐字是业主给的那十个（表头就是他写的字，不是别的页面的标签）', () => {
    const expected = [
      '序号',
      '设备名称',
      'IP地址',
      '设备类型',
      '状态',
      '告警数量',
      '通道数',
      '查看',
      '设置',
      '删除'
    ]
    const actual = [
      messageAt('zh-CN', 'devicesUi.indexColumn'),
      messageAt('zh-CN', 'devices.name'),
      messageAt('zh-CN', 'devicesUi.ipColumn'),
      messageAt('zh-CN', 'addDeviceUi.kindLabel'),
      messageAt('zh-CN', 'devicesUi.onlineColumn'),
      messageAt('zh-CN', 'devicesUi.alarmCountColumn'),
      messageAt('zh-CN', 'devicesUi.channelColumn'),
      messageAt('zh-CN', 'devicesUi.viewColumn'),
      messageAt('zh-CN', 'devicesUi.settingColumn'),
      messageAt('zh-CN', 'devicesUi.deleteColumn')
    ]
    assert.deepEqual(actual, expected)
  })

  it('每一列在四本目录里都有译文，且「设备类型」不写成「机型」那一套', () => {
    for (const key of [
      'devicesUi.viewColumn',
      'devicesUi.settingColumn',
      'devicesUi.deleteColumn',
      'devicesUi.indexColumn',
      'devicesUi.onlineColumn'
    ]) {
      for (const locale of Object.keys(CATALOGUES)) {
        const message = messageAt(locale, key)
        assert.ok(message && message.length > 0, `${locale} 缺 ${key}`)
      }
    }
    // 列名用的是「设备类型」（添加对话框里的那一条），不是"机型卡"时代的说法。
    assert.equal(messageAt('zh-CN', 'addDeviceUi.kindLabel'), '设备类型')
  })

  it('扁平化（第 2b 条）：这一页不用卡片外壳，只有线与表', () => {
    /*
     * 业主 2026-09-18 第 2b 条：「设备管理这个界面里面的内容，不要做成卡片的，而是做成
     * 扁平化设计，用线条分区」。`.table-wrap` 是**全应用共用**的卡片外壳（告警/事件中心/
     * 录音/样本库都靠它），所以这一页改成自己的 `.devices-table-flat`（上边线 + 行分隔线）。
     */
    assert.ok(
      devicesViewCode.includes('class="devices-table-flat"'),
      '设备表外壳不是扁平化的 .devices-table-flat'
    )
    assert.equal(
      devicesViewCode.includes('table-wrap'),
      false,
      '这一页又用回了卡片外壳（.table-wrap）'
    )
    // 扁平外壳必须靠线分区：至少有一条上边线与一条下边线。
    assert.match(
      devicesView,
      /\.devices-table-flat\s*\{[^}]*border-top:\s*1px solid/,
      '扁平外壳没有上边线'
    )
    assert.match(
      devicesView,
      /\.devices-table-flat\s*\{[^}]*border-bottom:\s*1px solid/,
      '扁平外壳没有下边线'
    )
    assert.ok(devicesViewCode.includes('class="table devices-table"'), '表格没有用全局 .table')
    // 卡片版式（上一版的 `device-card*` / `fact__*`）必须连同样式一起删干净。
    assert.equal(devicesView.includes('device-card'), false, '卡片版式的类名还在 DevicesView 里')
    assert.equal(/\.fact(__|\s*\{)/.test(devicesView), false, '卡片版式的 `.fact*` 样式还在')
    // 行要有可点的手感（全局 `.table tbody tr.is-clickable`）。
    assert.ok(devicesViewCode.includes("'is-clickable'"), '可点击的行没有挂 is-clickable')
  })

  it('数字列右对齐、图标列不参与分配宽度（否则图标会被甩到很右边）', () => {
    assert.ok(/\.devices-table \.devices-table__num\s*\{[^}]*text-align: right/.test(devicesView))
    assert.ok(/\.devices-table \.devices-table__actions\s*\{[^}]*width: 1%/.test(devicesView))
  })

  it('序号列是行号（第 1 行是 1），不是设备自己的什么编号', () => {
    assert.match(
      devicesViewCode,
      /v-for="\(device, index\) in cards"[\s\S]{0,400}?\{\{ index \+ 1 \}\}/,
      '序号列不是行号'
    )
  })
})

// ---------------------------------------------------------------------------
// ③④ 查看 / 设置 / 删除三个图标 + 双击 IP
// ---------------------------------------------------------------------------

describe('设备表：查看 / 设置 / 删除是图标，IP 双击开设备页面', () => {
  it('「查看」「设置」「删除」各是一个图标按钮，并带探针可认的标记', () => {
    const monitorButton = buttonAround(devicesViewCode, 'data-action="device-monitor"')
    assert.ok(monitorButton.includes('<svg'), '查看按钮里没有图标')
    assert.ok(monitorButton.includes("t('devicesUi.viewColumn')"), '查看按钮没有无障碍名字')

    const settingButton = buttonAround(devicesViewCode, 'data-action="device-configure"')
    assert.ok(settingButton.includes('<svg'), '设置按钮里没有图标')
    assert.ok(settingButton.includes("t('devicesUi.settingColumn')"), '设置按钮没有无障碍名字')

    const deleteButton = buttonAround(devicesViewCode, 'data-action="device-delete"')
    assert.ok(deleteButton.includes('<svg'), '删除按钮里没有图标')
    assert.ok(deleteButton.includes("t('devicesUi.deleteColumn')"), '删除按钮没有无障碍名字')
    // 两个破坏性/管理动作只对管理员出现（与后端 `requireAdministrator` 一致）。
    assert.match(deleteButton, /v-if="session\.isAdmin"/, '删除按钮没有按管理员收口')
    // 省略号菜单按第 8 条删掉了（编辑与删除升成两列，一个入口胜过两个）。
    assert.equal(devicesViewCode.includes('menu__list'), false, '行末的省略号菜单又回来了')
  })

  it('查看带设备 id 去实时检测页，设置打开编辑对话框，点名字进详情页', () => {
    // 查看 = 按机型进实时检测：带上 device 查询串（页面自己按 kind 分支）。
    assert.ok(
      /function monitor\([\s\S]{0,400}?router\.push\(\{ path: '\/monitor', query: \{ device: device\.id \} \}\)/.test(
        stripComments(devicesView)
      ),
      '查看不再带设备 id 去 /monitor'
    )
    // 设置 = 编辑对话框（业主第 10 条那一个）。
    assert.match(
      buttonAround(devicesViewCode, 'data-action="device-configure"'),
      /@click\.stop="startEdit\(device\)"/,
      '设置按钮不再打开编辑对话框'
    )
    // 名字是去详情/配置页的入口（列清单里没有"详情"这一列，而那个页面装着通道配置等）。
    const nameButton = buttonAround(devicesViewCode, 'data-action="device-detail"')
    assert.ok(nameButton.includes('go(`/devices/${device.id}`)'), '点名字不再进设备详情页')
  })

  it('行点击只选中（不跳走），这样双击 IP 才落得到那一格上', () => {
    // 双击的前半段是两次单击；单击这一行如果会导航，双击永远不会到达 IP 那一格。
    assert.ok(devicesViewCode.includes('@click="selectRow(device)"'), '行点击不再走本页的选中逻辑')
    assert.equal(
      devicesViewCode.includes('@click="selectDevice(device.id)"'),
      false,
      '行点击又在导航 —— 双击 IP 会先被第一次单击带走'
    )
    const rowHandler = between(
      stripComments(devicesView),
      'function selectRow(',
      '\n}',
      'selectRow()'
    )
    assert.equal(/router\.push/.test(rowHandler), false, 'selectRow 仍然会跳转')
    assert.ok(rowHandler.includes('devices.select('), 'selectRow 没有把当前设备切过去')
  })

  it('IP 那一格是**双击**打开，单击只阻止冒泡（单击 = 选中这一行）', () => {
    const ipButton = between(devicesViewCode, 'class="devices-table__ip mono"', '</button>', 'IP 按钮')
    assert.ok(ipButton.includes('@dblclick.stop="openWebUi(device)"'), 'IP 没有绑定双击打开')
    assert.equal(
      /@click(\.stop)?="openWebUi/.test(ipButton),
      false,
      '单击也会打开设备页面 —— 想选中这一行的人会弹出一个浏览器窗口'
    )
    assert.ok(/@click\.stop="ignoreClick"/.test(ipButton), '单击没有阻止冒泡（点 IP 会顺带选中行）')
    // 键盘也要能激活（读屏/纯键盘用户不会少一条路）。
    assert.ok(ipButton.includes('@keydown.enter'), 'IP 按钮键盘不可达')
  })

  it('打开设备页面走 store（主进程校验地址），不是渲染层自己开窗口', () => {
    assert.ok(
      devicesView.includes('devices.openWebUi(device.id)'),
      '打开设备页面没有走 store 的那条路'
    )
  })
})

// ---------------------------------------------------------------------------
// ⑤ 三种机型三支内容
// ---------------------------------------------------------------------------

describe('实时检测页：三种机型三支内容', () => {
  it('三个判据都在 computed 里，且不再用 `!isCamera` 当声纹那一支', () => {
    for (const name of ['isCamera', 'isSonar', 'isVoiceprint']) {
      assert.ok(
        new RegExp(`const ${name} = computed\\(`).test(monitorView),
        `${name} 不是一个 computed 判据`
      )
    }
    // `!isCamera` 是两族时代的写法：声呐会被它顺手划进声纹那一支（本轮修的就是这个）。
    assert.equal(
      monitorViewTemplate.includes('!isCamera'),
      false,
      '模板里还有 `!isCamera` —— 声呐会被划进声纹那一支'
    )
  })

  it('声呐支路：内容来自三块既有实现，那一句"实时流未接入"已经删掉', () => {
    /*
     * 顶栏状态行里也有一个 `v-else-if="isSonar"`（机型徽标），所以取**最后**那一个 ——
     * 页面正文里那一支才是"这一屏显示什么"。
     *
     * 业主 2026-09-18 第 19 条把那句说明删掉了（它原来在页面顶上，也挂在机型徽标的
     * 悬停提示里）：设备在不在线由设备下拉旁边的绿点/灰点回答。所以这一条现在反过来钉：
     * **那句话不许回来**，三块既有实现照旧。
     */
    const marker = '<template v-else-if="isSonar">'
    const start = monitorViewCode.lastIndexOf(marker)
    assert.ok(start > 0, '找不到声呐支路')
    const end = monitorViewCode.indexOf('</template>', start)
    const sonar = monitorViewCode.slice(start, end)
    assert.equal(
      sonar.includes('data-sonar-live-unwired'),
      false,
      '那一句"实时流未接入"又回来了（业主第 19 条要求删掉）'
    )
    assert.equal(
      sonar.includes('sonarLiveUnwired'),
      false,
      '声呐支路又引用了那条已删除的词条'
    )
    assert.ok(sonar.includes('DeviceInstallationCard'), '声呐支路没有地址信息卡片')
    assert.ok(sonar.includes('AuscultationPanel'), '声呐支路没有参数与告警同步面板')
    assert.ok(sonar.includes('MonitorRecordingTimeline'), '声呐支路没有本机录音时间轴')
    // 声呐这一支**不许**出现实时图（没有数据来源的图就是假的）。
    assert.equal(sonar.includes('<EChart'), false, '声呐支路里出现了实时图')
    assert.equal(sonar.includes('AudioLevelMeter'), false, '声呐支路里出现了音量表')
  })

  it('声呐**不会**被开一条实时监测会话（会去开不存在的 /features_stream）', () => {
    const mounted = between(monitorView, 'onMounted(async () => {', '\n})', 'onMounted')
    assert.ok(
      /else if \(isVoiceprint\.value\) \{\s*await startSession\(\)/.test(mounted),
      'onMounted 里会话的启动条件不再是"声纹设备"'
    )
    assert.equal(
      /else await startSession\(\)/.test(mounted),
      false,
      'onMounted 又变成"不是相机就开会话"'
    )
    const watcher = between(monitorView, 'watch(selectedDeviceId, async (id)', '\n})', '设备切换 watch')
    assert.ok(watcher.includes('} else if (isSonar.value) {'), '切换设备时没有声呐那一支')
    const sonarBranch = watcher.slice(watcher.indexOf('} else if (isSonar.value) {'))
    assert.ok(sonarBranch.includes('monitor.stop()'), '切到声呐时没有停掉上一台的会话')
    assert.ok(sonarBranch.includes('stopBoxAudio()'), '切到声呐时没有停掉上一台的预览声音')
  })

  it('采样率只在声纹设备那**一支**上读（相机与声呐没有那个端点）', () => {
    assert.ok(
      monitorView.includes('loadSampleRateIfVoiceprint'),
      '采样率又变成对所有机型都读 —— 对声呐读会得到一次必然失败的请求'
    )
    assert.equal(
      /await loadSampleRate\(selectedDeviceId\.value\)/.test(monitorView),
      false,
      '挂载时又无条件读采样率了'
    )
  })

  it('机型徽标仍在四本目录里；那条已删的说明不许回来', () => {
    for (const locale of Object.keys(CATALOGUES)) {
      const message = messageAt(locale, 'monitorUi.sonarFamilyBadge')
      assert.ok(message && message.length > 0, `${locale} 缺 monitorUi.sonarFamilyBadge`)
    }
    /*
     * `monitorUi.sonarLiveUnwired` 按业主 2026-09-18 第 19 条删掉了（四个目录一起删）：
     * 设备在不在线由设备下拉旁边的绿点/灰点回答，不再用一句话解释"这一屏为什么没有实时图"。
     * 这一条钉住"删干净了" —— 只要有一本目录还留着它，界面在某一种语言下就会多出那句话。
     */
    for (const locale of Object.keys(CATALOGUES)) {
      assert.equal(
        messageAt(locale, 'monitorUi.sonarLiveUnwired'),
        undefined,
        `${locale} 还留着已删除的 monitorUi.sonarLiveUnwired`
      )
    }
  })
})

// ---------------------------------------------------------------------------
// ⑥ 顶栏设备下拉：宽度 50%、靠右、紧挨设备数量
// ---------------------------------------------------------------------------

describe('实时检测页：顶栏的设备下拉', () => {
  it('下拉被投进顶栏那一格（页面不自己画一条标题栏）', () => {
    assert.ok(
      monitorViewTemplate.includes('<Teleport to="#topbar-page-slot">'),
      '设备下拉不再投到顶栏'
    )
    assert.ok(topbar.includes('id="topbar-page-slot"'), '顶栏没有那一格了')
  })

  it('宽度是那一格的 50%，并且靠右', () => {
    const rule = between(monitorView, '.topbar-device {', '}', '.topbar-device')
    assert.ok(/width:\s*50%/.test(rule), '下拉宽度不是 50%')
    assert.ok(/margin-left:\s*auto/.test(rule), '下拉没有靠右（没有紧挨右侧的设备数量）')
  })

  it('它右边紧挨着的就是「设备数量」那个指示器（DOM 顺序：那一格在 indicators 之前）', () => {
    const slot = topbar.indexOf('id="topbar-page-slot"')
    const indicators = topbar.indexOf('class="indicators"')
    assert.ok(slot > 0 && indicators > slot, '顶栏里那一格不再位于指示器之前')
    // 第一个指示器是设备总数（「设备数量」）。
    const firstIndicator = between(topbar, 'class="indicators"', '</div>', '指示器组')
    assert.ok(
      firstIndicator.includes("t('widgetsUi.indicatorDevices')"),
      '第一个指示器不再是设备总数'
    )
  })
})

// ---------------------------------------------------------------------------
// ② 添加设备：没有机型选择
// ---------------------------------------------------------------------------

describe('添加设备：机型由协议自动识别，不在界面上让人选', () => {
  it('模板里没有任何机型选择控件', () => {
    for (const forbidden of ['kind__radio', 'kind-option', 'name="kind"']) {
      assert.equal(
        addDialogTemplate.includes(forbidden),
        false,
        `添加设备对话框里还有机型选择控件：${forbidden}`
      )
    }
  })

  it('探活与添加都**不带** kind（由主进程按地址自动匹配协议）', () => {
    const probeCall = between(addDialog, 'await devices.probe({', '})', 'devices.probe 调用')
    assert.equal(/kind:/.test(probeCall), false, '探活时仍然把机型传下去了')
    const addCall = between(addDialog, 'await devices.add({', '})', 'devices.add 调用')
    assert.equal(/kind:/.test(addCall), false, '添加时仍然把机型传下去了')
  })

  it('识别出来的机型**要说出来**（不让人选，就必须让人看见结果）', () => {
    assert.ok(addDialogTemplate.includes('data-probe-kind'), '探活结果里没有机型那一行')
    assert.ok(
      addDialogTemplate.includes("t('addDeviceUi.detectedKind'"),
      '识别结果没有用 detectedKind 那句话'
    )
  })
})

// ---------------------------------------------------------------------------
// ① 添加/编辑里的地址信息输入（业主 2026-09-18 第 7 / 10 条：改名并删掉基准声压级）
// ---------------------------------------------------------------------------

describe('地址信息：两个录入入口都用同一套判据', () => {
  it('添加设备对话框有三个输入框（经纬度 + 方位角），用共享的 parseInstallation 校验', () => {
    for (const field of ['gisLatitude', 'gisLongitude', 'azimuthDeg']) {
      assert.ok(
        addDialogTemplate.includes(`form.installation.${field}`),
        `添加设备对话框缺 ${field} 输入`
      )
    }
    // 基准声压级按第 10 条删掉了：界面上一个输入框都不该再有它。
    assert.equal(
      addDialogTemplate.includes('soundLevelDb'),
      false,
      '添加设备对话框又出现了基准声压级输入'
    )
    assert.ok(addDialog.includes('parseInstallation('), '添加设备没有用共享的解析与范围校验')
  })

  it('设备管理页的「编辑」对话框也能改这三项（否则打错一个数字只能删掉重加）', () => {
    for (const field of ['gisLatitude', 'gisLongitude', 'azimuthDeg']) {
      assert.ok(
        devicesViewTemplate.includes(`editForm.installation.${field}`),
        `编辑对话框缺 ${field} 输入`
      )
    }
    assert.equal(
      devicesViewTemplate.includes('soundLevelDb'),
      false,
      '编辑对话框又出现了基准声压级输入'
    )
    assert.ok(devicesView.includes('parseInstallation('), '编辑对话框没有用共享的解析与范围校验')
    // 清空一个框 = 把库里那一项清掉（不是留旧值、也不是写 0）。
    assert.ok(
      /azimuthDeg: parsed\.installation\.azimuthDeg \?\? null/.test(devicesView),
      '清空一项时没有送 null（那会把"清空"变成"不动"）'
    )
  })

  it('设备详情页有同一张只读卡片（两页共用组件，不可能显示成两个样子）', () => {
    const detail = read('src/renderer/src/views/DeviceDetailView.vue')
    assert.ok(detail.includes('<DeviceInstallationCard'), '设备详情页没有安装点位卡片')
    assert.ok(monitorViewTemplate.includes('<DeviceInstallationCard'), '实时检测页没有安装点位卡片')
  })

  it('只读卡片把"没填"说成「未录入」，不画成 0', () => {
    const card = read('src/renderer/src/components/DeviceInstallationCard.vue')
    assert.ok(card.includes("t('installUi.unset')"), '卡片没有用「未录入」那一句')
    assert.ok(card.includes("t('installUi.halfPoint')"), '卡片没有说"只录了一半"')
    for (const locale of Object.keys(CATALOGUES)) {
      for (const key of ['installUi.unset', 'installUi.halfPoint']) {
        assert.ok(messageAt(locale, key), `${locale} 缺 ${key}`)
      }
    }
  })
})
