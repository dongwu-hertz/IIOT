/**
 * 实时视频墙的**播放器控制条**（业主 2026-09-19 第 12 批）。
 *
 * 业主原话：「实时视频墙里面的，播放器窗口，应该只有告警， 全屏， 暂停， 切换录像，音量，
 * 手动录像， 音量大小调整应该做成点击后显示出来， 上下调节的方式。」
 *
 * WHY THIS FILE EXISTS
 * 这一条改的是**控制条上放什么**，而"少一颗按钮"在源码里是安静的：
 * 页面照样渲染、探针照样通过，只有操作员会发现某个动作找不到了。所以这里钉三件事：
 *
 *   1. **只剩六颗**，而且就是业主给的那六颗、那个顺序；四颗视图按钮确实搬进了右键菜单的
 *      「显示方式」（不是删掉 —— 第 10 批第 2 条要的四种视图仍然可达）；
 *   2. 音量**不是**常驻横滑杆：点按钮才弹出一张**水平细滑条卡片**（业主 2026-09-21 批：
 *      出现在音量图标正上方、宽为格宽的 20%），而且"关掉这一格的声音"这件事仍然做得到
 *      （开关搬进了浮层，不是删掉）；
 *   3. 手填的第三方 RTSP 源**不是设备**：告警 / 切换录像 / 手动录像那三颗对它没有意义，
 *      所以它那一格只有 暂停 / 全屏 / 音量 三颗。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { zhCN } from '../src/shared/i18n/messages/zh-CN'
import { en } from '../src/shared/i18n/messages/en'
import { es } from '../src/shared/i18n/messages/es'
import { tr } from '../src/shared/i18n/messages/tr'

const projectRoot = path.resolve(__dirname, '..', '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
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

const wall = read('src/renderer/src/components/CameraVideoWall.vue')
const menu = read('src/renderer/src/components/VideoContextMenu.vue')
const nvr = read('src/shared/domain/camera-nvr.ts')

/**
 * 控制条那一段（从 `.camera-wall__bar` 到它的收尾 div）。
 *
 * **不能拿 `indexOf('data-cell-volume-pop')` 当右边界**：那串字在 `<script>` 里也出现
 * （"点外面关掉"那个函数用它在 `closest()` 里），而它在文件里比模板更靠前 —— 第一版就是这么
 * 切的，切出来是一个空串，于是十条断言全红。右边界取**它自己的收尾 `</div>`**，与
 * `camera-autoplay.test.ts` 同一做法（控制条里没有嵌套 div）。
 */
const barStart = wall.indexOf('class="camera-wall__bar"')
const bar = wall.slice(barStart, wall.indexOf('</div>', barStart))

/** 音量浮层那一段（它自己也没有嵌套 div）。 */
const popStart = wall.indexOf('class="camera-wall__volume-pop"')
const volumePop = wall.slice(popStart, wall.indexOf('</div>', popStart))

describe('播放器控制条：只有业主给的那六颗（第 12 批）', () => {
  it('六颗按业主的顺序，一颗不多一颗不少', () => {
    const actions = [...bar.matchAll(/data-action="(cell-[a-z-]+)"/g)].map((match) => match[1])
    assert.deepEqual(actions, [
      'cell-alarm',
      'cell-fullscreen',
      'cell-play',
      'cell-playback',
      'cell-volume',
      'cell-record'
    ])
  })

  it('四颗视图按钮**不在控制条上**了，但它们进了右键菜单的「显示方式」', () => {
    assert.equal(bar.includes('cell-view-'), false, '控制条上还有视图按钮')
    // 菜单模型：四种显示方式 + 一个纯分组的父项。
    assert.match(nvr, /'view-play',\s*\n\s*'view-timedomain',\s*\n\s*'view-spectrum',\s*\n\s*'view-spectrogram',/, '菜单动作词表里没有那四个')
    assert.match(nvr, /action: 'display'/, '没有「显示方式」这个父项')
    assert.match(nvr, /labelKey: 'cameraNvrUi\.menuDisplay'/, '父项的文案键不对')
    // 父项词表：第三批加了「翻转」父项（监测页传 flips context 才渲染，墙不传）——
    // 词表本身必须跟着加，否则模型与派发之间的契约断了。
    assert.match(
      nvr,
      /CAMERA_NVR_SUBMENU_ACTIONS = \['capture', 'display', 'flip'\]/,
      '父项词表没有跟着加'
    )
    // 墙对四个动作各有一条派发分支（少一条就是"点了没反应"）。
    for (const [action, mode] of [
      ['view-play', 'play'],
      ['view-timedomain', 'timedomain'],
      ['view-spectrum', 'spectrum'],
      ['view-spectrogram', 'spectrogram']
    ] as const) {
      assert.match(
        wall,
        new RegExp(`case '${action}':\\s*\\n\\s*chooseCellView\\(cell, '${mode}'\\)`),
        `菜单里的 ${action} 没有派发分支`
      )
    }
    // 菜单项本身也要有稳定的探针钩子（两层），否则探针只能靠文字点。
    assert.match(menu, /:data-action="item\.action"/, '一级菜单项没有 data-action')
    assert.match(menu, /:data-action="child\.action"/, '二级菜单项没有 data-action')
  })

  it('「暂停」仍然是"停掉这一路直播"（词换了，动作没换）', () => {
    assert.match(
      wall,
      /if \(isCameraCellLive\(cell\.status\)\) return t\('cameraWallUi\.pause'\)/,
      '正在拉流时那颗按钮的名字不是「暂停」'
    )
    assert.match(wall, /return t\('cameraWallUi\.play'\)/, '停着时那颗按钮的名字不是「播放」')
    // 动作仍然是 toggleCell（起流/停流），不是"暂停画面"那种本地状态。
    assert.match(bar, /data-action="cell-play"[\s\S]{0,600}@click\.stop="toggleCell\(cell\)"/, '暂停那颗按钮没有接上 toggleCell')
    assert.match(wall, /async function toggleCell\(cell: CameraCellView\)/, 'toggleCell 不在了')
  })

  it('手填的第三方 RTSP 源只有三颗（告警 / 切换录像 / 手动录像对它没有意义）', () => {
    assert.match(wall, /function cellHasDevice\(cell: CameraCellView\): boolean \{/, '没有"这一格是不是设备"的判据')
    const guarded = [...bar.matchAll(/v-if="cellHasDevice\(cell\)"/g)].length
    assert.equal(guarded, 3, '需要设备的那三颗没有各带一个 v-if（应为 3）')
    for (const action of ['cell-alarm', 'cell-playback', 'cell-record']) {
      const at = bar.indexOf(`data-action="${action}"`)
      assert.ok(at > 0, `控制条上没有 ${action}`)
      const before = bar.slice(Math.max(0, at - 300), at)
      assert.match(before, /v-if="cellHasDevice\(cell\)"/, `${action} 没有被"这一格是设备"门住`)
    }
  })
})

describe('音量：点一下弹出图标上方的水平细滑条卡片（2026-09-21 批）', () => {
  it('滑杆不再常驻在控制条上，而是在一个浮层里', () => {
    assert.equal(/type="range"/.test(bar), false, '控制条上还有常驻滑杆')
    assert.match(wall, /const volumeOpenSlot = ref<number \| null>\(null\)/, '没有"哪一格的音量浮层开着"这个状态')
    assert.match(wall, /v-if="volumeOpenSlot === cell\.index"/, '浮层没有按格开关')
    assert.match(volumePop, /type="range"/, '浮层里没有滑杆')
    assert.match(volumePop, /data-cell-volume\b/, '浮层里的滑杆没有探针钩子')
  })

  it('滑杆是**水平**的细条卡片：贴在图标正上方、宽为格宽的 20%（76–180px）', () => {
    const block = wall.slice(wall.indexOf('.camera-wall__volume-pop {'))
    const body = block.slice(0, block.indexOf('}'))
    // 竖条那一套彻底拿掉：没有竖排书写模式，也没有上下方向的 cursor。
    assert.equal(/writing-mode:\s*vertical/.test(wall), false, '滑杆又变成竖向了')
    assert.equal(/cursor:\s*ns-resize/.test(wall), false, '还留着竖向拖动的光标')
    assert.match(body, /right:\s*8px;/, '卡片没有对齐这一格的右缘')
    assert.match(body, /bottom:\s*3[0-9]px;/, '卡片没有浮在控制条上方')
    assert.match(body, /width:\s*20%;/, '宽度不是格宽的 20%')
    assert.match(body, /min-width:\s*76px;/)
    assert.match(body, /max-width:\s*180px;/)
    assert.match(body, /background:\s*#fff;/, '不是白底卡片')
    assert.match(body, /border:\s*1px solid var\(--color-border\);/)
    assert.match(body, /box-shadow:/)
    // 轨道 4px 圆条、thumb 10px 圆点（WebKit 与 Gecko 两条伪元素都要在）。
    const slider = wall.slice(wall.indexOf('.camera-wall__volume-slider {'))
    const sliderBody = slider.slice(0, slider.indexOf('}'))
    assert.match(sliderBody, /appearance:\s*none;/)
    for (const pseudo of ['::-webkit-slider-runnable-track', '::-moz-range-track']) {
      const at = wall.indexOf(`.camera-wall__volume-slider${pseudo} {`)
      assert.ok(at >= 0, `缺 ${pseudo}`)
      const rule = wall.slice(at, wall.indexOf('}', at))
      assert.match(rule, /height:\s*4px;/, `${pseudo} 轨道不是 4px`)
      assert.match(rule, /border-radius:\s*999px;/, `${pseudo} 轨道没有圆角`)
    }
    for (const pseudo of ['::-webkit-slider-thumb', '::-moz-range-thumb']) {
      const at = wall.indexOf(`.camera-wall__volume-slider${pseudo} {`)
      assert.ok(at >= 0, `缺 ${pseudo}`)
      const rule = wall.slice(at, wall.indexOf('}', at))
      assert.match(rule, /width:\s*10px;/, `${pseudo} 不是 10px`)
      assert.match(rule, /height:\s*10px;/)
      assert.match(rule, /border-radius:\s*50%;/, `${pseudo} 不是圆点`)
    }
  })

  it('点音量按钮 = 开/收浮层，并且把这一格设为唯一出声的那一格', () => {
    assert.match(wall, /function openVolumePopover\(cell: CameraCellView\): void \{/, '没有打开浮层的那个函数')
    assert.match(
      wall,
      /if \(volumeOpenSlot\.value === cell\.index\) \{\s*\n\s*volumeOpenSlot\.value = null\s*\n\s*return/,
      '再点一次没有收起浮层'
    )
    assert.match(wall, /if \(!cell\.audio\) toggleAudio\(cell\)/, '点音量没有把这一格设为出声格')
    assert.match(bar, /data-cell-volume-trigger/, '音量按钮没有"触发者"标记（点外面关掉时要让开它）')
    assert.match(bar, /:aria-expanded="volumeOpenSlot === cell\.index"/, '音量按钮没有暴露展开状态')
  })

  it('点外面关掉，而且**关掉声音**这件事仍然做得到（开关搬进了浮层）', () => {
    assert.match(wall, /function onVolumeDocumentMouseDown\(event: MouseEvent\): void \{/, '没有"点外面关掉"')
    assert.match(wall, /closest\('\[data-cell-volume-trigger\]'\)/, '触发按钮被当成"外面"（再点一次会变成先关后开）')
    assert.match(wall, /closest\('\[data-cell-volume-pop\]'\)/, '浮层自己被当成"外面"（拖滑杆时会被关掉）')
    assert.match(wall, /document\.addEventListener\('mousedown', onVolumeDocumentMouseDown, true\)/, '没有挂上监听')
    assert.match(
      wall,
      /document\.removeEventListener\('mousedown', onVolumeDocumentMouseDown, true\)/,
      '没有摘掉监听（离开页面会漏）'
    )
    // 原来挂在音量图标上的"开启/关闭声音"搬进了浮层，没有丢。
    assert.match(volumePop, /data-action="cell-volume-mute"/, '浮层里没有声音开关')
    assert.match(volumePop, /@click\.stop="toggleAudio\(cell\)"/, '声音开关没有接上 toggleAudio')
    assert.match(wall, /function volumeMuteLabel\(cell: CameraCellView\): string \{/, '声音开关没有名字')
  })

  it('拖动滑杆真的写进这一格的音量（与原来同一条路）', () => {
    assert.match(volumePop, /@input="onVolumeInput\(cell, \$event\)"/, '滑杆没有接上写音量的处理器')
    assert.match(wall, /function onVolumeInput\(cell: CameraCellView, event: Event\): void \{/, 'onVolumeInput 不在了')
    assert.match(wall, /applyAudioOutput\(\)/, '音量没有落到 `<video>.volume` 上')
  })
})

describe('第 12 批的六颗控件各自接的是既有那条路', () => {
  it('告警 / 切换录像 / 手动录像与右键菜单里那几项是同一段代码', () => {
    // 告警：与菜单的 `alarm-config` 同一个对话框状态。
    assert.match(wall, /function openCellAlarm\(cell: CameraCellView\): void \{[\s\S]{0,300}alarmDialogOpen\.value = true/)
    assert.match(wall, /case 'alarm-config':\s*\n\s*alarmTarget\.value = \{ deviceId, deviceName \}/, '菜单里的告警配置分支不见了')
    // 切换录像：与菜单的 `playback` 同一个弹窗。
    assert.match(wall, /function openCellPlayback\(cell: CameraCellView\): void \{[\s\S]{0,300}openPlaybackDialog\(/, '切换录像没有走回放弹窗')
    assert.match(wall, /case 'playback':\s*\n\s*openPlaybackDialog\(deviceId, deviceName\)/, '菜单里的回放分支不见了')
    // 手动录像：与菜单的 `toggle-recording` 同一个函数。
    assert.match(wall, /async function onCellRecord\(cell: CameraCellView\): Promise<void> \{[\s\S]{0,300}toggleCellRecording\(/, '手动录像没有走 toggleCellRecording')
    assert.match(wall, /case 'toggle-recording':\s*\n\s*await toggleCellRecording\(cell, deviceId\)/, '菜单里的录像分支不见了')
  })

  it('手动录像的可用性与原因是**共享层那一个函数**（菜单与按钮不会漂移）', () => {
    assert.match(wall, /cameraCaptureReadiness\(liveStateOf\(cell\)\)/, '按钮没有用共享的准备状态判据')
    assert.match(wall, /return readiness\.reasonText \|\| t\(readiness\.reasonKey\)/, '禁用时没有把原因当名字')
    assert.match(wall, /return nvr\.recording \|\| cameraCaptureReadiness/, '录像中不是"永远可以停"')
  })
})

describe('第 12 批的六条新文案四语言齐全', () => {
  it('六条键都在四本目录里，而且不是照抄中文', () => {
    const KEYS = [
      'cameraWallUi.play',
      'cameraWallUi.pause',
      'cameraWallUi.volumeLevel',
      'cameraWallUi.cellPlayback',
      'cameraWallUi.cellAlarm',
      'cameraNvrUi.menuDisplay'
    ]
    for (const key of KEYS) {
      const reference = messageAt('zh-CN', key) as string
      assert.ok(reference && reference.trim() !== '', `zh-CN 缺 ${key}`)
      for (const locale of ['en', 'es', 'tr']) {
        const message = messageAt(locale, key)
        assert.ok(message && message.trim() !== '', `${locale} 缺 ${key}`)
        assert.notEqual(message, reference, `${locale} 的 ${key} 与中文逐字相同`)
        assert.equal(message.includes('@'), false, `${locale} 的 ${key} 含裸 @`)
      }
    }
  })

  it('中文那六条就是业主给的那些词', () => {
    assert.equal(messageAt('zh-CN', 'cameraWallUi.pause'), '暂停')
    assert.equal(messageAt('zh-CN', 'cameraWallUi.play'), '播放')
    assert.equal(messageAt('zh-CN', 'cameraWallUi.volume'), '音量')
    assert.equal(messageAt('zh-CN', 'cameraWallUi.volumeLevel'), '音量大小')
    assert.equal(messageAt('zh-CN', 'cameraWallUi.cellPlayback'), '切换录像')
    assert.equal(messageAt('zh-CN', 'cameraNvrUi.menuDisplay'), '显示方式')
    // 「手动录像」那一颗复用菜单的文案，所以它是逐字那四个字。
    assert.equal(messageAt('zh-CN', 'cameraNvrUi.menuStartRecording'), '手动录像')
    // 四种视图的名字仍然只在 `cameraWallUi.view*` 里（菜单与控制条从不说两种话）。
    assert.equal(messageAt('zh-CN', 'cameraWallUi.viewSpectrum'), '频域图')
  })
})
