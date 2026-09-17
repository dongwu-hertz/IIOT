<script setup lang="ts">
/**
 * 账号管理（手册 §17.1 Account Management，p177–178）。
 *
 * ---------------------------------------------------------------------------
 * 它复用了什么（**没有第二套账号存储、没有第二套密码哈希**）
 * ---------------------------------------------------------------------------
 *   - 账号表与 scrypt 哈希：`UserRepository` / `AuthService`（既有）；
 *   - 会话与角色：`stores/session.ts` + 主进程的 `requireAdministrator()`；
 *   - 用户名/密码策略：`@shared/domain/auth` 里的 `usernameProblemKey()` /
 *     `PASSWORD_MIN_LENGTH`，与主进程用的是**同一组常量**，所以界面提前说的话
 *     与服务真正执行的话不可能不一致；
 *   - 权限的读写：`AUTH_SET_PERMISSIONS` / `AUTH_COPY_PERMISSIONS` 两条新通道，
 *     落到 `AccountPermissionStore`（`app_meta` 表）。
 *
 * 本组件只做三件事：把列表画出来、把校验**提前**跑一遍、把写入交给主进程。
 *
 * ---------------------------------------------------------------------------
 * 手册的硬约束（第 5198–5205 行）
 * ---------------------------------------------------------------------------
 *   1. 用户名不得包含 `/ \ : * ? " < > |`；
 *   2. 密码不得少于 6 个字符；
 *   3. 最多 50 个账号；
 *   4. 内置管理员不可删除。
 * 四条都由主进程强制（`AuthService`），这里复述它们是为了让用户在点下去之前
 * 就知道，而不是为了替代那条强制。
 *
 * ---------------------------------------------------------------------------
 * 内置管理员
 * ---------------------------------------------------------------------------
 * 「内置管理员」= 出厂的那个 `admin` 账户，也就是**由 `ensureSeedAccount()` 创建、
 * 在当前列表里角色为管理员且数量为 1 的那一个**。它的删除按钮必须不可用（手册
 * 第 5214 行：The super user cannot be deleted and only the password of the super
 * user can be edited），而密码可以改。判据是 `isBuiltInAdministrator()`，
 * 它同时要求「用户名是出厂名」与「它是唯一的管理员」——只看用户名会把一个
 * 被改名后新建的同名账户也当成内置的，只看数量会在有第二个管理员时误判。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  DEFAULT_ADMIN_USERNAME,
  MAX_USER_ACCOUNTS,
  PASSWORD_MIN_LENGTH,
  USERNAME_FORBIDDEN_CHARACTERS,
  USERNAME_MAX_LENGTH,
  USER_PERMISSION_KEYS,
  defaultPermissionsForRole,
  grantedPermissions,
  isAdminOnlyPermission,
  normalisePermissionSet,
  permissionOperationCount,
  usernameProblemKey,
  type UserPermissionKey,
  type UserPermissionSet,
  type UserRole,
  type UserSummary
} from '@shared/domain/auth'
import { useSessionStore } from '@renderer/stores/session'
import { passwordProblemKey, usernameConflictProblemKey } from '@renderer/lib/password'
import { formatDateTime } from '@renderer/lib/format'

const { t } = useI18n()
const session = useSessionStore()

/** 角色下拉的两个选项。取值来自共享层的枚举，界面不另写一份。 */
const ROLES: readonly UserRole[] = ['admin', 'operator']

const rows = computed(() => session.users)
const canWrite = computed(() => session.isAdmin)

/**
 * 账户清单由 `session.loadUsers()` 填充，而那个方法原本只被 `UsersDialog` 在打开时调用。
 * 设置页这一块是**常驻**的（没有"打开"这个时刻），所以必须自己在挂载时拉一次 ——
 * 否则表格永远是空的，而"空"看起来和"一个账户都没有"一模一样。
 */
onMounted(() => {
  if (session.isAdmin) void session.loadUsers()
})

/** 账户总数是否已达上限（手册：最多 50 个）。 */
const atAccountLimit = computed(() => rows.value.length >= MAX_USER_ACCOUNTS)

const formError = ref('')
const notice = ref('')

/** 当前展开编辑的账户 id；`''` = 都没有展开。 */
const editingId = ref('')
/** 正在确认删除的账户 id。 */
const confirmDeleteId = ref('')

interface EditDraft {
  displayName: string
  role: UserRole
  /** 权限草稿：每一项都有值，所以复选框不需要处理缺字段。 */
  permissions: UserPermissionSet
  /** 「从…复制权限」选中的来源账户 id。 */
  copyFromId: string
  /** 该账户的新密码（留空 = 不改）。 */
  newPassword: string
  confirmPassword: string
}

function emptyDraft(): EditDraft {
  return {
    displayName: '',
    role: 'operator',
    // 操作员的出厂默认勾选态（只读四项），与服务端 `defaultPermissionsForRole` 同一处。
    permissions: normalisePermissionSet('operator', defaultPermissionsForRole('operator')),
    copyFromId: '',
    newPassword: '',
    confirmPassword: ''
  }
}

const draft = reactive<EditDraft>(emptyDraft())

/** 新增账户的表单（与编辑分开：新增要用户名与密码，编辑不改用户名）。 */
const createOpen = ref(false)
const createDraft = reactive({
  username: '',
  displayName: '',
  role: 'operator' as UserRole,
  password: '',
  permissions: normalisePermissionSet('operator', defaultPermissionsForRole('operator'))
})

function resetMessages(): void {
  formError.value = ''
  notice.value = ''
  session.clearError()
}

function clearSecrets(): void {
  draft.newPassword = ''
  draft.confirmPassword = ''
  createDraft.password = ''
}

function collapse(): void {
  editingId.value = ''
  confirmDeleteId.value = ''
  createOpen.value = false
  Object.assign(draft, emptyDraft())
  Object.assign(createDraft, {
    username: '',
    displayName: '',
    role: 'operator' as UserRole,
    password: '',
    permissions: normalisePermissionSet('operator', defaultPermissionsForRole('operator'))
  })
  clearSecrets()
}

function label(user: UserSummary): string {
  return user.displayName?.trim() || user.username
}

function isSelf(user: UserSummary): boolean {
  return user.id === session.currentUserId
}

function isLastAdministrator(user: UserSummary): boolean {
  return user.role === 'admin' && session.adminCount <= 1
}

/**
 * 内置管理员（出厂的 `admin`，且是当前唯一的管理员）。
 *
 * 手册第 5214 行只说「super user 不可删除」。本仓库的 super user 就是
 * `ensureSeedAccount()` 建的那一个，因此判据是「出厂用户名 + 当前唯一管理员」。
 */
function isBuiltInAdministrator(user: UserSummary): boolean {
  return user.username.toLowerCase() === DEFAULT_ADMIN_USERNAME && isLastAdministrator(user)
}

/** 删除按钮为什么不可用；`''` = 可以删。 */
function deleteBlockReason(user: UserSummary): string {
  if (isSelf(user)) return t('usersUi.cannotDeleteSelf')
  if (isBuiltInAdministrator(user)) return t('accountUi.builtInAdminUndeletable')
  if (isLastAdministrator(user)) return t('errors.AUTH_LAST_ADMIN')
  return ''
}

function canDelete(user: UserSummary): boolean {
  return canWrite.value && deleteBlockReason(user) === ''
}

/** 生效权限：主进程给的那一份，缺字段时按角色默认（旧 preload / 既有测试字面量）。 */
function permissionsOf(user: UserSummary): UserPermissionSet {
  return normalisePermissionSet(user.role, user.permissions ? grantedPermissions(user.permissions) : undefined)
}

/** 角色改了、权限草稿必须跟着换，否则会出现「管理员却只剩只读勾选」的假象。 */
function onDraftRoleChange(): void {
  draft.permissions = normalisePermissionSet(draft.role, grantedPermissions(draft.permissions))
}

function toggleCreateRole(): void {
  createDraft.permissions = normalisePermissionSet(
    createDraft.role,
    grantedPermissions(createDraft.permissions)
  )
}

// ---------------------------------------------------------------------------
// 新增
// ---------------------------------------------------------------------------

function openCreate(): void {
  resetMessages()
  collapse()
  createOpen.value = true
}

/** 用户名的第一条违规原因，或 `''`。与服务端 `usernameProblemKey()` 同一实现。 */
function usernameError(username: string): string {
  switch (usernameProblemKey(username)) {
    case 'empty':
      return t('authUi.errUsername')
    case 'forbidden':
      return t('accountUi.errUsernameForbidden', { chars: USERNAME_FORBIDDEN_CHARACTERS })
    case 'tooLong':
      return t('accountUi.errUsernameTooLong', { max: USERNAME_MAX_LENGTH })
    default:
      return ''
  }
}

async function submitCreate(): Promise<void> {
  resetMessages()
  const username = createDraft.username.trim()
  const nameError = usernameError(username)
  if (nameError) {
    formError.value = nameError
    return
  }
  if (atAccountLimit.value) {
    formError.value = t('accountUi.errTooManyAccounts', { max: MAX_USER_ACCOUNTS })
    return
  }
  const problem = passwordProblemKey(createDraft.password)
  if (problem) {
    // 目录里的这一条带 `{min}`，所以「密码长度至少 N 位」的 N 永远等于服务端常量。
    formError.value = t(problem, { min: PASSWORD_MIN_LENGTH })
    return
  }
  /**
   * 「密码不能包含用户名」只在**新建**时检查。
   *
   * 服务端的 `assertPasswordAcceptable` 在新建与重置两条路上都查它，所以这里的顺序
   * 是：先查自己的三条规则，再查这一条 —— 换过去的那次修复是「密码框里还留着上一次
   * 提交的 5 位」，而不是这条规则本身。
   */
  const conflict = usernameConflictProblemKey(createDraft.password, username)
  if (conflict) {
    formError.value = t(conflict)
    return
  }

  const displayName = createDraft.displayName.trim()
  const created = await session.createUser({
    username,
    role: createDraft.role,
    password: createDraft.password,
    permissions: grantedPermissions(createDraft.permissions),
    ...(displayName ? { displayName } : {})
  })
  if (!created) {
    formError.value = session.error || t('errors.fallback')
    return
  }
  collapse()
  notice.value = t('usersUi.created')
}

// ---------------------------------------------------------------------------
// 编辑
// ---------------------------------------------------------------------------

function openEdit(user: UserSummary): void {
  resetMessages()
  createOpen.value = false
  confirmDeleteId.value = ''
  if (editingId.value === user.id) {
    editingId.value = ''
    return
  }
  editingId.value = user.id
  Object.assign(draft, emptyDraft())
  draft.displayName = user.displayName ?? ''
  draft.role = user.role
  draft.permissions = { ...permissionsOf(user) }
}

/** 「恢复该用户默认权限」（手册第 5195 行的 Default Permission）。 */
function restoreDefaultPermissions(): void {
  resetMessages()
  draft.permissions = normalisePermissionSet(draft.role, defaultPermissionsForRole(draft.role))
  notice.value = t('accountUi.permissionsDefaulted')
}

/**
 * 「从…复制权限」（手册第 5190 行的 Copy from 下拉框）。
 *
 * 只改草稿，不立刻落库：它是编辑的一部分，用户按「保存」之后才写。
 * 复制的是**来源账户生效的权限**，所以从一个管理员复制会给操作员勾上除
 * 「管理员专属」之外的全部权限 —— 这正是 `AuthService.copyPermissions()`
 * 在服务端做的事，两处一致。
 */
function copyPermissionsFrom(): void {
  resetMessages()
  const source = rows.value.find((user) => user.id === draft.copyFromId)
  if (!source) {
    formError.value = t('accountUi.errCopySource')
    return
  }
  draft.permissions = normalisePermissionSet('operator', grantedPermissions(permissionsOf(source)))
  notice.value = t('accountUi.permissionsCopied', { name: label(source) })
}

async function submitEdit(user: UserSummary): Promise<void> {
  resetMessages()
  const displayName = draft.displayName.trim()

  // 1) 角色
  if (draft.role !== user.role) {
    const ok = await session.setRole(user.id, draft.role)
    if (!ok) {
      formError.value = session.error || t('errors.fallback')
      return
    }
  }

  /**
   * 2) 权限
   *
   * 管理员恒为全权（服务端也会拒绝对管理员逐项改权限），所以这一步只在目标是
   * 操作员时发。
   */
  const targetRole = draft.role
  if (targetRole === 'operator') {
    const current = grantedPermissions(permissionsOf(user))
    const next = grantedPermissions(normalisePermissionSet('operator', grantedPermissions(draft.permissions)))
    const changed = current.length !== next.length || current.some((key) => !next.includes(key))
    if (changed) {
      const ok = await session.setPermissions({ userId: user.id, permissions: next })
      if (!ok) {
        formError.value = session.error || t('errors.fallback')
        return
      }
    }
  }

  // 3) 密码（留空 = 不改）
  if (draft.newPassword !== '') {
    const problem = passwordProblemKey(draft.newPassword)
    if (problem) {
      formError.value = t(problem, { min: PASSWORD_MIN_LENGTH })
      return
    }
    const conflict = usernameConflictProblemKey(draft.newPassword, user.username)
    if (conflict) {
      formError.value = t(conflict)
      return
    }
    if (draft.newPassword !== draft.confirmPassword) {
      formError.value = t('authUi.errPasswordMismatch')
      return
    }
    const ok = await session.resetPassword({ userId: user.id, newPassword: draft.newPassword })
    if (!ok) {
      formError.value = session.error || t('errors.fallback')
      return
    }
  }

  // 4) 显示名称（空字符串 = 清掉，界面回落到用户名）
  if (displayName !== (user.displayName ?? '')) {
    const ok = await session.updateProfile({ userId: user.id, displayName })
    if (!ok) {
      formError.value = session.error || t('errors.fallback')
      return
    }
  }

  collapse()
  notice.value = t('accountUi.saved')
}

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

function askDelete(user: UserSummary): void {
  resetMessages()
  editingId.value = ''
  confirmDeleteId.value = confirmDeleteId.value === user.id ? '' : user.id
}

async function confirmDelete(user: UserSummary): Promise<void> {
  resetMessages()
  const ok = await session.deleteUser(user.id)
  if (!ok) {
    formError.value = session.error || t('errors.fallback')
    return
  }
  confirmDeleteId.value = ''
  notice.value = t('accountUi.deleted')
}

/** 权限的显示名。取值是稳定标识，文案在四语言目录里。 */
function permissionLabel(key: UserPermissionKey): string {
  return t(`domain.permission.${key}`)
}

/**
 * 一项权限**管住多少条操作**，以及它管什么（手册 §17.1 的复选框）。
 *
 * `PERMISSION_OPERATIONS` 是共享层那张表 —— `handlers.ts` 里的 `requirePermission()`
 * 按同一张表落点，所以这里显示的不是说明文字，而是"这一项真的在拦什么"。
 * 唯一为空的一项是 `deleteRecordings`（本版本还没有删除录像的通道），界面如实说。
 */
function permissionScope(key: UserPermissionKey): string {
  const count = permissionOperationCount(key)
  if (count === 0) return t('accountUi.permissionScopeNone')
  return `${t(`domain.permissionScope.${key}`)}（${t('accountUi.permissionScopeCount', { count })}）`
}

function formatTime(value: number | undefined): string {
  return value ? formatDateTime(value) : t('usersUi.neverLoggedIn')
}
</script>

<template>
  <section class="card" data-section="account-management">
    <div class="section-header">
      <h3 class="section-title">{{ t('accountUi.title') }}</h3>
      <div class="btn-row">
        <button type="button" class="btn btn--sm" :disabled="!canWrite || session.busy" @click="session.loadUsers()">
          {{ t('common.refresh') }}
        </button>
        <button
          type="button"
          class="btn btn--sm btn--primary"
          :disabled="!canWrite || session.busy || atAccountLimit"
          :title="atAccountLimit ? t('accountUi.errTooManyAccounts', { max: MAX_USER_ACCOUNTS }) : undefined"
          @click="openCreate"
        >
          {{ t('usersUi.addUser') }}
        </button>
      </div>
    </div>

    <p v-if="formError" class="alert alert--danger" role="alert">{{ formError }}</p>
    <p v-else-if="notice" class="alert alert--success" role="status">{{ notice }}</p>
    <p v-if="!canWrite" class="muted account-hint">{{ t('accountUi.adminOnly') }}</p>

    <!-- 新增：就地展开，列表仍然看得见（用户名要对着现有账户检查）。 -->
    <form v-if="createOpen" class="editor" @submit.prevent="submitCreate">
      <h4 class="sub-title">{{ t('usersUi.addUser') }}</h4>
      <div class="form-grid">
        <label class="field">
          <span class="field-label">{{ t('usersUi.username') }}</span>
          <input
            v-model="createDraft.username"
            data-autofocus
            class="input"
            type="text"
            autocomplete="off"
            spellcheck="false"
          />
        </label>
        <label class="field">
          <span class="field-label">{{ t('usersUi.displayName') }}</span>
          <input v-model="createDraft.displayName" class="input" type="text" autocomplete="off" />
        </label>
        <label class="field">
          <span class="field-label">{{ t('usersUi.role') }}</span>
          <select v-model="createDraft.role" class="select" @change="toggleCreateRole">
            <option v-for="role in ROLES" :key="role" :value="role">
              {{ t(`domain.userRole.${role}`) }}
            </option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">{{ t('authUi.newPassword') }}</span>
          <input
            v-model="createDraft.password"
            class="input"
            type="password"
            autocomplete="new-password"
          />
        </label>
      </div>

      <!-- 权限复选框：管理员恒为全权，所以只在操作员上可勾。 -->
      <div class="permissions" data-permissions="create">
        <div class="permissions__head">
          <span class="field-label">{{ t('accountUi.permissions') }}</span>
          <span v-if="createDraft.role !== 'admin'" class="muted account-hint">
            {{ t('accountUi.createPermissionsHint') }}
          </span>
          <span v-else class="muted account-hint">{{ t('accountUi.adminAllPermissions') }}</span>
        </div>
        <label v-for="key in USER_PERMISSION_KEYS" :key="key" class="permissions__item">
          <input
            v-model="createDraft.permissions[key]"
            type="checkbox"
            :data-permission="key"
            :disabled="createDraft.role === 'admin' || isAdminOnlyPermission(key)"
          />
          <span class="permissions__text">
            <span>{{ permissionLabel(key) }}</span>
            <span class="permissions__scope">{{ permissionScope(key) }}</span>
          </span>
        </label>
      </div>

      <div class="btn-row">
        <button type="submit" class="btn btn--sm btn--primary" :disabled="session.busy">
          {{ session.busy ? t('usersUi.creating') : t('usersUi.create') }}
        </button>
        <button type="button" class="btn btn--sm" :disabled="session.busy" @click="collapse">
          {{ t('common.cancel') }}
        </button>
      </div>
    </form>

    <div class="table-wrap">
      <table class="table" data-table="accounts">
        <thead>
          <tr>
            <th>{{ t('usersUi.username') }}</th>
            <th>{{ t('usersUi.displayName') }}</th>
            <th>{{ t('usersUi.role') }}</th>
            <th>{{ t('usersUi.lastLogin') }}</th>
            <th>{{ t('devices.columns.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="user in rows" :key="user.id">
            <tr :data-account="user.username">
              <td class="mono">{{ user.username }}</td>
              <td>{{ label(user) }}</td>
              <td>
                <span>{{ t(`domain.userRole.${user.role}`) }}</span>
                <span v-if="user.mustChangePassword" class="badge badge--warning account-badge">
                  {{ t('usersUi.pendingPasswordChange') }}
                </span>
              </td>
              <td>{{ formatTime(user.lastLoginAt) }}</td>
              <td>
                <div class="row-actions">
                  <button
                    type="button"
                    class="btn btn--sm"
                    :disabled="!canWrite || session.busy"
                    @click="openEdit(user)"
                  >
                    {{ t('accountUi.editUser') }}
                  </button>
                  <button
                    type="button"
                    class="btn btn--sm btn--danger"
                    :disabled="!canDelete(user) || session.busy"
                    :title="deleteBlockReason(user)"
                    :data-delete-account="user.username"
                    @click="askDelete(user)"
                  >
                    {{ t('usersUi.deleteUser') }}
                  </button>
                </div>
              </td>
            </tr>

            <!-- 编辑：就地展开，被改的账户始终在屏幕上。 -->
            <tr v-if="editingId === user.id" :data-editor="user.username">
              <td colspan="5">
                <div class="editor">
                  <div class="form-grid">
                    <label class="field">
                      <span class="field-label">{{ t('usersUi.displayName') }}</span>
                      <input v-model="draft.displayName" class="input" type="text" />
                    </label>
                    <label class="field">
                      <span class="field-label">{{ t('usersUi.role') }}</span>
                      <select
                        v-model="draft.role"
                        class="select"
                        :disabled="isSelf(user) || isLastAdministrator(user) || session.busy"
                        @change="onDraftRoleChange"
                      >
                        <option v-for="role in ROLES" :key="role" :value="role">
                          {{ t(`domain.userRole.${role}`) }}
                        </option>
                      </select>
                    </label>
                    <label class="field">
                      <span class="field-label">{{ t('authUi.newPassword') }}</span>
                      <input
                        v-model="draft.newPassword"
                        class="input"
                        type="password"
                        autocomplete="new-password"
                      />
                    </label>
                    <label class="field">
                      <span class="field-label">{{ t('authUi.confirmPassword') }}</span>
                      <input
                        v-model="draft.confirmPassword"
                        class="input"
                        type="password"
                        autocomplete="new-password"
                      />
                    </label>
                  </div>

                  <div class="permissions" data-permissions="edit">
                    <div class="permissions__head">
                      <span class="field-label">{{ t('accountUi.permissions') }}</span>
                      <div class="btn-row">
                        <select v-model="draft.copyFromId" class="select" data-copy-from>
                          <option value="">{{ t('accountUi.copyFromPlaceholder') }}</option>
                          <option v-for="other in rows.filter((u) => u.id !== user.id)" :key="other.id" :value="other.id">
                            {{ label(other) }}
                          </option>
                        </select>
                        <button
                          type="button"
                          class="btn btn--sm"
                          :disabled="draft.copyFromId === ''"
                          @click="copyPermissionsFrom"
                        >
                          {{ t('accountUi.copyFrom') }}
                        </button>
                        <button type="button" class="btn btn--sm" @click="restoreDefaultPermissions">
                          {{ t('accountUi.defaultPermission') }}
                        </button>
                      </div>
                    </div>
                    <label v-for="key in USER_PERMISSION_KEYS" :key="key" class="permissions__item">
                      <input
                        v-model="draft.permissions[key]"
                        type="checkbox"
                        :disabled="draft.role === 'admin' || isAdminOnlyPermission(key)"
                        :data-permission="key"
                      />
                      <span class="permissions__text">
                        <span>{{ permissionLabel(key) }}</span>
                        <span class="permissions__scope">{{ permissionScope(key) }}</span>
                      </span>
                    </label>
                    <p v-if="draft.role === 'admin'" class="muted account-hint">
                      {{ t('accountUi.adminAllPermissions') }}
                    </p>
                  </div>

                  <div class="btn-row">
                    <button
                      type="button"
                      class="btn btn--sm btn--primary"
                      :disabled="session.busy"
                      :data-save-account="user.username"
                      @click="submitEdit(user)"
                    >
                      {{ session.busy ? t('common.saving') : t('common.save') }}
                    </button>
                    <button type="button" class="btn btn--sm" :disabled="session.busy" @click="collapse">
                      {{ t('common.cancel') }}
                    </button>
                  </div>
                </div>
              </td>
            </tr>

            <!-- 删除是不可逆的：在行内确认。 -->
            <tr v-if="confirmDeleteId === user.id" :data-delete-confirm="user.username">
              <td colspan="5">
                <div class="editor editor--row">
                  <span>{{ t('usersUi.deleteConfirm', { name: label(user) }) }}</span>
                  <div class="btn-row">
                    <button
                      type="button"
                      class="btn btn--sm btn--danger"
                      :disabled="session.busy"
                      @click="confirmDelete(user)"
                    >
                      {{ t('common.confirm') }}
                    </button>
                    <button type="button" class="btn btn--sm" :disabled="session.busy" @click="confirmDeleteId = ''">
                      {{ t('common.cancel') }}
                    </button>
                  </div>
                </div>
              </td>
            </tr>
          </template>

          <tr v-if="rows.length === 0">
            <td colspan="5" class="table-empty">{{ t('accountUi.empty') }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <p class="muted account-hint">
      {{ t('accountUi.rules', { chars: USERNAME_FORBIDDEN_CHARACTERS, min: PASSWORD_MIN_LENGTH, max: MAX_USER_ACCOUNTS }) }}
    </p>
  </section>
</template>

<style scoped>
.account-hint {
  font-size: 11.5px;
}

.sub-title {
  margin: 0 0 var(--space-2);
  font-size: 13px;
  font-weight: 600;
}

.account-badge {
  margin-left: 6px;
}

.editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-subtle);
  margin: var(--space-3) 0;
}

.editor--row {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  margin: 0;
}

.row-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}

/* 权限复选框：两列网格。每一项是"名字 + 它管住什么"两行，所以两列比三列好读。 */
.permissions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 16px;
}

.permissions__head {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.permissions__item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12.5px;
}

/* 权限名 + 它管住什么。两行而不是一行：范围那句话比名字长得多，
   挤在一行会把复选框推得七零八落。 */
.permissions__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.permissions__scope {
  color: var(--color-text-secondary);
  font-size: 11px;
  line-height: 1.35;
}
</style>
