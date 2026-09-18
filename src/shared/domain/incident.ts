/**
 * Incident（规格 §2.1 / §13.2 / §14.2）——领域规则、视图模型与"建议卡"的判据。
 *
 * ---------------------------------------------------------------------------
 * 这一轮（Phase 6 后半）只做规格 §14.2 的 **V1**：人工 Create Incident + 手动关联 Alert
 * ---------------------------------------------------------------------------
 * 规格把 Incident 用一句话定义清楚（"一个现实世界问题，可关联多个 Alert / 多个设备 /
 * 多种传感器"），但**没有**给它任何生命周期：§2.2 的状态机是给 **Alert** 的，Incident 没有
 * 状态、没有严重度、没有负责人、没有关闭条件。所以这一份里也**不造**那套东西 ——
 * 造一个规格没说过的生命周期，就会在界面长出一堆"我们自己的概念"，而业主验收时无从对照。
 * 取舍写在 `docs/EVENT-CENTER.md` §3.16。
 *
 * V2（规则型关联：same asset + time window + cross-sensor）与 V3（AI 建议 + confidence）
 * 这一轮**不做**：我们连 asset 这一层都没有（设备就是我们的资产），跨传感器规则需要
 * DTS/DAS/DGA 那几类设备（我们一台都不管，见 `docs/EVENT-CENTER.md` §3.1）。
 *
 * 另：规格 §8.2 的 KPI 例子里有一格 `Incidents 5`，并要求所有 KPI 可点击、点击转成筛选。
 * 我们**不加**那一格 —— Incident 按 V1 只有人工创建、没有关闭/解决（规格未定义），那个数字
 * 只增不减，而同一段 §8.2 末尾明确写着不要拿"总量"当主要 KPI。理由记在
 * `docs/EVENT-CENTER.md` §3.17。
 *
 * 这里**没有 i18n**：只产出目录键与纯数据，翻译由渲染层做。
 */

import type { RelatedGroup, RelatedGroupId } from './event-view'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 标题长度上限。
 *
 * 为什么是 120：它是**我们自己定的**（规格没写长度）。理由与仓库里其它"人写的短文本"一致 ——
 * 一句话能说清的现实问题不会超过两行，而面板宽度只够一行多一点；再长就该进备注。
 * 上限存在的真正目的不是省空间，是**让超长输入被明确拒绝**（而不是被悄悄截断）。
 */
export const INCIDENT_TITLE_MAX_LENGTH = 120

/** 备注长度上限（同样是我们的取值，理由同上；备注装得下现场描述）。 */
export const INCIDENT_NOTE_MAX_LENGTH = 500

/**
 * 「潜在关联 Incident」建议卡出现的**阈值**：同一条链上至少要有这么多条 Alert（含当前这条）。
 *
 * 规格 §13.2 的原话是"当相关性达到阈值时显示"，但**阈值本身手册未说明**。我们取 **2**：
 * 一条 Alert 孤零零的时候无话可说（"建议把这一条关联成一个事件"没有信息量），而只要同设备
 * 上还有第二条，就已经构成"一台设备上出了不止一件事"这个值得记下来的事实。取更大的值会让
 * 这条入口在只有两三台设备的现场永远不出现 —— 而那正是我们现场的规模。
 */
export const INCIDENT_SUGGESTION_MIN_ALERTS = 2

/**
 * 建议卡依据的那一组相关性。
 *
 * 用 **same-device**（规格 §13.2 的 Same device）：一个 Incident 是"一台设备上的现实问题"，
 * 而我们的数据里唯一稳定、可解释的分组维度就是设备（没有 asset 层，跨设备的"邻近"要靠坐标，
 * 而坐标是人工录的、多数设备是空的）。
 */
export const INCIDENT_SUGGESTION_GROUP: RelatedGroupId = 'same-device'

// ---------------------------------------------------------------------------
// 草稿校验
// ---------------------------------------------------------------------------

export type IncidentDraftReason = 'title-required' | 'title-too-long' | 'note-too-long'

export interface IncidentDraft {
  title: string
  note?: string
}

export type IncidentDraftResult =
  | { ok: true; draft: IncidentDraft }
  | { ok: false; reason: IncidentDraftReason }

/**
 * 校验一份"人写的"Incident 草稿（创建对话框与主进程**共用**这一处）。
 *
 * 为什么放在共享层而不是对话框里自己判：对话框判一次、主进程再判一次的两份规则迟早分叉，
 * 而这两处的判据不一样的时候，表现是"界面说可以、点下去被拒绝"。
 */
export function validateIncidentDraft(input: { title: unknown; note?: unknown }): IncidentDraftResult {
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (title === '') return { ok: false, reason: 'title-required' }
  if (title.length > INCIDENT_TITLE_MAX_LENGTH) return { ok: false, reason: 'title-too-long' }

  const rawNote = typeof input.note === 'string' ? input.note.trim() : ''
  if (rawNote.length > INCIDENT_NOTE_MAX_LENGTH) return { ok: false, reason: 'note-too-long' }

  return { ok: true, draft: rawNote === '' ? { title } : { title, note: rawNote } }
}

// ---------------------------------------------------------------------------
// 视图模型
// ---------------------------------------------------------------------------

/** 一个 Incident 在界面上的样子。 */
export interface IncidentView {
  id: string
  title: string
  note?: string
  createdAt: number
  createdBy: string
  /** 关联了几条 Alert（含聚合组的成员？不含 —— 关联的是**条目 id**，一条就是一条）。 */
  alertCount: number
}

/** 一条"Alert 属于哪个 Incident"的关联（仓储层的行）。 */
export interface IncidentLinkView {
  incidentId: string
  entryId: string
  linkedAt: number
  linkedBy: string
}

/** 界面按"新的在前"看 Incident（与 Activity 同一口径）。 */
export function sortIncidentsDesc(items: readonly IncidentView[]): IncidentView[] {
  return [...items].sort((left, right) => right.createdAt - left.createdAt)
}

/** 一条 Alert 的关联情况（详情抽屉的「关联」页签用这一个对象说明白）。 */
export interface IncidentLinkState {
  /** 这一条已经属于哪些 Incident（新的在前）。 */
  linked: IncidentView[]
  /** 建议卡：够阈值才有（见 `INCIDENT_SUGGESTION_MIN_ALERTS`）。 */
  suggestion?: IncidentSuggestion
}

/** 建议关联的那一组（含当前这一条）。 */
export interface IncidentSuggestion {
  /** 依据哪一组相关性（目前只有 `same-device`）。 */
  groupId: RelatedGroupId
  /**
   * 建议关联的 entry id，**含当前这一条**，按相关性分组里的顺序（新的在前）。
   *
   * 界面用它当"创建时一并关联"的初值；操作员可以在对话框里去掉某几条 ——
   * 规格 §13.2 明说"不自动替用户关闭/合并"，所以建议只是初值，不是结果。
   */
  entryIds: string[]
  alertCount: number
}

/**
 * 从相关性分组里算出建议（纯函数，界面与测试共用一处判据）。
 *
 * 注意这里**不做任何写操作、也不改任何状态**：它只回答"要不要给操作员看一眼这个建议"。
 */
export function incidentSuggestion(
  current: { id: string },
  groups: readonly RelatedGroup[]
): IncidentSuggestion | undefined {
  const group = groups.find((item) => item.id === INCIDENT_SUGGESTION_GROUP)
  if (!group) return undefined
  const entryIds = [current.id, ...group.ids]
  if (entryIds.length < INCIDENT_SUGGESTION_MIN_ALERTS) return undefined
  return { groupId: group.id, entryIds, alertCount: entryIds.length }
}

/**
 * 建议的标题（目录键 + 参数）。
 *
 * 规格 §14.2 的例子是 `Transformer T03 abnormal condition` —— 设备名 + 一句"异常情况"。
 * 我们没有 asset 名，所以用设备名；这不是"猜问题是什么"，只是一个能被改掉的初值。
 * 真正的句子在渲染层（`eventsUi.incidentSuggestedTitle`），这里只给参数。
 */
export function incidentSuggestedTitleParams(deviceName: string): { device: string } {
  return { device: deviceName.trim() === '' ? '—' : deviceName.trim() }
}
