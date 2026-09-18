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
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DeviceInstallation } from '@shared/domain/models'
import { hasInstallation, isPointComplete } from '@shared/domain/device-installation'

const props = defineProps<{ installation?: DeviceInstallation }>()

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
</style>
