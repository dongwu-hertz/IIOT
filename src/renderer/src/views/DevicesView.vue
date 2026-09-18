<script setup lang="ts">
/**
 * Device management (spec section 8.4).
 *
 * 右侧是**一行行设备的表格**（业主 2026-09-17 第 3 条）：设备名称 / 设备IP / 设备类型 /
 * 是否在线 / 告警数量 / 设备通道 / 查看 / 配置。所有事实都来自领域模型 —— 这里不出现任何
 * 协议字段名。通道数不在 `Device` 上，所以读 store 缓存的通道表；那一次调用成功之前显示
 * "—" 而不是猜一个数。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import type { AlarmQuery } from '@shared/domain/models'
import type { Device } from '@shared/domain/models'
import { isPointComplete, parseInstallation } from '@shared/domain/device-installation'
import { callApi, unwrap } from '@renderer/lib/result'
import { useDevicesStore } from '@renderer/stores/devices'
import { useSessionStore } from '@renderer/stores/session'
import { channelState } from '@renderer/lib/channelState'
import AddDeviceDialog from '@renderer/components/AddDeviceDialog.vue'
import AppModal from '@renderer/components/AppModal.vue'
import EmptyState from '@renderer/components/EmptyState.vue'
import StatusBadge from '@renderer/components/StatusBadge.vue'

const { t } = useI18n()
const router = useRouter()
const devices = useDevicesStore()

/**
 * Adding, editing and removing devices are administrator actions (see
 * `shared/domain/auth.ts`): they change what the hardware does, which is exactly
 * what an operator must not do unattended. The controls below are hidden behind
 * this store's `isAdmin` rather than removed, and the handlers stay in place —
 * the same page is what an administrator uses.
 *
 * The main process re-checks the role on every one of those calls, so this is a
 * presentation rule, not the enforcement.
 */
const session = useSessionStore()

const addOpen = ref(false)
const notice = ref('')
const actionError = ref('')

/** Edit dialog state. */
const editOpen = ref(false)
const editTarget = ref<Device | null>(null)

/**
 * 编辑对话框的四个安装信息输入框（业主 2026-09-17 第 1 条）。
 *
 * 与「添加设备」对话框一样用**字符串**：输入框给的就是字符串，而"清空"与"填 0"要能分开
 * —— 用数字的话清空会变成 0，界面上就出现一个看起来像实测值的纬度 0。
 * 解析与范围校验走共享的 `parseInstallation()`（与主进程同一套判据）。
 */
interface EditInstallationForm {
  gisLatitude: string
  gisLongitude: string
  azimuthDeg: string
}

const editForm = ref({
  name: '',
  ip: '',
  httpPort: 80,
  /**
   * 凭据（业主 2026-09-18 第 10 条）：用户名从库里读出来填上，**口令永远是空的**
   * （我们从不回显口令；空框 = 不改，见 `UpdateDeviceInput.password`）。
   */
  username: '',
  password: '',
  installation: {
    gisLatitude: '',
    gisLongitude: '',
    azimuthDeg: ''
  } as EditInstallationForm
})
const editError = ref('')
const editSaving = ref(false)
/** 密码框是否明文显示（第 10 条要的"支持显示密码"）。每次打开对话框都回到隐藏。 */
const editPasswordShown = ref(false)

/** 数值 → 输入框文字；没录过就是空串（不是 `0`，也不是 `'undefined'`）。 */
function installationInput(value: number | undefined): string {
  return value === undefined ? '' : String(value)
}

/** Remove confirmation state. */
const removeOpen = ref(false)
const removeTarget = ref<Device | null>(null)
const removing = ref(false)

const cards = computed(() => devices.devices)

// ---------------------------------------------------------------------------
// 设备拓扑树（产品要求：拓扑属于设备管理的内容，不再是全局侧栏的一部分）
// ---------------------------------------------------------------------------

/**
 * 表格里被选中的那一行（本页自己的选中态）。
 *
 * 为什么表格的"点一行"**不再跳走**：业主第 4 条要的是「**双击**设备 IP 打开设备 Web 界面」，
 * 而双击的前半段一定是两次单击 —— 只要单击这一行会导航（上一版的行点击就是跳去 `/monitor`），
 * 第一次单击就已经离开这一页了，双击永远落不到 IP 上。所以这一页的行点击改成**选中**：
 *   行点击 = 选中这一台（高亮 + 把 store 的当前设备切过去），
 *   要跳转就用右边那两列 —— 「查看」去实时检测、「设置」去设备详情。
 */
const activeRowId = ref('')

function selectRow(device: Device): void {
  activeRowId.value = device.id
  devices.select(device.id)
}

/**
 * IP 那一格的单击**什么都不做**，只阻止冒泡（不选中行、不跳转、不开浏览器）——
 * 这一格上的动作只有双击（打开设备 Web 界面）。写成具名空函数而不是 `@click.stop`：
 * 具名函数的意图在读代码时一眼可见，而"没有处理器的修饰符"依赖编译器的细节。
 */
function ignoreClick(): void {}

onMounted(() => {
  /*
   * 列表为空时**这一页自己读一次**。
   *
   * 其他列表页早就各自这么做了（`MonitorView` / `RecordingsView` / `AlarmsView` /
   * `TrendsView` / `SamplesView` / `EventCenterView` / `DeviceDetailView`），只有设备管理页
   * 原来完全依赖外壳（`AppShell`）在启动时读的那一次。而这一页恰恰最不该把"还没读到"显示成
   * "没有设备"。
   *
   * ⚠️ 诚实说明：**这不是** 2026-09-17 那条探针观察到的现象的成因。那次观察到的是
   * "加完设备之后实时监测页的设备下拉里只有这一台（库里 3 台）"，而当时的 store 并不是空的
   * （所以这个 `length === 0` 的分支根本不会触发）。那个现象**至今没有定位到**
   * （见 `docs/Ivms4200-UX-REFERENCE.md` §15.36 的"未查清"一节）。
   * 这里保留的是"与其他页一致"这一条**独立成立**的理由，不是那个现象的修复。
   */
  if (devices.devices.length === 0) void devices.load()
  // 告警数量那一列要真的去读一次（表格里是每台设备一行）。
  void loadAlarmCounts()
})

/*
 * 这里**没有卸载钩子**（第 8 条把行末那个 `⋮` 菜单删掉之后，本页最后一个全局监听器
 * ——"点外面关菜单"——跟着消失了）。少一个监听器，也少一处关不掉的浮层。
 */

/**
 * Channel counts are per-device facts, so they can only come from the device.
 * The store de-duplicates the calls and caches the result.
 */
watch(
  () => devices.devices.map((device) => device.id).join(','),
  () => {
    for (const device of devices.devices) {
      if (!devices.channels[device.id]) void devices.loadChannels(device.id)
    }
    // 设备表变了（加了一台/删了一台），告警数量那一列也要跟着重读。
    void loadAlarmCounts()
  },
  { immediate: true }
)

function channelCount(deviceId: string): number | null {
  const list = devices.channels[deviceId]
  return list ? list.length : null
}

/**
 * 每台设备的**告警数量**（表格那一列）。
 *
 * 为什么不是一个 IPC：告警表按设备分组计数在界面上的用法就是这一列，而设备数是个位数。
 * 所以这里为每台设备读一次 `alarms.query({ deviceId, limit: 1 })` 的 `total` —— 一次 IPC
 * 换一个准确的数字，比在主进程里新开一条"按设备计数"的通道更省事，也不会让契约多一个形状。
 * 读不到（IPC 失败）时那一格显示「—」：0 与"没读到"必须能分开。
 */
const alarmCounts = ref<Record<string, number>>({})

async function loadAlarmCounts(): Promise<void> {
  const next: Record<string, number> = {}
  for (const device of devices.devices) {
    const query: AlarmQuery = { deviceId: device.id, limit: 1 }
    const result = await callApi(() => window.api.alarms.query(query))
    if (result.success) next[device.id] = unwrap(result)?.total ?? 0
  }
  alarmCounts.value = next
}

function alarmCount(deviceId: string): number | null {
  return alarmCounts.value[deviceId] ?? null
}

/**
 * 点位那一格的文字（安装信息，业主 2026-09-17 第 1 条）。
 *
 * 只有**经纬度成对**时才算一个点位：只录了纬度不构成一个点，显示成一半的坐标会让
 * 人以为点位录好了。工具提示里带上方位角与基准声压级 —— 表格列不由我定，
 * 但这三项都是操作员要核对的事实。
 */
function installationTitle(device: Device): string {
  const installation = device.installation
  if (!installation) return t('installUi.noPoint')
  const parts: string[] = []
  if (isPointComplete(installation) && installation.gisLatitude !== undefined) {
    parts.push(
      `${installation.gisLatitude}, ${installation.gisLongitude ?? ''}`
    )
  }
  if (installation.azimuthDeg !== undefined) {
    parts.push(`${t('installUi.azimuth')} ${installation.azimuthDeg}`)
  }
  return parts.length > 0 ? parts.join(' · ') : t('installUi.noPoint')
}

/**
 * “8 路里开了几路”——卡片上的是通道数，但工程师真正关心的是有几路在工作。
 *
 * 通道表还没到手时返回空串（而不是“0 路已启用”）：那一刻我们并不知道，
 * 把“不知道”写成 0 和把未查询当成已启用是同一种错误。
 */
function enabledChannelSummary(deviceId: string): string {
  const list = devices.channels[deviceId]
  if (!list || list.length === 0) return ''
  const enabled = list.filter((channel) => channelState(channel) === 'enabled').length
  return t('channelState.enabledSummary', { enabled, total: list.length })
}

function go(path: string): void {
  void router.push(path)
}

/**
 * 「查看」——**按机型**进入对应的实时检测界面（业主 2026-09-17 第 5 条）。
 *
 * 这里只负责带上设备 id 跳转；"三种机型显示三种不同的内容"由 `/monitor` 自己按 kind 分支
 * （页面拿得到设备，判据只有一处）。为什么要在这里也判一次 kind：三种机型的**实时检测页
 * 是三个不同的页面内容**，而"点查看之后看到的是不是这一台该看的那一屏"是操作员的第一印象；
 * 带错参数会看到另一族的面板，那比报错更难发现。
 */
function monitor(device: Device): void {
  devices.select(device.id)
  void router.push({ path: '/monitor', query: { device: device.id } })
}

/** 双击设备 IP：打开设备自己的 Web 界面（业主 2026-09-17 第 4 条）。 */
async function openWebUi(device: Device): Promise<void> {
  actionError.value = ''
  const message = await devices.openWebUi(device.id)
  if (message) actionError.value = message
}

function startEdit(device: Device): void {
  editTarget.value = device
  const installation = device.installation
  editForm.value = {
    name: device.name,
    ip: device.ip ?? '',
    httpPort: device.httpPort ?? 80,
    // 凭据**两个框都留空**（= 不修改）：口令与用户名都住在主进程的凭据库里
    // （OS keyring，渲染层拿不到），所以这里没有办法"回显当前值"。
    username: '',
    password: '',
    installation: {
      gisLatitude: installationInput(installation?.gisLatitude),
      gisLongitude: installationInput(installation?.gisLongitude),
      azimuthDeg: installationInput(installation?.azimuthDeg)
    }
  }
  editPasswordShown.value = false
  editError.value = ''
  editOpen.value = true
}

async function submitEdit(): Promise<void> {
  const target = editTarget.value
  if (!target) return
  if (!editForm.value.name.trim()) {
    editError.value = t('devicesUi.editNameRequired')
    return
  }
  const port = Number(editForm.value.httpPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    editError.value = t('devicesUi.editPortInvalid')
    return
  }
  /*
   * 地址信息：三个框一起解析，任一项越界就**一个都不写**（与添加设备同一套判据）。
   * 清空的项送 `null` 而不是省略：编辑表单里"我把这个框清空了"就是要清掉库里的值，
   * 而省略一个键的语义是"这一项没动"（见 `UpdateDeviceInput.installation`）。
   */
  const parsed = parseInstallation(editForm.value.installation)
  if (!parsed.ok) {
    editError.value = t(parsed.reasonKey ?? 'installUi.errLatitude')
    return
  }
  const installation = {
    gisLatitude: parsed.installation.gisLatitude ?? null,
    gisLongitude: parsed.installation.gisLongitude ?? null,
    azimuthDeg: parsed.installation.azimuthDeg ?? null
  }
  editSaving.value = true
  /*
   * **不发 `ip`**（业主第 10 条：编辑设备时 IP 不可改）：地址决定设备身份，改了它
   * 就是另一台设备，而"编辑"这个词不包含"换一台"。端口照旧可以改（它只是同一个地址上的
   * 另一个端口）。
   *
   * 凭据只在**填了**的时候发（空口令 = 不改，见 `UpdateDeviceInput.password`）。
   */
  const username = editForm.value.username.trim()
  const password = editForm.value.password
  const updated = await devices.update({
    id: target.id,
    name: editForm.value.name.trim(),
    httpPort: port,
    ...(username === '' ? {} : { username }),
    ...(password === '' ? {} : { password }),
    installation
  })
  editSaving.value = false
  if (!updated) {
    editError.value = devices.error || t('devices.saveFailed')
    return
  }
  editOpen.value = false
  editTarget.value = null
  notice.value = t('devicesUi.noticeUpdated', { name: updated.name })
}

function askRemove(device: Device): void {
  removeTarget.value = device
  removeOpen.value = true
}

async function confirmRemove(): Promise<void> {
  const target = removeTarget.value
  if (!target) return
  removing.value = true
  const removed = await devices.remove(target.id)
  removing.value = false
  if (!removed) {
    actionError.value = devices.error || t('devices.deleteFailed')
    return
  }
  removeOpen.value = false
  notice.value = t('devicesUi.noticeRemoved', { name: target.name })
  removeTarget.value = null
}

function onAdded(deviceId: string): void {
  notice.value = t('devicesUi.noticeAdded')
  void devices.loadChannels(deviceId, true)
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------
</script>

<template>
  <div class="page">
    <!--
      这一页**没有页头**（产品要求）。「添加设备」按业主 2026-09-18 第 5 条搬进了**顶栏**——
      原来是挂在左侧拓扑树的树头上，而第 5 条要求整棵树下架。

      投到 `#topbar-page-slot`（顶栏里标题与右侧指示器之间的那一格，见 `AppTopbar.vue`）：
        · 它在 `.page` 的**第一个**子节点位置，所以**没有设备时也在** —— 空列表那一屏
          唯一的那个动作就是"添加设备"，把按钮跟着表格一起 `v-if` 掉会让新装的机器无路可走；
        · 靠右放（`margin-left: auto`）：紧挨着右边的设备数量/在线/告警指示器，
          与"这一屏能加设备"这件事同处一条视觉线上。
    -->
    <Teleport to="#topbar-page-slot">
      <!-- 只有管理员能加设备：普通账号连这个对话框都打不开（与设备表的删除列同一条口径）。 -->
      <div v-if="session.isAdmin" class="devices-topbar-add">
        <button
          type="button"
          class="btn btn--primary btn--sm"
          data-action="device-add"
          @click="addOpen = true"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M8 3.2v9.6M3.2 8h9.6" />
          </svg>
          {{ t('devicesUi.addButton') }}
        </button>
      </div>
    </Teleport>

    <p v-if="actionError" class="alert alert--danger" role="alert">{{ actionError }}</p>
    <p v-if="notice" class="alert alert--success" role="status">{{ notice }}</p>

    <EmptyState v-if="cards.length === 0" :title="t('devices.empty')" />

    <!--
      设备表（业主 2026-09-17 第 3 条；**列清单在 2026-09-18 第 8 条里重给了**）：
      序号 / 设备名称 / IP地址 / 设备类型 / 状态 / 告警数量 / 通道数 / 查看 / 设置 / 删除。
          与上一版清单的差别逐条写进 `docs/Ivms4200-UX-REFERENCE.md` 那一份（见 §15.50）：多了"序号"，
          "是否在线"改叫"状态"、"设备通道"改叫"通道数"，而原来藏在 `⋮` 菜单里的"编辑/删除"
          升成了两个图标列（`设置` / `删除`），菜单本身删掉。

          扁平化（业主 2026-09-18 第 2b 条）：这一页**不再用 `.table-wrap` 那张卡片**，
          改成一条上边线 + 每行一条分隔线（`.devices-table-flat`，见下面样式）。
        -->
    <section v-else class="devices-table-flat">
      <table class="table devices-table">
        <thead>
          <tr>
            <th scope="col" class="devices-table__num">{{ t('devicesUi.indexColumn') }}</th>
            <th scope="col">{{ t('devices.name') }}</th>
            <th scope="col">{{ t('devicesUi.ipColumn') }}</th>
            <th scope="col">{{ t('addDeviceUi.kindLabel') }}</th>
            <th scope="col">{{ t('devicesUi.onlineColumn') }}</th>
            <th scope="col" class="devices-table__num">{{ t('devicesUi.alarmCountColumn') }}</th>
            <th scope="col" class="devices-table__num">{{ t('devicesUi.channelColumn') }}</th>
            <th scope="col" class="devices-table__actions">{{ t('devicesUi.viewColumn') }}</th>
            <th scope="col" class="devices-table__actions">{{ t('devicesUi.settingColumn') }}</th>
            <th scope="col" class="devices-table__actions">{{ t('devicesUi.deleteColumn') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(device, index) in cards"
            :key="device.id"
            :class="[
              'is-clickable',
              {
                'devices-table__row--selected': device.id === activeRowId
              }
            ]"
            @click="selectRow(device)"
          >
            <td class="devices-table__num muted">{{ index + 1 }}</td>
            <td>
              <!--
                设备名是一**个入口**：点它进设备详情/配置页（业主第 8 条的列清单里没有
                "详情"这一列，而那个页面装着通道配置、告警策略、维护与升级 —— 它必须还在
                某个地方；名字是控制台里最自然的那一个）。
              -->
              <button
                type="button"
                class="devices-table__name devices-table__name--action"
                :title="t('devicesUi.openDetail')"
                data-action="device-detail"
                @click.stop="go(`/devices/${device.id}`)"
              >
                {{ device.name }}
              </button>
              <!--
                地址信息是**工具提示**而不是一列：业主给的列清单里没有它，而它又是
                已经录进库的事实。放在名字的 title 上，既不占列，又不丢信息。
              -->
              <span
                v-if="device.installation"
                class="devices-table__install"
                :title="installationTitle(device)"
              >
                {{ t('installUi.point') }}
              </span>
            </td>
            <td>
              <!--
                **双击** IP 打开设备自己的 Web 界面（业主 2026-09-17 第 4 条）。
                用 <button> 而不是给 <td> 绑双击，是为了键盘也能到它 —— 但**单击不打开**：
                单击这一格的人多半是想选中这一行（行点击 = 选中设备），把单击也接上浏览器的后果
                是"想选设备，却弹出一个浏览器窗口"。所以：
                  · `click` 只阻止冒泡（不选中行、也不打开任何东西）；
                  · `dblclick` 打开设备页面；
                  · Enter / 空格（键盘的"激活"）打开，读屏与纯键盘用户不会少一条路。
              -->
              <button
                type="button"
                class="devices-table__ip mono"
                :title="t('devicesUi.ipDoubleClickHint')"
                @click.stop="ignoreClick"
                @dblclick.stop="openWebUi(device)"
                @keydown.enter.prevent.stop="openWebUi(device)"
                @keydown.space.prevent.stop="openWebUi(device)"
              >
                {{ device.ip || '—' }}<span v-if="device.httpPort">:{{ device.httpPort }}</span>
              </button>
            </td>
            <td>{{ t(`domain.deviceKind.${device.kind}`) }}</td>
            <td><StatusBadge :status="device.status" :connection-type="device.connectionType" /></td>
            <td class="devices-table__num">{{ alarmCount(device.id) ?? '—' }}</td>
            <td class="devices-table__num">
              {{ channelCount(device.id) ?? '—' }}
              <!--
                通道数的**明细**（几路在用）挪进 `title`：这一列现在有十列，1280×720 下
                横排放不下 —— 数字留着（它是列的含义），"8 路里开了几路"放进悬停。
              -->
              <span
                v-if="enabledChannelSummary(device.id)"
                class="devices-table__hint"
                :title="enabledChannelSummary(device.id)"
                aria-hidden="true"
              ></span>
            </td>
            <td class="devices-table__actions">
              <!-- 「查看」= 按机型进入对应的实时检测界面（三个不同的内容）。 -->
              <button
                type="button"
                class="btn btn--ghost btn--icon"
                :aria-label="t('devicesUi.viewColumn')"
                :title="t('devicesUi.viewColumn')"
                data-action="device-monitor"
                @click.stop="monitor(device)"
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
                  <path d="M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8s-2.4 4.2-6.5 4.2S1.5 8 1.5 8Z" />
                  <circle cx="8" cy="8" r="1.8" />
                </svg>
              </button>
            </td>
            <!--
              「设置」= 编辑这一台设备（名称 / 端口 / 凭据 / 地址信息），业主第 10 条
              要的那个对话框。它原来是 `⋮` 菜单里的"编辑" —— 第 8 条的列清单把
              编辑与删除升成了两列，菜单因此删掉（一个入口胜过两个）。
            -->
            <td class="devices-table__actions">
              <button
                v-if="session.isAdmin"
                type="button"
                class="btn btn--ghost btn--icon"
                :aria-label="t('devicesUi.settingColumn')"
                :title="t('devicesUi.settingColumn')"
                data-action="device-configure"
                @click.stop="startEdit(device)"
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
                  <circle cx="8" cy="8" r="2.1" />
                  <path d="M8 1.6v1.7M8 12.7v1.7M14.4 8h-1.7M3.3 8H1.6M12.5 3.5l-1.2 1.2M4.7 11.3l-1.2 1.2M12.5 12.5l-1.2-1.2M4.7 4.7 3.5 3.5" />
                </svg>
              </button>
            </td>
            <td class="devices-table__actions">
              <button
                v-if="session.isAdmin"
                type="button"
                class="btn btn--ghost btn--icon devices-table__delete"
                :aria-label="t('devicesUi.deleteColumn')"
                :title="t('devicesUi.deleteColumn')"
                data-action="device-delete"
                @click.stop="askRemove(device)"
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true">
                  <path d="M2.8 4.2h10.4M6.4 4.2V2.9h3.2v1.3M4.2 4.2l.7 9h6.2l.7-9" />
                  <path d="M6.8 6.8v4.4M9.2 6.8v4.4" />
                </svg>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <AddDeviceDialog v-model="addOpen" @added="onAdded" />

    <!--
      编辑设备（业主 2026-09-18 第 10 条）：
        · 显示名称可改；**IP 不可改**（它决定设备身份，改了就是另一台设备）；
        · HTTP 端口与 IP **同一行**；
        · 用户名与密码**同一行**，都可改，密码框旁边有"显示/隐藏"；
        · 经纬度同一行。
      口令**从不回显**：密码框留空 = 不改（见 `UpdateDeviceInput.password` 的注释）。
    -->
    <AppModal v-model="editOpen" :title="t('devicesUi.editTitle')" width="560px">
      <div class="edit-form">
        <label class="field">
          <span class="field-label">{{ t('devices.name') }}</span>
          <input v-model="editForm.name" data-autofocus class="input" type="text" />
        </label>

        <div class="form-grid">
          <label class="field">
            <span class="field-label">{{ t('devices.ip') }}</span>
            <input
              class="input mono"
              type="text"
              :value="editForm.ip"
              readonly
              data-field="edit-ip"
              :title="t('devicesUi.ipReadonlyHint')"
            />
            <span class="field-hint">{{ t('devicesUi.ipReadonlyHint') }}</span>
          </label>
          <label class="field">
            <span class="field-label">{{ t('devices.port') }}</span>
            <input v-model.number="editForm.httpPort" class="input" type="number" min="1" max="65535" />
          </label>
        </div>

        <div class="form-grid">
          <label class="field">
            <span class="field-label">{{ t('devices.username') }}</span>
            <input
              v-model="editForm.username"
              class="input"
              type="text"
              autocomplete="off"
              :placeholder="t('devicesUi.credentialsKeep')"
            />
          </label>
          <label class="field">
            <span class="field-label">{{ t('devices.password') }}</span>
            <span class="field-row">
              <input
                v-model="editForm.password"
                class="input"
                :type="editPasswordShown ? 'text' : 'password'"
                autocomplete="off"
                :placeholder="t('devicesUi.credentialsKeep')"
              />
              <button
                type="button"
                class="btn btn--ghost btn--icon"
                :aria-pressed="editPasswordShown"
                :aria-label="editPasswordShown ? t('devicesUi.passwordHide') : t('devicesUi.passwordShow')"
                :title="editPasswordShown ? t('devicesUi.passwordHide') : t('devicesUi.passwordShow')"
                data-action="edit-password-reveal"
                @click="editPasswordShown = !editPasswordShown"
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
                  <path d="M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8s-2.4 4.2-6.5 4.2S1.5 8 1.5 8Z" />
                  <circle cx="8" cy="8" r="1.8" />
                  <path v-if="!editPasswordShown" d="M2.5 13.5 13.5 2.5" />
                </svg>
              </button>
            </span>
            <span class="field-hint">{{ t('devicesUi.credentialsHint') }}</span>
          </label>
        </div>
      </div>

      <!--
        地址信息（业主 2026-09-17 第 1 条；2026-09-18 第 7 条改名）：录入之后必须**改得动**，
        否则打错一个数字就只剩"删掉设备再加一遍"这条路。判据与添加设备对话框共用
        `parseInstallation()`，清空一项 = 把库里那一项清掉（不是留旧值）。
        经度与纬度**同一行**（第 10 条）。
      -->
      <fieldset class="install">
        <legend class="field-label">{{ t('installUi.section') }}</legend>
        <p class="field-hint">{{ t('installUi.sectionHint') }}</p>
        <div class="form-grid">
          <label class="field">
            <span class="field-label">{{ t('installUi.latitude') }}</span>
            <input
              v-model="editForm.installation.gisLatitude"
              class="input mono"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              spellcheck="false"
            />
          </label>
          <label class="field">
            <span class="field-label">{{ t('installUi.longitude') }}</span>
            <input
              v-model="editForm.installation.gisLongitude"
              class="input mono"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              spellcheck="false"
            />
          </label>
          <label class="field">
            <span class="field-label">{{ t('installUi.azimuth') }}</span>
            <input
              v-model="editForm.installation.azimuthDeg"
              class="input mono"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              spellcheck="false"
            />
            <span class="field-hint">{{ t('installUi.azimuthHint') }}</span>
          </label>
        </div>
      </fieldset>

      <p v-if="editError" class="alert alert--danger" role="alert">{{ editError }}</p>
      <template #footer>
        <button type="button" class="btn" :disabled="editSaving" @click="editOpen = false">
          {{ t('common.cancel') }}
        </button>
        <button type="button" class="btn btn--primary" :disabled="editSaving" @click="submitEdit">
          {{ editSaving ? t('common.saving') : t('common.save') }}
        </button>
      </template>
    </AppModal>

    <!-- Removal is destructive and drops stored credentials, so it must be confirmed. -->
    <AppModal v-model="removeOpen" :title="t('devicesUi.deleteTitle')" width="420px">
      <p class="confirm-text">
        {{ t('devicesUi.deleteBody', { name: removeTarget?.name ?? '' }) }}
      </p>
      <template #footer>
        <button type="button" class="btn" :disabled="removing" @click="removeOpen = false">
          {{ t('common.cancel') }}
        </button>
        <button type="button" class="btn btn--danger" :disabled="removing" @click="confirmRemove">
          {{ removing ? t('devicesUi.removing') : t('devicesUi.confirmDelete') }}
        </button>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
/*
 * 顶栏那一格里的「添加设备」（业主第 5 条）。
 *
 * 这一格是顶栏的 `#topbar-page-slot`（`flex: 1 1 50%; max-width: 50%; margin-left: auto`），
 * 里面只有一个按钮，所以靠右收在指示器旁边。`scoped` 对 `Teleport` 出去的内容照样生效 ——
 * 节点是本组件渲染的，`data-v-*` 在渲染时就打上了（总览页那个设备下拉也是这么做的）。
 */
.devices-topbar-add {
  margin-left: auto;
  display: flex;
  align-items: center;
}

.devices-topbar-add .btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  white-space: nowrap;
}

/*
 * 设备表（业主 2026-09-17 第 3 条；列清单在 2026-09-18 第 8 条重给）。
 *
 * **扁平化（第 2b 条）**：这一页不再用 `.table-wrap` 那张卡片（它是全应用共用的外壳，
 * 告警/事件中心/录音/样本库都靠它），改成只留一条上边线与每行的分隔线 —— 页面上没有
 * 圆角、没有卡片边框、没有卡片底色，分区靠线。
 *
 * 表本身的外观仍然来自全局 `.table`（表头吸顶、行分隔线、单元格内边距），这一页只加
 * 这张表特有的几件事：
 *   ① 数字列（序号 / 告警数量 / 通道数）右对齐 —— 位数不同的两行才读得成一列；
 *   ② 最后三列是图标按钮，宽度收到内容宽，不参与分配剩余宽度（否则图标会被甩到很右边）；
 *   ③ IP 那一格是 `<button>`（双击开设备 Web 界面），要看起来像一格文字而不是一个按钮；
 *   ④ 被选中的那一行加底色 —— 选中态由本页自己拿着（`activeRowId`），不再与任何左侧面板共享。
 */
.devices-table-flat {
  /* 只有上下两条线，没有卡片：上边线是这一段的起点，下边线把它与页脚内容分开。 */
  border-top: 1px solid var(--color-border);
  border-bottom: 1px solid var(--color-border);
}

.devices-table-flat .devices-table {
  /* `.table` 自己带表头底色与行线；这里只把"卡片内边距"那套去掉。 */
  background: transparent;
}

.devices-table .devices-table__num {
  text-align: right;
  white-space: nowrap;
}

/*
 * 十列要放得下 1280×720（业主第 8 条的清单比上一版多两列）：这一页的表把单元格的
 * 左右内边距收到 `--space-2`，并让"名字"与"IP"两列在必要时省略号截断 —— 两列的内容
 * 都是**可以在悬停里读全**的（名字的 title 是地址信息、IP 双击这一格本身就有提示）。
 * 不这样做的话，最后那个删除图标会被挤出内容区（几何探针在 1280×720 上报过"被裁掉的控件"）。
 */
.devices-table th,
.devices-table td {
  padding-left: var(--space-2);
  padding-right: var(--space-2);
}

.devices-table__name--action {
  display: inline-block;
  max-width: 168px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}

.devices-table__ip {
  max-width: 132px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 通道数那一格只留数字；明细在 `title` 里（见模板注释），这个小圆点表示"还有话"。 */
.devices-table__hint {
  display: inline-block;
  width: 5px;
  height: 5px;
  margin-left: 4px;
  border-radius: 50%;
  background: var(--color-border-strong, var(--color-border));
  vertical-align: middle;
}

.devices-table .devices-table__actions {
  width: 1%;
  white-space: nowrap;
}

.devices-table__name {
  font-weight: 600;
}

/* 名字是一个入口（点它进详情页）：看起来仍是一格文字，但指针与 hover 说得出它是可点的。 */
.devices-table__name--action {
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}

.devices-table__name--action:hover {
  color: var(--color-accent-hover);
  text-decoration: underline;
}

.devices-table__name--action:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
  border-radius: var(--radius-sm);
}

/* 删除是破坏性动作：hover 时图标变危险色（与告警里的删除同一套读法）。 */
.devices-table__delete:hover {
  color: var(--color-danger);
}

/* 「IP 不可改」那一格：只读输入看起来就是只读（不是禁用 —— 禁用会让人以为整页不能编辑）。 */
.edit-form .input[readonly] {
  background: var(--color-bg-subtle);
  color: var(--color-text-secondary);
  cursor: default;
}

/* 一行里的两个控件（输入框 + 图标按钮）：输入框占满，按钮不缩。 */
.field-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.field-row .input {
  flex: 1 1 auto;
  min-width: 0;
}

/* 「点位」只作为一个标记出现（坐标/方位角/声压级在 title 里）。 */
.devices-table__install {
  margin-left: 6px;
  padding: 0 6px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  font-size: 10.5px;
  line-height: 16px;
  color: var(--color-text-secondary);
  vertical-align: 1px;
}

.devices-table__ip {
  padding: 0;
  border: none;
  background: transparent;
  font: inherit;
  color: var(--color-text);
  cursor: pointer;
}

.devices-table__ip:hover {
  color: var(--color-accent);
  text-decoration: underline;
}

.devices-table__row--selected {
  background: var(--color-accent-soft);
}

/* 选中行的底色要压过 `.table tbody tr.is-clickable:hover`，否则鼠标一划过就看不出来。 */
.devices-table tbody tr.devices-table__row--selected:hover {
  background: var(--color-accent-soft);
}

.menu {
  position: relative;
}

.menu__list {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 30;
  min-width: 108px;
  padding: 4px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-md);
  display: flex;
  flex-direction: column;
}

.menu__item {
  text-align: left;
  padding: 6px 8px;
  border: none;
  background: transparent;
  border-radius: 6px;
  font-size: 12.5px;
  cursor: pointer;
}

.menu__item:hover {
  background: var(--color-bg-muted);
}

.menu__item--danger {
  color: var(--color-danger);
}

.edit-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.confirm-text {
  font-size: 12.5px;
  line-height: 1.7;
}
</style>
