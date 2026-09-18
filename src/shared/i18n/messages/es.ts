/**
 * Spanish (neutral / Latin-American-leaning, avoiding region-specific forms).
 *
 * Typed against `MessageSchema`, derived from the Chinese reference locale.
 * Register is formal ("usted" implied) throughout, which is what industrial
 * software uses; informal tú would read as consumer-grade to this audience.
 */

import type { MessageSchema } from '../schema'

export const es: MessageSchema = {
  /**
   * Árbol de dispositivos en la barra lateral (topología + selección).
   *
   * Misma regla estricta que `cameraLiveUi`: **ningún mensaje de este bloque puede
   * contener `@`** (es el signo de mensaje enlazado de vue-i18n y no compila al
   * renderizar; `tests/i18n.test.ts` compila todos los mensajes).
   */
  deviceTreeUi: {
    empty: 'Todavía no hay dispositivos',
    filterLabel: 'Filtrar dispositivos',
    filterPlaceholder: 'Filtrar por nombre o dirección…',
    filterClear: 'Quitar filtro',
    filterEmpty: 'Ningún dispositivo coincide con "{query}"',
    expandAll: 'Expandir todo',
    collapseAll: 'Contraer todo',
    expandNode: 'Expandir este elemento',
    collapseNode: 'Contraer este elemento',
    openInWall: 'Abrir en el muro de vídeo',
    statusOnline: 'En línea',
    statusOffline: 'Sin conexión',
    statusUnknown: 'Estado desconocido',
    kindBox: 'Equipo acústico',
    kindCamera: 'Cámara acústica',
    cameraStreamNode: 'Vídeo en directo',
    channelsUnavailable: 'Aún no se ha leído la tabla de canales',
    renameDevice: 'Cambiar el nombre del equipo',
    renameChannel: 'Cambiar el nombre del canal'
  },

  common: {
    confirm: 'Confirmar',
    cancel: 'Cancelar',
    save: 'Guardar',
    saving: 'Guardando…',
    delete: 'Eliminar',
    edit: 'Editar',
    close: 'Cerrar',
    refresh: 'Actualizar',
    reset: 'Restablecer',
    loading: 'Cargando…',
    none: 'Ninguno',
    unknown: 'Desconocido',
    clearSelection: 'Borrar selección',
    viewAll: 'Ver todo',
    unit: {
    }
  },

  errors: {
    DEVICE_OFFLINE: 'El equipo está desconectado y no se puede alcanzar',
    TIMEOUT: 'La solicitud agotó el tiempo de espera. Revise la red o el equipo.',
    AUTH_FAILED: 'Fallo de autenticación. Revise el usuario y la contraseña.',
    INVALID_RESPONSE: 'El equipo devolvió datos con un formato no reconocido',
    DEVICE_ERROR: 'El equipo informó de un error',
    STORAGE_ERROR: 'Falló una operación de almacenamiento local',
    DISK_FULL: 'Espacio en disco insuficiente; la grabación no esencial está en pausa',
    NETWORK_ERROR: 'Falló la conexión de red',
    VALIDATION_ERROR: 'Los datos introducidos no son válidos',
    NOT_IMPLEMENTED: 'Esta función no está disponible',
    UNKNOWN: 'Se produjo un error desconocido',
    fallback: 'La operación falló',
    deviceDetail: 'Respuesta del equipo: {detail}',
    withCode: '{message} ({code})',
    bridgeUnavailable: 'No se puede contactar con el proceso principal. Reinicie la aplicación.',
    bridgeUnavailableDetail: '{message}: {detail}',
    FORBIDDEN: 'Esta cuenta no tiene permiso para realizar esa acción',
    AUTH_USERNAME_TAKEN: 'Ese nombre de usuario ya está en uso',
    AUTH_LAST_ADMIN: 'Debe quedar al menos una cuenta de administrador',
    AUTH_PASSWORD_POLICY: 'La contraseña no cumple los requisitos (8+ caracteres, sin el usuario, sin espacios al principio ni al final)',
    AUTH_LOCKED: 'Demasiados intentos fallidos. Vuelva a intentarlo en breve.',
    authLockedRetry: 'Demasiados intentos fallidos. Vuelva a intentarlo en {seconds} segundos.'
  },

  language: {
    label: 'Idioma de la interfaz',
    description: 'Se aplica de inmediato y se recuerda su elección.'
  },

  app: {
    title: 'HERTZINNO Acoustic Box Manager',
    tagline: 'Software de gestión de equipos',
    /** Botón para contraer la barra lateral (especificación §3.2). */
    collapseSidebar: 'Contraer barra lateral',
    expandSidebar: 'Expandir barra lateral',
    nav: {
      overview: 'Resumen',
      devices: 'Equipos',
      monitor: 'Monitorización en vivo',
      trends: 'Tendencias',
      alarms: 'Alarmas',
      /** Mapa de dispositivos (lote 8): puntos WGS84 registrados y capturas de alarma. */
      map: 'Mapa de dispositivos',
      events: 'Centro de eventos y alarmas',
      recordings: 'Grabaciones',
      samples: 'Biblioteca de muestras',
      settings: 'Configuración',
      protocolLab: 'Laboratorio de protocolo',
      deviceDetail: 'Detalles del equipo'
    },
    versionFallback: 'Versión —',
    footerCopyright: 'Copyright © {year} HERTZINNO',
    mainNavigation: 'Navegación principal',
    releasedOn: "Publicado el {date}",
    builtOn: "Compilado el {date}",
    appVersion: "Versión de la aplicación",
    releaseDate: "Fecha de publicación",
    buildDate: "Fecha de compilación",
    operatingSystem: "Sistema operativo",
    databasePath: "Ruta de la base de datos",
    storageRootPath: "Raíz de almacenamiento",
    copyPath: "Copiar",
    copiedPath: "Copiado"
  },

  settingsUi: {
    saveButton: 'Guardar configuración',
    revert: 'Descartar cambios',
    loadFailedTitle: 'No se pudo leer la configuración',
    reload: 'Reintentar',

    /** Pestañas (propietario 2026-09-17 ③: idioma / almacenamiento / vídeo / alarmas / correo / cuenta / acerca de). */
    tabLanguage: 'Idioma',
    tabStorage: 'Almacenamiento',
    tabVideo: 'Vídeo y búfer',
    tabAlarm: 'Alarmas',
    tabEmail: 'Correo',
    tabAccount: 'Cuenta',
    tabAbout: 'Acerca de y mantenimiento',

    /** Rótulo del grupo dentro de la pestaña Almacenamiento. */
    storageGroupLocation: 'Ubicación y retención',
    /** Un solo grupo: sondeo de dispositivos + búfer circular (el propietario ④ pidió unirlos). */
    probeBufferGroup: 'Sondeo de dispositivos y búfer',
    /** Rótulo del grupo dentro de la pestaña Cuenta. */
    accountSessionGroup: 'Sesión actual',


    storagePath: 'Ruta de almacenamiento',
    picking: 'Seleccionando…',
    browse: 'Examinar…',
    retentionDays: 'Retención de grabaciones (días)',
    minFreeGb: 'Espacio libre reservado (GB)',

    healthCheckMs: 'Intervalo de comprobación (ms)',
    offlineThreshold: 'Fallos antes de desconectar',
    requestTimeoutMs: 'Tiempo de espera de solicitud (ms)',

    preAlarmSeconds: 'Grabación previa a la alarma (s)',
    postAlarmSeconds: 'Grabación posterior a la alarma (s)',
    ringBufferSeconds: 'Duración total del búfer (s)',

    liveSection: 'Vídeo en directo',
    autoPlayCameraLive: 'Reproducir al abrir la aplicación',
    autoPlayOn: 'Activado',
    autoPlayOff: 'Desactivado',

    diskSection: 'Uso del disco',
    diskBelowFloor: 'El espacio libre está por debajo del umbral de seguridad, por lo que se detuvo la grabación no esencial. Libere disco o reduzca «Espacio libre reservado».',
    diskUnavailable: 'Aún no se ha leído la información del disco.',
    diskBarLabel: 'Disco usado al {percent}%',
    diskUsedOfTotal: 'Usado / total',
    diskUsedValue: '{used} / {total} ({percent}%)',
    diskFree: 'Espacio libre',
    diskFreeValue: '{bytes} ({gb})',
    diskAppUsage: 'Uso de esta aplicación',
    diskAppUsageValue: '{bytes} (aproximadamente {percent}%)',

    trendSection: 'Almacenamiento de tendencias',
    trendFlushing: 'Escribiendo…',
    trendFlushNow: 'Volcar ahora',
    trendUnavailable: 'Aún no se ha leído el estado del almacenamiento de tendencias.',
    trendBuffered: 'Filas en búfer',
    trendFilesWritten: 'Archivos escritos',
    trendRowsWritten: 'Filas escritas',
    trendLastFlush: 'Último volcado',
    trendNeverFlushed: 'Sin volcar todavía',
    trendLastError: 'Último error',
    trendWrote: 'Se escribieron {rows} filas en {files} archivos',
    trendNothing: 'El búfer está vacío; no hay nada que escribir',
    rows: '{count} filas',
    files: '{count} archivos',


    saveFailed: 'No se pudo guardar',
    saveSuccess: 'Configuración guardada',
    copyFailed: 'No se pudo copiar. Seleccione el texto y cópielo manualmente.',
    browsePicked: 'Nueva ruta de almacenamiento seleccionada. Pulse «Guardar configuración» para aplicarla.',
    errStorageRoot: 'La ruta de almacenamiento es obligatoria',
    errRetentionDays: 'La retención debe ser un entero de al menos 1 día',
    errMinFree: 'El espacio libre reservado no puede ser negativo',
    errHealthCheck: 'El intervalo de comprobación debe ser de al menos 1000 ms',
    errOfflineThreshold: 'El umbral de desconexión debe ser un entero de al menos 1',
    errRequestTimeout: 'El tiempo de espera debe ser de al menos 1000 ms',
    errAlarmWindows: 'La grabación previa y posterior a la alarma no puede ser negativa',
    errRingBuffer: 'La duración del búfer circular debe ser un entero de al menos 1 segundo',
    errRingBufferTooShort: 'El búfer circular debe cubrir al menos la duración previa más la posterior',
    /**
     * Restaurar valores predeterminados (manual §17.2, línea 5227).
     */
    restoreDefaults: 'Valores predeterminados',
    restoreTitle: 'Restaurar valores predeterminados',
    restoreIntro: 'Estos parámetros del sistema se restaurarán a sus valores de fábrica:',
    restoreItemStorage: 'Ruta de almacenamiento (vuelve a la predeterminada de la plataforma)',
    restoreItemRetention: 'Días de conservación de grabaciones',
    restoreItemMinFree: 'Espacio libre mínimo',
    restoreItemHealthCheck: 'Intervalo de comprobación de estado',
    restoreItemOfflineThreshold: 'Fallos antes de marcar un dispositivo como desconectado',
    restoreItemRequestTimeout: 'Tiempo de espera de las peticiones',
    restoreItemPreAlarm: 'Duración previa a la alarma',
    restoreItemPostAlarm: 'Duración posterior a la alarma',
    restoreItemRingBuffer: 'Duración del búfer circular',
    restoreItemAutoPlay: 'Reproducir el vídeo en directo al abrir el programa',
    restoreItemMaxStreams: 'Máximo de transmisiones simultáneas',
    restoreItemAlarmLinkage: 'Vinculación de alarmas (servidor de correo, destinatarios, plantillas y enfriamiento)',
    restoreItemAlarmSounds: 'Biblioteca de sonidos de alarma (tipos y archivos de audio elegidos)',
    restoreWarnStorage: 'La ruta de almacenamiento vuelve a la predeterminada. Las grabaciones y los archivos que ya están en el disco no se borran, simplemente dejan de estar referenciados; anote la ruta actual si la necesita.',
    restoreKeeps: 'La lista de dispositivos, los canales, las grabaciones y los archivos de audio, los registros de alarma, las cuentas y sus permisos no se modifican.',
    restoreConfirm: 'Restaurar',
    restoreNotice: 'Los parámetros del sistema se han restaurado. La contraseña SMTP sigue en el almacén de credenciales de este equipo; use «Borrar la contraseña guardada» en la configuración de correo para eliminarla.'

  },
  /**
   * Página de resumen — el bloque de imagen en directo.
   *
   * Separado de `cameraLiveUi` solo porque el mismo hecho se dice de otra forma en esta
   * página: el botón de la página de monitorización dice «Iniciar vídeo» y esta línea de
   * estado dice «Sin iniciar». `title` se reutiliza de `cameraLiveUi.title`.
   *
   * Misma regla que en el resto del catálogo: NINGÚN mensaje puede contener `@` (el
   * prefijo de mensaje enlazado de vue-i18n, que rompe el renderizado).
   */
  overviewLiveUi: {
    cameraLabel: 'Cámara',
    device: 'Equipo',
    fullscreen: 'Pantalla completa',
    statusNoCamera: 'Sin cámara registrada',
    statusIdle: 'Sin iniciar',
    statusStarting: 'Iniciando vídeo…',
    statusPlaying: 'Vídeo en reproducción',
    statusRtspDisabled: 'RTSP de la cámara desactivado',
    statusFfmpegMissing: 'ffmpeg integrado no disponible',
    statusError: 'Fallo del flujo de vídeo',
    statusLimitExceeded: 'Límite de directos simultáneos alcanzado',
    statusOccupied: 'La imagen está en otra página',
    noCameraHint: 'Todavía no hay ninguna cámara acústica registrada. Añada una en «Equipos».',
    idleHint: 'Todavía no se reproduce. Pulse «Iniciar vídeo» para ver la imagen de la cámara.',
    startingHint: 'Iniciando…',
    rtspDisabledHint:
      'El servicio RTSP de la cámara está desactivado (el equipo informa rtsp_enabled=0). Actívelo en «Configuración avanzada → RTSP» de la interfaz web de la cámara y vuelva a intentarlo.',
    ffmpegMissingHint:
      'El remultiplexador ffmpeg integrado falta o no se ejecuta. Reinstale la aplicación; las rutas que se probaron están en el registro de la aplicación.',
    errorHint: 'El flujo de vídeo se ha interrumpido. Pulse «Reintentar» para abrirlo de nuevo.',
    limitExceededHint:
      'Este equipo ha alcanzado su límite de directos simultáneos (ajustable en «Configuración del sistema → Vídeo en directo»). Detenga otra imagen y abra esta después.',
    occupiedHint:
      'La página de monitorización está reproduciendo esta cámara. Una cámara solo lleva una imagen a la vez, así que «Iniciar vídeo» traslada la imagen a esta página (la de la otra página se detiene).',
    diagnosis: 'Diagnóstico del proceso principal: {reason}',
    rtspAddressUnknown: 'El equipo no informó de una dirección de vídeo'
  },

  devices: {
    addDevice: 'Añadir equipo',
    empty: 'Aún no hay equipos',
    name: 'Nombre del equipo',
    ip: 'Dirección IP',
    port: 'Puerto HTTP',
    username: 'Usuario',
    password: 'Contraseña',
    testConnection: 'Probar conexión',
    saveFailed: 'No se pudo guardar',
    deleteFailed: 'No se pudo eliminar el equipo',
    status: {
      online: 'En línea',
      offline: 'Desconectado',
      unknown: 'Desconocido'
    },
    columns: {
      actions: 'Acciones'
    }
  },

  devicesUi: {
    addButton: 'Añadir equipo',
    noticeAdded: 'Equipo añadido',
    noticeUpdated: 'Equipo «{name}» actualizado',
    noticeRemoved: 'Equipo «{name}» eliminado',
    menu: 'Más acciones',
    deviceId: 'ID del equipo',
    mac: 'Dirección MAC',
    channelCount: 'Canales',
    /** Cabeceras de esas dos columnas (el propietario las escribió literalmente). */
    ipColumn: 'IP del equipo',
    channelColumn: 'Canales del equipo',
    onlineColumn: 'En línea',
    alarmCountColumn: 'Alarmas',
    ipDoubleClickHint: 'Doble clic para abrir la interfaz web del equipo',
    /** Cabecera de esa columna y etiqueta del botón con el icono del ojo. */
    viewColumn: 'Ver',
    configure: 'Configurar',
    editTitle: 'Editar equipo',
    editNameRequired: 'El nombre del equipo es obligatorio',
    editPortInvalid: 'El puerto HTTP debe ser un entero entre 1 y 65535',
    deleteTitle: 'Eliminar equipo',
    deleteBody: '¿Eliminar el equipo «{name}»? Su historial de alarmas y sus grabaciones se conservan, pero las credenciales de conexión guardadas localmente se borran.',
    removing: 'Eliminando…',
    confirmDelete: 'Eliminar'
  },

  deviceRename: {
    titleDevice: 'Cambiar el nombre del equipo',
    titleChannel: 'Cambiar el nombre del canal',
    fieldDevice: 'Nombre del equipo',
    fieldChannel: 'Nombre del canal',
    sameName: 'Introduzca un nombre diferente.',
    deviceFailed: 'No se pudo cambiar el nombre.',
    cameraHint: 'La interfaz abierta de la cámara acústica no tiene ningún punto de acceso para el nombre del equipo, así que el nombre nuevo se guarda solo en la base de datos de este ordenador. El nombre interno de la cámara no cambia y otros programas siguen viendo el anterior.',
    deviceHint: 'Este nombre se escribe en la base de datos local y también en el propio equipo acústico.',
    channelHint: 'El nombre del canal se guarda en el equipo acústico; este ordenador vuelve a leer su tabla de canales después.',
    renameBoxNotice: 'Nombre del equipo cambiado a «{name}» y escrito también en el propio equipo.',
    renameBoxRestored: 'El equipo rechazó el cambio de nombre: {reason}. El nombre local se ha restaurado a «{name}».',
    renameBoxRestoreFailed: 'El equipo rechazó el cambio de nombre: {reason}. El nombre local sigue siendo «{name}» y no se pudo restaurar; este ordenador y el equipo ya no coinciden, cámbielo a mano.',
    renameCameraNotice: 'Nombre del equipo cambiado a «{name}» solo en este ordenador (la cámara no se renombró).',
    renameChannelNotice: 'Nombre del canal cambiado a «{name}» y escrito en el equipo acústico.'
  },

  time: {
    justNow: 'Ahora mismo',
    secondsAgo: 'hace {count} segundos',
    minutesAgo: 'hace {count} minutos',
    hoursAgo: 'hace {count} horas',
    daysAgo: 'hace {count} días',
    never: 'Nunca'
  },

  duration: {
    minutesSeconds: '{minutes} min {seconds} s',
    hoursMinutes: '{hours} h {minutes} min'
  },

  alarms: {
    type: {
      spl: 'Nivel de presión sonora',
      main_frequency: 'Frecuencia principal',
      band_energy_ratio: 'Relación de energía de banda',
      smoothness: 'Suavidad',
      clamp_looseness: 'Abrazadera floja',
      cooler_anomaly_a: 'Anomalía del refrigerador A',
      cooler_anomaly_b: 'Anomalía del refrigerador B',
      overload: 'Sobrecarga',
      short_circuit_surge: 'Sobretensión por cortocircuito',
      surface_discharge: 'Descarga superficial',
      corona_discharge: 'Descarga corona',
      gap_discharge: 'Descarga en entrehierro',
      floating_discharge: 'Descarga flotante',
      dc_bias: 'Polarización de CC'
    },
    unknownMask: 'Alarma desconocida (0x{mask})',
    none: 'Sin alarma'
  },

  alarmsUi: {
    countSummary: '{total} registros, {selected} seleccionados',
    bulkAcknowledge: 'Confirmar seleccionadas',
    bulkUnacknowledge: 'Quitar confirmación',
    addSelectedToSamples: 'Añadir a la biblioteca de muestras',
    sampleAddDone:
      'Añadidas: {created} nuevas, {existing} ya estaban en la biblioteca, {withMetrics} de ellas con valores de características.',
    sampleAddPartial:
      'Añadidas: {created} nuevas, {existing} ya estaban en la biblioteca, {failed} fallidas (el registro ya no existe).',
    sampleAddedWithMetrics:
      'Añadida a la biblioteca ({count} valores de características), etiqueta débil: {label}',
    sampleAddedNoMetrics:
      'Añadida a la biblioteca, pero esta alarma no trae valores de características, así que todavía no se puede entrenar con ella.',
    sampleAlreadyIn: 'Esta ya está en la biblioteca de muestras (no se escribió dos veces).',
    sampleSectionTitle: 'Biblioteca de muestras',
    sampleSectionHint:
      'Guarda las métricas y la etiqueta débil de esta alarma en la biblioteca local para reentrenar.',
    addToSamples: 'Añadir a la biblioteca',
    goSamples: 'Abrir la biblioteca',
    filterDevice: 'Equipo',
    filterAllDevices: 'Todos los equipos',
    filterChannel: 'Canal',
    filterAllChannels: 'Todos los canales',
    filterType: 'Tipo de alarma',
    filterAllTypes: 'Todos los tipos',
    filterFrom: 'Desde',
    filterTo: 'Hasta',
    filterAck: 'Confirmación',
    ackAll: 'Todas',
    ackAcknowledged: 'Confirmadas',
    ackUnacknowledged: 'Sin confirmar',
    columnTime: 'Hora',
    columnDevice: 'Equipo',
    columnChannel: 'Canal',
    columnType: 'Tipo de alarma',
    columnStatus: 'Estado',
    selectAll: 'Seleccionar todo',
    selectRow: 'Seleccionar {id}',
    loading: 'Cargando…',
    empty: 'Ninguna alarma coincide con estos filtros',
    pagerRange: '{from} – {to} de {total}',
    prevPage: 'Anterior',
    nextPage: 'Siguiente',
    detailTitle: 'Detalles de la alarma',
    metricsTitle: 'Métricas en el momento de la alarma',
    playbackTitle: 'Reproducción de la grabación',
    goSyncRecordings: 'Vaya a Grabaciones para sincronizar las grabaciones',
    ackSectionTitle: 'Confirmación',
    markAcknowledged: 'Marcar como confirmada',
    notifyAcknowledged: 'Se confirmaron {count} alarmas',
    notifyUnacknowledged: 'Se quitaron {count} confirmaciones',
    notifyDetailAcknowledged: 'Alarma confirmada',
    notifyDetailUnacknowledged: 'Confirmación de la alarma retirada',
    filterSeverity: 'Gravedad',
    filterAllSeverities: 'Todas las gravedades',
    columnSeverity: 'Gravedad',
    severitySectionTitle: 'Gravedad',
    noteSectionTitle: 'Nota',
    noteEmpty: 'Todavía no hay nota',
    notePlaceholder: 'Escriba una nota…',
    noteSave: 'Guardar nota',
    noteClear: 'Borrar nota',
    noteTooLong: 'La nota admite como máximo {max} caracteres (ahora {length})',
    noteSaved: 'Nota guardada',
    noteCleared: 'Nota borrada',
    severitySaved: 'Gravedad cambiada a «{level}»',
    recordMissing: 'Esta alarma ya no está registrada, así que el cambio no se guardó',
    prevEvent: 'Evento anterior',
    nextEvent: 'Evento siguiente',
    eventPosition: '{index} de {total} (filtro actual)'
  },

  metrics: {
    spl: 'Nivel de presión sonora',
    mainFrequency: 'Frecuencia principal',
    smoothness: 'Suavidad',
    bandEnergyRatio: 'Relación de energía de banda',
    oddEvenHarmonicRatio: 'Relación armónica par/impar',
    spectralComplexity: 'Complejidad espectral',
    fingerprintVariation: 'Variación de huella'
  },

  recordingsUi: {
    filterType: 'Tipo de grabación',
    filterAllTypes: 'Todos los tipos',
    columnStart: 'Inicio',
    columnDevice: 'Equipo',
    columnChannel: 'Canal',
    columnType: 'Tipo',
    columnDuration: 'Duración',
    columnSampleRate: 'Frecuencia de muestreo',
    columnFormat: 'Formato',
    columnSize: 'Tamaño',
    columnDownloaded: 'Descarga',
    columnPlay: 'Reproducir',
    columnSample: 'Biblioteca de muestras',
    addToSamples: 'Añadir a la biblioteca',
    sampleHint:
      'Una grabación no trae valores de características: al añadirla puede etiquetarla, pero para entrenar también hacen falta datos de características',
    sampleAddedNoMetrics:
      'Añadida a la biblioteca. Esta grabación no tiene valores de características, así que todavía no se puede entrenar con ella; puede etiquetarla en la biblioteca de muestras.',
    sampleAlreadyIn:
      'Esta grabación ya está en la biblioteca de muestras (no se escribió dos veces).',
    empty: 'Aún no hay grabaciones. Use «Sincronizar grabaciones» para importarlas desde un equipo.',
    downloaded: 'Descargada',
    notDownloaded: 'Sin descargar',
    playLabel: 'Reproducir la grabación de {time}',
    playLocal: 'Reproducir la grabación local',
    playRemote: 'Reproducir (se descargará primero del equipo)',
    playerTitle: 'Reproducción de la grabación',
    playerTitleAt: 'Reproducción de la grabación · {time}',
    videoPlayerTitle: 'Reproducción de la grabación de vídeo',
    videoLoading: 'Abriendo el archivo de vídeo…',
    videoUnavailable: 'Esta grabación no se puede reproducir en el reproductor integrado (falta el archivo local o el formato no es compatible).'
  },

  monitorUi: {
    noDeviceTitle: 'Añada primero un equipo',
    goToDevices: 'Ir a Equipos',
    deviceLabel: 'Equipo',
    noAddress: 'sin dirección',
    channelHint: '{count} canales',
    start: 'Iniciar monitorización',
    stop: 'Detener monitorización',
    channelSelect: 'Selección de canal',
    /** Insignia de familia para la rama del sónar. */
    sonarFamilyBadge: 'Sónar de aire SN-16',
    /** Por qué esta pantalla no tiene gráfico en vivo. */
    sonarLiveUnwired:
      'Los flujos de audio/espectrograma en vivo aún no están integrados (el manual da rutas WebSocket que no hemos verificado en el equipo), así que aquí no hay gráfico en vivo: abajo están los parámetros de este equipo, la sincronización de alarmas y las grabaciones locales.',
    /** La frase que queda tras quitar la tarjeta de estado de flujos: qué vía falla. */
    streamFailure: 'La vía {name} está fallando',
    currentValue: 'valor actual en {channel}',
    /**
     * Tarjetas de características por canal. Los tres estados de lectura son mensajes
     * distintos a propósito: `stored` es una lectura PASADA y la tarjeta muestra su hora;
     * `unread` significa que nunca llegó ninguna trama.
     */
    channelFeaturesSection: 'Características de voz por canal',
    channelFeaturesHint:
      '{count} canales; la sesión se suscribe a uno cada vez, así que cada tarjeta muestra la última lectura de ese canal',
    channelFeature_live: 'En vivo',
    channelFeature_stored: 'Última lectura',
    channelFeature_unread: 'Sin leer',
    channelFeatureUnread: 'Todavía no se ha leído ninguna trama de características en este canal',
    channelFeatureUpdated: 'Actualizado {time}',
    audioSection: 'Audio en vivo',
    audioPlay: 'Reproducir',
    audioStop: 'Detener reproducción',
    audioVolume: 'Volumen',
    /** La reproducción es la envolvente decimada, no el sonido original. */
    audioPreviewHint:
      'Lo que suena es la vista previa de envolvente a 10 tramas/s (una forma de onda decimada), no el audio original.',
    startRecording: 'Iniciar grabación',
    stopRecording: 'Detener grabación',
    trendSection: 'Tendencia en vivo',
    spectrumSection: 'Espectro',
    spectrogramSection: 'Espectrograma',
    /** ③b: la tercera tarjeta — la envolvente decimada, los mismos datos que reproduce el botón. */
    waveformSection: 'Forma de onda acústica',
    waveformHint: 'Envolvente decimada de una trama de 100 ms (los mismos datos que reproduce el botón)',
    waveformAmplitude: 'Amplitud normalizada',
    waitingAudio: 'Esperando tramas de audio…',
    /** ③b: solo archivos locales — esta familia no graba de forma continua en el dispositivo. */
    playbackSection: 'Reproducción en línea de tiempo',
    playbackLocalOnly: 'Solo archivos locales (el dispositivo no graba de forma continua)',
    playbackPrevious: 'Anterior',
    playbackNext: 'Siguiente',
    playbackZoomIn: 'Acercar',
    playbackZoomOut: 'Alejar',
    playbackWindow: '{from} – {to}',
    playbackNow: 'Ahora',
    playbackLoading: 'Leyendo grabaciones locales…',
    playbackEmpty:
      'Aún no hay grabaciones de este dispositivo en este equipo (las grabaciones manuales y los vídeos de detección descargados del dispositivo aparecen aquí)',
    sampleRate: 'Frecuencia de muestreo',
    waitingFeatures: 'Esperando tramas de características en vivo…',
    waitingSpectrum: 'Esperando tramas de espectro…',
    waitingSpectrumData: 'Esperando datos de espectro…',
    sessionRunning: 'Datos en vivo en curso',
    sessionStarting: 'Iniciando el flujo…',
    sessionError: 'Error en el flujo',
    sessionStopped: 'Datos en vivo detenidos',
    spectrumPerBin: '{hz} Hz por bin',
    chartNormalizedEnergy: 'Energía normalizada',
    chartBandEnergy: 'Energía de banda'
  },

  streamState: {
    IDLE: 'Inactivo',
    CONNECTING: 'Conectando',
    STREAMING: 'Recibiendo',
    RECONNECTING: 'Reconectando',
    STOPPED: 'Detenido',
    ERROR: 'Error'
  },

  spectrum: {
  },

  trendsUi: {
    querying: 'Consultando…',
    noDeviceTitle: 'Añada primero un equipo',
    goToDevices: 'Ir a Equipos',
    filterDevice: 'Equipo',
    filterChannel: 'Canal',
    filterAllChannels: 'Todos los canales',
    noAddress: 'sin dirección',
    filterMetric: 'Métrica',
    filterAggregation: 'Agregación',
    filterFrom: 'Desde',
    filterTo: 'Hasta',
    incompleteRange: 'Seleccione una hora de inicio y una de fin',
    deviceNotSelected: 'Ningún equipo seleccionado',
    notQueried: 'Sin consultar todavía',
    latestBucket: 'Último intervalo',
    rangeMinBucket: 'Mínimo del rango',
    rangeMaxBucket: 'Máximo del rango',
    emptyBuckets: 'Intervalos vacíos',
    chartTitle: 'Curva de tendencia',
    truncated: 'El resultado alcanzó el límite de puntos, por lo que solo se muestran los primeros {count} intervalos. Reduzca el rango de tiempo para ver la curva completa.',
    noDeviceSelectedTitle: 'Seleccione primero un equipo',
    noHistoryTitle: 'Este equipo aún no tiene historial',
    goToMonitor: 'Ir a Monitorización en vivo',
    emptyRangeTitle: 'No hay datos en el rango seleccionado',
    coverageAvailable: 'Rango disponible: {range}',
    noDataInBucket: '{value} (sin datos en este intervalo)',
    sampleCount: 'Muestras: {count}',
    loadingNotice: 'Consultando datos históricos…',
    noDataNotice: 'Todavía no se han consultado datos',
    flushedNotice: 'Se escribieron {rows} filas en {files} archivos de historial',
    emptyBufferNotice: 'El búfer está vacío; no hay nada que escribir',
    statPoints: 'Puntos devueltos',
    statRows: 'Filas originales',
    statBucket: 'Tamaño del intervalo',
    statFiles: 'Archivos analizados',
    statDuration: 'Tiempo de consulta',
    statRatio: 'Relación de reducción (filas : puntos)'
  },

  aggregation: {
    avg: 'Media',
    min: 'Mínimo',
    max: 'Máximo',
    p95: 'Percentil 95'
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
    breadcrumbDevices: 'Equipos',
    notFoundTitle: 'Equipo no encontrado',
    backToList: 'Volver a la lista de equipos',
    deviceIdLabel: 'ID del equipo {id}',
    refreshing: 'Actualizando…',
    openWebUi: 'Abrir página del equipo',
    monitor: 'Monitorizar',
    tabsLabel: 'Configuración del equipo',
    tabOverview: 'Resumen',
    tabChannels: 'Canales y frecuencia de muestreo',
    tabAlarms: 'Parámetros de alarma',
    tabNetwork: 'Red',
    tabTime: 'Hora / NTP',
    tabSerial: 'RS485 / Modbus',
    tabPush: 'Envío Push',
    tabMaintenance: 'Mantenimiento',
    tabAuscultation: 'Caja de auscultación',
    /** Única pestaña de configuración del sónar: enlace PTZ. */
    tabPtz: 'Enlace PTZ',
    tabCameraDetect: 'Modo de detección',
    tabCameraAlarms: 'Estrategias de alarma',
    tabCameraMaintenance: 'Mantenimiento y actualización',
    overviewTitle: 'Resumen del equipo',
    ip: 'Dirección IP',
    httpPort: 'Puerto HTTP',
    mac: 'Dirección MAC',
    firmware: 'Versión de firmware',
    fpga: 'Versión de FPGA',
    webVersion: 'Versión web',
    channelCount: 'Cantidad de canales',
    // El equipo no informó la cantidad de canales (no son "0 canales"): `GET /get_devinfo`
    // no tiene ese campo en este firmware y el mapeador del protocolo sustituye la
    // constante 8, así que ese número no se puede atribuir al equipo.
    channelCountUnreported: 'no informado por el equipo',
    sampleRate: 'Frecuencia de muestreo',
    lastSeen: 'Última conexión',
    nameSection: 'Nombre del equipo',
    nameLabel: 'Nombre del equipo',
    saveName: 'Guardar nombre',
    nameRequired: 'El nombre del equipo es obligatorio',
    nameSaveFailed: 'No se pudo guardar el nombre del equipo',
    nameSaved: 'Nombre del equipo guardado en el dispositivo',
    refreshedAt: 'Actualizado {time}',
    webSection: 'Página del equipo'
  },

  configCommon: {
    reload: 'Volver a leer',
    revert: 'Descartar cambios',
    unsaved: 'Hay cambios sin guardar',
    saving: 'Guardando…',
    saved: 'Guardado',
    noChanges: 'No hay nada que guardar',
    enabled: 'Activado',
    disabled: 'Desactivado',
    enabledOfTotal: '{enabled} de {total} activados',
    deviceWordingPrivate: 'El equipo no documenta este campo, por lo que se muestra tal como lo devuelve',
    baudRate: 'Velocidad en baudios',
    dataBits: 'Bits de datos',
    stopBits: 'Bits de parada',
    unitPerDevice: 'La unidad es la que use el equipo; el firmware no la documenta',
    deviceTime: 'Hora del equipo',
    hostTime: 'Este equipo',
    drift: 'Diferencia',
    readAt: 'Leído a las {time}',
    channel: 'Canal',
    status: 'Estado',
    target: 'Dirección de destino',
    publicWarningTitle: 'El equipo está subiendo datos a una dirección pública.'
  },

  configTime: {
    title: 'Hora / NTP',
    syncNow: 'Sincronizar ahora',
    saveButton: 'Guardar ajustes de hora',
    saveFailed: 'No se pudieron guardar los ajustes de hora',
    syncFailed: 'Falló la sincronización horaria',
    savedNotice: 'Ajustes de hora guardados. Hora del equipo: {time}',
    syncedNotice: 'Sincronizado con este equipo. Hora del equipo: {time}',
    ntpToggle: 'Sincronización NTP',
    ntpServer: 'Servidor NTP',
    ntpServerPlaceholder: 'p. ej. pool.ntp.org',
    ntpInterval: 'Intervalo de sincronización',
    errInterval: 'El intervalo de sincronización NTP debe ser un entero de al menos 1',
    errServerRequired: 'Se requiere una dirección de servidor NTP cuando la sincronización NTP está activada',
    sameAsHost: 'En hora con este equipo',
    deviceAhead: 'El equipo va {seconds} s adelantado',
    deviceBehind: 'El equipo va {seconds} s atrasado'
  },

  configModbus: {
    title: 'Modbus',
    type: 'Tipo',
    typeOption: 'Tipo {n}',
    port: 'Puerto',
    slaveId: 'Dirección de esclavo',
    saveButton: 'Guardar configuración Modbus',
    saveFailed: 'No se pudo guardar la configuración Modbus',
    savedNotice: 'Configuración Modbus guardada',
    errPort: 'El puerto Modbus debe estar entre 1 y 65535',
    errSlaveId: 'La dirección de esclavo Modbus debe estar entre 1 y 247'
  },

  configRs485: {
    title: 'RS485',
    mode: 'Modo',
    modeOption: 'Modo {n}',
    portLeft: 'Puerto izquierdo',
    portRight: 'Puerto derecho',
    unused: '(sin usar)',
    portUnknown: 'Desconocido (el equipo no devuelve este campo)',
    portNotInList: 'El valor actual no está en la lista de puertos del equipo; se ha conservado tal cual',
    deviceAddress: 'Dirección del equipo',
    saveButton: 'Guardar configuración RS485',
    saveFailed: 'No se pudo guardar la configuración RS485',
    savedNotice: 'Configuración RS485 guardada'
  },
  configPush: {
    title: 'Envío Push',
    publicWarning: 'Uno de los destinos de envío es una dirección no privada, por lo que las características, imágenes y datos térmicos que recoge el equipo saldrán de la red local. Si no se desea, desactive el canal en la interfaz del propio equipo o cámbielo a una dirección privada.',
    unavailableTitle: 'Aún no se ha leído la configuración de envío',
    kindFeatures: 'Datos de características',
    kindAlarm: 'Eventos de alarma',
    kindImage: 'Datos de imagen',
    kindHeat: 'Datos térmicos',
    heatInterval: 'Intervalo de envío de datos térmicos',
    targetScope: 'Ámbito de la dirección de destino',
    scopePublic: 'Incluye una dirección pública',
    scopePrivate: 'Solo direcciones privadas'
  },

  configNetwork: {
    title: 'Red',
    saveButton: 'Guardar configuración de red',
    processing: 'Procesando…',
    saveFailed: 'No se pudo cambiar la configuración de red',
    mode: 'Modo de dirección',
    modeManual: 'Manual',
    modeDhcp: 'Automática (DHCP)',
    ip: 'Dirección IP',
    netmask: 'Máscara de subred',
    gateway: 'Puerta de enlace predeterminada',
    dns: 'Servidor DNS',
    legend: 'Configuración de red',
    disconnectTitle: 'Cambiar la dirección corta la conexión actual de inmediato.',
    disconnectBodyBefore: 'Tras guardar, la aplicación se reconecta al equipo en la nueva dirección y ',
    disconnectBodyStrong: 'revierte automáticamente',
    disconnectBodyAfter: ' si el equipo no responde.',
    disconnectWarning: 'Todo el proceso tarda hasta unos 45 segundos; no cierre la aplicación ni corte la alimentación del equipo mientras tanto. Si ninguna de las dos direcciones responde, el equipo solo puede recuperarse desde su interfaz local o el puerto serie.',
    progressTitle: 'Progreso',
    progressRunning: 'En curso',
    progressDone: 'Finalizado',
    confirmTitle: 'Confirmar el cambio de red',
    confirmFrom: 'La dirección del equipo cambiará de',
    confirmTo: 'a',
    confirmPortSuffix: '(puerto HTTP {port}).',
    confirmBody: 'Al guardar se interrumpe la conexión actual de inmediato. La aplicación se reconectará en la nueva dirección y verificará la configuración; si la nueva dirección no responde, revertirá a la configuración anterior e informará del resultado.',
    confirmWarning: 'Si ninguna de las dos direcciones responde, el equipo solo puede recuperarse desde su interfaz local o el puerto serie.',
    confirmAction: 'Aplicar el cambio',
    errIp: 'La dirección IP no es válida',
    errNetmask: 'La máscara de subred no es válida',
    errGateway: 'La puerta de enlace no es válida',
    errDns: 'El servidor DNS no es válido',
    errPort: '{label} debe ser un entero entre 1 y 65535',
    portHttp: 'El puerto HTTP',
    portRtsp: 'El puerto RTSP',
    portTcp: 'El puerto TCP',
    stageApplying: 'Escribiendo la nueva configuración',
    stageApplied: 'Nueva configuración escrita en el equipo',
    stageReconnecting: 'Reconectando en la nueva dirección',
    stageConnected: 'La nueva dirección respondió',
    stageVerifying: 'Verificando los valores releídos del equipo',
    stageVerified: 'La configuración está en vigor',
    stageRollingBack: 'Sin respuesta en la nueva dirección; revirtiendo',
    stageRolledBack: 'Se revirtió a la configuración anterior',
    stageUnreachable: 'Ni la dirección antigua ni la nueva respondieron'
  },
  configChannels: {
    title: 'Configuración de canales',
    countHint: '{count} canales',
    unavailableTitle: 'Aún no se ha leído la configuración de canales',
    columnChannel: 'Canal',
    columnName: 'Nombre',
    columnSensorType: 'Tipo de sensor',
    columnEnabled: 'Activado',
    columnAlarmProfile: 'Perfil de alarma',
    columnActions: 'Acciones',
    ariaName: 'Nombre de {channel}',
    ariaSensorType: 'Tipo de sensor de {channel}',
    ariaEnabled: '{channel} activado',
    ariaAlarmProfile: 'Perfil de alarma de {channel}',
    enableOn: 'Activado',
    enableOff: 'Desactivado',
    unbound: 'Sin vincular',
    errNameRequired: 'El nombre del canal es obligatorio',
    saveFailed: 'No se pudo guardar',
    sampleRateTitle: 'Frecuencia de muestreo',
    sampleRateCurrent: 'Actual: {rate}',
    sampleRateWarningBefore: 'Cambiar la frecuencia de muestreo hace que el equipo ',
    sampleRateWarningStrong: 'reinicie la adquisición',
    sampleRateWarningAfter: ', lo que interrumpe la monitorización en vivo; habrá que iniciarla de nuevo.',
    sampleRateLabel: 'Frecuencia de muestreo',
    applyRate: 'Aplicar frecuencia de muestreo',
    errRateSame: 'Elija una frecuencia de muestreo distinta de la actual',
    errRateFailed: 'No se pudo aplicar la frecuencia de muestreo',
    rateApplied: 'Frecuencia de muestreo aplicada: {rate}. Hay que reiniciar la monitorización en vivo.',
    confirmTitle: 'Confirmar el cambio de frecuencia de muestreo',
    confirmFrom: 'La frecuencia de muestreo cambiará de',
    confirmTo: 'a',
    confirmBody: 'Al aplicarla, el equipo reinicia su proceso de adquisición, por lo que la monitorización en vivo se detiene de inmediato y la que ya estuviera en marcha habrá que iniciarla de nuevo cuando el equipo se recupere.',
    applying: 'Aplicando…',
    confirmApply: 'Aplicar'
  },

  configMaintenance: {
    title: 'Mantenimiento',
    destructiveBadge: 'Acciones destructivas',
    refreshStatus: 'Actualizar estado',
    running: 'Procesando…',
    rebootTitle: 'Reiniciar equipo',
    rebootConfirmTitle: 'Confirmar el reinicio',
    rebootConfirmBody: 'El equipo se reinicia de inmediato y no puede adquirir datos mientras tanto: la monitorización en vivo se detiene (unos 30 segundos), la grabación en curso termina y no se generan alarmas hasta que vuelva. La configuración del equipo no se modifica.',
    rebootConfirm: 'Reiniciar',
    upgradeTitle: 'Actualización del sistema',
    upgradeConfirmTitle: 'Confirmar la actualización del sistema',
    upgradeConfirmBody: 'El equipo entra en su proceso de actualización del sistema y se reinicia; no está disponible durante todo el proceso y tanto la monitorización en vivo como las alarmas se detienen. No corte la alimentación del equipo durante la actualización.',
    upgradeConfirm: 'Actualizar',
    resetTitle: 'Restablecer de fábrica',
    resetConfirmTitle: 'Restablecer de fábrica',
    resetConfirmBody: 'Toda la configuración del equipo —red, canales, parámetros de alarma, RS485/Modbus, envío Push y nombre del equipo— vuelve a los valores de fábrica, y el equipo se reinicia y se desconecta. Las grabaciones y el historial de alarmas ya guardados en este ordenador no se ven afectados. Esta operación no se puede deshacer.',
    resetConfirm: 'Confirmar restablecimiento',
    resetTypePrompt: 'Escriba {code} para confirmar (distingue mayúsculas)',
    uploadTitle: 'Carga de firmware',
    uploadButton: 'Subir firmware',
    uploading: 'Subiendo…',
    uploadConfirmTitle: 'Confirmar la carga del firmware',
    uploadConfirmBody: 'Tras la carga, el equipo escribe el nuevo firmware y se reinicia; no está disponible durante la actualización. La carga puede tardar varios minutos, así que no cierre esta aplicación, no apague el equipo ni desconecte la red mientras tanto.',
    uploadConfirm: 'Subir',
    selectedFile: 'Archivo seleccionado',
    fullPath: 'Ruta completa',
    fileSize: 'Tamaño',
    sizeUnknown: 'No puede leerse antes de la carga (el renderizador no tiene acceso al sistema de archivos); el número real de bytes aparece al terminar',
    firmwareFile: 'Archivo de firmware',
    uploadProgress: 'Carga de firmware en curso; no hay valor de progreso disponible',
    errNoFile: 'Elija primero un archivo de firmware',
    noticeRebooting: 'El equipo se está reiniciando; tarda unos 30 segundos, durante los cuales aparece brevemente como desconectado.',
    noticeUpgrading: 'Se envió la orden de actualización del sistema; el equipo entra en el proceso y se reinicia.',
    noticeReset: 'Se envió la orden de restablecimiento de fábrica. El equipo vuelve a la configuración de fábrica y se reinicia; vuelva a leer su configuración después.',
    noticeUploaded: 'La carga del firmware ha terminado; el equipo comenzará la actualización y se reiniciará.',
    noticeOnline: 'El equipo vuelve a estar en línea.',
    noticeStillOffline: 'El equipo sigue sin ser accesible; actualice de nuevo en un momento.',
    chooseFirmware: 'Elegir firmware…',
    uploadWarning: 'El firmware se está subiendo. No cierre la aplicación, no apague el dispositivo ni desconecte la red. El dispositivo inicia la actualización automáticamente al terminar la subida.'
  },

  configAlarms: {
    title: 'Parámetros de alarma',
    addProfile: 'Nuevo perfil',
    unavailableTitle: 'Aún no se han leído los parámetros de alarma',
    columnName: 'Nombre',
    columnMode: 'Modo de detección',
    columnSensitivity: 'Sensibilidad',
    columnInterference: 'Supresión de interferencias',
    columnEnabledRules: 'Criterios activados',
    columnActions: 'Acciones',
    allDisabled: 'Ninguno activado',
    editProfile: 'Editar perfil de alarma',
    createProfile: 'Nuevo perfil de alarma',
    groupBasics: 'Datos básicos',
    groupSpl: 'Nivel de presión sonora',
    groupMainFrequency: 'Frecuencia principal',
    groupBandEnergy: 'Relación de energía de banda',
    labelEnable: 'Activar',
    labelLower: 'Inferior',
    labelUpper: 'Superior',
    labelThreshold: 'Umbral',
    saveProfile: 'Guardar perfil',
    deleteConfirmTitle: 'Eliminar perfil de alarma',
    deleteConfirmBody: '¿Eliminar el perfil de alarma «{name}»?',
    deleting: 'Eliminando…',
    notifyCreated: 'Perfil «{name}» creado',
    notifySaved: 'Perfil «{name}» guardado',
    notifyDeleted: 'Perfil «{name}» eliminado',
    errNameRequired: 'El nombre es obligatorio',
    errNumeric: '«{field}» debe ser un número',
    errSensitivityRange: 'La sensibilidad debe estar entre 0 y 100',
    errMainFrequencyRange: 'La frecuencia principal inferior debe ser menor que la superior',
    errBandEnergyRange: 'La relación de energía de banda inferior debe ser menor que la superior',
    errFormInvalid: 'Hay campos no válidos',
    fieldSensitivity: 'Sensibilidad',
    fieldInterferenceSuppression: 'Supresión de interferencias',
    fieldSplOverloadThreshold: 'Umbral de sobrecarga de SPL',
    fieldSplSurgeThreshold: 'Umbral de subida brusca de SPL',
    fieldSplDropThreshold: 'Umbral de caída brusca de SPL',
    fieldSplStabilityThreshold: 'Umbral de estabilidad de SPL',
    fieldMainFrequencyLower: 'Límite inferior de frecuencia principal',
    fieldMainFrequencyUpper: 'Límite superior de frecuencia principal',
    fieldBandEnergyRatioLower: 'Límite inferior de energía de banda',
    fieldBandEnergyRatioUpper: 'Límite superior de energía de banda',
    fieldBandEnergyRatioThreshold: 'Umbral de energía de banda',
    ruleOverload: 'Sobrecarga',
    ruleSurge: 'Subida brusca',
    ruleDrop: 'Caída brusca',
    ruleStability: 'Estabilidad',
    ruleMainFrequency: 'Frecuencia principal',
    ruleBandEnergy: 'Energía de banda',
    deleteWarning: 'La eliminación no se puede deshacer: los canales que usan este perfil deben vincularse a otro. Mientras algún canal lo siga referenciando, el dispositivo rechaza la eliminación; desvincúlelo antes en Configuración de canales.'
  },

  widgetsUi: {
    audioLevel: 'Nivel de audio',
    sampleRateAndFrame: 'Frecuencia de muestreo {rate} · {frame}',
    millisecondsPerFrame: '{value} ms/trama',
    recording: 'Grabando {elapsed}',
    lastRecording: 'Última grabación {elapsed}',
    peak: 'Pico',
    rms: 'RMS',
    audioUnavailable: 'El flujo de audio en vivo no está activo, así que no hay nada que medir.',
    spectrogramAlt: 'Espectrograma de {time}',
    backToLatest: 'Volver al más reciente',
    spectrogramWaiting: 'Esperando datos de espectrograma…',
    spectrogramFrames: '{count} tramas (el equipo conserva las 5 más recientes)',
    lastRefresh: 'Última actualización {time}',
    offlineUnknownSummary: '{offline} desconectados, {unknown} desconocidos',
    indicatorDevices: 'Dispositivos totales',
    indicatorOnline: 'Dispositivos en línea',
    truncated: '{text}\n… (truncado)',
    arrayOf: 'Matriz de {count}',
    emptyObject: 'Objeto vacío',
    modalClose: 'Cerrar'
  },
  domainExtra: {
    connectionType: {
      LAN: 'LAN',
      REMOTE: 'Remoto'
    }
  },

  monitorErrors: {
    selectDevice: 'Seleccione primero un equipo',
    selectStream: 'Seleccione al menos un flujo',
    startBeforeRecording: 'Inicie la monitorización en vivo antes de grabar'
  },

  rangeExtra: {
    label1h: 'Última hora',
    label24h: '24 horas',
    label7d: '7 días',
    label30d: '30 días',
    labelCustom: 'Personalizado',
    errRangeOrder: 'La hora de inicio no puede ser posterior a la de fin'
  },

  addDeviceUi: {
    title: 'Añadir equipo',
    errIpRequired: 'Introduzca la dirección IP del equipo',
    errIpRange: 'La dirección IP no es válida (cada parte debe estar entre 0 y 255)',
    errHostInvalid: 'No es una dirección IP ni un nombre de host válidos',
    errPort: 'El puerto HTTP debe ser un entero entre 1 y 65535',
    errUsername: 'Introduzca el usuario de acceso',
    errPassword: 'Introduzca la contraseña de acceso',
    errAddFailed: 'No se pudo añadir el equipo',
    defaultPort: 'Normalmente 80',
    noResponseTitle: 'El equipo no respondió',
    noResponseBody: 'La dirección es accesible pero no devolvió información de equipo que este sistema reconozca. Compruebe la IP, el puerto y el modelo del equipo.',
    probeSuccess: 'Conexión correcta',
    probeLatency: 'ida y vuelta {ms} ms',
    probeAuth: 'autenticación {strategy}',
    alreadyRegisteredTitle: 'Este equipo ya está registrado',
    firmwareVersion: 'Versión de firmware',
    fpgaWebVersion: 'Versión de FPGA / web',
    testing: 'Probando…',
    adding: 'Añadiendo…',
    kindLabel: 'Tipo de dispositivo',
    autoDetectLead: 'No hay que elegir tipo: el protocolo se detecta automáticamente a partir de la dirección (caja de voz / sónar de aire / cámara acústica) y el resultado aparece tras «Probar conexión».',
    detectedKind: 'Detectado como: {kind}',
    alreadyRegisteredBody: 'Volver a añadirlo no crea un segundo dispositivo; solo actualiza la dirección de conexión (IP / puerto). ID local del dispositivo registrado:',
    // La cantidad de canales de la prueba no la informa el equipo: la caja no tiene
    // ese campo en `GET /get_devinfo`, así que el mapeador escribe la constante del
    // protocolo. La cifra autoritativa llega de `GET /get_passageway` tras registrar.
    channelCountUnreported: 'no informado'
  },

  installUi: {
    section: 'Información de instalación (opcional)',
    sectionHint: 'Solo para equipos de localización de fuentes sonoras (sónar de aire SN-16); deje en blanco para las demás familias. Latitud/longitud en WGS84 decimal.',
    latitude: 'Latitud (°)',
    longitude: 'Longitud (°)',
    azimuth: 'Azimut (°)',
    azimuthHint: '0 = norte, en sentido horario',
    soundLevel: 'Nivel de referencia (dB)',
    soundLevelHint: 'Nivel de referencia del punto, no el umbral de alarma',
    errLatitude: 'La latitud debe estar entre -90 y 90',
    errLongitude: 'La longitud debe estar entre -180 y 180',
    errAzimuth: 'El azimut debe estar entre 0 y 360 (escriba 0 para 360)',
    errSoundLevel: 'El nivel de referencia debe estar entre -50 y 200 dB',
    point: 'Punto',
    noPoint: 'Sin registrar',
    /** Un campo vacío no se muestra nunca como 0 (la latitud 0 es una coordenada real). */
    unset: 'Sin registrar',
    /** Solo la latitud o solo la longitud: medio punto no permite orientar nada. */
    halfPoint: 'Registrado a medias (latitud y longitud van en pareja)'
  },

  /**
   * Enlace con la cúpula PTZ del sónar de aire SN-16.
   *
   * La contraseña solo se muestra como «definida / no definida» y nunca se devuelve su contenido;
   * la línea de sincronización dice que el equipo aceptó la petición (el manual no documenta el
   * cuerpo de ese endpoint).
   */
  ptzUi: {
    title: 'Enlace con cúpula PTZ',
    hint: 'Este sónar acciona una cúpula PTZ para localizar fuentes sonoras. Todo lo de abajo está en el equipo; no se escribe nada hasta pulsar Guardar.',
    fieldEnabled: 'Activar enlace con la cúpula',
    enabledHint: 'Si se desactiva, el sónar deja de accionar la cúpula',
    fieldCameraIp: 'IP / nombre de la cúpula',
    fieldCameraPort: 'Puerto de la cúpula',
    fieldCameraUser: 'Cuenta de la cúpula',
    fieldCameraPassword: 'Contraseña de la cúpula',
    passwordSet: 'Definida',
    passwordUnset: 'No definida',
    passwordHint: 'Nunca se muestra; déjelo vacío para no cambiarla',
    passwordState: 'Estado de la contraseña',
    fieldDirection: 'La cúpula apunta como el sónar',
    directionHint: 'Desactivado significa que apunta al lado contrario',
    fieldSaveSnapshot: 'Guardar captura al alarmar',
    saveSnapshotHint: 'Si se desactiva, las alarmas no tienen imagen que abrir',
    fieldChannel: 'Canal de escucha en vivo',
    channelHint: '1 – {max} (número de canales que informa el equipo)',
    channelHintUnknown: 'El equipo no informa el número de canales, así que no se aplica límite',
    cameraInitialised: 'Cúpula inicializada',
    unknown: 'Sin leer',
    yes: 'Sí',
    no: 'No',
    save: 'Guardar en el equipo',
    syncing: 'Sincronizando…',
    syncTime: 'Sincronizar hora con la cúpula',
    unsaved: 'Hay cambios sin guardar',
    nothingChanged: 'No hay cambios que guardar',
    saved: 'Escrito en el equipo y verificado por relectura',
    savedPartly: 'Escrito en el equipo, pero {count} elemento(s) no coinciden al releer (ver abajo)',
    readBackTitle: 'Verificación por relectura',
    allApplied: 'Todo aplicado',
    someFailed: 'Algún elemento no se aplicó',
    applied: 'Aplicado',
    expectedActual: 'No aplicado: se esperaba {expected}, el equipo informa {actual}',
    passwordNotCompared: 'La contraseña solo se comprueba como «definida»: su contenido no se devuelve, así que no se puede comparar.',
    timeSyncAccepted: 'El equipo aceptó la petición de sincronización (el manual no documenta el cuerpo de este endpoint; se envió un objeto vacío).',
    timeSyncRejected: 'El equipo no aceptó la petición de sincronización.',
    errCameraIp: 'La dirección de la cúpula debe ser una IPv4 o un nombre de host',
    errCameraPort: 'El puerto de la cúpula debe estar entre 1 y 65535',
    errCameraUser: 'La cuenta de la cúpula no puede estar vacía',
    errRealtimeChannel: 'El canal en vivo debe estar dentro del número de canales del equipo'
  },

  /** Mapa de dispositivos sin conexión (lote 8). El fondo se dibuja solo con los puntos WGS84 grabados. */
  mapUi: {
    mapTitle: 'Mapa de dispositivos',
    counts: '{withPoint} de {total} equipos en el mapa',
    noPoints: 'Ningún equipo tiene punto registrado. Rellene latitud/longitud en Equipos → Editar → Información de instalación y el equipo aparecerá aquí.',
    selectHint: 'Pulse un marcador para ver ese equipo: posición, alarmas y capturas.',
    withoutPointTitle: 'Equipos sin punto ({count})',
    withoutPointHint: 'No están en el mapa: sin punto no hay posición que dibujar. Pulse un nombre para abrir ese equipo y registrarlo.',
    pickOne: 'Todavía no hay equipo seleccionado.',
    point: 'Punto',
    alarmsTitle: 'Alarmas y capturas',
    alarmCount: 'últimas {count}',
    noAlarms: 'Aún no hay alarmas de este equipo localmente. Use «Sincronizar alarmas» arriba.',
    sync: 'Sincronizar alarmas',
    syncing: 'Sincronizando…',
    syncOutcome: 'Revisadas {created} nuevas y {existing} ya guardadas; {linked} alarma(s) ya tienen capturas en local; {missing} no tenían archivos en el equipo.',
    hasSnapshot: 'Con capturas',
    noSnapshot: 'Sin captura',
    snapshotTitle: 'Capturas',
    snapshotCount: '{count} imagen(es)',
    snapshotLoading: 'Leyendo capturas…',
    snapshotNotCaptured: 'Esta alarma no tiene captura en el equipo (no se descargó al sincronizar, o la cúpula no tiene activado «guardar captura al alarmar»).',
    snapshotFilesGone: 'La base de datos registra capturas de esta alarma, pero los archivos ya no están en este equipo (cambió el directorio de almacenamiento o se limpiaron).',
    sonarHint: 'Las capturas del sónar de aire vienen de la cúpula PTZ enlazada: una por segundo, hasta tres.'
  },

  /** Biblioteca local de muestras de huella acústica (esquema v8: dos dimensiones de etiqueta). */
  samplesUi: {
    statTotal: "Muestras",
    statTrainable: "Utilizables para entrenar",
    statFaultHuman: "Fallo: humana",
    statEquipmentHuman: "Equipo: humana",
    statFaultDevice: "Fallo: criterio del equipo",
    statFaultAi: "Fallo: sugerencia de IA",
    statEquipmentUnlabelled: "Equipo sin etiqueta",
    filterSource: "Origen",
    filterLabelSource: "Origen de la etiqueta de fallo",
    filterEquipmentLabel: "Tipo de equipo",
    filterFaultLabel: "Tipo de fallo",
    filterAll: "Todas",
    source_alarm: "Alarma",
    source_manual: "Grabación manual",
    source_import: "Importada",
    labelSource_human: "Humana",
    labelSource_device: "Criterio del equipo",
    labelSource_ai: "Sugerencia de IA",
    dimension_equipment: "Tipo de equipo",
    dimension_fault: "Tipo de fallo",
    labelsTitle: "Biblioteca de etiquetas",
    labelsHint:
      "Al etiquetar puede elegir un nombre de aquí o escribir uno nuevo (se añade automáticamente)",
    labelsEmpty: "Todavía no hay etiquetas; añada una abajo",
    labelUsedBy: "{count} muestras la usan",
    labelRename: "Renombrar",
    labelAdd: "Añadir",
    labelNewPlaceholder: "Nombre de la nueva etiqueta",
    labelAdded: "Se añadió «{name}»",
    labelExists: "«{name}» ya está en la biblioteca de etiquetas",
    labelRenamed: "Renombrada a «{name}» y actualizadas {count} muestras",
    labelRenameFailed: "No se pudo renombrar: esta dimensión ya tiene una etiqueta con ese nombre",
    labelRemoved: "Se eliminó «{name}»",
    labelRemoveFailed: "No se pudo eliminar",
    labelInUse: "«{name}» todavía la usan {count} muestras, así que no se puede eliminar",
    trainButton: "Entrenar y evaluar",
    trainingTitle: "Resultado del entrenamiento (dejando uno fuera)",
    trainingSamples: "Entrenada con",
    trainingAccuracy: "Exactitud dejando uno fuera",
    trainingExcluded: "Excluidas",
    trainingExcludedValue: "{noLabel} sin tipo de fallo · {missingMetrics} sin características",
    trainingEquipment: "Tipos de equipo en el conjunto de entrenamiento",
    trainingEquipmentValue: "{kinds} tipo(s) · {unassigned} sin etiqueta",
    trainingDegenerate: "Solo hay una clase, así que la exactitud es del 100% por construcción y no aporta información.",
    trainingUnassessable: "Las clases con menos de 2 muestras no pueden evaluarse dejando uno fuera: {labels}. Su exactitud no forma parte de la cifra anterior.",
    trainingMixedEquipment:
      "El conjunto de entrenamiento contiene más de un tipo de equipo: una misma clase de fallo puede no ser el mismo fenómeno en equipos distintos, lo que baja la exactitud.",
    trainingTruncated: "Hay más muestras que el límite de entrenamiento; solo se usó la primera parte.",
    trainingConfusion: "Matriz de confusión (solo entradas distintas de cero)",
    trainingConfusionRow: "etiquetada {expected} → predicha {predicted}: {count}",
    columnTime: "Hora",
    columnDevice: "Equipo",
    columnChannel: "Canal",
    columnSource: "Origen",
    columnEquipment: "Tipo de equipo",
    columnFault: "Tipo de fallo",
    columnMetrics: "Características",
    columnActions: "Acciones",
    loading: "Cargando…",
    empty: "La biblioteca está vacía. Añada un registro desde la lista de alarmas o desde la página de grabaciones.",
    unlabelled: "Sin etiqueta",
    metricsCount: "{count} dim.",
    metricsHint: "Dimensiones que el equipo sí informó; las que faltan nunca se rellenan con 0",
    blockedNoLabel: "Sin tipo de fallo, no se puede entrenar",
    blockedMissingMetrics: "Faltan características: {metrics}",
    editLabel: "Editar etiquetas",
    clearEquipment: "Quitar el tipo de equipo",
    clearFault: "Quitar el tipo de fallo",
    labelSaved: "Etiquetas guardadas",
    labelCleared: "Etiqueta quitada",
    removed: "Muestra eliminada",
    exportTitle: "Exportar conjunto de datos",
    exportOnlyLabelled: "Exportar solo las muestras etiquetadas",
    exportCopyAudio: "Copiar también los archivos de audio",
    exportButton: "Exportar conjunto de datos…",
    exporting: "Exportando…",
    exportDone: "Se exportaron {samples} muestras ({labelled} etiquetadas) a:",
    exportSkipped: "Se omitieron {count} muestras sin etiquetar.",
    exportAudio: "Se copiaron {copied} archivos de audio ({bytes}).",
    exportAudioSkipped:
      "Audio no copiado: las rutas del manifiesto apuntan al directorio de almacenamiento de este equipo. Marque «Copiar también los archivos de audio» para usarlas en otro equipo.",
    exportAudioMissing:
      "{count} archivos de audio ya no están en el directorio de almacenamiento; el manifiesto los marca como audio_missing.",
    exportFiles: "El directorio contiene samples.jsonl, samples.csv y dataset-info.json.",
    aiTitle: "Etiquetado por IA (opcional)",
    aiReady: "Configurado",
    aiUnknown: "No se pudo leer la configuración",
    aiBlockedDisabled: "Desactivado",
    aiBlockedNoEndpoint: "Falta la dirección del servicio",
    aiBlockedBadEndpoint: "Dirección no válida (debe empezar por http:// o https://)",
    aiBlockedNoModel: "Falta el nombre del modelo",
    aiEnabled: "Activar el etiquetado por IA",
    aiEndpoint: "Dirección del servicio",
    aiEndpointPlaceholder: "https://host/v1/chat/completions",
    aiModel: "Modelo",
    aiModelPlaceholder: "Nombre del modelo",
    aiApiKey: "Clave de API",
    aiKeyStored: "guardada",
    aiKeyAbsent: "no guardada",
    aiApiKeyPlaceholder: "Dejar vacío para no cambiar la clave guardada",
    aiNoEncryption:
      "El cifrado del sistema no está disponible, así que la clave no se puede guardar (solo la dirección y el modelo).",
    aiSave: "Guardar configuración",
    aiSaved: "Configuración guardada",
    aiClearKey: "Borrar la clave",
    aiIncludeWeak: "Incluir muestras con etiqueta débil del equipo",
    aiRun: "Etiquetar con IA",
    aiRunning: "Etiquetando…",
    aiCandidateNote:
      "La IA propone candidatos: no sobrescribe el etiquetado humano ni entra en el conjunto de entrenamiento; hay que confirmarlo cambiando la etiqueta a humana.",
    aiOverwriteWarning:
      "Está activado sobrescribir la etiqueta débil del equipo: el juicio del mapa de bits se sustituirá por una suposición de la IA y no se podrá recuperar desde esa muestra.",
    aiOutcome:
      "Se revisaron {considered} muestras, se consultaron {requested} al modelo y se escribieron {labelled} etiquetas candidatas.",
    aiOutcomeBreakdown:
      "Omitidas {human} con etiqueta humana · {weak} con etiqueta débil · {unresolved} sin decisión de la IA · {failed} con error",
    pagerRange: "{shown} en esta página / {total} en total"
  },
  /** Familia de auscultación (E2 / FA100 / FA110 / Air Sonar): el canal de sondeo. */
  e2Ui: {
    statusTitle: 'Estado del equipo',
    variant: 'Generación del protocolo',
    variant_auscultation: 'Caja de auscultación (protocolo 2023)',
    variant_airSonar: 'Sónar de aire SN-16 (protocolo V3.2)',
    variantUnknown: 'Generación no reconocida (el equipo no informó nada concluyente)',
    mode: 'Modo de trabajo',
    modeNotApplicable: 'Esta generación no tiene modo de trabajo',
    modeUnknown: 'El equipo no informó ningún modo de trabajo',
    mode_burst_of_loud_sound: 'Ruidos fuertes repentinos',
    mode_rotating_equipment: 'Equipos rotativos',
    mode_electrical_power_equipment: 'Equipos eléctricos',
    samplerate: 'Frecuencia de muestreo',
    channelCount: 'Canales',
    spectrogramSize: 'Tamaño del espectrograma',
    deviceType: 'Modelo',
    firmware: 'Firmware',
    retention: 'Retención de registros',
    retentionValue: 'El equipo conserva los últimos {count}',
    paramsError: 'No se pudo leer todo el estado del equipo: {reason}',
    paramsEmpty: 'El equipo no devolvió ningún parámetro.',
    paramColumn: 'Parámetro',
    valueColumn: 'Valor actual',
    paramExtra: 'Clave adicional del equipo',
    paramValueHidden: 'definida (no se muestra)',
    param_db_limit: 'Umbral de decibelios (db_limit)',
    param_tde_ratio_limit: 'Umbral de energía en el tiempo (tde_ratio_limit)',
    param_fde_ratio_limit: 'Umbral de energía en frecuencia (fde_ratio_limit)',
    param_freq_down_limit: 'Límite inferior de banda (freq_down_limit)',
    param_freq_up_limit: 'Límite superior de banda (freq_up_limit)',
    param_hpss_limit: 'Umbral de componente armónico (hpss_limit)',
    param_main_freq_limit: 'Umbral de frecuencia principal (main_freq_limit)',
    param_sc_ratio_limit: 'Umbral de complejidad espectral (sc_ratio_limit)',
    param_sc_ratio_threshold: 'Criterio de complejidad espectral (sc_ratio_threshold)',
    param_samplerate: 'Frecuencia de muestreo (samplerate)',
    param_notify_url: 'Dirección de retorno de alarmas (notify_url)',
    param_is_send_alarm: 'Enviar alarmas (is_send_alarm)',
    param_is_send_fft: 'Enviar análisis en vivo (is_send_fft)',
    param_cam_enable: 'Cámara PTZ activada (cam_enable)',
    param_cam_ip: 'Dirección de la cámara (cam_ip)',
    param_cam_port: 'Puerto de la cámara (cam_port)',
    param_cam_user: 'Cuenta de la cámara (cam_user)',
    param_cam_pass: 'Contraseña de la cámara (cam_pass)',
    param_cur_realtime_channel: 'Canal de escucha en vivo (cur_realtime_channel)',
    param_is_cam_init: 'Cámara inicializada (is_cam_init)',
    param_is_ptz_direction_same_with_sonar:
      'La dirección de la cámara coincide con el sonar (is_ptz_direction_same_with_sonar)',
    param_is_save_snapshot: 'Captura al alarmar (is_save_snapshot)',
    param_is_send_realtime_value: 'Enviar valores de cálculo en vivo (is_send_realtime_value)',
    syncTitle: 'Sincronización de alarmas',
    syncHint:
      'Trae el registro de alarmas y las grabaciones del equipo (conserva los últimos {count}). Volver a sincronizar no duplica registros.',
    syncSpectrograms: 'Descargar también los espectrogramas',
    syncSnapshots: 'Descargar también las capturas PTZ',
    syncButton: 'Sincronizar alarmas',
    syncing: 'Sincronizando…',
    outcomeAlarms: 'Se revisaron {seen} registros: {created} añadidos, {existing} ya guardados.',
    outcomeAudio: 'Grabaciones: {saved} descargadas, {existing} ya locales, {failed} fallidas.',
    outcomeFilesMissing:
      '{count} de ellos ya no tienen archivo en el equipo (files_status = 0); solo se guardó la alarma.',
    outcomeSpectrograms:
      'Espectrogramas: {saved} guardados, {failed} ausentes en el equipo (menos de 10 tras un reinicio es normal).',
    outcomeSnapshots:
      'Capturas PTZ: {saved} guardadas, {failed} ausentes (0 si la cámara no está emparejada o la captura está desactivada).',
    outcomeBadTime: '{count} registros tenían una hora ilegible y se omitieron (no se adivinó su momento).',
    outcomeHint: 'Sincronizado a las {time}'
  },
  playerUi: {
    missingTitle: 'Este registro no tiene archivo de grabación local',
    missingBody: 'Una alarma solo guarda sus métricas y su tipo; la grabación debe sincronizarse desde el equipo. Abra la página Grabaciones, pulse «Sincronizar grabaciones» para importar los metadatos y archivos del equipo, y vuelva aquí para reproducirla.',
    errMissingFile: 'Este registro no tiene archivo de grabación local, por lo que no se puede reproducir',
    errNoData: 'El proceso principal no devolvió datos de audio',
    errDecode: 'No se pudo decodificar el audio: {detail}',
    loading: 'Cargando la grabación…',
    reload: 'Recargar',
    play: 'Reproducir grabación',
    release: 'Detener la reproducción',
    downloading: 'Descargando y decodificando el audio del equipo, unos {size}; espere…',
    autoplayBlocked: 'Cargado, pero el navegador no inició la reproducción automáticamente. Use el botón de reproducir de abajo.',
    leadShort: 'Se pidió empezar {requested} s antes de la alarma, pero esta grabación solo tiene {actual} s antes, así que empieza al principio del clip.',
    fewMegabytes: 'unos pocos MB',
    channelCount: 'Canales',
    channelCountValue: '{count} canales',
    encoding: 'Codificación',
    waveformTitle: 'Previsualización de onda',
    waveformAria: 'Previsualización de la forma de onda',
    waveformMissing: 'Esta reproducción no incluyó previsualización de onda.',
    spectrumTitle: 'Instantánea del espectro',
    spectrumMissing: 'Esta reproducción no incluyó instantánea del espectro.'
  },

  labUi: {
    noticeDone: 'Diagnóstico completado; resultados abajo',
    errSelectDevice: 'Seleccione primero un equipo',
    errPathRequired: 'Introduzca una ruta que sondear, por ejemplo /get_devinfo',
    endpointNotProbed: 'Este diagnóstico no sondeó ese endpoint.',
    requestFailed: 'La solicitud falló: {detail}',
    httpNoResponse: 'sin respuesta',
    contentTypeMissing: 'sin Content-Type declarado',
    chunkedUnknown: 'codificación por bloques sin determinar',
    chunkedYes: 'usa codificación por bloques',
    chunkedNo: 'sin codificación por bloques',
    bytesUnknown: 'recuento de bytes no registrado',
    bytesReceived: '{count} bytes recibidos',
    jsonFields: 'Campos JSON: {fields}',
    summarySeparator: '; ',

    risk1Title: 'Riesgo 1: cómo se transporta el token de sesión',
    risk1Question: 'La documentación solo indica que /login devuelve un token; nunca dice cómo lo llevan las peticiones posteriores.',
    risk1Confirmed: 'Transporte confirmado: {strategy}; la respuesta de login {tokenState} un campo de token.',
    risk1Pending: 'Sin confirmar. Ejecute primero un diagnóstico; si fallan todos los transportes candidatos, habrá que capturar tráfico en el equipo.',
    risk2Title: 'Riesgo 2: formato de trama de /audio_stream',
    risk2Question: 'El encapsulado del flujo de audio, el formato de muestreo y la estrategia de bloques no están documentados.',
    risk2Pending: 'Sin confirmar. El endpoint no devolvió una respuesta utilizable y no puede suponerse que sea PCM por bloques.',
    risk3Title: 'Riesgo 3: estructura de datos de /freq_domain y /time_freq_domain',
    risk3Question: 'Se desconocen los nombres de campo y las dimensiones de los dos endpoints de frecuencia, así que analizarlos directamente perdería datos en silencio.',
    risk3Pending: 'Sin confirmar. Sondee ambos endpoints por separado y revise las muestras sin procesar.',
    risk4Title: 'Riesgo 4: cómo se compone la URL de descarga de grabaciones',
    risk4Question: 'La ruta de grabación que devuelve el equipo no puede convertirse directamente en una URL descargable; se desconoce si necesita prefijo o puerto.',
    risk4Pending: 'Sin confirmar. Sondee la lista de grabaciones y el endpoint de descarga, confirme la forma de la ruta y solo entonces implemente la descarga.',
    risk5Title: 'Riesgo 5: el significado del puerto 0',
    risk5Question: 'El ejemplo de set_network muestra el puerto 0 y no es posible saber si significa «puerto predeterminado» o «deshabilitar este servicio».',
    risk5Pending: 'Requiere prueba en equipo real: escriba el puerto 0, vuelva a leer la configuración de red y observe si el equipo cambia realmente el puerto en el que escucha. Hasta resolverlo, esta aplicación no escribirá un puerto 0 en ningún equipo.',

    introTitle: 'Para qué sirve esta página',
    chipAuth: 'Transporte del token',
    chipAudioFraming: 'Tramas de /audio_stream',
    chipFreqSchema: 'Esquema de frecuencia',
    chipDownloadUrl: 'URL de descarga',
    chipPortZero: 'Significado del puerto 0',

    noDeviceTitle: 'Añada primero un equipo',
    goToDevices: 'Ir a Equipos',
    targetTitle: 'Objetivo del diagnóstico',
    deviceLine: 'ID del equipo {uid} · {address}',
    noAddress: 'sin dirección',
    deviceLabel: 'Equipo',
    diagnosing: 'Diagnosticando…',
    runDiagnosis: 'Ejecutar diagnóstico',

    customTitle: 'Sondear un endpoint propio',
    pathLabel: 'Ruta',
    pathPlaceholder: 'p. ej. /get_devinfo',
    methodLabel: 'Método',
    probing: 'Sondeando…',
    probe: 'Sondear',
    ok: 'Correcto',
    failed: 'Fallo',
    httpStatus: 'Estado HTTP',
    elapsed: 'Duración',
    chunked: 'Por bloques',
    yes: 'Sí',
    no: 'No',
    receivedBytes: 'Bytes recibidos',
    error: 'Error',

    reportTitle: 'Informe del diagnóstico',
    detectedAuth: 'Autenticación detectada',
    unconfirmed: 'Sin confirmar',
    loginTokenPresent: 'El login devuelve token',
    tokenPresent: 'presente',
    tokenAbsent: 'no encontrado',
    loginResponseFields: 'Campos de la respuesta de login',

    endpointsTitle: 'Resultados por endpoint',
    endpointCount: '{count} endpoints',
    columnPath: 'Ruta',
    columnMethod: 'Método',
    columnResult: 'Resultado',
    columnStatus: 'Estado',
    columnElapsed: 'Duración',
    columnChunked: 'Bloques',
    columnBytes: 'Bytes',
    columnError: 'Error',
    noEndpointResults: 'El diagnóstico no devolvió resultados por endpoint.',

    samplesTitle: 'Muestras sin procesar',
    unknownType: 'tipo desconocido',

    conclusionsTitle: 'Conclusiones',
    confirmed: 'Confirmado',
    pendingConfirmation: 'Pendiente'
  },

  authUi: {
    username: "Usuario",
    password: "Contraseña",
    signIn: "Iniciar sesión",
    signingIn: "Iniciando sesión…",
    rememberPassword: "Recordar la contraseña",
    rememberExpired: "La contraseña recordada tiene más de {days} días; vuelva a escribirla.",
    rememberUnavailable: "El cifrado del sistema no está disponible en este equipo, así que la contraseña no se recordará (el nombre de usuario sí).",
    signOut: "Cerrar sesión",
    signedInAs: "Sesión iniciada como",
    mustChangeTitle: "Cambie la contraseña de fábrica",
    changeTitle: "Cambiar contraseña",
    currentPassword: "Contraseña actual",
    newPassword: "Nueva contraseña",
    confirmPassword: "Confirmar nueva contraseña",
    changeSubmit: "Guardar contraseña",
    changing: "Guardando…",
    changeSuccess: "Contraseña cambiada",
    recoverLink: "¿Olvidó su contraseña?",
    recoverTitle: "Restablecer con una supercontraseña",
    installId: "Identificador de instalación",
    copy: "Copiar",
    copied: "Copiado",
    superPassword: "Supercontraseña",
    recoverSubmit: "Restablecer contraseña",
    recovering: "Restableciendo…",
    recoverSuccess: "Contraseña restablecida. Inicie sesión con la nueva.",
    backToLogin: "Volver al inicio de sesión",
    errUsername: "Introduzca un usuario",
    errPassword: "Introduzca una contraseña",
    errCurrentPassword: "Introduzca su contraseña actual",
    errNewPassword: "Introduzca una contraseña nueva",
    errPasswordMismatch: "Las dos contraseñas nuevas no coinciden",
        errPasswordLength: "La contraseña debe tener al menos {min} caracteres",
    errPasswordWhitespace: "La contraseña no puede empezar ni terminar con un espacio",
    errPasswordHasUsername: "La contraseña no puede contener el usuario",
    errSuperPassword: "Introduzca la supercontraseña"
  },

  usersUi: {
    title: "Cuentas",
    addUser: "Nueva cuenta",
    username: "Usuario",
    displayName: "Nombre visible",
    role: "Rol",
    lastLogin: "Último acceso",
    neverLoggedIn: "Nunca",
    pendingPasswordChange: "Cambio de contraseña pendiente",
    create: "Crear",
    creating: "Creando…",
    created: "Cuenta creada; deberá cambiar la contraseña en el primer acceso",
    resetPassword: "Restablecer contraseña",
    resetTitle: "Restablecer la contraseña de {name}",
    resetSubmit: "Restablecer",
    resetDone: "Contraseña restablecida",
    deleteUser: "Eliminar cuenta",
    deleteConfirm: "¿Eliminar la cuenta {name}? No se puede deshacer.",
    cannotDeleteSelf: "No puede eliminar la cuenta con la que ha iniciado sesión",
    empty: "Todavía no hay otras cuentas."
  },

  /**
   * Gestión de cuentas (manual §17.1, p177-178).
   */
  accountUi: {
    title: 'Gestión de cuentas',
    adminOnly: 'Solo un administrador puede gestionar cuentas',
    editUser: 'Editar cuenta',
    saved: 'Cuenta guardada',
    deleted: 'Cuenta eliminada',
    empty: 'Todavía no hay ninguna cuenta.',
    permissions: 'Permisos',
    permissionScopeCount: '{count} operación(es) dependen de este permiso',
    permissionScopeNone: 'Esta versión aún no tiene el canal de operación correspondiente',
    createPermissionsHint: 'Por defecto solo se marcan los permisos de lectura; los de escritura se marcan a mano',
    adminAllPermissions: 'Una cuenta de administrador tiene todos los permisos por defecto',
    copyFrom: 'Copiar permisos',
    copyFromPlaceholder: 'Copiar permisos de…',
    defaultPermission: 'Permisos predeterminados',
    permissionsCopied: 'Permisos copiados de «{name}»; pulse Guardar para aplicarlos',
    permissionsDefaulted: 'Permisos predeterminados restaurados; pulse Guardar para aplicarlos',
    errCopySource: 'Elija primero la cuenta de la que copiar los permisos',
    errUsernameForbidden: 'El nombre de usuario no puede contener: {chars}',
    errUsernameTooLong: 'El nombre de usuario no puede superar los {max} caracteres',
    errTooManyAccounts: 'Se pueden crear como máximo {max} cuentas',
    builtInAdminUndeletable: 'El administrador integrado no se puede eliminar, pero su contraseña sí se puede cambiar',
    rules: 'El nombre de usuario no puede contener {chars}; la contraseña no puede tener menos de {min} caracteres; como máximo {max} cuentas; el administrador integrado no se puede eliminar.'
  },

  /**
   * Biblioteca de sonidos de alarma (manual §17.2.7, p185).
   */
  alarmSoundUi: {
    title: 'Sonido de alarma',
    addCustom: 'Añadir sonido personalizado',
    defaultColumn: 'Predeterminado',
    typeColumn: 'Tipo',
    fileColumn: 'Archivo de audio',
    predefined: 'Predefinido',
    predefinedUndeletable: 'Un tipo de sonido predefinido no se puede eliminar',
    noFile: 'Sin seleccionar',
    pickFile: 'Elegir archivo',
    clearFile: 'Quitar',
    preview: 'Probar',
    previewing: 'Probando: {name}',
    customDefaultName: 'Sonido personalizado {count}',
    renameHint: 'Doble clic para cambiar el nombre',
    deleted: 'Sonido personalizado eliminado; pulse Guardar para aplicarlo',
    defaultSet: '«{name}» es ahora el sonido predeterminado; pulse Guardar para aplicarlo',
    defaultIs: 'Sonido predeterminado: {name}',
    filePicked: '{name} seleccionado; pulse Guardar para aplicarlo',
    onlyWav: 'El archivo de audio solo puede ser {ext}',
    errOnlyWav: 'El archivo de audio solo puede ser {ext}',
    errOnlyWavFor: 'El archivo elegido para «{name}» no es {ext}',
    errNoFile: 'Elija primero un archivo de audio para este sonido',
    errPreview: 'No se puede reproducir este archivo de audio; compruebe que sea un WAV válido',
    errEmptyName: 'El nombre del sonido no puede estar vacío',
    errPredefinedUndeletable: 'Un tipo de sonido predefinido no se puede eliminar',
    summary: '{total} entradas ({custom} personalizadas), {files} con archivo de audio'
  },

  /**
   * Configuración de correo (manual §17.2.8, p186).
   */
  emailUi: {
    title: 'Configuración de correo',
    host: 'Servidor SMTP',
    port: 'Puerto',
    portHint: 'Por defecto 25; con SSL suele ser 465',
    security: 'Seguridad de la conexión',
    securityNone: 'Ninguna',
    securitySsl: 'SSL',
    securityStarttls: 'STARTTLS',
    authentication: 'Autenticación del servidor',
    username: 'Nombre de usuario',
    password: 'Contraseña',
    passwordState: 'Contraseña guardada',
    clearPassword: 'Borrar la contraseña guardada',
    passwordCleared: 'Se ha borrado la contraseña SMTP guardada en este equipo',
    from: 'Dirección del remitente',
    receiversSection: 'Destinatarios',
    receiverN: 'Destinatario {n}',
    receiversHint: 'Hasta {max} destinatarios',
    templateSection: 'Contenido del mensaje',
    sendTest: 'Enviar correo de prueba',
    testFailed: 'No se pudo enviar el correo de prueba',
    saveSuccessWithPassword: 'Configuración guardada; la contraseña SMTP está en el almacén de credenciales de este equipo',
    errHost: 'Escriba la dirección del servidor SMTP',
    errPort: 'El puerto debe ser un entero entre 1 y 65535',
    errUsername: 'La autenticación del servidor exige un nombre de usuario',
    errFrom: 'Escriba la dirección del remitente',
    errFromFormat: 'La dirección del remitente no es válida',
    errRecipients: 'Escriba al menos un destinatario',
    errTooManyRecipients: 'Se pueden escribir como máximo {max} destinatarios',
    errRecipientFormat: 'Esta dirección de destinatario no es válida: {value}'
  },

  channelState: {
    enabled: 'Habilitado',
    disabled: 'Deshabilitado',
    unknown: 'Estado desconocido',
    disabledHint: 'Este canal está deshabilitado y no participa en el monitoreo en vivo',
    unknownHint: 'Todavía no se ha leído el estado de habilitación de este canal; actualice el dispositivo',
    liveActive: 'Recibiendo datos',
    liveSilent: 'Sin datos recibidos',
    enabledSummary: '{enabled} de {total} canales habilitados'
  },

  domain: {
    sensorType: {
      microphone: 'Micrófono',
      conduction: 'Conducción'
    },
    detectionMode: {
      characteristic: 'Detección por características',
      ai: 'Detección por IA'
    },
    recordingType: {
      alarm: 'Grabación de alarma',
      manual: 'Grabación manual',
      scheduled: 'Grabación programada'
    },
    streamKind: {
      features: 'Características en vivo',
      audio: 'Audio en vivo',
      spectrum: 'Espectro',
      spectrogram: 'Espectrograma'
    },
    deviceKind: {
      acousticBox: 'Caja acústica',
      acousticCamera: 'Cámara acústica',
      auscultationBox: 'Caja de auscultación / Sónar de aire SN-16'
    },
    eventSource: {
      deviceDetect: 'Registro de detección de la cámara',
      linkage: 'Vinculación local de alarmas',
      localAlarm: 'Alarma de la caja acústica'
    },
    eventSeverity: {
      info: 'Información',
      warning: 'Advertencia',
      critical: 'Crítico',
      unknown: 'Nivel desconocido'
    },
    eventKind: {
      deviceDetect: 'Detección completada',
      deviceDetectAlarm: 'Detección que el equipo marcó como alarma',
      linkageAlarm: 'Alarma por vinculación local',
      localAlarm: 'Alarma de la caja acústica'
    },
    detectFileKind: {
      power_spectrum_photo: 'Imagen del espectro de potencia',
      power_spectrum_video: 'Vídeo del espectro de potencia',
      soundmap_photo: 'Imagen del mapa sonoro',
      soundmap_video: 'Vídeo del mapa sonoro',
      voiceprint_photo: 'Imagen de huella acústica',
      voiceprint_video: 'Vídeo de huella acústica',
      bin_mic_data: 'Datos binarios del micrófono',
      wav_mic_data: 'Audio WAV del micrófono'
    },
    eventDownloadStage: {
      starting: 'Preparando',
      fetching: 'Descargando del equipo',
      verifying: 'Verificando el archivo',
      registering: 'Registrando la grabación',
      done: 'Descarga completada',
      reused: 'Ya está local, se reutiliza',
      failed: 'Fallo en la descarga'
    },
    userRole: {
      admin: 'Administrador',
      operator: 'Operador'
    },
    /**
     * Permisos de cuenta (manual §17.1, las casillas de permisos).
     */
    permission: {
      manageAccounts: 'Gestión de cuentas',
      manageSystemSettings: 'Escritura de la configuración del sistema',
      manageDevices: 'Alta y baja de dispositivos',
      configureDevices: 'Escritura de la configuración del dispositivo',
      controlCameras: 'Control y mantenimiento de la cámara',
      deleteRecordings: 'Eliminar grabaciones',
      downloadDetectFiles: 'Descargar registros de detección',
      viewDevices: 'Ver dispositivos',
      viewAlarms: 'Ver alarmas',
      viewRecordings: 'Ver grabaciones',
      viewTrends: 'Ver tendencias',
      viewEvents: 'Ver el centro de eventos y alarmas'
    },
    permissionScope: {
      manageAccounts: 'Todos los cambios de la página de cuentas: alta, baja, cambio de rol, de permisos, de nombre visible y restablecimiento de contraseña',
      manageSystemSettings: 'Guardar la configuración del sistema, restaurar valores predeterminados y elegir un archivo de sonido de alarma',
      manageDevices: 'Alta, modificación y baja de dispositivos; reinicio, restablecimiento de fábrica, actualización del sistema, carga de firmware y actualización de la cámara',
      configureDevices: 'Escritura de canales, frecuencia de muestreo, perfiles de alarma, dirección de red, hora, RS485, Modbus y nombre del dispositivo',
      controlCameras: 'Vídeo en directo, grabación manual y capturas, modelos de alarma de la cámara, inicio/parada de la detección y parámetros de imagen',
      deleteRecordings: 'Eliminar grabaciones (esta versión aún no tiene ese canal; véase el comentario del código)',
      downloadDetectFiles: 'Descargar a este equipo los archivos de resultados de detección del dispositivo',
      viewDevices: 'Lista de dispositivos, detalle, información del dispositivo y tabla de canales',
      viewAlarms: 'Registros de alarma, estado del motor de vinculación y alarmas pendientes',
      viewRecordings: 'Listas de grabaciones de audio/vídeo, datos de reproducción y direcciones de reproducción',
      viewTrends: 'Consultas de tendencias históricas, cobertura y estadísticas',
      viewEvents: 'Consultas del centro de eventos y alarmas y la biblioteca de detección de la cámara'
    },
    /**
     * Los seis sonidos de alarma predefinidos (manual §17.2.7, línea 5439).
     */
    alarmSound: {
      motionDetection: 'Detección de movimiento',
      videoLoss: 'Pérdida de vídeo',
      videoTampering: 'Manipulación de vídeo',
      externalAlarm: 'Alarma externa',
      lineCrossing: 'Cruce de línea',
      intrusion: 'Intrusión'
    }
  },

  /** Camera live video (FA371 RTSP -> ffmpeg -> loopback <video>). */
  cameraLiveUi: {
    title: 'Vídeo en directo de la cámara',
    rtspAddressUnknown: 'El dispositivo no informó de ninguna dirección de vídeo',
    start: 'Iniciar vídeo',
    stop: 'Detener vídeo',
    retry: 'Reintentar',
    statusIdle: 'Vídeo no iniciado',
    statusStarting: 'Iniciando vídeo…',
    statusPlaying: 'Vídeo en reproducción',
    statusRtspDisabled: 'El RTSP de la cámara está desactivado',
    statusFfmpegMissing: 'ffmpeg incluido no disponible',
    statusError: 'Fallo del flujo de vídeo',
    rtspDisabledHint:
      'El servicio RTSP de la cámara está apagado (el dispositivo informa rtsp_enabled=0). Actívelo en Configuración avanzada, RTSP de la interfaz web de la cámara y vuelva a intentarlo.',
    ffmpegMissingHint:
      'Falta el remultiplexador ffmpeg incluido o no puede ejecutarse. Reinstale este programa; el registro de la aplicación anota todas las rutas que probó.',
    errorHint: 'El flujo de vídeo se interrumpió. Puede reintentar para volver a abrirlo.',
    limitExceededHint:
      'Este equipo ha alcanzado su límite de directos simultáneos (ajustable en «Configuración del sistema → Vídeo en directo»). Detenga otra vista en reproducción y pulse «Iniciar vídeo».',
    dataForwarded: '{count} bytes transferidos',
    modeRemux: 'Solo remultiplexado (sin recodificar)',
    modeTranscode: 'Recodificado (modo de compatibilidad)',
    playbackInfo: 'Reproducción',
    attemptInfo: 'Candidato de dirección {index}: {id}'
  },

  /**
   * Camera acoustic streams (FA371 manual §5.2). No message may contain `@`.
   */
  cameraStreamUi: {
    title: 'Datos acústicos de la cámara',
    start: 'Iniciar recepción',
    stop: 'Detener recepción',
    adminOnlyHint: 'Iniciar y detener los flujos de la cámara es una acción de administrador.',
    noDevice: 'Seleccione primero una cámara.',
    sessionIdle: 'Flujos sin iniciar',
    sessionRunning: 'Recibiendo flujos',
    sessionError: 'Fallo de los flujos',
    handshake: 'Método de negociación: {id}',
    framesCount: '{count} tramas',
    silentFor: 'en silencio {seconds} s',
    phaseNotStarted: 'Sin iniciar',
    phaseNoFrames: 'Aún sin datos',
    phaseLive: 'Recibiendo',
    phaseStale: 'Flujo detenido',
    phaseError: 'Error del canal',
    hintNotStarted: 'Este canal no se ha iniciado. La conexión se abre solo tras pulsar Iniciar recepción.',
    hintNoFrames:
      'La conexión está establecida pero no ha llegado ni una trama. Un panel vacío significa que no hay datos, no que la sala esté en silencio.',
    hintStale:
      'Antes sí llegaron datos, pero no hay tramas nuevas desde hace más de {seconds} segundos; la imagen es la última trama y no debe leerse como un valor en vivo.',
    hintError: 'Este canal informó de un error. Consulte el registro inferior o el registro de la aplicación.',
    layoutWarning:
      'El tamaño de trama actual no coincide con la hipótesis de decodificación de este canal, por lo que los datos mostrados pueden no ser fiables.',
    voiceprintTitle: 'Imagen de voz',
    voiceprintAlt: 'Imagen de voz enviada por la cámara',
    voiceprintJpegMeta: 'Imagen JPEG enviada por el dispositivo: {bytes}',
    voiceprintMatrixMeta: 'Matriz de magnitud {width}x{height} (fuente diezmada {decimation} veces)',
    audioTitle: 'Audio en vivo',
    audioPlay: 'Activar sonido',
    audioStop: 'Silenciar',
    pcmMeta: '{samples} muestras por trama, {ms} ms, {rate} kHz',
    pcmCrest: 'Factor de cresta {crest}',
    fftTitle: 'Espectro',
    fftLineAxis: 'Número de línea espectral',
    fftAmplitudeAxis: 'Amplitud (cuentas brutas del dispositivo)',
    fftAxisFromDevice: '{lines} líneas espectrales; con la frecuencia de muestreo informada cada línea abarca {hz} Hz',
    fftAxisUnknown:
      '{lines} líneas espectrales; el dispositivo no informó de ninguna frecuencia de muestreo, así que el eje horizontal se rotula por número de línea y la escala de frecuencia es desconocida.',
    energyTitle: 'Puntos de energía',
    energyValue: 'Energía',
    energyPixelX: 'Píxel X',
    energyPixelY: 'Píxel Y',
    energySwath: 'Ángulo de barrido',
    energyAzimuth: 'Ángulo de acimut',
    energyNoTarget: 'Esta trama no contiene ningún punto objetivo (ahora mismo no se localiza ninguna fuente).',
    detectTitle: 'Resultados de detección',
    detectMode: 'Modo de detección'
  },

  /**
   * Camera NVR interactions — right-click menu, manual recording, snapshot.
   * Same rule as `cameraLiveUi`: NO MESSAGE HERE MAY CONTAIN `@`.
   */
  cameraNvrUi: {
    menuTitle: 'Acciones de la cámara: {name}',
    menuCapture: 'Captura / grabación',
    menuStartRecording: 'Iniciar grabación manual',
    menuStopRecording: 'Detener grabación',
    menuSnapshot: 'Captura',
    menuAlarmConfig: 'Configuración de alarmas…',
    menuFullscreen: 'Pantalla completa',
    menuExitFullscreen: 'Salir de pantalla completa',
    menuCopyRtsp: 'Copiar dirección RTSP',
    menuOpenExternal: 'Abrir en un reproductor externo',
    menuShowOverlay: 'Mostrar superposición',
    menuHideOverlay: 'Ocultar superposición',
    /*
     * Las tres entradas nuevas que el modelo del menú ya referencia.
     *
     * «Reproducción» debe decir de QUIÉN son las grabaciones: la FA371 no tiene
     * almacenamiento continuo en el dispositivo, así que solo se puede reproducir lo
     * que guarda este equipo. Llamarlo «reproducción del dispositivo» sería falso.
     */
    menuPlayback: 'Reproducir grabaciones locales',
    menuDownloadDetect: 'Descargar registros de detección',
    menuCloseTile: 'Vaciar esta celda',
    recordingStarted: 'Grabación local iniciada: {path}',
    playbackTitle: 'Reproducir grabaciones locales',
    playbackLoading: 'Leyendo las grabaciones locales…',
    playbackEmpty: 'Esta cámara todavía no tiene grabaciones en este equipo.',
    playbackLocalNote:
      'Grabaciones locales: la lista siguiente es lo que guarda este equipo (grabaciones manuales y archivos de detección descargados del dispositivo). La FA371 no tiene almacenamiento continuo en el dispositivo, así que no se reproducen grabaciones del dispositivo.',
    playbackUnavailable: 'No se puede reproducir esta grabación: el proceso principal no devolvió ninguna dirección local reproducible.',
    downloadTitle: 'Descargar registros de detección',
    downloadLoading: 'Leyendo los registros de detección del dispositivo…',
    downloadEmpty: 'El dispositivo no devolvió ningún registro de detección.',
    downloadNoPaging:
      'Este punto de acceso no admite paginación en el servidor: se leyeron de una vez todos los registros de detección del dispositivo ({count} según el dispositivo).',
    downloadColumnTime: 'Detectado el',
    downloadColumnMode: 'Modo de detección (valor bruto)',
    downloadColumnFiles: 'Archivos de resultado',
    downloadReused: 'Este archivo ya está en este equipo y se registró como grabación: {name}',
    downloadPlay: 'Reproducir esta grabación',
    openExternalDone: 'Se abrió esta dirección RTSP en el reproductor externo.',
    reasonIdle: 'El vídeo no está iniciado: pulse Iniciar vídeo y después grabe o capture.',
    reasonStarting:
      'El vídeo aún se está iniciando y no ha llegado ningún fotograma; grabar ahora escribiría un archivo vacío y la captura saldría en blanco.',
    reasonReady: 'El vídeo se está reproduciendo.',
    reasonRtspDisabled:
      'La cámara informa rtsp_enabled=0: el servicio RTSP está apagado en el dispositivo, así que no se puede grabar ni capturar.',
    reasonFfmpegMissing: 'El ffmpeg integrado no está disponible, así que el flujo no se puede grabar ni capturar.',
    reasonError: 'El flujo de vídeo ha fallado; vuelva a abrir el vídeo primero.',
    reasonLimitExceeded: 'Se alcanzó el límite de flujos simultáneos. Detenga otra celda en directo antes de grabar o capturar esta.',
    reasonNoAddress: 'El dispositivo no informó de ninguna dirección RTSP, así que no hay nada que copiar.',
    reasonNoSource: 'Ahora mismo no hay sesión RTSP utilizable, así que el reproductor externo no tiene dirección.',
    recordingBadge: 'Grabando {time}',
    recordSaved: 'Grabación guardada: duración {duration}, tamaño {size}, archivo {path}',
    recordWarning: 'Atención: {reason}',
    snapshotSaved: 'Captura guardada: {path}',
    openFolder: 'Abrir la carpeta contenedora',
    copyDone: 'Dirección RTSP copiada (contiene la contraseña del dispositivo; no la comparta).',
    copyMaskedDone:
      'Dirección RTSP copiada con la contraseña enmascarada; el reproductor pedirá la cuenta y la contraseña.',
    copyFailed: 'No se pudo copiar; seleccione la dirección y cópiela manualmente.',
    overlayDevice: 'Dispositivo: {name}',
    overlayStatus: 'Estado: {status}',
    overlayStream: 'Flujo: {mode} · {address}',
    fullscreenFailed: 'No se pudo entrar en pantalla completa; revise los permisos de la ventana.'
  },

  /**
   * Camera alarm configuration dialog (manual §5.1.22 – §5.1.29).
   * Same rule: NO `@` anywhere. The `ambiguity*` texts expose the manual's
   * contradictions instead of hiding them.
   */
  cameraAlarmUi: {
    title: 'Configuración de alarmas de la cámara',
    /** La tarjeta de alarma de la página de monitorización (junto al control de cámara). */
    entryHint:
      'Las estrategias y condiciones se aplican en el equipo; esta página solo las lee y las edita.',
    goAlarmList: 'Abrir el registro de alarmas',
    // `subtitle` se eliminó junto con el aviso que se mostraba; `refresh` era el
    // texto del antiguo botón de actualizar, ahora solo con icono y por tanto
    // nombrado por `refreshIcon` (aria-label + title).
    tabStrategies: 'Estrategias',
    tabConditions: 'Condiciones',
    refreshIcon: 'Volver a leer las estrategias y las condiciones de alarma',
    loading: 'Leyendo la configuración de alarmas…',
    empty: 'El dispositivo no devolvió ningún registro.',
    newStrategy: 'Nueva estrategia',
    editStrategy: 'Editar estrategia',
    newCondition: 'Nueva condición',
    editCondition: 'Editar condición',
    save: 'Guardar',
    cancel: 'Cancelar',
    edit: 'Editar',
    delete: 'Eliminar',
    confirmDelete: '¿Eliminar "{name}"? Se aplica al dispositivo de inmediato.',
    fieldName: 'Nombre',
    fieldAlias: 'Alias',
    fieldCondition: 'Condición',
    fieldLevel: 'Nivel de alarma',
    fieldInterval: 'Intervalo',
    fieldTimes: 'Ordinal',
    fieldCycle: 'Ciclo de detección (s)',
    fieldSensitivity: 'Sensibilidad',
    fieldDiagnosis: 'Descripción de diagnóstico',
    fieldDbThreshold: 'Umbral de dB',
    fieldDbOperator: 'Operador de dB',
    fieldDfSwitch: 'Activar la rama de frecuencia principal',
    fieldDbSwitch: 'Activar la rama de dB',
    fieldDfThreshold: 'Umbral de frecuencia principal',
    fieldDfOperator: 'Operador de frecuencia principal',
    fieldDfLogical: 'Lógica de frecuencia principal',
    fieldNcFileId: 'ID del archivo de comparación',
    fieldNcThreshold: 'Umbral de similitud',
    fieldNcSwitch: 'Activar la comparación de espectro',
    fieldNcLogical: 'Lógica de comparación',
    fieldNcOperator: 'Operador de comparación',
    fieldDischargeSwitch: 'Activar la rama de descarga',
    fieldDischargeLogical: 'Lógica de descarga',
    fieldDischargeType: 'Tipo de descarga',
    fieldNotes: 'Notas',
    branchDecibel: 'Nivel de presión sonora (dB)',
    branchDominantFreq: 'Frecuencia principal',
    branchComparison: 'Comparación de espectro',
    branchDischarge: 'Descarga (solo escritura)',
    operatorGt: 'mayor que',
    operatorLt: 'menor que',
    operatorEq: 'igual a',
    operatorGe: 'mayor o igual',
    operatorLe: 'menor o igual',
    logicalOr: 'o',
    logicalAnd: 'y',
    dischargeCorona: 'Corona',
    dischargeSuspension: 'Suspensión',
    dischargeSurface: 'Superficie',
    dischargeDischarge: 'Descarga',
    stateEnabled: 'Activada',
    stateDisabled: 'No activada',
    stateUnknown: 'Estado de activación desconocido',
    conditionHint:
      'El dispositivo solo devuelve el nombre y el id de la condición; la condición completa aparece en la sección inferior.',
    selectCondition: 'Seleccione una condición',
    noConditions: 'El dispositivo aún no tiene condiciones: cree una condición antes de la estrategia.',
    diagnosisKeyLabel: 'Clave de la descripción de diagnóstico',
    diagnosisKeyDiagosisn: 'diagosisn (tal como se escribe en POST)',
    diagnosisKeyDiagnosis: 'diagnosis (tal como se escribe en PUT)',
    diagnosisKeyBoth: 'Enviar ambas claves (sondeo)',
    conditionIdStyleLabel: 'Cómo se identifica la condición que se modifica',
    conditionIdStyleId: 'Enviar id (siguiendo el precedente de la estrategia)',
    conditionIdStyleAlarmConditionId: 'Enviar alarm_condition_id (la grafía de lectura)',
    conditionIdStyleNone: 'No enviar identificador (tabla de campos literal)',
    unverified: 'Sin verificar',
    ambiguityDiagnosisLabel: 'La clave de diagnóstico difiere entre POST y PUT',
    ambiguityDiagnosisNote:
      'La tabla de POST escribe diagosisn (el manual exige enviarlo tal cual) y la de PUT escribe diagnosis. El manual no dice si el dispositivo acepta ambas o solo una, así que sigue siendo un candidato seleccionable.',
    ambiguityConditionIdLabel: 'Modificar una condición no puede indicar su destino',
    ambiguityConditionIdNote:
      'La tabla de campos de la modificación no tiene ningún campo id, así que el manual no puede decir qué condición se modifica. Por defecto se sigue el precedente de la estrategia (enviar id); las otras dos grafías quedan como candidatas.',
    ambiguityLevelLabel: 'Dos rangos distintos de nivel de alarma',
    ambiguityLevelNote:
      'La tabla de lectura dice 0~3 y la de escritura 1~4. No se desplaza nada en silencio: se envía 1~4 tal cual y se muestra lo que devuelve el dispositivo, así que un 0 leído no tiene nombre de nivel.',
    ambiguitySwitchLabel: 'No existe endpoint para activar o desactivar una estrategia',
    ambiguitySwitchNote:
      'Switch solo aparece en la lectura y la interfaz abierta no tiene ningún endpoint para activar o desactivar una estrategia, mientras que una estrategia activada no se puede modificar. Por eso el diálogo muestra el estado y no puede cambiarlo.',
    ambiguityDischargeLabel: 'La rama de descarga existe solo en la escritura',
    ambiguityDischargeNote:
      'El interruptor, la lógica y el tipo de descarga solo aparecen en las tablas de alta y modificación, y la lectura nunca los devuelve; además al enum de tipo de descarga le falta el 3. No poder releerlos es como está escrito el manual, no un fallo del programa.',
    ambiguityUnitsLabel: 'Las unidades y los rangos de los umbrales no están especificados',
    ambiguityUnitsNote:
      'El manual no da unidad ni rango válido para el umbral de dB ni para el de frecuencia principal; la similitud de espectro se documenta como 0~1. Aquí no se convierte ningún valor.',
    ambiguityDeleteLabel: 'La petición de borrado no tiene nombre de campo documentado',
    ambiguityDeleteNote:
      'Los cuerpos de borrado solo dan un tipo (una matriz de ids) y ningún nombre de campo. El cliente envía una forma candidata documentada; que el dispositivo la acepte solo se confirma con su respuesta.',
    ambiguityCreateIdLabel: 'Una estrategia nueva no devuelve id',
    ambiguityCreateIdNote:
      'Crear una estrategia solo devuelve ret/msg y el manual no dice cómo vuelve el id nuevo, así que este diálogo vuelve a leer la lista tras guardar para reconocer la fila nueva.',
    issueName: 'El nombre de la estrategia debe tener entre 1 y 20 caracteres',
    issueCondition: 'Seleccione la condición de alarma que enlaza esta estrategia (una estrategia enlaza exactamente una)',
    issueLevel: 'La escritura solo acepta niveles 1~4 (la lectura dice 0~3; aquí no se desplaza nada)',
    issueCycle: 'El ciclo de detección debe ser de 1 a 30 segundos',
    issueSensitivity: 'La sensibilidad debe estar entre 0 y 1',
    issueInterval: 'El intervalo debe ser un número entero no menor que 0',
    issueTimes: 'El ordinal debe ser un número entero no menor que 0',
    issueConditionName: 'El nombre de la condición no puede estar vacío (máximo 64 caracteres)',
    issueNoBranch: 'Al menos una de las cuatro ramas debe estar activada, o la condición no participa',
    issueSimilarity: 'La similitud de ruido debe estar entre 0 y 1',
    issueDischargeType: 'Solo están definidos los tipos de descarga 0/1/2/4 (al manual le falta el 3)',
    savedStrategy: 'La estrategia se envió y la lista se actualizó.',
    savedCondition: 'La condición se envió y la lista se actualizó.',
    deleted: 'La orden de borrado se envió y la lista se actualizó.',
    missingId:
      'El id de este registro no es un número entero, así que no se puede modificar ni borrar (la lectura puede devolverlo como texto, véase §8.3 C21).',
    adminOnly: 'Crear, modificar y borrar la configuración de alarmas requiere una cuenta de administrador.'
  },

  /**
   * Channel wall — the Overview page's 1 / 4 / 16 pane channel view.
   *
   * Same rule as `cameraLiveUi` / `cameraStreamUi`: NO MESSAGE HERE MAY CONTAIN `@`
   * (vue-i18n's linked-message sigil; a message containing one fails to compile).
   */
  /**
   * Muro de vídeo en directo multicámara (vista dividida de la página de monitoreo).
   *
   * Misma regla estricta que `cameraLiveUi`: **ningún mensaje de este bloque puede
   * contener `@`** (es el signo de mensaje enlazado de vue-i18n y no compila al
   * renderizar; `tests/i18n.test.ts` compila todos los mensajes).
   */
  /**
   * Panel de control y mantenimiento de la cámara (modo de detección / inicio y
   * parada / estrategia habilitada / mantenimiento).
   *
   * Misma regla estricta: **ningún mensaje de este bloque puede contener `@`**.
   *
   * Dos redacciones deliberadas:
   *   - `modeRejected` / `detectNotApplied` / `strategyRejected` dicen que el
   *     equipo CONFIRMÓ la escritura sin aplicarla: en este hardware se ha medido
   *     una respuesta `ret:200` que ignoraba la escritura, así que la interfaz no
   *     puede convertir un código de éxito en «hecho»;
   *   - los textos `reason*` son descripciones emergentes de controles
   *     DESHABILITADOS, por lo que cada uno indica el paso siguiente.
   *
   * El grupo `appMode*` es el modo de APLICACIÓN (qué aplicación realiza este equipo:
   * descarga parcial / fuga de gas / ruido mecánico), distinto del grupo `mode*` de
   * arriba (el modo de DETECCIÓN: detección única / ronda inteligente), así que los
   * textos no deben mezclarse. `appModeSourceHint` es la ayuda del botón y solo afirma
   * un hecho: el punto de acceso no figura en el manual del equipo.
   */
  cameraControlUi: {
    title: 'Control de la cámara',
    refresh: 'Actualizar',
    modeTitle: 'Modo de detección',
    modeSingle: 'Detección única',
    modeCruise: 'Ronda inteligente',
    modeUnknownHint: 'El equipo devolvió un valor que el manual no define: 1 = detección única, -1 = ronda inteligente.',
    modeRawValue: 'Valor del equipo: {value}',
    modeReadBack: 'Equipo ahora: {value}',
    modeApplied: 'Aplicado',
    modeRejected: 'El equipo confirmó la escritura pero no la aplicó',
    appModeTitle: 'Modo de aplicación',
    appModeCurrent: 'Equipo ahora',
    appModePartialDischarge: 'Descarga parcial',
    appModeGasLeak: 'Fuga de gas',
    appModeMechanical: 'Ruido mecánico',
    appModeUnknownHint: 'El equipo devolvió un valor fuera de los tres medidos (1 = descarga parcial, 2 = fuga de gas, 3 = ruido mecánico).',
    appModeSourceHint: 'Este punto de acceso no figura en el manual del equipo; el cambio solo escribe el modo de aplicación.',
    appModeApplied: 'Aplicado',
    appModeRejected: 'El equipo confirmó la escritura pero no la aplicó',
    // Confirmación indicada por el responsable de producto. NO es un hecho verificado
    // del equipo: el manual no documenta si cambiar de modo interrumpe la detección,
    // su única frase sobre "borrar todos los datos históricos" se refiere a Restaurar,
    // y lo medido es que escribir `run_mode` borra el puntero de estrategia habilitada.
    appModeConfirmTitle: 'Cambiar el modo de aplicación',
    appModeConfirmBody: 'Al cambiar el modo se borrarán todos los datos almacenados. ¿Continuar?',
    appModeConfirmAction: 'Cambiar de todos modos',
    presetTitle: 'Modo de aplicación',
    presetCurrentBand: 'Banda de imagen actual',
    presetCurrentTargets: 'Número de objetivos actual',
    presetCurrentThreshold: 'Umbral de imagen actual',
    presetNotRead: 'Sin lectura',
    presetPartialDischarge: 'Descarga parcial',
    presetGasLeak: 'Fuga de gas',
    presetMechanical: 'Ruido mecánico',
    presetHintPartialDischarge: 'Descarga parcial: 20–40 kHz',
    presetHintGasLeak: 'Fuga de gas: 25–45 kHz',
    presetHintMechanical: 'Ruido mecánico: 2–50 kHz',
    presetCitationPartialDischarge: 'practical-guide.txt §4.1.2 · 20–40 kHz · Targets 1 · Sensitivity Low · Enhancement Off',
    presetCitationGasLeak: 'practical-guide.txt §4.2.2 · 25–45 kHz · Targets 1 · Sensitivity Low · Enhancement Off',
    presetCitationMechanical: 'practical-guide.txt §4.3.2 · 2–50 kHz · Targets 1 · Sensitivity Low · Enhancement Disabled',
    presetAlready: 'Ya está en este modo',
    presetRejectedBadge: 'No aceptada por el equipo',
    presetRejectedByDevice:
      'El equipo rechaza esta banda: su anchura de {width} kHz supera el límite de {limit} kHz (medido)',
    presetApply: 'Aplicar modo',
    presetApplied: 'Aplicado',
    presetRejected: 'El equipo confirmó la escritura pero no la aplicó',
    presetReadBack: 'Banda del equipo: {band}',
    presetRestore: 'Restaurar',
    presetRestored: 'Restaurado a los valores previos del equipo',
    presetRestoreRejected: 'El equipo confirmó la escritura pero no restauró',
    presetTargetsUnchanged: 'El número de objetivos es siempre 1',
    detectTitle: 'Detección',
    detectRunning: 'Detectando',
    detectStopped: 'Detenida',
    detectRetentionHint: 'El equipo conserva solo los 50 registros de detección más recientes; los anteriores se sobrescriben.',
    detectRecord: 'Registro {id}',
    detectStart: 'Iniciar detección',
    detectStop: 'Detener detección',
    detectStopHint: 'La detección única se detiene sola al terminar el periodo de la estrategia, así que entonces esta llamada es opcional.',
    detectApplied: 'Aplicado',
    detectNotApplied: 'El estado del equipo no cambió según lo solicitado',
    strategyTitle: 'Estrategia de alarma',
    strategyPeriodHint: 'El periodo de la estrategia se configura dentro de la propia estrategia; va de 1 a 30 segundos.',
    strategyNoneEnabled: 'No hay ninguna estrategia habilitada',
    strategyEnabled: 'Habilitada',
    strategyEnable: 'Habilitar',
    strategyDisable: 'Deshabilitar',
    strategyNoItems: 'El equipo todavía no tiene estrategias de alarma',
    strategyIdUnusable: 'El id de esta estrategia no es un número entero, así que no se puede habilitar ni deshabilitar',
    strategyNeedsOne: 'Hay que habilitar una estrategia de alarma antes de poder iniciar la detección',
    strategyDisabledPrevious: 'Solo puede haber una estrategia habilitada, así que se deshabilitó primero la estrategia {previous}',
    strategyApplied: 'Aplicado',
    strategyRejected: 'El equipo confirmó la escritura pero no la aplicó',
    maintenanceTitle: 'Mantenimiento',
    firmwareVersion: 'Versión de firmware',
    sdkVersion: 'Versión del SDK',
    webVersion: 'Versión de la interfaz web',
    lastUpgrade: 'Última actualización',
    valueUnavailable: 'Sin lectura',
    valueUnavailableHint: 'El equipo no devolvió este dato en la última lectura.',
    openWebUi: 'Abrir la interfaz web de la cámara',
    webUiOpened: 'Abierta en el navegador del sistema',
    // `upgrade` y `reboot` eran las etiquetas de los botones DESHABILITADOS; ahora ambas
    // acciones tienen controles reales, con sus textos en `cameraUpgradeUi.*`.
    rollback: 'Volver a una versión anterior',
    factoryReset: 'Restablecer de fábrica',
    reasonNotInOpenInterface: 'La interfaz abierta del equipo no tiene esta operación',
    reasonDeviceOffline: 'El equipo está desconectado',
    adminOnlyHint: 'Cambiar el modo, iniciar o detener la detección y habilitar una estrategia requieren un administrador'
  },

  /**
   * Actualización de firmware de la cámara (la vía HTTP que usa la propia interfaz
   * web del equipo: `POST /upload` + `PUT /reboot` + `GET /progress`).
   *
   * `*ConfirmBody` enuncia la CONSECUENCIA de una acción destructiva (qué ocurre,
   * cuándo empieza la actualización, qué no debe interrumpirse); `sourceHint` afirma
   * un solo hecho sobre el origen de las interfaces; `nameRejectedDetail` cita la
   * regla de nombre de archivo que aplica el propio equipo. El resto son etiquetas.
   */
  cameraUpgradeUi: {
    title: 'Actualización de firmware',
    sourceHint: 'La actualización y el reinicio usan las interfaces de la propia web del equipo (no figuran en el manual).',
    pick: 'Elegir paquete',
    repick: 'Elegir otro',
    packageFile: 'Paquete',
    packageSize: 'Tamaño',
    packageSha256: 'SHA-256',
    packageSuffix: 'Sufijo del nombre',
    sha256Hint: 'Compare este valor con la suma de verificación publicada por el fabricante para esta versión antes de subirla.',
    nameAccepted: 'El equipo acepta este nombre de archivo',
    nameRejected: 'El equipo rechazará este nombre de archivo',
    nameRejectedDetail: 'El equipo exige que el último segmento tras "_" sea V más tres números, por ejemplo _v2.0.11 (actualmente {suffix}).',
    upload: 'Subir paquete',
    uploading: 'Subiendo {percent}%',
    uploadConfirmTitle: 'Subir el paquete al equipo',
    uploadConfirmBody: 'El paquete se escribirá en el equipo ({size}). No corte la corriente ni la red durante la subida. El equipo no se reinicia solo después: usted decide por separado cuándo empieza la actualización.',
    uploadConfirm: 'Iniciar subida',
    uploaded: 'Paquete subido; el equipo aún no se ha actualizado',
    uploadedHint: 'Hay que reiniciar el equipo para que empiece la actualización: use Reiniciar equipo.',
    uploadDoneAt: 'La subida tardó {duration}',
    deviceProgressTitle: 'Progreso de actualización del equipo',
    deviceProgressRead: 'Leer el progreso del equipo',
    deviceProgressValue: 'Valor del equipo: {value}',
    deviceProgressUnknown: 'El equipo no documenta qué significa este valor, así que no se convierte.',
    deviceProgressNotRead: 'Sin lectura',
    reboot: 'Reiniciar equipo',
    rebootConfirmTitle: 'Reiniciar el equipo',
    rebootConfirmBody: 'El equipo se reinicia de inmediato: una detección en curso se interrumpe y la conexión se corta unos instantes. Si ya se subió un paquete, la actualización solo empieza tras este reinicio; no corte la corriente ni la red mientras se ejecuta.',
    rebootConfirm: 'Reiniciar',
    rebooting: 'Reiniciando…',
    rebootAcknowledged: 'Orden de reinicio enviada y confirmada por el equipo',
    rebootDropped: 'Orden de reinicio enviada; el equipo no confirmó (que la conexión se corte es normal al reiniciar)'
  },

  cameraWallUi: {
    title: 'Muro de vídeo en directo',
    layoutGroup: 'Disposición de celdas',
    layoutLabel: '{count} celdas',
    pickDevice: 'Elegir cámara',
    pickPlaceholder: 'Seleccione una cámara',
    replaceDevice: 'Cambiar cámara',
    noCamera: 'Todavía no hay cámaras acústicas',
    assignToCell: 'Poner en esta celda',
    statusIdle: 'Sin iniciar',
    statusStarting: 'Iniciando…',
    statusPlaying: 'Reproduciendo',
    statusRtspDisabled: 'RTSP no habilitado',
    statusFfmpegMissing: 'No se encuentra ffmpeg',
    statusError: 'Error de flujo',
    statusLimitExceeded: 'Límite de concurrencia superado',
    statusAlreadyShown: 'La cámara ya está en otra celda',
    statusDeviceRemoved: 'Dispositivo eliminado',
    statusDeviceOffline: 'Dispositivo sin conexión',
    start: 'Iniciar',
    stop: 'Detener',
    retry: 'Reintentar',
    fullscreen: 'Pantalla completa',
    exitFullscreen: 'Salir de pantalla completa',
    audioOn: 'Activar sonido',
    audioOff: 'Silenciar',
    audioBadge: 'Con sonido',
    volume: 'Volumen',
    volumeNoPicture: 'Esta celda no tiene imagen, así que no puede sonar',
    activeBadge: 'Celda activa',
    limitNotice: 'Máximo {max} flujos simultáneos; {active} en curso. Uno más superaría el límite: detenga otra celda primero.',
    limitSummary: '{active} de {max} flujos en directo',
    layoutShrunk: 'La disposición se redujo: se detuvieron {count} celdas.'
  },

  channelWall: {
    title: 'Muro de canales',
    summary: '{count} canales',
    layoutLabel: 'Distribución de paneles',
    layout1: '1 panel',
    layout2: '2 paneles',
    layout4: '4 paneles',
    layout8: '8 paneles',
    prevPage: 'Anterior',
    nextPage: 'Siguiente',
    pageIndicator: 'Página {page} de {total}',
    loading: 'Leyendo canales…',
    empty: 'No hay canales que mostrar',
    noChannelTable:
      '{count} dispositivos aún no han devuelto su tabla de canales, por lo que sus canales no aparecen.',
    cameraStreamLabel: 'Imagen de huella vocal',
    cameraMatrixOnly:
      'Esta cámara envía una matriz numérica en lugar de un fotograma de imagen, así que el muro no la redibuja.',
    cameraOtherDevice: 'El flujo se está ejecutando en otra cámara',
    cameraStale: 'Los datos se detuvieron (hace {seconds} s)',

    // 名字说的是「按下去会发生什么」；此刻是收起的还是展开的由 `aria-expanded` 表达。
    collapse: 'Contraer el muro de canales',
    expand: 'Expandir el muro de canales',
    collapsedNoChannel: 'Ahora mismo no hay ningún canal en línea',

    graphLabel: 'Tipo de gráfico',

    // 四种图形，每一种都对应设备端真实推送的一种载荷（见 `lib/channelWall.ts`）。
    // `deviceHasNoData` 是结构性的事实：这个设备家族根本没有这种载荷，
    // 所以它与「未监测」「尚无数据」必须读起来是不同的话。
    graph: {
      voiceprint: 'Imagen de huella vocal',
      spl: 'Línea de presión sonora',
      spectrum: 'Espectro',
      spectrogram: 'Espectrograma',
      deviceHasNoData: 'Este dispositivo no proporciona este tipo de datos',
      splCaption: '{value} dB · {count} puntos',
      lineAxis:
        '{count} líneas · el eje X es el índice de línea (el dispositivo no informa la frecuencia de muestreo)',
      // La unidad es una anotación DE ESTE REPOSITORIO, no del equipo: el campo del
      // payload es `sound_pressure_level` y ningún manual de caja de este repositorio
      // define su unidad (la única definición de dB aquí viene de la guía de la cámara
      // FA371). `splUnitNote` es la procedencia, colgada del `title` de la lectura.
      splUnit: 'dB',
      splUnitNote:
        'Anotación de esta aplicación: el campo del equipo es sound_pressure_level y su unidad no tiene respaldo en la documentación del equipo (este repositorio no incluye el manual de la caja), así que no es una medición calibrada.'
    },

    // La alarma MÁS RECIENTE de un canal, tomada de la base de datos local de alarmas.
    // El texto dice siempre "última alarma", nunca "alarmando ahora": el contrato IPC
    // no tiene ningún aviso de alarma por canal en vivo, así que lo segundo sería inventado.
    alarm: {
      recent: 'Última alarma',
      loading: 'Leyendo…',
      failed: 'No se pudieron leer los registros de alarma',
      none: 'Sin registros de alarma',
      entry: '{type} · {time} · {ack}'
    },

    reason: {
      notMonitored: 'Sin monitorear',
      deviceOffline: 'El dispositivo está fuera de línea, así que no hay datos en tiempo real'
    }
  },

  /**
   * Enlace de alarma local (grabación / ventana emergente / aviso / correo).
   *
   * Same rule as every other group: NO MESSAGE HERE MAY CONTAIN `@`
   * (vue-i18n's linked-message sigil: a message containing one fails to COMPILE at
   * render time, which the catalogue tests catch because they compile every message).
   * That is why the SMTP fields talk about "la dirección" instead of showing a
   * sample mailbox.
   */
  linkage: {
    title: 'Enlace de alarma',
    enabled: 'Activar el enlace de alarma',

    sourceSection: 'Fuentes de disparo',
    pollInterval: 'Intervalo de sondeo (s)',
    useDetectFeedback: 'Activar el acelerador de retroalimentación de detección',
    minAlarmLevel: 'Nivel de alarma mínimo',
    sourcePoll: 'Sondeo del registro de detecciones',
    sourceWebsocket: 'Flujo de retroalimentación de detección',
    sourceRunning: 'En ejecución',
    sourceStopped: 'Detenido',
    sourceLastPoll: 'Último sondeo',
    sourceLastError: 'Último error',
    sourceTriggers: 'Disparos',
    sourceFrames: 'Fotogramas recibidos',
    sourceNoFrames: '0 fotogramas hasta ahora (este flujo de eventos nunca ha enviado datos)',

    actionSection: 'Acciones',
    action: {
      record: 'Grabación',
      popup: 'Ventana emergente',
      notice: 'Aviso',
      email: 'Correo electrónico'
    },
    actionState: {
      success: 'Correcta',
      failed: 'Fallida',
      skipped: 'Omitida'
    },

    recordSection: 'Grabación',
    recordDuration: 'Duración del clip (s)',
    recordCooldown: 'Tiempo de espera (s)',
    recordSkipBusy: 'Omitir mientras ya se está grabando',

    popupSection: 'Ventana emergente',
    popupAutoDismiss: 'Cierre automático (s)',
    popupCooldown: 'Tiempo de espera (s)',
    popupMaxStack: 'Máximo en pantalla',

    noticeSection: 'Aviso',
    noticeCapacity: 'Registros conservados',

    /**
     * El bloque del SERVIDOR de correo se ha trasladado a `emailUi` (el manual §17.2.8 es una pestaña propia).
     */
    emailActionSection: 'Acción de correo',

    emailHostPlaceholder: 'por ejemplo smtp.example.com',
    emailPasswordPlaceholder: 'Déjelo en blanco para no cambiar la contraseña guardada',
    emailPasswordStored: 'Contraseña guardada',
    emailPasswordNotStored: 'Sin contraseña guardada',
    emailPasswordClearHint:
      'Escriba un solo espacio y guarde para borrar la contraseña almacenada',
    emailSubject: 'Plantilla del asunto',
    emailBody: 'Plantilla del cuerpo',
    emailAttachFrame: 'Adjuntar la imagen capturada',
    emailCooldown: 'Tiempo de espera (s)',
    emailTesting: 'Enviando…',
    emailTestOk: 'El servidor SMTP aceptó el correo de prueba ({count} destinatarios)',
    emailTestFailed: 'El envío del correo de prueba falló: {reason}',
    emailTestAttach: 'Adjunto de prueba',
    emailTestAttachNone: 'Sin adjunto',
    emailTestAttachSynthetic: 'Imagen de prueba integrada',
    emailTestAttachCamera: 'Imagen actual de la cámara',
    emailTestPrompt:
      'Guarde antes la configuración: el correo de prueba usa el servidor y las plantillas guardados.',

    runtimeSection: 'Límites de frecuencia',
    maxActionsPerMinute: 'Límite global (acciones por minuto)',
    cooldownPeriod: 'Ventana de tiempo de espera (s)',
    cooldownPerPeriod: 'Límite por ventana',
    cooldownPerInterface: 'Límite por franja de tiempo',
    windowUsage: '{used} de {limit} usados en esta ventana',

    pendingTitle: 'Alarmas pendientes',
    pendingEmpty: 'No hay alarmas en este momento',
    pendingAcknowledge: 'Confirmar',
    pendingAcknowledgeAll: 'Confirmar todas',
    pendingAcknowledged: 'Confirmada',
    pendingDropped:
      'Se descartaron {count} alarmas anteriores porque se alcanzó el límite de registros conservados',
    pendingLevel: 'Nivel',
    pendingStrategy: 'Estrategia',
    pendingMetrics: 'Intensidad del campo acústico {intensity}, fuga {volume}',
    pendingNoActions: 'No se ejecutó ninguna acción para esta alarma',
    pendingEngineOff: 'El enlace de alarma está desactivado en este momento',
    pendingShow: 'Mostrar las alarmas pendientes',

    adminOnly:
      'Modificar la configuración del enlace de alarma, enviar un correo de prueba y confirmar alarmas requiere una cuenta de administrador.',
    loadFailed: 'No se pudo leer el estado del enlace de alarma',
    statusTriggers: '{count} disparos en esta ejecución',
    statusActions: '{count} acciones ejecutadas'
  },

  eventsUi: {
    countSummary: '{total} eventos coinciden con el filtro actual',
    truncated:
      'Este resultado está incompleto: una fuente se truncó (cada fuente se lee hasta {cap} entradas) o el motor descartó alarmas anteriores. El panel de fuentes indica cuántas.',
    emptyTitle: 'No se ha reportado ningún evento',
    emptyFilteredTitle: 'Ningún evento coincide con el filtro actual',

    sourcesTitle: 'Estado de las fuentes',
    sourceOk: '{count} leídos',
    sourceFailed: 'Error de lectura: {reason}',
    sourceTruncated: '{count} truncados',
    sourceUntimed: '{count} sin hora del equipo',

    filterDevice: 'Equipo',
    filterAllDevices: 'Todos los equipos',
    filterSource: 'Fuente',
    filterAllSources: 'Todas las fuentes',
    filterSeverity: 'Nivel',
    filterAllSeverities: 'Todos los niveles',
    filterFrom: 'Desde',
    filterTo: 'Hasta',
    filterAck: 'Confirmación',
    ackAll: 'Todos',
    ackUnacknowledged: 'Sin confirmar',
    ackAcknowledged: 'Confirmado',

    approximateBadge: 'Hora aproximada',
    approximateHint:
      'La interfaz de la cámara nunca declara la unidad de sus marcas de tiempo, así que aquí la hora del equipo se interpreta en segundos y el valor convertido es aproximado.',
    timeUnknown:
      'El equipo no informó de una hora para este registro, así que la lista lo ordena por la hora de lectura.',

    detailTitle: 'Detalle del evento',
    detailEventId: 'Identificador del evento',
    detailDevice: 'Equipo',
    detailSource: 'Fuente',
    detailKind: 'Evento',
    detailSeverity: 'Nivel',
    detailDeviceTime: 'Marca de tiempo original del equipo',
    detailDeviceTimeUnit: 'Unidad asumida',
    detailSavingPath: 'Carpeta del equipo',
    detailLogId: 'Id del registro de detección',
    detailDetectMode: 'Modo de detección (valor original)',
    detailAlarmLevel: 'Nivel de alarma del equipo (original, sin convertir)',

    detailFilesTitle: 'Archivos de resultado de la detección (acciones del equipo)',
    detailDetectTitle: 'Detalle del registro de detección',
    detailFilesEmpty: 'Este registro de detección no trae ningún archivo de resultado',
    detailFileDownload: 'Descargar',
    detailFileDownloading: 'Descargando…',
    detailFileDownloaded: 'Descargado',
    detailFilePlay: 'Reproducir',
    detailFileOpenVideo: 'Abrir vídeo',
    detailDownloadNeedAdmin: 'Descargar archivos de resultado requiere una cuenta de administrador',
    detailSourceUnavailable: 'Esta fuente falló al leerse ahora mismo; inténtalo de nuevo',

    detailAck: 'Confirmar este evento',
    detailAckUnsupported:
      'El lado de la cámara no tiene interfaz de confirmación para los registros de detección (ninguna de las 32 interfaces abiertas del manual), así que esta entrada no se puede confirmar.',

    detailRecordingTitle: 'Grabación e imagen locales',
    detailRecordingNone: 'Este evento no tiene ninguna grabación en este equipo.',
    detailRecordingPending:
      'Los archivos de resultado de esta detección no se han descargado, así que no hay nada local que reproducir.',
    detailRecordingVideoUnavailable:
      'Esta grabación no se puede reproducir (el archivo local no existe o no es un vídeo).',
    detailRecordingGoto: 'Ir a grabaciones',
    detailFrameTitle: 'Fotograma de la vinculación',

    detailMetricsTitle: 'Métricas',
    metricSoundmapIntensity: 'Intensidad del mapa sonoro',
    metricLeakVolume: 'Volumen de fuga',
    metricLeakCost: 'Coste de la fuga',
    detailActionsTitle: 'Acciones de vinculación',
    detailActionLine: '{action}: {status}',
    detailActionReason: 'Motivo: {reason}',

    detailLocalAlarmChannel: 'Canal',
    detailLocalAlarmTypes: 'Tipos de alarma',

    downloadDone: 'Descargado {name} ({size})',

    // --- Phase 3: KPI strip / filters / alert queue (spec §8–§10) -----------
    // All five spec levels have a name (see VISIBLE_ALERT_SEVERITIES for why
    // medium/low are not rendered yet).
    alertSeverity: {
      critical: 'Crítico',
      high: 'Alto',
      medium: 'Medio',
      low: 'Bajo',
      info: 'Info'
    },
    alertStatus: {
      new: 'Nuevo',
      acknowledged: 'Confirmado',
      investigating: 'En investigación',
      resolved: 'Resuelto',
      closed: 'Cerrado',
      muted: 'Silenciado',
      reopened: 'Reabierto'
    },
    severityUnknown: 'Gravedad desconocida',

    kpiUnacknowledged: 'Sin confirmar',
    kpiAvgAck: 'Confirmación media',
    kpiScope: 'Los KPI y recuentos cubren las {loaded} filas cargadas de {total} resultados',

    viewMode: {
      compact: 'Compacta',
      standard: 'Estándar',
      evidence: 'Evidencia'
    },

    searchPlaceholder: 'Buscar equipo, evento o métrica',
    searchScope: 'La búsqueda solo cubre las {loaded} filas cargadas',

    savedViewTitle: 'Vistas',
    savedView: {
      all: 'Todo',
      critical: 'Crítico',
      high: 'Alto',
      unacknowledged: 'Sin confirmar',
      last24h: 'Últimas 24 horas',
      last7d: 'Últimos 7 días'
    },

    filterPanelTitle: 'Filtros',
    filterPanelToggle: 'Panel de filtros',
    panelCount: '{count}',
    panelScope: 'Recuentos sobre las {loaded} filas cargadas',
    clearFilters: 'Borrar todo',

    evidenceRecording: 'Grabación',
    evidenceFrame: 'Fotograma',
    evidenceFiles: '{count} archivos',
    metricMore: '+{count} más',

    // --- Fase 4: panel de detalle / Overview / Evidence (spec §11–§12) ------
    detailTab: {
      overview: 'Resumen',
      evidence: 'Evidencia',
      timeline: 'Cronología',
      related: 'Relacionados',
      activity: 'Actividad'
    },
    overviewStatus: 'Estado',
    overviewFirstDetected: 'Primera detección',
    overviewLastDetected: 'Última detección',
    overviewDuration: 'Duración',
    overviewOccurrences: 'Ocurrencias',
    drawerResize: 'Arrastra para cambiar el ancho del panel',

    evidenceVisualTitle: 'Evidencia de imagen',
    evidenceNone: 'Este evento no tiene evidencia de imagen.',
    evidenceNotCaptured: 'El equipo no capturó ninguna imagen (puede que la descarga de capturas estuviera desactivada al sincronizar).',
    evidenceFilesGone: 'La base registra esta imagen, pero el archivo ya no está en este equipo.',
    evidenceNotImage: 'El archivo existe, pero no es un formato de imagen que se pueda mostrar.',
    evidenceNotFound: 'No hay una ruta utilizable para esta evidencia de imagen.',
    evidenceError: 'No se pudo leer la evidencia de imagen.',

    // --- Fase 5: máquina de estados / acciones / Activity / Timeline / Related (§2.2, §13)
    actionInvestigate: 'Iniciar investigación',
    actionResolve: 'Marcar como resuelto',
    actionClose: 'Cerrar',
    actionReopen: 'Reabrir',
    actionMute: 'Silenciar',
    actionUnmute: 'Quitar silencio',
    actionAssign: 'Asignar',

    activityKind: {
      status: 'Cambio de estado',
      assign: 'Asignación',
      note: 'Nota'
    },


    relatedSameDevice: 'Mismo equipo',
    relatedSameKind: 'Mismo tipo de evento',
    relatedTimeWindow: 'Dentro de 10 minutos',

    // --- Fase 5 (UI): acciones / cronología / relacionados / actividad -------
    relatedTitle: 'Eventos relacionados',
    relatedScope: 'Los eventos relacionados se buscan entre las {loaded} filas cargadas',
    relatedEmpty: 'No se encontraron otros eventos relacionados.',
    relatedOpen: 'Abrir este',

    timelineTitle: 'Cronología',
    timelineDetected: 'Primera detección',

    activityTitle: 'Registro de gestión',
    activityEmpty: 'Este evento aún no tiene registro de gestión.',
    activityStatusLine: '{actor} cambió el estado de «{from}» a «{to}»',
    activityAssignLine: '{actor} lo asignó a {name}',
    activityNoteLine: '{actor} comentó',
    statusChangeDone: 'Estado cambiado a «{status}»',
    assignDone: 'Asignado a {name}',
    actionAssignee: 'Asignar a',
    actionNote: 'Añadir nota',
    actionReopenNotePlaceholder: 'Motivo de la reapertura (obligatorio)',
    actionNoteEmpty: 'Escribe primero un motivo',
    actionConfirm: 'Confirmar',
    actionCancel: 'Cancelar',

    // --- Fase 6: agrupación de disparos repetidos (spec §14.1) --------------
    groupWindowLabel: 'Agrupación',
    groupWindow: {
      off: 'Sin agrupar',
      m10: 'En 10 minutos',
      m30: 'En 30 minutos',
      h1: 'En 1 hora'
    },
    occurrenceCount: '×{count}',
    timelineOccurrence: 'Disparo {index}',
    statusChangeDoneMany: 'Estado de {count} disparos cambiado a «{status}»'

  }
}
