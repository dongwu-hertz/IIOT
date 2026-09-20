/**
 * GIS 实时监测工作台的数据装配（规格 §36 的 `RealtimeMonitor` 层）。
 *
 * 它把三件事接到一起：
 *   1. `resolveRealtimeProfile()` —— 设备协议事实 -> 五套模板之一；
 *   2. 既有实时会话（`stores/monitor.ts`）—— **只对 FA8 声纹盒**开流。
 *      声相机的五路 WebSocket 太重（voiceprint 一路约 450 KB/s），
 *      空气声呐则根本没有可订的实时流（MonitorView 的注释已说明这一点），
 *      所以这两种设备在 GIS 里不自动开 socket，只消费最近告警/静态事实；
 *   3. `buildRealtimeFrame()` —— 把读数归一成 `RealtimeFrame`。
 *
 * ---------------------------------------------------------------------------
 * 为什么 FA8 只订**当前一条通道**
 * ---------------------------------------------------------------------------
 * 实测（PROTOCOL-FINDINGS 4.3）：设备一条 WebSocket 只推一路通道，8 路就是 8 条
 * 连接。GIS 页面是"速览工作台"，不是"八通道并行采集器"；一次开满 8 条会把设备
 * 与 IPC 都翻八倍，而操作员一次也只读一条。所以规则是：**当前通道实时值 + 其它
 * 通道的最后一次读数（告警/本会话曾订阅过的缓存）**；没有就是 `—`，不编。
 *
 * ---------------------------------------------------------------------------
 * 退出必须收干净
 * ---------------------------------------------------------------------------
 * 主进程的 WebSocket 不属于组件：页面卸载时 `monitor.stop()` 必须真的执行，
 * 否则用户离开 GIS 后设备还在推 8 条流，而屏幕上没有一处能停它。因此这里用
 * `onBeforeUnmount` 统一收口，而不是指望某个按钮。
 */

import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type ComputedRef,
  type Ref
} from 'vue'
import type { AlarmEvent, Device } from '@shared/domain/models'
import {
  resolveRealtimeProfile,
  type DeviceRealtimeProfile,
  type RealtimeFrame
} from '@shared/domain/realtime-monitor'
import { useDevicesStore } from '@renderer/stores/devices'
import { useMonitorStore } from '@renderer/stores/monitor'
import { useRealtimeMonitorStore } from '@renderer/stores/realtimeMonitor'
import { useE2RealtimeStore } from '@renderer/stores/e2Realtime'
import { useFa371StreamStore } from '@renderer/stores/fa371Stream'
import { i18n } from '@renderer/i18n'
import {
  buildRealtimeFrame,
  featureSourceOfAlarm,
  featureSourceOfFeature,
  realtimeEventOfAlarm,
  type FeatureSource
} from '@renderer/lib/realtimeAdapters'

export interface RealtimeMonitorFeedOptions {
  /** 当前聚焦设备；未选中时 undefined（Empty State，不默认选第一台）。 */
  device: ComputedRef<Device | undefined>
  /** 当前设备最近 20 条告警（按时间倒序）；用于 last-known 值与 Event 模式。 */
  alarms: ComputedRef<AlarmEvent[]>
  /** 未确认告警条数；-1 = 没读到（Header 不因此变红）。 */
  pendingAlarms: ComputedRef<number>
}

export interface RealtimeMonitorFeed {
  profile: ComputedRef<DeviceRealtimeProfile | undefined>
  frame: ComputedRef<RealtimeFrame | null>
  /** 主进程会话正在启动（首次切换设备的 Skeleton 判据）。 */
  starting: ComputedRef<boolean>
  error: ComputedRef<string>
  /** FA8 当前通道。 */
  selectedChannel: Ref<number>
  selectChannel: (channelIndex: number) => void
  /** FA8 趋势图数据（当前通道的 features 缓冲）。 */
  featureHistory: ComputedRef<import('@shared/domain/models').RealtimeFeature[]>
  /** FA8 频谱（当前通道）。 */
  spectrumMagnitudes: ComputedRef<number[]>
  spectrumBinHz: ComputedRef<number>
  /** 数据源状态原文（main process 会话错误等），用于 NoData/Offline 说明。 */
  sourceState: ComputedRef<string>
}

export function useRealtimeMonitorFeed(options: RealtimeMonitorFeedOptions): RealtimeMonitorFeed {
  const devices = useDevicesStore()
  const monitor = useMonitorStore()
  const realtime = useRealtimeMonitorStore()

  const selectedChannel = ref(0)
  const e2Realtime = useE2RealtimeStore()
  const cameraStream = useFa371StreamStore()

  /** 协议事实 -> 模板档案；`cameraMode` 变化会切换 PD / Leak 两套模板。 */
  const profile = computed<DeviceRealtimeProfile | undefined>(() => {
    const device = options.device.value
    if (!device) return undefined
    return resolveRealtimeProfile({
      deviceId: device.id,
      kind: device.kind,
      ...(device.e2Variant !== undefined ? { e2Variant: device.e2Variant } : {}),
      cameraMode: realtime.cameraMode
    })
  })

  const isVoiceprint = computed(() => profile.value?.template === 'voiceprint')

  /** Event 模式里用户点开的那一条告警（不在当前 20 条里时退化为 undefined）。 */
  const eventAlarm = computed<AlarmEvent | undefined>(() => {
    if (realtime.monitorMode !== 'event' || realtime.currentEventId === '') return undefined
    return options.alarms.value.find((alarm) => alarm.id === realtime.currentEventId)
  })

  /**
   * 「最近一条 + 每通道最后一条」的告警索引。
   *
   * 列表按时间倒序，所以 `Map` 第一次写入的那条就是这一通道最近的一条；
   * 不按通道排序、不取最大值 —— 时间顺序才是"最后读数"的意思。
   */
  const latestAlarmsByChannel = computed<Map<number, AlarmEvent>>(() => {
    const map = new Map<number, AlarmEvent>()
    for (const alarm of options.alarms.value) {
      if (!map.has(alarm.channelId)) map.set(alarm.channelId, alarm)
    }
    return map
  })

  /**
   * FA8 八通道的读数来源：实时缓存优先，没有则退到该通道最近一条告警。
   *
   * 告警来源只在**该通道没有实时帧**时使用。有实时帧时，实时值优先，
   * 但把告警位与等级叠加到同一对象上 —— 这样通道状态既能看到当前读数，
   * 也能显示设备真实报过的 alarm，而不会因为一个偏高读数变红（规格 §6）。
   */
  const channelSources = computed<Record<number, FeatureSource | undefined>>(() => {
    const current = profile.value
    if (!current || current.template !== 'voiceprint') return {}
    const count = current.channelCount ?? 8
    const sources: Record<number, FeatureSource | undefined> = {}
    for (let channelId = 0; channelId < count; channelId += 1) {
      const live = monitor.channelFeatureOf(channelId)
      const alarm = latestAlarmsByChannel.value.get(channelId)
      const alarmSource = alarm ? featureSourceOfAlarm(alarm) : undefined
      let source: FeatureSource | undefined
      if (live) source = featureSourceOfFeature(live)
      else if (alarmSource) source = alarmSource
      if (source && alarmSource) {
        source = {
          ...source,
          ...(alarmSource.issueKeys !== undefined ? { issueKeys: alarmSource.issueKeys } : {}),
          ...(alarmSource.severity !== undefined ? { severity: alarmSource.severity } : {})
        }
      }
      sources[channelId] = source
    }
    return sources
  })

  /** 右栏 / Event 详情看的那一条通道读数。 */
  const selectedSource = computed<FeatureSource | null>(() => {
    if (!isVoiceprint.value) return null
    return channelSources.value[selectedChannel.value] ?? null
  })

  /** 当前设备的最近一帧 SN-16 每秒实时值；其它机型恒为 undefined。 */
  const e2RealtimeEvent = computed(() => {
    const device = options.device.value
    if (!device) return undefined
    return e2Realtime.latestFor(device.id)
  })

  /** 声温成像仪红外温度预览；只有相机模板使用。 */
  const cameraInfrared = computed(() => cameraStream.infrared)

  /** 主帧。 */
  const frame = computed<RealtimeFrame | null>(() => {
    const device = options.device.value
    const current = profile.value
    if (!device || !current) return null
    const event = eventAlarm.value
    const latestAlarm = event ?? options.alarms.value[0]
    return buildRealtimeFrame({
      device,
      profile: current,
      now: realtime.now,
      mode: realtime.monitorMode,
      ...(latestAlarm ? { latestAlarm } : {}),
      pendingAlarms: options.pendingAlarms.value,
      ...(isVoiceprint.value ? { featureSource: selectedSource.value } : {}),
      ...(isVoiceprint.value ? { channelSources: channelSources.value } : {}),
      ...(event ? { event: realtimeEventOfAlarm(event) } : {}),
      ...(e2RealtimeEvent.value
        ? {
            e2Realtime: e2RealtimeEvent.value.value,
            e2RealtimeAt: e2RealtimeEvent.value.at
          }
        : {}),
      ...(cameraInfrared.value ? { infrared: cameraInfrared.value } : {})
    })
  })
  // -------------------------------------------------------------------------
  // 会话生命周期（只有 FA8 会真的开 socket）
  // -------------------------------------------------------------------------

  let sessionSeq = 0

  /**
   * 让主进程会话与"当前设备 + 当前通道"对齐。
   *
   * 三条分支都要收干净上一台：
   *   - 选中相机/声呐/未支持型号 -> 停掉可能还开着的声纹盒会话；
   *   - 离线设备 -> 不发 start（对着离线设备开流只会得到一条假错误），停掉旧会话，
   *     last-known 值仍由告警列表提供；
   *   - 在线 FA8 -> 选设备 + 起 features/spectrum 两路（音频/时频图不在 GIS 里加载）。
   */
  async function syncSession(): Promise<void> {
    const seq = (sessionSeq += 1)
    const device = options.device.value
    const current = profile.value
    if (!device || current?.template !== 'voiceprint') {
      if (monitor.isRunning) await monitor.stop()
      return
    }

    // 通道表先到手：设备的某些通道可能被明确关闭，订阅关闭通道只会得到错误。
    await devices.loadChannels(device.id)
    if (seq !== sessionSeq) return

    const channels = devices.channelsOf(device.id)
    const enabled = channels.filter((channel) => channel.enabled)
    if (enabled.length > 0 && !enabled.some((channel) => channel.channelIndex === selectedChannel.value)) {
      // 默认落到第一条启用的通道；`selectedChannel` 的 watch 会再走一遍这里。
      selectedChannel.value = enabled[0]?.channelIndex ?? 0
      return
    }

    monitor.selectDevice(device.id)
    monitor.setDeviceStatus(device.status)
    if (device.status !== 'ONLINE') {
      if (monitor.isRunning) await monitor.stop()
      return
    }

    await monitor.start(['features', 'spectrum'], selectedChannel.value)
  }

  watch(
    () =>
      [
        options.device.value?.id ?? '',
        options.device.value?.status ?? 'UNKNOWN',
        profile.value?.template ?? '',
        selectedChannel.value
      ] as const,
    () => {
      void syncSession()
    },
    { immediate: true }
  )

  function selectChannel(channelIndex: number): void {
    const next = Math.max(0, Math.trunc(channelIndex))
    if (next === selectedChannel.value) return
    selectedChannel.value = next
  }

  /*
   * 点告警进 Event 模式时，FA8 要跟着切到**这条告警所属的通道**（规格 §14/§27：
   * 点告警 = 设备选中 + 事件选中 + 数据切到那一路）。否则中间的趋势/频谱还在
   * 上一个通道上，右栏却显示事件通道，看起来像同一条告警有两个读数。
   */
  watch(eventAlarm, (alarm) => {
    if (!alarm || realtime.monitorMode !== 'event') return
    selectChannel(alarm.channelId)
  })

  onMounted(() => {
    // SN-16 每秒实时值：两个可能的持有者用引用计数共享同一条推送。
    e2Realtime.acquire()
  })

  onBeforeUnmount(() => {
    // 让还在 await 的 syncSession 失效，并把设备侧的 socket 真的关掉。
    sessionSeq += 1
    e2Realtime.release()
    void monitor.stop()
  })

  // -------------------------------------------------------------------------
  // 图表数据
  // -------------------------------------------------------------------------

  const featureHistory = computed(() => (isVoiceprint.value ? monitor.content.features : []))
  const spectrumMagnitudes = computed(() => (isVoiceprint.value ? monitor.spectrumMagnitudes : []))
  const spectrumBinHz = computed(() => monitor.content.spectrum?.binHz ?? 0)
  const starting = computed(() => monitor.state === 'starting')
  /*
   * 只把**当前声纹会话**的错误交给工作台：monitor.error 在成功 stop 后不会自动清空，
   * 切到相机/声呐时它还是上一台 FA8 的错误原文，显示出来就是张冠李戴。
   */
  const error = computed(() =>
    isVoiceprint.value && monitor.state === 'error' ? monitor.error : ''
  )
  const sourceState = computed(() => {
    const key = monitor.staleBadgeKey
    return key ? i18n.global.t(key) : ''
  })

  return {
    profile,
    frame,
    starting,
    error,
    selectedChannel,
    selectChannel,
    featureHistory,
    spectrumMagnitudes,
    spectrumBinHz,
    sourceState
  }
}