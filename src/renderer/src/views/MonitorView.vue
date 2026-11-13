<script setup lang="ts">
/**
 * Realtime monitoring (spec section 9.1) — REAL device data.
 *
 * Every value on this page comes from the monitor store, which is fed by the
 * main-process WebSocket bridges (`window.events.onMonitor*`). There is no
 * simulator, no direct HTTP call, and no device URL anywhere in this file: the
 * renderer is structurally incapable of reaching a device (CSP `connect-src 'none'`).
 *
 * TWO MEASURED FACTS THAT SHAPE THIS PAGE
 *   1. The device streams ONE channel per WebSocket connection, so switching
 *      channel is a stop/start of the whole session, not a re-render. See
 *      `selectChannel()` and PROTOCOL-FINDINGS 4.3.
 *   2. The spectrogram stream is a rendered JPEG image, not a numeric matrix,
 *      so that panel is an `<img>` sequence (SpectrogramViewer) — never ECharts.
 *
 * LIFECYCLE: this view is the only owner of the session while it is mounted, and
 * it releases BOTH halves on unmount — `stop()` closes the sockets in the main
 * process, `unsubscribe()` releases the IPC listeners and clears the buffers.
 * See the comment on `onUnmounted` below; forgetting either half is the classic
 * leak in this architecture.
 *
 * THREE DEVICE FAMILIES, THREE PANELS (业主 2026-09-17 第 5 条)
 * For an `acousticCamera` this page renders the LIVE VIDEO panel instead: the camera
 * has no channels and no `/features_stream`, so the WebSocket monitor must not be
 * pointed at it at all. The camera panel's source is a loopback HTTP URL produced by
 * the main process (`window.api.cameraLive.*`), which is the ONE network address the
 * renderer is ever allowed to load — see the CSP note in `src/renderer/index.html`.
 * For an `auscultationBox` (2023 听诊盒子 or SN-16 空气声呐) it renders the PULL panel
 * instead: its protocol is plain HTTP (`/system`, `/workmode`, the alarm log) with no
 * realtime stream we have wired up, so that branch shows the device's own parameters,
 * the alarm sync and the local recordings — and says out loud that there is no live
 * stream. Every camera/sonar branch is additive; the box behaviour is unchanged.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import type { EChartsCoreOption } from 'echarts/core'
import type { AlarmEvent, Channel, RealtimeFeature } from '@shared/domain/models'
import { CHANNEL_COUNT } from '@shared/domain/models'
import {
  trendChannelColor,
  trendDataZoom,
  trendZoomBurstExceeded,
  trendZoomIsIdentity,
  trendZoomShouldRecord
} from '@shared/domain/trend'
import {
  alarmSeverityBadgeClass,
  channelAlarmOf,
  channelIsAlarming,
  groupAlarmsByChannel,
  type ChannelAlarmSummary
} from '@shared/domain/channel-alarm'
import { decideMonitorAutoStart } from '@shared/domain/monitor-autostart'
import { isGasLeakMonitor } from '@shared/domain/gas-leak'
import type { CameraLiveState, CameraLiveStatus } from '@shared/domain/camera-live'
import type { Fa371ScanArea } from '@shared/domain/fa371'
import {
  buildCameraNvrMenu,
  cameraCaptureReadiness,
  type CameraNvrAction,
  type CameraNvrEnvironment,
  type CameraNvrMenuItem
} from '@shared/domain/camera-nvr'
import { useDevicesStore } from '@renderer/stores/devices'
import { ALL_STREAM_KINDS, useMonitorStore } from '@renderer/stores/monitor'
import { useFa371StreamStore } from '@renderer/stores/fa371Stream'
import { useAlarmLinkageStore } from '@renderer/stores/alarmLinkage'
import { useCameraWallStore } from '@renderer/stores/liveWall'
import {
  linkageDetectModeText,
  linkageDischargeText,
  linkageFrequencyValue,
  linkageIntensityValue,
  linkageSeverityOf
} from '@renderer/lib/linkageText'
import type { PendingAlarmRecord } from '@shared/ipc/contract'
import { useFa371CameraSession } from '@renderer/composables/useFa371CameraSession'
import { alarmTypeLabel, describeAlarmMask, eventSeverityLabel, streamKindLabel } from '@renderer/lib/labels'
import {
  channelActivityLabelKey,
  channelReceivesData,
  channelState,
  channelStateClass,
  channelStateHintKey,
  channelStateLabelKey,
  type ChannelState
} from '@renderer/lib/channelState'
import { channelLabel, formatBytes, formatDateTime, formatDuration, formatNumber, EMPTY_VALUE } from '@renderer/lib/format'
import {
  channelFeatureLiveness,
  channelFeatureStateLabelKey,
  type ChannelFeatureState
} from '@renderer/lib/channelFeatures'
import {
  buildChannelSeries,
  seriesSparkPath,
  toggleWatchedChannel
} from '@renderer/lib/channelSeries'
import { clampListPage, listPageCount, listPageSlice } from '@renderer/lib/listPaging'
import { DEFAULT_VOLUME_PERCENT } from '@renderer/lib/audioPreview'
import { EnvelopePlayer } from '@renderer/lib/envelopePlayer'
import {
  formatHzTick,
  spectrumMaxHz,
  spectrumPoints,
  spectrumRangeLabel
} from '@renderer/lib/spectrum'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import {
  CAMERA_DEFAULT_VOLUME,
  CAMERA_FLIP_NONE,
  cameraFlipTransform,
  loadCameraVolume,
  sanitiseCameraVolume,
  saveCameraVolume,
  type CameraFlip
} from '@renderer/lib/cameraLivePrefs'
import EmptyState from '@renderer/components/EmptyState.vue'
import AppModal from '@renderer/components/AppModal.vue'
import EChart from '@renderer/components/EChart.vue'
import StatusBadge from '@renderer/components/StatusBadge.vue'
import SpectrogramViewer from '@renderer/components/SpectrogramViewer.vue'
import AudioLevelMeter from '@renderer/components/AudioLevelMeter.vue'
import CameraAcousticPanel from '@renderer/components/CameraAcousticPanel.vue'
import CameraControlPanel from '@renderer/components/CameraControlPanel.vue'
import CameraRecorderBar from '@renderer/components/CameraRecorderBar.vue'
import VideoContextMenu from '@renderer/components/VideoContextMenu.vue'
import CameraAlarmDialog from '@renderer/components/CameraAlarmDialog.vue'
import CameraRecordingPlaybackDialog from '@renderer/components/CameraRecordingPlaybackDialog.vue'
import CameraDetectDownloadDialog from '@renderer/components/CameraDetectDownloadDialog.vue'
import MonitorRecordingTimeline from '@renderer/components/MonitorRecordingTimeline.vue'
import AuscultationPanel from '@renderer/components/AuscultationPanel.vue'
import SonarOverviewPanel from '@renderer/components/SonarOverviewPanel.vue'
import DeviceLocationMap from '@renderer/components/DeviceLocationMap.vue'
import DeviceInstallationCard from '@renderer/components/DeviceInstallationCard.vue'
import GasLeakMonitorPanel from '@renderer/components/GasLeakMonitorPanel.vue'

const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const devices = useDevicesStore()
const monitor = useMonitorStore()
/**
 * 相机告警的镜像（主进程联动引擎的待处理列表，AppShell 常驻订阅推送）。
 * 这一页只**读**它；订阅/加载在 shell 那一层已经做过，这里不再发起第二次。
 */
const linkage = useAlarmLinkageStore()

const selectedDeviceId = ref('')
const activeChannelIndex = ref(0)

/**
 * 当前 FA-371 应用模式：1=局放，2=泄漏，3=机械。
 *
 * 这里把“软件已配置模式”和“相机实际 work_mode”严格分开：
 * - cameraWorkMode / configuredCameraWorkModes：决定 PRPD / Leakage / Mechanical 显示什么；
 * - observedCameraWorkModes：只用于进入设备时做一次一致性核对。
 *
 * 相机实际值不再直接驱动界面切换。若二者不一致，弹窗提醒，直到操作员手动修改设置。
 */
type CameraDetectionMode = 1 | 2 | 3
const CAMERA_MODE_STORAGE_KEY = 'hertzinno.monitor.camera-detection-modes.v1'

function isCameraDetectionMode(value: unknown): value is CameraDetectionMode {
  return value === 1 || value === 2 || value === 3
}

function loadConfiguredCameraWorkModes(): Record<string, CameraDetectionMode> {
  try {
    const raw = window.localStorage.getItem(CAMERA_MODE_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, CameraDetectionMode] =>
        isCameraDetectionMode(entry[1])
      )
    )
  } catch {
    return {}
  }
}

const configuredCameraWorkModes = ref<Record<string, CameraDetectionMode>>(loadConfiguredCameraWorkModes())
const observedCameraWorkModes = ref<Record<string, CameraDetectionMode>>({})

/**
 * Single source of truth for which mode-specific analysis card is rendered.
 * This computed value reads ONLY the software configuration map; camera observations never
 * assign it directly, so work_mode polling/read-back cannot make PRPD appear/disappear.
 */
const cameraWorkMode = computed<CameraDetectionMode | undefined>(() => {
  const deviceId = selectedDeviceId.value
  if (deviceId === '') return undefined
  // 尚未配置过（例如首次读取 work_mode 失败）时默认按局放渲染：
  // 软件配置本来就是界面权威（见文件头），默认 1 让 PRPD 面板至少能显示数据状态，
  // 而不是永远停在"请选择检测模式"——设备真推了数据却看不到，比默认模式更误导。
  // 首次观察成功后真实值会覆盖这里（`onCameraWorkModeObserved`）。
  return configuredCameraWorkModes.value[deviceId] ?? 1
})

/**
 * 相机**实际**的 work_mode（最近一次成功读到的值）。
 *
 * 与 `cameraWorkMode` 分开：前者是设备事实，用于设备头那枚「检测模式」徽标；
 * 后者是软件配置，决定 PRPD / 泄漏 / 机械分析卡渲染什么。外部（相机 Web 界面）
 * 改了模式时，徽标会跟着变，分析卡则等操作员采用新值。
 */
const cameraActualWorkMode = computed<CameraDetectionMode | undefined>(() => {
  const deviceId = selectedDeviceId.value
  if (deviceId === '') return undefined
  return observedCameraWorkModes.value[deviceId] ?? configuredCameraWorkModes.value[deviceId]
})

const cameraModeMismatch = ref<{
  deviceId: string
  configured: CameraDetectionMode
  actual: CameraDetectionMode
} | null>(null)

/**
 * 已经由操作员关掉的那一条不一致提醒。
 *
 * 没有它，10 秒一次的模式轮询会**反复弹同一个窗**（关掉 → 下一拍又弹出），
 * 比不提醒更烦。键里带上 configured 与 actual：任一侧变了就是一条新的不一致。
 */
const dismissedCameraMismatchKey = ref('')

function cameraModeMismatchKey(
  deviceId: string,
  configured: CameraDetectionMode,
  actual: CameraDetectionMode
): string {
  return `${deviceId}:${configured}:${actual}`
}

function persistConfiguredCameraWorkModes(): void {
  try {
    window.localStorage.setItem(CAMERA_MODE_STORAGE_KEY, JSON.stringify(configuredCameraWorkModes.value))
  } catch {
    // Persistence failure must not affect realtime monitoring. The in-memory latch remains valid.
  }
}

function cameraDetectionModeText(mode: CameraDetectionMode): string {
  if (mode === 1) return t('cameraControlUi.appModePartialDischarge')
  if (mode === 2) return t('cameraControlUi.appModeGasLeak')
  return t('cameraControlUi.appModeMechanical')
}

const cameraModeMismatchTitle = computed(() => t('cameraControlUi.modeMismatchTitle'))
const cameraModeMismatchMessage = computed(() => {
  const mismatch = cameraModeMismatch.value
  if (!mismatch) return ''
  return t('cameraControlUi.modeMismatchMessage', {
    configured: cameraDetectionModeText(mismatch.configured),
    actual: cameraDetectionModeText(mismatch.actual)
  })
})

interface DetectionRegion {
  id: string
  x: number
  y: number
  width: number
  height: number
}

const regionDrawMode = ref(false)
const regionEditorOpen = ref(false)
const detectionRegions = ref<DetectionRegion[]>([])
const detectionRegionsBaseline = ref<DetectionRegion[]>([])
const regionDraft = ref<DetectionRegion | null>(null)
const detectionAreaBusy = ref(false)
const detectionAreaError = ref('')
const detectionAreaNotice = ref('')
const detectionAreaLoadedDeviceId = ref('')
let regionStart: { x: number; y: number } | null = null

function onCameraWorkModeObserved(payload: { deviceId: string; mode: number | undefined }): void {
  const { deviceId, mode } = payload
  if (!isCameraDetectionMode(mode) || deviceId === '') return
  // Ignore a late observation from the camera that was selected before the current one.
  if (deviceId !== selectedDeviceId.value) return

  observedCameraWorkModes.value = { ...observedCameraWorkModes.value, [deviceId]: mode }

  const configured = configuredCameraWorkModes.value[deviceId]
  if (!configured) {
    // First use of this camera: establish the current camera mode as the software baseline once.
    configuredCameraWorkModes.value = { ...configuredCameraWorkModes.value, [deviceId]: mode }
    persistConfiguredCameraWorkModes()
    cameraModeMismatch.value = null
    return
  }

  // The configured mode remains authoritative for the UI. The observation only decides whether
  // the mismatch dialog is needed; it never directly switches PRPD/Leakage/Mechanical.
  if (configured === mode) {
    cameraModeMismatch.value = null
    dismissedCameraMismatchKey.value = ''
    return
  }
  const key = cameraModeMismatchKey(deviceId, configured, mode)
  if (dismissedCameraMismatchKey.value === key) return
  cameraModeMismatch.value = { deviceId, configured, actual: mode }
}

function onCameraWorkModeChange(payload: { deviceId: string; mode: number | undefined }): void {
  const { deviceId, mode } = payload
  if (!isCameraDetectionMode(mode) || deviceId === '') return
  if (deviceId !== selectedDeviceId.value) return

  configuredCameraWorkModes.value = { ...configuredCameraWorkModes.value, [deviceId]: mode }
  observedCameraWorkModes.value = { ...observedCameraWorkModes.value, [deviceId]: mode }
  persistConfiguredCameraWorkModes()
  cameraModeMismatch.value = null
  dismissedCameraMismatchKey.value = ''
}

function closeCameraModeMismatch(): void {
  const mismatch = cameraModeMismatch.value
  if (mismatch) {
    dismissedCameraMismatchKey.value = cameraModeMismatchKey(
      mismatch.deviceId,
      mismatch.configured,
      mismatch.actual
    )
  }
  cameraModeMismatch.value = null
}

/**
 * 采用相机当前模式：把软件配置切到设备事实，分析卡随之切换。
 *
 * 这是操作员在「检测模式不一致」弹窗里的**一键同步**入口；它不写设备（设备已经
 * 在这个模式上），只更新软件侧配置并持久化。
 */
function adoptCameraWorkMode(): void {
  const mismatch = cameraModeMismatch.value
  if (!mismatch) return
  configuredCameraWorkModes.value = {
    ...configuredCameraWorkModes.value,
    [mismatch.deviceId]: mismatch.actual
  }
  observedCameraWorkModes.value = {
    ...observedCameraWorkModes.value,
    [mismatch.deviceId]: mismatch.actual
  }
  persistConfiguredCameraWorkModes()
  dismissedCameraMismatchKey.value = ''
  cameraModeMismatch.value = null
}

function normalisedStagePoint(event: PointerEvent): { x: number; y: number } | null {
  const stage = stageEl.value
  if (!stage) return null
  const rect = stage.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  return {
    x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
  }
}

function beginDetectionRegion(event: PointerEvent): void {
  if (!regionDrawMode.value) return
  const point = normalisedStagePoint(event)
  if (!point) return
  event.preventDefault()
  regionStart = point
  regionDraft.value = { id: 'draft', x: point.x, y: point.y, width: 0, height: 0 }
  stageEl.value?.setPointerCapture?.(event.pointerId)
}

function updateDetectionRegion(event: PointerEvent): void {
  if (!regionDrawMode.value || !regionStart || !regionDraft.value) return
  const point = normalisedStagePoint(event)
  if (!point) return
  const x = Math.min(regionStart.x, point.x)
  const y = Math.min(regionStart.y, point.y)
  regionDraft.value = {
    id: 'draft',
    x,
    y,
    width: Math.abs(point.x - regionStart.x),
    height: Math.abs(point.y - regionStart.y)
  }
}

function finishDetectionRegion(event: PointerEvent): void {
  if (!regionStart || !regionDraft.value) return
  updateDetectionRegion(event)
  const draft = regionDraft.value
  if (draft.width >= 0.015 && draft.height >= 0.015) {
    detectionRegions.value.push({ ...draft, id: `region-${Date.now()}-${detectionRegions.value.length + 1}` })
  }
  regionStart = null
  regionDraft.value = null
  stageEl.value?.releasePointerCapture?.(event.pointerId)
}

function scanAreaReferenceSize(): { width: number; height: number } {
  const video = videoEl.value
  const width = video?.videoWidth && video.videoWidth > 0 ? video.videoWidth : 1920
  const height = video?.videoHeight && video.videoHeight > 0 ? video.videoHeight : 1080
  return { width, height }
}

function scanAreaToRegions(area: Fa371ScanArea): DetectionRegion[] {
  const { width, height } = scanAreaReferenceSize()
  return area.areas
    .filter((item) => item.drawStatus !== 0)
    .flatMap((item, index) => {
      if (
        item.leftTopX === undefined || item.leftTopY === undefined ||
        item.width === undefined || item.height === undefined
      ) return []
      return [{
        id: `device-region-${index + 1}`,
        x: Math.min(1, Math.max(0, item.leftTopX / width)),
        y: Math.min(1, Math.max(0, item.leftTopY / height)),
        width: Math.min(1, Math.max(0, item.width / width)),
        height: Math.min(1, Math.max(0, item.height / height))
      }]
    })
}

function regionsToScanArea(): Fa371ScanArea {
  const { width, height } = scanAreaReferenceSize()
  /**
   * 业主 2026-09-23：没有绘制任何告警区域时**默认全画面告警**——写一个覆盖
   * 整帧的区域，而不是把空数组交给设备（空数组在设备侧是"没有任何告警区域"
   * 还是"全画面"，手册没有定义，不能赌）。
   */
  const areas = detectionRegions.value.length > 0
    ? detectionRegions.value.map((region) => ({
        height: Math.round(region.height * height),
        width: Math.round(region.width * width),
        drawStatus: 1,
        leftTopX: Math.round(region.x * width),
        leftTopY: Math.round(region.y * height)
      }))
    : [{ height, width, drawStatus: 1, leftTopX: 0, leftTopY: 0 }]
  return {
    centerFocusCode: 2,
    coordinateSpace: 'pixel_video_frame',
    areas
  }
}

async function loadDetectionRegions(): Promise<void> {
  const deviceId = selectedDeviceId.value
  if (!deviceId || !isCamera.value || detectionAreaBusy.value) return
  detectionAreaBusy.value = true
  detectionAreaError.value = ''
  try {
    const result = await callApi(() => window.api.cameraControl.readScanArea(deviceId))
    if (!result.success) {
      detectionAreaError.value = resultMessage(result)
      return
    }
    const area = unwrap(result)
    detectionRegions.value = area ? scanAreaToRegions(area) : []
    detectionAreaLoadedDeviceId.value = deviceId
    detectionAreaNotice.value = ''
  } finally {
    detectionAreaBusy.value = false
  }
}

async function applyDetectionRegions(): Promise<boolean> {
  const deviceId = selectedDeviceId.value
  if (!deviceId || detectionAreaBusy.value) return false
  detectionAreaBusy.value = true
  detectionAreaError.value = ''
  detectionAreaNotice.value = ''
  try {
    const result = await callApi(() => window.api.cameraControl.writeScanArea(deviceId, regionsToScanArea()))
    if (!result.success) {
      detectionAreaError.value = resultMessage(result)
      return false
    }
    const write = unwrap(result)
    if (!write) return false
    detectionRegions.value = scanAreaToRegions(write.after)
    detectionAreaNotice.value = write.applied
      ? t('cameraAlarmUi.regionSaved')
      : t('cameraAlarmUi.regionNotApplied')
    return write.applied === true
  } finally {
    detectionAreaBusy.value = false
  }
}

function toggleRegionDrawMode(): void {
  regionEditorOpen.value = true
  regionDrawMode.value = !regionDrawMode.value
  regionStart = null
  regionDraft.value = null
}

async function openAlarmRegionConfiguration(): Promise<void> {
  // Reuse the PRIMARY live video instead of opening a second <video>. The RTSP loopback session
  // has one viewer, so the old Alarm dialog could replace the monitor viewer and leave this page
  // showing "video unavailable" until it reconnected. Editing in-place removes that race.
  if (!cameraActive.value && !cameraBusy.value) await startCameraLive()
  regionEditorOpen.value = true
  regionDrawMode.value = false
  regionStart = null
  regionDraft.value = null
  detectionAreaError.value = ''
  detectionAreaNotice.value = ''
  if (detectionAreaLoadedDeviceId.value !== selectedDeviceId.value) await loadDetectionRegions()
  detectionRegionsBaseline.value = detectionRegions.value.map((region) => ({ ...region }))
}

function cancelAlarmRegionConfiguration(): void {
  detectionRegions.value = detectionRegionsBaseline.value.map((region) => ({ ...region }))
  regionEditorOpen.value = false
  regionDrawMode.value = false
  regionStart = null
  regionDraft.value = null
  detectionAreaError.value = ''
  detectionAreaNotice.value = ''
}

async function saveAlarmRegionConfiguration(): Promise<void> {
  const applied = await applyDetectionRegions()
  if (!applied) return
  detectionRegionsBaseline.value = detectionRegions.value.map((region) => ({ ...region }))
  regionEditorOpen.value = false
  regionDrawMode.value = false
  regionStart = null
  regionDraft.value = null
}

function clearDetectionRegions(): void {
  detectionRegions.value = []
  regionDraft.value = null
  regionStart = null
  // 清除后保持框选状态：操作员的下一个动作几乎一定是重画，少一次点击。
  regionDrawMode.value = true
  detectionAreaNotice.value = t('cameraAlarmUi.regionCleared')
}
/** Real sample rate, read through the config API (never guessed locally). */
const sampleRate = ref<number | null>(null)

const selectedDevice = computed(() => devices.byId(selectedDeviceId.value))

/**
 * 把"选中那台设备在不在线"告诉监测 store（业主第 18 条：没有活数据时要说得清是哪一台 IP）。
 *
 * store 不持有设备列表（与画面墙同一条做法：谁有列表谁传进来），所以这条同步必须显式做。
 * `undefined`（没有选中设备）也照传：那是"没有设备"那一档，不是"离线"。
 */
watch(
  selectedDevice,
  (device) => monitor.setDeviceStatus(device?.status),
  { immediate: true }
)

/** Channels reported by the device; falls back to the fixed 0-7 index range. */
const channels = computed<Channel[]>(() => devices.channelsOf(selectedDeviceId.value))

interface ChannelTab {
  index: number
  label: string
  name: string
  /** 通道状态：未启用的通道要变灰且不可选，未知状态不能被当成已启用。 */
  state: ChannelState
}

const channelTabs = computed<ChannelTab[]>(() => {
  if (channels.value.length > 0) {
    return [...channels.value]
      .sort((a, b) => a.channelIndex - b.channelIndex)
      .map((channel) => ({
        index: channel.channelIndex,
        label: channelLabel(channel.channelIndex),
        name: channel.channelName || '',
        state: channelState(channel)
      }))
  }
  // 设备还没返回通道表：这一路的状态是“未知”而不是“已启用”，
  // 否则一台从未查询成功的设备会看起来一切正常（见 lib/channelState.ts）。
  return Array.from({ length: CHANNEL_COUNT }, (_, index) => ({
    index,
    label: channelLabel(index),
    name: '',
    state: 'unknown'
  }))
})

/**
 * 未开启的通道不参与选择：按钮本身禁用，处理器里再守一次。
 *
 * 参数故意只要求 `state`：通道页签与 ② 的通道卡片是同一件事的两种粒度，
 * 两者都走这一个判定（多写一份"什么算禁用"迟早会不一致）。
 */
function isTabDisabled(tab: { state: ChannelState }): boolean {
  return tab.state === 'disabled'
}

/** 灰色通道的悬停/读屏解释；已启用时返回空串，模板用 `|| undefined` 去掉 title。 */
function tabHint(tab: { state: ChannelState }): string {
  const key = channelStateHintKey(tab.state)
  return key ? t(key) : ''
}

/**
 * 通道按钮的读屏名称。
 *
 * 光念“CH3”无法告诉屏幕阅读器这一路是关掉的，所以状态必须进入无障碍名称；
 * 状态文本来自目录，本文件不持有任何语言的字面量。
 */
function tabAriaLabel(tab: ChannelTab): string {
  const parts = [tab.label]
  if (tab.name) parts.push(tab.name)
  parts.push(t(channelStateLabelKey(tab.state)))
  return parts.join(' ')
}

/**
 * 该通道此刻是否真的在产出数据 —— 与 `enabled` 无关的第二个事实。
 *
 * 只看运行中的会话：帧计数属于当前订阅的那一路，所以还要比对 `channelId`，
 * 否则切换通道的瞬间会把上一路的帧数算到新通道头上。
 */
function tabReceivesData(tab: ChannelTab): boolean {
  return channelReceivesData({
    isActiveChannel: tab.index === activeChannelIndex.value && tab.index === monitor.channelId,
    sessionRunning: monitor.state === 'running',
    frameCount: monitor.frameCountOf('features')
  })
}

/** 实时数据指示灯的文案（目录 key 由 channelState 模块给出）。 */
function tabActivityLabel(tab: ChannelTab): string {
  return t(channelActivityLabelKey(tabReceivesData(tab)))
}

/**
 * 初始通道：优先第一路“没有被明确关闭”的通道。
 *
 * 设备把通道表交回来之后就应当避开关闭的通道，否则一进页面就会给一路没启用的
 * 传感器建数据流。全部关闭时保持 0 —— 是否真的建立连接由主进程决定，UI 不替它下结论。
 */
function preferredChannelIndex(deviceId: string): number {
  const first = [...devices.channelsOf(deviceId)]
    .sort((a, b) => a.channelIndex - b.channelIndex)
    .find((channel) => channelState(channel) !== 'disabled')
  return first?.channelIndex ?? 0
}

const latest = computed(() => monitor.latest)

/** Extended metrics are optional in the domain model: render only when present. */
const extendedMetrics = computed(() => {
  const frame = latest.value
  if (!frame) return []
  const metrics: Array<{ key: string; label: string; value: number | undefined }> = [
    { key: 'oddEven', label: t('metrics.oddEvenHarmonicRatio'), value: frame.oddEvenHarmonicRatio },
    { key: 'complexity', label: t('metrics.spectralComplexity'), value: frame.spectralComplexity },
    { key: 'variation', label: t('metrics.fingerprintVariation'), value: frame.fingerprintVariation }
  ]
  return metrics.filter((metric) => metric.value !== undefined)
})

const isLive = computed(() => monitor.state === 'running' || monitor.state === 'starting')

/** 实时数据指示灯只画在正在监测的那一路上，且会话已经启动。 */
function showActivity(tab: ChannelTab): boolean {
  return tab.index === activeChannelIndex.value && isLive.value
}

// ---------------------------------------------------------------------------
// ② 每通道声纹特性卡片 + 音频回放（业主 2026-09-17）
// ---------------------------------------------------------------------------

/**
 * 每一路一行：**该路最后一次读到的**声纹特性 + 这一路有没有告警。
 *
 * 为什么是"最后一次"而不是"此刻"：设备一次只在一路通道上开流（PROTOCOL-FINDINGS 4.3），
 * 切到别的通道之后这一路就没有帧了。三种读数状态在行里分开写（`channelFeatures.ts`）：
 * 实时 / 最后一次读数（带时间）/ 未读取 —— 把"旧读数"画成"实时"比不显示更糟。
 *
 * 这个 computed 只做**取数**，状态判定全部走可单测的纯函数
 * （`channelFeatureState()` 与 `@shared/domain/channel-alarm.ts`）。
 */
interface ChannelFeatureRow {
  index: number
  label: string
  name: string
  /** 通道配置状态（开启/关闭/未知）——与上面的"读数状态"是两件事。 */
  state: ChannelState
  feature: RealtimeFeature | null
  featureState: ChannelFeatureState
  /** 这一路在这批最近告警里的小结；没有就是 `null`（详情按钮不出现）。 */
  alarm: ChannelAlarmSummary | null
  /** **还有没确认的**才算告警（判据在 `channel-alarm.ts`，已确认的不再标红）。 */
  alarming: boolean
}

const channelFeatureRows = computed<ChannelFeatureRow[]>(() =>
  channelTabs.value.map((tab) => {
    const feature = monitor.channelFeatureOf(tab.index)
    const alarm = channelAlarmOf(alarmsByChannel.value, tab.index)
    return {
      index: tab.index,
      label: tab.label,
      name: tab.name,
      state: tab.state,
      feature,
      /*
       * 读数状态：口径是**新鲜度**（`channelFeatureLiveness`）。
       *
       * 2026-09-24 多通道订阅之前，只有操作员点着的那一路才可能实时，所以判据里带着
       * "是不是当前通道"。现在勾选的每一路各有一条连接，任何一路只要帧在进来就是实时的
       * —— 继续用"我点着它"当判据会把一路正在更新的通道写成"最后一次读数"。
       * 反过来这一条也更严："我请求了它"不说明设备在推，"5 秒内到过帧"才说明。
       */
      featureState: channelFeatureLiveness({
        sessionRunning: monitor.state === 'running',
        hasFeature: feature !== null,
        ageMs: feature ? monitor.now - feature.timestamp : null
      }),
      alarm,
      alarming: channelIsAlarming(alarm)
    }
  })
)

/** 读数的时间（本地时间，秒级就够：帧率是 10 Hz 量级，不是毫秒级的判断依据）。 */
function featureTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString()
}

/**
 * 特性表翻页（业主 2026-09-21 第二批第 22 条）：每页 4 行，8 通道 = 2 页。
 *
 * 页码是坏值的常态（通道数从 8 掉到 3 时页码可能还停在 2），所以渲染层**一律先夹一遍**
 * 再读 —— 纯函数在 `lib/listPaging.ts`（与设备地图同一套），这里不存"夹过的页"，
 * 存操作员按的那一页（`channelFeaturePage`）。
 */
const CHANNEL_FEATURE_PAGE_SIZE = 4

const channelFeaturePage = ref(1)

const channelFeaturePageCount = computed(() =>
  listPageCount(channelFeatureRows.value.length, CHANNEL_FEATURE_PAGE_SIZE)
)

/** 夹进 1..pageCount 之后的当前页（越界页码显示为末页，而不是一张空表）。 */
const clampedChannelFeaturePage = computed(() =>
  clampListPage(channelFeaturePage.value, channelFeatureRows.value.length, CHANNEL_FEATURE_PAGE_SIZE)
)

const pagedChannelFeatureRows = computed<ChannelFeatureRow[]>(() =>
  listPageSlice(channelFeatureRows.value, channelFeaturePage.value, CHANNEL_FEATURE_PAGE_SIZE)
)

/** 翻页条的范围文案（1-based；末页不满 4 行时 end 按实际行数算，不写 4 的倍数）。 */
const channelFeatureRange = computed(() => {
  const start = (clampedChannelFeaturePage.value - 1) * CHANNEL_FEATURE_PAGE_SIZE + 1
  const end = start + pagedChannelFeatureRows.value.length - 1
  return { start, end, total: channelFeatureRows.value.length }
})

// ---------------------------------------------------------------------------
// ③ 「点击告警则显示详细的告警状态」（业主 2026-09-19 第 13 批第 3 条）
// ---------------------------------------------------------------------------

/**
 * 详情弹窗对哪一路打开；`null` = 关着。
 *
 * 存**通道号**而不是那一行对象：告警列表会随每次读库变（这一页在读设备的时候会重读一次），
 * 存对象的话弹窗里显示的是"打开那一刻的那一份"，与表里那一列可能不一致。
 */
const channelAlarmDetail = ref<number | null>(null)

/** 弹窗打开时那一路的读数行（通道不存在或列表刚清空时是 `undefined`）。 */
const channelAlarmDetailRow = computed(() =>
  channelFeatureRows.value.find((row) => row.index === channelAlarmDetail.value)
)

/**
 * 弹窗里那一路的**全部**（这一批查询里的）告警，最近的在最前。
 *
 * 与表里那一列同源（`deviceAlarms`），所以"表里说 3 条、点开只有 1 条"不可能发生。
 * 排序在这里做一次：`alarms.query` 今天按时间倒序返回，但界面不该依赖上游的排序。
 */
const channelAlarmDetailItems = computed<AlarmEvent[]>(() => {
  const index = channelAlarmDetail.value
  if (index === null) return []
  return deviceAlarms.value
    .filter((alarm) => alarm.channelId === index)
    .slice()
    .sort((a, b) => b.timestamp - a.timestamp)
})

function openChannelAlarmDetail(index: number): void {
  channelAlarmDetail.value = index
}

function closeChannelAlarmDetail(): void {
  channelAlarmDetail.value = null
}

/** 详情里那一行的故障类型文本（复用告警中心同一套解码，不另写一份）。 */
function alarmTypesText(alarm: AlarmEvent): string {
  // 位图 > 0 时走 `describeAlarmMask`：它会把"设备设了一个本版本不认识的位"如实说出来，
  // 这比空列表诚实（听诊盒子族的位图恒为 0，那种情况由 `deviceReason` 说）。
  if (alarm.alarmMask > 0) return describeAlarmMask(alarm.alarmMask)
  if (alarm.alarmTypes.length > 0) return alarm.alarmTypes.map(alarmTypeLabel).join(' + ')
  return t('alarms.none')
}

/**
 * 声学预览回放（② 的「音频播放按钮 + 音量」，第 21 条起收进声学波形卡的头部按钮）。
 *
 * 播放的是**包络预览**而不是原声：跨 IPC 过来的是 100 ms 一帧的降采样波形
 * （`AudioFrameEvent.waveform`），详见 `lib/audioPreview.ts` 的文件头。页面上那句
 * 说明（`monitorUi.audioPreviewHint`）按业主 2026-09-21 第二批第 21 条删掉了 ——
 * 「播放的是什么」由波形图本身与波形卡头部那颗按钮的 tooltip 回答。
 *
 * 播放器按组件创建（不是模块级）：离开页面时 `close()` 会真的释放 AudioContext，
 * 模块级实例会让它活到窗口关闭为止。
 */
const audioPlayer = new EnvelopePlayer()
const audioEnabled = ref(false)
const audioError = ref('')
const volumePercent = ref(DEFAULT_VOLUME_PERCENT)

/** 有预览帧才能按：按下去什么都不会发生的按钮比禁用更糟。 */
const canPlayAudio = computed(() => monitor.content.audio !== null)

function onVolumeInput(event: Event): void {
  const raw = Number((event.target as HTMLInputElement).value)
  const next = Number.isFinite(raw)
    ? Math.min(100, Math.max(0, Math.round(raw)))
    : DEFAULT_VOLUME_PERCENT
  volumePercent.value = next
  audioPlayer.setVolume(next)
}

/**
 * 音量浮层（第 21 条）：点音量图标在按钮下方弹出迷你滑杆，点浮层与按钮**以外**收起。
 *
 * 交互照画面墙那一颗的简化版（没有"唯一出声格"的概念，这里只有一个播放器）：
 * `mousedown` 捕获阶段挂在 document 上，触发按钮与浮层本身不算「外面」——
 * 算的话"再点一次收起"会变成"先关再开"。
 */
const volumePopoverOpen = ref(false)

function onVolumePopoverDocMouseDown(event: MouseEvent): void {
  const target = event.target
  if (target instanceof Element && target.closest('[data-waveform-volume-trigger]')) return
  if (target instanceof Element && target.closest('[data-waveform-volume-pop]')) return
  volumePopoverOpen.value = false
}

watch(volumePopoverOpen, (open) => {
  if (!open) {
    document.removeEventListener('mousedown', onVolumePopoverDocMouseDown, true)
    return
  }
  document.addEventListener('mousedown', onVolumePopoverDocMouseDown, true)
})

async function toggleAudio(): Promise<void> {
  audioError.value = ''
  if (audioEnabled.value) {
    audioEnabled.value = false
    await audioPlayer.suspend()
    return
  }
  try {
    // 先把音量推给播放器再起播：否则"先调音量、再按播放"会被回退成默认音量。
    audioPlayer.setVolume(volumePercent.value)
    await audioPlayer.resume()
    audioEnabled.value = true
  } catch (cause) {
    // 自动播放策略或没有输出设备：说实话，不要显示成"正在播放"。
    audioEnabled.value = false
    audioError.value = cause instanceof Error ? cause.message : String(cause)
  }
}

/** 切到相机分支时收声：那一支的画面与这一支的音频不该同时在响。 */
async function stopBoxAudio(): Promise<void> {
  if (!audioEnabled.value) return
  audioEnabled.value = false
  await audioPlayer.suspend()
}

watch(
  () => monitor.content.audio?.timestamp,
  () => {
    const frame = monitor.content.audio
    if (audioEnabled.value && frame) audioPlayer.push(frame.waveform, frame.frameMs)
  }
)

// ---------------------------------------------------------------------------
// 流失败的一句话（原来的「数据流状态」卡片被删了，失败不能因此变哑）
// ---------------------------------------------------------------------------

/**
 * 有哪一路坏了、最近一条错误是什么；没有失败就返回空串。
 *
 * 那四路各自的指示灯（"哪一路坏了"）是原来那张卡片**真正的价值** —— 所以卡片删掉之后
 * 这个信息必须留下来，只是压成一句话：全局状态说"断开"，而现实里常见的是特征流好着、
 * 时频图那一路一直在失败（或者反过来）。
 */
const streamFailure = computed(() => {
  for (const kind of ALL_STREAM_KINDS) {
    const status = monitor.statusOf(kind)
    if (!status || status.state !== 'ERROR') continue
    const detail = status.lastError ? `：${status.lastError}` : ''
    return `${t('monitorUi.streamFailure', { name: streamKindLabel(kind) })}${detail}`
  }
  return ''
})

// ---------------------------------------------------------------------------
// Chart options
// ---------------------------------------------------------------------------

const AXIS_LINE = '#E5E7EB'
const SPLIT_LINE = '#F1F1F2'
const TEXT_SECONDARY = '#6B7280'

/**
 * Chart metric definitions.
 *
 * `labelKey` rather than a rendered label: ECharts options are rebuilt whenever
 * this computed re-evaluates, so storing the KEY is what makes the axis name and
 * tooltip follow a language change.
 */
const TREND_METRICS = [
  { key: 'spl', labelKey: 'metrics.spl', unit: 'dB', color: '#FF6A1A' },
  { key: 'mainFrequency', labelKey: 'metrics.mainFrequency', unit: 'Hz', color: '#0F766E' },
  { key: 'smoothness', labelKey: 'metrics.smoothness', unit: '', color: '#6B7280' },
  { key: 'bandEnergyRatio', labelKey: 'metrics.bandEnergyRatio', unit: '', color: '#4338CA' }
] as const

type TrendMetricKey = (typeof TREND_METRICS)[number]['key']

const trendMetric = ref<TrendMetricKey>('spl')
const activeTrendMetric = computed(
  () => TREND_METRICS.find((metric) => metric.key === trendMetric.value) ?? TREND_METRICS[0]
)

function timeLabel(epochMs: number): string {
  const date = new Date(epochMs)
  const pad = (value: number): string => value.toString().padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

// ---------------------------------------------------------------------------
// Item 16（业主 2026-09-21 第二批）：趋势图 X 轴缩放/平移
// ---------------------------------------------------------------------------

/**
 * 趋势图的缩放窗口（百分比，`null` = 整段）。
 *
 * 回声防护**照抄** TrendsView 那一套（教训钉在 `tests/trend-zoom-export.test.ts` 第 36 轮）：
 * 我们写进选项的窗口，ECharts 应用之后会**再发一次** `dataZoom`（形状与用户缩放一模一样），
 * 于是"事件 → 改状态 → 重算选项 → `setOption(option, true)` → 事件"会一直转，一个核占满、
 * 定时器饿死、`executeJavaScript` 再不 settle。真正的判据是**来源**：`EChart.vue` 在图上
 * 捕获滚轮/按下，一次手势只让**一条**事件带 `userDriven: true` —— 所以
 * `onTrendZoom()` 的第一道闸门就是 `userDriven !== true` 一律丢。
 *
 * 下面三个**必须是普通变量**（不是 `ref`）：它们在 `setOption` 引起的回声事件里被写，
 * 放进 `ref` 会自己触发重渲染，反而多一条环（同一文件头注释里记过的第二条环）。
 */
let trendZoomWrittenAt = 0
let trendZoomWriteTarget: { start: number; end: number } | null = null
const trendZoomAcceptedAt: number[] = []
const trendZoom = ref<{ start: number; end: number } | null>(null)

function onTrendZoom(window: {
  start: number
  end: number
  startValue: number | null
  endValue: number | null
  userDriven?: boolean
}): void {
  // 第一道闸门：只有**用户手势**引起的缩放才记状态（回声永远不可能是用户驱动的）。
  if (window.userDriven !== true) return
  const msSinceWrite = Date.now() - trendZoomWrittenAt
  // 第二道：与最后写进选项的窗口相同、或"刚写过选项"的抑制窗口之内 → 都是回声。
  if (!trendZoomShouldRecord(trendZoom.value, window, msSinceWrite, trendZoomWriteTarget)) return
  // 安全阀：2 秒内接受太多次就不再接受 —— 任何残余的反馈环最多转这么多圈。
  if (trendZoomBurstExceeded(trendZoomAcceptedAt, Date.now())) {
    // 开发/诊断用的一句（**不是界面文案**，所以不走四语言目录：i18n 扫描器只允许英文）。
    console.warn('[monitor] dataZoom events too dense; ignoring further ones (feedback loop?)')
    return
  }
  const next = trendZoomIsIdentity(window.start, window.end)
    ? null
    : { start: window.start, end: window.end }
  trendZoom.value = next
  // 记下"刚刚写过选项"的时刻与目标窗口：接下来那些 `dataZoom` 都是回声。
  trendZoomWrittenAt = Date.now()
  trendZoomWriteTarget = next
  // 安全阀用的是"最近 2 秒内的接受时刻"：先丢掉窗口外的旧记录再记下这一次。
  for (let index = trendZoomAcceptedAt.length - 1; index >= 0; index -= 1) {
    if (Date.now() - (trendZoomAcceptedAt[index] as number) >= 2_000) {
      trendZoomAcceptedAt.splice(index, 1)
    }
  }
  trendZoomAcceptedAt.push(Date.now())
}

const trendOption = computed<EChartsCoreOption>(() => {
  const frames = monitor.content.features
  const metric = activeTrendMetric.value
  return {
    animation: false,
    // 底边给 dataZoom 的 slider 留位置（`trendDataZoom()` 里那条高 18、贴底 4）。
    grid: { left: 46, right: 16, top: 24, bottom: 52 },
    /*
     * X 轴缩放/平移（Item 16：滚轮缩放 + 拖拽平移 + 底部范围条）。窗口**写进选项** ——
     * `setOption(option, true)` 会丢掉 ECharts 自己记的缩放，不写进去每次重画都回整段。
     * 只开 X：配置里不配 `yAxisIndex`（默认只控类目轴），不设 `zoomLock`。
     */
    dataZoom: trendDataZoom(trendZoom.value ?? undefined),
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: frames.map((frame) => timeLabel(frame.timestamp)),
      axisLine: { lineStyle: { color: AXIS_LINE } },
      axisLabel: { color: TEXT_SECONDARY, fontSize: 10, hideOverlap: true }
    },
    yAxis: {
      type: 'value',
      name: metric.unit,
      scale: true,
      nameTextStyle: { color: TEXT_SECONDARY, fontSize: 10 },
      axisLine: { show: false },
      axisLabel: { color: TEXT_SECONDARY, fontSize: 10 },
      splitLine: { lineStyle: { color: SPLIT_LINE } }
    },
    series: [
      {
        name: t(metric.labelKey),
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: frames.map((frame) => frame[metric.key]),
        lineStyle: { width: 1.6, color: metric.color },
        itemStyle: { color: metric.color },
        areaStyle: { color: metric.color, opacity: 0.08 }
      }
    ]
  }
})

// ---------------------------------------------------------------------------
// Item 20（业主 2026-09-21 第二批）：趋势卡右侧"当前值"四行
// ---------------------------------------------------------------------------

/**
 * 右侧纵列的四个主行：声压级 / 主频 / 频带能量比 / 平稳度（业主点名的顺序）。
 *
 * 值取 `monitor.latest`（features 的最后一帧，即当前订阅那一路此刻的最新读数）；
 * 没有数据渲染 `—`（模板里判 `undefined`），不写 0 —— 空格会被读成 0。
 * 原先底下那四张 MetricCard 已按 Item 20 删除：同一个事实不画两遍。
 */
const trendStatRows = computed(() => {
  const frame = latest.value
  return [
    { key: 'spl', labelKey: 'metrics.spl' as const, unit: 'dB', value: frame?.spl, precision: 2 },
    {
      key: 'mainFrequency',
      labelKey: 'metrics.mainFrequency' as const,
      unit: 'Hz',
      value: frame?.mainFrequency,
      precision: 2
    },
    {
      key: 'bandEnergyRatio',
      labelKey: 'metrics.bandEnergyRatio' as const,
      unit: '',
      value: frame?.bandEnergyRatio,
      precision: 3
    },
    {
      key: 'smoothness',
      labelKey: 'metrics.smoothness' as const,
      unit: '',
      value: frame?.smoothness,
      precision: 3
    }
  ]
})

// ---------------------------------------------------------------------------
// Item 24（业主 2026-09-21 第二批）：检测模式 —— 四张图卡 × 8 通道同坐标
// ---------------------------------------------------------------------------

/**
 * 检测模式的视图选择：单通道（默认，原有四张图谱卡）/ 检测（2×2 四张指标卡）。
 *
 * 只记在组件 `ref`（业主明确要求**不持久化**）：这是一块"怎么看"的开关，
 * 不是"设备是什么"的状态，离开页面回到默认正是预期行为。
 */
const viewMode = ref<'single' | 'detect'>('single')

/**
 * 检测模式的四张卡（业主点名的四行与顺序）：声压级 / 平稳度 / 能量比 / 主频。
 *
 * 与 `TREND_METRICS` 是两张表：那张带单通道趋势图的**配色**（每张卡一条线），
 * 这张是检测卡的标题与 Y 轴单位 —— 卡内每条通道一色，颜色走 `trendChannelColor()`
 * （与历史趋势页"多通道同坐标"同一套 8 色调色板，按通道号取色，8 色之外循环）。
 */
const DETECT_METRICS = [
  { key: 'spl', labelKey: 'monitorUi.detectSpl', unit: 'dB' },
  { key: 'smoothness', labelKey: 'monitorUi.detectSmoothness', unit: '' },
  { key: 'bandEnergyRatio', labelKey: 'monitorUi.detectEnergyRatio', unit: '' },
  { key: 'mainFrequency', labelKey: 'monitorUi.detectDominantFreq', unit: 'Hz' }
] as const

type DetectMetricKey = (typeof DETECT_METRICS)[number]['key']

/**
 * 检测卡的数据源口径（与 store 的 `channelFeatureHistory` 同一句话）：
 * 设备一次只开一路流（PROTOCOL-FINDINGS 4.3），所以**当前订阅**那一路的帧实时进来，
 * 其余通道只有上次切到它时读到的尾巴。于是每张卡画的是"每通道各自的时间线" —
 * 通道内部连续，跨通道并不同步。界面上那句 `monitorUi.detectDataNote` 就是这句实话；
 * 谁把这张图画成"8 路同步实时流"，谁就是在编造设备做不到的事。
 */
const detectOptions = computed<Record<DetectMetricKey, EChartsCoreOption>>(() => {
  const history = monitor.channelFeatureHistory
  const result = {} as Record<DetectMetricKey, EChartsCoreOption>
  for (const metric of DETECT_METRICS) {
    // 只画**有读数**的通道：没有点的序列在图例里只占一个名字，那条"线"并不存在。
    const series = channelTabs.value.flatMap((tab) => {
      const frames = history[tab.index]
      if (frames === undefined || frames.length === 0) return []
      return [
        {
          name: t('monitorUi.detectLegendChannel', { channel: tab.label }),
          type: 'line' as const,
          showSymbol: false,
          // 每通道的点随自己收到的帧来（1 Hz 量级、每路封顶 600），lttb 抽样与频谱卡同一本账。
          sampling: 'lttb',
          // 数据点带各自的时间戳，时间轴上"没数据的时段"占它该占的宽度 —— 跨通道不同步
          // 这件事由轴本身说真话，不用额外标注。
          data: frames.map((frame) => [frame.timestamp, frame[metric.key]]),
          lineStyle: { width: 1.2, color: trendChannelColor(tab.index) },
          itemStyle: { color: trendChannelColor(tab.index) }
        }
      ]
    })
    result[metric.key] = {
      animation: false,
      // 右侧留给通道图例（竖排、可滚），所以 grid 右边留宽。
      grid: { left: 52, right: 92, top: 20, bottom: 24 },
      legend: {
        type: 'scroll',
        orient: 'vertical',
        right: 2,
        top: 'middle',
        icon: 'roundRect',
        itemWidth: 10,
        itemHeight: 3,
        textStyle: { color: TEXT_SECONDARY, fontSize: 10 }
      },
      tooltip: { trigger: 'axis' },
      xAxis: {
        type: 'time',
        axisLine: { lineStyle: { color: AXIS_LINE } },
        axisLabel: { color: TEXT_SECONDARY, fontSize: 10, hideOverlap: true }
      },
      yAxis: {
        type: 'value',
        name: metric.unit,
        scale: true,
        nameTextStyle: { color: TEXT_SECONDARY, fontSize: 10 },
        axisLine: { show: false },
        axisLabel: { color: TEXT_SECONDARY, fontSize: 10 },
        splitLine: { lineStyle: { color: SPLIT_LINE } }
      },
      series
    }
  }
  return result
})

/** 检测模式有没有任何一路的可画数据（四张卡共用的空态判据）。 */
const detectHasData = computed(() =>
  channelTabs.value.some((tab) => (monitor.channelFeatureHistory[tab.index]?.length ?? 0) > 0)
)

// ---------------------------------------------------------------------------
// 多通道同时显示（业主 2026-09-24）
// ---------------------------------------------------------------------------

/**
 * 「多通道读数」卡：勾选的那几路，每路一行 —— 四个读数 + 一条迷你趋势 + 状态。
 *
 * 为什么要有这张卡：四张检测卡画的是"每路一条线"的对比，但**没有地方一次读出
 * 每一路现在的四个数**（单通道视图那张特性表一次只翻 4 行，而且不带趋势）。
 * 业主的原话是"每路：SPL / 主频 / 平稳度 / 频带能量比 四读数 + 一条迷你趋势"。
 *
 * 数据源与四张检测卡完全相同（`monitor.channelFeatureHistory`，每通道自己的时间线），
 * 状态判定走纯函数 `lib/channelSeries.ts`（可单测）。**迷你趋势固定画声压级**：
 * 四个读数各配一条线只会让人分不清哪条是哪条，而声压级是操作员扫一眼的那个量。
 */
const MULTI_CHANNEL_WINDOW_MS = 60_000

const multiChannelSeries = computed(() =>
  buildChannelSeries({
    watchedChannels: monitor.featureChannels,
    history: monitor.channelFeatureHistory,
    metric: 'spl',
    now: monitor.now,
    windowMs: MULTI_CHANNEL_WINDOW_MS,
    activeChannel: activeChannelIndex.value,
    sessionRunning: monitor.state === 'running'
  })
)

/** 勾选状态：当前通道永远在里面（主 socket 一直在推它）。 */
function isChannelWatched(index: number): boolean {
  return monitor.featureChannels.includes(index)
}

/**
 * 勾选/取消一路 —— 只有点勾选框走这里，点行仍然是"切当前通道"。
 *
 * 增量订阅：`setFeatureChannels()` 不重启会话（主进程的 `start()` 是增量的），
 * 所以勾第 3 路不会把正在跑的频谱/波形/时频图一起掐掉重开。
 */
function toggleChannelWatch(index: number): void {
  if (index === activeChannelIndex.value) return
  void monitor.setFeatureChannels(toggleWatchedChannel(monitor.featureChannels, index))
}

/** 勾选框的提示：禁用那一个要说清楚为什么。 */
function watchTitle(index: number): string {
  if (index === activeChannelIndex.value) return t('realtimeUi.watchChannelCurrent')
  return isChannelWatched(index)
    ? t('realtimeUi.watchChannelOff')
    : t('realtimeUi.watchChannelOn')
}

/** 这一路主进程到底收到过帧没有（`MonitorState.featureChannels` 的如实汇报）。 */
const channelRealityByChannel = computed(() => {
  const map = new Map<number, { frames: number; observedChannelId?: number }>()
  for (const entry of monitor.featureChannelState) map.set(entry.channelId, entry)
  return map
})

/**
 * 一行的状态文字：实时 / 更新于 <时刻> / 未收到这一路。
 *
 * 三种说法各有各的意思，不许合成一句"无数据"—— "没收到"与"收到了但停了"对排障是
 * 两条完全不同的线索（前者要看设备，后者要看过一会儿会不会回来）。
 */
function multiChannelStateText(series: (typeof multiChannelSeries.value)[number]): string {
  if (series.state === 'unread') return t('realtimeUi.multiChannelNotReceived')
  if (series.state === 'live') return t('realtimeUi.status.live')
  return t('realtimeUi.updatedAt', { time: featureTime(series.lastAt ?? monitor.now) })
}

/**
 * 状态文字的悬停解释。
 *
 * 三种状态三种说法，**实时那一路不给解释**（它的状态本身就说明了一切，再挂一句
 * "设备只推当前通道"只会让人以为这一路有问题）：
 *   - 没收到 + 设备把这条连接推到了别的通道 -> "这条连接推的是 CHx"（帧里自称的 cur_ch，
 *     设备的原话，不是我们的推断）；
 *   - 没收到 + 其它情况 -> 说清 `PUT /channel_select` 之后这一路仍然没有帧的原因；
 *   - 收到了但停了 -> 说清"超过 5 秒没有新帧"，并说明留在这里的是最后一次读数。
 */
function multiChannelStateHint(series: (typeof multiChannelSeries.value)[number]): string {
  if (series.state === 'live') return ''
  const observed = channelRealityByChannel.value.get(series.channelId)?.observedChannelId
  if (observed !== undefined && observed !== series.channelId) {
    return t('realtimeUi.multiChannelWrongChannel', { channel: channelLabel(observed) })
  }
  return series.state === 'stored'
    ? t('realtimeUi.multiChannelStaleWhy')
    : t('realtimeUi.multiChannelNotReceivedWhy')
}

/** 迷你趋势的 path（纯函数在 `lib/channelSeries.ts`，已单测）。 */
function multiChannelSparkPath(points: Array<{ x: number; y: number }>): string {
  return seriesSparkPath(points)
}

/**
 * Frequency axis from `binHz`.
 *
 * THE POINT OF THIS CHART: `/freq_domain` carries 1024 magnitudes and NO
 * frequency axis, so plotting by array index would label a real 1.5 kHz peak as
 * "bin 16" — wrong by the bin width (~94 Hz at 96 kHz). Every x value here is
 * `index * binHz`, taken from the payload the main process derived from the
 * device sample rate.
 */
const spectrumAxisMax = computed(() =>
  spectrumMaxHz(monitor.spectrumMagnitudes, monitor.content.spectrum?.binHz ?? 0)
)

const spectrumHint = computed(() => {
  const binHz = monitor.content.spectrum?.binHz ?? 0
  // Reading `locale.value` keeps this computed subscribed to language changes;
  // the label itself is locale-independent (Hz), but the number formatting is not
  // (Spanish writes `94,5`).
  void locale.value
  if (binHz <= 0) return t('monitorUi.waitingSpectrumData')
  return `${spectrumRangeLabel(spectrumAxisMax.value)} · ${t('monitorUi.spectrumPerBin', {
    hz: formatNumber(binHz, 2)
  })}`
})

const spectrumOption = computed<EChartsCoreOption>(() => {
  const magnitudes = monitor.spectrumMagnitudes
  const binHz = monitor.content.spectrum?.binHz ?? 0
  return {
    animation: false,
    grid: { left: 46, right: 16, top: 24, bottom: 28 },
    tooltip: {
      trigger: 'axis',
      valueFormatter: (value: unknown) =>
        formatNumber(typeof value === 'number' ? value : Number(value), 3)
    },
    xAxis: {
      type: 'value',
      min: 0,
      max: spectrumAxisMax.value > 0 ? spectrumAxisMax.value : undefined,
      name: 'Hz',
      nameTextStyle: { color: TEXT_SECONDARY, fontSize: 10 },
      axisLine: { lineStyle: { color: AXIS_LINE } },
      axisLabel: { color: TEXT_SECONDARY, fontSize: 10, formatter: formatHzTick }
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: 1,
      name: t('monitorUi.chartNormalizedEnergy'),
      nameTextStyle: { color: TEXT_SECONDARY, fontSize: 10 },
      axisLine: { show: false },
      axisLabel: { color: TEXT_SECONDARY, fontSize: 10 },
      splitLine: { lineStyle: { color: SPLIT_LINE } }
    },
    series: [
      {
        name: t('monitorUi.chartBandEnergy'),
        type: 'line',
        showSymbol: false,
        // 1024 points per sweep at ~1.4 sweeps/s: LTTB keeps the rendered line
        // faithful while cutting the points the canvas has to touch.
        sampling: 'lttb',
        data: spectrumPoints(magnitudes, binHz),
        lineStyle: { width: 1.2, color: '#FF6A1A' },
        itemStyle: { color: '#FF6A1A' },
        areaStyle: { color: '#FF6A1A', opacity: 0.12 }
      }
    ]
  }
})

// ---------------------------------------------------------------------------
// ③b 声学波形（四张图谱卡片里的第三张）
// ---------------------------------------------------------------------------

/**
 * 一帧声学波形（示波器式）。
 *
 * 画的是**跨 IPC 过来的那一份降采样包络本身**（`AudioFrameEvent.waveform`，每帧 100 ms），
 * 而不是原始采样 —— 与「播放」按钮听到的是同一份数据、同一个形状。所以横轴是
 * **这一帧内的毫秒**（0..frameMs），不是绝对时间：一帧画一屏，下一帧覆盖上一帧。
 */
/**
 * 声学波形 Y 轴的对称量程（0 点固定在卡片中心，2026-09-23）。
 * 在 computed 里维护：当前帧峰值高就立即跟上（信号不被裁），低了就 ×0.98 慢回落。
 * 下限 1e-3 只是防"除零/零量程"，不是测量值。
 */
let waveformYMax = 1e-3

const waveformOption = computed<EChartsCoreOption>(() => {
  const frame = monitor.content.audio
  const points = frame?.waveform ?? []
  const frameMs = frame?.frameMs ?? 100
  const last = Math.max(points.length - 1, 1)
  let peak = 0
  for (const value of points) {
    const magnitude = Math.abs(value)
    if (magnitude > peak) peak = magnitude
  }
  const target = Math.max(peak * 1.15, 1e-3)
  waveformYMax = target > waveformYMax ? target : Math.max(target, waveformYMax * 0.98)
  return {
    animation: false,
    grid: { left: 46, right: 16, top: 24, bottom: 28 },
    tooltip: {
      trigger: 'axis',
      valueFormatter: (value: unknown) =>
        formatNumber(typeof value === 'number' ? value : Number(value), 3)
    },
    xAxis: {
      type: 'value',
      min: 0,
      max: frameMs,
      name: 'ms',
      nameTextStyle: { color: TEXT_SECONDARY, fontSize: 10 },
      axisLine: { lineStyle: { color: AXIS_LINE } },
      axisLabel: { color: TEXT_SECONDARY, fontSize: 10 }
    },
    yAxis: {
      type: 'value',
      // Y 轴以 0 为中心、随信号自适应（2026-09-23 业主：「0 点固定在卡片中心」）。
      // 实测 AE08 的包络是物理量级的小数（±1e-4 上下），固定 ±1 会让波形贴成一条
      // 平线；对称自适应量程既保住"0 永远居中"，又让信号真的看得见。峰值快升慢降，
      // 帧与帧之间量程不跳。
      min: -waveformYMax,
      max: waveformYMax,
      name: t('monitorUi.waveformAmplitude'),
      nameTextStyle: { color: TEXT_SECONDARY, fontSize: 10 },
      axisLine: { show: false },
      axisLabel: { color: TEXT_SECONDARY, fontSize: 10 },
      splitLine: { lineStyle: { color: SPLIT_LINE } }
    },
    series: [
      {
        name: t('monitorUi.waveformSection'),
        type: 'line',
        showSymbol: false,
        data: points.map((value, index) => [(index / last) * frameMs, value]),
        lineStyle: { width: 1.2, color: '#0F766E' },
        itemStyle: { color: '#0F766E' }
      }
    ]
  }
})

// ---------------------------------------------------------------------------
// Device / channel wiring
// ---------------------------------------------------------------------------

/**
 * 采样率是**声纹设备**的事实（`GET /get_sample_rate`）。相机与声呐都没有这个端点，
 * 所以只在这一支上读它 —— 对着别的机型读只会得到一次必然失败的请求，而主进程会把那次失败
 * 记到设备状态上，一台好设备就此显示成"离线"。
 */
async function loadSampleRateIfVoiceprint(deviceId: string): Promise<void> {
  if (!isVoiceprint.value) {
    sampleRate.value = null
    return
  }
  await loadSampleRate(deviceId)
}

async function loadSampleRate(deviceId: string): Promise<void> {
  const result = await callApi(() => window.api.config.getSampleRate(deviceId))
  sampleRate.value = result.success ? (unwrap(result) ?? null) : null
}

function syncFromRoute(): void {
  const queryDevice = typeof route.query.device === 'string' ? route.query.device : ''
  const candidate = queryDevice || devices.selectedDeviceId || devices.devices[0]?.id || ''
  selectedDeviceId.value = candidate
  if (candidate) {
    devices.select(candidate)
    monitor.selectDevice(candidate)
  }
}

/** Start the session for whatever device/channel is currently selected. */
async function startSession(): Promise<void> {
  await monitor.start(ALL_STREAM_KINDS, activeChannelIndex.value)
}

/**
 * 自动开始的尝试计数（业主 2026-09-19 第 13 批第 3 条）。
 *
 * 「这一次页面停留里为这台设备自动开过几次」。三条路径（进页面 / 切换设备 /
 * 设备刚上线）共用它，切设备时清零 —— 计数是**每台设备**的，不是全局的。
 */
const autoStartAttempts = ref(0)

function resetAutoStartAttempts(): void {
  autoStartAttempts.value = 0
}

/**
 * 「进页面 / 换设备 / 设备刚上线」共用的自动开始。
 *
 * 判定在 `@shared/domain/monitor-autostart.ts`（纯函数，可单测），这里只做两件事：
 * 把这一页的事实喂进去，把结论变成一次 `monitor.start()`。**没有**第二个"开始监测"
 * 按钮可点——按钮按业主的要求删掉了，所以这三条路径漏掉任何一条，操作员就只能刷新页面。
 *
 * 失败不在这里吞掉也不在这里报警：`monitor.start()` 的失败会落到会话状态（`error`）上，
 * 页头那枚徽标如实显示（`sessionError`），与改造前按按钮失败时的表现一致。
 */
async function autoStartSessionIfNeeded(): Promise<void> {
  const decision = decideMonitorAutoStart({
    hasLiveStream: isVoiceprint.value,
    deviceId: selectedDeviceId.value,
    deviceStatus: selectedDevice.value?.status ?? 'UNKNOWN',
    sessionState: monitor.state,
    sessionDeviceId: monitor.deviceId,
    attempts: autoStartAttempts.value
  })
  if (decision.action !== 'start') return
  autoStartAttempts.value += 1
  await startSession()
}

/**
 * 设备**刚上线**：自动开始一次（业主第 3 条的下半句）。
 *
 * 为什么需要这一条：本机探活可能比现实慢一拍（软件刚开机、设备刚上电），那时第一次
 * 自动尝试注定失败，而删除按钮之后就没有第二次机会了。所以在线状态从"不是 ONLINE"
 * 变成"ONLINE"时清零尝试计数并重新问一次判定 —— 判定仍然只有一处，这里只负责
 * "什么时候再问一次"。
 */
watch(
  () => selectedDevice.value?.status,
  async (status, previous) => {
    if (status !== 'ONLINE' || previous === 'ONLINE') return
    resetAutoStartAttempts()
    await autoStartSessionIfNeeded()
  }
)

/**
 * Switching channel RESTARTS the streams.
 *
 * MEASURED (PROTOCOL-FINDINGS 4.3): the device streams ONE channel per
 * WebSocket connection. There is no "subscribe to another channel" message, so
 * the old connections are closed and new ones opened with the new channel id.
 * Reusing a connection here would silently keep plotting the previous sensor.
 */
async function selectChannel(index: number): Promise<void> {
  if (index === activeChannelIndex.value) return
  // 未开启的通道不参与实时监测：按钮上已挂 `disabled`，这里再守一次，
  // 免得程序化调用（键盘、未来的快捷方式）绕过它去点一路关闭的通道。
  if (channelTabs.value.find((tab) => tab.index === index)?.state === 'disabled') return
  activeChannelIndex.value = index
  if (isLive.value) await startSession()
}

async function toggleRecording(): Promise<void> {
  if (monitor.recording.active) await monitor.stopRecording()
  else await monitor.startRecording()
}

// ---------------------------------------------------------------------------
// Camera live video (FA371) — a different device family, a different panel
// ---------------------------------------------------------------------------

/**
 * An acoustic camera has no box channels and no `/features_stream`, so pointing the
 * WebSocket monitor at it would open sockets at paths that do not exist and report a
 * healthy device as broken. `kind` is the discriminator the rest of the app uses
 * (`DeviceService.cameraClientFor`).
 */
const isCamera = computed(() => selectedDevice.value?.kind === 'acousticCamera')

/**
 * **三种机型，三种实时检测内容**（业主 2026-09-17 第 5 条）。
 *
 * 「查看」把操作员带到这一页，而这一页要看的东西按机型完全不同：
 *
 * | 机型 | 这一屏的内容 | 数据从哪来 |
 * |---|---|---|
 * | 声纹设备（AE08 / FA8） | 通道页签 + 趋势 + 四张图谱（波形卡内含播放/录音/音量） + 每通道声纹特性 | 主进程的四条 WebSocket（`monitor` store） |
 * | 声学相机（FA371） | 单路直播 + 五张声学图 + 检测启停 | 主进程回环 HTTP（`cameraLive`）+ 相机 REST |
 * | SN-16 空气声呐（`auscultationBox`） | 参数与告警同步（`AuscultationPanel`）+ 本机录音回放 | 设备的「拉」通道（HTTP），**没有**实时流 |
 *
 * 第三支是**新增的**：在那之前一台听诊盒子/声呐落到的是声纹那一支，而那一支会去开
 * `/features_stream` —— 这台设备上没有那个端点，于是"健康的设备"被显示成"实时监测起不来"。
 * 这与相机那一支的理由是同一个：**不能把不属于这一族的协议指向这台设备**。
 *
 * 声呐这一支现在**没有实时图**，因为这一族的实时音频/时频流是 WebSocket
 * （手册给了 `/audio_stream`、`/stft_stream`，SN-16 另有 `/all_chns_stream`），我们还没有接入，
 * 也没有在真机上验过帧格式。宁可这一屏少一块，也不画一张假的实时图 —— 界面上那句话
 * 就是这件事的说明（`monitorUi.sonarLiveUnwired`）。
 */
const isSonar = computed(() => selectedDevice.value?.kind === 'auscultationBox')

/**
 * 气井泄漏（AO01）：协议上是 acousticBox，但固件不推实时音频/频谱。
 * 不能走声纹那一支的四个图 + 四张指标卡，否则整页都是 "Waiting for…"/"Stream error"。
 */
const isGasLeak = computed(() => isGasLeakMonitor(selectedDevice.value))

/** 声纹设备那一支（也是"没有选中设备"时的默认支，与改造前一致）。 */
const isVoiceprint = computed(() => !isCamera.value && !isSonar.value && !isGasLeak.value)

/**
 * 相机声学数据流的会话**唯一**主人（业主 2026-09-21 第三批）。
 *
 * 声学面板按 `sections` 拆成了多份实例（右列：声纹 + 频谱；视频下方：波形 + 检测），
 * 而「选中相机就默认开始接收、离开就停」只能有一处实现 —— 在 `useFa371CameraSession()`
 * 里，由这一页调用一次。面板本身不再开/停任何流（见 `CameraAcousticPanel` 文件头）。
 */
useFa371CameraSession(selectedDeviceId, isCamera)

/** 红外温度帧（/inrared_data，16 B/帧）。会话随默认接收一起开这一路；设备没推时为空。 */
const fa371Stream = useFa371StreamStore()

/**
 * 「添加到视频墙」（业主 2026-09-24）：监测页看到画面时能一键把这台相机放进
 * 总览的视频墙。墙的模型只认自己 `bindDevices` 过的清单，所以动作前先把当前
 * 设备表灌进去——幂等，同一台设备重复添加由 `slotForDevice` 挡住。
 */
const cameraWall = useCameraWallStore()
const cameraOnWall = computed(
  () => selectedDeviceId.value !== '' && cameraWall.slotForDevice(selectedDeviceId.value) >= 0
)

function addCameraToWall(): void {
  const id = selectedDeviceId.value
  if (id === '' || cameraOnWall.value) return
  cameraWall.bindDevices(devices.devices)
  cameraWall.placeDeviceAuto(id)
}

const infraredFrame = computed(() => fa371Stream.infrared)

/** 温度数值：设备没给的字段显示 —— 0 ℃ 也是一个真实温度，不能拿 0 占位。 */
function infraredValue(value: number | undefined, digits = 1): string {
  return value === undefined ? EMPTY_VALUE : formatNumber(value, digits)
}

/** 红外入口只在设备**真的推过**红外帧后才出现（2026-09-22 业主第 4 条）。
 *
 * 相机有没有红外能力，唯一的诚实判据是数据：/inrared_data 推过帧 = 有声温成像能力；
 * 从未推过 = 非红外机型，温度入口整体不渲染（"做不到的不渲染"）。
 * 帧到达前短暂不出现是刻意的：给一个非红外机型常驻一个永远只有"—"的温度面板，
 * 比晚一两秒出现更误导。
 */
const hasInfraredFrames = computed(() => fa371Stream.hasFrames('infraredData'))

const cameraLive = ref<CameraLiveState | null>(null)
const cameraBusy = ref(false)
const videoEl = ref<HTMLVideoElement | null>(null)

/**
 * Status -> catalogue KEY.
 *
 * A key rather than rendered text, so the label follows a language change instead of
 * freezing at the language active when this module was evaluated — the same reason
 * the chart metrics store `labelKey`.
 */
const CAMERA_STATUS_KEYS: Record<CameraLiveStatus, string> = {
  idle: 'cameraLiveUi.statusIdle',
  starting: 'cameraLiveUi.statusStarting',
  playing: 'cameraLiveUi.statusPlaying',
  'rtsp-disabled': 'cameraLiveUi.statusRtspDisabled',
  'ffmpeg-missing': 'cameraLiveUi.statusFfmpegMissing',
  error: 'cameraLiveUi.statusError',
  // 本机的并发预算满了 —— 不是设备故障，也不是流故障（见共享域模型的说明）。
  'limit-exceeded': 'cameraLiveUi.statusLimitExceeded'
}

const cameraStatus = computed<CameraLiveStatus>(() => cameraLive.value?.status ?? 'idle')
const cameraStatusLabel = computed(() => t(CAMERA_STATUS_KEYS[cameraStatus.value]))
/** Only these two states own a URL worth handing to a <video> element. */
const cameraActive = computed(
  () => cameraStatus.value === 'starting' || cameraStatus.value === 'playing'
)
const cameraLiveUrl = computed(() =>
  cameraActive.value ? (cameraLive.value?.url ?? '') : ''
)
const cameraTone = computed(() => {
  if (cameraStatus.value === 'error' || cameraStatus.value === 'ffmpeg-missing') return 'danger'
  if (cameraStatus.value === 'rtsp-disabled' || cameraStatus.value === 'limit-exceeded') return 'warn'
  return cameraActive.value ? 'ok' : 'idle'
})

/**
 * The tone above mapped onto the classes that actually exist in `main.css`.
 *
 * `badge--ok` / `alert--warn` are NOT styles in this app (the vocabulary is
 * accent/success/warning/danger), and inventing a class in a scoped block would give
 * the badge no colour at all rather than a wrong one.
 */
const cameraBadgeClass = computed(() => {
  if (cameraTone.value === 'danger') return 'badge badge--danger'
  if (cameraTone.value === 'warn') return 'badge badge--warning'
  if (cameraTone.value === 'ok') return 'badge badge--success'
  return 'badge'
})

const cameraAlertClass = computed(() => {
  if (cameraTone.value === 'danger') return 'alert alert--danger'
  if (cameraTone.value === 'warn') return 'alert alert--warning'
  if (cameraTone.value === 'ok') return 'alert alert--success'
  return 'alert'
})

/**
 * The honest explanation under the player.
 *
 * The main process's own text wins when it has one: it either names the device fact
 * (`rtsp_enabled=0`) or quotes ffmpeg's stderr tail, both of which are more useful
 * than a generic sentence. The catalogue supplies the next step only when there is
 * nothing better to say.
 */
const cameraMessage = computed(() => {
  const state = cameraLive.value
  if (state?.error) return state.error
  if (cameraStatus.value === 'rtsp-disabled') return t('cameraLiveUi.rtspDisabledHint')
  if (cameraStatus.value === 'ffmpeg-missing') return t('cameraLiveUi.ffmpegMissingHint')
  if (cameraStatus.value === 'limit-exceeded') return t('cameraLiveUi.limitExceededHint')
  if (cameraStatus.value === 'error') return t('cameraLiveUi.errorHint')
  return ''
})

/** Read the main process's authoritative session state (an unguarded read). */
async function refreshCameraState(): Promise<void> {
  const id = selectedDeviceId.value
  if (!id) return
  const result = await callApi(() => window.api.cameraLive.state(id))
  cameraLive.value = result.success ? (unwrap(result)?.[0] ?? null) : null
}

// ---------------------------------------------------------------------------
// 这一台设备的告警信息（相机第 24 条 + 声纹第 13 批第 3 条的「是否告警」列）
// ---------------------------------------------------------------------------

/**
 * 最近几条告警，就地显示在「告警配置」那张卡片里（相机），同时供**每通道特性表**
 * 的「是否告警」一列分组（声纹设备）。
 *
 * 为什么在页面上直接列出来、而不是只给一个"查看告警记录"的链接：第 24 条要的是
 * **告警信息与历史告警展示**两件事 —— 链接解决"去看全部"，这几行解决"现在有没有事"。
 * 数据与告警记录页同源（同一个 `alarms.query`），所以两处不会各说一套。
 *
 * 为什么两台机型**共用这一次查询**：一次查询就是一次读库。相机要的是"最近几条"，
 * 声纹要的是"按通道分组"。分成两次查询会让同一屏上的两个数字有机会不一致（一次查询
 * 之间插进一条新告警），而共用一份结果不可能不一致。
 *
 * 只读一次、不订阅：这一页不持有告警的实时推送（那一条在事件中心与右上角告警图标里），
 * 刷新由换设备与顶栏的「刷新」按钮触发。
 */
const deviceAlarms = ref<AlarmEvent[]>([])
const deviceAlarmsLoading = ref(false)

async function loadDeviceAlarms(deviceId: string): Promise<void> {
  deviceAlarms.value = []
  if (!deviceId) return
  deviceAlarmsLoading.value = true
  const result = await callApi(() =>
    window.api.alarms.query({ deviceId, limit: DEVICE_ALARM_SAMPLE })
  )
  deviceAlarmsLoading.value = false
  // 切走了设备：这一批结果不该写进另一台的列表。
  if (selectedDeviceId.value !== deviceId) return
  deviceAlarms.value = result.success ? (unwrap(result)?.items ?? []) : []
}

/**
 * 这一次查询取多少条。
 *
 * 50 是"够覆盖一屏 8 路各一条、还留得下一点历史"的量级，同时把这次读库的成本钉住。
 * ⚠ 它是**采样窗口**：表里那一列回答的是"在这最近 50 条里，这一路有没有告警"，
 * 不是"历史上这一路有没有过告警"。界面上那行说明（`channelAlarmSampleHint`）就是
 * 这句话，不写就是把采样说成了全部历史。
 */
const DEVICE_ALARM_SAMPLE = 50

/** 按通道分组的告警小结（纯函数在 `@shared/domain/channel-alarm.ts`）。 */
const alarmsByChannel = computed(() => groupAlarmsByChannel(deviceAlarms.value))

/**
 * 相机分支「告警信息」卡片的真正数据源（2026-09-23「相机告警不显示」修复）。
 *
 * 上面的 `deviceAlarms` 读的是本地 `alarms` 表，而那张表只被听诊盒子（AE08/IoT
 * 接入）的告警写入 —— 相机的局放告警走的是联动引擎：`/detect_logs` 轮询 → 判定
 * → `PendingAlarmStore`，**永远不会**落到 `alarms` 表。所以相机页用 `deviceAlarms`
 * 注定永远为空，这正是"相机明明在告警、卡片却一条都没有"的原因。
 *
 * 这里改读联动引擎的待处理镜像（`AppShell` 常驻订阅推送，实时刷新、不额外轮询），
 * 按当前设备过滤、按发生时刻倒序。
 */
const cameraLinkageAlarms = computed(() =>
  linkage.pending
    .filter((item) => item.deviceId === selectedDeviceId.value)
    .slice()
    .sort((a, b) => b.at - a.at)
)

/** 联动总开关是否关着（`null` = 状态还没读到，不出提示）。 */
const linkageDisabled = computed(() => linkage.status !== null && !linkage.status.enabled)

/**
 * 这台设备**还没确认**的告警条数 —— 「告警控制」角标与告警卡标题右侧那个数字读它。
 *
 * 业主 2026-09-26 第 2 条：「告警控制里面显示的是 200 个告警，这内容应该和软件整体
 * 右上角的告警 ICON 一致」。
 *
 * 顶栏那颗图标（`AlarmLinkagePanel.bellCount`）数的是
 * `deviceAlarmTotal + linkage.unacknowledgedCount` —— 也就是**未确认**口径。相机告警
 * 只存在于联动这一路（相机告警不进 `alarms` 表，见上面那段注释），所以对相机而言
 * 与铃铛同源的那一半就是 `linkage.unacknowledged`。
 *
 * 这里刻意**不加** `deviceAlarms`（本地告警表）那一半：那台表只装听诊盒子的告警，
 * 相机分支加上它只会把别的设备的历史算到这台相机头上。
 */
const cameraAlarmUnacknowledgedCount = computed(
  () => cameraLinkageAlarms.value.filter((alarm) => !alarm.acknowledged).length
)

/**
 * 告警信息表每页几行（业主 2026-09-26 第 1 条：告警数量要支持换页）。
 *
 * 固定 8 行：这一块的高度要与左边 PRPD 那块（16:9 舞台 + 标题）对齐，
 * 行数由"标题 + 8 行 + 页脚"刚好铺满那个高度决定。**不是**按容器高度动态算的 ——
 * 动态算要在 resize 时重新分页，翻页翻到一半列表会自己变页，比多一条滚动条更难用。
 */
const CAMERA_ALARM_PAGE_SIZE = 8

const cameraAlarmPage = ref(1)

const cameraAlarmPages = computed(() =>
  Math.max(1, Math.ceil(cameraLinkageAlarms.value.length / CAMERA_ALARM_PAGE_SIZE))
)

/** 页码夹回范围：换设备、确认掉告警、新告警到达都会改总页数。 */
watch(cameraAlarmPages, (pages) => {
  if (cameraAlarmPage.value > pages) cameraAlarmPage.value = pages
  if (cameraAlarmPage.value < 1) cameraAlarmPage.value = 1
})

watch(selectedDeviceId, () => {
  cameraAlarmPage.value = 1
})

const pagedCameraAlarms = computed(() => {
  const start = (cameraAlarmPage.value - 1) * CAMERA_ALARM_PAGE_SIZE
  return cameraLinkageAlarms.value.slice(start, start + CAMERA_ALARM_PAGE_SIZE)
})

/**
 * 点告警行 → **告警中心**里这一条的详情（业主 2026-09-26 第 3 条）。
 *
 * 改成跳告警中心的原因：这台相机的告警证据（音频 / 视频 / 抓帧 / 检测文件）在告警中心
 * 与事件中心两处都有入口，而从"告警信息"这一行出发时操作员要的是**这一条**的详情，
 * 不是"那一台设备的所有事件"。`?cameraAlarm=<eventId>` 让告警中心直接把这一条打开。
 *
 * 设备筛选仍然一起带上：告警中心的列表要以这一台为默认条件，否则从这一行过去会看到
 * 全库的告警，还得自己再选一次设备。
 */
function openCameraAlarmDetail(alarm: PendingAlarmRecord): void {
  void router.push({
    path: '/alarms',
    query: { device: alarm.deviceId, cameraAlarm: alarm.eventId }
  })
}

/**
 * 告警类型那一格：放电类型 > 检测模式 > 通用「告警」（与告警中心 `cameraAlarmTypeText`
 * 同一优先级；两处说的是同一行数据，不能各排一个顺序）。
 */
function cameraAlarmTypeText(alarm: PendingAlarmRecord): string {
  return (
    linkageDischargeText(t, alarm) ||
    linkageDetectModeText(t, alarm) ||
    t('alarmsUi.cameraAlarmGeneric')
  )
}

async function startCameraLive(): Promise<void> {
  const id = selectedDeviceId.value
  if (!id || cameraBusy.value) return
  cameraBusy.value = true
  try {
    const result = await callApi(() => window.api.cameraLive.start({ deviceId: id }))
    if (!result.success) {
      // An IPC failure is still a STATE this panel can render, so the operator gets
      // the reason instead of an empty black box.
      cameraLive.value = { deviceId: id, status: 'error', error: resultMessage(result) }
      return
    }
    cameraLive.value = unwrap(result) ?? null
  } finally {
    cameraBusy.value = false
  }
}

async function stopCameraLive(): Promise<void> {
  // Release the element FIRST: it is what holds the loopback request open, and
  // stopping the main process under a live request would leave the <video> retrying.
  const video = videoEl.value
  if (video) {
    video.pause()
    video.removeAttribute('src')
    video.load()
  }
  cameraLive.value = null
  // 停流之后"暂停画面"这个状态不再有意义：下一次起播必须是活的画面。
  picturePaused.value = false
  const id = selectedDeviceId.value
  if (!id) return
  await callApi(() => window.api.cameraLive.stop(id))
}

/**
 * The stream ended or failed. Ask the main process WHY rather than guessing: a
 * crashed ffmpeg is reported there as an `error` state carrying its stderr tail, and
 * that is what the panel must show instead of a silently frozen last frame.
 */
/**
 * 中途断流自动重试（业主 2026-09-22 第 8 条「流错误」；2026-09-24 改成**有限多次**）。
 *
 * 相机把空闲/过载的 RTSP 会话踢掉时（表现为"流错误"），操作员的做法本来就是手动再点
 * 一次开始 —— 这一步把它自动化。改为 3 次退避重试（2s/5s/10s）：只试一次的旧版在
 * 相机负载高（告警密集 + 多路流）时仍然留给用户一条黑屏；连续 3 次都失败说明是真
 * 问题（地址变了、相机确实不推了），错误留在屏幕上。画面稳定播放 30 秒就把计数清零
 * ——偶发被踢不该消耗掉"真出问题时"的重试额度。
 */
let liveAutoRetryCount = 0
const LIVE_AUTO_RETRY_MAX = 3
const LIVE_AUTO_RETRY_DELAYS_MS = [2_000, 5_000, 10_000]
let liveStableTimer: ReturnType<typeof setTimeout> | undefined

/** 画面稳定 30 秒：把重试计数清零（偶发被踢不该吃掉真故障时的额度）。 */
function noteLiveStable(): void {
  if (liveStableTimer !== undefined) clearTimeout(liveStableTimer)
  liveStableTimer = setTimeout(() => {
    liveAutoRetryCount = 0
  }, 30_000)
}

function onVideoProblem(): void {
  void refreshCameraState().then(() => {
    if (
      cameraStatus.value === 'error' &&
      liveAutoRetryCount < LIVE_AUTO_RETRY_MAX &&
      !cameraBusy.value &&
      selectedDeviceId.value !== ''
    ) {
      const delay = LIVE_AUTO_RETRY_DELAYS_MS[Math.min(liveAutoRetryCount, LIVE_AUTO_RETRY_DELAYS_MS.length - 1)] ?? 10_000
      liveAutoRetryCount += 1
      window.setTimeout(() => {
        if (cameraStatus.value === 'error') void startCameraLive()
      }, delay)
    }
  })
}

/**
 * 第一帧到了（或播放真的开始了）。
 *
 * `start` 交回来的是 `starting`——ffmpeg 已经起来、回环地址已经存在，而状态变成
 * `playing` 是**随后**在主进程里发生的，没有任何推送会告诉渲染层。所以不在这里重读
 * 一次，面板就会一直挂着「正在启动…」，并且 录像/抓图 在**画面已经在播**的情况下
 * 仍然是灰的（原因还写着「正在启动」）。
 *
 * 这个洞先在视频墙上被测出来并修掉，监测页这里是同一个洞：`@error`/`@ended` 已经走
 * `refreshCameraState()`，成功的这条路以前没有对应的一步。
 */
function onVideoReady(): void {
  // 播放真的开始了：30 秒稳定后清重试计数（而不是一到帧就清——
  // 起来又掉的抖动序列不能被当成"每次都成功了"）。
  noteLiveStable()
  void refreshCameraState()
  if (detectionAreaLoadedDeviceId.value !== selectedDeviceId.value) void loadDetectionRegions()
  // 一有画面就把记住的音量写上去（元素是这一刻才存在的，之前写不了）。
  applyAudioOutput()
}

/** Start/stop for the panel's single button. */
async function toggleCameraLive(): Promise<void> {
  if (cameraActive.value) await stopCameraLive()
  else await startCameraLive()
}

// ---------------------------------------------------------------------------
// 第 21 条：画面冻结、音量记忆、翻转
// ---------------------------------------------------------------------------

/**
 * 「暂停画面」不是「暂停设备」。
 *
 * 这一路是主进程用 ffmpeg 转封装出来的**实时**流：渲染层没有、也不该有"暂停设备推流"这件事
 * （ffmpeg 与 RTSP 会话都在主进程，暂停它等于停流，那就不是暂停而是停止了）。所以这个按钮
 * 做的是 `video.pause()` —— **冻住眼前这一帧**，再按一下从实时位置继续。
 * 名字里带「画面」两个字就是为了不让它读成"设备停了"（与 §15.13 那条口径一致：
 * 界面不能替设备说一句它没做过的事）。
 */
const picturePaused = ref(false)

function togglePicturePause(): void {
  const video = videoEl.value
  if (!video) return
  if (picturePaused.value) {
    picturePaused.value = false
    void video.play().catch(() => {
      // 播放被拒（自动播放策略）：把状态放回"暂停"，按钮与画面才不会互相矛盾。
      picturePaused.value = true
    })
  } else {
    video.pause()
    picturePaused.value = true
  }
}

/**
 * 音量（第 21 条「音量可调并**记住**」）。
 *
 * 三条判断，每一条都有理由：
 *   1. **默认静音起播**：第 21 条要求"选中即自动播放"，而浏览器的自动播放策略不允许
 *      带声音自动播 —— 所以自动起播那一次必须是 muted，音量滑杆是**用户手势**，
 *      拖动它才算"他要求出声"。`audioUnlocked` 就是这件事的状态；
 *   2. **记住的是音量值，不是"要不要出声"**：下次进来仍然静音起播（策略不变），
 *      但滑杆位置与一拖动之后的响度都是上次那个数；
 *   3. **写到元素属性上**：`<video>` 读的是元素自己的 `volume` / `muted`，
 *      改了响应式变量而不写元素，界面上滑杆动了而声音没变。
 */
const liveVolume = ref(CAMERA_DEFAULT_VOLUME)
const audioUnlocked = ref(false)
/**
 * 静音开关（业主 2026-09-21 第三批，照画面墙音量浮层的那一颗）。
 *
 * 与「音量值」是两件事：记住的是音量值（每台设备一份），而「要不要出声」每次都从
 * 静音起播 —— 浏览器的自动播放策略不允许带声音自动播。解除静音是一次用户手势，
 * 所以取消静音的同时把 `audioUnlocked` 置上。
 */
const soundMuted = ref(true)

const liveVolumePercent = computed(() => Math.round(liveVolume.value * 100))

const liveVolumeLabel = computed(() =>
  !cameraActive.value
    ? t('cameraLiveUi.volumeNoPicture')
    : liveVolume.value === 0
      ? t('cameraLiveUi.volumeMuted')
      : t('cameraLiveUi.volumeValue', { percent: liveVolumePercent.value })
)

/** 音量图标的状态：这一路正在出声（用于喇叭上有没有斜杠）。 */
const liveSoundOn = computed(
  () => cameraActive.value && !soundMuted.value && audioUnlocked.value && liveVolume.value > 0
)

function applyAudioOutput(): void {
  const video = videoEl.value
  if (!video) return
  // 顺序有意义：先写 volume 再解 muted —— 反过来的话，解除静音的那一瞬间会以旧音量
  // 响一下（滑杆在 0 时那一瞬间是满音量）。
  video.volume = sanitiseCameraVolume(liveVolume.value)
  video.muted = soundMuted.value || !audioUnlocked.value || video.volume === 0
}

function onLiveVolumeInput(event: Event): void {
  const value = (event.target as HTMLInputElement | null)?.value
  liveVolume.value = sanitiseCameraVolume(value)
  // 拖动滑杆 = 用户手势：这一下之后才允许出声，而且拖动本身就是在说要听 —— 顺手把静音摘掉。
  audioUnlocked.value = true
  soundMuted.value = false
  applyAudioOutput()
  saveCameraVolume(selectedDeviceId.value, liveVolume.value)
}

/** 浮层里的静音开关（与画面墙那一颗同一语义：出声 / 不出声）。 */
function toggleSoundMute(): void {
  soundMuted.value = !soundMuted.value
  // 取消静音是一次用户手势：从这一刻起允许出声。
  if (!soundMuted.value) audioUnlocked.value = true
  applyAudioOutput()
}

/**
 * 控制条浮层（音量 / 红外，业主 2026-09-21 第三批）：图标按钮点出，点按钮与浮层
 * **以外**收起。与波形卡那张浮层同一套做法（`mousedown` 捕获挂在 document 上），
 * 只是这里有两个浮层共用一条关闭监听。
 */
const cameraVolumeOpen = ref(false)
const infraredOpen = ref(false)

function onCameraPopsDocMouseDown(event: MouseEvent): void {
  const target = event.target
  if (
    target instanceof Element &&
    target.closest(
      '[data-camera-volume-trigger], [data-camera-volume-pop], [data-camera-infrared], [data-camera-infrared-pop]'
    )
  ) {
    return
  }
  cameraVolumeOpen.value = false
  infraredOpen.value = false
}

const cameraPopsOpen = computed(() => cameraVolumeOpen.value || infraredOpen.value)

watch(cameraPopsOpen, (open) => {
  if (open) document.addEventListener('mousedown', onCameraPopsDocMouseDown, true)
  else document.removeEventListener('mousedown', onCameraPopsDocMouseDown, true)
})

/** 画面翻转（第 21 条）：左右 / 上下 / 90°，三个独立开关。 */
const flip = ref<CameraFlip>({ ...CAMERA_FLIP_NONE })

function toggleFlip(axis: keyof CameraFlip): void {
  flip.value = { ...flip.value, [axis]: !flip.value[axis] }
}

const videoTransform = computed(() => cameraFlipTransform(flip.value))

const flipActive = computed(
  () => flip.value.horizontal || flip.value.vertical || flip.value.quarter
)

// ---------------------------------------------------------------------------
// Camera NVR interactions: context menu, manual recording, snapshot, full screen
// ---------------------------------------------------------------------------

/**
 * 这些是**不属于相机状态**的界面事实，用来喂给纯函数 `buildCameraNvrMenu()`。
 * 菜单项的可用性判断只发生在那个函数里——面板按钮读的是同一个 `captureReadiness`，
 * 所以「菜单亮着但按钮灰着」这种漂移在结构上不可能发生。
 */
const stageEl = ref<HTMLElement | null>(null)
const fullscreen = ref(false)
const recording = ref(false)
const recordingStartedAt = ref(0)
const recordingElapsed = ref(0)
const recordingId = ref('')
const nvrBusy = ref(false)
const nvrError = ref('')
const nvrNotice = ref('')
const saveResultOpen = ref(false)
const saveResultKind = ref<'snapshot' | 'recording'>('snapshot')
const saveResultMessage = ref('')
/** 最近一次抓图的路径：提示条上的「打开所在文件夹」用它。 */
const lastSnapshotAbsolute = ref('')
const menuOpen = ref(false)
const menuX = ref(0)
const menuY = ref(0)
/**
 * 被右键的那一格所属的设备。
 *
 * 菜单是对**画面格**打开的，不是对整页打开的：动作必须作用在右键的那一格上。
 * 因此这里记住打开时的设备 id，而不是每次都读「当前所选设备」——两者今天相同
 * （相机页只有一格），但通道墙上会有多格，那时读所选设备就是错的。
 */
const menuDeviceId = ref('')
const alarmConditionDialogOpen = ref(false)
const alarmStrategyDialogOpen = ref(false)
/**
 * ⑤ 本机回放 / 检测记录下载两块弹窗的状态。
 *
 * 目标设备直接用 `nvrTargetId`（被右键的那一格，退回当前所选设备）：这一页只有
 * 一路画面，所以不需要画面墙那种"每格各记一份设备"的结构。
 */
const playbackOpen = ref(false)
/** 从「下载检测记录」接过来的那一段录像（下载 → 回放的真实闭环）。 */
const playbackPresetId = ref('')
const downloadOpen = ref(false)

function openPlaybackDialog(presetId = ''): void {
  playbackPresetId.value = presetId
  playbackOpen.value = true
}

/**
 * 下载完成后回放刚拿到的那一段。
 *
 * 下载下来的检测录像会被登记进**同一张录像表**，所以这不是一句客套话：关掉下载弹窗、
 * 带着这个录像 id 打开回放弹窗，操作员立刻能看到刚下载的画面（与画面墙同一条闭环）。
 */
function onDownloadedPlay(recordingId: string): void {
  downloadOpen.value = false
  if (recordingId === '') return
  openPlaybackDialog(recordingId)
}

/** NVR 动作的目标设备：优先用被右键的那一格，其次退回当前所选设备。 */
const nvrTargetId = computed(() => menuDeviceId.value || selectedDeviceId.value)

/** 录制计时器：只在录制中走，卸载/停止时一定清掉（否则会是一个静默泄漏）。 */
let recordingTimer: ReturnType<typeof setInterval> | undefined

function stopRecordingTimer(): void {
  if (recordingTimer !== undefined) {
    clearInterval(recordingTimer)
    recordingTimer = undefined
  }
}

function startRecordingTimer(startedAt: number): void {
  stopRecordingTimer()
  recordingStartedAt.value = startedAt
  recordingElapsed.value = Math.max(0, Date.now() - startedAt)
  recordingTimer = setInterval(() => {
    recordingElapsed.value = Math.max(0, Date.now() - recordingStartedAt.value)
  }, 500)
}

const readiness = computed(() => cameraCaptureReadiness(cameraLive.value))

const nvrEnvironment = computed<CameraNvrEnvironment>(() => ({
  deviceName: selectedDevice.value?.name ?? '',
  recording: recording.value,
  fullscreen: fullscreen.value,
  hasUsableSource: cameraActive.value,
  /**
   * 设备族能力：决定菜单项的**存在**，而不是是否可点。
   *
   * 声学相机有实时视频与「告警策略 + 告警条件」模型；声纹设备两者都没有
   * （它的告警档位走的是另一套接口）。所以在这台设备上，抓图/录像/RTSP 相关项
   * 与告警配置要么出现、要么根本不出现——不会出现一整屏永远点不动的灰项。
   */
  capabilities: {
    liveVideo: isCamera.value,
    alarmModel: isCamera.value,
    /*
     * ⑤ 与总览右键功能一致：本机录像回放与检测记录下载在这一页也真的实现了
     * （同一对弹窗组件），所以两项都声明为"有"。
     *
     * `tileClose` **故意不声明**：那是画面墙的"清空这一格"，而这一页只有一路画面，
     * 没有格可清 —— 停止这一路是页头那颗「停止」按钮的事。声明它只会多出一项
     * 语义重叠的菜单项（做不到就不出现，见 `camera-nvr.ts` 的规则一）。
     */
    localPlayback: true,
    detectDownload: true
  }
}))

/**
 * 菜单项 + 翻转上下文（业主 2026-09-21 第三批）。
 *
 * 三个翻转开关已从控制条移进右键菜单（本页专属）：把当前 `flip` 状态作为 context
 * 传进纯函数，「翻转」子菜单才存在、三项才带 ✓。画面墙不传 context —— 它的菜单
 * 保持原样（那是"这一格"的菜单，翻转不是画面格的能力）。
 */
const menuItems = computed<CameraNvrMenuItem[]>(() =>
  buildCameraNvrMenu(cameraLive.value, nvrEnvironment.value, { flips: flip.value })
    .filter((item) => item.action !== 'alarm-config')
)

/**
 * 抓图提示里的路径：优先显示存储根相对路径的尾部（绝对路径太长），
 * 「打开所在文件夹」用绝对路径。
 */
const snapshotLabel = computed(() => {
  const path = lastSnapshotAbsolute.value
  if (path === '') return ''
  const parts = path.split(/[\\/]/)
  return parts.slice(-3).join('/')
})

const saveResultTitle = computed(() =>
  saveResultKind.value === 'snapshot'
    ? t('cameraNvrUi.snapshotSavedTitle')
    : t('cameraNvrUi.recordSavedTitle')
)

function showSaveResult(kind: 'snapshot' | 'recording', message: string): void {
  saveResultKind.value = kind
  saveResultMessage.value = message
  saveResultOpen.value = true
}

function onCameraContextMenu(event: MouseEvent): void {
  // 浏览器原生菜单在监控软件里没有意义，而且会把我们的菜单顶掉。
  event.preventDefault()
  menuX.value = event.clientX
  menuY.value = event.clientY
  // 菜单记住**是哪一个画面格**被右键的。今天相机页只有一个画面格，但通道墙
  // 那边会有多个：如果动作只认「当前所选设备」，右键 B 格却对 A 格录像就只是
  // 时间问题。事件来自哪一格，动作就作用于哪一格。
  menuDeviceId.value = selectedDeviceId.value
  menuOpen.value = true
}

async function refreshRecordingState(): Promise<void> {
  const id = nvrTargetId.value
  if (!id) return
  const result = await callApi(() => window.api.cameraNvr.recordingState(id))
  const state = result.success ? unwrap(result)?.[0] : undefined
  if (state?.recording === true) {
    recording.value = true
    if (state.startedAt !== undefined) startRecordingTimer(state.startedAt)
    recordingId.value = ''
  } else if (!nvrBusy.value) {
    recording.value = false
    stopRecordingTimer()
  }
}

async function toggleManualRecording(): Promise<void> {
  const id = nvrTargetId.value
  if (!id || nvrBusy.value) return
  nvrBusy.value = true
  nvrError.value = ''
  nvrNotice.value = ''
  try {
    if (recording.value) {
      const result = await callApi(() => window.api.cameraNvr.stopRecording(id))
      recording.value = false
      stopRecordingTimer()
      if (!result.success) {
        nvrError.value = resultMessage(result)
        return
      }
      const saved = unwrap(result)
      if (saved) {
        recordingId.value = saved.recordingId ?? ''
        showSaveResult('recording', t('cameraNvrUi.recordSaved', {
          duration: formatDuration(saved.durationMs),
          size: formatBytes(saved.fileSize),
          path: saved.relativePath
        }))
        // 码流中途断掉时主进程会给出诊断；文件已保留，但必须让操作员看见。
        if (saved.warning) {
          nvrError.value = t('cameraNvrUi.recordWarning', { reason: saved.warning })
        }
      }
      return
    }

    const result = await callApi(() => window.api.cameraNvr.startRecording(id))
    if (!result.success) {
      nvrError.value = resultMessage(result)
      return
    }
    recording.value = true
    startRecordingTimer(unwrap(result)?.startedAt ?? Date.now())
  } finally {
    nvrBusy.value = false
  }
}

async function takeSnapshot(): Promise<void> {
  const id = nvrTargetId.value
  if (!id || nvrBusy.value) return
  nvrBusy.value = true
  nvrError.value = ''
  nvrNotice.value = ''
  try {
    const result = await callApi(() => window.api.cameraNvr.snapshot(id))
    if (!result.success) {
      nvrError.value = resultMessage(result)
      return
    }
    const captured = unwrap(result)
    if (!captured) return
    lastSnapshotAbsolute.value = captured.absolutePath
    showSaveResult('snapshot', t('cameraNvrUi.snapshotSaved', { path: snapshotLabel.value }))
  } finally {
    nvrBusy.value = false
  }
}

/** 「打开所在文件夹」：主进程只接受存储根内的路径（`StorageService.resolve`）。 */
async function revealSnapshot(): Promise<void> {
  if (lastSnapshotAbsolute.value === '') return
  const result = await callApi(() => window.api.app.revealFile(lastSnapshotAbsolute.value))
  if (!result.success) nvrError.value = resultMessage(result)
}

function toggleFullscreen(): void {
  if (!stageEl.value) return
  // Electron/Chromium's native Fullscreen API can be blocked by window focus or
  // permission policy. The product requirement is "make the video fill the app
  // window", not "put the whole OS window into browser fullscreen". A renderer-side
  // fixed layer is deterministic, keeps the same video element/session alive and
  // therefore cannot lose the RTSP viewer while switching in/out.
  fullscreen.value = !fullscreen.value
  menuOpen.value = false
}

function onFullscreenKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !fullscreen.value) return
  event.preventDefault()
  fullscreen.value = false
}

/**
 * 复制 RTSP 地址。
 *
 * 先向主进程要**可用**的地址（含口令，管理员通道）：打码地址贴进播放器是打不开的。
 * 拿不到就退回状态里那个打码地址，并且**明说**它是打码的——两种结果都用不同的
 * 提示语，让操作员知道剪贴板里到底是什么。
 */
async function copyRtspAddress(): Promise<void> {
  const id = nvrTargetId.value
  if (!id) return
  nvrError.value = ''
  const sourceResult = await callApi(() => window.api.cameraLive.source(id))
  const source = sourceResult.success ? unwrap(sourceResult) : undefined
  const text = source?.url ?? cameraLive.value?.rtspUrl ?? ''
  if (text === '') {
    nvrError.value = t('cameraNvrUi.reasonNoAddress')
    return
  }
  try {
    await navigator.clipboard.writeText(text)
    nvrNotice.value = source ? t('cameraNvrUi.copyDone') : t('cameraNvrUi.copyMaskedDone')
  } catch {
    nvrError.value = t('cameraNvrUi.copyFailed')
  }
}

async function openInExternalPlayer(): Promise<void> {
  const id = nvrTargetId.value
  if (!id) return
  nvrError.value = ''
  const result = await callApi(() => window.api.cameraLive.source(id))
  const source = result.success ? unwrap(result) : undefined
  if (!source) {
    nvrError.value = t('cameraNvrUi.reasonNoSource')
    return
  }
  const opened = await callApi(() => window.api.app.openExternal(source.url))
  if (!opened.success) nvrError.value = resultMessage(opened)
}

/**
 * 菜单派发：所有动作都在这里落地，视图里不再有第二份可用性判断。
 *
 * 菜单本身在执行完一个动作后会关闭（组件负责），这里只管做事。
 */
async function onMenuSelect(action: CameraNvrAction): Promise<void> {
  switch (action) {
    case 'toggle-recording':
      await toggleManualRecording()
      return
    case 'snapshot':
      await takeSnapshot()
      return
    case 'alarm-config':
      alarmConditionDialogOpen.value = true
      return
    case 'toggle-fullscreen':
      await toggleFullscreen()
      return
    case 'copy-rtsp':
      await copyRtspAddress()
      return
    case 'open-external':
      await openInExternalPlayer()
      return
    /*
     * 翻转（业主 2026-09-21 第三批从控制条移进菜单）：菜单项带当前状态的 ✓，
     * 切换走与控制条同一颗 `flip` ref —— 画面 transform 只有 `videoTransform` 一处。
     */
    case 'flip-horizontal':
      toggleFlip('horizontal')
      return
    case 'flip-vertical':
      toggleFlip('vertical')
      return
    case 'flip-quarter':
      toggleFlip('quarter')
      return
    /*
     * ⑤：这两项与总览的画面墙是同一对弹窗组件，所以这里的实现只有"打开哪一个"。
     * 列表、下载、回放的逻辑都在组件里，两处不会分叉。
     */
    case 'playback':
      openPlaybackDialog()
      return
    case 'download-detect':
      downloadOpen.value = true
      return
    default:
      return
  }
}

/**
 * 离开画面时把正在进行的录像正式收尾。
 *
 * 「切换设备 / 离开页面」不是「丢掉这段录像」：停止动作会走完整的收尾校验并把
 * 文件登记进录像表，因此这段素材仍然出现在录像列表里。反过来，如果什么都不做，
 * 主进程里就会留下一个没人看得见的 ffmpeg 在写文件。
 */
async function finaliseRecordingIfAny(): Promise<void> {
  if (!recording.value || nvrTargetId.value === '') return
  await toggleManualRecording()
}

/**
 * 从设备 Web 界面切回本软件时强制重读通道表。
 *
 * 通道的启用状态由设备侧决定（`/get_passageway` 的 `dchEn`），设备不会推配置变更
 * 事件；窗口重新获得焦点是最可靠的「操作员刚改完设备」信号。代价是一条很小的 GET，
 * 换来的是 CH5 / CH8 这类刚启用的通道能立刻出现在页签里。
 */
function refreshChannelsOnFocus(): void {
  if ((!isVoiceprint.value && !isGasLeak.value) || selectedDeviceId.value === '') return
  void devices.loadChannels(selectedDeviceId.value, true)
}

onMounted(async () => {
  document.addEventListener('keydown', onFullscreenKeydown, true)
  window.addEventListener('focus', refreshChannelsOnFocus)
  if (devices.devices.length === 0) await devices.load()
  /*
   * 每次进入这一页都重新允许一次自动起播（与总览页同一个口径，见
   * `resetAutoPlayAttempts()` 的注释）：第 21 条要的是"选中即自动播放"，
   * 而"一次进程一次尝试"会让第二次进入这一页时画面停着不动。
   * 「操作员按过停止」那一位**保留** —— 他明确不要的东西不因为换页面就回来。
   */
  syncFromRoute()
  if (selectedDeviceId.value) {
    // 通道表要先到手，初始通道才能避开被明确关闭的那几路。
    // force = true：设备侧的通道启用状态（dchEn）不会推送变更事件，缓存可能是
    // 上次打开页面时的旧值（实测：设备上把传感器从 CH1/CH2 改到 CH5/CH8 后，
    // 页签仍把 CH5/CH8 画成「已关闭」，点了也不切换）。
    await devices.loadChannels(selectedDeviceId.value, true)
    activeChannelIndex.value = preferredChannelIndex(selectedDeviceId.value)
    await loadSampleRateIfVoiceprint(selectedDeviceId.value)
    // A camera gets the live-video panel, not a WebSocket monitor session: its
    // channels are empty and its stream paths do not exist on the device.
    if (isCamera.value) {
      await refreshCameraState()
      // 主进程才是录像状态的权威：刷新页面后录制指示器必须能自己恢复，
      // 而不是显示成「没在录」。
      await refreshRecordingState()
      // 第 21 条：音量**记住**（每台设备一份）；这一路画面还没拿到用户手势，
      // 所以起播是静音的，出声要由音量那一次手势决定。
      liveVolume.value = loadCameraVolume(selectedDeviceId.value)
      audioUnlocked.value = false
      soundMuted.value = true
      // 第 24 条：告警信息（最近几条）与自动起播一起读一次。
      await loadDeviceAlarms(selectedDeviceId.value)
      await autoPlayCameraIfWorking()
    } else if (isGasLeak.value) {
      // 气井泄漏设备没有可开的实时流；本机告警录音由 GasLeakMonitorPanel 自己读。
      // 从声纹设备切过来时，上一台的四个 WebSocket 必须收干净。
      if (monitor.isRunning) await monitor.stop()
      await stopCameraLive()
      await stopBoxAudio()
    } else if (isVoiceprint.value) {
      // 第 13 批第 3 条：进页面就默认开始接收数据（判定见 `autoStartSessionIfNeeded`），
      // 页头那个「开始监测」按钮已经删掉。
      await autoStartSessionIfNeeded()
      // 每通道特性表里的「是否告警」与相机的告警入口读的是同一次查询。
      await loadDeviceAlarms(selectedDeviceId.value)
    }
    // 声呐那一支什么都不开：它的协议里没有我们要订的实时流（见 `isSonar` 的注释），
    // 而对着它开一条 `/features_stream` 只会让一台健康的设备显示成"监测起不来"。
  }
})

/**
 * 这一页也要参与「相机在工作就自动起播」。
 *
 * 产品原话是「软件打开如果是相机有在工作就自动播放视频」，而设备树的「实时视频」
 * 打开的正是本页（`/monitor?device=<id>`）。此前自动起播只写在总览页当时的单路播放器
 * （`CameraLiveSection.vue`，现已删除）里，于是同一个需求在两条入口上表现不同：
 * **总览页自动出画面，实时监测页停在「视频未启动」等操作员按按钮**。同一个产品需求不应该有两条答案。
 *
 * 判定仍然只走共享的 `decideCameraAutoPlay()`（`autoPlayIfWorking` 内部就是它），
 * 所以这一页**不会**绕开「一次进程一次尝试」「手动停止优先」这些既有约束，也不会
 * 另写一套「有在工作」的标准。
 *
 * `start` 与 `adopt` 之后必须重读一次会话状态：本页的 `cameraLive` 是本组件自己的
 * IPC 快照，不是 store 里的那一份，地址不会自己出现。
 */
async function autoPlayCameraIfWorking(): Promise<void> {
  // 实时监测页本身就是“看实时数据”的入口：进入页面后直接尝试起播，不再要求
  // 操作员先点播放，也不再受总览页的自动播放偏好开关影响。设备离线/RTSP 关闭时
  // startCameraLive() 会保留真实错误状态，不伪造一张黑色“正在播放”画面。
  await refreshCameraState()
  if (!cameraActive.value && cameraStatus.value !== 'starting') await startCameraLive()
}


// Keep the store's notion of "current device" in sync when the user switches.
watch(selectedDeviceId, async (id) => {
  cameraModeMismatch.value = null
  dismissedCameraMismatchKey.value = ''
  detectionRegions.value = []
  regionDrawMode.value = false
  regionEditorOpen.value = false
  detectionAreaLoadedDeviceId.value = ''
  detectionAreaError.value = ''
  detectionAreaNotice.value = ''
  regionDraft.value = null
  regionStart = null
  if (!id) return
  const live = isLive.value
  devices.select(id)
  await devices.loadChannels(id, true)
  void loadSampleRateIfVoiceprint(id)
  activeChannelIndex.value = preferredChannelIndex(id)
  monitor.selectDevice(id)
  if (isCamera.value) {
    // Leaving the box session running while a camera is displayed would keep four
    // sockets open on a device nobody is looking at.
    if (live) await monitor.stop()
    // ② 的预览声音也要停：切到相机之后还在响，操作员会以为是相机那一路的声音。
    await stopBoxAudio()
    // 正在录像时必须先收尾：录像子进程是主进程的，切设备不会自己停，
    // 而一个没有界面的录像等于一个看不见的 ffmpeg。
    await finaliseRecordingIfAny()
    await stopCameraLive()
    // 音量是**每台设备各记一份**的（同一间机房里两台相机的拾音电平可以差很多）。
    liveVolume.value = loadCameraVolume(id)
    // 新的一路画面：还没拿到用户手势，出声这件事要重新由音量那一次手势决定。
    audioUnlocked.value = false
    soundMuted.value = true
    await refreshCameraState()
    await refreshRecordingState()
    // 第 24 条：换了一台相机要重新读它的告警信息（否则列表还是上一台的）。
    await loadDeviceAlarms(id)
    // 第 21 条：**选中即自动播放**。挂在换设备这条路径上，与挂载那条走同一个
    // `autoPlayCameraIfWorking()` —— 两条入口读的是同一份判定，不会一个自动一个不自动。
    await autoPlayCameraIfWorking()
  } else if (isGasLeak.value) {
    // 气井泄漏设备没有可开的实时流；与声呐一样，先把上一台设备的会话收干净。
    await stopCameraLive()
    if (live) await monitor.stop()
    await stopBoxAudio()
    await finaliseRecordingIfAny()
  } else if (isSonar.value) {
    /*
     * 切到声呐：**把声纹设备那一套全部收干净**，然后什么都不开。
     * 这一支不订阅任何流，所以最容易出错的地方正好相反 —— 上一台设备的四条 WebSocket
     * 与预览声音如果留着，操作员会以为屏幕上那块正在播的就是眼前这台声呐。
     */
    await stopCameraLive()
    if (live) await monitor.stop()
    await stopBoxAudio()
    await finaliseRecordingIfAny()
  } else {
    // ...and the other way round: a live camera stream must not keep an ffmpeg
    // process running once the operator has switched to a box.
    await stopCameraLive()
    /*
     * 第 13 批第 3 条：换设备也默认开始接收数据。
     *
     * 这里**不能再**写成 `if (live) await startSession()`（改造前的样子，`live` 是
     * 切换前那一支的会话状态）：从相机/声呐切回声纹设备时 `live` 是 `false`，于是新设备
     * 的会话根本不会开 —— 而"开始监测"按钮已经按业主的要求删掉了，操作员只能刷新页面。
     * 判定改由 `autoStartSessionIfNeeded()` 统一回答；尝试计数是**每台设备**的，所以先清零。
     */
    resetAutoStartAttempts()
    await autoStartSessionIfNeeded()
    // 每通道特性表里那一列的告警属于**这一台**设备（否则显示的是上一台的）。
    await loadDeviceAlarms(id)
  }
  void router.replace({ path: '/monitor', query: { ...route.query, device: id } })
})

/**
 * RELEASE EVERYTHING.
 *
 * Both halves are required and they are not the same thing:
 *   - `stop()` closes the four WebSocket connections in the main process and
 *     releases its Ring Buffer, so the device stops streaming to nobody;
 *   - `unsubscribe()` calls the six unsubscribe functions returned by
 *     `window.events.on*` and clears the buffers. Those listeners live in the
 *     preload bridge, NOT in this component: skipping this call would keep the
 *     callback closures (and the JPEG/feature buffers) alive and decoding for
 *     the rest of the window's life, silently.
 *
 * `stop()` already releases the listeners internally; the explicit second call
 * is idempotent and documents the contract at the call site.
 */
onUnmounted(() => {
  document.removeEventListener('keydown', onFullscreenKeydown, true)
  window.removeEventListener('focus', refreshChannelsOnFocus)
  // 音量浮层的 click-outside 监听同理：组件没了，监听必须跟着掉。
  document.removeEventListener('mousedown', onVolumePopoverDocMouseDown, true)
  // 控制条浮层（音量 / 红外）的同一条监听同理。
  document.removeEventListener('mousedown', onCameraPopsDocMouseDown, true)
  // 菜单是 Teleport 到 body 的浮层，卸载时它不会跟着组件消失，必须显式关闭。
  menuOpen.value = false
  void monitor.stop()
  monitor.unsubscribe()
  // ② 的预览播放器：AudioContext 不会随组件卸载自己消失，必须显式关掉。
  void audioPlayer.close()
  // 录音计时器必须在卸载时清掉：它持有一个闭包，留着就是一个静默的泄漏。
  stopRecordingTimer()
  // 断流重试的"稳定 30 秒"计时器同理。
  if (liveStableTimer !== undefined) clearTimeout(liveStableTimer)
  // 正在进行的录像正式收尾（登记进录像表），而不是丢下一个隐藏的 ffmpeg。
  void finaliseRecordingIfAny()
  // The camera session owns an ffmpeg child process and a bound loopback port in the
  // main process; neither is released by navigation, so leaving the page must stop
  // it explicitly. `stopCameraLive` is a no-op when no session was started.
  void stopCameraLive()
})

const channelHint = computed(() => t('monitorUi.channelHint', { count: channelTabs.value.length }))

/**
 * 已启用通道数，与通道总数并排显示。
 *
 * 通道表还没到手时返回空串：此时“0 路已启用”会是撒谎，真正的情况是“不知道”。
 */
const enabledChannelSummary = computed(() => {
  const list = channels.value
  if (list.length === 0) return ''
  const enabled = list.filter((channel) => channelState(channel) === 'enabled').length
  return t('channelState.enabledSummary', { enabled, total: list.length })
})

const sessionLabel = computed(() => {
  if (monitor.state === 'running') return t('monitorUi.sessionRunning')
  if (monitor.state === 'starting') return t('monitorUi.sessionStarting')
  if (monitor.state === 'error') return t('monitorUi.sessionError')
  return t('monitorUi.sessionStopped')
})
</script>

<template>
  <div class="page">
    <EmptyState
      v-if="devices.devices.length === 0"
      :title="t('monitorUi.noDeviceTitle')"
    >
      <RouterLink class="btn btn--primary" to="/devices">{{ t('monitorUi.goToDevices') }}</RouterLink>
    </EmptyState>

    <template v-else>
      <!--
        **这一块原来是一条"没有活数据"的提示条**（第 10 批第 18 条要的），
        业主 2026-09-19 第 13 批第 1 条把它去掉了：

          「实时监测里面如果有告警弹窗（192.168.110.90 离线 还没有收到过这台设备的任何数据）
            这个内容不用显示」

        括号里那两句就是这条提示条在**离线且从来没收到过数据**时的正文（`offlineBanner` +
        `offlineNoContent`）。所以这里是**按他的原话撤掉整条**，不是换一句话 ——
        设备在不在线由页头设备名旁的 `StatusBadge` 回答（下拉旁那颗绿/灰点已于
        2026-09-21 第二批第 15 条删掉），而"数据停在哪一刻"由图上那个「上次内容」角标回答。

        **没有动的两件事**（他点名的是"这个内容"，不是这一整套行为）：
          · 六档状态机（`@shared/domain/monitor-offline.ts`）仍在，`stale` / `stopped`
            仍然决定角标出不出来；
          · 「上次内容」仍然保留并继续画（`monitor.content`）。
        它那四个词条（`offlineBanner` / `offlineNoIp` / `offlineLastContent` /
        `offlineNoContent`）与"提示条正文"那两个键（`staleBanner` / `stoppedBanner`）
        一起从四本目录里删掉了 —— 留着就是死键。冲突与取舍见 §15.78。
      -->

      <div class="camera-board" :class="{ 'camera-board--voiceprint': isVoiceprint }">
      <!--
        相机页的排布（业主 2026-09-21 第三批：65/35 左右两列）
        ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
        设备头仍整幅宽（`camera-board__wide`）。其下是 `.camera-split`：

          左列 65%                                右列 35%（纵向栈）
            单路直播（视频卡，无标题）              相机控制（检测模式/场景/启停）
            检测结果（文本列表 + 检测记录库）       告警配置（入口卡）
            告警结果（最近几条 + 查看告警记录）     一行会话状态（状态徽标 + 停止接收）
            声学波形（时域波形 + 电平表 + 播放）    声纹图（16:9）
                                                    频谱图（16:9）

        声学面板按 `sections` 拆成多份实例（`CameraAcousticPanel`），会话生命周期只有
        一个主人（`useFa371CameraSession()`，见 script）。声纹图与频谱图在右列**上下
        排列**（不再并排）；三个翻转开关从控制条移进了右键菜单（传 `context.flips`）。

        窄窗口（< 1100px）两列折成一列：左右栈先后落成一整条，控件一个都不会被裁掉。
        声纹/声呐两支不渲染 `.camera-split`，板子上其余子项的排布与加板子之前一致。
      -->
      <section class="card monitor-head camera-board__wide">
        <div class="monitor-head__row">
          <!--
            设备下拉**不在这里**：它被投到顶栏那一格（`#topbar-page-slot`，顶栏的 50% 宽）。
            理由（业主 2026-09-17）：「设备下拉移到顶栏，宽度 50%，删掉右侧状态字样」；
            第 6 条又把下拉收到那一格的 50% 并推到右边，紧挨着「设备数量」指示器
            （见下面 `.topbar-device` 的样式注释）——设备选择是**这一屏在看哪台设备**，
            与顶栏的设备总数/在线数/告警是同一件事，放在页头卡片里会让它和"状态"混成一块。
          -->
          <Teleport to="#topbar-page-slot">
            <label class="field topbar-device">
              <select
                v-model="selectedDeviceId"
                class="select"
                :aria-label="t('monitorUi.deviceLabel')"
                :title="t('monitorUi.deviceLabel')"
              >
                <option v-for="device in devices.devices" :key="device.id" :value="device.id">
                  {{ device.name }}（{{ device.ip || t('monitorUi.noAddress') }}）
                </option>
              </select>
            </label>
          </Teleport>

          <div v-if="selectedDevice" class="monitor-head__status">
            <StatusBadge
              :status="selectedDevice.status"
              :connection-type="selectedDevice.connectionType"
            />
            <!--
              角标：这一屏显示的数据**不是实时**的（业主第 18 条）。
              放在设备头这里而不是只挂在某一张图上：**三种机型**（声纹设备 / 声呐 / 相机）
              的图各不相同，而"你正在看的是上次内容"这句话对三种都成立。

              它**还要真的有一份上次内容**才显示：一台从来没推过数据的离线设备上写着
              「上次内容」就是在说一件不存在的事（那时由提示条那一句"还没有收到过"负责）。
            -->
            <span
              v-if="monitor.staleBadgeKey && monitor.content.fromLastContent"
              class="badge badge--warning"
              data-monitor-stale-badge
            >
              {{ t(monitor.staleBadgeKey) }}
            </span>
            <!--
              Box-only readouts. A camera has no channels and no WebSocket monitor
              session, so showing "0 channels" and "monitor stopped" next to it would
              describe the wrong device family.
            -->
            <template v-if="isVoiceprint">
      <DeviceLocationMap
        :installation="selectedDevice?.installation"
        :device-id="selectedDevice?.id"
        :device-name="selectedDevice?.name"
      />
              <span class="muted">{{ channelHint }}</span>
              <span v-if="enabledChannelSummary" class="muted">{{ enabledChannelSummary }}</span>
              <!--
                会话状态徽标。`data-monitor-session-badge` 是**给探针用的**标记属性
                （不带样式）：第 13 批第 3 条删掉了那个启停按钮之后，"进来到底有没有自动开始"
                只剩这一枚徽标能回答，而设备头里另有一枚「局域网/广域网」徽标（`StatusBadge`），
                靠"第几个 badge"去数是会数错的。
              -->
              <span
                class="badge"
                :class="monitor.isRunning ? 'badge--accent' : ''"
                data-monitor-session-badge
              >
                {{ sessionLabel }}
              </span>
            </template>
            <!--
              声呐（SN-16 空气声呐）：这一族**有**通道（16 路），但没有我们已经接入的实时流，
              所以这里给通道数 + 一句"实时流未接入"，而不是一个永远停在"监测已停止"的按钮。
            -->
            <template v-else-if="isGasLeak">
              <span class="muted">{{ channelHint }}</span>
              <span v-if="enabledChannelSummary" class="muted">{{ enabledChannelSummary }}</span>
              <span class="badge">{{ t('gasLeakUi.badge') }}</span>
            </template>
            <template v-else-if="isSonar">
              <span class="muted">{{ channelHint }}</span>
              <span v-if="enabledChannelSummary" class="muted">{{ enabledChannelSummary }}</span>
              <!--
                这里原来把那一长句（"实时音频/时频流尚未接入…"）挂在 `title` 上，同时页面顶上
                还有同一条横幅。业主 2026-09-18 第 19 条要求删掉那句话 —— 提示不再解释
                "这一屏为什么没有实时图"，在线与否由页头的状态徽标回答（下拉旁那颗
                绿点/灰点已于 2026-09-21 第二批第 15 条删掉）。
              -->
              <span class="badge">{{ t('monitorUi.sonarFamilyBadge') }}</span>
            </template>
            <template v-else>
              <!--
                相机当前**实际**检测模式（设备事实）。业主 2026-11-11：
                「相机的模式切换后，软件上好像没有直接显示」——不再只靠分析卡标题
                暗示，这里直接写出来；与软件配置不一致时变警告色并弹出确认。
              -->
              <span
                v-if="cameraActualWorkMode"
                class="badge"
                :class="{ 'badge--warning': cameraModeMismatch !== null }"
                data-camera-work-mode-badge
              >
                {{ t('cameraControlUi.detectionModeLabel') }}: {{ cameraDetectionModeText(cameraActualWorkMode) }}
              </span>
              <span :class="cameraBadgeClass">
                {{ cameraStatusLabel }}
              </span>
            </template>
          </div>

          <div class="spacer"></div>

          <!--
            「开始监测 / 停止监测」按钮**删掉了**（业主 2026-09-19 第 13 批第 3 条）：
            「实时监测里面选中哪个设备就默认开始接收数据，不用点击开始监测按钮」。
            会话状态没有丢，它就是上面那枚徽标（`sessionRunning` / `sessionStarting` /
            `sessionError` / `sessionStopped`）—— 徽标说明"现在是什么状态"，
            按钮只是"改变状态"的手段，而那个手段已经由自动开始接管
            （`autoStartSessionIfNeeded()` + `decideMonitorAutoStart()`）。
            相关的两个词条（`monitorUi.start` / `monitorUi.stop`）四本目录同步删除，
            理由见 §15.80。
          -->
        </div>

        <!-- 通道页签也是声纹设备专有的：相机的"通道"不存在，声呐的通道没有实时数据可切。 -->
        <nav v-if="isVoiceprint" class="channel-tabs" :aria-label="t('monitorUi.channelSelect')">
          <!-- 未启用的通道整块变灰且不可选；状态未知用另一种样式，两者不得混同。 -->
          <button
            v-for="tab in channelTabs"
            :key="tab.index"
            type="button"
            class="channel-tab"
            :class="[
              channelStateClass(tab.state),
              { 'channel-tab--active': tab.index === activeChannelIndex }
            ]"
            :disabled="isTabDisabled(tab)"
            :aria-disabled="isTabDisabled(tab)"
            :aria-label="tabAriaLabel(tab)"
            :title="tabHint(tab) || undefined"
            @click="selectChannel(tab.index)"
          >
            <span class="channel-tab__label">{{ tab.label }}</span>
            <span v-if="tab.name" class="channel-tab__name">{{ tab.name }}</span>
            <!-- 实时数据指示灯：开着却没有数据，和“被关掉”是两件事。 -->
            <span
              v-if="showActivity(tab)"
              class="channel-tab__live"
              :class="{ 'channel-tab__live--on': tabReceivesData(tab) }"
              :title="tabActivityLabel(tab)"
            >
              <span class="visually-hidden">{{ tabActivityLabel(tab) }}</span>
            </span>
          </button>
        </nav>
      </section>

      <!--
        覆盖层（右键菜单、告警对话框）在网格里用 `display: contents` 抵消掉 ——
        它们本身不画东西，但会多出一个"网格项"的占位，见 `.camera-board__overlay`。
      -->
      <!-- ------------------------------------------------------------------
           CAMERA LIVE VIDEO

           The camera publishes H.264 over RTSP, which Chromium cannot demux, so the
           main process re-muxes it with the bundled ffmpeg and serves it from a
           loopback-only HTTP server. This element loads that URL — the single network
           address the renderer is ever given, and the only reason the CSP carries
           `media-src http://127.0.0.1:*`.

           Every state below is reported honestly: "RTSP disabled" is a device fact,
           "ffmpeg missing" is an installation fact, and neither is ever shown as a
           black rectangle.

           视频卡**无标题**（业主 2026-09-21 第三批）：原来的标题行与状态徽标整行
           删掉 —— 状态由画面叠加条（.camera-live__overlay）回答，录制徽标保留；
           播放信息（已转发字节数 / 地址候选）那枚徽标的悬停说明随徽标一起去了
           控制条按钮的 title 与叠加条。
      ------------------------------------------------------------------ -->
      <div v-if="isCamera" class="camera-workspace">
        <!-- Top: live video + camera controls. -->
        <div class="camera-split camera-split--top">
          <div class="camera-split__main">
            <DeviceLocationMap
              :installation="selectedDevice?.installation"
              :device-id="selectedDevice?.id"
              :device-name="selectedDevice?.name"
            />

            <section class="card camera-live">
              <div
                ref="stageEl"
                class="camera-live__stage"
                :class="{
                  'camera-live__stage--fullscreen': fullscreen,
                  'camera-live__stage--drawing': regionDrawMode
                }"
                @contextmenu="onCameraContextMenu"
                @pointerdown="beginDetectionRegion"
                @pointermove="updateDetectionRegion"
                @pointerup="finishDetectionRegion"
                @pointercancel="finishDetectionRegion"
              >
                <video
                  v-if="cameraLiveUrl"
                  ref="videoEl"
                  class="camera-live__video"
                  :src="cameraLiveUrl"
                  :style="{ transform: videoTransform }"
                  :class="{
                    'camera-live__video--paused': picturePaused,
                    'camera-live__video--flipped': flipActive
                  }"
                  autoplay
                  muted
                  playsinline
                  @error="onVideoProblem"
                  @ended="onVideoProblem"
                  @loadeddata="onVideoReady"
                  @playing="onVideoReady"
                ></video>
                <div v-else class="camera-live__placeholder" :title="cameraStatusLabel" aria-live="polite">
                  <svg class="camera-live__placeholder-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 7h11v10H4zM15 10l5-3v10l-5-3z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
                  </svg>
                </div>

                <!-- Detection regions use normalized coordinates so resize/resolution changes do not move them. -->
                <div class="camera-detection-regions" aria-hidden="true">
                  <span
                    v-for="region in detectionRegions"
                    :key="region.id"
                    class="camera-detection-region"
                    :style="{
                      left: `${region.x * 100}%`,
                      top: `${region.y * 100}%`,
                      width: `${region.width * 100}%`,
                      height: `${region.height * 100}%`
                    }"
                  ></span>
                  <span
                    v-if="regionDraft"
                    class="camera-detection-region camera-detection-region--draft"
                    :style="{
                      left: `${regionDraft.x * 100}%`,
                      top: `${regionDraft.y * 100}%`,
                      width: `${regionDraft.width * 100}%`,
                      height: `${regionDraft.height * 100}%`
                    }"
                  ></span>
                </div>

                <!-- No text overlays in the video surface: recording is a visual indicator only. -->
                <span v-if="recording" class="camera-live__rec camera-live__rec--icon" role="status" :title="t('cameraNvrUi.menuStopRecording')">
                  <span class="camera-live__rec-dot" aria-hidden="true"></span>
                </span>

                <button
                  v-if="fullscreen"
                  type="button"
                  class="camera-live__fullscreen-exit"
                  :title="t('cameraNvrUi.menuExitFullscreen')"
                  :aria-label="t('cameraNvrUi.menuExitFullscreen')"
                  @pointerdown.stop
                  @click.stop="toggleFullscreen"
                >
                  <svg viewBox="0 0 18 18" aria-hidden="true">
                    <path d="M7 3.5V7H3.5M11 7h3.5V3.5M14.5 11H11v3.5M7 14.5V11H3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                </button>
              </div>

              <!-- Alarm-region controls intentionally live OUTSIDE the video surface.
                   This keeps the whole picture available for pointer drawing and avoids
                   a floating panel intercepting the first drag gesture. -->
              <aside
                v-if="regionEditorOpen"
                class="camera-detection-editor camera-detection-editor--external"
              >
                <div class="camera-detection-editor__header">
                  <strong>{{ t('cameraAlarmUi.tabRegions') }}</strong>
                  <span>{{ detectionRegions.length }}</span>
                </div>
                <div class="camera-detection-editor__actions">
                  <button type="button" class="btn btn--sm" :class="{ 'btn--primary': regionDrawMode }" @click="toggleRegionDrawMode">
                    {{ regionDrawMode ? t('cameraAlarmUi.regionDrawing') : t('cameraAlarmUi.regionDraw') }}
                  </button>
                  <button type="button" class="btn btn--sm" :disabled="detectionAreaBusy || detectionRegions.length === 0" @click="clearDetectionRegions">
                    {{ t('cameraAlarmUi.regionClear') }}
                  </button>
                  <button type="button" class="btn btn--sm" :disabled="detectionAreaBusy" @click="cancelAlarmRegionConfiguration">{{ t('common.cancel') }}</button>
                  <button type="button" class="btn btn--sm btn--primary" :disabled="detectionAreaBusy" @click="saveAlarmRegionConfiguration">{{ t('common.save') }}</button>
                </div>
                <p class="camera-detection-editor__hint">{{ t('cameraAlarmUi.regionDrawHint') }}</p>
                <p v-if="detectionAreaError" class="camera-detection-editor__error">{{ detectionAreaError }}</p>
                <p v-else-if="detectionAreaNotice" class="camera-detection-editor__notice">{{ detectionAreaNotice }}</p>
              </aside>

              <p v-if="nvrError" class="alert alert--danger" role="alert">{{ nvrError }}</p>
              <p v-else-if="nvrNotice" class="alert alert--success" role="status">
                {{ nvrNotice }}
                <button v-if="lastSnapshotAbsolute" type="button" class="btn btn--sm" @click="revealSnapshot">
                  {{ t('cameraNvrUi.openFolder') }}
                </button>
              </p>
              <p v-if="cameraMessage" :class="cameraAlertClass" role="status">{{ cameraMessage }}</p>

              <CameraRecorderBar :device-id="selectedDeviceId" />

              <!-- Icon-only player toolbar. Text is available only through title/aria-label. -->
              <div class="camera-controls camera-controls--icons" data-camera-controlbar>
                <button
                  type="button"
                  class="camera-control-btn camera-control-btn--icon"
                  :class="{ 'camera-control-btn--active': picturePaused }"
                  :disabled="!cameraActive"
                  :title="picturePaused ? t('cameraLiveUi.playPicture') : t('cameraLiveUi.pausePicture')"
                  :aria-label="picturePaused ? t('cameraLiveUi.playPicture') : t('cameraLiveUi.pausePicture')"
                  data-action="camera-pause"
                  @click="togglePicturePause"
                >
                  <svg class="camera-control-btn__icon" viewBox="0 0 18 18" aria-hidden="true">
                    <path v-if="picturePaused" d="M5.2 3.6 14 9l-8.8 5.4Z" fill="currentColor" />
                    <path v-else d="M5.2 3.8h2.6v10.4H5.2Zm5 0h2.6v10.4h-2.6Z" fill="currentColor" />
                  </svg>
                </button>

                <button
                  type="button"
                  class="camera-control-btn camera-control-btn--icon"
                  :class="{ 'camera-control-btn--active': cameraActive }"
                  :disabled="cameraBusy"
                  :title="cameraActive ? t('cameraLiveUi.stop') : cameraStatus === 'error' ? t('cameraLiveUi.retry') : t('cameraLiveUi.start')"
                  :aria-label="cameraActive ? t('cameraLiveUi.stop') : cameraStatus === 'error' ? t('cameraLiveUi.retry') : t('cameraLiveUi.start')"
                  data-action="camera-power"
                  @click="toggleCameraLive"
                >
                  <svg class="camera-control-btn__icon" viewBox="0 0 18 18" aria-hidden="true">
                    <path d="M9 2.7v6.1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                    <path d="M5.1 4.7a6 6 0 1 0 7.8 0" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                  </svg>
                </button>

                <span class="camera-controls__divider" aria-hidden="true"></span>

                <button
                  type="button"
                  class="camera-control-btn camera-control-btn--icon"
                  :class="{ 'camera-control-btn--recording': recording }"
                  :disabled="nvrBusy || !(recording || readiness.ready)"
                  :title="recording ? t('cameraNvrUi.menuStopRecording') : t('cameraNvrUi.menuStartRecording')"
                  :aria-label="recording ? t('cameraNvrUi.menuStopRecording') : t('cameraNvrUi.menuStartRecording')"
                  data-action="camera-record"
                  @click="toggleManualRecording"
                >
                  <span class="camera-control-btn__record-dot" aria-hidden="true"></span>
                </button>

                <button
                  type="button"
                  class="camera-control-btn camera-control-btn--icon"
                  :disabled="nvrBusy || !readiness.ready"
                  :title="t('cameraLiveUi.lookSnapshot')"
                  :aria-label="t('cameraLiveUi.lookSnapshot')"
                  data-action="camera-snapshot"
                  @click="takeSnapshot"
                >
                  <svg class="camera-control-btn__icon" viewBox="0 0 18 18" aria-hidden="true">
                    <path d="M3 5.7h3l1-1.6h4l1 1.6h3v8.2H3Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
                    <circle cx="9" cy="9.8" r="2.3" fill="none" stroke="currentColor" stroke-width="1.4" />
                  </svg>
                </button>

                <button type="button" class="camera-control-btn camera-control-btn--icon" :title="t('cameraLiveUi.lookPlayback')" :aria-label="t('cameraLiveUi.lookPlayback')" data-action="camera-playback" @click="playbackOpen = true">
                  <svg class="camera-control-btn__icon" viewBox="0 0 18 18" aria-hidden="true">
                    <path d="M3 9a6 6 0 1 0 1.8-4.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
                    <path d="M3 3.7v3.7h3.7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
                    <path d="m8 6.6 4 2.4-4 2.4Z" fill="currentColor" />
                  </svg>
                </button>

                <span class="camera-controls__divider" aria-hidden="true"></span>

                <span v-if="hasInfraredFrames" class="camera-controls__anchor">
                  <button
                    type="button"
                    class="camera-control-btn camera-control-btn--icon"
                    :class="{ 'camera-control-btn--active': infraredOpen }"
                    :aria-expanded="infraredOpen"
                    :aria-label="t('cameraLiveUi.infrared')"
                    :title="t('cameraLiveUi.infrared')"
                    data-camera-infrared
                    @click="infraredOpen = !infraredOpen"
                  >
                    <svg class="camera-control-btn__icon" viewBox="0 0 18 18" aria-hidden="true">
                      <path d="M9 2.4a2.8 2.8 0 0 1 2.8 2.8v4.5a3.7 3.7 0 1 1-5.6 0V5.2A2.8 2.8 0 0 1 9 2.4Z" fill="none" stroke="currentColor" stroke-width="1.4" />
                      <circle cx="9" cy="11.2" r="1.5" fill="currentColor" />
                    </svg>
                  </button>
                  <div v-if="infraredOpen" class="camera-controls__pop camera-controls__infrared" data-camera-infrared-pop>
                    <dl class="camera-infrared__grid">
                      <dt>{{ t('realtimeUi.metric.centerTemp') }}</dt><dd>{{ infraredValue(infraredFrame?.centerTemp) }}</dd>
                      <dt>{{ t('realtimeUi.metric.maxTemp') }}</dt><dd>{{ infraredValue(infraredFrame?.maxTemp) }}</dd>
                      <dt>{{ t('realtimeUi.metric.minTemp') }}</dt><dd>{{ infraredValue(infraredFrame?.minTemp) }}</dd>
                      <dt>{{ t('cameraLiveUi.infraredEmissivity') }}</dt><dd>{{ infraredValue(infraredFrame?.emissivity, 2) }}</dd>
                    </dl>
                  </div>
                </span>

                <span class="camera-controls__volume">
                  <button
                    type="button"
                    class="camera-control-btn camera-control-btn--icon"
                    :class="{ 'camera-control-btn--active': liveSoundOn }"
                    :disabled="!cameraActive"
                    :aria-expanded="cameraVolumeOpen"
                    :aria-label="liveVolumeLabel"
                    :title="liveVolumeLabel"
                    data-camera-volume-trigger
                    @click="cameraVolumeOpen = !cameraVolumeOpen"
                  >
                    <svg class="camera-control-btn__icon" viewBox="0 0 18 18" aria-hidden="true">
                      <path d="M3.2 6.8h2.6L9.5 3.7v10.6l-3.7-3.1H3.2Z" fill="currentColor" />
                      <path v-if="liveSoundOn" d="M12 6a4 4 0 0 1 0 6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
                      <path v-else d="m12 6.4 3 5.2m0-5.2-3 5.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
                    </svg>
                  </button>
                  <div v-if="cameraVolumeOpen" class="camera-controls__pop camera-controls__volume-pop" data-camera-volume-pop>
                    <input type="range" min="0" max="100" step="1" class="camera-controls__slider" data-action="camera-volume" :value="liveVolumePercent" :disabled="!cameraActive" :aria-label="liveVolumeLabel" :title="liveVolumeLabel" @input="onLiveVolumeInput" />
                    <button type="button" class="camera-control-btn camera-control-btn--icon camera-control-btn--light" :class="{ 'camera-control-btn--active': !soundMuted && liveVolume > 0 }" :disabled="!cameraActive" :aria-pressed="!soundMuted" :aria-label="liveVolumeLabel" :title="liveVolumeLabel" data-action="camera-volume-mute" @click="toggleSoundMute">
                      <svg class="camera-control-btn__icon" viewBox="0 0 18 18" aria-hidden="true">
                        <path d="M3.2 6.8h2.6L9.5 3.7v10.6l-3.7-3.1H3.2Z" fill="currentColor" />
                        <path v-if="!soundMuted" d="M12 6a4 4 0 0 1 0 6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
                        <path v-else d="m12 6.4 3 5.2m0-5.2-3 5.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
                      </svg>
                    </button>
                  </div>
                </span>

                <!--
                  「添加到视频墙」（业主 2026-09-24：「打开预览看到有视频，应该能直接
                  添加进去」）：有画面的相机一键进总览的视频墙——第一个空格，墙满了
                  进轮询队列，已在墙上时按钮就是状态而不是动作。
                -->
                <button
                  type="button"
                  class="camera-control-btn camera-control-btn--icon"
                  :class="{ 'camera-control-btn--active': cameraOnWall }"
                  :disabled="cameraOnWall"
                  :title="cameraOnWall ? t('monitorUi.onWall') : t('monitorUi.addToWall')"
                  :aria-label="cameraOnWall ? t('monitorUi.onWall') : t('monitorUi.addToWall')"
                  data-action="add-to-wall"
                  @click="addCameraToWall"
                >
                  <svg class="camera-control-btn__icon" viewBox="0 0 18 18" aria-hidden="true">
                    <rect x="2.5" y="2.5" width="5.5" height="5.5" fill="none" stroke="currentColor" stroke-width="1.4" />
                    <rect x="10" y="2.5" width="5.5" height="5.5" fill="none" stroke="currentColor" stroke-width="1.4" />
                    <rect x="2.5" y="10" width="5.5" height="5.5" fill="none" stroke="currentColor" stroke-width="1.4" />
                    <path d="M12.75 10v5.5M10 12.75h5.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
                  </svg>
                </button>

                <button type="button" class="camera-control-btn camera-control-btn--icon" :class="{ 'camera-control-btn--active': fullscreen }" :title="fullscreen ? t('cameraNvrUi.menuExitFullscreen') : t('cameraNvrUi.menuFullscreen')" :aria-label="fullscreen ? t('cameraNvrUi.menuExitFullscreen') : t('cameraNvrUi.menuFullscreen')" @click="toggleFullscreen">
                  <svg class="camera-control-btn__icon" viewBox="0 0 18 18" aria-hidden="true">
                    <path d="M3.5 7V3.5H7M11 3.5h3.5V7M14.5 11v3.5H11M7 14.5H3.5V11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                </button>

                <span class="camera-controls__live-dot" :class="{ 'camera-controls__live-dot--on': cameraStatus === 'playing' }" :title="cameraStatusLabel" aria-hidden="true"></span>
              </div>
            </section>
          </div>

          <div class="camera-split__side">
            <CameraControlPanel
              :device-id="selectedDeviceId"
              :sections="['mode', 'detect', 'preset']"
              :alarm-count="cameraAlarmUnacknowledgedCount"
              :configured-work-mode="cameraWorkMode"
              @work-mode-observed="onCameraWorkModeObserved"
              @work-mode-change="onCameraWorkModeChange"
              @alarm-condition-config="alarmConditionDialogOpen = true"
              @alarm-strategy-config="alarmStrategyDialogOpen = true"
              @alarm-region-config="openAlarmRegionConfiguration"
            />
          </div>
        </div>

        <!--
          Realtime acoustic workspace: the first row is the two large analysis charts;
          the second row is mode-specific analysis (PRPD / leakage / mechanical) plus alarms.
          The former Realtime Audio card is intentionally removed.
        -->
        <div class="camera-realtime-grid">
          <CameraAcousticPanel :sections="['voiceprint']" :show-status="false" :work-mode="cameraWorkMode" />
          <CameraAcousticPanel :sections="['spectrum']" :show-status="false" :work-mode="cameraWorkMode" />
          <CameraAcousticPanel :sections="['mode']" :show-status="false" :work-mode="cameraWorkMode" />

          <section class="card camera-alarm-result camera-alarm-history-card">
            <div class="section-header camera-alarm-result__header">
              <div class="camera-alarm-result__heading">
                <span class="camera-alarm-result__indicator" :class="{ 'camera-alarm-result__indicator--quiet': cameraAlarmUnacknowledgedCount === 0 }" aria-hidden="true"></span>
                <h3 class="section-title">{{ t('cameraAlarmUi.recentTitle') }}</h3>
                <!--
                  角标口径与**顶栏那颗告警图标**一致（业主 2026-09-26 第 2 条：
                  「告警控制里面显示的是 200 个告警，这内容应该和软件整体右上角的告警 ICON
                  一致」）：只数这台设备**还没确认**的告警条数。

                  改之前这里数是 `cameraLinkageAlarms.length`（这台设备在联动待处理列表里的
                  **全部**条目，上限 200）—— 于是一屏已经处理完的历史告警一直把角标顶在
                  上限或历史总数上，与顶栏那个"还有多少事没看"的数字对不上。
                -->
                <span class="camera-alarm-result__count" data-camera-alarm-count>{{ cameraAlarmUnacknowledgedCount }}</span>
              </div>
              <!--
                相机告警的完整证据链在事件中心（/events 支持 ?device= 预置筛选）；
                /alarms 这张表只有听诊盒子的告警，指过去对相机就是空页（2026-09-24 修）。
              -->
              <RouterLink class="btn btn--sm" :to="{ path: '/events', query: { device: selectedDeviceId } }" data-link="camera-alarm-history">
                {{ t('cameraAlarmUi.goAlarmList') }}
              </RouterLink>
            </div>
            <!--
              相机告警只存在于联动引擎的待处理列表（`cameraLinkageAlarms`），不在本地
              `alarms` 表 —— 那张表只有听诊盒子的告警。总开关关着时列表必然为空，
              空态里直接把这句话说出来，否则操作员分不清"没告警"与"功能没开"。
            -->
            <div class="camera-alarm-entry__list" data-camera-alarms>
              <p v-if="cameraLinkageAlarms.length === 0 && linkageDisabled" class="muted camera-alarm-result__empty" data-camera-alarms-empty>
                {{ t('cameraAlarmUi.linkageDisabledHint') }}
              </p>
              <p v-else-if="cameraLinkageAlarms.length === 0" class="muted camera-alarm-result__empty" data-camera-alarms-empty>{{ t('cameraAlarmUi.noAlarms') }}</p>
              <template v-else>
                <!--
                  告警内容 = 相机推送过来的字段本身（2026-09-24 业主：把推送内容展示出来）。
                  业主 2026-09-26 第 1 条要求它有**统一标题格**，五列固定：
                  时间 / 告警等级 / 告警类型 / 声场强度 / 主频。

                  为什么是"五列固定"而不是"按模式取舍列"：这是一张**设备原始输出的表**，
                  列在数据到达之前就存在（没有值的那一格显示 `—`，不隐藏、不写 0）。
                  逐格取值的规则仍在 `lib/linkageText.ts`（与铃铛面板同一套口径），
                  所以同一行在这里与在面板里是同一个数。
                -->
                <table class="camera-alarm-table">
                  <thead>
                    <tr>
                      <th scope="col" class="camera-alarm-table__time">{{ t('alarmsUi.columnTime') }}</th>
                      <th scope="col" class="camera-alarm-table__level">{{ t('alarmsUi.columnSeverity') }}</th>
                      <th scope="col">{{ t('alarmsUi.columnType') }}</th>
                      <th scope="col" class="camera-alarm-table__num">{{ t('cameraAlarmUi.columnIntensity') }}</th>
                      <th scope="col" class="camera-alarm-table__num">{{ t('cameraAlarmUi.columnMainFrequency') }}</th>
                      <th scope="col" class="camera-alarm-table__action">
                        <span class="sr-only">{{ t('alarmsUi.menuDetail') }}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="alarm in pagedCameraAlarms"
                      :key="alarm.eventId"
                      class="camera-alarm-table__row"
                      :data-camera-alarm="alarm.eventId"
                      role="link"
                      tabindex="0"
                      :title="t('cameraAlarmUi.openAlarmDetail')"
                      @click="openCameraAlarmDetail(alarm)"
                      @keydown.enter="openCameraAlarmDetail(alarm)"
                    >
                      <td class="camera-alarm-table__time">{{ formatDateTime(alarm.at) }}</td>
                      <td>
                        <span class="badge" :class="`badge--severity-${linkageSeverityOf(alarm)}`">
                          {{ alarm.alarmLevelRaw === undefined ? '—' : `${t('linkage.pendingLevel')} ${alarm.alarmLevelRaw}` }}
                        </span>
                      </td>
                      <td class="camera-alarm-table__type">{{ cameraAlarmTypeText(alarm) }}</td>
                      <!-- `—` = 设备这一次没有报这个量；绝不写 0（那会被读成"测到了 0"）。 -->
                      <td class="camera-alarm-table__num">{{ linkageIntensityValue(alarm) || '—' }}</td>
                      <td class="camera-alarm-table__num">{{ linkageFrequencyValue(alarm) || '—' }}</td>
                      <td class="camera-alarm-table__action">
                        <span v-if="!alarm.acknowledged" class="camera-alarm-table__unack" aria-hidden="true"></span>
                      </td>
                    </tr>
                  </tbody>
                </table>

                <!--
                  换页（业主 2026-09-26 第 1 条：「告警数量应该支持自动换页的功能」）。
                  每页固定 `CAMERA_ALARM_PAGE_SIZE` 行，设备切换/新告警到达时页码自动夹回范围内，
                  所以不会停在一个空页上。
                -->
                <div v-if="cameraAlarmPages > 1" class="camera-alarm-pager" data-camera-alarm-pager>
                  <button
                    type="button"
                    class="btn btn--sm"
                    data-action="camera-alarm-prev"
                    :disabled="cameraAlarmPage <= 1"
                    @click="cameraAlarmPage -= 1"
                  >
                    {{ t('alarmsUi.prevPage') }}
                  </button>
                  <span class="muted camera-alarm-pager__status" data-camera-alarm-page>
                    {{ t('cameraAlarmUi.pageStatus', { page: cameraAlarmPage, pages: cameraAlarmPages }) }}
                  </span>
                  <button
                    type="button"
                    class="btn btn--sm"
                    data-action="camera-alarm-next"
                    :disabled="cameraAlarmPage >= cameraAlarmPages"
                    @click="cameraAlarmPage += 1"
                  >
                    {{ t('alarmsUi.nextPage') }}
                  </button>
                </div>
              </template>
            </div>
          </section>
        </div>
      </div>

      <!--
        * 右键菜单、告警配置、本机回放、检测记录下载四个弹窗。
        *
        * 菜单的位置/键盘/关闭行为全部封在 `VideoContextMenu` 里（含「不越出窗口
        * 边缘」），这里只提供菜单项（来自纯函数）和动作派发。
        *
        * 后两个弹窗（⑤）与总览的画面墙用的是**同一对组件**，所以"与总览右键功能一致"
        * 不是两套实现的相似，而是同一套实现：列表、下载、回放行为不会分叉。
      -->
      <VideoContextMenu
        class="camera-board__overlay"
        :open="menuOpen"
        :x="menuX"
        :y="menuY"
        :title="t('cameraNvrUi.menuTitle', { name: selectedDevice?.name ?? '' })"
        :items="menuItems"
        @select="onMenuSelect"
        @close="menuOpen = false"
      />

      <CameraAlarmDialog
        class="camera-board__overlay"
        v-model="alarmConditionDialogOpen"
        section="conditions"
        :device-id="selectedDeviceId"
        :device-name="selectedDevice?.name ?? ''"
      />

      <CameraAlarmDialog
        class="camera-board__overlay"
        v-model="alarmStrategyDialogOpen"
        section="strategies"
        :device-id="selectedDeviceId"
        :device-name="selectedDevice?.name ?? ''"
      />

      <AppModal
        v-model="saveResultOpen"
        :title="saveResultTitle"
        width="480px"
        :close-on-overlay="false"
      >
        <p>{{ saveResultMessage }}</p>
        <template #footer>
          <button
            v-if="saveResultKind === 'snapshot' && lastSnapshotAbsolute"
            type="button"
            class="btn"
            @click="revealSnapshot"
          >
            {{ t('cameraNvrUi.openFolder') }}
          </button>
          <button type="button" class="btn btn--primary" @click="saveResultOpen = false">
            {{ t('common.close') }}
          </button>
        </template>
      </AppModal>

      <!-- 本机录像回放：这一页只有一台设备，所以目标就是被右键/所选的那一台。 -->
      <CameraRecordingPlaybackDialog
        class="camera-board__overlay"
        v-model="playbackOpen"
        :device-id="nvrTargetId"
        :device-name="selectedDevice?.name ?? ''"
        :preset-recording-id="playbackPresetId"
      />

      <!-- 设备检测记录下载：下载完成的那一段可以直接接着回放（与画面墙同一条闭环）。 -->
      <CameraDetectDownloadDialog
        class="camera-board__overlay"
        v-model="downloadOpen"
        :device-id="nvrTargetId"
        :device-name="selectedDevice?.name ?? ''"
        @play="onDownloadedPlay"
      />

      <!-- ------------------------------------------------------------------
           实时视频墙在这里**已被删除**（业主 2026-09-17：⑦「删实时视频墙」）。

           为什么删的是这一处而不是组件：多路视频墙在**总览**页仍然是主视图
           （`OverviewView` 用它做整页的相机格子），而实时监测页的职责是"看一台设备"。
           两个页面各挂一次同一块墙，等于同一批视频流有两份起播逻辑与两份音量状态。
      ------------------------------------------------------------------ -->
      </div>

      <!-- ---- acoustic box / 声纹设备（改造后逐像素不变） ----------------- -->
      <template v-if="isVoiceprint">
      <p v-if="monitor.error" class="alert alert--danger" role="alert">{{ monitor.error }}</p>

      <!--
        「数据流状态」那张卡片（`monitorUi.streamSection` 的 stream strip）按业主
        2026-09-17 的要求删掉了（③）。但**失败不能因此变哑**：原来那张卡片的真正价值是
        "哪一路坏了"，所以这里保留**一句话**：有流进入 ERROR 就把它连同最近一条错误写出来。
      -->
      <p v-else-if="streamFailure" class="alert alert--warning" role="alert">
        {{ streamFailure }}
      </p>

      <!--
        ③b 实时趋势**挪到最上面**（业主 2026-09-17：「把实时趋势挪到视频墙的位置」）。

        为什么它在最上面：这一支页面上最该一直盯着的东西就是趋势曲线（当前通道的哪个指标
        在怎么变），而改造前它被统计卡与音频条压在下面 —— 一进页面要滚动才看得到。
        原来占这个位置的是多路视频墙，它按 ⑦ 删掉了。

        2026-09-21 第二批：这张卡现在是**两块合一** —
          · 左侧 70% 趋势图 + 右侧 30% 当前值四行（Item 20，原先底下四张 MetricCard 已删）；
          · 卡头是「单通道 / 检测」的视图切换（Item 24）与单通道趋势的指标 chips。
          （时间轴回放原来挂在图下，业主 20260921 又要求撤掉 —— 趋势 X 轴的缩放/平移
          已覆盖"按时间找段"；见下方原位置的注释。）
      -->
      <section class="chart-panel card trend-panel">
        <div class="section-header">
          <h3 class="section-title">{{ t('monitorUi.trendSection') }}</h3>
          <div class="trend-panel__header-actions">
            <!--
              Item 24：单通道 / 检测 的 segmented 视图切换（选择只记组件 ref，不持久化）。
              检测 = 四张指标卡（声压级/平稳度/能量比/主频）× 每通道一色，最多 8 条；
              数据随原订阅来，不额外开设备连接。
            -->
            <div class="view-mode" role="group" :aria-label="t('monitorUi.viewMode')">
              <button
                type="button"
                class="view-mode__button"
                :class="{ 'view-mode__button--active': viewMode === 'single' }"
                :aria-pressed="viewMode === 'single'"
                data-view-mode="single"
                @click="viewMode = 'single'"
              >
                {{ t('monitorUi.modeSingle') }}
              </button>
              <button
                type="button"
                class="view-mode__button"
                :class="{ 'view-mode__button--active': viewMode === 'detect' }"
                :aria-pressed="viewMode === 'detect'"
                data-view-mode="detect"
                @click="viewMode = 'detect'"
              >
                {{ t('monitorUi.modeDetect') }}
              </button>
            </div>
            <div class="chip-row">
              <button
                v-for="metric in TREND_METRICS"
                :key="metric.key"
                type="button"
                class="chip chip--selectable"
                :class="{ 'chip--accent': trendMetric === metric.key }"
                @click="trendMetric = metric.key"
              >
                {{ t(metric.labelKey) }}
              </button>
            </div>
            <!--
              检测模式的数据源口径（monitorUi.detectDataNote：设备一次只开一路流，跨通道
              时间不同步）收在这颗 ⓘ 的悬停提示里 —— 原来整句写在检测卡网格下方，
              业主 20260921 要求只留一个悬浮入口。`cursor: help` 提示"悬停有说明"。
            -->
            <button
              type="button"
              class="trend-panel__info"
              data-trend-info
              :title="t('monitorUi.detectDataNote')"
              :aria-label="t('monitorUi.detectDataNote')"
            >
              i
            </button>
          </div>
        </div>

        <!--
          Item 20：横向排 —— 左 70% 趋势图，右 30% 当前值纵列。
          窄屏（<900px）回落上下排列（样式里的媒体查询）。
        -->
        <div class="trend-panel__body">
          <div class="trend-panel__chart">
            <EChart
              :option="trendOption"
              height="240px"
              :placeholder="monitor.content.features.length === 0 ? t('monitorUi.waitingFeatures') : ''"
              @datazoom="onTrendZoom"
            />
          </div>
          <!--
            右侧纵列：声压级 / 主频 / 频带能量比 / 平稳度四行（业主点名），
            值取 monitor.latest（features 最后一帧 = 当前订阅那一路的最新读数），
            没有数据显示 —（不是 0）。扩展指标（奇偶谐波比/频谱复杂度/指纹变化度，
            设备没上报就不画）以小号排在四行之后。
          -->
          <div class="trend-panel__stats">
            <p class="trend-panel__stats-title">
              {{ t('monitorUi.currentValue', { channel: channelLabel(activeChannelIndex) }) }}
            </p>
            <dl class="trend-stats">
              <div v-for="row in trendStatRows" :key="row.key" class="trend-stats__row">
                <dt class="trend-stats__label">{{ t(row.labelKey) }}</dt>
                <dd class="trend-stats__value" :data-trend-stat="row.key">
                  <template v-if="row.value !== undefined">
                    {{ formatNumber(row.value, row.precision) }}<span v-if="row.unit" class="trend-stats__unit">{{ row.unit }}</span>
                  </template>
                  <template v-else>—</template>
                </dd>
              </div>
              <div v-for="metric in extendedMetrics" :key="metric.key" class="trend-stats__row trend-stats__row--extended">
                <dt class="trend-stats__label">{{ metric.label }}</dt>
                <dd class="trend-stats__value trend-stats__value--extended" :data-trend-stat="metric.key">
                  {{ metric.value !== undefined ? formatNumber(metric.value, 3) : '—' }}
                </dd>
              </div>
            </dl>
          </div>
        </div>

        <!--
          时间轴回放原来挂在这里（趋势卡内的 .trend-panel__playback，业主 2026-09-21
          第二批「合并到实时趋势里面」）——按业主 20260921 后续要求**整块撤掉**：
          趋势图 X 轴的缩放/平移（EChart 的 datazoom）已经覆盖了"按时间找一段"这件事，
          再挂一条时间轴是同一件事的第二处实现。声呐分支那一支的时间轴
          （本页下方 isSonar 分支）不在此次范围内，保留不动。
        -->
      </section>

      <!--
        ③b 其下四张图谱卡片（业主确认的四张）：频谱 / 时频图 / 声学波形 / 每通道声纹特性。

        四张都是这一族**真实存在**的数据：频谱来自 /freq_domain（1024 个 bin + binHz），
        时频图是设备自己推的 JPEG，声学波形是跨 IPC 过来的降采样包络（与「播放」按钮听到的
        是同一份数据），每通道声纹特性是每一路最后一次读数。没有为了凑满四张而造数据源。

        列数由这一块自己的宽度决定（auto-fit + 最小 420px），与 §15.31 的图谱排同一套理由：
        媒体查询问的是窗口，不是这一块。

        Item 24：检测模式下这一块整体隐藏（`v-show`，流与组件都留着，只是不显示），
        换成下面那四张 2×2 检测卡。
      -->
      <div v-show="viewMode === 'single'" class="graph-grid">
        <!--
          ② 每通道声纹特性（业主 2026-09-17 要求的卡片；2026-09-19 第 13 批第 3 条改成表）。

          位置：**挪到原来的「频谱」那一格**（业主原话「把这个卡片挪到当前的频谱卡片的位置」），
          于是频谱卡整体后移一格。四张卡片的**高度现在一致**（`.graph-grid` 从
          `align-items: start` 改成默认的 `stretch`）—— 业主说「高度和左边的一致」，
          而"左边"取决于窗口宽度下这一排到底并了几列，只有让同一行的卡片互相撑齐才能
          在任何宽度下都成立（写死一个高度只会在某个宽度上刚好）。

          内容：8 行 × （通道序号 / 声压级 / 主频 / 平稳度 / 频带能量比 / 是否告警），
          每页 4 行翻页（第 22 条）。四列读数仍然只来自**本机订阅过的那一路**
          （设备一次只开一路流，见 4.3），所以第一格里那枚读数状态圆点和读数时间
          必须留着：`stored` 的数字是上一次读到的，没有时间它就与"实时"在视觉上没有区别。
        -->
        <section class="card chart-panel channel-features">
          <div class="section-header">
            <h3 class="section-title">{{ t('monitorUi.channelFeaturesSection') }}</h3>
          </div>

          <div class="channel-features__body">
            <table class="channel-table" data-channel-feature-table>
              <caption class="visually-hidden">{{ t('monitorUi.channelFeaturesSection') }}</caption>
              <thead>
                <tr>
                  <th scope="col">{{ t('monitorUi.channelFeatureColumnChannel') }}</th>
                  <th scope="col">{{ t('metrics.spl') }}</th>
                  <th scope="col">{{ t('metrics.mainFrequency') }}</th>
                  <th scope="col">{{ t('metrics.smoothness') }}</th>
                  <th scope="col">{{ t('metrics.bandEnergyRatio') }}</th>
                  <th scope="col">{{ t('monitorUi.channelFeatureColumnAlarm') }}</th>
                </tr>
              </thead>
              <tbody>
                <!--
                  整行可点 = 切这一路通道（业主：「点这个通道…三张卡就跟着切」）。
                  这一页的三张图（频谱/时频域/声学波形）只能显示**当前订阅的那一路**，
                  点行就是让它们跟着走 —— 走的仍然是共享的 `selectChannel()`
                  （未启用的通道不参与实时监测，那一行整块灰掉且点不动）。
                -->
                <tr
                  v-for="row in pagedChannelFeatureRows"
                  :key="row.index"
                  class="channel-table__row"
                  :class="[
                    channelStateClass(row.state),
                    { 'channel-table__row--active': row.index === activeChannelIndex }
                  ]"
                  :data-channel-feature-row="row.index"
                  @click="selectChannel(row.index)"
                >
                  <th scope="row" class="channel-table__channel">
                    <button
                      type="button"
                      class="channel-table__select"
                      :class="{ 'channel-table__select--active': row.index === activeChannelIndex }"
                      :disabled="isTabDisabled(row)"
                      :aria-pressed="row.index === activeChannelIndex"
                      :title="tabHint(row) || undefined"
                      @click.stop="selectChannel(row.index)"
                    >
                      <span class="channel-table__label">{{ row.label }}</span>
                      <span v-if="row.name" class="channel-table__name">{{ row.name }}</span>
                      <!--
                        读数状态（业主 2026-09-21 第二批第 17 条）：只画一枚 8px 圆点 ——
                        绿=有读数（实时或最后一次读数）、红=未读取。文字徽标删掉了，
                        状态文字进 title / aria-label（键复用 channelFeatureStateLabelKey）。
                      -->
                      <span
                        class="channel-table__feature-dot"
                        :class="
                          row.featureState === 'unread'
                            ? 'channel-table__feature-dot--miss'
                            : 'channel-table__feature-dot--ok'
                        "
                        role="img"
                        :title="t(channelFeatureStateLabelKey(row.featureState))"
                        :aria-label="t(channelFeatureStateLabelKey(row.featureState))"
                      ></span>
                      <!--
                        读数的时间**必须**画出来（原来在卡片底部，现在缩到第一格里）：
                        `stored` 那一行的数字是上一次读到的，没有时间它和"实时"没有区别。
                      -->
                      <span v-if="row.feature" class="muted channel-table__time">
                        {{ t('monitorUi.channelFeatureUpdated', { time: featureTime(row.feature.timestamp) }) }}
                      </span>
                    </button>
                  </th>

                  <template v-if="row.feature">
                    <td class="channel-table__value">{{ formatNumber(row.feature.spl, 2) }} dB</td>
                    <td class="channel-table__value">
                      {{ formatNumber(row.feature.mainFrequency, 2) }} Hz
                    </td>
                    <td class="channel-table__value">
                      {{ formatNumber(row.feature.smoothness, 3) }}
                    </td>
                    <td class="channel-table__value">
                      {{ formatNumber(row.feature.bandEnergyRatio, 3) }}
                    </td>
                  </template>
                  <!--
                    没读到过的那几路：四格写 `—` 并整行给出原因（`channelFeatureUnread`），
                    不是四个空格 —— 空格会被读成 0。
                  -->
                  <td v-else class="channel-table__empty" colspan="4">
                    {{ t('monitorUi.channelFeatureUnread') }}
                  </td>

                  <td class="channel-table__alarm">
                    <button
                      v-if="row.alarming"
                      type="button"
                      class="badge badge--danger channel-table__alarm-button"
                      :data-channel-alarm="row.index"
                      :title="t('monitorUi.channelAlarmOpen')"
                      @click.stop="openChannelAlarmDetail(row.index)"
                    >
                      {{ t('monitorUi.channelAlarmYes') }}
                    </button>
                    <!--
                      这一路有告警记录但**都确认过了**：不标红（告警中心确认过的就
                      不该继续打断人），但仍然给一个入口 —— 已确认不等于没发生过。
                    -->
                    <button
                      v-else-if="row.alarm"
                      type="button"
                      class="badge channel-table__alarm-button"
                      :data-channel-alarm="row.index"
                      :title="t('monitorUi.channelAlarmOpen')"
                      @click.stop="openChannelAlarmDetail(row.index)"
                    >
                      {{ t('monitorUi.channelAlarmAcknowledged') }}
                    </button>
                    <span v-else class="muted" :data-channel-alarm-none="row.index">
                      {{ t('monitorUi.channelAlarmNone') }}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <p class="muted channel-features__sample">
            {{ t('monitorUi.channelAlarmSampleHint', { count: DEVICE_ALARM_SAMPLE }) }}
          </p>

          <!--
            翻页条（第 22 条）：上一页 / 下一页 + 范围文案，样式参考告警记录页的 .pager。
            页数超过 1 才画（通道 ≤4 的机器不需要翻页）；按钮在头尾灰掉，不藏 ——
            藏了会让"有没有下一页"变成一个要试才知道的事。
          -->
          <div v-if="channelFeaturePageCount > 1" class="channel-features__pager">
            <span class="muted">
              {{
                t('monitorUi.channelPager', {
                  start: channelFeatureRange.start,
                  end: channelFeatureRange.end,
                  total: channelFeatureRange.total
                })
              }}
            </span>
            <div class="btn-row">
              <button
                type="button"
                class="btn btn--sm"
                :disabled="clampedChannelFeaturePage <= 1"
                @click="channelFeaturePage = clampedChannelFeaturePage - 1"
              >
                {{ t('alarmsUi.prevPage') }}
              </button>
              <button
                type="button"
                class="btn btn--sm"
                :disabled="clampedChannelFeaturePage >= channelFeaturePageCount"
                @click="channelFeaturePage = clampedChannelFeaturePage + 1"
              >
                {{ t('alarmsUi.nextPage') }}
              </button>
            </div>
          </div>
        </section>

        <section class="chart-panel card">
          <div class="section-header">
            <h3 class="section-title">{{ t('monitorUi.spectrumSection') }}</h3>

            <span class="muted chart-hint">{{ spectrumHint }}</span>
          </div>
          <EChart
            :option="spectrumOption"
            height="240px"
            :placeholder="monitor.spectrumMagnitudes.length === 0 ? t('monitorUi.waitingSpectrum') : ''"
          />
        </section>

        <section class="chart-panel card">
          <div class="section-header">
            <h3 class="section-title">{{ t('monitorUi.spectrogramSection') }}</h3>
          </div>
          <SpectrogramViewer :frames="monitor.content.spectrogramFrames" height="240px" />
        </section>

        <!--
          声学波形卡（第 21 条：实时音频**并入**这张卡）。

          卡头右侧是三颗图标按钮（播放/停止 / 录音 / 音量）——原来独立音频条
          （`.audio-bar`）的三个动作原样搬进来，禁用逻辑不变（播放看 `canPlayAudio`，
          录音看 `monitor.isRunning`）。音量收成一颗按钮：点击在下方弹出迷你滑杆浮层
          （`data-waveform-volume-pop`），点浮层与按钮以外的地方收起
          （与画面墙音量交互同一条做法）。电平表（`AudioLevelMeter`，含录音计时）
          留在卡内、图的下方 —— 说明文字 `monitorUi.audioPreviewHint` 按第 21 条删掉。
        -->
        <section class="chart-panel card waveform-card">
          <div class="section-header">
            <h3 class="section-title">{{ t('monitorUi.waveformSection') }}</h3>
            <div class="waveform-card__actions" role="group" :aria-label="t('monitorUi.audioSection')">
              <button
                type="button"
                class="btn btn--sm btn--icon"
                :class="{ 'btn--danger': audioEnabled }"
                :disabled="!canPlayAudio"
                :aria-pressed="audioEnabled"
                :aria-label="audioEnabled ? t('monitorUi.audioStop') : t('monitorUi.audioPlay')"
                :title="audioEnabled ? t('monitorUi.audioStop') : t('monitorUi.audioPlay')"
                data-waveform-play
                @click="toggleAudio"
              >
                <svg v-if="!audioEnabled" class="waveform-card__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <path d="M5 4.2 11.4 8 5 11.8Z" fill="currentColor" />
                </svg>
                <svg v-else class="waveform-card__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <rect x="4.6" y="4.6" width="6.8" height="6.8" fill="currentColor" />
                </svg>
              </button>
              <button
                type="button"
                class="btn btn--sm btn--icon"
                :class="{ 'btn--danger': monitor.recording.active }"
                :disabled="!monitor.isRunning"
                :aria-pressed="monitor.recording.active"
                :aria-label="monitor.recording.active ? t('monitorUi.stopRecording') : t('monitorUi.startRecording')"
                :title="monitor.recording.active ? t('monitorUi.stopRecording') : t('monitorUi.startRecording')"
                data-waveform-record
                @click="toggleRecording"
              >
                <svg class="waveform-card__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <circle
                    cx="8"
                    cy="8"
                    r="4.2"
                    :fill="monitor.recording.active ? 'currentColor' : 'none'"
                    stroke="currentColor"
                    stroke-width="1.3"
                  />
                </svg>
              </button>
              <span class="waveform-card__volume">
                <button
                  type="button"
                  class="btn btn--sm btn--icon"
                  :aria-expanded="volumePopoverOpen"
                  :aria-label="t('monitorUi.audioVolume')"
                  :title="t('monitorUi.audioVolume')"
                  data-waveform-volume-trigger
                  @click="volumePopoverOpen = !volumePopoverOpen"
                >
                  <svg class="waveform-card__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                    <path d="M3 6 H5.6 L9 3 V13 L5.6 10 H3 Z" fill="currentColor" />
                    <path
                      d="M11.2 5.4 A4.2 4.2 0 0 1 11.2 10.6"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.3"
                      stroke-linecap="round"
                    />
                  </svg>
                </button>
                <!--
                  迷你音量浮层：一条竖向滑杆（与画面墙那一颗同一套交互与方向，简化掉静音开关 ——
                  播放/停止按钮已经说清了"有没有声音"）。滑杆的值仍然推给 EnvelopePlayer。
                -->
                <div v-if="volumePopoverOpen" class="waveform-card__volume-pop" data-waveform-volume-pop>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    :value="volumePercent"
                    :aria-label="t('monitorUi.volumeLabel')"
                    @input="onVolumeInput"
                  />
                </div>
              </span>
            </div>
          </div>
          <EChart
            :option="waveformOption"
            height="240px"
            :placeholder="monitor.content.audio === null ? t('monitorUi.waitingAudio') : ''"
          />
          <AudioLevelMeter
            :peak="monitor.content.audio?.peak"
            :rms="monitor.content.audio?.rms"
            :recording="monitor.recording.active"
            :elapsed-ms="monitor.recording.elapsedMs"
            :disabled="monitor.content.audio === null"
            :sample-rate="monitor.content.audio?.sampleRate ?? sampleRate ?? undefined"
            :frame-ms="monitor.content.audio?.frameMs"
          />
          <p v-if="audioError" class="alert alert--danger" role="alert">{{ audioError }}</p>
        </section>
      </div>

      <!--
        Item 24：检测模式 —— 四张指标卡（声压级 / 平稳度 / 能量比 / 主频）的 2×2 网格，
        每张卡同一坐标系里最多 8 条通道曲线（每通道一色，图例在卡内右侧标通道号）。
        数据来自 store 的 `channelFeatureHistory`：每通道各自的时间线，**跨通道不同步**
        —— 那句口径原来写在网格下方的一句说明里，业主 20260921 要求撤掉文字块、
        只留趋势卡卡头那颗 ⓘ 的悬停提示。图本身用时间轴说真话（没数据的时段不占宽度）。

        2026-09-24 多通道同时显示：勾选多路时每一路各开一条 `/features_stream` 连接
        （`monitor.featureChannels`），于是同一次会话里可以有几条线**同时在长**。
        上面那张「多通道读数」卡就是这件事的入口与账目。
      -->
      <div v-show="viewMode === 'detect'" class="detect-grid">
        <!--
          多通道读数（业主 2026-09-24 原话：勾选多个通道，都在同一个卡片中，只是趋势线
          用不同的颜色表示；每路 SPL / 主频 / 平稳度 / 频带能量比 四读数 + 一条迷你趋势）。

          它是这个网格的第一项并横跨两列（`grid-column: 1 / -1`），所以四张检测卡仍然是
          2×2 —— 多出来的这张卡不会把"每行最多 2 张"挤成 2+2+1 的散排。

          勾选框 = **订阅**（一条勾选 = 一条连接），点行仍然是"切当前通道"——两者不共用
          点击目标：点行会让音频/频谱/时频图跟着走，勾选框只影响这张卡与四张检测卡上有几条线。
        -->
        <section v-if="isVoiceprint" class="card multi-channel" data-multi-channel>
          <div class="section-header">
            <h3 class="section-title">{{ t('realtimeUi.multiChannelTitle') }}</h3>
            <div
              class="multi-channel__watch"
              role="group"
              :aria-label="t('realtimeUi.watchChannelsLabel')"
              :title="t('realtimeUi.watchHint')"
            >
              <label
                v-for="tab in channelTabs"
                :key="tab.index"
                class="multi-channel__watch-item"
                :class="{ 'multi-channel__watch-item--off': isTabDisabled(tab) }"
              >
                <input
                  type="checkbox"
                  class="multi-channel__checkbox"
                  :checked="isChannelWatched(tab.index)"
                  :disabled="isTabDisabled(tab) || tab.index === activeChannelIndex"
                  :title="watchTitle(tab.index)"
                  :aria-label="watchTitle(tab.index)"
                  :data-multi-channel-watch="tab.index"
                  @change="toggleChannelWatch(tab.index)"
                />
                <span>{{ tab.label }}</span>
              </label>
            </div>
          </div>

          <table class="multi-channel__table" data-multi-channel-table>
            <caption class="visually-hidden">{{ t('realtimeUi.multiChannelTitle') }}</caption>
            <thead>
              <tr>
                <th scope="col">{{ t('monitorUi.channelFeatureColumnChannel') }}</th>
                <th scope="col">{{ t('metrics.spl') }}</th>
                <th scope="col">{{ t('metrics.mainFrequency') }}</th>
                <th scope="col">{{ t('metrics.smoothness') }}</th>
                <th scope="col">{{ t('metrics.bandEnergyRatio') }}</th>
                <th scope="col" class="multi-channel__spark-col">{{ t('realtimeUi.trendColumn') }}</th>
                <th scope="col">{{ t('realtimeUi.statusColumn') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="series in multiChannelSeries"
                :key="series.channelId"
                :data-multi-channel-row="series.channelId"
                :data-multi-channel-state="series.state"
                :data-multi-channel-age="series.ageMs ?? ''"
              >
                <th scope="row" class="multi-channel__channel">
                  <i class="multi-channel__swatch" :style="{ background: series.color }"></i>
                  <span>{{ series.label }}</span>
                  <!-- 「当前」是文字，不是只靠底色：色块已经在表示通道，不能用它兼任状态。 -->
                  <span v-if="series.isActive" class="multi-channel__current">
                    {{ t('realtimeUi.currentChannel') }}
                  </span>
                </th>
                <template v-if="series.latest">
                  <td class="multi-channel__value">{{ formatNumber(series.latest.spl, 2) }} dB</td>
                  <td class="multi-channel__value">
                    {{ formatNumber(series.latest.mainFrequency, 2) }} Hz
                  </td>
                  <td class="multi-channel__value">{{ formatNumber(series.latest.smoothness, 3) }}</td>
                  <td class="multi-channel__value">
                    {{ formatNumber(series.latest.bandEnergyRatio, 3) }}
                  </td>
                </template>
                <!--
                  没收到过的那几路：四格合成一句原因，不是四个空格、也不是四个 0。
                  「没收到」与「收到了但停了」在状态列里另外分开写。
                -->
                <td v-else class="multi-channel__empty" colspan="4">
                  {{ t('monitorUi.channelFeatureUnread') }}
                </td>
                <td class="multi-channel__spark-cell">
                  <svg
                    v-if="multiChannelSparkPath(series.points)"
                    class="multi-channel__spark"
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <path
                      :d="multiChannelSparkPath(series.points)"
                      :style="{ stroke: series.color }"
                      vector-effect="non-scaling-stroke"
                    />
                  </svg>
                  <span v-else class="muted">—</span>
                </td>
                <td class="multi-channel__state" :title="multiChannelStateHint(series)">
                  {{ multiChannelStateText(series) }}
                </td>
              </tr>
            </tbody>
          </table>
          <p class="multi-channel__note">{{ t('realtimeUi.multiChannelNote') }}</p>
        </section>

        <section v-for="metric in DETECT_METRICS" :key="metric.key" class="card chart-panel detect-card">
          <div class="section-header">
            <h3 class="section-title">{{ t(metric.labelKey) }}</h3>
          </div>
          <EChart
            :option="detectOptions[metric.key]"
            height="220px"
            :placeholder="detectHasData ? '' : t('monitorUi.waitingFeatures')"
          />
        </section>
      </div>

      <!--
        「当前帧」那张卡片（`monitorUi.currentFrameSection`）同样按 ③ 删掉了。
        它显示的四项里，采样率与当前通道**已经在页头的通道页签与波形卡的电平表上**
        （第 21 条起采样率/帧长随 `AudioLevelMeter` 住在声学波形卡里），
        数据来源与谱图缓存是排查用的内部状态 —— 需要时由协议实验室回答，
        不该占实时监测页的一整张卡片。

        Item 20：原先在这张卡下面的那四张统计卡（.card-grid--stats）也删了 ——
        趋势卡右侧的"当前值"四行取代它们，同一个事实不画两遍。
      -->

      <!--
        「点击告警则显示详细的告警状态」（业主 2026-09-19 第 13 批第 3 条）。

        弹窗里是**这一路**在这批最近告警里的全部记录（与表里那一列同源，见
        `channelAlarmDetailItems`），每一条给出：时间 / 等级 / 故障类型 / 是否已确认 /
        设备自己的原因原话 / 四项读数。再往下是去「告警中心」的入口（按设备预筛），
        因为"看全部历史"是那一页的职责，弹窗只回答"这一路现在怎么了"。
      -->

      <AppModal
        :model-value="cameraModeMismatch !== null"
        :title="cameraModeMismatchTitle"
        width="520px"
        @update:model-value="(open) => { if (!open) closeCameraModeMismatch() }"
      >
        <p class="alert alert--warning" role="alert">{{ cameraModeMismatchMessage }}</p>
        <dl v-if="cameraModeMismatch" class="camera-mode-mismatch__facts">
          <div>
            <dt>{{ t('cameraControlUi.modeMismatchConfigured') }}</dt>
            <dd>{{ cameraDetectionModeText(cameraModeMismatch.configured) }}</dd>
          </div>
          <div>
            <dt>{{ t('cameraControlUi.modeMismatchCamera') }}</dt>
            <dd>{{ cameraDetectionModeText(cameraModeMismatch.actual) }}</dd>
          </div>
        </dl>
        <template #footer>
          <button type="button" class="btn" @click="closeCameraModeMismatch">
            {{ t('common.close') }}
          </button>
          <button type="button" class="btn btn--primary" @click="adoptCameraWorkMode">
            {{ t('cameraControlUi.modeMismatchAdopt') }}
          </button>
        </template>
      </AppModal>

      <AppModal
        :model-value="channelAlarmDetail !== null"
        :title="t('monitorUi.channelAlarmDetailTitle', { channel: channelLabel(channelAlarmDetail ?? 0) })"
        width="620px"
        @update:model-value="closeChannelAlarmDetail"
      >
        <p v-if="channelAlarmDetailRow?.name" class="muted" data-channel-alarm-detail-name>
          {{ channelAlarmDetailRow.name }}
        </p>
        <p class="muted">{{ t('monitorUi.channelAlarmSampleHint', { count: DEVICE_ALARM_SAMPLE }) }}</p>

        <ul v-if="channelAlarmDetailItems.length > 0" class="channel-alarm__list" data-channel-alarm-detail-list>
          <li
            v-for="alarm in channelAlarmDetailItems"
            :key="alarm.id"
            class="channel-alarm__item"
            :data-channel-alarm-detail-id="alarm.id"
          >
            <div class="channel-alarm__head">
              <span class="muted">{{ formatDateTime(alarm.timestamp) }}</span>
              <span :class="alarmSeverityBadgeClass(alarm.severity)">
                {{ eventSeverityLabel(alarm.severity) }}
              </span>
              <span class="badge" :class="alarm.acknowledged ? 'badge--success' : 'badge--danger'">
                {{
                  alarm.acknowledged
                    ? t('monitorUi.channelAlarmAcknowledgedState')
                    : t('monitorUi.channelAlarmUnacknowledgedState')
                }}
              </span>
            </div>
            <div class="channel-alarm__types" data-channel-alarm-types>
              {{ alarmTypesText(alarm) }}
            </div>
            <dl class="channel-alarm__values">
              <div>
                <dt>{{ t('metrics.spl') }}</dt>
                <dd>{{ alarm.spl === undefined ? '—' : `${formatNumber(alarm.spl, 2)} dB` }}</dd>
              </div>
              <div>
                <dt>{{ t('metrics.mainFrequency') }}</dt>
                <dd>
                  {{ alarm.mainFrequency === undefined ? '—' : `${formatNumber(alarm.mainFrequency, 2)} Hz` }}
                </dd>
              </div>
              <div>
                <dt>{{ t('metrics.smoothness') }}</dt>
                <dd>{{ alarm.smoothness === undefined ? '—' : formatNumber(alarm.smoothness, 3) }}</dd>
              </div>
              <div>
                <dt>{{ t('metrics.bandEnergyRatio') }}</dt>
                <dd>
                  {{ alarm.bandEnergyRatio === undefined ? '—' : formatNumber(alarm.bandEnergyRatio, 3) }}
                </dd>
              </div>
            </dl>
            <!--
              设备自己的原话（听诊盒子族的 `alarm_reasons`，例："时域能量比超限，"）。
              原样显示、不翻译：那是设备的措辞，我们映射过的枚举不能替代它
              （记在 §15.23.3 里的理由）。
            -->
            <p v-if="alarm.deviceReason" class="muted channel-alarm__reason" data-channel-alarm-reason>
              {{ alarm.deviceReason }}
            </p>
          </li>
        </ul>
        <p v-else class="muted" data-channel-alarm-detail-empty>
          {{ t('monitorUi.channelAlarmNone') }}
        </p>

        <template #footer>
          <RouterLink
            class="btn btn--sm"
            :to="{ path: '/alarms', query: { device: selectedDeviceId } }"
            data-link="channel-alarm-history"
            @click="closeChannelAlarmDetail"
          >
            {{ t('cameraAlarmUi.goAlarmList') }}
          </RouterLink>
          <button type="button" class="btn btn--sm btn--primary" @click="closeChannelAlarmDetail">
            {{ t('common.close') }}
          </button>
        </template>
      </AppModal>
      </template>

      <!--
        ---- 气井泄漏（AO01）------------------------------------------------------

        不用声纹那一支：真机四个 WebSocket（features/audio/freq/time_freq）都能握手
        但都是 0 帧，设备自己的 /preview 页面也一样。这一支只显示设备端回传的泄漏
        告警录音，以及同步入口；详细边界见 `docs/AO01-INTEGRATION.md`。
      -->
            <template v-else-if="isGasLeak">
        <DeviceLocationMap
          :installation="selectedDevice?.installation"
          :device-id="selectedDevice?.id"
          :device-name="selectedDevice?.name"
        />
        <GasLeakMonitorPanel :device-id="selectedDeviceId" :channels="channels" />
            </template>

      <!--
        ---- 声呐（SN-16 空气声呐 / 2023 版听诊盒子）-----------------------------

        第 5 条要求的"三种机型三种内容"里的第三支。这一支**没有实时图**，理由见 `isSonar`
        的注释：这一族的实时音频/时频流是 WebSocket，手册给了路径（`/audio_stream`、
        `/stft_stream`，SN-16 另有 `/all_chns_stream`），但我们没有接入、也没有在真机上验过
        帧格式。宁可少一块，也不画一张假的实时图。

        这一屏放的是**这一族真实存在、我们已经实现**的东西，三块都来自既有设计：
          ① 地址信息（`DeviceInstallationCard`）：业主第 1 条新增的数据，与设备详情页共用；
          ② 参数与告警同步（`AuscultationPanel`）：设备详情页那个"听诊盒子"页签的同一份实现；
          ③ 本机录音回放（`MonitorRecordingTimeline`）：同步拉下来的告警录音都在本机库，
             与声纹设备那一支用的是同一条时间轴。

        **那一长句说明按业主 2026-09-18 第 19 条删掉了**（原来在页面顶上，也在机型号徽标的
        悬停提示里）：设备在不在线由页头的状态徽标回答，不再用一句话解释这一屏
        为什么没有实时图（下拉旁那颗绿点/灰点已于 2026-09-21 第二批第 15 条删掉）。
        口径记在 `docs/Ivms4200-UX-REFERENCE.md` §15.49。
      -->
      <template v-else-if="isSonar">
        <!--
          声呐总览（业主 2026-09-24 第 9 条改版）：GIS 地图（左 66%、16:9、设备居中）
          + 右栏（当前分贝/方位/播放录音 + 最近一次告警）+ 下方全部历史告警。
          实现与诚实边界都在 `SonarOverviewPanel.vue` 的文件头。
        -->
        <SonarOverviewPanel :device-id="selectedDeviceId" />

        <DeviceInstallationCard
          :installation="selectedDevice?.installation"
          :device-id="selectedDevice?.id"
          :device-name="selectedDevice?.name"
        />

        <AuscultationPanel :device-id="selectedDeviceId" />

        <MonitorRecordingTimeline :device-id="selectedDeviceId" />
      </template>
    </template>
  </div>
</template>

<style scoped>
/*
 * 实时监测页的排布板。
 *
 * 声纹 / 声呐两支的子项直接躺在板子上：板子在能放下 2×360px 时是两列，放不下就是
 * 一列，所以窄窗口上它们退回上下排列，控件一个都不会被裁掉（叠放 = 每块自己占满宽度）。
 *
 * 相机分支不同（业主 2026-09-21 第三批）：它只有设备头直接躺在板子上（整幅宽），
 * 其余全部装进 `.camera-split`（65/35 两列容器，自己占整幅宽）——左右两列的比例
 * 写死在那条规则上，不由板子的 auto-fit 决定。
 *
 * `minmax(0, 1fr)` 的第一个参数是 **0** 而不是 `auto`：网格项的默认最小尺寸是
 * `auto`，内容里有一个 1024 点的 ECharts canvas 时，`auto` 会让列宽顶在内容的最小
 * 宽度上、把整页撑出横向滚动条。0 允许列真的变窄，图表按容器宽度重排。
 *
 * 板子外面没有任何 width / max-width / margin: auto，所以 `.page` 的"靠左、流式"
 * 由 `.app-content` 的内边距独家决定这件事没有被这次重排改变。
 */
.camera-board {
  --camera-card-gap: var(--space-4);
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: var(--camera-card-gap);
  /*
   * **板子自己没有内边距**（业主 2026-09-26 第 1 条：「这个页面中卡片之间的距离以及卡片
   * 和边沿的距离应该是和设备管理里的卡片与边缘的距离一致的」）。
   *
   * 原来这里是 `padding: var(--camera-card-gap)`（四边 16px）。它与 `.app-content`
   * 自己的内边距**叠加**，于是相机页每张卡离窗口边沿比设备管理页远 16px ——
   * 设备管理页没有第二层内边距（`.app-content` 的 padding 是那一页唯一的边距来源，
   * 口径写在 `main.css` 的 `.page` 注释里）。
   *
   * 删掉它之后，三个数与设备管理页逐项相同：
   *   · 卡片↔卡片（同一行）= `--camera-card-gap` = `--space-4` = 设备管理 `.card-grid` 的 gap；
   *   · 卡片↔卡片（上下两块）= 同一个值（`gap` 两个方向同值）；
   *   · 卡片↔窗口边沿 = `.app-content` 的内边距 = 设备管理页同一个来源。
   * 卡片内部仍旧是 `.card` 的 `padding: var(--space-4)`，两页一致。
   */
  /*
   * `align-items: start`：网格项的默认值是 `stretch`，同一行里最高的一块会把其余
   * 几块**拉到一样高**（实测：1920x1080 上相机控制会被拉到与声学图一样高，多出来
   * 的那一截是空卡片）。这里只说"各自按自己的内容高"，不改任何控件。
   */
  align-items: start;
}

/*
 * 声纹分支的卡片间隙（业主 2026-09-21 第二批第 16 条）：留白收到 10%。
 * 只挂在声纹分支上（`:class` 由 `isVoiceprint` 决定）——相机 / 声呐两支的板子间隙
 * 维持 --space-5 不动。
 */
.camera-board--voiceprint {
  --camera-card-gap: calc(var(--space-5) * 0.1);
}

/* 无论并排成几列都必须占满整幅宽的两块：设备头 / 相机分支的 65/35 两列容器。 */
.camera-board__wide {
  grid-column: 1 / -1;
}

/*
 * 相机分支的左右两列：左 65% 是“画面 + 实时诊断区”，右 35% 是
 * “检测控制 → 声纹/频谱 → 告警配置”的纵向栈。视频下方的检测与告警优先并排，
 * 波形作为进一步诊断的下钻层独占整行。
 * `fr` 比例在任何宽度下保持 65/35；`min-width: 0` 让 ECharts 的 canvas 不顶出列宽。
 * 窄窗口（< 1100px）折成一列 —— 两列都压到 35% 的列宽里坐标轴就读不出来了。
 */
.camera-split {
  display: grid;
  grid-template-columns: 65fr 35fr;
  gap: var(--camera-card-gap);
  grid-column: 1 / -1;
  align-items: start;
}

@media (max-width: 1100px) {
  .camera-split {
    grid-template-columns: 1fr;
  }
}

.camera-split__main,
.camera-split__side {
  display: flex;
  flex-direction: column;
  gap: var(--camera-card-gap);
  min-width: 0;
}

/*
 * 覆盖层（右键菜单、告警对话框）不画东西，但作为网格项会占掉一格的间距，把"声学图"
 * 挤到第二行。`display: contents` 让它们不参与网格布局（它们真正渲染的内容在
 * `Teleport` 到 body 的那一层）。
 */
.camera-board__overlay {
  display: contents;
}

.monitor-head {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.monitor-head__row {
  display: flex;
  align-items: flex-end;
  gap: var(--space-4);
  flex-wrap: wrap;
}

/*
 * 顶栏那一格里的设备下拉（被 `Teleport` 投进 `#topbar-page-slot`）。
 *
 * 业主 2026-09-17 第 6 条：「宽度改为现在的 50%、位置移到右侧、紧挨着右侧的设备数量标签」。
 *   - **宽度 50%** 是相对**这一格**说的（那一格本身就是顶栏的 50%），所以下拉占顶栏的 25%；
 *   - **靠右**：`margin-left: auto` 把它推到这一格的右端，而这一格的右边紧挨着的就是
 *     `.topbar__actions` 里第一个指示器（设备总数）—— 不需要改顶栏的 DOM 顺序；
 *   - `min-width: 0` 让长设备名在下拉内部截断，而不是把右侧三个指示器挤走。
 *
 * `scoped` 样式对 Teleport 出去的内容仍然生效（Vue 会给它们带上同一个 scope 属性）。
 */
.topbar-device {
  width: 50%;
  min-width: 0;
  margin-left: auto;
}

.topbar-device .select {
  width: 100%;
  min-width: 0;
}

.monitor-head__status {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}

.monitor-head__note {
  font-size: 11.5px;
}

.channel-tabs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  padding-top: var(--space-2);
  border-top: 1px solid var(--color-border);
}

.channel-tab {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  min-width: 74px;
  padding: 5px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.channel-tab:hover {
  background: var(--color-bg-subtle);
}

.channel-tab--active {
  border-color: var(--color-accent);
  background: var(--color-accent-soft);
}

/* --- 通道状态：未启用 / 状态未知 --------------------------------------- */

/*
 * 未启用：整体压暗、去掉强调色、虚线边框。变灰表达的是“这一路不参与实时监测”，
 * 所以命中区域不再给出“可用”的反馈。
 */
.channel-tab.channel-state--disabled {
  opacity: 0.45;
  background: var(--color-bg-muted);
  border-style: dashed;
  cursor: not-allowed;
}

.channel-tab.channel-state--disabled:hover {
  background: var(--color-bg-muted);
  border-color: var(--color-border);
}

.channel-tab.channel-state--disabled .channel-tab__label {
  color: var(--color-text-secondary);
}

/*
 * 状态未知：同样是灰的，但用警告色虚线，读完状态之前看起来与“明确关闭”不同。
 */
.channel-tab.channel-state--unknown {
  border-style: dashed;
  border-color: var(--color-warning-border);
  color: var(--color-warning);
}

.channel-tab.channel-state--unknown:hover {
  border-color: var(--color-warning);
}

/*
 * 选中但未启用/未知：去掉橙色强调边框（强调色在过去等于“这一路能看”），
 * 但各自保留自己的状态色调，选中的未知通道仍然是警告色。
 */
.channel-tab--active.channel-state--disabled {
  border-color: var(--color-border-strong);
  background: var(--color-bg-subtle);
}

.channel-tab--active.channel-state--unknown {
  border-color: var(--color-warning);
  background: var(--color-bg-subtle);
}

.channel-tab__live {
  position: absolute;
  top: 5px;
  right: 6px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-neutral);
}

.channel-tab__live--on {
  background: var(--color-success);
}

.channel-tab__label {
  font-size: 12.5px;
  font-weight: 600;
}

.channel-tab--active .channel-tab__label {
  color: var(--color-accent-hover);
}

.channel-tab__name {
  font-size: 11px;
  color: var(--color-text-secondary);
  max-width: 96px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* --- ② per-channel voiceprint TABLE (batch 13 item 3) -------------------- */

.channel-features {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.channel-features__sample {
  margin: 0;
  font-size: 11px;
}

/*
 * 翻页条（第 22 条）：与告警记录页的 .pager 同一套（flex 两端对齐 + 小按钮），
 * 钉在卡片底部 —— 表体是 `flex: 1; min-height: 0`，卡片被同行撑高时它仍然落底。
 */
.channel-features__pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  font-size: 12px;
}

/*
 * 表体。`flex: 1` + `min-height: 0` 让它在同一行的卡片里"能长能缩"：
 * 八行刚好和左边那三张 240px 高的图差不多高，窗口更矮时它会收缩并出滚动条，
 * 而**不会**把整行撑得比图高出一大截（业主说「高度和左边的一致」）。
 */
.channel-features__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

/*
 * 8 行 ×（通道 / 声压级 / 主频 / 平稳度 / 频带能量比 / 告警）。
 *
 * 宽窄由内容定（`table-layout: auto`）：数值列必须能一次读完，通道那一列里那枚
 * 状态徽标 + 读数时间最宽，所以给它 `width: 1%` + `white-space: nowrap` 让它按内容收，
 * 剩余宽度分给五个数值格。
 */
.channel-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.channel-table th,
.channel-table td {
  padding: 4px 6px;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--color-border);
}

.channel-table thead th {
  padding-top: 0;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.channel-table tbody tr:last-child th,
.channel-table tbody tr:last-child td {
  border-bottom: none;
}

/* 整行可点 = 切这一路通道（三张图跟着走），所以指针要变手型。 */
.channel-table__row {
  cursor: pointer;
}

.channel-table__row:hover {
  background: var(--color-bg-subtle);
}

/* 正在看的那一路：左侧一条强调色，与通道页签上的选中态同一套语言。 */
.channel-table__row--active {
  box-shadow: inset 2px 0 0 var(--color-accent);
}

.channel-table__channel {
  width: 1%;
  padding-left: 0;
  font-weight: 400;
}

/* 未启用的通道不可点（与通道页签同一条规则）：整行变灰，但文字仍然读得清。 */
.channel-table__row.channel-state--disabled {
  opacity: 0.6;
}

.channel-table__select {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
}

.channel-table__select:disabled {
  cursor: not-allowed;
}

.channel-table__select--active .channel-table__label {
  color: var(--color-accent-hover);
}

.channel-table__label {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.channel-table__name {
  font-size: 11px;
  color: var(--color-text-secondary);
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 未启用：通道名变灰（业主 2026-09-21 第二批第 17 条：不再写"已启用/未启用"文字，用颜色表达）。 */
.channel-table__row.channel-state--disabled .channel-table__label {
  color: var(--color-text-tertiary);
}

/*
 * 读数状态点（第 17 条）：绿=有读数（实时或最后一次读数）、红=未读取。
 * 8px 圆点代替原来的文字徽标；状态文字在 title / aria-label 里。
 */
.channel-table__feature-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-success);
}

.channel-table__feature-dot--miss {
  background: var(--color-danger);
}

.channel-table__time {
  font-size: 11px;
}

.channel-table__value {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.channel-table__empty {
  color: var(--color-text-secondary);
}

.channel-table__alarm {
  white-space: nowrap;
}

/* 告警那一格是按钮：外观沿用徽标，但按下有反馈（它是打开详情的入口）。 */
.channel-table__alarm-button {
  font-family: inherit;
  cursor: pointer;
}

.channel-table__alarm-button:hover {
  border-color: var(--color-border-strong);
}

/* --- 告警详情弹窗 ------------------------------------------------------- */

.channel-alarm__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 52vh;
  overflow: auto;
}

.channel-alarm__item {
  padding: var(--space-3);
  background: var(--color-bg-subtle);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}

.channel-alarm__head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 12px;
}

.channel-alarm__types {
  margin-top: 4px;
  font-size: 12.5px;
}

.channel-alarm__values {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 2px var(--space-3);
  margin: var(--space-2) 0 0;
  font-size: 12px;
}

.channel-alarm__values div {
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
}

.channel-alarm__values dt {
  color: var(--color-text-secondary);
}

.channel-alarm__values dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}

.channel-alarm__reason {
  margin: 4px 0 0;
  font-size: 12px;
}

/*
 * 声学波形卡的头部按钮组（业主 2026-09-21 第二批第 21 条：实时音频并入了这张卡）。
 * 三颗 28px 图标按钮 + 说明文字；文字窄了截断，不许把按钮顶出卡片。
 */
.waveform-card__actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.chart-hint {
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.waveform-card__icon {
  display: block;
  width: 15px;
  height: 15px;
}

/* 音量浮层的定位锚点：包住触发按钮，浮层挂在按钮正下方、右缘对齐。 */
.waveform-card__volume {
  position: relative;
  display: inline-flex;
}

/*
 * 迷你音量浮层（业主 2026-09-23：竖排）：白底细边 + 轻阴影，一条 96px **竖向**滑杆。
 * 浮层**悬在卡头下方**（absolute），不参与文档流，不会把图往下挤。
 * 竖向 range 用 `writing-mode: vertical-lr` + `direction: rtl`（值大的一头朝上）。
 */
.waveform-card__volume-pop {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 20;
  padding: 10px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg);
  box-shadow: var(--shadow-lg);
}

.waveform-card__volume-pop input[type='range'] {
  width: 14px;
  height: 96px;
  margin: 0;
  writing-mode: vertical-lr;
  direction: rtl;
}

.chart-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/*
 * ③b 四张图谱卡片（每通道声纹特性 / 频谱 / 时频图 / 声学波形）的排布。
 *
 * 列数由**这一块自己的宽度**决定（`auto-fit` + 最小 420px）：最小 420px 是为了让两张卡
 * 并排时每张仍然放得下 ECharts 的坐标轴标签，而 420 这个数又是 1366×768 那种常见窗口
 * （内容宽 ≈1318px）能放下**两列**的下限 —— 四张卡挤在 3 列里会让每张只剩下 400px 出头。
 *
 * 这里曾经叫 `.chart-columns`（只有两块：频谱 + 时谱）。③b 之后它变成四块，
 * 名字跟着改成 `graph-grid`，**旧规则一并删掉**：留着一条没人用的 CSS 只会让下一个
 * 人以为那块还在（§15.29.4 记过同一条教训）。
 *
 * **对齐方式改过**（2026-09-19 第 13 批第 3 条）：原来是 `align-items: start`（各自按内容
 * 高），业主说每通道特性表「高度和左边的一致」。写死一个高度只能在某一个窗口宽度上成立
 * —— 这一排并几列是随宽度变的，"左边"是谁也跟着变。所以改成网格默认的 `stretch`：
 * 同一行的卡片互相撑齐，无论并成几列，"和左边一致"都自动成立。
 * 表体是 `flex: 1; overflow: auto`，所以它只会跟着变高/变矮，不会反过来把整行撑爆。
 */
.graph-grid {
  display: grid;
  /* 声纹分支卡片间隙收到 10%（业主 2026-09-21 第二批第 16 条）。 */
  gap: calc(var(--space-4) * 0.1);
  grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
}

/*
 * ③b 置顶的趋势卡片：整幅宽（业主 2026-09-21 第二批第 20 条改了它的内部排布）——
 * 卡内是横向的「图 70% + 当前值纵列 30%」，窄屏（<900px）回落上下排列。
 */
.trend-panel {
  grid-column: 1 / -1;
}

/* 卡头右侧那一组：「单通道 / 检测」切换 + 单通道趋势的指标 chips + 检测口径的 ⓘ 悬停提示。 */
.trend-panel__header-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

/*
 * Item 24 的 segmented 视图切换（单通道 / 检测）。
 * 一组**互斥**的按钮：选中态用底色块表达（与 channel-tab 的选中语言同一套），
 * `aria-pressed` 把状态交给读屏器。
 */
.view-mode {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  background: var(--color-bg-subtle);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}

.view-mode__button {
  padding: 3px 10px;
  font-family: inherit;
  font-size: 12px;
  color: var(--color-text-secondary);
  background: transparent;
  border: none;
  border-radius: calc(var(--radius-sm) - 2px);
  cursor: pointer;
}

.view-mode__button:hover {
  color: var(--color-text);
}

.view-mode__button--active {
  background: var(--color-bg);
  color: var(--color-accent-hover);
  font-weight: 600;
}

/* Item 20：横向排 —— 左趋势图 70%，右当前值纵列 30%（剩下的宽度归它，含间隙）。 */
.trend-panel__body {
  display: flex;
  gap: calc(var(--space-4) * 0.4);
  align-items: stretch;
}

.trend-panel__chart {
  flex: 0 0 70%;
  min-width: 0;
}

/*
 * 右侧纵列：声压级 / 主频 / 频带能量比 / 平稳度四行（大号数字），
 * 扩展指标以小号排在后面。一条左边线把它与图分开（不用卡片再包一层 ——
 * 它已经是这张卡的一部分）。
 */
.trend-panel__stats {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-left: calc(var(--space-4) * 0.4);
  border-left: 1px solid var(--color-border);
}

.trend-panel__stats-title {
  margin: 0;
  font-size: 11.5px;
  color: var(--color-text-secondary);
}

.trend-stats {
  margin: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: space-evenly;
  gap: var(--space-1);
}

.trend-stats__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.trend-stats__label {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.trend-stats__value {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* 扩展指标：存在才画（设备没上报就没有这一行），字号收小与四个主行拉开层级。 */
.trend-stats__row--extended {
  border-top: 1px dashed var(--color-border);
  padding-top: var(--space-1);
}

.trend-stats__value--extended {
  font-size: 13px;
  font-weight: 500;
}

.trend-stats__unit {
  margin-left: 3px;
  font-size: 11px;
  font-weight: 400;
  color: var(--color-text-secondary);
}

/*
 * 卡头右上角那颗 ⓘ（业主 20260921）：检测模式的数据源口径（monitorUi.detectDataNote）
 * 收在它的悬停提示里。圆形小按钮，衬线斜体 i 是这个符号最通用的画法；
 * `cursor: help` 告诉操作员"悬停有说明"。
 */
.trend-panel__info {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex: none;
  padding: 0;
  border: 1px solid var(--color-border-strong, var(--color-border));
  border-radius: 50%;
  background: transparent;
  color: var(--color-text-secondary);
  font-family: Georgia, 'Times New Roman', serif;
  font-style: italic;
  font-size: 10px;
  line-height: 1;
  cursor: help;
}

.trend-panel__info:hover {
  color: var(--color-text);
  border-color: var(--color-text-secondary);
}

/*
 * 窄屏（业主点名的 <900px）：图与当前值纵列回落**上下**排列，
 * 纵列的左边线换成上边线。
 */
@media (max-width: 900px) {
  .trend-panel__body {
    flex-direction: column;
  }

  .trend-panel__chart {
    flex: none;
    width: 100%;
  }

  .trend-panel__stats {
    border-left: none;
    padding-left: 0;
    border-top: 1px solid var(--color-border);
    padding-top: var(--space-2);
  }
}

/*
 * Item 24：检测模式的四张指标卡（声压级 / 平稳度 / 能量比 / 主频）——
 * 每行**最多 2 张**（业主点名的 2×2），窄屏回落一列。
 * 与 `.graph-grid` 并列的另一块（auto-fit 会在超宽屏上并出 4 列，那不符合"最多 2 张"）。
 */
/*
  多通道读数（2026-09-24）。它横跨检测网格的两列（`grid-column: 1 / -1`），所以四张检测卡
  仍然是 2×2；`margin-bottom` 补上网格那点细缝（网格 gap 是刻意压到很小的）。

  列宽由内容定：四个读数格里最宽的是"93000.00 Hz"，状态列里最宽的是"更新于 12:03:44"，
  通道列按色块 + CH 号 + 角标收窄。迷你趋势固定 96px 宽：它是"形状"而不是"读数"，
  宽了会抢走读数列的空间。
*/
.multi-channel {
  grid-column: 1 / -1;
  margin-bottom: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.multi-channel__watch {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  font-size: 12px;
}

.multi-channel__watch-item {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--color-text-secondary);
  cursor: pointer;
  white-space: nowrap;
}

/* 未启用的通道：整块变灰且点不动 —— 与页头通道页签同一套状态口径。 */
.multi-channel__watch-item--off {
  color: var(--color-text-disabled);
  cursor: not-allowed;
}

.multi-channel__checkbox {
  width: 13px;
  height: 13px;
  margin: 0;
  accent-color: var(--color-accent);
  cursor: pointer;
}

/* 当前通道由主 socket 一直在推，取消勾选只会少画一行 —— 禁用它，不是藏起来。 */
.multi-channel__checkbox:disabled {
  cursor: default;
  opacity: 0.75;
}

.multi-channel__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  table-layout: auto;
}

.multi-channel__table th,
.multi-channel__table td {
  padding: 4px 6px;
  border-bottom: 1px solid var(--color-border);
  text-align: right;
  white-space: nowrap;
}

.multi-channel__table thead th {
  color: var(--color-text-tertiary);
  font-weight: 500;
}

.multi-channel__channel {
  display: flex;
  align-items: center;
  gap: 4px;
  text-align: left;
  font-weight: 500;
}

/* 色块 = 这一路在四张检测卡上的线色（同一个 trendChannelColor 取色）。 */
.multi-channel__swatch {
  width: 10px;
  height: 3px;
  border-radius: 1px;
  flex: 0 0 auto;
}

.multi-channel__current {
  padding: 0 3px;
  border-radius: 2px;
  background: var(--color-accent-light);
  color: var(--color-accent-strong);
  font-size: 10px;
}

.multi-channel__empty {
  color: var(--color-text-tertiary);
  text-align: center !important;
}

.multi-channel__spark-col,
.multi-channel__spark-cell {
  width: 96px;
}

.multi-channel__spark {
  display: block;
  width: 96px;
  height: 16px;
}

.multi-channel__spark path {
  fill: none;
  stroke-width: 1.4;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.multi-channel__state {
  color: var(--color-text-secondary);
}

.multi-channel__note {
  margin: 0;
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.detect-grid {
  display: grid;
  gap: calc(var(--space-4) * 0.1);
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

@media (max-width: 900px) {
  .detect-grid {
    grid-template-columns: 1fr;
  }
}

.chip--selectable {
  cursor: pointer;
  font-family: inherit;
}

.chip--selectable:hover {
  border-color: var(--color-border-strong);
}

/* --- camera live video -------------------------------------------------- */

.camera-live {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 0;
  overflow: visible;
  border-color: #24282f;
  background: #111318;
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.16);
}

/*
 * 预览区始终保持 16:9。深色背景不是装饰，而是把它明确成“视频设备表面”，
 * 与页面其余白色业务卡片形成职责区分。视频仍然 contain，绝不拉伸原始画面。
 */
.camera-live__stage {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 16 / 9;
  background:
    radial-gradient(circle at 50% 48%, rgba(42, 48, 58, 0.52), transparent 58%),
    #050608;
  border-radius: var(--radius-md) var(--radius-md) 0 0;
  overflow: hidden;
}

.camera-live__stage::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.045);
}

.camera-live__video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #050608;
  transform-origin: center center;
  transition: transform 0.12s ease, filter 0.16s ease;
}

.camera-live__video--paused {
  filter: saturate(0.58) brightness(0.88);
}

/*
 * NVR 式底部控制条：功能不删，只重排优先级。
 * transport = 播放/连接；evidence = 录像/抓图/回放；tools = 配置/红外/叠加/音量。
 */
.camera-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 54px;
  padding: 8px 10px;
  color: #d9dde5;
  background: #15181e;
  border-top: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 0 0 var(--radius-md) var(--radius-md);
}

.camera-controls__group {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.camera-controls__group--tools {
  margin-left: auto;
}

.camera-controls__divider {
  width: 1px;
  height: 22px;
  flex: 0 0 1px;
  margin: 0 2px;
  background: rgba(255, 255, 255, 0.11);
}

.camera-control-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 34px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: 7px;
  color: #d9dde5;
  background: transparent;
  font: inherit;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease, transform 0.14s ease;
}

.camera-control-btn:hover:not(:disabled) {
  color: #fff;
  background: rgba(255, 255, 255, 0.075);
  border-color: rgba(255, 255, 255, 0.06);
}

.camera-control-btn:active:not(:disabled) {
  transform: translateY(1px);
}

.camera-control-btn:focus-visible {
  outline: 2px solid #ff6a1a;
  outline-offset: 2px;
}

.camera-control-btn:disabled {
  opacity: 0.38;
  cursor: not-allowed;
}

.camera-control-btn--primary {
  color: #fff;
  background: #ff6a1a;
}

.camera-control-btn--primary:hover:not(:disabled) {
  background: #f15e0d;
  border-color: transparent;
}

.camera-control-btn--active {
  color: #ffb27d;
  background: rgba(255, 106, 26, 0.13);
  border-color: rgba(255, 106, 26, 0.2);
}

.camera-control-btn--recording {
  color: #fff;
  background: rgba(190, 36, 47, 0.88);
  border-color: rgba(255, 113, 122, 0.24);
}

.camera-control-btn--recording:hover:not(:disabled) {
  background: rgba(208, 42, 54, 0.96);
}

.camera-control-btn--icon {
  width: 34px;
  padding: 0;
}

.camera-control-btn--compact {
  padding-inline: 8px;
}

.camera-control-btn--light {
  color: var(--color-text-primary);
}

.camera-control-btn__icon {
  width: 17px;
  height: 17px;
  flex: 0 0 17px;
}

.camera-control-btn__record-dot {
  width: 8px;
  height: 8px;
  flex: 0 0 8px;
  border-radius: 50%;
  background: #ff5360;
  box-shadow: 0 0 0 3px rgba(255, 83, 96, 0.08);
}

.camera-control-btn--recording .camera-control-btn__record-dot {
  background: #fff;
  animation: camera-rec-pulse 1.2s ease-in-out infinite;
}

.camera-controls__status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  margin-left: 4px;
  padding-left: 10px;
  border-left: 1px solid rgba(255, 255, 255, 0.11);
  color: #8f98a7;
  font-size: 11px;
  white-space: nowrap;
}

.camera-controls__status-dot {
  width: 7px;
  height: 7px;
  flex: 0 0 7px;
  border-radius: 50%;
  background: #656d79;
}

.camera-controls__status-dot--on {
  background: #36c275;
  box-shadow: 0 0 0 3px rgba(54, 194, 117, 0.12);
}

.camera-controls__volume,
.camera-controls__anchor {
  position: relative;
  display: inline-flex;
  align-items: center;
}

/* 浮层属于工具面板，不继承底部控制条的深色表面，保证温度/滑杆可读性。 */
.camera-controls__pop {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  z-index: 40;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  color: var(--color-text-primary);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 8px);
  box-shadow: var(--shadow-lg);
}

/* 音量浮层（业主 2026-09-22 第 5 条）：滑杆**纵向**排列，静音开关在滑杆下方。
 * Chromium 用 `writing-mode: vertical-lr` + `direction: rtl` 把原生 range 转纵向
 * （bottom = 小值在底部，符合"往上推变大"的直觉）；不支持该写法的旧内核会
 * 退回横向滑杆（`width: 140px` 那一行仍在），功能不受影响。 */
.camera-controls__volume-pop {
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
}

.camera-controls__volume-pop .camera-controls__slider {
  width: auto;
  height: 120px;
  writing-mode: vertical-lr;
  direction: rtl;
}

.camera-controls__slider:disabled {
  opacity: 0.5;
}

.camera-controls__infrared {
  align-items: stretch;
  flex-direction: column;
  gap: 4px;
  min-width: 220px;
}

.camera-infrared__grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px var(--space-3);
  margin: 0;
  font-size: 12px;
}

.camera-infrared__grid dt {
  color: var(--color-text-secondary);
}

.camera-infrared__grid dd {
  margin: 0;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.camera-infrared__note {
  margin: 0;
  font-size: 11px;
  line-height: 1.4;
}

/* 全屏：仅视频表面铺满；播放器逻辑不变。 */
.camera-live__stage--fullscreen {
  position: fixed;
  inset: 0;
  z-index: 900;
  width: 100vw;
  height: 100vh;
  max-width: none;
  aspect-ratio: auto;
  margin-inline: 0;
  border-radius: 0;
  background: #050608;
}

.camera-live__fullscreen-exit {
  position: absolute;
  z-index: 10;
  top: 14px;
  right: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  color: #fff;
  background: rgba(0, 0, 0, 0.52);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 8px;
  cursor: pointer;
}

.camera-live__fullscreen-exit:hover {
  background: rgba(0, 0, 0, 0.72);
}

.camera-live__fullscreen-exit svg {
  width: 18px;
  height: 18px;
}

.camera-live__stage--fullscreen .camera-live__video {
  max-height: 100vh;
  height: 100vh;
  object-fit: contain;
}

/*
 * HUD 只占左上角一小块：设备 + 实时状态是第一层；码流信息降为第二层。
 * 避免把监控画面当作“承载日志文本的容器”。
 */
.camera-live__overlay {
  position: absolute;
  top: 12px;
  left: 12px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  max-width: min(72%, 620px);
  padding: 8px 10px;
  color: #f8fafc;
  background: rgba(9, 12, 17, 0.66);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  backdrop-filter: blur(8px);
  pointer-events: none;
}

.camera-live__overlay-primary,
.camera-live__overlay-secondary {
  display: flex;
  align-items: center;
  min-width: 0;
}

.camera-live__overlay-primary {
  gap: 7px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.2;
}

.camera-live__overlay-secondary {
  gap: 6px;
  color: rgba(235, 239, 245, 0.68);
  font-size: 10.5px;
  line-height: 1.25;
}

.camera-live__device-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.camera-live__status-dot {
  width: 7px;
  height: 7px;
  flex: 0 0 7px;
  margin-left: 2px;
  border-radius: 50%;
  background: #727b88;
}

.camera-live__status-dot--on {
  background: #44ce82;
  box-shadow: 0 0 0 3px rgba(68, 206, 130, 0.12);
}

.camera-live__status-text {
  color: rgba(255, 255, 255, 0.82);
  font-weight: 500;
}

.camera-live__overlay-separator {
  opacity: 0.52;
}

.camera-live__overlay-address {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 录像指示器：右上固定，不和左侧 HUD 竞争空间。 */
.camera-live__rec {
  position: absolute;
  top: 12px;
  right: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  color: #fff;
  background: rgba(176, 31, 43, 0.88);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 999px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.18);
  pointer-events: none;
}

.camera-live__rec-dot {
  width: 8px;
  height: 8px;
  background: #fff;
  border-radius: 50%;
  animation: camera-rec-pulse 1.2s ease-in-out infinite;
}

@keyframes camera-rec-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}

.camera-live > .alert {
  margin: 10px 10px 0;
}

.camera-live > .alert:last-of-type {
  margin-bottom: 10px;
}

.camera-live__hint {
  font-size: 12px;
}

.camera-live__placeholder {
  display: grid;
  place-items: center;
  min-height: 100%;
  margin: 0;
  padding: var(--space-4);
  color: #8f98a7;
  font-size: 13px;
  text-align: center;
}

@media (max-width: 1380px) {
  .camera-control-btn__label--utility {
    display: none;
  }

  .camera-controls__status {
    display: none;
  }
}

@media (max-width: 1180px) {
  .camera-controls {
    flex-wrap: wrap;
  }

  .camera-controls__group--tools {
    margin-left: 0;
  }

  .camera-controls__status {
    margin-left: auto;
  }
}

@media (max-width: 760px) {
  .camera-control-btn__label {
    display: none;
  }

  .camera-control-btn {
    width: 36px;
    padding: 0;
  }

  .camera-controls__divider {
    display: none;
  }

  .camera-live__overlay {
    max-width: calc(100% - 24px);
  }
}

/* --- camera diagnostic workspace ---------------------------------------- */

/*
 * 视频下面不再是三张同权重卡片从上到下堆叠。检测结论与最近告警属于“先判断有没有事”的
 * 第一层，因此并排；波形属于“为什么”的第二层，因此单独整行。auto-fit 让左列变窄时自然折行。
 */
.camera-diagnostic-zone {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.camera-diagnostic-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
  gap: 12px;
  align-items: start;
  min-width: 0;
}

.camera-diagnostic-grid__detect,
.camera-waveform-zone {
  min-width: 0;
}

/* 最近告警是实时诊断的一部分，视觉上比“告警配置入口”更靠前，但仍保持白色业务表面。 */
.camera-alarm-result {
  min-width: 0;
  overflow: hidden;
}

.camera-alarm-result__header {
  gap: var(--space-3);
}

.camera-alarm-result__heading {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.camera-alarm-result__indicator {
  width: 7px;
  height: 7px;
  flex: 0 0 7px;
  border-radius: 50%;
  background: #ff6a1a;
  box-shadow: 0 0 0 3px rgba(255, 106, 26, 0.10);
}

.camera-alarm-result__count {
  display: inline-grid;
  place-items: center;
  min-width: 22px;
  height: 20px;
  padding: 0 6px;
  border-radius: 999px;
  color: var(--color-text-secondary);
  background: var(--color-bg-subtle);
  border: 1px solid var(--color-border);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.camera-alarm-result__history {
  margin-left: auto;
  flex: 0 0 auto;
}

.camera-alarm-result__empty {
  margin: 0;
  padding: 18px 4px 12px;
  text-align: center;
}

.camera-alarm-result__spl {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.camera-alarm-result__reason {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 告警策略属于低频配置，放到右栏末端并降低一点视觉重量。 */
.camera-alarm-entry--secondary {
  background: var(--color-bg-subtle);
  box-shadow: none;
}

@media (max-width: 760px) {
  .camera-diagnostic-grid {
    grid-template-columns: 1fr;
  }

  .camera-alarm-result__header {
    align-items: flex-start;
  }
}

/*
 * 这一台相机的告警信息（第 24 条）。
 *
 * 只列最近十条、超过就滚：这是"现在有没有事"的一眼，不是告警记录页（那一条由旁边的
 * 「查看告警记录」带 `?device=` 过去）。行内不做表格 —— 四条信息（时间 / 声压级 /
 * 有无抓图 / 设备原文）在一行里读完，比一个五列表格在这里更省地方。
 */
.camera-alarm-entry__list {
  margin-top: var(--space-2);
  border-top: 1px solid var(--color-border);
  padding-top: var(--space-2);
}

.camera-alarm-entry__items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 180px;
  overflow-y: auto;
  font-size: 12px;
}

.camera-alarm-entry__items li {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.camera-alarm-entry__items li > span:first-child {
  font-variant-numeric: tabular-nums;
  min-width: 132px;
}



/* --- camera realtime workspace v4 -------------------------------------- */
.camera-workspace {
  display: flex;
  flex-direction: column;
  gap: var(--camera-card-gap);
  grid-column: 1 / -1;
  min-width: 0;
}

.camera-split--top {
  grid-column: auto;
  align-items: stretch;
}

.camera-split--top > .camera-split__main,
.camera-split--top > .camera-split__side {
  height: 100%;
}

.camera-split--top .camera-live,
.camera-split--top :deep(.cctl),
.camera-split--top :deep(.cctl > .cctl__card) {
  height: 100%;
}

.camera-controls--icons {
  justify-content: flex-start;
  gap: 5px;
}

.camera-controls__live-dot {
  width: 8px;
  height: 8px;
  margin-left: auto;
  border-radius: 50%;
  background: #68717e;
}

.camera-controls__live-dot--on {
  background: #36c275;
  box-shadow: 0 0 0 3px rgba(54, 194, 117, 0.12);
}

.camera-live__placeholder-icon {
  width: 34px;
  height: 34px;
  color: #66707e;
}

.camera-live__rec--icon {
  width: 24px;
  height: 24px;
  justify-content: center;
  padding: 0;
}

.camera-live__stage--drawing {
  cursor: crosshair;
}

.camera-detection-regions {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.camera-detection-region {
  position: absolute;
  border: 2px solid rgba(255, 106, 26, 0.95);
  background: rgba(255, 106, 26, 0.08);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.18);
}

.camera-detection-region--draft {
  border-style: dashed;
  background: rgba(255, 106, 26, 0.04);
}


.camera-detection-editor {
  width: 100%;
  padding: var(--space-3);
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-subtle);
  color: var(--color-text);
}

.camera-detection-editor--external {
  position: relative;
  z-index: 1;
}

.camera-detection-editor__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
  font-size: 12px;
}

.camera-detection-editor__header span,
.camera-detection-editor__hint,
.camera-detection-editor__notice,
.camera-detection-editor__error {
  margin: 0;
  font-size: 10.5px;
  line-height: 1.45;
}

.camera-detection-editor__header span,
.camera-detection-editor__hint { color: var(--color-text-secondary); }
.camera-detection-editor__notice { margin-top: 6px; color: var(--color-success-text, #166534); }
.camera-detection-editor__error { margin-top: 6px; color: var(--color-danger-text, #b91c1c); }

.camera-detection-editor__actions {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
  margin-bottom: 7px;
}

.camera-detection-editor__actions .btn {
  justify-content: center;
  min-width: 0;
}

.camera-realtime-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--camera-card-gap);
  /*
   * `stretch`（不是 `start`）：业主 2026-09-26 第 1 条要求「告警信息这个窗口的高度和
   * 左侧 PRPD 的相同」。第二行就是 [mode(=PRPD) | 告警信息] 两格，网格项默认的 stretch
   * 让两块**由行高统一** —— 谁更高就都那么高，不需要在 CSS 里写死任何像素，也不会因为
   * PRPD 舞台的 16:9 比例将来变了而失效。
   */
  align-items: stretch;
  min-width: 0;
}

.camera-realtime-grid > * {
  min-width: 0;
}

/*
 * 告警信息表（业主 2026-09-26 第 1 条：统一标题格 + 五列固定）。
 *
 * 与 `.devices-table` 同一套视觉口径（表头一条细底边、行间一条分隔线、数字列等宽字体），
 * 因为业主对"卡片间距与边距要和设备管理一致"的要求说的就是这个页面的表格观感。
 */
/*
 * 「告警卡与左侧 PRPD 等高」的另一半（业主 2026-09-26 第 1 条）。
 *
 * `.camera-realtime-grid` 的 `stretch` 只保证**网格项**一样高；而左边那一格是
 * `CameraAcousticPanel` 的根 `.acam`（一个 flex 列，里面是那张 16:9 的 PRPD 卡）。
 * 实测（`scripts/verify-round50.cjs` 的真窗口探针）：告警行多到把行高撑到 436px 时，
 * PRPD 那张卡**仍然是内容高 387px** —— 于是"等高"只在没有告警时成立，
 * 一有告警两者底部就差 49px（正好一条分页栏的高度）。
 *
 * 修法：让 PRPD 那张卡**吃掉这一格剩下的高度**（`.acam__mode-panel` 是第三张卡的类名，
 * 只在这一支上出现）。`min-height: 0` + `flex: 1` 让它在行高由告警卡决定时也填满，
 * 而里面的 16:9 舞台用 `flex: 1 1 auto` 吸收多出来的高度（图本身 `object-fit: contain`，
 * 不会被拉变形 —— 多出来的那一段是黑边，不是拉伸）。
 */
.camera-realtime-grid :deep(.acam) {
  display: flex;
  flex-direction: column;
}

.camera-realtime-grid :deep(.acam__mode-panel) {
  flex: 1 1 auto;
  min-height: 0;
}

.camera-realtime-grid :deep(.acam__mode-panel .acam__stage--ratio) {
  flex: 1 1 auto;
  min-height: 240px;
}
.camera-alarm-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  table-layout: fixed;
}

.camera-alarm-table thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 6px 8px;
  text-align: left;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary);
  background: var(--color-bg-subtle);
  border-bottom: 1px solid var(--color-border);
  white-space: nowrap;
}

.camera-alarm-table__time { width: 132px; }
.camera-alarm-table__level { width: 86px; }
.camera-alarm-table__num { width: 104px; text-align: right; }
.camera-alarm-table__action { width: 18px; }

.camera-alarm-table tbody td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text);
  vertical-align: middle;
}

.camera-alarm-table__row {
  cursor: pointer;
  outline: none;
}

.camera-alarm-table__row:hover,
.camera-alarm-table__row:focus-visible {
  background: var(--color-bg-hover);
}

.camera-alarm-table td.camera-alarm-table__time,
.camera-alarm-table td.camera-alarm-table__num {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.camera-alarm-table td.camera-alarm-table__time {
  color: var(--color-text-secondary);
}

.camera-alarm-table__type {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 未确认标记：一枚小圆点，与标题那颗指示灯同一套颜色语义。 */
.camera-alarm-table__unack {
  display: block;
  width: 6px;
  height: 6px;
  margin: 0 auto;
  border-radius: 50%;
  background: #ff6a1a;
}

.camera-alarm-pager {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: 6px 0 0;
  margin-top: auto;
}

.camera-alarm-pager__status {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* 表格自己滚：行数由每页行数决定，卡片高度仍然由那一行里更高的 PRPD 决定。 */
.camera-alarm-entry__list > .camera-alarm-table,
.camera-alarm-entry__list > .camera-alarm-pager {
  flex: 0 0 auto;
}

.camera-alarm-entry__list {
  overflow-y: auto;
}


.camera-alarm-result__indicator--quiet {
  background: #36c275;
  box-shadow: 0 0 0 3px rgba(54, 194, 117, 0.10);
}

.camera-alarm-result--compact .camera-alarm-entry__items,
.camera-alarm-history-card .camera-alarm-entry__items {
  max-height: 235px;
  overflow: auto;
}

/*
 * 告警卡内容铺满整张卡（业主 2026-09-24：「告警信息应该占据全部卡片」）：
 * 网格行高由旁边三张图撑出来，列表 flex 撑满并自己滚动，而不是只顶上部的
 * 180/235px 一条。行可点（进事件中心的关联细节），鼠标给手型与悬停底色。
 */
.camera-alarm-history-card {
  display: flex;
  flex-direction: column;
}

.camera-alarm-history-card .camera-alarm-entry__list {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.camera-alarm-history-card .camera-alarm-entry__items {
  max-height: none;
  flex: 1 1 auto;
  min-height: 0;
}

.camera-alarm-history-card .camera-alarm-entry__items li {
  cursor: pointer;
  border-radius: var(--radius-sm, 6px);
  padding: 2px 4px;
}

.camera-alarm-history-card .camera-alarm-entry__items li:hover {
  background: var(--color-bg-subtle);
}


@media (max-width: 760px) {
  .camera-realtime-grid {
    grid-template-columns: 1fr;
  }

}


.camera-mode-mismatch__facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
  margin: var(--space-4) 0 0;
}

.camera-mode-mismatch__facts > div {
  padding: var(--space-3);
  border: 1px solid var(--color-border-subtle, #e5e7eb);
  border-radius: var(--radius-md, 8px);
  background: var(--color-bg-subtle, #f7f8fa);
}

.camera-mode-mismatch__facts dt {
  margin-bottom: 4px;
  color: var(--color-text-muted, #6b7280);
  font-size: 11px;
}

.camera-mode-mismatch__facts dd {
  margin: 0;
  font-weight: 600;
}

</style>
