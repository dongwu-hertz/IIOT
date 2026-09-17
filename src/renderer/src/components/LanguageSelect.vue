<script setup lang="ts">
/**
 * Language picker.
 *
 * WHY A NATIVE `<select>` RATHER THAN A CUSTOM DROPDOWN
 * A native select is keyboard-accessible, screen-reader-announced and rendered
 * by the OS (so it looks right on Windows without extra styling work). A custom
 * listbox would have to reimplement all of that, and this control exists on
 * every screen — a regression here is both likely and highly visible.
 *
 * Each option shows the language's ENDONYM ("Español", "Türkçe"). Showing
 * language names in the currently active language is a known usability failure:
 * the person who needs to switch is by definition reading an interface they may
 * not understand, so "Spanish" would be as unhelpful to them as "Español" is to
 * everyone else.
 */
import { useLocale } from '@renderer/composables/useLocale'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const { locale, locales, setLocale } = useLocale()

function onChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  setLocale(value as (typeof locales)[number]['code'])
}
</script>

<template>
  <label class="lang">
    <span class="lang__label">{{ t('language.label') }}</span>
    <select
      class="lang__select"
      :value="locale"
      :aria-label="t('language.label')"
      :title="t('language.description')"
      @change="onChange"
    >
      <option v-for="item in locales" :key="item.code" :value="item.code">
        {{ item.endonym }}
      </option>
    </select>
  </label>
</template>

<style scoped>
/*
 * Sized to match the sidebar's existing footer typography. `color-scheme` is
 * declared so the OS renders the native control in the light theme the product
 * uses (spec 8.2 rejects a dark theme), instead of inheriting the system dark
 * mode and producing a black dropdown on a white sidebar.
 */
.lang {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  color: var(--color-text-secondary);
  font-size: 12px;
  color-scheme: light;
}

.lang__label {
  white-space: nowrap;
}

.lang__select {
  flex: 1 1 auto;
  min-width: 0;
  max-width: 120px;
  padding: 2px 4px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg);
  color: var(--color-text);
  font-family: inherit;
  font-size: 12px;
}

.lang__select:hover {
  border-color: var(--color-border-strong);
}

.lang__select:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}
</style>
