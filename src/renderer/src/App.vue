<script setup lang="ts">
/**
 * Application root: the session gate.
 *
 * Nothing but the gate lives here now — the shell itself moved to
 * `components/AppShell.vue`, which is what makes the gate real. See that file's
 * comment: the shell's `onMounted` loads the device list and subscribes to the
 * device-status push, and both must wait for a session.
 *
 * THREE STATES, IN ORDER
 *   1. `!ready`   — the main process has not answered "is anybody signed in?"
 *                   yet. A blank surface, deliberately: rendering the login form
 *                   here would make every start flash a form at a user who is
 *                   already signed in.
 *   2. unauthenticated, or still on a factory/reset password — the login screen,
 *                   which is also where the forced password change happens.
 *   3. the shell.
 */
import { onMounted, onUnmounted } from 'vue'
import AppShell from '@renderer/components/AppShell.vue'
import LoginView from '@renderer/views/LoginView.vue'
import { useSessionStore } from '@renderer/stores/session'

const session = useSessionStore()

/**
 * Unsubscribe handle for the session push.
 *
 * The session lives in the MAIN process (docs/ACCOUNTS.md §5); this window holds a
 * copy for rendering. A copy that is only ever written by this page's own login
 * call would be wrong whenever the session changes elsewhere — including when a
 * headless verification script signs in over the IPC bridge, which is exactly how
 * every harness in `scripts/` authenticates.
 *
 * The first cut of this file polled `auth.session()` every two seconds instead.
 * That worked, but it made the renderer ask a question the main process already
 * knows the answer changed to, and it existed purely to accommodate the harness.
 * The main process now pushes on every change, the same way it already pushed
 * device status.
 */
let unsubscribeSession: (() => void) | undefined

onMounted(() => {
  // Asks the main process who is signed in (it owns the session) and flips
  // `ready` whatever the answer is.
  void session.restore()
  unsubscribeSession = session.subscribe()
})

onUnmounted(() => {
  unsubscribeSession?.()
  unsubscribeSession = undefined
})
</script>

<template>
  <!-- `v-if`/`v-else-if`/`v-else`, never `v-show`: an unmounted shell cannot run
       its onMounted lifecycles, which is the whole point of the gate. -->
  <div v-if="!session.ready" class="app-boot" aria-busy="true"></div>
  <LoginView v-else-if="!session.isAuthenticated || session.mustChangePassword" />
  <AppShell v-else />
</template>

<style scoped>
/* A minimal blank surface: the window background, no text and no spinner that
   could be mistaken for a hung page. */
.app-boot {
  height: 100%;
  background: var(--color-bg-subtle);
}
</style>
