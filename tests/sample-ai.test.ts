/**
 * 可插拔 AI 标注的**判断**与**网络**（`shared/domain/sample-ai.ts` +
 * `main/services/sample/sample-ai-label-service.ts`）。
 *
 * 这一组断言对准的是「一个自己标自己训的模型会不会把库弄脏」：
 *   - 没配置就说没配置（`describeAiReadiness` 给出**具体**原因）；
 *   - AI 标签恒为 `label_source = 'ai'`，而 `isTrainable()` 只认 `human`；
 *   - **人工标签永不覆盖**；设备弱标签默认也跳过（覆盖是破坏性的、要显式勾选）；
 *   - 模型回复里的"未知"不是一个类别；
 *   - 密钥永远不出现在回给界面的状态里。
 *
 * 网络这一层用**真的**本地 http 服务跑（`node:http`，不 mock fetch）：这样超时、
 * 非 200、`choices` 形状不对、正文包着代码块这些情形都是真的走了一遍。
 */

import { strict as assert } from 'node:assert'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import Database from 'better-sqlite3'

import { SampleRepository } from '../src/main/services/database/sample-repository'
import { SampleLabelRepository } from '../src/main/services/database/sample-label-repository'
import { openDatabase } from '../src/main/services/database/schema'
import { SampleLabelService } from '../src/main/services/sample/sample-label-service'
import {
  SampleAiLabelService,
  toStatus
} from '../src/main/services/sample/sample-ai-label-service'
import type { SampleAiStore, StoredAiSettings } from '../src/main/services/sample/sample-ai-store'
import {
  EMPTY_AI_CONFIG,
  buildLabelMessages,
  describeAiReadiness,
  extractReplyText,
  isAcceptableAiEndpoint,
  normaliseAiEndpoint,
  parseLabelReply
} from '../src/shared/domain/sample-ai'
import { humanLabel, weakLabelFromAlarmTypes } from '../src/shared/domain/sample-library'
import { AlarmType } from '../src/shared/domain/models'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-ai-'))
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

let counter = 0
function freshDb(): InstanceType<typeof Database> {
  counter += 1
  const db = openDatabase({ file: path.join(tempRoot, `db-${counter}.db`) })
  db.prepare(
    `INSERT INTO devices (id, device_uid, name, status, created_at, updated_at)
     VALUES ('dev-1', 'uid-dev-1', 'AE08', 'ONLINE', 1, 1)`
  ).run()
  return db
}

const FULL_METRICS = { spl: 62.5, mainFrequency: 93, smoothness: 4.88, bandEnergyRatio: 0.5 }

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

describe('AI 配置：能不能用，以及**为什么**不能用', () => {
  it('未启用 / 没地址 / 地址不合法 / 没模型，四种原因分得开', () => {
    assert.deepEqual(describeAiReadiness(EMPTY_AI_CONFIG), { ready: false, reason: 'disabled' })
    assert.deepEqual(
      describeAiReadiness({ enabled: true, endpoint: '  ', model: 'm' }),
      { ready: false, reason: 'no-endpoint' }
    )
    assert.deepEqual(
      describeAiReadiness({ enabled: true, endpoint: 'ftp://host/x', model: 'm' }),
      { ready: false, reason: 'bad-endpoint' }
    )
    assert.deepEqual(
      describeAiReadiness({ enabled: true, endpoint: 'https://host/v1/chat/completions', model: '' }),
      { ready: false, reason: 'no-model' }
    )
    assert.deepEqual(
      describeAiReadiness({ enabled: true, endpoint: 'http://127.0.0.1:1/x', model: 'm' }),
      { ready: true }
    )
  })

  it('地址只去空白与尾斜杠，**不猜**路径', () => {
    assert.equal(normaliseAiEndpoint('  https://host/v1/chat/completions//  '), 'https://host/v1/chat/completions')
    assert.equal(normaliseAiEndpoint('https://host'), 'https://host')
    assert.equal(isAcceptableAiEndpoint('not a url'), false)
    assert.equal(isAcceptableAiEndpoint('https://host/x'), true)
  })
})

describe('AI 提示词：缺失的维度是 null，不是 0', () => {
  it('固定顺序输出七维，没测到的写 null', () => {
    const messages = buildLabelMessages({
      deviceName: 'AE08',
      channelIndex: 2,
      capturedAt: 0,
      metrics: { spl: 62.5 },
      deviceLabel: 'corona_discharge'
    })
    assert.equal(messages.length, 2)
    assert.equal(messages[0]?.role, 'system')
    assert.equal(messages[1]?.role, 'user')

    const user = messages[1]?.content ?? ''
    const json = user.slice(user.indexOf('{'), user.lastIndexOf('}') + 1)
    const payload = JSON.parse(json) as Record<string, unknown>
    const metrics = payload.metrics as Record<string, number | null>

    assert.equal(metrics.spl, 62.5)
    // 关键：**缺的维度是 null**。写成 0 会让模型把"没测到"当成一次真实测量。
    assert.equal(metrics.mainFrequency, null)
    assert.equal(metrics.smoothness, null)
    assert.equal(Object.keys(metrics).length, 7)

    assert.equal(payload.device_label, 'corona_discharge')
    // 设备判定与上一轮 AI 猜测是**两格**：混在一起就是让模型自证。
    assert.equal(payload.previous_fault_label, null)
    assert.equal(payload.device_name, 'AE08')
    assert.equal(payload.channel_index, 2)
  })

  it('上一轮的 AI 候选进的是 previous_* 那两格，现有词表按维度分开给', () => {
    const messages = buildLabelMessages(
      {
        channelIndex: 0,
        capturedAt: 0,
        metrics: {},
        previousFaultLabel: '轴承故障',
        previousEquipmentLabel: '电机'
      },
      ['电力变压器', '开关柜'],
      ['轴承故障', '电晕放电']
    )
    const user = messages[1]?.content ?? ''
    const payload = JSON.parse(user.slice(user.indexOf('{'), user.lastIndexOf('}') + 1)) as Record<
      string,
      unknown
    >
    assert.equal(payload.previous_fault_label, '轴承故障')
    assert.equal(payload.previous_equipment_label, '电机')
    assert.equal(payload.device_label, null)
    // 两张词表分开送：混成一个数组会让模型把设备类型当故障类型用。
    assert.deepEqual(payload.existing_equipment_labels, ['电力变压器', '开关柜'])
    assert.deepEqual(payload.existing_fault_labels, ['轴承故障', '电晕放电'])
  })
})

describe('AI 回复解析：包着代码块也能读，读不出就报错', () => {
  it('纯 JSON：故障类型是必填的那一维', () => {
    assert.deepEqual(parseLabelReply('{"fault_label":"电晕放电","confidence":0.9}'), {
      ok: true,
      faultLabel: '电晕放电',
      confidence: 0.9
    })
  })

  it('两个维度都能解析出来（设备类型是可选的）', () => {
    const parsed = parseLabelReply(
      '{"equipment_label":"电力变压器","fault_label":"局部放电","confidence":0.8}'
    )
    assert.equal(parsed.ok ? parsed.faultLabel : '', '局部放电')
    assert.equal(parsed.ok ? parsed.equipmentLabel : '', '电力变压器')
  })

  it('旧字段名 `label` 仍然认（换提示词之前配好的端点会按旧格式回话）', () => {
    const parsed = parseLabelReply('{"label":"电晕放电"}')
    assert.equal(parsed.ok ? parsed.faultLabel : '', '电晕放电')
  })

  it('设备类型说"未知"只是**没有这一维**，不是错误', () => {
    const parsed = parseLabelReply('{"fault_label":"电晕放电","equipment_label":"未知"}')
    assert.equal(parsed.ok, true)
    assert.equal(parsed.ok ? parsed.faultLabel : '', '电晕放电')
    assert.equal(parsed.ok ? parsed.equipmentLabel : undefined, undefined)
  })

  it('```json 代码块 + 前后一句话（现实里最常见）', () => {
    const text = '好的，结果如下：\n```json\n{"label":"轴承故障","confidence":0.5,"rationale":"频谱有边带"}\n```\n希望有帮助。'
    const parsed = parseLabelReply(text)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.ok ? parsed.faultLabel : '', '轴承故障')
    assert.equal(parsed.ok ? parsed.rationale : '', '频谱有边带')
  })

  it('confidence 被夹到 0~1（95 不是概率）', () => {
    const parsed = parseLabelReply('{"label":"a","confidence":95}')
    assert.equal(parsed.ok ? parsed.confidence : -1, 1)
    const negative = parseLabelReply('{"label":"a","confidence":-3}')
    assert.equal(negative.ok ? negative.confidence : -1, 0)
  })

  it('没有 JSON / 没有 label ⇒ 报错，不猜', () => {
    assert.deepEqual(parseLabelReply('我不知道'), { ok: false, reason: 'no-json' })
    assert.deepEqual(parseLabelReply('{"confidence":0.9}'), { ok: false, reason: 'no-label' })
    assert.deepEqual(parseLabelReply('{"label":"   "}'), { ok: false, reason: 'no-label' })
  })

  it('模型自己说"未知"不是一个类别', () => {
    assert.deepEqual(parseLabelReply('{"label":"未知"}'), { ok: false, reason: 'unknown-label' })
    assert.deepEqual(parseLabelReply('{"label":"unknown"}'), { ok: false, reason: 'unknown-label' })
  })

  it('标签里的尾随标点按同一套归一化处理（与设备弱标签一致）', () => {
    const parsed = parseLabelReply('{"label":"时域能量比超限，"}')
    assert.equal(parsed.ok ? parsed.faultLabel : '', '时域能量比超限')
  })

  it('响应形状不对时说清是 HTTP 还是形状问题', () => {
    assert.deepEqual(extractReplyText(500, { error: { message: 'overloaded' } }), {
      ok: false,
      reason: 'HTTP 500：overloaded'
    })
    assert.deepEqual(extractReplyText(200, { choices: [] }), {
      ok: false,
      reason: '响应里没有 choices'
    })
    assert.deepEqual(extractReplyText(200, { choices: [{ message: {} }] }), {
      ok: false,
      reason: '响应里没有正文'
    })
    assert.deepEqual(extractReplyText(200, { choices: [{ message: { content: 'hi' } }] }), {
      ok: true,
      text: 'hi'
    })
  })
})

// ---------------------------------------------------------------------------
// 服务 + 真的本地 http 服务
// ---------------------------------------------------------------------------

interface FakeServer {
  endpoint: string
  requests: Array<{ url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }>
  close(): Promise<void>
  setReply(reply: Reply): void
}

type Reply =
  | { kind: 'ok'; content: string }
  | { kind: 'status'; status: number; body: unknown }
  | { kind: 'raw'; status: number; body: string }

async function startServer(): Promise<FakeServer> {
  let reply: Reply = { kind: 'ok', content: '{"label":"a"}' }
  const requests: FakeServer['requests'] = []

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(raw) as Record<string, unknown>
      } catch {
        body = { __unparsable: raw }
      }
      requests.push({ url: request.url ?? '', headers: request.headers, body })

      if (reply.kind === 'ok') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ choices: [{ message: { content: reply.content } }] }))
        return
      }
      if (reply.kind === 'status') {
        response.writeHead(reply.status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(reply.body))
        return
      }
      response.writeHead(reply.status, { 'content-type': 'text/html' })
      response.end(reply.body)
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return {
    endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
    requests,
    setReply(next: Reply) {
      reply = next
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
  }
}

function fakeStore(settings: Partial<StoredAiSettings>): SampleAiStore {
  const value: StoredAiSettings = {
    config: { enabled: true, endpoint: 'http://127.0.0.1:1/v1/chat/completions', model: 'm' },
    apiKeyStored: false,
    encryptionAvailable: true,
    ...settings
  }
  return { read: () => value, save: () => undefined } as unknown as SampleAiStore
}

/**
 * 建服务。
 *
 * 三个仓库都从**同一个** db 句柄建出来：这样"AI 写进去的标签有没有进标签库"这种跨表的事实
 * 才测得出来。签名收 db 而不是收一个现成的 repo，就是为了让这件事在调用点一眼可见。
 */
function makeService(db: InstanceType<typeof Database>, store: SampleAiStore): SampleAiLabelService {
  const repo = new SampleRepository(db)
  return new SampleAiLabelService({
    samples: repo,
    store,
    describeDevice: (deviceId) => (deviceId === 'dev-1' ? { name: 'AE08' } : {}),
    labels: new SampleLabelService({ labels: new SampleLabelRepository(db), samples: repo })
  })
}

/**
 * 插一条样本，返回 id。
 *
 * 两个维度**分开传**：`faultLabel` 决定覆盖规则（AI 只看这一维的来源），
 * `equipmentLabel` 是元数据。写成两个显式参数而不是一个 `label`，是为了让"这一条到底
 * 标了哪一维"在调用点一眼可见 —— 一个含糊的 `label` 正是刚才那次迁移里被静默丢掉的那一个。
 */
function seed(
  repo: SampleRepository,
  input: {
    capturedAt: number
    channelId?: number
    metrics?: Record<string, number>
    faultLabel?: { text: string; source: 'human' | 'device' | 'ai' }
    equipmentLabel?: { text: string; source: 'human' | 'device' | 'ai' }
  }
): string {
  const result = repo.insert({
    deviceId: 'dev-1',
    channelId: input.channelId ?? 0,
    source: 'alarm',
    capturedAt: input.capturedAt,
    metrics: input.metrics ?? FULL_METRICS,
    ...(input.faultLabel ? { faultLabel: input.faultLabel } : {}),
    ...(input.equipmentLabel ? { equipmentLabel: input.equipmentLabel } : {})
  })
  return result.id
}

describe('AI 标注服务：覆盖规则', () => {
  it('未配置时**抛错**，而不是返回一个空的成功', async () => {
    const db = freshDb()
    try {
      const service = makeService(
        db,
        fakeStore({ config: { enabled: true, endpoint: '', model: 'm' } })
      )
      assert.equal(service.status().blockedReason, 'no-endpoint')
      await assert.rejects(() => service.label({}), /未配置/)
    } finally {
      db.close()
    }
  })

  it('人工标签跳过；设备弱标签默认跳过；勾了才覆盖；没标签的直接写', async () => {
    const db = freshDb()
    const server = await startServer()
    // 两个维度都给：设备类型也跟着 AI 的候选走一遍。
    server.setReply({
      kind: 'ok',
      content: '{"equipment_label":"电力变压器","fault_label":"电晕放电","confidence":0.7}'
    })
    try {
      const repo = new SampleRepository(db)
      const human = seed(repo, { capturedAt: 1000, faultLabel: humanLabel('人工确认过的') })
      const weak = seed(repo, {
        capturedAt: 2000,
        channelId: 1,
        faultLabel: weakLabelFromAlarmTypes([AlarmType.CoronaDischarge])
      })
      const bare = seed(repo, { capturedAt: 3000, channelId: 2 })

      const service = makeService(
        db,
        fakeStore({
          config: { enabled: true, endpoint: server.endpoint, model: 'm' },
          apiKeyStored: true,
          apiKey: 'secret-key'
        })
      )

      const first = await service.label({})
      // 默认窗口**不看**人工标注的样本（看它们只会白占配额），所以这里 skippedHuman 是 0。
      assert.equal(first.considered, 2)
      assert.equal(first.skippedHuman, 0)
      assert.equal(first.skippedWeak, 1)
      assert.equal(first.requested, 1)
      assert.equal(first.labelled, 1)
      assert.equal(first.failed, 0)
      assert.equal(first.errors.length, 0)
      // 人工标签**一个字都没动**。
      assert.equal(repo.findById(human)?.faultLabel?.text, '人工确认过的')
      assert.equal(repo.findById(human)?.faultLabel?.source, 'human')
      // 设备弱标签也还在。
      assert.equal(repo.findById(weak)?.faultLabel?.source, 'device')
      // 没标签的那条两个维度都拿到了 AI 候选。
      assert.deepEqual(repo.findById(bare)?.faultLabel, { text: '电晕放电', source: 'ai' })
      assert.deepEqual(repo.findById(bare)?.equipmentLabel, { text: '电力变压器', source: 'ai' })
      // AI 给的名字**不进**标签库：词表是操作员维护的，候选要进得走"确认"那一步。
      const library = new SampleLabelService({
        labels: new SampleLabelRepository(db),
        samples: repo
      })
      assert.deepEqual(library.names('fault'), [])
      assert.deepEqual(library.names('equipment'), [])

      // 点名看人工标注的那条：会**看**，但拒绝覆盖，并如实计数。
      const pointed = await service.label({ sampleIds: [human] })
      assert.equal(pointed.considered, 1)
      assert.equal(pointed.skippedHuman, 1)
      assert.equal(pointed.requested, 0)
      assert.equal(server.requests.length, 1)
      assert.equal(repo.findById(human)?.faultLabel?.text, '人工确认过的')

      // 勾了"包含弱标签"之后，设备那条**会被替换**成 AI 候选。
      const second = await service.label({ includeWeakLabelled: true })
      assert.equal(second.skippedWeak, 0)
      assert.equal(second.requested, 2)
      assert.equal(repo.findById(weak)?.faultLabel?.source, 'ai')
      assert.equal(repo.findById(human)?.faultLabel?.source, 'human')
    } finally {
      db.close()
      await server.close()
    }
  })

  it('模型没提设备类型时**不动**已有的设备类型（"这次没说"不等于"清掉它"）', async () => {
    const db = freshDb()
    const server = await startServer()
    server.setReply({ kind: 'ok', content: '{"fault_label":"电晕放电"}' })
    try {
      const repo = new SampleRepository(db)
      const id = seed(repo, {
        capturedAt: 1000,
        equipmentLabel: { text: '开关柜', source: 'human' }
      })
      const service = makeService(
        db,
        fakeStore({ config: { enabled: true, endpoint: server.endpoint, model: 'm' } })
      )
      const outcome = await service.label({ sampleIds: [id] })
      assert.equal(outcome.labelled, 1)
      assert.deepEqual(repo.findById(id)?.faultLabel, { text: '电晕放电', source: 'ai' })
      assert.deepEqual(repo.findById(id)?.equipmentLabel, { text: '开关柜', source: 'human' })
    } finally {
      db.close()
      await server.close()
    }
  })

  it('请求体形状：temperature 0、要 JSON、带 Bearer 密钥', async () => {
    const db = freshDb()
    const server = await startServer()
    server.setReply({ kind: 'ok', content: '{"label":"a"}' })
    try {
      const repo = new SampleRepository(db)
      const id = seed(repo, { capturedAt: 1000 })
      const service = makeService(
        db,
        fakeStore({
          config: { enabled: true, endpoint: server.endpoint, model: 'qwen-plus' },
          apiKeyStored: true,
          apiKey: 'secret-key'
        })
      )
      await service.label({ sampleIds: [id] })

      assert.equal(server.requests.length, 1)
      const request = server.requests[0]
      assert.ok(request)
      assert.equal(request.headers.authorization, 'Bearer secret-key')
      assert.equal(request.body.model, 'qwen-plus')
      assert.equal(request.body.temperature, 0)
      assert.deepEqual(request.body.response_format, { type: 'json_object' })
      const messages = request.body.messages as Array<{ role: string; content: string }>
      assert.equal(messages[0]?.role, 'system')
      assert.ok(messages[1]?.content.includes('"spl":62.5'))
    } finally {
      db.close()
      await server.close()
    }
  })

  it('没有密钥时不带 authorization 头', async () => {
    const db = freshDb()
    const server = await startServer()
    try {
      const repo = new SampleRepository(db)
      seed(repo, { capturedAt: 1000 })
      const service = makeService(
        db,
        fakeStore({ config: { enabled: true, endpoint: server.endpoint, model: 'm' } })
      )
      await service.label({})
      assert.equal(server.requests[0]?.headers.authorization, undefined)
    } finally {
      db.close()
      await server.close()
    }
  })

  it('HTTP 失败与"未知"分别计数，错误原文带回来', async () => {
    const db = freshDb()
    const server = await startServer()
    try {
      const repo = new SampleRepository(db)
      const first = seed(repo, { capturedAt: 1000 })
      const second = seed(repo, { capturedAt: 2000, channelId: 1 })

      const service = makeService(
        db,
        fakeStore({ config: { enabled: true, endpoint: server.endpoint, model: 'm' } })
      )

      server.setReply({ kind: 'status', status: 503, body: { error: { message: 'busy' } } })
      const failed = await service.label({ sampleIds: [first] })
      assert.equal(failed.failed, 1)
      assert.equal(failed.labelled, 0)
      assert.ok(failed.errors[0]?.includes('HTTP 503'), failed.errors[0])
      // 失败就是失败：那条样本**不该**被写进任何标签。
      assert.equal(repo.findById(first)?.faultLabel, undefined)

      server.setReply({ kind: 'ok', content: '{"label":"未知"}' })
      const unresolved = await service.label({ sampleIds: [second] })
      assert.equal(unresolved.unresolved, 1)
      assert.equal(unresolved.failed, 0)
      assert.equal(repo.findById(second)?.faultLabel, undefined)
    } finally {
      db.close()
      await server.close()
    }
  })

  it('返回的不是 JSON（例如网关的 HTML 页面）算失败，不算"判不了"', async () => {
    const db = freshDb()
    const server = await startServer()
    server.setReply({ kind: 'raw', status: 200, body: '<html>gateway</html>' })
    try {
      const repo = new SampleRepository(db)
      const id = seed(repo, { capturedAt: 1000 })
      const service = makeService(
        db,
        fakeStore({ config: { enabled: true, endpoint: server.endpoint, model: 'm' } })
      )
      const outcome = await service.label({ sampleIds: [id] })
      assert.equal(outcome.failed, 1)
      assert.equal(outcome.unresolved, 0)
    } finally {
      db.close()
      await server.close()
    }
  })

  it('指定 sampleIds 时只问那些；查不到的丢掉且不计入 requested', async () => {
    const db = freshDb()
    const server = await startServer()
    try {
      const repo = new SampleRepository(db)
      const id = seed(repo, { capturedAt: 1000 })
      seed(repo, { capturedAt: 2000, channelId: 1 })
      const service = makeService(
        db,
        fakeStore({ config: { enabled: true, endpoint: server.endpoint, model: 'm' } })
      )
      const outcome = await service.label({ sampleIds: [id, 'does-not-exist'] })
      assert.equal(outcome.requested, 1)
      assert.equal(server.requests.length, 1)
    } finally {
      db.close()
      await server.close()
    }
  })

  it('一次最多问 maxBatch 条（外部服务不该被一次点爆）', async () => {
    const db = freshDb()
    const server = await startServer()
    try {
      const repo = new SampleRepository(db)
      for (let index = 0; index < 55; index += 1) {
        seed(repo, { capturedAt: 1000 + index, channelId: index % 8 })
      }
      const service = makeService(
        db,
        fakeStore({ config: { enabled: true, endpoint: server.endpoint, model: 'm' } })
      )
      const outcome = await service.label({})
      assert.equal(service.status().maxBatch, 50)
      assert.equal(outcome.considered, 50)
      assert.equal(outcome.requested, 50)
      assert.equal(server.requests.length, 50)
    } finally {
      db.close()
      await server.close()
    }
  })
})

describe('AI 状态：密钥不出现在回给界面的任何字段里', () => {
  it('只回 apiKeyStored，不回密钥内容', () => {
    const status = toStatus({
      config: { enabled: true, endpoint: 'https://host/v1/chat/completions', model: 'm' },
      apiKey: 'super-secret-value',
      apiKeyStored: true,
      encryptionAvailable: true
    })
    assert.equal(status.apiKeyStored, true)
    assert.equal(status.ready, true)
    // 密钥**内容**不在状态里；而 `apiKeyStored` 这个布尔本身当然要在。
    assert.equal(JSON.stringify(status).includes('super-secret-value'), false)
    assert.equal('apiKey' in status, false)
  })

  it('系统加密不可用时如实报 canStoreApiKey=false', () => {
    const status = toStatus({
      config: EMPTY_AI_CONFIG,
      apiKeyStored: false,
      encryptionAvailable: false
    })
    assert.equal(status.canStoreApiKey, false)
    assert.equal(status.ready, false)
    assert.equal(status.blockedReason, 'disabled')
  })
})
