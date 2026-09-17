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
import AppModal from '@renderer/components/AppModal.vue'
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

/** Recording currently loaded in the player panel; '' keeps the modal closed. */
const playingId = ref('')
const playerOpen = ref(false)

/** 视频录像用自己的弹窗：`<video>` 直接吃回环 HTTP 地址。 */
const videoOpen = ref(false)
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
    return
  }
  error.value = ''
  const page: RecordingPage | undefined = unwrap(result)
  items.value = page?.items ?? []
  total.value = page?.total ?? 0
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
  if (!isVideoRecording(recording)) {
    playingId.value = recording.id
    playerOpen.value = true
    return
  }
  videoTitle.value = formatDateTime(recording.startTime)
  videoUrl.value = ''
  videoError.value = ''
  videoOpen.value = true
  const result = await callApi(() => window.api.cameraNvr.videoUrl(recording.id))
  if (!result.success) {
    videoError.value = resultMessage(result)
    return
  }
  videoUrl.value = unwrap(result)?.url ?? ''
  if (videoUrl.value === '') videoError.value = t('recordingsUi.videoUnavailable')
}

function closeVideo(): void {
  videoOpen.value = false
  // 先卸载 <video>（它会释放回环连接），再清地址。
  videoUrl.value = ''
  videoError.value = ''
}

function closePlayer(): void {
  playerOpen.value = false
  // Clear the id only after the modal is gone so the player unmounts (and
  // revokes its object URL) instead of flickering through an empty state.
  playingId.value = ''
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
  <div class="page">
    <!--
      这一页**没有页头**（业主 2026-09-16）：
        - 「共 N 个录音文件」删掉 —— 列表本身就是那个数字；
        - 「同步设备录音」与「刷新」两个按钮删掉 —— 刷新在顶栏已经有了（只有一个刷新入口），
          而这一页要变成**存储**页（按日期查看与回放），不是一个"导入录音"的工作台。
      ⚠️ 注意：「同步设备录音」原本是**设备录音库**唯一的界面入口。删掉之后这个能力在界面上
      没有落点了（主进程那条 `recording:sync-device` 通道仍在）。这一条要在存储页成型时
      一并决定它去哪 —— 见 docs/Ivms4200-UX-REFERENCE.md §15.21。
    -->

    <p v-if="error" class="alert alert--danger" role="alert">{{ error }}</p>
    <p v-else-if="notice" class="alert alert--success" role="status">{{ notice }}</p>

    <section class="card">
      <div class="filter-bar">
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
              <!-- 未启用的通道照样可以查历史（录音已经存在），但要看得出来它现在没开。 -->
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

        <button type="button" class="btn" @click="reset">{{ t('common.reset') }}</button>
      </div>
    </section>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('recordingsUi.columnStart') }}</th>
            <th>{{ t('recordingsUi.columnDevice') }}</th>
            <th>{{ t('recordingsUi.columnChannel') }}</th>
            <th>{{ t('recordingsUi.columnType') }}</th>
            <th>{{ t('recordingsUi.columnDuration') }}</th>
            <th>{{ t('recordingsUi.columnSampleRate') }}</th>
            <th>{{ t('recordingsUi.columnFormat') }}</th>
            <th>{{ t('recordingsUi.columnSize') }}</th>
            <th>{{ t('recordingsUi.columnDownloaded') }}</th>
            <th class="col-play">{{ t('recordingsUi.columnPlay') }}</th>
            <th>{{ t('recordingsUi.columnSample') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="items.length === 0">
            <td colspan="11" class="table-empty">
              {{ loading ? t('alarmsUi.loading') : t('recordingsUi.empty') }}
            </td>
          </tr>
          <tr v-for="recording in items" :key="recording.id">
            <td class="nowrap">{{ formatDateTime(recording.startTime) }}</td>
            <td class="nowrap">{{ devices.nameById(recording.deviceId) }}</td>
            <td class="nowrap">{{ channelLabel(recording.channelId) }}</td>
            <td class="nowrap">{{ recordingTypeLabel(recording.recordingType) }}</td>
            <td class="nowrap">{{ formatDuration(recording.durationMs) }}</td>
            <td class="nowrap">{{ sampleRateLabel(recording) }}</td>
            <td class="nowrap">{{ formatLabel(recording) }}</td>
            <td class="nowrap">{{ formatBytes(recording.fileSize) }}</td>
            <td class="nowrap">
              <span
                class="badge"
                :class="isDownloaded(recording) ? 'badge--success' : 'badge--warning'"
                :title="recording.relativePath || undefined"
              >
                {{ isDownloaded(recording) ? t('recordingsUi.downloaded') : t('recordingsUi.notDownloaded') }}
              </span>
            </td>
            <td>
              <!-- `playback.load` downloads on demand, so this stays enabled for
                   rows that are not local yet: the first play is the download. -->
              <button
                type="button"
                class="btn btn--sm btn--icon"
                :aria-label="t('recordingsUi.playLabel', { time: formatDateTime(recording.startTime) })"
                :title="isDownloaded(recording) ? t('recordingsUi.playLocal') : t('recordingsUi.playRemote')"
                @click="openPlayer(recording)"
              >
                <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4 3l9 5-9 5z" fill="currentColor" />
                </svg>
              </button>
            </td>
            <td class="nowrap">
              <button
                type="button"
                class="btn btn--sm"
                :disabled="sampleBusyId === recording.id"
                :title="t('recordingsUi.sampleHint')"
                @click="addToSamples(recording)"
              >
                {{ t('recordingsUi.addToSamples') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="pager">
      <span class="muted">
        {{
          t('alarmsUi.pagerRange', {
            from: offset + 1,
            to: offset + items.length,
            total
          })
        }}
      </span>
      <div class="btn-row">
        <button
          type="button"
          class="btn btn--sm"
          :disabled="!canPrev"
          @click="goToPage(offset - RECORDING_PAGE_SIZE)"
        >
          {{ t('alarmsUi.prevPage') }}
        </button>
        <button
          type="button"
          class="btn btn--sm"
          :disabled="!canNext"
          @click="goToPage(offset + RECORDING_PAGE_SIZE)"
        >
          {{ t('alarmsUi.nextPage') }}
        </button>
      </div>
    </div>

    <!--
      The player is mounted inside the modal and therefore unmounts when the
      modal closes, which is what revokes its object URL and frees the several MB
      of audio it holds. `auto-load` starts playback as soon as it mounts.
    -->
    <AppModal v-model="playerOpen" :title="playerTitle" width="560px" @close="closePlayer">
      <RecordingPlayer v-if="playingId" :recording-id="playingId" auto-load />
    </AppModal>

    <!--
      * 视频录像（手动录像的 MP4）走自己的弹窗：主进程给一个本机回环地址，
      * `<video>` 直接拉字节流（支持 Range 拖动）。拿不到地址时**明说**不能播放，
      * 而不是给一个永远空着的播放器 —— 这是「0 Hz / WAV 的视频行」那条缺陷的收尾。
    -->
    <AppModal v-model="videoOpen" :title="t('recordingsUi.videoPlayerTitle')" width="760px" @close="closeVideo">
      <p class="muted">{{ videoTitle }}</p>
      <video v-if="videoUrl" class="video-player" :src="videoUrl" controls autoplay></video>
      <p v-else-if="videoError" class="alert alert--danger" role="alert">{{ videoError }}</p>
      <p v-else class="muted" role="status">{{ t('recordingsUi.videoLoading') }}</p>
    </AppModal>
  </div>
</template>

<style scoped>
.video-player {
  width: 100%;
  max-height: 60vh;
  background: #000;
  border-radius: var(--radius-md);
}
.col-play {
  width: 62px;
  text-align: center;
}

.pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  font-size: 12px;
}

.player-note {
  margin-top: var(--space-3);
  font-size: 11.5px;
}
</style>
