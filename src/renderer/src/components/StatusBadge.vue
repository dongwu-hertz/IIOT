<script setup lang="ts">
/**
 * Device status / connection-type indicator.
 *
 * Purely presentational, so it can be reused in tables, cards and headers. All
 * text comes from the catalogue, keyed by the stable status/connection enums.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ConnectionType, DeviceStatus } from '@shared/domain/models'

const props = withDefaults(
  defineProps<{
    status: DeviceStatus
    /** Rendered as a secondary chip when supplied (LAN / REMOTE). */
    connectionType?: ConnectionType
    /** Hide the text and render only the coloured dot. */
    dotOnly?: boolean
  }>(),
  { dotOnly: false }
)

const { t } = useI18n()

/**
 * Translation keys per device status.
 *
 * Keys, not labels: this map is built once at module scope, so a rendered string
 * would freeze at the startup language. The names come from the `devices.status`
 * block, which the device list already uses, so one status has one name.
 */
const STATUS_LABEL_KEYS: Record<DeviceStatus, string> = {
  ONLINE: 'devices.status.online',
  OFFLINE: 'devices.status.offline',
  UNKNOWN: 'devices.status.unknown'
}

const CONNECTION_LABEL_KEYS: Record<ConnectionType, string> = {
  LAN: 'domainExtra.connectionType.LAN',
  REMOTE: 'domainExtra.connectionType.REMOTE'
}

const label = computed(() => {
  const key = STATUS_LABEL_KEYS[props.status]
  return key ? t(key) : t('devices.status.unknown')
})
const dotClass = computed(() => {
  if (props.status === 'ONLINE') return 'dot dot--online'
  if (props.status === 'OFFLINE') return 'dot dot--offline'
  return 'dot dot--unknown'
})
const connectionLabel = computed(() => {
  const key = props.connectionType ? CONNECTION_LABEL_KEYS[props.connectionType] : undefined
  return key ? t(key) : ''
})
</script>

<template>
  <span class="status">
    <span :class="dotClass" :title="label" aria-hidden="true"></span>
    <span v-if="!dotOnly" class="status__label" :class="`status__label--${status.toLowerCase()}`">
      {{ label }}
    </span>
    <span v-if="connectionLabel" class="badge">{{ connectionLabel }}</span>
  </span>
</template>

<style scoped>
.status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.status__label {
  font-size: 12px;
}

.status__label--online {
  color: var(--color-success);
}

.status__label--offline {
  color: var(--color-text-secondary);
}

.status__label--unknown {
  color: var(--color-warning);
}
</style>
