/**
 * 相机「开机自动播放」的判定、呈现，以及总览页那一块画面的诚实性。
 *
 * WHY THIS FILE EXISTS
 * 「软件打开如果是相机有在工作就自动播放视频」这句话里，最容易做错的三件事都
 * 不在画面上：
 *   1. **「有在工作」是什么。** 相机没有注册、设备离线、设备端 RTSP 关着——这三种
 *      情况下「先播一下试试」都会以「连接超时」的形式失败，于是界面把设备的现状
 *      说成了网络故障，还白占了相机一条 RTSP 连接。判定必须能逐条拒绝。
 *   2. **一次启动只做一次。** 一个「没成功就再试一次」的自动路径，在相机没开 RTSP
 *      的现场就是每几秒一次的连接风暴，而且操作员永远看不到原因。
 *   3. **手动停止优先。** 操作员按下停止之后画面又自己回来，是这一块最不可接受的
 *      缺陷：它让停止按钮变成一个建议。
 *
 * 因此判定做成一个纯函数（`@shared/domain/camera-autoplay`），这里直接把它钉死；
 * 呈现也做成纯函数，于是「绝不给操作员一个永远转圈的黑框」这条规矩可以在没有浏览器
 * 的情况下断言——它落在「非播放状态下 `videoUrl` 必须为空」这一个不变式上，再加一条
 * 对真实组件模板的静态检查（`<video>` 必须挂在 `v-if="videoUrl"` 之下）。
 *
 * 中文注释是仓库约定（见 tests/channel-state.test.ts）。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  cameraLiveBadgeClass,
  cameraLiveMessageClass,
  cameraLiveViewModel,
  decideCameraAutoPlay,
  isSessionActive,
  rtspAvailabilityFromState,
  type CameraAutoPlayInput,
  type CameraRtspAvailability
} from '../src/shared/domain/camera-autoplay'
import type { CameraLiveState } from '../src/shared/domain/camera-live'
import { LOCALES } from '../src/shared/i18n/locales'
import { zhCN } from '../src/shared/i18n/messages/zh-CN'
import { en } from '../src/shared/i18n/messages/en'
import { es } from '../src/shared/i18n/messages/es'
import { tr } from '../src/shared/i18n/messages/tr'
import { ru } from '../src/shared/i18n/messages/ru'
import { zhTW } from '../src/shared/i18n/messages/zh-TW'
import { i18n } from '../src/renderer/src/i18n'

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/**
 * 一个「相机确实在工作」的世界。
 *
 * 每个用例只改它关心的那一项，于是失败时能一眼看出是哪一条规则被破坏了——这也是
 * 判定函数只接受一个扁平输入对象的原因。
 */
function world(overrides: Partial<CameraAutoPlayInput> = {}): CameraAutoPlayInput {
  return {
    autoPlayEnabled: true,
    cameraRegistered: true,
    deviceId: 'cam-1',
    deviceStatus: 'ONLINE',
    rtspAvailability: 'unknown',
    sessionStatus: null,
    manualStopped: false,
    alreadyAttempted: false,
    ...overrides
  }
}

function state(overrides: Partial<CameraLiveState> & Pick<CameraLiveState, 'status'>): CameraLiveState {
  return { deviceId: 'cam-1', ...overrides }
}

function catalogue(locale: string): Record<string, unknown> {
  if (locale === 'zh-CN') return zhCN as unknown as Record<string, unknown>
  if (locale === 'zh-TW') return zhTW as unknown as Record<string, unknown>
  if (locale === 'en') return en as unknown as Record<string, unknown>
  if (locale === 'es') return es as unknown as Record<string, unknown>
  if (locale === 'ru') return ru as unknown as Record<string, unknown>
  return tr as unknown as Record<string, unknown>
}

/** 把 `overviewLiveUi` 摊平成 `overviewLiveUi.a.b -> 文案`。 */
function flattenLiveUi(locale: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (source: Record<string, unknown>, prefix: string): void => {
    for (const [key, value] of Object.entries(source)) {
      const path2 = `${prefix}.${key}`
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        walk(value as Record<string, unknown>, path2)
      } else {
        out.set(path2, String(value))
      }
    }
  }
  const block = catalogue(locale)['overviewLiveUi']
  assert.ok(block, `${locale} has no overviewLiveUi block`)
  walk(block as Record<string, unknown>, 'overviewLiveUi')
  return out
}

/** 把 `settingsUi` 摊平，用来验证新设置项的文案真的存在于四种语言里。 */
function flattenSettingsUi(locale: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (source: Record<string, unknown>, prefix: string): void => {
    for (const [key, value] of Object.entries(source)) {
      const path2 = `${prefix}.${key}`
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        walk(value as Record<string, unknown>, path2)
      } else {
        out.set(path2, String(value))
      }
    }
  }
  walk(catalogue(locale)['settingsUi'] as Record<string, unknown>, 'settingsUi')
  return out
}

// ---------------------------------------------------------------------------
// 判定：「有在工作」是什么
// ---------------------------------------------------------------------------

describe('camera auto-play decision', () => {
  it('plays a camera that is registered, online and has an enabled RTSP source', () => {
    const decision = decideCameraAutoPlay(world({ rtspAvailability: 'enabled' }))
    assert.equal(decision.action, 'start')
    assert.equal(decision.reason, null)
  })

  it('plays when RTSP availability has not been learned yet, so the main process can answer', () => {
    // 「未知」不是「大概可以」：本应用没有一条只读视频配置的通道，所以第一次必须由
    // 主进程去问设备，并把设备的话原样带回来。这一次尝试就是 `alreadyAttempted`
    // 存在的理由——它保证「问一次」，而不是「一直问」。
    const decision = decideCameraAutoPlay(world({ rtspAvailability: 'unknown' }))
    assert.equal(decision.action, 'start')
  })

  it('does nothing when the setting is off', () => {
    const decision = decideCameraAutoPlay(world({ autoPlayEnabled: false, rtspAvailability: 'enabled' }))
    assert.equal(decision.action, 'skip')
    assert.equal(decision.reason, 'disabled')
  })

  it('does nothing when no camera is registered', () => {
    const decision = decideCameraAutoPlay(world({ cameraRegistered: false, deviceId: '' }))
    assert.equal(decision.action, 'skip')
    assert.equal(decision.reason, 'no-camera')
    // 一台相机都没有时，即使调用方误传了一个 id 也不能起播。
    const inconsistent = decideCameraAutoPlay(world({ cameraRegistered: false, deviceId: 'cam-1' }))
    assert.equal(inconsistent.reason, 'no-camera')
  })

  it('does nothing when the camera is offline or its status is unknown', () => {
    for (const status of ['OFFLINE', 'UNKNOWN']) {
      const decision = decideCameraAutoPlay(world({ deviceStatus: status }))
      assert.equal(decision.action, 'skip', status)
      assert.equal(decision.reason, 'offline', status)
    }
  })

  it('does nothing when the device says RTSP is off, or the video address cannot be built', () => {
    for (const availability of ['disabled', 'unavailable'] as const) {
      const decision = decideCameraAutoPlay(world({ rtspAvailability: availability }))
      assert.equal(decision.action, 'skip', availability)
      assert.equal(decision.reason, 'rtsp-disabled', availability)
    }
  })

  it('does nothing when the bundled ffmpeg is missing', () => {
    const decision = decideCameraAutoPlay(world({ sessionStatus: 'ffmpeg-missing' }))
    assert.equal(decision.action, 'skip')
    assert.equal(decision.reason, 'ffmpeg-missing')
  })

  it('adopts a session that is already playing instead of starting a second one', () => {
    // 这是「另一个页面正在播放」在判定层的样子：一台相机只有一条会话，再 start 一次
    // 会把对方的画面换掉，所以结论只能是接管。
    for (const status of ['starting', 'playing'] as const) {
      const decision = decideCameraAutoPlay(world({ sessionStatus: status }))
      assert.equal(decision.action, 'adopt', status)
      assert.equal(decision.reason, 'session-active', status)
    }
    assert.equal(isSessionActive('playing'), true)
    assert.equal(isSessionActive('idle'), false)
    assert.equal(isSessionActive(null), false)
  })

  it('never auto-plays again after the operator stopped it manually', () => {
    const decision = decideCameraAutoPlay(world({ manualStopped: true, rtspAvailability: 'enabled' }))
    assert.equal(decision.action, 'skip')
    assert.equal(decision.reason, 'manual-stop')
    // 手动停止优先于「本次已经尝试过」：先停止、再手动开始之后，那一位会被清掉，
    // 而这一位必须留下来（见下一条）。
    const alsoAttempted = decideCameraAutoPlay(
      world({ manualStopped: true, alreadyAttempted: true, rtspAvailability: 'enabled' })
    )
    assert.equal(alsoAttempted.reason, 'manual-stop')
  })

  it('does nothing on a second decision within the same application start', () => {
    const first = decideCameraAutoPlay(world({ rtspAvailability: 'enabled' }))
    assert.equal(first.action, 'start')
    // 调用方在真的去 start 之前就把「已尝试」记下来，所以同一个世界再问一次必然 skip。
    const second = decideCameraAutoPlay(world({ rtspAvailability: 'enabled', alreadyAttempted: true }))
    assert.equal(second.action, 'skip')
    assert.equal(second.reason, 'already-attempted')
  })

  it('reports a fact rather than a fault for every skip', () => {
    // 逐个走一遍：skip 一定带原因，且原因只能是那八个事实之一。
    const reasons = [
      decideCameraAutoPlay(world({ autoPlayEnabled: false })).reason,
      decideCameraAutoPlay(world({ cameraRegistered: false })).reason,
      decideCameraAutoPlay(world({ deviceStatus: 'OFFLINE' })).reason,
      decideCameraAutoPlay(world({ rtspAvailability: 'disabled' })).reason,
      decideCameraAutoPlay(world({ sessionStatus: 'ffmpeg-missing' })).reason,
      decideCameraAutoPlay(world({ alreadyAttempted: true })).reason,
      decideCameraAutoPlay(world({ manualStopped: true })).reason
    ]
    assert.deepEqual(reasons, [
      'disabled',
      'no-camera',
      'offline',
      'rtsp-disabled',
      'ffmpeg-missing',
      'already-attempted',
      'manual-stop'
    ])
    assert.ok(reasons.every((reason) => reason !== null))
  })

  it('is a pure function of its input', () => {
    const input = world({ rtspAvailability: 'enabled' })
    assert.deepEqual(decideCameraAutoPlay(input), decideCameraAutoPlay(input))
    // 判定不得改动调用方传进来的对象（否则「读一次世界」会变成一次写操作）。
    const before = JSON.stringify(input)
    decideCameraAutoPlay(input)
    assert.equal(JSON.stringify(input), before)
  })
})

// ---------------------------------------------------------------------------
// RTSP 可用性：从会话状态里学到的**事实**
// ---------------------------------------------------------------------------

describe('RTSP availability learned from a session', () => {
  it('remembers the device saying RTSP is off', () => {
    assert.equal(
      rtspAvailabilityFromState('unknown', state({ status: 'rtsp-disabled' })),
      'disabled'
    )
  })

  it('treats a missing video address as unavailable', () => {
    // 主进程说「设备未上报 video_port 或 video_url」：这是 RTSP 这一侧的结论，
    // 下一次自动起播不该再去撞一次。
    assert.equal(
      rtspAvailabilityFromState('unknown', state({ status: 'error', error: '设备未上报 video_port 或 video_url' })),
      'unavailable'
    )
  })

  it('does not blame RTSP for a stream that was working and then broke', () => {
    // 已经出过帧的失败说明地址本来是通的。
    assert.equal(
      rtspAvailabilityFromState('enabled', state({ status: 'error', error: '视频流中断' })),
      'enabled'
    )
  })

  it('learns availability from a session that reached a first frame', () => {
    assert.equal(rtspAvailabilityFromState('unknown', state({ status: 'playing' })), 'enabled')
    assert.equal(rtspAvailabilityFromState('unknown', state({ status: 'starting' })), 'enabled')
  })

  it('keeps what it knew when there is nothing new to learn', () => {
    const previous: CameraRtspAvailability = 'enabled'
    assert.equal(rtspAvailabilityFromState(previous, null), 'enabled')
    assert.equal(rtspAvailabilityFromState(previous, state({ status: 'idle' })), 'enabled')
    assert.equal(rtspAvailabilityFromState(previous, state({ status: 'ffmpeg-missing' })), 'enabled')
  })
})

// ---------------------------------------------------------------------------
// 呈现：绝不出现一个永远转圈的黑框
// ---------------------------------------------------------------------------

describe('live video view model', () => {
  /** 构件：`cameras` 台相机 + 一个可选的会话。 */
  function view(sessionStatus: string | null, extra: Record<string, unknown> = {}) {
    return cameraLiveViewModel({
      cameraCount: 1,
      sessionStatus: sessionStatus as never,
      ...extra
    })
  }

  it('explains that no camera is registered instead of drawing an empty player', () => {
    const model = cameraLiveViewModel({ cameraCount: 0, sessionStatus: null })
    assert.equal(model.state, 'no-camera')
    assert.equal(model.videoUrl, '')
    assert.equal(model.attached, false)
    assert.equal(model.messageKey, 'overviewLiveUi.noCameraHint')
  })

  it('shows an honest sentence for a camera that is not playing, never an empty <video>', () => {
    // 这就是「组件级/状态级」的那条断言：非播放状态下 `videoUrl` 必然为空，
    // 于是模板里那个 `v-if="videoUrl"` 不会成立，画出来的是文字。
    for (const status of ['idle', 'rtsp-disabled', 'ffmpeg-missing', 'error', 'limit-exceeded']) {
      const model = view(status, { sessionUrl: 'http://127.0.0.1:1/leak/stream.mp4' })
      assert.equal(model.videoUrl, '', status)
      assert.equal(model.attached, false, status)
      assert.ok(model.messageKey !== '', `${status} must explain itself`)
      assert.ok(model.statusKey.startsWith('overviewLiveUi.status'), status)
    }
  })

  it('reports the app own concurrent-stream budget as an app fact, not a camera fault', () => {
    // `limit-exceeded` 是主进程「本机预算满了」的结论：相机没问题，RTSP 也没问题。
    // 把它显示成流故障会把操作员引到错误的排查方向上。
    const model = view('limit-exceeded', { diagnosis: '已达到同时直播上限（最多 4 路，当前 4 路正在播放）' })
    assert.equal(model.state, 'limit-exceeded')
    assert.equal(model.tone, 'warn')
    assert.equal(model.videoUrl, '')
    assert.equal(model.messageKey, 'overviewLiveUi.diagnosis')
    assert.ok(model.messageParams.reason?.includes('最多 4 路'))
    // 没有主进程原文时也要有话可说。
    assert.equal(view('limit-exceeded').messageKey, 'overviewLiveUi.limitExceededHint')
  })

  it('hands the loopback URL to the player only while starting or playing', () => {
    const url = 'http://127.0.0.1:51321/token/stream.mp4'
    const starting = view('starting', { sessionUrl: url })
    assert.equal(starting.videoUrl, url)
    assert.equal(starting.attached, true)

    const playing = view('playing', { sessionUrl: url })
    assert.equal(playing.videoUrl, url)
    assert.equal(playing.attached, true)
    // 正常播放时不需要额外解释——画面本身就是答案。
    assert.equal(playing.messageKey, '')
  })

  it('never claims to play when a session exists but has no address yet', () => {
    const model = view('starting', { sessionUrl: undefined })
    assert.equal(model.videoUrl, '')
    assert.equal(model.attached, false)
  })

  it('leaves the picture to the other page instead of stealing the single viewer', () => {
    const model = view('playing', {
      sessionUrl: 'http://127.0.0.1:51321/token/stream.mp4',
      heldByAnotherPage: true
    })
    assert.equal(model.state, 'occupied')
    assert.equal(model.videoUrl, '')
    assert.equal(model.attached, false)
    assert.equal(model.tone, 'warn')
    assert.equal(model.messageKey, 'overviewLiveUi.occupiedHint')
  })

  it('quotes the main process diagnosis for every failing state', () => {
    const diagnosed = cameraLiveViewModel({
      cameraCount: 1,
      sessionStatus: 'error',
      diagnosis: 'rtsp://cam: Invalid data found when processing input'
    })
    assert.equal(diagnosed.messageKey, 'overviewLiveUi.diagnosis')
    assert.equal(diagnosed.diagnosis, 'rtsp://cam: Invalid data found when processing input')
    assert.deepEqual(diagnosed.messageParams, {
      reason: 'rtsp://cam: Invalid data found when processing input'
    })

    // 设备亲口说的 `rtsp_enabled=0` 也必须原样出现在界面上。
    const disabled = cameraLiveViewModel({
      cameraCount: 1,
      sessionStatus: 'rtsp-disabled',
      diagnosis: '相机的 RTSP 服务处于关闭状态（设备上报 rtsp_enabled=0）'
    })
    assert.equal(disabled.messageKey, 'overviewLiveUi.diagnosis')
    assert.ok(disabled.messageParams.reason?.includes('rtsp_enabled=0'))
  })

  it('falls back to its own hint when the main process has nothing to say', () => {
    assert.equal(view('rtsp-disabled').messageKey, 'overviewLiveUi.rtspDisabledHint')
    assert.equal(view('ffmpeg-missing').messageKey, 'overviewLiveUi.ffmpegMissingHint')
    assert.equal(view('error').messageKey, 'overviewLiveUi.errorHint')
    assert.equal(view('idle').messageKey, 'overviewLiveUi.idleHint')
  })

  it('maps each state to a class name that actually exists in the stylesheet', () => {
    assert.equal(cameraLiveBadgeClass('ok'), 'badge badge--success')
    assert.equal(cameraLiveBadgeClass('warn'), 'badge badge--warning')
    assert.equal(cameraLiveBadgeClass('danger'), 'badge badge--danger')
    assert.equal(cameraLiveBadgeClass('idle'), 'badge')
    assert.equal(cameraLiveMessageClass('warn'), 'alert alert--warning')
    assert.equal(cameraLiveMessageClass('danger'), 'alert alert--danger')
    assert.equal(cameraLiveMessageClass('idle'), 'muted')
  })
})

// ---------------------------------------------------------------------------
// 组件模板：`<video>` 必须挂在地址上
// ---------------------------------------------------------------------------

describe('CameraVideoWall template', () => {
  /**
   * 组件源码的静态检查。
   *
   * 这一条守的是一个纯粹的模板缺陷：把 `<video>` 的 `v-if` 换成别的条件（或者删掉），
   * 前面那些状态断言会全部照过，而界面上出现的是一个没有地址的播放器——黑框或浏览器
   * 自带的「无法播放」。把「地址是唯一开关」这句话钉在真实文件上，比在测试里重写一份
   * 模板更有意义。
   *
   * **这一组原本指向 `CameraLiveSection.vue`**（总览页的单路播放器）。总览改成多格视频墙
   * 之后那个组件不再被任何页面渲染，而"测试还在读它的源码"并不构成保留死代码的理由 ——
   * 那只会让断言看起来很安心，实际上守着一个没人渲染的文件。所以断言改指向视频墙
   * （现在真正画播放器的那个组件），死组件随之删除。
   */
  const source = readFileSync(
    path.resolve(__dirname, '../../src/renderer/src/components/CameraVideoWall.vue'),
    'utf8'
  )

  it('renders a player only for a cell that has a loopback address AND is live', () => {
    // 找真正的 `<video` 开标签。注意不能用 `indexOf('<video')`：本文件的注释里到处
    // 写着 `<video>`（说明为什么不能画一个没有地址的播放器），那样会把散文当成标签。
    // 标签的判据是 `<video` 后面紧跟空白（属性和元素名之间一定有分隔）。
    const tags = [...source.matchAll(/<video(?=\s)/g)]
    assert.ok(tags.length >= 1, `expected at least one <video> element, found ${tags.length}`)
    for (const tag of tags) {
      const opening = tag.index ?? 0
      const openTag = source.slice(opening, source.indexOf('>', opening) + 1)
      assert.match(
        openTag,
        /v-if="[^"]*cell\.url[^"]*"/,
        `every <video> must be guarded by its address:\n${openTag}`
      )
    }
  })

  it('renders a framed placeholder in the same place when there is no address', () => {
    // 没有画面时那一格必须是一块**有边框的占位区**，而不是留着 <video> 的黑矩形。
    assert.match(
      source,
      /'camera-wall__cell--placeholder':\s*!isCameraCellLive\(cell\.status\)/,
      'a non-live cell must carry the placeholder class'
    )
    // 占位区容器。这一条原本钉的是空白格里那句「空格子」文案
    // （`class="camera-wall__placeholder"`）；产品把空白格简化成右侧一个 `+` 号之后
    // 那句话没有了，所以断言改为钉住**容器**本身：没有 <video> 的格子里一定有一块
    // `.camera-wall__body`，而不是一块黑矩形。它守的仍然是原来那个缺陷
    // （把 `<video>` 的 v-if 改坏/删掉，界面上就出现一个没有地址的播放器）。
    assert.match(source, /class="camera-wall__body"/)
    // 空白格的入口：右侧那个 `+`，而且它**必须有名字** —— 本项目禁止没有无障碍
    // 名字的纯图标控件，删掉 aria-label 会让读屏用户只听到一个「按钮」。
    assert.match(source, /class="camera-wall__add"/)
    assert.match(source, /:aria-label="t\('cameraWallUi\.assignToCell'\)"/)
  })

  it('一格里只有底部那一条控制条，而且每个控件都说得出自己的名字', () => {
    // 顶部叠加条上那一排按钮（停止 / 关闭声音 / 全屏 / 关闭）必须消失：一格里有两条
    // 控件条，就是「同一件事在两个地方各说一遍」。
    assert.equal(
      source.includes('camera-wall__btn'),
      false,
      '顶部叠加条的按钮类名（camera-wall__btn）又出现了'
    )
    const bar = source.slice(source.indexOf('class="camera-wall__bar"'))
    assert.ok(bar.length > 0, '没有底部控制条（.camera-wall__bar）')
    const barBlock = bar.slice(0, bar.indexOf('</div>'))
    /*
     * 控制条里**只有六颗播放器控件**（业主 2026-09-19 第 12 批：
     * 「播放器窗口应该只有告警，全屏，暂停，切换录像，音量，手动录像」），顺序就是他给的顺序。
     *
     * 四颗视图按钮**不在这里了**（第 12 批把它们移进右键菜单的「显示方式」），
     * 音量也不再是一条常驻的横滑杆（点音量才弹出竖条，那一块在控制条**外面**）。
     * 这一条守的两件事没变：一格只有一条控制条、每个控件都说得出自己的名字。
     */
    const actions = [...barBlock.matchAll(/data-action="(cell-[a-z-]+)"/g)].map((match) => match[1])
    assert.deepEqual(
      actions,
      ['cell-alarm', 'cell-fullscreen', 'cell-play', 'cell-playback', 'cell-volume', 'cell-record'],
      '底部控制条的六颗控件不是业主第 12 批给的那六颗（或顺序不对）'
    )
    assert.equal((barBlock.match(/<button/g) ?? []).length, 6, '底部控制条的按钮数（应为 6）')
    assert.equal(
      barBlock.includes('cell-view-'),
      false,
      '控制条上又出现了视图按钮（第 12 批已把它们移进「显示方式」菜单）'
    )
    assert.equal((barBlock.match(/type="range"/g) ?? []).length, 0, '控制条上不该再有滑杆')
    // 音量浮层（点音量按钮才出现的那一条**竖**滑杆）在控制条外面、格子里。
    assert.match(source, /data-cell-volume-pop/, '没有音量浮层')
    assert.match(source, /class="camera-wall__volume-slider"/, '音量浮层里没有滑杆')
    // 每个控件都必须有无障碍名字，而且 `aria-label` 与 `title` 是**同一个值**：名字与
    // 提示不一致时，读屏用户听到的与鼠标用户看到的是两回事。
    const labels = [...barBlock.matchAll(/:aria-label="([^"]+)"/g)].map((match) => match[1])
    const titles = [...barBlock.matchAll(/:title="([^"]+)"/g)].map((match) => match[1])
    assert.equal(
      labels.length,
      6,
      '底部控制条里有控件没有 aria-label（六颗按钮）'
    )
    /*
     * 六颗控件的名字与提示**必须逐字相同**（第 12 批之后不再有例外：视图按钮从控制条上
     * 移走之后，那个"名字是视图名、提示是原因"的特例跟着进了菜单 —— 菜单自己就是用
     * `title` 显示禁用原因的，`VideoContextMenu` 的既有做法）。
     */
    assert.deepEqual(labels, titles, '底部控制条的 aria-label 与 title 必须一致')
    for (const label of labels) {
      assert.ok(
        typeof label === 'string' && label.trim() !== '' && !label.includes('undefined'),
        `控件的名字是空的：${String(label)}`
      )
    }
    // 原生控件必须关掉，否则一格里有浏览器的一条、我们的一条。
    const videos = [...source.matchAll(/<video(?=\s)[\s\S]*?>/g)].map((match) => match[0])
    assert.ok(videos.length >= 1, '找不到 <video> 元素')
    for (const video of videos) {
      assert.equal(/\scontrols(\s|>)/.test(video), false, `原生 controls 必须去掉：\n${video}`)
    }
  })

  it('空白格只有一个 `+`：没有文字、没有格内的下拉框', () => {
    // 加号必须是**画出来**的（两条 SVG 线），不能是文字 —— 空白格里任何一个文本节点
    // 都是产品明确不要的「文字说明」。
    const addStart = source.indexOf('class="camera-wall__add"')
    assert.ok(addStart >= 0, '没有空白格的入口按钮')
    const addBlock = source.slice(addStart, source.indexOf('</button>', addStart))
    assert.equal(addBlock.includes('+'), false, `空白格里出现了字面的加号文本：\n${addBlock}`)
    assert.match(addBlock, /class="camera-wall__plus"/)
    const plusStart = addBlock.indexOf('camera-wall__plus')
    const plusBlock = addBlock.slice(plusStart, addBlock.indexOf('</svg>', plusStart))
    assert.equal((plusBlock.match(/<line/g) ?? []).length, 2, '加号应当是两条线')
    /*
     * 选择器**不再**是藏在墙末尾的原生 `<select>`（业主 2026-09-18 报的 bug：点「+」
     * 之后「弹出来请选择相机，但位置被盖住 / 没有显示出来」—— 原生下拉贴在墙末尾那个
     * 1×1 的 `.visually-hidden` 宿主上，离被点的那一格有几百像素）。现在是一块自己画的
     * 浮层（`CameraCellPicker`，Teleport 到 `<body>`、位置由 `placeCameraPicker()` 算），
     * 所以空白格的 DOM 里既没有 `<select>` 也没有 `<option>` —— 格里仍然一个字都不写。
     *
     * 断言看的是**去掉注释**之后的源码：解释这件事的注释里就有 `showPicker` 这几个字母。
     */
    const codeOnly = source
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    assert.match(codeOnly, /<CameraCellPicker/)
    assert.equal(codeOnly.includes('wall-pick-'), false, '又出现了「墙级别隐藏 <select>」那种写法')
    assert.equal(codeOnly.includes('showPicker'), false, '又用回 showPicker() 了')
  })

  it('改「当前设备」不会直接起流：它只让自动起播被重新评估一次', () => {
    // 这条断言原来钉的是「activeDeviceId 变了绝不让主进程起一条流」。规则本身没变
    // （起流只可能来自操作员动作或那**一次**自动起播判定），变的是失效场景：原来
    // 只在挂载时判定一次，设备的在线状态或列表稍后才到就永远没有画面了，所以判定现在
    // 挂在 `autoPlaySignal` 上，而 `activeDeviceId` 是那个签名的一部分。
    // 这里断言：那个 watcher 自己不调 `cameraLive.start`，而且全组件只有**一处**
    // `await cameraLive.autoPlayIfWorking(`。
    const start = source.indexOf('() => props.activeDeviceId,\n  (deviceId) => {')
    assert.ok(start >= 0, 'could not locate the active-device watcher')
    const end = source.indexOf('\n)\n', start)
    const block = source.slice(start, end === -1 ? start + 1200 : end)
    assert.ok(block.length > 0, 'the active-device watcher block is empty')
    assert.ok(
      !block.includes('cameraLive.start'),
      `changing the active device must not start a stream directly:\n${block}`
    )
    // 签名里必须有 activeDeviceId，否则「切换设备」这件事再也不会被评估到。
    assert.match(source, /props\.activeDeviceId \?\? ''/)
    assert.equal(
      (source.match(/await cameraLive\.autoPlayIfWorking\(/g) ?? []).length,
      1,
      '自动起播的判定出现了不止一处调用'
    )
  })

  /**
   * 第 1 条（业主 2026-09-18 第 10 批）：「每次打开总览界面默认开启视频流」。
   *
   * 原来落不了地的原因很具体：`already-attempted` 那一位活在模块作用域里、清空时机是
   * **一次应用启动**，所以第一次进总览起播过之后，再进总览永远是"本次已经试过了"。
   * 改法是把清空时机挪到**进页面**：`resetAutoPlayAttempts()` 只清"试过了吗"，
   * **不动** "操作员按过停止"那一位。
   *
   * 为什么这一条只能靠源码守卫：那两个集合是模块私有的运行时状态（不在 store 里，
   * 它们必须活在"一次进程"这一层，见 store 里的注释），单测 import 不到它们的内容；
   * 而**它们各自的语义**（清哪个、不清哪个）正是这一条要求的全部。
   */
  it('每次进入总览/监测页都重新允许一次自动起播，但「手动停止」不许被清掉', () => {
    const store = readFileSync(
      path.resolve(__dirname, '..', '..', 'src', 'renderer', 'src', 'stores', 'cameraLive.ts'),
      'utf8'
    )
    const start = store.indexOf('export function resetAutoPlayAttempts(')
    assert.ok(start >= 0, 'store 里没有 resetAutoPlayAttempts()')
    const body = store.slice(start, store.indexOf('\n}', start))
    assert.match(body, /autoPlayAttempted\.clear\(\)/, '它没有清"这一轮试过了吗"')
    assert.equal(
      /manualStopped/.test(body),
      false,
      '它把「操作员按过停止」也清了：换一次页面就会把用户明确关掉的画面放回来'
    )
    // 与「模拟一次新启动」那个函数必须区分开：那个是清全部（测试与重新登录用）。
    const fullReset = store.slice(store.indexOf('export function resetAutoPlayGuards('))
    assert.match(
      fullReset.slice(0, fullReset.indexOf('\n}')),
      /manualStopped\.clear\(\)/,
      'resetAutoPlayGuards() 不再是"清全部"：它和进页面那一次会变成同一个东西'
    )

    // 两页都要在**挂载时**清一次，而且要在自动起播那一次调用**之前**。
    for (const [label, file, marker] of [
      ['总览的画面墙', 'CameraVideoWall.vue', 'await requestAutoPlay()'],
      ['实时监测的相机', 'MonitorView.vue', 'await autoPlayCameraIfWorking()']
    ] as const) {
      const page = readFileSync(
        path.resolve(__dirname, '..', '..', 'src', 'renderer', 'src', label.includes('总览') ? 'components' : 'views', file),
        'utf8'
      )
      const mounted = page.indexOf('onMounted(async () => {')
      assert.ok(mounted >= 0, `${file} 里找不到 onMounted`)
      const mountedBody = page.slice(mounted, page.indexOf('\n})', mounted))
      const resetAt = mountedBody.indexOf('resetAutoPlayAttempts()')
      const playAt = mountedBody.indexOf(marker)
      assert.ok(resetAt >= 0, `${label} 挂载时没有重新允许自动起播（第 1 条落不了地）`)
      assert.ok(
        playAt >= 0 && resetAt < playAt,
        `${label} 的清空排在自动起播之后：那一次仍然是"本次已经试过了"`
      )
    }
  })

  it('重新评估是事件驱动的：一个 watch 盯住输入签名，没有轮询', () => {    // 输入的四个来源（设备列表、设备状态、activeDeviceId、设置）压成一个 computed
    // 签名，签名变了才重新评估。用 computed 而不是定时器：只有真的变了才通知。
    assert.match(source, /const autoPlaySignal = computed\(/)
    assert.match(source, /watch\(autoPlaySignal,/)
    // `scheduleSettleRefresh` 的 setTimeout 是一次性的补读（起播之后把 starting 换成
    // playing），它不参与判定，也不重试。第二个 setTimeout 是 2026-09-22 业主第 8 条
    // 加的一次性**断流自动重试**（`onCellVideoProblem`，每设备只试一次）——它只在
    // 视频出错那一刻触发，同样不参与自动起播的判定，更不是轮询。
    const setTimeouts = [...source.matchAll(/window\.setTimeout/g)].map((match) => match.index ?? -1)
    assert.equal(setTimeouts.length, 2, '组件里出现了计划外的定时器')
    const retryAt = source.indexOf('function onCellVideoProblem')
    const retryEnd = source.indexOf('async function startCell')
    assert.ok(
      retryAt >= 0 && retryEnd > retryAt &&
      setTimeouts.some((index) => index > retryAt && index < retryEnd),
      '第二个定时器不在 onCellVideoProblem（一次性断流重试）里'
    )
    // 判定那一段（从目标相机的 computed 到挂载钩子）里不许有周期任务：
    // 「自动起播被写成轮询」是这个缺陷的名字，所以规则钉在那一段上，而不是钉在
    // 「整份文件只许有一个 setInterval」上 —— 录像指示器的走动计时器与自动起播
    // 毫无关系（见下一条），把它算进来只会让这条断言变成一句关于文件大小的空话。
    // 那一段里唯一允许的定时器是 `scheduleSettleRefresh()` 的**一次性**补读。
    const autoPlayStart = source.indexOf('const autoPlayTarget = computed')
    const autoPlayEnd = source.indexOf('onMounted(async () => {')
    assert.ok(autoPlayStart >= 0 && autoPlayEnd > autoPlayStart, '找不到自动起播那一段')
    const autoPlayBlock = source.slice(autoPlayStart, autoPlayEnd)
    assert.equal(autoPlayBlock.includes('setInterval'), false, '自动起播被写成了轮询')
    const settleStart = autoPlayBlock.indexOf('function scheduleSettleRefresh')
    const settles = [...autoPlayBlock.matchAll(/window\.setTimeout/g)].map((match) => match.index ?? -1)
    assert.equal(settles.length, 1, '自动起播那一段里出现了第二个定时器')
    assert.ok(settleStart >= 0 && (settles[0] ?? -1) > settleStart, '定时器不在一次性补读函数里')
  })

  it('组件里只有两条周期任务：录像计时器（逐格可清）与轮询轮换（卸载即清）', () => {
    // 录像指示器上的时长必须走动、轮询队列每 10 秒要轮一格，所以组件里**确实**需要
    // 周期任务。它们必须满足：
    //   - 各只有一处（`startRecordingTimer()` 里一处；轮换那处在挂载时挂上）；
    //   - 录像计时器按格号存进一张表，停止/清空格子/卸载时都能清掉（否则就是一个
    //     持有闭包的静默泄漏，而同一条规则在 `MonitorView` 上也写着）；轮换那条在
    //     `onUnmounted` 里 `clearInterval`，离开页面就不许再转；
    //   - 录像那条停止那一刻时长归零，不会留着一个还在走的旧基准。
    const timers = [...source.matchAll(/setInterval\(/g)]
    assert.equal(timers.length, 2, `组件里有 ${timers.length} 处 setInterval，只允许录像计时器与轮换各一处`)
    const start = source.indexOf('function startRecordingTimer')
    const stop = source.indexOf('function stopRecordingTimer')
    assert.ok(start >= 0 && stop >= 0, '没有录像计时器的启停函数')
    assert.ok((timers[0]?.index ?? -1) > start, 'setInterval 不在 startRecordingTimer() 里')
    // 轮换那一条：常量 + 挂载时挂 + 卸载时清，三件套缺一不可。
    assert.match(source, /WALL_ROTATION_INTERVAL_MS = 10_000/)
    const mounted = source.slice(source.indexOf('onMounted(async () => {'))
    assert.ok(mounted.slice(0, mounted.indexOf('\n})')).includes('setInterval(onRotationTick'), '挂载时没有起轮换定时器')
    assert.match(source, /clearInterval\(rotationTimer\)/)
    assert.match(source, /recordingTimers\.set\(/)
    assert.match(source, /recordingTimers\.delete\(/)
    assert.match(source, /function stopAllRecordingTimers\(\)/)
    // 卸载时必须真的调它，否则离开页面会留下一个没人拥有的周期任务。
    const unmount = source.slice(source.indexOf('onUnmounted(() => {'))
    assert.ok(
      unmount.slice(0, unmount.indexOf('\n})')).includes('stopAllRecordingTimers()'),
      '卸载时没有清掉录像计时器'
    )
  })

  it('先上墙、再判定：没有槽位就没有 <video>，起了也没地方画', () => {
    // 墙的格子分配刻意不持久化（见 `stores/liveWall`），所以一台还没上墙的相机没有
    // 槽位、也就没有 `<video>`。顺序反了就会同时成立「主进程在拉流」与「界面上没有
    // 任何地方能画它」。
    const start = source.indexOf('async function autoPlayOnce')
    const end = source.indexOf('const autoPlaySignal', start)
    const block = source.slice(start, end === -1 ? start + 2000 : end)
    const place = block.indexOf('wall.placeDevice')
    const decide = block.indexOf('await cameraLive.autoPlayIfWorking(')
    assert.ok(place >= 0, '没有把目标相机放上墙')
    assert.ok(decide >= 0, '没有调用判定函数')
    assert.ok(place < decide, `上墙必须发生在判定之前：\n${block}`)
  })
})

// ---------------------------------------------------------------------------
// 右键菜单与逐格录像：组件源码里的那几条硬规则
// ---------------------------------------------------------------------------

describe('CameraVideoWall: 画面格右键菜单与逐格录像', () => {
  const source = readFileSync(
    path.resolve(__dirname, '../../src/renderer/src/components/CameraVideoWall.vue'),
    'utf8'
  )

  it('菜单项只来自纯函数，组件里没有第二份「存在/可点」判断', () => {
    // `buildCameraNvrMenu()` 是菜单项**唯一**的来源（`MonitorView` 的单路面板读的
    // 是同一份）。一旦组件自己写一个 `visible:` / `enabled:`，两个界面的菜单就会
    // 开始漂移 —— 那正是这个模型存在要防的事情。
    assert.ok(source.includes('buildCameraNvrMenu(liveStateOf(cell), cellNvrEnvironment(cell))'))
    assert.equal(
      (source.match(/\bvisible\s*:/g) ?? []).length,
      0,
      '组件里又出现了 visible 判断'
    )
    assert.equal(
      (source.match(/\benabled\s*:/g) ?? []).length,
      0,
      '组件里又出现了 enabled 判断'
    )
  })

  it('菜单挂在被右键的那一格上：title 就是那一格的设备名', () => {
    // 「动作作用在右键的那一格」不是靠「当前所选设备」实现的：菜单状态里记的是
    // 格号，title 直接从那一格的渲染模型上取设备名。
    assert.match(source, /@contextmenu="onCellContextMenu\(cell, \$event\)"/)
    assert.match(source, /const menuTitle = computed\(\(\) => menuCell\.value\?\.deviceName \?\? ''\)/)
    assert.match(source, /:title="menuTitle"/)
    assert.match(source, /:items="menuItems"/)
  })

  it('没有相机的格子不打开相机菜单，而且连原生菜单都不拦', () => {
    // 产品要求空白格只有一个 `+`；而模型对一台不存在的相机只会给出一屏灰项
    // （回放/下载/清空这三项在模型里恒为 true）。所以守卫必须**先返回**，理由也
    // 必须写下来 —— 下一个人很容易把它当成一句多余的 if 删掉。
    const start = source.indexOf('async function onCellContextMenu')
    const end = source.indexOf('function closeMenu')
    assert.ok(start >= 0 && end > start, '找不到右键处理函数')
    const block = source.slice(start, end)
    const guard = block.indexOf("if (cell.deviceId === null || cell.kind !== 'acousticCamera') return")
    const prevent = block.indexOf('event.preventDefault()')
    assert.ok(guard >= 0, '没有「空白格不打开相机菜单」的守卫')
    assert.ok(prevent > guard, '守卫必须发生在 preventDefault() 之前')
    assert.ok(/[\u4e00-\u9fff]/.test(block), '这个决定没有中文说明')
  })

  it('画面格声明全部五项能力：三项可选能力缺省即隐藏，界面实现了就必须声明', () => {
    // `localPlayback` / `detectDownload` / `tileClose` 在模型里是**可选**的，
    // 缺省即不显示。本组件已经接上了对应的弹窗与清空路径，所以必须逐项声明；
    // 少一项，菜单里就少一个入口，而且不会有任何报错。
    for (const key of ['localPlayback: true', 'detectDownload: true', 'tileClose: true']) {
      assert.ok(source.includes(key), `画面格没有声明能力 ${key}`)
    }
  })

  it('模型给出的九个动作全部有派发分支（没有一个掉进静默的 default）', () => {
    // 菜单项与派发之间唯一的契约就是 action id。少一个 case，那一项点了没反应 ——
    // 这是本仓库明确禁止的「静默的不可点」。「显示/隐藏叠加信息」已按业主 2026-09-21
    // 批移除，所以这里也没有它的分支。
    const actions = [
      'toggle-recording',
      'snapshot',
      'toggle-fullscreen',
      'copy-rtsp',
      'open-external',
      'playback',
      'download-detect',
      'close-tile',
      'alarm-config'
    ]
    for (const action of actions) {
      assert.ok(source.includes(`case '${action}':`), `${action} 没有派发分支`)
    }
  })

  it('「关闭这一格」走既有的清空路径：先停会话，再清格子', () => {
    const start = source.indexOf('async function closeTile')
    const end = source.indexOf('// --- 派发')
    assert.ok(start >= 0 && end > start, '找不到 closeTile()')
    const block = source.slice(start, end)
    const stop = block.indexOf('await stopCell(cell)')
    const clear = block.indexOf('wall.clearCell(cell.index)')
    assert.ok(stop >= 0, '关闭这一格没有停会话（会留下孤儿流）')
    assert.ok(clear > stop, '必须先停会话再清空格子')
  })

  it('每一格的录像状态来自主进程，挂载时会读一次（刷新页面能恢复指示器）', () => {
    assert.match(source, /window\.api\.cameraNvr\.recordingState\(\)/)
    const mounted = source.slice(
      source.indexOf('onMounted(async () => {'),
      source.indexOf('onUnmounted(() => {')
    )
    assert.ok(
      mounted.includes('await refreshRecordingStates()'),
      '挂载时没有读主进程的录像状态：刷新页面后红色指示器会消失，而 ffmpeg 还在写盘'
    )
    // 停止画面之前必须先把录像收尾（那一路的 RTSP 源就是它正在读的东西）。
    const stopCell = source.slice(
      source.indexOf('async function stopCell('),
      source.indexOf('/** 丢掉这一格的画面')
    )
    assert.ok(stopCell.includes('await stopCellRecording(cell, deviceId)'))
    assert.ok(
      stopCell.indexOf('stopCellRecording') < stopCell.indexOf('releaseVideo'),
      '录像收尾必须在释放 <video> 之前'
    )
  })

  it('叠加条永远显示（业主 2026-09-21 批移除了开关），结果提示与录像指示器仍逐格', () => {
    // 「显示/隐藏叠加信息」整体移除：非空格的叠加条没有开关条件，状态必须一直在场。
    assert.match(source, /v-if="cell\.status !== 'empty'" class="camera-wall__overlay"/)
    assert.equal(source.includes('nvrOf(cell.index).overlay'), false, '叠加条又读上了按格开关')
    assert.equal(source.includes('toggleCellOverlay'), false, '叠加开关的处理函数又回来了')
    assert.equal(source.includes('toggle-overlay'), false, '菜单里又出现了「显示/隐藏叠加信息」')
    // 逐格的另外两条还在：录像指示器与结果提示各自按格号判定。
    assert.match(source, /v-if="nvrOf\(cell\.index\)\.recording"/)
    assert.match(source, /v-if="cellNvrMessage\(cell\)"/)
    // 逐格状态按格号索引，而不是整页一份。
    assert.match(source, /const nvrStates = ref<Record<number, CellNvrState>>\(\{\}\)/)
  })

  it('三个对话框都真的挂在墙上，回放与下载之间是一条真接线', () => {
    assert.match(source, /<CameraAlarmDialog/)
    assert.match(source, /<CameraRecordingPlaybackDialog/)
    assert.match(source, /<CameraDetectDownloadDialog/)
    // 下载完成的那一段直接交给回放弹窗（`presetRecordingId`），不是一句「请自行前往
    // 回放页」的提示。
    assert.match(source, /@play="onDownloadedPlay"/)
    assert.match(source, /:preset-recording-id="playbackPresetId"/)
  })
})

// ---------------------------------------------------------------------------
// 目录：新文案必须真的存在于四种语言里
// ---------------------------------------------------------------------------

describe('live video catalogue entries', () => {
  const LIVE_KEYS = [
    'overviewLiveUi.cameraLabel',
    'overviewLiveUi.device',
    'overviewLiveUi.fullscreen',
    'overviewLiveUi.statusNoCamera',
    'overviewLiveUi.statusIdle',
    'overviewLiveUi.statusStarting',
    'overviewLiveUi.statusPlaying',
    'overviewLiveUi.statusRtspDisabled',
    'overviewLiveUi.statusFfmpegMissing',
    'overviewLiveUi.statusError',
    'overviewLiveUi.statusLimitExceeded',
    'overviewLiveUi.statusOccupied',
    'overviewLiveUi.noCameraHint',
    'overviewLiveUi.idleHint',
    'overviewLiveUi.startingHint',
    'overviewLiveUi.rtspDisabledHint',
    'overviewLiveUi.ffmpegMissingHint',
    'overviewLiveUi.errorHint',
    'overviewLiveUi.limitExceededHint',
    'overviewLiveUi.occupiedHint',
    'overviewLiveUi.diagnosis',
    'overviewLiveUi.rtspAddressUnknown'
  ]

  it('has every key in all four languages', () => {
    for (const locale of LOCALES) {
      const messages = flattenLiveUi(locale)
      for (const key of LIVE_KEYS) {
        assert.ok(messages.has(key), `${locale} has no message for ${key}`)
        assert.ok((messages.get(key) ?? '').trim().length > 0, `${locale}.${key} is empty`)
      }
    }
  })

  it('resolves every state label through the catalogue in every language', () => {
    // 模板拿到的只有 key；key 不存在时用户看到的是一串裸 key。
    for (const locale of LOCALES) {
      for (const key of LIVE_KEYS) {
        const resolved = i18n.global.t(key, {}, { locale })
        assert.ok(resolved.length > 0, `${locale}/${key}`)
        assert.ok(!resolved.includes('overviewLiveUi.'), `${locale}/${key} did not resolve`)
      }
    }
  })

  it('never puts the linked-message sigil in a live-video message', () => {
    // `@` 是 vue-i18n 的链接消息前缀：一条含 `@` 的消息在渲染时才会崩掉，
    // 而这条断言让它在测试里就被挡住（`tests/i18n.test.ts` 编译每一条消息）。
    for (const locale of LOCALES) {
      for (const [key, message] of flattenLiveUi(locale)) {
        assert.ok(!message.includes('@'), `${locale}.${key} contains the linked-message sigil`)
      }
    }
  })

  it('names the new setting in all four languages', () => {
    const keys = [
      'settingsUi.liveSection',
      'settingsUi.autoPlayCameraLive',
      'settingsUi.autoPlayOn',
      'settingsUi.autoPlayOff'
    ]
    for (const locale of LOCALES) {
      const messages = flattenSettingsUi(locale)
      for (const key of keys) {
        assert.ok(messages.has(key), `${locale} has no message for ${key}`)
      }
    }
  })

  it('diagnosis keeps the same placeholder in every language', () => {
    // 占位符漂移是最典型的 i18n 缺陷：类型检查通过，界面上出现一个字面的 `{reason}`。
    for (const locale of LOCALES) {
      const message = flattenLiveUi(locale).get('overviewLiveUi.diagnosis') ?? ''
      assert.ok(message.includes('{reason}'), `${locale}/overviewLiveUi.diagnosis lost {reason}`)
    }
  })
})
