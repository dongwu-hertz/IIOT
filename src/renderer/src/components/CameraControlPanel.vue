<script setup lang="ts">
/**
 * 相机控制与维护面板（HERTZINNO FA371 / `acousticCamera`）。
 *
 * ---------------------------------------------------------------------------
 * 这个面板回答四个问题
 * ---------------------------------------------------------------------------
 *   1. 运行方式现在是什么？能改吗？—— `GET`/`PUT /run_mode`：
 *      `1` 单次检测 / `-1` 智能巡航；
 *   2. Detection Mode 现在是什么？—— `work_mode`：局部放电 / 气体泄漏 / 机械异响，
 *      `GET`/`PUT /system`（端点未文档化，真机实测可读可写）；
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
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  FA371_WORK_MODES,
  type Fa371AlarmStrategy,
  type Fa371DetectStatus,
  type Fa371RunModeConfig,
  type Fa371WorkModeValue
} from '@shared/domain/fa371'
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
  CameraModePresetRead,
  CameraModeRequestedValues
} from '@shared/domain/camera-mode-preset'
import { CAMERA_BAND_MAX_WIDTH_KHZ } from '@shared/domain/camera-mode-preset'
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
  /** 当前设备的实时告警数量；实时监测页把它放在标题右侧。 */
  alarmCount?: number
  /**
   * 实时监测页当前“已确认/已保存”的检测模式。
   * 它是界面显示 PRPD / Leakage / Mechanical 的权威值；设备 work_mode 只用于一致性核对。
   */
  configuredWorkMode?: Fa371WorkModeValue
  /** Hide the panel-local gear when the page hosts it in its top bar. */
  showSettingsButton?: boolean
}>()

defineExpose({ openDetectionSettings })

const emit = defineEmits<{
  /** 首次读取到设备实际 work_mode；父页面只做一致性核对，不用它反复改显示模式。 */
  (event: 'workModeObserved', payload: { deviceId: string; mode: Fa371WorkModeValue }): void
  /** 操作员在设置弹窗中明确修改模式且设备读回确认后，更新父页面保存的模式。 */
  (event: 'workModeChange', payload: { deviceId: string; mode: Fa371WorkModeValue }): void
  /** 实时监测页把三类告警配置拆成三个独立入口；具体弹窗/画面编辑器由父页面承载。 */
  (event: 'alarmConditionConfig'): void
  (event: 'alarmStrategyConfig'): void
  (event: 'alarmRegionConfig'): void
}>()


const activeSections = computed<readonly CameraControlSection[]>(
  () => props.sections ?? ALL_SECTIONS
)

/** Realtime Monitoring uses the compact operational control layout. */
const realtimeLayout = computed(() => {
  const sections = activeSections.value
  return (
    sections.includes('mode') &&
    sections.includes('preset') &&
    sections.includes('detect') &&
    !sections.includes('strategy') &&
    !sections.includes('maintenance') &&
    !sections.includes('upgrade')
  )
})
const detectionSettingsOpen = ref(false)
const settingsWorkModeDraft = ref<Fa371WorkModeValue | null>(null)
let detectStatusPollTimer: number | null = null
/**
 * 相机实际 work_mode 的轮询定时器。
 *
 * 与 detect_status 的 2 秒轮询分开：work_mode 是**设备设置**，变化频率低，
 * 10 秒一次足够；相机内嵌 HTTP 栈本来就小，不拿它去挤 2 秒那一拍。
 *
 * 轮询只更新「相机当前模式」这个事实并上报给父页面做一致性核对，**不**直接改
 * PRPD / 泄漏 / 机械分析卡的渲染（那仍由软件配置决定，见 refreshWorkMode 的注释）。
 */
let workModePollTimer: number | null = null
const WORK_MODE_POLL_MS = 10_000
let workModeLoadedDeviceId = ''

function isConfirmedWorkMode(value: unknown): value is Fa371WorkModeValue {
  return value === 1 || value === 2 || value === 3
}

/**
 * Application mode is treated as a latched device setting in Realtime Monitoring.
 * Read it once when a camera is selected. After that, ordinary refreshes (detect status,
 * imaging settings, strategy state, etc.) must NOT re-read or republish work_mode.
 * The latch is refreshed only after the operator explicitly changes Detection Mode.
 */
async function refreshWorkMode(deviceId: string, force = false): Promise<void> {
  if (!wants('mode') || deviceId === '') return
  if (!force && workModeLoadedDeviceId === deviceId && isConfirmedWorkMode(workModeRaw.value)) return

  const result = await callApi(() => window.api.cameraControl.readWorkMode(deviceId))
  // The operator may switch cameras while this request is in flight. Never publish an old
  // camera's work_mode into the newly selected camera's software state.
  if (props.deviceId !== deviceId) return
  if (!result.success) {
    // Keep the last confirmed UI mode. A transient read failure must never hide/show PRPD.
    return
  }

  const read = unwrap(result) ?? null
  if (read) workModeInfo.value = read
  const raw = read?.view.raw
  if (!read?.available || !isConfirmedWorkMode(raw)) return

  workModeLoadedDeviceId = deviceId
  emit('workModeObserved', { deviceId, mode: raw })
}

/**
 * Realtime monitoring has one selected camera. Keep detection state and the currently
 * enabled strategy in sync on the same lightweight 2 s poll so Start never remains
 * stale after the alarm-policy dialog changes device state.
 */
async function refreshRealtimeDetectStatus(): Promise<void> {
  if (!realtimeLayout.value || !wants('detect') || props.deviceId === '' || busy.value) return
  // Keep the Start button in sync with alarm-policy changes made in the separate
  // alarm dialog. Previously this poll refreshed only detect_status, so after an
  // operator enabled/disabled a strategy the Start button could remain grey until
  // the whole Camera Control panel was manually refreshed.
  const [detectResult, enabledResult] = await Promise.all([
    callApi(() => window.api.cameraControl.readDetectStatus(props.deviceId)),
    callApi(() => window.api.cameraControl.readEnabledStrategy(props.deviceId))
  ])
  if (detectResult.success) detect.value = unwrap(detectResult) ?? null
  if (enabledResult.success) enabledStrategies.value = unwrap(enabledResult) ?? null
}

function startDetectStatusPolling(): void {
  if (!realtimeLayout.value || detectStatusPollTimer !== null) return
  void refreshRealtimeDetectStatus()
  // 2 s 一拍（2026-09-23 下调，原 500 ms）：状态徽标 2 s 的延迟看不出差别，但相机
  // 的 HTTP 服务是单线程的小服务 —— 500 ms 一拍等于全天不间断地占着它（设备日志里
  // 一上午 1300+ 次 /system/detect_status，还挤掉了其它请求的连接）。
  detectStatusPollTimer = window.setInterval(() => { void refreshRealtimeDetectStatus() }, 2_000)
}

/**
 * 轮询相机实际 work_mode（仅实时布局需要）。
 *
 * 业主 2026-11-11：「相机的模式切换后，软件上好像没有直接显示」。原来 work_mode
 * 只在进入设备时读一次（为了不让轮询读回把 PRPD 卡片闪没），于是**相机 Web 界面
 * 改了模式，软件永远不知道**。现在每 10 秒读一次 + 窗口重新获得焦点时立刻读一次：
 * 只更新「相机当前模式」与一致性提醒，不直接切换分析卡。
 */
function startWorkModePolling(): void {
  if (!realtimeLayout.value || workModePollTimer !== null) return
  workModePollTimer = window.setInterval(() => {
    void refreshWorkMode(props.deviceId, true)
  }, WORK_MODE_POLL_MS)
}

function stopWorkModePolling(): void {
  if (workModePollTimer === null) return
  window.clearInterval(workModePollTimer)
  workModePollTimer = null
}

/** 从相机 Web 界面切回本软件时立刻对一次：不必等下一拍 10 秒。 */
function onWindowFocus(): void {
  if (!realtimeLayout.value || props.deviceId === '') return
  void refreshWorkMode(props.deviceId, true)
}

/**
 * 刷新按钮：除了常规读数，还要**强制重读 work_mode**。
 *
 * `load()` 刻意不读 work_mode（避免普通刷新闪动分析卡）；手动点刷新是操作员的
 * 明确意图，必须把相机当前模式一起读回来。
 */
async function reload(): Promise<void> {
  await refreshWorkMode(props.deviceId, true)
  await load()
}

function openDetectionSettings(): void {
  // Frequency has its own editor under Operation Mode. Opening the camera-settings
  // modal starts from the last device read, so an unfinished frequency edit is not
  // accidentally persisted when the operator only intends to change imaging settings.
  syncManualSettingsFromDevice()
  // The modal starts from the monitoring software's configured mode, not from a fresh camera read.
  // This lets the operator explicitly re-apply the expected mode when the camera was changed elsewhere.
  settingsWorkModeDraft.value = isConfirmedWorkMode(props.configuredWorkMode)
    ? props.configuredWorkMode
    : isConfirmedWorkMode(workModeRaw.value)
      ? workModeRaw.value
      : null
  detectionSettingsOpen.value = true
}

function closeDetectionSettings(): void {
  // Cancel means cancel the whole settings edit, including frequency / threshold drafts.
  syncManualSettingsFromDevice()
  detectionSettingsOpen.value = false
  settingsWorkModeDraft.value = null
}

async function applyDetectionSettings(): Promise<void> {
  const next = settingsWorkModeDraft.value
  const deviceId = props.deviceId
  if (!isConfirmedWorkMode(next) || deviceId === '' || manualBandError.value !== '') return

  // Imaging threshold is edited here; frequency lives directly under Operation Mode. Persist
  // any pending camera-setting draft before requesting a Detection Mode change so writes cannot race.
  if (manualSettingsDirty.value) {
    const saved = await saveManualImagingSettings()
    if (!saved) return
  }

  detectionSettingsOpen.value = false
  settingsWorkModeDraft.value = null

  // Important mismatch case: software may be configured for PD while the camera is already
  // in Gas mode. If the operator explicitly selects Gas and presses Apply, no device write is
  // needed, but the software configuration still has to move to Gas.
  if (next === workModeRaw.value) {
    if (next !== props.configuredWorkMode) {
      outcome.value = t('cameraControlUi.appModeApplied')
      emit('workModeChange', { deviceId, mode: next })
    }
    return
  }

  requestWorkMode(next)
}

function openAlarmConfiguration(kind: 'condition' | 'strategy' | 'region'): void {
  // Alarm configuration is intentionally outside this modal: each type owns its own Save/Cancel.
  // Entering one of those editors is navigation, not an implicit Save of frequency/threshold edits.
  syncManualSettingsFromDevice()
  detectionSettingsOpen.value = false
  settingsWorkModeDraft.value = null
  if (kind === 'condition') emit('alarmConditionConfig')
  else if (kind === 'strategy') emit('alarmStrategyConfig')
  else emit('alarmRegionConfig')
}

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
const detect = ref<Fa371DetectStatus | null>(null)
const detectActionResult = ref<CameraDetectActionResult | null>(null)
const enabledStrategies = ref<CameraEnabledStrategyView | null>(null)
const strategies = ref<Fa371AlarmStrategy[]>([])
const selectedStrategyId = ref('')
const maintenance = ref<CameraMaintenanceInfo | null>(null)

const canWrite = computed(() => session.isAdmin)

// ---------------------------------------------------------------------------
// 运行方式（run_mode：单次检测 / 智能巡航）
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
// 检测模式（work_mode：局部放电 / 气体泄漏 / 机械异响）
//
// ⚠ 与上面那块「运行方式」不是一回事：
//   运行方式 = `GET`/`PUT /run_mode`（手册 §5.1.8，单次检测 / 智能巡航）；
//   检测模式 = `GET`/`PUT /system`（`work_mode`，真机实测可读可写）。
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
function onWorkModeSelect(event: Event): void {
  const value = Number((event.target as HTMLSelectElement).value)
  if (value === 1 || value === 2 || value === 3) requestWorkMode(value)
}

function onRunModeSelect(event: Event): void {
  const value = Number((event.target as HTMLSelectElement).value)
  if (value === 1 || value === -1) void selectMode(value)
}

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
  const deviceId = props.deviceId
  // 已经在这个模式上就什么都不做：重复写一次等于拿一个无操作去赌一次设备行为。
  if (workModeRaw.value === next) return
  busy.value = true
  error.value = ''
  outcome.value = ''
  workModeOutcome.value = null
  try {
    const result = await callApi(() => window.api.cameraControl.writeWorkMode(deviceId, next))
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
    const readBack = workModeOutcome.value?.after.raw

    // writeWorkMode() already performs PUT -> GET. Its `after` value is the authoritative camera
    // fact for this Apply action; do not issue another work_mode GET here. That keeps the realtime
    // state chain to: one observation on entry, then write-after-readback only on explicit Apply.
    if (props.deviceId === deviceId && workModeOutcome.value && isConfirmedWorkMode(readBack)) {
      workModeInfo.value = {
        available: true,
        view: workModeOutcome.value.after,
        selectable: workModeInfo.value?.selectable ?? FA371_WORK_MODES
      }
      workModeLoadedDeviceId = deviceId
      if (workModeOutcome.value.applied) {
        emit('workModeChange', { deviceId, mode: readBack })
        // 业主 2026-09-24：切到泄漏模式成功 → 自动展开泄漏计算参数（那是泄漏量/成本
        // 口径的输入，手册把这些列为泄漏估算的必填上下文）。
        if (readBack === 2) void openLeakageEditor()
      } else {
        // A rejected write never changes software configuration; its read-back is only a mismatch fact.
        emit('workModeObserved', { deviceId, mode: readBack })
      }
      await load()
    }
  }
}

// ---------------------------------------------------------------------------
// 泄漏估算参数（业主 2026-09-24：局放 → 泄漏切换时要能填计算模板）
//
// 端点是手册内的 `/system/leakage`（§5.1.10/§5.1.11，V2.0 含 correction_rate）。
// 行为：当前模式是泄漏时模式区块下面出现这一块；从别的模式**切到**泄漏成功时
// 自动展开一次（参数是泄漏量/成本口径的输入，不切的时候没人需要天天看到它）。
// 读打底 → 改草稿 → 保存（部分字段更新）→ 设备重读值回显 —— 与 run_mode 同一口径。
// ---------------------------------------------------------------------------

interface LeakageDraft {
  correction_rate: number | undefined
  cost_display: boolean
  leakage_distance: number | undefined
  leakage_unit: number | undefined
  monetary_unit: number | undefined
  value_of_gas: number | undefined
  energy_cost: number | undefined
  specific_power: number | undefined
  working_hours: number | undefined
}

const leakageOpen = ref(false)
const leakageBusy = ref(false)
const leakageError = ref('')
const leakageNotice = ref('')
const leakageDraft = reactive<LeakageDraft>({
  correction_rate: undefined,
  cost_display: false,
  leakage_distance: undefined,
  leakage_unit: undefined,
  monetary_unit: undefined,
  value_of_gas: undefined,
  energy_cost: undefined,
  specific_power: undefined,
  working_hours: undefined
})

/** 当前应用模式是不是泄漏（读回值是权威，见 selectWorkMode 的注释链）。 */
const isLeakMode = computed(() => workModeRaw.value === 2)

async function openLeakageEditor(): Promise<void> {
  if (props.deviceId === '') return
  leakageOpen.value = true
  leakageError.value = ''
  leakageNotice.value = ''
  leakageBusy.value = true
  const result = await callApi(() => window.api.cameraControl.readLeakage(props.deviceId))
  leakageBusy.value = false
  if (!result.success) {
    leakageError.value = resultMessage(result)
    return
  }
  const current = unwrap(result)
  // 设备当前值打底：读不到的字段留空 = 不改它（保存时只发填了的字段）。
  leakageDraft.correction_rate = current?.correctionRate
  leakageDraft.cost_display = current?.costDisplay ?? false
  leakageDraft.leakage_distance = current?.distanceM
  leakageDraft.leakage_unit = current?.unit?.code
  leakageDraft.monetary_unit = current?.monetaryUnit?.code
  leakageDraft.value_of_gas = current?.valueOfGas
  leakageDraft.energy_cost = current?.energyCost
  leakageDraft.specific_power = current?.specificPower
  leakageDraft.working_hours = current?.workingHours
}

async function saveLeakage(): Promise<void> {
  if (busy.value || leakageBusy.value || props.deviceId === '') return
  leakageBusy.value = true
  leakageError.value = ''
  leakageNotice.value = ''
  try {
    // 只发填了的字段（手册原文：需要配置的参数单独发；空 = 不动设备上那个字段）。
    const patch: Record<string, number> = {}
    if (leakageDraft.correction_rate !== undefined) patch.correction_rate = leakageDraft.correction_rate
    if (leakageDraft.leakage_distance !== undefined) patch.leakage_distance = leakageDraft.leakage_distance
    if (leakageDraft.leakage_unit !== undefined) patch.leakage_unit = leakageDraft.leakage_unit
    if (leakageDraft.monetary_unit !== undefined) patch.monetary_unit = leakageDraft.monetary_unit
    if (leakageDraft.value_of_gas !== undefined) patch.value_of_gas = leakageDraft.value_of_gas
    if (leakageDraft.energy_cost !== undefined) patch.energy_cost = leakageDraft.energy_cost
    if (leakageDraft.specific_power !== undefined) patch.specific_power = leakageDraft.specific_power
    if (leakageDraft.working_hours !== undefined) patch.working_hours = leakageDraft.working_hours
    patch.cost_display = leakageDraft.cost_display ? 1 : 0

    const result = await callApi(() =>
      window.api.cameraControl.writeLeakage(props.deviceId, patch)
    )
    if (!result.success) {
      leakageError.value = resultMessage(result)
      return
    }
    // 权威值回显：设备读回来的才算数（与其他写通道同一口径）。
    const after = unwrap(result)?.after
    if (after) {
      leakageDraft.correction_rate = after.correctionRate
      leakageDraft.cost_display = after.costDisplay ?? false
      leakageDraft.leakage_distance = after.distanceM
      leakageDraft.leakage_unit = after.unit?.code
      leakageDraft.monetary_unit = after.monetaryUnit?.code
      leakageDraft.value_of_gas = after.valueOfGas
      leakageDraft.energy_cost = after.energyCost
      leakageDraft.specific_power = after.specificPower
      leakageDraft.working_hours = after.workingHours
    }
    leakageNotice.value = t('cameraControlUi.leakageSaved')
  } finally {
    leakageBusy.value = false
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

/** 设备当前的「频带 + 目标数量 + 阈值 + 命中预设」，全部来自一次真实读数。 */
const presetView = computed(() => presetInfo.value?.view ?? null)

// ---------------------------------------------------------------------------
// 实时监测页的手工成像参数
//
// 产品要求：应用模式只给“建议检测范围”，不能把频带锁死在预设值上。设备当前值仍
// 由 readModePreset() 读取；保存时复用 cameraControl.restoreModeValues() 这条“按给定
// 字段写回并重读”的通道。这个 API 名字历史上叫 restore，但服务端接受的是通用的
// CameraModeRequestedValues，因此这里不新增第二套写接口。
// ---------------------------------------------------------------------------
const manualLowerKhz = ref<number | null>(null)
const manualUpperKhz = ref<number | null>(null)
const manualThreshold = ref<number | null>(null)
const manualSettingsDirty = ref(false)

function syncManualSettingsFromDevice(): void {
  const view = presetView.value
  if (!view) return
  manualLowerKhz.value = view.lowerKhz ?? null
  manualUpperKhz.value = view.upperKhz ?? null
  manualThreshold.value = view.energyThreshold ?? null
  manualSettingsDirty.value = false
}

const suggestedBandText = computed(() => {
  switch (workModeRaw.value) {
    case 1:
      return '20–40 kHz'
    case 2:
      return '25–45 kHz'
    case 3:
      // 手册给的是 2–50 kHz 搜索/起始指导；单次成像带宽仍受设备自身校验约束。
      return t('cameraControlUi.suggestedMechanicalBand', { limit: CAMERA_BAND_MAX_WIDTH_KHZ })
    default:
      return '2–65 kHz'
  }
})

const manualBandError = computed(() => {
  const lower = manualLowerKhz.value
  const upper = manualUpperKhz.value
  if (lower === null || upper === null) return t('cameraControlUi.bandErrorMissing')
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) return t('cameraControlUi.bandErrorNumeric')
  if (lower < 2 || upper > 65) return t('cameraControlUi.bandErrorRange')
  if (lower >= upper) return t('cameraControlUi.bandErrorOrder')
  if (upper - lower > CAMERA_BAND_MAX_WIDTH_KHZ) {
    return t('cameraControlUi.bandErrorWidth', { limit: CAMERA_BAND_MAX_WIDTH_KHZ })
  }
  return ''
})

const manualSettingsCanSave = computed(() =>
  canWrite.value && !busy.value && manualSettingsDirty.value && manualBandError.value === '' && manualThreshold.value !== null
)

const manualFrequencyCanSave = computed(() =>
  canWrite.value && !busy.value && manualSettingsDirty.value && manualBandError.value === ''
)

function markManualSettingsDirty(): void {
  manualSettingsDirty.value = true
}

const CAMERA_BAND_MIN_KHZ = 2
const CAMERA_BAND_MAX_KHZ = 65

function clampBandValue(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Only two frequency inputs are exposed. When the operator edits the lower bound, keep that value
 * authoritative and move the upper bound if needed. The camera accepts at most a 20 kHz span.
 */
function onLowerFrequencyInput(): void {
  const raw = manualLowerKhz.value
  if (raw === null || !Number.isFinite(raw)) {
    markManualSettingsDirty()
    return
  }
  const lower = clampBandValue(raw, CAMERA_BAND_MIN_KHZ, CAMERA_BAND_MAX_KHZ - 1)
  let upper = manualUpperKhz.value
  if (upper === null || !Number.isFinite(upper)) upper = Math.min(CAMERA_BAND_MAX_KHZ, lower + CAMERA_BAND_MAX_WIDTH_KHZ)
  upper = clampBandValue(upper, CAMERA_BAND_MIN_KHZ + 1, CAMERA_BAND_MAX_KHZ)
  if (upper <= lower) upper = Math.min(CAMERA_BAND_MAX_KHZ, lower + 1)
  if (upper - lower > CAMERA_BAND_MAX_WIDTH_KHZ) upper = lower + CAMERA_BAND_MAX_WIDTH_KHZ
  manualLowerKhz.value = lower
  manualUpperKhz.value = upper
  markManualSettingsDirty()
}

/** Same rule in the other direction: editing the upper bound moves the lower bound when needed. */
function onUpperFrequencyInput(): void {
  const raw = manualUpperKhz.value
  if (raw === null || !Number.isFinite(raw)) {
    markManualSettingsDirty()
    return
  }
  const upper = clampBandValue(raw, CAMERA_BAND_MIN_KHZ + 1, CAMERA_BAND_MAX_KHZ)
  let lower = manualLowerKhz.value
  if (lower === null || !Number.isFinite(lower)) lower = Math.max(CAMERA_BAND_MIN_KHZ, upper - CAMERA_BAND_MAX_WIDTH_KHZ)
  lower = clampBandValue(lower, CAMERA_BAND_MIN_KHZ, CAMERA_BAND_MAX_KHZ - 1)
  if (lower >= upper) lower = Math.max(CAMERA_BAND_MIN_KHZ, upper - 1)
  if (upper - lower > CAMERA_BAND_MAX_WIDTH_KHZ) lower = upper - CAMERA_BAND_MAX_WIDTH_KHZ
  manualLowerKhz.value = lower
  manualUpperKhz.value = upper
  markManualSettingsDirty()
}

async function saveManualImagingSettings(): Promise<boolean> {
  if (!manualSettingsCanSave.value || props.deviceId === '') return false
  const lower = manualLowerKhz.value
  const upper = manualUpperKhz.value
  const threshold = manualThreshold.value
  if (lower === null || upper === null || threshold === null) return false

  busy.value = true
  error.value = ''
  outcome.value = ''
  try {
    const values: CameraModeRequestedValues = {
      acoustic: { lowerKhz: lower, upperKhz: upper },
      imaging: { energyThreshold: threshold }
    }
    const result = await callApi(() =>
      window.api.cameraControl.restoreModeValues(props.deviceId, values)
    )
    if (!result.success) {
      error.value = resultMessage(result)
      return false
    }
    const write = unwrap(result)
    outcome.value = write?.applied
      ? t('cameraControlUi.imagingSettingsApplied')
      : t('cameraControlUi.imagingSettingsRejected')
    if (write?.applied) {
      manualSettingsDirty.value = false
      return true
    }
    return false
  } finally {
    busy.value = false
    await load()
  }
}

/** Realtime Operation Mode owns frequency independently from Camera Settings. */
async function saveManualFrequencyBand(): Promise<boolean> {
  if (!manualFrequencyCanSave.value || props.deviceId === '') return false
  const lower = manualLowerKhz.value
  const upper = manualUpperKhz.value
  if (lower === null || upper === null) return false

  busy.value = true
  error.value = ''
  outcome.value = ''
  try {
    const values: CameraModeRequestedValues = {
      acoustic: { lowerKhz: lower, upperKhz: upper },
      imaging: {}
    }
    const result = await callApi(() =>
      window.api.cameraControl.restoreModeValues(props.deviceId, values)
    )
    if (!result.success) {
      error.value = resultMessage(result)
      return false
    }
    const write = unwrap(result)
    outcome.value = write?.applied
      ? t('cameraControlUi.imagingSettingsApplied')
      : t('cameraControlUi.imagingSettingsRejected')
    if (write?.applied) {
      manualSettingsDirty.value = false
      return true
    }
    return false
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
  startDetectStatusPolling()
  startWorkModePolling()
  window.addEventListener('focus', onWindowFocus)
})

onUnmounted(() => {
  unsubscribeUpgradeProgress?.()
  unsubscribeUpgradeProgress = null
  if (detectStatusPollTimer !== null) {
    window.clearInterval(detectStatusPollTimer)
    detectStatusPollTimer = null
  }
  stopWorkModePolling()
  window.removeEventListener('focus', onWindowFocus)
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
    const [modeResult, detectResult, enabledResult, listResult, maintenanceResult, presetResult] =
      await Promise.all([
        wants('mode') ? callApi(() => window.api.cameraControl.readRunMode(deviceId)) : null,
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
    // work_mode is intentionally NOT part of the ordinary refresh path.
    // It is read once per selected device by refreshWorkMode(), then latched until the
    // operator explicitly changes Detection Mode.
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
      if (read) {
        /*
         * 只有设备读数刷新后才覆盖输入框，避免用户正在键入时被异步状态刷新打断。
         *
         * 这里曾经还记一份 `matchedPresetIds`（"载入时设备命中哪个场景"），用于旧界面上
         * 那三个「应用场景」按钮判断"已经在这个场景"与"这一趟改过什么"。
         * 那一排按钮按业主 2026-09-26 的决定**已经撤掉**（需求优化成手工输入频带与成像门限），
         * 于是那份状态成了死代码，一并删掉；`readModePreset()` 的读数仍然要（下面要用它
         * 填输入框）。
         */
        if (!manualSettingsDirty.value) syncManualSettingsFromDevice()
      }
    }

    // 读到的每一路失败都要说出来：静默的半张卡比一句错误更难查。
    // 逐条判断而不是对数组 `.map()`：各路的 `DeviceResult<T>` 的 T 各不相同，
    // 放进一个数组后 `resultMessage` 拿到的会是联合类型，推不出 T。
    const failures: string[] = []
    if (modeResult && !modeResult.success) failures.push(resultMessage(modeResult))
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

onMounted(async () => {
  await refreshWorkMode(props.deviceId)
  await load()
})

watch(
  () => props.deviceId,
  async () => {
    modeOutcome.value = null
    workModeOutcome.value = null
    detectActionResult.value = null
    manualLowerKhz.value = null
    manualUpperKhz.value = null
    manualThreshold.value = null
    manualSettingsDirty.value = false
    detectionSettingsOpen.value = false
    workModeLoadedDeviceId = ''
    workModeInfo.value = null
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
    await refreshWorkMode(props.deviceId)
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
  <div class="cctl camera-board__panel" :class="{ 'cctl--realtime': realtimeLayout }">
    <section class="card cctl__card">
      <div class="section-header cctl__top-header">
        <h3 class="section-title">{{ t('cameraControlUi.title') }}</h3>
        <div class="cctl__header-actions">
          <span
            v-if="(alarmCount ?? 0) > 0"
            class="cctl__alarm-badge"
            data-camera-alarm-count
            :title="t('cameraControlUi.activeRecentAlarms', { count: alarmCount ?? 0 })"
            role="status"
          >
            <svg viewBox="0 0 18 18" aria-hidden="true">
              <path d="M9 2.4 16 15H2Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
              <path d="M9 6.2v4.5M9 13.1v.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
            </svg>
            <span>{{ alarmCount }}</span>
          </span>
          <button
            v-if="realtimeLayout && showSettingsButton !== false"
            type="button"
            class="cctl__icon-button"
            :class="{ 'cctl__icon-button--active': detectionSettingsOpen }"
            :title="t('cameraControlUi.settingsTitle')"
            :aria-label="t('cameraControlUi.settingsTitle')"
            :aria-expanded="detectionSettingsOpen"
            @click="openDetectionSettings"
          >
            <svg viewBox="0 0 18 18" aria-hidden="true">
              <path d="M7.7 2.3h2.6l.45 1.55c.35.14.68.33.98.56l1.55-.43 1.3 2.25-1.1 1.13c.05.36.05.73 0 1.1l1.1 1.13-1.3 2.25-1.55-.43c-.3.23-.63.42-.98.56l-.45 1.55H7.7l-.45-1.55a5.2 5.2 0 0 1-.98-.56l-1.55.43-1.3-2.25 1.1-1.13a4.1 4.1 0 0 1 0-1.1l-1.1-1.13 1.3-2.25 1.55.43c.3-.23.63-.42.98-.56L7.7 2.3Z" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round"/>
              <circle cx="9" cy="7.95" r="1.85" fill="none" stroke="currentColor" stroke-width="1.2"/>
            </svg>
          </button>
          <button
            type="button"
            class="cctl__icon-button"
            :disabled="loading"
            :title="t('cameraControlUi.refresh')"
            :aria-label="t('cameraControlUi.refresh')"
            @click="reload"
          >
            <svg viewBox="0 0 18 18" aria-hidden="true"><path d="M14.8 6.4A6 6 0 1 0 15 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M14.8 3.4v3.4h-3.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
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
        <h4 v-if="!realtimeLayout" class="cctl__label cctl__section-title">{{ t('cameraControlUi.detectionControlTitle') }}</h4>

        <!-- 检测模式（work_mode）：切换本身只改变 work_mode；频带/门限仅显示建议，不自动覆盖。 -->
        <div v-if="wants('mode') && workModeAvailable && !realtimeLayout" class="cctl__field cctl__field--mode-settings">
          <label class="cctl__field-label" for="camera-work-mode">{{ t('cameraControlUi.detectionModeLabel') }}</label>
          <select
            id="camera-work-mode"
            class="select cctl__select"
            :value="workModeRaw ?? ''"
            :disabled="busy || !canWrite"
            :title="canWrite ? t('cameraControlUi.appModeSourceHint') : t('cameraControlUi.adminOnlyHint')"
            @change="onWorkModeSelect"
          >
            <option v-for="value in workModeSelectable" :key="value" :value="value">
              {{ workModeText(value) }}
            </option>
          </select>
          <p class="cctl__field-hint">{{ t('cameraControlUi.suggestedFrequencyRange', { range: suggestedBandText }) }}</p>

          <!-- 泄漏计算参数（业主 2026-09-24）：当前是泄漏模式时出现；切到泄漏成功时自动展开一次。 -->
          <div v-if="isLeakMode || leakageOpen" class="cctl__leakage">
            <button
              v-if="!leakageOpen"
              type="button"
              class="btn btn--sm"
              :disabled="busy || !canWrite"
              @click="openLeakageEditor"
            >
              {{ t('cameraControlUi.leakageOpen') }}
            </button>
            <div v-else class="cctl__leakage-form">
              <span class="cctl__field-label">{{ t('cameraControlUi.leakageParamsTitle') }}</span>
              <div class="cctl__leakage-grid">
                <label class="field">
                  <span class="field-label">{{ t('cameraControlUi.leakageDistance') }}</span>
                  <input v-model.number="leakageDraft.leakage_distance" class="input" type="number" min="1" max="50" step="0.1" :disabled="leakageBusy || !canWrite" />
                </label>
                <label class="field">
                  <span class="field-label">{{ t('cameraControlUi.leakageUnitLabel') }}</span>
                  <select v-model.number="leakageDraft.leakage_unit" class="select" :disabled="leakageBusy || !canWrite">
                    <option :value="0">l/min</option>
                    <option :value="1">ml/s</option>
                  </select>
                </label>
                <label class="field">
                  <span class="field-label">{{ t('cameraControlUi.monetaryUnitLabel') }}</span>
                  <select v-model.number="leakageDraft.monetary_unit" class="select" :disabled="leakageBusy || !canWrite">
                    <option :value="0">¥ CNY</option>
                    <option :value="1">£ GBP</option>
                    <option :value="2">$ USD</option>
                    <option :value="3">€ EUR</option>
                    <option :value="4">₽ RUB</option>
                  </select>
                </label>
                <label class="field">
                  <span class="field-label">{{ t('cameraControlUi.valueOfGas') }}</span>
                  <input v-model.number="leakageDraft.value_of_gas" class="input" type="number" step="0.01" :disabled="leakageBusy || !canWrite" />
                </label>
                <label class="field">
                  <span class="field-label">{{ t('cameraControlUi.energyCost') }}</span>
                  <input v-model.number="leakageDraft.energy_cost" class="input" type="number" step="0.01" :disabled="leakageBusy || !canWrite" />
                </label>
                <label class="field">
                  <span class="field-label">{{ t('cameraControlUi.specificPower') }}</span>
                  <input v-model.number="leakageDraft.specific_power" class="input" type="number" step="0.01" :disabled="leakageBusy || !canWrite" />
                </label>
                <label class="field">
                  <span class="field-label">{{ t('cameraControlUi.workingHours') }}</span>
                  <input v-model.number="leakageDraft.working_hours" class="input" type="number" step="0.5" min="0" :disabled="leakageBusy || !canWrite" />
                </label>
                <label class="field">
                  <span class="field-label">{{ t('cameraControlUi.correctionRate') }}</span>
                  <input v-model.number="leakageDraft.correction_rate" class="input" type="number" step="0.01" :disabled="leakageBusy || !canWrite" />
                </label>
                <label class="field checkbox-field">
                  <input v-model="leakageDraft.cost_display" type="checkbox" :disabled="leakageBusy || !canWrite" />
                  <span class="field-label">{{ t('cameraControlUi.costDisplay') }}</span>
                </label>
              </div>
              <p v-if="leakageError" class="alert alert--danger" role="alert">{{ leakageError }}</p>
              <p v-else-if="leakageNotice" class="alert alert--success" role="status">{{ leakageNotice }}</p>
              <div class="btn-row">
                <button type="button" class="btn btn--sm btn--primary" :disabled="leakageBusy || !canWrite" @click="saveLeakage">
                  {{ t('cameraControlUi.leakageSave') }}
                </button>
                <button type="button" class="btn btn--sm" @click="leakageOpen = false">
                  {{ t('cameraAlarmUi.cancel') }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- 单次检测 / 智能巡航：保留设备原有 run_mode，但降为次级运行方式。 -->
        <div v-if="wants('mode')" class="cctl__field" data-camera-panel="mode">
          <label class="cctl__field-label" for="camera-run-mode">{{ t('cameraControlUi.operationLabel') }}</label>
          <select
            id="camera-run-mode"
            class="select cctl__select"
            :value="modeValue ?? ''"
            :disabled="busy || !canWrite"
            @change="onRunModeSelect"
          >
            <option :value="1">{{ t('cameraControlUi.modeSingle') }}</option>
            <option :value="-1">{{ t('cameraControlUi.modeCruise') }}</option>
          </select>
          <span v-if="modeUnrecognised" class="cctl__meta">
            {{ t('cameraControlUi.modeRawValue', { value: modeRawText }) }}
          </span>
        </div>

        <!-- Realtime layout: frequency and alarm configuration belong directly under
             Operation Mode. They are deliberately not hidden in Camera Settings. -->
        <div v-if="realtimeLayout && wants('preset')" class="cctl__field cctl__field--frequency-inline">
          <span class="cctl__field-label">{{ t('cameraControlUi.frequencyBand') }}</span>
          <div class="cctl__band-inputs">
            <label>
              <span class="sr-only">{{ t('cameraControlUi.lowerFrequency') }}</span>
              <input
                v-model.number="manualLowerKhz"
                class="input cctl__number"
                type="number"
                min="2"
                max="64"
                step="1"
                :disabled="busy || !canWrite"
                @input="onLowerFrequencyInput"
              />
            </label>
            <span class="cctl__range-separator">—</span>
            <label>
              <span class="sr-only">{{ t('cameraControlUi.upperFrequency') }}</span>
              <input
                v-model.number="manualUpperKhz"
                class="input cctl__number"
                type="number"
                min="3"
                max="65"
                step="1"
                :disabled="busy || !canWrite"
                @input="onUpperFrequencyInput"
              />
            </label>
            <span class="cctl__unit">kHz</span>
          </div>
          <p class="cctl__field-hint">{{ t('cameraControlUi.recommendedForMode', { range: suggestedBandText }) }}</p>
          <p v-if="manualBandError" class="cctl__field-error">{{ manualBandError }}</p>
          <div class="cctl__settings-actions cctl__settings-actions--primary">
            <button
              type="button"
              class="btn btn--sm btn--primary"
              :disabled="!manualFrequencyCanSave"
              @click="saveManualFrequencyBand"
            >
              {{ t('common.save') }}
            </button>
            <button
              type="button"
              class="btn btn--sm"
              :disabled="busy || !manualSettingsDirty"
              @click="syncManualSettingsFromDevice"
            >
              {{ t('common.cancel') }}
            </button>
          </div>
        </div>

        <div v-if="realtimeLayout" class="cctl__field cctl__alarm-config-field">
          <span class="cctl__field-label">{{ t('cameraAlarmUi.title') }}</span>
          <div class="cctl__alarm-config-actions">
            <button type="button" class="btn btn--sm" :disabled="!canWrite" @click="openAlarmConfiguration('condition')">
              {{ t('cameraAlarmUi.tabConditions') }}
            </button>
            <button type="button" class="btn btn--sm" :disabled="!canWrite" @click="openAlarmConfiguration('strategy')">
              {{ t('cameraAlarmUi.tabStrategies') }}
            </button>
            <button type="button" class="btn btn--sm" :disabled="!canWrite" @click="openAlarmConfiguration('region')">
              {{ t('cameraAlarmUi.tabRegions') }}
            </button>
          </div>
        </div>

        <!-- 手工频带：模式只提供建议，真正用于成像的上下限始终允许工程师输入。 -->
        <div v-if="wants('preset') && !realtimeLayout" class="cctl__field">
          <span class="cctl__field-label">{{ t('cameraControlUi.frequencyBand') }}</span>
          <div class="cctl__band-inputs">
            <label>
              <span class="sr-only">{{ t('cameraControlUi.lowerFrequency') }}</span>
              <input
                v-model.number="manualLowerKhz"
                class="input cctl__number"
                type="number"
                min="2"
                max="65"
                step="1"
                :disabled="busy || !canWrite"
                @input="onLowerFrequencyInput"
              />
            </label>
            <span class="cctl__range-separator">—</span>
            <label>
              <span class="sr-only">{{ t('cameraControlUi.upperFrequency') }}</span>
              <input
                v-model.number="manualUpperKhz"
                class="input cctl__number"
                type="number"
                min="2"
                max="65"
                step="1"
                :disabled="busy || !canWrite"
                @input="onUpperFrequencyInput"
              />
            </label>
            <span class="cctl__unit">kHz</span>
          </div>
          <p class="cctl__field-hint">{{ t('cameraControlUi.recommendedForMode', { range: suggestedBandText }) }}</p>
          <p v-if="manualBandError" class="cctl__field-error">{{ manualBandError }}</p>
        </div>

        <!-- 成像门限：既可以键入，也可以通过步进键微调；它不是告警阈值。 -->
        <div v-if="wants('preset') && !realtimeLayout" class="cctl__field">
          <label class="cctl__field-label" for="camera-imaging-threshold">{{ t('cameraControlUi.imagingThreshold') }}</label>
          <div class="cctl__threshold">
            <input
              id="camera-imaging-threshold"
              v-model.number="manualThreshold"
              class="input cctl__number cctl__number--threshold"
              type="number"
              step="1"
              :disabled="busy || !canWrite"
              @input="markManualSettingsDirty"
            />
            <span class="cctl__unit">dB</span>
          </div>
          <p class="cctl__field-hint">{{ t('cameraControlUi.imagingThresholdHint') }}</p>
        </div>

        <div v-if="wants('preset') && !realtimeLayout" class="cctl__settings-actions cctl__settings-actions--primary">
          <button
            type="button"
            class="btn btn--sm btn--primary"
            :disabled="!manualSettingsCanSave"
            @click="saveManualImagingSettings"
          >
            {{ t('cameraControlUi.apply') }}
          </button>
          <button
            type="button"
            class="btn btn--sm"
            :disabled="busy || !manualSettingsDirty"
            @click="syncManualSettingsFromDevice"
          >
            {{ t('common.reset') }}
          </button>
        </div>

      <!-- ---- 检测启停（**留在实时监测页**：它是看的时候要按的东西） ----- -->
      <template v-if="wants('detect')">
      <div class="cctl__row cctl__detect-state">
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
      <div class="btn-row cctl__detect-actions">
        <span :title="startDisabledReason">
          <button
            type="button"
            class="btn btn--sm btn--primary"
            :disabled="busy || !canWrite || detecting"
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
      <!-- 禁用原因必须**看得见**（2026-09-23 修复）：原来只挂在 title 提示里，
           操作员看到的就是一颗没反应的灰按钮，"开始检测没起作用"的投诉正来自这里。 -->
      <p v-if="startDisabledReason" class="cctl__meta" role="note">{{ startDisabledReason }}</p>
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

    <!-- Realtime Camera Control settings: the gear opens a real modal, never an inline row. -->
    <AppModal
      v-if="realtimeLayout"
      :model-value="detectionSettingsOpen"
      :title="t('cameraControlUi.settingsTitle')"
      width="460px"
      @update:model-value="(open) => { if (!open) closeDetectionSettings() }"
    >
      <div class="cctl__settings-modal">
        <div v-if="workModeAvailable" class="cctl__field">
          <label class="cctl__field-label" for="camera-work-mode-modal">{{ t('cameraControlUi.detectionModeLabel') }}</label>
          <select
            id="camera-work-mode-modal"
            v-model.number="settingsWorkModeDraft"
            class="select cctl__select"
            :disabled="busy || !canWrite"
            :title="canWrite ? t('cameraControlUi.appModeSourceHint') : t('cameraControlUi.adminOnlyHint')"
          >
            <option v-for="value in workModeSelectable" :key="value" :value="value">
              {{ workModeText(value) }}
            </option>
          </select>
          <p class="cctl__field-hint">{{ t('cameraControlUi.suggestedFrequencyRange', { range: suggestedBandText }) }}</p>
        </div>
        <p v-else class="cctl__meta">{{ t('cameraControlUi.detectionModeUnavailable') }}</p>

        <div v-if="wants('preset')" class="cctl__field">
          <label class="cctl__field-label" for="camera-imaging-threshold-modal">{{ t('cameraControlUi.imagingThreshold') }}</label>
          <div class="cctl__threshold">
            <input
              id="camera-imaging-threshold-modal"
              v-model.number="manualThreshold"
              class="input cctl__number cctl__number--threshold"
              type="number"
              step="1"
              :disabled="busy || !canWrite"
              @input="markManualSettingsDirty"
            />
            <span class="cctl__unit">dB</span>
          </div>
          <p class="cctl__field-hint">{{ t('cameraControlUi.imagingThresholdHint') }}</p>
        </div>

      </div>

      <template #footer>
        <button type="button" class="btn" @click="closeDetectionSettings">{{ t('common.cancel') }}</button>
        <button
          type="button"
          class="btn btn--primary"
          :disabled="busy || !canWrite || settingsWorkModeDraft === null || manualBandError !== '' || manualThreshold === null"
          @click="applyDetectionSettings"
        >
          {{ t('common.save') }}
        </button>
      </template>
    </AppModal>

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
        Switching detection mode will delete/reset the current camera detection settings, including the
        frequency band, imaging threshold, detection regions and mode-specific parameters. Continue?
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


/* ---- Realtime control redesign ----------------------------------------- */
.cctl__top-header {
  align-items: center;
}

.cctl__header-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.cctl__alarm-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 26px;
  padding: 0 8px;
  border-radius: 999px;
  color: #b42318;
  background: #fff2f0;
  border: 1px solid #fecdca;
  font-size: 11px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.cctl__alarm-badge svg,
.cctl__icon-button svg {
  width: 16px;
  height: 16px;
}

.cctl__icon-button {
  appearance: none;
  display: inline-grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: 7px;
  color: var(--color-text-secondary);
  background: var(--color-bg);
  cursor: pointer;
}

.cctl__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 0;
  border-bottom: 1px solid var(--color-border);
}

.cctl__field:last-of-type {
  border-bottom: 0;
}

.cctl__field-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--color-text-secondary);
}

.cctl__select {
  width: 100%;
}

.cctl__field-hint,
.cctl__field-error {
  margin: 0;
  font-size: 10.5px;
  line-height: 1.45;
}

.cctl__field-hint {
  color: var(--color-text-secondary);
}

.cctl__field-error {
  color: var(--color-danger, #b42318);
}

.cctl__band-inputs,
.cctl__threshold,
.cctl__settings-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cctl__number {
  width: 92px;
  font-variant-numeric: tabular-nums;
}

.cctl__number--threshold {
  width: 112px;
}

.cctl__range-separator,
.cctl__unit {
  color: var(--color-text-secondary);
  font-size: 11px;
}

.cctl__settings-actions {
  padding-top: 2px;
}

.cctl__alarm-config-actions {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.cctl__alarm-config-actions .btn {
  min-width: 0;
  white-space: normal;
}

.cctl__icon-button--active {
  color: var(--color-accent, #ff6a1a);
  border-color: rgba(255, 106, 26, 0.42);
  background: rgba(255, 106, 26, 0.08);
}

/* Realtime Monitoring: one operational card, not a card inside a card. */
.cctl--realtime,
.cctl--realtime > .cctl__card {
  height: 100%;
  min-height: 0;
}

.cctl--realtime > .cctl__card {
  flex: 1 1 auto;
}

.cctl--realtime .cctl__board {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 0;
  min-height: 0;
}

.cctl--realtime .cctl__section {
  flex: 1 1 auto;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

.cctl--realtime .cctl__field--mode-settings {
  margin: 0 0 var(--space-2);
  padding: var(--space-3);
  border: 1px solid rgba(255, 106, 26, 0.24);
  border-radius: var(--radius-sm, 6px);
  background: rgba(255, 106, 26, 0.04);
}

.cctl--realtime .cctl__settings-actions {
  margin-bottom: var(--space-2);
}


.cctl--realtime .cctl__settings-actions--primary {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-2);
  margin: var(--space-2) 0;
}

.cctl--realtime .cctl__settings-actions--primary .btn {
  min-height: 34px;
  justify-content: center;
}

.cctl--realtime .cctl__detect-state {
  margin-top: auto;
  padding: var(--space-3) 0 var(--space-2);
  border-top: 1px solid var(--color-border);
}

.cctl--realtime .cctl__detect-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-2);
}

.cctl--realtime .cctl__detect-actions > span,
.cctl--realtime .cctl__detect-actions .btn {
  width: 100%;
}

.cctl--realtime .cctl__detect-actions .btn {
  min-height: 36px;
  justify-content: center;
}


/* 泄漏计算参数（业主 2026-09-24）：模式区块下面的紧凑表单。 */
.cctl__leakage {
  margin-top: var(--space-2);
}

.cctl__leakage-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-subtle);
}

.cctl__leakage-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2) var(--space-3);
}
</style>
