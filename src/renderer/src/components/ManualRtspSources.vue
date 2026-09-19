<script setup lang="ts">
/**
 * 第三方相机（手填 RTSP 地址）。
 *
 * 业主 2026-09-19 第 11 批第 2 条：「实时视频墙的手填 RTSP 地址应该挪到**视频管理界面**」。
 * 业主选定的落点是**实时监测页**（见 `docs/UI-VERIFY.md` 第 20 轮的那条问与答），
 * 所以这个卡片挂在 `MonitorView` 上，画面墙那一侧不再有入口。
 *
 * WHY IT IS A CARD AND NOT A MODAL ANY MORE
 * 原来这一块是一个对话框，由画面墙的工具条打开。搬到页面上之后，对话框那一层就没有理由了：
 * 页面本来就有位置，而对话框把**列表**藏在一次点击后面 —— 一个"管理"界面不该先点一次
 * 才看得见自己管的东西。表单与列表因此在同一个卡片里（表单在上、列表在下）。
 *
 * 两条留在界面上的口径（手册未说明，所以必须写出来）
 *   1. **不校验可达性**：只判地址形状。连不上（端口不通、路径不对、要认证）时画面格上会显示
 *      ffmpeg 的原文 —— 那是唯一能回答"为什么连不上"的地方；
 *   2. **只在本次运行内有效**：手填地址常常含口令（`rtsp://user:pass@host/…`），写进
 *      localStorage 就是一份明文凭据。它和画面格的分配一样只在内存里（见 `stores/liveWall.ts`）。
 *
 * 放哪儿、怎么放进画面格
 * 这一页**不碰画面格**：放源进格是画面墙自己的事（总览页 → 点一格 → 选择器里那条
 * 「名字（手填 RTSP）」）。两处各写一套"放进第几格"，迟早出现两个不同的落点规则。
 */

import { computed, ref } from 'vue'
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

const { t } = useI18n()
const wall = useCameraWallStore()

/** 正在编辑的那一条 id；`null` = 新增。 */
const editingId = ref<string | null>(null)
const nameDraft = ref('')
const urlDraft = ref('')
const errorText = ref('')

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

function resetForm(): void {
  editingId.value = null
  nameDraft.value = ''
  urlDraft.value = ''
  errorText.value = ''
}

function startEdit(source: ManualRtspSource): void {
  editingId.value = source.id
  nameDraft.value = source.name
  urlDraft.value = source.url
  errorText.value = ''
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
    resetForm()
    return
  }

  wall.addManualSource({
    id: manualRtspIdFromBytes(crypto.getRandomValues(new Uint8Array(MANUAL_RTSP_ID_BYTES))),
    name,
    url: parsed.url
  })
  resetForm()
}

/**
 * 删掉一条源。
 *
 * 除了从列表里删掉，还要**把可能还在跑的那一路会话停掉**：store 交出来的 `toStop` 就是它。
 * 手填源不是设备，`cameraLive.stop()` 收的就是那串 `rtsp:…` id（主进程按会话 id 找它）。
 * 不停的话，屏幕上什么都没有了而 ffmpeg 还在读那个地址 —— 一个没人看的进程。
 */
function remove(source: ManualRtspSource): void {
  const result = wall.removeManualSource(source.id)
  if (editingId.value === source.id) resetForm()
  for (const id of result.toStop) void window.api.cameraLive.stop(id)
}
</script>

<template>
  <section class="card manual-sources" data-manual-rtsp-sources>
    <div class="section-header">
      <h3 class="section-title">{{ t('cameraWallUi.manualTitle') }}</h3>
    </div>

    <!-- 两条口径写在界面上：手册没有这一节，所以哪些是我们定的必须说清楚。 -->
    <p class="field-hint">{{ t('cameraWallUi.manualNote') }}</p>
    <!-- 放进画面格的动作在画面墙那一页（这一页不碰画面格），所以要指个路。 -->
    <p class="field-hint">{{ t('cameraWallUi.manualWhere') }}</p>

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
          {{ editingId === null ? t('cameraWallUi.manualSave') : t('cameraWallUi.manualUpdate') }}
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
        <div class="btn-row">
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
  </section>
</template>

<style scoped>
.manual-sources {
  margin-top: var(--space-5);
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

/* 一条手填源：名字 + 打码地址 + 两个动作。地址允许折断（很长）。 */
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
