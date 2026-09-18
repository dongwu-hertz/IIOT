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
| §2.2 状态机 | New → Acknowledged → Investigating → Resolved → Closed（+ Muted / Reassigned / Reopened） | 只有 `alarms.acknowledged`（二值）+ 备注 + 等级 | **✅ Phase 5**：七个状态落在 `event_status`（schema v13），每次变更写 `event_activity`（时间/操作者/前后状态）；抽屉头部按状态给动作（Ack/Investigate/Resolve/Close/Reopen/Mute + Assign），一次只有一个主 CTA。取舍见 3.12、3.14 |
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
| §13 Timeline/Related/Activity | 三块：时间线、相关性分组、活动流 | 无（有告警联动动作列表） | **✅ Phase 5**：三个页签都在（`IMPLEMENTED_DETAIL_TABS` 五个）。Timeline = 首次探测 + 我们的动作 + 联动动作，按时间排；Related = 同设备 / 同类型 / ±10 分钟三组（**只在已加载那一页里找**，作用域印在页面上），点一下切到那一条；Activity = `event_activity` 的流水，新的在前 |
| §14 聚合与 Incident | occurrenceCount / first-last / duration；人工 Create Incident | 无（每条告警一行、无聚合、无 Incident） | **✅ Phase 6 两半都做完**：前半 = 重复触发聚合（同一设备 + 同一种事件 + 窗口内的连续触发并成一条告警，`occurrenceCount` / `firstDetectedAt` / `lastDetectedAt` / `duration` / 原始成员都在，队列行带 ×N，时间线里每次触发各占一个节点，取舍见 3.15）；后半 = 人工 Create Incident + 手动关联（schema v14，抽屉「关联」页签的建议卡 / 创建 / 关联到已有 / 解除，取舍见 3.3 / 3.16 / 3.17） |
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

**Phase 6 后半已按 V1 落地**（schema v14 = `incidents` + `incident_alerts`）：抽屉「关联」页签里
列出现有的关联（可解除）、够阈值时给一张**建议卡**（规格 §13.2 的 "Potential Related Incident"），
创建/关联走同一个对话框。两处判据是**我们自己定的**，规格没给数：

- **建议卡的阈值 = 同一条相关性链上至少 2 条告警**（含当前这条，默认档）。规格 §13.2 只说
  "当相关性达到阈值时"，**阈值本身手册未说明**；默认取 2 的理由：一条孤立告警没有可建议的
  内容，而"同设备上还有第二条"已经是一次值得记下来的事实；取更大的值会让这条入口在只有
  两三台设备的现场永远不出现。**它是可调的**（业主 2026-09-18：「可以设置为可调整的」）：
  抽屉「关联」页签里的下拉四档 **2 / 3 / 5 / 10**，就放在建议卡旁边（要改的是眼前的东西，
  不该先去系统设置），跟着本机记住（`hertzinno.eventCenter.incidentThreshold`，与视图模式
  同一条规矩）。档位是**离散**的而不是自由输入：调低会让建议变多，离散档位让操作员能预判
  自己按下去会发生什么，也不会出现 `0` / `999` 这种没有意义的阈值。
- **建议的标题 = 设备名 + 「异常情况」**（规格 §14.2 的例子 `Transformer T03 abnormal condition`
  就是这个形状）。它只是**初值**，对话框里可以整句改掉 —— 规格 §13.2 明说"不自动替用户
  关闭/合并"，所以建议卡里只有一句话 + 一个按钮，没有任何自动动作。

**关联的标识空间与状态/Activity 完全一样**（`EventCenterEntry.id`：`alarm:` / `linkage:` /
`detect:` 前缀）：一条事件的状态、流水、所属 Incident 可以用同一把钥匙对齐。
一条 Alert **可以同时属于多个 Incident**（人工关联不做成"只能有一个"）：两个现实问题重叠在
同一条告警上是常见的，硬拦会把操作员逼去编一个假标题。

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

### 3.11 抽屉头部：一个主 CTA + 几个次要动作 + 行内表单

规格 §11.2 的头部是 `[Acknowledge] [Assign ▼] [⋯]`。Phase 5 的做法：

- **主 CTA**：由状态机给出（`statusActionsFor` 保证恰好一个）——`new` 时是「确认」、
  已确认时是「开始调查」、调查中时是「标记已解决」…… 与规格那一条"New 状态下通常是
  Acknowledge；Acknowledged 后可变为 Start Investigation"一致；
- **次要动作**：同一状态下的其它合法迁移（静默 / 关闭 / 重新开启）排成小按钮，
  没有可做的就一个都不出现；
- **Assign**：只在**有可选账户**时出现（一个账户都没有时点开只有空列表）；
- **需要输入的动作**（指派选人、重新开启写原因）走**行内表单**而不是再叠一层弹窗 ——
  抽屉本身已经是覆盖层，再叠一层就要处理两层 Esc。

`⋯` 菜单**没有做**：它的内容会与"次要动作"完全重合，多一个入口只是多一种找不到东西的方式。

### 3.14 「取消确认」在事件中心**不做**（规格的状态机是单向的）

规格 §2.2 的状态图里 `New → Acknowledged` 是**单向**的，没有回边；我们的状态机照抄。
改到 Phase 5 之前，事件中心对声纹告警是有一个「取消确认」按钮的（直接改
`alarms.acknowledged`），这一轮**移除了**它。

**能力没有从产品里消失**：告警记录页（`AlarmsView`）仍然有「批量确认 / 取消确认」，
那是对 `alarms.acknowledged` 的直接操作。事件中心里取消确认会与"状态机单向"这条口径打架
（"已确认"退回"待处理"意味着那条 Activity 要怎么写都不对），所以留在告警页。

### 3.12 工作流状态是**我们自己的表**，与来源的确认标志是两件事（Phase 5）

规格 §2.2 的状态机要落在库上，而"一条事件"有三个所有者：声纹告警在 `alarms`（SQLite）、
本机联动在引擎的待处理列表（内存 + 它自己的存储）、相机检测日志在**设备**上（连写接口都没有）。
三种做法里我们选了第三种：

| 做法 | 为什么不选 |
|---|---|
| 给 `alarms` 加列 | 只有三分之一的来源能用；联动与检测日志的状态无处可放 |
| 改联动引擎的内部存储 | 那是另一个模块的所有权；而且它仍然是"两处状态" |
| **新建 `event_status` / `event_activity`，按 `EventCenterEntry.id` 存** | ✅ 三个来源一视同仁；不动来源表的语义；相机检测日志也能被处置（记录在本机） |

由此来的三条规则（都写在代码里，这里只是索引）：

1. **`status` 与 `acknowledged` 是两件事**。`acknowledged` 是**来源侧的事实**（那一条告警行、
   ​那条待处理记录），`status` 是本机工作流状态。两者不一致时**以 `status` 为准**
   （`event-view.ts` 的 `entryStatus`：表里有行就用表里的，没有才用 `acknowledged` 推）。
2. **「确认」这一个动作让两边一起前进**：服务层在把状态改成 `acknowledged` 时**同时**调来源侧的
   确认接口；来源明确没有这个接口时（相机检测日志）**拒绝**整次写入 —— 不替设备答应它做不到的事。
   其余动作（开始调查/解决/关闭/静默/重新开启）**只**写本机：它们是我们的处置记录，与设备无关。
3. **状态变更与 Activity 在同一个事务里**（仓储层），所以不会出现"状态变了却没有记录"。

**Reassigned 不是状态**：状态图上它是 Acknowledged 的一个分叉，但"指派给谁"落在 `assignee`
上、记一条 `kind: 'assign'` 的 Activity。做成状态会出现"已指派的已确认"这种没有意义的组合。

**两个偏离状态图的地方**（都在 `ALERT_STATUS_TRANSITIONS` 里，也都有单测）：
`new → investigating`（打开就直接查是常见操作）与 `acknowledged → resolved`（一看就明白的告警
不必先"调查中"）；反过来**更严**一处：`closed` 只能回到 `reopened`。

### 3.13 四级严重度**暂时不迁移**到五级（改在这一轮明确下来）

`docs/EVENT-CENTER.md` 早先的表里把"值域改五级"排在 Phase 5。这一轮**没有做**，理由是：
库里现在**没有任何代码路径会写** `high` / `medium` / `low`（`deriveEventSeverity()` 只给
`warning` 或 `unknown`），所以那个 CHECK 目前不是障碍，而改它要重建 `alarms` 父表
（v10 的教训：改 CHECK 要重建父表，重建时外键会级联删子行，风险实打实）。

真正需要它的时刻是"出现可验证的五级等级来源"那一天 —— 那时这一次迁移要**连同旧数据怎么映射
一起做**（哪一档旧值算 High、哪一档算 Medium），而不是现在先改一个没人写的 CHECK。
界面上已经按五级**展示**（§3.6），所以这件事对使用者没有可见影响。

### 3.15 聚合在**主进程**做，分组键只有"设备 + 事件种类 + 时间窗口"（Phase 6）

规格 §14.1 要"同一设备 / 同一事件类型 / 指定时间窗口内的连续触发"并成一条 Alert，并说
"聚合依据必须可配置：assetId / eventType / detectionRegion / ruleId / timeWindow"。
我们**有的**只有 deviceId、eventType（事件种类）与时间窗口；asset / detectionRegion / ruleId
这三样在我们的数据里不存在（没有资产层、声学设备不报检测区域、联动规则还没有标识）。
所以"可配置"落在**时间窗口**上（界面四档：不聚合 / 10 分钟 / 30 分钟 / 1 小时），
分组键写死在 `eventGroupKey()` 一处。

三个实现上的判断：

1. **聚合在服务端、在分页之前**。告警是这一页所有数字的单位（KPI、筛选面板的计数、
   分页总数）—— 在渲染层并组会让 `total` 是"原始事件数"而列表是"告警数"，两个数字对不上。
2. **组的稳定标识 = 组内最早那一条的 entry id**，而**代表（返回给界面的那一条）是最新的**。
   `id` 会随着新触发往后滚，所以处置状态与（将来的）Incident 关联都挂在 `groupId` 上；
   而证据（抓帧、录像、指标）用最新那条的。
3. **API 的缺省是不聚合**（`groupWindowMs` 不给就不并）。界面每一查询都显式带上用户选的那一档
   （默认 10 分钟）—— 把"界面默认"写进 API 缺省里，以后改一次界面默认值就会悄悄改掉所有
   调用方（含测试与将来的脚本）。

处置一条聚合告警 = **处置组内每一条触发**（状态与 Activity 在同一个事务里各写 N 条），
回执说清改了几条；状态合并也按组（组内任何一条被处置过，整条告警就算处置过）。

**窗口的上限是 24 小时**：窗口太大就不是聚合，是把数据藏起来。

### 3.16 Incident **没有**生命周期 —— 我们不造规格没写的东西（Phase 6 后半）

规格 §2.1 用一句话定义 Incident（"一个现实世界问题，可关联多个 Alert / 多个设备 / 多种传感器"），
但**没有**给它状态、严重度、负责人或关闭条件 —— §2.2 的状态机是给 **Alert** 的。
所以 `incidents` 表里只有：标题、可选备注、创建人、创建/更新时间，加上关联表
`incident_alerts (incident_id, entry_id, linked_at, linked_by)`。

造一个"Open → Investigating → Closed"的 Incident 生命周期会让界面长出一套业主验收时
无从对照的概念（而且它会与 Alert 的状态机打架：一条 Alert 已 Resolved，它的 Incident 还是 Open
该显示什么？）。将来规格给了再迁移 —— 那时要**连同"旧的 Incident 怎么映射"一起做**。

### 3.17 KPI 条上**不加** `Incidents 5` 那一格（Phase 6 后半）

规格 §8.2 的 KPI 例子里有第五格 `Incidents 5`，并要求"所有 KPI 可点击，点击后转换成对应 Filter"。
我们不加它，理由是规格自己给的：**同一段末尾写着"不要使用'总告警数量 12,586'作为主要 KPI；
优先展示待处理性指标"**。按 §3.16，我们的 Incident 只有人工创建、没有关闭/解决，所以
"Incident 总数"是一个**只增不减**的数字 —— 它正是那一段点名反对的那类指标。等规格给出
Incident 的生命周期（有"未关闭"这个概念）再加这一格，那时它才是一个"待处理性"指标。

---

## 4. 进度与下一步（按规格 §18.1 的六个阶段）

| 阶段 | 内容 | 状态 |
|---|---|---|
| Phase 1 | Design Tokens + 基础组件样式 | **✅**：token 取值对齐 + 补齐（含严重度五级、页面底色、控件高度、焦点环、事件行度量、三栏宽度、字号档位）；按钮/输入/chip/card 的圆角与高度按规格改；页面底色 `#F7F8FA` |
| Phase 2 | 侧栏（232/64 折叠）+ 顶栏 + 事件中心骨架 | **✅ 侧栏**（折叠动画 200ms、3px 橙色竖条、偏好 localStorage、折叠后 tooltip） |
| Phase 3 | KPI 条 + 筛选栏 + 左侧筛选面板 + 告警队列（三种视图模式） | **✅ 本轮**：<br>· 纯函数层 `src/shared/domain/event-view.ts`（`AlertViewModel` 适配器、`eventKpis`、`eventFilterCounts`、筛选/URL/存取的容错解析）+ `tests/event-view.test.ts`（40 条）<br>· `EventKpiStrip.vue`（四格、可点、作用域印在下面）<br>· `EventFilterPanel.vue`（等级/来源/确认状态/设备四组带计数、216px）<br>· `AlertQueue.vue`（三档行高、3px 严重度色条、↑/↓ 选中并同步焦点、整行是 button、等级文字每一档都印）<br>· `EventCenterView.vue`：表格 → 队列、搜索 + 时间 + 六个内置视图 + 视图模式、URL/localStorage 记忆、Esc 关抽屉、来源读况改为**只在失败/截断时**出现、关键字不再触发重新查询<br>· `main.css`：`.severity--<五档>`（一个类给出强调色 + 软底色）、`.alert-row`、`.chip--tiny` 提升为全局<br>· 探针：`scripts/demo-shot-driver.cjs` 增加事件中心一段（KPI 四格与作用域、平均确认耗时是「—」、面板 216px 与四组、六个视图、三档行高、点行开抽屉 + Esc 关、点 KPI「严重」后地址栏/面板/localStorage 三处都对、四条版面关系），并修掉三处**探针自己**的缺陷（见 `docs/Ivms4200-UX-REFERENCE.md` §15.41.6） |
| Phase 4 | 详情抽屉（400–560 可拖）+ Overview + Evidence（按 sensorType） | **✅ 本轮**：<br>· 纯函数层新增：`AlertViewModel` 的 `firstDetectedAt` / `lastDetectedAt` / `durationMs`、抽屉宽度常量与容错（400–560）、`alertOverviewFields()`（§11.4 的字段表）、`evidenceImageSource()`（图从哪来）<br>· 新组件 `EventDetailDrawer.vue`：拖拽 + 键盘改宽度（偏好 localStorage）、Esc 关、↑/↓ 与 J/K 换条（只在焦点位于抽屉内时接管）、40px 页签条 + 2px 橙色下划线、头部等级/标题/设备链接/首次探测时间/主 CTA<br>· `EventCenterView.vue`：Overview 2 列属性网格 + Evidence（图片 / 录音录像 / 指标 / 结果文件），旧的内联抽屉拆干净<br>· **新 IPC** `eventCenter.evidenceImage` / `closeEvidenceImage`（只读；四道关：路径来源 `recordingId` 优先 → 存储根越界保护 → 文件在不在 → 是不是图片）<br>· `main.css`：新增 `--color-scrim`（模态与抽屉共用一个遮罩值，顺手修掉 `AppModal` 里写死的 rgba）<br>· 探针：抽屉默认宽度 400、抓手 400–560、页签只有两个、Overview ≥8 格且有一格跨两列、切页签真的切过去、Evidence 有图或有说明、焦点进入抽屉、键盘 ← 改宽度并**写回 localStorage** |
| Phase 5 | Timeline / Related / Activity + 状态机与动作（Ack/Assign/Resolve） | **✅ 本轮**：<br>· **schema v13**（`event_status` + `event_activity`，CHECK 钉住七个状态与三种记录）+ 迁移测试（老库升级一行不少、幂等、CHECK 真的在管）<br>· `EventStatusRepository`：状态与流水**同一个事务**、写完读回、按事件分组计数、分块查询；`assign` 不会把状态退回 `new`<br>· 领域：`AlertStatus` 七个取值、`ALERT_STATUS_TRANSITIONS` + `canTransitionStatus`、`statusActionsFor`、`activityRows` / `alertTimeline` / `relatedGroups` + 单测<br>· IPC：`eventCenter.changeStatus`（**写，要管理员**，`actor` 来自会话）+ `eventCenter.activity`（只读）<br>· **界面**：抽屉头部按状态给动作（主 CTA 恰好一个；没有确认接口的来源不出现「确认」）、指派选账户、重新开启必须填原因（行内表单）、处置后**重查且不关抽屉**，以及 Timeline / Related / Activity 三个页签<br>· 探针：只读那一批里加"五个页签切得过去、关联三组、时间线有节点、头部有主 CTA"；**写探针**（排在最末尾）点一次主 CTA，然后 `eventCenter.query` 读回状态、`eventCenter.activity` 读回流水，并断言抽屉没被关掉 |
| Phase 6 | 重复触发聚合 + 人工 Incident | **✅ 两半都做完**：<br>**前半（聚合）**：<br>· 领域：`groupEvents()`（同一设备 + 同一种事件 + **连续**触发并组；窗口 0 = 不聚合）、`representativeOf()`（代表取最新那条、组的稳定标识取最早那条）、`GROUP_WINDOW_CHOICES` 四档 + 单测<br>· 主进程：聚合在**分页之前**（`total` = 告警数）、窗口上限 24 小时、状态按**组**合并、一次处置落到组内每一条（同一个事务 + `appliedTo`）<br>· 界面：筛选栏的聚合窗口下拉（四档、跟着 URL 与本机记住、改了会重查）、队列行 ×N、时间线里第 2..N 次触发各占一个节点（保留原始明细）<br>· 探针：聚合窗口四档、切到"不聚合"行数从 1 涨到 50（**证明那个 ×N 不是编的**）、恢复现场<br>**后半（Incident，规格 §14.2 的 V1）**：<br>· **schema v14**（`incidents` + `incident_alerts`：主键 `(incident_id, entry_id)` 保证幂等、`ON DELETE CASCADE`、按 `entry_id` 建索引）+ 迁移测试（v13 库升级一行不少、幂等、外键与主键真的在管）<br>· 领域 `src/shared/domain/incident.ts`：`validateIncidentDraft()`（标题必填 + 长度上限，对话框与主进程**共用一处**）、`incidentSuggestion()`（阈值常量 + 只认 same-device 那一组）、`IncidentView` / `sortIncidentsDesc()` + 单测<br>· `IncidentRepository`：创建 + 关联在**一个事务**里、关联幂等（`INSERT OR IGNORE`）、写完读回、一次 `GROUP BY` 取关联条数<br>· 服务：`createIncident` / `linkAlerts` / `unlinkAlert` / `incidentsForEntry` / `listIncidents`（**只建关联、不碰 Alert 状态** —— 规格 §13.2 的"不自动关闭/合并"）<br>· IPC：三条写通道（**要管理员**）+ 两条读通道（`viewEvents`），五条都登记进 `PERMISSION_OPERATIONS.viewEvents`<br>· 界面：抽屉「关联」页签里新增 Incident 那一段（已关联列表 + 建议卡 + 两个按钮）、`IncidentCreateDialog.vue`（新建 / 关联到已有两种走向、候选默认全勾可去掉、本地校验用共享判据、回执就地显示）<br>· 探针：写探针先**把聚合关掉**（同设备多条告警各自成行）→ 找一台出现两次以上的设备 → 打开抽屉 → 关联页签里**必须有建议卡** → 建一个 → `incidentsForAlert` 读回（标题 / 创建人 / 关联条数）→ 面板里列出那一行 → 点「解除关联」→ 再读回 0 条；跑完恢复聚合窗口 |

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

**Phase 5 的已知未验证**（这一轮做完的；跑通 ≠ 全都验过）：
- **指派与"重新开启必填原因"的行内表单没有在探针里点过**：服务端的拒绝有单测，
  界面上只验证了"按钮由状态机给出"。
- **真库升级到 v13 还没有发生过**：迁移测试跑在临时库上（v12 → v13、幂等、CHECK）。
- **`event_activity` 没有保留策略**（会一直长）；**来源行被删之后 `event_status` 会留孤儿行**。
- **处置动作要求管理员**（与"确认"同一档）：要不要给操作员单独开一项权限，是产品决定。
- **`applyQuery` 那个真缺陷的回归**：探针里那句"清掉筛选之后队列仍然是空的"继续钉着它，
  但同类问题（"控件显示的状态与实际查询不一致"）**只有这一处被查过**。

**Phase 5 后端（这一轮）的已知未验证**：
- **升级现场库的实测**：迁移测试是在**临时库**上跑的（v12 → v13、幂等、CHECK）。
  操作员那台真实的库（现在是 v12）第一次用新包启动时会升到 v13 —— 那一次升级
  **还没有在真库上发生过**。新表是纯新增，既有数据不受影响，但"没做过"就是没做过。
- **`event_activity` 会一直长**：没有保留策略（那是产品决定：多久算旧账）。这一轮**不删**。
- **处置动作在界面上的闭环**：IPC 与领域规则有测试，但**还没有任何界面**调用它们 ——
  探针自然也还没有断言（界面部分做完那一轮再补）。
- **删除来源行之后的状态残留**：`event_status` 按 entry id 存，声纹告警行被删（保留策略）
  之后那一行状态会变成孤儿。它不影响任何界面（事件已经不出现了），但库里会攒下这些行 ——
  需要一条清理规则时，这一条是输入。

**Phase 6 后半（Incident）的已知未验证**（跑通 ≠ 全都验过）：
- **真库升级到 v14 还没有发生过**：迁移测试在临时库上跑（v13 → v14、幂等、外键/主键/CASCADE）。
  操作员那台库第一次用新包启动时会升到 v14（纯新增两张表）。
- **同名/重复 Incident 没有约束**：两个人可以建两个标题一样的 Incident，界面上并排出现两条
  一模一样的建议。没有去重规则（那是产品决定：合并两条 Incident 该保留哪一条？）。
- **删除 Incident 没有入口**：表上写了 `ON DELETE CASCADE`，但界面上没有"删除"（规格 V1 没有
  这个动作）。解除关联是有的。
- **`incident_alerts` 会一直长**：与 `event_activity` 同一条 —— 没有保留策略。
- **多个 Incident 同时在面板里时的排版**没有逐语言看过（探针里只有一条关联）。
- **关联条数只统计"链接条数"**，不展开到聚合组的成员：一条 ×50 的聚合告警算 **1** 条关联。
  这是刻意的（关联的是"告警"，不是"50 次触发"），但界面上的 `N 条关联告警` 与队列里的 ×N
  读起来可能让人以为两处说的是同一个数。
- **"关联到已有"的选择器没有量过很多条时的表现**：`listIncidents` 上限 100，界面上是一个原生
  `<select>`（一百条会很长的下拉）。

