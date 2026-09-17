/**
 * Tests for the DTO -> Domain mappers.
 *
 * Why this file matters more than it looks: the FA8 protocol documentation does
 * not define payload schemas for several endpoints (spec section 19). The
 * mappers therefore absorb whatever real firmware sends, and the failure mode
 * of a bad mapper is silent and dangerous — a missing SPL rendered as `0`
 * reads as "perfectly quiet" to an operator, when the truth is "unknown".
 *
 * These tests pin down the defensive behaviours that make that impossible.
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  extractArray,
  looksLikeHertzinnoDevice,
  mapAlarmMask,
  mapChannel,
  mapChannels,
  mapDetectionType,
  mapDeviceInfo,
  mapFeatureFrame,
  mapNetwork,
  mapSampleRate,
  normaliseMac,
  resolveDeviceUid,
  toDurationMs,
  toEpochMs
} from '../src/main/services/device/protocol/mappers'
import { SensorType } from '../src/shared/domain/models'

describe('toEpochMs', () => {
  it('treats a small number as seconds', () => {
    // 2026-02-26T14:05:33Z in seconds
    assert.equal(toEpochMs(1772114733), 1772114733000)
  })

  it('treats a large number as already milliseconds', () => {
    assert.equal(toEpochMs(1772114733000), 1772114733000)
  })

  it('parses numeric strings', () => {
    assert.equal(toEpochMs('1772114733'), 1772114733000)
  })

  it('parses ISO-ish strings, including a space separator', () => {
    const expected = Date.parse('2026-02-26T14:05:33')
    assert.equal(toEpochMs('2026-02-26 14:05:33'), expected)
    assert.equal(toEpochMs('2026-02-26T14:05:33'), expected)
  })

  it('rejects unusable input instead of returning NaN', () => {
    assert.equal(toEpochMs(undefined), undefined)
    assert.equal(toEpochMs(null), undefined)
    assert.equal(toEpochMs(''), undefined)
    assert.equal(toEpochMs(0), undefined)
    assert.equal(toEpochMs(-5), undefined)
    assert.equal(toEpochMs('not a date'), undefined)
  })
})

describe('toDurationMs', () => {
  it('treats a plausible clip length as seconds', () => {
    assert.equal(toDurationMs(30), 30_000)
    assert.equal(toDurationMs(600), 600_000)
  })

  it('treats a large value as milliseconds', () => {
    assert.equal(toDurationMs(30_000), 30_000)
  })

  it('rejects negatives and junk', () => {
    assert.equal(toDurationMs(-1), undefined)
    assert.equal(toDurationMs('abc'), undefined)
  })
})

describe('normaliseMac', () => {
  it('accepts colon, dash and bare hex forms', () => {
    const expected = 'aa:bb:cc:dd:ee:ff'
    assert.equal(normaliseMac('AA:BB:CC:DD:EE:FF'), expected)
    assert.equal(normaliseMac('aa-bb-cc-dd-ee-ff'), expected)
    assert.equal(normaliseMac('aabbccddeeff'), expected)
  })

  it('rejects strings that are not MACs', () => {
    assert.equal(normaliseMac('not-a-mac'), undefined)
    assert.equal(normaliseMac('aabbcc'), undefined)
    assert.equal(normaliseMac(undefined), undefined)
  })
})

describe('resolveDeviceUid', () => {
  it('prefers an explicit device id', () => {
    assert.equal(resolveDeviceUid({ device_id: 'FA8-000123' }), 'FA8-000123')
    assert.equal(resolveDeviceUid({ deviceId: 'FA8-000123' }), 'FA8-000123')
    assert.equal(resolveDeviceUid({ sn: 'SN-XYZ' }), 'SN-XYZ')
  })

  it('falls back to a namespaced MAC so it cannot collide with a serial', () => {
    assert.equal(resolveDeviceUid({ mac: 'AA:BB:CC:DD:EE:FF' }), 'mac:aa:bb:cc:dd:ee:ff')
  })

  it('accepts a numeric device id', () => {
    assert.equal(resolveDeviceUid({ device_id: 42 }), '42')
  })

  it('returns undefined when there is no identity — never falls back to IP', () => {
    // This is the guard that stops IP from becoming a device identity
    // (spec appendix C rule 5).
    assert.equal(resolveDeviceUid({ name: 'some box' }), undefined)
    assert.equal(resolveDeviceUid({}), undefined)
  })
})

describe('mapDeviceInfo', () => {
  it('maps a realistic payload', () => {
    const info = mapDeviceInfo({
      device_id: 'FA8-000123',
      name: 'Transformer A',
      mac: 'AA:BB:CC:DD:EE:FF',
      fpga_version: '1.2.3',
      device_version: '2.0.1',
      web_version: '1.0.9',
      channel_num: 8
    })
    assert.ok(info)
    assert.equal(info.deviceUid, 'FA8-000123')
    assert.equal(info.name, 'Transformer A')
    assert.equal(info.mac, 'aa:bb:cc:dd:ee:ff')
    assert.equal(info.fpgaVersion, '1.2.3')
    assert.equal(info.firmwareVersion, '2.0.1')
    assert.equal(info.webVersion, '1.0.9')
    assert.equal(info.channelCount, 8)
  })

  it('defaults channel count to 8 when the field is missing or nonsense', () => {
    assert.equal(mapDeviceInfo({ device_id: 'X' })?.channelCount, 8)
    assert.equal(mapDeviceInfo({ device_id: 'X', channel_num: 0 })?.channelCount, 8)
    assert.equal(mapDeviceInfo({ device_id: 'X', channel_num: 999 })?.channelCount, 8)
  })

  it('accepts channel_num as a string', () => {
    assert.equal(mapDeviceInfo({ device_id: 'X', channel_num: '8' })?.channelCount, 8)
  })

  it('returns undefined for a payload with no identity', () => {
    assert.equal(mapDeviceInfo({ name: 'anonymous' }), undefined)
  })

  it('synthesises a name when the device reports none', () => {
    assert.match(mapDeviceInfo({ device_id: 'FA8-9' })?.name ?? '', /FA8-9/)
  })
})

describe('looksLikeHertzinnoDevice', () => {
  it('accepts payloads with identity or firmware markers', () => {
    assert.equal(looksLikeHertzinnoDevice({ device_id: 'X' }), true)
    assert.equal(looksLikeHertzinnoDevice({ mac: 'aabbccddeeff' }), true)
    assert.equal(looksLikeHertzinnoDevice({ fpga_version: '1.0' }), true)
  })

  it('rejects unrelated HTTP servers, so LAN scanning does not list routers', () => {
    assert.equal(looksLikeHertzinnoDevice({ title: 'Welcome to nginx' }), false)
    assert.equal(looksLikeHertzinnoDevice('<html></html>'), false)
    assert.equal(looksLikeHertzinnoDevice(null), false)
  })
})

describe('mapNetwork', () => {
  it('preserves port 0 verbatim', () => {
    // Spec section 19: the meaning of 0 is unconfirmed. "Correcting" it here
    // would destroy the evidence needed to answer that question.
    const config = mapNetwork({ ip: '192.168.1.50', http_port: 0 })
    assert.equal(config.httpPort, 0)
  })

  it('reads ports reported under alternate names', () => {
    const config = mapNetwork({ httpPort: 8080, rtsp_port: 554, tcpPort: 9000 })
    assert.equal(config.httpPort, 8080)
    assert.equal(config.rtspPort, 554)
    assert.equal(config.tcpPort, 9000)
  })

  it('parses the legacy boolean dhcp flag into ipMode', () => {
    // Older firmware only exposed a boolean; the domain model now carries the
    // string form the real device actually uses.
    assert.equal(mapNetwork({ dhcp: true }).ipMode, 'dhcp')
    assert.equal(mapNetwork({ dhcp: 0 }).ipMode, 'manual')
    assert.equal(mapNetwork({ dhcp: 'on' }).ipMode, 'dhcp')
  })

  // -- MEASURED AE08 fields -------------------------------------------------
  // Real payload (abridged) from GET /get_network on firmware
  // 567E68F.2026-06-26_WEEK26.XSUSER.V.1.0.8. Every field carries a `dsy`
  // prefix; the specification documents none of them.

  it('maps the real dsy-prefixed network payload', () => {
    const config = mapNetwork({
      dsyDNSAdder: '192.0.2.53',
      dsyHTTPPort: 80,
      dsyIPAdder: '192.168.1.50',
      dsyIPGateway: '192.0.2.1',
      dsyIPMask: '255.255.255.0',
      dsyIPMode: 'manual',
      dsyRTSPPort: 28003,
      dsyTCPPort: 28001
    })

    assert.equal(config.ip, '192.168.1.50')
    assert.equal(config.netmask, '255.255.255.0')
    assert.equal(config.gateway, '192.0.2.1')
    assert.equal(config.dns, '192.0.2.53')
    assert.equal(config.httpPort, 80)
    assert.equal(config.rtspPort, 28003)
    assert.equal(config.tcpPort, 28001)
    assert.equal(config.ipMode, 'manual')
  })

  it('resolves spec risk 7: real ports are not zero', () => {
    // The specification's example showed port 0 and flagged its meaning as
    // unknown. On real hardware the ports carry genuine values, so 0 is an
    // "unset" placeholder rather than a mode.
    const config = mapNetwork({ dsyHTTPPort: 80, dsyRTSPPort: 28003, dsyTCPPort: 28001 })
    assert.notEqual(config.httpPort, 0)
    assert.equal(config.rtspPort, 28003)
  })

  it('still preserves an explicit zero rather than substituting a default', () => {
    // A future firmware could legitimately report 0 meaning "unset"; silently
    // replacing it with 80 would hide that from an operator.
    assert.equal(mapNetwork({ dsyHTTPPort: 0 }).httpPort, 0)
  })
})

describe('mapChannel', () => {
  it('maps a full channel record', () => {
    const channel = mapChannel(
      { channel_id: 3, channel_name: 'CH4 Bushing', sensor_type: 1, enable: 0, alarm_id: 7 },
      0
    )
    assert.ok(channel)
    assert.equal(channel.channelIndex, 3)
    assert.equal(channel.channelName, 'CH4 Bushing')
    assert.equal(channel.sensorType, SensorType.Conduction)
    assert.equal(channel.enabled, false)
    assert.equal(channel.remoteAlarmId, 7)
  })

  it('falls back to the positional index when channel_id is absent', () => {
    assert.equal(mapChannel({}, 5)?.channelIndex, 5)
  })

  it('defaults unknown sensor types to Microphone rather than losing the channel', () => {
    assert.equal(mapChannel({ channel_id: 0, sensor_type: 99 }, 0)?.sensorType, SensorType.Microphone)
  })

  it('rejects an out-of-range channel index', () => {
    assert.equal(mapChannel({ channel_id: 99 }, 0), undefined)
    assert.equal(mapChannel({ channel_id: -1 }, 0), undefined)
  })

  it('generates CH<n> when no name is given', () => {
    assert.equal(mapChannel({ channel_id: 0 }, 0)?.channelName, 'CH1')
    assert.equal(mapChannel({ channel_id: 7 }, 0)?.channelName, 'CH8')
  })
})

describe('mapChannels', () => {
  it('reads a bare array', () => {
    const channels = mapChannels([{ channel_id: 0 }, { channel_id: 1 }])
    assert.equal(channels.length, 2)
  })

  it('reads every envelope key the firmware might use', () => {
    for (const key of ['passageway', 'passageways', 'channel', 'channels', 'data', 'list']) {
      const channels = mapChannels({ [key]: [{ channel_id: 0 }] })
      assert.equal(channels.length, 1, `envelope key "${key}" was not recognised`)
    }
  })

  it('reads one level of nested envelope', () => {
    const channels = mapChannels({ data: { list: [{ channel_id: 0 }, { channel_id: 1 }] } })
    assert.equal(channels.length, 2)
  })

  it('de-duplicates repeated channel indices and sorts ascending', () => {
    const channels = mapChannels([{ channel_id: 2 }, { channel_id: 0 }, { channel_id: 2 }])
    assert.deepEqual(
      channels.map((channel) => channel.channelIndex),
      [0, 2]
    )
  })

  it('returns an empty list for junk rather than throwing', () => {
    assert.deepEqual(mapChannels(null), [])
    assert.deepEqual(mapChannels('nope'), [])
    assert.deepEqual(mapChannels({}), [])
  })

  it('handles a full 8-channel response', () => {
    const payload = Array.from({ length: 8 }, (_unused, index) => ({ channel_id: index }))
    assert.equal(mapChannels(payload).length, 8)
  })
})

describe('extractArray', () => {
  it('returns the array directly when given one', () => {
    assert.deepEqual(extractArray([1, 2], ['data']), [1, 2])
  })

  it('finds the first matching key', () => {
    assert.deepEqual(extractArray({ list: [3] }, ['data', 'list']), [3])
  })

  it('is empty for non-arrays', () => {
    assert.deepEqual(extractArray({ data: 'string' }, ['data']), [])
    assert.deepEqual(extractArray(undefined, ['data']), [])
  })
})

describe('mapSampleRate', () => {
  it('passes through Hz values', () => {
    assert.equal(mapSampleRate({ samplingrate: 48000 }), 48_000)
    assert.equal(mapSampleRate({ samplingrate: 96000 }), 96_000)
    assert.equal(mapSampleRate({ samplingrate: 192000 }), 192_000)
  })

  it('scales kHz values up to Hz', () => {
    assert.equal(mapSampleRate({ sample_rate: 48 }), 48_000)
    assert.equal(mapSampleRate(192), 192_000)
  })

  it('accepts a bare number or string', () => {
    assert.equal(mapSampleRate(48_000), 48_000)
    assert.equal(mapSampleRate('48000'), 48_000)
  })

  it('rejects nonsense', () => {
    assert.equal(mapSampleRate({}), undefined)
    assert.equal(mapSampleRate(0), undefined)
    assert.equal(mapSampleRate(-48000), undefined)
  })
})

describe('mapFeatureFrame', () => {
  const context = { deviceId: 'dev_1', nowMs: 1_700_000_000_000 }

  it('maps the documented field names', () => {
    const feature = mapFeatureFrame(
      {
        ch_id: 2,
        sound_pressure_level: 63.5,
        main_freq: 120.25,
        smoothness: 0.91,
        freq_band_energy_ratio: 0.44,
        hr_f: 0.12,
        sc_f: 0.34,
        sv_f: 0.56,
        time_stamp: 1_700_000_000
      },
      context
    )
    assert.ok(feature)
    assert.equal(feature.channelId, 2)
    assert.equal(feature.spl, 63.5)
    assert.equal(feature.mainFrequency, 120.25)
    assert.equal(feature.smoothness, 0.91)
    assert.equal(feature.bandEnergyRatio, 0.44)
    assert.equal(feature.oddEvenHarmonicRatio, 0.12)
    assert.equal(feature.spectralComplexity, 0.34)
    assert.equal(feature.fingerprintVariation, 0.56)
    assert.equal(feature.timestamp, 1_700_000_000_000)
  })

  it('accepts the hp_* aliases from the push protocol', () => {
    const feature = mapFeatureFrame(
      { hp_chid: 1, hp_spl: 55, hp_mainfreq: 100, hp_sll: 0.8, hp_fbet: 0.3 },
      context
    )
    assert.ok(feature)
    assert.equal(feature.channelId, 1)
    assert.equal(feature.spl, 55)
    assert.equal(feature.mainFrequency, 100)
  })

  it('coerces numeric strings', () => {
    const feature = mapFeatureFrame(
      { ch_id: '3', sound_pressure_level: '70.5', main_freq: '220' },
      context
    )
    assert.equal(feature?.channelId, 3)
    assert.equal(feature?.spl, 70.5)
    assert.equal(feature?.mainFrequency, 220)
  })

  it('returns undefined for a frame with no metrics, so keep-alives are not stored', () => {
    assert.equal(mapFeatureFrame({ ch_id: 0 }, context), undefined)
    assert.equal(mapFeatureFrame({}, context), undefined)
  })

  it('uses NaN, not 0, for an individual missing metric', () => {
    // A missing SPL must never render as "0 dB = silent".
    const feature = mapFeatureFrame({ ch_id: 0, main_freq: 50 }, context)
    assert.ok(feature)
    assert.ok(Number.isNaN(feature.spl), 'missing spl should be NaN, not 0')
    assert.equal(feature.mainFrequency, 50)
  })

  it('falls back to the supplied channel index when the frame omits one', () => {
    const feature = mapFeatureFrame({ spl: 60 }, { ...context, fallbackChannelId: 4 })
    assert.equal(feature?.channelId, 4)
  })

  it('returns undefined when neither a channel nor a fallback exists', () => {
    assert.equal(mapFeatureFrame({ spl: 60 }, context), undefined)
  })

  it('clamps an out-of-range channel into 0-7', () => {
    assert.equal(mapFeatureFrame({ ch_id: 99, spl: 60 }, context)?.channelId, 7)
    assert.equal(mapFeatureFrame({ ch_id: -5, spl: 60 }, context)?.channelId, 0)
  })

  it('uses the supplied clock when the frame carries no timestamp', () => {
    assert.equal(mapFeatureFrame({ ch_id: 0, spl: 1 }, context)?.timestamp, context.nowMs)
  })
})

describe('mapAlarmMask', () => {
  it('reads the common field names', () => {
    assert.equal(mapAlarmMask({ alarm_mask: 5 }), 5)
    assert.equal(mapAlarmMask({ alarm_type: 5 }), 5)
    assert.equal(mapAlarmMask({ abnormal_type: 5 }), 5)
  })

  it('parses hex strings', () => {
    assert.equal(mapAlarmMask({ alarm_type: '0x1F' }), 31)
  })

  it('parses decimal strings', () => {
    assert.equal(mapAlarmMask({ alarm_type: '31' }), 31)
  })

  it('returns undefined when there is no mask', () => {
    assert.equal(mapAlarmMask({}), undefined)
  })

  it('rejects a mask that would not fit in 31 bits', () => {
    assert.equal(mapAlarmMask({ alarm_mask: 2 ** 40 }), undefined)
  })
})

describe('mapDetectionType', () => {
  it('maps numeric and textual forms', () => {
    assert.equal(mapDetectionType(1), 'AI')
    assert.equal(mapDetectionType(0), 'Characteristic')
    assert.equal(mapDetectionType('AI'), 'AI')
    assert.equal(mapDetectionType('ai'), 'AI')
    assert.equal(mapDetectionType('characteristic'), 'Characteristic')
  })

  it('defaults to Characteristic for anything unrecognised', () => {
    assert.equal(mapDetectionType(undefined), 'Characteristic')
    assert.equal(mapDetectionType('???'), 'Characteristic')
  })
})
