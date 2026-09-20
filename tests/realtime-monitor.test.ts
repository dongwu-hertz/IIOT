/**
 * GIS 实时监测工作台的领域与适配层守卫（业主 2026-09-20 规格 V1.0）。
 *
 * 为什么这些断言放在这一层：
 *   - 五套模板由**协议事实**（kind + e2Variant）解析，不由型号名分支；这条一旦破，
 *     以后每接一台设备都会变成改页面；
 *   - 颜色/方向这些"看起来只是样式"的东西有硬语义：红色只能来自真实告警（§6）、
 *     Live 不能伪造方向（§20）、缺失值不能用 0（§31）。
 *     这些判据都是纯函数，值得直接用单测钉住，而不是靠读源码字符串。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import type { AlarmEvent, Device } from '../src/shared/domain/models'
import { AlarmType } from '../src/shared/domain/models'
import {
  REALTIME_KPI_LIMIT,
  REALTIME_TEMPLATES,
  parseAirSonarDirection,
  realtimeActions,
  realtimeHeaderStatus,
  realtimeQualityAt,
  resolveRealtimeProfile,
  withCameraMode
} from '../src/shared/domain/realtime-monitor'
import {
  buildRealtimeFrame,
  featureSourceOfAlarm,
  missingMetric
} from '../src/renderer/src/lib/realtimeAdapters'

function device(overrides: Partial<Device>): Device {
  return {
    id: 'dev-1',
    deviceUid: 'uid-1',
    kind: 'acousticBox',
    name: 'FA8-001',
    connectionType: 'LAN',
    status: 'ONLINE',
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function alarm(overrides: Partial<AlarmEvent>): AlarmEvent {
  return {
    id: 'alarm-1',
    deviceId: 'dev-1',
    channelId: 0,
    timestamp: 1_000,
    source: 'fa8',
    alarmMask: 0,
    alarmTypes: [],
    severity: 'unknown',
    acknowledged: false,
    createdAt: 1_000,
    ...overrides
  }
}

describe('模板解析：协议事实 -> 五套模板之一', () => {
  it('FA8 声纹盒 -> voiceprint，8 通道', () => {
    const profile = resolveRealtimeProfile({ deviceId: 'dev-1', kind: 'acousticBox' })
    assert.ok(profile)
    assert.equal(profile.template, 'voiceprint')
    assert.equal(profile.channelCount, 8)
    assert.ok(profile.capabilities.includes('multiChannel'))
    assert.ok(profile.capabilities.includes('voiceprint'))
  })

  it('声相机 -> PD（默认）或 Leak（显式模式），不按型号名', () => {
    const pd = resolveRealtimeProfile({ deviceId: 'cam-1', kind: 'acousticCamera' })
    assert.ok(pd)
    assert.equal(pd.template, 'acousticCameraPD')
    assert.equal(pd.mode, 'pd')
    assert.ok(pd.capabilities.includes('prpd'))
    assert.ok(!pd.capabilities.includes('leakEstimation'))

    const leak = resolveRealtimeProfile({
      deviceId: 'cam-1',
      kind: 'acousticCamera',
      cameraMode: 'leak'
    })
    assert.ok(leak)
    assert.equal(leak.template, 'acousticCameraLeak')
    assert.equal(leak.mode, 'leak')
    assert.ok(leak.capabilities.includes('leakEstimation'))
    assert.ok(!leak.capabilities.includes('prpd'))

    const toggled = withCameraMode(leak, 'pd')
    assert.equal(toggled.template, 'acousticCameraPD')
    assert.ok(toggled.capabilities.includes('prpd'))
  })

  it('空气声呐只有 e2Variant === airSonar 才解析；2023 版听诊盒与未知变体不猜', () => {
    const sonar = resolveRealtimeProfile({
      deviceId: 'sn-1',
      kind: 'auscultationBox',
      e2Variant: 'airSonar'
    })
    assert.ok(sonar)
    assert.equal(sonar.template, 'airSonar')
    assert.ok(sonar.capabilities.includes('directionFinding'))

    assert.equal(
      resolveRealtimeProfile({ deviceId: 'e2-1', kind: 'auscultationBox', e2Variant: 'auscultation' }),
      undefined,
      '2023 版听诊盒被塞进了某个模板'
    )
    assert.equal(
      resolveRealtimeProfile({ deviceId: 'e2-2', kind: 'auscultationBox' }),
      undefined,
      '还没读到变体就选模板：这是在猜'
    )
  })

  it('模板定义了 Tab 默认值与固定动作；动作按能力过滤，没有能力就不出现', () => {
    assert.equal(REALTIME_TEMPLATES.acousticCameraPD.defaultTab, 'prpd')
    assert.deepEqual(REALTIME_TEMPLATES.acousticCameraPD.tabs, [
      'prpd',
      'spectrum',
      'voiceprint',
      'waveform'
    ])
    assert.equal(REALTIME_TEMPLATES.acousticCameraLeak.defaultTab, 'spectrum')
    assert.equal(REALTIME_TEMPLATES.voiceprint.defaultTab, 'trend')
    assert.equal(REALTIME_TEMPLATES.airSonar.tabs.length, 0, '声呐中心是固定雷达，不应有 Tab')
    assert.equal(REALTIME_TEMPLATES.gasLeakMonitor.tabs.length, 0, 'WL15 中心是固定 Signal Trend')

    const sonar = resolveRealtimeProfile({
      deviceId: 'sn-1',
      kind: 'auscultationBox',
      e2Variant: 'airSonar'
    })
    assert.ok(sonar)
    assert.deepEqual(realtimeActions(sonar), ['listen', 'ptz', 'history', 'analysis', 'configuration'])

    const box = resolveRealtimeProfile({ deviceId: 'dev-1', kind: 'acousticBox' })
    assert.ok(box)
    assert.deepEqual(realtimeActions(box), ['listen', 'history', 'analysis', 'configuration'])
    assert.ok(!realtimeActions(box).includes('liveView'), 'FA8 没有实时视频能力却出现了 Live View')
  })
})

describe('数据质量与 Header 状态（规格 §4/§31）', () => {
  it('quality：新帧 GOOD、超过三个刷新周期 STALE、未来帧 INVALID、没有时间戳 NO DATA', () => {
    const now = 100_000
    assert.equal(realtimeQualityAt(now - 1_000, now), 'good')
    assert.equal(realtimeQualityAt(now - 3_400, now), 'good')
    assert.equal(realtimeQualityAt(now - 3_600, now), 'stale')
    assert.equal(realtimeQualityAt(now + 5_000, now), 'invalid')
    assert.equal(realtimeQualityAt(undefined, now), 'nodata')
    assert.equal(realtimeQualityAt(Number.NaN, now), 'nodata')
  })

  it('Header 只有一个状态，优先级 Offline > Alarm > Warning > Data Delay > Live', () => {
    const base = { deviceStatus: 'ONLINE', severity: 'normal', hasData: true, quality: 'good' } as const
    assert.equal(realtimeHeaderStatus(base), 'live')
    assert.equal(realtimeHeaderStatus({ ...base, quality: 'stale' }), 'dataDelay')
    assert.equal(realtimeHeaderStatus({ ...base, severity: 'warning' }), 'warning')
    assert.equal(realtimeHeaderStatus({ ...base, severity: 'alarm' }), 'alarm')
    assert.equal(
      realtimeHeaderStatus({ ...base, deviceStatus: 'OFFLINE', severity: 'alarm', quality: 'stale' }),
      'offline',
      '离线设备不能被读成"正在告警"'
    )
    assert.equal(
      realtimeHeaderStatus({ ...base, deviceStatus: 'UNKNOWN' }),
      'offline',
      'UNKNOWN（还没探活）不是在线'
    )
    assert.equal(
      realtimeHeaderStatus({ ...base, hasData: false, quality: 'nodata' }),
      'live',
      '从没收到过数据时不该显示 DATA DELAY（那是"曾经有、现在停了"）'
    )
  })
})

describe('Air Sonar 方向：只在告警原文里确实有数字时才存在（规格 §20/§22）', () => {
  it('数字与数字字符串都认，horizontal 归一化到 [0,360)，解析失败不猜', () => {
    assert.deepEqual(parseAirSonarDirection('{"horizontal":264,"vertical":90}'), {
      horizontal: 264,
      vertical: 90
    })
    assert.deepEqual(parseAirSonarDirection('{"horizontal":"-96","vertical":"-12"}'), {
      horizontal: 264,
      vertical: -12
    })
    assert.deepEqual(parseAirSonarDirection('{"horizontal":"abc"}'), {})
    assert.deepEqual(parseAirSonarDirection('not json'), {})
    assert.deepEqual(parseAirSonarDirection(undefined), {})
  })
})
describe('RealtimeFrame 适配层：有据可依，不用 0 填坑', () => {
  it('声相机 V1 用明确的 nodata 骨架，不编造 PRPD / 概率 / 温度', () => {
    const camera = device({ id: 'cam-1', kind: 'acousticCamera', name: 'FA371T-001' })
    const profile = resolveRealtimeProfile({ deviceId: camera.id, kind: camera.kind })
    assert.ok(profile)
    const frame = buildRealtimeFrame({ device: camera, profile, now: 10_000 })
    assert.equal(frame.primaryMetrics.length, REALTIME_KPI_LIMIT)
    for (const metric of frame.primaryMetrics) {
      assert.equal(metric.value, null, `${metric.key} 编了一个值`)
      assert.equal(metric.quality, 'nodata', `${metric.key} 不是 nodata`)
    }
    assert.deepEqual(
      frame.primaryMetrics.map((metric) => metric.key),
      ['soundEnergy', 'pdType', 'confidence', 'maxTemp']
    )
    assert.equal(frame.status.online, true)
    assert.equal(frame.status.severity, 'normal')
  })

  it('FA8：告警位决定通道红黄，七项特征顺序固定，没有实时帧的通道是 nodata', () => {
    const box = device({ id: 'dev-1', kind: 'acousticBox', name: 'FA8-001' })
    const profile = resolveRealtimeProfile({ deviceId: box.id, kind: box.kind })
    assert.ok(profile)
    const current = alarm({
      alarmMask: 0b1,
      alarmTypes: [AlarmType.SPL],
      spl: 78.2,
      smoothness: 0.42,
      severity: 'critical',
      timestamp: 50_000
    })
    const source = featureSourceOfAlarm(current)
    const frame = buildRealtimeFrame({
      device: box,
      profile,
      now: current.timestamp,
      latestAlarm: current,
      pendingAlarms: 1,
      featureSource: source,
      channelSources: { 0: source }
    })
    assert.equal(frame.status.severity, 'alarm', '未确认的 critical 告警没有让 Header 变红')
    assert.equal(frame.channels?.length, 8)
    assert.equal(frame.channels?.[0]?.status, 'alarm')
    assert.equal(frame.channels?.[1]?.status, 'nodata')
    assert.equal(frame.channels?.[1]?.spl?.value, null)
    assert.deepEqual(
      frame.details?.map((metric) => metric.key),
      [
        'spl',
        'mainFrequency',
        'bandEnergyRatio',
        'smoothness',
        'oddEvenHarmonicRatio',
        'spectralComplexity',
        'fingerprintVariation'
      ],
      'FA8 右栏七项的顺序不能按数值大小重排'
    )
    assert.equal(frame.details?.[0]?.value, 78.2)
    assert.equal(frame.details?.[3]?.value, 0.42)
  })

  it('FA8：实时测量值本身不带告警含义，偏高的 SPL 不会自己变红', () => {
    const box = device({ id: 'dev-1', kind: 'acousticBox' })
    const profile = resolveRealtimeProfile({ deviceId: box.id, kind: box.kind })
    assert.ok(profile)
    const source = {
      timestamp: 60_000,
      spl: 105,
      mainFrequency: 50,
      smoothness: 0.9,
      bandEnergyRatio: 0.3
    }
    const frame = buildRealtimeFrame({
      device: box,
      profile,
      now: source.timestamp,
      featureSource: source,
      channelSources: { 0: source }
    })
    assert.equal(frame.status.severity, 'normal')
    assert.equal(frame.channels?.[0]?.status, 'normal', '实时帧没有告警位，却把通道标红了')
    assert.equal(frame.channels?.[0]?.issues, undefined)
  })

  it('Air Sonar：Live 不显示方向；Event 才从告警原文取，并解析 CH / TDE / FDE', () => {
    const sonar = device({
      id: 'sn-1',
      kind: 'auscultationBox',
      e2Variant: 'airSonar',
      name: 'SN16-001'
    })
    const profile = resolveRealtimeProfile({
      deviceId: sonar.id,
      kind: sonar.kind,
      e2Variant: 'airSonar'
    })
    assert.ok(profile)
    const raw = JSON.stringify({
      db_value: 66.6,
      horizontal: '264',
      vertical: '90',
      max_db_chn: 13,
      max_tddr_value: 0.00043,
      max_fdr_value: 41.94
    })
    const current = alarm({
      id: 'sn-alarm',
      deviceId: sonar.id,
      source: 'e2',
      spl: 66.6,
      deviceRaw: raw,
      severity: 'critical',
      deviceReason: 'Gunshot'
    })

    const live = buildRealtimeFrame({
      device: sonar,
      profile,
      now: current.timestamp,
      latestAlarm: current,
      pendingAlarms: 1,
      mode: 'live'
    })
    assert.equal('target' in live, false, 'Live 模式伪造了方向')
    assert.equal(
      live.primaryMetrics.find((metric) => metric.key === 'maxChannel')?.value,
      'CH13'
    )
    assert.equal(live.details?.find((metric) => metric.key === 'tdeRatio')?.value, 0.00043)
    assert.equal(live.details?.find((metric) => metric.key === 'fdeRatio')?.value, 41.94)

    const event = buildRealtimeFrame({
      device: sonar,
      profile,
      now: current.timestamp,
      latestAlarm: current,
      pendingAlarms: 1,
      mode: 'event',
      event: {
        id: current.id,
        at: current.timestamp,
        severity: 'alarm',
        labelKey: 'realtimeUi.event.alarm'
      }
    })
    assert.equal(event.target?.horizontal, 264)
    assert.equal(event.target?.vertical, 90)
    assert.equal(event.event?.id, current.id)
  })

  it('缺失值构造器保留 unit 与文本占位（Air Sonar 的 EVENT NONE 不是测量值）', () => {
    const none = missingMetric('event', { textKey: 'realtimeUi.event.none' })
    assert.equal(none.value, null)
    assert.equal(none.quality, 'nodata')
    assert.equal(none.textKey, 'realtimeUi.event.none')
    const meter = missingMetric('spl', { unit: 'dB' })
    assert.equal(meter.unit, 'dB')
    assert.equal(meter.value, null)
  })
})

describe('实时工作台文案：四本目录 key 集合一致，引用的 key 都在', () => {
  it('realtimeUi 子树在四种语言里 key 完全相同，而且没有裸 @', async () => {
    const catalogues = await Promise.all([
      import('../src/shared/i18n/messages/zh-CN'),
      import('../src/shared/i18n/messages/en'),
      import('../src/shared/i18n/messages/es'),
      import('../src/shared/i18n/messages/tr')
    ]).then(([zh, en, es, tr]) => [
      zh.zhCN as Record<string, unknown>,
      en.en as Record<string, unknown>,
      es.es as Record<string, unknown>,
      tr.tr as Record<string, unknown>
    ])

    const flatten = (source: Record<string, unknown>, prefix = ''): Map<string, string> => {
      const out = new Map<string, string>()
      for (const [key, value] of Object.entries(source)) {
        const path = prefix ? `${prefix}.${key}` : key
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          for (const [nestedKey, nestedValue] of flatten(value as Record<string, unknown>, path)) {
            out.set(nestedKey, nestedValue)
          }
        } else if (typeof value === 'string') {
          out.set(path, value)
        }
      }
      return out
    }

    const reference = [...flatten(catalogues[0]!).keys()]
      .filter((key) => key.startsWith('realtimeUi.'))
      .sort()
    assert.ok(reference.length > 40, 'realtimeUi 目录小得可疑')
    for (const locale of catalogues.slice(1)) {
      const keys = [...flatten(locale).keys()].filter((key) => key.startsWith('realtimeUi.')).sort()
      assert.deepEqual(keys, reference, '四种语言的 realtimeUi key 集合不一致')
    }

    const referenced = [
      'realtimeUi.title',
      'realtimeUi.status.dataDelay',
      'realtimeUi.quality.stale',
      'realtimeUi.mode.leak',
      'realtimeUi.tabs.prpd',
      'realtimeUi.actions.configuration',
      'realtimeUi.template.airSonar',
      'realtimeUi.metric.maxSpl',
      'realtimeUi.channelStatus.nodata',
      'realtimeUi.pdClass.corona',
      /*
       * 四条局放类型都在这里：它们**不是**通过 `t('…')` 直接引用的，而是
       * `RealtimeProbabilityBars` 用 `label-key-prefix="realtimeUi.pdClass"` +
       * `:order="['corona','creepage','suspended','noise']"` 拼出来的（见下一条断言）。
       * 只钉 `corona` 的旧写法漏掉了另外三条 —— 那正是脚本会报成"没人用"的原因。
       */
      'realtimeUi.pdClass.creepage',
      'realtimeUi.pdClass.suspended',
      'realtimeUi.pdClass.noise',
      /*
       * 波形空态：这一条是 2026-09-20 修掉的真缺陷 —— 模板里写的是
       * `realtimeUi.waveformWaiting`，而四本目录里从来没有这个 key（只有
       * `waveformPending`），界面会渲染出裸 key。改成引用既有 key，并在这里钉住。
       */
      'realtimeUi.waveformPending',
      'realtimeUi.event.none',
      'realtimeUi.ptz.tracking',
      'realtimeUi.leakStatus.unknown'
    ]
    for (const locale of catalogues) {
      const messages = flatten(locale)
      for (const key of referenced) {
        const message = messages.get(key)
        assert.ok(message && message.trim() !== '', `缺少 ${key}`)
        assert.equal(message.includes('@'), false, `${key} 含裸 @`)
      }
    }
  })
})
// ---------------------------------------------------------------------------
// 声相机按需接收（2026-09-20 续）：不点「接收」绝不建设备连接
// ---------------------------------------------------------------------------

describe('声相机模板：三个 Tab 的按需接收与生命周期', () => {
  const projectRoot = path.resolve(__dirname, '..', '..')
  const read = (relative: string): string =>
    fs.readFileSync(path.join(projectRoot, relative), 'utf8')
  const stripComments = (source: string): string =>
    source
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')

  const cameraView = read('src/renderer/src/components/realtime/AcousticCameraTemplate.vue')
  const cameraCode = stripComments(cameraView)
  const monitorView = read('src/renderer/src/components/realtime/RealtimeMonitor.vue')

  it('Tab -> 通道的映射只包含已实测的三路；PRPD 不绑定任何通道', () => {
    assert.match(cameraCode, /spectrum:\s*'fftData'/, 'Spectrum 没有绑定 /fftData')
    assert.match(cameraCode, /waveform:\s*'pcmData'/, 'Waveform 没有绑定 /pcmData')
    assert.match(cameraCode, /voiceprint:\s*'voiceprintData'/, 'Voiceprint 没有绑定 /voiceprintData')
    const block = cameraCode.slice(
      cameraCode.indexOf('const KIND_BY_TAB'),
      cameraCode.indexOf('const START_KEY_BY_TAB')
    )
    assert.ok(block.length > 0, '没有 KIND_BY_TAB')
    assert.equal(/prpd\s*:/.test(block), false, 'PRPD 被随便配了一路设备通道')
  })

  it('没有自动启动：onMounted 只做状态对账与走时，start 只由点击触发', () => {
    const mounted = cameraCode.slice(
      cameraCode.indexOf('onMounted(async'),
      cameraCode.indexOf('onBeforeUnmount(()')
    )
    assert.ok(mounted.length > 0, '没有 onMounted')
    assert.equal(/camera\.start\(/.test(mounted), false, 'onMounted 里自动启动了相机流')
    assert.match(cameraCode, /@click="startReceiving\('fftData'\)"/, '频谱没有手动接收入口')
    assert.match(cameraCode, /@click="startReceiving\('pcmData'\)"/, '波形没有手动接收入口')
    assert.match(cameraCode, /@click="startReceiving\('voiceprintData'\)"/, '声纹图没有手动接收入口')
    for (const hook of ['data-camera-stream-start="spectrum"', 'data-camera-stream-start="waveform"', 'data-camera-stream-start="voiceprint"']) {
      assert.ok(cameraCode.includes(hook), `缺少稳定钩子 ${hook}`)
    }
  })

  it('接收中的连接看得见、停得掉：相位行 + 停止按钮，错误可重试', () => {
    assert.match(cameraCode, /data-camera-stream-stop/, '没有停止接收按钮')
    assert.match(cameraCode, /camera\.channelPhase/, '没有显示当前通道相位')
    assert.match(cameraCode, /data-camera-stream-error/, '错误状态没有独立标记')
    assert.match(cameraCode, /data-camera-stream-retry/, '失败后不能重试')
  })

  it('离开页面 / 换设备都收干净：stop + unsubscribe；已存在会话也接推送', () => {
    const unmount = cameraCode.slice(cameraCode.indexOf('onBeforeUnmount(()'))
    assert.match(unmount, /void camera\.stop\(\)/, '卸载时没有停主进程会话')
    assert.match(unmount, /camera\.unsubscribe\(\)/, '卸载时没有摘掉推送监听')
    assert.match(cameraCode, /camera\.subscribe\(\)/, '采纳已有会话时没有接上推送')
    assert.match(cameraCode, /watch\(\s*\(\) => props\.deviceId/, '换相机没有重新对账')
  })

  it('PRPD 仍然没有按需入口：接口没有相位数据时不许用 Spectrum 冒充', () => {
    assert.match(monitorView, /:device-id="device\.id"/, 'RealtimeMonitor 没有把相机 id 传进模板')
    assert.match(cameraCode, /data-realtime-prpd-empty/, 'PRPD 空态钩子被删了')
    assert.match(cameraCode, /realtimeUi\.prpdUnavailable/, 'PRPD 空态不再说明接口未提供')
    assert.equal(
      /KIND_BY_TAB[\s\S]{0,200}prpd/.test(cameraCode),
      false,
      'PRPD 被赋予了数据通道'
    )
  })

  it('波形空态引用的是目录里真有的 key（不再是渲染裸 key 的 waveformWaiting）', () => {
    assert.match(
      cameraCode,
      /:empty-text="t\('realtimeUi\.waveformPending'\)"/,
      '波形图的空态文案没有引用 realtimeUi.waveformPending'
    )
    assert.equal(
      cameraCode.includes('waveformWaiting'),
      false,
      'waveformWaiting 这个 key 四本目录里都不存在，写了就是渲染裸 key'
    )
  })

  it('局放概率条的「前缀 + 顺序」是同一份契约：前缀下的四条 key 都被画出来', () => {
    const prefix = cameraCode.match(/label-key-prefix="([^"]+)"/)?.[1]
    assert.equal(prefix, 'realtimeUi.pdClass', '概率条没有把 i18n 前缀传给子组件')
    const order = cameraCode.match(/:order="\[([^\]]+)\]"/)?.[1]
    assert.ok(order, '概率条没有固定顺序')
    const keys = [...order.matchAll(/'([^']+)'/g)].map((match) => match[1])
    assert.deepEqual(
      keys,
      ['corona', 'creepage', 'suspended', 'noise'],
      '局放类型顺序变了：这四条同时也是 i18n 键的名单，改名要连目录一起改'
    )
  })

  it('按需接收的新文案在四本目录里齐全', async () => {
    const catalogues = await Promise.all([
      import('../src/shared/i18n/messages/zh-CN'),
      import('../src/shared/i18n/messages/en'),
      import('../src/shared/i18n/messages/es'),
      import('../src/shared/i18n/messages/tr')
    ]).then(([zh, en, es, tr]) => [zh.zhCN, en.en, es.es, tr.tr])
    const keys = ['startSpectrum', 'startWaveform', 'startVoiceprint', 'onDemandHint']
    for (const catalogue of catalogues) {
      const block = (catalogue as { cameraStreamUi: Record<string, string> }).cameraStreamUi
      for (const key of keys) {
        assert.ok(block[key] && block[key].trim() !== '', `cameraStreamUi.${key} 缺失`)
        assert.equal(block[key].includes('@'), false, `cameraStreamUi.${key} 含裸 @`)
      }
    }
  })
})
describe('SN-16 realtime_value feeds the Air Sonar Live frame', () => {
  it('uses the callback values for MAX SPL / MAX CHANNEL / TDE / FDE and makes them stale by age', () => {
    const sonar = device({
      id: 'sn-live',
      kind: 'auscultationBox',
      e2Variant: 'airSonar',
      name: 'SN16-LIVE'
    })
    const profile = resolveRealtimeProfile({
      deviceId: sonar.id,
      kind: sonar.kind,
      e2Variant: 'airSonar'
    })
    assert.ok(profile)

    const at = 500_000
    const frame = buildRealtimeFrame({
      device: sonar,
      profile,
      now: at,
      e2Realtime: {
        maxDbChannel: 13,
        maxDbValue: 68.6,
        maxFdrValue: 41.94,
        maxTdrValue: 0.00043
      },
      e2RealtimeAt: at
    })

    assert.equal(frame.quality, 'good')
    assert.equal(frame.primaryMetrics.find((metric) => metric.key === 'maxSpl')?.value, 68.6)
    assert.equal(frame.primaryMetrics.find((metric) => metric.key === 'maxChannel')?.value, 'CH13')
    assert.equal(frame.details?.find((metric) => metric.key === 'tdeRatio')?.value, 0.00043)
    assert.equal(frame.details?.find((metric) => metric.key === 'fdeRatio')?.value, 41.94)
    assert.equal(
      frame.primaryMetrics.find((metric) => metric.key === 'maxSpl')?.quality,
      'good'
    )
    assert.equal('target' in frame, false, '实时值 callback 没有方向字段，不能伪造方向')

    const stale = buildRealtimeFrame({
      device: sonar,
      profile,
      now: at + 10_000,
      e2Realtime: { maxDbValue: 68.6, maxDbChannel: 13 },
      e2RealtimeAt: at
    })
    assert.equal(stale.quality, 'stale')
    assert.equal(stale.primaryMetrics.find((metric) => metric.key === 'maxSpl')?.quality, 'stale')
  })
})