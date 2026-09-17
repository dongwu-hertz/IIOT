<script setup lang="ts">
/**
 * 分屏档位图标：一个正方形被分成 `count` 个小方格（相机墙 1 / 4 / 9 / 16，
 * 通道墙 1 / 4 / 8 / 16）。
 *
 * 几何全部来自 `layoutIconGeometry()`，而格子数与列数由调用方从驱动真实网格的那
 * 两个量传进来（档位本身，与 `cameraWallColumns()` / `layoutColumns()`），所以图标
 * 不可能和它选出来的分屏不一致。
 *
 * 图标本身 `aria-hidden`：按钮上已经有 `aria-label`（例如「4 分屏」）。同一个意思
 * 不让读屏软件说两遍，也让无障碍名字只有一处定义。
 */
import { computed } from 'vue'
import { LAYOUT_ICON_VIEW_BOX, layoutIconGeometry } from '@renderer/lib/layoutIcon'

const props = defineProps<{
  /** 这一档有几格（就是档位数字本身）。 */
  count: number
  /** 每行几格：与真实网格用的是同一个函数。 */
  columns: number
}>()

const geometry = computed(() => layoutIconGeometry(props.count, props.columns))
</script>

<template>
  <svg
    class="layout-icon"
    :viewBox="`0 0 ${LAYOUT_ICON_VIEW_BOX} ${LAYOUT_ICON_VIEW_BOX}`"
    aria-hidden="true"
    focusable="false"
  >
    <rect
      v-for="(cell, index) in geometry.cells"
      :key="index"
      :x="cell.x"
      :y="cell.y"
      :width="cell.width"
      :height="cell.height"
      rx="0.6"
      fill="none"
      stroke="currentColor"
    />
  </svg>
</template>

<style scoped>
.layout-icon {
  display: block;
  width: 15px;
  height: 15px;
}

/*
 * 线段略细：16 分屏的格子只有 2 个用户单位宽，更粗的线会把格子内部填满，
 * 那时图标看起来就是一个实心方块，而不是 16 个小方框。
 */
.layout-icon rect {
  stroke-width: 1;
}
</style>
