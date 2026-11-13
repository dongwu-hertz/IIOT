/**
 * English.
 *
 * Typed against `MessageSchema`, which is derived from the Chinese reference
 * locale — a missing or renamed key is a compile error, not a runtime surprise.
 */

import type { MessageSchema } from '../schema'

export const en: MessageSchema = {
  /**
   * Device tree in the left sidebar (multi-device topology + selection).
   *
   * Same hard rule as `cameraLiveUi`: **no message in this block may contain `@`**
   * (vue-i18n's linked-message sigil — it fails to compile at render time, and
   * `tests/i18n.test.ts` compiles every message to prove it).
   */
  common: {
    confirm: 'Confirm',
    cancel: 'Cancel',
    save: 'Save',
    saving: 'Saving…',
    delete: 'Delete',
    edit: 'Edit',
    close: 'Close',
    refresh: 'Refresh',
    reset: 'Reset',
    loading: 'Loading…',
    none: 'None',
    unknown: 'Unknown',
    clearSelection: 'Clear selection',
    viewAll: 'View all',
    unit: {
    }
  },

  errors: {
    DEVICE_OFFLINE: 'The device is offline and cannot be reached',
    TIMEOUT: 'The request timed out. Check the network or the device.',
    AUTH_FAILED: 'Authentication failed. Check the username and password.',
    INVALID_RESPONSE: 'The device returned data in an unrecognised format',
    DEVICE_ERROR: 'The device reported an error',
    STORAGE_ERROR: 'A local storage operation failed',
    RECORDING_EMPTY: 'Recording failed: the file was empty (0 bytes) and has been deleted. Check disk space and the camera stream, then try again',
    RECORDING_INCOMPLETE: 'Recording failed: the file is incomplete (missing the moov index) and has been deleted. The video stream may have been interrupted during recording',
    DISK_FULL: 'Not enough free disk space; non-essential recording is paused',
    NETWORK_ERROR: 'Network connection failed',
    VALIDATION_ERROR: 'The input is not valid',
    NOT_IMPLEMENTED: 'This feature is not available',
    UNKNOWN: 'An unknown error occurred',
    fallback: 'The operation failed',
    deviceDetail: 'Device response: {detail}',
    withCode: '{message} ({code})',
    /** Technical diagnostic detail (e.g. ffmpeg's stderr tail) appended after the catalogue message; the detail is technical English shared by all locales. */
    withDetail: '{message} ({detail})',
    bridgeUnavailable: 'Cannot reach the main process. Please restart the app.',
    bridgeUnavailableDetail: '{message}: {detail}',
    FORBIDDEN: 'This account is not allowed to perform that action',
    AUTH_USERNAME_TAKEN: 'That username is already taken',
    AUTH_LAST_ADMIN: 'At least one administrator account must remain',
    AUTH_PASSWORD_POLICY: 'The password does not meet the requirements (8+ characters, no username, no leading or trailing space)',
    AUTH_LOCKED: 'Too many failed sign-in attempts. Please try again shortly.',
    authLockedRetry: 'Too many failed sign-in attempts. Try again in {seconds} seconds.'
  },

  language: {
    label: 'Interface language',
    description: 'Takes effect immediately and your choice is remembered.'
  },

  /** Calendar range picker (the "one calendar" shared by the alarm and event centers). */
  picker: {
    placeholder: 'Select time range',
    presetAll: 'All',
    presetToday: 'Today',
    preset1h: 'Last hour',
    preset24h: 'Last 24 hours',
    preset7d: 'Last 7 days',
    prevMonth: 'Previous month',
    nextMonth: 'Next month',
    startTime: 'Start time',
    endTime: 'End time',
    clear: 'Clear',
    confirm: 'OK',
    sun: 'Su',
    mon: 'Mo',
    tue: 'Tu',
    wed: 'We',
    thu: 'Th',
    fri: 'Fr',
    sat: 'Sa'
  },

  app: {
    title: 'HAIS',
    tagline: 'Device management software',
    /** Sidebar collapse toggle (event centre spec §3.2). */
    collapseSidebar: 'Collapse sidebar',
    expandSidebar: 'Expand sidebar',
    nav: {
      overview: 'Overview',
      devices: 'Devices',
      monitor: 'Live monitoring',
      trends: 'Trends',
      alarms: 'Alarm center',
      /**
       * Map information (GIS). Renamed from "Device map" and moved to sit directly under
       * Overview (owner batch 10, item 12: the page also carries a GIS service or floor plan,
       * so "device map" no longer covers it).
       */
      map: 'Map information',
      /**
       * Event & alarm centre. Unlike `/alarms` (acoustic-box rows only) this page
       * merges three sources newest-first: camera detection logs, local alarm
       * linkage and the box's own alarms.
       */
      events: 'Event centre',
      recordings: 'Recordings',
      samples: 'Sample library',
      settings: 'Settings',
      protocolLab: 'Protocol Lab',
      deviceDetail: 'Device details'
    },
    versionFallback: 'Version —',
    footerCopyright: 'Copyright © {year} HERTZINNO',
    mainNavigation: 'Main navigation',
    releasedOn: "Released {date}",
    builtOn: "Built {date}",
    appVersion: "Application version",
    releaseDate: "Release date",
    buildDate: "Build date",
    operatingSystem: "Operating system",
    databasePath: "Database path",
    storageRootPath: "Storage root",
    copyPath: "Copy",
    copiedPath: "Copied"
  },

  settingsUi: {
    saveButton: 'Save settings',
    revert: 'Discard changes',
    loadFailedTitle: 'Could not read the settings',
    reload: 'Try again',

    /** Tabs (owner 2026-09-17 ③: language / storage / video / alarm / email / account / about). */
    tabLanguage: 'Language',
    tabGeneral: 'General',
    tabIntegration: 'Integrations',
    tabGisServices: 'GIS services',
    cacheCardTitle: 'Cache',
    mapSourceLabel: 'Map source',
    mapSourceLocal: 'Local cached map',
    mapSourceLocalHint: 'Uses tiles downloaded on this machine; download below first.',
    mapDefaultBadge: 'Default',
    mapKeyRequired: 'This service requires an API key',
    mapCacheGroup: 'Tile cache download',
    mapCacheZoomMin: 'Min zoom',
    mapCacheZoomMax: 'Max zoom',
    mapCacheSouth: 'South',
    mapCacheWest: 'West',
    mapCacheNorth: 'North',
    mapCacheEast: 'East',
    mapCacheUseCenter: 'Fill current center',
    mapCacheStart: 'Start download',
    mapCacheRunning: 'Downloading…',
    mapCacheNeedTemplate: 'Pick a map service and fill the URL template first.',
    mapCacheBadZoom: 'Zoom range must be {min}–{max}',
    mapCacheBadBounds: 'The bounds are not valid',
    mapCacheResult: 'Downloaded {downloaded} · skipped {skipped} · failed {failed} · {size}',
    mapCacheProgressText: 'Processed {done}/{total} (failed {failed})',
    linkageEnabledOn: 'Enabled',
    linkageEnabledOff: 'Disabled',
    tabStorage: 'Storage',
    tabVideo: 'Video & buffering',
    tabAlarm: 'Alarms',

    /*
     * GIS / online basemap (owner 2026-09-19, extra item 1).
     *
     * Not in the manual: the manual has no map or tile-service chapter. The page name, the global provider
presets, the licence boundaries
     * presets, the licence boundaries, off-by-default, https-only, time-zone centre and zoom 2–18
     * are all this software own choices; the rules live in @shared/domain/map-tiles.
     */

    mapGroupService: 'Basemap service (online tiles)',
    mapEnable: 'Enable online basemap',
    mapEnableHint: 'Off by default: while it is off this page keeps using the local offline grid and never touches the network. When enabled, only https XYZ tile URLs are accepted and attribution is mandatory.',
    mapPresetsLabel: 'Free service presets',
    mapPresetsHint: "Presets are ordered free public, then global commercial / bring-your-own-key, then China regional, then custom. Commercial templates are pre-filled from public documentation; verify them against the provider documentation before use.",
    mapPresetOsm: 'OpenStreetMap standard tiles',
    mapPresetCarto: 'CARTO Basemaps',
    mapPresetTianditu: 'Tianditu',
    mapPresetCustom: 'Custom XYZ',
    mapPresetOpentopomap: "OpenTopoMap (terrain)",
    mapPresetEsri: "Esri World Street Map",
    mapPresetMaptiler: "MapTiler Cloud",
    mapPresetMapbox: "Mapbox",
    mapPresetTomtom: "TomTom Maps",
    mapPresetStadia: "Stadia Maps (Stamen family)",
    mapBoundaryOsm: 'Licence boundary: free; attribution © OpenStreetMap contributors is mandatory. The Tile Usage Policy forbids heavy or bulk use and does not accept it as a default basemap; this software ships with the layer off.',
    mapBoundaryCarto: 'Licence boundary: free basemap, attribution © CARTO © OpenStreetMap contributors is mandatory. We could not find an explicit commercial or high-traffic clause, so it is marked as unconfirmed; do not treat it as cleared for commercial use.',
    mapBoundaryTianditu: 'Licence boundary: free, but the owner must apply for a key; quotas apply and commercial use needs separate authorisation. This software cannot apply for the key or guarantee the quota.',
    mapBoundaryCustom: 'Licence boundary: whatever the XYZ provider you choose requires. This software only checks https and placeholders; it does not judge whether your licence covers your use.',
    mapBoundaryOpentopomap: "Licence boundary: free; attribution \"Map data © OpenStreetMap contributors, SRTM | Map style © OpenTopoMap (CC-BY-SA)\" is mandatory. Usage policy is similar to OSM: heavy or bulk use is not accepted, and this is not a default basemap.",
    mapBoundaryKeyProvider: "Licence boundary: {service} normally requires you to register and obtain a key (free tiers may exist, paid plans may apply). Attribution, rate and concurrency limits and commercial terms are set by that provider. This software cannot apply for the key, does not guarantee quota or availability, and does not judge whether your licence covers your use.",
    mapBoundaryEsri: "Licence boundary: Esri public basemap services; we did not confirm an explicit free commercial clause, so this is marked as unconfirmed. Verify against the Esri master agreement and your account before use; if a token is required, use a custom XYZ template with a key placeholder. This software does not make it the default.",
    mapGroupTemplate: 'XYZ template and attribution',
    mapUrlTemplate: 'XYZ template',
    mapUrlHint: 'Must contain the z, x and y placeholders; s rotates subdomains and key inserts the key below. Only https:// is accepted.',
    mapKey: 'Key (optional)',
    mapKeyHint: 'Put the key for Tianditu and similar services here; it is stored in the local settings database and is not written to logs.',
    mapAttribution: 'Attribution text',
    mapAttributionHint: 'Shown at the bottom-right of the map; it cannot be empty while the layer is enabled.',
    mapErrTemplateRequired: 'An XYZ template is required when the online basemap is enabled',
    mapErrTemplateProtocol: 'Only https:// addresses are allowed (no http, file or other schemes)',
    mapErrTemplateTokens: 'The XYZ template must contain the z, x and y placeholders',
    mapErrTemplateTokenUnknown: 'The template has an unknown placeholder (only z, x, y, s and key are allowed)',
    mapErrTemplateInvalid: 'The XYZ template is not a valid address (check for spaces or excessive length)',
    mapErrKeyRequired: 'The template uses the key placeholder; enter the key',
    mapErrKeyInvalid: 'The key is not valid (no line breaks, at most 512 characters)',
    mapErrAttributionRequired: 'Attribution text is required when the online basemap is enabled',
    restoreItemMapTiles: 'Online basemap (switch, XYZ template, key and attribution)',
    tabAccount: 'Account',
    tabAbout: 'About & maintenance',
    /** AI services tab (owner request: support "different AI services" in settings). */

    /** GIS service library (inside the Map tab; owner request: "add GIS service"). */
    mapServiceGroup: 'GIS services',
    mapServiceHint:
      'Save frequently used tile services by name and apply one with a single click; "Apply" overwrites the current configuration above and turns the layer on.',
    mapServiceEmpty: 'No saved GIS services yet.',
    mapServiceAdd: 'Add service',
    mapServiceSaveCurrent: 'Save current configuration as a service',
    mapServiceApply: 'Apply',
    mapServiceEdit: 'Edit',
    mapServiceDelete: 'Delete',
    mapServiceDeleteConfirm: 'Delete GIS service "{name}"?',
    mapServiceSave: 'Save service',
    mapServiceCancel: 'Cancel',
    mapServiceName: 'Service name',
    mapServiceTest: 'Test tile',
    mapServiceTesting: 'Testing…',
    mapServiceTestOk: 'Sample tile loaded successfully; this URL works.',
    mapServiceTestFail: 'Sample tile failed to load (no internet, wrong key, or service refused).',
    mapServiceTooMany: 'GIS service limit reached',

    /** AI service library (inside the AI tab). */
    aiServiceGroup: 'AI services',
    aiServiceHint:
      'Add AI services (OpenAI-compatible API) and pick one; the selected service labels samples. Keys stay on this machine and are never shown back.',
    aiServiceEmpty: 'No saved AI services yet.',
    aiServiceAdd: 'Add service',
    aiServiceName: 'Service name',
    aiServiceEndpoint: 'Endpoint URL',
    aiServiceModel: 'Model',
    aiServiceKey: 'API key',
    aiServiceKeyPlaceholder: 'Leave empty to keep the stored key',
    aiServiceKeyStored: 'Key stored',
    aiServiceKeyNone: 'No key stored',
    aiServiceDeleteConfirm: 'Delete AI service "{name}"? Its key will be deleted too.',
    aiServiceSaveFailed: 'Failed to save the AI service',
    aiServiceTooMany: 'AI service limit reached',
    aiServiceUnknown: 'Service status not loaded yet',
    aiServiceReady: 'Selected service is ready',
    aiPresetLabel: 'Provider presets (click to fill endpoint and model)',
    aiPreset_openai: 'OpenAI',
    aiPreset_deepseek: 'DeepSeek',
    aiPreset_moonshot: 'Moonshot',
    aiPreset_zhipu: 'Zhipu GLM',
    aiPreset_qwen: 'Qwen',
    aiPreset_ollama: 'Ollama (local)',
    aiPreset_custom: 'Custom',

    /** Group caption inside the Storage tab (the tab name already says "storage"). */
    storageGroupLocation: 'Location & retention',
    /** One group: device probing + ring buffer (owner ④ asked for them to be merged). */
    probeBufferGroup: 'Device probing & buffering',
    /** Group caption inside the Account tab: who is signed in, change password, sign out. */
    accountSessionGroup: 'Current session',


    storagePath: 'Storage path',
    picking: 'Choosing…',
    browse: 'Browse…',
    retentionDays: 'Recording retention (days)',
    minFreeGb: 'Reserved free space (GB)',
    storageQuotaGb: 'Storage quota (GB)',
    alarmReservePercent: 'Permanent alarm reserve (%)',
    storageQuotaHelp: 'Combined limit for video, audio, trends, logs and caches; 0 = unlimited. When exceeded, the oldest continuous recordings are deleted first.',

    healthCheckMs: 'Health check interval (ms)',
    offlineThreshold: 'Failures before offline',
    requestTimeoutMs: 'Request timeout (ms)',

    preAlarmSeconds: 'Pre-alarm recording (s)',
    postAlarmSeconds: 'Post-alarm recording (s)',
    ringBufferSeconds: 'Total buffer length (s)',

    liveSection: 'Live video',
    autoPlayCameraLive: 'Play automatically when the app opens',
    autoPlayOn: 'On',
    autoPlayOff: 'Off',

    diskSection: 'Disk usage',
    diskBelowFloor: 'Free space is below the safety threshold, so non-essential recording has stopped. Free up the disk or lower “Reserved free space”.',
    diskUnavailable: 'Disk information has not been read yet.',
    diskBarLabel: 'Disk {percent}% used',
    diskUsedOfTotal: 'Used / total',
    diskUsedValue: '{used} / {total} ({percent}%)',
    diskFree: 'Free space',
    diskFreeValue: '{bytes} ({gb})',
    diskAppUsage: 'Used by this app',
    diskAppUsageValue: '{bytes} (about {percent}%)',
    quotaUsage: 'Quota usage',
    quotaUsageValue: '{used} / {quota} ({percent}%)',
    quotaUnlimited: 'Unlimited (0 = no limit)',
    quotaOverNotice: 'Quota exceeded by {bytes}; automatic cleanup can keep only permanent alarms and manual recordings. Delete manual recordings or raise the quota.',
    quotaSweepPending: 'Quota exceeded. The next automatic sweep can free about {bytes}.',

    trendSection: 'Trend storage',
    trendFlushing: 'Writing…',
    trendFlushNow: 'Flush now',
    trendUnavailable: 'Trend storage status has not been read yet.',
    trendBuffered: 'Buffered rows',
    trendFilesWritten: 'Files written',
    trendRowsWritten: 'Rows written',
    trendLastFlush: 'Last flush',
    trendNeverFlushed: 'Never flushed',
    trendLastError: 'Last error',
    trendWrote: 'Wrote {rows} rows across {files} files',
    trendNothing: 'The buffer is empty; nothing to write',
    rows: '{count} rows',
    files: '{count} files',


    saveFailed: 'Save failed',
    saveSuccess: 'Settings saved',
    copyFailed: 'Copy failed. Select the text and copy it manually.',
    browsePicked: 'New storage path selected. Click “Save settings” to apply it.',
    errStorageRoot: 'Storage path is required',
    errRetentionDays: 'Retention must be an integer of at least 1 day',
    errMinFree: 'Reserved free space cannot be negative',
    errStorageQuota: 'Storage quota cannot be negative',
    errAlarmReserve: 'Permanent alarm reserve must be between 0 and 100%',
    errHealthCheck: 'Health check interval must be at least 1000 ms',
    errOfflineThreshold: 'Offline threshold must be an integer of at least 1',
    errRequestTimeout: 'Request timeout must be at least 1000 ms',
    errAlarmWindows: 'Pre- and post-alarm recording cannot be negative',
    errRingBuffer: 'Ring buffer length must be an integer of at least 1 second',
    errRingBufferTooShort: 'Ring buffer must be at least the pre-alarm plus post-alarm length',
    /**
     * Restore Default Value (manual §17.2, line 5227).
     */
    restoreDefaults: 'Default Value',
    restoreTitle: 'Restore default values',
    restoreIntro: 'These system settings will be restored to their factory defaults:',
    restoreItemStorage: 'Storage path (back to the platform default)',
    restoreItemRetention: 'Recording retention days',
    restoreItemMinFree: 'Minimum free space',
    restoreItemHealthCheck: 'Health check interval',
    restoreItemOfflineThreshold: 'Failures before a device is offline',
    restoreItemRequestTimeout: 'Request timeout',
    restoreItemPreAlarm: 'Pre-alarm capture length',
    restoreItemPostAlarm: 'Post-alarm capture length',
    restoreItemRingBuffer: 'Ring buffer length',
    restoreItemAutoPlay: 'Start live video automatically when the software opens',
    restoreItemMaxStreams: 'Maximum concurrent live streams',
    restoreItemAlarmLinkage: 'Alarm linkage (including the mail server, receivers, templates and cooldown)',
    restoreItemAlarmSounds: 'Alarm sound library (sound types and the audio files chosen)',
    restoreItemIotIngest: 'Data ingest (HTTP push / MQTT switches, bind address and ports)',
    restoreItemMapServices: 'GIS service library (saved named tile services)',
    restoreWarnStorage: 'The storage path goes back to the default. Recordings and files already on disk are not deleted, they are simply no longer pointed at; note the current path down first if you need it.',
    restoreKeeps: 'The device list, channels, recordings and audio files, alarm records, accounts and account permissions are not touched.',
    restoreConfirm: 'Restore defaults',
    restoreNotice: 'The system settings have been restored. The SMTP password is still in this machine’s credential store; use “Clear the stored password” in the e-mail settings to remove it.'

  },
  /**
   * Overview page — the "live picture" block.
   *
   * Separate from `cameraLiveUi` only because the same fact is worded differently on
   * this page: the monitoring page's button says "Start video" while this status line
   * says "Not started". `title` is still reused from `cameraLiveUi.title`.
   *
   * Same rule as every other block: NO MESSAGE MAY CONTAIN `@` (the vue-i18n
   * linked-message sigil, which crashes the render).
   */
  overviewLiveUi: {
    cameraLabel: 'Camera',
    device: 'Device',
    fullscreen: 'Full screen',
    statusNoCamera: 'No camera registered',
    statusIdle: 'Not started',
    statusStarting: 'Starting video…',
    statusPlaying: 'Video playing',
    statusRtspDisabled: 'Camera RTSP is off',
    statusFfmpegMissing: 'Bundled ffmpeg unavailable',
    statusError: 'Video stream failed',
    statusLimitExceeded: 'Concurrent live limit reached',
    statusOccupied: 'The picture is on another page',
    noCameraHint: 'No acoustic camera is registered yet. Add one under “Devices”.',
    idleHint: 'Not playing yet. Press “Start video” to see the camera picture.',
    startingHint: 'Starting…',
    rtspDisabledHint:
      'The camera’s RTSP service is off (the device reports rtsp_enabled=0). Enable it under “Advanced settings → RTSP” in the camera web interface and try again.',
    ffmpegMissingHint:
      'The bundled ffmpeg remuxer is missing or will not run. Reinstall the application; the paths it looked in are in the application log.',
    errorHint: 'The video stream stopped. Press “Retry” to open it again.',
    limitExceededHint:
      'This machine has reached its concurrent live limit (adjust it under “System settings → Live video”). Stop another picture first, then open this one.',
    occupiedHint:
      'The monitoring page is playing this camera. One camera carries one picture at a time, so pressing “Start video” takes the picture over to this page (the other page’s picture stops).',
    diagnosis: 'Main-process diagnosis: {reason}',
    rtspAddressUnknown: 'The device did not report a video address'
  },

  devices: {
    addDevice: 'Add device',
    empty: 'No devices yet',
    name: 'Device name',
    ip: 'IP address',
    port: 'HTTP port',
    username: 'Username',
    password: 'Password',
    testConnection: 'Test connection',
    saveFailed: 'Save failed',
    deleteFailed: 'Could not delete the device',
    status: {
      online: 'Online',
      offline: 'Offline',
      unknown: 'Unknown'
    },
    columns: {
      actions: 'Actions'
    }
  },

  devicesUi: {
    profileSection: 'Ownership and attributes',
    profileSectionHint: 'Department and custom attributes are stored locally for asset and operations records; they are not written to device firmware.',
    department: 'Department',
    departmentPlaceholder: 'e.g. Operations',
    attributes: 'Attributes',
    addAttribute: 'Add attribute',
    attributeKey: 'Attribute name',
    attributeValue: 'Attribute value',
    noAttributes: 'No attributes yet',
    addButton: 'Add device',
    noticeAdded: 'Device added',
    kindPushDevice: 'Push device',
    noticeUpdated: 'Device “{name}” updated',
    noticeRemoved: 'Device “{name}” deleted',
    deviceId: 'Device ID',
    mac: 'MAC address',
    channelCount: 'Channels',
    /**
     * Device table headers — re-given by the owner on 2026-09-18 (item 8):
     * No. / Device name / IP address / Device type / Status / Alarms / Channels /
     * View / Settings / Delete.
     */
    indexColumn: 'No.',
    ipColumn: 'IP address',
    channelColumn: 'Channels',
    onlineColumn: 'Status',
    alarmCountColumn: 'Alarms',
    ipDoubleClickHint: 'Double-click to open the device web interface',
    /** Header of that table column, and the label of the eye icon button. */
    viewColumn: 'View',
    /** Settings = the edit dialog (name / port / credentials / address info). */
    settingColumn: 'Settings',
    /** Delete = remove the device (destructive, asks first). */
    deleteColumn: 'Delete',
    /** Used by the map page's entry to the device config page. */
    configure: 'Configure',
    /** Clicking the device name opens the detail/config page. */
    openDetail: 'Open device details and configuration',
    ipReadonlyHint: 'The IP address identifies the device and cannot be changed',
    credentialsKeep: 'Leave blank to keep',
    credentialsHint: 'Credentials live in the local credential store and are never shown back; only filled fields are written.',
    passwordShow: 'Show password',
    passwordHide: 'Hide password',
    editTitle: 'Edit device',
    editNameRequired: 'Device name is required',
    editPortInvalid: 'HTTP port must be an integer between 1 and 65535',
    deleteTitle: 'Delete device',
    deleteBody: 'Delete the device “{name}”? Its alarm history and recordings are kept, but locally stored connection credentials are erased.',
    removing: 'Deleting…',
    confirmDelete: 'Delete'
  },

  time: {
    justNow: 'Just now',
    secondsAgo: '{count} seconds ago',
    minutesAgo: '{count} minutes ago',
    hoursAgo: '{count} hours ago',
    daysAgo: '{count} days ago',
    never: 'Never'
  },

  duration: {
    minutesSeconds: '{minutes} min {seconds} s',
    hoursMinutes: '{hours} h {minutes} min'
  },

  alarms: {
    type: {
      spl: 'SPL',
      main_frequency: 'Main frequency',
      band_energy_ratio: 'Band energy ratio',
      smoothness: 'Smoothness',
      clamp_looseness: 'Loose clamp',
      cooler_anomaly_a: 'Cooler anomaly A',
      cooler_anomaly_b: 'Cooler anomaly B',
      overload: 'Overload',
      short_circuit_surge: 'Short-circuit surge',
      surface_discharge: 'Surface discharge',
      corona_discharge: 'Corona discharge',
      gap_discharge: 'Gap discharge',
      floating_discharge: 'Floating discharge',
      dc_bias: 'DC bias'
    },
    unknownMask: 'Unknown alarm (0x{mask})',
    none: 'No alarm'
  },

  sonarUi: {
    mapTitle: 'Device location',
    noGis: 'This device has no GIS coordinates yet (set the installation position in Devices).',
    currentSpl: 'Current level',
    azimuth: 'Pointing direction',
    playAudio: 'Play latest recording',
    playLiveAudio: 'Play live audio',
    stopLiveAudio: 'Stop live audio',
    ptzPreviewTitle: 'PTZ camera',
    ptzLivePreview: 'PTZ live preview',
    ptzAlarmVideo: 'Video',
    ptzLiveReserved: 'PTZ live preview will be shown here.',
    ptzAlarmReserved: 'PTZ alarm video will be shown here.',
    calibratedDirection: 'Calibrated direction',
    installationOffset: 'Installation offset {degrees}°',
    callbackConnected: 'Connected',
    callbackDisconnected: 'Not connected',
    audioChannel: 'Audio channel',
    pullingAudio: 'Pulling CH{channel}',
    pullAudio: 'Pull audio',
    stopPullAudio: 'Stop audio',
    ptzPreviewReserved: 'PTZ link enabled — live preview and alarm video will be shown here.',
    ptzNotLinked: 'No PTZ camera linked',
    deviceInfoTitle: 'Device information',
    deviceTitle: 'Device',
    settingsTitle: 'Device settings',
    switchToPtz: 'Switch to PTZ camera',
    switchToLocation: 'Switch to Device location',
    viewSwitch: 'View switch',
    deviceInfoIp: 'IP address',
    deviceInfoStatus: 'Status',
    deviceInfoFirmware: 'Firmware',
    stopAudio: 'Stop playback',
    noAudio: 'No playable recording yet',
    realtimeOff: 'Live data is not connected: the device callback does not point to this machine, or the local listener is off.',
    enableRealtime: 'Enable live data',
    waitingRealtime: 'Callback enabled; waiting for the device to push realtime values…',
    fromLatestAlarm: 'latest alarm direction',
    syncRecordings: 'Sync alarm recordings',
    syncingRecordings: 'Syncing…',
    recordSyncDone: 'Recording sync finished: {saved} saved, {existing} already present, {missing} missing.',
    latestAlarm: 'Latest alarm',
    noSnapshot: 'No snapshot for this alarm.',
    alarmDirection: 'Alarm direction',
    alarmSpl: 'Level',
    alarmType: 'Alarm type',
    alarmTime: 'Alarm time',
    noAlarms: 'No alarm records for this device yet.',
    history: 'Alarm history'
  },
  alarmsUi: {
    countSummary: '{total} records, {selected} selected',
    metricBandEnergyRatio: 'Band energy ratio',
    detailDevice: 'Device',
    detailContent: 'Content',
    overviewStatus: 'Status',
    cameraEvidenceMissing: 'No snapshot image for this alarm.',
    cameraEvidenceLoading: 'Loading the snapshot image…',
    cameraActionsTitle: 'Linkage action results',
    cameraAlarmNotFound: 'This camera alarm is no longer in the pending list (it may have been acknowledged and then dropped at the retention cap).',
    viewInEventCenter: 'Open full evidence in the event center',
    cameraRowBadge: 'Camera',
    cameraSectionTitle: 'Camera alarms',
    cameraSectionEmpty: 'No alarm pushed by the camera yet.',
    cameraAlarmGeneric: 'Camera alarm',
    bulkAcknowledge: 'Acknowledge selected',
    bulkUnacknowledge: 'Unacknowledge selected',
    addSelectedToSamples: 'Add to sample library',
    sampleAddDone:
      'Added: {created} new, {existing} already in the library, {withMetrics} of them with feature values.',
    sampleAddPartial:
      'Added: {created} new, {existing} already in the library, {failed} failed (record no longer exists).',
    sampleAddedWithMetrics: 'Added to the library ({count} feature values), weak label: {label}',
    sampleAddedNoMetrics:
      'Added to the library, but this alarm carries no feature values, so it cannot be trained on yet.',
    sampleAlreadyIn: 'This one is already in the sample library (not written twice).',
    sampleSectionTitle: 'Sample library',
    sampleSectionHint:
      'Store this alarm’s metrics and weak label in the local sample library for retraining.',
    addToSamples: 'Add to sample library',
    goSamples: 'Open sample library',
    filterDevice: 'Device',
    filterAllDevices: 'All devices',
    filterChannel: 'Channel',
    filterType: 'Alarm type',
    filterAllTypes: 'All types',
    filterFrom: 'From',
    /** Filter row (owner redesign: title + content + one calendar). */
    filterTitle: 'Title',
    filterTitleHint: 'Search by device name',
    filterContent: 'Content',
    filterContentHint: 'Search note / device reason',
    filterTimeRange: 'Time range',
    menuDetail: 'View details',
    menuReplay: 'Replay',
    menuDownload: 'Download alarm',
    menuAddSample: 'Add to samples',
    menuAck: 'Acknowledge',
    menuUnack: 'Unacknowledge',
    menuNoRecording: 'This alarm has no local recording to download',
    downloadDone: 'Saved to {path}',
    videoTitle: 'Alarm video',
    snapshotsTitle: 'Alarm snapshots',
    filterTo: 'To',
    filterAck: 'Acknowledged',
    filterAllChannels: 'All channels',
    ackAll: 'All',
    ackAcknowledged: 'Acknowledged',
    ackUnacknowledged: 'Unacknowledged',
    columnTime: 'Time',
    columnDevice: 'Device',
    columnChannel: 'Channel',
    columnType: 'Alarm type',
    columnStatus: 'Status',
    selectAll: 'Select all',
    selectRow: 'Select {id}',
    loading: 'Loading…',
    empty: 'No alarms match these filters',
    pagerRange: '{from} – {to} of {total}',
    prevPage: 'Previous',
    nextPage: 'Next',
    detailTitle: 'Alarm details',
    metricsTitle: 'Metrics at the time of the alarm',
    playbackTitle: 'Recording playback',
    goSyncRecordings: 'Go to Recordings to sync recordings',
    ackSectionTitle: 'Acknowledge',
    markAcknowledged: 'Mark as acknowledged',
    notifyAcknowledged: 'Acknowledged {count} alarms',
    notifyUnacknowledged: 'Unacknowledged {count} alarms',
    notifyDetailAcknowledged: 'Alarm acknowledged',
    notifyDetailUnacknowledged: 'Alarm unacknowledged',
    filterSeverity: 'Severity',
    filterAllSeverities: 'All severities',
    moreFilters: 'More filters',
    hideMoreFilters: 'Hide more filters',
    moreFiltersActive: 'More filters ({count} active)',
    columnSeverity: 'Severity',
    severitySectionTitle: 'Severity',
    noteSectionTitle: 'Note',
    noteEmpty: 'No note yet',
    notePlaceholder: 'Write a note…',
    noteSave: 'Save note',
    noteClear: 'Clear note',
    noteTooLong: 'A note holds at most {max} characters (currently {length})',
    noteSaved: 'Note saved',
    noteCleared: 'Note cleared',
    severitySaved: 'Severity changed to “{level}”',
    recordMissing: 'This alarm is no longer on record, so the change was not saved',
    prevEvent: 'Previous event',
    nextEvent: 'Next event',
    eventPosition: '{index} of {total} (current filter)'
  },

  metrics: {
    spl: 'SPL',
    mainFrequency: 'Main frequency',
    smoothness: 'Steadiness',
    bandEnergyRatio: 'Band energy ratio',
    oddEvenHarmonicRatio: 'Odd/even harmonic ratio',
    spectralComplexity: 'Spectral complexity',
    fingerprintVariation: 'Fingerprint variation'
  },

  recordingsUi: {
    filterType: 'Recording type',
    filterAllTypes: 'All types',
    columnStart: 'Start time',
    columnDevice: 'Device',
    columnChannel: 'Channel',
    columnType: 'Type',
    columnDuration: 'Duration',
    columnSampleRate: 'Sample rate',
    columnFormat: 'Format',
    columnSize: 'File size',
    columnDownloaded: 'Download',
    columnPlay: 'Play',
    columnSample: 'Sample library',
    addToSamples: 'Add to sample library',
    sampleHint:
      'A recording carries no feature values: after adding it you can label it, but training also needs feature data',
    sampleAddedNoMetrics:
      'Added to the library. This recording has no feature values, so it cannot be trained on yet — you can label it in the sample library.',
    sampleAlreadyIn: 'This recording is already in the sample library (not written twice).',
    empty: 'No recordings yet. Use “Sync device recordings” to import them from a device.',
    downloaded: 'Downloaded',
    notDownloaded: 'Not downloaded',
    playLabel: 'Play the recording from {time}',
    playLocal: 'Play the local recording',
    playRemote: 'Play (will download from the device first)',
    playerTitle: 'Recording playback',
    playerTitleAt: 'Recording playback · {time}',
    videoPlayerTitle: 'Video recording playback',
    videoLoading: 'Opening the video file…',
    videoUnavailable: 'This recording cannot be played in the built-in player (the local file is missing or the format is unsupported).'
  },

  mapPickerUi: {
    title: 'Pick a point on the map',
    hint: 'Drag with the left mouse button to move the map; right-click to confirm the point.',
    offlineHint: 'Online base map is disabled; you can still click the grid to pick a point.',
    selected: 'Selected: {lat}, {lon}',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    confirm: 'Use this point',
    pickButton: 'Pick on map'
  },
  gasLeakUi: {
    title: 'Gas well leak monitoring',
    badge: 'On-device detection',
    noLiveStream: 'This firmware does not provide a live audio/spectrum stream. Leak detection runs on the device and results arrive as alarm recordings. The recordings below are the leak alarms synced to this machine.',
    alarmCount: 'Leak alarms',
    latestAlarm: 'Latest',
    none: 'None',
    channels: 'Enabled channels',
    sync: 'Sync alarm recordings',
    syncing: 'Syncing…',
    synced: '{count} synced',
    syncFailed: 'Sync failed: {reason}',
    goRecordings: 'Open recordings'
  },
  monitorUi: {
    noDeviceTitle: 'Add a device first',
    goToDevices: 'Go to Devices',
    deviceLabel: 'Device',
    noAddress: 'no address',
    channelHint: '{count} channels',
    /*
     * `start: 'Start monitoring'` / `stop: 'Stop monitoring'` used to live here:
     * batch 13 item 3 removed the button (receiving starts by itself), so nothing
     * referenced them any more. Deleted from all four catalogues — see §15.80.
     */
    channelSelect: 'Channel selection',
    /** Family badge for the sonar branch (top of the page). */
    sonarFamilyBadge: 'SN-16 air sonar',
    /*
     * `sonarLiveUnwired` ("live audio/spectrogram streams are not wired up yet …") was
     * DELETED by the owner's 2026-09-18 item 19: it was both the banner on top of the page
     * and the tooltip on the family badge. Online/offline is now answered by the green/grey
     * dot next to the device selector instead of by a sentence explaining the absence of a
     * live chart. Removed from all four catalogues together.
     */
    /** One line left after the stream-status card was removed: which feed is failing. */
    streamFailure: 'The {name} feed is failing',
    currentValue: 'current value on {channel}',
    /**
     * Per-channel voiceprint cards. The three reading states are separate messages on
     * purpose: `stored` is a PAST reading and the card prints its time, `unread` means no
     * frame ever arrived. Collapsing them into one "no data" would hide exactly the
     * difference the operator needs to decide whether to trust the number.
     */
    channelFeaturesSection: 'Per-channel voiceprint characteristics',
    /** Channel-feature pager range text (4 channels per page). */
    channelPager: '{start}-{end} / {total}',
    /** Accessible name of the volume popover in the acoustic-waveform card. */
    volumeLabel: 'Volume',
    /** Trend-card view switch (owner batch 20260921 item 24: single channel / detection). */
    viewMode: 'View switch',
    modeSingle: 'Single channel',
    modeDetect: 'Detection',
    detectSpl: 'SPL',
    detectSmoothness: 'Stability',
    detectEnergyRatio: 'Band energy ratio',
    detectDominantFreq: 'Dominant frequency',
    /** Detection-card legend: {channel} receives CH1..CH8. */
    detectLegendChannel: 'Channel {channel}',
    /** Data-source note for detection mode (the device opens one stream at a time; per-channel curves are not time-aligned). */
    detectDataNote: 'With several channels ticked each one opens its own connection (one tick = one connection): every curve shows that channel readings within this session — continuous within a channel, not time-aligned across channels.',
    channelFeature_live: 'Live',
    channelFeature_stored: 'Last reading',
    channelFeature_unread: 'Not read',
    channelFeatureUnread: 'No feature frame has been read on this channel yet',
    channelFeatureUpdated: 'Updated {time}',
    /*
     * 2026-09-19 batch 13 item 3: this card became a single TABLE
     * (8 rows × channel / SPL / main frequency / smoothness / band energy ratio /
     * alarm) and an alarm cell opens the detailed alarm state.
     */
    channelFeatureColumnChannel: 'Channel',
    channelFeatureColumnAlarm: 'Alarm',
    channelAlarmYes: 'Alarm',
    channelAlarmAcknowledged: 'Acknowledged',
    channelAlarmNone: 'Normal',
    channelAlarmOpen: 'Show this channel’s detailed alarm state',
    channelAlarmSampleHint:
      'The alarm column comes from the most recent {count} alarms; acknowledged ones are no longer highlighted and can still be opened',
    channelAlarmDetailTitle: '{channel} detailed alarm state',
    channelAlarmAcknowledgedState: 'Acknowledged',
    channelAlarmUnacknowledgedState: 'Unacknowledged',
    audioSection: 'Live audio',
    audioPlay: 'Play',
    audioStop: 'Stop playback',
    audioVolume: 'Volume',
    /** Playback is the decimated envelope, not the original sound — say so. */
    startRecording: 'Start recording',
    stopRecording: 'Stop recording',
    trendSection: 'Live trend',
    spectrumSection: 'Spectrum',
    spectrogramSection: 'Spectrogram',
    /** ③b: the third graph card — the decimated envelope itself, same data the play button plays. */
    waveformSection: 'Acoustic waveform',
    waveformAmplitude: 'Normalised amplitude',
    addToWall: 'Add to video wall',
    onWall: 'On the video wall',
    waitingAudio: 'Waiting for audio frames…',
    /** ③b timeline playback: local files only — this family has no continuous device-side recording. */
    playbackSection: 'Timeline playback',
    playbackLocalOnly: 'Local files only (no continuous recording on the device side)',
    playbackPrevious: 'Previous',
    playbackNext: 'Next',
    playbackZoomIn: 'Zoom in',
    playbackZoomOut: 'Zoom out',
    playbackWindow: '{from} – {to}',
    playbackNow: 'Now',
    playbackLoading: 'Reading local recordings…',
    playbackEmpty:
      'No recordings for this device on this machine yet (manual recordings and detection videos downloaded from the device show up here)',
    sampleRate: 'Sample rate',
    // The "no live data" banner keys were removed by owner batch 13 item 1 (see §15.78).
    staleBadge: 'Last content',
    waitingFeatures: 'Waiting for live feature frames…',
    waitingSpectrum: 'Waiting for spectrum frames…',
    waitingSpectrumData: 'Waiting for spectrum data…',
    sessionRunning: 'Live data running',
    sessionStarting: 'Starting the stream…',
    sessionError: 'Stream error',
    sessionStopped: 'Live data stopped',
    spectrumPerBin: '{hz} Hz per bin',
    chartNormalizedEnergy: 'Normalised energy',
    chartBandEnergy: 'Band energy'
  },

  streamState: {
    IDLE: 'Idle',
    CONNECTING: 'Connecting',
    STREAMING: 'Receiving',
    RECONNECTING: 'Reconnecting',
    STOPPED: 'Stopped',
    ERROR: 'Error'
  },

  spectrum: {
  },

  trendsUi: {
    noDeviceTitle: 'Add a device first',
    goToDevices: 'Go to Devices',
    filterDevice: 'Device',
    /** "Alarms in the selected range" card below the trend charts (owner batch 20260921). */
    rangeAlarmsTitle: 'Alarms in range',
    rangeAlarmsCount: '{count} in range',
    /** Tooltip for the drag-to-reorder metric chips. */
    metricDragHint: 'Drag to reorder charts (click to toggle)',
    /* `filterChannel` was removed with the channel row: channels are a column
       beside the chart now (batch 13 item 4). */
    noAddress: 'no address',
    filterMetric: 'Metric',
    channelHide: 'Hide this channel',
    channelShow: 'Show this channel',
    channelShowAll: 'Show all',
    /*
     * Batch 13 item 4: channels became a RIGHT-HAND COLUMN (8 or 2 channels, CH1…)
     * with rename, grey-out when there is no data, and a checkbox when there is.
     */
    channelPanelTitle: 'Channels',
    channelPanelSummary: '{withData} / {total} with data',
    channelNoData: 'No reading on this channel in this range; ticking it would only draw an empty line',
    channelRenameHint: 'Rename this channel (written to the device; the others are untouched)',
    channelRenameOffline: 'Renaming writes to the device: it needs an online acoustic box',
    channelRenamePlaceholder: 'Channel name',
    channelRenameFailed: 'Rename failed (the device did not confirm)',
    channelRenamed: '{channel} renamed',
    channelNameError_empty: 'A channel name cannot be empty',
    channelNameError_tooLong: 'A channel name is at most {count} characters',
    channelNameError_unchanged: 'The name did not change',
    channelLines: '{count} channel(s)',
    metricLimit: 'At most {count} metrics at once',
    metricMultiHint: '{count} metrics selected: one chart each, every chart showing all visible channels',
    metricNoData: 'No reading for this metric in this range (the device did not report it).',
    filterRangeLabel: 'Time range',
    /* `filterAggregation` and the four bucket-card keys were removed with the
       selector and the cards (batch 13 item 5). */
    granularityLabel: 'Granularity',
    zoomHint: 'Showing points {from}–{to} of {total}: {range}',
    zoomReset: 'Reset zoom',
    exportCsv: 'Export data',
    exporting: 'Exporting…',
    exportHint: 'Save the data currently on screen as CSV (visible channels only)',
    exportDone: 'Exported {rows} rows to {path} ({bytes})',
    exportNothing: 'Nothing to export on this screen (run a query, or pick another range)',
    exportFailed: 'Export failed (the main process did not confirm the write)',
    print: 'Print / save as PDF',
    printHint: 'Opens the print dialog; choose “Save as PDF” as the destination',
    filterFrom: 'From',
    filterTo: 'To',
    incompleteRange: 'Select both a start and an end time',
    chartTitle: 'Trend curve',
    truncated: 'The result hit the point limit, so only the first {count} buckets are shown. Narrow the time range to see the full curve.',
    noDeviceSelectedTitle: 'Select a device first',
    noHistoryTitle: 'No history for this device yet',
    goToMonitor: 'Go to Live monitoring',
    emptyRangeTitle: 'No data in the selected range',
    coverageAvailable: 'Available range: {range}',
    noDataInBucket: '{value} (no data in this bucket)',
    sampleCount: 'Samples: {count}',
    loadingNotice: 'Querying historical data…',
    noDataNotice: 'No data has been queried yet',
    flushedNotice: 'Wrote {rows} rows to {files} history files',
    emptyBufferNotice: 'The buffer is empty; nothing to write',
  },

  aggregation: {
    avg: 'Average',
    min: 'Minimum',
    max: 'Maximum',
    p95: '95th percentile'
  },

  /* X-axis time granularity (batch 13 item 5). The six steps are our own design. */
  granularity: {
    auto: 'Auto',
    autoLabel: 'Pick a bucket from the time span',
    autoHint: 'Bucket chosen automatically: {bucket}',
    fixedHint: 'Fix the time span of one bucket (finer is closer to the raw readings)',
    sec1: '1 second',
    sec10: '10 seconds',
    min1: '1 minute',
    min5: '5 minutes',
    hour1: '1 hour',
    day1: '1 day'
  },

  bucket: {
    seconds: '{count} s',
    minutes: '{count} min',
    hours: '{count} h',
    days: '{count} d'
  },

  /** Y-axis title. Spanish and Turkish need their own punctuation, so this is
   *  a per-locale template rather than a shared bracket format. */
  axisTitle: {
    composite: '{metric} ({aggregation})'
  },

  deviceDetailUi: {
    breadcrumbDevices: 'Devices',
    notFoundTitle: 'Device not found',
    backToList: 'Back to device list',
    /** Modal title row (owner batch 20260921): device name + ID + MAC on one line. */
    headerId: 'ID {id}',
    headerMac: 'MAC {mac}',
    /** Unsaved-changes confirmation dialog (tab switch / modal close). */
    unsavedBody: 'This tab has unsaved changes. Continuing will discard them.',
    unsavedDiscard: 'Discard changes',
    unsavedKeepEditing: 'Keep editing',
    refreshing: 'Refreshing…',
    openWebUi: 'Open device page',
    monitor: 'Monitor',
    tabsLabel: 'Device configuration',
    tabOverview: 'Overview',
    tabChannels: 'Channels & sample rate',
    tabAlarms: 'Alarm parameters',
    tabNetwork: 'Network',
    tabTime: 'Time / NTP',
    tabSerial: 'RS485 / Modbus',
    tabPush: 'Push reporting',
    tabMaintenance: 'Maintenance',
    tabAuscultation: 'Auscultation box',
    /** The air sonar's only config tab: PTZ (dome camera) linkage. */
    tabPtz: 'PTZ linkage',
    tabCameraDetect: 'Detection mode',
    tabCameraAlarms: 'Alarm strategies',
    tabCameraMaintenance: 'Maintenance & upgrade',
    overviewTitle: 'Device overview',
    ip: 'IP address',
    httpPort: 'HTTP port',
    mac: 'MAC address',
    firmware: 'Firmware version',
    fpga: 'FPGA version',
    webVersion: 'Web version',
    channelCount: 'Channels',
    // The device did not report a channel count (not "0 channels"): `GET /get_devinfo`
    // has no such field on this firmware, and the protocol mapper substitutes the
    // constant 8, so that number cannot be attributed to the device.
    channelCountUnreported: 'not reported by the device',
    sampleRate: 'Sample rate',
    lastSeen: 'Last seen',
    nameSection: 'Device name',
    nameLabel: 'Device name',
    saveName: 'Save name',
    nameRequired: 'Device name is required',
    nameSaveFailed: 'Could not save the device name',
    nameSaved: 'Device name saved to the device',
    refreshedAt: 'Refreshed {time}',
    webSection: 'Device page'
  },

  configCommon: {
    reload: 'Reload',
    revert: 'Discard changes',
    unsaved: 'Unsaved changes',
    saving: 'Saving…',
    saved: 'Saved',
    noChanges: 'There is nothing to save',
    enabled: 'Enabled',
    disabled: 'Disabled',
    enabledOfTotal: '{enabled} of {total} enabled',
    deviceWordingPrivate: 'The device does not document this field, so it is shown as reported',
    baudRate: 'Baud rate',
    dataBits: 'Data bits',
    stopBits: 'Stop bits',
    unitPerDevice: 'The unit is whatever the device uses; the firmware does not document it',
    deviceTime: 'Device time',
    hostTime: 'This computer',
    drift: 'Difference',
    readAt: 'Read at {time}',
    channel: 'Channel',
    status: 'Status',
    target: 'Target address',
    publicWarningTitle: 'The device is uploading data to a public address.'
  },

  configTime: {
    title: 'Time / NTP',
    syncNow: 'Sync now',
    saveButton: 'Save time settings',
    saveFailed: 'Could not save the time settings',
    syncFailed: 'Time sync failed',
    savedNotice: 'Time settings saved. Device time: {time}',
    syncedNotice: 'Synced to this computer. Device time: {time}',
    ntpToggle: 'NTP sync',
    ntpServer: 'NTP server',
    ntpServerPlaceholder: 'e.g. pool.ntp.org',
    ntpInterval: 'Sync interval',
    errInterval: 'The NTP sync interval must be an integer of at least 1',
    errServerRequired: 'An NTP server address is required when NTP sync is enabled',
    sameAsHost: 'In step with this computer',
    deviceAhead: 'Device is {seconds} s ahead',
    deviceBehind: 'Device is {seconds} s behind'
  },

  configModbus: {
    title: 'Modbus',
    type: 'Type',
    typeOption: 'Type {n}',
    port: 'Port',
    slaveId: 'Slave address',
    saveButton: 'Save Modbus settings',
    saveFailed: 'Could not save the Modbus settings',
    savedNotice: 'Modbus settings saved',
    errPort: 'The Modbus port must be between 1 and 65535',
    errSlaveId: 'The Modbus slave address must be between 1 and 247'
  },

  configRs485: {
    title: 'RS485',
    mode: 'Mode',
    modeOption: 'Mode {n}',
    portLeft: 'Left port',
    portRight: 'Right port',
    unused: '(unused)',
    portUnknown: 'Unknown (the device does not report this field)',
    portNotInList: 'The current value is not in the device\u2019s port list; it has been preserved as-is',
    deviceAddress: 'Device address',
    saveButton: 'Save RS485 settings',
    saveFailed: 'Could not save the RS485 settings',
    savedNotice: 'RS485 settings saved'
  },
  configPush: {
    title: 'Push reporting',
    publicWarning: 'One of the reporting targets is a non-private address, so the features, images and heat data the device collects will leave the local network. If that is not wanted, disable the channel on the device\u2019s own interface or point it at a private address.',
    unavailableTitle: 'Reporting configuration not read yet',
    kindFeatures: 'Feature data',
    kindAlarm: 'Alarm events',
    kindImage: 'Image data',
    kindHeat: 'Heat data',
    heatInterval: 'Heat data reporting interval',
    targetScope: 'Target address scope',
    scopePublic: 'Includes a public address',
    scopePrivate: 'Private addresses only'
  },

  configNetwork: {
    title: 'Network',
    saveButton: 'Save network settings',
    processing: 'Working…',
    saveFailed: 'Could not change the network settings',
    mode: 'Address mode',
    modeManual: 'Manual',
    modeDhcp: 'Automatic (DHCP)',
    ip: 'IP address',
    netmask: 'Subnet mask',
    gateway: 'Default gateway',
    dns: 'DNS server',
    legend: 'Network settings',
    disconnectTitle: 'Changing the address drops the current connection immediately.',
    disconnectBodyBefore: 'After saving, the app reconnects to the device at the new address and ',
    disconnectBodyStrong: 'rolls back automatically',
    disconnectBodyAfter: ' if the device does not answer.',
    disconnectWarning: 'The whole process takes up to about 45 seconds; do not close the app or cut power to the device meanwhile. If neither address answers, the device can only be recovered through its local interface or the serial port.',
    progressTitle: 'Progress',
    progressRunning: 'Running',
    progressDone: 'Finished',
    confirmTitle: 'Confirm the network change',
    confirmFrom: 'The device address will change from',
    confirmTo: 'to',
    confirmPortSuffix: '(HTTP port {port}).',
    confirmBody: 'Saving drops the current connection immediately. The app will reconnect at the new address and verify the configuration; if the new address does not answer it rolls back to the previous configuration and reports the outcome.',
    confirmWarning: 'If neither address answers, the device can only be recovered through its local interface or the serial port.',
    confirmAction: 'Apply the change',
    errIp: 'That is not a valid IP address',
    errNetmask: 'That is not a valid subnet mask',
    errGateway: 'That is not a valid gateway',
    errDns: 'That is not a valid DNS server',
    errPort: '{label} must be an integer between 1 and 65535',
    portHttp: 'The HTTP port',
    portRtsp: 'The RTSP port',
    portTcp: 'The TCP port',
    stageApplying: 'Writing the new configuration',
    stageApplied: 'New configuration written to the device',
    stageReconnecting: 'Reconnecting at the new address',
    stageConnected: 'The new address answered',
    stageVerifying: 'Verifying the values read back from the device',
    stageVerified: 'The configuration is in effect',
    stageRollingBack: 'No answer at the new address; rolling back',
    stageRolledBack: 'Rolled back to the previous configuration',
    stageUnreachable: 'Neither the old nor the new address answered'
  },
  configChannels: {
    title: 'Channel configuration',
    countHint: '{count} channels',
    unavailableTitle: 'Channel configuration not read yet',
    columnChannel: 'Channel',
    columnName: 'Name',
    columnSensorType: 'Sensor type',
    columnEnabled: 'Enabled',
    columnAlarmProfile: 'Alarm profile',
    columnActions: 'Actions',
    ariaName: '{channel} name',
    ariaSensorType: '{channel} sensor type',
    ariaEnabled: '{channel} enabled',
    ariaAlarmProfile: '{channel} alarm profile',
    enableOn: 'Enabled',
    enableOff: 'Disabled',
    unbound: 'Not bound',
    errNameRequired: 'The channel name is required',
    saveFailed: 'Save failed',
    sampleRateTitle: 'Sample rate',
    sampleRateCurrent: 'Current: {rate}',
    sampleRateWarningBefore: 'Changing the sample rate makes the device ',
    sampleRateWarningStrong: 'restart acquisition',
    sampleRateWarningAfter: ', which interrupts live monitoring; monitoring has to be started again.',
    sampleRateLabel: 'Sample rate',
    applyRate: 'Apply sample rate',
    errRateSame: 'Choose a sample rate different from the current one',
    errRateFailed: 'Could not apply the sample rate',
    rateApplied: 'Sample rate applied: {rate}. Live monitoring has to be restarted.',
    confirmTitle: 'Confirm the sample rate change',
    confirmFrom: 'The sample rate will change from',
    confirmTo: 'to',
    confirmBody: 'Applying it makes the device restart its acquisition pipeline, so live monitoring stops immediately and any monitoring already running has to be started again once the device recovers.',
    applying: 'Applying…',
    confirmApply: 'Apply'
  },

  configMaintenance: {
    title: 'Maintenance',
    destructiveBadge: 'Destructive actions',
    refreshStatus: 'Refresh status',
    running: 'Working…',
    rebootTitle: 'Restart device',
    rebootConfirmTitle: 'Confirm restart',
    rebootConfirmBody: 'The device restarts immediately and cannot acquire data while it does: live monitoring stops (about 30 seconds), any recording in progress ends, and no alarms are raised until it is back. The configuration on the device is not modified.',
    rebootConfirm: 'Restart',
    upgradeTitle: 'System upgrade',
    upgradeConfirmTitle: 'Confirm the system upgrade',
    upgradeConfirmBody: 'The device enters its system upgrade flow and restarts; it is unavailable throughout, and both live monitoring and alarms stop. Do not cut power to the device during the upgrade.',
    upgradeConfirm: 'Upgrade',
    resetTitle: 'Factory reset',
    resetConfirmTitle: 'Factory reset',
    resetConfirmBody: 'All configuration on the device — network, channels, alarm parameters, RS485/Modbus, Push reporting and the device name — returns to factory values, and the device then restarts and disconnects. Recordings and alarm history already stored on this computer are unaffected. This cannot be undone.',
    resetConfirm: 'Confirm factory reset',
    resetTypePrompt: 'Type {code} to confirm (case-sensitive)',
    uploadTitle: 'Firmware upload',
    uploadButton: 'Upload firmware',
    uploading: 'Uploading…',
    uploadConfirmTitle: 'Confirm the firmware upload',
    uploadConfirmBody: 'After the upload the device writes the new firmware and restarts; it is unavailable during the upgrade. The upload can take several minutes, so do not close this app, switch the device off, or disconnect the network meanwhile.',
    uploadConfirm: 'Upload',
    selectedFile: 'Selected file',
    fullPath: 'Full path',
    fileSize: 'File size',
    sizeUnknown: 'Cannot be read before the upload (the renderer has no filesystem access); the actual byte count appears once it finishes',
    firmwareFile: 'Firmware file',
    uploadProgress: 'Firmware upload in progress; no progress value is available',
    errNoFile: 'Choose a firmware file first',
    noticeRebooting: 'The device is restarting; this takes about 30 seconds, during which it briefly shows as offline.',
    noticeUpgrading: 'The system upgrade command was sent; the device enters the upgrade flow and restarts.',
    noticeReset: 'The factory reset command was sent. The device returns to factory configuration and restarts; re-read its configuration afterwards.',
    noticeUploaded: 'Firmware upload finished; the device will begin upgrading and restart.',
    noticeOnline: 'The device is back online.',
    noticeStillOffline: 'The device is still unreachable; refresh again shortly.',
    chooseFirmware: 'Choose firmware…',
    uploadWarning: 'Firmware is uploading. Do not close the application, power off the device or disconnect from the network. The device starts the upgrade automatically once the upload finishes.'
  },

  configAlarms: {
    title: 'Alarm parameters',
    addProfile: 'New profile',
    unavailableTitle: 'Alarm parameters not read yet',
    columnName: 'Name',
    columnMode: 'Detection mode',
    columnSensitivity: 'Sensitivity',
    columnInterference: 'Interference suppression',
    columnEnabledRules: 'Enabled criteria',
    columnActions: 'Actions',
    allDisabled: 'None enabled',
    editProfile: 'Edit alarm profile',
    createProfile: 'New alarm profile',
    groupBasics: 'Basics',
    groupSpl: 'SPL',
    groupMainFrequency: 'Main frequency',
    groupBandEnergy: 'Band energy ratio',
    labelEnable: 'Enable',
    labelLower: 'Lower',
    labelUpper: 'Upper',
    labelThreshold: 'Threshold',
    saveProfile: 'Save profile',
    deleteConfirmTitle: 'Delete alarm profile',
    deleteConfirmBody: 'Delete the alarm profile “{name}”?',
    deleting: 'Deleting…',
    notifyCreated: 'Profile “{name}” created',
    notifySaved: 'Profile “{name}” saved',
    notifyDeleted: 'Profile “{name}” deleted',
    errNameRequired: 'A name is required',
    errNumeric: '“{field}” must be a number',
    errSensitivityRange: 'Sensitivity must be between 0 and 100',
    errMainFrequencyRange: 'The lower main frequency must be below the upper one',
    errBandEnergyRange: 'The lower band energy ratio must be below the upper one',
    errFormInvalid: 'Some fields are not valid',
    fieldSensitivity: 'Sensitivity',
    fieldInterferenceSuppression: 'Interference suppression',
    fieldSplOverloadThreshold: 'SPL overload threshold',
    fieldSplSurgeThreshold: 'SPL surge threshold',
    fieldSplDropThreshold: 'SPL drop threshold',
    fieldSplStabilityThreshold: 'SPL stability threshold',
    fieldMainFrequencyLower: 'Main frequency lower bound',
    fieldMainFrequencyUpper: 'Main frequency upper bound',
    fieldBandEnergyRatioLower: 'Band energy ratio lower bound',
    fieldBandEnergyRatioUpper: 'Band energy ratio upper bound',
    fieldBandEnergyRatioThreshold: 'Band energy ratio threshold',
    ruleOverload: 'Overload',
    ruleSurge: 'Surge',
    ruleDrop: 'Drop',
    ruleStability: 'Stability',
    ruleMainFrequency: 'Main frequency',
    ruleBandEnergy: 'Band energy ratio',
    deleteWarning: 'Deleting cannot be undone: channels using this profile must be bound to another one. While any channel still references it the device refuses the deletion, so unbind it under Channel configuration first.'
  },

  widgetsUi: {
    audioLevel: 'Audio level',
    sampleRateAndFrame: 'Sample rate {rate} · {frame}',
    millisecondsPerFrame: '{value} ms/frame',
    recording: 'Recording {elapsed}',
    lastRecording: 'Last recording {elapsed}',
    peak: 'Peak',
    rms: 'RMS',
    audioUnavailable: 'The live audio stream is not running, so there is nothing to meter.',
    spectrogramAlt: 'Spectrogram at {time}',
    backToLatest: 'Back to latest',
    spectrogramWaiting: 'Waiting for spectrogram data…',
    lastRefresh: 'Last refreshed {time}',
    offlineUnknownSummary: '{offline} offline, {unknown} unknown',
    indicatorDevices: 'Total devices',
    indicatorOnline: 'Online devices',
    truncated: '{text}\n… (truncated)',
    arrayOf: 'Array of {count}',
    emptyObject: 'Empty object',
    modalClose: 'Close'
  },
  domainExtra: {
    connectionType: {
      LAN: 'LAN',
      REMOTE: 'Remote'
    }
  },

  monitorErrors: {
    selectDevice: 'Select a device first',
    selectStream: 'Select at least one stream',
    startBeforeRecording: 'Start live monitoring before recording'
  },

  rangeExtra: {
    label1h: 'Last hour',
    label24h: '24 hours',
    label7d: '7 days',
    label30d: '30 days',
    labelCustom: 'Custom',
    errRangeOrder: 'The start time cannot be later than the end time'
  },

  addDeviceUi: {
    title: 'Add device',
    errIpRequired: 'Enter the device IP address',
    errIpRange: 'That is not a valid IP address (each part must be 0-255)',
    errHostInvalid: 'That is not a valid IP address or host name',
    errPort: 'The HTTP port must be an integer between 1 and 65535',
    errUsername: 'Enter the login username',
    errPassword: 'Enter the login password',
    errAddFailed: 'Could not add the device',
    defaultPort: 'Usually 80',
    // "Address information" collapsed by default (owner batch 13, item 2).
    installationEmpty: 'Not filled in',
    installationPoint: 'Point {latitude}, {longitude}',
    installationPartial: 'Only partly filled in',
    // Protocol access method (owner batch 13, items 3 and 4).
    /** Access method (owner batch 20260921 item 11): pick IP / HTTP / MQTT first, then fill that mode's fields. */
    accessMethod: 'Access method',
    accessMethodIp: 'IP address',
    accessMethodHttp: 'HTTP',
    accessMethodMqtt: 'MQTT',
    moreGis: 'More (GIS) information',
    deviceNameRequired: 'Device name is required',
    ingestModeHint: 'This device pushes data to this machine over HTTP/MQTT: give it a name and GIS info, then configure the data-stream keys.',
    pushDeviceAdded: 'Push device added',
    kindPushDevice: 'Push device',
    protocolHint: 'How this device pushes data to this machine. "No access" means this software connects to it instead (the default).',
    protocolListening: 'This machine is listening on port {port}.',
    protocolNotListening: 'This machine is not listening yet (the port opens once the device is added).',
    protocolNotListeningReason: 'This machine is not listening: {reason}',
    protocolListenUnknown: 'Could not read the listening status of this machine.',
    metricKeysTitle: 'Data-stream interface (telemetry values)',
    metricKeysHint: 'Each of the four quantities below is carried by one telemetry key; the device must send those keys for this machine to plot them. The defaults are the canonical names — change them only if the device uses other spellings.',
    videoKeyTitle: 'Video-stream interface',
    videoKeyHint: 'Which key carries the video address (RTSP / HTTP). Leave empty when this device pushes no video.',
    protocolPlanInvalid: 'The access plan has an invalid or duplicated key — check the telemetry keys above.',
    /* 本机接入（batch 13 item 1: data ingest moved into Add device). */
    localIngestTitle: 'This machine’s ingest (listen settings and counters)',
    localIngestHint:
      'Which address and port this machine listens on for pushed data, and what has arrived. The master switch and the two channel switches are derived from the device declarations and are shown read-only.',
    localIngestDerived: 'Master {master}; HTTP channel {http}; MQTT channel {mqtt} (derived from device declarations)',
    localIngestSave: 'Save listen settings',
    noResponseTitle: 'The device did not answer',
    noResponseBody: 'The address is reachable but did not return device information this system recognises. Check the IP, the port and the device model.',
    probeSuccess: 'Connected',
    probeLatency: 'round trip {ms} ms',
    probeAuth: 'auth {strategy}',
    alreadyRegisteredTitle: 'This device is already registered',
    firmwareVersion: 'Firmware version',
    fpgaWebVersion: 'FPGA / web version',
    testing: 'Testing…',
    adding: 'Adding…',
    kindLabel: 'Device type',
    autoDetectLead: 'No device type to pick: the protocol is detected automatically from the address (voiceprint box / air sonar / acoustic camera) and the result appears after "Test connection".',
    detectedKind: 'Detected as: {kind}',
    alreadyRegisteredBody: 'Adding it again does not create a second device; it only updates the connection address (IP / port). Registered local device ID:',
    // The probe's channel count is not the device's own report: the box has no
    // channel-count field in `GET /get_devinfo`, so the mapper fills in the
    // protocol constant. The authoritative count comes from `GET /get_passageway`
    // once the device is registered.
    channelCountUnreported: 'not reported'
  },

  /**
   * IoT data ingest (owner, 2026-09-19, item 1: HTTP push + MQTT).
   *
   * The manual does NOT describe this section, so the wording below is ours; the shape
   * follows the ThingsBoard device-side API (token in the URL path / as the MQTT username).
   */
  iotUi: {
    /* Batch 13 item 1 moved data ingest into Add device: the switch/path keys of
       the deleted settings tab were removed from all four catalogues. */
    bindLabel: 'Bind address',
    bindHint: '0.0.0.0 accepts every interface (devices can reach it); 127.0.0.1 is local only.',
    errBind: 'The bind address must be 0.0.0.0, 127.0.0.1 or an IPv4 address',
    errPort: 'The port must be an integer between 1 and 65535',
    httpGroup: 'HTTP push',
    httpPortLabel: 'HTTP port',
    mqttGroup: 'MQTT',
    mqttPortLabel: 'MQTT port',
    mqttTopicLabel: 'Publish topic',
    secretLabel: 'Device secret',
    localAddressesLabel: 'Local addresses (for devices)',
    noLocalAddresses: 'This machine has no address a device could use (loopback only).',
    listening: 'Listening on {address}:{port}',
    notListening: 'Not listening',
    derivedOn: 'on',
    derivedOff: 'off',
    saveDone: 'Listen settings saved and read back',
    saveFailed: 'Saving the listen settings failed',
    saveMismatch: 'The value read back after saving differs from what was written (the UI shows the value read back)',
    statsRequests: 'HTTP requests',
    statsMessages: 'MQTT messages',
    statsRejectedAuth: 'Rejected credentials',
    statsRejectedPayload: 'Rejected payloads',
    statsTrendRows: 'Trend rows written',
    statsAlarmRows: 'Alarm rows written',
    statsLastAt: 'Last received',
    statsNever: 'Nothing received yet',
    lastUnrecognised: 'Keys not recognised in the last message: {keys}',
    portConflict: 'HTTP and MQTT share port {port}; whichever starts second will fail.',
    devicesTitle: 'Push address and secret',
    devicesHint: 'Put the address below into the device push configuration. The secret may only write telemetry to this machine; it cannot read anything.',
    copy: 'Copy',
    copied: 'Copied',
    rotate: 'Rotate secret',
    rotateTitle: 'Rotate the push secret?',
    rotateBody: 'The old secret stops working immediately; the device must be reconfigured with the new one before it can push again.',
    rotateConfirm: 'Rotate',
    rotateNotice: 'Secret rotated. Put the new secret into the device.',
    serviceOff: 'This machine is not listening right now (since batch 13 that follows the devices): fill the address into the device, and once it is added this machine opens the port for that device automatically.',
    // httpOff / mqttOff were removed in batch 13: those channel switches are derived now.
    mqttUser: 'MQTT username (the secret)',
    secretHint: 'One secret per device; rotating it invalidates the previous one immediately.',
  },

  installUi: {
    /*
     * Renamed from "Installation info" and the reference sound level removed by the owner
     * (2026-09-18, items 7 and 10). The DB column and the API keep it (see §15.49).
     */
    section: 'Address info (optional)',
    sectionHint: 'For sound-source-localisation devices (SN-16 air sonar) only; leave blank for other families. Latitude/longitude are decimal WGS84.',
    latitude: 'Latitude (°)',
    longitude: 'Longitude (°)',
    azimuth: 'Azimuth (°)',
    azimuthHint: '0 = true north, clockwise',
    gisLabel: 'Map',
    viewOnMap: 'Show on the map',
    copyPoint: 'Copy coordinates',
    pointCopied: 'Coordinates copied',
    mapNoPoint: 'No map point recorded, so this device cannot be located',
    mapHint: 'Enter latitude, longitude and azimuth under Devices → Edit → Address info',
    openMap: 'Open map information',
    mapRange: 'Range {range} m',
    mapDirection: 'Direction {degrees}°',
    mapNoAzimuth: 'Azimuth not recorded',
    errLatitude: 'Latitude must be between -90 and 90',
    errLongitude: 'Longitude must be between -180 and 180',
    errAzimuth: 'Azimuth must be between 0 and 360 (write 0 for 360)',
    errFloorX: 'Floor-plan X must be between 0 and 1',
    errFloorY: 'Floor-plan Y must be between 0 and 1',
    /* UI removed (item 10) but the domain still parses the field — see §15.49. */
    errSoundLevel: 'Reference level must be between -50 and 200 dB',
    point: 'Point',
    noPoint: 'Not recorded',
    /** One field left empty — never shown as 0 (latitude 0 is a real coordinate). */
    unset: 'Not recorded',
    /** Only one of latitude/longitude filled in: half a point cannot be aimed. */
    halfPoint: 'Only half recorded (latitude and longitude come as a pair)'
  },

  /**
   * PTZ (dome camera) linkage for the SN-16 air sonar.
   *
   * The password field says "set / not set" and never echoes the value; the time-sync line says
   * the device accepted the request — the manual does not document that endpoint's request body.
   */
  ptzUi: {
    title: 'Dome camera linkage (PTZ)',
    hint: 'This sonar drives a dome camera for sound-source localisation. Everything below lives on the device; nothing is written until you press Save.',
    fieldEnabled: 'Enable dome linkage',
    enabledHint: 'When off, the sonar no longer drives the dome',
    fieldCameraIp: 'Dome IP / hostname',
    fieldCameraPort: 'Dome port',
    fieldCameraUser: 'Dome account',
    fieldCameraPassword: 'Dome password',
    passwordSet: 'Set',
    passwordUnset: 'Not set',
    passwordHint: 'Never echoed; leave empty to keep it',
    passwordState: 'Password state',
    fieldDirection: 'Dome direction matches the sonar',
    directionHint: 'Off means the dome faces the opposite way',
    fieldSaveSnapshot: 'Save a snapshot on alarm',
    saveSnapshotHint: 'With this off, alarms have no picture to open',
    fieldChannel: 'Live listening channel',
    channelHint: '1 – {max} (channel count reported by the device)',
    channelHintUnknown: 'The device did not report a channel count, so no limit is applied',
    cameraInitialised: 'Dome initialised',
    unknown: 'Not read',
    yes: 'Yes',
    no: 'No',
    save: 'Save to device',
    syncing: 'Syncing…',
    syncTime: 'Sync time with dome',
    unsaved: 'Unsaved changes',
    nothingChanged: 'Nothing to save',
    saved: 'Written to the device and read back',
    savedPartly: 'Written to the device, but {count} item(s) did not read back (see below)',
    readBackTitle: 'Read-back check',
    allApplied: 'All applied',
    someFailed: 'Some items did not apply',
    applied: 'Applied',
    expectedActual: 'Not applied: expected {expected}, device now reports {actual}',
    passwordNotCompared: 'The password is only checked as "set": its content is never returned, so it cannot be compared.',
    timeSyncAccepted: 'The device accepted the time-sync request (the manual does not document this endpoint’s body; an empty object was sent).',
    timeSyncRejected: 'The device did not accept the time-sync request.',
    errCameraIp: 'The dome address must be an IPv4 address or a hostname',
    errCameraPort: 'The dome port must be between 1 and 65535',
    errCameraUser: 'The dome account must not be empty',
    errRealtimeChannel: 'The live channel must be within the device channel count'
  },

  /** Offline device map (batch 8). The basemap is drawn from recorded WGS84 points only. */
  /**
   * GIS Live Monitor (owner spec V1.0, 2026-09-20).
   *
   * `@` is the linked-message sigil in vue-i18n, so no message may contain one
   * (the i18n test compiles every entry). Device models are deliberately not
   * repeated here: the model only affects `resolveRealtimeProfile()`.
   */
  realtimeUi: {
    title: 'Live Monitor',
    primary: 'PRIMARY',
    detail: 'ANALYSIS / DETAIL',
    realtime: 'REALTIME',
    directionRadar: 'DIRECTION',
    signalTrend: 'SIGNAL TREND',
    channels: 'CHANNELS',
    channelsHint: 'Select a channel to switch the centre and right columns; channels with no reading show —.',
    watchHint:
      'Tick extra channels to see their trends and four readings together (one colour per channel); audio, spectrum and voiceprint still follow the current channel only.',
    watchChannelOn: 'SHOW THIS CHANNEL TOO',
    watchChannelsLabel: 'CHANNELS SHOWN TOGETHER',
    watchChannelOff: 'STOP SHOWING THIS CHANNEL',
    watchChannelCurrent: 'THE CURRENT CHANNEL IS ALWAYS SHOWN',
    multiChannelTitle: 'MULTI-CHANNEL READINGS',
    multiChannelNote:
      'Each channel is plotted at its own arrival time; channels are not guaranteed to be in step.',
    multiChannelNotReceived: 'NO DATA',
    multiChannelNotReceivedWhy:
      'The /features_stream subscription carries no channel and pushes only the current channel of the device; this channel refreshes only if the firmware routes per connection.',
    multiChannelWrongChannel: 'THIS CONNECTION CARRIES {channel}',
    multiChannelStaleWhy: 'No new frame for over 5 seconds: this channel may have stopped; the table shows its last reading.',
    trendColumn: 'TREND',
    statusColumn: 'STATUS',
    currentChannel: 'CURRENT',
    featuresTitle: '{channel} FEATURES',
    channelIssue: 'CHANNEL ISSUE',
    aboveLimit: 'Above limit',
    emptyTrend: 'No data received for this channel yet.',
    spectrumWaiting: 'Waiting for spectrum data…',
    spectrumUnknownAxis: 'The device does not provide a frequency axis: the horizontal axis shows spectrum bin numbers.',
    voiceprintPending: 'No voiceprint change chart for this channel yet; the seven feature readings are in the right column.',
    waveformPending: 'This device does not provide a realtime waveform.',
    pdProbability: 'PD PROBABILITY',
    pdProbabilityEmpty: 'The device does not provide partial-discharge class probabilities.',
    leakAnalysis: 'LEAK ANALYSIS',
    leakAnalysisEmpty: 'The device interface does not provide realtime leak-analysis fields yet.',
    pdClass: {
      corona: 'Corona',
      creepage: 'Creepage',
      suspended: 'Suspended',
      noise: 'Noise'
    },
    tempUnitHint: 'Unit follows the device infrared setting.',
    noTarget: 'No Target',
    signalTrendPending: 'Waiting for the realtime data-point table; this is a pluggable Signal Trend placeholder.',
    connectionPending: 'Connection and channel fields will be bound when the full communication protocol is available.',
    selectDeviceTitle: 'Select a device to view live data',
    selectDeviceHint: 'Choose a device from the map, device list, or alarm list.',
    unsupportedTitle: 'No realtime template for this model yet',
    unsupportedHint: 'V1 provides a live workspace for acoustic cameras, the FA8 voiceprint engine, and air sonar; this device is still available on the Live Monitor page.',
    openMonitor: 'Open Live Monitor',
    resize: 'Drag to resize the live section',
    location: 'Location',
    updatedAt: 'Updated {time}',
    dataDelay: 'DATA DELAY',
    collapse: 'Collapse',
    expand: 'Expand',
    offline: 'DEVICE OFFLINE',
    lastCommunication: 'Last communication: {time}',
    lastKnownValue: 'Last known value: {value}',
    noDataTitle: 'No live data yet',
    noDataHint: 'Receiving starts automatically when the device is online; missing values are never replaced with 0.',
    returnToLive: 'Return to Live',
    status: {
      live: 'LIVE',
      warning: 'WARNING',
      alarm: 'ALARM',
      offline: 'OFFLINE',
      dataDelay: 'DATA DELAY'
    },
    quality: {
      good: 'GOOD',
      stale: 'STALE',
      invalid: 'INVALID',
      nodata: 'NO DATA'
    },
    mode: {
      label: 'View mode',
      pd: 'Partial discharge',
      leak: 'Leak'
    },
    tabs: {
      label: 'Main visualisation',
      trend: 'Trend',
      spectrum: 'Spectrum',
      voiceprint: 'Voiceprint',
      waveform: 'Waveform',
      prpd: 'PRPD'
    },
    actions: {
      liveView: 'Live view',
      listen: 'Listen',
      ptz: 'PTZ',
      history: 'History',
      analysis: 'Analysis',
      configuration: 'Configuration'
    },
    template: {
      acousticCameraPD: 'Acoustic Camera · Partial Discharge',
      acousticCameraLeak: 'Acoustic Camera · Leak',
      voiceprint: 'Voiceprint Engine',
      airSonar: 'Air Sonar',
      gasLeakMonitor: 'Gas Well Leak Monitor'
    },
    metric: {
      maxSpl: 'Max SPL',
      soundEnergy: 'Sound energy',
      pdType: 'PD type',
      confidence: 'Confidence',
      maxTemp: 'Max temperature',
      leakRate: 'Leak rate',
      loss: 'Leak loss',
      frequencyBand: 'Frequency band',
      detectionDistance: 'Detection distance',
      centerTemp: 'Centre temperature',
      minTemp: 'Min temperature',
      maxChannel: 'Max channel',
      event: 'Event',
      ptz: 'PTZ',
      azimuth: 'Azimuth',
      tdeRatio: 'Time-domain energy ratio',
      fdeRatio: 'Frequency-domain energy ratio',
      horizontal: 'Horizontal',
      vertical: 'Vertical',
      leakStatus: 'Leak status',
      edgeAi: 'Edge AI',
      connection: 'Connection',
      lastAnalysis: 'Last analysis',
      channels: 'Channels',
      target: 'Target',
      peakSpl: 'Peak SPL'
    },
    event: {
      none: 'None',
      alarm: 'Alarm'
    },
    ptz: {
      tracking: 'Tracking'
    },
    leakStatus: {
      unknown: 'Unknown'
    },
    channelStatus: {
      normal: 'Normal',
      warning: 'Warning',
      alarm: 'Alarm',
      nodata: 'No data'
    }
  },
  floorPlanUi: {
    importButton: 'Import floor plan',
    replaceButton: 'Replace floor plan',
    removeButton: 'Remove floor plan',
    modeFloor: 'Floor plan mode',
    modeGis: 'GIS map',
    dragHint: 'Drag device icons onto the floor plan; release to save automatically',
    imported: 'Floor plan imported: {name}',
    importFailed: 'Floor plan import failed',
    storageFailed: 'Could not save the floor plan; try a smaller image',
    removed: 'Floor plan removed',
    saved: 'Position saved for {name}',
    saveFailed: 'Could not save the device position'
  },
  mapUi: {
    fitAll: 'Fit all devices',
    sonarDirection: 'Source direction {degrees}° · range {range} m',
    sonarNoPoint: 'No map point recorded, so direction and range cannot be shown',
    autoFocus: 'Auto focus',
    canvasLabel: 'Device positions',
    /**
     * The translucent status bar in the map's top-right corner (owner batch 11, item 4):
     * the old "{withPoint} of {total}" line, the legend counts and the
     * "no device has a recorded point yet" paragraph were all deleted by name.
     * Five separate readings, not one sentence: it is an instrument read-out.
     */
    statusLabel: 'Map status',
    statusMapped: '{count} on the map',
    statusTotal: '{count} in total',
    statusOnline: 'Online {count}',
    statusOffline: 'Offline {count}',
    statusAlarms: 'Unacknowledged {count}',
    selectHint: 'Click a marker to see that device: position, alarms and snapshots.',
    pickOne: 'No device selected yet.',
    point: 'Point',
    /**
     * Marker tones (owner batch 10, item 14: online green / alarm red / offline grey).
     * "Online" and "offline" reuse `devices.status.*` - one wording per fact. Colour never
     * carries the meaning alone, so each legend entry shows a count.
     */
    /** Device list (first of the three lists, item 17). */
    devicesTitle: 'Devices',
    devicesCount: '{count} device(s)',
    /**
     * Three columns only (owner batch 11, item 5: index / name / status), and clicking the
     * device name opens its detail page. Double-click still works too - the map markers
     * have always done that.
     */
    devicesHint: 'Click a row to select the device (its marker highlights too); click the device name to open it.',
    /** Paging (same item: at most 10 devices per page, then pages). */
    pagePrev: 'Previous',
    pageNext: 'Next',
    pageStatus: 'Page {page} / {pages}',
    colAlarms: 'Unacknowledged',
    /** Alarm list (second). */
    alarmsTitle: 'Alarms',
    alarmsFor: 'Selected device: {name}',
    /** Live data list (third). */
    /**
     * Where each of the three columns comes from, written after the owner settled the wording
     * (2026-09-19: "use 平稳度"). That settled the ambiguity: what he called "stability" IS this
     * repo's `smoothness` (a real value the device reports with each alarm), so the column has a
     * source and the old "not in the manual, therefore always —" note is gone.
     */
    hoverStream: 'Current video stream',
    hoverAlarm: '{count} unacknowledged alarm(s)',
    hoverNoAlarm: 'No unacknowledged alarms',
    hoverHint: 'Double-click to open this device.',
    /** "Could not be read" and "there is none" must stay distinguishable (same rule as the device table). */
    notRead: '—',
    none: '—',
    alarmCount: 'latest {count}',
    noAlarms: 'No alarms for this device locally yet. Use “Sync alarms” above.',
    sync: 'Sync alarms',
    syncing: 'Syncing…',
    syncOutcome: 'Checked {created} new and {existing} already stored; {linked} alarm(s) now have snapshots locally; {missing} had no files left on the device.',
    hasSnapshot: 'Snapshots',
    noSnapshot: 'No snapshot',
    snapshotTitle: 'Snapshots',
    snapshotCount: '{count} image(s)',
    snapshotLoading: 'Loading snapshots…',
    snapshotNotCaptured: 'This alarm has no snapshot on the device (it was not downloaded during sync, or the dome does not have “save a snapshot on alarm” enabled).',
    snapshotFilesGone: 'The database records snapshots for this alarm, but the files are no longer on this machine (storage root changed, or they were cleaned up).',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    zoomReset: 'Back to time-zone centre',
    zoomLevel: 'Zoom {zoom}',
    tilesError: '{failed} of {total} basemap tiles did not load (network unavailable or service refused); device markers and lists are unaffected.',
    /** Hint on the canvas while the basemap switch is off (owner batch 20260921 item 9: the map must not look "empty" without saying why). */
    tilesOffHint: 'GIS base map is off · enable it in Settings → GIS Services',
    sonarHint: 'The air sonar’s snapshots come from the linked dome camera: one per second, up to three.'
  },

  /** Local abnormal-voiceprint sample library (schema v8: two label dimensions). */
  samplesUi: {
    statTotal: "Samples",
    statTrainable: "Usable for training",
    statFaultHuman: "Fault: human",
    statEquipmentHuman: "Equipment: human",
    statFaultDevice: "Fault: device verdict",
    statFaultAi: "Fault: AI suggestion",
    statEquipmentUnlabelled: "Equipment unlabelled",
    filterSource: "Origin",
    filterLabelSource: "Fault label source",
    filterEquipmentLabel: "Equipment type",
    filterFaultLabel: "Fault type",
    filterAll: "All",
    source_alarm: "Alarm",
    source_manual: "Manual recording",
    source_import: "Imported",
    labelSource_human: "Human",
    labelSource_device: "Device verdict",
    labelSource_ai: "AI suggestion",
    dimension_equipment: "Equipment type",
    dimension_fault: "Fault type",
    labelsTitle: "Label library",
    labelsHint:
      "When labelling you can pick a name from here or type a new one (it is added automatically)",
    labelsEmpty: "No labels yet — add one below",
    labelUsedBy: "{count} samples use it",
    labelRename: "Rename",
    labelAdd: "Add",
    labelNewPlaceholder: "New label name",
    labelAdded: "Added “{name}”",
    labelExists: "“{name}” is already in the label library",
    labelRenamed: "Renamed to “{name}” and updated {count} samples",
    labelRenameFailed: "Rename failed: this dimension already has a label with that name",
    labelRemoved: "Deleted “{name}”",
    labelRemoveFailed: "Delete failed",
    labelInUse: "“{name}” is still used by {count} samples, so it cannot be deleted",
    trainButton: "Train and evaluate",
    trainingTitle: "Training result (leave-one-out)",
    trainingSamples: "Trained on",
    trainingAccuracy: "Leave-one-out accuracy",
    trainingExcluded: "Excluded",
    trainingExcludedValue: "{noLabel} without a fault type · {missingMetrics} missing features",
    trainingEquipment: "Equipment types in the training set",
    trainingEquipmentValue: "{kinds} kind(s) · {unassigned} unlabelled",
    trainingDegenerate: "There is only one class, so the accuracy is 100% by construction and says nothing.",
    trainingUnassessable: "Classes with fewer than 2 samples cannot be assessed by leave-one-out: {labels}. Their accuracy is not part of the number above.",
    trainingMixedEquipment:
      "The training set contains more than one equipment type: the same fault class may not be the same phenomenon on different equipment, which pulls the accuracy down.",
    trainingTruncated: "There are more samples than the training cap allows; only the first part was used.",
    trainingConfusion: "Confusion matrix (non-zero entries only)",
    trainingConfusionRow: "labelled {expected} → predicted {predicted}: {count}",
    columnTime: "Time",
    columnDevice: "Device",
    columnChannel: "Channel",
    columnSource: "Origin",
    columnEquipment: "Equipment type",
    columnFault: "Fault type",
    columnMetrics: "Features",
    columnActions: "Actions",
    loading: "Loading…",
    empty: "The sample library is empty. Add a record to it from the alarm list or the recordings page.",
    unlabelled: "Unlabelled",
    metricsCount: "{count} dims",
    metricsHint: "Feature dimensions the device actually reported; missing ones are never filled with 0",
    blockedNoLabel: "No fault type, cannot train",
    blockedMissingMetrics: "Missing features: {metrics}",
    editLabel: "Edit labels",
    clearEquipment: "Clear equipment type",
    clearFault: "Clear fault type",
    labelSaved: "Labels saved",
    labelCleared: "Label cleared",
    removed: "Sample removed",
    exportTitle: "Export dataset",
    exportOnlyLabelled: "Only export labelled samples",
    exportCopyAudio: "Also copy the audio files",
    exportButton: "Export dataset…",
    exporting: "Exporting…",
    exportDone: "Exported {samples} samples ({labelled} labelled) to:",
    exportSkipped: "{count} unlabelled samples were skipped.",
    exportAudio: "Copied {copied} audio files ({bytes}).",
    exportAudioSkipped:
      "Audio not copied: the paths in the manifest point at this machine’s storage directory. Tick “Also copy the audio files” to use them on another machine.",
    exportAudioMissing:
      "{count} audio files are no longer in the storage directory; the manifest marks them audio_missing.",
    exportFiles: "The directory contains samples.jsonl, samples.csv and dataset-info.json.",
    aiTitle: "AI labelling (optional)",
    aiReady: "Configured",
    aiUnknown: "Configuration could not be read",
    aiBlockedDisabled: "Not enabled",
    aiBlockedNoEndpoint: "No endpoint set",
    aiBlockedBadEndpoint: "Endpoint is not valid (must start with http:// or https://)",
    aiBlockedNoModel: "No model set",
    aiEnabled: "Enable AI labelling",
    aiEndpoint: "Endpoint",
    aiEndpointPlaceholder: "https://host/v1/chat/completions",
    aiModel: "Model",
    aiModelPlaceholder: "Model name",
    aiApiKey: "API key",
    aiKeyStored: "stored",
    aiKeyAbsent: "not stored",
    aiApiKeyPlaceholder: "Leave empty to keep the stored key",
    aiNoEncryption:
      "System encryption is unavailable, so the key cannot be stored (only the endpoint and model name are saved).",
    aiSave: "Save configuration",
    aiSaved: "Configuration saved",
    aiClearKey: "Clear the key",
    aiIncludeWeak: "Include samples with a device weak label",
    aiRun: "Label with AI",
    aiRunning: "Labelling…",
    aiCandidateNote:
      "The AI proposes candidates: it does not overwrite human labels and does not enter the training set — confirm one by re-labelling it as human.",
    aiOverwriteWarning:
      "Overwriting device weak labels is on: the bitmap’s verdict will be replaced by an AI guess and cannot be recovered from that sample.",
    aiOutcome:
      "Looked at {considered} samples, asked the model about {requested}, wrote {labelled} candidate labels.",
    aiOutcomeBreakdown:
      "Skipped {human} with a human label · {weak} with a weak label · {unresolved} the AI would not decide · {failed} failed",
    pagerRange: "{shown} on this page / {total} in total"
  },
  /** Auscultation family (E2 / FA100 / FA110) — the pull channel (owner request 2026-09-16). */
  /**
   * SN-16 per-second realtime value callback (device POSTs to notify_url; the shared
   * ingest HTTP listener receives it).
   */
  e2CallbackUi: {
    title: 'SN-16 realtime callback',
    hint: 'The device POSTs max_db_value / max_db_chn / TDE / FDE to notify_url every second; this machine receives it on the shared ingest HTTP listener. Enabling writes the local address into the device (administrator).',
    start: 'Receive on this PC',
    stop: 'Stop receiving',
    deviceUrl: 'Device callback URL',
    flag: 'is_send_realtime_value',
    listener: 'Local listener',
    listening: 'Listening (port {port})',
    stopped: 'Not listening',
    pointsToUs: 'Points to this PC',
    pointsElsewhere: 'Points elsewhere',
    notConfigured: 'Not configured',
    adminOnly: 'Writing to the device requires an administrator.',
    partialReadback: 'The device was written, but not every field read back identically; refresh to confirm.',
    receivedAt: 'Last received: {time}',
    maxDbValue: 'Max SPL',
    maxChannel: 'Max channel',
    tde: 'Time-domain energy ratio',
    fde: 'Frequency-domain energy ratio',
    noValue: 'No realtime value received yet.'
  },
  e2Ui: {
    statusTitle: 'Device status',
    variant: 'Protocol generation',
    variant_auscultation: 'Auscultation box (2023 protocol)',
    /** The owner named this generation: an SN-16 air sonar for sound-source localisation. */
    variant_airSonar: 'SN-16 air sonar (V3.2 protocol)',
    variantUnknown: 'Unrecognised generation (the device reported nothing decidable)',
    mode: 'Work mode',
    modeNotApplicable: 'This generation has no work mode',
    modeUnknown: 'The device did not report a work mode',
    mode_burst_of_loud_sound: 'Burst of loud sound',
    mode_rotating_equipment: 'Rotating equipment',
    mode_electrical_power_equipment: 'Electrical power equipment',
    samplerate: 'Sample rate',
    channelCount: 'Channels',
    spectrogramSize: 'Spectrogram size',
    deviceType: 'Device type',
    firmware: 'Firmware',
    retention: 'Alarm log retention',
    retentionValue: 'The device keeps the latest {count}',
    paramsError: 'The device status could not be read in full: {reason}',
    paramsEmpty: 'The device returned no parameters.',
    paramColumn: 'Parameter',
    valueColumn: 'Current value',
    paramExtra: 'Extra key from the device',
    paramValueHidden: 'set (not shown)',
    param_db_limit: 'Decibel limit (db_limit)',
    param_tde_ratio_limit: 'Time-domain energy ratio limit (tde_ratio_limit)',
    param_fde_ratio_limit: 'Frequency-domain energy ratio limit (fde_ratio_limit)',
    param_freq_down_limit: 'Band lower limit (freq_down_limit)',
    param_freq_up_limit: 'Band upper limit (freq_up_limit)',
    param_hpss_limit: 'Harmonic impact component limit (hpss_limit)',
    param_main_freq_limit: 'Main frequency limit (main_freq_limit)',
    param_sc_ratio_limit: 'Spectrum complexity limit (sc_ratio_limit)',
    param_sc_ratio_threshold: 'Spectrum complexity threshold (sc_ratio_threshold)',
    param_samplerate: 'Sample rate (samplerate)',
    param_notify_url: 'Alarm callback address (notify_url)',
    param_is_send_alarm: 'Push alarms (is_send_alarm)',
    param_is_send_fft: 'Push live analysis (is_send_fft)',
    param_cam_enable: 'PTZ camera enabled (cam_enable)',
    param_cam_ip: 'Camera address (cam_ip)',
    param_cam_port: 'Camera port (cam_port)',
    param_cam_user: 'Camera account (cam_user)',
    param_cam_pass: 'Camera password (cam_pass)',
    param_cur_realtime_channel: 'Live listening channel (cur_realtime_channel)',
    param_is_cam_init: 'Camera initialised (is_cam_init)',
    param_is_ptz_direction_same_with_sonar: 'Camera direction matches the sonar (is_ptz_direction_same_with_sonar)',
    param_is_save_snapshot: 'Alarm snapshot (is_save_snapshot)',
    param_is_send_realtime_value: 'Push live calculation values (is_send_realtime_value)',
    syncTitle: 'Alarm sync',
    syncHint:
      'Pull the alarm log and recordings from the device (it keeps the latest {count}). Syncing again never duplicates rows.',
    syncSpectrograms: 'Also download the spectrograms',
    syncSnapshots: 'Also download the PTZ snapshots',
    syncButton: 'Sync alarms',
    syncing: 'Syncing…',
    outcomeAlarms: 'Looked at {seen} log entries: {created} added, {existing} already stored.',
    outcomeAudio: 'Recordings: {saved} downloaded, {existing} already local, {failed} failed.',
    outcomeFilesMissing:
      '{count} of them no longer have files on the device (files_status = 0); only the alarm row was stored.',
    outcomeSpectrograms:
      'Spectrograms: {saved} saved, {failed} not on the device (fewer than 10 after a restart is normal).',
    outcomeSnapshots:
      'PTZ snapshots: {saved} saved, {failed} not on the device (0 when the camera is unpaired or snapshots are off).',
    outcomeBadTime: '{count} entries had an unparsable time and were skipped (their moment was not guessed).',
    outcomeDbThreshold: 'Skipped {count} record(s) below the device dB threshold',
    outcomeHint: 'Synced at {time}'
  },
  playerUi: {
    missingTitle: 'This record has no local recording file',
    missingBody: 'An alarm stores only its metrics and alarm type; the recording has to be synced from the device. Open the Recordings page, click “Sync device recordings” to import the device\u2019s recording metadata and files, then come back here to play it.',
    errMissingFile: 'This record has no local recording file, so it cannot be played',
    errNoData: 'The main process returned no audio data',
    errDecode: 'Failed to decode the audio: {detail}',
    loading: 'Loading the recording…',
    reload: 'Reload',
    play: 'Play recording',
    release: 'Stop playback',
    downloading: 'Downloading and decoding the audio from the device, about {size}; please wait…',
    autoplayBlocked: 'Loaded, but the browser did not start playback automatically. Use the play button below.',
    leadShort: 'Playback was asked to start {requested} s before the alarm, but this recording only holds {actual} s before it, so it starts at the beginning of the clip.',
    fewMegabytes: 'a few MB',
    channelCount: 'Channels',
    channelCountValue: '{count} channels',
    encoding: 'Encoding',
    waveformTitle: 'Waveform preview',
    waveformAria: 'Recording waveform preview',
    waveformMissing: 'This playback did not include a waveform preview.',
    spectrumTitle: 'Spectrum snapshot',
    spectrumMissing: 'This playback did not include a spectrum snapshot.'
  },

  labUi: {
    noticeDone: 'Diagnosis complete; results below',
    errSelectDevice: 'Select a device first',
    errPathRequired: 'Enter a path to probe, for example /get_devinfo',
    endpointNotProbed: 'This diagnosis did not probe that endpoint.',
    requestFailed: 'Request failed: {detail}',
    httpNoResponse: 'no response',
    contentTypeMissing: 'no Content-Type declared',
    chunkedUnknown: 'chunked encoding not determined',
    chunkedYes: 'chunked encoding used',
    chunkedNo: 'not chunked',
    bytesUnknown: 'byte count not recorded',
    bytesReceived: '{count} bytes received',
    jsonFields: 'JSON fields: {fields}',
    summarySeparator: '; ',

    risk1Title: 'Risk 1: how the login token is carried',
    risk1Question: 'The documentation only says /login returns a token; it never says how later requests carry it.',
    risk1Confirmed: 'Confirmed working carrier: {strategy}; the login response {tokenState} a token field.',
    risk1Pending: 'Not confirmed yet. Run a diagnosis first; if every candidate carrier fails, capture traffic on the device side to compare.',
    risk2Title: 'Risk 2: /audio_stream frame format',
    risk2Question: 'The audio stream\u2019s framing, sample format and chunking strategy are all undocumented.',
    risk2Pending: 'Not confirmed yet. The endpoint returned no usable response, and it cannot be assumed to be chunked PCM.',
    risk3Title: 'Risk 3: /freq_domain and /time_freq_domain data shape',
    risk3Question: 'The field names and array dimensions of both frequency-domain endpoints are unknown, so parsing them directly would silently drop data.',
    risk3Pending: 'Not confirmed yet. Probe both endpoints separately and inspect the raw samples.',
    risk4Title: 'Risk 4: how the recording download URL is assembled',
    risk4Question: 'The recording path the device returns cannot be turned into a downloadable URL directly; whether it needs a prefix or a port is unknown.',
    risk4Pending: 'Not confirmed yet. Probe the recording list and the download endpoint, confirm the path shape, and only then implement the download.',
    risk5Title: 'Risk 5: the meaning of port 0',
    risk5Question: 'The set_network example shows port 0, and it is impossible to tell whether that means “default port” or “disable this service”.',
    risk5Pending: 'Requires testing on real hardware: write port 0, re-read the network configuration, and see whether the device actually changes the port it listens on. Until that is settled this app will not write a 0-valued port to a device.',

    introTitle: 'What this page is for',
    chipAuth: 'Token carrier',
    chipAudioFraming: '/audio_stream framing',
    chipFreqSchema: 'Frequency-domain schema',
    chipDownloadUrl: 'Recording download URL',
    chipPortZero: 'Meaning of port 0',

    noDeviceTitle: 'Add a device first',
    goToDevices: 'Go to Devices',
    targetTitle: 'Diagnosis target',
    deviceLine: 'Device ID {uid} · {address}',
    noAddress: 'no address',
    deviceLabel: 'Device',
    diagnosing: 'Diagnosing…',
    runDiagnosis: 'Run diagnosis',

    customTitle: 'Probe a custom endpoint',
    pathLabel: 'Path',
    pathPlaceholder: 'e.g. /get_devinfo',
    methodLabel: 'Method',
    probing: 'Probing…',
    probe: 'Probe',
    ok: 'OK',
    failed: 'Failed',
    httpStatus: 'HTTP status',
    elapsed: 'Elapsed',
    chunked: 'Chunked',
    yes: 'Yes',
    no: 'No',
    receivedBytes: 'Bytes received',
    error: 'Error',

    reportTitle: 'Diagnosis report',
    detectedAuth: 'Detected authentication',
    unconfirmed: 'Not confirmed',
    loginTokenPresent: 'Login returns a token',
    tokenPresent: 'present',
    tokenAbsent: 'not found',
    loginResponseFields: 'Login response fields',

    endpointsTitle: 'Endpoint results',
    endpointCount: '{count} endpoints',
    columnPath: 'Path',
    columnMethod: 'Method',
    columnResult: 'Result',
    columnStatus: 'Status',
    columnElapsed: 'Elapsed',
    columnChunked: 'Chunked',
    columnBytes: 'Bytes',
    columnError: 'Error',
    noEndpointResults: 'The diagnosis returned no endpoint results.',

    samplesTitle: 'Raw response samples',
    unknownType: 'unknown type',

    conclusionsTitle: 'Conclusions',
    confirmed: 'Confirmed',
    pendingConfirmation: 'Pending'
  },

  authUi: {
    username: "Username",
    password: "Password",
    signIn: "Sign in",
    signingIn: "Signing in…",
    rememberPassword: "Remember password",
    rememberExpired: "The remembered password is older than {days} days, so please type it again.",
    rememberUnavailable: "OS encryption is unavailable on this computer, so the password will not be remembered (the user name still is).",
    signOut: "Sign out",
    signedInAs: "Signed in as",
    mustChangeTitle: "Change the factory password",
    changeTitle: "Change password",
    currentPassword: "Current password",
    newPassword: "New password",
    confirmPassword: "Confirm new password",
    changeSubmit: "Save new password",
    changing: "Saving…",
    changeSuccess: "Password changed",
    recoverLink: "Forgot your password?",
    recoverTitle: "Reset with a super password",
    installId: "Installation id",
    copy: "Copy",
    copied: "Copied",
    superPassword: "Super password",
    recoverSubmit: "Reset password",
    recovering: "Resetting…",
    recoverSuccess: "Password reset. Please sign in with the new password.",
    backToLogin: "Back to sign in",
    errUsername: "Enter a username",
    errPassword: "Enter a password",
    errCurrentPassword: "Enter your current password",
    errNewPassword: "Enter a new password",
    errPasswordMismatch: "The two new passwords do not match",
        errPasswordLength: "The password must be at least {min} characters",
    errPasswordWhitespace: "The password cannot begin or end with a space",
    errPasswordHasUsername: "The password cannot contain the username",
    errSuperPassword: "Enter the super password"
  },

  usersUi: {
    title: "Accounts",
    addUser: "New account",
    username: "Username",
    displayName: "Display name",
    role: "Role",
    lastLogin: "Last sign-in",
    neverLoggedIn: "Never",
    pendingPasswordChange: "Password change pending",
    create: "Create",
    creating: "Creating…",
    created: "Account created; the password must be changed at first sign-in",
    resetPassword: "Reset password",
    resetTitle: "Reset the password for {name}",
    resetSubmit: "Reset",
    resetDone: "Password reset",
    deleteUser: "Delete account",
    deleteConfirm: "Delete the account {name}? This cannot be undone.",
    cannotDeleteSelf: "You cannot delete the account you are signed in with",
    empty: "There are no other accounts yet."
  },

  /**
   * Account management (manual §17.1 Account Management, p177-178).
   */
  accountUi: {
    title: 'Account management',
    adminOnly: 'Only an administrator can manage accounts',
    editUser: 'Edit account',
    saved: 'Account saved',
    deleted: 'Account deleted',
    empty: 'There are no accounts yet.',
    permissions: 'Permissions',
    permissionScopeCount: '{count} operation(s) are governed by this permission',
    permissionScopeNone: 'This version has no matching operation channel yet',
    createPermissionsHint: 'By default only the read permissions are checked; write permissions must be granted by hand',
    adminAllPermissions: 'An administrator account has every permission by default',
    copyFrom: 'Copy permissions',
    copyFromPlaceholder: 'Copy permissions from…',
    defaultPermission: 'Default Permission',
    permissionsCopied: 'Permissions copied from “{name}”; press Save to apply',
    permissionsDefaulted: 'Default permissions restored; press Save to apply',
    errCopySource: 'Choose the account to copy the permissions from first',
    errUsernameForbidden: 'The user name cannot contain any of: {chars}',
    errUsernameTooLong: 'The user name cannot be longer than {max} characters',
    errTooManyAccounts: 'At most {max} accounts can be created',
    builtInAdminUndeletable: 'The built-in administrator cannot be deleted, but its password can be changed',
    rules: 'The user name cannot contain {chars}; the password cannot be shorter than {min} characters; at most {max} accounts; the built-in administrator cannot be deleted.'
  },

  /**
   * Alarm sound library (manual §17.2.7, p185).
   */
  alarmSoundUi: {
    title: 'Alarm sound',
    binding: {
      popup: 'Alarm linkage popup sound',
      push: 'Device push alarm sound'
    },
    soundOn: 'On',
    soundOff: 'Off',
    bindingNone: 'Not selected',
    bindingHint: 'The selected sound plays for linkage popups and device-pushed alarms.',
    libraryGroup: 'Sound library',
    addCustom: 'Add customized alarm sound',
    defaultColumn: 'Default',
    typeColumn: 'Type',
    fileColumn: 'Audio file',
    predefined: 'Pre-defined',
    predefinedUndeletable: 'A pre-defined alarm sound type cannot be deleted',
    noFile: 'Not selected',
    pickFile: 'Select file',
    clearFile: 'Clear',
    preview: 'Test',
    previewing: 'Testing: {name}',
    customDefaultName: 'Customized sound {count}',
    renameHint: 'Double-click to rename',
    deleted: 'Customized sound deleted; press Save to apply',
    defaultSet: '“{name}” is now the default sound; press Save to apply',
    defaultIs: 'Default sound: {name}',
    filePicked: '{name} selected; press Save to apply',
    onlyWav: 'The audio file can only be {ext}',
    errOnlyWav: 'The audio file can only be {ext}',
    errOnlyWavFor: 'The file selected for “{name}” is not {ext}',
    errNoFile: 'Select an audio file for this sound first',
    errPreview: 'This audio file cannot be played; check that it is a valid WAV file',
    errEmptyName: 'The sound name cannot be empty',
    errPredefinedUndeletable: 'A pre-defined alarm sound type cannot be deleted',
    summary: '{total} entries ({custom} customized), {files} with an audio file'
  },

  /**
   * E-mail settings (manual §17.2.8 Email Settings, p186).
   */
  emailUi: {
    title: 'E-mail settings',
    host: 'SMTP server',
    port: 'Port',
    portHint: 'The default is 25; with SSL this is usually 465',
    security: 'Connection security',
    securityNone: 'None',
    securitySsl: 'SSL',
    securityStarttls: 'STARTTLS',
    authentication: 'Server authentication',
    username: 'User name',
    password: 'Password',
    passwordState: 'Stored password',
    clearPassword: 'Clear the stored password',
    passwordCleared: 'The SMTP password stored on this machine has been cleared',
    from: 'Sender address',
    receiversSection: 'Receivers',
    receiverN: 'Receiver {n}',
    receiversHint: 'Up to {max} receivers',
    templateSection: 'Message content',
    sendTest: 'Send test e-mail',
    testFailed: 'Sending the test e-mail failed',
    saveSuccessWithPassword: 'Settings saved; the SMTP password is in this machine’s credential store',
    errHost: 'Enter the SMTP server address',
    errPort: 'The port must be an integer between 1 and 65535',
    errUsername: 'Server authentication requires a user name',
    errFrom: 'Enter the sender address',
    errFromFormat: 'The sender address is not a valid address',
    errRecipients: 'Enter at least one receiver address',
    errTooManyRecipients: 'At most {max} receivers can be entered',
    errRecipientFormat: 'This receiver address is not valid: {value}'
  },

  channelState: {
    enabled: 'Enabled',
    disabled: 'Disabled',
    unknown: 'Status unknown',
    disabledHint: 'This channel is disabled and takes no part in live monitoring',
    unknownHint: 'The enabled state of this channel has not been read yet; refresh the device',
    liveActive: 'Receiving data',
    liveSilent: 'No data received',
    enabledSummary: '{enabled} of {total} channels enabled'
  },

  domain: {
    sensorType: {
      microphone: 'Microphone',
      conduction: 'Bone conduction'
    },
    detectionMode: {
      characteristic: 'Characteristic detection',
      ai: 'AI detection'
    },
    recordingType: {
      alarm: 'Alarm recording',
      manual: 'Manual recording',
      scheduled: 'Scheduled recording'
    },
    streamKind: {
      features: 'Live features',
      audio: 'Live audio',
      spectrum: 'Spectrum',
      spectrogram: 'Spectrogram'
    },
    deviceKind: {
      acousticBox: 'Acoustic box',
      acousticCamera: 'Acoustic camera',
      auscultationBox: 'Auscultation box / SN-16 air sonar'
    },
    eventSource: {
      deviceDetect: 'Camera detection log',
      linkage: 'Local alarm linkage',
      localAlarm: 'Acoustic box alarm',
      deviceStatus: 'Device status'
    },
    eventSeverity: {
      info: 'Info',
      warning: 'Warning',
      critical: 'Critical',
      unknown: 'Level unknown'
    },
    eventKind: {
      deviceDetect: 'Detection completed',
      deviceDetectAlarm: 'Detection the device flagged as an alarm',
      linkageAlarm: 'Local linkage alarm',
      localAlarm: 'Acoustic box alarm',
      deviceOnline: 'Device online',
      deviceOffline: 'Device offline'
    },
    detectFileKind: {
      power_spectrum_photo: 'Power spectrum image',
      power_spectrum_video: 'Power spectrum video',
      soundmap_photo: 'Sound map image',
      soundmap_video: 'Sound map video',
      voiceprint_photo: 'Voiceprint image',
      voiceprint_video: 'Voiceprint video',
      bin_mic_data: 'Microphone binary data',
      wav_mic_data: 'Microphone WAV audio'
    },
    eventDownloadStage: {
      starting: 'Preparing',
      fetching: 'Downloading from the device',
      verifying: 'Verifying the file',
      registering: 'Registering the recording',
      done: 'Download finished',
      reused: 'Already local, reusing it',
      failed: 'Download failed'
    },
    userRole: {
      admin: 'Administrator',
      operator: 'Operator'
    },
    /**
     * Account permissions (manual §17.1, the permission checkboxes).
     */
    permission: {
      manageAccounts: 'Account management',
      manageSystemSettings: 'Write system settings',
      manageDevices: 'Add and remove devices',
      configureDevices: 'Write device configuration',
      controlCameras: 'Camera control and maintenance',
      deleteRecordings: 'Delete recordings',
      downloadDetectFiles: 'Download detection records',
      viewDevices: 'View devices',
      viewAlarms: 'View alarms',
      viewRecordings: 'View recordings',
      viewTrends: 'View trends',
      viewEvents: 'View the event and alarm centre'
    },
    permissionScope: {
      manageAccounts: 'Every change on the account management page: add, delete, change a role, change permissions, change a display name, reset a password',
      manageSystemSettings: 'Saving system settings, restoring defaults and choosing an alarm sound file',
      manageDevices: 'Adding, updating and removing devices; reboot, factory reset, system upgrade, firmware upload and camera firmware upgrade',
      configureDevices: 'Writing channels, sample rate, alarm profiles, network address, time, RS485, Modbus and the device name',
      controlCameras: 'Live video on and off, manual recording and snapshots, camera alarm models, detection start/stop and imaging parameters',
      deleteRecordings: 'Deleting recordings (this version has no such channel yet; see the code comment)',
      downloadDetectFiles: 'Downloading detection result files from a device to this machine',
      viewDevices: 'Device list, device detail, device information and the channel table',
      viewAlarms: 'Alarm center, linkage engine status and pending alarms',
      viewRecordings: 'Audio/video recording lists, playback data and recording playback addresses',
      viewTrends: 'Historical trend queries, coverage and statistics',
      viewEvents: 'Event and alarm centre queries and the camera detection library'
    },
    /**
     * The six pre-defined alarm sounds (manual §17.2.7, line 5439).
     */
    alarmSound: {
      motionDetection: 'Motion detection',
      videoLoss: 'Video loss',
      videoTampering: 'Video tampering',
      externalAlarm: 'External alarm',
      lineCrossing: 'Line crossing',
      intrusion: 'Intrusion'
    }
  },

  /** Camera live video (FA371 RTSP -> ffmpeg -> loopback <video>). */
  /**
   * Continuous recording (S1 UI): toggle + status line.
   *
   * Same hard rule as `cameraLiveUi`: no message in this block may contain `@`.
   * starting / recording / waiting / backoff are four distinct facts and must
   * never be collapsed into a single "on" state.
   */
  recorderUi: {
    title: 'Continuous recording',
    enable: 'Start continuous recording',
    disable: 'Stop continuous recording',
    working: 'Working…',
    statusOff: 'Not started',
    statusStarting: 'Starting…',
    statusRecording: 'Recording',
    statusWaiting: 'Started, waiting for video data',
    statusBackoff: 'Connection lost; retry {attempt}',
    notRunning: 'Recording requested, but the recorder process is not running',
    registered: '{count} segment(s) registered this run',
    segmentLength: '{seconds}s per segment',
    lastError: 'Last error: {reason}',
    hint: 'Continuous recording is stored as local time slices; when the storage quota is exceeded, the oldest slices are deleted first.'
  },

  cameraLiveUi: {
    title: 'Camera live video',
    rtspAddressUnknown: 'The device did not report a video address',
    start: 'Start video',
    stop: 'Stop video',
    retry: 'Retry',
    statusIdle: 'Video not started',
    statusStarting: 'Starting video…',
    statusPlaying: 'Video playing',
    statusRtspDisabled: 'Camera RTSP is disabled',
    statusFfmpegMissing: 'Bundled ffmpeg unavailable',
    statusError: 'Video stream failed',
    rtspDisabledHint:
      'The camera RTSP service is off (the device reports rtsp_enabled=0). Enable it under Advanced settings, RTSP in the camera web interface, then try again.',
    ffmpegMissingHint:
      'The bundled ffmpeg re-muxer is missing or cannot run. Reinstall this software; the application log records every path it tried.',
    errorHint: 'The video stream stopped. Retry to reopen it.',
    limitExceededHint:
      'This machine has reached its concurrent live limit (adjust it under “System settings → Live video”). Stop another running view first, then press “Start video”.',
    pausePicture: 'Pause picture',
    playPicture: 'Play picture',
    lookSnapshot: 'View (snapshot)',
    lookPlayback: 'Playback',
    volume: 'Volume',
    volumeMuted: 'Muted',
    volumeValue: 'Volume {percent}%',
    volumeNoPicture: 'Volume needs a picture first',
    /** Infrared popover button (owner batch 20260921, third batch item 2). The device reports temperatures only, no IR video. */
    infrared: 'Infrared',
    infraredNoVideo: 'The device provides temperature values only; no infrared video stream yet',
    infraredEmissivity: 'Emissivity',
    /** Toggle for the video info overlay bar. */
    overlayToggle: 'Overlay',
    dataForwarded: '{count} bytes forwarded',
    modeRemux: 'Re-mux only (no re-encode)',
    modeTranscode: 'Re-encode (compatibility mode)',
    attemptInfo: 'Address candidate {index}: {id}'
  },

  /**
   * Camera acoustic streams (FA371 manual §5.2). No message may contain `@`.
   */
  cameraStreamUi: {
    detectMode: 'Detection mode value',
    modePrpdTitle: 'PRPD',
    modeLeakageTitle: 'Leakage Data',
    modeMechanicalTitle: 'Mechanical Features',
    modeAnalysisTitle: 'Mode Analysis',
    prpdPhase: 'Phase',
    prpdAmplitude: 'Amplitude',
    prpdCount: 'Count',
    prpdPhaseAxis: 'Phase (°)',
    modeDataStatus: 'Status',
    modeDataWaiting: 'Waiting for mode-specific feature data.',
    modeSelectHint: 'Select a Detection Mode to show mode-specific analysis.',
    stop: 'Stop receiving',
    startSpectrum: 'Start spectrum',
    startWaveform: 'Start waveform',
    startVoiceprint: 'Start voiceprint image',
    onDemandHint: 'The GIS view does not open camera streams automatically: a connection is created only after you press Start, and it stops when you leave the tab or page.',
    adminOnlyHint: 'Starting and stopping camera streams is an administrator action.',
    noDevice: 'Select a camera first.',
    sessionIdle: 'Streams not started',
    sessionRunning: 'Receiving streams',
    sessionError: 'Streams failed',
    handshake: 'Handshake method: {id}',
    framesCount: '{count} frames',
    silentFor: 'silent for {seconds} s',
    phaseNotStarted: 'Not started',
    phaseNoFrames: 'No frames yet',
    phaseLive: 'Receiving',
    phaseStale: 'Stream stopped',
    phaseError: 'Channel error',
    hintNotStarted: 'This channel has not been started. A connection is opened only after Start receiving.',
    hintNoFrames:
      'The connection is up but not a single frame has arrived. An empty panel means no data, not a quiet room.',
    hintStale:
      'Data did arrive before, but nothing new for over {seconds} seconds; the picture is the last frame and must not be read as a live value.',
    hintError: 'This channel reported an error. See the log below or the application log for the reason.',
    layoutWarning:
      'The current frame size does not match this channel decode assumption, so the displayed data may be unreliable.',
    voiceprintTitle: 'Voiceprint image',
    voiceprintAlt: 'Voiceprint image pushed by the camera',
    voiceprintJpegMeta: 'JPEG image pushed by the device: {bytes}',
    voiceprintMatrixMeta: 'Magnitude matrix {width}x{height} (source decimated {decimation} times)',
    audioTitle: 'Live audio',
    audioPlay: 'Enable sound',
    audioStop: 'Mute',
    pcmMeta: '{samples} samples per frame, {ms} ms, {rate} kHz',
    pcmCrest: 'Crest factor {crest}',
    fftTitle: 'Spectrum',
    fftLineAxis: 'Spectrum line number',
    fftAmplitudeAxis: 'Amplitude (raw device counts)',
    fftAxisFromDevice: '{lines} spectrum lines; at the sample rate the device reported each line spans {hz} Hz',
    fftAxisUnknown:
      '{lines} spectrum lines; the device reported no sample rate, so the horizontal axis is labelled by line number and the frequency scale is unknown.',
  },

  /**
   * Camera NVR interactions — right-click menu, manual recording, snapshot.
   *
   * Same hard rule as `cameraLiveUi`: NO MESSAGE HERE MAY CONTAIN `@`.
   *
   * The `reason*` messages are the point of this block: every disabled menu item
   * and disabled button must say WHY, and both read them from one pure rule.
   */
  cameraNvrUi: {
    menuTitle: 'Camera actions: {name}',
    menuCapture: 'Snapshot / recording',
    menuStartRecording: 'Start manual recording',
    menuStopRecording: 'Stop recording',
    menuSnapshot: 'Snapshot',
    menuAlarmConfig: 'Alarm configuration…',
    /** The four display modes moved here from the player bar (owner batch 12). */
    menuDisplay: 'Display mode',
    /** "Picture flip" submenu (owner batch 20260921, third batch item 2: flip moved into the context menu; rendered only when the camera single-panel passes `flips`). */
    menuFlip: 'Picture flip',
    menuFlipHorizontal: 'Flip horizontally',
    menuFlipVertical: 'Flip vertically',
    menuFlipQuarter: 'Rotate 90°',
    menuFullscreen: 'Full screen',
    menuExitFullscreen: 'Exit full screen',
    menuCopyRtsp: 'Copy RTSP address',
    menuOpenExternal: 'Open in external player',
    /*
     * The three new entries the frozen menu model already references.
     *
     * "Playback" must say WHOSE recordings these are: the FA371 has no on-device
     * continuous recording storage, so the only playable material is what this
     * machine holds (manual recordings and downloaded detection files). Calling it
     * "device playback" would be a false claim.
     */
    menuPlayback: 'Play local recordings',
    menuDownloadDetect: 'Download detection records',
    menuCloseTile: 'Clear this cell',
    recordingStarted: 'Local recording started: {path}',
    playbackTitle: 'Play local recordings',
    playbackLoading: 'Reading local recordings…',
    playbackEmpty: 'This camera has no recordings on this machine yet.',
    playbackLocalNote:
      'Local recordings: the list below is what this computer has stored (manual recordings and detection files downloaded from the device). The FA371 has no continuous on-device recording storage, so this is not playback of device-side recordings.',
    playbackUnavailable: 'Cannot play this recording: the main process returned no playable local address.',
    playbackTimeline: 'Recording timeline (blank areas are gaps with no recording)',
    playbackGap: 'This segment has ended. The next one starts at {time}; about {gap} has no recording in between.',
    playbackContinueNext: 'Skip to next segment',
    playbackLastSegment: 'This is the last segment.',
    downloadTitle: 'Download detection records',
    downloadLoading: 'Reading the device detection records…',
    downloadEmpty: 'The device returned no detection records.',
    downloadNoPaging:
      'This endpoint has no server-side paging: the whole set of detection records on the device was read at once ({count} reported by the device).',
    downloadColumnTime: 'Detected at',
    downloadColumnMode: 'Detection mode (raw value)',
    downloadColumnFiles: 'Result files',
    downloadReused: 'This file is already on this machine and was registered as a recording: {name}',
    downloadPlay: 'Play this recording',
    openExternalDone: 'Opened this RTSP address in the external player.',
    reasonIdle: 'Video is not started: click Start video first, then record or take a snapshot.',
    reasonStarting:
      'Video is still starting and no frame has arrived; recording now would write an empty file and a snapshot would capture nothing.',
    reasonReady: 'Video is playing.',
    reasonRtspDisabled:
      'The camera reports rtsp_enabled=0, so RTSP is off on the device: recording and snapshots are impossible.',
    reasonFfmpegMissing: 'The bundled ffmpeg is unavailable, so the stream cannot be recorded or captured.',
    reasonError: 'The video stream failed; reopen the video first.',
    reasonLimitExceeded: 'The concurrent live-stream limit is reached. Stop another live cell before recording or capturing this one.',
    reasonNoAddress: 'The device did not report an RTSP address, so there is nothing to copy.',
    reasonNoSource: 'There is no usable RTSP session right now, so an external player has no address to open.',
    recordingBadge: 'Recording {time}',
    recordSaved: 'Recording saved: duration {duration}, size {size}, file {path}',
    recordWarning: 'Note: {reason}',
    snapshotSavedTitle: 'Snapshot saved',
    recordSavedTitle: 'Recording saved',
    snapshotSaved: 'Snapshot saved: {path}',
    openFolder: 'Open containing folder',
    copyDone: 'RTSP address copied (it contains the device password; do not share it).',
    copyMaskedDone:
      'RTSP address copied with the password masked; the player will ask for the device account and password.',
    copyFailed: 'Copy failed; select the address and copy it manually.',
    overlayDevice: 'Device: {name}',
    overlayStatus: 'Status: {status}',
    overlayStream: 'Stream: {mode} · {address}',
  },

  /**
   * Camera alarm configuration dialog (manual §5.1.22 – §5.1.29).
   *
   * Same rule: NO `@` anywhere.
   *
   * These strings carry an engineering duty: the manual contradicts itself in
   * several places, so the UI must call those values UNVERIFIED rather than let
   * an operator believe the device confirmed them. `unverified` and the
   * `ambiguity*` texts exist for exactly that; do not delete them to look tidy.
   */
  cameraAlarmUi: {
    title: 'Camera alarm configuration',
    /** The alarm card on the live-monitoring page (side by side with camera control). */
    entryHint: 'Strategies and conditions take effect on the device; this page only reads and edits them.',
    noAlarms: 'No alarm records for this camera on this machine yet.',
    /** Shown in the Alarms card empty state when the linkage master switch is off (camera alarms only exist through the linkage engine). */
    linkageDisabledHint: 'Alarm linkage is switched off, so camera detections will not appear here. Enable it under Settings → Alarm linkage.',
    /** Title of the "Alarm results" card below the video on the monitor page (owner batch 20260921, third batch item 5). */
    recentTitle: 'Alarms',
    /*
     * Unified header of the alarm table (owner 2026-09-26 item 1). Time / level /
     * type reuse `alarmsUi.columnTime` / `columnSeverity` / `columnType` so the
     * same column has one name everywhere; these two are camera-specific readings.
     * A cell the device did not report shows an em dash, never 0.
     */
    columnIntensity: 'Sound intensity',
    columnMainFrequency: 'Main frequency',
    /** Pager readout (rows per page is fixed, see `CAMERA_ALARM_PAGE_SIZE`). */
    pageStatus: 'Page {page} / {pages}',
    /** Clicking a row opens THAT alarm's detail in the alarm centre. */
    openAlarmDetail: 'Open this alarm in the alarm center',
    goAlarmList: 'Open the alarm center',
    // `subtitle` was deleted with the notice line it rendered; `refresh` was the
    // text label of the old refresh button, which is now icon-only and therefore
    // named by `refreshIcon` (aria-label + title).
    tabStrategies: 'Alarm strategies',
    tabConditions: 'Alarm conditions',
    tabRegions: 'Alarm regions',
    regionHint: 'Opening this page first reads the current alarm regions from the camera. Each region has a stable id and name; Save writes geometry to the camera and stores the id/name in the local database.',
    regionColX: 'X %',
    regionColY: 'Y %',
    regionColW: 'W %',
    regionColH: 'H %',
    regionAdd: 'Add region',
    regionDeleteSelected: 'Delete selected',
    regionClearSelection: 'Clear selection',
    regionEmpty: 'No alarm regions configured.',
    regionClear: 'Clear all',
    regionSave: 'Save regions',
    regionReload: 'Load from camera',
    regionCleared: 'Cleared (not written to the camera yet — Save to apply).',
    regionSaved: 'Alarm regions saved: geometry was written to the camera and region ids/names were stored locally.',
    regionNotApplied: 'The camera acknowledged the write, but the read-back regions do not match this edit. The UI has been restored to the camera read-back.',
    regionMetadataSaveFailed: 'The regions were written to the camera, but their local ids/names could not be saved: {reason}',
    regionInvalid: 'Every region needs a name and X/Y/W/H as 0–100 percentages, with W/H above 0 and inside the frame.',
    regionVideoStart: 'Start video',
    regionDraw: 'Draw region',
    regionDrawing: 'Drawing…',
    regionDrawHint: 'Start the video, tap "Draw region", then drag on the picture to outline an alarm region; the numeric table below works too.',
    strategyEnable: 'Enable',
    strategyDisable: 'Disable',
    strategyEnableSaved: 'Enable state written to the camera.',
    regionColIndex: 'No.',
    regionColName: 'Name',
    regionDefaultName: 'Region {n}',
    refreshIcon: 'Re-read alarm strategies, enable state, conditions and regions',
    loading: 'Reading alarm configuration…',
    empty: 'The device returned no records.',
    newStrategy: 'New strategy',
    editStrategy: 'Edit strategy',
    newCondition: 'New condition',
    editCondition: 'Edit condition',
    save: 'Save',
    saveToCamera: 'Save to Camera',
    cancel: 'Cancel',
    edit: 'Edit',
    delete: 'Delete',
    confirmDelete: 'Delete "{name}"? This is applied to the device immediately.',
    fieldName: 'Name',
    fieldAlias: 'Alias',
    fieldCondition: 'Condition',
    fieldLevel: 'Alarm level',
    fieldInterval: 'Interval',
    fieldTimes: 'Ordinal',
    fieldCycle: 'Detection cycle (s)',
    fieldSensitivity: 'Sensitivity',
    fieldDiagnosis: 'Diagnostic description',
    fieldDbThreshold: 'dB threshold',
    fieldDbOperator: 'dB operator',
    fieldDbSwitch: 'Enable the dB branch',
    fieldDfThreshold: 'Main frequency threshold',
    fieldDfOperator: 'Main frequency operator',
    fieldDfSwitch: 'Enable the main frequency branch',
    fieldDfLogical: 'Main frequency logic',
    fieldNcFileId: 'Comparison file ID',
    fieldNcThreshold: 'Similarity threshold',
    fieldNcSwitch: 'Enable spectrum comparison',
    fieldNcLogical: 'Comparison logic',
    fieldNcOperator: 'Comparison operator',
    fieldDischargeSwitch: 'Enable the discharge branch',
    fieldDischargeLogical: 'Discharge logic',
    fieldDischargeType: 'Discharge type',
    fieldNotes: 'Notes',
    branchDecibel: 'SPL (dB)',
    branchDominantFreq: 'Main frequency',
    branchComparison: 'Spectrum comparison',
    branchDischarge: 'Discharge diagnosis',
    dischargeDiagnosisHint: 'An enabled acoustic abnormality (dB, main frequency or spectrum comparison) can raise the alarm first. Discharge type is diagnosed afterwards and is not required to match before the alarm is raised.',
    operatorGt: 'greater than',
    operatorLt: 'less than',
    operatorEq: 'equal to',
    operatorGe: 'greater or equal',
    operatorLe: 'less or equal',
    logicalOr: 'or',
    logicalAnd: 'and',
    dischargeCorona: 'Corona',
    dischargeSuspension: 'Suspension',
    dischargeSurface: 'Surface',
    dischargeDischarge: 'Discharge',
    stateEnabled: 'Enabled',
    stateDisabled: 'Not enabled',
    stateUnknown: 'Enable state unknown',
    conditionHint:
      'The device returns only the condition name and its id; the full condition is listed in the section below.',
    selectCondition: 'Select a condition',
    noConditions: 'The device has no alarm conditions yet: create a condition before a strategy.',
    conditionIdStyleLabel: 'How an updated condition is identified',
    conditionIdStyleId: 'Send id (following the strategy precedent)',
    conditionIdStyleAlarmConditionId: 'Send alarm_condition_id (the read-side spelling)',
    conditionIdStyleNone: 'Send no identifier (literal field table)',
    unverified: 'Unverified',
    ambiguityConditionIdLabel: 'Updating a condition cannot name its target',
    ambiguityConditionIdNote:
      'The request field table for updating a condition has no id field at all, so the manual cannot say which condition is meant. The default follows the strategy precedent (send id); the other two spellings remain available as candidates.',
    ambiguityLevelLabel: 'Two different alarm level ranges',
    ambiguityLevelNote:
      'The read-side table says 0~3 and the write side says 1~4. Nothing is silently shifted: 1~4 is sent as typed and whatever comes back is shown as-is, so a read-back 0 has no level name.',
    ambiguityDischargeLabel: 'The discharge branch exists only on the write side',
    ambiguityDischargeNote:
      'The discharge switch, logic and type appear only in the create/update field tables and are never returned by the read side; the discharge type enum is also missing 3. Not being able to read them back is how the manual is written, not a gap in this software.',
    ambiguityUnitsLabel: 'Threshold units and ranges are unspecified',
    ambiguityUnitsNote:
      'The manual gives no unit or legal range for the dB threshold or the main frequency threshold; the spectrum similarity is documented as 0~1. No value is ever converted here.',
    ambiguityDeleteLabel: 'The delete request has no documented field name',
    ambiguityDeleteNote:
      'The delete bodies for strategies and conditions give only a type (an array of ids) and no field name. The client sends a documented candidate shape; whether the device accepts it can only be confirmed by its answer.',
    ambiguityCreateIdLabel: 'A newly created strategy returns no id',
    ambiguityCreateIdNote:
      'Creating a strategy returns only ret/msg and the manual never says how the new id comes back, so this dialog re-reads the list after saving in order to claim the new row.',
    issueName: 'The strategy name must be 1~20 characters',
    issueCondition: 'Select the alarm condition this strategy binds (one strategy binds exactly one condition)',
    issueLevel: 'The write side accepts alarm levels 1~4 only (the read side says 0~3; nothing is shifted here)',
    issueCycle: 'The detection cycle must be 1~30 seconds',
    issueSensitivity: 'Sensitivity must be between 0 and 1',
    issueInterval: 'The interval must be a whole number not less than 0',
    issueTimes: 'The ordinal must be a whole number not less than 0',
    issueConditionName: 'The condition name cannot be empty (at most 64 characters)',
    issueNoBranch: 'Enable at least one acoustic trigger: dB, main frequency or spectrum comparison.',
    issueSimilarity: 'The noise similarity must be between 0 and 1',
    issueDischargeType: 'Only discharge types 0/1/2/4 are defined (the manual is missing 3)',
    savedStrategy: 'The strategy was sent and the list refreshed.',
    savedCondition: 'The condition was sent and the list refreshed.',
    deleted: 'The delete request was sent and the list refreshed.',
    deletedConditionAfterDisable: 'The linked enabled alarm strategy was disabled first, then the condition was deleted.',
    missingId:
      'The id of this record is not a whole number, so it cannot be changed or deleted (the read side may return it as a string, see spec §8.3 C21).',
    adminOnly: 'Creating, changing and deleting alarm configuration requires an administrator account.'
  },

  /**
   * Channel wall — the Overview page's 1 / 4 / 16 pane channel view.
   *
   * Same rule as `cameraLiveUi` / `cameraStreamUi`: NO MESSAGE HERE MAY CONTAIN `@`
   * (vue-i18n's linked-message sigil; a message containing one fails to compile).
   */
  /**
   * Multi-camera live video wall (the monitoring page's split-screen view).
   *
   * Same hard rule as `cameraLiveUi`: **no message in this block may contain `@`**
   * (vue-i18n's linked-message sigil — it fails to compile at render time, and
   * `tests/i18n.test.ts` compiles every message to prove it).
   *
   * Every "no picture" state names its own specific cause: never a spinner that
   * never resolves and never an unexplained black rectangle.
   */
  /**
   * Camera control & maintenance panel (detection mode / start-stop / enabled
   * strategy / maintenance).
   *
   * Same hard rule: **no message in this block may contain `@`**.
   *
   * Two deliberate wordings:
   *   - `modeRejected` / `detectNotApplied` / `strategyRejected` say the device
   *     ACKNOWLEDGED the write without applying it — this hardware has been
   *     measured answering `ret:200` while ignoring a write, so the UI must never
   *     turn a success code into "done";
   *   - the `reason*` strings are tooltips on DISABLED controls, so each names the
   *     next step (use the device web interface / not supported / connect first).
   *
   * The `appMode*` group is the APPLICATION mode (which application this device
   * performs: partial discharge / gas leak / mechanical noise) — a different thing
   * from the `mode*` group above (the DETECTION mode: single detection / smart
   * patrol), so the wording must not be mixed up. `appModeSourceHint` is the button
   * tooltip and states one fact only: the endpoint is not in the device manual.
   */
  cameraControlUi: {
    settingsTitle: 'Camera Control Settings',
    detectionControlTitle: 'Detection control',
    detectionModeLabel: 'Detection Mode',
    leakageOpen: 'Leakage estimation parameters',
    leakageParamsTitle: 'Leakage estimation parameters (written to camera /system/leakage)',
    leakageDistance: 'Distance (m)',
    leakageUnitLabel: 'Leakage unit',
    monetaryUnitLabel: 'Currency',
    valueOfGas: 'Value of gas',
    energyCost: 'Energy cost',
    specificPower: 'Specific power',
    workingHours: 'Working hours',
    correctionRate: 'Site correction rate',
    costDisplay: 'Show leak cost',
    leakageSave: 'Save leakage parameters',
    leakageSaved: 'Leakage parameters saved (device read-back is authoritative)',
    operationLabel: 'Operation',
    frequencyBand: 'Frequency Band',
    lowerFrequency: 'Lower frequency',
    upperFrequency: 'Upper frequency',
    suggestedFrequencyRange: 'Suggested frequency range: {range}',
    recommendedForMode: 'Recommended for this mode: {range}',
    imagingThreshold: 'Imaging Threshold',
    imagingThresholdHint: 'Start from the current site background level; -30 dB is only a commissioning starting point.',
    apply: 'Apply',
    detectionModeUnavailable: 'Detection Mode is not exposed by the current camera firmware.',
    activeRecentAlarms: '{count} unacknowledged alarm(s) — same count as the alarm icon in the top bar',
    suggestedMechanicalBand: '2-50 kHz search range · active span <= {limit} kHz',
    bandErrorMissing: 'Enter both lower and upper frequency limits.',
    bandErrorNumeric: 'Frequency limits must be numeric.',
    bandErrorRange: 'Frequency band must stay within 2-65 kHz.',
    bandErrorOrder: 'Upper frequency must be greater than lower frequency.',
    bandErrorWidth: 'Active imaging bandwidth cannot exceed {limit} kHz on this device.',
    imagingSettingsApplied: 'Imaging band and threshold applied.',
    imagingSettingsRejected: 'The device acknowledged the request, but the read-back values did not match.',
    modeMismatchTitle: 'Detection Mode Mismatch',
    modeMismatchMessage: 'Realtime Monitoring is configured for “{configured}”, but the camera is currently in “{actual}” mode. Confirm or change Detection Mode in Camera Control Settings.',
    modeMismatchConfigured: 'Configured',
    modeMismatchCamera: 'Camera Mode',
  modeMismatchAdopt: 'Use camera mode',
    title: 'Camera control',
    refresh: 'Refresh',
    modeTitle: 'Operation',
    modeSingle: 'Single detection',
    modeCruise: 'Smart patrol',
    modeUnknownHint: 'The device returned a value the manual does not define: 1 = single detection, -1 = smart patrol.',
    modeRawValue: 'Device value: {value}',
    modeReadBack: 'Device now: {value}',
    modeApplied: 'Applied',
    modeRejected: 'The device acknowledged the write but did not apply it',
    appModeTitle: 'Detection mode',
    appModeCurrent: 'Device now',
    appModePartialDischarge: 'Partial discharge',
    appModeGasLeak: 'Gas leak',
    appModeMechanical: 'Mechanical noise',
    appModeUnknownHint: 'The device returned a value outside the three measured ones (1 = partial discharge, 2 = gas leak, 3 = mechanical noise).',
    appModeSourceHint: 'This endpoint is not in the device manual; a switch writes Detection Mode (work_mode) only.',
    appModeApplied: 'Applied',
    appModeRejected: 'The device acknowledged the write but did not apply it',
    // Confirmation supplied by the product owner. It is NOT a verified device fact:
    // the manual leaves "does switching mode interrupt detection" undocumented, its
    // only "deletes all historical data" statement is about Restore, and what we
    // measured is that writing `run_mode` clears the enabled-strategy pointer.
    // See the long Chinese note on `pendingWorkMode` in `CameraControlPanel.vue`.
    appModeConfirmTitle: 'Switch detection mode',
    appModeConfirmBody: 'Switching the mode erases all stored data. Continue?',
    appModeConfirmAction: 'Switch anyway',
    detectTitle: 'Detection',
    detectRunning: 'Detecting',
    detectStopped: 'Stopped',
    detectRetentionHint: 'The device keeps only the latest 50 detection records; older ones are overwritten.',
    detectRecord: 'Record {id}',
    detectStart: 'Start detection',
    detectStop: 'Stop detection',
    detectStopHint: 'Single detection stops by itself at the end of the strategy period, so this call is optional then.',
    detectApplied: 'Applied',
    detectNotApplied: 'The device state did not change as requested',
    strategyTitle: 'Alarm strategy',
    strategyPeriodHint: 'The strategy period is configured inside the strategy; it ranges from 1 to 30 seconds.',
    strategyNoneEnabled: 'No strategy is enabled',
    strategyEnabled: 'Enabled',
    strategyEnable: 'Enable',
    strategyDisable: 'Disable',
    strategyNoItems: 'The device has no alarm strategy yet',
    strategyIdUnusable: 'This strategy id is not an integer, so it cannot be enabled or disabled',
    strategyNeedsOne: 'One alarm strategy must be enabled before detection can start',
    strategyDisabledPrevious: 'Only one strategy may be enabled, so strategy {previous} was disabled first',
    strategyApplied: 'Applied',
    strategyRejected: 'The device acknowledged the write but did not apply it',
    maintenanceTitle: 'Maintenance',
    firmwareVersion: 'Firmware version',
    sdkVersion: 'SDK version',
    webVersion: 'Web interface version',
    lastUpgrade: 'Last upgrade',
    valueUnavailable: 'Not read',
    valueUnavailableHint: 'The device did not return this value in the last read.',
    openWebUi: 'Open camera web interface',
    webUiOpened: 'Opened in the system browser',
    // `upgrade` and `reboot` were the labels of the DISABLED maintenance buttons;
    // both actions now have real controls whose strings live in `cameraUpgradeUi.*`.
    rollback: 'Rollback',
    factoryReset: 'Factory reset',
    reasonNotInOpenInterface: 'The device open interface has no such operation',
    reasonDeviceOffline: 'Device is offline',
    adminOnlyHint: 'Changing the mode, starting or stopping detection and enabling a strategy require an administrator'
  },

  /**
   * Camera firmware upgrade (the HTTP path the device's own web interface uses:
   * `POST /upload` + `PUT /reboot` + `GET /progress`).
   *
   * Three strings here are deliberate prose, and they are the only kind this
   * project keeps: `*ConfirmBody` states the CONSEQUENCE of a destructive action
   * (what happens, when the upgrade starts, what must not be interrupted);
   * `sourceHint` states one fact about where the endpoints come from; and
   * `nameRejectedDetail` quotes the file-name rule the device itself applies.
   * Everything else is a short label.
   */
  cameraUpgradeUi: {
    title: 'Firmware upgrade',
    sourceHint: 'Upgrading and rebooting use the endpoints the device web interface itself uses (not in the device manual).',
    pick: 'Choose package',
    repick: 'Choose another',
    packageFile: 'Package',
    packageSize: 'Size',
    packageSha256: 'SHA-256',
    packageSuffix: 'Name suffix',
    sha256Hint: 'Compare this with the checksum the vendor published for this release before uploading.',
    nameAccepted: 'The device accepts this file name',
    nameRejected: 'The device will refuse this file name',
    nameRejectedDetail: 'The device requires the last segment after "_" to be V plus three numbers, for example _v2.0.11 (currently {suffix}).',
    upload: 'Upload package',
    uploading: 'Uploading {percent}%',
    uploadConfirmTitle: 'Upload the package to the device',
    uploadConfirmBody: 'The package will be written to the device ({size}). Do not cut power or network during the upload. The device does not reboot by itself afterwards: you decide separately when the upgrade starts.',
    uploadConfirm: 'Start upload',
    uploaded: 'Package uploaded; the device has not upgraded yet',
    uploadedHint: 'The device must be rebooted before the upgrade starts: use Reboot device.',
    uploadDoneAt: 'Upload took {duration}',
    deviceProgressTitle: 'Device upgrade progress',
    deviceProgressRead: 'Read device progress',
    deviceProgressValue: 'Device value: {value}',
    deviceProgressUnknown: 'The device does not document what this value means, so it is not converted.',
    deviceProgressNotRead: 'Not read',
    reboot: 'Reboot device',
    rebootConfirmTitle: 'Reboot the device',
    rebootConfirmBody: 'The device reboots immediately: a running detection is interrupted and the connection drops briefly. If a package has been uploaded, the upgrade only starts after this reboot; do not cut power or network while it runs.',
    rebootConfirm: 'Reboot',
    rebooting: 'Rebooting…',
    rebootAcknowledged: 'Reboot command sent and acknowledged by the device',
    rebootDropped: 'Reboot command sent; the device did not acknowledge (a dropped connection is normal on reboot)'
  },

  cameraWallUi: {
    layoutGroup: 'Cell layout',
    layoutLabel: '{count} cells',
    pickDevice: 'Choose camera',
    viewPlay: 'Video',
    viewTimedomain: 'Time Domain',
    viewSpectrum: 'Frequency spectrum',
    viewSpectrogram: 'Spectrogram',
    viewWaiting: 'Waiting for data…',
    viewNeedsCamera: 'A third-party RTSP source has video only',
    viewSpectrogramNote: 'Colour shows relative strength within one frame only',
    viewStreamError: 'This acoustic stream could not be opened',
    /** One (camera, view) pair may appear only once on the whole wall (owner batch 20260921 item 1). */
    viewAlreadyShown: 'This content is already shown in another window of this camera (the same content may appear only once)',
    /** Badge for (camera, view) pairs already on the wall, in the picker. */
    viewInUse: 'On wall',
    /** Rotation indicator: {shown} streams on screen / {total} including queued. */
    rotationIndicator: 'Rotation {shown}/{total}',
    rotationPauseTitle: 'Pause rotation',
    rotationResumeTitle: 'Resume rotation',
    /** Shown when every window is full and the new item joins the rotation queue ({position} = queue position). */
    queuedNotice: 'All windows are full — added to the rotation queue (position {position})',
    manualTitle: 'Third-party cameras (hand-typed RTSP)',
    manualNote: 'The manual does not describe third-party RTSP: the address goes to the bundled ffmpeg as typed. This app checks the shape only, never reachability (when it cannot connect, the cell shows the ffmpeg text itself). The address lives in memory only for this run — it usually carries a password and is never written to disk.',
    manualWhere: 'To put one into a cell, use the video wall on the overview page: click a cell and pick it from the list.',
    manualName: 'Name',
    manualNameHint: 'Leave empty to use the host from the address',
    manualUrl: 'RTSP address',
    manualUrlPlaceholder: 'rtsp://192.168.1.64:554/Streaming/Channels/101',
    manualSave: 'Add',
    manualUpdate: 'Save changes',
    manualList: 'Hand-typed sources',
    manualEmpty: 'No hand-typed address yet.',
    manualEdit: 'Edit',
    manualDelete: 'Delete',
    manualAtCapacity: 'At most {max} hand-typed sources.',
    manualSuffix: 'typed RTSP',
    manualMissing: 'This hand-typed RTSP source is no longer in the list',
    manualIssueEmpty: 'Enter an RTSP address',
    manualIssueScheme: 'The address must start with rtsp:// or rtsps://',
    manualIssueHost: 'The address has no host name',
    manualIssueWhitespace: 'The address cannot contain spaces',
    manualIssueControl: 'The address cannot contain line breaks or control characters',
    manualIssuePort: 'The port must be between 1 and 65535',
    manualIssueTooLong: 'The address is too long',
    pickNoOption: 'No camera available',
    replaceDevice: 'Replace camera',
    noCamera: 'No acoustic camera registered yet',
    assignToCell: 'Put in this cell',
    statusIdle: 'Not started',
    statusStarting: 'Starting…',
    statusPlaying: 'Playing',
    statusRtspDisabled: 'RTSP disabled',
    statusFfmpegMissing: 'ffmpeg not found',
    statusError: 'Stream error',
    statusLimitExceeded: 'Concurrency limit reached',
    statusAlreadyShown: 'Camera already in another cell',
    statusDeviceRemoved: 'Device removed',
    statusDeviceOffline: 'Device offline',
    start: 'Start',
    stop: 'Stop',
    /** The player bar's pause control (owner batch 12). It still stops the live session. */
    play: 'Play',
    pause: 'Pause',
    retry: 'Retry',
    fullscreen: 'Fullscreen',
    exitFullscreen: 'Exit fullscreen',
    audioOn: 'Enable sound',
    audioOff: 'Mute',
    volume: 'Volume',
    /** The vertical slider inside the popover (owner batch 12: click to reveal, drag up/down). */
    volumeLevel: 'Volume level',
    /** The bar's "switch to recording" control (= the menu's local playback dialog). */
    cellPlayback: 'Switch to recording',
    /** The bar's alarm control (= the menu's alarm configuration dialog). */
    cellAlarm: 'Alarm configuration',
    volumeNoPicture: 'No picture in this cell, so it cannot play sound',
    activeBadge: 'Active cell',
    limitNotice: 'Up to {max} live streams at once; {active} running. Starting one more would exceed the limit — stop another cell first.',
    layoutShrunk: 'The layout shrank: {count} cell(s) were stopped.'
  },
  /**
   * System messages — the application-level failures section inside the panel behind the
   * topbar alarm icon (owner, 2026-09-18).
   *
   * The rule lives in `stores/appNotices.ts`: application-level failures (the device list,
   * settings or the alarm list cannot be read; authentication failed …) belong here, while
   * a page's own in-place feedback (form validation, the result of what you just clicked)
   * does not. The panel is an overlay, so this content never moves the page layout.
   */
  noticesUi: {
    title: 'System messages',
    clearAll: 'Clear all',
    dismiss: 'Dismiss this system message',
    bellWithProblems: '{count} system message(s) · pending alarms'
  },

  /**
   * Local alarm linkage (recording / popup / notice / e-mail).
   *
   * Same rule as every other group: NO MESSAGE HERE MAY CONTAIN `@`
   * (vue-i18n's linked-message sigil — a message containing one fails to COMPILE at
   * render time, which the catalogue tests catch because they compile every message).
   * That is why the SMTP fields talk about "the address" instead of showing a
   * sample mailbox.
   */
  linkage: {
    popupTitle: 'Alarm linkage',
    popupInfo: '{device} raised a notice-level alarm (level {level})',
    popupWarning: '{device} raised an alarm (level {level})',
    popupCritical: '{device} raised a CRITICAL alarm (level {level})!',
    title: 'Alarm linkage',
    enabled: 'Enable alarm linkage',
    enabledOn: 'Enabled',
    enabledOff: 'Disabled',

    sourceSection: 'Trigger sources',
    pollInterval: 'Polling interval (s)',
    useDetectFeedback: 'Enable the detect-feedback accelerator',
    cameraPushEnabled: 'Receive camera-pushed alarms (HTTP)',
    cameraPushPort: 'Push listener port',
    minAlarmLevel: 'Minimum alarm level',
    sourcePoll: 'Detection-log polling',
    noRecordingNoAction: 'This alarm has no recording-action result (it may have been acknowledged before the recording step ran).',
    noRecordingFailed: 'The local linkage recording FAILED',
    noRecordingSkipped: 'The local linkage recording was skipped this time (in cooldown, or the recording action is disabled)',
    sourceWebsocket: 'Detect-feedback stream',
    sourcePush: 'Camera push',
    sourceRunning: 'Running',
    sourceStopped: 'Stopped',
    sourceLastPoll: 'Last poll',
    sourceLastError: 'Last error',
    sourceTriggers: 'Triggers',
    sourceFrames: 'Frames received',
    sourceNoFrames: '0 frames so far (this event stream has never pushed data)',

    actionSection: 'Actions',
    action: {
      record: 'Recording',
      popup: 'Popup',
      notice: 'Notice',
      email: 'E-mail'
    },
    actionState: {
      success: 'Succeeded',
      failed: 'Failed',
      skipped: 'Skipped'
    },

    recordSection: 'Recording',
    recordDuration: 'Clip length (s)',
    recordCooldown: 'Cooldown (s)',
    recordSkipBusy: 'Skip while already recording',

    popupSection: 'Popup',
    popupAutoDismiss: 'Auto close (s)',
    popupCooldown: 'Cooldown (s)',
    popupMaxStack: 'Maximum on screen',

    noticeSection: 'Notice',
    noticeCapacity: 'Kept records',

    /**
     * The mail SERVER block moved to `emailUi` (manual §17.2.8 is its own tab).
     */
    emailActionSection: 'E-mail action',

    emailHostPlaceholder: 'for example smtp.example.com',
    emailPasswordPlaceholder: 'Leave blank to keep the stored password unchanged',
    emailPasswordStored: 'Password stored',
    emailPasswordNotStored: 'No password stored',
    emailPasswordClearHint: 'Enter a single space and save to clear the stored password',
    emailSubject: 'Subject template',
    emailBody: 'Body template',
    emailAttachFrame: 'Attach the captured frame',
    emailCooldown: 'Cooldown (s)',
    emailTesting: 'Sending…',
    emailTestOk: 'The test e-mail was accepted by the SMTP server ({count} recipients)',
    emailTestFailed: 'The test e-mail failed: {reason}',
    emailTestAttach: 'Test attachment',
    emailTestAttachNone: 'No attachment',
    emailTestAttachSynthetic: 'Built-in test image',
    emailTestAttachCamera: 'Current camera picture',
    emailTestPrompt: 'Save the settings first: the test uses the saved server and templates.',

    runtimeSection: 'Rate limits',
    maxActionsPerMinute: 'Global cap (actions per minute)',
    cooldownPeriod: 'Cooldown window (s)',
    cooldownPerPeriod: 'Cap per window',
    cooldownPerInterface: 'Cap per time slice',
    windowUsage: '{used} of {limit} used in this window',

    bellTitle: 'Alarms: {count} unacknowledged',
    deviceAlarmsTitle: 'Device alarms',
    deviceAlarmsEmpty: 'No unacknowledged device alarms',
    deviceAlarmAcknowledge: 'Acknowledge',
    deviceAlarmsMore: '{count} more not listed (see Alarm center for all)',
    pendingTitle: 'Pending alarms',
    pendingEmpty: 'No alarms right now',
    pendingAcknowledge: 'Acknowledge',
    pendingAcknowledgeAll: 'Acknowledge all',
    pendingAcknowledged: 'Acknowledged',
    pendingDropped: '{count} older alarms were dropped because the retained-record limit was reached',
    pendingLevel: 'Level',
    pendingStrategy: 'Strategy',
    metricIntensity: 'Sound intensity {value} dB',
    metricDf: 'Dominant freq {value} Hz',
    metricVolume: 'Leak volume {value}',
    metricLeakCost: 'Leak cost {value}',
    dischargeType: {
      corona: 'Corona discharge',
      suspension: 'Floating discharge',
      surface: 'Surface discharge',
      discharge: 'Discharge'
    },
    pendingNoActions: 'No action ran for this alarm',
    pendingEngineOff: 'Alarm linkage is currently switched off',
    pendingShow: 'Show pending alarms',

    adminOnly:
      'Changing the alarm-linkage configuration, sending a test e-mail and acknowledging alarms require an administrator account.',
    loadFailed: 'Could not read the alarm-linkage status',
    statusTriggers: '{count} triggers this run',
    statusActions: '{count} actions executed'
  },

  /**
   * Event & alarm centre (`/events`).
   *
   * Same hard rule as `linkage`: **no message here may contain `@`** (vue-i18n's
   * linked-message sigil). The wording mentions an unknown level, approximate
   * times and a missing device timestamp on purpose: the camera manual lists an
   * `alarm_level` field that has never been observed on a real device, and it
   * never declares its timestamp unit, so the page has to say which values came
   * from the device and which were derived.
   */
  eventsUi: {
    countSummary: '{total} events match the current filter',
    truncated:
      'This result is incomplete: a source was truncated (each source is read up to {cap} entries) or earlier alarms were dropped by the engine. The source panel below states how many.',
    emptyTitle: 'No events have been reported',
    emptyFilteredTitle: 'No event matches the current filter',

    sourcesTitle: 'Source status',
    sourceOk: '{count} read',
    sourceFailed: 'Read failed: {reason}',
    sourceTruncated: '{count} truncated',
    sourceUntimed: '{count} without a device timestamp',

    filterDevice: 'Device',
    filterAllDevices: 'All devices',
    filterSource: 'Source',
    filterAllSources: 'All sources',
    filterSeverity: 'Level',
    filterAllSeverities: 'All levels',
    filterFrom: 'From',
    filterTo: 'To',
    filterAck: 'Acknowledged',
    ackAll: 'All',
    ackUnacknowledged: 'Unacknowledged',
    ackAcknowledged: 'Acknowledged',

    approximateBadge: 'Approximate time',
    approximateHint:
      'The camera interface never declares its timestamp unit, so device time is read as seconds here and the converted value is approximate.',
    timeUnknown:
      'The device reported no time for this log, so the list orders it by observation time.',

    detailTitle: 'Event detail',
    detailEventId: 'Event identity',
    detailDevice: 'Device',
    detailSource: 'Source',
    detailKind: 'Event',
    detailSeverity: 'Level',
    detailDeviceTime: 'Raw device timestamp',
    detailDeviceTimeUnit: 'Unit assumed',
    detailSavingPath: 'Device folder',
    detailLogId: 'Detection log id',
    detailDetectMode: 'Detection mode (raw value)',
    detailAlarmLevel: 'Device alarm level (raw, not converted)',

    detailFilesTitle: 'Detection result files (device-side actions)',
    detailDetectTitle: 'Detection log detail',
    detailFilesEmpty: 'This detection log carries no result file',
    detailFileDownload: 'Download',
    detailFileDownloading: 'Downloading…',
    detailFileDownloaded: 'Downloaded',
    detailFilePlay: 'Play',
    detailFileOpenVideo: 'Open video',
    detailDownloadNeedAdmin: 'Downloading result files requires an administrator account',
    detailSourceUnavailable: 'This source failed to read just now; try again in a moment',

    detailAck: 'Acknowledge this event',
    detailAckUnsupported:
      'The camera side has no acknowledge endpoint for detection logs (none of the manual 32 open interfaces), so this entry cannot be acknowledged.',

    detailRecordingTitle: 'Local recording and image',
    detailRecordingNone: 'This event has no recording on this machine.',
    detailRecordingPending:
      'The result files of this detection have not been downloaded, so there is nothing local to play.',
    detailRecordingVideoUnavailable:
      'This recording cannot be played (the local file is missing or is not a video).',
    detailRecordingGoto: 'Go to recordings',
    detailFrameTitle: 'Linkage frame',

    detailMetricsTitle: 'Metrics',
    metricSoundmapIntensity: 'Sound map intensity',
    metricLeakVolume: 'Leak volume',
    metricLeakCost: 'Leak cost',
    detailActionsTitle: 'Linkage actions',
    detailActionLine: '{action}: {status}',
    detailActionReason: 'Reason: {reason}',

    detailLocalAlarmChannel: 'Channel',
    detailLocalAlarmTypes: 'Alarm types',

    downloadDone: 'Downloaded {name} ({size})',

    // --- Phase 3: KPI strip / filters / alert queue (spec §8–§10) -----------
    // All five spec levels have a name: `medium` / `low` cannot be produced yet (see
    // VISIBLE_ALERT_SEVERITIES), but AlertSeverity is a complete type — a missing name
    // would render a bare key the day Phase 5 stores five levels.
    alertSeverity: {
      critical: 'Critical',
      high: 'High',
      medium: 'Medium',
      low: 'Low',
      info: 'Info'
    },
    alertStatus: {
      new: 'New',
      acknowledged: 'Acknowledged',
      investigating: 'Investigating',
      resolved: 'Resolved',
      closed: 'Closed',
      muted: 'Muted',
      reopened: 'Reopened'
    },
    severityUnknown: 'Severity unknown',

    kpiUnacknowledged: 'Unacknowledged',
    kpiAvgAck: 'Avg. acknowledge',
    kpiScope: 'KPI and counts cover the {loaded} loaded of {total} results',

    viewMode: {
      compact: 'Compact',
      standard: 'Standard',
      evidence: 'Evidence'
    },

    searchPlaceholder: 'Search device, event, metric',
    filterTimeRange: 'Time range',
    searchScope: 'Search covers the {loaded} loaded rows only',

    savedViewTitle: 'Views',
    savedView: {
      all: 'All',
      critical: 'Critical',
      high: 'High',
      unacknowledged: 'Unacknowledged',
      last24h: 'Last 24 hours',
      last7d: 'Last 7 days'
    },

    filterPanelTitle: 'Filters',
    filterPanelToggle: 'Filter panel',
    panelCount: '{count}',
    panelScope: 'Counts cover the {loaded} loaded rows',
    clearFilters: 'Clear all',

    evidenceRecording: 'Recording',
    evidenceFrame: 'Frame',
    evidenceFiles: '{count} files',
    metricMore: '+{count} more',

    // --- Phase 4: detail drawer / Overview / Evidence (spec §11–§12) --------
    // All five tabs get a name: Timeline / Related / Activity only render in Phase 5,
    // but the tab type is complete — a missing name would print a bare key that day.
    detailTab: {
      overview: 'Overview',
      evidence: 'Evidence',
      timeline: 'Timeline',
      related: 'Related',
      activity: 'Activity'
    },
    colIndex: 'No.',
    overviewStatus: 'Status',
    overviewFirstDetected: 'First detected',
    overviewLastDetected: 'Last detected',
    overviewDuration: 'Duration',
    overviewOccurrences: 'Occurrences',
    drawerResize: 'Drag to resize the drawer',

    evidenceVisualTitle: 'Image evidence',
    evidenceExpand: 'Expand',
    evidenceExpandTitle: 'Evidence · expanded view',
    evidenceNone: 'No image evidence for this event.',
    evidenceNotCaptured: 'The device captured no image (snapshot download may have been off during sync).',
    evidenceFilesGone: 'The library records this image, but the file is gone from this machine.',
    evidenceNotImage: 'The file exists, but it is not an image format that can be displayed.',
    evidenceNotFound: 'No usable path for this image evidence.',
    evidenceError: 'Reading the image evidence failed.',

    // --- Phase 5: status machine / actions / Activity / Timeline / Related (§2.2, §13)
    actionInvestigate: 'Start investigating',
    actionResolve: 'Mark resolved',
    actionClose: 'Close',
    actionReopen: 'Reopen',
    actionMute: 'Mute',
    actionUnmute: 'Unmute',
    actionAssign: 'Assign',

    activityKind: {
      status: 'Status change',
      assign: 'Assignment',
      note: 'Note'
    },


    relatedSameDevice: 'Same device',
    relatedSameKind: 'Same event type',
    relatedTimeWindow: 'Within 10 minutes',

    // --- Phase 5 (UI): actions / timeline / related / activity ---------------
    relatedTitle: 'Related events',
    relatedScope: 'Related events are searched among the {loaded} loaded rows',
    relatedEmpty: 'No related events were found.',
    relatedOpen: 'Open this one',

    /*
     * --- Phase 6 second half (spec §13.2 suggestion card + §14.2 V1) ----------
     * "Incident" stays untranslated: the spec defines it alongside Event and Alert
     * (§2.1), and no English synonym is both accurate and unambiguous here.
     */
    incidentTitle: 'Incidents',
    incidentThreshold: 'Suggestion threshold',
    incidentThresholdOption: '{count} alerts',
    incidentBelowThreshold: 'Another {related} alert(s) on the same device — below the threshold ({count}), so no suggestion.',
    incidentNone: 'This alert is not linked to any incident yet.',
    incidentAlertCount: '{count} linked alert(s)',
    incidentUnlink: 'Unlink',
    incidentSuggestionLabel: 'Potential related incident',
    incidentSuggestionCount: '{count} correlated alert(s)',
    incidentSuggestedTitle: '{device} abnormal condition',
    incidentCreate: 'Create incident',
    incidentLinkExisting: 'Link to an existing incident',
    incidentCreated: 'Created "{title}" and linked {count} alert(s)',
    incidentLinked: 'Linked {linked} (another {already} were already in it)',
    incidentUnlinked: 'Unlinked from "{title}"',
    incidentFailed: 'That action did not succeed.',
    incidentDialogTitle: 'Incident',
    incidentModeLabel: 'What to do',
    incidentModeCreate: 'New incident',
    incidentModeLink: 'Link to existing',
    incidentFieldTitle: 'Title',
    incidentTitlePlaceholder: 'e.g. Fan 1 abnormal condition',
    incidentTitleHint: 'Up to {max} characters',
    incidentFieldNote: 'Note (optional)',
    incidentFieldExisting: 'Choose an incident',
    incidentCandidates: 'Link these alerts too ({count})',
    incidentNoCandidates: 'No alert to link — this only creates the incident itself.',
    incidentNoExisting: 'No incident exists yet',
    incidentSubmitCreate: 'Create and link',
    incidentSubmitLink: 'Link',
    incidentSubmitting: 'Saving…',
    incidentReasonTitleRequired: 'A title is required',
    incidentReasonTitleTooLong: 'The title is too long (up to {max} characters)',
    incidentReasonNoteTooLong: 'The note is too long (up to {max} characters)',
    incidentReasonNoExisting: 'Choose an incident first',
    incidentReasonNoAlerts: 'Select at least one alert',

    timelineTitle: 'Timeline',
    timelineDetected: 'First detected',

    activityTitle: 'Handling record',
    activityEmpty: 'No handling record for this event yet.',
    activityStatusLine: '{actor} changed the status from "{from}" to "{to}"',
    activityAssignLine: '{actor} assigned it to {name}',
    activityNoteLine: '{actor} commented',
    statusChangeDone: 'Status changed to "{status}"',
    assignDone: 'Assigned to {name}',
    actionAssignee: 'Assign to',
    actionNote: 'Add note',
    actionReopenNotePlaceholder: 'Reason for reopening (required)',
    actionNoteEmpty: 'Please enter a reason first',
    actionConfirm: 'Confirm',
    actionCancel: 'Cancel',

    // --- Phase 6: repeated-trigger aggregation (spec §14.1) -----------------
    groupWindowLabel: 'Grouping',
    groupWindow: {
      off: 'No grouping',
      m10: 'Within 10 minutes',
      m30: 'Within 30 minutes',
      h1: 'Within 1 hour'
    },
    occurrenceCount: '×{count}',
    timelineOccurrence: 'Trigger {index}',
    statusChangeDoneMany: 'Status of {count} triggers changed to "{status}"'

  }
}
