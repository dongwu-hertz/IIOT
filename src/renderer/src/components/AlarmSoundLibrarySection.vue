<script setup lang="ts">
/**
 * 告警声音库（手册 §17.2.7 Alarm Sound Settings，p185）。
 *
 * ---------------------------------------------------------------------------
 * 手册要的六件事，逐条对应到下面
 * ---------------------------------------------------------------------------
 *   1. 六种**预定义**类型常驻列表（第 5439 行）-> `domain.alarmSound.*` 六条，
 *      由 `ALARM_SOUND_TYPE_KEYS` 决定，界面不自己写死顺序；
 *   2. 每一种可以选一个本机音频文件（5440）-> 每行的「选择文件」；
 *   3. Add 自定义 + **双击 Type 字段改名**（5441–5442）-> 「添加自定义」+ 双击名字进入
 *      内联重命名；
 *   4. 试听（5445）-> 每行的「试听」；有地址时才渲染 `<audio>`（无地址不渲染）；
 *   5. 自定义项可以删除（5446）-> 预定义项的删除按钮**不可用**（它不在手册的
 *      Delete 范围内），自定义项可删；
 *   6. **`.wav` 硬约束**（5448）-> 对话框只放 wav、主进程归一化再判一次、
 *      界面在这里**提前**拒绝，三处一致。
 *
 * ---------------------------------------------------------------------------
 * 本轮**不**做绑定
 * ---------------------------------------------------------------------------
 * 「哪一类告警用哪一个声音」属于告警模型那一轮。这里的 `defaultSoundId` 是
 * 「声音库的默认声音」（新建/删除之后的初值），**不是**某类告警的默认声音 ——
 * 界面上那三个字写的是「默认声音」，不是「默认告警声音」。
 *
 * ---------------------------------------------------------------------------
 * 试听怎么放
 * ---------------------------------------------------------------------------
 * 文件在**本机**，所以给 `<audio>` 一个 `file://` 地址即可，字节流不过 IPC。
 * 每个 `<video>`/`<audio>` 都由地址守卫：没有地址时那个元素根本不渲染
 * （见模板里的 `v-if`），所以不会出现一个"空播放器"。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ALARM_SOUND_FILE_EXTENSION,
  ALARM_SOUND_TYPE_KEYS,
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

/** 正在内联重命名的自定义项 id。 */
const renamingId = ref('')
const renameText = ref('')

/** 试听：**当前**正在播的那个地址。空串 = 没有播放器渲染。 */
const previewUrl = ref('')
const previewId = ref('')

/** 新增自定义项时的计数器，只用来生成一个不会撞的 id。 */
let customCounter = 0

const items = computed(() => draft.items)
const customItems = computed(() => draft.items.filter((item) => item.type === null))

function seedFromStore(): void {
  const current = settings.settings?.alarmSounds
  if (!current) return
  // 深拷贝：草稿与 store 里的那一份必须互不影响，否则「撤销修改」失效。
  draft.items = current.items.map((item) => ({ ...item }))
  draft.selectedId = current.selectedId
  draft.defaultSoundId = current.defaultSoundId
  renamingId.value = ''
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

/** 一行显示的名字：预定义项来自目录，自定义项来自用户（双击改的就是它）。 */
function displayName(item: AlarmSoundEntry): string {
  return item.type === null ? item.label : t(`domain.alarmSound.${item.type}`)
}

function isPredefined(item: AlarmSoundEntry): boolean {
  return item.type !== null
}

// ---------------------------------------------------------------------------
// 选择文件
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
  // `null` = 用户取消，不是错误。
  if (picked === null) return
  /**
   * **手册的硬约束在这里就拦下来**（第 5448 行）。
   *
   * 与主进程归一化器同一实现（`isAcceptableAlarmSoundFile`），所以两处不可能给出
   * 不同的答案；这里先判是为了让用户立刻看到原因，而不是保存之后发现那一格是空的。
   */
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

// ---------------------------------------------------------------------------
// 自定义项
// ---------------------------------------------------------------------------

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
  // 手册第 5442 行：双击 Type 字段改名。新增之后**直接进入改名状态**，省掉一次双击。
  startRename(entry)
}

function startRename(item: AlarmSoundEntry): void {
  if (!isCustomAlarmSoundId(item.id)) return
  renamingId.value = item.id
  renameText.value = item.label
}

function commitRename(): void {
  const item = draft.items.find((candidate) => candidate.id === renamingId.value)
  if (item) {
    const next = renameText.value.trim()
    if (next === '') {
      formError.value = t('alarmSoundUi.errEmptyName')
    } else {
      item.label = next
    }
  }
  renamingId.value = ''
}

/** 选定「默认声音」（库的默认，不是某类告警的绑定）。 */
function markDefault(item: AlarmSoundEntry): void {
  resetMessages()
  draft.defaultSoundId = item.id
  notice.value = t('alarmSoundUi.defaultSet', { name: displayName(item) })
}

function removeCustom(item: AlarmSoundEntry): void {
  resetMessages()
  if (isPredefined(item)) {
    formError.value = t('alarmSoundUi.errPredefinedUndeletable')
    return
  }
  draft.items = draft.items.filter((candidate) => candidate.id !== item.id)
  if (draft.defaultSoundId === item.id) draft.defaultSoundId = ALARM_SOUND_TYPE_KEYS[0]
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

/**
 * 把一个本机路径变成 `<audio>` 能吃下的地址。
 *
 * `encodeURI` 是必须的：Windows 路径里的 `\` 与空格会让一个裸 `file://` 地址
 * 被 Chromium 拒绝（或者更糟，解析成一个不存在的路径）。先按 `/` 分段编码再拼，
 * 这样盘符（`E:`）与每一段名字里的特殊字符都各自被正确转义。
 */
function toFileUrl(filePath: string): string {
  const normalised = filePath.replace(/\\/g, '/')
  const encoded = normalised
    .split('/')
    .map((segment, index) => (index === 0 ? segment : encodeURIComponent(segment)))
    .join('/')
  return `file:///${encoded.replace(/^\/+/, '')}`
}

function preview(item: AlarmSoundEntry): void {
  resetMessages()
  if (item.filePath === '') {
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
  /**
   * 保存前的最后一道自检：**任何一个非 `.wav`** 都不许出这个组件。
   *
   * 主进程的归一化器同样会清掉它，但那时用户只会看到"我选好的一格变成了未选择"。
   * 在这里先说清楚是哪一项。
   */
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
    defaultSoundId: draft.defaultSoundId
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

/** 当前草稿里有多少项已经选了文件——诊断用，也是"这一页有没有内容"的实据。 */
const fileCount = computed(() => draft.items.filter((item) => item.filePath !== '').length)
const defaultName = computed(() => {
  const item = draft.items.find((candidate) => candidate.id === draft.defaultSoundId)
  return item ? displayName(item) : ''
})
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

    <div class="sound-bar">
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

    <div class="table-wrap">
      <table class="table" data-table="alarm-sounds">
        <thead>
          <tr>
            <th>{{ t('alarmSoundUi.defaultColumn') }}</th>
            <th>{{ t('alarmSoundUi.typeColumn') }}</th>
            <th>{{ t('alarmSoundUi.fileColumn') }}</th>
            <th>{{ t('devices.columns.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="item in items"
            :key="item.id"
            :data-sound-id="item.id"
            :data-sound-custom="isPredefined(item) ? 'no' : 'yes'"
          >
            <td>
              <input
                type="radio"
                name="alarm-sound-default"
                :value="item.id"
                :checked="draft.defaultSoundId === item.id"
                :data-default-sound="item.id"
                :disabled="!canWrite"
                @change="markDefault(item)"
              />
            </td>
            <td>
              <!-- 自定义项：双击名字进入内联重命名（手册第 5442 行）。 -->
              <template v-if="!isPredefined(item)">
                <input
                  v-if="renamingId === item.id"
                  v-model="renameText"
                  data-autofocus
                  class="input sound-rename"
                  type="text"
                  :data-rename-input="item.id"
                  @keydown.enter.prevent="commitRename"
                  @keydown.esc.prevent="renamingId = ''"
                  @blur="commitRename"
                />
                <span
                  v-else
                  class="sound-name"
                  :data-rename-target="item.id"
                  :title="t('alarmSoundUi.renameHint')"
                  @dblclick="startRename(item)"
                >
                  {{ displayName(item) }}
                </span>
              </template>
              <span v-else class="sound-name">{{ displayName(item) }}</span>
              <span v-if="isPredefined(item)" class="badge badge--accent sound-badge">
                {{ t('alarmSoundUi.predefined') }}
              </span>
            </td>
            <td>
              <span class="mono sound-file" :data-sound-file="item.id">
                {{ item.fileName || t('alarmSoundUi.noFile') }}
              </span>
            </td>
            <td>
              <div class="row-actions">
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
                  type="button"
                  class="btn btn--sm btn--danger"
                  :disabled="isPredefined(item) || !canWrite || saving"
                  :title="isPredefined(item) ? t('alarmSoundUi.predefinedUndeletable') : undefined"
                  :data-delete-sound="item.id"
                  @click="removeCustom(item)"
                >
                  {{ t('common.delete') }}
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!--
      试听用的播放器。

      它由**地址守卫**：`previewUrl` 是空串时整个元素不渲染，所以页面上永远不会出现
      一个没有源、按了没反应的播放器。`v-if` 与 `:src` 同时绑同一个地址，两者不可能
      不一致。
    -->
    <div v-if="previewUrl" class="sound-preview">
      <span class="muted sound-hint">
        {{ t('alarmSoundUi.previewing', { name: items.find((item) => item.id === previewId)?.fileName ?? '' }) }}
      </span>
      <audio
        :src="previewUrl"
        data-preview-player
        controls
        autoplay
        @error="previewFailed"
      ></audio>
    </div>

    <p class="muted sound-hint">
      {{ t('alarmSoundUi.defaultIs', { name: defaultName }) }}
      · {{ t('alarmSoundUi.onlyWav', { ext: ALARM_SOUND_FILE_EXTENSION }) }}
    </p>
  </section>
</template>

<style scoped>
.sound-hint {
  font-size: 11.5px;
}

.sound-bar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
  flex-wrap: wrap;
}

.sound-name {
  cursor: default;
}

.sound-badge {
  margin-left: 6px;
}

.sound-file {
  word-break: break-all;
}

.sound-rename {
  width: 180px;
}

.row-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
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
