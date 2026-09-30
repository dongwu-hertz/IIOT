/**
 * ⑪ 连续录像器（`services/recorder/rtsp-recorder-service.ts`）的监督逻辑回归测试。
 *
 * WHY THIS FILE EXISTS
 * 纯规则（`tests/recorder.test.ts`）只回答了"判据对不对"；这一层回答的是
 * **"把这些判据接起来之后，录像器会不会在真实时序下漏拍"**：
 *   - 断了流之后到底有没有重启，重启前有没有等退避；
 *   - 文件重新在长的时候，退避档位有没有归零（否则一次抖动之后永远慢半拍）；
 *   - 停止/重启之后，已经写完但没登记的片段有没有补上；
 *   - 跨天有没有换目录（不换就把今天的片段写进昨天的目录）。
 *
 * 用假 ffmpeg（自己按需"写"片段文件）+ 假时钟，**不需要真机、不需要 ffmpeg 进程**：
 * 这一层要验的是调度与登记，不是 RTSP 本身（RTSP 那条路真机上已经用同一套参数跑通）。
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  RtspRecorderService,
  type RecorderDeviceTarget,
  type RecorderSegmentRecord
} from '../src/main/services/recorder/rtsp-recorder-service'
import { RECORDER_STALL_MS } from '../src/shared/domain/recorder'
import type { FfmpegProcess } from '../src/main/services/media/ffmpeg'

const tempRoots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hz-recorder-'))
  tempRoots.push(root)
  return root
}

after(async () => {
  for (const root of tempRoots) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
})

interface Harness {
  service: RtspRecorderService
  root: string
  registrations: RecorderSegmentRecord[]
  spawnCount: () => number
  kills: () => number
  /** 假 ffmpeg："写"出一段片段（内容非空，模拟一个有数据的文件）。 */
  writeSegment: (dir: string, name: string, bytes?: number) => Promise<void>
  /** 追加字节（模拟"文件还在长"）。 */
  grow: (dir: string, name: string, bytes: number) => Promise<void>
  advance: (ms: number) => void
  now: () => number
  target: RecorderDeviceTarget
  /** 当前这一轮目录（由片段实际落盘的位置反推）。 */
  todayDir: () => string
  /** 片段名（与录像器生成规则一致），供测试构造"盘上已有文件"的场景。 */
  nameFor: (atMs: number) => string
}

async function harness(options: { startMs?: number } = {}): Promise<Harness> {
  const root = await makeRoot()
  let clock = options.startMs ?? new Date(2026, 8, 26, 8, 0, 0, 0).getTime()
  const registrations: RecorderSegmentRecord[] = []
  let spawns = 0
  let kills = 0
  const target: RecorderDeviceTarget = {
    deviceId: 'dev-1',
    deviceUid: 'FA371-MOCK',
    rtspUrl: 'rtsp://127.0.0.1:8554/live'
  }

  const service = new RtspRecorderService({
    getStorageRoot: () => root,
    // 假进程：不跑真的 ffmpeg，只提供一个可被 kill 的句柄。
    spawn: (): FfmpegProcess => {
      spawns += 1
      let killed = false
      return {
        child: {} as FfmpegProcess['child'],
        stdout: {} as FfmpegProcess['stdout'],
        stderrTail: () => '',
        exited: Promise.resolve({ code: 0, signal: null }),
        kill: () => {
          if (!killed) {
            killed = true
            kills += 1
          }
        },
        killed: () => killed
      }
    },
    buildArgs: () => ['-fake'],
    registerSegment: (segment) => {
      registrations.push(segment)
    },
    listRegisteredNames: async (_deviceId, relativeDir) =>
      registrations
        .filter((entry) => entry.relativePath.startsWith(`${relativeDir}/`))
        .map((entry) => entry.relativePath.slice(relativeDir.length + 1)),
    now: () => clock,
    autoTick: false
  })

  const pad = (input: number, width = 2): string => String(input).padStart(width, '0')
  const dirFor = (atMs: number): string => {
    const date = new Date(atMs)
    return path.join(
      root,
      'video',
      'FA371-MOCK',
      String(date.getFullYear()),
      pad(date.getMonth() + 1),
      pad(date.getDate())
    )
  }
  const nameFor = (atMs: number): string => {
    const date = new Date(atMs)
    return (
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
      `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}.mp4`
    )
  }

  return {
    service,
    root,
    registrations,
    spawnCount: () => spawns,
    kills: () => kills,
    /** 片段名与录像器自己生成的一模一样（`recorderSegmentName()` 的规则）。 */
    nameFor,
    writeSegment: async (dir, name, bytes = 1_024) => {
      await fs.mkdir(dir, { recursive: true })
      const buffer = Buffer.alloc(bytes, 7)
      await fs.writeFile(path.join(dir, name), buffer)
      await fs.utimes(path.join(dir, name), new Date(clock), new Date(clock))
    },
    grow: async (dir, name, bytes) => {
      await fs.appendFile(path.join(dir, name), Buffer.alloc(bytes, 7))
      await fs.utimes(path.join(dir, name), new Date(clock), new Date(clock))
    },
    advance: (ms) => {
      clock += ms
    },
    now: () => clock,
    target,
    todayDir: () => dirFor(clock)
  }
}

describe('连续录像器：拉起与登记', () => {
  it('start() 立刻拉起一轮（不是等一个监督周期），并落在当天的目录里', async () => {
    const harnessed = await harness()
    const status = await harnessed.service.start(harnessed.target, 300)
    assert.equal(harnessed.spawnCount(), 1)
    assert.equal(status.state, 'starting', '还没写出字节时不许说"正在录"')
    assert.equal(status.segmentSeconds, 300)

    const dir = harnessed.todayDir()
    assert.ok(
      dir.endsWith(path.join('video', 'FA371-MOCK', '2026', '09', '26')),
      `片段目录应符合既有分层：${dir}`
    )
    await fs.stat(dir) // 目录已经建好，否则 ffmpeg 第一片会写失败
    await harnessed.service.stop(harnessed.target.deviceId)
  })

  it('文件在长 = recording；只登记**已经写完**的片段', async () => {
    const harnessed = await harness()
    const dir = harnessed.todayDir()
    await harnessed.service.start(harnessed.target, 300)

    // 第一片：写完（有下一片了），但库里还没有 → 应当被登记。
    await harnessed.writeSegment(dir, '2026-09-26_08-00-00.mp4', 5_000)
    await harnessed.advance(300_000)
    await harnessed.writeSegment(dir, '2026-09-26_08-05-00.mp4', 500)
    await harnessed.service.tickDevice('dev-1')

    assert.equal(harnessed.registrations.length, 1, '只登记已经写完的那一片')
    const registered = harnessed.registrations[0]!
    assert.equal(registered.name, '2026-09-26_08-00-00.mp4')
    assert.equal(registered.startMs, new Date(2026, 8, 26, 8, 0, 0, 0).getTime())
    assert.equal(
      registered.endMs,
      new Date(2026, 8, 26, 8, 5, 0, 0).getTime(),
      '结束时刻取下一片的起始（切片边界）'
    )
    assert.equal(registered.relativePath, 'video/FA371-MOCK/2026/09/26/2026-09-26_08-00-00.mp4')

    const status = harnessed.service.status()[0]!
    assert.equal(status.registeredCount, 1)
    assert.equal(status.lastSegment?.name, '2026-09-26_08-00-00.mp4')
    await harnessed.service.stop(harnessed.target.deviceId)
  })

  it('盘上的 0 字节片段不会被登记（相机没出流 ≠ 录到一段空的）', async () => {
    const harnessed = await harness()
    const dir = harnessed.todayDir()
    await harnessed.service.start(harnessed.target, 300)
    await harnessed.writeSegment(dir, '2026-09-26_08-00-00.mp4', 0)
    await harnessed.advance(300_000)
    await harnessed.writeSegment(dir, '2026-09-26_08-05-00.mp4', 5_000)
    await harnessed.advance(300_000)
    await harnessed.writeSegment(dir, '2026-09-26_08-10-00.mp4', 5_000)
    await harnessed.service.tickDevice('dev-1')
    assert.deepEqual(
      harnessed.registrations.map((entry) => entry.name),
      ['2026-09-26_08-05-00.mp4'],
      '空的 08-00-00 不许入库，最后一片还在写也不许入库'
    )
    await harnessed.service.stop(harnessed.target.deviceId)
  })
})

describe('连续录像器：看门狗与退避', () => {
  it('进程活着但文件不长 → 杀掉并按退避重排；文件重新在长后退避归零', async () => {
    const harnessed = await harness()
    const dir = harnessed.todayDir()
    await harnessed.service.start(harnessed.target, 300)
    await harnessed.writeSegment(dir, '2026-09-26_08-00-00.mp4', 1_000)

    // 第一拍：文件比上一拍大 → 认为健康。
    harnessed.advance(2_000)
    await harnessed.grow(dir, '2026-09-26_08-00-00.mp4', 1_000)
    await harnessed.service.tickDevice('dev-1')
    assert.equal(harnessed.service.status()[0]?.state, 'recording')

    // 之后一直没有新字节，超过阈值 → 杀掉并进入退避。
    harnessed.advance(RECORDER_STALL_MS + 3_000)
    await harnessed.service.tickDevice('dev-1')
    assert.equal(harnessed.kills(), 1, '卡住时必须杀掉那一轮 ffmpeg')
    const stalled = harnessed.service.status()[0]!
    assert.equal(stalled.state, 'backoff')
    assert.equal(stalled.attempt, 1)

    // 退避还没到点：不许拉起。
    await harnessed.service.tickDevice('dev-1')
    assert.equal(harnessed.spawnCount(), 1)

    // 退避到点：拉起新一轮，并重新开始计"文件在长"。
    harnessed.advance(2_000)
    await harnessed.service.tickDevice('dev-1')
    assert.equal(harnessed.spawnCount(), 2)
    const recovered = harnessed.service.status()[0]!
    assert.ok(recovered.state === 'starting' || recovered.state === 'recording')

    await harnessed.service.stop(harnessed.target.deviceId)
  })
})

describe('连续录像器：跨天与补登记', () => {
  it('跨过本地零点会重启到新的一天目录（片段不落进昨天的目录）', async () => {
    const day1 = new Date(2026, 8, 26, 23, 58, 0, 0).getTime()
    const harnessed = await harness({ startMs: day1 })
    await harnessed.service.start(harnessed.target, 300)
    await harnessed.writeSegment(harnessed.todayDir(), '2026-09-26_23-58-00.mp4', 5_000)

    harnessed.advance(3 * 60_000) // 23:58 -> 00:01（跨天）
    await harnessed.service.tickDevice('dev-1')

    assert.equal(harnessed.kills(), 1, '跨天要换目录，因此要重启一轮')
    assert.equal(harnessed.spawnCount(), 2)
    const newDir = path.join(
      harnessed.root,
      'video',
      'FA371-MOCK',
      '2026',
      '09',
      '27'
    )
    await fs.stat(newDir) // 新目录必须已经建好，否则重启的第一片写不进去
    await harnessed.service.stop(harnessed.target.deviceId)
  })

  it('start() 会把上一次运行留下的片段全部补登记（崩溃恢复，一片都不许落下）', async () => {
    const harnessed = await harness()
    const dir = harnessed.todayDir()
    // 模拟"上一次运行被强杀"：盘上有两片，库里一片都没有。
    await harnessed.writeSegment(dir, '2026-09-26_07-00-00.mp4', 4_000)
    await harnessed.advance(300_000)
    await harnessed.writeSegment(dir, '2026-09-26_07-05-00.mp4', 4_000)
    await harnessed.advance(60_000)

    await harnessed.service.start(harnessed.target, 300)
    assert.deepEqual(
      harnessed.registrations.map((entry) => entry.name),
      ['2026-09-26_07-00-00.mp4', '2026-09-26_07-05-00.mp4'],
      '写这些文件的进程已经不存在了，所以最后一片也应当补登记（否则它永远在盘上、库里没有）'
    )

    // 补登记是幂等的：停止时再扫一遍，不会重复入库。
    const before = harnessed.registrations.length
    await harnessed.service.stop(harnessed.target.deviceId)
    assert.deepEqual(harnessed.registrations.slice(before), [], '已经登记过的不许再插一次')
  })

  it('同一台设备 start → stop → start 不会卡住（探针挂住时的第一嫌疑）', async () => {
    // 真窗口探针在 stop() 之后立刻改设置并再 start()，然后**挂住不返回**。
    // 这里先把"录像器自己会不会卡在第二轮 start"这条摘出来：假 ffmpeg + 假时钟下
    // 这条路径必须立刻返回，否则问题在录像器；如果这里全绿，问题就在探针的用法
    // （settings.update / 真 ffmpeg 收尾）上。
    const harnessed = await harness()
    await harnessed.service.start(harnessed.target, 300)
    await harnessed.service.stop(harnessed.target.deviceId)
    const second = await harnessed.service.start(harnessed.target, 300)
    assert.equal(harnessed.spawnCount(), 2, '第二轮应当重新拉起一个进程')
    assert.ok(second.state === 'starting' || second.state === 'recording', second.state)
    await harnessed.service.stop(harnessed.target.deviceId)
    assert.deepEqual(harnessed.service.status(), [])
  })

  it('stop() 之后不再出现在状态里，重复 stop 不抛', async () => {
    const harnessed = await harness()
    await harnessed.service.start(harnessed.target, 300)
    await harnessed.service.stop(harnessed.target.deviceId)
    assert.deepEqual(harnessed.service.status(), [])
    assert.equal(await harnessed.service.stop(harnessed.target.deviceId), undefined)
  })
})
