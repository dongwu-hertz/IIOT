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
import {
  DEFAULT_INGEST_VIDEO_KEY,
  defaultIngestMetricKeys,
  deviceIngestPlanProblems,
  isBindAddress,
  isPort,
  normaliseDeviceIngestPlan,
  type DeviceIngestPlan,
  type IngestDisplayMetric,
  type IngestMetricKey,
  type IngestProtocol
} from '@shared/domain/iot-ingest'
import { resolveChannelCount } from '@renderer/lib/channelCount'
import { formatDateTime } from '@renderer/lib/format'
import { useDevicesStore } from '@renderer/stores/devices'
import { useIngestStore } from '@renderer/stores/ingest'
import { useSettingsStore } from '@renderer/stores/settings'
import AppModal from '@renderer/components/AppModal.vue'
import MapPointPicker from '@renderer/components/MapPointPicker.vue'
import DevicePushEndpoint from '@renderer/components/DevicePushEndpoint.vue'

const props = defineProps<{ modelValue: boolean }>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  (event: 'added', deviceId: string): void
}>()

const { t } = useI18n()
const devices = useDevicesStore()
const ingest = useIngestStore()
const settings = useSettingsStore()

interface FormState {
  /**
   * 设备名称 —— **只有 HTTP/MQTT 推送模式必填**（业主 20260921 第 12 条）：IP 地址模式的
   * 名字来自设备自己（探活的 `info.name`），而推送设备没有"问设备叫什么"这一步，
   * 界面上显示什么完全由这一次输入决定。
   */
  name: string
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
    name: '',
    ip: '',
    httpPort: 80,
    username: 'admin',
    password: '',
    installation: { gisLatitude: '', gisLongitude: '', azimuthDeg: '' }
  }
}

const form = reactive<FormState>(emptyForm())
const mapPickerOpen = ref(false)
const formError = ref('')
const probing = ref(false)
const adding = ref(false)
const probeResult = ref<ProbeResult | null>(null)
const probeError = ref('')

/**
 * 「地址信息」展开着吗？**默认收起**（业主 2026-09-19 第 13 批第 2 条）。
 *
 * 收起时那一行仍要说清"填了没有"（见 `installationSummary`）：一个纯标题的折叠行会让
 * 操作员要么每次点开看一眼、要么永远不知道里面有没有东西。
 */
const installationOpen = ref(false)

function coordinateInput(value: string): number | undefined {
  const text = value.trim()
  if (text === '') return undefined
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

function onMapPointPicked(point: { latitude: number; longitude: number }): void {
  form.installation.gisLatitude = point.latitude.toFixed(6)
  form.installation.gisLongitude = point.longitude.toFixed(6)
}

/** 收起状态下那一行小结：没填 / 填了什么（只报"有没有点位"，不在这里堆坐标）。 */
const installationSummary = computed(() => {
  const parsed = parseInstallation(form.installation)
  if (!hasInstallation(parsed.installation)) return t('addDeviceUi.installationEmpty')
  if (parsed.installation.gisLatitude !== undefined && parsed.installation.gisLongitude !== undefined) {
    return t('addDeviceUi.installationPoint', {
      latitude: parsed.installation.gisLatitude,
      longitude: parsed.installation.gisLongitude
    })
  }
  return t('addDeviceUi.installationPartial')
})

// ---------------------------------------------------------------------------
// 接入方式（业主 20260921 第 12 条：添加设备**先选接入方式**，三选一）
// ---------------------------------------------------------------------------

/**
 * 三选一：**IP 地址** = 我们主动去连的设备（原有流程：地址 + 凭据 + 探活自动识别机型）；
 * **HTTP / MQTT** = 纯推送第三方设备（设备把数据推到本机，没有地址与凭据，名称必填，
 * 登记为 `pushDevice`）。
 *
 * 原来的"协议接入方式"单选（不接入 / HTTP / MQTT）被这一组**取代**：'不接入'这个选项
 * 消失 —— IP 地址就是"不接入推流"，不再作为单独一档出现。
 */
const ACCESS_METHODS = ['ip', 'http', 'mqtt'] as const

type AccessMethod = (typeof ACCESS_METHODS)[number]

const ACCESS_METHOD_LABEL_KEYS: Record<AccessMethod, string> = {
  ip: 'addDeviceUi.accessMethodIp',
  http: 'addDeviceUi.accessMethodHttp',
  mqtt: 'addDeviceUi.accessMethodMqtt'
}

/** 接入方式（默认 IP 地址）。 */
const accessMethod = ref<AccessMethod>('ip')

/** 所选接入方式对应的推流协议（IP 地址模式即"不接入推流"）。 */
const ingestProtocol = computed<IngestProtocol>(() =>
  accessMethod.value === 'ip' ? 'none' : accessMethod.value
)

/** 现在是 HTTP/MQTT 推送模式吗（界面按它切换字段集与校验）。 */
const pushMode = computed(() => accessMethod.value !== 'ip')

/** 四个可显示指标的**名字**复用目录里那四个既有词条（趋势页与实时监测页用的是同一批）。 */
const METRIC_LABEL_KEYS: Record<IngestDisplayMetric, string> = {
  spl: 'metrics.spl',
  mainFrequency: 'metrics.mainFrequency',
  smoothness: 'metrics.smoothness',
  bandEnergyRatio: 'metrics.bandEnergyRatio'
}

/**
 * 数据流接口那四行。
 *
 * 用 `ref`（而不是 `computed`）：它们是**可编辑的草稿**，键名会被操作员改；
 * 换语言不该重置它们，而 `defaultIngestMetricKeys()` 每次都返回新数组。
 */
const metricKeys = ref<IngestMetricKey[]>(defaultIngestMetricKeys())
const videoKey = ref(DEFAULT_INGEST_VIDEO_KEY)

/** 这一屏要提交的那份方案（判据与落库用的是同一个纯函数）。 */
const ingestPlan = computed<DeviceIngestPlan>(() => ({
  protocol: ingestProtocol.value,
  metricKeys: metricKeys.value,
  videoKey: videoKey.value
}))

const planProblems = computed(() => deviceIngestPlanProblems(ingestPlan.value))

/** 本机监听的现状（只读）：监听中 / 未监听 + 原因。 */
const listenStatusText = computed(() => {
  const status = ingest.status
  if (!status) return t('addDeviceUi.protocolListenUnknown')
  const entry = ingestProtocol.value === 'mqtt' ? status.mqtt : status.http
  const port = ingestProtocol.value === 'mqtt' ? status.config.mqttPort : status.config.httpPort
  if (entry.listening) {
    return t('addDeviceUi.protocolListening', { port: entry.port ?? port })
  }
  return entry.error
    ? t('addDeviceUi.protocolNotListeningReason', { reason: entry.error })
    : t('addDeviceUi.protocolNotListening')
})

// ---------------------------------------------------------------------------
// 本机接入：监听设置 + 收数统计（第 13 批第 1 条：数据接入搬进添加设备）
// ---------------------------------------------------------------------------

/** 折叠状态。默认收起：它是"配好之后偶尔回来看一眼"的东西，不该占着主路径。 */
const iotLocalOpen = ref(false)

/**
 * 监听设置的草稿（绑定地址 + 两个端口）。
 *
 * 只草拟**这三项**：`enabled` / `httpEnabled` / `mqttEnabled` 由**设备声明**派生
 * （`DeviceService.syncIngest()` → `syncIngestFromDevices()`），界面不该拨它们 ——
 * 拨了也会被下一次设备变更覆盖，而"我改了它又自己变回去了"是最难解释的一种界面行为。
 * 但 `settings.update` 收的是**整份** `IotIngestConfig`，所以提交时把当前那份展开再覆盖这三项
 * （enabled 那三个键原样带回去，等于什么都没改）。
 */
const iotDraft = ref({ bindAddress: '0.0.0.0', httpPort: 8080, mqttPort: 1883 })
const iotSaving = ref(false)
const iotNotice = ref('')
const iotError = ref('')

/** 当前落库的那一份（拿来判断草稿有没有改、也是提交时的底稿）。 */
const iotCurrent = computed(() => settings.settings?.iotIngest)

const iotDirty = computed(() => {
  const current = iotCurrent.value
  if (!current) return false
  return (
    iotDraft.value.bindAddress.trim() !== current.bindAddress ||
    Number(iotDraft.value.httpPort) !== current.httpPort ||
    Number(iotDraft.value.mqttPort) !== current.mqttPort
  )
})

/** 两个监听端口撞在一起：这不是错误，但一定不是操作员想要的（一启一失）。 */
const iotPortConflict = computed(
  () => Number(iotDraft.value.httpPort) === Number(iotDraft.value.mqttPort)
)

/** 派生的三个开关的说法（只读那一行用）。 */
const ingestEnabledText = computed(() =>
  ingest.status?.config.enabled ? t('iotUi.derivedOn') : t('iotUi.derivedOff')
)

function ingestChannelText(flag: boolean | undefined): string {
  return flag ? t('iotUi.derivedOn') : t('iotUi.derivedOff')
}

/** 一句"监听中 0.0.0.0:8080 / 未监听"（复用设置页原来那两个词条，说法保持一致）。 */
function listenerText(entry: { listening: boolean; port?: number } | undefined): string {
  if (!entry) return t('iotUi.notListening')
  if (!entry.listening) return t('iotUi.notListening')
  return t('iotUi.listening', {
    address: ingest.status?.config.bindAddress ?? '',
    port: entry.port ?? 0
  })
}

/** 「最近一条」：从没收到过时说"从未"，而不是一个空值或 1970 年。 */
const iotLastAtText = computed(() => {
  const at = ingest.status?.stats.lastAt
  return at ? formatDateTime(at) : t('iotUi.statsNever')
})

/** 把草稿灌成当前值（进对话框、以及保存成功后都走这里）。 */
function seedIotDraft(): void {
  const current = iotCurrent.value
  if (!current) return
  iotDraft.value = {
    bindAddress: current.bindAddress,
    httpPort: current.httpPort,
    mqttPort: current.mqttPort
  }
}

async function reloadIngest(): Promise<void> {
  await ingest.load()
  seedIotDraft()
}

/**
 * 保存监听设置。
 *
 * 三条判断都写在这里，因为它们是"写本机监听"这件事的一部分：
 *   1. 判据用**共享层**的 `isBindAddress` / `isPort`（与主进程归一化器同一份）——
 *      界面允许写进去、主进程却回落到默认值，是这类设置最坏的一种失败；
 *   2. 发的是**整份** `IotIngestConfig`（契约如此），enabled 那三个键从当前值原样带回；
 *   3. 保存后**重读**一次状态（`ingest.load()`）并核对草稿与落库值一致 —— 写后读回。
 */
async function saveIotSettings(): Promise<void> {
  iotNotice.value = ''
  iotError.value = ''
  const current = iotCurrent.value
  if (!current) {
    iotError.value = t('iotUi.saveFailed')
    return
  }
  const bind = iotDraft.value.bindAddress.trim()
  if (!isBindAddress(bind)) {
    iotError.value = t('iotUi.errBind')
    return
  }
  const httpPort = Number(iotDraft.value.httpPort)
  const mqttPort = Number(iotDraft.value.mqttPort)
  if (!isPort(httpPort) || !isPort(mqttPort)) {
    iotError.value = t('iotUi.errPort')
    return
  }

  iotSaving.value = true
  const saved = await settings.update({
    iotIngest: { ...current, bindAddress: bind, httpPort, mqttPort }
  })
  iotSaving.value = false
  if (!saved) {
    iotError.value = settings.error || t('iotUi.saveFailed')
    return
  }
  await reloadIngest()
  const applied = iotCurrent.value
  if (!applied || applied.bindAddress !== bind || applied.httpPort !== httpPort ||
      applied.mqttPort !== mqttPort) {
    // 读回来的与刚写的不一样：以读回来的为准，并如实说出来。
    iotError.value = t('iotUi.saveMismatch')
    return
  }
  iotNotice.value = t('iotUi.saveDone', { port: httpPort })
}

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

/** Simple IPv4 / hostname validation; the main process validates again.（IP 地址模式专用） */
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
  // 收起状态也回到出厂默认（业主第 13 批第 2 条：默认收起）。
  installationOpen.value = false
  // 接入方式回到出厂默认：IP 地址（不接入推流）。
  accessMethod.value = 'ip'
  // 接入方式与接口清单同样回到出厂默认（四个规范键 + video_url）。
  metricKeys.value = defaultIngestMetricKeys()
  videoKey.value = DEFAULT_INGEST_VIDEO_KEY
  resetProbe()
}

/**
 * 切到 HTTP/MQTT：GIS 信息**默认展开**（业主 20260921 第 12 条 —— 对一台推送设备来说
 * "装在哪"是主信息，不该藏进默认收起的折叠块里），并作废可能存在的探活结果
 * （探活说的是 IP 那一档的事，不能把两份模式的预览混在一起）。
 */
watch(
  () => accessMethod.value,
  (method) => {
    if (method !== 'ip') {
      installationOpen.value = true
      resetProbe()
    }
  }
)

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
  /*
   * 校验按接入方式分两套（业主 20260921 第 12 条）：
   *   - IP 地址模式：地址 + 端口 + 凭据（原流程）；
   *   - HTTP/MQTT 模式：**名称必填**（推送设备没有设备侧名字可读），地址与凭据不存在。
   */
  if (pushMode.value) {
    if (!form.name.trim()) {
      formError.value = t('addDeviceUi.deviceNameRequired')
      return
    }
  } else {
    const validation = validate()
    if (validation) {
      formError.value = validation
      return
    }
  }
  const installationProblem = installationValidation()
  if (installationProblem) {
    formError.value = installationProblem
    return
  }
  /*
   * 接入方案：**选了 HTTP/MQTT 就必须是一份合法方案**（键名形状、四个指标不重复）。
   * 这一步是界面上的即时校验；主进程会在写库之前再判一次（IPC 能被直接调用）。
   */
  if (ingestProtocol.value !== 'none' && planProblems.value.length > 0) {
    formError.value = t('addDeviceUi.protocolPlanInvalid')
    return
  }
  formError.value = ''
  adding.value = true
  const parsed = parseInstallation(form.installation)
  const device = await devices.add({
    // HTTP/MQTT 模式没有这四个输入框 —— 推送设备地址落 NULL、凭据不存（主进程口径）。
    ip: pushMode.value ? '' : form.ip.trim(),
    httpPort: pushMode.value ? 80 : Number(form.httpPort),
    username: pushMode.value ? '' : form.username.trim(),
    password: pushMode.value ? '' : form.password,
    // 名称只有推送模式才发（IP 模式的名字来自设备自己）。
    ...(pushMode.value ? { name: form.name.trim() } : {}),
    // 只有**真的填了东西**才带上这一组：四项全空时不写 installation，
    // 免得库里出现一个"录过安装信息但四项都空"的假象。
    ...(hasInstallation(parsed.installation) ? { installation: parsed.installation } : {}),
    /*
     * 接入方案只在不接入之外才发：`none` 是"这台设备不走推流接入"，
     * 而库里那一列的出厂值本来就是它 —— 发一份 `none` 与不发是同一件事。
     * 发了 http/mqtt ⇒ 主进程按纯推送设备（pushDevice）登记，不做 IP 探测。
     */
    ...(ingestProtocol.value === 'none'
      ? {}
      : { ingest: normaliseDeviceIngestPlan(ingestPlan.value) })
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
  /*
   * 添完之后本机的监听状态可能刚变（有设备声明了 HTTP/MQTT 就会起监听），
   * 所以读一次读数 —— 上面那句"监听中/未监听"必须说的是**此刻**的事。
   */
  void ingest.load()
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

/**
 * 打开对话框时读一次接入读数（监听状态那一行）。
 *
 * **只读一次，不轮询**：这一行说的是"此刻本机有没有在听"，而对话框里的操作（选协议）
 * 本身不会立刻改变监听（监听由**设备声明**驱动，要等设备真的进库）。添加成功之后
 * `submit()` 会再读一次。
 */
watch(
  () => props.modelValue,
  (isOpen) => {
    if (isOpen) {
      void ingest.load()
      // 监听设置的草稿从**落库值**灌进来（进对话框时读一次当前设置）。
      void settings.load().then(() => seedIotDraft())
      iotNotice.value = ''
      iotError.value = ''
    }
  },
  { immediate: true }
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
          {{
            addedDevice.kind === 'pushDevice'
              ? t('addDeviceUi.pushDeviceAdded')
              : t('devicesUi.noticeAdded')
          }}
        </p>
        <DevicePushEndpoint :device-id="addedDevice.id" />
      </template>

      <template v-else>
      <!--
        **接入方式**（业主 20260921 第 12 条：添加设备先选接入方式，三选一）。
        IP 地址 = 我们主动去连的设备（地址 + 凭据 + 探活自动识别机型）；HTTP / MQTT =
        纯推送第三方设备（名称必填 + GIS + 推流键，登记为 pushDevice，没有地址与凭据）。
        原来的"协议接入方式"单选（不接入 / HTTP / MQTT）被这一组取代：'不接入'消失，
        IP 地址就是"不接入推流"。
      -->
      <section class="protocol" data-add-access-method>
        <span class="field-label">{{ t('addDeviceUi.accessMethod') }}</span>
        <div class="protocol__choices" role="radiogroup" :aria-label="t('addDeviceUi.accessMethod')">
          <label v-for="option in ACCESS_METHODS" :key="option" class="protocol__choice">
            <input
              v-model="accessMethod"
              type="radio"
              name="access-method"
              :value="option"
              :data-access-method="option"
            />
            <span>{{ t(ACCESS_METHOD_LABEL_KEYS[option]) }}</span>
          </label>
        </div>
      </section>

      <!--
        **不让人选机型**（业主 2026-09-17 第 2 条）：协议由主进程按地址自动匹配。
        为什么这比"选一张机型卡"更好：选错家系的表现是"设备没响应"，而那是**网络故障的样子** ——
        操作员会去查网线，而不是回头看自己选错了哪张卡。自动识别把这件事从"用户的判断题"
        变成"软件的判断题"，并且识别结果**当面说出来**（下面那行提示）。
        这一段（连同四个地址/凭据输入）只属于 IP 地址模式；HTTP/MQTT 模式没有"问设备"这一步。
      -->
      <template v-if="accessMethod === 'ip'">
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
      </template>

      <!--
        HTTP/MQTT 模式（业主 20260921 第 12 条）：**名称必填** —— 推送设备没有设备侧名字可读，
        也没有地址/凭据输入框（那两栏对一台"我们够不到、它推上来"的设备没有意义）。
      -->
      <template v-else>
        <p class="add__lead">{{ t('addDeviceUi.ingestModeHint') }}</p>

        <div class="form-grid">
          <label class="field">
            <span class="field-label">{{ t('devices.name') }}</span>
            <input
              v-model="form.name"
              data-autofocus
              class="input"
              type="text"
              autocomplete="off"
              spellcheck="false"
            />
          </label>
        </div>
      </template>

      <!--
        **地址信息**（业主 2026-09-18 第 7 / 10 条）：原「安装信息」，去掉基准声压级。
        **与机型无关地一直存在**：机型是自动识别的，而"探活之前不让填点位"会让没有凭据时
        完全录不进地址信息。经纬度与方位角都可空；声源定位设备（Air Sonar / SN-16）才需要填。

        **默认收起**（业主 2026-09-19 第 13 批第 2 条：「添加设备里面， 地址信息这个按钮
        默认是收起来的」）—— **IP 地址模式**如此：它是一件可选的事，摊开会把主路径挤下去。
        HTTP/MQTT 模式相反（业主 20260921 第 12 条）：GIS 是这台设备的主信息，**默认展开**。
        收起时那一行仍然说得清"这是什么、现在填没填"，展开靠那颗按钮（`aria-expanded`）。
      -->
      <section class="collapse" data-add-installation>
        <button
          type="button"
          class="collapse__head"
          data-action="toggle-add-installation"
          :aria-expanded="installationOpen"
          aria-controls="add-installation-body"
          @click="installationOpen = !installationOpen"
        >
          <span class="collapse__caret" aria-hidden="true">{{ installationOpen ? '▾' : '▸' }}</span>
          <!--
            折叠头文案按接入方式分两种（业主 20260921 第 12 条）：IP 地址模式它叫
            「更多（GIS）信息」（addDeviceUi.moreGis）—— 是主路径之外的可选信息；
            HTTP/MQTT 模式 GIS 是主信息，沿用「地址信息」（installUi.section）。
          -->
          <span class="field-label">
            {{ accessMethod === 'ip' ? t('addDeviceUi.moreGis') : t('installUi.section') }}
          </span>
          <span class="muted collapse__summary">
            {{ installationSummary }}
          </span>
        </button>
        <div v-if="installationOpen" id="add-installation-body" class="install">
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
          <div class="form-actions">
            <button
              type="button"
              class="btn btn--sm"
              data-action="pick-device-point"
              @click="mapPickerOpen = true"
            >
              {{ t('mapPickerUi.pickButton') }}
            </button>
          </div>
        </div>
      </section>

      <MapPointPicker
        :open="mapPickerOpen"
        :latitude="coordinateInput(form.installation.gisLatitude)"
        :longitude="coordinateInput(form.installation.gisLongitude)"
        @close="mapPickerOpen = false"
        @pick="onMapPointPicked"
      />

      <!--
        **推流接入**（业主 20260921 第 12 条：这一块只在 HTTP/MQTT 模式出现；IP 地址模式
        "不含任何推流/协议块"）。协议档位本身由上面的「接入方式」单选决定（HTTP 或 MQTT），
        这里配的是这台设备会推哪些遥测值：

          · **数据流接口**：四个可显示的指标（声压级 / 主频 / 平稳度 / 频带能量比）各由**哪个键**
            送来 —— 默认就是别名表里那几个规范名（现场设备用别的写法时才需要改）；
          · **视频流接口**：哪一个键装的是视频地址（默认 `video_url`，留空 = 这台设备不推视频）；
          · 本机的监听状态**如实显示**（监听中 / 未监听 + 原因），端口在下面的「本机接入」里改。

        **秘钥与遥测地址在添加成功之后显示**（上面那一块 `DevicePushEndpoint`）：秘钥是**这台设备的**、
        由主进程生成并读回核对，所以在设备进库之前没有它可以显示的东西 —— 提前"预生成"一个
        只会给出一串还没生效的字符。
      -->
      <section v-if="pushMode" class="protocol" data-add-protocol>
        <span class="field-label">{{ t(ACCESS_METHOD_LABEL_KEYS[accessMethod]) }}</span>
        <p class="field-hint">{{ t('addDeviceUi.protocolHint') }}</p>

        <p class="field-hint" data-iot-listen-status>
          {{ listenStatusText }}
        </p>

        <div class="protocol__keys">
          <span class="field-label">{{ t('addDeviceUi.metricKeysTitle') }}</span>
          <p class="field-hint">{{ t('addDeviceUi.metricKeysHint') }}</p>
          <label v-for="row in metricKeys" :key="row.metric" class="field protocol__row">
            <span class="field-label">{{ t(METRIC_LABEL_KEYS[row.metric]) }}</span>
            <input
              v-model="row.key"
              class="input mono"
              type="text"
              spellcheck="false"
              autocomplete="off"
              :data-iot-metric-key="row.metric"
            />
          </label>
        </div>

        <label class="field protocol__row">
          <span class="field-label">{{ t('addDeviceUi.videoKeyTitle') }}</span>
          <input
            v-model="videoKey"
            class="input mono"
            type="text"
            spellcheck="false"
            autocomplete="off"
            data-iot-video-key
          />
          <span class="field-hint">{{ t('addDeviceUi.videoKeyHint') }}</span>
        </label>

        <p v-if="planProblems.length > 0" class="alert alert--warning" role="alert" data-iot-plan-problem>
          {{ t('addDeviceUi.protocolPlanInvalid') }}
        </p>

        <!--
          本机接入（业主 2026-09-19 第 13 批第 1 条：「系统设置里面的数据接入，应该是在设备管理的
          添加设备功能里面」）。

          这一块原来在**系统设置 → 数据接入**那个页签里，整页随这一次改造删掉了。搬到这里的三件
          东西按"谁在什么时候需要它"排：
            · 监听设置（绑定地址 / 两个端口）—— 选完接入方式就要知道"本机在哪个口上等"；
            · 监听状态（是不是真的起来了、起不来是什么原因）—— 填进设备之前必须看见；
            · 收数统计（收到几条、被拒几条、写进趋势几行、最近一条是什么时候、哪些键不认识）——
              设备接上之后回来核对"到底通没通"。
          **总开关与两个通道开关不在这里**：它们由**设备声明**派生（库里有没有设备声明 http/mqtt），
          所以这一块只把它们**显示**出来（只读），不让操作员拨 —— 拨了也会被下一次设备变更覆盖。
          用原生 `<details>` 折叠：它们是"配好之后偶尔回来看一眼"的东西，不该占着对话框的主路径。
        -->
        <details class="iot-local" data-add-iot-local :open="iotLocalOpen">
          <summary @click.prevent="iotLocalOpen = !iotLocalOpen">
            {{ t('addDeviceUi.localIngestTitle') }}
          </summary>

          <p class="field-hint">{{ t('addDeviceUi.localIngestHint') }}</p>

          <!-- 派生的三个开关：只读显示（说的是事实，不是一个可以被改掉的选项）。 -->
          <p class="field-hint" data-iot-derived-flags>
            {{
              t('addDeviceUi.localIngestDerived', {
                master: ingestEnabledText,
                http: ingestChannelText(ingest.status?.config.httpEnabled),
                mqtt: ingestChannelText(ingest.status?.config.mqttEnabled)
              })
            }}
          </p>

          <div class="form-grid">
            <label class="field">
              <span class="field-label">{{ t('iotUi.bindLabel') }}</span>
              <input
                v-model="iotDraft.bindAddress"
                class="input mono"
                type="text"
                spellcheck="false"
                data-add-iot-bind
              />
              <span class="field-hint">{{ t('iotUi.bindHint') }}</span>
            </label>
            <label class="field">
              <span class="field-label">{{ t('iotUi.httpPortLabel') }}</span>
              <input
                v-model.number="iotDraft.httpPort"
                class="input"
                type="number"
                min="1"
                max="65535"
                data-add-iot-http-port
              />
            </label>
            <label class="field">
              <span class="field-label">{{ t('iotUi.mqttPortLabel') }}</span>
              <input
                v-model.number="iotDraft.mqttPort"
                class="input"
                type="number"
                min="1"
                max="65535"
                data-add-iot-mqtt-port
              />
            </label>
          </div>

          <p v-if="iotPortConflict" class="alert alert--warning" role="alert" data-add-iot-conflict>
            {{ t('iotUi.portConflict', { port: iotDraft.httpPort }) }}
          </p>

          <div class="btn-row">
            <button
              type="button"
              class="btn btn--sm"
              :disabled="iotSaving || !iotDirty"
              data-add-iot-save
              @click="saveIotSettings"
            >
              {{ iotSaving ? t('common.saving') : t('addDeviceUi.localIngestSave') }}
            </button>
            <button type="button" class="btn btn--sm" data-add-iot-reload @click="reloadIngest">
              {{ t('common.refresh') }}
            </button>
          </div>
          <p v-if="iotNotice" class="alert alert--success" role="status" data-add-iot-notice>
            {{ iotNotice }}
          </p>
          <p v-if="iotError" class="alert alert--danger" role="alert" data-add-iot-error>
            {{ iotError }}
          </p>

          <dl class="kv">
            <div class="kv__item">
              <dt class="kv__label">{{ t('iotUi.httpGroup') }}</dt>
              <dd class="kv__value" data-add-iot-http-status>
                {{ listenerText(ingest.status?.http) }}
                <span v-if="ingest.status?.http.error" class="text-danger">
                  （{{ ingest.status.http.error }}）
                </span>
              </dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('iotUi.mqttGroup') }}</dt>
              <dd class="kv__value" data-add-iot-mqtt-status>
                {{ listenerText(ingest.status?.mqtt) }}
                <span v-if="ingest.status?.mqtt.error" class="text-danger">
                  （{{ ingest.status.mqtt.error }}）
                </span>
              </dd>
            </div>
          </dl>

          <dl class="kv" data-add-iot-stats>
            <div class="kv__item">
              <dt class="kv__label">{{ t('iotUi.statsRequests') }}</dt>
              <dd class="kv__value">{{ ingest.status?.stats.httpRequests ?? 0 }}</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('iotUi.statsMessages') }}</dt>
              <dd class="kv__value">{{ ingest.status?.stats.mqttMessages ?? 0 }}</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('iotUi.statsRejectedAuth') }}</dt>
              <dd class="kv__value">{{ ingest.status?.stats.rejectedAuth ?? 0 }}</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('iotUi.statsRejectedPayload') }}</dt>
              <dd class="kv__value">{{ ingest.status?.stats.rejectedPayload ?? 0 }}</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('iotUi.statsTrendRows') }}</dt>
              <dd class="kv__value">{{ ingest.status?.stats.trendRows ?? 0 }}</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('iotUi.statsAlarmRows') }}</dt>
              <dd class="kv__value">{{ ingest.status?.stats.alarmRows ?? 0 }}</dd>
            </div>
            <!--
              「最近一条是什么时候」与「本机有哪些地址」是这一块里最常被问的两件事：
              前者回答"它还在推吗"，后者回答"设备该填哪个 IP"。
            -->
            <div class="kv__item">
              <dt class="kv__label">{{ t('iotUi.statsLastAt') }}</dt>
              <dd class="kv__value">{{ iotLastAtText }}</dd>
            </div>
          </dl>

          <p v-if="ingest.status?.stats.lastUnrecognised?.length" class="field-hint" data-add-iot-unrecognised>
            {{ t('iotUi.lastUnrecognised', { keys: ingest.status.stats.lastUnrecognised.join(', ') }) }}
          </p>

          <div class="field">
            <span class="field-label">{{ t('iotUi.localAddressesLabel') }}</span>
            <div v-if="ingest.status?.localAddresses.length" class="iot-addresses">
              <span
                v-for="item in ingest.status.localAddresses"
                :key="item.address"
                class="mono iot-local-address"
              >
                {{ item.address }}（{{ item.iface }}）
              </span>
            </div>
            <span v-else class="field-hint">{{ t('iotUi.noLocalAddresses') }}</span>
          </div>
        </details>
      </section>

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
        <!-- 「测试连接」只对 IP 地址模式有意义（探活要地址与凭据）；推送设备没有可探的地址。 -->
        <button
          v-if="accessMethod === 'ip'"
          type="button"
          class="btn"
          :disabled="probing || adding"
          @click="testConnection"
        >
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

/*
 * 可折叠的一段（业主第 13 批第 2 条：地址信息默认收起）。
 *
 * 用的是 `button` + `v-if` + `aria-expanded`/`aria-controls` 那一套（与告警中心的
 * 「更多筛选」同一做法）：原生 `<details>` 的展开状态没法用探针稳定地读，而且它会把
 * 内容留在 DOM 里 —— 收起时那条路径上的输入框仍然会被 Tab 走到。
 */
.collapse {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}

.collapse__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: 8px 10px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.collapse__head:hover {
  background: var(--color-bg-muted);
}

.collapse__caret {
  color: var(--color-text-secondary);
  font-size: 11px;
}

.collapse__summary {
  margin-left: auto;
  font-size: 11.5px;
}

.install {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: 0 10px 10px;
}

/*
 * 协议接入方式（第 13 批第 3 条）：一整段，放在「地址信息」下方。
 *
 * 它**不是**可折叠的（与地址信息不同）：接入方式是"这台设备怎么把数据送进来"，
 * 属于添加设备这条主路径的一部分；地址信息是可选的（只有声源定位设备才填点位）。
 */
.protocol {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}

.protocol__choices {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
}

.protocol__choice {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  cursor: pointer;
}

.protocol__keys {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--color-border);
}

.protocol__row {
  gap: 2px;
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

/*
 * 「本机接入」那一块（第 13 批第 1 条：数据接入搬进添加设备）。
 *
 * 它是一块**独立的**内容（配好之后偶尔回来看一眼），所以用原生 `<details>` 折叠：
 * 收起时只留一行标题，展开时是监听设置 + 监听状态 + 收数统计。
 */
.iot-local {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-subtle);
}

.iot-local > summary {
  cursor: pointer;
  font-weight: 600;
  font-size: 12.5px;
}

.iot-local[open] > summary {
  margin-bottom: var(--space-1);
}

/* 本机地址允许折断：一行 "192.168.110.97（以太网）" 在窄对话框里会溢出。 */
.iot-addresses {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.iot-local-address {
  font-size: 12.5px;
  overflow-wrap: anywhere;
}
</style>
