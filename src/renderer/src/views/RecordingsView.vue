<script setup lang="ts">
/**
 * Recordings (spec section 10.3).
 *
 * Playback is real: each row opens the shared `RecordingPlayer`, which calls
 * `window.api.playback.load(recordingId)`. That call downloads the clip from the
 * device first when there is no local file yet, which is why the play button is
 * enabled even for `未下载` rows — playback IS the download in that case.
 *
 * "同步设备录音" pulls the device's own recording library into the local
 * metadata database (`recordings.syncDevice`); the result count is surfaced and
 * the list is reloaded so the new rows (and their download state) appear
 * immediately.
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Recording, RecordingPage, RecordingQuery, RecordingType } from '@shared/domain/models'
import { CHANNEL_COUNT, recordingFormatLabel } from '@shared/domain/models'
import { useDevicesStore } from '@renderer/stores/devices'
import { useSamplesStore } from '@renderer/stores/samples'
import { recordingTypeLabel } from '@renderer/lib/labels'
import { channelState, channelStateLabelKey, type ChannelState } from '@renderer/lib/channelState'
import {
  channelLabel,
  EMPTY_VALUE,
  formatBytes,
  formatDateTime,
  formatDuration,
  formatSampleRate,
  fromDateTimeLocalValue
} from '@renderer/lib/format'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import RecordingPlayer from '@renderer/components/RecordingPlayer.vue'

const RECORDING_PAGE_SIZE = 50

const RECORDING_TYPE_OPTIONS: RecordingType[] = ['alarm', 'manual', 'scheduled']

const { t } = useI18n()
const devices = useDevicesStore()

interface FilterState {
  deviceId: string
  channelId: string
  recordingType: string
  from: string
  to: string
}

const filters = reactive<FilterState>({
  deviceId: '',
  channelId: '',
  recordingType: '',
  from: '',
  to: ''
})

const items = ref<Recording[]>([])
const total = ref(0)
const offset = ref(0)
const loading = ref(false)
const error = ref('')
const notice = ref('')

/** Currently selected recording in the master-detail workspace. */
const playingId = ref('')

/** Video preview uses the existing loopback HTTP URL so Range seeking keeps working. */
const videoUrl = ref('')
const videoError = ref('')
const videoTitle = ref('')

const playingRecording = computed(
  () => items.value.find((recording) => recording.id === playingId.value) ?? null
)

const playerTitle = computed(() =>
  playingRecording.value
    ? t('recordingsUi.playerTitleAt', { time: formatDateTime(playingRecording.value.startTime) })
    : t('recordingsUi.playerTitle')
)

/** 历史筛选用的通道项：带上状态，未启用/未知都要在文字里标出来。 */
interface ChannelOption {
  index: number
  name: string
  state: ChannelState
}

const channelOptions = computed<ChannelOption[]>(() => {
  if (filters.deviceId) {
    const list = devices.channelsOf(filters.deviceId)
    if (list.length > 0) {
      return [...list]
        .sort((a, b) => a.channelIndex - b.channelIndex)
        .map((channel) => ({
          index: channel.channelIndex,
          name: channel.channelName,
          state: channelState(channel)
        }))
    }
  }
  // 设备没返回通道表：状态是“未知”，不能当作“已启用”。
  return Array.from({ length: CHANNEL_COUNT }, (_, index) => ({
    index,
    name: '',
    state: 'unknown'
  }))
})

const canPrev = computed(() => offset.value > 0)
const canNext = computed(() => offset.value + items.value.length < total.value)

function buildQuery(): RecordingQuery {
  const query: RecordingQuery = {
    deviceId: filters.deviceId || undefined,
    limit: RECORDING_PAGE_SIZE,
    offset: offset.value
  }
  if (filters.channelId !== '') query.channelId = Number(filters.channelId)
  if (filters.recordingType !== '') query.recordingType = filters.recordingType as RecordingType
  const from = fromDateTimeLocalValue(filters.from)
  if (from !== undefined) query.from = from
  const to = fromDateTimeLocalValue(filters.to)
  if (to !== undefined) query.to = to
  return query
}

async function load(): Promise<void> {
  loading.value = true
  const result = await callApi(() => window.api.recordings.query(buildQuery()))
  loading.value = false
  if (!result.success) {
    error.value = resultMessage(result)
    items.value = []
    total.value = 0
    playingId.value = ''
    videoUrl.value = ''
    return
  }
  error.value = ''
  const page: RecordingPage | undefined = unwrap(result)
  items.value = page?.items ?? []
  total.value = page?.total ?? 0

  // Keep the selected item when it is still in the page; otherwise select the first
  // visible recording so the right-hand preview never looks disconnected from the list.
  if (!items.value.some((item) => item.id === playingId.value)) {
    playingId.value = ''
    videoUrl.value = ''
    videoError.value = ''
    const first = items.value[0]
    if (first) await openPlayer(first)
  }
}

/** Any filter change restarts from the first page. */
async function applyFilters(): Promise<void> {
  offset.value = 0
  await load()
}

function reset(): void {
  filters.deviceId = ''
  filters.channelId = ''
  filters.recordingType = ''
  filters.from = ''
  filters.to = ''
  void applyFilters()
}

async function goToPage(next: number): Promise<void> {
  offset.value = Math.max(0, next)
  await load()
}

/**
 * Open the player for one row.
 *
 * `playback.load` performs the download when the file is not local yet, so an
 * un-downloaded row is playable too — the first click just takes longer, which
 * is what the player's spinner is for.
 */
/** 手动录像落盘的是 MP4；音频录像才是 WAV/FLAC。 */
function isVideoRecording(recording: Recording): boolean {
  return /\.mp4$/i.test(recording.relativePath)
}

/**
 * 「格式」列。
 *
 * v5 之前视频录像行只能显示扩展名，因为 `audio_format` 的 CHECK 不允许 `mp4`，
 * 列里存的是借来的 `'wav'`。schema v5 之后容器就在 `container_format` 列，
 * 所以这里直接用共享的 `recordingFormatLabel()`——事件中心与录像页读同一个
 * 函数，不会对同一个文件给出两种说法。
 */
function formatLabel(recording: Recording): string {
  return recordingFormatLabel(recording) ?? EMPTY_VALUE
}

/** 采样率列：视频录像没有采样率可言，显示「—」而不是 0 Hz。 */
function sampleRateLabel(recording: Recording): string {
  if (isVideoRecording(recording)) return EMPTY_VALUE
  return formatSampleRate(recording.sampleRate)
}

/**
 * 把一段录音加进**本地样本库**（业主 2026-09-16）。
 *
 * 与告警入库最大的差别**必须说出来**：录音行不存特征值，所以入库之后这一条
 * 「有音频、没特征」，暂时进不了训练集。文案因此不能说笼统的"已添加"——
 * `metricsStored === 0` 时明说"暂无特征值，需人工标注后仍不能参与训练"，
 * 而不是让操作员以为素材已经能用了。
 */
const samples = useSamplesStore()
const sampleBusyId = ref('')

async function addToSamples(recording: Recording): Promise<void> {
  sampleBusyId.value = recording.id
  const outcome = await samples.addFromRecording(recording.id)
  sampleBusyId.value = ''
  if (!outcome) {
    notice.value = samples.error
    return
  }
  notice.value = outcome.created
    ? t('recordingsUi.sampleAddedNoMetrics')
    : t('recordingsUi.sampleAlreadyIn')
}

/**
 * 打开某一行。
 *
 * 两条路必须分开：
 *   - 音频录像走 `playback.load`（主进程把整段 WAV base64 推过来，几十 KB～几 MB）；
 *   - 视频录像走 `cameraNvr.videoUrl`（主进程只回一个回环 HTTP 地址，
 *     `<video>` 自己拉字节流，支持 Range 拖动）。
 * 拿不到地址时**明说无法播放**，而不是打开一个永远空着的播放器。
 */
async function openPlayer(recording: Recording): Promise<void> {
  playingId.value = recording.id
  videoTitle.value = formatDateTime(recording.startTime)
  videoUrl.value = ''
  videoError.value = ''

  // Audio is loaded on demand by RecordingPlayer. Video needs the loopback URL
  // immediately so the inline preview can seek with HTTP Range requests.
  if (!isVideoRecording(recording)) return

  const result = await callApi(() => window.api.cameraNvr.videoUrl(recording.id))
  if (!result.success) {
    videoError.value = resultMessage(result)
    return
  }
  videoUrl.value = unwrap(result)?.url ?? ''
  if (videoUrl.value === '') videoError.value = t('recordingsUi.videoUnavailable')
}

async function exportRecording(recording: Recording): Promise<void> {
  const result = await callApi(() => window.api.recordings.export(recording.id))
  if (!result.success) {
    notice.value = resultMessage(result)
    return
  }
  const saved = unwrap(result)
  if (saved) notice.value = t('alarmsUi.downloadDone', { path: saved.path })
}

/** A recording is local only when the metadata carries a stored relative path. */
function isDownloaded(recording: Recording): boolean {
  return recording.relativePath.trim() !== ''
}

/*
 * 「同步设备录音」的界面入口按产品要求删除了（2026-09-16）。
 *
 * 这里把随它一起失效的东西**一起删掉**，而不是留一个用不到的函数等以后：
 * 主进程那条 `recording:sync-device` 通道仍在、能力没丢，而"设备录音库怎么导入"这件事
 * 属于这一页要变成的**存储**页（按日期查看与回放）的范畴，等那一版成型时再决定落点。
 * 留一个没有任何调用点的函数，下一个人只会以为它还在被用。
 */

onMounted(async () => {
  if (devices.devices.length === 0) await devices.load()
  await load()
})

watch(
  () => ({ ...filters }),
  () => {
    void applyFilters()
  }
)

watch(
  () => filters.deviceId,
  (deviceId) => {
    if (deviceId) void devices.loadChannels(deviceId)
    filters.channelId = ''
  }
)
</script>

<template>
  <div class="page recordings-page">
    <p v-if="error" class="alert alert--danger" role="alert">{{ error }}</p>
    <p v-else-if="notice" class="alert alert--success" role="status">{{ notice }}</p>

    <!-- Compact filter bar. The media library should reach the list quickly, not spend the first screen on controls. -->
    <section class="card recordings-filters">
      <div class="recordings-filter-grid">
        <label class="field">
          <span class="field-label">{{ t('alarmsUi.filterDevice') }}</span>
          <select v-model="filters.deviceId" class="select">
            <option value="">{{ t('alarmsUi.filterAllDevices') }}</option>
            <option v-for="device in devices.devices" :key="device.id" :value="device.id">
              {{ device.name }}
            </option>
          </select>
        </label>

        <label class="field">
          <span class="field-label">{{ t('alarmsUi.filterChannel') }}</span>
          <select v-model="filters.channelId" class="select">
            <option value="">{{ t('alarmsUi.filterAllChannels') }}</option>
            <option v-for="channel in channelOptions" :key="channel.index" :value="channel.index">
              {{ channelLabel(channel.index) }}<template v-if="channel.name">（{{ channel.name }}）</template>
              <template v-if="channel.state !== 'enabled'">（{{ t(channelStateLabelKey(channel.state)) }}）</template>
            </option>
          </select>
        </label>

        <label class="field">
          <span class="field-label">{{ t('recordingsUi.filterType') }}</span>
          <select v-model="filters.recordingType" class="select">
            <option value="">{{ t('recordingsUi.filterAllTypes') }}</option>
            <option v-for="type in RECORDING_TYPE_OPTIONS" :key="type" :value="type">
              {{ recordingTypeLabel(type) }}
            </option>
          </select>
        </label>

        <label class="field">
          <span class="field-label">{{ t('alarmsUi.filterFrom') }}</span>
          <input v-model="filters.from" class="input" type="datetime-local" />
        </label>

        <label class="field">
          <span class="field-label">{{ t('alarmsUi.filterTo') }}</span>
          <input v-model="filters.to" class="input" type="datetime-local" />
        </label>

        <div class="recordings-filter-actions">
          <button type="button" class="btn btn--sm" @click="reset">{{ t('common.reset') }}</button>
        </div>
      </div>
    </section>

    <div class="recordings-workspace">
      <!-- Master list -->
      <section class="card recordings-master">
        <header class="recordings-master__head">
          <div>
            <h3 class="section-title">{{ t('recordingsUi.playerTitle') }}</h3>
            <p class="muted recordings-master__count">
              {{ t('alarmsUi.pagerRange', { from: offset + 1, to: offset + items.length, total }) }}
            </p>
          </div>
        </header>

        <div class="recording-list" role="list">
          <div v-if="items.length === 0" class="recording-list__empty">
            {{ loading ? t('alarmsUi.loading') : t('recordingsUi.empty') }}
          </div>

          <article
            v-for="recording in items"
            :key="recording.id"
            class="recording-row"
            :class="{ 'recording-row--active': playingId === recording.id }"
            role="listitem"
            tabindex="0"
            @click="openPlayer(recording)"
            @keydown.enter="openPlayer(recording)"
          >
            <div class="recording-row__icon" :class="{ 'recording-row__icon--video': isVideoRecording(recording) }" aria-hidden="true">
              <svg v-if="isVideoRecording(recording)" width="16" height="16" viewBox="0 0 16 16">
                <rect x="2.5" y="4" width="8.5" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/>
                <path d="M11 6.2l2.5-1.5v6.6L11 9.8z" fill="currentColor"/>
              </svg>
              <svg v-else width="16" height="16" viewBox="0 0 16 16">
                <path d="M3 9V7m2 5V4m2 9V3m2 8V5m2 4V7m2 1V6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
              </svg>
            </div>

            <div class="recording-row__body">
              <div class="recording-row__top">
                <strong>{{ formatDateTime(recording.startTime) }}</strong>
                <span class="recording-row__duration">{{ formatDuration(recording.durationMs) }}</span>
              </div>
              <div class="recording-row__meta">
                <span>{{ devices.nameById(recording.deviceId) }}</span>
                <span>·</span>
                <span>{{ channelLabel(recording.channelId) }}</span>
                <span>·</span>
                <span>{{ recordingTypeLabel(recording.recordingType) }}</span>
              </div>
              <div class="recording-row__bottom">
                <span class="chip chip--tiny">{{ formatLabel(recording) }}</span>
                <span v-if="recording.fileSize !== undefined" class="muted">{{ formatBytes(recording.fileSize) }}</span>
                <span class="recording-local-state" :class="isDownloaded(recording) ? 'recording-local-state--local' : 'recording-local-state--remote'">
                  <svg v-if="isDownloaded(recording)" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M3 8.5l3 3L13 4.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                  <svg v-else width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M5.2 12.5H4.5A2.5 2.5 0 014 7.55 4 4 0 0111.6 6.2 3 3 0 0112 12.2h-1" fill="none" stroke="currentColor" stroke-width="1.2"/>
                  </svg>
                  {{ isDownloaded(recording) ? t('recordingsUi.downloaded') : t('recordingsUi.notDownloaded') }}
                </span>
              </div>
            </div>

            <button
              type="button"
              class="btn btn--sm btn--icon recording-row__play"
              :aria-label="t('recordingsUi.playLabel', { time: formatDateTime(recording.startTime) })"
              :title="isDownloaded(recording) ? t('recordingsUi.playLocal') : t('recordingsUi.playRemote')"
              @click.stop="openPlayer(recording)"
            >
              <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3l9 5-9 5z" fill="currentColor" /></svg>
            </button>
          </article>
        </div>

        <div class="pager recordings-master__pager">
          <span class="muted">
            {{ t('alarmsUi.pagerRange', { from: offset + 1, to: offset + items.length, total }) }}
          </span>
          <div class="btn-row">
            <button type="button" class="btn btn--sm" :disabled="!canPrev" @click="goToPage(offset - RECORDING_PAGE_SIZE)">
              {{ t('alarmsUi.prevPage') }}
            </button>
            <button type="button" class="btn btn--sm" :disabled="!canNext" @click="goToPage(offset + RECORDING_PAGE_SIZE)">
              {{ t('alarmsUi.nextPage') }}
            </button>
          </div>
        </div>
      </section>

      <!-- Preview / metadata -->
      <section class="card recordings-preview">
        <template v-if="playingRecording">
          <header class="recordings-preview__head">
            <div>
              <h3 class="section-title">{{ playerTitle }}</h3>
              <p class="muted recordings-preview__sub">
                {{ devices.nameById(playingRecording.deviceId) }} · {{ channelLabel(playingRecording.channelId) }} · {{ recordingTypeLabel(playingRecording.recordingType) }}
              </p>
            </div>
            <div class="btn-row recordings-preview__actions">
              <button
                type="button"
                class="btn btn--sm btn--icon"
                :title="t('alarmsUi.menuDownload')"
                @click="exportRecording(playingRecording)"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M8 2v8m0 0l-3-3m3 3l3-3M3 13.5h10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
              <button
                type="button"
                class="btn btn--sm"
                :disabled="sampleBusyId === playingRecording.id"
                :title="t('recordingsUi.sampleHint')"
                @click="addToSamples(playingRecording)"
              >
                {{ t('recordingsUi.addToSamples') }}
              </button>
              <RouterLink
                v-if="playingRecording.recordingType === 'alarm'"
                class="btn btn--sm"
                :to="{ path: '/alarms', query: { device: playingRecording.deviceId } }"
              >
                {{ t('alarmsUi.detailTitle') }}
              </RouterLink>
            </div>
          </header>

          <div class="recordings-preview__scroll">
            <div v-if="isVideoRecording(playingRecording)" class="video-preview-shell">
              <video v-if="videoUrl" class="video-player" :src="videoUrl" controls autoplay></video>
              <p v-else-if="videoError" class="alert alert--danger" role="alert">{{ videoError }}</p>
              <p v-else class="muted" role="status">{{ t('recordingsUi.videoLoading') }}</p>
            </div>

            <RecordingPlayer v-else :recording-id="playingRecording.id" />

            <section class="recording-facts">
              <div class="recording-fact">
                <span class="recording-fact__label">{{ t('recordingsUi.columnStart') }}</span>
                <strong>{{ formatDateTime(playingRecording.startTime) }}</strong>
              </div>
              <div class="recording-fact">
                <span class="recording-fact__label">{{ t('recordingsUi.columnDuration') }}</span>
                <strong>{{ formatDuration(playingRecording.durationMs) }}</strong>
              </div>
              <div class="recording-fact">
                <span class="recording-fact__label">{{ t('recordingsUi.columnFormat') }}</span>
                <strong>{{ formatLabel(playingRecording) }}</strong>
              </div>
              <div class="recording-fact">
                <span class="recording-fact__label">{{ t('recordingsUi.columnSampleRate') }}</span>
                <strong>{{ sampleRateLabel(playingRecording) }}</strong>
              </div>
              <div class="recording-fact">
                <span class="recording-fact__label">{{ t('recordingsUi.columnSize') }}</span>
                <strong>{{ formatBytes(playingRecording.fileSize) }}</strong>
              </div>
              <div class="recording-fact">
                <span class="recording-fact__label">{{ t('recordingsUi.columnDownloaded') }}</span>
                <strong>{{ isDownloaded(playingRecording) ? t('recordingsUi.downloaded') : t('recordingsUi.notDownloaded') }}</strong>
              </div>
            </section>

            <section class="recording-path">
              <span class="field-label">{{ t('recordingsUi.columnDevice') }}</span>
              <span>{{ devices.nameById(playingRecording.deviceId) }}</span>
              <span class="muted">·</span>
              <span>{{ channelLabel(playingRecording.channelId) }}</span>
              <span class="muted">·</span>
              <span>{{ recordingTypeLabel(playingRecording.recordingType) }}</span>
            </section>
          </div>
        </template>

        <div v-else class="recordings-preview__empty">
          <div class="recordings-preview__empty-icon" aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 24 24"><path d="M5 12h2m2-5v10m3-13v16m3-11v6m3-4v2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </div>
          <strong>{{ t('recordingsUi.playerTitle') }}</strong>
          <span class="muted">{{ loading ? t('alarmsUi.loading') : t('recordingsUi.empty') }}</span>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.recordings-page {
  gap: var(--space-3);
}

.recordings-filters {
  padding: 10px 12px;
}

.recordings-filter-grid {
  display: grid;
  grid-template-columns: minmax(150px, 1fr) minmax(150px, 1fr) minmax(150px, 0.9fr) minmax(190px, 1.1fr) minmax(190px, 1.1fr) auto;
  gap: 8px;
  align-items: end;
}

.recordings-filter-grid .field {
  min-width: 0;
  gap: 4px;
}

.recordings-filter-grid .field-label {
  font-size: 11px;
}

.recordings-filter-grid .select,
.recordings-filter-grid .input {
  width: 100%;
  min-width: 0;
  height: var(--control-height-sm);
}

.recordings-filter-actions {
  display: flex;
  align-items: flex-end;
}

.recordings-workspace {
  display: grid;
  grid-template-columns: minmax(420px, 0.9fr) minmax(500px, 1.1fr);
  gap: var(--space-3);
  align-items: start;
  min-height: 0;
}

.recordings-master,
.recordings-preview {
  min-width: 0;
  padding: 0;
  overflow: hidden;
}

.recordings-master__head,
.recordings-preview__head {
  min-height: 58px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.recordings-master__count,
.recordings-preview__sub {
  margin: 2px 0 0;
  font-size: 11.5px;
}

.recording-list {
  max-height: min(68vh, 760px);
  overflow-y: auto;
}

.recording-list__empty {
  padding: 42px 16px;
  text-align: center;
  color: var(--color-text-secondary);
  font-size: 12.5px;
}

.recording-row {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) 30px;
  gap: 9px;
  align-items: center;
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border);
  cursor: pointer;
  outline: none;
  transition: background 120ms ease;
}

.recording-row:hover,
.recording-row:focus-visible {
  background: var(--color-bg-hover);
}

.recording-row--active {
  background: var(--color-accent-soft);
}

.recording-row__icon {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--color-accent, #ff6a1a) 10%, transparent);
  color: var(--color-accent, #ff6a1a);
}

.recording-row__icon--video {
  background: var(--color-bg-subtle);
  color: var(--color-text-secondary);
}

.recording-row__body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.recording-row__top,
.recording-row__meta,
.recording-row__bottom {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.recording-row__top {
  justify-content: space-between;
  font-size: 12.5px;
}

.recording-row__duration,
.recording-row__meta,
.recording-row__bottom {
  color: var(--color-text-secondary);
  font-size: 11.5px;
}

.recording-row__duration {
  flex: none;
  font-variant-numeric: tabular-nums;
}

.recording-row__meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recording-row__bottom {
  flex-wrap: wrap;
}

.recording-local-state {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: auto;
}

.recording-local-state--local { color: var(--color-success); }
.recording-local-state--remote { color: var(--color-text-secondary); }

.recording-row__play {
  opacity: 0.7;
}

.recording-row:hover .recording-row__play,
.recording-row--active .recording-row__play {
  opacity: 1;
}

.recordings-master__pager {
  padding: 9px 12px;
  border-top: 1px solid var(--color-border);
}

.recordings-preview {
  position: sticky;
  top: var(--space-3);
  max-height: calc(100vh - 112px);
  display: flex;
  flex-direction: column;
}

.recordings-preview__actions {
  flex: none;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.recordings-preview__scroll {
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.video-preview-shell {
  border-radius: var(--radius-md);
  overflow: hidden;
  background: #000;
  min-height: 260px;
  display: grid;
  place-items: center;
}

.video-player {
  width: 100%;
  max-height: 54vh;
  display: block;
  background: #000;
}

.recording-facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 7px;
}

.recording-fact {
  min-width: 0;
  padding: 8px 9px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-subtle);
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.recording-fact__label {
  font-size: 10.5px;
  color: var(--color-text-secondary);
}

.recording-fact strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
}

.recording-path {
  border-top: 1px solid var(--color-border);
  padding-top: 10px;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 12px;
}

.recordings-preview__empty {
  min-height: 420px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--color-text-secondary);
  text-align: center;
}

.recordings-preview__empty-icon {
  width: 48px;
  height: 48px;
  border-radius: 14px;
  display: grid;
  place-items: center;
  background: var(--color-bg-subtle);
  margin-bottom: 4px;
}

.pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  font-size: 12px;
}

@media (max-width: 1280px) {
  .recordings-filter-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .recordings-workspace {
    grid-template-columns: minmax(360px, 0.82fr) minmax(460px, 1.18fr);
  }
}

@media (max-width: 980px) {
  .recordings-filter-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .recordings-workspace {
    grid-template-columns: 1fr;
  }

  .recordings-preview {
    position: static;
    max-height: none;
  }

  .recording-list {
    max-height: 520px;
  }
}

@media (max-width: 640px) {
  .recordings-filter-grid,
  .recording-facts {
    grid-template-columns: 1fr;
  }

  .recordings-preview__head {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
