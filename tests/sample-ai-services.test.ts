/**
 * 命名的 AI 服务库（业主追加：设置里支持「不同 AI 服务」）。
 *
 * WHY THIS FILE EXISTS
 * `SampleAiStore` 是这一块的唯一持久化入口，要钉住的行为：
 *   1. 旧单配置 → 服务库的**一次性迁移**：合成「默认服务」、设为选用、旧键删除；
 *      `enabled` 键沿用（迁移前后同一个开关，不重置用户的选择）；
 *   2. 增 / 改 / 删 / 选用四条写路径：不合法地址在保存那一刻被拒（带原因）；
 *   3. 删除服务**连同密钥**（真删除）；删掉当前选用项回落到第一条；
 *   4. 测试环境没有系统加密（`safeStorage` 不可用）：密钥写入**失败关闭**——
 *      一个明文 Key 字节都不落盘，配置本体照存。
 *
 * 密钥用 `sampleAi.key.<id>` 每服务一条；`app_meta` 用内存 Map 假桩（store 只依赖
 * get/set/remove 三个方法，不真的开 SQLite）。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { SampleAiStore } from '../src/main/services/sample/sample-ai-store'

/** 内存版 AppMetaRepository：只实现 store 用到的三个方法。 */
function fakeMeta(initial?: Record<string, string>): {
  store: SampleAiStore
  map: Map<string, string>
} {
  const map = new Map<string, string>(Object.entries(initial ?? {}))
  const meta = {
    get: (key: string) => map.get(key),
    set: (key: string, value: string) => void map.set(key, value),
    remove: (key: string) => void map.delete(key)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { store: new SampleAiStore(meta as any), map }
}

describe('AI 服务库：旧单配置迁移', () => {
  it('旧 endpoint/model/key → 合成「默认服务」、设为选用、旧键删除', () => {
    const { store, map } = fakeMeta({
      'sampleAi.enabled': 'true',
      'sampleAi.endpoint': 'https://api.example.com/v1/chat/completions',
      'sampleAi.model': 'demo-model',
      'sampleAi.apiKey': 'ciphertext'
    })
    const stored = store.read()
    assert.equal(stored.services.length, 1)
    assert.equal(stored.services[0]!.name, '默认服务')
    assert.equal(stored.services[0]!.endpoint, 'https://api.example.com/v1/chat/completions')
    assert.equal(stored.services[0]!.model, 'demo-model')
    // 设为选用 + enabled 键沿用（'true' → true）。
    assert.equal(stored.activeId, stored.services[0]!.id)
    assert.equal(stored.enabled, true)
    // 旧键删干净（enabled 键是开关本体，保留）。
    assert.equal(map.get('sampleAi.endpoint'), undefined)
    assert.equal(map.get('sampleAi.model'), undefined)
    assert.equal(map.get('sampleAi.apiKey'), undefined)
    assert.equal(map.get('sampleAi.enabled'), 'true')
    // 再读一次：迁移幂等，不会长出第二条服务。
    assert.equal(store.read().services.length, 1)
  })

  it('旧配置 enabled=false：迁移后开关仍是关的（不替用户打开）', () => {
    const { store } = fakeMeta({
      'sampleAi.enabled': 'false',
      'sampleAi.endpoint': 'https://api.example.com/v1/chat/completions',
      'sampleAi.model': 'm'
    })
    const stored = store.read()
    assert.equal(stored.services.length, 1)
    assert.equal(stored.activeId, stored.services[0]!.id)
    assert.equal(stored.enabled, false)
    // readActive：开关关 ⇒ config.enabled=false（样本页照它禁用按钮）。
    assert.equal(store.readActive().config.enabled, false)
  })

  it('全新安装：空库落盘，不报错', () => {
    const { store, map } = fakeMeta()
    const stored = store.read()
    assert.deepEqual(stored.services, [])
    assert.equal(stored.activeId, '')
    assert.ok(map.get('sampleAi.services') !== undefined)
  })
})

describe('AI 服务库：增改删选', () => {
  it('saveService 新增：合法条目入列并拿到 id；不合法地址带原因被拒', () => {
    const { store } = fakeMeta()
    const ok = store.saveService({
      name: 'DeepSeek',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      model: 'deepseek-chat'
    })
    assert.equal(ok.error, undefined)
    assert.notEqual(ok.id, '')
    const bad = store.saveService({ name: '坏地址', endpoint: 'ftp://x', model: 'm' })
    assert.notEqual(bad.error, undefined)
    assert.equal(store.read().services.length, 1)
  })

  it('更新不存在的 id ⇒ 拒绝；更新存在的 id ⇒ 字段改写', () => {
    const { store } = fakeMeta()
    const created = store.saveService({
      name: '甲',
      endpoint: 'https://a.com/v1/chat/completions',
      model: 'm1'
    })
    const missing = store.saveService({
      id: 'no-such-id',
      name: '乙',
      endpoint: 'https://b.com/v1/chat/completions',
      model: 'm2'
    })
    assert.notEqual(missing.error, undefined)
    const updated = store.saveService({
      id: created.id,
      name: '甲改',
      endpoint: 'https://a2.com/v1/chat/completions',
      model: 'm3'
    })
    assert.equal(updated.error, undefined)
    const stored = store.read()
    assert.equal(stored.services.length, 1)
    assert.equal(stored.services[0]!.name, '甲改')
    assert.equal(stored.services[0]!.endpoint, 'https://a2.com/v1/chat/completions')
  })

  it('deleteService：删掉当前选用项回落到第一条；删空后 activeId 为空串', () => {
    const { store } = fakeMeta()
    const first = store.saveService({
      name: '一',
      endpoint: 'https://1.com/v1/chat/completions',
      model: 'm'
    })
    store.saveService({ name: '二', endpoint: 'https://2.com/v1/chat/completions', model: 'm' })
    const second = store.read().services.find((service) => service.name === '二')
    assert.ok(second)
    store.setActive(second.id)
    assert.equal(store.read().activeId, second.id)
    // 删当前选用项 ⇒ 回落到第一条。
    assert.equal(store.deleteService(second.id), true)
    assert.equal(store.read().activeId, first.id)
    // 删掉不存在的 ⇒ false，不抛错。
    assert.equal(store.deleteService('ghost'), false)
    // 删空。
    store.deleteService(first.id)
    assert.equal(store.read().activeId, '')
    assert.equal(store.readActive().config.enabled, false)
  })

  it('setActive：选用即打开总开关；空串 = 不选任何服务', () => {
    const { store } = fakeMeta()
    const created = store.saveService({
      name: '甲',
      endpoint: 'https://a.com/v1/chat/completions',
      model: 'm'
    })
    store.setActive('')
    assert.equal(store.read().activeId, '')
    store.setActive(created.id)
    const stored = store.read()
    assert.equal(stored.activeId, created.id)
    assert.equal(stored.enabled, true)
    // 选用不存在的 id ⇒ false。
    assert.equal(store.setActive('ghost'), false)
  })

  it('saveActiveConfig（旧三通道）：改 active 服务的地址/模型/开关，不动选用', () => {
    const { store } = fakeMeta()
    const created = store.saveService({
      name: '甲',
      endpoint: 'https://a.com/v1/chat/completions',
      model: 'm'
    })
    store.setActive(created.id)
    store.saveActiveConfig({
      enabled: false,
      endpoint: 'https://a2.com/v1/chat/completions',
      model: 'm2'
    })
    const stored = store.read()
    assert.equal(stored.activeId, created.id, '选用关系不被开关改动')
    assert.equal(stored.enabled, false)
    assert.equal(stored.services[0]!.endpoint, 'https://a2.com/v1/chat/completions')
    assert.equal(store.readActive().config.enabled, false)
  })

  it('saveActiveConfig 对不合法地址抛错（与 store.saveService 同一条判据）', () => {
    const { store } = fakeMeta()
    const created = store.saveService({
      name: '甲',
      endpoint: 'https://a.com/v1/chat/completions',
      model: 'm'
    })
    store.setActive(created.id)
    assert.throws(
      () => store.saveActiveConfig({ enabled: true, endpoint: 'ftp://x', model: 'm' }),
      /http:\/\/ 或 https:\/\//
    )
  })

  it('库里没有服务时 saveActiveConfig 自动创建「默认服务」并选用（样本页老入口不丢配置）', () => {
    const { store } = fakeMeta()
    store.saveActiveConfig({
      enabled: true,
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'm'
    })
    const stored = store.read()
    assert.equal(stored.services.length, 1)
    assert.equal(stored.services[0]!.name, '默认服务')
    assert.equal(stored.activeId, stored.services[0]!.id)
    assert.equal(stored.enabled, true)
    // 自动创建后再保存 = 更新同一条，不会长出第二条。
    store.saveActiveConfig({
      enabled: true,
      endpoint: 'https://api2.example.com/v1/chat/completions',
      model: 'm2'
    })
    const after = store.read()
    assert.equal(after.services.length, 1)
    assert.equal(after.services[0]!.endpoint, 'https://api2.example.com/v1/chat/completions')
  })

  it('库里没有服务、地址也为空：saveActiveConfig 只落开关，不长出空服务', () => {
    const { store } = fakeMeta()
    store.saveActiveConfig({ enabled: false, endpoint: '', model: '' })
    assert.equal(store.read().services.length, 0)
    assert.equal(store.read().enabled, false)
  })
})

describe('AI 服务库：密钥的失败关闭（无系统加密环境）', () => {
  it('saveService 带 key：配置照存，密钥不落盘（stored=false）', () => {
    const { store, map } = fakeMeta()
    const created = store.saveService({
      name: '甲',
      endpoint: 'https://a.com/v1/chat/completions',
      model: 'm',
      apiKey: 'secret-key'
    })
    const stored = store.read()
    assert.equal(stored.services.length, 1)
    assert.equal(stored.keys[created.id]?.stored, false)
    assert.equal(map.get(`sampleAi.key.${created.id}`), undefined, '一个明文/密文 Key 字节都不写')
  })

  it('deleteService 把密钥键一起删掉（真删除）', () => {
    const { store, map } = fakeMeta()
    // 手工预置一条密文（模拟"系统加密可用时存下的"）。
    const created = store.saveService({
      name: '甲',
      endpoint: 'https://a.com/v1/chat/completions',
      model: 'm'
    })
    map.set(`sampleAi.key.${created.id}`, 'ciphertext-bytes')
    store.deleteService(created.id)
    assert.equal(map.get(`sampleAi.key.${created.id}`), undefined)
  })
})
