/**
 * 「添加设备」对话框的第 13 批改造（业主 2026-09-19）。
 *
 * WHY THIS FILE EXISTS
 * 这一批对这个对话框提了两件事，而且两件都是"少看一眼就漏"的：
 *
 *   1. **「地址信息」默认收起**（A2）。它是可选的一段（只有声源定位设备才填点位），
 *      摊开会把主路径挤下去；但收起之后**必须仍说得清填了没有** —— 一个纯标题的折叠行
 *      会让操作员要么每次点开看一眼、要么永远不知道里面有没有东西。所以小结那三档
 *      （未填写 / 点位有值 / 只填了一部分）在这里逐条钉住。
 *   2. 收起是**真的收起**：内容用 `v-if` 从 DOM 上摘掉，而不是用 CSS 藏起来 ——
 *      后者会让收起状态下的输入框仍然被 Tab 走到（键盘用户会"掉进"一段看不见的表单）。
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

const CATALOGUES: Record<string, { addDeviceUi: Record<string, unknown> }> = {
  'zh-CN': zhCN as unknown as { addDeviceUi: Record<string, unknown> },
  en: en as unknown as { addDeviceUi: Record<string, unknown> },
  es: es as unknown as { addDeviceUi: Record<string, unknown> },
  tr: tr as unknown as { addDeviceUi: Record<string, unknown> }
}

const dialog = read('src/renderer/src/components/AddDeviceDialog.vue')

describe('添加设备：「地址信息」默认收起（第 13 批第 2 条）', () => {
  it('收起状态是**默认值**，而且关窗之后回到收起', () => {
    assert.match(
      dialog,
      /const installationOpen = ref\(false\)/,
      '「地址信息」的展开状态不是默认收起'
    )
    const reset = dialog.slice(dialog.indexOf('function resetForm'), dialog.indexOf('function resetForm') + 400)
    assert.match(reset, /installationOpen\.value = false/, '关窗之后没有回到收起状态')
  })

  it('展开靠一颗带 aria 状态的按钮，内容是 `v-if`（不是 CSS 藏起来）', () => {
    assert.match(dialog, /data-action="toggle-add-installation"/, '没有那颗展开/收起按钮')
    assert.match(dialog, /:aria-expanded="installationOpen"/, '按钮没有暴露展开状态')
    assert.match(dialog, /aria-controls="add-installation-body"/, '按钮没有指向它控制的那一块')
    assert.match(
      dialog,
      /<div v-if="installationOpen" id="add-installation-body"[\s\S]{0,400}<input/,
      '那一块内容不是 `v-if` 出来的（收起时输入框仍然会被 Tab 走到）'
    )
    // 整段有稳定的探针钩子（探针用它断言"默认收起、点一下展开"）。
    assert.ok(dialog.includes('data-add-installation'), '没有给探针的钩子')
  })

  it('收起时那一行仍说得清填了没有（三档分开）', () => {
    assert.match(dialog, /const installationSummary = computed\(/, '没有收起时那一行小结')
    assert.match(dialog, /t\('addDeviceUi\.installationEmpty'\)/, '没有"未填写"那一档')
    assert.match(dialog, /t\('addDeviceUi\.installationPoint', \{/, '没有"点位有值"那一档')
    assert.match(dialog, /t\('addDeviceUi\.installationPartial'\)/, '没有"只填了一部分"那一档')
    // 小结读的是与提交同一套判据（`parseInstallation` / `hasInstallation`）。
    assert.match(dialog, /const parsed = parseInstallation\(form\.installation\)/, '小结没有用共享判据')
    assert.match(dialog, /hasInstallation\(parsed\.installation\)/, '小结没有用共享判据')
  })

  it('三条小结文案四语言齐全，占位符一致', () => {
    for (const [locale, catalogue] of Object.entries(CATALOGUES)) {
      for (const key of ['installationEmpty', 'installationPoint', 'installationPartial']) {
        const value = catalogue.addDeviceUi[key]
        assert.equal(typeof value, 'string', `${locale} 缺 addDeviceUi.${key}`)
        assert.ok(String(value).trim() !== '', `${locale} 的 ${key} 是空的`)
      }
    }
    for (const locale of ['en', 'es', 'tr']) {
      assert.deepEqual(
        (String(CATALOGUES[locale]!.addDeviceUi.installationPoint).match(/\{(\w+)\}/g) ?? []).sort(),
        (String(CATALOGUES['zh-CN']!.addDeviceUi.installationPoint).match(/\{(\w+)\}/g) ?? []).sort(),
        `${locale} 的 installationPoint 占位符与中文不一致`
      )
    }
    assert.deepEqual(
      (String(CATALOGUES['zh-CN']!.addDeviceUi.installationPoint).match(/\{(\w+)\}/g) ?? []).sort(),
      ['{latitude}', '{longitude}']
    )
  })

  it('提交路径没有被收起影响：收起时照样把地址信息一起提交', () => {
    // 判据是"填了没有"（`hasInstallation`），不是"展没展开" —— 否则收起状态下输入的点位会被丢掉。
    const submit = dialog.slice(dialog.indexOf('async function submit'), dialog.indexOf('function installationValidation'))
    assert.match(submit, /hasInstallation\(parsed\.installation\)/, '提交时按展开状态判了')
    assert.equal(
      /installationOpen/.test(submit),
      false,
      '提交路径里出现了展开状态（收起时输入的点位会被丢掉）'
    )
  })
})
