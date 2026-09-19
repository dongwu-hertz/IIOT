/**
 * 视频墙的四种视图（业主 2026-09-18 第 10 批第 2 条：「视频墙支持播放 / 1 秒时域图 / 频域图 /
 * 时频谱图」）。
 *
 * WHY THIS FILE EXISTS
 * 这一条有一半**在探针里验不到**：现场那台相机是离线的，收不到任何一帧真实数据，
 * 所以"图画得对不对"只能靠"喂进去一串已知的数、断言吐出来的轨迹"来钉。于是分成三块：
 *
 *   1. **纯计算**（`lib/cameraCellChart.ts`）：环形缓冲、1 秒拼帧、按列取极值、谱线抽稀、
 *      归一化、瀑布矩阵、色标 —— 全部是数进数出，逐条断言；
 *   2. **模型**（`lib/cameraWall.ts`）：视图逐格保存、换源/清格/换档位时怎么回落、
 *      哪些源支持哪些视图（手填 RTSP 只有画面）；
 *   3. **接线**（源码守卫）：墙把 `pcmData` / `fftData` 交给谁、离开页面有没有停订阅。
 *
 * 三条口径也在这一份里钉住（手册未说明的地方**不许编**）：
 *   · 频率轴没有 `binHz` 时只标"第 N 根谱线"，绝不编一个 Hz 轴；
 *   · 色标只表示同一帧内的相对强弱；
 *   · 时域图拼**固定 1 秒**（实测一帧 100 ms ⇒ 10 帧），不够就画多少算多少。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  CAMERA_CELL_SPECTROGRAM_COLUMNS,
  CAMERA_CELL_SPECTRUM_BARS,
  CAMERA_CELL_SPECTRUM_ROWS,
  CAMERA_CELL_VIEW_MODES,
  CAMERA_CELL_VIEW_STREAM,
  CAMERA_CELL_WAVEFORM_FRAMES,
  CAMERA_CELL_VIEW_KEYS,
  availableCellViews,
  cellViewRefusalKey,
  isCameraCellViewMode
} from '../src/shared/domain/camera-cell-view'
import { zhCN } from '../src/shared/i18n/messages/zh-CN'
import { en } from '../src/shared/i18n/messages/en'
import { es } from '../src/shared/i18n/messages/es'
import { tr } from '../src/shared/i18n/messages/tr'
import {
  concatWaveform,
  normalise,
  pushCapped,
  spectrogramColor,
  spectrogramColumn,
  spectrogramMatrix,
  spectrumAxisLabels,
  spectrumBars,
  waveformColumns,
  waveformFrames
} from '../src/renderer/src/lib/cameraCellChart'
import {
  assignCamera,
  buildCameraCells,
  cellViewsFor,
  cellViewsOf,
  clearCameraCell,
  createCameraWallModel,
  normaliseCameraWallModel,
  setCameraCellView,
  setCameraWallLayout,
  type CameraWallModel
} from '../src/renderer/src/lib/cameraWall'

const projectRoot = path.resolve(__dirname, '..', '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

const CATALOGUES: Record<string, { cameraWallUi: Record<string, unknown> }> = {
  'zh-CN': zhCN as unknown as { cameraWallUi: Record<string, unknown> },
  en: en as unknown as { cameraWallUi: Record<string, unknown> },
  es: es as unknown as { cameraWallUi: Record<string, unknown> },
  tr: tr as unknown as { cameraWallUi: Record<string, unknown> }
}

function messages(locale: string): Record<string, unknown> {
  return CATALOGUES[locale]!.cameraWallUi
}

// ---------------------------------------------------------------------------
// 1. 纯计算
// ---------------------------------------------------------------------------

describe('图表的纯计算', () => {
  it('环形缓冲：保留最后 limit 个，短的照收', () => {
    let list: number[] = []
    for (const value of [1, 2, 3]) list = pushCapped(list, value, 2)
    assert.deepEqual(list, [2, 3])
    assert.deepEqual(pushCapped([], 9, 3), [9])
    // 传入的数组**不被就地修改**（store 用整体替换，纯函数不能偷改旧值）。
    const original = [1, 2]
    const next = pushCapped(original, 3, 5)
    assert.deepEqual(original, [1, 2])
    assert.deepEqual(next, [1, 2, 3])
  })

  it('1 秒 = 10 帧（实测一帧 100 ms），不够就画多少算多少', () => {
    assert.equal(CAMERA_CELL_WAVEFORM_FRAMES, 10)
    assert.equal(waveformFrames([1, 2, 3]).length, 3)
    assert.deepEqual(waveformFrames(Array.from({ length: 12 }, (_, i) => i)), [
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11
    ])
  })

  it('时域：把若干帧的包络**按时间接起来**（不是叠加）', () => {
    assert.deepEqual(concatWaveform([[1, 2], [3]]), [1, 2, 3])
    assert.deepEqual(concatWaveform([]), [])
  })

  it('按像素列取极值：一列的尖峰不会被平均掉', () => {
    const columns = waveformColumns([1, -1, 5, 0, 0, 0], 3)
    assert.equal(columns.length, 3)
    assert.deepEqual(columns[0], { min: -1, max: 1 })
    assert.deepEqual(columns[1], { min: 0, max: 5 })
    // 采样点比列数还少时也要给出**每一列**（否则画的线会短一截）。
    assert.equal(waveformColumns([1], 4).length, 4)
    assert.deepEqual(waveformColumns([], 3), [
      { min: 0, max: 0 },
      { min: 0, max: 0 },
      { min: 0, max: 0 }
    ])
    assert.deepEqual(waveformColumns([1, 2], 0), [])
  })

  it('谱线抽稀取**每段最大值**（谱线的意义在峰值）', () => {
    const bars = spectrumBars([1, 9, 2, 3, 0, 4], 3)
    assert.equal(bars.length, 3)
    assert.deepEqual(bars, [9, 3, 4])
    assert.equal(spectrumBars([], 3).length, 3)
    assert.equal(spectrumBars([1, 2, 3]).length, CAMERA_CELL_SPECTRUM_BARS)
  })

  it('归一化：按**帧内**最大值；全零/空数组给出 0 而不是 NaN', () => {
    assert.deepEqual(normalise([0, 5, 10]), [0, 0.5, 1])
    assert.deepEqual(normalise([0, 0]), [0, 0])
    assert.deepEqual(normalise([]), [])
    // 超过上界不夹到 1 以上（画到画布外面去）。
    assert.deepEqual(normalise([-5, 5]), [0, 1])
  })

  it('频域图的轴：有 binHz 才写 Hz，没有就写"第 N 根谱线"（**不编采样率**）', () => {
    const withHz = spectrumAxisLabels(512, 200)
    assert.equal(withHz.unit, 'hz')
    assert.equal(withHz.left, '0 Hz')
    assert.equal(withHz.right, '102 kHz', '512 × 200 Hz = 102.4 kHz，四舍五入到 kHz')

    const without = spectrumAxisLabels(512, undefined)
    assert.equal(without.unit, 'bin')
    assert.equal(without.right, `#${CAMERA_CELL_SPECTRUM_BARS}`)
    // `binHz = 0` 也是"不知道"，不能当成 0 Hz。
    assert.equal(spectrumAxisLabels(512, 0).unit, 'bin')
  })

  it('时频谱图：一列 = 一帧抽稀成 rows 行，低频在第 0 行', () => {
    const column = spectrogramColumn([0, 0, 10, 10], 2)
    assert.equal(column.length, 2)
    assert.deepEqual(column, [0, 1])
  })

  it('瀑布矩阵：**左补空列**（不够时不许把历史挤到右边）', () => {
    const frames = [[1, 2, 3, 4]]
    const matrix = spectrogramMatrix(frames, 3, 2)
    assert.equal(matrix.length, 3)
    assert.equal(matrix[0], null, '最左边是空的（还没有那么早的帧）')
    assert.equal(matrix[1], null)
    assert.ok(Array.isArray(matrix[2]), '最新的一帧在最右')
    // 帧比列多时只留最近的。
    const many = Array.from({ length: 10 }, (_, index) => [index])
    assert.equal(spectrogramMatrix(many, 3, 1).length, 3)
    assert.deepEqual(spectrogramMatrix([], CAMERA_CELL_SPECTROGRAM_COLUMNS, CAMERA_CELL_SPECTRUM_ROWS)[0], null)
  })

  it('色标：两端与越界都夹住，而且 0 与 1 明显不同', () => {
    const low = spectrogramColor(0)
    const high = spectrogramColor(1)
    assert.notDeepEqual(low, high)
    assert.deepEqual(spectrogramColor(-5), low)
    assert.deepEqual(spectrogramColor(9), high)
    for (const value of [0.25, 0.5, 0.75]) {
      const [r, g, b] = spectrogramColor(value)
      for (const channel of [r, g, b]) {
        assert.ok(Number.isInteger(channel) && channel >= 0 && channel <= 255, String(channel))
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 2. 哪些源支持哪些视图
// ---------------------------------------------------------------------------

describe('哪些源支持哪些视图', () => {
  it('相机四种都有；手填 RTSP 只有画面（**它连设备都不是**）', () => {
    assert.deepEqual([...availableCellViews('camera')], [...CAMERA_CELL_VIEW_MODES])
    assert.deepEqual([...availableCellViews('manual-rtsp')], ['play'])
    assert.equal(availableCellViews('camera').length, 4)
    // 切不了时给出的**原因键**（界面据此说明，而不是给一个点了没反应的按钮）。
    assert.equal(cellViewRefusalKey('manual-rtsp', 'spectrum'), 'cameraWallUi.viewNeedsCamera')
    assert.equal(cellViewRefusalKey('camera', 'spectrum'), null)
    assert.equal(cellViewRefusalKey('camera', 'play'), null)
  })

  it('视图与相机通道的对应关系只有一处定义', () => {
    assert.equal(CAMERA_CELL_VIEW_STREAM.play, null, '播放走 RTSP + ffmpeg，与声学预览无关')
    assert.equal(CAMERA_CELL_VIEW_STREAM.timedomain, 'pcmData')
    assert.equal(CAMERA_CELL_VIEW_STREAM.spectrum, 'fftData')
    assert.equal(CAMERA_CELL_VIEW_STREAM.spectrogram, 'fftData')
  })

  it('四种视图的名字四语言齐全，键也只有四个', () => {
    assert.equal(Object.keys(CAMERA_CELL_VIEW_KEYS).length, 4)
    for (const locale of ['zh-CN', 'en', 'es', 'tr']) {
      const catalogue = messages(locale)
      for (const mode of CAMERA_CELL_VIEW_MODES) {
        const key = CAMERA_CELL_VIEW_KEYS[mode]!.split('.')[1]!
        const value = catalogue[key]
        assert.equal(typeof value, 'string', `${locale} 缺 ${key}`)
        assert.ok(String(value).trim() !== '', `${locale} 的 ${key} 是空的`)
      }
    }
    // 中文那四个就是业主给的说法。
    const zh = messages('zh-CN')
    assert.equal(zh.viewPlay, '播放')
    assert.equal(zh.viewTimedomain, '1 秒时域图')
    assert.equal(zh.viewSpectrum, '频域图')
    assert.equal(zh.viewSpectrogram, '时频谱图')
    // 色标那句说明必须**写进界面**（手册未说明色标，不能让人以为颜色 = 声压级）。
    assert.ok(String(zh.viewSpectrogramNote).includes('相对强弱'))
  })

  it('`isCameraCellViewMode` 只认这四个', () => {
    for (const mode of CAMERA_CELL_VIEW_MODES) assert.equal(isCameraCellViewMode(mode), true)
    for (const bad of ['', 'video', 'fft', null, 3]) assert.equal(isCameraCellViewMode(bad), false)
  })
})

// ---------------------------------------------------------------------------
// 3. 模型
// ---------------------------------------------------------------------------

const CAM = 'dev-camera-1'
const MANUAL = `rtsp:${'ab'.repeat(16)}`

function modelWith(getManual = true): CameraWallModel {
  const base: CameraWallModel = {
    ...createCameraWallModel(4),
    slots: [CAM, MANUAL, null, null],
    manualSources: getManual
      ? [{ id: MANUAL, name: '大门', url: 'rtsp://10.0.0.9/live' }]
      : []
  }
  return base
}

describe('墙的模型：视图逐格保存', () => {
  it('默认全是播放；设过之后逐格生效', () => {
    let model = modelWith()
    assert.deepEqual(cellViewsOf(model), ['play', 'play', 'play', 'play'])
    model = setCameraCellView(model, 0, 'spectrogram')
    assert.deepEqual(cellViewsOf(model), ['spectrogram', 'play', 'play', 'play'])
    assert.equal(cellViewsOf(model).length, 4, '长度永远与格数一致')
  })

  it('空格与"不支持的视图"都被拒（手填 RTSP 切不到频域图）', () => {
    const model = modelWith()
    assert.equal(setCameraCellView(model, 2, 'spectrum'), model, '空格切不了')
    assert.equal(setCameraCellView(model, 1, 'spectrum'), model, '手填源只有画面')
    assert.equal(setCameraCellView(model, 9, 'spectrum'), model, '越界')
    assert.equal(setCameraCellView(model, 0, 'nope' as never), model, '不认识的视图')
    // 相机那一格可以。
    assert.notEqual(setCameraCellView(model, 0, 'spectrum'), model)
    assert.deepEqual([...cellViewsFor(model, 0)], [...CAMERA_CELL_VIEW_MODES])
    assert.deepEqual([...cellViewsFor(model, 1)], ['play'])
  })

  it('换源时视图**回落成播放**（那是上一台的画法选择）', () => {
    let model = setCameraCellView(modelWith(), 0, 'timedomain')
    // 把 0 号格换成另一台相机：视图必须回默认。
    model = assignCamera(model, 0, 'dev-camera-2').model
    assert.equal(cellViewsOf(model)[0], 'play')
    // 换到"手填源"上更是如此（它压根没有那三种视图）。
    model = assignCamera(setCameraCellView(model, 0, 'spectrum'), 0, MANUAL).model
    assert.equal(cellViewsOf(model)[0], 'play')
  })

  it('清格 / 换档位时视图一起清掉（不然下次放大档位会"复活"到别的格上）', () => {
    let model = setCameraCellView(modelWith(), 0, 'spectrum')
    model = clearCameraCell(model, 0)
    assert.equal(model.views?.[0] ?? null, null)
    assert.deepEqual(cellViewsOf(model), ['play', 'play', 'play', 'play'])

    // 换档位：被挤掉的格子的视图必须一起消失。
    let small = setCameraCellView(modelWith(), 0, 'spectrum')
    small = { ...small, slots: [CAM, MANUAL, null, 'dev-camera-2'] }
    small = setCameraCellView(small, 3, 'timedomain')
    assert.deepEqual(cellViewsOf(small), ['spectrum', 'play', 'play', 'timedomain'])
    const shrunk = setCameraWallLayout(small, 1)
    assert.equal(shrunk.model.views?.length, 1)
    assert.equal(cellViewsOf(shrunk.model)[0], 'spectrum')
    // 再放大回去：第 4 格那一个 `timedomain` **不许**回来。
    const grown = setCameraWallLayout(shrunk.model, 4)
    assert.deepEqual(cellViewsOf(grown.model), ['spectrum', 'play', 'play', 'play'])
  })

  it('规范化：坏值/空格上的视图被清成播放，缺 `views` 就是全播放', () => {
    const normalised = normaliseCameraWallModel({
      layout: 4,
      slots: [CAM, null, null, null],
      audioSlot: null,
      activeSlot: 0,
      views: ['spectrogram', 'spectrum', 'nope', 7]
    })
    assert.deepEqual(cellViewsOf(normalised), ['spectrogram', 'play', 'play', 'play'])
    assert.equal(cellViewsOf({ ...normalised, views: undefined })[0], 'play')
  })

  it('渲染模型每一格都带着自己的视图与"支持哪些"', () => {
    const model = setCameraCellView(modelWith(), 0, 'spectrum')
    const cells = buildCameraCells(model, {
      devices: [
        {
          id: CAM,
          deviceUid: 'uid-cam',
          kind: 'acousticCamera',
          name: '相机 A',
          connectionType: 'LAN',
          status: 'ONLINE',
          createdAt: 1,
          updatedAt: 1
        }
      ],
      states: {},
      maxStreams: 4
    })
    assert.equal(cells[0]?.view, 'spectrum')
    assert.equal(cells[0]?.sourceKind, 'camera')
    assert.deepEqual([...cells[0]!.availableViews], [...CAMERA_CELL_VIEW_MODES])
    assert.equal(cells[1]?.sourceKind, 'manual-rtsp')
    assert.deepEqual([...cells[1]!.availableViews], ['play'])
    assert.equal(cells[2]?.sourceKind, 'empty')
    assert.equal(cells[2]?.view, 'play')
  })
})

// ---------------------------------------------------------------------------
// 4. 接线（源码守卫）
// ---------------------------------------------------------------------------

describe('接线（源码守卫）', () => {
  it('墙把图交给 `CameraCellChart`，而"播放"仍然走 `<video>`', () => {
    const wall = read('src/renderer/src/components/CameraVideoWall.vue')
    assert.match(
      wall,
      /v-if="cell\.view === 'play' && cell\.url && isCameraCellLive\(cell\.status\)"/,
      '播放那一支没有按视图判'
    )
    assert.match(
      wall,
      /v-else-if="cell\.view !== 'play' && cell\.deviceId"/,
      '图表格没有接上 CameraCellChart'
    )
    /*
     * 四颗视图按钮的入口**在第 12 批之后是右键菜单的「显示方式」**（业主：
     * 「播放器窗口应该只有告警，全屏，暂停，切换录像，音量，手动录像」）。
     * 所以这里守的是：菜单模型的四个动作都在，而墙对它们**各有一条派发分支**
     * （少一条就是"点了没反应"）。
     */
    assert.match(wall, /case 'view-spectrum':\s*\n\s*chooseCellView\(cell, 'spectrum'\)/, '菜单里的「频域图」没有派发分支')
    assert.match(wall, /cellView: cell\.view/, '菜单环境里没有这一格此刻的视图（✓ 打不出来）')
    assert.match(wall, /availableViews: cell\.availableViews/, '菜单环境里没有"这一格支持哪些视图"')
    assert.match(wall, /charts\.dispose\(\)/, '离开页面没有停掉声学预览订阅')
  })

  it('图表组件：四种视图各自的画法与三条口径的说明都在', () => {
    const chart = read('src/renderer/src/components/CameraCellChart.vue')
    for (const hook of ['data-cell-chart', 'data-cell-chart-empty', 'data-cell-chart-axis', 'data-cell-chart-note']) {
      assert.ok(chart.includes(hook), `图表组件缺 ${hook}`)
    }
    assert.match(chart, /drawWaveform\(/, '没有时域图')
    assert.match(chart, /drawSpectrum\(/, '没有频域图')
    assert.match(chart, /drawSpectrogram\(/, '没有时频谱图')
    assert.match(chart, /spectrumAxisLabels\(/, '频域图的轴没有按"有没有 binHz"判')
    assert.match(chart, /spectrogramColor\(/, '时频谱图没有用共享的色标')
    assert.match(chart, /requestAnimationFrame/, '每一帧都同步重画（没有合并）')
    // 订阅的收放：离开时放开（相机连接数有限）。
    assert.match(chart, /charts\.release\(/, '离开时没有放开声学通道')
  })

  it('订阅按**设备**合并（同一台设备多条图表格共享一次 start）', () => {
    const store = read('src/renderer/src/stores/cameraCellCharts.ts')
    assert.match(store, /kinds\.includes\(kind\)/, '没有"已经订过就跳过"')
    assert.match(store, /const kinds = \[\.\.\.\(current\?\.kinds \?\? \[\]\), kind\]/, '没有把 kinds 合并')
    assert.match(store, /fa371Stream\.start\(\{ deviceId, kinds \}\)/, '没有按设备下一次 start')
    assert.match(store, /fa371Stream\.stop\(deviceId\)/, '最后一份订阅释放时没有停掉会话')
    assert.match(store, /CAMERA_CELL_WAVEFORM_FRAMES/, 'PCM 缓冲没有上限（会漏内存）')
    assert.match(store, /CAMERA_CELL_SPECTROGRAM_COLUMNS/, 'FFT 缓冲没有上限（会漏内存）')
  })

  it('手填 RTSP 那一格只有画面，而且原因写在界面上', () => {
    /*
     * 第 12 批之后这句话在**菜单**里：`buildCameraNvrMenu()` 为"这一格不支持的那几种视图"
     * 给出 `disabledReasonKey: cameraWallUi.viewNeedsCamera`，菜单把它渲染成灰项下面那行原因
     * （`VideoContextMenu` 的 `.vmenu__reason`）。控制条上不再有视图按钮，所以墙里那句
     * `t('cameraWallUi.viewNeedsCamera')` 也跟着搬进了共享层的菜单模型。
     */
    const nvr = read('src/shared/domain/camera-nvr.ts')
    assert.match(
      nvr,
      /disabledReasonKey: 'cameraWallUi\.viewNeedsCamera'/,
      '手填源的"只有画面"没有在「显示方式」菜单里说明'
    )
    const wall = read('src/renderer/src/components/CameraVideoWall.vue')
    assert.match(wall, /availableViews: cell\.availableViews/, '墙没有把"这一格支持哪些视图"告诉菜单')
  })
})
