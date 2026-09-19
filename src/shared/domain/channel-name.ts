/**
 * 通道重命名的输入判定（业主 2026-09-19 第 13 批第 4 条）。
 *
 * 业主原话：「历史趋势：声纹场景选设备后右侧列出 8 或 2 个通道 CH1…支持重命名、
 * 无数据灰显、有数据可勾选」。
 *
 * 名字写到哪里去（这一条是**关键**，不能自己发明一个"本地别名"）
 *   设备手册给了 `/set_passageway`，`chinfoArray.dchName` 就是通道名 ——
 *   本仓库既有的 `config.updateChannel(deviceId, index, { name })` 走的正是这条路，
 *   而且它是**写后读回**核对过的（`ConfigService.updateChannel()` 末尾重新 `getChannels()`）。
 *   真机取证记录（`docs/PROTOCOL-FINDINGS.md` §7）还写明了"改名后其余 7 行逐字节不变"。
 *   所以「重命名」= 走既有那条设备写路径，**不**新建本地别名表：另存一份会让"设备上叫什么"
 *   与"我们显示叫什么"两个事实长期不一致，而这种不一致最后一定由操作员来发现。
 *
 * 为什么判定要做成纯函数
 *   这一条有三个必须能逐条钉死的边界（空名 / 太长 / 没改），而它们都属于"不该写设备"：
 *   写一次设备要占用一条连接、还可能被设备拒绝。判定放在这里，界面与测试调同一个它。
 *
 * **手册未说明**：手册没有给通道名的长度上限（`/set_passageway` 那一节只列了字段），
 * 所以 `CHANNEL_NAME_MAX_LENGTH` 是**本仓库自己的取值**，不是设备的事实 ——
 * 取 32 是因为设备自己的默认名（"通道 1" 之类）与常见现场命名（"1#机组轴承"）都远在它之下，
 * 而这个上限只是**不把明显不合理的输入发出去**，设备若另有更严的限制，它的拒绝会照原样显示。
 */

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

/**
 * 通道名的长度上限（**本仓库自己的设计**，手册未说明，见文件头）。
 *
 * 按 UTF-16 码元计（`String.prototype.length`），与输入框的 `maxlength` 同一把尺子 ——
 * 两处用不同的尺子会出现"界面允许输入、提交时又说太长"。
 */
export const CHANNEL_NAME_MAX_LENGTH = 32

/** 判定失败的原因（界面照它取词条，本模块不 import vue-i18n）。 */
export type ChannelNameProblem = 'empty' | 'too-long' | 'unchanged'

export type ChannelNameVerdict =
  | { ok: true; value: string }
  | { ok: false; problem: ChannelNameProblem }

/**
 * 把用户输入变成"能不能写"的结论。
 *
 * 三条规则，顺序就是这个函数的全部内容：
 *   1. 去掉首尾空白之后为空 —— `ConfigService.updateChannel()` 那边也会拒（设备侧没有匿名通道名），
 *      但在这里拒可以**一次都不发**；
 *   2. 超过 `CHANNEL_NAME_MAX_LENGTH` —— 见文件头（本仓库的设计）；
 *   3. 与当前名字**完全相同**（比较的也是去掉首尾空白之后的）—— 没改就不要写设备：
 *      写一次是"读全部通道 → 合并 → 写回 → 再读回"，为一次无变化的操作付这个代价不合适，
 *      而且它会真的动到设备上的那一行。
 */
export function normaliseChannelName(raw: string, current: string): ChannelNameVerdict {
  const value = raw.trim()
  if (value === '') return { ok: false, problem: 'empty' }
  if (value.length > CHANNEL_NAME_MAX_LENGTH) return { ok: false, problem: 'too-long' }
  if (value === current.trim()) return { ok: false, problem: 'unchanged' }
  return { ok: true, value }
}

/**
 * 判定失败 → 词条后缀（`trendsUi.channelNameError_<suffix>`）。
 *
 * 导出而不是在组件里再写一份 `if/else`：给 `ChannelNameProblem` 加一个成员时，
 * TypeScript 会强制这里补齐，界面也就不可能出现"某个原因下没有话说"。
 */
export const CHANNEL_NAME_PROBLEM_KEYS: Record<ChannelNameProblem, string> = {
  empty: 'trendsUi.channelNameError_empty',
  'too-long': 'trendsUi.channelNameError_tooLong',
  unchanged: 'trendsUi.channelNameError_unchanged'
}
