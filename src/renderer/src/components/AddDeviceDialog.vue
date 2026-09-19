<script setup lang="ts">
/**
 * Add-device dialog (spec section 6.2) — the most important flow in the app.
 *
 * Design constraints that are easy to get wrong:
 *   - IP is NOT a device identity. The probe reports `alreadyRegistered`, and in
 *     that case adding the device only refreshes its connection address; the UI
 *     must say so explicitly and show which local device it matched.
 *   - The password is only ever forwarded to `devices.probe` / `devices.add`.
 *     It is never persisted, never logged, and is wiped from reactive state as
 *     soon as the device has been added or the dialog closes.
 *   - Probing is optional but recommended: 添加 works without it, because the
 *     add path performs its own auth discovery in the main process.
 */
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ProbeResult } from '@shared/ipc/contract'
import { type Device, type DeviceKind } from '@shared/domain/models'
import { hasInstallation, parseInstallation } from '@shared/domain/device-installation'
import { resolveChannelCount } from '@renderer/lib/channelWall'
import { useDevicesStore } from '@renderer/stores/devices'
import AppModal from '@renderer/components/AppModal.vue'
import DevicePushEndpoint from '@renderer/components/DevicePushEndpoint.vue'

const props = defineProps<{ modelValue: boolean }>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  (event: 'added', deviceId: string): void
}>()

const { t } = useI18n()
const devices = useDevicesStore()

interface FormState {
  ip: string
  httpPort: number
  username: string
  password: string
  /**
   * 地址信息（业主 2026-09-18 第 7 / 10 条：原「安装信息」改名为「地址信息」，
   * 并且**删掉基准声压级**）：点位（GIS 经纬度）+ 方位角。
   *
   * 用**字符串**存：输入框给的就是字符串，而"没填"（空串）与"填了 0"必须能分开 ——
   * 用数字的话空输入会变成 0，界面上就出现一个看起来像实测值的纬度 0。
   * 真值由 `parseInstallation()` 解析并校验（与主进程同一套判据）。
   */
  installation: {
    gisLatitude: string
    gisLongitude: string
    azimuthDeg: string
  }
}

/**
 * Defaults.
 *
 * The username is pre-filled because the families we ship against all use a fixed
 * `admin` account that cannot be renamed. The PASSWORD is never pre-filled — not even
 * the documented factory value — because typing it is the operator's assertion that
 * they read it off this specific device, and a pre-filled password would silently
 * "work" against a device still on the factory default while hiding that fact.
 *
 * **机型不再由人选择**（业主 2026-09-17 第 2 条）：协议由主进程自动匹配。
 */
function emptyForm(): FormState {
  return {
    ip: '',
    httpPort: 80,
    username: 'admin',
    password: '',
    installation: { gisLatitude: '', gisLongitude: '', azimuthDeg: '' }
  }
}

const form = reactive<FormState>(emptyForm())
const formError = ref('')
const probing = ref(false)
const adding = ref(false)
const probeResult = ref<ProbeResult | null>(null)
const probeError = ref('')

/**
 * 刚添加成功的那台设备（业主 2026-09-18 第 10 批第 5 条：「添加设备支持 HTTP 推流
 * （秘钥 + 推流地址）」）。
 *
 * 添加成功之后**不立刻关窗**，而是把这一台设备的推流地址与秘钥显示出来：秘钥要趁现在就
 * 填到设备上（或复制走），关掉之后它只剩"去设备列表里点齿轮"这一条路。这一步不写任何东西
 * （秘钥由主进程在读取时生成一条并读回核对，见 `DevicePushEndpoint`）。
 */
const addedDevice = ref<Device | null>(null)

const kindLabel = (kind: DeviceKind): string => t(`domain.deviceKind.${kind}`)

/**
 * 自动识别出来的机型（来自探活结果），没有探活/探不出就是空。
 *
 * 界面**不让人选**机型（业主 2026-09-17 第 2 条），但必须把"识别成了什么"说出来：
 * 加错家系的代价是整套协议不对（表现成"没响应"），不说就是在让操作员自己猜。
 */
const detectedKind = computed<DeviceKind | undefined>(() => probeResult.value?.kind)

const open = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

/** Simple IPv4 / hostname validation; the main process validates again. */
function validate(): string {
  const ip = form.ip.trim()
  if (!ip) return t('addDeviceUi.errIpRequired')
  const isIpv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(ip)
  if (isIpv4) {
    const parts = ip.split('.').map((part) => Number(part))
    if (parts.some((part) => part > 255)) return t('addDeviceUi.errIpRange')
  } else if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(ip)) {
    return t('addDeviceUi.errHostInvalid')
  }
  const port = Number(form.httpPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return t('addDeviceUi.errPort')
  if (!form.username.trim()) return t('addDeviceUi.errUsername')
  if (!form.password) return t('addDeviceUi.errPassword')
  return ''
}

function resetProbe(): void {
  probeResult.value = null
  probeError.value = ''
}

/**
 * 清干净这次输入（关窗时走这条路）。
 *
 * 注意它**不**在"添加成功"那条路上被调用：那时窗口还开着，要显示这一台设备的推流地址，
 * 而表单已经被 `addedDevice` 那一块换掉了（见模板里的两个分支）。
 */
function resetForm(): void {
  Object.assign(form, emptyForm())
  formError.value = ''
  addedDevice.value = null
  resetProbe()
}

/**
 * Any edit after a probe invalidates the preview: otherwise the panel could
 * describe device A while 添加 registers device B.
 *
 * 机型不再是可编辑项（自动识别），所以这里盯的是地址与凭据；安装信息不参与：
 * 它不改变"这台设备是谁"，改点位不该让探活结果作废。
 */
watch(
  () => [form.ip, form.httpPort, form.username, form.password],
  () => resetProbe()
)

watch(
  () => props.modelValue,
  (isOpen) => {
    if (!isOpen) {
      // Wipe the credential from memory whenever the dialog goes away.
      form.password = ''
      formError.value = ''
      addedDevice.value = null
      resetProbe()
    }
  }
)

async function testConnection(): Promise<void> {
  const validation = validate()
  if (validation) {
    formError.value = validation
    return
  }
  const installationProblem = installationValidation()
  if (installationProblem) {
    formError.value = installationProblem
    return
  }
  formError.value = ''
  resetProbe()
  probing.value = true
  // 不带 `kind`：机型由主进程**自动识别**（业主 2026-09-17 第 2 条）。
  const { result, error } = await devices.probe({
    ip: form.ip.trim(),
    httpPort: Number(form.httpPort),
    username: form.username.trim(),
    password: form.password
  })
  probing.value = false
  if (error) {
    probeError.value = error
    return
  }
  probeResult.value = result ?? null
}

async function submit(): Promise<void> {
  const validation = validate()
  if (validation) {
    formError.value = validation
    return
  }
  const installationProblem = installationValidation()
  if (installationProblem) {
    formError.value = installationProblem
    return
  }
  formError.value = ''
  adding.value = true
  const parsed = parseInstallation(form.installation)
  const device = await devices.add({
    ip: form.ip.trim(),
    httpPort: Number(form.httpPort),
    username: form.username.trim(),
    password: form.password,
    // 只有**真的填了东西**才带上这一组：四项全空时不写 installation，
    // 免得库里出现一个"录过安装信息但四项都空"的假象。
    ...(hasInstallation(parsed.installation) ? { installation: parsed.installation } : {})
  })
  adding.value = false
  if (!device) {
    // `devices.add` already normalised the failure into store.error.
    formError.value = devices.error || t('addDeviceUi.errAddFailed')
    return
  }
  emit('added', device.id)
  resetProbe()
  form.password = ''
  addedDevice.value = device
}

/** 安装信息四个输入的即时校验；返回空串表示没问题。 */
function installationValidation(): string {
  const parsed = parseInstallation(form.installation)
  return parsed.ok ? '' : t(parsed.reasonKey ?? 'installUi.errAzimuth')
}

function close(): void {
  open.value = false
  resetForm()
}

const probeInfo = computed(() => probeResult.value?.info)
const probeUnreachable = computed(
  () => probeResult.value !== null && probeResult.value.reachable === false
)

/**
 * 探测回来的通道数，以及它**到底能不能算设备报的**。
 *
 * 这一格原来直接渲染 `probeInfo.channelCount`，于是「设备报了 8 路」与「设备什么都没报、
 * 协议映射填了常量 8」在屏幕上完全一样。判定交给 `resolveChannelCount()`（纯函数、
 * 有单元测试）：探测阶段拿不到通道表（还没登记，`GET /get_passageway` 无从问起），
 * 所以只有**不等于协议常量的回报值**才显示，其余显示「—（设备未上报）」。
 *
 * 相机没有这个字段也没有 `info`，因此它仍然是「—」，不会被写成「未上报通道数」。
 */
const probeChannelCount = computed(() =>
  resolveChannelCount({
    channelTableCount: null,
    deviceReportedCount: probeInfo.value?.channelCount ?? null
  })
)
</script>

<template>
  <AppModal
    v-model="open"
    :title="t('addDeviceUi.title')"
    width="600px"
    :close-on-overlay="!probing && !adding"
  >
    <!--
      `data-add-device-dialog` 是**给探针用的**标记（不带任何样式）：对话框在 DOM 里不止一个
      （顶栏的告警浮层也是 `role=dialog`），探针必须能一眼认出"这一个才是添加设备"。
      判据不能再是"里面有机型单选项" —— 机型选择已经删掉了（第 2 条）。
    -->
    <div class="add" data-add-device-dialog>
      <!--
        添加成功之后这一块**接替**表单：设备已经在库里了，这时现场要做的下一件事是
        「把这台设备的推流地址填到设备上」（业主 2026-09-18 第 10 批第 5 条）。
        此时地址与秘钥是**确定的**（就这一台），所以它比"关掉窗口、再去设备列表点齿轮"有用。
      -->
      <template v-if="addedDevice">
        <p class="alert alert--success" role="status" data-add-device-done>
          {{ t('devicesUi.noticeAdded') }}
        </p>
        <DevicePushEndpoint :device-id="addedDevice.id" />
      </template>

      <template v-else>
      <!--
        **不让人选机型**（业主 2026-09-17 第 2 条）：协议由主进程按地址自动匹配。
        为什么这比"选一张机型卡"更好：选错家系的表现是"设备没响应"，而那是**网络故障的样子** ——
        操作员会去查网线，而不是回头看自己选错了哪张卡。自动识别把这件事从"用户的判断题"
        变成"软件的判断题"，并且识别结果**当面说出来**（下面那行提示）。
      -->
      <p class="add__lead">{{ t('addDeviceUi.autoDetectLead') }}</p>

      <div class="form-grid">
        <label class="field">
          <span class="field-label">{{ t('devices.ip') }}</span>
          <input
            v-model="form.ip"
            data-autofocus
            class="input"
            type="text"
            placeholder="192.168.1.100"
            autocomplete="off"
            spellcheck="false"
          />
        </label>

        <label class="field">
          <span class="field-label">{{ t('devices.port') }}</span>
          <input v-model.number="form.httpPort" class="input" type="number" min="1" max="65535" />
          <span class="field-hint">{{ t('addDeviceUi.defaultPort') }}</span>
        </label>

        <label class="field">
          <span class="field-label">{{ t('devices.username') }}</span>
          <input v-model="form.username" class="input" type="text" autocomplete="off" />
        </label>

        <label class="field">
          <span class="field-label">{{ t('devices.password') }}</span>
          <input v-model="form.password" class="input" type="password" autocomplete="off" />
        </label>
      </div>

      <!--
        **地址信息**（业主 2026-09-18 第 7 / 10 条）：原「安装信息」，去掉基准声压级。
        **与机型无关地一直显示**：机型是自动识别的，而"探活之前不让填点位"会让没有凭据时
        完全录不进地址信息。经纬度与方位角都可空；声源定位设备（Air Sonar / SN-16）才需要填。
      -->
      <fieldset class="install">
        <legend class="field-label">{{ t('installUi.section') }}</legend>
        <p class="field-hint">{{ t('installUi.sectionHint') }}</p>
        <div class="form-grid">
          <label class="field">
            <span class="field-label">{{ t('installUi.latitude') }}</span>
            <input
              v-model="form.installation.gisLatitude"
              class="input mono"
              type="text"
              inputmode="decimal"
              placeholder="31.2304"
              autocomplete="off"
              spellcheck="false"
            />
          </label>
          <label class="field">
            <span class="field-label">{{ t('installUi.longitude') }}</span>
            <input
              v-model="form.installation.gisLongitude"
              class="input mono"
              type="text"
              inputmode="decimal"
              placeholder="121.4737"
              autocomplete="off"
              spellcheck="false"
            />
          </label>
          <label class="field">
            <span class="field-label">{{ t('installUi.azimuth') }}</span>
            <input
              v-model="form.installation.azimuthDeg"
              class="input mono"
              type="text"
              inputmode="decimal"
              placeholder="0"
              autocomplete="off"
              spellcheck="false"
            />
            <span class="field-hint">{{ t('installUi.azimuthHint') }}</span>
          </label>
        </div>
      </fieldset>

      <p v-if="formError" class="alert alert--danger" role="alert">{{ formError }}</p>

      <!-- Probe failure: the message already came from the unified error model. -->
      <p v-if="probeError" class="alert alert--danger" role="alert">{{ probeError }}</p>

      <template v-if="probeResult">
        <div v-if="probeUnreachable" class="alert alert--warning">
          <span class="alert__body">
            <span class="alert__title">{{ t('addDeviceUi.noResponseTitle') }}</span>
            <br />
            {{ t('addDeviceUi.noResponseBody') }}
          </span>
        </div>

        <div v-else class="probe">
          <div class="probe__header">
            <span class="badge badge--success">{{ t('addDeviceUi.probeSuccess') }}</span>
            <span class="probe__meta">
              {{ t('addDeviceUi.probeLatency', { ms: probeResult.latencyMs ?? '—' }) }}
              <template v-if="probeResult.authStrategy">
                · {{ t('addDeviceUi.probeAuth', { strategy: probeResult.authStrategy }) }}
              </template>
            </span>
          </div>

          <!--
            **自动识别出来的机型**必须说出来：加错家系的代价是整套协议不对，
            而那个症状（没响应）会被读成网络故障。识别结果来自探活本身。
          -->
          <p v-if="detectedKind" class="probe__kind" data-probe-kind>
            {{ t('addDeviceUi.detectedKind', { kind: kindLabel(detectedKind) }) }}
          </p>

          <dl class="kv">
            <div class="kv__item">
              <dt class="kv__label">{{ t('devices.name') }}</dt>
              <dd class="kv__value">{{ probeInfo?.name || '—' }}</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('devicesUi.deviceId') }}</dt>
              <dd class="kv__value mono">{{ probeInfo?.deviceUid || '—' }}</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('devicesUi.mac') }}</dt>
              <dd class="kv__value mono">{{ probeInfo?.mac || '—' }}</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('addDeviceUi.firmwareVersion') }}</dt>
              <dd class="kv__value">{{ probeInfo?.firmwareVersion || '—' }}</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('devicesUi.channelCount') }}</dt>
              <dd class="kv__value">
                {{ probeChannelCount.count ?? '—' }}
                <!--
                  只有设备确实回了 info、却拿不出一个能归因于它的通道数时才写这句：
                  相机根本没有 `info`，它的「—」不是「未上报通道数」。
                -->
                <span v-if="probeInfo && probeChannelCount.source === 'unreported'" class="muted">
                  （{{ t('addDeviceUi.channelCountUnreported') }}）
                </span>
              </dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('addDeviceUi.fpgaWebVersion') }}</dt>
              <dd class="kv__value">
                {{ probeInfo?.fpgaVersion || '—' }} / {{ probeInfo?.webVersion || '—' }}
              </dd>
            </div>
          </dl>
        </div>

        <!-- Spec 6.2: the identity is the deviceUid, not the IP. -->
        <div v-if="probeResult.alreadyRegistered" class="alert alert--warning">
          <span class="alert__body">
            <span class="alert__title">{{ t('addDeviceUi.alreadyRegisteredTitle') }}</span>
            <br />
            {{ t('addDeviceUi.alreadyRegisteredBody') }}
            <code class="mono">{{ probeResult.existingDeviceId || t('common.unknown') }}</code>
          </span>
        </div>
      </template>
      </template>
    </div>

    <template #footer>
      <!--
        添加成功之后只剩「完成」：这一台已经进库了，再点一次「添加设备」只会再注册一遍
        （主进程按设备标识幂等，所以它不会产生第二台，但按钮会让人以为还能做点什么）。
      -->
      <button v-if="addedDevice" type="button" class="btn btn--primary" @click="close">
        {{ t('common.close') }}
      </button>
      <template v-else>
        <button type="button" class="btn" :disabled="probing || adding" @click="testConnection">
          {{ probing ? t('addDeviceUi.testing') : t('devices.testConnection') }}
        </button>
        <button type="button" class="btn btn--primary" :disabled="adding || probing" @click="submit">
          {{ adding ? t('addDeviceUi.adding') : t('devices.addDevice') }}
        </button>
        <button type="button" class="btn btn--ghost" :disabled="adding" @click="close">{{ t('common.cancel') }}</button>
      </template>
    </template>
  </AppModal>
</template>

<style scoped>
.add {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.add__lead {
  font-size: 12.5px;
  color: var(--color-text-secondary);
}

/*
 * 这里原来还有一套「机型选择卡片」的样式（`.kind` / `.kind__options` / `.kind__option*` /
 * `.kind__radio` / `.kind__name` / `.kind__desc`）。业主 2026-09-17 第 2 条把机型选择整个删掉
 * （协议由主进程按地址自动匹配），样式随之删除 —— 留着它们，下一个人会以为对话框里还有那块内容，
 * 而探针也会继续去数一个不该存在的单选组。
 */

.field-hint--warning {
  color: var(--color-warning);
}

.probe {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-subtle);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.probe__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.probe__meta {
  font-size: 11.5px;
  color: var(--color-text-secondary);
}

.kv__item {
  margin: 0;
}

dd {
  margin: 0;
}
</style>
