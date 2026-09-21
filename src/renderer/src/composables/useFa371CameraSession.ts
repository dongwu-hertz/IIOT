/**
 * FA371 相机声学数据流的**会话生命周期**（业主 2026-09-21 第三批）。
 *
 * WHY THIS IS A COMPOSABLE
 * 相机分支重排成 65/35 两列之后，`CameraAcousticPanel` 从一个整幅宽的大面板被拆成
 * 按 `sections` 取用的**多份实例**（右列：声纹 + 频谱；视频下方：波形 + 检测）。
 * 而「选中相机就默认开始接收、离开就停」这件事**只能有一个主人** —— 每份面板各自
 * 开一次会话会是重复订阅（两套 socket 推同一路数据），各自停一次又会把别人还在
 * 看的画面停掉。所以生命周期从面板里搬出来，由监测页在 setup 里调用一次；
 * 面板退化成纯展示，读同一份 `fa371Stream` store。
 *
 * 行为与原来那一版逐条一致（第 10 批第 23 条「数据默认实时接收」）：
 *   1. 先 `refreshState()` 再决定 —— 主进程可能留着上一次访问的会话，不看就再开一次
 *      是重复订阅；
 *   2. 只有管理员才自动开 —— `fa371Stream.start` 的角色检查在主进程，这里只决定
 *      「要不要发起那次调用」，非管理员不发起；
 *   3. 失败不吞 —— `camera.error` 由面板的状态行渲染。
 *
 * 红外通道（`infraredData`）从这一轮起**随默认会话一起开**（业主第三批要控制条上的
 * 「红外」按钮）：16 B/帧，手册 §5.3.6 的 `/inrared_data` 由设备实时推送。设备不支持
 * 该通道时它只是自己那一路 error，不影响其余五路 —— 红外浮层用「无数据 = —」回答。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { FA371_ALL_STREAM_KINDS } from '@shared/domain/fa371-stream'
import { useFa371StreamStore } from '@renderer/stores/fa371Stream'
import { useSessionStore } from '@renderer/stores/session'

export function useFa371CameraSession(deviceId: Ref<string>, active: Ref<boolean>): void {
  const camera = useFa371StreamStore()
  const session = useSessionStore()

  const busy = ref(false)

  /** 主进程对 `fa371Stream.start` 有角色检查；与其发起一次注定失败的调用，不如不发起。 */
  const canStart = computed(() => session.isAdmin)

  /** 默认实时接收：选中相机即开始（第 23 条删掉了「开始接收」按钮）。 */
  async function ensureStreaming(): Promise<void> {
    if (!canStart.value || camera.isActive || busy.value) return
    busy.value = true
    try {
      await camera.start([...FA371_ALL_STREAM_KINDS])
    } finally {
      busy.value = false
    }
  }

  async function adoptDevice(id: string): Promise<void> {
    camera.selectDevice(id)
    // 先读一次主进程的会话状态再决定开不开：重复订阅＝两套 socket 推同一路数据。
    await camera.refreshState()
    await ensureStreaming()
  }

  /** The stale clock only exists while the camera branch is shown. */
  let clock: ReturnType<typeof setInterval> | undefined

  onMounted(async () => {
    if (!active.value || !deviceId.value) return
    await adoptDevice(deviceId.value)
    clock = setInterval(() => camera.touchClock(), 1_000)
  })

  watch(deviceId, async (id) => {
    if (!active.value || !id) return
    // Leaving a camera session running while switching would keep six sockets open
    // on a device nobody is looking at (and double every push for one frame gap).
    await camera.stop()
    await adoptDevice(id)
  })

  // 离开相机分支（切到声纹设备/声呐）：会话必须收尾，否则主进程里留着没人看的 socket。
  watch(active, (on) => {
    if (on) return
    void camera.stop()
  })

  onBeforeUnmount(() => {
    if (clock !== undefined) clearInterval(clock)
    // 两半都收：主进程里的 socket 与 preload 里的监听器。
    void camera.stop()
    camera.unsubscribe()
  })
}
