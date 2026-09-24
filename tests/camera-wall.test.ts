/**
 * 多路视频墙模型的回归测试。
 *
 * WHY THIS FILE EXISTS
 * 「多路视频」这件事的难点不在画面，而在算数：
 *   - **同一内容不能出现在两格里**（业主 2026-09-21 批）：墙上一格的身份是
 *     (源 id, 视图)，同一台相机的画面与时域图是两种内容、允许各占一格，
 *     同一个 (id, view) 全墙唯一，重复放置 = 移动；三条入口（双击、拖拽、
 *     下拉）必须落到同一个判定上；
 *   - 本机的并发预算是有限的（每路一个 ffmpeg + 一个回环服务），**超过上限的
 *     那一路必须被明确拒绝**，而不是先起一路再失败；
 *   - 换档位变小、删设备、设备离线时，**不能留下指向死设备的格子**；
 *   - 声音全局至多一格；
 *   - 放不进窗口的内容进**轮询队列**，`rotateWallOnce()` 逐格轮换、被轮走的
 *     排到队尾，而不是被丢弃。
 * 这些判断全部住在 `src/renderer/src/lib/cameraWall.ts`（纯函数、零运行时依赖），
 * 所以它们能在没有浏览器的情况下被直接断言 —— 本文件只测它，不测 Vue 模板。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  CAMERA_CELL_STATUSES,
  CAMERA_CELL_STATUS_KEYS,
  CAMERA_PICKER_GAP,
  CAMERA_WALL_LAYOUTS,
  DEFAULT_CAMERA_WALL_LAYOUT,
  activeCameraStreams,
  assignCamera,
  buildCameraCells,
  cameraCellCount,
  cameraCellStartPermission,
  cameraWallColumns,
  cameraWallSummary,
  cellViewAt,
  cellViewSwitchPermission,
  cellViewsOf,
  clearCameraCell,
  clearCameraDevice,
  createCameraWallModel,
  enqueueWallItem,
  findCameraSlot,
  findWallItem,
  focusSlotForDevice,
  isCameraWallLayout,
  isWallCapableDevice,
  normaliseCameraWallModel,
  placeCameraPicker,
  removeDeviceFromWall,
  removeIdFromQueue,
  rotateWallOnce,
  setActiveSlot,
  setAudioSlot,
  setCameraWallLayout,
  toggleAudioSlot,
  type CameraWallModel
} from '../src/renderer/src/lib/cameraWall'
import { layoutIconGeometry } from '../src/renderer/src/lib/layoutIcon'
import { cameraStreamLimitMessage, cameraStreamLimitReached } from '../src/shared/domain/camera-live'
import type { CameraLiveState } from '../src/shared/domain/camera-live'
import { buildCameraNvrMenu, type CameraNvrEnvironment } from '../src/shared/domain/camera-nvr'
import { FA371_RESULT_FILE_KINDS } from '../src/shared/domain/fa371'
import { EVENT_DOWNLOAD_STAGES } from '../src/shared/domain/event-center'
import { LOCALES } from '../src/shared/i18n/locales'
import { zhCN } from '../src/shared/i18n/messages/zh-CN'
import { en } from '../src/shared/i18n/messages/en'
import { es } from '../src/shared/i18n/messages/es'
import { tr } from '../src/shared/i18n/messages/tr'
import { ru } from '../src/shared/i18n/messages/ru'
import { zhTW } from '../src/shared/i18n/messages/zh-TW'
import type { Device } from '../src/shared/domain/models'

// ---------------------------------------------------------------------------
// 目录：把某个语言摊平成 `a.b.c -> 文案`
// ---------------------------------------------------------------------------

const CATALOGUES: Record<string, Record<string, unknown>> = {
  'zh-CN': zhCN as unknown as Record<string, unknown>,
  'zh-TW': zhTW as unknown as Record<string, unknown>,
  en: en as unknown as Record<string, unknown>,
  es: es as unknown as Record<string, unknown>,
  tr: tr as unknown as Record<string, unknown>,
  ru: ru as unknown as Record<string, unknown>
}

/** 摊平一份目录（`a.b.c -> 文案`），用于「这个键在四种语言里都存在」这类断言。 */
function flattenCatalogue(locale: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (source: Record<string, unknown>, prefix: string): void => {
    for (const [key, value] of Object.entries(source)) {
      const path = prefix === '' ? key : `${prefix}.${key}`
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        walk(value as Record<string, unknown>, path)
      } else {
        out.set(path, String(value))
      }
    }
  }
  walk(CATALOGUES[locale] ?? {}, '')
  return out
}

// ---------------------------------------------------------------------------
// 夹俱
// ---------------------------------------------------------------------------

function camera(id: string, status: Device['status'] = 'ONLINE'): Device {
  return {
    id,
    deviceUid: `uid-${id}`,
    kind: 'acousticCamera',
    name: `相机 ${id}`,
    connectionType: 'LAN',
    status,
    createdAt: 0,
    updatedAt: 0
  }
}

/** 声纹设备：有 8 路音频通道，但**没有** RTSP 视频。 */
function box(id: string): Device {
  return {
    id,
    deviceUid: `uid-${id}`,
    kind: 'acousticBox',
    name: `声纹设备 ${id}`,
    connectionType: 'LAN',
    status: 'ONLINE',
    createdAt: 0,
    updatedAt: 0
  }
}

function liveState(
  deviceId: string,
  status: CameraLiveState['status'],
  extra: Partial<CameraLiveState> = {}
): CameraLiveState {
  return { deviceId, status, ...extra }
}

/** 一个 4 格、装满四台相机的模型。 */
function fullWall(): CameraWallModel {
  let model = createCameraWallModel(4)
  for (let index = 0; index < 4; index += 1) {
    model = assignCamera(model, index, `cam-${index + 1}`).model
  }
  return model
}

// ---------------------------------------------------------------------------
// 档位与槽位
// ---------------------------------------------------------------------------

describe('视频墙的档位与画面格数', () => {
  it('给出 1 / 4 / 9 / 16 四档（安防标准四档，9 是 3×3）', () => {
    // 产品负责人明确要求：9 分屏取代原来的 8 分屏（iVMS-4200 的默认视图也是
    // 1 / 4 / 9 / 16 这四套，见 docs/Ivms4200-UX-REFERENCE.md §1.1）。
    assert.deepEqual([...CAMERA_WALL_LAYOUTS], [1, 4, 9, 16])
  })

  it('档位就是槽位数，每行格数按 1 / 2 / 3 / 4 排', () => {
    assert.equal(cameraCellCount(1), 1)
    assert.equal(cameraCellCount(4), 4)
    assert.equal(cameraCellCount(9), 9)
    assert.equal(cameraCellCount(16), 16)
    assert.equal(cameraWallColumns(1), 1)
    assert.equal(cameraWallColumns(4), 2)
    assert.equal(cameraWallColumns(9), 3)
    assert.equal(cameraWallColumns(16), 4)
    // 列数必须整除槽位数，否则最后一行会缺一块 —— 9 分屏最容易被写成 4 列。
    for (const layout of CAMERA_WALL_LAYOUTS) {
      assert.equal(
        cameraCellCount(layout) % cameraWallColumns(layout),
        0,
        `${layout} 档的列数不整除`
      )
    }
  })

  it('默认档位是 4，且只有合法档位被接受', () => {
    assert.equal(DEFAULT_CAMERA_WALL_LAYOUT, 4)
    assert.equal(isCameraWallLayout(4), true)
    assert.equal(isCameraWallLayout(9), true)
    // 旧的 8 档已经不再是视频墙的合法档位（它现在是通道墙的）。
    assert.equal(isCameraWallLayout(8), false)
    assert.equal(isCameraWallLayout('4'), false)
    assert.equal(isCameraWallLayout(undefined), false)
  })

  it('新建的模型每个槽位都是空的，没有任何相机', () => {
    const model = createCameraWallModel(16)
    assert.equal(model.slots.length, 16)
    assert.equal(model.slots.every((slot) => slot === null), true)
    assert.equal(model.audioSlot, null)
    assert.equal(model.activeSlot, 0)
  })

  it('来自 localStorage 的坏档位/坏槽位被修补成合法模型', () => {
    const broken = normaliseCameraWallModel({
      layout: 7,
      slots: ['cam-1', 42, '', null, 'cam-2'],
      audioSlot: 99,
      activeSlot: -3
    })
    assert.equal(broken.layout, DEFAULT_CAMERA_WALL_LAYOUT)
    assert.equal(broken.slots.length, 4)
    assert.deepEqual(broken.slots, ['cam-1', null, null, null])
    // 悬空的出声/当前格索引必须回落，否则界面会出现「没声音但徽标亮着」。
    assert.equal(broken.audioSlot, null)
    assert.equal(broken.activeSlot, 0)
    // 旧版本存下来的 8 档（本轮被 9 取代）同样回落到默认档：界面上不能出现一个
    // 既画不出 8 格、也不在任何档位列表里的墙。
    assert.equal(normaliseCameraWallModel({ layout: 8 }).layout, DEFAULT_CAMERA_WALL_LAYOUT)
  })
})

// ---------------------------------------------------------------------------
// 格子分配：一格的身份是 (源 id, 视图)
// ---------------------------------------------------------------------------

describe('格子分配', () => {
  it('把相机放进某一格，空格子仍然留空', () => {
    const model = assignCamera(createCameraWallModel(4), 2, 'cam-1')
    assert.equal(model.changed, true)
    assert.deepEqual(model.model.slots, [null, null, 'cam-1', null])
    assert.equal(model.movedFrom, null)
    assert.equal(model.evicted, null, '空格没有可交出去的内容')
    // 缺省视图 = 播放（有效视图口径，null 与 'play' 一回事）。
    assert.equal(cellViewAt(model.model, 2), 'play')
  })

  it('同一 (id, 视图) 放进第二格时是**移动**，不是出现两格', () => {
    let model = assignCamera(createCameraWallModel(4), 0, 'cam-1').model
    const second = assignCamera(model, 3, 'cam-1')
    model = second.model
    assert.equal(second.movedFrom, 0)
    assert.deepEqual(model.slots, [null, null, null, 'cam-1'])
    // 无论走哪条入口，同一 (id, 播放) 在模型里只有一个位置。
    assert.equal(
      model.slots.filter((slot, index) => slot === 'cam-1' && cellViewAt(model, index) === 'play')
        .length,
      1
    )
  })

  it('同一台相机**不同视图**各占一格：两种内容可以共存', () => {
    let model = assignCamera(createCameraWallModel(4), 0, 'cam-1').model
    const placed = assignCamera(model, 2, 'cam-1', 'spectrum')
    model = placed.model
    assert.deepEqual(model.slots, ['cam-1', null, 'cam-1', null])
    assert.equal(cellViewAt(model, 0), 'play')
    assert.equal(cellViewAt(model, 2), 'spectrum')
    // 这是新增共存，不是移动：没有源格被清空。
    assert.equal(placed.movedFrom, null)
    assert.equal(placed.evicted, null)
  })

  it('别格已有同 (id, 视图) 时放进来 = 移动那一格，其它视图的格原样保留', () => {
    let model = assignCamera(createCameraWallModel(4), 0, 'cam-1').model
    model = assignCamera(model, 1, 'cam-1', 'spectrum').model
    // 再把 (cam-1, 播放) 放到第 3 格：播放那一格移动，spectrum 那一格不动。
    const moved = assignCamera(model, 3, 'cam-1')
    assert.equal(moved.movedFrom, 0)
    assert.deepEqual(moved.model.slots, [null, 'cam-1', null, 'cam-1'])
    assert.equal(cellViewAt(moved.model, 1), 'spectrum')
    assert.equal(cellViewAt(moved.model, 3), 'play')
  })

  it('放进来的视图就是目标视图，不再是"一律回默认"', () => {
    let model = createCameraWallModel(4)
    model = assignCamera(model, 0, 'cam-1', 'timedomain').model
    assert.equal(cellViewAt(model, 0), 'timedomain')
    // 缺省（双击/拖拽）仍是播放。
    model = assignCamera(model, 1, 'cam-2').model
    assert.equal(cellViewAt(model, 1), 'play')
  })

  it('替换覆盖时如实交出 evicted（本格原来的内容），空格则没有', () => {
    let model = createCameraWallModel(4)
    model = assignCamera(model, 0, 'cam-1', 'spectrum').model
    const replaced = assignCamera(model, 0, 'cam-2')
    assert.deepEqual(replaced.evicted, { id: 'cam-1', view: 'spectrum' })
    // 移动同样可能挤掉目标格原有内容：两份都如实报。
    const full = assignCamera(createCameraWallModel(4), 1, 'cam-9').model
    const movedOnto = assignCamera(full, 1, 'cam-1')
    assert.equal(movedOnto.evicted?.id, 'cam-9')
    assert.equal(movedOnto.evicted?.view, 'play')
    // 空格落子：没有 evicted。
    assert.equal(assignCamera(createCameraWallModel(4), 2, 'cam-1').evicted, null)
  })

  it('放进同一格同一个视图是幂等的（不产生「改动」）', () => {
    const model = assignCamera(createCameraWallModel(4), 1, 'cam-1').model
    const again = assignCamera(model, 1, 'cam-1')
    assert.equal(again.changed, false)
    assert.equal(again.model, model)
  })

  it('越界格号或空设备 id 一律拒绝，且不修改模型', () => {
    const model = createCameraWallModel(4)
    assert.equal(assignCamera(model, -1, 'cam-1').changed, false)
    assert.equal(assignCamera(model, 4, 'cam-1').changed, false)
    assert.equal(assignCamera(model, 0, '').changed, false)
    assert.equal(assignCamera(model, -1, 'cam-1').evicted, null)
  })

  it('移动内容时出声标记跟着走，不会留在原来的空格上', () => {
    let model = assignCamera(createCameraWallModel(4), 0, 'cam-1').model
    model = setAudioSlot(model, 0)
    const moved = assignCamera(model, 2, 'cam-1').model
    assert.equal(moved.slots[0], null)
    assert.equal(moved.slots[2], 'cam-1')
    assert.equal(moved.audioSlot, 2)
  })

  it('findCameraSlot 回答「这台相机在第几格」（同 id 第一个格号）；findWallItem 按 (id, 视图) 精确找', () => {
    let model = fullWall()
    assert.equal(findCameraSlot(model, 'cam-3'), 2)
    assert.equal(findCameraSlot(model, 'cam-9'), -1)
    assert.equal(findCameraSlot(model, ''), -1)
    // 一台相机两格：findWallItem 按视图区分，findCameraSlot 给第一个。
    model = assignCamera(model, 0, 'cam-3', 'spectrum').model
    assert.equal(findWallItem(model, 'cam-3', 'play'), 2)
    assert.equal(findWallItem(model, 'cam-3', 'spectrum'), 0)
    assert.equal(findWallItem(model, 'cam-3', 'timedomain'), -1)
    assert.equal(findWallItem(model, '', 'play'), -1)
  })

  it('cellViewAt 把坏值/缺省回落成播放；合法值原样给出（与 cellViewsOf 同一口径）', () => {
    const model = {
      layout: 4,
      slots: ['cam-1', 'cam-2', null, null],
      audioSlot: null,
      activeSlot: 0,
      views: ['nope', 'spectrum', undefined, null]
    } as unknown as CameraWallModel
    assert.equal(cellViewAt(model, 0), 'play', '坏值按默认算')
    assert.equal(cellViewAt(model, 1), 'spectrum', '合法值原样给出')
    assert.equal(cellViewAt(model, 2), 'play', '缺席按默认算')
    assert.deepEqual(cellViewsOf(model), ['play', 'spectrum', 'play', 'play'])
    // 空格上的视图由 normalise 清掉（坏输入修成永远合法的模型），cellViewAt 只回答"有效视图"。
    const normalised = normaliseCameraWallModel(model)
    assert.equal(cellViewAt(normalised, 2), 'play')
  })

  it('cellViewSwitchPermission：同 (id, 视图) 已在别格时拒绝，其余放行', () => {
    let model = createCameraWallModel(4)
    model = assignCamera(model, 0, 'cam-1').model
    model = assignCamera(model, 1, 'cam-1', 'spectrum').model
    // 第 2 格放 cam-1：播放与 spectrum 都已被占，切这两个被拒。
    model = assignCamera(model, 2, 'cam-1', 'timedomain').model
    assert.equal(cellViewSwitchPermission(model, 2, 'play'), 'already-shown')
    assert.equal(cellViewSwitchPermission(model, 2, 'spectrum'), 'already-shown')
    assert.equal(cellViewSwitchPermission(model, 2, 'timedomain'), null, '切自己现在那个不算重复')
    assert.equal(cellViewSwitchPermission(model, 2, 'spectrogram'), null)
    // 本格已是目标视图时也不拒（同格同视图 = 没动）。
    assert.equal(cellViewSwitchPermission(model, 1, 'spectrum'), null)
    // 空格与越界：没有可切的源，交给 setCameraCellView 拒，permission 不报重复。
    assert.equal(cellViewSwitchPermission(model, 3, 'play'), null)
    assert.equal(cellViewSwitchPermission(model, 99, 'play'), null)
  })

  it('双击一台相机：它的播放已在墙上就回到那一格，否则落在空格', () => {
    const model = assignCamera(createCameraWallModel(4), 2, 'cam-2').model
    assert.equal(focusSlotForDevice(model, 'cam-2'), 2)
    // 一台全新的相机落在第一个空格（第 1 格），而不是追到最后一格。
    assert.equal(focusSlotForDevice(model, 'cam-9'), 0)
    // 「当前格」是空的时优先用当前格（操作员刚点过的那一格）。
    assert.equal(focusSlotForDevice(setActiveSlot(model, 3), 'cam-9'), 3)
    // 当前格被占、后面还有空格时，落点是第一个空格而不是当前格。
    const busyFirst = assignCamera(model, 0, 'cam-5').model
    assert.equal(focusSlotForDevice(setActiveSlot(busyFirst, 0), 'cam-9'), 1)
    // 三个判断互不修改模型（纯函数）。
    assert.deepEqual(model.slots, [null, null, 'cam-2', null])

    const filled = fullWall()
    // 全满时落在当前格（替换），而不是越界或静默失败。
    assert.equal(focusSlotForDevice(filled, 'cam-9'), filled.activeSlot)
    // 槽位里躺着一台已经不在设备列表里的相机：优先替换它，而不是替换一台真的
    // 在线的相机。
    const stale = assignCamera(createCameraWallModel(1), 0, 'gone').model
    assert.equal(focusSlotForDevice(stale, 'cam-1', ['cam-1', 'cam-2']), 0)
    assert.equal(focusSlotForDevice(fullWall(), 'cam-1', ['cam-1']), 0)
  })

  it('相机的播放已在墙上、图也在墙上：双击仍然落在**播放**那一格', () => {
    let model = createCameraWallModel(4)
    model = assignCamera(model, 1, 'cam-1').model
    model = assignCamera(model, 3, 'cam-1', 'spectrogram').model
    assert.equal(focusSlotForDevice(model, 'cam-1'), 1)
  })

  it('相机比格子多：多出来的那几台不会被硬塞进某一格', () => {
    let model = createCameraWallModel(4)
    // 先用 4 台把 4 格装满。
    for (let index = 1; index <= 4; index += 1) {
      const target = focusSlotForDevice(model, `cam-${index}`)
      model = assignCamera(model, target, `cam-${index}`).model
    }
    assert.equal(model.slots.filter((slot) => slot !== null).length, 4)

    // 第 5、6 台相机没有空格可放：全满时落点是**当前格**（替换），
    // 而不是静默失败，也不是越界写进数组之外。
    const fifth = focusSlotForDevice(model, 'cam-5')
    assert.equal(fifth, model.activeSlot)
    model = assignCamera(model, fifth, 'cam-5').model
    assert.equal(findCameraSlot(model, 'cam-4'), -1, '被替换掉的那一台不再在墙上')
    assert.equal(findCameraSlot(model, 'cam-5'), fifth)

    // 无论怎么分配，墙上永远不会有超过 4 格，也不会有两个相同的 (id, 播放)。
    assert.equal(model.slots.filter((slot) => slot !== null).length, 4)
    assert.equal(new Set(model.slots.filter((slot) => slot !== null)).size, 4)
  })
})

// ---------------------------------------------------------------------------
// 并发上限
// ---------------------------------------------------------------------------

describe('并发上限（超过并发上限）', () => {
  it('上限判断是「已达上限即拒绝」，不是「超过才拒绝」', () => {
    assert.equal(cameraStreamLimitReached(3, 4), false)
    assert.equal(cameraStreamLimitReached(4, 4), true)
    assert.equal(cameraStreamLimitReached(5, 4), true)
    assert.equal(cameraStreamLimitReached(0, 1), false)
    assert.equal(cameraStreamLimitReached(1, 1), true)
  })

  it('说清楚上限是几、当前几路、该怎么办', () => {
    const message = cameraStreamLimitMessage(4, 4)
    assert.match(message, /4/)
    assert.match(message, /停止/)
  })

  it('这一格能不能开始：超预算时给出 limit-exceeded，而不是开始', () => {
    const model = createCameraWallModel(4)
    const allowed = cameraCellStartPermission(model, 0, 'cam-1', 3, 4)
    assert.equal(allowed.allowed, true)
    assert.equal(allowed.refusal, null)

    const refused = cameraCellStartPermission(model, 0, 'cam-1', 4, 4)
    assert.equal(refused.allowed, false)
    assert.equal(refused.refusal, 'limit-exceeded')
  })

  it('同一内容的播放已在别格时拒绝的原因是 already-shown，与预算无关', () => {
    const model = assignCamera(createCameraWallModel(4), 0, 'cam-1').model
    const refused = cameraCellStartPermission(model, 2, 'cam-1', 0, 4)
    assert.equal(refused.allowed, false)
    assert.equal(refused.refusal, 'already-shown')
    // 目标格自己就是那一个播放格：不算"别格已有"。
    const same = cameraCellStartPermission(model, 0, 'cam-1', 0, 4)
    assert.equal(same.allowed, true)
    assert.equal(same.refusal, null)
  })

  it('同一台相机的**图**不占 RTSP 会话：chart 格与播放格互不争用', () => {
    let model = createCameraWallModel(4)
    model = assignCamera(model, 0, 'cam-1').model
    model = assignCamera(model, 1, 'cam-1', 'spectrum').model
    // cam-1 的播放已在第 0 格：别的格再放 cam-1 的**播放**仍被拒（两路 ffmpeg 会互顶）。
    const playDup = cameraCellStartPermission(model, 2, 'cam-1', 0, 4)
    assert.equal(playDup.allowed, false)
    assert.equal(playDup.refusal, 'already-shown')
    // 但第 1 格那个 spectrum 本身起不了流（它是图），也不挡别的格起 cam-1 ——
    // 同一台相机的图 + 画面是两种内容，允许同时存在。
    const chartCell = cameraCellStartPermission(model, 1, 'cam-1', 0, 4)
    assert.equal(chartCell.allowed, true, 'chart 视图不占会话，不该按 already-shown 拒')
    // 预算照常是另一条独立的线：满了照样拒。
    const limited = cameraCellStartPermission(model, 2, 'cam-2', 4, 4)
    assert.equal(limited.allowed, false)
    assert.equal(limited.refusal, 'limit-exceeded')
  })

  it('渲染模型里：chart 视图与别格的播放共存时不再报 already-shown', () => {
    let model = createCameraWallModel(4)
    model = assignCamera(model, 0, 'cam-1').model
    model = assignCamera(model, 1, 'cam-1', 'spectrum').model
    const cells = buildCameraCells(model, {
      devices: [camera('cam-1')],
      states: { 'cam-1': liveState('cam-1', 'playing', { url: 'http://127.0.0.1:9/t/stream.mp4' }) },
      maxStreams: 4
    })
    assert.equal(cells[0]?.status, 'playing')
    // 第 1 格是 spectrum 视图：与第 0 格的播放是两种内容，不该报"已在别格"。
    assert.notEqual(cells[1]?.status, 'already-shown')
  })

  it('数占用只看 starting/playing，不看空格与失败格', () => {
    const model = fullWall()
    const cells = buildCameraCells(model, {
      devices: [camera('cam-1'), camera('cam-2'), camera('cam-3'), camera('cam-4')],
      states: {
        'cam-1': liveState('cam-1', 'playing', { url: 'http://127.0.0.1:1/a/stream.mp4' }),
        'cam-2': liveState('cam-2', 'starting'),
        'cam-3': liveState('cam-3', 'error', { error: 'ffmpeg 退出码 1' }),
        'cam-4': liveState('cam-4', 'limit-exceeded', { error: cameraStreamLimitMessage(4, 4) })
      },
      maxStreams: 4
    })
    assert.equal(activeCameraStreams(cells), 2)
    const summary = cameraWallSummary(model, cells, 4)
    assert.equal(summary.assigned, 4)
    assert.equal(summary.active, 2)
    assert.equal(summary.limited, 1)
    assert.equal(summary.failed, 1)
    assert.equal(summary.max, 4)
  })

  it('主进程报的 limit-exceeded 原样成为格子状态，不被折进 error', () => {
    const model = assignCamera(createCameraWallModel(1), 0, 'cam-1').model
    const cells = buildCameraCells(model, {
      devices: [camera('cam-1')],
      states: {
        'cam-1': liveState('cam-1', 'limit-exceeded', { error: '已达到同时直播上限' })
      },
      maxStreams: 4
    })
    assert.equal(cells[0]?.status, 'limit-exceeded')
    assert.equal(cells[0]?.messageKey, 'cameraWallUi.statusLimitExceeded')
    // 主进程的原文（含具体数字）优先于通用文案。
    assert.equal(cells[0]?.messageText, '已达到同时直播上限')
    assert.equal(cells[0]?.url, undefined)
  })
})

// ---------------------------------------------------------------------------
// 每一格的状态都是具体的
// ---------------------------------------------------------------------------

describe('格子的诚实状态', () => {
  it('空白格一个字的模型文案都没有，也不是一块黑矩形', () => {
    // 产品把空白格简化成右侧一个大 `+`（见 `CameraVideoWall.vue`），所以这一格
    // **没有**短状态词、没有提示句：`messageKey` 是 `undefined`，而不是某个文案 key。
    // 原来这条断言钉的是「空格子」那条词（`cameraWallUi.cellEmpty`）—— 那句话已经
    // 从界面和目录里一起删掉了，留着它才是回归。
    const cells = buildCameraCells(createCameraWallModel(1), {
      devices: [],
      states: {},
      maxStreams: 4
    })
    assert.equal(cells[0]?.status, 'empty')
    assert.equal(cells[0]?.messageKey, undefined)
    assert.equal(cells[0]?.messageText, undefined)
    assert.equal(cells[0]?.url, undefined)
  })

  it('没有会话快照 = 未开始（不是错误，也不是播放中）', () => {
    const model = assignCamera(createCameraWallModel(1), 0, 'cam-1').model
    const cells = buildCameraCells(model, {
      devices: [camera('cam-1')],
      states: {},
      maxStreams: 4
    })
    assert.equal(cells[0]?.status, 'idle')
  })

  it('playing 才带 url；starting 也带（回环服务已经起来，第一帧到了就能画）', () => {
    const model = assignCamera(createCameraWallModel(1), 0, 'cam-1').model
    const playing = buildCameraCells(model, {
      devices: [camera('cam-1')],
      states: { 'cam-1': liveState('cam-1', 'playing', { url: 'http://127.0.0.1:9/t/stream.mp4' }) },
      maxStreams: 4
    })
    assert.equal(playing[0]?.status, 'playing')
    assert.equal(playing[0]?.url, 'http://127.0.0.1:9/t/stream.mp4')

    const starting = buildCameraCells(model, {
      devices: [camera('cam-1')],
      states: { 'cam-1': liveState('cam-1', 'starting', { url: 'http://127.0.0.1:9/t/stream.mp4' }) },
      maxStreams: 4
    })
    assert.equal(starting[0]?.status, 'starting')
    assert.equal(starting[0]?.url, 'http://127.0.0.1:9/t/stream.mp4')
  })

  it('RTSP 未启用 / 找不到 ffmpeg 各自是一条状态，并带上原因', () => {
    const model = assignCamera(createCameraWallModel(4), 0, 'cam-1').model
    const withSecond = assignCamera(model, 1, 'cam-2').model
    const cells = buildCameraCells(withSecond, {
      devices: [camera('cam-1'), camera('cam-2')],
      states: {
        'cam-1': liveState('cam-1', 'rtsp-disabled', { error: '设备上报 rtsp_enabled=0' }),
        'cam-2': liveState('cam-2', 'ffmpeg-missing', { error: '找不到 ffmpeg 可执行文件' })
      },
      maxStreams: 4
    })
    assert.equal(cells[0]?.status, 'rtsp-disabled')
    assert.equal(cells[0]?.messageKey, 'cameraWallUi.statusRtspDisabled')
    assert.equal(cells[0]?.messageText, '设备上报 rtsp_enabled=0')
    assert.equal(cells[1]?.status, 'ffmpeg-missing')
    assert.equal(cells[1]?.messageKey, 'cameraWallUi.statusFfmpegMissing')
  })

  it('流错误带上主进程的诊断原文', () => {
    const model = assignCamera(createCameraWallModel(1), 0, 'cam-1').model
    const cells = buildCameraCells(model, {
      devices: [camera('cam-1')],
      states: {
        'cam-1': liveState('cam-1', 'error', {
          error: '视频流中断（ffmpeg 退出码 1）：Connection refused'
        })
      },
      maxStreams: 4
    })
    assert.equal(cells[0]?.status, 'error')
    assert.match(cells[0]?.messageText ?? '', /Connection refused/)
  })

  it('一旦说话就只说短状态词：每一种状态都拿到目录键，空白格一个都没有', () => {
    // 一面墙上同时有空格子与占用格：**只有**空白格没有 messageKey（它的界面内容是
    // 一个 `+`，一个字都不写），其余每一格都必须能说出自己的**短状态词**。
    //
    // 这里额外钉一条这一轮改掉的规则：手里的 key 必须来自 `CAMERA_CELL_STATUS_KEYS`。
    // 它挡的是「格子又拿到一句长句子」——设备被删/离线以前拿的是
    // `cameraWallUi.removingDevice` / `offlineDevice` 那两句「设备「X」已删除，这一格
    // 已清空。」，而那是解释，不是状态。
    let model = createCameraWallModel(4)
    model = assignCamera(model, 1, 'cam-1').model
    model = assignCamera(model, 2, 'cam-2').model
    const cells = buildCameraCells(model, {
      devices: [camera('cam-1'), camera('cam-2', 'OFFLINE')],
      states: {},
      maxStreams: 4
    })
    for (const index of [0, 3]) {
      assert.equal(cells[index]?.status, 'empty')
      assert.equal(cells[index]?.messageKey, undefined)
    }
    const allowed = new Set(Object.values(CAMERA_CELL_STATUS_KEYS))
    for (const cell of cells) {
      if (cell.status === 'empty') continue
      assert.equal(typeof cell.messageKey, 'string')
      assert.notEqual(cell.messageKey, '')
      assert.ok(
        allowed.has(cell.messageKey ?? ''),
        `${cell.status} 拿到了一个不是短状态词的 key：${cell.messageKey}`
      )
    }
    // 离线设备必须是 device-offline，而不是「未开始」。
    assert.equal(cells[2]?.status, 'device-offline')
    assert.equal(CAMERA_CELL_STATUSES.includes('device-offline'), true)
  })

  it('相机不在设备列表里（已删除）= device-removed，卖的是短状态词而不是那句解释', () => {
    const model = assignCamera(createCameraWallModel(1), 0, 'gone').model
    const cells = buildCameraCells(model, { devices: [], states: {}, maxStreams: 4 })
    assert.equal(cells[0]?.status, 'device-removed')
    assert.equal(cells[0]?.messageKey, 'cameraWallUi.statusDeviceRemoved')
  })

  it('设备被删除优先于主进程残留的 playing 快照', () => {
    const model = assignCamera(createCameraWallModel(1), 0, 'gone').model
    const cells = buildCameraCells(model, {
      devices: [],
      states: { gone: liveState('gone', 'playing', { url: 'http://127.0.0.1:1/x/stream.mp4' }) },
      maxStreams: 4
    })
    assert.equal(cells[0]?.status, 'device-removed')
    assert.equal(cells[0]?.url, undefined)
  })
})

// ---------------------------------------------------------------------------
// 音频独占
// ---------------------------------------------------------------------------

describe('音频独占', () => {
  it('至多一格出声：切到另一格时前一格自动静音', () => {
    const model = fullWall()
    const first = setAudioSlot(model, 0)
    const second = setAudioSlot(first, 2)
    assert.equal(second.audioSlot, 2)
    const audible = [0, 1, 2, 3].filter((slot) => second.audioSlot === slot)
    assert.deepEqual(audible, [2])
  })

  it('再点一次同一格就静音（声音按钮是开关）', () => {
    const model = setAudioSlot(fullWall(), 1)
    assert.equal(toggleAudioSlot(model, 1).audioSlot, null)
    assert.equal(toggleAudioSlot(model, 2).audioSlot, 2)
  })

  it('空格不能出声', () => {
    const model = createCameraWallModel(4)
    assert.equal(setAudioSlot(model, 3).audioSlot, null)
    assert.equal(toggleAudioSlot(model, 3).audioSlot, null)
  })

  it('传 null 就是静音', () => {
    const model = setAudioSlot(fullWall(), 3)
    assert.equal(setAudioSlot(model, null).audioSlot, null)
  })

  it('格子模型里只有一格 audio 标记为真，而且它必须真的有画面', () => {
    const model = setAudioSlot(fullWall(), 2)
    const playing = 'http://127.0.0.1:9/t/stream.mp4'
    const cells = buildCameraCells(model, {
      devices: [camera('cam-1'), camera('cam-2'), camera('cam-3'), camera('cam-4')],
      states: {
        'cam-1': liveState('cam-1', 'playing', { url: playing }),
        'cam-2': liveState('cam-2', 'playing', { url: playing }),
        'cam-3': liveState('cam-3', 'playing', { url: playing }),
        'cam-4': liveState('cam-4', 'playing', { url: playing })
      },
      maxStreams: 4
    })
    assert.equal(cells.filter((cell) => cell.audio).length, 1)
    assert.equal(cells[2]?.audio, true)

    // 出声格**没有画面**时不能报「正在出声」：模型里 `audioSlot` 还指着第 3 格，
    // 但这一格的 `<video>` 已经被卸载（未开始 / 流错误 / 设备离线），此时徽标
    // 「正在出声」就是一句假话 —— 界面实测踩过这个坑，所以 audio 由 `audibleAt()`
    // 同时看「是不是出声格」与「这一格有没有画面」。
    const silent = buildCameraCells(model, {
      devices: [camera('cam-1'), camera('cam-2'), camera('cam-3'), camera('cam-4')],
      states: {},
      maxStreams: 4
    })
    assert.equal(silent.filter((cell) => cell.audio).length, 0)
    // 模型本身没有被改：声音仍然记在第 3 格，画面回来之后它接着出声。
    assert.equal(model.audioSlot, 2)
  })
})

// ---------------------------------------------------------------------------
// 换档位 / 删除设备
// ---------------------------------------------------------------------------

describe('换档位与设备被删除', () => {
  it('档位变小：多出来的格子被清空，并交出被挤掉的相机（调用方据此停流）', () => {
    const full = fullWall()
    const result = setCameraWallLayout(full, 1)
    assert.equal(result.model.slots.length, 1)
    assert.deepEqual(result.model.slots, ['cam-1'])
    assert.deepEqual([...result.evictedDeviceIds].sort(), ['cam-2', 'cam-3', 'cam-4'])
  })

  it('档位变小后，被挤掉的相机不再出现在任何格子里', () => {
    const result = setCameraWallLayout(fullWall(), 1)
    assert.equal(findCameraSlot(result.model, 'cam-4'), -1)
  })

  it('档位变大：原来的分配原样保留，新格子是空的（不重新洗牌）', () => {
    const small = assignCamera(createCameraWallModel(1), 0, 'cam-1').model
    const result = setCameraWallLayout(small, 16)
    assert.equal(result.model.slots.length, 16)
    assert.equal(result.model.slots[0], 'cam-1')
    assert.equal(result.model.slots.slice(1).every((slot) => slot === null), true)
    assert.deepEqual(result.evictedDeviceIds, [])
  })

  it('档位变小挤掉出声的那一格时，声音标记被清掉（不会留下悬空的声音）', () => {
    const full = setAudioSlot(fullWall(), 3)
    const result = setCameraWallLayout(full, 1)
    assert.equal(result.model.audioSlot, null)
  })

  it('清空一格：相机消失，声音与当前格都不再指向它', () => {
    const model = setAudioSlot(fullWall(), 1)
    const cleared = clearCameraCell(model, 1)
    assert.equal(cleared.slots[1], null)
    assert.equal(cleared.audioSlot, null)
  })

  it('设备被删除：清空它占的格并交出格号（界面据此说明哪一格为什么空了）', () => {
    const model = fullWall()
    const result = removeDeviceFromWall(model, 'cam-2')
    assert.deepEqual(result.clearedSlots, [1])
    assert.equal(findCameraSlot(result.model, 'cam-2'), -1)
    // 其他相机不受影响：删一台设备不该让整面墙重排。
    assert.equal(result.model.slots[0], 'cam-1')
    assert.equal(result.model.slots[2], 'cam-3')
  })

  it('删除不在墙上的设备是一个无操作', () => {
    const model = fullWall()
    const result = removeDeviceFromWall(model, 'cam-9')
    assert.deepEqual(result.clearedSlots, [])
    assert.equal(result.model, model)
  })

  it('clearCameraDevice 清掉某台相机出现的所有格（防模型被外部改成重复）', () => {
    // 手工构造一个「同一台相机在两格」的脏模型：真实入口不会产生它，
    // 但持久化/旧版本可能留下它，清理必须彻底。
    const dirty: CameraWallModel = {
      layout: 4,
      slots: ['cam-1', 'cam-1', null, 'cam-2'],
      audioSlot: 1,
      activeSlot: 0
    }
    const cleaned = clearCameraDevice(dirty, 'cam-1')
    assert.deepEqual(cleaned.slots, [null, null, null, 'cam-2'])
    // 出声的那一格被清空了：声音标记必须一起消失。
    assert.equal(cleaned.audioSlot, null)
  })

  it('当前格只能落在存在的格子里', () => {
    const model = setActiveSlot(createCameraWallModel(4), 3)
    assert.equal(model.activeSlot, 3)
    assert.equal(setActiveSlot(model, 99).activeSlot, 3)
    const shrunk = setCameraWallLayout(model, 1).model
    assert.equal(shrunk.activeSlot, 0)
  })
})

// ---------------------------------------------------------------------------
// 档位图标与它选出来的真实网格
// ---------------------------------------------------------------------------

describe('档位图标不可能与它选出的网格不一致', () => {
  it('1 / 4 / 9 / 16 的图标分别是 1×1 / 2×2 / 3×3 / 4×4', () => {
    // 图标与真实网格共用同一份输入：**档位本身 + `cameraWallColumns()`**。所以这里断言
    // 的不是「图标长什么样」，而是「图标 == 网格」：16 档的图标画成 4×3 而点下去是
    // 4×4，正是操作员点到错档位的直接原因。
    const expected: Record<number, [number, number] | undefined> = {
      1: [1, 1],
      4: [2, 2],
      9: [3, 3],
      16: [4, 4]
    }
    for (const layout of CAMERA_WALL_LAYOUTS) {
      const wanted = expected[layout]
      assert.ok(wanted, `${layout} 档没有期望形状`)
      const geometry = layoutIconGeometry(layout, cameraWallColumns(layout))
      assert.equal(geometry.cells.length, cameraCellCount(layout), `${layout} 档图标的格子数`)
      assert.equal(geometry.columns, wanted[0], `${layout} 档图标的列数`)
      assert.equal(geometry.rows, wanted[1], `${layout} 档图标的行数`)
      // 真实网格：每行几格由 `cameraWallColumns()` 决定，行数是格子数除以列数。
      assert.equal(cameraWallColumns(layout), wanted[0], `${layout} 档网格的列数`)
      assert.equal(
        cameraCellCount(layout) / cameraWallColumns(layout),
        wanted[1],
        `${layout} 档网格的行数`
      )
    }
  })

  it('9 档就是 3×3，既不是 4×2 也不是一行九格', () => {
    assert.equal(cameraCellCount(9), 9)
    assert.equal(cameraWallColumns(9), 3)
    const geometry = layoutIconGeometry(9, cameraWallColumns(9))
    assert.equal(geometry.cells.length, 9)
    assert.equal(geometry.columns, 3)
    assert.equal(geometry.rows, 3)
  })
})

// ---------------------------------------------------------------------------
// 能不能进视频墙
// ---------------------------------------------------------------------------

describe('哪些设备能进视频墙', () => {
  it('只有声学相机有视频：声纹设备没有 RTSP 流', () => {
    assert.equal(isWallCapableDevice(camera('cam-1')), true)
    assert.equal(isWallCapableDevice(box('box-1')), false)
    assert.equal(isWallCapableDevice(undefined), false)
  })
})

// ---------------------------------------------------------------------------
// 画面格的右键菜单：模型给出的项，以及它们引用的目录键
// ---------------------------------------------------------------------------

/**
 * WHY HERE
 * 右键菜单的**内容**完全由 `@shared/domain/camera-nvr` 决定，而画面格是第一个
 * 声明了全部五项能力的界面（单路面板 `MonitorView` 只声明两项）。所以这一组断言
 * 钉两件事：
 *   1. 五项全开时模型输出的**顺序与 labelKey**（字面量打字错误会让某一项指着一条
 *      不存在的词条，界面上就会出现一串裸 key）；
 *   2. 那三个新键 —— `menuPlayback` / `menuDownloadDetect` / `menuCloseTile` —— 在
 *      **四种语言**里都真的存在、非空、且是真正翻译过的（不是把中文抄过去）。
 */
describe('画面格的右键菜单（NVR 式）', () => {
  /**
   * 画面格声明的能力：**六项**全开（本组件确实实现了全部六项）。
   *
   * 第六项 `cellViews` 是业主 2026-09-19 第 12 批加上的：四颗视图按钮从控制条
   * 移进了右键菜单的「显示方式」。它是**画面格**的能力 —— 实时监测页不声明它。
   */
  const WALL_CAPABILITIES = {
    liveVideo: true,
    alarmModel: true,
    localPlayback: true,
    detectDownload: true,
    tileClose: true,
    cellViews: true
  }

  function wallEnv(overrides: Partial<CameraNvrEnvironment> = {}): CameraNvrEnvironment {
    return {
      deviceName: '相机 A',
      recording: false,
      fullscreen: false,
      hasUsableSource: true,
      capabilities: WALL_CAPABILITIES,
      ...overrides
    }
  }

  function playing(overrides: Partial<CameraLiveState> = {}): CameraLiveState {
    return liveState('cam-1', 'playing', {
      url: 'http://127.0.0.1:9/t/stream.mp4',
      rtspUrl: 'rtsp://192.168.110.235:443/live',
      ...overrides
    })
  }

  it('正在播放的一格：九项按固定顺序给出，本机动作仍然排在设备侧动作之前', () => {
    const menu = buildCameraNvrMenu(playing(), wallEnv())
    assert.deepEqual(
      menu.map((item) => item.action),
      [
        'capture',
        'toggle-fullscreen',
        'copy-rtsp',
        'open-external',
        // 第 12 批新增：四颗视图按钮从控制条移进这里（与「叠加信息」同属"怎么画"）。
        'display',
        // 「显示/隐藏叠加信息」已按业主 2026-09-21 批移除：叠加条永远显示。
        'playback',
        'download-detect',
        'close-tile',
        'alarm-config'
      ]
    )
    // 设备侧动作永远最后：清空这一格虽然排在本机组末尾，也必须在告警配置之前。
    assert.equal(menu[menu.length - 1]?.action, 'alarm-config')
    // 分组线：回放、清空、告警配置各自开一段（叠加信息那一项已经不在了）。
    assert.deepEqual(
      menu.filter((item) => item.separatorBefore).map((item) => item.action),
      ['playback', 'close-tile', 'alarm-config']
    )
  })

  it('三项新入口带着自己的目录键，而且就是这一次补齐的那三个', () => {
    const menu = buildCameraNvrMenu(playing(), wallEnv())
    const keyOf = (action: string): string =>
      menu.find((item) => item.action === action)?.labelKey ?? ''
    assert.equal(keyOf('playback'), 'cameraNvrUi.menuPlayback')
    assert.equal(keyOf('download-detect'), 'cameraNvrUi.menuDownloadDetect')
    assert.equal(keyOf('close-tile'), 'cameraNvrUi.menuCloseTile')
    // 「回放」的文案必须说清是本机录像：FA371 没有设备侧连续录像存储，
    // 写成「回放设备录像」就是一句假话。这条断言钉的是**中文字面量**，
    // 因为参考语言就是产品原话所在的那一种。
    assert.equal(zhCN.cameraNvrUi.menuPlayback.includes('本机'), true)
    assert.equal(zhCN.cameraNvrUi.menuDownloadDetect.includes('检测'), true)
  })

  it('回放与下载恒为可点：它们是「打开一个选择器」，可用性由列表自己说', () => {
    // 本函数是纯的、不做 I/O。凭空判一个「有没有录像 / 有没有检测记录」就是猜，
    // 而这个模型的全部意义就是「不可用必须给得出原因」。
    const menu = buildCameraNvrMenu(null, wallEnv())
    assert.equal(menu.find((item) => item.action === 'playback')?.enabled, true)
    assert.equal(menu.find((item) => item.action === 'download-detect')?.enabled, true)
    assert.equal(menu.find((item) => item.action === 'close-tile')?.enabled, true)
  })

  it('没有相机的格子：模型仍然给出三个入口，所以组件必须自己拦住', () => {
    // 这就是「空白格不打开相机菜单」的理由，写在这里免得以后有人把它当成一句
    // 多余的守卫删掉：设备族能力全关时，模型**仍然**会输出本机回放 / 检测下载 /
    // 清空这一格三项（前两项是本机动作，第三项与相机能力无关）。对着一台不存在的
    // 相机显示「回放本机录像」，比不显示更糟。
    const boxEnv = wallEnv({ capabilities: { ...WALL_CAPABILITIES, liveVideo: false, alarmModel: false } })
    const actions = buildCameraNvrMenu(null, boxEnv).map((item) => item.action)
    assert.ok(actions.includes('playback'))
    assert.ok(actions.includes('download-detect'))
    assert.ok(actions.includes('close-tile'))
    assert.equal(actions.includes('capture'), false)
    assert.equal(actions.includes('alarm-config'), false)
  })

  it('三个新键在四种语言里都存在、非空，而且是真正翻译过的', () => {
    const keys = [
      'cameraNvrUi.menuPlayback',
      'cameraNvrUi.menuDownloadDetect',
      'cameraNvrUi.menuCloseTile'
    ]
    for (const locale of LOCALES) {
      const messages = flattenCatalogue(locale)
      for (const key of keys) {
        const message = messages.get(key)
        assert.ok(message !== undefined, `${locale} 没有词条 ${key}`)
        assert.ok((message ?? '').trim().length > 0, `${locale}.${key} 是空的`)
        assert.ok(!(message ?? '').includes('@'), `${locale}.${key} 含 linked-message 符号`)
      }
    }
    // 「真的翻译过」：非参考语言里这三条不能与中文逐字相同。
    for (const locale of LOCALES) {
      if (locale === 'zh-CN') continue
      const messages = flattenCatalogue(locale)
      for (const key of keys) {
        assert.notEqual(messages.get(key), flattenCatalogue('zh-CN').get(key), `${locale}.${key} 还是中文`)
      }
    }
  })

  it('两个新弹窗与逐格提示用到的每一个 cameraNvrUi 键在四种语言里都存在', () => {
    // 弹窗里的键名都是字符串，打字错误不会被类型检查抓住 —— 界面上会出现一串裸 key。
    // 所以把这一轮新增/新用的键逐个列出来，在四种语言里查一遍。
    const keys = [
      'cameraNvrUi.recordingStarted',
      'cameraNvrUi.playbackTitle',
      'cameraNvrUi.playbackLoading',
      'cameraNvrUi.playbackEmpty',
      'cameraNvrUi.playbackLocalNote',
      'cameraNvrUi.playbackUnavailable',
      'cameraNvrUi.downloadTitle',
      'cameraNvrUi.downloadLoading',
      'cameraNvrUi.downloadEmpty',
      'cameraNvrUi.downloadNoPaging',
      'cameraNvrUi.downloadColumnTime',
      'cameraNvrUi.downloadColumnMode',
      'cameraNvrUi.downloadColumnFiles',
      'cameraNvrUi.downloadReused',
      'cameraNvrUi.downloadPlay',
      'cameraNvrUi.openExternalDone'
    ]
    for (const locale of LOCALES) {
      const messages = flattenCatalogue(locale)
      for (const key of keys) {
        assert.ok((messages.get(key) ?? '').trim().length > 0, `${locale} 没有词条 ${key}`)
      }
    }
    // 带占位符的三条：占位符漂移不会被类型检查发现，而用户会看到一个裸的 `{count}`。
    for (const locale of LOCALES) {
      const messages = flattenCatalogue(locale)
      assert.ok((messages.get('cameraNvrUi.recordingStarted') ?? '').includes('{path}'))
      assert.ok((messages.get('cameraNvrUi.downloadNoPaging') ?? '').includes('{count}'))
      assert.ok((messages.get('cameraNvrUi.downloadReused') ?? '').includes('{name}'))
    }
  })

  it('检测记录弹窗复用的领域枚举在四种语言里都有词条', () => {
    // 下载弹窗按**原始枚举值**渲染文件种类与下载阶段（`detectFileKindLabel()` /
    // `eventDownloadStageLabel()`）。两个枚举的映射都是全集，少一条就会出现一串
    // 裸 key，而且只在真机上某一种文件出现时才看得见。
    for (const locale of LOCALES) {
      const messages = flattenCatalogue(locale)
      for (const kind of FA371_RESULT_FILE_KINDS) {
        assert.ok((messages.get(`domain.detectFileKind.${kind}`) ?? '').trim().length > 0, `${locale} 缺 domain.detectFileKind.${kind}`)
      }
      for (const stage of EVENT_DOWNLOAD_STAGES) {
        assert.ok((messages.get(`domain.eventDownloadStage.${stage}`) ?? '').trim().length > 0, `${locale} 缺 domain.eventDownloadStage.${stage}`)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 轮询队列与轮换（业主 2026-09-21 批「超出窗口数自动轮询」）
// ---------------------------------------------------------------------------

describe('轮询队列（enqueue / remove / normalise）', () => {
  it('排进队：可见或已在队的不重复入队', () => {
    let model = createCameraWallModel(4)
    model = assignCamera(model, 0, 'cam-1').model
    // 已在墙上可见：(cam-1, play) 进不了队。
    assert.equal(enqueueWallItem(model, 'cam-1', 'play'), model)
    // 同一个 (id, view) 排一次就够。
    const once = enqueueWallItem(model, 'cam-2', 'spectrum')
    assert.deepEqual(once.queue, [{ id: 'cam-2', view: 'spectrum' }])
    assert.equal(enqueueWallItem(once, 'cam-2', 'spectrum'), once)
    // 同 id 不同视图是两个内容：照收。
    const twice = enqueueWallItem(once, 'cam-2', 'timedomain')
    assert.deepEqual(twice.queue, [
      { id: 'cam-2', view: 'spectrum' },
      { id: 'cam-2', view: 'timedomain' }
    ])
    // 空 id / 坏视图不收。
    assert.equal(enqueueWallItem(model, '', 'play'), model)
    assert.equal(enqueueWallItem(model, 'cam-2', 'nope' as never), model)
  })

  it('内容回到墙上就从队里清掉（与可见性去重同一条规则）', () => {
    let model = createCameraWallModel(4)
    model = enqueueWallItem(model, 'cam-2', 'play')
    assert.equal((model.queue ?? []).length, 1)
    // 这一格放进了同一内容：队列里那一份失去资格。
    model = assignCamera(model, 1, 'cam-2').model
    assert.equal(enqueueWallItem(model, 'cam-2', 'play'), model, '可见内容不该重复进队')
  })

  it('removeIdFromQueue：按 id 清掉所有项，没动到就不产生新对象', () => {
    let model = createCameraWallModel(4)
    model = enqueueWallItem(model, 'cam-1', 'play')
    model = enqueueWallItem(model, 'cam-2', 'spectrum')
    model = enqueueWallItem(model, 'cam-1', 'spectrogram')
    const cleaned = removeIdFromQueue(model, 'cam-1')
    assert.deepEqual(cleaned.queue, [{ id: 'cam-2', view: 'spectrum' }])
    // 不存在的 id 是 no-op（纯函数的「没变就返回原对象」）。
    assert.equal(removeIdFromQueue(cleaned, 'cam-9'), cleaned)
    // 没有队列的模型上清任何东西都是原样返回。
    const empty = createCameraWallModel(4)
    assert.equal(removeIdFromQueue(empty, 'cam-9'), empty)
  })

  it('normalise：坏项丢弃、按 (id, view) 去重、与格子上可见的 (id, view) 去重', () => {
    const normalised = normaliseCameraWallModel({
      layout: 4,
      slots: ['cam-1', null, null, null],
      audioSlot: null,
      activeSlot: 0,
      queue: [
        { id: 'cam-1', view: 'play' }, // 已在墙上可见：丢
        { id: 'cam-2', view: 'spectrum' },
        { id: 'cam-2', view: 'spectrum' }, // 重复：丢
        { id: '', view: 'play' }, // 坏 id：丢
        { id: 'cam-3', view: 'nope' }, // 坏视图：丢
        { id: 'cam-4', view: 'timedomain' },
        null, // 坏项：丢
        'junk' // 坏项：丢
      ],
      rotateCursor: -5
    })
    assert.deepEqual(normalised.queue, [
      { id: 'cam-2', view: 'spectrum' },
      { id: 'cam-4', view: 'timedomain' }
    ])
    // 负游标修回 0。
    assert.equal(normalised.rotateCursor, 0)
    // 缺 `queue` 字段就是空队。
    assert.deepEqual(normaliseCameraWallModel(createCameraWallModel(4)).queue, [])
  })
})

describe('轮询轮换（rotateWallOnce）', () => {
  it('队空：什么都不发生，游标不动', () => {
    const model = createCameraWallModel(4)
    const result = rotateWallOnce(model)
    assert.equal(result.changed, false)
    assert.equal(result.model, model)
    assert.equal(result.model.rotateCursor ?? 0, 0)
  })

  it('队首进游标指着的那一格，被轮走的排到队尾', () => {
    let model = createCameraWallModel(4)
    model = assignCamera(model, 0, 'cam-1').model
    model = enqueueWallItem(model, 'cam-2', 'play')
    const result = rotateWallOnce(model)
    assert.equal(result.changed, true)
    if (!result.changed) return
    assert.equal(result.slot, 0)
    assert.equal(result.incoming.id, 'cam-2')
    assert.deepEqual(result.evicted, { id: 'cam-1', view: 'play' })
    assert.deepEqual(result.model.slots, ['cam-2', null, null, null])
    // 被轮走的 (cam-1, play) 补到队尾：轮询是"轮流站"，不是淘汰。
    assert.deepEqual(result.model.queue, [{ id: 'cam-1', view: 'play' }])
    assert.equal(result.model.rotateCursor, 1)
  })

  it('游标逐格推进：一格一格顺次轮，不跳格', () => {
    let model = createCameraWallModel(4)
    for (let index = 0; index < 4; index += 1) {
      model = assignCamera(model, index, `cam-${index + 1}`).model
    }
    model = enqueueWallItem(model, 'cam-9', 'play')
    model = enqueueWallItem(model, 'cam-10', 'play')
    const first = rotateWallOnce(model)
    assert.equal(first.changed, true)
    if (!first.changed) return
    assert.equal(first.slot, 0)
    const second = rotateWallOnce(first.model)
    assert.equal(second.changed, true)
    if (!second.changed) return
    assert.equal(second.slot, 1)
    assert.deepEqual(second.model.slots.slice(0, 2), ['cam-9', 'cam-10'])
    assert.equal(second.model.rotateCursor, 2)
  })

  it('进格的视图跟着 incoming 走，且不残留上一格留下的 spectrum', () => {
    let model = createCameraWallModel(4)
    model = assignCamera(model, 0, 'cam-1').model
    model = enqueueWallItem(model, 'cam-2', 'spectrum')
    const result = rotateWallOnce(model)
    assert.equal(result.changed, true)
    if (!result.changed) return
    assert.equal(result.model.slots[0], 'cam-2')
    assert.equal(cellViewAt(result.model, 0), 'spectrum')
    assert.equal(result.model.views?.[0], 'spectrum')
    // 下一轮轮到播放进来：第 1 格落 cam-3，视图是播放（默认），
    // 而第 0 格那个 spectrum **不被波及**。
    const back = rotateWallOnce({
      ...result.model,
      queue: [{ id: 'cam-3', view: 'play' }]
    })
    assert.equal(back.changed, true)
    if (!back.changed) return
    assert.equal(back.model.slots[1], 'cam-3')
    assert.equal(cellViewAt(back.model, 1), 'play')
    assert.equal(cellViewAt(back.model, 0), 'spectrum')
  })

  it('被轮走的那一格是出声格时静音', () => {
    let model = createCameraWallModel(4)
    model = assignCamera(model, 0, 'cam-1').model
    model = setAudioSlot(model, 0)
    model = enqueueWallItem(model, 'cam-2', 'play')
    const result = rotateWallOnce(model)
    assert.equal(result.changed, true)
    if (!result.changed) return
    assert.equal(result.model.audioSlot, null, '出声格被轮走必须静音，不留悬空徽标')
  })

  it('空格被轮：没有 evicted，队尾不补空项', () => {
    const model = enqueueWallItem(createCameraWallModel(4), 'cam-1', 'play')
    const result = rotateWallOnce(model)
    assert.equal(result.changed, true)
    if (!result.changed) return
    assert.equal(result.evicted, null)
    assert.deepEqual(result.model.queue, [])
    assert.equal(result.model.slots[0], 'cam-1')
  })
})

/**
 * 空白格上的相机选择器浮层摆在哪儿（业主 2026-09-18 报的 bug）。
 *
 * 修之前那块选择器是原生 `<select>`，挂在墙末尾的 1×1 隐藏宿主里，由 `showPicker()`
 * 打开 —— 下拉贴在**宿主那个盒子**上，墙一高就落到窗口外面。换成自己画的浮层之后，
 * 「开在哪里」是我们自己的算术，因此必须能被单元测试直接钉住（而不是只能靠肉眼看）。
 */
describe('相机选择器浮层的落点', () => {
  /** 1440×900 的一次真实几何：被点的那一格在页面中部。 */
  const viewport = { width: 1440, height: 900 }
  const cell = { left: 320, top: 200, right: 800, bottom: 470 }

  it('优先开在那一格下面，左边缘与那一格对齐', () => {
    const placed = placeCameraPicker(cell, { width: 220, height: 160 }, viewport)
    assert.equal(placed.placement, 'below')
    assert.equal(placed.left, cell.left)
    assert.equal(placed.top, cell.bottom + CAMERA_PICKER_GAP)
  })

  it('下面放不下时翻到上面，且整块仍在视口里', () => {
    // 这一格贴着窗口底部：下面只剩 20px，而浮层高 160px。
    const low = { left: 320, top: 700, right: 800, bottom: 880 }
    const placed = placeCameraPicker(low, { width: 220, height: 160 }, viewport)
    assert.equal(placed.placement, 'above')
    assert.equal(placed.top, low.top - CAMERA_PICKER_GAP - 160)
    assert.ok(placed.top >= 0, '翻到上面之后不能是负的')
    assert.ok(placed.top + 160 <= viewport.height, '翻到上面之后要整个在视口里')
  })

  it('上下都放不下时仍然给得出一个落点，且不出界', () => {
    // 一格比视口还高（16 分屏下把窗口缩到很矮时就是这个形状）。
    const tall = { left: 0, top: -40, right: 1440, bottom: 1200 }
    const placed = placeCameraPicker(tall, { width: 260, height: 200 }, viewport)
    assert.ok(placed.top >= CAMERA_PICKER_GAP, 'top 不能跑到窗口上面去')
    assert.ok(placed.top + 200 <= viewport.height, 'top 不能把浮层推到窗口下面')
    assert.ok(placed.left >= CAMERA_PICKER_GAP)
    assert.ok(placed.left + 260 <= viewport.width)
  })

  it('水平方向夹进视口：贴右边缘的那一格不会把浮层推出窗口', () => {
    const right = { left: 1300, top: 200, right: 1440, bottom: 400 }
    const placed = placeCameraPicker(right, { width: 220, height: 160 }, viewport)
    assert.ok(placed.left + 220 <= viewport.width, '浮层右边缘出界了')
    assert.ok(placed.left >= CAMERA_PICKER_GAP)
  })

  it('浮层比视口还宽时退到左边缘，不产生负坐标', () => {
    const placed = placeCameraPicker(cell, { width: 1600, height: 160 }, viewport)
    assert.equal(placed.left, CAMERA_PICKER_GAP)
  })

  it('视口高度为 0 之类的退化输入不会算出 NaN', () => {
    const placed = placeCameraPicker(cell, { width: 220, height: 160 }, { width: 0, height: 0 })
    assert.ok(Number.isFinite(placed.left) && Number.isFinite(placed.top))
    assert.equal(placed.left, CAMERA_PICKER_GAP)
    assert.equal(placed.top, CAMERA_PICKER_GAP)
  })

  it('负数尺寸（量不到的浮层）不会把落点算成负的', () => {
    const placed = placeCameraPicker(cell, { width: -10, height: -10 }, viewport)
    assert.ok(placed.left >= CAMERA_PICKER_GAP && placed.top >= CAMERA_PICKER_GAP)
    assert.ok(placed.left <= viewport.width && placed.top <= viewport.height)
  })
})
