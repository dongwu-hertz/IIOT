/**
 * FA371 在线声学相机（泄漏检测型）—— HTTP 协议 DTO。
 *
 * 唯一来源：`docs/reference/FA371-api-spec.md`（从旧手册抽取的可实现规格），
 * 以及 2026-09 的两份新手册（`docs/reference/api-workflow.txt` 的 API 目录与流程、
 * `docs/reference/practical-guide.txt` 的使用指南）—— 两者的增补与**更正**见
 * `docs/FA371-API-DELTA.md`（其中一条把旧规格的缺口 C33 证伪了）。
 * 本文件是该设备族的**线上键名**（wire name）唯一住所；域模型见
 * `@shared/domain/fa371`，映射见 `./mappers`。
 * 项目硬规则：固件/手册的字段名可以出现在 `dto.ts` 与 `mappers.ts`，
 * 其它任何地方都不得出现（appendix C rule 2）。
 *
 * ---------------------------------------------------------------------------
 * 三条编写约定（与 `protocol/dto.ts` 一致，但针对 FA371 强化）
 * ---------------------------------------------------------------------------
 * 1) **读宽写严**：所有响应字段可选（手册示例普遍缺字段、示例 JSON 损坏）；
 *    写请求体里的字段按手册 `necessarily` 标记设为必填——设备是整体替换语义，
 *    少发一个字段等于把它重置。
 *
 * 2) **逐字保留手册拼写，包括疑似笔误**（规格 §1「保留原样拼写」）：
 *    `target_numbe` / `target_number`、`diagosisn` / `diagnosis`、
 *    `files_status` / `file_status`、`Times` / `times`、`Switch`、`Notes`、
 *    `Duration`、`discharge_switch`。
 *    **两种拼写都建模**，谁是真名由 Protocol Lab 实测决定；本文件只负责
 *    让两种都能被表达、被发送。
 *
 * 3) **手册未定义处不得猜死**：凡是规格 §8（UNDEFINED / AMBIGUOUS）标注的
 *    缺口，都建模成「一组具名候选」，可探测、可切换，绝不硬编码单一猜测。
 *    §8.3 C2/C22/C24/C25/C29/C30 对应本文件里的 `FA371_*_CANDIDATES`。
 */

// ---------------------------------------------------------------------------
// 通用响应包（规格 §1）
// ---------------------------------------------------------------------------

/**
 * 通用返回字段（规格 §1）：
 *   `ret` integer —— `200` 成功；部分接口定义 `-1` 为业务失败；
 *   `msg` String  —— 成功时为 `"SUCCESS"`。
 *
 * 注意：**不是所有接口都带 `ret`/`msg`**。已确认的例外：
 *   §5.1.15 `POST /turn_off_detect` 无响应内容；
 *   §5.1.16 `GET /system/detect_status` 只有 `detect_status`；
 *   §5.1.20 `GET /system_time` 只有 `sys_time`。
 * 因此 `ret`/`msg` 一律可选，缺省时视为成功（见 mappers.isFa371Success）。
 * §8.2 B3：`ret` 的完整错误码集合手册只在 4 处给出，其余未知。
 */
export interface Fa371AckDto {
  ret?: number
  msg?: string
  [key: string]: unknown
}

/** 规格 §1 明确的成功码。 */
export const FA371_RET_SUCCESS = 200

/**
 * 规格中唯一被反复定义的业务失败码（§5.1.14 无可用策略、§5.1.25 策略已启用、
 * §5.1.29 条件被策略绑定、§5.1.32 比对文件被绑定）。其余失败码 §8.2 B3 未定义。
 */
export const FA371_RET_BUSINESS_FAILURE = -1

// ---------------------------------------------------------------------------
// 登录（规格 §2.1）
// ---------------------------------------------------------------------------

/**
 * 登录请求字段（§2.1）。`password` = `md5(明文 + 'lfxs')` 32 位小写十六进制，
 * 派生实现在 `../auth-strategy.ts`（`derivePassword`），本文件只描述线上形状。
 */
export interface Fa371LoginRequestDto {
  username: string
  password: string
}

/**
 * 登录响应：**只有 `token`**，没有 `ret`/`msg`（§2.1）。
 * 手册称 token 为 "encrypted token value"，但**加密算法未说明**（§8.1 A4），
 * 因此这里只声明它是字符串，不做任何解码。
 */
export interface Fa371LoginResponseDto {
  /** 字段名就是小写 `token`（§2.1 明确）。 */
  token?: string
  [key: string]: unknown
}

/**
 * 登录请求体的封装方式。
 *
 * 规格 §2.1 的规范化示例是**裸对象** `{username, password}`；
 * 而同家族的 AE08 实测要求 `{msgBody:{username, password}}`（见 auth-resolver）。
 * FA371 手册没有 `msgBody` 这一层，所以默认按手册发裸对象，
 * 但把这个不确定性建模成候选，供 Protocol Lab 探测（§8.1 A7 登录失败形状未知）。
 */
export type Fa371LoginEnvelopeId = 'plain' | 'msgBody'

export interface Fa371LoginEnvelopeCandidate {
  id: Fa371LoginEnvelopeId
  /** 供 Protocol Lab 报告使用的中文说明。 */
  description: string
  /**
   * 输入是 `auth-strategy.buildLoginBody()` 产出的 `{username, password}`，
   * 类型取 `Record<string, unknown>` 是因为那个模块不依赖本文件。
   */
  wrap(body: Record<string, unknown>): unknown
}

export const FA371_LOGIN_ENVELOPE_CANDIDATES: readonly Fa371LoginEnvelopeCandidate[] = [
  {
    id: 'plain',
    description: '裸对象 {"username":..,"password":..}（手册 §2.1 规范化示例逐字如此）',
    wrap: (body) => ({ username: body.username, password: body.password })
  },
  {
    id: 'msgBody',
    description: '{"msgBody":{...}} 包裹（AE08 实测形状；FA371 手册无此约定，仅作探测候选）',
    wrap: (body) => ({ msgBody: { username: body.username, password: body.password } })
  }
]

/** 默认按手册发裸对象。 */
export const DEFAULT_FA371_LOGIN_ENVELOPE: Fa371LoginEnvelopeId = 'plain'

// ---------------------------------------------------------------------------
// §5.1.2 / §5.1.3 声场配置
// ---------------------------------------------------------------------------

/**
 * `GET /system/acoustic` 响应。
 *
 * §8.3 C1（P0）：示例 `samplerate: 13200` 与合法值 `96000/132000` 量纲矛盾，
 * 且字段说明写「单位 KHz」而数值 96000 显然不是 KHz。
 * **单位不可推断** → 原样保留数值，单位不确定性由 mapper 的候选集表达。
 */
export interface Fa371AcousticDto {
  /** 分析频带上限，手册标 KHz（示例 25）。 */
  freq_up_limit?: number | string
  /** 分析频带下限，手册标 KHz（示例 20）。 */
  freq_down_limit?: number | string
  /** MIC 阵列采样率。手册字段说明标 KHz，取值却是 96000 / 132000 → §8.3 C1。 */
  samplerate?: number | string
  ret?: number
  msg?: string
  [key: string]: unknown
}

/**
 * `PUT /system/acoustic` 请求体（§5.1.3）。
 *
 * 手册字段表标 `non-essential`（支持部分字段），但正文约束「上下限之差 2~20、
 * 上限>下限」——**只发单个字段时设备如何校验，手册未说明**（§5.1.3 缺口）。
 * 因此这里三个字段都可选，由调用方决定发哪些。
 */
export interface Fa371AcousticWriteDto {
  freq_up_limit?: number
  freq_down_limit?: number
  samplerate?: number
}

// ---------------------------------------------------------------------------
// §5.1.4 / §5.1.5 成像配置
// ---------------------------------------------------------------------------

/**
 * `GET /system/image` 响应。
 *
 * §8.3 C2（P0）：字段表键名是 `target_numbe`（漏了 `r`），示例 JSON 里是
 * `target_number`；且字段表声明 `imaging_sensitivity` / `imaging_enhance`，
 * 示例 JSON 里**完全没有这两个键**。→ 两种拼写都建模，谁真谁假必须实测。
 */
export interface Fa371ImagingDto {
  /** 成像阈值（范围/单位未说明，§8.3 C3）。 */
  energy_threshold?: number | string
  /** 示例 JSON 的拼写。 */
  target_number?: number | string
  /** 字段表的拼写（疑似笔误，必须按原样匹配）。 */
  target_numbe?: number | string
  /** 成像滤波灵敏度，手册标 `[0,2]`；示例里没有这个键。 */
  imaging_sensitivity?: number | string
  /** 成像增强，手册标 `[0,2]`，`0` = off；示例里没有这个键。 */
  imaging_enhance?: number | string
  ret?: number
  msg?: string
  [key: string]: unknown
}

/**
 * `PUT /system/image` 请求体。
 *
 * 目标数量当前最多 3（§5.1.5 正文）。真实键名未知（§8.3 C2），
 * 所以两个键都留可选，实际发哪个由客户端的 `imagingTargetCountKey` 选项决定。
 */
export interface Fa371ImagingWriteDto {
  energy_threshold?: number
  target_number?: number
  target_numbe?: number
  imaging_sensitivity?: number
  imaging_enhance?: number
}

/**
 * §8.3 C2 的具名候选：写「目标数量」时用哪个键。
 * 默认 `target_number`（示例 JSON 的拼写，属于真实设备响应留下的证据），
 * 但可切换到字段表拼写，或两个都发（探测用）。
 */
export type Fa371ImagingTargetKeyId = 'target_number' | 'target_numbe' | 'both'

export interface Fa371ImagingTargetKeyCandidate {
  id: Fa371ImagingTargetKeyId
  description: string
  apply(body: Fa371ImagingWriteDto, value: number): void
}

export const FA371_IMAGING_TARGET_KEY_CANDIDATES: readonly Fa371ImagingTargetKeyCandidate[] = [
  {
    id: 'target_number',
    description: 'target_number（§5.1.4 示例 JSON 的拼写）',
    apply: (body, value) => {
      body.target_number = value
    }
  },
  {
    id: 'target_numbe',
    description: 'target_numbe（§5.1.4 字段表拼写，漏 r）',
    apply: (body, value) => {
      body.target_numbe = value
    }
  },
  {
    id: 'both',
    description: '两个键都发（探测用；设备是否忽略未知键未说明）',
    apply: (body, value) => {
      body.target_number = value
      body.target_numbe = value
    }
  }
]

export const DEFAULT_FA371_IMAGING_TARGET_KEY: Fa371ImagingTargetKeyId = 'target_number'

// ---------------------------------------------------------------------------
// §5.1.6 / §5.1.7 视频与 RTSP 配置
// ---------------------------------------------------------------------------

/**
 * `GET /system/video` 响应。
 *
 * §8.3 C4（P0）：字段表把 `video_url` 标为 integer，示例值却是字符串 `"live"`
 * → 联合类型 `string | number`，由 mapper 归一化。
 */
export interface Fa371VideoDto {
  video_bit_rate?: number | string
  video_fps?: number | string
  video_height?: number | string
  video_width?: number | string
  /** 翻转模式：0 默认 / 1 垂直 / 2 水平 / 3 180°。 */
  video_flip_model?: number | string
  /** RTSP 服务端口（示例 443；是否是 TLS 未说明，§8.5 E3）。 */
  video_port?: number | string
  /** RTSP 服务 url（手册标 integer，示例是字符串 `"live"`）。 */
  video_url?: string | number
  rtsp_connected_num?: number | string
  rtsp_client_limit?: number | string
  rtsp_enabled?: number | string
  ret?: number
  msg?: string
  [key: string]: unknown
}

/**
 * `PUT /system/video` 请求体（§5.1.7）。
 *
 * §8.3 C5：请求字段表**未列 `rtsp_connected_num`**，示例却发了它（只读计数）。
 * 这里保留该字段但标注为「只读回显」，客户端默认不发送（调用方可通过选项要求发送）。
 * 分辨率必须 `video_height`/`video_width` 成对出现，且手册只承认 1920*1080、1280*720。
 */
export interface Fa371VideoWriteDto {
  video_height?: number
  video_width?: number
  video_fps?: number
  video_bit_rate?: number
  video_flip_model?: number
  video_port?: number
  video_url?: string | number
  rtsp_client_limit?: number
  rtsp_enabled?: number
  /** 只读计数，§5.1.7 字段表未列；默认不发送。 */
  rtsp_connected_num?: number
}

// ---------------------------------------------------------------------------
// §5.1.8 / §5.1.9 运行模式
// ---------------------------------------------------------------------------

/**
 * `GET /run_mode` 响应。`run_mode`：`1` 单次检测模式；`-1` 智能巡航模式（§5.1.8）。
 */
export interface Fa371RunModeDto {
  run_mode?: number | string
  ret?: number
  msg?: string
  [key: string]: unknown
}

/** `PUT /run_mode` 请求体。 */
export interface Fa371RunModeWriteDto {
  run_mode: number
}

// ---------------------------------------------------------------------------
// 应用模式（`GET` / `PUT /system`）—— **手册未收录，真机实测**
// ---------------------------------------------------------------------------

/**
 * `GET /system` 响应。
 *
 * ---------------------------------------------------------------------------
 * ⚠ 这个端点是**未文档化**的，不要把它当成受支持的 API
 * ---------------------------------------------------------------------------
 * 它**不在**任何一份手册里（`docs/reference/FA371-api-spec.md`、
 * `api-workflow.txt`、`practical-guide.txt`、`leak-detection-manual.txt` 全都没有
 * `/system` 这一条，§5.1 的 32 个接口清单里也没有）。它是从**设备自带 Web 界面的
 * bundle** 里读出来的（`/static/js/main.<hash>.js`，设备前端用
 * `on().then(e => e.data.work_mode)` 读它，而 `on()` 打的就是 `/system`）。
 * 因此本文件把它与手册接口分开标注。
 *
 * 实测（`192.168.110.235`，`V0.5.1.6_251219`）：
 *
 *   `GET /system`                     → `200 {"msg":"SUCCESS","ret":200,"work_mode":1}`
 *   `PUT /system` `{"work_mode":2}`   → `200 {"msg":"SUCCESS","ret":200}`，重读 `work_mode:2` ✅
 *   `PUT /system` `{"work_mode":3}`   → `200`，重读 `work_mode:3` ✅
 *   `PUT /system` `{"work_mode":1}`   → `200`，重读 `work_mode:1` ✅
 *
 * 也就是说：**这个之前被判定为"只读"的端点其实是可写的**。上一版结论
 * （`docs/FA371-API-DELTA.md` §13「不能写：无端点、无手册、设备端也不提供控件」）
 * 已被这次真机实验证伪 —— 设备自家 UI 里确实**没有**切换控件（整个 bundle 里
 * `work_mode:` 作为请求体键出现 0 次），但 PUT 本身是有效的。
 *
 * 猜测出来的路径一律 **404**（`/system/work_mode`、`/system/app_mode`、`/system/mode`、
 * `/system/device_mode`、`/system/product_mode` 都实测过）——这个端点只能靠读设备
 * 前端代码找到，猜是猜不到的。
 *
 * 取值语义来自设备自己的前端代码，逐字照抄：
 *
 *   ```js
 *   1 == t ? ti.get("PartialDischargeDetectionMode")
 *          : 2 == t ? ti.get("LeakDetectionMode")
 *                   : ti.get("MechanicalNoiseDetectionMode")
 *   ```
 *
 * 即 **1 = 局部放电，2 = 气体泄漏，其它 = 机械异响**。
 *
 * `ret`/`msg` 只是通用包络，与手册一致；`work_mode` 的类型按读取宽容处理
 * （设备返回的是数字，但没有文档保证它不会变成字符串）。
 */
export interface Fa371SystemDto {
  work_mode?: number | string
  ret?: number
  msg?: string
  [key: string]: unknown
}

/**
 * `PUT /system` 请求体。
 *
 * 只发 `work_mode` 一个字段。**这很重要**：这台设备的 `/system` 是否支持部分字段
 * 更新、以及不发其它字段会不会把它们重置，都**没有文档**（端点本身就没文档）。
 * `Fa371ApiClient.setWorkMode` 因此只构造这一个键，并且切换应用模式**不碰**
 * `/system/acoustic` 与 `/system/image`（那两条是成像参数，属于另一条通道）。
 */
export interface Fa371WorkModeWriteDto {
  work_mode: number
}

// ---------------------------------------------------------------------------
// §5.1.10 / §5.1.11 泄漏估算配置
// ---------------------------------------------------------------------------

/**
 * `GET /system/leakage` 响应。
 *
 * §8.3 C7（P1）：示例中 `leakage_unit: 1` 配 `"l/min"`（按定义 `1` 应为 `ml/s`）、
 * `monetary_unit: 1` 配 `"CNY"`（按定义 `1` 应为 GBP）——**示例与枚举不一致**。
 * 因此两个 `*_str` 原样保留，与代码值的矛盾由 mapper 显式标记，不做静默纠正。
 */
export interface Fa371LeakageDto {
  /** `0` 不展示 / `1` 展示。 */
  cost_display?: number | string
  /** 泄漏估算距离，范围 `[1~50]` 米。 */
  leakage_distance?: number | string
  /** `0` = l/min，`1` = ml/s。 */
  leakage_unit?: number | string
  leakage_unit_str?: string
  /** `0` ¥ / `1` £ / `2` $ / `3` € / `4` ₽。 */
  monetary_unit?: number | string
  monetary_unit_str?: string
  value_of_gas?: number | string
  energy_cost?: number | string
  specific_power?: number | string
  working_hours?: number | string
  ret?: number
  msg?: string
  [key: string]: unknown
}

/**
 * `PUT /system/leakage` 请求体（§5.1.11）。
 *
 * 手册原文支持部分字段更新（"the corresponding field is sent separately if a
 * parameter needs to be configured"），且示例里**没有**两个 `*_str`——
 * 它们是否可由客户端设置（还是设备回显）手册未说明（§8.3 C8）。
 */
export interface Fa371LeakageWriteDto {
  cost_display?: number
  leakage_distance?: number
  leakage_unit?: number
  monetary_unit?: number
  value_of_gas?: number
  energy_cost?: number
  specific_power?: number
  working_hours?: number
}

// ---------------------------------------------------------------------------
// §5.1.12 / §5.1.13 检测区域
// ---------------------------------------------------------------------------

/** 单个矩形检测区。 */
export interface Fa371ScanAreaItemDto {
  area_height?: number | string
  area_width?: number | string
  /** `0` 隐藏 / `1` 显示。 */
  detect_area_status?: number | string
  left_top_x?: number | string
  left_top_y?: number | string
  [key: string]: unknown
}

/**
 * `GET /system/scan_area` 响应。
 *
 * §8.3 C9/C10（P0）：**坐标单位与参考系未知**。示例横轴最大 992+240=1232
 * （暗示基准约 1920），纵轴 704+168=872 与 1080 不吻合；
 * 且 GET 示例给 240×168、PUT 示例给 768×432。数组长度上限也未说明。
 * → 原样保留数值，坐标系假设由 mappers 的候选集表达。
 */
export interface Fa371ScanAreaDto {
  areas?: Fa371ScanAreaItemDto[]
  /** `1` 中心聚焦 / `2` 框选。 */
  center_focus?: number | string
  ret?: number
  msg?: string
  [key: string]: unknown
}

/**
 * `PUT /system/scan_area` 请求体（§5.1.13）。
 *
 * 手册明确要求「all fields need to be sent when requesting」→ 写侧字段必填。
 */
export interface Fa371ScanAreaWriteDto {
  areas: Array<{
    area_height: number
    area_width: number
    detect_area_status: number
    left_top_x: number
    left_top_y: number
  }>
  center_focus: number
}

// ---------------------------------------------------------------------------
// §5.1.14 / §5.1.15 检测启停
// ---------------------------------------------------------------------------

/**
 * `POST /turn_on_detect` 响应。
 *
 * `detect_id` 仅在单次检测模式开启时返回（§5.1.14）；巡航模式下是缺字段还是 `0`
 * 手册未说明（§8.3 C11），故可选。
 */
export interface Fa371TurnOnDetectDto {
  detect_id?: number | string
  ret?: number
  msg?: string
  [key: string]: unknown
}

/** `POST /turn_off_detect`：**无响应内容**（§5.1.15），因此没有响应 DTO。 */

// ---------------------------------------------------------------------------
// §5.1.16 检测状态
// ---------------------------------------------------------------------------

/**
 * `GET /system/detect_status` 响应——**全组唯一缺 `ret`/`msg` 的接口**，
 * 且字段表类型写 `boolean`、取值语义是 `0`/`1`（§8.3 C13，P0）。
 * 两者都由 mapper 归一化。
 */
export interface Fa371DetectStatusDto {
  detect_status?: number | string | boolean
  ret?: number
  msg?: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// §5.1.17 检测日志
// ---------------------------------------------------------------------------

/**
 * 一条检测日志。
 *
 * 字段表与示例的冲突（§8.3 C14/C15/C16，全部为 P0/P1）：
 *   - 字段表列了 `alarm_strategy_id`/`alarm_level`/`nc_file`/`last_alarm_db`/
 *     `last_alarm_df`/`last_alarm_nc`/`is_alarm`/`nc_file_path`/
 *     `nc_file_fft_photo_name`，**两处示例 JSON 里一个都没有** → 全部可选；
 *   - `files_status`（示例）vs `file_status`（字段表）→ 两种都建模；
 *   - `start_time`/`end_time` 字段表标 string、示例是整数 → 联合类型；
 *   - `soundmap_intensity` 字段表标 int、示例是 `20.4` 浮点 → number。
 * 时间戳单位/时区未说明（§8.2 B5）→ 原样保留，由 mapper 表达不确定性。
 */
export interface Fa371DetectLogDto {
  id?: number | string
  detect_mode?: number | string
  start_time?: number | string
  end_time?: number | string
  status?: number | string
  soundmap_intensity?: number | string
  /** 示例拼写。 */
  files_status?: number | string
  /** 字段表拼写。二者冲突，§8.3 C16。 */
  file_status?: number | string
  /** 以开始时间命名的文件夹，自带结尾 `/`（§5.1.18 缺口提到可能产生双斜杠）。 */
  saving_path?: string
  power_spect_video_name?: string
  power_spect_photo_name?: string
  soundmap_video_name?: string
  soundmap_photo_name?: string
  voiceprint_video_name?: string
  voiceprint_photo_name?: string
  bin_mic_data_name?: string
  wav_mic_data_name?: string
  /** `data_1`~`data_4`：泄漏量/泄漏成本/泄漏单位/成本单位（§5.1.17 字段表）。 */
  data_1?: number | string
  data_2?: number | string
  data_3?: number | string
  data_4?: number | string
  // -- 字段表有、示例无的告警字段（§8.3 C15） ----------------------------
  alarm_strategy_id?: number | string
  alarm_level?: number | string
  nc_file?: string
  last_alarm_db?: number | string
  last_alarm_df?: number | string
  last_alarm_nc?: number | string
  is_alarm?: number | string
  nc_file_path?: string
  nc_file_fft_photo_name?: string
  [key: string]: unknown
}

/**
 * `GET /detect_logs` 响应。
 *
 * §8.3 C14（P0）：字段表说返回 `detect_logs` **数组**，示例却是一个**裸对象**
 * （键直接是 `bin_mic_data_name` 那一层）；§5.2.3 又用单数 `detect_log`。
 * 三种形状都建模，由 `mappers.mapDetectLogs` 统一接纳。
 */
export interface Fa371DetectLogsEnvelopeDto {
  detect_logs?: Fa371DetectLogDto[] | Fa371DetectLogDto
  detect_log?: Fa371DetectLogDto
  ret?: number
  msg?: string
  [key: string]: unknown
}

/**
 * `GET /detect_logs` 的 `detect_id` 传参方式。
 *
 * §8.3 C14（P0）：手册同页给出两种互相矛盾的说法——
 * 「The request parameters need to be put into the Query Param of the HTTP request」
 * 与 `Request format: http://localhost/detect_logs/{detect_id}`。
 * 分页参数手册未说明。
 */
export type Fa371DetectLogsQueryStyleId = 'query_param' | 'path_segment'

export interface Fa371DetectLogsQueryStyleCandidate {
  id: Fa371DetectLogsQueryStyleId
  description: string
  buildPath(detectId: number): string
}

export const FA371_DETECT_LOGS_QUERY_STYLE_CANDIDATES: readonly Fa371DetectLogsQueryStyleCandidate[] =
  [
    {
      id: 'query_param',
      description: '?detect_id=<id>（「Query Param」说明，默认）',
      buildPath: (detectId) => `/detect_logs?detect_id=${encodeURIComponent(String(detectId))}`
    },
    {
      id: 'path_segment',
      description: '/detect_logs/<id>（Request format 行给出的路径式）',
      buildPath: (detectId) => `/detect_logs/${encodeURIComponent(String(detectId))}`
    }
  ]

export const DEFAULT_FA371_DETECT_LOGS_QUERY_STYLE: Fa371DetectLogsQueryStyleId = 'query_param'

// ---------------------------------------------------------------------------
// §5.1.19 删除检测日志
// ---------------------------------------------------------------------------

/**
 * `DELETE /detect_logs` 请求体：待删除日志 id 数组。
 *
 * §8.3 C18（P1）：字段表 `id` 类型写 `string`，示例是数组 `[2,3]`，且示例缺右花括号。
 * 字段名 `id` 与示例一致，所以这个接口的候选集只需要形状层面的（见下）。
 */
export type Fa371IdListBody = { id: number[] }

/**
 * id 数组请求体的具名候选。
 *
 * 适用范围（规格 §8.3 三个 P0 缺口，都是「请求字段名缺失」）：
 *   §5.1.19 `DELETE /detect_logs` —— 示例 `{"id":[2,3]}`（有字段名，作基准）
 *   §5.1.24 `DELETE /alarm_strategy` —— 只给了类型 `integer[]`，字段名缺失
 *   §5.1.29 `DELETE /alarm_condition` —— 同上
 *   §5.1.32 `DELETE /nc_file` —— 同上
 * 默认按 §5.1.19 的 `{"id":[...]}`（唯一有字段名的先例），其余可切换。
 */
export type Fa371IdListBodyId = 'id_array_object' | 'bare_array' | 'ids_array_object'

export interface Fa371IdListBodyCandidate {
  id: Fa371IdListBodyId
  description: string
  build(ids: readonly number[]): unknown
}

export const FA371_ID_LIST_BODY_CANDIDATES: readonly Fa371IdListBodyCandidate[] = [
  {
    id: 'id_array_object',
    description: '{"id":[1,2]}（§5.1.19 示例；字段名缺失的三处照此先例推断）',
    build: (ids) => ({ id: [...ids] })
  },
  {
    id: 'bare_array',
    description: '裸数组 [1,2]（§5.1.24/§5.1.29/§5.1.32 的字段表只给 integer[]）',
    build: (ids) => [...ids]
  },
  {
    id: 'ids_array_object',
    description: '{"ids":[1,2]}（字段名缺失的另一种可能拼写）',
    build: (ids) => ({ ids: [...ids] })
  }
]

export const DEFAULT_FA371_ID_LIST_BODY: Fa371IdListBodyId = 'id_array_object'

// ---------------------------------------------------------------------------
// §5.1.20 / §5.1.21 系统时间
// ---------------------------------------------------------------------------

/**
 * `GET /system_time` 响应——**缺 `ret`/`msg`**（与 §5.1.16 同类例外）。
 *
 * §8.3 C19（P0）：示例 `sys_time: 17220332` 只有 8 位，既不像秒级也不像毫秒级
 * Unix 时间戳（示例疑似被截断），**单位未说明** → 原样保留，由 mapper 表达。
 */
export interface Fa371SystemTimeDto {
  sys_time?: number | string
  [key: string]: unknown
}

/**
 * `PUT /time_set_manually` 请求体。
 *
 * 注意读写键名不对称：读用 `sys_time`、写用 `time`（§8.3 C20）。
 * 单位同样未说明（§8.2 B5）。
 */
export interface Fa371SystemTimeWriteDto {
  time: number
}

// ---------------------------------------------------------------------------
// §5.1.22 – §5.1.25 告警策略
// ---------------------------------------------------------------------------

/**
 * 一条告警策略（读取侧，§5.1.22）。
 *
 * §8.3 C21（P0）：`id` 字段表标 **string**，而 `PUT`（§5.1.25）里 `id` 是 integer；
 * `level` 读侧文档写 `0,1,2,3`、写侧 `1,2,3,4`。两处冲突都只做原样保留 + 标记。
 * `Times` / `Switch` 是手册原文的大写拼写，必须按原样匹配。
 */
export interface Fa371AlarmStrategyDto {
  id?: number | string
  name?: string
  alias?: string
  alarm_condition_id?: number | string
  alarm_condition_name?: string
  interval_time?: number | string
  /** 手册原文大写 `Times`（写入用 `times`）。 */
  Times?: number | string
  timeout_duration?: number | string
  sensitivity?: number | string
  level?: number | string
  diagnosis?: string
  /** 手册原文大写 `Switch`：`1` 开 `0` 关。 */
  Switch?: number | string
  [key: string]: unknown
}

/** `GET /alarm_strategy?page=` 响应（§5.1.22，手册**没有**返回示例）。 */
export interface Fa371AlarmStrategyPageDto {
  alarm_strategy_list?: Fa371AlarmStrategyDto[]
  page_total?: number | string
  ret?: number
  msg?: string
  [key: string]: unknown
}

/**
 * `POST /alarm_strategy` 请求体（§5.1.23）。
 *
 * §8.3 C22（P0）：键名 `diagosisn` 是 `diagnosis` 的笔误，**手册明确要求按原样发送**；
 * 但 §5.1.25 `PUT` 用的是 `diagnosis`。两个键都建模，由
 * `FA371_STRATEGY_DIAGNOSIS_KEY_CANDIDATES` 决定实际发哪个。
 * 写入用 `alarm_id`、读取用 `alarm_condition_id`（手册原文如此）。
 * `times` 小写（读取是 `Times`）。
 */
export interface Fa371AlarmStrategyCreateDto {
  name: string
  alias: string
  alarm_id: number
  level: number
  interval_time: number
  times: number
  timeout_duration: number
  sensitivity: number
  /** 手册拼写（疑似笔误），按 spec 必须原样发送。 */
  diagosisn?: string
  /** 正确拼写，作为候选保留。 */
  diagnosis?: string
}

/** `PUT /alarm_strategy` 请求体（§5.1.25）：比新建多一个 `id`。 */
export interface Fa371AlarmStrategyUpdateDto extends Fa371AlarmStrategyCreateDto {
  id: number
}

/**
 * `PUT /alarm_strategy_enable` 请求体。
 *
 * 出处是 **2026-09 的 `docs/reference/api-workflow.txt` 第 340–346 行**
 * （`GET /alarm_strategy_enable` 读、`PUT` 写）与第 129–134 行的流程说明；
 * 旧手册把这一对接口整段漏掉了，旧规格因此记成了不存在的缺口 `C33`
 * （更正见 `docs/FA371-API-DELTA.md` §1）。
 *
 * 字段形状**不是猜的**：设备自带 Web 界面的 bundle
 * （`/static/js/main.<hash>.js`）里就是 `{ switch: t ? 1 : 0, id: e.id }` 一个 PUT，
 * 且该 bundle 对 `ret == -1` 的文案是「策略开启失败，您当前开启的策略数量已达上限」
 * —— 与手册「同时最多一条策略启用」一致。真机实测（192.168.110.235，
 * `V0.5.1.6_251219`）：`{switch:1,id:1}` → `ret:200`，重读确实变为 `switch:1`。
 */
export interface Fa371AlarmStrategyEnableWriteDto {
  /** `1` 启用 / `0` 停用。 */
  switch: number
  id: number
}

/**
 * §8.3 C22 的具名候选：写策略诊断说明时用哪个键。
 * 默认 `diagosisn`（§5.1.23 明文要求原样发送），可切换为 `diagnosis` 或两个都发。
 */
export type Fa371StrategyDiagnosisKeyId = 'diagosisn' | 'diagnosis' | 'both'

export interface Fa371StrategyDiagnosisKeyCandidate {
  id: Fa371StrategyDiagnosisKeyId
  description: string
  apply(body: Fa371AlarmStrategyCreateDto, value: string): void
}

export const FA371_STRATEGY_DIAGNOSIS_KEY_CANDIDATES: readonly Fa371StrategyDiagnosisKeyCandidate[] =
  [
    {
      id: 'diagosisn',
      description: 'diagosisn（§5.1.23 明文键名，笔误但必须原样发送）',
      apply: (body, value) => {
        body.diagosisn = value
      }
    },
    {
      id: 'diagnosis',
      description: 'diagnosis（§5.1.25 PUT 与 §5.1.22 读取侧的拼写）',
      apply: (body, value) => {
        body.diagnosis = value
      }
    },
    {
      id: 'both',
      description: '两个键都发（探测用）',
      apply: (body, value) => {
        body.diagosisn = value
        body.diagnosis = value
      }
    }
  ]

export const DEFAULT_FA371_STRATEGY_DIAGNOSIS_KEY: Fa371StrategyDiagnosisKeyId = 'diagosisn'

// ---------------------------------------------------------------------------
// §5.1.26 – §5.1.29 告警条件
// ---------------------------------------------------------------------------

/**
 * 一条告警条件（读取侧，§5.1.26）。
 *
 * `Notes` 是手册原文大写拼写。`discharge_*` 三字段**读取侧没有**（写读不对称，
 * §8.3 C26）→ 本接口不声明它们（见写入 DTO）。
 */
export interface Fa371AlarmConditionDto {
  id?: number | string
  name?: string
  /** dB 告警值（范围/单位未说明，§8.3 C28）。 */
  decibel_thr?: number | string
  /** `(0-4)` 对应 `>, <, =, >=, <=`。 */
  db_arithmetic_operator?: number | string
  db_switch?: number | string
  /** 主频告警值（Hz 还是 kHz 未说明，§8.3 C28）。 */
  dominant_freq_thr?: number | string
  df_arithmetic_operator?: number | string
  df_switch?: number | string
  /** `0` = `||`，`1` = `&&`。 */
  df_logical_operator?: number | string
  noise_comparison_file_id?: number | string
  /** 噪声相似度 `0-1`。 */
  noise_comparison_thr?: number | string
  nc_switch?: number | string
  nc_logical_operator?: number | string
  /** 读取侧手册只写符号 `>`、`<`，未给数字枚举（§8.3 C28）。 */
  nc_arithmetic_operator?: number | string
  /** 手册原文大写 `Notes`。 */
  Notes?: string
  [key: string]: unknown
}

/** `GET /alarm_condition?page=` 响应（§5.1.26，手册无返回示例）。 */
export interface Fa371AlarmConditionPageDto {
  alarm_condition_list?: Fa371AlarmConditionDto[]
  page_total?: number | string
  ret?: number
  msg?: string
  [key: string]: unknown
}

/**
 * `POST/PUT /alarm_condition` 请求体（§5.1.27 / §5.1.28，两节字段表相同）。
 *
 * §8.3 C26（P0）：`discharge_*` 只出现在写入接口，读取字段表与 §4.4 UI 描述都没有
 * ——写读不对称；且 `discharge_switch` 类型标 **string** 而取值是 `0/1`。
 * §8.3 C27：`discharge_type` 枚举缺 `3`（`0,1,2,4`）。
 * PUT 的 `id` 问题见 `FA371_ALARM_CONDITION_UPDATE_ID_CANDIDATES`。
 */
export interface Fa371AlarmConditionWriteDto {
  name: string
  decibel_thr: number
  db_arithmetic_operator: number
  db_switch: number
  dominant_freq_thr: number
  df_arithmetic_operator: number
  df_switch: number
  df_logical_operator: number
  noise_comparison_file_id: number
  noise_comparison_thr: number
  nc_switch: number
  nc_logical_operator: number
  nc_arithmetic_operator: number
  /** 手册类型标 string、取值 `0`/`1` → 联合类型。 */
  discharge_switch?: number | string
  discharge_logical_operator?: number
  /** `0` 电晕 / `1` 悬浮 / `2` 沿面 / `4` 放电（缺 `3`）。 */
  discharge_type?: number
  notes?: string
}

/**
 * §8.3 C25（P0，本规格最严重的「无法实现」缺口之一）的具名候选：
 * `PUT /alarm_condition` 的请求字段表里**没有 `id`**，无法得知要改哪一条。
 *
 * 默认沿用 `PUT /alarm_strategy`（§5.1.25）的先例发 `id`；
 * 另外两种可能（不发标识 / 用读取侧的 `alarm_condition_id`）保留为候选。
 */
export type Fa371AlarmConditionUpdateIdStyleId = 'id' | 'none' | 'alarm_condition_id'

export interface Fa371AlarmConditionUpdateIdCandidate {
  id: Fa371AlarmConditionUpdateIdStyleId
  description: string
  /** 把目标 id 合并进请求体；`none` 表示原样发送（调用方自负其责）。 */
  apply(body: Record<string, unknown>, targetId: number | string): void
}

export const FA371_ALARM_CONDITION_UPDATE_ID_CANDIDATES: readonly Fa371AlarmConditionUpdateIdCandidate[] =
  [
    {
      id: 'id',
      description: '{"id":<id>, ...}（沿用 §5.1.25 PUT /alarm_strategy 的先例，默认）',
      apply: (body, targetId) => {
        body.id = targetId
      }
    },
    {
      id: 'none',
      description: '不带任何标识字段（照 §5.1.28 字段表字面实现；是否可行未知）',
      apply: () => undefined
    },
    {
      id: 'alarm_condition_id',
      description: '{"alarm_condition_id":<id>, ...}（读取侧 §5.1.26 的 id 拼写）',
      apply: (body, targetId) => {
        body.alarm_condition_id = targetId
      }
    }
  ]

export const DEFAULT_FA371_ALARM_CONDITION_UPDATE_ID: Fa371AlarmConditionUpdateIdStyleId = 'id'

// ---------------------------------------------------------------------------
// §5.1.30 – §5.1.32 噪声比对文件
// ---------------------------------------------------------------------------

/**
 * `POST /upload_nc` 响应（§5.1.30）。
 *
 * §8.3 C31（P1）：返回的 `ret`/`msg` 具体取值、**是否回传新文件 id 均未说明**——
 * 上传后拿不到 `noise_comparison_file_id`，无法给条件绑定比对文件。
 * 因此这里除了 `ret`/`msg` 之外把 payload 当作未知，由调用方自行寻找。
 */
export interface Fa371NcUploadDto {
  ret?: number
  msg?: string
  [key: string]: unknown
}

/** `POST /upload_nc` 的表单字段名：文件 `nc_file`、备注 `notes`（§5.1.30）。 */
export const FA371_NC_UPLOAD_FILE_FIELD = 'nc_file'
export const FA371_NC_UPLOAD_NOTES_FIELD = 'notes'

/** 一条比对文件（§5.1.31）。`Duration` / `Notes` 大写是手册原文。 */
export interface Fa371NcFileDto {
  id?: number | string
  file_name?: string
  /** 单位未说明（§8.3 C32）。 */
  file_size?: number | string
  /** 单位未说明（§8.3 C32）。 */
  samplerate?: number | string
  /** 手册原文大写 `Duration`，单位未说明。 */
  Duration?: number | string
  /** 手册原文大写 `Notes`。 */
  Notes?: string
  [key: string]: unknown
}

/** `GET /nc_filelist?page=` 响应（每页默认 10 条，§5.1.31）。 */
export interface Fa371NcFilePageDto {
  nc_file_list?: Fa371NcFileDto[]
  page_total?: number | string
  ret?: number
  msg?: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// §5.1.18 结果文件下载
// ---------------------------------------------------------------------------

/**
 * `GET /detect_file/{log.saving_path}/{logs.file_name}` 的下载结果。
 *
 * §8.3 C17（P1）：占位符命名 `{log.saving_path}` / `{logs.file_name}` 不统一；
 * `saving_path` 自带结尾 `/`（§5.1.17 示例 `"2019_06_20_20_30_39_940/"`），
 * 拼接是否产生双斜杠未说明；**下载是否需要 `Authorization` 头也未说明**。
 * 客户端仍然发送 token（不能依赖设备不校验），并把原始 content-type 交回调用方。
 */
export interface Fa371DownloadedFile {
  bytes: Uint8Array
  contentType: string
  status: number
}

// ---------------------------------------------------------------------------
// 手册未收录、设备自带 Web 界面在用的只读接口（实测存在）
// ---------------------------------------------------------------------------

/**
 * `GET /dev_info` 响应 —— 设备自报的版本信息。
 *
 * **手册与旧规格都写着「系统信息读取只有 UI、开放接口未开放」（旧 §8.5 E10），
 * 实测把这句推翻了。** 该路径来自设备自带 Web 界面的 bundle：界面用
 * `ge.device_version` 渲染「固件版本」、`M.basic_server_version` 渲染
 * 「基础服务版本」、`M.upgrade_time` 渲染「发布时间」。
 *
 * 真机实测（192.168.110.235，`V0.5.1.6_251219`）：
 *   `GET /dev_info` → `{"device_version":"V0.5.1.6_251219","msg":"SUCCESS","ret":200,"sdk_version":"v8.1.0"}`
 *
 * 注意它**不是**声学箱的 `/get_devinfo`：后者在本设备上不存在，会落到 SPA 的
 * 兜底路由（HTTP 200 + `index.html`），而 `fa371-api-client.call()` 会显式拒绝
 * 这种"网页当接口响应"的返回。两个路径只差几个字母，不要互相替代。
 */
export interface Fa371VersionInfoDto {
  /** 固件版本，形如 `V0.5.1.6_251219`。 */
  device_version?: string
  /** SDK 版本，形如 `v8.1.0`。 */
  sdk_version?: string
  ret?: number
  msg?: string
  [key: string]: unknown
}

/**
 * `GET /basic` 响应 —— 设备基础信息（同为手册未收录、实测存在的只读接口）。
 *
 * 真机实测：
 *   `GET /basic` → `{"basic_server_version":"TM.PD3...","dev_mac":"70:19:88:a3:29:9e",
 *                    "dev_name":"FE128-ROBOT-PLUS001","dev_type":"FE128-ROBOT-PLUS",
 *                    "dev_version":"TM.PD3...","push_enable":0,"push_url":"",
 *                    "upgrade_time":"2026-09-14_06:56:47","web_version":"WEBV10.2.5",
 *                    "msg":"SUCCESS","ret":200}`
 *
 * `upgrade_time` 的格式（`YYYY-MM-DD_HH:MM:SS`）与时区手册都没说明，因此只按
 * **原样字符串**交给上层，不做日期解析。
 */
export interface Fa371BasicInfoDto {
  basic_server_version?: string
  dev_mac?: string
  dev_name?: string
  dev_type?: string
  dev_version?: string
  push_enable?: number | string
  push_url?: string
  /** 上次升级时刻，设备原样的字符串。 */
  upgrade_time?: string
  web_version?: string
  ret?: number
  msg?: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// 升级三件套（`POST /upload` / `PUT /reboot` / `GET /progress`）
// —— 手册未收录，是设备自带 Web 界面在用的接口
// ---------------------------------------------------------------------------

/**
 * `GET /progress` 响应 —— 设备自报的升级进度。
 *
 * **⚠ 未文档化**：路径不在任何一份手册里，是从设备自带前端的 bundle 里读出来的
 * （`Dn = e => Qt('/progress', e)`，而 `Qt` 是 GET 封装）。真机只读实测
 * （`192.168.110.235`，`V0.5.1.6_251219`，2026-09-15 与本次复核各一次）：
 *
 *   `GET /progress` → `200 {"msg":"SUCCESS","ret":200,"upgrade_progress":-2.0}`
 *
 * `upgrade_progress` 是**浮点数**，`-2` 的含义没有任何文档说明（设备自带界面只在
 * 「设备正在升级」时才显示进度）。所以本 DTO 只声明字段名，**不声明量纲**：
 * 映射与显示都把它当"设备原样给的一个数"，不换算成百分比
 * （见 `@shared/domain/camera-upgrade` 的 `CameraUpgradeProgress`）。
 */
export interface Fa371UpgradeProgressDto {
  /** 设备自报的进度数值。量纲未定义，原样交给上层。 */
  upgrade_progress?: number
  ret?: number
  msg?: string
  [key: string]: unknown
}
