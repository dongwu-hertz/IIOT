/**
 * 声学预览回放里的**纯计算** —— 重采样与"浅队列"的时刻计算。
 *
 * 谁在用：`lib/envelopePlayer.ts`（WebAudio 适配层，被实时监测页与相机声学面板共用）；
 * 这个文件本身不碰任何浏览器对象，所以单测能在 node 里把这些判断逐条钉死。
 *
 * 为什么是"包络"而不是原声
 * 跨 IPC 过来的是 100 ms 一帧的**降采样包络**（`AudioFrameEvent.waveform`，每个桶取
 * 绝对值最大的那个采样点，所以瞬态不会被平均掉），不是 4800 个原始采样。回放把每个
 * 包络按它自己真实的 100 ms 时长线性重采样成一个 buffer 排进队列：**时间是准的，
 * 声音不是原声**。界面上的说明必须照这个说 —— 写"播放录音"就是在骗操作员。
 *
 * 为什么队列要"浅"
 * 每帧都往后排，渲染进程一卡（切页、长任务）队列就会越排越远，于是操作员按下"停止"
 * 之后声音还在响，而且是几秒钟前的旧声音。所以只允许领先 30 ms、积压超过 300 ms 就
 * 丢弃积压重新对齐（宁可听到一次小的跳变，也不要无界的延迟）。
 */

/** 排一帧时至少领先当前时刻多久（秒）。 */
export const PREVIEW_LEAD_SECONDS = 0.03

/** 允许的最大积压（秒）：超过就把队列拉回"现在 + 领先量"。 */
export const PREVIEW_MAX_BACKLOG_SECONDS = 0.3

/** 音量默认值（百分比）。这是我们自己定的：留给操作员调大的余地，也避免一按就满音量。 */
export const DEFAULT_VOLUME_PERCENT = 60

/**
 * 把一条包络线性重采样成 `length` 个采样点。
 *
 * 端点保留（首尾各取包络的首尾），中间线性插值 —— 与 ECharts 画这条包络用的是同一套
 * 视觉语义，所以"听到的"和"看到的"是同一个形状。
 *
 * 退化输入都返回**静音**而不是抛错：空包络（设备还没送出波形）、长度为 1 的包络
 * （整帧一个点）在真实数据里都会出现，它们应当听起来是安静的，而不是让回放整个挂掉。
 */
export function resampleEnvelope(
  waveform: readonly number[],
  length: number
): Float32Array<ArrayBuffer> {
  const size = Math.max(2, Math.floor(length))
  const out = new Float32Array(size)
  if (waveform.length === 0) return out
  if (waveform.length === 1) {
    out.fill(waveform[0] ?? 0)
    return out
  }
  for (let index = 0; index < size; index += 1) {
    const position = (index / (size - 1)) * (waveform.length - 1)
    const low = Math.floor(position)
    const high = Math.min(waveform.length - 1, low + 1)
    const fraction = position - low
    out[index] = (waveform[low] ?? 0) * (1 - fraction) + (waveform[high] ?? 0) * fraction
  }
  return out
}

/**
 * 下一帧应当**开始播放**的时刻。
 *
 * 纯函数，因为这段"浅队列"的判断是回放里唯一容易写错、又最难在真机上复现的部分
 * （要制造渲染进程卡顿才能看到积压），所以它必须能被单测直接钉住。
 *
 * @param current 当前排队位置（上一帧结束后指针所在时刻）
 * @param now AudioContext 的当前时刻
 * @param lead 至少领先多久
 * @param maxBacklog 允许的最大积压
 */
export function scheduleStartTime(
  current: number,
  now: number,
  lead: number = PREVIEW_LEAD_SECONDS,
  maxBacklog: number = PREVIEW_MAX_BACKLOG_SECONDS
): number {
  // 落后于当前时刻（暂停过、或第一帧）：从现在 + 领先量开始。
  if (current < now) return now + lead
  // 积压太深（渲染进程卡过）：丢弃积压，重新对齐到现在 + 领先量。
  if (current - now > maxBacklog) return now + lead
  return current
}

/*
 * 包络回放器（WebAudio 那一层适配）搬去了 `envelopePlayer.ts`。
 *
 * 这个文件必须保持**不碰任何浏览器对象**：单测要在 node 里直接跑它（`AudioContext`
 * 在 node 里造不出来），所以"能测的纯函数"与"只能靠人听的适配层"分成两个文件。
 */
