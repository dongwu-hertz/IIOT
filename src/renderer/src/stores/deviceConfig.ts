/**
 * Device configuration store (Phase 9).
 *
 * SCOPE
 * Pinia is a singleton, so this store holds the configuration of ONE device —
 * the one `loadAll(deviceId)` was last called for. Switching device on the
 * detail page re-seeds every slice rather than merging, because a stale
 * threshold from another device's alarm profile is worse than an empty form.
 *
 * WRITES ARE NOT PATCHES ON THE WIRE (this is why some code below looks wrong)
 * Device write endpoints REPLACE the whole object rather than patching it, so a
 * partial channel list silently resets every channel left out of it
 * (PROTOCOL-FINDINGS 5A.2 / 5A.11). The main process therefore performs
 * READ-MODIFY-WRITE for every `update*`/`save*` call. The renderer's job is the
 * opposite of what it looks like: send ONLY the fields the user changed, and let
 * the process that owns the complete object do the merge. Sending a whole object
 * built here would be the dangerous option — the renderer does not know about
 * fields the device requires but does not return (`Rs485ConfigView.portRight`).
 *
 * RULE: no wire-level field name may appear in this file. If you find yourself
 * needing one, the mapping belongs in the main process instead.
 *
 * WRITES REFRESH ONE SLICE
 * Every write already returns the authoritative value for its own block, so the
 * store assigns that value and touches nothing else. A full `loadAll` after a
 * write would be both slow and wrong: a network change in particular would
 * re-read eight endpoints from a device that is busy re-addressing itself.
 *
 * NO ACTION THROWS (spec 14.2)
 * Failures are funnelled into `error` as a human-readable Chinese string through
 * the shared `callApi`/`resultMessage` helpers, and the action resolves normally.
 * Views can render without defensive try/catch.
 */

import { computed, ref, type ComputedRef } from 'vue'
import { defineStore } from 'pinia'
import type { DeviceResult } from '@shared/errors'
import type { NetworkProgressEvent } from '@shared/ipc/contract'
import type {
  AlarmProfileConfig,
  ChannelConfigView,
  ModbusConfigView,
  NetworkChangeResult,
  NetworkConfigView,
  PushConfigView,
  Rs485ConfigView,
  TimeConfigView
} from '@renderer/types/device-config'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import { i18n } from '@renderer/i18n'

/**
 * Sample rates the device accepts (spec 11.2).
 *
 * Only these three were measured; the select is built from this list so the UI
 * cannot offer a value the firmware would reject.
 */
export const SAMPLE_RATE_OPTIONS: readonly number[] = [48000, 96000, 192000]

/** Fields of the network form, for change detection against the read snapshot. */
const NETWORK_FIELDS = [
  'mode',
  'ip',
  'netmask',
  'gateway',
  'dns',
  'httpPort',
  'rtspPort',
  'tcpPort'
] as const

export const useDeviceConfigStore = defineStore('deviceConfig', () => {
  // -------------------------------------------------------------------------
  // State — one slice per configuration block
  // -------------------------------------------------------------------------

  /** Device every slice below belongs to. Also the push filter for progress. */
  const deviceId = ref('')

  const channels = ref<ChannelConfigView[]>([])
  /** Distinguishes "device reported zero channels" from "not read yet". */
  const channelsLoaded = ref(false)

  const sampleRate = ref<number | null>(null)

  const alarmProfiles = ref<AlarmProfileConfig[]>([])

  /**
   * Network form draft.
   *
   * A DRAFT, not the device's current state: the user edits it freely and only
   * `changeNetwork` writes it. `networkOriginal` is the snapshot the draft was
   * seeded from, so the UI can offer "撤销修改" and warn before a risky save.
   */
  const network = ref<NetworkConfigView | null>(null)
  const networkOriginal = ref<NetworkConfigView | null>(null)

  /**
   * Last network progress push.
   *
   * A network change takes up to ~45 s and may roll back, so a spinner is not an
   * acceptable UI: the stage and its detail are the only evidence the operator
   * gets about what the device is doing.
   */
  const networkProgress = ref<NetworkProgressEvent | null>(null)
  /** Outcome of the last completed attempt (success, rollback or lockout). */
  const networkChange = ref<NetworkChangeResult | null>(null)
  const networkChanging = ref(false)

  const time = ref<TimeConfigView | null>(null)
  /**
   * Host clock when `time` was read.
   *
   * Drift must be computed against the instant of the read, not against "now":
   * `deviceTime` is a snapshot, so subtracting a live host clock would invent a
   * growing error that is really just the age of the reading.
   */
  const timeReadAt = ref<number | null>(null)

  const rs485 = ref<Rs485ConfigView | null>(null)
  const serialPorts = ref<string[]>([])
  const modbus = ref<ModbusConfigView | null>(null)
  const push = ref<PushConfigView | null>(null)

  /** Reads in flight; a counter so concurrent loads cannot clear the flag early. */
  const loadingCount = ref(0)
  /** Writes in flight; counter for the same reason. */
  const savingCount = ref(0)

  const loading = computed(() => loadingCount.value > 0)
  const saving = computed(() => savingCount.value > 0)

  const error = ref('')
  /** Host time of the last successful write, for the "已保存 hh:mm:ss" hint. */
  const lastSavedAt = ref<number | null>(null)

  // -------------------------------------------------------------------------
  // Getters
  // -------------------------------------------------------------------------

  /** True when the network draft differs from the last value read from device. */
  const networkDirty: ComputedRef<boolean> = computed(() => {
    const draft = network.value
    const original = networkOriginal.value
    if (!draft || !original) return false
    return NETWORK_FIELDS.some((field) => draft[field] !== original[field])
  })

  /** Alarm profile by id, for showing which profiles channels are bound to. */
  const alarmProfileById = computed(
    () => (profileId: number) =>
      alarmProfiles.value.find((profile) => profile.id === profileId) ?? undefined
  )

  /** Drift in seconds (device clock minus host clock), or null when unknown. */
  const timeDriftSeconds: ComputedRef<number | null> = computed(() => {
    const snapshot = time.value
    const readAt = timeReadAt.value
    if (!snapshot || readAt === null) return null
    return (snapshot.deviceTime - readAt) / 1000
  })

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Run one read, routing failure text into `error` instead of throwing.
   *
   * The failure MESSAGE is returned as well as stored: a per-section refresh has
   * to show why it failed next to the control that was pressed, and re-deriving
   * the text there would lose the code and the detail the main process sent.
   */
  async function read<T>(
    operation: () => Promise<DeviceResult<T>>
  ): Promise<{ ok: true; data?: T } | { ok: false; message: string }> {
    loadingCount.value += 1
    const result = await callApi(operation)
    loadingCount.value -= 1
    if (!result.success) {
      const message = resultMessage(result)
      error.value = message
      return { ok: false, message }
    }
    return { ok: true, data: unwrap(result) }
  }

  /**
   * Run one write, routing failure text into `error` instead of throwing.
   *
   * `lastSavedAt` is only stamped on success — a rejected write must not look
   * like it landed.
   */
  async function write<T>(operation: () => Promise<DeviceResult<T>>): Promise<DeviceResult<T>> {
    savingCount.value += 1
    const result = await callApi(operation)
    savingCount.value -= 1
    if (!result.success) {
      error.value = resultMessage(result)
      return result
    }
    error.value = ''
    lastSavedAt.value = Date.now()
    return result
  }

  // -------------------------------------------------------------------------
  // Reads (one loader per slice, so a refresh can be surgical)
  // -------------------------------------------------------------------------

  async function loadChannels(targetDeviceId: string): Promise<string> {
    const outcome = await read(() => window.api.config.getChannels(targetDeviceId))
    if (!outcome.ok) return outcome.message
    channels.value = outcome.data ?? []
    channelsLoaded.value = true
    return ''
  }

  async function loadSampleRate(targetDeviceId: string): Promise<string> {
    const outcome = await read(() => window.api.config.getSampleRate(targetDeviceId))
    if (!outcome.ok) return outcome.message
    sampleRate.value = outcome.data ?? null
    return ''
  }

  async function loadAlarmProfiles(targetDeviceId: string): Promise<string> {
    const outcome = await read(() => window.api.config.getAlarmProfiles(targetDeviceId))
    if (!outcome.ok) return outcome.message
    alarmProfiles.value = outcome.data ?? []
    return ''
  }

  async function loadNetwork(targetDeviceId: string): Promise<string> {
    const outcome = await read(() => window.api.config.getNetwork(targetDeviceId))
    if (!outcome.ok) return outcome.message
    const value = outcome.data ?? null
    network.value = value
    // The draft is reseeded from the device, so unsaved edits are dropped here
    // on purpose: a failed save must not leave the form claiming values the
    // device never accepted.
    networkOriginal.value = value ? { ...value } : null
    return ''
  }

  async function loadTime(targetDeviceId: string): Promise<string> {
    const outcome = await read(() => window.api.config.getTime(targetDeviceId))
    if (!outcome.ok) return outcome.message
    time.value = outcome.data ?? null
    timeReadAt.value = time.value ? Date.now() : null
    return ''
  }

  async function loadRs485(targetDeviceId: string): Promise<string> {
    const outcome = await read(() => window.api.config.getRs485(targetDeviceId))
    if (!outcome.ok) return outcome.message
    rs485.value = outcome.data ?? null
    return ''
  }

  async function loadSerialPorts(targetDeviceId: string): Promise<string> {
    const outcome = await read(() => window.api.config.getSerialPorts(targetDeviceId))
    if (!outcome.ok) return outcome.message
    serialPorts.value = outcome.data ?? []
    return ''
  }

  async function loadModbus(targetDeviceId: string): Promise<string> {
    const outcome = await read(() => window.api.config.getModbus(targetDeviceId))
    if (!outcome.ok) return outcome.message
    modbus.value = outcome.data ?? null
    return ''
  }

  async function loadPush(targetDeviceId: string): Promise<string> {
    const outcome = await read(() => window.api.config.getPush(targetDeviceId))
    if (!outcome.ok) return outcome.message
    push.value = outcome.data ?? null
    return ''
  }

  /**
   * Read every configuration block for one device.
   *
   * The slices are read in PARALLEL and independently: one unsupported endpoint
   * (the Push block in particular is firmware-dependent) must not blank the whole
   * page, so every failure is collected and reported while the successful slices
   * stay visible.
   */
  async function loadAll(targetDeviceId: string): Promise<void> {
    if (!targetDeviceId) {
      error.value = i18n.global.t('monitorErrors.selectDevice')
      return
    }
    deviceId.value = targetDeviceId
    loadingCount.value += 1
    // Clear first: showing the previous device's thresholds while the new device
    // is being read is worse than showing an empty form for a second.
    channels.value = []
    channelsLoaded.value = false
    sampleRate.value = null
    alarmProfiles.value = []
    network.value = null
    networkOriginal.value = null
    networkChange.value = null
    networkProgress.value = null
    time.value = null
    timeReadAt.value = null
    rs485.value = null
    serialPorts.value = []
    modbus.value = null
    push.value = null

    const failures = (
      await Promise.all([
        loadChannels(targetDeviceId),
        loadSampleRate(targetDeviceId),
        loadAlarmProfiles(targetDeviceId),
        loadNetwork(targetDeviceId),
        loadTime(targetDeviceId),
        loadRs485(targetDeviceId),
        loadSerialPorts(targetDeviceId),
        loadModbus(targetDeviceId),
        loadPush(targetDeviceId)
      ])
    ).filter((message) => message !== '')

    loadingCount.value -= 1
    // The loaders run in parallel and each may have written `error`; the last one
    // wins. Re-state the collected summary so the user sees everything that
    // failed rather than one arbitrary endpoint.
    error.value = failures.length > 0 ? [...new Set(failures)].join('；') : ''
  }

  // -------------------------------------------------------------------------
  // Writes — channels and sample rate
  // -------------------------------------------------------------------------

  /**
   * Update ONE channel.
   *
   * ONLY the changed fields are sent as `patch`. It looks like the other channel
   * fields would be lost, and on the wire they would be — but this call is not
   * the wire: the main process re-reads the channel list, merges this patch, and
   * submits the COMPLETE eight-channel object the device requires
   * (PROTOCOL-FINDINGS 5A.2, 5A.11). Sending a complete object from here would
   * move that merge into the renderer, which is exactly the bug that silently
   * resets channels on a live device.
   */
  async function updateChannel(
    targetDeviceId: string,
    channelIndex: number,
    patch: Partial<Omit<ChannelConfigView, 'channelIndex'>>
  ): Promise<ChannelConfigView[] | undefined> {
    const result = await write(() =>
      window.api.config.updateChannel(targetDeviceId, channelIndex, patch)
    )
    if (!result.success) return undefined
    // The write returns the device's fresh channel list, so no second read is
    // needed and no other slice is touched.
    const rows = unwrap(result)
    if (rows) {
      channels.value = rows
      channelsLoaded.value = true
    }
    return rows
  }

  /**
   * Change the sample rate.
   *
   * The device restarts acquisition, so live streams are interrupted; the view
   * owns that confirmation (spec 11.2). The main process stops monitoring first.
   */
  async function setSampleRate(targetDeviceId: string, rate: number): Promise<number | undefined> {
    const result = await write(() => window.api.config.setSampleRate(targetDeviceId, rate))
    if (!result.success) return undefined
    const applied = unwrap(result)
    if (applied !== undefined) sampleRate.value = applied
    return applied
  }

  // -------------------------------------------------------------------------
  // Writes — alarm profiles
  // -------------------------------------------------------------------------

  /**
   * Create (`id` absent) or update (`id` present) one alarm profile.
   *
   * All fields are always sent by the service, because the device replaces the
   * profile wholesale rather than patching a threshold.
   */
  async function saveAlarmProfile(
    targetDeviceId: string,
    profile: AlarmProfileConfig
  ): Promise<AlarmProfileConfig[] | undefined> {
    const result = await write(() => window.api.config.saveAlarmProfile(targetDeviceId, profile))
    if (!result.success) return undefined
    const rows = unwrap(result)
    if (rows) alarmProfiles.value = rows
    return rows
  }

  /**
   * Delete one alarm profile.
   *
   * The service refuses when a channel is still bound to it, and says which
   * ones; that message is surfaced verbatim rather than re-worded here.
   */
  async function deleteAlarmProfile(
    targetDeviceId: string,
    profileId: number
  ): Promise<AlarmProfileConfig[] | undefined> {
    const result = await write(() =>
      window.api.config.deleteAlarmProfile(targetDeviceId, profileId)
    )
    if (!result.success) return undefined
    const rows = unwrap(result)
    if (rows) alarmProfiles.value = rows
    return rows
  }

  // -------------------------------------------------------------------------
  // Network
  // -------------------------------------------------------------------------

  /**
   * Edit the network draft locally.
   *
   * There is no `config.updateNetwork` in the contract: the device write is the
   * whole reconnect-and-verify transaction (`changeNetwork`), and editing an IP
   * field must not touch the device. This action therefore only moves the draft.
   */
  function updateNetwork(patch: Partial<NetworkConfigView>): void {
    const draft = network.value
    if (!draft) return
    network.value = { ...draft, ...patch }
  }

  /** Throw away unsaved network edits and restore the last value read. */
  function resetNetworkDraft(): void {
    const original = networkOriginal.value
    network.value = original ? { ...original } : null
  }

  /**
   * Apply a network change (the dangerous one): write, reconnect, verify, and
   * roll back on failure — all inside the main process.
   *
   * The returned `NetworkChangeResult` is NOT reduced to a boolean anywhere:
   * `message` is written by the service to be shown to the user verbatim, and it
   * is the only text that distinguishes "rolled back, nothing changed" from
   * "unreachable on both addresses, get physical access".
   */
  async function changeNetwork(
    targetDeviceId: string,
    next: NetworkConfigView
  ): Promise<NetworkChangeResult | undefined> {
    // Subscribe BEFORE the call: the first push ('applying') is emitted while the
    // request is still in flight, and there is no replay.
    subscribeNetworkProgress()
    networkChanging.value = true
    networkChange.value = null
    networkProgress.value = null
    error.value = ''

    // Deliberately not routed through `write()`: the interesting failure here is
    // a SUCCESSFUL call reporting a failed change (rollback or lockout), which
    // must reach the user as the service's own sentence, not as a generic error.
    savingCount.value += 1
    const result = await callApi(() => window.api.config.changeNetwork(targetDeviceId, { ...next }))
    savingCount.value -= 1
    networkChanging.value = false

    if (!result.success) {
      error.value = resultMessage(result)
      return undefined
    }

    const info = unwrap(result)
    if (!info) return undefined

    networkChange.value = info
    if (info.observed) {
      // Covers both outcomes: the verified new configuration, and the snapshot
      // restored by a rollback. Either way the form now shows what the device
      // reports, not what was typed.
      network.value = { ...info.observed }
      networkOriginal.value = { ...info.observed }
    }
    if (info.success) {
      lastSavedAt.value = Date.now()
    } else {
      error.value = info.message
    }
    return info
  }

  // -------------------------------------------------------------------------
  // Time
  // -------------------------------------------------------------------------

  /** Update NTP settings, preserving the fields the caller did not edit. */
  async function updateTime(
    targetDeviceId: string,
    patch: Partial<Omit<TimeConfigView, 'deviceTime'>>
  ): Promise<TimeConfigView | undefined> {
    const result = await write(() => window.api.config.updateTime(targetDeviceId, patch))
    if (!result.success) return undefined
    const value = unwrap(result)
    if (value) {
      time.value = value
      timeReadAt.value = Date.now()
    }
    return value
  }

  /** Set the device clock from this host's clock. */
  async function syncTime(targetDeviceId: string): Promise<TimeConfigView | undefined> {
    const result = await write(() => window.api.config.syncTime(targetDeviceId))
    if (!result.success) return undefined
    const value = unwrap(result)
    if (value) {
      time.value = value
      timeReadAt.value = Date.now()
    }
    return value
  }

  // -------------------------------------------------------------------------
  // RS485 / Modbus
  // -------------------------------------------------------------------------

  /**
   * Update RS485 settings.
   *
   * `patch` may be partial; the service merges it over a fresh read so
   * `portRight` — which the read endpoint does NOT return — is passed back
   * verbatim instead of being cleared by the whole-object write.
   */
  async function updateRs485(
    targetDeviceId: string,
    patch: Partial<Rs485ConfigView>
  ): Promise<Rs485ConfigView | undefined> {
    const result = await write(() => window.api.config.updateRs485(targetDeviceId, patch))
    if (!result.success) return undefined
    const value = unwrap(result)
    if (value) rs485.value = value
    return value
  }

  async function updateModbus(
    targetDeviceId: string,
    patch: Partial<ModbusConfigView>
  ): Promise<ModbusConfigView | undefined> {
    const result = await write(() => window.api.config.updateModbus(targetDeviceId, patch))
    if (!result.success) return undefined
    const value = unwrap(result)
    if (value) modbus.value = value
    return value
  }

  // -------------------------------------------------------------------------
  // Device name
  // -------------------------------------------------------------------------

  /**
   * Rename the device.
   *
   * The name also lives in the device list (`devices` store), which the caller
   * must refresh — this store deliberately does not reach into another store.
   */
  async function setDeviceName(targetDeviceId: string, name: string): Promise<boolean> {
    const result = await write(() => window.api.config.setDeviceName(targetDeviceId, name))
    return result.success
  }

  // -------------------------------------------------------------------------
  // Network progress push
  // -------------------------------------------------------------------------

  let releaseNetworkProgress: (() => void) | null = null

  /**
   * Listen for progress pushes of a running network change.
   *
   * Idempotent: subscribing twice would deliver every stage twice, and — worse —
   * would keep a second closure (and its store reference) alive after unmount.
   */
  function subscribeNetworkProgress(): void {
    if (releaseNetworkProgress) return
    // `window.events` is absent outside Electron (plain vite preview).
    if (typeof window === 'undefined' || !window.events?.onNetworkProgress) return

    releaseNetworkProgress = window.events.onNetworkProgress((event) => {
      // A push can arrive for a device this page is not showing; ignoring it is
      // not an error, it simply belongs to another view.
      if (deviceId.value && event.deviceId !== deviceId.value) return
      networkProgress.value = event
    })
  }

  /**
   * Release the progress listener.
   *
   * MUST be called on unmount: the listener belongs to the preload bridge, not to
   * the component, so it survives navigation and keeps this store — and every
   * config object it holds — alive for the lifetime of the window.
   */
  function unsubscribeNetworkProgress(): void {
    if (!releaseNetworkProgress) return
    try {
      releaseNetworkProgress()
    } catch {
      // Releasing a listener must never throw into an unmount path.
    }
    releaseNetworkProgress = null
  }

  /** True while the progress bridge is installed. Used by the view's status line. */
  const isNetworkProgressSubscribed = (): boolean => releaseNetworkProgress !== null

  function clearError(): void {
    error.value = ''
  }

  return {
    // state
    deviceId,
    channels,
    channelsLoaded,
    sampleRate,
    alarmProfiles,
    network,
    networkOriginal,
    networkProgress,
    networkChange,
    networkChanging,
    time,
    timeReadAt,
    rs485,
    serialPorts,
    modbus,
    push,
    loading,
    saving,
    error,
    lastSavedAt,
    // getters
    networkDirty,
    alarmProfileById,
    timeDriftSeconds,
    // reads
    loadAll,
    loadChannels,
    loadSampleRate,
    loadAlarmProfiles,
    loadNetwork,
    loadTime,
    loadRs485,
    loadSerialPorts,
    loadModbus,
    loadPush,
    // writes
    updateChannel,
    setSampleRate,
    saveAlarmProfile,
    deleteAlarmProfile,
    updateNetwork,
    resetNetworkDraft,
    changeNetwork,
    updateTime,
    syncTime,
    updateRs485,
    updateModbus,
    setDeviceName,
    // push
    subscribeNetworkProgress,
    unsubscribeNetworkProgress,
    isNetworkProgressSubscribed,
    clearError
  }
})
