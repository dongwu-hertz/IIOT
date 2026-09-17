/**
 * 用打了标签的样本训练基线分类器（`shared/domain/sample-classifier.ts`）。
 *
 * 这一组断言要守住两件事，它们都是「指标会不会说谎」的问题：
 *   1. **标准化真的在起作用**：7 个特征量纲差几个数量级，不标准化的话距离几乎只由主频决定 ——
 *      这里用一组"只在小平量纲那一维上有区别"的数据把它钉住；
 *   2. **评估不许自欺**：留一法（每条都不参与判定自己），单类别数据集如实标成 `degenerate`
 *      （准确率恒为 1，没有信息量）。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  evaluateLeaveOneOut,
  fitStandardiser,
  predict,
  standardise,
  trainClassifier,
  type LabeledVector
} from '../src/shared/domain/sample-classifier'

/** 两组只在第 3 维（平滑度，小量纲）上分开、第 1 维（主频，大量纲）完全相同的数据。 */
const SMOOTHNESS_ONLY: LabeledVector[] = [
  { label: 'quiet', vector: [60, 50_000, 1.0, 0.5, 1, 1, 1] },
  { label: 'quiet', vector: [61, 50_000, 1.1, 0.5, 1, 1, 1] },
  { label: 'loud', vector: [60, 50_000, 4.0, 0.5, 1, 1, 1] },
  { label: 'loud', vector: [61, 50_000, 4.2, 0.5, 1, 1, 1] }
]

describe('标准化', () => {
  it('均值与标准差按训练集算', () => {
    const standardiser = fitStandardiser([
      [1, 10],
      [3, 30]
    ])
    assert.deepEqual(standardiser.mean, [2, 20])
    assert.ok(Math.abs((standardiser.stdDev[0] as number) - 1) < 1e-12)
    assert.ok(Math.abs((standardiser.stdDev[1] as number) - 10) < 1e-12)
  })

  it('某一维恒定（标准差 0）时写 1 而不是 0：写 0 会除零、把距离毁成 Infinity', () => {
    const standardiser = fitStandardiser([
      [5, 1],
      [5, 3]
    ])
    assert.equal(standardiser.stdDev[0], 1)
    const standardised = standardise([5, 2], standardiser)
    assert.deepEqual(standardised, [0, 0])
    assert.ok(standardised.every((value) => Number.isFinite(value)))
  })

  it('z-score：均值处为 0，偏离一个标准差为 ±1', () => {
    const standardiser = fitStandardiser([
      [0, 0],
      [2, 2]
    ])
    assert.deepEqual(standardise([1, 1], standardiser), [0, 0])
    assert.deepEqual(standardise([2, 0], standardiser), [1, -1])
  })
})

describe('训练', () => {
  it('空数据集没有模型（返回 undefined，不抛异常、也不给一个空模型的假指标）', () => {
    assert.equal(trainClassifier([]), undefined)
    assert.equal(trainClassifier([{ label: 'a', vector: [] }]), undefined)
  })

  it('全是坏向量时没有模型', () => {
    assert.equal(
      trainClassifier([{ label: 'a', vector: [Number.NaN, 1] }]),
      undefined
    )
  })

  it('类别按字典序排列（混淆矩阵的行列顺序必须可复现）', () => {
    const classifier = trainClassifier([
      { label: 'z', vector: [1, 1] },
      { label: 'a', vector: [2, 2] },
      { label: 'm', vector: [3, 3] }
    ])
    assert.deepEqual(classifier?.labels, ['a', 'm', 'z'])
  })

  it('每类样本数被记下来（类别不平衡的直接证据）', () => {
    const classifier = trainClassifier([
      { label: 'a', vector: [1, 1] },
      { label: 'a', vector: [1.2, 1.2] },
      { label: 'b', vector: [5, 5] }
    ])
    assert.deepEqual(classifier?.counts, { a: 2, b: 1 })
  })

  it('中心点落在该类的均值上（标准化空间里）', () => {
    const rows: LabeledVector[] = [
      { label: 'a', vector: [0, 0] },
      { label: 'a', vector: [2, 2] },
      { label: 'b', vector: [10, 10] }
    ]
    const classifier = trainClassifier(rows)
    assert.ok(classifier)
    // 独立算一遍期望值：用同一套标准化参数把该类的向量标准化后取均值。
    // （注意它**不是** 0：标准化用的是全体的均值，不是这一类的均值。）
    const members = rows.filter((row) => row.label === 'a').map((row) => row.vector)
    const expected = [0, 1].map((dimension) => {
      const values = members.map(
        (vector) => ((vector[dimension] as number) - (classifier.standardiser.mean[dimension] as number)) /
          (classifier.standardiser.stdDev[dimension] as number)
      )
      return values.reduce((sum, value) => sum + value, 0) / values.length
    })
    const aIndex = classifier.labels.indexOf('a')
    assert.ok(aIndex >= 0)
    const centroid = classifier.centroids[aIndex] ?? []
    centroid.forEach((value, dimension) => {
      assert.ok(Math.abs(value - (expected[dimension] as number)) < 1e-12, `第 ${dimension} 维`)
    })
  })

  it('向量长度不同的样本被丢掉（不同特征维度硬凑在一起算距离没有意义）', () => {
    const classifier = trainClassifier([
      { label: 'a', vector: [1, 1, 1] },
      { label: 'b', vector: [5, 5] }
    ])
    assert.deepEqual(classifier?.labels, ['a'])
  })
})

describe('判定', () => {
  it('能分出只在**小平量纲**那一维上有区别的两类（这就是标准化的作用）', () => {
    const classifier = trainClassifier(SMOOTHNESS_ONLY)
    assert.ok(classifier)
    // 主频恒为 50000、平滑度 1.05 -> quiet；平滑度 4.1 -> loud。
    assert.equal(predict(classifier, [60, 50_000, 1.05, 0.5, 1, 1, 1])?.label, 'quiet')
    assert.equal(predict(classifier, [60, 50_000, 4.1, 0.5, 1, 1, 1])?.label, 'loud')
  })

  it('给出第二名：第一名和第二名很接近时这个判定本身很弱，调用方要知道', () => {
    const classifier = trainClassifier(SMOOTHNESS_ONLY)
    assert.ok(classifier)
    const prediction = predict(classifier, [60, 50_000, 2.5, 0.5, 1, 1, 1])
    assert.ok(prediction?.runnerUp)
    assert.notEqual(prediction?.label, prediction?.runnerUp?.label)
  })

  it('缺失维度（NaN）判不出来 —— 不把缺失当 0 去猜一个类别', () => {
    const classifier = trainClassifier(SMOOTHNESS_ONLY)
    assert.ok(classifier)
    assert.equal(predict(classifier, [60, 50_000, Number.NaN, 0.5, 1, 1, 1]), undefined)
  })

  it('长度不符也判不出来', () => {
    const classifier = trainClassifier(SMOOTHNESS_ONLY)
    assert.ok(classifier)
    assert.equal(predict(classifier, [60, 50_000]), undefined)
    assert.equal(predict(classifier, [60, 50_000, 1, 0.5, 1, 1, 1, 9]), undefined)
  })
})

describe('留一法评估', () => {
  it('完全分得开的数据：准确率 1，且每条都真的被评过', () => {
    const evaluation = evaluateLeaveOneOut(SMOOTHNESS_ONLY)
    assert.equal(evaluation.total, 4)
    assert.equal(evaluation.correct, 4)
    assert.equal(evaluation.accuracy, 1)
    assert.equal(evaluation.degenerate, false)
    // 混淆矩阵只有对角线。
    assert.ok(evaluation.confusion.every((entry) => entry.expected === entry.predicted))
  })

  it('故意标错一条：准确率下降，而且混淆矩阵指得出是哪一类被误判成哪一类', () => {
    // 每类都给两条以上：留一法才有分辨率（每类只有一条时它结构上评不了，见下一条）。
    const rows: LabeledVector[] = [
      { label: 'a', vector: [0, 0] },
      { label: 'a', vector: [0.1, 0.1] },
      { label: 'b', vector: [10, 10] },
      { label: 'b', vector: [10.1, 10.1] },
      // 这一条的特征是 b 的样子，却标成 a —— 数据集里的脏样本。
      { label: 'a', vector: [10.2, 10.2] }
    ]
    const evaluation = evaluateLeaveOneOut(rows)
    assert.equal(evaluation.total, 5)
    assert.equal(evaluation.correct, 4)
    const wrong = evaluation.confusion.filter((entry) => entry.expected !== entry.predicted)
    assert.deepEqual(wrong, [{ expected: 'a', predicted: 'b', count: 1 }])
    assert.deepEqual(evaluation.unassessable, [])
  })

  it('只有一个类别时如实标成 degenerate：准确率恒为 1，这个数字没有信息量', () => {
    const evaluation = evaluateLeaveOneOut([
      { label: 'only', vector: [1, 1] },
      { label: 'only', vector: [1.1, 1.1] }
    ])
    assert.equal(evaluation.degenerate, true)
    assert.equal(evaluation.accuracy, 1)
    assert.deepEqual(evaluation.labels, ['only'])
  })

  it('空数据集：不产生 NaN 指标', () => {
    const evaluation = evaluateLeaveOneOut([])
    assert.equal(evaluation.total, 0)
    assert.equal(evaluation.accuracy, 0)
    assert.ok(Number.isFinite(evaluation.accuracy))
  })

  it('**每类只有一条时留一法结构上评不了**：准确率必然是 0，而这不是"模型不行"', () => {
    const evaluation = evaluateLeaveOneOut([
      { label: 'a', vector: [0, 0] },
      { label: 'b', vector: [10, 10] }
    ])
    // 每条被评时，它自己那一类在训练集里**一条都不剩**，判定只能落到别的类上。
    assert.equal(evaluation.total, 2)
    assert.equal(evaluation.correct, 0)
    assert.equal(evaluation.accuracy, 0)
    // 所以这件事必须被**单独报出来**，否则用户会看到 0% 去怀疑一个没问题的模型。
    assert.deepEqual(evaluation.unassessable, ['a', 'b'])
  })
})
