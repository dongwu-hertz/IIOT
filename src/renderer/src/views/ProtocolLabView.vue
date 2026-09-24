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
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DiagnoseReport, EndpointProbeResult } from '@shared/ipc/contract'
import { useDevicesStore } from '@renderer/stores/devices'
import { formatDateTime, formatJsonPreview, summarizeUnknown } from '@renderer/lib/format'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import EmptyState from '@renderer/components/EmptyState.vue'
import AppModal from '@renderer/components/AppModal.vue'

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

type ResponseTab = 'pretty' | 'raw' | 'hex' | 'meta'
interface ProbeHistoryEntry {
  id: number
  at: number
  result: EndpointProbeResult
}

const responseTab = ref<ResponseTab>('pretty')
const activeResult = ref<EndpointProbeResult | null>(null)
const probeHistory = ref<ProbeHistoryEntry[]>([])
const safeMode = ref(true)
const postConfirmOpen = ref(false)
let historySequence = 0

/** The renderer can only send GET/POST + path through the real IPC contract. */
const endpointLibrary = computed(() => {
  const seen = new Set<string>()
  const items: { path: string; method: string; result?: EndpointProbeResult }[] = []
  for (const path of QUICK_PATHS) {
    const result = endpoints.value.find((item) => item.path === path)
    const method = result?.method ?? 'GET'
    const key = `${method}:${path}`
    seen.add(key)
    items.push({ path, method, result })
  }
  for (const result of endpoints.value) {
    const key = `${result.method}:${result.path}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push({ path: result.path, method: result.method, result })
  }
  return items
})

const endpointGroups = computed(() => {
  const groups = [
    { id: 'device', title: 'Device', items: [] as typeof endpointLibrary.value },
    { id: 'audio', title: 'Audio', items: [] as typeof endpointLibrary.value },
    { id: 'analysis', title: 'Analysis', items: [] as typeof endpointLibrary.value },
    { id: 'recording', title: 'Recording', items: [] as typeof endpointLibrary.value },
    { id: 'other', title: 'Other', items: [] as typeof endpointLibrary.value }
  ]
  for (const item of endpointLibrary.value) {
    const path = item.path.toLowerCase()
    const target = path.includes('audio_stream')
      ? groups[1]
      : path.includes('freq') || path.includes('domain')
        ? groups[2]
        : path.includes('record') || path.includes('download') || path.includes('file')
          ? groups[3]
          : path.includes('dev') || path.includes('info') || path.includes('login')
            ? groups[0]
            : groups[4]
    target?.items.push(item)
  }
  return groups.filter((group) => group.items.length > 0)
})

const responsePretty = computed(() => {
  const current = activeResult.value
  if (!current) return ''
  if (current.json !== undefined) return formatJsonPreview(current.json)
  return current.sampleAscii || current.sampleHex || current.error || ''
})

const responseRaw = computed(() => activeResult.value?.sampleAscii || '')
const responseHex = computed(() => activeResult.value?.sampleHex || '')

function endpointStateClass(item: { result?: EndpointProbeResult }): string {
  if (!item.result) return 'endpoint-state--idle'
  return item.result.ok ? 'endpoint-state--ok' : 'endpoint-state--failed'
}

function selectEndpoint(item: { path: string; method: string; result?: EndpointProbeResult }): void {
  probePath.value = item.path
  probeMethod.value = METHOD_OPTIONS.includes(item.method) ? item.method : 'GET'
  activeResult.value = item.result ?? null
  responseTab.value = item.result?.json !== undefined ? 'pretty' : item.result?.sampleAscii ? 'raw' : item.result?.sampleHex ? 'hex' : 'meta'
}

function selectHistory(entry: ProbeHistoryEntry): void {
  activeResult.value = entry.result
  probePath.value = entry.result.path
  probeMethod.value = METHOD_OPTIONS.includes(entry.result.method) ? entry.result.method : 'GET'
  responseTab.value = entry.result.json !== undefined ? 'pretty' : entry.result.sampleAscii ? 'raw' : entry.result.sampleHex ? 'hex' : 'meta'
}

function pushHistory(result: EndpointProbeResult): void {
  probeHistory.value = [
    { id: ++historySequence, at: Date.now(), result },
    ...probeHistory.value
  ].slice(0, 50)
}

onMounted(async () => {
  if (devices.devices.length === 0) await devices.load()
  selectedDeviceId.value = devices.selectedDeviceId || devices.devices[0]?.id || ''
})

const selectedDevice = computed(() => devices.byId(selectedDeviceId.value))

watch(selectedDeviceId, () => {
  report.value = null
  probeResult.value = null
  activeResult.value = null
  probeHistory.value = []
  error.value = ''
  probeError.value = ''
  notice.value = ''
})

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
  const first = report.value?.endpoints?.[0]
  if (first) {
    activeResult.value = first
    probePath.value = first.path
    probeMethod.value = METHOD_OPTIONS.includes(first.method) ? first.method : 'GET'
    responseTab.value = first.json !== undefined ? 'pretty' : first.sampleAscii ? 'raw' : first.sampleHex ? 'hex' : 'meta'
  }
}

async function executeProbe(): Promise<void> {
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
  if (probeResult.value) {
    activeResult.value = probeResult.value
    pushHistory(probeResult.value)
    responseTab.value = probeResult.value.json !== undefined
      ? 'pretty'
      : probeResult.value.sampleAscii
        ? 'raw'
        : probeResult.value.sampleHex
          ? 'hex'
          : 'meta'
  }
}

function runProbe(): void {
  if (safeMode.value && probeMethod.value === 'POST') {
    postConfirmOpen.value = true
    return
  }
  void executeProbe()
}

function confirmPostProbe(): void {
  postConfirmOpen.value = false
  void executeProbe()
}

function useQuickPath(path: string): void {
  const item = endpointLibrary.value.find((entry) => entry.path === path)
  if (item) selectEndpoint(item)
  else {
    probePath.value = path
    probeMethod.value = 'GET'
    activeResult.value = null
  }
}

// ---------------------------------------------------------------------------
// Report rendering helpers
// ---------------------------------------------------------------------------

const endpoints = computed<EndpointProbeResult[]>(() => report.value?.endpoints ?? [])

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
  <div class="page protocol-page">
    <p v-if="error" class="alert alert--danger" role="alert">{{ error }}</p>
    <p v-else-if="notice" class="alert alert--success" role="status">{{ notice }}</p>

    <EmptyState v-if="devices.devices.length === 0" :title="t('labUi.noDeviceTitle')">
      <RouterLink class="btn btn--primary" to="/devices">{{ t('labUi.goToDevices') }}</RouterLink>
    </EmptyState>

    <template v-else>
      <section class="lab-toolbar card">
        <div class="lab-toolbar__identity">
          <div class="lab-toolbar__eyebrow">Protocol Laboratory</div>
          <div v-if="selectedDevice" class="lab-toolbar__device-line">
            <span class="status-dot" aria-hidden="true"></span>
            <strong>{{ selectedDevice.name }}</strong>
            <span class="muted mono">{{ selectedDevice.ip || t('labUi.noAddress') }}</span>
            <span class="muted">{{ selectedDevice.deviceUid }}</span>
          </div>
        </div>

        <label class="field lab-toolbar__device">
          <span class="field-label">{{ t('labUi.deviceLabel') }}</span>
          <select v-model="selectedDeviceId" class="select">
            <option v-for="device in devices.devices" :key="device.id" :value="device.id">
              {{ device.name }}（{{ device.ip || t('labUi.noAddress') }}）
            </option>
          </select>
        </label>

        <label class="safe-mode" title="POST requests require confirmation while Safe Mode is enabled.">
          <input v-model="safeMode" type="checkbox" />
          <span>Safe Mode</span>
        </label>

        <button
          type="button"
          class="btn btn--primary"
          :disabled="diagnosing || !selectedDeviceId"
          @click="runDiagnose"
        >
          {{ diagnosing ? t('labUi.diagnosing') : t('labUi.runDiagnosis') }}
        </button>
      </section>

      <div class="lab-workbench">
        <aside class="lab-sidebar card" aria-label="Protocol endpoints">
          <div class="lab-pane-head">
            <span class="lab-pane-title">{{ t('labUi.endpointsTitle') }}</span>
            <span class="muted">{{ endpointLibrary.length }}</span>
          </div>

          <div class="endpoint-tree">
            <section v-for="group in endpointGroups" :key="group.id" class="endpoint-group">
              <div class="endpoint-group__title">{{ group.title }}</div>
              <button
                v-for="item in group.items"
                :key="`${item.method}-${item.path}`"
                type="button"
                class="endpoint-row"
                :class="{
                  'endpoint-row--active': activeResult?.path === item.path && activeResult?.method === item.method
                }"
                @click="selectEndpoint(item)"
              >
                <span class="endpoint-state" :class="endpointStateClass(item)" aria-hidden="true"></span>
                <span class="endpoint-method">{{ item.method }}</span>
                <span class="endpoint-path mono">{{ item.path }}</span>
                <span v-if="item.result?.status" class="endpoint-status">{{ item.result.status }}</span>
              </button>
            </section>
          </div>

          <div class="lab-history">
            <div class="lab-pane-head lab-pane-head--sub">
              <span class="lab-pane-title">History</span>
              <span class="muted">{{ probeHistory.length }}</span>
            </div>
            <p v-if="probeHistory.length === 0" class="muted lab-empty">No requests in this session.</p>
            <button
              v-for="entry in probeHistory"
              :key="entry.id"
              type="button"
              class="history-row"
              @click="selectHistory(entry)"
            >
              <span class="history-row__time">{{ formatDateTime(entry.at) }}</span>
              <span class="history-row__request mono">{{ entry.result.method }} {{ entry.result.path }}</span>
              <span :class="entry.result.ok ? 'history-row__ok' : 'history-row__failed'">
                {{ entry.result.status ?? (entry.result.ok ? 'OK' : 'ERR') }}
              </span>
            </button>
          </div>
        </aside>

        <main class="lab-console card">
          <div class="request-bar">
            <select v-model="probeMethod" class="select request-bar__method" aria-label="HTTP method">
              <option v-for="method in METHOD_OPTIONS" :key="method" :value="method">{{ method }}</option>
            </select>
            <input
              v-model="probePath"
              class="input mono request-bar__path"
              type="text"
              :placeholder="t('labUi.pathPlaceholder')"
              spellcheck="false"
              @keydown.enter.prevent="runProbe"
            />
            <button type="button" class="btn btn--primary" :disabled="probing || !selectedDeviceId" @click="runProbe">
              {{ probing ? t('labUi.probing') : t('labUi.probe') }}
            </button>
          </div>

          <div class="quick-strip" aria-label="Quick endpoints">
            <button
              v-for="path in QUICK_PATHS"
              :key="path"
              type="button"
              class="quick-endpoint mono"
              @click="useQuickPath(path)"
            >
              {{ path }}
            </button>
          </div>

          <p v-if="probeError" class="alert alert--danger" role="alert">{{ probeError }}</p>

          <div class="response-head">
            <div>
              <div class="response-title">
                <template v-if="activeResult">
                  <span class="mono">{{ activeResult.method }} {{ activeResult.path }}</span>
                  <span class="badge" :class="activeResult.ok ? 'badge--success' : 'badge--danger'">
                    {{ activeResult.ok ? t('labUi.ok') : t('labUi.failed') }}
                  </span>
                </template>
                <span v-else>{{ t('labUi.customTitle') }}</span>
              </div>
              <div v-if="activeResult" class="response-summary muted">
                {{ activeResult.status ?? '—' }} · {{ activeResult.latencyMs ?? '—' }} ms ·
                {{ activeResult.receivedBytes ?? '—' }} B
              </div>
            </div>
          </div>

          <div class="response-tabs" role="tablist" aria-label="Response representation">
            <button type="button" class="response-tab" :class="{ 'response-tab--active': responseTab === 'pretty' }" @click="responseTab = 'pretty'">Pretty</button>
            <button type="button" class="response-tab" :class="{ 'response-tab--active': responseTab === 'raw' }" @click="responseTab = 'raw'">Raw</button>
            <button type="button" class="response-tab" :class="{ 'response-tab--active': responseTab === 'hex' }" @click="responseTab = 'hex'">Hex</button>
            <button type="button" class="response-tab" :class="{ 'response-tab--active': responseTab === 'meta' }" @click="responseTab = 'meta'">Metadata</button>
          </div>

          <div class="response-body">
            <div v-if="!activeResult" class="response-empty">
              <span class="response-empty__icon">↯</span>
              <span>Select an endpoint or send a request to inspect its response.</span>
            </div>

            <pre v-else-if="responseTab === 'pretty'" class="response-code">{{ responsePretty || '—' }}</pre>
            <pre v-else-if="responseTab === 'raw'" class="response-code">{{ responseRaw || '—' }}</pre>
            <pre v-else-if="responseTab === 'hex'" class="response-code response-code--hex">{{ responseHex || '—' }}</pre>

            <dl v-else class="response-meta kv">
              <div class="kv__item"><dt class="kv__label">{{ t('labUi.columnStatus') }}</dt><dd class="kv__value">{{ activeResult.status ?? '—' }}</dd></div>
              <div class="kv__item"><dt class="kv__label">{{ t('labUi.columnElapsed') }}</dt><dd class="kv__value">{{ activeResult.latencyMs ?? '—' }} ms</dd></div>
              <div class="kv__item"><dt class="kv__label">Content-Type</dt><dd class="kv__value mono">{{ activeResult.contentType || '—' }}</dd></div>
              <div class="kv__item"><dt class="kv__label">{{ t('labUi.chunked') }}</dt><dd class="kv__value">{{ activeResult.chunked === undefined ? '—' : activeResult.chunked ? t('labUi.yes') : t('labUi.no') }}</dd></div>
              <div class="kv__item"><dt class="kv__label">{{ t('labUi.receivedBytes') }}</dt><dd class="kv__value">{{ activeResult.receivedBytes ?? '—' }}</dd></div>
              <div class="kv__item"><dt class="kv__label">{{ t('labUi.error') }}</dt><dd class="kv__value text-danger">{{ activeResult.error || '—' }}</dd></div>
            </dl>
          </div>

          <section v-if="report" class="diagnostic-summary">
            <div class="lab-pane-head">
              <span class="lab-pane-title">{{ t('labUi.reportTitle') }}</span>
              <span class="muted">{{ formatDateTime(report.startedAt) }} → {{ formatDateTime(report.finishedAt) }}</span>
            </div>
            <div class="diagnostic-meta">
              <span class="chip">Auth: {{ report.authStrategyDetected || t('labUi.unconfirmed') }}</span>
              <span class="chip">Token: {{ report.loginTokenPresent ? t('labUi.tokenPresent') : t('labUi.tokenAbsent') }}</span>
              <span v-if="report.loginFieldNames.length" class="chip mono">{{ report.loginFieldNames.join(', ') }}</span>
            </div>
            <ul v-if="reportNotes.length" class="notes">
              <li v-for="(note, index) in reportNotes" :key="index" class="notes__item">{{ note }}</li>
            </ul>
          </section>
        </main>

        <aside class="lab-findings card">
          <div class="lab-pane-head">
            <span class="lab-pane-title">{{ t('labUi.conclusionsTitle') }}</span>
            <span class="muted">{{ riskConclusions.filter((risk) => risk.confirmed).length }}/{{ riskConclusions.length }}</span>
          </div>

          <div class="finding-list">
            <article v-for="risk in riskConclusions" :key="risk.id" class="finding">
              <div class="finding__head">
                <span class="finding__state" :class="risk.confirmed ? 'finding__state--ok' : 'finding__state--pending'" aria-hidden="true"></span>
                <span class="finding__title">{{ risk.title }}</span>
                <span class="badge" :class="risk.confirmed ? 'badge--success' : 'badge--warning'">
                  {{ risk.confirmed ? t('labUi.confirmed') : t('labUi.pendingConfirmation') }}
                </span>
              </div>
              <p class="finding__question">{{ risk.question }}</p>
              <p class="finding__conclusion">{{ risk.conclusion }}</p>
            </article>
          </div>

          <div class="lab-scope-note">
            <strong>Real capability only</strong>
            <p>The renderer can send only GET/POST + path through the current IPC contract. Headers, JSON body and credentials are intentionally not simulated here.</p>
          </div>
        </aside>
      </div>
    </template>

    <AppModal v-model="postConfirmOpen" title="Send POST request?" width="520px">
      <p>This request may modify the selected device.</p>
      <p class="mono post-target">POST {{ probePath }}</p>
      <p class="muted">Safe Mode requires confirmation before sending POST requests. No request body or custom headers are added by this UI.</p>
      <template #footer>
        <button type="button" class="btn" @click="postConfirmOpen = false">{{ t('common.cancel') }}</button>
        <button type="button" class="btn btn--danger" @click="confirmPostProbe">Send Request</button>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
.protocol-page {
  gap: var(--space-3);
}

.lab-toolbar {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) minmax(220px, 320px) auto auto;
  align-items: end;
  gap: var(--space-3);
  padding: 12px 14px;
}

.lab-toolbar__identity {
  min-width: 0;
}

.lab-toolbar__eyebrow,
.lab-pane-title {
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.01em;
  color: var(--color-text);
}

.lab-toolbar__device-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin-top: 5px;
  font-size: 11.5px;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--color-success, #2f855a);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-success, #2f855a) 12%, transparent);
}

.lab-toolbar__device {
  min-width: 0;
}

.safe-mode {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 34px;
  padding: 0 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  font-size: 11.5px;
  white-space: nowrap;
  background: var(--color-bg-subtle);
}

.lab-workbench {
  display: grid;
  grid-template-columns: minmax(210px, 0.8fr) minmax(440px, 2.25fr) minmax(260px, 1fr);
  gap: var(--space-3);
  min-height: 640px;
  align-items: stretch;
}

.lab-sidebar,
.lab-console,
.lab-findings {
  min-width: 0;
  padding: 0;
  overflow: hidden;
}

.lab-sidebar,
.lab-findings {
  display: flex;
  flex-direction: column;
}

.lab-console {
  display: flex;
  flex-direction: column;
}

.lab-pane-head {
  min-height: 42px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 0 12px;
  border-bottom: 1px solid var(--color-border);
}

.lab-pane-head--sub {
  min-height: 36px;
  padding: 0;
  border-top: 1px solid var(--color-border);
  border-bottom: none;
}

.endpoint-tree {
  padding: 8px;
  overflow: auto;
  flex: 1 1 auto;
}

.endpoint-group + .endpoint-group {
  margin-top: 10px;
}

.endpoint-group__title {
  padding: 4px 7px 6px;
  font-size: 10px;
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-secondary);
}

.endpoint-row {
  width: 100%;
  display: grid;
  grid-template-columns: 8px 34px minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  padding: 7px;
  text-align: left;
  cursor: pointer;
}

.endpoint-row:hover,
.endpoint-row--active {
  background: var(--color-bg-hover);
}

.endpoint-row--active {
  box-shadow: inset 2px 0 0 var(--color-primary, #ff6a1a);
}

.endpoint-state {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-border-strong);
}

.endpoint-state--ok { background: var(--color-success, #2f855a); }
.endpoint-state--failed { background: var(--color-danger, #d64545); }
.endpoint-state--idle { background: var(--color-text-tertiary, #9ca3af); }

.endpoint-method {
  font-size: 9px;
  font-weight: 700;
  color: var(--color-text-secondary);
}

.endpoint-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
}

.endpoint-status {
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-secondary);
}

.lab-history {
  flex: 0 0 210px;
  overflow: auto;
  padding: 0 8px 8px;
  background: color-mix(in srgb, var(--color-bg-subtle) 65%, transparent);
}

.lab-empty {
  padding: 8px 4px;
  font-size: 11px;
}

.history-row {
  width: 100%;
  display: grid;
  grid-template-columns: 58px minmax(0, 1fr) auto;
  gap: 6px;
  align-items: center;
  padding: 6px 4px;
  border: 0;
  border-top: 1px solid var(--color-border);
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.history-row:first-of-type { border-top: 0; }
.history-row:hover { background: var(--color-bg-hover); }
.history-row__time { font-size: 9.5px; color: var(--color-text-secondary); }
.history-row__request { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; }
.history-row__ok { color: var(--color-success, #2f855a); font-size: 10px; }
.history-row__failed { color: var(--color-danger, #d64545); font-size: 10px; }

.request-bar {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr) auto;
  gap: 8px;
  padding: 12px;
  border-bottom: 1px solid var(--color-border);
}

.request-bar__method,
.request-bar__path {
  min-width: 0;
}

.quick-strip {
  display: flex;
  gap: 6px;
  padding: 8px 12px;
  overflow-x: auto;
  border-bottom: 1px solid var(--color-border);
}

.quick-endpoint {
  flex: none;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-bg-subtle);
  color: var(--color-text-secondary);
  padding: 4px 8px;
  font-size: 10px;
  cursor: pointer;
}

.quick-endpoint:hover {
  border-color: var(--color-border-strong);
  color: var(--color-text);
}

.lab-console > .alert {
  margin: 8px 12px 0;
}

.response-head {
  min-height: 54px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
}

.response-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
}

.response-summary {
  margin-top: 4px;
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}

.response-tabs {
  display: flex;
  gap: 18px;
  padding: 0 12px;
  border-bottom: 1px solid var(--color-border);
}

.response-tab {
  position: relative;
  border: 0;
  background: transparent;
  color: var(--color-text-secondary);
  padding: 8px 0 9px;
  font-size: 11px;
  cursor: pointer;
}

.response-tab--active {
  color: var(--color-text);
  font-weight: 600;
}

.response-tab--active::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: var(--color-primary, #ff6a1a);
}

.response-body {
  min-height: 340px;
  flex: 1 1 auto;
  overflow: auto;
  background: color-mix(in srgb, var(--color-bg-subtle) 45%, transparent);
}

.response-code {
  margin: 0;
  min-height: 340px;
  padding: 14px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}

.response-code--hex { color: var(--color-text-secondary); }

.response-empty {
  min-height: 340px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--color-text-secondary);
  font-size: 11.5px;
}

.response-empty__icon {
  font-size: 24px;
  opacity: 0.45;
}

.response-meta {
  padding: 12px;
}

.diagnostic-summary {
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-subtle);
}

.diagnostic-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 12px 0;
}

.notes {
  margin: 8px 12px 12px 26px;
  padding: 0;
}

.notes__item {
  margin-top: 4px;
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--color-text-secondary);
}

.finding-list {
  padding: 8px;
  overflow: auto;
  flex: 1 1 auto;
}

.finding {
  padding: 10px;
  border-radius: 8px;
  border: 1px solid var(--color-border);
  background: var(--color-bg);
}

.finding + .finding { margin-top: 8px; }

.finding__head {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
}

.finding__state {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.finding__state--ok { background: var(--color-success, #2f855a); }
.finding__state--pending { background: var(--color-warning, #d18b00); }

.finding__title {
  font-size: 11.5px;
  font-weight: 650;
}

.finding__question {
  margin: 7px 0 0 15px;
  font-size: 10.5px;
  line-height: 1.45;
  color: var(--color-text-secondary);
}

.finding__conclusion {
  margin: 5px 0 0 15px;
  font-size: 10.5px;
  line-height: 1.55;
}

.lab-scope-note {
  margin: 8px;
  padding: 10px;
  border-radius: 8px;
  background: var(--color-bg-subtle);
  font-size: 10.5px;
  line-height: 1.55;
  color: var(--color-text-secondary);
}

.lab-scope-note strong {
  display: block;
  margin-bottom: 3px;
  color: var(--color-text);
}

.post-target {
  padding: 9px 10px;
  border: 1px solid var(--color-border);
  border-radius: 7px;
  background: var(--color-bg-subtle);
}

@media (max-width: 1180px) {
  .lab-workbench {
    grid-template-columns: 220px minmax(0, 1fr);
  }

  .lab-findings {
    grid-column: 1 / -1;
    min-height: 0;
  }

  .finding-list {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 820px) {
  .lab-toolbar {
    grid-template-columns: 1fr;
    align-items: stretch;
  }

  .lab-workbench {
    grid-template-columns: 1fr;
  }

  .lab-sidebar {
    max-height: 360px;
  }

  .request-bar {
    grid-template-columns: 82px minmax(0, 1fr);
  }

  .request-bar .btn {
    grid-column: 1 / -1;
  }

  .finding-list {
    grid-template-columns: 1fr;
  }
}
</style>
