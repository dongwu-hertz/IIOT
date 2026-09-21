<script setup lang="ts">
/**
 * 告警联动设置（录像 / 弹窗 / 提示 / 邮件）——业主 20260921 批重做版式。
 *
 * 三个版式要点：
 *   1. **总开关挪到标题行右侧**（一个 Switch：标题 + 开关同一行），拨动即保存；
 *   2. **动作区是一排小卡**（录像 / 弹窗 / 提示 / 邮件 / 频率上限，各 = 图标 + 名称 +
 *      迷你控件），五张紧凑排列、窄窗自动换行 —— 取代原来「每个动作一节、整幅宽表单」
 *      的大留白排法；
 *   3. 触发源健康度照实显示（0 帧是一个结论，不是装饰）。
 *
 * 数据与保存机制不变：整块的深拷贝草稿，只发 `alarmLinkage` 这一个键，
 * SMTP 口令仍由 `EmailSettingsSection.vue` 提交（它是设置里唯一的只写字段）。
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

/**
 * 标题行那颗总开关：拨动即保存。
 *
 * 它不再只是草稿状态 —— 「启用联动」是这一页唯一的「改了就该立刻生效」的字段，
 * 让它挂在显式「保存」按钮后面，操作员会以为开关没反应。
 */
async function toggleEnabled(): Promise<void> {
  if (!canWrite.value) {
    formError.value = t('linkage.adminOnly')
    return
  }
  draft.enabled = !draft.enabled
  await save()
}

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
  <section class="card linkage-panel" data-section="alarm-linkage">
    <!--
      标题行 = 标题 + 总开关（业主 20260921 批）。开关在最右，拨动即保存；
      禁用态（非管理员）照实灰掉 —— 与这一页其它控件同一套权限口径。
    -->
    <div class="section-header">
      <h3 class="section-title">{{ t('linkage.title') }}</h3>
      <button
        type="button"
        class="switch"
        :class="{ 'switch--on': draft.enabled }"
        :aria-checked="draft.enabled"
        :disabled="!canWrite || saving"
        role="switch"
        data-linkage-enabled-switch
        @click="toggleEnabled"
      >
        <span class="switch__knob"></span>
        <span class="switch__text">
          {{ draft.enabled ? t('linkage.enabledOn') : t('linkage.enabledOff') }}
        </span>
      </button>
    </div>

    <p v-if="formError" class="alert alert--danger" role="alert">{{ formError }}</p>
    <p v-else-if="notice" class="alert alert--success" role="status">{{ notice }}</p>
    <p v-if="!canWrite" class="muted settings-hint">{{ t('linkage.adminOnly') }}</p>

    <!-- 触发源 -->
    <div class="linkage-block">
      <h4 class="sub-title">{{ t('linkage.sourceSection') }}</h4>
      <div class="form-grid source-grid">
        <label class="field">
          <span class="field-label">{{ t('linkage.pollInterval') }}</span>
          <input v-model.number="draft.pollIntervalSeconds" class="input" type="number" min="2" :disabled="!canWrite" />
        </label>
        <label class="field">
          <span class="field-label">{{ t('linkage.minAlarmLevel') }}</span>
          <input v-model.number="draft.minAlarmLevel" class="input" type="number" min="0" max="4" :disabled="!canWrite" />
        </label>
        <label class="field checkbox-field">
          <input v-model="draft.useDetectFeedback" type="checkbox" :disabled="!canWrite" />
          <span class="field-label">{{ t('linkage.useDetectFeedback') }}</span>
        </label>
      </div>

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
    </div>

    <!--
      动作区（业主 20260921 批）：一排**小卡** —— 每张 = 图标 + 名称 + 迷你控件，
      五张紧凑排列、可换行。卡片右上角的勾选是这一动作的**启用开关**，
      未勾选时卡内控件灰掉（动作不生效，参数仍保存在草稿里）。
    -->
    <div class="linkage-block">
      <h4 class="sub-title">{{ t('linkage.actionSection') }}</h4>
      <div class="action-cards">
        <!-- 录像 -->
        <div class="action-card" data-action-card="record" :class="{ 'action-card--off': !draft.actions.record }">
          <div class="action-card__head">
            <svg class="action-card__icon" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="1.5" y="4" width="9" height="8" rx="1.5" fill="none" stroke="currentColor" />
              <path d="M10.5 7 14.5 4.8v6.4L10.5 9z" fill="none" stroke="currentColor" stroke-linejoin="round" />
            </svg>
            <span class="action-card__name">{{ t('linkage.action.record') }}</span>
            <input v-model="draft.actions.record" type="checkbox" :disabled="!canWrite" data-action-enable="record" :aria-label="t('linkage.action.record')" />
          </div>
          <label class="field field--mini">
            <span class="field-label">{{ t('linkage.recordDuration') }}</span>
            <input v-model.number="draft.recording.durationSeconds" class="input" type="number" min="1" max="600" :disabled="!canWrite || !draft.actions.record" />
          </label>
          <label class="field field--mini">
            <span class="field-label">{{ t('linkage.recordCooldown') }}</span>
            <input v-model.number="draft.recording.cooldownSeconds" class="input" type="number" min="0" :disabled="!canWrite || !draft.actions.record" />
          </label>
          <label class="field field--mini checkbox-field">
            <input v-model="draft.recording.skipWhenBusy" type="checkbox" :disabled="!canWrite || !draft.actions.record" />
            <span class="field-label">{{ t('linkage.recordSkipBusy') }}</span>
          </label>
        </div>

        <!-- 弹窗 -->
        <div class="action-card" data-action-card="popup" :class="{ 'action-card--off': !draft.actions.popup }">
          <div class="action-card__head">
            <svg class="action-card__icon" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" />
              <path d="M1.5 5.5h13" stroke="currentColor" />
            </svg>
            <span class="action-card__name">{{ t('linkage.action.popup') }}</span>
            <input v-model="draft.actions.popup" type="checkbox" :disabled="!canWrite" data-action-enable="popup" :aria-label="t('linkage.action.popup')" />
          </div>
          <label class="field field--mini">
            <span class="field-label">{{ t('linkage.popupAutoDismiss') }}</span>
            <input v-model.number="draft.popup.autoDismissSeconds" class="input" type="number" min="0" max="600" :disabled="!canWrite || !draft.actions.popup" />
          </label>
          <label class="field field--mini">
            <span class="field-label">{{ t('linkage.popupCooldown') }}</span>
            <input v-model.number="draft.popup.cooldownSeconds" class="input" type="number" min="0" :disabled="!canWrite || !draft.actions.popup" />
          </label>
          <label class="field field--mini">
            <span class="field-label">{{ t('linkage.popupMaxStack') }}</span>
            <input v-model.number="draft.popup.maxStack" class="input" type="number" min="1" max="10" :disabled="!canWrite || !draft.actions.popup" />
          </label>
        </div>

        <!-- 提示 -->
        <div class="action-card" data-action-card="notice" :class="{ 'action-card--off': !draft.actions.notice }">
          <div class="action-card__head">
            <svg class="action-card__icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 1.8a4 4 0 0 0-4 4v2.4L2.8 10v1h10.4v-1L12 8.2V5.8a4 4 0 0 0-4-4z" fill="none" stroke="currentColor" stroke-linejoin="round" />
              <path d="M6.6 13a1.4 1.4 0 0 0 2.8 0" fill="none" stroke="currentColor" />
            </svg>
            <span class="action-card__name">{{ t('linkage.action.notice') }}</span>
            <input v-model="draft.actions.notice" type="checkbox" :disabled="!canWrite" data-action-enable="notice" :aria-label="t('linkage.action.notice')" />
          </div>
          <label class="field field--mini">
            <span class="field-label">{{ t('linkage.noticeCapacity') }}</span>
            <input v-model.number="draft.notices.pendingCapacity" class="input" type="number" min="10" max="1000" :disabled="!canWrite || !draft.actions.notice" />
          </label>
        </div>

        <!--
          邮件动作。邮件**服务器**配置（SMTP 主机 / 端口 / 发件人 / 收件人 / 测试邮件）
          在「集成 → 邮箱」那张卡里（`EmailSettingsSection.vue`）；这里保留的是
          **联动侧**的两个字段：附帧与冷却（它们是动作的属性，不是服务器的）。
        -->
        <div class="action-card" data-action-card="email" :class="{ 'action-card--off': !draft.actions.email }">
          <div class="action-card__head">
            <svg class="action-card__icon" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" fill="none" stroke="currentColor" />
              <path d="m2.5 4.5 5.5 4 5.5-4" fill="none" stroke="currentColor" stroke-linejoin="round" />
            </svg>
            <span class="action-card__name">{{ t('linkage.action.email') }}</span>
            <input v-model="draft.actions.email" type="checkbox" :disabled="!canWrite" data-action-enable="email" :aria-label="t('linkage.action.email')" />
          </div>
          <label class="field field--mini">
            <span class="field-label">{{ t('linkage.emailCooldown') }}</span>
            <input v-model.number="draft.email.cooldownSeconds" class="input" type="number" min="0" :disabled="!canWrite || !draft.actions.email" />
          </label>
          <label class="field field--mini checkbox-field">
            <input v-model="draft.email.attachFrame" type="checkbox" :disabled="!canWrite || !draft.actions.email" />
            <span class="field-label">{{ t('linkage.emailAttachFrame') }}</span>
          </label>
        </div>

        <!-- 频率上限 -->
        <div class="action-card" data-action-card="rate" data-action-card-always-on>
          <div class="action-card__head">
            <svg class="action-card__icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2.5 9.5a5.5 5.5 0 1 1 11 0" fill="none" stroke="currentColor" />
              <path d="M8 9.5 10.4 6" stroke="currentColor" stroke-linecap="round" />
              <path d="M2 12h12" stroke="currentColor" stroke-linecap="round" />
            </svg>
            <span class="action-card__name">{{ t('linkage.runtimeSection') }}</span>
          </div>
          <label class="field field--mini">
            <span class="field-label">{{ t('linkage.maxActionsPerMinute') }}</span>
            <input v-model.number="draft.runtime.maxActionsPerMinute" class="input" type="number" min="1" max="600" :disabled="!canWrite" />
          </label>
          <label class="field field--mini">
            <span class="field-label">{{ t('linkage.cooldownPeriod') }}</span>
            <input v-model.number="draft.runtime.cooldown.periodSeconds" class="input" type="number" min="0" :disabled="!canWrite" />
          </label>
          <label class="field field--mini">
            <span class="field-label">{{ t('linkage.cooldownPerPeriod') }}</span>
            <input v-model.number="draft.runtime.cooldown.perPeriod" class="input" type="number" min="1" :disabled="!canWrite" />
          </label>
          <label class="field field--mini">
            <span class="field-label">{{ t('linkage.cooldownPerInterface') }}</span>
            <input v-model.number="draft.runtime.cooldown.perInterface" class="input" type="number" min="1" :disabled="!canWrite" />
          </label>
        </div>
      </div>

      <p v-if="engineStatus" class="muted settings-hint">
        {{ t('linkage.windowUsage', { used: engineStatus.actionsThisWindow, limit: draft.runtime.maxActionsPerMinute }) }}
        · {{ t('linkage.statusTriggers', { count: engineStatus.triggers }) }}
        · {{ t('linkage.statusActions', { count: engineStatus.actions }) }}
      </p>
    </div>

    <div class="btn-row section-actions">
      <button type="button" class="btn" :disabled="!canWrite" @click="seedFromStore">
        {{ t('settingsUi.revert') }}
      </button>
      <button type="button" class="btn btn--primary" :disabled="saving || !canWrite" data-action="save-linkage" @click="save">
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
  margin: 0 0 var(--space-2);
  font-size: 12.5px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

/* 块与块之间一条细线，不再每块大留白。 */
.linkage-block {
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* 标题行开关（与声音绑定页同一套样式语言）。 */
.switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px 3px 3px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-bg);
  font-size: 11.5px;
  color: var(--color-text-secondary);
  font-family: inherit;
  cursor: pointer;
}

.switch:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.switch__knob {
  width: 28px;
  height: 16px;
  border-radius: 999px;
  background: var(--color-bg-subtle);
  border: 1px solid var(--color-border);
  position: relative;
  flex: none;
}

.switch__knob::after {
  content: '';
  position: absolute;
  top: 1px;
  left: 1px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--color-text-secondary);
  transition: left 0.15s ease, background 0.15s ease;
}

.switch--on {
  color: var(--color-accent-hover);
}

.switch--on .switch__knob {
  background: var(--color-accent-soft);
  border-color: var(--color-accent);
}

.switch--on .switch__knob::after {
  left: 13px;
  background: var(--color-accent);
}

.source-grid {
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
}

.checkbox-field {
  flex-direction: row;
  align-items: center;
  gap: 6px;
}

.source-kv {
  margin: 0;
}

.source-sep {
  margin: 0 4px;
  color: var(--color-border-strong);
}

/*
 * 动作小卡：一排紧凑卡片（业主 20260921 批）。五张一排、可换行；
 * 未启用的动作整卡降不透明 —— 参数还在，只是这一动作不生效。
 */
.action-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: var(--space-2);
}

.action-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border, rgba(0, 0, 0, 0.12));
  border-radius: 6px;
  background: var(--color-bg);
}

.action-card--off {
  opacity: 0.62;
}

.action-card__head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.action-card__icon {
  width: 16px;
  height: 16px;
  color: var(--color-text-secondary);
  flex: none;
}

.action-card__name {
  font-weight: 600;
  font-size: 12.5px;
  flex: 1;
}

/* 卡内迷你控件：标签与输入上下排，行距收紧。 */
.field--mini {
  gap: 2px;
}

.field--mini .field-label {
  font-size: 11.5px;
}

.text-ok {
  color: var(--color-success, #047857);
}

.section-actions {
  margin-top: 0;
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-border);
}
</style>

