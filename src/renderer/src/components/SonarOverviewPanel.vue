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
import { useDevicesStore } from '@renderer/stores/devices'
import { useE2RealtimeStore } from '@renderer/stores/e2Realtime'
import { useUiRefreshStore } from '@renderer/stores/uiRefresh'
import { callApi, unwrap } from '@renderer/lib/result'
import { alarmTypeLabel } from '@renderer/lib/labels'
import { formatDateTime, formatNumber } from '@renderer/lib/format'
import { useSessionStore } from '@renderer/stores/session'
import { resultMessage } from '@renderer/lib/result'

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
const hasGis = computed(
  () =>
    device.value?.installation?.gisLatitude !== undefined &&
    device.value?.installation?.gisLongitude !== undefined
)
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

/** 最近一次告警（query 按时间倒序，第一条就是）。 */
const latestAlarm = computed(() => alarms.value[0])
/** 最近一条告警里的声源方位（设备原文 horizontal；取不到就不猜）。 */
const latestAlarmDirection = computed(() => {
  const raw = latestAlarm.value?.deviceRaw
  if (!raw) return undefined
  try {
    const value = Number((JSON.parse(raw) as Record<string, unknown>).horizontal)
    return Number.isFinite(value) ? ((value % 360) + 360) % 360 : undefined
  } catch {
    return undefined
  }
})

/** 指向方向：优先最近告警，其次安装方位角。 */
const direction = computed(() => latestAlarmDirection.value ?? azimuth.value)

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
  await loadCallback()
  await loadAlarms()
  await loadLatestSnapshot(latestAlarm.value)
})

onBeforeUnmount(() => {
  e2Realtime.release()
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
      <div class="sonar-map__stage">
        <svg v-if="hasGis" viewBox="0 0 1280 720" class="sonar-map__svg" role="img">
          <!-- 本机网格（离线优先：不请求任何在线瓦片） -->
          <g stroke="var(--color-border)" stroke-width="1">
            <line v-for="x in 9" :key="`v${x}`" :x1="x * 128" y1="0" :x2="x * 128" y2="720" />
            <line v-for="y in 5" :key="`h${y}`" x1="0" :y1="y * 144" x2="1280" :y2="y * 144" />
          </g>
          <!-- 设备标记：居中，箭头指向安装方位角（0 = 正北 = 上方）。 -->
          <g :transform="`rotate(${direction ?? 0} 640 360)`">
            <line x1="640" y1="360" x2="640" y2="270" stroke="var(--color-accent)" stroke-width="3" />
            <path d="M640 258 l10 18 h-20 Z" fill="var(--color-accent)" />
          </g>
          <circle cx="640" cy="360" r="10" fill="var(--color-accent)" />
          <circle cx="640" cy="360" r="18" fill="none" stroke="var(--color-accent)" stroke-width="1.5" opacity="0.6" />
          <text x="640" y="402" text-anchor="middle" font-size="15" fill="var(--color-text-secondary)">
            {{ device?.name ?? '' }}
          </text>
        </svg>
        <p v-else class="muted sonar-map__empty">{{ t('sonarUi.noGis') }}</p>
      </div>
    </section>

    <!-- 右列：第一行当前值，第二行最近一次告警 -->
    <div class="sonar-side">
      <section class="card sonar-now" data-sonar-now>
        <div class="sonar-now__spl">
          <span class="sonar-now__spl-value">{{ currentSpl === undefined ? '—' : formatNumber(currentSpl, 1) }}</span>
          <span class="sonar-now__spl-unit">dB</span>
        </div>
        <dl class="sonar-now__facts">
          <dt>{{ t('sonarUi.currentSpl') }}</dt>
          <dd>{{ currentSpl === undefined ? '—' : `${formatNumber(currentSpl, 1)} dB` }}</dd>
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
        </li>
      </ul>
    </section>
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
  grid-column: 1 / -1;
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
