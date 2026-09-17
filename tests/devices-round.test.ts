/**
 * 这一轮（设备管理 · 拓扑树）的界面与目录回归测试。
 *
 * WHY THIS FILE EXISTS
 * 这一轮改的四件事里，有三件**只有在源码结构上才能提前拦住回归**，另外一件只能靠一次
 * 真实窗口的测量：
 *   1. 删掉的两句文案（「设备拓扑」标题与「共 N 台设备，在线 N 台」）随时可能被下一次
 *      改动带回来 —— 它们是两块内容唯一的身份说明，删掉之后没有任何「单元」会失败；
 *   2. 删掉的**目录键**必须是真的删掉：留着一条没人用的 `deviceTreeUi.title`，下一个人
 *      很容易再把它画回屏幕上（这条规则与 `page-layout.test.ts` 钉 `--content-max-width`
 *      是同一条：删掉的东西才会被遵守）；
 *   3. 右键菜单的三个落点（设备=本地+设备、相机=只有本地、通道=设备）必须由**目录里的
 *      句子**分得清，否则界面会让操作员以为相机的名字也被改了 —— 这一轮最不能出的错；
 *   4. 树的左/上间距与四档窗口尺寸下的几何，`scripts/demo-shot-driver.cjs` 在真实
 *      Electron 窗口里量（那一次运行才会真的改窗口大小）。这一层与那一层的分工写在
 *      `page-layout.test.ts` 的文件头里，这里沿用。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import type { CameraNvrMenuItem } from '../src/shared/domain/camera-nvr'
import { zhCN } from '../src/shared/i18n/messages/zh-CN'
import { en } from '../src/shared/i18n/messages/en'
import { es } from '../src/shared/i18n/messages/es'
import { tr } from '../src/shared/i18n/messages/tr'

const projectRoot = path.resolve(__dirname, '..', '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

/** 去掉 HTML 注释：注释里会提到被删掉的文案（那是文档，不是渲染出来的内容）。 */
function stripHtmlComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '')
}

/**
 * 只留一个 SFC 的 `<template>` 块。
 *
 * 「模板里渲染了什么」与「脚本里算过什么」是两件事：`devices.devices.length` 在脚本里
 * 是筛选框的显示阈值（那是逻辑），只有出现在模板里才是「把设备总数画在屏幕上」。
 */
function templateBlock(source: string): string {
  const open = source.indexOf('<template>')
  const close = source.lastIndexOf('</template>')
  return open >= 0 && close > open ? source.slice(open, close) : ''
}

/**
 * 取出一段源码里的**代码**（`/* *​/`、`//` 与 `<!-- -->` 注释全部去掉）。
 *
 * 这个仓库的解释性注释是中文散文，里面会提到被删掉的东西、也会提到纯函数的名字
 * （`VideoContextMenu.vue` 的文件头与模板里都写着「由 `buildCameraNvrMenu()` 决定」）。
 * 把注释当成代码来断言，会把一句正确的文档判成违规 —— 那不是回归，那是测试写错了。
 */
function stripComments(source: string): string {
  return stripHtmlComments(source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !(trimmed.startsWith('//') || trimmed.startsWith('*'))
    })
    .join('\n')
}

const CATALOGUES: Record<string, unknown> = {
  'zh-CN': zhCN,
  en,
  es,
  tr
}

/** 取一条 `a.b.c` 目录键；不存在时返回 `undefined`。 */
function messageAt(locale: string, key: string): string | undefined {
  const source = CATALOGUES[locale]
  let cursor: unknown = source
  for (const part of key.split('.')) {
    if (!cursor || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return typeof cursor === 'string' ? cursor : undefined
}

/** 一条消息里的命名占位符，排序后返回（与 `i18n.test.ts` 同一套判定）。 */
function placeholders(message: string): string[] {
  return [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string).sort()
}

// ---------------------------------------------------------------------------
// 被删掉的两句文案
// ---------------------------------------------------------------------------

describe('设备管理页：删掉「设备拓扑」标题与设备总数那一行', () => {
  it('树的组件不再渲染任何可见标题', () => {
    const tree = stripHtmlComments(read('src/renderer/src/components/DeviceTree.vue'))
    // `.device-tree__title` 这一条规则/元素是被删掉的标题本身；留着它就会有第二处
    // 画标题的地方。
    assert.equal(
      /device-tree__title/.test(tree),
      false,
      'DeviceTree.vue 又出现了标题（`.device-tree__title`）'
    )
    assert.equal(
      /<h[1-6][^>]*>\s*\{\{/.test(tree),
      false,
      'DeviceTree.vue 又渲染了一个带插值的标题元素'
    )
  })

  it('根行不再渲染设备总数（那一行是「共 N 台设备」的唯一落点）', () => {
    const template = stripHtmlComments(templateBlock(read('src/renderer/src/components/DeviceTree.vue')))
    // 根行里那个数字曾经是「共 N 台设备」唯一的落点。设备总数在模板里还可以出现在一个
    // 地方 —— 筛选框要不要画（`devices.devices.length > FILTER_THRESHOLD`）—— 那是
    // 布局判断，不是画在屏幕上的数字，所以判的是「有没有把它**插值**出来」。
    assert.equal(
      /\{\{[^}]*devices\.devices\.length[^}]*\}\}/.test(template),
      false,
      '设备树的模板里又插值渲染了设备总数'
    )
    // `.device-tree__meta` 是根行那个数字与设备行那个家族名共用的样式：根行不再有
    // 数字之后，这个类只能出现在设备行上（家族名）。
    const metaCount = (template.match(/device-tree__meta/g) ?? []).length
    assert.equal(metaCount, 1, `模板里 .device-tree__meta 出现 ${metaCount} 次，应为 1（只有设备行的家族名）`)
  })

  it('设备管理页不再渲染设备/在线计数那一行', () => {
    const view = stripHtmlComments(read('src/renderer/src/views/DevicesView.vue'))
    assert.equal(/devicesUi\.count/.test(view), false, '设备管理页又渲染了 devicesUi.count')
    assert.equal(
      /page-subtitle/.test(view),
      false,
      '设备管理页又出现了 `.page-subtitle`（被删掉的那一行就是它）'
    )
    // 副标题那一行仍然不许回来。页面标题与「添加设备」按钮**已经搬走**（见下一条），
    // 所以这一条现在只断言"被删掉的那一行没有回来"。
    assert.equal(/devicesUi\.count/.test(view), false, '设备管理页又渲染了 devicesUi.count')
    assert.equal(
      /page-subtitle/.test(view),
      false,
      '设备管理页又出现了 `.page-subtitle`（被删掉的那一行就是它）'
    )
  })

  /**
   * 页面标题与新增入口的第二轮搬迁（业主 2026-09-16）。
   *
   * 两件事必须同时成立，否则就是"搬了一半"：
   *   1. 设备管理页**不再**有页面标题，也不再自己画「添加设备」——外层框架的标题栏已经
   *      写了「设备管理」，而新增入口属于左侧拓扑树那一栏（参考 ThingsBoard）；
   *   2. 入口确实到了树里，而且设备管理页真的把它接上了（树只 emit，不自己弹对话框）。
   */
  it('设备管理页没有页面标题，也不再自己画新增入口', () => {
    const view = stripHtmlComments(read('src/renderer/src/views/DevicesView.vue'))
    assert.equal(/page-title/.test(view), false, '设备管理页又出现了 `.page-title`')
    assert.equal(
      /devicesUi\.addButton/.test(view),
      false,
      '设备管理页又自己画了「添加设备」按钮（它已经搬进拓扑树）'
    )
  })

  it('新增入口在拓扑树里，并且设备管理页把它接上了', () => {
    const tree = stripHtmlComments(read('src/renderer/src/components/DeviceTree.vue'))
    assert.ok(tree.includes("t('devicesUi.addButton')"), '拓扑树里缺少「添加设备」入口')
    assert.ok(/\(event: 'add'\)/.test(tree), '拓扑树必须 emit add（树不自己弹对话框）')
    assert.ok(
      /:can-add-device="session\.isAdmin"/.test(read('src/renderer/src/views/DevicesView.vue')),
      '设备管理页必须把自己那句「是不是管理员」的判断传给树'
    )
  })

  it('两个被删掉的目录键在所有四本目录里都不存在了', () => {
    for (const locale of Object.keys(CATALOGUES)) {
      assert.equal(
        messageAt(locale, 'deviceTreeUi.title'),
        undefined,
        `${locale} 里仍然存在已删除的 deviceTreeUi.title`
      )
      assert.equal(
        messageAt(locale, 'devicesUi.count'),
        undefined,
        `${locale} 里仍然存在已删除的 devicesUi.count`
      )
    }
  })

  it('整个渲染层里没有任何地方再引用这两个键', () => {
    const renderer = path.join(projectRoot, 'src', 'renderer', 'src')
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(vue|ts)$/.test(entry.name)) files.push(full)
      }
    }
    walk(renderer)
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8')
      for (const key of ['deviceTreeUi.title', 'devicesUi.count']) {
        assert.equal(
          source.includes(key),
          false,
          `${path.relative(projectRoot, file)} 仍然引用已删除的 ${key}`
        )
      }
    }
  })

  it('树仍然有一个无障碍名字（删的是屏幕上的标题，不是这块内容的身份）', () => {
    const tree = read('src/renderer/src/components/DeviceTree.vue')
    const labels = [...tree.matchAll(/:aria-label="([^"]+)"/g)]
      .map((match) => match[1] ?? '')
      .filter((label) => label !== '')
    assert.ok(labels.length >= 2, `树上没有 aria-label：${JSON.stringify(labels)}`)
    // 名字必须由目录给出：要么直接 `t('...')`，要么交给脚本里只做「拼目录文字」的
    // 辅助函数（`channelAria` 就是这一种）。硬编码的界面文字在这里被拦住。
    for (const label of labels) {
      const residue = label
        .replace(/t\('[\w.]+'\)/g, '')
        .replace(/^[\w.$![\]]+\s*\?\s*/, '')
        .replace(/^[a-zA-Z_$][\w$]*\([\w.$()]*\)$/, '')
        .replace(/[\s?:()]/g, '')
      assert.equal(residue, '', `aria-label 不是目录键，也不是只拼目录文字的辅助函数：${label}`)
    }
  })
})

// ---------------------------------------------------------------------------
// 右键菜单与重命名
// ---------------------------------------------------------------------------

describe('拓扑树的右键菜单', () => {
  const tree = stripHtmlComments(read('src/renderer/src/components/DeviceTree.vue'))
  const view = stripHtmlComments(read('src/renderer/src/views/DevicesView.vue'))

  it('右键是真的接上了（`contextmenu` 处理器，且行上阻止了系统菜单）', () => {
    assert.ok(
      tree.includes('@contextmenu.prevent="openContextMenu($event, row.node)"'),
      '树行没有绑定 contextmenu 处理器'
    )
  })

  it('设备行给「修改设备名称」，通道行给「修改通道名称」', () => {
    assert.ok(tree.includes("labelKey: 'deviceTreeUi.renameDevice'"), '菜单里没有设备重命名项')
    assert.ok(tree.includes("labelKey: 'deviceTreeUi.renameChannel'"), '菜单里没有通道重命名项')
    // 通道项必须先确认这一行真的是通道（有 channelIndex）：相机的流叶子不是通道，
    // 给不存在的通道改名是本轮最不该造出来的东西。
    assert.ok(
      /row\.node\.kind === 'channel' && row\.node\.channelIndex !== undefined/.test(tree),
      '通道重命名项没有按「真实通道行」过滤'
    )
  })

  it('设备重命名对两种设备都存在（相机的落点不同，但菜单项本身不能缺）', () => {
    // 设备分支里只有一项，且 `visible` / `enabled` 都是常量 true —— 没有按 kind
    // 把相机那一项藏起来：相机**可以**改名字，只是改的是本机数据库。
    const deviceBranch = tree.slice(
      tree.indexOf("if (row.node.kind === 'device')"),
      tree.indexOf("if (row.node.kind === 'channel' && row.node.channelIndex !== undefined)")
    )
    assert.ok(deviceBranch.includes('TREE_MENU_RENAME_DEVICE'), '设备分支里没有重命名动作')
    assert.ok(deviceBranch.includes('visible: true'), '设备重命名项被标成了不可见')
    assert.ok(deviceBranch.includes('enabled: true'), '设备重命名项被标成了禁用')
    assert.equal(
      /acousticCamera/.test(deviceBranch),
      false,
      '设备重命名项不该按设备家族分叉（落点不同由对话框与目录说明）'
    )
  })

  it('菜单复用视频画面的浮层组件，没有第二份定位/键盘实现', () => {
    assert.ok(tree.includes('VideoContextMenu'), '设备树没有复用 VideoContextMenu')
    // 组件里出现过的浮层 class 只能来自那个组件：树自己再画一个 `.vmenu` 就是漂移。
    assert.equal(/class="vmenu/.test(tree), false, '设备树自己画了一套菜单浮层')
  })

  it('菜单选中的动作翻译成对外的两个事件，并带上设备/通道身份', () => {
    assert.ok(tree.includes("emit('rename-device', row.node.deviceId)"), '没有派发 rename-device')
    assert.ok(
      tree.includes("emit('rename-channel', row.node.deviceId, row.node.channelIndex)"),
      '没有派发带通道号的 rename-channel'
    )
  })

  it('设备管理页把两个事件接到对话框上，并且真的写出去', () => {
    assert.ok(view.includes('<DeviceRenameDialog'), '设备管理页没有重命名对话框')
    assert.ok(view.includes('@rename-device="onRenameDevice"'), 'rename-device 没有接线')
    assert.ok(view.includes('@rename-channel="onRenameChannel"'), 'rename-channel 没有接线')
    // 三种落点各自的那一次调用必须都在源码里。
    // 本地那一次是 `devices.update({ id: device.id, name })`（多行写法，按两个字段判）。
    assert.ok(
      /devices\.update\(\{[\s\S]{0,80}id:\s*device\.id[\s\S]{0,40}name\s*\}\)/.test(view),
      '设备名没有写本地数据库'
    )
    assert.ok(
      view.includes('window.api.config.setDeviceName(device.id, name)'),
      '声纹设备的设备名没有写到设备上'
    )
    assert.ok(
      /window\.api\.config\.updateChannel\(target\.deviceId, target\.channelIndex, \{ name \}\)/.test(view),
      '通道名没有写到设备上'
    )
    // 写入之后必须把本机那份通道表读回来，否则树继续显示旧名字。
    assert.ok(
      view.includes('await devices.loadChannels(target.deviceId, true)'),
      '通道改名之后没有重新读取通道表'
    )
  })

  it('「只有本机改名」这件事由 kind 判定，不按名字或地址猜', () => {
    // 声纹设备才会走设备侧写入；其余（相机）只有本地那一次。
    assert.ok(
      /if \(device\.kind === 'acousticBox'\)/.test(view),
      '设备侧写入没有按 kind === acousticBox 把关'
    )
    assert.equal(
      /name\.includes\(|\.ip\s*===/.test(view),
      false,
      '重命名的落点判定里出现了按名字/地址猜的写法'
    )
  })
})

// ---------------------------------------------------------------------------
// 复用 VideoContextMenu 的类型约束
// ---------------------------------------------------------------------------

describe('VideoContextMenu 的类型放宽', () => {
  /**
   * 组件里声明的结构（与 `VideoContextMenu.vue` 的 `ContextMenuEntry` 逐字段一致）。
   *
   * 这里**故意重抄一遍**：`tests/` 的 tsconfig 不包含 `.vue`（`vue-tsc` 才编译它们），
   * 所以从测试里 import 那个组件是不可能的。抄下来的作用不是「再实现一遍规则」，而是
   * 让「相机的菜单项能不能塞进这个浮层」这件事在 `tsc -p tsconfig.tests.json` 里就有
   * 答案 —— 放宽类型最常见的失败就是把相机那三个调用方改坏，而那是纯类型问题。
   */
  interface StructuralMenuEntry {
    action: string
    labelKey: string
    visible: boolean
    enabled: boolean
    disabledReasonKey?: string
    disabledReasonText?: string
    checked?: boolean
    separatorBefore?: boolean
    submenu?: StructuralMenuEntry[]
  }

  it('相机的菜单项可以赋给结构化的菜单项类型（两个既有调用方不用改）', () => {
    const cameraItem: CameraNvrMenuItem = {
      action: 'toggle-recording',
      labelKey: 'cameraNvrUi.menuStartRecording',
      visible: true,
      enabled: false,
      disabledReasonKey: 'cameraNvrUi.reasonIdle',
      checked: false,
      separatorBefore: true,
      submenu: [
        {
          action: 'snapshot',
          labelKey: 'cameraNvrUi.menuSnapshot',
          visible: true,
          enabled: true
        }
      ]
    }
    const widened: StructuralMenuEntry = cameraItem
    assert.equal(widened.action, 'toggle-recording')
    assert.equal(widened.submenu?.length, 1)
    // 树自己的两个动作也满足同一个结构（`action` 是 `string`，不是那个联合类型）。
    const treeItem: StructuralMenuEntry = {
      action: 'tree-rename-device',
      labelKey: 'deviceTreeUi.renameDevice',
      visible: true,
      enabled: true
    }
    assert.notEqual(treeItem.action, widened.action)
  })

  it('组件里确实导出了这个结构类型，且没有把相机类型写死进 props', () => {
    const menu = read('src/renderer/src/components/VideoContextMenu.vue')
    assert.ok(
      menu.includes('export interface ContextMenuEntry'),
      'VideoContextMenu 没有导出结构化的菜单项类型'
    )
    assert.ok(menu.includes('items: ContextMenuEntry[]'), 'items 的 props 没有用结构类型')
    // 事件签名保持相机动作联合类型不变（两个既有调用方的契约）。
    assert.ok(
      menu.includes("(event: 'select', action: CameraNvrAction): void"),
      'select 事件签名被改掉了：相机的两个调用方会失去类型检查'
    )
    // 相机菜单的规则仍然只有 `camera-nvr.ts` 一处：组件不许自己判启用/禁用。
    // 判的是**代码**，不是注释 —— 这个组件的文件头正当地提到了那个纯函数的名字。
    const code = stripComments(menu)
    assert.equal(
      /buildCameraNvrMenu/.test(code),
      false,
      'VideoContextMenu 自己调用了相机菜单规则（规则应该只有一处）'
    )
  })
})

// ---------------------------------------------------------------------------
// 目录：重命名这一块的句子
// ---------------------------------------------------------------------------

describe('重命名文案：四本目录齐全，而且说清了落点', () => {
  const REQUIRED = [
    'deviceTreeUi.renameDevice',
    'deviceTreeUi.renameChannel',
    'deviceTreeUi.expandNode',
    'deviceTreeUi.collapseNode',
    'deviceRename.titleDevice',
    'deviceRename.titleChannel',
    'deviceRename.fieldDevice',
    'deviceRename.fieldChannel',
    'deviceRename.sameName',
    'deviceRename.deviceFailed',
    'deviceRename.cameraHint',
    'deviceRename.deviceHint',
    'deviceRename.channelHint',
    'deviceRename.renameBoxNotice',
    'deviceRename.renameCameraNotice',
    'deviceRename.renameChannelNotice'
  ]

  it('每一条在四本目录里都有译文，而且不是照抄中文', () => {
    for (const key of REQUIRED) {
      for (const locale of Object.keys(CATALOGUES)) {
        const message = messageAt(locale, key)
        assert.ok(message && message.trim() !== '', `${locale} 缺少 ${key}`)
      }
      const reference = messageAt('zh-CN', key) as string
      for (const locale of ['en', 'es', 'tr']) {
        assert.notEqual(messageAt(locale, key), reference, `${locale} 的 ${key} 与中文逐字相同`)
      }
    }
  })

  it('带占位符的句子在四种语言里占位符一致', () => {
    for (const key of [
      'deviceRename.renameBoxNotice',
      'deviceRename.renameCameraNotice',
      'deviceRename.renameChannelNotice'
    ]) {
      const reference = placeholders(messageAt('zh-CN', key) as string)
      assert.deepEqual(reference, ['name'], `${key} 的参考文案占位符不是 {name}：${reference}`)
      for (const locale of ['en', 'es', 'tr']) {
        assert.deepEqual(
          placeholders(messageAt(locale, key) as string),
          reference,
          `${locale} 的 ${key} 占位符不一致`
        )
      }
    }
  })

  it('相机的成功提示明说「相机本身没有改名」，不能让人以为设备也改了', () => {
    const camera = messageAt('zh-CN', 'deviceRename.renameCameraNotice') as string
    assert.match(camera, /相机本身没有改名|相机没有改名/, `相机提示不够明确：${camera}`)
    // 箱子那一句必须说「设备自身也写入了」，否则与相机那句分不出区别。
    const box = messageAt('zh-CN', 'deviceRename.renameBoxNotice') as string
    assert.match(box, /设备自身/, `声纹设备提示没有说明写到设备：${box}`)
    const channel = messageAt('zh-CN', 'deviceRename.renameChannelNotice') as string
    assert.match(channel, /通道/, `通道提示没有说明改的是通道：${channel}`)
  })

  it('相机的说明文字点明「只保存在本机数据库」与接口没有该端点', () => {
    const hint = messageAt('zh-CN', 'deviceRename.cameraHint') as string
    assert.match(hint, /本机数据库/, `相机说明没有说清落点：${hint}`)
    assert.match(hint, /没有.*端点/, `相机说明没有说清设备侧做不到：${hint}`)
  })

  it('这一轮新增的消息里没有裸 `@`（vue-i18n 的 linked-message 记法）', () => {
    for (const key of REQUIRED) {
      for (const locale of Object.keys(CATALOGUES)) {
        const message = messageAt(locale, key) as string
        assert.equal(message.includes('@'), false, `${locale} 的 ${key} 含裸 @：${message}`)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 树在左列（源码层面；几何由真实窗口那次运行量）
// ---------------------------------------------------------------------------

describe('设备管理页的布局结构', () => {
  const view = read('src/renderer/src/views/DevicesView.vue')

  it('树是 .devices-layout 里的第一个子元素（左边那一列）', () => {
    const layout = view.indexOf('class="devices-layout"')
    const topology = view.indexOf('class="card devices-topology"')
    const main = view.indexOf('class="devices-main"')
    assert.ok(layout >= 0, '没有 .devices-layout')
    assert.ok(topology > layout, '拓扑不在 .devices-layout 里')
    assert.ok(main > topology, '拓扑不是左列（设备卡片在它之前）')
  })

  it('左列宽度仍然给树的缩进留了位置，右列吃掉剩余宽度', () => {
    assert.match(
      view,
      /grid-template-columns:\s*minmax\(220px,\s*280px\)\s+minmax\(0,\s*1fr\)/,
      '两列的定义被改掉了'
    )
    // 右列必须能收缩（`minmax(0, 1fr)`），否则宽内容会把整页撑出横向滚动条。
    assert.ok(view.includes('minmax(0, 1fr)'), '右列没有 minmax(0, 1fr)')
  })

  it('拓扑卡片自己不加左/上内边距：左上间距只有 .app-content 一处来源', () => {
    const block = view.slice(view.indexOf('.devices-topology {'))
    const body = block.slice(0, block.indexOf('}'))
    assert.match(body, /padding:\s*0\s+var\(--space-3\)/, `拓扑卡片的 padding 变了：${body}`)
    assert.equal(
      /--content-max-width|margin:\s*0\s+auto/.test(view),
      false,
      '设备管理页又出现了定宽居中列'
    )
  })
})
