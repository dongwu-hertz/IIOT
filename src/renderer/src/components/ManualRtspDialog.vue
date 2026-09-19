<script setup lang="ts">
/**
 * 手填 RTSP 地址（业主 2026-09-19 第 3 条：「② 能手填一个 RTSP 地址给第三方相机」）。
 *
 * ---------------------------------------------------------------------------
 * 为什么是一个独立对话框，而不是并进相机选择器
 * ---------------------------------------------------------------------------
 * 相机选择器（`CameraCellPicker`）回答的是"放**哪一台**相机进来"，它的候选项来自设备表；
 * 而这里要做的是**新建一个本机并不认识的源**（名称 + 地址 + 改 + 删），是一个有表单、
 * 有校验、有列表的界面。并进选择器会让那个"只画候选项"的浮层长出表单与 CRUD ——
 * 它的文件头明确写着"一个字的业务判断都没有"，那条纪律值得留着。
 *
 * 入口有两条，都指向这里：墙的工具条（「手填 RTSP 地址…」）与选择器列表末尾那一项。
 *
 * ---------------------------------------------------------------------------
 * 三条口径（手册未说明，所以写在界面上）
 * ---------------------------------------------------------------------------
 *   1. **不校验可达性**：只判地址形状。连不上（端口不通、路径不对、要认证）时这一格会显示
 *      ffmpeg 的原文 —— 那是唯一能回答"为什么连不上"的地方；
 *   2. **只在本次运行内有效**：手填地址常常含口令（`rtsp://user:pass@host/…`），写进
 *      localStorage 就是一份明文凭据。它与画面格分配一样只在内存里；
 *   3. **它没有"设备离线"这个概念**：它连设备都不是，状态只来自本机那一路会话。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  MANUAL_RTSP_ID_BYTES,
  MAX_MANUAL_RTSP_SOURCES,
  defaultManualRtspName,
  manualRtspIdFromBytes,
  maskRtspUrl,
  parseManualRtspUrl,
  type ManualRtspSource,
  type ManualRtspUrlIssue
} from '@shared/domain/rtsp-source'
import { useCameraWallStore } from '@renderer/stores/liveWall'
import AppModal from '@renderer/components/AppModal.vue'

const props = defineProps<{
  modelValue: boolean
  /** 保存之后放进哪一格（当前格）；越界时由 store 拒绝，界面仍然显示列表。 */
  targetSlot: number
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  /** 新增或改完之后：调用方要把这一格重启一次（旧地址的 ffmpeg 还在跑）。 */
  (event: 'applied', slot: number): void
  /** 删掉之后：调用方要把那一路**会话停掉**（它还在读那个地址），并把清空的格收拾干净。 */
  (event: 'removed', id: string, slots: number[]): void
}>()

const { t } = useI18n()
const wall = useCameraWallStore()

const open = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

/** 正在编辑的那一条 id；`null` = 新增。 */
const editingId = ref<string | null>(null)
const nameDraft = ref('')
const urlDraft = ref('')
const errorText = ref('')

function resetForm(): void {
  editingId.value = null
  nameDraft.value = ''
  urlDraft.value = ''
  errorText.value = ''
}

watch(
  () => props.modelValue,
  (isOpen) => {
    if (!isOpen) resetForm()
  }
)

/** 地址问题的可读文案键（形状问题在**输入的那一刻**就说清楚，不等 ffmpeg 超时）。 */
const ISSUE_KEYS: Record<ManualRtspUrlIssue, string> = {
  empty: 'manualIssueEmpty',
  'too-long': 'manualIssueTooLong',
  'bad-scheme': 'manualIssueScheme',
  'missing-host': 'manualIssueHost',
  whitespace: 'manualIssueWhitespace',
  'control-character': 'manualIssueControl',
  'bad-port': 'manualIssuePort'
}

const atCapacity = computed(() => wall.manualSources.length >= MAX_MANUAL_RTSP_SOURCES)

function startEdit(source: ManualRtspSource): void {
  editingId.value = source.id
  nameDraft.value = source.name
  urlDraft.value = source.url
  errorText.value = ''
}

/** 哪几条手填源此刻占着哪一格（列表里要说出来，删之前才知道会清掉什么）。 */
function slotsOf(id: string): number[] {
  return wall.model.slots
    .map((slot, index) => (slot === id ? index : -1))
    .filter((index) => index >= 0)
}

function submit(): void {
  const parsed = parseManualRtspUrl(urlDraft.value)
  if (!parsed.ok) {
    errorText.value = t(`cameraWallUi.${ISSUE_KEYS[parsed.issue as ManualRtspUrlIssue]}`)
    return
  }
  const name = nameDraft.value.trim() || defaultManualRtspName(parsed.url)

  if (editingId.value !== null) {
    const ok = wall.updateManualSource(editingId.value, { name, url: parsed.url })
    if (!ok) {
      errorText.value = t('cameraWallUi.manualIssueScheme')
      return
    }
    const id = editingId.value
    resetForm()
    // 已经占着格的那几条：把那些格重启一次（旧地址的 ffmpeg 还在读旧地址）。
    const slots = slotsOf(id)
    for (const slot of slots) emit('applied', slot)
    return
  }

  const id = manualRtspIdFromBytes(
    crypto.getRandomValues(new Uint8Array(MANUAL_RTSP_ID_BYTES))
  )
  wall.addManualSource({ id, name, url: parsed.url })
  // 顺手放进**当前格**：手填地址的唯一目的就是把它显示出来，多要一次点击没有意义。
  const placed = wall.placeDevice(props.targetSlot, id)
  resetForm()
  if (placed.ok) emit('applied', props.targetSlot)
}

function place(source: ManualRtspSource): void {
  const placed = wall.placeDevice(props.targetSlot, source.id)
  if (placed.ok) emit('applied', props.targetSlot)
}

function remove(source: ManualRtspSource): void {
  const result = wall.removeManualSource(source.id)
  if (editingId.value === source.id) resetForm()
  if (result.clearedSlots.length > 0) emit('removed', source.id, result.clearedSlots)
}
</script>

<template>
  <AppModal v-model="open" :title="t('cameraWallUi.manualTitle')" width="620px">
    <div class="manual" data-manual-rtsp-dialog>
      <!-- 三条口径写在界面上：手册没有这一节，所以哪些是我们定的必须说清楚。 -->
      <p class="field-hint">{{ t('cameraWallUi.manualNote') }}</p>

      <div class="manual__form">
        <label class="field">
          <span class="field-label">{{ t('cameraWallUi.manualName') }}</span>
          <input
            v-model="nameDraft"
            class="input"
            type="text"
            data-manual-rtsp-name
            :placeholder="t('cameraWallUi.manualNameHint')"
          />
        </label>

        <label class="field">
          <span class="field-label">{{ t('cameraWallUi.manualUrl') }}</span>
          <input
            v-model="urlDraft"
            class="input mono"
            type="text"
            spellcheck="false"
            autocomplete="off"
            data-manual-rtsp-url
            :placeholder="t('cameraWallUi.manualUrlPlaceholder')"
          />
        </label>

        <div class="btn-row">
          <button
            type="button"
            class="btn btn--primary btn--sm"
            data-action="manual-rtsp-save"
            :disabled="atCapacity && editingId === null"
            @click="submit"
          >
            {{
              editingId === null
                ? t('cameraWallUi.manualSave')
                : t('cameraWallUi.manualUpdate')
            }}
          </button>
          <button
            v-if="editingId !== null"
            type="button"
            class="btn btn--sm"
            data-action="manual-rtsp-cancel-edit"
            @click="resetForm"
          >
            {{ t('common.cancel') }}
          </button>
        </div>
      </div>

      <p v-if="errorText" class="alert alert--danger" role="alert" data-manual-rtsp-error>
        {{ errorText }}
      </p>
      <p v-if="atCapacity && editingId === null" class="alert alert--warning" role="note">
        {{ t('cameraWallUi.manualAtCapacity', { max: MAX_MANUAL_RTSP_SOURCES }) }}
      </p>

      <div class="manual__list">
        <span class="settings-group__title">{{ t('cameraWallUi.manualList') }}</span>
        <p v-if="wall.manualSources.length === 0" class="field-hint" data-manual-rtsp-empty>
          {{ t('cameraWallUi.manualEmpty') }}
        </p>
        <div
          v-for="source in wall.manualSources"
          :key="source.id"
          class="manual__row"
          data-manual-rtsp-row
          :data-manual-rtsp-id="source.id"
        >
          <span class="manual__name">{{ source.name }}</span>
          <code class="manual__url mono">{{ maskRtspUrl(source.url) }}</code>
          <span v-if="slotsOf(source.id).length > 0" class="field-hint">
            {{
              t('cameraWallUi.manualInSlot', {
                slots: slotsOf(source.id)
                  .map((index) => index + 1)
                  .join(', ')
              })
            }}
          </span>
          <div class="btn-row">
            <button
              type="button"
              class="btn btn--sm"
              data-action="manual-rtsp-place"
              @click="place(source)"
            >
              {{ t('cameraWallUi.manualPlace') }}
            </button>
            <button
              type="button"
              class="btn btn--sm"
              data-action="manual-rtsp-edit"
              @click="startEdit(source)"
            >
              {{ t('cameraWallUi.manualEdit') }}
            </button>
            <button
              type="button"
              class="btn btn--sm btn--danger"
              data-action="manual-rtsp-remove"
              @click="remove(source)"
            >
              {{ t('cameraWallUi.manualDelete') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </AppModal>
</template>

<style scoped>
.manual {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.manual__form {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}

.manual__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  border-top: 1px solid var(--color-border);
  padding-top: var(--space-3);
}

/* 一条手填源：名字 + 打码地址 + 三个动作。地址允许折断（很长）。 */
.manual__row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}

.manual__name {
  font-size: 13px;
  font-weight: 600;
}

.manual__url {
  font-size: 12px;
  color: var(--color-text-secondary);
  overflow-wrap: anywhere;
}
</style>
