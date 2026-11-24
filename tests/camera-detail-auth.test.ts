import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path: string): string => readFileSync(path, 'utf8')

test('camera detail does not call generic FA8 config loaders', () => {
  const detail = read('src/renderer/src/views/DeviceDetailView.vue')
  assert.match(detail, /loadsGenericDeviceConfig/)
  assert.match(detail, /config\.clearError\(\)/)
  assert.match(detail, /configTask/)
  assert.doesNotMatch(detail, /Promise\.all\(\[config\.loadAll\(props\.id\), devices\.refreshStatus\(props\.id\)\]\)/)
})

test('generic configFor refuses non-FA8 devices before touching the wire', () => {
  const service = read('src/main/services/device/device-service.ts')
  const start = service.indexOf('async configFor(deviceId: string): Promise<ConfigService> {')
  assert.ok(start >= 0)
  const body = service.slice(start, start + 1200)
  assert.match(body, /device\.kind !== 'acousticBox'/)
  assert.match(body, /ErrorCodes\.NOT_IMPLEMENTED/)
  assert.match(body, /const client = this\.clientFor\(device\)/)
})

test('camera detect-log parsing cannot flip a reachable camera offline', () => {
  const service = read('src/main/services/device/device-service.ts')
  const start = service.indexOf('async cameraDetectLogs(deviceId: string)')
  assert.ok(start >= 0)
  const end = service.indexOf('async configFor(', start)
  const body = service.slice(start, end)
  assert.match(body, /this\.cameraClientFor\(device\)\.getDetectLogs\(1\)/)
  assert.doesNotMatch(body, /withStatusTracking/)
})
