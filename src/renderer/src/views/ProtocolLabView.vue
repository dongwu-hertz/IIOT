<script setup lang="ts">
/**
 * Protocol Laboratory (spec section 19).
 *
 * The FA8 documentation leaves five behaviours undefined. Guessing any of them
 * silently would poison the rest of the codebase, so this page exists to MEASURE
 * them against a real device and show the raw evidence to a human:
 *
 *   1. how the login token must be carried (header / query / cookie / body)
 *   2. how `/audio_stream` frames its payload (content-type, chunked, framing)
 *   3. the JSON schema behind `/freq_domain` and `/time_freq_domain`
 *   4. the rule for building a recording download URL
 *   5. what a port value of 0 means in `set_network`
 *
 * All calls go through `window.api.protocol.*`; the renderer performs no HTTP of
 * its own (CSP `connect-src 'none'`). Token values are never returned by the main
 * process — only whether a token existed — so nothing secret can be displayed,
 * logged or copied out of this page.
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DiagnoseReport, EndpointProbeResult } from '@shared/ipc/contract'
import { useDevicesStore } from '@renderer/stores/devices'
import { formatDateTime, formatJsonPreview, summarizeUnknown } from '@renderer/lib/format'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import EmptyState from '@renderer/components/EmptyState.vue'

const { t } = useI18n()

const devices = useDevicesStore()

const selectedDeviceId = ref('')
const diagnosing = ref(false)
const error = ref('')
const notice = ref('')
const report = ref<DiagnoseReport | null>(null)

const probePath = ref('')
const probeMethod = ref('GET')
const probing = ref(false)
const probeResult = ref<EndpointProbeResult | null>(null)
const probeError = ref('')

/** One-click probes for the endpoints the documentation leaves undefined. */
const QUICK_PATHS = ['/get_devinfo', '/audio_stream', '/freq_domain', '/time_freq_domain']

const METHOD_OPTIONS = ['GET', 'POST']

onMounted(async () => {
  if (devices.devices.length === 0) await devices.load()
  selectedDeviceId.value = devices.selectedDeviceId || devices.devices[0]?.id || ''
})

const selectedDevice = computed(() => devices.byId(selectedDeviceId.value))

async function runDiagnose(): Promise<void> {
  if (!selectedDeviceId.value) return
  diagnosing.value = true
  error.value = ''
  notice.value = ''
  const result = await callApi(() => window.api.protocol.diagnose(selectedDeviceId.value))
  diagnosing.value = false
  if (!result.success) {
    error.value = resultMessage(result)
    report.value = null
    return
  }
  report.value = unwrap(result) ?? null
  notice.value = t('labUi.noticeDone')
}

async function runProbe(): Promise<void> {
  const path = probePath.value.trim()
  if (!selectedDeviceId.value) {
    probeError.value = t('labUi.errSelectDevice')
    return
  }
  if (!path) {
    probeError.value = t('labUi.errPathRequired')
    return
  }
  probing.value = true
  probeError.value = ''
  const result = await callApi(() =>
    window.api.protocol.probeEndpoint(selectedDeviceId.value, path, probeMethod.value)
  )
  probing.value = false
  if (!result.success) {
    probeError.value = resultMessage(result)
    probeResult.value = null
    return
  }
  probeResult.value = unwrap(result) ?? null
}

function useQuickPath(path: string): void {
  probePath.value = path
}

// ---------------------------------------------------------------------------
// Report rendering helpers
// ---------------------------------------------------------------------------

const endpoints = computed<EndpointProbeResult[]>(() => report.value?.endpoints ?? [])

const sampledEndpoints = computed(() => endpoints.value.filter((item) => item.sampleHex || item.sampleAscii))

function findEndpoint(fragment: string): EndpointProbeResult | undefined {
  const needle = fragment.toLowerCase()
  return endpoints.value.find((item) => item.path.toLowerCase().includes(needle))
}

/**
 * Recording-library endpoints. Deliberately NOT `findEndpoint('audio')`: that
 * would match `/audio_stream` and mislabel the framing risk as the download risk.
 */
function findRecordingEndpoint(): EndpointProbeResult | undefined {
  return endpoints.value.find((item) => {
    const path = item.path.toLowerCase()
    if (path.includes('stream')) return false
    return path.includes('download') || path.includes('record') || path.includes('audio')
  })
}

function describeEndpoint(item: EndpointProbeResult | undefined): string {
  if (!item) return t('labUi.endpointNotProbed')
  if (!item.ok) {
    return t('labUi.requestFailed', {
      detail: item.error || `HTTP ${item.status ?? t('labUi.httpNoResponse')}`
    })
  }
  const content = item.contentType ?? t('labUi.contentTypeMissing')
  const chunked =
    item.chunked === undefined
      ? t('labUi.chunkedUnknown')
      : item.chunked
        ? t('labUi.chunkedYes')
        : t('labUi.chunkedNo')
  const bytes =
    item.receivedBytes === undefined
      ? t('labUi.bytesUnknown')
      : t('labUi.bytesReceived', { count: item.receivedBytes })
  const sep = t('labUi.summarySeparator')
  const json =
    item.json !== undefined ? sep + t('labUi.jsonFields', { fields: summarizeUnknown(item.json) }) : ''
  return `${content}${sep}${chunked}${sep}${bytes}${json}`
}

/**
 * The five risks, each with a conclusion derived from the report.
 * A risk is only marked "已确认" when the device actually answered — never
 * because a default assumption "usually works".
 */
const riskConclusions = computed(() => {
  const current = report.value
  const tokenKnown = Boolean(current?.authStrategyDetected)
  const audioStream = findEndpoint('audio_stream')
  const freqDomain = findEndpoint('freq_domain')
  const timeFreqDomain = findEndpoint('time_freq_domain')
  const download = findRecordingEndpoint()

  return [
    {
      id: 'token',
      title: t('labUi.risk1Title'),
      question: t('labUi.risk1Question'),
      confirmed: tokenKnown,
      conclusion: tokenKnown
        ? t('labUi.risk1Confirmed', {
            strategy: current?.authStrategyDetected,
            tokenState: current?.loginTokenPresent ? t('labUi.tokenPresent') : t('labUi.tokenAbsent')
          })
        : t('labUi.risk1Pending')
    },
    {
      id: 'audio-stream',
      title: t('labUi.risk2Title'),
      question: t('labUi.risk2Question'),
      confirmed: Boolean(audioStream?.ok),
      conclusion: audioStream
        ? describeEndpoint(audioStream)
        : t('labUi.risk2Pending')
    },
    {
      id: 'freq-domain',
      title: t('labUi.risk3Title'),
      question: t('labUi.risk3Question'),
      confirmed: Boolean(freqDomain?.ok || timeFreqDomain?.ok),
      conclusion: freqDomain?.ok || timeFreqDomain?.ok
        ? `freq_domain：${describeEndpoint(freqDomain)}；time_freq_domain：${describeEndpoint(timeFreqDomain)}`
        : t('labUi.risk3Pending')
    },
    {
      id: 'download',
      title: t('labUi.risk4Title'),
      question: t('labUi.risk4Question'),
      confirmed: Boolean(download?.ok),
      conclusion: download
        ? describeEndpoint(download)
        : t('labUi.risk4Pending')
    },
    {
      id: 'port-zero',
      title: t('labUi.risk5Title'),
      question: t('labUi.risk5Question'),
      confirmed: false,
      conclusion: t('labUi.risk5Pending')
    }
  ]
})

const reportNotes = computed(() => report.value?.notes ?? [])
</script>

<template>
  <div class="page">
    <section class="card lab-intro">
      <h3 class="section-title">{{ t('labUi.introTitle') }}</h3>
      <div class="chip-row lab-risks">
        <span class="chip">{{ t('labUi.chipAuth') }}</span>
        <span class="chip">{{ t('labUi.chipAudioFraming') }}</span>
        <span class="chip">{{ t('labUi.chipFreqSchema') }}</span>
        <span class="chip">{{ t('labUi.chipDownloadUrl') }}</span>
        <span class="chip">{{ t('labUi.chipPortZero') }}</span>
      </div>
    </section>

    <p v-if="error" class="alert alert--danger" role="alert">{{ error }}</p>
    <p v-else-if="notice" class="alert alert--success" role="status">{{ notice }}</p>

    <EmptyState
      v-if="devices.devices.length === 0"
      :title="t('labUi.noDeviceTitle')"
    >
      <RouterLink class="btn btn--primary" to="/devices">{{ t('labUi.goToDevices') }}</RouterLink>
    </EmptyState>

    <template v-else>
      <section class="card">
        <div class="section-header">
          <h3 class="section-title">{{ t('labUi.targetTitle') }}</h3>
          <span v-if="selectedDevice" class="muted lab-hint">
            {{
              t('labUi.deviceLine', {
                uid: selectedDevice.deviceUid,
                address: selectedDevice.ip || t('labUi.noAddress')
              })
            }}
          </span>
        </div>

        <div class="lab-controls">
          <label class="field lab-device">
            <span class="field-label">{{ t('labUi.deviceLabel') }}</span>
            <select v-model="selectedDeviceId" class="select">
              <option v-for="device in devices.devices" :key="device.id" :value="device.id">
                {{ device.name }}（{{ device.ip || t('labUi.noAddress') }}）
              </option>
            </select>
          </label>

          <button
            type="button"
            class="btn btn--primary"
            :disabled="diagnosing || !selectedDeviceId"
            @click="runDiagnose"
          >
            {{ diagnosing ? t('labUi.diagnosing') : t('labUi.runDiagnosis') }}
          </button>
        </div>
      </section>

      <section class="card">
        <div class="section-header">
          <h3 class="section-title">{{ t('labUi.customTitle') }}</h3>
        </div>
        <div class="lab-controls">
          <label class="field lab-path">
            <span class="field-label">{{ t('labUi.pathLabel') }}</span>
            <input
              v-model="probePath"
              class="input mono"
              type="text"
              :placeholder="t('labUi.pathPlaceholder')"
              spellcheck="false"
            />
          </label>
          <label class="field lab-method">
            <span class="field-label">{{ t('labUi.methodLabel') }}</span>
            <select v-model="probeMethod" class="select">
              <option v-for="method in METHOD_OPTIONS" :key="method" :value="method">
                {{ method }}
              </option>
            </select>
          </label>
          <button type="button" class="btn" :disabled="probing || !selectedDeviceId" @click="runProbe">
            {{ probing ? t('labUi.probing') : t('labUi.probe') }}
          </button>
        </div>
        <div class="chip-row lab-quick">
          <button
            v-for="path in QUICK_PATHS"
            :key="path"
            type="button"
            class="chip chip--selectable"
            @click="useQuickPath(path)"
          >
            {{ path }}
          </button>
        </div>
        <p v-if="probeError" class="alert alert--danger lab-probe-error" role="alert">
          {{ probeError }}
        </p>

        <div v-if="probeResult" class="probe-card">
          <div class="probe-card__head">
            <span class="mono">{{ probeResult.method }} {{ probeResult.path }}</span>
            <span class="badge" :class="probeResult.ok ? 'badge--success' : 'badge--danger'">
              {{ probeResult.ok ? t('labUi.ok') : t('labUi.failed') }}
            </span>
          </div>
          <dl class="kv">
            <div class="kv__item">
              <dt class="kv__label">{{ t('labUi.httpStatus') }}</dt>
              <dd class="kv__value">{{ probeResult.status ?? '—' }}</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('labUi.elapsed') }}</dt>
              <dd class="kv__value">{{ probeResult.latencyMs ?? '—' }} ms</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">Content-Type</dt>
              <dd class="kv__value mono">{{ probeResult.contentType || '—' }}</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('labUi.chunked') }}</dt>
              <dd class="kv__value">
                {{
                  probeResult.chunked === undefined
                    ? '—'
                    : probeResult.chunked
                      ? t('labUi.yes')
                      : t('labUi.no')
                }}
              </dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('labUi.receivedBytes') }}</dt>
              <dd class="kv__value">{{ probeResult.receivedBytes ?? '—' }}</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('labUi.error') }}</dt>
              <dd class="kv__value">{{ probeResult.error || '—' }}</dd>
            </div>
          </dl>
          <pre v-if="probeResult.sampleAscii" class="sample">{{ probeResult.sampleAscii }}</pre>
          <pre v-if="probeResult.sampleHex" class="sample sample--hex">{{ probeResult.sampleHex }}</pre>
          <pre v-if="probeResult.json !== undefined" class="sample">{{
            formatJsonPreview(probeResult.json)
          }}</pre>
        </div>
      </section>

      <template v-if="report">
        <section class="card">
          <div class="section-header">
            <h3 class="section-title">{{ t('labUi.reportTitle') }}</h3>
            <span class="muted lab-hint">
              {{ formatDateTime(report.startedAt) }} → {{ formatDateTime(report.finishedAt) }}
            </span>
          </div>
          <dl class="kv">
            <div class="kv__item">
              <dt class="kv__label">{{ t('labUi.detectedAuth') }}</dt>
              <dd class="kv__value mono">{{ report.authStrategyDetected || t('labUi.unconfirmed') }}</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('labUi.loginTokenPresent') }}</dt>
              <dd class="kv__value">
                <span class="badge" :class="report.loginTokenPresent ? 'badge--success' : 'badge--warning'">
                  {{ report.loginTokenPresent ? t('labUi.tokenPresent') : t('labUi.tokenAbsent') }}
                </span>
              </dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('labUi.loginResponseFields') }}</dt>
              <dd class="kv__value mono">
                {{ report.loginFieldNames.length ? report.loginFieldNames.join(', ') : '—' }}
              </dd>
            </div>
          </dl>
          <ul v-if="reportNotes.length" class="notes">
            <li v-for="(note, index) in reportNotes" :key="index" class="notes__item">{{ note }}</li>
          </ul>
        </section>

        <section class="card card--flush">
          <div class="section-header report-head">
            <h3 class="section-title">{{ t('labUi.endpointsTitle') }}</h3>
            <span class="muted lab-hint">{{ t('labUi.endpointCount', { count: endpoints.length }) }}</span>
          </div>
          <div class="table-wrap table-wrap--flush">
            <table class="table">
              <thead>
                <tr>
                  <th>{{ t('labUi.columnPath') }}</th>
                  <th>{{ t('labUi.columnMethod') }}</th>
                  <th>{{ t('labUi.columnResult') }}</th>
                  <th>{{ t('labUi.columnStatus') }}</th>
                  <th>{{ t('labUi.columnElapsed') }}</th>
                  <th>Content-Type</th>
                  <th>{{ t('labUi.columnChunked') }}</th>
                  <th>{{ t('labUi.columnBytes') }}</th>
                  <th>{{ t('labUi.columnError') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="endpoints.length === 0">
                  <td colspan="9" class="table-empty">{{ t('labUi.noEndpointResults') }}</td>
                </tr>
                <tr v-for="(item, index) in endpoints" :key="`${item.method}-${item.path}-${index}`">
                  <td class="mono nowrap">{{ item.path }}</td>
                  <td class="nowrap">{{ item.method }}</td>
                  <td>
                    <span class="badge" :class="item.ok ? 'badge--success' : 'badge--danger'">
                      {{ item.ok ? t('labUi.ok') : t('labUi.failed') }}
                    </span>
                  </td>
                  <td class="nowrap">{{ item.status ?? '—' }}</td>
                  <td class="nowrap">{{ item.latencyMs ?? '—' }} ms</td>
                  <td class="mono nowrap">{{ item.contentType || '—' }}</td>
                  <td class="nowrap">
                    {{
                      item.chunked === undefined
                        ? '—'
                        : item.chunked
                          ? t('labUi.yes')
                          : t('labUi.no')
                    }}
                  </td>
                  <td class="nowrap">{{ item.receivedBytes ?? '—' }}</td>
                  <td class="error-cell">{{ item.error || '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section v-if="sampledEndpoints.length > 0" class="card">
          <div class="section-header">
            <h3 class="section-title">{{ t('labUi.samplesTitle') }}</h3>
          </div>
          <div class="samples">
            <article v-for="item in sampledEndpoints" :key="`sample-${item.method}-${item.path}`" class="sample-block">
              <header class="sample-block__head">
                <span class="mono">{{ item.method }} {{ item.path }}</span>
                <span class="badge">{{ item.contentType || t('labUi.unknownType') }}</span>
              </header>
              <pre v-if="item.sampleAscii" class="sample">{{ item.sampleAscii }}</pre>
              <pre v-if="item.sampleHex" class="sample sample--hex">{{ item.sampleHex }}</pre>
              <pre v-if="item.json !== undefined" class="sample">{{ formatJsonPreview(item.json) }}</pre>
            </article>
          </div>
        </section>

        <section class="card">
          <div class="section-header">
            <h3 class="section-title">{{ t('labUi.conclusionsTitle') }}</h3>
          </div>
          <ul class="risks">
            <li v-for="risk in riskConclusions" :key="risk.id" class="risk">
              <div class="risk__head">
                <span class="risk__title">{{ risk.title }}</span>
                <span class="badge" :class="risk.confirmed ? 'badge--success' : 'badge--warning'">
                  {{ risk.confirmed ? t('labUi.confirmed') : t('labUi.pendingConfirmation') }}
                </span>
              </div>
              <p class="risk__question">{{ risk.question }}</p>
              <p class="risk__conclusion">{{ risk.conclusion }}</p>
            </li>
          </ul>
        </section>
      </template>
    </template>
  </div>
</template>

<style scoped>
.lab-intro {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.lab-text {
  font-size: 12.5px;
  line-height: 1.8;
  color: var(--color-text);
}

.lab-risks {
  gap: 6px;
}

.lab-hint {
  font-size: 11.5px;
}

.lab-controls {
  display: flex;
  align-items: flex-end;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.lab-device {
  min-width: 260px;
}

.lab-path {
  min-width: 240px;
  flex: 1;
}

.lab-method {
  width: 120px;
}

.lab-quick {
  margin-top: var(--space-2);
}

.lab-probe-error {
  margin-top: var(--space-3);
}

.chip--selectable {
  cursor: pointer;
  font-family: inherit;
}

.chip--selectable:hover {
  border-color: var(--color-border-strong);
}

.probe-card {
  margin-top: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-subtle);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.probe-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.report-head {
  padding: 12px 14px 10px;
  margin-bottom: 0;
  border-bottom: 1px solid var(--color-border);
}

.table-wrap--flush {
  border: none;
  border-radius: 0;
}

.error-cell {
  color: var(--color-danger);
  max-width: 260px;
}

.notes {
  margin-top: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.notes__item {
  font-size: 12px;
  color: var(--color-text-secondary);
  padding-left: 12px;
  position: relative;
}

.notes__item::before {
  content: '·';
  position: absolute;
  left: 2px;
}

.samples {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.sample-block {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.sample-block__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 8px 12px;
  background: var(--color-bg-subtle);
  border-bottom: 1px solid var(--color-border);
  font-size: 12px;
}

.sample {
  margin: 0;
  padding: 10px 12px;
  background: var(--color-bg);
  border-top: 1px solid var(--color-border);
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 220px;
  overflow: auto;
  user-select: text;
}

.sample:first-of-type {
  border-top: none;
}

.sample--hex {
  color: var(--color-text-secondary);
}

.risks {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.risk {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.risk__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.risk__title {
  font-size: 12.5px;
  font-weight: 600;
}

.risk__question {
  font-size: 11.5px;
  color: var(--color-text-secondary);
}

.risk__conclusion {
  font-size: 12.5px;
  line-height: 1.7;
}
</style>
