<script setup lang="ts">
/**
 * System settings (spec section 14.4).
 *
 * The view edits a local DRAFT and only writes it through
 * `settings.update(patch)` when the user saves. That keeps the store honest
 * (it never claims the main process accepted something it did not) and makes it
 * possible to cancel an edit — including a freshly picked storage directory.
 *
 * "最小剩余空间" is edited in GB but stored in bytes; 1 GB = 1073741824 bytes.
 * The conversion lives in `lib/format.ts` so no component does the arithmetic.
 */
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AppSettingsPatch } from '@shared/ipc/contract'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUiRefreshStore } from '@renderer/stores/uiRefresh'
import { RELEASE, formatVersion, parsePlainDate } from '@shared/release'

/**
 * Logo resolved by the bundler, so it is emitted with a content hash and survives
 * packaging into the asar archive.
 */
import logoUrl from '@renderer/assets/branding/hertzinno-logo.png'
import { useTrendsStore } from '@renderer/stores/trends'
import { useIngestStore } from '@renderer/stores/ingest'
import {
  MQTT_TELEMETRY_TOPIC,
  isBindAddress,
  isPort,
  telemetryPath
} from '@shared/domain/iot-ingest'
import {
  bytesToGb,
  formatBytes,
  formatDate,
  formatDateTime,
  formatGb,
  gbToBytes
} from '@renderer/lib/format'
import { resultMessage } from '@renderer/lib/result'
import EmptyState from '@renderer/components/EmptyState.vue'
import LanguageSelect from '@renderer/components/LanguageSelect.vue'
import LinkageSettingsSection from '@renderer/components/LinkageSettingsSection.vue'
import AccountManagementSection from '@renderer/components/AccountManagementSection.vue'
import AlarmSoundLibrarySection from '@renderer/components/AlarmSoundLibrarySection.vue'
import EmailSettingsSection from '@renderer/components/EmailSettingsSection.vue'
import AppModal from '@renderer/components/AppModal.vue'
import ChangePasswordDialog from '@renderer/components/ChangePasswordDialog.vue'
import { useSessionStore } from '@renderer/stores/session'

const { t } = useI18n()
const settings = useSettingsStore()
const uiRefresh = useUiRefreshStore()
/** Trend buffering counters live in the trends store, shared with the trend page. */
const trends = useTrendsStore()
/**
 * IoT 数据接入的**读数**（业主 2026-09-19 第 1 条）。
 *
 * 与配置分开：配置和这一页其它项一样走草稿 + 自动保存（那样改完端口立刻生效），
 * 而这个 store 只有"监听起没起来、收到多少"这些主进程才有答案的事实。
 */
const ingest = useIngestStore()
/** 当前登录的账号：设置页「账号」页签要显示它，并提供改密与退出登录（业主 ③）。 */
const session = useSessionStore()

/**
 * 页签（业主 2026-09-17 的 ③：把 语言 / 存储 / 视频 / 告警 / 邮箱 / 账号 / 关于
 * 做成**切换卡片页**）。
 *
 * 三个决定，都写在代码旁边免得下次被"优化"回去：
 *   1. 页签顺序按业主给的那一串（语言在最前：它是唯一一条改了立刻生效的设置）；
 *   2. 页签**不持久化**：设置页是一个"进来改一项就走"的地方，记住上次停在哪一页
 *      反而会让下次进来看到一页与预期无关的内容（默认永远落在「语言」）；
 *   3. 「设备探测」并进「视频与缓冲」这一页（业主 ④：探测与缓冲合成一组）——
 *      它们都是"这一路实时链路怎么工作"的参数，合成一页之后不必在七个页签之间来回跳。
 */
const TABS = [
  { id: 'language', labelKey: 'settingsUi.tabLanguage' },
  { id: 'storage', labelKey: 'settingsUi.tabStorage' },
  { id: 'video', labelKey: 'settingsUi.tabVideo' },
  { id: 'alarm', labelKey: 'settingsUi.tabAlarm' },
  { id: 'email', labelKey: 'settingsUi.tabEmail' },
  /**
   * 数据接入（业主 2026-09-19 第 1 条）。
   *
   * 排在「邮箱」之后、账号之前：前六页都是"我们怎么用数据"，这一页是"设备怎么把数据送进来"，
   * 而账号与关于属于另一类（身份 / 元信息）。`tests/settings-tabs.test.ts` 钉着这张表 ——
   * 加一个页签必须同时改那条守卫，否则它会红。
   */
  { id: 'iot', labelKey: 'settingsUi.tabIot' },
  { id: 'account', labelKey: 'settingsUi.tabAccount' },
  { id: 'about', labelKey: 'settingsUi.tabAbout' }
] as const
type SettingsTab = (typeof TABS)[number]['id']
const activeTab = ref<SettingsTab>('language')

/** 账号页签里的改密对话框（与侧栏账户菜单是同一个组件）。 */
const changePasswordOpen = ref(false)

function signOut(): void {
  void session.logout()
}

interface Draft {
  storageRoot: string
  retentionDays: number
  minFreeGb: number
  healthCheckIntervalMs: number
  offlineFailureThreshold: number
  requestTimeoutMs: number
  preAlarmSeconds: number
  postAlarmSeconds: number
  ringBufferSeconds: number
  /**
   * 开机自动播放相机实时视频。
   *
   * 与上面那些数值型草稿字段一样走「编辑草稿 -> 保存」的流程：勾选框只是草稿，
   * 点击保存才会写进主进程的设置表。
   */
  autoPlayCameraLive: boolean
  /**
   * IoT 数据接入（业主 2026-09-19 第 1 条：HTTP 推流 + MQTT）。
   *
   * 六个字段一起走同一个草稿与同一次保存（`patchFromDraft()` 只发 `iotIngest` 这一个键）：
   * 它们是**一块**配置，分成六次写会让监听被重起六遍（改端口那一次才真正需要重起）。
   */
  iotEnabled: boolean
  iotBindAddress: string
  iotHttpEnabled: boolean
  iotHttpPort: number
  iotMqttEnabled: boolean
  iotMqttPort: number
}

const draft = reactive<Draft>({
  storageRoot: '',
  retentionDays: 30,
  minFreeGb: 10,
  healthCheckIntervalMs: 5000,
  offlineFailureThreshold: 3,
  requestTimeoutMs: 5000,
  preAlarmSeconds: 10,
  postAlarmSeconds: 20,
  ringBufferSeconds: 60,
  autoPlayCameraLive: true,
  iotEnabled: false,
  iotBindAddress: '0.0.0.0',
  iotHttpEnabled: true,
  iotHttpPort: 8080,
  iotMqttEnabled: true,
  iotMqttPort: 1883
})

const formError = ref('')
const notice = ref('')
const copiedKey = ref('')
const picking = ref(false)
/** Trend panel: '立即落盘' progress and its result. */
const flushingTrends = ref(false)
const trendNotice = ref('')

/** Re-seed the draft whenever the store receives a fresh authoritative copy. */
function seedFromStore(): void {
  const current = settings.settings
  if (!current) return
  draft.storageRoot = current.storageRoot
  draft.retentionDays = current.retentionDays
  draft.minFreeGb = bytesToGb(current.minFreeBytes)
  draft.healthCheckIntervalMs = current.healthCheckIntervalMs
  draft.offlineFailureThreshold = current.offlineFailureThreshold
  draft.requestTimeoutMs = current.requestTimeoutMs
  draft.preAlarmSeconds = current.preAlarmSeconds
  draft.postAlarmSeconds = current.postAlarmSeconds
  draft.ringBufferSeconds = current.ringBufferSeconds
  draft.autoPlayCameraLive = current.autoPlayCameraLive
  const iot = current.iotIngest
  draft.iotEnabled = iot.enabled
  draft.iotBindAddress = iot.bindAddress
  draft.iotHttpEnabled = iot.httpEnabled
  draft.iotHttpPort = iot.httpPort
  draft.iotMqttEnabled = iot.mqttEnabled
  draft.iotMqttPort = iot.mqttPort
}

onMounted(async () => {
  await settings.load()
  seedFromStore()
  await settings.loadDiskUsage()
  // Read-only diagnostics; the trend writer lives in the main process and this
  // panel never configures it, it only reports what it is doing.
  void trends.loadStats()
  /** IoT 接入的读数（监听事实 + 收数统计）。与上面两个诊断读数同一类。 */
  void ingest.load()
})

watch(() => settings.settings, seedFromStore)

/**
 * 顶栏那颗唯一的刷新（业主 2026-09-19 更正第 4 条）：这一页里那两颗「刷新」
 * （磁盘占用 / 趋势存储）都删掉了，重读这两个诊断读数由它触发。
 */
watch(
  () => uiRefresh.tick,
  () => {
    void settings.loadDiskUsage()
    void trends.loadStats()
    void ingest.load()
  }
)

/**
 * 切到「存储」页签时**重读一次**两个诊断读数。
 *
 * 为什么需要它：那两个数（磁盘占用、趋势落盘计数）会随时间变，而它们原来各有一颗
 * 「刷新」按钮。按钮删掉之后，如果只在挂载时读一次，操作员在这一页上切换页签再回来
 * 会看到一个永远不会变的数字 —— 那比没有这个数更糟。
 */
watch(activeTab, (tab) => {
  if (tab !== 'storage') {
    /**
     * 切到「数据接入」页签也重读一次：这一页显示的是**运行读数**（监听状态、收到多少条），
     * 停在上次进页面时的值会让人以为服务没在收数据。
     */
    if (tab === 'iot') void ingest.load()
    return
  }
  void settings.loadDiskUsage()
  void trends.loadStats()
})

function validate(): string {
  if (!draft.storageRoot.trim()) return t('settingsUi.errStorageRoot')
  if (!Number.isInteger(draft.retentionDays) || draft.retentionDays < 1)
    return t('settingsUi.errRetentionDays')
  if (draft.minFreeGb < 0) return t('settingsUi.errMinFree')
  if (!Number.isInteger(draft.healthCheckIntervalMs) || draft.healthCheckIntervalMs < 1000)
    return t('settingsUi.errHealthCheck')
  if (!Number.isInteger(draft.offlineFailureThreshold) || draft.offlineFailureThreshold < 1)
    return t('settingsUi.errOfflineThreshold')
  if (!Number.isInteger(draft.requestTimeoutMs) || draft.requestTimeoutMs < 1000)
    return t('settingsUi.errRequestTimeout')
  if (draft.preAlarmSeconds < 0 || draft.postAlarmSeconds < 0) return t('settingsUi.errAlarmWindows')
  if (!Number.isInteger(draft.ringBufferSeconds) || draft.ringBufferSeconds < 1)
    return t('settingsUi.errRingBuffer')
  if (draft.ringBufferSeconds < draft.preAlarmSeconds + draft.postAlarmSeconds)
    return t('settingsUi.errRingBufferTooShort')
  /**
   * 数据接入（业主 2026-09-19 第 1 条）。
   *
   * 用**共享层**的判据（`isBindAddress` / `isPort`），与主进程归一化器同一份：
   * 界面允许写进去、主进程却回落到默认值，是这类设置最坏的一种失败。
   */
  if (!isBindAddress(draft.iotBindAddress.trim())) return t('iotUi.errBind')
  if (draft.iotHttpEnabled && !isPort(Number(draft.iotHttpPort))) return t('iotUi.errPort')
  if (draft.iotMqttEnabled && !isPort(Number(draft.iotMqttPort))) return t('iotUi.errPort')
  return ''
}

/**
 * 把草稿变成提交给主进程的补丁。保存与"草稿有没有变"两个判断共用它，
 * 免得两处各写一遍字段映射（漏一个字段就会出现"改了没保存"或"没改也在保存"）。
 */
function patchFromDraft(): AppSettingsPatch {
  return {
    storageRoot: draft.storageRoot.trim(),
    retentionDays: draft.retentionDays,
    minFreeBytes: gbToBytes(draft.minFreeGb),
    healthCheckIntervalMs: draft.healthCheckIntervalMs,
    offlineFailureThreshold: draft.offlineFailureThreshold,
    requestTimeoutMs: draft.requestTimeoutMs,
    preAlarmSeconds: draft.preAlarmSeconds,
    postAlarmSeconds: draft.postAlarmSeconds,
    ringBufferSeconds: draft.ringBufferSeconds,
    autoPlayCameraLive: draft.autoPlayCameraLive,
    /**
     * 六项**一起**提交（一个键）：主进程收到之后会按新配置重新对账监听，
     * 分开提交等于把监听重起六遍。
     */
    iotIngest: {
      enabled: draft.iotEnabled,
      bindAddress: draft.iotBindAddress.trim(),
      httpEnabled: draft.iotHttpEnabled,
      httpPort: Number(draft.iotHttpPort),
      mqttEnabled: draft.iotMqttEnabled,
      mqttPort: Number(draft.iotMqttPort)
    }
  }
}

/**
 * 草稿与**已存值**是否不同。
 *
 * 自动保存的安全阀，也是它敢做成"改了就存"的原因：`seedFromStore()` 把草稿逐字抄自 store，
 * 所以"回填之后"与"保存成功之后"这两个时刻草稿与 store 必然相同 ⇒ 那个 watcher 不会写盘。
 * 用「比较内容」而不是「一个 isSeeding 标志」是因为 watcher 默认在下一个 tick 才跑，
 * 标志在同步赋值结束时早就复位了——那是这类自动保存最经典的一个坑。
 */
function draftDiffersFromStore(): boolean {
  const current = settings.settings
  if (!current) return false
  const patch = patchFromDraft() as Record<string, unknown>
  return Object.keys(patch).some((key) => {
    const stored = (current as unknown as Record<string, unknown>)[key]
    const next = patch[key]
    /**
     * 嵌套块（`iotIngest`）**逐字段**比。
     *
     * `patchFromDraft()` 每次都新建那个对象，所以引用比较永远为真 —— 后果是"没改也在保存"，
     * 而保存会重启一次监听（设置变化的回调）。逐字段比才是"草稿与已存值是否不同"的原意。
     */
    if (next !== null && typeof next === 'object') {
      const before = stored as Record<string, unknown> | undefined
      if (!before) return true
      return Object.keys(next as Record<string, unknown>).some(
        (field) => before[field] !== (next as Record<string, unknown>)[field]
      )
    }
    return stored !== next
  })
}

/**
 * 自动保存（业主 2026-09-16：去掉「保存设置」按钮）。
 *
 * 防抖 600ms：一个数字输入框连续敲键时不该每敲一下就写一次库。非法值**不写**，
 * 只把错误留在 `formError` 里——把非法值写进去比不写更糟（下次打开软件就是坏的设置）。
 */
const AUTOSAVE_DEBOUNCE_MS = 600
let autosaveTimer = 0

function scheduleAutosave(): void {
  if (autosaveTimer) window.clearTimeout(autosaveTimer)
  autosaveTimer = window.setTimeout(() => {
    autosaveTimer = 0
    void persist()
  }, AUTOSAVE_DEBOUNCE_MS)
}

onUnmounted(() => {
  if (autosaveTimer) window.clearTimeout(autosaveTimer)
  autosaveTimer = 0
})

/**
 * 真的写下去。
 *
 * 不再有"保存成功"的横幅：自动保存每改一个字段就弹一次提示是噪音。**失败必须说话** ——
 * 静默失败的自动保存是最坏的一种：用户以为改好了，重启之后又变回去了。
 */
async function persist(): Promise<void> {
  const validation = validate()
  if (validation) {
    formError.value = validation
    return
  }
  formError.value = ''
  const saved = await settings.update(patchFromDraft())
  if (!saved) {
    formError.value = settings.error || t('settingsUi.saveFailed')
    return
  }
  // 回填一次：让草稿与 store 对齐（例如 storageRoot 被 trim 过），也顺手清掉"有差异"状态。
  seedFromStore()
  await settings.loadDiskUsage()
  /**
   * 保存之后**过一会儿再读一次接入读数**。
   *
   * 主进程是在设置写入的事件回调里重新起监听的（异步的 `listen()`），所以紧接着读回来的
   * 大概率还是上一份状态 —— 那会让"我刚开了它、屏幕上却写着未监听"。真实的结论仍然来自
   * 主进程报的 `listening`，这里的等待只是不去抢在那之前。
   */
  window.setTimeout(() => void ingest.load(), 250)
}

/** 草稿一变就排一次自动保存；回填与保存成功造成的变化会被 `draftDiffersFromStore()` 挡掉。 */
watch(draft, () => {
  if (!draftDiffersFromStore()) return
  const validation = validate()
  if (validation) {
    // 非法值先把话说清楚，但仍然排一次保存：用户把 0 改回 5 之后那一次会被排上。
    formError.value = validation
  }
  scheduleAutosave()
})

async function browse(): Promise<void> {
  picking.value = true
  const picked = await settings.pickStorageDir()
  picking.value = false
  if (picked) {
    draft.storageRoot = picked
    notice.value = t('settingsUi.browsePicked')
  } else if (settings.error) {
    formError.value = settings.error
  }
}

async function copy(text: string, key: string): Promise<void> {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    copiedKey.value = key
    window.setTimeout(() => {
      if (copiedKey.value === key) copiedKey.value = ''
    }, 1600)
  } catch {
    formError.value = t('settingsUi.copyFailed')
  }
}

// ---------------------------------------------------------------------------
// Trend storage panel (Phase 11)
// ---------------------------------------------------------------------------

/**
 * Force a trend batch write.
 *
 * Spec §12.1 buffers feature rows in memory and flushes every 60 s or 1000 rows;
 * closing the app is exactly the moment an operator wants to be sure nothing is
 * still buffered, so the button exists next to the counters it changes.
 */
async function flushTrends(): Promise<void> {
  flushingTrends.value = true
  const written = await trends.flush()
  flushingTrends.value = false
  if (!written) {
    trendNotice.value = ''
    return
  }
  trendNotice.value =
    written.rows > 0
      ? t('settingsUi.trendWrote', { rows: written.rows, files: written.files })
      : t('settingsUi.trendNothing')
}

// ---------------------------------------------------------------------------
// Disk usage derived values
// ---------------------------------------------------------------------------

const disk = computed(() => settings.diskUsage)

const usedBytes = computed(() => {
  const usage = disk.value
  if (!usage) return 0
  return Math.max(0, usage.totalBytes - usage.freeBytes)
})

const usedPercent = computed(() => {
  const usage = disk.value
  if (!usage || usage.totalBytes <= 0) return 0
  return Math.min(100, Math.round((usedBytes.value / usage.totalBytes) * 100))
})

const appPercent = computed(() => {
  const usage = disk.value
  if (!usage || usage.totalBytes <= 0) return 0
  return Math.min(100, Math.round((usage.usedByAppBytes / usage.totalBytes) * 100))
})

const info = computed(() => settings.appInfo)

const versionText = computed(() =>
  info.value?.version ? formatVersion(info.value.version) : t('app.versionFallback')
)

/**
 * Release and build dates, formatted for the active locale.
 *
 * The shared layer's old `formatReleaseDate` wrote a Chinese-style
 * `2026 年 9 月 11 日`, which is wrong in an English, Spanish or Turkish UI; it has
 * been removed. `parsePlainDate` reads `YYYY-MM-DD` as a LOCAL calendar date (a
 * bare `new Date('2026-09-11')` is UTC midnight and shows the previous day west of
 * Greenwich) and `formatDate` renders it through Intl. Both computeds re-evaluate
 * on a language change, so the About panel follows the switch without a reload.
 */
const releaseText = computed(() => {
  const parsed = parsePlainDate(info.value?.releaseDate)
  return parsed ? t('app.releasedOn', { date: formatDate(parsed.getTime()) }) : ''
})

/**
 * Build date is shown only when it differs from the release date.
 *
 * On a normal release they are equal and a second identical date is noise; on a
 * development build the difference is exactly what tells you the binary is not
 * the released artifact.
 */
const buildText = computed(() => {
  const build = info.value?.buildDate ?? ''
  const release = info.value?.releaseDate ?? ''
  if (!build || build === release) return ''
  const parsed = parsePlainDate(build)
  return parsed ? t('app.builtOn', { date: formatDate(parsed.getTime()) }) : ''
})

/** Open a link through the main process, which validates the scheme. */
async function openLink(url: string): Promise<void> {
  const result = await window.api.app.openExternal(url)
  if (!result.success) settings.setError(resultMessage(result))
}

const APP_INFO_ROWS = computed(() => [
  { key: 'version', label: t('app.appVersion'), value: info.value?.version ?? '', copyable: false },
  { key: 'releaseDate', label: t('app.releaseDate'), value: info.value?.releaseDate ?? '', copyable: false },
  { key: 'buildDate', label: t('app.buildDate'), value: info.value?.buildDate ?? '', copyable: false },
  { key: 'electron', label: 'Electron', value: info.value?.electronVersion ?? '', copyable: false },
  { key: 'chrome', label: 'Chrome', value: info.value?.chromeVersion ?? '', copyable: false },
  { key: 'node', label: 'Node', value: info.value?.nodeVersion ?? '', copyable: false },
  {
    key: 'platform',
    label: t('app.operatingSystem'),
    value: info.value ? `${info.value.platform} (${info.value.arch})` : '',
    copyable: false
  },
  { key: 'database', label: t('app.databasePath'), value: info.value?.databasePath ?? '', copyable: true },
  { key: 'storage', label: t('app.storageRootPath'), value: info.value?.storageRoot ?? '', copyable: true }
])

// ---------------------------------------------------------------------------
// 数据接入（业主 2026-09-19 第 1 条）
// ---------------------------------------------------------------------------

/**
 * 推流路径的样例（秘钥位置用**语言无关**的占位符）。
 *
 * 路径形状只能有一处定义（共享层的 `telemetryPath()`），界面不自己拼字符串 —— 否则
 * 「设备该往哪推」与「服务认哪条路径」会各有一份，而那两份只要差一个斜杠就是 404。
 */
const iotHttpPathSample = telemetryPath('<secret>')
const iotMqttTopic = MQTT_TELEMETRY_TOPIC

/**
 * 两个通道用同一个端口是**冲突**而不是非法值：归一化器不替用户改端口（改哪一个都是猜测），
 * 服务那边会各自报 `EADDRINUSE`。界面上先说一句，省得用户去看两条错误码。
 */
const iotPortConflict = computed(
  () =>
    draft.iotHttpEnabled &&
    draft.iotMqttEnabled &&
    Number(draft.iotHttpPort) === Number(draft.iotMqttPort)
)

/** 一个监听的读数文案：关着 / 没监听 / 监听中。 */
function listenerText(listener?: {
  enabled: boolean
  listening: boolean
  address?: string
  port?: number
}): string {
  if (!listener) return t('iotUi.loadFailed')
  if (!listener.enabled) return t('iotUi.statusOff')
  if (listener.listening) {
    return t('iotUi.listening', { address: listener.address ?? '—', port: listener.port ?? '—' })
  }
  return t('iotUi.notListening')
}

const iotLastAtText = computed(() => {
  const at = ingest.status?.stats.lastAt
  return at ? formatDateTime(at) : t('iotUi.statsNever')
})

// ---------------------------------------------------------------------------
// 一键恢复默认值（手册 §17.2 第 5227 行）
// ---------------------------------------------------------------------------

/**
 * 将被重置的项，**逐项列出来**给用户确认。
 *
 * 为什么是硬编码的一张清单而不是从主进程读：主进程那边是
 * `SettingsService.RESTORABLE_SETTING_KEYS`（十三个键），而这里要显示的是
 * **人能读懂的每一项名称**。两者的对应关系由 `tests/account-settings.test.ts`
 * 钉住（它断言这张清单的键集合与主进程那份**完全相同**），所以「加了新设置项却
 * 忘了写进确认对话框」会是一条失败的测试，而不是一次静默的重置。
 *
 * `settingsUi.restoreItems` 里的每一条按这个顺序显示。
 */
const RESTORE_ITEMS = computed(() => [
  t('settingsUi.restoreItemStorage'),
  t('settingsUi.restoreItemRetention'),
  t('settingsUi.restoreItemMinFree'),
  t('settingsUi.restoreItemHealthCheck'),
  t('settingsUi.restoreItemOfflineThreshold'),
  t('settingsUi.restoreItemRequestTimeout'),
  t('settingsUi.restoreItemPreAlarm'),
  t('settingsUi.restoreItemPostAlarm'),
  t('settingsUi.restoreItemRingBuffer'),
  t('settingsUi.restoreItemAutoPlay'),
  t('settingsUi.restoreItemMaxStreams'),
  t('settingsUi.restoreItemAlarmLinkage'),
  t('settingsUi.restoreItemAlarmSounds'),
  /** 数据接入（业主 2026-09-19 第 1 条）：恢复默认会把监听**关掉**，所以必须列出来。 */
  t('settingsUi.restoreItemIotIngest')
])

const restoreOpen = ref(false)
const restoring = ref(false)
const restoreError = ref('')
const restoreNotice = ref('')

function openRestore(): void {
  restoreError.value = ''
  restoreNotice.value = ''
  restoreOpen.value = true
}

/**
 * 恢复默认值。
 *
 * 写入**只**走 `settings.restoreDefaults()`：它不接受参数，被重置的键由主进程
 * 定义。所以这个对话框是「确认一次」而不是「描述一次要写什么」—— 界面无法通过
 * 这个按钮多写一个键。
 */
async function confirmRestore(): Promise<void> {
  restoring.value = true
  restoreError.value = ''
  const ok = await settings.restoreDefaults()
  restoring.value = false
  if (!ok) {
    restoreError.value = settings.error || t('settingsUi.saveFailed')
    return
  }
  // 主进程回的是**读回来**的那一份，所以这里重新播种草稿就够，不必自己填默认值。
  seedFromStore()
  await settings.loadDiskUsage()
  restoreOpen.value = false
  restoreNotice.value = t('settingsUi.restoreNotice')
}
</script>

<template>
  <div class="page">
    <!--
      这一页**没有页头**：外层框架的标题栏已经写了「系统设置」，而「恢复默认值」按产品要求
      挪到了页面最底部（见文件末尾那张卡片）。
    -->

    <p v-if="formError" class="alert alert--danger" role="alert">{{ formError }}</p>
    <p v-else-if="notice" class="alert alert--success" role="status">{{ notice }}</p>
    <p v-if="restoreNotice" class="alert alert--success" role="status">{{ restoreNotice }}</p>
    <p v-if="settings.error && !formError" class="alert alert--danger" role="alert">
      {{ settings.error }}
    </p>

    <EmptyState
      v-if="!settings.loaded && !settings.loading"
      :title="t('settingsUi.loadFailedTitle')"
    >
      <button type="button" class="btn" @click="settings.load()">{{ t('settingsUi.reload') }}</button>
    </EmptyState>

    <template v-else>
      <!--
        页签（业主 2026-09-17 的 ③）。`role="tablist"` + `role="tab"` + `aria-selected`
        不是装饰：屏幕阅读器要能说出"这是七个页签中的第几个、当前选中哪个"。
        读屏名称用**这一页的标题**（`app.nav.settings`，与路由 meta 同一个键）——
        `settingsUi.title` 这个键从来不存在，第一版写成它会让 aria-label 变成裸 key。
      -->
      <nav class="settings-tabs" role="tablist" :aria-label="t('app.nav.settings')">
        <button
          v-for="tab in TABS"
          :key="tab.id"
          type="button"
          role="tab"
          class="settings-tab"
          :class="{ 'settings-tab--active': activeTab === tab.id }"
          :aria-selected="activeTab === tab.id"
          :data-tab="tab.id"
          @click="activeTab = tab.id"
        >
          {{ t(tab.labelKey) }}
        </button>
      </nav>

      <!--
        语言：这一张卡片**没有标题** —— 页签已经写着「语言」了（业主 ③：不要每张卡片都写名字）。
        它是唯一一条「改了立刻生效、而且不需要保存」的设置，所以单独一页。
      -->
      <section v-if="activeTab === 'language'" class="card settings-panel" role="tabpanel">
        <div class="settings-language">
          <LanguageSelect />
        </div>
      </section>

      <section
        v-if="activeTab === 'storage'"
        class="card settings-panel"
        role="tabpanel"
      >
        <div class="settings-group">
          <span class="settings-group__title">{{ t('settingsUi.storageGroupLocation') }}</span>

          <div class="field">
            <span class="field-label">{{ t('settingsUi.storagePath') }}</span>
            <div class="path-row">
              <input v-model="draft.storageRoot" class="input mono" type="text" spellcheck="false" />
              <button type="button" class="btn" :disabled="picking" @click="browse">
                {{ picking ? t('settingsUi.picking') : t('settingsUi.browse') }}
              </button>
            </div>
          </div>

          <div class="form-grid settings-grid">
            <label class="field">
              <span class="field-label">{{ t('settingsUi.retentionDays') }}</span>
              <input v-model.number="draft.retentionDays" class="input" type="number" min="1" />
            </label>

            <label class="field">
              <span class="field-label">{{ t('settingsUi.minFreeGb') }}</span>
              <input v-model.number="draft.minFreeGb" class="input" type="number" min="0" step="0.5" />
            </label>
          </div>
        </div>
      </section>

      <!--
        视频与缓冲（业主 ③ 的「视频」页；④ 要求**设备探测与缓冲合成一组**）。

        一张卡片、两组：实时视频（一条自动起播）与「设备探测与缓冲」（六个数）。
        合成一组不是排版偏好：这六个数服务的是同一条实时链路 —— 探测决定"多久问一次设备、
        几次不通算离线、一次请求等多久"，缓冲决定"告警前后各留多久、环形缓冲开多大"。
        拆成两张卡片时，操作员要在两张卡之间来回看着改（而它们互相约束：缓冲必须不小于
        告警前 + 告警后，这条校验就写在下面的 `validate()` 里）。
      -->
      <section v-if="activeTab === 'video'" class="card settings-panel" role="tabpanel">
        <div class="settings-group">
          <span class="settings-group__title">{{ t('settingsUi.liveSection') }}</span>
          <div class="field">
            <span class="field-label">{{ t('settingsUi.autoPlayCameraLive') }}</span>
            <!--
              勾选框只是草稿，自动保存（600ms 防抖）之后才会写进主进程。
              文案说明它**只在相机确实在工作时**才会起播，也说明手动停止优先——
              否则操作员会以为关掉它才是唯一能让它不自动播的办法。
            -->
            <label class="toggle">
              <input v-model="draft.autoPlayCameraLive" type="checkbox" />
              <span>
                {{
                  draft.autoPlayCameraLive
                    ? t('settingsUi.autoPlayOn')
                    : t('settingsUi.autoPlayOff')
                }}
              </span>
            </label>
          </div>
        </div>

        <div class="settings-group">
          <span class="settings-group__title">{{ t('settingsUi.probeBufferGroup') }}</span>
          <div class="form-grid">
            <label class="field">
              <span class="field-label">{{ t('settingsUi.healthCheckMs') }}</span>
              <input
                v-model.number="draft.healthCheckIntervalMs"
                class="input"
                type="number"
                min="1000"
                step="500"
              />
            </label>
            <label class="field">
              <span class="field-label">{{ t('settingsUi.offlineThreshold') }}</span>
              <input
                v-model.number="draft.offlineFailureThreshold"
                class="input"
                type="number"
                min="1"
              />
            </label>
            <label class="field">
              <span class="field-label">{{ t('settingsUi.requestTimeoutMs') }}</span>
              <input
                v-model.number="draft.requestTimeoutMs"
                class="input"
                type="number"
                min="1000"
                step="500"
              />
            </label>
            <label class="field">
              <span class="field-label">{{ t('settingsUi.preAlarmSeconds') }}</span>
              <input v-model.number="draft.preAlarmSeconds" class="input" type="number" min="0" />
            </label>
            <label class="field">
              <span class="field-label">{{ t('settingsUi.postAlarmSeconds') }}</span>
              <input v-model.number="draft.postAlarmSeconds" class="input" type="number" min="0" />
            </label>
            <label class="field">
              <span class="field-label">{{ t('settingsUi.ringBufferSeconds') }}</span>
              <input v-model.number="draft.ringBufferSeconds" class="input" type="number" min="1" />
            </label>
          </div>
        </div>
      </section>

      <section
        v-if="activeTab === 'storage'"
        class="card settings-panel"
        role="tabpanel"
      >
        <div class="settings-group__head">
          <span class="settings-group__title">{{ t('settingsUi.diskSection') }}</span>
          <!-- 这一颗「刷新」已删（业主 2026-09-19 更正第 4 条）：切到这个页签会重读一次，
               顶栏那颗唯一的刷新也会重读这两个诊断读数。 -->
        </div>

        <p v-if="disk?.belowSafetyFloor" class="alert alert--danger" role="alert">
          {{ t('settingsUi.diskBelowFloor') }}
        </p>

        <div v-if="!disk" class="muted">{{ t('settingsUi.diskUnavailable') }}</div>
        <template v-else>
          <div class="bar" role="img" :aria-label="t('settingsUi.diskBarLabel', { percent: usedPercent })">
            <div
              class="bar__fill"
              :class="{ 'bar__fill--danger': disk.belowSafetyFloor }"
              :style="{ width: `${usedPercent}%` }"
            ></div>
          </div>
          <dl class="kv disk-kv">
            <div class="kv__item">
              <dt class="kv__label">{{ t('settingsUi.diskUsedOfTotal') }}</dt>
              <dd class="kv__value">
                {{
                  t('settingsUi.diskUsedValue', {
                    used: formatBytes(usedBytes),
                    total: formatBytes(disk.totalBytes),
                    percent: usedPercent
                  })
                }}
              </dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('settingsUi.diskFree') }}</dt>
              <dd class="kv__value">
                {{ t('settingsUi.diskFreeValue', { bytes: formatBytes(disk.freeBytes), gb: formatGb(disk.freeBytes) }) }}
              </dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('settingsUi.diskAppUsage') }}</dt>
              <dd class="kv__value">
                {{ t('settingsUi.diskAppUsageValue', { bytes: formatBytes(disk.usedByAppBytes), percent: appPercent }) }}
              </dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('app.storageRootPath') }}</dt>
              <dd class="kv__value mono">{{ disk.storageRoot }}</dd>
            </div>
          </dl>
        </template>
      </section>

      <section
        v-if="activeTab === 'storage'"
        class="card settings-panel"
        role="tabpanel"
      >
        <div class="settings-group__head">
          <span class="settings-group__title">{{ t('settingsUi.trendSection') }}</span>
          <div class="btn-row">
            <!-- 「刷新」那一颗已删（业主 2026-09-19 更正第 4 条）：切到页签与顶栏刷新都会重读。
                 「立即落盘」留着 —— 它不是刷新，是让主进程把缓冲写进库。 -->
            <button
              type="button"
              class="btn btn--sm"
              :disabled="flushingTrends"
              @click="flushTrends"
            >
              {{ flushingTrends ? t('settingsUi.trendFlushing') : t('settingsUi.trendFlushNow') }}
            </button>
          </div>
        </div>

        <p v-if="trends.error && !trendNotice" class="alert alert--danger" role="alert">
          {{ trends.error }}
        </p>
        <p v-else-if="trendNotice" class="alert alert--success" role="status">{{ trendNotice }}</p>

        <div v-if="!trends.stats" class="muted">{{ t('settingsUi.trendUnavailable') }}</div>
        <template v-else>
          <dl class="kv">
            <div class="kv__item">
              <dt class="kv__label">{{ t('settingsUi.trendBuffered') }}</dt>
              <dd class="kv__value">{{ t('settingsUi.rows', { count: trends.stats.bufferedRows }) }}</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('settingsUi.trendFilesWritten') }}</dt>
              <dd class="kv__value">{{ t('settingsUi.files', { count: trends.stats.filesWritten }) }}</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('settingsUi.trendRowsWritten') }}</dt>
              <dd class="kv__value">{{ t('settingsUi.rows', { count: trends.stats.rowsWritten }) }}</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('settingsUi.trendLastFlush') }}</dt>
              <dd class="kv__value">
                {{ trends.stats.lastFlushAt ? formatDateTime(trends.stats.lastFlushAt) : t('settingsUi.trendNeverFlushed') }}
              </dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('settingsUi.trendLastError') }}</dt>
              <dd class="kv__value" :class="{ 'text-danger': !!trends.stats.lastError }">
                {{ trends.stats.lastError || t('common.none') }}
              </dd>
            </div>
          </dl>
        </template>
      </section>

      <!--
        告警联动（录像 / 弹窗 / 提示 / 邮件）。
        
        独立组件而不是并进本文件：这一块有二十多个字段、自己的草稿与「测试邮件」
        流程，而它保存时只发 `alarmLinkage` 这一个键，因此与上面的草稿互不干扰。
      -->
      <template v-if="activeTab === 'alarm'">
        <LinkageSettingsSection />

      <!--
        告警声音库（手册 §17.2.7）与邮件设置（手册 §17.2.8）。

        三块各发**一个** patch 键（`alarmSounds` / `alarmLinkage` / `alarmLinkage`），
        所以它们互不覆盖；放在联动那一块旁边，是因为它们服务的正是同一件事
        （告警发生时出什么声、发什么邮件）。
      -->
        <AlarmSoundLibrarySection />
      </template>

      <!-- 邮箱页签（手册 §17.2.8）：邮件服务器与告警收件人。 -->
      <EmailSettingsSection v-if="activeTab === 'email'" />

      <!--
        数据接入（业主 2026-09-19 第 1 条：HTTP 推流 + MQTT）。

        这一页是**入站**那一侧：本机开两个监听，等设备把数据推上来。三组内容按现场要回答的
        三个问题排：能不能接（开关 / 地址 / 端口）、接成什么样（监听状态）、接到没有（收数统计）。
        秘钥与逐设备的推流地址在**设备对话框**里（那里才知道是哪一台设备）。
      -->
      <section v-if="activeTab === 'iot'" class="card settings-panel" role="tabpanel">
        <div class="settings-group" data-iot-section>
          <span class="settings-group__title">{{ t('settingsUi.tabIot') }}</span>

          <div class="field">
            <!--
              **总开关不再是操作员拨的**（业主 2026-09-19 第 13 批第 1 条：把数据接入搬进
              「添加设备」）。它现在由**设备声明**派生：库里有没有设备声明 http / mqtt
              （`DeviceService.syncIngest()` → `syncIngestFromDevices()`），
              所以这一格是**只读显示**，勾没勾说的是事实而不是一个可以被改掉的选项。

              为什么留着这一格而不是删掉：这一页还要显示端口、监听状态与收数统计 ——
              那些说的是"怎么听"和"收到了什么"，与"谁在推"是两件不同的事。
              下一轮把端口也搬进添加设备那个对话框（见 §15.77 的落地顺序）。
            -->
            <label class="toggle">
              <input
                v-model="draft.iotEnabled"
                type="checkbox"
                disabled
                data-iot-enable
                :data-iot-enable-derived="ingest.status?.config.enabled ? 'on' : 'off'"
              />
              <span>{{ t('iotUi.enableLabel') }}</span>
            </label>
            <span class="field-hint">{{ t('iotUi.enableHint') }}</span>
            <span class="field-hint" data-iot-enable-derived-hint>{{ t('iotUi.enableDerived') }}</span>
          </div>
        </div>

        <div class="settings-group">
          <span class="settings-group__title">{{ t('iotUi.httpGroup') }}</span>

          <div class="field">
            <label class="toggle">
              <input v-model="draft.iotHttpEnabled" type="checkbox" data-iot-http-enable />
              <span>{{ t('iotUi.httpEnable') }}</span>
            </label>
          </div>

          <div class="form-grid">
            <label class="field">
              <span class="field-label">{{ t('iotUi.bindLabel') }}</span>
              <input
                v-model="draft.iotBindAddress"
                class="input mono"
                type="text"
                spellcheck="false"
                data-iot-bind
              />
              <span class="field-hint">{{ t('iotUi.bindHint') }}</span>
            </label>
            <label class="field">
              <span class="field-label">{{ t('iotUi.httpPortLabel') }}</span>
              <input
                v-model.number="draft.iotHttpPort"
                class="input"
                type="number"
                min="1"
                max="65535"
                data-iot-http-port
              />
            </label>
            <div class="field">
              <span class="field-label">{{ t('iotUi.httpPathLabel') }}</span>
              <span class="mono iot-value">{{ iotHttpPathSample }}</span>
            </div>
          </div>
        </div>

        <div class="settings-group">
          <span class="settings-group__title">{{ t('iotUi.mqttGroup') }}</span>

          <div class="field">
            <label class="toggle">
              <input v-model="draft.iotMqttEnabled" type="checkbox" data-iot-mqtt-enable />
              <span>{{ t('iotUi.mqttEnable') }}</span>
            </label>
            <span class="field-hint">{{ t('iotUi.mqttUserHint') }}</span>
          </div>

          <div class="form-grid">
            <label class="field">
              <span class="field-label">{{ t('iotUi.mqttPortLabel') }}</span>
              <input
                v-model.number="draft.iotMqttPort"
                class="input"
                type="number"
                min="1"
                max="65535"
                data-iot-mqtt-port
              />
            </label>
            <div class="field">
              <span class="field-label">{{ t('iotUi.mqttTopicLabel') }}</span>
              <span class="mono iot-value" data-iot-mqtt-topic>{{ iotMqttTopic }}</span>
            </div>
          </div>
        </div>

        <p v-if="iotPortConflict" class="alert alert--warning" role="alert" data-iot-conflict>
          {{ t('iotUi.portConflict', { port: draft.iotHttpPort }) }}
        </p>

        <div class="settings-group">
          <span class="settings-group__title">{{ t('iotUi.statusGroup') }}</span>

          <p v-if="ingest.error" class="alert alert--danger" role="alert">{{ ingest.error }}</p>

          <dl class="kv">
            <div class="kv__item">
              <dt class="kv__label">{{ t('iotUi.httpGroup') }}</dt>
              <dd class="kv__value" data-iot-http-status>
                {{ listenerText(ingest.status?.http) }}
                <span v-if="ingest.status?.http.error" class="text-danger">
                  （{{ ingest.status.http.error }}）
                </span>
              </dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('iotUi.mqttGroup') }}</dt>
              <dd class="kv__value" data-iot-mqtt-status>
                {{ listenerText(ingest.status?.mqtt) }}
                <span v-if="ingest.status?.mqtt.error" class="text-danger">
                  （{{ ingest.status.mqtt.error }}）
                </span>
              </dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('iotUi.secretLabel') }}</dt>
              <dd class="kv__value" data-iot-secret-count>
                {{ t('iotUi.devicesWithSecret', { count: ingest.status?.devicesWithSecret ?? 0 }) }}
              </dd>
            </div>
          </dl>

          <dl class="kv" data-iot-stats>
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
            <div class="kv__item">
              <dt class="kv__label">{{ t('iotUi.statsLastAt') }}</dt>
              <dd class="kv__value">{{ iotLastAtText }}</dd>
            </div>
          </dl>

          <p v-if="ingest.status?.stats.lastUnrecognised?.length" class="field-hint" data-iot-unrecognised>
            {{ t('iotUi.lastUnrecognised', { keys: ingest.status.stats.lastUnrecognised.join(', ') }) }}
          </p>

          <div class="field">
            <span class="field-label">{{ t('iotUi.localAddressesLabel') }}</span>
            <div v-if="ingest.status?.localAddresses.length" class="iot-addresses">
              <span
                v-for="item in ingest.status.localAddresses"
                :key="item.address"
                class="mono iot-value"
              >
                {{ item.address }}（{{ item.iface }}）
              </span>
            </div>
            <span v-else class="field-hint">{{ t('iotUi.noLocalAddresses') }}</span>
          </div>

          <p class="field-hint">{{ t('iotUi.manualNote') }}</p>
          <p v-if="settings.settings && !settings.settings.iotIngest.enabled" class="field-hint">
            {{ t('iotUi.serviceOff') }}
          </p>
        </div>
      </section>

      <!--
        账号管理（手册 §17.1）。

        它落在设置页里，因为手册第 5173–5174 行把它列在同一个工具菜单下
        （Tool -> Account Management），而这一页就是那个菜单在软件里的落点。
      -->
      <!--
        账号页签（业主 ③：「账号页签承接退出登录」）。

        上：账号管理（手册 §17.1：Tool -> Account Management，本页就是那个菜单的落点）。
        下：**当前会话** —— 谁在登录、改密码、退出登录。这两个动作原来只在侧栏底部那个
        账户菜单里；搬进来之后「账号」这一页就是账号相关动作的**唯一**去处。
        改密对话框与侧栏那个是**同一个组件**（`ChangePasswordDialog`），密码校验只有一处。
      -->
      <template v-if="activeTab === 'account'">
        <AccountManagementSection />

        <section class="card settings-panel" role="tabpanel">
          <div class="settings-group">
            <span class="settings-group__title">{{ t('settingsUi.accountSessionGroup') }}</span>
            <dl class="kv">
              <div class="kv__item">
                <dt class="kv__label">{{ t('authUi.signedInAs') }}</dt>
                <dd class="kv__value">
                  {{ session.displayName }} ·
                  {{ t(`domain.userRole.${session.session?.user.role ?? 'operator'}`) }}
                </dd>
              </div>
            </dl>
            <div class="btn-row">
              <button
                type="button"
                class="btn btn--sm"
                data-action="change-password"
                @click="changePasswordOpen = true"
              >
                {{ t('authUi.changeTitle') }}
              </button>
              <!-- 退出登录用危险色：它是这一页唯一的"会把你踢出去"的动作。 -->
              <button
                type="button"
                class="btn btn--sm btn--danger"
                data-action="sign-out"
                @click="signOut"
              >
                {{ t('authUi.signOut') }}
              </button>
            </div>
          </div>
        </section>
      </template>

      <ChangePasswordDialog v-model="changePasswordOpen" />

      <section v-if="activeTab === 'about'" class="card settings-panel" role="tabpanel">
        <!--
          关于页签：这一张卡片**没有标题**（页签已经写着「关于与维护」了）。
          Brand block. The logo fills the card width rather than sitting at its
          intrinsic 224 px: the wordmark is the recognisable part and reads better
          larger, and `object-fit: contain` keeps the aspect ratio honest.
        -->
        <div class="about-brand">
          <img class="about-brand__logo" :src="logoUrl" alt="HERTZINNO" />
          <div class="about-brand__meta">
            <div class="about-brand__name">HERTZINNO Acoustic Box Manager</div>
            <div class="about-brand__version">
              {{ versionText }}
              <template v-if="releaseText">
                <span class="about-brand__sep">·</span>
                <span>{{ releaseText }}</span>
              </template>
            </div>
            <div v-if="buildText" class="about-brand__build">{{ buildText }}</div>
          </div>
        </div>

        <!-- Contact: same reasoning as the sidebar — routed through the main
             process because the renderer's CSP forbids external navigation. -->
        <div class="about-contact">
          <button type="button" class="btn btn--sm" @click="openLink(RELEASE.homepage)">
            www.hertzinno.com
          </button>
          <button
            type="button"
            class="btn btn--sm"
            @click="openLink(`mailto:${RELEASE.supportEmail}`)"
          >
            {{ RELEASE.supportEmail }}
          </button>
        </div>

        <dl class="kv">
          <div v-for="row in APP_INFO_ROWS" :key="row.key" class="kv__item">
            <dt class="kv__label">{{ row.label }}</dt>
            <dd class="kv__value">
              <span class="mono">{{ row.value || '—' }}</span>
              <button
                v-if="row.copyable && row.value"
                type="button"
                class="btn btn--sm btn--ghost copy-btn"
                @click="copy(row.value, row.key)"
              >
                {{ copiedKey === row.key ? t('app.copiedPath') : t('app.copyPath') }}
              </button>
            </dd>
          </div>
        </dl>
      </section>

      <!--
        维护组（「恢复默认值」）落在**关于页签**里（业主 ③ 把这一页叫「关于与维护」）。

        它原来在整页最底部（业主 2026-09-16：「应该放在最底部，避免影响排版」）。
        拆页签之后"最底部"的语义变成"关于这一页的最后"：它仍然是**读完整页之后**才做的决定，
        而不再与语言/存储这些**编辑项**混在一条长列里。
        确认对话框仍然逐项列出 13 项范围（见下面 `AppModal`），这一条没有变。
      -->
      <section v-if="activeTab === 'about'" class="card settings-panel" role="tabpanel">
        <div class="danger-action">
          <!--
            这里**故意不写那句"会重置哪些、不会动哪些"的说明**：确认对话框已经逐项列出 13 项
            范围、并明确写了哪些东西不会被动（见下面 `AppModal`）。同一件事写两遍，改一处就会
            不一致——而这一页刚刚才因为"每张卡片都写名字"被要求去掉重复。
          -->
          <span class="danger-action__title">{{ t('settingsUi.restoreDefaults') }}</span>
          <button
            type="button"
            class="btn"
            data-action="restore-defaults"
            :disabled="settings.loading || settings.saving"
            @click="openRestore"
          >
            {{ t('settingsUi.restoreDefaults') }}
          </button>
        </div>
      </section>
    </template>

    <!--
      一键恢复默认值的确认对话框（手册 §17.2 的 Default Value）。

      它**必须**存在，而且必须逐项列出范围：这个按钮会覆盖整页系统设置，
      而「范围只包括系统设置项」这件事只有写在用户看得见的地方才算数。
      对话框还显式说明哪些东西**不会**被动（设备列表、通道、录像/录音文件、
      告警记录、账号），因为那才是用户真正担心的问题。
    -->
    <AppModal v-model="restoreOpen" :title="t('settingsUi.restoreTitle')" width="560px">
      <p>{{ t('settingsUi.restoreIntro') }}</p>
      <ul class="restore-list" data-restore-items>
        <li v-for="item in RESTORE_ITEMS" :key="item">{{ item }}</li>
      </ul>
      <p class="alert alert--warning" role="note">{{ t('settingsUi.restoreWarnStorage') }}</p>
      <p>{{ t('settingsUi.restoreKeeps') }}</p>
      <p v-if="restoreError" class="alert alert--danger" role="alert">{{ restoreError }}</p>

      <template #footer>
        <button type="button" class="btn" :disabled="restoring" @click="restoreOpen = false">
          {{ t('common.cancel') }}
        </button>
        <button
          type="button"
          class="btn btn--danger"
          data-action="confirm-restore-defaults"
          :disabled="restoring"
          @click="confirmRestore"
        >
          {{ restoring ? t('common.saving') : t('settingsUi.restoreConfirm') }}
        </button>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
/*
 * 页签（业主 ③）。
 *
 * 为什么不复用全局的 `.chip` / 页签样式：那些是**筛选器**（可多选、可取消），
 * 而这里是**互斥的页面切换**，必须带 `role="tab"` / `aria-selected`。
 * 下划线式而不是按钮式：一排七个按钮看起来像工具栏，页签要看起来像"一个页面的几页"。
 */
.settings-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  padding-bottom: 2px;
  border-bottom: 1px solid var(--color-border);
}

.settings-tab {
  padding: 6px 12px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
}

.settings-tab:hover {
  background: var(--color-bg-muted);
  color: var(--color-text);
}

.settings-tab--active {
  color: var(--color-accent-hover);
  border-bottom-color: var(--color-accent);
  font-weight: 600;
}

/*
 * 一页的内容：**更紧**（业主 ③：「设置页太宽松」）。
 *
 * 两条具体的收紧：卡片内边距从 `--space-5` 收到 `--space-4`，组与组之间只隔
 * `--space-4`（原来是每块一张卡、卡间距 `--space-5`）。页签之后本来就不需要
 * "每块一张卡"那种分隔方式 —— 一页里的分组用一条细线就够。
 */
.settings-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-4);
}

/* 一页里的分组：小标题 + 内容，组间一条细线。 */
.settings-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.settings-group + .settings-group {
  padding-top: var(--space-4);
  border-top: 1px solid var(--color-border);
}

.settings-group__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.settings-group__title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

/*
 * 分组内的表单网格：**三列**（够宽时）。
 *
 * 这几个分组里的字段都是短数字（毫秒、秒、天、GB），两列在宽窗口上会留下大块空白 ——
 * 那正是"太宽松"的来源。最小 180px 让窄窗口自动退到两列、一列。
 */
.settings-group .form-grid {
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
}

/*
 * 页面最底部的那张「恢复默认值」卡片（业主 2026-09-16）。
 * 一行：左边是动作名，右边是按钮；用 `margin-left: auto` 把按钮推到右端，
 * 与卡片里其它"标签在左、控件在右"的行保持同一套视觉语言。
 * 它没有专门的配色：这是**破坏性**动作，但破坏性由确认对话框承担（那里写着范围），
 * 把一个常年挂在页面底部的按钮涂成红色只会让它变成背景噪音。
 */
.danger-action {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.danger-action__title {
  font-weight: 600;
}

.danger-action .btn {
  margin-left: auto;
}
/*
 * 语言选择器在侧栏里是撑满一行的；搬进设置卡片后如果照旧撑满，标签与下拉框会被
 * 整张卡的宽度拉开到看起来不像一组。收在一个可读的宽度里。
 */
.settings-language {
  max-width: 320px;
}

.settings-hint {
  font-size: 11.5px;
}

/*
 * 数据接入里那些"要照抄去别处"的值（推流路径、MQTT 主题、本机地址）用等宽字，
 * 并且**允许折断**：一条 `/api/v1/<32 位十六进制>/telemetry` 在窄窗口里会溢出卡片。
 */
.iot-value {
  display: inline-block;
  font-size: 12.5px;
  color: var(--color-text);
  overflow-wrap: anywhere;
}

.iot-addresses {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.about-brand {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4) 0;
  margin-bottom: var(--space-3);
  border-bottom: 1px solid var(--color-border);
}

.about-brand__logo {
  /* The asset is 224x120 with transparent padding; contain keeps it undistorted
     while the flex row decides the width. */
  width: 168px;
  height: auto;
  object-fit: contain;
  flex: none;
}

.about-brand__meta {
  min-width: 0;
}

.about-brand__name {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
}

.about-brand__version {
  margin-top: 2px;
  font-size: 12.5px;
  color: var(--color-text-secondary);
}

.about-brand__sep {
  margin: 0 5px;
  color: var(--color-border-strong);
}

.about-brand__build {
  margin-top: 2px;
  font-size: 11.5px;
  color: var(--color-text-secondary);
}

.about-contact {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}

.settings-grid {
  margin-top: var(--space-2);
}

.path-row {
  display: flex;
  gap: var(--space-2);
}

.path-row .input {
  flex: 1;
}

.disk-kv {
  margin-top: var(--space-3);
}

.copy-btn {
  margin-left: 8px;
}

.trend-hint {
  margin-top: var(--space-3);
}

/* 恢复默认值的范围清单。两列，一眼能数完十三项。 */
.restore-list {
  margin: var(--space-2) 0;
  padding-left: 20px;
  columns: 2;
  font-size: 12.5px;
}
</style>
