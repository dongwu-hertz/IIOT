/**
 * 命名的 GIS 服务库（业主追加：设置里「添加 GIS 服务」）。
 *
 * WHY THIS FILE EXISTS
 * `normaliseMapServices()` 是设置落库前的最后一道闸：界面存进来的、磁盘上被手改过的，
 * 都从这里过。要钉住的行为：
 *   1. 坏条目**逐条丢弃**并记 issues（索引:问题码）——一条坏服务不作废整个库；
 *   2. 名称必填、模板必填且沿用 `mapTilesProblem()` 的全部规则（同一份判据）；
 *   3. id 去重（后到的丢）、上限 `MAX_MAP_SERVICES`、缺 id 自动补；
 *   4. 非数组输入 = 空库（不是抛错：设置表里的坏值不该让启动失败）。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  MAX_MAP_SERVICES,
  mapServiceProblem,
  normaliseMapServices,
  type MapServiceEntry
} from '../src/shared/domain/map-tiles'

function entry(partial: Partial<MapServiceEntry>): MapServiceEntry {
  return {
    id: 'svc-1',
    name: '我的服务',
    service: 'custom',
    urlTemplate: 'https://tiles.example.com/{z}/{x}/{y}.png',
    apiKey: '',
    attribution: '© example',
    ...partial
  }
}

describe('GIS 服务库：归一化', () => {
  it('非数组输入 ⇒ 空库（坏设置值不让启动失败）', () => {
    for (const bad of [undefined, null, 42, 'str', {}, { 0: entry({}) }]) {
      const result = normaliseMapServices(bad)
      assert.deepEqual(result.services, [])
      assert.deepEqual(result.issues, [])
    }
  })

  it('合法条目原样通过（trim 字段）', () => {
    const { services, issues } = normaliseMapServices([
      entry({ name: '  带空格的名字  ', urlTemplate: ' https://a.com/{z}/{x}/{y}.png ' })
    ])
    assert.equal(issues.length, 0)
    assert.equal(services.length, 1)
    assert.equal(services[0]!.name, '带空格的名字')
    assert.equal(services[0]!.urlTemplate, 'https://a.com/{z}/{x}/{y}.png')
  })

  it('坏条目逐条丢弃，一条坏服务不作废整个库', () => {
    const { services, issues } = normaliseMapServices([
      entry({ id: 'good-1', name: '好服务' }),
      entry({ id: 'bad-1', name: '' }), // 空名
      entry({ id: 'bad-2', urlTemplate: '' }), // 空模板
      entry({ id: 'good-2', name: '另一个好服务' })
    ])
    assert.deepEqual(
      services.map((service) => service.id),
      ['good-1', 'good-2']
    )
    assert.equal(issues.length, 2)
    assert.ok(issues[0]!.startsWith('1:'))
    assert.ok(issues[1]!.startsWith('2:'))
  })

  it('重复 id：后到的丢', () => {
    const { services, issues } = normaliseMapServices([
      entry({ id: 'dup', name: '先到' }),
      entry({ id: 'dup', name: '后到' })
    ])
    assert.equal(services.length, 1)
    assert.equal(services[0]!.name, '先到')
    assert.ok(issues.some((issue) => issue.endsWith(':duplicate-id')))
  })

  it('缺 id 自动补一个（不会两条都空 id 撞车）', () => {
    const { services, issues } = normaliseMapServices([
      entry({ id: '', name: '甲' }),
      entry({ id: '', name: '乙' })
    ])
    assert.equal(issues.length, 0)
    assert.equal(services.length, 2)
    assert.notEqual(services[0]!.id, services[1]!.id)
    assert.ok(services.every((service) => service.id !== ''))
  })

  it('超过上限：后面的条目丢弃并记 too-many', () => {
    const many = Array.from({ length: MAX_MAP_SERVICES + 3 }, (_, index) =>
      entry({ id: `s${index}`, name: `服务${index}` })
    )
    const { services, issues } = normaliseMapServices(many)
    assert.equal(services.length, MAX_MAP_SERVICES)
    assert.equal(issues.filter((issue) => issue.endsWith(':too-many')).length, 3)
  })

  it('模板校验沿用 mapTilesProblem 同一份判据（http / 缺占位符 / 未知占位符）', () => {
    for (const template of [
      'http://a.com/{z}/{x}/{y}.png', // 只允许 https
      'https://a.com/{z}/{x}.png', // 缺 {y}
      'https://a.com/{z}/{x}/{y}/{foo}.png' // 未知占位符
    ]) {
      const result = normaliseMapServices([entry({ urlTemplate: template })])
      assert.equal(result.services.length, 0, `模板 ${template} 应被拒`)
      assert.equal(result.issues.length, 1)
    }
  })

  it('形状不对的元素（字符串/数字）记 shape 丢弃，不让 JSON.parse 式崩掉', () => {
    const { services, issues } = normaliseMapServices(['oops', 42, null, entry({ id: 'ok' })])
    assert.deepEqual(
      services.map((service) => service.id),
      ['ok']
    )
    assert.equal(issues.filter((issue) => issue.endsWith(':shape')).length, 3)
  })
})

describe('GIS 服务库：单条校验', () => {
  it('空名 / 超长名 ⇒ templateInvalid', () => {
    assert.equal(mapServiceProblem(entry({ name: '' })), 'templateInvalid')
    assert.equal(mapServiceProblem(entry({ name: 'x'.repeat(65) })), 'templateInvalid')
  })

  it('名称合法但模板坏 ⇒ 返回 mapTilesProblem 的问题码', () => {
    assert.equal(mapServiceProblem(entry({ urlTemplate: '' })), 'templateRequired')
    assert.equal(
      mapServiceProblem(entry({ urlTemplate: 'http://a.com/{z}/{x}/{y}.png' })),
      'templateProtocol'
    )
  })

  it('好条目 ⇒ null', () => {
    assert.equal(mapServiceProblem(entry({})), null)
  })
})
