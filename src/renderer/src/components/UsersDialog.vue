<script setup lang="ts">
/**
 * Account management (administrators only).
 *
 * The service's own rules are reflected in the controls rather than left to fail
 * after the click, because every one of them is a rule the user cannot see:
 *   - the account you are signed in with cannot be deleted (and its role cannot
 *     be changed, which the main process also refuses);
 *   - the last administrator cannot be removed or demoted — doing so would leave
 *     an installation nobody can administer, including nobody who can create
 *     another account.
 *
 * The main process re-checks all of these. A disabled control here is a courtesy,
 * not the enforcement.
 */
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { PASSWORD_MIN_LENGTH, USER_ROLES, type UserRole, type UserSummary } from '@shared/domain/auth'
import { useSessionStore } from '@renderer/stores/session'
import { passwordProblemKey } from '@renderer/lib/password'
import { formatDateTime } from '@renderer/lib/format'
import AppModal from '@renderer/components/AppModal.vue'

const props = defineProps<{ modelValue: boolean }>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
}>()

const { t } = useI18n()
const session = useSessionStore()

const open = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

interface CreateForm {
  username: string
  displayName: string
  role: UserRole
  password: string
}

function emptyCreate(): CreateForm {
  return { username: '', displayName: '', role: 'operator', password: '' }
}

const createOpen = ref(false)
const createForm = reactive<CreateForm>(emptyCreate())

/** Account whose password is being reset, by id. */
const resetForId = ref('')
const resetForm = reactive({ password: '', confirmPassword: '' })

/** Account whose deletion is being confirmed, by id. */
const confirmDeleteId = ref('')

const formError = ref('')
const notice = ref('')

const rows = computed(() => session.users)
/** Every account except the signed-in one; `usersUi.empty` is about those. */
const otherCount = computed(() => rows.value.filter((user: UserSummary) => !isSelf(user)).length)

function label(user: UserSummary): string {
  return user.displayName?.trim() || user.username
}

function lastLoginText(user: UserSummary): string {
  return user.lastLoginAt ? formatDateTime(user.lastLoginAt) : t('usersUi.neverLoggedIn')
}

function isSelf(user: UserSummary): boolean {
  return user.id === session.currentUserId
}

function isLastAdmin(user: UserSummary): boolean {
  return user.role === 'admin' && session.adminCount <= 1
}

function canDelete(user: UserSummary): boolean {
  return !isSelf(user) && !isLastAdmin(user)
}

function canChangeRole(user: UserSummary): boolean {
  // Self-demotion is refused by the service as well. Locking the control keeps
  // an administrator from demoting themselves by accident, which would look like
  // the app had thrown them out.
  return !isSelf(user) && !isLastAdmin(user)
}

/** Why a row's delete button is disabled, or '' when it is allowed. */
function deleteBlockReason(user: UserSummary): string {
  if (isSelf(user)) return t('usersUi.cannotDeleteSelf')
  if (isLastAdmin(user)) return t('errors.AUTH_LAST_ADMIN')
  return ''
}

function resetMessages(): void {
  formError.value = ''
  notice.value = ''
  session.clearError()
}

/**
 * Wipe every password field.
 *
 * Passwords live in reactive state only while a form is open; closing the dialog
 * must not leave one behind in memory for the rest of the session.
 */
function clearSecrets(): void {
  Object.assign(createForm, emptyCreate())
  resetForm.password = ''
  resetForm.confirmPassword = ''
}

function closeRowEditors(): void {
  createOpen.value = false
  resetForId.value = ''
  confirmDeleteId.value = ''
  clearSecrets()
}

watch(
  () => props.modelValue,
  (isOpen) => {
    resetMessages()
    closeRowEditors()
    if (isOpen) {
      // The list is re-read on every open: another window may have created or
      // deleted an account since this dialog was last shown.
      void session.loadUsers()
    }
  }
)

function toggleCreate(): void {
  resetMessages()
  confirmDeleteId.value = ''
  resetForId.value = ''
  createOpen.value = !createOpen.value
}

async function submitCreate(): Promise<void> {
  resetMessages()
  const username = createForm.username.trim()
  if (!username) {
    formError.value = t('authUi.errUsername')
    return
  }
  const problem = passwordProblemKey(createForm.password)
  if (problem) {
    formError.value = t(problem, { min: PASSWORD_MIN_LENGTH })
    return
  }

  const displayName = createForm.displayName.trim()
  const created = await session.createUser({
    username,
    role: createForm.role,
    password: createForm.password,
    // Omitted rather than sent empty: the service treats a missing display name
    // as "use the username".
    ...(displayName ? { displayName } : {})
  })
  if (!created) {
    formError.value = session.error || t('errors.fallback')
    return
  }
  closeRowEditors()
  notice.value = t('usersUi.created')
}

function startReset(user: UserSummary): void {
  resetMessages()
  confirmDeleteId.value = ''
  resetForId.value = resetForId.value === user.id ? '' : user.id
  resetForm.password = ''
  resetForm.confirmPassword = ''
}

async function submitReset(user: UserSummary): Promise<void> {
  resetMessages()
  const problem = passwordProblemKey(resetForm.password)
  if (problem) {
    formError.value = t(problem, { min: PASSWORD_MIN_LENGTH })
    return
  }
  if (resetForm.password !== resetForm.confirmPassword) {
    formError.value = t('authUi.errPasswordMismatch')
    return
  }

  const ok = await session.resetPassword({ userId: user.id, newPassword: resetForm.password })
  if (!ok) {
    formError.value = session.error || t('errors.fallback')
    return
  }
  resetForm.password = ''
  resetForm.confirmPassword = ''
  resetForId.value = ''
  notice.value = t('usersUi.resetDone')
}

async function onRoleChange(user: UserSummary, event: Event): Promise<void> {
  resetMessages()
  const select = event.target as HTMLSelectElement
  const role = select.value as UserRole
  if (role === user.role) return

  const ok = await session.setRole(user.id, role)
  if (!ok) {
    formError.value = session.error || t('errors.fallback')
    // The store keeps the role the main process still reports, so the bound
    // value does not change and Vue would leave the refused option selected.
    // Re-selecting the stored role is what makes the refusal visible.
    select.value = user.role
  }
}

function askDelete(user: UserSummary): void {
  resetMessages()
  resetForId.value = ''
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
}
</script>

<template>
  <AppModal v-model="open" :title="t('usersUi.title')" width="760px">
    <div class="users">
      <p v-if="formError" class="alert alert--danger" role="alert">{{ formError }}</p>
      <p v-if="notice" class="alert alert--success" role="status">{{ notice }}</p>

      <div class="users__toolbar">
        <button type="button" class="btn btn--sm" :disabled="session.busy" @click="toggleCreate">
          {{ t('usersUi.addUser') }}
        </button>
      </div>

      <!-- Create: revealed in place, so the list stays visible while a name is
           checked against the accounts already on screen. -->
      <form v-if="createOpen" class="users__create" @submit.prevent="submitCreate">
        <div class="form-grid">
          <label class="field">
            <span class="field-label">{{ t('usersUi.username') }}</span>
            <input
              v-model="createForm.username"
              data-autofocus
              class="input"
              type="text"
              autocomplete="off"
              spellcheck="false"
            />
          </label>
          <label class="field">
            <span class="field-label">{{ t('usersUi.displayName') }}</span>
            <input v-model="createForm.displayName" class="input" type="text" autocomplete="off" />
          </label>
          <label class="field">
            <span class="field-label">{{ t('usersUi.role') }}</span>
            <select v-model="createForm.role" class="select">
              <option v-for="role in USER_ROLES" :key="role" :value="role">
                {{ t(`domain.userRole.${role}`) }}
              </option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">{{ t('authUi.newPassword') }}</span>
            <input
              v-model="createForm.password"
              class="input"
              type="password"
              autocomplete="new-password"
            />
          </label>
        </div>
        <div class="btn-row">
          <button type="submit" class="btn btn--sm btn--primary" :disabled="session.busy">
            {{ session.busy ? t('usersUi.creating') : t('usersUi.create') }}
          </button>
          <button type="button" class="btn btn--sm" :disabled="session.busy" @click="toggleCreate">
            {{ t('common.cancel') }}
          </button>
        </div>
      </form>

      <table class="table users__table">
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
            <tr>
              <td class="mono">{{ user.username }}</td>
              <td>{{ label(user) }}</td>
              <td>
                <div class="users__role-cell">
                  <select
                    class="select"
                    :value="user.role"
                    :disabled="!canChangeRole(user) || session.busy"
                    :title="isLastAdmin(user) ? t('errors.AUTH_LAST_ADMIN') : undefined"
                    @change="onRoleChange(user, $event)"
                  >
                    <option v-for="role in USER_ROLES" :key="role" :value="role">
                      {{ t(`domain.userRole.${role}`) }}
                    </option>
                  </select>
                  <span v-if="user.mustChangePassword" class="badge badge--warning">
                    {{ t('usersUi.pendingPasswordChange') }}
                  </span>
                </div>
              </td>
              <td>{{ lastLoginText(user) }}</td>
              <td class="users__actions">
                <button
                  type="button"
                  class="btn btn--sm"
                  :disabled="session.busy"
                  @click="startReset(user)"
                >
                  {{ t('usersUi.resetPassword') }}
                </button>
                <button
                  type="button"
                  class="btn btn--sm btn--danger"
                  :disabled="session.busy || !canDelete(user)"
                  :title="deleteBlockReason(user)"
                  @click="askDelete(user)"
                >
                  {{ t('usersUi.deleteUser') }}
                </button>
              </td>
            </tr>

            <!-- Reset: inline, so the row being changed stays on screen. -->
            <tr v-if="resetForId === user.id">
              <td colspan="5">
                <div class="users__inline">
                  <span class="users__inline-title">
                    {{ t('usersUi.resetTitle', { name: label(user) }) }}
                  </span>
                  <div class="form-grid">
                    <label class="field">
                      <span class="field-label">{{ t('authUi.newPassword') }}</span>
                      <input
                        v-model="resetForm.password"
                        data-autofocus
                        class="input"
                        type="password"
                        autocomplete="new-password"
                      />
                    </label>
                    <label class="field">
                      <span class="field-label">{{ t('authUi.confirmPassword') }}</span>
                      <input
                        v-model="resetForm.confirmPassword"
                        class="input"
                        type="password"
                        autocomplete="new-password"
                      />
                    </label>
                  </div>
                  <div class="btn-row">
                    <button
                      type="button"
                      class="btn btn--sm btn--primary"
                      :disabled="session.busy"
                      @click="submitReset(user)"
                    >
                      {{ session.busy ? t('common.saving') : t('usersUi.resetSubmit') }}
                    </button>
                    <button
                      type="button"
                      class="btn btn--sm"
                      :disabled="session.busy"
                      @click="resetForId = ''"
                    >
                      {{ t('common.cancel') }}
                    </button>
                  </div>
                </div>
              </td>
            </tr>

            <!-- Deletion is destructive and irreversible: confirmed in the row. -->
            <tr v-if="confirmDeleteId === user.id">
              <td colspan="5">
                <div class="users__inline">
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
                    <button
                      type="button"
                      class="btn btn--sm"
                      :disabled="session.busy"
                      @click="confirmDeleteId = ''"
                    >
                      {{ t('common.cancel') }}
                    </button>
                  </div>
                </div>
              </td>
            </tr>
          </template>

          <tr v-if="otherCount === 0">
            <td colspan="5" class="table-empty">{{ t('usersUi.empty') }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <template #footer>
      <button type="button" class="btn" @click="open = false">{{ t('common.close') }}</button>
    </template>
  </AppModal>
</template>

<style scoped>
.users {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.users__toolbar {
  display: flex;
  justify-content: flex-end;
}

.users__create {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-subtle);
}

.users__table td,
.users__table th {
  vertical-align: middle;
}

.users__pending {
  margin-top: 4px;
}

/* The role select and the pending-password badge belong to the same account, so
   they stack inside one cell rather than reading as two columns. */
.users__role-cell {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}

.users__actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}

.users__inline {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-subtle);
  font-size: 12.5px;
}

.users__inline-title {
  font-weight: 600;
}
</style>
