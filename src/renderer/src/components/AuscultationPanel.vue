<script setup lang="ts">
/**
 * 听诊盒子族（E2 / FA100 / FA110）的设备面板：工作模式 + 阈值参数 + 告警同步。
 *
 * 业主 2026-09-16 的「拉」通道：`token 登录 → /workmode → 按模式读参数 → 告警日志 → 文件下载`。
 * 这一屏把前三步**显示出来**，第四第五步由「同步告警」按钮触发。
 *
 * 三件在这一屏必须成立的事：
 *   1. **参数显示设备原样给的值**，不显示我们编的"默认值" —— 手册里的示例数字是文档示例，
 *      不是这台设备的当前值。所以没读到的键就**不显示**，而不是拿文档示例填进去。
 *   2. **认不出的工作模式照样显示原文**（设备可能出了第四种模式），那时界面不假装知道它叫什么。
 *   3. **`/system` 读失败单独说**：模式读到了、参数没读到是可能的，合并成一句"读取失败"
 *      会让操作员以为整台设备没回应。
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { E2DeviceStatus, E2SyncOutcome } from '@shared/ipc/contract'
import {
  E2_AIR_SONAR_PARAMS,
  E2_COMMON_PARAMS,
  E2_MODE_PARAMS,
  E2_PARAM_GROUPS,
  E2_SENSITIVE_PARAMS,
  isE2WorkMode
} from '@shared/domain/e2'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import { formatDateTime } from '@renderer/lib/format'

const props = defineProps<{ deviceId: string }>()

const { t } = useI18n()

const status = ref<E2DeviceStatus | null>(null)
const loading = ref(false)
const error = ref('')
const syncing = ref(false)
const outcome = ref<E2SyncOutcome | null>(null)
const notice = ref('')
/** 同步时是否连时频谱图一起拉（默认关：一条告警最多 10 张图 = 10 次请求）。 */
const withSpectrograms = ref(false)

async function load(): Promise<void> {
  loading.value = true
  const result = await callApi(() => window.api.e2.status(props.deviceId))
  loading.value = false
  if (!result.success) {
    error.value = resultMessage(result)
    status.value = null
    return
  }
  error.value = ''
  status.value = unwrap(result) ?? null
}

onMounted(load)

async function sync(): Promise<void> {
  syncing.value = true
  outcome.value = null
  const result = await callApi(() =>
    window.api.e2.syncAlarms(props.deviceId, {
      // 条数用设备状态里给的上限口径；这里传 200 是"一次一页"的默认值。
      limit: 200,
      downloadAudio: true,
      downloadSpectrograms: withSpectrograms.value
    })
  )
  syncing.value = false
  if (!result.success) {
    notice.value = resultMessage(result)
    return
  }
  notice.value = ''
  outcome.value = unwrap(result) ?? null
}

/** 工作模式：认得出就用目录里的名字，认不出就把设备原文显示出来。 */
const modeText = computed(() => {
  const current = status.value
  if (!current) return ''
  // Air Sonar **没有**工作模式这个概念（它是单一用途的声学成像设备）。
  if (current.variant === 'airSonar') return t('e2Ui.modeNotApplicable')
  const raw = current.mode ?? current.rawWorkMode
  if (raw === '') return t('e2Ui.modeUnknown')
  return isE2WorkMode(raw) ? t(`e2Ui.mode_${raw}`) : raw
})

/** 这一台是哪一代；认不出来就**照实说**，不按某一代去解释。 */
const variantText = computed(() => {
  const variant = status.value?.variant
  if (variant === undefined) return t('e2Ui.variantUnknown')
  return t(`e2Ui.variant_${variant}`)
})

const isAirSonar = computed(() => status.value?.variant === 'airSonar')

/**
 * 要显示的参数行。
 *
 * 三条规矩：
 *   - 顺序：先按**参数分组**（阈值 / 相机 / 开关 / 其它），组内保持手册的键顺序；
 *   - **只显示设备真的回了的键**（手册里的示例数字是文档示例，不是这台设备的当前值）；
 *   - 设备**多给**的键也列出来并标记（那常常是固件比手册新的信号），
 *     但**口令类的键不显示值**（`cam_pass` 是 PTZ 相机口令）。
 */
const paramRows = computed<
  Array<{ key: string; value: string; group: string; extra: boolean; sensitive: boolean }>
>(() => {
  const current = status.value
  if (!current) return []
  const params = current.params

  const known = new Set<string>(['work_mode'])
  const order: string[] = []
  const mode = current.mode
  if (mode !== undefined) {
    for (const key of E2_MODE_PARAMS[mode]) order.push(key)
  }
  for (const key of E2_AIR_SONAR_PARAMS) order.push(key)
  for (const key of E2_COMMON_PARAMS) order.push(key)

  const rows: Array<{ key: string; value: string; group: string; extra: boolean; sensitive: boolean }> = []
  const push = (key: string, extra: boolean): void => {
    if (!(key in params)) return
    const sensitive = E2_SENSITIVE_PARAMS.includes(key)
    rows.push({
      key,
      value: sensitive ? t('e2Ui.paramValueHidden') : formatValue(params[key]),
      group: E2_PARAM_GROUPS[key] ?? 'other',
      extra,
      sensitive
    })
  }
  for (const key of order) {
    if (known.has(key)) continue
    known.add(key)
    push(key, false)
  }
  for (const key of Object.keys(params)) {
    if (known.has(key)) continue
    push(key, true)
  }
  // 按分组排：阈值 → 相机 → 开关 → 其它；组内保持上面 push 的顺序（即手册顺序）。
  const groupRank: Record<string, number> = { threshold: 0, camera: 1, switch: 2, other: 3 }
  return rows.sort((left, right) => (groupRank[left.group] ?? 9) - (groupRank[right.group] ?? 9))
})

function formatValue(value: unknown): string {
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return '—'
  return JSON.stringify(value)
}

/** 参数键的中文名：认识的用自己的目录，不认识的直接显示设备给的键名。 */
function paramLabel(key: string): string {
  const known = t(`e2Ui.param_${key}`)
  return known.startsWith('e2Ui.') ? key : known
}
</script>

<template>
  <section class="card">
    <div class="section-header">
      <h3 class="section-title">{{ t('e2Ui.statusTitle') }}</h3>
      <button type="button" class="btn btn--sm" :disabled="loading" @click="load">
        {{ loading ? t('common.loading') : t('common.refresh') }}
      </button>
    </div>

    <p v-if="error" class="alert alert--danger" role="alert">{{ error }}</p>

    <template v-else-if="status">
      <dl class="kv">
        <div class="kv__item">
          <dt class="kv__label">{{ t('e2Ui.variant') }}</dt>
          <dd class="kv__value">{{ variantText }}</dd>
        </div>
        <div class="kv__item">
          <dt class="kv__label">{{ t('e2Ui.mode') }}</dt>
          <dd class="kv__value">{{ modeText }}</dd>
        </div>
        <div class="kv__item">
          <dt class="kv__label">{{ t('e2Ui.samplerate') }}</dt>
          <dd class="kv__value">
            {{ status.samplerate !== undefined ? `${status.samplerate} Hz` : '—' }}
          </dd>
        </div>
        <div class="kv__item">
          <dt class="kv__label">{{ t('e2Ui.channelCount') }}</dt>
          <dd class="kv__value">
            {{ status.channelCount !== undefined ? status.channelCount : '—' }}
          </dd>
        </div>
        <div v-if="!isAirSonar" class="kv__item">
          <dt class="kv__label">{{ t('e2Ui.spectrogramSize') }}</dt>
          <dd class="kv__value">
            {{
              status.stftPicWidth !== undefined && status.stftPicHeight !== undefined
                ? `${status.stftPicWidth} × ${status.stftPicHeight}`
                : '—'
            }}
          </dd>
        </div>
        <div class="kv__item">
          <dt class="kv__label">{{ t('e2Ui.deviceType') }}</dt>
          <dd class="kv__value">{{ status.basic.devType ?? '—' }}</dd>
        </div>
        <div class="kv__item">
          <dt class="kv__label">{{ t('e2Ui.firmware') }}</dt>
          <dd class="kv__value">{{ status.basic.devVersion ?? '—' }}</dd>
        </div>
        <div class="kv__item">
          <dt class="kv__label">{{ t('e2Ui.retention') }}</dt>
          <dd class="kv__value">{{ t('e2Ui.retentionValue', { count: status.alarmLogRetention }) }}</dd>
        </div>
      </dl>

      <p v-if="status.paramsError" class="alert alert--warning" role="note">
        {{ t('e2Ui.paramsError', { reason: status.paramsError }) }}
      </p>

      <div v-if="paramRows.length > 0" class="param-table">
        <table class="table">
          <thead>
            <tr>
              <th>{{ t('e2Ui.paramColumn') }}</th>
              <th>{{ t('e2Ui.valueColumn') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in paramRows" :key="row.key">
              <td class="nowrap">
                {{ paramLabel(row.key) }}
                <!-- 设备多给的键单独标一下：那常常是固件比手册新的信号。 -->
                <span v-if="row.extra" class="badge badge--warning param-extra">
                  {{ t('e2Ui.paramExtra') }}
                </span>
              </td>
              <td class="nowrap mono" :class="{ 'param-sensitive': row.sensitive }">
                {{ row.value }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else-if="!status.paramsError" class="muted">{{ t('e2Ui.paramsEmpty') }}</p>
    </template>
    <p v-else class="muted">{{ t('common.loading') }}</p>
  </section>

  <section class="card">
    <div class="section-header">
      <h3 class="section-title">{{ t('e2Ui.syncTitle') }}</h3>
    </div>
    <p class="muted sync-hint">{{ t('e2Ui.syncHint', { count: status?.alarmLogRetention ?? 5000 }) }}</p>

    <div class="btn-row sync-actions">
      <label class="field checkbox-field">
        <input v-model="withSpectrograms" type="checkbox" />
        <span class="field-label">
          {{ isAirSonar ? t('e2Ui.syncSnapshots') : t('e2Ui.syncSpectrograms') }}
        </span>
      </label>
      <button
        type="button"
        class="btn btn--primary"
        data-action="e2-sync"
        :disabled="syncing"
        @click="sync"
      >
        {{ syncing ? t('e2Ui.syncing') : t('e2Ui.syncButton') }}
      </button>
    </div>

    <p v-if="notice" class="alert alert--danger" role="alert">{{ notice }}</p>

    <template v-if="outcome">
      <!--
        `data-e2-outcome` 是**给探针用的**标记属性（不带任何样式）：探针要在不看中文的情况下
        读出"这次同步真的写了几条、下了几个文件"，而不是去猜某一行文案。
      -->
      <div class="sync-outcome" data-e2-outcome>
        <p class="sync-line" role="status">
          {{ t('e2Ui.outcomeAlarms', {
            created: outcome.alarmsCreated,
            existing: outcome.alarmsExisting,
            seen: outcome.logsSeen
          }) }}
        </p>
        <p class="sync-line muted">
          {{ t('e2Ui.outcomeAudio', {
            saved: outcome.audioSaved,
            existing: outcome.audioExisting,
            failed: outcome.audioFailed
          }) }}
        </p>
        <p v-if="outcome.filesMissing > 0" class="sync-line sync-warning">
          {{ t('e2Ui.outcomeFilesMissing', { count: outcome.filesMissing }) }}
        </p>
        <p v-if="withSpectrograms" class="sync-line muted">
          {{ (isAirSonar ? t('e2Ui.outcomeSnapshots') : t('e2Ui.outcomeSpectrograms'), {
            saved: outcome.spectrogramsSaved,
            failed: outcome.spectrogramsFailed
          }) }}
        </p>
        <p v-if="outcome.skippedBadTime > 0" class="sync-line sync-warning">
          {{ t('e2Ui.outcomeBadTime', { count: outcome.skippedBadTime }) }}
        </p>
        <ul v-if="outcome.errors.length > 0" class="sync-errors">
          <li v-for="(message, index) in outcome.errors" :key="index">{{ message }}</li>
        </ul>
        <p class="sync-line muted">
          {{ t('e2Ui.outcomeHint', { time: formatDateTime(Date.now()) }) }}
        </p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.param-table {
  margin-top: var(--space-3);
}

.param-extra {
  margin-left: 6px;
  font-size: 10.5px;
}

/* 口令类的键不显示值：只显示"已设置"。 */
.param-sensitive {
  color: var(--color-text-secondary);
}

.sync-hint {
  font-size: 11.5px;
}

.sync-actions {
  margin-top: var(--space-2);
  align-items: center;
}

.checkbox-field {
  flex-direction: row;
  align-items: center;
  gap: 6px;
}

.sync-line {
  margin: 4px 0 0;
  font-size: 12px;
}

.sync-warning {
  color: var(--color-warning);
}

.sync-errors {
  margin: 4px 0 0;
  padding-left: 16px;
  font-size: 11.5px;
  color: var(--color-danger);
}
</style>
