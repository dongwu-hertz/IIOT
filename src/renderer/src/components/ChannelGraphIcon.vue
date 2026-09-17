<script setup lang="ts">
/**
 * 图形切换器的四个图标（声纹图 / 声压线 / 频谱图 / 时谱图）。
 *
 * 与 `LayoutGridIcon.vue` 同一条规矩：图标自己 `aria-hidden`，无障碍名字只由按钮上的
 * `aria-label` 给出 —— 同一个意思不让读屏软件说两遍，名字也只有一处定义。
 *
 * 为什么是四个手画的内联 SVG 而不是一个通用形状：这四种图形**画的是不同的东西**
 * （一幅设备渲染的图像 / 一条随时间的折线 / 一条随频率的谱线 / 随时间堆叠的频带），
 * 图标必须一眼能分开；仓库不引图标库，所以四个形状都画在这里。
 */
import type { ChannelGraphKind } from '@renderer/lib/channelWall'

defineProps<{
  /** 这个图标代表哪种图形。 */
  kind: ChannelGraphKind
}>()
</script>

<template>
  <!-- 声纹图：同心的弧线，像一圈一圈的声纹 -->
  <svg
    v-if="kind === 'voiceprint'"
    class="graph-icon"
    viewBox="0 0 16 16"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M3.2 2.6 A6.4 6.4 0 0 1 3.2 13.4" />
    <path d="M6.4 4.6 A4 4 0 0 1 6.4 11.4" />
    <path d="M9.6 6.6 A1.7 1.7 0 0 1 9.6 9.4" />
  </svg>

  <!-- 声压线：一条随时间的折线加一条基线 -->
  <svg
    v-else-if="kind === 'spl'"
    class="graph-icon"
    viewBox="0 0 16 16"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M1.8 11.2 L4.6 6.4 L7.2 9.4 L10 3.6 L14.2 7.6" />
    <path d="M1.8 13.6 H14.2" />
  </svg>

  <!-- 频谱图：一排高低不同的谱线加一条基线 -->
  <svg
    v-else-if="kind === 'spectrum'"
    class="graph-icon"
    viewBox="0 0 16 16"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M2.4 11.6 V7.4" />
    <path d="M5.2 11.6 V4.2" />
    <path d="M8 11.6 V8.6" />
    <path d="M10.8 11.6 V5.2" />
    <path d="M13.6 11.6 V9" />
    <path d="M1.8 13.6 H14.2" />
  </svg>

  <!-- 时谱图：随时间堆叠的几条频带，中间一条更短（能量分布不均） -->
  <svg v-else class="graph-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <rect x="1.8" y="2.6" width="12.4" height="2.6" rx="0.8" />
    <rect x="1.8" y="6.6" width="7.4" height="2.6" rx="0.8" />
    <rect x="1.8" y="10.6" width="12.4" height="2.6" rx="0.8" />
  </svg>
</template>

<style scoped>
.graph-icon {
  display: block;
  width: 15px;
  height: 15px;
}

/*
 * 线段略细：15px 的图标里要放下五条谱线或三条频带，更粗的线会把形状糊成一个实心块，
 * 那时四个图标看起来就是同一个方块。
 */
.graph-icon path,
.graph-icon rect {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.1;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
