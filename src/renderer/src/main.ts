/**
 * Renderer entry point.
 *
 * Deliberately thin: Vue, Pinia, the router and i18n are the only global
 * concerns. Anything that needs device data goes through a store, which goes
 * through `window.api.*`.
 */

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { i18n } from './i18n'
import { useLocale } from './composables/useLocale'
import './assets/main.css'

const app = createApp(App)

/**
 * Last-resort handler. A render error must never surface as a Chrome error
 * overlay or an unhandled rejection in front of the user; it is logged for
 * support and the affected component simply does not render.
 *
 * Logged in English and not translated: this goes to the developer console and
 * the app log, which support reads, not the end user. Translating it would make
 * a bug report harder to search for.
 */
app.config.errorHandler = (error, _instance, info) => {
  // The stack is logged, not just the message: a minified build reduces most
  // messages to a bare position, and without the stack the report is not
  // actionable. `info` names the lifecycle hook or handler that threw.
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  console.error('[renderer] uncaught component error:', info, '\n', detail)
}

app.use(createPinia())
app.use(router)
app.use(i18n)

/**
 * Resolve the startup language BEFORE mounting.
 *
 * The stored/system choice is applied synchronously for the common case, so the
 * first paint is already in the right language. When detection has to consult
 * the main process the app still mounts immediately in the default language and
 * re-renders when the answer arrives — waiting on IPC here would delay the first
 * paint for a cosmetic reason.
 */
void useLocale().initLocale()

app.mount('#app')
