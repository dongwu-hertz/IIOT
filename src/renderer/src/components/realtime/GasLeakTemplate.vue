<script setup lang="ts">
/**
 * XS-SW-15A 气井泄漏监测模板（规格 §24/§25）。
 *
 * **V1 故意保守**：现有彩页没有实时数据点表，所以左栏只显示泄漏状态 / 边缘推理 /
 * 连接三件事，中心是可插拔的 Signal Trend（当前没有数据就是空态），右栏显示通道
 * 在线状态。等拿到完整通信协议/数据点表后，只需替换本组件的中心图表与字段绑定。
 *
 * 当前软件里还没有这个设备类型，`resolveRealtimeProfile()` 因此还不会返回本模板；
 * 组件先落位，接入时不需要重写页面（规格 §43）。
 */

import { useI18n } from 'vue-i18n'
import type { RealtimeFrame } from '@shared/domain/realtime-monitor'
import RealtimeMetric from './RealtimeMetric.vue'

defineProps<{ frame: RealtimeFrame }>()

const { t } = useI18n()
</script>

<template>
  <div class="gl" data-realtime-template="gasLeakMonitor">
    <section class="gl__col gl__col--left">
      <header class="gl__head"><h4>{{ t('realtimeUi.primary') }}</h4></header>
      <div class="gl__metrics">
        <RealtimeMetric
          v-for="metric in frame.primaryMetrics"
          :key="metric.key"
          :metric="metric"
        />
      </div>
    </section>

    <section class="gl__col gl__col--center">
      <header class="gl__head"><h4>{{ t('realtimeUi.signalTrend') }}</h4></header>
      <p class="gl__placeholder">{{ t('realtimeUi.signalTrendPending') }}</p>
    </section>

    <section class="gl__col gl__col--right">
      <header class="gl__head"><h4>{{ t('realtimeUi.channelStatus') }}</h4></header>
      <div class="gl__channels">
        <div v-for="channel in [1, 2]" :key="channel" class="gl__channel">
          <span>CH{{ channel }}</span>
          <span class="gl__channel-state">{{ t('realtimeUi.quality.nodata') }}</span>
        </div>
      </div>
      <p class="gl__hint">{{ t('realtimeUi.connectionPending') }}</p>
    </section>
  </div>
</template>

<style scoped>
.gl {
  display: grid;
  grid-template-columns: 240px minmax(320px, 1fr) 260px;
  gap: var(--space-4);
  align-items: stretch;
  min-height: 220px;
}

.gl__col {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.gl__head {
  min-height: 24px;
}

.gl__head h4 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.gl__metrics {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.gl__placeholder {
  margin: 0;
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 160px;
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  color: var(--color-text-tertiary);
  text-align: center;
  padding: var(--space-3);
}

.gl__channels {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.gl__channel {
  display: flex;
  justify-content: space-between;
  padding: 5px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: 12.5px;
}

.gl__channel-state {
  color: var(--color-text-tertiary);
}

.gl__hint {
  margin: 0;
  font-size: 11.5px;
  color: var(--color-text-tertiary);
}

@media (max-width: 1100px) {
  .gl {
    grid-template-columns: 220px minmax(0, 1fr);
  }

  .gl__col--right {
    grid-column: 1 / -1;
  }
}
</style>