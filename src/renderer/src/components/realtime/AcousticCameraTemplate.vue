<script setup lang="ts">
/**
 * 声学相机模板（规格 §8/§10；PD 与 Leak 共用这个组件、由 `cameraMode` 选模板）。
 *
 * V1 的诚实边界（规格开头就要求区分"文档明确支持"与"平台设计"）：
 *   - 三栏 Shell、Tab 顺序、默认 Tab（PD=PRPD，Leak=Spectrum）、能力驱动的底部动作，
 *     这些是平台设计，完整实现；
 *   - PRPD / 局放概率 / 温度 / 泄漏速率这些**实时字段目前没有已确认的设备接口**
 *     （FA371 的五路 WebSocket 里没有它们，检测日志里的泄漏量是事件流）。
 *     因此这些位置显示明确的 NoData，不用编造数字填充。
 *
 * 声相机的实时 WebSocket 很重，因此 GIS **不自动开流**，而是按 Tab 提供"按需接收"：
 *   - Spectrum   -> `/fftData`（实测约 20 KB/s，1024 条设备原始计数谱线，频率轴未知）；
 *   - Waveform   -> `/pcmData`（实测约 190 KB/s，512 点降采样包络）；
 *   - Voiceprint -> `/voiceprintData`（实测约 450 KB/s，设备自己渲染的 JPEG）。
 * PRPD 不提供按需按钮：设备接口没有相位分辨数据。启停与主进程一样受
 * admin + controlCameras 守卫；切换 Tab / 换设备 / 离开页面都会停掉连接，
 * 不留后台 socket。底部「实时画面」仍指向实时监测页处理 RTSP，不在 GIS 放视频。
 */

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Fa371StreamKind } from '@shared/domain/fa371-stream'
import type {
  AcousticCameraViewMode,
  RealtimeFrame,
  RealtimeTabId
} from '@shared/domain/realtime-monitor'
import { realtimeTemplate } from '@shared/domain/realtime-monitor'
import { useFa371StreamStore } from '@renderer/stores/fa371Stream'
import { useSessionStore } from '@renderer/stores/session'
import { formatBytes, formatNumber } from '@renderer/lib/format'
import RealtimeLineChart from './RealtimeLineChart.vue'
import RealtimeMetric from './RealtimeMetric.vue'
import RealtimeProbabilityBars from './RealtimeProbabilityBars.vue'

const props = defineProps<{
  frame: RealtimeFrame
  activeTab: RealtimeTabId
  cameraMode: AcousticCameraViewMode
  deviceId: string
}>()

const emit = defineEmits<{
  (event: 'setTab', tab: RealtimeTabId): void
  (event: 'setCameraMode', mode: AcousticCameraViewMode): void
}>()

const { t } = useI18n()
const camera = useFa371StreamStore()
const session = useSessionStore()

const templateId = computed(() =>
  props.cameraMode === 'leak' ? 'acousticCameraLeak' : 'acousticCameraPD'
)
const tabs = computed(() => realtimeTemplate(templateId.value).tabs)
const pdProbabilities = computed<Record<string, number | string | null>>(() => {
  const analysis = props.frame.analysis
  return analysis?.type === 'pdProbability' ? analysis.values : {}
})

/**
 * 三个 Tab 对应的**已实测设备通道**（手册 §5.2）。
 *
 * PRPD 刻意不在这张表里：设备接口没有相位分辨数据，不能给它随便配一路，
 * 也不能用 Spectrum 冒充。`fftData` 是 1024 条谱线（设备原始计数、频率轴未知），
 * `pcmData` 是降采样包络，`voiceprintData` 是设备自己渲染的 JPEG。
 */
const KIND_BY_TAB: Partial<Record<RealtimeTabId, Fa371StreamKind>> = {
  spectrum: 'fftData',
  waveform: 'pcmData',
  voiceprint: 'voiceprintData'
}

/** 当前 Tab 对应的设备通道（PRPD 没有）。 */
const tabKind = computed(() => KIND_BY_TAB[props.activeTab])

/** 当前 Tab 那颗「接收」按钮的文案 key（错误后重试也用同一颗）。 */
const START_KEY_BY_TAB: Partial<Record<RealtimeTabId, string>> = {
  spectrum: 'cameraStreamUi.startSpectrum',
  waveform: 'cameraStreamUi.startWaveform',
  voiceprint: 'cameraStreamUi.startVoiceprint'
}
const startLabel = computed(() => {
  const key = START_KEY_BY_TAB[props.activeTab]
  return key ? t(key) : ''
})

/** 主进程的启动/停止都是 admin + controlCameras；渲染层只做同一判据的提示。 */
const canStart = computed(() => session.isAdmin)
const busy = ref(false)
/**
 * 「按需接收」的同意位。
 *
 * 第一次必须由操作员点一次按钮（GIS 不自动建设备连接）；点过之后，在 Tab 之间
 * 切换会自动把当前连接换成该 Tab 的那一路，并在离开有数据的 Tab / 页面时停掉。
 */
const optedIn = ref(false)

const fft = computed(() => camera.fft)
const pcm = computed(() => camera.pcm)
const voiceprint = computed(() => camera.voiceprint)

const voiceprintSrc = computed(() => {
  const base64 = voiceprint.value?.jpegBase64
  return base64 ? `data:image/jpeg;base64,${base64}` : ''
})

const spectrumPoints = computed(() => {
  const preview = fft.value
  if (!preview) return []
  const binHz = preview.binHz
  return preview.bins
    .map((value, index) => ({
      x: binHz !== undefined && binHz > 0 ? index * binHz : index,
      y: value
    }))
    .filter((point) => Number.isFinite(point.y))
})

const spectrumUnit = computed(() =>
  fft.value?.binHz !== undefined && fft.value.binHz > 0 ? 'Hz' : ''
)

const fftHint = computed(() => {
  const preview = fft.value
  if (!preview) return ''
  const binHz = preview.binHz
  return binHz !== undefined && binHz > 0
    ? t('cameraStreamUi.fftAxisFromDevice', {
        lines: preview.binCount,
        hz: formatNumber(binHz, 2)
      })
    : t('cameraStreamUi.fftAxisUnknown', { lines: preview.binCount })
})

const waveformPoints = computed(() =>
  (pcm.value?.waveform ?? [])
    .map((value, index) => ({ x: index, y: value }))
    .filter((point) => Number.isFinite(point.y))
)

const pcmHint = computed(() => {
  const preview = pcm.value
  if (!preview) return ''
  return t('cameraStreamUi.pcmMeta', {
    samples: preview.samples,
    ms: preview.frameMs,
    rate: formatNumber(preview.sampleRate / 1000, 1)
  })
})

const PHASE_KEYS: Record<ReturnType<typeof camera.channelPhase>, string> = {
  'not-started': 'cameraStreamUi.phaseNotStarted',
  'no-frames': 'cameraStreamUi.phaseNoFrames',
  live: 'cameraStreamUi.phaseLive',
  stale: 'cameraStreamUi.phaseStale',
  error: 'cameraStreamUi.phaseError'
}

function phaseLabel(kind: Fa371StreamKind): string {
  return t(PHASE_KEYS[camera.channelPhase(kind)])
}

/** 当前 Tab 那一路的状态行：相位 + 帧数 + 静默秒数。 */
function streamStatus(kind: Fa371StreamKind): string {
  const phase = camera.channelPhase(kind)
  const parts = [phaseLabel(kind)]
  if (phase === 'live') parts.push(t('cameraStreamUi.framesCount', { count: camera.frameCountOf(kind) }))
  const silent = camera.silentSeconds(kind)
  if (phase === 'stale' && silent !== undefined) {
    parts.push(t('cameraStreamUi.silentFor', { seconds: formatNumber(silent, 1) }))
  }
  return parts.join(' · ')
}

/** 空面板时按相位给一句实话；不把"没启动"写成"环境安静"。 */
function phaseHint(kind: Fa371StreamKind): string {
  switch (camera.channelPhase(kind)) {
    case 'no-frames':
      return t('cameraStreamUi.hintNoFrames')
    case 'stale': {
      const silent = camera.silentSeconds(kind)
      return silent === undefined
        ? t('cameraStreamUi.hintStale', { seconds: '—' })
        : t('cameraStreamUi.hintStale', { seconds: formatNumber(silent, 1) })
    }
    case 'error':
      return t('cameraStreamUi.hintError')
    case 'live':
      return t('cameraStreamUi.sessionRunning')
    default:
      return t('cameraStreamUi.onDemandHint')
  }
}

async function startReceiving(kind: Fa371StreamKind): Promise<void> {
  if (!canStart.value || busy.value) return
  busy.value = true
  optedIn.value = true
  try {
    // 红外温度没有独立 Tab：与操作员选的那一路一起接收（16 B/帧，代价极小）。
    await camera.start([kind, 'infraredData'])
  } finally {
    busy.value = false
  }
}

async function stopReceiving(): Promise<void> {
  if (busy.value) return
  busy.value = true
  optedIn.value = false
  try {
    await camera.stop()
  } finally {
    busy.value = false
  }
}

let clock: number | undefined

onMounted(async () => {
  // 上一台相机的会话如果还在（异常卸载等），先停掉再切换，避免两台共用一份缓冲。
  if (camera.deviceId !== '' && camera.deviceId !== props.deviceId && camera.isActive) {
    await camera.stop()
  }
  camera.selectDevice(props.deviceId)
  // 主进程可能还有上一次留下的会话：只读状态，不做自动启动。
  await camera.refreshState()
  optedIn.value = camera.isActive
  // 采纳一条已存在的会话时也要接上推送，否则画面会停在快照那一刻。
  if (camera.isActive) camera.subscribe()
  clock = window.setInterval(() => camera.touchClock(), 1_000)
})

onBeforeUnmount(() => {
  if (clock !== undefined) window.clearInterval(clock)
  // 两半都要收：preload 里的监听器与主进程里的 socket。
  void camera.stop()
  camera.unsubscribe()
})

watch(
  () => props.deviceId,
  async (id) => {
    if (!id) return
    if (camera.isActive) await camera.stop()
    optedIn.value = false
    camera.selectDevice(id)
    await camera.refreshState()
  }
)

/**
 * 换 Tab：只在操作员已经点过一次「接收」之后才自动跟随。
 * 切到没有对应数据通道的 Tab（PRPD）时先把连接停掉，不留后台 socket。
 */
watch(
  () => props.activeTab,
  async (tab) => {
    if (!optedIn.value || !canStart.value) return
    const kind = KIND_BY_TAB[tab]
    if (!kind) {
      if (camera.isActive) await stopReceiving()
      return
    }
    if (!camera.running.includes(kind)) await startReceiving(kind)
  }
)
</script>

<template>
  <div class="ac" data-realtime-template="acousticCamera">
    <section class="ac__col ac__col--left">
      <header class="ac__head">
        <h4>{{ t('realtimeUi.primary') }}</h4>
        <div class="ac__mode" role="group" :aria-label="t('realtimeUi.mode.label')">
          <button
            type="button"
            class="ac__mode-button"
            :class="{ 'ac__mode-button--active': cameraMode === 'pd' }"
            :aria-pressed="cameraMode === 'pd'"
            :title="t('realtimeUi.mode.pd')"
            data-camera-mode="pd"
            @click="emit('setCameraMode', 'pd')"
          >PD</button>
          <button
            type="button"
            class="ac__mode-button"
            :class="{ 'ac__mode-button--active': cameraMode === 'leak' }"
            :aria-pressed="cameraMode === 'leak'"
            :title="t('realtimeUi.mode.leak')"
            data-camera-mode="leak"
            @click="emit('setCameraMode', 'leak')"
          >LEAK</button>
        </div>
      </header>
      <div class="ac__metrics">
        <RealtimeMetric
          v-for="metric in frame.primaryMetrics"
          :key="metric.key"
          :metric="metric"
        />
      </div>
    </section>

    <section class="ac__col ac__col--center">
      <nav class="ac__tabs" role="tablist" :aria-label="t('realtimeUi.tabs.label')">
        <button
          v-for="tab in tabs"
          :key="tab"
          type="button"
          role="tab"
          class="ac__tab"
          :class="{ 'ac__tab--active': tab === activeTab }"
          :aria-selected="tab === activeTab"
          :data-realtime-tab="tab"
          @click="emit('setTab', tab)"
        >
          {{ t(`realtimeUi.tabs.${tab}`) }}
        </button>
      </nav>

      <div class="ac__canvas">
        <!-- PRPD empty state intentionally has no explanatory copy. -->
        <div v-if="activeTab === 'prpd'" class="ac__nodata" data-realtime-prpd-empty></div>

        <template v-else>
          <div class="ac__stream-bar">
            <span
              class="ac__stream-state"
              :data-camera-phase="tabKind ? camera.channelPhase(tabKind) : 'none'"
            >
              {{ tabKind ? streamStatus(tabKind) : '' }}
            </span>
            <button
              v-if="camera.isActive"
              type="button"
              class="btn btn--sm"
              data-camera-stream-stop
              :disabled="busy"
              @click="stopReceiving"
            >
              {{ t('cameraStreamUi.stop') }}
            </button>
          </div>

          <div
            v-if="camera.state === 'error'"
            class="ac__nodata ac__nodata--error"
            data-camera-stream-error
          >
            <p class="ac__nodata-text">{{ camera.error || t('cameraStreamUi.sessionError') }}</p>
            <button
              v-if="canStart && tabKind"
              type="button"
              class="btn btn--sm"
              data-camera-stream-retry
              :disabled="busy"
              @click="startReceiving(tabKind)"
            >
              {{ startLabel }}
            </button>
            <span v-else-if="!canStart" class="muted">{{ t('cameraStreamUi.adminOnlyHint') }}</span>
          </div>

          <template v-else-if="activeTab === 'spectrum'">
            <RealtimeLineChart
              v-if="spectrumPoints.length > 0"
              :points="spectrumPoints"
              x-kind="value"
              :x-unit="spectrumUnit"
              :value-precision="0"
              :empty-text="t('realtimeUi.spectrumWaiting')"
              :height="188"
            />
            <p v-if="fftHint" class="ac__hint">{{ fftHint }}</p>
            <div v-if="spectrumPoints.length === 0" class="ac__nodata">
              <p class="ac__nodata-text">{{ tabKind ? phaseHint(tabKind) : '' }}</p>
              <button
                v-if="canStart && tabKind && !camera.running.includes(tabKind)"
                type="button"
                class="btn btn--sm"
                data-camera-stream-start="spectrum"
                :disabled="busy"
                @click="startReceiving('fftData')"
              >
                {{ t('cameraStreamUi.startSpectrum') }}
              </button>
              <span v-else-if="!canStart" class="muted">
                {{ t('cameraStreamUi.adminOnlyHint') }}
              </span>
            </div>
          </template>

          <template v-else-if="activeTab === 'voiceprint'">
            <img
              v-if="voiceprintSrc"
              class="ac__voiceprint"
              :src="voiceprintSrc"
              :alt="t('cameraStreamUi.voiceprintAlt')"
            />
            <p v-if="voiceprint?.jpegBytes" class="ac__hint">
              {{ t('cameraStreamUi.voiceprintJpegMeta', { bytes: formatBytes(voiceprint.jpegBytes) }) }}
            </p>
            <div v-if="!voiceprintSrc" class="ac__nodata">
              <p class="ac__nodata-text">{{ tabKind ? phaseHint(tabKind) : '' }}</p>
              <button
                v-if="canStart && tabKind && !camera.running.includes(tabKind)"
                type="button"
                class="btn btn--sm"
                data-camera-stream-start="voiceprint"
                :disabled="busy"
                @click="startReceiving('voiceprintData')"
              >
                {{ t('cameraStreamUi.startVoiceprint') }}
              </button>
              <span v-else-if="!canStart" class="muted">
                {{ t('cameraStreamUi.adminOnlyHint') }}
              </span>
            </div>
          </template>

          <template v-else>
            <RealtimeLineChart
              v-if="waveformPoints.length > 0"
              :points="waveformPoints"
              x-kind="value"
              :value-precision="4"
              :empty-text="t('realtimeUi.waveformPending')"
              :height="188"
            />
            <p v-if="pcmHint" class="ac__hint">{{ pcmHint }}</p>
            <div v-if="waveformPoints.length === 0" class="ac__nodata">
              <p class="ac__nodata-text">{{ tabKind ? phaseHint(tabKind) : '' }}</p>
              <button
                v-if="canStart && tabKind && !camera.running.includes(tabKind)"
                type="button"
                class="btn btn--sm"
                data-camera-stream-start="waveform"
                :disabled="busy"
                @click="startReceiving('pcmData')"
              >
                {{ t('cameraStreamUi.startWaveform') }}
              </button>
              <span v-else-if="!canStart" class="muted">
                {{ t('cameraStreamUi.adminOnlyHint') }}
              </span>
            </div>
          </template>
        </template>
      </div>
    </section>

    <section class="ac__col ac__col--right">
      <header class="ac__head">
        <h4>{{ t('realtimeUi.detail') }}</h4>
      </header>
      <div class="ac__analysis">
        <p class="ac__section-label">
          {{ cameraMode === 'leak' ? t('realtimeUi.leakAnalysis') : t('realtimeUi.pdProbability') }}
        </p>
        <RealtimeProbabilityBars
          v-if="cameraMode !== 'leak'"
          :values="pdProbabilities"
          label-key-prefix="realtimeUi.pdClass"
          :order="['corona', 'creepage', 'suspended', 'noise']"
          :empty-text="t('realtimeUi.pdProbabilityEmpty')"
        />
        <p v-else class="ac__analysis-empty">{{ t('realtimeUi.leakAnalysisEmpty') }}</p>
      </div>
      <div class="ac__details">
        <RealtimeMetric
          v-for="metric in frame.details ?? []"
          :key="metric.key"
          :metric="metric"
          variant="detail"
        />
      </div>
    </section>
  </div>
</template>

<style scoped>
.ac {
  display: grid;
  grid-template-columns: 260px minmax(320px, 1fr) 300px;
  gap: var(--space-4);
  align-items: stretch;
  min-height: 240px;
}

.ac__col {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.ac__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
  min-height: 24px;
}

.ac__head h4 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.ac__mode {
  display: inline-flex;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.ac__mode-button {
  padding: 2px 8px;
  border: 0;
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.ac__mode-button--active {
  background: var(--color-accent-light);
  color: var(--color-accent-strong);
  font-weight: 600;
}

.ac__metrics {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.ac__tabs {
  display: flex;
  gap: var(--space-2);
  border-bottom: 1px solid var(--color-border);
}

.ac__tab {
  padding: 4px 2px 6px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}

.ac__tab--active {
  color: var(--color-accent-strong);
  border-bottom-color: var(--color-accent);
  font-weight: 600;
}

.ac__canvas {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* 当前 Tab 那一路的相位 + 停止入口：接收中的连接不许是"看不见的"。 */
.ac__stream-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-height: 24px;
}

.ac__stream-state {
  font-size: 11.5px;
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
}

.ac__voiceprint {
  display: block;
  width: 100%;
  max-height: 188px;
  object-fit: contain;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-subtle);
}

.ac__hint {
  margin: 0;
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.ac__nodata {
  margin: 0;
  min-height: 188px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-4);
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  color: var(--color-text-tertiary);
  text-align: center;
}

.ac__nodata--error {
  border-color: var(--color-danger-border);
  color: var(--color-danger);
}

.ac__nodata-text {
  margin: 0;
  max-width: 420px;
}

.ac__analysis {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.ac__section-label {
  margin: 0;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-text-tertiary);
}

.ac__analysis-empty {
  margin: 0;
  font-size: 12px;
  color: var(--color-text-tertiary);
}

.ac__details {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

@media (max-width: 1100px) {
  .ac {
    grid-template-columns: 240px minmax(0, 1fr);
  }

  .ac__col--right {
    grid-column: 1 / -1;
  }
}
</style>