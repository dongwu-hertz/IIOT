<script setup lang="ts">
/**
 * Application login screen — the software's own account, not a device's.
 *
 * WHY THIS IS A FULL-WINDOW VIEW AND NOT A ROUTE
 * A route would still mount the shell around it, and the shell's `onMounted`
 * loads the device list and subscribes to the device-status push. Both are
 * session-scoped work that must not happen before somebody is signed in, so the
 * login screen replaces the shell entirely (App.vue) and no route is involved.
 *
 * THREE FORMS, ONE SCREEN
 * `login`, the forced password change that a factory or administrator-reset
 * password triggers, and `recover` (manufacturer-issued recovery code). They
 * share this screen because all three are "before the app" states and the user
 * moves between them; routing them separately would let the app be reached by
 * navigating back.
 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSessionStore } from '@renderer/stores/session'
import { PASSWORD_MIN_LENGTH } from '@shared/domain/auth'
import { REMEMBERED_PASSWORD_MAX_AGE_MS } from '@shared/domain/remembered-login'
import { passwordProblemKey } from '@renderer/lib/password'
import LanguageSelect from '@renderer/components/LanguageSelect.vue'

/**
 * Logo resolved by the bundler: a hand-written path would work in dev and 404
 * inside the packaged asar, which is why every other screen imports it too.
 */
import logoUrl from '@renderer/assets/branding/hertzinno-logo.png'

const { t } = useI18n()
const session = useSessionStore()

type Step = 'login' | 'change' | 'recover'
/** The form the user asked for; a forced change overrides it (see `step`). */
const mode = ref<Step>('login')

/**
 * The form actually on screen.
 *
 * `mustChangePassword` outranks `mode`: an account still on a factory or
 * administrator-set password cannot reach the app, so no local form state may be
 * allowed to fall back to the login form for it.
 */
const step = computed<Step>(() => (session.mustChangePassword ? 'change' : mode.value))

const formError = ref('')
const notice = ref('')

const loginForm = reactive({ username: '', password: '' })
const changeForm = reactive({ currentPassword: '', newPassword: '', confirmPassword: '' })
const recoverForm = reactive({ username: '', superPassword: '', newPassword: '', confirmPassword: '' })

/**
 * 「记住密码」勾选框。默认不勾：记住密码是一个**用户主动选择**的事，默认勾上等于替用户
 * 决定在这台机器上留一份可解密的凭据。
 */
const rememberPassword = ref(false)

/**
 * 这一次的密码是不是用户**亲手输入**的（而不是我们从记住的凭据里预填的）。
 *
 * 它决定「三个月」那个窗口要不要重新计时：自动填充的登录**不续期**，否则用户点一下登录
 * 就把窗口往后推，`每三个月重新输入一次密码` 永远不会发生（详见
 * `@shared/domain/remembered-login.ts` 的长注释）。只由密码框的 `input` 事件置真 ——
 * 用户敲一个字符或粘贴一次都算亲手输入。
 */
const passwordTyped = ref(false)

/** 曾经记住过、但已过 90 天：要提示重新输入，而不是默默不填。 */
const rememberedExpired = ref(false)
/** 这台机器上系统加密不可用 ⇒ 密码记不住，勾选框要禁用并说明原因。 */
const canRememberPassword = ref(true)

/** 预填过一次就够：否则用户清空用户名之后会被 watch 再填回来。 */
let prefillApplied = false

/**
 * 提示语里的天数**由策略常量算出来**，不写死 90。
 *
 * 两处写同一个数字，改了一处就会出现"界面上说 90 天、实际 30 天就把人挡在外面"这种
 * 最难查的不一致。
 */
const REMEMBERED_PASSWORD_DAYS = Math.round(
  REMEMBERED_PASSWORD_MAX_AGE_MS / (24 * 60 * 60 * 1000)
)

/** The forced change succeeded and is being reported before the app opens. */
const changeDone = ref(false)
const copied = ref(false)

/** Loading state of the installation id, so the field never lies about why it is empty. */
const installIdState = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle')

/**
 * How long the forced-change confirmation stays on screen before the shell takes
 * over. Long enough to read one short sentence, short enough not to feel stuck.
 */
const CHANGE_HOLD_MS = 1200
let proceedTimer = 0

onMounted(() => {
  // 用户名/密码预填是**本地**读取（主进程两格 `app_meta`），所以它不阻塞首屏渲染之外
  // 的任何东西：登录页先画出来，预填到位后再出现。
  void loadRemembered()
})

onUnmounted(() => {
  // The timer flips a store flag that unmounts this view. Releasing it here means
  // a logout or a hot update during the pause cannot fire it afterwards.
  if (proceedTimer) window.clearTimeout(proceedTimer)
  proceedTimer = 0
})

const installIdText = computed(() => {
  if (installIdState.value === 'ready') return session.installId
  // `none` and `loading` are catalogue keys: an empty field with no explanation
  // reads as a broken screen rather than as a failed call.
  return installIdState.value === 'failed' ? t('common.none') : t('common.loading')
})

/** Clear stale messages so a failure from the previous form cannot be read as this one's. */
function resetMessages(): void {
  formError.value = ''
  notice.value = ''
  session.clearError()
}

async function loadInstallId(): Promise<void> {
  installIdState.value = 'loading'
  const value = await session.loadInstallId()
  installIdState.value = value ? 'ready' : 'failed'
}

/**
 * 预填上次的用户名与（勾选过的）密码。只在挂载时跑一次。
 *
 * 用户名**总是**填（产品要求「记录上次的用户名」）；密码只在主进程说它还能用时才填 ——
 * 「还能用」的判据是「勾选过 + 没超过 90 天 + 系统加密可用」，三条都在主进程里判
 * （`isRememberedPasswordUsable()`），渲染层不重复实现一遍规则。
 *
 * `passwordTyped` 保持为假：预填进来的密码不是用户亲手输入的，所以登录成功时**不该**给
 * 90 天窗口续期。这一条正是「每三个月重新输入一次」能真正发生的原因。
 */
async function loadRemembered(): Promise<void> {
  const remembered = await session.loadRememberedLogin()
  if (prefillApplied) return
  prefillApplied = true

  canRememberPassword.value = remembered.persistent
  rememberedExpired.value = remembered.expired

  if (remembered.username) loginForm.username = remembered.username
  if (remembered.password) {
    loginForm.password = remembered.password
    // 密码是被预填的（用户没敲），所以勾选框要跟着勾上，否则登录一次就把记忆清掉了。
    rememberPassword.value = true
  }
}

function startRecover(): void {
  resetMessages()
  mode.value = 'recover'
  if (installIdState.value === 'idle') void loadInstallId()
}

function backToLogin(): void {
  resetMessages()
  mode.value = 'login'
}

async function submitLogin(): Promise<void> {
  resetMessages()
  const username = loginForm.username.trim()
  if (!username) {
    formError.value = t('authUi.errUsername')
    return
  }
  if (!loginForm.password) {
    formError.value = t('authUi.errPassword')
    return
  }

  const typedPassword = loginForm.password
  const ok = await session.login({ username, password: typedPassword })
  // The password leaves reactive state the moment it has been used.
  loginForm.password = ''
  if (!ok) {
    formError.value = session.error || t('errors.fallback')
    return
  }

  /*
   * 登录成功之后才处理"记住" —— 失败的登录绝不能把密码存下来（那会把一个错密码记成
   * 下次的预填值）。用户名**总是**记住（产品要求的第 1 条），密码只在勾选时记。
   */
  await session.rememberLogin({
    username,
    ...(rememberPassword.value ? { password: typedPassword } : {}),
    rememberPassword: rememberPassword.value,
    userTypedPassword: passwordTyped.value
  })
  passwordTyped.value = false
  rememberedExpired.value = false

  if (session.mustChangePassword) {
    // The account is still on its factory/administrator-set password. Carrying
    // the password just proven into the change form saves retyping it; it lives
    // in this component only and is wiped as soon as the change succeeds.
    changeForm.currentPassword = typedPassword
    changeDone.value = false
    mode.value = 'change'
  }
}

async function submitForcedChange(): Promise<void> {
  resetMessages()
  if (!changeForm.currentPassword) {
    formError.value = t('authUi.errCurrentPassword')
    return
  }
  const problem = passwordProblemKey(changeForm.newPassword)
  if (problem) {
    formError.value = t(problem, { min: PASSWORD_MIN_LENGTH })
    return
  }
  if (changeForm.newPassword !== changeForm.confirmPassword) {
    formError.value = t('authUi.errPasswordMismatch')
    return
  }

  const ok = await session.changePassword({
    currentPassword: changeForm.currentPassword,
    newPassword: changeForm.newPassword
  })
  if (!ok) {
    formError.value = session.error || t('errors.fallback')
    return
  }

  changeForm.currentPassword = ''
  changeForm.newPassword = ''
  changeForm.confirmPassword = ''
  changeDone.value = true
  // Report the change FIRST, then release the gate. The store deliberately
  // leaves the flag set (see `changePassword`), because clearing it here would
  // replace this screen in the same tick and the confirmation would never be
  // readable.
  proceedTimer = window.setTimeout(() => {
    proceedTimer = 0
    session.completeForcedChange()
  }, CHANGE_HOLD_MS)
}

async function submitRecover(): Promise<void> {
  resetMessages()
  const username = recoverForm.username.trim()
  if (!username) {
    formError.value = t('authUi.errUsername')
    return
  }
  if (!recoverForm.superPassword.trim()) {
    formError.value = t('authUi.errSuperPassword')
    return
  }
  const problem = passwordProblemKey(recoverForm.newPassword)
  if (problem) {
    formError.value = t(problem, { min: PASSWORD_MIN_LENGTH })
    return
  }
  if (recoverForm.newPassword !== recoverForm.confirmPassword) {
    formError.value = t('authUi.errPasswordMismatch')
    return
  }

  const ok = await session.recover({
    username,
    // Trimmed: a code arrives by mail or chat and a trailing space is invisible.
    superPassword: recoverForm.superPassword.trim(),
    newPassword: recoverForm.newPassword
  })
  recoverForm.superPassword = ''
  recoverForm.newPassword = ''
  recoverForm.confirmPassword = ''
  if (!ok) {
    formError.value = session.error || t('errors.fallback')
    return
  }

  // Recovery creates no session — the point of it is to get back IN, and the
  // form is already the sign-in screen, so the username is carried over.
  loginForm.username = username
  mode.value = 'login'
  notice.value = t('authUi.recoverSuccess')
}

async function copyInstallId(): Promise<void> {
  const value = session.installId
  if (!value) return
  try {
    await navigator.clipboard.writeText(value)
    copied.value = true
    window.setTimeout(() => {
      copied.value = false
    }, 1600)
  } catch {
    // The clipboard can be refused (window not focused, no permission). The id
    // stays on screen and selectable, which is the useful fallback; there is no
    // catalogue key for a failure here and inventing one is not allowed, so the
    // button simply does not claim success.
    copied.value = false
  }
}
</script>

<template>
  <div class="login">
    <section class="login__card">
      <header class="login__brand">
        <img class="login__logo" :src="logoUrl" alt="HAIS" width="110" height="59" />
        <span class="login__brand-text">
          <span class="login__brand-name">{{ t('app.title') }}</span>
          <span class="login__brand-sub">{{ t('app.tagline') }}</span>
        </span>
      </header>

      <!-- Sign in -->
      <template v-if="step === 'login'">
        <!--
          No heading and no factory-credentials hint, deliberately.
          The product owner asked for both to come off this screen: printing the
          factory password in the UI tells anybody standing at the machine how to
          get in, which is the opposite of what an account gate is for. The
          credentials live in the documentation (README §3 / docs/ACCOUNTS.md §1)
          where whoever installs the software will read them once.
        -->

        <form class="login__form" @submit.prevent="submitLogin">
          <label class="field">
            <span class="field-label">{{ t('authUi.username') }}</span>
            <input
              v-model="loginForm.username"
              data-autofocus
              class="input"
              type="text"
              autocomplete="username"
              spellcheck="false"
            />
          </label>

          <label class="field">
            <span class="field-label">{{ t('authUi.password') }}</span>
            <input
              v-model="loginForm.password"
              class="input"
              type="password"
              autocomplete="current-password"
              @input="passwordTyped = true"
            />
          </label>

          <!--
            「记住密码」（产品要求：勾选了才记住）。
            预填的密码也算勾上（见 loadRemembered）：否则用户登录一次就把记忆清掉了。
            系统加密不可用时禁用它并说明原因 —— 一个能勾但不起作用的框比没有这个框更糟。
          -->
          <label class="login__remember">
            <input
              v-model="rememberPassword"
              type="checkbox"
              :disabled="!canRememberPassword"
            />
            <span>{{ t('authUi.rememberPassword') }}</span>
          </label>
          <p v-if="!canRememberPassword" class="login__hint">
            {{ t('authUi.rememberUnavailable') }}
          </p>
          <!-- 过期与"从没记住过"要分开说：前者是"该重新输入了"，后者什么都不用说。 -->
          <p v-else-if="rememberedExpired" class="login__hint">
            {{ t('authUi.rememberExpired', { days: REMEMBERED_PASSWORD_DAYS }) }}
          </p>

          <p v-if="formError" class="alert alert--danger" role="alert">{{ formError }}</p>
          <p v-if="notice" class="alert alert--success" role="status">{{ notice }}</p>

          <button type="submit" class="btn btn--primary login__submit" :disabled="session.busy">
            {{ session.busy ? t('authUi.signingIn') : t('authUi.signIn') }}
          </button>
        </form>

        <button type="button" class="login__link" @click="startRecover">
          {{ t('authUi.recoverLink') }}
        </button>
      </template>

      <!-- Forced password change: the account cannot be used until this is done. -->
      <template v-else-if="step === 'change'">
        <h1 class="login__title">{{ t('authUi.mustChangeTitle') }}</h1>
        <p v-if="changeDone" class="alert alert--success" role="status">
          {{ t('authUi.changeSuccess') }}
        </p>

        <form v-else class="login__form" @submit.prevent="submitForcedChange">
          <label class="field">
            <span class="field-label">{{ t('authUi.currentPassword') }}</span>
            <input
              v-model="changeForm.currentPassword"
              data-autofocus
              class="input"
              type="password"
              autocomplete="current-password"
            />
          </label>

          <label class="field">
            <span class="field-label">{{ t('authUi.newPassword') }}</span>
            <input
              v-model="changeForm.newPassword"
              class="input"
              type="password"
              autocomplete="new-password"
            />
          </label>

          <label class="field">
            <span class="field-label">{{ t('authUi.confirmPassword') }}</span>
            <input
              v-model="changeForm.confirmPassword"
              class="input"
              type="password"
              autocomplete="new-password"
            />
          </label>

          <p v-if="formError" class="alert alert--danger" role="alert">{{ formError }}</p>

          <button type="submit" class="btn btn--primary login__submit" :disabled="session.busy">
            {{ session.busy ? t('authUi.changing') : t('authUi.changeSubmit') }}
          </button>
        </form>
      </template>

      <!-- Recovery with the manufacturer-issued super password. -->
      <template v-else>
        <h1 class="login__title">{{ t('authUi.recoverTitle') }}</h1>

        <div class="login__install">
          <span class="field-label">{{ t('authUi.installId') }}</span>
          <div class="login__install-row">
            <code class="login__install-id mono">{{ installIdText }}</code>
            <button
              type="button"
              class="btn btn--sm"
              :disabled="installIdState !== 'ready'"
              @click="copyInstallId"
            >
              {{ copied ? t('authUi.copied') : t('authUi.copy') }}
            </button>
          </div>
        </div>

        <form class="login__form" @submit.prevent="submitRecover">
          <label class="field">
            <span class="field-label">{{ t('authUi.username') }}</span>
            <input
              v-model="recoverForm.username"
              data-autofocus
              class="input"
              type="text"
              autocomplete="username"
              spellcheck="false"
            />
          </label>

          <label class="field">
            <span class="field-label">{{ t('authUi.superPassword') }}</span>
            <input
              v-model="recoverForm.superPassword"
              class="input"
              type="text"
              autocomplete="off"
              spellcheck="false"
            />
          </label>

          <label class="field">
            <span class="field-label">{{ t('authUi.newPassword') }}</span>
            <input
              v-model="recoverForm.newPassword"
              class="input"
              type="password"
              autocomplete="new-password"
            />
          </label>

          <label class="field">
            <span class="field-label">{{ t('authUi.confirmPassword') }}</span>
            <input
              v-model="recoverForm.confirmPassword"
              class="input"
              type="password"
              autocomplete="new-password"
            />
          </label>

          <p v-if="formError" class="alert alert--danger" role="alert">{{ formError }}</p>

          <button type="submit" class="btn btn--primary login__submit" :disabled="session.busy">
            {{ session.busy ? t('authUi.recovering') : t('authUi.recoverSubmit') }}
          </button>
        </form>

        <button type="button" class="login__link" @click="backToLogin">
          {{ t('authUi.backToLogin') }}
        </button>
      </template>

      <!--
        The language picker is repeated here on purpose: the sidebar one is
        inside the shell, which is unreachable before signing in — so a user who
        cannot read the interface would otherwise have no way to change it.
      -->
      <footer class="login__footer">
        <LanguageSelect />
      </footer>
    </section>
  </div>
</template>

<style scoped>
.login {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-6);
  background: var(--color-bg-subtle);
  overflow-y: auto;
}

.login__card {
  width: 100%;
  max-width: 420px;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: 28px 26px 22px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
}

.login__brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--color-border);
}

/* The asset is 224x120 with transparent padding, so it is contained by height
   while the brand column sets the width. */
.login__logo {
  height: 34px;
  width: auto;
  max-width: 84px;
  object-fit: contain;
  flex: none;
}

.login__brand-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.login__brand-name {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.login__brand-sub {
  font-size: 11px;
  color: var(--color-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.login__title {
  font-size: 16px;
  font-weight: 600;
}

.login__lead {
  font-size: 12px;
  line-height: 1.7;
  color: var(--color-text-secondary);
}

.login__form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-2);
}

.login__submit {
  justify-content: center;
  width: 100%;
}

/*
 * 「记住密码」勾选框：与上面的输入框左对齐，行高做得够大（点得到），
 * 文字用次级色 —— 它是一句次要说明，不是表单标签。
 */
.login__remember {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--color-text-secondary);
  cursor: pointer;
  user-select: none;
  align-self: flex-start;
}

.login__remember input {
  margin: 0;
  cursor: pointer;
}

.login__remember input:disabled {
  cursor: not-allowed;
}

/* 「记不住」与「已过期」两种说明共用：都只在有事要说的时候出现。 */
.login__hint {
  margin: 0;
  align-self: flex-start;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--color-warning);
}

.login__link {
  all: unset;
  cursor: pointer;
  align-self: flex-start;
  font-size: 12px;
  color: var(--color-accent);
  border-radius: 3px;
}

.login__link:hover,
.login__link:focus-visible {
  color: var(--color-accent-hover);
  text-decoration: underline;
}

.login__install {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.login__install-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.login__install-id {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-subtle);
  font-size: 12.5px;
  letter-spacing: 0.06em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.login__footer {
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-border);
}
</style>
