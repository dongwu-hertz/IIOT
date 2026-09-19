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

describe('添加设备：「协议接入方式」（第 13 批第 3、4 条）', () => {
  it('三档单选，默认不接入；选了 HTTP/MQTT 才出现接口清单', () => {
    assert.match(dialog, /data-add-protocol/, '没有「协议接入方式」那一块')
    assert.match(dialog, /const PROTOCOL_OPTIONS: readonly IngestProtocol\[\] = \['none', 'http', 'mqtt'\]/, '三档不是 none/http/mqtt')
    assert.match(dialog, /const ingestProtocol = ref<IngestProtocol>\('none'\)/, '默认不是"不接入"')
    assert.match(dialog, /:data-iot-protocol="option"/, '单选项没有探针钩子')
    // 接口清单只在选了协议之后渲染（不接入时不显示四个键）。
    assert.match(dialog, /<template v-if="ingestProtocol !== 'none'">/, '接口清单没有按协议门住')
  })

  it('数据流接口：四个可显示的指标各一行，行上有键名输入与探针钩子', () => {
    assert.match(dialog, /const metricKeys = ref<IngestMetricKey\[\]>\(defaultIngestMetricKeys\(\)\)/, '没有那四行的草稿')
    assert.match(dialog, /:data-iot-metric-key="row\.metric"/, '键名输入没有探针钩子')
    assert.match(dialog, /METRIC_LABEL_KEYS\[row\.metric\]/, '行的标签不是指标名字')
    // 四个指标的名字复用目录里既有的那四条（趋势页/实时监测页用的是同一批）。
    for (const key of ['metrics.spl', 'metrics.mainFrequency', 'metrics.smoothness', 'metrics.bandEnergyRatio']) {
      assert.ok(dialog.includes(key), `指标标签没有复用 ${key}`)
    }
  })

  it('视频流接口：一个键名输入，默认 video_url，留空表示不推视频', () => {
    assert.match(dialog, /const videoKey = ref\(DEFAULT_INGEST_VIDEO_KEY\)/, '没有视频键的草稿')
    assert.match(dialog, /data-iot-video-key/, '视频键没有探针钩子')
    assert.match(dialog, /t\('addDeviceUi\.videoKeyHint'\)/, '没有"留空表示不推视频"那句说明')
  })

  it('方案由共享层的纯函数校验，不合法就**不提交**', () => {
    assert.match(dialog, /deviceIngestPlanProblems\(ingestPlan\.value\)/, '没有用共享层的校验')
    assert.match(
      dialog,
      /if \(ingestProtocol\.value !== 'none' && planProblems\.value\.length > 0\)/,
      '不合法时没有拦住提交'
    )
    assert.match(dialog, /data-iot-plan-problem/, '没有把问题显示出来')
    // 提交时规范化（库里只存一种写法）。
    assert.match(dialog, /ingest: normaliseDeviceIngestPlan\(ingestPlan\.value\)/, '提交时没有规范化')
    // 不接入就**不发**这一项（库里那一列的出厂值本来就是 none）。
    assert.match(dialog, /ingestProtocol\.value === 'none'\s*\n\s*\?\s*\{\}/, '"不接入"时仍然发了方案')
  })

  it('关窗之后接入方式与接口清单回到出厂默认', () => {
    const reset = dialog.slice(dialog.indexOf('function resetForm'), dialog.indexOf('function resetForm') + 700)
    assert.match(reset, /ingestProtocol\.value = 'none'/, '没有重置协议')
    assert.match(reset, /metricKeys\.value = defaultIngestMetricKeys\(\)/, '没有重置遥测键')
    assert.match(reset, /videoKey\.value = DEFAULT_INGEST_VIDEO_KEY/, '没有重置视频键')
  })

  it('监听状态是**只读的读数**：读一次 ingest 读数，不在这一屏改端口', () => {
    assert.match(dialog, /void ingest\.load\(\)/, '没有读接入读数')
    assert.match(dialog, /data-iot-listen-status/, '没有监听状态那一段')
    assert.match(dialog, /t\('addDeviceUi\.protocolListening', \{ port:/, '监听中那句话没有带端口')
    // 端口在系统设置里（这一轮只显示状态，不改端口）。
    assert.equal(/iotHttpPort|iotMqttPort/.test(dialog), false, '这一屏出现端口输入框了（端口还没搬过来）')
  })

  it('十条新文案四语言齐全', () => {
    const KEYS = [
      'protocolSection',
      'protocolHint',
      'protocolNone',
      'protocolHttp',
      'protocolMqtt',
      'protocolListening',
      'protocolNotListening',
      'protocolNotListeningReason',
      'protocolListenUnknown',
      'metricKeysTitle',
      'metricKeysHint',
      'videoKeyTitle',
      'videoKeyHint',
      'protocolPlanInvalid'
    ]
    for (const [locale, catalogue] of Object.entries(CATALOGUES)) {
      for (const key of KEYS) {
        const value = catalogue.addDeviceUi[key]
        assert.equal(typeof value, 'string', `${locale} 缺 addDeviceUi.${key}`)
        assert.ok(String(value).trim() !== '', `${locale} 的 ${key} 是空的`)
      }
    }
    for (const locale of ['en', 'es', 'tr']) {
      for (const key of ['protocolListening', 'protocolNotListeningReason']) {
        assert.deepEqual(
          (String(CATALOGUES[locale]!.addDeviceUi[key]).match(/\{(\w+)\}/g) ?? []).sort(),
          (String(CATALOGUES['zh-CN']!.addDeviceUi[key]).match(/\{(\w+)\}/g) ?? []).sort(),
          `${locale} 的 ${key} 占位符与中文不一致`
        )
      }
    }
  })
})
