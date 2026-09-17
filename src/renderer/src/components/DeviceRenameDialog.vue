<script setup lang="ts">
/**
 * 拓扑树右键菜单里的「修改设备名称 / 修改通道名称」对话框。
 *
 * WHY A DEDICATED COMPONENT
 * 「重命名」在这里不是一个动作，而是**三种落点完全不同的动作**，而界面的全部责任是
 * 把「刚刚到底改了什么」说清楚：
 *   1. 声纹设备的设备名：本机数据库 + 设备自身（`config.setDeviceName`）；
 *   2. 声学相机的设备名：**只有本机数据库**。FA371 的开放接口里没有设备名称端点
 *      （`docs/reference/FA371-api-spec.md` §3 的表后注把「设备重命名」明确列为
 *      「UI 有、Open Interface 未开放」），所以这里必须当面告诉操作员，否则他会
 *      以为相机的名字也改了，而别的软件仍然看到旧名字；
 *   3. 通道名：写在声纹设备上，本机的通道表随后重新读取。
 *
 * 判定一律**按 `kind`**（`'acousticBox' | 'acousticCamera'`），绝不按名字或地址猜。
 *
 * 保存本身由调用方（设备管理页）执行：它拿着设备 store 与 IPC 桥，也知道失败之后
 * 该显示哪一句错误。这里的 `onSubmit` 返回 `true` 才关闭，`false` 就把对话框留在
 * 屏幕上让错误可见 —— 一个失败的写入绝不能看起来像成功过。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DeviceKind } from '@shared/domain/models'
import AppModal from '@renderer/components/AppModal.vue'

const props = defineProps<{
  /** 对话框是否打开（`v-model`）。 */
  modelValue: boolean
  /** `'device'` = 改设备名，`'channel'` = 改通道名。 */
  target: 'device' | 'channel'
  /** 被改的设备家族，决定「改的到底是谁」。 */
  kind: DeviceKind
  /** 设备名称（标题里显示「正在改哪一台」）。 */
  deviceName: string
  /** 通道名所在的通道标签（`CH3`）；改设备名时为空。 */
  channelLabel: string
  /** 当前值，打开时作为输入框的初值。 */
  currentName: string
  /** 保存中（按钮禁用 + 文字切换）。 */
  saving: boolean
  /** 保存失败的原因；空串表示没有错误。 */
  error: string
  /** 执行保存；返回 `true` 表示写入成功，可以关闭。 */
  onSubmit: (name: string) => Promise<boolean>
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
}>()

const { t } = useI18n()

const draft = ref('')

/**
 * 每次打开都从当前值重新开始。
 *
 * 不这么做的话，上一次取消时留下的半截文字会在下一次打开时“粘”在输入框里 ——
 * 而那种草稿一旦被误保存，就会把一个操作员没打算提交的名字写到设备上。
 */
watch(
  () => props.modelValue,
  (open) => {
    if (open) draft.value = props.currentName
  },
  { immediate: true }
)

const title = computed(() =>
  props.target === 'channel' ? t('deviceRename.titleChannel') : t('deviceRename.titleDevice')
)

const fieldLabel = computed(() =>
  props.target === 'channel' ? t('deviceRename.fieldChannel') : t('deviceRename.fieldDevice')
)

/**
 * 这一块唯一的说明文字：改的到底是什么。
 *
 * 相机的本地改名必须**当场**说出来（见文件头理由 2）；箱子与通道各有一句，说的也是
 * 「名字最终落在哪里」这件事实。
 */
const hint = computed(() => {
  if (props.target === 'channel') return t('deviceRename.channelHint')
  return props.kind === 'acousticCamera' ? t('deviceRename.cameraHint') : t('deviceRename.deviceHint')
})

/** 标题里带上正在改的对象，多台设备时不会改名改错对象。 */
const heading = computed(() => {
  if (props.target === 'channel') {
    return `${props.deviceName} · ${props.channelLabel}`
  }
  return props.deviceName
})

/** 空名与同名都不提交：它们要么是误触，要么什么都不会改变。 */
const unchanged = computed(() => draft.value.trim() === props.currentName.trim())

async function submit(): Promise<void> {
  const name = draft.value.trim()
  if (name === '' || unchanged.value) return
  const done = await props.onSubmit(name)
  if (done) emit('update:modelValue', false)
}

function cancel(): void {
  emit('update:modelValue', false)
}
</script>

<template>
  <AppModal
    :model-value="modelValue"
    :title="title"
    width="460px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="rename-form">
      <p class="rename-form__target mono">{{ heading }}</p>
      <label class="field">
        <span class="field-label">{{ fieldLabel }}</span>
        <input
          v-model="draft"
          data-autofocus
          class="input"
          type="text"
          maxlength="64"
          spellcheck="false"
          @keydown.enter.prevent="submit"
        />
      </label>
      <p class="rename-form__hint">{{ hint }}</p>
      <p v-if="error" class="alert alert--danger" role="alert">{{ error }}</p>
    </div>
    <template #footer>
      <button type="button" class="btn" :disabled="saving" @click="cancel">
        {{ t('common.cancel') }}
      </button>
      <button
        type="button"
        class="btn btn--primary"
        :disabled="saving || draft.trim() === '' || unchanged"
        @click="submit"
      >
        {{ saving ? t('common.saving') : t('common.save') }}
      </button>
    </template>
  </AppModal>
</template>

<style scoped>
.rename-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.rename-form__target {
  margin: 0;
  font-size: 12px;
  color: var(--color-text-secondary);
}

/* 改的到底是哪一台、哪一路：这是这一块唯一的「说明」，说的是落点而不是操作步骤。 */
.rename-form__hint {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--color-text-secondary);
}
</style>
