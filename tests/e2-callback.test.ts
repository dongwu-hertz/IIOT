/**
 * SN-16 `realtime_value` 回调链（2026-09-21，真机未接入，只有文档）。
 *
 * 文档给出的字段名有两处写法（`max_tdr_value` / `max_tddr_value`），所以这里的测试
 * 把"两种都收"钉死；另外也钉住"回调不进趋势表"与"设备侧写回必须读回核对"两条口径。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { hasE2RealtimeValues, parseE2CallbackPayload, pickE2CallbackAddress } from '../src/shared/domain/e2-callback'
import { zhCN } from '../src/shared/i18n/messages/zh-CN'
import { en } from '../src/shared/i18n/messages/en'
import { es } from '../src/shared/i18n/messages/es'
import { tr } from '../src/shared/i18n/messages/tr'

const projectRoot = path.resolve(__dirname, '..', '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

describe('E2 callback payload parser', () => {
  it('recognises realtime_value with numbers and numeric strings', () => {
    const parsed = parseE2CallbackPayload({
      message_type: 'realtime_value',
      max_db_chn: '13',
      max_db_value: '68.6',
      max_fdr_value: 41.94,
      max_tdr_value: '0.00043'
    })
    assert.equal(parsed.kind, 'realtimeValue')
    if (parsed.kind !== 'realtimeValue') return
    assert.deepEqual(parsed.value, {
      maxDbChannel: 13,
      maxDbValue: 68.6,
      maxFdrValue: 41.94,
      maxTdrValue: 0.00043
    })
    assert.equal(hasE2RealtimeValues(parsed.value), true)
  })

  it('accepts the max_tddr_value spelling from our own code comments', () => {
    const parsed = parseE2CallbackPayload({ max_tddr_value: 0.001 })
    assert.equal(parsed.kind, 'realtimeValue')
    if (parsed.kind !== 'realtimeValue') return
    assert.equal(parsed.value.maxTdrValue, 0.001)
  })

  it('accepts a payload without message_type when max_* keys are present', () => {
    const parsed = parseE2CallbackPayload({ max_db_value: 61.2 })
    assert.equal(parsed.kind, 'realtimeValue')
    if (parsed.kind !== 'realtimeValue') return
    assert.equal(parsed.value.maxDbValue, 61.2)
  })

  it('drops invalid values instead of writing NaN/0', () => {
    const parsed = parseE2CallbackPayload({
      message_type: 'realtime_value',
      max_db_chn: 0,
      max_db_value: 'abc',
      max_fdr_value: null,
      max_tdr_value: 0.5
    })
    assert.equal(parsed.kind, 'realtimeValue')
    if (parsed.kind !== 'realtimeValue') return
    assert.deepEqual(parsed.value, { maxTdrValue: 0.5 })
  })

  it('classifies the other documented callback types without inventing realtime values', () => {
    assert.equal(parseE2CallbackPayload({ message_type: 'heart_beat_message' }).kind, 'heartbeat')
    assert.equal(parseE2CallbackPayload({ message_type: 'alarm_msg' }).kind, 'alarm')
    assert.equal(parseE2CallbackPayload({ message_type: 'wav_save_report' }).kind, 'filesSaved')
    assert.equal(parseE2CallbackPayload({ message_type: 'new_firmware' }).kind, 'unknown')
    assert.equal(parseE2CallbackPayload('not-json-object').kind, 'invalid')
    assert.equal(parseE2CallbackPayload([{ message_type: 'realtime_value' }]).kind, 'invalid')
  })

  it('rejects realtime_value with no usable field', () => {
    assert.equal(parseE2CallbackPayload({ message_type: 'realtime_value' }).kind, 'invalid')
  })
})

describe('E2 callback address selection', () => {
  it('prefers a local address on the device /24, then non-loopback, then loopback', () => {
    const addresses = [
      { address: '10.8.0.5' },
      { address: '192.168.1.20' },
      { address: '127.0.0.1' }
    ]
    assert.equal(pickE2CallbackAddress('192.168.1.234', addresses), '192.168.1.20')
    assert.equal(pickE2CallbackAddress('172.16.0.2', addresses), '10.8.0.5')
    assert.equal(pickE2CallbackAddress(undefined, addresses), '10.8.0.5')
    assert.equal(pickE2CallbackAddress('192.168.1.5', []), '127.0.0.1')
  })
})

describe('E2 callback wiring guards (source)', () => {
  const service = read('src/main/services/device/e2/e2-device-service.ts')
  const ingest = read('src/main/services/ingest/iot-ingest-service.ts')
  const panel = read('src/renderer/src/components/AuscultationPanel.vue')
  const contract = read('src/shared/ipc/contract.ts')
  const preload = read('src/preload/index.ts')
  const feed = read('src/renderer/src/composables/useRealtimeMonitorFeed.ts')

  it('the E2 service writes notify_url + is_send_realtime_value and reads back', () => {
    assert.match(service, /async setRealtimeCallback\(/, '没有 setRealtimeCallback')
    assert.match(service, /merged\.notify_url = callbackUrl/, '没有写 notify_url')
    assert.match(service, /is_send_realtime_value: enabled \? 1 : 0/, '没有写 is_send_realtime_value')
    assert.match(service, /const after = await client\.getSystem\(\)/, '没有 PUT /system 之后读回')
    assert.match(service, /field: 'notifyUrl' as const, ok:/, '没有 notify_url 读回核对')
    assert.match(service, /field: 'isSendRealtimeValue' as const, ok:/, '没有 is_send_realtime_value 读回核对')
    // 开启时让设备声明 HTTP 接入：监听由既有对账逻辑打开，不再开第二个端口。
    assert.match(service, /plan\.protocol = 'http'/, '没有声明 HTTP 接入')
    assert.match(service, /this\.devices\.ingestEndpoint\(deviceId\)/, '没有复用本机接入端点')
  })

  it('the shared ingest endpoint routes realtime_value away from the trend table', () => {
    assert.match(ingest, /findE2RealtimeRow\(rows\)/, '没有识别 E2 实时行')
    assert.match(ingest, /parseE2CallbackPayload\(row\.values\)/, '没有复用共享解析器')
    assert.match(ingest, /this\.emit\('e2-realtime', event\)/, '没有把实时值推给订阅者')
    assert.match(ingest, /e2Realtime: outcome\.e2Realtime/, 'HTTP 响应没有区分 E2 回调')
  })

  it('IPC and preload expose the status/write calls plus the push subscription', () => {
    for (const channel of ['E2_REALTIME_CALLBACK', 'E2_REALTIME_CALLBACK_UPDATE', 'E2_REALTIME_CALLBACK_VALUE']) {
      assert.ok(contract.includes(channel), `contract 缺 ${channel}`)
    }
    assert.match(contract, /onE2RealtimeValue: EventSubscription<E2RealtimeValueEvent>/, '事件表缺 onE2RealtimeValue')
    assert.match(preload, /realtimeCallback: \(deviceId: string\)/, 'preload 缺 realtimeCallback')
    assert.match(preload, /setRealtimeCallback: \(deviceId: string, enabled: boolean\)/, 'preload 缺 setRealtimeCallback')
    assert.match(preload, /onE2RealtimeValue/, 'preload 缺推送订阅')
  })

  it('the GIS feed consumes the pushed realtime value for the Air Sonar frame', () => {
    assert.match(feed, /useE2RealtimeStore/, 'feed 没有订阅 E2 实时值 store')
    assert.match(feed, /e2RealtimeAt/, 'feed 没有把实时值时间戳交给适配层')
    assert.match(feed, /e2Realtime: e2RealtimeEvent\.value\.value/, 'feed 没有把实时值交给 buildRealtimeFrame')
  })

  it('the device panel shows status + last value and gates the write on admin', () => {
    assert.match(panel, /data-e2-callback-card/, '面板没有回调卡片')
    assert.match(panel, /data-e2-callback-listener/, '没有监听状态钩子')
    assert.match(panel, /data-e2-realtime-value/, '没有最近实时值钩子')
    assert.match(panel, /canConfigureCallback/, '没有管理员判据')
    assert.match(panel, /window\.api\.e2\.setRealtimeCallback/, '没有写设备的调用')
  })

  it('all new copy exists in all four catalogues', () => {
    const keys = [
      'title',
      'hint',
      'start',
      'stop',
      'deviceUrl',
      'flag',
      'listener',
      'listening',
      'stopped',
      'pointsToUs',
      'pointsElsewhere',
      'notConfigured',
      'adminOnly',
      'partialReadback',
      'receivedAt',
      'maxDbValue',
      'maxChannel',
      'tde',
      'fde',
      'noValue'
    ]
    for (const catalogue of [zhCN, en, es, tr]) {
      const block = (catalogue as { e2CallbackUi: Record<string, string> }).e2CallbackUi
      for (const key of keys) {
        assert.ok(block[key] && block[key].trim() !== '', `缺 e2CallbackUi.${key}`)
        assert.equal(block[key].includes('@'), false, `e2CallbackUi.${key} 含裸 @`)
      }
    }
    assert.deepEqual(
      ((en as unknown as { e2CallbackUi: Record<string, string> }).e2CallbackUi.listening!.match(/\{(\w+)\}/g) ?? []).sort(),
      ((zhCN as unknown as { e2CallbackUi: Record<string, string> }).e2CallbackUi.listening!.match(/\{(\w+)\}/g) ?? []).sort()
    )
  })
})