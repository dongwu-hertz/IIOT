/**
 * 用**打了标签的样本**训练一个能跑的基线分类器（零依赖、零网络、纯函数）。
 *
 * ---------------------------------------------------------------------------
 * 为什么是"最近质心"而不是别的
 * ---------------------------------------------------------------------------
 * 业主的要求是「支持用打了标签的数据进行样本训练」。这条在这里被拆成两件必须分开的事：
 *
 *   1. **数据集**：标签 + 特征向量（`sample-library.ts` 负责它的诚实性）；
 *   2. **训练**：真的从数据里算出一个模型，而且**能给出可验证的指标**。
 *
 * 第 2 件用「最近质心」（nearest centroid）做基线，理由不是它最准，而是它**最诚实**：
 *   - 它没有超参数可以调，所以不存在"调出来的好看数字"；
 *   - 它在几十条样本上就能跑（深度模型在这个量级上只会过拟合，而报告出来的准确率会是噪声）；
 *   - 它可解释：每个类别就是一个中心点，判错的样本可以直接看出离哪个类更近；
 *   - 它零依赖、纯函数，**可单测**。
 *
 * 真正做二次训练（微调声学大模型）应该在**外部**流水线里做 —— 本仓库的职责是把带标签的
 * 数据集**准备好并导出**（`docs` 里那条路线），再给出一个可复现的基线作对照：
 * 「外部模型有没有比最近质心更好」是一个可以回答的问题；「我们的模型准不准」在没有
 * 外部真值集的时候是不可回答的。
 *
 * ---------------------------------------------------------------------------
 * 两条不让指标说谎的规矩
 * ---------------------------------------------------------------------------
 * - **先标准化再算距离**。7 个特征量纲差着几个数量级（声压 ~50–120，主频 ~10–60000），
 *   不标准化的话距离**几乎只由主频决定**，模型看起来能跑、其实只学了一维。标准化用训练集
 *   自己的均值/标准差（z-score）。
 * - **评估用留一法（leave-one-out）**。样本量是几十条量级，切一个 train/test 会让 test 只剩
 *   几条，准确率是抛硬币。留一法是"每条都当一次测试样本、其余训练"——在这个量级上这是唯一
 *   有意义的估计，而且它**不需要**随机数，结果可复现。
 *
 * 仍然**不会**好看的地方（必须一起报出来，否则指标就是骗人的）：类别不平衡、每类只有一两条、
 * 特征本身不区分这些类别。所以 `Evaluation` 里带了每类样本数与混淆矩阵，让调用方能把这两件事
 * 说出来，而不是只报一个 accuracy。
 */

/** 一条带标签的特征向量。`label` 是稳定标识（不是界面文案）。 */
export interface LabeledVector {
  label: string
  vector: number[]
}

/** z-score 标准化的参数，来自训练集本身。 */
export interface Standardiser {
  mean: number[]
  /** 标准差；某一维恒定时写 1（见 `fitStandardiser` 的说明）。 */
  stdDev: number[]
}

export interface Classifier {
  /** 类别，**按字典序**排列，这样混淆矩阵的行列顺序稳定、可复现。 */
  labels: string[]
  /** 每个类别在**标准化空间**里的中心点，与 `labels` 同序。 */
  centroids: number[][]
  standardiser: Standardiser
  /** 每个类别参加训练了几条 —— 类别不平衡的直接证据。 */
  counts: Record<string, number>
}

export interface Prediction {
  label: string
  /** 到该类中心的欧氏距离（标准化空间）。 */
  distance: number
  /** 第二名：与第一名的距离差不说明问题（两者接近时这个判定很弱），所以要能报出来。 */
  runnerUp?: { label: string; distance: number }
}

export interface Evaluation {
  total: number
  correct: number
  /** `correct / total`；`total === 0` 时是 0，不是 NaN。 */
  accuracy: number
  labels: string[]
  /** 混淆矩阵的非零项：`expected` 被预测成 `predicted` 的有几条。 */
  confusion: Array<{ expected: string; predicted: string; count: number }>
  /** 每个类别有几条被评过（与训练时的 `counts` 相同，便于对照）。 */
  counts: Record<string, number>
  /** 只有一个类别时**指标没有意义**（准确率恒为 1），这里如实标出来。 */
  degenerate: boolean
  /**
   * **留一法结构上评不了**的类别：每类样本数 < 2 的那些。
   *
   * 为什么必须单独报出来：留一法会把被评的那一条拿出训练集，所以一个只有 1 条样本的类别
   * 在被评自己时**在训练集里完全不存在**，判定必然落到别的类上 —— 准确率因此是 0，
   * 而这个 0 与"模型不行"**不是一回事**，它是"数据不够，这个方法在这里没有分辨率"。
   * 不把这件事说出来，用户会看到"准确率 0%"然后去怀疑一个其实没问题的模型。
   */
  unassessable: string[]
}

/** 向量必须长度一致、全为有限数。`NaN`（缺失维度）会让整条不可用 —— 缺失不许变成 0。 */
function isUsableVector(vector: readonly number[], length: number): boolean {
  if (vector.length !== length) return false
  return vector.every((value) => typeof value === 'number' && Number.isFinite(value))
}

/**
 * 用训练集拟合标准化参数（z-score）。
 *
 * 某一维的**标准差为 0**（例如所有样本的平滑度恰好相同）时写 1 而不是 0：写 0 会让
 * `standardise()` 里除零，`Infinity` 会把距离彻底毁掉；写 1 的语义是"这一维没有波动，
 * 标准化后仍是 0"，也就是**这一维对判定不起作用** —— 这正是它应有的效果。
 */
export function fitStandardiser(rows: readonly number[][]): Standardiser {
  if (rows.length === 0) return { mean: [], stdDev: [] }
  const width = rows[0]?.length ?? 0
  const mean: number[] = []
  const stdDev: number[] = []

  for (let index = 0; index < width; index += 1) {
    let sum = 0
    for (const row of rows) sum += row[index] as number
    const average = sum / rows.length
    let variance = 0
    for (const row of rows) {
      const delta = (row[index] as number) - average
      variance += delta * delta
    }
    const deviation = Math.sqrt(variance / rows.length)
    mean.push(average)
    stdDev.push(deviation > 0 ? deviation : 1)
  }

  return { mean, stdDev }
}

/** 按训练集的均值/标准差做 z-score。 */
export function standardise(vector: readonly number[], standardiser: Standardiser): number[] {
  return vector.map((value, index) => {
    const mean = standardiser.mean[index]
    const deviation = standardiser.stdDev[index]
    if (mean === undefined || deviation === undefined) return value
    return (value - mean) / deviation
  })
}

/**
 * 训练。
 *
 * 返回 `undefined` 的两种情形都**不抛异常**：一条可用样本都没有、或向量长度不一致。
 * 调用方（界面）拿到 `undefined` 就该显示"还没有可训练的数据"，而不是一个空模型的假指标。
 *
 * 向量长度以**第一条可用样本**为准；长度不同的样本被丢掉（不同设备/不同版本的特征维度
 * 可能不同，硬凑在一起算距离是没有意义的）。
 */
export function trainClassifier(rows: readonly LabeledVector[]): Classifier | undefined {
  const width = rows.find((row) => row.vector.length > 0)?.vector.length ?? 0
  if (width === 0) return undefined

  const usable = rows.filter((row) => row.label !== '' && isUsableVector(row.vector, width))
  if (usable.length === 0) return undefined

  const labels = [...new Set(usable.map((row) => row.label))].sort()
  const standardiser = fitStandardiser(usable.map((row) => [...row.vector]))

  const counts: Record<string, number> = {}
  const sums = new Map<string, number[]>()
  for (const row of usable) {
    counts[row.label] = (counts[row.label] ?? 0) + 1
    const running = sums.get(row.label) ?? new Array<number>(width).fill(0)
    const standardised = standardise(row.vector, standardiser)
    for (let index = 0; index < width; index += 1) {
      running[index] = (running[index] as number) + (standardised[index] as number)
    }
    sums.set(row.label, running)
  }

  const centroids = labels.map((label) => {
    const total = sums.get(label) ?? []
    const count = counts[label] ?? 1
    return total.map((value) => value / count)
  })

  return { labels, centroids, standardiser, counts }
}

function euclidean(left: readonly number[], right: readonly number[]): number {
  let sum = 0
  for (let index = 0; index < left.length; index += 1) {
    const delta = (left[index] as number) - (right[index] as number)
    sum += delta * delta
  }
  return Math.sqrt(sum)
}

/**
 * 判定一条样本属于哪一类。
 *
 * 向量不可用（长度不符或有缺失维）时返回 `undefined` —— **绝不**把缺失当成 0 去猜一个类别：
 * 在样本库里，"这条判不出来"比"判错但看起来很有信心"有价值得多。
 */
export function predict(classifier: Classifier, vector: readonly number[]): Prediction | undefined {
  const width = classifier.standardiser.mean.length
  if (!isUsableVector(vector, width)) return undefined

  const standardised = standardise(vector, classifier.standardiser)
  const scored = classifier.labels
    .map((label, index) => ({
      label,
      distance: euclidean(standardised, classifier.centroids[index] as number[])
    }))
    .sort((left, right) => left.distance - right.distance)

  const best = scored[0]
  if (best === undefined) return undefined
  const second = scored[1]
  return second === undefined
    ? { label: best.label, distance: best.distance }
    : { label: best.label, distance: best.distance, runnerUp: second }
}

/**
 * 留一法评估。
 *
 * 对每一条样本：把它自己**拿掉**再训练，然后用这个模型判它。这样任何一条都不会参与判定
 * 自己 —— 用同一条样本训练又测试得到的 100% 是自欺。
 *
 * 单类别的数据集返回 `degenerate: true`：那时每个判定都必然是那唯一一类，准确率恒为 1，
 * 这个数字**没有信息量**，界面必须把它说成"只有一个类别，无法评估"。
 */
export function evaluateLeaveOneOut(rows: readonly LabeledVector[]): Evaluation {
  const labels = [...new Set(rows.map((row) => row.label))].sort()
  const counts: Record<string, number> = {}
  for (const row of rows) counts[row.label] = (counts[row.label] ?? 0) + 1

  const confusion = new Map<string, number>()
  let correct = 0
  let evaluated = 0

  for (let index = 0; index < rows.length; index += 1) {
    const held = rows[index] as LabeledVector
    const rest = rows.filter((_, position) => position !== index)
    const classifier = trainClassifier(rest)
    if (!classifier) continue
    const prediction = predict(classifier, held.vector)
    if (!prediction) continue
    evaluated += 1
    const key = `${held.label}\u0000${prediction.label}`
    confusion.set(key, (confusion.get(key) ?? 0) + 1)
    if (prediction.label === held.label) correct += 1
  }

  return {
    total: evaluated,
    correct,
    accuracy: evaluated === 0 ? 0 : correct / evaluated,
    labels,
    confusion: [...confusion.entries()].map(([key, count]) => {
      const [expected = '', predicted = ''] = key.split('\u0000')
      return { expected, predicted, count }
    }),
    counts,
    degenerate: labels.length < 2,
    // 每类只有 1 条 ⇒ 留一法评到它时它在训练集里根本不存在（见 `unassessable` 的说明）。
    unassessable: labels.filter((label) => (counts[label] ?? 0) < 2)
  }
}
