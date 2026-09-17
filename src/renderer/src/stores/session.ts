/**
 * Application account session store.
 *
 * The session itself lives in the MAIN process; this store holds the renderer's
 * copy purely so the UI can render the right controls. Every privileged action
 * here re-checks the role in the main process — nothing in this file is a
 * security boundary, and treating it as one would be the mistake the service's
 * own comment warns about.
 *
 * Setup-style Pinia store, following `stores/devices.ts`: every action funnels
 * failures into a human-readable `error` string through `lib/result.ts` and
 * resolves normally, so no component needs a defensive try/catch (spec 14.2).
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  ChangePasswordInput,
  CopyUserPermissionsInput,
  CreateUserInput,
  LoginInput,
  RecoverAccountInput,
  RememberLoginInput,
  RememberedLoginSnapshot,
  ResetUserPasswordInput,
  SessionInfo,
  UpdateUserPermissionsInput,
  UpdateUserProfileInput,
  UserRole,
  UserSummary
} from '@shared/domain/auth'
import type { DeviceResult } from '@shared/errors'
import { i18n } from '@renderer/i18n'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'

export const useSessionStore = defineStore('session', () => {
  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  const session = ref<SessionInfo | null>(null)
  /**
   * True once `restore()` has answered, whatever the answer was.
   *
   * The shell gate in App.vue renders nothing until this flips, which is what
   * keeps the login form from flashing on every start while the main process is
   * still being asked "is anybody signed in?".
   */
  const ready = ref(false)
  const busy = ref(false)
  /** Human-readable failure, already translated. Empty when the last call worked. */
  const error = ref('')
  /**
   * The signed-in account is still on its factory or administrator-reset
   * password, so the app must not be reachable until it is replaced.
   */
  const mustChangePassword = ref(false)

  /** Administrator-only account list, loaded on demand by `UsersDialog`. */
  const users = ref<UserSummary[]>([])
  /** This installation's public id, shown on the recovery form. */
  const installId = ref('')

  // -------------------------------------------------------------------------
  // Getters
  // -------------------------------------------------------------------------

  const isAuthenticated = computed(() => session.value !== null)
  const isAdmin = computed(() => session.value?.user.role === 'admin')
  /** Best available human label for the signed-in account. */
  const displayName = computed(
    () => session.value?.user.displayName?.trim() || session.value?.user.username || ''
  )
  /** Id of the signed-in account, for the "cannot delete yourself" rule. */
  const currentUserId = computed(() => session.value?.user.id ?? '')
  /**
   * How many administrators exist, from the last loaded account list.
   *
   * Used to disable the controls that would remove or demote the last one. The
   * main process enforces the same rule; this exists so the UI does not offer an
   * action that is certain to be refused.
   */
  const adminCount = computed(() => users.value.filter((user) => user.role === 'admin').length)

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Failure text for a result.
   *
   * `resultMessage` returns '' for a successful envelope, so the fallback covers
   * the one state it cannot describe: success with no payload. The main process
   * never produces that, and showing nothing would be worse than a generic line.
   */
  function failureText<T>(result: DeviceResult<T>): string {
    return resultMessage(result) || i18n.global.t('errors.fallback')
  }

  /** Adopt a session, or the absence of one, as the whole authentication state. */
  function applySession(next: SessionInfo | null): void {
    session.value = next
    mustChangePassword.value = next?.user.mustChangePassword ?? false
  }

  /**
   * Merge an account the main process just returned into local state.
   *
   * Both copies are updated: the account list (so the dialog does not need a
   * second round trip after every edit) and the session (so the sidebar stops
   * showing a stale display name or role).
   */
  function applyUser(updated: UserSummary): void {
    const index = users.value.findIndex((user) => user.id === updated.id)
    if (index >= 0) users.value.splice(index, 1, updated)
    const current = session.value
    if (current && current.user.id === updated.id) {
      session.value = { ...current, user: updated }
    }
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  /**
   * Ask the main process who is signed in. Called once by App.vue on start.
   *
   * `ready` flips even when the call fails: the gate shows a blank surface until
   * it does, and a failed call that never resolved would leave the window empty
   * instead of rendering the login form.
   */
  async function restore(): Promise<void> {
    const result = await callApi(() => window.api.auth.session())
    if (!result.success) {
      applySession(null)
      error.value = failureText(result)
    } else {
      applySession(unwrap(result) ?? null)
      error.value = ''
    }
    ready.value = true
  }

  /**
   * Subscribe to the main process's session push.
   *
   * WHY A PUSH AND NOT A POLL
   * The session lives in the MAIN process (docs/ACCOUNTS.md §5) and this window
   * does not create every session: the packaged smoke probe signs in through
   * `window.api.auth.*` directly, and any future idle timeout or second window
   * would do the same. The renderer holds only a COPY, so a copy written solely by
   * this page's own login call is wrong the moment the session changes elsewhere.
   *
   * An earlier version re-read `auth.session()` on a two-second timer. It worked,
   * but it made the renderer ask a question whose answer the main process already
   * knew had changed — and it existed only to accommodate the harness. Same
   * treatment as the device-status channel.
   *
   * THE PUSH IS AUTHORITATIVE ON `mustChangePassword`, including when it clears it.
   * An earlier version refused to lower that flag here, on the theory that a stale
   * `false` could let the shell in without the password having been changed. That
   * theory does not hold and the refusal caused a real defect: the flag can only be
   * cleared by `changePassword` / `recoverAccount` / `resetUserPassword`, all of
   * which happen in the main process BEFORE the push is emitted. So a push saying
   * `false` means the change genuinely happened — including when it was performed
   * over the bridge rather than through this page, which is exactly how every
   * headless verification script authenticates. Refusing to believe it left those
   * runs staring at a change-password form that could never be satisfied.
   */
  function subscribe(): () => void {
    if (typeof window === 'undefined' || typeof window.events?.onAuthSession !== 'function') {
      // No bridge (a dev-server renderer, or a probe build): the gate still works
      // from `restore()` and this page's own actions.
      return () => {}
    }
    return window.events.onAuthSession((next) => {
      session.value = next
      mustChangePassword.value = next?.user.mustChangePassword === true
    })
  }

  /** Returns true when the credentials were accepted. */
  async function login(input: LoginInput): Promise<boolean> {
    busy.value = true
    const result = await callApi(() => window.api.auth.login(input))
    busy.value = false
    const outcome = result.data
    if (!result.success || !outcome) {
      error.value = failureText(result)
      return false
    }
    applySession(outcome.session)
    // Taken from the OUTCOME rather than the summary: the service returns it as
    // an instruction ("change this now"), and the login screen acts on it.
    mustChangePassword.value = outcome.mustChangePassword
    error.value = ''
    return true
  }

  /** Clears the local copy of the session, in the UI sense, whatever happens. */
  async function logout(): Promise<void> {
    busy.value = true
    const result = await callApi(() => window.api.auth.logout())
    busy.value = false
    // The local copy is dropped even when the call failed. Keeping it would
    // leave the whole console reachable in front of a main process that may no
    // longer hold a session; the worst case of the other choice is that the user
    // signs out twice.
    applySession(null)
    users.value = []
    error.value = result.success ? '' : failureText(result)
  }

  // -------------------------------------------------------------------------
  // Passwords
  // -------------------------------------------------------------------------

  /**
   * Replace the signed-in account's password.
   *
   * DELIBERATELY DOES NOT CLEAR `mustChangePassword`.
   * The login screen owes the user a confirmation of a FORCED change before the
   * app shell replaces it. Clearing the flag here would unmount that screen in
   * the same tick as the call resolves, so the confirmation would never be seen;
   * `completeForcedChange()` is the login screen's signal that it has finished
   * reporting. A voluntary change (from the user menu) is unaffected either way,
   * because the flag is already false there.
   */
  async function changePassword(input: ChangePasswordInput): Promise<boolean> {
    busy.value = true
    const result = await callApi(() => window.api.auth.changePassword(input))
    busy.value = false
    const updated = result.data
    if (!result.success || !updated) {
      error.value = failureText(result)
      return false
    }
    applyUser(updated)
    error.value = ''
    return true
  }

  /** Release the forced-change gate once its confirmation has been shown. */
  function completeForcedChange(): void {
    mustChangePassword.value = false
  }

  /**
   * Reset a password with the manufacturer's recovery code.
   *
   * Creates no session: the account's password changed, so the user signs in
   * with it like any other login. That is why this is reachable from the login
   * screen and why the caller shows `authUi.recoverSuccess` and returns to the
   * form.
   */
  async function recover(input: RecoverAccountInput): Promise<boolean> {
    busy.value = true
    const result = await callApi(() => window.api.auth.recover(input))
    busy.value = false
    if (!result.success || !result.data) {
      error.value = failureText(result)
      return false
    }
    applyUser(result.data)
    error.value = ''
    return true
  }

  /**
   * Load the installation id shown on the recovery form.
   *
   * Public on the main side (no session required) because it exists to be read
   * off the screen and handed to the manufacturer.
   */
  async function loadInstallId(): Promise<string> {
    const result = await callApi(() => window.api.auth.installId())
    const value = result.data
    if (!result.success || !value) {
      error.value = failureText(result)
      return ''
    }
    installId.value = value
    error.value = ''
    return value
  }

  // -------------------------------------------------------------------------
  // 记住上次的用户名 / 记住密码（业主 2026-09-16）
  // -------------------------------------------------------------------------

  /**
   * 登录页要预填的东西。
   *
   * 读失败时返回"什么都没有"而不是把错误抛到登录页：登录页上一条红色错误横幅会让人以为
   * **登录**出了问题，而这件事只是"没记住"。主进程那条通道本来也不会失败（它只读两格
   * `app_meta`），所以这里的分支是防御性的。
   */
  async function loadRememberedLogin(): Promise<RememberedLoginSnapshot> {
    const empty: RememberedLoginSnapshot = { username: '', expired: false, persistent: false }
    const result = await callApi(() => window.api.auth.rememberedLogin())
    if (!result.success || !result.data) return empty
    return result.data
  }

  /** 登录成功之后调用。是否记住密码由用户那个勾选框决定（见 `RememberLoginInput`）。 */
  async function rememberLogin(input: RememberLoginInput): Promise<void> {
    const result = await callApi(() => window.api.auth.rememberLogin(input))
    if (!result.success) {
      // 记不住不是登录失败：把话说清楚，但**不**动 `error`（那是登录自身的错误面）。
      error.value = failureText(result)
      return
    }
    error.value = ''
  }

  /** 清除记忆（用户名与密码一起）。 */
  async function forgetRememberedLogin(): Promise<void> {
    const result = await callApi(() => window.api.auth.forgetRememberedLogin())
    if (!result.success) error.value = failureText(result)
    else error.value = ''
  }

  // -------------------------------------------------------------------------
  // Account management (administrator only)
  // -------------------------------------------------------------------------

  async function loadUsers(): Promise<void> {
    if (!isAdmin.value) {
      // The main process refuses this too. Repeating the check locally means an
      // operator never sees a list they could act on, and the message is the
      // catalogue's own FORBIDDEN text rather than an empty table.
      users.value = []
      error.value = i18n.global.t('errors.FORBIDDEN')
      return
    }
    busy.value = true
    const result = await callApi(() => window.api.auth.listUsers())
    busy.value = false
    const list = result.data
    if (!result.success || !list) {
      error.value = failureText(result)
      return
    }
    users.value = list
    error.value = ''
  }

  async function createUser(input: CreateUserInput): Promise<UserSummary | undefined> {
    busy.value = true
    const result = await callApi(() => window.api.auth.createUser(input))
    busy.value = false
    const created = result.data
    if (!result.success || !created) {
      error.value = failureText(result)
      return undefined
    }
    users.value = [...users.value, created]
    error.value = ''
    return created
  }

  async function deleteUser(userId: string): Promise<boolean> {
    busy.value = true
    const result = await callApi(() => window.api.auth.deleteUser(userId))
    busy.value = false
    if (!result.success) {
      error.value = failureText(result)
      return false
    }
    users.value = users.value.filter((user) => user.id !== userId)
    error.value = ''
    return true
  }

  async function resetPassword(input: ResetUserPasswordInput): Promise<boolean> {
    busy.value = true
    const result = await callApi(() => window.api.auth.resetPassword(input))
    busy.value = false
    const updated = result.data
    if (!result.success || !updated) {
      error.value = failureText(result)
      return false
    }
    applyUser(updated)
    error.value = ''
    return true
  }

  async function setRole(userId: string, role: UserRole): Promise<boolean> {
    busy.value = true
    const result = await callApi(() => window.api.auth.setRole(userId, role))
    busy.value = false
    const updated = result.data
    if (!result.success || !updated) {
      error.value = failureText(result)
      return false
    }
    applyUser(updated)
    error.value = ''
    return true
  }

  /**
   * 逐项保存一个账户的权限（手册 §17.1 的复选框）。
   *
   * 提交的是**全量**勾选态：主进程整体替换那一格，所以「取消勾选」与「勾选」
   * 走同一条路，不存在「只发增量、少发一项就等于没改」这种静默状态。
   */
  async function setPermissions(input: UpdateUserPermissionsInput): Promise<boolean> {
    busy.value = true
    const result = await callApi(() => window.api.auth.setPermissions(input))
    busy.value = false
    const updated = result.data
    if (!result.success || !updated) {
      error.value = failureText(result)
      return false
    }
    applyUser(updated)
    error.value = ''
    return true
  }

  /** 「从…复制权限」（手册 §17.1 第 5 步的 Copy from）。 */
  async function copyPermissions(input: CopyUserPermissionsInput): Promise<boolean> {
    busy.value = true
    const result = await callApi(() => window.api.auth.copyPermissions(input))
    busy.value = false
    const updated = result.data
    if (!result.success || !updated) {
      error.value = failureText(result)
      return false
    }
    applyUser(updated)
    error.value = ''
    return true
  }

  /** 改显示名称（Edit User 的一部分）。 */
  async function updateProfile(input: UpdateUserProfileInput): Promise<boolean> {
    busy.value = true
    const result = await callApi(() => window.api.auth.updateProfile(input))
    busy.value = false
    const updated = result.data
    if (!result.success || !updated) {
      error.value = failureText(result)
      return false
    }
    applyUser(updated)
    error.value = ''
    return true
  }

  function clearError(): void {
    error.value = ''
  }

  return {
    // state
    session,
    ready,
    busy,
    error,
    mustChangePassword,
    users,
    installId,
    // getters
    isAuthenticated,
    isAdmin,
    displayName,
    currentUserId,
    adminCount,
    // session
    restore,
    subscribe,
    login,
    logout,
    // passwords
    changePassword,
    completeForcedChange,
    recover,
    loadInstallId,
    loadRememberedLogin,
    rememberLogin,
    forgetRememberedLogin,
    // account management
    loadUsers,
    createUser,
    deleteUser,
    resetPassword,
    setRole,
    setPermissions,
    copyPermissions,
    updateProfile,
    clearError
  }
})
