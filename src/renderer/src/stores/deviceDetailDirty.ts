/**
 * 设备详情里三处「草稿式」配置的脏标记登记处（业主 20260921）：
 * RS485、Modbus、通道表。这三块的草稿都住在各自组件的本地 `draft` 里
 * （理由见各组件文件头），而"当前页签有没有没写完的配置"这件事，详情页和
 * 弹窗宿主都要问 —— 页签切换与弹窗关闭前的未保存确认（AppModal confirm）
 * 就靠它决定要不要拦。
 *
 * 为什么不放进 `deviceConfig` store：那一份是设备读回来的**权威状态**；脏标记是
 * 界面会话期的临时事实，混进去会让"设备的数据"与"用户打了一半的字"无法区分。
 * 用 Pinia 而不用模块级 ref 的理由与 `stores/uiRefresh.ts` 相同：跨组件共享、
 * 比组件寿命长、热更新与测试里可重置。
 *
 * 不变式：同一时间至多一个详情实例（弹窗或全页路由二选一），且未保存确认会拦住
 * "带着脏页签离开"这件事，所以任意时刻至多一个 section 是脏的；但登记处本身
 * 不依赖这条不变式 —— 它是三个独立布尔，任何组合都能表达。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export type DeviceDetailDirtySection = 'rs485' | 'modbus' | 'channels'

export const useDeviceDetailDirtyStore = defineStore('deviceDetailDirty', () => {
  const rs485 = ref(false)
  const modbus = ref(false)
  const channels = ref(false)

  /** 任意一处脏 = 切页签 / 关弹窗前需要确认。 */
  const anyDirty = computed(() => rs485.value || modbus.value || channels.value)

  function mark(section: DeviceDetailDirtySection, value: boolean): void {
    if (section === 'rs485') rs485.value = value
    else if (section === 'modbus') modbus.value = value
    else channels.value = value
  }

  /** 详情实例卸载时归零（组件自身卸载时已逐个置 false，这里是兜底）。 */
  function reset(): void {
    rs485.value = false
    modbus.value = false
    channels.value = false
  }

  return { rs485, modbus, channels, anyDirty, mark, reset }
})
