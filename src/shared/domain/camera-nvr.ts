/**
 * 相机 NVR 式交互（右键菜单 / 手动录像 / 抓图）的**纯**规则与命名。
 *
 * WHY THIS IS SHARED AND PURE
 * 三处代码必须对同一台相机在同一时刻给出同一个答案：
 *   1. 视频画面上的右键菜单（`VideoContextMenu.vue`），
 *   2. 面板上的「开始/停止录像」「抓图」按钮，
 *   3. 主进程的录像/抓图服务（它才是最终拒绝非法请求的地方）。
 * 如果每一步各自判断一次「现在能不能录」，三者迟早会漂移——菜单亮着而按钮灰着，
 * 或者反过来，用户点了没反应。所以判断只写一次，写在这里：无 I/O、无 Vue、
 * 无 Electron，可以被 `node --test` 直接断言。
 *
 * 同理，文件名与目录段也放在这里：主进程用它拼真实路径，测试用它断言命名规则
 * （时间戳前缀保证按文件名排序即按时间排序，冲突时追加序号而不是覆盖）。
 */

import type { CameraLiveState, CameraLiveStatus } from './camera-live'
import { CAMERA_CELL_VIEW_MODES, type CameraCellViewMode } from './camera-cell-view'

// ---------------------------------------------------------------------------
// 右键菜单
// ---------------------------------------------------------------------------

/** 菜单项的稳定 id。UI 的分发（switch）和测试都按它来，不用显示文字。 */
export const CAMERA_NVR_ACTIONS = [
  'toggle-recording',
  'snapshot',
  'alarm-config',
  'toggle-fullscreen',
  'copy-rtsp',
  'open-external',
  'toggle-overlay',
  /**
   * 四种显示方式（播放 / 1 秒时域图 / 频域图 / 时频谱图）。
   *
   * 业主 2026-09-19 第 12 批把播放器控制条收成六颗播放器控件
   * （告警 / 全屏 / 暂停 / 切换录像 / 音量 / 手动录像），四颗视图按钮**从控制条移到了这里**:
   * 它们是"这一格画什么"，不是播放器动作。移走而不是删掉（第 10 批第 2 条要的四种视图仍然可达），
   * 也仍然只有一处实现（`CAMERA_CELL_VIEW_MODES`）。
   */
  'view-play',
  'view-timedomain',
  'view-spectrum',
  'view-spectrogram',
  // 本机录像回放（不是回看设备录像计划，语义见 `buildCameraNvrMenu()`）。
  'playback',
  // 下载设备侧生成的检测结果文件。
  'download-detect',
  // 清空这一格（画面格自己的动作，与相机能力无关）。
  'close-tile'
] as const

export type CameraNvrAction = (typeof CAMERA_NVR_ACTIONS)[number]

/**
 * 菜单渲染需要知道的、**不属于相机状态**的那些事实。
 *
 * 全部由调用方（视图）提供，而不是在这里去问主进程：这个函数必须是纯的，
 * 否则「菜单为什么灰着」就又要靠一次 IPC 往返才能回答。
 */
export interface CameraNvrEnvironment {
  /** 设备名，用于「显示叠加信息」时叠在画面上的标题。 */
  deviceName: string
  /** 主进程是否正在为这台相机手动录像（录像中该项读「停止录像」）。 */
  recording: boolean
  /** 是否处于全屏（决定该项读「全屏」还是「退出全屏」）。 */
  fullscreen: boolean
  /** 叠加信息是否可见。 */
  overlay: boolean
  /**
   * 当前是否存在**可用的 RTSP 源**（活动会话）。
   *
   * 抓图/录像还要求视频真的在出帧（见 `cameraCaptureReadiness`），但
   * 「在外部播放器打开」只需要一个能交给播放器的地址，因此单独列出。
   */
  hasUsableSource: boolean
  /**
   * **设备族能力**——决定菜单项是否存在，而不是是否可点。
   *
   * 参考 iVMS-4200 的做法：设备根本做不到的功能**不出现**（它的手册原话是
   * "only available when …"），只有「此刻不可用」才灰显并说明原因。两类混淆
   * 起来会让菜单里堆着一堆永远点不动的项，也会让人以为设备有这个能力。
   *
   * 这里的能力全部来自设备族事实，与当前流状态无关：
   *   - `liveVideo`  该设备族有没有实时视频画面（声学相机有，声纹设备没有）；
   *   - `alarmModel` 该设备族有没有「告警策略 + 告警条件」这套模型（相机有；
   *                  声纹设备的告警档位是另一套接口，与本模型不通用）。
   */
  capabilities: CameraNvrCapabilities
  /**
   * 这一格**此刻**画的是哪一种视图（播放 / 1 秒时域图 / 频域图 / 时频谱图）。
   *
   * 缺省 = `play`。菜单里「显示方式」那四个子项要打一个 ✓，所以它必须是**当前值**，
   * 而不是"这一格支持什么"（那是下面那个）。
   */
  cellView?: CameraCellViewMode
  /**
   * 这一格**支持**哪些视图。
   *
   * 缺省 = 全部四种（一台真实的相机）。手填的第三方 RTSP 源只有画面，所以它那一格
   * 传 `['play']`：另外三种在这张菜单里**灰显并写出原因**（`cameraWallUi.viewNeedsCamera`
   * = "第三方 RTSP 源只有画面"）。按本文件的老规矩，设备族做不到的功能不出现 ——
   * 而这里"做不到"的是**这一格的来源**，不是设备族，所以给一句原因比整项消失更有用
   * （操作员会问"为什么只有播放"，菜单必须答得上来）。
   */
  availableViews?: readonly CameraCellViewMode[]
}

export interface CameraNvrCapabilities {
  liveVideo: boolean
  alarmModel: boolean
  /**
   * 本机录像回放入口。**可选，缺省即「没有」**。
   *
   * 与上面两个能力不同，这两个是**界面实现**的能力，不是设备族的能力：
   * 「本机录像回放」和「下载设备检测记录」各自需要一套弹窗（录像列表 / 检测记录
   * 列表）才能真正做完。一个还没接上那套弹窗的页面如果显示这一项，用户点下去
   * 只会得到一个关不掉的空菜单项——正是本文件最反对的那种「静默的不可点」。
   *
   * 所以缺省是**关闭**：能力默认不宣称，只有确实实现了该动作的界面才打开它。
   * 这样新增菜单项对既有页面（`MonitorView`）是**零影响**，`camera-nvr.test.ts`
   * 用「不传新能力时输出与扩展前逐字节相同」把这件事钉住。
   */
  localPlayback?: boolean
  /** 设备检测记录下载入口。可选，缺省即「没有」（理由同上）。 */
  detectDownload?: boolean
  /**
   * 「关闭这一格」入口。可选，缺省即「没有」。
   *
   * 画面格顶部原有的「关闭」按钮已按产品要求移除，清空一格因此需要一个新去处：
   * 否则操作员把相机放错了格，就只能把它换成另一台，永远清不空。
   *
   * 它其实是**格**的动作而不是相机的动作，仍然放在这里，是因为菜单是在**格**上
   * 打开的，而「哪些项存在、按什么顺序排、各自什么时候灰」这套规则只允许有一处
   * 实现。灰显/存在的判据同样按「界面声明了才有」处理。
   */
  tileClose?: boolean
  /**
   * 「显示方式」入口（播放 / 1 秒时域图 / 频域图 / 时频谱图）。**可选，缺省即「没有」**。
   *
   * 与 `localPlayback` / `detectDownload` 同一类：这是**界面实现**的能力，不是设备族的。
   * 四种视图是**画面格**的东西（业主 2026-09-18 第 10 批第 2 条要的是"视频墙"上的四种画法），
   * 实时监测页那一屏有它自己的一套声学面板，没有"这一格画什么"这回事 —— 所以那一页不声明，
   * 菜单里也就不会出现一个点了没反应的「显示方式」。
   */
  cellViews?: boolean
}

export interface CameraNvrMenuItem {
  action: CameraNvrAction | CameraNvrSubmenuAction
  /** 目录键**名**，不是渲染后的文字：换语言时菜单必须跟着换。 */
  labelKey: string
  /**
   * 是否存在（false = 设备族没有这个能力，整项不画）。
   *
   * 与 `enabled` 是两件事：`visible: false` 是「设备做不到」，`enabled: false`
   * 是「现在做不了」，后者必须带上原因。
   */
  visible: boolean
  enabled: boolean
  /** 禁用原因（目录键），仅在 `visible && !enabled` 时存在。 */
  disabledReasonKey?: string
  /** 禁用的**原始**诊断文字（设备/主进程给的），优先于上面的通用文案。 */
  disabledReasonText?: string
  /** 开关型菜单项的当前状态（叠加信息）。 */
  checked?: boolean
  /** 该组之前画一条分隔线，模仿安全监控软件的菜单分组。 */
  separatorBefore?: boolean
  /**
   * 二级菜单（最多两层，且**子项不得再带子菜单**）。
   *
   * 「同类变体」放这里，而不是摊成同级项：抓图与手动录像是同一件事的两种形态。
   * 录像的开关状态仍然在**同一个位置**翻转（子项文字变化），因此「就地翻转」
   * 这条规则没有被破坏。
   */
  submenu?: CameraNvrMenuItem[]
}

/** 只有分组用的「父项」，点击它只展开子菜单，不派发任何动作。 */
export const CAMERA_NVR_SUBMENU_ACTIONS = ['capture', 'display'] as const
export type CameraNvrSubmenuAction = (typeof CAMERA_NVR_SUBMENU_ACTIONS)[number]

/**
 * 四种显示方式在菜单里的动作 id 与文案键（顺序就是 `CAMERA_CELL_VIEW_MODES` 的顺序）。
 *
 * 文案复用 `cameraWallUi.view*` —— 这四个名字在控制条上是它们、在菜单里也是它们，
 * 「一件事只有一处措辞」。
 */
const VIEW_ACTION_BY_MODE: Record<CameraCellViewMode, CameraNvrAction> = {
  play: 'view-play',
  timedomain: 'view-timedomain',
  spectrum: 'view-spectrum',
  spectrogram: 'view-spectrogram'
}

const VIEW_LABEL_BY_MODE: Record<CameraCellViewMode, string> = {
  play: 'cameraWallUi.viewPlay',
  timedomain: 'cameraWallUi.viewTimedomain',
  spectrum: 'cameraWallUi.viewSpectrum',
  spectrogram: 'cameraWallUi.viewSpectrogram'
}

/**
 * 抓图 / 手动录像的准备状态 —— **唯一**的可用性判断。
 *
 * 只有 `playing` 才算「有画面可录/可抓」：
 *   - `idle`      没有会话，点下去只会得到一个打不开的地址；
 *   - `starting`  ffmpeg 还没吐出第一个字节，此时抓图必然抓空、
 *                 录像会写出一段没有关键帧的空文件；
 *   - `rtsp-disabled` / `ffmpeg-missing` / `error` 都带着各自的诊断，照原样说明；
 *   - `limit-exceeded` 不是设备故障，而是本机的并发预算满了：**先停掉别的画面格**
 *     才可能录到这一路，所以它也必须有一条自己的说明，而不是被并进 `error`。
 *
 * 每个分支都给一个目录键：菜单项和按钮都要能解释「为什么不能点」，而不是
 * 静默失败（这是产品要求里最硬的一条）。
 */
export interface CameraCaptureReadiness {
  ready: boolean
  /** 与状态对应的原因键；`ready` 为 true 时也给出（供提示语使用）。 */
  reasonKey: string
  /** 状态自带的主进程/设备诊断原文，存在时优先展示。 */
  reasonText?: string
}

/** 状态 -> 原因目录键。 */
export const CAMERA_CAPTURE_REASON_KEYS: Record<CameraLiveStatus, string> = {
  idle: 'cameraNvrUi.reasonIdle',
  starting: 'cameraNvrUi.reasonStarting',
  playing: 'cameraNvrUi.reasonReady',
  'rtsp-disabled': 'cameraNvrUi.reasonRtspDisabled',
  'ffmpeg-missing': 'cameraNvrUi.reasonFfmpegMissing',
  error: 'cameraNvrUi.reasonError',
  // 并发预算滿了：设备没问题，是「同时看几路」这件事到顶了。
  'limit-exceeded': 'cameraNvrUi.reasonLimitExceeded'
}

export function cameraCaptureReadiness(state: CameraLiveState | null): CameraCaptureReadiness {
  const status: CameraLiveStatus = state?.status ?? 'idle'
  const reasonKey = CAMERA_CAPTURE_REASON_KEYS[status]
  const result: CameraCaptureReadiness = {
    ready: status === 'playing',
    reasonKey
  }
  const text = state?.error?.trim()
  // 主进程的话（`rtsp_enabled=0`、ffmpeg 的 stderr 尾部、连接被拒……）永远比
  // 一句通用文案有用，所以原样带上，UI 可以选择显示它。
  if (text !== undefined && text !== '') result.reasonText = text
  return result
}

/**
 * 生成右键菜单项。
 *
 * 规则集中在这里，视图只负责渲染与派发，不允许再写一遍 `visible` / `enabled`
 * 判断。三条来自 iVMS-4200 的排布规则落在这里：
 *   1. **做不到的功能不出现**（`visible`），只在「此刻不可用」才灰显 + 说明；
 *   2. **同类变体进二级菜单**（抓图 / 录像），菜单最深两层；
 *   3. **设备侧动作排在本地动作之后**（告警配置写的是设备，排在最后）。
 */
export function buildCameraNvrMenu(
  state: CameraLiveState | null,
  env: CameraNvrEnvironment
): CameraNvrMenuItem[] {
  const readiness = cameraCaptureReadiness(state)
  const captureReason = {
    disabledReasonKey: readiness.reasonKey,
    ...(readiness.reasonText !== undefined ? { disabledReasonText: readiness.reasonText } : {})
  }
  const hasAddress = (state?.rtspUrl ?? '').trim() !== ''
  const { liveVideo, alarmModel } = env.capabilities

  /**
   * 「显示方式」那四个子项（业主 2026-09-19 第 12 批把视图按钮从控制条移到这里）。
   *
   * `enabled` 只由**这一格的来源**决定：一台相机的四种都能画，手填的第三方 RTSP 源只有画面。
   * 不可用的那几种**照旧列出并写出原因**（`cameraWallUi.viewNeedsCamera`）—— 这是本文件
   * 里"做不到的不出现"那条规则的一处**有意的例外**：四颗按钮刚刚从控制条上被移走，
   * 操作员点开菜单就是来问"那几张图去哪了"的，整项消失等于拒绝回答。
   */
  const availableViews = env.availableViews ?? CAMERA_CELL_VIEW_MODES
  const currentView: CameraCellViewMode = env.cellView ?? 'play'
  const displayItems: CameraNvrMenuItem[] = CAMERA_CELL_VIEW_MODES.map((mode) => {
    const usable = availableViews.includes(mode)
    return {
      action: VIEW_ACTION_BY_MODE[mode],
      labelKey: VIEW_LABEL_BY_MODE[mode],
      visible: liveVideo,
      enabled: usable,
      ...(usable ? {} : { disabledReasonKey: 'cameraWallUi.viewNeedsCamera' }),
      checked: currentView === mode
    }
  })

  const captureItems: CameraNvrMenuItem[] = [
    {
      action: 'toggle-recording',
      labelKey: env.recording ? 'cameraNvrUi.menuStopRecording' : 'cameraNvrUi.menuStartRecording',
      visible: liveVideo,
      // 录像中永远可以停：状态在录制过程中变成 error 也必须能收尾，
      // 否则用户会被卡在一个停不下来的红色指示器上。
      enabled: env.recording || readiness.ready,
      ...(env.recording || readiness.ready ? {} : captureReason)
    },
    {
      action: 'snapshot',
      labelKey: 'cameraNvrUi.menuSnapshot',
      visible: liveVideo,
      enabled: readiness.ready,
      ...(readiness.ready ? {} : captureReason)
    }
  ]

  const items: CameraNvrMenuItem[] = [
    {
      action: 'capture',
      labelKey: 'cameraNvrUi.menuCapture',
      visible: liveVideo,
      // 父项本身不执行动作：它存在只是为了把两类变体收进二级菜单。
      enabled: captureItems.some((item) => item.enabled),
      ...(captureItems.some((item) => item.enabled) ? {} : captureReason),
      submenu: captureItems
    },
    {
      action: 'toggle-fullscreen',
      labelKey: env.fullscreen ? 'cameraNvrUi.menuExitFullscreen' : 'cameraNvrUi.menuFullscreen',
      visible: liveVideo,
      enabled: true
    },
    {
      action: 'copy-rtsp',
      labelKey: 'cameraNvrUi.menuCopyRtsp',
      visible: liveVideo,
      enabled: hasAddress,
      ...(hasAddress ? {} : { disabledReasonKey: 'cameraNvrUi.reasonNoAddress' })
    },
    {
      action: 'open-external',
      labelKey: 'cameraNvrUi.menuOpenExternal',
      visible: liveVideo,
      // 需要一个真正能打开的地址（带口令、来自活动会话）；仅有打码地址时
      // 交给播放器也打不开，所以宁可禁用并说明。
      enabled: env.hasUsableSource,
      ...(env.hasUsableSource ? {} : { disabledReasonKey: 'cameraNvrUi.reasonNoSource' })
    },
    {
      /*
       * 显示方式（播放 / 1 秒时域图 / 频域图 / 时频谱图）。
       *
       * 它紧挨着「叠加信息」摆在一起、**不带分隔线**：两项都是"这一格怎么画"，
       * 而不是"对相机做什么"。业主第 12 批把四颗视图按钮从控制条上撤走之后，
       * 这里是它们唯一的入口。
       */
      action: 'display',
      labelKey: 'cameraNvrUi.menuDisplay',
      visible: liveVideo && env.capabilities.cellViews === true,
      enabled: displayItems.some((item) => item.enabled),
      ...(displayItems.some((item) => item.enabled)
        ? {}
        : { disabledReasonKey: 'cameraWallUi.viewNeedsCamera' }),
      submenu: displayItems
    },
    {
      action: 'toggle-overlay',
      labelKey: env.overlay ? 'cameraNvrUi.menuHideOverlay' : 'cameraNvrUi.menuShowOverlay',
      visible: liveVideo,
      enabled: true,
      checked: env.overlay,
      separatorBefore: true
    },
    {
      /*
       * 本机录像回放。
       *
       * FA371 **没有**连续录像存储（`rtsp-stream.ts` 明确不把码流写盘），所以这里
       * 能回放的只有本机文件：操作员手动录下的片段，以及从设备下载下来的检测视频
       * （`detect-library-service.ts` 会把它们登记进同一张录像表）。这一点必须在
       * 文案里说清楚——iVMS 的 `Instant Playback` 读的是设备/存储服务器上的录像，
       * 我们没有那个东西，写成「回放设备录像」就是一句假话。
       *
       * `enabled` 恒为 true：它只是打开一个本机录像列表，而「这台相机还没有录像」
       * 是列表自己要说的事。本函数是纯的、不做 I/O，凭空判一个可用性就是猜。
       */
      action: 'playback',
      labelKey: 'cameraNvrUi.menuPlayback',
      visible: env.capabilities.localPlayback === true,
      enabled: true,
      separatorBefore: true
    },
    {
      /*
       * 下载设备侧生成的检测结果文件（`GET /detect_file/{saving_path}/{file_name}`）。
       *
       * 需要先选一条检测记录（`logId` + `startTimeRaw`），所以它同样是「打开一个
       * 选择器」。`enabled` 恒为 true 的理由与上一项相同。
       */
      action: 'download-detect',
      labelKey: 'cameraNvrUi.menuDownloadDetect',
      visible: env.capabilities.detectDownload === true,
      enabled: true
    },
    {
      /*
       * 清空这一格。它排在本机组的最末尾（「关闭」这种破坏性动作不该夹在常用项
       * 中间），但仍然**在**设备侧的告警配置之前——「设备侧动作永远排最后」是本文件
       * 的一条硬规则，由 `camera-nvr.test.ts` 钉住，不能为了位置好看而破坏它。
       */
      action: 'close-tile',
      labelKey: 'cameraNvrUi.menuCloseTile',
      visible: env.capabilities.tileClose === true,
      enabled: true,
      separatorBefore: true
    },
    {
      // 设备侧动作：写的是设备的告警策略与条件，因此排在所有本地动作之后。
      action: 'alarm-config',
      labelKey: 'cameraNvrUi.menuAlarmConfig',
      // 设备族没有告警模型时**不出现**：声纹设备的告警档位是另一套接口，
      // 在这里灰显一项只会让人以为相机也能配。
      visible: alarmModel,
      // 告警配置与视频是否在播放无关；管理员权限由主进程校验。
      enabled: true,
      separatorBefore: true
    }
  ]
  // 能力决定**存在**：做不到的项不画出来（参考 iVMS-4200 的做法）。两个来源——
  // 设备族做不到（`liveVideo` / `alarmModel`），以及**当前这个界面还没实现**
  // （`localPlayback` / `detectDownload`，缺省即没有）。
  return items.filter((item) => item.visible)
}

// ---------------------------------------------------------------------------
// 文件命名与目录（纯函数，主进程与测试共用）
// ---------------------------------------------------------------------------

/** 相机媒体文件的两种落盘目录（相对存储根）。 */
export const CAMERA_MEDIA_KINDS = ['video', 'snapshot'] as const
export type CameraMediaKind = (typeof CAMERA_MEDIA_KINDS)[number]

const KIND_EXTENSION: Record<CameraMediaKind, string> = {
  video: 'mp4',
  snapshot: 'jpg'
}

/** `2026-09-15_11-22-33-456` —— 文件名安全，且按字典序排序等于按时间排序。 */
export function cameraMediaStamp(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (input: number, width = 2): string => String(input).padStart(width, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`
  )
}

/** 目录段 `<YYYY>/<MM>/<DD>`，与音频目录保持同一套日期结构。 */
export function cameraMediaDateSegments(timestamp: number): [string, string, string] {
  const date = new Date(timestamp)
  const pad = (input: number): string => String(input).padStart(2, '0')
  return [String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate())]
}

/** 只保留文件名安全的字符，且不允许路径穿越。 */
export function safeCameraMediaSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)
  // `.` / `..` 本身是**合法字符**组合，却是路径段里唯一危险的两个值：它们会被
  // `path.join` 解释成「当前目录/上级目录」，把文件写到存储根外面去。字符白名单
  // 挡不住它们，所以单独拒绝。
  if (safe === '' || /^\.+$/.test(safe)) return 'unknown'
  return safe
}

/**
 * 相对存储根的目录：`<kind>/<DEVICE_UID>/<YYYY>/<MM>/<DD>`。
 *
 * 与 `StorageService.audioDir()` 同构（同样的 uid 目录 + 年月日分层），因此
 * 「把存储根搬到更大的盘」这件事对视频/抓图和音频一样只是一次设置变更。
 */
export function cameraMediaRelativeDirectory(
  kind: CameraMediaKind,
  deviceUid: string,
  timestamp: number
): string {
  const [year, month, day] = cameraMediaDateSegments(timestamp)
  return [kind, safeCameraMediaSegment(deviceUid), year, month, day].join('/')
}

export interface CameraMediaNameInput {
  timestamp: number
  kind: CameraMediaKind
  /** 附加标签（例如设备名），会追加在时间戳之后。 */
  label?: string
  /** 并列冲突时的序号：0 为首次（不带后缀）。 */
  attempt?: number
}

/**
 * 文件名。
 *
 * 时间戳在前，因此 `readdir` 的字典序就是时间序；`attempt` 只在同一毫秒内
 * 已经存在同名文件时递增，保证**永不覆盖**已有录像/抓图。
 */
export function cameraMediaFileName(input: CameraMediaNameInput): string {
  const stamp = cameraMediaStamp(input.timestamp)
  const label = input.label !== undefined && input.label.trim() !== ''
    ? `_${safeCameraMediaSegment(input.label.trim())}`
    : ''
  const attempt = input.attempt ?? 0
  const suffix = attempt > 0 ? `_${attempt}` : ''
  return `${stamp}${label}${suffix}.${KIND_EXTENSION[input.kind]}`
}
