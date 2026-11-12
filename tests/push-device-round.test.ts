/**
 * 业主 20260921 第二批（Item 11/12/13）的界面与主进程结构回归测试。
 *
 * WHY THIS FILE EXISTS
 * 这一批的核心是第四种机型 `pushDevice`（HTTP/MQTT 接入的纯推送第三方设备），它牵出
 * 一串"老代码遇到新 kind 会怎样"的问题：
 *
 *   1. **铅笔编辑图标**：设备表「设置」列的图标改为 24 viewBox 的可编辑铅笔；
 *   2. **编辑对话框的显隐**（Item 12）：推流秘钥那一块（DevicePushEndpoint）只对声明了
 *      http/mqtt 接入的设备显示；推送设备编辑名称 / GIS / 推流键，IP 区整块隐藏；
 *   3. **设备详情页**：pushDevice 得到最小页签集（概览 + push），不挂任何设备协议页签；
 *   4. **机型标签**：设备表与地图悬停对 pushDevice 走 `devicesUi.kindPushDevice`
 *      （不进 `domain.deviceKind.*`）；
 *   5. **主进程接线**：接入服务收到遥测 → DeviceService 标在线（app-services 的
 *      `onTelemetry` 适配器）。
 *
 * 词条（addDeviceUi.* / devicesUi.kindPushDevice）由 i18n 那一批统一补，这里只断
 * **键名被源码引用**与结构，不断目录内容。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

const projectRoot = path.resolve(__dirname, '..', '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

const devicesView = read('src/renderer/src/views/DevicesView.vue')
const detailView = read('src/renderer/src/views/DeviceDetailView.vue')
const mapView = read('src/renderer/src/views/DeviceMapView.vue')
const dialog = read('src/renderer/src/components/AddDeviceDialog.vue')

describe('设置列图标是**铅笔**（可编辑动作）', () => {
  it('device-configure 按钮里是 24 viewBox 的铅笔，描边风格与相邻图标一致', () => {
    const button = devicesView.slice(
      devicesView.indexOf('data-action="device-configure"'),
      devicesView.indexOf('data-action="device-delete"')
    )
    assert.match(button, /viewBox="0 0 24 24"/, '编辑按钮不是 24 viewBox')
    assert.match(button, /stroke="currentColor"/, '没有用 currentColor 描边')
    assert.match(button, /fill="none"/, '不是无填充描边风格')
    assert.match(button, /<path d="M4 20h4l10\.5-10\.5a2\.1 2\.1 0 0 0-3-3L5 17v3Z"/)
    assert.match(button, /<path d="m13\.5 6\.5 4 4"/)
  })

  it('旧的齿轮/太阳图形不在了，data-action 保持不变', () => {
    const button = devicesView.slice(
      devicesView.indexOf('data-action="device-configure"'),
      devicesView.indexOf('data-action="device-delete"')
    )
    assert.equal(button.includes('<circle'), false, '编辑按钮里还有齿轮中心圆')
    assert.equal(button.includes('viewBox="0 0 16 16"'), false, '编辑按钮里还有 16 viewBox 的图标')
    assert.ok(button.includes('data-action="device-configure"'))
  })
})

describe('编辑对话框：DevicePushEndpoint 按接入方案显隐（Item 12）', () => {
  it('推流秘钥只对声明了 http/mqtt 的设备显示', () => {
    assert.match(
      devicesView,
      /const editShowsPushEndpoint = computed\(\(\) => \{\s*const plan = editTarget\.value\?\.ingest\s*return plan !== undefined && usesIngest\(plan\.protocol\)/,
      '显隐判据不是"ingest_plan.protocol 为 http/mqtt"'
    )
    assert.match(
      devicesView,
      /<DevicePushEndpoint\s*\n?\s*v-if="editTarget && editShowsPushEndpoint"/,
      'DevicePushEndpoint 没有按判据显隐'
    )
  })

  it('推送设备的编辑：名称 / GIS / 推流键可改，IP 区整块隐藏', () => {
    // IP + 端口、用户名 + 密码两行只在非推送设备出现。
    assert.match(
      devicesView,
      /<template v-if="!editIsPushDevice">[\s\S]{0,2000}data-field="edit-ip"/,
      'IP 区没有对推送设备隐藏'
    )
    // 推流键编辑块只对推送设备出现。
    assert.match(
      devicesView,
      /<div v-if="editIsPushDevice" class="edit-push-keys">/,
      '没有推送设备专属的推流键编辑块'
    )
    assert.match(devicesView, /:data-iot-metric-key="row\.metric"/, '推流键编辑没有探针钩子')
    // 提交：推送设备发 ingest 方案，不发端口/凭据。
    assert.match(
      devicesView,
      /\.\.\.\(pushDevice\s*\n\s*\?\s*\{[\s\S]{0,200}ingest: ingest as NonNullable<typeof ingest>[\s\S]{0,40}\}\s*\n\s*: \{/,
      '推送设备的提交没有换成 ingest 分支'
    )
    assert.match(
      devicesView,
      /deviceIngestPlanProblems\(ingest\)\.length > 0/,
      '编辑推送设备的推流键没有过共享层校验'
    )
  })
})

describe('设备详情页：pushDevice 的最小页签集（Item 12）', () => {
  it('页签只有 概览 + push，且显式分支（不进 FA8 默认分支）', () => {
    assert.match(detailView, /const PUSH_DEVICE_TABS: ReadonlyArray<TabId> = \['overview', 'push'\]/)
    assert.match(
      detailView,
      /if \(kind === 'pushDevice'\) return TABS\.filter\(\(tab\) => PUSH_DEVICE_TABS\.includes\(tab\.id\)\)/,
      'visibleTabs 没有 pushDevice 的显式分支'
    )
  })

  it('push 页签对推送设备装本机推流端点（DevicePushEndpoint），其余机型照旧 PushConfigSection', () => {
    assert.match(
      detailView,
      /<template v-else-if="activeTab === 'push'">[\s\S]{0,200}<DevicePushEndpoint v-if="device\.kind === 'pushDevice'" :device-id="props\.id" \/>/,
      'push 页签没有按机型分流'
    )
    assert.match(detailView, /<PushConfigSection v-else :device-id="props\.id" \/>/)
  })
})

describe('机型标签：pushDevice 走 devicesUi.kindPushDevice（Item 12）', () => {
  it('设备表与地图悬停都有 pushDevice 分支', () => {
    assert.match(
      devicesView,
      /function kindLabel\(device: Device\): string \{\s*return device\.kind === 'pushDevice'\s*\n\s*\? t\('devicesUi\.kindPushDevice'\)/,
      '设备表没有 pushDevice 标签分支'
    )
    assert.match(
      mapView,
      /function hoverKindLabel\(device: Device\): string \{\s*return device\.kind === 'pushDevice'\s*\n\s*\? t\('devicesUi\.kindPushDevice'\)/,
      '地图悬停没有 pushDevice 标签分支'
    )
  })

  it('添加对话框的成功提示引用 pushDeviceAdded 键名', () => {
    assert.ok(dialog.includes("t('addDeviceUi.pushDeviceAdded')"))
  })
})

describe('主进程接线：收到遥测 → 设备上线（Item 12）', () => {
  it('app-services 把 TelemetryIntake 的 onTelemetry 接到 DeviceService', () => {
    const services = read('src/main/services/app-services.ts')
    assert.match(
      services,
      /onTelemetry: \(deviceId\) => deviceService\.markOnlineFromTelemetry\(deviceId\)/,
      'onTelemetry 没有接到 DeviceService.markOnlineFromTelemetry'
    )
  })

  it('DeviceService 有 markOnlineFromTelemetry，且健康检查对 pushDevice 走无遥测分支', () => {
    const service = read('src/main/services/device/device-service.ts')
    assert.match(service, /markOnlineFromTelemetry\(deviceId: string\): void/)
    assert.match(
      service,
      /if \(device\.kind === 'pushDevice'\) \{\s*this\.checkPushDevice\(device, runtime\)\s*return\s*\}/,
      'checkOne 没有跳过推送设备的 HTTP 轮询'
    )
    assert.match(service, /shouldMarkPushDeviceOffline\(\{/)
  })
})
