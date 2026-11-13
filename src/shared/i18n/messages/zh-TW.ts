/**
 * 繁體中文（台灣）。
 *
 * Typed against `MessageSchema`, which is derived from the Simplified Chinese
 * reference locale — a missing or renamed key is a compile error, not a runtime
 * surprise.
 *
 * 與其它目錄同一條鐵律：**任何一條消息裡不得出現 `@`**（vue-i18n 的
 * linked-message 記號，渲染時會編譯失敗，`tests/i18n.test.ts` 會編譯每一條
 * 消息來兜住這一點）。
 *
 * 用語對齊台灣慣用說法：軟體 / 韌體 / 視訊 / 資料 / 網路 / 儲存 / 登入 /
 * 帳號 / 預設 / 設定 / 攝影機 / 取樣率 / 串流 / 離線（設備）/ 線上（設備）。
 */

import type { MessageSchema } from '../schema'

export const zhTW: MessageSchema = {
  common: {
    confirm: '確認',
    cancel: '關閉',
    save: '儲存',
    saving: '儲存中…',
    delete: '刪除',
    edit: '編輯',
    close: '關閉',
    refresh: '重新整理',
    reset: '重設',
    loading: '載入中…',
    none: '無',
    unknown: '不明',
    clearSelection: '取消選取',
    viewAll: '檢視全部',
    unit: {
    }
  },

  errors: {
    DEVICE_OFFLINE: '設備目前離線，無法連線',
    TIMEOUT: '請求逾時，請檢查網路或設備狀態',
    AUTH_FAILED: '認證失敗，請檢查使用者名稱與密碼',
    INVALID_RESPONSE: '設備回傳的資料格式無法辨識',
    DEVICE_ERROR: '設備回報了一個錯誤',
    STORAGE_ERROR: '本機儲存操作失敗',
    RECORDING_EMPTY: '錄影儲存失敗：錄影檔案為空（0 位元組），已刪除。請檢查磁碟空間與相機串流後重試',
    RECORDING_INCOMPLETE: '錄影儲存失敗：錄影檔案不完整（缺少 moov 索引），已刪除。視訊串流可能在錄製過程中中斷',
    DISK_FULL: '磁碟可用空間不足，已暫停非必要錄音',
    NETWORK_ERROR: '網路連線失敗',
    VALIDATION_ERROR: '輸入內容不合法',
    NOT_IMPLEMENTED: '此功能暫不可用',
    UNKNOWN: '發生未知錯誤',
    fallback: '操作失敗',
    deviceDetail: '設備回傳：{detail}',
    withCode: '{message}（{code}）',
    /** 技術診斷細節（如 ffmpeg 的 stderr 尾行）附加在目錄消息之後；細節本身是技術英語，各語言共用。 */
    withDetail: '{message}（{detail}）',
    bridgeUnavailable: '無法連線到主行程，請重新啟動應用程式',
    bridgeUnavailableDetail: '{message}：{detail}',
    FORBIDDEN: '目前帳戶沒有執行此操作的權限',
    AUTH_USERNAME_TAKEN: '該使用者名稱已被占用',
    AUTH_LAST_ADMIN: '必須保留至少一個管理員帳戶',
    AUTH_PASSWORD_POLICY: '密碼不符合要求（至少 8 碼，不能包含使用者名稱，首尾不能有空格）',
    AUTH_LOCKED: '登入失敗次數過多，請稍後重試',
    authLockedRetry: '登入失敗次數過多，請在 {seconds} 秒後重試'
  },

  language: {
    label: '介面語言',
    description: '切換後立即生效，並會記住你的選擇。'
  },

  /** 日曆範圍選擇器（告警中心 / 事件中心共用的「一個日曆」）。 */
  picker: {
    placeholder: '選擇時間範圍',
    presetAll: '所有資料',
    presetToday: '今日',
    preset1h: '最近 1 小時',
    preset24h: '最近 24 小時',
    preset7d: '近 7 天',
    prevMonth: '上個月',
    nextMonth: '下個月',
    startTime: '開始時刻',
    endTime: '結束時刻',
    clear: '清除選取',
    confirm: '確定',
    sun: '週日',
    mon: '週一',
    tue: '週二',
    wed: '週三',
    thu: '週四',
    fri: '週五',
    sat: '週六'
  },

  /**
   * 應用外框：側欄、頂欄與視窗標題。
   *
   * `nav.*` 鍵同時被路由表與側欄引用，路由與其標籤不會因此分離。
   */
  app: {
    title: 'HAIS',
    tagline: '設備管理軟體',
    collapseSidebar: '收合側欄',
    expandSidebar: '展開側欄',
    nav: {
      overview: '總覽',
      devices: '設備管理',
      monitor: '即時監測',
      trends: '歷史趨勢',
      alarms: '警報中心',
      map: '地圖資訊',
      events: '事件總覽',
      recordings: '錄音檔案',
      samples: '樣本庫',
      settings: '系統設定',
      protocolLab: '協定實驗室',
      deviceDetail: '設備詳情'
    },
    versionFallback: '版本號 —',
    /**
     * 頁面頁尾（產品要求：右側底部顯示公司版權與版本號）。
     *
     * `{year}` 由介面帶入，取**發布日期**的年份而不是執行時的年份——版權聲明說的是
     * 那個發布的製品，不是「現在」。
     */
    footerCopyright: '版權所有 © {year} HERTZINNO',
    mainNavigation: '主導航',
    releasedOn: '發布於 {date}',
    builtOn: '建構於 {date}',
    appVersion: '應用程式版本',
    releaseDate: '發布日期',
    buildDate: '建構日期',
    operatingSystem: '作業系統',
    databasePath: '資料庫路徑',
    storageRootPath: '儲存根目錄',
    copyPath: '複製',
    copiedPath: '已複製'
  },

  /**
   * 設定頁。
   *
   * 命名為 `settingsUi` 而不是併進 `settings`，因為兩者承載不同性質的文字：
   * `settings.*` 放多個畫面共用的儲存與保留詞彙，這一塊是設定**畫面**自己的
   * 文案；併在一起會讓「這個標籤是共用還是畫面私有」變得含糊。
   */
  settingsUi: {
    saveButton: '儲存設定',
    revert: '復原修改',
    loadFailedTitle: '無法讀取系統設定',
    reload: '重新讀取',

    /* 頁簽（語言 / 儲存 / 視訊 / 告警 / 郵件 / 帳號 / 關於）。 */
    tabLanguage: '語言',
    tabGeneral: '一般',
    tabIntegration: '整合',
    tabGisServices: 'GIS 服務',
    cacheCardTitle: '快取',
    mapSourceLabel: '地圖來源',
    mapSourceLocal: '本機快取地圖',
    mapSourceLocalHint: '使用本機已下載的圖磚快取；需先在下方下載快取。',
    mapDefaultBadge: '預設',
    mapKeyRequired: '此服務需要 API Key',
    mapCacheGroup: '圖磚快取下載',
    mapCacheZoomMin: '最小級別',
    mapCacheZoomMax: '最大級別',
    mapCacheSouth: '南緯',
    mapCacheWest: '西經',
    mapCacheNorth: '北緯',
    mapCacheEast: '東經',
    mapCacheUseCenter: '填入目前中心',
    mapCacheStart: '開始下載',
    mapCacheRunning: '正在下載…',
    mapCacheNeedTemplate: '請先選擇地圖服務並填寫 URL 模板。',
    mapCacheBadZoom: '級別範圍需為 {min}–{max}',
    mapCacheBadBounds: '經緯度範圍不合法',
    mapCacheResult: '下載 {downloaded} · 跳過 {skipped} · 失敗 {failed} · 共 {size}',
    mapCacheProgressText: '已處理 {done}/{total}（失敗 {failed}）',
    linkageEnabledOn: '已啟用',
    linkageEnabledOff: '已關閉',
    tabStorage: '儲存',
    tabVideo: '視訊與緩衝',
    tabAlarm: '警報',

    /*
     * GIS / 線上底圖。
     */

    mapGroupService: '底圖服務（線上圖磚）',
    mapEnable: '啟用線上底圖',
    mapEnableHint: '預設關閉：關著時地圖頁仍用本機離線格線圖，不存取網路。啟用後只允許 https 的 XYZ 圖磚位址，並且必須填寫署名。',
    mapPresetsLabel: '免費服務預置',
    mapPresetsHint: '預置按「免費公開 → 全球商業 / 自帶 key → 中國區域 → 自訂」排列；商業服務的模板依公開文件預填，使用前請與服務商文件核對。',
    mapPresetOsm: 'OpenStreetMap 標準圖磚',
    mapPresetCarto: 'CARTO Basemaps',
    mapPresetTianditu: '天地圖',
    mapPresetCustom: '自訂 XYZ',
    mapPresetOpentopomap: 'OpenTopoMap（地形圖）',
    mapPresetEsri: 'Esri World Street Map',
    mapPresetMaptiler: 'MapTiler Cloud',
    mapPresetMapbox: 'Mapbox',
    mapPresetTomtom: 'TomTom Maps',
    mapPresetStadia: 'Stadia Maps（Stamen 系列）',
    mapBoundaryOsm: '授權邊界：免費；必須署名「© OpenStreetMap contributors」。Tile Usage Policy 不允許高流量或批次使用，也不接受把它當作預設底圖；本軟體預設關閉這一層。',
    mapBoundaryCarto: '授權邊界：免費底圖，必須署名「© CARTO © OpenStreetMap contributors」。商用 / 高流量條款我們未確認到明確寫法，標為待確認，不要當成可以商用。',
    mapBoundaryTianditu: '授權邊界：免費，但要自己申請 key，有配額；商用另需授權。本軟體不能替你申請 key，也不能保證配額夠用。',
    mapBoundaryCustom: '授權邊界：由你選擇的 XYZ 服務方規定。本軟體只校驗 https 與佔位符，不判斷授權是否涵蓋你的用途。',
    mapBoundaryOpentopomap: '授權邊界：免費；必須署名「Map data © OpenStreetMap contributors, SRTM | Map style © OpenTopoMap (CC-BY-SA)」。使用政策類似 OSM：不接受高流量 / 批次使用，不做預設。',
    mapBoundaryKeyProvider: '授權邊界：{service} 通常需要你自己註冊並申請 key（有免費額度，也可能收費）；署名、流量 / 並發限制、商用條件都由該服務商條款決定。本軟體不代申請、不保證配額或可用性，也不判斷你的授權是否涵蓋用途。',
    mapBoundaryEsri: '授權邊界：Esri 公共底圖服務；我們未確認到可免費商用的明確條款，標為待確認。使用前請依 Esri 主協定 / 帳號授權自行核對；需要 token 時請用自訂模板加 key 佔位符。本軟體不做預設。',
    mapGroupTemplate: 'XYZ 模板與署名',
    mapUrlTemplate: 'XYZ 範本',
    mapUrlHint: '必須包含 z、x、y 三個佔位符；可用 s 輪換子域、用 key 引用下面的金鑰。只允許 https://。',
    mapKey: '金鑰（可選）',
    mapKeyHint: '天地圖等需要 key 的服務把 key 放在這裡；金鑰儲存在本機設定庫中，不寫進日誌。',
    mapAttribution: '署名文字',
    mapAttributionHint: '會顯示在地圖右下角；啟用時不能留空。',
    mapErrTemplateRequired: '啟用線上底圖時必須填寫 XYZ 模板',
    mapErrTemplateProtocol: '只允許 https:// 位址（不允許 http、file 或其它協定）',
    mapErrTemplateTokens: 'XYZ 模板必須包含 z、x、y 三個佔位符',
    mapErrTemplateTokenUnknown: '模板裡有不認識的佔位符（只允許 z、x、y、s、key）',
    mapErrTemplateInvalid: 'XYZ 模板不是合法位址（檢查是否有空格或過長）',
    mapErrKeyRequired: '模板裡用了 key 佔位符，請填寫金鑰',
    mapErrKeyInvalid: '金鑰不合法（不能含換行，最長 512 字元）',
    mapErrAttributionRequired: '啟用線上底圖時必須填寫署名文字',
    restoreItemMapTiles: '線上地圖底圖（開關、XYZ 模板、金鑰與署名）',
    tabAccount: '帳號',
    tabAbout: '關於與維護',

    /** GIS 服務庫（地圖頁簽內）。 */
    mapServiceGroup: 'GIS 服務',
    mapServiceHint: '把常用的圖磚服務命名儲存起來，切換時一鍵套用；「套用」會覆蓋上方目前設定並打開開關。',
    mapServiceEmpty: '還沒有儲存的 GIS 服務。',
    mapServiceAdd: '新增服務',
    mapServiceSaveCurrent: '把目前設定儲存為服務',
    mapServiceApply: '套用',
    mapServiceEdit: '編輯',
    mapServiceDelete: '刪除',
    mapServiceDeleteConfirm: '刪除 GIS 服務「{name}」？',
    mapServiceSave: '儲存服務',
    mapServiceCancel: '關閉',
    mapServiceName: '服務名稱',
    mapServiceTest: '測試圖磚',
    mapServiceTesting: '測試中…',
    mapServiceTestOk: '範例圖磚載入成功，這個位址可以用。',
    mapServiceTestFail: '範例圖磚載入失敗（無外網、金鑰錯或服務拒絕）。',
    mapServiceTooMany: 'GIS 服務數量已達上限',

    /** AI 服務庫（AI 頁簽內）。 */
    aiServiceGroup: 'AI 服務',
    aiServiceHint: '新增常用的 AI 服務（OpenAI 相容介面），選中哪條就用哪條給樣本提候選標籤；金鑰只儲存在本機，介面不回顯。',
    aiServiceEmpty: '還沒有儲存的 AI 服務。',
    aiServiceAdd: '新增服務',
    aiServiceName: '服務名稱',
    aiServiceEndpoint: '介面位址',
    aiServiceModel: '模型名稱',
    aiServiceKey: '金鑰（API Key）',
    aiServiceKeyPlaceholder: '留空 = 不改動已存的金鑰',
    aiServiceKeyStored: '金鑰已儲存',
    aiServiceKeyNone: '未存金鑰',
    aiServiceDeleteConfirm: '刪除 AI 服務「{name}」？它的金鑰會一併刪除。',
    aiServiceSaveFailed: '儲存 AI 服務失敗',
    aiServiceTooMany: 'AI 服務數量已達上限',
    aiServiceUnknown: '尚未讀取服務狀態',
    aiServiceReady: '目前服務已就緒',
    aiPresetLabel: '廠家預置（點選填位址與模型）',
    aiPreset_openai: 'OpenAI',
    aiPreset_deepseek: 'DeepSeek',
    aiPreset_moonshot: 'Moonshot',
    aiPreset_zhipu: '智譜 GLM',
    aiPreset_qwen: '通義千問',
    aiPreset_ollama: 'Ollama（本機）',
    aiPreset_custom: '自訂',

    /** 儲存頁第一組的小標題：**儲存位置** + 保留策略。 */
    storageGroupLocation: '位置與保留',
    /** 視訊與緩衝頁裡那一組（設備探測與緩衝合成一組）。 */
    probeBufferGroup: '設備探測與緩衝',
    /** 帳號頁裡「目前工作階段」那一組（誰在登入 / 改密碼 / 登出）。 */
    accountSessionGroup: '目前工作階段',

    storagePath: '儲存路徑',
    picking: '選擇中…',
    browse: '瀏覽…',
    retentionDays: '錄音保留天數',
    minFreeGb: '最小剩餘空間（GB）',
    storageQuotaGb: '儲存配額（GB）',
    alarmReservePercent: '告警永久保留區比例（%）',
    storageQuotaHelp: '錄影、錄音、趨勢、日誌與快取合計的上限；0 = 不限制。超出後自動清理最舊的連續錄影。',

    healthCheckMs: '健康檢查間隔（毫秒）',
    offlineThreshold: '離線判定失敗次數',
    requestTimeoutMs: '請求逾時（毫秒）',

    preAlarmSeconds: '告警前錄製（秒）',
    postAlarmSeconds: '告警後錄製（秒）',
    ringBufferSeconds: '緩衝區總時長（秒）',

    liveSection: '即時視訊',
    autoPlayCameraLive: '開啟軟體時自動播放',
    autoPlayOn: '已開啟',
    autoPlayOff: '已關閉',

    diskSection: '磁碟占用',
    diskBelowFloor: '剩餘空間已低於安全閾值，已停止非必要錄音。請清理磁碟或調整「最小剩餘空間」。',
    diskUnavailable: '尚未讀取到磁碟資訊。',
    diskBarLabel: '磁碟已使用 {percent}%',
    diskUsedOfTotal: '已使用 / 總容量',
    diskUsedValue: '{used} / {total}（{percent}%）',
    diskFree: '剩餘空間',
    diskFreeValue: '{bytes}（{gb}）',
    diskAppUsage: '本程式占用',
    diskAppUsageValue: '{bytes}（約占 {percent}%）',
    quotaUsage: '配額占用',
    quotaUsageValue: '{used} / {quota}（{percent}%）',
    quotaUnlimited: '無上限（0 = 不限制）',
    quotaOverNotice: '已超出配額 {bytes}；自動清理只能保留永久告警與手動錄影。請清理手動錄影或調大配額。',
    quotaSweepPending: '已超過配額，自動清理預計可釋放 {bytes}。',

    trendSection: '趨勢儲存',
    trendFlushing: '寫入中…',
    trendFlushNow: '立即落盤',
    trendUnavailable: '尚未讀取到趨勢儲存狀態。',
    trendBuffered: '待寫入緩衝',
    trendFilesWritten: '已寫入檔案',
    trendRowsWritten: '已寫入行數',
    trendLastFlush: '最近落盤時間',
    trendNeverFlushed: '尚未落盤',
    trendLastError: '最近錯誤',
    trendWrote: '已寫入 {rows} 行，共 {files} 個檔案',
    trendNothing: '緩衝區為空，沒有需要寫入的資料',
    rows: '{count} 列',
    files: '{count} 個',

    saveFailed: '儲存失敗',
    saveSuccess: '設定已儲存',
    copyFailed: '複製失敗，請手動選取文字後複製',
    browsePicked: '已選擇新的儲存路徑，點擊「儲存設定」後生效',
    errStorageRoot: '儲存路徑不能為空',
    errRetentionDays: '保留天數需為不小於 1 的整數',
    errMinFree: '最小剩餘空間不能為負數',
    errStorageQuota: '儲存配額不能為負數',
    errAlarmReserve: '告警永久保留區比例需在 0–100 之間',
    errHealthCheck: '健康檢查間隔需不小於 1000 毫秒',
    errOfflineThreshold: '離線判定次數需為不小於 1 的整數',
    errRequestTimeout: '請求逾時需不小於 1000 毫秒',
    errAlarmWindows: '告警前後錄製時長不能為負數',
    errRingBuffer: '環形緩衝區時長需為不小於 1 的整數',
    errRingBufferTooShort: '環形緩衝區時長需不小於告警前 + 告警後錄製時長',

    /**
     * 一鍵恢復預設值（手冊 §17.2 第 5227 行）。
     *
     * `restoreItems*` 與 `SettingsService.RESTORABLE_SETTING_KEYS` 一一對應，
     * 由 `tests/account-settings.test.ts` 釘住項數；確認對話框逐項列出它們。
     */
    restoreDefaults: '恢復預設值',
    restoreTitle: '恢復預設值',
    restoreIntro: '以下系統設定項將被恢復為出廠預設值：',
    restoreItemStorage: '儲存路徑（恢復為平台預設路徑）',
    restoreItemRetention: '錄音保留天數',
    restoreItemMinFree: '最小剩餘空間',
    restoreItemHealthCheck: '健康檢查間隔',
    restoreItemOfflineThreshold: '離線判定失敗次數',
    restoreItemRequestTimeout: '請求逾時',
    restoreItemPreAlarm: '告警前錄製時長',
    restoreItemPostAlarm: '告警後錄製時長',
    restoreItemRingBuffer: '環形緩衝區總時長',
    restoreItemAutoPlay: '開啟軟體時自動播放即時視訊',
    restoreItemMaxStreams: '同時直播路數上限',
    restoreItemAlarmLinkage: '告警連動（含郵件伺服器、收件人、模板與冷卻）',
    restoreItemAlarmSounds: '告警聲音庫（聲音類型與所選音訊檔案）',
    restoreItemIotIngest: '資料接入（HTTP 推流 / MQTT 的開關、監聽位址與連接埠）',
    restoreItemMapServices: 'GIS 服務庫（已儲存的命名圖磚服務列表）',
    restoreWarnStorage: '儲存路徑會被改回預設值。磁碟上已有的錄影與錄音檔案不會被刪除，只是不再被指向；需要保留原路徑時請先記下它。',
    restoreKeeps: '設備列表、通道、錄影與錄音檔案、告警記錄、帳號與帳號權限都不會被改動。',
    restoreConfirm: '恢復預設值',
    restoreNotice: '系統設定項已恢復預設值。SMTP 口令仍儲存在本機憑證庫中，如需清除請在郵件設定裡點「清除已儲存的口令」。'
  },

  /**
   * 總覽頁「即時畫面」這一塊自己的文案。
   *
   * 與其它目錄塊同一條鐵律：**任何一條消息裡不得出現 `@`**，`tests/i18n.test.ts`
   * 會編譯每一條消息。
   */
  overviewLiveUi: {
    cameraLabel: '相機',
    device: '設備',
    fullscreen: '全螢幕',
    statusNoCamera: '未註冊相機',
    statusIdle: '尚未開始',
    statusStarting: '正在啟動視訊…',
    statusPlaying: '視訊播放中',
    statusRtspDisabled: '相機 RTSP 未啟用',
    statusFfmpegMissing: '內建 ffmpeg 不可用',
    statusError: '視訊串流失敗',
    statusLimitExceeded: '已達同時直播上限',
    statusOccupied: '畫面在另一個頁面上',
    noCameraHint: '尚未註冊聲學相機，先在「設備管理」中新增一台相機。',
    idleHint: '尚未開始播放。點擊「開始視訊」即可看到相機畫面。',
    startingHint: '正在啟動…',
    rtspDisabledHint:
      '相機的 RTSP 服務處於關閉狀態（設備上報 rtsp_enabled=0）。請在相機 Web 介面的「進階設定 → RTSP」中啟用後再試。',
    ffmpegMissingHint: '內建的 ffmpeg 轉封裝組件缺失或無法執行，請重新安裝本軟體；應用日誌中記錄了它查詢過的路徑。',
    errorHint: '視訊串流已中斷，可以點擊「重試」重新打開。',
    limitExceededHint:
      '本機同時直播的路數已達上限（可在「系統設定 → 即時視訊」調整）。請先停止其他畫面格裡的直播，再打開這一路。',
    occupiedHint:
      '監測頁正在播放這台相機的畫面。同一台相機同時只有一路畫面，點擊「開始視訊」會把畫面接管到本頁（對方頁面的畫面會停止）。',
    diagnosis: '主行程診斷：{reason}',
    rtspAddressUnknown: '設備未上報視訊位址'
  },

  devices: {
    addDevice: '新增設備',
    empty: '尚未新增設備',
    name: '設備名稱',
    ip: 'IP 位址',
    port: 'HTTP 連接埠',
    username: '使用者名稱',
    password: '密碼',
    testConnection: '測試連線',
    saveFailed: '儲存失敗',
    deleteFailed: '刪除設備失敗',
    status: {
      online: '線上',
      offline: '離線',
      unknown: '不明'
    },
    columns: {
      actions: '動作'
    }
  },
  devicesUi: {
    profileSection: '歸屬與屬性',
    profileSectionHint: '部門與自訂屬性只保存在本機，用於資產與運維歸檔；不會寫入裝置韌體。',
    department: '部門',
    departmentPlaceholder: '例如：運維一部',
    attributes: '屬性',
    addAttribute: '新增屬性',
    attributeKey: '屬性名稱',
    attributeValue: '屬性值',
    noAttributes: '尚未新增屬性',
    addButton: '新增裝置',
    noticeAdded: '裝置已新增',
    kindPushDevice: '推送裝置',
    noticeUpdated: '已更新裝置「{name}」',
    noticeRemoved: '已刪除裝置「{name}」',
    deviceId: '裝置 ID',
    mac: 'MAC 位址',
    channelCount: '通道數',
    /**
     * 裝置表的列表頭（業主 2026-09-17 的清單逐字給過；**2026-09-18 第 8 條重給了**）：
     * 序號 / 裝置名稱 / IP地址 / 裝置型別 / 狀態 / 告警數量 / 通道數 / 檢視 / 設定 / 刪除。
     *
     * 與上一版的差別：多了「序號」；「裝置IP」→「IP地址」、「是否線上」→「狀態」、
     * 「裝置通道」→「通道數」；「配置」拆成「設定」與「刪除」兩個圖示列（原來藏在 `⋮` 選單裡）。
     */
    indexColumn: '序號',
    ipColumn: 'IP 位址',
    channelColumn: '通道數',
    onlineColumn: '狀態',
    alarmCountColumn: '告警數量',
    ipDoubleClickHint: '雙擊開啟裝置 Web 介面',
    /** 裝置表那一列的表頭，也是「檢視」圖示按鈕的說明（業主的列清單裡叫「檢視」）。 */
    viewColumn: '檢視',
    /** 「設定」= 開啟編輯對話方塊（名稱 / 埠 / 憑據 / 地址資訊），業主第 10 條那一個。 */
    settingColumn: '設定',
    /** 「刪除」= 刪除這臺裝置（破壞性動作，彈確認）。 */
    deleteColumn: '刪除',
    /**
     * 「配置」：**點點陣圖/地圖頁**上那一臺裝置的入口（進 `/devices/:id` 的配置頁）。
     * 裝置表那一列按第 8 條改叫「設定」之後，這個詞只剩地圖頁一個讀者 —— 它說的仍然是
     * "配置這臺裝置"（頁籤：通道配置 / 告警策略 / 維護與升級），所以留著。
     */
    configure: '設定',
    /** 點裝置名進詳情/配置頁（頁籤：概覽 / 檢測模式 / 告警策略 / 維護與升級）。 */
    openDetail: '檢視裝置詳情與配置',
    /** 編輯對話方塊裡 IP 那一格只讀的原因（業主第 10 條：IP 不可改）。 */
    ipReadonlyHint: 'IP 地址決定裝置身份，不可修改',
    /** 憑據兩格留空的意思（口令與使用者名稱都不回顯）。 */
    credentialsKeep: '留白 = 不修改',
    credentialsHint: '憑據儲存在本機憑據庫裡，不會回顯；填了才會寫入。',
    passwordShow: '顯示密碼',
    passwordHide: '隱藏密碼',
    editTitle: '編輯裝置',
    editNameRequired: '裝置名稱不能為空',
    editPortInvalid: 'HTTP 埠需為 1-65535 之間的整數',
    deleteTitle: '刪除裝置',
    deleteBody: '確定要刪除裝置「{name}」嗎？該裝置的歷史告警與錄音記錄將保留，但本地儲存的連線憑據會被清除。',
    removing: '刪除中…',
    confirmDelete: '確認刪除'
  },

  /**
   * 拓撲樹上的重新命名（右鍵 → 修改裝置名稱 / 修改通道名稱）。
   *
   * 這一塊的存在理由是**誠實**，不是措辭：同一個動作在三種情形下落點不同 ——
   *   - 聲紋裝置：本地庫 + 裝置自身的名字都改（`config.setDeviceName`）；
   *   - 聲學相機：FA371 的開放介面裡**沒有**裝置名稱端點
   *     （`docs/reference/FA371-api-spec.md` §3 的表後註明確列出「裝置重新命名」未開放），
   *     所以只能改我們本地資料庫，「裝置本身」一個字都沒變；
   *   - 通道：只改裝置（本地庫裡的通道表隨後由 `devices.getChannels` 重新讀出）。
   *
   * 因此成功提示分成 `renameBoxNotice` / `renameCameraNotice` 兩條：操作員讀完這一句
   * 必須知道**剛剛到底改動了什麼**，而「已重新命名」四個字會讓他以為相機的名字也改了。
   */
  time: {
    justNow: '剛剛',
    secondsAgo: '{count} 秒之前',
    minutesAgo: '{count} 分鐘前',
    hoursAgo: '{count} 小時前',
    daysAgo: '{count} 天之前',
    never: '從未'
  },

  duration: {
    minutesSeconds: '{minutes} 分鐘 {seconds} 秒',
    hoursMinutes: '{hours} 小時 {minutes} 分'
  },

  /**
   * Alarm taxonomy (appendix B). Keys match `ALARM_TYPE_KEYS` in
   * `shared/domain/models.ts` exactly, so the mapping needs no lookup table of
   * its own — `t('alarms.type.' + alarmTypeKey(type))` is the whole mechanism.
   */
  alarms: {
    type: {
      spl: '聲壓級異常',
      main_frequency: '主頻異常',
      band_energy_ratio: '頻帶能量比異常',
      smoothness: '平滑度異常',
      clamp_looseness: '夾具鬆動',
      cooler_anomaly_a: '冷卻器異常 A',
      cooler_anomaly_b: '冷卻器異常 B',
      overload: '過載',
      short_circuit_surge: '短路衝擊',
      surface_discharge: '沿面放電',
      corona_discharge: '電暈放電',
      gap_discharge: '間隙放電',
      floating_discharge: '懸浮放電',
      dc_bias: '直流偏壓'
    },
    /** Unknown bit set: surfaced rather than dropped, so new firmware is visible. */
    unknownMask: '不明警報 (0x{mask})',
    none: '無告警'
  },

  /**
   * Alarm records screen.
   *
   * The `metric*` labels are shared with the trend page's metric picker, so they
   * live under `metrics` rather than here — otherwise the same acoustic quantity
   * would end up named twice and could drift.
   */
  sonarUi: {
    mapTitle: '裝置位置',
    noGis: '這臺裝置還沒有 GIS 座標（在裝置管理裡補安裝位置）。',
    currentSpl: '當前分貝',
    azimuth: '當前方位指向',
    playAudio: '播放最近錄音',
    playLiveAudio: '播放即時音訊',
    stopLiveAudio: '停止即時音訊',
    ptzPreviewTitle: 'PTZ 相機',
    ptzLivePreview: 'PTZ 即時預覽',
    ptzAlarmVideo: '影片',
    ptzLiveReserved: 'PTZ 即時預覽將在此顯示。',
    ptzAlarmReserved: 'PTZ 告警影片將在此顯示。',
    calibratedDirection: '校準方向',
    calibrationAngle: '校準角度',
    calibrationSaved: '校準已儲存',
    installationOffset: '安裝偏移 {degrees}°',
    callbackConnected: '已連線',
    callbackDisconnected: '未連線',
    audioChannel: '音訊通道',
    pullingAudio: '正在擷取 CH{channel}',
    pullAudio: '擷取音訊',
    stopPullAudio: '停止音訊',
    ptzPreviewReserved: 'PTZ 聯動已啟用，即時預覽與告警影片將在此顯示。',
    ptzNotLinked: '未連接 PTZ 相機',
    deviceInfoTitle: '裝置資訊',
    deviceTitle: '裝置',
    settingsTitle: '裝置設定',
    switchToPtz: '切換到 PTZ 相機',
    switchToLocation: '切換到裝置位置',
    viewSwitch: '檢視切換',
    deviceInfoIp: 'IP 位址',
    deviceInfoStatus: '狀態',
    deviceInfoFirmware: '韌體',
    stopAudio: '停止播放音訊',
    noAudio: '還沒有可播放的錄音',
    realtimeOff: '即時值未接入：裝置回呼未指向本機，或本機接收埠未開啟。',
    enableRealtime: '開啟即時資料',
    waitingRealtime: '回呼已開啟，正在等待裝置推送即時值…',
    fromLatestAlarm: '最近告警方位',
    syncRecordings: '同步告警錄音',
    syncingRecordings: '同步中…',
    recordSyncDone: '錄音同步完成：新儲存 {saved} 筆，已有 {existing} 筆，缺少 {missing} 筆。',
    latestAlarm: '最近一筆告警',
    noSnapshot: '這條告警沒有抓圖。',
    alarmDirection: '告警方位',
    alarmSpl: '分貝大小',
    alarmType: '告警類型',
    alarmTime: '告警時間',
    noAlarms: '這臺裝置還沒有告警記錄。',
    history: '歷史告警'
  },
  alarmsUi: {
    countSummary: '共 {total} 條記錄，已選 {selected} 條',
    metricBandEnergyRatio: '頻帶能量比',
    detailDevice: '告警裝置',
    detailContent: '告警內容',
    overviewStatus: '告警狀態',
    cameraEvidenceMissing: '這條告警沒有取到抓圖。',
    cameraEvidenceLoading: '正在讀取抓圖…',
    cameraActionsTitle: '聯動動作結果',
    cameraAlarmNotFound: '這條相機告警已經不在待處理清單裡（可能已被確認並因超出保留上限被丟棄）。',
    viewInEventCenter: '在事件中心查看完整證據',
    cameraRowBadge: '相機',
    cameraSectionTitle: '相機告警',
    cameraSectionEmpty: '相機還沒有推送過告警。',
    cameraAlarmGeneric: '相機告警',
    bulkAcknowledge: '批次確認',
    bulkUnacknowledge: '取消確認',
    addSelectedToSamples: '加入樣本庫',
    sampleAddDone: '入庫完成：新增 {created} 條，已在庫 {existing} 條，其中 {withMetrics} 條帶特徵值。',
    sampleAddPartial: '入庫完成：新增 {created} 條，已在庫 {existing} 條，失敗 {failed} 條（記錄已不存在）。',
    sampleAddedWithMetrics: '已入庫（{count} 維特徵），弱標籤：{label}',
    sampleAddedNoMetrics: '已入庫，但這條告警沒有特徵值，暫時不能參與訓練。',
    sampleAlreadyIn: '這條已經在樣本庫裡了（未重複寫入）。',
    sampleSectionTitle: '樣本庫',
    sampleSectionHint: '把這條告警的指標與弱標籤存進本地樣本庫，供二次訓練。',
    addToSamples: '加入樣本庫',
    goSamples: '檢視樣本庫',
    filterDevice: '裝置',
    filterAllDevices: '全部裝置',
    filterChannel: '聲道',
    filterType: '告警型別',
    filterAllTypes: '全部型別',
    filterFrom: '開始時間',
    /** 篩選行（業主重構：標題 + 內容 + 一個日曆）。 */
    filterTitle: '標題',
    filterTitleHint: '按裝置名搜尋',
    filterContent: '內容',
    filterContentHint: '按備註 / 告警原因搜尋',
    filterTimeRange: '時間範圍',
    /** 行右鍵選單。 */
    menuDetail: '檢視詳情',
    menuReplay: '重播',
    menuDownload: '下載告警',
    menuAddSample: '加入樣本',
    menuAck: '確認',
    menuUnack: '取消確認',
    menuNoRecording: '這條告警沒有本機錄音，無法下載',
    downloadDone: '已儲存到 {path}',
    videoTitle: '告警影片',
    snapshotsTitle: '告警抓圖',
    filterTo: '結束時間',
    filterAck: '確認狀態',
    filterAllChannels: '全部聲道',
    ackAll: '全部確認',
    ackAcknowledged: '已確認',
    ackUnacknowledged: '未確認',
    columnTime: '時間',
    columnDevice: '裝置',
    columnChannel: '聲道',
    columnType: '告警型別',
    columnStatus: '狀態',
    selectAll: '全選',
    selectRow: '選擇 {id}',
    loading: '正在載入…',
    empty: '沒有符合條件的告警記錄',
    pagerRange: '第 {from} – {to} 條 / 共 {total} 條',
    prevPage: '上一頁',
    nextPage: '下一頁',
    detailTitle: '告警詳情',
    metricsTitle: '告警時刻指標',
    playbackTitle: '錄音回放',
    goSyncRecordings: '前往「錄音檔案」同步錄音',
    ackSectionTitle: '確認',
    markAcknowledged: '標記為已確認',
    notifyAcknowledged: '已確認 {count} 條告警',
    notifyUnacknowledged: '已取消確認 {count} 條告警',
    notifyDetailAcknowledged: '該告警已確認',
    notifyDetailUnacknowledged: '該告警已取消確認',
    filterSeverity: '告警等級',
    filterAllSeverities: '全部等級',
    moreFilters: '更多篩選',
    hideMoreFilters: '收起更多篩選',
    moreFiltersActive: '更多篩選（{count} 項生效）',
    columnSeverity: '告警等級',
    severitySectionTitle: '告警等級',
    noteSectionTitle: '備註',
    noteEmpty: '還沒有備註',
    notePlaceholder: '寫一條備註…',
    noteSave: '儲存備註',
    noteClear: '清除備註',
    noteTooLong: '備註最多 {max} 個字元（當前 {length}）',
    noteSaved: '備註已儲存',
    noteCleared: '備註已清除',
    severitySaved: '告警等級已改為「{level}」',
    recordMissing: '這條告警已不在記錄中，改動沒有儲存',
    prevEvent: '上一個事件',
    nextEvent: '下一個事件',
    eventPosition: '第 {index} / {total} 條（當前篩選結果）'
  },

  /** Acoustic quantity names, shared by the alarm detail panel and the trend page. */
  metrics: {
    spl: '聲壓級',
    mainFrequency: '主頻',
    smoothness: '平穩度',
    bandEnergyRatio: '頻帶能量比',
    oddEvenHarmonicRatio: '奇偶諧波比',
    spectralComplexity: '頻譜複雜度',
    fingerprintVariation: '指紋變化度'
  },

  /**
   * Domain labels. Keys mirror `ALARM_TYPE_KEYS`-style snake_case identifiers so
   * `t('domain.sensorType.' + key)` needs no lookup table of its own.
   */
  recordingsUi: {
    filterType: '錄音型別',
    filterAllTypes: '全部型別',
    columnStart: '開始時間',
    columnDevice: '裝置',
    columnChannel: '聲道',
    columnType: '型別',
    columnDuration: '時長',
    columnSampleRate: '取樣率',
    columnFormat: '檔案格式',
    columnSize: '檔案大小',
    columnDownloaded: '下載狀態',
    columnPlay: '開始播放',
    columnSample: '樣本庫',
    addToSamples: '加入樣本庫',
    sampleHint: '錄音本身不含特徵值：入庫後可人工標註，但要能訓練還需有特徵資料',
    sampleAddedNoMetrics: '已入庫。這段錄音沒有特徵值，暫時不能參與訓練——可在樣本庫里人工標註。',
    sampleAlreadyIn: '這段錄音已經在樣本庫裡了（未重複寫入）。',
    empty: '暫無錄音檔案，可使用「同步裝置錄音」從裝置匯入',
    downloaded: '已下載',
    notDownloaded: '未下載',
    playLabel: '播放 {time} 的錄音',
    playLocal: '播放本地錄音',
    playRemote: '播放（將先從裝置下載）',
    playerTitle: '錄音回放',
    playerTitleAt: '錄音回放 · {time}',
    videoPlayerTitle: '影片錄影播放',
    videoLoading: '正在開啟影片檔案…',
    videoUnavailable: '該錄影無法在內建播放器中播放（本地檔案缺失或格式不受支援）。'
  },

  mapPickerUi: {
    title: '在地圖上選點',
    hint: '左鍵拖動地圖，右鍵確認點位',
    offlineHint: '線上底圖未啟用：仍可點擊網格選點。',
    selected: '已選：{lat}, {lon}',
    zoomIn: '放大檢視',
    zoomOut: '縮小',
    confirm: '使用此點位',
    pickButton: '在地圖上選點'
  },
  gasLeakUi: {
    title: '氣井洩漏監測',
    badge: '裝置端偵測',
    panelTitle: '洩漏檢測',
    manualRecording: '手動錄音',
    syncAudio: '同步音訊',
    audioSynced: '音訊同步完成：儲存 {count} 條',
    playAudio: '播放錄音',
    stopAudio: '停止音訊',
    noAudio: '無錄音',
    noLiveStream: '目前韌體不提供即時音訊/頻譜串流；洩漏偵測在裝置端執行，結果以告警錄音回傳。下方顯示已同步到本機的洩漏告警錄音。',
    alarmCount: '累計洩漏告警',
    alarmHistory: '告警歷史',
    latestAlarm: '最近一筆告警',
    none: '暫無',
    channels: '啟用通道',
    sync: '同步告警錄音',
    syncing: '同步中…',
    synced: '已同步 {count} 筆',
    syncFailed: '同步失敗：{reason}',
    goRecordings: '查看全部錄音'
  },
  monitorUi: {
    noDeviceTitle: '請先新增裝置',
    goToDevices: '前往裝置管理',
    deviceLabel: '監測裝置',
    noAddress: '無地址',
    channelHint: '{count} 個通道',
    /*
     * 這裡原來還有 `start: '開始監測'` / `stop: '停止監測'`：業主 2026-09-19 第 13 批
     * 第 3 條要求「選中裝置就預設開始接收資料，不用點選開始監測按鈕」，按鈕刪掉之後
     * 這兩個詞條沒有任何地方再用（會話狀態仍然由頁頭那枚徽標顯示），
     * 四本目錄同步刪除 —— 理由見 §15.80。
     */
    channelSelect: '通道選擇',
    /** 聲吶那一支的機型徽標（頂欄狀態行）。 */
    sonarFamilyBadge: 'SN-16 空氣聲吶',
    /*
     * 這裡原來還有 `sonarLiveUnwired`（"實時音訊/時頻流尚未接入（手冊給的是 WebSocket 路徑，
     * 未在真機驗證）……"）那一長句：它既在頁面頂上當橫幅，也掛在機型徽標的 `title` 上。
     * 業主 2026-09-18 第 19 條要求刪掉這段話 —— 裝置在不線上改由裝置下拉旁邊的綠點/灰點
     * 回答，不再用一句話解釋"這一屏為什麼沒有實時圖"。四個目錄同步刪除，理由留在這裡。
     */
    /*
     * 「資料流狀態」那張卡片與「當前幀」卡片按業主 2026-09-17 的要求刪掉了（③），
     * 相關的鍵（streamSection/streamSummary/currentFrameSection/frameTimestamp/
     * sampleRate/currentChannel/dataSource/spectrogramCache/frames）一併刪除 ——
     * 死鍵留在目錄裡會讓下一次審計讀不出"哪些是沒人用的"。
     * 但**失敗不留啞**：`streamFailure` 這一句保留了原來那張卡片的真正價值
     * （哪一路壞了）。
     */
    streamFailure: '{name} 這一路出錯',
    currentValue: '{channel} 當前值',
    /*
     * ② 每通道聲紋特性卡片（業主 2026-09-17）。
     *
     * 三種讀數狀態必須分開寫：`live` 是此刻在收的那一路，`stored` 是**上一次**讀到的
     * （卡片上帶時間），`unread` 是從沒讀到過。把它們合成一句"無資料"就等於把
     * "舊讀數"和"沒讀到"混成同一件事 —— 而操作員正是靠這個區別決定要不要相信那個數字。
     */
    channelFeaturesSection: '每通道聲紋特性',
    /** 通道特性翻頁範圍文案（每頁 4 通道）。 */
    channelPager: '{start}-{end} / {total}',
    /** 聲學波形卡音量浮層的無障礙名稱。 */
    volumeLabel: '音量大小',
    /** 趨勢卡檢視切換（業主 20260921 批第 24 條：單通道 / 檢測）。 */
    viewMode: '檢視切換',
    modeSingle: '單通道',
    modeDetect: '檢測',
    detectSpl: '聲壓級',
    detectSmoothness: '平穩度',
    detectEnergyRatio: '頻帶能量比',
    detectDominantFreq: '主頻',
    /** 檢測卡圖例：{channel} 傳入 CH1..CH8。 */
    detectLegendChannel: '聲道 {channel}',
    /** 檢測模式資料口徑說明（裝置一次只開一路流，各通道曲線不同步）。 */
    detectDataNote: '勾選多路時每一路各開一條連線（一條勾選 = 一條連線）：每條曲線是該通道在同一工作階段收到的讀數，通道內連續、跨通道時間不同步。',
    channelFeature_live: '實時',
    channelFeature_stored: '最後一次讀數',
    channelFeature_unread: '未讀取',
    channelFeatureUnread: '這一路還沒有讀到過特徵幀',
    channelFeatureUpdated: '更新於 {time}',
    /*
     * 2026-09-19 第 13 批第 3 條：這張卡片從"每通道一張小卡"改成**一張表**
     * （8 行 × 通道序號/聲壓級/主頻/平穩度/頻帶能量比/是否告警），並且
     * 「點選告警則顯示詳細的告警狀態」。下面這一組就是表頭與告警那一列/詳情彈窗的詞條。
     */
    channelFeatureColumnChannel: '聲道',
    channelFeatureColumnAlarm: '警報',
    channelAlarmYes: '警報',
    /*
     * 有記錄但**都確認過了**：不標紅（確認過的不再打斷人），但入口留著 ——
     * 已確認不等於沒發生過（判據在 `@shared/domain/channel-alarm.ts`）。
     */
    channelAlarmAcknowledged: '已確認',
    channelAlarmNone: '無異常',
    channelAlarmOpen: '檢視這一路的詳細告警狀態',
    /*
     * 這一列是**取樣視窗**裡的結論（最近 N 條），必須把 N 說出來：
     * 不寫就等於把"最近這一批記錄裡沒有"說成了"歷史上從沒有過"。
     */
    channelAlarmSampleHint: '告警一列來自最近 {count} 條告警記錄；已確認的不再標紅，仍可檢視詳情',
    channelAlarmDetailTitle: '{channel} 詳細告警狀態',
    channelAlarmAcknowledgedState: '已確認',
    channelAlarmUnacknowledgedState: '未確認',
    audioSection: '實時音訊',
    audioPlay: '開始播放',
    audioStop: '結束播放',
    audioVolume: '音量大小',
    /*
     * 回放的是**包絡預覽**而不是原聲：跨 IPC 過來的是 100 ms 一幀的降取樣波形。
     * 這句話必須留著 —— 不說清楚就是在讓操作員以為他聽到的是裝置裡的原始聲音。
     */
    startRecording: '開始錄音',
    stopRecording: '停止錄音',
    trendSection: '實時趨勢',
    spectrumSection: '頻譜',
    spectrogramSection: '時頻圖',
    /*
     * ③b 四張圖譜卡片裡的「聲學波形」：畫的是**跨 IPC 過來的降取樣包絡本身**
     * （100 ms 一幀），與「播放」按鈕聽到的是同一份資料 —— 所以那句說明照這個寫。
     */
    waveformSection: '聲學波形',
    waveformAmplitude: '歸一化幅度',
    addToWall: '添加到影片牆',
    onWall: '已在影片牆',
    waitingAudio: '等待音訊幀…',
    /*
     * ③b 時間軸回放：只回放**本機**檔案。
     * FA8 這一族沒有裝置側連續錄影，寫成"回放裝置錄影"就是一句假話。
     */
    playbackSection: '時間軸回放',
    playbackLocalOnly: '只回放本機檔案（裝置側沒有連續錄影）',
    playbackPrevious: '上一段落',
    playbackNext: '下一段落',
    playbackZoomIn: '拉近',
    playbackZoomOut: '縮小',
    playbackWindow: '{from} – {to}',
    playbackNow: '現在',
    playbackLoading: '正在讀取本機錄影…',
    playbackEmpty: '本機還沒有這臺裝置的錄影（手動錄影或從裝置下載檢測錄影之後會出現在這裡）',
    /*
     * 這一條**保留**：`RecordingPlayer`（回放面板）用它給取樣率那一格做標籤。
     * 名字帶 `monitorUi` 是歷史原因，四語言必須一致，所以它留在這裡而不是新開一個鍵。
     */
    sampleRate: '取樣率',
    /*
     * 這一組（`offlineBanner` / `offlineNoIp` / `offlineLastContent` / `offlineNoContent` /
     * `waitingBanner` / `staleBanner` / `stoppedBanner`）**在 2026-09-19 第 13 批第 1 條刪掉了**：
     * 業主說「實時監測裡面如果有告警彈窗（192.168.110.90 離線 還沒有收到過這臺裝置的任何資料）
     * 這個內容不用顯示」—— 那幾句就是那條提示條的正文。四本目錄同時刪，理由見 §15.78。
     */
    staleBadge: '上次內容',
    waitingFeatures: '等待實時特徵幀…',
    waitingSpectrum: '等待頻譜幀…',
    waitingSpectrumData: '等待頻譜資料…',
    sessionRunning: '實時資料執行中',
    sessionStarting: '正在啟動資料流…',
    sessionError: '資料流異常',
    sessionStopped: '實時資料已停止',
    spectrumPerBin: '每個 bin {hz} Hz',
    chartNormalizedEnergy: '歸一化能量',
    chartBandEnergy: '頻帶能量'
  },

  streamState: {
    IDLE: '空閒',
    CONNECTING: '連線中',
    STREAMING: '串流接收中',
    RECONNECTING: '重連中',
    STOPPED: '已中止',
    ERROR: '錯誤'
  },

  spectrum: {
    /** Range label for the frequency axis, e.g. "0 – 48 kHz". */
  },

  trendsUi: {
    noDeviceTitle: '請先新增裝置',
    goToDevices: '前往裝置管理',
    filterDevice: '裝置',
    /** 趨勢頁下方「所選時間段的告警」卡（業主 20260921）。 */
    rangeAlarmsTitle: '時間段告警',
    rangeAlarmsCount: '範圍內 {count} 條',
    /** 指標拖拽排序的氣泡提示。 */
    metricDragHint: '拖動調整圖表順序（點選切換顯示）',
    /*
     * 這裡原來還有 `filterChannel: '通道'`（篩選欄裡那一排通道名前面的標籤）。
     * 第 13 批第 4 條把通道搬到**圖右側那一列**（那一列自己有標題 `channelPanelTitle`），
     * 篩選欄裡不再有通道控制元件，所以這個鍵四本目錄一起刪 —— 留著就是死鍵。
     */
    noAddress: '無地址',
    filterMetric: '指標',
    channelHide: '隱藏這條通道',
    channelShow: '顯示這條通道',
    channelShowAll: '全部顯示',
    /*
     * 第 13 批第 4 條：通道改成**右側一列**（8 或 2 個通道 CH1…），可重新命名、無資料灰顯、
     * 有資料可勾選。下面這一組是那一列與改名用的詞條。
     */
    channelPanelTitle: '聲道',
    channelPanelSummary: '{withData} / {total} 路有資料',
    channelNoData: '這一段範圍裡這一路沒有讀數，勾選它只會得到一條空線',
    channelRenameHint: '改這一路的名稱（寫進裝置，其餘通道不變）',
    channelRenameOffline: '改名要寫裝置：裝置線上、且是聲紋裝置時才能改',
    channelRenamePlaceholder: '通道名稱',
    channelRenameFailed: '改名失敗（裝置沒有確認）',
    channelRenamed: '{channel} 已重新命名',
    /*
     * 三條判定失敗的說明（鍵名字尾與 `@shared/domain/channel-name.ts` 的
     * `CHANNEL_NAME_PROBLEM_KEYS` 一一對應）。
     */
    channelNameError_empty: '通道名稱不能為空',
    channelNameError_tooLong: '通道名稱最多 {count} 個字元',
    channelNameError_unchanged: '名稱沒有變化',
    channelLines: '{count} 條通道',
    metricLimit: '最多同時顯示 {count} 個量',
    metricMultiHint: '已選 {count} 個量：每個量一張圖，每張圖裡是所有可見通道',
    metricNoData: '這個量在這段時間裡沒有讀數（裝置沒有上報這一段）。',
    filterRangeLabel: '時間範圍',
    /*
     * `filterAggregation`（「聚合方式」）**刪掉了**（第 13 批第 5 條：「刪除聚合方式」）：
     * 那個下拉框沒有了，桶裡怎麼算固定是平均，Y 軸名字裡照舊寫著「（平均）」。
     * 接著往下 `latestBucket` / `rangeMinBucket` / `rangeMaxBucket` / `emptyBuckets`
     * 四個鍵也刪了 —— 它們只被那四張被刪掉的卡片用（業主：「聲壓級那四張卡片刪除；
     * 只顯示趨勢曲線」）。四本目錄同步刪，理由見 §15.82。
     */
    granularityLabel: '顆粒度',
    /*
     * 第 13 批第 6 條：時間軸縮放 + 資料匯出 + 列印為 PDF。
     */
    zoomHint: '當前顯示第 {from}–{to} 個點（共 {total} 點）：{range}',
    zoomReset: '重置縮放',
    exportCsv: '匯出資料',
    exporting: '正在匯出…',
    exportHint: '把當前這一屏查到的資料存成 CSV（只匯出正在顯示的通道）',
    exportDone: '已匯出 {rows} 行到 {path}（{bytes}）',
    exportNothing: '當前這一屏沒有可匯出的資料（先查一次、或換一段時間）',
    exportFailed: '匯出失敗（主程序沒有確認寫盤結果）',
    print: '列印 / 存為 PDF',
    printHint: '開啟列印對話方塊；在"目標"裡選"另存為 PDF"就能拿到 PDF',
    filterFrom: '起始時間',
    filterTo: '結束時間',
    incompleteRange: '請選擇完整的起始與結束時間',
    chartTitle: '趨勢曲線',
    truncated: '結果已達到最大點數上限，僅顯示前 {count} 個時間桶。請縮小時間範圍以檢視完整曲線。',
    noDeviceSelectedTitle: '請先選擇裝置',
    noHistoryTitle: '該裝置暫無歷史資料',
    goToMonitor: '前往實時監測',
    emptyRangeTitle: '所選時間範圍內沒有資料',
    coverageAvailable: '檢視可用範圍：{range}',
    noDataInBucket: '{value}（該時間桶無資料）',
    sampleCount: '樣本數：{count}',
    loadingNotice: '正在查詢歷史資料…',
    noDataNotice: '尚未查詢到資料',
    flushedNotice: '已寫入 {rows} 行到 {files} 個歷史檔案',
    emptyBufferNotice: '緩衝區為空，沒有需要寫入的資料',
  },

  aggregation: {
    avg: '平均值',
    min: '最小值',
    max: '最大值',
    p95: '95 分位數'
  },

  /*
   * X 軸的時間顆粒度（業主 2026-09-19 第 13 批第 5 條：「X 軸支援自定義縮放時間顆粒度」）。
   *
   * 六檔 + 自動，檔位的劃分是**本倉庫的設計**（手冊未說明，見
   * `src/shared/domain/trend-granularity.ts` 的檔案頭）：秒級看瞬態、分鐘級看班次、
   * 小時/天級看長期趨勢。「自動」那一檔旁邊會把主程序實際挑的桶寬寫出來。
   */
  granularity: {
    auto: '自動',
    autoLabel: '按時間跨度自動挑一格',
    autoHint: '自動挑的桶寬：{bucket}',
    fixedHint: '固定每一格的時間跨度（越細越接近原始讀數）',
    sec1: '每秒',
    sec10: '每 10 秒',
    min1: '1 分鐘',
    min5: '5 分鐘',
    hour1: '1 小時',
    day1: '每天'
  },

  bucket: {
    seconds: '共 {count} 秒',
    minutes: '{count} 分鐘',
    hours: '{count} 小時',
    days: '共 {count} 天'
  },

  /** Y-axis title. Spanish and Turkish need their own punctuation, so this is
   *  a per-locale template rather than a shared bracket format. */
  axisTitle: {
    composite: '{metric}（{aggregation}）'
  },

  deviceDetailUi: {
    breadcrumbDevices: '裝置管理',
    notFoundTitle: '裝置不存在',
    backToList: '返回裝置列表',
    /** 彈窗標題行（業主 20260921）：裝置名 + ID + MAC 同一行。 */
    headerId: 'ID {id}',
    headerMac: 'MAC {mac}',
    /** 未儲存修改確認彈窗（頁籤切換/彈窗關閉時攔截）。 */
    unsavedBody: '當前頁簽有未儲存的修改，繼續將丟失這些修改。',
    unsavedDiscard: '放棄修改',
    unsavedKeepEditing: '繼續編輯',
    refreshing: '重新整理中…',
    openWebUi: '開啟裝置頁面',
    monitor: '監測',
    tabsLabel: '裝置配置',
    tabOverview: '概覽',
    tabChannels: '通道與取樣率',
    tabAlarms: '告警引數',
    tabNetwork: '網路配置',
    tabTime: '時間 / NTP',
    tabSerial: 'RS485 / Modbus',
    tabPush: 'Push 上報',
    tabMaintenance: '裝置維護',
    tabAuscultation: '聽診盒子',
    /** 空氣聲吶（SN-16）唯一的一頁：球機聯動配置。 */
    tabPtz: 'PTZ 聯動',
    tabCameraDetect: '檢測模式',
    tabCameraAlarms: '警報策略',
    tabCameraMaintenance: '維護與升級',
    overviewTitle: '裝置概覽',
    ip: 'IP 位址',
    httpPort: 'HTTP 埠',
    mac: 'MAC 位址',
    firmware: '韌體版本',
    fpga: 'FPGA 版本號',
    webVersion: 'Web 版本號',
    channelCount: '通道數量',
    /*
     * 通道數**沒能從裝置問到**時的那句話（不是「0 路」）。
     *
     * `GET /get_devinfo` 實測根本沒有通道數字段，而協議對映在裝置沒給這個欄位時會把
     * 協議常量 8 填進去（`src/main/services/device/protocol/mappers.ts`），
     * 所以介面上那個 8 無法歸因於裝置；通道數的權威來源是 `GET /get_passageway`
     * 的行數（`docs/PROTOCOL-FINDINGS.md` §3.1）。查不到就不顯示數字。
     */
    channelCountUnreported: '裝置未上報通道數',
    sampleRate: '取樣率',
    lastSeen: '最近線上',
    nameSection: '裝置名稱',
    nameLabel: '裝置名稱',
    saveName: '儲存名稱',
    nameRequired: '裝置名稱不能為空',
    nameSaveFailed: '裝置名稱儲存失敗',
    nameSaved: '裝置名稱已儲存到裝置',
    refreshedAt: '已重新整理 {time}',
    webSection: '裝置頁面'
  },

  configCommon: {
    reload: '重新讀取',
    revert: '撤銷修改',
    unsaved: '有未儲存的修改',
    saving: '儲存中…',
    saved: '已儲存',
    noChanges: '沒有需要儲存的修改',
    enabled: '已啟用',
    disabled: '未啟用',
    enabledOfTotal: '已啟用 {enabled} / {total} 路',
    deviceWordingPrivate: '裝置未公開該欄位取值含義，此處按原值顯示',
    baudRate: '鮑率',
    dataBits: '資料位',
    stopBits: '停止位元',
    unitPerDevice: '單位以裝置為準，裝置未公開說明',
    deviceTime: '裝置時間',
    hostTime: '本機時間',
    drift: '偏移',
    readAt: '讀取時刻：{time}',
    channel: '聲道',
    status: '狀態',
    target: '目標地址',
    publicWarningTitle: '裝置正在向公網地址上傳資料。'
  },

  configTime: {
    title: '時間 / NTP',
    syncNow: '立即對時',
    saveButton: '儲存時間設定',
    saveFailed: '儲存時間設定失敗',
    syncFailed: '對時失敗',
    savedNotice: '時間設定已儲存，裝置時間：{time}',
    syncedNotice: '已按本機時間對時，裝置時間：{time}',
    ntpToggle: 'NTP 對時',
    ntpServer: 'NTP 伺服器',
    ntpServerPlaceholder: '範例 cn.pool.ntp.org',
    ntpInterval: '同步間隔',
    errInterval: 'NTP 同步間隔需為不小於 1 的整數',
    errServerRequired: '啟用 NTP 時必須填寫 NTP 伺服器地址',
    sameAsHost: '與本機基本一致',
    deviceAhead: '裝置比本機快 {seconds} 秒',
    deviceBehind: '裝置比本機慢 {seconds} 秒'
  },

  configModbus: {
    title: 'Modbus',
    type: '型別',
    typeOption: '型別 {n}',
    port: '埠',
    slaveId: '從站地址',
    saveButton: '儲存 Modbus 配置',
    saveFailed: '儲存 Modbus 配置失敗',
    savedNotice: 'Modbus 配置已儲存',
    errPort: 'Modbus 埠必須在 1-65535 之間',
    errSlaveId: 'Modbus 從站地址必須在 1-247 之間'
  },

  configRs485: {
    title: 'RS485',
    mode: '運作模式',
    modeOption: '模式：{n}',
    portLeft: '左埠',
    portRight: '右埠',
    unused: '（未啟用）',
    portUnknown: '未知（裝置不返回該欄位）',
    portNotInList: '當前值不在裝置返回的串列埠列表中，已原樣保留',
    deviceAddress: '裝置地址',
    saveButton: '儲存 RS485 配置',
    saveFailed: '儲存 RS485 配置失敗',
    savedNotice: 'RS485 配置已儲存'
  },
  configPush: {
    title: 'Push 上報',
    publicWarning: '上報目標中包含非內網地址，裝置採集到的特徵、圖形與熱力資料會離開本地網路。若不希望資料外發，請在裝置本地介面關閉對應通道或改為內網地址。',
    unavailableTitle: '尚未讀取到上報配置',
    kindFeatures: '特徵資料',
    kindAlarm: '告警資訊',
    kindImage: '圖形資料',
    kindHeat: '熱力資料',
    heatInterval: '熱力資料上報間隔',
    targetScope: '目標地址範圍',
    scopePublic: '包含公網地址',
    scopePrivate: '僅內網地址'
  },

  configNetwork: {
    title: '網路配置',
    saveButton: '儲存網路配置',
    processing: '處理中…',
    saveFailed: '網路配置修改失敗',
    mode: '位址模式',
    modeManual: '手動設定',
    modeDhcp: '自動獲取（DHCP）',
    ip: 'IP 位址',
    netmask: '子網掩碼',
    gateway: '預設閘道器',
    dns: 'DNS 伺服器',
    legend: '網路配置',
    disconnectTitle: '修改地址會立即斷開當前連線。',
    disconnectBodyBefore: '儲存後程式會按新地址重新連線裝置，並在裝置無響應時',
    disconnectBodyStrong: '自動回退',
    disconnectBodyAfter: '到原設定。',
    disconnectWarning: '整個過程最長約 45 秒，期間請勿關閉程式或斷開裝置電源。若新舊地址都無法連線，只能透過裝置本地介面或串列埠恢復。',
    progressTitle: '修改進度',
    progressRunning: '進行中',
    progressDone: '已結束',
    confirmTitle: '確認修改網路配置',
    confirmFrom: '裝置地址將從',
    confirmTo: '改為',
    confirmPortSuffix: '（HTTP 埠 {port}）。',
    confirmBody: '儲存後當前連線會立即中斷。程式將自動用新地址重連裝置並核對配置；若新地址無響應，會自動回退到原配置並把結果告訴你。',
    confirmWarning: '若新舊地址都無法連線，裝置將只能透過本地介面或串列埠恢復。',
    confirmAction: '確認修改',
    errIp: 'IP 地址格式不正確',
    errNetmask: '子網掩碼格式不正確',
    errGateway: '閘道器格式不正確',
    errDns: 'DNS 格式不正確',
    errPort: '{label}必須是 1-65535 之間的整數',
    portHttp: 'HTTP 埠',
    portRtsp: 'RTSP 埠',
    portTcp: 'TCP 埠',
    stageApplying: '正在寫入新配置',
    stageApplied: '新配置已寫入裝置',
    stageReconnecting: '正在按新地址重連',
    stageConnected: '新地址已響應',
    stageVerifying: '正在核對裝置回讀值',
    stageVerified: '設定已套用',
    stageRollingBack: '新地址無響應，正在回退原配置',
    stageRolledBack: '已回復到原設定',
    stageUnreachable: '新舊地址均無響應'
  },
  configChannels: {
    title: '聲道設定',
    countHint: '共 {count} 個通道',
    unavailableTitle: '尚未讀取到通道配置',
    columnChannel: '聲道',
    columnName: '名稱',
    columnSensorType: '感測器型別',
    columnEnabled: '啟用',
    columnAlarmProfile: '警報設定',
    columnActions: '動作',
    ariaName: '{channel} 名稱',
    ariaSensorType: '{channel} 感測器型別',
    ariaEnabled: '{channel} 啟用',
    ariaAlarmProfile: '{channel} 警報設定',
    enableOn: '啟用',
    enableOff: '關閉',
    unbound: '未繫結',
    errNameRequired: '通道名稱不能為空',
    saveFailed: '儲存失敗',
    sampleRateTitle: '取樣率',
    sampleRateCurrent: '當前：{rate}',
    sampleRateWarningBefore: '修改取樣率會使裝置',
    sampleRateWarningStrong: '重啟採集',
    sampleRateWarningAfter: '，正在進行的實時監測會被中斷，需要重新開始監測。',
    sampleRateLabel: '取樣率',
    applyRate: '應用取樣率',
    errRateSame: '請選擇與當前不同的取樣率',
    errRateFailed: '應用取樣率失敗',
    rateApplied: '取樣率已應用為 {rate}，實時監測需要重新開始',
    confirmTitle: '確認修改取樣率',
    confirmFrom: '取樣率將從',
    confirmTo: '改為',
    confirmBody: '應用後裝置會重啟採集流程，正在進行的實時監測會立即中斷，已開始的監測需要在裝置恢復後重新啟動。',
    applying: '應用中…',
    confirmApply: '確認應用'
  },

  configMaintenance: {
    title: '裝置維護',
    destructiveBadge: '破壞性操作',
    refreshStatus: '重新整理狀態',
    running: '執行中…',
    rebootTitle: '重啟裝置',
    rebootConfirmTitle: '確認重啟裝置',
    rebootConfirmBody: '裝置將立即重啟，期間無法採集資料：實時監測會中斷（約 30 秒），正在進行的錄音會停止，告警在重啟完成前不會產生。裝置上的配置不會被修改。',
    rebootConfirm: '確認重啟',
    upgradeTitle: '系統升級',
    upgradeConfirmTitle: '確認系統升級',
    upgradeConfirmBody: '裝置將進入系統升級流程並重啟，升級期間裝置不可用，實時監測與告警都會中斷。升級過程中請不要斷開裝置電源。',
    upgradeConfirm: '確認升級',
    resetTitle: '恢復出廠設定',
    resetConfirmTitle: '恢復出廠設定',
    resetConfirmBody: '裝置上的全部配置——網路、通道、告警引數、RS485/Modbus、Push 上報與裝置名稱——都會恢復為出廠值，裝置隨後重啟並斷開連線。本程式已儲存到電腦上的錄音與告警記錄不受影響。該操作無法撤銷。',
    resetConfirm: '確認恢復出廠設定',
    resetTypePrompt: '請輸入 {code} 以確認（區分大小寫）',
    uploadTitle: '韌體上傳',
    uploadButton: '上傳韌體',
    uploading: '上傳中…',
    uploadConfirmTitle: '確認上傳韌體',
    uploadConfirmBody: '上傳後裝置將寫入新韌體並重啟，升級期間裝置不可用。上傳可能需要數分鐘，期間請不要關閉本程式、關閉裝置或斷開網路。',
    uploadConfirm: '確認上傳',
    selectedFile: '已選檔案',
    fullPath: '完整路徑',
    fileSize: '檔案大小',
    sizeUnknown: '上傳前無法讀取（渲染程序無檔案訪問許可權），上傳完成後顯示實際位元組數',
    firmwareFile: '韌體檔案',
    uploadProgress: '韌體上傳中，無法獲取進度',
    errNoFile: '請先選擇韌體檔案',
    noticeRebooting: '裝置正在重啟，約需 30 秒。重啟期間裝置會短暫顯示為離線。',
    noticeUpgrading: '已下發系統升級指令，裝置將進入升級流程並重啟。',
    noticeReset: '已下發恢復出廠設定指令。裝置將恢復出廠配置並重啟；建議重啟後重新讀取裝置配置。',
    noticeUploaded: '韌體上傳完成，裝置將開始升級並重啟。',
    noticeOnline: '裝置已恢復線上。',
    noticeStillOffline: '裝置仍不可達，請稍後再次重新整理。',
    chooseFirmware: '選擇韌體…',
    uploadWarning: '正在上傳韌體，請勿關閉程式、關閉裝置或斷開網路。上傳結束後裝置會自動開始升級。'
  },

  configAlarms: {
    title: '告警引數',
    addProfile: '新增設定',
    unavailableTitle: '尚未讀取到告警引數',
    columnName: '名稱',
    columnMode: '檢測模式',
    columnSensitivity: '檢測靈敏度',
    columnInterference: '干擾抑制等級',
    columnEnabledRules: '已啟用的判據',
    columnActions: '動作',
    allDisabled: '全部未啟用',
    editProfile: '編輯告警配置',
    createProfile: '新增警報設定',
    groupBasics: '基本資訊',
    groupSpl: '聲壓級',
    groupMainFrequency: '主頻',
    groupBandEnergy: '頻帶能量比',
    labelEnable: '致能',
    labelLower: '下限值',
    labelUpper: '上限值',
    labelThreshold: '閾值',
    saveProfile: '儲存配置',
    deleteConfirmTitle: '刪除告警配置',
    deleteConfirmBody: '確定刪除告警配置「{name}」嗎？',
    deleting: '刪除中…',
    notifyCreated: '已新增設定「{name}」',
    notifySaved: '已儲存配置「{name}」',
    notifyDeleted: '已刪除配置「{name}」',
    errNameRequired: '名稱不能為空',
    errNumeric: '「{field}」必須填寫數字',
    errSensitivityRange: '檢測靈敏度需在 0-100 之間',
    errMainFrequencyRange: '主頻下限必須小於上限',
    errBandEnergyRange: '頻帶能量比下限必須小於上限',
    errFormInvalid: '填寫內容有誤',
    fieldSensitivity: '檢測靈敏度',
    fieldInterferenceSuppression: '干擾抑制等級',
    fieldSplOverloadThreshold: '聲壓級過載閾值',
    fieldSplSurgeThreshold: '聲壓級突升閾值',
    fieldSplDropThreshold: '聲壓級突降閾值',
    fieldSplStabilityThreshold: '聲壓級穩定性閾值',
    fieldMainFrequencyLower: '主頻下限',
    fieldMainFrequencyUpper: '主頻上限',
    fieldBandEnergyRatioLower: '頻帶能量比下限',
    fieldBandEnergyRatioUpper: '頻帶能量比上限',
    fieldBandEnergyRatioThreshold: '頻帶能量比閾值',
    ruleOverload: '過載',
    ruleSurge: '驟升',
    ruleDrop: '驟降',
    ruleStability: '穩定性',
    ruleMainFrequency: '主頻',
    ruleBandEnergy: '頻帶能量比',
    deleteWarning: '刪除後無法恢復，使用該配置的通道需要重新繫結其他配置。若仍有通道繫結該配置，裝置會拒絕刪除，請先到「通道配置」中解除繫結。'
  },

  widgetsUi: {
    audioLevel: '音訊電平',
    sampleRateAndFrame: '取樣率 {rate} · {frame}',
    millisecondsPerFrame: '{value} ms/幀',
    recording: '錄音中 {elapsed}',
    lastRecording: '上次錄音 {elapsed}',
    peak: '最高值',
    rms: '均方根值',
    audioUnavailable: '實時音訊流未執行，表頭無資料。',
    spectrogramAlt: '時頻圖 {time}',
    backToLatest: '返回最新資料',
    spectrogramWaiting: '等待時頻圖資料…',
    lastRefresh: '上次重新整理 {time}',
    offlineUnknownSummary: '離線 {offline} 臺，未知 {unknown} 臺',
    indicatorDevices: '裝置總數',
    indicatorOnline: '線上裝置',
    truncated: '{text}\n… (已截斷)',
    arrayOf: '陣列（{count} 項）',
    emptyObject: '空物件',
    modalClose: '關閉'
  },
  domainExtra: {
    connectionType: {
      LAN: '區域網',
      REMOTE: '遠端'
    }
  },

  monitorErrors: {
    selectDevice: '請先選擇一臺裝置',
    selectStream: '請至少選擇一種資料流',
    startBeforeRecording: '請先啟動實時監測，再開始錄音'
  },

  rangeExtra: {
    label1h: '最近 1 小時',
    label24h: '24 小時',
    label7d: '近 7 天',
    label30d: '近 30 天',
    labelCustom: '自定義',
    errRangeOrder: '起始時間不能晚於結束時間'
  },

  addDeviceUi: {
    title: '新增裝置',
    errIpRequired: '請輸入裝置 IP 地址',
    errIpRange: 'IP 地址格式不正確（每段需在 0-255 之間）',
    errHostInvalid: 'IP 地址或主機名格式不正確',
    errPort: 'HTTP 埠需為 1-65535 之間的整數',
    errUsername: '請輸入登入使用者名稱',
    errPassword: '請輸入登入密碼',
    errAddFailed: '新增裝置失敗',
    defaultPort: '預設 80',
    /**
     * 「地址資訊」收起時那一行小結（業主 2026-09-19 第 13 批第 2 條：預設收起）。
     * 三檔分開說，因為"沒填"與"只填了一半"對操作員的下一步完全不同。
     */
    installationEmpty: '未填寫',
    installationPoint: '點位 {latitude}, {longitude}',
    installationPartial: '還沒填完',
    /**
     * 協議接入方式（業主 2026-09-19 第 13 批第 3、4 條）。
     *
     * 「資料流介面 / 影片流介面」這兩個名字是業主給的說法（他點名參考 ThingsBoard 的那套）。
     * 監聽狀態那兩句**必須帶埠**：操作員要把它與裝置上填的埠對一眼。
     */
    /** 接入方式（業主 20260921 批第 11 條）：先選 IP / HTTP / MQTT，再填該模式各自的欄位。 */
    accessMethod: '連接方式',
    accessMethodIp: 'IP 位址',
    accessMethodHttp: 'HTTP',
    accessMethodMqtt: 'MQTT',
    /** IP 模式的 GIS 摺疊頭。 */
    moreGis: '更多（GIS）資訊',
    deviceNameRequired: '請填寫裝置名稱',
    ingestModeHint: '此裝置透過 HTTP/MQTT 主動向本機推送資料：填寫名稱與 GIS 資訊，並配置資料流介面鍵。',
    pushDeviceAdded: '推送裝置已新增',
    kindPushDevice: '推送裝置',
    protocolHint: '這臺裝置往本機推資料時走哪條路。不接入表示它由本軟體主動去連（預設）。',
    protocolListening: '本機正在 {port} 埠監聽。',
    protocolNotListening: '本機此刻沒有在監聽（新增成功之後才會按這臺裝置的宣告開啟埠）。',
    protocolNotListeningReason: '本機沒有在監聽：{reason}',
    protocolListenUnknown: '讀不到本機的監聽狀態。',
    metricKeysTitle: '資料流介面（遙測值）',
    metricKeysHint: '下面四個量各由一個遙測鍵送來，裝置按這些鍵發，本機才畫得出曲線。預設是規範名，裝置用別的寫法時才需要改。',
    videoKeyTitle: '影片流介面',
    videoKeyHint: '哪一個鍵裝的是影片地址（RTSP / HTTP），留空表示這臺裝置不推影片。',
    protocolPlanInvalid: '接入方案裡有不合法的鍵名或重複項，請檢查上面的遙測鍵。',
    /*
     * 本機接入（業主 2026-09-19 第 13 批第 1 條：資料接入從系統設定搬進「新增裝置」）。
     * 這一塊是**本機**的監聽設定與收數讀數；設定頁那個「資料接入」頁籤隨這次改造刪掉了。
     */
    localIngestTitle: '本機接入（監聽設定與收數）',
    localIngestHint:
      '本機在哪個地址、哪個埠上等裝置推資料，以及接到了什麼。總開關與兩個通道開關由裝置宣告派生，這裡只顯示、不改。',
    localIngestDerived: '總開關 {master}；HTTP 通道 {http}；MQTT 通道 {mqtt}（由裝置宣告派生）',
    localIngestSave: '儲存監聽設定',
    noResponseTitle: '裝置無響應',
    noResponseBody: '目標地址可以訪問，但未返回本系統可識別的裝置資訊。請確認 IP、埠與裝置型號。',
    probeSuccess: '連線成功',
    probeLatency: '來回 {ms} ms',
    probeAuth: '認證方式 {strategy}',
    alreadyRegisteredTitle: '該裝置已在系統中註冊',
    firmwareVersion: '韌體版本',
    fpgaWebVersion: 'FPGA / Web 版本號',
    testing: '測試中…',
    adding: '新增中…',
    kindLabel: '裝置型別',
    /*
     * 新增裝置**不再讓人選機型**（業主 2026-09-17 第 2 條）：協議由主程序自動匹配。
     * 這兩句必須說出來：不說，操作員會去找那張已經被刪掉的機型卡；
     * 說了，他會知道"識別結果會自己出現"。
     */
    autoDetectLead: '不用選機型：系統會按地址自動識別協議（聲紋裝置 / 空氣聲吶 / 聲學相機），識別結果在「測試連線」之後顯示。',
    detectedKind: '已識別為：{kind}',
    alreadyRegisteredBody: '繼續新增不會建立新裝置，只會更新它的連線地址（IP / 埠）。已註冊的本地裝置 ID：',
    /*
     * 探測回來的通道數**不是裝置報的**時的那句話。
     *
     * 盒子在 `GET /get_devinfo` 裡沒有通道數字段，而協議對映會把協議常量 8 填進去
     * （見 `deviceDetailUi.channelCountUnreported` 的說明），所以探測面板裡那個 8
     * 不能當成「裝置上報了 8 路」。權威通道數只在登記之後由 `GET /get_passageway`
     * 讀回，所以這裡如實寫「裝置未上報」而不是顯示一個我們沒收到的數字。
     */
    channelCountUnreported: '裝置未上報'
  },

  /**
   * **地址資訊**（業主 2026-09-17 第 1 條；2026-09-18 第 7 / 10 條改名並刪掉基準聲壓級）
   * —— 聲源定位裝置（Air Sonar / SN-16）的點位（GIS 經緯度）/ 朝向（方位角）。
   *
   * 口徑寫在文案裡，因為這兩項**手冊裡沒有**（是我們的資料模型，見 `DeviceInstallation`
   * 的註釋）：經緯度是 WGS84 十進位制度，方位角 0 = 正北、順時針。含糊的標籤會讓操作員填錯
   * 口徑，而錯的口徑比沒填更糟。
   *
   * 刪掉的兩條（`soundLevel` / `soundLevelHint` / `errSoundLevel`）按業主 2026-09-18 第 10 條
   * 「基準聲壓級內容刪除」：三個介面（新增裝置 / 編輯裝置 / 地址資訊卡片）都不再顯示它。
   * **庫裡的列與 API 仍在**（`devices.sound_level_db`，v11 遷移已經發布過，刪列要再做一次
   * 遷移），舊值原樣保留但介面不再讀寫 —— 取捨見 `docs/Ivms4200-UX-REFERENCE.md` §15.49。
   */
  /**
   * IoT 資料接入（業主 2026-09-19 第 1 條：HTTP 推流 + MQTT）。
   *
   * **手冊未說明**這一節（手冊裡沒有"IoT 接入"這一章），所以下面是我們的口徑，
   * 形狀照抄 ThingsBoard 的裝置側接入：秘鑰放在 URL 路徑裡 / 當 MQTT 使用者名稱。
   * 現場那臺 FA8 聲紋裝置自己的 Push 配置就是這個形狀（`GET /get_date_push` 實測），
   * 所以"我們自己的裝置"與"第三方裝置"共用同一套接收端。
   */
  iotUi: {
    /*
     * 2026-09-19 第 13 批第 1 條：「資料接入」從系統設定搬進「裝置管理 → 新增裝置」。
     * 隨那一頁刪掉的詞條（四本一起刪）：`enableLabel` / `enableHint` / `enableDerived` /
     * `httpEnable` / `mqttEnable` / `httpPathLabel` / `statusGroup` / `statusOff` /
     * `devicesWithSecret` / `localAddressesLabel`（**留著**，見下）/ `manualNote` /
     * `loadFailed` / `settingsUi.tabIot`。
     * 留下來的都是"這一塊現在真的會顯示"的：監聽地址、埠、監聽狀態、收數統計、
     * 本機地址、秘鑰那幾句（在 `DevicePushEndpoint` 裡）。
     */
    bindLabel: '監聽地址',
    bindHint: '0.0.0.0 表示所有網絡卡（裝置才連得上）；127.0.0.1 表示只允許本機。',
    errBind: '監聽地址只能是 0.0.0.0、127.0.0.1 或一個 IPv4 地址',
    errPort: '埠需為 1-65535 之間的整數',
    httpGroup: 'HTTP 串流',
    httpPortLabel: 'HTTP 埠',
    mqttGroup: 'MQTT',
    mqttPortLabel: 'MQTT 埠',
    mqttTopicLabel: '釋出主題',
    secretLabel: '裝置秘鑰',
    localAddressesLabel: '本機地址（給裝置用）',
    noLocalAddresses: '本機沒有可用於裝置的地址（只有迴環地址）。',
    listening: '監聽中 {address}:{port}',
    notListening: '未監聽',
    /* 派生的三個開關的取值（只讀那一行）。 */
    derivedOn: '開',
    derivedOff: '關',
    /* 監聽設定（繫結地址 / 埠）儲存的三個結果。 */
    saveDone: '監聽設定已儲存，並已讀回核對',
    saveFailed: '儲存監聽設定失敗',
    saveMismatch: '儲存之後讀回來的值與剛寫的不一樣（介面上顯示的是讀回來的那一份）',
    statsRequests: 'HTTP 請求',
    statsMessages: 'MQTT 報文',
    statsRejectedAuth: '憑據被拒',
    statsRejectedPayload: '載荷被拒',
    statsTrendRows: '寫入趨勢行',
    statsAlarmRows: '寫入告警行',
    statsLastAt: '最近一次收到',
    statsNever: '尚未收到任何資料',
    lastUnrecognised: '最近一次認不出來的鍵：{keys}',
    portConflict: 'HTTP 與 MQTT 用了同一個埠（{port}），後啟動的那個會失敗。',
    devicesTitle: '推流地址與秘鑰',
    devicesHint: '把下面的地址填進裝置的推流配置。秘鑰只允許往本機寫遙測，不能讀任何資料。',
    copy: '複製',
    copied: '已複製',
    rotate: '輪換秘鑰',
    rotateTitle: '輪換推流秘鑰？',
    rotateBody: '舊秘鑰會立刻失效；裝置必須用新秘鑰重新配置後才會繼續推資料。',
    rotateConfirm: '輪換',
    rotateNotice: '秘鑰已輪換，請把新秘鑰填到裝置上。',
    serviceOff: '本機此刻沒有在監聽（第 13 批之後由**裝置宣告**決定）：把地址填進裝置、新增成功之後，本機會按這臺裝置的接入方式自動開啟埠。',
    // `httpOff` / `mqttOff` 兩句在 2026-09-19 第 13 批裡刪掉了：那兩個通道開關現在是
    // **派生**的（有沒有裝置宣告 http / mqtt），而"按開關把地址藏起來"會讓操作員在
    // 裝置宣告之前拿不到該填進裝置的地址。監聽狀態由上面那句 `serviceOff` 統一回答。
    mqttUser: 'MQTT 使用者名稱（就是秘鑰）',
    secretHint: '秘鑰按裝置一條，可隨時輪換；輪換後舊秘鑰立刻失效。',
  },

  installUi: {
    section: '地址資訊（可選）',
    sectionHint: '聲源定位裝置（SN-16 空氣聲吶）填這幾項；其他機型留空。經緯度用 WGS84 十進位制度。',
    latitude: '緯度（°）',
    longitude: '經度（°）',
    azimuth: '方位角 (°)',
    azimuthHint: '0 = 正北，順時針',
    gisLabel: '地圖',
    viewOnMap: '在地圖資訊裡檢視',
    copyPoint: '複製座標',
    pointCopied: '已複製座標',
    mapNoPoint: '未錄入點位，無法在地圖上定位該裝置',
    mapHint: '請到裝置管理 → 編輯 → 地址資訊中錄入經緯度與方位角',
    openMap: '開啟地圖資訊',
    mapRange: '範圍 {range} m',
    mapDirection: '方位角 {degrees}°',
    mapNoAzimuth: '未錄入方位角',
    errLatitude: '緯度需在 -90 到 90 之間',
    errLongitude: '經度需在 -180 到 180 之間',
    errAzimuth: '方位角需在 0 到 360 之間（360 請寫 0）',
    errFloorX: '平面圖橫座標需在 0 到 1 之間',
    errFloorY: '平面圖縱座標需在 0 到 1 之間',
    /*
     * 基準聲壓級**介面已經不顯示**（業主 2026-09-18 第 10 條），但這條錯誤文案留著：
     * `parseInstallation()` 仍然解析並把 `soundLevelDb` 寫進庫（v11 的列還在，API 也還在，
     * 程式化呼叫與探針仍在用它），所以越界時仍然要給出一句話 —— 刪掉它就等於把一個
     * 可達的失敗路徑變成裸 key。理由與取捨見 `docs/Ivms4200-UX-REFERENCE.md` §15.49。
     */
    errSoundLevel: '基準聲壓級需在 -50 到 200 dB 之間',
    /** 裝置表/詳情頁裡那一格的標題。 */
    point: '點位',
    noPoint: '未錄入',
    /** 某一項沒有錄：與"錄了 0"必須分開寫（緯度 0 是一個真實座標）。 */
    unset: '未錄入',
    /** 經緯度只錄了一半：半座標的點位算不出方向，介面要能說出來。 */
    halfPoint: '只錄了一半（經緯度要成對）'
  },

  /**
   * SN-16 空氣聲吶的**球機聯動（PTZ）**配置（業主 2026-09-17 第 8 批）。
   *
   * 三處措辭是刻意的：
   *   - 叫「球機」而不是"攝像機/雲臺"：那是業主現場的叫法；
   *   - 口令那一格只說「已設定 / 未設定」，**永遠不回顯內容**；
   *   - 對時那句明說這是裝置接受了請求 —— 手冊**沒有寫這個端點的請求體**，我們不假裝知道
   *     它做了什麼（主程序發的是一個空物件，這件事寫在這一句的旁邊）。
   */
  ptzUi: {
    title: '球機聯動（PTZ）',
    hint: '這一代聲吶與球機聯動做聲源定位。下面這些都是裝置上的引數，點「儲存」才會寫進裝置。',
    fieldEnabled: '啟用球機聯動',
    enabledHint: '關掉之後聲吶不再驅動球機',
    fieldCameraIp: '球機 IP / 主機名',
    fieldCameraPort: '球機埠',
    fieldCameraUser: '球機賬號',
    fieldCameraPassword: '球機口令',
    passwordSet: '已設定',
    passwordUnset: '未設定',
    passwordHint: '不回顯內容；留空表示不改',
    passwordState: '口令狀態',
    fieldDirection: '球機方向與聲吶一致',
    directionHint: '關掉表示球機與聲吶朝向相反',
    fieldSaveSnapshot: '告警時儲存抓圖',
    saveSnapshotHint: '關掉之後告警沒有抓圖可看',
    fieldChannel: '實時監聽通道',
    channelHint: '1 – {max}（裝置報的通道數）',
    channelHintUnknown: '裝置未上報通道數，這裡不設上限',
    cameraInitialised: '球機已初始化',
    unknown: '未讀取',
    yes: '確定',
    no: '取消',
    save: '儲存到裝置',
    syncing: '對時中…',
    syncTime: '與球機對時',
    unsaved: '有未儲存的修改',
    nothingChanged: '沒有需要儲存的修改',
    saved: '已寫入裝置，並讀回核對過',
    savedPartly: '已寫入裝置，但有 {count} 項讀回不一致（見下）',
    readBackTitle: '讀回核對',
    allApplied: '已全部套用',
    someFailed: '有未生效的項',
    applied: '已套用',
    expectedActual: '未生效：應為 {expected}，裝置現為 {actual}',
    passwordNotCompared: '口令只核對"已設定"：內容不回傳，無法比對。',
    timeSyncAccepted: '裝置接受了這次對時請求（手冊未說明請求體，發的是一個空物件）。',
    timeSyncRejected: '裝置沒有接受這次對時請求。',
    errCameraIp: '球機地址需為 IPv4 或主機名',
    errCameraPort: '球機埠需在 1 到 65535 之間',
    errCameraUser: '球機賬號不能為空',
    errRealtimeChannel: '實時通道需在裝置通道數範圍內'
  },

  /**
   * 離線**點點陣圖**（業主 2026-09-17 第 8 批第 2 條）。
   *
   * 措辭上刻意不含"地圖"兩字以外的東西：底圖是我們按經緯度畫的平面圖（渲染層不聯網），
   * 所以不能寫"地圖載入失敗/正在載入地圖"這類會被讀成"網路問題"的話。
   * 抓圖那三句是**三種不同的事實**，不能合併（見 `E2AlarmSnapshotView` 的註釋）。
   */
  /**
   * GIS 實時監測工作臺 / Live Monitor（業主 2026-09-20 規格 V1.0）。
   *
   * 與其它目錄同一條規則：**任何一條訊息都不得包含 `@`**（i18n 測試會逐條編譯）。
   * 模板與狀態名不在這裡重複裝置型號：型號隻影響 `resolveRealtimeProfile()`。
   */
  realtimeUi: {
    title: '實時監測',
    primary: '主資料',
    detail: '分析 / 詳情',
    realtime: '實時資料',
    directionRadar: '方向雷達',
    signalTrend: '訊號趨勢',
    channels: '聲道',
    channelsHint: '點一個通道，中間與右欄跟著切換；沒有讀到資料的通道顯示 —。',
    watchHint: '勾選多路可同時看趨勢與四讀數（每路一條線，顏色區分）；音訊/頻譜/聲紋圖仍只看當前通道。',
    watchChannelsLabel: '同時顯示的通道',
    watchChannelOn: '同時顯示這一路',
    watchChannelOff: '不再同時顯示這一路',
    watchChannelCurrent: '當前通道始終顯示',
    multiChannelTitle: '多通道讀數',
    multiChannelNote: '每路按自己到達的時刻作圖，通道之間不保證同步。',
    multiChannelNotReceived: '未收到這一路',
    multiChannelNotReceivedWhy:
      '設備 /features_stream 的訂閱沒有通道參數，只推設備當前通道；這一路要等韌體按連線分通道才會同時更新。',
    multiChannelWrongChannel: '這條連線推的是 {channel}',
    multiChannelStaleWhy: '超過 5 秒沒有新訊框：這一路可能已經停了，表裡留著的是它最後一次讀數。',
    trendColumn: '趨勢',
    statusColumn: '狀態',
    currentChannel: '當前',
    featuresTitle: '{channel} 特徵',
    channelIssue: '通道異常',
    aboveLimit: '超過上限',
    emptyTrend: '還沒有收到這一通道的資料。',
    spectrumWaiting: '等待頻譜資料…',
    spectrumUnknownAxis: '裝置未提供頻率軸：橫軸按譜線序號顯示。',
    voiceprintPending: '該通道暫時沒有聲紋變化圖；7 項特徵讀數在右欄。',
    waveformPending: '該裝置暫未提供實時波形。',
    pdProbability: '局放機率',
    pdProbabilityEmpty: '裝置未提供局放型別機率。',
    leakAnalysis: '洩漏分析',
    leakAnalysisEmpty: '裝置介面暫未提供實時洩漏分析欄位。',
    pdClass: {
      corona: '電暈',
      creepage: '沿面放電',
      suspended: '懸浮',
      noise: '噪聲'
    },
    tempUnitHint: '單位以裝置紅外配置為準。',
    noTarget: '無目標',
    signalTrendPending: '等待接入實時資料點表；當前顯示可插拔的 Signal Trend 佔位。',
    connectionPending: '等待完整通訊協議後繫結連線與通道欄位。',
    selectDeviceTitle: '請選擇裝置檢視實時資料',
    selectDeviceHint: '從地圖、裝置列表或告警列表中選擇一臺裝置。',
    unsupportedTitle: '此型號暫無實時監測模板',
    unsupportedHint: 'V1 為聲學相機、FA8 聲紋盒與空氣聲吶提供實時工作臺；該裝置仍可在實時監測頁檢視。',
    openMonitor: '開啟實時監測',
    resize: '拖動調整實時區高度',
    location: '安裝位置',
    updatedAt: '更新於 {time}',
    dataDelay: '資料延遲',
    collapse: '摺疊',
    expand: '展開',
    offline: '裝置離線',
    lastCommunication: '最後通訊：{time}',
    lastKnownValue: '最後有效值：{value}',
    noDataTitle: '暫無實時資料',
    noDataHint: '裝置線上後會自動開始接收；當前不會用 0 代替缺失值。',
    returnToLive: '返回實時',
    status: {
      live: '實時',
      warning: '警示',
      alarm: '警報',
      offline: '離線',
      dataDelay: '資料延遲'
    },
    quality: {
      good: '良好',
      stale: '延遲',
      invalid: '無效',
      nodata: '無資料'
    },
    mode: {
      label: '顯示模式',
      pd: '區域性放電',
      leak: '洩漏'
    },
    tabs: {
      label: '主視覺化選擇',
      trend: '趨勢',
      spectrum: '頻譜',
      voiceprint: '聲紋',
      waveform: '波形圖',
      prpd: 'PRPD'
    },
    actions: {
      liveView: '實時畫面',
      listen: '監聽',
      ptz: '雲臺',
      history: '歷史',
      analysis: '進行分析',
      configuration: '設定'
    },
    template: {
      acousticCameraPD: '聲學相機 · 區域性放電',
      acousticCameraLeak: '聲學相機 · 洩漏',
      voiceprint: '聲紋引擎',
      airSonar: '空氣聲吶',
      gasLeakMonitor: '氣井洩漏監測'
    },
    metric: {
      maxSpl: '最大聲壓級',
      soundEnergy: '聲音能量',
      pdType: '放電型別',
      confidence: '信賴度',
      maxTemp: '最高溫度',
      leakRate: '洩漏速率',
      loss: '洩漏損失',
      frequencyBand: '頻帶',
      detectionDistance: '檢測距離',
      centerTemp: '中心溫度',
      minTemp: '最低溫度',
      maxChannel: '最大聲道',
      event: '事件名稱',
      ptz: '雲臺',
      azimuth: '方位角度',
      tdeRatio: '時域能量比',
      fdeRatio: '頻域能量比',
      horizontal: '水平角度',
      vertical: '垂直角度',
      leakStatus: '洩漏狀態',
      edgeAi: '邊緣推理',
      connection: '連線',
      lastAnalysis: '最近一次分析',
      channels: '聲道',
      target: '目標',
      peakSpl: '峰值聲壓級'
    },
    event: {
      none: '無',
      alarm: '警報'
    },
    ptz: {
      tracking: '跟蹤中'
    },
    leakStatus: {
      unknown: '不明'
    },
    channelStatus: {
      normal: '狀態正常',
      warning: '警示',
      alarm: '警報',
      nodata: '無資料'
    }
  },
  floorPlanUi: {
    importButton: '匯入平面圖',
    replaceButton: '更換平面圖',
    removeButton: '移除平面圖',
    modeFloor: '平面圖模式',
    modeGis: 'GIS 地圖',
    dragHint: '拖動裝置圖示到平面圖上的位置，放開即自動儲存',
    imported: '平面圖已匯入：{name}',
    importFailed: '平面圖匯入失敗',
    storageFailed: '平面圖無法儲存，請換一張較小的圖片',
    removed: '平面圖已移除',
    saved: '{name} 的位置已儲存',
    saveFailed: '裝置位置儲存失敗'
  },
  mapUi: {
    fitAll: '適合全部裝置',
    sonarDirection: '聲源方向 {degrees}° · 範圍 {range} m',
    sonarNoPoint: '未錄入點位，無法顯示聲源方向與範圍',
    autoFocus: '自動聚焦',
    canvasLabel: '裝置落點圖',
    /**
     * 地圖右上角那條半透明狀態列（業主 2026-09-19 第 11 批第 4 條：刪除「圖上 N 臺 / 共 M 臺」、
     * 圖例上的三個計數、以及「還沒有任何裝置錄入點位…」那句，改說「直接顯示 GIS 地圖的資訊，
     * 在地圖右上角的位置做一個半透明的狀態列，顯示當前地圖上的裝置數量資訊，告警資訊」）。
     *
     * 五個數各有各的措辭，不合成一句話：狀態列是**讀數**，不是句子（擠在一行裡時更讀得出來）。
     */
    statusLabel: '地圖狀態',
    statusMapped: '圖上 {count} 臺',
    statusTotal: '共 {count} 臺',
    statusOnline: '線上 {count}',
    statusOffline: '離線 {count}',
    statusAlarms: '未確認告警 {count}',
    selectHint: '點一個標記檢視這臺裝置：位置、告警與抓圖。',
    pickOne: '還沒有選中裝置。',
    point: '點位',
    /**
     * 落點的三種色調（業主 2026-09-18 第 10 批第 14 條：線上綠 / 告警紅 / 離線灰）。
     * 「線上」「離線」兩檔直接複用 `devices.status.*`（同一件事只有一處措辭），
     * 這裡只補"有告警"那一檔。顏色不單獨承載資訊，所以圖例上各帶一個數。
     */
    /** 裝置列表（第 17 條的第一張）。 */
    devicesTitle: '裝置列表',
    devicesCount: '{count} 臺',
    /**
     * 列表只有三列（業主 2026-09-19 第 11 批第 5 條：「裝置列表只需要顯示序號，裝置名稱，狀態這三項」），
     * 而且「點選裝置名稱可以進入到裝置詳情」—— 雙擊仍然進詳情（地圖上的標記一直是這麼做的）。
     */
    devicesHint: '點一行選中它（地圖上的標記同時高亮）；點裝置名稱進這一臺的詳情頁。',
    /**
     * 翻頁（同一條第 5 條：裝置列表預設最多 10 臺，超過就翻頁）。
     * `pageStatus` 只寫"第幾頁/共幾頁"：一頁幾臺是 `DEVICE_MAP_PAGE_SIZE` 那個常量的事。
     */
    pagePrev: '上一頁',
    pageNext: '下一頁',
    pageStatus: '第 {page} / {pages} 頁',
    colAlarms: '未確認告警',
    /** 告警列表（第二張）。 */
    alarmsTitle: '警報列表',
    historyAlarmsTitle: '歷史告警',
    alarmsFor: '選中裝置：{name}',
    /** 實時資料列表（第三張）。 */
    /**
     * 三列各取自哪裡（業主 2026-09-19 澄清「用平穩度表示」之後寫的）。
     *
     * 那句澄清解掉了原先的歧義：他說的「穩定度」就是本倉庫的 `smoothness`
     * （告警上報的一個真實測量值，`AlarmEvent.smoothness`）。所以這一列**有資料來源**了 ——
     * 原來那句"手冊未說明、所以這一列恆為 —"的說明隨之下架。
     */
    hoverStream: '當前影片流',
    hoverAlarm: '{count} 條未確認告警',
    hoverNoAlarm: '沒有未確認告警',
    hoverHint: '雙擊進這一臺的詳情頁。',
    /** 一個讀數「沒讀到」與「就是沒有」必須分得開（與裝置表那邊同一條口徑）。 */
    notRead: '—',
    none: '—',
    alarmCount: '最近 {count} 條',
    noAlarms: '本地還沒有這臺裝置的告警。上面點「同步告警」拉一次。',
    sync: '同步警報',
    syncing: '同步處理中…',
    syncOutcome: '檢查 {created} 條新增、{existing} 條已在庫；抓圖落庫 {linked} 條；裝置上檔案已不在 {missing} 條。',
    hasSnapshot: '有抓圖',
    noSnapshot: '無抓圖',
    snapshotTitle: '抓圖',
    snapshotCount: '{count} 張',
    snapshotLoading: '讀取抓圖中…',
    snapshotNotCaptured: '這條告警在裝置上沒有抓圖（同步時沒下載，或球機未開啟「告警時儲存抓圖」）。',
    snapshotFilesGone: '庫裡記著這條告警有抓圖，但檔案已經不在本地了（換過儲存目錄，或被清理）。',
    zoomIn: '拉近',
    zoomOut: '縮小',
    zoomReset: '回到時區中心',
    zoomLevel: '縮放 {zoom}',
    tilesError: '底圖有 {failed} / {total} 塊沒有載入出來（網路不可用或服務拒絕）；裝置點位與列表不受影響。',
    /** 底圖開關關著時畫布上的提示（業主 20260921 批第 9 條：地圖不能看起來"是空的"而不說為什麼）。 */
    tilesOffHint: 'GIS 底圖未啟用 · 到「設定 → GIS 服務」開啟線上底圖',
    sonarHint: '空氣聲吶的抓圖來自聯動的球機：每 1 秒一張，最多 3 張。'
  },

  /**
   * 本地異常聲紋樣本庫（schema v7，業主 2026-09-16）。
   *
   * 「標籤來源」三檔的措辭刻意不同權重：人工是真值、裝置是弱標籤、AI 是待確認的候選。
   * 三條文案如果讀起來一樣可信，介面就在暗示它們可信度相同。
   */
  samplesUi: {
    statTotal: "樣本總數",
    statTrainable: "可參與訓練",
    statFaultHuman: "故障：人工判定",
    statEquipmentHuman: "裝置：人工",
    statFaultDevice: "故障：裝置判定",
    statFaultAi: "故障：AI 建議",
    statEquipmentUnlabelled: "裝置型別未標",
    filterSource: "樣本來源",
    filterLabelSource: "故障標籤來源",
    filterEquipmentLabel: "裝置型別",
    filterFaultLabel: "故障型別",
    filterAll: "全部樣本",
    source_alarm: "警報",
    source_manual: "手動錄音",
    source_import: "匯入",
    labelSource_human: "人工標註",
    labelSource_device: "裝置判定",
    labelSource_ai: "AI 建議",
    dimension_equipment: "裝置型別",
    dimension_fault: "故障型別",
    labelsTitle: "標籤庫",
    labelsHint: "打標籤時可以直接選這裡的寫法，也可以直接打一個新的（自動入庫）",
    labelsEmpty: "還沒有標籤，先在下面加一個",
    labelUsedBy: "{count} 條樣本在用",
    labelRename: "重新命名",
    labelAdd: "新增",
    labelNewPlaceholder: "新增標籤名",
    labelAdded: "已新增「{name}」",
    labelExists: "「{name}」已經在標籤庫裡了",
    labelRenamed: "已改名為「{name}」，同時更新了 {count} 條樣本",
    labelRenameFailed: "改名失敗：這一維裡已經有同名的標籤",
    labelRemoved: "已刪除「{name}」",
    labelRemoveFailed: "刪除失敗",
    labelInUse: "「{name}」還有 {count} 條樣本在用，不能刪除",
    trainButton: "訓練並評估",
    trainingTitle: "訓練結果（留一法）",
    trainingSamples: "參與訓練",
    trainingAccuracy: "留一法準確率",
    trainingExcluded: "不納入訓練",
    trainingExcludedValue: "無故障型別 {noLabel} 條 · 缺特徵 {missingMetrics} 條",
    trainingEquipment: "訓練集的裝置型別",
    trainingEquipmentValue: "{kinds} 種 · 未標註 {unassigned} 條",
    trainingDegenerate: "只有一個類別，準確率恆為 100%，這個數字沒有資訊量。",
    trainingUnassessable: "每類樣本不足 2 條的類別無法用留一法評估：{labels}。它們的準確率不參與上面的數字。",
    trainingMixedEquipment: "訓練集裡不止一種裝置型別：同一個故障類別在不同裝置上可能不是同一種現象，準確率會偏低。",
    trainingTruncated: "樣本數超過訓練上限，本次只用了前一部分。",
    trainingConfusion: "混淆矩陣（只列非零項）",
    trainingConfusionRow: "標註為 {expected} → 判為 {predicted}：{count} 條",
    columnTime: "時間",
    columnDevice: "裝置",
    columnChannel: "聲道",
    columnSource: "來源",
    columnEquipment: "裝置型別",
    columnFault: "故障型別",
    columnMetrics: "特徵",
    columnActions: "動作",
    loading: "正在載入…",
    empty: "樣本庫還是空的。可以在「告警中心」或「錄音檔案」裡把一條記錄加入樣本庫。",
    unlabelled: "未標註",
    metricsCount: "{count} 維",
    metricsHint: "裝置報過的特徵維度；缺的維度不會補 0",
    blockedNoLabel: "沒有故障型別，不能訓練",
    blockedMissingMetrics: "缺特徵：{metrics}",
    editLabel: "改標籤",
    clearEquipment: "撤銷裝置型別",
    clearFault: "撤銷故障型別",
    labelSaved: "標籤已儲存",
    labelCleared: "標註已撤銷",
    removed: "樣本已刪除",
    exportTitle: "匯出資料集",
    exportOnlyLabelled: "只匯出已標註的樣本",
    exportCopyAudio: "同時複製音訊檔案",
    exportButton: "匯出資料集…",
    exporting: "正在匯出…",
    exportDone: "已匯出 {samples} 條（其中已標註 {labelled} 條）到：",
    exportSkipped: "另有 {count} 條未標註被跳過。",
    exportAudio: "已複製音訊 {copied} 個（{bytes}）。",
    exportAudioSkipped: "未複製音訊：清單裡的路徑指向本機儲存目錄，換機器用要勾上「同時複製音訊檔案」。",
    exportAudioMissing: "有 {count} 條音訊檔案不在儲存目錄裡，清單中已標記 audio_missing。",
    exportFiles: "目錄內含 samples.jsonl、samples.csv、dataset-info.json。",
    aiTitle: "AI 標註（可選）",
    aiReady: "已設定",
    aiUnknown: "未讀取到配置",
    aiBlockedDisabled: "未啟用",
    aiBlockedNoEndpoint: "未填介面地址",
    aiBlockedBadEndpoint: "介面地址不合法（需以 http:// 或 https:// 開頭）",
    aiBlockedNoModel: "未填模型名稱",
    aiEnabled: "啟用 AI 標註",
    aiEndpoint: "介面地址",
    aiEndpointPlaceholder: "https://主機/v1/chat/completions",
    aiModel: "模型名稱",
    aiModelPlaceholder: "例如 my-model",
    aiApiKey: "API 金鑰",
    aiKeyStored: "已儲存",
    aiKeyAbsent: "未儲存",
    aiApiKeyPlaceholder: "留空表示不改動已儲存的金鑰",
    aiNoEncryption: "系統加密不可用，金鑰無法儲存（只儲存地址與模型名）。",
    aiSave: "儲存配置",
    aiSaved: "配置已儲存",
    aiClearKey: "清除金鑰",
    aiIncludeWeak: "包含帶裝置弱標籤的樣本",
    aiRun: "讓 AI 標註",
    aiRunning: "正在標註…",
    aiCandidateNote: "AI 給出的是候選標籤：不會覆蓋人工標註，也不會進入訓練集，需要人工確認後改標為人工。",
    aiOverwriteWarning: "已勾選覆蓋裝置弱標籤：裝置點陣圖給出的判定會被 AI 的猜測替換掉，無法從這條樣本恢復。",
    aiOutcome: "檢查 {considered} 條，向模型提問 {requested} 條，寫入候選標籤 {labelled} 條。",
    aiOutcomeBreakdown: "人工標註跳過 {human} 條 · 裝置弱標籤跳過 {weak} 條 · AI 判不了 {unresolved} 條 · 失敗 {failed} 條",
    pagerRange: "本頁 {shown} 條 / 共 {total} 條"
  },
  /**
   * 聽診盒子族（E2 / FA100 / FA110）的「拉」通道（業主 2026-09-16）。
   *
   * 引數名（`db_limit`、`hpss_limit`…）用**裝置自己的鍵名**做字尾：手冊就是這些名字，
   * 換一箇中文說法會讓"介面上的詞"與"手冊裡的詞"對不上，而排查時要對著手冊看。
   * 認不出的鍵在元件裡**直接顯示原鍵名**（`paramLabel()`），所以這裡不必窮舉。
   */
  /**
   * SN-16 每秒實時值回撥（裝置 POST 到 notify_url，本機複用接入監聽接收）。
   */
  e2CallbackUi: {
    title: 'SN-16 實時值回撥',
    hint: '裝置按秒把 max_db_value / max_db_chn / TDE / FDE 發到 notify_url；本機複用「本機接入」的 HTTP 監聽接收。開啟時會把本機地址寫入裝置（管理員操作）。',
    start: '在本機接收',
    stop: '結束接收',
    deviceUrl: '裝置回撥地址',
    flag: 'is_send_realtime_value',
    listener: '本機監聽',
    listening: '監聽中（埠 {port}）',
    stopped: '未監聽',
    pointsToUs: '已指向本機',
    pointsElsewhere: '指向其它位址',
    notConfigured: '裝置未配置',
    adminOnly: '寫入裝置需要管理員許可權。',
    partialReadback: '裝置已寫入，但讀回核對沒有全部一致；請重新整理確認。',
    receivedAt: '最近一次收到：{time}',
    maxDbValue: '最大聲壓級',
    maxChannel: '最大聲道',
    tde: '時域能量比',
    fde: '頻域能量比',
    noValue: '還沒有收到實時值。'
  },
  e2Ui: {
    statusTitle: '裝置狀態',
    variant: '協議代次',
    variant_auscultation: '聽診盒子（2023 版協議）',
    /*
     * 業主 2026-09-17 澄清：這一代是他們的一款 **SN-16 空氣聲吶**，用途是**聲源定位**
     * （不是"再一款聽診盒子"）。所以標籤按產品名寫，而不是按手冊的檔名（Air Sonar）寫。
     * 內部變體鍵仍是 `airSonar`（它出現在 IPC 與落庫資料裡，改鍵只會讓舊資料對不上）。
     */
    variant_airSonar: 'SN-16 空氣聲吶（V3.2 協議）',
    variantUnknown: '認不出這一代（裝置回話裡沒有可判定的欄位）',
    mode: '運作模式',
    modeNotApplicable: '這一代沒有工作模式',
    modeUnknown: '裝置未上報工作模式',
    mode_burst_of_loud_sound: '突發大聲音監測',
    mode_rotating_equipment: '旋轉類裝置監測',
    mode_electrical_power_equipment: '電力裝置狀態監測',
    samplerate: '取樣率',
    channelCount: '通道數',
    spectrogramSize: '時頻譜圖尺寸',
    deviceType: '裝置型號',
    firmware: '韌體版本',
    retention: '告警記錄上限',
    retentionValue: '裝置只保留最近 {count} 條',
    paramsError: '裝置狀態沒讀全：{reason}',
    paramsEmpty: '裝置沒有返回任何引數。',
    paramColumn: '引數',
    valueColumn: '當前值',
    paramExtra: '裝置多給的鍵',
    paramValueHidden: '已設定（不顯示）',
    param_db_limit: '分貝閾值 db_limit',
    param_tde_ratio_limit: '時域能量比閾值 tde_ratio_limit',
    param_fde_ratio_limit: '頻帶能量比閾值 fde_ratio_limit',
    param_freq_down_limit: '頻帶下限 freq_down_limit',
    param_freq_up_limit: '頻帶上限 freq_up_limit',
    param_hpss_limit: '諧波衝擊成分閾值 hpss_limit',
    param_main_freq_limit: '主頻閾值 main_freq_limit',
    param_sc_ratio_limit: '頻譜複雜度閾值 sc_ratio_limit',
    param_sc_ratio_threshold: '頻譜複雜度判據 sc_ratio_threshold',
    param_samplerate: '取樣率 samplerate',
    param_notify_url: '告警回撥地址 notify_url',
    param_is_send_alarm: '推送警報 is_send_alarm',
    param_is_send_fft: '推送實時分析 is_send_fft',
    param_cam_enable: '啟用 PTZ 相機 cam_enable',
    param_cam_ip: '相機地址 cam_ip',
    param_cam_port: '相機埠 cam_port',
    param_cam_user: '相機賬號 cam_user',
    param_cam_pass: '相機口令 cam_pass',
    param_cur_realtime_channel: '實時監聽通道 cur_realtime_channel',
    param_is_cam_init: '相機已初始化 is_cam_init',
    param_is_ptz_direction_same_with_sonar: '相機方向與聲學一致 is_ptz_direction_same_with_sonar',
    param_is_save_snapshot: '告警抓圖 is_save_snapshot',
    param_is_send_realtime_value: '推送實時計算值 is_send_realtime_value',
    syncTitle: '警報同步',
    syncHint: '把裝置上的告警日誌與錄音拉到本機（裝置只保留最近 {count} 條）。重複同步不會重複入庫。',
    syncSpectrograms: '同時下載時頻譜圖',
    syncSnapshots: '同時下載 PTZ 抓圖',
    syncButton: '同步警報',
    syncing: '同步處理中…',
    outcomeAlarms: '檢查 {seen} 條日誌：新增 {created} 條，已在庫 {existing} 條。',
    outcomeAudio: '錄音：新下載 {saved} 個，本地已有 {existing} 個，失敗 {failed} 個。',
    outcomeFilesMissing: '其中 {count} 條的檔案已被裝置清掉（files_status = 0），只登記了告警。',
    outcomeSpectrograms: '時頻譜圖：存下 {saved} 張，裝置上沒有 {failed} 張（重啟後不足 10 張是正常的）。',
    outcomeSnapshots: 'PTZ 抓圖：存下 {saved} 張，裝置上沒有 {failed} 張（相機沒配對或未開啟抓圖時會是 0）。',
    outcomeBadTime: '{count} 條的時間無法解析，已跳過（沒有猜它們的時刻）。',
    outcomeDbThreshold: '因 dB 值低於裝置閾值跳過 {count} 條',
    outcomeHint: '同步於 {time}'
  },
  playerUi: {
    missingTitle: '該記錄沒有本地錄音檔案',
    missingBody: '告警本身只儲存指標與告警型別，錄音檔案需要從裝置同步。請先在「錄音檔案」頁面點選「同步裝置錄音」，把裝置上的錄音後設資料與檔案匯入本地，然後回到這裡播放。',
    errMissingFile: '該記錄沒有本地錄音檔案，無法播放',
    errNoData: '主程序沒有返回音訊資料',
    errDecode: '音訊資料解碼失敗：{detail}',
    loading: '正在載入錄音…',
    reload: '重新載入',
    play: '播放錄音',
    release: '關閉播放',
    downloading: '正在從裝置下載並解碼音訊，約 {size}，請稍候…',
    autoplayBlocked: '已載入完成，瀏覽器未自動播放，請點選下方播放按鈕。',
    leadShort: '請求從告警前 {requested} 秒開始，但這段錄音只有告警前 {actual} 秒的內容，已從錄音開頭播放。',
    fewMegabytes: '數 MB',
    channelCount: '聲道數',
    channelCountValue: '{count} 聲道',
    encoding: '編碼',
    waveformTitle: '波形預覽',
    waveformAria: '錄音波形預覽',
    waveformMissing: '本次播放資料未包含波形預覽。',
    spectrumTitle: '頻譜快照',
    spectrumMissing: '本次播放資料未包含頻譜快照。'
  },

  labUi: {
    noticeDone: '診斷已完成，結果如下',
    errSelectDevice: '請先選擇裝置',
    errPathRequired: '請輸入要探測的路徑，例如 /get_devinfo',
    endpointNotProbed: '本次診斷未探測到該端點。',
    requestFailed: '請求失敗：{detail}',
    httpNoResponse: '無響應',
    contentTypeMissing: '未宣告 Content-Type',
    chunkedUnknown: '未確認分塊傳輸',
    chunkedYes: '使用了分塊傳輸',
    chunkedNo: '非分塊傳輸',
    bytesUnknown: '未統計位元組數',
    bytesReceived: '收到 {count} 位元組',
    jsonFields: 'JSON 欄位：{fields}',
    summarySeparator: '；',

    risk1Title: '風險 1：登入 Token 的攜帶方式',
    risk1Question: '文件只說明 /login 返回 Token，未說明後續請求如何攜帶。',
    risk1Confirmed: '已確認可用方式：{strategy}；登入響應中{tokenState} Token 欄位。',
    risk1Pending: '尚未確認。請先執行診斷；若全部候選方式都失敗，需要在裝置端抓包核對。',
    risk2Title: '風險 2：/audio_stream 的幀格式',
    risk2Question: '音訊流的封裝方式、取樣格式與分塊策略均未文件化。',
    risk2Pending: '尚未確認。該端點未返回可用響應，不能假設其為 chunked PCM。',
    risk3Title: '風險 3：/freq_domain 與 /time_freq_domain 的資料結構',
    risk3Question: '兩個頻域端點的欄位名與陣列維度未知，直接解析會靜默丟資料。',
    risk3Pending: '尚未確認。請分別探測兩個端點並檢視原始樣本。',
    risk4Title: '風險 4：錄音下載地址的拼裝規則',
    risk4Question: '裝置返回的錄音路徑無法直接拼成可下載 URL（是否帶字首、是否要再拼埠未知）。',
    risk4Pending: '尚未確認。請探測錄音列表與下載端點，確認返回的路徑形態後再實現下載。',
    risk5Title: '風險 5：埠 0 的語義',
    risk5Question: 'set_network 示例中出現埠 0，無法判斷它表示“預設埠”還是“禁用該服務”。',
    risk5Pending: '必須實機驗證：寫入埠 0 後重新讀取網路配置，觀察裝置實際監聽埠是否變化。在得到結論前，本程式不會向裝置寫入 0 值埠。',

    introTitle: '這裡做什麼',
    chipAuth: 'Token 攜帶方式',
    chipAudioFraming: '/audio_stream 幀格式',
    chipFreqSchema: '頻域端點資料結構',
    chipDownloadUrl: '錄音下載 URL 規則',
    chipPortZero: '埠 0 語義',

    noDeviceTitle: '請先新增裝置',
    goToDevices: '前往裝置管理',
    targetTitle: '診斷目標',
    deviceLine: '裝置 ID {uid} · {address}',
    noAddress: '無地址',
    deviceLabel: '裝置',
    diagnosing: '診斷中…',
    runDiagnosis: '執行診斷',

    customTitle: '自定義端點探測',
    pathLabel: '路徑',
    pathPlaceholder: '範例 /get_devinfo',
    methodLabel: '呼叫方式',
    probing: '探測中…',
    probe: '探測',
    ok: '通過',
    failed: '失敗',
    httpStatus: 'HTTP 狀態',
    elapsed: '耗時',
    chunked: '分塊傳輸',
    yes: '有',
    no: '無',
    receivedBytes: '接收位元組',
    error: '錯誤',

    reportTitle: '診斷報告',
    detectedAuth: '檢測到的認證方式',
    unconfirmed: '未確認',
    loginTokenPresent: '登入是否返回 Token',
    tokenPresent: '有',
    tokenAbsent: '未發現',
    loginResponseFields: '登入響應欄位',

    endpointsTitle: '端點探測結果',
    endpointCount: '共 {count} 個端點',
    columnPath: '路徑',
    columnMethod: '呼叫方式',
    columnResult: '結果',
    columnStatus: '狀態碼',
    columnElapsed: '耗時',
    columnChunked: '分塊',
    columnBytes: '接收位元組',
    columnError: '錯誤',
    noEndpointResults: '診斷未返回端點結果。',

    samplesTitle: '原始響應樣本',
    unknownType: '未知型別',

    conclusionsTitle: '結論',
    confirmed: '已確認',
    pendingConfirmation: '待確認'
  },

  authUi: {
    username: "使用者名稱",
    password: "密碼",
    signIn: "登入",
    signingIn: "正在登入…",
    rememberPassword: "記住密碼",
    rememberExpired: "記住的密碼已超過 {days} 天，請重新輸入。",
    rememberUnavailable: "這臺電腦上的系統加密不可用，密碼不會被記住（使用者名稱仍會記住）。",
    signOut: "退出登入",
    signedInAs: "當前賬戶",
    mustChangeTitle: "請先修改出廠密碼",
    changeTitle: "修改密碼",
    currentPassword: "當前密碼",
    newPassword: "新密碼",
    confirmPassword: "確認新密碼",
    changeSubmit: "儲存新密碼",
    changing: "正在儲存…",
    changeSuccess: "密碼已修改",
    recoverLink: "忘記密碼？",
    recoverTitle: "用超級密碼重置",
    installId: "安裝標識",
    copy: "複製",
    copied: "已複製",
    superPassword: "超級密碼",
    recoverSubmit: "重置密碼",
    recovering: "正在重設…",
    recoverSuccess: "密碼已重置，請用新密碼登入",
    backToLogin: "返回登入",
    errUsername: "請輸入使用者名稱",
    errPassword: "請輸入密碼",
    errCurrentPassword: "請輸入當前密碼",
    errNewPassword: "請輸入新密碼",
    errPasswordMismatch: "兩次輸入的新密碼不一致",
    errPasswordLength: "密碼長度至少 {min} 位",
    errPasswordWhitespace: "密碼首尾不能包含空格",
    errPasswordHasUsername: "密碼不能包含使用者名稱",
    errSuperPassword: "請輸入超級密碼"
  },

  usersUi: {
    title: "賬戶管理",
    addUser: "新增賬戶",
    username: "使用者名稱",
    displayName: "顯示名稱",
    role: "使用者角色",
    lastLogin: "最近登入",
    neverLoggedIn: "從未登入",
    pendingPasswordChange: "待修改密碼",
    create: "建立",
    creating: "正在建立…",
    created: "賬戶已建立，對方首次登入時需要修改密碼",
    resetPassword: "重置密碼",
    resetTitle: "重置「{name}」的密碼",
    resetSubmit: "確認重置",
    resetDone: "密碼已重置",
    deleteUser: "刪除賬戶",
    deleteConfirm: "確定刪除賬戶「{name}」嗎？該操作無法撤銷。",
    cannotDeleteSelf: "不能刪除當前登入的賬戶",
    empty: "除當前賬戶外還沒有其他賬戶。"
  },

  /**
   * 賬號管理頁（手冊 §17.1 Account Management，p177–178）。
   *
   * 與 `usersUi` 分開而不是並進它：`usersUi` 裡的文案服務於那個**彈窗**
   * （`UsersDialog.vue`，從頂欄的賬戶選單開啟），而這一頁是設定頁裡的一塊。
   * 同一件事在兩個位置上的說法本來就不同（彈窗裡叫「關閉」，頁面上不需要關閉），
   * 共用 key 會逼著其中一處說彆扭的話。
   */
  accountUi: {
    title: '賬號管理',
    adminOnly: '只有管理員可以管理賬戶',
    editUser: '編輯賬戶',
    saved: '賬戶已儲存',
    deleted: '賬戶已刪除',
    empty: '還沒有任何賬戶。',
    permissions: '許可權',
    permissionScopeCount: '{count} 項操作受此許可權控制',
    permissionScopeNone: '本版本還沒有對應的操作通道',
    createPermissionsHint: '按手冊預設只勾選只讀許可權，寫入類許可權需要手工勾選',
    adminAllPermissions: '管理員賬戶預設擁有全部許可權',
    copyFrom: '複製許可權',
    copyFromPlaceholder: '從…複製許可權',
    defaultPermission: '恢復該使用者預設許可權',
    permissionsCopied: '已複製「{name}」的許可權，點選儲存後生效',
    permissionsDefaulted: '已恢復預設許可權，點選儲存後生效',
    errCopySource: '請先選擇要複製許可權的賬戶',
    errUsernameForbidden: '使用者名稱不能包含以下字元：{chars}',
    errUsernameTooLong: '使用者名稱不能超過 {max} 個字元',
    errTooManyAccounts: '最多隻能建立 {max} 個賬戶',
    builtInAdminUndeletable: '內建管理員不可刪除，但可以修改它的密碼',
    rules: '使用者名稱不得包含 {chars}；密碼不得少於 {min} 個字元；最多 {max} 個賬戶；內建管理員不可刪除。'
  },

  /**
   * 告警聲音庫（手冊 §17.2.7，p185）。
   */
  alarmSoundUi: {
    title: '告警聲音',
    binding: {
      popup: '告警聯動彈窗提示音',
      push: '裝置推送告警提示音'
    },
    soundOn: '開',
    soundOff: '關',
    bindingNone: '未選擇',
    bindingHint: '彈窗與裝置推送告警響起時使用所選聲音。',
    libraryGroup: '聲音庫',
    addCustom: '新增自定義聲音',
    defaultColumn: '預設',
    typeColumn: '型別',
    fileColumn: '音訊檔案',
    predefined: '預定義',
    predefinedUndeletable: '預定義的聲音型別不可刪除',
    noFile: '未選擇',
    pickFile: '選擇檔案',
    clearFile: '清除檔案',
    preview: '試聽',
    previewing: '正在試聽：{name}',
    customDefaultName: '自定義聲音 {count}',
    renameHint: '雙擊可以改名',
    deleted: '已刪除該自定義聲音，點選儲存後生效',
    defaultSet: '已將「{name}」設為預設聲音，點選儲存後生效',
    defaultIs: '預設聲音：{name}',
    filePicked: '已選擇 {name}，點選儲存後生效',
    onlyWav: '音訊檔案只能是 {ext} 格式',
    errOnlyWav: '音訊檔案只能是 {ext} 格式',
    errOnlyWavFor: '「{name}」選擇的檔案不是 {ext} 格式',
    errNoFile: '請先為該聲音選擇音訊檔案',
    errPreview: '無法播放該音訊檔案，請確認它是有效的 WAV 檔案',
    errEmptyName: '聲音名稱不能為空',
    errPredefinedUndeletable: '預定義的聲音型別不可刪除',
    summary: '共 {total} 項（自定義 {custom} 項），已選擇檔案 {files} 項'
  },

  /**
   * 郵件設定（手冊 §17.2.8 Email Settings，p186）。
   */
  emailUi: {
    title: '郵件設定',
    host: 'SMTP 伺服器',
    port: '埠',
    portHint: '預設為 25；選擇 SSL 時通常需要改成 465',
    security: '連線安全',
    securityNone: '無',
    securitySsl: 'SSL',
    securityStarttls: 'STARTTLS',
    authentication: '要求認證',
    username: '使用者名稱',
    password: '密碼',
    passwordState: '已儲存的口令',
    clearPassword: '清除已儲存的口令',
    passwordCleared: '已清除本機儲存的 SMTP 口令',
    from: '發件人地址',
    receiversSection: '收件者',
    receiverN: '收件者 {n}',
    receiversHint: '最多 {max} 個收件人',
    templateSection: '郵件內容',
    sendTest: '傳送測試郵件',
    testFailed: '傳送測試郵件失敗',
    saveSuccessWithPassword: '設定已儲存，SMTP 口令已存入本機憑據庫',
    errHost: '請填寫 SMTP 伺服器地址',
    errPort: '埠需為 1 到 65535 之間的整數',
    errUsername: '勾選「要求認證」後必須填寫使用者名稱',
    errFrom: '請填寫發件人地址',
    errFromFormat: '發件人地址格式不正確',
    errRecipients: '請至少填寫一個收件人地址',
    errTooManyRecipients: '最多隻能填寫 {max} 個收件人',
    errRecipientFormat: '收件人地址格式不正確：{value}'
  },

  channelState: {
    enabled: '已啟用',
    disabled: '未啟用',
    unknown: '狀態未知',
    disabledHint: '該通道未啟用，不參與實時監測',
    unknownHint: '尚未讀取到該通道的啟用狀態，請重新整理裝置',
    liveActive: '正在接收資料',
    liveSilent: '未接收到資料',
    enabledSummary: '已啟用 {enabled} / {total} 路'
  },

  domain: {
    sensorType: {
      microphone: '麥克風',
      conduction: '骨傳導'
    },
    detectionMode: {
      characteristic: '特徵檢測',
      ai: 'AI 檢測'
    },
    recordingType: {
      alarm: '告警錄音',
      manual: '手動錄音',
      scheduled: '定時錄音'
    },
    streamKind: {
      features: '實時特徵',
      audio: '實時音訊',
      spectrum: '頻譜',
      spectrogram: '時頻圖'
    },
    deviceKind: {
      acousticBox: '聲紋裝置',
      acousticCamera: '聲學相機',
      auscultationBox: '聽診盒子 / SN-16 空氣聲吶'
    },
    /**
     * 事件與告警中心的列舉鍵。
     *
     * 與其它 `domain.*` 同一條規則：取值是**穩定標識**，介面按這些鍵翻譯；
     * 領域層（`shared/domain/event-center.ts`）只產出標識，不產出文案。
     */
    eventSource: {
      deviceDetect: '相機檢測日誌',
      linkage: '本機告警聯動',
      localAlarm: '聲紋裝置告警',
      deviceStatus: '裝置狀態'
    },
    eventSeverity: {
      info: '提醒',
      warning: '警示',
      critical: '嚴重',
      unknown: '等級未知'
    },
    eventKind: {
      deviceDetect: '完成一次檢測',
      deviceDetectAlarm: '裝置判定為告警的檢測',
      linkageAlarm: '本機聯動告警',
      localAlarm: '聲紋裝置告警',
      deviceOnline: '裝置上線',
      deviceOffline: '裝置離線'
    },
    detectFileKind: {
      power_spectrum_photo: '功率譜圖片',
      power_spectrum_video: '功率譜影片',
      soundmap_photo: '聲場圖圖片',
      soundmap_video: '聲場圖影片',
      voiceprint_photo: '聲紋圖片',
      voiceprint_video: '聲紋影片',
      bin_mic_data: '麥克風二進位制資料',
      wav_mic_data: '麥克風 WAV 音訊'
    },
    eventDownloadStage: {
      starting: '準備下載',
      fetching: '正在從裝置下載',
      verifying: '正在校驗檔案',
      registering: '正在登記錄影',
      done: '下載完成',
      reused: '本機已有，直接複用',
      failed: '下載失敗'
    },
    userRole: {
      admin: '管理員',
      operator: '普通使用者'
    },
    /**
     * 賬號許可權目錄（手冊 §17.1 的許可權核取方塊）。
     *
     * 取值是 `UserPermissionKey` 的穩定標識，介面按它逐項渲染核取方塊，
     * 所以「多了一項許可權卻沒有譯文」會渲染出一串裸 key。
     */
    permission: {
      manageAccounts: '賬號管理',
      manageSystemSettings: '系統設定寫入',
      manageDevices: '裝置增刪',
      configureDevices: '裝置配置寫入',
      controlCameras: '相機控制與維護',
      deleteRecordings: '刪除錄影',
      downloadDetectFiles: '下載檢測記錄',
      viewDevices: '檢視裝置',
      viewAlarms: '檢視告警',
      viewRecordings: '檢視錄影',
      viewTrends: '檢視趨勢',
      viewEvents: '檢視事件中心'
    },
    /**
     * 每一項許可權**管住哪些操作**（與 `PERMISSION_OPERATIONS` 一一對應）。
     *
     * 為什麼介面上要顯示它：一個核取方塊如果只寫「裝置配置寫入」，使用者無法判斷它到底
     * 會不會讓他改網路地址、改裝置名、改串列埠。這一句就是那個答案，而它與主程序真正
     * 攔截的通道來自同一張表。
     */
    permissionScope: {
      manageAccounts: '賬號管理頁上的全部改動：新增、刪除、改角色、改許可權、改顯示名稱、重置口令',
      manageSystemSettings: '系統設定的儲存、恢復預設值與告警聲音檔案選擇',
      manageDevices: '新增/修改/刪除裝置、重啟、恢復出廠、系統升級、韌體上傳與相機韌體升級',
      configureDevices: '通道、取樣率、告警配置、網路地址、時間、RS485、Modbus 與裝置名稱的寫入',
      controlCameras: '實時影片開關、手動錄影與抓圖、相機告警模型、檢測啟停與成像引數',
      deleteRecordings: '刪除錄影（本版本還沒有這條通道，見程式碼註釋）',
      downloadDetectFiles: '把裝置上的檢測結果檔案下載到本機',
      viewDevices: '裝置列表、裝置詳情、裝置資訊與通道表',
      viewAlarms: '告警中心、聯動引擎狀態與待處理告警',
      viewRecordings: '錄音/錄影列表、回放資料與錄影播放地址',
      viewTrends: '歷史趨勢查詢、覆蓋範圍與統計',
      viewEvents: '事件中心的查詢與相機檢測庫'
    },
    /**
     * 六種預定義告警聲音（手冊 §17.2.7 第 5439 行的 six pre-defined alarm sound
     * type）。取值是 `AlarmSoundTypeKey`，自定義項不用這裡的名字（它的名字是使用者打的）。
     */
    alarmSound: {
      motionDetection: '移動偵測',
      videoLoss: '影片丟失',
      videoTampering: '影片遮擋',
      externalAlarm: '外部報警',
      lineCrossing: '越界偵測',
      intrusion: '區域入侵'
    }
  },

  /**
   * Camera live video (FA371 RTSP -> ffmpeg -> loopback <video>).
   *
   * NO MESSAGE HERE MAY CONTAIN `@`: it is vue-i18n's linked-message sigil, and a
   * message containing one fails to COMPILE at render time (`SyntaxError: 10`) —
   * which the catalogue tests catch, because they compile every message.
   */
  /**
   * 連續錄影（S1 介面）：開關 + 狀態行。
   *
   * 與 `cameraLiveUi` 同一條硬規則：本塊任何一條訊息都不得包含 `@`。
   */
  recorderUi: {
    title: '連續錄影',
    enable: '開啟連續錄影',
    disable: '停止連續錄影',
    working: '處理中…',
    statusOff: '未開啟',
    statusStarting: '正在啟動…',
    statusRecording: '錄影中',
    statusWaiting: '已啟動，等待視訊資料',
    statusBackoff: '連線中斷，第 {attempt} 次重試',
    notRunning: '已要求錄影，但錄影程序未執行',
    registered: '本次執行已登記 {count} 片',
    segmentLength: '每段 {seconds} 秒',
    lastError: '最近錯誤：{reason}',
    hint: '連續錄影會按時間切片保存在本機；超出儲存配額時會先刪除最舊的連續錄影。'
  },

  cameraLiveUi: {
    title: '相機實時影片',
    rtspAddressUnknown: '裝置未上報影片地址',
    start: '開始影片',
    stop: '停止影片',
    retry: '重試',
    statusIdle: '影片未啟動',
    statusStarting: '正在啟動影片…',
    statusPlaying: '影片播放中',
    statusRtspDisabled: '相機 RTSP 未啟用',
    statusFfmpegMissing: '內建 ffmpeg 不可用',
    statusError: '影片流失敗',
    rtspDisabledHint: '相機的 RTSP 服務處於關閉狀態（裝置上報 rtsp_enabled=0）。請在相機 Web 介面的「高階設定 → RTSP」中啟用後再試。',
    ffmpegMissingHint: '內建的 ffmpeg 轉封裝元件缺失或無法執行，請重新安裝本軟體；應用日誌中記錄了它查詢過的路徑。',
    errorHint: '影片流已中斷，可以點選重試重新開啟。',
    limitExceededHint:
      '本機同時直播的路數已達上限（可在「系統設定 → 實時影片」調整）。請先停止其他正在播放的畫面，再點選「開始影片」。',
    pausePicture: '暫停畫面',
    playPicture: '播放畫面',
    lookSnapshot: '檢視（抓圖）',
    lookPlayback: '重播',
    volume: '音量大小',
    volumeMuted: '已靜音',
    volumeValue: '目前音量 {percent}%',
    volumeNoPicture: '還沒有畫面時不能調音量',
    /** 紅外浮層按鈕（業主 20260921 批第三批第 2 條）。裝置只報溫度數值，無紅外影片流。 */
    infrared: '紅外',
    infraredNoVideo: '裝置僅提供溫度數值，暫無紅外影片流',
    infraredEmissivity: '發射率',
    /** 影片資訊疊加條開關。 */
    overlayToggle: '疊加',
    dataForwarded: '已轉發 {count} 位元組',
    modeRemux: '直接轉封裝（不重新編碼）',
    modeTranscode: '重新編碼（相容模式）',
    attemptInfo: '第 {index} 個地址候選：{id}'
  },

  /**
   * Camera acoustic streams (FA371 manual §5.2) — the five WebSocket channels.
   *
   * Same rule as `cameraLiveUi`: NO MESSAGE HERE MAY CONTAIN `@` (the linked-message
   * sigil), and the catalogue tests compile every message to prove it.
   *
   * The wording matters more than usual here: every "no data" state must read as a
   * distinct, honest fact rather than as a quiet measurement.
   */
  cameraStreamUi: {
    detectMode: '檢測模式值',
    modePrpdTitle: 'PRPD',
    modeLeakageTitle: '洩漏資料',
    modeMechanicalTitle: '機械特徵',
    modeAnalysisTitle: '分析模式',
    prpdPhase: '相位角',
    prpdAmplitude: '振幅',
    prpdCount: '次數',
    prpdPhaseAxis: '相位角（°）',
    modeDataStatus: '狀態',
    modeDataWaiting: '等待目前模式的特徵資料。',
    modeSelectHint: '請選擇檢測模式以顯示對應的分析內容。',
    stop: '結束接收',
    startSpectrum: '接收頻譜',
    startWaveform: '開始接收波形',
    startVoiceprint: '接收聲紋圖',
    onDemandHint: 'GIS 不會自動開相機資料流：點「接收」後才會建立該通道連線；切換 Tab 或離開頁面會停止。',
    adminOnlyHint: '開啟與停止相機資料流屬於管理員操作。',
    noDevice: '請先選擇一臺相機。',
    sessionIdle: '資料流未啟動',
    sessionRunning: '資料流接收中',
    sessionError: '資料流失敗',
    handshake: '交握方式：{id}',
    framesCount: '{count} 幀',
    silentFor: '已靜默 {seconds} 秒',
    phaseNotStarted: '未啟動',
    phaseNoFrames: '尚無資料',
    phaseLive: '串流接收中',
    phaseStale: '資料已停止',
    phaseError: '通道錯誤',
    hintNotStarted: '該通道尚未啟動。點選「開始接收」後才會建立連線。',
    hintNoFrames: '連線已建立，但還沒有收到任何一幀。空面板代表沒有資料，不代表環境安靜。',
    hintStale: '曾經收到資料，但已超過 {seconds} 秒沒有新幀，畫面停留在最後一幀上，請勿當作實時值。',
    hintError: '該通道報錯，具體原因見下方日誌或應用日誌。',
    layoutWarning: '當前幀長與該通道的解碼假設不一致，顯示的資料可能不可靠。',
    voiceprintTitle: '聲紋圖',
    voiceprintAlt: '相機推送的聲紋影象',
    voiceprintJpegMeta: '裝置推送的 JPEG 影象：{bytes}',
    voiceprintMatrixMeta: '幅度矩陣 {width}×{height}（源資料已抽稀 {decimation} 倍）',
    audioTitle: '實時音訊',
    audioPlay: '開啟聲音',
    audioStop: '關閉聲音',
    pcmMeta: '每幀 {samples} 個取樣點 · {ms} 毫秒 · {rate} kHz',
    pcmCrest: '峰值因數 {crest}',
    fftTitle: '頻譜',
    fftLineAxis: '譜線序號',
    fftAmplitudeAxis: '幅度（裝置原始計數）',
    fftAxisFromDevice: '{lines} 條譜線；裝置上報取樣率後每線寬 {hz} Hz',
    fftAxisUnknown: '{lines} 條譜線；裝置未上報取樣率，因此橫軸按譜線序號標註，頻率刻度未知。',
  },

  /**
   * Camera NVR interactions — right-click menu, manual recording, snapshot.
   *
   * Same hard rule as `cameraLiveUi`: **NO MESSAGE HERE MAY CONTAIN `@`**
   * (vue-i18n's linked-message sigil compiles to a SyntaxError at render time,
   * and `tests/i18n.test.ts` compiles every message).
   *
   * The `reason*` messages are the point of this block: every disabled menu item
   * and disabled button must say WHY, using the same wording, because both the
   * menu and the buttons read them from one pure rule.
   */
  cameraNvrUi: {    menuTitle: '相機操作：{name}',
    menuCapture: '抓圖 / 錄影',
    menuStartRecording: '手動錄影',
    menuStopRecording: '停止錄影',
    menuSnapshot: '抓圖',
    menuAlarmConfig: '警報設定…',
    /**
     * 「顯示方式」子選單（業主 2026-09-19 第 12 批把四顆檢視按鈕從控制條移到這裡：
     * 「播放器視窗應該只有 告警 / 全屏 / 暫停 / 切換錄影 / 音量 / 手動錄影」）。
     * 四個子項的文字複用 `cameraWallUi.view*`，所以選單與控制條從不說兩種話。
     */
    menuDisplay: '顯示方式',
    /** 「畫面翻轉」子選單（業主 20260921 批第三批第 2 條：翻轉調整移入右鍵；僅相機單路面板傳入 flips 時渲染）。 */
    menuFlip: '畫面翻轉',
    menuFlipHorizontal: '左右翻轉',
    menuFlipVertical: '上下翻轉',
    menuFlipQuarter: '旋轉 90°',
    menuFullscreen: '全螢幕',
    menuExitFullscreen: '離開全螢幕',
    menuCopyRtsp: '複製 RTSP 地址',
    menuOpenExternal: '在外部播放器開啟',
    /*
     * 三項新入口（模型 `camera-nvr.ts` 已經在引用這三個鍵，本輪補齊）。
     *
     * 「回放」必須說清回放的是**本機**錄影：FA371 沒有裝置側連續錄影儲存
     * （`rtsp-stream.ts` 明確不把碼流寫盤），能回放的只有操作員手動錄下的片段
     * 與從裝置下載下來的檢測錄影。寫成「回放裝置錄影」就是一句假話。
     */
    menuPlayback: '回放本機錄影',
    menuDownloadDetect: '下載檢測記錄',
    menuCloseTile: '關閉這一格',
    recordingStarted: '本機錄影已開始：{path}',
    playbackTitle: '回放本機錄影',
    playbackLoading: '正在讀取本機錄影…',
    playbackEmpty: '這臺相機在本機還沒有錄影檔案。',
    playbackLocalNote:
      '本機錄影：下面列出的是這臺電腦上已儲存的錄影檔案（手動錄影，以及從裝置下載的檢測錄影）。FA371 沒有裝置側的連續錄影儲存，這裡回放的不是裝置上的錄影。',
    playbackUnavailable: '無法播放這段錄影：沒有取得可播放的本機地址。',
    playbackTimeline: '錄影時間軸（空白處為沒有錄影的缺口）',
    playbackGap: '目前片段已結束；下一段從 {time} 開始，中間約 {gap} 沒有錄影。',
    playbackContinueNext: '跳至下一段',
    playbackLastSegment: '已經是最後一段。',
    downloadTitle: '下載檢測記錄',
    downloadLoading: '正在讀取裝置檢測記錄…',
    downloadEmpty: '裝置沒有返回任何檢測記錄。',
    downloadNoPaging:
      '裝置介面不支援分頁：本次一次性讀取了裝置上的全部檢測記錄（裝置上報 {count} 條）。',
    downloadColumnTime: '檢測時間',
    downloadColumnMode: '檢測模式（原始值）',
    downloadColumnFiles: '結果檔案',
    downloadReused: '本機已有這個檔案，已直接登記為錄影：{name}',
    downloadPlay: '回放這段錄影',
    openExternalDone: '已在外部播放器中開啟這一路的 RTSP 地址。',
    reasonIdle: '影片尚未啟動：請先點選「開始影片」，畫面出現後才能錄影或抓圖。',
    reasonStarting: '影片正在啟動，還沒有收到任何一幀；此時錄影會寫出空檔案，抓圖必然抓空。',
    reasonReady: '影片正在播放。',
    reasonRtspDisabled: '相機上報 rtsp_enabled=0，裝置側 RTSP 服務未啟用，無法錄影或抓圖。',
    reasonFfmpegMissing: '內建 ffmpeg 不可用，無法從碼流錄影或抓圖。',
    reasonError: '影片流失敗，請先重新開啟影片。',
    reasonLimitExceeded: '已達到同時直播上限，先停掉其他畫面格里的直播才能操作這一路。',
    reasonNoAddress: '裝置未上報 RTSP 地址，沒有可複製的地址。',
    reasonNoSource: '當前沒有可用的 RTSP 會話，外部播放器沒有可開啟的地址。',
    recordingBadge: '錄製中 {time}',
    recordSaved: '錄影已儲存：時長 {duration}，大小 {size}，檔案 {path}',
    recordWarning: '提醒：{reason}',
    snapshotSavedTitle: '抓圖已儲存',
    recordSavedTitle: '錄影已儲存',
    snapshotSaved: '抓圖已儲存：{path}',
    openFolder: '開啟所在資料夾',
    copyDone: '已複製 RTSP 地址（含裝置口令，請勿外傳）。',
    copyMaskedDone: '已複製 RTSP 地址（口令已打碼，播放器會要求輸入裝置賬號與密碼）。',
    copyFailed: '複製失敗，請手動選中地址後複製。',
    overlayDevice: '裝置：{name}',
    overlayStatus: '狀態：{status}',
    overlayStream: '碼流：{mode} · {address}',
  },

  /**
   * 相機告警配置對話方塊（手冊 §5.1.22 – §5.1.29）。
   *
   * 同一規則：**不得出現 `@`**。
   *
   * 這裡的文案要承擔一件工程上的責任：手冊有多處自相矛盾/缺失，介面必須把它
   * 說成「未驗證」，而不是讓操作員以為那些取值是裝置確認過的。`unverified` 與
   * `ambiguity*` 就是做這件事的，不要為了好看而刪。
   */
  cameraAlarmUi: {
    title: '相機告警配置',
    /** 實時監測頁那張「告警」卡片（與相機控制並排）的說明與出口。 */
    entryHint: '告警策略與告警條件在裝置側生效，這裡只讀取與修改它們。',
    noAlarms: '本機還沒有這臺相機的告警記錄。',
    /** 連動總開關關著時，「告警資訊」卡片空態如實說明（相機告警只走連動引擎）。 */
    linkageDisabledHint: '告警連動總開關未開啟，相機偵測到的告警不會出現在這裡。請到「設定 → 告警連動」開啟。',
    /** 監測頁影片下方的「告警結果」卡標題（業主 20260921 批第三批第 5 條）。 */
    recentTitle: '告警資訊',
    /* 「告警資訊」表的統一標題格（業主 2026-09-26 第 1 條）。取值为空的那一格顯示 —。 */
    columnIntensity: '聲場強度',
    columnMainFrequency: '主頻',
    pageStatus: '第 {page} / {pages} 頁',
    openAlarmDetail: '在告警中心檢視這條告警的詳情',
    goAlarmList: '檢視告警中心',
    // `subtitle`（「裝置 {name}：告警策略與告警條件（一條策略只關聯一個條件）。」）
    // 已按產品要求刪除：對話方塊裡不再出現這句話，四種語言裡的這一條也一併刪掉，
    // 免得留一個沒人渲染的死鍵。同一個約束仍然成立（策略只能綁一條條件），
    // 它以表單校驗 `issueCondition` 的形式存在。
    tabStrategies: '警報策略',
    tabConditions: '告警條件',
    tabRegions: '告警區域',
    regionHint: '區域依影片畫面的百分比填寫（參考解析度 1920×1080），與即時監測頁的框選編輯同一份資料；儲存後寫入相機。',
    regionColX: 'X %',
    regionColY: 'Y %',
    regionColW: '寬 %',
    regionColH: '高度 %',
    regionAdd: '新增區域',
    regionDeleteSelected: '刪除選取區域',
    regionClearSelection: '取消選取',
    regionEmpty: '尚未設定告警區域。',
    regionClear: '全部清除',
    regionSave: '儲存區域',
    regionReload: '從相機獲取',
    regionCleared: '已清空（尚未寫入相機，儲存後生效）。',
    regionSaved: '告警區域已儲存：矩形已寫入相機，編號和名稱已儲存到本機。',
    regionNotApplied: '相機已回應，但讀回的告警區域與本次設定不一致；已恢復顯示相機實際區域。',
    regionMetadataSaveFailed: '區域已寫入相機，但編號/名稱儲存到本機失敗：{reason}',
    regionInvalid: '每個區域的 X/Y/寬/高都必須是 0–100 的百分比，且寬、高大於 0、不超出畫面。',
    regionVideoStart: '開啟影片',
    regionDraw: '框選區域',
    regionDrawing: '框選中…',
    regionDrawHint: '先開啟影片，點「框選區域」後在畫面上拖曳畫出告警區域；也可以在下方表格裡直接改數值。',
    strategyEnable: '啟用',
    strategyDisable: '停用策略',
    strategyEnableSaved: '啟用狀態已寫入相機。',
    regionColIndex: '編號',
    regionColName: '名稱',
    regionDefaultName: '區域 {n}',
    // `refresh`（「重新整理」）是**文字**按鈕時代的鍵，現在那個控制元件只有一個圖示，
    // 所以它的可訪問名改成下面這一條（圖示按鈕必須靠 aria-label + title 才有名字）。
    refreshIcon: '重新讀取告警策略與告警條件',
    loading: '正在讀取告警配置…',
    empty: '裝置沒有返回任何記錄。',
    newStrategy: '新增策略',
    editStrategy: '編輯策略',
    newCondition: '新建條件',
    editCondition: '編輯條件',
    save: '儲存',
    saveToCamera: '儲存到相機',
    cancel: '關閉',
    edit: '編輯',
    delete: '刪除',
    confirmDelete: '確認刪除「{name}」？此操作會立即下發到裝置。',
    fieldName: '名稱',
    fieldAlias: '別名',
    fieldCondition: '關聯條件',
    fieldLevel: '告警等級',
    fieldInterval: '間隔時間',
    fieldTimes: '序號',
    fieldCycle: '檢測週期（秒）',
    fieldSensitivity: '靈敏度',
    fieldDiagnosis: '診斷說明',
    fieldDbThreshold: 'dB 警報值',
    fieldDbOperator: 'dB 運算',
    fieldDbSwitch: '啟用 dB 判據',
    fieldDfThreshold: '主頻告警值',
    fieldDfOperator: '主頻運算',
    fieldDfSwitch: '啟用主頻判據',
    fieldDfLogical: '主頻邏輯',
    fieldNcFileId: '比對檔案 ID',
    fieldNcThreshold: '相似度閾值',
    fieldNcSwitch: '啟用頻譜比對',
    fieldNcLogical: '比對邏輯',
    fieldNcOperator: '比對運算',
    fieldDischargeSwitch: '啟用放電判據',
    fieldDischargeLogical: '放電邏輯',
    fieldDischargeType: '放電型別',
    fieldNotes: '備註',
    branchDecibel: '聲壓級（dB）',
    branchDominantFreq: '主頻',
    branchComparison: '頻譜比對',
    branchDischarge: '放電診斷',
    dischargeDiagnosisHint: 'dB、主頻或頻譜比對中的任一已啟用異常條件可以先觸發告警；放電類型在異常之後進行診斷，不再作為告警成立前必須匹配的條件。',
    operatorGt: '大於',
    operatorLt: '小於',
    operatorEq: '等於',
    operatorGe: '大於等於',
    operatorLe: '小於等於',
    logicalOr: '或者',
    logicalAnd: '與',
    dischargeCorona: '電暈',
    dischargeSuspension: '懸浮',
    dischargeSurface: '沿面放電',
    dischargeDischarge: '放電',
    stateEnabled: '已啟用',
    stateDisabled: '未啟用',
    stateUnknown: '啟用狀態未知',
    conditionHint: '裝置只回傳條件名稱與 id；完整條件需要展開下面一欄檢視。',
    selectCondition: '請選擇條件',
    noConditions: '裝置還沒有告警條件：請先新建一條條件，再建立策略。',
    conditionIdStyleLabel: '條件修改的目標標識',
    conditionIdStyleId: '發 id（沿用策略的先例）',
    conditionIdStyleAlarmConditionId: '發 alarm_condition_id（讀取側拼寫）',
    conditionIdStyleNone: '不發標識（照欄位表字面）',
    unverified: '未驗證',
    ambiguityConditionIdLabel: '修改條件時無法指定目標',
    ambiguityConditionIdNote: '修改告警條件的請求欄位表裡根本沒有 id 欄位，無法從手冊得知要改哪一條。預設沿用修改策略的先例發 id，另兩種發法保留為候選。',
    ambiguityLevelLabel: '告警等級兩套取值',
    ambiguityLevelNote: '讀取側欄位表寫 0~3，寫入側寫 1~4。本軟體不做靜默偏移：介面上的 1~4 原樣發出，讀回來的值原樣顯示，因此讀到一個 0 時它沒有對應的等級名稱。',
    ambiguityDischargeLabel: '放電判據只在寫入側存在',
    ambiguityDischargeNote: '放電開關、邏輯與型別只出現在新增/修改條件的欄位表裡，讀取介面不回傳它們；放電型別列舉還缺了 3。寫入後讀不回來是手冊如此，不是本軟體漏讀。',
    ambiguityUnitsLabel: '閾值單位與範圍未說明',
    ambiguityUnitsNote: 'dB 告警值與主頻告警值的單位、合法範圍手冊都沒有寫；頻譜比對的相似度寫 0~1。介面上這些數值一律不做換算。',
    ambiguityDeleteLabel: '刪除請求的欄位名缺失',
    ambiguityDeleteNote: '刪除策略/條件的請求體只給了型別（id 陣列），沒有給欄位名。客戶端按候選形狀傳送，裝置是否接受以實際返回為準。',
    ambiguityCreateIdLabel: '新建後拿不到新 id',
    ambiguityCreateIdNote: '新建策略只返回 ret/msg，手冊沒說如何回傳新策略的 id。因此儲存後本對話方塊會重新讀取列表來認領新行。',
    issueName: '策略名必須為 1~20 個字元',
    issueCondition: '請選擇該策略要繫結的告警條件（一條策略只能關聯一個條件）',
    issueLevel: '告警等級在寫入側只接受 1~4（讀取側寫 0~3，本軟體不做偏移）',
    issueCycle: '檢測週期必須為 1~30 秒',
    issueSensitivity: '靈敏度必須為 0~1',
    issueInterval: '間隔時間必須是不小於 0 的整數',
    issueTimes: '序號必須是不小於 0 的整數',
    issueConditionName: '條件名稱不能為空（不超過 64 個字元）',
    issueNoBranch: '請至少啟用一個聲學異常判據：dB、主頻或頻譜比對。',
    issueSimilarity: '噪聲相似度必須為 0~1',
    issueDischargeType: '放電型別只定義了 0/1/2/4（手冊缺 3）',
    savedStrategy: '策略已下發，列表已重新整理。',
    savedCondition: '條件已下發，列表已重新整理。',
    deleted: '刪除請求已下發，列表已重新整理。',
    deletedConditionAfterDisable: '已先停用關聯且正在啟用的告警策略，然後刪除該告警條件。',
    missingId: '該記錄的 id 無法解析為整數，無法修改或刪除（讀取側 id 可能是字串，見規格 §8.3 C21）。',
    adminOnly: '新建、修改與刪除告警配置需要管理員賬戶。'
  },

  /**
   * Channel wall — the Overview page's 1 / 4 / 16 pane channel view.
   *
   * Same rule as `cameraLiveUi` / `cameraStreamUi`: NO MESSAGE HERE MAY CONTAIN `@`
   * (vue-i18n's linked-message sigil — a message containing one fails to COMPILE at
   * render time, which the catalogue tests catch because they compile every message).
   *
   * The wording carries the honesty rules: a tile with no stream says "not monitored",
   * never a plausible measurement.
   */
  /**
   * 多路實時影片牆（監控頁的分屏直播）。
   *
   * 與 `cameraLiveUi` / `cameraStreamUi` 同一條硬規則：**本塊任何一條訊息都不得
   * 包含 `@`**（vue-i18n 的 linked-message 記法，渲染時編譯失敗，
   * `tests/i18n.test.ts` 會編譯每一條訊息）。
   *
   * 這個區塊的措辭是有內容的：每一種「沒有畫面」都必須說出**具體原因**，
   * 絕不允許一個永遠轉的載入圈，或者一塊沒有任何解釋的黑矩形。
   */
  /**
   * 相機控制與維護面板（檢測模式 / 檢測啟停 / 啟用中的策略 / 維護）。
   *
   * 同一條硬規則：**本塊任何一條訊息都不得包含 `@`**（vue-i18n 的
   * linked-message 記法，渲染時編譯失敗；`tests/i18n.test.ts` 會編譯每一條訊息）。
   *
   * 措辭上的兩條堅持：
   *   - `modeRejected` / `detectNotApplied` / `strategyRejected` / `appModeRejected`
   *     說的是**「裝置應答成功但沒有生效」** —— 本裝置實測過 `ret:200` 卻忽略寫入，
   *     所以介面絕不能把成功碼說成"已改好"；
   *   - `reason*` 三條是禁用控制元件 title 裡的原因，不是說明文字：它們回答的是
   *     "這一項為什麼點不了"，所以每條都必須給出**下一步**（去裝置 Web 介面 / 裝置不支援 / 先聯網）。
   *
   * `appMode*` 那一組是**應用模式**（這臺裝置在做哪種應用：區域性放電 / 氣體洩漏 /
   * 機械異響），與上面 `mode*` 那一組（**檢測模式**：單次檢測 / 智慧巡航）是兩件
   * 完全不同的事，措辭上不要互相串用。`appModeSourceHint` 是按鈕上的 title，
   * 只說一句事實：**該端點未見於裝置手冊** —— 不說"已支援"，因為它是實測介面。
   */
  cameraControlUi: {
    settingsTitle: '相機控制設定',
    detectionControlTitle: '檢測控制',
    detectionModeLabel: '檢測模式',
    leakageOpen: '洩漏計算參數',
    leakageParamsTitle: '洩漏計算參數（寫入相機 /system/leakage）',
    leakageDistance: '估算距離（米）',
    leakageUnitLabel: '洩漏單位',
    monetaryUnitLabel: '貨幣單位',
    valueOfGas: '氣體價值',
    energyCost: '能源成本',
    specificPower: '單位功率',
    workingHours: '工作時長',
    correctionRate: '現場校正係數',
    costDisplay: '顯示洩漏成本',
    leakageSave: '保存洩漏參數',
    leakageSaved: '洩漏計算參數已保存（以設備讀回值為準）',
    operationLabel: '運行方式',
    frequencyBand: '頻率範圍',
    lowerFrequency: '頻率下限',
    upperFrequency: '頻率上限',
    suggestedFrequencyRange: '建議頻率範圍：{range}',
    recommendedForMode: '目前模式建議：{range}',
    imagingThreshold: '成像閾值',
    imagingThresholdHint: '建議從目前現場背景聲級開始調整；-30 dB 僅作為調試起始值。',
    apply: '套用',
    detectionModeUnavailable: '目前相機韌體未提供檢測模式（work_mode）。',
    activeRecentAlarms: '未確認告警 {count} 條（與右上角告警圖示同一口徑）',
    suggestedMechanicalBand: '2-50 kHz 搜尋範圍 · 目前成像頻寬 <= {limit} kHz',
    bandErrorMissing: '請輸入頻率下限和上限。',
    bandErrorNumeric: '頻率上下限必須為數字。',
    bandErrorRange: '頻率範圍必須位於 2-65 kHz。',
    bandErrorOrder: '頻率上限必須大於頻率下限。',
    bandErrorWidth: '目前設備的有效成像頻寬不能超過 {limit} kHz。',
    imagingSettingsApplied: '成像頻帶和閾值已生效。',
    imagingSettingsRejected: '設備已回應，但寫後讀回值與請求值不一致。',
    modeMismatchTitle: '檢測模式不一致',
    modeMismatchMessage: '即時監測目前設定為「{configured}」，但相機目前檢測模式為「{actual}」。請在「相機控制設定」中確認或修改檢測模式。',
    modeMismatchConfigured: '目前設定',
    modeMismatchCamera: '相機模式',
  modeMismatchAdopt: '使用相機目前模式',
    title: '相機控制',
    refresh: '重新整理',
    modeTitle: '運行方式',
    modeSingle: '單次檢測',
    modeCruise: '智慧巡航',
    modeUnknownHint: '裝置返回的取值手冊沒有定義：1 = 單次檢測，-1 = 智慧巡航。',
    modeRawValue: '裝置返回 {value}',
    modeReadBack: '裝置當前：{value}',
    modeApplied: '已套用',
    modeRejected: '裝置應答成功但沒有生效',
    appModeTitle: '檢測模式',
    appModeCurrent: '裝置當前',
    appModePartialDischarge: '區域性放電',
    appModeGasLeak: '氣體洩漏',
    appModeMechanical: '機械異響',
    appModeUnknownHint: '裝置返回的取值不在實測過的三個之內（1 = 區域性放電，2 = 氣體洩漏，3 = 機械異響）。',
    appModeSourceHint: '此端點未見於設備手冊；切換時只寫檢測模式 work_mode。',
    appModeApplied: '已套用',
    appModeRejected: '裝置應答成功但沒有生效',
    /*
     * 「切換模式」的二次確認（產品負責人指定）。
     *
     * `appModeConfirmBody` 就是產品給的原話，一個字都沒有改。**它不是一條經過驗證的
     * 裝置事實**：手冊把"切換模式會不會打斷檢測"列為未說明，手冊裡唯一一處"刪除全部
     * 歷史資料"說的是**恢復出廠**，本專案實測到的只是"寫 `run_mode` 會清掉啟用策略的
     * 指標"（`docs/FA371-API-DELTA.md` §17）——`work_mode` 會不會清資料 **未驗證**。
     * 詳細的來路記在 `CameraControlPanel.vue` 裡 `pendingWorkMode` 上面的註釋。
     * 要改這句話，先改產品的要求，不要拿它反推裝置行為。
     */
    appModeConfirmTitle: '切換檢測模式',
    /**
     * 產品指定的原話，逐字照發。
     *
     * 不帶 `{mode}` 佔位符是**故意的**：要求的是一模一樣的這一句，把目標模式插進去
     * 就等於改了這句話；「當前是什麼、要切到哪個」由按鈕自己的高亮狀態表達（裝置重讀
     * 值仍然顯示在 `appModeCurrent` 那一行）。四語言之間也不許各寫一套自己的說法。
     */
    appModeConfirmBody: '切換模式會清空全部的儲存資料，是否繼續？',
    appModeConfirmAction: '繼續切換',
    detectTitle: '檢測狀態',
    detectRunning: '檢測中',
    detectStopped: '未檢測',
    detectRetentionHint: '裝置只保留最近 50 條檢測記錄，更早的會被迴圈覆蓋。',
    detectRecord: '記錄號 {id}',
    detectStart: '開始檢測',
    detectStop: '停止檢測',
    detectStopHint: '單次檢測會在策略週期結束時自行停止，那時不必再調停止介面。',
    detectApplied: '已套用',
    detectNotApplied: '裝置狀態沒有按請求改變',
    strategyTitle: '警報策略',
    strategyPeriodHint: '策略週期在策略自身裡配置，範圍 1~30 秒。',
    strategyNoneEnabled: '沒有啟用任何策略',
    strategyEnabled: '已啟用',
    strategyEnable: '啟用',
    strategyDisable: '關閉',
    strategyNoItems: '裝置上還沒有告警策略',
    strategyIdUnusable: '該策略 id 不是整數，無法啟停',
    strategyNeedsOne: '開始檢測前需要先啟用一條告警策略',
    strategyDisabledPrevious: '裝置只允許一條策略啟用，已先停用策略 {previous}',
    strategyApplied: '已套用',
    strategyRejected: '裝置應答成功但沒有生效',
    maintenanceTitle: '維護',
    firmwareVersion: '韌體版本',
    sdkVersion: 'SDK 版本號',
    webVersion: 'Web 介面版本',
    lastUpgrade: '上次升級',
    valueUnavailable: '未讀到',
    valueUnavailableHint: '裝置本次讀取沒有返回這一項。',
    openWebUi: '開啟相機 Web 介面',
    webUiOpened: '已在系統瀏覽器中開啟',
    // `upgrade` 與 `reboot` 兩個標籤在升級實裝那一輪刪掉了：它們屬於**禁用的**
    // 維護按鈕，而那兩個動作現在有了真控制元件，文案在 `cameraUpgradeUi.*` 裡。
    // 留著一份沒人用的"韌體升級/重啟裝置"，只會讓下一個人猜該用哪一個。
    rollback: '版本回滾',
    factoryReset: '恢復出廠',
    reasonNotInOpenInterface: '裝置開放介面沒有這個操作',
    reasonDeviceOffline: '裝置離線',
    adminOnlyHint: '切換模式、啟停檢測、啟停策略需要管理員'
  },

  /**
   * 相機韌體升級（裝置自帶 Web 介面用的那條 HTTP 路：`POST /upload` +
   * `PUT /reboot` + `GET /progress`）。
   *
   * 這一組只出現在相機控制面板的維護區。三段文案是本專案**刻意保留**的說明性文字：
   *   - `uploadConfirmBody` / `rebootConfirmBody`：破壞性動作的**後果**（會發生什麼、
   *     什麼時候開始升級、期間不能做什麼）。確認對話方塊的正文是唯一允許解釋的地方；
   *   - `sourceHint`：一句話說明這些介面的來路（未見於裝置手冊），放在控制元件的 title 上；
   *   - `nameRejectedDetail`：裝置檔名規則的原文 —— 裝置就是用它拒收的。
   * 其餘一律短句，不寫教程。
   */
  cameraUpgradeUi: {
    title: '韌體升級',
    sourceHint: '升級與重啟走的是裝置自帶 Web 介面用的介面（未見於裝置手冊）。',
    pick: '選擇升級包',
    repick: '換一個包',
    packageFile: '升級包',
    packageSize: '檔案大小',
    packageSha256: 'SHA-256',
    packageSuffix: '檔名字尾',
    sha256Hint: '請與廠家釋出該版本時給出的校驗值核對，再決定是否上傳。',
    nameAccepted: '檔名符合裝置要求',
    nameRejected: '檔名不符合裝置要求，裝置會拒收這個包',
    nameRejectedDetail: '裝置要求：按 "_" 切開的最後一段必須是 V 加三段數字，例如 _v2.0.11（當前是 {suffix}）。',
    upload: '上傳升級包',
    uploading: '正在上傳 {percent}%',
    uploadConfirmTitle: '上傳升級包到裝置',
    uploadConfirmBody: '包會被寫入裝置（{size}）。上傳期間不要斷電、不要斷網。上傳完成後裝置不會自動重啟，什麼時候開始升級由你另外決定。',
    uploadConfirm: '開始上傳',
    uploaded: '升級包已上傳，裝置尚未升級',
    uploadedHint: '需要重啟裝置才會開始升級：請再點「重啟裝置」。',
    uploadDoneAt: '上傳用時 {duration}',
    deviceProgressTitle: '裝置升級進度',
    deviceProgressRead: '讀取裝置進度',
    deviceProgressValue: '裝置返回 {value}',
    deviceProgressUnknown: '該數值的含義裝置沒有文件說明，因此這裡不做換算。',
    deviceProgressNotRead: '未讀到',
    reboot: '重啟裝置',
    rebootConfirmTitle: '重啟裝置',
    rebootConfirmBody: '裝置會立即重啟：正在進行的檢測會中斷，連線會短暫斷開。若升級包已上傳，重啟之後裝置才開始升級，升級期間同樣不要斷電、不要斷網。',
    rebootConfirm: '重啟',
    rebooting: '正在重啟…',
    rebootAcknowledged: '重啟指令已發出，裝置已回執',
    rebootDropped: '重啟指令已發出，裝置未回執（重啟時連線斷開是正常現象）'
  },

  cameraWallUi: {
    layoutGroup: '分屏檔位',
    layoutLabel: '{count} 分割畫面',
    pickDevice: '選擇相機',
    // 浮層裡一臺可選的相機都沒有時的那一行（其它格已經把它們都佔了）。
    viewPlay: '開始播放',
    viewTimedomain: '時域圖',
    viewSpectrum: '頻域圖',
    viewSpectrogram: '時頻譜圖',
    viewWaiting: '等待資料…',
    viewNeedsCamera: '第三方 RTSP 源只有畫面',
    viewSpectrogramNote: '顏色只表示同一幀內譜線的相對強弱',
    viewStreamError: '聲學資料這一路打不開',
    /** 同一 (相機, 檢視) 全牆唯一（業主 20260921 批第 1 條：相同內容只允許出現一次）。 */
    viewAlreadyShown: '該內容已在此相機的其它視窗顯示（相同內容只允許出現一次）',
    /** 選擇器裡已經上牆的 (相機, 檢視) 組合角標。 */
    viewInUse: '已在視窗',
    /** 輪詢指示器：{shown} 當前在屏的路數 / {total} 全部路數（含排隊）。 */
    rotationIndicator: '輪詢 {shown}/{total}',
    rotationPauseTitle: '暫停輪詢',
    rotationResumeTitle: '繼續輪詢',
    /** 格子全滿時新放進去的內容進輪詢佇列（{position} = 佇列位置）。 */
    queuedNotice: '視窗已滿，已加入輪詢佇列（第 {position} 個）',
    manualTitle: '第三方相機（手填 RTSP）',
    manualNote: '手冊未說明第三方 RTSP 接入：地址按原樣交給內建 ffmpeg，本機只判形狀、不判能不能連上（連不上時畫面格會顯示 ffmpeg 的原文）。地址只在本次執行內有效 —— 它常帶口令，不寫盤。',
    manualWhere: '放進畫面格在總覽頁的影片牆裡：點一格，在列表裡選它。',
    manualName: '名稱',
    manualNameHint: '留空就用地址裡的主機名',
    manualUrl: 'RTSP 位址',
    manualUrlPlaceholder: 'rtsp://192.168.1.64:554/Streaming/Channels/101',
    manualSave: '新增',
    manualUpdate: '儲存修改',
    manualList: '已新增的手填源',
    manualEmpty: '還沒有手填的地址。',
    manualEdit: '編輯',
    manualDelete: '刪除',
    manualAtCapacity: '最多 {max} 條手填源。',
    manualSuffix: '手動輸入 RTSP',
    manualMissing: '這條手填 RTSP 源已經不在列表裡了',
    manualIssueEmpty: '請填寫 RTSP 地址',
    manualIssueScheme: '地址必須以 rtsp:// 或 rtsps:// 開頭',
    manualIssueHost: '地址裡沒有主機名',
    manualIssueWhitespace: '地址裡不能有空格',
    manualIssueControl: '地址裡不能有換行或控制字元',
    manualIssuePort: '埠需在 1-65535 之間',
    manualIssueTooLong: '地址太長',
    pickNoOption: '沒有可選的相機',
    replaceDevice: '更換相機',
    noCamera: '還沒有新增聲學相機',
    assignToCell: '放入這一格',
    statusIdle: '未開始',
    statusStarting: '正在啟動…',
    statusPlaying: '正在播放',
    statusRtspDisabled: 'RTSP 未啟用',
    statusFfmpegMissing: '找不到 ffmpeg 程式',
    statusError: '流錯誤',
    statusLimitExceeded: '超過併發上限',
    statusAlreadyShown: '該相機已在另一格',
    statusDeviceRemoved: '裝置已刪除',
    statusDeviceOffline: '裝置離線',
    start: '開始',
    stop: '停止播放',
    /**
     * 播放器控制條上那一顆（業主 2026-09-19 第 12 批給的控制條清單裡有「暫停」）。
     *
     * **動作沒變**：它仍然是 `toggleCell()` —— 停掉這一路的 RTSP 會話，再按一次重新起流。
     * RTSP 直播沒有真正的"暫停"（流不會等你），所以這裡的「暫停」= 停止這一路直播，
     * 這一點寫在 `docs/Ivms4200-UX-REFERENCE.md` §15.74，介面不假裝畫面停住了而流還在跑。
     */
    play: '開始播放',
    pause: '暫停',
    retry: '重試',
    fullscreen: '全螢幕',
    exitFullscreen: '離開全螢幕',
    audioOn: '開啟聲音',
    audioOff: '關閉聲音',
    // 控制條上那顆音量按鈕自己的名字（點它才彈出豎條）。
    volume: '音量大小',
    // 豎條滑桿的名字：業主說的"音量大小"，上下拖動調節。
    volumeLevel: '聲音大小',
    // 控制條上那顆「切換錄影」（= 右鍵選單裡的"回放本機錄影"，同一個彈窗）。
    cellPlayback: '切換錄影',
    // 控制條上那顆「告警」（= 右鍵選單裡的"告警配置"，同一個對話方塊）。
    cellAlarm: '警報設定',
    // 這一格沒有畫面時音量圖示與滑桿**禁用**，它們的名字直接說出禁用的原因。
    volumeNoPicture: '這一格沒有畫面，無法出聲',
    activeBadge: '當前格',
    /*
     * 這一輪刪掉的詞條（四處目錄同步刪除，刪除理由寫在這裡，其餘三處只跟刪）：
     *   cellEmpty       空白格上只有一個 `+`，一個字都不寫；
     *   idleHint        「未開始」的徽標已經說完，長句子是解釋而不是狀態；
     *   removingDevice /
     *   offlineDevice   裝置被刪/離線現在只顯示短狀態詞，哪一臺由疊加條上的名字回答；
     *   noCameraHint    同一件事標題行已經說過，而且「請先在裝置管理中新增」是說明；
     *   setActive       本來就沒有任何地方渲染它；
     *   streamError     同上（格子上的診斷原文來自主程序，不來自這條詞）；
     *   pickPlaceholder 原生 `<select>` 的第一個 `<option>`（「請選擇相機」）。
     *                   選擇器改成自己畫的浮層之後它沒有讀者了：浮層的無障礙名字來自
     *                   `pickDevice`，清單為空那一行是新增的 `pickNoOption`
     *                   （業主 2026-09-18 報的那個「彈出來看不見」的 bug，見
     *                   `CameraCellPicker.vue`）。
     */
    limitNotice: '同時直播上限為 {max} 路，當前 {active} 路。再開一路會超過上限，請先停掉另一格。',
    layoutShrunk: '分屏檔位變小，{count} 個畫面格的直播已停止。'
  },
  /**
   * 系統訊息 —— 頂欄那顆告警圖示後面的面板裡，**應用級**失敗那一段（業主 2026-09-18）。
   *
   * 口徑寫在 `stores/appNotices.ts` 的檔案頭：應用級失敗（裝置列表/設定/告警列表讀不出來、
   * 認證失敗……）進這裡，頁面自己的就地反饋（表單校驗、點一下的結果）不進來。面板是浮層，
   * 所以這些內容的出現與消失**不改變佈局** —— 這正是業主那句話的後半句。
   */
  noticesUi: {
    title: '系統訊息',
    clearAll: '清除全部通知',
    dismiss: '忽略這條系統訊息',
    /*
     * 告警圖示按鈕的無障礙名字（有系統訊息時）。角標裡的**數字**仍然只是待處理告警條數
     * （與面板裡那份列表同源），系統訊息用這個句子說出來，兩者不相加。
     */
    bellWithProblems: '{count} 條系統訊息 · 待處理告警'
  },

  /**
   * 告警本地聯動（錄影 / 彈窗 / 提示 / 郵件）。
   *
   * 與其它目錄同一條規則：**任何一條訊息都不得包含 `@`**
   * （vue-i18n 的 linked-message 訊號；含 `@` 的訊息在渲染時編譯失敗，
   * `tests/i18n.test.ts` 會編譯每一條訊息並把這種失敗變成測試失敗）。
   * 本組裡有郵箱相關的說明文字，寫「郵箱地址」而不是示例地址，
   * 正是為了不引入 `@`。
   */
  linkage: {
    popupTitle: '告警連動',
    popupInfo: '{device} 觸發提示級告警（等級 {level}）',
    popupWarning: '{device} 觸發告警（等級 {level}）',
    popupCritical: '{device} 觸發嚴重告警（等級 {level}）！',
    title: '告警聯動',
    enabled: '啟用告警聯動',
    enabledOn: '已啟用',
    enabledOff: '已關閉',

    sourceSection: '觸發源',
    pollInterval: '輪詢間隔（秒）',
    useDetectFeedback: '啟用檢測反饋流加速器',
    cameraPushEnabled: '接收相機主動推送的告警（HTTP）',
    cameraPushPort: '推送接收埠',
    minAlarmLevel: '最低告警等級',
    sourcePoll: '輪詢檢測日誌',
    noRecordingNoAction: '這條告警沒有留下錄影動作的結果（這一條可能是在錄影那一路跑完之前就被確認了）。',
    noRecordingFailed: '本機聯動錄影失敗了',
    noRecordingSkipped: '本機聯動錄影這一次被跳過（冷卻中，或錄影動作沒啟用）',
    sourceWebsocket: '檢測反饋流',
    sourcePush: '相機推送',
    sourceRunning: '執行中',
    sourceStopped: '已中止',
    sourceLastPoll: '最近一次輪詢',
    sourceLastError: '最近一次錯誤',
    sourceTriggers: '已觸發',
    sourceFrames: '已收到幀',
    sourceNoFrames: '至今 0 幀（該事件流從未推送過資料）',

    actionSection: '動作開關',
    action: {
      record: '錄影',
      popup: '彈窗',
      notice: '提醒',
      email: '郵件'
    },
    actionState: {
      success: '已完成',
      failed: '失敗',
      skipped: '已跳過'
    },

    recordSection: '錄影',
    recordDuration: '錄影時長（秒）',
    recordCooldown: '冷卻時間（秒）',
    recordSkipBusy: '正在錄影時跳過',

    popupSection: '彈窗',
    popupAutoDismiss: '自動關閉（秒）',
    popupCooldown: '冷卻時間（秒）',
    popupMaxStack: '同時最多幾個',

    noticeSection: '提醒',
    noticeCapacity: '保留條數',

    /**
     * 郵件**伺服器**那一塊已經搬到 `emailUi`（手冊 §17.2.8 的獨立標籤頁）。
     * 這裡只留**聯動側**的兩個欄位，它們的標題也隨之下移。
     */
    emailActionSection: '郵件動作',
    emailHostPlaceholder: '範例 smtp.example.com',
    emailPasswordPlaceholder: '留空表示保持已儲存的口令不變',
    emailPasswordStored: '已儲存口令',
    emailPasswordNotStored: '未儲存口令',
    emailPasswordClearHint: '填一個空格並儲存可清除口令',
    emailSubject: '主題模板',
    emailBody: '內容範本',
    emailAttachFrame: '附帶抓幀',
    emailCooldown: '冷卻時間（秒）',
    emailTesting: '正在傳送…',
    emailTestOk: '測試郵件已送達 SMTP 伺服器（{count} 個收件人）',
    emailTestFailed: '測試郵件傳送失敗：{reason}',
    emailTestAttach: '測試附件',
    emailTestAttachNone: '不帶附件',
    emailTestAttachSynthetic: '內建測試圖片',
    emailTestAttachCamera: '相機當前畫面',
    emailTestPrompt: '請先儲存設定，測試郵件使用的是儲存後的伺服器與模板。',

    runtimeSection: '頻率上限',
    maxActionsPerMinute: '全域性上限（次/分鐘）',
    cooldownPeriod: '冷卻視窗（秒）',
    cooldownPerPeriod: '視窗內上限（次）',
    cooldownPerInterface: '每個時間片上限（次）',
    windowUsage: '本視窗已用 {used} / {limit}',

    bellTitle: '告警：{count} 條未確認',
    deviceAlarmsTitle: '裝置告警',
    deviceAlarmsEmpty: '當前沒有未確認的裝置告警',
    deviceAlarmAcknowledge: '確認',
    deviceAlarmsMore: '另有 {count} 條未列出（到「告警中心」看全部）',
    pendingTitle: '待處理告警',
    pendingEmpty: '當前無告警',
    pendingAcknowledge: '確認',
    pendingAcknowledgeAll: '全部確認',
    pendingAcknowledged: '已確認',
    pendingDropped: '有 {count} 條更早的告警因超出保留上限被丟棄',
    pendingLevel: '等級',
    metricIntensity: '聲場強度 {value} dB',
    metricDf: '主頻 {value} Hz',
    metricVolume: '洩漏量 {value}',
    metricLeakCost: '洩漏價格 {value}',
    dischargeType: {
      corona: '電暈放電',
      suspension: '懸浮放電',
      surface: '沿面放電',
      discharge: '放電'
    },
    pendingStrategy: '連動策略',
    pendingNoActions: '本次沒有執行任何動作',
    pendingEngineOff: '告警聯動當前是關閉的',
    pendingShow: '顯示待處理告警',

    adminOnly: '修改告警聯動配置、傳送測試郵件與確認告警需要管理員賬戶。',
    loadFailed: '讀取告警聯動狀態失敗',
    statusTriggers: '本次執行已觸發 {count} 次',
    statusActions: '已執行動作 {count} 次'
  },

  /**
   * 事件與告警中心（`/events`）。
   *
   * 與 `linkage` 同一硬規則：**任何一條訊息都不得包含 `@`**
   * （vue-i18n 的 linked-message 訊號；含 `@` 的訊息渲染時編譯失敗，
   * `tests/i18n.test.ts` 會編譯每一條訊息並把這種失敗變成測試失敗）。
   *
   * 文案裡反覆出現「等級未知」「近似時間」「裝置沒有給時間」，是刻意的：
   * 相機手冊把 `alarm_level` 列在欄位表裡卻從未在真機出現過（§8.3 C15），
   * 時間戳單位也從未宣告（§8.3 C19），所以介面必須說清哪些值是裝置給的、
   * 哪些是按假設換算的，而不是把它們畫成確定的事實。
   */
  eventsUi: {
    countSummary: '本次篩選命中 {total} 條事件',
    truncated:
      '本次結果不完整：某路來源的讀取被截斷（每路來源最多讀取 {cap} 條），或者更早的告警已被引擎丟棄；下方「來源讀況」寫明瞭各截掉多少條。',
    emptyTitle: '沒有任何事件上報',
    emptyFilteredTitle: '當前篩選條件下沒有事件',

    sourcesTitle: '來源讀況',
    sourceOk: '讀到 {count} 條',
    sourceFailed: '讀取失敗：{reason}',
    sourceTruncated: '已截斷 {count} 條',
    sourceUntimed: '其中 {count} 條裝置沒有給時間',

    filterDevice: '裝置',
    filterAllDevices: '全部裝置',
    filterSource: '來源',
    filterAllSources: '全部來源',
    filterSeverity: '等級',
    filterAllSeverities: '全部等級',
    filterFrom: '開始時間',
    filterTo: '結束時間',
    filterAck: '確認狀態',
    ackAll: '全部確認',
    ackUnacknowledged: '未確認',
    ackAcknowledged: '已確認',

    approximateBadge: '近似時間',
    approximateHint:
      '相機介面沒有宣告時間戳單位，本頁按秒解讀裝置時間，因此換算結果是近似值。',
    timeUnknown: '裝置沒有提供這條日誌的時間，列表按讀取時刻排序。',

    detailTitle: '事件詳情',
    detailEventId: '事件標識',
    detailDevice: '裝置',
    detailSource: '來源',
    detailKind: '類型',
    detailSeverity: '等級',
    detailDeviceTime: '裝置原始時間戳',
    detailDeviceTimeUnit: '解讀單位',
    detailSavingPath: '裝置目錄',
    detailLogId: '檢測日誌編號',
    detailDetectMode: '檢測模式（原始值）',
    detailAlarmLevel: '裝置告警等級（原始值，未換算）',

    detailFilesTitle: '檢測結果檔案（裝置側動作）',
    detailDetectTitle: '檢測日誌詳情',
    detailFilesEmpty: '這條檢測日誌沒有可用的結果檔案',
    detailFileDownload: '下載',
    detailFileDownloading: '正在下載…',
    detailFileDownloaded: '已下載',
    detailFilePlay: '開始播放',
    detailFileOpenVideo: '開啟影片',
    detailDownloadNeedAdmin: '下載結果檔案需要管理員賬戶',
    detailSourceUnavailable: '這一路來源本次讀取失敗，請稍後重試',

    detailAck: '確認該事件',
    detailAckUnsupported:
      '相機側的檢測日誌沒有確認介面（手冊的 32 個開放介面裡沒有），因此這一條不能確認。',

    detailRecordingTitle: '本機錄影與畫面',
    detailRecordingNone: '這條事件在本機沒有對應的錄影檔案。',
    detailRecordingPending: '這條檢測的結果檔案還沒有下載，因此本機沒有可播放的檔案。',
    detailRecordingVideoUnavailable: '無法播放這段錄影（本地檔案不存在或不是影片）。',
    detailRecordingGoto: '前往錄音檔案頁',
    detailFrameTitle: '聯動抓幀',

    detailMetricsTitle: '指標',
    metricSoundmapIntensity: '聲場強度',
    metricLeakVolume: '洩漏量',
    metricLeakCost: '洩漏成本',
    detailActionsTitle: '聯動動作',
    detailActionLine: '{action}：{status}',
    detailActionReason: '緣由：{reason}',

    detailLocalAlarmChannel: '聲道',
    detailLocalAlarmTypes: '告警型別',

    downloadDone: '已下載 {name}（{size}）',

    // --- Phase 3：KPI 條 / 篩選 / 告警佇列（規格 §8–§10） --------------------
    // 規格的五檔都給出中文名：`medium` / `low` 現在沒有程式碼路徑能產生（介面不渲染它們，
    // 見 `VISIBLE_ALERT_SEVERITIES`），但 `AlertSeverity` 是完整型別 —— 少兩個名字，
    // Phase 5 把五級存進庫的那天就會渲染出裸 key。
    alertSeverity: {
      critical: '嚴重',
      high: '嚴重',
      medium: '中等',
      low: '輕微',
      info: '提醒'
    },
    alertStatus: {
      new: '待處理',
      acknowledged: '已確認',
      investigating: '調查中',
      resolved: '已解決',
      closed: '已關閉',
      muted: '已靜默',
      reopened: '重新開啟'
    },
    severityUnknown: '等級未知',

    kpiUnacknowledged: '未確認',
    kpiAvgAck: '平均確認耗時',
    kpiScope: 'KPI 與計數按已載入的 {loaded} 條統計（本次結果 {total} 條）',

    viewMode: {
      compact: '緊湊',
      standard: '標準',
      evidence: '證據'
    },

    searchPlaceholder: '搜尋裝置、事件、指標',
    filterTimeRange: '時間範圍',
    searchScope: '搜尋只在已載入的 {loaded} 條裡生效',

    savedViewTitle: '檢視',
    savedView: {
      all: '全部項目',
      critical: '嚴重',
      high: '嚴重',
      unacknowledged: '未確認',
      last24h: '近 24 小時',
      last7d: '最近 7 天'
    },

    filterPanelTitle: '篩選',
    filterPanelToggle: '篩選面板',
    panelCount: '{count} 條',
    panelScope: '計數按已載入的 {loaded} 條',
    clearFilters: '清除全部條件',

    evidenceRecording: '錄影',
    evidenceFrame: '抓幀',
    evidenceFiles: '{count} 個檔案',
    metricMore: '另有 {count} 項',

    // --- Phase 4：詳情抽屜 / Overview / Evidence（規格 §11–§12） --------------
    // 五個頁籤都給名字：Timeline / Related / Activity 要到 Phase 5 才渲染，
    // 但頁籤型別是完整的 —— 少一個名字，那天就會印出裸 key。
    detailTab: {
      overview: '概覽',
      evidence: '證據',
      timeline: '時間線',
      related: '關聯',
      activity: '活動'
    },
    colIndex: '序號',
    overviewStatus: '狀態',
    overviewFirstDetected: '首次探測',
    overviewLastDetected: '最後探測',
    overviewDuration: '持續時長',
    overviewOccurrences: '次數',
    drawerResize: '拖動調整抽屜寬度',

    evidenceVisualTitle: '畫面與圖片',
    evidenceExpand: '放大檢視',
    evidenceExpandTitle: '證據 · 放大檢視',
    evidenceNone: '這條事件沒有圖片證據。',
    evidenceNotCaptured: '裝置上沒有抓到圖（同步時可能沒有開啟抓圖下載）。',
    evidenceFilesGone: '庫裡記著這份圖，但本機磁碟上已經沒有了。',
    evidenceNotImage: '這份檔案在，但不是能顯示的圖片格式。',
    evidenceNotFound: '找不到這份圖片證據的路徑。',
    evidenceError: '讀取圖片證據失敗。',

    // --- Phase 5：狀態機 / 處置動作 / Activity / Timeline / Related（§2.2、§13）--
    actionInvestigate: '開始調查',
    actionResolve: '標記已解決',
    actionClose: '關閉',
    actionReopen: '重新開啟',
    actionMute: '靜默',
    actionUnmute: '取消靜默',
    actionAssign: '分派',

    activityKind: {
      status: '狀態變更',
      assign: '分派',
      note: '說明'
    },


    relatedSameDevice: '同一臺裝置',    relatedSameKind: '同一種事件',
    relatedTimeWindow: '前後 10 分鐘',

    // --- Phase 5（介面）：動作 / 時間線 / 相關性 / 處置記錄 -------------------
    relatedTitle: '關聯事件',
    relatedScope: '相關性只在已載入的 {loaded} 條裡找',
    relatedEmpty: '沒有找到相關的其它事件。',
    relatedOpen: '檢視這一條',

    /*
     * --- Phase 6 後半（規格 §13.2 的建議卡 + §14.2 的 V1）---------------------
     *
     * 「Incident」這個詞**不翻譯**：規格全篇用的是它（§2.1 把它與 Event / Alert 並列定義），
     * 中文裡沒有一個既準確又不會與"告警""事件"混淆的詞 —— 翻成"事件"會和我們自己的
     * 「事件」撞車，翻成"故障單"則加了規格沒有的含義。
     */
    incidentTitle: 'Incident 關聯',
    /*
     * 建議閾值就地可調（業主 2026-09-18：「可以設定為可調整的」）。規格 §13.2 只說
     * "當相關性達到閾值時"，閾值本身手冊未說明 —— 所以由操作員在這幾個離散檔位裡選。
     */
    incidentThreshold: '建議閾值',
    incidentThresholdOption: '{count} 條',
    incidentBelowThreshold: '同裝置上還有 {related} 條其它告警，未到閾值（{count} 條），因此沒有給建議。',
    incidentNone: '這一條還沒有關聯任何 Incident。',
    incidentAlertCount: '{count} 條關聯告警',
    incidentUnlink: '解除關聯',
    incidentSuggestionLabel: '可能相關的 Incident',
    incidentSuggestionCount: '{count} 條相關告警',
    incidentSuggestedTitle: '{device} 異常情況',
    incidentCreate: '建立 Incident',
    incidentLinkExisting: '關聯到已有 Incident',
    incidentCreated: '已建立「{title}」，關聯了 {count} 條告警',
    incidentLinked: '已關聯 {linked} 條（另有 {already} 條本來就在裡面）',
    incidentUnlinked: '已解除與「{title}」的關聯',
    incidentFailed: '這個操作沒有成功。',
    incidentDialogTitle: 'Incident',
    incidentModeLabel: '怎麼做',
    incidentModeCreate: '新增 Incident',
    incidentModeLink: '關聯到已有',
    incidentFieldTitle: '標題',
    incidentTitlePlaceholder: '例如：1 號風機異常情況',
    incidentTitleHint: '最多 {max} 個字',
    incidentFieldNote: '備註（可選）',
    incidentFieldExisting: '選擇 Incident',
    incidentCandidates: '一併關聯這些告警（{count} 條）',
    incidentNoCandidates: '沒有可一併關聯的告警 —— 只建立 Incident 本身。',
    incidentNoExisting: '還沒有已建的 Incident',
    incidentSubmitCreate: '建立並關聯',
    incidentSubmitLink: '關聯',
    incidentSubmitting: '正在寫入…',
    incidentReasonTitleRequired: '標題不能為空',
    incidentReasonTitleTooLong: '標題太長（上限 {max} 字）',
    incidentReasonNoteTooLong: '備註太長（上限 {max} 字）',
    incidentReasonNoExisting: '先選一個 Incident',
    incidentReasonNoAlerts: '至少要選一條告警',

    timelineTitle: '時間線',
    timelineDetected: '首次探測到',

    activityTitle: '處置記錄',
    activityEmpty: '這一條還沒有任何處置記錄。',
    activityStatusLine: '{actor} 把狀態從「{from}」改為「{to}」',
    activityAssignLine: '{actor} 指派給 {name}',
    activityNoteLine: '{actor} 的留言',
    statusChangeDone: '狀態已改為「{status}」',
    assignDone: '已指派給 {name}',
    actionAssignee: '指派給',
    actionNote: '新增說明',
    actionReopenNotePlaceholder: '重新開啟的原因（必填）',
    actionNoteEmpty: '請先填寫原因',
    actionConfirm: '確定',
    actionCancel: '撤銷',

    // --- Phase 6：重複觸發聚合（規格 §14.1）---------------------------------
    groupWindowLabel: '聚合方式',
    groupWindow: {
      off: '不進行聚合',
      m10: '10 分鐘內',
      m30: '30 分鐘內',
      h1: '1 小時內'
    },
    occurrenceCount: '×{count}',
    timelineOccurrence: '第 {index} 次觸發',
    statusChangeDoneMany: '已把 {count} 次觸發的狀態改為「{status}」'

  }
}
