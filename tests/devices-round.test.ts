/**
 * 设备管理页（**拓扑树下架之后**）的界面与目录回归测试。
 *
 * WHY THIS FILE EXISTS
 * 业主 2026-09-18 第 5 条要求「移除左侧拓扑树，添加设备进标题栏」。这一条**删掉的比加上的
 * 多**：一整棵树的组件、它的 store、纯函数与那份单元测试全部下架，「添加设备」搬到顶栏。
 * 删掉的东西没有任何「单元」会因为被带回来而变红，所以这一份必须在源码结构上把它们钉住：
 *   1. 被删的文件必须真的不存在，渲染层里不许再有人 import 它们（留一个空壳组件是最容易
 *      发生的"半搬"状态：界面上看不见，但下一次改动会照着它写）；
 *   2. 被删的**目录键**必须真的删掉（`deviceTreeUi.*` / `deviceRename.*`）。留着一条没人用的
 *      `deviceTreeUi.renameDevice`，下一个人很容易顺着它把右键菜单画回屏幕上（这条规则与
 *      `page-layout.test.ts` 钉 `--content-max-width` 是同一条：删掉的东西才会被遵守）；
 *   3. 「添加设备」的入口必须真的在顶栏那一格里，而且**空列表时也得在** —— 新装的机器
 *      一台设备都没有，把按钮跟着表格一起 `v-if` 掉会让它无路可走；
 *   4. 下架的是**界面**，不是能力：设备改名留在设备详情页、通道改名留在通道配置里。
 *      这两件必须继续有源码落点，否则这次改动就是把功能删了而不是搬家。
 *
 * 真实窗口里的几何（单列宽度、十列在 1280×720 下放不放得下、顶栏那颗按钮的位置）由
 * `scripts/demo-shot-driver.cjs` 量。这一层与那一层的分工写在 `page-layout.test.ts` 的文件头里。
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

function exists(relative: string): boolean {
  return fs.existsSync(path.join(projectRoot, relative))
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
  return open >= 0 && close > open ? source.slice(open, close + '</template>'.length) : ''
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

/** 渲染层里所有的 `.vue` / `.ts`，相对仓库根。 */
function rendererFiles(): string[] {
  const root = path.join(projectRoot, 'src', 'renderer', 'src')
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(vue|ts)$/.test(entry.name)) files.push(path.relative(projectRoot, full))
    }
  }
  walk(root)
  return files
}

// ---------------------------------------------------------------------------
// 拓扑树下架：文件、引用、目录键
// ---------------------------------------------------------------------------

/** 第 5 条删掉的五个文件（四个源码 + 它自己的那份单元测试）。 */
const REMOVED_FILES = [
  'src/renderer/src/components/DeviceTree.vue',
  'src/renderer/src/components/DeviceRenameDialog.vue',
  'src/renderer/src/stores/deviceTree.ts',
  'src/renderer/src/lib/deviceTree.ts',
  'tests/device-tree.test.ts'
]

describe('拓扑树下架（业主 2026-09-18 第 5 条）', () => {
  it('被删的五个文件真的不存在', () => {
    for (const file of REMOVED_FILES) {
      assert.equal(exists(file), false, `${file} 又回来了（第 5 条要求整棵树下架）`)
    }
  })

  it('渲染层里没有任何地方再 import 树、树的 store 或那个重命名对话框', () => {
    // 断言的是**引用**（import 语句 / 模板标签），不是"文件里出现过这个词"——
    // `DevicesView.vue` 的文件头会正当地写出这次改动删掉了什么。
    const importLike = new RegExp(
      String.raw`(from\s+'[^']*(DeviceTree|DeviceRenameDialog|stores/deviceTree|lib/deviceTree)[^']*'|<DeviceTree|<DeviceRenameDialog|useDeviceTreeStore)`
    )
    for (const file of rendererFiles()) {
      const source = stripComments(read(file))
      assert.equal(importLike.test(source), false, `${file} 仍然引用已下架的树/重命名对话框`)
    }
  })

  it('设备管理页里不再有树的挂载点与两列布局', () => {
    const view = stripComments(read('src/renderer/src/views/DevicesView.vue'))
    for (const token of [
      'devices-layout',
      'devices-topology',
      'devices-main',
      'device-tree',
      'treeSelection',
      'onRenameDevice',
      'onRenameChannel',
      'renameDeviceName',
      'renameChannelName',
      'openDeviceInWall',
      'selectDevice'
    ]) {
      assert.equal(view.includes(token), false, `DevicesView.vue 里仍然有 ${token}`)
    }
  })

  it('被删的两组目录键在四本目录里都不存在了', () => {
    for (const locale of Object.keys(CATALOGUES)) {
      assert.equal(
        messageAt(locale, 'deviceTreeUi'),
        undefined,
        `${locale} 里仍然存在已删除的 deviceTreeUi 组`
      )
      assert.equal(
        messageAt(locale, 'deviceRename'),
        undefined,
        `${locale} 里仍然存在已删除的 deviceRename 组`
      )
    }
  })

  it('整个渲染层里没有任何地方再引用这两组键', () => {
    for (const file of rendererFiles()) {
      const source = read(file)
      for (const key of ['deviceTreeUi.', 'deviceRename.']) {
        assert.equal(source.includes(key), false, `${file} 仍然引用已删除的 ${key}*`)
      }
    }
  })

  it('更早删掉的两句文案也没有回来（页面标题与设备/在线计数那一行）', () => {
    const view = stripHtmlComments(read('src/renderer/src/views/DevicesView.vue'))
    assert.equal(/devicesUi\.count/.test(view), false, '设备管理页又渲染了 devicesUi.count')
    assert.equal(/page-subtitle/.test(view), false, '设备管理页又出现了 `.page-subtitle`')
    assert.equal(/page-title/.test(view), false, '设备管理页又出现了 `.page-title`')
    for (const locale of Object.keys(CATALOGUES)) {
      assert.equal(
        messageAt(locale, 'devicesUi.count'),
        undefined,
        `${locale} 里仍然存在已删除的 devicesUi.count`
      )
    }
  })
})

// ---------------------------------------------------------------------------
// 「添加设备」搬进标题栏
// ---------------------------------------------------------------------------

describe('「添加设备」在标题栏那一格里', () => {
  const view = stripHtmlComments(read('src/renderer/src/views/DevicesView.vue'))
  const template = templateBlock(view)

  it('入口投到 `#topbar-page-slot`，不再是本页自己画的一颗按钮', () => {
    assert.ok(
      template.includes('<Teleport to="#topbar-page-slot">'),
      '「添加设备」没有投到顶栏那一格'
    )
    assert.ok(
      template.includes('data-action="device-add"'),
      '顶栏那颗按钮没有稳定的探针钩子（data-action="device-add"）'
    )
    assert.ok(
      template.includes("t('devicesUi.addButton')"),
      '顶栏那颗按钮的文案不是目录键 devicesUi.addButton'
    )
  })

  it('投出去的是 `.page` 早期的子节点，排在空状态与表格之前', () => {
    const page = template.indexOf('class="page"')
    const teleport = template.indexOf('<Teleport to="#topbar-page-slot">')
    const empty = template.indexOf('<EmptyState')
    const table = template.indexOf('class="devices-table-flat"')
    assert.ok(page >= 0 && teleport >= 0 && empty >= 0 && table >= 0, '页面里缺了 .page / Teleport / EmptyState / 设备表之一')
    assert.ok(teleport > page, 'Teleport 不在 .page 里面')
    assert.ok(teleport < empty, '「添加设备」排在了空状态之后')
    assert.ok(teleport < table, '「添加设备」排在了设备表之后')
  })

  it('「添加设备」不在"有设备时才画"的分支里（空列表那一屏唯一的动作就是它）', () => {
    // `.page` 里唯一一个 `v-if="cards.length === 0"` 是空状态。Teleport 那一整块必须
    // 完全落在它之前 —— 否则新装的机器一台设备都没有时会连入口都看不见。
    const teleportBlock = template.slice(
      template.indexOf('<Teleport to="#topbar-page-slot">'),
      template.indexOf('</Teleport>')
    )
    assert.equal(
      /cards\.length/.test(teleportBlock),
      false,
      '顶栏那颗按钮挂上了与设备数量有关的分支'
    )
  })

  it('只有管理员能看到这颗按钮（与删除列同一条口径）', () => {
    const block = template.slice(
      template.indexOf('<Teleport to="#topbar-page-slot">'),
      template.indexOf('</Teleport>')
    )
    assert.ok(block.includes('v-if="session.isAdmin"'), '顶栏的添加按钮没有做管理员判断')
  })

  it('设备管理页把它接回对话框（按钮只开对话框，不自己写库）', () => {
    assert.ok(template.includes('@click="addOpen = true"'), '按钮没有打开添加对话框')
    assert.ok(
      template.includes('<AddDeviceDialog v-model="addOpen" @added="onAdded" />'),
      '添加对话框没有被接回来'
    )
  })

  it('这条文案在四本目录里都有译文，而且不是照抄中文', () => {
    const reference = messageAt('zh-CN', 'devicesUi.addButton') as string
    assert.ok(reference && reference.trim() !== '', 'zh-CN 缺少 devicesUi.addButton')
    for (const locale of ['en', 'es', 'tr']) {
      const message = messageAt(locale, 'devicesUi.addButton')
      assert.ok(message && message.trim() !== '', `${locale} 缺少 devicesUi.addButton`)
      // 「添加设备」在英文里可能是 "Add device"、西语 "Añadir dispositivo"……都行，
      // 但逐字抄中文一定不对。
      assert.notEqual(message, reference, `${locale} 的 devicesUi.addButton 与中文逐字相同`)
    }
  })
})

// ---------------------------------------------------------------------------
// 下架的是界面，不是能力
// ---------------------------------------------------------------------------

describe('改名能力仍然有落点（树没了不等于功能没了）', () => {
  it('设备改名留在设备详情页（写到设备自身，不写本地名字）', () => {
    const detail = stripComments(read('src/renderer/src/views/DeviceDetailView.vue'))
    assert.ok(detail.includes('config.setDeviceName'), '设备详情页不再有设备改名的写入')
    assert.ok(detail.includes('nameDraft'), '设备详情页不再有改名的输入态')
    // 落点只有一个：设备的名字由设备自己说了算。本机那份是**读回来**的
    // （`handlers.ts` 里 setDeviceName 之后会 `getInfo` 刷新缓存名）。
    assert.equal(
      /devices\.update\(\{[^}]*name/.test(detail),
      false,
      '设备详情页又开始往本地数据库写名字了：本机名会与设备真实名字分叉'
    )
  })

  it('通道改名留在通道配置里（写设备，然后重新读回通道表）', () => {
    const channel = stripComments(
      read('src/renderer/src/components/device-config/ChannelConfigSection.vue')
    )
    assert.ok(channel.includes('config.updateChannel'), '通道配置不再写通道名')
    assert.ok(/name:\s*row\.draft\.name/.test(channel) || channel.includes('row.draft.name'), '通道配置不再有改名输入态')
  })
})

// ---------------------------------------------------------------------------
// 复用 VideoContextMenu 的类型约束（相机那两处调用方不能改坏）
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
    // 结构类型的 `action` 是 `string` 而不是相机的动作联合：这是树那一轮为了把树的
    // 右键项塞进同一个浮层而放宽的，树下架之后仍然保留（相机那边的新动作不必改组件）。
    assert.equal(typeof widened.action, 'string')
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
// 单列布局（几何由真实窗口那次运行量）
// ---------------------------------------------------------------------------

describe('设备管理页的布局结构', () => {
  const view = read('src/renderer/src/views/DevicesView.vue')

  it('页面没有定宽居中列（左对齐、流式，与总览页同一条口径）', () => {
    assert.equal(
      /--content-max-width|margin:\s*0\s+auto/.test(view),
      false,
      '设备管理页又出现了定宽居中列'
    )
  })

  it('表格是 `.page` 的直接子节点，中间没有一层布局容器', () => {
    const code = stripHtmlComments(view)
    const page = code.indexOf('class="page"')
    const section = code.indexOf('class="devices-table-flat"')
    assert.ok(page >= 0, '没有 .page')
    assert.ok(section > page, '设备表不在 .page 里')
    // `.page` 与设备表之间除了 Teleport / 提示行 / 空状态之外，不该再有一层 div 包裹。
    const between = code.slice(page, section)
    assert.equal(
      /<div[^>]*class="(devices-|)[^"]*(layout|main|wrap)/.test(between),
      false,
      '设备表又被包进了一层布局容器'
    )
  })
})
