/**
 * 告警提示音播放器（业主 2026-09-23：「告警默认开启，并且默认弹窗和播放声音」）。
 *
 * ---------------------------------------------------------------------------
 * 为什么在**主窗口**播，而不是在联动弹窗窗口里播
 * ---------------------------------------------------------------------------
 * 联动弹窗（`linkage-actions.ts` 的 `ElectronPopupSink`）刻意 `javascript: false`——
 * 一段只显示文字的置顶窗口不需要脚本能力，那是它最重要的安全设置。声音因此由
 * 主窗口的渲染进程播放：告警到达时主窗口必然活着（它持有联动订阅），而弹窗可能
 * 已按 `autoDismissSeconds` 消失。
 *
 * ---------------------------------------------------------------------------
 * 播放什么
 * ---------------------------------------------------------------------------
 *   - 绑定选了 `.wav` 文件 → 用 `<audio>` 播那个文件（`file://` 地址与设置页试听
 *     同一条 `toFileUrl` 路径，字节流不过 IPC）；
 *   - 没选文件（出厂状态）→ 内置双音蜂鸣（WebAudio 振荡器），不依赖任何外部文件，
 *     保证「默认开」不是一句空话；
 *   - 绑定被用户明确关掉（`enabled === false`）→ 什么都不播。
 *
 * 节流：不管告警多密，两次发声之间至少隔 `MIN_INTERVAL_MS`——联动引擎自己有冷却，
 * 但声音这一层再设一道，防止一串突发告警变成连续噪音。
 */

import type { AlarmSoundLibrary } from '@shared/domain/alarm-sound'
import { toFileUrl } from '@renderer/lib/fileUrl'

/** 两次提示音之间的最小间隔。 */
const MIN_INTERVAL_MS = 1_500

let lastPlayAt = 0
let beepContext: AudioContext | null = null

/**
 * 播放一次「联动弹窗」提示音。
 *
 * 门的语义（与归一化器对齐）：`popup` 绑定**缺省为开**（2026-09-23 起），
 * 只有 `enabled === false` 是用户明确关掉。调用方负责决定「该不该响」
 * （比如只在出现新的未确认告警时调用），本函数只管「怎么响」。
 */
export function playAlarmPopupSound(library: AlarmSoundLibrary | null | undefined): void {
  const binding = library?.popup
  if (binding !== undefined && binding.enabled !== true) return

  const now = Date.now()
  if (now - lastPlayAt < MIN_INTERVAL_MS) return
  lastPlayAt = now

  const entry =
    binding && binding.soundId !== ''
      ? library?.items.find((item) => item.id === binding.soundId)
      : undefined
  if (entry && entry.filePath !== '') {
    playFile(entry.filePath)
    return
  }
  playBuiltinBeep()
}

/** 播用户绑定的 `.wav`。失败（文件被删/被移动）时退回内置蜂鸣——有声音总比静默强。 */
function playFile(filePath: string): void {
  try {
    const audio = new Audio(toFileUrl(filePath))
    audio.addEventListener('error', () => playBuiltinBeep(), { once: true })
    void audio.play().catch(() => playBuiltinBeep())
  } catch {
    playBuiltinBeep()
  }
}

/**
 * 内置双音蜂鸣：880 Hz 与 660 Hz 各 120 ms。
 *
 * AudioContext 按需创建并常驻（一次创建，之后每次告警复用）；创建/恢复失败
 * （没有输出设备、策略拦截）就静默放弃——提示音失败不能影响告警本身。
 */
function playBuiltinBeep(): void {
  try {
    beepContext ??= new AudioContext()
    if (beepContext.state === 'suspended') void beepContext.resume()
    const startAt = beepContext.currentTime + 0.02
    for (const [offset, frequency] of [
      [0, 880],
      [0.18, 660]
    ] as const) {
      const oscillator = beepContext.createOscillator()
      const gain = beepContext.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.value = frequency
      // 10 ms 的淡入淡出，避免方波式的爆音。
      gain.gain.setValueAtTime(0, startAt + offset)
      gain.gain.linearRampToValueAtTime(0.25, startAt + offset + 0.01)
      gain.gain.setValueAtTime(0.25, startAt + offset + 0.11)
      gain.gain.linearRampToValueAtTime(0, startAt + offset + 0.12)
      oscillator.connect(gain).connect(beepContext.destination)
      oscillator.start(startAt + offset)
      oscillator.stop(startAt + offset + 0.13)
    }
  } catch {
    // 没有音频输出设备时，提示音让位，告警本身（弹窗/待处理列表）不受影响。
  }
}
