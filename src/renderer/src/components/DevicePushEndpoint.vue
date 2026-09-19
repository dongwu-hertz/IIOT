<script setup lang="ts">
/**
 * 「推流地址与秘钥」——添加/编辑设备对话框里的那一块（业主 2026-09-18 第 10 批第 5 条：
 * 「添加设备支持 HTTP 推流（秘钥 + 推流地址）」）。
 *
 * ---------------------------------------------------------------------------
 * 为什么地址是**逐网卡列出来**的
 * ---------------------------------------------------------------------------
 * 监听地址可以是 `0.0.0.0`（所有网卡），但 `0.0.0.0` **不是一个设备能连的目标** ——
 * 设备要的是"这台机器在局域网里的那个地址"。所以主进程把本机每个非回环 IPv4 地址都报上来，
 * 由现场那个人挑设备真正连得上的那一条（一台值班机常常同时有办公网与设备网两张网卡）。
 *
 * ---------------------------------------------------------------------------
 * 秘钥的显示
 * ---------------------------------------------------------------------------
 * ThingsBoard 也是把 access token 显示在设备详情里（见 §15.61.3 的调研表），所以这里直接
 * 明文显示 + 一键复制。轮换是一次**凭据变更**，所以它有确认对话框，而且确认文案要说清
 * 「旧秘钥立刻失效」——不写这一句，用户会以为轮换是"再加一条"。
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DeviceIngestEndpoint } from '@shared/ipc/contract'
import { httpPushUrl, mqttPushTarget } from '@shared/domain/iot-ingest'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import AppModal from '@renderer/components/AppModal.vue'

const props = defineProps<{ deviceId: string }>()

const { t } = useI18n()

const endpoint = ref<DeviceIngestEndpoint | null>(null)
const error = ref('')
const loading = ref(false)
const copiedKey = ref('')
const rotating = ref(false)
const rotateOpen = ref(false)
const rotateNotice = ref('')

async function load(): Promise<void> {
  loading.value = true
  const result = await callApi(() => window.api.devices.ingestEndpoint(props.deviceId))
  loading.value = false
  if (!result.success) {
    error.value = resultMessage(result)
    return
  }
  endpoint.value = unwrap(result) ?? null
  error.value = ''
}

onMounted(() => {
  void load()
})

/** 每个候选网卡一条 HTTP 地址（用共享层的拼装，界面不自己拼字符串）。 */
const httpUrls = computed(() => {
  const current = endpoint.value
  if (!current) return []
  return current.localAddresses.map((item) => ({
    key: `http-${item.address}`,
    iface: item.iface,
    value: httpPushUrl(item.address, current.httpPort, current.secret)
  }))
})

const mqttTargets = computed(() => {
  const current = endpoint.value
  if (!current) return []
  return current.localAddresses.map((item) => ({
    key: `mqtt-${item.address}`,
    iface: item.iface,
    value: mqttPushTarget(item.address, current.mqttPort)
  }))
})

async function copy(text: string, key: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    copiedKey.value = key
    window.setTimeout(() => {
      if (copiedKey.value === key) copiedKey.value = ''
    }, 1600)
  } catch {
    error.value = t('settingsUi.copyFailed')
  }
}

async function confirmRotate(): Promise<void> {
  rotating.value = true
  const result = await callApi(() => window.api.devices.rotatePushSecret(props.deviceId))
  rotating.value = false
  if (!result.success) {
    error.value = resultMessage(result)
    return
  }
  endpoint.value = unwrap(result) ?? endpoint.value
  rotateOpen.value = false
  rotateNotice.value = t('iotUi.rotateNotice')
}
</script>

<template>
  <fieldset class="push" data-device-push>
    <legend class="field-label">{{ t('iotUi.devicesTitle') }}</legend>

    <p v-if="error" class="alert alert--danger" role="alert">{{ error }}</p>
    <p v-else-if="rotateNotice" class="alert alert--success" role="status">{{ rotateNotice }}</p>

    <p v-if="!endpoint && loading" class="field-hint">{{ t('common.loading') }}</p>

    <template v-if="endpoint">
      <!-- 开关关着时地址仍然显示（它是配置），但必须明说"现在连不上"。 -->
      <p v-if="!endpoint.serviceEnabled" class="alert alert--warning" role="note">
        {{ t('iotUi.serviceOff') }}
      </p>

      <p class="field-hint">{{ t('iotUi.devicesHint') }}</p>

      <div class="field">
        <span class="field-label">{{ t('iotUi.secretLabel') }}</span>
        <span class="push__value">
          <code class="mono" data-push-secret>{{ endpoint.secret }}</code>
          <button
            type="button"
            class="btn btn--sm btn--ghost"
            data-action="copy-secret"
            @click="copy(endpoint.secret, 'secret')"
          >
            {{ copiedKey === 'secret' ? t('iotUi.copied') : t('iotUi.copy') }}
          </button>
        </span>
        <span class="field-hint">{{ t('iotUi.secretHint') }}</span>
      </div>

      <div class="field">
        <span class="field-label">{{ t('iotUi.httpGroup') }}</span>
        <!--
          **地址与监听状态分开说**（第 13 批第 1 条之后）：地址是**配置**（主机 + 端口 + 秘钥路径），
          它一直成立；监听开没开是另一件事，由上面那句 `serviceOff` 回答。

          为什么不再按 `httpEnabled` 把地址藏起来：那一格是**派生**的（有没有设备声明 HTTP 接入），
          而操作员打开这个对话框正是为了把地址填到设备上 —— 在设备还没声明接入（也就是还没添加成功）
          的时候把地址藏掉，他就没有任何东西可以填。
        -->
        <template v-if="httpUrls.length === 0">
          <span class="field-hint">{{ t('iotUi.noLocalAddresses') }}</span>
        </template>
        <template v-else>
          <span v-for="item in httpUrls" :key="item.key" class="push__value" data-push-http-url>
            <code class="mono">{{ item.value }}</code>
            <button
              type="button"
              class="btn btn--sm btn--ghost"
              :title="item.iface"
              @click="copy(item.value, item.key)"
            >
              {{ copiedKey === item.key ? t('iotUi.copied') : t('iotUi.copy') }}
            </button>
          </span>
        </template>
      </div>

      <div class="field">
        <span class="field-label">{{ t('iotUi.mqttGroup') }}</span>
        <template v-if="mqttTargets.length === 0">
          <span class="field-hint">{{ t('iotUi.noLocalAddresses') }}</span>
        </template>
        <template v-else>
          <span v-for="item in mqttTargets" :key="item.key" class="push__value" data-push-mqtt-target>
            <code class="mono">{{ item.value }}</code>
            <button
              type="button"
              class="btn btn--sm btn--ghost"
              :title="item.iface"
              @click="copy(item.value, item.key)"
            >
              {{ copiedKey === item.key ? t('iotUi.copied') : t('iotUi.copy') }}
            </button>
          </span>
        </template>
        <span class="field-hint" data-push-mqtt-topic>
          {{ t('iotUi.mqttTopicLabel') }}: <code class="mono">{{ endpoint.mqttTopic }}</code>
        </span>
        <span class="field-hint">
          {{ t('iotUi.mqttUser') }}: <code class="mono">{{ endpoint.secret }}</code>
        </span>
      </div>

      <div class="btn-row">
        <button
          type="button"
          class="btn btn--sm"
          data-action="rotate-push-secret"
          :disabled="rotating"
          @click="rotateOpen = true"
        >
          {{ t('iotUi.rotate') }}
        </button>
      </div>
    </template>
  </fieldset>

  <AppModal v-model="rotateOpen" :title="t('iotUi.rotateTitle')" width="460px">
    <p>{{ t('iotUi.rotateBody') }}</p>
    <template #footer>
      <button type="button" class="btn" :disabled="rotating" @click="rotateOpen = false">
        {{ t('common.cancel') }}
      </button>
      <button
        type="button"
        class="btn btn--danger"
        data-action="confirm-rotate-push-secret"
        :disabled="rotating"
        @click="confirmRotate"
      >
        {{ rotating ? t('common.saving') : t('iotUi.rotateConfirm') }}
      </button>
    </template>
  </AppModal>
</template>

<style scoped>
.push {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--space-3);
  margin: 0;
}

/*
 * 一行：值 + 复制按钮。值允许折断 —— 一条 HTTP 推流地址有 60 多个字符，
 * 在 560px 宽的对话框里不折断就会把复制按钮挤出可见区域。
 */
.push__value {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.push__value code {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  overflow-wrap: anywhere;
}

.push__value .btn {
  flex: none;
}
</style>
