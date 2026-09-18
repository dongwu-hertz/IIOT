# Event & Alarm Center 改造：规格落地表（对照 `HERTZINNO_Event_Alarm_Center_UX_UI_Spec_V1.0`）

> 规格原件：`docs/reference/event-alarm-center-spec-v1.txt`（由业主 2026-09-17 提供的 .docx 抽出，
> 重新生成：`node scripts/docx-to-text.cjs <input.docx> docs/reference/event-alarm-center-spec-v1.txt`）。
>
> 本文档回答三件事：**规格每一节要求什么 / 我们现在是什么样 / 这一轮做到哪一步**。
> 与产品现实冲突的地方在第 3 节逐条列出，并写明我们的做法（这些是我们的判断，不是规格说的）。

---

## 1. 规格要求 vs 我们的现状（逐节）

| 规格 | 要求 | 我们的现状 | 这一轮 |
|---|---|---|---|
| §2.2 状态机 | New → Acknowledged → Investigating → Resolved → Closed（+ Muted / Reassigned / Reopened） | 只有 `alarms.acknowledged`（二值）+ 备注 + 等级 | Phase 5（要加列/表：状态、指派人、Activity 流）。Phase 3 已把状态**类型**与标签做出来（`AlertStatus` / `eventsUi.alertStatus.*`），界面只会显示 New / Acknowledged 两个 —— 其余三个没有数据来源，所以不渲染 |
| §2.3 严重度 | 五级 Critical/High/Medium/Low/Info + 指定色 | 四级 `info/warning/critical/unknown`（DB CHECK 钉死） | **Phase 1 加了颜色 token；Phase 3 加了展示层适配器**（`toAlertViewModel`，我们的 `warning` → 界面「高」，`unknown` → 「等级未知」而不是装成 Info，见 3.6）。值域改五级仍属 Phase 5（迁移 v13 + 旧数据映射） |
| §3.2/§3.3 侧栏 | 232 / 64 可折叠、180–220ms、3px 橙色选中竖条、偏好本地保存 | 固定 216px、2px 竖条、无折叠 | **✅ Phase 2 做完**（偏好存 localStorage） |
| §4.1 布局 | 1440×900 基准；内容内边距 24（≥1600 用 32）；Filter 216 / Drawer 400–560 | 三栏中的 Filter 栏 | **Filter 216 已做（Phase 3）**；Drawer 400–560 属 Phase 4（token 已就位） |
| §5 字体排版 | Inter / Noto Sans SC；11–24px 的九档字号 | 系统字体栈；字号在各组件里写死 | **token 已加**（§2 对照表）；Phase 3 的三个新组件全部用 token |
| §6 颜色 | 品牌/中性/严重度全套 hex | 自有 token（值略有差异） | **✅ 取值已对齐**（含新增严重度五级、页面底色、hover、tertiary/disabled、accent-active/light/strong） |
| §7 间距/圆角/阴影 | 4px 网格（我们已有）；输入/按钮 6px、卡片 8px、Modal 10px；面板靠 1px 边框 | 4px 网格已有；输入/按钮 8px、卡片 12px | **✅ 已改**（`.btn`/`.input`/`.chip` 6px、`.card` 8px、按钮 28px、输入框 36px） |
| §8.1 页头 | 标题 24/32/600 + 副标题 + 右侧只有时间范围/自动刷新 | 顶栏已有页面名；页内无标题（产品曾要求删） | **冲突，见 3.2**（Phase 3 保持无页内标题） |
| §8.2 KPI 条 | 五个可点 KPI（点后转筛选，不跳页） | 顶栏三个指示器（设备数/在线/未确认告警） | **✅ Phase 3 做了四格**（严重/高/未确认/平均确认耗时）+ 点一下转筛选；「聚合事件」属 Phase 6，所以没有那一格（见 3.7） |
| §9 筛选 | 搜索 260–320px、六个下拉、Chippy 激活态、Saved Views、URL 同步 | 筛选栏（设备/等级/时间等） | **✅ Phase 3**：搜索（260–320px）+ 左侧四组带计数面板 + 六个内置视图 + URL/localStorage 记忆。关键字只在已加载页内搜（见 3.8），"六个下拉"变成"面板四组 + 时间两个"（见 3.9） |
| §10 告警队列 | 88–104px 行、3px 左竖条、三种视图模式（Compact/Standard/Evidence）、偏好保留 | 表格行（`.table`） | **✅ Phase 3**：表格 → 队列行（56/88/104 三档、3px 严重度色条、键盘 ↑/↓）；Evidence 模式没有缩略图（见 3.10） |
| §11 详情抽屉 | 400/440/560 可拖、不跳页、Esc 关闭、↑↓ 切条、五页签 | 右侧覆盖层抽屉（滚动分区，无页签、无宽度拖拽、宽度写死 480） | **✅ Phase 4**：400–560 可拖（拖拽 + 键盘 ←→，偏好 localStorage）、默认 400（≥1600 用 440）、不跳页、Esc 关、↑/↓ 与 J/K 换条（只在焦点位于抽屉内时接管）、页签条只渲染**已实现**的两个（Timeline/Related/Activity 属 Phase 5） |
| §12 Evidence | 按 sensorType 分渲染器（Acoustic / DTS / DAS / DGA）、统一容器 | 相机检测结果、本机录音、PRPD/频谱在别的页面 | **✅ Phase 4 做了 Acoustic 一个渲染器**：图片证据（联动抓帧 / 声纹告警的球机抓图）+ 录音录像 + 指标（频谱与测量）+ 检测结果文件；链接按来源选路（`evidenceImageSource`）。DTS/DAS/DGA **不做**（**冲突**：见 3.1）。每一条事件只有**一张**图（见 3.10） |
| §13 Timeline/Related/Activity | 三块：时间线、相关性分组、活动流 | 无（有告警联动动作列表） | Phase 5（Activity 需要落库） |
| §14 聚合与 Incident | occurrenceCount / first-last / duration；人工 Create Incident | 无（每条告警一行、无聚合、无 Incident） | Phase 6（**冲突**：见 3.3）。Phase 3 的视图模型已带 `occurrenceCount`（恒为 1，界面在 1 时不渲染 ×N） |
| §15 交互与可用性 | 选中不跳页、Ack 不关抽屉、键盘、焦点环、时区 | 部分符合（焦点环本轮统一为 `--focus-ring`） | Phase 3 已做：点行不跳页、↑/↓ 选中并同步焦点、Esc 关抽屉、行与筛选项都有焦点环 |
| §16 组件树/Store/ViewModel | EventCenterPage → KPI/Filter/Queue/Drawer … | `EventCenterView.vue` 单文件 + `stores/eventCenter.ts` | Phase 3 拆出 `EventKpiStrip` / `EventFilterPanel` / `AlertQueue` 与纯函数层 `shared/domain/event-view.ts`（`AlertViewModel` 适配器），见第 4 节 |
| §17 Design Tokens | 一套 `--hz-*` 等 token，禁止组件里硬编码 | 已有 token 体系（组件里不写 hex） | **✅ 取值与清单已对齐**，对照表见 §2；Phase 3 新增 `.severity--<档>` 变量类（一个类给出强调色与软底色） |
| §18.1 Phase 1–6 | 六个阶段 | — | 见第 4 节进度 |

---

## 2. Token 对照表（规格 §17 → 我们的 token）

规格用 `--hz-*` / `--bg-*` / `--severity-*` 这套名字。我们**不改名**（仓库从第一版起就是
"只有 `main.css` 写颜色"，改名会动几十个文件却没有任何可见收益），只做两件事：
**取值对齐** + **补齐缺的**。下表左边是规格的名字，右边是我们实际用的。

| 规格 §17 | 我们的 token | 值 |
|---|---|---|
| `--hz-primary` | `--color-accent` | #FF6A1A |
| `--hz-primary-hover` | `--color-accent-hover` | #EA5A0B |
| `--hz-primary-active` | `--color-accent-active`（新） | #CC4B00 |
| `--hz-primary-light` | `--color-accent-light`（新） | #FFF4EC |
| （§3.3 选中文字） | `--color-accent-strong`（新） | #E65300 |
| `--bg-page` | `--color-bg-page`（新） | #F7F8FA |
| `--bg-panel` | `--color-bg` | #FFFFFF |
| `--bg-hover` | `--color-bg-hover`（新） | #F9FAFB |
| `--text-primary` | `--color-text` | #101828 |
| `--text-secondary` | `--color-text-secondary` | #475467 |
| `--text-tertiary` | `--color-text-tertiary`（新） | #667085 |
| `--text-disabled` | `--color-text-disabled`（新） | #98A2B3 |
| `--border-default` | `--color-border` | #E4E7EC |
| `--border-strong` | `--color-border-strong` | #D0D5DD |
| `--severity-critical` / `…-bg` | `--color-severity-critical` / `-soft`（新） | #B42318 / #FEF3F2 |
| `--severity-high` / `-bg` | `--color-severity-high` / `-soft`（新） | #F04438 / #FFF4F2 |
| `--severity-medium` / `-bg` | `--color-severity-medium` / `-soft`（新） | #F79009 / #FFFAEB |
| `--severity-low` / `-bg` | `--color-severity-low` / `-soft`（新） | #2E90FA / #EFF8FF |
| （Info） | `--color-severity-info` / `-soft`（新） | #667085 / #F2F4F7 |
| `--status-success` | `--color-success` | #12B76A |
| `--radius-input/-button` | `--radius-sm` | 6px（原 8px） |
| `--radius-card` | `--radius-card`（新） | 8px（`.card` 原 12px） |
| `--radius-modal` | `--radius-md` | 10px |
| `--space-1…12` | `--space-1…6`（已有 4/8/12/16/20/24） | 4px 网格 |
| `--sidebar-expanded` / `-collapsed` | `--sidebar-width` / `--sidebar-collapsed`（新） | 232 / 64 |
| `--header-height` | `--topbar-height` | 56px |
| `--filter-panel` / `--detail-panel` | `--filter-panel` / `--detail-panel`（新） | 216 / 400（+440 / 560） |
| `--control-height-sm/-md` | `--control-height-sm/-md`（新） | 28 / 36 |
| `--nav-row-height` | `--nav-row-height`（新） | 40 |
| `--event-row-min-height` / `padding` | `--event-row-*`（新） | 88 / 16 / 12 |
| `--focus-ring` | `--focus-ring`（新） | `0 0 0 2px rgba(255,106,26,.35)` |
| §5.2 九档字号 | `--font-size-*`（新） | 24/18/16/15/14/13/12/11 + 行高 |

**字号迁移的实话**：token 已经就位，但**既有组件里仍有写死的 `font-size`**（100+ 处）。
一次性全局换字号会把每一页的行高与换行都动一遍，而这一轮并不改那些页面 —— 所以规则是：
**新做/重做的界面一律用 token（有源码守卫钉住）**，旧组件在各自被重做时逐个换过来。

---

## 3. 与产品现实冲突的地方（我们的做法，不是规格说的）

### 3.1 DTS / DAS / DGA 的 Evidence 渲染器 —— 我们**不造**这些界面

规格 §12.2–§12.4 给了 DTS（分布式温度）、DAS（分布式声波）、DGA（油中气体）三种证据面板，
§18.2 的验收还要求"Acoustic / DTS / DAS / DGA 至少各有一个 demo renderer"。

我们**只做 Acoustic 那一个渲染器**（含声呐的球机抓图、相机检测结果、本机录音、
频谱/PRPD 这些我们**真的有数据**的东西），DTS/DAS/DGA 三个**不建**：
它们对应的产品我们现在一台都不管，做出来就是**没有数据来源的假面板** ——
那正是这个仓库一直拒绝的东西（"宁可这一屏少一块，也不画一张假的实时图"）。
Evidence 的**容器**按规格做成"按 `sensorType` 选渲染器"的形状，所以将来接了 DTS/DAS/DGA，
加一个 renderer 即可，不用改容器。

### 3.2 "页内标题 + 副标题" 与既有产品决定冲突

规格 §8.1 要页内标题（24px）与副标题，而业主在 2026-09-16 明确要求**删掉页内标题**
（"外层框架的标题栏已经写了当前页的名字"），仓库里还有一条源码守卫钉着它不许回来
（`tests/page-layout.test.ts`：`.page-title` 出现即失败）。

做法：**页内不加大标题**，把规格那一条翻译成"这一页的页头只放时间范围 + 自动刷新 + 更多"，
并用 KPI 条承担"一眼看懂现在什么状态"的职责。如果业主要求按规格加回页内标题，
那要同时撤掉 2026-09-16 那条要求与守卫 —— 这是一个产品决定，需要一句话。

### 3.3 Incident / 跨传感器关联 —— V1 先做**人工**，且只在本机告警范围内

规格 §14 的 Incident（一个现实问题关联多条 Alert）与"跨传感器关联"在我们的数据里
只有**声学一族**（声纹设备 / 相机 / 听诊盒子 / 声呐）。做法按规格自己给的优先级：
V1 只做**人工 Create Incident + 手动关联告警**（P2），不做规则型自动关联与 AI 建议（V2/V3），
且 Incident 的成员只来自我们**有的**那三种来源。

### 3.4 mock 数据 demo —— 不放进产品，只在探针里

规格 §18.3 要求"mock data 驱动的完整事件处置流程"。我们的产品**不带任何模拟数据**
（渲染层的业务数据全部来自真实设备与本机库），所以：**处置流程的演示由 GUI 探针用一台
假相机/假声呐 + 一次性 profile 跑**（`scripts/demo-shot-driver.cjs` 已经这么做了），
产品里不出现"演示模式"。这样"能跑通"这件事仍然可验证，而不会有人在现场把演示数据当真。

### 3.5 字体

规格建议 Inter / Noto Sans SC。渲染层 CSP 是 `connect-src 'none'`，**离线软件不能下载网络字体**。
做法：把这两个名字写进 `--font-sans` 的**最前面**（本机装了就用），后面保留系统字体回退。
不新增依赖、不引 webfont、不联网。

### 3.6 等级：我们的四级 → 规格五级是**展示层**换算（Phase 3）

规格要五级（Critical/High/Medium/Low/Info），我们的领域层只有四级，而且 `unknown`
**是合法取值**（相机 `alarm_level` 从未在真机上回过、声纹协议里根本没有等级字段 ——
`event-center.ts` 的注释写了原因）。做法是加一层显式适配器（`toAlertViewModel`）：

| 我们的 `EventSeverity` | 界面等级 | 理由 |
|---|---|---|
| `critical` | Critical | 同义 |
| `warning` | **High** | `deriveEventSeverity()` 里 `'warning'` 不是"从设备读到的等级"，而是这条记录本身的语义（设备确实报了非零告警位）。它是我们唯一站得住的等级信号；压到 Medium 只会让"永远为 0 的 Critical/High 占着最高两档" |
| `info` | Info | 同义 |
| `unknown` | Info + **「等级未知」** | 不许把"不知道"装成"提示"：界面显示「等级未知」，KPI 也不把它算进任何一档 |

`medium` / `low` 在当前的领域层里**没有任何代码路径能产生**，所以它们不出现在筛选面板、
不出现在 KPI 条、也不出现在下拉里 —— 一个永远搜不到东西的筛选项比没有更糟。
界面上"真的会出现"的等级由 `VISIBLE_ALERT_SEVERITIES` 一处定义。

Phase 5 做等级迁移（v13：把等级**存进库**）时，要改的只有这一个函数加数据库 CHECK。

### 3.7 KPI 与分组计数的作用域 = **已加载的那一页**（Phase 3）

规格 §8 的 KPI 条读起来像"当前筛选范围的整体统计"。我们做不到，而且原因在代码里：
主进程的等级过滤是**按来源整路跳过**的（`event-center-service.ts`：
`input.severity !== deriveEventSeverity(source)` 直接返回空），所以"整个筛选结果"的等级分布
在主进程里根本没被算过。

做法：KPI 与筛选面板的计数都按 `store.items`（当前页）算，并且**把作用域印在界面上**
（`eventsUi.kpiScope`「已加载 {loaded} / 本次结果 {total} 条」、`eventsUi.panelScope`）。
数字是准的，只是范围小一号，而且使用者看得见它小一号。

要真正做全量分面，得在主进程里加一次聚合查询（不增列、不增表），那是后续的事项；
在拿到之前，界面不把一页的分布说成全库分布。

### 3.8 关键字只在已加载的那一页里搜（Phase 3）

规格 §9.1 有一个 260–320px 的搜索框。三路来源的检索是**三件不同的事**
（相机是设备 HTTP、联动是内存待处理列表、声纹是 SQLite），所以关键字没有进查询参数，
而是在已加载的那一页里匹配（设备名 / 事件种类 / 标识 / 指标值）。

做法：搜索框下面/旁边（`eventsUi.searchScope`「搜索只在已加载的 N 条里生效」）把这件事说出来。
另外：**改关键字不重新查询**（只有设备/来源/等级/时间/确认状态会触发查询）—— 否则每敲一个字
就去连一次相机。

### 3.9 "六个下拉"改成"面板四组 + 时间两个"（Phase 3）

规格 §9 的下拉是 搜索 + 六个（Severity / Status / Type / Device / Time / Owner…）。
我们把**设备 / 来源 / 等级 / 确认状态**做成左侧筛选面板的四组（带计数），筛选栏里只留
搜索 + 时间范围 + 内置视图 + 视图模式。理由：同样的四个条件在面板与下拉里各放一份，
两处状态要同步、两处都要维护计数，而操作员会看到"同一个筛选有两个开关"。

时间范围没有进面板（它是两个 `datetime-local`，放进 216px 的窄栏里会挤成一团）。
Owner / Assignee 那一组属于 Phase 5（状态机带指派人）—— 现在没有指派人这个字段，
画出来就是一个永远为空的筛选。

### 3.10 Evidence 里**每条事件只有一张图**（Phase 4 落地版）

规格 §12.1 的 Visual 一列列了「声学图 / 可见光图 / 热成像图」，§10 的 Evidence 模式还要缩略图。
我们能提供的图片证据只有**两处**：

| 来源 | 图从哪来 | 走哪个接口 |
|---|---|---|
| 本机联动告警（`linkage`） | `frameRelativePath`（抓帧在存储根下的相对路径） | 新接口 `eventCenter.evidenceImage({relativePath})` |
| 声纹告警（`localAlarm`，**仅听诊盒子 / 空气声呐**） | `alarms.snapshot_dir`（球机抓图目录） | **已有**接口 `e2.alarmSnapshots(deviceId, alarmId)`（第 8 批做的，不重复造） |
| 相机检测日志（`deviceDetect`） | 图是**设备侧结果文件**，要先下载到本机 | 不在这里：走 Evidence 页签的「结果文件」列表 |

所以 Phase 4 的 Evidence 渲染的是**一张**图（不是一组），并在取不到时说清是哪一种"没有"：
`not-captured`（设备上本来就没有）/ `files-gone`（库里有、盘上没了）/ `not-image`（不是图片格式）/
`not-found`（路径认不出来）/ `error`（IPC 自己失败）。**一条事件的多次触发各有一张图**
（聚合是 Phase 6 之后的事），所以"一条事件几张图"这个问题要等聚合做出来才谈得上。

Phase 4 **没有**做在**队列行**里显示缩略图（规格 §10 的 Evidence 视图模式那一条）：
队列一屏 50 行、每行一张回环图，一次就是 50 个 `<img>` 与 50 次令牌请求。
队列那一档现在显示的是"有哪些证据"（录像 / 抓帧 / N 个结果文件）—— 要看图进抽屉。
这一条是**取舍**，不是遗漏。

### 3.11 抽屉里没有 Assign / ⋯（主 CTA 只有一个）

规格 §11.2 的头部是 `[Acknowledge] [Assign ▼] [⋯]`。Phase 4 只做了 `[Acknowledge]`：
Assign（指派人）与 `⋯` 菜单里的动作都属于 Phase 5 的状态机（库里现在没有指派人这一列，
也没有状态变更记录）。一个点开只有「暂无选项」的菜单比没有更糟，所以先不画。

---

## 4. 进度与下一步（按规格 §18.1 的六个阶段）

| 阶段 | 内容 | 状态 |
|---|---|---|
| Phase 1 | Design Tokens + 基础组件样式 | **✅**：token 取值对齐 + 补齐（含严重度五级、页面底色、控件高度、焦点环、事件行度量、三栏宽度、字号档位）；按钮/输入/chip/card 的圆角与高度按规格改；页面底色 `#F7F8FA` |
| Phase 2 | 侧栏（232/64 折叠）+ 顶栏 + 事件中心骨架 | **✅ 侧栏**（折叠动画 200ms、3px 橙色竖条、偏好 localStorage、折叠后 tooltip） |
| Phase 3 | KPI 条 + 筛选栏 + 左侧筛选面板 + 告警队列（三种视图模式） | **✅ 本轮**：<br>· 纯函数层 `src/shared/domain/event-view.ts`（`AlertViewModel` 适配器、`eventKpis`、`eventFilterCounts`、筛选/URL/存取的容错解析）+ `tests/event-view.test.ts`（40 条）<br>· `EventKpiStrip.vue`（四格、可点、作用域印在下面）<br>· `EventFilterPanel.vue`（等级/来源/确认状态/设备四组带计数、216px）<br>· `AlertQueue.vue`（三档行高、3px 严重度色条、↑/↓ 选中并同步焦点、整行是 button、等级文字每一档都印）<br>· `EventCenterView.vue`：表格 → 队列、搜索 + 时间 + 六个内置视图 + 视图模式、URL/localStorage 记忆、Esc 关抽屉、来源读况改为**只在失败/截断时**出现、关键字不再触发重新查询<br>· `main.css`：`.severity--<五档>`（一个类给出强调色 + 软底色）、`.alert-row`、`.chip--tiny` 提升为全局<br>· 探针：`scripts/demo-shot-driver.cjs` 增加事件中心一段（KPI 四格与作用域、平均确认耗时是「—」、面板 216px 与四组、六个视图、三档行高、点行开抽屉 + Esc 关、点 KPI「严重」后地址栏/面板/localStorage 三处都对、四条版面关系），并修掉三处**探针自己**的缺陷（见 `docs/Ivms4200-UX-REFERENCE.md` §15.41.6） |
| Phase 4 | 详情抽屉（400–560 可拖）+ Overview + Evidence（按 sensorType） | **✅ 本轮**：<br>· 纯函数层新增：`AlertViewModel` 的 `firstDetectedAt` / `lastDetectedAt` / `durationMs`、抽屉宽度常量与容错（400–560）、`alertOverviewFields()`（§11.4 的字段表）、`evidenceImageSource()`（图从哪来）<br>· 新组件 `EventDetailDrawer.vue`：拖拽 + 键盘改宽度（偏好 localStorage）、Esc 关、↑/↓ 与 J/K 换条（只在焦点位于抽屉内时接管）、40px 页签条 + 2px 橙色下划线、头部等级/标题/设备链接/首次探测时间/主 CTA<br>· `EventCenterView.vue`：Overview 2 列属性网格 + Evidence（图片 / 录音录像 / 指标 / 结果文件），旧的内联抽屉拆干净<br>· **新 IPC** `eventCenter.evidenceImage` / `closeEvidenceImage`（只读；四道关：路径来源 `recordingId` 优先 → 存储根越界保护 → 文件在不在 → 是不是图片）<br>· `main.css`：新增 `--color-scrim`（模态与抽屉共用一个遮罩值，顺手修掉 `AppModal` 里写死的 rgba）<br>· 探针：抽屉默认宽度 400、抓手 400–560、页签只有两个、Overview ≥8 格且有一格跨两列、切页签真的切过去、Evidence 有图或有说明、焦点进入抽屉、键盘 ← 改宽度并**写回 localStorage** |
| Phase 5 | Timeline / Related / Activity + 状态机与动作（Ack/Assign/Resolve） | 待做（需要 schema v13：状态、指派人、Activity 表，以及四级→五级严重度的旧数据映射；`AlertStatus` 类型与标签、`AlertViewModel` 的三个聚合字段、五个页签里缺的三个标签**都已经在**了） |
| Phase 6 | 重复触发聚合 + 人工 Incident | 待做（需要聚合键与 Incident 表；`AlertViewModel.occurrenceCount` 已经带着，界面在它等于 1 时不渲染 ×N） |

**每一阶段的交付口径**（与仓库既有规矩一致）：四语言文案 + 单测/源码守卫 + 探针断言 +
文档记录 + 重新打包；写库/写设备一律**写完读回**；规格没说的取值一律在文档里标明是我们的设计。

**Phase 3 的已知未验证**（探针在有数据的 profile 里跑通，但下面这些没有被证明）：
- **长列表下的滚动与虚拟化**：队列是一页 50 条直接渲染，没有做虚拟滚动（规格也没要求）。
  上万条的滚动表现**没有测过**。
- **筛选面板的计数在"结果超过一页"时的说服力**：作用域已经印出来了，但"点一个计数为 0 的设备
  仍然可能在别的页上有数据"这件事只在文案里说明，没有在界面上做过实验。
- **多显示器 / 缩放比例**：三栏在 1440×900 的窗口里验过（探针量了 216px），其它分辨率没有量。
- **四语言的实际排版**：es/tr 的文案更长（"Confirmación media"、"Onayunmadı"），窄栏里
  是否换行、KPI 首屏是否被挤成两行**没有逐语言看过**。

**Phase 4 的已知未验证**（同样是探针跑通 ≠ 全都验过）：
- **拖拽改宽度只验了键盘那一路**：探针在抓手上按 ← 量到 416px 并读回 localStorage；
  鼠标拖拽（`mousedown` + `mousemove`）**没有被自动验证**（合成鼠标事件在 Electron 里
  能触发，但那验证的是探针自己的事件合成，不是真实拖拽手感）。手感要人拖一下。
- **图片证据在真机上没验过**：探针跑的是操作员库的副本（**只复制数据库、不复制存储根**），
  所以联动抓帧与声纹抓图在那次运行里都取不到文件 —— 探针只能证明"取不到时有正确的说法"。
  "真的显示出一张图"要等真机上有抓帧、且存储根里有那个文件时才能看到。
- **一条事件的图与它自己是否对得上**：`recordings.findById` / `snapshot_dir` 给的路径是
  权威，但"这张图确实是这条告警那一刻的"这件事没有第三方证据（设备侧不留这种指纹）。
- **四语言的抽屉排版**：头部三行 + 页签条 + 属性网格在 es/tr 下是否换行、是否溢出，
  没有逐语言看过（探针在 zh-CN 下量的）。
- **Evidence 页签里"链接到图片"的行为**：实现成 `target="_blank"` 打开回环地址，
  但没有验证窗口里点开之后浏览器/内嵌视图的表现。

