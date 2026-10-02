<script setup lang="ts">
/**
 * 连续录像开关 + 状态行（S1 界面）。
 *
 * 事实来源：
 *   - `window.api.recorder.status()` 是**录像器自己的话**（starting / recording /
 *     waiting / backoff），这里原样显示，绝不把 waiting/backoff 合成一句「已开启」；
 *   - `settings.recorder.enabledDeviceIds` 是**用户的意图**。两者都要看：设置里
 *     说要录、但进程没起来时，状态行必须说「已要求录像，但录像进程未运行」，
 *     而不是说「未开启」替用户把意图抹掉。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RecorderStatusView } from '@shared/ipc/contract'
import { useSettingsStore } from '@renderer/stores/settings'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'

const props = defineProps<{ deviceId: string }>()
const { t } = useI18n()
const settings = useSettingsStore()

const status = ref<RecorderStatusView | null>(null)
const busy = ref(false)
const actionError = ref('')
const loadError = ref('')
let pollTimer: number | null = null

const requested = computed(
  () => settings.settings?.recorder.enabledDeviceIds.includes(props.deviceId) ?? false
)
const enabled = computed(() => status.value?.enabled ?? requested.value)
const segmentSeconds = computed(
  () => status.value?.segmentSeconds ?? settings.settings?.recorder.segmentSeconds ?? 300
)

type UiState = RecorderStatusView['state'] | 'not-running' | 'off'
const uiState = computed<UiState>(() => {
  if (status.value) return status.value.state
  return requested.value ? 'not-running' : 'off'
})

const statusText = computed(() => {
  switch (uiState.value) {
    case 'starting':
      return t('recorderUi.statusStarting')
    case 'recording':
      return t('recorderUi.statusRecording')
    case 'waiting':
      return t('recorderUi.statusWaiting')
    case 'backoff':
      return t('recorderUi.statusBackoff', { attempt: status.value?.attempt ?? 1 })
    case 'not-running':
      return t('recorderUi.notRunning')
    case 'stopped':
      return requested.value ? t('recorderUi.notRunning') : t('recorderUi.statusOff')
    default:
      return t('recorderUi.statusOff')
  }
})

const statusTone = computed(() => {
  switch (uiState.value) {
    case 'recording':
      return 'ok'
    case 'starting':
    case 'waiting':
    case 'backoff':
      return 'warn'
    case 'not-running':
      return 'danger'
    default:
      return 'idle'
  }
})
const statusClass = computed(() => `camera-recorder-bar__status--${statusTone.value}`)
const lastError = computed(() => status.value?.lastError ?? '')
const toggleLabel = computed(() =>
  busy.value
    ? t('recorderUi.working')
    : enabled.value
      ? t('recorderUi.disable')
      : t('recorderUi.enable')
)

async function loadStatus(): Promise<void> {
  if (props.deviceId === '') return
  const result = await callApi(() => window.api.recorder.status())
  if (!result.success) {
    loadError.value = resultMessage(result)
    return
  }
  loadError.value = ''
  const list = unwrap(result) ?? []
  status.value = list.find((entry) => entry.deviceId === props.deviceId) ?? null
}

async function toggle(): Promise<void> {
  if (busy.value || props.deviceId === '') return
  busy.value = true
  actionError.value = ''
  const result = await callApi(() =>
    window.api.recorder.setEnabled({ deviceId: props.deviceId, enabled: !enabled.value })
  )
  if (!result.success) {
    actionError.value = resultMessage(result)
    busy.value = false
    return
  }
  status.value = unwrap(result) ?? null
  // The main process has already persisted the new intent; re-read it so the
  // toggle and status line reflect the authoritative settings object.
  await settings.load()
  busy.value = false
}

onMounted(async () => {
  if (!settings.loaded) await settings.load()
  await loadStatus()
  pollTimer = window.setInterval(() => {
    void loadStatus()
  }, 3000)
})

onUnmounted(() => {
  if (pollTimer !== null) window.clearInterval(pollTimer)
  pollTimer = null
})

watch(
  () => props.deviceId,
  () => {
    status.value = null
    actionError.value = ''
    loadError.value = ''
    void loadStatus()
  }
)
</script>

<template>
  <div class="camera-recorder-bar" data-camera-recorder>
    <span class="camera-recorder-bar__title">{{ t('recorderUi.title') }}</span>
    <button
      type="button"
      class="camera-recorder-bar__toggle"
      :class="{ 'camera-recorder-bar__toggle--on': enabled }"
      :disabled="busy || deviceId === ''"
      :aria-pressed="enabled"
      :title="t('recorderUi.hint')"
      data-action="recorder-toggle"
      @click="toggle"
    >
      {{ toggleLabel }}
    </button>

    <span
      class="camera-recorder-bar__status"
      :class="statusClass"
      :data-recorder-state="uiState"
      data-recorder-status
      role="status"
      aria-live="polite"
    >
      <span class="camera-recorder-bar__dot" aria-hidden="true"></span>
      {{ statusText }}
    </span>

    <span v-if="status && status.registeredCount > 0" class="camera-recorder-bar__meta">
      {{ t('recorderUi.registered', { count: status.registeredCount }) }}
    </span>
    <span class="camera-recorder-bar__meta">
      {{ t('recorderUi.segmentLength', { seconds: segmentSeconds }) }}
    </span>

    <span v-if="lastError" class="camera-recorder-bar__error">
      {{ t('recorderUi.lastError', { reason: lastError }) }}
    </span>
    <span v-if="actionError" class="camera-recorder-bar__error" role="alert">{{ actionError }}</span>
    <span v-else-if="loadError" class="camera-recorder-bar__error" role="alert">{{ loadError }}</span>
  </div>
</template>

<style scoped>
.camera-recorder-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 10px;
  padding: 8px 10px 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.12);
  color: rgba(255, 255, 255, 0.82);
  font-size: 12px;
  line-height: 18px;
}

.camera-recorder-bar__title {
  font-weight: 600;
}

.camera-recorder-bar__toggle {
  height: 26px;
  padding: 0 10px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
}

.camera-recorder-bar__toggle:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.14);
}

.camera-recorder-bar__toggle--on {
  border-color: rgba(255, 106, 26, 0.7);
  background: rgba(255, 106, 26, 0.2);
  color: #ffd9bf;
}

.camera-recorder-bar__toggle:disabled {
  opacity: 0.55;
  cursor: default;
}

.camera-recorder-bar__status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: rgba(255, 255, 255, 0.9);
}

.camera-recorder-bar__dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: #68717e;
}

.camera-recorder-bar__status--ok .camera-recorder-bar__dot {
  background: var(--color-success);
}

.camera-recorder-bar__status--warn .camera-recorder-bar__dot {
  background: var(--color-warning-border);
}

.camera-recorder-bar__status--danger .camera-recorder-bar__dot {
  background: var(--color-danger);
}

.camera-recorder-bar__meta {
  color: rgba(255, 255, 255, 0.62);
}

.camera-recorder-bar__error {
  color: #fca5a5;
}
</style>
