/**
 * 视频墙每一格的**视图**（业主 2026-09-18 第 10 批第 2 条：「视频墙支持播放 / 1 秒时域图 /
 * 频域图 / 时频谱图」）。
 *
 * ---------------------------------------------------------------------------
 * 「四种视图」在我们这套架构里指的是同一台相机的四种**画法**
 * ---------------------------------------------------------------------------
 * 相机（FA371 声学相机）自己有两条数据来源：
 *   · **画面**：`GET /system/video` 给的 RTSP 地址 → ffmpeg → 回环 MP4 → `<video>`；
 *   · **声学预览**：设备自己的 WebSocket 通道（`pcmData` / `fftData` …），主进程抽稀之后
 *     经 IPC 推给渲染层。
 * 所以"四种视图"= 同一格用哪一路数据来画：
 *
 *   | 视图 | 数据 | 手册依据 |
 *   |---|---|---|
 *   | `play` | 画面（RTSP → ffmpeg） | §5.1.6 实时视频 |
 *   | `timedomain` | `pcmData` 包络，拼够 **1 秒** | 手册把 `pcmData` 描述成 PCM 流，**没有**规定要画多长；"1 秒"是业主给的 |
 *   | `spectrum` | `fftData` 的一帧谱线 | 手册只写"FFT 数据"，**没有**规定坐标轴 |
 *   | `spectrogram` | `fftData` 连续多帧堆成瀑布 | **手册未说明**——手册没有"时频谱图"这一路，它是从 FFT 帧堆出来的 |
 *
 * **手册未说明的地方（不编造）**：
 *   · 频域图的**频率轴**：实测这台相机没有任何 HTTP 接口能给出采样率
 *     （`binHz` 为 `undefined`），所以我们的界面只标"第 N 根谱线"，绝不编一个 Hz 轴
 *     （与 `Fa371FftPreview.binHz` 的注释同一条规矩）；
 *   · 时频谱图的**颜色映射**：手册没有任何色标，我们用一条固定的亮度映射并说明"颜色不代表
 *     绝对声压级，只表示同一帧内谱线的相对强弱"。
 *
 * ---------------------------------------------------------------------------
 * 哪些源支持哪些视图
 * ---------------------------------------------------------------------------
 * 手填的第三方 RTSP 源（业主 2026-09-19 第 3 条）**只有画面**：它连设备都不是，
 * 我们拿不到它的任何声学通道。所以它的视图列表就是 `['play']` —— 界面据此把那三个按钮
 * 藏起来并说明原因，而不是给一个点了没反应的按钮。
 */

/** 一格的四种画法。顺序就是界面上按钮的顺序。 */
export const CAMERA_CELL_VIEW_MODES = ['play', 'timedomain', 'spectrum', 'spectrogram'] as const

export type CameraCellViewMode = (typeof CAMERA_CELL_VIEW_MODES)[number]

/** 默认视图：进来先看画面（产品要求"选中即自动播放"）。 */
export const DEFAULT_CAMERA_CELL_VIEW: CameraCellViewMode = 'play'

export function isCameraCellViewMode(value: unknown): value is CameraCellViewMode {
  return typeof value === 'string' && (CAMERA_CELL_VIEW_MODES as readonly string[]).includes(value)
}

/** 这一格的源**是**什么（决定它支持哪些视图）。 */
export type CameraCellSourceKind = 'camera' | 'manual-rtsp' | 'empty' | 'other'

/**
 * 一种视图用哪一路相机通道。
 *
 * `play` 用 `null`：它走 RTSP + ffmpeg，与声学预览那两条 WebSocket 无关。
 */
export const CAMERA_CELL_VIEW_STREAM: Readonly<Record<CameraCellViewMode, 'pcmData' | 'fftData' | null>> = {
  play: null,
  timedomain: 'pcmData',
  spectrum: 'fftData',
  spectrogram: 'fftData'
}

/**
 * 「1 秒时域图」要拼多长时间。
 *
 * 主进程推给渲染层的一帧 `pcmData` 是**100 ms**（实测：4800 样本 @ 48 kHz，见
 * `Fa371PcmPreview.samples` 的注释），所以 1 秒 = 连续 10 帧。这个数字是**业主给的
 * "1 秒"**加上实测的帧长算出来的，手册没有规定。
 */
export const CAMERA_CELL_WAVEFORM_SECONDS = 1

/** 一帧 `pcmData` 覆盖的秒数（实测值，见上）。 */
export const FA371_PCM_FRAME_SECONDS = 0.1

/** 时域图要保留多少帧（`ceil(1 / 0.1)` = 10）。 */
export const CAMERA_CELL_WAVEFORM_FRAMES = Math.ceil(
  CAMERA_CELL_WAVEFORM_SECONDS / FA371_PCM_FRAME_SECONDS
)

/**
 * 时频谱图保留多少列（帧）。
 *
 * 30 列 × 主进程的推送节奏（实测 FFT 通道约 10 帧/s）≈ 3 秒的时间窗。给一个**固定的
 * 列数**而不是"按秒数换算"：渲染层只知道收到了几帧，推算秒数要靠推送节奏，而那个节奏
 * 设备端不保证（手册未说明），固定列数不会因此说谎。
 */
export const CAMERA_CELL_SPECTROGRAM_COLUMNS = 30

/** 每一列画多少行（谱线抽稀成这么多行）。 */
export const CAMERA_CELL_SPECTRUM_ROWS = 24

/** 频域图画多少根柱子（谱线抽稀到这么多根）。 */
export const CAMERA_CELL_SPECTRUM_BARS = 48

/**
 * 这一格的源支持哪些视图。
 *
 * 手填 RTSP 只有画面；相机四种都有；空格与"别的机型"（声纹设备/听诊盒子）不进画面墙，
 * 但为了界面上不出现"零个按钮"这种怪状态，它们也回一个只读的画面项。
 */
export function availableCellViews(kind: CameraCellSourceKind): readonly CameraCellViewMode[] {
  return kind === 'camera' ? CAMERA_CELL_VIEW_MODES : [DEFAULT_CAMERA_CELL_VIEW]
}

/** 这一格**能不能**切到某个视图（切不了时给出原因键，界面据此说明而不是静默）。 */
export function cellViewRefusalKey(
  kind: CameraCellSourceKind,
  mode: CameraCellViewMode
): 'cameraWallUi.viewNeedsCamera' | null {
  if (kind === 'manual-rtsp') return 'cameraWallUi.viewNeedsCamera'
  if (kind !== 'camera' && mode !== DEFAULT_CAMERA_CELL_VIEW) return 'cameraWallUi.viewNeedsCamera'
  return null
}

/** 视图的目录键（`cameraWallUi.view*`），界面与测试共用一处。 */
export const CAMERA_CELL_VIEW_KEYS: Readonly<Record<CameraCellViewMode, string>> = {
  play: 'cameraWallUi.viewPlay',
  timedomain: 'cameraWallUi.viewTimedomain',
  spectrum: 'cameraWallUi.viewSpectrum',
  spectrogram: 'cameraWallUi.viewSpectrogram'
}
