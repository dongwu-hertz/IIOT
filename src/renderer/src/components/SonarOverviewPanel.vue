<script setup lang="ts">
/**
 * Air Sonar（SN-16 空气声呐）实时监测总览（业主 2026-09-24 第 9 条改版）。
 *
 * 布局（业主原话）：
 *   - 左侧 66%：GIS 地图，16:9，所选设备居中；
 *   - 右侧第一行：当前分贝 / 当前方位指向 / 播放音频按钮；
 *   - 右侧第二行：最近一次告警（图片 / 告警方向 / 分贝 / 告警类型——类型字段预留
 *     软件后训练识别的接入位，当前显示设备上报的类型）；
 *   - 再下方：该设备全部历史告警。
 *
 * 诚实边界（这一族的真实能力，与 MonitorView 的注释一致）：
 *   - SN-16 的实时值来自设备回调推送（`e2Realtime` store）：没有推送时显示 —，
 *     不编一个"当前值"；
 *   - 方位指向 = 设备安装方位角（`azimuthDeg`，静态安装事实），不是波束方向；
 *   - 这一族没有实时音频流（协议有路径但帧格式未验）：「播放音频」播的是**最近一条
 *     可播放的告警录音**，按钮的名字就这么写，不叫"实时"。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AlarmEvent } from '@shared/domain/models'
import type { E2DeviceStatus, E2SyncOutcome } from '@shared/ipc/contract'
import type { E2PtzConfig } from '@shared/domain/e2-ptz'
import { useDevicesStore } from '@renderer/stores/devices'
import { useE2RealtimeStore } from '@renderer/stores/e2Realtime'
import { useUiRefreshStore } from '@renderer/stores/uiRefresh'
import { callApi, unwrap } from '@renderer/lib/result'
import { alarmTypeLabel } from '@renderer/lib/labels'
import { formatDateTime, formatNumber } from '@renderer/lib/format'
import { useSessionStore } from '@renderer/stores/session'
import { resultMessage } from '@renderer/lib/result'
import { PcmStreamPlayer } from '@renderer/lib/pcmStreamPlayer'
import DeviceLocationMap from '@renderer/components/DeviceLocationMap.vue'
import DeviceInstallationCard from '@renderer/components/DeviceInstallationCard.vue'

const props = defineProps<{
  deviceId: string
  settingsOpen?: boolean
}>()
const emit = defineEmits<{
  'update:settingsOpen': [value: boolean]
}>()
const { t } = useI18n()
const devices = useDevicesStore()
const e2Realtime = useE2RealtimeStore()
const uiRefresh = useUiRefreshStore()
const session = useSessionStore()

const device = computed(() => devices.byId(props.deviceId))

const settingsOpen = computed({
  get: () => props.settingsOpen ?? false,
  set: (value: boolean) => emit('update:settingsOpen', value)
})


// ---------------------------------------------------------------------------
// GIS 地图（本机 SVG：设备居中 + 方位箭头；离线优先，不出网）
// ---------------------------------------------------------------------------

/** 设备有没有可画的坐标（GIS 坐标在安装信息里，`installation.gisLatitude` 那一组）。 */
/** 安装方位角（0 = 正北，顺时针）。 */
const azimuth = computed(() => device.value?.installation?.azimuthDeg)

// ---------------------------------------------------------------------------
// 当前分贝 / 方位
// ---------------------------------------------------------------------------

const currentSpl = computed(() => {
  const value = e2Realtime.latestFor(props.deviceId)?.value.maxDbValue
  return value !== undefined && Number.isFinite(value) ? value : undefined
})

// ---------------------------------------------------------------------------
// 历史告警 + 最近一次告警
// ---------------------------------------------------------------------------

const alarms = ref<AlarmEvent[]>([])
const alarmsTotal = ref(0)
const alarmPageSize = ref(20)
const alarmOffset = ref(0)
const alarmFrom = ref('')
const alarmTo = ref('')
const alarmLoading = ref(false)
const latestAlarm = ref<AlarmEvent | undefined>()

const alarmPage = computed(() => Math.floor(alarmOffset.value / alarmPageSize.value) + 1)
const alarmPageCount = computed(() => Math.max(1, Math.ceil(alarmsTotal.value / alarmPageSize.value)))

async function loadLatestAlarm(): Promise<void> {
  const result = await callApi(() => window.api.alarms.query({ deviceId: props.deviceId, limit: 1 }))
  latestAlarm.value = result.success ? unwrap(result)?.items?.[0] : undefined
}

async function loadAlarms(): Promise<void> {
  if (!props.deviceId) return
  alarmLoading.value = true
  try {
    const from = alarmFrom.value === '' ? undefined : new Date(`${alarmFrom.value}T00:00:00`).getTime()
    const to = alarmTo.value === '' ? undefined : new Date(`${alarmTo.value}T23:59:59.999`).getTime()
    const result = await callApi(() => window.api.alarms.query({
      deviceId: props.deviceId,
      limit: alarmPageSize.value,
      offset: alarmOffset.value,
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {})
    }))
    alarms.value = result.success ? (unwrap(result)?.items ?? []) : []
    alarmsTotal.value = result.success ? (unwrap(result)?.total ?? alarms.value.length) : 0
  } finally {
    alarmLoading.value = false
  }
}

function applyAlarmFilters(): void {
  alarmOffset.value = 0
  void loadAlarms()
}

function previousAlarmPage(): void {
  if (alarmOffset.value === 0) return
  alarmOffset.value = Math.max(0, alarmOffset.value - alarmPageSize.value)
  void loadAlarms()
}

function nextAlarmPage(): void {
  if (alarmPage.value >= alarmPageCount.value) return
  alarmOffset.value += alarmPageSize.value
  void loadAlarms()
}

/** 最近一次告警（独立于筛选/翻页，始终取全库最新一条）。 */


/**
 * 轻量轮询：只拉最近 5 条告警元数据，不下载音频。
 *
 * SN-16 的 `realtime_value` 只有 SPL/TDE/FDE，没有方向；方向只出现在 `alarm_msg`
 * 告警日志的 `horizontal` 里。这里每 5 秒轻量同步一次，让方向/最近告警读数在设备持续
 * 产生告警时接近实时；不伪造一个没有数据源的实时角度。
 */
let alarmPollTimer: number | undefined
let alarmPolling = false
async function pollLatestAlarms(): Promise<void> {
  if (alarmPolling || props.deviceId === '') return
  alarmPolling = true
  try {
    const result = await callApi(() =>
      window.api.e2.syncAlarms(props.deviceId, { limit: 5, downloadAudio: false })
    )
    if (result.success) await Promise.all([loadLatestAlarm(), loadAlarms()])
  } finally {
    alarmPolling = false
  }
}
/** 最近一次告警（query 按时间倒序，第一条就是）。 */
/** 最近告警的声压级；实时回调没到时用它作为「最近一次」读数，并明确标注。 */
const latestAlarmSpl = computed(() => latestAlarm.value?.spl)
const displaySpl = computed(() => currentSpl.value ?? latestAlarmSpl.value)
const splIsLive = computed(() => currentSpl.value !== undefined)
/** 最近一条告警里的声源方位（设备原文 horizontal；取不到就不猜）。 */
function alarmAzimuthOf(alarm: AlarmEvent | undefined): number | undefined {
  const raw = alarm?.deviceRaw
  if (!raw) return undefined
  try {
    const value = Number((JSON.parse(raw) as Record<string, unknown>).horizontal)
    return Number.isFinite(value) ? ((value % 360) + 360) % 360 : undefined
  } catch {
    return undefined
  }
}

const latestAlarmDirection = computed(() => alarmAzimuthOf(latestAlarm.value))
/** 设备安装方位：作为告警相对角度的校准偏移。 */
const installationAzimuth = computed(() => device.value?.installation?.azimuthDeg ?? 0)

/** 实时声压 / 告警方向：设备原文 relative + 安装方位 = 软件校准后的方向。 */
const calibratedDirection = computed(() => {
  const relative = latestAlarmDirection.value
  if (relative === undefined) return azimuth.value
  return ((relative + installationAzimuth.value) % 360 + 360) % 360
})

const direction = computed(() => calibratedDirection.value)

const e2Status = ref<E2DeviceStatus | null>(null)
const statusLoading = ref(false)

const audioChannel = ref(1)
const audioChannelCount = computed(() => {
  const count = e2Status.value?.channelCount ?? devices.channelsOf(props.deviceId).length
  return count && count > 0 ? count : 16
})
const liveAudioChannel = ref<number | undefined>(undefined)


async function loadStatus(): Promise<void> {
  statusLoading.value = true
  try {
    const result = await callApi(() => window.api.e2.status(props.deviceId))
    e2Status.value = result.success ? unwrap(result) ?? null : null
  } finally {
    statusLoading.value = false
  }
}

async function onAudioChannelChange(): Promise<void> {
  if (!liveAudioEnabled.value) return
  await callApi(() => window.api.e2.stopAudio(props.deviceId))
  liveAudioEnabled.value = false
  liveAudioChannel.value = undefined
  await liveAudio.resume()
  const result = await callApi(() => window.api.e2.startAudio(props.deviceId, audioChannel.value))
  if (result.success) {
    liveAudioEnabled.value = true
    liveAudioChannel.value = audioChannel.value
  }
}

/** 指向方向：优先最近告警，其次安装方位角。 */

const liveAudio = new PcmStreamPlayer()
const liveAudioEnabled = ref(false)
const liveAudioBusy = ref(false)
const liveAudioError = ref('')
let unsubscribeLiveAudio: (() => void) | null = null

async function toggleLiveAudio(): Promise<void> {
  if (liveAudioBusy.value) return
  liveAudioBusy.value = true
  liveAudioError.value = ''
  try {
    if (liveAudioEnabled.value) {
      liveAudioEnabled.value = false
      liveAudioChannel.value = undefined
      await callApi(() => window.api.e2.stopAudio(props.deviceId))
      await liveAudio.suspend()
      return
    }
    await liveAudio.resume()
    const result = await callApi(() => window.api.e2.startAudio(props.deviceId, audioChannel.value))
    if (!result.success) {
      liveAudioError.value = resultMessage(result)
      await liveAudio.suspend()
      return
    }
    liveAudioEnabled.value = true
    liveAudioChannel.value = audioChannel.value
  } catch (error) {
    liveAudioError.value = error instanceof Error ? error.message : String(error)
    liveAudioEnabled.value = false
    await liveAudio.suspend()
  } finally {
    liveAudioBusy.value = false
  }
}
const ptz = ref<E2PtzConfig | null>(null)

async function loadPtz(): Promise<void> {
  const result = await callApi(() => window.api.e2.ptz(props.deviceId))
  ptz.value = result.success ? unwrap(result) ?? null : null
}
/** 右侧 PTZ 卡的两个内容：实时预览 / 告警视频。 */
const ptzPreviewMode = ref<'live' | 'alarm'>('live')

function togglePtzPreviewMode(): void {
  ptzPreviewMode.value = ptzPreviewMode.value === 'live' ? 'alarm' : 'live'
}
const recordSyncBusy = ref(false)
const recordSyncError = ref('')
const recordSyncNotice = ref('')
/** 指南针校准：直接编辑设备安装方位角（持久化到设备记录）。 */
const calibrationDeg = ref(0)
const calibrationBusy = ref(false)
const calibrationMessage = ref('')
watch(
  () => device.value?.installation?.azimuthDeg,
  (value) => {
    calibrationDeg.value = value ?? 0
  },
  { immediate: true }
)

async function saveCalibration(): Promise<void> {
  if (calibrationBusy.value) return
  const raw = Number(calibrationDeg.value)
  if (!Number.isFinite(raw)) return
  const degrees = ((raw % 360) + 360) % 360
  calibrationBusy.value = true
  calibrationMessage.value = ''
  try {
    const result = await callApi(() =>
      window.api.devices.update({
        id: props.deviceId,
        installation: { azimuthDeg: degrees }
      })
    )
    calibrationMessage.value = result.success ? t('sonarUi.calibrationSaved') : resultMessage(result)
  } finally {
    calibrationBusy.value = false
  }
}
async function syncRecordings(): Promise<void> {
  if (recordSyncBusy.value) return
  recordSyncBusy.value = true
  recordSyncError.value = ''
  recordSyncNotice.value = ''
  try {
    const result = await callApi(() =>
      window.api.e2.syncAlarms(props.deviceId, { limit: 200, downloadAudio: true })
    )
    if (!result.success) {
      recordSyncError.value = resultMessage(result)
      return
    }
    const outcome = unwrap(result) as E2SyncOutcome | undefined
    await loadLatestAlarm()
    await loadAlarms()
    recordSyncNotice.value = t('sonarUi.recordSyncDone', {
      saved: outcome?.audioSaved ?? 0,
      existing: outcome?.audioExisting ?? 0,
      missing: outcome?.filesMissing ?? 0
    })
  } finally {
    recordSyncBusy.value = false
  }
}

/** 最近告警的抓图（SN-16 的告警快照；设备没抓就老实说没有）。 */
const latestSnapshotUrl = ref('')
const latestSnapshotState = ref<'idle' | 'ok' | 'missing'>('idle')

async function loadLatestSnapshot(alarm: AlarmEvent | undefined): Promise<void> {
  latestSnapshotUrl.value = ''
  latestSnapshotState.value = 'idle'
  if (!alarm) return
  // 抓图是 E2（听诊盒子族）的能力；其它来源的告警没有这条路。
  const result = await callApi(() => window.api.e2.alarmSnapshots(alarm.deviceId, alarm.id))
  const view = result.success ? unwrap(result) : undefined
  const url = view?.state === 'ok' ? view.files[0]?.url ?? '' : ''
  if (url !== '') {
    latestSnapshotUrl.value = url
    latestSnapshotState.value = 'ok'
  } else {
    latestSnapshotState.value = 'missing'
  }
}

// ---------------------------------------------------------------------------
// 播放最近一条可播放的告警录音
// ---------------------------------------------------------------------------

const audioEl = ref<HTMLAudioElement | null>(null)
const audioUrl = ref('')
const audioBusy = ref(false)
const audioPlaying = ref(false)
const audioError = ref('')

/** 最近一条**有可播放录音**的告警。 */
const latestPlayable = computed(() =>
  alarms.value.find(
    (alarm) => alarm.localRecordingId !== undefined && alarm.localRecordingContainer !== undefined
  )
)

async function toggleAudio(): Promise<void> {
  audioError.value = ''
  if (audioPlaying.value) {
    audioEl.value?.pause()
    audioPlaying.value = false
    return
  }
  const alarm = latestPlayable.value
  if (!alarm?.localRecordingId) return
  audioBusy.value = true
  try {
    const result = await callApi(() => window.api.playback.load(alarm.localRecordingId as string))
    const payload = result.success ? unwrap(result) : undefined
    if (!payload || payload.audioBase64 === '') {
      audioError.value = t('sonarUi.noAudio')
      return
    }
    const bytes = Uint8Array.from(atob(payload.audioBase64), (char) => char.charCodeAt(0))
    if (audioUrl.value !== '') URL.revokeObjectURL(audioUrl.value)
    audioUrl.value = URL.createObjectURL(new Blob([bytes], { type: payload.mimeType }))
    await audioEl.value?.play()
    audioPlaying.value = true
  } finally {
    audioBusy.value = false
  }
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

onMounted(async () => {
  e2Realtime.acquire()
  unsubscribeLiveAudio = window.events.onE2AudioFrame((event) => {
    if (event.deviceId === props.deviceId && liveAudioEnabled.value) {
      liveAudio.push(event.samples, event.sampleRate)
    }
  })
  await loadPtz()
  await loadStatus()
  await loadLatestAlarm()
  await loadAlarms()
  await loadLatestSnapshot(latestAlarm.value)
  alarmPollTimer = window.setInterval(() => void pollLatestAlarms(), 5_000)
})

onBeforeUnmount(() => {
  e2Realtime.release()
  unsubscribeLiveAudio?.()
  unsubscribeLiveAudio = null
  void liveAudio.close()
  if (liveAudioEnabled.value) void callApi(() => window.api.e2.stopAudio(props.deviceId))
  if (alarmPollTimer !== undefined) window.clearInterval(alarmPollTimer)
  if (audioEl.value) audioEl.value.pause()
  if (audioUrl.value !== '') URL.revokeObjectURL(audioUrl.value)
})

// 顶栏「刷新」会 bump `uiRefresh.tick`：跟着重读告警与最近告警的抓图。
watch(
  () => uiRefresh.tick,
  async () => {
    await loadAlarms()
    await loadStatus()
    await loadLatestSnapshot(latestAlarm.value)
  }
)
// 最近一条变了（新告警进来）就换抓图。
watch(latestAlarm, (alarm) => void loadLatestSnapshot(alarm))
</script>

<template>
  <div class="sonar-shell">
    <div class="sonar-board">
      <section class="card sonar-view" data-sonar-map>
        <div class="section-header">
          <h3 class="section-title">{{ t('sonarUi.mapTitle') }}</h3>
        </div>
        <DeviceLocationMap
          :installation="device?.installation"
          :device-id="props.deviceId"
          :device-name="device?.name"
        />
      </section>

      <div class="sonar-side">
        <section class="card sonar-ptz" data-sonar-ptz-preview>
          <div class="section-header">
            <h3 class="section-title">
              {{ ptzPreviewMode === 'live' ? t('sonarUi.ptzLivePreview') : t('sonarUi.ptzAlarmVideo') }}
            </h3>
            <div class="sonar-ptz__head-actions">
              <span v-if="ptz?.cameraIp" class="muted mono">{{ ptz.cameraIp }}</span>
              <button
                type="button"
                class="btn btn--sm btn--icon"
                :title="ptzPreviewMode === 'live' ? t('sonarUi.ptzAlarmVideo') : t('sonarUi.ptzLivePreview')"
                :aria-label="ptzPreviewMode === 'live' ? t('sonarUi.ptzAlarmVideo') : t('sonarUi.ptzLivePreview')"
                data-sonar-ptz-mode-toggle
                @click="togglePtzPreviewMode"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M4 8h14m0 0-3-3m3 3-3 3M20 16H6m0 0 3-3m-3 3 3 3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
            </div>
          </div>
          <div class="sonar-ptz__preview">
            <p v-if="!ptz?.enabled" class="muted">{{ t('sonarUi.ptzNotLinked') }}</p>
            <p v-else-if="ptzPreviewMode === 'live'">{{ t('sonarUi.ptzLiveReserved') }}</p>
            <p v-else>{{ t('sonarUi.ptzAlarmReserved') }}</p>
          </div>
        </section>

        <section class="card sonar-device" data-sonar-now>
          <div class="section-header">
            <h3 class="section-title">{{ t('sonarUi.deviceTitle') }}</h3>
          </div>

          <div class="sonar-device__hero">
            <div class="sonar-now__spl">
              <span class="sonar-now__spl-value">{{ displaySpl === undefined ? '—' : formatNumber(displaySpl, 1) }}</span>
              <span class="sonar-now__spl-unit">dB</span>
              <span v-if="!splIsLive && latestAlarmSpl !== undefined" class="muted sonar-now__source">{{ t('sonarUi.latestAlarm') }}</span>
            </div>
            <div class="sonar-compass" data-sonar-compass>
              <svg viewBox="0 0 80 80" width="80" height="80" aria-hidden="true">
                <circle cx="40" cy="40" r="33" class="sonar-compass__ring" />
                <text x="40" y="10" text-anchor="middle" class="sonar-compass__n">N</text>
                <text x="73" y="44" text-anchor="middle" class="sonar-compass__tick">E</text>
                <text x="40" y="77" text-anchor="middle" class="sonar-compass__tick">S</text>
                <text x="7" y="44" text-anchor="middle" class="sonar-compass__tick">W</text>
                <g :transform="`rotate(${direction ?? 0} 40 40)`">
                  <polygon points="40,13 34,46 40,41 46,46" class="sonar-compass__needle" />
                </g>
                <circle cx="40" cy="40" r="3" class="sonar-compass__hub" />
              </svg>
              <strong>{{ direction === undefined ? '—' : `${formatNumber(direction, 0)}°` }}</strong>
              <span class="muted">{{ t('sonarUi.calibratedDirection') }}</span>
            </div>
          </div>
          <div class="sonar-device__audio-toolbar">
            <span class="sonar-device__audio-label">{{ t('sonarUi.audioChannel') }}</span>
            <select
              v-model.number="audioChannel"
              class="select sonar-device__audio-select"
              :disabled="liveAudioBusy"
              data-sonar-audio-channel
              @change="onAudioChannelChange"
            >
              <option v-for="channel in audioChannelCount" :key="channel" :value="channel">CH{{ channel }}</option>
            </select>
            <button
              type="button"
              class="btn btn--sm sonar-device__text-button"
              :class="{ 'btn--danger': audioPlaying }"
              :disabled="audioBusy || !latestPlayable"
              :title="latestPlayable ? '' : t('sonarUi.noAudio')"
              data-sonar-audio
              @click="toggleAudio"
            >
              {{ audioPlaying ? t('sonarUi.stopAudio') : t('sonarUi.playAudio') }}
            </button>
            <button
              type="button"
              class="btn btn--sm btn--primary sonar-device__text-button"
              :disabled="liveAudioBusy"
              data-sonar-live-audio
              @click="toggleLiveAudio"
            >
              {{ liveAudioEnabled ? t('sonarUi.stopPullAudio') : t('sonarUi.pullAudio') }}
            </button>
            <button
              type="button"
              class="btn btn--sm sonar-device__text-button"
              :disabled="recordSyncBusy"
              data-sonar-sync-recordings
              @click="syncRecordings"
            >
              {{ recordSyncBusy ? t('sonarUi.syncingRecordings') : t('sonarUi.syncRecordings') }}
            </button>
          </div>
          <p v-if="liveAudioEnabled" class="muted sonar-device__pulling">
            {{ t('sonarUi.pullingAudio', { channel: liveAudioChannel ?? audioChannel }) }}
          </p>
          <p v-if="liveAudioError" class="alert alert--danger" role="alert">{{ liveAudioError }}</p>
          <p v-if="!latestPlayable" class="muted" data-sonar-no-recording>{{ t('sonarUi.noAudio') }}</p>
          <p v-if="recordSyncError" class="alert alert--danger" role="alert">{{ recordSyncError }}</p>
          <p v-if="recordSyncNotice" class="muted" role="status">{{ recordSyncNotice }}</p>
          <p v-if="audioError" class="alert alert--danger" role="alert">{{ audioError }}</p>

          <div class="sonar-device__latest" data-sonar-latest>
            <div class="section-header">
              <h3 class="section-title">{{ t('sonarUi.latestAlarm') }}</h3>
            </div>
            <template v-if="latestAlarm">
              <img v-if="latestSnapshotUrl" :src="latestSnapshotUrl" class="sonar-latest__image" alt="" />
              <p v-else-if="latestSnapshotState === 'missing'" class="muted">{{ t('sonarUi.noSnapshot') }}</p>
              <RouterLink
                class="sonar-device__latest-link"
                :to="{ path: '/alarms', query: { device: props.deviceId, alarm: latestAlarm.id } }"
                data-sonar-latest-link
              >
                <dl class="sonar-latest__facts">
                  <dt>{{ t('sonarUi.alarmTime') }}</dt>
                  <dd>{{ formatDateTime(latestAlarm.timestamp) }}</dd>
                  <dt>{{ t('sonarUi.alarmDirection') }}</dt>
                  <dd>{{ direction === undefined ? '—' : `${formatNumber(direction, 0)}°` }}</dd>
                  <dt>{{ t('sonarUi.alarmType') }}</dt>
                  <dd>{{ latestAlarm.alarmTypes.length > 0 ? latestAlarm.alarmTypes.map(alarmTypeLabel).join(' + ') : t('sonarUi.acousticEvent') }}</dd>
                </dl>
              </RouterLink>
            </template>
            <p v-else class="muted">{{ t('sonarUi.noAlarms') }}</p>
          </div>
          <audio ref="audioEl" :src="audioUrl" class="sonar-hidden-audio" @ended="audioPlaying = false"></audio>
        </section>
      </div>
    </div>

    <div class="sonar-bottom">
      <section class="card sonar-history" data-sonar-history>
        <div class="section-header">
          <h3 class="section-title">{{ t('sonarUi.history') }}</h3>
          <span class="muted">{{ alarmsTotal }}</span>
        </div>

        <div class="sonar-history__filters">
          <label class="field">
            <span class="field-label">{{ t('sonarUi.historyFrom') }}</span>
            <input v-model="alarmFrom" type="date" class="input" data-sonar-history-from />
          </label>
          <label class="field">
            <span class="field-label">{{ t('sonarUi.historyTo') }}</span>
            <input v-model="alarmTo" type="date" class="input" data-sonar-history-to />
          </label>
          <label class="field">
            <span class="field-label">{{ t('sonarUi.historyPageSize') }}</span>
            <select v-model.number="alarmPageSize" class="select" data-sonar-history-page-size @change="applyAlarmFilters">
              <option :value="20">20</option>
              <option :value="50">50</option>
              <option :value="100">100</option>
              <option :value="200">200</option>
            </select>
          </label>
          <button type="button" class="btn btn--sm" data-sonar-history-apply @click="applyAlarmFilters">
            {{ t('sonarUi.historyApply') }}
          </button>
        </div>

        <p v-if="alarmLoading && alarms.length === 0" class="muted">{{ t('common.loading') }}</p>
        <p v-else-if="alarms.length === 0" class="muted">{{ t('sonarUi.noAlarms') }}</p>
        <ul v-else class="sonar-history__list">
          <li v-for="alarm in alarms" :key="alarm.id">
            <span class="muted">{{ formatDateTime(alarm.timestamp) }}</span>
            <span>{{ alarm.alarmTypes.length > 0 ? alarm.alarmTypes.map(alarmTypeLabel).join(' + ') : t('sonarUi.acousticEvent') }}</span>
            <span class="muted">{{ alarm.spl === undefined ? '—' : `${formatNumber(alarm.spl, 1)} dB` }}</span>
            <span v-if="alarmAzimuthOf(alarm) !== undefined" class="muted">{{ t('sonarUi.alarmDirection') }} {{ formatNumber(alarmAzimuthOf(alarm), 0) }}°</span>
          </li>
        </ul>

        <div class="sonar-history__pager">
          <button type="button" class="btn btn--sm" :disabled="alarmOffset === 0 || alarmLoading" data-sonar-history-prev @click="previousAlarmPage">
            {{ t('mapUi.pagePrev') }}
          </button>
          <span class="muted">{{ t('mapUi.pageStatus', { page: alarmPage, pages: alarmPageCount }) }}</span>
          <button type="button" class="btn btn--sm" :disabled="alarmPage >= alarmPageCount || alarmLoading" data-sonar-history-next @click="nextAlarmPage">
            {{ t('mapUi.pageNext') }}
          </button>
        </div>
      </section>

      <section class="card sonar-device-status" data-sonar-device-status>
        <div class="section-header">
          <h3 class="section-title">{{ t('e2Ui.statusTitle') }}</h3>
          <button type="button" class="btn btn--sm" :disabled="statusLoading" @click="loadStatus">
            {{ statusLoading ? t('common.loading') : t('common.refresh') }}
          </button>
        </div>
        <template v-if="e2Status">
          <dl class="sonar-device-info__facts">
            <div><dt>{{ t('e2Ui.variant') }}</dt><dd>{{ e2Status.variant ?? '—' }}</dd></div>
            <div><dt>{{ t('e2Ui.samplerate') }}</dt><dd>{{ e2Status.samplerate !== undefined ? `${e2Status.samplerate} Hz` : '—' }}</dd></div>
            <div><dt>{{ t('e2Ui.channelCount') }}</dt><dd>{{ e2Status.channelCount ?? '—' }}</dd></div>
            <div><dt>{{ t('e2Ui.deviceType') }}</dt><dd class="mono">{{ e2Status.basic.devType ?? '—' }}</dd></div>
            <div><dt>{{ t('e2Ui.firmware') }}</dt><dd>{{ e2Status.basic.devVersion ?? '—' }}</dd></div>
            <div><dt>{{ t('e2Ui.retention') }}</dt><dd>{{ t('e2Ui.retentionValue', { count: e2Status.alarmLogRetention }) }}</dd></div>
          </dl>
        </template>
        <p v-else class="muted">{{ t('common.loading') }}</p>
      </section>
    </div>
    <div v-if="settingsOpen" class="sonar-settings-overlay" data-sonar-settings-overlay @click.self="settingsOpen = false">
      <section class="card sonar-settings" role="dialog" aria-modal="true" data-sonar-settings-panel>
        <div class="sonar-settings__head">
          <h3 class="section-title">{{ t('sonarUi.settingsTitle') }}</h3>
          <button
            type="button"
            class="btn btn--sm btn--icon"
            :aria-label="t('common.close')"
            :title="t('common.close')"
            data-sonar-settings-close
            @click="settingsOpen = false"
          >×</button>
        </div>
        <div class="sonar-settings__grid">
          <section class="sonar-settings__section" data-sonar-device-info>
            <h4>{{ t('sonarUi.deviceInfoTitle') }}</h4>
            <dl class="sonar-device-info__facts">
              <div><dt>{{ t('devicesUi.deviceId') }}</dt><dd class="mono">{{ device?.deviceUid || '—' }}</dd></div>
              <div><dt>{{ t('sonarUi.deviceInfoIp') }}</dt><dd class="mono">{{ device?.ip || '—' }}</dd></div>
              <div><dt>{{ t('deviceDetailUi.mac') }}</dt><dd class="mono">{{ device?.mac || '—' }}</dd></div>
              <div><dt>{{ t('sonarUi.deviceInfoStatus') }}</dt><dd>{{ device?.status || '—' }}</dd></div>
              <div><dt>{{ t('deviceDetailUi.firmware') }}</dt><dd>{{ device?.firmwareVersion || '—' }}</dd></div>
              <div><dt>{{ t('deviceDetailUi.fpga') }}</dt><dd>{{ device?.fpgaVersion || '—' }}</dd></div>
              <div><dt>{{ t('deviceDetailUi.webVersion') }}</dt><dd>{{ device?.webVersion || '—' }}</dd></div>
            </dl>
          </section>
          <DeviceInstallationCard
            :installation="device?.installation"
            :device-id="device?.id"
            :device-name="device?.name"
          />
          <section class="sonar-settings__section" data-sonar-calibration-setting>
            <h4>{{ t('sonarUi.calibrationAngle') }}</h4>
            <dl class="sonar-device-info__facts">
              <div>
                <dt>{{ t('sonarUi.installationOffset', { degrees: formatNumber(installationAzimuth, 0) }) }}</dt>
                <dd>{{ formatNumber(installationAzimuth, 0) }}°</dd>
              </div>
              <div>
                <dt>{{ t('sonarUi.calibrationAngle') }}</dt>
                <dd>
                  <input
                    v-model.number="calibrationDeg"
                    type="number"
                    min="0"
                    max="359"
                    step="1"
                    class="input sonar-compass__calibration-input"
                    :disabled="!session.isAdmin || calibrationBusy"
                    data-sonar-calibration-input
                    @change="saveCalibration"
                  />
                  °
                </dd>
              </div>
            </dl>
            <p v-if="calibrationMessage" class="muted" role="status">{{ calibrationMessage }}</p>
          </section>
        </div>
      </section>
    </div>
  </div>
</template>
<style scoped>
/* 业主 2026-09-24：地图 16:9、占 66% 宽；卡片间距统一。 */
.sonar-board {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  gap: var(--space-4);
  width: 100%;
}

.sonar-bottom {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-4);
  align-items: start;
}

.sonar-ptz__placeholder {
  aspect-ratio: 16 / 9;
  display: grid;
  place-items: center;
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-subtle);
  padding: var(--space-3);
  text-align: center;
}

.sonar-ptz__placeholder p {
  margin: 0;
  max-width: 36ch;
}

.sonar-device-info__facts {
  display: grid;
  gap: var(--space-2);
  margin: 0;
}

.sonar-device-info__facts > div {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  border-bottom: 1px solid var(--color-border);
  padding-bottom: var(--space-2);
}

.sonar-device-info__facts dt {
  color: var(--color-text-secondary);
}

.sonar-device-info__facts dd {
  margin: 0;
  text-align: right;
}

@media (max-width: 900px) {
  .sonar-bottom {
    grid-template-columns: 1fr;
  }
}
.sonar-map {
  min-width: 0;
}

.sonar-map__stage {
  aspect-ratio: 16 / 9;
  width: 100%;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-subtle);
  display: grid;
  place-items: center;
  overflow: hidden;
}

.sonar-map__svg {
  width: 100%;
  height: 100%;
}

.sonar-map__empty {
  padding: var(--space-4);
}

.sonar-side {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}

.sonar-now__spl {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.sonar-now__spl-value {
  font-size: 40px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.sonar-now__spl-unit {
  color: var(--color-text-secondary);
}

.sonar-now__facts,
.sonar-latest__facts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 12px;
  margin: var(--space-2) 0;
  font-size: 12.5px;
}

.sonar-now__facts dt,
.sonar-latest__facts dt {
  color: var(--color-text-secondary);
}

.sonar-now__facts dd,
.sonar-latest__facts dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}

.sonar-latest__image {
  width: 100%;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
}

.sonar-history {
  grid-column: auto;
  min-width: 0;
}

.sonar-history__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 320px;
  overflow-y: auto;
  font-size: 12.5px;
}

.sonar-history__list li {
  display: flex;
  gap: var(--space-3);
  align-items: baseline;
}

.sonar-hidden-audio {
  display: none;
}

@media (max-width: 1100px) {
  .sonar-board {
    grid-template-columns: 1fr;
  }
}
/* 业主 2026-11-13：标题栏设置入口 + 左视图切换 + 右 Device/历史等高。 */
.sonar-shell {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  width: 100%;
  height: clamp(520px, 68vh, 760px);
  min-width: 0;
}

.sonar-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: 32px;
}

.sonar-view-switch {
  display: inline-flex;
  padding: 3px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-subtle);
}

.sonar-view-switch__button {
  border: 0;
  background: transparent;
  color: var(--color-text-secondary);
  border-radius: var(--radius-sm);
  padding: 5px 12px;
  font-size: 12.5px;
  cursor: pointer;
}

.sonar-view-switch__button.is-active {
  background: var(--color-bg);
  color: var(--color-text);
  box-shadow: 0 1px 2px rgb(0 0 0 / 12%);
}

.sonar-settings-toggle.is-active {
  border-color: var(--color-accent);
  color: var(--color-accent);
}

.sonar-board {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  align-items: stretch;
  gap: var(--space-4);
  width: 100%;
  min-width: 0;
}

.sonar-view {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.sonar-ptz-view {
  flex: 1;
  min-height: 320px;
  display: grid;
  place-items: stretch;
}

.sonar-ptz-view .sonar-ptz__placeholder {
  aspect-ratio: auto;
  min-height: 320px;
  height: 100%;
}

.sonar-side {
  display: grid;
  grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--space-4);
  min-width: 0;
  min-height: 0;
}

.sonar-device,
.sonar-history {
  min-width: 0;
  min-height: 0;
}

.sonar-device {
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.sonar-device__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: var(--space-2) 0;
}

.sonar-device__latest {
  border-top: 1px solid var(--color-border);
  margin-top: var(--space-3);
  padding-top: var(--space-2);
}

.sonar-history {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sonar-history__list {
  flex: 1;
  min-height: 0;
  max-height: none;
  overflow-y: auto;
}

.sonar-settings-overlay {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: grid;
  place-items: center;
  padding: var(--space-4);
  background: rgb(0 0 0 / 45%);
}

.sonar-settings {
  width: min(960px, 92vw);
  max-height: 86vh;
  overflow: auto;
}

.sonar-settings__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}

.sonar-settings__grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  align-items: start;
  gap: var(--space-4);
}

.sonar-settings__section {
  min-width: 0;
}

.sonar-settings__section h4 {
  margin: 0 0 var(--space-2);
}

@media (max-width: 1000px) {
  .sonar-board,
  .sonar-settings__grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .sonar-side {
    grid-template-rows: minmax(320px, auto) minmax(320px, auto);
  }
}
/* 最终高度约束：左视图与右侧两卡等高，历史列表在卡内滚动。 */
.sonar-shell {
  height: auto;
}

.sonar-board {
  height: clamp(520px, 68vh, 760px);
}

.sonar-view,
.sonar-side {
  height: 100%;
}

.sonar-device,
.sonar-history {
  height: 100%;
}
/* 右侧：PTZ 预览在上，Device 与 Alarm history 在下方等分。 */
.sonar-side {
  grid-template-rows: minmax(150px, 34%) minmax(0, 1fr) minmax(0, 1fr);
}

.sonar-ptz {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.sonar-ptz__head-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.sonar-ptz__preview {
  flex: 1;
  min-height: 0;
  display: grid;
  place-items: center;
  padding: var(--space-3);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-subtle);
  text-align: center;
}

.sonar-ptz__preview p {
  margin: 0;
  max-width: 42ch;
}

@media (max-width: 1000px) {
  .sonar-side {
    grid-template-rows: minmax(220px, auto) minmax(320px, auto) minmax(320px, auto);
  }
}
/* 2026-11-13：右侧 PTZ + Device 两块合计与左侧地图等高；告警历史 + 设备状态在下方各 50%。 */
.sonar-side {
  grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
}

.sonar-bottom {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--space-4);
  align-items: stretch;
  width: 100%;
  height: 320px;
  margin-top: var(--space-4);
}

.sonar-bottom > .card {
  height: 100%;
  min-height: 0;
  min-width: 0;
}

.sonar-device__hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.sonar-now__source {
  margin-left: 4px;
  font-size: 11.5px;
}

.sonar-compass {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex: 0 0 auto;
  min-width: 92px;
  gap: 2px;
  font-variant-numeric: tabular-nums;
}

.sonar-compass__ring {
  fill: var(--color-bg-subtle);
  stroke: var(--color-border);
  stroke-width: 1.5;
}

.sonar-compass__n {
  fill: var(--color-danger);
  font-size: 10px;
  font-weight: 700;
}

.sonar-compass__tick {
  fill: var(--color-text-secondary);
  font-size: 9px;
}

.sonar-compass__needle {
  fill: var(--color-accent);
}

.sonar-compass__hub {
  fill: var(--color-text);
}

.sonar-compass strong {
  font-size: 12.5px;
}

.sonar-compass .muted {
  font-size: 10.5px;
}

.sonar-device__calibration {
  margin: 0 0 var(--space-2);
  color: var(--color-text-secondary);
  font-size: 11.5px;
}

.sonar-device__callback {
  border-top: 1px solid var(--color-border);
  border-bottom: 1px solid var(--color-border);
  padding: var(--space-2) 0;
  margin-bottom: var(--space-2);
}

.sonar-device__callback-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.sonar-device__callback p {
  margin: var(--space-1) 0;
  font-size: 11.5px;
}

.sonar-device__audio-row {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.sonar-device__audio-row .field {
  margin: 0;
}

.sonar-device__actions {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-2);
  margin: var(--space-2) 0;
}

.sonar-device__action-button {
  min-height: 38px;
  font-weight: 600;
  white-space: normal;
}

.sonar-device__action-button.btn--primary {
  box-shadow: 0 2px 8px color-mix(in srgb, var(--color-accent) 28%, transparent);
}

.sonar-device-status .sonar-device-info__facts {
  margin-top: var(--space-2);
}

@media (max-width: 1000px) {
  .sonar-bottom {
    grid-template-columns: minmax(0, 1fr);
  }
}
.sonar-compass__calibration {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-top: 3px;
  color: var(--color-text-secondary);
  font-size: 10px;
}

.sonar-compass__calibration-input {
  width: 48px;
  height: 23px;
  padding: 1px 4px;
  font-size: 10.5px;
}

.sonar-compass__calibration-message {
  max-width: 110px;
  font-size: 10px;
  text-align: center;
}

.sonar-device__audio-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: var(--space-2) 0 var(--space-1);
}

.sonar-device__audio-label {
  flex: 0 0 auto;
  color: var(--color-text-secondary);
  font-size: 12px;
}

.sonar-device__audio-select {
  flex: 0 0 78px;
  width: 78px;
  height: 32px;
  padding: 3px 6px;
}

.sonar-device__tool-button {
  width: 34px;
  min-width: 34px;
  height: 34px;
  padding: 0;
  display: inline-grid;
  place-items: center;
}

.sonar-device__pulling {
  margin: 2px 0 4px;
  font-size: 11px;
}
/* 与声学相机页修改后的卡片间距一致（8px）。 */
.sonar-shell,
.sonar-board,
.sonar-side,
.sonar-bottom {
  gap: 8px;
}

.sonar-bottom {
  margin-top: 8px;
}
.sonar-device__audio-toolbar {
  flex-wrap: wrap;
}

.sonar-device__text-button {
  min-height: 32px;
  padding: 4px 8px;
  font-size: 11.5px;
  line-height: 1.2;
  white-space: normal;
}
.sonar-device__latest-link {
  display: block;
  color: inherit;
  text-decoration: none;
  border-radius: var(--radius-sm);
}

.sonar-device__latest-link:hover {
  background: var(--color-bg-subtle);
}

.sonar-history__filters {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.sonar-history__filters .field {
  margin: 0;
}

.sonar-history__pager {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
.sonar-settings__section[data-sonar-calibration-setting] {
  grid-column: 1 / -1;
}
</style>
