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
| §2.2 状态机 | New → Acknowledged → Investigating → Resolved → Closed（+ Muted / Reassigned / Reopened） | 只有 `alarms.acknowledged`（二值）+ 备注 + 等级 | Phase 5（要加列/表：状态、指派人、Activity 流） |
| §2.3 严重度 | 五级 Critical/High/Medium/Low/Info + 指定色 | 四级 `info/warning/critical/unknown`（DB CHECK 钉死） | **Phase 1 已加颜色的 token**；值域改五级属 Phase 5（要迁移 v13 + 旧数据映射） |
| §3.2/§3.3 侧栏 | 232 / 64 可折叠、180–220ms、3px 橙色选中竖条、偏好本地保存 | 固定 216px、2px 竖条、无折叠 | **✅ 本轮做完**（偏好存 localStorage） |
| §4.1 布局 | 1440×900 基准；内容内边距 24（≥1600 用 32）；Filter 216 / Drawer 400–560 | 无这三栏；内容内边距 24 | Phase 3/4（token 已就位：`--filter-panel` / `--detail-panel*`） |
| §5 字体排版 | Inter / Noto Sans SC；11–24px 的九档字号 | 系统字体栈；字号在各组件里写死 | **token 已加**（§2 对照表）；逐组件迁移见第 4 节 |
| §6 颜色 | 品牌/中性/严重度全套 hex | 自有 token（值略有差异） | **✅ 取值已对齐**（含新增严重度五级、页面底色、hover、tertiary/disabled、accent-active/light/strong） |
| §7 间距/圆角/阴影 | 4px 网格（我们已有）；输入/按钮 6px、卡片 8px、Modal 10px；面板靠 1px 边框 | 4px 网格已有；输入/按钮 8px、卡片 12px | **✅ 已改**（`.btn`/`.input`/`.chip` 6px、`.card` 8px、按钮 28px、输入框 36px） |
| §8.1 页头 | 标题 24/32/600 + 副标题 + 右侧只有时间范围/自动刷新 | 顶栏已有页面名；页内无标题（产品曾要求删） | Phase 3（**冲突**：见 3.2） |
| §8.2 KPI 条 | 五个可点 KPI（点后转筛选，不跳页） | 顶栏三个指示器（设备数/在线/未确认告警） | Phase 3 |
| §9 筛选 | 搜索 260–320px、六个下拉、Chippy 激活态、Saved Views、URL 同步 | 筛选栏（设备/等级/时间等）+ 分面计数 | Phase 3（Saved Views 与 URL 同步是新东西） |
| §10 告警队列 | 88–104px 行、3px 左竖条、三种视图模式（Compact/Standard/Evidence）、偏好保留 | 表格行（`.table`）+ 详情在抽屉里但整页是"列表页" | Phase 3（表格 → 队列行） |
| §11 详情抽屉 | 400/440/560 可拖、不跳页、Esc 关闭、↑↓ 切条、五页签 | 有右侧详情面板（滚动分区，无页签、无宽度拖拽） | Phase 4 |
| §12 Evidence | 按 sensorType 分渲染器（Acoustic / DTS / DAS / DGA）、统一容器 | 相机检测结果、本机录音、PRPD/频谱在别的页面 | Phase 4（**冲突**：见 3.1） |
| §13 Timeline/Related/Activity | 三块：时间线、相关性分组、活动流 | 无（有告警联动动作列表） | Phase 5（Activity 需要落库） |
| §14 聚合与 Incident | occurrenceCount / first-last / duration；人工 Create Incident | 无（每条告警一行、无聚合、无 Incident） | Phase 6（**冲突**：见 3.3） |
| §15 交互与可用性 | 选中不跳页、Ack 不关抽屉、键盘、焦点环、时区 | 部分符合（焦点环本轮统一为 `--focus-ring`） | 随 Phase 3–5 |
| §16 组件树/Store/ViewModel | EventCenterPage → KPI/Filter/Queue/Drawer … | `EventCenterView.vue` 单文件 + `stores/eventCenter.ts` | Phase 3 起按规格拆组件（见第 4 节） |
| §17 Design Tokens | 一套 `--hz-*` 等 token，禁止组件里硬编码 | 已有 token 体系（组件里不写 hex） | **✅ 取值与清单已对齐**，对照表见 §2 |
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

---

## 4. 进度与下一步（按规格 §18.1 的六个阶段）

| 阶段 | 内容 | 状态 |
|---|---|---|
| Phase 1 | Design Tokens + 基础组件样式 | **✅ 本轮**：token 取值对齐 + 补齐（含严重度五级、页面底色、控件高度、焦点环、事件行度量、三栏宽度、字号档位）；按钮/输入/chip/card 的圆角与高度按规格改；页面底色 `#F7F8FA` |
| Phase 2 | 侧栏（232/64 折叠）+ 顶栏 + 事件中心骨架 | **✅ 侧栏**（折叠动画 200ms、3px 橙色竖条、偏好 localStorage、折叠后 tooltip）；事件中心骨架属 Phase 3 |
| Phase 3 | KPI 条 + 筛选栏 + 左侧筛选面板 + 告警队列（三种视图模式） | 待做 |
| Phase 4 | 详情抽屉（400–560 可拖）+ Overview + Evidence（按 sensorType） | 待做（Evidence 只做 Acoustic，见 3.1） |
| Phase 5 | Timeline / Related / Activity + 状态机与动作（Ack/Assign/Resolve） | 待做（需要 schema v13：状态、指派人、Activity 表，以及四级→五级严重度的旧数据映射） |
| Phase 6 | 重复触发聚合 + 人工 Incident | 待做（需要聚合键与 Incident 表） |

**每一阶段的交付口径**（与仓库既有规矩一致）：四语言文案 + 单测/源码守卫 + 探针断言 +
文档记录 + 重新打包；写库/写设备一律**写完读回**；规格没说的取值一律在文档里标明是我们的设计。
