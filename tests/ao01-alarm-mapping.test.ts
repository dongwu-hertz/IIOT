/**
 * AO01 告警/音频行映射 —— 用 2026-11-12 真机抓到的逐字段形状固定下来。
 *
 * 真机 `PUT /get_alarm_audio` 返回 `alertArray`：
 *   { dalId, dalChId, dalChName, dalChSenType, dalAbnoType, dalStartTime, dalDuration }
 * `dalAbnoType` 是 0 正常 / 1 异常，**不是** AE08 的 14 位 alarm mask。
 *
 * 告警行没有文件名；`GET /audio?alert_id=<dalId>` 返回 `audioArray[0]`：
 *   { dauFileName, dauFilePath: "/mic/2026_11_06/", dauAudionLeng, dauSmp, ... }
 * 下载 URL 是 `/download_audio/mic/2026_11_06/<name>.wav`。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  extractAlarmAudio,
  mapAlarmRecording,
  mapAlertAudioFile,
  toAlarmRecordingRow
} from '../src/main/services/device/protocol/mappers'

const ALERT_ROW = {
  dalAbnoType: 1,
  dalChId: 0,
  dalChName: 'ch1',
  dalChSenType: 0,
  dalDuration: 9,
  dalId: 43,
  dalStartTime: 1793918532
}

const AUDIO_PAYLOAD = {
  audioArray: [
    {
      dauAudionLeng: 10,
      dauChId: 0,
      dauChName: 'ch1',
      dauChSenType: 0,
      dauDataSour: 0,
      dauFileName: '0_0_20261106_064212.wav',
      dauFilePath: '/mic/2026_11_06/',
      dauId: 20371,
      dauSmp: 48000,
      dauStatus: 1
    }
  ],
  audioSize: 1
}

describe('AO01 告警与音频行映射（真机形状）', () => {
  it('从 alertArray 取出告警行', () => {
    const rows = extractAlarmAudio({ alertArray: [ALERT_ROW], alertSize: 1, allSize: 43 })
    assert.equal(rows.length, 1)
    assert.equal((rows[0] as Record<string, unknown>).dalId, 43)
  })

  it('dalStartTime 按秒转毫秒，dalDuration 按秒转毫秒，且不把 0/1 当 alarm mask', () => {
    const mapped = mapAlarmRecording(ALERT_ROW)
    assert.ok(mapped)
    assert.equal(mapped.remoteId, 43)
    assert.equal(mapped.channelIndex, 0)
    assert.equal(mapped.channelName, 'ch1')
    assert.equal(mapped.alarmTime, 1793918532 * 1000)
    assert.equal(mapped.durationMs, 9000)
    assert.equal(mapped.sampleRate, 48000)
    // dalAbnoType=1 是「异常」标志；解成 SPL(bit0) 会显示错误的告警类型。
    assert.equal(mapped.alarmMask, 0)
  })

  it('从 /audio?alert_id 取到可下载的相对路径', () => {
    const file = mapAlertAudioFile(AUDIO_PAYLOAD)
    assert.equal(file.fileName, 'mic/2026_11_06/0_0_20261106_064212.wav')
    assert.equal(file.durationMs, 10000)
    assert.equal(file.sampleRate, 48000)
  })

  it('recordings 行保留告警 id，并把相对路径放进 eventType 供下载使用', () => {
    const mapped = mapAlarmRecording(ALERT_ROW)
    assert.ok(mapped)
    Object.assign(mapped, mapAlertAudioFile(AUDIO_PAYLOAD))
    const row = toAlarmRecordingRow('dev_ao01', mapped!, 1_800_000_000_000)
    assert.equal(row.recordingType, 'alarm')
    assert.equal(row.remoteRecordingId, '43')
    assert.equal(row.startTime, 1793918532 * 1000)
    assert.equal(row.eventType, 'mic/2026_11_06/0_0_20261106_064212.wav')
    assert.equal(row.durationMs, 10000)
    assert.equal(row.sampleRate, 48000)
  })
})