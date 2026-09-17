/**
 * 通道墙「每通道状态 + 最近告警」这一轮：档位裁剪、通道数归因、dB 单位与措辞。
 *
 * WHY THIS FILE EXISTS（这一轮的四件事都必须在没有浏览器的情况下可断言）
 *   1. **档位按设备真实通道数裁剪**：2 路设备不该出现 4 / 8 分屏。判定住在
 *      `channelWallLayouts()`（纯函数），模板里只 `v-for` 那个结果，所以这里直接断言
 *      纯函数，再用源码守卫钉住「模板里没有第二个判断」。
 *   2. **通道数归因**：`GET /get_devinfo` 实测没有通道数字段，协议映射在设备没给时会把
 *      常量 8 填进去，于是「设备报了 8」与「设备什么都没报」在界面上是同一个数。
 *      `resolveChannelCount()` 把两者分开，并让**通道表**（`GET /get_passageway`）
 *      成为权威 —— 这正是「2 路盒子显示通道数 8」那个缺陷的修复点。
 *   3. **dB 是本仓库的标注**：它不是硬编码在模板里的字面量（那样没人能搜到它的出处），
 *      而是目录里的一条词条 + 元素 `title` 上的出处说明。
 *   4. **措辞只能是「最近告警」**：契约里没有每通道的实时告警推送，写「正在告警」就是
 *      编造。这条只能靠源码 + 目录守卫，浏览器里看不出来。
 *
 * 中文注释是仓库约定（见 tests/channel-state.test.ts）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  boxChannelCapacity,
  channelWallLayouts,
  resolveChannelCount,
  resolveChannelWallLayout,
  type ChannelWallTile
} from '../src/renderer/src/lib/channelWall'
import { CHANNEL_COUNT } from '../src/shared/domain/models'
import { LOCALES } from '../src/shared/i18n/locales'
import { zhCN } from '../src/shared/i18n/messages/zh-CN'
import { en } from '../src/shared/i18n/messages/en'
import { es } from '../src/shared/i18n/messages/es'
import { tr } from '../src/shared/i18n/messages/tr'

const projectRoot = path.resolve(__dirname, '..', '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

/** 一格声纹通道；只有这一轮关心的字段会被用到。 */
function boxTile(deviceId: string, channelIndex: number): ChannelWallTile {
  return {
    key: `box:${deviceId}:${channelIndex}`,
    deviceId,
    deviceName: deviceId,
    deviceStatus: 'ONLINE',
    kind: 'acousticBox',
    source: 'boxChannel',
    channelIndex,
    label: `CH${channelIndex + 1}`,
    channelName: '',
    state: 'enabled'
  }
}

/** 一台设备的 n 路通道（= `buildTiles()` 会产出的那些格子）。 */
function boxTiles(deviceId: string, channels: number): ChannelWallTile[] {
  return Array.from({ length: channels }, (_value, index) => boxTile(deviceId, index))
}

/** 一格相机：没有通道，因此档位裁剪与告警都不该被它影响。 */
function cameraTile(deviceId: string): ChannelWallTile {
  return {
    key: `camera:${deviceId}`,
    deviceId,
    deviceName: deviceId,
    deviceStatus: 'ONLINE',
    kind: 'acousticCamera',
    source: 'cameraStream',
    label: '',
    channelName: ''
  }
}

// ---------------------------------------------------------------------------
// 档位裁剪
// ---------------------------------------------------------------------------

describe('channelWallLayouts()：档位按设备真实的通道数裁剪', () => {
  it('8 路设备：1 / 2 / 4 / 8（与产品要求一致）', () => {
    assert.deepEqual(channelWallLayouts(boxTiles('ae08', 8)), [1, 2, 4, 8])
  })

  it('2 路设备：只有 1 / 2（4 分屏与 8 分屏都是它用不上的档位）', () => {
    assert.deepEqual(channelWallLayouts(boxTiles('box2', 2)), [1, 2])
  })

  it('1 路设备：只有 1', () => {
    assert.deepEqual(channelWallLayouts(boxTiles('box1', 1)), [1])
  })

  it('3 路设备：补上最小的能一屏装下它的 4，否则要翻两页才看得全', () => {
    assert.deepEqual(channelWallLayouts(boxTiles('box3', 3)), [1, 2, 4])
  })

  it('6 路设备：1 / 2 / 4 都保留，再补上 8', () => {
    assert.deepEqual(channelWallLayouts(boxTiles('box6', 6)), [1, 2, 4, 8])
  })

  it('容量取**最宽的那台设备**，不是格子总数', () => {
    const tiles = [...boxTiles('box2a', 2), ...boxTiles('box2b', 2), ...boxTiles('box8', 8)]
    assert.equal(boxChannelCapacity(tiles), 8)
    assert.deepEqual(channelWallLayouts(tiles), [1, 2, 4, 8])
  })

  it('相机不参与容量：一台相机没有通道', () => {
    assert.equal(boxChannelCapacity([cameraTile('cam')]), null)
  })

  it('一台设备的通道表都还没读到：不裁剪（未知不是 0 路）', () => {
    // 只有相机（或干脆空墙）时不能裁成 1 档：那不是「设备只有一路」，是「还不知道」。
    assert.equal(boxChannelCapacity([cameraTile('cam')]), null)
    assert.deepEqual(channelWallLayouts([cameraTile('cam')]), [1, 2, 4, 8])
    assert.deepEqual(channelWallLayouts([]), [1, 2, 4, 8])
  })

  it('裁剪出来的档位永远非空、升序、且都是合法档位', () => {
    for (const channels of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const options = channelWallLayouts(boxTiles('d', channels))
      assert.ok(options.length > 0, `${channels} 路时没有任何档位`)
      assert.deepEqual([...options].sort((a, b) => a - b), options, `${channels} 路时档位不是升序`)
      assert.ok(
        options.some((layout) => layout >= channels),
        `${channels} 路时没有一档能一屏装下这台设备：${options.join('/')}`
      )
    }
  })

  it('比最大档位还宽的设备：给出全部档位（没有更大的档位可给）', () => {
    // 这一档不存在（本协议固定 8 路），但类型上没有理由崩：仍然是完整的合法集合。
    assert.deepEqual(channelWallLayouts(boxTiles('d', 16)), [1, 2, 4, 8])
  })
})

describe('resolveChannelWallLayout()：持久化档位超出裁剪集合时在渲染层回退', () => {
  it('还在集合里就原样使用', () => {
    assert.equal(resolveChannelWallLayout(8, boxTiles('ae08', 8)), 8)
    assert.equal(resolveChannelWallLayout(1, boxTiles('ae08', 8)), 1)
  })

  it('先看 8 路盒子、后来换成 2 路盒子：8 / 4 都回退到 2', () => {
    const tiles = boxTiles('box2', 2)
    assert.equal(resolveChannelWallLayout(8, tiles), 2)
    assert.equal(resolveChannelWallLayout(4, tiles), 2)
    assert.equal(resolveChannelWallLayout(2, tiles), 2)
  })

  it('容量未知（没有通道表）时什么都不回退', () => {
    assert.equal(resolveChannelWallLayout(8, [cameraTile('cam')]), 8)
    assert.equal(resolveChannelWallLayout(4, []), 4)
  })

  it('回退结果永远落在裁剪集合里', () => {
    for (const channels of [1, 2, 3, 6, 8]) {
      const tiles = boxTiles('d', channels)
      for (const stored of [1, 2, 4, 8] as const) {
        const effective = resolveChannelWallLayout(stored, tiles)
        assert.ok(
          channelWallLayouts(tiles).includes(effective),
          `${channels} 路、持久化 ${stored} 档时回退到了集合外的 ${effective}`
        )
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 通道数归因
// ---------------------------------------------------------------------------

describe('resolveChannelCount()：通道表是权威，设备回报只是兜底', () => {
  it('通道表两行就是 2 路 —— 2 路盒子原来显示「通道数 8」的那个缺陷', () => {
    const resolved = resolveChannelCount({ channelTableCount: 2, deviceReportedCount: 8 })
    assert.deepEqual(resolved, { count: 2, source: 'channelTable' })
  })

  it('通道表八行就是 8 路（真机 AE08）', () => {
    assert.deepEqual(resolveChannelCount({ channelTableCount: 8, deviceReportedCount: 8 }), {
      count: 8,
      source: 'channelTable'
    })
  })

  it('通道表还没读到、回报正好是协议常量：不显示数字（不能归因于设备）', () => {
    // `GET /get_devinfo` 实测没有通道数字段，`mapDeviceInfo()` 在缺失时会填
    // CHANNEL_COUNT，所以这个 8 完全可能是映射写的 —— 不显示它才是如实的。
    assert.deepEqual(resolveChannelCount({ deviceReportedCount: CHANNEL_COUNT }), {
      count: null,
      source: 'unreported'
    })
    assert.deepEqual(resolveChannelCount({ channelTableCount: 0, deviceReportedCount: 8 }), {
      count: null,
      source: 'unreported'
    })
  })

  it('回报一个不等于协议常量的值：那只能是设备报的，显示它', () => {
    assert.deepEqual(resolveChannelCount({ deviceReportedCount: 4 }), {
      count: 4,
      source: 'deviceReport'
    })
    assert.deepEqual(resolveChannelCount({ channelTableCount: null, deviceReportedCount: 2 }), {
      count: 2,
      source: 'deviceReport'
    })
  })

  it('什么都没读到：没有数字，来源是「未上报」', () => {
    assert.deepEqual(resolveChannelCount({}), { count: null, source: 'unreported' })
    assert.deepEqual(resolveChannelCount({ channelTableCount: null, deviceReportedCount: null }), {
      count: null,
      source: 'unreported'
    })
  })

  it('声学相机没有通道：0 是产品事实，不是「没读到」，也不是协议兜底', () => {
    // 主进程的 `syntheticCameraInfo()` 给相机的 `channelCount` 就是 0，那个 0 说的是
    // 「这台设备没有通道这个概念」。把它归进 `unreported` 会让界面写「设备未上报通道数」，
    // 那是另一件事（缺陷），而 `mapDeviceInfo()` 的协议常量 8 更不能出现在相机上。
    assert.deepEqual(resolveChannelCount({ deviceReportedCount: 0, deviceKind: 'acousticCamera' }), {
      count: 0,
      source: 'noChannels'
    })
    // 相机拿不到通道表，所以这条路就是它的正常路径。
    assert.deepEqual(
      resolveChannelCount({ channelTableCount: null, deviceReportedCount: 0, deviceKind: 'acousticCamera' }),
      { count: 0, source: 'noChannels' }
    )
    // 声纹设备的 0 仍然是「没有可信数字」：相机那条路绝不能外溢到它。
    assert.deepEqual(resolveChannelCount({ deviceReportedCount: 0, deviceKind: 'acousticBox' }), {
      count: null,
      source: 'unreported'
    })
    // 通道表优先于家族：相机将来若真有通道表，也以表为准。
    assert.deepEqual(
      resolveChannelCount({ channelTableCount: 2, deviceKind: 'acousticCamera' }),
      { count: 2, source: 'channelTable' }
    )
  })

  it('0 / 负数 / 小数 / NaN / 非有限值一律不算一个数', () => {
    for (const bad of [0, -1, -8, 2.5, NaN, Infinity, -Infinity]) {
      assert.deepEqual(
        resolveChannelCount({ channelTableCount: bad }),
        { count: null, source: 'unreported' },
        `${String(bad)} 被当成了一个通道数`
      )
      assert.deepEqual(
        resolveChannelCount({ deviceReportedCount: bad }),
        { count: null, source: 'unreported' },
        `${String(bad)} 被当成了一个通道数`
      )
    }
  })

  it('通道表永远是权威来源：设备回报更小也不采纳', () => {
    assert.deepEqual(resolveChannelCount({ channelTableCount: 8, deviceReportedCount: 2 }), {
      count: 8,
      source: 'channelTable'
    })
  })
})

// ---------------------------------------------------------------------------
// 目录词条
// ---------------------------------------------------------------------------

const CATALOGUES: Record<string, Record<string, unknown>> = {
  'zh-CN': zhCN as unknown as Record<string, unknown>,
  en: en as unknown as Record<string, unknown>,
  es: es as unknown as Record<string, unknown>,
  tr: tr as unknown as Record<string, unknown>
}

function messageAt(locale: string, key: string): unknown {
  let cursor: unknown = CATALOGUES[locale]
  for (const segment of key.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

/**
 * 这一轮新增/复用的每一个 key。
 *
 * 复用的三条（`metrics.spl`、`alarmsUi.ackAcknowledged`、`alarmsUi.ackUnacknowledged`）
 * 也写在这里：模板一旦换词条名，这里会先失败。
 */
const ROUND_KEYS = [
  'channelWall.graph.splUnit',
  'channelWall.graph.splUnitNote',
  'channelWall.alarm.recent',
  'channelWall.alarm.loading',
  'channelWall.alarm.failed',
  'channelWall.alarm.none',
  'channelWall.alarm.entry',
  'deviceDetailUi.channelCountUnreported',
  'addDeviceUi.channelCountUnreported',
  'metrics.spl',
  'alarmsUi.ackAcknowledged',
  'alarmsUi.ackUnacknowledged'
]

describe('这一轮的目录词条', () => {
  it('四种语言里都存在，且都不是空串', () => {
    for (const locale of LOCALES) {
      for (const key of ROUND_KEYS) {
        assert.equal(typeof messageAt(locale, key), 'string', `${locale} 缺少 ${key}`)
        assert.ok(String(messageAt(locale, key)).trim().length > 0, `${locale}.${key} 是空串`)
      }
    }
  })

  it('告警那一行的占位符四种语言一致（否则界面会渲染出字面的 {ack}）', () => {
    for (const locale of LOCALES) {
      assert.equal(
        messageAt(locale, 'channelWall.alarm.entry'),
        '{type} · {time} · {ack}',
        `${locale} 的 channelWall.alarm.entry 占位符不一致`
      )
    }
  })

  it('声压单位就是 dB，出处说明在四种语言里都不是空的', () => {
    for (const locale of LOCALES) {
      assert.equal(messageAt(locale, 'channelWall.graph.splUnit'), 'dB', `${locale} 的单位不是 dB`)
      const note = String(messageAt(locale, 'channelWall.graph.splUnitNote'))
      assert.ok(note.length > 20, `${locale} 的 splUnitNote 太短，说不清出处：${note}`)
    }
  })

  it('channelWall 下的任何词条都不说「正在告警」（契约里没有实时每通道告警推送）', () => {
    for (const locale of LOCALES) {
      const wall = CATALOGUES[locale]?.channelWall as Record<string, unknown> | undefined
      assert.ok(wall, `${locale} 没有 channelWall 块`)
      const bad: string[] = []
      const walk = (node: unknown, prefix: string): void => {
        if (typeof node === 'string') {
          // 中英西土四种语言里「此刻正在告警」的说法都不能出现。
          if (/正在告警|alarming now|alarmando ahora|şu anda alarm/.test(node)) {
            bad.push(`${prefix}=${node}`)
          }
          return
        }
        if (node && typeof node === 'object') {
          for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
            walk(value, prefix ? `${prefix}.${key}` : key)
          }
        }
      }
      walk(wall, 'channelWall')
      assert.deepEqual(bad, [], `${locale} 的通道墙词条里出现了实时告警的说法：${bad.join(', ')}`)
    }
  })

  it('「最近告警」与「无告警记录」就是那两个说法', () => {
    assert.equal(messageAt('zh-CN', 'channelWall.alarm.recent'), '最近告警')
    assert.equal(messageAt('zh-CN', 'channelWall.alarm.none'), '无告警记录')
  })
})

// ---------------------------------------------------------------------------
// 源码守卫
// ---------------------------------------------------------------------------

/**
 * 去掉注释后的源码。
 *
 * 只做「注释里的字样不算渲染」这一件事：`ChannelWall.vue` 的说明性注释里就写着
 * `monitor.start()` 与 `dB`（那正是「不许这么做」的说明），把它们算成违规会把守卫
 * 变成一句废话。按行首标记剥离，与 `scripts/i18n-progress.cjs` 用的是同一种启发式。
 */
function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*')
    })
    .join('\n')
}

const channelWallSource = read('src/renderer/src/components/ChannelWall.vue')
const channelWallLive = stripComments(channelWallSource)

describe('通道墙：dB 单位与措辞的源码守卫', () => {
  it('模板里不再有硬编码的 dB 字面量，单位来自目录', () => {
    // 按标识符边界找那个单位，而不是子串：`loadBoxChannels` 里也有 `dB` 两个字母。
    const unitLiteral = /(^|[^A-Za-z0-9_])dB([^A-Za-z0-9_]|$)/
    assert.equal(
      unitLiteral.test(channelWallLive),
      false,
      'ChannelWall.vue 里又出现了 dB 字面量：它必须来自目录（channelWall.graph.splUnit）'
    )
    assert.match(channelWallLive, /t\('channelWall\.graph\.splUnit'\)/)
  })

  it('出处在元素 title 上（数值旁边），不是只写在注释里', () => {
    const hits = channelWallLive.match(/t\('channelWall\.graph\.splUnitNote'\)/g) ?? []
    assert.ok(hits.length >= 2, `splUnitNote 只挂了 ${hits.length} 处，读数与单位都该有`)
  })

  it('数值仍然照常显示（所有者要的是那个数）', () => {
    assert.match(channelWallLive, /formatNumber\(liveFrame!\.spl, 1\)/)
  })

  it('通道墙自己不开硬件会话，也不用模拟数据', () => {
    assert.equal(channelWallLive.includes('useSimulatedRealtime'), false, '模拟数据进了通道墙')
    assert.equal(/monitor\.start\s*\(/.test(channelWallLive), false, '通道墙自己在 start() 实时会话')
    assert.equal(
      /fa371Stream\.start\s*\(/.test(channelWallLive),
      false,
      '通道墙自己在 start() 相机会话'
    )
  })

  it('档位控件 v-for 的是裁剪结果，模板里没有「设备有几路」这个判断', () => {
    assert.match(channelWallLive, /v-for="option in layoutOptions"/)
    assert.equal(
      /v-for="option in CHANNEL_WALL_LAYOUTS"/.test(channelWallLive),
      false,
      '档位控件又直接遍历全部档位了：2 路设备会看到 4 / 8 分屏'
    )
  })

  it('每一格的那一行写的是「最近告警」并显示类型 / 时间 / 确认状态', () => {
    assert.match(channelWallLive, /t\('channelWall\.alarm\.recent'\)/)
    assert.match(channelWallLive, /describeAlarmMask\(alarm\.alarmMask\)/)
    assert.match(channelWallLive, /formatDateTime\(alarm\.timestamp\)/)
    assert.match(channelWallLive, /alarm\.acknowledged \? t\('alarmsUi\.ackAcknowledged'\)/)
    // 四种读数状态必须分开：读取中 / 读取失败 / 无记录 / 具体记录。
    assert.match(channelWallLive, /t\('channelWall\.alarm\.loading'\)/)
    assert.match(channelWallLive, /t\('channelWall\.alarm\.failed'\)/)
    assert.match(channelWallLive, /t\('channelWall\.alarm\.none'\)/)
    assert.match(channelWallLive, /t\('channelWall\.alarm\.entry'/)
  })

  it('告警只查本地库（只读 IPC），一次一路且 limit 为 1', () => {
    assert.match(channelWallLive, /window\.api\.alarms\.query\(/)
    assert.match(channelWallLive, /limit: 1/)
    assert.match(channelWallLive, /channelId: tile\.channelIndex/)
  })
})

describe('设备详情 / 添加设备：通道数的来源', () => {
  it('设备详情页用 resolveChannelCount()，并且把通道表放在前面', () => {
    const source = stripComments(read('src/renderer/src/views/DeviceDetailView.vue'))
    assert.match(source, /resolveChannelCount\(\{/)
    assert.match(source, /channelTableCount: config\.channels\.length/)
    // 旧写法（设备回报优先）不许回来。
    assert.equal(
      /channelCountFromDevice\.value \?\?/.test(source),
      false,
      '设备详情页又把设备回报的通道数排在通道表前面了'
    )
  })

  it('添加设备对话框不再直接渲染探测回来的通道数', () => {
    const source = stripComments(read('src/renderer/src/components/AddDeviceDialog.vue'))
    assert.match(source, /probeChannelCount\.count/)
    assert.equal(
      /probeInfo\?\.channelCount \?\? '—'/.test(source),
      false,
      '添加设备对话框又直接把设备回报的通道数渲染出来了'
    )
    assert.match(source, /t\('addDeviceUi\.channelCountUnreported'\)/)
  })
})
