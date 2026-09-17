<script setup lang="ts">
/**
 * 设备维护（Phase 10）— 全部为破坏性操作。
 *
 * CONFIRMATION IS THE WHOLE POINT OF THIS FILE
 * The IPC contract states it plainly: the three control operations execute
 * immediately and the renderer owns the guard. So every button here opens a
 * dialog that names the CONSEQUENCE (what stops working, what is lost, how long
 * it takes) rather than asking "确定吗？", and 恢复出厂设置 additionally requires
 * the literal word RESET to be typed — a mis-click cannot produce that.
 *
 * These calls go straight to `window.api.maintenance.*` instead of through the
 * configuration store on purpose: the store mirrors `window.api.config.*` state
 * (configuration that can be read back), while these are one-shot actions with
 * no state to keep in sync.
 *
 * FIRMWARE SIZE: `pickFirmware()` returns a path only. The renderer has no file
 * access (and must not gain any), so the byte count is known only AFTER the
 * upload completes, from its result. The UI says that instead of inventing one.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DeviceResult } from '@shared/errors'
import { useDevicesStore } from '@renderer/stores/devices'
import { formatBytes } from '@renderer/lib/format'
import { callApi, resultMessage } from '@renderer/lib/result'
import AppModal from '@renderer/components/AppModal.vue'

const props = defineProps<{ deviceId: string }>()

const { t } = useI18n()
const devices = useDevicesStore()

type ActionKind = 'reboot' | 'reset' | 'upgrade' | 'upload'

/** The literal word required before a factory reset can be confirmed. */
const RESET_WORD = 'RESET'

const running = ref<ActionKind | null>(null)
const notice = ref('')
const error = ref('')

const pending = ref<ActionKind | null>(null)
const resetPhrase = ref('')

const firmwarePath = ref('')
/** Bytes actually uploaded, from the upload result. Unknown before that. */
const firmwareBytes = ref<number | null>(null)

/** 重启成功后的“设备正在重启”状态：提供刷新按钮，而不是自动轮询。 */
const awaitingReboot = ref(false)

/**
 * Translation keys per action. Deliberately explicit about consequences — see the
 * file header.
 *
 * Keys rather than text: this map is built once at module scope, so rendered
 * strings would freeze at the startup language.
 */
const CONFIRM_KEYS: Record<ActionKind, { titleKey: string; bodyKey: string; confirmKey: string }> = {
  reboot: {
    titleKey: 'configMaintenance.rebootConfirmTitle',
    bodyKey: 'configMaintenance.rebootConfirmBody',
    confirmKey: 'configMaintenance.rebootConfirm'
  },
  upgrade: {
    titleKey: 'configMaintenance.upgradeConfirmTitle',
    bodyKey: 'configMaintenance.upgradeConfirmBody',
    confirmKey: 'configMaintenance.upgradeConfirm'
  },
  reset: {
    titleKey: 'configMaintenance.resetConfirmTitle',
    bodyKey: 'configMaintenance.resetConfirmBody',
    confirmKey: 'configMaintenance.resetConfirm'
  },
  upload: {
    titleKey: 'configMaintenance.uploadConfirmTitle',
    bodyKey: 'configMaintenance.uploadConfirmBody',
    confirmKey: 'configMaintenance.uploadConfirm'
  }
}

const canReset = computed(() => resetPhrase.value.trim() === RESET_WORD)

const confirmInfo = computed(() => {
  const kind = pending.value
  if (!kind) return null
  const keys = CONFIRM_KEYS[kind]
  return {
    title: t(keys.titleKey),
    consequence: t(keys.bodyKey),
    confirm: t(keys.confirmKey)
  }
})

const firmwareName = computed(() => {
  if (!firmwarePath.value) return ''
  // Both separators: the packaged app targets Windows, the dev machine is POSIX.
  const parts = firmwarePath.value.split(/[\\/]/)
  return parts[parts.length - 1] ?? firmwarePath.value
})

function openConfirm(kind: ActionKind): void {
  error.value = ''
  notice.value = ''
  resetPhrase.value = ''
  pending.value = kind
}

function closeConfirm(): void {
  pending.value = null
  resetPhrase.value = ''
}

/** Run one maintenance call, funnelling failure text into `error`. */
async function run(
  kind: ActionKind,
  operation: () => Promise<DeviceResult<void>>
): Promise<boolean> {
  running.value = kind
  const result = await callApi(operation)
  running.value = null
  if (!result.success) {
    error.value = resultMessage(result)
    return false
  }
  error.value = ''
  return true
}

async function confirmPending(): Promise<void> {
  const kind = pending.value
  if (!kind) return

  if (kind === 'reboot') {
    const ok = await run('reboot', () => window.api.maintenance.reboot(props.deviceId))
    if (!ok) return
    closeConfirm()
    awaitingReboot.value = true
    notice.value = t('configMaintenance.noticeRebooting')
    return
  }

  if (kind === 'upgrade') {
    const ok = await run('upgrade', () => window.api.maintenance.systemUpgrade(props.deviceId))
    if (!ok) return
    closeConfirm()
    notice.value = t('configMaintenance.noticeUpgrading')
    return
  }

  if (kind === 'reset') {
    if (!canReset.value) return
    const ok = await run('reset', () => window.api.maintenance.factoryReset(props.deviceId))
    if (!ok) return
    closeConfirm()
    awaitingReboot.value = true
    notice.value = t('configMaintenance.noticeReset')
    return
  }

  // upload：单独处理，因为返回值带有实际字节数（上传前无法得知文件大小）。
  if (!firmwarePath.value) {
    error.value = t('configMaintenance.errNoFile')
    closeConfirm()
    return
  }
  running.value = 'upload'
  const uploaded = await callApi(() =>
    window.api.maintenance.uploadFirmware(props.deviceId, firmwarePath.value)
  )
  running.value = null
  if (!uploaded.success) {
    error.value = resultMessage(uploaded)
    return
  }
  firmwareBytes.value = uploaded.data?.bytes ?? null
  closeConfirm()
  notice.value = t('configMaintenance.noticeUploaded')
}

async function pickFirmware(): Promise<void> {
  error.value = ''
  notice.value = ''
  const picked = await callApi(() => window.api.maintenance.pickFirmware())
  if (!picked.success) {
    error.value = resultMessage(picked)
    return
  }
  const path = picked.data ?? null
  if (!path) return // 用户取消
  firmwarePath.value = path
  firmwareBytes.value = null
}

function clearFirmware(): void {
  firmwarePath.value = ''
  firmwareBytes.value = null
}

async function refreshStatus(): Promise<void> {
  await devices.refreshStatus(props.deviceId)
  awaitingReboot.value = false
  const status = devices.byId(props.deviceId)?.status
  notice.value =
      status === 'ONLINE'
        ? t('configMaintenance.noticeOnline')
        : t('configMaintenance.noticeStillOffline')
}
</script>

<template>
  <section class="card card--danger">
    <div class="section-header">
      <h3 class="section-title">{{ t('configMaintenance.title') }}</h3>
      <span class="badge badge--danger">{{ t('configMaintenance.destructiveBadge') }}</span>
    </div>

    <p v-if="error" class="alert alert--danger actions" role="alert">{{ error }}</p>
    <p v-else-if="notice" class="alert alert--success actions" role="status">
      {{ notice }}
      <button
        v-if="awaitingReboot"
        type="button"
        class="btn btn--sm refresh-inline"
        :disabled="devices.loading"
        @click="refreshStatus"
      >
        {{ devices.loading ? t('deviceDetailUi.refreshing') : t('configMaintenance.refreshStatus') }}
      </button>
    </p>

    <div class="action-list">
      <div class="action">
        <div class="action__text">
          <p class="action__title">{{ t('configMaintenance.rebootTitle') }}</p>
        </div>
        <button type="button" class="btn" :disabled="running !== null" @click="openConfirm('reboot')">
          {{ running === 'reboot' ? t('configMaintenance.running') : t('configMaintenance.rebootTitle') }}
        </button>
      </div>

      <div class="action">
        <div class="action__text">
          <p class="action__title">{{ t('configMaintenance.upgradeTitle') }}</p>
        </div>
        <button type="button" class="btn" :disabled="running !== null" @click="openConfirm('upgrade')">
          {{ running === 'upgrade' ? t('configMaintenance.running') : t('configMaintenance.upgradeTitle') }}
        </button>
      </div>

      <div class="action">
        <div class="action__text">
          <p class="action__title">{{ t('configMaintenance.resetTitle') }}</p>
        </div>
        <button
          type="button"
          class="btn btn--danger"
          :disabled="running !== null"
          @click="openConfirm('reset')"
        >
          {{ running === 'reset' ? t('configMaintenance.running') : t('configMaintenance.resetTitle') }}
        </button>
      </div>

      <div class="action action--firmware">
        <div class="action__text">
          <p class="action__title">{{ t('configMaintenance.uploadTitle') }}</p>

          <dl v-if="firmwarePath" class="firmware">
            <div class="firmware__row">
              <dt class="kv__label">{{ t('configMaintenance.selectedFile') }}</dt>
              <dd class="kv__value mono">{{ firmwareName }}</dd>
            </div>
            <div class="firmware__row">
              <dt class="kv__label">{{ t('configMaintenance.fullPath') }}</dt>
              <dd class="kv__value mono">{{ firmwarePath }}</dd>
            </div>
            <div class="firmware__row">
              <dt class="kv__label">{{ t('configMaintenance.fileSize') }}</dt>
              <dd class="kv__value">
                <template v-if="firmwareBytes !== null">{{ formatBytes(firmwareBytes) }}</template>
                <template v-else>
                  <span class="muted">
                    {{ t('configMaintenance.sizeUnknown') }}
                  </span>
                </template>
              </dd>
            </div>
          </dl>
        </div>

        <div class="action__buttons">
          <button type="button" class="btn" :disabled="running !== null" @click="pickFirmware">
            {{ t('configMaintenance.chooseFirmware') }}
          </button>
          <button
            type="button"
            class="btn btn--primary"
            :disabled="running !== null || !firmwarePath"
            @click="openConfirm('upload')"
          >
            {{ running === 'upload' ? t('configMaintenance.uploading') : t('configMaintenance.uploadButton') }}
          </button>
          <button
            v-if="firmwarePath"
            type="button"
            class="btn btn--ghost btn--sm"
            :disabled="running !== null"
            @click="clearFirmware"
          >
            {{ t('common.clearSelection') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 上传中：不确定进度（传输层只报告开始/结束） -->
    <div v-if="running === 'upload'" class="uploading" role="status">
      <div
        class="bar bar--indeterminate"
        role="progressbar"
        :aria-valuetext="t('configMaintenance.uploadProgress')"
      >
        <div class="bar__fill"></div>
      </div>
      <p class="muted uploading__text">
        {{ t('configMaintenance.uploadWarning') }}
      </p>
    </div>
  </section>

  <!-- 二次确认：每一项都说明后果 -->
  <AppModal
    :model-value="pending !== null"
    :title="confirmInfo?.title ?? ''"
    width="520px"
    :close-on-overlay="false"
    @update:model-value="closeConfirm"
  >
    <p class="alert alert--danger" role="alert">{{ confirmInfo?.consequence }}</p>

    <!-- The failure is surfaced INSIDE the dialog as well: the section's own
         banner sits behind the overlay, and a rejected destructive action must
         not look like a dialog that simply refuses to close. -->
    <p v-if="error" class="alert alert--danger confirm-error" role="alert">{{ error }}</p>

    <dl v-if="pending === 'upload' && firmwarePath" class="firmware confirm-firmware">
      <div class="firmware__row">
        <dt class="kv__label">{{ t('configMaintenance.firmwareFile') }}</dt>
        <dd class="kv__value mono">{{ firmwareName }}</dd>
      </div>
      <div class="firmware__row">
        <dt class="kv__label">{{ t('configMaintenance.fullPath') }}</dt>
        <dd class="kv__value mono">{{ firmwarePath }}</dd>
      </div>
    </dl>

    <label v-if="pending === 'reset'" class="field reset-field">
      <!-- The literal RESET phrase stays in the markup: it is what the user must
           type, and interpolating it from the catalogue would make the prompt and
           the accepted word two separate things that could drift apart. -->
      <span class="field-label">{{ t('configMaintenance.resetTypePrompt', { code: 'RESET' }) }}</span>
      <input
        v-model="resetPhrase"
        class="input mono"
        type="text"
        autocomplete="off"
        spellcheck="false"
        placeholder="RESET"
        data-autofocus
      />
    </label>

    <template #footer>
      <button type="button" class="btn" @click="closeConfirm">{{ t('common.cancel') }}</button>
      <button
        type="button"
        class="btn"
        :class="pending === 'reboot' || pending === 'upgrade' ? 'btn--primary' : 'btn--danger'"
        :disabled="running !== null || (pending === 'reset' && !canReset)"
        @click="confirmPending"
      >
        {{ running !== null ? t('configMaintenance.running') : confirmInfo?.confirm }}
      </button>
    </template>
  </AppModal>
</template>

<style scoped>
.card--danger {
  border-color: var(--color-danger-border);
  background: var(--color-danger-soft);
}

.actions {
  margin: var(--space-3) 0;
}

.refresh-inline {
  margin-left: var(--space-2);
  background: var(--color-bg);
}

.action-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.action {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg);
}

.action--firmware {
  flex-direction: column;
}

.action__text {
  min-width: 0;
}

.action__title {
  font-size: 13px;
  font-weight: 600;
}

.action__desc {
  font-size: 12px;
  color: var(--color-text-secondary);
  line-height: 1.7;
}

.action__buttons {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.firmware {
  margin-top: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.firmware__row {
  min-width: 0;
}

.confirm-firmware {
  margin-top: var(--space-3);
}

.confirm-error {
  margin-top: var(--space-3);
}

.uploading {
  margin-top: var(--space-3);
}

.bar--indeterminate .bar__fill {
  width: 40%;
  animation: indeterminate 1.3s ease-in-out infinite;
}

@keyframes indeterminate {
  0% {
    margin-left: -40%;
  }
  100% {
    margin-left: 100%;
  }
}

.uploading__text {
  margin-top: 6px;
  font-size: 12px;
}

.reset-field {
  margin-top: var(--space-3);
}

code {
  font-family: var(--font-mono);
  background: var(--color-bg-muted);
  border-radius: var(--radius-sm);
  padding: 0 4px;
}
</style>
