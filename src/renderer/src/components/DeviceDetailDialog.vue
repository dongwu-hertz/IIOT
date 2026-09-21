<script setup lang="ts">
/**
 * 设备详情弹窗 —— 全局唯一的弹窗宿主（业主 20260921：设备详情从整页改为弹窗）。
 *
 * 挂在 `AppShell`（与窗口同寿命），任何页面想打开设备详情都经
 * `stores/deviceDetailDialog` 的 `show(id, name)` 触发这里 —— 打开状态只有这一份。
 * `/devices/:id` 路由保留：深链直达仍然得到整页详情（`modal` 不传），那种语境下
 * 本组件不登场。
 *
 * 外壳是 `AppModal`：宽 `min(1100px, 92vw)`，内容区限高 `min(760px, 90vh)` 并自己
 * 滚动 —— 详情页页签多，弹窗不能跟着内容无限长高。Esc / 点遮罩 / X 都是"请求关闭"，
 * 先交给详情页自己的未保存守卫（`requestCloseGuarded`）：当前页签有没写完的配置时
 * 弹确认，「放弃修改」才真正关，「继续编辑」留在原地。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppModal from '@renderer/components/AppModal.vue'
import DeviceDetailView from '@renderer/views/DeviceDetailView.vue'
import { useDeviceDetailDialogStore } from '@renderer/stores/deviceDetailDialog'
import { useDevicesStore } from '@renderer/stores/devices'

const { t } = useI18n()
const dialog = useDeviceDetailDialogStore()
const devices = useDevicesStore()

const view = ref<InstanceType<typeof DeviceDetailView> | null>(null)

/**
 * 弹窗标题 = 设备名。`show()` 打开那一刻由调用方传入；调用方手里没有名字时
 * （只带了 id）退回设备列表查一次，再不行给通用标题 —— 标题栏不能空着，
 * 它是读屏器认识这个对话框的门牌。
 */
const dialogTitle = computed(() => {
  if (dialog.title) return dialog.title
  return devices.byId(dialog.deviceId)?.name ?? t('app.nav.deviceDetail')
})

/**
 * AppModal 的 X / Esc / 点遮罩都汇成一次 `update:modelValue(false)` 请求。
 * 不直接关：先过详情页的未保存守卫，确认「放弃修改」后才真正收弹窗。
 */
function onRequestClose(open: boolean): void {
  if (open) {
    dialog.open = true
    return
  }
  if (!view.value) {
    dialog.close()
    return
  }
  view.value.requestCloseGuarded()
}
</script>

<template>
  <AppModal
    :model-value="dialog.open"
    :title="dialogTitle"
    width="min(1100px, 92vw)"
    @update:model-value="onRequestClose"
  >
    <div class="device-detail-dialog__body">
      <DeviceDetailView v-if="dialog.deviceId" ref="view" :id="dialog.deviceId" modal />
    </div>
  </AppModal>
</template>

<style scoped>
/*
 * 内容区限高并自己滚动：详情页的页签内容（通道表八行、网络配置…）远超一屏，
 * 弹窗整体高度必须由这一格钳住，而不是跟着内容长。减掉的 64px 约等于弹窗
 * 标题栏 + 上下内边距，保证 90vh 的矮窗口里标题栏也不被顶出屏幕。
 */
.device-detail-dialog__body {
  max-height: min(760px, calc(90vh - 64px));
  overflow-y: auto;
}
</style>
