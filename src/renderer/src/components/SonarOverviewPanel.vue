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
import type { E2SyncOutcome } from '@shared/ipc/contract'
import type { E2RealtimeCallbackStatus } from '@shared/domain/e2-callback'
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

const props = defineProps<{ deviceId: string }>()

const { t } = useI18n()
const devices = useDevicesStore()
const e2Realtime = useE2RealtimeStore()
const uiRefresh = useUiRefreshStore()
const session = useSessionStore()

const device = computed(() => devices.byId(props.deviceId))

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

async function loadAlarms(): Promise<void> {
  if (!props.deviceId) return
  const result = await callApi(() => window.api.alarms.query({ deviceId: props.deviceId, limit: 200 }))
  alarms.value = result.success ? (unwrap(result)?.items ?? []) : []
}

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
    if (result.success) await loadAlarms()
  } finally {
    alarmPolling = false
  }
}
/** 最近一次告警（query 按时间倒序，第一条就是）。 */
const latestAlarm = computed(() => alarms.value[0])
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

/** 指向方向：优先最近告警，其次安装方位角。 */
const direction = computed(() => latestAlarmDirection.value ?? azimuth.value)

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
      await callApi(() => window.api.e2.stopAudio(props.deviceId))
      await liveAudio.suspend()
      return
    }
    await liveAudio.resume()
    const result = await callApi(() => window.api.e2.startAudio(props.deviceId))
    if (!result.success) {
      liveAudioError.value = resultMessage(result)
      await liveAudio.suspend()
      return
    }
    liveAudioEnabled.value = true
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
const callback = ref<E2RealtimeCallbackStatus | null>(null)
const callbackBusy = ref(false)
const callbackError = ref('')
const callbackNotice = ref('')
const recordSyncBusy = ref(false)
const recordSyncError = ref('')
const recordSyncNotice = ref('')

const callbackReady = computed(
  () => callback.value?.pointsToUs === true && callback.value?.isSendRealtimeValue === 1
)

async function loadCallback(): Promise<void> {
  const result = await callApi(() => window.api.e2.realtimeCallback(props.deviceId))
  if (!result.success) {
    callbackError.value = resultMessage(result)
    return
  }
  callbackError.value = ''
  callback.value = unwrap(result) ?? null
}

async function enableRealtime(): Promise<void> {
  if (callbackBusy.value) return
  callbackBusy.value = true
  callbackError.value = ''
  callbackNotice.value = ''
  try {
    const result = await callApi(() => window.api.e2.setRealtimeCallback(props.deviceId, true))
    if (!result.success) {
      callbackError.value = resultMessage(result)
      return
    }
    callbackNotice.value = t('sonarUi.waitingRealtime')
    // 设备写入成功不等于监听已经起来（端口/地址可能失败）：
    // 等几轮读回，避免界面一直停在「未接入」。
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await loadCallback()
  await loadPtz()
      if (callbackReady.value) break
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    if (!callbackReady.value && callback.value?.listener?.error) {
      callbackError.value = callback.value.listener.error
    }
  } finally {
    callbackBusy.value = false
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
  await loadCallback()
  await loadPtz()
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
    await loadLatestSnapshot(latestAlarm.value)
  }
)
// 最近一条变了（新告警进来）就换抓图。
watch(latestAlarm, (alarm) => void loadLatestSnapshot(alarm))
</script>

<template>
  <div class="sonar-board">
    <!-- 左 66%：GIS 地图（16:9，设备居中） -->
    <section class="card sonar-map" data-sonar-map>
      <div class="section-header">
        <h3 class="section-title">{{ t('sonarUi.mapTitle') }}</h3>
      </div>
      <DeviceLocationMap
        :installation="device?.installation"
        :device-id="props.deviceId"
        :device-name="device?.name"
      />
    </section>

    <!-- 右列：第一行当前值，第二行最近一次告警 -->
    <div class="sonar-side">
      <section class="card sonar-ptz" data-sonar-ptz-preview>
        <div class="section-header">
          <h3 class="section-title">{{ t('sonarUi.ptzPreviewTitle') }}</h3>
          <span v-if="ptz?.cameraIp" class="muted mono">{{ ptz.cameraIp }}</span>
        </div>
        <div class="sonar-ptz__placeholder">
          <p v-if="ptz?.enabled">{{ t('sonarUi.ptzPreviewReserved') }}</p>
          <p v-else class="muted">{{ t('sonarUi.ptzNotLinked') }}</p>
        </div>
      </section>
      <section class="card sonar-now" data-sonar-now>
        <div class="sonar-now__spl">
          <span class="sonar-now__spl-value">{{ displaySpl === undefined ? '—' : formatNumber(displaySpl, 1) }}</span>
          <span class="sonar-now__spl-unit">dB</span>
        </div>
        <dl class="sonar-now__facts">
          <dt>{{ t('sonarUi.currentSpl') }}</dt>
          <dd>
            {{ displaySpl === undefined ? '—' : `${formatNumber(displaySpl, 1)} dB` }}
            <span v-if="!splIsLive && latestAlarmSpl !== undefined" class="muted"> · {{ t('sonarUi.latestAlarm') }}</span>
          </dd>
          <dt>{{ t('sonarUi.azimuth') }}</dt>
          <dd>
            {{ direction === undefined ? '—' : `${formatNumber(direction, 0)}°` }}
            <span v-if="latestAlarmDirection !== undefined" class="muted"> · {{ t('sonarUi.fromLatestAlarm') }}</span>
          </dd>
        </dl>
        <div v-if="!callbackReady" class="sonar-now__hint" data-sonar-realtime-off>
          <p class="muted">{{ t('sonarUi.realtimeOff') }}</p>
          <button
            v-if="session.isAdmin"
            type="button"
            class="btn btn--sm"
            :disabled="callbackBusy"
            data-sonar-enable-callback
            @click="enableRealtime"
          >
            {{ callbackBusy ? t('common.loading') : t('sonarUi.enableRealtime') }}
          </button>
        </div>
        <p v-else-if="currentSpl === undefined" class="muted" data-sonar-realtime-waiting>
          {{ t('sonarUi.waitingRealtime') }}
        </p>
        <p v-if="callbackError" class="alert alert--danger" role="alert">{{ callbackError }}</p>
        <p v-if="callbackNotice" class="muted" role="status">{{ callbackNotice }}</p>
        <button
          type="button"
          class="btn btn--sm"
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
          class="btn btn--sm btn--ghost"
          :disabled="liveAudioBusy"
          data-sonar-live-audio
          @click="toggleLiveAudio"
        >
          {{ liveAudioEnabled ? t('sonarUi.stopLiveAudio') : t('sonarUi.playLiveAudio') }}
        </button>
        <p v-if="liveAudioError" class="alert alert--danger" role="alert">{{ liveAudioError }}</p>
        <p v-if="!latestPlayable" class="muted" data-sonar-no-recording>
          {{ t('sonarUi.noAudio') }}
        </p>
        <p v-if="recordSyncError" class="alert alert--danger" role="alert">{{ recordSyncError }}</p>
        <p v-if="recordSyncNotice" class="muted" role="status">{{ recordSyncNotice }}</p>
        <button
          type="button"
          class="btn btn--sm btn--ghost"
          :disabled="recordSyncBusy"
          data-sonar-sync-recordings
          @click="syncRecordings"
        >
          {{ recordSyncBusy ? t('sonarUi.syncingRecordings') : t('sonarUi.syncRecordings') }}
        </button>
        <p v-if="audioError" class="alert alert--danger" role="alert">{{ audioError }}</p>
        <!-- 播放器元素不进可视布局：按钮与状态就是它的界面。 -->
        <audio ref="audioEl" :src="audioUrl" class="sonar-hidden-audio" @ended="audioPlaying = false"></audio>
      </section>

      <section class="card sonar-latest" data-sonar-latest>
        <div class="section-header">
          <h3 class="section-title">{{ t('sonarUi.latestAlarm') }}</h3>
        </div>
        <template v-if="latestAlarm">
          <img v-if="latestSnapshotUrl" :src="latestSnapshotUrl" class="sonar-latest__image" alt="" />
          <p v-else-if="latestSnapshotState === 'missing'" class="muted">{{ t('sonarUi.noSnapshot') }}</p>
          <dl class="sonar-latest__facts">
            <dt>{{ t('sonarUi.alarmDirection') }}</dt>
          <dd>
            {{ direction === undefined ? '—' : `${formatNumber(direction, 0)}°` }}
            <span v-if="latestAlarmDirection !== undefined" class="muted"> · {{ t('sonarUi.fromLatestAlarm') }}</span>
          </dd>
            <dt>{{ t('sonarUi.alarmSpl') }}</dt>
            <dd>{{ latestAlarm.spl === undefined ? '—' : `${formatNumber(latestAlarm.spl, 1)} dB` }}</dd>
            <dt>{{ t('sonarUi.alarmType') }}</dt>
            <dd>{{ latestAlarm.alarmTypes.length > 0 ? latestAlarm.alarmTypes.map(alarmTypeLabel).join(' + ') : '—' }}</dd>
            <dt>{{ t('sonarUi.alarmTime') }}</dt>
            <dd>{{ formatDateTime(latestAlarm.timestamp) }}</dd>
          </dl>
        </template>
        <p v-else class="muted">{{ t('sonarUi.noAlarms') }}</p>
      </section>
    </div>

    <!-- 下方：全部历史告警 -->
<div class="sonar-bottom">
    <section class="card sonar-history" data-sonar-history>
      <div class="section-header">
        <h3 class="section-title">{{ t('sonarUi.history') }}</h3>
        <span class="muted">{{ alarms.length }}</span>
      </div>
      <p v-if="alarms.length === 0" class="muted">{{ t('sonarUi.noAlarms') }}</p>
      <ul v-else class="sonar-history__list">
        <li v-for="alarm in alarms" :key="alarm.id">
          <span class="muted">{{ formatDateTime(alarm.timestamp) }}</span>
          <span>{{ alarm.alarmTypes.length > 0 ? alarm.alarmTypes.map(alarmTypeLabel).join(' + ') : '—' }}</span>
          <span class="muted">{{ alarm.spl === undefined ? '—' : `${formatNumber(alarm.spl, 1)} dB` }}</span>
          <span v-if="alarmAzimuthOf(alarm) !== undefined" class="muted">{{ t('sonarUi.alarmDirection') }} {{ formatNumber(alarmAzimuthOf(alarm), 0) }}°</span>
        </li>
      </ul>
    </section>
      <section class="card sonar-device-info" data-sonar-device-info>
        <div class="section-header">
          <h3 class="section-title">{{ t('sonarUi.deviceInfoTitle') }}</h3>
        </div>
        <dl class="sonar-device-info__facts">
          <div><dt>{{ t('sonarUi.deviceInfoIp') }}</dt><dd class="mono">{{ device?.ip || '—' }}</dd></div>
          <div><dt>{{ t('sonarUi.deviceInfoStatus') }}</dt><dd>{{ device?.status || '—' }}</dd></div>
          <div><dt>{{ t('sonarUi.deviceInfoFirmware') }}</dt><dd>{{ device?.firmwareVersion || '—' }}</dd></div>
        </dl>
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
</style>
