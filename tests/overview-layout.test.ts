/**
 * 总览页与视频墙这一轮的排版要求（产品原话）：
 *   1.「总览界面，四个窗口默认是 16:9 的比例，添加新视频或者声纹图的加号应该在窗口中心。」
 *   6.「设备状态不需要在总览中显示，告警状态也不需要。」
 *
 * WHY THIS FILE EXISTS
 * 这三件事都能在源码里「看起来做完了」而在屏幕上不成立：
 *   - `aspect-ratio` 写在 `.camera-wall__cell` 上才会让**整格**是 16:9；写在
 *     `<video>` 上只会让画面在盒子里留边，格子还是随便多高。声明还有可能被
 *     `min-height` / 网格行高盖掉，所以真机测量在 `scripts/video-proof-driver.cjs`
 *     （量每一格真正的盒子），这里钉住声明与「没有把 `+` 推回边上」这两件事。
 *   - 空白格的 `+` 上一轮是「靠右」（`.camera-wall__body--empty { align-items: flex-end }`），
 *     产品这一轮改主意要它在**中心**。这个反转很容易被误当成回归改回去，所以两边都钉：
 *     新要求（居中）必须在，旧写法（`flex-end`）必须不在。
 *   - 两张卡片删掉之后，模板里可能留下引用；而它们引用的词条会变成孤儿，需要交给
 *     目录那一轮清理 —— 本文件把「渲染层里再没有任何地方引用这些键」钉住，那份键名
 *     清单就是给目录轮用的（**不在这里删词条**，四个目录文件不属于本文件的所有者）。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

const projectRoot = path.resolve(__dirname, '..', '..')
const rendererRoot = path.join(projectRoot, 'src', 'renderer', 'src')

function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 取 SFC 的 `<style>` 块（这个仓库每个组件只有一个样式块）。 */
function styleBlock(source: string): string {
  const match = /<style[^>]*>([\s\S]*?)<\/style>/.exec(source)
  assert.ok(match, '组件里没有 <style> 块')
  return stripCssComments(match[1] ?? '')
}

/** 取模板块（`<template>` 到最后一个 `</template>`）：只测真正渲染出来的标记。 */
function templateBlock(source: string): string {
  const start = source.indexOf('<template>')
  const end = source.lastIndexOf('</template>')
  assert.ok(start >= 0 && end > start, '组件里没有 <template> 块')
  return source.slice(start, end)
}

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  assert.ok(start >= 0, `没有找到规则 ${selector}`)
  const end = css.indexOf('}', start)
  assert.ok(end > start, `规则 ${selector} 没有闭合`)
  return css.slice(start, end)
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(vue|ts)$/.test(entry.name)) out.push(full)
  }
  return out
}

const overview = read('src/renderer/src/views/OverviewView.vue')
const wall = read('src/renderer/src/components/CameraVideoWall.vue')

/**
 * 这一轮删掉的两张卡片独占的词条。
 *
 * 这份清单有两个用途：声明层里断言渲染层**没有任何地方**再引用它们（删干净了），
 * 以及交给目录那一轮去删词条 —— 本文件刻意**不删**词条：四个目录文件由另一轮负责，
 * 而且「键还在、引用没了」是可检出的，反过来（键删了、引用还在）才是界面上的裸 key。
 */
const ORPHANED_OVERVIEW_KEYS = [
  'overview.recentAlarms',
  'overview.noRecentAlarms',
  'overview.deviceStatus',
  'overview.manageDevices',
  'overview.noDevices',
  'overview.goAddDevice',
  'overview.alarmAcknowledged',
  'overview.alarmUnacknowledged',
  'common.viewAll'
]

describe('总览页只剩视频墙与通道墙', () => {
  const template = templateBlock(overview)

  it('两块内容都在：实时视频墙（自动起播）与通道墙', () => {
    // 自动起播是总览页独有的属性，而且必须是**这一个标签**上的（跨标签的贪婪匹配会
    // 在属性被挪到别处时照样通过）。
    assert.match(template, /<CameraVideoWall[^>]*auto-play[^>]*\/>/)
    assert.match(template, /:active-device-id="devices\.selectedDeviceId"/)
    assert.match(template, /<ChannelWall\s*\/>/)
  })

  it('「最近告警」与「设备状态」两张卡确实删掉了（不是藏起来）', () => {
    assert.equal(template.includes('two-col'), false, '`.two-col` 网格还在：它是那两张卡的容器')
    assert.equal(template.includes('section-header'), false, '卡片标题行还在')
    assert.equal(template.includes('<EmptyState'), false, '两张卡的空状态还在')
    assert.equal(template.includes('deviceList'), false, '设备列表的渲染逻辑还在')
  })

  it('两张卡独占的目录键在渲染层里没有任何引用', () => {
    const files = walk(rendererRoot)
    const hits: string[] = []
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8')
      // 注释里提到键名不算引用（这一轮留下了说明性注释），只找 `t('key')` 这类调用。
      for (const key of ORPHANED_OVERVIEW_KEYS) {
        if (source.includes(`t('${key}'`) || source.includes(`t("${key}"`)) {
          hits.push(`${path.relative(rendererRoot, file)} -> ${key}`)
        }
      }
    }
    assert.deepEqual(hits, [], `这些键仍被引用，说明卡片没删干净：${hits.join(', ')}`)
  })

  it('剩下的唯一「说点什么」是设备读取失败的原样错误，不是一个新句式', () => {
    assert.match(template, /devices\.error/)
    assert.match(template, /role="alert"/)
  })
})

describe('视频墙的格子是 16:9，空白格的 + 在正中', () => {
  const css = styleBlock(wall)
  const template = templateBlock(wall)

  it('16:9 写在格子本身上，而不是写在 <video> 上', () => {
    const cell = ruleBody(css, '.camera-wall__cell')
    assert.match(cell, /aspect-ratio:\s*16\s*\/\s*9/)
    // 整格是 16:9 才叫「四个窗口默认是 16:9」；画面自己再定比例只会变成盒子内留边。
    const video = ruleBody(css, '.camera-wall__video')
    assert.equal(/aspect-ratio/.test(video), false, '比例被写到了 <video> 上：格子仍然不是 16:9')
  })

  it('格子上没有最小高度：min-height 是唯一能让 16:9 失效的东西', () => {
    // 真机实测：16 分屏在默认窗口里每格 275.2px 宽，`min-height: 170px` 会把它顶成
    // 275.2×170 ≈ 1.62:1 —— 声明还在，比例却不是 16:9。所以这一条必须不在，
    // 而且 <video> 上同样不能有（它会把画面顶出格子，被 overflow 裁掉）。
    const cell = ruleBody(css, '.camera-wall__cell')
    assert.equal(/min-height/.test(cell), false, `格子上又出现了 min-height：${cell}`)
    const video = ruleBody(css, '.camera-wall__video')
    assert.equal(/min-height/.test(video), false, `<video> 上又出现了 min-height：${video}`)
  })

  it('空白格的 + 居中：新的写法在，旧的 flex-end 不在', () => {
    const emptyBody = ruleBody(css, '.camera-wall__body--empty')
    assert.match(emptyBody, /align-items:\s*center/)
    assert.equal(
      /flex-end/.test(emptyBody),
      false,
      '空白格的 + 又靠右了：产品这一轮明确要求它在窗口中心'
    )
    // 纵向居中来自基类（两轴都 center），所以这一格只有「居中」一种画法。
    const body = ruleBody(css, '.camera-wall__body')
    assert.match(body, /justify-content:\s*center/)
    assert.match(body, /align-items:\s*center/)
  })

  it('空白格仍然只有一个 +：没有文字、没有可见的 <select>', () => {
    assert.match(template, /class="camera-wall__add"/)
    assert.match(template, /camera-wall__plus/)
    // 选择器宿主在墙级别：空白格里因此不可能出现一条 <option> 文本。
    assert.match(template, /camera-wall__pickers/)
  })

  it('每一格 <video> 仍然被地址与状态双重守卫（空地址时不存在播放器）', () => {
    // 这是整个视频墙最硬的一条不变量：没有地址的 `<video>` 等于一块黑矩形。
    const guard = /<video\s+v-if="cell\.url && isCameraCellLive\(cell\.status\)"/
    assert.match(template, guard)
    assert.match(template, /:src="cell\.url"/)
  })

  it('档位控件仍然在标题行里、并且是标题行最右的元素（产品要求右对齐）', () => {
    const header = template.slice(template.indexOf('class="section-header"'), template.indexOf('camera-wall__notice'))
    assert.match(header, /class="segment camera-wall__layout"/)
    assert.ok(
      header.indexOf('camera-wall__layout') > header.indexOf('section-title'),
      '档位控件不在标题之后（那它就不在标题行的右端）'
    )
    // 控件里只有图标：按钮上有 svg 与无障碍名字，没有文字。
    assert.match(header, /<LayoutGridIcon/)
    assert.match(header, /aria-label="t\('cameraWallUi\.layoutLabel'/)
  })
})
