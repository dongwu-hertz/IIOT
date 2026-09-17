<script setup lang="ts">
/**
 * Signed-in account control for the sidebar footer.
 *
 * Shows WHO the console is currently acting as — a fact every destructive action
 * is authorised against — and gives access to the three account actions: change
 * password, account management (administrators only) and sign out.
 *
 * Account management is hidden, not merely disabled, for an operator: offering
 * a control that the main process will always refuse is worse than not offering
 * it, because it invites the reading "I should be allowed to do this".
 *
 * 「修改密码」的对话框是**共享组件**（`ChangePasswordDialog.vue`）：设置页的「账号」页签
 * 用的是同一个（业主 2026-09-17 的 ③）。密码校验只允许有一处实现。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSessionStore } from '@renderer/stores/session'
import ChangePasswordDialog from '@renderer/components/ChangePasswordDialog.vue'
import UsersDialog from '@renderer/components/UsersDialog.vue'

const { t } = useI18n()
const session = useSessionStore()

const menuOpen = ref(false)
const changeOpen = ref(false)
const usersOpen = ref(false)

const roleLabel = computed(() => t(`domain.userRole.${session.session?.user.role ?? 'operator'}`))

function closeMenu(): void {
  menuOpen.value = false
}

function onDocumentClick(): void {
  closeMenu()
}

/** Escape closes the menu, matching the modal's own behaviour. */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && menuOpen.value) closeMenu()
}

onMounted(() => {
  // The menu is a popover, so a click anywhere else — including on a nav entry —
  // must dismiss it. Registered on the document because the menu is not a focus
  // trap: the user is expected to click away from it.
  document.addEventListener('click', onDocumentClick)
  document.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick)
  document.removeEventListener('keydown', onKeydown)
})

function openChange(): void {
  closeMenu()
  changeOpen.value = true
}

function openUsers(): void {
  closeMenu()
  usersOpen.value = true
}

function signOut(): void {
  closeMenu()
  void session.logout()
}
</script>

<template>
  <div class="user">
    <button
      type="button"
      class="user__trigger"
      :aria-expanded="menuOpen"
      aria-haspopup="menu"
      @click.stop="menuOpen = !menuOpen"
    >
      <span class="user__text">
        <span class="user__caption">{{ t('authUi.signedInAs') }}</span>
        <span class="user__name" :title="session.displayName">{{ session.displayName }}</span>
      </span>
      <span class="badge user__role">{{ roleLabel }}</span>
    </button>

    <div v-if="menuOpen" class="user__menu" role="menu" @click.stop>
      <button type="button" class="user__item" role="menuitem" @click="openChange">
        {{ t('authUi.changeTitle') }}
      </button>
      <button
        v-if="session.isAdmin"
        type="button"
        class="user__item"
        role="menuitem"
        @click="openUsers"
      >
        {{ t('usersUi.title') }}
      </button>
      <button
        type="button"
        class="user__item user__item--danger"
        role="menuitem"
        @click="signOut"
      >
        {{ t('authUi.signOut') }}
      </button>
    </div>

    <ChangePasswordDialog v-model="changeOpen" />

    <!-- Reachable only for an administrator; the main process re-checks anyway. -->
    <UsersDialog v-if="session.isAdmin" v-model="usersOpen" />
  </div>
</template>

<style scoped>
.user {
  position: relative;
}

.user__trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  width: 100%;
  padding: 5px 6px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.user__trigger:hover {
  background: var(--color-bg-muted);
}

.user__trigger:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

.user__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.user__caption {
  font-size: 10.5px;
  color: var(--color-text-secondary);
}

.user__name {
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.user__role {
  flex: none;
  font-size: 10.5px;
  padding: 0 6px;
  line-height: 16px;
}

/* Opens upwards: the trigger sits in the footer, so a downward menu would fall
   off the bottom of the window. */
.user__menu {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 60;
  padding: 4px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-md);
  display: flex;
  flex-direction: column;
}

.user__item {
  text-align: left;
  padding: 6px 8px;
  border: none;
  background: transparent;
  border-radius: 6px;
  font-size: 12.5px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.user__item:hover {
  background: var(--color-bg-muted);
}

.user__item--danger {
  color: var(--color-danger);
}
</style>
