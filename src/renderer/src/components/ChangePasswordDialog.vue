<script setup lang="ts">
/**
 * 「修改密码」对话框 —— 侧栏账户菜单与设置页「账号」页签用的是**同一个**组件。
 *
 * 为什么抽出来（业主 2026-09-17 的 ③「账号页签承接退出登录」）：
 * 同一个动作在两个地方各写一遍，迟早会在校验规则或"当前密码"处理上分叉 ——
 * 而这是密码流程，分叉的代价是"某一个入口允许设一个另一个入口拒绝的口令"。
 * 抽出来之后只有一处 `passwordProblemKey()`、一处 `session.changePassword()`。
 *
 * 两条既有行为原样保留（它们写在 `UserMenu` 里时就有，不是这次新加的）：
 *   1. 关闭对话框时**清空三个输入框**：一个凭据不该留在侧栏背后的内存里；
 *   2. 改密成功后表单换成一句成功提示（`changed`），而不是留在原表单上让人再点一次。
 */
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSessionStore } from '@renderer/stores/session'
import { PASSWORD_MIN_LENGTH } from '@shared/domain/auth'
import { passwordProblemKey } from '@renderer/lib/password'
import AppModal from '@renderer/components/AppModal.vue'

const open = defineModel<boolean>({ required: true })

const { t } = useI18n()
const session = useSessionStore()

const formError = ref('')
/** 口令已经换掉了：对话框改为报告结果，而不是继续给一张表单。 */
const changed = ref(false)
const form = reactive({ currentPassword: '', newPassword: '', confirmPassword: '' })

watch(open, (isOpen) => {
  if (isOpen) {
    formError.value = ''
    changed.value = false
    return
  }
  form.currentPassword = ''
  form.newPassword = ''
  form.confirmPassword = ''
  formError.value = ''
  changed.value = false
})

const busy = computed(() => session.busy)

async function submit(): Promise<void> {
  formError.value = ''
  if (!form.currentPassword) {
    formError.value = t('authUi.errCurrentPassword')
    return
  }
  const problem = passwordProblemKey(form.newPassword)
  if (problem) {
    formError.value = t(problem, { min: PASSWORD_MIN_LENGTH })
    return
  }
  if (form.newPassword !== form.confirmPassword) {
    formError.value = t('authUi.errPasswordMismatch')
    return
  }

  const ok = await session.changePassword({
    currentPassword: form.currentPassword,
    newPassword: form.newPassword
  })
  if (!ok) {
    formError.value = session.error || t('errors.fallback')
    return
  }
  form.currentPassword = ''
  form.newPassword = ''
  form.confirmPassword = ''
  changed.value = true
}
</script>

<template>
  <AppModal v-model="open" :title="t('authUi.changeTitle')" width="420px">
    <div class="change-password">
      <p v-if="changed" class="alert alert--success" role="status">
        {{ t('authUi.changeSuccess') }}
      </p>
      <template v-else>
        <label class="field">
          <span class="field-label">{{ t('authUi.currentPassword') }}</span>
          <input
            v-model="form.currentPassword"
            data-autofocus
            class="input"
            type="password"
            autocomplete="current-password"
          />
        </label>
        <label class="field">
          <span class="field-label">{{ t('authUi.newPassword') }}</span>
          <input
            v-model="form.newPassword"
            class="input"
            type="password"
            autocomplete="new-password"
          />
        </label>
        <label class="field">
          <span class="field-label">{{ t('authUi.confirmPassword') }}</span>
          <input
            v-model="form.confirmPassword"
            class="input"
            type="password"
            autocomplete="new-password"
          />
        </label>
        <p v-if="formError" class="alert alert--danger" role="alert">{{ formError }}</p>
      </template>
    </div>

    <template #footer>
      <button type="button" class="btn" :disabled="busy" @click="open = false">
        {{ changed ? t('common.close') : t('common.cancel') }}
      </button>
      <button
        v-if="!changed"
        type="button"
        class="btn btn--primary"
        :disabled="busy"
        @click="submit"
      >
        {{ busy ? t('authUi.changing') : t('authUi.changeSubmit') }}
      </button>
    </template>
  </AppModal>
</template>

<style scoped>
.change-password {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
</style>
