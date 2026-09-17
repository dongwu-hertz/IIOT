<script setup lang="ts">
/**
 * Neutral placeholder for "no devices yet", "no alarms matched the filter", etc.
 * The default slot is where a view puts its call-to-action button.
 */
withDefaults(
  defineProps<{
    title: string
    description?: string
  }>(),
  { description: '' }
)
</script>

<template>
  <div class="empty">
    <div class="empty__mark" aria-hidden="true">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
        <rect
          x="3.75"
          y="4.75"
          width="16.5"
          height="14.5"
          rx="2.5"
          stroke="currentColor"
          stroke-width="1.3"
        />
        <path d="M3.9 9.6h16.2" stroke="currentColor" stroke-width="1.3" />
        <path d="M7.2 13.4h5.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
      </svg>
    </div>
    <p class="empty__title">{{ title }}</p>
    <p v-if="description" class="empty__description">{{ description }}</p>
    <div v-if="$slots.default" class="empty__action">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 32px 16px;
  text-align: center;
  color: var(--color-text-secondary);
}

.empty__mark {
  color: var(--color-border-strong);
  margin-bottom: 2px;
}

.empty__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
}

.empty__description {
  font-size: 12px;
  max-width: 420px;
}

.empty__action {
  margin-top: 6px;
}
</style>
