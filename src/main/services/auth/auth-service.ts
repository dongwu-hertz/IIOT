/**
 * Application authentication and authorisation.
 *
 * This service owns the answer to "who is using this console right now". Nothing
 * else in the main process may cache that answer, and every privileged IPC handler
 * asks here rather than trusting anything the renderer sends — a renderer that
 * claims to be an administrator is asserting, not proving.
 *
 * THE SESSION LIVES IN THE MAIN PROCESS, DELIBERATELY
 * The renderer also holds a copy so the UI can render the right things, but that
 * copy is only ever a display concern. If the session state lived only in the
 * renderer, every guard here would degrade into "does the page say it is an
 * admin", which is a formality.
 */

import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { AppError, ErrorCodes } from '@shared/errors'
import { appLog } from '../logging/logger'
import {
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_ADMIN_USERNAME,
  MAX_USER_ACCOUNTS,
  PASSWORD_MIN_LENGTH,
  USERNAME_FORBIDDEN_CHARACTERS,
  usernameProblemKey,
  defaultPermissionsForRole,
  grantedPermissions,
  isAdministrator,
  normalisePermissionSet,
  readPermissionKeys,
  withoutAdminOnly,
  type ChangePasswordInput,
  type CopyUserPermissionsInput,
  type CreateUserInput,
  type RecoverAccountInput,
  type ResetUserPasswordInput,
  type SessionInfo,
  type UpdateUserPermissionsInput,
  type UpdateUserProfileInput,
  type UserPermissionKey,
  type UserPermissionSet,
  type UserRole,
  type UserSummary,
  type LoginInput
} from '@shared/domain/auth'
import type { UserRecord, UserRepository, AppMetaRepository } from '../database/user-repository'
import { hashPassword, verifyPassword } from './password'
import { normaliseCode, verifyRecoveryCode } from './super-password'
import type { AccountPermissionStore } from './account-permission-store'
import type { RememberedLoginStore } from './remembered-login-store'
import type { RememberLoginInput, RememberedLoginSnapshot } from '@shared/domain/auth'

/** Meta key holding this installation's id. */
const INSTALL_ID_KEY = 'install.id'

/**
 * Interactive login throttling.
 *
 * In-memory and per-process on purpose: this defends the console in front of the
 * operator, and a restart clearing it is acceptable (a restart is not something an
 * attacker at the keyboard can do repeatedly without being noticed). Persisting it
 * would add a write to every failed attempt, which is its own denial-of-service.
 */
const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 60_000

interface AttemptState {
  failures: number
  lockedUntil: number
}

export interface AuthServiceOptions {
  users: UserRepository
  meta: AppMetaRepository
  /** Injectable clock, so lockout behaviour is testable without waiting a minute. */
  now?: () => number
  /**
   * 账号权限表（手册 §17.1）。可选：不传时权限退化为「按角色的出厂默认」，
   * 因此既有测试与只关心登录的调用方不需要知道它的存在。
   */
  permissions?: AccountPermissionStore
  /**
   * 「记住上次的用户名 / 记住密码」（业主 2026-09-16）。可选，理由同上：
   * 只关心登录结果的调用方（与既有测试）不需要知道它。
   *
   * 它**不参与** `login()` 的判定：登录成功与否只看用户表。记住与否是界面在登录**之后**
   * 才决定的事（取决于用户有没有勾那个框），所以是独立的三个方法。
   */
  rememberedLogin?: RememberedLoginStore
}

export interface LoginOutcome {
  session: SessionInfo
  /** True when the account is still on its factory or reset password. */
  mustChangePassword: boolean
}

/**
 * Emits `session` with the new `SessionInfo` (or `null`) whenever it changes.
 *
 * The renderer mirrors the session for rendering only, and it must stay in step
 * even when the change did not originate in the page — which is exactly what the
 * headless verification scripts do when they authenticate over the bridge. Without
 * this push the renderer has to poll, and a login screen that asks "is anybody
 * signed in?" every two seconds forever is a worse answer than an event.
 *
 * Same shape as `DeviceService`'s `status` event, so `main/index.ts` forwards both
 * to the window the same way.
 */
export class AuthService extends EventEmitter {
  private readonly users: UserRepository
  private readonly meta: AppMetaRepository
  private readonly now: () => number
  private readonly permissions: AccountPermissionStore | undefined
  /** 缺省时"记住"功能整体退化为"什么都不记"。 */
  private readonly rememberedLoginStore: RememberedLoginStore | undefined
  private readonly attempts = new Map<string, AttemptState>()
  private session?: SessionInfo

  constructor(options: AuthServiceOptions) {
    super()
    this.users = options.users
    this.meta = options.meta
    this.now = options.now ?? (() => Date.now())
    this.permissions = options.permissions
    this.rememberedLoginStore = options.rememberedLogin
  }

  /**
   * 公共 `requireAdministrator()` + 权限（手册 §17.1 的逐项授权）。
   *
   * 这一条**包含**角色检查，所以调用方写它一个就够：管理员通过，操作员还必须在
   * 权限表里被勾上 `manageAccounts`。两者的顺序无关紧要（两个都是抛异常），
   * 但先查角色更便宜，而且报错更贴近"这个账户是什么角色"。
   *
   * 为什么账号管理这一组不写在 `handlers.ts` 里：这些操作**全都**要这一项权限，
   * 而它们的入口有八个。写在服务里意味着「加了第九个入口却忘了加守卫」不可能发生——
   * 它在服务里，不在调用点上。
   */
  private requireAccountManagement(): SessionInfo {
    this.requireAdministrator()
    return this.requirePermission('manageAccounts')
  }

  // -------------------------------------------------------------------------
  // 权限（手册 §17.1）
  // -------------------------------------------------------------------------

  /**
   * 一个账户**生效**的权限。
   *
   * 管理员恒为全权（`normalisePermissionSet` 按角色决定），因此库里不需要、
   * 也不允许存管理员的那一份。操作员则取权限表里的那一格；没有条目 = 出厂默认。
   */
  private effectivePermissions(user: UserRecord): UserPermissionSet {
    if (user.role === 'admin') return normalisePermissionSet('admin', undefined)
    const stored = this.permissions?.forUser(user.id)
    return normalisePermissionSet('operator', stored ?? defaultPermissionsForRole('operator'))
  }

  /** 一个账户的权限，作为 `UserSummary` 的一部分交给界面。 */
  permissionsOf(user: UserRecord): UserPermissionSet {
    return this.effectivePermissions(user)
  }

  /**
   * 要求当前会话持有某一项权限。
   *
   * 与 `requireAdministrator()` 的分工：那一条是**角色**层面的硬规则（账号管理、
   * 系统设置写入、设备增删），这一条是角色之上**逐项勾选**的细粒度授权。
   * 管理员直接通过，所以给既有调用方加这一条不会改变管理员看到的行为。
   */
  requirePermission(permission: UserPermissionKey): SessionInfo {
    const session = this.requireSession()
    if (isAdministrator(session.user.role)) return session
    const user = this.users.findById(session.user.id)
    if (!user) throw new AppError(ErrorCodes.AUTH_FAILED, '当前账户不存在')
    if (this.effectivePermissions(user)[permission] === true) return session
    throw new AppError(
      ErrorCodes.FORBIDDEN,
      '当前账户没有该项权限',
      `permission=${permission} role=${session.user.role}`
    )
  }

  /** 当前会话是否持有某一项权限（读侧，不抛）。 */
  hasPermission(permission: UserPermissionKey): boolean {
    const session = this.session
    if (!session) return false
    if (isAdministrator(session.user.role)) return true
    const user = this.users.findById(session.user.id)
    if (!user) return false
    return this.effectivePermissions(user)[permission] === true
  }

  /**
   * `UserRecord` -> 跨 IPC 的 `UserSummary`，**权限在这里补上**。
   *
   * 做成方法而不是模块级函数，是因为权限要读权限表（`this.permissions`），
   * 而那份存储属于这个服务。
   */
  private toSummary(user: UserRecord): UserSummary {
    const summary: UserSummary = {
      id: user.id,
      username: user.username,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
      createdAt: user.createdAt,
      permissions: this.effectivePermissions(user)
    }
    if (user.displayName) summary.displayName = user.displayName
    if (user.lastLoginAt !== undefined) summary.lastLoginAt = user.lastLoginAt
    return summary
  }

  /** Announce the current session (or its absence) to whoever is listening. */
  private publishSession(): void {
    this.emit('session', this.session ?? null)
  }

  // -------------------------------------------------------------------------
  // Installation identity + first run
  // -------------------------------------------------------------------------

  /**
   * This installation's id, generated once and then stable.
   *
   * Public (it is shown on the login screen), used only to derive the recovery
   * code. Generated rather than derived from hardware: a machine id would change
   * when the disk is imaged or the network adapter is replaced, which would lock
   * an operator out of their own recovery path.
   */
  installId(): string {
    const existing = this.meta.get(INSTALL_ID_KEY)
    if (existing) return formatInstallId(existing)
    const raw = randomBytes(8).toString('hex').toUpperCase()
    this.meta.set(INSTALL_ID_KEY, raw)
    appLog().info('Generated installation id for password recovery')
    return formatInstallId(raw)
  }

  /** The raw (ungrouped) id, for code derivation. */
  private rawInstallId(): string {
    return normaliseCode(this.installId())
  }

  // -------------------------------------------------------------------------
  // 记住上次的用户名 / 记住密码（业主 2026-09-16）
  // -------------------------------------------------------------------------

  /**
   * 登录页要预填的东西。
   *
   * 没接 `rememberedLogin` 时返回"什么都没有"而不是抛错：这个依赖是可选的，而
   * 「没记住任何东西」本来就是它的合法状态。
   */
  rememberedLogin(): RememberedLoginSnapshot {
    if (!this.rememberedLoginStore) {
      return { username: '', expired: false, persistent: false }
    }
    return this.rememberedLoginStore.read()
  }

  /** 登录成功之后由界面调用（是否记住取决于用户有没有勾那个框）。 */
  rememberLogin(input: RememberLoginInput): void {
    this.rememberedLoginStore?.remember(input)
  }

  /** 用户主动清除（例如换人用这台机器）。 */
  forgetRememberedLogin(): void {
    this.rememberedLoginStore?.forget()
  }

  /**
   * Create the factory administrator if there are no accounts at all.
   *
   * Runs on every start and does nothing once an account exists, so an
   * administrator who renames or deletes every other user is not re-created —
   * there is no way to lock the software out of having an owner.
   */
  ensureSeedAccount(): { created: boolean; username: string } {    if (this.users.count() > 0) return { created: false, username: DEFAULT_ADMIN_USERNAME }

    this.users.insert({
      username: DEFAULT_ADMIN_USERNAME,
      displayName: DEFAULT_ADMIN_USERNAME,
      role: 'admin',
      passwordHash: hashPassword(DEFAULT_ADMIN_PASSWORD),
      // Forces the factory password to be replaced on first login. It is
      // documented, so it is public knowledge the moment the app is installed.
      mustChangePassword: true
    })
    appLog().warn('Created the factory administrator account; the password must be changed on first login', {
      username: DEFAULT_ADMIN_USERNAME
    })
    return { created: true, username: DEFAULT_ADMIN_USERNAME }
  }

  // -------------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------------

  currentSession(): SessionInfo | undefined {
    return this.session
  }

  /** The signed-in user, or a clear failure. */
  requireSession(): SessionInfo {
    if (!this.session) {
      throw new AppError(ErrorCodes.AUTH_FAILED, '尚未登录')
    }
    return this.session
  }

  /** The signed-in administrator, or a clear failure. */
  requireAdministrator(): SessionInfo {
    const session = this.requireSession()
    if (!isAdministrator(session.user.role)) {
      throw new AppError(
        ErrorCodes.FORBIDDEN,
        '该操作需要管理员权限',
        `role=${session.user.role}`
      )
    }
    return session
  }

  // -------------------------------------------------------------------------
  // Login / logout
  // -------------------------------------------------------------------------

  login(input: LoginInput): LoginOutcome {
    const username = input.username.trim()
    this.assertNotLocked(username)

    const user = this.users.findByUsername(username)
    // Verify against a dummy hash when the account is absent, so that "no such
    // user" and "wrong password" take the same time. Otherwise the response time
    // enumerates valid usernames.
    const stored = user?.passwordHash ?? DUMMY_HASH
    const ok = verifyPassword(input.password, stored)

    if (!user || !ok) {
      this.recordFailure(username)
      appLog().warn('Application login failed', { username })
      throw new AppError(ErrorCodes.AUTH_FAILED, '用户名或密码不正确')
    }

    this.attempts.delete(username.toLowerCase())
    this.users.setLastLogin(user.id, this.now())
    this.session = { user: this.toSummary(user), signedInAt: this.now() }
    appLog().info('Application login succeeded', { username: user.username, role: user.role })
    this.publishSession()

    return { session: this.session, mustChangePassword: user.mustChangePassword }
  }

  logout(): void {
    if (this.session) {
      appLog().info('Application logout', { username: this.session.user.username })
    }
    this.session = undefined
    this.publishSession()
  }

  /**
   * Replace the current session's user object after a profile change, so the
   * renderer never shows a stale role or display name.
   */
  private refreshSession(user: UserRecord): void {
    if (this.session?.user.id === user.id) {
      this.session = { ...this.session, user: this.toSummary(user) }
      this.publishSession()
    }
  }

  // -------------------------------------------------------------------------
  // Passwords
  // -------------------------------------------------------------------------

  /** Change one's own password, proving the current one. */
  changePassword(input: ChangePasswordInput): UserSummary {
    const session = this.requireSession()
    const user = this.users.findById(session.user.id)
    if (!user) throw new AppError(ErrorCodes.AUTH_FAILED, '当前账户不存在')

    if (!verifyPassword(input.currentPassword, user.passwordHash)) {
      throw new AppError(ErrorCodes.AUTH_FAILED, '当前密码不正确')
    }
    assertPasswordAcceptable(input.newPassword, user.username)
    if (verifyPassword(input.newPassword, user.passwordHash)) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '新密码不能与当前密码相同')
    }

    this.users.updatePassword(user.id, hashPassword(input.newPassword), false)
    const updated = this.users.findById(user.id)
    if (!updated) throw new AppError(ErrorCodes.STORAGE_ERROR, '密码保存后无法读回账户')
    this.refreshSession(updated)
    appLog().info('Password changed by the account owner', { username: user.username })
    return this.toSummary(updated)
  }

  /**
   * Regain access with the recovery code.
   *
   * Requires no session — that is the entire point — so it must be the most
   * carefully bounded operation in the file: it can only reset the password of an
   * EXISTING account, it cannot change a role, it cannot create or delete
   * anything, and every use is logged at warn level. It also clears that account's
   * lockout, because a locked-out administrator is exactly who this is for.
   */
  recoverAccount(input: RecoverAccountInput): UserSummary {
    const username = input.username.trim()
    if (!username) throw new AppError(ErrorCodes.VALIDATION_ERROR, '请输入要找回的账户名')

    if (!verifyRecoveryCode(this.rawInstallId(), input.superPassword)) {
      appLog().warn('Recovery code rejected', { username })
      throw new AppError(ErrorCodes.AUTH_FAILED, '超级密码不正确')
    }

    const user = this.users.findByUsername(username)
    if (!user) throw new AppError(ErrorCodes.VALIDATION_ERROR, `账户不存在: ${username}`)

    assertPasswordAcceptable(input.newPassword, user.username)
    this.users.updatePassword(user.id, hashPassword(input.newPassword), false)
    this.attempts.delete(user.username.toLowerCase())
    const updated = this.users.findById(user.id)
    if (!updated) throw new AppError(ErrorCodes.STORAGE_ERROR, '密码重置后无法读回账户')
    this.refreshSession(updated)
    appLog().warn('Password reset with the recovery code', { username: user.username })
    return this.toSummary(updated)
  }

  // -------------------------------------------------------------------------
  // Account management (administrator only)
  // -------------------------------------------------------------------------

  listUsers(): UserSummary[] {
    this.requireAccountManagement()
    return this.users.list().map((user) => this.toSummary(user))
  }

  createUser(input: CreateUserInput): UserSummary {
    this.requireAccountManagement()

    const username = input.username.trim()
    // 手册 §17.1（第 5198–5199 行）的三条硬约束，逐条在这里，界面只是**提前**说。
    if (!username) throw new AppError(ErrorCodes.VALIDATION_ERROR, '用户名不能为空')
    const nameProblem = usernameProblemKey(username)
    if (nameProblem === 'forbidden') {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `用户名不能包含以下字符：${USERNAME_FORBIDDEN_CHARACTERS}`
      )
    }
    if (nameProblem === 'tooLong') {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '用户名过长')
    }
    if (this.users.count() >= MAX_USER_ACCOUNTS) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `最多只能创建 ${MAX_USER_ACCOUNTS} 个账户`
      )
    }
    if (this.users.findByUsername(username)) {
      throw new AppError(ErrorCodes.AUTH_USERNAME_TAKEN, `用户名已存在: ${username}`)
    }
    assertPasswordAcceptable(input.password, username)

    const created = this.users.insert({
      username,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      role: input.role,
      passwordHash: hashPassword(input.password),
      // An administrator who creates an account sets its first password, so the
      // new user must replace it. Otherwise the administrator permanently knows
      // somebody else's credentials.
      mustChangePassword: true
    })

    /**
     * 新账户的初始权限（手册 §17.1）：
     *   - 管理员 = 全权，**不落库**（由角色推出来，见 `effectivePermissions`）；
     *   - 操作员 = 界面提交的那一份；没提交就是出厂默认（只读的四项）。
     */
    if (created.role !== 'admin') {
      const requested =
        input.permissions === undefined
          ? defaultPermissionsForRole('operator')
          : withoutAdminOnly(readPermissionKeys(input.permissions))
      this.permissions?.set(created.id, requested)
    }

    appLog().info('Account created', { username: created.username, role: created.role })
    // 读回：上面那次 `set()` 之后重新按生效规则算一遍，交给界面的就是落库后的事实。
    const reread = this.users.findById(created.id)
    if (!reread) throw new AppError(ErrorCodes.STORAGE_ERROR, '账户创建后无法读回')
    return this.toSummary(reread)
  }

  deleteUser(userId: string): void {
    const session = this.requireAccountManagement()
    const target = this.users.findById(userId)
    if (!target) throw new AppError(ErrorCodes.VALIDATION_ERROR, '账户不存在')

    // Order matters, and getting it wrong made one of these branches unreachable:
    // when the actor is an administrator and the target is a DIFFERENT
    // administrator there are at least two, so the last-administrator rule can
    // never fire for a delete. Checking it first is what makes "delete the last
    // administrator" (which is only ever yourself) report the real reason.
    if (target.role === 'admin' && this.users.adminCount() <= 1) {
      throw new AppError(ErrorCodes.AUTH_LAST_ADMIN, '必须保留至少一个管理员账户')
    }
    if (session.user.id === userId) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '不能删除当前登录的账户')
    }

    this.users.remove(userId)
    // 权限表里那一格一起删掉：留下来的孤立权限会在**新账户拿到同一个 id** 时
    // 悄悄变成它的权限。id 是随机的，但「不可能发生」不是不留孤儿条目的理由。
    this.permissions?.remove(userId)
    appLog().info('Account deleted', { username: target.username, by: session.user.username })
  }

  resetUserPassword(input: ResetUserPasswordInput): UserSummary {
    this.requireAccountManagement()
    const target = this.users.findById(input.userId)
    if (!target) throw new AppError(ErrorCodes.VALIDATION_ERROR, '账户不存在')
    assertPasswordAcceptable(input.newPassword, target.username)

    this.users.updatePassword(target.id, hashPassword(input.newPassword), true)
    this.attempts.delete(target.username.toLowerCase())
    const updated = this.users.findById(target.id)
    if (!updated) throw new AppError(ErrorCodes.STORAGE_ERROR, '密码重置后无法读回账户')
    this.refreshSession(updated)
    appLog().info('Password reset by an administrator', { username: target.username })
    return this.toSummary(updated)
  }

  setUserRole(userId: string, role: UserRole): UserSummary {
    const session = this.requireAccountManagement()
    const target = this.users.findById(userId)
    if (!target) throw new AppError(ErrorCodes.VALIDATION_ERROR, '账户不存在')

    if (target.role === 'admin' && role !== 'admin' && this.users.adminCount() <= 1) {
      throw new AppError(ErrorCodes.AUTH_LAST_ADMIN, '必须保留至少一个管理员账户')
    }
    if (session.user.id === userId && role !== 'admin') {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '不能撤销当前登录账户的管理员权限')
    }

    const updated = this.users.updateProfile(userId, { role })
    if (!updated) throw new AppError(ErrorCodes.STORAGE_ERROR, '角色保存后无法读回账户')
    /**
     * 角色变了，权限表里那一格必须跟着变，否则会出现两种分裂：
     *   - 管理员：库里还留着一份操作员权限，而生效权限由角色算成全权——库里的
     *     那份就是永远读不到的垃圾，下次降回操作员时会突然生效（像是"系统偷偷
     *     记着我以前的勾选"）；
     *   - 操作员 → 管理员：他原来勾的东西同理。
     * 所以降级时清掉条目（回到出厂默认），升级时也清掉（管理员不需要存权限）。
     */
    if (role === 'admin' || updated.role === 'admin') this.permissions?.remove(userId)
    this.refreshSession(updated)
    appLog().info('Account role changed', { username: updated.username, role })
    return this.toSummary(updated)
  }

  /**
   * 改显示名称（手册 §17.1 的 Edit User）。
   *
   * 只改**标签**：用户名与角色各有自己的通道，因为它们的约束完全不同。显示名
   * 没有唯一性要求，所以两个人叫同一个名字是允许的——界面在那一列上同时显示
   * 用户名，正是为了这一点。
   */
  updateUserProfile(input: UpdateUserProfileInput): UserSummary {
    const session = this.requireAccountManagement()
    const target = this.users.findById(input.userId)
    if (!target) throw new AppError(ErrorCodes.VALIDATION_ERROR, '账户不存在')

    const displayName = input.displayName.trim()
    const updated = this.users.updateProfile(target.id, { displayName })
    if (!updated) throw new AppError(ErrorCodes.STORAGE_ERROR, '显示名称保存后无法读回账户')
    this.refreshSession(updated)
    appLog().info('Account display name changed', {
      username: updated.username,
      by: session.user.username
    })
    return this.toSummary(updated)
  }

  /**
   * 逐个勾选地改一个账户的权限（手册 §17.1 第 5 步的「check the checkboxes」）。
   *
   * 三条规则：
   *   1. **只有管理员能改**（`requireAdministrator()`），与手册「管理员可以修改所有
   *      操作员以及自己账户的密码与权限」一致；
   *   2. **管理员的权限永远是全权**，所以对管理员调用它是一个明确的失败，而不是
   *      把一份"看起来不是全权"的勾选态写进库、再被生效规则盖掉；
   *   3. 管理员专属项（账号管理、系统设置写入）对操作员**丢不掉也加不上**：
   *      传进来会被 `withoutAdminOnly` 丢掉。这不是静默修正——它不可能改变结果，
   *      因为生效规则本来就把它们钉成 `false`。
   */
  updateUserPermissions(input: UpdateUserPermissionsInput): UserSummary {
    const session = this.requireAccountManagement()
    const target = this.users.findById(input.userId)
    if (!target) throw new AppError(ErrorCodes.VALIDATION_ERROR, '账户不存在')
    if (target.role === 'admin') {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        '管理员账户的权限为全部权限，不可逐项修改'
      )
    }

    const requested = withoutAdminOnly(readPermissionKeys(input.permissions))
    this.permissions?.set(target.id, requested)

    // 读回：`set()` 已经把归一化后的那一份写给调用方，这里再从库里读一遍账户，
    // 交给界面的就是落库后的事实（而不是"我刚提交了什么"）。
    const reread = this.users.findById(target.id)
    if (!reread) throw new AppError(ErrorCodes.STORAGE_ERROR, '权限保存后无法读回账户')
    appLog().info('Account permissions updated', {
      username: reread.username,
      permissions: grantedPermissions(this.effectivePermissions(reread)).join(','),
      by: session.user.username
    })
    this.refreshSession(reread)
    return this.toSummary(reread)
  }

  /**
   * 「从…复制权限」（手册 §17.1 第 5 步的 Copy from 下拉框）。
   *
   * 复制的是**生效权限**，不是库里那一格：
   *   - 来源是管理员 -> 目标是操作员时，管理员专属项按规则丢掉，其余全勾上；
   *   - 来源是操作员 -> 目标是操作员时，逐项照搬。
   *
   * 自己复制给自己被拒绝：那既没有意义，也会让「我刚做了一次复制」和
   * 「我什么都没改」在界面上无法区分。
   */
  copyPermissions(input: CopyUserPermissionsInput): UserSummary {
    const session = this.requireAccountManagement()
    if (input.sourceUserId === input.targetUserId) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '不能把权限复制给同一个账户')
    }
    const source = this.users.findById(input.sourceUserId)
    if (!source) throw new AppError(ErrorCodes.VALIDATION_ERROR, '来源账户不存在')
    const target = this.users.findById(input.targetUserId)
    if (!target) throw new AppError(ErrorCodes.VALIDATION_ERROR, '目标账户不存在')
    if (target.role === 'admin') {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        '管理员账户的权限为全部权限，不可逐项修改'
      )
    }

    const sourceSet = this.effectivePermissions(source)
    const copied = withoutAdminOnly(grantedPermissions(sourceSet))
    this.permissions?.set(target.id, copied)

    const reread = this.users.findById(target.id)
    if (!reread) throw new AppError(ErrorCodes.STORAGE_ERROR, '权限保存后无法读回账户')
    appLog().info('Account permissions copied', {
      from: source.username,
      to: reread.username,
      permissions: copied.join(','),
      by: session.user.username
    })
    this.refreshSession(reread)
    return this.toSummary(reread)
  }

  // -------------------------------------------------------------------------
  // Throttling
  // -------------------------------------------------------------------------

  private assertNotLocked(username: string): void {
    const state = this.attempts.get(username.toLowerCase())
    if (!state) return
    const remaining = state.lockedUntil - this.now()
    if (remaining > 0) {
      const seconds = Math.ceil(remaining / 1000)
      // AUTH_LOCKED, not FORBIDDEN. A lockout means "your password was wrong too
      // many times; wait a moment", which is the opposite instruction to "this
      // account may not do that" — and reusing FORBIDDEN made the login screen
      // report a permissions problem for what is really a throttling delay.
      throw new AppError(
        ErrorCodes.AUTH_LOCKED,
        `登录失败次数过多，请在 ${seconds} 秒后重试`,
        `retryAfterSeconds=${seconds}`
      )
    }
  }

  private recordFailure(username: string): void {
    const key = username.toLowerCase()
    const state = this.attempts.get(key) ?? { failures: 0, lockedUntil: 0 }
    state.failures += 1
    if (state.failures >= MAX_ATTEMPTS) {
      state.lockedUntil = this.now() + LOCKOUT_MS
      // Reset the counter so the next window is a full one rather than instantly
      // re-locking on the following failure.
      state.failures = 0
      appLog().warn('Account temporarily locked after repeated failures', { username })
    }
    this.attempts.set(key, state)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A valid-format hash with no known preimage.
 *
 * Used when the username does not exist so that verification still performs the
 * full scrypt work. Without it, a missing user returns in microseconds and a wrong
 * password takes ~50 ms, which turns the login form into a username oracle.
 */
const DUMMY_HASH = hashPassword(randomBytes(32).toString('hex'))

/** `AB12CD34EF56` -> `AB12-CD34-EF56`. */
function formatInstallId(raw: string): string {
  const groups: string[] = []
  for (let i = 0; i < raw.length; i += 4) groups.push(raw.slice(i, i + 4))
  return groups.join('-')
}

/**
 * Password policy, enforced in one place.
 *
 * Length only, plus the two rules that actually matter in practice: a password
 * containing the username is rejected, and surrounding whitespace is refused
 * rather than silently trimmed (a trailing space is invisible in a password field
 * and produces a support call).
 */
function assertPasswordAcceptable(password: string, username: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new AppError(
      ErrorCodes.AUTH_PASSWORD_POLICY,
      `密码长度至少 ${PASSWORD_MIN_LENGTH} 位`
    )
  }
  if (password !== password.trim()) {
    throw new AppError(ErrorCodes.AUTH_PASSWORD_POLICY, '密码首尾不能包含空格')
  }
  if (username.length >= 3 && password.toLowerCase().includes(username.toLowerCase())) {
    throw new AppError(ErrorCodes.AUTH_PASSWORD_POLICY, '密码不能包含用户名')
  }
}
