/**
 * Turkish.
 *
 * Typed against `MessageSchema`, derived from the Chinese reference locale.
 *
 * TWO TURKISH-SPECIFIC POINTS WORTH KNOWING
 *  1. Turkish is agglutinative and vowel-harmony-sensitive, so a sentence cannot
 *     be assembled by gluing translated fragments together. Every message below
 *     is a whole sentence, and placeholders sit where a native sentence wants
 *     them rather than where the Chinese or English source had them.
 *  2. The dotted/dotless i distinction (İ/i vs I/ı) is a real orthography rule,
 *     not a font quirk: `Dil` is correct, `DİL` would read as a typo to a native
 *     speaker. Locale-aware case handling (`toLocaleUpperCase('tr')`) is used
 *     wherever the code upper-cases a label.
 */

import type { MessageSchema } from '../schema'

export const tr: MessageSchema = {
  /**
   * Sol kenar çubuğundaki cihaz ağacı (topoloji + seçim).
   *
   * `cameraLiveUi` ile aynı katı kural: **bu bloktaki hiçbir mesaj `@` içeremez**
   * (vue-i18n'in bağlantılı mesaj imi; render sırasında derlenmez ve
   * `tests/i18n.test.ts` her mesajı derler).
   */
  deviceTreeUi: {
    empty: 'Henüz cihaz yok',
    filterLabel: 'Cihazları filtrele',
    filterPlaceholder: 'Ada veya adrese göre filtrele…',
    filterClear: 'Filtreyi temizle',
    filterEmpty: '"{query}" ile eşleşen cihaz yok',
    expandAll: 'Tümünü aç',
    collapseAll: 'Tümünü kapat',
    expandNode: 'Bu öğeyi aç',
    collapseNode: 'Bu öğeyi kapat',
    openInWall: 'Video duvarında aç',
    statusOnline: 'Çevrimiçi',
    statusOffline: 'Çevrimdışı',
    statusUnknown: 'Durum bilinmiyor',
    kindBox: 'Akustik cihaz',
    kindCamera: 'Akustik kamera',
    cameraStreamNode: 'Canlı video',
    channelsUnavailable: 'Kanal tablosu henüz okunmadı',
    renameDevice: 'Cihaz adını değiştir',
    renameChannel: 'Kanal adını değiştir'
  },

  common: {
    confirm: 'Onayla',
    cancel: 'İptal',
    save: 'Kaydet',
    saving: 'Kaydediliyor…',
    delete: 'Sil',
    edit: 'Düzenle',
    close: 'Kapat',
    refresh: 'Yenile',
    reset: 'Sıfırla',
    loading: 'Yükleniyor…',
    none: 'Yok',
    unknown: 'Bilinmiyor',
    clearSelection: 'Seçimi temizle',
    viewAll: 'Tümünü gör',
    unit: {
    }
  },

  errors: {
    DEVICE_OFFLINE: 'Cihaz çevrimdışı ve erişilemiyor',
    TIMEOUT: 'İstek zaman aşımına uğradı. Ağı veya cihazı kontrol edin.',
    AUTH_FAILED: 'Kimlik doğrulama başarısız. Kullanıcı adını ve parolayı kontrol edin.',
    INVALID_RESPONSE: 'Cihaz tanınmayan bir biçimde veri döndürdü',
    DEVICE_ERROR: 'Cihaz bir hata bildirdi',
    STORAGE_ERROR: 'Yerel depolama işlemi başarısız oldu',
    DISK_FULL: 'Disk alanı yetersiz; zorunlu olmayan kayıt duraklatıldı',
    NETWORK_ERROR: 'Ağ bağlantısı başarısız oldu',
    VALIDATION_ERROR: 'Girilen değerler geçerli değil',
    NOT_IMPLEMENTED: 'Bu özellik kullanılamıyor',
    UNKNOWN: 'Bilinmeyen bir hata oluştu',
    fallback: 'İşlem başarısız oldu',
    deviceDetail: 'Cihaz yanıtı: {detail}',
    withCode: '{message} ({code})',
    bridgeUnavailable: 'Ana sürece ulaşılamıyor. Uygulamayı yeniden başlatın.',
    bridgeUnavailableDetail: '{message}: {detail}',
    FORBIDDEN: 'Bu hesabın söz konusu işlemi yapma yetkisi yok',
    AUTH_USERNAME_TAKEN: 'Bu kullanıcı adı zaten alınmış',
    AUTH_LAST_ADMIN: 'En az bir yönetici hesabı kalmalıdır',
    AUTH_PASSWORD_POLICY: 'Parola koşulları karşılamıyor (en az 8 karakter, kullanıcı adı içermemeli, başında ve sonunda boşluk olmamalı)',
    AUTH_LOCKED: 'Çok fazla başarısız giriş denemesi. Lütfen kısa süre sonra tekrar deneyin.',
    authLockedRetry: 'Çok fazla başarısız giriş denemesi. {seconds} saniye sonra tekrar deneyin.'
  },

  language: {
    label: 'Arayüz dili',
    description: 'Değişiklik hemen uygulanır ve seçiminiz hatırlanır.'
  },

  app: {
    title: 'HERTZINNO Acoustic Box Manager',
    tagline: 'Cihaz yönetim yazılımı',
    /** Kenar çubuğunu daraltma düğmesi (olay merkezi şartnamesi §3.2). */
    collapseSidebar: 'Kenar çubuğunu daralt',
    expandSidebar: 'Kenar çubuğunu genişlet',
    nav: {
      overview: 'Genel bakış',
      devices: 'Cihazlar',
      monitor: 'Canlı izleme',
      trends: 'Eğilimler',
      alarms: 'Alarmlar',
      /** Cihaz haritası (8. parti): kayıtlı WGS84 noktaları ve alarm görüntüleri. */
      map: 'Cihaz haritası',
      events: 'Olay ve alarm merkezi',
      recordings: 'Kayıtlar',
      samples: 'Örnek kitaplığı',
      settings: 'Ayarlar',
      protocolLab: 'Protokol laboratuvarı',
      deviceDetail: 'Cihaz ayrıntıları'
    },
    versionFallback: 'Sürüm —',
    footerCopyright: 'Telif hakkı © {year} HERTZINNO',
    mainNavigation: 'Ana gezinme',
    releasedOn: "{date} tarihinde yayımlandı",
    builtOn: "{date} tarihinde derlendi",
    appVersion: "Uygulama sürümü",
    releaseDate: "Yayın tarihi",
    buildDate: "Derleme tarihi",
    operatingSystem: "İşletim sistemi",
    databasePath: "Veritabanı yolu",
    storageRootPath: "Depolama kökü",
    copyPath: "Kopyala",
    copiedPath: "Kopyalandı"
  },

  settingsUi: {
    saveButton: 'Ayarları kaydet',
    revert: 'Değişiklikleri geri al',
    loadFailedTitle: 'Ayarlar okunamadı',
    reload: 'Yeniden dene',

    /** Sekmeler (mal sahibi 2026-09-17 ③: dil / depolama / video / alarmlar / e-posta / hesap / hakkında). */
    tabLanguage: 'Dil',
    tabStorage: 'Depolama',
    tabVideo: 'Video ve tampon',
    tabAlarm: 'Alarmlar',
    tabEmail: 'E-posta',
    tabAccount: 'Hesap',
    tabAbout: 'Hakkında ve bakım',

    /** Depolama sekmesindeki grup başlığı. */
    storageGroupLocation: 'Konum ve saklama',
    /** Tek grup: cihaz yoklaması + halka tampon (mal sahibi ④ bunların birleştirilmesini istedi). */
    probeBufferGroup: 'Cihaz yoklaması ve tampon',
    /** Hesap sekmesindeki grup başlığı. */
    accountSessionGroup: 'Geçerli oturum',


    storagePath: 'Depolama yolu',
    picking: 'Seçiliyor…',
    browse: 'Gözat…',
    retentionDays: 'Kayıt saklama süresi (gün)',
    minFreeGb: 'Ayrılan boş alan (GB)',

    healthCheckMs: 'Sağlık denetimi aralığı (ms)',
    offlineThreshold: 'Çevrimdışı için hata sayısı',
    requestTimeoutMs: 'İstek zaman aşımı (ms)',

    preAlarmSeconds: 'Alarm öncesi kayıt (sn)',
    postAlarmSeconds: 'Alarm sonrası kayıt (sn)',
    ringBufferSeconds: 'Toplam arabellek süresi (sn)',

    liveSection: 'Canlı görüntü',
    autoPlayCameraLive: 'Uygulama açıldığında otomatik oynat',
    autoPlayOn: 'Açık',
    autoPlayOff: 'Kapalı',

    diskSection: 'Disk kullanımı',
    diskBelowFloor: 'Boş alan güvenlik eşiğinin altında olduğu için zorunlu olmayan kayıt durduruldu. Diskte yer açın veya «Ayrılan boş alan» değerini düşürün.',
    diskUnavailable: 'Disk bilgileri henüz okunmadı.',
    diskBarLabel: 'Disk %{percent} kullanımda',
    diskUsedOfTotal: 'Kullanılan / toplam',
    diskUsedValue: '{used} / {total} (%{percent})',
    diskFree: 'Boş alan',
    diskFreeValue: '{bytes} ({gb})',
    diskAppUsage: 'Bu uygulamanın kullanımı',
    diskAppUsageValue: '{bytes} (yaklaşık %{percent})',

    trendSection: 'Eğilim depolama',
    trendFlushing: 'Yazılıyor…',
    trendFlushNow: 'Şimdi yaz',
    trendUnavailable: 'Eğilim depolama durumu henüz okunmadı.',
    trendBuffered: 'Arabellekteki satır',
    trendFilesWritten: 'Yazılan dosya',
    trendRowsWritten: 'Yazılan satır',
    trendLastFlush: 'Son yazma',
    trendNeverFlushed: 'Henüz yazılmadı',
    trendLastError: 'Son hata',
    trendWrote: '{rows} satır, {files} dosyaya yazıldı',
    trendNothing: 'Arabellek boş; yazılacak veri yok',
    rows: '{count} satır',
    files: '{count} dosya',


    saveFailed: 'Kaydedilemedi',
    saveSuccess: 'Ayarlar kaydedildi',
    copyFailed: 'Kopyalanamadı. Metni seçip elle kopyalayın.',
    browsePicked: 'Yeni depolama yolu seçildi. Uygulamak için «Ayarları kaydet» düğmesine basın.',
    errStorageRoot: 'Depolama yolu zorunludur',
    errRetentionDays: 'Saklama süresi en az 1 gün olan bir tam sayı olmalıdır',
    errMinFree: 'Ayrılan boş alan negatif olamaz',
    errHealthCheck: 'Sağlık denetimi aralığı en az 1000 ms olmalıdır',
    errOfflineThreshold: 'Çevrimdışı eşiği en az 1 olan bir tam sayı olmalıdır',
    errRequestTimeout: 'İstek zaman aşımı en az 1000 ms olmalıdır',
    errAlarmWindows: 'Alarm öncesi ve sonrası kayıt negatif olamaz',
    errRingBuffer: 'Halka arabellek süresi en az 1 saniye olan bir tam sayı olmalıdır',
    errRingBufferTooShort: 'Halka arabellek, alarm öncesi ve sonrası sürelerin toplamını kapsamalıdır',
    /**
     * Öntanımlı değerleri geri yükle (kılavuz §17.2, satır 5227).
     */
    restoreDefaults: 'Öntanımlı değerler',
    restoreTitle: 'Öntanımlı değerleri geri yükle',
    restoreIntro: 'Şu sistem ayarları fabrika öntanımlılarına döndürülecek:',
    restoreItemStorage: 'Depolama yolu (platform öntanımlısına döner)',
    restoreItemRetention: 'Kayıt saklama günü',
    restoreItemMinFree: 'En az boş alan',
    restoreItemHealthCheck: 'Sağlık denetimi aralığı',
    restoreItemOfflineThreshold: 'Cihaz çevrimdışı sayılmadan önceki hata sayısı',
    restoreItemRequestTimeout: 'İstek zaman aşımı',
    restoreItemPreAlarm: 'Alarm öncesi kayıt süresi',
    restoreItemPostAlarm: 'Alarm sonrası kayıt süresi',
    restoreItemRingBuffer: 'Halka arabellek süresi',
    restoreItemAutoPlay: 'Yazılım açıldığında canlı videoyu kendiliğinden başlat',
    restoreItemMaxStreams: 'Eşzamanlı canlı yayın üst sınırı',
    restoreItemAlarmLinkage: 'Alarm bağlantısı (e-posta sunucusu, alıcılar, şablonlar ve bekleme süresi)',
    restoreItemAlarmSounds: 'Alarm ses kitaplığı (ses türleri ve seçilen ses dosyaları)',
    restoreWarnStorage: 'Depolama yolu öntanımlıya döner. Disk üzerindeki kayıtlar ve dosyalar silinmez, yalnızca artık işaret edilmez; gerekirse geçerli yolu önceden not edin.',
    restoreKeeps: 'Cihaz listesi, kanallar, kayıtlar ve ses dosyaları, alarm kayıtları, hesaplar ve hesap izinleri değiştirilmez.',
    restoreConfirm: 'Geri yükle',
    restoreNotice: 'Sistem ayarları geri yüklendi. SMTP parolası hâlâ bu makinenin kimlik bilgisi deposunda; silmek için e-posta ayarlarındaki “Kayıtlı parolayı sil” düğmesini kullanın.'

  },
  /**
   * Genel bakış sayfası — canlı görüntü bloğu.
   *
   * `cameraLiveUi` içinden ayrı tutulmasının tek nedeni aynı olgunun bu sayfada farklı
   * söylenmesi: izleme sayfasının düğmesi «Görüntüyü başlat» derken bu durum satırı
   * «Başlatılmadı» der. `title` yine `cameraLiveUi.title` içinden kullanılır.
   *
   * Kataloğun tamamındaki kural: HİÇBİR mesaj `@` içermemelidir (vue-i18n'in bağlantılı
   * mesaj imi; çizimi bozar).
   */
  overviewLiveUi: {
    cameraLabel: 'Kamera',
    device: 'Cihaz',
    fullscreen: 'Tam ekran',
    statusNoCamera: 'Kayıtlı kamera yok',
    statusIdle: 'Başlatılmadı',
    statusStarting: 'Görüntü başlatılıyor…',
    statusPlaying: 'Görüntü oynatılıyor',
    statusRtspDisabled: 'Kamera RTSP kapalı',
    statusFfmpegMissing: 'Gömülü ffmpeg kullanılamıyor',
    statusError: 'Görüntü akışı başarısız',
    statusLimitExceeded: 'Eşzamanlı canlı yayın sınırına ulaşıldı',
    statusOccupied: 'Görüntü başka bir sayfada',
    noCameraHint: 'Henüz akustik kamera kayıtlı değil. «Cihazlar» bölümünden bir kamera ekleyin.',
    idleHint: 'Henüz oynatılmıyor. Kamera görüntüsü için «Görüntüyü başlat» düğmesine basın.',
    startingHint: 'Başlatılıyor…',
    rtspDisabledHint:
      'Kameranın RTSP hizmeti kapalı (cihaz rtsp_enabled=0 bildiriyor). Kamera web arayüzünde «Gelişmiş ayarlar → RTSP» bölümünden etkinleştirip yeniden deneyin.',
    ffmpegMissingHint:
      'Gömülü ffmpeg yeniden çoklayıcısı eksik veya çalışmıyor. Uygulamayı yeniden kurun; denenen yollar uygulama günlüğünde kayıtlıdır.',
    errorHint: 'Görüntü akışı kesildi. Yeniden açmak için «Yeniden dene» düğmesine basın.',
    limitExceededHint:
      'Bu makine eşzamanlı canlı yayın sınırına ulaştı («Sistem ayarları → Canlı görüntü» bölümünden ayarlanır). Önce başka bir görüntüyü durdurun, sonra bunu açın.',
    occupiedHint:
      'İzleme sayfası bu kamerayı oynatıyor. Bir kamera aynı anda tek görüntü taşır, bu nedenle «Görüntüyü başlat» görüntüyü bu sayfaya devralır (diğer sayfanın görüntüsü durur).',
    diagnosis: 'Ana süreç tanılaması: {reason}',
    rtspAddressUnknown: 'Cihaz bir görüntü adresi bildirmedi'
  },

  devices: {
    addDevice: 'Cihaz ekle',
    empty: 'Henüz cihaz yok',
    name: 'Cihaz adı',
    ip: 'IP adresi',
    port: 'HTTP bağlantı noktası',
    username: 'Kullanıcı adı',
    password: 'Parola',
    testConnection: 'Bağlantıyı sına',
    saveFailed: 'Kaydedilemedi',
    deleteFailed: 'Cihaz silinemedi',
    status: {
      online: 'Çevrimiçi',
      offline: 'Çevrimdışı',
      unknown: 'Bilinmiyor'
    },
    columns: {
      actions: 'İşlemler'
    }
  },

  devicesUi: {
    addButton: 'Cihaz ekle',
    noticeAdded: 'Cihaz eklendi',
    noticeUpdated: '«{name}» cihazı güncellendi',
    noticeRemoved: '«{name}» cihazı silindi',
    deviceId: 'Cihaz kimliği',
    mac: 'MAC adresi',
    channelCount: 'Kanal sayısı',
    /** Başlıklar mal sahibi tarafından 2026-09-18'de yeniden verildi (8. madde). */
    indexColumn: 'Sıra',
    ipColumn: 'IP adresi',
    channelColumn: 'Kanal sayısı',
    onlineColumn: 'Durum',
    alarmCountColumn: 'Alarmlar',
    ipDoubleClickHint: 'Cihaz web arayüzünü açmak için çift tıklayın',
    /** O sütunun başlığı ve göz simgeli düğmenin etiketi. */
    viewColumn: 'Görüntüle',
    /** Ayarlar = düzenleme iletişim kutusu (ad / bağlantı noktası / kimlik bilgileri / adres). */
    settingColumn: 'Ayarlar',
    /** Sil = cihazı kaldır (yıkıcıdır, önce onay ister). */
    deleteColumn: 'Sil',
    /** Harita sayfasının cihaz yapılandırmasına girişi için. */
    configure: 'Yapılandır',
    openDetail: 'Cihaz ayrıntılarını ve yapılandırmasını aç',
    ipReadonlyHint: 'IP adresi cihazın kimliğidir, değiştirilemez',
    credentialsKeep: 'Boş = değiştirme',
    credentialsHint: 'Kimlik bilgileri yerel depoda tutulur ve hiçbir zaman geri gösterilmez; yalnızca doldurulan alanlar yazılır.',
    passwordShow: 'Parolayı göster',
    passwordHide: 'Parolayı gizle',
    editTitle: 'Cihazı düzenle',
    editNameRequired: 'Cihaz adı zorunludur',
    editPortInvalid: 'HTTP bağlantı noktası 1 ile 65535 arasında bir tam sayı olmalıdır',
    deleteTitle: 'Cihazı sil',
    deleteBody: '«{name}» cihazı silinsin mi? Alarm geçmişi ve kayıtları korunur, ancak yerel olarak saklanan bağlantı kimlik bilgileri silinir.',
    removing: 'Siliniyor…',
    confirmDelete: 'Sil'
  },

  deviceRename: {
    titleDevice: 'Cihaz adını değiştir',
    titleChannel: 'Kanal adını değiştir',
    fieldDevice: 'Cihaz adı',
    fieldChannel: 'Kanal adı',
    sameName: 'Farklı bir ad girin.',
    deviceFailed: 'Ad değiştirilemedi.',
    cameraHint: 'Akustik kameranın açık arayüzünde cihaz adı için bir uç nokta yoktur; bu nedenle yeni ad yalnızca bu bilgisayarın veritabanında saklanır. Kameranın kendi içindeki ad değişmez ve diğer yazılımlar eski adı görmeye devam eder.',
    deviceHint: 'Bu ad hem yerel veritabanına hem de akustik cihazın kendisine yazılır.',
    channelHint: 'Kanal adı akustik cihazda saklanır; bu bilgisayar kanal tablosunu ardından yeniden okur.',
    renameBoxNotice: 'Cihaz adı «{name}» olarak değiştirildi ve cihazın kendisine de yazıldı.',
    renameBoxRestored: 'Cihaz ad değişikliğini reddetti: {reason}. Yerel ad «{name}» olarak geri alındı.',
    renameBoxRestoreFailed: 'Cihaz ad değişikliğini reddetti: {reason}. Yerel ad hâlâ «{name}» ve geri alınamadı; bu bilgisayar ile cihaz artık uyuşmuyor, elle düzeltin.',
    renameCameraNotice: 'Cihaz adı yalnızca bu bilgisayarda «{name}» olarak değiştirildi (kameranın adı değişmedi).',
    renameChannelNotice: 'Kanal adı «{name}» olarak değiştirildi ve akustik cihaza yazıldı.'
  },

  time: {
    justNow: 'Az önce',
    secondsAgo: '{count} saniye önce',
    minutesAgo: '{count} dakika önce',
    hoursAgo: '{count} saat önce',
    daysAgo: '{count} gün önce',
    never: 'Hiç'
  },

  duration: {
    minutesSeconds: '{minutes} dk {seconds} sn',
    hoursMinutes: '{hours} sa {minutes} dk'
  },

  alarms: {
    type: {
      spl: 'Ses basıncı düzeyi',
      main_frequency: 'Ana frekans',
      band_energy_ratio: 'Bant enerji oranı',
      smoothness: 'Düzgünlük',
      clamp_looseness: 'Gevşek kelepçe',
      cooler_anomaly_a: 'Soğutucu arızası A',
      cooler_anomaly_b: 'Soğutucu arızası B',
      overload: 'Aşırı yük',
      short_circuit_surge: 'Kısa devre dalgalanması',
      surface_discharge: 'Yüzey deşarjı',
      corona_discharge: 'Korona deşarjı',
      gap_discharge: 'Boşluk deşarjı',
      floating_discharge: 'Yüzen deşarj',
      dc_bias: 'DC öngerilim'
    },
    unknownMask: 'Bilinmeyen alarm (0x{mask})',
    none: 'Alarm yok'
  },

  alarmsUi: {
    countSummary: '{total} kayıt, {selected} tanesi seçili',
    bulkAcknowledge: 'Seçilenleri onayla',
    bulkUnacknowledge: 'Onayı kaldır',
    addSelectedToSamples: 'Örnek kitaplığına ekle',
    sampleAddDone:
      'Eklendi: {created} yeni, {existing} zaten kitaplıkta, bunlardan {withMetrics} tanesi özellik değeri içeriyor.',
    sampleAddPartial:
      'Eklendi: {created} yeni, {existing} zaten kitaplıkta, {failed} başarısız (kayıt artık yok).',
    sampleAddedWithMetrics:
      'Kitaplığa eklendi ({count} özellik değeri), zayıf etiket: {label}',
    sampleAddedNoMetrics:
      'Kitaplığa eklendi, ancak bu alarm özellik değeri taşımıyor; şimdilik eğitimde kullanılamaz.',
    sampleAlreadyIn: 'Bu kayıt zaten örnek kitaplığında (ikinci kez yazılmadı).',
    sampleSectionTitle: 'Örnek kitaplığı',
    sampleSectionHint:
      'Bu alarmın ölçümlerini ve zayıf etiketini yeniden eğitim için yerel örnek kitaplığına kaydedin.',
    addToSamples: 'Kitaplığa ekle',
    goSamples: 'Kitaplığı aç',
    filterDevice: 'Cihaz',
    filterAllDevices: 'Tüm cihazlar',
    filterChannel: 'Kanal',
    filterAllChannels: 'Tüm kanallar',
    filterType: 'Alarm türü',
    filterAllTypes: 'Tüm türler',
    filterFrom: 'Başlangıç',
    filterTo: 'Bitiş',
    filterAck: 'Onay durumu',
    ackAll: 'Tümü',
    ackAcknowledged: 'Onaylandı',
    ackUnacknowledged: 'Onaylanmadı',
    columnTime: 'Zaman',
    columnDevice: 'Cihaz',
    columnChannel: 'Kanal',
    columnType: 'Alarm türü',
    columnStatus: 'Durum',
    selectAll: 'Tümünü seç',
    selectRow: '{id} seç',
    loading: 'Yükleniyor…',
    empty: 'Bu filtrelerle eşleşen alarm yok',
    pagerRange: '{total} kayıttan {from} – {to}',
    prevPage: 'Önceki',
    nextPage: 'Sonraki',
    detailTitle: 'Alarm ayrıntıları',
    metricsTitle: 'Alarm anındaki ölçümler',
    playbackTitle: 'Kayıt oynatma',
    goSyncRecordings: 'Kayıtları eşitlemek için Kayıtlar sayfasına gidin',
    ackSectionTitle: 'Onay',
    markAcknowledged: 'Onaylandı olarak işaretle',
    notifyAcknowledged: '{count} alarm onaylandı',
    notifyUnacknowledged: '{count} alarmın onayı kaldırıldı',
    notifyDetailAcknowledged: 'Alarm onaylandı',
    notifyDetailUnacknowledged: 'Alarmın onayı kaldırıldı',
    filterSeverity: 'Önem derecesi',
    filterAllSeverities: 'Tüm önem dereceleri',
    columnSeverity: 'Önem derecesi',
    severitySectionTitle: 'Önem derecesi',
    noteSectionTitle: 'Not',
    noteEmpty: 'Henüz not yok',
    notePlaceholder: 'Bir not yazın…',
    noteSave: 'Notu kaydet',
    noteClear: 'Notu sil',
    noteTooLong: 'Not en çok {max} karakter olabilir (şu an {length})',
    noteSaved: 'Not kaydedildi',
    noteCleared: 'Not silindi',
    severitySaved: 'Önem derecesi «{level}» olarak değiştirildi',
    recordMissing: 'Bu alarm artık kayıtlı değil, bu nedenle değişiklik kaydedilmedi',
    prevEvent: 'Önceki olay',
    nextEvent: 'Sonraki olay',
    eventPosition: '{total} kayıt içinde {index}. (geçerli süzgeç)'
  },

  metrics: {
    spl: 'Ses basıncı düzeyi',
    mainFrequency: 'Ana frekans',
    smoothness: 'Düzgünlük',
    bandEnergyRatio: 'Bant enerji oranı',
    oddEvenHarmonicRatio: 'Tek/çift harmonik oranı',
    spectralComplexity: 'Spektral karmaşıklık',
    fingerprintVariation: 'Parmak izi değişimi'
  },

  recordingsUi: {
    filterType: 'Kayıt türü',
    filterAllTypes: 'Tüm türler',
    columnStart: 'Başlangıç',
    columnDevice: 'Cihaz',
    columnChannel: 'Kanal',
    columnType: 'Tür',
    columnDuration: 'Süre',
    columnSampleRate: 'Örnekleme hızı',
    columnFormat: 'Biçim',
    columnSize: 'Dosya boyutu',
    columnDownloaded: 'İndirme',
    columnPlay: 'Oynat',
    columnSample: 'Örnek kitaplığı',
    addToSamples: 'Kitaplığa ekle',
    sampleHint:
      'Kayıt özellik değeri taşımaz: ekledikten sonra etiketleyebilirsiniz, ancak eğitim için özellik verisi de gerekir',
    sampleAddedNoMetrics:
      'Kitaplığa eklendi. Bu kayıtta özellik değeri yok; şimdilik eğitimde kullanılamaz — örnek kitaplığında etiketleyebilirsiniz.',
    sampleAlreadyIn: 'Bu kayıt zaten örnek kitaplığında (ikinci kez yazılmadı).',
    empty: 'Henüz kayıt yok. Cihazdan içe aktarmak için «Cihaz kayıtlarını eşitle» düğmesini kullanın.',
    downloaded: 'İndirildi',
    notDownloaded: 'İndirilmedi',
    playLabel: '{time} kaydını oynat',
    playLocal: 'Yerel kaydı oynat',
    playRemote: 'Oynat (önce cihazdan indirilecek)',
    playerTitle: 'Kayıt oynatma',
    playerTitleAt: 'Kayıt oynatma · {time}',
    videoPlayerTitle: 'Video kaydı oynatma',
    videoLoading: 'Video dosyası açılıyor…',
    videoUnavailable: 'Bu kayıt yerleşik oynatıcıda oynatılamıyor (yerel dosya eksik ya da biçim desteklenmiyor).'
  },

  monitorUi: {
    noDeviceTitle: 'Önce bir cihaz ekleyin',
    goToDevices: 'Cihazlar sayfasına git',
    deviceLabel: 'Cihaz',
    noAddress: 'adres yok',
    channelHint: '{count} kanal',
    start: 'İzlemeyi başlat',
    stop: 'İzlemeyi durdur',
    channelSelect: 'Kanal seçimi',
    /** Sonar dalı için aile rozeti. */
    sonarFamilyBadge: 'SN-16 hava sonarı',
    /* `sonarLiveUnwired`, mal sahibinin 2026-09-18 tarihli 19. maddesiyle kaldırıldı. */
    /** Akış durumu kartı kaldırıldıktan sonra kalan tek satır: hangi yol bozuk. */
    streamFailure: '{name} yolu hata veriyor',
    currentValue: '{channel} güncel değeri',
    /**
     * Kanal başına ses izi kartları. Üç okuma durumu bilerek ayrı mesajdır: `stored`
     * GEÇMİŞ bir okumadır ve kart saatini yazar; `unread` hiç çerçeve gelmedi demektir.
     */
    channelFeaturesSection: 'Kanal başına ses izi özellikleri',
    channelFeaturesHint:
      '{count} kanal; oturum her seferinde tek kanala abone olur, bu yüzden her kart o kanalın son okumasını gösterir',
    channelFeature_live: 'Canlı',
    channelFeature_stored: 'Son okuma',
    channelFeature_unread: 'Okunmadı',
    channelFeatureUnread: 'Bu kanalda henüz hiç özellik çerçevesi okunmadı',
    channelFeatureUpdated: 'Güncellendi {time}',
    audioSection: 'Canlı ses',
    audioPlay: 'Oynat',
    audioStop: 'Oynatmayı durdur',
    audioVolume: 'Ses düzeyi',
    /** Oynatılan ses, özgün ses değil, azaltılmış zarf önizlemesidir. */
    audioPreviewHint:
      'Çalan ses saniyede 10 çerçevelik zarf önizlemesidir (azaltılmış dalga biçimi), özgün ses değildir.',
    startRecording: 'Kaydı başlat',
    stopRecording: 'Kaydı durdur',
    trendSection: 'Canlı eğilim',
    spectrumSection: 'Spektrum',
    spectrogramSection: 'Spektrogram',
    /** ③b: üçüncü grafik kartı — oynat düğmesinin çaldığı verinin kendisi (azaltılmış zarf). */
    waveformSection: 'Akustik dalga biçimi',
    waveformHint: '100 ms’lik bir çerçevenin azaltılmış zarfı (oynat düğmesinin çaldığı verinin aynısı)',
    waveformAmplitude: 'Normalleştirilmiş genlik',
    waitingAudio: 'Ses çerçeveleri bekleniyor…',
    /** ③b zaman çizelgesi: yalnızca yerel dosyalar — bu ailede cihaz tarafında sürekli kayıt yok. */
    playbackSection: 'Zaman çizelgesinde oynatma',
    playbackLocalOnly: 'Yalnızca yerel dosyalar (cihaz tarafında sürekli kayıt yok)',
    playbackPrevious: 'Önceki',
    playbackNext: 'Sonraki',
    playbackZoomIn: 'Yakınlaştır',
    playbackZoomOut: 'Uzaklaştır',
    playbackWindow: '{from} – {to}',
    playbackNow: 'Şimdi',
    playbackLoading: 'Yerel kayıtlar okunuyor…',
    playbackEmpty:
      'Bu cihaz için bu bilgisayarda henüz kayıt yok (elle alınan kayıtlar ve cihazdan indirilen algılama videoları burada görünür)',
    sampleRate: 'Örnekleme hızı',
    waitingFeatures: 'Canlı özellik çerçeveleri bekleniyor…',
    waitingSpectrum: 'Spektrum çerçeveleri bekleniyor…',
    waitingSpectrumData: 'Spektrum verisi bekleniyor…',
    sessionRunning: 'Canlı veri çalışıyor',
    sessionStarting: 'Akış başlatılıyor…',
    sessionError: 'Akış hatası',
    sessionStopped: 'Canlı veri durduruldu',
    spectrumPerBin: 'bin başına {hz} Hz',
    chartNormalizedEnergy: 'Normalize enerji',
    chartBandEnergy: 'Bant enerjisi'
  },

  streamState: {
    IDLE: 'Boşta',
    CONNECTING: 'Bağlanıyor',
    STREAMING: 'Alınıyor',
    RECONNECTING: 'Yeniden bağlanıyor',
    STOPPED: 'Durduruldu',
    ERROR: 'Hata'
  },

  spectrum: {
  },

  trendsUi: {
    querying: 'Sorgulanıyor…',
    noDeviceTitle: 'Önce bir cihaz ekleyin',
    goToDevices: 'Cihazlar sayfasına git',
    filterDevice: 'Cihaz',
    filterChannel: 'Kanal',
    filterAllChannels: 'Tüm kanallar',
    noAddress: 'adres yok',
    filterMetric: 'Ölçüm',
    filterAggregation: 'Toplama',
    filterFrom: 'Başlangıç',
    filterTo: 'Bitiş',
    incompleteRange: 'Hem başlangıç hem bitiş zamanını seçin',
    deviceNotSelected: 'Cihaz seçilmedi',
    notQueried: 'Henüz sorgulanmadı',
    latestBucket: 'En son kova',
    rangeMinBucket: 'Aralık en düşük',
    rangeMaxBucket: 'Aralık en yüksek',
    emptyBuckets: 'Boş kovalar',
    chartTitle: 'Eğilim eğrisi',
    truncated: 'Sonuç nokta sınırına ulaştı, bu yüzden yalnızca ilk {count} kova gösteriliyor. Tam eğriyi görmek için zaman aralığını daraltın.',
    noDeviceSelectedTitle: 'Önce bir cihaz seçin',
    noHistoryTitle: 'Bu cihazın henüz geçmişi yok',
    goToMonitor: 'Canlı izlemeye git',
    emptyRangeTitle: 'Seçilen aralıkta veri yok',
    coverageAvailable: 'Kullanılabilir aralık: {range}',
    noDataInBucket: '{value} (bu kovada veri yok)',
    sampleCount: 'Örnek sayısı: {count}',
    loadingNotice: 'Geçmiş veriler sorgulanıyor…',
    noDataNotice: 'Henüz veri sorgulanmadı',
    flushedNotice: '{rows} satır, {files} geçmiş dosyasına yazıldı',
    emptyBufferNotice: 'Arabellek boş; yazılacak veri yok',
    statPoints: 'Dönen nokta',
    statRows: 'Ham satır',
    statBucket: 'Kova boyutu',
    statFiles: 'Taranan dosya',
    statDuration: 'Sorgu süresi',
    statRatio: 'İndirgeme oranı (satır : nokta)'
  },

  aggregation: {
    avg: 'Ortalama',
    min: 'En düşük',
    max: 'En yüksek',
    p95: '95. yüzdelik'
  },

  bucket: {
    seconds: '{count} sn',
    minutes: '{count} dk',
    hours: '{count} sa',
    days: '{count} gün'
  },

  /** Y-axis title. Spanish and Turkish need their own punctuation, so this is
   *  a per-locale template rather than a shared bracket format. */
  axisTitle: {
    composite: '{metric} ({aggregation})'
  },

  deviceDetailUi: {
    breadcrumbDevices: 'Cihazlar',
    notFoundTitle: 'Cihaz bulunamadı',
    backToList: 'Cihaz listesine dön',
    deviceIdLabel: 'Cihaz kimliği {id}',
    refreshing: 'Yenileniyor…',
    openWebUi: 'Cihaz sayfasını aç',
    monitor: 'İzle',
    tabsLabel: 'Cihaz yapılandırması',
    tabOverview: 'Genel bakış',
    tabChannels: 'Kanallar ve örnekleme hızı',
    tabAlarms: 'Alarm parametreleri',
    tabNetwork: 'Ağ',
    tabTime: 'Zaman / NTP',
    tabSerial: 'RS485 / Modbus',
    tabPush: 'Push bildirimi',
    tabMaintenance: 'Bakım',
    tabAuscultation: 'Oskültasyon kutusu',
    /** Hava sonarının tek yapılandırma sekmesi: PTZ bağlantısı. */
    tabPtz: 'PTZ bağlantısı',
    tabCameraDetect: 'Algılama modu',
    tabCameraAlarms: 'Alarm stratejileri',
    tabCameraMaintenance: 'Bakım ve güncelleme',
    overviewTitle: 'Cihaza genel bakış',
    ip: 'IP adresi',
    httpPort: 'HTTP bağlantı noktası',
    mac: 'MAC adresi',
    firmware: 'Yazılım sürümü',
    fpga: 'FPGA sürümü',
    webVersion: 'Web sürümü',
    channelCount: 'Kanal sayısı',
    // Cihaz kanal sayısını bildirmedi ("0 kanal" değil): bu ürün yazılımında
    // `GET /get_devinfo` içinde böyle bir alan yok ve protokol eşleyicisi 8 sabitini
    // yerine koyuyor, bu yüzden o sayı cihaza atfedilemez.
    channelCountUnreported: 'cihaz bildirmedi',
    sampleRate: 'Örnekleme hızı',
    lastSeen: 'Son görülme',
    nameSection: 'Cihaz adı',
    nameLabel: 'Cihaz adı',
    saveName: 'Adı kaydet',
    nameRequired: 'Cihaz adı zorunludur',
    nameSaveFailed: 'Cihaz adı kaydedilemedi',
    nameSaved: 'Cihaz adı cihaza kaydedildi',
    refreshedAt: '{time} tarihinde yenilendi',
    webSection: 'Cihaz sayfası'
  },

  configCommon: {
    reload: 'Yeniden oku',
    revert: 'Değişiklikleri geri al',
    unsaved: 'Kaydedilmemiş değişiklikler var',
    saving: 'Kaydediliyor…',
    saved: 'Kaydedildi',
    noChanges: 'Kaydedilecek bir şey yok',
    enabled: 'Etkin',
    disabled: 'Devre dışı',
    enabledOfTotal: '{total} kanaldan {enabled} tanesi etkin',
    deviceWordingPrivate: 'Cihaz bu alanı belgelemiyor; bildirdiği değer olduğu gibi gösteriliyor',
    baudRate: 'Baud hızı',
    dataBits: 'Veri biti',
    stopBits: 'Durdurma biti',
    unitPerDevice: 'Birim cihazın kullandığı birimdir; yazılım bunu belgelemiyor',
    deviceTime: 'Cihaz saati',
    hostTime: 'Bu bilgisayar',
    drift: 'Fark',
    readAt: 'Okuma zamanı: {time}',
    channel: 'Kanal',
    status: 'Durum',
    target: 'Hedef adres',
    publicWarningTitle: 'Cihaz genel bir adrese veri yüklüyor.'
  },

  configTime: {
    title: 'Zaman / NTP',
    syncNow: 'Şimdi eşitle',
    saveButton: 'Zaman ayarlarını kaydet',
    saveFailed: 'Zaman ayarları kaydedilemedi',
    syncFailed: 'Zaman eşitleme başarısız',
    savedNotice: 'Zaman ayarları kaydedildi. Cihaz saati: {time}',
    syncedNotice: 'Bu bilgisayara göre eşitlendi. Cihaz saati: {time}',
    ntpToggle: 'NTP eşitleme',
    ntpServer: 'NTP sunucusu',
    ntpServerPlaceholder: 'örn. pool.ntp.org',
    ntpInterval: 'Eşitleme aralığı',
    errInterval: 'NTP eşitleme aralığı en az 1 olan bir tam sayı olmalıdır',
    errServerRequired: 'NTP eşitleme etkinken bir NTP sunucu adresi gerekir',
    sameAsHost: 'Bu bilgisayarla aynı',
    deviceAhead: 'Cihaz {seconds} sn ileride',
    deviceBehind: 'Cihaz {seconds} sn geride'
  },

  configModbus: {
    title: 'Modbus',
    type: 'Tür',
    typeOption: 'Tür {n}',
    port: 'Bağlantı noktası',
    slaveId: 'Köle adresi',
    saveButton: 'Modbus yapılandırmasını kaydet',
    saveFailed: 'Modbus yapılandırması kaydedilemedi',
    savedNotice: 'Modbus yapılandırması kaydedildi',
    errPort: 'Modbus bağlantı noktası 1 ile 65535 arasında olmalıdır',
    errSlaveId: 'Modbus köle adresi 1 ile 247 arasında olmalıdır'
  },

  configRs485: {
    title: 'RS485',
    mode: 'Çalışma modu',
    modeOption: 'Mod {n}',
    portLeft: 'Sol bağlantı noktası',
    portRight: 'Sağ bağlantı noktası',
    unused: '(kullanılmıyor)',
    portUnknown: 'Bilinmiyor (cihaz bu alanı döndürmüyor)',
    portNotInList: 'Geçerli değer cihazın bağlantı noktası listesinde yok; olduğu gibi korundu',
    deviceAddress: 'Cihaz adresi',
    saveButton: 'RS485 yapılandırmasını kaydet',
    saveFailed: 'RS485 yapılandırması kaydedilemedi',
    savedNotice: 'RS485 yapılandırması kaydedildi'
  },
  configPush: {
    title: 'Push bildirimi',
    publicWarning: 'Bildirim hedeflerinden biri özel olmayan bir adres, bu yüzden cihazın topladığı özellikler, görüntüler ve ısı verileri yerel ağdan çıkacak. İstenmiyorsa ilgili kanalı cihazın kendi arayüzünden kapatın veya özel bir adrese yönlendirin.',
    unavailableTitle: 'Bildirim yapılandırması henüz okunmadı',
    kindFeatures: 'Özellik verisi',
    kindAlarm: 'Alarm olayları',
    kindImage: 'Görüntü verisi',
    kindHeat: 'Isı verisi',
    heatInterval: 'Isı verisi bildirim aralığı',
    targetScope: 'Hedef adres kapsamı',
    scopePublic: 'Genel bir adres içeriyor',
    scopePrivate: 'Yalnızca özel adresler'
  },

  configNetwork: {
    title: 'Ağ',
    saveButton: 'Ağ ayarlarını kaydet',
    processing: 'İşleniyor…',
    saveFailed: 'Ağ ayarları değiştirilemedi',
    mode: 'Adres modu',
    modeManual: 'Elle',
    modeDhcp: 'Otomatik (DHCP)',
    ip: 'IP adresi',
    netmask: 'Alt ağ maskesi',
    gateway: 'Varsayılan ağ geçidi',
    dns: 'DNS sunucusu',
    legend: 'Ağ ayarları',
    disconnectTitle: 'Adresi değiştirmek geçerli bağlantıyı hemen keser.',
    disconnectBodyBefore: 'Kaydettikten sonra uygulama cihaza yeni adresten yeniden bağlanır ve cihaz yanıt vermezse ',
    disconnectBodyStrong: 'otomatik olarak geri alır',
    disconnectBodyAfter: '.',
    disconnectWarning: 'Tüm işlem en fazla yaklaşık 45 saniye sürer; bu sırada uygulamayı kapatmayın ve cihazın gücünü kesmeyin. İki adres de yanıt vermezse cihaz yalnızca yerel arayüzünden veya seri bağlantı noktasından kurtarılabilir.',
    progressTitle: 'İlerleme',
    progressRunning: 'Sürüyor',
    progressDone: 'Bitti',
    confirmTitle: 'Ağ değişikliğini onayla',
    confirmFrom: 'Cihaz adresi şuradan değişecek:',
    confirmTo: 'şuna:',
    confirmPortSuffix: '(HTTP bağlantı noktası {port}).',
    confirmBody: 'Kaydetmek geçerli bağlantıyı hemen keser. Uygulama yeni adresten yeniden bağlanıp yapılandırmayı doğrular; yeni adres yanıt vermezse önceki yapılandırmaya geri döner ve sonucu bildirir.',
    confirmWarning: 'İki adres de yanıt vermezse cihaz yalnızca yerel arayüzünden veya seri bağlantı noktasından kurtarılabilir.',
    confirmAction: 'Değişikliği uygula',
    errIp: 'IP adresi geçerli değil',
    errNetmask: 'Alt ağ maskesi geçerli değil',
    errGateway: 'Ağ geçidi geçerli değil',
    errDns: 'DNS sunucusu geçerli değil',
    errPort: '{label} 1 ile 65535 arasında bir tam sayı olmalıdır',
    portHttp: 'HTTP bağlantı noktası',
    portRtsp: 'RTSP bağlantı noktası',
    portTcp: 'TCP bağlantı noktası',
    stageApplying: 'Yeni yapılandırma yazılıyor',
    stageApplied: 'Yeni yapılandırma cihaza yazıldı',
    stageReconnecting: 'Yeni adresten yeniden bağlanılıyor',
    stageConnected: 'Yeni adres yanıt verdi',
    stageVerifying: 'Cihazdan geri okunan değerler doğrulanıyor',
    stageVerified: 'Yapılandırma yürürlükte',
    stageRollingBack: 'Yeni adres yanıt vermiyor; geri alınıyor',
    stageRolledBack: 'Önceki yapılandırmaya geri dönüldü',
    stageUnreachable: 'Ne eski ne de yeni adres yanıt verdi'
  },
  configChannels: {
    title: 'Kanal yapılandırması',
    countHint: '{count} kanal',
    unavailableTitle: 'Kanal yapılandırması henüz okunmadı',
    columnChannel: 'Kanal',
    columnName: 'Ad',
    columnSensorType: 'Sensör türü',
    columnEnabled: 'Etkin',
    columnAlarmProfile: 'Alarm profili',
    columnActions: 'İşlemler',
    ariaName: '{channel} adı',
    ariaSensorType: '{channel} sensör türü',
    ariaEnabled: '{channel} etkin',
    ariaAlarmProfile: '{channel} alarm profili',
    enableOn: 'Etkin',
    enableOff: 'Devre dışı',
    unbound: 'Bağlı değil',
    errNameRequired: 'Kanal adı zorunludur',
    saveFailed: 'Kaydedilemedi',
    sampleRateTitle: 'Örnekleme hızı',
    sampleRateCurrent: 'Geçerli: {rate}',
    sampleRateWarningBefore: 'Örnekleme hızını değiştirmek cihazın ',
    sampleRateWarningStrong: 'veri toplamayı yeniden başlatmasına',
    sampleRateWarningAfter: ' yol açar; bu canlı izlemeyi kesintiye uğratır ve izlemenin yeniden başlatılması gerekir.',
    sampleRateLabel: 'Örnekleme hızı',
    applyRate: 'Örnekleme hızını uygula',
    errRateSame: 'Geçerli olandan farklı bir örnekleme hızı seçin',
    errRateFailed: 'Örnekleme hızı uygulanamadı',
    rateApplied: 'Örnekleme hızı {rate} olarak uygulandı. Canlı izlemenin yeniden başlatılması gerekiyor.',
    confirmTitle: 'Örnekleme hızı değişikliğini onayla',
    confirmFrom: 'Örnekleme hızı şuradan değişecek:',
    confirmTo: 'şuna:',
    confirmBody: 'Uygulamak cihazın veri toplama sürecini yeniden başlatır; bu nedenle canlı izleme hemen durur ve çalışmakta olan izleme, cihaz toparlandıktan sonra yeniden başlatılmalıdır.',
    applying: 'Uygulanıyor…',
    confirmApply: 'Uygula'
  },

  configMaintenance: {
    title: 'Bakım',
    destructiveBadge: 'Yıkıcı işlemler',
    refreshStatus: 'Durumu yenile',
    running: 'İşleniyor…',
    rebootTitle: 'Cihazı yeniden başlat',
    rebootConfirmTitle: 'Yeniden başlatmayı onayla',
    rebootConfirmBody: 'Cihaz hemen yeniden başlar ve bu sırada veri toplayamaz: canlı izleme durur (yaklaşık 30 saniye), süren kayıt biter ve cihaz geri gelene kadar alarm üretilmez. Cihazdaki yapılandırma değiştirilmez.',
    rebootConfirm: 'Yeniden başlat',
    upgradeTitle: 'Sistem yükseltmesi',
    upgradeConfirmTitle: 'Sistem yükseltmesini onayla',
    upgradeConfirmBody: 'Cihaz sistem yükseltme akışına girer ve yeniden başlar; bu süre boyunca kullanılamaz ve hem canlı izleme hem de alarmlar durur. Yükseltme sırasında cihazın gücünü kesmeyin.',
    upgradeConfirm: 'Yükselt',
    resetTitle: 'Fabrika ayarlarına dön',
    resetConfirmTitle: 'Fabrika ayarlarına dön',
    resetConfirmBody: 'Cihazdaki tüm yapılandırma — ağ, kanallar, alarm parametreleri, RS485/Modbus, Push bildirimi ve cihaz adı — fabrika değerlerine döner, ardından cihaz yeniden başlar ve bağlantı kesilir. Bu bilgisayarda saklanan kayıtlar ve alarm geçmişi etkilenmez. Bu işlem geri alınamaz.',
    resetConfirm: 'Fabrika ayarlarını onayla',
    resetTypePrompt: 'Onaylamak için {code} yazın (büyük/küçük harfe duyarlı)',
    uploadTitle: 'Yazılım yükleme',
    uploadButton: 'Yazılım yükle',
    uploading: 'Yükleniyor…',
    uploadConfirmTitle: 'Yazılım yüklemeyi onayla',
    uploadConfirmBody: 'Yüklemeden sonra cihaz yeni yazılımı yazar ve yeniden başlar; yükseltme sırasında kullanılamaz. Yükleme birkaç dakika sürebilir; bu sırada bu uygulamayı kapatmayın, cihazı kapatmayın ve ağı kesmeyin.',
    uploadConfirm: 'Yükle',
    selectedFile: 'Seçilen dosya',
    fullPath: 'Tam yol',
    fileSize: 'Dosya boyutu',
    sizeUnknown: 'Yüklemeden önce okunamaz (arayüzün dosya sistemi erişimi yok); gerçek bayt sayısı işlem bittiğinde görünür',
    firmwareFile: 'Yazılım dosyası',
    uploadProgress: 'Yazılım yüklemesi sürüyor; ilerleme değeri yok',
    errNoFile: 'Önce bir yazılım dosyası seçin',
    noticeRebooting: 'Cihaz yeniden başlatılıyor; yaklaşık 30 saniye sürer ve bu sırada kısa süre çevrimdışı görünür.',
    noticeUpgrading: 'Sistem yükseltme komutu gönderildi; cihaz yükseltme akışına girip yeniden başlayacak.',
    noticeReset: 'Fabrika ayarlarına dönme komutu gönderildi. Cihaz fabrika yapılandırmasına dönüp yeniden başlayacak; sonrasında yapılandırmayı yeniden okuyun.',
    noticeUploaded: 'Yazılım yüklemesi tamamlandı; cihaz yükseltmeye başlayıp yeniden başlayacak.',
    noticeOnline: 'Cihaz yeniden çevrimiçi.',
    noticeStillOffline: 'Cihaz hâlâ erişilemiyor; birazdan yeniden yenileyin.',
    chooseFirmware: 'Yazılım seç…',
    uploadWarning: 'Yazılım yükleniyor. Uygulamayı kapatmayın, cihazı kapatmayın ve ağ bağlantısını kesmeyin. Yükleme bittiğinde cihaz güncellemeyi kendiliğinden başlatır.'
  },

  configAlarms: {
    title: 'Alarm parametreleri',
    addProfile: 'Yeni profil',
    unavailableTitle: 'Alarm parametreleri henüz okunmadı',
    columnName: 'Ad',
    columnMode: 'Algılama modu',
    columnSensitivity: 'Hassasiyet',
    columnInterference: 'Girişim bastırma',
    columnEnabledRules: 'Etkin ölçütler',
    columnActions: 'İşlemler',
    allDisabled: 'Hiçbiri etkin değil',
    editProfile: 'Alarm profilini düzenle',
    createProfile: 'Yeni alarm profili',
    groupBasics: 'Temel bilgiler',
    groupSpl: 'Ses basıncı düzeyi',
    groupMainFrequency: 'Ana frekans',
    groupBandEnergy: 'Bant enerji oranı',
    labelEnable: 'Etkinleştir',
    labelLower: 'Alt',
    labelUpper: 'Üst',
    labelThreshold: 'Eşik',
    saveProfile: 'Profili kaydet',
    deleteConfirmTitle: 'Alarm profilini sil',
    deleteConfirmBody: '«{name}» alarm profili silinsin mi?',
    deleting: 'Siliniyor…',
    notifyCreated: '«{name}» profili oluşturuldu',
    notifySaved: '«{name}» profili kaydedildi',
    notifyDeleted: '«{name}» profili silindi',
    errNameRequired: 'Bir ad gerekli',
    errNumeric: '«{field}» bir sayı olmalıdır',
    errSensitivityRange: 'Hassasiyet 0 ile 100 arasında olmalıdır',
    errMainFrequencyRange: 'Alt ana frekans üst değerden küçük olmalıdır',
    errBandEnergyRange: 'Alt bant enerji oranı üst değerden küçük olmalıdır',
    errFormInvalid: 'Bazı alanlar geçerli değil',
    fieldSensitivity: 'Hassasiyet',
    fieldInterferenceSuppression: 'Girişim bastırma',
    fieldSplOverloadThreshold: 'SPL aşırı yük eşiği',
    fieldSplSurgeThreshold: 'SPL ani artış eşiği',
    fieldSplDropThreshold: 'SPL ani düşüş eşiği',
    fieldSplStabilityThreshold: 'SPL kararlılık eşiği',
    fieldMainFrequencyLower: 'Ana frekans alt sınırı',
    fieldMainFrequencyUpper: 'Ana frekans üst sınırı',
    fieldBandEnergyRatioLower: 'Bant enerji oranı alt sınırı',
    fieldBandEnergyRatioUpper: 'Bant enerji oranı üst sınırı',
    fieldBandEnergyRatioThreshold: 'Bant enerji oranı eşiği',
    ruleOverload: 'Aşırı yük',
    ruleSurge: 'Ani artış',
    ruleDrop: 'Ani düşüş',
    ruleStability: 'Kararlılık',
    ruleMainFrequency: 'Ana frekans',
    ruleBandEnergy: 'Bant enerjisi',
    deleteWarning: 'Silme geri alınamaz: bu profili kullanan kanallar başka bir profile bağlanmalıdır. Bir kanal hâlâ buna başvuruyorsa cihaz silmeyi reddeder; önce Kanal yapılandırmasından bağlantıyı kaldırın.'
  },

  widgetsUi: {
    audioLevel: 'Ses düzeyi',
    sampleRateAndFrame: 'Örnekleme hızı {rate} · {frame}',
    millisecondsPerFrame: '{value} ms/çerçeve',
    recording: 'Kaydediliyor {elapsed}',
    lastRecording: 'Son kayıt {elapsed}',
    peak: 'Tepe',
    rms: 'RMS',
    audioUnavailable: 'Canlı ses akışı çalışmıyor, bu yüzden ölçülecek bir şey yok.',
    spectrogramAlt: '{time} spektrogramı',
    backToLatest: 'En sona dön',
    spectrogramWaiting: 'Spektrogram verisi bekleniyor…',
    spectrogramFrames: '{count} çerçeve (cihaz en son 5 çerçeveyi saklar)',
    lastRefresh: 'Son yenileme {time}',
    offlineUnknownSummary: '{offline} çevrimdışı, {unknown} bilinmiyor',
    indicatorDevices: 'Toplam cihaz',
    indicatorOnline: 'Çevrimiçi cihaz',
    truncated: '{text}\n… (kısaltıldı)',
    arrayOf: '{count} öğeli dizi',
    emptyObject: 'Boş nesne',
    modalClose: 'Kapat'
  },
  domainExtra: {
    connectionType: {
      LAN: 'Yerel ağ',
      REMOTE: 'Uzak'
    }
  },

  monitorErrors: {
    selectDevice: 'Önce bir cihaz seçin',
    selectStream: 'En az bir akış seçin',
    startBeforeRecording: 'Kayıttan önce canlı izlemeyi başlatın'
  },

  rangeExtra: {
    label1h: 'Son 1 saat',
    label24h: '24 saat',
    label7d: '7 gün',
    label30d: '30 gün',
    labelCustom: 'Özel',
    errRangeOrder: 'Başlangıç zamanı bitiş zamanından sonra olamaz'
  },

  addDeviceUi: {
    title: 'Cihaz ekle',
    errIpRequired: 'Cihazın IP adresini girin',
    errIpRange: 'IP adresi geçerli değil (her bölüm 0-255 arasında olmalı)',
    errHostInvalid: 'Geçerli bir IP adresi veya ana makine adı değil',
    errPort: 'HTTP bağlantı noktası 1 ile 65535 arasında bir tam sayı olmalıdır',
    errUsername: 'Oturum açma kullanıcı adını girin',
    errPassword: 'Oturum açma parolasını girin',
    errAddFailed: 'Cihaz eklenemedi',
    defaultPort: 'Genellikle 80',
    noResponseTitle: 'Cihaz yanıt vermedi',
    noResponseBody: 'Adrese erişilebiliyor ancak bu sistemin tanıdığı cihaz bilgisi döndürülmedi. IP’yi, bağlantı noktasını ve cihaz modelini kontrol edin.',
    probeSuccess: 'Bağlantı başarılı',
    probeLatency: 'gidiş dönüş {ms} ms',
    probeAuth: 'kimlik doğrulama {strategy}',
    alreadyRegisteredTitle: 'Bu cihaz zaten kayıtlı',
    firmwareVersion: 'Yazılım sürümü',
    fpgaWebVersion: 'FPGA / web sürümü',
    testing: 'Sınanıyor…',
    adding: 'Ekleniyor…',
    kindLabel: 'Cihaz türü',
    autoDetectLead: 'Cihaz türü seçilmez: protokol adresten otomatik algılanır (ses izi kutusu / hava sonarı / akustik kamera) ve sonuç «Bağlantıyı sına» sonrasında görünür.',
    detectedKind: 'Algılanan tür: {kind}',
    alreadyRegisteredBody: 'Yeniden eklemek ikinci bir cihaz oluşturmaz; yalnızca bağlantı adresini (IP / port) günceller. Kayıtlı yerel cihaz kimliği:',
    // Sınamadaki kanal sayısını cihaz bildirmez: kutuda `GET /get_devinfo` içinde böyle
    // bir alan yok, bu yüzden eşleyici protokol sabitini yazıyor. Yetkili sayı, kayıttan
    // sonra `GET /get_passageway` yolundan gelir.
    channelCountUnreported: 'bildirilmedi'
  },

  installUi: {
    /* Yeniden adlandırıldı ve referans düzey kaldırıldı (mal sahibi 2026-09-18, 7 ve 10). */
    section: 'Adres bilgisi (isteğe bağlı)',
    sectionHint: 'Yalnızca ses kaynağı konumlandırma cihazları (SN-16 hava sonarı) için; diğer ailelerde boş bırakın. Enlem/boylam ondalık WGS84.',
    latitude: 'Enlem (°)',
    longitude: 'Boylam (°)',
    azimuth: 'Azimut (°)',
    azimuthHint: '0 = kuzey, saat yönünde',
    errLatitude: 'Enlem -90 ile 90 arasında olmalı',
    errLongitude: 'Boylam -180 ile 180 arasında olmalı',
    errAzimuth: 'Azimut 0 ile 360 arasında olmalı (360 için 0 yazın)',
    /* Arayüzde artık gösterilmiyor (10. madde); alan doğrulaması sürüyor (§15.49). */
    errSoundLevel: 'Referans düzey -50 ile 200 dB arasında olmalı',
    point: 'Nokta',
    noPoint: 'Kayıtlı değil',
    /** Boş alan hiçbir zaman 0 olarak gösterilmez (0 enlemi gerçek bir koordinattır). */
    unset: 'Kaydedilmedi',
    /** Enlem/boylamdan yalnızca biri girilmiş: yarım nokta yön veremez. */
    halfPoint: 'Yarısı kayıtlı (enlem ve boylam birlikte olmalı)'
  },

  /**
   * SN-16 hava sonarının PTZ (kubbe kamera) bağlantısı.
   *
   * Parola yalnızca «tanımlı / tanımsız» olarak gösterilir, içeriği asla geri verilmez; saat
   * eşitleme satırı cihazın isteği kabul ettiğini söyler (kılavuz bu ucun gövdesini yazmıyor).
   */
  ptzUi: {
    title: 'Kubbe kamera bağlantısı (PTZ)',
    hint: 'Bu sonar, ses kaynağı konumlandırma için bir kubbe kamerayı yönetir. Aşağıdakilerin hepsi cihazda durur; Kaydet\'e basmadan hiçbir şey yazılmaz.',
    fieldEnabled: 'Kubbe bağlantısını etkinleştir',
    enabledHint: 'Kapalıyken sonar kubbeyi yönetmez',
    fieldCameraIp: 'Kubbe IP / ana makine adı',
    fieldCameraPort: 'Kubbe bağlantı noktası',
    fieldCameraUser: 'Kubbe hesabı',
    fieldCameraPassword: 'Kubbe parolası',
    passwordSet: 'Tanımlı',
    passwordUnset: 'Tanımsız',
    passwordHint: 'Asla geri gösterilmez; değiştirmemek için boş bırakın',
    passwordState: 'Parola durumu',
    fieldDirection: 'Kubbe yönü sonarla aynı',
    directionHint: 'Kapalıysa ters yöne bakar',
    fieldSaveSnapshot: 'Alarmda görüntü kaydet',
    saveSnapshotHint: 'Kapalıysa alarmların açılacak görüntüsü olmaz',
    fieldChannel: 'Canlı dinleme kanalı',
    channelHint: '1 – {max} (cihazın bildirdiği kanal sayısı)',
    channelHintUnknown: 'Cihaz kanal sayısını bildirmedi, bu yüzden üst sınır uygulanmıyor',
    cameraInitialised: 'Kubbe başlatıldı',
    unknown: 'Okunmadı',
    yes: 'Evet',
    no: 'Hayır',
    save: 'Cihaza kaydet',
    syncing: 'Eşitleniyor…',
    syncTime: 'Kubbe ile saat eşitle',
    unsaved: 'Kaydedilmemiş değişiklikler var',
    nothingChanged: 'Kaydedilecek değişiklik yok',
    saved: 'Cihaza yazıldı ve geri okunarak doğrulandı',
    savedPartly: 'Cihaza yazıldı, ancak {count} öğe geri okumada eşleşmedi (aşağıya bakın)',
    readBackTitle: 'Geri okuma denetimi',
    allApplied: 'Tümü uygulandı',
    someFailed: 'Uygulanmayan öğeler var',
    applied: 'Uygulandı',
    expectedActual: 'Uygulanmadı: beklenen {expected}, cihaz şimdi {actual}',
    passwordNotCompared: 'Parola yalnızca «tanımlı» olarak denetlenir: içeriği geri dönmediği için karşılaştırılamaz.',
    timeSyncAccepted: 'Cihaz saat eşitleme isteğini kabul etti (kılavuz bu ucun gövdesini yazmıyor; boş bir nesne gönderildi).',
    timeSyncRejected: 'Cihaz saat eşitleme isteğini kabul etmedi.',
    errCameraIp: 'Kubbe adresi IPv4 veya ana makine adı olmalı',
    errCameraPort: 'Kubbe bağlantı noktası 1 ile 65535 arasında olmalı',
    errCameraUser: 'Kubbe hesabı boş olamaz',
    errRealtimeChannel: 'Canlı kanal, cihazın kanal sayısı aralığında olmalı'
  },

  /** Çevrimdışı cihaz haritası (8. parti). Arka plan yalnızca kayıtlı WGS84 noktalarından çizilir. */
  mapUi: {
    mapTitle: 'Cihaz haritası',
    counts: '{total} cihazdan {withPoint} tanesi haritada',
    noPoints: 'Henüz hiçbir cihazın noktası kayıtlı değil. Cihazlar → Düzenle → Kurulum bilgisi altında enlem/boylam girin; cihaz burada görünür.',
    selectHint: 'Bir işaretçiye tıklayıp cihazı görün: konum, alarmlar ve görüntüler.',
    withoutPointTitle: 'Noktası olmayan cihazlar ({count})',
    withoutPointHint: 'Haritada değiller: nokta yoksa çizilecek konum da yok. Kaydetmek için ada tıklayıp o cihazı açın.',
    pickOne: 'Henüz cihaz seçilmedi.',
    point: 'Nokta',
    alarmsTitle: 'Alarmlar ve görüntüler',
    alarmCount: 'son {count}',
    noAlarms: 'Bu cihazın yerel alarmı yok. Yukarıdan «Alarmları eşitle»ye basın.',
    sync: 'Alarmları eşitle',
    syncing: 'Eşitleniyor…',
    syncOutcome: '{created} yeni ve {existing} zaten kayıtlı kayıt incelendi; {linked} alarmın görüntüsü artık yerelde; {missing} kaydın dosyası cihazda kalmamıştı.',
    hasSnapshot: 'Görüntülü',
    noSnapshot: 'Görüntüsüz',
    snapshotTitle: 'Görüntüler',
    snapshotCount: '{count} görüntü',
    snapshotLoading: 'Görüntüler okunuyor…',
    snapshotNotCaptured: 'Bu alarmın cihazda görüntüsü yok (eşitlemede indirilmedi ya da kubbe «alarmda görüntü kaydet» etkin değil).',
    snapshotFilesGone: 'Veritabanı bu alarm için görüntü kayıtlı diyor, ancak dosyalar artık bu makinede değil (depolama dizini değişti veya temizlendi).',
    sonarHint: 'Hava sonarının görüntüleri bağlı kubbe kameradan gelir: saniyede bir, en fazla üç.'
  },

  /** Yerel anormal ses izi örnek kitaplığı (şema v8: iki etiket boyutu). */
  samplesUi: {
    statTotal: "Örnek",
    statTrainable: "Eğitime uygun",
    statFaultHuman: "Arıza: insan",
    statEquipmentHuman: "Ekipman: insan",
    statFaultDevice: "Arıza: cihaz kararı",
    statFaultAi: "Arıza: yapay zekâ önerisi",
    statEquipmentUnlabelled: "Ekipman etiketsiz",
    filterSource: "Kaynak",
    filterLabelSource: "Arıza etiketi kaynağı",
    filterEquipmentLabel: "Ekipman türü",
    filterFaultLabel: "Arıza türü",
    filterAll: "Tümü",
    source_alarm: "Alarm",
    source_manual: "Elle kayıt",
    source_import: "İçe aktarılan",
    labelSource_human: "İnsan",
    labelSource_device: "Cihaz kararı",
    labelSource_ai: "Yapay zekâ önerisi",
    dimension_equipment: "Ekipman türü",
    dimension_fault: "Arıza türü",
    labelsTitle: "Etiket kitaplığı",
    labelsHint:
      "Etiketlerken buradan bir ad seçebilir ya da yeni bir ad yazabilirsiniz (otomatik eklenir)",
    labelsEmpty: "Henüz etiket yok; aşağıdan ekleyin",
    labelUsedBy: "{count} örnek kullanıyor",
    labelRename: "Yeniden adlandır",
    labelAdd: "Ekle",
    labelNewPlaceholder: "Yeni etiket adı",
    labelAdded: "«{name}» eklendi",
    labelExists: "«{name}» zaten etiket kitaplığında",
    labelRenamed: "«{name}» olarak değiştirildi ve {count} örnek güncellendi",
    labelRenameFailed: "Adlandırma başarısız: bu boyutta aynı ada sahip bir etiket var",
    labelRemoved: "«{name}» silindi",
    labelRemoveFailed: "Silme başarısız",
    labelInUse: "«{name}» hâlâ {count} örnek tarafından kullanılıyor, silinemez",
    trainButton: "Eğit ve değerlendir",
    trainingTitle: "Eğitim sonucu (birini dışarıda bırakma)",
    trainingSamples: "Eğitimde kullanılan",
    trainingAccuracy: "Birini dışarıda bırakma doğruluğu",
    trainingExcluded: "Dışlanan",
    trainingExcludedValue: "{noLabel} arıza türü yok · {missingMetrics} eksik öznitelik",
    trainingEquipment: "Eğitim kümesindeki ekipman türleri",
    trainingEquipmentValue: "{kinds} tür · {unassigned} etiketsiz",
    trainingDegenerate: "Tek bir sınıf var; doğruluk tanımı gereği %100 ve hiçbir şey söylemiyor.",
    trainingUnassessable: "2'den az örneği olan sınıflar birini dışarıda bırakma ile değerlendirilemez: {labels}. Doğrulukları yukarıdaki sayıya dahil değil.",
    trainingMixedEquipment:
      "Eğitim kümesinde birden fazla ekipman türü var: aynı arıza sınıfı farklı ekipmanlarda aynı olgu olmayabilir ve bu doğruluğu düşürür.",
    trainingTruncated: "Örnek sayısı eğitim sınırını aşıyor; yalnızca ilk bölümü kullanıldı.",
    trainingConfusion: "Karışıklık matrisi (yalnızca sıfırdan farklı satırlar)",
    trainingConfusionRow: "{expected} etiketli → {predicted} tahmini: {count}",
    columnTime: "Zaman",
    columnDevice: "Cihaz",
    columnChannel: "Kanal",
    columnSource: "Kaynak",
    columnEquipment: "Ekipman türü",
    columnFault: "Arıza türü",
    columnMetrics: "Öznitelik",
    columnActions: "İşlem",
    loading: "Yükleniyor…",
    empty: "Örnek kitaplığı boş. Alarm listesinden veya kayıtlar sayfasından bir kayıt ekleyin.",
    unlabelled: "Etiketsiz",
    metricsCount: "{count} boyut",
    metricsHint: "Cihazın gerçekten bildirdiği öznitelik boyutları; eksikler asla 0 ile doldurulmaz",
    blockedNoLabel: "Arıza türü yok, eğitilemez",
    blockedMissingMetrics: "Eksik öznitelik: {metrics}",
    editLabel: "Etiketleri düzenle",
    clearEquipment: "Ekipman türünü kaldır",
    clearFault: "Arıza türünü kaldır",
    labelSaved: "Etiketler kaydedildi",
    labelCleared: "Etiket kaldırıldı",
    removed: "Örnek silindi",
    exportTitle: "Veri kümesini dışa aktar",
    exportOnlyLabelled: "Yalnızca etiketli örnekleri aktar",
    exportCopyAudio: "Ses dosyalarını da kopyala",
    exportButton: "Veri kümesini dışa aktar…",
    exporting: "Dışa aktarılıyor…",
    exportDone: "{samples} örnek ({labelled} etiketli) şuraya aktarıldı:",
    exportSkipped: "{count} etiketsiz örnek atlandı.",
    exportAudio: "{copied} ses dosyası kopyalandı ({bytes}).",
    exportAudioSkipped:
      "Ses kopyalanmadı: bildirimdeki yollar bu makinenin depolama dizinini gösterir. Başka bir makinede kullanmak için «Ses dosyalarını da kopyala» seçeneğini işaretleyin.",
    exportAudioMissing:
      "{count} ses dosyası artık depolama dizininde yok; bildirimde audio_missing olarak işaretlendi.",
    exportFiles: "Dizin samples.jsonl, samples.csv ve dataset-info.json içerir.",
    aiTitle: "Yapay zekâ ile etiketleme (isteğe bağlı)",
    aiReady: "Yapılandırıldı",
    aiUnknown: "Yapılandırma okunamadı",
    aiBlockedDisabled: "Etkin değil",
    aiBlockedNoEndpoint: "Servis adresi girilmedi",
    aiBlockedBadEndpoint: "Adres geçersiz (http:// veya https:// ile başlamalı)",
    aiBlockedNoModel: "Model adı girilmedi",
    aiEnabled: "Yapay zekâ etiketlemesini etkinleştir",
    aiEndpoint: "Servis adresi",
    aiEndpointPlaceholder: "https://sunucu/v1/chat/completions",
    aiModel: "Model",
    aiModelPlaceholder: "Model adı",
    aiApiKey: "API anahtarı",
    aiKeyStored: "kayıtlı",
    aiKeyAbsent: "kayıtlı değil",
    aiApiKeyPlaceholder: "Kayıtlı anahtarı değiştirmemek için boş bırakın",
    aiNoEncryption:
      "Sistem şifrelemesi kullanılamıyor; anahtar kaydedilemez (yalnızca adres ve model adı kaydedilir).",
    aiSave: "Yapılandırmayı kaydet",
    aiSaved: "Yapılandırma kaydedildi",
    aiClearKey: "Anahtarı sil",
    aiIncludeWeak: "Cihaz zayıf etiketli örnekleri de dahil et",
    aiRun: "Yapay zekâ ile etiketle",
    aiRunning: "Etiketleniyor…",
    aiCandidateNote:
      "Yapay zekâ aday etiket önerir: insan etiketini geçersiz kılmaz ve eğitim kümesine girmez; etiketin insan olarak değiştirilmesiyle onaylanması gerekir.",
    aiOverwriteWarning:
      "Cihaz zayıf etiketinin üzerine yazma açık: bit haritasının kararı yapay zekâ tahminiyle değiştirilecek ve bu örnekten geri alınamayacak.",
    aiOutcome:
      "{considered} örnek incelendi, {requested} örnek modele soruldu, {labelled} aday etiket yazıldı.",
    aiOutcomeBreakdown:
      "{human} insan etiketli atlandı · {weak} zayıf etiketli atlandı · {unresolved} yapay zekâ karar veremedi · {failed} başarısız",
    pagerRange: "Bu sayfada {shown} / toplam {total}"
  },
  /** Oskültasyon ailesi (E2 / FA100 / FA110 / Air Sonar): çekme kanalı. */
  e2Ui: {
    statusTitle: 'Cihaz durumu',
    variant: 'Protokol kuşağı',
    variant_auscultation: 'Oskültasyon kutusu (2023 protokolü)',
    variant_airSonar: 'SN-16 hava sonarı (V3.2 protokolü)',
    variantUnknown: 'Kuşak tanınamadı (cihaz belirleyici bir alan bildirmedi)',
    mode: 'Çalışma modu',
    modeNotApplicable: 'Bu kuşakta çalışma modu yok',
    modeUnknown: 'Cihaz çalışma modunu bildirmedi',
    mode_burst_of_loud_sound: 'Ani yüksek ses',
    mode_rotating_equipment: 'Dönen ekipman',
    mode_electrical_power_equipment: 'Elektrik güç ekipmanı',
    samplerate: 'Örnekleme hızı',
    channelCount: 'Kanal sayısı',
    spectrogramSize: 'Spektrogram boyutu',
    deviceType: 'Cihaz modeli',
    firmware: 'Yazılım sürümü',
    retention: 'Kayıt saklama',
    retentionValue: 'Cihaz son {count} kaydı saklar',
    paramsError: 'Cihaz durumunun tamamı okunamadı: {reason}',
    paramsEmpty: 'Cihaz hiçbir parametre döndürmedi.',
    paramColumn: 'Parametre',
    valueColumn: 'Geçerli değer',
    paramExtra: 'Cihazın fazladan verdiği anahtar',
    paramValueHidden: 'ayarlı (gösterilmez)',
    param_db_limit: 'Desibel eşiği (db_limit)',
    param_tde_ratio_limit: 'Zaman alanı enerji oranı eşiği (tde_ratio_limit)',
    param_fde_ratio_limit: 'Frekans alanı enerji oranı eşiği (fde_ratio_limit)',
    param_freq_down_limit: 'Bant alt sınırı (freq_down_limit)',
    param_freq_up_limit: 'Bant üst sınırı (freq_up_limit)',
    param_hpss_limit: 'Harmonik bileşen eşiği (hpss_limit)',
    param_main_freq_limit: 'Ana frekans eşiği (main_freq_limit)',
    param_sc_ratio_limit: 'Spektrum karmaşıklığı eşiği (sc_ratio_limit)',
    param_sc_ratio_threshold: 'Spektrum karmaşıklığı ölçütü (sc_ratio_threshold)',
    param_samplerate: 'Örnekleme hızı (samplerate)',
    param_notify_url: 'Alarm geri bildirim adresi (notify_url)',
    param_is_send_alarm: 'Alarm gönder (is_send_alarm)',
    param_is_send_fft: 'Canlı analiz gönder (is_send_fft)',
    param_cam_enable: 'PTZ kamera etkin (cam_enable)',
    param_cam_ip: 'Kamera adresi (cam_ip)',
    param_cam_port: 'Kamera bağlantı noktası (cam_port)',
    param_cam_user: 'Kamera hesabı (cam_user)',
    param_cam_pass: 'Kamera parolası (cam_pass)',
    param_cur_realtime_channel: 'Canlı dinleme kanalı (cur_realtime_channel)',
    param_is_cam_init: 'Kamera başlatıldı (is_cam_init)',
    param_is_ptz_direction_same_with_sonar:
      'Kamera yönü sonarla aynı (is_ptz_direction_same_with_sonar)',
    param_is_save_snapshot: 'Alarm anında görüntü (is_save_snapshot)',
    param_is_send_realtime_value: 'Canlı hesap değerlerini gönder (is_send_realtime_value)',
    syncTitle: 'Alarm eşitleme',
    syncHint:
      'Alarm kayıtlarını ve kayıtları cihazdan çeker (cihaz son {count} kaydı saklar). Yeniden eşitleme kayıtları çoğaltmaz.',
    syncSpectrograms: 'Spektrogramları da indir',
    syncSnapshots: 'PTZ görüntülerini de indir',
    syncButton: 'Alarmları eşitle',
    syncing: 'Eşitleniyor…',
    outcomeAlarms: '{seen} kayıt incelendi: {created} eklendi, {existing} zaten kayıtlı.',
    outcomeAudio: 'Kayıtlar: {saved} indirildi, {existing} zaten yerel, {failed} başarısız.',
    outcomeFilesMissing:
      'Bunlardan {count} tanesinin dosyası cihazda yok (files_status = 0); yalnızca alarm kaydı yazıldı.',
    outcomeSpectrograms:
      'Spektrogramlar: {saved} kaydedildi, {failed} cihazda yok (yeniden başlatmadan sonra 10’dan az olması normal).',
    outcomeSnapshots:
      'PTZ görüntüleri: {saved} kaydedildi, {failed} cihazda yok (kamera eşlenmemişse veya görüntü alma kapalıysa 0).',
    outcomeBadTime: '{count} kaydın zamanı okunamadı ve atlandı (zamanı tahmin edilmedi).',
    outcomeHint: 'Eşitleme: {time}'
  },
  playerUi: {
    missingTitle: 'Bu kaydın yerel ses dosyası yok',
    missingBody: 'Bir alarm yalnızca ölçümlerini ve alarm türünü saklar; kaydın cihazdan eşitlenmesi gerekir. Kayıtlar sayfasını açıp «Cihaz kayıtlarını eşitle» ile cihazdaki kayıt üst verilerini ve dosyalarını içe aktarın, sonra oynatmak için buraya dönün.',
    errMissingFile: 'Bu kaydın yerel ses dosyası yok, bu yüzden oynatılamıyor',
    errNoData: 'Ana süreç ses verisi döndürmedi',
    errDecode: 'Ses çözümlenemedi: {detail}',
    loading: 'Kayıt yükleniyor…',
    reload: 'Yeniden yükle',
    play: 'Kaydı oynat',
    release: 'Oynatmayı durdur',
    downloading: 'Ses cihazdan indirilip çözümleniyor, yaklaşık {size}; lütfen bekleyin…',
    autoplayBlocked: 'Yüklendi, ancak tarayıcı oynatmayı kendiliğinden başlatmadı. Aşağıdaki oynat düğmesini kullanın.',
    leadShort: 'Oynatmanın alarmdan {requested} sn önce başlaması istendi, ancak bu kayıtta alarmdan önce yalnızca {actual} sn var; bu nedenle kaydın başından başlıyor.',
    fewMegabytes: 'birkaç MB',
    channelCount: 'Kanal sayısı',
    channelCountValue: '{count} kanal',
    encoding: 'Kodlama',
    waveformTitle: 'Dalga biçimi önizlemesi',
    waveformAria: 'Kayıt dalga biçimi önizlemesi',
    waveformMissing: 'Bu oynatma bir dalga biçimi önizlemesi içermiyordu.',
    spectrumTitle: 'Spektrum anlık görüntüsü',
    spectrumMissing: 'Bu oynatma bir spektrum anlık görüntüsü içermiyordu.'
  },

  labUi: {
    noticeDone: 'Tanılama tamamlandı; sonuçlar aşağıda',
    errSelectDevice: 'Önce bir cihaz seçin',
    errPathRequired: 'Yoklanacak bir yol girin, örneğin /get_devinfo',
    endpointNotProbed: 'Bu tanılama o uç noktayı yoklamadı.',
    requestFailed: 'İstek başarısız: {detail}',
    httpNoResponse: 'yanıt yok',
    contentTypeMissing: 'Content-Type bildirilmemiş',
    chunkedUnknown: 'parçalı kodlama belirlenemedi',
    chunkedYes: 'parçalı kodlama kullanılıyor',
    chunkedNo: 'parçalı değil',
    bytesUnknown: 'bayt sayısı kaydedilmedi',
    bytesReceived: '{count} bayt alındı',
    jsonFields: 'JSON alanları: {fields}',
    summarySeparator: '; ',

    risk1Title: 'Risk 1: oturum belirtecinin nasıl taşındığı',
    risk1Question: 'Belgeler yalnızca /login uç noktasının bir belirteç döndürdüğünü söylüyor; sonraki isteklerin onu nasıl taşıdığını hiç belirtmiyor.',
    risk1Confirmed: 'Çalıştığı doğrulanan taşıma: {strategy}; giriş yanıtında belirteç alanı {tokenState}.',
    risk1Pending: 'Henüz doğrulanmadı. Önce bir tanılama çalıştırın; tüm aday taşımalar başarısız olursa cihaz tarafında trafik yakalanması gerekir.',
    risk2Title: 'Risk 2: /audio_stream çerçeve biçimi',
    risk2Question: 'Ses akışının çerçevelenmesi, örnekleme biçimi ve parçalama stratejisi belgelenmemiş.',
    risk2Pending: 'Henüz doğrulanmadı. Uç nokta kullanılabilir bir yanıt döndürmedi ve parçalı PCM olduğu varsayılamaz.',
    risk3Title: 'Risk 3: /freq_domain ve /time_freq_domain veri yapısı',
    risk3Question: 'Her iki frekans alanı uç noktasının alan adları ve dizi boyutları bilinmiyor; doğrudan ayrıştırmak veriyi sessizce kaybeder.',
    risk3Pending: 'Henüz doğrulanmadı. İki uç noktayı ayrı ayrı yoklayıp ham örnekleri inceleyin.',
    risk4Title: 'Risk 4: kayıt indirme adresinin nasıl kurulduğu',
    risk4Question: 'Cihazın döndürdüğü kayıt yolu doğrudan indirilebilir bir adrese çevrilemiyor; önek veya bağlantı noktası gerekip gerekmediği bilinmiyor.',
    risk4Pending: 'Henüz doğrulanmadı. Kayıt listesini ve indirme uç noktasını yoklayıp yolun biçimini doğrulayın, ancak ondan sonra indirmeyi uygulayın.',
    risk5Title: 'Risk 5: 0 bağlantı noktasının anlamı',
    risk5Question: 'set_network örneğinde 0 bağlantı noktası görünüyor ve bunun “varsayılan bağlantı noktası” mı yoksa “bu hizmeti devre dışı bırak” mı olduğu anlaşılamıyor.',
    risk5Pending: 'Gerçek cihazda sınama gerektirir: 0 bağlantı noktasını yazın, ağ yapılandırmasını yeniden okuyun ve cihazın gerçekten dinlediği bağlantı noktasının değişip değişmediğine bakın. Bu netleşene kadar uygulama cihaza 0 değerinde bağlantı noktası yazmaz.',

    introTitle: 'Bu sayfa ne için',
    chipAuth: 'Belirteç taşıma',
    chipAudioFraming: '/audio_stream çerçeveleme',
    chipFreqSchema: 'Frekans alanı şeması',
    chipDownloadUrl: 'Kayıt indirme adresi',
    chipPortZero: '0 bağlantı noktası',

    noDeviceTitle: 'Önce bir cihaz ekleyin',
    goToDevices: 'Cihazlar sayfasına git',
    targetTitle: 'Tanılama hedefi',
    deviceLine: 'Cihaz kimliği {uid} · {address}',
    noAddress: 'adres yok',
    deviceLabel: 'Cihaz',
    diagnosing: 'Tanılanıyor…',
    runDiagnosis: 'Tanılamayı çalıştır',

    customTitle: 'Özel uç nokta yokla',
    pathLabel: 'Yol',
    pathPlaceholder: 'örn. /get_devinfo',
    methodLabel: 'Yöntem',
    probing: 'Yoklanıyor…',
    probe: 'Yokla',
    ok: 'Başarılı',
    failed: 'Başarısız',
    httpStatus: 'HTTP durumu',
    elapsed: 'Süre',
    chunked: 'Parçalı',
    yes: 'Evet',
    no: 'Hayır',
    receivedBytes: 'Alınan bayt',
    error: 'Hata',

    reportTitle: 'Tanılama raporu',
    detectedAuth: 'Algılanan kimlik doğrulama',
    unconfirmed: 'Doğrulanmadı',
    loginTokenPresent: 'Giriş belirteç döndürüyor',
    tokenPresent: 'var',
    tokenAbsent: 'bulunamadı',
    loginResponseFields: 'Giriş yanıtı alanları',

    endpointsTitle: 'Uç nokta sonuçları',
    endpointCount: '{count} uç nokta',
    columnPath: 'Yol',
    columnMethod: 'Yöntem',
    columnResult: 'Sonuç',
    columnStatus: 'Durum',
    columnElapsed: 'Süre',
    columnChunked: 'Parçalı',
    columnBytes: 'Bayt',
    columnError: 'Hata',
    noEndpointResults: 'Tanılama uç nokta sonucu döndürmedi.',

    samplesTitle: 'Ham yanıt örnekleri',
    unknownType: 'bilinmeyen tür',

    conclusionsTitle: 'Sonuçlar',
    confirmed: 'Doğrulandı',
    pendingConfirmation: 'Bekliyor'
  },

  authUi: {
    username: "Kullanıcı adı",
    password: "Parola",
    signIn: "Oturum aç",
    signingIn: "Oturum açılıyor…",
    rememberPassword: "Parolayı hatırla",
    rememberExpired: "Hatırlanan parola {days} günden eski; lütfen yeniden yazın.",
    rememberUnavailable: "Bu bilgisayarda sistem şifrelemesi kullanılamıyor, bu nedenle parola hatırlanmaz (kullanıcı adı hatırlanır).",
    signOut: "Oturumu kapat",
    signedInAs: "Oturum sahibi",
    mustChangeTitle: "Fabrika parolasını değiştirin",
    changeTitle: "Parola değiştir",
    currentPassword: "Mevcut parola",
    newPassword: "Yeni parola",
    confirmPassword: "Yeni parolayı doğrula",
    changeSubmit: "Yeni parolayı kaydet",
    changing: "Kaydediliyor…",
    changeSuccess: "Parola değiştirildi",
    recoverLink: "Parolanızı mı unuttunuz?",
    recoverTitle: "Süper parola ile sıfırla",
    installId: "Kurulum kimliği",
    copy: "Kopyala",
    copied: "Kopyalandı",
    superPassword: "Süper parola",
    recoverSubmit: "Parolayı sıfırla",
    recovering: "Sıfırlanıyor…",
    recoverSuccess: "Parola sıfırlandı. Yeni parolayla oturum açın.",
    backToLogin: "Oturum açmaya dön",
    errUsername: "Kullanıcı adı girin",
    errPassword: "Parola girin",
    errCurrentPassword: "Mevcut parolanızı girin",
    errNewPassword: "Yeni parola girin",
    errPasswordMismatch: "İki yeni parola aynı değil",
        errPasswordLength: "Parola en az {min} karakter olmalı",
    errPasswordWhitespace: "Parola başında veya sonunda boşluk olamaz",
    errPasswordHasUsername: "Parola kullanıcı adını içeremez",
    errSuperPassword: "Süper parolayı girin"
  },

  usersUi: {
    title: "Hesaplar",
    addUser: "Yeni hesap",
    username: "Kullanıcı adı",
    displayName: "Görünen ad",
    role: "Rol",
    lastLogin: "Son giriş",
    neverLoggedIn: "Hiç",
    pendingPasswordChange: "Parola değişikliği bekliyor",
    create: "Oluştur",
    creating: "Oluşturuluyor…",
    created: "Hesap oluşturuldu; ilk girişte parola değiştirilmeli",
    resetPassword: "Parolayı sıfırla",
    resetTitle: "{name} parolasını sıfırla",
    resetSubmit: "Sıfırla",
    resetDone: "Parola sıfırlandı",
    deleteUser: "Hesabı sil",
    deleteConfirm: "{name} hesabı silinsin mi? Bu işlem geri alınamaz.",
    cannotDeleteSelf: "Oturum açtığınız hesabı silemezsiniz",
    empty: "Henüz başka hesap yok."
  },

  /**
   * Hesap yönetimi (kılavuz §17.1, s177-178).
   */
  accountUi: {
    title: 'Hesap yönetimi',
    adminOnly: 'Hesapları yalnızca bir yönetici yönetebilir',
    editUser: 'Hesabı düzenle',
    saved: 'Hesap kaydedildi',
    deleted: 'Hesap silindi',
    empty: 'Henüz hiç hesap yok.',
    permissions: 'İzinler',
    permissionScopeCount: 'Bu izne bağlı {count} işlem var',
    permissionScopeNone: 'Bu sürümde karşılık gelen işlem kanalı henüz yok',
    createPermissionsHint: 'Öntanımlı olarak yalnızca okuma izinleri işaretlidir; yazma izinleri elle işaretlenir',
    adminAllPermissions: 'Yönetici hesabı öntanımlı olarak tüm izinlere sahiptir',
    copyFrom: 'İzinleri kopyala',
    copyFromPlaceholder: 'İzinleri şuradan kopyala…',
    defaultPermission: 'Öntanımlı izinler',
    permissionsCopied: 'İzinler “{name}” hesabından kopyalandı; uygulamak için Kaydet’e basın',
    permissionsDefaulted: 'Öntanımlı izinler geri yüklendi; uygulamak için Kaydet’e basın',
    errCopySource: 'Önce izinlerin kopyalanacağı hesabı seçin',
    errUsernameForbidden: 'Kullanıcı adı şunları içeremez: {chars}',
    errUsernameTooLong: 'Kullanıcı adı {max} karakterden uzun olamaz',
    errTooManyAccounts: 'En fazla {max} hesap oluşturulabilir',
    builtInAdminUndeletable: 'Yerleşik yönetici silinemez, ancak parolası değiştirilebilir',
    rules: 'Kullanıcı adı {chars} içeremez; parola {min} karakterden kısa olamaz; en fazla {max} hesap; yerleşik yönetici silinemez.'
  },

  /**
   * Alarm ses kitaplığı (kılavuz §17.2.7, s185).
   */
  alarmSoundUi: {
    title: 'Alarm sesi',
    addCustom: 'Özel alarm sesi ekle',
    defaultColumn: 'Öntanımlı',
    typeColumn: 'Tür',
    fileColumn: 'Ses dosyası',
    predefined: 'Öntanımlı',
    predefinedUndeletable: 'Öntanımlı bir alarm sesi türü silinemez',
    noFile: 'Seçilmedi',
    pickFile: 'Dosya seç',
    clearFile: 'Kaldır',
    preview: 'Dinle',
    previewing: 'Dinleniyor: {name}',
    customDefaultName: 'Özel ses {count}',
    renameHint: 'Yeniden adlandırmak için çift tıklayın',
    deleted: 'Özel ses silindi; uygulamak için Kaydet’e basın',
    defaultSet: '“{name}” artık öntanımlı ses; uygulamak için Kaydet’e basın',
    defaultIs: 'Öntanımlı ses: {name}',
    filePicked: '{name} seçildi; uygulamak için Kaydet’e basın',
    onlyWav: 'Ses dosyası yalnızca {ext} olabilir',
    errOnlyWav: 'Ses dosyası yalnızca {ext} olabilir',
    errOnlyWavFor: '“{name}” için seçilen dosya {ext} değil',
    errNoFile: 'Önce bu ses için bir ses dosyası seçin',
    errPreview: 'Bu ses dosyası oynatılamıyor; geçerli bir WAV dosyası olduğunu doğrulayın',
    errEmptyName: 'Ses adı boş olamaz',
    errPredefinedUndeletable: 'Öntanımlı bir alarm sesi türü silinemez',
    summary: 'Toplam {total} kayıt ({custom} özel), {files} tanesinde ses dosyası var'
  },

  /**
   * E-posta ayarları (kılavuz §17.2.8, s186).
   */
  emailUi: {
    title: 'E-posta ayarları',
    host: 'SMTP sunucusu',
    port: 'Bağlantı noktası',
    portHint: 'Öntanımlı 25; SSL ile genellikle 465 olur',
    security: 'Bağlantı güvenliği',
    securityNone: 'Yok',
    securitySsl: 'SSL',
    securityStarttls: 'STARTTLS',
    authentication: 'Sunucu kimlik doğrulaması',
    username: 'Kullanıcı adı',
    password: 'Parola',
    passwordState: 'Kayıtlı parola',
    clearPassword: 'Kayıtlı parolayı sil',
    passwordCleared: 'Bu makinede kayıtlı SMTP parolası silindi',
    from: 'Gönderen adresi',
    receiversSection: 'Alıcılar',
    receiverN: 'Alıcı {n}',
    receiversHint: 'En fazla {max} alıcı',
    templateSection: 'İleti içeriği',
    sendTest: 'Deneme e-postası gönder',
    testFailed: 'Deneme e-postası gönderilemedi',
    saveSuccessWithPassword: 'Ayarlar kaydedildi; SMTP parolası bu makinenin kimlik bilgisi deposunda',
    errHost: 'SMTP sunucu adresini girin',
    errPort: 'Bağlantı noktası 1 ile 65535 arasında bir tam sayı olmalı',
    errUsername: 'Sunucu kimlik doğrulaması bir kullanıcı adı gerektirir',
    errFrom: 'Gönderen adresini girin',
    errFromFormat: 'Gönderen adresi geçerli değil',
    errRecipients: 'En az bir alıcı adresi girin',
    errTooManyRecipients: 'En fazla {max} alıcı girilebilir',
    errRecipientFormat: 'Bu alıcı adresi geçerli değil: {value}'
  },

  channelState: {
    enabled: 'Etkin',
    disabled: 'Devre dışı',
    unknown: 'Durum bilinmiyor',
    disabledHint: 'Bu kanal devre dışı ve canlı izlemeye katılmaz',
    unknownHint: 'Bu kanalın etkinlik durumu henüz okunmadı; cihazı yenileyin',
    liveActive: 'Veri alınıyor',
    liveSilent: 'Veri alınmadı',
    enabledSummary: '{total} kanaldan {enabled} tanesi etkin'
  },

  domain: {
    sensorType: {
      microphone: 'Mikrofon',
      conduction: 'İletim'
    },
    detectionMode: {
      characteristic: 'Karakteristik algılama',
      ai: 'Yapay zekâ algılama'
    },
    recordingType: {
      alarm: 'Alarm kaydı',
      manual: 'Manuel kayıt',
      scheduled: 'Zamanlanmış kayıt'
    },
    streamKind: {
      features: 'Canlı özellikler',
      audio: 'Canlı ses',
      spectrum: 'Spektrum',
      spectrogram: 'Spektrogram'
    },
    deviceKind: {
      acousticBox: 'Akustik kutu',
      acousticCamera: 'Akustik kamera',
      auscultationBox: 'Oskültasyon kutusu / SN-16 hava sonarı'
    },
    eventSource: {
      deviceDetect: 'Kamera algılama günlüğü',
      linkage: 'Yerel alarm bağlantısı',
      localAlarm: 'Akustik kutu alarmı'
    },
    eventSeverity: {
      info: 'Bilgi',
      warning: 'Uyarı',
      critical: 'Kritik',
      unknown: 'Düzey bilinmiyor'
    },
    eventKind: {
      deviceDetect: 'Algılama tamamlandı',
      deviceDetectAlarm: 'Cihazın alarm saydığı algılama',
      linkageAlarm: 'Yerel bağlantı alarmı',
      localAlarm: 'Akustik kutu alarmı'
    },
    detectFileKind: {
      power_spectrum_photo: 'Güç spektrumu görüntüsü',
      power_spectrum_video: 'Güç spektrumu videosu',
      soundmap_photo: 'Ses haritası görüntüsü',
      soundmap_video: 'Ses haritası videosu',
      voiceprint_photo: 'Ses izi görüntüsü',
      voiceprint_video: 'Ses izi videosu',
      bin_mic_data: 'Mikrofon ikili verisi',
      wav_mic_data: 'Mikrofon WAV sesi'
    },
    eventDownloadStage: {
      starting: 'Hazırlanıyor',
      fetching: 'Cihazdan indiriliyor',
      verifying: 'Dosya doğrulanıyor',
      registering: 'Kayıt oluşturuluyor',
      done: 'İndirme tamamlandı',
      reused: 'Yerelde var, yeniden kullanılıyor',
      failed: 'İndirme başarısız'
    },
    userRole: {
      admin: 'Yönetici',
      operator: 'Operatör'
    },
    /**
     * Hesap izinleri (kılavuz §17.1, izin onay kutuları).
     */
    permission: {
      manageAccounts: 'Hesap yönetimi',
      manageSystemSettings: 'Sistem ayarlarını yazma',
      manageDevices: 'Cihaz ekleme ve silme',
      configureDevices: 'Cihaz yapılandırmasını yazma',
      controlCameras: 'Kamera kontrolü ve bakımı',
      deleteRecordings: 'Kayıtları silme',
      downloadDetectFiles: 'Algılama kayıtlarını indirme',
      viewDevices: 'Cihazları görme',
      viewAlarms: 'Alarmları görme',
      viewRecordings: 'Kayıtları görme',
      viewTrends: 'Eğilimleri görme',
      viewEvents: 'Olay ve alarm merkezini görme'
    },
    permissionScope: {
      manageAccounts: 'Hesap yönetimi sayfasındaki tüm değişiklikler: ekleme, silme, rol, izinler, görünen ad ve parola sıfırlama',
      manageSystemSettings: 'Sistem ayarlarını kaydetme, öntanımlıları geri yükleme ve alarm ses dosyası seçme',
      manageDevices: 'Cihaz ekleme, değiştirme ve silme; yeniden başlatma, fabrika ayarları, sistem yükseltme, ürün yazılımı yükleme ve kamera yükseltme',
      configureDevices: 'Kanal, örnekleme hızı, alarm profilleri, ağ adresi, saat, RS485, Modbus ve cihaz adı yazma',
      controlCameras: 'Canlı videoyu açma/kapatma, elle kayıt ve ekran görüntüsü, kamera alarm modelleri, algılamayı başlatma/durdurma ve görüntüleme parametreleri',
      deleteRecordings: 'Kayıtları silme (bu sürümde henüz böyle bir kanal yok; kod açıklamasına bakın)',
      downloadDetectFiles: 'Algılama sonucu dosyalarını cihazdan bu makineye indirme',
      viewDevices: 'Cihaz listesi, cihaz ayrıntısı, cihaz bilgisi ve kanal tablosu',
      viewAlarms: 'Alarm kayıtları, bağlantı motoru durumu ve bekleyen alarmlar',
      viewRecordings: 'Ses/video kayıt listeleri, oynatma verileri ve kayıt oynatma adresleri',
      viewTrends: 'Geçmiş eğilim sorguları, kapsam ve istatistikler',
      viewEvents: 'Olay ve alarm merkezi sorguları ile kamera algılama kitaplığı'
    },
    /**
     * Öntanımlı altı alarm sesi (kılavuz §17.2.7, satır 5439).
     */
    alarmSound: {
      motionDetection: 'Hareket algılama',
      videoLoss: 'Video kaybı',
      videoTampering: 'Video müdahalesi',
      externalAlarm: 'Harici alarm',
      lineCrossing: 'Çizgi geçişi',
      intrusion: 'Bölge ihlali'
    }
  },

  /** Camera live video (FA371 RTSP -> ffmpeg -> loopback <video>). */
  cameraLiveUi: {
    title: 'Kamera canlı görüntüsü',
    rtspAddressUnknown: 'Aygıt bir görüntü adresi bildirmedi',
    start: 'Görüntüyü başlat',
    stop: 'Görüntüyü durdur',
    retry: 'Yeniden dene',
    statusIdle: 'Görüntü başlatılmadı',
    statusStarting: 'Görüntü başlatılıyor…',
    statusPlaying: 'Görüntü oynatılıyor',
    statusRtspDisabled: 'Kamera RTSP kapalı',
    statusFfmpegMissing: 'Paket içindeki ffmpeg kullanılamıyor',
    statusError: 'Görüntü akışı başarısız',
    rtspDisabledHint:
      'Kameranın RTSP hizmeti kapalı (aygıt rtsp_enabled=0 bildiriyor). Kamera web arayüzünde Gelişmiş ayarlar, RTSP bölümünden açıp yeniden deneyin.',
    ffmpegMissingHint:
      'Paket içindeki ffmpeg dönüştürücü eksik veya çalıştırılamıyor. Yazılımı yeniden kurun; uygulama günlüğü denediği tüm yolları kaydeder.',
    errorHint: 'Görüntü akışı kesildi. Yeniden deneyerek açabilirsiniz.',
    limitExceededHint:
      'Bu makine eşzamanlı canlı yayın sınırına ulaştı («Sistem ayarları → Canlı görüntü» bölümünden ayarlanır). Önce çalışan başka bir görüntüyü durdurun, sonra «Görüntüyü başlat» düğmesine basın.',
    dataForwarded: '{count} bayt aktarıldı',
    modeRemux: 'Yalnızca yeniden paketleme (yeniden kodlama yok)',
    modeTranscode: 'Yeniden kodlama (uyumluluk kipi)',
    playbackInfo: 'Oynatma',
    attemptInfo: 'Adres adayı {index}: {id}'
  },

  /**
   * Camera acoustic streams (FA371 manual §5.2). No message may contain `@`.
   */
  cameraStreamUi: {
    title: 'Kamera akustik verileri',
    start: 'Almayı başlat',
    stop: 'Almayı durdur',
    adminOnlyHint: 'Kamera akışlarını başlatmak ve durdurmak yönetici işlemidir.',
    noDevice: 'Önce bir kamera seçin.',
    sessionIdle: 'Akışlar başlatılmadı',
    sessionRunning: 'Akışlar alınıyor',
    sessionError: 'Akışlar başarısız',
    handshake: 'El sıkışma yöntemi: {id}',
    framesCount: '{count} çerçeve',
    silentFor: '{seconds} sn sessiz',
    phaseNotStarted: 'Başlatılmadı',
    phaseNoFrames: 'Henüz veri yok',
    phaseLive: 'Alınıyor',
    phaseStale: 'Akış durdu',
    phaseError: 'Kanal hatası',
    hintNotStarted: 'Bu kanal başlatılmadı. Bağlantı yalnızca Almayı başlat denildikten sonra açılır.',
    hintNoFrames:
      'Bağlantı kuruldu ama tek bir çerçeve bile gelmedi. Boş panel veri olmadığını gösterir; odanın sessiz olduğu anlamına gelmez.',
    hintStale:
      'Daha önce veri geldi, ancak {seconds} saniyeden uzun süredir yeni çerçeve yok; görüntü son çerçevedir ve canlı değer olarak okunmamalıdır.',
    hintError: 'Bu kanal hata bildirdi. Nedeni için aşağıdaki günlüğe veya uygulama günlüğüne bakın.',
    layoutWarning:
      'Geçerli çerçeve boyutu bu kanalın çözme varsayımıyla uyuşmuyor; gösterilen veriler güvenilir olmayabilir.',
    voiceprintTitle: 'Ses izi görüntüsü',
    voiceprintAlt: 'Kameranın gönderdiği ses izi görüntüsü',
    voiceprintJpegMeta: 'Aygıtın gönderdiği JPEG görüntüsü: {bytes}',
    voiceprintMatrixMeta: 'Genlik matrisi {width}x{height} (kaynak {decimation} kez seyreltildi)',
    audioTitle: 'Canlı ses',
    audioPlay: 'Sesi aç',
    audioStop: 'Sesi kapat',
    pcmMeta: 'Çerçeve başına {samples} örnek, {ms} ms, {rate} kHz',
    pcmCrest: 'Tepe faktörü {crest}',
    fftTitle: 'Spektrum',
    fftLineAxis: 'Spektrum çizgi numarası',
    fftAmplitudeAxis: 'Genlik (aygıtın ham sayıları)',
    fftAxisFromDevice: '{lines} spektrum çizgisi; aygıtın bildirdiği örnekleme hızıyla her çizgi {hz} Hz kapsar',
    fftAxisUnknown:
      '{lines} spektrum çizgisi; aygıt örnekleme hızı bildirmedi, bu yüzden yatay eksen çizgi numarasıyla etiketlenir ve frekans ölçeği bilinmez.',
    energyTitle: 'Enerji noktaları',
    energyValue: 'Enerji',
    energyPixelX: 'Piksel X',
    energyPixelY: 'Piksel Y',
    energySwath: 'Tarama açısı',
    energyAzimuth: 'Yön açısı',
    energyNoTarget: 'Bu çerçevede hedef noktası yok (şu anda konumlanan bir ses kaynağı yok).',
    detectTitle: 'Algılama sonuçları',
    detectMode: 'Algılama kipi'
  },

  /**
   * Camera NVR interactions — right-click menu, manual recording, snapshot.
   * Same rule as `cameraLiveUi`: NO MESSAGE HERE MAY CONTAIN `@`.
   */
  cameraNvrUi: {
    menuTitle: 'Kamera işlemleri: {name}',
    menuCapture: 'Ekran görüntüsü / kayıt',
    menuStartRecording: 'Elle kaydı başlat',
    menuStopRecording: 'Kaydı durdur',
    menuSnapshot: 'Ekran görüntüsü',
    menuAlarmConfig: 'Alarm yapılandırması…',
    menuFullscreen: 'Tam ekran',
    menuExitFullscreen: 'Tam ekrandan çık',
    menuCopyRtsp: 'RTSP adresini kopyala',
    menuOpenExternal: 'Harici oynatıcıda aç',
    menuShowOverlay: 'Bilgi katmanını göster',
    menuHideOverlay: 'Bilgi katmanını gizle',
    /*
     * Menü modelinin zaten başvurduğu üç yeni giriş.
     *
     * «Oynatma» kayıtların KİME ait olduğunu söylemek zorunda: FA371'de aygıt
     * tarafında sürekli kayıt depolaması yok, bu yüzden yalnızca bu bilgisayarda
     * saklananlar oynatılabilir. Buna «aygıt kaydı oynatma» demek yanlış olur.
     */
    menuPlayback: 'Yerel kayıtları oynat',
    menuDownloadDetect: 'Algılama kayıtlarını indir',
    menuCloseTile: 'Bu hücreyi boşalt',
    recordingStarted: 'Yerel kayıt başladı: {path}',
    playbackTitle: 'Yerel kayıtları oynat',
    playbackLoading: 'Yerel kayıtlar okunuyor…',
    playbackEmpty: 'Bu kameranın bu bilgisayarda henüz kaydı yok.',
    playbackLocalNote:
      'Yerel kayıtlar: aşağıdaki liste bu bilgisayarda saklananlardır (elle kayıtlar ve aygıttan indirilen algılama dosyaları). FA371 aygıt tarafında sürekli kayıt depolamasına sahip değildir, bu yüzden burada aygıt kayıtları oynatılmaz.',
    playbackUnavailable: 'Bu kayıt oynatılamıyor: ana süreç oynatılabilir bir yerel adres döndürmedi.',
    downloadTitle: 'Algılama kayıtlarını indir',
    downloadLoading: 'Aygıtın algılama kayıtları okunuyor…',
    downloadEmpty: 'Aygıt hiçbir algılama kaydı döndürmedi.',
    downloadNoPaging:
      'Bu uç noktada sunucu tarafı sayfalama yok: aygıttaki tüm algılama kayıtları tek seferde okundu (aygıt {count} bildirdi).',
    downloadColumnTime: 'Algılama zamanı',
    downloadColumnMode: 'Algılama kipi (ham değer)',
    downloadColumnFiles: 'Sonuç dosyaları',
    downloadReused: 'Bu dosya bu bilgisayarda zaten var ve kayıt olarak tanımlandı: {name}',
    downloadPlay: 'Bu kaydı oynat',
    openExternalDone: 'Bu RTSP adresi harici oynatıcıda açıldı.',
    reasonIdle: 'Video başlatılmadı: önce Videoyu başlat düğmesine basın, görüntü geldikten sonra kaydedin.',
    reasonStarting:
      'Video hâlâ başlıyor ve henüz tek kare gelmedi; şimdi kayıt boş bir dosya yazar, ekran görüntüsü de boş çıkar.',
    reasonReady: 'Video oynatılıyor.',
    reasonRtspDisabled:
      'Kamera rtsp_enabled=0 bildiriyor: cihazda RTSP kapalı olduğu için kayıt ve ekran görüntüsü mümkün değil.',
    reasonFfmpegMissing: 'Paket içindeki ffmpeg kullanılamıyor; akış kaydedilemez veya görüntü alınamaz.',
    reasonError: 'Video akışı başarısız oldu; önce videoyu yeniden açın.',
    reasonLimitExceeded: 'Eşzamanlı canlı akış sınırına ulaşıldı. Bu kamera için kayıt veya görüntü almadan önce başka bir hücreyi durdurun.',
    reasonNoAddress: 'Cihaz bir RTSP adresi bildirmedi, kopyalanacak bir adres yok.',
    reasonNoSource: 'Şu anda kullanılabilir bir RTSP oturumu yok; harici oynatıcıya verilecek adres yok.',
    recordingBadge: 'Kayıt sürüyor {time}',
    recordSaved: 'Kayıt kaydedildi: süre {duration}, boyut {size}, dosya {path}',
    recordWarning: 'Dikkat: {reason}',
    snapshotSaved: 'Ekran görüntüsü kaydedildi: {path}',
    openFolder: 'Bulunduğu klasörü aç',
    copyDone: 'RTSP adresi kopyalandı (cihaz parolasını içerir; paylaşmayın).',
    copyMaskedDone:
      'RTSP adresi parola gizlenerek kopyalandı; oynatıcı cihaz hesabını ve parolasını soracaktır.',
    copyFailed: 'Kopyalanamadı; adresi seçip elle kopyalayın.',
    overlayDevice: 'Cihaz: {name}',
    overlayStatus: 'Durum: {status}',
    overlayStream: 'Akış: {mode} · {address}',
    fullscreenFailed: 'Tam ekrana geçilemedi; pencere izinlerini kontrol edin.'
  },

  /**
   * Camera alarm configuration dialog (manual §5.1.22 – §5.1.29).
   * Same rule: NO `@` anywhere. The `ambiguity*` texts expose the manual's
   * contradictions instead of hiding them.
   */
  cameraAlarmUi: {
    title: 'Kamera alarm yapılandırması',
    /** İzleme sayfasındaki alarm kartı (kamera kontrolünün yanında). */
    entryHint:
      'Stratejiler ve koşullar cihazda geçerlidir; bu sayfa yalnızca okur ve düzenler.',
    goAlarmList: 'Alarm kayıtlarını aç',
    // `subtitle` gösterilen uyarı satırıyla birlikte kaldırıldı; `refresh` eski
    // yenile düğmesinin metniydi, düğme artık yalnızca simge olduğu için adı
    // `refreshIcon` (aria-label + title) üzerinden veriliyor.
    tabStrategies: 'Alarm stratejileri',
    tabConditions: 'Alarm koşulları',
    refreshIcon: 'Alarm stratejilerini ve alarm koşullarını yeniden oku',
    loading: 'Alarm yapılandırması okunuyor…',
    empty: 'Cihaz hiç kayıt döndürmedi.',
    newStrategy: 'Yeni strateji',
    editStrategy: 'Stratejiyi düzenle',
    newCondition: 'Yeni koşul',
    editCondition: 'Koşulu düzenle',
    save: 'Kaydet',
    cancel: 'İptal',
    edit: 'Düzenle',
    delete: 'Sil',
    confirmDelete: '"{name}" silinsin mi? Bu işlem cihaza hemen uygulanır.',
    fieldName: 'Ad',
    fieldAlias: 'Takma ad',
    fieldCondition: 'Koşul',
    fieldLevel: 'Alarm seviyesi',
    fieldInterval: 'Aralık',
    fieldTimes: 'Sıra numarası',
    fieldCycle: 'Algılama çevrimi (sn)',
    fieldSensitivity: 'Hassasiyet',
    fieldDiagnosis: 'Tanı açıklaması',
    fieldDbThreshold: 'dB eşiği',
    fieldDbOperator: 'dB operatörü',
    fieldDbSwitch: 'dB kolunu etkinleştir',
    fieldDfThreshold: 'Ana frekans eşiği',
    fieldDfOperator: 'Ana frekans operatörü',
    fieldDfSwitch: 'Ana frekans kolunu etkinleştir',
    fieldDfLogical: 'Ana frekans mantığı',
    fieldNcFileId: 'Karşılaştırma dosyası kimliği',
    fieldNcThreshold: 'Benzerlik eşiği',
    fieldNcSwitch: 'Tayf karşılaştırmasını etkinleştir',
    fieldNcLogical: 'Karşılaştırma mantığı',
    fieldNcOperator: 'Karşılaştırma operatörü',
    fieldDischargeSwitch: 'Deşarj kolunu etkinleştir',
    fieldDischargeLogical: 'Deşarj mantığı',
    fieldDischargeType: 'Deşarj tipi',
    fieldNotes: 'Notlar',
    branchDecibel: 'Ses basıncı seviyesi (dB)',
    branchDominantFreq: 'Ana frekans',
    branchComparison: 'Tayf karşılaştırması',
    branchDischarge: 'Deşarj (yalnız yazma)',
    operatorGt: 'büyük',
    operatorLt: 'küçük',
    operatorEq: 'eşit',
    operatorGe: 'büyük veya eşit',
    operatorLe: 'küçük veya eşit',
    logicalOr: 'veya',
    logicalAnd: 've',
    dischargeCorona: 'Korona',
    dischargeSuspension: 'Asılı',
    dischargeSurface: 'Yüzey',
    dischargeDischarge: 'Deşarj',
    stateEnabled: 'Etkin',
    stateDisabled: 'Etkin değil',
    stateUnknown: 'Etkinlik durumu bilinmiyor',
    conditionHint:
      'Cihaz yalnızca koşulun adını ve kimliğini döndürür; koşulun tamamı aşağıdaki bölümde listelenir.',
    selectCondition: 'Bir koşul seçin',
    noConditions: 'Cihazda henüz alarm koşulu yok: stratejiden önce bir koşul oluşturun.',
    diagnosisKeyLabel: 'Tanı açıklaması anahtarı',
    diagnosisKeyDiagosisn: 'diagosisn (POST için yazıldığı gibi)',
    diagnosisKeyDiagnosis: 'diagnosis (PUT için yazıldığı gibi)',
    diagnosisKeyBoth: 'İki anahtarı da gönder (yoklama)',
    conditionIdStyleLabel: 'Güncellenen koşulun nasıl belirtileceği',
    conditionIdStyleId: 'id gönder (strateji örneğini izler)',
    conditionIdStyleAlarmConditionId: 'alarm_condition_id gönder (okuma tarafındaki yazım)',
    conditionIdStyleNone: 'Tanımlayıcı gönderme (alan tablosuna birebir)',
    unverified: 'Doğrulanmadı',
    ambiguityDiagnosisLabel: 'Tanı açıklaması anahtarı POST ile PUT arasında farklı',
    ambiguityDiagnosisNote:
      'POST alan tablosu diagosisn yazar (kılavuz birebir gönderilmesini ister), PUT ise diagnosis yazar. Cihazın ikisini mi yoksa birini mi kabul ettiği kılavuzda yok; bu yüzden bu bir seçilebilir aday olarak kalır.',
    ambiguityConditionIdLabel: 'Koşul güncellenirken hedef belirtilemiyor',
    ambiguityConditionIdNote:
      'Koşul güncelleme isteğinin alan tablosunda hiç id alanı yok, bu yüzden hangi koşulun değiştiği kılavuzdan bilinemez. Varsayılan, strateji örneğini izleyip id gönderir; diğer iki yazım aday olarak durur.',
    ambiguityLevelLabel: 'İki farklı alarm seviyesi aralığı',
    ambiguityLevelNote:
      'Okuma tablosu 0~3, yazma tarafı 1~4 der. Sessizce kaydırma yapılmaz: 1~4 olduğu gibi gönderilir ve dönen değer olduğu gibi gösterilir; bu yüzden okunan bir 0 için seviye adı yoktur.',
    ambiguitySwitchLabel: 'Stratejiyi etkinleştirme/devre dışı bırakma ucu yok',
    ambiguitySwitchNote:
      'Switch yalnızca okuma tarafında görünür ve açık arayüzde stratejiyi etkinleştiren ya da devre dışı bırakan bir uç yoktur; etkin bir strateji ise hiç değiştirilemez. Bu yüzden iletişim kutusu durumu bildirir ama değiştiremez.',
    ambiguityDischargeLabel: 'Deşarj kolu yalnızca yazma tarafında var',
    ambiguityDischargeNote:
      'Deşarj anahtarı, mantığı ve tipi yalnızca ekleme/güncelleme alan tablolarında görünür ve okuma tarafı bunları hiç döndürmez; ayrıca deşarj tipi listesinde 3 eksiktir. Geri okunamamaları kılavuzun yazılışıdır, bu yazılımın eksiği değildir.',
    ambiguityUnitsLabel: 'Eşik birimleri ve aralıkları belirtilmemiş',
    ambiguityUnitsNote:
      'Kılavuz dB eşiği ve ana frekans eşiği için birim ya da geçerli aralık vermez; tayf benzerliği 0~1 olarak yazılmıştır. Burada hiçbir değer dönüştürülmez.',
    ambiguityDeleteLabel: 'Silme isteğinde belgelenmiş alan adı yok',
    ambiguityDeleteNote:
      'Strateji ve koşul silme gövdeleri yalnızca bir tip (kimlik dizisi) verir, alan adı vermez. İstemci belgelenmiş aday biçimlerden birini gönderir; cihazın kabul edip etmediği ancak yanıtıyla doğrulanır.',
    ambiguityCreateIdLabel: 'Yeni oluşturulan strateji kimlik döndürmüyor',
    ambiguityCreateIdNote:
      'Strateji oluşturmak yalnızca ret/msg döndürür ve yeni kimliğin nasıl geldiği kılavuzda yok; bu yüzden bu iletişim kutusu kaydettikten sonra listeyi yeniden okuyup yeni satırı sahiplenir.',
    issueName: 'Strateji adı 1~20 karakter olmalıdır',
    issueCondition: 'Bu stratejinin bağlanacağı alarm koşulunu seçin (bir strateji tam olarak bir koşula bağlanır)',
    issueLevel: 'Yazma tarafı yalnızca 1~4 alarm seviyesini kabul eder (okuma 0~3 der; burada kaydırma yapılmaz)',
    issueCycle: 'Algılama çevrimi 1~30 saniye olmalıdır',
    issueSensitivity: 'Hassasiyet 0 ile 1 arasında olmalıdır',
    issueInterval: 'Aralık 0 dan küçük olmayan bir tam sayı olmalıdır',
    issueTimes: 'Sıra numarası 0 dan küçük olmayan bir tam sayı olmalıdır',
    issueConditionName: 'Koşul adı boş olamaz (en fazla 64 karakter)',
    issueNoBranch: 'Dört koldan en az biri açık olmalıdır, aksi hâlde koşul değerlendirmeye katılmaz',
    issueSimilarity: 'Gürültü benzerliği 0 ile 1 arasında olmalıdır',
    issueDischargeType: 'Yalnızca 0/1/2/4 deşarj tipleri tanımlıdır (kılavuzda 3 eksik)',
    savedStrategy: 'Strateji gönderildi ve liste yenilendi.',
    savedCondition: 'Koşul gönderildi ve liste yenilendi.',
    deleted: 'Silme isteği gönderildi ve liste yenilendi.',
    missingId:
      'Bu kaydın kimliği tam sayı değil; bu yüzden değiştirilemez veya silinemez (okuma tarafı metin olarak döndürebilir, bkz. §8.3 C21).',
    adminOnly: 'Alarm yapılandırmasını oluşturmak, değiştirmek ve silmek yönetici hesabı gerektirir.'
  },

  /**
   * Channel wall — the Overview page's 1 / 4 / 16 pane channel view.
   *
   * Same rule as `cameraLiveUi` / `cameraStreamUi`: NO MESSAGE HERE MAY CONTAIN `@`
   * (vue-i18n's linked-message sigil; a message containing one fails to compile).
   */
  /**
   * Çok kameralı canlı video duvarı (izleme sayfasının bölünmüş görünümü).
   *
   * `cameraLiveUi` ile aynı katı kural: **bu bloktaki hiçbir mesaj `@` içeremez**
   * (vue-i18n'in bağlantılı mesaj imi; render sırasında derlenmez ve
   * `tests/i18n.test.ts` her mesajı derler).
   */
  /**
   * Kamera kontrol ve bakım paneli (algılama modu / başlatma-durdurma / etkin
   * strateji / bakım).
   *
   * Aynı katı kural: **bu bloktaki hiçbir mesaj `@` içeremez**.
   *
   * İki bilinçli ifade:
   *   - `modeRejected` / `detectNotApplied` / `strategyRejected`, cihazın yazmayı
   *     ONAYLADIĞINI ancak UYGULAMADIĞINI söyler: bu donanımda yazmayı yok sayan
   *     bir `ret:200` yanıtı ölçüldü, bu yüzden arayüz başarı kodunu «tamam»
   *     diye gösteremez;
   *   - `reason*` metinleri DEVRE DIŞI kontrollerin ipuçlarıdır; her biri bir
   *     sonraki adımı söyler.
   *
   * `appMode*` grubu UYGULAMA modudur (bu cihazın yaptığı iş: kısmi deşarj / gaz
   * kaçağı / mekanik gürültü) ve yukarıdaki `mode*` grubundan (ALGILAMA modu: tek
   * algılama / akıllı tur) tamamen farklıdır; metinler karıştırılmamalıdır.
   * `appModeSourceHint` düğme ipucudur ve yalnızca tek bir olguyu söyler: uç nokta
   * cihaz kılavuzunda yoktur.
   */
  cameraControlUi: {
    title: 'Kamera kontrolü',
    refresh: 'Yenile',
    modeTitle: 'Algılama modu',
    modeSingle: 'Tek algılama',
    modeCruise: 'Akıllı tur',
    modeUnknownHint: 'Cihaz, kılavuzun tanımlamadığı bir değer döndürdü: 1 = tek algılama, -1 = akıllı tur.',
    modeRawValue: 'Cihaz değeri: {value}',
    modeReadBack: 'Cihazın şu anki değeri: {value}',
    modeApplied: 'Uygulandı',
    modeRejected: 'Cihaz yazmayı onayladı ancak uygulamadı',
    appModeTitle: 'Uygulama modu',
    appModeCurrent: 'Cihazın şu anki değeri',
    appModePartialDischarge: 'Kısmi deşarj',
    appModeGasLeak: 'Gaz kaçağı',
    appModeMechanical: 'Mekanik gürültü',
    appModeUnknownHint: 'Cihaz, ölçülen üç değerin dışında bir değer döndürdü (1 = kısmi deşarj, 2 = gaz kaçağı, 3 = mekanik gürültü).',
    appModeSourceHint: 'Bu uç nokta cihaz kılavuzunda yok; değiştirme yalnızca uygulama modunu yazar.',
    appModeApplied: 'Uygulandı',
    appModeRejected: 'Cihaz yazmayı onayladı ancak uygulamadı',
    // Ürün sahibinin belirlediği onay metni. Doğrulanmış bir cihaz gerçeği DEĞİLDİR:
    // kılavuz mod değiştirmenin algılamayı kesip kesmediğini belirtmiyor, "tüm geçmiş
    // verileri siler" ifadesi yalnızca Fabrika ayarları için geçiyor ve ölçtüğümüz şey
    // `run_mode` yazmanın etkin strateji işaretçisini temizlediği.
    appModeConfirmTitle: 'Uygulama modunu değiştir',
    appModeConfirmBody: 'Mod değiştirildiğinde tüm saklanan veriler silinir. Devam edilsin mi?',
    appModeConfirmAction: 'Yine de değiştir',
    presetTitle: 'Uygulama modu',
    presetCurrentBand: 'Geçerli görüntüleme bandı',
    presetCurrentTargets: 'Geçerli hedef sayısı',
    presetCurrentThreshold: 'Geçerli görüntüleme eşiği',
    presetNotRead: 'Okunamadı',
    presetPartialDischarge: 'Kısmi deşarj',
    presetGasLeak: 'Gaz kaçağı',
    presetMechanical: 'Mekanik gürültü',
    presetHintPartialDischarge: 'Kısmi deşarj: 20–40 kHz',
    presetHintGasLeak: 'Gaz kaçağı: 25–45 kHz',
    presetHintMechanical: 'Mekanik gürültü: 2–50 kHz',
    presetCitationPartialDischarge: 'practical-guide.txt §4.1.2 · 20–40 kHz · Targets 1 · Sensitivity Low · Enhancement Off',
    presetCitationGasLeak: 'practical-guide.txt §4.2.2 · 25–45 kHz · Targets 1 · Sensitivity Low · Enhancement Off',
    presetCitationMechanical: 'practical-guide.txt §4.3.2 · 2–50 kHz · Targets 1 · Sensitivity Low · Enhancement Disabled',
    presetAlready: 'Zaten bu modda',
    presetRejectedBadge: 'Aygıt kabul etmiyor',
    presetRejectedByDevice:
      'Aygıt bu bandı reddediyor: {width} kHz genişliği aygıtın {limit} kHz sınırını aşıyor (ölçüldü)',
    presetApply: 'Modu uygula',
    presetApplied: 'Uygulandı',
    presetRejected: 'Cihaz yazmayı onayladı ancak uygulamadı',
    presetReadBack: 'Cihaz bandı: {band}',
    presetRestore: 'Geri yükle',
    presetRestored: 'Cihazın önceki değerlerine geri yüklendi',
    presetRestoreRejected: 'Cihaz yazmayı onayladı ancak geri yüklemedi',
    presetTargetsUnchanged: 'Hedef sayısı her zaman 1',
    detectTitle: 'Algılama',
    detectRunning: 'Algılıyor',
    detectStopped: 'Durdu',
    detectRetentionHint: 'Cihaz yalnızca en son 50 algılama kaydını saklar; daha eskilerin üzerine yazılır.',
    detectRecord: 'Kayıt {id}',
    detectStart: 'Algılamayı başlat',
    detectStop: 'Algılamayı durdur',
    detectStopHint: 'Tek algılama, strateji süresi bittiğinde kendiliğinden durur; o anda bu çağrı isteğe bağlıdır.',
    detectApplied: 'Uygulandı',
    detectNotApplied: 'Cihaz durumu istenen şekilde değişmedi',
    strategyTitle: 'Alarm stratejisi',
    strategyPeriodHint: 'Strateji süresi stratejinin kendi içinde yapılandırılır; 1 ile 30 saniye arasındadır.',
    strategyNoneEnabled: 'Etkin strateji yok',
    strategyEnabled: 'Etkin',
    strategyEnable: 'Etkinleştir',
    strategyDisable: 'Devre dışı bırak',
    strategyNoItems: 'Cihazda henüz alarm stratejisi yok',
    strategyIdUnusable: 'Bu stratejinin kimliği tam sayı değil, bu yüzden etkinleştirilip devre dışı bırakılamaz',
    strategyNeedsOne: 'Algılama başlatılmadan önce bir alarm stratejisi etkinleştirilmelidir',
    strategyDisabledPrevious: 'Aynı anda yalnızca bir strateji etkin olabilir, bu yüzden önce {previous} numaralı strateji devre dışı bırakıldı',
    strategyApplied: 'Uygulandı',
    strategyRejected: 'Cihaz yazmayı onayladı ancak uygulamadı',
    maintenanceTitle: 'Bakım',
    firmwareVersion: 'Yazılım sürümü',
    sdkVersion: 'SDK sürümü',
    webVersion: 'Web arayüzü sürümü',
    lastUpgrade: 'Son güncelleme',
    valueUnavailable: 'Okunamadı',
    valueUnavailableHint: 'Cihaz son okumada bu değeri döndürmedi.',
    openWebUi: 'Kamera web arayüzünü aç',
    webUiOpened: 'Sistem tarayıcısında açıldı',
    // `upgrade` ve `reboot` DEVRE DIŞI düğmelerin etiketleriydi; iki işlemin de artık
    // gerçek denetimleri var ve metinleri `cameraUpgradeUi.*` altında.
    rollback: 'Sürüm geri alma',
    factoryReset: 'Fabrika ayarlarına dön',
    reasonNotInOpenInterface: 'Cihazın açık arayüzünde böyle bir işlem yok',
    reasonDeviceOffline: 'Cihaz çevrimdışı',
    adminOnlyHint: 'Modu değiştirmek, algılamayı başlatıp durdurmak ve strateji etkinleştirmek yönetici gerektirir'
  },

  /**
   * Kamera yazılım güncellemesi (cihazın kendi web arayüzünün kullandığı HTTP yolu:
   * `POST /upload` + `PUT /reboot` + `GET /progress`).
   *
   * `*ConfirmBody` yıkıcı bir işlemin SONUCUNU yazar (ne olur, güncelleme ne zaman
   * başlar, ne kesilmemelidir); `sourceHint` uç noktaların kaynağına dair tek bir
   * olgu söyler; `nameRejectedDetail` cihazın uyguladığı dosya adı kuralını aktarır.
   * Geri kalanı kısa etiketlerdir.
   */
  cameraUpgradeUi: {
    title: 'Yazılım güncelleme',
    sourceHint: 'Güncelleme ve yeniden başlatma, cihazın kendi web arayüzünün kullandığı uç noktaları kullanır (cihaz kılavuzunda yoktur).',
    pick: 'Paket seç',
    repick: 'Başka paket seç',
    packageFile: 'Paket',
    packageSize: 'Boyut',
    packageSha256: 'SHA-256',
    packageSuffix: 'Dosya adı son eki',
    sha256Hint: 'Yüklemeden önce bu değeri üreticinin bu sürüm için yayımladığı sağlama değeriyle karşılaştırın.',
    nameAccepted: 'Cihaz bu dosya adını kabul ediyor',
    nameRejected: 'Cihaz bu dosya adını reddedecek',
    nameRejectedDetail: 'Cihaz, "_" sonrasındaki son parçanın V ve üç sayı olmasını ister; örneğin _v2.0.11 (şu an {suffix}).',
    upload: 'Paketi yükle',
    uploading: 'Yükleniyor: %{percent}',
    uploadConfirmTitle: 'Paketi cihaza yükle',
    uploadConfirmBody: 'Paket cihaza yazılacak ({size}). Yükleme sırasında gücü ve ağı kesmeyin. Cihaz sonrasında kendiliğinden yeniden başlamaz: güncellemenin ne zaman başlayacağına siz karar verirsiniz.',
    uploadConfirm: 'Yüklemeyi başlat',
    uploaded: 'Paket yüklendi; cihaz henüz güncellenmedi',
    uploadedHint: 'Güncellemenin başlaması için cihaz yeniden başlatılmalı: Cihazı yeniden başlat düğmesini kullanın.',
    uploadDoneAt: 'Yükleme {duration} sürdü',
    deviceProgressTitle: 'Cihaz güncelleme ilerlemesi',
    deviceProgressRead: 'Cihaz ilerlemesini oku',
    deviceProgressValue: 'Cihaz değeri: {value}',
    deviceProgressUnknown: 'Bu değerin ne anlama geldiği cihaz tarafından belgelenmemiş, bu yüzden dönüştürülmez.',
    deviceProgressNotRead: 'Okunamadı',
    reboot: 'Cihazı yeniden başlat',
    rebootConfirmTitle: 'Cihazı yeniden başlat',
    rebootConfirmBody: 'Cihaz hemen yeniden başlar: süren bir algılama kesilir ve bağlantı kısa süre kopar. Paket yüklendiyse güncelleme ancak bu yeniden başlatmadan sonra başlar; sürerken gücü ve ağı kesmeyin.',
    rebootConfirm: 'Yeniden başlat',
    rebooting: 'Yeniden başlatılıyor…',
    rebootAcknowledged: 'Yeniden başlatma komutu gönderildi ve cihaz onayladı',
    rebootDropped: 'Yeniden başlatma komutu gönderildi; cihaz onaylamadı (bağlantının kopması normaldir)'
  },

  cameraWallUi: {
    title: 'Canlı video duvarı',
    layoutGroup: 'Hücre düzeni',
    layoutLabel: '{count} hücre',
    pickDevice: 'Kamera seç',
    pickNoOption: 'Seçilebilir kamera yok',
    replaceDevice: 'Kamerayı değiştir',
    noCamera: 'Henüz akustik kamera yok',
    assignToCell: 'Bu hücreye koy',
    statusIdle: 'Başlatılmadı',
    statusStarting: 'Başlatılıyor…',
    statusPlaying: 'Oynatılıyor',
    statusRtspDisabled: 'RTSP etkin değil',
    statusFfmpegMissing: 'ffmpeg bulunamadı',
    statusError: 'Akış hatası',
    statusLimitExceeded: 'Eşzamanlılık sınırı aşıldı',
    statusAlreadyShown: 'Kamera başka bir hücrede',
    statusDeviceRemoved: 'Cihaz silindi',
    statusDeviceOffline: 'Cihaz çevrimdışı',
    start: 'Başlat',
    stop: 'Durdur',
    retry: 'Yeniden dene',
    fullscreen: 'Tam ekran',
    exitFullscreen: 'Tam ekrandan çık',
    audioOn: 'Sesi aç',
    audioOff: 'Sesi kapat',
    audioBadge: 'Ses açık',
    volume: 'Ses düzeyi',
    volumeNoPicture: 'Bu hücrede görüntü yok, ses çıkaramaz',
    activeBadge: 'Etkin hücre',
    limitNotice: 'Aynı anda en fazla {max} akış; şu anda {active}. Bir tane daha sınırı aşar: önce başka bir hücreyi durdurun.',
    limitSummary: '{max} akıştan {active} tanesi',
    layoutShrunk: 'Düzen küçüldü: {count} hücre durduruldu.'
  },

  channelWall: {
    title: 'Kanal duvarı',
    summary: '{count} kanal',
    layoutLabel: 'Bölme düzeni',
    layout1: '1 bölme',
    layout2: '2 bölme',
    layout4: '4 bölme',
    layout8: '8 bölme',
    prevPage: 'Önceki',
    nextPage: 'Sonraki',
    pageIndicator: 'Sayfa {page} / {total}',
    loading: 'Kanallar okunuyor…',
    empty: 'Gösterilecek kanal yok',
    noChannelTable:
      '{count} cihaz henüz kanal tablosunu döndürmediği için kanalları listelenmiyor.',
    cameraStreamLabel: 'Ses izi görüntüsü',
    cameraMatrixOnly:
      'Bu kamera görüntü karesi yerine sayısal bir matris gönderiyor, bu yüzden duvar onu yeniden çizmez.',
    cameraOtherDevice: 'Akış başka bir kamerada çalışıyor',
    cameraStale: 'Veri durdu ({seconds} sn önce)',

    // 名字说的是「按下去会发生什么」；此刻是收起的还是展开的由 `aria-expanded` 表达。
    collapse: 'Kanal duvarını daralt',
    expand: 'Kanal duvarını genişlet',
    collapsedNoChannel: 'Şu anda çevrimiçi kanal yok',

    graphLabel: 'Grafik türü',

    // 四种图形，每一种都对应设备端真实推送的一种载荷（见 `lib/channelWall.ts`）。
    // `deviceHasNoData` 是结构性的事实：这个设备家族根本没有这种载荷，
    // 所以它与「未监测」「尚无数据」必须读起来是不同的话。
    graph: {
      voiceprint: 'Ses izi görüntüsü',
      spl: 'Ses basıncı çizgisi',
      spectrum: 'Spektrum',
      spectrogram: 'Spektrogram',
      deviceHasNoData: 'Bu cihaz bu tür veri sağlamıyor',
      splCaption: '{value} dB · {count} nokta',
      lineAxis: '{count} çizgi · X ekseni çizgi sırasıdır (cihaz örnekleme hızını bildirmiyor)',
      // Birim BU DEPONUN etiketidir, cihazın değil: yükteki alan adı
      // `sound_pressure_level` ve bu depodaki hiçbir kutu kılavuzu birimini tanımlamıyor
      // (buradaki tek dB tanımı FA371 kamera kılavuzundan geliyor). `splUnitNote`
      // bu kaynağı söyler ve okumanın `title` özniteliğine asılır.
      splUnit: 'dB',
      splUnitNote:
        'Bu uygulamanın etiketi: cihaz alanı sound_pressure_level ve biriminin cihaz belgelerinde dayanağı yok (bu depoda kutu kılavuzu yok), bu yüzden kalibre edilmiş bir ölçüm sayılmaz.'
    },

    // Bir kanalın EN SON alarm kaydı; yerel alarm veritabanından okunur.
    // Metin her zaman "en son alarm" der, "şu anda alarm veriyor" demez: IPC sözleşmesinde
    // kanal başına canlı alarm bildirimi yok, bu yüzden ikincisi uydurma olurdu.
    alarm: {
      recent: 'En son alarm',
      loading: 'Okunuyor…',
      failed: 'Alarm kayıtları okunamadı',
      none: 'Alarm kaydı yok',
      entry: '{type} · {time} · {ack}'
    },

    reason: {
      notMonitored: 'İzlenmiyor',
      deviceOffline: 'Cihaz çevrimdışı olduğu için gerçek zamanlı veri yok'
    }
  },

  /**
   * Sistem mesajları: üst çubuktaki alarm simgesinin arkasındaki panelde yer alan
   * uygulama düzeyindeki hatalar (mal sahibi, 2026-09-18).
   *
   * Kural `stores/appNotices.ts` dosyasında yazılıdır: uygulama düzeyindeki hatalar
   * (cihaz listesi, ayarlar veya alarm listesi okunamıyor; kimlik doğrulama başarısız…)
   * buraya girer; sayfanın kendi yerinde verdiği geri bildirim (form doğrulama, az önce
   * tıkladığınız şeyin sonucu) girmez. Panel bir kaplamadır: bu içerik yerleşimi oynatmaz.
   */
  noticesUi: {
    title: 'Sistem mesajları',
    clearAll: 'Tümünü temizle',
    dismiss: 'Bu sistem mesajını yoksay',
    bellWithProblems: '{count} sistem mesajı · bekleyen alarm'
  },

  /**
   * Local alarm linkage (recording / popup / notice / e-mail).
   *
   * Same rule as every other group: NO MESSAGE HERE MAY CONTAIN the at-sign
   * (vue-i18n's linked-message sigil; a message containing one fails to compile).
   * That is why the SMTP fields speak of the address without ever showing a
   * sample mailbox. No message below contains that character.
   */
  linkage: {
    title: 'Alarm ilişkilendirmesi',
    enabled: 'Alarm ilişkilendirmesini etkinleştir',

    sourceSection: 'Tetikleme kaynakları',
    pollInterval: 'Yoklama aralığı (sn)',
    useDetectFeedback: 'Algılama geri bildirim hızlandırıcısını etkinleştir',
    minAlarmLevel: 'En düşük alarm seviyesi',
    sourcePoll: 'Algılama günlüğü yoklaması',
    sourceWebsocket: 'Algılama geri bildirim akışı',
    sourceRunning: 'Çalışıyor',
    sourceStopped: 'Durdu',
    sourceLastPoll: 'Son yoklama',
    sourceLastError: 'Son hata',
    sourceTriggers: 'Tetiklemeler',
    sourceFrames: 'Alınan kareler',
    sourceNoFrames: 'Şu ana kadar 0 kare (bu olay akışı hiç veri göndermedi)',

    actionSection: 'Eylemler',
    action: {
      record: 'Kayıt',
      popup: 'Açılır pencere',
      notice: 'Bildirim',
      email: 'E-posta'
    },
    actionState: {
      success: 'Başarılı',
      failed: 'Başarısız',
      skipped: 'Atlandı'
    },

    recordSection: 'Kayıt',
    recordDuration: 'Klip uzunluğu (sn)',
    recordCooldown: 'Bekleme süresi (sn)',
    recordSkipBusy: 'Zaten kayıt yapılırken atla',

    popupSection: 'Açılır pencere',
    popupAutoDismiss: 'Otomatik kapanma (sn)',
    popupCooldown: 'Bekleme süresi (sn)',
    popupMaxStack: 'Ekranda en fazla',

    noticeSection: 'Bildirim',
    noticeCapacity: 'Saklanan kayıt',

    /**
     * E-posta SUNUCUSU bloğu `emailUi` altına taşındı (kılavuz §17.2.8 ayrı bir sekmedir).
     */
    emailActionSection: 'E-posta eylemi',

    emailHostPlaceholder: 'örneğin smtp.example.com',
    emailPasswordPlaceholder: 'Kayıtlı parolanın değişmemesi için boş bırakın',
    emailPasswordStored: 'Parola kayıtlı',
    emailPasswordNotStored: 'Parola kayıtlı değil',
    emailPasswordClearHint: 'Tek bir boşluk girip kaydedin; kayıtlı parola silinir',
    emailSubject: 'Konu şablonu',
    emailBody: 'Gövde şablonu',
    emailAttachFrame: 'Yakalanan kareyi ekle',
    emailCooldown: 'Bekleme süresi (sn)',
    emailTesting: 'Gönderiliyor…',
    emailTestOk: 'Test e-postası SMTP sunucusu tarafından kabul edildi ({count} alıcı)',
    emailTestFailed: 'Test e-postası başarısız oldu: {reason}',
    emailTestAttach: 'Test eki',
    emailTestAttachNone: 'Ek yok',
    emailTestAttachSynthetic: 'Yerleşik test görüntüsü',
    emailTestAttachCamera: 'Kameranın geçerli görüntüsü',
    emailTestPrompt:
      'Önce ayarları kaydedin: test, kayıtlı sunucuyu ve kayıtlı şablonları kullanır.',

    runtimeSection: 'Hız sınırları',
    maxActionsPerMinute: 'Genel üst sınır (dakikadaki eylem)',
    cooldownPeriod: 'Bekleme penceresi (sn)',
    cooldownPerPeriod: 'Pencere başına üst sınır',
    cooldownPerInterface: 'Zaman dilimi başına üst sınır',
    windowUsage: 'Bu pencerede {used} / {limit} kullanıldı',

    pendingTitle: 'Bekleyen alarmlar',
    pendingEmpty: 'Şu anda alarm yok',
    pendingAcknowledge: 'Onayla',
    pendingAcknowledgeAll: 'Tümünü onayla',
    pendingAcknowledged: 'Onaylandı',
    pendingDropped: '{count} eski alarm, saklanan kayıt sınırına ulaşıldığı için düşürüldü',
    pendingLevel: 'Seviye',
    pendingStrategy: 'Strateji',
    pendingMetrics: 'Ses alanı yoğunluğu {intensity}, sızıntı {volume}',
    pendingNoActions: 'Bu alarm için hiçbir eylem çalışmadı',
    pendingEngineOff: 'Alarm ilişkilendirmesi şu anda kapalı',
    pendingShow: 'Bekleyen alarmları göster',

    adminOnly:
      'Alarm ilişkilendirmesi yapılandırmasını değiştirmek, test e-postası göndermek ve alarmları onaylamak yönetici hesabı gerektirir.',
    loadFailed: 'Alarm ilişkilendirmesi durumu okunamadı',
    statusTriggers: 'Bu çalıştırmada {count} tetikleme',
    statusActions: '{count} eylem yürütüldü'
  },

  eventsUi: {
    countSummary: 'Geçerli filtreyle eşleşen {total} olay',
    truncated:
      'Bu sonuç eksik: bir kaynak kesildi (her kaynak en fazla {cap} kayıt okunur) veya motor daha eski alarmları düşürdü. Aşağıdaki kaynak paneli kaç kaydın etkilendiğini yazar.',
    emptyTitle: 'Bildirilmiş hiçbir olay yok',
    emptyFilteredTitle: 'Geçerli filtreyle eşleşen olay yok',

    sourcesTitle: 'Kaynak durumu',
    sourceOk: '{count} kayıt okundu',
    sourceFailed: 'Okuma başarısız: {reason}',
    sourceTruncated: '{count} kayıt kesildi',
    sourceUntimed: '{count} kaydın cihaz saati yok',

    filterDevice: 'Cihaz',
    filterAllDevices: 'Tüm cihazlar',
    filterSource: 'Kaynak',
    filterAllSources: 'Tüm kaynaklar',
    filterSeverity: 'Düzey',
    filterAllSeverities: 'Tüm düzeyler',
    filterFrom: 'Başlangıç',
    filterTo: 'Bitiş',
    filterAck: 'Onay durumu',
    ackAll: 'Tümü',
    ackUnacknowledged: 'Onaylanmamış',
    ackAcknowledged: 'Onaylanmış',

    approximateBadge: 'Yaklaşık zaman',
    approximateHint:
      'Kamera arayüzü zaman damgası birimini hiç bildirmez; burada cihaz saati saniye olarak yorumlanır ve dönüştürülen değer yaklaşıktır.',
    timeUnknown:
      'Cihaz bu günlük için saat bildirmedi, bu yüzden liste onu okuma anına göre sıralar.',

    detailTitle: 'Olay ayrıntısı',
    detailEventId: 'Olay kimliği',
    detailDevice: 'Cihaz',
    detailSource: 'Kaynak',
    detailKind: 'Olay',
    detailSeverity: 'Düzey',
    detailDeviceTime: 'Cihazın ham zaman damgası',
    detailDeviceTimeUnit: 'Varsayılan birim',
    detailSavingPath: 'Cihaz klasörü',
    detailLogId: 'Algılama günlüğü numarası',
    detailDetectMode: 'Algılama modu (ham değer)',
    detailAlarmLevel: 'Cihaz alarm düzeyi (ham, dönüştürülmemiş)',

    detailFilesTitle: 'Algılama sonucu dosyaları (cihaz tarafı eylemleri)',
    detailDetectTitle: 'Algılama günlüğü ayrıntısı',
    detailFilesEmpty: 'Bu algılama günlüğünde sonuç dosyası yok',
    detailFileDownload: 'İndir',
    detailFileDownloading: 'İndiriliyor…',
    detailFileDownloaded: 'İndirildi',
    detailFilePlay: 'Oynat',
    detailFileOpenVideo: 'Videoyu aç',
    detailDownloadNeedAdmin: 'Sonuç dosyalarını indirmek yönetici hesabı gerektirir',
    detailSourceUnavailable: 'Bu kaynak şu anda okunamadı; birazdan yeniden deneyin',

    detailAck: 'Bu olayı onayla',
    detailAckUnsupported:
      'Kamera tarafında algılama günlükleri için onay arayüzü yok (kılavuzun 32 açık arayüzünün hiçbiri), bu yüzden bu kayıt onaylanamaz.',

    detailRecordingTitle: 'Yerel kayıt ve görüntü',
    detailRecordingNone: 'Bu olayın bu makinede kaydı yok.',
    detailRecordingPending:
      'Bu algılamanın sonuç dosyaları henüz indirilmedi, bu yüzden oynatılacak yerel bir dosya yok.',
    detailRecordingVideoUnavailable:
      'Bu kayıt oynatılamıyor (yerel dosya yok veya video değil).',
    detailRecordingGoto: 'Kayıtlara git',
    detailFrameTitle: 'Bağlantı karesi',

    detailMetricsTitle: 'Ölçümler',
    metricSoundmapIntensity: 'Ses haritası yoğunluğu',
    metricLeakVolume: 'Kaçak hacmi',
    metricLeakCost: 'Kaçak maliyeti',
    detailActionsTitle: 'Bağlantı eylemleri',
    detailActionLine: '{action}: {status}',
    detailActionReason: 'Neden: {reason}',

    detailLocalAlarmChannel: 'Kanal',
    detailLocalAlarmTypes: 'Alarm türleri',

    downloadDone: '{name} indirildi ({size})',

    // --- Phase 3: KPI strip / filters / alert queue (spec §8–§10) -----------
    // All five spec levels have a name (see VISIBLE_ALERT_SEVERITIES for why
    // medium/low are not rendered yet).
    alertSeverity: {
      critical: 'Kritik',
      high: 'Yüksek',
      medium: 'Orta',
      low: 'Düşük',
      info: 'Bilgi'
    },
    alertStatus: {
      new: 'Yeni',
      acknowledged: 'Onaylandı',
      investigating: 'İnceleniyor',
      resolved: 'Çözüldü',
      closed: 'Kapatıldı',
      muted: 'Sessize alındı',
      reopened: 'Yeniden açıldı'
    },
    severityUnknown: 'Önem düzeyi bilinmiyor',

    kpiUnacknowledged: 'Onaylanmadı',
    kpiAvgAck: 'Ortalama onay',
    kpiScope: 'KPI ve sayımlar, {total} sonuçtan yüklenen {loaded} satırı kapsar',

    viewMode: {
      compact: 'Kompakt',
      standard: 'Standart',
      evidence: 'Kanıt'
    },

    searchPlaceholder: 'Cihaz, olay veya ölçüm ara',
    searchScope: 'Arama yalnızca yüklenen {loaded} satırı kapsar',

    savedViewTitle: 'Görünümler',
    savedView: {
      all: 'Tümü',
      critical: 'Kritik',
      high: 'Yüksek',
      unacknowledged: 'Onaylanmadı',
      last24h: 'Son 24 saat',
      last7d: 'Son 7 gün'
    },

    filterPanelTitle: 'Filtreler',
    filterPanelToggle: 'Filtre paneli',
    panelCount: '{count}',
    panelScope: 'Sayımlar yüklenen {loaded} satırı kapsar',
    clearFilters: 'Tümünü temizle',

    evidenceRecording: 'Kayıt',
    evidenceFrame: 'Kare',
    evidenceFiles: '{count} dosya',
    metricMore: '+{count} daha',

    // --- Phase 4: ayrıntı paneli / Overview / Evidence (spec §11–§12) --------
    detailTab: {
      overview: 'Genel bakış',
      evidence: 'Kanıt',
      timeline: 'Zaman çizelgesi',
      related: 'İlgili',
      activity: 'Etkinlik'
    },
    overviewStatus: 'Durum',
    overviewFirstDetected: 'İlk algılama',
    overviewLastDetected: 'Son algılama',
    overviewDuration: 'Süre',
    overviewOccurrences: 'Tekrar sayısı',
    drawerResize: 'Paneli yeniden boyutlandırmak için sürükleyin',

    evidenceVisualTitle: 'Görsel kanıt',
    evidenceNone: 'Bu olayın görsel kanıtı yok.',
    evidenceNotCaptured: 'Cihaz görüntü yakalamadı (eşitleme sırasında görüntü indirme kapalı olabilir).',
    evidenceFilesGone: 'Kayıt bu görüntüyü biliyor, ancak dosya artık bu makinede yok.',
    evidenceNotImage: 'Dosya var, ancak görüntülenebilen bir görüntü biçimi değil.',
    evidenceNotFound: 'Bu görsel kanıt için kullanılabilir bir yol yok.',
    evidenceError: 'Görsel kanıt okunamadı.',

    // --- Phase 5: durum makinesi / eylemler / Activity / Timeline / Related (§2.2, §13)
    actionInvestigate: 'İncelemeyi başlat',
    actionResolve: 'Çözüldü olarak işaretle',
    actionClose: 'Kapat',
    actionReopen: 'Yeniden aç',
    actionMute: 'Sessize al',
    actionUnmute: 'Sessizliği kaldır',
    actionAssign: 'Ata',

    activityKind: {
      status: 'Durum değişikliği',
      assign: 'Atama',
      note: 'Not'
    },


    relatedSameDevice: 'Aynı cihaz',
    relatedSameKind: 'Aynı olay türü',
    relatedTimeWindow: '10 dakika içinde',

    // --- Phase 5 (UI): eylemler / zaman çizelgesi / ilgili / etkinlik -------
    relatedTitle: 'İlgili olaylar',
    relatedScope: 'İlgili olaylar yüklenen {loaded} satır arasında aranır',
    relatedEmpty: 'İlgili başka olay bulunamadı.',
    relatedOpen: 'Bunu aç',

    /*
     * --- 6. aşamanın ikinci yarısı (§13.2 öneri kartı + §14.2 V1) -------------
     * "Incident" çevrilmez: şartname onu Event ve Alert ile birlikte tanımlıyor
     * (§2.1) ve Türkçede hem doğru hem de belirsizlik yaratmayan bir karşılık yok.
     */
    incidentTitle: 'Incident kayıtları',
    incidentThreshold: 'Öneri eşiği',
    incidentThresholdOption: '{count} alarm',
    incidentBelowThreshold: 'Aynı cihazda {related} alarm daha var; eşiğe ({count}) ulaşılmadığı için öneri gösterilmiyor.',
    incidentNone: 'Bu alarm henüz bir incident kaydına bağlı değil.',
    incidentAlertCount: '{count} bağlı alarm',
    incidentUnlink: 'Bağlantıyı kaldır',
    incidentSuggestionLabel: 'Olası ilgili incident',
    incidentSuggestionCount: '{count} ilişkili alarm',
    incidentSuggestedTitle: '{device} anormal durum',
    incidentCreate: 'Incident oluştur',
    incidentLinkExisting: 'Var olan incidente bağla',
    incidentCreated: '«{title}» oluşturuldu ve {count} alarm bağlandı',
    incidentLinked: '{linked} alarm bağlandı (bunlardan {already} tanesi zaten içindeydi)',
    incidentUnlinked: '«{title}» ile bağlantı kaldırıldı',
    incidentFailed: 'Bu işlem tamamlanmadı.',
    incidentDialogTitle: 'Incident',
    incidentModeLabel: 'Ne yapılacak',
    incidentModeCreate: 'Yeni incident',
    incidentModeLink: 'Var olana bağla',
    incidentFieldTitle: 'Başlık',
    incidentTitlePlaceholder: 'örn. 1 numaralı fan anormal durum',
    incidentTitleHint: 'En fazla {max} karakter',
    incidentFieldNote: 'Not (isteğe bağlı)',
    incidentFieldExisting: 'Incident seç',
    incidentCandidates: 'Bu alarmları da bağla ({count})',
    incidentNoCandidates: 'Bağlanacak alarm yok — yalnızca incident kaydı oluşturulur.',
    incidentNoExisting: 'Henüz oluşturulmuş incident yok',
    incidentSubmitCreate: 'Oluştur ve bağla',
    incidentSubmitLink: 'Bağla',
    incidentSubmitting: 'Kaydediliyor…',
    incidentReasonTitleRequired: 'Başlık zorunlu',
    incidentReasonTitleTooLong: 'Başlık çok uzun (en fazla {max} karakter)',
    incidentReasonNoteTooLong: 'Not çok uzun (en fazla {max} karakter)',
    incidentReasonNoExisting: 'Önce bir incident seçin',
    incidentReasonNoAlerts: 'En az bir alarm seçin',

    timelineTitle: 'Zaman çizelgesi',
    timelineDetected: 'İlk algılama',

    activityTitle: 'İşlem kaydı',
    activityEmpty: 'Bu olay için henüz işlem kaydı yok.',
    activityStatusLine: '{actor} durumu "{from}" iken "{to}" yaptı',
    activityAssignLine: '{actor} {name} kişisine atadı',
    activityNoteLine: '{actor} not ekledi',
    statusChangeDone: 'Durum "{status}" olarak değiştirildi',
    assignDone: '{name} kişisine atandı',
    actionAssignee: 'Şuna ata',
    actionNote: 'Not ekle',
    actionReopenNotePlaceholder: 'Yeniden açma nedeni (zorunlu)',
    actionNoteEmpty: 'Önce bir neden yazın',
    actionConfirm: 'Onayla',
    actionCancel: 'Vazgeç',

    // --- Phase 6: tekrarlanan tetikleme gruplama (spec §14.1) ---------------
    groupWindowLabel: 'Gruplama',
    groupWindow: {
      off: 'Gruplama yok',
      m10: '10 dakika içinde',
      m30: '30 dakika içinde',
      h1: '1 saat içinde'
    },
    occurrenceCount: '×{count}',
    timelineOccurrence: '{index}. tetikleme',
    statusChangeDoneMany: '{count} tetiklemenin durumu "{status}" olarak değiştirildi'

  }
}
