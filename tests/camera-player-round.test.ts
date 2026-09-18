/**
 * 相机实时画面：播放器式控制条、音量记忆、翻转（业主 2026-09-18 第 10 批第 20、21 条）。
 *
 * 业主原话（两条）：
 *   「声学相机页选中即 16:9 视频自动播放、音视频同步、音量可调并记住、支持左右/上下/90° 翻转。」
 *   「视频窗口下方是通用播放器式控制条（暂停/播放/录制/查看/回放/告警配置）并删除页面里的播放信息。」
 *
 * WHY THIS FILE EXISTS
 * 五件事"源码里改对了但用户看不到效果"，只有在结构上钉住才能提前拦住：
 *
 *   1. **控制条必须在画面下方**。它在画面上方时源码看起来一模一样（同一个 `btn-row`），
 *      而"播放器的控制条"这个位置本身就是这一条要求的一半。
 *   2. **原生 `controls` 必须关掉**。留着它，页面上就有两条控制条：一条有录制/抓图/回放，
 *      一条只有暂停/音量，用户点哪条都对、也都不对。
 *   3. **音量的"记住"是 localStorage，而且坏值要修**。一个 `NaN` 会让
 *      `<video>.volume = NaN` 抛 `IndexSizeError` —— 表现是"画面起不来"，与音量毫无关系。
 *   4. **自动起播那一遍必须静音**。浏览器的自动播放策略不允许带声音自动播；不静音起播的
 *      结果是 `play()` 被拒 → 画面永远不出来，而源码怎么看都是对的。
 *   5. **90° 必须配 9/16 的缩放**。16:9 的框里转 90° 不缩就会两头裁掉，而"裁掉"在截图上
 *      看起来像"相机的视场变窄了"。
 *
 * 真正跑起来的样子由 `scripts/demo-shot-driver.cjs` 在真实窗口里量（控制条的下边是否在
 * 画面下边之下、滑杆拖动之后 `<video>.volume` 是否真的变了、翻转之后 transform 是否非 none）。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  CAMERA_DEFAULT_VOLUME,
  cameraFlipTransform,
  sanitiseCameraVolume
} from '../src/shared/domain/camera-live-prefs'
import { zhCN } from '../src/shared/i18n/messages/zh-CN'
import { en } from '../src/shared/i18n/messages/en'
import { es } from '../src/shared/i18n/messages/es'
import { tr } from '../src/shared/i18n/messages/tr'

const projectRoot = path.resolve(__dirname, '..', '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

/** 去掉注释之后的源码：断言的是代码，不是散文。 */
function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !(trimmed.startsWith('//') || trimmed.startsWith('*'))
    })
    .join('\n')
}

function templateBlock(source: string): string {
  const open = source.indexOf('<template>')
  const close = source.lastIndexOf('</template>')
  return open >= 0 && close > open ? source.slice(open, close) : ''
}

const CATALOGUES: Record<string, unknown> = { 'zh-CN': zhCN, en, es, tr }

function messageAt(locale: string, key: string): string | undefined {
  let cursor: unknown = CATALOGUES[locale]
  for (const part of key.split('.')) {
    if (!cursor || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return typeof cursor === 'string' ? cursor : undefined
}

const monitor = read('src/renderer/src/views/MonitorView.vue')
const monitorCode = stripComments(monitor)
const monitorTemplate = stripComments(templateBlock(monitor))
const prefs = stripComments(read('src/renderer/src/lib/cameraLivePrefs.ts'))
/** 键前缀与取值规则在 shared 那一半（纯值，见那个文件的头注）。 */
const sharedPrefs = stripComments(read('src/shared/domain/camera-live-prefs.ts'))

describe('音量的"记住"：localStorage + 坏值修好', () => {
  it('坏值一律回默认，而**静音（0）是用户的选择**，不许被当成"没记住"', () => {
    assert.equal(sanitiseCameraVolume('0.5'), 0.5, '字符串数字没有被解析')
    assert.equal(sanitiseCameraVolume(0), 0, '静音被当成了无效值')
    assert.equal(sanitiseCameraVolume('0'), 0, '字符串的 0 被当成了无效值')
    assert.equal(sanitiseCameraVolume(2), 1, '越界值没有收到 1')
    assert.equal(sanitiseCameraVolume(-1), 0, '负数没有收到 0')
    // 这些是最要紧的：`NaN` / 空串 / 别的类型会让 `<video>.volume = NaN` 抛异常。
    for (const bad of [Number.NaN, undefined, null, '', 'abc', {}, [], Number.POSITIVE_INFINITY]) {
      assert.equal(
        sanitiseCameraVolume(bad),
        CAMERA_DEFAULT_VOLUME,
        `坏值 ${JSON.stringify(bad)} 没有被修成默认值`
      )
    }
  })

  it('键里带设备 id（两台相机的拾音电平可以差很多）', () => {
    assert.match(
      prefs,
      /CAMERA_VOLUME_STORAGE_PREFIX\}\$\{deviceId\}/,
      '存储键里没有设备 id：换一台相机会用上一台的音量'
    )
    assert.match(
      sharedPrefs,
      /CAMERA_VOLUME_STORAGE_PREFIX = 'hertzinno\.cameraLive\.volume\.'/,
      '键名没有沿用 hertzinno. 前缀'
    )  })

  it('读写在 localStorage 上，而且写失败（隐私模式/配额）不许让画面出问题', () => {
    assert.match(prefs, /window\.localStorage\.getItem/, '读不是从 localStorage')
    assert.match(prefs, /window\.localStorage\.setItem/, '写不是到 localStorage')
    // 两处都要有 try/catch：隐私模式下 localStorage 会**抛异常**，不是返回 null。
    assert.equal(
      (prefs.match(/catch \{/g) ?? []).length,
      2,
      '读或写没有包 try/catch：隐私模式下会抛异常，而那是偏好不是功能'
    )
  })
})

describe('翻转：左右 / 上下 / 90°，三个独立开关', () => {
  it('三个开关能同时成立（左+右+90° 与只转 90° 不是同一个画面）', () => {
    assert.equal(cameraFlipTransform({ horizontal: true, vertical: true, quarter: true }),
      'scale(-1, -1) rotate(90deg) scale(0.5625)')
    assert.equal(cameraFlipTransform({ horizontal: false, vertical: false, quarter: false }), 'none')
    assert.equal(cameraFlipTransform({ horizontal: true, vertical: false, quarter: false }),
      'scale(-1, 1)')
    assert.equal(cameraFlipTransform({ horizontal: false, vertical: true, quarter: false }),
      'scale(1, -1)')
  })

  it('90° 一定配着 9/16 的缩放（16:9 的框里不缩就会两头裁掉）', () => {
    const transform = cameraFlipTransform({ horizontal: false, vertical: false, quarter: true })
    assert.match(transform, /rotate\(90deg\)/, '90° 那一档没有旋转')
    assert.match(transform, /scale\(0\.5625\)/, '90° 没有配 9/16 的缩放：画面两头会被裁掉')
    // 9/16 = 0.5625 是算出来的（见 `cameraLivePrefs.ts` 的注释），不是试出来的。
    assert.equal(Number((9 / 16).toFixed(4)), 0.5625)
  })

  it('视图把 transform 写进 `style`（CSS 类里的固定值做不到三个开关的组合）', () => {
    assert.match(monitorTemplate, /:style="\{ transform: videoTransform \}"/, '画面没有绑 transform')
    assert.match(monitorCode, /const videoTransform = computed/, '没有 videoTransform')
    for (const action of [
      'camera-flip-horizontal',
      'camera-flip-vertical',
      'camera-flip-quarter'
    ]) {
      assert.ok(monitorTemplate.includes(`data-action="${action}"`), `控制条缺少 ${action}`)
    }
  })
})

describe('第 22 条：控制条在画面**下方**，而且原生 controls 关掉了', () => {
  it('控制条是画面之后的一个兄弟节点（不是画面上方那排按钮）', () => {
    const stageAt = monitorTemplate.indexOf('camera-live__stage')
    const barAt = monitorTemplate.indexOf('data-camera-controlbar')
    assert.ok(stageAt >= 0 && barAt >= 0, '找不到画面或找不到控制条')
    assert.ok(barAt > stageAt, '控制条没有排在画面之后（第 22 条要求"视频窗口下方"）')
  })

  it('原生 `controls` 关掉：页面上只许有一条控制条', () => {
    // 只取 `<video …>` 这一个标签本身：整段模板里搜"controls"会命中
    // `class="camera-controls"`（`-` 也是词边界），那会永远为真。
    const tag = /<video\b[\s\S]*?>/.exec(monitorTemplate)
    assert.ok(tag, '找不到 `<video>` 标签')
    assert.equal(
      /(^|\s)controls(\s|=|>|\/)/.test(tag[0]),
      false,
      '`<video controls>` 又打开了：页面上会有两条控制条，而它们的功能不一样'
    )
  })

  it('六个动作都在同一个控制条里，而且每一项都有稳定的探针钩子', () => {
    const bar = monitorTemplate.slice(monitorTemplate.indexOf('data-camera-controlbar'))
    const barEnd = bar.indexOf('</div>\n      </section>')
    const body = barEnd > 0 ? bar.slice(0, barEnd) : bar
    for (const action of [
      'camera-pause',
      'camera-power',
      'camera-record',
      'camera-snapshot',
      'camera-playback',
      'camera-alarm-config'
    ]) {
      assert.ok(body.includes(`data-action="${action}"`), `控制条里缺少 ${action}`)
    }
    // 可用性必须与右键菜单同源（同一个 `readiness`），否则"菜单亮着按钮灰着"。
    assert.ok(body.includes('readiness.ready'), '控制条里的动作没有读同一个 readiness')
  })

  it('「播放信息」那块从页面上删掉了，但那个值没有丢（挪成状态徽标的 title）', () => {
    assert.equal(
      /cameraLiveUi\.playbackInfo/.test(monitorCode),
      false,
      '页面上又渲染了「播放信息」那一行（第 22 条要求删掉）'
    )
    assert.match(
      monitorTemplate,
      /:title="cameraMeta \|\| undefined"/,
      '播放信息没有挪成状态徽标的悬停说明：那段诊断在排障时是第一条线索'
    )
  })

  it('「查看」= 抓图，「回放」是回放：两个按钮各自对应一个既有动作', () => {
    // 「查看」这个词在业主的清单里只有"看一张定格的画面"这一件事可对应。
    const snapshotButton = monitorTemplate.slice(
      monitorTemplate.indexOf('data-action="camera-snapshot"')
    )
    assert.match(
      snapshotButton.slice(0, 400),
      /@click="takeSnapshot"/,
      '「查看」没有接到抓图（页面上的"查看"必须有确定的含义）'
    )
    const playbackButton = monitorTemplate.slice(
      monitorTemplate.indexOf('data-action="camera-playback"')
    )
    assert.match(
      playbackButton.slice(0, 400),
      /@click="playbackOpen = true"/,
      '「回放」没有接到本机录像回放对话框'
    )
  })
})

describe('第 21 条：自动播放 / 音量 / 翻转三件事的接线', () => {
  it('挂载与**换设备**两条路径都自动起播（"选中即自动播放"）', () => {
    const calls = monitorCode.match(/autoPlayCameraIfWorking\(\)/g) ?? []
    // 一处是定义，其余是调用点：挂载、换设备。
    assert.ok(calls.length >= 3, `自动起播的调用点太少（${calls.length} 处）—— 换设备那条路径漏了`)
    assert.match(
      monitorCode,
      /liveVolume\.value = loadCameraVolume\(id\)[\s\S]{0,400}await autoPlayCameraIfWorking\(\)/,
      '换设备之后没有"先读音量、再自动起播"'
    )
  })

  it('自动起播那一遍是**静音**的（浏览器的自动播放策略），出声要由滑杆那一次手势决定', () => {
    assert.match(
      monitorCode,
      /video\.muted = !audioUnlocked\.value \|\| video\.volume === 0/,
      '没有"没拿到用户手势就保持静音"这条判断：带声音自动播会被浏览器拒，画面永远不出来'
    )
    assert.match(
      monitorCode,
      /audioUnlocked\.value = true/,
      '没有任何地方把手势标记置为 true（那音量就永远出不来声）'
    )
    // 换设备/重新进页面时手势要重置：那次手势是对**上一路画面**做的。
    assert.ok(
      (monitorCode.match(/audioUnlocked\.value = false/g) ?? []).length >= 2,
      '换设备或重新挂载时没有重置"有没有拿到手势"'
    )
  })

  it('先写 volume 再解除 muted（反过来会以满音量响一下）', () => {
    const fn = monitorCode.slice(monitorCode.indexOf('function applyAudioOutput('))
    const body = fn.slice(0, fn.indexOf('\n}'))
    const volumeAt = body.indexOf('video.volume =')
    const mutedAt = body.indexOf('video.muted =')
    assert.ok(volumeAt >= 0 && mutedAt > volumeAt, '先解除静音再写音量：滑杆在 0 时会响一下')
  })

  it('暂停的是**画面**不是设备：按钮名字里带「画面」，而且实现是 `video.pause()`', () => {
    const fn = monitorCode.slice(monitorCode.indexOf('function togglePicturePause('))
    const body = fn.slice(0, fn.indexOf('\n}'))
    assert.match(body, /video\.pause\(\)/, '暂停没有作用在 `<video>` 上')
    assert.match(body, /video\.play\(\)/, '再按一次没有恢复播放')
    // 名字必须说清"是画面停了，不是设备停了"。
    assert.match(String(messageAt('zh-CN', 'cameraLiveUi.pausePicture')), /画面/, '按钮名字没说清停的是画面')
    assert.equal(
      /cameraLive\.stop|cameraLive\.pause/.test(body),
      false,
      '「暂停画面」碰到了主进程的会话 —— 那已经不是暂停而是停止'
    )
  })

  it('停流之后"暂停"状态被清掉（下一次起播必须是活的画面）', () => {
    const fn = monitorCode.slice(monitorCode.indexOf('async function stopCameraLive('))
    const body = fn.slice(0, fn.indexOf('\n}'))
    assert.match(body, /picturePaused\.value = false/, '停流之后还留着"暂停画面"的状态')
  })
})

describe('新增文案：四种语言齐全，占位符一致', () => {
  const REQUIRED = [
    'cameraLiveUi.pausePicture',
    'cameraLiveUi.playPicture',
    'cameraLiveUi.lookSnapshot',
    'cameraLiveUi.lookPlayback',
    'cameraLiveUi.volume',
    'cameraLiveUi.volumeMuted',
    'cameraLiveUi.volumeValue',
    'cameraLiveUi.volumeNoPicture',
    'cameraLiveUi.flipGroup',
    'cameraLiveUi.flipHorizontal',
    'cameraLiveUi.flipVertical',
    'cameraLiveUi.flipQuarter'
  ]

  it('每一条在四本目录里都有译文，而且不是照抄中文', () => {
    for (const key of REQUIRED) {
      for (const locale of Object.keys(CATALOGUES)) {
        const message = messageAt(locale, key)
        assert.ok(message && message.trim() !== '', `${locale} 缺 ${key}`)
        assert.equal(message.includes('@'), false, `${locale} 的 ${key} 含裸 @`)
      }
      const reference = messageAt('zh-CN', key) as string
      for (const locale of ['en', 'es', 'tr']) {
        assert.notEqual(messageAt(locale, key), reference, `${locale} 的 ${key} 与中文逐字相同`)
      }
    }
  })

  it('`volumeValue` 的占位符四语言一致', () => {
    for (const locale of Object.keys(CATALOGUES)) {
      assert.deepEqual(
        (messageAt(locale, 'cameraLiveUi.volumeValue') as string).match(/\{(\w+)\}/g),
        ['{percent}'],
        `${locale} 的 volumeValue 占位符不是 {percent}`
      )
    }
  })

  it('已删除的「播放信息」键在四种语言里都不复存在', () => {
    for (const locale of Object.keys(CATALOGUES)) {
      assert.equal(
        messageAt(locale, 'cameraLiveUi.playbackInfo'),
        undefined,
        `${locale} 里仍然存在已删除的 cameraLiveUi.playbackInfo`
      )
    }
  })
})
