<script setup lang="ts">
/**
 * Device detail — 设备概览 + 设备配置（Phase 9）+ 设备维护（Phase 10）。
 *
 * Device configuration BELONGS HERE, not in 系统设置: `SettingsView` edits this
 * app's local settings (storage root, retention, ring buffer), while everything on
 * this page is written to the DEVICE. Keeping the two apart is the difference
 * between "my laptop keeps recordings for 30 days" and "the box in the substation
 * alarms above 120" — two very different mistakes to make.
 *
 * TABS, NOT ONE LONG SCROLL
 * The sections carry very different risk levels: renaming a channel is routine,
 * while an IP change or a factory reset can take a device off the network. Tabs
 * keep a destructive control from being one stray scroll away from a routine one.
 *
 * The push subscription opened here (network progress) is released in
 * `onUnmounted`: the listener belongs to the preload bridge, so a component that
 * forgets to release it keeps the store — and every configuration object it
 * holds — alive for the lifetime of the window.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useDevicesStore } from '@renderer/stores/devices'
import { isGasLeakMonitor } from '@shared/domain/gas-leak'
import { useUiRefreshStore } from '@renderer/stores/uiRefresh'
import { useDeviceConfigStore } from '@renderer/stores/deviceConfig'
import { useDeviceDetailDialogStore } from '@renderer/stores/deviceDetailDialog'
import { useDeviceDetailDirtyStore } from '@renderer/stores/deviceDetailDirty'
import { channelState } from '@renderer/lib/channelState'
import { resolveChannelCount } from '@renderer/lib/channelCount'
import { formatDateTime, formatRelativeTime, formatSampleRate } from '@renderer/lib/format'
import EmptyState from '@renderer/components/EmptyState.vue'
import StatusBadge from '@renderer/components/StatusBadge.vue'
import AppModal from '@renderer/components/AppModal.vue'
import ChannelConfigSection from '@renderer/components/device-config/ChannelConfigSection.vue'
import AlarmProfileSection from '@renderer/components/device-config/AlarmProfileSection.vue'
import NetworkConfigSection from '@renderer/components/device-config/NetworkConfigSection.vue'
import TimeConfigSection from '@renderer/components/device-config/TimeConfigSection.vue'
import Rs485ConfigSection from '@renderer/components/device-config/Rs485ConfigSection.vue'
import ModbusConfigSection from '@renderer/components/device-config/ModbusConfigSection.vue'
import PushConfigSection from '@renderer/components/device-config/PushConfigSection.vue'
import MaintenanceSection from '@renderer/components/device-config/MaintenanceSection.vue'
import AuscultationPanel from '@renderer/components/AuscultationPanel.vue'
import CameraControlPanel from '@renderer/components/CameraControlPanel.vue'
import DeviceInstallationCard from '@renderer/components/DeviceInstallationCard.vue'
import DeviceProfileCard from '@renderer/components/DeviceProfileCard.vue'
import DevicePushEndpoint from '@renderer/components/DevicePushEndpoint.vue'
import AirSonarPtzPanel from '@renderer/components/AirSonarPtzPanel.vue'
import { callApi } from '@renderer/lib/result'

const props = defineProps<{ id: string; modal?: boolean }>()

const { t } = useI18n()
const router = useRouter()
const devices = useDevicesStore()
const uiRefresh = useUiRefreshStore()
const config = useDeviceConfigStore()
const detailDialog = useDeviceDetailDialogStore()
const dirtySections = useDeviceDetailDirtyStore()

type TabId =
  | 'overview'
  | 'channels'
  | 'alarms'
  | 'network'
  | 'time'
  | 'serial'
  | 'push'
  | 'maintenance'
  /** 听诊盒子族专有：工作模式 / 阈值参数 / 告警同步（`AuscultationPanel`）。 */
  | 'auscultation'
  /** 空气声呐（SN-16）**唯一**的一页：球机联动（PTZ）配置。 */
  | 'ptz'
  /** 相机专有（⑨ 从实时监测页搬过来）：检测模式 / 告警策略 / 维护与升级。 */
  | 'cameraDetect'
  | 'cameraAlarms'
  | 'cameraMaintenance'

const TABS: ReadonlyArray<{ id: TabId; labelKey: string }> = [
  { id: 'overview', labelKey: 'deviceDetailUi.tabOverview' },
  { id: 'channels', labelKey: 'deviceDetailUi.tabChannels' },
  { id: 'alarms', labelKey: 'deviceDetailUi.tabAlarms' },
  { id: 'network', labelKey: 'deviceDetailUi.tabNetwork' },
  { id: 'time', labelKey: 'deviceDetailUi.tabTime' },
  { id: 'serial', labelKey: 'deviceDetailUi.tabSerial' },
  { id: 'push', labelKey: 'deviceDetailUi.tabPush' },
  { id: 'maintenance', labelKey: 'deviceDetailUi.tabMaintenance' },
  { id: 'auscultation', labelKey: 'deviceDetailUi.tabAuscultation' },
  /**
   * 空气声呐（SN-16）唯一的一页。
   *
   * 标签只有「PTZ 联动」四个字 + 缩写，因为这一页的全部内容就是它；写成"球机联动配置"
   * 会与页内的小标题重复两遍。
   */
  { id: 'ptz', labelKey: 'deviceDetailUi.tabPtz' },
  // 相机专有三个页签：⑨ 把「检测模式 / 告警策略 / 维护与升级」搬到了设备管理。
  { id: 'cameraDetect', labelKey: 'deviceDetailUi.tabCameraDetect' },
  { id: 'cameraAlarms', labelKey: 'deviceDetailUi.tabCameraAlarms' },
  { id: 'cameraMaintenance', labelKey: 'deviceDetailUi.tabCameraMaintenance' }
]

/**
 * 听诊盒子族只保留这三个页签。
 *
 * 其余六个（通道/告警参数/网络/时间/RS485/Push）对应的是 FA8 的端点，在这一族上**不存在** ——
 * 留着它们会让操作员点开一个"永远读不到"的页面，而那看起来像设备坏了。听诊盒子自己的东西
 * （工作模式、阈值参数、告警同步）在 `auscultation` 那个页签里。
 */
const AUSCULTATION_TABS: ReadonlyArray<TabId> = ['overview', 'auscultation', 'maintenance']

/**
 * **空气声呐只有一页：球机联动（PTZ）**（业主 2026-09-17 第 8 批第 1 条）。
 *
 * 为什么把 2023 版那一组页签整个换掉、而不是在它后面加一个 PTZ 页签：这一族是**两代产品**，
 * 而 SN-16 是"与球机联动做声源定位"的单一用途设备 —— 业主的原话是"只支持一个 PTZ 的配置
 * 功能"。听诊盒子那一套（工作模式 / 阈值参数 / 告警同步）在它身上没有对应物
 * （它的 `/system` 里连 `work_mode` 都没有），维护那一套（重启/心跳）也与球机联动无关。
 * 留着它们，界面就在承诺一些这一代产品不会回答的东西。
 *
 * **设备身份与安装点位不丢**：它们作为 PTZ 那一页顶部的一小块只读信息保留（见模板）。
 */
const AIR_SONAR_TABS: ReadonlyArray<TabId> = ['ptz']

/**
 * 相机只保留这五个页签。
 *
 * 这一条**修的是一个既有缺陷**：改造之前，一台相机也会看到 FA8 的「通道与采样率」「告警参数」
 * 「网络配置」「时间 / NTP」「RS485 / Modbus」「Push 上报」—— 那些端点在相机上都不存在
 * （`/get_passageway`、`/alarm_profile`、`/recorder_conf`…），点开就是 404，而 404 会被
 * 读成"设备离线"。机型决定页签，与设备树、健康检查、客户端选择是同一条规矩。
 */
const CAMERA_TABS: ReadonlyArray<TabId> = [
  'overview',
  'cameraDetect',
  'cameraAlarms',
  'cameraMaintenance'
]

/**
 * 纯推送第三方设备（pushDevice，业主 20260921 第 12 条）只保留这两个页签。
 *
 * 它没有我们主动去连的协议 —— 通道 / 告警参数 / 网络 / 时间 / 串口 / 维护那些页签
 * 全部对应 FA8 或相机端点，在推送设备上**不存在**；「概览」装基础信息 + GIS
 * （`DeviceInstallationCard` 本来就在概览里），「push」装推流秘钥与地址
 * （复用 `DevicePushEndpoint`，与添加/编辑对话框里是同一组件）。
 */
const PUSH_DEVICE_TABS: ReadonlyArray<TabId> = ['overview', 'push']

const activeTab = ref<TabId>('overview')

const loading = ref(false)
const actionError = ref('')
const notice = ref('')

const nameDraft = ref('')
const renaming = ref(false)
const nameNotice = ref('')

const device = computed(() => devices.byId(props.id))
/** AO01 是两路气井传感器，没有声压级告警模板；配置里隐藏 SPL 组。 */
const isGasLeakDevice = computed(() => isGasLeakMonitor(device.value))

/**
 * The generic FA8 configuration blocks (channels / sample rate / alarm profiles /
 * network / time / RS485 / Modbus / push) only exist on `acousticBox`.
 *
 * Camera, Air Sonar and push devices have their own tabs and protocols. Loading
 * all of these anyway used to ask e.g. a camera for `/get_devinfo` and
 * `/passageway`; those endpoints do not exist there, the resulting login/probe
 * failures were surfaced as "AUTH_FAILED", and the failed health checks could
 * even flip an ONLINE camera to OFFLINE just by opening its detail page.
 */
const loadsGenericDeviceConfig = computed(() => device.value?.kind === 'acousticBox')

/**
 * 当前机型能看到的页签。
 *
 * ⚠️ **必须定义在 `device` 之后**：第一版把它（和下面那个 `watch`）写在了 `TABS` 旁边，
 * 而 `watch` 的取值函数在 setup 阶段就会跑一次 —— 那时 `device` 还在 TDZ 里，
 * 于是整页抛 `ReferenceError: Cannot access 'device' before initialization`（Vue 的
 * `runtime-2`）。`vue-tsc` 与单测都看不见这种错误，是 GUI 探针的 console 断言抓到的。
 */
const visibleTabs = computed(() => {
  const kind = device.value?.kind
  if (kind === 'auscultationBox') {
    /*
     * 两代产品，两组页签。判据是**设备自己说的代次**（`devices.e2_variant`，v12），
     * 不是型号名、也不是用户的选择。
     *
     * 还**没读到过**代次时（`undefined`）先给 2023 版那一组：那时我们确实不知道它是谁，
     * 而这一组在两种情况下都不会误导 —— 它只是"读参数/同步告警"，一台 SN-16 点开只会
     * 得到"这一代没有工作模式"的答复（`AuscultationPanel` 本来就这么写）。
     * 而一旦读到 `airSonar`，页签就只剩 PTZ 那一页。
     */
    if (device.value?.e2Variant === 'airSonar') {
      return TABS.filter((tab) => AIR_SONAR_TABS.includes(tab.id))
    }
    return TABS.filter((tab) => AUSCULTATION_TABS.includes(tab.id))
  }
  if (kind === 'acousticCamera') return TABS.filter((tab) => CAMERA_TABS.includes(tab.id))
  // 推送设备：最小页签集（概览 + push），**必须显式分支** —— 默认分支会把 FA8 的六个
  // 设备协议页签也分给它，而它在那些端点上全部不存在（点开就是 404 → 被读成离线）。
  if (kind === 'pushDevice') return TABS.filter((tab) => PUSH_DEVICE_TABS.includes(tab.id))
  return TABS.filter(
    (tab) => tab.id !== 'ptz' && !AUSCULTATION_TABS.includes(tab.id) && !CAMERA_TABS.includes(tab.id)
  )
})

/**
 * 换设备之后页签可能不在新机型的那一组里（例如从声纹设备切到相机时停在 `channels`）。
 * 那种情况下退回**这一组的第一页** —— 否则页面会是一片空白，而空白看起来像"这台设备没数据"。
 *
 * 第一页而不是恒定的「概览」：空气声呐那一组里**没有**概览页（只有 PTZ），退回概览会让
 * `activeTab` 停在一个不存在的页签上，页面就是空白。
 */
watch(
  () => [device.value?.kind, device.value?.e2Variant],
  () => {
    if (!visibleTabs.value.some((tab) => tab.id === activeTab.value)) {
      activeTab.value = visibleTabs.value[0]?.id ?? 'overview'
    }
  }
)

/**
 * 未保存修改确认（业主 20260921）：切页签与（弹窗语境）关弹窗前，若 RS485 / Modbus /
 * 通道表任一还有没保存的草稿，先弹确认，「放弃修改」才放行，「继续编辑」留在原地。
 *
 * 三处草稿住在各自组件里，脏标记经 `stores/deviceDetailDirty` 报到这里。因为守卫会
 * 拦下"带着脏页签离开"，任意时刻至多一处是脏的 —— 所以不需要分辨"哪个页签的脏"，
 * 一个 `anyDirty` 就够。守卫不覆盖的两条路：头部「实时监测」跳转与全页路由的离开
 * （业主只点了页签切换与弹窗关闭这两处，且全页路由本来就没有任何离开拦截）。
 */
const unsavedConfirmOpen = ref(false)
/** 确认「放弃修改」之后要执行的动作（切页签或关弹窗），null = 没有待执行的离开。 */
let pendingAfterDiscard: (() => void) | null = null

function requestUnsavedGuard(after: () => void): void {
  if (!dirtySections.anyDirty) {
    after()
    return
  }
  pendingAfterDiscard = after
  unsavedConfirmOpen.value = true
}

function requestTab(tab: TabId): void {
  if (tab === activeTab.value) return
  requestUnsavedGuard(() => {
    activeTab.value = tab
  })
}

function discardUnsaved(): void {
  unsavedConfirmOpen.value = false
  const after = pendingAfterDiscard
  pendingAfterDiscard = null
  after?.()
}

function keepEditing(): void {
  unsavedConfirmOpen.value = false
  pendingAfterDiscard = null
}

/**
 * 弹窗宿主（`DeviceDetailDialog`）在关闭前从这里过一遍守卫：
 * 有未保存修改时弹自家确认，用户「放弃修改」后才真正关弹窗。
 */
function requestCloseGuarded(): void {
  requestUnsavedGuard(() => detailDialog.close())
}

defineExpose({ requestCloseGuarded })

/**
 * 设备回报的通道数（`GET /get_devinfo` 的 `channelCount`）。
 *
 * **它不是权威值**：真机实测那个响应里根本没有通道数字段，而协议映射在设备没给这个
 * 字段时会把协议常量 `CHANNEL_COUNT`(8) 填进去
 * （`src/main/services/device/protocol/mappers.ts`，那个函数自己的注释也这么写）。
 * 所以这个 `ref` 只是「设备回了一个什么数」，能不能显示由 `resolveChannelCount()` 决定。
 */
const deviceReportedChannelCount = ref<number | null>(null)

/**
 * 概览里显示的通道数 —— **权威来源是已读回的通道表**，判定只有 `resolveChannelCount()`
 * 一处（纯函数、有单元测试）：
 *
 *   1. 通道表读到几行就是几路（`GET /get_passageway`，设备端真的列出来的通道）；
 *   2. 声学相机没有通道，这个 `0` 是关于产品的事实（`source: 'noChannels'`），
 *      不是「没读到」—— 与声纹设备那条路分开；
 *   3. 通道表还没到手时才看设备回报，而且**只有不等于协议常量的值**才算设备报的 ——
 *      一个正好是 8 的回报无法与「设备什么都没报、映射填了 8」区分，所以不显示；
 *   4. 两者都不可信就显示 `—` 并说明「设备未上报通道数」，**绝不显示一个我们没收到
 *      的数字**（2 路盒子原来会因此显示「通道数 8」）。
 *
 * 这样在 2 路盒子上显示的是 2（通道表两行），在 8 路盒子上显示 8（通道表八行）。
 */
const channelCount = computed(() =>
  resolveChannelCount({
    channelTableCount: config.channels.length || null,
    deviceReportedCount: deviceReportedChannelCount.value,
    deviceKind: device.value?.kind
  })
)

/**
 * 已启用通道数，跟在通道总数后面。
 *
 * 设备配置还没读回来时返回空串：那时“0 路已启用”是假的，真实情况是还没查。
 */
const enabledChannelSummary = computed(() => {
  const list = config.channels
  if (list.length === 0) return ''
  const enabled = list.filter((channel) => channelState(channel) === 'enabled').length
  return t('channelState.enabledSummary', { enabled, total: list.length })
})

/**
 * Top-of-page failure banner.
 *
 * The network section renders the service's own result sentence itself — verbatim
 * and persistently — so repeating the identical string up here would make one
 * failure look like two.
 */
const topError = computed(() => {
  if (actionError.value) return actionError.value
  const message = config.error
  if (!message) return ''
  if (config.networkChange && config.networkChange.message === message) return ''
  return message
})

async function refresh(): Promise<void> {
  loading.value = true
  actionError.value = ''

  const info = await devices.fetchInfo(props.id)
  if (info.error) actionError.value = info.error
  else deviceReportedChannelCount.value = info.info?.channelCount ?? null

  // Identity, configuration and status are independent reads; run them together
  // so one slow endpoint cannot serialise the whole page.
  // Only FA8 (`acousticBox`) has the generic configuration endpoints. Other
  // families own their tabs; probing FA8 endpoints on them is not a harmless
  // read — it causes failed logins, a misleading AUTH_FAILED banner, and can
  // push the device over its offline threshold.
  const configTask = loadsGenericDeviceConfig.value
    ? config.loadAll(props.id)
    : Promise.resolve(config.clearError())
  await Promise.all([configTask, devices.refreshStatus(props.id)])
  await resolveE2Variant()

  loading.value = false
  notice.value = t('deviceDetailUi.refreshedAt', { time: formatDateTime(Date.now()) })
}

/**
 * 空气声呐（SN-16）的**代次**决定这一页给哪一组页签，而它只存在于设备的回话里。
 *
 * 正常路径上代次已经落库（添加设备时探活顺手记的、或上次读状态时记的），所以这里**通常
 * 什么都不做**。它兜的是"老库里的行还没有这一列"与"设备上次没读通"这两种情况：
 * 读一次状态（这一步在主进程里会把代次记进设备行），再单台刷一次设备 —— 页签随之收成
 * 只有一个「PTZ 联动」。
 *
 * 失败**不报错**：代次读不到时那一页仍然能看能点（只是页签还是 2023 版那一组），
 * 而一个只读的探测不该让整个详情页显示成红色。
 */
async function resolveE2Variant(): Promise<void> {
  const current = device.value
  if (!current || current.kind !== 'auscultationBox' || current.e2Variant !== undefined) return
  const result = await callApi(() => window.api.e2.status(props.id))
  if (!result.success) return
  await devices.refreshStatus(props.id)
}


/**
 * 顶栏那颗唯一的刷新（业主 2026-09-19 更正第 4 条）：这一页自己那颗「刷新」已经删掉，
 * 重读数据由它触发 —— 调用的还是原来那个函数。
 */
watch(
  () => uiRefresh.tick,
  () => {
    void refresh()
  }
)

onMounted(async () => {
  if (devices.devices.length === 0) await devices.load()
  // Subscribe before the first read: a change already in flight still reports the
  // stage it has reached.
  config.subscribeNetworkProgress()
  await refresh()
})

onUnmounted(() => {
  config.unsubscribeNetworkProgress()
  // 兜底：正常情况下各配置区块卸载时已把自己的脏标记置回 false。
  dirtySections.reset()
})

// The same component instance is reused when only the route param changes, so a
// device switch must re-seed every slice rather than show the previous device's
// thresholds and IP address.
watch(
  () => props.id,
  async () => {
    activeTab.value = 'overview'
    notice.value = ''
    actionError.value = ''
    await refresh()
  }
)

watch(
  () => device.value?.name,
  (value) => {
    nameDraft.value = value ?? ''
  },
  { immediate: true }
)

function goMonitor(): void {
  devices.select(props.id)
  // 弹窗语境：跳转前先收掉弹窗，否则详情弹窗会悬在实时监测页上面。
  if (props.modal) detailDialog.close()
  void router.push({ path: '/monitor', query: { device: props.id } })
}

async function openWebUi(): Promise<void> {
  actionError.value = ''
  const message = await devices.openWebUi(props.id)
  if (message) actionError.value = message
}

async function renameDevice(): Promise<void> {
  actionError.value = ''
  nameNotice.value = ''
  const trimmed = nameDraft.value.trim()
  if (trimmed === '') {
    actionError.value = t('deviceDetailUi.nameRequired')
    return
  }
  renaming.value = true
  const saved = await config.setDeviceName(props.id, trimmed)
  renaming.value = false
  if (!saved) {
    actionError.value = config.error || t('deviceDetailUi.nameSaveFailed')
    return
  }
  // The main process refreshes its cached identity, so re-read the list to keep
  // the header, sidebar and device list showing the same name.
  await devices.load()
  nameNotice.value = t('deviceDetailUi.nameSaved')
}

/** 设备不存在时的退路：全页路由回列表；弹窗语境收掉弹窗即回到原页面。 */
function backToList(): void {
  if (props.modal) detailDialog.close()
  else void router.push('/devices')
}

/** Human-readable device web address, shown next to the button as an explanation. */
const webUiAddress = computed(() => {
  const current = device.value
  if (!current?.ip) return ''
  const port = current.httpPort ?? 80
  return port === 80 ? `http://${current.ip}/` : `http://${current.ip}:${port}/`
})
</script>

<template>
  <div class="page">
    <!--
      标题行（弹窗与全页路由同一套，业主 20260921）：设备名（大号）+ 状态徽标 +
      `ID {id}` / `MAC {mac}` / 当前采样率（小号灰字）同一行，右侧是「打开设备页面 /
      监测」。弹窗语境这一行就是它的标题层（AppModal 自家标题栏写的也是同一个名字）；
      全页路由语境在它上面再留一行小字「设备管理 / 设备名」——面包屑返回只在那里存在，
      弹窗有自家关闭按钮，不画这层。
    -->
    <div class="page-header">
      <div class="detail-header">
        <div v-if="!modal" class="breadcrumb">
          <RouterLink to="/devices">{{ t('deviceDetailUi.breadcrumbDevices') }}</RouterLink>
          <span>/</span>
          <span class="breadcrumb__current">
            {{ device?.name ?? t('app.nav.deviceDetail') }}
          </span>
        </div>
        <div class="detail-header__row">
          <h2 class="detail-header__name">{{ device?.name ?? t('app.nav.deviceDetail') }}</h2>
          <StatusBadge
            v-if="device"
            :status="device.status"
            :connection-type="device.connectionType"
          />
          <span class="detail-header__meta">
            {{ t('deviceDetailUi.headerId', { id: device?.deviceUid ?? '—' }) }}
          </span>
          <span class="detail-header__meta">
            {{ t('deviceDetailUi.headerMac', { mac: device?.mac || '—' }) }}
          </span>
          <span class="detail-header__meta">
            {{ t('deviceDetailUi.sampleRate') }} {{ formatSampleRate(config.sampleRate) }}
          </span>
        </div>
      </div>

      <div class="btn-row">
        <button type="button" class="btn" @click="openWebUi">{{ t('deviceDetailUi.openWebUi') }}</button>
        <button type="button" class="btn btn--primary" @click="goMonitor">{{ t('deviceDetailUi.monitor') }}</button>
      </div>
    </div>

    <p v-if="topError" class="alert alert--danger" role="alert">{{ topError }}</p>
    <p v-else-if="notice" class="alert" role="status">{{ notice }}</p>

    <div v-if="!device" class="card">
      <EmptyState :title="t('deviceDetailUi.notFoundTitle')">
        <button type="button" class="btn" @click="backToList">{{ t('deviceDetailUi.backToList') }}</button>
      </EmptyState>
    </div>

    <template v-else>
      <div class="tabs" role="tablist" :aria-label="t('deviceDetailUi.tabsLabel')">
        <button
          v-for="tab in visibleTabs"
          :key="tab.id"
          type="button"
          class="tab"
          :class="{ 'tab--active': activeTab === tab.id }"
          role="tab"
          :aria-selected="activeTab === tab.id"
          :data-tab="tab.id"
          @click="requestTab(tab.id)"
        >
          {{ t(tab.labelKey) }}
        </button>
      </div>

      <!-- 概览 -->
      <template v-if="activeTab === 'overview'">
        <section class="card">
          <div class="section-header">
            <h3 class="section-title">{{ t('deviceDetailUi.overviewTitle') }}</h3>
          </div>
          <dl class="kv">
            <div class="kv__item">
              <dt class="kv__label">{{ t('deviceDetailUi.ip') }}</dt>
              <dd class="kv__value mono">{{ device.ip || '—' }}</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('deviceDetailUi.httpPort') }}</dt>
              <dd class="kv__value mono">{{ device.httpPort ?? '—' }}</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('deviceDetailUi.mac') }}</dt>
              <dd class="kv__value mono">{{ device.mac || '—' }}</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('deviceDetailUi.firmware') }}</dt>
              <dd class="kv__value">{{ device.firmwareVersion || '—' }}</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('deviceDetailUi.fpga') }}</dt>
              <dd class="kv__value">{{ device.fpgaVersion || '—' }}</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('deviceDetailUi.webVersion') }}</dt>
              <dd class="kv__value">{{ device.webVersion || '—' }}</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('deviceDetailUi.channelCount') }}</dt>
              <dd class="kv__value">
                {{ channelCount.count ?? '—' }}
                <!--
                  数字的出处跟着数字一起说：通道表里的行数是权威值，那时后面跟的是
                  「已启用 x / y 路」；查不到可信数字时写「设备未上报通道数」，
                  而不是拿协议常量 8 顶上（理由见 `channelCount` 的说明）。
                -->
                <span v-if="channelCount.source === 'unreported'" class="muted">
                  （{{ t('deviceDetailUi.channelCountUnreported') }}）
                </span>
                <span v-else-if="enabledChannelSummary" class="muted">（{{ enabledChannelSummary }}）</span>
              </dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('deviceDetailUi.sampleRate') }}</dt>
              <dd class="kv__value">{{ formatSampleRate(config.sampleRate) }}</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('deviceDetailUi.lastSeen') }}</dt>
              <dd class="kv__value">
                {{ formatRelativeTime(device.lastSeen) }}
                <span class="muted">（{{ formatDateTime(device.lastSeen) }}）</span>
              </dd>
            </div>
          </dl>
        </section>

        <section class="card">
          <div class="section-header">
            <h3 class="section-title">{{ t('deviceDetailUi.nameSection') }}</h3>
          </div>
          <div class="rename-row">
            <input
              v-model="nameDraft"
              class="input"
              type="text"
              maxlength="64"
              spellcheck="false"
              :aria-label="t('deviceDetailUi.nameLabel')"
            />
            <button
              type="button"
              class="btn btn--primary"
              :disabled="renaming || nameDraft.trim() === (device.name ?? '')"
              @click="renameDevice"
            >
              {{ renaming ? t('common.saving') : t('deviceDetailUi.saveName') }}
            </button>
          </div>
          <p v-if="nameNotice" class="alert alert--success rename-notice" role="status">
            {{ nameNotice }}
          </p>
        </section>

        <section class="card">
          <div class="section-header">
            <h3 class="section-title">{{ t('deviceDetailUi.webSection') }}</h3>
          </div>
          <p v-if="webUiAddress" class="mono web-address">{{ webUiAddress }}</p>
        </section>

        <!--
          安装点位（业主 2026-09-17 第 1 条）：点位 / 方位角 / 基准声压级。
          录入在「添加设备」与设备管理页的「编辑」两处，这里是**同一份数据的只读视图** ——
          卡片本身与实时检测页（声呐那一支）共用，所以两页不可能显示成两个样子。
        -->
        <DeviceInstallationCard
          :installation="device.installation"
          :device-id="device.id"
          :device-name="device.name"
          :show-map="false"
          :sector-width-deg="device.e2Variant === 'airSonar' ? 1 : undefined"
        />

        <DeviceProfileCard :department="device.department" :attributes="device.attributes" />
      </template>

      <!-- 通道与采样率 -->
      <template v-else-if="activeTab === 'channels'">
        <ChannelConfigSection :device-id="props.id" />
      </template>

      <!-- 告警参数 -->
      <template v-else-if="activeTab === 'alarms'">
        <AlarmProfileSection :device-id="props.id" :hide-spl="isGasLeakDevice" />
      </template>

      <!-- 网络配置 -->
      <template v-else-if="activeTab === 'network'">
        <NetworkConfigSection :device-id="props.id" />
      </template>

      <!-- 时间 / NTP -->
      <template v-else-if="activeTab === 'time'">
        <TimeConfigSection :device-id="props.id" />
      </template>

      <!-- RS485 / Modbus -->
      <template v-else-if="activeTab === 'serial'">
        <Rs485ConfigSection :device-id="props.id" />
        <ModbusConfigSection :device-id="props.id" />
      </template>

      <!-- Push 上报：推送设备复用「push」页签装本机推流端点（秘钥 + 地址），其余机型是设备侧 Push 配置 -->
      <template v-else-if="activeTab === 'push'">
        <DevicePushEndpoint v-if="device.kind === 'pushDevice'" :device-id="props.id" />
        <PushConfigSection v-else :device-id="props.id" />
      </template>

      <!-- 听诊盒子族：工作模式 / 阈值参数 / 告警同步 -->
      <template v-else-if="activeTab === 'auscultation'">
        <AuscultationPanel :device-id="props.id" />
      </template>

      <!--
        空气声呐（SN-16）：**这一族唯一的一页** —— 球机联动（PTZ）配置。

        身份与安装点位留在这一页顶部（只读）：业主把这一族的其他页签都去掉了，但如果连
        "这是哪一台、装在哪、朝哪边"都看不到，那一页就没法用来判断配置对不对
        （球机地址与声呐点位、朝向是同一件事的三个面）。
      -->
      <template v-else-if="activeTab === 'ptz'">
        <section class="card">
          <div class="section-header">
            <h3 class="section-title">{{ t('deviceDetailUi.overviewTitle') }}</h3>
          </div>
          <dl class="kv">
            <div class="kv__item">
              <dt class="kv__label">{{ t('deviceDetailUi.ip') }}</dt>
              <dd class="kv__value mono">{{ device.ip || '—' }}</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('deviceDetailUi.firmware') }}</dt>
              <dd class="kv__value">{{ device.firmwareVersion || '—' }}</dd>
            </div>
            <!-- 身份（`deviceUid`）也留着：球机联动出问题时，第一件要对的就是"这是哪一台"。 -->
            <div class="kv__item">
              <dt class="kv__label">{{ t('devicesUi.deviceId') }}</dt>
              <dd class="kv__value mono ptz-identity">{{ device.deviceUid }}</dd>
            </div>
          </dl>
        </section>

        <DeviceInstallationCard
          :installation="device.installation"
          :device-id="device.id"
          :device-name="device.name"
          :show-map="false"
          :sector-width-deg="device.e2Variant === 'airSonar' ? 1 : undefined"
        />

        <DeviceProfileCard :department="device.department" :attributes="device.attributes" />

        <AirSonarPtzPanel :device-id="props.id" />
      </template>

      <!-- 相机（⑨）：检测模式 / 告警策略 / 维护与升级 —— 同一份实现按 sections 取用 -->
      <template v-else-if="activeTab === 'cameraDetect'">
        <CameraControlPanel :device-id="props.id" :sections="['mode']" />
      </template>

      <template v-else-if="activeTab === 'cameraAlarms'">
        <CameraControlPanel :device-id="props.id" :sections="['strategy']" />
      </template>

      <template v-else-if="activeTab === 'cameraMaintenance'">
        <CameraControlPanel :device-id="props.id" :sections="['maintenance', 'upgrade']" />
      </template>

      <!-- 设备维护 -->
      <template v-else>
        <MaintenanceSection :device-id="props.id" />
      </template>
    </template>

    <!--
      未保存修改确认（业主 20260921）：页签切换与（弹窗语境）关弹窗共用 —— 触发方把
      要继续做的事交给 `requestUnsavedGuard`，这里确认「放弃修改」后才执行。Esc / 点
      遮罩 / X 都按「继续编辑」处理（留在原地），焦点默认落在「继续编辑」上。
    -->
    <AppModal
      :model-value="unsavedConfirmOpen"
      :title="t('configCommon.unsaved')"
      width="420px"
      @update:model-value="keepEditing"
    >
      <p class="confirm-text">{{ t('deviceDetailUi.unsavedBody') }}</p>
      <template #footer>
        <button type="button" class="btn btn--danger" @click="discardUnsaved">
          {{ t('deviceDetailUi.unsavedDiscard') }}
        </button>
        <button type="button" class="btn btn--primary" data-autofocus @click="keepEditing">
          {{ t('deviceDetailUi.unsavedKeepEditing') }}
        </button>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
.breadcrumb {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--color-text-secondary);
  margin-bottom: 2px;
}

/*
 * 面包屑的最后一段在旧版里装着设备名 + 状态徽标；标题行改版（业主 20260921）之后
 * 徽标跟着大号名字走，这一段只剩「设备管理 / 设备名」一行小字，给整段文字用。
 */
.breadcrumb__current {
  color: var(--color-text);
  font-weight: 600;
}

/*
 * 标题行（设备名 + ID / MAC / 采样率同一行，见模板注释）。名字是这一行里唯一的
 * 大字；身份与读数一律小号灰字，不与名字抢层级。徽标与名字之间的间隙比 meta 略宽 —
 * 徽标是"状态"，与名字是一组；meta 是"身份"，单独一层。
 */
.detail-header__row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.detail-header__name {
  font-size: 17px;
  font-weight: 600;
  line-height: 1.3;
}

.detail-header__meta {
  font-size: 11.5px;
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.confirm-text {
  font-size: 12.5px;
  line-height: 1.7;
}

.detail-hint {
  font-size: 11.5px;
}

.detail-text {
  font-size: 12.5px;
  color: var(--color-text-secondary);
  line-height: 1.75;
}

.web-address {
  margin-top: 8px;
  padding: 6px 9px;
  background: var(--color-bg-muted);
  border-radius: var(--radius-sm);
  display: inline-block;
}

.tabs {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  padding: 4px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-subtle);
}

.tab {
  height: 28px;
  padding: 0 12px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 12.5px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.tab:hover {
  background: var(--color-bg-muted);
  color: var(--color-text);
}

.tab--active {
  background: var(--color-bg);
  border-color: var(--color-border);
  color: var(--color-text);
  font-weight: 600;
  box-shadow: var(--shadow-sm);
}

.rename-row {
  display: flex;
  gap: var(--space-2);
  max-width: 460px;
}

.rename-notice {
  margin-top: var(--space-3);
  max-width: 460px;
}
</style>
