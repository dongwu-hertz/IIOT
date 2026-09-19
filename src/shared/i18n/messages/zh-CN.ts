/**
 * Chinese (Simplified) — the REFERENCE locale.
 *
 * Every other catalogue is typed against this file's shape (see `schema.ts`), so
 * a key added here must be added to `en`, `es` and `tr` or the build fails. This
 * is the language the product originally shipped in, and remains the default.
 *
 * CONVENTIONS
 *  - Keys are grouped by the screen or concern that owns them, never by widget
 *    type. `settings.title`, not `pageTitle.settings`.
 *  - Placeholders use named braces (`{count}`), never positional `{0}`, because
 *    Spanish and Turkish reorder clauses and a positional placeholder forces the
 *    translation to fight the sentence.
 *  - No punctuation is baked into a label that is concatenated elsewhere.
 */

export const zhCN = {
  /**
   * 左侧栏的设备树（多设备拓扑 + 选择）。
   *
   * 与 `cameraLiveUi` 同一条硬规则：**本块任何一条消息都不得包含 `@`**
   * （vue-i18n 的 linked-message 记法，渲染时会编译成 SyntaxError，
   * `tests/i18n.test.ts` 会编译每一条消息来兜住这一点）。
   *
   * 这里的措辞决定「操作员能不能一眼看出这台设备通不通」，所以每一条状态
   * 都用完整句子，不用 `OK` / `NG` 之类的缩写。
   */
  common: {
    confirm: '确认',
    cancel: '取消',
    save: '保存',
    saving: '保存中…',
    delete: '删除',
    edit: '编辑',
    close: '关闭',
    refresh: '刷新',
    reset: '重置',
    loading: '加载中…',
    none: '无',
    unknown: '未知',
    clearSelection: '取消选择',
    viewAll: '查看全部',
    unit: {
    }
  },

  /**
   * Application errors, keyed by the stable `ErrorCodes` values from
   * `shared/errors.ts`.
   *
   * WHY THESE LIVE HERE AND NOT IN THE MAIN PROCESS
   * The main process already returns a stable code alongside its message. Adding
   * a translation catalogue there would mean shipping four languages into a
   * process that renders no UI, and would require the language choice to be
   * pushed across the IPC boundary. Translating at the single renderer-side
   * chokepoint (`lib/result.ts`) keeps one source of truth and no cross-process
   * state.
   */
  errors: {
    DEVICE_OFFLINE: '设备当前离线，无法连接',
    TIMEOUT: '请求超时，请检查网络或设备状态',
    AUTH_FAILED: '认证失败，请检查用户名与密码',
    INVALID_RESPONSE: '设备返回的数据格式无法识别',
    DEVICE_ERROR: '设备报告了一个错误',
    STORAGE_ERROR: '本地存储操作失败',
    DISK_FULL: '磁盘可用空间不足，已暂停非必要录音',
    NETWORK_ERROR: '网络连接失败',
    VALIDATION_ERROR: '输入内容不合法',
    NOT_IMPLEMENTED: '该功能暂不可用',
    UNKNOWN: '发生未知错误',
    /** Used when the failure carries no code at all. */
    fallback: '操作失败',
    /** Device-originated text is shown verbatim and cannot be translated. */
    deviceDetail: '设备返回：{detail}',
    /** Appends the code so support can triage a screenshot. */
    withCode: '{message}（{code}）',
    bridgeUnavailable: '无法连接到主进程，请重启应用',
    bridgeUnavailableDetail: '{message}：{detail}',
    FORBIDDEN: '当前账户没有执行该操作的权限',
    AUTH_USERNAME_TAKEN: '该用户名已被占用',
    AUTH_LAST_ADMIN: '必须保留至少一个管理员账户',
    AUTH_PASSWORD_POLICY: '密码不符合要求（至少 8 位，不能包含用户名，首尾不能有空格）',
    AUTH_LOCKED: '登录失败次数过多，请稍后重试',
    authLockedRetry: '登录失败次数过多，请在 {seconds} 秒后重试'
  },

  language: {
    label: '界面语言',
    description: '切换后立即生效，并会记住你的选择。'
  },

  /**
   * Application chrome: the sidebar, the topbar and the window title.
   *
   * `nav.*` keys are referenced by the route table and the sidebar, so a route
   * and its label cannot drift apart.
   */
  app: {
    title: 'HERTZINNO Acoustic Box Manager',
    tagline: '设备管理软件',
    /** 侧栏折叠按钮（事件中心规格 §3.2）。 */
    collapseSidebar: '收起侧栏',
    expandSidebar: '展开侧栏',
    nav: {
      overview: '总览',
      devices: '设备管理',
      monitor: '实时监测',
      trends: '历史趋势',
      alarms: '告警中心',
      /**
       * 地图信息（GIS）（业主 2026-09-17 第 8 批建的页；2026-09-18 第 10 批第 12 条改名并挪位置）。
       *
       * 原来叫「点位图」，排在「设备管理」**之后**。第 12 条的原话是「『点位图』改名
       * 『地图信息（GIS）』并移到设备管理上方、总览下方」—— 名字与顺序都是业主给的。
       * 名字里带上 GIS 是因为这一页要放 GIS 服务/平面图（第 13 条），不只是几个点。
       */
      map: '地图信息',
      /**
       * 事件与告警中心（产品要求「设置事件和告警中心」）。
       *
       * 与 `/alarms`（只有声纹设备自己的告警行）不同：这一个页面按时间倒序合并
       * 三路来源——相机检测日志、本机告警联动、声纹告警。
       */
      events: '事件与告警中心',
      recordings: '录音文件',
      samples: '样本库',
      settings: '系统设置',
      protocolLab: '协议实验室',
      deviceDetail: '设备详情'
    },
    versionFallback: '版本 —',
    /**
     * 页面页脚（产品要求：右侧底部显示公司版权与版本号）。
     *
     * `{year}` 由界面传入，取**发布日期**的年份而不是运行时的年份——版权声明说的是
     * 那个发布的制品，不是「现在」。
     */
    footerCopyright: '版权所有 © {year} HERTZINNO',
    mainNavigation: '主导航',
    /** Release metadata, shown in both the sidebar footer and the About panel. */
    releasedOn: '发布于 {date}',
    builtOn: '构建于 {date}',
    appVersion: '应用版本',
    releaseDate: '发布日期',
    buildDate: '构建日期',
    operatingSystem: '操作系统',
    databasePath: '数据库路径',
    storageRootPath: '存储根目录',
    copyPath: '复制',
    copiedPath: '已复制'
  },

  /**
   * Settings page.
   *
   * Named `settingsUi` rather than merged into `settings` because the two carry
   * different kinds of text: `settings.*` holds the shared vocabulary for storage
   * and retention values that several screens read, while this block is the
   * settings SCREEN's own copy. Merging them made it ambiguous whether a label
   * was shared or screen-local, which is how the same release-metadata labels
   * nearly ended up defined twice.
   */
  settingsUi: {
    saveButton: '保存设置',
    revert: '撤销修改',
    loadFailedTitle: '无法读取系统设置',
    reload: '重新读取',

    /*
     * 页签（业主 2026-09-17 的 ③：把 语言/存储/视频/告警/邮箱/账号/关于 做成切换卡片页）。
     *
     * 页签名就是业主给的那一串里的名字；「关于」那一页里还放着「恢复默认值」，
     * 所以它的名字带上"维护"两个字（业主 ⑯ 的措辞是「关于 / 维护」）。
     */
    tabLanguage: '语言',
    tabStorage: '存储',
    tabVideo: '视频与缓冲',
    tabIot: '数据接入',
    tabAlarm: '告警',
    tabEmail: '邮箱',
    tabAccount: '账号',
    tabAbout: '关于与维护',

    /** 存储页第一组的小标题：**存储位置** + 保留策略（页签名已经是"存储"，卡片不再重复写）。 */
    storageGroupLocation: '位置与保留',
    /** 视频与缓冲页里那一组（业主 ④：设备探测与缓冲合成一组）。 */
    probeBufferGroup: '设备探测与缓冲',
    /** 账号页里"当前会话"那一组（谁在登录 / 改密码 / 退出登录）。 */
    accountSessionGroup: '当前会话',


    storagePath: '存储路径',
    picking: '选择中…',
    browse: '浏览…',
    retentionDays: '录音保留天数',
    minFreeGb: '最小剩余空间（GB）',

    healthCheckMs: '健康检查间隔（毫秒）',
    offlineThreshold: '离线判定失败次数',
    requestTimeoutMs: '请求超时（毫秒）',

    preAlarmSeconds: '告警前录制（秒）',
    postAlarmSeconds: '告警后录制（秒）',
    ringBufferSeconds: '缓冲区总时长（秒）',

    liveSection: '实时视频',
    autoPlayCameraLive: '打开软件时自动播放',
    autoPlayOn: '已开启',
    autoPlayOff: '已关闭',

    diskSection: '磁盘占用',
    diskBelowFloor: '剩余空间已低于安全阈值，已停止非必要录音。请清理磁盘或调整「最小剩余空间」。',
    diskUnavailable: '尚未读取到磁盘信息。',
    diskBarLabel: '磁盘已使用 {percent}%',
    diskUsedOfTotal: '已使用 / 总容量',
    diskUsedValue: '{used} / {total}（{percent}%）',
    diskFree: '剩余空间',
    diskFreeValue: '{bytes}（{gb}）',
    diskAppUsage: '本程序占用',
    diskAppUsageValue: '{bytes}（约占 {percent}%）',

    trendSection: '趋势存储',
    trendFlushing: '写入中…',
    trendFlushNow: '立即落盘',
    trendUnavailable: '尚未读取到趋势存储状态。',
    trendBuffered: '待写入缓冲',
    trendFilesWritten: '已写入文件',
    trendRowsWritten: '已写入行数',
    trendLastFlush: '最近落盘时间',
    trendNeverFlushed: '尚未落盘',
    trendLastError: '最近错误',
    trendWrote: '已写入 {rows} 行，共 {files} 个文件',
    trendNothing: '缓冲区为空，没有需要写入的数据',
    rows: '{count} 行',
    files: '{count} 个',


    saveFailed: '保存失败',
    saveSuccess: '设置已保存',
    copyFailed: '复制失败，请手动选中文本后复制',
    browsePicked: '已选择新的存储路径，点击「保存设置」后生效',
    errStorageRoot: '存储路径不能为空',
    errRetentionDays: '保留天数需为不小于 1 的整数',
    errMinFree: '最小剩余空间不能为负数',
    errHealthCheck: '健康检查间隔需不小于 1000 毫秒',
    errOfflineThreshold: '离线判定次数需为不小于 1 的整数',
    errRequestTimeout: '请求超时需不小于 1000 毫秒',
    errAlarmWindows: '告警前后录制时长不能为负数',
    errRingBuffer: '环形缓冲区时长需为不小于 1 的整数',
    errRingBufferTooShort: '环形缓冲区时长需不小于告警前 + 告警后录制时长',

    /**
     * 一键恢复默认值（手册 §17.2 第 5227 行）。
     *
     * `restoreItems*` 与 `SettingsService.RESTORABLE_SETTING_KEYS` 一一对应，
     * 由 `tests/account-settings.test.ts` 钉住项数；确认对话框逐项列出它们。
     */
    restoreDefaults: '恢复默认值',
    restoreTitle: '恢复默认值',
    restoreIntro: '以下系统设置项将被恢复为出厂默认值：',
    restoreItemStorage: '存储路径（恢复为平台默认路径）',
    restoreItemRetention: '录音保留天数',
    restoreItemMinFree: '最小剩余空间',
    restoreItemHealthCheck: '健康检查间隔',
    restoreItemOfflineThreshold: '离线判定失败次数',
    restoreItemRequestTimeout: '请求超时',
    restoreItemPreAlarm: '告警前录制时长',
    restoreItemPostAlarm: '告警后录制时长',
    restoreItemRingBuffer: '环形缓冲区总时长',
    restoreItemAutoPlay: '打开软件时自动播放实时视频',
    restoreItemMaxStreams: '同时直播路数上限',
    restoreItemAlarmLinkage: '告警联动（含邮件服务器、收件人、模板与冷却）',
    restoreItemAlarmSounds: '告警声音库（声音类型与所选音频文件）',
    restoreItemIotIngest: '数据接入（HTTP 推流 / MQTT 的开关、监听地址与端口）',
    restoreWarnStorage: '存储路径会被改回默认值。磁盘上已有的录音与文件不会被删除，只是不再被指向；需要保留原路径时请先记下它。',
    restoreKeeps: '设备列表、通道、录像与录音文件、告警记录、账号与账号权限都不会被改动。',
    restoreConfirm: '恢复默认值',
    restoreNotice: '系统设置项已恢复默认值。SMTP 口令仍保存在本机凭据库中，如需清除请在邮件设置里点「清除已保存的口令」。'
  },

  /**
   * 总览页「实时画面」这一块自己的文案。
   *
   * 与 `cameraLiveUi` 分开的**唯一**理由是：同一件事在两页上的说法不同。监测页的
   * 按钮写「开始视频」，总览页的状态行写「尚未开始」；共用 key 会逼着两页说同一句
   * 话，而那句话对其中一页一定是别扭的。`title` 仍复用 `cameraLiveUi.title`。
   *
   * 与其它目录块同一条铁律：**任何一条消息里不得出现 `@`**（vue-i18n 的链接消息
   * 前缀，会让这条消息在渲染时崩掉），`tests/i18n.test.ts` 会编译每一条消息。
   */
  overviewLiveUi: {
    cameraLabel: '相机',
    device: '设备',
    fullscreen: '全屏',
    statusNoCamera: '未注册相机',
    statusIdle: '尚未开始',
    statusStarting: '正在启动视频…',
    statusPlaying: '视频播放中',
    statusRtspDisabled: '相机 RTSP 未启用',
    statusFfmpegMissing: '内置 ffmpeg 不可用',
    statusError: '视频流失败',
    statusLimitExceeded: '已达同时直播上限',
    statusOccupied: '画面在另一个页面上',
    noCameraHint: '尚未注册声学相机，先在「设备管理」中添加一台相机。',
    idleHint: '尚未开始播放。点击「开始视频」即可看到相机画面。',
    startingHint: '正在启动…',
    rtspDisabledHint:
      '相机的 RTSP 服务处于关闭状态（设备上报 rtsp_enabled=0）。请在相机 Web 界面的「高级设置 → RTSP」中启用后再试。',
    ffmpegMissingHint: '内置的 ffmpeg 转封装组件缺失或无法运行，请重新安装本软件；应用日志中记录了它查找过的路径。',
    errorHint: '视频流已中断，可以点击「重试」重新打开。',
    limitExceededHint:
      '本机同时直播的路数已达上限（可在「系统设置 → 实时视频」调整）。请先停止其他画面格里的直播，再打开这一路。',
    occupiedHint:
      '监测页正在播放这台相机的画面。同一台相机同时只有一路画面，点击「开始视频」会把画面接管到本页（对方页面的画面会停止）。',
    diagnosis: '主进程诊断：{reason}',
    rtspAddressUnknown: '设备未上报视频地址'
  },

  devices: {
    addDevice: '添加设备',
    empty: '尚未添加设备',
    name: '设备名称',
    ip: 'IP 地址',
    port: 'HTTP 端口',
    username: '用户名',
    password: '密码',
    testConnection: '测试连接',
    saveFailed: '保存失败',
    deleteFailed: '删除设备失败',
    status: {
      online: '在线',
      offline: '离线',
      unknown: '未知'
    },
    columns: {
      actions: '操作'
    }
  },

  /**
   * Device management page.
   *
   * New text is added per page as it is migrated; see README §8.6 for the
   * remaining backlog. The earlier `devices.*` block above holds the dialog and
   * table vocabulary shared by several screens, so this page reuses it where the
   * wording is identical rather than duplicating strings.
   */
  devicesUi: {
    addButton: '添加设备',
    noticeAdded: '设备已添加',
    noticeUpdated: '已更新设备「{name}」',
    noticeRemoved: '已删除设备「{name}」',
    deviceId: '设备 ID',
    mac: 'MAC 地址',
    channelCount: '通道数',
    /**
     * 设备表的列表头（业主 2026-09-17 的清单逐字给过；**2026-09-18 第 8 条重给了**）：
     * 序号 / 设备名称 / IP地址 / 设备类型 / 状态 / 告警数量 / 通道数 / 查看 / 设置 / 删除。
     *
     * 与上一版的差别：多了「序号」；「设备IP」→「IP地址」、「是否在线」→「状态」、
     * 「设备通道」→「通道数」；「配置」拆成「设置」与「删除」两个图标列（原来藏在 `⋮` 菜单里）。
     */
    indexColumn: '序号',
    ipColumn: 'IP地址',
    channelColumn: '通道数',
    onlineColumn: '状态',
    alarmCountColumn: '告警数量',
    ipDoubleClickHint: '双击打开设备 Web 界面',
    /** 设备表那一列的表头，也是「查看」图标按钮的说明（业主的列清单里叫「查看」）。 */
    viewColumn: '查看',
    /** 「设置」= 打开编辑对话框（名称 / 端口 / 凭据 / 地址信息），业主第 10 条那一个。 */
    settingColumn: '设置',
    /** 「删除」= 删除这台设备（破坏性动作，弹确认）。 */
    deleteColumn: '删除',
    /**
     * 「配置」：**点位图/地图页**上那一台设备的入口（进 `/devices/:id` 的配置页）。
     * 设备表那一列按第 8 条改叫「设置」之后，这个词只剩地图页一个读者 —— 它说的仍然是
     * "配置这台设备"（页签：通道配置 / 告警策略 / 维护与升级），所以留着。
     */
    configure: '配置',
    /** 点设备名进详情/配置页（页签：概览 / 检测模式 / 告警策略 / 维护与升级）。 */
    openDetail: '查看设备详情与配置',
    /** 编辑对话框里 IP 那一格只读的原因（业主第 10 条：IP 不可改）。 */
    ipReadonlyHint: 'IP 地址决定设备身份，不可修改',
    /** 凭据两格留空的意思（口令与用户名都不回显）。 */
    credentialsKeep: '留空 = 不修改',
    credentialsHint: '凭据保存在本机凭据库里，不会回显；填了才会写入。',
    passwordShow: '显示密码',
    passwordHide: '隐藏密码',
    editTitle: '编辑设备',
    editNameRequired: '设备名称不能为空',
    editPortInvalid: 'HTTP 端口需为 1-65535 之间的整数',
    deleteTitle: '删除设备',
    deleteBody: '确定要删除设备「{name}」吗？该设备的历史告警与录音记录将保留，但本地保存的连接凭据会被清除。',
    removing: '删除中…',
    confirmDelete: '确认删除'
  },

  /**
   * 拓扑树上的重命名（右键 → 修改设备名称 / 修改通道名称）。
   *
   * 这一块的存在理由是**诚实**，不是措辞：同一个动作在三种情形下落点不同 ——
   *   - 声纹设备：本地库 + 设备自身的名字都改（`config.setDeviceName`）；
   *   - 声学相机：FA371 的开放接口里**没有**设备名称端点
   *     （`docs/reference/FA371-api-spec.md` §3 的表后注明确列出「设备重命名」未开放），
   *     所以只能改我们本地数据库，「设备本身」一个字都没变；
   *   - 通道：只改设备（本地库里的通道表随后由 `devices.getChannels` 重新读出）。
   *
   * 因此成功提示分成 `renameBoxNotice` / `renameCameraNotice` 两条：操作员读完这一句
   * 必须知道**刚刚到底改动了什么**，而「已重命名」四个字会让他以为相机的名字也改了。
   */
  time: {
    justNow: '刚刚',
    secondsAgo: '{count} 秒前',
    minutesAgo: '{count} 分钟前',
    hoursAgo: '{count} 小时前',
    daysAgo: '{count} 天前',
    never: '从未'
  },

  duration: {
    minutesSeconds: '{minutes} 分 {seconds} 秒',
    hoursMinutes: '{hours} 小时 {minutes} 分'
  },

  /**
   * Alarm taxonomy (appendix B). Keys match `ALARM_TYPE_KEYS` in
   * `shared/domain/models.ts` exactly, so the mapping needs no lookup table of
   * its own — `t('alarms.type.' + alarmTypeKey(type))` is the whole mechanism.
   */
  alarms: {
    type: {
      spl: '声压级异常',
      main_frequency: '主频异常',
      band_energy_ratio: '频带能量比异常',
      smoothness: '平滑度异常',
      clamp_looseness: '夹具松动',
      cooler_anomaly_a: '冷却器异常 A',
      cooler_anomaly_b: '冷却器异常 B',
      overload: '过载',
      short_circuit_surge: '短路冲击',
      surface_discharge: '沿面放电',
      corona_discharge: '电晕放电',
      gap_discharge: '间隙放电',
      floating_discharge: '悬浮放电',
      dc_bias: '直流偏磁'
    },
    /** Unknown bit set: surfaced rather than dropped, so new firmware is visible. */
    unknownMask: '未知告警 (0x{mask})',
    none: '无告警'
  },

  /**
   * Alarm records screen.
   *
   * The `metric*` labels are shared with the trend page's metric picker, so they
   * live under `metrics` rather than here — otherwise the same acoustic quantity
   * would end up named twice and could drift.
   */
  alarmsUi: {
    countSummary: '共 {total} 条记录，已选 {selected} 条',
    bulkAcknowledge: '批量确认',
    bulkUnacknowledge: '取消确认',
    addSelectedToSamples: '加入样本库',
    sampleAddDone: '入库完成：新增 {created} 条，已在库 {existing} 条，其中 {withMetrics} 条带特征值。',
    sampleAddPartial: '入库完成：新增 {created} 条，已在库 {existing} 条，失败 {failed} 条（记录已不存在）。',
    sampleAddedWithMetrics: '已入库（{count} 维特征），弱标签：{label}',
    sampleAddedNoMetrics: '已入库，但这条告警没有特征值，暂时不能参与训练。',
    sampleAlreadyIn: '这条已经在样本库里了（未重复写入）。',
    sampleSectionTitle: '样本库',
    sampleSectionHint: '把这条告警的指标与弱标签存进本地样本库，供二次训练。',
    addToSamples: '加入样本库',
    goSamples: '查看样本库',
    filterDevice: '设备',
    filterAllDevices: '全部设备',
    filterChannel: '通道',
    filterType: '告警类型',
    filterAllTypes: '全部类型',
    filterFrom: '开始时间',
    filterTo: '结束时间',
    filterAck: '确认状态',
    filterAllChannels: '全部通道',
    ackAll: '全部',
    ackAcknowledged: '已确认',
    ackUnacknowledged: '未确认',
    columnTime: '时间',
    columnDevice: '设备',
    columnChannel: '通道',
    columnType: '告警类型',
    columnStatus: '状态',
    selectAll: '全选',
    selectRow: '选择 {id}',
    loading: '正在加载…',
    empty: '没有符合条件的告警记录',
    pagerRange: '第 {from} – {to} 条 / 共 {total} 条',
    prevPage: '上一页',
    nextPage: '下一页',
    detailTitle: '告警详情',
    metricsTitle: '告警时刻指标',
    playbackTitle: '录音回放',
    goSyncRecordings: '前往「录音文件」同步录音',
    ackSectionTitle: '确认',
    markAcknowledged: '标记为已确认',
    notifyAcknowledged: '已确认 {count} 条告警',
    notifyUnacknowledged: '已取消确认 {count} 条告警',
    notifyDetailAcknowledged: '该告警已确认',
    notifyDetailUnacknowledged: '该告警已取消确认',
    filterSeverity: '告警等级',
    filterAllSeverities: '全部等级',
    moreFilters: '更多筛选',
    hideMoreFilters: '收起更多筛选',
    moreFiltersActive: '更多筛选（{count} 项生效）',
    columnSeverity: '等级',
    severitySectionTitle: '告警等级',
    noteSectionTitle: '备注',
    noteEmpty: '还没有备注',
    notePlaceholder: '写一条备注…',
    noteSave: '保存备注',
    noteClear: '清除备注',
    noteTooLong: '备注最多 {max} 个字符（当前 {length}）',
    noteSaved: '备注已保存',
    noteCleared: '备注已清除',
    severitySaved: '告警等级已改为「{level}」',
    recordMissing: '这条告警已不在记录中，改动没有保存',
    prevEvent: '上一事件',
    nextEvent: '下一事件',
    eventPosition: '第 {index} / {total} 条（当前筛选结果）'
  },

  /** Acoustic quantity names, shared by the alarm detail panel and the trend page. */
  metrics: {
    spl: '声压级',
    mainFrequency: '主频',
    smoothness: '平稳度',
    bandEnergyRatio: '频带能量比',
    oddEvenHarmonicRatio: '奇偶谐波比',
    spectralComplexity: '频谱复杂度',
    fingerprintVariation: '指纹变化度'
  },

  /**
   * Domain labels. Keys mirror `ALARM_TYPE_KEYS`-style snake_case identifiers so
   * `t('domain.sensorType.' + key)` needs no lookup table of its own.
   */
  recordingsUi: {
    filterType: '录音类型',
    filterAllTypes: '全部类型',
    columnStart: '开始时间',
    columnDevice: '设备',
    columnChannel: '通道',
    columnType: '类型',
    columnDuration: '时长',
    columnSampleRate: '采样率',
    columnFormat: '格式',
    columnSize: '文件大小',
    columnDownloaded: '下载状态',
    columnPlay: '播放',
    columnSample: '样本库',
    addToSamples: '加入样本库',
    sampleHint: '录音本身不含特征值：入库后可人工标注，但要能训练还需有特征数据',
    sampleAddedNoMetrics: '已入库。这段录音没有特征值，暂时不能参与训练——可在样本库里人工标注。',
    sampleAlreadyIn: '这段录音已经在样本库里了（未重复写入）。',
    empty: '暂无录音文件，可使用「同步设备录音」从设备导入',
    downloaded: '已下载',
    notDownloaded: '未下载',
    playLabel: '播放 {time} 的录音',
    playLocal: '播放本地录音',
    playRemote: '播放（将先从设备下载）',
    playerTitle: '录音回放',
    playerTitleAt: '录音回放 · {time}',
    videoPlayerTitle: '视频录像播放',
    videoLoading: '正在打开视频文件…',
    videoUnavailable: '该录像无法在内置播放器中播放（本地文件缺失或格式不受支持）。'
  },

  monitorUi: {
    noDeviceTitle: '请先添加设备',
    goToDevices: '前往设备管理',
    deviceLabel: '监测设备',
    noAddress: '无地址',
    channelHint: '{count} 个通道',
    /*
     * 这里原来还有 `start: '开始监测'` / `stop: '停止监测'`：业主 2026-09-19 第 13 批
     * 第 3 条要求「选中设备就默认开始接收数据，不用点击开始监测按钮」，按钮删掉之后
     * 这两个词条没有任何地方再用（会话状态仍然由页头那枚徽标显示），
     * 四本目录同步删除 —— 理由见 §15.80。
     */
    channelSelect: '通道选择',
    /** 声呐那一支的机型徽标（顶栏状态行）。 */
    sonarFamilyBadge: 'SN-16 空气声呐',
    /*
     * 这里原来还有 `sonarLiveUnwired`（"实时音频/时频流尚未接入（手册给的是 WebSocket 路径，
     * 未在真机验证）……"）那一长句：它既在页面顶上当横幅，也挂在机型徽标的 `title` 上。
     * 业主 2026-09-18 第 19 条要求删掉这段话 —— 设备在不在线改由设备下拉旁边的绿点/灰点
     * 回答，不再用一句话解释"这一屏为什么没有实时图"。四个目录同步删除，理由留在这里。
     */
    /*
     * 「数据流状态」那张卡片与「当前帧」卡片按业主 2026-09-17 的要求删掉了（③），
     * 相关的键（streamSection/streamSummary/currentFrameSection/frameTimestamp/
     * sampleRate/currentChannel/dataSource/spectrogramCache/frames）一并删除 ——
     * 死键留在目录里会让下一次审计读不出"哪些是没人用的"。
     * 但**失败不留哑**：`streamFailure` 这一句保留了原来那张卡片的真正价值
     * （哪一路坏了）。
     */
    streamFailure: '{name} 这一路出错',
    currentValue: '{channel} 当前值',
    /*
     * ② 每通道声纹特性卡片（业主 2026-09-17）。
     *
     * 三种读数状态必须分开写：`live` 是此刻在收的那一路，`stored` 是**上一次**读到的
     * （卡片上带时间），`unread` 是从没读到过。把它们合成一句"无数据"就等于把
     * "旧读数"和"没读到"混成同一件事 —— 而操作员正是靠这个区别决定要不要相信那个数字。
     */
    channelFeaturesSection: '每通道声纹特性',
    channelFeaturesHint: '{count} 路通道；会话一次只订阅一路，卡片上是该路最后一次读数',
    channelFeature_live: '实时',
    channelFeature_stored: '最后一次读数',
    channelFeature_unread: '未读取',
    channelFeatureUnread: '这一路还没有读到过特征帧',
    channelFeatureUpdated: '更新于 {time}',
    /*
     * 2026-09-19 第 13 批第 3 条：这张卡片从"每通道一张小卡"改成**一张表**
     * （8 行 × 通道序号/声压级/主频/平稳度/频带能量比/是否告警），并且
     * 「点击告警则显示详细的告警状态」。下面这一组就是表头与告警那一列/详情弹窗的词条。
     */
    channelFeatureColumnChannel: '通道',
    channelFeatureColumnAlarm: '告警',
    channelAlarmYes: '告警',
    /*
     * 有记录但**都确认过了**：不标红（确认过的不再打断人），但入口留着 ——
     * 已确认不等于没发生过（判据在 `@shared/domain/channel-alarm.ts`）。
     */
    channelAlarmAcknowledged: '已确认',
    channelAlarmNone: '正常',
    channelAlarmOpen: '查看这一路的详细告警状态',
    /*
     * 这一列是**采样窗口**里的结论（最近 N 条），必须把 N 说出来：
     * 不写就等于把"最近这一批记录里没有"说成了"历史上从没有过"。
     */
    channelAlarmSampleHint: '告警一列来自最近 {count} 条告警记录；已确认的不再标红，仍可查看详情',
    channelAlarmDetailTitle: '{channel} 详细告警状态',
    channelAlarmAcknowledgedState: '已确认',
    channelAlarmUnacknowledgedState: '未确认',
    audioSection: '实时音频',
    audioPlay: '播放',
    audioStop: '停止播放',
    audioVolume: '音量',
    /*
     * 回放的是**包络预览**而不是原声：跨 IPC 过来的是 100 ms 一帧的降采样波形。
     * 这句话必须留着 —— 不说清楚就是在让操作员以为他听到的是设备里的原始声音。
     */
    audioPreviewHint: '播放的是 10 帧/秒的包络预览（降采样波形），不是原始音频。',
    startRecording: '开始录音',
    stopRecording: '停止录音',
    trendSection: '实时趋势',
    spectrumSection: '频谱',
    spectrogramSection: '时频图',
    /*
     * ③b 四张图谱卡片里的「声学波形」：画的是**跨 IPC 过来的降采样包络本身**
     * （100 ms 一帧），与「播放」按钮听到的是同一份数据 —— 所以那句说明照这个写。
     */
    waveformSection: '声学波形',
    waveformHint: '100 毫秒一帧的降采样包络（与播放听到的是同一份数据）',
    waveformAmplitude: '归一化幅度',
    waitingAudio: '等待音频帧…',
    /*
     * ③b 时间轴回放：只回放**本机**文件。
     * FA8 这一族没有设备侧连续录像，写成"回放设备录像"就是一句假话。
     */
    playbackSection: '时间轴回放',
    playbackLocalOnly: '只回放本机文件（设备侧没有连续录像）',
    playbackPrevious: '上一段',
    playbackNext: '下一段',
    playbackZoomIn: '放大',
    playbackZoomOut: '缩小',
    playbackWindow: '{from} – {to}',
    playbackNow: '现在',
    playbackLoading: '正在读取本机录像…',
    playbackEmpty: '本机还没有这台设备的录像（手动录像或从设备下载检测录像之后会出现在这里）',
    /*
     * 这一条**保留**：`RecordingPlayer`（回放面板）用它给采样率那一格做标签。
     * 名字带 `monitorUi` 是历史原因，四语言必须一致，所以它留在这里而不是新开一个键。
     */
    sampleRate: '采样率',
    /*
     * 这一组（`offlineBanner` / `offlineNoIp` / `offlineLastContent` / `offlineNoContent` /
     * `waitingBanner` / `staleBanner` / `stoppedBanner`）**在 2026-09-19 第 13 批第 1 条删掉了**：
     * 业主说「实时监测里面如果有告警弹窗（192.168.110.90 离线 还没有收到过这台设备的任何数据）
     * 这个内容不用显示」—— 那几句就是那条提示条的正文。四本目录同时删，理由见 §15.78。
     */
    staleBadge: '上次内容',
    waitingFeatures: '等待实时特征帧…',
    waitingSpectrum: '等待频谱帧…',
    waitingSpectrumData: '等待频谱数据…',
    sessionRunning: '实时数据运行中',
    sessionStarting: '正在启动数据流…',
    sessionError: '数据流异常',
    sessionStopped: '实时数据已停止',
    spectrumPerBin: '每 bin {hz} Hz',
    chartNormalizedEnergy: '归一化能量',
    chartBandEnergy: '频带能量'
  },

  streamState: {
    IDLE: '空闲',
    CONNECTING: '连接中',
    STREAMING: '接收中',
    RECONNECTING: '重连中',
    STOPPED: '已停止',
    ERROR: '错误'
  },

  spectrum: {
    /** Range label for the frequency axis, e.g. "0 – 48 kHz". */
  },

  trendsUi: {
    noDeviceTitle: '请先添加设备',
    goToDevices: '前往设备管理',
    filterDevice: '设备',
    /*
     * 这里原来还有 `filterChannel: '通道'`（筛选栏里那一排通道名前面的标签）。
     * 第 13 批第 4 条把通道搬到**图右侧那一列**（那一列自己有标题 `channelPanelTitle`），
     * 筛选栏里不再有通道控件，所以这个键四本目录一起删 —— 留着就是死键。
     */
    noAddress: '无地址',
    filterMetric: '指标',
    channelHide: '隐藏这条通道',
    channelShow: '显示这条通道',
    channelShowAll: '全部显示',
    /*
     * 第 13 批第 4 条：通道改成**右侧一列**（8 或 2 个通道 CH1…），可重命名、无数据灰显、
     * 有数据可勾选。下面这一组是那一列与改名用的词条。
     */
    channelPanelTitle: '通道',
    channelPanelSummary: '{withData} / {total} 路有数据',
    channelNoData: '这一段范围里这一路没有读数，勾选它只会得到一条空线',
    channelRename: '重命名',
    channelRenameHint: '改这一路的名称（写进设备，其余通道不变）',
    channelRenameOffline: '改名要写设备：设备在线、且是声纹设备时才能改',
    channelRenamePlaceholder: '通道名称',
    channelRenameFailed: '改名失败（设备没有确认）',
    channelRenamed: '{channel} 已改名',
    /*
     * 三条判定失败的说明（键名后缀与 `@shared/domain/channel-name.ts` 的
     * `CHANNEL_NAME_PROBLEM_KEYS` 一一对应）。
     */
    channelNameError_empty: '通道名称不能为空',
    channelNameError_tooLong: '通道名称最多 {count} 个字符',
    channelNameError_unchanged: '名称没有变化',
    channelHintVisible: '图上 {shown} / {total} 条通道',
    channelLines: '{count} 条通道',
    metricLimit: '最多同时显示 {count} 个量',
    metricMultiHint: '已选 {count} 个量：每个量一张图，每张图里是所有可见通道',
    metricNoData: '这个量在这段时间里没有读数（设备没有上报这一段）。',
    statQueries: '本次查询条数',
    filterAggregation: '聚合方式',
    filterFrom: '起始时间',
    filterTo: '结束时间',
    incompleteRange: '请选择完整的起始与结束时间',
    deviceNotSelected: '未选择设备',
    notQueried: '尚未查询',
    latestBucket: '最新时间桶',
    rangeMinBucket: '区间最低桶',
    rangeMaxBucket: '区间最高桶',
    emptyBuckets: '空缺时间桶',
    chartTitle: '趋势曲线',
    truncated: '结果已达到最大点数上限，仅显示前 {count} 个时间桶。请缩小时间范围以查看完整曲线。',
    noDeviceSelectedTitle: '请先选择设备',
    noHistoryTitle: '该设备暂无历史数据',
    goToMonitor: '前往实时监测',
    emptyRangeTitle: '所选时间范围内没有数据',
    coverageAvailable: '查看可用范围：{range}',
    noDataInBucket: '{value}（该时间桶无数据）',
    sampleCount: '样本数：{count}',
    loadingNotice: '正在查询历史数据…',
    noDataNotice: '尚未查询到数据',
    flushedNotice: '已写入 {rows} 行到 {files} 个历史文件',
    emptyBufferNotice: '缓冲区为空，没有需要写入的数据',
    statPoints: '返回点数',
    statRows: '原始行数',
    statBucket: '聚合桶大小',
    statFiles: '扫描文件',
    statDuration: '查询耗时',
    statRatio: '降采样比（行 : 点）'
  },

  aggregation: {
    avg: '平均',
    min: '最小',
    max: '最大',
    p95: '95分位'
  },

  bucket: {
    seconds: '{count} 秒',
    minutes: '{count} 分钟',
    hours: '{count} 小时',
    days: '{count} 天'
  },

  /** Y-axis title. Spanish and Turkish need their own punctuation, so this is
   *  a per-locale template rather than a shared bracket format. */
  axisTitle: {
    composite: '{metric}（{aggregation}）'
  },

  deviceDetailUi: {
    breadcrumbDevices: '设备管理',
    notFoundTitle: '设备不存在',
    backToList: '返回设备列表',
    deviceIdLabel: '设备 ID {id}',
    refreshing: '刷新中…',
    openWebUi: '打开设备页面',
    monitor: '监测',
    tabsLabel: '设备配置',
    tabOverview: '概览',
    tabChannels: '通道与采样率',
    tabAlarms: '告警参数',
    tabNetwork: '网络配置',
    tabTime: '时间 / NTP',
    tabSerial: 'RS485 / Modbus',
    tabPush: 'Push 上报',
    tabMaintenance: '设备维护',
    tabAuscultation: '听诊盒子',
    /** 空气声呐（SN-16）唯一的一页：球机联动配置。 */
    tabPtz: 'PTZ 联动',
    tabCameraDetect: '检测模式',
    tabCameraAlarms: '告警策略',
    tabCameraMaintenance: '维护与升级',
    overviewTitle: '设备概览',
    ip: 'IP 地址',
    httpPort: 'HTTP 端口',
    mac: 'MAC 地址',
    firmware: '固件版本',
    fpga: 'FPGA 版本',
    webVersion: 'Web 版本',
    channelCount: '通道数量',
    /*
     * 通道数**没能从设备问到**时的那句话（不是「0 路」）。
     *
     * `GET /get_devinfo` 实测根本没有通道数字段，而协议映射在设备没给这个字段时会把
     * 协议常量 8 填进去（`src/main/services/device/protocol/mappers.ts`），
     * 所以界面上那个 8 无法归因于设备；通道数的权威来源是 `GET /get_passageway`
     * 的行数（`docs/PROTOCOL-FINDINGS.md` §3.1）。查不到就不显示数字。
     */
    channelCountUnreported: '设备未上报通道数',
    sampleRate: '采样率',
    lastSeen: '最近在线',
    nameSection: '设备名称',
    nameLabel: '设备名称',
    saveName: '保存名称',
    nameRequired: '设备名称不能为空',
    nameSaveFailed: '设备名称保存失败',
    nameSaved: '设备名称已保存到设备',
    refreshedAt: '已刷新 {time}',
    webSection: '设备页面'
  },

  configCommon: {
    reload: '重新读取',
    revert: '撤销修改',
    unsaved: '有未保存的修改',
    saving: '保存中…',
    saved: '已保存',
    noChanges: '没有需要保存的修改',
    enabled: '已启用',
    disabled: '未启用',
    enabledOfTotal: '已启用 {enabled} / {total} 路',
    deviceWordingPrivate: '设备未公开该字段取值含义，此处按原值显示',
    baudRate: '波特率',
    dataBits: '数据位',
    stopBits: '停止位',
    unitPerDevice: '单位以设备为准，设备未公开说明',
    deviceTime: '设备时间',
    hostTime: '本机时间',
    drift: '偏差',
    readAt: '读取时刻：{time}',
    channel: '通道',
    status: '状态',
    target: '目标地址',
    publicWarningTitle: '设备正在向公网地址上传数据。'
  },

  configTime: {
    title: '时间 / NTP',
    syncNow: '立即对时',
    saveButton: '保存时间设置',
    saveFailed: '保存时间设置失败',
    syncFailed: '对时失败',
    savedNotice: '时间设置已保存，设备时间：{time}',
    syncedNotice: '已按本机时间对时，设备时间：{time}',
    ntpToggle: 'NTP 对时',
    ntpServer: 'NTP 服务器',
    ntpServerPlaceholder: '例如 cn.pool.ntp.org',
    ntpInterval: '同步间隔',
    errInterval: 'NTP 同步间隔需为不小于 1 的整数',
    errServerRequired: '启用 NTP 时必须填写 NTP 服务器地址',
    sameAsHost: '与本机基本一致',
    deviceAhead: '设备比本机快 {seconds} 秒',
    deviceBehind: '设备比本机慢 {seconds} 秒'
  },

  configModbus: {
    title: 'Modbus',
    type: '类型',
    typeOption: '类型 {n}',
    port: '端口',
    slaveId: '从站地址',
    saveButton: '保存 Modbus 配置',
    saveFailed: '保存 Modbus 配置失败',
    savedNotice: 'Modbus 配置已保存',
    errPort: 'Modbus 端口必须在 1-65535 之间',
    errSlaveId: 'Modbus 从站地址必须在 1-247 之间'
  },

  configRs485: {
    title: 'RS485',
    mode: '工作模式',
    modeOption: '模式 {n}',
    portLeft: '左端口',
    portRight: '右端口',
    unused: '（未使用）',
    portUnknown: '未知（设备不返回该字段）',
    portNotInList: '当前值不在设备返回的串口列表中，已原样保留',
    deviceAddress: '设备地址',
    saveButton: '保存 RS485 配置',
    saveFailed: '保存 RS485 配置失败',
    savedNotice: 'RS485 配置已保存'
  },
  configPush: {
    title: 'Push 上报',
    publicWarning: '上报目标中包含非内网地址，设备采集到的特征、图形与热力数据会离开本地网络。若不希望数据外发，请在设备本地界面关闭对应通道或改为内网地址。',
    unavailableTitle: '尚未读取到上报配置',
    kindFeatures: '特征数据',
    kindAlarm: '告警信息',
    kindImage: '图形数据',
    kindHeat: '热力数据',
    heatInterval: '热力数据上报间隔',
    targetScope: '目标地址范围',
    scopePublic: '包含公网地址',
    scopePrivate: '仅内网地址'
  },

  configNetwork: {
    title: '网络配置',
    saveButton: '保存网络配置',
    processing: '处理中…',
    saveFailed: '网络配置修改失败',
    mode: '地址模式',
    modeManual: '手动设置',
    modeDhcp: '自动获取（DHCP）',
    ip: 'IP 地址',
    netmask: '子网掩码',
    gateway: '默认网关',
    dns: 'DNS 服务器',
    legend: '网络配置',
    disconnectTitle: '修改地址会立即断开当前连接。',
    disconnectBodyBefore: '保存后程序会按新地址重新连接设备，并在设备无响应时',
    disconnectBodyStrong: '自动回退',
    disconnectBodyAfter: '到原配置。',
    disconnectWarning: '整个过程最长约 45 秒，期间请勿关闭程序或断开设备电源。若新旧地址都无法连接，只能通过设备本地界面或串口恢复。',
    progressTitle: '修改进度',
    progressRunning: '进行中',
    progressDone: '已结束',
    confirmTitle: '确认修改网络配置',
    confirmFrom: '设备地址将从',
    confirmTo: '改为',
    confirmPortSuffix: '（HTTP 端口 {port}）。',
    confirmBody: '保存后当前连接会立即中断。程序将自动用新地址重连设备并核对配置；若新地址无响应，会自动回退到原配置并把结果告诉你。',
    confirmWarning: '若新旧地址都无法连接，设备将只能通过本地界面或串口恢复。',
    confirmAction: '确认修改',
    errIp: 'IP 地址格式不正确',
    errNetmask: '子网掩码格式不正确',
    errGateway: '网关格式不正确',
    errDns: 'DNS 格式不正确',
    errPort: '{label}必须是 1-65535 之间的整数',
    portHttp: 'HTTP 端口',
    portRtsp: 'RTSP 端口',
    portTcp: 'TCP 端口',
    stageApplying: '正在写入新配置',
    stageApplied: '新配置已写入设备',
    stageReconnecting: '正在按新地址重连',
    stageConnected: '新地址已响应',
    stageVerifying: '正在核对设备回读值',
    stageVerified: '配置已生效',
    stageRollingBack: '新地址无响应，正在回退原配置',
    stageRolledBack: '已回退到原配置',
    stageUnreachable: '新旧地址均无响应'
  },
  configChannels: {
    title: '通道配置',
    countHint: '共 {count} 个通道',
    unavailableTitle: '尚未读取到通道配置',
    columnChannel: '通道',
    columnName: '名称',
    columnSensorType: '传感器类型',
    columnEnabled: '启用',
    columnAlarmProfile: '告警配置',
    columnActions: '操作',
    ariaName: '{channel} 名称',
    ariaSensorType: '{channel} 传感器类型',
    ariaEnabled: '{channel} 启用',
    ariaAlarmProfile: '{channel} 告警配置',
    enableOn: '启用',
    enableOff: '停用',
    unbound: '未绑定',
    errNameRequired: '通道名称不能为空',
    saveFailed: '保存失败',
    sampleRateTitle: '采样率',
    sampleRateCurrent: '当前：{rate}',
    sampleRateWarningBefore: '修改采样率会使设备',
    sampleRateWarningStrong: '重启采集',
    sampleRateWarningAfter: '，正在进行的实时监测会被中断，需要重新开始监测。',
    sampleRateLabel: '采样率',
    applyRate: '应用采样率',
    errRateSame: '请选择与当前不同的采样率',
    errRateFailed: '应用采样率失败',
    rateApplied: '采样率已应用为 {rate}，实时监测需要重新开始',
    confirmTitle: '确认修改采样率',
    confirmFrom: '采样率将从',
    confirmTo: '改为',
    confirmBody: '应用后设备会重启采集流程，正在进行的实时监测会立即中断，已开始的监测需要在设备恢复后重新启动。',
    applying: '应用中…',
    confirmApply: '确认应用'
  },

  configMaintenance: {
    title: '设备维护',
    destructiveBadge: '破坏性操作',
    refreshStatus: '刷新状态',
    running: '执行中…',
    rebootTitle: '重启设备',
    rebootConfirmTitle: '确认重启设备',
    rebootConfirmBody: '设备将立即重启，期间无法采集数据：实时监测会中断（约 30 秒），正在进行的录音会停止，告警在重启完成前不会产生。设备上的配置不会被修改。',
    rebootConfirm: '确认重启',
    upgradeTitle: '系统升级',
    upgradeConfirmTitle: '确认系统升级',
    upgradeConfirmBody: '设备将进入系统升级流程并重启，升级期间设备不可用，实时监测与告警都会中断。升级过程中请不要断开设备电源。',
    upgradeConfirm: '确认升级',
    resetTitle: '恢复出厂设置',
    resetConfirmTitle: '恢复出厂设置',
    resetConfirmBody: '设备上的全部配置——网络、通道、告警参数、RS485/Modbus、Push 上报与设备名称——都会恢复为出厂值，设备随后重启并断开连接。本程序已保存到电脑上的录音与告警记录不受影响。该操作无法撤销。',
    resetConfirm: '确认恢复出厂设置',
    resetTypePrompt: '请输入 {code} 以确认（区分大小写）',
    uploadTitle: '固件上传',
    uploadButton: '上传固件',
    uploading: '上传中…',
    uploadConfirmTitle: '确认上传固件',
    uploadConfirmBody: '上传后设备将写入新固件并重启，升级期间设备不可用。上传可能需要数分钟，期间请不要关闭本程序、关闭设备或断开网络。',
    uploadConfirm: '确认上传',
    selectedFile: '已选文件',
    fullPath: '完整路径',
    fileSize: '文件大小',
    sizeUnknown: '上传前无法读取（渲染进程无文件访问权限），上传完成后显示实际字节数',
    firmwareFile: '固件文件',
    uploadProgress: '固件上传中，无法获取进度',
    errNoFile: '请先选择固件文件',
    noticeRebooting: '设备正在重启，约需 30 秒。重启期间设备会短暂显示为离线。',
    noticeUpgrading: '已下发系统升级指令，设备将进入升级流程并重启。',
    noticeReset: '已下发恢复出厂设置指令。设备将恢复出厂配置并重启；建议重启后重新读取设备配置。',
    noticeUploaded: '固件上传完成，设备将开始升级并重启。',
    noticeOnline: '设备已恢复在线。',
    noticeStillOffline: '设备仍不可达，请稍后再次刷新。',
    chooseFirmware: '选择固件…',
    uploadWarning: '正在上传固件，请勿关闭程序、关闭设备或断开网络。上传结束后设备会自动开始升级。'
  },

  configAlarms: {
    title: '告警参数',
    addProfile: '新增配置',
    unavailableTitle: '尚未读取到告警参数',
    columnName: '名称',
    columnMode: '检测模式',
    columnSensitivity: '检测灵敏度',
    columnInterference: '干扰抑制等级',
    columnEnabledRules: '已启用的判据',
    columnActions: '操作',
    allDisabled: '全部未启用',
    editProfile: '编辑告警配置',
    createProfile: '新增告警配置',
    groupBasics: '基本信息',
    groupSpl: '声压级',
    groupMainFrequency: '主频',
    groupBandEnergy: '频带能量比',
    labelEnable: '使能',
    labelLower: '下限',
    labelUpper: '上限',
    labelThreshold: '阈值',
    saveProfile: '保存配置',
    deleteConfirmTitle: '删除告警配置',
    deleteConfirmBody: '确定删除告警配置「{name}」吗？',
    deleting: '删除中…',
    notifyCreated: '已新增配置「{name}」',
    notifySaved: '已保存配置「{name}」',
    notifyDeleted: '已删除配置「{name}」',
    errNameRequired: '名称不能为空',
    errNumeric: '「{field}」必须填写数字',
    errSensitivityRange: '检测灵敏度需在 0-100 之间',
    errMainFrequencyRange: '主频下限必须小于上限',
    errBandEnergyRange: '频带能量比下限必须小于上限',
    errFormInvalid: '填写内容有误',
    fieldSensitivity: '检测灵敏度',
    fieldInterferenceSuppression: '干扰抑制等级',
    fieldSplOverloadThreshold: '声压级过载阈值',
    fieldSplSurgeThreshold: '声压级突升阈值',
    fieldSplDropThreshold: '声压级突降阈值',
    fieldSplStabilityThreshold: '声压级稳定性阈值',
    fieldMainFrequencyLower: '主频下限',
    fieldMainFrequencyUpper: '主频上限',
    fieldBandEnergyRatioLower: '频带能量比下限',
    fieldBandEnergyRatioUpper: '频带能量比上限',
    fieldBandEnergyRatioThreshold: '频带能量比阈值',
    ruleOverload: '过载',
    ruleSurge: '突升',
    ruleDrop: '突降',
    ruleStability: '稳定性',
    ruleMainFrequency: '主频',
    ruleBandEnergy: '频带能量比',
    deleteWarning: '删除后无法恢复，使用该配置的通道需要重新绑定其他配置。若仍有通道绑定该配置，设备会拒绝删除，请先到「通道配置」中解除绑定。'
  },

  widgetsUi: {
    audioLevel: '音频电平',
    sampleRateAndFrame: '采样率 {rate} · {frame}',
    millisecondsPerFrame: '{value} ms/帧',
    recording: '录音中 {elapsed}',
    lastRecording: '上次录音 {elapsed}',
    peak: '峰值',
    rms: '有效值',
    audioUnavailable: '实时音频流未运行，表头无数据。',
    spectrogramAlt: '时频图 {time}',
    backToLatest: '回到最新',
    spectrogramWaiting: '等待时频图数据…',
    spectrogramFrames: '共 {count} 帧（设备端保留最近 5 帧）',
    lastRefresh: '上次刷新 {time}',
    offlineUnknownSummary: '离线 {offline} 台，未知 {unknown} 台',
    indicatorDevices: '设备总数',
    indicatorOnline: '在线设备',
    truncated: '{text}\n… (已截断)',
    arrayOf: '数组（{count} 项）',
    emptyObject: '空对象',
    modalClose: '关闭'
  },
  domainExtra: {
    connectionType: {
      LAN: '局域网',
      REMOTE: '远程'
    }
  },

  monitorErrors: {
    selectDevice: '请先选择一台设备',
    selectStream: '请至少选择一种数据流',
    startBeforeRecording: '请先启动实时监测，再开始录音'
  },

  rangeExtra: {
    label1h: '最近 1 小时',
    label24h: '24 小时',
    label7d: '7 天',
    label30d: '30 天',
    labelCustom: '自定义',
    errRangeOrder: '起始时间不能晚于结束时间'
  },

  addDeviceUi: {
    title: '添加设备',
    errIpRequired: '请输入设备 IP 地址',
    errIpRange: 'IP 地址格式不正确（每段需在 0-255 之间）',
    errHostInvalid: 'IP 地址或主机名格式不正确',
    errPort: 'HTTP 端口需为 1-65535 之间的整数',
    errUsername: '请输入登录用户名',
    errPassword: '请输入登录密码',
    errAddFailed: '添加设备失败',
    defaultPort: '默认 80',
    /**
     * 「地址信息」收起时那一行小结（业主 2026-09-19 第 13 批第 2 条：默认收起）。
     * 三档分开说，因为"没填"与"只填了一半"对操作员的下一步完全不同。
     */
    installationEmpty: '未填写',
    installationPoint: '点位 {latitude}, {longitude}',
    installationPartial: '只填了一部分',
    /**
     * 协议接入方式（业主 2026-09-19 第 13 批第 3、4 条）。
     *
     * 「数据流接口 / 视频流接口」这两个名字是业主给的说法（他点名参考 ThingsBoard 的那套）。
     * 监听状态那两句**必须带端口**：操作员要把它与设备上填的端口对一眼。
     */
    protocolSection: '协议接入方式',
    protocolHint: '这台设备往本机推数据时走哪条路。不接入表示它由本软件主动去连（默认）。',
    protocolNone: '不接入',
    protocolHttp: 'HTTP 接入',
    protocolMqtt: 'MQTT 接入',
    protocolListening: '本机正在 {port} 端口监听。',
    protocolNotListening: '本机此刻没有在监听（添加成功之后才会按这台设备的声明打开端口）。',
    protocolNotListeningReason: '本机没有在监听：{reason}',
    protocolListenUnknown: '读不到本机的监听状态。',
    metricKeysTitle: '数据流接口（遥测值）',
    metricKeysHint: '下面四个量各由一个遥测键送来，设备按这些键发，本机才画得出曲线。默认是规范名，设备用别的写法时才需要改。',
    videoKeyTitle: '视频流接口',
    videoKeyHint: '哪一个键装的是视频地址（RTSP / HTTP），留空表示这台设备不推视频。',
    protocolPlanInvalid: '接入方案里有不合法的键名或重复项，请检查上面的遥测键。',
    noResponseTitle: '设备无响应',
    noResponseBody: '目标地址可以访问，但未返回本系统可识别的设备信息。请确认 IP、端口与设备型号。',
    probeSuccess: '连接成功',
    probeLatency: '往返 {ms} ms',
    probeAuth: '认证方式 {strategy}',
    alreadyRegisteredTitle: '该设备已在系统中注册',
    firmwareVersion: '固件版本',
    fpgaWebVersion: 'FPGA / Web 版本',
    testing: '测试中…',
    adding: '添加中…',
    kindLabel: '设备类型',
    /*
     * 添加设备**不再让人选机型**（业主 2026-09-17 第 2 条）：协议由主进程自动匹配。
     * 这两句必须说出来：不说，操作员会去找那张已经被删掉的机型卡；
     * 说了，他会知道"识别结果会自己出现"。
     */
    autoDetectLead: '不用选机型：系统会按地址自动识别协议（声纹设备 / 空气声呐 / 声学相机），识别结果在「测试连接」之后显示。',
    detectedKind: '已识别为：{kind}',
    alreadyRegisteredBody: '继续添加不会创建新设备，只会更新它的连接地址（IP / 端口）。已注册的本地设备 ID：',
    /*
     * 探测回来的通道数**不是设备报的**时的那句话。
     *
     * 盒子在 `GET /get_devinfo` 里没有通道数字段，而协议映射会把协议常量 8 填进去
     * （见 `deviceDetailUi.channelCountUnreported` 的说明），所以探测面板里那个 8
     * 不能当成「设备上报了 8 路」。权威通道数只在登记之后由 `GET /get_passageway`
     * 读回，所以这里如实写「设备未上报」而不是显示一个我们没收到的数字。
     */
    channelCountUnreported: '设备未上报'
  },

  /**
   * **地址信息**（业主 2026-09-17 第 1 条；2026-09-18 第 7 / 10 条改名并删掉基准声压级）
   * —— 声源定位设备（Air Sonar / SN-16）的点位（GIS 经纬度）/ 朝向（方位角）。
   *
   * 口径写在文案里，因为这两项**手册里没有**（是我们的数据模型，见 `DeviceInstallation`
   * 的注释）：经纬度是 WGS84 十进制度，方位角 0 = 正北、顺时针。含糊的标签会让操作员填错
   * 口径，而错的口径比没填更糟。
   *
   * 删掉的两条（`soundLevel` / `soundLevelHint` / `errSoundLevel`）按业主 2026-09-18 第 10 条
   * 「基准声压级内容删除」：三个界面（添加设备 / 编辑设备 / 地址信息卡片）都不再显示它。
   * **库里的列与 API 仍在**（`devices.sound_level_db`，v11 迁移已经发布过，删列要再做一次
   * 迁移），旧值原样保留但界面不再读写 —— 取舍见 `docs/Ivms4200-UX-REFERENCE.md` §15.49。
   */
  /**
   * IoT 数据接入（业主 2026-09-19 第 1 条：HTTP 推流 + MQTT）。
   *
   * **手册未说明**这一节（手册里没有"IoT 接入"这一章），所以下面是我们的口径，
   * 形状照抄 ThingsBoard 的设备侧接入：秘钥放在 URL 路径里 / 当 MQTT 用户名。
   * 现场那台 FA8 声纹设备自己的 Push 配置就是这个形状（`GET /get_date_push` 实测），
   * 所以"我们自己的设备"与"第三方设备"共用同一套接收端。
   */
  iotUi: {
    enableLabel: '启用数据接入',
    enableHint: '默认关闭。开启后设备才能把数据推上来；关闭时两个监听都不会启动。',
    /**
     * 派生说明（业主 2026-09-19 第 13 批第 1 条之后，这一格是只读的）。
     */
    enableDerived: '这一格由设备决定：只要有一台设备在「添加设备 → 协议接入方式」里选了 HTTP 或 MQTT 接入，它就会打开；最后一台这样的设备被删掉之后，它会关掉。',
    bindLabel: '监听地址',
    bindHint: '0.0.0.0 表示所有网卡（设备才连得上）；127.0.0.1 表示只允许本机。',
    errBind: '监听地址只能是 0.0.0.0、127.0.0.1 或一个 IPv4 地址',
    errPort: '端口需为 1-65535 之间的整数',
    httpGroup: 'HTTP 推流',
    httpEnable: '启用 HTTP 推流',
    httpPortLabel: 'HTTP 端口',
    httpPathLabel: '推流路径',
    mqttGroup: 'MQTT',
    mqttEnable: '启用 MQTT',
    mqttPortLabel: 'MQTT 端口',
    mqttTopicLabel: '发布主题',
    mqttUserHint: '连接时用设备秘钥当用户名，密码留空。',
    secretLabel: '设备秘钥',
    manualNote: '手册未说明这一节：形状照抄 ThingsBoard 的设备侧接入（秘钥在 URL 路径里、MQTT 用秘钥当用户名），这样现场设备与第三方设备都能接。',
    devicesWithSecret: '已有秘钥的设备：{count} 台',
    localAddressesLabel: '本机地址（给设备用）',
    noLocalAddresses: '本机没有可用于设备的地址（只有回环地址）。',
    statusGroup: '运行状态',
    listening: '监听中 {address}:{port}',
    notListening: '未监听',
    statusOff: '已关闭',
    statsRequests: 'HTTP 请求',
    statsMessages: 'MQTT 报文',
    statsRejectedAuth: '凭据被拒',
    statsRejectedPayload: '载荷被拒',
    statsTrendRows: '写入趋势行',
    statsAlarmRows: '写入告警行',
    statsLastAt: '最近收到',
    statsNever: '尚未收到任何数据',
    lastUnrecognised: '最近一次认不出来的键：{keys}',
    portConflict: 'HTTP 与 MQTT 用了同一个端口（{port}），后启动的那个会失败。',
    devicesTitle: '推流地址与秘钥',
    devicesHint: '把下面的地址填进设备的推流配置。秘钥只允许往本机写遥测，不能读任何数据。',
    copy: '复制',
    copied: '已复制',
    rotate: '轮换秘钥',
    rotateTitle: '轮换推流秘钥？',
    rotateBody: '旧秘钥会立刻失效；设备必须用新秘钥重新配置后才会继续推数据。',
    rotateConfirm: '轮换',
    rotateNotice: '秘钥已轮换，请把新秘钥填到设备上。',
    serviceOff: '本机此刻没有在监听（第 13 批之后由**设备声明**决定）：把地址填进设备、添加成功之后，本机会按这台设备的接入方式自动打开端口。',
    // `httpOff` / `mqttOff` 两句在 2026-09-19 第 13 批里删掉了：那两个通道开关现在是
    // **派生**的（有没有设备声明 http / mqtt），而"按开关把地址藏起来"会让操作员在
    // 设备声明之前拿不到该填进设备的地址。监听状态由上面那句 `serviceOff` 统一回答。
    mqttUser: 'MQTT 用户名（就是秘钥）',
    secretHint: '秘钥按设备一条，可随时轮换；轮换后旧秘钥立刻失效。',
    loadFailed: '读取数据接入状态失败',
  },

  installUi: {
    section: '地址信息（可选）',
    sectionHint: '声源定位设备（SN-16 空气声呐）填这几项；其他机型留空。经纬度用 WGS84 十进制度。',
    latitude: '纬度（°）',
    longitude: '经度（°）',
    azimuth: '方位角（°）',
    azimuthHint: '0 = 正北，顺时针',
    gisLabel: '地图',
    viewOnMap: '在地图信息里查看',
    copyPoint: '复制坐标',
    pointCopied: '已复制坐标',
    errLatitude: '纬度需在 -90 到 90 之间',
    errLongitude: '经度需在 -180 到 180 之间',
    errAzimuth: '方位角需在 0 到 360 之间（360 请写 0）',
    /*
     * 基准声压级**界面已经不显示**（业主 2026-09-18 第 10 条），但这条错误文案留着：
     * `parseInstallation()` 仍然解析并把 `soundLevelDb` 写进库（v11 的列还在，API 也还在，
     * 程序化调用与探针仍在用它），所以越界时仍然要给出一句话 —— 删掉它就等于把一个
     * 可达的失败路径变成裸 key。理由与取舍见 `docs/Ivms4200-UX-REFERENCE.md` §15.49。
     */
    errSoundLevel: '基准声压级需在 -50 到 200 dB 之间',
    /** 设备表/详情页里那一格的标题。 */
    point: '点位',
    noPoint: '未录入',
    /** 某一项没有录：与"录了 0"必须分开写（纬度 0 是一个真实坐标）。 */
    unset: '未录入',
    /** 经纬度只录了一半：半坐标的点位算不出方向，界面要能说出来。 */
    halfPoint: '只录了一半（经纬度要成对）'
  },

  /**
   * SN-16 空气声呐的**球机联动（PTZ）**配置（业主 2026-09-17 第 8 批）。
   *
   * 三处措辞是刻意的：
   *   - 叫「球机」而不是"摄像机/云台"：那是业主现场的叫法；
   *   - 口令那一格只说「已设置 / 未设置」，**永远不回显内容**；
   *   - 对时那句明说这是设备接受了请求 —— 手册**没有写这个端点的请求体**，我们不假装知道
   *     它做了什么（主进程发的是一个空对象，这件事写在这一句的旁边）。
   */
  ptzUi: {
    title: '球机联动（PTZ）',
    hint: '这一代声呐与球机联动做声源定位。下面这些都是设备上的参数，点「保存」才会写进设备。',
    fieldEnabled: '启用球机联动',
    enabledHint: '关掉之后声呐不再驱动球机',
    fieldCameraIp: '球机 IP / 主机名',
    fieldCameraPort: '球机端口',
    fieldCameraUser: '球机账号',
    fieldCameraPassword: '球机口令',
    passwordSet: '已设置',
    passwordUnset: '未设置',
    passwordHint: '不回显内容；留空表示不改',
    passwordState: '口令状态',
    fieldDirection: '球机方向与声呐一致',
    directionHint: '关掉表示球机与声呐朝向相反',
    fieldSaveSnapshot: '告警时保存抓图',
    saveSnapshotHint: '关掉之后告警没有抓图可看',
    fieldChannel: '实时监听通道',
    channelHint: '1 – {max}（设备报的通道数）',
    channelHintUnknown: '设备未上报通道数，这里不设上限',
    cameraInitialised: '球机已初始化',
    unknown: '未读取',
    yes: '是',
    no: '否',
    save: '保存到设备',
    syncing: '对时中…',
    syncTime: '与球机对时',
    unsaved: '有未保存的修改',
    nothingChanged: '没有需要保存的修改',
    saved: '已写入设备，并读回核对过',
    savedPartly: '已写入设备，但有 {count} 项读回不一致（见下）',
    readBackTitle: '读回核对',
    allApplied: '全部生效',
    someFailed: '有未生效的项',
    applied: '生效',
    expectedActual: '未生效：应为 {expected}，设备现为 {actual}',
    passwordNotCompared: '口令只核对"已设置"：内容不回传，无法比对。',
    timeSyncAccepted: '设备接受了这次对时请求（手册未说明请求体，发的是一个空对象）。',
    timeSyncRejected: '设备没有接受这次对时请求。',
    errCameraIp: '球机地址需为 IPv4 或主机名',
    errCameraPort: '球机端口需在 1 到 65535 之间',
    errCameraUser: '球机账号不能为空',
    errRealtimeChannel: '实时通道需在设备通道数范围内'
  },

  /**
   * 离线**点位图**（业主 2026-09-17 第 8 批第 2 条）。
   *
   * 措辞上刻意不含"地图"两字以外的东西：底图是我们按经纬度画的平面图（渲染层不联网），
   * 所以不能写"地图加载失败/正在加载地图"这类会被读成"网络问题"的话。
   * 抓图那三句是**三种不同的事实**，不能合并（见 `E2AlarmSnapshotView` 的注释）。
   */
  mapUi: {
    canvasLabel: '设备落点图',
    /**
     * 地图右上角那条半透明状态栏（业主 2026-09-19 第 11 批第 4 条：删除「图上 N 台 / 共 M 台」、
     * 图例上的三个计数、以及「还没有任何设备录入点位…」那句，改说「直接显示 GIS 地图的信息，
     * 在地图右上角的位置做一个半透明的状态栏，显示当前地图上的设备数量信息，告警信息」）。
     *
     * 五个数各有各的措辞，不合成一句话：状态栏是**读数**，不是句子（挤在一行里时更读得出来）。
     */
    statusLabel: '地图状态',
    statusMapped: '图上 {count} 台',
    statusTotal: '共 {count} 台',
    statusOnline: '在线 {count}',
    statusOffline: '离线 {count}',
    statusAlarms: '未确认告警 {count}',
    selectHint: '点一个标记查看这台设备：位置、告警与抓图。',
    pickOne: '还没有选中设备。',
    point: '点位',
    /**
     * 落点的三种色调（业主 2026-09-18 第 10 批第 14 条：在线绿 / 告警红 / 离线灰）。
     * 「在线」「离线」两档直接复用 `devices.status.*`（同一件事只有一处措辞），
     * 这里只补"有告警"那一档。颜色不单独承载信息，所以图例上各带一个数。
     */
    legendAlarm: '有未确认告警',
    /** 设备列表（第 17 条的第一张）。 */
    devicesTitle: '设备列表',
    devicesCount: '{count} 台',
    /**
     * 列表只有三列（业主 2026-09-19 第 11 批第 5 条：「设备列表只需要显示序号，设备名称，状态这三项」），
     * 而且「点击设备名称可以进入到设备详情」—— 双击仍然进详情（地图上的标记一直是这么做的）。
     */
    devicesHint: '点一行选中它（地图上的标记同时高亮）；点设备名称进这一台的详情页。',
    /**
     * 翻页（同一条第 5 条：设备列表默认最多 10 台，超过就翻页）。
     * `pageStatus` 只写"第几页/共几页"：一页几台是 `DEVICE_MAP_PAGE_SIZE` 那个常量的事。
     */
    pagePrev: '上一页',
    pageNext: '下一页',
    pageStatus: '第 {page} / {pages} 页',
    colAlarms: '未确认告警',
    /** 告警列表（第二张）。 */
    alarmsTitle: '告警列表',
    alarmsFor: '选中设备：{name}',
    /** 实时数据列表（第三张）。 */
    liveTitle: '实时数据列表',
    colDb: '分贝',
    colStability: '平稳度',
    colAzimuth: '方位',
    /**
     * 三列各取自哪里（业主 2026-09-19 澄清「用平稳度表示」之后写的）。
     *
     * 那句澄清解掉了原先的歧义：他说的「稳定度」就是本仓库的 `smoothness`
     * （告警上报的一个真实测量值，`AlarmEvent.smoothness`）。所以这一列**有数据源**了 ——
     * 原来那句"手册未说明、所以这一列恒为 —"的说明随之下架。
     */
    liveHint: '分贝与平稳度都取该设备最近一条告警上报的声压级与平稳度，没有告警时是「—」；方位取录入的方位角（不是当前帧的声源方位）。',
    hoverStream: '当前视频流',
    hoverAlarm: '{count} 条未确认告警',
    hoverNoAlarm: '没有未确认告警',
    hoverHint: '双击进这一台的详情页。',
    /** 一个读数「没读到」与「就是没有」必须分得开（与设备表那边同一条口径）。 */
    notRead: '—',
    none: '—',
    alarmCount: '最近 {count} 条',
    noAlarms: '本地还没有这台设备的告警。上面点「同步告警」拉一次。',
    sync: '同步告警',
    syncing: '同步中…',
    syncOutcome: '检查 {created} 条新增、{existing} 条已在库；抓图落库 {linked} 条；设备上文件已不在 {missing} 条。',
    hasSnapshot: '有抓图',
    noSnapshot: '无抓图',
    snapshotTitle: '抓图',
    snapshotCount: '{count} 张',
    snapshotLoading: '读取抓图中…',
    snapshotNotCaptured: '这条告警在设备上没有抓图（同步时没下载，或球机未开启「告警时保存抓图」）。',
    snapshotFilesGone: '库里记着这条告警有抓图，但文件已经不在本地了（换过存储目录，或被清理）。',
    sonarHint: '空气声呐的抓图来自联动的球机：每 1 秒一张，最多 3 张。'
  },

  /**
   * 本地异常声纹样本库（schema v7，业主 2026-09-16）。
   *
   * 「标签来源」三档的措辞刻意不同权重：人工是真值、设备是弱标签、AI 是待确认的候选。
   * 三条文案如果读起来一样可信，界面就在暗示它们可信度相同。
   */
  samplesUi: {
    statTotal: "样本总数",
    statTrainable: "可参与训练",
    statFaultHuman: "故障：人工",
    statEquipmentHuman: "设备：人工",
    statFaultDevice: "故障：设备判定",
    statFaultAi: "故障：AI 建议",
    statEquipmentUnlabelled: "设备类型未标",
    filterSource: "样本来源",
    filterLabelSource: "故障标签来源",
    filterEquipmentLabel: "设备类型",
    filterFaultLabel: "故障类型",
    filterAll: "全部",
    source_alarm: "告警",
    source_manual: "手动录音",
    source_import: "导入",
    labelSource_human: "人工标注",
    labelSource_device: "设备判定",
    labelSource_ai: "AI 建议",
    dimension_equipment: "设备类型",
    dimension_fault: "故障类型",
    labelsTitle: "标签库",
    labelsHint: "打标签时可以直接选这里的写法，也可以直接打一个新的（自动入库）",
    labelsEmpty: "还没有标签，先在下面加一个",
    labelUsedBy: "{count} 条样本在用",
    labelRename: "改名",
    labelAdd: "添加",
    labelNewPlaceholder: "新增标签名",
    labelAdded: "已添加「{name}」",
    labelExists: "「{name}」已经在标签库里了",
    labelRenamed: "已改名为「{name}」，同时更新了 {count} 条样本",
    labelRenameFailed: "改名失败：这一维里已经有同名的标签",
    labelRemoved: "已删除「{name}」",
    labelRemoveFailed: "删除失败",
    labelInUse: "「{name}」还有 {count} 条样本在用，不能删除",
    trainButton: "训练并评估",
    trainingTitle: "训练结果（留一法）",
    trainingSamples: "参与训练",
    trainingAccuracy: "留一法准确率",
    trainingExcluded: "被排除",
    trainingExcludedValue: "无故障类型 {noLabel} 条 · 缺特征 {missingMetrics} 条",
    trainingEquipment: "训练集的设备类型",
    trainingEquipmentValue: "{kinds} 种 · 未标注 {unassigned} 条",
    trainingDegenerate: "只有一个类别，准确率恒为 100%，这个数字没有信息量。",
    trainingUnassessable: "每类样本不足 2 条的类别无法用留一法评估：{labels}。它们的准确率不参与上面的数字。",
    trainingMixedEquipment: "训练集里不止一种设备类型：同一个故障类别在不同设备上可能不是同一种现象，准确率会偏低。",
    trainingTruncated: "样本数超过训练上限，本次只用了前一部分。",
    trainingConfusion: "混淆矩阵（只列非零项）",
    trainingConfusionRow: "标注为 {expected} → 判为 {predicted}：{count} 条",
    columnTime: "时间",
    columnDevice: "设备",
    columnChannel: "通道",
    columnSource: "来源",
    columnEquipment: "设备类型",
    columnFault: "故障类型",
    columnMetrics: "特征",
    columnActions: "操作",
    loading: "正在加载…",
    empty: "样本库还是空的。可以在「告警中心」或「录音文件」里把一条记录加入样本库。",
    unlabelled: "未标注",
    metricsCount: "{count} 维",
    metricsHint: "设备报过的特征维度；缺的维度不会补 0",
    blockedNoLabel: "没有故障类型，不能训练",
    blockedMissingMetrics: "缺特征：{metrics}",
    editLabel: "改标签",
    clearEquipment: "撤销设备类型",
    clearFault: "撤销故障类型",
    labelSaved: "标签已保存",
    labelCleared: "标注已撤销",
    removed: "样本已删除",
    exportTitle: "导出数据集",
    exportOnlyLabelled: "只导出已标注的样本",
    exportCopyAudio: "同时复制音频文件",
    exportButton: "导出数据集…",
    exporting: "正在导出…",
    exportDone: "已导出 {samples} 条（其中已标注 {labelled} 条）到：",
    exportSkipped: "另有 {count} 条未标注被跳过。",
    exportAudio: "已复制音频 {copied} 个（{bytes}）。",
    exportAudioSkipped: "未复制音频：清单里的路径指向本机存储目录，换机器用要勾上「同时复制音频文件」。",
    exportAudioMissing: "有 {count} 条音频文件不在存储目录里，清单中已标记 audio_missing。",
    exportFiles: "目录内含 samples.jsonl、samples.csv、dataset-info.json。",
    aiTitle: "AI 标注（可选）",
    aiReady: "已配置",
    aiUnknown: "未读取到配置",
    aiBlockedDisabled: "未启用",
    aiBlockedNoEndpoint: "未填接口地址",
    aiBlockedBadEndpoint: "接口地址不合法（需以 http:// 或 https:// 开头）",
    aiBlockedNoModel: "未填模型名",
    aiEnabled: "启用 AI 标注",
    aiEndpoint: "接口地址",
    aiEndpointPlaceholder: "https://主机/v1/chat/completions",
    aiModel: "模型",
    aiModelPlaceholder: "模型名",
    aiApiKey: "API 密钥",
    aiKeyStored: "已保存",
    aiKeyAbsent: "未保存",
    aiApiKeyPlaceholder: "留空表示不改动已保存的密钥",
    aiNoEncryption: "系统加密不可用，密钥无法保存（只保存地址与模型名）。",
    aiSave: "保存配置",
    aiSaved: "配置已保存",
    aiClearKey: "清除密钥",
    aiIncludeWeak: "包含带设备弱标签的样本",
    aiRun: "让 AI 标注",
    aiRunning: "正在标注…",
    aiCandidateNote: "AI 给出的是候选标签：不会覆盖人工标注，也不会进入训练集，需要人工确认后改标为人工。",
    aiOverwriteWarning: "已勾选覆盖设备弱标签：设备位图给出的判定会被 AI 的猜测替换掉，无法从这条样本恢复。",
    aiOutcome: "检查 {considered} 条，向模型提问 {requested} 条，写入候选标签 {labelled} 条。",
    aiOutcomeBreakdown: "人工标注跳过 {human} 条 · 设备弱标签跳过 {weak} 条 · AI 判不了 {unresolved} 条 · 失败 {failed} 条",
    pagerRange: "本页 {shown} 条 / 共 {total} 条"
  },
  /**
   * 听诊盒子族（E2 / FA100 / FA110）的「拉」通道（业主 2026-09-16）。
   *
   * 参数名（`db_limit`、`hpss_limit`…）用**设备自己的键名**做后缀：手册就是这些名字，
   * 换一个中文说法会让"界面上的词"与"手册里的词"对不上，而排查时要对着手册看。
   * 认不出的键在组件里**直接显示原键名**（`paramLabel()`），所以这里不必穷举。
   */
  e2Ui: {
    statusTitle: '设备状态',
    variant: '协议代次',
    variant_auscultation: '听诊盒子（2023 版协议）',
    /*
     * 业主 2026-09-17 澄清：这一代是他们的一款 **SN-16 空气声呐**，用途是**声源定位**
     * （不是"再一款听诊盒子"）。所以标签按产品名写，而不是按手册的文件名（Air Sonar）写。
     * 内部变体键仍是 `airSonar`（它出现在 IPC 与落库数据里，改键只会让旧数据对不上）。
     */
    variant_airSonar: 'SN-16 空气声呐（V3.2 协议）',
    variantUnknown: '认不出这一代（设备回话里没有可判定的字段）',
    mode: '工作模式',
    modeNotApplicable: '这一代没有工作模式',
    modeUnknown: '设备未上报工作模式',
    mode_burst_of_loud_sound: '突发大声音监测',
    mode_rotating_equipment: '旋转类设备监测',
    mode_electrical_power_equipment: '电力设备状态监测',
    samplerate: '采样率',
    channelCount: '通道数',
    spectrogramSize: '时频谱图尺寸',
    deviceType: '设备型号',
    firmware: '固件版本',
    retention: '告警记录上限',
    retentionValue: '设备只保留最近 {count} 条',
    paramsError: '设备状态没读全：{reason}',
    paramsEmpty: '设备没有返回任何参数。',
    paramColumn: '参数',
    valueColumn: '当前值',
    paramExtra: '设备多给的键',
    paramValueHidden: '已设置（不显示）',
    param_db_limit: '分贝阈值 db_limit',
    param_tde_ratio_limit: '时域能量比阈值 tde_ratio_limit',
    param_fde_ratio_limit: '频带能量比阈值 fde_ratio_limit',
    param_freq_down_limit: '频带下限 freq_down_limit',
    param_freq_up_limit: '频带上限 freq_up_limit',
    param_hpss_limit: '谐波冲击成分阈值 hpss_limit',
    param_main_freq_limit: '主频阈值 main_freq_limit',
    param_sc_ratio_limit: '频谱复杂度阈值 sc_ratio_limit',
    param_sc_ratio_threshold: '频谱复杂度判据 sc_ratio_threshold',
    param_samplerate: '采样率 samplerate',
    param_notify_url: '告警回调地址 notify_url',
    param_is_send_alarm: '推送告警 is_send_alarm',
    param_is_send_fft: '推送实时分析 is_send_fft',
    param_cam_enable: '启用 PTZ 相机 cam_enable',
    param_cam_ip: '相机地址 cam_ip',
    param_cam_port: '相机端口 cam_port',
    param_cam_user: '相机账号 cam_user',
    param_cam_pass: '相机口令 cam_pass',
    param_cur_realtime_channel: '实时监听通道 cur_realtime_channel',
    param_is_cam_init: '相机已初始化 is_cam_init',
    param_is_ptz_direction_same_with_sonar: '相机方向与声学一致 is_ptz_direction_same_with_sonar',
    param_is_save_snapshot: '告警抓图 is_save_snapshot',
    param_is_send_realtime_value: '推送实时计算值 is_send_realtime_value',
    syncTitle: '告警同步',
    syncHint: '把设备上的告警日志与录音拉到本机（设备只保留最近 {count} 条）。重复同步不会重复入库。',
    syncSpectrograms: '同时下载时频谱图',
    syncSnapshots: '同时下载 PTZ 抓图',
    syncButton: '同步告警',
    syncing: '正在同步…',
    outcomeAlarms: '检查 {seen} 条日志：新增 {created} 条，已在库 {existing} 条。',
    outcomeAudio: '录音：新下载 {saved} 个，本地已有 {existing} 个，失败 {failed} 个。',
    outcomeFilesMissing: '其中 {count} 条的文件已被设备清掉（files_status = 0），只登记了告警。',
    outcomeSpectrograms: '时频谱图：存下 {saved} 张，设备上没有 {failed} 张（重启后不足 10 张是正常的）。',
    outcomeSnapshots: 'PTZ 抓图：存下 {saved} 张，设备上没有 {failed} 张（相机没配对或未开启抓图时会是 0）。',
    outcomeBadTime: '{count} 条的时间无法解析，已跳过（没有猜它们的时刻）。',
    outcomeHint: '同步于 {time}'
  },
  playerUi: {
    missingTitle: '该记录没有本地录音文件',
    missingBody: '告警本身只保存指标与告警类型，录音文件需要从设备同步。请先在「录音文件」页面点击「同步设备录音」，把设备上的录音元数据与文件导入本地，然后回到这里播放。',
    errMissingFile: '该记录没有本地录音文件，无法播放',
    errNoData: '主进程没有返回音频数据',
    errDecode: '音频数据解码失败：{detail}',
    loading: '正在加载录音…',
    reload: '重新加载',
    play: '播放录音',
    release: '关闭播放',
    downloading: '正在从设备下载并解码音频，约 {size}，请稍候…',
    autoplayBlocked: '已加载完成，浏览器未自动播放，请点击下方播放按钮。',
    leadShort: '请求从告警前 {requested} 秒开始，但这段录音只有告警前 {actual} 秒的内容，已从录音开头播放。',
    fewMegabytes: '数 MB',
    channelCount: '声道数',
    channelCountValue: '{count} 声道',
    encoding: '编码',
    waveformTitle: '波形预览',
    waveformAria: '录音波形预览',
    waveformMissing: '本次播放数据未包含波形预览。',
    spectrumTitle: '频谱快照',
    spectrumMissing: '本次播放数据未包含频谱快照。'
  },

  labUi: {
    noticeDone: '诊断已完成，结果如下',
    errSelectDevice: '请先选择设备',
    errPathRequired: '请输入要探测的路径，例如 /get_devinfo',
    endpointNotProbed: '本次诊断未探测到该端点。',
    requestFailed: '请求失败：{detail}',
    httpNoResponse: '无响应',
    contentTypeMissing: '未声明 Content-Type',
    chunkedUnknown: '未确认分块传输',
    chunkedYes: '使用了分块传输',
    chunkedNo: '非分块传输',
    bytesUnknown: '未统计字节数',
    bytesReceived: '收到 {count} 字节',
    jsonFields: 'JSON 字段：{fields}',
    summarySeparator: '；',

    risk1Title: '风险 1：登录 Token 的携带方式',
    risk1Question: '文档只说明 /login 返回 Token，未说明后续请求如何携带。',
    risk1Confirmed: '已确认可用方式：{strategy}；登录响应中{tokenState} Token 字段。',
    risk1Pending: '尚未确认。请先运行诊断；若全部候选方式都失败，需要在设备端抓包核对。',
    risk2Title: '风险 2：/audio_stream 的帧格式',
    risk2Question: '音频流的封装方式、采样格式与分块策略均未文档化。',
    risk2Pending: '尚未确认。该端点未返回可用响应，不能假设其为 chunked PCM。',
    risk3Title: '风险 3：/freq_domain 与 /time_freq_domain 的数据结构',
    risk3Question: '两个频域端点的字段名与数组维度未知，直接解析会静默丢数据。',
    risk3Pending: '尚未确认。请分别探测两个端点并查看原始样本。',
    risk4Title: '风险 4：录音下载地址的拼装规则',
    risk4Question: '设备返回的录音路径无法直接拼成可下载 URL（是否带前缀、是否要再拼端口未知）。',
    risk4Pending: '尚未确认。请探测录音列表与下载端点，确认返回的路径形态后再实现下载。',
    risk5Title: '风险 5：端口 0 的语义',
    risk5Question: 'set_network 示例中出现端口 0，无法判断它表示“默认端口”还是“禁用该服务”。',
    risk5Pending: '必须实机验证：写入端口 0 后重新读取网络配置，观察设备实际监听端口是否变化。在得到结论前，本程序不会向设备写入 0 值端口。',

    introTitle: '这里做什么',
    chipAuth: 'Token 携带方式',
    chipAudioFraming: '/audio_stream 帧格式',
    chipFreqSchema: '频域端点数据结构',
    chipDownloadUrl: '录音下载 URL 规则',
    chipPortZero: '端口 0 语义',

    noDeviceTitle: '请先添加设备',
    goToDevices: '前往设备管理',
    targetTitle: '诊断目标',
    deviceLine: '设备 ID {uid} · {address}',
    noAddress: '无地址',
    deviceLabel: '设备',
    diagnosing: '诊断中…',
    runDiagnosis: '运行诊断',

    customTitle: '自定义端点探测',
    pathLabel: '路径',
    pathPlaceholder: '例如 /get_devinfo',
    methodLabel: '方法',
    probing: '探测中…',
    probe: '探测',
    ok: '成功',
    failed: '失败',
    httpStatus: 'HTTP 状态',
    elapsed: '耗时',
    chunked: '分块传输',
    yes: '是',
    no: '否',
    receivedBytes: '接收字节',
    error: '错误',

    reportTitle: '诊断报告',
    detectedAuth: '检测到的认证方式',
    unconfirmed: '未确认',
    loginTokenPresent: '登录是否返回 Token',
    tokenPresent: '存在',
    tokenAbsent: '未发现',
    loginResponseFields: '登录响应字段',

    endpointsTitle: '端点探测结果',
    endpointCount: '共 {count} 个端点',
    columnPath: '路径',
    columnMethod: '方法',
    columnResult: '结果',
    columnStatus: '状态码',
    columnElapsed: '耗时',
    columnChunked: '分块',
    columnBytes: '接收字节',
    columnError: '错误',
    noEndpointResults: '诊断未返回端点结果。',

    samplesTitle: '原始响应样本',
    unknownType: '未知类型',

    conclusionsTitle: '结论',
    confirmed: '已确认',
    pendingConfirmation: '待确认'
  },

  authUi: {
    username: "用户名",
    password: "密码",
    signIn: "登录",
    signingIn: "正在登录…",
    rememberPassword: "记住密码",
    rememberExpired: "记住的密码已超过 {days} 天，请重新输入。",
    rememberUnavailable: "这台电脑上的系统加密不可用，密码不会被记住（用户名仍会记住）。",
    signOut: "退出登录",
    signedInAs: "当前账户",
    mustChangeTitle: "请先修改出厂密码",
    changeTitle: "修改密码",
    currentPassword: "当前密码",
    newPassword: "新密码",
    confirmPassword: "确认新密码",
    changeSubmit: "保存新密码",
    changing: "正在保存…",
    changeSuccess: "密码已修改",
    recoverLink: "忘记密码？",
    recoverTitle: "用超级密码重置",
    installId: "安装标识",
    copy: "复制",
    copied: "已复制",
    superPassword: "超级密码",
    recoverSubmit: "重置密码",
    recovering: "正在重置…",
    recoverSuccess: "密码已重置，请用新密码登录",
    backToLogin: "返回登录",
    errUsername: "请输入用户名",
    errPassword: "请输入密码",
    errCurrentPassword: "请输入当前密码",
    errNewPassword: "请输入新密码",
    errPasswordMismatch: "两次输入的新密码不一致",
    errPasswordLength: "密码长度至少 {min} 位",
    errPasswordWhitespace: "密码首尾不能包含空格",
    errPasswordHasUsername: "密码不能包含用户名",
    errSuperPassword: "请输入超级密码"
  },

  usersUi: {
    title: "账户管理",
    addUser: "新增账户",
    username: "用户名",
    displayName: "显示名称",
    role: "角色",
    lastLogin: "最近登录",
    neverLoggedIn: "从未登录",
    pendingPasswordChange: "待修改密码",
    create: "创建",
    creating: "正在创建…",
    created: "账户已创建，对方首次登录时需要修改密码",
    resetPassword: "重置密码",
    resetTitle: "重置「{name}」的密码",
    resetSubmit: "确认重置",
    resetDone: "密码已重置",
    deleteUser: "删除账户",
    deleteConfirm: "确定删除账户「{name}」吗？该操作无法撤销。",
    cannotDeleteSelf: "不能删除当前登录的账户",
    empty: "除当前账户外还没有其他账户。"
  },

  /**
   * 账号管理页（手册 §17.1 Account Management，p177–178）。
   *
   * 与 `usersUi` 分开而不是并进它：`usersUi` 里的文案服务于那个**弹窗**
   * （`UsersDialog.vue`，从顶栏的账户菜单打开），而这一页是设置页里的一块。
   * 同一件事在两个位置上的说法本来就不同（弹窗里叫「关闭」，页面上不需要关闭），
   * 共用 key 会逼着其中一处说别扭的话。
   */
  accountUi: {
    title: '账号管理',
    adminOnly: '只有管理员可以管理账户',
    editUser: '编辑账户',
    saved: '账户已保存',
    deleted: '账户已删除',
    empty: '还没有任何账户。',
    permissions: '权限',
    permissionScopeCount: '{count} 项操作受此权限控制',
    permissionScopeNone: '本版本还没有对应的操作通道',
    createPermissionsHint: '按手册默认只勾选只读权限，写入类权限需要手工勾选',
    adminAllPermissions: '管理员账户默认拥有全部权限',
    copyFrom: '复制权限',
    copyFromPlaceholder: '从…复制权限',
    defaultPermission: '恢复该用户默认权限',
    permissionsCopied: '已复制「{name}」的权限，点击保存后生效',
    permissionsDefaulted: '已恢复默认权限，点击保存后生效',
    errCopySource: '请先选择要复制权限的账户',
    errUsernameForbidden: '用户名不能包含以下字符：{chars}',
    errUsernameTooLong: '用户名不能超过 {max} 个字符',
    errTooManyAccounts: '最多只能创建 {max} 个账户',
    builtInAdminUndeletable: '内置管理员不可删除，但可以修改它的密码',
    rules: '用户名不得包含 {chars}；密码不得少于 {min} 个字符；最多 {max} 个账户；内置管理员不可删除。'
  },

  /**
   * 告警声音库（手册 §17.2.7，p185）。
   */
  alarmSoundUi: {
    title: '告警声音',
    addCustom: '添加自定义声音',
    defaultColumn: '默认',
    typeColumn: '类型',
    fileColumn: '音频文件',
    predefined: '预定义',
    predefinedUndeletable: '预定义的声音类型不可删除',
    noFile: '未选择',
    pickFile: '选择文件',
    clearFile: '清除',
    preview: '试听',
    previewing: '正在试听：{name}',
    customDefaultName: '自定义声音 {count}',
    renameHint: '双击可以改名',
    deleted: '已删除该自定义声音，点击保存后生效',
    defaultSet: '已将「{name}」设为默认声音，点击保存后生效',
    defaultIs: '默认声音：{name}',
    filePicked: '已选择 {name}，点击保存后生效',
    onlyWav: '音频文件只能是 {ext} 格式',
    errOnlyWav: '音频文件只能是 {ext} 格式',
    errOnlyWavFor: '「{name}」选择的文件不是 {ext} 格式',
    errNoFile: '请先为该声音选择音频文件',
    errPreview: '无法播放该音频文件，请确认它是有效的 WAV 文件',
    errEmptyName: '声音名称不能为空',
    errPredefinedUndeletable: '预定义的声音类型不可删除',
    summary: '共 {total} 项（自定义 {custom} 项），已选择文件 {files} 项'
  },

  /**
   * 邮件设置（手册 §17.2.8 Email Settings，p186）。
   */
  emailUi: {
    title: '邮件设置',
    host: 'SMTP 服务器',
    port: '端口',
    portHint: '默认为 25；选择 SSL 时通常需要改成 465',
    security: '连接安全',
    securityNone: '无',
    securitySsl: 'SSL',
    securityStarttls: 'STARTTLS',
    authentication: '要求认证',
    username: '用户名',
    password: '密码',
    passwordState: '已保存的口令',
    clearPassword: '清除已保存的口令',
    passwordCleared: '已清除本机保存的 SMTP 口令',
    from: '发件人地址',
    receiversSection: '收件人',
    receiverN: '收件人 {n}',
    receiversHint: '最多 {max} 个收件人',
    templateSection: '邮件内容',
    sendTest: '发送测试邮件',
    testFailed: '发送测试邮件失败',
    saveSuccessWithPassword: '设置已保存，SMTP 口令已存入本机凭据库',
    errHost: '请填写 SMTP 服务器地址',
    errPort: '端口需为 1 到 65535 之间的整数',
    errUsername: '勾选「要求认证」后必须填写用户名',
    errFrom: '请填写发件人地址',
    errFromFormat: '发件人地址格式不正确',
    errRecipients: '请至少填写一个收件人地址',
    errTooManyRecipients: '最多只能填写 {max} 个收件人',
    errRecipientFormat: '收件人地址格式不正确：{value}'
  },

  channelState: {
    enabled: '已启用',
    disabled: '未启用',
    unknown: '状态未知',
    disabledHint: '该通道未启用，不参与实时监测',
    unknownHint: '尚未读取到该通道的启用状态，请刷新设备',
    liveActive: '正在接收数据',
    liveSilent: '未接收到数据',
    enabledSummary: '已启用 {enabled} / {total} 路'
  },

  domain: {
    sensorType: {
      microphone: '麦克风',
      conduction: '传导'
    },
    detectionMode: {
      characteristic: '特征检测',
      ai: 'AI 检测'
    },
    recordingType: {
      alarm: '告警录音',
      manual: '手动录音',
      scheduled: '定时录音'
    },
    streamKind: {
      features: '实时特征',
      audio: '实时音频',
      spectrum: '频谱',
      spectrogram: '时频图'
    },
    deviceKind: {
      acousticBox: '声纹设备',
      acousticCamera: '声学相机',
      auscultationBox: '听诊盒子 / SN-16 空气声呐'
    },
    /**
     * 事件与告警中心的枚举键。
     *
     * 与其它 `domain.*` 同一条规则：取值是**稳定标识**，界面按这些键翻译；
     * 领域层（`shared/domain/event-center.ts`）只产出标识，不产出文案。
     */
    eventSource: {
      deviceDetect: '相机检测日志',
      linkage: '本机告警联动',
      localAlarm: '声纹设备告警'
    },
    eventSeverity: {
      info: '提示',
      warning: '警告',
      critical: '严重',
      unknown: '等级未知'
    },
    eventKind: {
      deviceDetect: '完成一次检测',
      deviceDetectAlarm: '设备判定为告警的检测',
      linkageAlarm: '本机联动告警',
      localAlarm: '声纹设备告警'
    },
    detectFileKind: {
      power_spectrum_photo: '功率谱图片',
      power_spectrum_video: '功率谱视频',
      soundmap_photo: '声场图图片',
      soundmap_video: '声场图视频',
      voiceprint_photo: '声纹图片',
      voiceprint_video: '声纹视频',
      bin_mic_data: '麦克风二进制数据',
      wav_mic_data: '麦克风 WAV 音频'
    },
    eventDownloadStage: {
      starting: '准备下载',
      fetching: '正在从设备下载',
      verifying: '正在校验文件',
      registering: '正在登记录像',
      done: '下载完成',
      reused: '本机已有，直接复用',
      failed: '下载失败'
    },
    userRole: {
      admin: '管理员',
      operator: '普通用户'
    },
    /**
     * 账号权限目录（手册 §17.1 的权限复选框）。
     *
     * 取值是 `UserPermissionKey` 的稳定标识，界面按它逐项渲染复选框，
     * 所以「多了一项权限却没有译文」会渲染出一串裸 key。
     */
    permission: {
      manageAccounts: '账号管理',
      manageSystemSettings: '系统设置写入',
      manageDevices: '设备增删',
      configureDevices: '设备配置写入',
      controlCameras: '相机控制与维护',
      deleteRecordings: '删除录像',
      downloadDetectFiles: '下载检测记录',
      viewDevices: '查看设备',
      viewAlarms: '查看告警',
      viewRecordings: '查看录像',
      viewTrends: '查看趋势',
      viewEvents: '查看事件与告警中心'
    },
    /**
     * 每一项权限**管住哪些操作**（与 `PERMISSION_OPERATIONS` 一一对应）。
     *
     * 为什么界面上要显示它：一个复选框如果只写「设备配置写入」，用户无法判断它到底
     * 会不会让他改网络地址、改设备名、改串口。这一句就是那个答案，而它与主进程真正
     * 拦截的通道来自同一张表。
     */
    permissionScope: {
      manageAccounts: '账号管理页上的全部改动：新增、删除、改角色、改权限、改显示名称、重置口令',
      manageSystemSettings: '系统设置的保存、恢复默认值与告警声音文件选择',
      manageDevices: '新增/修改/删除设备、重启、恢复出厂、系统升级、固件上传与相机固件升级',
      configureDevices: '通道、采样率、告警配置、网络地址、时间、RS485、Modbus 与设备名称的写入',
      controlCameras: '实时视频开关、手动录像与抓图、相机告警模型、检测启停与成像参数',
      deleteRecordings: '删除录像（本版本还没有这条通道，见代码注释）',
      downloadDetectFiles: '把设备上的检测结果文件下载到本机',
      viewDevices: '设备列表、设备详情、设备信息与通道表',
      viewAlarms: '告警中心、联动引擎状态与待处理告警',
      viewRecordings: '录音/录像列表、回放数据与录像播放地址',
      viewTrends: '历史趋势查询、覆盖范围与统计',
      viewEvents: '事件与告警中心的查询与相机检测库'
    },
    /**
     * 六种预定义告警声音（手册 §17.2.7 第 5439 行的 six pre-defined alarm sound
     * type）。取值是 `AlarmSoundTypeKey`，自定义项不用这里的名字（它的名字是用户打的）。
     */
    alarmSound: {
      motionDetection: '移动侦测',
      videoLoss: '视频丢失',
      videoTampering: '视频遮挡',
      externalAlarm: '外部报警',
      lineCrossing: '越界侦测',
      intrusion: '区域入侵'
    }
  },

  /**
   * Camera live video (FA371 RTSP -> ffmpeg -> loopback <video>).
   *
   * NO MESSAGE HERE MAY CONTAIN `@`: it is vue-i18n's linked-message sigil, and a
   * message containing one fails to COMPILE at render time (`SyntaxError: 10`) —
   * which the catalogue tests catch, because they compile every message.
   */
  cameraLiveUi: {
    title: '相机实时视频',
    rtspAddressUnknown: '设备未上报视频地址',
    start: '开始视频',
    stop: '停止视频',
    retry: '重试',
    statusIdle: '视频未启动',
    statusStarting: '正在启动视频…',
    statusPlaying: '视频播放中',
    statusRtspDisabled: '相机 RTSP 未启用',
    statusFfmpegMissing: '内置 ffmpeg 不可用',
    statusError: '视频流失败',
    rtspDisabledHint: '相机的 RTSP 服务处于关闭状态（设备上报 rtsp_enabled=0）。请在相机 Web 界面的「高级设置 → RTSP」中启用后再试。',
    ffmpegMissingHint: '内置的 ffmpeg 转封装组件缺失或无法运行，请重新安装本软件；应用日志中记录了它查找过的路径。',
    errorHint: '视频流已中断，可以点击重试重新打开。',
    limitExceededHint:
      '本机同时直播的路数已达上限（可在「系统设置 → 实时视频」调整）。请先停止其他正在播放的画面，再点击「开始视频」。',
    pausePicture: '暂停画面',
    playPicture: '播放画面',
    lookSnapshot: '查看（抓图）',
    lookPlayback: '回放',
    volume: '音量',
    volumeMuted: '已静音',
    volumeValue: '音量 {percent}%',
    volumeNoPicture: '还没有画面时不能调音量',
    flipGroup: '画面翻转',
    flipHorizontal: '左右翻转',
    flipVertical: '上下翻转',
    flipQuarter: '旋转 90°',
    dataForwarded: '已转发 {count} 字节',
    modeRemux: '直接转封装（不重新编码）',
    modeTranscode: '重新编码（兼容模式）',
    attemptInfo: '第 {index} 个地址候选：{id}'
  },

  /**
   * Camera acoustic streams (FA371 manual §5.2) — the five WebSocket channels.
   *
   * Same rule as `cameraLiveUi`: NO MESSAGE HERE MAY CONTAIN `@` (the linked-message
   * sigil), and the catalogue tests compile every message to prove it.
   *
   * The wording matters more than usual here: every "no data" state must read as a
   * distinct, honest fact rather than as a quiet measurement.
   */
  cameraStreamUi: {
    stop: '停止接收',
    adminOnlyHint: '开启与停止相机数据流属于管理员操作。',
    noDevice: '请先选择一台相机。',
    sessionIdle: '数据流未启动',
    sessionRunning: '数据流接收中',
    sessionError: '数据流失败',
    handshake: '握手方式：{id}',
    framesCount: '{count} 帧',
    silentFor: '已静默 {seconds} 秒',
    phaseNotStarted: '未启动',
    phaseNoFrames: '尚无数据',
    phaseLive: '接收中',
    phaseStale: '数据已停止',
    phaseError: '通道错误',
    hintNotStarted: '该通道尚未启动。点击「开始接收」后才会建立连接。',
    hintNoFrames: '连接已建立，但还没有收到任何一帧。空面板代表没有数据，不代表环境安静。',
    hintStale: '曾经收到数据，但已超过 {seconds} 秒没有新帧，画面停留在最后一帧上，请勿当作实时值。',
    hintError: '该通道报错，具体原因见下方日志或应用日志。',
    layoutWarning: '当前帧长与该通道的解码假设不一致，显示的数据可能不可靠。',
    voiceprintTitle: '声纹图',
    voiceprintAlt: '相机推送的声纹图像',
    voiceprintJpegMeta: '设备推送的 JPEG 图像：{bytes}',
    voiceprintMatrixMeta: '幅度矩阵 {width}×{height}（源数据已抽稀 {decimation} 倍）',
    audioTitle: '实时音频',
    audioPlay: '开启声音',
    audioStop: '关闭声音',
    pcmMeta: '每帧 {samples} 个采样点 · {ms} 毫秒 · {rate} kHz',
    pcmCrest: '峰值因数 {crest}',
    fftTitle: '频谱',
    fftLineAxis: '谱线序号',
    fftAmplitudeAxis: '幅度（设备原始计数）',
    fftAxisFromDevice: '{lines} 条谱线；设备上报采样率后每线宽 {hz} Hz',
    fftAxisUnknown: '{lines} 条谱线；设备未上报采样率，因此横轴按谱线序号标注，频率刻度未知。',
    energyTitle: '能量点',
    energyValue: '能量',
    energyPixelX: '像素横坐标',
    energyPixelY: '像素纵坐标',
    energySwath: '扫描角',
    energyAzimuth: '方位角',
    energyNoTarget: '该帧不含目标点（当前没有定位到声源）。',
    detectTitle: '检测结果',
    detectMode: '检测模式'
  },

  /**
   * Camera NVR interactions — right-click menu, manual recording, snapshot.
   *
   * Same hard rule as `cameraLiveUi`: **NO MESSAGE HERE MAY CONTAIN `@`**
   * (vue-i18n's linked-message sigil compiles to a SyntaxError at render time,
   * and `tests/i18n.test.ts` compiles every message).
   *
   * The `reason*` messages are the point of this block: every disabled menu item
   * and disabled button must say WHY, using the same wording, because both the
   * menu and the buttons read them from one pure rule.
   */
  cameraNvrUi: {    menuTitle: '相机操作：{name}',
    menuCapture: '抓图 / 录像',
    menuStartRecording: '手动录像',
    menuStopRecording: '停止录像',
    menuSnapshot: '抓图',
    menuAlarmConfig: '告警配置…',
    /**
     * 「显示方式」子菜单（业主 2026-09-19 第 12 批把四颗视图按钮从控制条移到这里：
     * 「播放器窗口应该只有 告警 / 全屏 / 暂停 / 切换录像 / 音量 / 手动录像」）。
     * 四个子项的文字复用 `cameraWallUi.view*`，所以菜单与控制条从不说两种话。
     */
    menuDisplay: '显示方式',
    menuFullscreen: '全屏',
    menuExitFullscreen: '退出全屏',
    menuCopyRtsp: '复制 RTSP 地址',
    menuOpenExternal: '在外部播放器打开',
    menuShowOverlay: '显示叠加信息',
    menuHideOverlay: '隐藏叠加信息',
    /*
     * 三项新入口（模型 `camera-nvr.ts` 已经在引用这三个键，本轮补齐）。
     *
     * 「回放」必须说清回放的是**本机**录像：FA371 没有设备侧连续录像存储
     * （`rtsp-stream.ts` 明确不把码流写盘），能回放的只有操作员手动录下的片段
     * 与从设备下载下来的检测录像。写成「回放设备录像」就是一句假话。
     */
    menuPlayback: '回放本机录像',
    menuDownloadDetect: '下载检测记录',
    menuCloseTile: '关闭这一格',
    recordingStarted: '本机录像已开始：{path}',
    playbackTitle: '回放本机录像',
    playbackLoading: '正在读取本机录像…',
    playbackEmpty: '这台相机在本机还没有录像文件。',
    playbackLocalNote:
      '本机录像：下面列出的是这台电脑上已保存的录像文件（手动录像，以及从设备下载的检测录像）。FA371 没有设备侧的连续录像存储，这里回放的不是设备上的录像。',
    playbackUnavailable: '无法播放这段录像：没有取得可播放的本机地址。',
    downloadTitle: '下载检测记录',
    downloadLoading: '正在读取设备检测记录…',
    downloadEmpty: '设备没有返回任何检测记录。',
    downloadNoPaging:
      '设备接口不支持分页：本次一次性读取了设备上的全部检测记录（设备上报 {count} 条）。',
    downloadColumnTime: '检测时间',
    downloadColumnMode: '检测模式（原始值）',
    downloadColumnFiles: '结果文件',
    downloadReused: '本机已有这个文件，已直接登记为录像：{name}',
    downloadPlay: '回放这段录像',
    openExternalDone: '已在外部播放器中打开这一路的 RTSP 地址。',
    reasonIdle: '视频尚未启动：请先点击「开始视频」，画面出现后才能录像或抓图。',
    reasonStarting: '视频正在启动，还没有收到任何一帧；此时录像会写出空文件，抓图必然抓空。',
    reasonReady: '视频正在播放。',
    reasonRtspDisabled: '相机上报 rtsp_enabled=0，设备侧 RTSP 服务未启用，无法录像或抓图。',
    reasonFfmpegMissing: '内置 ffmpeg 不可用，无法从码流录像或抓图。',
    reasonError: '视频流失败，请先重新打开视频。',
    reasonLimitExceeded: '已达到同时直播上限，先停掉其他画面格里的直播才能操作这一路。',
    reasonNoAddress: '设备未上报 RTSP 地址，没有可复制的地址。',
    reasonNoSource: '当前没有可用的 RTSP 会话，外部播放器没有可打开的地址。',
    recordingBadge: '录制中 {time}',
    recordSaved: '录像已保存：时长 {duration}，大小 {size}，文件 {path}',
    recordWarning: '注意：{reason}',
    snapshotSaved: '抓图已保存：{path}',
    openFolder: '打开所在文件夹',
    copyDone: '已复制 RTSP 地址（含设备口令，请勿外传）。',
    copyMaskedDone: '已复制 RTSP 地址（口令已打码，播放器会要求输入设备账号与密码）。',
    copyFailed: '复制失败，请手动选中地址后复制。',
    overlayDevice: '设备：{name}',
    overlayStatus: '状态：{status}',
    overlayStream: '码流：{mode} · {address}',
    fullscreenFailed: '无法进入全屏，请检查窗口权限。'
  },

  /**
   * 相机告警配置对话框（手册 §5.1.22 – §5.1.29）。
   *
   * 同一规则：**不得出现 `@`**。
   *
   * 这里的文案要承担一件工程上的责任：手册有多处自相矛盾/缺失，界面必须把它
   * 说成「未验证」，而不是让操作员以为那些取值是设备确认过的。`unverified` 与
   * `ambiguity*` 就是做这件事的，不要为了好看而删。
   */
  cameraAlarmUi: {
    title: '相机告警配置',
    /** 实时监测页那张「告警」卡片（与相机控制并排）的说明与出口。 */
    entryHint: '告警策略与告警条件在设备侧生效，这里只读取与修改它们。',
    noAlarms: '本机还没有这台相机的告警记录。',
    goAlarmList: '查看告警中心',
    // `subtitle`（「设备 {name}：告警策略与告警条件（一条策略只关联一个条件）。」）
    // 已按产品要求删除：对话框里不再出现这句话，四种语言里的这一条也一并删掉，
    // 免得留一个没人渲染的死键。同一个约束仍然成立（策略只能绑一条条件），
    // 它以表单校验 `issueCondition` 的形式存在。
    tabStrategies: '告警策略',
    tabConditions: '告警条件',
    // `refresh`（「刷新」）是**文字**按钮时代的键，现在那个控件只有一个图标，
    // 所以它的可访问名改成下面这一条（图标按钮必须靠 aria-label + title 才有名字）。
    refreshIcon: '重新读取告警策略与告警条件',
    loading: '正在读取告警配置…',
    empty: '设备没有返回任何记录。',
    newStrategy: '新建策略',
    editStrategy: '编辑策略',
    newCondition: '新建条件',
    editCondition: '编辑条件',
    save: '保存',
    cancel: '取消',
    edit: '编辑',
    delete: '删除',
    confirmDelete: '确认删除「{name}」？此操作会立即下发到设备。',
    fieldName: '名称',
    fieldAlias: '别名',
    fieldCondition: '关联条件',
    fieldLevel: '告警等级',
    fieldInterval: '间隔时间',
    fieldTimes: '序号',
    fieldCycle: '检测周期（秒）',
    fieldSensitivity: '灵敏度',
    fieldDiagnosis: '诊断说明',
    fieldDbThreshold: 'dB 告警值',
    fieldDbOperator: 'dB 运算',
    fieldDbSwitch: '启用 dB 判据',
    fieldDfThreshold: '主频告警值',
    fieldDfOperator: '主频运算',
    fieldDfSwitch: '启用主频判据',
    fieldDfLogical: '主频逻辑',
    fieldNcFileId: '比对文件 ID',
    fieldNcThreshold: '相似度阈值',
    fieldNcSwitch: '启用频谱比对',
    fieldNcLogical: '比对逻辑',
    fieldNcOperator: '比对运算',
    fieldDischargeSwitch: '启用放电判据',
    fieldDischargeLogical: '放电逻辑',
    fieldDischargeType: '放电类型',
    fieldNotes: '备注',
    branchDecibel: '声压级（dB）',
    branchDominantFreq: '主频',
    branchComparison: '频谱比对',
    branchDischarge: '放电（仅写入）',
    operatorGt: '大于',
    operatorLt: '小于',
    operatorEq: '等于',
    operatorGe: '大于等于',
    operatorLe: '小于等于',
    logicalOr: '或',
    logicalAnd: '与',
    dischargeCorona: '电晕',
    dischargeSuspension: '悬浮',
    dischargeSurface: '沿面',
    dischargeDischarge: '放电',
    stateEnabled: '已启用',
    stateDisabled: '未启用',
    stateUnknown: '启用状态未知',
    conditionHint: '设备只回传条件名称与 id；完整条件需要展开下面一栏查看。',
    selectCondition: '请选择条件',
    noConditions: '设备还没有告警条件：请先新建一条条件，再创建策略。',
    diagnosisKeyLabel: '诊断说明键名',
    diagnosisKeyDiagosisn: 'diagosisn（POST 手册原文）',
    diagnosisKeyDiagnosis: 'diagnosis（PUT 手册原文）',
    diagnosisKeyBoth: '两个键都发（探测用）',
    conditionIdStyleLabel: '条件修改的目标标识',
    conditionIdStyleId: '发 id（沿用策略的先例）',
    conditionIdStyleAlarmConditionId: '发 alarm_condition_id（读取侧拼写）',
    conditionIdStyleNone: '不发标识（照字段表字面）',
    unverified: '未验证',
    ambiguityDiagnosisLabel: '诊断说明键名不一致',
    ambiguityDiagnosisNote: '新建策略的字段表写 diagosisn（手册要求原样发送），修改策略写 diagnosis。设备是否两个都认、是否只认一个，手册未说明，因此这里是一个可选候选。',
    ambiguityConditionIdLabel: '修改条件时无法指定目标',
    ambiguityConditionIdNote: '修改告警条件的请求字段表里根本没有 id 字段，无法从手册得知要改哪一条。默认沿用修改策略的先例发 id，另两种发法保留为候选。',
    ambiguityLevelLabel: '告警等级两套取值',
    ambiguityLevelNote: '读取侧字段表写 0~3，写入侧写 1~4。本软件不做静默偏移：界面上的 1~4 原样发出，读回来的值原样显示，因此读到一个 0 时它没有对应的等级名称。',
    ambiguitySwitchLabel: '没有启用/停用策略的接口',
    ambiguitySwitchNote: 'Switch 只出现在读取接口，开放接口里没有任何启用/停用策略的端点；而已启用的策略按手册不能被修改。因此这里只能显示启用状态，不能切换。',
    ambiguityDischargeLabel: '放电判据只在写入侧存在',
    ambiguityDischargeNote: '放电开关、逻辑与类型只出现在新增/修改条件的字段表里，读取接口不回传它们；放电类型枚举还缺了 3。写入后读不回来是手册如此，不是本软件漏读。',
    ambiguityUnitsLabel: '阈值单位与范围未说明',
    ambiguityUnitsNote: 'dB 告警值与主频告警值的单位、合法范围手册都没有写；频谱比对的相似度写 0~1。界面上这些数值一律不做换算。',
    ambiguityDeleteLabel: '删除请求的字段名缺失',
    ambiguityDeleteNote: '删除策略/条件的请求体只给了类型（id 数组），没有给字段名。客户端按候选形状发送，设备是否接受以实际返回为准。',
    ambiguityCreateIdLabel: '新建后拿不到新 id',
    ambiguityCreateIdNote: '新建策略只返回 ret/msg，手册没说如何回传新策略的 id。因此保存后本对话框会重新读取列表来认领新行。',
    issueName: '策略名必须为 1~20 个字符',
    issueCondition: '请选择该策略要绑定的告警条件（一条策略只能关联一个条件）',
    issueLevel: '告警等级在写入侧只接受 1~4（读取侧写 0~3，本软件不做偏移）',
    issueCycle: '检测周期必须为 1~30 秒',
    issueSensitivity: '灵敏度必须为 0~1',
    issueInterval: '间隔时间必须是不小于 0 的整数',
    issueTimes: '序号必须是不小于 0 的整数',
    issueConditionName: '条件名称不能为空（不超过 64 个字符）',
    issueNoBranch: '四个判据至少要打开一个，否则这条条件不会参与判定',
    issueSimilarity: '噪声相似度必须为 0~1',
    issueDischargeType: '放电类型只定义了 0/1/2/4（手册缺 3）',
    savedStrategy: '策略已下发，列表已刷新。',
    savedCondition: '条件已下发，列表已刷新。',
    deleted: '删除请求已下发，列表已刷新。',
    missingId: '该记录的 id 无法解析为整数，无法修改或删除（读取侧 id 可能是字符串，见规格 §8.3 C21）。',
    adminOnly: '新建、修改与删除告警配置需要管理员账户。'
  },

  /**
   * Channel wall — the Overview page's 1 / 4 / 16 pane channel view.
   *
   * Same rule as `cameraLiveUi` / `cameraStreamUi`: NO MESSAGE HERE MAY CONTAIN `@`
   * (vue-i18n's linked-message sigil — a message containing one fails to COMPILE at
   * render time, which the catalogue tests catch because they compile every message).
   *
   * The wording carries the honesty rules: a tile with no stream says "not monitored",
   * never a plausible measurement.
   */
  /**
   * 多路实时视频墙（监控页的分屏直播）。
   *
   * 与 `cameraLiveUi` / `channelWall` 同一条硬规则：**本块任何一条消息都不得
   * 包含 `@`**（vue-i18n 的 linked-message 记法，渲染时编译失败，
   * `tests/i18n.test.ts` 会编译每一条消息）。
   *
   * 这个区块的措辞是有内容的：每一种「没有画面」都必须说出**具体原因**，
   * 绝不允许一个永远转的加载圈，或者一块没有任何解释的黑矩形。
   */
  /**
   * 相机控制与维护面板（检测模式 / 检测启停 / 启用中的策略 / 维护）。
   *
   * 同一条硬规则：**本块任何一条消息都不得包含 `@`**（vue-i18n 的
   * linked-message 记法，渲染时编译失败；`tests/i18n.test.ts` 会编译每一条消息）。
   *
   * 措辞上的两条坚持：
   *   - `modeRejected` / `detectNotApplied` / `strategyRejected` / `appModeRejected`
   *     说的是**「设备应答成功但没有生效」** —— 本设备实测过 `ret:200` 却忽略写入，
   *     所以界面绝不能把成功码说成"已改好"；
   *   - `reason*` 三条是禁用控件 title 里的原因，不是说明文字：它们回答的是
   *     "这一项为什么点不了"，所以每条都必须给出**下一步**（去设备 Web 界面 / 设备不支持 / 先联网）。
   *
   * `appMode*` 那一组是**应用模式**（这台设备在做哪种应用：局部放电 / 气体泄漏 /
   * 机械异响），与上面 `mode*` 那一组（**检测模式**：单次检测 / 智能巡航）是两件
   * 完全不同的事，措辞上不要互相串用。`appModeSourceHint` 是按钮上的 title，
   * 只说一句事实：**该端点未见于设备手册** —— 不说"已支持"，因为它是实测接口。
   */
  cameraControlUi: {
    title: '相机控制',
    refresh: '刷新',
    modeTitle: '检测模式',
    modeSingle: '单次检测',
    modeCruise: '智能巡航',
    modeUnknownHint: '设备返回的取值手册没有定义：1 = 单次检测，-1 = 智能巡航。',
    modeRawValue: '设备返回 {value}',
    modeReadBack: '设备当前：{value}',
    modeApplied: '已生效',
    modeRejected: '设备应答成功但没有生效',
    appModeTitle: '应用模式',
    appModeCurrent: '设备当前',
    appModePartialDischarge: '局部放电',
    appModeGasLeak: '气体泄漏',
    appModeMechanical: '机械异响',
    appModeUnknownHint: '设备返回的取值不在实测过的三个之内（1 = 局部放电，2 = 气体泄漏，3 = 机械异响）。',
    appModeSourceHint: '端点未见于设备手册，切换只写应用模式一项。',
    appModeApplied: '已生效',
    appModeRejected: '设备应答成功但没有生效',
    /*
     * 「切换模式」的二次确认（产品负责人指定）。
     *
     * `appModeConfirmBody` 就是产品给的原话，一个字都没有改。**它不是一条经过验证的
     * 设备事实**：手册把"切换模式会不会打断检测"列为未说明，手册里唯一一处"删除全部
     * 历史数据"说的是**恢复出厂**，本项目实测到的只是"写 `run_mode` 会清掉启用策略的
     * 指针"（`docs/FA371-API-DELTA.md` §17）——`work_mode` 会不会清数据 **未验证**。
     * 详细的来路记在 `CameraControlPanel.vue` 里 `pendingWorkMode` 上面的注释。
     * 要改这句话，先改产品的要求，不要拿它反推设备行为。
     */
    appModeConfirmTitle: '切换应用模式',
    /**
     * 产品指定的原话，逐字照发。
     *
     * 不带 `{mode}` 占位符是**故意的**：要求的是一模一样的这一句，把目标模式插进去
     * 就等于改了这句话；「当前是什么、要切到哪个」由按钮自己的高亮状态表达（设备重读
     * 值仍然显示在 `appModeCurrent` 那一行）。四语言之间也不许各写一套自己的说法。
     */
    appModeConfirmBody: '切换模式会清空全部的存储数据，是否继续？',
    appModeConfirmAction: '继续切换',
    presetTitle: '应用场景',
    presetCurrentBand: '当前成像频带',
    presetCurrentTargets: '当前目标数量',
    presetCurrentThreshold: '当前成像阈值',
    presetNotRead: '未读到',
    presetPartialDischarge: '局部放电',
    presetGasLeak: '气体泄漏',
    presetMechanical: '机械异响',
    presetHintPartialDischarge: '局部放电：20–40 kHz',
    presetHintGasLeak: '气体泄漏：25–45 kHz',
    presetHintMechanical: '机械异响：2–50 kHz',
    presetCitationPartialDischarge: 'practical-guide.txt §4.1.2 · 20–40 kHz · Targets 1 · Sensitivity Low · Enhancement Off',
    presetCitationGasLeak: 'practical-guide.txt §4.2.2 · 25–45 kHz · Targets 1 · Sensitivity Low · Enhancement Off',
    presetCitationMechanical: 'practical-guide.txt §4.3.2 · 2–50 kHz · Targets 1 · Sensitivity Low · Enhancement Disabled',
    presetAlready: '已在此场景',
    presetRejectedBadge: '设备不接受',
    presetRejectedByDevice: '设备会拒绝这条频带：宽度 {width} kHz 超过设备的宽度上限 {limit} kHz（实测）',
    presetApply: '应用场景',
    presetApplied: '已生效',
    presetRejected: '设备应答成功但没有生效',
    presetReadBack: '设备当前频带：{band}',
    presetRestore: '还原',
    presetRestored: '已还原为切换前的设备值',
    presetRestoreRejected: '设备应答成功但没有还原',
    presetTargetsUnchanged: '目标数量始终为 1',
    detectTitle: '检测状态',
    detectRunning: '检测中',
    detectStopped: '未检测',
    detectRetentionHint: '设备只保留最近 50 条检测记录，更早的会被循环覆盖。',
    detectRecord: '记录号 {id}',
    detectStart: '开始检测',
    detectStop: '停止检测',
    detectStopHint: '单次检测会在策略周期结束时自行停止，那时不必再调停止接口。',
    detectApplied: '已生效',
    detectNotApplied: '设备状态没有按请求改变',
    strategyTitle: '告警策略',
    strategyPeriodHint: '策略周期在策略自身里配置，范围 1~30 秒。',
    strategyNoneEnabled: '没有启用任何策略',
    strategyEnabled: '已启用',
    strategyEnable: '启用',
    strategyDisable: '停用',
    strategyNoItems: '设备上还没有告警策略',
    strategyIdUnusable: '该策略 id 不是整数，无法启停',
    strategyNeedsOne: '开始检测前需要先启用一条告警策略',
    strategyDisabledPrevious: '设备只允许一条策略启用，已先停用策略 {previous}',
    strategyApplied: '已生效',
    strategyRejected: '设备应答成功但没有生效',
    maintenanceTitle: '维护',
    firmwareVersion: '固件版本',
    sdkVersion: 'SDK 版本',
    webVersion: 'Web 界面版本',
    lastUpgrade: '上次升级',
    valueUnavailable: '未读到',
    valueUnavailableHint: '设备本次读取没有返回这一项。',
    openWebUi: '打开相机 Web 界面',
    webUiOpened: '已在系统浏览器中打开',
    // `upgrade` 与 `reboot` 两个标签在升级实装那一轮删掉了：它们属于**禁用的**
    // 维护按钮，而那两个动作现在有了真控件，文案在 `cameraUpgradeUi.*` 里。
    // 留着一份没人用的"固件升级/重启设备"，只会让下一个人猜该用哪一个。
    rollback: '版本回滚',
    factoryReset: '恢复出厂',
    reasonNotInOpenInterface: '设备开放接口没有这个操作',
    reasonDeviceOffline: '设备离线',
    adminOnlyHint: '切换模式、启停检测、启停策略需要管理员'
  },

  /**
   * 相机固件升级（设备自带 Web 界面用的那条 HTTP 路：`POST /upload` +
   * `PUT /reboot` + `GET /progress`）。
   *
   * 这一组只出现在相机控制面板的维护区。三段文案是本项目**刻意保留**的说明性文字：
   *   - `uploadConfirmBody` / `rebootConfirmBody`：破坏性动作的**后果**（会发生什么、
   *     什么时候开始升级、期间不能做什么）。确认对话框的正文是唯一允许解释的地方；
   *   - `sourceHint`：一句话说明这些接口的来路（未见于设备手册），放在控件的 title 上；
   *   - `nameRejectedDetail`：设备文件名规则的原文 —— 设备就是用它拒收的。
   * 其余一律短句，不写教程。
   */
  cameraUpgradeUi: {
    title: '固件升级',
    sourceHint: '升级与重启走的是设备自带 Web 界面用的接口（未见于设备手册）。',
    pick: '选择升级包',
    repick: '换一个包',
    packageFile: '升级包',
    packageSize: '大小',
    packageSha256: 'SHA-256',
    packageSuffix: '文件名后缀',
    sha256Hint: '请与厂家发布该版本时给出的校验值核对，再决定是否上传。',
    nameAccepted: '文件名符合设备要求',
    nameRejected: '文件名不符合设备要求，设备会拒收这个包',
    nameRejectedDetail: '设备要求：按 "_" 切开的最后一段必须是 V 加三段数字，例如 _v2.0.11（当前是 {suffix}）。',
    upload: '上传升级包',
    uploading: '正在上传 {percent}%',
    uploadConfirmTitle: '上传升级包到设备',
    uploadConfirmBody: '包会被写入设备（{size}）。上传期间不要断电、不要断网。上传完成后设备不会自动重启，什么时候开始升级由你另外决定。',
    uploadConfirm: '开始上传',
    uploaded: '升级包已上传，设备尚未升级',
    uploadedHint: '需要重启设备才会开始升级：请再点「重启设备」。',
    uploadDoneAt: '上传用时 {duration}',
    deviceProgressTitle: '设备升级进度',
    deviceProgressRead: '读取设备进度',
    deviceProgressValue: '设备返回 {value}',
    deviceProgressUnknown: '该数值的含义设备没有文档说明，因此这里不做换算。',
    deviceProgressNotRead: '未读到',
    reboot: '重启设备',
    rebootConfirmTitle: '重启设备',
    rebootConfirmBody: '设备会立即重启：正在进行的检测会中断，连接会短暂断开。若升级包已上传，重启之后设备才开始升级，升级期间同样不要断电、不要断网。',
    rebootConfirm: '重启',
    rebooting: '正在重启…',
    rebootAcknowledged: '重启指令已发出，设备已回执',
    rebootDropped: '重启指令已发出，设备未回执（重启时连接断开是正常现象）'
  },

  cameraWallUi: {
    title: '实时视频墙',
    layoutGroup: '分屏档位',
    layoutLabel: '{count} 分屏',
    pickDevice: '选择相机',
    // 浮层里一台可选的相机都没有时的那一行（其它格已经把它们都占了）。
    viewPlay: '播放',
    viewTimedomain: '1 秒时域图',
    viewSpectrum: '频域图',
    viewSpectrogram: '时频谱图',
    viewWaiting: '等待数据…',
    viewNeedsCamera: '第三方 RTSP 源只有画面',
    viewSpectrogramNote: '颜色只表示同一帧内谱线的相对强弱',
    viewStreamError: '声学数据这一路打不开',
    manualTitle: '第三方相机（手填 RTSP）',
    manualNote: '手册未说明第三方 RTSP 接入：地址按原样交给内置 ffmpeg，本机只判形状、不判能不能连上（连不上时画面格会显示 ffmpeg 的原文）。地址只在本次运行内有效 —— 它常带口令，不写盘。',
    manualWhere: '放进画面格在总览页的视频墙里：点一格，在列表里选它。',
    manualName: '名称',
    manualNameHint: '留空就用地址里的主机名',
    manualUrl: 'RTSP 地址',
    manualUrlPlaceholder: 'rtsp://192.168.1.64:554/Streaming/Channels/101',
    manualSave: '添加',
    manualUpdate: '保存修改',
    manualList: '已添加的手填源',
    manualEmpty: '还没有手填的地址。',
    manualEdit: '编辑',
    manualDelete: '删除',
    manualAtCapacity: '最多 {max} 条手填源。',
    manualSuffix: '手填 RTSP',
    manualMissing: '这条手填 RTSP 源已经不在列表里了',
    manualIssueEmpty: '请填写 RTSP 地址',
    manualIssueScheme: '地址必须以 rtsp:// 或 rtsps:// 开头',
    manualIssueHost: '地址里没有主机名',
    manualIssueWhitespace: '地址里不能有空格',
    manualIssueControl: '地址里不能有换行或控制字符',
    manualIssuePort: '端口需在 1-65535 之间',
    manualIssueTooLong: '地址太长',
    pickNoOption: '没有可选的相机',
    replaceDevice: '更换相机',
    noCamera: '还没有添加声学相机',
    assignToCell: '放入这一格',
    statusIdle: '未开始',
    statusStarting: '正在启动…',
    statusPlaying: '播放中',
    statusRtspDisabled: 'RTSP 未启用',
    statusFfmpegMissing: '找不到 ffmpeg',
    statusError: '流错误',
    statusLimitExceeded: '超过并发上限',
    statusAlreadyShown: '该相机已在另一格',
    statusDeviceRemoved: '设备已删除',
    statusDeviceOffline: '设备离线',
    start: '开始',
    stop: '停止',
    /**
     * 播放器控制条上那一颗（业主 2026-09-19 第 12 批给的控制条清单里有「暂停」）。
     *
     * **动作没变**：它仍然是 `toggleCell()` —— 停掉这一路的 RTSP 会话，再按一次重新起流。
     * RTSP 直播没有真正的"暂停"（流不会等你），所以这里的「暂停」= 停止这一路直播，
     * 这一点写在 `docs/Ivms4200-UX-REFERENCE.md` §15.74，界面不假装画面停住了而流还在跑。
     */
    play: '播放',
    pause: '暂停',
    retry: '重试',
    fullscreen: '全屏',
    exitFullscreen: '退出全屏',
    audioOn: '开启声音',
    audioOff: '关闭声音',
    audioBadge: '正在出声',
    // 控制条上那颗音量按钮自己的名字（点它才弹出竖条）。
    volume: '音量',
    // 竖条滑杆的名字：业主说的"音量大小"，上下拖动调节。
    volumeLevel: '音量大小',
    // 控制条上那颗「切换录像」（= 右键菜单里的"回放本机录像"，同一个弹窗）。
    cellPlayback: '切换录像',
    // 控制条上那颗「告警」（= 右键菜单里的"告警配置"，同一个对话框）。
    cellAlarm: '告警配置',
    // 这一格没有画面时音量图标与滑杆**禁用**，它们的名字直接说出禁用的原因。
    volumeNoPicture: '这一格没有画面，无法出声',
    activeBadge: '当前格',
    /*
     * 这一轮删掉的词条（四处目录同步删除，删除理由写在这里，其余三处只跟删）：
     *   cellEmpty       空白格上只有一个 `+`，一个字都不写；
     *   idleHint        「未开始」的徽标已经说完，长句子是解释而不是状态；
     *   removingDevice /
     *   offlineDevice   设备被删/离线现在只显示短状态词，哪一台由叠加条上的名字回答；
     *   noCameraHint    同一件事标题行已经说过，而且「请先在设备管理中添加」是说明；
     *   setActive       本来就没有任何地方渲染它；
     *   streamError     同上（格子上的诊断原文来自主进程，不来自这条词）；
     *   pickPlaceholder 原生 `<select>` 的第一个 `<option>`（「请选择相机」）。
     *                   选择器改成自己画的浮层之后它没有读者了：浮层的无障碍名字来自
     *                   `pickDevice`，清单为空那一行是新增的 `pickNoOption`
     *                   （业主 2026-09-18 报的那个「弹出来看不见」的 bug，见
     *                   `CameraCellPicker.vue`）。
     */
    limitNotice: '同时直播上限为 {max} 路，当前 {active} 路。再开一路会超过上限，请先停掉另一格。',
    limitSummary: '同时直播 {active} / {max} 路',
    layoutShrunk: '分屏档位变小，{count} 个画面格的直播已停止。'
  },

  channelWall: {
    title: '通道墙',
    summary: '共 {count} 路通道',
    layoutLabel: '分屏档位',
    layout1: '1 分屏',
    layout2: '2 分屏',
    layout4: '4 分屏',
    layout8: '8 分屏',
    prevPage: '上一页',
    nextPage: '下一页',
    pageIndicator: '第 {page} / {total} 页',
    loading: '正在读取通道…',
    empty: '暂无可展示的通道',
    noChannelTable: '有 {count} 台设备尚未返回通道表，因此没有列出它们的通道。',
    cameraStreamLabel: '声纹图像',
    cameraMatrixOnly: '这台相机推送的是数值矩阵而不是图像帧，通道墙不重新绘图。',
    cameraOtherDevice: '数据流在另一台相机上',
    cameraStale: '数据已停止（{seconds} 秒前）',

    /*
     * 收起 / 展开。
     *
     * 名字说的是**按下去会发生什么**（与相机墙的播放按钮同一条规矩），
     * 此刻是收起的还是展开的由 `aria-expanded` 表达 —— 两件事各说各的，
     * 读屏软件报出来就是「展开通道墙，已收起，按钮」。
     */
    collapse: '收起通道墙',
    expand: '展开通道墙',
    /*
     * 默认收起时的那一句：说出**为什么**是收起的，否则一排空白看起来像坏了。
     * 收起的默认值来自「有没有通道在线」，所以这句话也必须只在那种情况下出现。
     */
    collapsedNoChannel: '当前没有在线通道',

    graphLabel: '图形类型',

    /*
     * 四种图形。名字就是产品要求里的说法（声压线 / 频谱图 / 时谱图 / 声纹图），
     * 每一种都对应设备端真实推送的一种载荷（见 `lib/channelWall.ts` 的
     * `CHANNEL_GRAPH_KINDS`）。
     *
     * `deviceHasNoData` 是**结构性**的事实：这台设备的家族根本没有这种载荷
     * （相机没有时频通道，声纹盒子没有图像），它与会话在不在、通不通无关，
     * 所以它与「未监测」「尚无数据」必须读起来是不同的话。
     *
     * `splCaption` / `lineAxis` 是画得出来时折线下面的角注：一个是真实读数，
     * 一个是“横轴到底是什么”。后者的存在理由：实测这台相机没有任何接口能给出
     * 采样率，编一个 Hz 轴比按谱线序号标注更糟。
     */
    graph: {
      voiceprint: '声纹图',
      spl: '声压线',
      spectrum: '频谱图',
      spectrogram: '时谱图',
      deviceHasNoData: '该设备不提供这种数据',
      splCaption: '{value} dB · {count} 点',
      lineAxis: '{count} 条谱线 · 横轴为谱线序号（设备未上报采样率）',
      /*
       * 声压读数的单位。
       *
       * **这个 `dB` 是本仓库的标注，设备侧没有手册依据**：设备推上来的字段名是
       * `sound_pressure_level`（`protocol/mappers.ts` 的 `spl`），本仓库里没有任何
       * 盒子手册能证明它是声压级的分贝值 —— `docs/reference/*` 全是 FA371 相机文档，
       * 而唯一一处 dB 定义（20 µPa 基准）来自那本相机手册。数值照常显示（所有者要的
       * 是那个数），但这四个字母是标注，不是计量结果。
       *
       * `splUnitNote` 是它的出处：挂在读数与单位元素的 `title` 上，值本身保持 `dB`
       * 这个短写法（8 分屏下格子只有几十像素宽）。
       */
      splUnit: 'dB',
      splUnitNote:
        '本仓库的标注：设备字段是 sound_pressure_level，其单位在设备手册中没有依据（本仓库没有盒子手册），不可当作计量校准结果。'
    },

    /*
     * 每一路通道的最近一条告警（本地告警库的记录）。
     *
     * 措辞固定为「最近告警」，**不是「正在告警」**：契约里没有任何「这一路此刻正在
     * 告警」的推送（`PushChannels` 里与告警沾边的两条都是设备级、且不带通道号），
     * 写「正在告警」就是编的（见 `ChannelWall.vue` 文件头）。
     *
     * 四种情况必须读起来是不同的事：读取中 / 读取失败 / 无告警记录 / 最近一条是什么。
     * 后者的确认状态复用告警页的词条（`alarmsUi.ackAcknowledged` / `ackUnacknowledged`），
     * 同一件事不在两处起名字。
     */
    alarm: {
      recent: '最近告警',
      loading: '读取中…',
      failed: '告警记录读取失败',
      none: '无告警记录',
      entry: '{type} · {time} · {ack}'
    },

    reason: {
      notMonitored: '未监测',
      deviceOffline: '设备离线，无法获取实时数据'
    }
  },

  /**
   * 系统消息 —— 顶栏那颗告警图标后面的面板里，**应用级**失败那一段（业主 2026-09-18）。
   *
   * 口径写在 `stores/appNotices.ts` 的文件头：应用级失败（设备列表/设置/告警列表读不出来、
   * 认证失败……）进这里，页面自己的就地反馈（表单校验、点一下的结果）不进来。面板是浮层，
   * 所以这些内容的出现与消失**不改变布局** —— 这正是业主那句话的后半句。
   */
  noticesUi: {
    title: '系统消息',
    clearAll: '全部清除',
    dismiss: '忽略这条系统消息',
    /*
     * 告警图标按钮的无障碍名字（有系统消息时）。角标里的**数字**仍然只是待处理告警条数
     * （与面板里那份列表同源），系统消息用这个句子说出来，两者不相加。
     */
    bellWithProblems: '{count} 条系统消息 · 待处理告警'
  },

  /**
   * 告警本地联动（录像 / 弹窗 / 提示 / 邮件）。
   *
   * 与其它目录同一条规则：**任何一条消息都不得包含 `@`**
   * （vue-i18n 的 linked-message 信号；含 `@` 的消息在渲染时编译失败，
   * `tests/i18n.test.ts` 会编译每一条消息并把这种失败变成测试失败）。
   * 本组里有邮箱相关的说明文字，写「邮箱地址」而不是示例地址，
   * 正是为了不引入 `@`。
   */
  linkage: {
    title: '告警联动',
    enabled: '启用告警联动',

    sourceSection: '触发源',
    pollInterval: '轮询间隔（秒）',
    useDetectFeedback: '启用检测反馈流加速器',
    minAlarmLevel: '最低告警等级',
    sourcePoll: '轮询检测日志',
    sourceWebsocket: '检测反馈流',
    sourceRunning: '运行中',
    sourceStopped: '已停止',
    sourceLastPoll: '最近一次轮询',
    sourceLastError: '最近一次错误',
    sourceTriggers: '已触发',
    sourceFrames: '已收到帧',
    sourceNoFrames: '至今 0 帧（该事件流从未推送过数据）',

    actionSection: '动作开关',
    action: {
      record: '录像',
      popup: '弹窗',
      notice: '提示',
      email: '邮件'
    },
    actionState: {
      success: '成功',
      failed: '失败',
      skipped: '已跳过'
    },

    recordSection: '录像',
    recordDuration: '录像时长（秒）',
    recordCooldown: '冷却时间（秒）',
    recordSkipBusy: '正在录像时跳过',

    popupSection: '弹窗',
    popupAutoDismiss: '自动关闭（秒）',
    popupCooldown: '冷却时间（秒）',
    popupMaxStack: '同时最多几个',

    noticeSection: '提示',
    noticeCapacity: '保留条数',

    /**
     * 邮件**服务器**那一块已经搬到 `emailUi`（手册 §17.2.8 的独立标签页）。
     * 这里只留**联动侧**的两个字段，它们的标题也随之下移。
     */
    emailActionSection: '邮件动作',
    emailHostPlaceholder: '例如 smtp.example.com',
    emailPasswordPlaceholder: '留空表示保持已保存的口令不变',
    emailPasswordStored: '已保存口令',
    emailPasswordNotStored: '未保存口令',
    emailPasswordClearHint: '填一个空格并保存可清除口令',
    emailSubject: '主题模板',
    emailBody: '正文模板',
    emailAttachFrame: '附带抓帧',
    emailCooldown: '冷却时间（秒）',
    emailTesting: '正在发送…',
    emailTestOk: '测试邮件已送达 SMTP 服务器（{count} 个收件人）',
    emailTestFailed: '测试邮件发送失败：{reason}',
    emailTestAttach: '测试附件',
    emailTestAttachNone: '不带附件',
    emailTestAttachSynthetic: '内置测试图片',
    emailTestAttachCamera: '相机当前画面',
    emailTestPrompt: '请先保存设置，测试邮件使用的是保存后的服务器与模板。',

    runtimeSection: '频率上限',
    maxActionsPerMinute: '全局上限（次/分钟）',
    cooldownPeriod: '冷却窗口（秒）',
    cooldownPerPeriod: '窗口内上限（次）',
    cooldownPerInterface: '每个时间片上限（次）',
    windowUsage: '本窗口已用 {used} / {limit}',

    bellTitle: '告警：{count} 条未确认',
    deviceAlarmsTitle: '设备告警',
    deviceAlarmsEmpty: '当前没有未确认的设备告警',
    deviceAlarmAcknowledge: '确认',
    deviceAlarmsMore: '另有 {count} 条未列出（到「告警中心」看全部）',
    pendingTitle: '待处理告警',
    pendingEmpty: '当前无告警',
    pendingAcknowledge: '确认',
    pendingAcknowledgeAll: '全部确认',
    pendingAcknowledged: '已确认',
    pendingDropped: '有 {count} 条更早的告警因超出保留上限被丢弃',
    pendingLevel: '等级',
    pendingStrategy: '策略',
    pendingMetrics: '声场强度 {intensity}，泄漏量 {volume}',
    pendingNoActions: '本次没有执行任何动作',
    pendingEngineOff: '告警联动当前是关闭的',
    pendingShow: '显示待处理告警',

    adminOnly: '修改告警联动配置、发送测试邮件与确认告警需要管理员账户。',
    loadFailed: '读取告警联动状态失败',
    statusTriggers: '本次运行已触发 {count} 次',
    statusActions: '已执行动作 {count} 次'
  },

  /**
   * 事件与告警中心（`/events`）。
   *
   * 与 `linkage` 同一硬规则：**任何一条消息都不得包含 `@`**
   * （vue-i18n 的 linked-message 信号；含 `@` 的消息渲染时编译失败，
   * `tests/i18n.test.ts` 会编译每一条消息并把这种失败变成测试失败）。
   *
   * 文案里反复出现「等级未知」「近似时间」「设备没有给时间」，是刻意的：
   * 相机手册把 `alarm_level` 列在字段表里却从未在真机出现过（§8.3 C15），
   * 时间戳单位也从未声明（§8.3 C19），所以界面必须说清哪些值是设备给的、
   * 哪些是按假设换算的，而不是把它们画成确定的事实。
   */
  eventsUi: {
    countSummary: '本次筛选命中 {total} 条事件',
    truncated:
      '本次结果不完整：某路来源的读取被截断（每路来源最多读取 {cap} 条），或者更早的告警已被引擎丢弃；下方「来源读况」写明了各截掉多少条。',
    emptyTitle: '没有任何事件上报',
    emptyFilteredTitle: '当前筛选条件下没有事件',

    sourcesTitle: '来源读况',
    sourceOk: '读到 {count} 条',
    sourceFailed: '读取失败：{reason}',
    sourceTruncated: '已截断 {count} 条',
    sourceUntimed: '其中 {count} 条设备没有给时间',

    filterDevice: '设备',
    filterAllDevices: '全部设备',
    filterSource: '来源',
    filterAllSources: '全部来源',
    filterSeverity: '等级',
    filterAllSeverities: '全部等级',
    filterFrom: '开始时间',
    filterTo: '结束时间',
    filterAck: '确认状态',
    ackAll: '全部',
    ackUnacknowledged: '未确认',
    ackAcknowledged: '已确认',

    approximateBadge: '近似时间',
    approximateHint:
      '相机接口没有声明时间戳单位，本页按秒解读设备时间，因此换算结果是近似值。',
    timeUnknown: '设备没有提供这条日志的时间，列表按读取时刻排序。',

    detailTitle: '事件详情',
    detailEventId: '事件标识',
    detailDevice: '设备',
    detailSource: '来源',
    detailKind: '事件',
    detailSeverity: '等级',
    detailDeviceTime: '设备原始时间戳',
    detailDeviceTimeUnit: '解读单位',
    detailSavingPath: '设备目录',
    detailLogId: '检测日志编号',
    detailDetectMode: '检测模式（原始值）',
    detailAlarmLevel: '设备告警等级（原始值，未换算）',

    detailFilesTitle: '检测结果文件（设备侧动作）',
    detailDetectTitle: '检测日志详情',
    detailFilesEmpty: '这条检测日志没有可用的结果文件',
    detailFileDownload: '下载',
    detailFileDownloading: '正在下载…',
    detailFileDownloaded: '已下载',
    detailFilePlay: '播放',
    detailFileOpenVideo: '打开视频',
    detailDownloadNeedAdmin: '下载结果文件需要管理员账户',
    detailSourceUnavailable: '这一路来源本次读取失败，请稍后重试',

    detailAck: '确认该事件',
    detailAckUnsupported:
      '相机侧的检测日志没有确认接口（手册的 32 个开放接口里没有），因此这一条不能确认。',

    detailRecordingTitle: '本机录像与画面',
    detailRecordingNone: '这条事件在本机没有对应的录像文件。',
    detailRecordingPending: '这条检测的结果文件还没有下载，因此本机没有可播放的文件。',
    detailRecordingVideoUnavailable: '无法播放这段录像（本地文件不存在或不是视频）。',
    detailRecordingGoto: '前往录音文件页',
    detailFrameTitle: '联动抓帧',

    detailMetricsTitle: '指标',
    metricSoundmapIntensity: '声场强度',
    metricLeakVolume: '泄漏量',
    metricLeakCost: '泄漏成本',
    detailActionsTitle: '联动动作',
    detailActionLine: '{action}：{status}',
    detailActionReason: '原因：{reason}',

    detailLocalAlarmChannel: '通道',
    detailLocalAlarmTypes: '告警类型',

    downloadDone: '已下载 {name}（{size}）',

    // --- Phase 3：KPI 条 / 筛选 / 告警队列（规格 §8–§10） --------------------
    // 规格的五档都给出中文名：`medium` / `low` 现在没有代码路径能产生（界面不渲染它们，
    // 见 `VISIBLE_ALERT_SEVERITIES`），但 `AlertSeverity` 是完整类型 —— 少两个名字，
    // Phase 5 把五级存进库的那天就会渲染出裸 key。
    alertSeverity: {
      critical: '严重',
      high: '高',
      medium: '中',
      low: '低',
      info: '提示'
    },
    alertStatus: {
      new: '待处理',
      acknowledged: '已确认',
      investigating: '调查中',
      resolved: '已解决',
      closed: '已关闭',
      muted: '已静默',
      reopened: '重新开启'
    },
    severityUnknown: '等级未知',

    kpiUnacknowledged: '未确认',
    kpiAvgAck: '平均确认耗时',
    kpiScope: 'KPI 与计数按已加载的 {loaded} 条统计（本次结果 {total} 条）',

    viewMode: {
      compact: '紧凑',
      standard: '标准',
      evidence: '证据'
    },

    searchPlaceholder: '搜索设备、事件、指标',
    searchScope: '搜索只在已加载的 {loaded} 条里生效',

    savedViewTitle: '视图',
    savedView: {
      all: '全部',
      critical: '严重',
      high: '高',
      unacknowledged: '未确认',
      last24h: '近 24 小时',
      last7d: '近 7 天'
    },

    filterPanelTitle: '筛选',
    filterPanelToggle: '筛选面板',
    panelCount: '{count} 条',
    panelScope: '计数按已加载的 {loaded} 条',
    clearFilters: '清除全部',

    evidenceRecording: '录像',
    evidenceFrame: '抓帧',
    evidenceFiles: '{count} 个文件',
    metricMore: '另有 {count} 项',

    // --- Phase 4：详情抽屉 / Overview / Evidence（规格 §11–§12） --------------
    // 五个页签都给名字：Timeline / Related / Activity 要到 Phase 5 才渲染，
    // 但页签类型是完整的 —— 少一个名字，那天就会印出裸 key。
    detailTab: {
      overview: '概览',
      evidence: '证据',
      timeline: '时间线',
      related: '关联',
      activity: '活动'
    },
    overviewStatus: '状态',
    overviewFirstDetected: '首次探测',
    overviewLastDetected: '最后探测',
    overviewDuration: '持续时长',
    overviewOccurrences: '次数',
    drawerResize: '拖动调整抽屉宽度',

    evidenceVisualTitle: '画面与图片',
    evidenceNone: '这条事件没有图片证据。',
    evidenceNotCaptured: '设备上没有抓到图（同步时可能没有打开抓图下载）。',
    evidenceFilesGone: '库里记着这份图，但本机磁盘上已经没有了。',
    evidenceNotImage: '这份文件在，但不是能显示的图片格式。',
    evidenceNotFound: '找不到这份图片证据的路径。',
    evidenceError: '读取图片证据失败。',

    // --- Phase 5：状态机 / 处置动作 / Activity / Timeline / Related（§2.2、§13）--
    actionInvestigate: '开始调查',
    actionResolve: '标记已解决',
    actionClose: '关闭',
    actionReopen: '重新开启',
    actionMute: '静默',
    actionUnmute: '取消静默',
    actionAssign: '指派',

    activityKind: {
      status: '状态变更',
      assign: '指派',
      note: '说明'
    },


    relatedSameDevice: '同一台设备',    relatedSameKind: '同一种事件',
    relatedTimeWindow: '前后 10 分钟',

    // --- Phase 5（界面）：动作 / 时间线 / 相关性 / 处置记录 -------------------
    relatedTitle: '关联事件',
    relatedScope: '相关性只在已加载的 {loaded} 条里找',
    relatedEmpty: '没有找到相关的其它事件。',
    relatedOpen: '查看这一条',

    /*
     * --- Phase 6 后半（规格 §13.2 的建议卡 + §14.2 的 V1）---------------------
     *
     * 「Incident」这个词**不翻译**：规格全篇用的是它（§2.1 把它与 Event / Alert 并列定义），
     * 中文里没有一个既准确又不会与"告警""事件"混淆的词 —— 翻成"事件"会和我们自己的
     * 「事件」撞车，翻成"故障单"则加了规格没有的含义。
     */
    incidentTitle: 'Incident 关联',
    /*
     * 建议阈值就地可调（业主 2026-09-18：「可以设置为可调整的」）。规格 §13.2 只说
     * "当相关性达到阈值时"，阈值本身手册未说明 —— 所以由操作员在这几个离散档位里选。
     */
    incidentThreshold: '建议阈值',
    incidentThresholdOption: '{count} 条',
    incidentBelowThreshold: '同设备上还有 {related} 条其它告警，未到阈值（{count} 条），因此没有给建议。',
    incidentNone: '这一条还没有关联任何 Incident。',
    incidentAlertCount: '{count} 条关联告警',
    incidentUnlink: '解除关联',
    incidentSuggestionLabel: '可能相关的 Incident',
    incidentSuggestionCount: '{count} 条相关告警',
    incidentSuggestedTitle: '{device} 异常情况',
    incidentCreate: '创建 Incident',
    incidentLinkExisting: '关联到已有 Incident',
    incidentCreated: '已创建「{title}」，关联了 {count} 条告警',
    incidentLinked: '已关联 {linked} 条（另有 {already} 条本来就在里面）',
    incidentUnlinked: '已解除与「{title}」的关联',
    incidentFailed: '这个操作没有成功。',
    incidentDialogTitle: 'Incident',
    incidentModeLabel: '怎么做',
    incidentModeCreate: '新建 Incident',
    incidentModeLink: '关联到已有',
    incidentFieldTitle: '标题',
    incidentTitlePlaceholder: '例如：1 号风机异常情况',
    incidentTitleHint: '最多 {max} 字',
    incidentFieldNote: '备注（可选）',
    incidentFieldExisting: '选择 Incident',
    incidentCandidates: '一并关联这些告警（{count} 条）',
    incidentNoCandidates: '没有可一并关联的告警 —— 只创建 Incident 本身。',
    incidentNoExisting: '还没有已建的 Incident',
    incidentSubmitCreate: '创建并关联',
    incidentSubmitLink: '关联',
    incidentSubmitting: '正在写入…',
    incidentReasonTitleRequired: '标题不能为空',
    incidentReasonTitleTooLong: '标题太长（上限 {max} 字）',
    incidentReasonNoteTooLong: '备注太长（上限 {max} 字）',
    incidentReasonNoExisting: '先选一个 Incident',
    incidentReasonNoAlerts: '至少要选一条告警',

    timelineTitle: '时间线',
    timelineDetected: '首次探测到',

    activityTitle: '处置记录',
    activityEmpty: '这一条还没有任何处置记录。',
    activityStatusLine: '{actor} 把状态从「{from}」改为「{to}」',
    activityAssignLine: '{actor} 指派给 {name}',
    activityNoteLine: '{actor} 留言',
    statusChangeDone: '状态已改为「{status}」',
    assignDone: '已指派给 {name}',
    actionAssignee: '指派给',
    actionNote: '添加说明',
    actionReopenNotePlaceholder: '重新开启的原因（必填）',
    actionNoteEmpty: '请先填写原因',
    actionConfirm: '确定',
    actionCancel: '取消',

    // --- Phase 6：重复触发聚合（规格 §14.1）---------------------------------
    groupWindowLabel: '聚合',
    groupWindow: {
      off: '不聚合',
      m10: '10 分钟内',
      m30: '30 分钟内',
      h1: '1 小时内'
    },
    occurrenceCount: '×{count}',
    timelineOccurrence: '第 {index} 次触发',
    statusChangeDoneMany: '已把 {count} 次触发的状态改为「{status}」'

  }
}
