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


describe('添加设备：「接入方式」三选一（业主 20260921 第 12 条）', () => {
  it('IP 地址 / HTTP / MQTT 三选一，默认 IP；原来的"不接入"档消失', () => {
    assert.match(dialog, /data-add-access-method/, '没有「接入方式」那一块')
    assert.match(
      dialog,
      /const ACCESS_METHODS = \['ip', 'http', 'mqtt'\] as const/,
      '三档不是 ip/http/mqtt'
    )
    assert.match(dialog, /const accessMethod = ref<AccessMethod>\('ip'\)/, '默认不是 IP 地址')
    assert.match(dialog, /:data-access-method="option"/, '单选项没有探针钩子')
    // 「不接入」不再是独立的一档：选项清单里没有 none，也不再引用 protocolNone 词条。
    assert.equal(/'none'/.test(dialog.slice(dialog.indexOf('const ACCESS_METHODS'), dialog.indexOf('const ACCESS_METHODS') + 300)), false)
    assert.equal(dialog.includes('protocolNone'), false, '「不接入」词条又被引用了（该档已删）')
  })

  it('IP 地址模式：四个地址/凭据输入 + 「更多（GIS）信息」折叠块；不含任何推流/协议块', () => {
    // 地址/凭据那一格只在 IP 模式渲染。
    assert.match(
      dialog,
      /<template v-if="accessMethod === 'ip'">[\s\S]{0,600}v-model="form\.ip"/,
      'IP 输入框不在 IP 模式分支里'
    )
    for (const binding of ['v-model.number="form.httpPort"', 'v-model="form.username"', 'v-model="form.password"']) {
      assert.ok(dialog.includes(binding), `没有 ${binding}`)
    }
    // 推流/协议块（数据流键、视频键、本机接入）整块只在 HTTP/MQTT 模式出现。
    assert.match(
      dialog,
      /<section v-if="pushMode" class="protocol" data-add-protocol>/,
      '推流块没有按接入方式门住（IP 模式不该含任何推流/协议块）'
    )
    assert.match(dialog, /data-iot-video-key/)
    assert.match(dialog, /data-add-iot-local/)
  })

  it('HTTP/MQTT 模式：名称（新增必填）+ 顶部说明；没有地址/凭据输入', () => {
    assert.match(dialog, /t\('addDeviceUi\.ingestModeHint'\)/, '推送模式顶部没有说明')
    assert.match(
      dialog,
      /<template v-else>[\s\S]{0,500}v-model="form\.name"/,
      '推送模式没有名称输入框'
    )
    // 名称必填：校验用的是新词条 deviceNameRequired。
    assert.match(
      dialog,
      /if \(!form\.name\.trim\(\)\)[\s\S]{0,120}addDeviceUi\.deviceNameRequired/,
      '名称必填没有用新词条拦'
    )
    // 推送模式的提交：地址与凭据一律发空串（主进程落 NULL、不存凭据）。
    assert.match(dialog, /ip: pushMode\.value \? '' : form\.ip\.trim\(\)/, '推送模式没有清空 IP')
    assert.match(dialog, /password: pushMode\.value \? '' : form\.password/, '推送模式没有清空口令')
    assert.match(
      dialog,
      /\.\.\.\(pushMode\.value \? \{ name: form\.name\.trim\(\) \} : \{\}\)/,
      '名称只在推送模式发送'
    )
  })

  it('GIS 折叠头：IP 模式用新词条「更多（GIS）信息」（addDeviceUi.moreGis）', () => {
    assert.match(
      dialog,
      /accessMethod === 'ip' \? t\('addDeviceUi\.moreGis'\) : t\('installUi\.section'\)/,
      '折叠头文案没有按接入方式切换'
    )
    // 推送模式 GIS 默认展开：切过去时强制展开。
    assert.match(
      dialog,
      /if \(method !== 'ip'\) \{\s*installationOpen\.value = true/,
      '切到 HTTP/MQTT 没有默认展开 GIS'
    )
  })

  it('「测试连接」只对 IP 地址模式出现（探活要地址与凭据）', () => {
    assert.match(
      dialog,
      /v-if="accessMethod === 'ip'"[\s\S]{0,200}@click="testConnection"/,
      '测试连接按钮没有按接入方式门住'
    )
  })

  it('添加成功：推送设备用新词条 pushDeviceAdded，并照旧显示推流端点', () => {
    assert.match(
      dialog,
      /addedDevice\.kind === 'pushDevice'[\s\S]{0,120}addDeviceUi\.pushDeviceAdded/,
      '推送设备的成功提示没有用新词条'
    )
    assert.match(dialog, /data-add-device-done/, '没有"添加成功"那一块')
    assert.match(dialog, /<DevicePushEndpoint :device-id="addedDevice\.id" \/>/, '添加成功后没有推流端点')
  })

  it('接入方案的校验与规范化照旧走共享层纯函数', () => {
    assert.match(dialog, /deviceIngestPlanProblems\(ingestPlan\.value\)/, '没有用共享层的校验')
    assert.match(
      dialog,
      /if \(ingestProtocol\.value !== 'none' && planProblems\.value\.length > 0\)/,
      '不合法时没有拦住提交'
    )
    assert.match(dialog, /data-iot-plan-problem/, '没有把问题显示出来')
    assert.match(dialog, /ingest: normaliseDeviceIngestPlan\(ingestPlan\.value\)/, '提交时没有规范化')
    // IP 模式（none）就**不发**方案；http/mqtt 发送 ⇒ 主进程按 pushDevice 登记。
    assert.match(dialog, /ingestProtocol\.value === 'none'\s*\n\s*\?\s*\{\}/, 'IP 模式仍然发了方案')
  })

  it('关窗之后接入方式回到出厂默认（IP 地址）', () => {
    const reset = dialog.slice(dialog.indexOf('function resetForm'), dialog.indexOf('function resetForm') + 700)
    assert.match(reset, /accessMethod\.value = 'ip'/, '没有重置接入方式')
    assert.match(reset, /metricKeys\.value = defaultIngestMetricKeys\(\)/, '没有重置遥测键')
    assert.match(reset, /videoKey\.value = DEFAULT_INGEST_VIDEO_KEY/, '没有重置视频键')
  })

  it('监听状态是**只读的读数**：读一次 ingest 读数，端口改法照旧在本机接入里', () => {
    assert.match(dialog, /void ingest\.load\(\)/, '没有读接入读数')
    assert.match(dialog, /data-iot-listen-status/, '没有监听状态那一段')
    assert.match(dialog, /t\('addDeviceUi\.protocolListening', \{ port:/, '监听中那句话没有带端口')
  })

  it('这一批新词条的**键名**全部出现在对话框源码里（词条由 i18n 统一补）', () => {
    for (const key of [
      'addDeviceUi.accessMethod',
      'addDeviceUi.accessMethodIp',
      'addDeviceUi.accessMethodHttp',
      'addDeviceUi.accessMethodMqtt',
      'addDeviceUi.moreGis',
      'addDeviceUi.deviceNameRequired',
      'addDeviceUi.ingestModeHint',
      'addDeviceUi.pushDeviceAdded'
    ]) {
      assert.ok(dialog.includes(`'${key}'`), `对话框没有引用 ${key}`)
    }
  })
})
