<script setup lang="ts">
/**
 * Device management (spec section 8.4).
 *
 * 右侧是**一行行设备的表格**（业主 2026-09-17 第 3 条）：设备名称 / 设备IP / 设备类型 /
 * 是否在线 / 告警数量 / 设备通道 / 查看 / 配置。所有事实都来自领域模型 —— 这里不出现任何
 * 协议字段名。通道数不在 `Device` 上，所以读 store 缓存的通道表；那一次调用成功之前显示
 * "—" 而不是猜一个数。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import type { AlarmQuery } from '@shared/domain/models'
import type { Channel, Device, DeviceKind } from '@shared/domain/models'
import type { ChannelConfigView } from '@shared/domain/device-config'
import { isPointComplete, parseInstallation } from '@shared/domain/device-installation'
import { useDevicesStore } from '@renderer/stores/devices'
import { useDeviceTreeStore } from '@renderer/stores/deviceTree'
import { useCameraWallStore } from '@renderer/stores/liveWall'
import { useSessionStore } from '@renderer/stores/session'
import { channelState } from '@renderer/lib/channelState'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import AddDeviceDialog from '@renderer/components/AddDeviceDialog.vue'
import AppModal from '@renderer/components/AppModal.vue'
import DeviceRenameDialog from '@renderer/components/DeviceRenameDialog.vue'
import DeviceTree from '@renderer/components/DeviceTree.vue'
import EmptyState from '@renderer/components/EmptyState.vue'
import StatusBadge from '@renderer/components/StatusBadge.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const devices = useDevicesStore()
const tree = useDeviceTreeStore()
const wall = useCameraWallStore()

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
 * 树上应当高亮的设备。
 *
 * 判定只走 `stores/deviceTree.selectedForRoute()` 一处（查询串 > 记住的 > 第一台），
 * 所以「点树跳转」与「直接输入地址栏 / 刷新 / 后退」落到的是同一个节点 —— 这正是
 * 产品要求里的「用别的方式来到这个路由也要高亮正确的节点」。
 *
 * 高亮读的是 `/monitor` 的查询串：拓扑树的点击语义是「看这台设备的实时画面」，
 * 所以选中态跟着监测页走，而不是跟着本页的设备卡片走。
 */
const treeSelection = computed(() => tree.selectedForRoute(route.query.device))

/**
 * 表格里被选中的那一行（本页自己的选中态）。
 *
 * 为什么表格的"点一行"**不再跳走**：业主第 4 条要的是「**双击**设备 IP 打开设备 Web 界面」，
 * 而双击的前半段一定是两次单击 —— 只要单击这一行会导航（上一版的行点击就是跳去 `/monitor`），
 * 第一次单击就已经离开这一页了，双击永远落不到 IP 上。所以这一页的行点击改成**选中**：
 *   行点击 = 选中这一台（高亮 + 把 store 的当前设备切过去），
 *   要跳转就用右边那两列 —— 「查看」去实时检测、「配置」去设备详情。
 * 树上的点击仍然是"看这台设备的实时画面"（那是拓扑树的语义，没变）。
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

/**
 * 选中一台设备：**走路由**，让查询串成为选择的唯一真相。
 *
 * 这样浏览器的后退键、外部链接和刷新都会高亮同一台设备；如果只改 store 不改路由，
 * 后退之后树与页面就会各说各话。
 */
function selectDevice(deviceId: string): void {
  wall.bindDevices(devices.devices)
  void router.push({ path: '/monitor', query: { ...route.query, device: deviceId } })
}

/**
 * 双击设备 = 放进视频墙的当前格（产品要求）。
 *
 * 除了改路由（让监控页显示这台设备），还要把设备放进视频墙的状态格：双击的语义
 * 是「看它」，而下拉选择/拖拽都能做同一件事，所以这里不依赖任何鼠标手势是否成功。
 */
function openDeviceInWall(deviceId: string): void {
  wall.bindDevices(devices.devices)
  const slot = wall.slotForDevice(deviceId)
  wall.placeDevice(slot, deviceId)
  wall.setActive(slot)
  void router.push({ path: '/monitor', query: { ...route.query, device: deviceId } })
}

onMounted(() => {
  tree.ensureDefaultExpansion()
  /*
   * 列表为空时**这一页自己读一次**。
   *
   * 其他列表页早就各自这么做了（`MonitorView` / `RecordingsView` / `AlarmsView` /
   * `TrendsView` / `SamplesView` / `EventCenterView` / `DeviceDetailView`），只有设备管理页
   * 原来完全依赖外壳（`AppShell`）在启动时读的那一次。而这一页恰恰最不该把"还没读到"显示成
   * "没有设备"：`DeviceTree` 对 `devices.length === 0` 只画一句"没有设备"。
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

onUnmounted(() => {
  // 行末的 `⋮` 菜单按第 8 条删掉了（编辑与删除升成两列），所以这里不再有"点外面关菜单"
  // 的监听器 —— 少一个监听器也少一处"关不掉的浮层"。
})

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
// 右键重命名（产品要求：右键设备行改设备名、右键通道行改通道名）
// ---------------------------------------------------------------------------

/**
 * 正在改的对象。
 *
 * 用判别联合而不是「一堆可空字段」：`channelIndex` 只在改通道时存在，而 `renameError`
 * / `renameNotice` 这类字段一旦可以同时为空或同时有值，就会出现「改设备名时用到了
 * 一个 undefined 的通道号」这种只有运行时才发现的错。
 */
type RenameTarget =
  | { kind: 'device'; deviceId: string }
  | { kind: 'channel'; deviceId: string; channelIndex: number }

const renameOpen = ref(false)
const renameTarget = ref<RenameTarget | null>(null)
const renameError = ref('')
const renameSaving = ref(false)

/** 正在改的设备；它被删掉时对话框里的名字会退回空串而不是留在上一台。 */
const renameDevice = computed<Device | undefined>(() => {
  const target = renameTarget.value
  return target ? devices.byId(target.deviceId) : undefined
})

const renameKind = computed<DeviceKind>(() => renameDevice.value?.kind ?? 'acousticBox')

const renameChannel = computed<Channel | undefined>(() => {
  const target = renameTarget.value
  if (!target || target.kind !== 'channel') return undefined
  return (devices.channels[target.deviceId] ?? []).find(
    (channel) => channel.channelIndex === target.channelIndex
  )
})

/**
 * 输入框的初值。
 *
 * 改设备名时读**数据库里的名字**（不是树上的显示名）：树上相机的地址不会出现，
 * 但那是显示规则，把它当成输入初值会让一次「保存」把本地名字默默改成「声学相机」。
 * 改通道名时读设备上报的通道名（就是树上那个名字）。
 */
const renameCurrentName = computed(() => {
  const target = renameTarget.value
  if (!target) return ''
  if (target.kind === 'device') return renameDevice.value?.name ?? ''
  return renameChannel.value?.channelName ?? ''
})

const renameChannelLabel = computed(() => {
  const target = renameTarget.value
  if (!target || target.kind !== 'channel') return ''
  return `CH${target.channelIndex + 1}`
})

function onRenameDevice(deviceId: string): void {
  renameTarget.value = { kind: 'device', deviceId }
  renameError.value = ''
  renameOpen.value = true
}

function onRenameChannel(deviceId: string, channelIndex: number): void {
  renameTarget.value = { kind: 'channel', deviceId, channelIndex }
  renameError.value = ''
  renameOpen.value = true
}

/**
 * 写入新名字；返回 `true` 才关闭对话框。
 *
 * 落点按 `kind` 分（绝不按名字或地址猜）：
 *   - **声纹设备**：本机数据库 + 设备自身（`config.setDeviceName`）。两件事都做完才算
 *     成功；只改成本地那一半会让本机显示一个新名字而设备仍然叫旧名字，而这正是这一
 *     轮要消灭的那种谎话 —— 所以设备侧被拒时本机那一半会被**回滚**（见
 *     `renameDeviceName`）。
 *   - **声学相机**：**只有本机数据库**。FA371 的开放接口没有设备名称端点
 *     （`docs/reference/FA371-api-spec.md` §3：手册 32 个接口里没有「设备重命名」，
 *     表后注明确把它列为「Open Interface 未开放」），所以这里不可能有第二种结果；
 *     对话框会当面把这件事说给操作员（`deviceRename.cameraHint`），成功提示也明说
 *     「相机本身没有改名」。
 *   - **通道**：写在设备上（`config.updateChannel`），成功之后**重新读**本机那份通道表，
 *     否则树和卡片会继续显示旧名字。
 *
 * 失败一律返回 `false` 并把原因留在对话框里：主进程对这三个写入都要求管理员，
 * 权限不足会被如实拒绝，而一个被拒绝的写入绝不能看起来像成功过。
 *
 * **声纹设备改名失败必须回滚本机那一半**：设备比本机权威（真实名字在设备上），
 * 而「本机显示新名字、设备仍叫旧名字」正是这一轮要消灭的那种谎话。所以失败时用
 * `devices.update` 把本机改回原名，并把「设备的原文 + 本机已恢复」一起说给操作员；
 * 万一连回滚也失败，就直说本机与设备现在不一致，而不是假装没事。
 */
async function submitRename(name: string): Promise<boolean> {
  const target = renameTarget.value
  if (!target) return false
  renameSaving.value = true
  renameError.value = ''
  const ok = target.kind === 'device' ? await renameDeviceName(name) : await renameChannelName(name, target)
  renameSaving.value = false
  return ok
}

/** 改设备名（本地 + 设备侧，见 `submitRename` 的说明）。 */
async function renameDeviceName(name: string): Promise<boolean> {
  const device = renameDevice.value
  if (!device) return false

  // 回滚要用的原值必须**在写入之前**取：`renameDevice` 是 store 上的计算属性，
  // 本地那一半一改，它立刻就是新名字了。
  const previousLocalName = device.name

  const updated = await devices.update({ id: device.id, name })
  if (!updated) {
    renameError.value = devices.error || t('deviceRename.deviceFailed')
    return false
  }

  if (device.kind === 'acousticBox') {
    const result = await callApi(() => window.api.config.setDeviceName(device.id, name))
    if (!result.success) {
      // 设备侧被拒（多半是权限、设备不可达或设备不认这个名称）。本机那一半刚刚已经
      // 落库了，先把它改回去，否则树会显示一个设备并不具备的名字。
      const restored = await devices.update({ id: device.id, name: previousLocalName })
      if (!restored) {
        renameError.value = t('deviceRename.renameBoxRestoreFailed', {
          reason: resultMessage(result),
          name: previousLocalName
        })
        return false
      }
      renameError.value = t('deviceRename.renameBoxRestored', {
        reason: resultMessage(result),
        name: previousLocalName
      })
      return false
    }
    notice.value = t('deviceRename.renameBoxNotice', { name: updated.name })
    return true
  }

  // 相机：本地数据库是**唯一**的落点（见函数头）。
  notice.value = t('deviceRename.renameCameraNotice', { name: updated.name })
  return true
}

/** 改通道名：写设备，再把本机那份通道表读回来（否则界面继续显示旧名字）。 */
async function renameChannelName(
  name: string,
  target: Extract<RenameTarget, { kind: 'channel' }>
): Promise<boolean> {
  const result = await callApi(() =>
    window.api.config.updateChannel(target.deviceId, target.channelIndex, { name })
  )
  if (!result.success) {
    renameError.value = resultMessage(result)
    return false
  }
  const channels = unwrap(result) as ChannelConfigView[] | undefined
  await devices.loadChannels(target.deviceId, true)
  const written = channels?.find((channel) => channel.channelIndex === target.channelIndex)
  notice.value = t('deviceRename.renameChannelNotice', { name: written?.name ?? name })
  return true
}
</script>

<template>
  <div class="page">
    <!--
      这一页**没有页头**（产品要求）：外层框架的标题栏已经写了「设备管理」，这里再写一遍
      是同一条事实的第二处实现。「添加设备」也跟着搬进了左侧拓扑树的树头（参考 ThingsBoard
      的设备管理架构：左侧列表自带新增入口），所以整块 `page-header` 都删掉了 ——
      留一个只剩按钮的空页头，等于把"被删掉的那一行"换成一个更占地方的占位。
    -->

    <p v-if="actionError" class="alert alert--danger" role="alert">{{ actionError }}</p>
    <p v-if="notice" class="alert alert--success" role="status">{{ notice }}</p>

    <!--
      两列：左边拓扑（选择设备 + 新增设备），右边设备表（管理设备）。
      拓扑不再是全局侧栏的一部分——产品要求它属于设备管理的内容。小屏下折成单列，
      顺序是「先看拓扑，再看设备表」，与阅读顺序一致。
    -->
    <div class="devices-layout">
      <section class="card devices-topology">
        <DeviceTree
          :selected-device-id="treeSelection"
          :can-add-device="session.isAdmin"
          @select="selectDevice"
          @open="openDeviceInWall"
          @add="addOpen = true"
          @rename-device="onRenameDevice"
          @rename-channel="onRenameChannel"
        />
      </section>

      <div class="devices-main">
        <EmptyState v-if="cards.length === 0" :title="t('devices.empty')" />

        <!--
          设备表（业主 2026-09-17 第 3 条；**列清单在 2026-09-18 第 8 条里重给了**）：
          序号 / 设备名称 / IP地址 / 设备类型 / 状态 / 告警数量 / 通道数 / 查看 / 设置 / 删除。
          与上一版清单的差别逐条写进 `docs/Ivcs4200…` 那一份（见 §15.50）：多了"序号"，
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
                    'devices-table__row--selected':
                      device.id === (activeRowId || treeSelection)
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
      </div>
    </div>

    <AddDeviceDialog v-model="addOpen" @added="onAdded" />

    <!--
      右键菜单里的「修改设备名称 / 修改通道名称」。
      三种落点（本地 + 设备 / 只有本地 / 只有设备）由对话框当面说明，写入由本页执行：
      它拿着设备 store 与 IPC 桥，也知道失败之后该显示哪一句。
    -->
    <DeviceRenameDialog
      v-model="renameOpen"
      :target="renameTarget?.kind ?? 'device'"
      :kind="renameKind"
      :device-name="renameDevice?.name ?? ''"
      :channel-label="renameChannelLabel"
      :current-name="renameCurrentName"
      :saving="renameSaving"
      :error="renameError"
      :on-submit="submitRename"
    />

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
 * 拓扑 + 卡片两列。左列固定宽度（树的层级缩进需要可预期的宽度），右列吃掉剩余空间。
 * `align-items: start` 让拓扑卡按内容高度收住，而不是被拉成与设备卡片一样高。
 *
 * 左列的第一行是**树的第一个行**，所以 `.devices-topology` 自己不加上内边距：
 * 卡片在内容盒的左上角，树行就在卡片内容盒的左上角 —— 与总览页那块内容列同一个
 * 视觉起点（`--space-6` 由 `.app-content` 提供，是这页与总览页共用的唯一来源）。
 */
.devices-layout {
  display: grid;
  grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
  align-items: start;
  gap: var(--space-4);
}

@media (max-width: 900px) {
  .devices-layout {
    grid-template-columns: minmax(0, 1fr);
  }
}

.devices-topology {
  /* 只有右上左三个方向的内边距；上边距为 0，树从卡片顶部开始。 */
  padding: 0 var(--space-3) var(--space-2);
  /* 设备多起来时树自己滚，不去撑高整页——页面滚动条已经由内容区管着。 */
  max-height: 60vh;
  overflow: auto;
}

.devices-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
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
 *   ④ 被选中的那一行加底色 —— 与左侧拓扑树里高亮的是同一台设备。
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
