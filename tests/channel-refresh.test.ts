/**
 * 通道启用状态的刷新守卫（业主 2026-11-11）。
 *
 * 现象：设备上只接了通道 5 和通道 8（`/get_passageway` 里 dchEn=1 在 dchId 4/7），
 * 但实时监测页的 CH5/CH8 页签仍是「已关闭」，点了也不切换；设备管理里也还是旧表。
 *
 * 根因不是映射（`mapChannels` 实测能正确读出 4/7），而是**缓存**：
 *   - 实时监测读 `devices.channelsOf()`，`loadChannels` 默认命中渲染层缓存就不再读；
 *   - 设备管理只在页面挂载时 loadAll 一次，切回通道页签不重读；
 *   - 保存通道只更新配置 store，不更新实时监测读的那份共享通道表。
 *
 * 设备不会推送通道配置变更事件，所以这三处都必须显式重读。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

const projectRoot = path.resolve(__dirname, '..', '..')
function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

const monitor = read('src/renderer/src/views/MonitorView.vue')
const section = read('src/renderer/src/components/device-config/ChannelConfigSection.vue')
const configStore = read('src/renderer/src/stores/deviceConfig.ts')

describe('通道启用状态：进入页面 / 切回窗口 / 打开页签都从设备重读', () => {
  it('实时监测进入页面与换设备时强制刷新通道表（不吃渲染层缓存）', () => {
    assert.match(monitor, /devices\.loadChannels\(selectedDeviceId\.value,\s*true\)/)
    assert.match(monitor, /devices\.loadChannels\(id,\s*true\)/)
  })

  it('从设备 Web 界面切回本软件（窗口 focus）时刷新通道表', () => {
    assert.match(monitor, /function refreshChannelsOnFocus\(\): void/)
    assert.match(monitor, /window\.addEventListener\('focus', refreshChannelsOnFocus\)/)
    assert.match(monitor, /window\.removeEventListener\('focus', refreshChannelsOnFocus\)/)
  })

  it('设备管理每次打开「通道与采样率」页签都从设备重读', () => {
    assert.match(section, /onMounted\(\(\) => \{\s*void reloadChannels\(\)\s*\}\)/)
  })

  it('保存通道后同步共享的设备通道缓存，实时监测页签立即跟着变', () => {
    assert.match(configStore, /useDevicesStore\(\)\.loadChannels\(targetDeviceId,\s*true\)/)
  })
})