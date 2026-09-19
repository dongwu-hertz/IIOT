/**
 * IoT 数据接入的读数（业主 2026-09-19 第 1 条）。
 *
 * 与配置分开：配置写在 `settings.iotIngest` 里（走 `settings.update`），这个 store 只持有
 * **主进程报回来的事实** —— 监听起没起来、收到多少、最近一次认不认得出来。
 *
 * 为什么不并进 `stores/settings.ts`：那一个的语义是"可编辑的设置草稿"，而这个是一份
 * **只读读数**（和 `diskUsage` / `trends.stats` 同一类）。混进去之后，"保存设置"会不会把
 * 读数也写回主进程，就变成下一个需要想的问题。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { IotIngestRuntimeStatus } from '@shared/ipc/contract'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'

export const useIngestStore = defineStore('ingest', () => {
  const status = ref<IotIngestRuntimeStatus | null>(null)
  const loading = ref(false)
  const error = ref('')

  /** 读一次。失败时**保留上一次的读数**并置 `error`（把读数清空会被读成"什么都没收到"）。 */
  async function load(): Promise<void> {
    loading.value = true
    const result = await callApi(() => window.api.ingest.status())
    loading.value = false
    if (!result.success) {
      error.value = resultMessage(result)
      return
    }
    status.value = unwrap(result) ?? null
    error.value = ''
  }

  /**
   * 有没有在听。
   *
   * 判据是**真实的监听状态**而不是配置里的开关：配置说开着而端口被占时，界面上必须能看出
   * 「开关是开的，但它没在听」，这两个数在卡片上是分开显示的两行。
   */
  const listening = computed(
    () => Boolean(status.value?.http.listening) || Boolean(status.value?.mqtt.listening)
  )

  return { status, loading, error, listening, load }
})
