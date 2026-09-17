/**
 * 本地样本库的**判断**（`shared/domain/sample-library.ts`）。
 *
 * 这一组断言对准的全是「一改就会让数据集变脏」的地方，逐条对应文件头写下的设计：
 *   - 标签**必须记住是谁给的**（设备弱标签 / 人工真值 / AI 候选），否则训练出来的模型
 *     在说谎而且事后查不出来；
 *   - 标签是**数据**不是文案：设备位图走稳定键，E2 的原文原样存，不翻译、不映射；
 *   - 缺失的特征**不许补 0**（补 0 等于编造一个测到的值）；
 *   - 默认**只拿人工标签**训练。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  SAMPLE_LABEL_MAX_LENGTH,
  SAMPLE_TRAINING_MIN_METRICS,
  countByLabel,
  featureVector,
  humanLabel,
  aiLabel,
  isTrainable,
  isTrainableWithWeakLabels,
  normaliseSampleLabel,
  weakLabelFromAlarmTypes,
  weakLabelFromReason
} from '../src/shared/domain/sample-library'
import { AlarmType } from '../src/shared/domain/models'

/** 四个必报维度都给齐的一份特征。 */
const FULL_METRICS = {
  spl: 62.5,
  mainFrequency: 93,
  smoothness: 4.88,
  bandEnergyRatio: 0.5
}

describe('样本标签：归一化', () => {
  it('去掉首尾空白并折叠内部空白', () => {
    assert.equal(normaliseSampleLabel('  电晕放电  '), '电晕放电')
    assert.equal(normaliseSampleLabel('电晕   放电'), '电晕 放电')
  })

  it('去掉**尾随**分隔标点（E2 手册示例的原文就带一个中文逗号）', () => {
    assert.equal(normaliseSampleLabel('时域能量比超限，'), '时域能量比超限')
    assert.equal(normaliseSampleLabel('时域能量比超限,  '), '时域能量比超限')
    assert.equal(normaliseSampleLabel('A、;;'), 'A')
  })

  it('只去尾部：类别名内部的括号与标点不动（那是设备给的类别名的一部分）', () => {
    assert.equal(normaliseSampleLabel('谐波分量超限（HPSS超限）'), '谐波分量超限（HPSS超限）')
    assert.equal(normaliseSampleLabel('a,b'), 'a,b')
  })

  it('空、纯空白、纯标点、非字符串一律"没有标签"（undefined 而不是空串）', () => {
    for (const value of ['', '   ', '，，', ';', 42, null, undefined, {}, []]) {
      assert.equal(normaliseSampleLabel(value), undefined, JSON.stringify(value))
    }
  })

  it('超长标签被截到上限（上限是我们定的，手册未说明）', () => {
    const long = 'x'.repeat(SAMPLE_LABEL_MAX_LENGTH + 40)
    assert.equal(normaliseSampleLabel(long)?.length, SAMPLE_LABEL_MAX_LENGTH)
  })
})

describe('样本标签：来源必须被记住', () => {
  it('设备位图给的是**弱标签**，用稳定键而不是界面文案', () => {
    const label = weakLabelFromAlarmTypes([AlarmType.CoronaDischarge])
    assert.deepEqual(label, { text: 'corona_discharge', source: 'device' })
  })

  it('多个位同时置位时只取**主位**（最低位），一个样本只有一个标签', () => {
    const label = weakLabelFromAlarmTypes([AlarmType.SPL, AlarmType.CoronaDischarge])
    assert.equal(label?.text, 'spl')
    assert.equal(label?.source, 'device')
  })

  it('没有位就没有标签（不是空标签）', () => {
    assert.equal(weakLabelFromAlarmTypes([]), undefined)
  })

  it('设备原因文本**原样**存（只做归一化），不映射到我们自己的类别', () => {
    // 手册那 8 条里有一条重复、而且明确不是完整清单，所以不认识的类别保持未知。
    const label = weakLabelFromReason('时域能量比超限，')
    assert.deepEqual(label, { text: '时域能量比超限', source: 'device' })
  })

  it('人工标注与 AI 建议分开记：前者是真值，后者是候选', () => {
    assert.deepEqual(humanLabel('电晕放电'), { text: '电晕放电', source: 'human' })
    assert.deepEqual(aiLabel('电晕放电'), { text: '电晕放电', source: 'ai' })
    assert.equal(humanLabel(''), undefined)
    assert.equal(aiLabel(undefined), undefined)
  })
})

describe('特征向量', () => {
  it('长度恒定（7 维，与 FA8 /features_stream 的 7 个特征一一对应）', () => {
    assert.equal(featureVector({}).length, 7)
    assert.equal(featureVector({ spl: 1 }).length, 7)
  })

  it('维度顺序稳定：下标 0 是声压级', () => {
    const vector = featureVector({ spl: 11, mainFrequency: 22 })
    assert.equal(vector[0], 11)
    assert.equal(vector[1], 22)
  })

  it('缺失的维度是 NaN 而不是 0（补 0 等于编造一个测到的值）', () => {
    const vector = featureVector({ spl: 11 })
    assert.equal(Number.isNaN(vector[2] as number), true)
    assert.notEqual(vector[2], 0)
  })

  it('NaN / Infinity / 非数字都不算测到了', () => {
    const vector = featureVector({ spl: Number.NaN, mainFrequency: Number.POSITIVE_INFINITY })
    assert.equal(Number.isNaN(vector[0] as number), true)
    assert.equal(Number.isNaN(vector[1] as number), true)
  })
})

describe('能不能进训练集', () => {
  it('人工标签 + 四个必报维度齐 ⇒ 可以', () => {
    const verdict = isTrainable({ label: humanLabel('电晕放电'), metrics: FULL_METRICS })
    assert.deepEqual(verdict, { usable: true })
  })

  it('**设备弱标签默认不进训练集**（拿设备的判断去学设备的判断，指标会虚高）', () => {
    const verdict = isTrainable({ label: weakLabelFromReason('时域能量比超限'), metrics: FULL_METRICS })
    assert.equal(verdict.usable, false)
    assert.equal(verdict.reason, 'no-label')
  })

  it('AI 建议也不算真值', () => {
    assert.equal(isTrainable({ label: aiLabel('电晕放电'), metrics: FULL_METRICS }).usable, false)
  })

  it('未标注不能进训练集', () => {
    assert.equal(isTrainable({ metrics: FULL_METRICS }).reason, 'no-label')
  })

  it('缺必报维度时不可用，并且**说出缺了哪几维**', () => {
    const verdict = isTrainable({
      label: humanLabel('电晕放电'),
      metrics: { spl: 60, mainFrequency: 90 }
    })
    assert.equal(verdict.usable, false)
    assert.equal(verdict.reason, 'missing-metrics')
    assert.deepEqual(verdict.missing, ['smoothness', 'bandEnergyRatio'])
  })

  it('必报维度就是那四个，后三维（奇偶谐波比/频谱复杂度/声纹变化）不参与门槛', () => {
    assert.deepEqual(SAMPLE_TRAINING_MIN_METRICS, [
      'spl',
      'mainFrequency',
      'smoothness',
      'bandEnergyRatio'
    ])
    assert.equal(isTrainable({ label: humanLabel('x'), metrics: FULL_METRICS }).usable, true)
  })

  it('显式允许弱标签时设备标签可用，但 AI 建议仍然不行', () => {
    assert.equal(
      isTrainableWithWeakLabels({ label: weakLabelFromReason('时域能量比超限'), metrics: FULL_METRICS }),
      true
    )
    assert.equal(
      isTrainableWithWeakLabels({ label: aiLabel('电晕放电'), metrics: FULL_METRICS }),
      false
    )
    assert.equal(isTrainableWithWeakLabels({ metrics: FULL_METRICS }), false)
  })
})

describe('按类别计数（类别不平衡要能被看见）', () => {
  it('每个类别各几条', () => {
    const counts = countByLabel([
      { label: humanLabel('a'), metrics: FULL_METRICS },
      { label: humanLabel('a'), metrics: FULL_METRICS },
      { label: humanLabel('b'), metrics: FULL_METRICS }
    ])
    assert.deepEqual(counts, { a: 2, b: 1 })
  })

  it('未标注的样本不计入任何类别', () => {
    assert.deepEqual(countByLabel([{ metrics: FULL_METRICS }]), {})
  })
})
