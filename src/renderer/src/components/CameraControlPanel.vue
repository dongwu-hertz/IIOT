<script setup lang="ts">
/**
 * 相机控制与维护面板（HERTZINNO FA371 / `acousticCamera`）。
 *
 * ---------------------------------------------------------------------------
 * 这个面板回答四个问题
 * ---------------------------------------------------------------------------
 *   1. 检测模式现在是什么？能改吗？—— `GET`/`PUT /run_mode`，手册字段名就是
 *      **检测模式**：`1` 单次检测 / `-1` 智能巡航；
 *   2. 这台设备在做**哪种应用**？—— 局部放电 / 气体泄漏 / 机械异响，
 *      `GET`/`PUT /system`（**端点未文档化**，真机实测可读可写，见下面「应用模式」一节）；
 *   3. 检测在跑吗？能开始/停止吗？—— `POST /turn_on_detect` /
 *      `POST /turn_off_detect` + `GET /system/detect_status`；
 *   4. 维护能做什么？—— 版本信息可读（`GET /dev_info` / `GET /basic`），
 *      升级/回滚/重启/恢复出厂设备开放接口里没有，所以是**禁用控件 + 原因**，
 *      旁边留一条真实可用的路：打开设备自带 Web 界面。
 *
 * ---------------------------------------------------------------------------
 * 三条硬规则（这个面板的"为什么长这样"）
 * ---------------------------------------------------------------------------
 * 1) **写后回读，不装作改了**。本设备实测过 `ret:200` 却忽略写入
 *    （`PUT /alarm_strategy {Switch:1}`），所以主进程的写方法返回的是**重读值**
 *    加一个 `applied`。这里显示的是 `after`（设备事实）；`applied === false` 时
 *    明说「设备应答成功但没有生效」，而不是把控件翻到请求值。
 *
 * 2) **能力门槛**：做不到的**不渲染**，暂时做不到的渲染成**禁用 + title 里的原因**。
 *    维护区的升级/回滚/重启/恢复出厂由主进程的能力表逐项给出，面板不自己判断；
 *    「应用模式」那一块同理 —— 端点 `GET /system` **未文档化**，读不到就整块不渲染
 *    （读通道回的 `available: false`），而不是留一个点了必然失败的按钮。
 *
 * 3) **开始检测需要一条启用中的策略**（新手册
 *    `docs/reference/api-workflow.txt` 第 203 行），设备**同时只允许一条**启用，
 *    没有启用时 `POST /turn_on_detect` 会回 `ret:-1`。所以「开始检测」在没有
 *    启用策略时是禁用的，并说明原因，而不是让操作员点了再吃一个失败。
 *
 * 自包含：只依赖 `deviceId`，自带本地状态，不改动 `CameraAcousticPanel` /
 * `CameraAlarmDialog`。所有文案走 `cameraControlUi.*`。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Fa371AlarmStrategy, Fa371DetectStatus, Fa371RunModeConfig, Fa371WorkModeValue } from '@shared/domain/fa371'
import { Fa371RunMode } from '@shared/domain/fa371'
import type {
  CameraDetectActionResult,
  CameraEnabledStrategyView,
  CameraMaintenanceFeature,
  CameraMaintenanceInfo,
  CameraMaintenanceReasonKey,
  CameraRunModeWriteResult,
  CameraWorkModeRead,
  CameraWorkModeWriteResult
} from '@shared/domain/camera-control'
import type {
  CameraRebootResult,
  CameraUpgradePackage,
  CameraUpgradeProgress,
  CameraUpgradeProgressEvent,
  CameraUpgradeUploadResult
} from '@shared/domain/camera-upgrade'
import type {
  CameraModePresetId,
  CameraModePresetRead,
  CameraModePresetWriteResult,
  CameraModeRequestedValues
} from '@shared/domain/camera-mode-preset'
import { CAMERA_BAND_MAX_WIDTH_KHZ, CAMERA_MODE_PRESETS, CAMERA_PRESETS_REJECTED_BY_DEVICE } from '@shared/domain/camera-mode-preset'
import { useSessionStore } from '@renderer/stores/session'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import { formatBytes, formatDuration } from '@renderer/lib/format'
import AppModal from '@renderer/components/AppModal.vue'

/**
 * 面板里的**区块**。业主 2026-09-17（⑨）要求把「升级、维护、告警策略、检测模式」四块
 * 移到设备管理的配置界面，而「检测启停」留在实时监测页（它是**看的时候要按的东西**，
 * 不是配置）。同一份实现被两个页面使用，所以区块由一个 prop 决定 —— 复制成两个组件会让
 * 这两处迟早不一致（而那两处共享同一批 IPC 与同一套"读了要写回"的规矩）。
 */
export type CameraControlSection =
  | 'mode'
  | 'preset'
  | 'detect'
  | 'strategy'
  | 'maintenance'
  | 'upgrade'

/** 默认渲染全部区块（不传 `sections` 时的手感与改造前完全一致）。 */
const ALL_SECTIONS: readonly CameraControlSection[] = [
  'mode',
  'preset',
  'detect',
  'strategy',
  'maintenance',
  'upgrade'
]

const props = defineProps<{
  /** 相机设备 id。面板自己不接触设备，一切都走 IPC。 */
  deviceId: string
  /** 只渲染这几块（不传＝全部）。见 `CameraControlSection`。 */
  sections?: readonly CameraControlSection[]
}>()

const activeSections = computed<readonly CameraControlSection[]>(
  () => props.sections ?? ALL_SECTIONS
)

/** 这一块要不要渲染 / 要不要为它去读设备。**读写共用同一个判据**。 */
function wants(section: CameraControlSection): boolean {
  return activeSections.value.includes(section)
}

const { t } = useI18n()
const session = useSessionStore()

const loading = ref(false)
const busy = ref(false)
const error = ref('')
/** 写操作之后的一句结果（"已生效" / "设备没有接受"），与 error 分开。 */
const outcome = ref('')

const mode = ref<Fa371RunModeConfig | null>(null)
const modeOutcome = ref<CameraRunModeWriteResult | null>(null)
const workModeInfo = ref<CameraWorkModeRead | null>(null)
const workModeOutcome = ref<CameraWorkModeWriteResult | null>(null)
const presetInfo = ref<CameraModePresetRead | null>(null)
const presetOutcome = ref<CameraModePresetWriteResult | null>(null)
const presetRestorable = ref<CameraModeRequestedValues | null>(null)
/** 载入时设备命中的预设。用来判断「已经在这个场景」与「这一趟到底改过什么」。 */
const initialPresetIds = ref<CameraModePresetId[]>([])
const detect = ref<Fa371DetectStatus | null>(null)
const detectActionResult = ref<CameraDetectActionResult | null>(null)
const enabledStrategies = ref<CameraEnabledStrategyView | null>(null)
const strategies = ref<Fa371AlarmStrategy[]>([])
const selectedStrategyId = ref('')
const maintenance = ref<CameraMaintenanceInfo | null>(null)

const canWrite = computed(() => session.isAdmin)

// ---------------------------------------------------------------------------
// 检测模式
// ---------------------------------------------------------------------------

/** 控件只有两态；设备回了别的值时两态都不选中，并把原始值显示出来。 */
const modeValue = computed(() => mode.value?.mode)

const modeRawText = computed(() => {
  const raw = mode.value?.raw
  return raw === undefined ? '' : String(raw)
})

/** 读回值既不是 1 也不是 -1：不猜含义，只把原始数字交给操作员。 */
const modeUnrecognised = computed(() => mode.value !== null && mode.value.raw !== undefined && mode.value.mode === undefined)

/** 写完之后设备实际是什么 —— 界面显示这个，而不是请求值。 */
const modeReadBackText = computed(() => {
  const result = modeOutcome.value
  if (!result) return ''
  const after = result.after
  if (after.mode === Fa371RunMode.SingleDetection) return t('cameraControlUi.modeSingle')
  if (after.mode === Fa371RunMode.IntelligentCruise) return t('cameraControlUi.modeCruise')
  return after.raw === undefined ? t('cameraControlUi.valueUnavailable') : t('cameraControlUi.modeRawValue', { value: after.raw })
})

async function selectMode(next: 1 | -1): Promise<void> {
  if (busy.value || props.deviceId === '') return
  if (mode.value?.mode === next) return
  busy.value = true
  error.value = ''
  outcome.value = ''
  modeOutcome.value = null
  try {
    const result = await callApi(() => window.api.cameraControl.writeRunMode(props.deviceId, next))
    if (!result.success) {
      error.value = resultMessage(result)
      return
    }
    // 权威值：设备写完之后自己说的那个。
    modeOutcome.value = unwrap(result) ?? null
    outcome.value = modeOutcome.value?.applied
      ? t('cameraControlUi.modeApplied')
      : t('cameraControlUi.modeRejected')
  } finally {
    busy.value = false
    // 无论成功还是被忽略，都把设备当前状态重新读一遍（`after` 会覆盖 mode）。
    await load()
  }
}

// ---------------------------------------------------------------------------
// 应用模式（这台设备在做哪种应用：局部放电 / 气体泄漏 / 机械异响）
//
// ⚠ 与上面那块「检测模式」只差一个词，但不是一回事：
//   检测模式 = `GET`/`PUT /run_mode`（手册 §5.1.8，单次检测 / 智能巡航）；
//   应用模式 = `GET`/`PUT /system`（**端点未文档化**，真机实测可读可写）。
// 端点不在任何一份手册里（是设备自带 Web 界面的 bundle 里读出来的），所以这里
// 每一步都按"实测接口"对待：读不到就**不渲染**控件，写完之后显示**重读值**，
// 按钮 title 只陈述这一条事实（`appModeSourceHint`），不写成"已支持"。
//
// 这个控件**只写 `work_mode`**，不碰成像参数（那是下面「应用场景」预设那条通道）。
// ---------------------------------------------------------------------------

const WORK_MODE_KEYS: Record<Fa371WorkModeValue, string> = {
  1: 'cameraControlUi.appModePartialDischarge',
  2: 'cameraControlUi.appModeGasLeak',
  3: 'cameraControlUi.appModeMechanical'
}

/**
 * 能力门：**读到了才渲染**。
 *
 * `/system` 未文档化 —— 换一版固件它可能就不回 `work_mode` 了。一个点了必然失败的
 * 按钮比没有按钮更糟，所以 `available: false` 时这一段整块不出现（与维护区
 * "做不到的不渲染"是同一条规则）。
 */
const workModeAvailable = computed(() => workModeInfo.value?.available === true)

/** 设备当前的应用模式原始值；没读到时为 `undefined`。 */
const workModeRaw = computed(() => workModeInfo.value?.view.raw)

/** 可写入的三个值，顺序由主进程给出（`1`/`2`/`3`）。 */
const workModeSelectable = computed(() => workModeInfo.value?.selectable ?? [])

/** 译名；命中不了就回落到"设备返回 N"（`mapWorkMode` 从不把未知值映射成某个模式）。 */
function workModeText(raw: number | undefined): string {
  if (raw === undefined) return ''
  const key = WORK_MODE_KEYS[raw as Fa371WorkModeValue]
  return key === undefined ? t('cameraControlUi.modeRawValue', { value: raw }) : t(key)
}

/** 读回来认不出的取值：只把原始数字摆出来，不猜它是不是机械异响。 */
const workModeUnknown = computed(
  () => workModeInfo.value !== null && workModeRaw.value !== undefined && workModeInfo.value.view.mode === undefined
)

/** 写完之后设备实际是什么 —— 显示的是重读值，不是请求值。 */
const workModeReadBackText = computed(() => workModeText(workModeOutcome.value?.after.raw))

/**
 * 「切换应用模式」的二次确认。
 *
 * 产品原话：「应该点击后弹窗，切换模式会清空全部的存储数据，是否继续这样的提示。」
 * 所以这里拦住的是**所有三个入口**（局部放电 / 气体泄漏 / 机械异响）—— 它们共用的
 * 唯一写入口是 `selectWorkMode()`，确认框只加在它前面一层。
 *
 * ⚠ 这句提示的**来路**（下一个人不要把它当成一条已验证的设备事实）
 * ---------------------------------------------------------------------------
 * 「切换模式会清空全部的存储数据，是否继续？」是**产品负责人指定**的措辞，本轮
 * 照原话实现（一个字都没有"改进"）。但它**没有**被手册或本项目的实测支持：
 *
 *   1. 手册 `docs/reference/FA371-api-spec.md` 把「切换模式会不会打断正在进行的
 *      检测」明确列为**手册未说明**（undocumented），并没有任何一句说切换模式会
 *      清数据；
 *   2. 手册里唯一一处"删除全部历史数据"说的是**恢复出厂**（Restore），那是另一个
 *      动作、另一条通道；
 *   3. 本项目**实测**到的只有一件事：写 `run_mode` 会清掉**启用策略的指针**
 *      （`docs/FA371-API-DELTA.md` §17）。`work_mode`（本对话框写的这个字段）与
 *      `run_mode` 是两个不同的字段，`work_mode` 是否触发任何清理 —— **未验证**。
 *
 * 也就是说：这句话作为**产品对一个破坏性动作的提醒**是有意的（宁可按最坏情况提示），
 * 但它不是从设备行为推出来的结论。要改这句话，先改产品的要求，不要拿它去反推设备。
 */
const pendingWorkMode = ref<Fa371WorkModeValue | null>(null)

/**
 * 按钮的入口：**只弹确认，不写设备**。
 *
 * 取消（按钮 / Esc / 遮罩都不关，见 `:close-on-overlay="false"`）时把 `pending` 清空，
 * 一个字节都不发给设备。
 */
function requestWorkMode(next: Fa371WorkModeValue): void {
  if (busy.value || props.deviceId === '') return
  // 已经在这个模式上就什么都不做（与 `selectWorkMode` 里的守卫同一条理由）。
  if (workModeRaw.value === next) return
  error.value = ''
  outcome.value = ''
  pendingWorkMode.value = next
}

function cancelWorkMode(): void {
  pendingWorkMode.value = null
}

/** 确认之后才真的写。写的是 `pendingWorkMode` 记下的那个值，不是"当前选中项"。 */
async function confirmWorkMode(): Promise<void> {
  const next = pendingWorkMode.value
  if (next === null) return
  await selectWorkMode(next)
  pendingWorkMode.value = null
}

/**
 * 这次确认要切到哪个模式。
 *
 * 与产品那句话**分开**渲染：要求的正文必须逐字出现，所以目标模式不插进那句话里，
 * 而是单独一行说明（否则操作员只看到"要清数据"，不知道是在切哪个模式）。
 */
const pendingWorkModeText = computed(() =>
  pendingWorkMode.value === null ? '' : workModeText(pendingWorkMode.value)
)

async function selectWorkMode(next: Fa371WorkModeValue): Promise<void> {
  if (busy.value || props.deviceId === '') return
  // 已经在这个模式上就什么都不做：重复写一次等于拿一个无操作去赌一次设备行为。
  if (workModeRaw.value === next) return
  busy.value = true
  error.value = ''
  outcome.value = ''
  workModeOutcome.value = null
  try {
    const result = await callApi(() => window.api.cameraControl.writeWorkMode(props.deviceId, next))
    if (!result.success) {
      error.value = resultMessage(result)
      return
    }
    workModeOutcome.value = unwrap(result) ?? null
    outcome.value = workModeOutcome.value?.applied
      ? t('cameraControlUi.appModeApplied')
      : t('cameraControlUi.appModeRejected')
  } finally {
    busy.value = false
    // 无论生效还是被忽略，都把设备当前状态重新读一遍（`after` 会覆盖读数）。
    await load()
  }
}

// ---------------------------------------------------------------------------
// 应用场景（应用模式预设：局部放电 / 气体泄漏 / 机械异响）
//
// 厂家自己的 Quick Start 把「切换模式」写成**写成像参数**
// （`docs/reference/api-workflow.txt` 第 55–64 行：set the imaging frequency band
// to 20 kHz–40 kHz，`PUT /system/acoustic`）。所以这一块读写的对象就是
// `/system/acoustic` + `/system/image`，按钮上写的就是频带。
//
// 「这台设备在做哪种应用」（`work_mode`）**不在这里**：它是上面那块独立控件的事，
// 端点 `GET`/`PUT /system` **未文档化**（实测可读可写）。两条通道刻意不互相调用 ——
// 切换应用模式不会顺带改写下面这些成像参数。
// ---------------------------------------------------------------------------

const PRESET_HINT_KEYS: Record<CameraModePresetId, string> = {
  partial_discharge: 'cameraControlUi.presetHintPartialDischarge',
  gas_leak: 'cameraControlUi.presetHintGasLeak',
  mechanical: 'cameraControlUi.presetHintMechanical'
}

const PRESET_CITATION_KEYS: Record<CameraModePresetId, string> = {
  partial_discharge: 'cameraControlUi.presetCitationPartialDischarge',
  gas_leak: 'cameraControlUi.presetCitationGasLeak',
  mechanical: 'cameraControlUi.presetCitationMechanical'
}

/** 设备当前的「频带 + 目标数量 + 阈值 + 命中预设」，全部来自一次真实读数。 */
const presetView = computed(() => presetInfo.value?.view ?? null)

const matchedPresetIds = computed(() => presetInfo.value?.matchedPresetIds ?? [])

/**
 * 当前频带。两侧都读到才画成 `20–40 kHz`；只读到一侧只显示那一个数。
 *
 * **不做单位换算**：手册的单位就是 kHz，转换只会在界面上制造第二个真相。
 */
const currentBandText = computed(() => {
  const view = presetView.value
  if (!view) return ''
  const lower = view.lowerKhz
  const upper = view.upperKhz
  if (lower !== undefined && upper !== undefined) return `${lower}–${upper} kHz`
  if (lower !== undefined) return `${lower} kHz`
  if (upper !== undefined) return `${upper} kHz`
  return ''
})

const currentTargetsText = computed(() => presetView.value?.targetCount ?? null)

/**
 * 成像阈值只**显示**，从不写入。
 *
 * 三个模式在手册里的推荐值都是「Set after observing ambient energy」
 * （`practical-guide.txt` 第 366–368 / 449–451 / 523–525 行），所以这里没有
 * 阈值控件，也不给预设编一个值 —— 只把设备现在报的数字摆出来给操作员对照。
 */
const currentThresholdText = computed(() => presetView.value?.energyThreshold ?? null)

const bandUnknownTitle = computed(() =>
  presetView.value && currentBandText.value === '' ? t('cameraControlUi.presetNotRead') : ''
)

const presetDisabledTitle = computed(() => (canWrite.value ? '' : t('cameraControlUi.adminOnlyHint')))

/**
 * 这个预设的频带**设备会直接拒绝**吗？
 *
 * 机械异响的手册推荐值是 2–50 kHz（宽度 48），而设备实测强制宽度 ≤20 kHz，
 * 所以写下去必然得到 `ret:400 Set acousic config error`。手册的值照抄不改
 * （改了就是替厂家编数字），但按钮必须禁用并说明原因 —— 让操作员点一个
 * 注定失败的按钮，比告诉他为什么不能点更糟。
 */
function presetRejectedByDevice(id: CameraModePresetId): boolean {
  return CAMERA_PRESETS_REJECTED_BY_DEVICE.includes(id)
}

/** 禁用原因，写成"多宽 / 上限多少"，因为数字才是操作员需要的东西。 */
function presetRejectedTitle(id: CameraModePresetId): string {
  const band = CAMERA_MODE_PRESETS.find((preset) => preset.id === id)?.values.band
  if (!band) return ''
  return t('cameraControlUi.presetRejectedByDevice', {
    width: band.upperKhz - band.lowerKhz,
    limit: CAMERA_BAND_MAX_WIDTH_KHZ
  })
}

function presetHint(id: CameraModePresetId): string {
  return t(PRESET_HINT_KEYS[id])
}

function presetCitation(id: CameraModePresetId): string {
  return t(PRESET_CITATION_KEYS[id])
}

function presetName(id: CameraModePresetId): string {
  if (id === 'partial_discharge') return t('cameraControlUi.presetPartialDischarge')
  if (id === 'gas_leak') return t('cameraControlUi.presetGasLeak')
  return t('cameraControlUi.presetMechanical')
}

/** 设备现在是不是就是这个预设（读不到字段时服务判 `false`，不猜）。 */
function presetIsCurrent(id: CameraModePresetId): boolean {
  return matchedPresetIds.value.includes(id)
}

/**
 * 「已经在这个场景」只在**载入时**就成立、且此后没有被切走时才显示。
 *
 * 否则操作员点完按钮看到的还是同一句「已在此场景」，就分不清按钮到底有没有生效。
 */
const presetAlreadyIds = computed(() => {
  const current = new Set(matchedPresetIds.value)
  return initialPresetIds.value.filter((id) => current.has(id))
})

function presetAlready(id: CameraModePresetId): boolean {
  return presetAlreadyIds.value.includes(id)
}

/** 写完之后重新读到的频带（权威值），显示在结果那一行。 */
const presetReadBackText = computed(() => {
  const after = presetOutcome.value?.after
  if (!after) return ''
  const lower = after.lowerKhz
  const upper = after.upperKhz
  if (lower === undefined && upper === undefined) return t('cameraControlUi.presetNotRead')
  if (lower !== undefined && upper !== undefined) return `${lower}–${upper} kHz`
  return `${lower ?? upper} kHz`
})

function presetResultText(result: CameraModePresetWriteResult): string {
  if (result.kind === 'restore') {
    return result.applied
      ? t('cameraControlUi.presetRestored')
      : t('cameraControlUi.presetRestoreRejected')
  }
  return result.applied ? t('cameraControlUi.presetApplied') : t('cameraControlUi.presetRejected')
}

/** 从一次写入/还原的返回里取出「这次改了哪些字段」，放弃所有非数值字段。 */
function restorableValues(from: CameraModePresetWriteResult['before']): CameraModeRequestedValues {
  return {
    acoustic: {
      ...(from.lowerKhz !== undefined ? { lowerKhz: from.lowerKhz } : {}),
      ...(from.upperKhz !== undefined ? { upperKhz: from.upperKhz } : {}),
      ...(from.sampleRateRaw !== undefined ? { sampleRateRaw: from.sampleRateRaw } : {})
    },
    imaging: {
      ...(from.targetCount !== undefined ? { targetCount: from.targetCount } : {}),
      ...(from.imagingSensitivity !== undefined
        ? { imagingSensitivity: from.imagingSensitivity }
        : {}),
      ...(from.imagingEnhance !== undefined ? { imagingEnhance: from.imagingEnhance } : {}),
      // 阈值：手册说现场看环境再定，所以预设不写；**还原**时才把设备原来的数字搬回去。
      ...(from.energyThreshold !== undefined ? { energyThreshold: from.energyThreshold } : {})
    }
  }
}

/**
 * 一个还原请求值都没有时（两侧都没读到），不渲染还原按钮：
 * 发一个空请求只会浪费一次往返，服务也会以 VALIDATION_ERROR 拒绝。
 */
function hasAnyValue(values: CameraModeRequestedValues): boolean {
  return Object.keys(values.acoustic).length > 0 || Object.keys(values.imaging).length > 0
}

async function applyPreset(id: CameraModePresetId): Promise<void> {
  if (busy.value || props.deviceId === '') return
  busy.value = true
  error.value = ''
  outcome.value = ''
  presetOutcome.value = null
  try {
    const result = await callApi(() => window.api.cameraControl.applyModePreset(props.deviceId, id))
    if (!result.success) {
      error.value = resultMessage(result)
      return
    }
    const write = unwrap(result)
    if (!write) return
    presetOutcome.value = write
    // 「撤销」写回去的是**写之前读到的设备事实**，不是请求值 —— 请求值只说明我们
    // 想要什么，不说明设备原来是什么。
    presetRestorable.value = restorableValues(write.before)
    outcome.value = presetResultText(write)
  } finally {
    busy.value = false
    await load()
  }
}

/**
 * 把当前场景**再写一遍**。
 *
 * 为什么需要它：设备可能应答 `ret:200` 却没有真的改（本设备有先例），这时重读的
 * 频带仍是旧值 —— 唯一的补救就是照预设再写一次。按钮只在「当前读数不是这个预设」
 * 时出现：读数已经是它的时候再写一遍等于拿一个无操作去赌一次设备行为。
 */
const presetCanReapply = computed(() => {
  const outcomeValue = presetOutcome.value
  if (outcomeValue?.kind !== 'preset' || !outcomeValue.presetId) return false
  if (outcomeValue.applied) return false
  return !presetIsCurrent(outcomeValue.presetId)
})

async function reapplyPreset(): Promise<void> {
  const id = presetOutcome.value?.presetId
  if (id === undefined) return
  await applyPreset(id)
}

/** 撤销：把写之前读到的值写回去。只在确实切过场景、且还有值可写时渲染。 */
const presetCanRestore = computed(() => {
  if (presetOutcome.value === null) return false
  const values = presetRestorable.value
  if (values === null || !hasAnyValue(values)) return false
  if (matchedPresetIds.value.length === 0) return false
  // 设备现在回到载入时那些预设中的某一个 → 已经没东西可撤了。
  return !initialPresetIds.value.some(presetIsCurrent)
})

async function restorePreset(): Promise<void> {
  const values = presetRestorable.value
  if (busy.value || props.deviceId === '' || values === null) return
  busy.value = true
  error.value = ''
  outcome.value = ''
  try {
    const result = await callApi(() =>
      window.api.cameraControl.restoreModeValues(props.deviceId, values)
    )
    if (!result.success) {
      error.value = resultMessage(result)
      return
    }
    const write = unwrap(result)
    if (!write) return
    presetOutcome.value = write
    // 还原值用完之后清掉：再点一次已经没有意义（设备已经在那个值上了）。
    presetRestorable.value = null
    outcome.value = presetResultText(write)
  } finally {
    busy.value = false
    await load()
  }
}

// ---------------------------------------------------------------------------
// 检测启停
// ---------------------------------------------------------------------------

const detecting = computed(() => detect.value?.detecting === true)

/**
 * 没有启用策略时不能开始：设备会回 `ret:-1`。这不是"猜"，
 * 而是手册明确写出来的前提（`api-workflow.txt` 第 203 行）。
 */
const enabledIds = computed(() => enabledStrategies.value?.ids ?? [])

const startDisabledReason = computed(() => {
  if (!canWrite.value) return t('cameraControlUi.adminOnlyHint')
  if (enabledIds.value.length === 0) return t('cameraControlUi.strategyNeedsOne')
  return ''
})

async function detectAction(action: 'turn_on' | 'turn_off'): Promise<void> {
  if (busy.value || props.deviceId === '') return
  busy.value = true
  error.value = ''
  outcome.value = ''
  detectActionResult.value = null
  try {
    const result =
      action === 'turn_on'
        ? await callApi(() => window.api.cameraControl.turnOnDetect(props.deviceId))
        : await callApi(() => window.api.cameraControl.turnOffDetect(props.deviceId))
    if (!result.success) {
      // 设备说"没有可用策略"时，`msg` 原文就藏在这条消息里，照原样显示。
      error.value = resultMessage(result)
      return
    }
    detectActionResult.value = unwrap(result) ?? null
    outcome.value = detectActionResult.value?.applied
      ? t('cameraControlUi.detectApplied')
      : t('cameraControlUi.detectNotApplied')
  } finally {
    busy.value = false
    await load()
  }
}

// ---------------------------------------------------------------------------
// 启用中的告警策略
// ---------------------------------------------------------------------------

/** 读取侧的 id 可能是字符串（§8.3 C21），写入口径只接受正整数。 */
function strategyIdNumber(strategy: Fa371AlarmStrategy): number | undefined {
  const raw = strategy.id
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : undefined
}

const selectedStrategy = computed(() =>
  strategies.value.find((strategy) => strategy.id === selectedStrategyId.value)
)

const selectedIsEnabled = computed(() =>
  selectedStrategyId.value !== '' && enabledIds.value.includes(selectedStrategyId.value)
)

/** 只有「设备上有策略」「id 能当整数用」「有管理员权限」三者都成立时才渲染可点控件。 */
const selectedWritableId = computed(() => {
  const strategy = selectedStrategy.value
  return strategy ? strategyIdNumber(strategy) : undefined
})

const strategyToggleTitle = computed(() => {
  if (!canWrite.value) return t('cameraControlUi.adminOnlyHint')
  if (selectedStrategy.value && selectedWritableId.value === undefined) {
    return t('cameraControlUi.strategyIdUnusable')
  }
  return ''
})

async function toggleStrategy(): Promise<void> {
  const id = selectedWritableId.value
  if (busy.value || id === undefined || props.deviceId === '') return
  busy.value = true
  error.value = ''
  outcome.value = ''
  try {
    const result = await callApi(() =>
      window.api.cameraControl.setStrategyEnabled(props.deviceId, id, !selectedIsEnabled.value)
    )
    if (!result.success) {
      error.value = resultMessage(result)
      return
    }
    const write = unwrap(result)
    if (!write) return
    if (write.disabledPrevious !== undefined) {
      // 手册顺序：设备同时只允许一条启用，所以启用目标前先停用了旧的。
      outcome.value = t('cameraControlUi.strategyDisabledPrevious', { previous: write.disabledPrevious })
    } else {
      outcome.value = write.applied
        ? t('cameraControlUi.strategyApplied')
        : t('cameraControlUi.strategyRejected')
    }
  } finally {
    busy.value = false
    await load()
  }
}

// ---------------------------------------------------------------------------
// 维护
// ---------------------------------------------------------------------------

const REASON_KEYS: Record<CameraMaintenanceReasonKey, string> = {
  not_in_open_interface: 'cameraControlUi.reasonNotInOpenInterface',
  device_offline: 'cameraControlUi.reasonDeviceOffline'
}

/** 能力表按 id 取项；缺项就是不渲染（做不到的不存在）。 */
function feature(id: string): CameraMaintenanceFeature | undefined {
  return maintenance.value?.features.find((item) => item.id === id)
}

function featureReason(id: string): string {
  const item = feature(id)
  if (!item || item.available || !item.reasonKey) return ''
  return t(REASON_KEYS[item.reasonKey])
}

/** 版本字段：设备没回这一项时显示「未读到」，而不是空白。 */
function versionText(value: string | undefined): string {
  return value && value !== '' ? value : t('cameraControlUi.valueUnavailable')
}

const versionUnavailableHint = computed(() =>
  (maintenance.value?.unreadable.length ?? 0) > 0 ? t('cameraControlUi.valueUnavailableHint') : ''
)

async function openWebUi(): Promise<void> {
  error.value = ''
  outcome.value = ''
  const result = await callApi(() => window.api.devices.openWebUi(props.deviceId))
  if (!result.success) {
    error.value = resultMessage(result)
    return
  }
  outcome.value = t('cameraControlUi.webUiOpened')
}

// ---------------------------------------------------------------------------
// 固件升级（设备自带 Web 界面用的那条 HTTP 路：POST /upload + PUT /reboot + GET /progress）
//
// 与上面「维护」那一小段的分工：能力表（`feature('firmware_upgrade')`）回答"这一段
// 该不该出现"，本段回答"这个包是什么、传到哪了"。三件事是本段存在的理由：
//
//   1. **上传与重启是两回事**。上传成功之后这里只说"包已上传、设备尚未升级"，
//      重启由操作员另外确认一次（`CameraUpgradeUploadResult` 里也没有任何"升级完成"
//      的含义）。设备自带前端也是先 `/upload`、再由人点重启。
//   2. **文件名不符合设备规则时上传按钮点不了**，并把设备那条规则的原文放进 title：
//      先传几十 MB 再吃一个"文件名不对"，与设备的规则完全一致地提前拦下来。
//   3. **两个进度不是一个东西**：上传进度是主进程推的真实字节数（百分比可以信），
//      设备自报的 `upgrade_progress` 含义没有文档，所以原样显示、不换算。
// ---------------------------------------------------------------------------

const upgradeAvailable = computed(() => feature('firmware_upgrade')?.available === true)

const upgradePackage = ref<CameraUpgradePackage | null>(null)
/** 选包 / 上传 / 重启 / 读进度四个动作各自的进行中状态（同一时刻只允许一个）。 */
const upgradeBusy = ref<'inspect' | 'upload' | 'reboot' | 'progress' | null>(null)
const upgradeProgress = ref<CameraUpgradeProgressEvent | null>(null)
const upgradeResult = ref<CameraUpgradeUploadResult | null>(null)
const deviceProgress = ref<CameraUpgradeProgress | null>(null)
const rebootResult = ref<CameraRebootResult | null>(null)

/** 二次确认的两种动作：上传（写设备存储）与重启（中断现场一切）。 */
const confirmKind = ref<'upload' | 'reboot' | null>(null)

const uploadProgressPercent = computed(() => upgradeProgress.value?.percent ?? 0)

const uploadProgressText = computed(() =>
  t('cameraUpgradeUi.uploading', { percent: uploadProgressPercent.value })
)

/** 设备自己的文件名规则判定；`false` 时上传按钮禁用。 */
const packageRejected = computed(() => upgradePackage.value?.nameAccepted === false)

/** 上传按钮为什么点不了（空串 = 可以点），放进按钮外层 span 的 title。 */
const uploadDisabledReason = computed(() => {
  if (!canWrite.value) return t('cameraControlUi.adminOnlyHint')
  const pkg = upgradePackage.value
  if (!pkg) return t('cameraUpgradeUi.pick')
  if (!pkg.nameAccepted) return t('cameraUpgradeUi.nameRejected')
  return ''
})

const uploadDisabled = computed(
  () =>
    upgradeBusy.value !== null ||
    !canWrite.value ||
    upgradePackage.value === null ||
    !upgradePackage.value.nameAccepted
)

/** 上传结果那两行。**没有任何"升级完成"的意思**：重启才开始升级。 */
const uploadOutcomeText = computed(() => {
  const result = upgradeResult.value
  if (!result) return ''
  return `${t('cameraUpgradeUi.uploaded')} · ${t('cameraUpgradeUi.uploadDoneAt', {
    duration: formatDuration(result.elapsedMs)
  })}`
})

/** 设备侧进度：设备原样给的那个数，不做换算。 */
const deviceProgressText = computed(() => {
  const progress = deviceProgress.value
  if (!progress) return ''
  return progress.raw === undefined
    ? t('cameraUpgradeUi.deviceProgressNotRead')
    : t('cameraUpgradeUi.deviceProgressValue', { value: progress.raw })
})

const rebootOutcomeText = computed(() => {
  const result = rebootResult.value
  if (!result) return ''
  return result.acknowledged
    ? t('cameraUpgradeUi.rebootAcknowledged')
    : t('cameraUpgradeUi.rebootDropped')
})

/**
 * 确认框的文案键，按 kind 取。
 *
 * 存的是**键**而不是译文：这张表在模块初始化时建好，存译文会把它冻结在启动语言上
 * （与维护卡的 `CONFIRM_KEYS` 同一条理由）。
 */
const CONFIRM_KEYS: Record<'upload' | 'reboot', { title: string; body: string; confirm: string }> = {
  upload: {
    title: 'cameraUpgradeUi.uploadConfirmTitle',
    body: 'cameraUpgradeUi.uploadConfirmBody',
    confirm: 'cameraUpgradeUi.uploadConfirm'
  },
  reboot: {
    title: 'cameraUpgradeUi.rebootConfirmTitle',
    body: 'cameraUpgradeUi.rebootConfirmBody',
    confirm: 'cameraUpgradeUi.rebootConfirm'
  }
}

const confirmInfo = computed(() => {
  const kind = confirmKind.value
  if (!kind) return null
  const keys = CONFIRM_KEYS[kind]
  return {
    title: t(keys.title),
    // 上传的后果里要写出**这个包有多大**：几十 MB 的写入不是一瞬间的事。
    body:
      kind === 'upload'
        ? t(keys.body, { size: formatBytes(upgradePackage.value?.sizeBytes ?? 0) })
        : t(keys.body),
    confirm: t(keys.confirm)
  }
})

async function choosePackage(): Promise<void> {
  if (upgradeBusy.value !== null) return
  error.value = ''
  upgradeBusy.value = 'inspect'
  try {
    const picked = await callApi(() => window.api.cameraUpgrade.pickPackage())
    if (!picked.success) {
      error.value = resultMessage(picked)
      return
    }
    const filePath = unwrap(picked) ?? null
    // 用户取消：已经选好的那个包不动。
    if (!filePath) return

    const inspected = await callApi(() => window.api.cameraUpgrade.inspectPackage(filePath))
    if (!inspected.success) {
      error.value = resultMessage(inspected)
      return
    }
    upgradePackage.value = unwrap(inspected) ?? null
    // 换包就清掉上一次的结果：那一行"已上传"说的是**另一个文件**。
    upgradeResult.value = null
    upgradeProgress.value = null
    outcome.value = ''
  } finally {
    upgradeBusy.value = null
  }
}

async function readDeviceProgress(): Promise<void> {
  if (upgradeBusy.value !== null || props.deviceId === '') return
  error.value = ''
  upgradeBusy.value = 'progress'
  try {
    const result = await callApi(() => window.api.cameraUpgrade.readProgress(props.deviceId))
    if (!result.success) {
      error.value = resultMessage(result)
      return
    }
    deviceProgress.value = unwrap(result) ?? null
  } finally {
    upgradeBusy.value = null
  }
}

function openConfirm(kind: 'upload' | 'reboot'): void {
  if (upgradeBusy.value !== null) return
  error.value = ''
  confirmKind.value = kind
}

function closeConfirm(): void {
  confirmKind.value = null
}

async function confirmPending(): Promise<void> {
  if (confirmKind.value === 'upload') await uploadPackage()
  else if (confirmKind.value === 'reboot') await rebootDevice()
}

async function uploadPackage(): Promise<void> {
  const pkg = upgradePackage.value
  if (upgradeBusy.value !== null || !pkg || !pkg.nameAccepted) return

  error.value = ''
  outcome.value = ''
  upgradeResult.value = null
  upgradeProgress.value = null
  upgradeBusy.value = 'upload'
  try {
    const result = await callApi(() => window.api.cameraUpgrade.upload(props.deviceId, pkg.path))
    if (!result.success) {
      // 失败留在对话框里（卡片上的横幅被遮住了），与维护卡的写法一致。
      error.value = resultMessage(result)
      return
    }
    upgradeResult.value = unwrap(result) ?? null
    outcome.value = uploadOutcomeText.value
    // **到此为止**：上传不重启设备，重启是下面那个按钮 + 一次确认的事。
    confirmKind.value = null
  } finally {
    upgradeBusy.value = null
  }
}

async function rebootDevice(): Promise<void> {
  if (upgradeBusy.value !== null || props.deviceId === '') return
  error.value = ''
  upgradeBusy.value = 'reboot'
  try {
    const result = await callApi(() => window.api.cameraUpgrade.reboot(props.deviceId))
    if (!result.success) {
      error.value = resultMessage(result)
      return
    }
    rebootResult.value = unwrap(result) ?? null
    outcome.value = rebootOutcomeText.value
    confirmKind.value = null
  } finally {
    upgradeBusy.value = null
  }
}

/**
 * 上传进度订阅。
 *
 * 推的是真实写出的字节数（主进程数出来的），这里只认**自己这台设备**的事件：
 * 同一个窗口可能同时开着别的相机面板。退订在 `onUnmounted` 里做 —— 订阅句柄留在
 * 模块闭包里，不释放会把这份状态留到窗口关闭（见 contract 里的订阅纪律）。
 */
let unsubscribeUpgradeProgress: (() => void) | null = null

onMounted(() => {
  unsubscribeUpgradeProgress = window.events.onCameraUpgradeProgress((event) => {
    if (event.deviceId !== props.deviceId) return
    upgradeProgress.value = event
  })
})

onUnmounted(() => {
  unsubscribeUpgradeProgress?.()
  unsubscribeUpgradeProgress = null
})

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

async function load(): Promise<void> {
  const deviceId = props.deviceId
  if (deviceId === '') return
  loading.value = true
  try {
    /**
     * 只读**这一份实例要渲染的**那几块。
     *
     * 面板现在会被挂三次（实时监测一次、设备管理两次），无条件读七路的话同一批数据会被
     * 拉三遍，而且"这次读的是哪几块"与"屏幕上画的是哪几块"会不一致 —— 一处改了另一处没改，
     * 排查时看起来像设备出了问题。
     */
    const [modeResult, workModeResult, detectResult, enabledResult, listResult, maintenanceResult, presetResult] =
      await Promise.all([
        wants('mode') ? callApi(() => window.api.cameraControl.readRunMode(deviceId)) : null,
        wants('mode') ? callApi(() => window.api.cameraControl.readWorkMode(deviceId)) : null,
        wants('detect') ? callApi(() => window.api.cameraControl.readDetectStatus(deviceId)) : null,
        /**
         * 「启用中的策略」不只是告警策略那一块要的：**检测启停按钮的可用性依赖它**
         * （没有启用策略时设备会回 `ret:-1`，所以开始按钮是禁用的）。
         * 第一版只按 `strategy` 条件化读取，结果实时监测页（只取 detect+preset）拿不到它，
         * 开始按钮就被**永久禁用**了 —— 一个"看起来只是变灰了"的功能性回归。
         */
        wants('strategy') || wants('detect')
          ? callApi(() => window.api.cameraControl.readEnabledStrategy(deviceId))
          : null,
        wants('strategy')
          ? callApi(() => window.api.cameraAlarms.listStrategies(deviceId))
          : null,
        wants('maintenance') || wants('upgrade')
          ? callApi(() => window.api.cameraControl.maintenance(deviceId))
          : null,
        wants('preset') ? callApi(() => window.api.cameraControl.readModePreset(deviceId)) : null
      ])

    if (modeResult?.success) mode.value = unwrap(modeResult) ?? null
    // 应用模式是**未文档化**端点：服务把"读不到"收成 `available:false`（而不是抛错），
    // 这里照收即可，控件据此整块不渲染。真失败（比如设备离线）仍会进下面那份 failures。
    if (workModeResult?.success) workModeInfo.value = unwrap(workModeResult) ?? null
    if (detectResult?.success) detect.value = unwrap(detectResult) ?? null
    if (enabledResult?.success) enabledStrategies.value = unwrap(enabledResult) ?? null
    if (listResult?.success) {
      strategies.value = unwrap(listResult)?.items ?? []
      // 默认选中"当前启用的那条"（如果只有一条就选它），否则第一条。
      const enabled = enabledStrategies.value?.ids ?? []
      const preferred =
        strategies.value.find((strategy) => strategy.id !== undefined && enabled.includes(strategy.id)) ??
        strategies.value[0]
      selectedStrategyId.value = preferred?.id ?? ''
    }
    if (maintenanceResult?.success) maintenance.value = unwrap(maintenanceResult) ?? null
    if (presetResult?.success) {
      const read = unwrap(presetResult)
      presetInfo.value = read ?? null
      if (read) initialPresetIds.value = read.matchedPresetIds
    }

    // 读到的每一路失败都要说出来：静默的半张卡比一句错误更难查。
    // 逐条判断而不是对数组 `.map()`：各路的 `DeviceResult<T>` 的 T 各不相同，
    // 放进一个数组后 `resultMessage` 拿到的会是联合类型，推不出 T。
    const failures: string[] = []
    if (modeResult && !modeResult.success) failures.push(resultMessage(modeResult))
    if (workModeResult && !workModeResult.success) failures.push(resultMessage(workModeResult))
    if (detectResult && !detectResult.success) failures.push(resultMessage(detectResult))
    if (enabledResult && !enabledResult.success) failures.push(resultMessage(enabledResult))
    if (listResult && !listResult.success) failures.push(resultMessage(listResult))
    if (maintenanceResult && !maintenanceResult.success) failures.push(resultMessage(maintenanceResult))
    if (presetResult && !presetResult.success) failures.push(resultMessage(presetResult))
    error.value = [...new Set(failures)].join(' · ')
  } finally {
    loading.value = false
  }
}

onMounted(load)

watch(
  () => props.deviceId,
  async () => {
    modeOutcome.value = null
    workModeOutcome.value = null
    detectActionResult.value = null
    presetOutcome.value = null
    presetRestorable.value = null
    initialPresetIds.value = []
    // 升级这一段的面板状态是**逐设备**的：换一台设备时上一位操作员选的包、
    // 上传结果与设备进度都不再属于这个面板。
    upgradePackage.value = null
    upgradeProgress.value = null
    upgradeResult.value = null
    deviceProgress.value = null
    rebootResult.value = null
    confirmKind.value = null
    upgradeBusy.value = null
    outcome.value = ''
    error.value = ''
    await load()
  }
)
</script>

<template>
  <!--
    `camera-board__panel` 是**给探针用的**标记类：`scripts/video-proof-driver.cjs` 靠它认出
    "这两块就是应当并排的面板"（不然就得靠组件的内部类名去猜）。它不带任何样式，
    只在这一个属性上起作用。
  -->
  <div class="cctl camera-board__panel">
    <section class="card cctl__card">
      <div class="section-header">
        <h3 class="section-title">{{ t('cameraControlUi.title') }}</h3>
        <button type="button" class="btn btn--sm" :disabled="loading" @click="load">
          {{ t('cameraControlUi.refresh') }}
        </button>
      </div>

      <p v-if="error" class="alert alert--danger" role="alert">{{ error }}</p>
      <p v-if="outcome" class="alert alert--warning" role="status">{{ outcome }}</p>

      <!--
        排布（本轮只改排布，控件本身一个都没动）
        ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
        原来七行是一根竖列，1440px 以上的窗口右半边全空着。现在把七行按**它们管什么**
        分成四块，放进一个自适应列数的板子里（`.cctl__board`，`auto-fit` + 最小列宽）：

          检测        检测模式 / 应用模式 / 应用场景 / 检测启停
          告警策略    哪条策略启用中 + 启用·停用
          维护        版本信息 + 打开 Web 界面 / 回滚 / 恢复出厂（禁用）
          固件升级    只有能力表说可用时才出现（整块能力门，原样保留）

        分块的依据是面板自己的职责边界（见文件头）：**检测**是"设备在做什么"，
        **告警策略**是"哪条策略在管这件事"，**维护/固件升级**是"设备本身怎么了"。
        板子的列数是 `auto-fit` 算出来的，不是写死的：宽窗口并排，窄窗口自动落回一列，
        所以「自适应窗口大小」与「用掉可用宽度」是同一个 CSS 实现的结果，没有断点、
        没有居中、也没有定宽列。
      -->
      <div class="cctl__board">
      <!-- ================= 检测 ================= -->
      <section v-if="wants('mode') || wants('preset') || wants('detect')" class="card cctl__card cctl__section">
        <h4 class="cctl__label cctl__section-title">{{ t('cameraControlUi.modeTitle') }}</h4>

      <!-- ---- 检测模式（⑨ 之后只在设备管理里渲染） --------------------- -->
      <div v-if="wants('mode')" class="cctl__row">
        <span class="cctl__label">{{ t('cameraControlUi.modeTitle') }}</span>
        <div class="cctl__modes">
          <button
            type="button"
            class="btn btn--sm"
            :class="{ 'btn--primary': modeValue === 1 }"
            :disabled="busy || !canWrite"
            :title="canWrite ? '' : t('cameraControlUi.adminOnlyHint')"
            @click="selectMode(1)"
          >
            {{ t('cameraControlUi.modeSingle') }}
          </button>
          <button
            type="button"
            class="btn btn--sm"
            :class="{ 'btn--primary': modeValue === -1 }"
            :disabled="busy || !canWrite"
            :title="canWrite ? '' : t('cameraControlUi.adminOnlyHint')"
            @click="selectMode(-1)"
          >
            {{ t('cameraControlUi.modeCruise') }}
          </button>
        </div>
        <span v-if="modeUnrecognised" class="cctl__meta" :title="t('cameraControlUi.modeUnknownHint')">
          {{ t('cameraControlUi.modeRawValue', { value: modeRawText }) }}
        </span>
      </div>
      <p v-if="modeOutcome" class="cctl__meta" :class="{ 'cctl__meta--warn': !modeOutcome.applied }">
        {{ t('cameraControlUi.modeReadBack', { value: modeReadBackText }) }}
      </p>

      <!-- ---- 应用模式（这台设备在做哪种应用） -------------------------- -->
      <!-- 整块由能力门控制：`/system` 未文档化，读不到就不渲染。它属于"检测模式"那一块。 -->
      <template v-if="wants('mode') && workModeAvailable">
        <div class="cctl__row">
          <!-- title 只陈述一条事实：这个端点未见于设备手册。不写成"已支持"。 -->
          <span class="cctl__label" :title="t('cameraControlUi.appModeSourceHint')">
            {{ t('cameraControlUi.appModeTitle') }}
          </span>
          <div class="cctl__modes">
            <button
              v-for="value in workModeSelectable"
              :key="value"
              type="button"
              class="btn btn--sm"
              :class="{ 'btn--primary': workModeRaw === value }"
              :disabled="busy || !canWrite"
              :title="canWrite ? '' : t('cameraControlUi.adminOnlyHint')"
              @click="requestWorkMode(value)"
            >
              {{ workModeText(value) }}
            </button>
          </div>
          <span
            v-if="workModeRaw !== undefined"
            class="cctl__meta"
            :class="{ 'cctl__meta--warn': workModeUnknown }"
            :title="workModeUnknown ? t('cameraControlUi.appModeUnknownHint') : ''"
          >
            {{ t('cameraControlUi.appModeCurrent') }}: {{ workModeText(workModeRaw) }}
          </span>
        </div>
        <p
          v-if="workModeOutcome"
          class="cctl__meta"
          :class="{ 'cctl__meta--warn': !workModeOutcome.applied }"
        >
          {{ t('cameraControlUi.modeReadBack', { value: workModeReadBackText }) }}
        </p>
      </template>

      <!-- ---- 应用场景（应用模式预设） -------------------------------- -->
      <div v-if="wants('preset')" class="cctl__row">
        <span class="cctl__label">{{ t('cameraControlUi.presetTitle') }}</span>
        <span class="cctl__meta" :title="bandUnknownTitle">
          {{ t('cameraControlUi.presetCurrentBand') }}:
          {{ currentBandText === '' ? t('cameraControlUi.presetNotRead') : currentBandText }}
        </span>
        <span class="cctl__meta" :title="t('cameraControlUi.presetTargetsUnchanged')">
          {{ t('cameraControlUi.presetCurrentTargets') }}:
          {{ currentTargetsText === null ? t('cameraControlUi.presetNotRead') : currentTargetsText }}
        </span>
        <span class="cctl__meta">
          {{ t('cameraControlUi.presetCurrentThreshold') }}:
          {{ currentThresholdText === null ? t('cameraControlUi.presetNotRead') : currentThresholdText }}
        </span>
      </div>
      <div v-if="wants('preset')" class="cctl__presets">
        <span
          v-for="preset in CAMERA_MODE_PRESETS"
          :key="preset.id"
          :title="
            presetRejectedByDevice(preset.id)
              ? presetRejectedTitle(preset.id)
              : presetCitation(preset.id)
          "
        >
          <button
            type="button"
            class="btn btn--sm"
            :class="{ 'btn--primary': presetIsCurrent(preset.id) }"
            :disabled="busy || !canWrite || presetRejectedByDevice(preset.id)"
            @click="applyPreset(preset.id)"
          >
            {{ presetHint(preset.id) }}
          </button>
          <span
            v-if="presetRejectedByDevice(preset.id)"
            class="cctl__meta cctl__meta--warn"
          >
            {{ t('cameraControlUi.presetRejectedBadge') }}
          </span>
          <span v-else-if="presetAlready(preset.id)" class="cctl__meta cctl__meta--ok">
            {{ t('cameraControlUi.presetAlready') }}
          </span>
        </span>
        <span v-if="presetCanRestore" :title="t('cameraControlUi.presetRestore')">
          <button type="button" class="btn btn--sm" :disabled="busy || !canWrite" @click="restorePreset">
            {{ t('cameraControlUi.presetRestore') }}
          </button>
        </span>
        <span v-if="presetDisabledTitle" :title="presetDisabledTitle">
          <button type="button" class="btn btn--sm" disabled>
            {{ t('cameraControlUi.presetApply') }}
          </button>
        </span>
      </div>
      <p v-if="wants('preset')" class="cctl__meta">{{ t('cameraControlUi.adminOnlyHint') }}</p>
      <p
        v-if="wants('preset') && (presetAlreadyIds.length > 0 || presetOutcome)"
        class="cctl__meta"
        :class="{ 'cctl__meta--warn': presetOutcome !== null && !presetOutcome.applied }"
      >
        <template v-if="presetAlreadyIds.length > 0">
          {{ t('cameraControlUi.presetAlready') }}:
          {{ presetAlreadyIds.map(presetName).join(' · ') }}
        </template>
        <template v-if="presetOutcome">
          {{ presetResultText(presetOutcome) }} ·
          {{ t('cameraControlUi.presetReadBack', { band: presetReadBackText }) }}
        </template>
      </p>
      <div v-if="wants('preset') && presetCanReapply" class="btn-row">
        <button type="button" class="btn btn--sm" :disabled="busy || !canWrite" @click="reapplyPreset">
          {{ t('cameraControlUi.presetApply') }}
        </button>
      </div>

      <!-- ---- 检测启停（**留在实时监测页**：它是看的时候要按的东西） ----- -->
      <template v-if="wants('detect')">
      <div class="cctl__row">
        <span class="cctl__label">{{ t('cameraControlUi.detectTitle') }}</span>
        <span
          class="badge"
          :class="{ 'badge--success': detecting }"
          :title="t('cameraControlUi.detectRetentionHint')"
        >
          {{ detecting ? t('cameraControlUi.detectRunning') : t('cameraControlUi.detectStopped') }}
        </span>
        <span v-if="detectActionResult?.detectId !== undefined" class="cctl__meta">
          {{ t('cameraControlUi.detectRecord', { id: detectActionResult.detectId }) }}
        </span>
      </div>
      <div class="btn-row">
        <span :title="startDisabledReason">
          <button
            type="button"
            class="btn btn--sm btn--primary"
            :disabled="busy || !canWrite || enabledIds.length === 0 || detecting"
            @click="detectAction('turn_on')"
          >
            {{ t('cameraControlUi.detectStart') }}
          </button>
        </span>
        <button
          type="button"
          class="btn btn--sm"
          :disabled="busy || !canWrite || !detecting"
          :title="canWrite ? t('cameraControlUi.detectStopHint') : t('cameraControlUi.adminOnlyHint')"
          @click="detectAction('turn_off')"
        >
          {{ t('cameraControlUi.detectStop') }}
        </button>
      </div>
      </template>
      </section>

      <!-- ================= 告警策略 ================= -->
      <section v-if="wants('strategy')" class="card cctl__card cctl__section">
        <h4 class="cctl__label cctl__section-title">{{ t('cameraControlUi.strategyTitle') }}</h4>

      <!-- ---- 启用中的告警策略 ---------------------------------------- -->
      <div class="cctl__row">
        <span class="cctl__label" :title="t('cameraControlUi.strategyPeriodHint')">
          {{ t('cameraControlUi.strategyTitle') }}
        </span>
        <span v-if="enabledIds.length === 0" class="cctl__meta cctl__meta--warn">
          {{ t('cameraControlUi.strategyNoneEnabled') }}
        </span>
        <span v-else class="badge badge--success">{{ t('cameraControlUi.strategyEnabled') }}</span>
      </div>
      <div v-if="strategies.length > 0" class="cctl__row">
        <select v-model="selectedStrategyId" class="select" :disabled="busy">
          <option v-for="strategy in strategies" :key="strategy.id" :value="strategy.id">
            {{ strategy.name || strategy.alias || strategy.id }}
          </option>
        </select>
        <span :title="strategyToggleTitle">
          <button
            type="button"
            class="btn btn--sm"
            :disabled="busy || !canWrite || selectedWritableId === undefined"
            @click="toggleStrategy"
          >
            {{ selectedIsEnabled ? t('cameraControlUi.strategyDisable') : t('cameraControlUi.strategyEnable') }}
          </button>
        </span>
      </div>
      <p v-else class="cctl__meta">{{ t('cameraControlUi.strategyNoItems') }}</p>
      </section>

      <!-- ================= 维护 ================= -->
      <section v-if="wants('maintenance')" class="card cctl__card cctl__section">
        <h4 class="cctl__label cctl__section-title">{{ t('cameraControlUi.maintenanceTitle') }}</h4>

      <!-- ---- 维护 ---------------------------------------------------- -->
      <dl class="cctl__info">
        <dt>{{ t('cameraControlUi.firmwareVersion') }}</dt>
        <dd :title="versionUnavailableHint">
          {{ versionText(maintenance?.version.firmwareVersion) }}
        </dd>
        <dt>{{ t('cameraControlUi.sdkVersion') }}</dt>
        <dd :title="versionUnavailableHint">{{ versionText(maintenance?.version.sdkVersion) }}</dd>
        <dt>{{ t('cameraControlUi.webVersion') }}</dt>
        <dd :title="versionUnavailableHint">{{ versionText(maintenance?.version.webVersion) }}</dd>
        <dt>{{ t('cameraControlUi.lastUpgrade') }}</dt>
        <dd :title="versionUnavailableHint">{{ versionText(maintenance?.version.lastUpgradeTime) }}</dd>
      </dl>

      <div class="btn-row">
        <span :title="featureReason('device_web_ui')">
          <button
            type="button"
            class="btn btn--sm btn--primary"
            :disabled="feature('device_web_ui')?.available !== true"
            @click="openWebUi"
          >
            {{ t('cameraControlUi.openWebUi') }}
          </button>
        </span>
        <span v-if="feature('rollback')" :title="featureReason('rollback')">
          <button type="button" class="btn btn--sm" disabled>
            {{ t('cameraControlUi.rollback') }}
          </button>
        </span>
        <span v-if="feature('factory_reset')" :title="featureReason('factory_reset')">
          <button type="button" class="btn btn--sm" disabled>
            {{ t('cameraControlUi.factoryReset') }}
          </button>
        </span>
      </div>
      </section>

      <!-- ================= 固件升级 ================= -->
      <section v-if="wants('upgrade') && upgradeAvailable" class="card cctl__card cctl__section">
        <h4 class="cctl__label cctl__section-title">{{ t('cameraUpgradeUi.title') }}</h4>

      <!-- ---- 固件升级（设备自带 Web 界面用的那条 HTTP 路） -------------- -->
      <!--
        能力门：能力表里没有 `firmware_upgrade`（或它不可用）时整块不出现 ——
        与上面「应用模式」是同一条规则（暂时做不到的禁用 + title 原因，根本不存在的
        不渲染）。这一段**只在设备在线时**出现，因为升级要连设备传几十 MB。
      -->
      <div class="cctl__row">
        <span class="cctl__label" :title="t('cameraUpgradeUi.sourceHint')">
          {{ t('cameraUpgradeUi.title') }}
        </span>
          <button
            type="button"
            class="btn btn--sm"
            :disabled="upgradeBusy !== null"
            @click="choosePackage"
          >
            {{ upgradePackage ? t('cameraUpgradeUi.repick') : t('cameraUpgradeUi.pick') }}
          </button>
          <span :title="uploadDisabledReason">
            <button
              type="button"
              class="btn btn--sm btn--primary"
              :disabled="uploadDisabled"
              @click="openConfirm('upload')"
            >
              {{ upgradeBusy === 'upload' ? uploadProgressText : t('cameraUpgradeUi.upload') }}
            </button>
          </span>
          <!-- 重启**独立**于上传：只有它会让设备开始升级，因此单独一次确认。 -->
          <span :title="featureReason('reboot')">
            <button
              type="button"
              class="btn btn--sm"
              :class="{ 'btn--danger': upgradeResult !== null }"
              :disabled="upgradeBusy !== null || !canWrite || feature('reboot')?.available !== true"
              @click="openConfirm('reboot')"
            >
              {{ upgradeBusy === 'reboot' ? t('cameraUpgradeUi.rebooting') : t('cameraUpgradeUi.reboot') }}
            </button>
          </span>
          <button
            type="button"
            class="btn btn--sm"
            :disabled="upgradeBusy !== null"
            :title="t('cameraUpgradeUi.deviceProgressUnknown')"
            @click="readDeviceProgress"
          >
            {{ t('cameraUpgradeUi.deviceProgressRead') }}
          </button>
        </div>

        <dl v-if="upgradePackage" class="cctl__info">
          <dt>{{ t('cameraUpgradeUi.packageFile') }}</dt>
          <dd class="mono">{{ upgradePackage.fileName }}</dd>
          <dt>{{ t('cameraUpgradeUi.packageSize') }}</dt>
          <dd>{{ formatBytes(upgradePackage.sizeBytes) }}</dd>
          <dt :title="t('cameraUpgradeUi.sha256Hint')">{{ t('cameraUpgradeUi.packageSha256') }}</dt>
          <dd class="mono cctl__sha">{{ upgradePackage.sha256 }}</dd>
          <dt>{{ t('cameraUpgradeUi.packageSuffix') }}</dt>
          <dd class="mono">{{ upgradePackage.suffix }}</dd>
        </dl>

        <p
          v-if="upgradePackage"
          class="cctl__meta"
          :class="{ 'cctl__meta--warn': packageRejected }"
          :title="
            packageRejected
              ? t('cameraUpgradeUi.nameRejectedDetail', { suffix: upgradePackage.suffix })
              : ''
          "
        >
          {{ packageRejected ? t('cameraUpgradeUi.nameRejected') : t('cameraUpgradeUi.nameAccepted') }}
        </p>

        <div v-if="upgradeBusy === 'upload'" class="cctl__upload" role="status">
          <div class="bar" role="progressbar" :aria-valuetext="uploadProgressText">
            <div class="bar__fill" :style="{ width: `${uploadProgressPercent}%` }"></div>
          </div>
          <p class="cctl__meta">{{ uploadProgressText }}</p>
        </div>

        <!-- 上传完成：说清楚"包到了、还没升级"，下一步由操作员决定。 -->
        <p v-if="upgradeResult" class="cctl__meta cctl__meta--ok">{{ uploadOutcomeText }}</p>
        <p v-if="upgradeResult" class="cctl__meta">{{ t('cameraUpgradeUi.uploadedHint') }}</p>
        <p v-if="deviceProgress" class="cctl__meta">
          {{ t('cameraUpgradeUi.deviceProgressTitle') }}: {{ deviceProgressText }}
        </p>
        <p
          v-if="rebootResult"
          class="cctl__meta"
          :class="{ 'cctl__meta--warn': !rebootResult.acknowledged }"
        >
          {{ rebootOutcomeText }}
        </p>
      </section>
      </div>
    </section>

    <!-- 固件升级的二次确认：正文就是**后果**（会写什么、什么时候开始升级、不能做什么） -->
    <AppModal
      :model-value="confirmKind !== null"
      :title="confirmInfo?.title ?? ''"
      width="520px"
      :close-on-overlay="false"
      @update:model-value="closeConfirm"
    >
      <p class="alert alert--danger" role="alert">{{ confirmInfo?.body }}</p>

      <!-- 失败也留在对话框里：卡片上的横幅被遮罩挡住了，而一个"点了不关"的
           对话框比一句错误更难查。 -->
      <p v-if="error" class="alert alert--danger cctl__confirm-error" role="alert">{{ error }}</p>

      <dl v-if="confirmKind === 'upload' && upgradePackage" class="cctl__info cctl__confirm-info">
        <dt>{{ t('cameraUpgradeUi.packageFile') }}</dt>
        <dd class="mono">{{ upgradePackage.fileName }}</dd>
        <dt>{{ t('cameraUpgradeUi.packageSize') }}</dt>
        <dd>{{ formatBytes(upgradePackage.sizeBytes) }}</dd>
        <dt>{{ t('cameraUpgradeUi.packageSha256') }}</dt>
        <dd class="mono cctl__sha">{{ upgradePackage.sha256 }}</dd>
      </dl>

      <template #footer>
        <button type="button" class="btn" @click="closeConfirm">{{ t('common.cancel') }}</button>
        <button
          type="button"
          class="btn"
          :class="confirmKind === 'reboot' ? 'btn--danger' : 'btn--primary'"
          :disabled="upgradeBusy !== null"
          @click="confirmPending"
        >
          <template v-if="upgradeBusy === 'upload'">{{ uploadProgressText }}</template>
          <template v-else-if="upgradeBusy === 'reboot'">{{ t('cameraUpgradeUi.rebooting') }}</template>
          <template v-else>{{ confirmInfo?.confirm }}</template>
        </button>
      </template>
    </AppModal>

    <!--
      应用模式（局部放电 / 气体泄漏 / 机械异响）的二次确认。
      ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
      - `:close-on-overlay="false"`：这是破坏性动作的确认，点遮罩**不能**把它关掉
        （关掉等于"取消"是对的，但那样会让一次误点看起来像确认过了 —— 与
        `NetworkConfigSection` 的保存确认同一条规则）；
      - 键盘：`AppModal` 自带 Escape 关闭 + Tab 焦点陷阱，Esc 走
        `@update:model-value` -> 取消，一个字节都不写；
      - 焦点：不强设 `data-autofocus`。`AppModal` 因此聚焦**第一个可聚焦元素**，
        也就是页脚里的「取消」—— 一记回车是取消，而不是把设备切到另一个模式。
        对话框自身 `tabindex="-1"`，关闭时 `AppModal` 会把焦点还给打开它的那个按钮。
    -->
    <AppModal
      :model-value="pendingWorkMode !== null"
      :title="t('cameraControlUi.appModeConfirmTitle')"
      width="520px"
      :close-on-overlay="false"
      @update:model-value="cancelWorkMode"
    >
      <p class="alert alert--danger" role="alert">
        {{ t('cameraControlUi.appModeConfirmBody') }}
      </p>
      <!-- 正文逐字是产品那句话，所以"切到哪个模式"另起一行，不塞进那句话里。 -->
      <p class="cctl__meta cctl__confirm-mode">
        {{ t('cameraControlUi.appModeTitle') }}: {{ pendingWorkModeText }}
      </p>

      <template #footer>
        <button type="button" class="btn" @click="cancelWorkMode">{{ t('common.cancel') }}</button>
        <button type="button" class="btn btn--danger" :disabled="busy" @click="confirmWorkMode">
          {{ t('cameraControlUi.appModeConfirmAction') }}
        </button>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
.cctl {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.cctl__card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/*
 * 排布板：四块（检测 / 告警策略 / 维护 / 固件升级）按可用宽度自动决定列数。
 *
 * `auto-fit` + `minmax(340px, 1fr)` 是这次「重新排布」的全部机制：
 *   - 宽窗口上四块并排（2560px 上实测 4 列），窄窗口上自动落回 1 列；
 *   - `1fr` 让每一列吃掉剩余宽度，所以没有定宽列、也没有居中；
 *   - 最小 340px 是**内容**决定的：最宽的一行是固件升级的四个按钮（选择包 /
 *     上传 / 重启 / 读进度），再窄就会换行（换行本身不丢失控件，只是变高）。
 *
 * `.cctl` 的每一块都是一张卡片，所以这一层不再需要自己的间距 —— 卡片本身有边框与
 * 内边距，这正是「分组」在视觉上被看出来的地方。
 */
.cctl__board {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
  gap: var(--space-3);
  align-items: start;
}

/* 使 flex 上下文里的卡片作为网格项时不会撑破列（`min-width: auto` 是默认值）。 */
.cctl__section {
  min-width: 0;
}

.cctl__section-title {
  margin: 0;
  padding-bottom: 2px;
  font-size: 12.5px;
  font-weight: 600;
  border-bottom: 1px solid var(--color-border);
}

.cctl__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.cctl__modes {
  display: inline-flex;
  gap: 6px;
}

.cctl__presets {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.cctl__label {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.cctl__meta {
  font-size: 11.5px;
  color: var(--color-text-secondary);
}

.cctl__meta--warn {
  color: var(--color-warning);
}

.cctl__meta--ok {
  color: var(--color-success);
}

.cctl__info {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px var(--space-3);
  margin: 0;
  font-size: 12px;
}

.cctl__info dt {
  color: var(--color-text-secondary);
}

.cctl__info dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}

/* SHA-256 是 64 个十六进制字符：允许在任意位置断行，否则它会把这一行撑开。 */
.cctl__sha {
  word-break: break-all;
}

.cctl__upload {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cctl__confirm-error,
.cctl__confirm-info {
  margin-top: var(--space-3);
}

.cctl__confirm-mode {
  margin-top: var(--space-2);
}
</style>
