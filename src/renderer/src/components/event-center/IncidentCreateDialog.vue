<script setup lang="ts">
/**
 * Incident 创建 / 关联对话框（规格 §14.2 的 V1，组件树里的 `IncidentCreateDialog`）。
 *
 * ---------------------------------------------------------------------------
 * 为什么一个对话框装两种动作
 * ---------------------------------------------------------------------------
 * 规格 §14.2 的 V1 是「人工 Create Incident + **手动关联** Alert」：对操作员来说这是同一件
 * 事的两种走向 —— 「这几条告警是一件新的事情」或者「它们属于我已经建过的那个事情」。
 * 分成两个对话框会让"我想把它们归到一起"这个念头要在两个入口里各找一次；而规格的组件
 * 清单里也只有这一个名字。
 *
 * 三件这一轮刻意**不做**的事（规格没要求、做了就是编）：
 *   1. **不自动替操作员勾选就没有别的选项**：候选清单是可勾选的，而且如实说明"这几条是按
 *      同一台设备找出来的"（§13.2 的原话是"不自动替用户关闭/合并"）；
 *   2. **没有 Incident 状态/严重度/负责人**：V1 只要标题与关联，规格没给 Incident 生命周期；
 *   3. **不关闭任何 Alert**：这个对话框只写"关联"，处置是抽屉头部那几个动作的事。
 *
 * 标题的初值是**建议**（设备名 + 「异常情况」），它来自 `incidentSuggestedTitleParams()`
 * 与一条目录键；操作员可以整句改掉。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AppModal from '@renderer/components/AppModal.vue'
import {
  INCIDENT_NOTE_MAX_LENGTH,
  INCIDENT_TITLE_MAX_LENGTH,
  validateIncidentDraft,
  type IncidentDraftReason,
  type IncidentView
} from '@shared/domain/incident'

/**
 * 对话框自己的校验原因。
 *
 * 前三个来自 `validateIncidentDraft()`（领域那份判据），后两个是**只有这个界面才知道**的
 * 事（"关联到已有"时选了哪一条、勾了几条）—— 它们不该被塞进领域类型里，那不是领域规则。
 */
type DialogReason = IncidentDraftReason | 'no-existing' | 'no-alerts'

/** 一个候选项：要关联的那条告警（id + 已经渲染好的文字）。 */
export interface IncidentCandidate {
  id: string
  label: string
}

const props = defineProps<{
  open: boolean
  /** 建议标题（`[Create Incident]` 带过来的初值）。 */
  suggestedTitle: string
  /** 建议一并关联的那几条（同一台设备上找出来的），默认全勾。 */
  candidates: IncidentCandidate[]
  /** 库里已有的 Incident（「关联到已有」的选择器）。 */
  existing: IncidentView[]
  /** 写操作进行中（按钮禁用 + 文案换成"正在…"）。 */
  busy: boolean
  /** 主进程给的失败原文（为空则不显示）。 */
  error: string
}>()

const emit = defineEmits<{
  (event: 'create', payload: { title: string; note?: string; entryIds: string[] }): void
  (event: 'link', payload: { incidentId: string; entryIds: string[] }): void
  (event: 'close'): void
}>()

const { t } = useI18n()

/** `create` = 新建；`link` = 关联到已有。 */
const mode = ref<'create' | 'link'>('create')
const title = ref('')
const note = ref('')
const titleTouched = ref(false)
const entryIds = ref<string[]>([])
const existingId = ref('')
/** 本地校验原因（提交之前就说清楚，不必等主进程拒绝）。 */
const localReason = ref<DialogReason | ''>('')

const canLinkExisting = computed(() => props.existing.length > 0)
const titleLimit = computed(() => INCIDENT_TITLE_MAX_LENGTH)
const noteLimit = computed(() => INCIDENT_NOTE_MAX_LENGTH)

/**
 * 打开时重置成干净的一副：建议标题填进去、候选全勾、模式回到"新建"。
 *
 * `titleTouched` 记住"操作员自己改过标题"：改过之后就不再用建议覆盖他写的东西
 * （数据可能在我们打开对话框之后才到达，那时覆盖等于把他刚打的字吞掉）。
 */
watch(
  () => props.open,
  (open) => {
    if (!open) return
    mode.value = 'create'
    title.value = props.suggestedTitle
    titleTouched.value = false
    note.value = ''
    entryIds.value = props.candidates.map((item) => item.id)
    existingId.value = props.existing[0]?.id ?? ''
    localReason.value = ''
  }
)

watch(
  () => props.suggestedTitle,
  (next) => {
    if (!props.open || titleTouched.value) return
    title.value = next
  }
)

watch(
  () => props.candidates,
  (next) => {
    if (!props.open) return
    // 候选变了（换了一条事件）：只有**没被操作员动过**时才重新全勾。
    if (!entryIds.value.length) entryIds.value = next.map((item) => item.id)
  }
)

/**
 * 原因 → 目录键。
 *
 * 显式一张表而不是拼 `incidentReason_${reason}`：目录键不允许带连字符（这个仓库的键都是
 * camelCase），拼出来的键在四个语言文件里都不存在 —— 那会在界面上显示一个裸键。
 */
const REASON_KEYS: Record<DialogReason, string> = {
  'title-required': 'eventsUi.incidentReasonTitleRequired',
  'title-too-long': 'eventsUi.incidentReasonTitleTooLong',
  'note-too-long': 'eventsUi.incidentReasonNoteTooLong',
  'no-existing': 'eventsUi.incidentReasonNoExisting',
  'no-alerts': 'eventsUi.incidentReasonNoAlerts'
}

const reasonText = computed(() => {
  const reason = localReason.value
  if (reason === '') return ''
  // 两条"太长"的 `{max}` 指的是**不同的**上限（标题 vs 备注），所以按原因选值再翻。
  const max = reason === 'note-too-long' ? INCIDENT_NOTE_MAX_LENGTH : INCIDENT_TITLE_MAX_LENGTH
  return t(REASON_KEYS[reason], { max })
})

function toggleEntry(id: string, checked: boolean): void {
  entryIds.value = checked
    ? [...new Set([...entryIds.value, id])]
    : entryIds.value.filter((item) => item !== id)
}

function submit(): void {
  if (props.busy) return
  if (mode.value === 'link') {
    if (existingId.value.trim() === '') {
      localReason.value = 'no-existing'
      return
    }
    if (entryIds.value.length === 0) {
      localReason.value = 'no-alerts'
      return
    }
    localReason.value = ''
    emit('link', { incidentId: existingId.value, entryIds: [...entryIds.value] })
    return
  }

  const checked = validateIncidentDraft({ title: title.value, note: note.value })
  if (!checked.ok) {
    localReason.value = checked.reason
    return
  }
  localReason.value = ''
  emit('create', {
    title: checked.draft.title,
    ...(checked.draft.note === undefined ? {} : { note: checked.draft.note }),
    entryIds: [...entryIds.value]
  })
}
</script>

<template>
  <AppModal
    :model-value="open"
    :title="t('eventsUi.incidentDialogTitle')"
    width="560px"
    @update:model-value="emit('close')"
  >
    <div class="incident-form">
      <!--
        两种走向：新建 / 关联到已有。用仓库里既有的 `btn` + `btn--primary` + `aria-pressed`
        那套（事件中心队列的三种视图模式就是这么写的），不新造一种分段控件。
      -->
      <div class="chip-row" role="group" :aria-label="t('eventsUi.incidentModeLabel')">
        <button
          type="button"
          class="btn btn--sm"
          :class="{ 'btn--primary': mode === 'create' }"
          :aria-pressed="mode === 'create'"
          data-incident-mode="create"
          @click="mode = 'create'"
        >
          {{ t('eventsUi.incidentModeCreate') }}
        </button>
        <button
          type="button"
          class="btn btn--sm"
          :class="{ 'btn--primary': mode === 'link' }"
          :aria-pressed="mode === 'link'"
          :disabled="!canLinkExisting"
          :title="canLinkExisting ? '' : t('eventsUi.incidentNoExisting')"
          data-incident-mode="link"
          @click="mode = 'link'"
        >
          {{ t('eventsUi.incidentModeLink') }}
        </button>
      </div>

      <template v-if="mode === 'create'">
        <label class="field">
          <span class="field-label">{{ t('eventsUi.incidentFieldTitle') }}</span>
          <input
            v-model="title"
            class="input"
            type="text"
            data-field="incident-title"
            data-autofocus
            :maxlength="titleLimit"
            :placeholder="t('eventsUi.incidentTitlePlaceholder')"
            @input="titleTouched = true"
          />
          <span class="muted field-hint">
            {{ t('eventsUi.incidentTitleHint', { max: titleLimit }) }}
          </span>
        </label>

        <label class="field">
          <span class="field-label">{{ t('eventsUi.incidentFieldNote') }}</span>
          <textarea
            v-model="note"
            class="input incident-form__note"
            rows="3"
            data-field="incident-note"
            :maxlength="noteLimit"
          ></textarea>
        </label>
      </template>

      <label v-else class="field">
        <span class="field-label">{{ t('eventsUi.incidentFieldExisting') }}</span>
        <select v-model="existingId" class="select" data-field="incident-existing">
          <option v-for="item in existing" :key="item.id" :value="item.id">
            {{ item.title }} · {{ t('eventsUi.incidentAlertCount', { count: item.alertCount }) }}
          </option>
        </select>
      </label>

      <!--
        候选清单：默认全勾（它们就是建议卡里那几条），但**可以逐条去掉** ——
        规格 §13.2 明说建议只是建议，不自动替操作员合并。
      -->
      <div class="field">
        <span class="field-label">
          {{ t('eventsUi.incidentCandidates', { count: candidates.length }) }}
        </span>
        <ul v-if="candidates.length > 0" class="incident-form__list" data-field="incident-candidates">
          <li v-for="item in candidates" :key="item.id" class="incident-form__candidate">
            <label class="incident-form__check">
              <input
                type="checkbox"
                :checked="entryIds.includes(item.id)"
                :value="item.id"
                data-field="incident-candidate"
                @change="toggleEntry(item.id, ($event.target as HTMLInputElement).checked)"
              />
              <span>{{ item.label }}</span>
            </label>
          </li>
        </ul>
        <p v-else class="muted">{{ t('eventsUi.incidentNoCandidates') }}</p>
      </div>

      <p v-if="reasonText" class="alert alert--warning" role="alert" data-incident-reason>
        {{ reasonText }}
      </p>
      <p v-if="error" class="alert alert--danger" role="alert" data-incident-error>
        {{ error }}
      </p>
    </div>

    <template #footer>
      <button type="button" class="btn" :disabled="busy" @click="emit('close')">
        {{ t('common.cancel') }}
      </button>
      <button
        type="button"
        class="btn btn--primary"
        :disabled="busy"
        data-action="incident-submit"
        @click="submit"
      >
        {{
          busy
            ? t('eventsUi.incidentSubmitting')
            : mode === 'create'
              ? t('eventsUi.incidentSubmitCreate')
              : t('eventsUi.incidentSubmitLink')
        }}
      </button>
    </template>
  </AppModal>
</template>

<style scoped>
.incident-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.incident-form__note {
  resize: vertical;
  min-height: 64px;
}

.incident-form__list {
  margin: var(--space-1) 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 180px;
  overflow-y: auto;
}

.incident-form__check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 12px;
  cursor: pointer;
}
</style>
