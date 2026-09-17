<script setup lang="ts">
/**
 * Push 上报（数据外发）— 只读（Phase 9）。
 *
 * WHY THIS IS READ-ONLY AND WHY IT IS NOT A NEUTRAL FORM
 * The tested device had all four egress channels ENABLED and pointing at a public
 * internet address (`targetsPublicAddress`), i.e. a unit in a customer's
 * substation continuously uploading feature/graph/heat data off-site. That is a
 * fact a customer needs to see, not a setting buried in a table, so the warning
 * is rendered prominently whenever any target leaves the local network.
 *
 * The write endpoint is intentionally not exposed by the IPC contract; changing
 * an egress target is done on the device's own web interface.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDeviceConfigStore } from '@renderer/stores/deviceConfig'
import { EMPTY_VALUE } from '@renderer/lib/format'
import EmptyState from '@renderer/components/EmptyState.vue'

const props = defineProps<{ deviceId: string }>()

const { t } = useI18n()
const config = useDeviceConfigStore()

/**
 * A reporting channel.
 *
 * The label is a translation KEY, not text: this array is rebuilt inside a
 * computed, but storing a rendered string would still tie it to whatever
 * language was active when the row was built rather than to the current one.
 */
interface ChannelRow {
  key: string
  labelKey: string
  enabled: boolean
  url: string
}

const rows = computed<ChannelRow[]>(() => {
  const push = config.push
  if (!push) return []
  return [
    {
      key: 'feature',
      labelKey: 'configPush.kindFeatures',
      enabled: push.featureEnabled,
      url: push.featureUrl
    },
    {
      key: 'alarm',
      labelKey: 'configPush.kindAlarm',
      enabled: push.alarmEnabled,
      url: push.alarmUrl
    },
    {
      key: 'graph',
      labelKey: 'configPush.kindImage',
      enabled: push.graphEnabled,
      url: push.graphUrl
    },
    {
      key: 'heat',
      labelKey: 'configPush.kindHeat',
      enabled: push.heatEnabled,
      url: push.heatUrl
    }
  ]
})

const enabledCount = computed(() => rows.value.filter((row) => row.enabled).length)

async function reload(): Promise<void> {
  await config.loadPush(props.deviceId)
}
</script>

<template>
  <section class="card">
    <div class="section-header">
      <h3 class="section-title">{{ t('configPush.title') }}</h3>
      <div class="btn-row">
        <span v-if="config.push" class="muted hint">
          {{ t('configCommon.enabledOfTotal', { enabled: enabledCount, total: rows.length }) }}
        </span>
        <button type="button" class="btn btn--sm" :disabled="config.loading" @click="reload">
          {{ t('configCommon.reload') }}
        </button>
      </div>
    </div>

    <p v-if="config.push?.targetsPublicAddress" class="alert alert--warning" role="alert">
      <span class="alert__icon" aria-hidden="true">⚠</span>
      <span class="alert__body">
        <span class="alert__title">{{ t('configCommon.publicWarningTitle') }}</span>
        {{ t('configPush.publicWarning') }}
      </span>
    </p>

    <EmptyState
      v-if="!config.push"
      :title="t('configPush.unavailableTitle')"
    >
      <button type="button" class="btn btn--sm" :disabled="config.loading" @click="reload">
        {{ t('configCommon.reload') }}
      </button>
    </EmptyState>

    <div v-else class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('configCommon.channel') }}</th>
            <th>{{ t('configCommon.status') }}</th>
            <th>{{ t('configCommon.target') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.key">
            <td class="nowrap">{{ t(row.labelKey) }}</td>
            <td>
              <span class="badge" :class="row.enabled ? 'badge--warning' : ''">
                {{ row.enabled ? t('configCommon.enabled') : t('configCommon.disabled') }}
              </span>
            </td>
            <td class="mono">{{ row.url || EMPTY_VALUE }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <dl v-if="config.push" class="kv extra">
      <div class="kv__item">
        <dt class="kv__label">{{ t('configPush.heatInterval') }}</dt>
        <dd class="kv__value">
          {{ config.push.heatInterval }}
          <span class="muted">{{ t('configCommon.unitPerDevice') }}</span>
        </dd>
      </div>
      <div class="kv__item">
        <dt class="kv__label">{{ t('configPush.targetScope') }}</dt>
        <dd class="kv__value">
          <span :class="config.push.targetsPublicAddress ? 'text-warning' : 'text-success'">
            {{ config.push.targetsPublicAddress ? t('configPush.scopePublic') : t('configPush.scopePrivate') }}
          </span>
        </dd>
      </div>
    </dl>
  </section>
</template>

<style scoped>
.hint {
  font-size: 11.5px;
}

.block-hint {
  display: block;
  margin-bottom: var(--space-3);
}

.extra {
  margin-top: var(--space-4);
}
</style>
