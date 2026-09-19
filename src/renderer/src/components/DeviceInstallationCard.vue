<script setup lang="ts">
/**
 * 地址信息只读卡片（业主 2026-09-17 第 1 条；2026-09-18 第 7 / 10 条改名并把
 * **基准声压级删掉**）：点位（GIS 经纬度）/ 方位角。
 *
 * **只读**，用的就是全应用共有的 `.kv` 键值列表（设备详情页与实时检测页各挂一次）。
 * 为什么不做成第二处输入框：录入在两处 —— 「添加设备」对话框与设备管理页的「编辑」对话框
 * （那里有校验、有写库、有读回）。这里再放一套输入框就是同一件事的第三处实现，而三处实现里
 * 只要有一处判据不同，同一个点位就会在两页显示成两个样子。
 *
 * 两件必须成立的事：
 *   1. **没填的字段显示「未录入」，不显示 0** —— 纬度 0 是几内亚湾上的一个真实坐标，
 *      与"这个点位没录过"是两件完全不同的事，而 `0` 与 `undefined` 在界面上只差一个字。
 *   2. **经纬度成对才算一个点位**：只录了纬度时点位那一行说"只录了一半"，而不是把它
 *      显示成一个只有一半坐标的点 —— 声源定位拿一个半坐标算出来的方向是错的。
 *
 * 2026-09-19（第 10 批第 7 条后半「支持 GIS 显示」）补了两件事，都只在**点位成对**时出现：
 *   · **「在地图信息里查看」**：跳到 `/map?device=<id>`，地图页会选中这一台并打开它的悬停卡
 *     （见 `lib/deviceMapLink.ts`）。本机不联网取瓦片，所以"GIS 显示"就是"把点位真的画到
 *     地图页上、并且能从别处一键定位到它"；
 *   · **「复制坐标」**：把 `纬度, 经度` 复制走，粘进任何 GIS 工具/坐标拾取器都能用
 *     （十进制度是那个域里最通用的交换形式，`DeviceInstallation` 的注释里写了口径）。
 * 点位**一半**时这两个入口都不给：半截坐标落不了图，给一个点了什么也没有的按钮比不给更糟。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DeviceInstallation } from '@shared/domain/models'
import { hasInstallation, isPointComplete } from '@shared/domain/device-installation'
import { deviceMapLink, isMappable } from '@renderer/lib/deviceMapLink'

const props = defineProps<{
  installation?: DeviceInstallation
  /**
   * 这一台的设备 id（可选）。
   *
   * 缺席时**不渲染**那两个 GIS 入口：地图页要的是 id，而"猜一个"没有任何依据。
   * 两个调用点（设备详情页 / 实时检测页）都传得出来，所以实际不会缺席。
   */
  deviceId?: string
}>()

const { t } = useI18n()

/** 全空：这张卡片整体说"未录入"，而不是每行一个"未录入"。 */
const empty = computed(() => !hasInstallation(props.installation))

/** 点位那一行的文字：成对才写出坐标，只录一半就如实说。 */
const pointText = computed(() => {
  const installation = props.installation
  if (!installation || !hasInstallation(installation)) return t('installUi.unset')
  if (!isPointComplete(installation)) return t('installUi.halfPoint')
  if (installation.gisLatitude === undefined) return t('installUi.unset')
  return `${installation.gisLatitude}, ${installation.gisLongitude}`
})

function degrees(value: number | undefined, unit: string): string {
  return value === undefined ? t('installUi.unset') : `${value}${unit}`
}

/** 那两个 GIS 入口显示的**唯一**条件：点位成对，而且知道是哪一台设备。 */
const canShowOnMap = computed(
  () => isMappable(props.installation) && (props.deviceId ?? '').trim() !== ''
)

const mapTarget = computed(() => deviceMapLink(props.deviceId ?? ''))

const copied = ref(false)

/**
 * 复制坐标。
 *
 * 复制的是**点位那一行的原文**（`纬度, 经度`）：那是十进制度、逗号分隔，粘进任何 GIS 工具
 * 都能用；再格式化一遍（补零、换成度分秒）只会让用户拿到一个与我们库里不一致的字符串。
 */
async function copyPoint(): Promise<void> {
  const installation = props.installation
  if (!installation || !isPointComplete(installation)) return
  try {
    await navigator.clipboard.writeText(pointText.value)
    copied.value = true
    window.setTimeout(() => {
      copied.value = false
    }, 1600)
  } catch {
    // 复制失败不弹错：坐标就在屏幕上，用户可以自己选中（与设置页 copy 的处理一致）。
  }
}
</script>

<template>
  <section class="card install-card">
    <div class="section-header">
      <h3 class="section-title">{{ t('installUi.section') }}</h3>
      <span v-if="empty" class="muted">{{ t('installUi.unset') }}</span>
    </div>
    <!--
      两行**一直画出来**（空的那一行显示「未录入」）：只画有值的那几行时，"没录方位角"
      与"这一版不显示方位角"长得一模一样，而这两件事对声源定位的含义完全不同。
      （基准声压级那一行按业主 2026-09-18 第 10 条删掉了。）
    -->
    <dl class="kv" data-installation>
      <div class="kv__item">
        <dt class="kv__label">{{ t('installUi.point') }}</dt>
        <dd class="kv__value mono" data-installation-point>{{ pointText }}</dd>
      </div>
      <div class="kv__item">
        <dt class="kv__label">{{ t('installUi.azimuth') }}</dt>
        <dd class="kv__value">
          {{ degrees(installation?.azimuthDeg, '°') }}
          <span class="muted">{{ t('installUi.azimuthHint') }}</span>
        </dd>
      </div>
      <!--
        GIS 的两个入口（业主第 7 条后半）。**只有点位成对**时才画出来：
        半截坐标落不了图，那个链接点了会到地图页却找不到这一台。
      -->
      <div v-if="canShowOnMap" class="kv__item">
        <dt class="kv__label">{{ t('installUi.gisLabel') }}</dt>
        <dd class="kv__value">
          <span class="gis-actions">
            <RouterLink
              class="btn btn--sm"
              data-action="open-device-on-map"
              :to="mapTarget"
            >
              {{ t('installUi.viewOnMap') }}
            </RouterLink>
            <button
              type="button"
              class="btn btn--sm btn--ghost"
              data-action="copy-device-point"
              @click="copyPoint"
            >
              {{ copied ? t('installUi.pointCopied') : t('installUi.copyPoint') }}
            </button>
          </span>
        </dd>
      </div>
    </dl>
  </section>
</template>

<style scoped>
.install-card {
  /* 与设备详情页其他卡片同一个落点：卡片自己不带外边距，由父级网格给间距。 */
  min-width: 0;
}

.kv {
  margin: 0;
}

/* 两个按钮一行：宽窗口上并排，窄了自动换行（卡片本身可以被压到 ~360px）。 */
.gis-actions {
  display: inline-flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
</style>
