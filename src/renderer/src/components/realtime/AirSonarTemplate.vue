<script setup lang="ts">
/**
 * 空气声呐模板（规格 §18–§22）。
 *
 * 中心固定 Direction Radar，其余读数在左右两栏。两条硬规矩：
 *   1. **Live 模式不显示不断变化的方向角**（§20）：没有有效目标就显示 No Target；
 *      `frame.target` 只在 Event 模式且告警原文里确实有 horizontal/vertical 时存在；
 *   2. 诊断信息不伪造：`max_db_value` / TDE / FDE 的每秒实时推送尚未进入本机
 *      （设备的回调接收端还没实现），因此 Live 下这些显示 `—`；
 *      点击历史告警进入 Event 模式时才按告警原文显示当时的值。
 */

import { useI18n } from 'vue-i18n'
import type { RealtimeFrame } from '@shared/domain/realtime-monitor'
import RealtimeDirectionRadar from './RealtimeDirectionRadar.vue'
import RealtimeMetric from './RealtimeMetric.vue'

defineProps<{ frame: RealtimeFrame }>()

const { t } = useI18n()
</script>

<template>
  <div class="as" data-realtime-template="airSonar">
    <section class="as__col as__col--left">
      <header class="as__head"><h4>{{ t('realtimeUi.primary') }}</h4></header>
      <div class="as__metrics">
        <RealtimeMetric
          v-for="metric in frame.primaryMetrics"
          :key="metric.key"
          :metric="metric"
        />
      </div>
    </section>

    <section class="as__col as__col--center">
      <header class="as__head"><h4>{{ t('realtimeUi.directionRadar') }}</h4></header>
      <RealtimeDirectionRadar
        :target="frame.target"
        :empty-text="t('realtimeUi.noTarget')"
      />
    </section>

    <section class="as__col as__col--right">
      <header class="as__head"><h4>{{ t('realtimeUi.realtime') }}</h4></header>
      <div class="as__details">
        <RealtimeMetric
          v-for="metric in frame.details ?? []"
          :key="metric.key"
          :metric="metric"
          variant="detail"
        />
      </div>
    </section>
  </div>
</template>

<style scoped>
.as {
  display: grid;
  grid-template-columns: 240px minmax(320px, 1fr) 280px;
  gap: var(--space-4);
  align-items: stretch;
  min-height: 240px;
}

.as__col {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.as__head {
  min-height: 24px;
}

.as__head h4 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.as__metrics,
.as__details {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.as__col--center {
  justify-content: flex-start;
}

.as__col--center :deep(.rt-radar) {
  flex: 1 1 auto;
}

@media (max-width: 1100px) {
  .as {
    grid-template-columns: 220px minmax(0, 1fr);
  }

  .as__col--right {
    grid-column: 1 / -1;
  }
}
</style>