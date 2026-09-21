<script setup lang="ts">
/**
 * 告警声音（业主 20260921 批重做）。
 *
 * 与旧版「按 越界告警 / 区域入侵 等设备侧类型逐条选文件」的大表不同，这一版只有**两个**
 * 声音设置：**告警联动弹窗提示音**与**设备推送告警提示音**（各 = 开/关 + 选音）。
 * 音源统一来自下方的**声音库**（`AppSettings.alarmSounds.items`，手册 §17.2.7 那套
 * 预定义类型 + 自定义项）；绑定本身存在同一块设置的 `popup` / `push` 两个可选字段上，
 * 旧数据没有这两个字段时归一化器回落到「关 + 未选择」。
 *
 * 声音库管理刻意做薄：选文件 / 试听 / 清除 / 加自定义 / 删自定义（`.wav` 硬约束与
 * 共享层 `isAcceptableAlarmSoundFile()` 同一份判据）。试听给 `<audio>` 一个 `file://`
 * 地址（`lib/fileUrl.ts`），字节流不过 IPC。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ALARM_SOUND_FILE_EXTENSION,
  CUSTOM_ALARM_SOUND_ID_PREFIX,
  baseName,
  defaultAlarmSoundLibrary,
  isAcceptableAlarmSoundFile,
  isCustomAlarmSoundId,
  type AlarmSoundEntry,
  type AlarmSoundLibrary
} from '@shared/domain/alarm-sound'
import { useSettingsStore } from '@renderer/stores/settings'
import { useSessionStore } from '@renderer/stores/session'
import { toFileUrl } from '@renderer/lib/fileUrl'

const { t } = useI18n()
const settings = useSettingsStore()
const session = useSessionStore()

/** 只有管理员能改：与 `SETTINGS_UPDATE` 的判定一致（写入要管理员）。 */
const canWrite = computed(() => session.isAdmin)

/** 草稿：整块的深拷贝（保存时才写回主进程）。 */
const draft = reactive<AlarmSoundLibrary>(defaultAlarmSoundLibrary())

const saving = ref(false)
const formError = ref('')
const notice = ref('')

/** 试听：**当前**正在播的那个地址。空串 = 没有播放器渲染。 */
const previewUrl = ref('')
const previewId = ref('')

/** 新增自定义项时的计数器，只用来生成一个不会撞的 id。 */
let customCounter = 0

const items = computed(() => draft.items)
const customItems = computed(() => draft.items.filter((item) => item.type === null))

function emptyBinding(): { enabled: boolean; soundId: string } {
  return { enabled: false, soundId: '' }
}

function seedFromStore(): void {
  const current = settings.settings?.alarmSounds
  if (!current) return
  // 深拷贝：草稿与 store 里的那一份必须互不影响，否则「撤销修改」失效。
  draft.items = current.items.map((item) => ({ ...item }))
  draft.selectedId = current.selectedId
  draft.defaultSoundId = current.defaultSoundId
  draft.popup = current.popup ? { ...current.popup } : emptyBinding()
  draft.push = current.push ? { ...current.push } : emptyBinding()
}

onMounted(async () => {
  await settings.load()
  seedFromStore()
})

watch(() => settings.settings, seedFromStore)

function resetMessages(): void {
  formError.value = ''
  notice.value = ''
  settings.clearError()
}

/** 一行显示的名字：预定义项来自目录，自定义项来自用户。 */
function displayName(item: AlarmSoundEntry): string {
  return item.type === null ? item.label : t(`domain.alarmSound.${item.type}`)
}

/** 某一个绑定当前选中的库条目（可能没选）。 */
function bindingItem(kind: 'popup' | 'push'): AlarmSoundEntry | undefined {
  const soundId = draft[kind]?.soundId ?? ''
  return soundId === '' ? undefined : draft.items.find((item) => item.id === soundId)
}

// ---------------------------------------------------------------------------
// 绑定开关与选音
// ---------------------------------------------------------------------------

function toggleBinding(kind: 'popup' | 'push'): void {
  if (!canWrite.value) {
    formError.value = t('linkage.adminOnly')
    return
  }
  resetMessages()
  const binding = draft[kind] ?? emptyBinding()
  draft[kind] = { ...binding, enabled: !binding.enabled }
}

/** 选音：select 的 v-model 直连可选字段会让 vue-tsc 报「可能为 undefined」，走显式 setter。 */
function setBindingSound(kind: 'popup' | 'push', soundId: string): void {
  const binding = draft[kind] ?? emptyBinding()
  draft[kind] = { ...binding, soundId }
}

function onBindingSelect(kind: 'popup' | 'push', event: Event): void {
  const value = (event.target as HTMLSelectElement | null)?.value ?? ''
  setBindingSound(kind, value)
}

// ---------------------------------------------------------------------------
// 声音库（音源）
// ---------------------------------------------------------------------------

async function pickFile(item: AlarmSoundEntry): Promise<void> {
  if (!canWrite.value) {
    formError.value = t('linkage.adminOnly')
    return
  }
  resetMessages()
  previewUrl.value = ''
  previewId.value = ''
  const picked = await settings.pickAlarmSound()
  if (settings.error) {
    formError.value = settings.error
    return
  }
  // `''` = 用户取消（store 把 null 归一化成空串），不是错误。
  if (picked === '') return
  /** **手册的硬约束在这里就拦下来**（第 5448 行：只能是 `.wav`）。 */
  if (!isAcceptableAlarmSoundFile(picked)) {
    formError.value = t('alarmSoundUi.errOnlyWav', { ext: ALARM_SOUND_FILE_EXTENSION })
    return
  }
  item.filePath = picked
  item.fileName = baseName(picked)
  notice.value = t('alarmSoundUi.filePicked', { name: item.fileName })
}

/** 清掉一个声音指向的文件。 */
function clearFile(item: AlarmSoundEntry): void {
  resetMessages()
  item.filePath = ''
  item.fileName = ''
  if (previewId.value === item.id) {
    previewUrl.value = ''
    previewId.value = ''
  }
}

function addCustom(): void {
  resetMessages()
  if (!canWrite.value) {
    formError.value = t('linkage.adminOnly')
    return
  }
  customCounter += 1
  const entry: AlarmSoundEntry = {
    id: `${CUSTOM_ALARM_SOUND_ID_PREFIX}${Date.now().toString(36)}${customCounter}`,
    type: null,
    label: t('alarmSoundUi.customDefaultName', { count: customItems.value.length + 1 }),
    filePath: '',
    fileName: ''
  }
  draft.items.push(entry)
  draft.selectedId = entry.id
}

function removeCustom(item: AlarmSoundEntry): void {
  resetMessages()
  if (!isCustomAlarmSoundId(item.id)) return
  draft.items = draft.items.filter((candidate) => candidate.id !== item.id)
  if (draft.selectedId === item.id) draft.selectedId = ''
  if (previewId.value === item.id) {
    previewUrl.value = ''
    previewId.value = ''
  }
  notice.value = t('alarmSoundUi.deleted')
}

// ---------------------------------------------------------------------------
// 试听
// ---------------------------------------------------------------------------

function preview(item: AlarmSoundEntry | undefined): void {
  resetMessages()
  if (!item || item.filePath === '') {
    formError.value = t('alarmSoundUi.errNoFile')
    return
  }
  if (!isAcceptableAlarmSoundFile(item.filePath)) {
    formError.value = t('alarmSoundUi.errOnlyWav', { ext: ALARM_SOUND_FILE_EXTENSION })
    return
  }
  // 同一个地址再点一次 = 重播：把地址清掉再加回来，`<audio>` 会重新加载。
  previewUrl.value = ''
  previewId.value = ''
  window.setTimeout(() => {
    if (!item) return
    previewUrl.value = toFileUrl(item.filePath)
    previewId.value = item.id
  }, 0)
}

function previewFailed(): void {
  formError.value = t('alarmSoundUi.errPreview')
}

// ---------------------------------------------------------------------------
// 保存
// ---------------------------------------------------------------------------

async function save(): Promise<void> {
  resetMessages()
  if (!canWrite.value) {
    formError.value = t('linkage.adminOnly')
    return
  }
  /** 保存前最后一道自检：**任何一个非 `.wav`** 都不许出这个组件。 */
  const bad = draft.items.find((item) => item.filePath !== '' && !isAcceptableAlarmSoundFile(item.filePath))
  if (bad) {
    formError.value = t('alarmSoundUi.errOnlyWavFor', {
      name: displayName(bad),
      ext: ALARM_SOUND_FILE_EXTENSION
    })
    return
  }
  const unnamed = draft.items.find((item) => item.type === null && item.label.trim() === '')
  if (unnamed) {
    formError.value = t('alarmSoundUi.errEmptyName')
    return
  }

  saving.value = true
  const payload: AlarmSoundLibrary = {
    items: draft.items.map((item) => ({ ...item })),
    selectedId: draft.selectedId,
    defaultSoundId: draft.defaultSoundId,
    popup: { ...(draft.popup ?? emptyBinding()) },
    push: { ...(draft.push ?? emptyBinding()) }
  }
  const saved = await settings.update({ alarmSounds: payload })
  saving.value = false
  if (!saved) {
    formError.value = settings.error || t('settingsUi.saveFailed')
    return
  }
  seedFromStore()
  notice.value = t('settingsUi.saveSuccess')
}

/** 当前草稿里有多少项已经选了文件 —— 「这一页有没有内容」的实据。 */
const fileCount = computed(() => draft.items.filter((item) => item.filePath !== '').length)
</script>

<template>
  <section class="card" data-section="alarm-sound">
    <div class="section-header">
      <h3 class="section-title">{{ t('alarmSoundUi.title') }}</h3>
      <div class="btn-row">
        <button type="button" class="btn btn--sm" :disabled="!canWrite || saving" @click="seedFromStore">
          {{ t('settingsUi.revert') }}
        </button>
        <button
          type="button"
          class="btn btn--sm btn--primary"
          :disabled="!canWrite || saving"
          data-action="save-alarm-sounds"
          @click="save"
        >
          {{ saving ? t('common.saving') : t('settingsUi.saveButton') }}
        </button>
      </div>
    </div>

    <p v-if="formError" class="alert alert--danger" role="alert">{{ formError }}</p>
    <p v-else-if="notice" class="alert alert--success" role="status">{{ notice }}</p>
    <p v-if="!canWrite" class="muted sound-hint">{{ t('linkage.adminOnly') }}</p>

    <!--
      两个声音设置（业主 20260921 批）：联动弹窗提示音 / 设备推送告警提示音。
      每行 = 名称 + 开关 + 选音（音源 = 下方声音库条目）+ 试听。
    -->
    <div class="binding-list">
      <div v-for="kind in (['popup', 'push'] as const)" :key="kind" class="binding-row" :data-sound-binding="kind">
        <span class="binding-row__name">{{ t(`alarmSoundUi.binding.${kind}`) }}</span>
        <button
          type="button"
          class="switch"
          :class="{ 'switch--on': draft[kind]?.enabled }"
          :aria-checked="draft[kind]?.enabled === true"
          :disabled="!canWrite || saving"
          role="switch"
          :data-binding-toggle="kind"
          @click="toggleBinding(kind)"
        >
          <span class="switch__knob"></span>
          <span class="switch__text">
            {{ draft[kind]?.enabled ? t('alarmSoundUi.soundOn') : t('alarmSoundUi.soundOff') }}
          </span>
        </button>
        <select
          class="input binding-row__select"
          :value="draft[kind]?.soundId ?? ''"
          :disabled="!canWrite || saving"
          :data-binding-select="kind"
          @change="onBindingSelect(kind, $event)"
        >
          <option value="">{{ t('alarmSoundUi.bindingNone') }}</option>
          <option v-for="item in items" :key="item.id" :value="item.id">
            {{ displayName(item) }}{{ item.filePath === '' ? `（${t('alarmSoundUi.noFile')}）` : '' }}
          </option>
        </select>
        <button
          type="button"
          class="btn btn--sm"
          :disabled="bindingItem(kind)?.filePath === '' || bindingItem(kind) === undefined"
          :data-binding-preview="kind"
          @click="preview(bindingItem(kind))"
        >
          {{ t('alarmSoundUi.preview') }}
        </button>
      </div>
    </div>
    <p class="muted sound-hint">{{ t('alarmSoundUi.bindingHint') }}</p>

    <!--
      声音库（音源）。刻意做薄：选文件 / 试听 / 清除 / 加自定义 / 删自定义。
      预定义项的「类型」只是名字（`domain.alarmSound.*`），不再是"哪类告警绑哪个声音" ——
      绑定就是上面那两行。
    -->
    <div class="sound-lib">
      <div class="sound-lib__bar">
        <span class="sound-lib__title">{{ t('alarmSoundUi.libraryGroup') }}</span>
        <button
          type="button"
          class="btn btn--sm"
          :disabled="!canWrite || saving"
          data-action="add-custom-sound"
          @click="addCustom"
        >
          {{ t('alarmSoundUi.addCustom') }}
        </button>
        <span class="muted sound-hint">
          {{ t('alarmSoundUi.summary', { total: items.length, custom: customItems.length, files: fileCount }) }}
        </span>
      </div>

      <ul class="sound-lib__list">
        <li v-for="item in items" :key="item.id" class="sound-lib__row" :data-sound-id="item.id">
          <span class="sound-lib__name">
            {{ displayName(item) }}
            <span v-if="item.type !== null" class="badge badge--accent">{{ t('alarmSoundUi.predefined') }}</span>
          </span>
          <span class="mono sound-lib__file" :data-sound-file="item.id">
            {{ item.fileName || t('alarmSoundUi.noFile') }}
          </span>
          <span class="sound-lib__actions">
            <button
              type="button"
              class="btn btn--sm"
              :disabled="!canWrite || saving"
              :data-pick-sound="item.id"
              @click="pickFile(item)"
            >
              {{ t('alarmSoundUi.pickFile') }}
            </button>
            <button
              type="button"
              class="btn btn--sm"
              :disabled="item.filePath === ''"
              :data-preview-sound="item.id"
              @click="preview(item)"
            >
              {{ t('alarmSoundUi.preview') }}
            </button>
            <button
              type="button"
              class="btn btn--sm"
              :disabled="item.filePath === '' || saving"
              :data-clear-sound="item.id"
              @click="clearFile(item)"
            >
              {{ t('alarmSoundUi.clearFile') }}
            </button>
            <button
              v-if="isCustomAlarmSoundId(item.id)"
              type="button"
              class="btn btn--sm btn--danger"
              :disabled="!canWrite || saving"
              :data-delete-sound="item.id"
              @click="removeCustom(item)"
            >
              {{ t('common.delete') }}
            </button>
          </span>
        </li>
      </ul>
      <p class="muted sound-hint">{{ t('alarmSoundUi.onlyWav', { ext: ALARM_SOUND_FILE_EXTENSION }) }}</p>
    </div>

    <!-- 试听播放器：由地址守卫，空串时整个元素不渲染，不会出现"空播放器"。 -->
    <div v-if="previewUrl" class="sound-preview">
      <span class="muted sound-hint">
        {{ t('alarmSoundUi.previewing', { name: items.find((item) => item.id === previewId)?.fileName ?? '' }) }}
      </span>
      <audio :src="previewUrl" data-preview-player controls autoplay @error="previewFailed"></audio>
    </div>
  </section>
</template>

<style scoped>
.sound-hint {
  font-size: 11.5px;
}

/* 两个绑定行：名称 + 开关 + 选音 + 试听，一行排开、窄窗自动折行。 */
.binding-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.binding-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border, rgba(0, 0, 0, 0.12));
  border-radius: 6px;
}

.binding-row__name {
  font-weight: 600;
  min-width: 128px;
}

.binding-row__select {
  flex: 1;
  min-width: 180px;
}

/* 开关（与联动页签标题右侧那颗同一套样式语言）。 */
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

/* 声音库：比旧版大表薄的列表。 */
.sound-lib {
  border-top: 1px solid var(--color-border);
  padding-top: var(--space-3);
  margin-top: var(--space-2);
}

.sound-lib__bar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-2);
  flex-wrap: wrap;
}

.sound-lib__title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.sound-lib__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sound-lib__row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: 4px var(--space-2);
  border: 1px solid var(--color-border, rgba(0, 0, 0, 0.08));
  border-radius: 6px;
  font-size: 12.5px;
}

.sound-lib__name {
  font-weight: 600;
  min-width: 130px;
}

.sound-lib__file {
  flex: 1;
  min-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.sound-lib__actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.sound-preview {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-3);
  flex-wrap: wrap;
}
</style>
