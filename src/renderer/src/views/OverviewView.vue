<script setup lang="ts">
/**
 * Overview / dashboard (spec section 8.3).
 *
 * 这一页现在只有一块内容：**实时视频墙**。
 *
 * 这一轮删掉了原先的两张卡片 —— 「最近告警」与「设备状态」。产品负责人的原话是
 * 「设备状态不需要在总览中显示，告警状态也不需要」，并且明确**只删这两张卡**：
 * 顶栏上的设备总数／在线数指示器与告警铃铛角标不动（`AppTopbar.vue`），它们属于
 * 窗口级 chrome，在每一个页面上都在，说的也仍然是同样两个数。
 *
 * 两张卡一起删掉的还有只喂给它们的那部分代码：`alarms.loadRecent()` 调用与
 * `devices.refreshTick` 上的那个 watch。留着它们就是「读一份没有任何读者的列表」，
 * 而这一页本来也不该在没有任何显示需求时去查数据库。设备列表由 shell 在会话开始时
 * 读一次（`AppShell.vue`），视频墙在列表为空时还会自己补读一次
 * （`CameraVideoWall.vue` 的 `onMounted`），所以这里不需要第二份读取。
 *
 * 空状态也跟着走了：两张卡各自的 `EmptyState`（暂无告警记录／尚未添加设备）随卡片
 * 一起删除。而**设备列表读取失败**那条也不再画在这一页上了：它是应用级的失败
 * （`devices.error`），由 shell 报进顶栏那颗告警图标里的「系统消息」（业主 2026-09-18：
 * 这类内容放在告警图标内，不要挂在页面顶上）。这一页因此连一条页内横幅都没有 ——
 * 「打开软件第一眼就是画面」在字面上仍然成立。
 */
import { useDevicesStore } from '@renderer/stores/devices'
import CameraVideoWall from '@renderer/components/CameraVideoWall.vue'

const devices = useDevicesStore()

</script>

<template>
  <div class="page overview-page">
    <!--
      实时视频：产品要求「总览里面应该有直接的视频播放窗口」，并要求它支持
      1 / 4 / 16 分屏（相机墙档位 1 / 4 / 9 / 16，一格 = 一台相机，
      9 是 3×3 的安防标准档位）。

      这里用**多路视频墙**而不是单路面板：总览是应用启动后第一个渲染的页面，
      而「相机在工作就直接出画面」这个要求必须在这一页自己完成。挂载时的那一次
      自动起播由墙自己发起（`auto-play` 属性，见 `CameraVideoWall.vue`），判定仍然
      只有 `shared/domain/camera-autoplay.ts` 里的 `decideCameraAutoPlay()` 一份。

      没有画面（未分配相机、或这一路没在播）的格子由墙渲染成一块有边框的占位区，
      不是黑矩形，也不是转圈的加载态。

      它是这一页的第一个区块：统计数字已经搬到顶栏（`AppTopbar.vue`），告警与设备
      两张卡这一轮被产品删掉，所以「打开软件第一眼就是画面」现在字面上成立。
    -->
    <CameraVideoWall class="overview-video-wall" data-overview-version="v6-overview-charts" :active-device-id="devices.selectedDeviceId" auto-play />

  </div>
</template>


<style scoped>
/* Overview keeps a single responsibility: the live video wall fills the available workspace. */
.overview-page {
  min-height: 0;
  height: 100%;
  gap: var(--space-2, 8px);
  overflow: auto;
}





.overview-video-wall {
  flex: 1 1 auto;
  min-height: 360px;
}
</style>
