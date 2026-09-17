<script setup lang="ts">
/**
 * 「下载检测记录」对话框（画面格右键菜单的 `download-detect` 项）。
 *
 * ---------------------------------------------------------------------------
 * 它做什么
 * ---------------------------------------------------------------------------
 * 列出设备自己产生的检测记录（`eventCenter.detectLogs(deviceId)`），让操作员挑一条，
 * 再挑它的一种结果文件（`Fa371ResultFileKind`，手册 §5.1.17 的八种），通过
 * `eventCenter.downloadDetectFile()` 下载（`GET /detect_file/...`）。
 *
 * 下载下来的文件**不是**一堆散落的东西：主进程会把它登记进 `recordings` 表
 * （`recordingType: 'manual'`），于是它立刻出现在「回放本机录像」里。所以下载成功
 * 且容器是 MP4 时，这里给一个「回放这段录像」的按钮，把这条闭环接实
 * （见 `emit('play')`）。
 *
 * ---------------------------------------------------------------------------
 * 三件必须说清楚的事（都是事实，不是解释）
 * ---------------------------------------------------------------------------
 *   1. **这个端点没有服务端分页**：手册没有给 `/detect_logs` 定义任何分页参数
 *      （§8.3 C14），真机返回的是一个整批数组。所以界面上不画一个假的分页器，
 *      而是把「本次一次性读完了全部记录」写出来（`downloadNoPaging`）。
 *   2. **进度是阶段而不是百分比**：传输层把响应体一次性读出来，中间层拿不到
 *      `Content-Length` 与已读字节数，所以这里只显示主进程推来的阶段
 *      （`eventCenter.downloadDetectFile` 的进度事件）。编一个假进度条比没有更糟。
 *   3. **下载是幂等的**：同一个文件第二次下载会带 `reused: true` 回来，界面照实
 *      说「本机已有这个文件」，而不是假装又下载了一遍。
 *
 * 权限：`downloadDetectFile` 需要管理员，**主进程**才是执行者。这里不复制那条
 * 判断去当权威，只是在显然不是管理员时先把话说在前面；真被拒绝时显示的是主进程
 * 的原话。
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { EventDetectDownloadInput, EventDetectDownloadResult, EventDownloadProgress } from '@shared/ipc/contract'
import type { EventDetectLogView } from '@shared/domain/event-center'
import type { Fa371ResultFileKind } from '@shared/domain/fa371'
import { detectFileKindLabel, eventDownloadStageLabel } from '@renderer/lib/labels'
import { formatBytes, formatDateTime } from '@renderer/lib/format'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import { useSessionStore } from '@renderer/stores/session'
import AppModal from '@renderer/components/AppModal.vue'

const props = defineProps<{
  modelValue: boolean
  deviceId: string
  deviceName: string
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  /** 下载成功且是视频：调用方接着打开「回放本机录像」并播这一段。 */
  (event: 'play', recordingId: string): void
}>()

const { t } = useI18n()
const session = useSessionStore()

const logs = ref<EventDetectLogView[]>([])
/** 设备自报的记录条数（**不是**分页信息，见文件头）。 */
const logsCount = ref<number | null>(null)
const loading = ref(false)
const error = ref('')
const notice = ref('')
/** 打开的那一条检测记录（-1 = 没有展开任何一条）。 */
const openIndex = ref(-1)
/** 逐文件的下载阶段，键与 `stores/eventCenter` 的 `eventDownloadKey` 同构。 */
const downloads = ref<Record<string, EventDownloadProgress>>({})
/** 最近一次下载的产物：`reused`、登记到的录像 id 都在里面。 */
const lastResult = ref<EventDetectDownloadResult | null>(null)

const isAdmin = computed(() => session.isAdmin)

/** 「本机已有这个文件」的说明只在真发生过时出现。 */
const lastResultText = computed(() => {
  const result = lastResult.value
  if (!result) return ''
  if (result.reused) return t('cameraNvrUi.downloadReused', { name: result.fileName })
  return t('eventsUi.downloadDone', { name: result.fileName, size: formatBytes(result.bytes) })
})

/** 刚下载的产物能不能接着回放：只有 MP4 才有 `<video>` 可放。 */
const canPlayLast = computed(
  () => lastResult.value !== null && lastResult.value.container === 'mp4' && lastResult.value.recordingId !== ''
)

/** 设备接口不分页：把本次到底读了什么写出来。 */
const noPagingText = computed(() =>
  t('cameraNvrUi.downloadNoPaging', { count: logsCount.value ?? logs.value.length })
)

function downloadKey(logId: number, kind: Fa371ResultFileKind): string {
  return `${props.deviceId}:${logId}:${kind}`
}

function stageOf(log: EventDetectLogView, kind: Fa371ResultFileKind): string {
  if (log.logId === undefined) return ''
  const progress = downloads.value[downloadKey(log.logId, kind)]
  return progress ? eventDownloadStageLabel(progress.stage) : ''
}

function isDownloading(log: EventDetectLogView, kind: Fa371ResultFileKind): boolean {
  if (log.logId === undefined) return false
  const progress = downloads.value[downloadKey(log.logId, kind)]
  return progress?.stage === 'starting' || progress?.stage === 'fetching' || progress?.stage === 'verifying' || progress?.stage === 'registering'
}

/** 一条记录的时间：接口没有声明单位，换算是近似的，所以照实标出来。 */
function logTime(log: EventDetectLogView): string {
  if (log.startTimeMs === undefined) return t('eventsUi.timeUnknown')
  return formatDateTime(log.startTimeMs)
}

async function load(): Promise<void> {
  const deviceId = props.deviceId
  if (deviceId === '') return
  loading.value = true
  error.value = ''
  notice.value = ''
  lastResult.value = null
  openIndex.value = -1
  downloads.value = {}
  const result = await callApi(() => window.api.eventCenter.detectLogs(deviceId))
  loading.value = false
  if (!result.success) {
    error.value = resultMessage(result)
    logs.value = []
    logsCount.value = null
    return
  }
  const page = unwrap(result)
  logs.value = page?.items ?? []
  logsCount.value = page?.logsCount ?? null
}

/** 展开 / 收起一条记录。 */
function toggleLog(index: number): void {
  openIndex.value = openIndex.value === index ? -1 : index
}

/**
 * 下载一个结果文件。
 *
 * 成功后**不猜**结果：`reused`、字节数、登记到的录像 id 全部来自主进程的返回。
 */
async function download(log: EventDetectLogView, kind: Fa371ResultFileKind): Promise<void> {
  const logId = log.logId
  if (logId === undefined || isDownloading(log, kind)) return
  const input: EventDetectDownloadInput = { deviceId: props.deviceId, logId, kind }
  if (log.startTimeRaw !== undefined) input.startTimeRaw = log.startTimeRaw

  error.value = ''
  notice.value = ''
  lastResult.value = null
  downloads.value = {
    ...downloads.value,
    [downloadKey(logId, kind)]: { deviceId: props.deviceId, logId, kind, stage: 'starting' }
  }
  const result = await callApi(() => window.api.eventCenter.downloadDetectFile(input))
  if (!result.success) {
    const message = resultMessage(result)
    error.value = message
    downloads.value = {
      ...downloads.value,
      [downloadKey(logId, kind)]: {
        deviceId: props.deviceId,
        logId,
        kind,
        stage: 'failed',
        error: message
      }
    }
    return
  }
  const payload = unwrap(result)
  if (payload) {
    lastResult.value = payload
    notice.value = lastResultText.value
    // 这一条现在在盘上了：把「已下载」这件事就地反映出来（重读是一次整批读，
    // 但只有下载成功之后才会发生）。
    await load()
    lastResult.value = payload
    notice.value = lastResultText.value
  }
}

/** 把刚下载的那一段交给「回放本机录像」。 */
function playLast(): void {
  const result = lastResult.value
  if (!result || !canPlayLast.value) return
  emit('play', result.recordingId)
}

// --- 进度订阅 ---------------------------------------------------------------

let unsubscribe: (() => void) | undefined

function subscribe(): void {
  if (unsubscribe !== undefined) return
  unsubscribe = window.events.onEventCenterDownloadProgress((progress: EventDownloadProgress) => {
    // 只认这一台设备的：本弹窗画的是它的记录。
    if (progress.deviceId !== props.deviceId) return
    downloads.value = {
      ...downloads.value,
      [`${progress.deviceId}:${progress.logId}:${progress.kind}`]: progress
    }
  })
}

function unsubscribeProgress(): void {
  unsubscribe?.()
  unsubscribe = undefined
}

// 订阅跟着弹窗的开关走，并且在卸载时一定退订：主进程的推送监听持有这里的闭包，
// 不退订就等于把这个组件（以及它的列表）留在窗口的余生里。
onUnmounted(unsubscribeProgress)

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      subscribe()
      void load()
      return
    }
    unsubscribeProgress()
    logs.value = []
    downloads.value = {}
    lastResult.value = null
    error.value = ''
    notice.value = ''
  }
)

function close(): void {
  unsubscribeProgress()
  emit('update:modelValue', false)
}
</script>

<template>
  <AppModal
    :model-value="modelValue"
    :title="t('cameraNvrUi.downloadTitle')"
    width="820px"
    @update:model-value="emit('update:modelValue', $event)"
    @close="unsubscribeProgress"
  >
    <p class="muted">{{ deviceName }}</p>
    <p class="muted download__note" role="note">{{ noPagingText }}</p>
    <p v-if="!isAdmin" class="alert alert--warning" role="note">
      {{ t('eventsUi.detailDownloadNeedAdmin') }}
    </p>

    <p v-if="loading" class="muted" role="status">{{ t('cameraNvrUi.downloadLoading') }}</p>
    <p v-else-if="error" class="alert alert--danger" role="alert">{{ error }}</p>
    <p v-else-if="logs.length === 0" class="muted" role="status">
      {{ t('cameraNvrUi.downloadEmpty') }}
    </p>

    <p v-if="notice" class="alert alert--success" role="status">
      {{ notice }}
      <button v-if="canPlayLast" type="button" class="btn btn--sm" @click="playLast">
        {{ t('cameraNvrUi.downloadPlay') }}
      </button>
    </p>

    <ul v-if="logs.length > 0" class="download__list">
      <li v-for="(log, index) in logs" :key="`${log.logId ?? 'x'}:${log.startTimeRaw ?? index}`" class="download__row">
        <button
          type="button"
          class="download__head"
          :aria-expanded="openIndex === index"
          @click="toggleLog(index)"
        >
          <span class="download__time">{{ logTime(log) }}</span>
          <span v-if="log.atApproximate" class="chip chip--tiny">
            {{ t('eventsUi.approximateBadge') }}
          </span>
          <span class="muted">{{ t('eventsUi.detailLogId') }} {{ log.logId ?? '—' }}</span>
          <span class="muted">
            {{ t('cameraNvrUi.downloadColumnMode') }} {{ log.detectMode ?? '—' }}
          </span>
          <span class="badge">{{ t('cameraNvrUi.downloadColumnFiles') }} {{ log.files.length }}</span>
        </button>

        <div v-if="openIndex === index" class="download__files">
          <p v-if="log.files.length === 0" class="muted" role="status">
            {{ t('eventsUi.detailFilesEmpty') }}
          </p>
          <div v-for="file in log.files" :key="file.kind" class="download__file">
            <span class="download__kind">{{ detectFileKindLabel(file.kind) }}</span>
            <span class="download__name mono" :title="file.fileName">{{ file.fileName }}</span>
            <span class="chip chip--tiny">{{ file.container }}</span>
            <span class="spacer"></span>
            <span v-if="file.downloadedRecordingId" class="badge badge--success">
              {{ t('eventsUi.detailFileDownloaded') }}
            </span>
            <span v-if="stageOf(log, file.kind)" class="muted download__stage">
              {{ stageOf(log, file.kind) }}
            </span>
            <button
              type="button"
              class="btn btn--sm"
              :disabled="isDownloading(log, file.kind)"
              @click="download(log, file.kind)"
            >
              {{
                isDownloading(log, file.kind)
                  ? t('eventsUi.detailFileDownloading')
                  : t('eventsUi.detailFileDownload')
              }}
            </button>
          </div>
        </div>
      </li>
    </ul>

    <template #footer>
      <button type="button" class="btn" @click="close">{{ t('common.close') }}</button>
    </template>
  </AppModal>
</template>

<style scoped>
.download__note {
  font-size: 11.5px;
  line-height: 1.5;
}

.download__list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 8px 0;
  padding: 0;
  list-style: none;
}

.download__row {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-subtle);
}

.download__head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  font: inherit;
  font-size: 12px;
  color: inherit;
  text-align: left;
  background: transparent;
  border: 0;
  cursor: pointer;
}

.download__time {
  font-weight: 600;
}

.download__files {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px;
  border-top: 1px solid var(--color-border);
}

.download__file {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.download__kind {
  font-size: 12px;
  font-weight: 600;
}

.download__name {
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 220px;
}

.download__stage {
  font-size: 11px;
}
</style>
