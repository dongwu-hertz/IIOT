<script setup lang="ts">
/**
 * 告警联动设置（录像 / 弹窗 / 提示 / 邮件）。
 *
 * ---------------------------------------------------------------------------
 * 为什么是独立组件而不是并进 `SettingsView.vue`
 * ---------------------------------------------------------------------------
 * 两件事各自都成立：
 *   1. 这一块有二十多个字段与它自己的草稿、校验、测试邮件流程，塞进设置页会
 *      让那个文件同时讲两件不相关的事；
 *   2. 保存走的是**同一个** `settings.update(patch)`，而且 patch 的形状是
 *      `Partial<AppSettings>`——所以只要它只发 `alarmLinkage` 这一个键，
 *      就绝不会覆盖设置页正在编辑的其它字段。
 *
 * ---------------------------------------------------------------------------
 * SMTP 口令
 * ---------------------------------------------------------------------------
 * 口令是设置结构里**唯一**的只写字段（`alarmLinkage.email.smtpPassword`）：
 * 它在同一次保存里提交，主进程会立刻把它交给 DPAPI/safeStorage 凭据库，
 * 然后从设置 JSON 里丢掉它。因此：
 *   - 输入框永远是空的，占位文字只说「留空表示不改」；
 *   - 页面显示的是「已保存口令 / 未保存口令」这个**主进程给出的事实**；
 *   - 要清除口令就填一个空格再保存（有空格的字符串是真值，不会被当成「没填」）。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AlarmLinkageConfig, AppSettingsPatch } from '@shared/ipc/contract'
import { DEFAULT_ALARM_LINKAGE_CONFIG } from '@shared/domain/alarm-linkage'
import { useSettingsStore } from '@renderer/stores/settings'
import { useAlarmLinkageStore } from '@renderer/stores/alarmLinkage'
import { useSessionStore } from '@renderer/stores/session'
import { formatDateTime } from '@renderer/lib/format'

const { t } = useI18n()
const settings = useSettingsStore()
/**
 * 引擎状态（触发源健康度、全局速率用量）。
 *
 * 命名为 `engine` 而不是 `linkage`：后者已经被上面那个**类型**
 * `AlarmLinkageConfig` 的领域名占住了语义，两个都叫 linkage 会让下面
 * `linkage.status` 这类访问变成对类型取属性——编译期就会报「不可调用」。
 * 这个 store 的订阅由 `AppShell` 常驻持有，这里只是一个读者。
 */
const engine = useAlarmLinkageStore()
const session = useSessionStore()

/**
 * 草稿：整块的深拷贝。
 *
 * 用默认值作为底再覆盖，是因为它保证「每一个子字段都有值」——手写一个字面量
 * 草稿对象的话，新增一个字段时界面会静默地发一个缺字段的 patch。
 *
 * 深拷贝用 JSON 往返而不是 `structuredClone`：这份结构按定义就是纯 JSON
 * （它就是设置表里那一格的内容），而 JSON 往返在任何运行环境里行为一致。
 */
function cloneLinkageDefaults(): AlarmLinkageConfig {
  return JSON.parse(JSON.stringify(DEFAULT_ALARM_LINKAGE_CONFIG)) as AlarmLinkageConfig
}

const draft = reactive<AlarmLinkageConfig>(cloneLinkageDefaults())

const saving = ref(false)
const formError = ref('')
const notice = ref('')

/** 只有管理员能改：与 `handlers.ts` 顶部的规则一致（写入要管理员）。 */
const canWrite = computed(() => session.isAdmin)

const engineStatus = computed(() => engine.status)

/** 用主进程返回的权威配置重建草稿。 */
function seedFromStore(): void {
  const current = settings.settings?.alarmLinkage
  if (!current) return
  const fresh = cloneLinkageDefaults()
  Object.assign(fresh, current)
  Object.assign(fresh.actions, current.actions)
  Object.assign(fresh.recording, current.recording)
  Object.assign(fresh.popup, current.popup)
  Object.assign(fresh.notices, current.notices)
  Object.assign(fresh.email, current.email)
  Object.assign(fresh.runtime, current.runtime)
  Object.assign(fresh.runtime.cooldown, current.runtime.cooldown)
  // `smtpPassword` 是只写字段：草稿里永远没有它（邮件那一页负责提交它）。
  delete fresh.email.smtpPassword
  Object.assign(draft, fresh)
  draft.email.smtpPassword = undefined
}

onMounted(async () => {
  await settings.load()
  seedFromStore()
  await engine.loadStatus()
})

async function save(): Promise<void> {
  if (!canWrite.value) {
    formError.value = t('linkage.adminOnly')
    return
  }
  saving.value = true
  formError.value = ''
  notice.value = ''

  /**
   * 只发 `alarmLinkage` 这一个键，而且**不发口令**。
   *
   * `AppSettingsPatch` 是 `Partial<AppSettings>`，主进程按键逐个校验；只带一个
   * 键就表示「其余设置一律不动」——这正是这个组件能与设置页、邮件页并存的原因。
   *
   * 口令由 `EmailSettingsSection.vue` 提交：它是设置里唯一的只写字段，而这个组件
   * 现在只编辑联动的两个邮件字段（附帧与冷却），没有口令输入框，把 `undefined`
   * 发出去也不表示"删除"（归一化器只认真正的字符串）。
   */
  const payload: AlarmLinkageConfig = {
    ...draft,
    actions: { ...draft.actions },
    recording: { ...draft.recording },
    popup: { ...draft.popup },
    notices: { ...draft.notices },
    runtime: { ...draft.runtime, cooldown: { ...draft.runtime.cooldown } },
    email: { ...draft.email }
  }
  delete payload.email.smtpPassword

  const saved = await settings.update({ alarmLinkage: payload } as AppSettingsPatch)
  saving.value = false
  if (!saved) {
    formError.value = settings.error || t('settingsUi.saveFailed')
    return
  }
  seedFromStore()
  notice.value = t('settingsUi.saveSuccess')
  await engine.loadStatus()
}

function formatTime(value: number | undefined): string {
  return value ? formatDateTime(value) : '—'
}
</script>

<template>
  <section class="card">
    <div class="section-header">
      <h3 class="section-title">{{ t('linkage.title') }}</h3>
    </div>

    <p v-if="formError" class="alert alert--danger" role="alert">{{ formError }}</p>
    <p v-else-if="notice" class="alert alert--success" role="status">{{ notice }}</p>
    <p v-if="!canWrite" class="muted settings-hint">{{ t('linkage.adminOnly') }}</p>

    <!-- 总开关 -->
    <label class="field checkbox-field">
      <input v-model="draft.enabled" type="checkbox" :disabled="!canWrite" />
      <span class="field-label">{{ t('linkage.enabled') }}</span>
    </label>

    <!-- 触发源 -->
    <h4 class="sub-title">{{ t('linkage.sourceSection') }}</h4>
    <div class="form-grid">
      <label class="field">
        <span class="field-label">{{ t('linkage.pollInterval') }}</span>
        <input v-model.number="draft.pollIntervalSeconds" class="input" type="number" min="2" :disabled="!canWrite" />
      </label>
      <label class="field">
        <span class="field-label">{{ t('linkage.minAlarmLevel') }}</span>
        <input v-model.number="draft.minAlarmLevel" class="input" type="number" min="0" max="4" :disabled="!canWrite" />
      </label>
    </div>
    <label class="field checkbox-field">
      <input v-model="draft.useDetectFeedback" type="checkbox" :disabled="!canWrite" />
      <span class="field-label">{{ t('linkage.useDetectFeedback') }}</span>
    </label>

    <!-- 触发源健康度：0 帧是一个结论，所以照实显示 -->
    <dl v-if="engineStatus" class="kv source-kv">
      <div v-for="source in engineStatus.sources" :key="source.kind" class="kv__item">
        <dt class="kv__label">
          {{ source.kind === 'poll' ? t('linkage.sourcePoll') : t('linkage.sourceWebsocket') }}
        </dt>
        <dd class="kv__value">
          <span :class="source.running ? 'text-ok' : 'muted'">
            {{ source.running ? t('linkage.sourceRunning') : t('linkage.sourceStopped') }}
          </span>
          <span class="source-sep">·</span>
          {{ t('linkage.sourceTriggers') }}: {{ source.triggers }}
          <template v-if="source.kind === 'websocket'">
            <span class="source-sep">·</span>
            {{ t('linkage.sourceFrames') }}: {{ source.frames }}
            <span v-if="source.frames === 0" class="muted">（{{ t('linkage.sourceNoFrames') }}）</span>
          </template>
          <template v-if="source.lastPollAt">
            <span class="source-sep">·</span>
            {{ t('linkage.sourceLastPoll') }}: {{ formatTime(source.lastPollAt) }}
          </template>
          <span v-if="source.lastError" class="text-danger">
            <span class="source-sep">·</span>{{ t('linkage.sourceLastError') }}: {{ source.lastError }}
          </span>
        </dd>
      </div>
    </dl>

    <!-- 动作开关 -->
    <h4 class="sub-title">{{ t('linkage.actionSection') }}</h4>
    <div class="form-grid action-grid">
      <label v-for="kind in (['record', 'popup', 'notice', 'email'] as const)" :key="kind" class="field checkbox-field">
        <input v-model="draft.actions[kind]" type="checkbox" :disabled="!canWrite" />
        <span class="field-label">{{ t(`linkage.action.${kind}`) }}</span>
      </label>
    </div>

    <!-- 录像 -->
    <h4 class="sub-title">{{ t('linkage.recordSection') }}</h4>
    <div class="form-grid">
      <label class="field">
        <span class="field-label">{{ t('linkage.recordDuration') }}</span>
        <input v-model.number="draft.recording.durationSeconds" class="input" type="number" min="1" max="600" :disabled="!canWrite" />
      </label>
      <label class="field">
        <span class="field-label">{{ t('linkage.recordCooldown') }}</span>
        <input v-model.number="draft.recording.cooldownSeconds" class="input" type="number" min="0" :disabled="!canWrite" />
      </label>
    </div>
    <label class="field checkbox-field">
      <input v-model="draft.recording.skipWhenBusy" type="checkbox" :disabled="!canWrite" />
      <span class="field-label">{{ t('linkage.recordSkipBusy') }}</span>
    </label>

    <!-- 弹窗 -->
    <h4 class="sub-title">{{ t('linkage.popupSection') }}</h4>
    <div class="form-grid">
      <label class="field">
        <span class="field-label">{{ t('linkage.popupAutoDismiss') }}</span>
        <input v-model.number="draft.popup.autoDismissSeconds" class="input" type="number" min="0" max="600" :disabled="!canWrite" />
      </label>
      <label class="field">
        <span class="field-label">{{ t('linkage.popupCooldown') }}</span>
        <input v-model.number="draft.popup.cooldownSeconds" class="input" type="number" min="0" :disabled="!canWrite" />
      </label>
      <label class="field">
        <span class="field-label">{{ t('linkage.popupMaxStack') }}</span>
        <input v-model.number="draft.popup.maxStack" class="input" type="number" min="1" max="10" :disabled="!canWrite" />
      </label>
    </div>

    <!-- 提示 -->
    <h4 class="sub-title">{{ t('linkage.noticeSection') }}</h4>
    <div class="form-grid">
      <label class="field">
        <span class="field-label">{{ t('linkage.noticeCapacity') }}</span>
        <input v-model.number="draft.notices.pendingCapacity" class="input" type="number" min="10" max="1000" :disabled="!canWrite" />
      </label>
    </div>

    <!--
      邮件**服务器**配置（SMTP 主机 / 端口 / 认证 / 发件人 / 收件人 / SSL / 测试邮件）
      已经搬到 `EmailSettingsSection.vue`，对应手册 §17.2.8 那一张独立的 Email 标签页。
      这里保留的是**联动侧**的两个字段：
        - `attachFrame`：告警邮件要不要附一张抓帧（这是联动动作的属性，不是邮件服务器的）；
        - 冷却时间：同一条规则的两次邮件之间的最小间隔（同上）。

      为什么不整块搬走：这一页讲的是「告警发生时做哪四个动作」，而「邮件服务器怎么配」
      是四个动作共用的传输层配置。手册把它们放在两张标签页里，代码里就放两个组件。
    -->
    <h4 class="sub-title">{{ t('linkage.emailActionSection') }}</h4>
    <div class="form-grid">
      <label class="field">
        <span class="field-label">{{ t('linkage.emailCooldown') }}</span>
        <input v-model.number="draft.email.cooldownSeconds" class="input" type="number" min="0" :disabled="!canWrite" />
      </label>
    </div>
    <label class="field checkbox-field">
      <input v-model="draft.email.attachFrame" type="checkbox" :disabled="!canWrite" />
      <span class="field-label">{{ t('linkage.emailAttachFrame') }}</span>
    </label>

    <!-- 频率上限 -->
    <h4 class="sub-title">{{ t('linkage.runtimeSection') }}</h4>
    <div class="form-grid">
      <label class="field">
        <span class="field-label">{{ t('linkage.maxActionsPerMinute') }}</span>
        <input v-model.number="draft.runtime.maxActionsPerMinute" class="input" type="number" min="1" max="600" :disabled="!canWrite" />
      </label>
      <label class="field">
        <span class="field-label">{{ t('linkage.cooldownPeriod') }}</span>
        <input v-model.number="draft.runtime.cooldown.periodSeconds" class="input" type="number" min="0" :disabled="!canWrite" />
      </label>
      <label class="field">
        <span class="field-label">{{ t('linkage.cooldownPerPeriod') }}</span>
        <input v-model.number="draft.runtime.cooldown.perPeriod" class="input" type="number" min="1" :disabled="!canWrite" />
      </label>
      <label class="field">
        <span class="field-label">{{ t('linkage.cooldownPerInterface') }}</span>
        <input v-model.number="draft.runtime.cooldown.perInterface" class="input" type="number" min="1" :disabled="!canWrite" />
      </label>
    </div>

    <p v-if="engineStatus" class="muted settings-hint">
      {{ t('linkage.windowUsage', { used: engineStatus.actionsThisWindow, limit: draft.runtime.maxActionsPerMinute }) }}
      · {{ t('linkage.statusTriggers', { count: engineStatus.triggers }) }}
      · {{ t('linkage.statusActions', { count: engineStatus.actions }) }}
    </p>

    <div class="btn-row section-actions">
      <button type="button" class="btn" :disabled="!canWrite" @click="seedFromStore">
        {{ t('settingsUi.revert') }}
      </button>
      <button type="button" class="btn btn--primary" :disabled="saving || !canWrite" @click="save">
        {{ saving ? t('common.saving') : t('settingsUi.saveButton') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.settings-hint {
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
  margin-top: var(--space-2);
}

.action-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.source-kv {
  margin-top: var(--space-2);
}

.source-sep {
  margin: 0 4px;
  color: var(--color-border-strong);
}

.test-row {
  display: flex;
  align-items: flex-end;
  gap: var(--space-3);
  margin-top: var(--space-3);
}

.text-ok {
  color: var(--color-success, #047857);
}

.smtp-detail {
  margin: 6px 0 0;
  max-height: 140px;
  overflow: auto;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
}

.section-actions {
  margin-top: var(--space-4);
}
</style>
