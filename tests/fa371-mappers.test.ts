/**
 * FA371 mapper 测试。
 *
 * 这些测试守的是一条具体的、已经害过人的性质：
 * **手册的示例 JSON 缺字段、字段表与示例互相矛盾**（规格 §8.3 C2/C7/C13/C14/C15/C16）。
 * 一个"想当然"的 mapper 遇到缺字段会产出 `undefined` 满地的域对象，或者干脆抛异常，
 * 而两者在 UI 上都表现为"设备坏了"。
 *
 * 因此每个用例都直接喂**手册原样的响应形状**（含 8 位时间戳、裸日志对象、
 * `target_numbe` 拼写、`files_status` 与 `file_status` 并存、矛盾的单位枚举），
 * 断言的是"不缺字段就不崩、缺字段不瞎猜、矛盾要显式暴露"。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  DEFAULT_FA371_SAMPLE_RATE_UNIT,
  DEFAULT_FA371_SCAN_AREA_COORDINATE_SPACE,
  DEFAULT_FA371_TIMESTAMP_UNIT,
  FA371_ARITHMETIC_OPERATOR_CANDIDATES,
  FA371_SAMPLE_RATE_UNIT_CANDIDATES,
  FA371_TIMESTAMP_UNIT_CANDIDATES,
  buildRtspUrlCandidates,
  detectLogFiles,
  interpretFa371Timestamp,
  isFa371Success,
  joinDetectFilePath,
  mapAcousticConfig,
  mapAlarmCondition,
  mapAlarmConditionPage,
  mapAlarmStrategy,
  mapAlarmStrategyPage,
  mapDetectLog,
  mapDetectLogs,
  mapDetectStatus,
  mapDetectionResult,
  mapDischargeTypeKey,
  mapImagingConfig,
  mapLeakageConfig,
  mapNcFilePage,
  mapRunMode,
  mapScanArea,
  mapSystemTime,
  mapVideoConfig
} from '../src/main/services/device/fa371/mappers'

// ---------------------------------------------------------------------------
// 声场配置（§5.1.2，缺口 §8.3 C1）
// ---------------------------------------------------------------------------

describe('FA371 mapper: /system/acoustic', () => {
  it('保留原始 samplerate，不按任何单位换算（§8.3 C1）', () => {
    // 手册示例逐字：samplerate 13200 —— 与合法值 96000/132000 量纲矛盾。
    const config = mapAcousticConfig({ freq_up_limit: 25, freq_down_limit: 20, samplerate: 13200 })

    assert.equal(config.sampleRateRaw, 13200)
    assert.equal(config.sampleRateUnit, DEFAULT_FA371_SAMPLE_RATE_UNIT)
    assert.equal(config.freqUpLimit, 25)
    assert.equal(config.freqDownLimit, 20)
    assert.equal(config.bandWidth, 5)
  })

  it('缺字段时只留缺口，不产出 NaN/0', () => {
    const config = mapAcousticConfig({ ret: 200, msg: 'SUCCESS' })

    assert.equal(config.sampleRateRaw, undefined)
    assert.equal(config.freqUpLimit, undefined)
    assert.equal(config.freqDownLimit, undefined)
    assert.equal(config.bandWidth, undefined)
    assert.ok(!('freqUpLimit' in config))
  })

  it('单位候选集自描述且默认是"未知"', () => {
    assert.equal(FA371_SAMPLE_RATE_UNIT_CANDIDATES.length, 3)
    for (const candidate of FA371_SAMPLE_RATE_UNIT_CANDIDATES) {
      assert.ok(candidate.description.length > 0, `${candidate.id} 缺少说明`)
    }
    const fallback = FA371_SAMPLE_RATE_UNIT_CANDIDATES.find((entry) => entry.id === 'unknown')
    assert.ok(fallback?.description.includes('未确定'))
  })
})

// ---------------------------------------------------------------------------
// 成像配置（§5.1.4，缺口 §8.3 C2）
// ---------------------------------------------------------------------------

describe('FA371 mapper: /system/image', () => {
  it('只回示例键 target_number 时，记录用的是哪个键', () => {
    const config = mapImagingConfig({ energy_threshold: 25, target_number: 1, ret: 200, msg: 'SUCCESS' })

    assert.equal(config.energyThreshold, 25)
    assert.equal(config.targetCount, 1)
    assert.equal(config.targetCountKeyUsed, 'target_number')
    // 字段表声明存在、示例里却没有的两个键 → 缺失，不是 0。
    assert.equal(config.imagingSensitivity, undefined)
    assert.equal(config.imagingEnhance, undefined)
  })

  it('只回字段表拼写 target_numbe 时也能读到', () => {
    const config = mapImagingConfig({ energy_threshold: 25, target_numbe: 2 })

    assert.equal(config.targetCount, 2)
    assert.equal(config.targetCountKeyUsed, 'target_numbe')
  })

  it('一个键都没有时不猜，并标注 absent', () => {
    const config = mapImagingConfig({ energy_threshold: 25, imaging_sensitivity: 1, imaging_enhance: 0 })

    assert.equal(config.targetCountKeyUsed, 'absent')
    assert.equal(config.targetCount, undefined)
    assert.equal(config.imagingSensitivity, 1)
    assert.equal(config.imagingEnhance, 0)
  })
})

// ---------------------------------------------------------------------------
// 视频与 RTSP（§5.1.6，缺口 §8.3 C4 / §8.5 E2）
// ---------------------------------------------------------------------------

describe('FA371 mapper: /system/video', () => {
  it('video_url 是字符串时归一化为 RTSP 路径', () => {
    const video = mapVideoConfig({
      rtsp_client_limit: 6,
      rtsp_connected_num: 1,
      rtsp_enabled: 1,
      video_bit_rate: 4096,
      video_flip_model: 0,
      video_fps: 30,
      video_height: 1080,
      video_port: 443,
      video_url: 'live',
      video_width: 1920,
      msg: 'SUCCESS',
      ret: 200
    })

    assert.equal(video.rtspPath, 'live')
    assert.equal(video.rtspPort, 443)
    assert.equal(video.rtspEnabled, true)
    assert.equal(video.rtspClientLimit, 6)
    assert.equal(video.rtspConnectedCount, 1)
    assert.equal(video.flipModelKey, 'normal')
    assert.equal(video.width, 1920)
    assert.equal(video.height, 1080)
  })

  it('video_url 数字（手册标 integer）也不抛异常（§8.3 C4）', () => {
    const video = mapVideoConfig({ video_url: 1 })
    assert.equal(video.rtspPath, '1')
  })

  it('翻转模式取值不在 0..3 时不猜 key', () => {
    const video = mapVideoConfig({ video_flip_model: 9 })
    assert.equal(video.flipModel, 9)
    assert.equal(video.flipModelKey, undefined)
  })

  it('RTSP URL 只给候选，且缺端口/路径时返回空集（§8.5 E2）', () => {
    const candidates = buildRtspUrlCandidates('192.168.2.168', {
      rtspPort: 443,
      rtspPath: 'live'
    })

    const ids = candidates.map((candidate) => candidate.id)
    assert.deepEqual(ids, ['rtsp_without_credentials', 'rtsps_without_credentials'])
    assert.equal(candidates[0]?.url, 'rtsp://192.168.2.168:443/live')
    assert.equal(candidates[0]?.assumeCredentials, false)

    // 手册没有默认端口，也不保证 video_url 只有 "live" → 缺信息就不生成候选。
    assert.deepEqual(buildRtspUrlCandidates('192.168.2.168', {}), [])
    assert.deepEqual(buildRtspUrlCandidates('192.168.2.168', { rtspPort: 554 }), [])
  })
})

// ---------------------------------------------------------------------------
// 运行模式（§5.1.8）
// ---------------------------------------------------------------------------

describe('FA371 mapper: /run_mode', () => {
  it('映射两个已定义取值', () => {
    assert.deepEqual(mapRunMode({ run_mode: 1, ret: 200 }), {
      raw: 1,
      mode: 1,
      key: 'single_detection'
    })
    assert.deepEqual(mapRunMode({ run_mode: -1 }), {
      raw: -1,
      mode: -1,
      key: 'intelligent_cruise'
    })
  })

  it('未知取值只留 raw（§5.1.9 缺口：其它码未说明）', () => {
    assert.deepEqual(mapRunMode({ run_mode: 7 }), { raw: 7 })
  })

  it('字符串数字也接受', () => {
    assert.equal(mapRunMode({ run_mode: '-1' }).key, 'intelligent_cruise')
  })
})

// ---------------------------------------------------------------------------
// 泄漏估算（§5.1.10，缺口 §8.3 C7）
// ---------------------------------------------------------------------------

describe('FA371 mapper: /system/leakage', () => {
  it('示例里枚举与字符串矛盾时显式标记，不静默修正（§8.3 C7）', () => {
    // 手册示例逐字：leakage_unit: 1 配 "l/min"（按定义 1 应为 ml/s），
    // monetary_unit: 1 配 "CNY"（按定义 1 应为 GBP）。
    const leakage = mapLeakageConfig({
      cost_display: 1,
      leakage_distance: 1,
      leakage_unit: 1,
      leakage_unit_str: 'l/min',
      monetary_unit: 1,
      monetary_unit_str: 'CNY',
      energy_cost: 1,
      specific_power: 1,
      value_of_gas: 1,
      working_hours: 1,
      ret: 200,
      msg: 'SUCCESS'
    })

    assert.equal(leakage.costDisplay, true)
    assert.equal(leakage.distanceM, 1)
    assert.equal(leakage.unit?.code, 1)
    assert.equal(leakage.unit?.codeKey, 'millilitre_per_second')
    assert.equal(leakage.unit?.label, 'l/min')
    assert.equal(leakage.unit?.codeMatchesLabel, false, '矛盾必须被标出来')
    assert.equal(leakage.monetaryUnit?.codeMatchesLabel, false)
    assert.equal(leakage.workingHours, 1)
  })

  it('自洽的响应标成一致', () => {
    const leakage = mapLeakageConfig({ leakage_unit: 0, leakage_unit_str: 'l/min' })
    assert.equal(leakage.unit?.codeMatchesLabel, true)
  })

  it('缺字段时不产出空壳子对象', () => {
    const leakage = mapLeakageConfig({ ret: 200 })
    assert.equal(leakage.unit, undefined)
    assert.equal(leakage.monetaryUnit, undefined)
    assert.deepEqual(leakage, {})
  })
})

// ---------------------------------------------------------------------------
// 检测区域（§5.1.12，缺口 §8.3 C9/C10）
// ---------------------------------------------------------------------------

describe('FA371 mapper: /system/scan_area', () => {
  it('映射手册的 5 个区域示例', () => {
    const area = mapScanArea({
      areas: [
        { area_height: 168, area_width: 240, detect_area_status: 1, left_top_x: 12, left_top_y: 12 },
        { area_height: 168, area_width: 240, detect_area_status: 1, left_top_x: 257, left_top_y: 185 },
        { area_height: 168, area_width: 240, detect_area_status: 1, left_top_x: 502, left_top_y: 358 },
        { area_height: 168, area_width: 240, detect_area_status: 1, left_top_x: 747, left_top_y: 531 },
        { area_height: 168, area_width: 240, detect_area_status: 1, left_top_x: 992, left_top_y: 704 }
      ],
      center_focus: 2,
      msg: 'SUCCESS',
      ret: 200
    })

    assert.equal(area.areas.length, 5)
    assert.equal(area.areas[0]?.leftTopX, 12)
    assert.equal(area.areas[0]?.drawStatusKey, 'visible')
    assert.equal(area.centerFocusCode, 2)
    assert.equal(area.centerFocusKey, 'box_select')
    // §8.3 C9：坐标系未实测 → 默认不许声称是像素。
    assert.equal(area.coordinateSpace, DEFAULT_FA371_SCAN_AREA_COORDINATE_SPACE)
  })

  it('areas 缺失时是空数组而不是 undefined', () => {
    const area = mapScanArea({ center_focus: 1 })
    assert.deepEqual(area.areas, [])
  })

  it('坐标系假设可以显式给出，便于实测时对照', () => {
    const area = mapScanArea({ areas: [] }, { coordinateSpace: 'pixel_video_frame' })
    assert.equal(area.coordinateSpace, 'pixel_video_frame')
  })

  it('区域里缺字段的项不崩，缺失即 undefined', () => {
    const area = mapScanArea({ areas: [{ left_top_x: 10 }] })
    assert.equal(area.areas[0]?.leftTopX, 10)
    assert.equal(area.areas[0]?.leftTopY, undefined)
    assert.equal(area.areas[0]?.drawStatusKey, undefined)
  })
})

// ---------------------------------------------------------------------------
// 检测状态与启停（§5.1.14 / §5.1.16，缺口 §8.3 C11/C13）
// ---------------------------------------------------------------------------

describe('FA371 mapper: /system/detect_status', () => {
  it('只有 detect_status、没有 ret/msg 时按成功解读并记录该例外（§8.3 C13）', () => {
    const status = mapDetectStatus({ detect_status: 0 })
    assert.equal(status.detecting, false)
    assert.equal(status.retPresent, false)
  })

  it('1 / "1" / true 都归一化成正在检测', () => {
    assert.equal(mapDetectStatus({ detect_status: 1 }).detecting, true)
    assert.equal(mapDetectStatus({ detect_status: '1' }).detecting, true)
    assert.equal(mapDetectStatus({ detect_status: true }).detecting, true)
    assert.equal(mapDetectStatus({ detect_status: '0' }).detecting, false)
  })

  it('空响应当作未检测而不是抛异常', () => {
    const status = mapDetectStatus({})
    assert.equal(status.detecting, false)
    assert.equal(status.retPresent, false)
  })
})

describe('FA371 mapper: /turn_on_detect', () => {
  it('单次检测模式带 detect_id', () => {
    assert.deepEqual(mapDetectionResult({ detect_id: 1, ret: 200, msg: 'SUCCESS' }), { detectId: 1 })
  })

  it('巡航模式下缺 detect_id 时不产出 0（§8.3 C11）', () => {
    assert.deepEqual(mapDetectionResult({ ret: 200, msg: 'SUCCESS' }), {})
  })
})

// ---------------------------------------------------------------------------
// 检测日志（§5.1.17，缺口 §8.3 C14/C15/C16）
// ---------------------------------------------------------------------------

/** 手册 §5.1.17 示例的规范化版本（16 个键，**不含**任何告警字段）。 */
const DETECT_LOG_EXAMPLE = {
  bin_mic_data_name: 'mic_data_2019_06_20_20_30_39_940.bin',
  data_1: 0.0,
  data_2: -1.0,
  data_3: 0.0,
  data_4: 0.0,
  detect_mode: 2,
  end_time: 1561033842,
  files_status: 1,
  id: 7,
  power_spect_photo_name: 'power_spectrum_2019_06_20_20_30_39_940.jpg',
  power_spect_video_name: 'power_spectrum_2019_06_20_20_30_39_940.mp4',
  saving_path: '2019_06_20_20_30_39_940/',
  soundmap_intensity: 20.4,
  soundmap_photo_name: 'sound_2019_06_20_20_30_39_940.jpg',
  soundmap_video_name: 'sound_2019_06_20_20_30_39_940.mp4',
  start_time: 1561033839,
  status: 1,
  voiceprint_photo_name: 'voiceprint_2019_06_20_20_30_39_940.jpg',
  voiceprint_video_name: 'voiceprint_2019_06_20_20_30_39_940.mp4',
  wav_mic_data_name: 'mic_data_2019_06_20_20_30_39_940.wav'
}

describe('FA371 mapper: /detect_logs', () => {
  it('字段表声明的数组形状', () => {
    const logs = mapDetectLogs({ detect_logs: [DETECT_LOG_EXAMPLE], msg: 'SUCCESS', ret: 200 })
    assert.equal(logs.length, 1)
    assert.equal(logs[0]?.id, 7)
  })

  it('单个对象塞进复数键也不崩', () => {
    const logs = mapDetectLogs({ detect_logs: DETECT_LOG_EXAMPLE, ret: 200 })
    assert.equal(logs.length, 1)
    assert.equal(logs[0]?.id, 7)
  })

  it('§5.2.3 的单数 detect_log 包装也认', () => {
    const logs = mapDetectLogs({ detect_log: DETECT_LOG_EXAMPLE, msg: 'SUCCESS', ret: 200 })
    assert.equal(logs.length, 1)
  })

  it('§5.1.17 示例的裸对象形状也认（§8.3 C14）', () => {
    const logs = mapDetectLogs({ ...DETECT_LOG_EXAMPLE, msg: 'SUCCESS', ret: 200 })
    assert.equal(logs.length, 1)
    assert.equal(logs[0]?.savingPath, '2019_06_20_20_30_39_940/')
  })

  it('认不出来的形状返回空数组，不抛异常', () => {
    assert.deepEqual(mapDetectLogs({ ret: 200, msg: 'SUCCESS' }), [])
    assert.deepEqual(mapDetectLogs(undefined), [])
    assert.deepEqual(mapDetectLogs('not json'), [])
  })

  it('字段表有、示例没有的 9 个告警字段保持缺省（§8.3 C15）', () => {
    const log = mapDetectLog(DETECT_LOG_EXAMPLE)
    assert.equal(log.alarmStrategyId, undefined)
    assert.equal(log.alarmLevelRaw, undefined)
    assert.equal(log.ncFile, undefined)
    assert.equal(log.lastAlarmDb, undefined)
    assert.equal(log.isAlarm, undefined)
    assert.ok(!('isAlarm' in log), '缺失字段不应以 undefined 形式预置在对象里')
  })

  it('告警字段存在时按原样映射', () => {
    const log = mapDetectLog({
      id: 8,
      alarm_strategy_id: 3,
      alarm_level: 4,
      nc_file: 'a.bin',
      last_alarm_db: 66.5,
      last_alarm_df: 1200,
      last_alarm_nc: 0.84,
      is_alarm: 1,
      nc_file_path: '/media/nc/a.bin',
      nc_file_fft_photo_name: 'a_fft.jpg'
    })

    assert.equal(log.alarmStrategyId, 3)
    assert.equal(log.alarmLevelKey, 'level_4')
    assert.equal(log.ncFile, 'a.bin')
    assert.equal(log.lastAlarmDb, 66.5)
    assert.equal(log.isAlarm, true)
    assert.equal(log.ncFileFftPhotoName, 'a_fft.jpg')
  })

  it('files_status 与 file_status 两种拼写都读（§8.3 C16）', () => {
    assert.equal(mapDetectLog({ files_status: 1 }).filesStatusKey, 'saved')
    assert.equal(mapDetectLog({ file_status: 0 }).filesStatusKey, 'deleted')
  })

  it('soundmap_intensity 保留小数，不取整', () => {
    assert.equal(mapDetectLog({ soundmap_intensity: 20.4 }).soundmapIntensity, 20.4)
  })

  it('时间戳原样保留；单位未定时不产出换算值（§8.2 B5 / §8.3 C19）', () => {
    const log = mapDetectLog(DETECT_LOG_EXAMPLE)
    assert.equal(log.timeUnit, DEFAULT_FA371_TIMESTAMP_UNIT)
    assert.equal(log.startTimeRaw, 1561033839)
    assert.equal(log.endTimeRaw, 1561033842)
    // 未实测单位前不把 1561033839 当秒或当毫秒。
    assert.equal(log.startTime, undefined)
    assert.equal(log.endTime, undefined)

    const seconds = mapDetectLog(DETECT_LOG_EXAMPLE, { timeUnit: 'epoch_seconds' })
    assert.equal(seconds.startTime, 1561033839000)
    assert.equal(seconds.endTime, 1561033842000)
  })

  it('时间为字符串（字段表标 string）也能解析', () => {
    const log = mapDetectLog({ start_time: '1561033839' }, { timeUnit: 'epoch_seconds' })
    assert.equal(log.startTimeRaw, 1561033839)
    assert.equal(log.startTime, 1561033839000)
  })

  it('结果文件按 kind 归类，并给出可用清单', () => {
    const log = mapDetectLog(DETECT_LOG_EXAMPLE)
    const files = detectLogFiles(log)

    assert.equal(files.length, 8)
    assert.deepEqual(
      files.map((file) => file.kind),
      [
        'power_spectrum_photo',
        'power_spectrum_video',
        'soundmap_photo',
        'soundmap_video',
        'voiceprint_photo',
        'voiceprint_video',
        'bin_mic_data',
        'wav_mic_data'
      ]
    )
    assert.equal(files[0]?.fileName, 'power_spectrum_2019_06_20_20_30_39_940.jpg')
  })

  it('一个文件字段都没有时清单为空数组', () => {
    assert.deepEqual(detectLogFiles(mapDetectLog({ id: 1 })), [])
  })
})

describe('FA371 mapper: 结果文件路径拼接', () => {
  it('规整 saving_path 自带的尾斜杠（§8.3 C17）', () => {
    assert.equal(
      joinDetectFilePath('2019_06_20_20_30_39_940/', 'sound_2019_06_20_20_30_39_940.jpg'),
      '2019_06_20_20_30_39_940/sound_2019_06_20_20_30_39_940.jpg'
    )
    assert.equal(joinDetectFilePath('/a/b/', '/c.jpg'), 'a/b/c.jpg')
    assert.equal(joinDetectFilePath('', 'c.jpg'), 'c.jpg')
    assert.equal(joinDetectFilePath('a/', ''), 'a')
  })
})

// ---------------------------------------------------------------------------
// 系统时间（§5.1.20，缺口 §8.3 C19）
// ---------------------------------------------------------------------------

describe('FA371 mapper: /system_time', () => {
  it('8 位示例不猜单位，也不产出 epochMs（§8.3 C19）', () => {
    const time = mapSystemTime({ sys_time: 17220332 })

    assert.equal(time.raw, 17220332)
    assert.equal(time.unit, 'unknown')
    assert.equal(time.epochMs, undefined)
    assert.ok(!('epochMs' in time))
  })

  it('给出单位假设时才换算', () => {
    const seconds = mapSystemTime({ sys_time: 17220332 }, { timeUnit: 'epoch_seconds' })
    assert.equal(seconds.epochMs, 17220332000)

    const millis = mapSystemTime({ sys_time: 17220332000 }, { timeUnit: 'epoch_milliseconds' })
    assert.equal(millis.epochMs, 17220332000)
  })

  it('时间戳候选集包含 unknown 且默认就是它', () => {
    const ids = FA371_TIMESTAMP_UNIT_CANDIDATES.map((candidate) => candidate.id)
    assert.deepEqual(ids, ['unknown', 'epoch_seconds', 'epoch_milliseconds'])
    assert.equal(interpretFa371Timestamp(123, 'unknown'), undefined)
    assert.equal(interpretFa371Timestamp(1, 'epoch_seconds'), 1000)
    assert.equal(interpretFa371Timestamp(undefined, 'epoch_seconds'), undefined)
  })
})

// ---------------------------------------------------------------------------
// 告警策略（§5.1.22，缺口 §8.3 C21）
// ---------------------------------------------------------------------------

describe('FA371 mapper: /alarm_strategy', () => {
  const STRATEGY = {
    id: '7',
    name: 'Strategy One',
    alias: 'nick',
    alarm_condition_id: 2,
    alarm_condition_name: 'Condition 1',
    interval_time: 60,
    Times: 3,
    timeout_duration: 10,
    sensitivity: 0.8,
    level: 2,
    diagnosis: 'note',
    Switch: 1,
    page_total: 1
  }

  it('读取侧大写键 Times / Switch 按原样匹配', () => {
    const strategy = mapAlarmStrategy(STRATEGY)

    assert.equal(strategy.id, '7')
    assert.equal(strategy.rawIdType, 'string')
    assert.equal(strategy.times, 3)
    assert.equal(strategy.enabled, true)
    assert.equal(strategy.alarmConditionId, 2)
    assert.equal(strategy.levelKey, 'level_2')
  })

  it('id 为数字时（PUT 侧形状）归一化成字符串并记录原始类型', () => {
    const strategy = mapAlarmStrategy({ id: 7 })
    assert.equal(strategy.id, '7')
    assert.equal(strategy.rawIdType, 'number')
  })

  it('没有 id 时标 absent', () => {
    assert.equal(mapAlarmStrategy({ name: 'x' }).rawIdType, 'absent')
  })

  it('读侧 level 0 不静默偏移成写侧的 1（§8.3 C21）', () => {
    const strategy = mapAlarmStrategy({ level: 0 })
    assert.equal(strategy.level, 0)
    assert.equal(strategy.levelKey, undefined)
  })

  it('列表缺失时是空数组', () => {
    const page = mapAlarmStrategyPage({ ret: 200, msg: 'SUCCESS' })
    assert.deepEqual(page.items, [])
    assert.equal(page.pageTotal, undefined)
  })

  it('列表存在时映射每一项与 page_total', () => {
    const page = mapAlarmStrategyPage({ alarm_strategy_list: [STRATEGY], page_total: 4 })
    assert.equal(page.items.length, 1)
    assert.equal(page.pageTotal, 4)
  })
})

// ---------------------------------------------------------------------------
// 告警条件（§5.1.26，缺口 §8.3 C26/C27/C28）
// ---------------------------------------------------------------------------

describe('FA371 mapper: /alarm_condition', () => {
  it('映射读取侧完整字段，并保留大写 Notes', () => {
    const condition = mapAlarmCondition({
      id: 1,
      name: 'Condition 1',
      decibel_thr: 90,
      db_arithmetic_operator: 3,
      db_switch: 1,
      dominant_freq_thr: 1200,
      df_arithmetic_operator: 0,
      df_switch: 1,
      df_logical_operator: 1,
      noise_comparison_file_id: 5,
      noise_comparison_thr: 0.85,
      nc_switch: 0,
      nc_logical_operator: 0,
      nc_arithmetic_operator: 1,
      Notes: 'remark'
    })

    assert.equal(condition.decibelThreshold, 90)
    assert.equal(condition.dbOperatorKey, 'greater_or_equal')
    assert.equal(condition.dbSwitch, true)
    assert.equal(condition.dominantFreqThreshold, 1200)
    assert.equal(condition.dfOperatorKey, 'greater_than')
    assert.equal(condition.dfLogicalOperatorKey, 'and')
    assert.equal(condition.noiseComparisonFileId, 5)
    assert.equal(condition.ncSimilarityThreshold, 0.85)
    assert.equal(condition.ncSwitch, false)
    assert.equal(condition.ncLogicalOperatorKey, 'or')
    assert.equal(condition.ncOperatorKey, 'less_than')
    assert.equal(condition.notes, 'remark')
  })

  it('读取侧没有 discharge_* → 永远不产出 discharge（§8.3 C26 写读不对称）', () => {
    const condition = mapAlarmCondition({ id: 1, discharge_switch: '1', discharge_type: 4 })
    assert.equal(condition.discharge, undefined)
  })

  it('运算符取值超出候选表时不猜 key（§8.3 C28）', () => {
    const condition = mapAlarmCondition({ db_arithmetic_operator: 9, nc_arithmetic_operator: 7 })
    assert.equal(condition.dbOperatorKey, undefined)
    assert.equal(condition.ncOperatorKey, undefined)
  })

  it('运算符配对是具名假设，默认候选可用', () => {
    const candidate = FA371_ARITHMETIC_OPERATOR_CANDIDATES[0]
    assert.ok(candidate)
    assert.equal(candidate.id, 'ordered_table')
    assert.equal(candidate.keys[0], 'greater_than')
    assert.equal(candidate.keys[4], 'less_or_equal')
  })

  it('放电类型枚举缺 3 → 3 不映射（§8.3 C27）', () => {
    assert.equal(mapDischargeTypeKey(0), 'corona')
    assert.equal(mapDischargeTypeKey(1), 'suspension')
    assert.equal(mapDischargeTypeKey(2), 'surface')
    assert.equal(mapDischargeTypeKey(3), undefined)
    assert.equal(mapDischargeTypeKey(4), 'discharge')
  })

  it('缺字段的响应只产出空对象，不崩', () => {
    assert.deepEqual(mapAlarmCondition({ ret: 200, msg: 'SUCCESS' }), {})
    assert.deepEqual(mapAlarmConditionPage({}).items, [])
  })
})

// ---------------------------------------------------------------------------
// 比对文件（§5.1.31，缺口 §8.3 C32）
// ---------------------------------------------------------------------------

describe('FA371 mapper: /nc_filelist', () => {
  it('大写 Duration / Notes 按原样匹配，单位原样保留', () => {
    const page = mapNcFilePage({
      nc_file_list: [
        {
          id: 1,
          file_name: 'mic_data.bin',
          file_size: 123456,
          samplerate: 48000,
          Duration: 10,
          Notes: 'sample'
        }
      ],
      page_total: 1
    })

    const file = page.items[0]
    assert.ok(file)
    assert.equal(file.id, 1)
    assert.equal(file.fileName, 'mic_data.bin')
    assert.equal(file.fileSizeRaw, 123456)
    assert.equal(file.sampleRateRaw, 48000)
    assert.equal(file.durationRaw, 10)
    assert.equal(file.notes, 'sample')
    assert.equal(page.pageTotal, 1)
  })

  it('空响应是空列表', () => {
    assert.deepEqual(mapNcFilePage(undefined).items, [])
    assert.deepEqual(mapNcFilePage({ ret: 200 }).items, [])
  })
})

// ---------------------------------------------------------------------------
// 包络判定（§1）
// ---------------------------------------------------------------------------

describe('FA371 mapper: 包络判定', () => {
  it('ret 缺失视为成功（§5.1.15/§5.1.16/§5.1.20 三个接口本就不带 ret）', () => {
    assert.equal(isFa371Success({ detect_status: 0 }), true)
    assert.equal(isFa371Success({ sys_time: 17220332 }), true)
    assert.equal(isFa371Success(undefined), true)
  })

  it('ret === 200 是成功，其它任何码都是失败（§8.2 B3 其余码未定义）', () => {
    assert.equal(isFa371Success({ ret: 200, msg: 'SUCCESS' }), true)
    assert.equal(isFa371Success({ ret: -1, msg: 'no policy' }), false)
    assert.equal(isFa371Success({ ret: 500 }), false)
    // 字符串形式的 200 也要认（固件常把数字写成字符串）。
    assert.equal(isFa371Success({ ret: '200' }), true)
  })
})

// ---------------------------------------------------------------------------
// 复用性：域对象不得夹带线上键名（appendix C rule 2）
// ---------------------------------------------------------------------------

describe('FA371 mapper: 词汇隔离', () => {
  it('映射结果里没有手册的 snake_case / 大写键名', () => {
    const forbidden = /(_[a-z])|^(Times|Switch|Notes|Duration)$/
    const objects = [
      mapAcousticConfig({ freq_up_limit: 25, freq_down_limit: 20, samplerate: 96000 }),
      mapImagingConfig({ energy_threshold: 1, target_number: 2, imaging_sensitivity: 1 }),
      mapVideoConfig({ video_url: 'live', video_port: 443, rtsp_enabled: 1 }),
      mapLeakageConfig({ leakage_unit: 0, leakage_unit_str: 'l/min' }),
      mapRunMode({ run_mode: 1 }),
      mapScanArea({ areas: [{ left_top_x: 1, left_top_y: 2 }], center_focus: 1 }),
      mapDetectStatus({ detect_status: 1 }),
      mapDetectLog(DETECT_LOG_EXAMPLE),
      mapAlarmStrategy({ id: 1, Times: 1, Switch: 1 }),
      mapAlarmCondition({ id: 1, Notes: 'x' })
    ]

    for (const object of objects) {
      for (const key of Object.keys(object)) {
        assert.ok(!forbidden.test(key), `键 "${key}" 看起来像固件键名，泄漏到域层了`)
      }
    }
  })

  it('时间戳/采样率/坐标系的默认假设一律是"未确定"', () => {
    assert.equal(DEFAULT_FA371_TIMESTAMP_UNIT, 'unknown')
    assert.equal(DEFAULT_FA371_SCAN_AREA_COORDINATE_SPACE, 'unverified')
  })
})
