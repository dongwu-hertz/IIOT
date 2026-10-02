<script setup lang="ts">
/**
 * 「回放本机录像」对话框（画面格右键菜单的 `playback` 项）。
 *
 * ---------------------------------------------------------------------------
 * 为什么叫「本机录像」而不是「设备录像」
 * ---------------------------------------------------------------------------
 * FA371 **没有**设备侧的连续录像存储：本应用的主进程明确不把 RTSP 码流写盘
 * （见 `services/media/rtsp-stream.ts`），所以设备上根本没有可以回看的录像计划。
 * 能回放的只有**这台电脑**上的文件，它们有两个来源：
 *   1. 操作员在画面格上手动录下的片段（`cameraNvr.startRecording/stopRecording`）；
 *   2. 从设备下载下来的检测结果录像（`eventCenter.downloadDetectFile`，它会把这些
 *      文件登记进**同一张** `recordings` 表）。
 * 把这一项写成「回放设备录像」就是一句假话，所以文案与这里的行为都只说本机。
 *
 * ---------------------------------------------------------------------------
 * 两条硬规则
 * ---------------------------------------------------------------------------
 * 1. **只列视频行**。本对话框用 `<video>` 播放，而 `recordings` 表里同时住着音频
 *    录像（WAV/FLAC）。把一行音频交给 `<video>` 会得到一个「无法播放」，所以这里
 *    按扩展名过滤到 MP4 —— 这是 `RecordingsView` 已经踩过的那个坑。
 * 2. **空 src 不变式**。`<video>` 只在拿到回环地址时存在；关掉/换一段之前先把元素
 *    的 `src` 摘掉并 `load()`（元素手上是一条回环 HTTP 请求），再丢掉地址。
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Recording } from '@shared/domain/models'
import { recordingTypeLabel } from '@renderer/lib/labels'
import { formatBytes, formatDateTime, formatDuration } from '@renderer/lib/format'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import AppModal from '@renderer/components/AppModal.vue'
import VideoPlaybackTimeline from '@renderer/components/VideoPlaybackTimeline.vue'
import { nextSegmentStep, recordingSegments } from '@renderer/lib/recordingTimeline'

const props = defineProps<{
  modelValue: boolean
  deviceId: string
  deviceName: string
  /**
   * 打开时直接播这一段（由「下载检测记录」弹窗传进来）。
   *
   * 下载下来的文件会被登记进同一张录像表，所以这里不是一句客套话：它就是
   * 「下载 -> 回放」这条闭环的接线。
   */
  presetRecordingId?: string
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
}>()

const { t } = useI18n()

/** 一次读回的行数。列表只用于**挑一段**，不做分页界面。 */
const RECORDING_LIMIT = 200

/** 只有超过这个正缺口的才停下来提示；小于它的正/负间隙按切片边界抖动处理，直接续播。 */
const AUTO_ADVANCE_GAP_TOLERANCE_MS = 5_000

const items = ref<Recording[]>([])
const loading = ref(false)
const error = ref('')

/** 正在播放的那一段的 id；空串 = 没有播放器（空 src 不变式）。 */
const playingId = ref('')
const videoUrl = ref('')
const videoError = ref('')
const videoTitle = ref('')
const videoEl = ref<HTMLVideoElement | null>(null)

/** 当前播放时刻（epoch ms），喂给时间轴游标；停止时为 null。 */
const videoCurrentMs = ref<number | null>(null)

/** 播完后的去路：正常接下一段、遇到大缺口等用户确认、或已经到末尾。 */
type PlaybackFollowUp =
  | { kind: 'gap'; nextId: string; nextStart: number; gapMs: number }
  | { kind: 'end' }
const followUp = ref<PlaybackFollowUp | null>(null)

/** 已经登记的行里，属于「本机视频」的那些。 */
const videoItems = computed(() => items.value.filter(isVideoRecording))

/** 时间轴只画有本机地址的视频片段；音频行不参与相机回放。 */
const timelineSegments = computed(() => recordingSegments(videoItems.value))

/**
 * 一行的扩展名决定它能不能进 `<video>`。
 *
 * 手动录像与设备下载的检测录像落盘都是 MP4；音频录像才是 WAV/FLAC —— 后者交给
 * `<video>` 只会得到一句「无法播放」。所以这里过滤，而不是把音频行也画出来。
 */
function isVideoRecording(recording: Recording): boolean {
  return /\.mp4$/i.test(recording.relativePath)
}

/** 释放 `<video>`：它拿着一条回环请求，丢状态之前必须先把它放掉。 */
function releaseVideo(): void {
  const video = videoEl.value
  if (!video) return
  video.pause()
  video.removeAttribute('src')
  video.load()
}

function stopPlayback(): void {
  releaseVideo()
  playingId.value = ''
  videoUrl.value = ''
  videoError.value = ''
  videoTitle.value = ''
  videoCurrentMs.value = null
  followUp.value = null
}

async function load(): Promise<void> {
  const deviceId = props.deviceId
  if (deviceId === '') return
  loading.value = true
  error.value = ''
  const result = await callApi(() =>
    window.api.recordings.query({ deviceId, limit: RECORDING_LIMIT, offset: 0 })
  )
  loading.value = false
  if (!result.success) {
    error.value = resultMessage(result)
    items.value = []
    return
  }
  items.value = unwrap(result)?.items ?? []
}

/**
 * 播放某一段。
 *
 * 地址由主进程给（回环 HTTP，支持 Range 拖动），拿不到就**明说**无法播放，
 * 而不是打开一个永远空着的播放器。
 */
async function play(recording: Recording): Promise<void> {
  stopPlayback()
  playingId.value = recording.id
  videoTitle.value = formatDateTime(recording.startTime)
  videoCurrentMs.value = recording.startTime
  const result = await callApi(() => window.api.cameraNvr.videoUrl(recording.id))
  // 期间被关掉或换了另一段：这一份结果已经过期，丢掉它（否则会把地址写回去）。
  if (playingId.value !== recording.id) return
  if (!result.success) {
    videoError.value = resultMessage(result)
    return
  }
  videoUrl.value = unwrap(result)?.url ?? ''
  if (videoUrl.value === '') videoError.value = t('cameraNvrUi.playbackUnavailable')
}

/** 按 id 播放列表里的某一段（时间轴点击与「跳到下一段」共用）。 */
function playById(id: string): void {
  const target = videoItems.value.find((recording) => recording.id === id)
  if (target) void play(target)
}

/** 把 `<video>.currentTime` 换算回录像的 epoch 时刻，喂给时间轴游标。 */
function onVideoTimeUpdate(): void {
  const video = videoEl.value
  const recording = videoItems.value.find((item) => item.id === playingId.value)
  if (!video || !recording) return
  videoCurrentMs.value = recording.startTime + video.currentTime * 1000
}

/**
 * 一段播完：只有小缝/重叠才自动接下一段；真缺口停下来显示在时间轴上，
 * 由操作员点「跳到下一段」决定是否跨过。
 */
function onVideoEnded(): void {
  const current = playingId.value
  if (current === '') return
  const step = nextSegmentStep(timelineSegments.value, current)
  if (!step?.next) {
    followUp.value = { kind: 'end' }
    return
  }
  if (step.gapMs > AUTO_ADVANCE_GAP_TOLERANCE_MS) {
    followUp.value = {
      kind: 'gap',
      nextId: step.next.id,
      nextStart: step.next.startMs,
      gapMs: step.gapMs
    }
    return
  }
  playById(step.next.id)
}

/** 用户确认跨过缺口：播下一段（缺口本身已经由时间轴如实画出来）。 */
function continueAfterGap(): void {
  const pending = followUp.value
  if (pending?.kind === 'gap') playById(pending.nextId)
}

/** 打开时读一次列表；若带着 preset 就直接播那一段（下载 -> 回放）。 */
async function openForDevice(): Promise<void> {
  stopPlayback()
  await load()
  const preset = props.presetRecordingId ?? ''
  if (preset === '') return
  const target = videoItems.value.find((recording) => recording.id === preset)
  // preset 找不到时不做任何猜测：列表已经画出来，操作员自己挑。
  if (target) await play(target)
}

function close(): void {
  stopPlayback()
  emit('update:modelValue', false)
}

watch(
  () => props.modelValue,
  (open) => {
    // 关闭时（父组件直接改 v-model 也算）先释放元素，再让弹窗卸载。
    if (!open) {
      stopPlayback()
      return
    }
    void openForDevice()
  }
)

// 整个组件被卸载（例如画面格那一页导航走了）时同样要放掉回环请求：
// Vue 只是把 `<video>` 从 DOM 上摘下来，而那条请求是元素自己放掉的。
onUnmounted(stopPlayback)
</script>

<template>
  <AppModal
    :model-value="modelValue"
    :title="t('cameraNvrUi.playbackTitle')"
    width="720px"
    @update:model-value="emit('update:modelValue', $event)"
    @close="stopPlayback"
  >
    <!--
      这一行是必须的诚实说明，不是装饰：「本机录像」四个字必须被说清楚，否则
      操作员会以为自己在看设备上的连续录像。
    -->
    <p class="muted playback__note" role="note">{{ t('cameraNvrUi.playbackLocalNote') }}</p>
    <p class="muted">{{ deviceName }}</p>

    <VideoPlaybackTimeline
      v-if="timelineSegments.length > 0"
      :segments="timelineSegments"
      :current-id="playingId || undefined"
      :cursor-ms="videoCurrentMs"
      :label="t('cameraNvrUi.playbackTimeline')"
      :zoom-in-label="t('monitorTimelineUi.playbackZoomIn')"
      :zoom-out-label="t('monitorTimelineUi.playbackZoomOut')"
      @select="playById"
    />

    <p v-if="loading" class="muted" role="status">{{ t('cameraNvrUi.playbackLoading') }}</p>
    <p v-else-if="error" class="alert alert--danger" role="alert">{{ error }}</p>
    <p v-else-if="videoItems.length === 0" class="muted" role="status">
      {{ t('cameraNvrUi.playbackEmpty') }}
    </p>

    <table v-if="videoItems.length > 0" class="table playback__table">
      <thead>
        <tr>
          <th>{{ t('recordingsUi.columnStart') }}</th>
          <th>{{ t('recordingsUi.columnType') }}</th>
          <th>{{ t('recordingsUi.columnDuration') }}</th>
          <th>{{ t('recordingsUi.columnSize') }}</th>
          <th class="playback__col-play">{{ t('recordingsUi.columnPlay') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="recording in videoItems" :key="recording.id">
          <td class="nowrap">{{ formatDateTime(recording.startTime) }}</td>
          <td class="nowrap">{{ recordingTypeLabel(recording.recordingType) }}</td>
          <td class="nowrap">{{ formatDuration(recording.durationMs) }}</td>
          <td class="nowrap">{{ formatBytes(recording.fileSize) }}</td>
          <td>
            <button
              type="button"
              class="btn btn--sm btn--icon"
              :aria-label="t('recordingsUi.playLabel', { time: formatDateTime(recording.startTime) })"
              :title="t('recordingsUi.playLocal')"
              @click="play(recording)"
            >
              <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 3l9 5-9 5z" fill="currentColor" />
              </svg>
            </button>
          </td>
        </tr>
      </tbody>
    </table>

    <!--
      播放器。`v-if="videoUrl"` 是空 src 不变式：地址为空时这里画的是说明文字，
      而不是一个永远空着的黑框。
    -->
    <div v-if="playingId" class="playback__player">
      <p class="muted">{{ videoTitle }}</p>
      <video
        v-if="videoUrl"
        ref="videoEl"
        class="playback__video"
        :src="videoUrl"
        controls
        @ended="onVideoEnded"
        @timeupdate="onVideoTimeUpdate"
        autoplay
      ></video>
      <p v-else-if="videoError" class="alert alert--danger" role="alert">{{ videoError }}</p>
      <p v-else class="muted" role="status">{{ t('recordingsUi.videoLoading') }}</p>
      <div
        v-if="followUp?.kind === 'gap'"
        class="alert alert--warning playback__gap"
        role="status"
      >
        <p>
          {{ t('cameraNvrUi.playbackGap', {
            time: formatDateTime(followUp.nextStart),
            gap: formatDuration(followUp.gapMs)
          }) }}
        </p>
        <button type="button" class="btn btn--sm" @click="continueAfterGap">
          {{ t('cameraNvrUi.playbackContinueNext') }}
        </button>
      </div>
      <p v-else-if="followUp?.kind === 'end'" class="muted playback__gap">
        {{ t('cameraNvrUi.playbackLastSegment') }}
      </p>
    </div>

    <template #footer>
      <button type="button" class="btn" @click="close">{{ t('common.close') }}</button>
    </template>
  </AppModal>
</template>

<style scoped>
.playback__gap {
  margin-top: 8px;
}

.playback__gap p {
  margin: 0 0 6px;
}
.playback__note {
  font-size: 11.5px;
  line-height: 1.5;
}

.playback__table {
  width: 100%;
  margin: 8px 0;
  font-size: 12px;
  border-collapse: collapse;
}

.playback__table th,
.playback__table td {
  padding: 6px 8px;
  text-align: left;
  border-bottom: 1px solid var(--color-border);
}

.playback__col-play {
  width: 62px;
  text-align: center;
}

.playback__player {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}

.playback__video {
  width: 100%;
  max-height: 46vh;
  background: #000;
  border-radius: var(--radius-md);
}
</style>
