/**
 * Application accounts — the software's OWN login, not a device's.
 *
 * WHY THE APPLICATION NEEDS ACCOUNTS AT ALL
 * The devices this app manages are single-account appliances: an AE08 box and an
 * FA371 camera both ship with one un-renameable `admin` account and no notion of
 * roles (`docs/reference/FA371-api-spec.md` §6 — the camera cannot even change its
 * password over the API). So "administrator and normal user, with a way back in
 * when a password is forgotten" cannot be delegated to the hardware; it has to
 * live here.
 *
 * WHAT SEPARATES THE TWO ROLES
 * Deliberately small and checkable, because a permission model nobody can state
 * in one sentence is a permission model nobody will enforce consistently:
 *
 *   - `admin`    — everything, including account management and destructive
 *                  device operations (add/remove, factory reset, firmware).
 *   - `operator` — monitoring and everyday work: view devices, browse alarms and
 *                  recordings, run the protocol lab. Cannot manage accounts, and
 *                  cannot add or remove devices.
 *
 * Configuration writes are guarded the same way as destructive operations: they
 * change what the hardware does, which is exactly the thing an operator should not
 * be doing unattended.
 */

/** Role identifiers. The union members ARE the `domain.userRole.*` catalogue keys. */
export type UserRole = 'admin' | 'operator'

// ---------------------------------------------------------------------------
// 权限目录（手册 §17.1，p177–178）
// ---------------------------------------------------------------------------

/**
 * 可**逐项勾选**的权限。
 *
 * 取值同时是 `domain.permission.<value>` 目录键的取值，因此界面不需要任何查表：
 * 后端只产出这些稳定标识，四种语言的文案在目录里。
 *
 * ---------------------------------------------------------------------------
 * 与既有 `UserRole` 的关系（**没有改语义，只是把手册的复选框落到既有模型上**）
 * ---------------------------------------------------------------------------
 * 本仓库原有模型只有两个角色，且把「谁能做什么」硬编码在 `requireAdministrator()`
 * 里。手册 §17.1 要求管理员「默认全权」、操作员「默认无权限、权限手工勾选」，
 * 所以这一轮把手册的复选框实现成**上述硬规则之外的细粒度授权**：
 *
 *   - `manageAccounts` / `manageSystemSettings` 是**管理员专属**（见
 *     `ADMIN_ONLY_PERMISSIONS`）：它们就是仓库原本那条 `requireAdministrator()`
 *     规则本身，勾给操作员等于把角色改掉。因此它们对操作员**恒为未勾选且禁用**，
 *     `AuthService` 也会拒绝任何把它们授予操作员的写入。
 *   - 其余权限是操作员**可以拿到**的东西。其中「监控/告警/录像/趋势」这类只读能力
 *     出厂就勾给操作员了（`OPERATOR_DEFAULT_PERMISSIONS`）——比手册更宽，理由写在
 *     那个常量上。
 *   - 仓库原本的「操作员不能新增/删除设备」由 `manageDevices` 默认未勾选来表达，
 *     而不是删掉那条硬规则。
 */
export type UserPermissionKey =
  | 'manageAccounts'
  | 'manageSystemSettings'
  | 'manageDevices'
  | 'configureDevices'
  | 'controlCameras'
  | 'deleteRecordings'
  | 'downloadDetectFiles'
  | 'viewDevices'
  | 'viewAlarms'
  | 'viewRecordings'
  | 'viewTrends'
  | 'viewEvents'

/** 运行时清单，用于校验一个经 IPC 到达的取值。顺序即界面上的勾选顺序。 */
export const USER_PERMISSION_KEYS: readonly UserPermissionKey[] = [
  'manageAccounts',
  'manageSystemSettings',
  'manageDevices',
  'configureDevices',
  'controlCameras',
  'deleteRecordings',
  'downloadDetectFiles',
  'viewDevices',
  'viewAlarms',
  'viewRecordings',
  'viewTrends',
  'viewEvents'
]

export function isUserPermissionKey(value: unknown): value is UserPermissionKey {
  return typeof value === 'string' && (USER_PERMISSION_KEYS as readonly string[]).includes(value)
}

/**
 * 管理员专属权限：勾给操作员等于把 `operator` 改成 `admin`。
 *
 * 这两项对应仓库原有的那条硬规则（`AuthService.requireAdministrator()`）：
 * 账号管理与系统设置写入都要求管理员。把它们做成复选框是为了让手册的清单完整，
 * 而不是给操作员开一条新路——所以它们对操作员**恒为禁用**。
 */
export const ADMIN_ONLY_PERMISSIONS: readonly UserPermissionKey[] = [
  'manageAccounts',
  'manageSystemSettings'
]

export function isAdminOnlyPermission(key: UserPermissionKey): boolean {
  return ADMIN_ONLY_PERMISSIONS.includes(key)
}

/**
 * 操作员**出厂就带**的权限。
 *
 * ⚠ **与手册 §17.1 不同，这一点是刻意偏离，理由如下**：
 * 手册写的是「操作员默认无权限」。但本仓库既有的产品语义是「操作员负责值守：
 * 看设备、看告警、看录像、看趋势」（见本文件顶部与 `README`），而本仓库的监测页
 * 与总览页在启动时会真的去拉设备列表与实时流。若按手册给一个「什么都看不见」的
 * 操作员，这个角色在本产品里就没有任何用处，也会让既有的监测链路在默认配置下
 * 直接失效。
 *
 * 所以折中并且**写清楚**：只读的四项出厂勾上，**任何写入类权限出厂一律未勾选**
 * （手册「权限手工勾选」针对的正是这些）。这个偏离记在报告与目录里，不藏在代码里。
 */
export const OPERATOR_DEFAULT_PERMISSIONS: readonly UserPermissionKey[] = [
  'viewDevices',
  'viewAlarms',
  'viewRecordings',
  'viewTrends',
  'viewEvents'
]

/** 管理员的默认权限：全权（手册 §17.1「Administrator has all permissions by default」）。 */
export const ADMIN_PERMISSIONS: readonly UserPermissionKey[] = USER_PERMISSION_KEYS

/** 一个角色的出厂权限集（界面「恢复该用户默认权限」用它）。 */
export function defaultPermissionsForRole(role: UserRole): UserPermissionKey[] {
  return role === 'admin' ? [...ADMIN_PERMISSIONS] : [...OPERATOR_DEFAULT_PERMISSIONS]
}

/** 勾选态：每一个已知权限都有明确的是/否，界面不需要处理「缺字段」。 */
export type UserPermissionSet = Record<UserPermissionKey, boolean>

/**
 * 把任意输入归一化成**每一项都有值**的勾选态。
 *
 * `role === 'admin'` 时恒为全权；管理员专属项对操作员恒为 `false`。所以「操作员带着
 * `manageAccounts` 的权限集」在类型层面就不可能出现——它只会从主进程出来。
 *
 * ⚠ `granted === undefined` 表示**没有条目**，此时按该角色的**出厂默认**处理
 * （`defaultPermissionsForRole`），而不是"全部未勾选"：一个没有条目的操作员是
 * 「没被手工改过」，它有只读权限；空数组 `[]` 才是"被明确取消了全部可选权限"。
 * 这两件事在库里是两种不同的行，归一化器不能把它们混成一个。
 */
export function normalisePermissionSet(
  role: UserRole,
  granted: readonly UserPermissionKey[] | undefined
): UserPermissionSet {
  const set = {} as UserPermissionSet
  const grantedList = role === 'admin' ? ADMIN_PERMISSIONS : (granted ?? defaultPermissionsForRole(role))
  for (const key of USER_PERMISSION_KEYS) {
    if (role === 'admin') {
      set[key] = true
      continue
    }
    set[key] = isAdminOnlyPermission(key) ? false : grantedList.includes(key)
  }
  return set
}

/** 勾选态里**已启用**的权限，按目录顺序（存库用的就是这个形状）。 */
export function grantedPermissions(set: UserPermissionSet): UserPermissionKey[] {
  return USER_PERMISSION_KEYS.filter((key) => set[key] === true)
}

/** 从任意（可能是旧版本、可能被手改过的）输入里读出权限键数组。未知键一律丢掉。 */
export function readPermissionKeys(value: unknown): UserPermissionKey[] {
  if (!Array.isArray(value)) return []
  const out: UserPermissionKey[] = []
  for (const item of value) {
    if (isUserPermissionKey(item) && !out.includes(item)) out.push(item)
  }
  return out
}

/** 从权限键数组里滤掉管理员专属项（授予操作员时的唯一合法形态）。 */
export function withoutAdminOnly(
  keys: readonly UserPermissionKey[]
): UserPermissionKey[] {
  return keys.filter((key) => !isAdminOnlyPermission(key))
}

/** 硬约束：用户名不得包含这些字符（手册 §17.1 第 5198 行）。 */
export const USERNAME_FORBIDDEN_CHARACTERS = '/\\:*?"<>|'

/** 用户名长度上限。手册只规定字符集与账号总数，长度上限是本机的一条保守约束。 */
export const USERNAME_MAX_LENGTH = 32

/** 用户名的**第一条**违规原因键，或 `''` 表示可用。纯函数，界面与服务共用。 */
export function usernameProblemKey(username: string): '' | 'empty' | 'forbidden' | 'tooLong' {
  const value = username.trim()
  if (!value) return 'empty'
  for (const character of USERNAME_FORBIDDEN_CHARACTERS) {
    if (value.includes(character)) return 'forbidden'
  }
  if (value.length > USERNAME_MAX_LENGTH) return 'tooLong'
  return ''
}

/** 手册 §17.1：最多 50 个账号。 */
export const MAX_USER_ACCOUNTS = 50

/**
 * 每一项权限**管住哪些操作**（稳定标识，不是文案）。
 *
 * 为什么需要这张表：一个权限目录如果只存在于界面上，它就是装饰。这张表把「这一项
 * 到底管什么」写进共享层，于是：
 *   - `handlers.ts` 的写路径按它调用 `requirePermission()`；
 *   - 账号管理界面按它显示每一项的适用范围（`domain.permissionScope.*`）；
 *   - `tests/account-settings-round.test.ts` 断言**每一项权限都至少管一个操作**，
 *     所以"加了一个复选框但它什么都不做"会是一条失败的测试。
 *
 * 取值是 IPC 通道名，与 `IpcChannels` 一致；用字符串而不是 import 那个对象，
 * 是为了让共享领域层不反向依赖 IPC 契约表（那会绕成一个环）。
 */
export const PERMISSION_OPERATIONS: Record<UserPermissionKey, readonly string[]> = {
  manageAccounts: [
    'auth:list-users',
    'auth:create-user',
    'auth:delete-user',
    'auth:reset-password',
    'auth:set-role',
    'auth:set-permissions',
    'auth:copy-permissions',
    'auth:update-profile'
  ],
  manageSystemSettings: [
    'settings:update',
    'settings:restore-defaults',
    'settings:pick-alarm-sound',
    /**
     * IoT 数据接入的读数（业主 2026-09-19 第 1 条）。
     *
     * 归这一项而不是 `viewDevices`：它回的是**监听事实**（绑定地址、端口、起没起来）与
     * 收数统计 —— 那是系统设置页上那张卡片，与 `settings:update` 在同一页、同一档权限。
     * 界面上的"数据接入"页签只有管理员进得去，所以这一条与它一致。
     */
    'iot-ingest:status',
    /**
     * 瓦片缓存下载（业主 20260921 批）：它写在设置「集成 → 地图」那张卡里、改的是
     * 本机存储根（map-cache/），与 `settings:update` 同一档 —— 管理员 + 系统设置写入。
     */
    'map:cache-tiles'
  ],
  manageDevices: [
    'device:add',
    'device:update',
    'device:remove',
    'device:open-web-ui',
    /**
     * 推流秘钥与推流地址（业主 2026-09-18 第 10 批第 5 条）。
     *
     * 归 `manageDevices` 而不是 `configureDevices`：秘钥是**这台设备在库里的凭据**
     * （与"它在不在库里、叫什么、地址是什么"同一件事），而 `configureDevices` 管的是
     * 写进设备里的参数。读端点信息时第一次会**生成**一条秘钥，那是一次写库 ——
     * 所以它不该只要求"能看设备"。
     */
    'device:ingest-endpoint',
    'device:rotate-push-secret',
    'maintenance:reboot',
    'maintenance:factory-reset',
    'maintenance:system-upgrade',
    'maintenance:upload-firmware',
    'camera-upgrade:upload',
    'camera-upgrade:reboot'
  ],
  configureDevices: [
    'config:update-channel',
    'config:set-sample-rate',
    'config:save-alarm-profile',
    'config:delete-alarm-profile',
    'config:change-network',
    'config:update-time',
    'config:sync-time',
    'config:update-rs485',
    'config:update-modbus',
    'config:set-device-name',
    /*
     * 空气声呐的球机联动（PTZ）三条（业主 2026-09-17 第 8 批）。
     *
     * 归 `configureDevices` 而不是 `manageDevices`：它们是**设备配置**（写的是设备上的
     * `cam_*` 参数），与上面那一批同一件事；而 `manageDevices` 管的是"这台设备在不在库里"
     * （添加/删除/改地址）。能看设备状态不等于能改它的球机地址 —— 但能改设备配置的人
     * 也应该能改这一组，所以不新开一项权限（新开会让账号管理界面多一个复选框，
     * 而它管的事与"配置设备"完全重叠）。
     */
    'e2:ptz',
    'e2:ptz-update',
    'e2:nvt-time-sync',
    /** SN-16 实时回调写回设备（notify_url / is_send_realtime_value）。 */
    'e2:realtime-callback-update'
  ],
  controlCameras: [
    'camera-live:start',
    'camera-live:stop',
    'camera-live:source',
    'camera-nvr:start-recording',
    'camera-nvr:stop-recording',
    'camera-nvr:snapshot',
    'fa371-stream:start',
    'fa371-stream:stop',
    'camera-alarm:create-strategy',
    'camera-alarm:update-strategy',
    'camera-alarm:delete-strategies',
    'camera-alarm:create-condition',
    'camera-alarm:update-condition',
    'camera-alarm:delete-conditions',
    'camera-control:write-run-mode',
    'camera-control:turn-on-detect',
    'camera-control:turn-off-detect',
    'camera-control:set-strategy-enabled',
    'camera-control:apply-mode-preset',
    'camera-control:restore-mode-values',
    'camera-control:write-work-mode'
  ],
  /**
   * ⚠ **这一项目前没有可执行的落点，刻意留空。**
   *
   * 本工程到今天为止**没有**任何一条删除录像/录音的 IPC 通道（`RECORDING_QUERY` 是
   * 读，`RECORDING_SYNC_DEVICE` 是把设备上的录音镜像下来）。手册的权限清单里有
   * "删除录像"，所以复选框要有；但把 `recording:query`（一个只读通道）写进这里来
   * 凑数，会让"这一项管着什么"变成一句假话 —— 一个只读通道被授予并不需要什么权限。
   *
   * 于是空数组：`tests/account-settings-round.test.ts` 里有一条断言把**只有它**列为
   * 允许为空的一项，并同时钉住"其余每一项都必须至少管一个操作"。等真的有了删除通道，
   * 把通道名填进来，那条断言就会要求它不再为空。
   */
  deleteRecordings: [],
  downloadDetectFiles: ['event-center:download-detect-file'],
  viewDevices: [
    'device:list',
    'device:get',
    'device:get-info',
    'device:get-channels',
    /** SN-16 实时回调状态（只读设备参数，见 E2_REALTIME_CALLBACK）。 */
    'e2:realtime-callback'
  ],
  /**
   * 告警这一路的读 + **确认** + **备注/改判等级**。
   *
   * 「确认」写在本项下而不是 `manageDevices`/`manageSystemSettings` 下，理由：确认一条
   * 待处理告警是**值守动作**（把已经看过的告警从待处理里清掉），不是配置变更；它不改
   * 设备、不改设置、不删记录。`handlers.ts` 里它仍然额外要管理员（那是仓库原有的角色
   * 规则，本轮没有放宽），所以这一项**当前**只是让拒绝的理由更精确。
   *
   * 备注与等级同属值守动作（v6 起）：它们只改**这条告警记录自己的注解**，不改设备、
   * 不改设置、不删记录。等级虽然影响联动闸门（未来），但改判本身仍是对记录的注解。
   */
  viewAlarms: [
    'alarm:query',
    'alarm:set-note',
    'alarm:set-severity',
    'alarm:count-by-severity',
    'linkage:get-status',
    'linkage:get-pending',
    'linkage:acknowledge',
    /**
     * 某条告警的**抓图**（业主 2026-09-17 第 8 批）：那是**告警的附件**，所以归这一项
     * 而不是 `viewRecordings`（录音是另一条记录）也不是 `configureDevices`（那是改设备）。
     * `e2:snapshot-close` 是同一个端点的收尾动作，跟着它一起授权。
     */
    'e2:alarm-snapshots',
    'e2:snapshot-close'
  ],
  viewRecordings: [
    'recording:query',
    'recording:playback-data',
    'recording:export',
    'camera-nvr:video-url',
    /**
     * 本地样本库（schema v7）：这个库是**从录音派生的**，打标签/删样本是对派生物的注解，
     * 不动录音本身、也不删录音文件 —— 所以它与"能不能看录音"是同一件事，不为它单开一项权限
     * （那会给账号管理界面多一个复选框，而它管的操作与 `viewRecordings` 完全重合）。
     */
    'sample:query',
    'sample:stats',
    'sample:add-from-alarm',
    'sample:add-from-alarms',
    'sample:add-from-recording',
    'sample:set-label',
    /** 标签库（两个维度的词表）：改名会连样本一起改，删除有引用检查 —— 但仍属"我的录音"。 */
    'sample:labels-list',
    'sample:label-add',
    'sample:label-rename',
    'sample:label-delete',
    'sample:remove',
    'sample:train',
    /**
     * 导出训练数据集。归在这里而不是管理员权限：导出的内容就是**他能看的那些录音**
     * （清单 + 可选音频），没有多给他任何东西。真正需要管的是"导到哪儿"，
     * 而那由主进程打开的系统对话框决定。
     */
    /** 听诊盒子族的「拉」通道：读设备状态 + 把告警与录音拉到本机（与"看录音"同一批）。 */
    'e2:status',
    'e2:sync-alarms',
    'sample:pick-export-dir',
    'sample:export-dataset',
    /** AI 标注：同上 —— 它读到的是同一批样本，写进去的是**候选**标签（不覆盖人工标注）。 */
    'sample:ai-status',
    'sample:ai-save-config',
    'sample:ai-label',
    /** 命名的 AI 服务库（业主追加）：与上面三条同一批 —— 管的是同一份候选标注配置。 */
    'sample:ai-services',
    'sample:ai-service-save',
    'sample:ai-service-delete',
    'sample:ai-service-set-active'
  ],
  /**
   * 趋势的读 + **导出 CSV**（业主 2026-09-19 第 13 批第 6 条：「支持数据导出」）。
   *
   * 导出归这一项而不是 `manageSystemSettings`：它导出的**就是这个操作员本来就能看到的数据**，
   * 而且只写进我们自己的导出目录（`存储根/exports/trends/`）—— 不改设备、不改库。
   * 把它提成管理员操作的话，一个只能看趋势的账号连"把看到的图存下来"都做不到。
   */
  viewTrends: ['trend:query', 'trend:coverage', 'trend:stats', 'trend:export-csv'],
  /** 事件中心的读 + **确认** + 取图片证据 + 处置（改状态/指派）+ 读处置流水；理由同上一条。 */
  viewEvents: [
    'event-center:query',
    'event-center:detect-logs',
    'event-center:acknowledge',
    // Phase 4（详情抽屉的 Evidence 页签）：把库里的相对路径变成回环图片地址。**只读**：
    // 不连设备、不写盘、不写库 —— 所以它与 `query` 同级，不是特权操作。
    'event-center:evidence-image',
    'event-center:evidence-image-close',
    // Phase 5：处置（改状态/指派，写库 + 写 Activity）与读处置流水。
    // 写的那一条在 handlers 里**另外**要求管理员（与 acknowledge 一致）。
    'event-center:change-status',
    'event-center:activity',
    // Phase 6 后半（规格 §14.2 的 V1）：Incident 的两条读 + 三条写。
    // 读的两条（这条 Alert 属于谁 / 现在有哪些）与 `query` 同级；写的那三条
    // （建/关联/解除，写 incidents 与 incident_alerts）在 handlers 里另外要求管理员。
    'event-center:incidents-for-alert',
    'event-center:incident-list',
    'event-center:incident-create',
    'event-center:incident-link',
    'event-center:incident-unlink'
  ]
}

/**
 * 唯一一项**允许**暂时没有落点的权限（见上面 `deleteRecordings` 的说明）。
 *
 * 写成常量而不是散在测试里的字符串：这份豁免是有理由的，而且它应该在某一天消失。
 */
export const PERMISSION_WITHOUT_ENFORCEMENT: readonly UserPermissionKey[] = ['deleteRecordings']

/** 某一项权限覆盖的操作数（界面用来证明它不是装饰）。 */
export function permissionOperationCount(key: UserPermissionKey): number {
  return PERMISSION_OPERATIONS[key].length
}

/** Runtime list, for validating a value that arrived over IPC. */
export const USER_ROLES: readonly UserRole[] = ['admin', 'operator']

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value)
}

/**
 * Whether a role may perform administrator-only actions.
 *
 * One function rather than scattered `role === 'admin'` comparisons: the day a
 * third role appears (a read-only auditor, say), this is the single place that has
 * to learn about it.
 */
export function isAdministrator(role: UserRole): boolean {
  return role === 'admin'
}

/**
 * A user as the renderer may see it. NEVER carries the password hash.
 *
 * The main process is the only place a hash exists. `UserRecord` in the repository
 * layer is the shape that has it, and it is deliberately not exported across IPC —
 * a hash is not a secret worth leaking, but shipping it to the renderer would make
 * it available to any script that ends up running in the page.
 */
export interface UserSummary {
  id: string
  username: string
  displayName?: string
  role: UserRole
  /** True for an account still on its factory/reset password. */
  mustChangePassword: boolean
  /** Epoch ms of the last successful login, if any. */
  lastLoginAt?: number
  createdAt: number
  /**
   * 逐项勾选的权限（手册 §17.1）。**每一项都有值**，界面不需要处理缺字段。
   *
   * 由主进程算出来：管理员恒为全权，管理员专属项对操作员恒为 `false`
   * （见 `normalisePermissionSet`）。渲染层提交回来的任何权限都被忽略，
   * 所以它无法被伪造。
   *
   * 可选**只**为兼容性：旧 preload（开发服务器渲染层）与既有测试里手工构造的
   * `UserSummary` 字面量没有这个字段。界面读到 `undefined` 时按
   * `defaultPermissionsForRole(role)` 显示，而不是把它当成「无权限」——
   * 那会把一个管理员显示成只剩只读权限。
   */
  permissions?: UserPermissionSet
}

/** 管理员改某个账户的显示名称（手册 §17.1 的 Edit User）。 */
export interface UpdateUserProfileInput {
  userId: string
  /** 空字符串 = 清掉显示名，界面回落到用户名。 */
  displayName: string
}

/** 管理员改某个账户的权限（逐项勾选后的全量提交，不是增量）。 */
export interface UpdateUserPermissionsInput {
  userId: string
  permissions: UserPermissionKey[]
}

/**
 * 「从…复制权限」的入参。
 *
 * 复制的是**权限**，不是密码、不是角色：手册 §17.1 的 Copy from 下拉框只搬复选框。
 * `sourceUserId === targetUserId` 由服务拒绝——自己复制给自己没有意义，而且会让
 * 「恢复默认权限」和「复制」哪个是权威变得说不清。
 */
export interface CopyUserPermissionsInput {
  sourceUserId: string
  targetUserId: string
}

/** Who is currently signed in to this window. */
export interface SessionInfo {
  user: UserSummary
  /** Epoch ms the session was established (i.e. when the app was unlocked). */
  signedInAt: number
}

/** Credentials for a login attempt. */
export interface LoginInput {
  username: string
  password: string
}

/**
 * 登录页要预填的东西（业主 2026-09-16：「记录上次的用户名」「勾选了记住密码就记住」）。
 *
 * 用户名**总是**返回（它不是秘密）：产品要求的第 1 条与第 2 条是两件事，取消勾选「记住密码」
 * 之后用户名仍然应该被记住。
 */
export interface RememberedLoginSnapshot {
  /** 上次登录用的用户名；空串表示这台机器上还没有记录。 */
  username: string
  /** 密码，只在「勾选过 + 未过期 + 系统加密可用」时出现。 */
  password?: string
  /**
   * 曾经记住过、现在过了 90 天。
   *
   * 与"从没记住过"分开：界面上的说法不同（要提示"请重新输入密码"，而不是什么都不说）。
   */
  expired: boolean
  /** 这台机器上系统加密（DPAPI / 密钥环）是否可用；为假时密码不会被记住。 */
  persistent: boolean
}

/**
 * 登录成功之后把这次的输入交给主进程保存。
 *
 * 三个布尔/可选字段各有分工，缺一个都会让「每三个月重新输入」失效或让取消勾选无效：
 *   - `rememberPassword`：用户那个勾选框；
 *   - `password`：只在需要记住时才传；
 *   - `userTypedPassword`：这一次的密码是**用户亲手输入**的（不是自动填充的）。它决定要不要
 *     开一个新的 90 天窗口 —— 自动填充的登录不续期，否则"每三个月重新输入"永远不会发生。
 */
export interface RememberLoginInput {
  username: string
  password?: string
  rememberPassword: boolean
  userTypedPassword: boolean
}

/** Create another account (administrator only). */
export interface CreateUserInput {
  username: string
  password: string
  displayName?: string
  role: UserRole
  /**
   * 创建时勾选的权限（手册 §17.1 第 5 步：Input the user name … and check the
   * checkboxes to assign the permissions for the created user）。
   *
   * 缺省 = 该角色的出厂默认。管理员恒为全权，所以这份清单只对操作员有意义
   * （其中管理员专属项会被服务丢掉）。
   */
  permissions?: UserPermissionKey[]
}

/** Change one's own password; requires the current one. */
export interface ChangePasswordInput {
  currentPassword: string
  newPassword: string
}

/**
 * Regain access with the super password.
 *
 * The username is required because the reset applies to ONE account; a super
 * password that silently reset "some" account would be worse than useless.
 */
export interface RecoverAccountInput {
  username: string
  superPassword: string
  newPassword: string
}

/** Administrator-side reset of somebody else's password. */
export interface ResetUserPasswordInput {
  userId: string
  newPassword: string
}

/**
 * Password policy, in one place so the UI can state it and the service can enforce
 * it without the two drifting apart.
 *
 * Deliberately modest: this is a single-machine industrial tool whose threat model
 * is somebody walking up to an unattended console, not an internet-facing service.
 * A policy that is annoying enough to encourage written-down passwords would make
 * the tool LESS safe, which is the trap to avoid here.
 *
 * 取值 6 来自手册 §17.1（p178，第 5199 行）的**硬约束**：
 * 「the length of the password cannot be less than 6 characters」。本仓库原来是 8，
 * 这一轮按手册降到 6 —— 这是一次**放宽**，不是收紧：手册同时「强烈建议」至少 8 位
 * 并且混合大小写/数字/符号，但那是建议（`recommend`），不是它可以拒绝的条件。
 * 界面照实说明下限，`tests/account-settings.test.ts` 钉住 6 与「5 位被拒」。
 */
export const PASSWORD_MIN_LENGTH = 6
/** The factory administrator password. Documented in README/BUILD on purpose. */
export const DEFAULT_ADMIN_USERNAME = 'admin'
export const DEFAULT_ADMIN_PASSWORD = 'Hz@123456'
