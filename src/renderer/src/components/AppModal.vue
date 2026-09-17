<script setup lang="ts">
/**
 * Accessible modal shell used by every dialog in the app.
 *
 * Why a component instead of `<dialog>`: Electron's Chromium supports `<dialog>`,
 * but its focus trap and Escape handling differ subtly between versions; a small
 * explicit implementation keeps behaviour identical on the Windows target and
 * makes the "focus the first field" requirement of the Add Device flow obvious.
 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    title: string
    /** CSS width of the panel. */
    width?: string
    /** Set false for flows that must be dismissed explicitly (e.g. a warning). */
    closeOnOverlay?: boolean
  }>(),
  { width: '520px', closeOnOverlay: true }
)

const { t } = useI18n()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  (event: 'close'): void
}>()

const panel = ref<HTMLElement | null>(null)
/** Element that had focus before opening, restored on close. */
let restoreFocusTo: HTMLElement | null = null

function focusable(): HTMLElement[] {
  if (!panel.value) return []
  const selector =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  return Array.from(panel.value.querySelectorAll<HTMLElement>(selector)).filter(
    (element) => element.offsetWidth > 0 || element.offsetHeight > 0 || element === document.activeElement
  )
}

async function activate(): Promise<void> {
  restoreFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
  document.body.style.overflow = 'hidden'
  await nextTick()
  const preferred = panel.value?.querySelector<HTMLElement>('[data-autofocus]')
  const first = focusable()[0]
  ;(preferred ?? first ?? panel.value)?.focus()
}

function deactivate(): void {
  document.body.style.overflow = ''
  restoreFocusTo?.focus()
  restoreFocusTo = null
}

function close(): void {
  emit('update:modelValue', false)
  emit('close')
}

function onOverlayPointerDown(): void {
  if (props.closeOnOverlay) close()
}

/** Escape closes; Tab is trapped inside the panel so focus cannot escape. */
function onKeydown(event: KeyboardEvent): void {
  if (!props.modelValue) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close()
    return
  }
  if (event.key !== 'Tab') return
  const elements = focusable()
  const first = elements[0]
  const last = elements[elements.length - 1]
  if (!first || !last) {
    event.preventDefault()
    panel.value?.focus()
    return
  }
  const active = document.activeElement
  const inside = panel.value?.contains(active) ?? false
  if (event.shiftKey && (active === first || !inside)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) void activate()
    else deactivate()
  }
)

document.addEventListener('keydown', onKeydown, true)
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true)
  document.body.style.overflow = ''
})
</script>

<template>
  <Teleport to="body">
    <div v-if="modelValue" class="overlay" @mousedown.self="onOverlayPointerDown">
      <section
        ref="panel"
        class="panel"
        :style="{ width }"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        tabindex="-1"
      >
        <header class="panel__header">
          <h2 class="panel__title">{{ title }}</h2>
          <button type="button" class="btn btn--ghost btn--icon" :aria-label="t('widgetsUi.modalClose')" @click="close">
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M3 3l10 10M13 3L3 13"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </header>

        <div class="panel__body">
          <slot />
        </div>

        <footer v-if="$slots.footer" class="panel__footer">
          <slot name="footer" />
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 8vh 16px 24px;
  background: rgba(23, 23, 23, 0.32);
  overflow-y: auto;
}

.panel {
  max-width: 100%;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  outline: none;
}

.panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 12px 14px;
  border-bottom: 1px solid var(--color-border);
}

.panel__title {
  font-size: 14px;
  font-weight: 600;
}

.panel__body {
  padding: 16px 14px;
}

.panel__footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: 12px 14px;
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-subtle);
  border-radius: 0 0 var(--radius-lg) var(--radius-lg);
}
</style>
