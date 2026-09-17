/**
 * 告警声音库（手册 §17.2.7 Alarm Sound Settings，p185）。
 *
 * ---------------------------------------------------------------------------
 * 手册说了什么
 * ---------------------------------------------------------------------------
 *   - 列表里有**六种预定义**的告警声音类型（第 5439 行）；
 *   - 每一种可以点图标选一个**本机音频文件**（第 5440 行）；
 *   - 可以按 Add 添加**自定义**声音，双击 Type 字段改名，再给它选文件（5441–5443）；
 *   - 可以试听一个音频文件（5445）；
 *   - 自定义项可以选中后 Delete 删掉（5446）；
 *   - **硬约束**：`The format of the audio file can only be *wav`（第 5448 行）。
 *
 * ---------------------------------------------------------------------------
 * 这一轮做什么、不做什么
 * ---------------------------------------------------------------------------
 * 本轮只做**声音库本身**（有哪些类型、每个类型指向哪个文件、默认声音是谁）。
 * 「哪一条告警用哪一个声音」的**绑定**属于告警模型那一轮，所以这里**不**含任何
 * `alarmType -> soundId` 的映射；`defaultSoundId` 是库里唯一一处「默认」，
 * 它是「库的默认声音」（新增类型时的初值），不是「某类告警的默认声音」。
 *
 * 放在 `shared/domain` 而不是主进程里：渲染层必须能**命名**这些类型与键，
 * 而渲染层的 tsconfig 不包含 `src/main/`（这是本工程的进程边界规则）。
 * 这里没有一行运行时逻辑依赖 Node，也没有把主进程代码拖进渲染层包里的风险。
 */

/** 六种预定义告警声音类型（手册第 5439 行的「six pre-defined alarm sound type」）。 */
export const ALARM_SOUND_TYPE_KEYS = [
  'motionDetection',
  'videoLoss',
  'videoTampering',
  'externalAlarm',
  'lineCrossing',
  'intrusion'
] as const

export type AlarmSoundTypeKey = (typeof ALARM_SOUND_TYPE_KEYS)[number]

/** 一条声音记录：预定义的六种是**稳定 id**，自定义的是 `custom:*`。 */
export interface AlarmSoundEntry {
  /** 稳定标识。预定义项等于它的类型键，自定义项形如 `custom:<n>`。 */
  id: string
  /**
   * 预定义项 = 它的类型键；自定义项 = `null`。
   *
   * 用 `null` 而不是把自定义项也塞一个假类型：界面据此决定「能不能删除」
   * （预定义项不能删，手册的 Delete 只针对自定义项），以及名字是翻译出来的
   * 还是用户打进去的。
   */
  type: AlarmSoundTypeKey | null
  /** 自定义项的用户名字。预定义项为 `''`（名字来自目录，不落库）。 */
  label: string
  /** 选中的音频文件的**绝对路径**；`''` = 还没选（界面显示「未选择」）。 */
  filePath: string
  /** 文件名（`filePath` 的 basename），由主进程在归一化时重算，便于界面直接显示。 */
  fileName: string
}

/** 声音库整块（`AppSettings.alarmSounds`）。 */
export interface AlarmSoundLibrary {
  items: AlarmSoundEntry[]
  /** 界面列表里选中的那一项；`''` = 没有选中。 */
  selectedId: string
  /**
   * 库的默认声音 id。
   *
   * **含义**：新增一条声音、或某条声音被删掉之后，界面默认指向哪一项。
   * 它**不是**「哪一类告警用哪个声音」——那个绑定留给下一轮。
   */
  defaultSoundId: string
}

/** 出厂默认声音（新建声音项时的初值，也是「恢复默认」之后的值）。 */
export const DEFAULT_ALARM_SOUND_ID = 'motionDetection'

/** 自定义声音项的 id 前缀。用前缀而不是纯序号，是为了让「预定义 vs 自定义」一眼可辨。 */
export const CUSTOM_ALARM_SOUND_ID_PREFIX = 'custom:'

/** 自定义项 id 是否合法（只认本文件定义的前缀 + 非空后缀）。 */
export function isCustomAlarmSoundId(id: string): boolean {
  return id.startsWith(CUSTOM_ALARM_SOUND_ID_PREFIX) && id.length > CUSTOM_ALARM_SOUND_ID_PREFIX.length
}

/** **唯一的音频格式**：手册第 5448 行写死了 `*.wav`。 */
export const ALARM_SOUND_FILE_EXTENSION = '.wav'

/**
 * 音频文件是否可接受。
 *
 * 只按扩展名判断，而且**大小写不敏感**（Windows 上 `Alarm.WAV` 与 `alarm.wav`
 * 是同一件事，一个区分大小写的检查会让操作员看到「格式不对」却找不出哪里不对）。
 * 内容不做解码校验：手册只规定格式，而本机没有解码器可以判 WAV 是否可听——
 * 假装校验过比不校验更糟。
 */
export function isAcceptableAlarmSoundFile(filePath: string): boolean {
  const name = baseName(filePath).toLowerCase()
  return name.endsWith(ALARM_SOUND_FILE_EXTENSION)
}

/** 取路径的最后一段。同时接受 `\` 与 `/`（用户可能从两种形态的路径里粘贴）。 */
export function baseName(filePath: string): string {
  const trimmed = filePath.trim()
  if (trimmed === '') return ''
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

/** 一条预定义声音记录。 */
export function predefinedAlarmSound(type: AlarmSoundTypeKey): AlarmSoundEntry {
  return { id: type, type, label: '', filePath: '', fileName: '' }
}

/** 出厂的完整声音库：六条预定义、都没有选文件、默认指向运动检测告警声。 */
export function defaultAlarmSoundLibrary(): AlarmSoundLibrary {
  return {
    items: ALARM_SOUND_TYPE_KEYS.map(predefinedAlarmSound),
    selectedId: '',
    defaultSoundId: DEFAULT_ALARM_SOUND_ID
  }
}

/**
 * 把任意（旧版本、被人手改过、或经 IPC 到达的）输入归一化成一份完整合法的声音库。
 *
 * 三条规则，与 `alarm-linkage-config.ts` 同一套：
 *   1. 非法值回落到默认值，**不抛异常**（一个坏配置不能让应用起不来）；
 *   2. 六种预定义类型**永远都在**、永远按目录顺序排在前面（手册说列表里有六种）；
 *   3. 被修正过的字段名会交回来，由调用方写日志——**绝不静默**。
 */
export function normaliseAlarmSoundLibrary(value: unknown): {
  library: AlarmSoundLibrary
  issues: string[]
} {
  const issues: string[] = []
  const defaults = defaultAlarmSoundLibrary()
  if (value === undefined) return { library: defaults, issues }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    issues.push('(root)')
    return { library: defaults, issues }
  }

  const source = value as Record<string, unknown>
  const rawItems = Array.isArray(source.items) ? source.items : []
  if (source.items !== undefined && !Array.isArray(source.items)) issues.push('items')

  /**
   * 预定义项：无论输入里有没有它们，都以**出厂那一份**为底，再用输入里的
   * `filePath` 覆盖。这样「输入里漏了一条预定义声音」不会让它从列表里消失。
   */
  const predefined = new Map<AlarmSoundTypeKey, AlarmSoundEntry>()
  for (const type of ALARM_SOUND_TYPE_KEYS) predefined.set(type, predefinedAlarmSound(type))

  const custom: AlarmSoundEntry[] = []
  const seenIds = new Set<string>()

  rawItems.forEach((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      issues.push(`items[${index}]`)
      return
    }
    const item = raw as Record<string, unknown>
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (id === '') {
      issues.push(`items[${index}].id`)
      return
    }
    const rawType = typeof item.type === 'string' ? item.type : null
    const type =
      rawType !== null && (ALARM_SOUND_TYPE_KEYS as readonly string[]).includes(rawType)
        ? (rawType as AlarmSoundTypeKey)
        : null

    const filePath = typeof item.filePath === 'string' ? item.filePath.trim() : ''
    if (item.filePath !== undefined && typeof item.filePath !== 'string') {
      issues.push(`items[${index}].filePath`)
    }
    /**
     * **非 `.wav` 的文件在归一化时被丢掉**（手册第 5448 行）。
     *
     * 这里不是「拒绝整个提交」，而是把那一格清空并记一条 issue：一次坏提交不该把
     * 用户已经选好的另外五条声音一起抹掉。界面另外会**在选文件时就拒绝**，
     * 所以走到这里还能看到 issue，说明那是一次绕过界面的写入。
     */
    let acceptedPath = filePath
    if (filePath !== '' && !isAcceptableAlarmSoundFile(filePath)) {
      issues.push(`items[${index}].filePath(${ALARM_SOUND_FILE_EXTENSION})`)
      acceptedPath = ''
    }

    if (type !== null) {
      // 预定义项：文件覆盖出厂那一份，`label` 由目录提供，忽略输入。
      const entry = predefined.get(type)
      if (!entry) {
        issues.push(`items[${index}].type`)
        return
      }
      if (seenIds.has(id) && id !== type) {
        issues.push(`items[${index}].id(duplicate)`)
        return
      }
      seenIds.add(type)
      entry.filePath = acceptedPath
      entry.fileName = baseName(acceptedPath)
      return
    }

    // 自定义项：必须有非空的 id 与名字。
    const label = typeof item.label === 'string' ? item.label.trim() : ''
    if (label === '') issues.push(`items[${index}].label`)
    if (seenIds.has(id)) {
      issues.push(`items[${index}].id(duplicate)`)
      return
    }
    seenIds.add(id)
    custom.push({
      id,
      type: null,
      label,
      filePath: acceptedPath,
      fileName: baseName(acceptedPath)
    })
  })

  const items: AlarmSoundEntry[] = [
    ...ALARM_SOUND_TYPE_KEYS.map((type) => predefined.get(type) as AlarmSoundEntry),
    ...custom
  ]

  const ids = new Set(items.map((item) => item.id))
  const rawDefault = typeof source.defaultSoundId === 'string' ? source.defaultSoundId.trim() : ''
  let defaultSoundId = rawDefault
  if (defaultSoundId === '' || !ids.has(defaultSoundId)) {
    if (rawDefault !== '') issues.push('defaultSoundId')
    defaultSoundId = defaults.defaultSoundId
  }

  const rawSelected = typeof source.selectedId === 'string' ? source.selectedId.trim() : ''
  let selectedId = rawSelected
  if (selectedId !== '' && !ids.has(selectedId)) {
    issues.push('selectedId')
    selectedId = ''
  }

  return { library: { items, selectedId, defaultSoundId }, issues }
}
