<script setup lang="ts">
/**
 * 邮件设置（手册 §17.2.8 Email Settings，p186）。
 *
 * ---------------------------------------------------------------------------
 * 它复用了什么（**没有第二套 SMTP 实现**）
 * ---------------------------------------------------------------------------
 *   - 发信：自研的 `SmtpClient`（`main/services/linkage/smtp-client.ts`，
 *     `node:net` + `node:tls`），经 `SmtpLinkageEmailSender` 使用；
 *   - 测试邮件：既有的 `LINKAGE_TEST_EMAIL` 通道 -> `AlarmLinkageService.testEmail()`
 *     —— 界面**不**自己拼 SMTP 会话；
 *   - 配置落库：既有的 `alarmLinkage.email`（`normaliseAlarmLinkageConfig`），
 *     这里只补手册要求而原来缺的字段与界面；
 *   - 口令：设置结构里唯一的**只写**字段 `email.smtpPassword`，主进程收到后立刻交给
 *     DPAPI/safeStorage 凭据库并从设置 JSON 里丢掉。界面永远读不到它，只能显示
 *     「已保存 / 未保存」这个由主进程给出的事实。
 *
 * ---------------------------------------------------------------------------
 * 逐字对照手册第 5462–5473 行
 * ---------------------------------------------------------------------------
 *   Server Authentication (Optional) -> `要求认证`勾选框（勾了才显示用户名/密码）
 *   SMTP Server                      -> `SMTP 服务器`
 *   Port (25 by default)             -> `端口`，默认 25
 *   User Name / Password             -> `用户名` / `密码`（可选认证下）
 *   Sender Address                   -> `发件人地址`
 *   Receiver 1 to 3 (up to 3)        -> **三个独立输入框**，第 3 个之后没有第 4 个
 *   Enable SSL                       -> `启用 SSL`
 *   Send Test Email                  -> `发送测试邮件`
 *
 * ---------------------------------------------------------------------------
 * 与手册的**一处偏离**（写在报告里，也写在这里）
 * ---------------------------------------------------------------------------
 * 手册把 SSL 写成一个勾选框。本工程的 SMTP 实现支持三种连接安全方式
 * （`none` / `ssl` / `starttls`），其中「SSL」= 一上来就握手的隐式 TLS（465 那种），
 * 与「先明文再升级」的 STARTTLS 是两件不同的事。所以界面给的是一个**显式三选一**
 * 的「连接安全」选择（无 / SSL / STARTTLS），默认 STARTTLS：
 *   - 勾选框无法表达「要 SSL 而不是 STARTTLS」，而这两者在真实服务器上互换会直接连不上；
 *   - 手册自己的字段名就是 Enable SSL，所以选项的文字就是 "SSL"，不是自造术语。
 * 默认端口 25 是手册明确要求的（第 5466 行），已改。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AlarmLinkageConfig, AppSettingsPatch, LinkageSmtpSecurity } from '@shared/ipc/contract'
import {
  DEFAULT_ALARM_LINKAGE_CONFIG,
  looksLikeEmailAddress,
  parseRecipientList
} from '@shared/domain/alarm-linkage'
import { useSettingsStore } from '@renderer/stores/settings'
import { useDevicesStore } from '@renderer/stores/devices'
import { useSessionStore } from '@renderer/stores/session'
import { resultMessage } from '@renderer/lib/result'

const { t } = useI18n()
const settings = useSettingsStore()
const devices = useDevicesStore()
const session = useSessionStore()

/** 手册第 5471 行：**最多三个**收件人。 */
const MAX_RECIPIENTS = 3

interface Draft {
  host: string
  port: number
  /** 可选认证（手册第 5462 行的 Server Authentication）。 */
  authentication: boolean
  username: string
  security: LinkageSmtpSecurity
  from: string
  /** 三个固定槽位；空串表示这一槽没有收件人。 */
  recipients: string[]
  subjectTemplate: string
  bodyTemplate: string
}

function emptyDraft(): Draft {
  const defaults = DEFAULT_ALARM_LINKAGE_CONFIG.email
  return {
    host: defaults.host,
    port: defaults.port,
    authentication: false,
    username: defaults.username,
    security: defaults.security,
    from: defaults.from,
    recipients: ['', '', ''],
    subjectTemplate: defaults.subjectTemplate,
    bodyTemplate: defaults.bodyTemplate
  }
}

const draft = reactive<Draft>(emptyDraft())

/** 口令输入框：永远是空的，只有用户真的输入了才有值。 */
const passwordInput = ref('')

const saving = ref(false)
const testing = ref(false)
const formError = ref('')
const notice = ref('')
const testNotice = ref('')
const testError = ref('')
const testDetail = ref('')

const canWrite = computed(() => session.isAdmin)
const passwordStored = computed(() => settings.settings?.alarmLinkage.email.smtpPasswordStored ?? false)

/**
 * 表单当前状态的 JSON 快照，挂在 `data-draft` 上给探针读。
 *
 * 为什么值得在正式代码里留一个 `data-*`：这一块有十来个字段、两个保存目标与一次
 * 真的 SMTP 交互，而「填进去了没有」与「Vue 状态改到了没有」是两个不同的事实。
 * 探针只能读 DOM 的话，一次「发件人地址格式不正确」既可能是校验写错，也可能是
 * 探针没把值送进 `v-model` —— 这一轮两种都真的发生过，而区分它们只值这一个属性。
 * 它不含任何秘密（口令输入框的值不在里面）。
 */
const draftSnapshot = computed(() =>
  JSON.stringify({
    host: draft.host,
    port: draft.port,
    security: draft.security,
    authentication: draft.authentication,
    username: draft.username,
    from: draft.from,
    recipients: [...draft.recipients]
  })
)

/** 测试邮件的附件方式与目标相机（沿用联动那一轮已有的三种选择）。 */
const testAttachment = ref<'none' | 'synthetic' | 'camera'>('synthetic')
const testDeviceId = ref('')

const cameras = computed(() => devices.devices.filter((device) => device.kind === 'acousticCamera'))

/**
 * 连接安全的三个选项。
 *
 * ⚠ **取值是共享层的 `LinkageSmtpSecurity`**（`'none' | 'tls' | 'starttls'`）：
 * 手册的「Enable SSL」= 隐式 TLS = 共享枚举里的 `'tls'`，所以**选项的文字**写 SSL、
 * **选项的值**是 `'tls'`。不新增第四个枚举值：那会让同一件事有两个名字，
 * 而 `SmtpClient` 只认共享枚举里那三个。
 */
const securityOptions = computed(() => [
  { value: 'none' as const, label: t('emailUi.securityNone') },
  { value: 'tls' as const, label: t('emailUi.securitySsl') },
  { value: 'starttls' as const, label: t('emailUi.securityStarttls') }
])

const attachOptions = computed(() => [
  { value: 'none' as const, label: t('linkage.emailTestAttachNone') },
  { value: 'synthetic' as const, label: t('linkage.emailTestAttachSynthetic') },
  { value: 'camera' as const, label: t('linkage.emailTestAttachCamera') }
])

/** 把逗号分隔的收件人串铺进三个槽位。 */
function splitRecipients(value: string): string[] {
  const list = parseRecipientList(value)
  return [list[0] ?? '', list[1] ?? '', list[2] ?? '']
}

function seedFromStore(): void {
  const email = settings.settings?.alarmLinkage.email
  if (!email) return
  const fresh = emptyDraft()
  draft.host = email.host
  draft.port = email.port
  // 「要求认证」的判据是**有没有用户名**：手册说勾选之后才填用户名，所以一个填了
  // 用户名的配置一定勾过它。口令是否已存不进这个判据——换了主机却还没填新口令时
  // 勾选框也应该保持勾着。
  draft.authentication = email.username.trim() !== ''
  draft.username = email.username
  draft.security = email.security
  draft.from = email.from
  draft.recipients = splitRecipients(email.recipients)
  draft.subjectTemplate = email.subjectTemplate || fresh.subjectTemplate
  draft.bodyTemplate = email.bodyTemplate || fresh.bodyTemplate
  passwordInput.value = ''
}

onMounted(async () => {
  await settings.load()
  seedFromStore()
  await devices.load()
  if (cameras.value.length > 0) testDeviceId.value = cameras.value[0]?.id ?? ''
})

watch(() => settings.settings, seedFromStore)

function resetMessages(): void {
  formError.value = ''
  notice.value = ''
  settings.clearError()
}

/** 校验，返回第一条问题（`''` = 通过）。**提前**说，不让用户白点一次保存。 */
function validate(): string {
  if (draft.host.trim() === '') return t('emailUi.errHost')
  if (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535) {
    return t('emailUi.errPort')
  }
  if (draft.authentication && draft.username.trim() === '') return t('emailUi.errUsername')
  if (draft.from.trim() === '') return t('emailUi.errFrom')
  if (!looksLikeEmailAddress(draft.from)) return t('emailUi.errFromFormat')
  const filled = draft.recipients.map((item) => item.trim()).filter((item) => item !== '')
  if (filled.length === 0) return t('emailUi.errRecipients')
  if (filled.length > MAX_RECIPIENTS) return t('emailUi.errTooManyRecipients', { max: MAX_RECIPIENTS })
  const bad = filled.find((item) => !looksLikeEmailAddress(item))
  if (bad) return t('emailUi.errRecipientFormat', { value: bad })
  return ''
}

/** 收件人串：三个槽位按顺序拼起来，空的丢掉。 */
function recipientsValue(): string {
  return draft.recipients
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .join(', ')
}

async function save(): Promise<void> {
  resetMessages()
  if (!canWrite.value) {
    formError.value = t('linkage.adminOnly')
    return
  }
  const problem = validate()
  if (problem) {
    formError.value = problem
    return
  }
  const current = settings.settings?.alarmLinkage
  if (!current) {
    formError.value = t('settingsUi.loadFailedTitle')
    return
  }

  saving.value = true
  /**
   * 只发 `alarmLinkage` 这一个键（与联动那一页同一形状），邮件之外的部分原样保留。
   *
   * 口令是唯一的只写字段：用户填了才提交；留空 = 不改（**不是**删除）。
   * 删除要显式点「清除已保存的口令」，那时提交的是空字符串。
   */
  const payload: AlarmLinkageConfig = {
    ...current,
    actions: { ...current.actions },
    recording: { ...current.recording },
    popup: { ...current.popup },
    notices: { ...current.notices },
    runtime: { ...current.runtime, cooldown: { ...current.runtime.cooldown } },
    email: {
      ...current.email,
      host: draft.host.trim(),
      port: draft.port,
      security: draft.security,
      username: draft.authentication ? draft.username.trim() : '',
      from: draft.from.trim(),
      recipients: recipientsValue(),
      subjectTemplate: draft.subjectTemplate,
      bodyTemplate: draft.bodyTemplate
    }
  }
  delete payload.email.smtpPassword
  if (passwordInput.value !== '') payload.email.smtpPassword = passwordInput.value

  const saved = await settings.update({ alarmLinkage: payload } as AppSettingsPatch)
  saving.value = false
  if (!saved) {
    formError.value = settings.error || t('settingsUi.saveFailed')
    return
  }
  const touchedPassword = passwordInput.value !== ''
  seedFromStore()
  notice.value = touchedPassword ? t('emailUi.saveSuccessWithPassword') : t('settingsUi.saveSuccess')
}

/** 显式清除凭据库里那条口令（提交一个空字符串）。 */
async function clearPassword(): Promise<void> {
  resetMessages()
  if (!canWrite.value) {
    formError.value = t('linkage.adminOnly')
    return
  }
  const current = settings.settings?.alarmLinkage
  if (!current) {
    formError.value = t('settingsUi.loadFailedTitle')
    return
  }
  saving.value = true
  const payload: AlarmLinkageConfig = {
    ...current,
    runtime: { ...current.runtime, cooldown: { ...current.runtime.cooldown } },
    email: { ...current.email, smtpPassword: '' }
  }
  const saved = await settings.update({ alarmLinkage: payload } as AppSettingsPatch)
  saving.value = false
  if (!saved) {
    formError.value = settings.error || t('settingsUi.saveFailed')
    return
  }
  seedFromStore()
  notice.value = t('emailUi.passwordCleared')
}

/**
 * 发送测试邮件（手册第 5473 行）。
 *
 * 走既有的 `LINKAGE_TEST_EMAIL` 通道 -> `AlarmLinkageService.testEmail()`，
 * 因此**界面不接触 SMTP**：连接、认证、TLS 升级、信封、附件编码全在主进程里，
 * 界面拿回来的是 SMTP 服务器自己说的话（成功几个收件人 / 失败原因 + transcript）。
 *
 * 收件人用的是**当前草稿**（还没保存的那一份），这样"先测一次再保存"是可能的 ——
 * 手册的步骤顺序（第 4 步测试、第 6 步保存）就是如此。
 */
async function sendTest(): Promise<void> {
  resetMessages()
  if (!canWrite.value) {
    formError.value = t('linkage.adminOnly')
    return
  }
  const problem = validate()
  if (problem) {
    formError.value = problem
    return
  }
  testing.value = true
  const result = await window.api.linkage.testEmail({
    host: draft.host.trim(),
    port: draft.port,
    security: draft.security,
    username: draft.authentication ? draft.username.trim() : '',
    // 留空 -> 用已保存的口令（主进程决定，界面拿不到它）。
    ...(passwordInput.value !== '' ? { password: passwordInput.value } : {}),
    from: draft.from.trim(),
    recipients: recipientsValue(),
    subject: draft.subjectTemplate || t('linkage.title'),
    body: draft.bodyTemplate || t('linkage.emailTestPrompt'),
    attach: testAttachment.value,
    ...(testAttachment.value === 'camera' && testDeviceId.value !== ''
      ? { deviceId: testDeviceId.value }
      : {})
  })
  testing.value = false

  if (!result.success) {
    testError.value = resultMessage(result) || t('emailUi.testFailed')
    return
  }
  const value = result.data
  if (!value) {
    testError.value = t('linkage.loadFailed')
    return
  }
  if (value.ok) {
    testNotice.value = t('linkage.emailTestOk', {
      count: parseRecipientList(recipientsValue()).length
    })
    return
  }
  // 失败时把 SMTP 自己的话原样带出来：一句「发送失败」对排查毫无帮助。
  testError.value = t('linkage.emailTestFailed', { reason: value.error ?? '' })
  testDetail.value = value.detail ?? value.transcript.slice(-4).join('\n')
}
</script>

<template>
  <section class="card" data-section="email-settings">
    <div class="section-header">
      <h3 class="section-title">{{ t('emailUi.title') }}</h3>
      <!--
        探针用的状态快照（`data-draft` 是 JSON）。
        没有它，「发送测试邮件失败」这件事只能靠猜 —— 一次探针跑掉一次实测机会，
        而"DOM 里是 A、Vue 状态里是 B"正是这轮踩过的那个坑。
      -->
      <span class="visually-hidden" :data-draft="draftSnapshot" aria-hidden="true"></span>
      <div class="btn-row">
        <button type="button" class="btn btn--sm" :disabled="!canWrite || saving" @click="seedFromStore">
          {{ t('settingsUi.revert') }}
        </button>
        <button
          type="button"
          class="btn btn--sm btn--primary"
          :disabled="!canWrite || saving"
          data-action="save-email"
          @click="save"
        >
          {{ saving ? t('common.saving') : t('settingsUi.saveButton') }}
        </button>
      </div>
    </div>

    <p v-if="formError" class="alert alert--danger" role="alert">{{ formError }}</p>
    <p v-else-if="notice" class="alert alert--success" role="status">{{ notice }}</p>
    <p v-if="!canWrite" class="muted email-hint">{{ t('linkage.adminOnly') }}</p>

    <div class="form-grid">
      <label class="field">
        <span class="field-label">{{ t('emailUi.host') }}</span>
        <input
          v-model="draft.host"
          class="input"
          type="text"
          spellcheck="false"
          data-field="smtp-host"
          :placeholder="t('linkage.emailHostPlaceholder')"
          :disabled="!canWrite"
        />
      </label>
      <label class="field">
        <span class="field-label">{{ t('emailUi.port') }}</span>
        <input
          v-model.number="draft.port"
          class="input"
          type="number"
          min="1"
          max="65535"
          data-field="smtp-port"
          :disabled="!canWrite"
        />
        <span class="field-hint">{{ t('emailUi.portHint') }}</span>
      </label>
      <label class="field">
        <span class="field-label">{{ t('emailUi.security') }}</span>
        <select v-model="draft.security" class="input" data-field="smtp-security" :disabled="!canWrite">
          <option v-for="option in securityOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>
      <label class="field">
        <span class="field-label">{{ t('emailUi.from') }}</span>
        <input
          v-model="draft.from"
          class="input"
          type="text"
          spellcheck="false"
          data-field="smtp-from"
          :disabled="!canWrite"
        />
      </label>
    </div>

    <!-- Server Authentication (Optional)：勾了才显示用户名与口令。 -->
    <label class="field checkbox-field">
      <input
        v-model="draft.authentication"
        type="checkbox"
        data-field="smtp-authentication"
        :disabled="!canWrite"
      />
      <span class="field-label">{{ t('emailUi.authentication') }}</span>
    </label>

    <div v-if="draft.authentication" class="form-grid auth-grid">
      <label class="field">
        <span class="field-label">{{ t('emailUi.username') }}</span>
        <input
          v-model="draft.username"
          class="input"
          type="text"
          spellcheck="false"
          autocomplete="off"
          data-field="smtp-username"
          :disabled="!canWrite"
        />
      </label>
      <label class="field">
        <span class="field-label">{{ t('emailUi.password') }}</span>
        <input
          v-model="passwordInput"
          class="input"
          type="password"
          autocomplete="new-password"
          data-field="smtp-password"
          :placeholder="t('linkage.emailPasswordPlaceholder')"
          :disabled="!canWrite"
        />
        <span class="field-hint">
          {{ passwordStored ? t('linkage.emailPasswordStored') : t('linkage.emailPasswordNotStored') }}
          · {{ t('linkage.emailPasswordClearHint') }}
        </span>
      </label>
      <div class="field">
        <span class="field-label">{{ t('emailUi.passwordState') }}</span>
        <button
          type="button"
          class="btn btn--sm"
          data-action="clear-smtp-password"
          :disabled="!canWrite || !passwordStored || saving"
          @click="clearPassword"
        >
          {{ t('emailUi.clearPassword') }}
        </button>
      </div>
    </div>

    <!-- 收件人：手册第 5471 行的 Receiver 1 to 3，就是三个槽位 -->
    <h4 class="sub-title">{{ t('emailUi.receiversSection') }}</h4>
    <div class="form-grid">
      <label v-for="(_, index) in draft.recipients" :key="index" class="field">
        <span class="field-label">{{ t('emailUi.receiverN', { n: index + 1 }) }}</span>
        <input
          v-model="draft.recipients[index]"
          class="input"
          type="text"
          spellcheck="false"
          :data-field="`smtp-receiver-${index + 1}`"
          :disabled="!canWrite"
        />
      </label>
    </div>
    <p class="muted email-hint">{{ t('emailUi.receiversHint', { max: MAX_RECIPIENTS }) }}</p>

    <!-- 邮件内容模板（联动引擎用它渲染每一封告警邮件） -->
    <h4 class="sub-title">{{ t('emailUi.templateSection') }}</h4>
    <label class="field">
      <span class="field-label">{{ t('linkage.emailSubject') }}</span>
      <input
        v-model="draft.subjectTemplate"
        class="input"
        type="text"
        data-field="smtp-subject"
        :disabled="!canWrite"
      />
    </label>
    <label class="field">
      <span class="field-label">{{ t('linkage.emailBody') }}</span>
      <textarea
        v-model="draft.bodyTemplate"
        class="input"
        rows="3"
        data-field="smtp-body"
        :disabled="!canWrite"
      ></textarea>
    </label>

    <!-- 发送测试邮件（手册第 5473 行） -->
    <div class="test-row">
      <label class="field">
        <span class="field-label">{{ t('linkage.emailTestAttach') }}</span>
        <select v-model="testAttachment" class="input" :disabled="!canWrite">
          <option v-for="option in attachOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>
      <label v-if="testAttachment === 'camera'" class="field">
        <span class="field-label">RTSP</span>
        <select v-model="testDeviceId" class="input" :disabled="!canWrite">
          <option v-for="camera in cameras" :key="camera.id" :value="camera.id">{{ camera.name }}</option>
        </select>
      </label>
      <button
        type="button"
        class="btn"
        data-action="send-test-email"
        :disabled="testing || !canWrite"
        @click="sendTest"
      >
        {{ testing ? t('linkage.emailTesting') : t('emailUi.sendTest') }}
      </button>
    </div>
    <p v-if="testNotice" class="alert alert--success" role="status">{{ testNotice }}</p>
    <div v-if="testError" class="alert alert--danger" role="alert">
      <p>{{ testError }}</p>
      <pre v-if="testDetail" class="smtp-detail">{{ testDetail }}</pre>
    </div>
  </section>
</template>

<style scoped>
.email-hint {
  font-size: 11.5px;
}

.sub-title {
  margin: var(--space-4) 0 2px;
  font-size: 13px;
  font-weight: 600;
}

.checkbox-field {
  flex-direction: row;
  align-items: center;
  gap: 6px;
  margin-top: var(--space-3);
}

.auth-grid {
  margin-top: var(--space-2);
}

.test-row {
  display: flex;
  align-items: flex-end;
  gap: var(--space-3);
  margin-top: var(--space-3);
}

.smtp-detail {
  margin: 6px 0 0;
  max-height: 140px;
  overflow: auto;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
