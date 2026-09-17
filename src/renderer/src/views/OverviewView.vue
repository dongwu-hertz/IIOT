<script setup lang="ts">
/**
 * Overview / dashboard (spec section 8.3).
 *
 * 这一页现在只有两块内容：**实时视频墙**和**通道墙**。
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
 * 一起删除。剩下唯一一种「说点什么」的情况是设备列表读取失败，那条错误由上面的
 * `devices.error` 原样显示 —— 那是真实状态，不是解释。
 */
import { useDevicesStore } from '@renderer/stores/devices'
import ChannelWall from '@renderer/components/ChannelWall.vue'
import CameraVideoWall from '@renderer/components/CameraVideoWall.vue'

const devices = useDevicesStore()
</script>

<template>
  <div class="page">
    <div v-if="devices.error" class="alert alert--danger" role="alert">{{ devices.error }}</div>

    <!--
      实时视频：产品要求「总览里面应该有直接的视频播放窗口」，并要求它支持
      1 / 4 / 16 分屏。两块墙的档位**故意不同**：相机墙 1 / 4 / 9 / 16（一格 = 一台
      相机，9 是 3×3 的安防标准档位），通道墙 1 / 2 / 4 / 8（一格 = 一路通道，
      8 对应 AE08 的 8 路通道，见 `ChannelWall.vue`）。

      这里用**多路视频墙**而不是单路面板：总览是应用启动后第一个渲染的页面，
      而「相机在工作就直接出画面」这个要求必须在这一页自己完成。挂载时的那一次
      自动起播由墙自己发起（`auto-play` 属性，见 `CameraVideoWall.vue`），判定仍然
      只有 `shared/domain/camera-autoplay.ts` 里的 `decideCameraAutoPlay()` 一份。

      没有画面（未分配相机、或这一路没在播）的格子由墙渲染成一块有边框的占位区，
      不是黑矩形，也不是转圈的加载态。

      它是这一页的第一个区块：统计数字已经搬到顶栏（`AppTopbar.vue`），告警与设备
      两张卡这一轮被产品删掉，所以「打开软件第一眼就是画面」现在字面上成立。
    -->
    <CameraVideoWall :active-device-id="devices.selectedDeviceId" auto-play />

    <!-- 通道墙：1 / 2 / 4 / 8 分屏的通道总览，自带走空状态与空设备时的隐身处理。 -->
    <ChannelWall />
  </div>
</template>
