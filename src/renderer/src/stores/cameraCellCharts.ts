/**
 * 画面格里那三种图的数据来源（业主 2026-09-18 第 10 批第 2 条）。
 *
 * ---------------------------------------------------------------------------
 * 为什么不复用 `stores/fa371Stream.ts`
 * ---------------------------------------------------------------------------
 * 那个 store 是**单设备**的（`deviceId` + `selectDevice()`），服务的是"当前在看哪一台相机"
 * 的监测页；而画面墙上可能同时有好几格的图表，来源是**多台**设备。硬把它们合成一个
 * store 会让"换一格"变成"换整个会话"（`selectDevice()` 会清缓冲），于是每点一格图就闪一次。
 *
 * ---------------------------------------------------------------------------
 * 订阅的粒度：**每台设备一份**，kinds 取该设备所有图表格的并集
 * ---------------------------------------------------------------------------
 * `fa371Stream.start` 的入参是"这一台设备想要的**全部**通道"（与 `monitor.start` 同一形状），
 * 所以同一台设备上两格图（一格时域、一格频域）必须**合并**成一次订阅：
 * 各订各的会让第二次把第一次顶掉，表现是"后切的那一格有数据，先切的那格不动了"。
 *
 * 相机侧的 WebSocket 路数是有限的（实测约 6 条，见 `Fa371StreamMeasurement`），所以本 store
 * 每台设备最多开 `pcmData` + `fftData` **两条**，并在最后一份订阅释放时立刻停掉 ——
 * 不看图的时候不该占着相机的连接数。
 *
 * ---------------------------------------------------------------------------
 * 缓冲：两种，都是有界的
 * ---------------------------------------------------------------------------
 *   · `pcm`：最近 `CAMERA_CELL_WAVEFORM_FRAMES`（10）帧包络 ⇒ 恰好 1 秒；
 *   · `fft`：最近 `CAMERA_CELL_SPECTROGRAM_COLUMNS`（30）帧谱线 ⇒ 时频谱图的那 30 列。
 * 有界是硬要求：一个忘了设上限的数组在值班台上跑一夜就是内存泄漏。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Fa371FftPreview, Fa371PcmPreview, Fa371StreamKind } from '@shared/domain/fa371-stream'
import {
  CAMERA_CELL_SPECTROGRAM_COLUMNS,
  CAMERA_CELL_WAVEFORM_FRAMES
} from '@shared/domain/camera-cell-view'
import { callApi, unwrap } from '@renderer/lib/result'
import { pushCapped } from '@renderer/lib/cameraCellChart'

/** 一台设备当前被订阅的通道集合。 */
interface DeviceCharts {
  kinds: Fa371StreamKind[]
  pcm: Fa371PcmPreview[]
  fft: Fa371FftPreview[]
  /** 最近一帧的时间戳，界面据此说"多久没数据了"。 */
  lastAt?: number
  error?: string
}

export const useCameraCellChartsStore = defineStore('cameraCellCharts', () => {
  /**
   * 订阅表。
   *
   * 用 `ref` 包一个普通对象并整体替换（与 `stores/liveWall.ts` 同一条做法）：
   * Vue 的深层响应式代理传进纯函数会很危险，而且这里每次都是"算出一份新的"，整体替换更好推理。
   */
  const devices = ref<Record<string, DeviceCharts>>({})
  const now = ref(0)
  /** 已安装的推送监听（只装一次；第二次会每一帧都处理两遍）。 */
  let unsubscribers: Array<() => void> = []

  function subscribe(): void {
    if (unsubscribers.length > 0) return
    if (typeof window === 'undefined' || !window.events) return
    const events = window.events
    unsubscribers = [events.onFa371Pcm(handlePcm), events.onFa371Fft(handleFft)]
  }

  /** 拆掉推送监听（只在本 store 被 dispose 时调用）。 */
  function detachListeners(): void {
    for (const releaseOne of unsubscribers) {
      try {
        releaseOne()
      } catch {
        // 一个释放失败不该把其余的留在那里。
      }
    }
    unsubscribers = []
  }

  function belongs(deviceId: string): DeviceCharts | undefined {
    return devices.value[deviceId]
  }

  function handlePcm(preview: Fa371PcmPreview): void {
    const entry = belongs(preview.deviceId)
    if (!entry) return
    entry.pcm = pushCapped(entry.pcm, preview, CAMERA_CELL_WAVEFORM_FRAMES)
    entry.lastAt = preview.timestamp
    devices.value = { ...devices.value, [preview.deviceId]: entry }
    now.value = Date.now()
  }

  function handleFft(preview: Fa371FftPreview): void {
    const entry = belongs(preview.deviceId)
    if (!entry) return
    entry.fft = pushCapped(entry.fft, preview, CAMERA_CELL_SPECTROGRAM_COLUMNS)
    entry.lastAt = preview.timestamp
    devices.value = { ...devices.value, [preview.deviceId]: entry }
    now.value = Date.now()
  }

  /**
   * 某一格需要 `kind` 才能画 → 登记一次。
   *
   * 返回 `false` 表示**没能开始**（主进程拒绝了，通常是没权限）：界面据此说"这一路打不开"，
   * 而不是画一张永远空着的图。
   */
  async function require(deviceId: string, kind: Fa371StreamKind): Promise<boolean> {
    if (deviceId === '') return false
    subscribe()
    const current = devices.value[deviceId]
    if (current?.kinds.includes(kind)) return true
    const kinds = [...(current?.kinds ?? []), kind]
    // 先落表（哪怕还没确认）：这样推送一到就能进缓冲，不必等一次 IPC 往返。
    devices.value = {
      ...devices.value,
      [deviceId]: { kinds, pcm: current?.pcm ?? [], fft: current?.fft ?? [] }
    }
    const result = await callApi(() => window.api.fa371Stream.start({ deviceId, kinds }))
    if (!result.success) {
      const entry = devices.value[deviceId]
      if (entry) entry.error = result.error?.message ?? 'start-failed'
      devices.value = { ...devices.value }
      return false
    }
    const state = unwrap(result)
    const entry = devices.value[deviceId]
    if (entry) entry.error = state?.streams?.some((item) => item.lastError) ? 'stream-error' : undefined
    devices.value = { ...devices.value }
    return true
  }

  /** 某一格不再需要 `kind` 了 → 收回；这一台设备一条都不要了就停掉它的会话。 */
  function release(deviceId: string, kind: Fa371StreamKind): void {
    const current = devices.value[deviceId]
    if (!current) return
    const kinds = current.kinds.filter((item) => item !== kind)
    if (kinds.length === current.kinds.length) return
    if (kinds.length === 0) {
      const next = { ...devices.value }
      delete next[deviceId]
      devices.value = next
      void callApi(() => window.api.fa371Stream.stop(deviceId))
      return
    }
    devices.value = { ...devices.value, [deviceId]: { ...current, kinds } }
    // 主进程的入参是"全部想要的通道"：少了一条也要重新下发一次，否则那一路会一直推。
    void callApi(() => window.api.fa371Stream.start({ deviceId, kinds }))
  }

  /** 离开画面墙：停掉所有会话并拆掉监听。 */
  function dispose(): void {
    const ids = Object.keys(devices.value)
    devices.value = {}
    detachListeners()
    for (const deviceId of ids) {
      void callApi(() => window.api.fa371Stream.stop(deviceId))
    }
  }

  const deviceIds = computed(() => Object.keys(devices.value))

  return { devices, now, deviceIds, require, release, dispose }
})
