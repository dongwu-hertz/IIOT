<script setup lang="ts">
/**
 * 通道墙一格里的图形 —— 声纹图 / 声压线 / 频谱图 / 时谱图。
 *
 * 这个组件只画**设备真实推来的东西**：
 *   - 设备自己渲染好的 JPEG（声纹图 `/voiceprintData`、时谱图 `/time_freq_domain`）
 *     原样交给 `<img>`，不重新绘图、不做 STFT —— 那会画出一张与固件本意不同的图，
 *     而且几何全靠猜（与 `SpectrogramViewer.vue` 同一条已实测的结论）；
 *   - 数值序列（声压线的 SPL、频谱图的幅度/谱线）交给一条内联 SVG 折线，
 *     几何由 `lib/channelWall.ts` 的 `graphGeometry()` 算 —— 纯函数、可单元测试。
 *
 * 它没有数据源，也不插值、不平滑、不模拟：没有数据时它**一个像素都不画**，由调用方
 * （`ChannelWall.vue` 的 `buildTileView()`）给出那句如实的说明。`src/renderer/src/
 * composables/useSimulatedRealtime.ts` 绝不进这条路径。
 *
 * 为什么不用已打包的 ECharts
 *   1. 8 分屏下一屏最多 8 格，每格一个 ECharts 实例（canvas + 自己的 ResizeObserver
 *      + 每个实例一份数据副本）在总览页上是纯开销，而这里要画的就是一条折线；
 *   2. 折线的几何必须是可断言的东西，而 ECharts 的选项对象只能靠人眼看；
 *   3. 仓库既有约定里图表要么用 ECharts，要么用内联 SVG（不引图标/图表库）。
 *
 * 模板里只有 `<span>`/`<img>`/`<svg>`：这一格本身是一个 `<button>`，里面不能有
 * 任何可交互的后代（嵌套按钮既不是合法结构，也会让键盘用户迷路）。
 */
import { computed } from 'vue'
import {
  GRAPH_VIEW_HEIGHT,
  GRAPH_VIEW_WIDTH,
  graphGeometry,
  type ChannelGraphKind
} from '@renderer/lib/channelWall'

const props = withDefaults(
  defineProps<{
    /** 选中的图形：决定画图像还是折线。 */
    kind: ChannelGraphKind
    /** 设备渲染好的 JPEG（data URL）；没有图像类数据时是空串。 */
    image?: string
    /** 图像的无障碍替代文本（JPEG 是设备给的画面，读屏需要一句话说清它是什么）。 */
    imageAlt?: string
    /** 折线的**真实数值**；点数不足两个时折线不画。 */
    values?: readonly number[]
    /** 折线下方那行角注：真实读数或真实量程，由调用方按语言给出。 */
    caption?: string
  }>(),
  { image: '', imageAlt: '', values: () => [], caption: '' }
)

/** 折线几何：非有限值已被丢掉，全部相等时画在中间（见 `graphGeometry()`）。 */
const geometry = computed(() => graphGeometry(props.values))

/** 这一格要画的是折线类图形（另两种是图像类）。 */
const isLine = computed(() => props.kind === 'spl' || props.kind === 'spectrum')

/**
 * 真的有东西可画吗。
 *
 * 没有就整块不渲染（组件根节点的 `v-if`），而不是留一个空的伸缩盒子在格子里占位：
 * 那会把调用方那句“为什么没有数据”的说明挤到角落，一格小格子里尤其明显。
 */
const drawable = computed(
  () => props.image !== '' || (isLine.value && geometry.value.count >= 2)
)
</script>

<template>
  <span v-if="drawable" class="wall-graph">
    <img v-if="image" class="wall-tile__image" :src="image" :alt="imageAlt" />

    <span v-else class="wall-graph__plot">
      <svg
        class="wall-graph__svg"
        :viewBox="`0 0 ${GRAPH_VIEW_WIDTH} ${GRAPH_VIEW_HEIGHT}`"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <!--
          `preserveAspectRatio="none"`：折线必须占满整格，格子宽高比与绘图区不同，
          所以形状会被拉伸。`vector-effect` 让描边仍然是 1 像素 —— 否则横向拉伸会把
          线拉粗，而这里的线宽是给人看的，不是数据。
        -->
        <polyline
          class="wall-graph__line"
          :points="geometry.points"
          vector-effect="non-scaling-stroke"
        />
      </svg>
      <span v-if="caption" class="wall-graph__caption">{{ caption }}</span>
    </span>
  </span>
</template>

<style scoped>
.wall-graph {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.wall-graph__plot {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  min-height: 0;
}

.wall-graph__svg {
  display: block;
  flex: 1 1 auto;
  width: 100%;
  min-height: 24px;
}

/*
 * 折线的颜色来自主题变量：只有一处定义，浅色/深色主题里都不用改这里。
 * `fill: none` 是必须的 —— SVG 里折线默认会被填充成一块实心多边形。
 */
.wall-graph__line {
  fill: none;
  stroke: var(--color-accent);
  stroke-width: 1.2;
  stroke-linejoin: round;
  stroke-linecap: round;
}

/* 角注：真实读数或真实量程，最多两行（8 分屏的格子很小）。 */
.wall-graph__caption {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  font-size: 11px;
  line-height: 1.3;
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
}

/* 设备给的 JPEG：等比缩放，留黑边而不是拉伸变形（与相机面板同一条规矩）。 */
.wall-tile__image {
  flex: 1 1 auto;
  width: 100%;
  min-height: 0;
  object-fit: contain;
  border-radius: var(--radius-sm);
  background: #111111;
}
</style>
