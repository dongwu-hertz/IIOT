<script setup lang="ts">
/**
 * 空气声呐（SN-16）的**球机联动（PTZ）配置** —— 业主 2026-09-17 第 8 批第 1 条。
 *
 * 这一页是这一族**唯一**的配置页（见 `DeviceDetailView` 的 `AIR_SONAR_TABS`）。
 *
 * ---------------------------------------------------------------------------
 * 三条设计上的事
 * ---------------------------------------------------------------------------
 * 1. **只有「保存」才写设备**。PTZ 是现场调试动作：改错一个端口或把球机口令改坏，
 *    表现是"球机取不到流"，而那看起来像网络问题。所以输入框是本地状态，保存时一次写回
 *    （`PUT /system` 整份回写），不边打字边写。
 * 2. **保存之后按读回结果说话**。主进程写完之后会**重新 `GET /system`**，这里逐项显示
 *    "哪一项生效了 / 哪一项没有（我要的值 vs 设备现在的值）"。设备不认这次写入时，
 *    界面必须跟着显示设备的真实值 —— 而不是显示我们刚敲进去的那一份。
 * 3. **口令只写不读**。设备会明文回 `cam_pass`，但界面只显示「已设置」；不改口令时主进程
 *    会把设备刚给的原值写回去（不会把口令清空）。写了新口令之后这里只说"已写入，
 *    内容未比对" —— 内容对不对只能由球机能否取到流来证明。
 *
 * 手册依据（`Air Sonar User Manual 241128.pdf` 的 `/system` 参数表）：
 * `cam_enable` / `cam_ip` / `cam_port` / `cam_user` / `cam_pass` /
 * `is_ptz_direction_same_with_sonar` / `is_save_snapshot` / `cur_realtime_channel` / `is_cam_init`。
 * **手册没有写这些键哪些可写、也没有给 `PUT /system` 的部分更新语义**，所以我们按它的写示例
 * 做"整份回写"，并且写完必须读回核对 —— 这一条是我们自己的做法，不是手册说的。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { E2PtzConfig, E2PtzFieldCheck, E2PtzPatch } from '@shared/domain/e2-ptz'
import { validatePtzPatch } from '@shared/domain/e2-ptz'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'

const props = defineProps<{ deviceId: string }>()

const { t } = useI18n()

const loading = ref(false)
const saving = ref(false)
const syncing = ref(false)
const loadError = ref('')
const notice = ref('')
const actionError = ref('')

/** 上一次**从设备读回来**的状态（保存之后刷新它，显示的就是设备现在的值）。 */
const config = ref<E2PtzConfig | null>(null)
/** 保存之后逐项核对的结果；空数组 = 还没保存过。 */
const checks = ref<E2PtzFieldCheck[]>([])
/** 写了新口令但内容无法比对（设备只回"已设置"）。 */
const passwordWritten = ref(false)
/** 与球机对时的结果（`accepted` + 设备原话；手册未说明请求体）。 */
const nvtTimeResult = ref<{ accepted: boolean; note: string } | null>(null)

/**
 * 输入框的本地状态。
 *
 * **字符串**存端口与通道：输入框给的就是字符串，而"清空"与"填 0"必须能分开
 * （与添加设备那边的安装信息同一条理由）。开关是布尔（没有"没填"这一态）。
 */
const form = reactive({
  enabled: false,
  cameraIp: '',
  cameraPort: '',
  cameraUser: '',
  cameraPassword: '',
  directionSameAsSonar: false,
  saveSnapshot: false,
  realtimeChannel: ''
})

function seedFrom(config: E2PtzConfig): void {
  form.enabled = config.enabled === true
  form.cameraIp = config.cameraIp ?? ''
  form.cameraPort = config.cameraPort === undefined ? '' : String(config.cameraPort)
  form.cameraUser = config.cameraUser ?? ''
  // 口令永远不预填：设备回的是明文，但界面不持有它（用户不输入就不改）。
  form.cameraPassword = ''
  form.directionSameAsSonar = config.directionSameAsSonar === true
  form.saveSnapshot = config.saveSnapshot === true
  form.realtimeChannel =
    config.realtimeChannel === undefined ? '' : String(config.realtimeChannel)
}

async function load(): Promise<void> {
  loading.value = true
  actionError.value = ''
  const result = await callApi(() => window.api.e2.ptz(props.deviceId))
  loading.value = false
  if (!result.success) {
    loadError.value = resultMessage(result)
    config.value = null
    return
  }
  loadError.value = ''
  const next = unwrap(result) ?? null
  config.value = next
  if (next) seedFrom(next)
}

onMounted(load)

/**
 * 只有**真的改了**的项才进补丁。
 *
 * 为什么：主进程会把整份参数写回设备，所以"把没改的项也带上"不会出错；但读回核对是按补丁
 * 逐项做的 —— 带上没改的项会让核对结果里出现一堆与本意无关的行，而"哪一项没生效"
 * 是这一页最要紧的一句话。
 */
function buildPatch(): { patch: E2PtzPatch; reasonKey: string } {
  const current = config.value
  const patch: E2PtzPatch = {}
  if (current) {
    if (form.enabled !== (current.enabled === true)) patch.enabled = form.enabled
    if (form.cameraIp.trim() !== (current.cameraIp ?? '')) patch.cameraIp = form.cameraIp.trim()
    const port = form.cameraPort.trim()
    if (port !== '' && Number(port) !== current.cameraPort) patch.cameraPort = Number(port)
    if (form.cameraUser.trim() !== (current.cameraUser ?? '')) {
      patch.cameraUser = form.cameraUser.trim()
    }
    if (
      form.directionSameAsSonar !== (current.directionSameAsSonar === true)
    ) {
      patch.directionSameAsSonar = form.directionSameAsSonar
    }
    if (form.saveSnapshot !== (current.saveSnapshot === true)) {
      patch.saveSnapshot = form.saveSnapshot
    }
    const channel = form.realtimeChannel.trim()
    if (channel !== '' && Number(channel) !== current.realtimeChannel) {
      patch.realtimeChannel = Number(channel)
    }
  }
  if (form.cameraPassword !== '') patch.cameraPassword = form.cameraPassword

  // 与界面同一套范围判据（`validatePtzPatch` 是界面与主进程共用的那一个）。
  const validation = validatePtzPatch(patch, current?.channelCount)
  if (!validation.ok) return { patch, reasonKey: validation.reasonKey }
  return { patch, reasonKey: '' }
}

const dirty = computed(() => buildPatch().patch !== undefined && Object.keys(buildPatch().patch).length > 0)

async function save(): Promise<void> {
  notice.value = ''
  actionError.value = ''
  const { patch, reasonKey } = buildPatch()
  if (reasonKey !== '') {
    actionError.value = t(reasonKey)
    return
  }
  if (Object.keys(patch).length === 0) {
    notice.value = t('ptzUi.nothingChanged')
    return
  }
  saving.value = true
  const result = await callApi(() => window.api.e2.updatePtz(props.deviceId, patch))
  saving.value = false
  if (!result.success) {
    actionError.value = resultMessage(result)
    return
  }
  const outcome = unwrap(result)
  checks.value = outcome?.fields ?? []
  passwordWritten.value = patch.cameraPassword !== undefined && (outcome?.allApplied ?? false)
  // 界面刷新成**设备现在的值**（不是我们请求的那一份）。
  if (outcome) {
    config.value = outcome.readBack
    seedFrom(outcome.readBack)
  }
  notice.value = outcome?.allApplied
    ? t('ptzUi.saved')
    : t('ptzUi.savedPartly', { count: checks.value.filter((check) => !check.ok).length })
}

async function syncNvtTime(): Promise<void> {
  notice.value = ''
  actionError.value = ''
  syncing.value = true
  const result = await callApi(() => window.api.e2.syncNvtTime(props.deviceId))
  syncing.value = false
  if (!result.success) {
    actionError.value = resultMessage(result)
    return
  }
  nvtTimeResult.value = unwrap(result) ?? null
}

/** 通道那一格的上限：设备说得出通道数就用它，说不出就不写上限（不猜 16）。 */
const channelMax = computed(() => config.value?.channelCount)

const fieldLabel: Record<E2PtzFieldCheck['field'], string> = {
  enabled: 'ptzUi.fieldEnabled',
  cameraIp: 'ptzUi.fieldCameraIp',
  cameraPort: 'ptzUi.fieldCameraPort',
  cameraUser: 'ptzUi.fieldCameraUser',
  cameraPassword: 'ptzUi.fieldCameraPassword',
  directionSameAsSonar: 'ptzUi.fieldDirection',
  saveSnapshot: 'ptzUi.fieldSaveSnapshot',
  realtimeChannel: 'ptzUi.fieldChannel'
}
</script>

<template>
  <div class="ptz">
    <p v-if="loadError" class="alert alert--danger" role="alert">{{ loadError }}</p>

    <section v-if="config" class="card">
      <div class="section-header">
        <h3 class="section-title">{{ t('ptzUi.title') }}</h3>
        <span v-if="loading" class="muted">{{ t('common.loading') }}</span>
      </div>
      <p class="muted ptz__hint">{{ t('ptzUi.hint') }}</p>

      <div class="form-grid">
        <label class="field field--switch">
          <span class="field-label">{{ t('ptzUi.fieldEnabled') }}</span>
          <input v-model="form.enabled" type="checkbox" data-ptz="enabled" />
          <span class="field-hint">{{ t('ptzUi.enabledHint') }}</span>
        </label>

        <label class="field">
          <span class="field-label">{{ t('ptzUi.fieldCameraIp') }}</span>
          <input
            v-model="form.cameraIp"
            class="input mono"
            type="text"
            spellcheck="false"
            data-ptz="cameraIp"
          />
        </label>

        <label class="field">
          <span class="field-label">{{ t('ptzUi.fieldCameraPort') }}</span>
          <input
            v-model="form.cameraPort"
            class="input mono"
            type="text"
            inputmode="numeric"
            data-ptz="cameraPort"
          />
        </label>

        <label class="field">
          <span class="field-label">{{ t('ptzUi.fieldCameraUser') }}</span>
          <input
            v-model="form.cameraUser"
            class="input"
            type="text"
            autocomplete="off"
            data-ptz="cameraUser"
          />
        </label>

        <label class="field">
          <span class="field-label">{{ t('ptzUi.fieldCameraPassword') }}</span>
          <input
            v-model="form.cameraPassword"
            class="input"
            type="password"
            autocomplete="new-password"
            :placeholder="config.cameraPasswordSet ? t('ptzUi.passwordSet') : t('ptzUi.passwordUnset')"
            data-ptz="cameraPassword"
          />
          <span class="field-hint">{{ t('ptzUi.passwordHint') }}</span>
        </label>

        <label class="field field--switch">
          <span class="field-label">{{ t('ptzUi.fieldDirection') }}</span>
          <input
            v-model="form.directionSameAsSonar"
            type="checkbox"
            data-ptz="directionSameAsSonar"
          />
          <span class="field-hint">{{ t('ptzUi.directionHint') }}</span>
        </label>

        <label class="field field--switch">
          <span class="field-label">{{ t('ptzUi.fieldSaveSnapshot') }}</span>
          <input v-model="form.saveSnapshot" type="checkbox" data-ptz="saveSnapshot" />
          <span class="field-hint">{{ t('ptzUi.saveSnapshotHint') }}</span>
        </label>

        <label class="field">
          <span class="field-label">{{ t('ptzUi.fieldChannel') }}</span>
          <input
            v-model="form.realtimeChannel"
            class="input mono"
            type="text"
            inputmode="numeric"
            data-ptz="realtimeChannel"
          />
          <span class="field-hint">
            {{
              channelMax === undefined
                ? t('ptzUi.channelHintUnknown')
                : t('ptzUi.channelHint', { max: channelMax })
            }}
          </span>
        </label>
      </div>

      <!--
        「球机是否已初始化」是**设备状态**，不是设置项：它由设备在球机握手之后自己置位，
        所以我们只显示、不回写（回写一个我们猜的值会把设备的状态改坏）。
      -->
      <dl class="kv ptz__status">
        <div class="kv__item">
          <dt class="kv__label">{{ t('ptzUi.cameraInitialised') }}</dt>
          <dd class="kv__value">
            {{
              config.cameraInitialised === undefined
                ? t('ptzUi.unknown')
                : config.cameraInitialised
                  ? t('ptzUi.yes')
                  : t('ptzUi.no')
            }}
          </dd>
        </div>
        <div class="kv__item">
          <dt class="kv__label">{{ t('ptzUi.passwordState') }}</dt>
          <dd class="kv__value">
            {{ config.cameraPasswordSet ? t('ptzUi.passwordSet') : t('ptzUi.passwordUnset') }}
          </dd>
        </div>
      </dl>

      <div class="btn-row">
        <button
          type="button"
          class="btn btn--primary"
          :disabled="saving || loading"
          data-action="ptz-save"
          @click="save"
        >
          {{ saving ? t('common.saving') : t('ptzUi.save') }}
        </button>
        <button
          type="button"
          class="btn"
          :disabled="syncing || loading"
          data-action="ptz-time-sync"
          @click="syncNvtTime"
        >
          {{ syncing ? t('ptzUi.syncing') : t('ptzUi.syncTime') }}
        </button>
        <span v-if="dirty" class="muted ptz__dirty">{{ t('ptzUi.unsaved') }}</span>
      </div>

      <p v-if="actionError" class="alert alert--danger" role="alert">{{ actionError }}</p>
      <p v-if="notice" class="alert alert--success" role="status" data-ptz-notice>{{ notice }}</p>

      <!--
        与球机对时：手册**只列了端点、没有写请求体**，所以这里照实说"请求被接受了",
        并把设备的原话带出来 —— 不假装知道它做了什么。
      -->
      <p v-if="nvtTimeResult" class="alert" :class="nvtTimeResult.accepted ? 'alert--success' : 'alert--warning'" role="status" data-ptz-nvt-time>
        {{
          nvtTimeResult.accepted
            ? t('ptzUi.timeSyncAccepted')
            : t('ptzUi.timeSyncRejected')
        }}
        <span v-if="nvtTimeResult.note" class="muted">（{{ nvtTimeResult.note }}）</span>
      </p>
    </section>

    <!--
      读回核对：**写完之后设备现在是什么值**。没生效的项排在上面并写清"我要的值 / 设备的值"，
      因为这一块的全部价值就是"哪一项没生效"。
    -->
    <section v-if="checks.length > 0" class="card" data-ptz-checks>
      <div class="section-header">
        <h3 class="section-title">{{ t('ptzUi.readBackTitle') }}</h3>
        <span class="badge" :class="checks.every((check) => check.ok) ? 'badge--success' : 'badge--warning'">
          {{ checks.every((check) => check.ok) ? t('ptzUi.allApplied') : t('ptzUi.someFailed') }}
        </span>
      </div>
      <ul class="ptz__checks">
        <li v-for="check in checks" :key="check.field" :class="{ 'ptz__check--bad': !check.ok }">
          <span class="ptz__check-name">{{ t(fieldLabel[check.field]) }}</span>
          <span v-if="check.ok" class="muted">{{ t('ptzUi.applied') }}</span>
          <span v-else class="ptz__check-bad">
            {{ t('ptzUi.expectedActual', { expected: check.expected, actual: check.actual }) }}
          </span>
        </li>
      </ul>
      <p v-if="passwordWritten" class="muted ptz__hint">{{ t('ptzUi.passwordNotCompared') }}</p>
    </section>
  </div>
</template>

<style scoped>
.ptz {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.ptz__hint {
  font-size: 11.5px;
  margin: 0;
}

.ptz__status {
  margin: var(--space-3) 0 0;
}

.field--switch {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.field--switch .field-hint {
  flex-basis: 100%;
}

.btn-row {
  margin-top: var(--space-3);
}

.ptz__dirty {
  font-size: 11.5px;
}

.ptz__checks {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12.5px;
}

.ptz__checks li {
  display: flex;
  gap: 10px;
  align-items: baseline;
}

.ptz__check-name {
  min-width: 140px;
  color: var(--color-text-secondary);
}

.ptz__check-bad {
  color: var(--color-danger);
}

.ptz__check--bad .ptz__check-name {
  color: var(--color-danger);
}
</style>
