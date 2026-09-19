# iVMS-4200 实时预览交互参考 + 本仓库落地计划

> **文档性质**：这是一份**工作参考（working reference）**，不是论文。上半部分是**研究结果**（每条结论带来源链接），
> 下半部分是**本仓库的差异分析与落地清单**。
>
> **取证时间**：2026-09-15。**取证方式**：`web_search` / `web_fetch` + 直接抓取 Hikvision 官方 CDN 的 PDF 并本地抽文本。
> Hikvision 的部分 URL 对本机返回 403（见 §0.3「取证方法与失败项」），因此**版本之间存在差异的条目会并列写出**，不取平均。
>
> **引用纪律**：**每一条事实性结论都带来源**。没有来源的一律标 `未经证实`，`未经证实` 不等于错，只等于「不要把 UI 建在它上面」。
>
> **语言约定**：中文说明，标识符/文件路径/菜单英文原文保留原文；引用原文时用 `「」` 括起。
>
> **本文档不改动任何源码**。下半部分的每一项都写明了「碰哪个文件」，`MonitorView.vue` 与 `src/main/services/media/**`
> 在撰写期间正由另一位 agent 修改（见 §2.2），因此本文把**已在位的东西**和**缺口**分开写。

---

## 文档索引（2026-09-17 整理）

- **§0–§14 是 iVMS-4200 的研究结果**（每条结论带来源；`未经证实` 的条目不要拿它当依据）。
  想看"别人怎么做实时预览"从这里开始：§3 右键菜单、§1 分屏、§2 工具条、§4 手动录像、§6 告警配置。
- **§15 是「我们自己的落地记录」**，按业主的批次一轮一轮往后加（最新在最下面）。
  想查"某一版为什么这么写、谁要求的、当时怎么验的"看这里。

**§15 逐节导航**（按主题分组；括号里是节号）

| 主题 | 节 |
|---|---|
| 取证方法 / 手册佐证 / **手册明确未说明的清单** / 我们自己的设计 | §15.1 – §15.7、§15.5（未说明清单）、§15.6（属于我们的设计，别写成"参照 iVMS"） |
| 告警等级与联动、回放时间轴、布防、告警→本机录像 | §15.8 – §15.15、§15.17 |
| i18n 审计工具与它当场揪出的缺陷（含四条**流程教训**） | §15.13（§15.13.1–§15.13.5） |
| 界面批次（标题栏、入口、告警图标、登录页、夜间批次、设置页签…） | §15.18 – §15.21、§15.35、§15.38、§15.39 |
| 两份 FA8/FA110 与两份 E2 API 资料、这一族的**两代协议** | §15.22、§15.23、§15.27、§15.28 |
| **样本库 / 标签两维 / AI 打标**（分叉 AI 训练版从这里接） | **§15.24 – §15.26** |
| 实时监测页结构改造（③④⑦、⑨、⑧、②、⑤、③b） | §15.29 – §15.34 |
| 听诊盒子族端到端验证、SN-16 身份澄清与真机验证工具 | §15.36、§15.37 |
| 设备表 / 机型自动识别 / 点位信息 / 三种实时检测（第 7 批） | §15.38 |
| **PTZ 球机联动 + 离线点位图 + 告警抓图（第 8 批）** | **§15.39** |
| **事件中心规格改造 Phase 1–2（token + 侧栏）** | **§15.40** |
| **事件中心规格改造 Phase 3（KPI / 筛选面板 / 告警队列）** | **§15.41** |
| **事件中心规格改造 Phase 4（详情抽屉 / Overview / Evidence + 图片证据接口）** | **§15.42** |
| **事件中心规格改造 Phase 5 前半（状态机 / 处置工作流 / Activity，schema v13）** | **§15.43** |
| **事件中心规格改造 Phase 5 后半（处置动作 / 指派 / 三个页签）** | **§15.44** |
| **事件中心规格改造 Phase 6 前半（重复触发聚合）** | **§15.45** |
| **相机墙空白格的「+」选择器弹错位置（业主报的 bug）** | **§15.46** |
| **应用级失败进告警图标（不再挂在页面顶上）** | **§15.47** |
| **事件中心规格改造 Phase 6 后半（Incident：人工创建 + 手动关联）** | **§15.48** |
| **第 10 批界面要求（24 条）：③侧栏折叠按钮位置 + 圆形 logo / ⑦⑩地址信息改名并删基准声压级 / ⑲在线绿点灰点 + 删那段说明** | **§15.49** |
| **第 10 批（续）：②b设备管理扁平化 / ⑧设备表十列 / ⑨编辑设备（含凭据写回）** | **§15.50** |

> 配套：`docs/UI-VERIFY.md`（人工核对清单、未验证清单、真机怎么跑）、`docs/BASELINE.md`（分叉基线）。

---

## 0. 来源清单与取证状态

### 0.1 一手来源（Hikvision 官方）

| 编号 | 来源 | 覆盖内容 | 取证状态 |
|---|---|---|---|
| **S1** | [Hikvision USA《iVMS-4200 Part 3 — Device Groups & Live View》(2017)](https://www.hikvision.com/content/dam/hikvision/ca/how-to-document/IVMS-4200-part-3-device-groups-and-live-view.pdf) | 实时预览页整体、窗口工具条、右键菜单条目、拖拽/双击、PTZ、即时回放 | ✅ 直接下载 PDF 并本地抽文本（11 页） |
| **S2** | [Hikvision《iVMS-4200 Client Software User Manual》V2.7（葡萄牙语版 PDF，2017）](https://idoc.pub/documents/manual-of-ivms-4200v2720171127-portuguese-2nv5vpwx5rlk) | 右键菜单**完整清单与顺序**、窗口工具条图标清单、手动录像/抓图、即时回放、告警（Event Management / Arming Schedule / Linkage Action）、文件保存路径 | ✅ HTTP 200 并抽文本（11444 行） |
| **S3** | [Hikvision《iVMS-4200 Client Software User Manual》V2.02（俄语版 PDF，2014-10-28）](https://avant.by/sites/default/files/help-documentation/instr_ivms-4200.pdf) | 右键菜单**完整清单与顺序**（与 S2 可互相校验）、工具条表、`Ctrl+双击`、`Esc` 退出全屏 | ✅ PDF 230 页，本地抽文本 |
| **S4** | [Hikvision《iVMS-4200 Client Software User Manual》（英文 HTML 全文）](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) | 5.1 起停预览、5.6 自定义分屏、24.5 工具条图标表、24.2 图像参数（含「>9 分屏自动切子码流」）、第 9 章告警、24.6 键盘快捷键 | ✅ HTTP 200 并抽文本 |
| **S5** | [Hikvision 官方技术门户：《Where are the files I downloaded from the iVMS-4200 saved?》(2022-12-01)](https://techsupportca.freshdesk.com/support/solutions/articles/17000129940/thumbs_up) | 录像/抓图**保存路径的设置位置** | ✅ HTTP 200 |
| **S6** | [Hikvision《iVMS-4200 VS Client Software User Manual》V1.3.1 (UD20798B, 2020)](https://www.hikvision.com/content/dam/hikvision/en/support/download/vms/ivms4200-series/user-manual/UD20798B_iVMS-4200-VS-Client-Software_User-Manual_V1.3.1_20200729.PDF) | 较新界面（含 `Display Shield Area`、`Auto-change Stream Type`） | ⚠️ **本机 403，未能直接取证**；只通过搜索引擎摘要看到片段（如 `Right-click a live view image and select Display Shield Area`），因此**该版本的条目一律标 `未经证实`** |

### 0.2 二手来源（经销商 / 教程 / 论坛）

| 编号 | 来源 | 用途 | 可信度 |
|---|---|---|---|
| **S7** | [Tigers Eyes DV《iVMS-4200 – Просмотр в реальном времени》](https://www.tigerseyesdv.ru/ivms-4200-prosmotr-v-realnom-vremeni/) | 分屏档位「4、6、8、9、16 或自定义（最多 5 套）」、`Esc` 退出全屏、手动录像与抓图的**具体操作链**、磁盘路径设置位置、`Ctrl+L` 锁屏、`Ctrl+双击` 通道零 | 二手，但**与 S2/S3/S4 逐条一致**，只在「分屏档位扩展集」和 `Ctrl+L` 上提供 S1–S4 未覆盖的信息 |
| **S8** | [Manualzz《Hikvision iVMS-4200 User Manual》](https://manualzz.com/doc/6611355/hikvision-ivms-4200-video-management-software-user-manual) | 交叉检索 | ⚠️ 本机 HTTP 403（Cloudflare 挑战），仅用于确认章节编号 |
| **S9** | [IPCamtalk 论坛帖「Main view is just black」](https://www.ipcamtalk.net/threads/updating-sadp-ivms-v3-cannot-see-any-existing-cameras-main-view-is-just-black.48042/) | 佐证「空窗口/无画面 = 黑」的现场观感 | 论坛帖，仅作观感旁证 |

### 0.3 取证方法与失败项（诚实记录）

- 成功：S1、S2、S3、S4、S5、S7 均取到原文并本地抽成文本后引用。
- 失败：`hikvision.com` 的**新版**英文手册 CDN（UD20798B，S6）对本机返回 **403**；`manualzz.com` 403；
  `manualslib.com` 403；`hikvision.msk.ru` / `ftp.viatec.ua` DNS 解析失败。
- 因此：**本文能给出的「右键菜单完整清单」以 S2(V2.7) 与 S3(V2.02) 两份完整表格为准，并用 S1(V2017 教程) 校验**。
  版本之间确实有差异，§3 会把差异列出，不假装只有一个版本。
- 未做：没有安装/运行 iVMS-4200 本体，**所有结论都来自文档**。凡是文档没写的交互细节（例如空窗口里到底画什么、
  同一相机开两次会怎样），本文标 `未经证实`，不靠「一般监控软件都这样」补齐。

---

# 第一部分：iVMS-4200 实时预览交互参考

## 1. 实时预览的分屏布局与切换

### 1.1 分屏档位

| 档位集合 | 原文/来源 | 备注 |
|---|---|---|
| **1 / 4 / 9 / 16** —— 默认视图（Default View） | 「Four frequently-used default view modes are selectable: 1-Window, 4-Windows, 9-Windows, and 16-Windows」[S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) | 默认视图是**固定四档**；新建的自定义视图**默认就是 4 分屏** [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) |
| **1 ~ 64** 路同时显示 | 「Live view can display 1 ~ 64 images at a time」[S1](https://www.hikvision.com/content/dam/hikvision/ca/how-to-document/IVMS-4200-part-3-device-groups-and-live-view.pdf) | 这是**客户端能力上限**，不是某一档的格子数 |
| **4 / 6 / 8 / 9 / 16 / 自定义** | 「Разделение окон – 4, 6, 8, 9, 16 окон или пользовательское (до 5 своих раскладок)」[S7](https://www.tigerseyesdv.ru/ivms-4200-prosmotr-v-realnom-vremeni/) | 二手来源，与 S2/S3 的「自定义分屏」机制吻合 |
| **自定义分屏：3×3 / 4×4 / 5×5 / 6×6，最多 5 套** | 「Click on the live view or playback toolbar → Select Edit … Select the window division as 3×3, 4×4, 5×5, or 6×6 … Up to 5 window divisions can be customized」[S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) | 自定义还支持**合并相邻窗口（Joint）成一个大窗口** [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) |

**结论**：iVMS-4200 的布局是**两层概念**——
1. **Window Division（分屏档位）**：几何布局，只管画几格；
2. **View（视图）**：把「某个分屏档位 + 每格里绑哪台相机」存成一个**具名对象**，默认视图有 1/4/9/16 四套，
   自定义视图最多 5 套，可命名、可保存、可另存、可删除 [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7)[S1](https://www.hikvision.com/content/dam/hikvision/ca/how-to-document/IVMS-4200-part-3-device-groups-and-live-view.pdf)。
   下一次打开客户端时视图会重复出现（「Next session, view repeats」）[S1](https://www.hikvision.com/content/dam/hikvision/ca/how-to-document/IVMS-4200-part-3-device-groups-and-live-view.pdf)。

### 1.2 用户怎么切换

| 操作路径 | 具体动作 | 来源 |
|---|---|---|
| **工具栏按钮** | 在实时预览工具栏上点窗口分割图标 → 弹出档位列表 → 选一档 | [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) |
| **左侧 View 面板** | 展开 `Default View` 列表选一档；或展开 `Custom View` 列表选自定义视图 | [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) |
| **自定义分屏编辑器** | 工具栏 → `Edit` → `Add` → 起名 → 选 3×3/4×4/5×5/6×6 → 拖拽选中相邻窗口 `Joint` → `Save` | [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) |
| **鼠标滚轮切档** | **无此交互** —— 手册中滚轮的用途只有两处：PTZ 缩放、数字放大/还原 | [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7)（`Enable Wheel for Zoom` 一节） |

> ⚠️ **纠正一个常见误传**：网上流传「滚轮切分屏」。在 S1–S4 四份文档里都**没有**该行为；
> 滚轮在有据可查的用途是**缩放**（PTZ 模式 / 数字放大模式），且这个行为由
> `System Configuration → Live View and Playback → Enable Wheel for Zoom` 开关控制 [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7)。
> 「滚轮切分屏」标 **`未经证实`**。

### 1.3 空窗口长什么样

| 说法 | 状态 |
|---|---|
| 没放相机的窗口是**纯黑**，没有任何可点内容；分辨「窗口是空的」和「相机掉线了」靠的是**左侧相机列表的图标**而不是窗口本身 | **`未经证实`**（文档中没有对空窗口的描述） |
| 相机状态图标有 4 类：在线正常 / 正在预览 / 正在录像 / 离线；事件触发时组图标会变化 [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) | ✅ 有来源，指的是**列表里的图标**，不是窗口内容 |
| 现场观感：无画面时主视图整体是黑的，用户会把它当成故障来报修 [S9](https://www.ipcamtalk.net/threads/updating-sadp-ivms-v3-cannot-see-any-existing-cameras-main-view-is-just-black.48042/) | 论坛旁证，仅说明「黑窗口会被误读成故障」 |

**对我们的直接价值**：iVMS 的空窗口**不解释自己**。这正是本仓库明确反对的做法
（`ChannelWall.vue` 的注释：没数据时写「未监测」，绝不画 0；`MonitorView.vue`：`rtsp-disabled` / `ffmpeg-missing`
必须是可读状态而不是黑框）。**这一条要主动反向抄**。

### 1.4 判定

> **照抄**（分屏档位与「视图 = 档位 + 绑定」的两层结构），但**空窗口的沉默处理必须改写**：我们每一格都要能自己说明为什么没画面。

---

## 2. 单窗口工具条与叠加层

### 2.1 工具条的出现时机

| 结论 | 原文 | 来源 |
|---|---|---|
| 工具条出现在**被选中或鼠标悬停**的窗口上，**不是**每个窗口常驻 | 「Toolbar appears for selected or mouse-over window」[S1](https://www.hikvision.com/content/dam/hikvision/ca/how-to-document/IVMS-4200-part-3-device-groups-and-live-view.pdf) | ✅ |
| 可以全局关闭/开启每个窗口的工具条 | 「Enable Screen Toolbar Display: Show the toolbar on each display window in live view or playback」[S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) | ✅ |
| 工具条上的**图标种类与顺序可自定义**（勾选显示哪些、拖拽排序） | `System Configuration → Toolbar` [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) | ✅ |

### 2.2 工具条图标清单（**权威表**，V2.7 手册 Table「Icons on Live View Toolbar」）

按手册原表顺序 [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7)：

| # | 图标名 | 手册描述 | 作用域 |
|---|---|---|---|
| 1 | **Stop Live View** | 停止该显示窗口的预览 | **单格** |
| 2 | **Capture** | 抓图，存到 PC | **单格** |
| 3 | **Record** | 开始手动录像，文件存到 PC | **单格** |
| 4 | **PTZ Control** | 对球机启动 PTZ 模式；点击并在画面里拖动来操作 | **单格** |
| 5 | **Two-way Audio** | 与该设备建立双向语音 | **单格**，但**同一时刻只能对一台相机生效** |
| 6 | **Digital Zoom** | 开启数字放大；再点一次关闭 | **单格** |
| 7 | **Instant Playback** | 切换到即时回放模式 | **单格** |
| 8 | **Remote Configuration** | 打开该相机的远程配置页 | **单格** |

补充（同手册其它章节 + S1 教程）：`PTZ` 面板可展开成左侧常驻面板（预设/巡航/模式），
`Two-way Audio` 有 `Start IP Two-Way Audio` 变体（对 IP 相机而非录像机背板音频口）[S1](https://www.hikvision.com/content/dam/hikvision/ca/how-to-document/IVMS-4200-part-3-device-groups-and-live-view.pdf)[S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7)。

### 2.3 全局（工具栏级）控件

| 控件 | 含义 | 来源 |
|---|---|---|
| Stop Live View（全局版） | 停止**全部**窗口的预览 | [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) |
| Mute / Audio On | 全局音频开关 | [S3](https://avant.by/sites/default/files/help-documentation/instr_ivms-4200.pdf) |
| Window Division | 分屏档位 | [S3](https://avant.by/sites/default/files/help-documentation/instr_ivms-4200.pdf) |
| Save View / Save View As | 保存当前布局+绑定 | [S3](https://avant.by/sites/default/files/help-documentation/instr_ivms-4200.pdf)[S1](https://www.hikvision.com/content/dam/hikvision/ca/how-to-document/IVMS-4200-part-3-device-groups-and-live-view.pdf) |
| Resume/Pause Auto-switch、Show/Hide the Menu、Previous/Next | 自动轮巡控制 | [S3](https://avant.by/sites/default/files/help-documentation/instr_ivms-4200.pdf) |
| Full Screen | 整个预览区全屏；再点/`Esc` 退出；可 `Lock` 锁屏（解锁需管理员口令） | [S3](https://avant.by/sites/default/files/help-documentation/instr_ivms-4200.pdf)[S7](https://www.tigerseyesdv.ru/ivms-4200-prosmotr-v-realnom-vremeni/) |
| View Scale | `Full Screen / 4:3 / 16:9 / Original Resolution`（全局画面比例） | [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) |

### 2.4 关于「主码流/子码流」

| 结论 | 来源 |
|---|---|
| **不是**每格工具条上的按钮，而是**相机列表节点的右键菜单**里的「切换码流类型」 | [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7)：「Right click on the camera name in the camera list to switch the stream type」 |
| 可把常用码流类型固定到那个右键菜单上（`All Stream Types`） | 同上 |
| 全局开关 `Auto-change Stream Type`：**分屏大于 9 时自动切到子码流** | 同上（`System Configuration → Image`） |
| 单路相机的预览码流/回放码流也可在 `Group Management → Modify Camera` 里分别指定 | 同上 |

### 2.5 关于「叠加信息（OSD）」

| 结论 | 来源 |
|---|---|
| 事件命中时用**绿色方框**标出目标 | [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7)（`Enable Highlight`） |
| 可在画面上显示 VCA 规则、交易信息、温度 | 同上 |
| 「窗口左上角恒显设备名/IP、时间戳」这类 NVR 式叠加 —— 手册中**未见**统一描述 | **`未经证实`** |

### 2.6 判定

> **改写**。逐个控件的**信息架构**照抄（哪些是单格、哪些是全局、悬停才出现、可配置顺序），
> 但**内容必须换**：我们没有 PTZ、没有双向语音、没有数字放大、没有远程配置页；
> 我们有 iVMS 没有的「声学通道 / 声纹图 / 频谱 / 告警策略」，这些才是单格工具条该承载的东西。

---

## 3. 实时预览的右键菜单（**最重要的一节**）

### 3.1 菜单名与完整条目

菜单的正式名字是 **Live View Management（实时预览管理）**：
「Right-click on the display window in the live view to open the right-click menu.
The following buttons are available in the Live View Management menu」[S2](https://idoc.pub/documents/manual-of-ivms-4200v2720171127-portuguese-2nv5vpwx5rlk)[S3](https://avant.by/sites/default/files/help-documentation/instr_ivms-4200.pdf)。

**V2.7 完整清单，按手册原顺序** [S2](https://idoc.pub/documents/manual-of-ivms-4200v2720171127-portuguese-2nv5vpwx5rlk)：

| # | 菜单项（英文） | 类型 | 何时可用/禁用 | 备注 |
|---|---|---|---|---|
| 1 | `Stop Live View` | 命令 | 该格有预览时 | 全局工具条上另有一个「停全部」 |
| 2 | `Capture` | 命令 | 该格有画面时 | 抓图 → 存 PC |
| 3 | `Other Capture Modes` | **子菜单** | 同上 | 子项见 §3.2 |
| 4 | `Start / Stop Recording` | 命令（**文案随状态切换**） | 该格有画面时 | 手动录像，文件存 PC |
| 5 | `Open / Close PTZ Control` | **开关型**（Open ↔ Close） | **仅 PTZ 相机** | 「Click again to disable」 |
| 6 | `Open / Close Digital Zoom` | **开关型** | 有画面时 | 「Click again to disable」 |
| 7 | `Enable Auto-tracking` | 命令 | **仅支持自动跟踪的球机**；不适用时**不出现或置灰** | 原文「This button is only available for a speed dome that supports the auto-tracking function」 |
| 8 | `Switch to Instant Playback` | **子菜单**（时长列表） | 该路有**录像存储**（DVR/NVR/相机 SD/存储服务器）时 | 子项见 §3.3 |
| 9 | `Fire Source Information` | **子菜单** | **仅热成像相机** | 子项见 §3.4 |
| 10 | `Start / Stop Two-way Audio` | 开关型 | 设备支持双向语音 | 全局仅一台相机可占 |
| 11 | `Start / Stop IP Two-way Audio` | 开关型 | 设备支持 **IP 双向语音** | 与上一条互斥使用场景 |
| 12 | `Enable / Disable Audio` | 开关型 | 设备有音频轨 | 静音/取消静音该路 IPC 音频 |
| 13 | `Camera Status` | 命令 → 信息窗 | 总是 | 显示录像状态、信号状态、连接数；**每 10 秒刷新** [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) |
| 14 | `Remote Configuration` | 命令 → 打开设备配置页 | 总是；可再选「常规参数 / 高级参数」 | 挂在设备上的通道不可用 |
| 15 | `VCA Configuration` | 命令 | **仅 VCA 设备** | 进入设备的 VCA 配置界面 |
| 16 | `Synchronization` | 命令 | 总是 | 把设备时钟与本机同步 |
| 17 | `Show / Hide Temperature Information` | 开关型 | **仅热成像相机** | |
| 18 | `Fisheye Expansion` | 命令 → 子窗口 | **仅鱼眼相机** | 进入鱼眼展开窗口（Fisheye / Panorama / PTZ / 半球 / 圆柱 等模式） |
| 19 | `Start / Stop Master-Slave Tracking` | 开关型 | **仅枪机/筒机 + 已配主从规则** | |
| 20 | `Link to Access Control Point` | 命令 → 弹窗 | 相机可关联门禁点 | 勾 `Enable` + 选门禁点 → OK；**设置后需重新开始预览才生效**，之后工具条上出现 4 个门控按钮 [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) |
| 21 | `Unlock` | 命令 | **仅门口机 / 门外机（V 系列）** | 远程开门 |
| 22 | `Full Screen` | 开关型 | 总是 | 再点一次退出 |

### 3.2 `Other Capture Modes` 子菜单（3 项）

| 子项 | 行为 | 来源 |
|---|---|---|
| `Print Captured Picture` | 抓一帧并打印 | [S2](https://idoc.pub/documents/manual-of-ivms-4200v2720171127-portuguese-2nv5vpwx5rlk)[S3](https://avant.by/sites/default/files/help-documentation/instr_ivms-4200.pdf) |
| `Send Email` | 抓一帧并作为附件发邮件（需先配邮件参数） | 同上 |
| `Custom Capture` | 抓一帧，**先让用户编辑文件名再保存** | 同上 |

### 3.3 `Switch to Instant Playback` 子菜单（6 项）

`30s` / `1 min` / `3 min` / `5 min` / `8 min` / `10 min`
[S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7)。
语义：以**当前时刻倒推**播放该路最近一段。手册举例：「select 3 min, and the current time of the live view is 09:30:00,
then the instant playback will start from 09:27:00」。播放期间窗口右上角出现一个指示器。
即时回放**只作用于选中相机**，其余相机仍显示实时画面 [S1](https://www.hikvision.com/content/dam/hikvision/ca/how-to-document/IVMS-4200-part-3-device-groups-and-live-view.pdf)。

### 3.4 `Fire Source Information` 子菜单（热成像）

`Fire Source Region`（高于阈值的区域）/ `Maximum Temperature Region`（绿色标注）/ `Fire Source Target`（目标位置）
[S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7)。
另有平行入口：`Manual Temperature Measurement → By Point / By Frame`
（右键菜单与工具条各有一个入口），画点/画框测温，`Disable Manual Temperature Display` 清除 [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7)。

### 3.5 版本差异（**必须并列，不能取平均**）

| 版本 | 菜单项差异 | 来源 |
|---|---|---|
| **V2.02 (2014, S3)** | 菜单**结构与顺序与 V2.7 一致**（22 项都在），但：① 热成像只到 `Fire Source Information` 一层，**没有** `Show/Hide Temperature Information` 这一项（V2.7 才有）；② `Unlock` **在**（俄文原文 `Unlock («Отпереть»)`，用于门口机/门外机） | [S3](https://avant.by/sites/default/files/help-documentation/instr_ivms-4200.pdf)（P34–36） |
| **V2.7 (2017, S2)** | 在上面的基础上增加了 `Show/Hide Temperature Information`；`Link to Access Control Point` 与 `Unlock` 都在 | [S2](https://idoc.pub/documents/manual-of-ivms-4200v2720171127-portuguese-2nv5vpwx5rlk) |
| **2017 官方 How-to (S1)** | **不是完整表，只是教程挑出来的**：`Capture` / `Other Capture Modes`（含 `Print Captured Picture`、`Send email`、`Custom Capture`）/ `Start Recording` / `Open PTZ Control` / `Open Digital Zoom` / `Switch to Instant Playback` / `Start Two-way Audio` / `Start IP Two-Way Audio` / `Enable Audio` / `Camera Status` / `Remote Configuration` / `Synchronization`。**不能拿它当条目清单用** | [S1](https://www.hikvision.com/content/dam/hikvision/ca/how-to-document/IVMS-4200-part-3-device-groups-and-live-view.pdf)（P7–11） |
| **V2.02 → V2.7 的**逐项**增删** | ⚠️ 只核对了上述两处；**其余条目是否也有增删未逐条 diff**，标 `未经证实` | — |
| **V1.3.1 (2020, S6)** | 搜索摘要显示存在 `Display Shield Area`（遮蔽区域），且右键菜单条目**可能已重组** | ⚠️ `未经证实`（403，未能取证） |

### 3.6 从菜单结构上能提炼出的**设计规则**（这几条比条目本身更重要）

| 规则 | 证据 |
|---|---|
| **R1 类型化而不是平铺**：命令 / 开关（文案随状态翻转，如 `Start↔Stop`、`Open↔Close`、`Show↔Hide`）/ 子菜单（`Other Capture Modes`、`Instant Playback` 时长、`Fisheye Expansion`、`Fire Source Information`）四种形态共存 | [S2](https://idoc.pub/documents/manual-of-ivms-4200v2720171127-portuguese-2nv5vpwx5rlk) |
| **R2 设备能力决定条目存在性**：非 PTZ 相机没有 `Open PTZ Control`；非热成像没有 `Fire Source Information`；非鱼眼没有 `Fisheye Expansion`；非门口机没有 `Unlock`。原文一律是 `only available when …` | 同上 |
| **R3 状态翻转在同一位置**：录像/PTZ/数字放大/音频/全屏全是**同一项换文案**，不开第二个入口 | 同上 |
| **R4 「先抓后处理」收进子菜单**：抓图本身是一个动作，抓完要打印/发邮件/自定义文件名是它的变体，因此 `Capture` 与 `Other Capture Modes` 相邻 | 同上 |
| **R5 危险/设备侧动作与画面动作分离**：`Remote Configuration` / `VCA Configuration` / `Synchronization` / `Link to Access Control Point` 是**改设备**的，`Capture` / `Record` / `Full Screen` 是**改本机/本画面**的。手册没有显式分组，但**条目排序上前者明显靠后** | 同上（顺序即证据） |
| **R6 禁用要给原因**：手册对「不适用」的措辞是 `only available when …`。**它没有说明 UI 上是隐藏还是置灰** | 原文有「不可用」，**UI 呈现方式 `未经证实`** |
| **R7 没有多级弹窗**：最深层是二级（`Other Capture Modes → Print`），没有三级菜单 | [S2](https://idoc.pub/documents/manual-of-ivms-4200v2720171127-portuguese-2nv5vpwx5rlk) |

### 3.7 判定

> **改写**。条目清单是重要参考，但**我们只能承接其中约 1/3**（见 §5、§6）：
> 无 PTZ、无双向语音、无数字放大、无鱼眼、无热成像、无门口机、无 VCA、无门禁点；
> 而 R1–R7 这七条**设计规则照抄**——它们与具体功能无关，是「右键菜单该怎么组织」。

---

## 4. 手动录像

### 4.1 开始/停止的三条等价路径

| 路径 | 操作 | 来源 |
|---|---|---|
| 工具条 | 鼠标移到显示窗口 → 出现工具条 → 点录像图标（图标变为「停止」形态） | [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7)[S2](https://idoc.pub/documents/manual-of-ivms-4200v2720171127-portuguese-2nv5vpwx5rlk) |
| 右键菜单 | 右键画面 → `Start Recording`；录制中该项变 `Stop Recording` | 同上 |
| 停止 | 点工具条上的停止图标 / 右键菜单 `/ Select 停止` | 同上 |

### 4.2 录制状态的可视化

| 事实 | 原文 | 来源 |
|---|---|---|
| 图标**换形态**（不是变色） | 「The icon turns to ⏺」 | [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) |
| 窗口**右上角出现指示器** | 「An indicator appears in the upper-right corner of the display window」 | 同上 |
| 即时回放期间**也**在右上角出现指示器 | 同上（`5.5 Instant Playback`） | 同上 |
| 相机列表里的图标集含「正在录像」一态 | ✅ | 同上 |
| **是否闪烁** | ❌ 手册未描述闪烁 | **`未经证实`** |

### 4.3 文件落盘与命名

| 问题 | 结论 | 来源 |
|---|---|---|
| 存哪 | 本机 PC（Cloud P2P 设备在实时预览下**不支持**手动录像） | [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) |
| 路径可配 | `Device Management → System Configuration → File → Saving Path of Video Files / Saving Path of Pictures` | [S5](https://techsupportca.freshdesk.com/support/solutions/articles/17000129940/thumbs_up) ✅ 官方支持门户确认 |
| 停止后反馈 | 桌面**右下角**弹出一个小窗，显示**保存路径** | [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) |
| **文件命名规则** | ❌ 手册**没有**给出任何命名规则（无「设备名_时间戳.mp4」之类的描述） | **`未经证实`** |
| **是否自动分目录（按日期/相机）** | ❌ 手册未说明 | **`未经证实`** |

### 4.4 录像怎么再被找到（回放/文件检索）

| 入口 | 检索维度 | 来源 |
|---|---|---|
| `File → Open Video File` | 按**相机**（从 Camera Group 列表选）+ **起止时间**搜索；结果以**缩略图**列出 | [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) |
| 对结果可做 | 删除 / 发邮件 / `Save as` 另存 / **双击播放** | 同上 |
| `File → Open Image File`（抓图） | 同样的相机+时间检索；结果缩略图，可放大/打印/删除/发邮件/另存 | 同上 |
| `Remote Playback` 模块 | 按设备录像检索，与「本地文件」是**两条不同的路**（本地手动录像走上面 `File` 菜单） | 同上 |

> **对我们最关键的一条**：iVMS 把「手动录像」明确归入**本机文件**，检索入口是 `File` 菜单，
> **不是**远程回放模块。也就是说：**手动录像是操作员自己的文件，不是设备的录像计划。**

### 4.5 判定

> **照抄**（交互与状态可视化：图标翻转 + 右上角指示器 + 工具条/右键双入口 + 停止后给出路径），
> **命名与目录改写**（iVMS 没规则，我们有硬规则，见 §5.2）。

---

## 5. 设备树/相机列表的交互

### 5.1 启动预览的三种方式

| 方式 | 细节 | 来源 |
|---|---|---|
| **拖拽** | 把相机从列表拖到某个显示窗口 | [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7)[S7](https://www.tigerseyesdv.ru/ivms-4200-prosmotr-v-realnom-vremeni/) |
| **双击** | **先选中一个显示窗口**，再双击相机名 → 在该窗口起预览 | [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7)（明确写了 `after selecting a display window`） |
| **悬停播放按钮** | 鼠标悬停在相机上 → 出现 ▶ 图标 → 点它 | [S7](https://www.tigerseyesdv.ru/ivms-4200-prosmotr-v-realnom-vremeni/) |
| **整组** | 把**相机组**拖进窗口 / 双击组名；**窗口数自适应组内相机数** | [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) |
| **自定义视图** | 把保存好的视图拖进窗口 / 双击视图 | 同上 |
| **搬移** | 已出画面的窗口，可把**画面本身**拖到另一个窗口 | 同上 |

### 5.2 列表节点右键

| 对谁右键 | 菜单内容 | 来源 |
|---|---|---|
| **相机 / 相机组** | **切换码流类型**（主/子/第 6~10 路码流），可自定义常用码流集合 | [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) |
| **通道（编码通道）** | 双击或选中后 `Modify` → 改通道名/预览码流/回放码流/旋转类型/传输协议/流媒体服务器 | 同上（`4.3 Edit Channel Parameters`） |
| 热成像相关 | 右键菜单中的 `Fire Source Information` 等（**那是画面上的菜单**，不是列表上的） | 同上 |
| E-map 热点的右键 | `Modify` / `Delete` / `Live View` / `Display Alarm Information` | 同上 |

### 5.3 同一台相机被打开两次

| 结论 | 状态 |
|---|---|
| 手册中**没有任何**关于「同一相机在同一分屏里开两次」的描述 | **`未经证实`** |
| 可确证的相关约束：`Two-way Audio` **同一时刻只能对一台相机生效** [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) | ✅ |
| 可确证的相关约束：`Remote Playback` **最多 16 路同时检索**；流媒体服务器一个最多转发 64 路、分发给客户端最多 200 路 [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) | ✅ |

> **对我们的意义**：这一条**不要参考 iVMS**。我们这台相机的 `rtsp_client_limit` 实测默认 **6**
> （`docs/FA371-INTEGRATION.md`/`rtsp-stream.ts` 均引用），而 `CameraLiveSession` 的注释明确写着
> 「One viewer is a decision, not an accident」。我们**主动禁止**同一相机多格 —— 这是一个**有意的分歧**，见 §5 的下半部分。

### 5.4 判定

> **改写**。拖拽 + 双击 + 悬停▶ 的三入口**照抄**；「整组拖入」**不适用**（我们没有相机组）；
> 「同相机开两次」**反向定**：我们一相机一会话。

---

## 6. 告警配置

### 6.1 在 iVMS-4200 里，告警配置在哪

| 层 | 位置 | 内容 | 来源 |
|---|---|---|---|
| **配置层** | `Event Management` 模块（按资源类型分页：`Camera Event` / `Alarm Input` / `Exception` / 门禁 / Pyronix…） | 为每个事件类型配「布防计划 + 联动动作」 | [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) |
| **总开关层** | `Tool → Device Arming Control`：勾选设备即「武装」，**已武装设备的告警才自动上传到客户端** | 这是 VMS 侧的第二道开关，与设备侧布防计划是两件事 | [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) |
| **呈现层** | `Alarm Event`（告警与事件中心）：`Alarm` / `Event` 两个页签、弹窗告警、`Prev/Next` 翻页、`Prioritize Display of Latest Alarm` | 只读呈现，不配置 | [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) |
| **设备侧配置** | `Remote Configuration`（或右键菜单的 `Remote Configuration` / `VCA Configuration`）→ 打开设备自己的配置页 | 设备侧规则 | [S1](https://www.hikvision.com/content/dam/hikvision/ca/how-to-document/IVMS-4200-part-3-device-groups-and-live-view.pdf)[S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) |

> **分层是这台软件的核心事实**：`Event Management` 是**客户端的事件引擎**，它把设备上报的事件
> 再挂一层「客户端联动」；`Device Arming Control` 决定**客户端收不收**；
> 而**设备自己的规则**在 `Remote Configuration` 里，是另一个世界。
> 三者的关系不是「一个功能的三个入口」，而是**三套独立的规则**。

### 6.2 「布防计划（Arming Schedule）」是什么意思

| 事实 | 原文/说明 | 来源 |
|---|---|---|
| 它是**时间段模板**，不是 cron 表达式 | 2 个内置：`All-day Template`（全时）、`Weekday Template`（工作日 8:00–20:00）；另有 9 个预定义 `Template 01–09` 可编辑；以及 `Custom` | [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) |
| 编辑方式 | 在时间轴上**拖拽**画时间段；**每天最多 8 段**；可拖动/改长短/删除/复制到其它日期；保存为 `Template 01…09` | 同上 |
| 绑定关系 | 计划绑定在**「某个相机的某个事件类型」**上（每个事件类型各自选一个计划） | 同上 |
| 「武装」是把计划生效 | 设备被 `Device Arming Control` 勾上后，命中计划的事件才会上报到客户端 | 同上 |

### 6.3 「联动动作（Linkage Action）」有哪些

按手册中运动检测/遮挡/视频丢失/音频异常/人脸/越界等条目**汇总**（不同事件类型可用集合不同）[S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7)：

| 联动动作 | 含义 | 备注 |
|---|---|---|
| `Alarm Output` | 触发设备上的**报警输出口**（选端口） | 设备离线异常时**不可用** |
| `Channel Record` / `Recording` | 触发选中相机开始录像 | 措辞在不同事件里不统一 |
| `Audible Warning` | 客户端**本地声光**告警（可换 WAV） | 声音文件在 `System Configuration → Alarm Sound` |
| `Email Linkage` | 发邮件给一个或多个收件人 | |
| `Alarm on E-map` | 在电子地图上显示告警 | |
| `Alarm Triggered Pop-up Image` | 客户端弹出告警画窗 | 需先指定 triggered camera |
| `Alarm Triggered Video Wall Display` | 推到电视墙 | 需先指定 triggered camera |
| `Capture`（门禁侧） | 触发实时抓拍 | 需设备支持 |

其它 UI 事实：
- 可以 `Copy to...` 把一套告警参数**复制到其它相机/设备** [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7)；
- 弹窗告警默认以 **4 分屏**显示告警视频（热成像与目标抓拍会同时显示实时视频）[S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7)；
- 门禁「跨设备联动」里 `Recording` 明确标注「设备需支持录像」[S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7)。

### 6.4 「报警输入 / 报警输出」在 UI 里是什么

| 概念 | UI 里的样子 | 来源 |
|---|---|---|
| **Alarm Input（报警输入）** | 是**一个可被添加、可被分组、可作事件源、可作地图热点的资源对象**：`Event Management → Alarm Input` 页签名下有「启用 / 命名 / 常开常闭状态 / 布防计划 / 触发相机 / 联动动作」；也能作为 E-map 热点的类型之一；播放端还有专门的 `Alarm Input Playback` | [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) |
| **Alarm Output（报警输出）** | 是**一个可被联动的执行器**：联动动作里选端口；可作 E-map 热点；门禁侧可单独远程控制（含 `Output Delay`、脉冲时长） | [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) |

### 6.5 判定

> **不适用（作为整体）**。iVMS 的告警是**VMS 自己的事件引擎**：它在设备事件之上再挂一层客户端联动，
> 还有第二个开关（`Device Arming Control`）决定客户端收不收。
> **我们是设备自己的告警策略 API**（`/alarm_strategy` + `/alarm_condition`），**没有**中间这一层——
> 见 §7.3 的逐项对照。可迁移的只有**信息架构的形状**（策略/条件/计划/联动四段式），不是机制。

---

## 7. 键盘与鼠标约定

### 7.1 有来源的快捷键/手势

| 输入 | 行为 | 来源 |
|---|---|---|
| `Esc` | 退出全屏 | [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7)、[S3](https://avant.by/sites/default/files/help-documentation/instr_ivms-4200.pdf)、[S7](https://www.tigerseyesdv.ru/ivms-4200-prosmotr-v-realnom-vremeni/) |
| **双击某格** | 切到 **1 分屏**显示该路；若开启了 `Disconnect Background Videos in Single Live View`，**其余路的实时流会被停掉以省资源**；再双击（或 `Esc`）恢复 | [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) |
| `Ctrl` + 双击 | 显示/还原**通道零（Channel-Zero）** | [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) |
| `Ctrl + L` | 全屏下**锁定客户端**（解锁需管理员口令） | [S7](https://www.tigerseyesdv.ru/ivms-4200-prosmotr-v-realnom-vremeni/) |
| 数字键 `1`–`9` | 在 PTZ 面板里调用预置点 1–9；`[1 2 4]` 形式调用更多预置点 | [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) |
| 鼠标滚轮 | PTZ 模式缩放；数字放大模式下放大/还原（受 `Enable Wheel for Zoom` 控制） | [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) |
| **左键拖框** | 数字放大：**右下方向拖=放大，左上方向拖=还原** | [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7)、[S7](https://www.tigerseyesdv.ru/ivms-4200-prosmotr-v-realnom-vremeni/) |
| 配置项 | `System Configuration → Keyboard and Joystick`：**外接键盘/摇杆**的快捷键可自定义（需先在 General 里启用） | [S4](https://idoc.pub/documents/hikvision-ivms-4200-pc-user-manual-34wpgp6e2wl7) |
| **滚轮切分屏** | ❌ 未在任何来源中出现 | **`未经证实`** |
| **方向键在窗口间移动焦点** | ❌ 未在任何来源中出现 | **`未经证实`** |
| 通用「确认对话框」约定（删除是否二次确认等） | ❌ 手册未系统描述；仅在某些操作里见到「小窗提示保存路径」 | **`未经证实`** |

### 7.2 判定

> **照抄**（`Esc` 退出全屏、双击进单画面、`Ctrl+双击` 这类「同一动作的加强版」约定、快捷键可配置）。
> **改写**「双击 = 1 分屏并停掉其它流」这条语义：它默认**会主动停掉别的视频**，
> 而我们的实时会话是**按需建立**的（见 §5.1），不能照搬「后台续跑再断掉」的模型。

---

# 第二部分：我们的映射与落地计划

> **基线声明（重要）**：撰写本文时（2026-09-15），`MonitorView.vue` 与 `src/main/services/media/**`
> 正由**另一位 agent 并发修改**。因此下面把状态分成三类：
> **[在位]** = 我读到的代码里已经存在；**[缺口]** = 现在没有、建议补；**[决策]** = 需要 owner 拍板。
> 本文不重复规划已在位的东西，只写 delta。

## 8. 我们现在的实现基线（读代码得到的事实）

| 能力 | 现状 | 位置 |
|---|---|---|
| 右键菜单**组件** | **[在位]** `VideoContextMenu.vue`：`role="menu"`、方向键/Home/End/Enter、`Esc` 关闭、点击外部/滚动/缩放/再次右键关闭、**不越出窗口边缘**、禁用项**在菜单里写明原因**（不是只挂 `title`）、支持 `checked` 与 `separatorBefore` | `src/renderer/src/components/VideoContextMenu.vue` |
| 右键菜单**规则（纯函数）** | **[在位]** `buildCameraNvrMenu()` 在**全部能力都声明出来**时产出 10 项；可用性判断只有这一处 | `src/shared/domain/camera-nvr.ts` |
| 右键菜单的**新增本机动作** | **[在位]** `playback`（回放**本机**录像，不是设备录像计划——FA371 没有连续录像存储）、`download-detect`（下载设备检测结果文件）、`close-tile`（清空这一格）。三者各由一个**可选且缺省关闭**的能力（`localPlayback` / `detectDownload` / `tileClose`）控制存在与否，所以还没实现对应弹窗的界面显示不出死项；不声明新能力时菜单与扩展前**逐项相同**（`camera-nvr.test.ts` 钉住） | `src/shared/domain/camera-nvr.ts`、`CameraRecordingPlaybackDialog.vue`、`CameraDetectDownloadDialog.vue` |
| 右键菜单挂到**每一格** | **[在位]** `CameraVideoWall.vue` 逐格右键，`title` = 那一格的设备名；**空格子不开相机菜单**（对一台不存在的相机会显示一屏灰项）。测量：菜单项顺序、`aria-label == title`、子菜单、`Esc`（先收子菜单）与点击外部关闭、灰项在菜单里写出原因 | `src/renderer/src/components/CameraVideoWall.vue` |
| 手动录像 | **[在位]** 主进程 ffmpeg `-c:v copy` 写**分片 MP4**、停止时校验 `ftyp`/`moov`、0 字节即删并报错、登记进 `recordings`（`recordingType='manual'`、`event_type='video_mp4'`） | `src/main/services/media/camera-capture.ts`、`src/main/services/database/alarm-repository.ts` |
| 抓图 | **[在位]** 同一 RTSP 源取 1 帧 → JPEG，校验 `FFD8`/`FFD9` | 同上 |
| 录像/抓图落盘命名 | **[在位]** `<root>/<kind>/<DEVICE_UID>/<YYYY>/<MM>/<DD>/<时间戳>[_标签][_序号].<ext>`，时间戳在前 ⇒ 字典序==时间序，**永不覆盖** | `src/shared/domain/camera-nvr.ts`、`src/main/services/storage/storage-service.ts` |
| 录制指示 | **[在位]** 画面右上角 `.camera-live__rec` + 红点 + 计时器（500 ms 刷新） | `MonitorView.vue` |
| 叠加信息 | **[在位]** 设备名 / 状态 / 转封装模式 + 打码 RTSP 地址；可开关 | `MonitorView.vue`（`cameraNvrUi.overlay*`） |
| 全屏 | **[在位]** 用 `requestFullscreen()` 作用在**画面容器**上 | `MonitorView.vue`（`toggleFullscreen`、`stageEl`） |
| 告警配置 | **[在位]** 独立对话框 `CameraAlarmDialog.vue`：策略/条件两个页签，新建/修改/删除，把手册歧义（`diagosisn` vs `diagnosis`、PUT 条件的 id 风格、`discharge_*` 只写不读）做成**显式候选**并标注未验证 | `src/renderer/src/components/CameraAlarmDialog.vue` |
| 实时视频会话 | **[在位]** 每相机一个会话：回环 HTTP + 随机令牌 + ffmpeg 转封装；状态 `idle/starting/playing/rtsp-disabled/ffmpeg-missing/error`；`currentSource()` 只在 `playing` 时给出可用源 | `src/main/services/media/rtsp-stream.ts`、`src/shared/domain/camera-live.ts` |
| 视频墙（总览页 1/4/16） | **[在位]** `ChannelWall.vue` 复用 `lib/channelWall.ts` 纯函数；档位+页码持久化在 localStorage；**点击格子 = 跳到监测页** | `ChannelWall.vue`、`lib/channelWall.ts`、`stores/channelWall.ts` |
| 录像列表 | **[在位但只面向音频]** `RecordingsView.vue` 按 `recordingType` 过滤、播放走 `window.api.playback.load`（WAV/FLAC），**列里有 `采样率` 与 `音频格式` 两列** | `src/renderer/src/views/RecordingsView.vue` |

**一句话总结基线**：iVMS 的**右键菜单 + 手动录像 + 抓图 + 告警配置**这四块，本仓库**都已经有对应物了**。
所以本轮的真正工作是：**补「实时预览页自己的多格墙」、把音频录像列表接上视频录像、把布局/绑定做成可保存对象**，
而不是从零造右键菜单。

## 9. 交付物 A：我们的数据模型与 iVMS-4200 的差异

**每个概念都不迁移**，逐条给出后果。

| # | iVMS-4200 的概念 | 我们的实际 | 直接后果 |
|---|---|---|---|
| A1 | **通道（Channel）= 一路视频输入**。一台 NVR 有 N 个编码通道，`1/4/9/16` 分屏格子里每格是一路通道 | 我们的 `Channel` 是**声纹盒子的 8 路声学通道**（`CH1`…`CH8`，0 基，有 `enabled` 状态）；相机**没有通道**，它只有 `kind='acousticCamera'` 这个设备身份 | **「一路 = 一格」的等式不成立**。相机只有**一路视频**；盒子的 8 路是**多路声学数据**，其中**同一时刻只有一路有实时数据**（设备一条 WebSocket 只推一路，见 `MonitorView` 顶部注释与 `PROTOCOL-FINDINGS 4.3`）。所以「16 分屏」在我们这里**不可能**是「16 路同时实时」 |
| A2 | **View = 分屏档位 + 每格绑哪台相机**，可命名、保存、下次启动恢复 | 我们只有 `channelWall` 的「档位 + 页码」存进 localStorage；**没有「绑定」这个概念**（因为格子是设备/通道摊平出来的，不是用户摆的） | 若要在监测页做多格，**必须新增一个「绑定」数据模型**（哪一格放哪个 deviceId/通道）。这是本轮唯一真正的新数据模型 |
| A3 | **PTZ / 预置点 / 巡航 / 花纹（Pattern）/ 数字放大 / 鱼眼展开 / 主从跟踪** | **完全没有**。FA371 是固定安装的声学相机，没有云台；`docs/reference/FA371-api-spec.md` 的 32 个 HTTP 接口里没有任何 PTZ | 右键菜单里这 6 类条目**整类删除**，不做置灰「将来会有」的占位（那只会让人以为设备坏了） |
| A4 | **双向语音 / IP 双向语音 / 音频开关** | 相机有 `/pcmData`（512 点包络 + peak/rms，**只下不下发**）。`CameraAcousticPanel.vue` 用 WebAudio 做了**本地可听回放**，但**没有下行语音通道** | 「对讲」不适用；「本机监听」我们已经有（且比 iVMS 更诚实：写明了它播放的是**抽取后的包络**，不是原始 PCM） |
| A5 | **告警 = VMS 自己的事件引擎**：设备事件 → 客户端 `Event Management` 挂「布防计划 + 联动动作」→ 再由 `Device Arming Control` 决定客户端收不收 | **告警是设备自己的策略**：`/alarm_condition`（判决条件：dB / 主频 / 频谱比对 + 放电，各有独立开关）→ `/alarm_strategy`（等级/周期/灵敏度/开关，1:1 绑定条件）→ **智能巡航模式**周期执行 | 我们没有「布防计划」这个对象——**设备侧没有时间段概念**（策略只有 `timeout_duration` 1–30 s 的**检测周期**）。也**没有「联动动作」**：设备不会替我们发邮件、开报警输出口、推电视墙。**因此 iVMS 的 `Event Management` 那一整套 UI 结构无法平移**；能平移的只有「条件 / 策略 / 开关 / 周期」四段式的**信息架构** |
| A6 | **报警输入 / 报警输出**是**可添加、可分组、可作事件源/执行器的资源对象** | 设备接口里**没有** alarm input/output 端点（32 个接口清单中不存在）；`code:32` 无关 | 「报警输入/输出」**整类不适用**。若产线确实需要「相机告警 → 触发外部声光」，那是**我们的主进程**去驱动一个我们自己的输出口，**不是设备的接口** → 需要 owner 决策（见 §11 `D1`） |
| A7 | **主码流 / 子码流**：可切换、分屏 >9 自动切子码流 | FA371 的 `GET /system/video` 给出**一路** RTSP（`video_port` + `video_url`，实测 `443` / `live`）。**没有 main/sub 两路** | 码流切换**不适用**。「分屏大时自动降码流」这条优化**没有对应物**；如果将来 16 格真的跑实时，要解决的是**转封装会话数**，不是码流档次 |
| A8 | 手动录像 = **本机 PC 文件**，占位是「桌面右下角小窗 + 保存路径」，检索入口 `File → Open Video File` | 我们的手动录像也落**本机存储根**，但**登记进 `recordings` 表**（`event_type='video_mp4'`、`recording_type='manual'`、`sampleRate=0`），因此它和音频录像**同表** | 差异点：**我们能检索、iVMS 靠文件浏览**。代价是 `RecordingsView` 现在**为音频写的**（有「采样率」「音频格式」两列、播放走 `playback.load`），视频行会显示成 `0 Hz` / `WAV` — **这是本轮必须修的一个真实缺陷**（见 §11 `P0-3`） |
| A9 | 存储路径由用户在 `System Configuration → File` **自由设置** | 我们的存储根由 spec 固定，且**目录层级固定**为 `<kind>/<DEVICE_UID>/<YYYY>/<MM>/<DD>/` | 目录结构**照抄我们自己的规范，不抄 iVMS**；iVMS 连「按日期分目录」都没规定（`未经证实`）。**我们比它严格，不要往回退** |
| A10 | 客户端是**常驻的**：视图、码流、告警、录像计划都是客户端侧长期状态 | 我们的会话是**按需的**：`MonitorView.onUnmounted` 会 `stop()` + `unsubscribe()`，相机面板离开即停 ffmpeg | **「切走再回来还是那一屏」不能靠常驻会话实现**，只能靠**保存布局 + 重新起流**。这与 iVMS 的 `Resume Latest Live View Status After Restart` 目标相同、机制不同 |
| A11 | 空窗口**不解释自己**（黑） | 我们有硬规矩：没数据不画 0（`ChannelWall` 的「未监测」）、`rtsp-disabled`/`ffmpeg-missing` 必须是可读状态 | **反向**：iVMS 这一条**明确不抄** |

**三条最不能迁移的**（按对设计的影响排序）：
1. **A1** —— 「一路 = 一格」不成立；我们的「多格」是**多台相机 + 盒子的一路实时通道**，不是 N 路同时视频。
2. **A5** —— 我们是**设备自己的告警策略**，没有 VMS 事件引擎，也没有布防计划/联动动作这两个对象。
3. **A3 + A4** —— 没有 PTZ、没有对讲，右键菜单的**大半条目**在我们这里必须消失而不是置灰。

## 10. 交付物 B：落地清单

**图例**：`[在位]` 已存在（本轮不重做）｜`[缺口]` 需新增/修改｜`[决策]` 需 owner 拍板（**不是实现细节**）。

### P0 —— 下一轮必须做

| ID | 事项 | 触碰文件 | 需要主进程工作？ | 怎么验证 | 状态 |
|---|---|---|---|---|---|
| **P0-1** | **实时预览页自己的 1/4/16 分屏墙**：从 `ChannelWall.vue` 抽出**布局几何 + 分页**的复用（`lib/channelWall.ts` 的 `layoutColumns/tileCount/totalPages/clampPage/visibleTiles` 全是纯函数，可直接复用），但**新增 `src/renderer/src/lib/liveWall.ts`** 承载「实时预览页的格子模型」——因为两个页面的**格子语义不同**：总览页一格 = 一个「状态」（点击跳走），监测页一格 = 一路**活的视频/声学**（点击选中、右键出菜单） | 新增 `src/renderer/src/lib/liveWall.ts`；改 `MonitorView.vue`；**不改** `ChannelWall.vue` 与 `lib/channelWall.ts` | 否（掉帧/会话上限的守卫已在 `rtsp-stream.ts`） | 纯函数单测：`liveWall` 的档位→列数、分页夹取；渲染层手动验证：切 1/4/16 后**已建立的会话不被重建** | `[缺口]` |
| **P0-2** | **把右键菜单挂到「每一格」而不是整页**：`VideoContextMenu` 已支持坐标，`buildCameraNvrMenu()` 已是纯函数 —— 只需让**格子**提供自己的 `CameraLiveState` + `CameraNvrEnvironment`，并在菜单顶部用 `title` 显示**是哪一台相机**（组件已支持 `title`） | `src/renderer/src/components/CameraVideoWall.vue`（多格墙在这里；`MonitorView.vue` 的那一格早已有菜单） | 否 | 4 分屏下逐格右键，确认菜单里 `开始/停止录像` 的状态**只跟该格**；确认 `title` 是那一格的设备名 | **✅ 完成**（实测：`title` == `aria-label` == 被右键那一格的设备名；项序 9 项 + `抓图 / 录像` 子菜单 2 项；灰项在菜单里写出原因；空格子**不**开菜单；`Esc` 先收子菜单、点击外部关闭） |
| **P0-3** | **录像列表能播视频**：`RecordingsView.vue` 需要按 `event_type === 'video_mp4'`（或 `relative_path` 的 `.mp4` 后缀）分流——视频行**不显示采样率/音频格式**，播放**走 `<video>` + 本地路径**而不是 `playback.load` | `src/renderer/src/views/RecordingsView.vue`、可能 `src/renderer/src/lib/labels.ts`、`src/shared/i18n/messages/*.ts` | **是**：需要一个「按 recordingId 取本机可播放路径」的 IPC（audio 侧已有 `playback.load`，但它 `decodeAudioData`）。**这是本轮唯一确定需要新增 IPC 的项** | 录一段 → 停止 → 在录像列表里按 `manual` 过滤 → 双击能播；确认视频行不出现 `0 Hz / WAV` | `[缺口]` |
| **P0-4** | **给「抓图/录像被禁用」补上 iVMS 没有的那一半**：`buildCameraNvrMenu()` 已经做对了（`disabledReasonKey` + `disabledReasonText`），`VideoContextMenu` 也把原因**写在菜单里**。剩下的是**面板按钮**要与菜单**读同一份 `cameraCaptureReadiness`**（现在按钮用 `readiness.ready` + `title`，菜单用 reason key）——统一成**同一条可见文案** | `MonitorView.vue` | 否 | 断掉 RTSP（或看 `rtsp-disabled` 状态）后：菜单项写着原因、按钮旁边的告警条写着**同一句话** | `[在位]/[缺口]` 各半 |
| **P0-5** | **布局选择持久化复用 `channelWall` 的既有约定**：新增的实时预览页档位也走 `localStorage` + `try/catch`，键名沿用 `hertzinno.` 前缀（例如 `hertzinno.liveWall.layout` / `.page`），**不新开第二种持久化方式** | 新增/扩展 `src/renderer/src/stores/liveWall.ts`（与 `stores/channelWall.ts` 同构） | 否 | 切到 4 分屏 → 切走路由 → 回来仍是 4 分屏；手工把 localStorage 写成非法值 → 回落到默认档而**不是空白** | `[缺口]` |

### P1 —— 值得做，但排在 P0 之后

| ID | 事项 | 触碰文件 | 主进程？ | 验证 | 状态 |
|---|---|---|---|---|---|
| **P1-1** | **格子内的录像指示对齐 iVMS 的两处表达**：图标翻转（菜单/按钮文案随状态变，已有）+ 画面右上角指示器（已有）。**补**：指示器在**全屏**下也可见（现在 `.camera-live__rec` 在 stage 内，全屏时应该还在，需实测）；**不抄**「闪烁」（`未经证实`，且闪烁违反本仓库的可访问性取向） | `MonitorView.vue`（`<style scoped>`） | 否 | 进全屏 → 开始录像 → 指示器仍在右上角且计时在走 | `[在位]` + 微调 |
| **P1-2** | **`Stop Live View` 单格版 + 全局版**：现在只有面板顶部一对「开始/停止视频」按钮。iVMS 的语义是「单格停 + 全局停」，我们应给**每格**一个「停这一路」（`cameraLive.stop(deviceId)`） | `MonitorView.vue` | 否（`cameraLive.stop(id)` 已存在） | 4 格下停其中一格，其余三格**不受影响** | `[缺口]` |
| **P1-3** | **`Camera Status` 的等价物**：iVMS 给一个「录像状态/信号状态/连接数，每 10 秒刷新」的信息窗。我们的等价物是**每格的状态徽标 + `bytesSent` + `attempt/candidateId`**（`cameraMeta` 已经在算），把它从 `MonitorView` 的 `<dl>` 提成**可复用的格内浮层/右键信息项** | `MonitorView.vue`、可能新增组件 | 否 | 右键 → 「画面信息」显示：状态、转封装模式、已转发字节、正在用的 RTSP 候选 id | `[缺口]` |
| **P1-4** | **双击进单画面**（iVMS 最有用的一个约定）。**改写其语义**：iVMS 双击会「停掉其它视频省资源」；我们是按需会话，双击应 = **切到 1 分屏并保留已有会话**，退出单画面时**不自动重连**（重连由用户或 `playing` 状态驱动） | `MonitorView.vue`、`lib/liveWall.ts` | 否 | 4 分屏双击第 3 格 → 进 1 分屏显示第 3 格；`Esc` 回到 4 分屏且**同一批会话**仍在 | `[缺口]` |
| **P1-5** | **菜单的键盘可达性已在位**（方向键/Home/End/Enter/`Esc`、禁用项**也能被选中**以便读屏听到原因）。剩下的是**把 `Esc` 绑定到「退出全屏」**（iVMS 的第一快捷键），且不能与菜单的 `Esc` 冲突（菜单打开时 `Esc` 关菜单，菜单关闭时 `Esc` 退全屏） | `MonitorView.vue`、`VideoContextMenu.vue`（后者已 `stopPropagation`） | 否 | 全屏中按 `Esc` → 退出全屏；全屏中打开右键菜单后按 `Esc` → **先关菜单、再按一次才退全屏** | `[缺口]` |
| **P1-6** | **告警配置的入口从「面板上一个按钮」扩到「右键菜单 + 面板按钮」双入口**（iVMS 的 `Remote Configuration` 就是双入口：工具条 + 右键）。`buildCameraNvrMenu` 已有 `'alarm-config'` 项且 `enabled: true` | `MonitorView.vue`（派发已在 `onMenuSelect` 里） | 否 | 右键 → 告警配置 → 对话框打开；面板按钮同样打开 | `[在位]` |

### P2 —— 可做可不做

| ID | 事项 | 说明 | 状态 |
|---|---|---|---|
| **P2-1** | **`ChannelWall` 与实时预览页共享「布局分段控件」的观感**（`.wall__layout` 的分段按钮 + `chip--accent`）。**共享 CSS 观感、不共享组件**：两处的 `aria-pressed`/禁用语义不同 | `ChannelWall.vue`（样式）、新的 live wall | `[缺口]` |
| **P2-2** | **文件名可编辑**（iVMS `Custom Capture`）。我们的命名规则是**时间戳在前保证字典序**，允许用户改前缀会破坏这个性质；若要做，只能**加后缀**，且必须在 `camera-nvr.ts` 的纯函数里加参数而不是在调用点拼字符串 | `src/shared/domain/camera-nvr.ts` | `[决策]` |
| **P2-3** | **`File → Open Video File` 式的「按相机 + 起止时间」检索**。我们已有 `recordings.query({deviceId, from, to, recordingType})`，缺的是**UI**：在 `RecordingsView` 上加「今天/本班次」快捷区间 | `RecordingsView.vue` | `[缺口]` |
| **P2-4** | **工具条图标顺序可配置**（iVMS `System Configuration → Toolbar`）。我们的工具条只有 8 个固定按钮，做可配置的收益很低 | — | **不推荐** |
| **P2-5** | **`Instant Playback`（即时回放）**。iVMS 的即时回放读的是**设备/存储服务器上的录像**；我们的相机没有录像存储（`rtsp-stream.ts` 明确「never writes it to disk」），**只有本机手动录的片段**。所以能做的只是「回到本次会话录下的那段」——**语义不同，且价值有限** | `camera-capture.ts`、新的播放层 | **不推荐（见 §12）** |

### 明确标注为「需要 owner 决策」的项

| ID | 决策点 | 为什么不是实现细节 |
|---|---|---|
| **D1** | **要不要一个「相机告警 → 本机联动」的机制**（例如告警时自动开始录像 / 弹窗 / 出声）。设备侧**没有**联动动作接口（§9 A5/A6），因此这必然是**我们自己在主进程里做的事件引擎**——那就是 iVMS `Event Management` 的角色，**是一次产品范围扩张**，必须先决定要不要 | 它会引入「主进程常驻监听 + 新的事件规则存储 + 与设备策略的对应关系」，不是加一个按钮 |
| **D2** | **是否允许同一相机在多格里出现**。我们当前**不允许**（一相机一会话，`CameraLiveSession` 注释明确；`rtsp_client_limit` 实测 6）。若产品要求 16 格全填相机，就必须**改 RTSP/会话设计**（多会话或一路多播分发）——**这是对 `src/main/services/media/**` 的设计变更，属于 owner 决策** | 32 格 × 每路 ffmpeg 的 CPU、相机连接数上限、回环端口数量都会变 |
| **D3** | **录像列表的视频播放需要的新 IPC**（P0-3）。音频侧 `playback.load` 会把整段 base64 过 IPC（一段 10 s 音频 ≈ 5 MB）；视频**绝不能**走同一条路。选择不外乎：`file://` + 协议白名单、`app.getPath` 映射、或**复用已有的回环 HTTP 服务**（`rtsp-stream.ts` 的 127.0.0.1 + 随机令牌模型正是为此存在的）。**三条路的安全含义不同，必须 owner 定** | 触及 CSP（`media-src`）与 `onBeforeRequest` 豁免范围 |
| **D4** | **是否新增 npm 依赖**。本轮清单**没有一项需要新依赖**：分屏/分页是纯函数，右键菜单是原生 DOM，`<video>` 播本地文件不需要库。唯一可能引依赖的是「视频缩略图」（若要像 iVMS 那样给录像列表出缩略图，需要 ffmpeg 抽帧 —— **但我们的 ffmpeg 已经在位**，所以仍然不需要新依赖） | — |

## 11. 交付物 C：明确劝退的部分

| # | iVMS-4200 的做法 | 为什么**不要抄** |
|---|---|---|
| C1 | **常驻多路实时 + 客户端侧长期保持 N 路码流** | 我们的会话按需建立、离开即停（`MonitorView.onUnmounted`）。改成常驻会同时改变：CPU（每路一个 ffmpeg 转封装）、相机连接数（实测 `rtsp_client_limit=6`）、以及「关闭页面即释放」这条已经写进测试与注释的契约 |
| C2 | **云 / P2P / Hik-Connect 那一整套**（`Add Offline Device`、EHome、HiDDNS、注册管理服务器、流媒体服务器） | 我们是**单设备直连**（`connect-src 'none'`，渲染层结构上无法触达设备 IP）。引入任何「云/中转」都会**推翻这条架构约束**，而它是本仓库最值钱的一条安全设计 |
| C3 | **跨厂商设备发现/添加**（SADP、按 IP 段批量添加、`Stream Media Server`、`Video Wall` 解码器管理） | 我们只有两个产品族、两种协议（声纹盒子的 WS + 相机的 REST/WS/RTSP），**没有设备发现层**；`devices` 表是用户显式添加的。做「发现」等于做一个我们不需要的资产管理系统 |
| C4 | **PTZ / 预置点 / 巡航 / 花纹 / 鱼眼展开 / 主从跟踪** | 设备**没有云台**（FA371 的 32 个接口里没有任何 PTZ）。做成置灰菜单项会被读成「设备故障」，做成隐藏项则是永远不会被实现的分支 |
| C5 | **双向语音 / IP 双向语音 / 音频开关** | 相机只有**下行** `/pcmData`，没有上行语音通道。我们已有**本机可听回放**（`CameraAcousticPanel` 走 WebAudio），且它诚实地说明播放的是抽取后的包络 —— **这比一个假装能对讲的按钮有用** |
| C6 | **主/子码流切换、`>9 分屏自动切子码流`** | 设备只提供一路 RTSP（`video_port`/`video_url`），**没有第二路码流**。这条优化在我们这里没有对应物 |
| C7 | **`Event Management` 的「布防计划 + 联动动作 + Device Arming Control」三段式** | 设备侧**没有**时间段计划、**没有**联动动作、**没有**第二个「客户端收不收」的开关。照搬 UI 会造出三个我们无法兑现的概念（详见 §9 A5/A6 与 D1） |
| C8 | **报警输入 / 报警输出资源对象**（可添加、可分组、可作地图热点、可作联动目标） | 设备接口里不存在这两类端点。把它们画进界面就是**凭空的资源类型** |
| C9 | **`Alarm on E-map` / 电子地图 / 热点** | 我们没有地图数据来源，也没有多站点概念（设备表是扁平的）。地图的价值来自「站点多到需要空间记忆」，我们不满足前提 |
| C10 | **`Video Wall`（解码器 + 电视墙 + 场景）** | 需要物理解码设备与 HDMI 输出。我们是单机桌面应用 |
| C11 | **`Two-way Audio`「全局同时只能一台」这类隐藏约束** | 这类约束在 iVMS 里是**文档里的一句 Note**，用户很容易踩。我们如果将来做任何「全局唯一」的资源，**必须在 UI 上显式表达**，而不是靠一句 note |
| C12 | **空窗口不说话（纯黑）** | §1.3 已说明：iVMS 的空窗口不解释自己，现场会被当成故障。本仓库已有相反的硬规矩（不画 0、状态必可读），**这一条要反着做** |
| C13 | **`Instant Playback`（倒推 30s/1/3/5/8/10 min 回看）** | 它依赖**设备侧/存储服务器上的连续录像**。FA371 没有录像存储，我们只在用户点击时写本机文件。「即时回看」在我们这里只能是「回看刚才那一小段」，与 iVMS 的语义不是一回事 |
| C14 | **`Unlock` / 门禁点联动 / 门口机 / 访客 / 考勤 / 车牌 / 人脸检索** | 完全不同的产品线，与本项目无关 |

---

## 12. 一页速查：iVMS → 我们的映射表

| iVMS 交互 | 我们 | 判定 |
|---|---|---|
| 1/4/9/16 分屏 + View 对象（可命名/保存） | 相机墙固定 **1/4/9/16**；通道墙的档位**按设备真实通道数裁剪**（1→[1]、2→[1,2]、3→[1,2,4]、8→[1,2,4,8]），权威通道数取自 `GET /get_passageway` 的行数，**不是**协议常量 8；**绑定对象待做** | **改写**（档位结构照抄，View 对象需新建数据模型） |
| 悬停出现的单格工具条（8 图标） | 单格工具条：**开始/停止视频、录像、抓图、告警配置、全屏、叠加开关、画面信息** | **改写**（承载的内容全换） |
| 右键菜单 22 项 / 3 子菜单 | 右键菜单 **顶层 9 项 / 1 子菜单**（`capture`〔手动录像·抓图〕/ `toggle-fullscreen` / `copy-rtsp` / `open-external` / `toggle-overlay` / `playback` / `download-detect` / `close-tile` / `alarm-config`）；后三项是新加的本机动作，各由**可选且缺省关闭**的能力控制 | **改写**（条目大幅裁剪；**组织规则 R1–R7 照抄**） |
| 拖拽 / 双击 / 悬停▶ 起预览 | 拖拽 + 双击 + 悬停▶（**待做**；现在是设备下拉框 + 单画面） | **照抄**（交互形式） |
| 手动录像：图标翻转 + 右上角指示器 + 双入口 | **已在位**，语义一致 | **照抄** |
| 录像文件命名 | 我们有**硬规则**（时间戳前缀 + 永不覆盖 + 序号） | **我们更好，保留** |
| 录像检索：`File → Open Video File` + 缩略图 | `RecordingsView`（音频向，需接视频） | **改写** |
| 告警：`Event Management`（布防计划 + 联动动作 + Device Arming Control） | `CameraAlarmDialog`（设备 `/alarm_condition` + `/alarm_strategy`） | **不适用**（机制不同；只借四段式信息架构） |
| 报警输入 / 输出 | 无对应 | **不适用** |
| PTZ / 双向语音 / 数字放大 / 鱼眼 / 热成像 / 门禁 | 无对应 | **不适用** |
| `Esc` 退全屏、双击进单画面、快捷键可配 | `Esc` 退全屏（待做）、双击进单画面（待做） | **照抄** |
| 滚轮切分屏 | — | **不存在（`未经证实`），不要实现** |
| 空窗口纯黑 | 每格必须自己解释为什么没画面 | **反向** |

---

## 13. 还没确认的事实（不要拿它们当依据）

按「对决策的影响」排序：

1. **同一相机在同一分屏里被打开两次会发生什么** —— 手册**完全没写**。我们**主动禁止**（一相机一会话），
   但这是我们的选择，**不是抄来的结论**。（要是产品坚持 16 格全相机，见 `D2`。）
2. **手动录像文件的实际命名规则与目录结构** —— 官方手册与支持门户**都没有给出**。
   只有「路径可配置」（`System Configuration → File`，[S5](https://techsupportca.freshdesk.com/support/solutions/articles/17000129940/thumbs_up)）。
   网上流传的命名样例**未取到可靠来源**，因此本文不写。
3. **录像指示器是否闪烁** —— 手册只说「右上角出现一个指示器」，未描述闪烁或颜色。
   （我们**故意不闪**：闪烁在无障碍与「值班盯屏」两个场景下都是负担。）
4. **右键菜单里「不适用」的条目是隐藏还是置灰** —— 手册的措辞只有 `only available when …`，
   **UI 呈现方式未取证**。我们选了**置灰 + 在菜单里写明原因**（`VideoContextMenu` 已实现），这是**我们的决定**。
5. **空窗口里到底画什么** —— 无来源。我们的做法（画一句「为什么没画面」）是**本仓库的规矩**，不是 iVMS 的做法。
6. **V1.3.1（2020）的右键菜单条目是否已重组、`Display Shield Area` 的确切位置** —— 官方 CDN 对本机 **403**，
   只有搜索摘要的片段，**整体标 `未经证实`**。如果将来要「以最新版为准」，需要一台能访问 hikvision.com 的机器重新取证。
7. **滚轮是否能切分屏 / 方向键是否能在窗口间移动焦点** —— 在 S1–S4 中均**未出现**，标 `未经证实`；
   **不要实现**，除非产品明确要求（那会是一个与 iVMS 不同的新约定）。
8. **V2.02(S3) 与 V2.7(S2) 之间菜单项的增删是否还有其它变化** —— 本文只对比到了两个版本，
   中间版本（V2.4/V2.5/V2.6）未取证。

**取证可复现命令**（供后续复核，不改动工作区）：

```powershell
# S1 / S3 是 PDF：下载后本地抽文本即可（pypdf 装到临时目录，不污染工作区）
$tgt = "$env:TEMP\pyext"; python -m pip install --quiet --target $tgt pypdf
$env:PYTHONPATH = $tgt
# 然后把 PDF 逐页 extract_text() 落成 .txt 再 grep
```

---

## 14. 附：本次研究涉及的原始条目出处（便于复核）

| 本文结论 | 出处（可直接核对的最小单位） |
|---|---|
| 默认视图只有 1/4/9/16 | S4「5.1.3 Start Live View in Default View Mode」 |
| 自定义分屏 3×3/4×4/5×5/6×6、最多 5 套、可 Joint | S4「5.6 Customize Window Division」 |
| `>9 分屏自动切子码流` | S4「24.3 Set Image Parameters → Auto-change Stream Type」 |
| 工具条图标 8 项及顺序 | S4「24.5 Set Icons Shown on Toolbar → Table 24-1」 |
| 工具条在悬停/选中时出现 | S1 第 6 页「Window Toolbar」 |
| 右键菜单 22 项及顺序 | S2 第 38–40 页「Live View Management」表；S3 第 34–36 页同表 |
| `Other Capture Modes` 三个子项 | S2/S3 同上；S1 第 7 页 |
| `Instant Playback` 六个时长 | S4「5.5 Instant Playback」 |
| 录制中右上角出指示器 | S4「5.4.1 Manually Record Video」 |
| 保存路径设置位置 | S5（官方支持门户） |
| `Device Arming Control` 是第二道开关 | S4「9.2.1 Enable Receiving Alarms from Devices」 |
| 布防计划每天最多 8 段、9 个模板 | S4「9.1.9 Configure Arming Schedule」「9.1.10 Configure Custom Arming Schedule」 |
| 联动动作清单 | S4「9.1.1 Configure Motion Detection Alarm」等各事件条目 |
| `Esc` 退全屏 / `Ctrl+L` 锁屏 / `Ctrl+双击` 通道零 | S4「5.5 Instant Playback」「5.10 More Functions」；S3「Full Screen」；S7 |
| 双击 = 1 分屏并停掉其它视频 | S4「24.2 Set Live View and Playback Parameters → Disconnect Background Videos in Single Live View」 |

---

## 15. 一手手册复核（UD02161B，© 2016，204 页）

上面 §1–§14 的来源是**较新版本**的 iVMS 手册与官方门户（S1–S7）。本节记录一次**一手手册**的复核：业主提供的官方 PDF
`IVMS_4200_User_Manual.pdf`（*iVMS-4200 Client Software User Manual*，`UD02161B`，© 2016 Hangzhou Hikvision，**英文，204 页**，
sha256 前缀 `1122778a`）。它**比 S4 旧**，所以本节的用法是：**佐证**较新的结论、并**标出版本差异**，而不是取代 §1–§14。

### 15.1 取证方法与可复现命令

抽文本用的是仓库里那个一次性的 `scripts/pdf-to-text.py`（pypdf 装到临时目录，不污染工作区）：

```powershell
$py = Join-Path $env:TEMP 'hz-pypdf'
python -m pip install --quiet --target $py pypdf
$env:PYTHONPATH = $py
python scripts\pdf-to-text.py "<IVMS_4200_User_Manual.pdf>" "$env:TEMP\ivms4200-manual.txt"
```

**页码换算（已与目录逐条核对）**：抽取文本里的运行页眉是两行 `User Manual of iVMS-4200` + 页码 `N`，**位于该页正文之前**；
因此「页眉行之后、下一个页眉行之前」的正文属手册第 `N` 页。下文所有 `pN` 均按此换算。

### 15.2 六块内容与章节对应

| 界面模块 | 手册模块 | 章节 | 页 |
|---|---|---|---|
| 设备管理 | Device Management（增删改 + 分组） | Ch3 | p14–30 |
| 实时检测 | Main View（实时预览 + 抓图/录像） | Ch4 | p31–52 |
| 回放 | Remote Playback（检索/回放/导出） | Ch5 | p53–74 |
| 事件中心 | Event Management（布防/联动/参数） | Ch6.1–6.13 | p75–93 |
| 告警记录 | Alarm Event module（**与事件同一个面板的两个 tab**） | Ch6.14 | p93–97 |
| 系统设置 | System Configuration + Account Management | Ch17 | p177–187 |

**两条结构性认识**：① 手册把「配置」（Event Management）与「查看」（6.14）分成两个模块，且**告警与事件在同一个面板里是两个 tab**
——本仓库把「告警记录」与「事件与告警中心」做成两个独立页面，是**我们自己的切法**；② `Log Search`（Ch16）与 `Storage Schedule`（Ch5.1）
在 iVMS 里是**独立模块**，不属于「系统设置」。

### 15.3 一手手册佐证了本文的哪些结论

| 结论 | 一手出处 |
|---|---|
| 默认视图只有 1/4/9/16 | p34（1150–1151） |
| 自定义分屏最多 5 套、可 Joint 合并相邻窗口 | p44–45（1495、1503–1504） |
| 回放最多同时 16 窗口，超 16 的自定义分屏对回放无效 | p44–45（1509–1512） |
| `Instant Playback` 六个时长 30s/1/3/5/8/10min，**前提是视频已录在设备侧** | p42–44（1432–1447） |
| 录制中右上角出现指示器、停止后弹保存路径 | p39–42（1361–1364） |
| 手动录像/抓图各有按「设备 + 起止时间」检索的页面 | p39–42（1366–1424） |
| 布防计划每天最多 8 段、有 `Template 01–09` | p75–77（2516–2535） |
| 联动动作共 7 类；**抓图不是联动勾选项**（走存储计划） | p75–93（各表并集，2484–2486） |
| 事件回放有 `Previous/Next Event`，**pre-play 默认 30 秒** | p67–68（2209–2210、2223–2224） |
| 下载三模式 + **限速 0–32768 kbps** + 进度 + Stop；按标签下载 = 标签前后各 30 秒 | p60–66（2089–2124） |
| `Device Arming Control` 是第二道开关 | p93（3085–3086） |
| `Ctrl+双击` 通道零 / 辅助屏最多 3 块 / 状态面板每 10 秒刷新 | p51–52（1694–1715） |
| 账号两类（Administrator/Operator）、密码 ≥6、最多 50 个、用户名禁用 `/ \ : * ? " < > \|` | p177–178（5198–5205） |
| 告警声音按类型绑定、可自定义、可试听、**仅 `*.wav`** | p185（5432–5448） |
| 邮件：SMTP、**端口默认 25**、可选认证、可选 SSL、**最多 3 个收件人**、可发测试邮件 | p186（5454–5474） |
| 系统配置有 `Default Value` **一键恢复全部默认值** | p178（5227） |

### 15.4 已发现的**版本差异**（一手 2016 vs 较新的 S4）

| 项 | 一手 UD02161B（2016） | 较新版本（S4） |
|---|---|---|
| 自定义分屏规格 | **3×3 / 4×4 / 5×5**（p44，1502） | 3×3 / 4×4 / 5×5 / **6×6**（§1.1 表） |
| 实时预览右键菜单条目数 | 章首列 **20 项**（p31–34，1062–1131） | **22 项**（§3 表） |
| 部署方式 | 另有 **Hik Cloud P2P**、Transcoder、Video Wall 独立成章 | 同 |

> 结论：**以较新版本为准**；本节的一手手册用于**佐证交互细节**，不用于断言「iVMS 没有某功能」。

### 15.5 一手手册**明确未说明**的清单（不要假设存在）

以下条目在 UD02161B 里**查不到**，本节按规矩标「手册未说明」，**不得据本手册假定其存在**：

- **告警等级 / 严重度 / 优先级** —— 13 张告警配置表与 6.14 三个小节里**一个字段都没有**；唯一近似物是弹窗排序策略
  `Prioritize Display of Latest Alarm`（6.14.1 默认**不勾**、6.14.3 默认**勾选**），那是**显示策略，不是等级**。
- **告警确认（acknowledge）** —— 全书没有这个概念，6.14.1 只有 `Clear`（删除）与 `Note`（备注列）。全书唯一出现的
  「Acknowledgement」在 p3 商标声明，与告警无关。
- 可保存的**视图套数上限**；自动巡切的**默认与可选间隔值**；回放的**倍速档位清单**（全书唯一速度数值是 5.2.7 的 `1X`/`8X`）；
  时间轴**最小时间分辨率**；**标签数量上限**；下载文件的**格式与命名**；`Log Expiry Date` 的默认值与范围。
- 账号管理的**具体权限项清单**（复选框逐项未列出）；**组数量上限与嵌套层级**；账号管理页与 File 页签的**子项划分**。
- 在线设备发现的**协议**；弹窗告警**是否自动关闭**、**能否单独静音**、**能否跳转到告警记录/回放**。
- 告警条件持续存在时**是否重复上报 / 有无去重抑制**；`Device Exception`（归告警）与 `device disconnection`（举为客户端事件）
  的**确切边界**——手册两处口径矛盾，**不要照抄**。

### 15.6 属于**本仓库自己的设计**、不得写成「参照 iVMS」的项

- **告警等级划分与严重度**（业主要求新增）—— 手册无此概念，出处是我们自己。
- **告警确认**（我们已有，超出 iVMS）—— 因此「设备检测日志没有确认接口就如实回报不支持」是合理设计，不必为对齐而移除。
- **录像指示器不闪烁** —— 见 §13.3，是我们的决定。
- **`Instant Playback` 的改写** —— 设备侧无连续录像存储，我们把它改写成「回放**本机**录像」，语义与 iVMS 不同。

### 15.7 本轮路线图（业主已确认「全部都做」）

| # | 工作流 | 为什么排在这里 |
|---|---|---|
| 1 | **系统设置**：账号 RBAC / 告警声音库 / 邮件 / 一键恢复默认 | 告警联动要能「选告警音」，声音库属于系统设置；先做可避免两轮同时改同一份设置形状 |
| 2 | **告警模型升级**：等级划分 + 备注 + 联动扩展 + 4 分屏弹图 + 图标闪烁 | 等级与备注都要加字段 ⇒ **一次 DB 迁移做完**，分两轮就是两次迁移 |
| 3 | **回放时间轴与日历**：点选跳转/滚轮缩放/类型配色 + 标签打点与按标签导出 | 直接升级 `/recordings` 与回放弹窗 |
| 4 | **告警记录 → 一键跳到本机录像**：回退 30 秒 + 上/下一事件 | 建立在前一项之上 |
| 5 | **自定义分屏 + 视图对象**（≤5 套 / 3×3、4×4、5×5 / Joint 合并） | 唯一会引入**新的可保存数据模型**的一项，最贵，放最后 |

**❌ 已取消：布防时间表（原第 3 项）。** 业主在看过 §15.9 的取证后决定**不做时间闸门，设备 24 小时检测**。
这条**不是遗漏**，是有意为之——理由见 §15.9。

> ⚠️ **上面这张表是"计划"，不是"完成情况"。** 五条里真正做完的是 ① 与 ④；② 只做了等级/备注/迁移，
> ③ 与 ⑤ 只做了**模型层**（纯函数 + 测试），UI 都没接线。**逐条对照见 §15.17。**

**每次「一键恢复默认」的范围**：只重置**系统设置项**的默认值，**绝不动**设备、通道、录像/录音文件、告警记录与账号。
手册原文是「恢复全部系统配置」，照抄会变成「一个按钮删掉用户的数据」——这一处我们**有意收窄**。

### 15.8 告警等级与联动：**我们已经有基础，不要再造第二套**

业主在同一轮里要求「告警也要做告警联动和等级划分」。动手前先记清楚现状——**本仓库已经有一套等级模型**，
而且是按本项目那条「不猜」的规矩建的：

```ts
// src/shared/domain/event-center.ts:79
export type EventSeverity = 'info' | 'warning' | 'critical' | 'unknown'
```

`'unknown'` 在这套模型里**是合法且预期会出现**的取值，**不是兜底**（`:69-78`）：

- 相机 `alarm_level` 的**读侧枚举是 `0,1,2,3`、写侧是 `1,2,3,4`**，两套互相冲突，而且真机（`192.168.110.235`）
  **从未回过这个字段**（`FA371-API-DELTA.md` §8.3 C15/C21）；
- 声纹设备（AE08）的告警协议里**根本没有等级字段**（`AlarmEvent` 只有告警位图）。

`deriveEventSeverity()`（`:362`）因此只有两条分支：`localAlarm → 'warning'`，其余 → `'unknown'`。其中
**声纹告警的 `'warning'` 不是从设备读到的等级**，而是**这条记录本身的语义**（`alarms` 表里的行只在设备上报过
非零告警位时才存在）。函数的注释把话说尽了：「未来的设备若给出可验证的等级，只需要在这里加一个分支」。

联动侧也已经有雏形：`alarm-linkage.ts:180` 的 `minAlarmLevel`（默认 `0`）与跳过原因 `'below-min-level'`（`:246`），
但注释（`:176`）说明它**只在设备真的回了 `alarm_level` 时才生效**——而设备从没回过，所以这道闸门**目前是空转的**。

**因此第 2 轮的设计原则（不是新增一套，而是把已有的补齐）：**

1. **复用 `EventSeverity`**，不新造等级词表；`'unknown'` 继续保留原义，**不得为「好看」把未知的猜成某一级**。
2. 等级从「由来源硬推导」升级为**可配置的映射**（来源/告警类型 → 等级），但**默认值必须与今天逐字一致**
   （`localAlarm → warning`、其余 `unknown`）——改默认值是行为变更，不能顺手做。
3. **等级在告警产生时快照到告警行上**：事后改映射不得改写历史告警。
4. **`minAlarmLevel` 的语义要重新讲清楚**：它今天是「设备原始 `alarm_level`」的闸门（空转）；要不要改成
   对**我们自己的等级**生效，是一个**语义变更**，必须在代码注释与本节里写明，并给出迁移含义。
5. 联动动作按手册可以更细：手册 7 类里我们有 4 类（录像/弹窗/提示/邮件），本轮补**「可选告警音」**
   （音源来自第 1 轮的告警声音库，第 17.2.7 节，仅 `*.wav`）。手册里**没有 PTZ 联动**，
   「抓图」**不是**联动勾选项（走存储计划），这两条照手册记着，不要「补全」出一个手册里不存在的东西。
6. 等级要**看得见**：告警列表加等级列与筛选、弹窗按等级着色；`6.14` 的「图标闪烁」「Note 备注列」
   「4 分屏弹图 + 最新替换最早」按手册补齐（出处见 §15.3 与 §9 表）。

> 一句话：**iVMS 一手手册里没有任何等级概念**，所以这一项从第一天起就是**我们自己的设计**；
> 而我们已经有一套用得住的 `EventSeverity`——任务是把「可配置 + 可见 + 可联动」补上，而不是另起一套。

### 15.9 布防时间表：**❌ 已取消——设备 24 小时检测**

> **决定（业主）：不做布防时间表，设备 24 小时检测。**
> 因此本项目**没有**任何「时段内才布防 / 时段外不产生告警」的概念。这是**有意为之，不是遗漏**——
> 界面上不要出现任何暗示「可以按时间布防」的控件，也不要出现「布防时段外」这类状态词。
>
> 下面这份取证保留下来有三个用处：① 它是这个决定的**依据**；② 它约束任何日后想动「时间」的人
> ——尤其**回放页的日历/时间轴不是时间表**，两者语义不同，不要复用同一套控件语义；
> ③ 若将来产品真的要加时间维度，从这里开始，不必重新取证。
>
> （以下为取消前所做的取证，事实与结论未变；「实现纪律」一节现在是**将来若要做**时的前提。）

iVMS 的「布防时间表」是**设备侧**概念：时段内该事件才布防，时段外根本不产生告警。**我们没有这个前提**，
这一点在动手前已经取过证：

- **声纹设备（AE08）**：`GET /get_alarm_system` 的**全部**参数是 `dalSPLODEn/Thre`（SPL 过载）、
  `dalSPLSDDEn/Thre`（突降）、`dalSPLSIDEn/Thre`（突升）、`dalSPLStaDetEN/Thre`（稳定性）、
  主频上下限、频带能量比——**一个时间/时段字段都没有**（`PROTOCOL-FINDINGS.md` §3.5，259–310 行）。
  全文涉及时间的只有 `dsyNTPInterval`（对时）与 `dsyHeatInterval`（热力图推送间隔），都与告警布防无关。
- **声学相机（FA371）**：告警模型是「策略 + 条件」，策略里有**检测周期（秒）**、灵敏度、等级，
  但**没有布防时段**。
- ⚠️ **未验证**：以上只能说明**我们已测得/已列出的端点集里没有**布防时段端点，**不等于**两家的固件一定没有
  一个我们没探过的计划端点（本仓库的规矩：没有测量就不能断言「不具备」）。

**因此本产品的时间表语义只能是：它决定「本机是否响应」，不决定「设备是否检测」。**
这会带来一条必须在界面与代码注释里说清的后果，也定下了实现纪律：

1. **绝不因为「时段外」就丢掉告警记录。** 设备照样在 24 小时检测，告警记录是**证据**；
   我们的时间表只用来闸门**我们自己的反应**（联动动作：录像/弹窗/提示/告警音/邮件）。
2. 告警记录上要能看出它**落在时段内还是时段外**（例如「已布防」/「布防时段外」），
   否则操作员会以为「时段外就没发生过」。
3. 系统设置页与告警规则页都要有一句实话：**本时间表不改变设备侧的检测行为**。
4. 时间表控件与第 4/5 轮回放的日历/时间轴**不是一回事**，不要为了省事复用同一套控件语义——
   手册里时间表与录像计划确实共用一套控件（§15.3），但那是设备侧计划，与我们的本机闸门不同。

> 一句话：**iVMS 的时间表是「设备布防」，我们不做它——设备 24 小时检测。**
> 上面那套「本机响应闸门」只在**将来产品明确要求时间维度**时才适用；**现在不要实现**。

### 15.10 「告警 → 本机录像」（第 5 轮）：**链路已在位，但有三条前提必须先说清**

动手前核过：这条链路**已经存在**，不是要从零接：

- 写：`alarms.recording_id`（`schema.ts:118`）+ `RecordingRepository.linkRecording(alarmId, recordingId)`（`alarm-repository.ts:217`），
  由**联动动作「录像」**产出（`linkage-actions.ts:250/261`）。
- 读：`alarm-repository.ts:67` → `AlarmEvent.localRecordingId`；待处理记录也带 `recordingId`（`pending-alarm-store.ts:187`）。
- 用：`AlarmsView.vue:477` 已经在**告警详情**里挂了 `<RecordingPlayer :recording-id="detail.localRecordingId">`。

所以第 5 轮缺的是**「跳转 + 回退看前因 + 上/下一事件」这套交互**，不是数据通路。但有三条前提必须在实现与界面里说清：

1. **它依赖联动动作「录像」被打开。** 该动作默认是关的，因此**大多数告警没有关联录音**——
   跳转按钮必须在这种情形下明确说「这条告警没有本机录音（未启用联动录像）」，而不是给一个点不动的按钮。
   `AlarmsView.vue:12` 的注释已经写过这件事，继续沿用。
2. **它的目标通常是「录音」而不是「录像」。** 盒子的环形缓冲捕获出来的是**音频**（`stream-manager.ts:392`），
   只有相机的手动录像才是视频（`camera-capture.ts`）。所以「一键跳到本机录像」在声学设备上的实际语义是
   **跳到这条告警对应的本机录音**。界面文案要按设备族说对，不能笼统写「录像」。
3. ⚠️ **「回退 30 秒」与环形缓冲的预录时长冲突。** 手册的 `Pre-play for` 默认 **30 s**（p180–181，5302），
   而我们环形缓冲的**告警前**预录默认只有 **10 s**（`ringBufferPreSeconds`，post 默认 20 s）——
   **预录只有 10 秒时不可能回退 30 秒**。诚实做法是：从**实际存在的预录起点**开始播，
   并如实说明这条告警实际有多少预录；是否把默认预录时长提到 ≥30 s，是**产品决定**，不要顺手改。

> 一句话：把「跳转 + 回退 + 上/下一事件」做出来，同时**把没有录音的情况、目标是音频而非视频、
> 以及预录不足 30 秒**这三件事说清楚——否则这个功能会在最需要它的时候给不出东西。

### 15.11 回放时间轴与标签（第 4 轮）：**「下载」是两件不同的事，别混成一件**

手册 5.2.1 的下载有三种模式（按文件 / 按日期 / 按标签），都带**限速 0–32768 kbps**、进度条与 Stop；
按标签下载的范围是**标签点前后各 30 秒**（p60–66，2089–2124）。动手前必须把两件事分开，否则会实现错：

**(a) 「设备 → 本机」的下载** —— 手册讲的是这个（从 DVR/NVR/存储服务器取文件到 PC），限速也是为它设的。
我们**已经有**：相机的检测结果文件（`detect-library-service.ts`）与声纹设备的告警录音（`alarm-service.downloadRecording`）。
所以「限速 + 进度 + 可中断」这套 UI 若要做，应该挂在这条路上，而不是凭空新建。

**(b) 「本机 → 用户选定路径」的导出** —— 「按标签导出前后各 30 秒」隐含的是**把已有文件的一段剪出来另存**。
**这个能力我们没有。** 实测搜索的结果：没有 `showSaveDialog`、没有导出类 IPC、没有对已有文件做 `-ss/-t` 的剪切；
现有的只有：录制时 ffmpeg 定长（`linkage-actions.ts:93` 的 `-t <seconds> -c:v copy`）、
`video-file-server.ts` 的 **Range 播放**（只读，不落盘）、以及环形缓冲在**告警发生时**产出的音频片段
（`recording-service.ts:268`，那是录制路径，不是导出路径）。

**可行性判断**（这两条决定了工作量）：

- **音频（WAV）**：可以在纯 TS 里切片——按样本切 `Float32Array` 再复用现成的 `wav-writer.ts` 写文件。
  **不需要 ffmpeg**，也不需要新依赖。
- **视频（MP4）**：需要调用**已在包内的 ffmpeg** 做 `-ss/-t -c copy`。注意 `-c copy` 只能切到关键帧，
  所以「前后各 30 秒」的边界**不会是帧精确的**——这一点必须如实说明，不要承诺精确到帧。

**(c) 标签（Tag）我们完全没有这个模型。** 手册里标签是回放文件上的书签（默认名 `TAG`、可改名、可跳到标签位置）。
我们要做就得新建一张表 ⇒ **需要一次 DB 迁移**。第 2 轮已经要用一次迁移（`SCHEMA_VERSION` 5 → 6，加 `severity` 与 `note`），
标签可以是 6 → 7。**建议分成两次迁移**：把「告警等级/备注」和「录像标签」塞进同一次迁移会让两件无关的事互相牵连，
而本仓库的迁移机制本来就是版本化、可重复执行的，多一次迁移的代价远小于耦合。

**已经有的、可以直接用的**：手册的「时间轴按录像类型配色」与「Filter 只看某类录像」，
在我们的数据里对应 `recordingType`（`manual` / `alarm`）与 `event_type`、`container_format`——
**筛选与配色的数据已经存在**，缺的只是时间轴这条 UI。
>
> **进展（已落地）**：时间轴的**几何模型**已经写好并自带测试 —— `src/renderer/src/lib/playbackTimeline.ts`
> （纯函数、零依赖、零 i18n）与 `tests/playback-timeline.test.ts`（**27 个断言全过**）。
> 它提供：`timeToX` / `xToTime`、`placeSegments`（裁剪到窗口、丢掉零长度段、标记两端是否被裁）、
> `chooseTickStep` / `ticksFor`（**按绝对时间对齐**，拖动时标签不漂移；标签间距不小于设定像素）、
> `zoomWindow`（**锚点像素位置不变**——这是滚轮缩放的全部意义）、`panWindow` / `clampWindow`（不拖出空白轴）、
> `segmentAt`（命中测试）、`stepEvent`（手册 p67–68 的 `Previous/Next Event`；没有更远的一段时返回
> `undefined`，而不是绕回第一段——绕回去会让按钮说谎）。
> **尚未接线**：还没有组件用它（第 ③ 轮接），也还没并入项目级类型检查。
> **两处我们自己定的**（写在模块文件头）：`TICK_STEPS_MS` 刻度表与最小标签间距、以及缩放锚点语义。

### 15.12 自定义分屏与视图对象（第 6 轮）：**和本仓库一条既有决定正面冲突**

手册 4.6 的自定义分屏（最多 5 套、3×3/4×4/5×5、拖选相邻窗口 `Joint` 合并成一整格，p44–45）
与 4.1 的「视图 = 档位 + 每格绑哪台相机，可命名保存、下次启动恢复」，对我们来说是**两件新的东西**，
其中第二件**与一条既有决定冲突**，必须在动手前解决，不能糊过去。

**冲突**：`stores/liveWall.ts` 的文件头（第 9–11 行）明确写着格子分配**只在内存里、刻意不持久化**，理由是：

> 「它指的是『哪台相机在哪一格』，而设备 id 是数据库主键，重启后可能对应另一台设备 ——
> 把一个可能过期的 id 从磁盘上恢复出来，会在启动时静默拉一路谁也没要求的视频。」

而手册的「视图对象」恰恰要求把**每格绑谁**存下来并在重启后恢复。**照抄就会破坏这条决定。**

**另外，当前的档位模型表达不了自定义分屏**：`CameraWallLayout = 1 | 4 | 9 | 16`，
每档只用 `cameraWallColumns()` 给出一个**统一列数**（`lib/cameraWall.ts:68-73`）。
而 `Joint` 合并出来的是**不等宽不等高的格子**（`{row, col, rowSpan, colSpan}`），
用一个「列数」是描述不了的 ⇒ 需要一个新的格子几何模型，且必须仍然是**纯函数**（决定只在 `lib/cameraWall.ts` 里）。

**建议的解法（两条一起用）**：

1. **存稳定身份，不存数据库主键。** 设备已经有稳定的 `deviceUid`（相机是 `fa371:<ip>:<port>`，
   盒子是 `mac:…`）。视图里存 uid；恢复时**重新解析**成当前设备，解析不到的格子**留空并说明原因**
   （沿用既有的「为什么这格空了」的 notice 机制），而不是塞一个过期 id 进去。
2. **恢复视图时绝不自动起流。** 恢复只把绑定画进格子；要不要真的拉流仍然由既有的自动起播策略
   （`decideCameraAutoPlay()`，一次进程一次尝试）决定。这条同时守住了上面那句原始理由的**真实关切**
   ——「静默拉一路谁也没要求的视频」——而不需要放弃视图对象这个功能。

**可复用的持久化约定**：`hertzinno.` 前缀 + `try/catch`（`stores/liveWall.ts:52-70`、
`stores/channelWall.ts`）。**最多 5 套**这个上限来自手册（1495），照抄；本地存储的容量与坏值修补
沿用现有写法（「坏值修补成合法模型」在 `lib/cameraWall.ts` 已有测试）。

> 一句话：**自定义分屏是纯新增（但需要新的格子几何模型）；视图对象则要先解决「绑定要不要落盘」这个冲突**
> ——解法是「存 uid + 恢复时重新解析 + 不自动起流」，不是把 uid 换成 id 或者干脆不做。
>
> **进展（已落地）**：几何模型已经写好并自带测试 —— `src/renderer/src/lib/cameraViewDivision.ts`
> （纯函数、零依赖、零 i18n）与 `tests/camera-view-division.test.ts`（**23 个断言全过**）。
> 它提供：`createUniformDivision` / `validateDivision`（八种问题码，逐条点名而不是一个布尔）/
> `areJoinable` / `joinCells`（`Joint`）/ `splitCell`（**本模块自加**，因为不可逆的合并在界面上是敌意的）/
> `normaliseDivision` / `normaliseViews`（≤5 套、绑定数组对齐格子数、重复 id 换掉、坏值丢弃）。
> 两条**我们自己定的**取值也写在文件头：`MAX_DIVISION_CELLS = 16`（手册那条 16 是回放窗口数）、
> 以及绑定的语义是 **`deviceUid` 字符串、结构修补不解析身份**。
> **尚未接线**：它还没有被任何组件或 store 使用（第 5 轮接），也还没并入项目级类型检查
> （当前整棵树因另一轮正在补目录翻译而不可编译，见 §15.13 的说明方式）。
>
> **进展（第二批，已落地）**：
>   - 纯函数 `bindViewToDevices(view, resolveUid)`（同文件）：把存下的 `deviceUid` 解析成「每格放哪台设备」。
>     解析不到就**留空并记下原因**（`missing` / `duplicate`），**绝不猜**——把 uid 当 id 用、或按索引
>     硬塞一台别的设备，会让操作员在写着 CH3 的格子里看到 CH5 的画面。绑定测试见
>     `tests/camera-view-division.test.ts`（现共 **28 条断言全过**）。
>   - `stores/liveWall.ts` 加了视图层：`views` 状态 + `saveViewAs` / `renameView` / `deleteView` /
>     `bindViewSlot` / `resolveView`，落盘键 `hertzinno.cameraWall.views`（沿用既有 `hertzinno.` 前缀），
>     读取一律过 `normaliseViews` 修补。达到 **5 套上限时如实回报 `'limit-reached'`**，不悄悄丢掉最旧的一套。
>     守卫见 `tests/camera-view-store.test.ts`（**5 条全过**）：store **绝不导入 cameraLive、不发
>     `window.api.cameraLive`、不访问 `cameraLive.` 成员**，因此恢复视图在结构上不可能拉起任何一路流。
>   - ⚠️ **还剩一件必须做的**：现有 `CameraWallModel` 的档位是固定的 `1 | 4 | 9 | 16`（N 个等大槽位），
>     而 `Joint` 合并后的格子数可能是 8 这种**既不是平方数、也不在档位表里**的值——
>     **模型表达不了自定义分屏**。所以 `resolveView()` 目前只产出「决定」，**不改模型**；
>     第 5 轮剩下的工作就是把这个模型泛化成「一组矩形格子」，再把视图接到墙上。
>     这一点在 store 的注释里也写明了，免得下一个人以为已经能应用。

### 15.13 i18n 双向审计工具，以及它当场揪出的两个真缺陷

第 ⑦ 项要「清理 i18n 孤儿键」。上一轮我是**手工**找出 `overview` 整个块（12 键 × 4 语言）没人引用才删的——
手工做一次可以，做成规矩不行，所以新增 `scripts/i18n-orphans.cjs`（用仓库已有的 `typescript` 解析成 AST，
**不新增依赖**）。它同时查两个方向：**孤儿键**（目录里有、源码没人用）与**缺失键**（调用点引用了、目录里没有）。
后者更危险：界面会直接渲染出裸 key。

**两个方向必须用两个不同的集合**（这是这个脚本做错两次的地方，已写进文件头）：

- 「缺失键」要**精确** ⇒ 只认**调用点**（`t('a.b')`、`te`/`tm`、`xxx.t(...)`、以及名字以 `Key` 结尾的属性），
  这样文件路径之类的噪声（`'app.asar.unpacked'`）和注释里的字样都进不来。
- 「孤儿键」必须**宽松** ⇒ 源码里出现过一个**与词条完全同名的字面量**就算被引用，因为键常常经变量/映射表
  传进 `t()`（`channelStateLabelKey(state)`、`const KEYS = ['a.b']`），从调用点追不到。
  这里的误报方向是**漏报孤儿**（少清理几个键）；反过来会让人**删掉界面正在用的词条**。**宁可漏报，不可误杀。**

**当场查出的两个真缺陷（已修）：**

| 缺陷 | 证据 | 后果 | 修法 |
|---|---|---|---|
| `cameraLiveUi.limitExceededHint` **不存在**（它在目录里的实际路径是 `overviewLiveUi.limitExceededHint`） | 调用点 `MonitorView.vue:534` | 达到同时直播上限时，监测页会渲染出裸 key | **不复用总览页那一句**：`zh-CN.ts:305` 写明两页措辞是刻意分开的（监测页按钮写「开始视频」、总览页状态行写「尚未开始」），共用 key 会逼着其中一页说别扭的话。改为在四份目录的 `cameraLiveUi` 里各加**一句监测页自己的措辞**，并引用 `cameraLiveUi.start` 的真词 |
| `cameraStreamUi.detectUnparsed` **四份目录里都没有** | 调用点 `CameraAcousticPanel.vue:458`；`cameraStreamUi` 块本身存在，但**没有** `detectUnparsed` | 声学面板无数据可拼时会渲染出裸 key | 该行本来就是**设备原始字段**的诊断转储（`ret=` / `rawMsg`），不是散文；改用同一张表已经在用的缺失值占位符 `EMPTY_VALUE`（`'—'`，`lib/format.ts:23`），不再向 i18n 要一句从未定义过的句子 |

这两条**现有检查都抓不到**：`i18n-progress.cjs` 只管「源码里有没有写死的中文」，`tests/i18n.test.ts` 只断言
**语言之间**键集一致（四语言里都没有的键，它一致地缺失，因此通过）。

### 15.13.1 工具的**第三个**缺陷：动态前缀一个都没收到（已修；这个会误杀活键）

`DYNAMIC_HEAD` 是照 `.vue` 里的整串写的（`prefix.${`）。但 TS 的 `TemplateHead.text` **不含** `${`——
它只到 `${` 之前，也就是 `alarms.type.`。于是 `noteDynamic()` 在 `.ts` 文件里**永远匹配不上**，
`.ts` 里动态拼出来的键整批落进孤儿表。

后果是灾难性的：照那张表删键，会**删掉界面正在用的词条**。实测对比：

| | 修前 | 修后 |
|---|---|---|
| 动态前缀 | 8 个（全部来自 `.vue`） | **21 个** |
| 「任何地方都没人用」 | 172 | **90** |

即 **82 个活键被误判成死键**。其中六族全在名单里：`alarms.type.*`（15 个，`labels.ts:23` 的
`` `alarms.type.${key}` ``）、`domain.eventSeverity.*`、`domain.eventKind.*`、`domain.eventSource.*`、
`domain.detectFileKind.*`、`domain.eventDownloadStage.*` —— 它们由 `labels.ts` 的
`domainLabel(prefix, key)`（`` i18n.global.t(`${prefix}.${key}`) ``）驱动，而 `prefix` 是
**调用点传进去的字面量**，AST 里看不出来。`streamState.*`、`errors.*`、`domain.streamKind.*`、
`domain.recordingType.*`、`linkage.popup.*` 同理。

修法两条（都在 `scripts/i18n-orphans.cjs`）：

1. 动态前缀**按原文扫**，不走 AST：`prefix.${` 的正则直接 match 源文件全文。顺带解决 `.vue` 里
   `` `${t(`domain.permissionScope.${key}`)}…` `` 这种**嵌套模板**按反引号成对切分会切错的问题。
   代价：注释里写了 `prefix.${…}` 也会计入 —— 方向是安全的（宁可漏报孤儿）。
2. 额外把 `domainLabel('domain.eventSeverity', …)` 的**第一个字符串参数**收作动态前缀。

> **教训（比这条缺陷本身更重要）**：孤儿表在**删键之前**必须用「这条键真的没人用吗」的独立证据复核一遍，
> 不能因为是工具产出的就当成结论。同理，**修完工具要重跑并对比数字**：172 → 90 这个差值本身就是缺陷的证据。

### 15.13.2 孤儿清理推迟，以及为什么

剩余 97 个孤儿（90 个「任何地方都没人用」+ 7 个「只有测试还在引用」）**本轮不删**：

- 第 1 轮（系统设置：账号/声音/邮件）仍在往这四份目录里加键，`linkage.email*`（13 个）与 `accountUi.*`
  正压在它的作业面上。本轮实测到 `en.ts` 在我读取之后被它改动（`edit` 工具报 stale），现在删会互相覆盖。
- 已单独复核过一个反例：`alarms.unknownBit` **确实**是死键 —— 未知 bit 现在走 `alarmTypeKey()` 的
  `unknown_${type}` 可搜索标识（`shared/domain/alarm-mask.ts:88-93` 写明理由），不再是「一句话 + `{bit}` 参数」。
  删它是对的，但要等目录空闲，且删完要连 `tests/i18n.test.ts` 的键集断言一起确认。

### 15.13.3 一条流程教训：`cameraWall.ts` 被我用 PowerShell 写坏过

同一个文件在几何泛化（第 ⑥ 项的自定义分屏）之后，我用 `Get-Content -Raw` + `Set-Content -NoNewline`
（PowerShell **5.1**，默认 ANSI）配合含 `${...}` 的 `-replace` 改过它。结果是：文件里出现 276 个
`U+FFFD`（跨 119 行），**注释里的文字丢了约 115 个字符且无法逐字恢复**（`out/renderer` 的产物是压缩过的、
注释已被剥离；该分支没有任何提交，文件未被跟踪，所以**没有任何干净参照**）。更糟的是两处代码被吃进注释：

- 一个 `if (deviceId === null) {` 被并到上一行 `//` 注释尾部 ⇒ 整格逻辑消失，`.test-build` 随后带着同一处
  损伤重编，`camera-cell` 全线报 `Maximum call stack size` / 语法错误；
- 一行 `messageKey: CAMERA_CELL_STATUS_KEYS['device-offline'],` 同样被吞 ⇒ 这是**静默的行为缺陷**
  （语法仍然合法，只是设备离线那一格丢了文案），单靠类型检查抓不到。

恢复过程与规矩：

1. 结构修复脚本先还原换行、把残留 token 换成空格；再用「显式 `old → new` 列表 + 每处断言**恰好匹配一次**、
   不匹配就不写文件」的 node 脚本（`fs.writeFileSync(p, text, 'utf8')`）修文本；
2. **绝不**用 PowerShell 的 `Set-Content` 写仓库文件；`-replace` 的替换串里 `$` / `${name}` 会被解释，
   任何含 `$` 的替换都用 `edit` 工具做；
3. 复核手段：列 0 的 `*` 续行数、`U+FFFD` 数、中文注释里的空格缺口，三项都要为 0；
4. 递归那个错误是**修好注释之后才暴露**的：`wallGeometry()` 曾调用 `wallCellCount()`，而后者又调用
   `wallGeometry()` —— 类型检查完全看不见这种错，只有跑测试才会以 `RangeError` 现身。
   **「类型检查通过」不等于「代码能跑」**：这次的顺序是先 `vue-tsc` 全绿、再跑测试才炸出 27 个失败。

> 丢字符这件事只能**如实记账**：约 115 个字符的注释原文无法逐字恢复，现在的文字是按上下文重写的。

### 15.13.4 流程教训之二：并发构建会写坏 `out/`，且症状看起来像代码缺陷

第 11 轮我跑的 GUI 探针一次报了 **9 个问题**，其中 7 个是「Failed to fetch dynamically imported module」、
「Unable to preload CSS」以及连带的「系统设置里没有语言选择器」。这些**全是假的**：并行的设置轮同时在跑
`electron-vite build`，两边交错写 `out/renderer/assets`，于是入口 chunk 与其引用的分块来自不同批次。

三条可复用的判断依据（缺一条就别下结论）：

1. **同一分块在一次探针运行里出现多个哈希**：报错要找 `SettingsView-8j0snh_a.js`，而同一次运行里还见到
   `SettingsView-BsMkBP-h.css` 与 `SettingsView-CArQQBHh.js` —— 只有交错构建能造出这种局面。
2. **引用一致性自检**：把入口 `index-*.js` 里所有 `名字-哈希.js/css` 引用抽出来逐个查存在性。损坏时会有缺失；
   构建完整时是 40/40 全部存在（`out/renderer/assets` 共 43 个文件）。
3. **重跑**：构建落定后重跑同一探针，9 → 2。剩下那 2 个与构建无关（见下）。

> 规矩：**同一时刻只允许一个构建者**。`out/` 是构建产物目录，不是可以并发写的共享资源。
> 收尾轮统一做构建与安装包，中途不要让第二个进程碰它。

### 15.13.5 流程教训之三：探针报的「问题」要先当成**测量缺口**，而不是布局缺陷

设备管理页那条 `请求 1366x768，渲染层报回来 1280x720` **两次运行都复现**，所以不是随机抖动。看探针实现
（`scripts/demo-shot-driver.cjs` 的 `TREE_SIZES` 循环）就清楚了：它调 `win.setContentSize(1366, 768)` 再等 700ms，
而这一档**窗口尺寸根本没变**（读回的还是上一档的 1280×720；紧接着的 1920×1080 与 2560×1440 都正常生效）。

所以：

- 1366×768 这一档的布局**从未被测量**——既不能算通过，也不能算失败；
- 连带报出的「内容列没有随窗口变宽：`[1016,1016,1656,2296]`」只是数组里出现了两个相同的 1016，因为前两档
  其实是同一个视口。**窗口真的变宽时列宽是跟着变的**（1920→1656、2560→2296），这一点有数据。

这条**已解决**（第 12 轮）：根因是**竞争**，不是布局。并行的设置轮当时也在跑（它自己的 Electron 实例 +
自己的构建），窗口尺寸设置被抢；那一轮代理停下之后，同一条探针在**不改代码**的情况下报
`problems: 0`——四档窗口尺寸全部量到，且设备管理页在四档下的几何逐像素一致。

顺带把这类「没量到」变成可失败的事实：探针现在对告警页输出 `alarms controls`（筛选标签、等级下拉的档位数
与文案、表头列名），见 §15.14.3。探针最不该做的事就是把「没量到」与「量到不合格」混成同一个问题。

### 15.14 告警等级：**我们自己的划分**，以及为什么只能是我们的

**出处先说清楚：iVMS-4200 手册全书没有告警等级这个概念。** 13 张告警配置表与 6.14 三个小节里一个等级/优先级字段都没有，
唯一近似物是弹窗排序策略 `Prioritize Display of Latest Alarm`（6.14.1 默认不勾、6.14.3 默认勾选），那是**显示策略**
（§15.5）。设备侧同样不给：声纹设备的告警协议里**只有位图**，没有等级字段；相机的 `alarm_level` 读侧写 `0..3`、
写侧写 `1..4`、两套枚举自相矛盾，且真机（192.168.110.235）**从未回过**这个字段（§8.3 C15/C21）。

所以「等级」只能由我们按**告警位的物理含义**自己划。三条如实记账：

| 档 | 位 | 依据 |
|---|---|---|
| `critical` | Bit8 短路冲击、Bit7 过载 | 会**动手损坏设备**的电气故障，且「不需要看趋势，看到就要处理」。全部 14 个位里只有这两个 |
| `warning` | Bit4 夹具松动、Bit5/6 冷却器异常、Bit9–12 四类放电、Bit13 直流偏磁 | **已经命名的物理缺陷**：都指向一个具体、需要安排检修的对象，而不是「某个量偏了」 |
| `info` | Bit0–Bit3 声压/主频/带能量比/平滑度 | **四项声学基础量越限**。它们是"测量值过了阈值"，本身还不是缺陷判定——附录 B 的位序把这四个放在最前，正是因为它们是输入量而不是结论 |

两条刻意的取舍：

1. **阈值化的东西一律不进 `critical`**。把「声压超标」与「短路冲击」并列，会让真正的紧急告警被淹掉；反过来把放电类降成
   `info`，等于告诉值班员"不用管"。
2. **一个位图带多个位时取最高档**，不是最低档。真实报文同时置位是常态（声压越限 + 短路冲击），按最低档取会把一条
   紧急告警记成 `info`。

#### 15.14.1 快照，而不是读时派生——以及**刻意不回填**

`severity` 是 `alarms` 表上的一列（v6 迁移），入库时算一次就固定下来：

- 等级表是**我们可以改的设计**，而历史告警记录的是「当时我们怎么判的」。若改成读时派生，改一次表就会把历史记录的
  等级一起改写——那是**篡改记录**，不是升级。
- v6 之前的旧行留在建表默认值 `'unknown'`，**刻意不回填**：那时候我们确实没有判过等级，按位图回填等于伪造一个当时
  并不存在的判断。`'unknown'` 在这个模型里是**合法且预期会出现**的取值（见 `event-center.ts` 的等级说明），
  不是兜底。
- 测试用「入库后篡改 `alarm_mask`，读回的等级不许跟着变」把这条语义钉住了
  （`tests/alarm-severity.test.ts`）。

**备注**（`note`）也是我们自己加的：手册的告警列表有 `Note` 列，但**没有给长度限制**；500 字符的上限是我们的设计
（`schema.ts` v6 的 CHECK 与 `ALARM_NOTE_MAX_LENGTH` 同一个数字，后者只是为了让调用方拿到可读错误而不是
`SQLITE_CONSTRAINT`）。

**人工改判**写回的也是这一列 `severity`，不另开「人工等级」字段：两个字段并存必然出现「到底听谁的」。

#### 15.14.2 做完的与**明确还没做**的（不要读成已完成）

**做完**（主进程侧）：域层分类表与 `deriveAlarmSeverity()`；`AlarmEvent.severity` / `AlarmEvent.note` /
`AlarmQuery.severity`；仓库层入库快照、按等级筛选、分档计数、`setNote()`、`setSeverity()`；`AlarmService` 透传。

**做完**（IPC 与告警记录页，第 12 轮）：三个通道 `alarm:set-note` / `alarm:set-severity` /
`alarm:count-by-severity`，守卫统一 `viewAlarms`（它们只改这条记录自己的注解，理由写在
`auth.ts` 的 `viewAlarms` 上）；筛选栏的「告警等级」下拉（四档，顺序刻意是
`critical → warning → info → unknown`，因为这是筛选器）；表格「等级」列 + 四档配色；
详情抽屉里的等级改判与备注编辑（保存/清除）。备注上限 `ALARM_NOTE_MAX_LENGTH = 500` 移到
`@shared/domain/models`，让渲染层与主进程共用一个数字。

`unknown` 的配色是**中性灰**而不是绿色：它不是「最轻的一档」，而是「我们没判」，画成绿色会让操作员
以为这条已经被判定为无碍。

**明确还没做**：

- **4 分屏弹图与图标闪烁**（② 的剩下两项）——联动弹窗一次显示 4 路、告警图标闪烁。都还没动。
- **联动按等级闸门**：`judge()` 里那个 `minAlarmLevel` 闸的是**设备回的 `alarm_level`**，而该字段从未在真机上出现过，
  所以**它今天是失效的**（这一点 `alarm-linkage.ts` 的注释已经写明）。要真的按等级闸门，前提是**箱体告警也喂进联动
  引擎**——今天引擎只吃相机的 `/detect_logs` 与 `/detectFeedback`（`LinkageTriggerSourceKind` 只有 `poll` 与
  `websocket`），而相机那条路上我们**给不出**有证据的等级。所以本轮**没有**加一个用不上的 `minSeverity` 配置字段：
  加一个没有任何来源能填的闸门，只会把「失效」从一处搬到另一处。正确顺序是先把箱体告警接进引擎（并带上
  `deriveAlarmSeverity(mask)`），再在配置里开这个闸门。

#### 15.14.3 「控件没渲染」与「没有数据」在探针里长得一样——已加一项 DOM 采集

第 12 轮给 `scripts/demo-shot-driver.cjs` 加了一项告警页的 DOM 采集，输出形如：

```
[demo] alarms controls: {"filterLabels":["设备","通道","告警类型","告警等级","开始时间","结束时间","确认状态"],
                         "severityOptionCount":4,"severityOptions":["严重","警告","提示","等级未知"],
                         "heads":["","时间","设备","通道","告警类型","等级","状态"]}
```

它的价值在于：一次性 profile 里**一条告警都没有**，所以「等级列没渲染」与「没有记录」在
`problems: 0` 下**完全无法区分**。这两条断言（下拉有四档、表头有「等级」）让前者变成失败。

着色与备注编辑仍然只能靠单元测试与源码守卫（`tests/alarm-severity-ui.test.ts` 逐档断言配色类存在、
断言筛选器真的把 `severity` 写进 query、断言三个新通道都被权限守卫拦住），因为它们需要先有一条记录。

### 15.15 告警 → 本机录像的跳转（第 13 轮）：**手册只给了 30 秒这个数字，没给这条规则**

工作流 ④ 的要求是「一键跳到本机录像（回退 30 秒 + 上/下一事件）」。落地时有三件事必须分清出处：

#### 15.15.1 归因：30 秒是**借来的数字**，不是手册对这条路径的规定

- 手册 §15.11（p60–66，2089–2124）的 30 秒是**「按标签下载」的范围**——标签点**前后各 30 秒**。
- 手册**没有**规定「从一条告警跳到回放要回退多少秒」。所以「告警回放也回退 30 秒」是**我们自己的选择**，
  只是借用了同一个量级。
- 手册 p67–68 的 `Previous/Next Event` 是**回放界面里**的上一/下一事件，与"告警列表里换一条"不是同一件事；
  我们把它的**语义**（没有更远的一段时不许绕回）用在了抽屉的按钮上。

代码里这条归因写在 `ALARM_JUMP_BACK_MS` 的注释上，并且有守卫测试盯着它不许被简化成"手册要求 30 秒"
（`tests/alarm-recording-jump.test.ts`）。

#### 15.15.2 与环形缓冲区的正面冲突：**差额必须说出来**

本机的环形缓冲区预录时长是可配置的（`ringBufferPreSeconds`，出厂默认 **10 秒**），而请求是 30 秒。
于是"跳到告警前 30 秒"**经常拿不到**——夹到片段开头是对的（跳不到负时间），但**静默夹取就是界面说假话**：
操作员会以为那 20 秒只是自己没听到，而真相是那 20 秒**根本没被录下来**。

所以夹取逻辑被抽成纯函数 `anchorSeek()`（`src/renderer/src/lib/playbackTimeline.ts`），它**连差额一起返回**：

| 输入 | `seekMs` | `achievedLeadMs` | `shortfallMs` |
|---|---|---|---|
| 预录 60 秒、请求 30 秒 | 30 000 | 30 000 | **0** |
| 预录 10 秒、请求 30 秒（我们的出厂默认） | 0 | 10 000 | **20 000** |
| 锚点落在片段之前 | 0 | 0 | 30 000 |

`shortfallMs` 成为调用方**必须处理**的返回值；播放器在差额超过 500 毫秒（显示取整的容差）时渲染
`playerUi.leadShort`，把"请求 30 秒 / 实际只有 10 秒"如实说出来。跳转点还留了 50 毫秒尾部余量，
否则正好跳到 `duration` 会让元素立刻结束、看起来像播放失败。

#### 15.15.3 为此新增的一个字段：`PlaybackData.startTimeMs`

"跳到告警前 30 秒"这句话里，30 秒是相对**告警时刻**说的，而跳转是相对**片段**说的。要换算就必须同时
知道片段在绝对时间轴上的起点——`PlaybackData` 原本只有 `durationMs`，**没有起点**。所以补上
`startTimeMs: number`（`playback-service.ts` 用录音行自己的 `start_time` 填）。缺了它，代码只能从片段
开头播，而"请求的秒数是否真的被满足"就无从判断——那正好会让 15.16.2 那件事变成不可观测。

#### 15.15.4 明确没做与已知限制

- **上/下一事件只在本页内移动**，到边界就禁用（按钮禁用比"点了没反应"更不含糊）。跨页跳需要再发一次
  查询并处理新一页的头/尾，**没做**。
- 位置由 `alarmsUi.eventPosition`（「第 N / M 条（当前筛选结果）」）说出来，避免"下一步按什么顺序走"
  成为谜——顺序就是当前筛选结果的顺序。
- **前提**：告警要有 `localRecordingId` 才有东西可跳。联动动作「录像」**出厂是关闭的**
  （`actions.record` 默认 `true`，但整个联动引擎 `enabled` 默认 `false`），所以绝大多数告警今天
  根本没有本机录像，抽屉里显示的是「该记录没有本地录音文件」并把人送去「录音文件」页。这不是缺陷，
  是**当前配置下的真实状态**。
- 抽屉里的新控件（上/下一事件、等级改选、备注框）需要**有告警行**才渲染，而 GUI 探针用的一次性 profile
  里一条都没有——所以这一轮给探针加的是**告警页控件采集**（§15.14.3），抽屉内部则靠
  `tests/alarm-recording-jump.test.ts` 的接线守卫（锚点传没传、有没有第二份算术、差额有没有渲染出来）。

### 15.17 收尾盘点：**做到什么程度、什么没做**（2026-09-15，最后一轮）

这一节是给下一个接手的人的**诚实账**，不是成绩单。§15.7 的路线图五条 + 布防时间表取消，逐条对照：

| # | 工作流 | 状态 | 说明 |
|---|---|---|---|
| ① | 系统设置（账号 RBAC / 声音库 / 邮件 / 一键恢复默认） | **已落地** | `SettingsView.vue` 挂了四个 section（`AccountManagementSection` / `AlarmSoundLibrarySection` / `EmailSettingsSection` / `LinkageSettingsSection`），恢复默认是 13 项的范围清单。类型检查与测试全绿，四语词条完整；账号 RBAC 有逐条断言（含「权限目录与 `requirePermission()` 双向对齐」）。⚠️ **邮件没有做端到端实发验证**（没有可用的 SMTP 服务器），只覆盖到「配置校验 + 测试邮件请求构造」。 |
| ② | 告警模型升级 | **一半** | ✅ 等级划分（我们自己的三档设计，入库快照 + 人工改判 + 筛选/配色/分档计数）、✅ 备注（500 字符上限、保存/清除、`recordMissing` 三态）、✅ DB 迁移 5→6。❌ **联动动作扩展**（引擎仍是原有的 4 个动作：录像/弹窗/提示/邮件）、❌ **4 分屏弹图**、❌ **图标闪烁**。 |
| ③ | 回放时间轴与日历 + 标签打点与按标签导出 | **只做了模型层** | ✅ `lib/playbackTimeline.ts`（几何、刻度、缩放锚点、命中、事件跳转、`anchorSeek`）带 35 条断言。❌ **时间轴/日历 UI 未接线**（没有任何组件用它）、❌ **标签模型与按标签导出完全没做**（需要一次 6→7 迁移，见 §15.11(c)）。 |
| ④ | 告警 → 一键跳到本机录像（回退 30 秒 + 上/下一事件） | **已落地** | 见 §15.15。含"请求的回退量拿不到时如实报差额"这条。 |
| ⑤ | 自定义分屏 + 可保存的视图对象 | **只做了模型层** | ✅ `lib/cameraViewDivision.ts`（≤5 套 / 3×3、4×4、5×5 / Joint 合并 / 拆分）+ `stores/liveWall.ts` 的视图对象（存 `deviceUid`、恢复不自动起流）+ `lib/cameraWall.ts` 的几何泛化。❌ **UI 未做**：没有做「保存当前布局为视图」的入口，也不能把一套自定义分屏应用到墙上。 |
| ❌ | 布防时间表 | **有意不做** | 见 §15.9 与 §15.16。 |

**⑥ 收尾本身（本轮做完的）**：

- **i18n 孤儿键清理完成**：97 → **7**（剩下 7 条是**只有测试引用**的，删它们要连测试一起改，按工具的边界刻意留下）。
  zh-CN 词条 1721 → **1631**。删除用的是 AST 定位（不是按行删，因为目录里有**多行值**），
  删完立刻用「缺失键」这一方向做安全网——**0 个缺失键**，证明没有误删活键。
  删键留下的尾逗号也清了（AST 定位，**不能用正则**：`message: 'a,}'` 里的逗号紧跟着 `}`）。
- **本文件同步**：新增 §15.14（等级设计）、§15.15（告警→录像）、§15.16（布防时间表）、§15.13.4/5（并发构建与探针测量缺口）。
- **安装包重建**：见下面 §15.17.1。

#### 15.17.1 交付物与验证口径

| 项 | 结果 |
|---|---|
| `tsc --noEmit -p tsconfig.node.json` | 0 错误 |
| `vue-tsc --noEmit -p tsconfig.web.json` | 0 错误 |
| `tsc -p tsconfig.tests.json` | 0 错误 |
| `node --test .test-build/tests/**` | **1276 / 0 失败** |
| `scripts/i18n-orphans.cjs` | 缺失键 **0**、死孤儿 **0**、四语键集完全一致 |
| `scripts/i18n-progress.cjs` | 界面残留中文 **0** 行 |
| `electron-vite build` | exit 0 |
| `scripts/demo-shot.cjs`（GUI 探针，一次性 profile） | **`problems: 0`** |
| `scripts/video-proof.cjs`（相机视频探针） | **未通过 —— 与代码无关**：真实相机 `192.168.110.235` 当时 `/login` 超时不可达，探针如实报「没有可用相机」 |

**安装包**（`npm run dist:win:offline`）：

| 项 | 值 |
|---|---|
| 文件 | `release\HERTZINNO Acoustic Box Manager-1.0.0-x64-setup.exe` |
| 时间 / 大小 | 2026-09-16 21:35:44 · 126 970 647 B（121.09 MB） |
| SHA-256 | `A3DF722F9155147654CD7A26BEF268635F25F641CA7AE8AD48B52D22A37EA63F` |
| 签名 | **NotSigned**（`dist:win` 的设计如此；要签名走 `dist:win:signed`，见 `electron-builder.yml` 里那段说明） |
| 打包产物自检 `node scripts/verify-packaged.cjs` | **25 通过 / 0 失败**：better-sqlite3 与 DuckDB 在打包进程内可用、内置 ffmpeg 能从 `app.asar.unpacked` 执行、渲染层加载完成、**打包构建里四种语言都渲染**、出厂账户登录 + 首次改密成功、数据库已创建 |

> **新增了一条离线打包路径，因为默认那条在这台机器上打不出来。**
> `electron-builder` 每次都要从 GitHub 下载 Electron 的 zip（它**不在** `%LOCALAPPDATA%\electron-builder\Cache`
> 里，NSIS 与 winCodeSign 在、Electron 不在），在这台机器上表现为下载到 100% 之后**跟进请求挂 10 分钟**：
> `⨯ Timeout awaiting 'request' for 600000ms  failedTask=build`（2026-09-16 连续复现两次）。
> 解法是 `scripts/electron-builder.offline.cjs`：`extends: file:electron-builder.yml` + 一行
> `electronDist: node_modules/electron/dist`，让 builder 直接用**已解包**的那份 Electron。
> 顺带消掉一个版本漂移风险：打包出来的运行时就是探针与 `electron-vite dev` 用的同一个二进制。
> 默认的 `npm run dist:win` **没有改**（能联网的机器仍然走它）。


> **一条流程规矩（本轮踩过）**：`tsc -p tsconfig.tests.json` 会**重新 emit** `.test-build`，把
> `scripts/rewrite-aliases.cjs` 的重写覆盖掉。漏跑重写时测试只加载得动 322 个、报 30 个失败——
> 看起来像代码炸了，其实只是别名没改写。**emit 之后必须重跑 rewrite-aliases**，或者用 `npm test`
> （它的 `test:build` 已经把两步连在一起）。
>
> **同一件事的另一半（2026-09-18 第 10 批第 4 条踩到，见 §15.51.5）**：`tsc` 只 **emit**，
> 从不**删除**源文件已经不存在的旧产物。删掉/改名的测试于是留在 `.test-build/tests/` 里继续被
> `node --test ".test-build/tests/**/*.test.js"` 跑到，而它 import 的是 `.test-build/src/` 里那份
> **同样过期**的编译产物 —— 所以**它照样全绿**。所以 `test:build` 现在第一步是
> `node scripts/clean-test-build.cjs`（整个目录删掉重建）。看到"删掉一个测试之后总数没降"，
> 就是这一条。

### 15.18 界面改造（业主 2026-09-16）：页面标题、新增入口、告警图标

三条要求都属于**产品决策**，不是手册条目，所以这一节的性质与 §15.6 一样：写清楚"这是我们定的"。

#### 15.18.1 去掉页面内标题，因为外层框架已经写了

设备管理 / 告警记录 / 事件与告警中心 / 录音文件 / 历史趋势 / 系统设置 / 设备详情 七个页面里那个
`<h2 class="page-title">` 全部删掉，`.page-title` 这个类也从 `assets/main.css` 删了 —— 留着它，
下一个人会以为"页面标题"仍然是这套设计的一部分。

删掉的两个键**本来就是重复实现**，这一点值得单独记：

| 删掉的键 | 框架里说的是哪一条 | 为什么是重复 |
|---|---|---|
| `devicesUi.title`（「设备管理」） | 路由 `meta.titleKey = 'app.nav.devices'` | 同一句话，两个键 |
| `settingsUi.title`（「系统设置」） | 路由 `meta.titleKey = 'app.nav.settings'` | 同上 |

设备详情页特殊：它的 `h2` 写的是**设备名**，而**面包屑已经写了同一个名字**。删 `h2` 时唯一要救的是
它里面那个 `StatusBadge` —— 那是**信息**不是标题，所以它跟着面包屑走（`.breadcrumb__current`）。

**留下的是什么**：副标题（「共 N 条记录，已选 M 条」这类汇总行）与操作按钮。它们不是标题，
是这一屏自己的状态与动作。页头 CSS 加了 `.page-header > .btn-row { margin-left: auto }`：
页头只剩动作时（事件中心 / 历史趋势 / 系统设置）按钮贴右端，有副标题时副标题在左、动作在右，
一条规则同时成立。

#### 15.18.2 「添加设备」搬进左侧拓扑树

参考 ThingsBoard 的设备管理架构：左侧列表自带新增入口，右侧内容区不重复标题。所以
`DeviceTree.vue` 的树头右侧多了一颗带文字的「添加设备」（**不是**只有一个「＋」：树头已经有一个
「＋」表示"全部展开"，两个同形图标并排是猜谜）。

树只 `emit('add')`，**不自己弹对话框**：它不知道"当前账户是不是管理员"，那个判断由设备管理页
通过 `:can-add-device="session.isAdmin"` 传进来。这样"谁能添加设备"只有一处判断。
空状态里原来那颗按钮也去掉了 —— 入口只留一个。

#### 15.18.3 待处理告警并入告警图标

改之前顶栏有**两个**说同类事的入口：一颗独立的「待处理告警」按钮（带面板），和一颗只显示
未确认告警数的铃铛（点它跳 `/events`）。数字来自两个不同的源。

改之后只有一个：`AlarmLinkagePanel` **就是**那颗告警图标。规则：

- **角标数 = 面板里列出的条数**（`linkage.unacknowledgedCount`）。数字与列表必须同源，否则就是
  「一个数字配一份别的列表」——本仓库最反对的那种界面说假话。探针会把这两个数**对比**一次。
- 没有告警时面板写「当前无告警」（`linkage.pendingEmpty`，四语都改了）。
- 面板底部补了一个去「告警记录」页的出口：合并前那颗铃铛本来是跳转，改成下拉之后这个出口
  必须在面板里还回来，否则"看全部记录"就没有入口了。

⚠️ **被去掉的一件东西，请业主确认**：原来那颗铃铛的角标是**告警日志里未确认的条数**
（`alarms.query({acknowledged:false})`），那与「待处理告警」不是同一个集合（后者是联动引擎的
待处理提示，而联动引擎**出厂是关闭的**）。合并之后顶栏只显示待处理告警数，未确认告警数只在
告警记录页上。如果业主希望顶栏同时反映未确认告警数，那需要的是一个**两个分区**的面板
（面板里分别列出两类），而不是把两个数字压在一个角标上。

#### 15.18.4 探针里两条**过时断言**也一并改了（顺手清掉一个假警报）

设备管理页删掉页头之后，探针立刻报了 5 个问题，全都是同一类：它原来断言「拓扑卡片的上边缘在
**页头之下**」（`0 < gap ≤ 120`）。页头没了，这个间距就变成 0，于是断言失败。

这不是布局坏了，是**断言描述的是已经不存在的设计**。改成新设计下**更强**的约束：页头已删，
拓扑卡片是内容列的第一个元素，上间距必须**正好 0**（以前那个间距由页头决定、是可变的）。
四档窗口尺寸下实测 `card top=[0,0,0,0]`。

### 15.19 设备状态与两处页面改造（业主 2026-09-16 第二批）

这一批一共 10 条，**本轮做完 3 条**（① ⑥ ⑩），其余 7 条列在 §15.19.4 —— 不要读成全部完成。

#### 15.19.1 ① 离线设备直接显示离线：一条**产品要求与 spec 规则打架**的地方

先记事实（都实测过）：

| 事实 | 值 |
|---|---|
| 健康检查间隔 | `healthCheckIntervalMs`，出厂 **5000 ms** |
| 新添加设备的状态 | `UNKNOWN`（`schema.ts` 的 `status TEXT NOT NULL DEFAULT 'UNKNOWN'`） |
| 翻成离线的条件 | 连续失败 `offlineFailureThreshold` 次，出厂 **3** |

所以「实时更新」那条本来就是成立的（5 秒一轮 + 状态推送，`AppShell` 已订阅）。但「离线直接显示离线」
不成立：一台从未被探通的设备（新添加的，或重启后数据库里还是 `UNKNOWN` 的）要等 **3 × 5 = 15 秒**
才肯说离线，中间一直显示「未知」。

而代码里有一条明确的相反规则：`spec 13.2`「A single timeout must NOT flip a device offline」。
它防的是**抖动**——一台刚才还在线的设备因为一次超时被写成离线、下一轮又变回在线，界面上会闪，
操作员会以为设备在反复掉线。

**两条能同时成立，靠的是把判据从"数据库里的状态"换成"本进程是否亲眼见过它在线"**：

- `DeviceRuntime` 新增 `observedOnline`：`markOnline()` 里置真，运行时**新建时为假**。
- 从未在线过 ⇒ 第一次失败就报离线（产品要求）。
- 见过它在线 ⇒ 保留 `offlineFailureThreshold` 次失败的延迟（spec 13.2 防抖动）。

为什么不用 `lastStatus` 当判据：它是从数据库读出来的，里面可能是一次**旧会话**留下的 `ONLINE`。
把它当成"刚才还在"，会让每次重启之后每台设备都白等 15 秒。

判断本身抽成了纯函数 `shouldMarkOffline()`（`src/shared/domain/device-status.ts`）——它以前写在
`DeviceService.markFailed()` 私有方法里，**不可测**（要验证"第一次失败就离线"得先造一个真会超时的
HTTP 传输），而它恰好是那种"一改就让界面说假话"的判断。`tests/device-offline-rule.test.ts`
逐条断言两条规则并排成立。

#### 15.19.2 ⑥ 删掉「RTSP 地址」与「直接转封装」

两处都在相机实时视频面板的 `dl.kv` 里：

- **RTSP 地址**是本机回环服务的内部地址（`rtsp://127.0.0.1:<port>/…`）。操作员拿它没有可做的事，
  而它长得像"设备的地址"、容易被当成真实设备地址抄走。右键菜单里那条「复制 RTSP 地址」仍然在，
  真需要时拿得到。删掉后 `cameraLiveUi.rtspAddress` 成为死键，已从四份目录删除。
- **「直接转封装」**说的是本机用哪种方式把 H.264 交给 `<video>`（转封装 / 重新编码），是实现细节。

留下的是「播放信息」（已转发字节数 / 正在用哪个地址候选）——它只在**失败时**才是线索。

#### 15.19.3 ⑩ 历史趋势：动作搬进筛选卡片，设备下拉收窄

「刷新 / 立即落盘」从页头搬进筛选那张卡片（它们作用于**整组**筛选条件，不属于某一个下拉框，
所以放在筛选栏末尾并 `margin-left: auto` 推到右端）。设备下拉的 `min-width` 从 240px 收窄到 160px。

⚠️ **探针在这里只能验证一半**：一次性 profile 里**没有设备**，这一页会走「尚未添加设备」分支，
筛选卡片根本不渲染 —— 那三条 DOM 断言在那里**量不到**。所以探针如实打印
「skipped（这个一次性 profile 里没有设备，筛选卡片不渲染）」，而"接线本身"由
`tests/page-layout.test.ts` 的源码守卫钉住（两个动作必须在 `<section class="card">` 与它后面第一个
`</section>` **之间**）。这是 §15.13.5 那条规矩的又一次应用：**不许把"没量到"报成"不合格"。**

#### 15.19.4 这一批**还没做**的 7 条（下一轮从这里接）

| # | 要求 | 现状 |
|---|---|---|
| ② | 声纹设备：每通道显示声纹特性；四级指标进一张小卡片；卡片下方放实时音频播放按钮 + 音量调节；去掉声纹设备下的视频窗口 | **未做** |
| ③ | 去掉「数据流状态」「当前帧」；「实时趋势」挪到实时视频墙的位置；其下四张卡片（时域/频域/时频谱/告警状态）；参考 ThingsBoard 时间轴，支持手动记录与时间轴回放 | **未做**（时间轴几何模型已在 `lib/playbackTimeline.ts`） |
| ④ | 实时检测：设备下拉 = 容器宽度 50%；删掉右侧「在线/局域网/视频未启动」；下拉移到标题栏右侧、设备数量图标之前 | **未做**（下拉要进**顶栏**，需要 `<Teleport>` 或插槽机制） |
| ⑤ | 实时检测内容直接是 16:9 视频窗口，右键与小功能与总览一致，最多两通道（371T 带红外） | **未做** |
| ⑦ | 删掉下方实时视频墙与「相机声学数据」卡片；相机控制与告警并列 | **未做** |
| ⑧ | 声纹图/频谱图/能量点/PRPD/检测结果排成同一排 | **未做** |
| ⑨ | 升级、维护、告警策略、检测模式移到设备管理的配置界面 | **未做** |

### 15.20 登录页：记住上次的用户名 / 记住密码 / 每三个月重新输入（业主 2026-09-16）

三条要求：记住上次的用户名；**勾选了**「记住密码」才记住密码；**每三个月**重新输入一次。

#### 15.20.1 口令必须走 OS 加密，不能塞进 localStorage

本仓库有一条既成的硬规则（spec 14.1）：「本地凭据如需持久化，使用 Windows Credential Manager /
DPAPI；**不要明文存 SQLite**」。设备口令就是照这条做的（`device/credential-store.ts` 用
Electron 的 `safeStorage`）。账户口令是**更强的**一个秘密（它拿着整个应用），所以走同一条路：

- `safeStorage.encryptString()` 之后再写 `app_meta`（`remembered-login-store.ts`）；
- 用户名单独一格 —— 它不是秘密，界面要能只读它；
- **系统加密不可用时失败关闭**：只记住用户名，密码一个字节都不落盘，界面把勾选框禁用并说明原因。

#### 15.20.2 最容易做错的一处：自动填充的登录**不许**续期

如果每次登录成功都把「记住时间」刷成现在，第 3 条永远不会发生：登录页自动填好密码、用户点一下
登录、时间被刷新；三个月后再来一次，还是自动填好。**"每三个月重新输入一次"这句话的全部意义
就是这个**，所以：

- 存储里的 `rememberedAt` = 用户**最后一次亲手输入这个密码**的时刻；
- 刷新只有一个触发条件：`userTypedPassword`（渲染层由密码框的 `input` 事件置真，预填不置）；
- 自动填充的那次登录沿用原时间 ⇒ 时间一到**真的**过期：主进程在读到的当下就把密文删掉，
  返回 `{ expired: true, password: undefined }`，登录页提示「已超过 {days} 天，请重新输入」。

规则本身在纯函数里（`@shared/domain/remembered-login.ts`），`tests/remembered-login.test.ts`
**10 条断言**，其中包括「自动填充续期会让这条要求永远不发生」这一条，以及"把一次完整的三个月
周期走一遍"（第 0 天记住 → 第 1/10/45/89 天自动填充不动窗口 → 第 91 天过期 → 重新输入开新窗口）。

> 提示语里的天数由 `REMEMBERED_PASSWORD_MAX_AGE_MS` **算出来**，不写死 90：两处写同一个数字，
> 改一处就会出现"界面说 90 天、实际 30 天把人挡在外面"。

#### 15.20.3 端到端探针：`npm run verify:remember`

源码看起来"有实现"这件事在这条链路上特别不值钱 —— 它横跨渲染层表单 → IPC → `safeStorage` 加密 →
`app_meta` 落盘 → 重新加载时的解密与预填。所以有一个专门的探针
（`scripts/remember-login-proof.cjs`，一次性 profile）走完整条路，实测输出：

```
login chrome : {"hasCheckbox":true,"checked":false,"disabled":false,"label":"记住密码","usernameValue":""}
sign in      : {"step":"changed"}
remembered   : {"ok":true,"username":"admin","hasPassword":true,"passwordMatches":true,"expired":false,"persistent":true}
prefilled    : {"onLoginScreen":true,"username":"admin","passwordLength":19,"passwordMatches":true,"rememberChecked":true}
unchecked    : {"username":"admin","hasPassword":false}
problems     : 0
```

五条分别是：勾选框存在且**默认不勾**；登录（含首次强制改密）；读回来用户名 + 密码且**与输入一致**
（加密→落盘→解密整圈）；登出并重新加载后**用户名与密码都预填、勾选框跟着勾上**；取消勾选后
**密码真的被删掉、而用户名仍然记住**。

> 第一次跑这个探针报的是「没有窗口」：驱动在应用入口之前被 require，所以它的 `app.whenReady()`
> 回调排在应用自己的前面 —— 那时窗口还没建。改成监听 `browser-window-created`（demo 驱动用的
> 同一条路子）。这类"抢跑"在探针里很常见，值得记一笔。

#### 15.20.4 顺手修掉探针的一处**测量口径**问题

加了这一批之后 demo 探针报了 4 个问题：「请求 1280x720，渲染层报回来 1286x737」（四档一律
+6 / +17）。查下来不是布局坏了 —— 卡片间距、树的列宽、贴边**全部通过**；坏的是**基准**：
断言拿"我们请求的尺寸"去比渲染层的 `window.innerWidth`，而中间隔着 Windows 的边框与非 100%
的 DPI 缩放，视口尺寸由**窗口**决定、不由请求决定。

改成先读 `win.getContentSize()` 再要求渲染层与**它**一致；请求值与实际值不同时另记一行日志
（那是环境事实）。改完重跑 `problems: 0`，而且这一轮的偏差**没有复现** —— 所以这不是"修好了一个
bug"，而是让这条断言不再会因为环境抖动而长期红着（长期红着的断言等于没有断言）。

⚠️ 这也意味着：`--with-data` 的 demo 探针报问题**不等于**界面坏了。第一次遇到先看 `problems` 里
具体是哪一条，再看它是"事实不符"还是"基准不对"。

### 15.21 界面改造第三批（业主 2026-09-16 晚）：本轮做完的与**一条要先问清楚的**

这一批业主一次提了约 19 条，**本轮做完 4 条**，其余列在 §15.21.3。

#### 15.21.1 做完的四条

**① 顶栏刷新按钮只留图标。** 文字去掉后补了 `title` + `aria-label` —— 一个只有图形的按钮在读屏里
就是"按钮"，而它是顶栏唯一的全局动作。旋转动画保留（它原来与文字一起表示"正在刷新"）。

**② 录音文件页去掉页头**：「共 N 个录音文件」删掉（列表本身就是那个数字），「同步设备录音」与
「刷新」两个按钮删掉（刷新在顶栏已经有一个入口）。

> ⚠️ **一个必须记账的后果**：「同步设备录音」原本是**设备录音库唯一的界面入口**
> （`recording:sync-device` 通道仍在主进程）。删掉之后这个能力在界面上没有落点。这一页接下来要
> 变成**存储**页（按日期查看与回放），"设备录音库怎么导入"属于那一版的范畴，等它成型时一并决定。
> 代码里那段注释与这一节都是为这件事留的线索，别当成"已经不需要了"。

**③ 系统设置去掉「还原」与「保存设置」，改成自动保存。**
「保存」是**唯一**把设置写下去的动作，直接删掉等于设置改不动，所以先把它变成自动保存：

- 草案一变就排一次写盘，防抖 600ms（连续敲数字时不该每敲一下就写一次库）；
- **非法值不写**，只把错误留在页面上 —— 把非法值写进去比不写更糟（下次打开软件就是坏的设置）；
- 用「草稿与已存值**比较内容**」当作安全阀，而不是一个 `isSeeding` 标志：watcher 默认在下一个
  tick 才跑，标志在同步赋值结束时已经复位了，那是这类自动保存最经典的一个坑。回填与保存成功之后
  草稿必然等于已存值，所以那两次不会写盘；
- **不再有"保存成功"横幅**（每改一个字段弹一次是噪音），但**失败必须说话** ——
  静默失败的自动保存是最坏的一种：用户以为改好了，重启之后又变回去。

**④ 清掉随之变成死键的 6 个文案**（`recordingsUi` 的 countSummary / selectDeviceFirst / syncDevice /
syncNothing / syncedNotice / syncing），四份目录一起删，删完 0 缺失键、四语键集一致。

#### 15.21.2 「恢复默认」**没有删**，以及为什么这一条要单独说

业主原话是三个按钮（恢复默认 / 还原 / 保存设置）都删。我删了后两个，**留了恢复默认**：

- 它是手册 §17.2 的「一键恢复全部系统配置」，本仓库**有意把范围收窄**成 13 项设置（文档 §15.7 有
  那段理由）；
- 它与"保存/还原"不是一类东西：那两个是**编辑动作**（自动保存之后确实多余），恢复默认是一个
  **破坏性维护动作**；
- 直接让它在界面上消失，用户就再也找不到它了 —— 而"找不到"与"被删掉"在使用者眼里没有区别。

它的正确落点是把这一页改成页签式之后（见 §15.21.3 第 ④ 条）的「关于 / 维护」那一页。请确认这个
处理；要真删也告诉我，我连它的 13 项范围与测试一起收拾干净，不留半个死代码。

#### 15.21.3 这一批**还没做**的（下一轮从这里接）

| # | 业主原话（要点） | 需要的改动 |
|---|---|---|
| ① | 录音文件 → **存储**页：按日期查看、回放音频/视频 | `RecordingsView` 大改：日历/日期选择 + 播放；并决定"设备录音库导入"去哪 |
| ② | 系统设置：把 语言/存储/视频/告警/邮箱/账号/关于 做成**切换卡片页** | `SettingsView` 拆成页签；同时按 #③ #④ 重排 |
| ③ | 设置页太宽松：语言/存储/设备探测/缓冲重新排版，**不要每张卡片都写名字** | 与 #② 一起做（页签本身就是"不必每卡一个标题"的答案） |
| ④ | **设备探测**属于软件设置，且应与**缓冲**合并 | 把「离线判定失败次数 / 请求超时 / 健康检查间隔」与环形缓冲合成一组 |
| ⑤ | **告警联动**挪进**告警中心**，重新排版，启动开关放到「告警联动」右侧 | `LinkageSettingsSection` 从设置页移到 `EventCenterView` |
| ⑥ | **告警声音**内容应按**声纹/声学相机**的告警设计，而不是视频那一套 | 重做声音类型的取值：与 `AlarmType` / 相机检测模型对齐 |
| ⑦ | **触发源**应按不同的边缘分析设备各自配置，不该在这里测试 | 「测试触发」这类入口从设置里移除，挂到设备上 |
| ⑧ | **告警中心**要包含**设备离线告警** | 主进程把 `DeviceService` 的状态事件接进事件中心（新增一种 `EventKind`） |
| ⑨ | 设备管理支持**添加/移除设备**；添加支持 IP 或 API 文档指定的方式；删除要**弹窗确认** | 添加已支持（对话框 + 测试连接）；**删除已有确认弹窗**（`removeOpen` + `AppModal`）——需要业主要确认的是"现在这一步哪里不顺" |
| ⑩ | 删除整个软件**最右侧的下拉按钮** | **待确认是哪一个**：`AppTopbar` 最右是刷新按钮（无文字），而全局唯一的下拉是**侧栏底部**的账户菜单 `UserMenu`（当前账户 / 退出登录 / 改密码）。见 §15.21.4 |
| ⑪ | 版权页脚应**始终在底部**，不随页面移动 | 布局已经是对的（`.app-content` 有 `min-height: 0` + `overflow: auto`，页脚在它之外，`html/body/#app` 都是 `height: 100%`），探针实测 `footerBottomGap: 0`。**需要业主要确认看到的是什么现象**（哪个页面、窗口多大、要不要滚动才看到）——不然我只能靠猜 |

#### 15.21.4 两条我判断不了的，请给一句话

1. **「最右侧的下拉按钮」是哪一个？** 全局只有一个下拉：**侧栏底部**的账户菜单（`UserMenu`：
   当前账户 / 退出登录 / 修改密码）。顶栏最右侧是刚按 #① 改成纯图标的**刷新按钮**（它不是下拉）。
   如果指的是账户菜单，我可以删掉它 —— 但**退出登录的入口会一起消失**，所以我会顺手把
   「退出登录 / 修改密码」放进设置页的「账号」页签（#② 本来就要做账号页签）。
2. **页脚"随页面移动"是哪个页面？** 现在所有页面的页脚都在窗口底部（`footerBottomGap: 0`，
   且不在滚动容器里）。我需要一个具体页面与窗口尺寸才能复现。

#### 15.21.5 本轮验证

| 检查 | 结果 |
|---|---|
| `tsc node` / `vue-tsc` / `tsc tests` | 0 / 0 / 0 |
| 全部测试 | **1298 / 0 失败** |
| `i18n-orphans` | 缺失键 **0**、死孤儿 **0**、四语键集一致（词条 1630 → 1624） |
| `i18n-progress` | 界面残留中文 **0** 行 |
| 构建 | exit 0 |
| `npm run verify:remember` | **0 问题** |
| `demo-shot --with-data` | **0 问题**，9 张截图已刷新到 `.demo-shots-real/` |

### 15.22 两份 FA8 / FA110 一手 API 资料（业主 2026-09-16 提供）

一次给了两份：
`FA8 API_ 20250207_v1.0.pdf`（39 页）与 `API documents_ Acoustic Box FA110_20240312.docx`（1100 行）。
抽取方法：pypdf 6.19（wheel 在本地缓存里，解压后经 `PYTHONPATH` 使用，**没有装进仓库、也没有新增仓库依赖**）
与仓库既有的 `scripts/docx-to-text.cjs`。下面只写**这两份材料真的写了**的东西，并单独列出它们**没写**的。

#### 15.22.1 FA8：`dauAbnoType` 的位表与我们的 `AlarmType` **逐位相同**

`/get_audio` 那一节里有一小节叫 **"Anomaly Type field parsing：dauAbnoType"**，把异常类型写成**位图**，
位定义与仓库既有分类法逐位对应 —— 这是本节最重要的一条，它同时说明我们**没有编造**分类：

| 位 | 手册原文（FA8 API p23） | 仓库的 `AlarmType` |
|---|---|---|
| bit0 | Sound pressure level | `SPL` |
| bit1 | main frequency | `MainFrequency` |
| bit2 | Band energy ratio | `BandEnergyRatio` |
| bit3 | smoothness | `Smoothness` |
| bit4 | `'jsd'` clip losse | `ClampLooseness` |
| bit5 | `'qqyx_A'` cooler noise A | `CoolerAnomalyA` |
| bit6 | `'qqyx_B'` cooler noise B | `CoolerAnomalyB` |
| bit7 | `'gz'` heavy overloading | `Overload` |
| bit8 | `'dlcj'` short-circuit shock | `ShortCircuitSurge` |
| bit9 | `'bfd_bmfd'` surface discharge | `SurfaceDischarge` |
| bit10 | `'bfd-dyfd'` corona discharge | `CoronaDischarge` |
| bit11 | `'bfd_jjxfd'` gap discharge | `GapDischarge` |
| bit12 | `'bfd_xffd'` floating discharge | `FloatingDischarge` |
| bit13 | `'lpc'` Direct current magnetic bias | `DCBias` |

手册只到 bit13、**没有 bit14+**，与 `ALARM_MASK_BITS = 14` 一致。位4–13 那些 `'jsd'`/`'qqyx_A'` 是
**固件拼音缩写**：按仓库硬规则（"Protocol DTO → Mapper → Domain Model，绝不镜像固件名"），它们只该
出现在 DTO/映射层，界面用的仍是我们那套语义键。

另外，**每条告警录音记录**（`/get_audio` 与 `/get_alarm_audio` 的 `audioArray[]`）都带
`dauChId`（通道号 0-7）、`dauChName`、**`dauChSenType`（Sensor type）**、**`dauAbnoType`（异常类型位图）**、
`dauAlarmTime`、`dauAudionLeng`、`dauSPL`、`dauStati`、`dauMainFreq`、`dauFBET`、`dauSmp`、`dauStatus`
（1 文件存在 / 0 不存在）。**仓库目前没有映射 `dauAbnoType` / `dauChSenType`**（DTO 里没有这两个字段）。

#### 15.22.2 FA8：「AI 模式」是一条**告警策略字段**，不是一个新类别表

`/add_alarm_system` 与 `/get_alarm_system` 里都有：

```
dalDetecType  integer   Alarm Mode   0 Characteristic mode   1 AI mode
```

即**每条告警参数**可选「特征模式（阈值）」或「**AI 模式**」。结合 15.22.1，AI 模式改变的是设备
**怎么判**，而不是**类别集合** —— 类别仍是那 14 位。所以「支持 AI 的告警类别推送」在这份材料里的
落点是：**让操作员能把某条告警参数设成 AI 模式**（`dalDetecType = 1`），并保证未知位仍被如实呈现
（仓库已有 `unknownAlarmBits()` 与 `unknown_<n>` 回退）。

同一节的告警参数字段（供以后做策略界面时对照）：`dalName`、`dalSPLODEn/Thre`（声压过载）、
`dalSPLSIDEn/Thre`（声压骤升）、`dalSPLSDDEn/Thre`（声压骤降）、`dalSPLStaDetEN/Thre`（声压稳定性）、
`dalMainFreqEn` + `dalMFLower/dalMFUpper`、`dalFBETEn` + `dalFBETLo/dalFBETUp/dalFBETThre`、
`dalIntInhLeve`（干扰抑制等级）、`dalDeteSen`（检测灵敏度）、`dalId`、`dalDetecType`。

> ⚠️ **手册未说明**：AI 模式**用什么模型、会不会推出这 14 位之外的新类别**，两份材料都没写。
> 不要假定"AI 模式下会多出若干类别"；未知位照旧走"未知告警位"那条诚实路径。

#### 15.22.3 FA8：`/get_devinfo` **没有通道数字段，也没有型号字段**

`/get_devinfo` 的 `msgBody` 只有 `devname`、`fpga_version`、`dev_version`、`dev_mac`、`web_version`。
通道数在别处是**写死 0-7** 的：

| 位置 | 原文 |
|---|---|
| `/get_passageway` | `chinfoArray object []  All channel`，`dchId integer  Channel ID 0-7` |
| `/get_cur_ch` | `cur_ch number  Channel number 0-7` |
| `/channel_select` | `cur_ch number  Channel number 0-7` |
| `/recorder_conf` | `recorder number[] … Channels 1-9 start/stop recording` |
| `/features_stream` 示例 | `Start pushing 8 channels raw data AA 55 05 05 FF 00 EE BB` |

**结论（直接决定实现方式）**：一台设备到底几路，**唯一诚实的依据是 `/get_passageway` 返回的
`chinfoArray` 实际条数**；不能靠型号名，也不能假定 8。`/recorder_conf` 那句「Channels 1-9」与
本文件其它地方的 0-7 冲突，**手册未说明**，按疑似笔误处理、不据此实现。

`/features_stream`（每秒一帧）的字段：`main_freq`、`smoothness`、`sound_pressure_level`、
`freq_band_energy_ratio`、`hr_f`（奇偶谐波比）、`sc_f`（频谱复杂度）、`sv_f`（声纹成分变化量）——
与仓库 `metrics` 里既有指标一致。

还有一个**新端点**要记：`/voiceprintAnalyse`（POST）带 `objectList[].objectId`（通道号）与
**`typeList string[]` ——「Defect class identification can be selected from a variety of types」**，
即"分析哪些缺陷类别"是**可选的字符串列表**，但**手册未枚举**有哪些取值。另有
`/voiceprintDataCollect`（POST，按 `objectId` + `duration` 采集一段 wav 供分析）。

#### 15.22.4 FA110：**另一套协议——它是 HTTP 回调，不是我们轮询**

`FA110_20240312.docx` 描述的是完全不同的东西：

- 读参数：`GET /system`；参数里有一个 **`work_mode`** 字符串选监测类型，已见三种：
  **`burst_of_loud_sound`（突发强声）**、**Rotational Device Monitoring（旋转设备）**、
  **Power Equipment State Monitoring（电力设备状态）**；
- **`notify_url`**（"Message Callback Address"，示例 `http://192.168.2.190:5000/alarm`）+
  **`is_send_alarm`（1 发送 / 0 不发送）** ⇒ **设备主动把告警 POST 到我们指定的地址**，
  而不是我们轮询或订阅 WebSocket；
- `is_send_fft`（是否同时推实时分析数据）、`samplerate`、以及按监测类型分组的阈值
  （`db_limit`、`tde_ratio_limit`、`fde_ratio_limit`、`freq_down_limit`、`freq_up_limit`；
  电力设备那一组是声音分贝 / 频带能量比 / 主频 / 频谱复杂度阈值）；
- 传输格式：**"PCM FLOAT, with a channel count of 1, quantization bits of 32"**。

⚠️ **与业主说法的关系**：业主说 FA110 是"历史的两通道设备，其实只支持一个通道，每次切换"。
手册那句**通道数 1** 与业主一致；而"两通道、每次切换"这件事**手册未说明**（docx 里没有通道切换接口，
也没有双通道并发的描述）。按业主口径实现：**同一时刻只有一个通道在工作，换通道是切换**。

⚠️ **手册未说明（FA110 侧，动手前必须记住）**：

- 回调 POST 的**请求体格式没有给**：`notify_url` 的说明栏写的是 "Work Mode, please refer to the
  instructions for details" —— 它指向**另一份 "instructions"**，那份不在手上。
  **所以现在不能凭猜写解析器。**
- `work_mode` 的**完整取值清单**（只见到三种）与其**告警类别枚举**都没有；
- 没有 `dauAbnoType` 那样的异常位图（那是 FA8 才有的）。

#### 15.22.5 由这两份材料定下的实现口径

| 需求 | 依据 | 做法 |
|---|---|---|
| 8 / 2 通道**自动识别** | 15.22.3：`/get_devinfo` 没有通道数 | 以 `/get_passageway` 的 `chinfoArray.length` 为准；拿不到就如实说「设备未上报通道数」（仓库已有这条路径），**不猜 8** |
| **FA110 单通道、可切换** | 15.22.4：通道数 1；"两通道切换"手册未说明（业主口径） | 设备形态上区分「**同时多通道**」与「**单通道可切换**」两种；切换入口 FA8 是 `/channel_select`，FA110 的等价入口**手册未说明、待定** |
| **AI 告警类别** | 15.22.2（`dalDetecType` 0/1）+ 15.22.1（类别位表） | 告警策略里暴露「特征模式 / AI 模式」；类别仍用既有 14 位分类法；未知位如实呈现 |
| 声纹缺陷类别 | 15.22.3：`typeList string[]`，**未枚举** | 只当**字符串列表**透传与显示，**不预置任何类别清单** |
| 告警录音的异常类型 | 15.22.1：`dauAbnoType` 位图 | 仓库**尚未映射**这两个字段（`dauAbnoType`/`dauChSenType`）；映射后按 15.22.1 的位表解，与既有 `decodeAlarmMask` 同一套 |

#### 15.22.6 这一节的边界

以上全部来自这两份文件；凡是它们没写的，本节都标了**手册未说明**，没有从别处推断补全。
特别是 FA110 的**回调体格式**与**告警类别**：在拿到那份 "instructions" 或一次真机抓包之前，
**不要写解析器** —— 写出来的只会是一个看起来能跑、字段全是编的解析器。

#### 15.22.7 三种设备形态，**不要混淆**（业主 2026-09-16 明确）

业主补充：还有**新版本的两通道设备，与 8 通道一致** —— 别把它与老的 FA110 混为一谈。
所以设备形态有三种，而**只有第一种和第二种共用同一套协议**：

| 形态 | 协议 | 通道 | 仓库现状 |
|---|---|---|---|
| **FA8 8 通道**（AE08） | FA8：轮询 + `/features_stream` WebSocket | **8 路同时** | ✅ 已支持（真机 AE08） |
| **FA8 2 通道（新版本）** | **与 8 通道完全一致**，只是通道表只有 2 行 | **2 路同时** | ✅ **已支持且有测试**：`tests/channel-wall-status.test.ts` 「2 路设备：只有 1 / 2」；通道数由 `/get_passageway` 的 `chinfoArray.length` 决定，**不假定 8** |
| **FA110（历史）** | **另一套：HTTP 回调**（`work_mode` + `notify_url` + `is_send_alarm`） | 硬件两路，但**同一时刻只有一路**，靠切换 | ❌ **未支持**：需要协议探测 + 主进程里的回调接收端；且**回调体格式手册未说明**，等料 |

**为什么新 2 通道不需要新代码**：仓库判定通道数只认**设备自己的通道表**，而"2 路 ⇒ 档位只有 1/2"
这条产品规则已经写在 `channelWallLayouts()` 里并有断言。所以新盒子上线时，只要它按 FA8 回
`chinfoArray`（2 行），界面上就会是 2 路、档位 1/2、设备卡片显示「通道数 2」。

**FA8 侧还剩一个真实缺口**（一手资料支撑，可直接做）：告警录音记录自带 `dauChSenType`
（该条录音的传感器类型），DTO 里有这个字段但**没有映射**到域模型（只有通道配置的
`dchSensorType` → `Channel.sensorType` 被映射了）。要落到域模型需要给 `recordings` 加一列。

### 15.23 听诊盒子 E2 / 听诊盒子 API（业主 2026-09-16 再补两份）

`听诊盒子E2用户手册与API中文.docx`（1318 段）与 `听诊盒子API接口20231222.docx`（937 段）。
两者与 §15.22.4 那份 `FA110_20240312.docx` **是同一族设备的同一套协议**（同样的
`notify_url: http://192.168.2.190:5000/alarm`、同样的 `saving_path`、同样那句
"PCM FLOAT, channel count of 1"）——FA110 那份是**英文版**，这两份是**中文版**，而且多出了
**用户手册**那一半（正是之前缺的东西）。

#### 15.23.1 抽取方式的一条教训：**不是文件坏了，是我看错了**

第一遍抽出来的中文在终端里全是乱码（"系统" → "绯荤粺"）。我先怀疑抽取脚本，写了个 Python
版本按 XML 声明的 UTF-8 解 —— **输出一模一样**。真相是：**抽取一直是对的**，是
PowerShell 控制台与 `Get-Content` 按 GBK 解码 UTF-8 字节**显示**成那样。本轮之前已经踩过同
一个坑（`docs/` 也是这么显示错的）。所以：

> **读中文文本一律用 `read` / `grep` 工具，不用 `Get-Content`。** 验证"文件是否乱码"要拿
> 字节或工具去比，不能看终端。
>
> 顺带记一个真缺陷：仓库自带的 `scripts/docx-to-text.cjs` 在这两份中文 docx 上产出的是
> **有损**乱码（出现 `?`，不可逆）。全英文的文档看不出来（ASCII 在两种解码下一样），所以它
> 一直到第一份中文 docx 才暴露。本次改用 `zipfile + ElementTree` 直接读 `word/document.xml`
> （按 XML 声明的 UTF-8），没有把它塞进仓库。

#### 15.23.2 三种 `work_mode` 及其**完整参数与出厂默认值**

`GET /workmode` 返回 `{ work_mode, samplerate, audio_stream_url, stft_pic_height, stft_pic_width,
stft_stream_url }`。三种模式与各自的阈值参数（默认值来自两份文档里的示例，**不是我们定的**）：

| 模式 | 含义 | 参数（示例默认值） |
|---|---|---|
| `burst_of_loud_sound` | 突发大声音监测 | `db_limit` 50 · `tde_ratio_limit` 1.0 · `fde_ratio_limit` 1.0 · `freq_down_limit` 12000 · `freq_up_limit` 24000 · `samplerate` 48000 |
| `rotating_equipment` | 旋转类设备监测 | `db_limit` 50 · `hpss_limit` 1.1 |
| `electrical_power_equipment` | 电力设备状态监测 | `db_limit` 50 · `fde_ratio_limit` 1.0 · `freq_down_limit` 30000 · `freq_up_limit` 60000 · `main_freq_limit` 60000 · `sc_ratio_limit` 1.0–2 · `sc_ratio_threshold` 0.3 · `samplerate` 120000 |

三种模式都另有 `notify_url`、`is_send_alarm`（1 发 / 0 不发）、`is_send_fft`。
实时流是 **WebSocket**：`ws://{ip}/audio_stream`（PCM FLOAT、**通道数 1**、32 位、LittleEndian）与
`ws://{ip}/stft_stream`（时频谱图，尺寸取自 `/workmode` 的 `stft_pic_*`）。

#### 15.23.3 告警类型：**8 条枚举（7 种不同）**，与上面的阈值参数一一对应

`听诊盒子E2用户手册` 4.3.1「设备日志」原文列出「告警类型分为」：

1. 分贝报警超限 2. 谐波分量超限（HPSS超限） 3. 频带能量比超限 4. 主频超限
5. 奇偶谐波比超限 6. 频谱复杂度超限 7. **频带能量比超限（与第 3 条重复）** 8. 时域能量比超限

⚠️ **手册自身有一处重复**（频带能量比出现两次、而"时域能量比"只出现一次）：按**疑似笔误**处理，
**不据此实现**；实现时以 `alarm_reasons` 返回的**实际文本**为准，不要假定这 8 条就是枚举全集。

逐条与参数对应（我们自己的对应关系，手册没有画这张表）：分贝→`db_limit`、谐波分量/HPSS→`hpss_limit`、
频带能量比→`fde_ratio_limit`、主频→`main_freq_limit`、频谱复杂度→`sc_ratio_limit`+`sc_ratio_threshold`、
时域能量比→`tde_ratio_limit`。**奇偶谐波比**在已见参数里**没有对应项**（三种模式的示例参数里都没有），
**手册未说明**。

#### 15.23.4 告警记录的形状（**这是 §15.22.4 缺的那一块**）

告警**可以查询**（按工作模式分三个接口），返回 `{ logs_count, logs[] }`，每条：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | int | 日志编号 |
| `time` | string | 告警时刻，格式 **`yyyy-MM-dd_HH-mm-SS`**（注意是下划线，不是 ISO） |
| **`alarm_reasons`** | **string** | **告警原因文本**，例：`"时域能量比超限，"`（带一个中文逗号） |
| `alarm_value` | int | "Collection of alarm parameters"（**位集合**，见下） |
| `saving_path` | string | 告警文件所在文件夹，例 `"20220416_075133/"` |
| `audio_name` | string | 告警录音文件名，例 `"20220416_075133.wav"` |
| `files_status` | int | **文件是否还在**（被保留策略清掉后置 0） |
| `db_value` / `tde_ratio` / `fde_ratio` … | number | 该次告警的特征值（随模式不同而不同） |

几条**产品规则**（手册写明，照做即可）：

- 触发告警时设备自动保存**告警前 5 秒 + 后 5 秒**共 10 秒录音，以及**对应 10 张时频谱图**，
  以 `1.jpg`…`10.jpg` 存在以告警时刻命名的文件夹里；下载时 `file_path` 必须带
  `saving_path` + 文件名。
- 设备重启之后，告警前的数据可能不足 5 秒、图也可能少于 10 张 —— 后者是**正常**，不是缺陷。
- **设备只保留 5000 条告警记录**，超出时删除最早的告警文件并把那条的 `files_status` 置 0。
  所以"记录在、文件没了"是一种**预期状态**，界面必须能说清（我们的 `files_status`/`dauStatus`
  已经有对应的诚实处理）。

⚠️ **手册未说明**：`alarm_value` 这个"参数集合"的**位定义没有枚举**（原文只说 "see annotations
for specific content 4.4.1"，而 4.4.1 讲的是告警文件的保存说明）。所以**不要**把它当成
FA8 那套 14 位位图去解 —— 两者不是一套东西。实现时先如实把原始整数透出。

#### 15.23.5 另一条有用的发现：心跳

`GET/PUT /hb_settings` 有 `is_notify_heartbeat`（0/1）、`notify_interval`、`notify_url`
（示例 `http://192.168.2.190:8000`，**与告警回调不是同一个**），并且设备可以 `POST /heartbeat`
主动上报、由我们返回一系列信息。

这条对「**告警中心要包含设备离线告警**」有用：E2 族有一个**设备自己发的心跳**，
比我们单方面探测更权威（"设备说我还在" vs "我探测不到它"）。**手册未说明**心跳的具体请求体，
未说明它能否替代我们的健康检查。

#### 15.23.6 结论：E2/听诊盒子族**不必等回调体**就能做

§15.22.4 当时判定 FA110 卡在"回调 POST 的请求体手册没给"。这两份中文文档把局面改了：

- 告警**可以主动查询**（三个按模式分的日志接口，字段齐全），所以**不需要先实现回调接收端**；
- `notify_url` + `is_send_alarm` 是**可选的推送通道**（它的请求体仍未说明），当增强项；
- 阈值参数的读写接口（`GET /system` + 修改）也都在。

所以实现路径是：**先做"拉"（登录取 token → `/workmode` → 按模式读参数 → 查告警日志 → 下载告警文件），
把推送留到拿到回调样例之后**。这样 FA110/E2 这一族不需要任何一条编造的字段就能上线。

### 15.24 本地异常声纹样本库（业主 2026-09-16）：**做了什么、以及"AI 大模型"这件事的实话**

业主的要求分三句：把**告警与手动录音**建成**本地异常声纹样本库**、方便**后续二次训练**、
「可以把 AI 大模型引入，并支持用**打了标签的数据**进行样本训练」。

这一轮做完了**样本库的地基**（迁移 + 仓库 + 域层判断 + 可训练的基线 + 60 条测试）。
**没有**做：IPC、界面、数据集导出、以及任何大模型。下面把这三件分开说清。

#### 15.24.1 地基：一次迁移 + 一个仓库 + 两处纯函数

**schema v6 → v7**（`samples` 表，见 `schema.ts` 那条迁移里的长注释）：一条样本 = 一段音频的
来源 + 它的 7 维特征 + **谁给它定的类别**。四条设计决定值得单记：

1. **`label_source` 是一列，不是约定**。三类来源可信度完全不同：设备的自我判定（FA8 的
   `dauAbnoType` 位 / 听诊盒子族的 `alarm_reasons` 文本）、**人工标注**（唯一的真值）、
   **AI/模型建议**（待审的候选）。混在一起而不留出处，数据集事后**无法审计**，训出来的模型会
   自信地复述设备的猜测，而报告上写着"人工级标签"。所以有
   `CHECK ((label IS NULL) = (label_source IS NULL))` —— 要么都有、要么都没有。
2. **`label` 是自由文本，不是枚举**。两个设备族的词汇根本不通用：FA8 有 14 位分类法（已被它的
   API 手册逐位确认），听诊盒子族发的是 `alarm_reasons` 自由文本而**手册没有枚举**（§15.23.3）。
   硬塞进一个枚举意味着为**叫不出名字**的类别编槽位。值用稳定标识（`corona_discharge`）
   或设备原文，**永远不是界面文案**。
3. **`features` 是 JSON 文本**。7 维今天够用、以后会长；JSON 让旧版本仍能打开库。
   **缺失的维度保持缺失**（键不存在），绝不补 0 —— 补 0 等于编造一个测到的值。
4. **`recording_id` 级联删除**。样本的音频在源录音里，录音被删（保留策略）时样本必须一起消失，
   否则样本指向一个不存在的文件。

纯函数两处（都有单测，因为都是"一改就让数据集变脏"的地方）：

- `shared/domain/sample-library.ts`：标签归一化（含**去掉尾随分隔标点** —— E2 手册示例的原文就是
  `"时域能量比超限，"`，带一个中文逗号，不处理会把同一个类别切成两个）、设备位图→**弱标签**、
  特征向量（缺的维度是 `NaN` **不是 0**）、`isTrainable()`。
- `shared/domain/sample-classifier.ts`：**真的训练**（见下）。

#### 15.24.2 「支持用打了标签的数据进行样本训练」——**做成了一件真事**

这一句被落成了可验证的东西：一个**零依赖、纯函数**的最近质心分类器，
`trainClassifier()` / `predict()` / `evaluateLeaveOneOut()`。

为什么是最近质心而不是"更高级"的东西（写进代码注释了）：它**没有超参数可调**，所以不存在
"调出来的好看数字"；几十条样本就能跑（深度模型在这个量级只会过拟合，报出来的准确率是噪声）；
每个类别就是一个中心点，判错能直接看出离哪个类更近。

两条**不让指标说谎**的规矩：

- **先标准化再算距离**。7 个特征量纲差几个数量级（声压 ~50–120、主频 ~10–60000），不标准化
  时距离几乎只由主频决定 —— 模型看起来能跑、其实只学了一维。有专门一条测试用"只在平滑度上
  有区别、主频完全相同"的数据把它钉住。
- **评估用留一法**，因为样本量是几十条量级、切分法在这里是抛硬币；留一法不需要随机数，可复现。

⚠️ 而且这一轮的测试**当场揪出一个必须如实报出来的性质**：**每类只有 1 条样本时，留一法
结构上评不了那一类**（被评的那条一拿走，它那一类在训练集里就空了，判定必然落到别类），
准确率因此是 **0**，而那个 0 与"模型不行"**不是一回事**。所以 `Evaluation` 多了一个
`unassessable: string[]` 把这件事单独报出来 —— 否则用户会看到 0% 去怀疑一个没问题的模型。
（我第一版的测试断言写的是"准确率应该是 1"，是**断言错了**，代码把它纠正过来。）

#### 15.24.3 ⚠️「引入 AI 大模型」——**这一轮没有做，而且我不会假装做了**

必须说清楚，因为这是最容易糊弄过去的一句：

- **没有引入任何大模型**，没有新增依赖、没有网络调用、构建里没有任何模型权重。
  本仓库有"不新增依赖"的硬规矩，而且这台机器上连 Electron 的下载都会超时 ——
  所谓"接一个大模型"在这里只能是一个**假的**东西：一个看起来在跑、输出是编的桩。
- **也没有做 AI 打标签**。数据模型**能记录** AI 给的标签（`label_source = 'ai'`，
  `aiLabel()` 有单测），但**今天没有任何东西会产生这种标签** —— 我不是加了一个"AI 通道"，
  只是把"标签可能来自 AI"这件事在数据里留了位置，这对**审计**是必需的（混进来之后无法分辨）。
- 我**故意没有**先造一个 `AiLabeller` 接口加一个恒返回空的服务：那是一个没有调用方、
  也不会被验证的 API（本仓库一直在清理这种"看起来有"的东西）。

**诚实的实现路径**（下一轮可以选）：
1. **数据集导出**（不依赖任何模型）：把带标签的样本 + 清单（manifest）落成一个文件夹，
   供**外部**流水线做真正的微调。"二次训练"在这类产品里本来就该在外部做 ——
   本机的职责是把数据集**准备干净并导出**；
2. **可插拔的打标器**：由操作员配置一个**自己部署**的推理端点（像 SMTP 那样"配了才用"），
   我们只做"发样本 → 收候选标签 → **记成 `label_source = 'ai'` 并等人工确认**"。
   没有配置时**明确显示"未配置"**，绝不用桩输出冒充结果；
3. 界面上必须有"**只看人工标签**"的默认过滤：`isTrainable()` 默认就只认 `human`，
   要用弱标签必须显式选择（那等于"拿设备的判断去学设备的判断"，指标会虚高，代价由决定的人承担）。

#### 15.24.4 这一轮**没做**的（下一轮从这里接）

| 缺什么 | 说明 |
|---|---|
| **IPC + 界面** | 样本库页面（列表、按来源/标签筛选、播放、打标签/撤销）都还没有；`AppServices.sampleRepo` 已挂好 |
| **两个来源没有接** | 「把这条告警加入样本库」「把这段手动录音加入样本库」这两个入口还没做 —— 也就是**今天还不会自动产生样本**（仓库与迁移就绪，缺调用点） |
| **数据集导出** | 上面 15.24.3 的第 1 条 |
| **AI 打标** | 上面 15.24.3 的第 2 条（需要操作员自己的端点） |

#### 15.24.5 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；测试 **1358 / 0 失败**（比上一轮 +60，全部新增）；
i18n 无变化（本轮没有界面文案）；`electron-vite build` exit 0。

> 另外记一笔：这一轮我自己踩了两个坑，都被测试当场抓住 ——
> ① 把跨列的 `CHECK` 写在了列定义中间，SQLite 报 `near "features": syntax error`；
> ② 在那段 SQL 的**模板字面量内部**用反引号括了测试文件名，直接把模板提前闭合（一串 TS1005）。
> 两条都写在 `schema.ts` 的注释里，免得下一个人再踩。

---

### 15.25 样本库接完（业主 2026-09-16 同日，第二轮）：入口、导出、以及**真的**可插拔 AI 标注

上面 15.24.3 写下了「诚实的实现路径」三条，这一轮**三条都做完了**，而且顺序就是那三条的顺序。

#### 15.25.1 两个入口（这一轮之前**一条样本都产生不了**）

| 入口 | 位置 | 关键取舍 |
|---|---|---|
| **告警 → 样本** | 告警记录页：工具栏「加入样本库」（对勾选的多条）+ 详情抽屉里单条 | 告警是**唯一自带特征值**的来源（`spl`/`main_frequency`/`smoothness`/`band_energy_ratio`，设备在告警时刻报的），所以入库同时得到一个**弱标签**（`dauAbnoType` 位图的最低位置位 → 稳定键）。批量那是逐条插入而**不是**一个事务：一条失败不该让前面 11 条一起回滚。 |
| **录音 → 样本** | 录音文件页新增「样本库」列 | 录音行**一个特征值都没有**，所以入库后如实返回 `metricsStored: 0`，界面**明说**"已入库，但没有特征值，暂时不能参与训练"。绝不假装素材已经能用。 |

两条路都**幂等**：同一条记录点两次是"已在库"（`created: false`），报成失败会让操作员去查一个
不存在的问题。批量回执因此把 **新增 / 已在库 / 失败** 三个数分开说。

批量入参在 handler 里**收窄**（不是数组就当空数组），空数组是合法请求（返回一排 0）。

#### 15.25.2 数据集导出（供**外部**二次训练）

`SampleDatasetExporter`（`main/services/sample/sample-dataset-export.ts`）。导出一个文件夹：

| 文件 | 内容 |
|---|---|
| `samples.jsonl` | 每条样本一行：id、时间（epoch ms + ISO）、设备（id/名/类型）、通道、来源、标签与**标签来源**、`trainable` 与不放行的原因、音频相对路径与 sha256、7 维特征 |
| `samples.csv` | 同一批数据，表头固定顺序，**带 UTF-8 BOM**（不带的话 Excel 把中文表头与中文标签读成乱码，而那一列正是人要看的） |
| `dataset-info.json` | `feature_order`（**7 维的顺序**）、各类别条数、标签来源构成、`trainable_rule`、导出时间与版本 |
| `audio/`（可选） | 勾了「同时复制音频文件」才生成，文件名 `<样本 id>.<扩展名>` |

六个必须写对的点（每一条都有断言）：

1. **缺失维度是 `null`，不是 `0`**。CSV 里是空格。补 0 会凭空造出"主频 0 Hz"的样本。
2. **JSONL 每行键集合一致**（缺的写 `null`）。省掉那个键会让下游按行得到不同的列集合，
   而"没有这一列"与"这一列是空的"是两种不同的处理。
3. **CSV 转义**逗号、引号、换行 —— 中文标签里逗号是常态（`"时域能量比超限，轴承"`），
   不转义一个标签就能让整张表错位，而这种错在表格软件里只表现为"少了一列"。
4. **维度顺序写进 `dataset-info.json`**：7 维交出去不带顺序，接收方只能猜；猜错顺序训练出来的
   模型不会报错，只会不准。
5. **音频缺失如实计数**（`audioMissing`），并在该行标 `audio_missing: true`。静默跳过会让
   一个缺了一半音频的数据集看起来是完整的。**没勾复制时也照样探测**：那个标记说的是
   "这条样本的音频已经不在存储目录里了"，与"这次要不要拷走"无关。
6. **超上限报错而不是截断**（20000 条）：半份数据集比一份都没有更危险。

默认**不复制音频**：一次导出可能是几百兆，而训练常常就在同一台机器上读原路径；
默认复制会把"我只想导个清单"变成一次磁盘写满。目录由系统对话框选（`sample:pick-export-dir`），
磁盘根目录**拒绝**。

#### 15.25.3 AI 标注：**真的接上了**，但它是"候选"，而且是操作员自己的端点

15.24.3 说"没有引入任何大模型"。这一轮**引入了**，方式是：

- **配置**由操作员填：一个兼容 OpenAI `/chat/completions` 的地址 + 模型名 +（可选）API 密钥。
  **开关关着 = 不用**；没配置时界面显示**具体**原因（未启用 / 未填接口地址 / 地址不合法 /
  未填模型名），并且「让 AI 标注」按钮是**禁用**的 —— 不是"点了没反应"。
- **密钥**走 `safeStorage` 加密后落 `app_meta`（与设备口令、记住的登录密码同一条纪律）。
  系统加密不可用时**失败关闭**：只存地址与模型，界面照实说明。密钥**永不经过 IPC**，
  状态里只有 `apiKeyStored: true/false`（有测试断言回给界面的 JSON 里没有密钥内容）。
- **请求体只有数值**，没有音频：7 维特征（缺的写 `null`）+ 设备位图给的弱标签 +
  上一轮 AI 候选（**单独一格**）+ 库里已有的类别短语。把上一轮的 AI 猜测塞进"设备判定"那一格
  会让模型把自己的话当成设备说的 —— 那是自证，所以两格分开。
- **三条覆盖规矩**（按"谁更可信"排，各有计数）：
  1. `human`（人工确认过的真值）**永不覆盖**；默认动作连看都不看（窗口里排除掉，
     否则一个人工样本上千条的库里，前 50 条全是人工的，"标注一批"永远标不到东西）；
  2. `device`（设备弱标签）默认**跳过**；只有显式勾「包含带设备弱标签的样本」才覆盖，
     勾上时界面用警示色写明"位图判定会被替换、无法从这条样本恢复"；
  3. `ai`（上一轮候选）可以覆盖，没标签的直接写。
- **写进去的 `label_source` 恒为 `'ai'`**，而 `isTrainable()` 只认 `human` ⇒ 这批标签
  **不会自动进训练集**。要进训练集必须人工确认（改标成人工）。理由与 15.24.1 第 1 条相同：
  一个自己标自己训的模型会放大自己的错。
- **模型说"未知"不是类别**：`{"label":"未知"}` / `unknown` / `无法判断` 一律不进库，
  计为 `unresolved`（判不了 ≠ 失败，一次检修里出现几条很正常）。
- **回复解析**容忍现实里的包装（```json 代码块 + 前后一句话）：取第一个**括号平衡**的
  `{...}` 片段；但取不到 JSON、或没有可用标签就**报错**，不猜。
- **结果分五类计数**：`considered`（看了几条）、`requested`（真的问了几条）、`labelled`、
  `skippedHuman`、`skippedWeak`、`unresolved`、`failed`。合并成一个"跳过 N 条"会让操作员无法
  判断下一步该做什么；界面上还把前 5 条**错误原文**列出来。

网络层用 `node:http` 起**真的**本地服务测（不 mock `fetch`）：21 条测试覆盖未配置抛错、
覆盖规则、Bearer 头、请求体形状（`temperature: 0`、`response_format: json_object`）、
HTTP 503、网关返回 HTML、`{"label":"未知"}`、批量上限 50、以及"密钥不出现在状态里"。

⚠️ **未验证的部分（必须说清）**：这套东西**从未对着一个真实的大模型端点跑过**。
本机没有可用的端点，我也不会去连一个来"证明"。已验证的是**协议形状与全部本地行为**；
未验证的是"某个真实服务是否按这个形状回话"。第一次接真端点时，界面会把错误原文显示出来
（HTTP 状态 + 响应体里的 `error.message`），所以对不上时能立刻看出是对不上，而不是静默失败。

#### 15.25.4 界面与探针

- 侧栏新增**样本库**（`/samples`）：统计六格、筛选三格（来源 / 标签来源 / 类别）、
  训练与留一法结果（带**局限**：单一类别、每类不足 2 条、被上限截断）、
  样本表（类别编辑、撤销标注、删除）、**导出数据集**卡片、**AI 标注**卡片。
- 探针（`scripts/demo-shot.cjs`）新增 `/samples` 截图与四条屏幕级断言：
  告警中心有「加入样本库」且**未勾选时是禁用的**、录音表头有「样本库」列、
  样本库页有导出与 AI 两张卡片、AI 状态行说出**具体**原因且未配置时运行按钮禁用。
  （理由同 15.13.5：「控件没渲染」与「没有数据」在只报 0 problems 的探针里长得一模一样 ——
  所以这两条必须**无条件**断言，不能等有数据才检查。）

#### 15.25.5 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；测试 **1390 / 0 失败**（比 15.24 的 1358 多 32 条，
全部新增：导出 11 + AI 21）；i18n **1723 词条 / 0 缺失 / 四语言键集完全一致**
（本轮新增 46 + 43 = 89 个键，四语言同步）；`electron-vite build` exit 0；
`demo-shot --with-data` **0 problems**（含上面四条新断言），截图 `.demo-shots/10-samples.png`。

> 自查记一笔：这一轮有三处**我自己写错的测试断言**被代码纠正 ——
> ① 以为 CSV 只有 4 个特征列（域层是 **7** 维，测试改用 `SAMPLE_FEATURE_METRICS` 拼表头）；
> ② 以为"没勾复制音频就不探测文件在不在"（实现是**照样探测**，那是更对的：`audio_missing`
> 与"这次拷不拷"无关）；③ 以为 JSONL 里缺的维度**键不出现**（实现写 `null`，每行键一致，
> 那对下游更友好）。三次都是**断言错了**，代码是对的 —— 写在这里是因为这三条正是最容易
> 被"顺手改成好看的样子"的地方。

---

### 15.26 标签分成**两个维度** + 一个可维护的标签库（业主 2026-09-16 第三轮）

原话：「对于告警录音和手动录音，应该支持两个类型的标签，一个是**设备类型**，一个是**故障类型**，
这样方便后续进行数据采集和分类。对于标签的添加和使用，应该有个**专门的功能**去做标签的添加和
设备类型添加维护，之后在打标签时，直接**选择**故障类型和设备类型或**新建**故障类型和设备类型。」

上一轮（15.25）每条样本只有**一个**标签。这一轮把它改成两个维度，并补上一个专门维护的词表。

#### 15.26.1 为什么必须是**两列**，而不是拼成一个字符串

这两件事回答的是不同的问题，而且只有**组合**才有意义：「局部放电」在变压器上和开关柜上不是
同一种声学现象；而「轴承故障」这个故障名离开设备类型就没有外延。拼成 `变压器/局部放电` 之后：

1. 按设备类型筛样本要先做字符串切分 —— 一种最容易写错的解析；
2. 同一个设备类型的两种写法（`变压器` / `电力变压器`）会被当成两个设备类型；
3. 训练集统计只能按"组合"计数，**看不到**"某个故障类型跨了几种设备"这件要紧的事。

于是 schema **v7 → v8**（`sample-label-dimensions`）：

| v7 | v8 |
|---|---|
| `label` / `label_source` | **`fault_label` / `fault_label_source`**（含义不变：设备位图的弱标签本来就落在这一维） |
| — | **`equipment_label` / `equipment_label_source`**（新） |
| 一条表级 CHECK | **两条**：两维各自的"文字与来源要么都有、要么都没有" |

v8 是**整表重建**（`samples_v8` → 拷数据 → 删旧表 → 改名），不是 `RENAME COLUMN`：
`ALTER TABLE` 能改 CHECK 里的列名，但**加不了**新的 CHECK，而第二维必须有自己的那一条。
迁移把 `label → fault_label` 原样搬过去，所以已有样本的含义一个字都没变。

为什么设备类型那一维的 `device` 来源仍然留着（明知设备从不说它装在什么设备上）：CHECK 的取值
集合是**维度无关**的；为一个用不到的取值单开一套约束，只会让"这两个维度到底是不是一回事"
这个问题永远说不清。今天它只会是 `human` 或 `ai`。

#### 15.26.2 标签库（`sample_labels`）：一个专门维护的词表

`dimension`（`equipment` / `fault`）+ `name` + **`name_key`**，唯一约束在
`UNIQUE (dimension, name_key)`。三条规矩：

| 动作 | 规矩 | 为什么 |
|---|---|---|
| **加** | 同名**幂等**（返回 `created: false`），不是报错 | 操作员打出 `轴承故障 ` 这种带空格的重名是**常态**，那不是错误，是同一个类别 |
| **改名** | **连样本一起改**（一个事务），并报出改了几条 | 只改词表会让那些样本指向一个"库里没有的类别"，按故障类型筛选立刻列出 0 条 —— 看起来像数据丢了 |
| **删除** | 还有样本在用就**拒绝**，并说得出有几条在用 | 一句"删除失败"没法让操作员决定下一步。**没有**做"停用"（那要加一列）：宁可让他看到"3 条样本在用" |

`name_key` 是唯一性的真正依据（`labelNameKey()`：折叠空白、去尾随分隔标点、抹平大小写），
所以 `轴承故障` / `轴承故障 ` / `bearing` / `Bearing` 都是同一条。**库级**约束而不是 JS 判重：
在 JS 里判重会在两次点击之间漏掉一次插入。

`usedBy` 是**现场数出来的**（`COUNT(*) WHERE equipment_label = ?`），不是存下来的计数器 ——
一个会漂移的计数比没有计数更糟，因为界面会拿它当"能不能删"的依据。样本被删掉之后它立刻跟着变
（有测试钉住）。改名的同时会把样本里的来源改成 `human`：改名是人的动作，改完还留着 `device`
/ `ai` 就是在说谎（"设备判定"的那个名字已经不存在了）。

#### 15.26.3 打标签：**选**一个或**直接打一个新的**

样本表里「设备类型」「故障类型」两列各自是一个 `<input list=…>` + `<datalist>`：
候选来自标签库，直接打一个新的就是"新建"。保存时 `SampleLibraryService.setLabels()` 会：

1. 只动**调用方点名的**维度（`undefined` = 不改，`null` = 清掉）—— 默认清掉会让"只改故障类型"
   顺手毁掉已有的设备类型；
2. 对每个要写的名字先 `ensureLabel()` 一次（"或新建"那一半），并**写回库里那一份写法** ——
   否则同一个类别会因为"这一次多打了个空格"而分裂成两个；
3. 人工改标一律记成 `human`（操作员确认过的就是真值，哪怕它和设备说的一样）。

#### 15.26.4 训练：目标是**故障类型**，但设备类型进了报告

`isTrainable()` 的判据改成"**故障类型**是人工 + 必报维度齐"（设备类型是**元数据**，
不参与准入）。理由是声学模型要判的就是故障。但训练报告多了一段设备类型构成：

```
equipment: { counts, unassigned, mixed }
```

`mixed` 为真时界面提示「同一个故障类别在不同设备上可能不是同一种现象，准确率会偏低」，
但**不阻止**训练 —— 该不该合着训是领域决定，不是程序决定。这条与 15.24.2 里"指标必须带着
局限一起显示"是同一条纪律。

数据集导出同理：JSONL/CSV 里两个维度**各自一对列**（`equipment_label` + 来源、`fault_label` +
来源），`dataset-info.json` 里两组计数分开，`trainable_rule` 写明"设备类型是元数据、不参与准入"。

#### 15.26.5 AI 标注也跟着分成两维，但**候选不进词表**

提示词要求模型回 `{"equipment_label":…,"fault_label":…,"confidence":…}`；解析容忍旧字段名
`label`（换提示词之前配好的端点会按旧格式回话）。两条宽容度刻意不同：

- **故障类型必填**，且"未知"不算（它是训练目标，写进去等于多一个假类）；
- **设备类型可选**，模型说"未知"或没提就是**没有这一维** ——
  而且那时**不动**已有的设备类型（"这次没说"不等于"把人工标好的清掉"）。

AI 写进样本的标签**不会**自动进标签库：词表是操作员维护的短清单，让候选自动进词表，
一个每次换一个同义词的模型就能把它灌满噪声。候选要进词表，走**确认**那一步（界面上改成人工，
`setLabel()` 会 `ensureLabel()`）。

#### 15.26.6 顺带修掉一个**审计脚本的真缺陷**

`scripts/i18n-orphans.cjs` 的动态前缀正则要求 `${` 前面是一个**点**，所以
`` t(`samplesUi.dimension_${dimension}`) `` 一个前缀都收不到 ——
`samplesUi.dimension_equipment` 于是被报成"任何地方都没人用（可直接删）"。
上一轮 `labelSource_*` 没被误报纯属侥幸（那时它同时在模板里以字面量出现过）。
修法两条一起上：脚本补一条 `_${` 形状的前缀正则（只收**带命名空间**的，否则 `PCM_${x}`、
`unknown_${x}` 这类会把真孤儿盖住），界面侧改成**显式键表**（`DIMENSION_KEYS` /
`LABEL_SOURCE_KEYS` / `SOURCE_KEYS`）—— 键名同时是审计证据，拼出来的键等于没有证据。

#### 15.26.7 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；测试 **1412 / 0 失败**（比 15.25 的 1390 多 22：
标签库一批 + 两个维度的存储与筛选）；i18n **1748 词条 / 0 缺失 / 四语言键集完全一致**；
`electron-vite build` exit 0；`demo-shot --with-data` **0 problems**（新增断言：标签库卡片在、
两栏都在、样本表两列都在）。

> 自查两笔，都是**测试**先出错才发现的：
> ① 机械化迁移测试时，`seed()` 里 `...(input.label ? { label: … } : {})` 这个**展开**绕过了
> TS 的多余属性检查，于是"人工标注"那条样本其实**一个标签都没写**，覆盖规则那条测试因此
> 静默地测错了对象（`considered` 从 2 变成 3 才暴露）。已改成两个显式参数并注明原因。
> ② 一度想让 AI 的候选也进标签库（好让操作员在输入框里选得到），写完注释才发现那等于
> 让模型掌管词表 —— 改成"确认才进库"，并把理由写进服务层。

---

### 15.27 E2 / 听诊盒子族的「拉」通道（业主 2026-09-16 第三批第①项）

**资料再次被推翻了一处旧结论**：§15.22.4 写着"回调 POST 的请求体手册没给，所以不能写解析器"。
那句只对 2024-03 那份 **FA110** 文档成立。同族的 `API_doc_En听诊盒子API接口20231222.docx`
把**四种回调消息**全写出来了（见 15.27.4）。所以这一族现在**一条都不必猜**。

#### 15.27.1 端点清单（逐条来自手册，没有一条是推断的）

| 用途 | 端点 | 关键参数 / 返回 |
|---|---|---|
| 认证 | `POST /login` | `{username, password}`，**口令是 MD5 后的 32 位十六进制**；回 `{token}`；此后每个请求带 `Authorization: Bearer <token>`；失败或失效回 **401** |
| 工作模式 | `GET /workmode` | `work_mode` / `samplerate` / `audio_stream_url` / `stft_stream_url` / `stft_pic_height` / `stft_pic_width` |
| 参数读 | `GET /system` | 三种模式各自的阈值集合（+ 共用的 `notify_url` / `is_send_alarm` / `is_send_fft`） |
| 参数写 | `PUT /system` | 整份参数一起发（**不是**部分更新）→ 调用方 read-modify-write |
| 日志（全部） | `GET /alarm_log_all` | `start_col` / `col_count` |
| 日志（筛选） | `GET /alarm_log` | `start_time` / `end_time` / `start_col` / `col_count` / **`alarm_value`**（按告警类型位或筛） |
| 文件下载 | `GET /alarm_files` | `file_path` = **`saving_path` + 文件名**；回二进制；404 = 文件不存在 |
| 设备信息 | `GET /basic` / `PUT /basic` | `dev_name` / `dev_type` / `dev_version` / `upgrade_time` / `web_version` / `equip_number`；只允许改 `dev_name` |
| 心跳设置 | `GET /hb_settings` / `PUT /hb_settings` | `is_notify_heartbeat` / `notify_interval` / `notify_url` |
| 心跳应答 | `POST /heartbeat` | 设备打过来，**我们**回 `{message_type, sys_time, sys_time_str, dev_name, dev_type, dev_version}` |
| 重启 | `PUT /reboot` | — |
| 实时流 | `ws://{ip}/audio_stream` / `ws://{ip}/stft_stream` | PCM FLOAT / 通道 1 / 32 位 / LittleEndian |

#### 15.27.2 `alarm_value` 的位表**是有的**（又一次推翻旧结论）

§15.23.4 当时写着"位定义没有枚举，所以不要把它当位图解"。**同一个文件后面那一节**（§"Note"）
就给了表：

| 值 | 含义 |
|---|---|
| `0x00000001` | 分贝超限 |
| `0x00000010` | 主频超限 |
| `0x00000100` | 时域能量比超限 |
| `0x00001000` | 频带能量比超限 |
| `0x00010000` | HPSS 超限 |
| `0x00100000` | 频谱复杂度超限 |

**自洽验证**：手册示例 `alarm_value: 256`（= 0x100）配的 `alarm_reasons` 正是
"时域能量比超限，" —— 与表里 0x100 = 时域能量比一致。所以这张表可信。

但仍然**只解这 6 个**：用户手册 §4.3.1 的告警类型列表有 8 条（"频带能量比"重复一次），
其中"奇偶谐波比超限"在参数表与位表里**都没有对应项**。所以 `decodeE2AlarmValue()` 把
认不出的位置单独列成 `unknownBits`，界面照实显示"手册未说明的位"，不猜。

#### 15.27.3 落库：**不把 `alarm_value` 写进 `alarm_mask`**（schema v9）

`alarms` 表原先是按 FA8 的 14 位位图设计的：`decodeAlarmMask()` 解故障类型、
`deriveAlarmSeverity()` 按位给等级。听诊盒子族的数字是**另一套词汇**，混进去的后果很具体：

> `alarmMask = 256` 会被解成 FA8 的某个故障类型，而 `deriveAlarmSeverity(256)` 会给它一个
> **严重**等级 —— 一个设备从未报过的类型，加一个我们编出来的等级。

所以 v9（`alarm-device-payload`）给 `alarms` 加了五列，并**回填**旧行为 `source='fa8'`：

| 列 | 用途 |
|---|---|
| `source` | `'fa8'` / `'e2'`：这条告警是哪套协议报的 |
| `device_alarm_value` | 设备原始 `alarm_value`（**不参与**故障解码与等级判定） |
| `device_reason` | 设备自己的原因文本（`alarm_reasons`，如"时域能量比超限，"） |
| `files_status` | 设备上文件还在不在（1 在 / 0 已被 5000 条保留策略清掉）；FA8 行恒为 NULL = "这套协议不报这个" |
| `device_raw` | 整份设备载荷 JSON（三种模式的字段集合不同，给每个键开一列会冻死固件可以改的形状） |

听诊盒子族的行一律 `alarmMask: 0` + `severity: 'unknown'`（**显式传**，不是让
`deriveAlarmSeverity(0)` 去派生一个"由空位图推出来的等级"）。

映射到既有列的两处（写在这里以免下一轮有人以为是自动的）：`db_value → spl`（分贝值就是
声压级）、`main_frequency → mainFrequency`（只在电力设备模式出现）。

#### 15.27.4 回调体（**下一轮做推送时直接用**，本轮不实现接收端）

| 消息 | `message_type` | 字段 |
|---|---|---|
| 告警 | `alarm_msg` | `dev_name` / `alarm_time`（**`yyyyMMdd_HHmmSS`**）/ `alarm_reasons`（参数表带 s、示例不带）/ `alarm_value` / `saving_path` / `audio_name` / `files_status` / `db_value` + 按模式的 `tde_ratio`·`fde_ratio`·`main_frequency`·`hpss`·`sc_ratio`·`oeh_ratio` |
| 文件保存完成 | 参数表写 **`alarm_files_save_report`**、同页示例写 **`wav_save_report`** | `dev_name` / `file_path` / `save_status`（1 成功 / 0 失败） |
| 每秒计算结果 | `fft_data` | `dev_name` / `work_mode` / `fft_array`（**定长 4096**）/ `db_value` + 按模式的特征 |
| 定时心跳 | `heart_beat_message` | `sys_time` / `sys_time_str` / `dev_name` / `dev_type` / `dev_version`；**不需要** Authorization 头 |

三处手册自身的不一致都按"两个都收"处理（`isE2CallbackType()` 认两个 `message_type`）。

#### 15.27.5 这一轮落地的代码

| 文件 | 内容 |
|---|---|
| `shared/domain/e2.ts` | 端点常量、三种模式的参数表、`alarm_value` 位表与解码、两种时间样式的解析、`file_path` 拼装、谱图文件名、回调消息类型 |
| `main/services/device/e2/e2-client.ts` | 上面全部端点的 HTTP 客户端：MD5 口令、Bearer token、**401 自动重登一次**再重试、响应收窄、错误分档（400 = 我们参数错 / 404 = 文件被清掉 / 其它 = 设备故障） |
| `main/services/device/e2/e2-sync-service.ts` | 「拉」的落库：日志 → `alarms`（幂等）→ 要下载的 → `/alarm_files` → 存储 + `recordings`（`upsertRemote` + `attachFile`，幂等键 = `saving_path + audio_name`） |
| `schema.ts` v9 | 上面那五列 + `idx_alarms_source_time` |
| `tests/e2-client.test.ts`（33 条） | **真的**本地 HTTP 服务：口令必须 32 位 MD5、401 重登一次、`file_path` 必带 `saving_path`、`col_count` 必须显式传（手册默认值自相矛盾）、认不出的模式保留原文 |
| `tests/e2-sync.test.ts`（11 条） | **真的** WAV 字节 + 真的 `StorageService`：不写 `alarm_mask`、等级 unknown、幂等、时间解不出就跳过、`files_status=0` 不下载但登记、磁盘护栏挡住时**一个字节都没落盘**、谱图缺图算"少几张"不算失败 |

**修掉的两个真缺陷**（都是测试先出错才发现的）：

1. `parseE2Timestamp()` 原来直接信 `new Date(2022, 12, 45, 99, 99, 99)` —— JS 会**滚动进位**
   （13 月 → 次年 1 月），于是一个设备写错的日期被悄悄变成一个看起来完全正常的时间。
   现在**回读校验**六个字段，对不上就是 `undefined`。
2. `E2Client.readLogPage()` 声明了 `timeMs` 却从没填过（时间只存了原文）。补上解析，
   并把"设备原文"整份留在 `entry.raw` 里 —— 否则落库的 `device_raw` 会丢掉白名单之外的键。

#### 15.27.6 设备形态、界面与验证

**第四种机型**（`DeviceKind` 加了 `'auscultationBox'`，界面上叫「听诊盒子」）—— 这一族与另外两族
的三处分叉，都在 `device-service.ts` 里显式分支，没有一处靠猜：

| 分支 | 声纹设备（FA8） | 声学相机（FA371） | **听诊盒子（E2）** |
|---|---|---|---|
| 探活 / 身份 | `GET /get_devinfo` | 无身份端点：uid 按地址编（`fa371:`） | `GET /basic`；uid **优先用设备自己的** `equip_number`（`e2:`），没有才按地址编（`e2ip:`，前缀就写明它是编的） |
| 通道 | `/get_passageway` 的 `chinfoArray.length` | **0**（产品没有通道） | **1**（手册：channel count 1；整套接口没有按通道的参数） |
| 认证 | 会话策略协商 | `POST /login` + salt | `POST /login`（**MD5 口令**）→ `Bearer` token，会话缓存在客户端对象里 |
| 健康检查 | `GET /get_devinfo` | `GET /system/detect_status` | **`GET /workmode`** |

健康检查这一行是最容易写错的一处：用 `/get_devinfo` 去探一台听诊盒子会 404，而那会被
`markFailed()` 记成"离线"——**一台完全健康的设备显示离线**，是这套代码里最误导的一种症状
（相机当初踩的就是同一个坑，所以那次之后每一族都必须点名自己的"最便宜的认证读"）。

界面：设备详情页对听诊盒子**只保留三个页签**（概览 / 听诊盒子 / 设备维护）—— 其余六个
（通道、告警参数、网络、时间、RS485、Push）对应的是 FA8 的端点，在这一族上不存在，留着就是
让人点开一个永远读不到东西的页面。新增的「听诊盒子」页签（`AuscultationPanel.vue`）显示：

- 工作模式（认不出就显示**设备原文**）、采样率、时频谱图尺寸、设备型号/固件、告警保留条数；
- **阈值参数表**：只列设备真的回了的键，按"当前模式的专有参数 + 三种模式共用参数"排序，
  设备**多给**的键单独标一个「设备多给的键」徽标（那常常是固件比手册新的信号）；
- `GET /system` 失败时**单独一行**说明（"模式读到了、参数没读到"是可能的）；
- 「同步告警」按钮 + 结果五行（检查/新增/已在库、录音下载/复用/失败、文件被清、
  谱图、时间无法解析）。**没有**做参数写入：业主这一轮要的是"按模式**读**参数"。

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；测试 **1461 / 0 失败**（新增 44：客户端 33 + 同步 11）；
i18n **0 缺失 / 四语言键集一致**（新增 `e2Ui` 与 `domain.deviceKind.auscultationBox`、`deviceDetailUi.tabAuscultation`）；
`electron-vite build` exit 0；`demo-shot --with-data` **0 problems** —— 新增一条**无条件**断言：
点开「添加设备」后三个机型卡片都要在（`DEVICE_KINDS` 加了第三种而对话框没渲染出来，
表现只是"少一个选项"，探针只报 0 problems 时完全看不出来）。

⚠️ **未验证的部分**：真机不在手上。已验证的是**协议形状与全部本地行为**（真的本地 HTTP 服务 +
真的 WAV 字节 + 真的 `StorageService`）；未验证的是"某台真实 E2 是否按手册回话"。
设备侧还有一项**明知未测**：探活顺序假定 `/workmode` 在所有模式都可读（手册三种模式都列了它，
但没有真机确认）。

---

### 15.28 拿到第三份手册：这一族**有两代协议**，5 处必须改（业主 2026-09-17 提供 PDF）

业主给了 `Air Sonar User Manual 241128.pdf`（V3.2，1.2 MB）。抽出来之后第一件事就是与
§15.27 已经实现的东西**逐条对照** —— 结果不是"补充细节"，而是**换了一代协议**。

#### 15.28.1 抽取方式（这台机器上没有 PDF 库）

`pip download pypdf` 拿不到包（离线），Word COM 转换**挂住**（10 分钟超时，留下一个无声的
WINWORD 进程）。最后自己写了一个抽取器：解 FlateDecode → 展开对象流（ObjStm）→ 解析每个字体
的 **ToUnicode CMap** → 扫内容流的 `Tf`/`Tj`/`TJ`/`Td` 重建行。37 个内容流、5090 行、
4 个 CMap，产出 48 KB 文本，中文/英文都正常。
（`Air Sonar` 是英文手册，所以没有中文编码问题；但同样的抽取器对中文 PDF 也适用。）

> 记一笔**教训**：Word COM 那条路会静默挂住，而且它需要用户级 Word 实例 —— 在自动化里
> 不是一个可靠选项。能自己解就自己解。

#### 15.28.2 两代协议的对照表（这是这一节的核心）

> **业主 2026-09-17 澄清了这一代的产品身份**：那份 `Air Sonar User Manual 241128.pdf`
> 对应的是他们的一款 **SN-16 空气声呐**，用途是**声源定位**（不是"再一款听诊盒子"）。
> 手册示例里的型号串写的是 `AS16`，产品名是 SN-16 —— 所以代码里
> `e2ChannelCountFromModel()` **两种写法都认**（`AS16` / `SN-16` / `SN16`），
> 界面标签与设备机型项都按 **SN-16 空气声呐** 写。下表的表头与正文沿用"Air Sonar"
> 是因为它逐条引自那份手册；**产品名以 SN-16 为准**。

| | 听诊盒子（`API_doc_En…20231222`） | **SN-16 空气声呐（手册里叫 Air Sonar V3.2，241128）** |
|---|---|---|
| 型号 / 通道 | 通道数 **1**（"PCM FLOAT, channel count of 1"） | **16 通道**（`/realtime_chan` 1..16；`/all_chns_stream` 是 16 通道 PCM SHORT）；型号串手册写 `AS16`，产品名 **SN-16** |
| 工作模式 | `work_mode` 三种 | **没有这个概念**（单一用途 + PTZ 联动） |
| 参数（`/system`） | `db_limit`/`tde_ratio_limit`/`fde_ratio_limit`/`freq_*`/`hpss_limit`/`main_freq_limit`/`sc_ratio_*`/`samplerate`/`notify_url`/`is_send_alarm`/`is_send_fft` | `db_limit`/`tde_ratio_limit`/`fde_ratio_limit`/`freq_*`/`samplerate`（固定 20K）/`notify_url`/`is_send_alarm`/**`is_send_realtime_value`** + **PTZ 一组**：`cam_enable`/`cam_ip`/`cam_port`/`cam_user`/`cam_pass`/`is_cam_init`/`is_ptz_direction_same_with_sonar`/`is_save_snapshot`/`cur_realtime_channel` |
| 日志（全部） | `GET /alarm_log_all` | **`GET /get_all_alarms`** |
| 日志（条件） | `GET /alarm_log`（还支持 `alarm_value` 位或筛） | **`GET /get_alarm_logs_conditional`**（只有时间区间，**没有** `alarm_value`） |
| 日志字段 | `id`/`time`/`alarm_reasons`/`alarm_value`/`saving_path`/`audio_name`/`files_status`/`db_value`+按模式特征 | `id`/`time`/`db_value`/`tde_ratio`/`fde_ratio`/**`horizontal`**/**`vertical`**/`saving_path`/`files_status` — **没有** `alarm_reasons`、**没有** `alarm_value`、**没有** `audio_name` |
| 录音文件名 | `audio_name` 由设备给（时间戳名） | **固定 `alarm.wav`** |
| 告警图 | **10 张时频谱图**（`1.jpg`…`10.jpg`） | **3 张 PTZ 抓图**（`1.jpg`…`3.jpg`，1 秒一张） |
| 下载 | `GET /alarm_files?file_path=` | **`GET /saving_alarm_file?file_path=`** |
| 设备信息 | `GET /basic` | **`GET /get_device_basic_params`**（字段一样） |
| 口令 | 手册只写 "MD5 encrypted password, 32 characters" | **`lfxs` + MD5**（同厂 FA371 也是这个盐） |
| 新增端点 | — | `PUT /NVTconfig`（PTZ 参数）、`GET /NVTconfig`（PTZ 的 RTSP 地址）、`PUT /realtime_chan`、`PUT /time_sync_with_nvt` |
| 实时流 | `ws://{ip}/audio_stream`（单通道 PCM FLOAT 32 位）+ `/stft_stream` | `ws://{ip}/audio_stream`（单通道 PCM SHORT 16 位）+ `/all_chns_stream`（16 通道）；**客户端要每 50 秒发一次心跳** |
| 保留条数 / 前后 5 秒 / `files_status` 语义 | 5000 / 是 / 一样 | **一样**（这几条两代一致） |
| 回调 | `alarm_msg`（带 `alarm_value`/`alarm_reasons`）、`alarm_files_save_report`（示例叫 `wav_save_report`）、`fft_data`、`heart_beat_message` | `alarm_msg`（带 `horizontal`/`vertical`，**不带** `alarm_value`/`alarm_reasons`）、`alarm_files_save_report`（示例仍叫 `wav_save_report`）、**`realtime_value`**（`max_db_chn`/`max_db_value`/`max_fdr_value`/`max_tdr_value`，取代 `fft_data`）、`heart_beat_message` |

#### 15.28.3 已经改掉的 5 处（都因为这份手册）

1. **变体是一个显式概念**。`E2Variant = 'auscultation' | 'airSonar'`，判定靠**设备自己的回话**
   （`/system` 里有 PTZ 键 ⇒ airSonar，有 `work_mode` ⇒ auscultation；两者都没有 ⇒ `undefined`，
   也就是"认不出"，那一天界面照实说，不硬塞进某一代）。**不按型号名猜、也不让用户选。**
2. **端点按变体取**（`E2_ENDPOINTS_BY_VARIANT`）：日志 / 下载 / 设备信息三处路径两代都不同。
   同步开始前先 `ensureVariant()` —— 不先判一次，一台 Air Sonar 会被拿去查 `/alarm_log_all`，
   回 404，而"设备没有日志"看起来就像一个结论。
3. **口令摘要两种都试**。两份手册写的不是一回事（一份只写 MD5，一份写 `lfxs` + MD5），
   而同厂 FA371 用的是加盐那一版。处理方式不是挑一个：**先加盐，401 再不加盐**，记住成的那种
   （`resolvedPasswordStyle`）。这是**文档互斥**，猜错的代价是"永远登录不上"，而试两次的代价
   只是一次多余的请求。真机验过之后应当删掉没用的那一条。
4. **落库与展示按变体分化**：录音文件名（设备给 vs 固定 `alarm.wav`）、告警图张数与语义
   （10 张时频谱 vs 3 张 PTZ 抓图，界面措辞也不同）、通道数（1 vs 从 `dev_type` 读出的 16）。
   Air Sonar 的行**没有** `alarm_value`/`alarm_reasons`，所以那两列留空 —— **不编**。
5. **PTZ 相机口令不显示**：`cam_pass` 会出现在 `/system` 的回话里（设备把它回给了我们），
   但界面只显示「已设置（不显示）」。与设备口令、账户口令同一条纪律。

另外把机型项的中文名改成「**听诊盒子 / Air Sonar**」（同一个机型项覆盖两代产品），
并在参数表里**按组显示**（阈值 / 相机 / 开关 / 其它）—— Air Sonar 一次回 18 个键，平铺一列没法看。

#### 15.28.4 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；测试 **1472 / 0 失败**（新增 11：变体判定 6 +
两种口令摘要 4 + Air Sonar 同步 3，另有几条既有断言按新行为调整）；i18n **1810 词条 / 0 缺失 /
四语言键集一致**；`electron-vite build` exit 0；`demo-shot --with-data` **0 problems**。

⚠️ **仍未验证（真机不在手上，两代都没有）**：

- Air Sonar 的**16 通道**只在型号字符串与手册文字上确认过；界面目前仍按"单通道"建这条设备的
  通道表（`AS16` ⇒ 16 这个换算已经写在代码里，但**没有**拿它去建 16 行通道，因为那要连同
  通道墙/监听选择一起改）。这是下一轮的事，不是遗漏。
- 两代的实时流（WebSocket）都还没接；Air Sonar 的 `/all_chns_stream`（16 通道 PCM SHORT）
  与"每 50 秒发心跳"这条要求已经记在这里，实现要等真机。
- 口令到底是哪一种（加盐/不加盐）**必须**用真机定下来，然后把另一种删掉。

#### 15.28.5 又抓到一个真缺陷：第三种机型**加不进库**（schema v10）

写 `tests/e2-device.test.ts`（用**真的** `DeviceService` 走一遍 probe → add）时第一轮就红了：

```
SqliteError: CHECK constraint failed: kind IN ('acousticBox', 'acousticCamera')
```

v3 给 `devices.kind` 加的是一条**列级 CHECK**。上一轮我改了 `DeviceKind` 联合类型、加了探活分支、
加了界面选项 —— 但**没有改库约束**，所以"添加设备"会在写库那一刻失败，而错误信息会把排查
方向引向协议。这正是"只改 TS 类型不改库约束"这类缺陷的典型表现。

v10 重建 `devices` 表把 CHECK 放宽到三种机型。重建一张**被四张表引用**的父表有一个会
**删数据**的坑：外键打开时 `DROP TABLE devices` 会先做一次**隐式 DELETE**，而
channels / alarms / recordings / samples 全是 `ON DELETE CASCADE` —— 现场数据会被级联清空。
所以迁移器新增了一个 `foreignKeysOff` 开关（**在事务外面**切 PRAGMA：`PRAGMA foreign_keys`
在事务内部是空操作，迁移函数自己设它没用），跑完再验一次 `PRAGMA foreign_key_check`。

`tests/device-schema-v10.test.ts` 因此断言的重点不是"新机型能写进去"，而是
**"一台设备 + 它的通道/告警/录音/样本在升级后一条都没少"**，外加：
`idx_devices_uid` **仍然是 UNIQUE**（重建时最容易写松的一格，写松了就没有任何报错）。

测试 **1489 / 0 失败**（+17：设备分支 12 + 迁移 5）。

---

### 15.29 实时监测页的结构改造（业主 2026-09-17 第二批）：本轮做了 ③④⑦

业主给的第二批是七条（②③④⑤⑦⑧⑨）。这一轮做掉三条**删除/搬迁**类的（它们的意图没有歧义），
剩下的四条（②⑤⑧ 是新增与排布、⑨ 是把四块搬进设备管理）留到下一轮 —— 那四条需要新的卡片与
新的页签，混在一起做会让"改错了哪一条"无法归因。

#### 15.29.1 ④ 设备下拉搬进顶栏（50% 宽）

顶栏留了一个**空容器** `#topbar-page-slot`（`flex: 1 1 50%`），页面用 `Teleport` 把控件投进去。
为什么是"容器 + Teleport"而不是给顶栏加 prop：顶栏因此不必知道有哪些页面、每个页面有什么控件；
唯一的契约是一个 `id`，而它只被一个地方引用（`MonitorView`）。宽度由**顶栏**决定 ——
"50%" 是布局的规矩，不该由每个页面各写一遍。

页头里那一份同时删掉（`.monitor-head__device`）：两份下拉会让"在看哪台设备"有两个答案。

#### 15.29.2 ⑦ 删视频墙与相机声学数据卡片；相机控制与告警并排

删的是**实时监测页的用法**，不是组件：多路视频墙在**总览**页仍然是主视图（`OverviewView` 里
`<CameraVideoWall auto-play>` 还在），两个页面各挂一次同一块墙等于同一批视频流有两份起播逻辑
与两份音量状态。相机声学数据卡片同理 —— 那五个 WebSocket 通道已经由这一页自己的图谱呈现。

> **这一段后来被更正过**（§15.31.1）：视频墙那半句仍然成立；"相机声学数据卡片同理"是错的 ——
> 业主确认 ⑧ 就是「那五路排成一排」，⑦ 删掉的是它的**旧版式**，不是这块面板本身。

新加的告警卡片（`.camera-alarm-entry`）与 `CameraControlPanel` 都是 `.camera-board` 的网格子项，
所以在有宽度时自动并排（探针实测同一行；`.camera-board` 仍是 `auto-fit minmax(360px,1fr)`）。

#### 15.29.3 ③ 「数据流状态」与「当前帧」两张卡片删除 —— **但失败不许变哑**

这两张卡片按字面删掉了。删之前先问了一句"它真正的价值是什么"：那张流状态卡片的用处是
**哪一路坏了**（全局状态说"断开"，而现实里常见的是特征流好着、时频图那一路一直失败）。
所以删卡片的同时补了**一句话** `streamFailure`：有流进入 `ERROR` 就把"哪一路 + 最近一条错误"
写出来。删掉信息面而不留替代，等于把一次可诊断的故障变成一次沉默。

「当前帧」显示的四项里，采样率与当前通道已经在页头的通道页签与音频条上，数据来源与谱图缓存
是排查用的内部状态（需要时由协议实验室回答）。

#### 15.29.4 两处需要记下来的"顺手发现"

1. **删了标记，没删样式**：`.stream-strip` 等 11 条 CSS 规则留在了文件里，是新增的源码守卫
   （`tests/page-layout.test.ts`）报出来的。死样式不会报错，只会让下一个人以为那块还在。
2. **解释性注释会绊倒"已经删掉"的断言**：`<!-- 这里原来挂过 CameraAcousticPanel，为什么删 -->`
   与"又挂回来了"在文本上一模一样。所以 `tests/page-layout.test.ts` 新增了 `stripComments()`，
   断言一律跑在**去掉注释**的源码上（本文件在加它之前真的报过一次假失败）。

#### 15.29.5 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；测试 **1493 / 0 失败**（+4：页守卫 4，
另有两处既有守卫按新结构**有意**改写并注明原因）；i18n **0 缺失 / 四语言键集一致**（删了 22 个
死键、新增 3 个）；`electron-vite build` exit 0；`demo-shot --with-data` **0 problems**，
新增两条 DOM 断言：设备下拉**在顶栏那一格里**且那一格约 50%（实测 48%），
以及切换设备到相机之后**相机控制与告警在同一行**（`sameRow: true`）。

#### 15.29.6 这一批**还没做**的四条（下一轮）

- **②** 每通道声纹特性卡片 + 音频播放按钮 + 音量（声纹设备那一支）；
- **③b** 实时趋势挪到视频墙的位置，其下四张图谱卡片 + 时间轴回放；
- **⑤** 相机那一支改 16:9 视频窗口、与总览的右键功能一致、最多两通道；
- **⑧** 五张图谱排成一排（声纹图 / 频谱图 / 能量点 / PRPD / 检测结果）；
- **⑨** 升级 / 维护 / 告警策略 / 检测模式移进设备管理的配置界面（要连**设备详情的页签按机型分化**
  一起做：现在相机也会看到 FA8 的通道/RS485/Push 页签，那些端点在它上面不存在）。

---

### 15.30 ⑨ 相机配置搬家（业主 2026-09-17 第二批第 3 轮）

#### 15.30.1 同一份实现按 `sections` 取用，不复制组件

`CameraControlPanel` 加了 `sections?: CameraControlSection[]`（`mode` / `preset` / `detect` /
`strategy` / `maintenance` / `upgrade`，不传＝全部，手感与改造前一致）：

| 页面 | 取哪几块 | 为什么 |
|---|---|---|
| 实时监测页 | `detect` + `preset` | 「检测启停」是**看的时候要按的东西**；「应用场景」是边看边切的预设 |
| 设备管理 → 检测模式 | `mode` | ⑨ 要求搬走 |
| 设备管理 → 告警策略 | `strategy` | ⑨ |
| 设备管理 → 维护与升级 | `maintenance` + `upgrade` | ⑨ |

不拆成四个组件是因为它们共享同一批 IPC、同一套 `canWrite` 与"读了要写回"的规矩 ——
复制一份之后两处迟早不一致。代价是**每一路读取也要按 `sections` 条件化**，否则同一批数据会被
拉三遍，而且"读的"与"画的"会不一致（那种不一致排查起来像设备出了问题）。

#### 15.30.2 顺带修掉的既有缺陷：相机也会看到 FA8 的页签

设备详情页原来对**所有**机型显示同一组页签：通道与采样率 / 告警参数 / 网络配置 / 时间 /
RS485 / Push 上报。那些端点（`/get_passageway`、`/alarm_profile`、`/recorder_conf`…）
在相机上**都不存在** —— 点开就是 404，而 404 会被读成"设备离线"。
现在页签由机型决定：相机是「概览 / 检测模式 / 告警策略 / 维护与升级」，
听诊盒子是「概览 / 听诊盒子 / 设备维护」，声纹设备仍然是原来那一组。

换设备之后页签不在新机型那一组里时**退回概览**（例如从相机切回声纹设备时停在 `cameraDetect`），
否则页面是一片空白，而空白看起来像"这台设备没数据"。

#### 15.30.3 两个只有 GUI 探针能抓到的缺陷

1. **TDZ 崩溃**：`visibleTabs` 与那个纠正页签的 `watch` 第一版被写在了 `TABS` 旁边，
   而 `watch` 的取值函数在 setup 阶段就会跑一次 —— 那时 `const device` 还在 TDZ 里，
   整页抛 `ReferenceError: Cannot access 'device' before initialization`（Vue `runtime-2`）。
   `vue-tsc` 编译通过、单测全绿，只有探针的 console 断言报了出来。
2. **"只是变灰了"的功能性回归**：「启用中的策略」这一路读取第一版只按 `strategy` 条件化，
   而**检测启停按钮的可用性依赖它**（没有启用策略时设备回 `ret:-1`，所以开始按钮是禁用的）。
   于是实时监测页的开始按钮被永久禁用 —— 一个不报错、不崩溃、只是不能用的问题。
   现在它同时被 `strategy` 与 `detect` 触发，并且有一条源码守卫钉住这条**跨块依赖**。

#### 15.30.4 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；测试 **1498 / 0 失败**（+5：sections 守卫 5）；
i18n **0 缺失 / 四语言一致**（+3 个页签名）；`electron-vite build` exit 0；
`demo-shot --with-data` **0 problems** —— 新增一条**按路由**取的断言：
相机详情页的页签恰好是「概览 / 检测模式 / 告警策略 / 维护与升级」，且**没有** FA8 的三个。

> 第一版这条探针是"点设备树"的，结果是 `skipped（没找到相机节点）` —— 等于没测。
> 改成用 IPC 拿设备 id 再直接走 `/devices/<id>` 路由：**探针不该因为"点不到"而跳过一条能测的断言**。

---

### 15.31 ⑧ 相机五路实时图谱排成一排（业主 2026-09-17 第二批第 4 轮）

#### 15.31.1 先把 §15.29.2 的话更正掉：⑦ 删的是**旧版式**，⑧ 定的是新版式

第二轮里我把 ⑦ 读成了"相机声学数据卡片**不需要**了 —— 那五路已经由这一页自己的图谱呈现"，
并且按那个理解把 `CameraAcousticPanel` 从实时监测页删掉了。业主随后确认的 ⑧ 是
「相机五路实时数据排成一排」：**⑦ 删的是它旧的版式，⑧ 定的是新的版式**。

两句话不冲突，但第二轮的推理是错的（值不值得留一块面板，与它排成几列是两件事）。
所以这块回来了，带的是新排布；`docs/UI-VERIFY.md` 里也把这一条列成"需要人眼确认"的。

#### 15.31.2 两个决定：整幅宽 + 由**这一排自己**的宽度决定列数

| 决定 | 为什么 |
|---|---|
| 这一块**占满整幅宽**（`camera-board__wide`） | 板子的一格在 1440 窗口下按列宽规则算下来是 (1166 − 2×20)/3 ≈ 375px；五张挤在 375px 里，每张 ~60px —— 那也是"一排"，但表头与坐标轴都放不下 |
| 列数用 `repeat(auto-fit, minmax(200px, 1fr))`，**不用** `@media` | 这一块的宽度不由**窗口**决定，由外层排布板给它的那一格决定。媒体查询问的是窗口，不是这一排 |

第二版（对，第一版就是这么写的）是 `repeat(5, minmax(0,1fr))` 加三条
`@media (max-width: 1500px / 1000px / 700px)` 退成 3 / 2 / 1 列。它在那台探针窗口上
（1440×900）**当场就错了**：媒体查询命中 1500 那一档，五张图被折成 3 + 2
（`graphTops: [767,767,767,1321,1321]`），而版面本身一点都没有变窄 —— 变窄的是窗口，
不是这一排。`auto-fit` + 最小 200px 问的才是这一排自己的宽度。

#### 15.31.3 这一轮测的是"同一排"，不是"有五个元素"

探针新增的四个量（都是无条件断言，"量不到"也报问题）：

| 量 | 实测（1440×900 探针窗口） | 判据 |
|---|---|---|
| `graphTops` | `[767,767,767,767,767]` | 五个顶边之差 < 8px |
| `panelWidth` / `rowWidth` | 1166 / 1166 | 这一排必须占满面板（差 ≤ 1px），面板必须占满排布板 |
| `graphWidths` | `[220,220,220,220,220]` | 每张 ≥ 200px（放得下表头与坐标轴） |
| `rowOverflow` / `rowFifthRight` | 0 / 0 | 这一排自己不横向溢出；第五张的右边缘不越过这一排 |

同一轮里还删掉了探针里一个**误导性的 0**：`monitor chrome` 原来量
`.camera-acoustic`（这个类名在源码里根本不存在），于是报告里永远有一句
`acousticPanel: 0`。它从没被断言过，但读报告的人会把它读成"面板不在" ——
那正是 §15.13.5 说的"控件没渲染"和"排错了"长得一样。

#### 15.31.4 被这次改动**绊倒**的两条既有守卫（都要改，不是"测试坏了好修"）

1. `tests/camera-ui-round.test.ts` 里有一条 ⑦ 的守卫断言"实时监测页**不许**出现
   `<CameraAcousticPanel`" —— 它是按第二轮那个错误理解写的。现在改成
   "在 + 是整幅宽的那一块"：⑦ 删的是旧版式，⑧ 定的就是新版式。
2. 同一条用例还数了 `camera-board__wide` 在文件里出现的**次数**（= 4：选择器 + 三处注释/用法）。
   这次多了一处用法就让数字变了。数出现次数会被**注释**绊倒（这已经是它第二次绊倒：
   上一轮 `stripComments()` 就是为同一类问题加的），所以改成数**用法**
   （`class="…camera-board__wide"` 恰好 2 处：设备头 + 相机图谱），并单独钉住每一处。

#### 15.31.5 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；测试 **1498 / 0 失败**（这一项改的是既有守卫，
不是新增用例：⑧ 的守卫从"一排五列 + 媒体查询断点"改成"auto-fit 列宽 + 整幅宽 + 不许再由
窗口宽度决定"）；i18n **0 缺失 / 四语言键集一致**（7 个孤儿全部只有测试引用，未动）；
`electron-vite build` **exit 0**；`demo-shot --with-data` **0 problems**，`monitor camera` 那一行
的实测值见 §15.31.3；`npm run dist:win:offline` 出包
`release\HERTZINNO Acoustic Box Manager-1.0.0-x64-setup.exe`（127,020,798 B，
sha256 `6AFCD33EDC94DAFE08B377AC808014152C6471B682FD2099239F8207E2D4AB62`）；
`node scripts/verify-packaged.cjs` **25 通过 / 0 失败**。

#### 15.31.6 这一轮的**未验证**清单（诚实版）

1. **能量点表格在 220px 卡里的表现**：这台相机离线、没有实时能量点，`v-if` 让表格不渲染，
   所以探针量到的 `tableOverflow` 是 `null`（报告里会写出来）。为了不让五列表把卡片撑开，
   我加了 `table-layout: fixed`（五列等宽地分这一张卡的宽度）—— 那是**预防措施**，
   不是实测结论。要真验证，得让一台在线相机有实时能量点，或在页面上造一份能量点数据。
2. **业主真实屏幕上的列数**：所有数字都来自探针强制的那一档（内容区 1440×900）。
   在更宽的窗口上 `auto-fit` 会给同一排更多宽度（每张 > 220px）；在 1166px 以下会先掉到 4 列
   （第 5 张折行）。这条降级曲线是**算出来的**，没有逐档实测。
3. **五路图谱自身的内容**：这一轮只动排布。五条流是否都在直播、图谱画得对不对，
   属于相机那一路的功能验证，不由这一轮的探针回答。

---

### 15.32 ② 每通道声纹特性卡片 + 音频回放（业主 2026-09-17 第二批第 5 轮）

#### 15.32.1 "每通道"这三个字决定了数据从哪来

设备**一次只在一路通道上开流**（MEASURED：`PROTOCOL-FINDINGS 4.3`，`monitor.ts` 的
`start()` 就是按这个写的：切通道 = 停一套连接、开另一套）。所以"此刻的每通道特性"
这个数据**不存在** —— 存在的只有"每一路最后一次读到的那一帧"。

于是这一轮做的是：把每一路的最后一帧**记下来**（`stores/monitor.ts` 的
`channelFeatures`），卡片上按三种状态分开写：

| 状态 | 何时 | 卡片上写了什么 |
|---|---|---|
| `live` | 就是此刻订阅的那一路，且帧真的在进来 | 「实时」+ 更新时间 |
| `stored` | 有读数，但不是此刻在收的那一路 | 「最后一次读数」+ 更新时间 |
| `unread` | 从来没有读到过 | 「未读取」+ 一句"这一路还没有读到过特征帧" |

把 `stored` 画成 `live` 比不显示更糟：那是一个**看起来新的旧数字**。所以卡片上
"数值"与"更新时间"是**同真同假**的（有一条探针断言在钉这件事）。

#### 15.32.2 一处容易写错的地方：每通道读数**不随会话清空**

`unsubscribe()` → `clearBuffers()` 会清掉所有显示缓冲，而切通道正好会走 `unsubscribe()`
（因为切通道 = 停一次会话）。如果 `channelFeatures` 放在 `clearBuffers()` 里，切一次通道
七张卡片就会全空 —— 那正是这张表存在的意义被抹掉。

所以它只在**换设备**时清空（`selectDevice()`）：那些读数属于上一台设备。
`tests/page-layout.test.ts` 里有一条守卫同时钉这两件事（清缓冲函数里不许出现它、
选设备函数里必须有它）。

#### 15.32.3 音频回放：一句说明与一个真音量

「播放」按钮播出的是**包络预览**，不是原声：跨 IPC 过来的是 100 ms 一帧的降采样波形
（每个桶取绝对值最大的采样点），回放按它真实的时长重采样后排队 —— 时间是对的，
声音不是。按钮旁边那句 `audioPreviewHint` 就是照这个写的，**它必须留着**：
不说清楚就等于让操作员以为他听到的是设备里的原始声音。

音量做在 `GainNode` 上（这里没有 `<audio>` 元素可用），并且**先调音量再按播放也算数**
（`setVolume()` 在未起播时记住值）；默认 60% 是我们自己选的（留给操作员调大的余地）。

实现与相机声学面板**共用一份**（`lib/envelopePlayer.ts`）：那一支第一版里同类代码是
内联在组件里的，两份实现早晚会在"浅队列"这类细节上分叉，而分叉的表现（按下停止还在响、
声音延迟越来越大）最难查。纯计算（重采样、"浅队列"的时刻）拆到 `lib/audioPreview.ts`，
那个文件不碰浏览器对象，所以能在 node 里逐条单测。

#### 15.32.4 ② 里的"去掉视频窗口"不用改：那一支本来就没有

② 的原文还带一句"去掉视频窗口"。核对结果：**声纹设备那一支没有视频窗口**——
整个文件里唯一的 `<video>` 在 `v-if="isCamera"` 的单路直播面板里（第 1365 行），
而多路视频墙已经在 ⑦ 里删掉了。所以这一句在这次改动之前就已经成立，
本轮**没有为此改任何东西**（记录在此，免得下一次审计以为漏做了一条）。

#### 15.32.5 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；测试 **1526 / 0 失败**（+28：新增
`tests/channel-features.test.ts`（10）、`tests/audio-preview.test.ts`（14）、
`tests/page-layout.test.ts` 的 ② 守卫（4））；i18n **0 缺失 / 四语言键集一致**
（+11 个新键× 4 语言，7 个孤儿仍是"只有测试引用"）；
`electron-vite build` **exit 0**；`demo-shot --with-data` **0 problems**，新增的 DOM 断言
实测：**8 张通道卡片 = 8 个通道页签**、恰好 1 张高亮、每张卡片恰好 1 个状态标记、
"有数值 ⇔ 有时间"全部成立、播放按钮/音量滑杆/那句说明各 1 个；
`npm run dist:win:offline` 出包
`release\HERTZINNO Acoustic Box Manager-1.0.0-x64-setup.exe`（127,023,939 B，
sha256 `9851E1AD37922B042F11F887CC163115249659829308054807428569705022BF`）；
`node scripts/verify-packaged.cjs` **25 通过 / 0 失败**。

#### 15.32.6 这一轮**未验证**的部分（诚实版）

1. **声音本身**：设备离线，探针量到的是"播放按钮 disabled=true、音量 60%"，
   也就是**没有预览帧可播**。回放到底好不好听（包络回放的真实听感、音量滑杆的实际效果）
   只能在真机上由人耳确认 —— `tests/audio-preview.test.ts` 只能证明重采样与队列时刻的
   **数学**是对的。
2. **`stored` 状态在真实数据下的样子**：要一台在线设备、切一次通道，才会看到
   "CH1 是最后一次读数 + 时间"这种卡片。当前所有 8 张都是 `unread`（离线）。
3. **本机时间格式**：卡片上的时间是 `toLocaleTimeString()`，跟随系统区域设置，
   没有跟着界面语言走（我们没做这一层）。

---

### 15.33 ⑤ 相机那一支：16:9 视频窗口 + 右键与总览一致（业主 2026-09-17 第二批第 6 轮）

#### 15.33.1 16:9 是**窗口**的比例，不是画面的比例

改的是 `.camera-live__stage`：`min-height: 320px` + 视频 `max-height: 62vh`（比例随卡片
高度变形）换成 `aspect-ratio: 16 / 9`，视频用 `object-fit: contain` 填满这个窗口。
画面比例由设备决定，窗口比例是我们能定的 —— 定成 16:9 之后，操作员看到的框不会随着
窗口高度忽胖忽瘦（那正是"视频窗口"与"一块会变形的黑布"的区别）。

高度上限**只能压宽度**：`max-width: calc(72vh * 16 / 9)` + `margin-inline: auto`。
如果改成给窗口加 `max-height`，比例就被破坏了（窗口比 16:9 更扁），画面两侧多出黑边 ——
"限制大小"和"保持比例"是两件事。全屏时反过来：比例交还给屏幕（`aspect-ratio: auto`、
`max-width: none`），否则全屏画面会保持 16:9、上下各留一条黑边。

#### 15.33.2 "与总览右键功能一致"：同一对弹窗组件，不是两套相似实现

右键菜单的**内容**本来就来自同一个纯函数（`buildCameraNvrMenu()`），但**能力声明**
在各自组件里，而 `visible` 决定"这一项存不存在"。改造前实时监测页只声明了两项能力，
所以它比总览**少**两项：本机录像回放、检测记录下载 —— 而界面上"少一项"与"这台设备
不支持"长得一样。

现在这两项在这一页也真的实现了，用的是总览那**同一对**组件
（`CameraRecordingPlaybackDialog` / `CameraDetectDownloadDialog`），所以"一致"不是
两套实现的相似，而是同一套实现：列表、下载、"下载完接着回放"那条闭环都不会分叉。
实测：这一页按右键弹出 **8 项**（抓图/录像、全屏、复制地址、外部播放器、叠加信息、
本机回放、下载检测记录、告警配置），比画面墙少且只少一项 —— 「清空这一格」。

#### 15.33.3 一处**刻意**的不一致：没有「清空这一格」

画面墙的"清空这一格"在这一页没有意义：这一页只有一路画面，没有格可清，停止它是页头
那颗「停止」按钮的事。`camera-nvr.ts` 的规则一是"做不到的功能不出现"，所以这里**不声明**
`tileClose` —— 声明它只会多出一项与「停止」语义重叠的菜单项。

守卫把这件事写成"差异是刻意的"：`tests/monitor-camera-menu.test.ts` 断言两处的菜单
**只差这一项**，而不是断言"完全相等"或"少几项都行"。

#### 15.33.4 手册里查不到的那半条：最多两通道

⑤ 的原文还有"最多两通道（371T 红外）"。查了手上的资料：

- `docs/reference/FA371-manual-en.txt`：**没有任何**双通道 / 双镜头 / 红外通道的说明
  （"channel" 只出现在网络拓扑与告警间隔的句子里）；
- `docs/reference/FA371-api-spec.md`：32 个开放接口里没有第二路视频源。

所以这一条**没有实现，也没有编**：按"手册未说明的一律标注手册未说明"的规矩，
它进了 `docs/UI-VERIFY.md` 的问题清单，等业主给一句话（哪两路？是可见光 + 红外两个
RTSP 地址，还是同一路码流里的两个通道？）。

#### 15.33.5 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；测试 **1535 / 0 失败**（+9：新增
`tests/monitor-camera-menu.test.ts`）；i18n **0 缺失 / 四语言键集一致**（本轮没有新键：
菜单文案是画面墙那一轮就有的）；`electron-vite build` **exit 0**；
`demo-shot --with-data` **0 problems**，新增两组 DOM 断言实测：

- 舞台 **1133×637，比例 1.778**（16:9 是 1.7778）；
- 在页面上真的派发一次 `contextmenu`：菜单**弹出**、**8 项**、含二级菜单
  （「抓图 / 录像」）、其中 3 项因"视频尚未启动"灰显并带原因文字。

> 探针的第一版在这里报过一次**假失败**：派发事件之后立刻读 DOM，而 Vue 的模板更新是
> 异步的，读到的必然是"菜单没开"。改成"先派发、200 ms 后再量"才是对的 ——
> 这类"探针自己没等渲染"的假失败，与"功能真的坏了"在报告里长得一样。

出包：`npm run dist:win:offline` →
`release\HERTZINNO Acoustic Box Manager-1.0.0-x64-setup.exe`（127,025,577 B，
sha256 `525F488CE1CFE18BD0DF084FC36428C16B6B3ACE7562A7380DC3DD3B9448F922`）；
`node scripts/verify-packaged.cjs` **25 通过 / 0 失败**。

---

### 15.34 ③b 趋势置顶 + 四张图谱卡片 + 时间轴回放（业主 2026-09-17 第二批第 7 轮）

#### 15.34.1 四张卡片是**业主确认过的**那四张，而且都用已有的真实数据

业主原文是「实时趋势挪到视频墙位置；其下四张图谱卡片 + 时间轴回放」，但**没有**说四张是哪
四张。所以先问了一句，得到的是"按你的默认做"，默认是：

| 卡片 | 数据来自 | 为什么是它 |
|---|---|---|
| 频谱 | `/freq_domain`：1024 个 bin + `binHz` | 已经有卡片，且横轴是**真实频率**（不是 bin 序号） |
| 时频图 | 设备自己推的 JPEG | 已经有卡片 |
| 声学波形 | `AudioFrameEvent.waveform`（100 ms 一帧的降采样包络） | ② 之后「播放」按钮已经在用这份数据；**加了图**而不是加了数据源 |
| 每通道声纹特性 | `channelFeatures`（② 的那张表） | 它本来就是一张"图谱卡片"，③b 只是把它并进这一排 |

**没有为了凑满四张而造数据源**：声纹图 / 能量图 / PRPD 这些名字在这一族设备的接口里
不存在（FA8 手册只给了 features / freq_domain / spectrogram / audio 四路流），
所以它们没有出现在这四张里。

版式：`.graph-grid` 是 `repeat(auto-fit, minmax(420px, 1fr))`（这一块自己的宽度决定几列，
与 §15.31 同一套理由）。420px 是"两张并排时每张放得下 ECharts 坐标轴"的下限，
也是 1366×768 那种常见窗口（内容宽 ≈1318px）能放下**两列**的下限。

#### 15.34.2 时间轴回放：几何与数据**都**是既有的纯模块

`lib/playbackTimeline.ts`（时刻↔像素、刻度、缩放/平移、命中测试、上/下一段）本来就写好了，
它的文件头引用的正是 iVMS 手册第 5 章（时间轴、滚轮缩放、上/下一事件）——只是在 ③b 之前
**没有任何界面用它**。所以这一轮没有新写几何，而是：

- 新增 `lib/recordingTimeline.ts`（**数据**层：一条录像 → 一个段、初始窗口、可拖范围），
- 新增 `MonitorRecordingTimeline.vue`：量宽度、接鼠标、把选中的那一段交给共享的
  `RecordingPlayer`。

三处"手册没说、我们自己定"的数（都写在那个文件的文件头里）：
**没有终点也没有时长的录像按 1 秒画**（0 宽度画不出来、也点不中）、
**初始窗口左右各留 2% 余量**（不留的话第一段贴着边像被裁掉）、
**一条录像都没有时窗口取"最近 1 小时"**（空窗口会让刻度与缩放全部退化）。

界面上那句「只回放本机文件（设备侧没有连续录像）」必须留着：FA8 这一族没有设备侧连续录像，
能回放的只有本机文件（手动录像 + 从设备下载的检测录像，它们登记在同一张录像表里）。

#### 15.34.3 顺手清掉的一条死样式

四张卡片取代了原来"频谱 + 时谱并排"的 `.chart-columns`，规则随之改名为 `.graph-grid`，
**旧规则删掉**。这不是洁癖：§15.29.4 记过同一条教训（删了标记没删样式，是源码守卫报出来的），
所以这一轮直接加了守卫：源码里出现 `chart-columns` 就是失败。

#### 15.34.4 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；测试 **1551 / 0 失败**（+16：新增
`tests/recording-timeline.test.ts`（11）与 `tests/page-layout.test.ts` 的 ③b 守卫（5）；
另有一条既有守卫按新名字**有意**改写并注明原因）；i18n **0 缺失 / 四语言键集一致**
（+14 个新键 × 4 语言）；`electron-vite build` **exit 0**；
`demo-shot --with-data` **0 problems**，新增的几何断言实测：

- 趋势 top **268** → 四张卡片 top **603** → 时间轴 top **1544**（顺序正确，且四张卡片各 ≥ 420px）；
- 时间轴：轨道宽度够、**12 个刻度**、**0 段录像且空态说明已画出**（这台设备本机没有录像）。

出包：`npm run dist:win:offline` →
`release\HERTZINNO Acoustic Box Manager-1.0.0-x64-setup.exe`（127,030,512 B，
sha256 `BB0CBCFD4D489C7CA81C2ED95E3E1C0B10D80BFB55F3B93BD21D693A0686BFD4`）；
`node scripts/verify-packaged.cjs` **25 通过 / 0 失败**。

#### 15.34.5 这一轮**未验证**的部分（诚实版）

1. **真的播一段**：这台设备本机 0 条录像，所以"点一段 → `RecordingPlayer` 出声"这条路径
   没有在真机上走过。单测只覆盖到数据层（录像 → 段、窗口、范围）。
2. **拖拽与滚轮的手感**：`zoomWindow` / `panWindow` 有单测，但"按住拖到边界"
   "滚轮缩放时光标下的时刻不动"这类**手感**只能人眼看。
3. **录像段颜色**：按 `recordingType` 分三种颜色（`manual` / `alarm` / `event`），
   颜色取值来自既有 token，但"哪一类用哪种颜色"是我们自己定的（手册只说不同录像类型
   以颜色区分，没有规定色板）。

---

### 15.35 ③ 系统设置拆页签（业主 2026-09-17 第三件事，一次解决五条）

业主这一条一口气点了五件事：**页签**、**太宽松**、**每张卡片都写名字**、
**设备探测并入缓冲**、**账号页签承接退出登录**。一次做完的原因很清楚：
它们改的是同一张页面的**结构**，分开做等于把同一段模板拆开重写五遍。

#### 15.35.1 七个页签 = 业主点名的那七个

语言 / 存储 / 视频与缓冲 / 告警 / 邮箱 / 账号 / 关于与维护。

三处**我们自己定的**（业主只给了名字）：
1. 页签**不持久化**，每次进设置页都落在「语言」：这是一个"进来改一项就走"的页面，
   记住上次停在哪一页反而会让下次进来看到一页与预期无关的内容；
2. 「设备探测」并进「视频与缓冲」这一页（业主 ④ 的"探测与缓冲合成一组"）——
   它们是同一条实时链路的参数：探测决定"多久问一次、几次不通算离线、一次等多久"，
   缓冲决定"告警前后各留多久、环形缓冲开多大"，而它们互相约束（缓冲必须不小于
   告警前 + 告警后，这条校验原本就写在 `validate()` 里）；
3. 「关于」那一页带上"维护"两个字，因为「恢复默认值」按 §15.21.2 的建议落在这里。

#### 15.35.2 "不要每张卡片都写名字"落成了一条**可测**的规则

页签已经写着这一页叫什么，卡片再写一遍就是重复。所以这一页里**一个
`<h3 class="section-title">` 都不许有**（有一条源码守卫钉住），一页里的分组改用
`.settings-group__title` 这种小标题（「位置与保留」「设备探测与缓冲」「当前会话」）。

**版面更紧**也是同一条要求的另一半：卡片内边距从 `--space-5` 收到 `--space-4`，
分组之间只隔 `--space-4` 加一条细线，分组内的表单网格改成三列起步
（`auto-fit minmax(180px, 1fr)`）—— 原来那些短数字（毫秒/秒/天/GB）两列会留下大块空白，
那正是"太宽松"的来源。

#### 15.35.3 账号页签承接退出登录（并且改密的实现只有一处）

「退出登录」与「修改密码」原来只在侧栏底部那个账户菜单里。现在账号页签里有：
账号管理（手册 §17.1）+ 「当前会话」（谁在登录 / 修改密码 / 退出登录）。

改密对话框抽成了 `ChangePasswordDialog.vue`，**侧栏菜单与账号页签共用同一个组件** ——
密码校验只允许有一处实现，否则迟早会出现"一个入口接受、另一个入口拒绝"的口令。

侧栏那个账户菜单**没有删**：业主 ③ 只说账号页签要承接退出登录，而"删掉最右侧那个下拉"
是另一条（⑩）至今没有确认的要求。删一个没被要求删的入口，比留着它更糟。

#### 15.35.4 顺手删掉的五个死键

`settingsUi` 里的 `languageSection` / `storageSection` / `probeSection` / `ringSection` /
`aboutSection` 在这一轮之后没有任何引用（它们的用途被页签名与分组小标题取代）。
按仓库规矩**连四语言的词条一起删掉**：留着一个没人用的键，下一轮就会有人把它加回某张卡片上。

#### 15.35.5 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；测试 **1563 / 0 失败**（+12：新增
`tests/settings-tabs.test.ts`）；i18n **缺失键 0 / 四语言键集一致 / 可直接删的孤儿 0**
（删了 5 个死键、新增 9 个键 × 4 语言）；`electron-vite build` **exit 0**；
`demo-shot --with-data` **0 problems**，新增的页签探针**逐个点了一遍**，实测：

| 页签 | 卡片 | 控件 | 数字输入 | 卡片标题（重复） |
|---|---|---|---|---|
| language | 1 | 8 | 0 | 0 |
| storage | 3 | 14 | 2 | 0 |
| video | 1 | 14 | **6** | 0 |
| alarm | 2 | 63 | 13 | 0 |
| email | 1 | 20 | 1 | 0 |
| account | 2 | 13 | 0 | 0（退出登录 / 修改密码各 1 个） |
| about | 2 | 12 | 0 | 0（恢复默认值 1 个） |

> 探针的第一版量的是 `[role=tabpanel]` 里的内容，于是「告警」「邮箱」两页被误报成
> "点下去什么都没有" —— 那两页装的是独立组件（`LinkageSettingsSection` 等），
> 它们的根元素不是 tabpanel。改成按**整页**量内容：**只数一种标记会把正常的页面误报成空的**。

出包：`npm run dist:win:offline` →
`release\HERTZINNO Acoustic Box Manager-1.0.0-x64-setup.exe`（127,032,803 B，
sha256 `70F88D4F194B7B58BB5256E5DC3D6A618D19F1CF0C8102F0833A82177425FDFB`）；
`node scripts/verify-packaged.cjs` **25 通过 / 0 失败**。

---

### 15.36 ① 听诊盒子「拉」通道的**端到端**验证（业主 2026-09-17 第 4 轮）

①的代码、单测与文档在前面几轮已经落地（§15.27 / §15.28）。这一轮补的是它缺的那一块证据：
**"从界面上把设备加进来 → 点同步 → 告警与录音真的落进本机库"这条串起来的路**。
真机不在手上，所以设备那一侧是探针进程里的一台**假听诊盒子**（`scripts/demo-shot-driver.cjs`
的 `startMockE2Device()`），协议那一侧按手册实现。

#### 15.36.1 探针到底做了什么（一次真实运行）

1. 探针进程启动假设备（随机端口），只认**加盐**口令摘要（`md5(password + 'lfxs')`），
   其余一律 401 —— 这样"先加盐、401 再换不加盐"那条路径是**真的**走了一遍；
2. 渲染层：打开「添加设备」→ 选「听诊盒子 / Air Sonar」→ 填 `127.0.0.1:<port>` + admin/口令
   → 点「测试连接」（实测往返 52 ms、设备名/`equip_number` 都读回来了）→ 点「添加设备」；
3. 进设备详情 → 「听诊盒子」页签 → 点「同步告警」；
4. 断言（两层，缺一不可）：

| 层 | 断言 | 实测 |
|---|---|---|
| 假设备侧（应用**发出了什么**） | 登录先用加盐摘要；之后每个请求带 `Bearer`；日志走 `/alarm_log_all`；下载走 `/alarm_files` 且 `file_path` 含 `saving_path` | `loginStyles` 首个为 `salted`；12 个带 token 的请求；`filePaths: ["alarm/2026-09-17/alarm.wav"]` |
| 应用侧（**落下去了什么**） | 设备身份是设备自己报的 `equip_number`；库里 1 条告警、1 份录音；录音采样率来自**真 WAV 表头**；文件比 44 字节的头长；界面上能看到这台设备 | `deviceUid: e2:PROBE-E2-0001`；`alarms: 1`、`recordings: 1`；`sampleRate: 48000`、`fileSize: 192044`；`addedDeviceVisible: true` |

探针还会把**存储根目录**改成一次性 profile 里的目录再同步：`--with-data` 用的是操作员真库的
副本，但 `storageRoot` 指向他真实的存储目录 —— 不换掉就会往他的目录里写一份探针录音。

#### 15.36.2 这条探针**能证明**什么、**不能**证明什么

- 能证明：应用真的按手册发出了那些请求（摘要、token 头、路径、`file_path` 口径），
  并且把结果落进了本机库与磁盘（字节数与 WAV 表头都对）。
- **不能**证明：与**真机**的互操作性。一台按我们的理解写出来的假设备无法证伪我们的理解 ——
  真机可能不回 `equip_number`、可能只认不加盐的摘要、可能把 `saving_path` 拼得不一样。
  这一条列在 `docs/UI-VERIFY.md` 的「真机验证」清单里，**不要**把它读成"真机验过了"。

#### 15.36.3 这一轮修掉的一个缺陷（探针抓到的）

设备管理页原来**不自己读设备表**：它完全依赖外壳（`AppShell`）在启动时读的那一次，
而其他列表页（监测/录像/告警/趋势/样本/事件中心/设备详情）都写了
`if (devices.devices.length === 0) await devices.load()`。这一页恰恰最不该把"还没读到"
显示成"没有设备"（`DeviceTree` 对空列表只画一句"没有设备"）。现在它也有这一句，
并且由 `tests/e2-probe.test.ts` 钉住。

#### 15.36.4 **定位并修掉**了一个会截断设备列表的缺陷

第 4 轮里留下了一处"未查清"的观察：加完设备之后，实时监测页的设备下拉里只有这一台，
而同一时刻 IPC 报库里有 3 台。第 5 轮把它查清了，而且它是个**真缺陷**，不是探针的假象。

**成因链**（三处代码各自都对，合起来错）：

1. 主进程的 `DEVICE_REFRESH_STATUS`（`handlers.ts`）：**带 `id` 时只回那一台**
   （`return [services.devices.get(id)]`），不带 `id` 才回整份设备表；
2. `stores/devices.ts` 的 `refreshStatus(id)` 原来一律 `devices.value = list` ——
   把"一台"当成"整份"，于是**全应用的设备列表被替换成这一台**；
3. `DeviceDetailView` **在挂载时**就调 `refreshStatus(props.id)`（`onMounted → refresh()`），
   所以"打开任意一台设备的详情页"就会触发。

**操作员看到的现象**：进过一次设备详情页之后，顶栏的"设备总数"变小、实时监测页的设备下拉里
只剩一台、设备树上少了几台 —— 而库里一台都没少。因为它是"界面少了几台"而不是报错，
以前既不会被日志抓到，也不会被单测抓到。

**证据**（同一次探针运行，修复前后）：

| 读数 | 修复前 | 修复后 |
|---|---|---|
| 渲染层 store 里的设备数（进详情页之前） | 1 | **2** |
| 同一时刻 IPC 报的台数 | 2 | 2 |
| 加完设备之后 store / IPC | 2 / 3 | **3 / 3** |
| 同步完（已在详情页里走了一遍）之后的 store / IPC | 1 / 3 | **3 / 3** |
| 实时监测页下拉里的 option | `["探针听诊盒子（127.0.0.1）"]` | `["AE08（…）","Acoustic Camera …","探针听诊盒子（…）"]` |

**修复**：`refreshStatus()` 现在区分两种调用 —— 不带 `id` 整份替换，带 `id` 按 id **合并**。
守卫在 `tests/device-list-truncation.test.ts`（同时钉住主进程的两种返回、store 的合并语义、
以及"详情页挂载时确实会调它"这三件事），探针那边也留了一条断言
（"界面上的设备数不许少于库里的"，含顶栏那个第二读数）。

> 这件事值得记下来的地方：**业主的原始投诉**是"设置页太宽松"那一批里的措辞，
> 而这处缺陷是**端到端探针**顺手撞出来的 —— 单测、类型检查、逐页截图全绿，
> 只有"把整条链走一遍"才会看到"库里有、界面上没有"。

#### 15.36.5 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；测试 **1574 / 0 失败**（+11：新增
`tests/e2-probe.test.ts`（7）与 `tests/device-list-truncation.test.ts`（4）：假设备的端点
覆盖清单、加盐摘要、Bearer 校验、真 WAV/JPEG 字节、"写操作的探针必须排在只读探针之后"、
设备管理页自读，以及 §15.36.4 那个缺陷的三处守卫）；
i18n **缺失键 0 / 四语言键集一致 / 可直接删的孤儿 0**；`electron-vite build` **exit 0**；
`demo-shot --with-data` **0 problems**（含上面两张表里的实测值）。

出包：`npm run dist:win:offline` →
`release\HERTZINNO Acoustic Box Manager-1.0.0-x64-setup.exe`（127,032,708 B，
sha256 `B6FF3BD3339E9B0CF22BB358D8BE511EC9BA6407F38C7D51CA1AD9046DFEF375`）；
`node scripts/verify-packaged.cjs` **25 通过 / 0 失败**。

---

### 15.37 SN-16 空气声呐：产品身份澄清 + 真机验证工具（业主 2026-09-17 第 6 轮）

#### 15.37.1 业主澄清了什么

第三份 API 资料（`Air Sonar User Manual 241128.pdf`）对应的是他们的一款 **SN-16 空气声呐**，
用途是**声源定位**（不是"再一款听诊盒子"）。手册示例里的型号串写的是 `AS16`，产品名是 SN-16。

按这个澄清改了三处（**内部变体键不动**）：

| 改什么 | 之前 | 现在 |
|---|---|---|
| 型号串 → 通道数 | 只认 `AS16` | **`AS16` / `SN-16` / `SN16` 都认**（`e2ChannelCountFromModel()`） |
| 界面上的代次名 | `Air Sonar（V3.2 协议）` | **`SN-16 空气声呐（V3.2 协议）`**（四语言） |
| 添加设备里的机型项 | `听诊盒子 / Air Sonar` | **`听诊盒子 / SN-16 空气声呐`**（四语言） |

变体键仍然是 `airSonar`：它出现在 IPC 形状与落库数据（`variant`）里，为了让名字更好听去改键，
只会让旧数据与旧日志对不上 —— **键不是给人看的，标签才是**。

#### 15.37.2 真机验证工具：`scripts/e2-live-proof.cjs`（新）

离线测试与端到端探针用的都是**假设备**，只能证明"我们按手册发了什么"。这一轮补上了对着
**真设备**跑的那一条：

```
node scripts/e2-live-proof.cjs --ip 192.168.110.50 --password 123456
# 可选：--port 80 --username admin --limit 5 --spectrograms
```

它跑**真实构建的应用**，用界面用的那几个 IPC 走完整条链并把每一步的原话打出来：
`devices.probe`（顺带验了口令摘要）→ `devices.add` → `e2.status`（判代次 + 参数 + 设备信息 +
通道数）→ `e2.syncAlarms` → 读回本机库（告警与录音）。报告同时落到
`.e2-live-proof/e2-live-proof.json`。

三件"不碰操作员东西"的设计（都是**实测发现有必要**才加的）：
1. **一次性 profile**（`--user-data-dir=<temp>`）：不动他的设备表、设置与库；
2. **凭据只从命令行来**：不读他 profile 里的 safeStorage 密文（两处进程之间传的是自己的口令）；
3. **存储根目录保险**：一次性 profile 里 `storageRoot` 的默认值居然是 **`D:\HertzinnoData`**
   —— **操作员真实的存储目录**。所以脚本先把存储根目录换进临时目录再同步，并在报告里
   断言"它确实在 profile 里"（第一次跑没有这道保险时，验证用的 WAV 会被写进他的库）。

#### 15.37.3 这条工具**立刻抓到两个真缺陷**（都是假设备挡住的那一类）

**缺陷一：SN-16 根本加不进来。** 探活（`probeAuscultation`）登录之后**直接**读设备信息，
而设备信息端点按代次不同（2023 版 `/basic`、SN-16 `/get_device_basic_params`）。
对一台真实的 SN-16，它会去打 `/basic` → 404 → 探活失败 → 添加设备失败。
而**登录明明是成功的**，所以现象看起来像口令或权限问题。

- 修：`await client.ensureVariant()`（读两代都有的 `/system`）**再**读设备信息。
- 回归测试：`tests/e2-device.test.ts` 的"SN-16 空气声呐（只有 `/get_device_basic_params`）
  加得进来，而且先判代次再读设备信息"。
- **这条测试确实抓得住**：把修复临时回退之后它失败（12 通过 / 1 失败），恢复后 13/13。
- 根因是"假设备比真机宽松"：原来的假设备对 `/basic` 与 `/get_device_basic_params` **都答**，
  所以这条路径永远走不到 404。现在假设备可以指定"只答哪一代"（`basicPath`）。

**缺陷二：同一条事实两个答案。** 添加对话框里 SN-16 显示"通道数 1"（探活返回的是这一族的
产品默认值），而同一条设备的详情页显示 16（`E2DeviceService.status()` 是按型号串算的）。

- 修：探活与 `auscultationInfo()` 都改成"型号串能说就说，说不出来才是这一族的产品事实（1）"。
- 实测（对着 SN-16 的假设备）：`probe.info.channelCount = 16`，`status.channelCount = 16`。

#### 15.37.4 **真机验证做完了**（业主 2026-09-17 给了 IP 与口令）

设备：**192.168.110.234**，`admin` / 口令来自业主；`dev_type = AS16-auth-vertical-reverse`，
`dev_version = V3.4.0.2024-11-27`，`web_version = WEBV2.3.0`，`equip_number = C864C0DF…4D0A804C4`，
采样率 20000，告警记录 **1001** 条。

**这台真机的接口路径与手册完全不同** —— 这是本轮最重要的一条发现。设备自己的前端
（`/assets/js/syslog.js`、登录页内联脚本）才是这一版固件的权威文档：

| 用途 | 手册（V3.2） | **真机 V3.4.0** | 证据 |
|---|---|---|---|
| 登录 | `POST /login`，`md5(password + 'lfxs')` | **一致** ✓ | 登录页内联脚本 `var pwd = password + "lfxs"; hex_md5(pwd)` |
| 全部告警 | `GET /get_all_alarms` | **`GET /alarm_log_all`**（404 vs 200） | 直接请求 + `syslog.js` |
| 条件查询 | `GET /get_alarm_logs_conditional` | **`GET /alarm_log`** | 同上 |
| 设备信息 | `GET /get_device_basic_params` | **`GET /basic`** | 同上 |
| 录音 | `GET /saving_alarm_file?file_path=` | **`GET /static_file/<saving_path>alarm.wav`**（静态文件，不是 API） | `syslog.js`：`$("#logAudio")[0].src = url_pass + "static_file/" + resinfo.saving_path + "alarm.wav"` |
| 抓图 | 同上下载 | **`GET /static_file/<saving_path>{n}.jpg`**，`n = 1..3` | `syslog.js`：`for (let i = 1; i <= 3; i++)` |
| 心跳 / 重启 | `PUT /hb_settings`、`PUT /reboot` | 未验证 | — |

**参数与字段仍然是第二代那一套**（`cam_enable`/`cur_realtime_channel`/`is_save_snapshot`/
`is_send_realtime_value`、`horizontal`/`vertical`、无 `alarm_value`/`alarm_reasons`/`audio_name`）
—— 所以"两代"的差别**不在端点路径上**，而在字段上。我们原来把两者绑在一起，于是这台设备
的每一个 `/get_*` 路径都 404。

**改法：设备回话说了算。** `E2Client` 现在为四个用途各记一份"已确认的路径"，按
"已确认的 → 手册那条 → 另一代那条 →（下载还有第三条：静态文件）"依次试，**只有 404 才换下一条**
（400/401 不换，否则会把参数错与认证问题一起掩盖），成功之后记住**路径**（不是带查询串的 URL）。

##### 真机验证一次跑出来的三个缺陷（都已修 + 有单测）

1. **SN-16 加不进来**：探活直接读设备信息，而端点是按代次取的 → `/get_device_basic_params` 404。
   修法是先 `ensureVariant()` 再读；回归测试见 `tests/e2-device.test.ts`。
2. **空名字丢身份**：这台设备 `dev_name` 是空串，而第一版把整个 `info` 挂在 `name` 上 ——
   于是身份退回按地址编的 `e2ip:…`，尽管设备给了 `equip_number`。修后
   `deviceUid = e2:C864C0DF…`（真机实测），换 IP 也仍是同一台。
3. **"文件没了"被报成"下载失败"**：`files_status=1` 但三条下载路径全 404 时，原来记进
   `audioFailed`。那会让人以为是我们的下载坏了；实际是保留策略的预期结果。现在记进
   `filesMissing`（界面本来就有那句话）。

##### 一个**在真机数据上**发现的"文件都没了"的事实

1001 条告警里只有 **6 条** `files_status = 1`，而**这 6 条的 `alarm.wav` 与 `1.jpg` 也全是
404** —— 设备自己的网页播放器同样取不到。所以这一步的诚实结论是：**这台设备上现在没有
可下载的媒体文件**，本机只登记了告警行与"待认领"的录音行（`relative_path` 为空，
与 FA8 同步同一条语义）。探针也据此分两种情况断言：下了文件就必须是真 WAV；没下就必须说清为什么。

##### 真机验证的最终结果（`node scripts/e2-live-proof.cjs --ip 192.168.110.234 --password …`）

**0 problems**：探活 ✓（156 ms、身份 `e2:C864…`、16 通道、固件 V3.4.0）→ 添加 ✓ →
状态 ✓（`variant: airSonar`、16 通道、参数原样）→ 同步 ✓（**5 条真告警落库**、
`filesMissing: 5`、`audioFailed: 0`）→ 读回 ✓（告警带着设备的 `horizontal`/`vertical`）。

##### 还没做的一处（记录）

设备没有名字（`dev_name` 为空），所以添加之后的设备名是兜底名
`Auscultation Box 192.168.110.234`。用型号串（`AS16-auth-vertical-reverse`）给它起一个更
有用的默认名是可行的，但"默认名从哪来"是一条产品决定 —— 留给业主一句话。

#### 15.37.5 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；测试 **1577 / 0 失败**（新增：SN-16 探活先判代次的
回归、型号串带后缀、端点 404 回退与"记住路径而不是整条 URL"、设备信息/日志/下载四条回退）；
i18n **缺失键 0 / 四语言键集一致 / 可直接删的孤儿 0**；`electron-vite build` **exit 0**；
`demo-shot --with-data` **0 problems**（GUI 探针基线未变）；
**`e2-live-proof` 对着真机 192.168.110.234 = 0 problems**（见 §15.37.4 的结果）。

> 端点回退那一版**写完当天就被单测抓住一个自造缺陷**：第一版把"成功的那条 URL"整个记住，
> 于是下一条文件会拿着上一条的 `?file_path=…1.jpg` 去下载，设备老实回了 200 和**第一张图的
> 字节** —— 结果是"每一张都下载成功、内容全是第一张"。路径是端点的属性、`file_path` 是文件的
> 属性，两者不能一起记。这条教训写在 `fileCandidates()` 的注释里。

出包：`npm run dist:win:offline` →
`release\HERTZINNO Acoustic Box Manager-1.0.0-x64-setup.exe`（127,034,420 B，
sha256 `35AC5C2A72669345F29E349072F7615DBDC69C69F4CAE98BB056F3E4BFCAA0B5`）；
`node scripts/verify-packaged.cjs` **25 通过 / 0 失败**。

---

### 15.38 设备管理表格 / 机型自动识别 / 点位信息 / 三种实时检测（业主 2026-09-17 第 7 批）

六条要求一次做完。逐条记**做了什么、判据在哪、以及我们自己的设计决定是什么**
（手册里没有的东西一律标明出处，见下面 15.38.1）。

| # | 要求 | 落点 |
|---|---|---|
| ① | 空气声呐（SN-16）添加设备时能录入 GIS 点位 + 方位角 + 分贝 | `devices` 表 v11 四列 + 添加对话框 + 编辑对话框 + 两张只读卡片 |
| ② | 添加设备不再让人选机型，改为自动匹配协议 | `DeviceService.probe()` 按 `AUTO_PROBE_ORDER` 依次探活；界面只显示识别结果 |
| ③ | 设备管理页右侧改成一行行设备的表格（八列，查看/配置用图标） | `DevicesView` 的 `table.devices-table` + 全局 `.table-wrap` / `.table` |
| ④ | 双击设备 IP 打开设备 Web 界面 | IP 那一格的按钮：`dblclick`（+ 键盘 Enter/空格）→ `shell.openExternal` |
| ⑤ | 点「查看」按机型进三种实时检测界面 | `MonitorView` 的三个 `computed` 判据与三支模板 |
| ⑥ | 实时检测页设备下拉宽度 = 现在的一半、移到右侧、紧挨「设备数量」 | `.topbar-device`（顶栏那一格的 50%，靠右） |

#### 15.38.1 ① 安装信息：**这是我们自己的数据模型**

设备**不提供**位置。手册（`Air Sonar User Manual 241128.pdf`）给的是参数与告警，
`/system` 里没有经纬度、没有朝向、也没有"点位基准声压级"。所以这三项是**我们加的**，
口径必须写清楚，否则操作员会填错口径（错的口径比没填更糟）：

| 字段 | 口径 | 出处 |
|---|---|---|
| `gisLatitude` / `gisLongitude` | **WGS84 十进制度**（不是度分秒、不是投影坐标） | 我们定的（GIS 工具之间最通用的交换形式） |
| `azimuthDeg` | **罗盘方位角**，0 = 正北、顺时针，范围 `[0, 360)`（**360 被判越界，写 0**） | 我们定的；与设备报的 `horizontal`（声源方位）**同向**，两者才能直接比较 |
| `soundLevelDb` | 该点位的**基准声压级**（dB），用来与设备报的 `db_value` 对照，**不是告警门限** | 我们定的；门限在设备端 `db_limit` 里 |

四条实现上的规矩：

1. **空值不是 0**。`''` / `null` / `undefined` 一律表示"没有填"；四项全空时设备行上
   **没有 `installation`**（不是"四个字段都是 undefined 的对象"）。理由：纬度 `0` 是几内亚湾上
   一个真实坐标，"没录过"与"录了 0"必须能分开。列也**不带 `NOT NULL`**，老行是 `NULL`。
2. **经纬度成对才算一个点位**。只录一半时界面写「只录了一半（经纬度要成对）」，
   而不是显示一个只有一半坐标的点 —— 声源定位拿半个坐标算出来的方向是错的。
3. **一套判据、四处用**。范围与解析只有 `shared/domain/device-installation.ts` 一处
   （界面即时反馈 + 主进程落库前的最后一道闸）。CLI 探针里写的范围是另一套，没用。
4. **录入两处、只读两处**：添加设备对话框（第 1 条原文）、设备管理页的「编辑」对话框
   （否则打错一个数字只剩"删掉重加"这条路，这是我们自己加的）；
   只读视图是同一个组件 `DeviceInstallationCard.vue`，挂在设备详情页「概览」页签与
   实时检测页的声呐那一支 —— 两页不可能显示成两个样子。

落库：`schema v11`，`ALTER TABLE devices ADD COLUMN gis_latitude REAL / gis_longitude REAL /
azimuth_deg REAL / sound_level_db REAL`（**不加 CHECK**：范围判据在应用层一处，
写死进 SQL 就会出现两处判据不一致；而 SQLite 改 CHECK 需要重建父表，代价见 v10 那条迁移的教训）。
部分更新的语义：字段**缺席** = 不动这一列，`null` = 清空这一列。

#### 15.38.2 ② 机型自动识别：不是"猜"，是按顺序探活

`DeviceService.probe()` 在没有 `kind` 时按 `AUTO_PROBE_ORDER` 依次试：
**声纹设备 → 听诊盒子族 → 声学相机**，第一个成功的家系即为结果（`matchesFamily()`：
相机看 `reachable === true`，另外两族看 `info !== undefined`）。

为什么这个顺序：三族的探活代价不同（FA8 一次 `/get_devinfo`；E2 先 `/system` 判变体再读设备信息；
相机要读设备信息与 RTSP 参数）。把最便宜、最常见的放前面。

界面**不让人选**，但必须把识别结果**说出来**（添加对话框里 `[data-probe-kind]` 那一行）：
选错家系的症状是"设备没响应"，而那正是**网络故障的样子** —— 操作员会去查网线。
自动识别把这道判断题从用户手里拿走，代价是**我们必须把答案说出来**。

#### 15.38.3 ③ 设备表：一列一个事实（八列，顺序按业主给的清单）

`设备名称 / 设备IP / 设备类型 / 是否在线 / 告警数量 / 设备通道 / 查看 / 配置`。
外观全部来自全应用共有的 `.table-wrap` + `.table`（告警 / 事件中心 / 录音 / 样本库同一套），
这一页只加了四件：数字列右对齐、图标列收宽、IP 那一格看起来像文字、选中行加底色。

**一个我们自己定的界面决定**：这一页的**行点击 = 选中**（高亮 + 把 store 的当前设备切过去），
**不再跳转**。上一版行点击是 `selectDevice()` → 直接去 `/monitor`；而第 4 条要的是
「**双击** IP 打开设备 Web 界面」—— 双击的前半段一定是两次单击，单击要是会导航，
第一次单击就已经离开这一页了，**双击永远落不到那一格上**。要跳转就用右边那两列：
「查看」去实时检测、「配置」去设备详情。拓扑树上的点击语义没变（那是"看这台设备的画面"）。

改名 / 删除仍然是 ADMIN 的动作，收在「配置」之后的省略号菜单里（业主的列清单里没有它们，
但删掉就等于把功能删了）。

「告警数量」那一列：每台设备读一次 `alarms.query({ deviceId, limit: 1 })` 的 `total`
（设备数是个位数，不值得为它加一条 IPC 通道）。读不到时显示「—」：**0 与"没读到"必须能分开**。
「设备通道」那一列同理，通道表到手之前是「—」而不是猜一个数。

#### 15.38.4 ④ 双击 IP 打开设备 Web 界面

链路：`dblclick` → store `openWebUi(id)` → IPC `DEVICE_OPEN_WEB_UI` → 主进程按设备地址拼
`http://<ip>:<port>` → `shell.openExternal`（**系统浏览器**，不是 iframe、不是第二个窗口：
设备凭据必须留在我们不控制的那种上下文里，规范 §8.5 明确"不使用 iframe"）。

三件必须成立的小事：**单击什么都不做**（只阻止冒泡，见 15.38.3 的理由）；
**键盘也能到**（Enter / 空格 —— 纯键盘与读屏用户不会少一条路）；
地址栏位与端口一起给出（`:80` 时也按设备真实端口拼）。探针把 `shell.openExternal` 换成
记录用的替身，量"单击不加一条、双击正好加一条、且那一条是这一行的地址"。

#### 15.38.5 ⑤ 三种机型，三种实时检测内容

「查看」带上设备 id 去 `/monitor`，由**那一页自己**按 `kind` 分支（判据只有一处：
`isVoiceprint` / `isSonar` / `isCamera` 三个 `computed`）。

| 机型 | 这一屏是什么 | 数据来源 |
|---|---|---|
| 声纹设备（AE08 / FA8） | 通道页签 + 实时趋势 + 四张图谱 + 每通道声纹特性 + 音频条 | 主进程四条 WebSocket（`monitor` store） |
| 声学相机（FA371） | 单路 16:9 直播 + 五张声学图 + 检测启停 + 告警入口 | 主进程回环 HTTP + 相机 REST |
| **SN-16 空气声呐 / 听诊盒子** | **参数与告警同步**（`AuscultationPanel`）+ **安装点位卡片** + **本机录音时间轴** | 设备的「拉」通道（HTTP），**没有实时流** |

第三支是这一批新增的：在那之前一台听诊盒子/声呐落到的是声纹那一支，而那一支会去开
`/features_stream` —— 这台设备上没有那个端点，于是**一台健康的设备被显示成"实时监测起不来"**。
这与相机那一支当初的错误是同一个：不能把不属于这一族的协议指向这台设备。

**声呐这一屏现在没有实时图，这是有意的**：这一族的实时音频/时频流是 WebSocket
（手册给了 `/audio_stream`、`/stft_stream`，SN-16 另有 `/all_chns_stream`），我们**还没有接入**，
也没有在真机上验过帧格式。界面上那句 `monitorUi.sonarLiveUnwired` 就是这件事的说明。
宁可这一屏少一块，也不画一张没有数据来源的实时图。

顺手修掉一处**同一条事实两个答案**：听诊盒子族的本地通道行数原来恒等于 1
（`AUSCULTATION_CHANNEL_COUNT`），于是 16 通道的 SN-16 在设备表的「设备通道」列显示 **1**、
而同一台设备的详情页显示 **16**。现在通道行数跟着设备回话里的 `dev_type` 走
（`e2ChannelCountFromModel()`，算不出来才是 1）。
⚠️ 通道行里的 `enabled` 仍然是**本机默认值**（这一族没有任何按通道开关的接口），
所以「已启用 16/16」只说明本机认为它开着 —— 那不是设备事实。

另外两处按机型收口：**采样率**（`/get_sample_rate`）只对声纹设备读（相机与声呐没这个端点，
读了会得到一次必然失败的请求，而主进程会把失败记到设备状态上，好设备就此显示成"离线"）；
切到声呐时会把上一台的会话、预览声音与录像**收干净**，免得操作员以为屏幕上那块正在播的是眼前这台。

#### 15.38.6 ⑥ 顶栏的设备下拉：顶栏那一格的 50%、靠右、紧挨设备数量

下拉仍然由 `MonitorView` 用 `<Teleport to="#topbar-page-slot">` 投进顶栏那一格
（那一格是顶栏的 50%）。这一批把下拉**自身**的宽度收到那一格的 50%（= 顶栏的 25%），
`margin-left: auto` 推到这一格右端 —— 于是它右边紧挨着的就是 `.indicators` 里第一个
指示器（设备总数）。顶栏的 DOM 顺序没有改，探针量的三个数：
`selectRatio`（40–60%）、`selectRightGapToSlot`（≤2px）、`selectToIndicatorsGap`（0–24px，
就是顶栏那 16px 的间距）。

#### 15.38.7 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；测试 **1620 / 0 失败**（这一批新增 43 条：
安装信息解析/落库/读回/v11 迁移 16 条 + 界面与目录守卫 25 条 + 机型自动识别 2 条
（不带 `kind` 探活认得出这一族、以及"声纹那一家先试"的请求顺序））；
i18n **缺失键 0 / 四语言键集一致 / 可直接删的孤儿 0**；`electron-vite build` **exit 0**；
`demo-shot --with-data` **0 problems**（本批新增五组断言，实测数字见下面那张表）；
**`e2-live-proof` 对着真机 SN-16（192.168.110.234）= 0 problems**，而且是**不带 `kind`**
（= 真的走了自动识别那条路）跑出来的：探活 108 ms、`kind: auscultationBox`、16 通道、
安装信息写进去读回来逐项相等、5 条真告警落库、`filesMissing: 5`。

GUI 探针量到的本批关键数字（窗口 1440×900，`--with-data`）：

| 读数 | 实测 |
|---|---|
| 设备表表头 | `设备名称 / 设备IP / 设备类型 / 是否在线 / 告警数量 / 设备通道 / 查看 / 配置` |
| 每行的「查看」「配置」图标 | 3 行 / 3 个 / 3 个，且每个都有 `<svg>`；IP 是可双击的按钮（3 个） |
| 点「查看」 | `#/monitor?device=dev_…`，且顶栏下拉正好选中这一台 |
| 点「配置」 | `#/devices/dev_…` |
| 单击 IP | 停在 `#/devices`（不跳走），`shell.openExternal` **一条都没加** |
| 双击 IP | `openExternal(http://192.168.110.90)` **正好一条** |
| 添加对话框 | 机型控件 **0** 个；安装信息四个框；识别结果那行写「已识别为：听诊盒子 / SN-16 空气声呐」 |
| 顶栏下拉 | 宽 **294px** = 那一格（48% 顶栏）的 **50%**；右缝 **0px**；到指示器 **16px** |
| 声呐那一支 | 实时流说明 1 处 + 同步面板 1 + 安装点位卡片 1（点位 `31.2304, 121.4737`）；通道页签/趋势/音频条 **0** |
| 假设备端到端 | 探活 ✓ → 加设备 ✓ → 安装信息读回 ✓ → 同步：`alarms 1` / `recordings 1`（WAV 48000、192044 字节） |

出包：`npm run dist:win:offline` →
`release\HERTZINNO Acoustic Box Manager-1.0.0-x64-setup.exe`（**127,043,036 B**，
sha256 `D177E377D4F85D5765D032B6FF3F02DC89C0455C0EA7D2DFD38BF753B607856B`）；
`node scripts/verify-packaged.cjs` **25 通过 / 0 失败**（未签名 → 首次运行会有 SmartScreen 提示）。

#### 15.38.8 还没验证的（不要按已验证验收）

1. **声呐的实时流**：手册给的三条 WebSocket 路径我们一条都没有实现，也没在真机上试过
   —— 这一屏的"参数 + 告警同步 + 本机录音"是它的全部内容。
2. **真机上的点位录入**：`e2-live-proof` 目前只验证到探活/添加/状态/同步/读回告警行；
   "在界面上录入点位再从库里读回来"这一条在**假设备**（GUI 探针）上是通的，
   真机上尚未跑过（真机那台 SN-16 也没被登记进操作员的库）。
3. **双击 IP 打开的系统浏览器**：探针把 `shell.openExternal` 换成了替身（自动化验证不该
   真的弹浏览器），所以"URL 拼对了、链路通了"是证明过的，**浏览器里那一页长什么样**没看过。
4. **表格在设备很多时的表现**（比如 30 台）：这一批只有 2–3 台设备的现场，
   行高、表头吸顶与横向滚动都没在多设备下量过。

---

### 15.39 空气声呐的球机联动（PTZ）+ 离线点位图与告警抓图（业主 2026-09-17 第 8 批）

业主两条要求，一条是对**已有页面**的收窄，一条是**新页面**：

> ①「空气声呐设备是和球机联动的，所以应该只支持一个 PTZ 的配置功能」
> ②「支持在地图点击这个声呐告警设备可以看到视频的截图」

开工前问了三件事，业主当场定下（这三条决定了整个实现方向）：

| 问题 | 业主的选择 |
|---|---|
| 底图从哪来（渲染层不联网、仓库里也没有地图库） | **用我们自己的离线点位图** |
| 「只支持一个 PTZ」的范围 | **配置页只留一个「PTZ 联动」页签**（身份与安装点位作为该页顶部只读信息；听诊盒子那套参数/告警同步、以及维护都不再给这一族） |
| 真机上要不要写一次 PTZ 参数 | **可以：把当前值原样写回再读回** |

#### 15.39.1 ① PTZ 配置：键来自手册，写法是我们定的

那一组参数的**键名全部来自手册**（`Air Sonar User Manual 241128.pdf` 的 `/system` 参数表）：

| 手册键 | 界面上的意思 | 可写 |
|---|---|---|
| `cam_enable` | 启用球机联动 | ✅ |
| `cam_ip` / `cam_port` / `cam_user` / `cam_pass` | 球机地址 / 端口 / 账号 / 口令 | ✅（口令**只写不读**） |
| `is_ptz_direction_same_with_sonar` | 球机方向与声呐一致 | ✅ |
| `is_save_snapshot` | 告警时保存抓图 | ✅ |
| `cur_realtime_channel` | 实时监听通道（1..通道数） | ✅ |
| `is_cam_init` | 球机是否已初始化 | ❌ **只读状态** |

三条**我们自己的**做法（手册没说，所以写在代码与这里，不散在界面文案里）：

1. **写 = 整份回写（read-modify-write）**。手册的写示例就是把整个参数对象发回去，
   所以 `applyPtzPatch()` 拿"设备刚回的整份 `/system`"做底、只改要改的那几个键，
   `db_limit` / `notify_url` / `samplerate` 原样带着走。**没改口令时写回的是设备刚给的原值**
   —— 写空会把球机口令清掉。
2. **写完必须读回核对**（业主的硬规矩）。`updatePtzConfig()` 的顺序是
   读 → 改 → `PUT /system` → **再读** → `comparePtzPatch()` 逐项比；
   界面显示的"哪一项生效 / 哪一项没有（应为…设备现为…）"就是这份核对结果，
   **不拿"请求发出去了"当成功**。归一化之后才比较：设备把 `true` 回成 `1`、
   把端口回成字符串都算一致。
3. **口令永不出主进程**：`/system` 会明文回 `cam_pass`（真机实测 `AP1_lfxs_2025`），
   但视图里只有 `cameraPasswordSet: boolean`，界面只显示「已设置 / 未设置」。
   写了新口令之后界面明说"内容未比对"（只能由球机能否取到流来证明）。

**与球机对时**（`PUT /time_sync_with_nvt`）：手册**只列了这个端点，没有写请求体**，
所以我们发一个空对象，界面照实写「设备接受了这次请求（手册未说明请求体）」——
不假装知道它做了什么。真机上**没有**点过它（只有假设备探针覆盖）。

页签按**设备自己说的代次**给（v12 把代次记进 `devices.e2_variant`）：`airSonar` ⇒ 只有
`ptz` 一个页签；2023 版听诊盒子仍然是「概览 / 听诊盒子 / 设备维护」。代次在**添加设备时**
就落库（探活本来就要读一次 `/system` 判代次，顺手记下），所以刚加进来的 SN-16 不会先
显示成 2023 版那一组。

#### 15.39.2 ② 离线点位图：坐标是我们自己投影的

**没有底图服务，也不可能有**：渲染层按设计不联网（CSP `connect-src 'none'`、
`img-src 'self' data:`），在线地图（高德/百度/OSM）全都要从公网取瓦片。
业主选了"我们自己画"，于是这张图是**等距圆柱投影的平面图**：

```
x ∝ (lon − lon0) · cos(lat0)          y ∝ −(lat − lat0)
```

`cos(lat0)` 是必须的：北纬 31° 上 1° 经度的地面距离只有 1° 纬度的 ~0.857 倍，不乘它
东西向会被拉长 17%，两台设备的相对方位就看不出来了。x/y 用**同一个** px/度（经度折过），
所以图上的夹角等于现场的夹角 —— 这条有单测（正方形的地面范围必须画成正方形）。

三件我们自己定的口径：

1. 边界由**录了点位的设备**决定，四周留 28px；只有一个点时用 `MIN_SPAN_DEG`（0.0005°≈55 米）
   撑开视野并放在正中（不除零、不飞出画布）。
2. **没有完整点位的设备不画在图上**，而是单独列出来（点名字进那一台去补录）——
   半坐标的点位没有位置可画，堆在角落比不画更糟。
3. 网格步长按视野取「好看的步长」（1/2/5×10ⁿ，最多 6 条），网格线与设备落点用
   **同一个投影器**（`mapProjector`）：抄第二份算式迟早会错位。

**抓图**（业主要的"点声呐看截图"）：SN-16 每次告警带 3 张球机抓图（手册：1 秒一张），
2023 版带 10 张时频谱图。这一批把三件事接上了：

- **落库**：`alarms.snapshot_dir`（v12）记下本机存图的那个目录（存储根相对）。
  在此之前图**下载了但路径没有落进任何一列**，界面永远找不到 —— 这是"文件在磁盘上、
  软件里没有"的典型。
- **同步时下载**：点位图上的「同步告警」会带 `downloadSpectrograms: true`
  （一条告警最多 3 次请求；这也是这一页存在的理由）。
- **给界面**：图片字节不过 IPC —— 主进程用**与手动录像回放同一个**回环 HTTP 服务
  （`VideoFileServer.serveImages`）开端点，路径里带每会话令牌，CSP 为此放行了
  `img-src http://127.0.0.1:*`（与 `media-src` 同一条安全推理：只绑回环、只放行图片加载、
  `connect-src` 仍然是 `none`）。

三种状态**分开说**（这是这一块最容易骗人的地方）：有图 / `not-captured`（设备上本来就没有：
没开"告警时保存抓图"、球机没配对、或同步时没下）/ `files-gone`（库里记着、磁盘上的文件
已经不在了 —— 换过存储目录或被清理）。合成一句"没有图"会让操作员去查同步。

#### 15.39.3 顺手补上的两处

- `devices.e2_variant`（v12）：听诊盒子族的代次原来只活在"这一次读到的客户端对象"里，
  刷新页面/重启软件就又要问一次设备 —— 而它决定界面给不给 PTZ 页签。写入之后**读回核对**
  （不一致只在日志里报：代次记错只影响页签，不该让一次只读的"读状态"失败）。
- `e2:alarm-snapshots` 归 `viewAlarms`（那是**告警的附件**），PTZ 三条归 `configureDevices`
  （那是**设备配置**）—— 权限目录 `PERMISSION_OPERATIONS` 里逐条登记，
  `tests/account-settings-round.test.ts` 的"每一项权限都至少管一个操作"会盯着它们。

#### 15.39.4 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；测试 **1680 / 0 失败**（这一批新增 60 条：
PTZ 纯函数与服务层 17 条、抓图三态与仓库 6 条、schema v12 3 条、点位图投影 8 条、
界面与权限目录守卫 26 条）；i18n **缺失键 0 / 四语言键集一致 / 可直接删的孤儿 0**；
`electron-vite build` **exit 0**；`demo-shot --with-data` **0 problems**。

GUI 探针新增的**空气声呐**那一条（假空气声呐 + 假抓图，实测数字）：

| 读数 | 实测 |
|---|---|
| 添加设备（探活不带 `kind`） | 「已识别为：听诊盒子 / SN-16 空气声呐」，6 ms |
| 代次落库 | 加完设备设备行 `e2_variant = airSonar`（还没读状态就已经有） |
| **配置页页签** | `["PTZ 联动"]` —— **只有这一个** |
| PTZ 面板读到的值 | `cam_ip 192.168.2.64` / `cam_port 80` / `cam_user admin` / 口令输入框**空** |
| 改端口 → 保存 | 读回核对：`["球机端口生效"]`、`allApplied: true`、界面上那个框变成 **8082** |
| 假设备那一侧 | `cam_port = 8082`（真写进去了），`db_limit 60` / `cam_user admin` / `cam_pass` **原值未动** |
| 点位图 | 标记数 2；点声呐标记 → 右侧显示「探针声呐」 |
| 同步（带抓图） | `检查 1 条新增、0 条已在库；抓图落库 1 条；设备上文件已不在 0 条` |
| 告警那一行 | 徽标「有抓图」 |
| 抓图 | **3 张**，`naturalWidth > 0`（真的解码了 = CSP + 回环端点 + 目录落库整条链通），地址全是 `http://127.0.0.1:…` |
| `/workmode` | 假空气声呐**一次都没有收到**（那一代没有这个端点） |

**探针当场抓到的一个真缺陷**（已修 + 有回归测试）：健康检查对听诊盒子族直接调
`getWorkMode()`，而"这一族是不是空气声呐"只有读过 `/system` 才知道 —— 新客户端
（进程刚起 / 地址刚改）的 `variant` 还是 `undefined`，于是对一台 SN-16 发一个必然 404 的
请求，`markFailed()` 把**健康的设备**记成失败，三轮之后显示**离线**。
修法是健康检查先 `ensureVariant()`（读两代都有的 `/system`，代价仍然是**一次**认证读）；
回归测试见 `tests/e2-ptz-snapshots.test.ts` 的"健康检查**不问 `/workmode`**"。

**真机验证：没能跑成 —— 设备不在线**。`node scripts/e2-live-proof.cjs --ip 192.168.110.234`
在 2026-09-17 21:4x 运行时报：`听诊盒子/空气声呐：请求超时`，三种协议全部失败；
随后 `ping` 与 `http://192.168.110.234/` **都超时**（同一天下午它还以 108 ms 应答过）。
22:0x 再查一次仍然不通。

**于是这一轮补了另一件事：把那条链在"没有真机"的情况下先跑通。**
新 fixture `scripts/mock-air-sonar.cjs`（进程外的假 SN-16，按真机 V3.4.0 实测的形状实现：
真机路径 `/basic` 与 `/alarm_log_all` + 手册路径都答、文件走 `/static_file/`、
`PUT /system` **真的改自己的参数**、`/workmode` 回 404）。
把 `e2-live-proof.cjs` 指向它跑了一遍 —— **0 problems**，而且新加的两步都真的执行了：

| 步骤 | 在真应用主进程里实测到的 |
|---|---|
| 探活（不带 `kind`） | `kind: auscultationBox`、13 ms、16 通道、`dev_type = AS16-auth-vertical-reverse` |
| 安装信息 | 写进去 → 从库里读回逐项相等 |
| 同步（`--spectrograms`） | `alarmsCreated 1` / `audioSaved 1` / **`spectrogramsSaved 3`** / **`snapshotsLinked 1`** |
| **抓图**（新） | `state: ok`、**3 张**、每张的地址都是 `http://127.0.0.1:…`（回环端点）、目录 `audio/e2_MOCK-SN16-0001/…/_stft`，磁盘上三段 jpg 各 160 字节 |
| **PTZ 读 → 原值写回 → 读回**（新） | `allApplied: true`，逐项 `enabled / cam_ip / cam_port / cam_user / direction / saveSnapshot / realtimeChannel` 全部 `ok` |
| 整份回写的证据（假设备那一侧） | `PUT /system` 的 body 里有**整份参数**（`db_limit 60`、`cam_pass AP1_lfxs_2025` 等原值都在） |
| `/workmode` | 假设备的日志里**一条请求都没有**（只有启动横幅里提到过它）—— 健康检查的修复在真流程里也成立 |

所以现在**只剩"那台设备自己怎么回"没有验证**：harness 本身（含新加的两步）已经被证明能跑。

出包：`npm run dist:win:offline` →
`release\HERTZINNO Acoustic Box Manager-1.0.0-x64-setup.exe`（**127,062,445 B**，
sha256 `C4756ABDA4FFE12329940D9C6CE125ED6B6AC32BC6B841EE824CDC3A3CFB12F3`）；
`node scripts/verify-packaged.cjs` **25 通过 / 0 失败**（未签名 → 首次运行会有 SmartScreen 提示）。

#### 15.39.5 还没验证的（不要按已验证验收）

1. **真机上的 PTZ 写入**：`e2-live-proof` 里那一步（读 → **当前值原样写回** → 读回比对，
   业主同意过的那一次写入）**已经在一台假的 SN-16 上完整跑通**（见 15.39.4 的表），
   但**在真机上仍然没有跑过**：2026-09-17 21:4x 与 22:0x 两次检查，那台 SN-16
   （192.168.110.234）**都不在线**（三种协议全部超时，ping 与 HTTP 都不通；
   同一天下午它还以 108 ms 应答过）。
   所以"PTZ 写通道在这台设备上通不通、`PUT /system` 认不认我们这一份"**至今没有证据** ——
   fixture 与单测覆盖的是我们的实现，不是那台设备的行为。
   设备一上线跑这一条即可（**不会**改动球机的实际配置）：
   ```
   node scripts/e2-live-proof.cjs --ip 192.168.110.234 --password 123456
   ```
2. **`/time_sync_with_nvt` 的效果**：手册没写请求体，我们发空对象。
   真机上**没有点过**这个按钮；它做了什么、有没有用，**未验证**
   （假设备上验到的是"请求发出去了、回了 200"）。
3. **真机上的抓图**：这台 SN-16 的 1001 条告警里只有 6 条 `files_status=1`，
   而这 6 条的 `alarm.wav` / `1.jpg` 也全是 404（设备自己的网页播放器同样取不到）。
   所以"点开告警看抓图"在真机上**一次都没有成功过** —— 有图的那条链在假设备上验过
   （3 张 jpg，真的解码出来了）。
4. **抓图数目与质量**：手册说最多 3 张、1 秒一张；我们按名字 `1.jpg`…`3.jpg` 收，
   少于 3 张是正常的（重启后可能只剩一部分），但**没有**在真机上见过任何一张。

---

### 15.40 事件中心规格改造（业主 2026-09-17 第 9 批）：Phase 1–2

业主给了一份新规格：`HERTZINNO_Event_Alarm_Center_UX_UI_Spec_V1.0.docx`（抽出文本在
`docs/reference/event-alarm-center-spec-v1.txt`，用 `scripts/docx-to-text.cjs` 生成）。
它要把"告警记录列表"升级成一个**处置工作台**：Filter + Alert Queue + Detail Drawer 三栏，
KPI 条、状态机（New→Acknowledged→Investigating→Resolved→Closed）、
按 sensorType 切换的 Evidence、Timeline/Related/Activity、重复触发聚合与 Incident。

**逐节对照表（要求 → 现状 → 做到哪一步 → 冲突与做法）写在 `docs/EVENT-CENTER.md`**，
这里只记这一轮动了什么、为什么这么分阶段。

#### 15.40.1 Token：**取值对齐、名字不改**

规格 §17 把 token 列成 `--hz-*` / `--bg-*` / `--severity-*` 一套名字。我们**没有改名**：
这个仓库从第一版起就是"只有 `main.css` 写颜色"，改名会动几十个文件而没有任何可见收益。
做的是两件事 —— **取值对齐**（主色三档、页面底色 `#F7F8FA`、文字三级、边框两档、
输入/按钮圆角 6px、卡片 8px、控件高度 28/36、严重度五级）与**补齐缺的**
（`--color-severity-*` 十项、`--color-bg-page/-hover`、`--color-accent-light/-strong`、
`--sidebar-collapsed`、`--filter-panel`、`--detail-panel*`、`--event-row-*`、`--focus-ring`、
九档字号）。对照表在 `docs/EVENT-CENTER.md` §2。

字号那一档要说实话：**token 加好了，但既有组件里还有 100 多处写死的 `font-size`**。
一次性全局换字号会把每一页的行高与换行都动一遍（而这一轮并不改那些页面），
所以规则是"新做/重做的界面一律用 token（源码守卫钉住），旧组件在各自被重做时换过来"。

#### 15.40.2 侧栏可折叠（232 / 64）

规格 §3.2/§3.3 给了两个宽度、180–220ms 的过渡、折叠后的 Tooltip，以及选中项的样式
（3px 橙色竖条 + `#FFF5ED` 轻背景 + `#E65300` 文字，**明确不许整块填成高饱和橙**）。
都按规格做了，另外三处是我们自己的决定：

1. **折叠只改宽度与可见性，不换 DOM**：菜单项还是同一批节点，所以 Tab 顺序与读屏结果
   不随折叠改变；文字只是 `display: none`，`title` 与 `aria-expanded` 都留着。
2. **偏好记在 localStorage**（键 `hertzinno.sidebar.collapsed`），读写**各自兜底**：
   隐私模式/配额满时静默降级为展开 —— 一个界面偏好丢了不该让侧栏打不开。
   仓库里已有同样的先例（频道墙的折叠状态）。
3. **折叠时 logo 让位给折叠按钮**：64px 放不下两个 24px 的东西，而按钮留在同一个位置
   才不需要找"怎么展开"。

规格还要求"折叠后 Tooltip 里带**未处理数量**"：我们侧栏目前没有计数角标
（那个数字在顶栏的告警图标上）。这一条**没做**，原因与去处写在 `docs/EVENT-CENTER.md`
（会在 Phase 3 引入 KPI/队列时一并给侧栏接上同一个计数源，避免两处各查一次）。

#### 15.40.3 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；测试 **1693 / 0 失败**（新增 10 条：
Phase 1 token 6 条 + Phase 2 侧栏 4 条，见 `tests/event-center-round.test.ts`）；
i18n 缺失键 0、四语言键集一致（新增 `app.collapseSidebar` / `app.expandSidebar`）；
`electron-vite build` exit 0；GUI 探针 `demo-shot --with-data` **0 problems**
（窗口 1440×900、四档几何、设备表、点位图、空气声呐整条链全绿）；
重新打包后 `verify-packaged` **25 通过 / 0 失败**。

顺带修好一处**探针自己的缺陷**：`layout()` 的 30 秒超时对"在浏览器里点完一整条链"的
空气声呐探针太紧（显式等待就有 15 秒以上），忙的时候会误报超时 ——
现在超时可按调用点放宽（那一条给 120 秒），并把理由写在注释里。
这条与 15.39.4 里"探针挂住一个小时"是同一类问题的两个面：**探针自己的时间假设**也要能被质疑。

#### 15.40.4 这一轮**没做**的

规格 Phase 3–6 当时全部没做：KPI 条、左侧筛选面板、告警队列三种视图模式、详情抽屉与五个页签、
状态机与指派/Activity、重复触发聚合与 Incident。事件中心这一轮**一个字都没改**
（**Phase 3 已在 §15.41 完成**）。
另外三处冲突（DTS/DAS/DGA 渲染器、页内大标题、mock 数据 demo）在 `docs/EVENT-CENTER.md` §3
逐条写明，其中两条需要业主一句话（见 `docs/UI-VERIFY.md` Z 段末）。
5. **点位图的坐标精度**：`gisLatitude/gisLongitude` 是**人工录入**的，软件不做任何坐标
   校验（只校验范围），所以图上的相对位置**恰好等于**录入值的相对位置 —— 录错了图就错了，
   这一点在界面上没有提示（要不要加"定位到地图/坐标系"的提示是下一步的事）。

### 15.41 事件中心规格改造 Phase 3：KPI 条 / 筛选面板 / 告警队列（业主 2026-09-17 第 9 批）

规格 §18.1 的 Phase 3：把"一个表格 + 一个抽屉"变成"KPI 条 + 筛选栏 + 左侧筛选面板 + 告警队列"。
逐节对照与冲突处理仍在 `docs/EVENT-CENTER.md`（这一轮新增了 3.6–3.10 五条），
这里记的是**这一轮的实际取舍**。

#### 15.41.1 先把"等级"这件事摊开：四级 → 五级只在一个函数里换算

规格要五级（Critical/High/Medium/Low/Info），我们的领域层是四级，而且 `unknown` 是
**合法且预期会出现**的取值（相机 `alarm_level` 从未在真机上回过、声纹协议里没有等级字段）。
所以新增 `src/shared/domain/event-view.ts`：`toAlertViewModel()` 把领域事件换成
`AlertViewModel`（规格 §16.2 的契约），换算规则是

- `warning` → **High**（不是 Medium）：`deriveEventSeverity()` 的注释写明 `'warning'` 不是
  "从设备读到的等级"，而是"设备确实报了非零告警位"这条记录本身的语义。它是我们唯一站得住的
  等级信号；压到 Medium 只会让"永远为 0 的 Critical/High 占着最高两档"。
- `unknown` → Info **+ `severityUnknown: true`**，界面显示「等级未知」。不许把"不知道"印成"提示"。
- `medium` / `low` **不渲染**（没有代码路径能产生它们）：不出现在面板、KPI、下拉里。
  界面上"会出现"的等级由 `VISIBLE_ALERT_SEVERITIES` 一处定义。

这样 Phase 5 做等级迁移时，要改的只有这一个函数 + 数据库 CHECK。

#### 15.41.2 三个新组件，一条纯函数层

| 文件 | 职责 |
|---|---|
| `shared/domain/event-view.ts` | 视图模型适配、KPI、分面计数、筛选匹配、URL/localStorage 的**容错**存取（纯函数，37 条单测） |
| `components/event-center/EventKpiStrip.vue` | 四格 KPI（严重 / 高 / 未确认 / 平均确认耗时），前三格可点→转筛选，作用域印在下面 |
| `components/event-center/EventFilterPanel.vue` | 等级 / 来源 / 确认状态 / 设备四组带计数（216px） |
| `components/event-center/AlertQueue.vue` | 三档行高（56/88/104）、3px 严重度色条、↑/↓ 选中并同步焦点 |

`EventCenterView.vue` 里**表格拆掉**，换成队列；筛选栏只留 搜索 + 时间范围 + 六个内置视图 +
三种视图模式 + 面板开关；来源读况卡片改成**只在某一路失败或被截断时**出现（三路都正常时它
只是三行绿字，却占掉队列的第一屏；逐路条数已经在筛选面板里）。

#### 15.41.3 三处必须说出来的口径（都不许"看起来像全量"）

1. **KPI 与分组计数按"已加载的那一页"算**。主进程的等级过滤是**按来源整路跳过**的
   （`input.severity !== deriveEventSeverity(source)` 直接返回空），全量等级分布在主进程里
   从来没被算过。界面把作用域印出来：`KPI 与计数按已加载的 {loaded} 条统计（本次结果 {total} 条）`、
   `计数按已加载的 N 条`。
2. **平均确认耗时恒为「—」**：三路来源都没有把"确认时刻"带进事件模型，算不出来。
   显示 0 会被读成"确认得飞快"（`MetricCard` 对 `null` 本来就有「—」这一档）。
3. **关键字只在已加载的那一页里搜**，而且**改关键字不重新查询**（只有设备/来源/等级/时间/
   确认状态会触发查询）。相机的检测日志是一次设备 HTTP 请求 —— 每敲一个字连一次设备，
   换不来更全的结果，只是更慢。

#### 15.41.4 顺手修掉的一处真缺陷（Phase 3 期间发现）

原来唯一的筛选 watcher 是 `watch(() => ({...filters}))`：**搜索框每敲一个字都会重新查询**
（三路来源全查一遍，含相机 HTTP）。这一轮把它拆成两个：查询字段（设备/来源/等级/时间/确认状态）
触发 `reload()`，全部字段触发"写回地址栏与 localStorage"。搜索因此是**即时**的，
而且不再打着查询的旗号去连设备。

#### 15.41.5 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；测试 **1755 / 0 失败**（新增 62 条：
`tests/event-view.test.ts` 40 条纯函数 + `tests/event-center-round.test.ts` 22 条 Phase 3 守卫）；
i18n 缺失键 0、四语言键集一致（新增 30 个键 × 4 语言；同时删掉 6 个因表格移除而变成孤儿的
`eventsUi.column*`；`medium` / `low` 两个"现在不会出现"的等级也给了文案，免得 Phase 5
存五级的那天渲染出裸 key）；`electron-vite build` exit 0；GUI 探针 `demo-shot --with-data`
**0 problems**；重新打包后 `verify-packaged` **25 通过 / 0 失败**
（安装包 127,072,722 字节，sha256 `67986179417E6175FBDA88BAD2E3491A9B4A2D94C991CCD1E67A457EF7E1D3A5`）。

探针新增的一段（`scripts/demo-shot-driver.cjs`，只读、排在写设备之前）断言：
KPI 恰好四格且标签齐全、"平均确认耗时"是「—」、作用域文案里写着"已加载"、
筛选面板 216px 且四组齐全、六个内置视图、三种视图模式、旧表格已消失、
三档行高分别是 56/88/104、（**有行时**）点一行能开抽屉且 Esc 能关掉、
点 KPI「严重」之后地址栏出现 `severity=critical` 且左侧面板同步高亮、
**localStorage 里那一份筛选能读回来**（写操作读回验证）、
以及四条版面关系（无横向溢出 / 面板与队列不重叠 / KPI 条一行放得下 / 视口 1440×900）。
库里那一屏没有告警行时，行高/抽屉/Esc 三项在日志里**明确写成"没有验证"**，
不报问题也不假装通过。

#### 15.41.6 探针自己在这一轮暴露了三个缺陷（都已修，且都记在这里）

1. **事件中心那一段挂住过一次**（180 秒没有返回，而主进程日志一直在动）。超时之后
   driver 直接抛 `TypeError`（拿 `{probeTimeout:true}` 当结果读字段），**连报告都没打印出来**。
   修了两处：超时那一支**只报超时**、不再读字段（于是报告照常出），并且页面脚本每一步都往
   `window.__eventsProbeStep` 写一个进度标记 —— 超时时能报出**卡在哪一步**（渲染进程还能
   应答的话）。超时也从 180 秒收到 90 秒。
   这一次挂住的**原因没有查明**（下一次运行就恢复了）：主进程活着、渲染进程对
   `executeJavaScript` 180 秒不应答，与"页面结构没渲染"不是一回事。**没有结案**。
2. **"点配置没进详情页"与"单击 IP 把页面带走了"两条假失败**：探针从实时监测页切回设备管理页
   之后**固定等 900ms** 就去查表格，而这一步要重新读设备列表（含逐台探活），忙的时候 900ms
   内表格还没进 DOM —— 于是两次查找都拿到 `null`。改成**等行出现**（最多 6 秒）。
3. **"设备管理页找不到「添加设备」按钮"与"不在拓扑树里"两条假失败**：同一类问题，
   切到设备管理页后固定等 1.2 秒就断言拓扑树里的按钮。改成**等 `.device-tree` 出现**。
   判据很直接：紧接着的 addDialog 探针（同一页、晚一两秒）就找到了那个按钮 ——
   同一个东西一次找不到、一次找得到，问题在探针的等待上。

**这一类脆弱点还没有全部清理**：驱动里还有一批"切过去 + 固定等待 + 直接断言 DOM"的探针
（设置页、告警页、趋势页、样本库、实时监测都各有一些）。它们平时是绿的，但机器忙的时候
同样会把"还没渲染完"报成产品缺陷。**这是已知的探针脆弱点，不是产品问题**；下次动到哪一页，
就把那一页的等待改成"等元素出现"。

#### 15.41.7 还没验证的（不要按已验证验收）
- **长列表滚动与虚拟化**：一页 50 条直接渲染，没有虚拟滚动；上万条的滚动表现没测过。
- **"计数为 0 的设备仍可能在别的页有数据"**：只在文案里说明了，没有在界面上做过实验。
- **多显示器 / 缩放比例**：三栏只在 1440×900 量过（探针量了 216px）。
- **四语言的实际排版**：es/tr 文案更长（"Confirmación media"、"Onaylanmadı"），窄栏里是否
  换行、KPI 首屏会不会被挤成两行，**没有逐语言看过**。

### 15.42 事件中心规格改造 Phase 4：详情抽屉 / Overview / Evidence（业主 2026-09-17 第 9 批）

规格 §18.1 的 Phase 4：**Detail Drawer + Overview + Evidence**，完成条件是
「400–560 resize；不同 sensorType renderer」。逐节对照与冲突处理仍在 `docs/EVENT-CENTER.md`
（这一轮新增 3.10 / 3.11 两条），这里记的是实际取舍与踩到的坑。

#### 15.42.1 抽屉：结构进组件，动作留在页面

新的 `components/event-center/EventDetailDrawer.vue` 只负责**结构**：几何（400–560 可拖 +
键盘 ←→ 改宽度 + 偏好写 localStorage）、页签条、头部（等级 / 标题 / 设备链接 / 首次探测时间 /
主 CTA 插槽）、Esc 与 ↑/↓、换事件时把滚动拉回顶部。确认、下载结果文件、播放这些**动作**
仍由 `EventCenterView.vue` 通过插槽塞进来 —— 那一条路径已经验证过（能力决定渲染 + 写完读回），
搬进组件只会多一层 props 转发。

两个刻意的决定：

1. **页签条只渲染"已经做出来"的那两个**（Overview / Evidence）。规格的 Timeline / Related /
   Activity 排在 Phase 5（它们的素材是状态变更记录与聚合结果，库里现在没有）——
   画出三个永远空着的页签比不画更糟。标签文案五个都给了，Phase 5 只需要把常量加进去。
2. **↑/↓ 只在焦点位于抽屉内部时接管**。队列自己也处理 ↑/↓（它是列表的键盘入口），
   抽屉若在 `window` 上无条件接管，一次按键会跳两条 —— 一个很难查的"跳着走"缺陷。
   Esc 是例外：它是覆盖层的通用关闭键，焦点在哪都该管用。探针里有一条断言专门钉它。

#### 15.42.2 图片证据：一个新接口 + 复用已有接口

Evidence 页签（规格 §12.1 的 Acoustic 那一列）要回答"系统为什么认为这里发生了问题"，
而我们真正有的图片只有两处：

| 来源 | 图从哪来 | 接口 |
|---|---|---|
| 本机联动告警 | `frameRelativePath` | **新**：`eventCenter.evidenceImage({relativePath})` |
| 声纹告警（仅听诊盒子 / 空气声呐） | `alarms.snapshot_dir` | **复用**：`e2.alarmSnapshots(deviceId, alarmId)`（第 8 批已有） |

新接口只读、不加管理员校验，并且有**四道关**：路径来源（`recordingId` 优先，库里的行是权威）
→ 存储根越界保护（`StorageService.resolve` 会拒 `..` 逃逸并留一条 warn）→ 文件在不在
（`files-gone`）→ 是不是图片（交给端点的扩展名白名单，**不写第二份扩展名表**）。
四种失败各有各的说法，界面**不许画空框**。

一个刻意的细节：`evidenceImageSource(alert, deviceKind)` 把**机型**也吃进去。AE08 这类声纹盒子
根本没有球机抓图，不传机型就会拿它去问 `e2.alarmSnapshots`，然后界面上出现一句
"读取图片证据失败"—— 那是**假故障**（设备不提供这个能力，不是我们坏了）。

#### 15.42.3 探针抓到一个真缺陷（"存了 416、看起来还是 400"）

第一版的抽屉算了宽度、也把 416 写进了 localStorage，但 `.drawer` 的宽度只由 CSS 的
`var(--detail-panel)` 给 —— **没有把宽度绑到元素上**。于是：拖拽/键盘改宽度时，
`aria-valuenow` 变了、localStorage 变了、所有断言都是绿的，**屏幕上一点没变**。

抓到它的是探针里那一条"键盘 ← 之后量一次真实宽度"（400 ≠ 416）。修法是给 `.drawer` 加
`:style="{ width: … }"`，并且在源码守卫里钉住这一条绑定 —— 光有 aria 与 localStorage
的断言是不够的，它们证明的是"我们以为自己设了宽度"。

#### 15.42.4 顺手修掉的一处旧账

`AppModal` 里写死的 `rgba(23,23,23,0.32)` 与事件抽屉的 `rgba(23,23,23,0.24)` 是同一个值的
两个答案。新增 `--color-scrim`（0.32）两者共用 —— 组件里的 rgba 与 hex 是同一类问题，
而"遮罩有多暗"只该有一个答案。

#### 15.42.5 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；测试 **1789 / 0 失败**（Phase 4 新增 34 条：
`tests/event-view.test.ts` +15 纯函数、`tests/event-center.test.ts` +10 服务、
`tests/event-center-round.test.ts` +9 源码守卫）；i18n 缺失键 0、四语言键集一致；
`electron-vite build` exit 0；GUI 探针 `demo-shot --with-data` 0 problems
（抽屉默认 400px、抓手 400–560、页签恰好两个、Overview 11 格含 1 格跨两列、
切到 Evidence 真的切过去、Evidence 有图或有说明、焦点进入抽屉、键盘 ← 后宽度 416
且 localStorage 读回 416）；重新打包后 `verify-packaged` **25 通过 / 0 失败**
（安装包 127,078,606 字节，sha256 `24AAEE44CA477AC0D0B001C9D66A184BA15CFD11B55B7537B074419912C4E4AD`）。

#### 15.42.6 还没验证的（不要按已验证验收）

1. **鼠标拖拽只验了算法，没验手感**：探针走的是键盘那一路（← 一次 16px）。
   真实拖拽（按下、移动、松开）在 Electron 里能合成，但那验证的是探针自己的事件合成。
2. **"真的显示出一张图"没有在真机上看到过**：探针跑的是操作员库的**副本**（只复制数据库、
   不复制存储根），所以两条图片路径在那次运行里都取不到文件 —— 它只能证明"取不到时有正确的
   说法"。要看到真图，需要真机上有抓帧/抓图、且存储根里有那个文件。
3. **图与事件是否对得上**：路径由库回答（`recordings.relative_path` / `snapshot_dir`），
   但"这张图确实是这条告警那一刻的"没有任何第三方证据。
4. **四语言的抽屉排版**：探针在 zh-CN 下量的；es/tr 的头部三行、页签条、属性网格是否换行没看过。
5. **Evidence 里"打开大图"**：实现成 `target="_blank"` 打开回环地址，没有验证点开后的表现。

### 15.43 事件中心规格改造 Phase 5（前半）：状态机 / 处置工作流 / Activity（业主 2026-09-17 第 9 批）

规格 §18.1 的 Phase 5 完成条件是「状态变更记录完整；Assign/Ack/Resolve 流程闭环」。
这一轮做的是**能落库、能被判定的那一半**（schema + 领域 + IPC + 测试），界面（动作按钮与
Activity / Timeline / Related 三个页签）在同一阶段的后半，下一轮做。

#### 15.43.1 状态存哪儿：**新建两张表**，而不是给 `alarms` 加列

一条事件有三个所有者：声纹告警在 `alarms`（SQLite）、本机联动在引擎的待处理列表（内存 +
它自己的存储）、相机检测日志在**设备**上（连写接口都没有）。而"处置"是**我们自己的记录**。

所以 schema v13 新建 `event_status`（按 `EventCenterEntry.id` 一行一个当前状态 + 指派人）与
`event_activity`（状态变更 / 指派 / 留言三类流水，带时间、操作者、前后状态）。三个来源一视同仁，
不动来源表的语义，相机检测日志也能被处置（记在本机）。

三条由此而来的规则写在 `docs/EVENT-CENTER.md` §3.12，其中最容易出错的一条是：
**`status`（我们写的）与 `acknowledged`（来源侧的事实）不一致时以 `status` 为准**；而「确认」
这一个动作会让两边一起前进 —— 来源没有确认接口时（相机检测日志）**拒绝整次写入**，
不替设备答应它做不到的事。

#### 15.43.2 状态机：七个取值 + 一张迁移表，主 CTA 只有一个

`AlertStatus` 采纳规格状态图的七个取值（主线五个 + `muted` + `reopened`）。**Reassigned
不做成状态**：它是"指派给谁"，落在 `assignee` 上、记一条 Activity —— 做成状态会出现
"已指派的已确认"这种没有意义的组合。

迁移表里有两处**比状态图宽**（`new → investigating`、`acknowledged → resolved`：都是真实的
操作习惯，逼着人多点一下没有意义），一处**比状态图严**（`closed` 只能回到 `reopened`：
要动已关闭的东西必须留下"重新开启"这条记录）。`statusActionsFor()` 保证任何状态下的主 CTA
**恰好一个**（规格 §11.2），并且**没有确认接口的来源里不出现「确认」**（不是灰掉，是不画）。

#### 15.43.3 顺手挡掉的两个坑（都是"写库写歪"的那种）

1. **指派把状态退回「待处理」**：一条来源侧已确认、但库里还没有状态行的事件，如果
   `assign` 直接建一行 `new`，操作员会看到"指派了一下，状态退回待处理"，完全无法解释。
   修法：`assign` 时把**界面看到的当前状态**一起传下去建行（`fromStatus`），并有单测钉住。
2. **`muted` 的主 CTA 变成两个**：静默状态同时允许 `→ acknowledged` 与 `→ new`，
   第一版于是画出两个都叫「取消静默」的按钮（只有落点不同）。修法：只留一个
   （回到已确认），`muted → new` 留给程序化调用。

#### 15.43.4 一个流程教训（这一轮真踩到了）

**在这台机器上不要用 PowerShell 的 `Set-Content` / `Out-File` 写源码文件。** 我用
`Get-Content -Raw` + `Set-Content` 做了一次字符串替换，写出来的文件**不再是 UTF-8**
（中文变成乱码，TypeScript 报"字符串没有结束"），整个文件只能重写。前面改 i18n 目录时也踩过
同一次（行尾 + BOM 全被改掉，最后 `git checkout` 重来）。

规矩：**文本替换一律用编辑器工具（read + edit），不要经过 PowerShell 的重定向/管道**。
`write` 工具与 `edit` 工具写的是 UTF-8 且保留行尾；PowerShell 两者都改。
（写一次性脚本让 **Node** 去改文件是可以的 —— 那一轮删 13 个 i18n 键就是这么做的。）

#### 15.43.5 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；测试 **1831 / 0 失败**（这一轮新增 42 条：
`tests/event-workflow.test.ts` 17 条 + `tests/event-schema-v13.test.ts` 6 条 +
`tests/event-view.test.ts` 里的状态机 / Activity / Timeline / Related 19 条）；
i18n 缺失键 0、四语言键集一致、**孤儿键回到 0**（这一轮只加"现在就用得上"的键：
七个状态名 + 七个动作名 + 三种 Activity 类型；界面那一轮才用的 13 个键没有提前加进去）。

这一轮**没有重新打包**：改动全在后端（schema + 领域 + IPC），包里没有任何可见差别；
安装包在界面那一轮末尾一起出（届时要顺手把 `docs/BASELINE.md` 里的包哈希与测试数更新掉）。

#### 15.43.6 还没验证的（不要按已验证验收）

1. **真库升级没有发生过**：迁移测试跑在临时库上（v12 → v13、幂等、CHECK 都在）。
   操作员那台 v12 的真库第一次用新包启动时会升到 v13 —— 那一次还没发生。
2. **处置闭环在界面上不存在**（这一轮的性质）：IPC 与规则有测试，但没有任何界面在调它们，
   探针自然也还没有断言。
3. **`event_activity` 没有保留策略**：会一直长。多久算旧账是产品决定，这一轮不删。
4. **来源行被删之后的状态残留**：`event_status` 按 entry id 存，声纹告警行若被保留策略清掉，
   那一行状态就成了孤儿（界面上看不到，但库里会攒）。要清理规则时这是输入。
5. **`assignee` 的可选账户**：界面要用现有的账号列表（`auth` 那套 IPC），但"给操作员指派
   别人是否合适"这一类权限问题**还没有决定** —— 服务端目前按"与确认同一档（要管理员）"处理。

### 15.44 事件中心规格改造 Phase 5（后半）：处置动作与三个页签（业主 2026-09-17 第 9 批）

Phase 5 的界面一半：抽屉头部的处置动作、指派、以及 Timeline / Related / Activity 三个页签。
逐节对照仍在 `docs/EVENT-CENTER.md`（这一轮把 §2.2 与 §13 两行改成 ✅，并新增 3.11 / 3.14）。

#### 15.44.1 头部：一个主 CTA + 次要动作 + 行内表单

按钮不是写死的，而是**由状态机算出来的**（`statusActionsFor`）：待处理时主 CTA 是「确认」、
已确认时变「开始调查」、调查中变「标记已解决」…… 与规格 §11.2 那句"New 状态下通常是
Acknowledge；Acknowledged 后可变为 Start Investigation"一致。三条硬规则（都有单测）：

- **主 CTA 恰好一个**（规格明说）——`statusActionsFor` 自己保证，静默状态下的「取消静默」不抢；
- **没有确认接口的来源里不出现「确认」**（相机检测日志）：不是灰掉，是**不画**；
- **需要输入的动作给行内表单**（指派选账户、重新开启写原因），不叠第二层弹窗。

`⋯` 菜单没做：它的内容会与那几个次要动作完全重合。

#### 15.44.2 处置之后**重查**，但**不关抽屉**

规格 §15.1 明说"确认后立即更新状态、写入 Activity、**不关闭 Drawer**"。所以处置成功后
**不能**走页面上那个 `reload()`（它会关抽屉），而是：重查一次（`store.applyQuery`）→
按 id 重新指向更新后的那一条 → 重读一次处置记录。页签保持不变（操作员可能正停在
Activity 上看刚写进去的那一条）。

#### 15.44.3 三个页签：都是"我们真的知道的事"

- **Timeline**：首次探测到 + 我们自己的动作（状态/指派/留言）+ 联动动作，按时间排。
  规格举的例子里还有"AI 分类 · 置信度""阈值超限""通知已发"——我们没有那些数据，**不画**；
- **Related**：同设备 / 同类型 / 前后 10 分钟三组，**只在已加载的那一页里找**（作用域印在
  页面上），点一个 chip 就切到那一条。规格的"同资产 / 邻近资产"不做：我们没有 asset 这一层，
  坐标也是人工录的、多数设备还是空的；
- **Activity**：`event_activity` 的流水，新的在前，写成一句人话（"admin 把状态从「待处理」
  改为「已确认」"）。主语是**账户名**（可追责），不是显示名。

#### 15.44.4 探针：加了第三条**写探针**，并修了它自己的一只瞎眼

处置是写操作（改状态、写两张表），所以新增的 `eventsHandling` 排在**所有只读探针之后**
（与听诊盒子、空气声呐那两条并列）。它做三层断言：界面真的点了 → `eventCenter.query` 读回
状态真的变了 → `eventCenter.activity` 读回"谁在什么时候从什么改到什么"，并且抽屉没被关掉。

顺带修了探针自己的三处缺陷（都是"报告看不见真相"的那一类）：

1. **console 监听认不出数字等级**：Electron 38 的 `console-message` 传对象，但 `level`
   可能是数字（2/3）。第一版只比字符串 `'error'`/`'warning'`，于是**渲染层的报错一条都
   没被报出来**——探针看起来"没有 console 错误"，其实瞎了一只眼。
2. **`execJson` 没有超时 + `layout()` 默认 30 秒太紧**：渲染进程被拖住时前者能**几个小时
   不返回**（实测那一次探针跑了 4.5 小时）。现在每次往返都有上限，`layout()` 默认提到 60 秒。
3. **超时之后仍然读字段**：`devicesChrome` 超时返回 `{probeTimeout:true}`，而下一行读
   `pageTitles.length` → `TypeError` → **整份报告被带走**（那一次运行等于白跑）。
   现在超时那一支只报超时；并且 harness 异常时也会把已经收集到的问题打出来。

**还有一处是真正的根因（值得单独记）**：探针那几次"挂住几个小时"的病根是
**Chromium 的后台定时器节流** —— 机器被别的窗口占着时探针窗口是被遮挡的，`setTimeout`
被节流（先 1 秒一次，隐藏 5 分钟后 1 分钟一次），而探针每一步都是 `await sleep(...)`，
于是 4 秒的等待变成几分钟、一次运行从 6 分钟涨到 4.5 小时，报告里全是超时。
修法是一行：窗口创建时 `webContents.setBackgroundThrottling(false)`。

这一条同时解释了**前几轮那些"探针莫名其妙挂住"的记录**（§15.40.3、§15.41.6）：
不是产品卡住，是探针的定时器被节流了 —— 而且渲染进程本身是好的，
所以"超时之后还能读到卡在哪一步"。

#### 15.44.5 探针抓到第二个**真缺陷**：取消筛选取消不掉（界面在骗人）

只读探针里那句"清筛选之后队列仍然是空的：0"不是探针的问题，是产品的问题。追下去
（在探针里直接问主进程一次同样条件的查询，结果是 50 条，而界面显示
「本次筛选命中 0 条事件」）之后定位到 `stores/eventCenter.ts` 的 `applyQuery`：

```
query.value = { ...query.value, ...patch, offset: 0 }    ← 旧写法：在旧查询上打补丁
```

页面侧的 `buildQuery()` **只带上生效的筛选**，所以"取消一个筛选"在补丁里表现为
**没有那个键** —— 而合并会把它留在 query 里。于是点「清除全部」之后：筛选栏空了、
左侧面板显示"全部"、**查询却仍然按旧的等级过滤**，页面显示 0 条。

这是"界面在骗人"的那一类缺陷（控件显示的状态与实际查询不一致），而且从 Phase 3 就存在
（那时的探针只加筛选、从不取消，所以没碰到）。修法是从**干净的一页**开始：

```
query.value = { ...emptyQuery(), ...patch, offset: 0 }
```

守卫写在 `tests/event-center-round.test.ts`（"筛选记在地址栏与本机，并且**取消筛选真的
取消得掉**"），探针里那句"清掉筛选之后队列仍然是空的"继续钉着它。

#### 15.44.6 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；测试 **1836 / 0 失败**；i18n 缺失键 0、
四语言键集一致、**孤儿键 0**；`electron-vite build` exit 0；
**GUI 探针 `demo-shot --with-data` 0 problems**（含 §15.44.4 的第三条写探针：
点主 CTA → 状态读回 → 处置记录读回 → 抽屉没关）。

写探针读回来的原文：

```
events handling: {"ok":true,"action":"acknowledge","entryId":"alarm:alm_0mu6ni6hh004xnj22n",
 "statusBefore":"(none)","statusAfter":"acknowledged","activityCount":1,"activityKind":"status",
 "activityActor":"admin","activityTo":"acknowledged","notice":"状态已改为「已确认」",
 "drawerStillOpen":true,"activityRows":1,
 "activityText":"2026/9/18 15:43admin 把状态从「待处理」改为「已确认」"}
```

#### 15.44.7 还没验证的（不要按已验证验收）

1. **指派**：界面与 IPC 都有，但探针里没有点过"选账户 → 确定"这一步（只验证了按钮存在性
   由状态机控制）。**重新开启的原因必填**同理（服务端有单测，界面上的行内表单没点过）。
2. **真库升级到 v13 还没有发生过**（迁移测试跑在临时库上）。
3. **`event_activity` 没有保留策略**；**处置动作要求管理员**（要不要给操作员单独开一项
   权限需要一句话）。
4. **DTS / DAS / DGA 三种 Evidence 渲染器不做**（§3.1 那条仍然要业主点头）；
   **页内大标题不加**（§3.2）。

### 15.45 事件中心规格改造 Phase 6 前半：重复触发聚合（业主 2026-09-17 第 9 批）

规格 §18.1 的 Phase 6 完成条件是「重复告警聚合；人工 Create Incident；关联 Alert」。
这一轮做的是**聚合**那一半（领域 + 主进程 + 界面 + 探针），Incident 属同一阶段的后半。

#### 15.45.1 分组键与"连续"的定义

规格 §14.1 说"同一设备 / 同一事件类型 / 指定时间窗口内的**连续**触发"。我们有的只有
deviceId、事件种类与时间窗口（没有 asset / detectionRegion / ruleId，那三样在我们数据里
不存在），所以分组键写死在 `eventGroupKey()` 一处，"可配置"落在**时间窗口**上（界面四档）。

"连续"是这样实现的：按时间升序扫，**与组内最后一条**的间隔 ≤ 窗口就并入，否则另起一组。
这比"窗口内的第一条一直拉人进来"更贴近操作员的直觉 —— 后者会把一次长时间的抖动并成一个
巨大的组（0 分钟到 10 分钟、再到 20 分钟……只要每 9 分钟响一次就永远在同一组里）。

#### 15.45.2 两个标识：组用最早的，代表用最新的

- **`groupId` = 组内最早那一条的 entry id**（稳定：后来的触发不会改它）；
  处置状态与（后半的）Incident 关联都挂在它上面。
- **返回给界面的那一条 = 组内最新那一条**：抽屉里的证据（抓帧、录像、指标）是最近一次触发
  产生的，把最早那条当代表会让操作员看到一张十分钟前的图却以为是最新的。

处置一条聚合告警 = **处置组内每一条触发**（状态与流水在同一个事务里各写 N 条，`appliedTo`
回到界面，回执写"已把 N 次触发的状态改为…"）。状态合并也按组：组内任何一条被处置过，
整条告警就算处置过 —— 只看代表会漏掉"这组在更早的触发上已经被确认过"。

#### 15.45.3 探针怎么证明"聚合不是编的"

新加的探针断言里最要紧的一条是：**把聚合窗口切到「不聚合」，行数必须变多**；
并且只有在页面上真的出现了 ×N 时才要求"严格变多"（操作员库里的告警如果本来就间隔很久，
聚合前后行数一样是正常的，那不该报成缺陷）。

实测（操作员库的副本）：10 分钟窗口下 50 条告警并成 **1 条**（队列一行、带 ×N），
切到「不聚合」立刻是 **50 行**，切回 10 分钟又是 1 行；抽屉的时间线里 **50 个节点**
（1 次"首次探测到" + 49 次后续触发）—— 这就是规格 §14.1 那句"聚合后仍保留原始 Event 明细"
在界面上的样子。探针随后把窗口恢复成默认档，后面那条写探针照旧跑通。

#### 15.45.4 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；测试 **1862 / 0 失败**（这一轮新增 26 条：
11 条聚合纯函数、7 条服务侧聚合与上限、2 条"一次处置落到整组"、6 条源码守卫）；
i18n 缺失键 0、四语言键集一致、孤儿键 0；`electron-vite build` exit 0；
GUI 探针 `demo-shot --with-data` **0 problems**；重新打包后 `verify-packaged` **25 通过 / 0 失败**
（安装包 127,088,702 字节，sha256 `EF9ADB1E2D42CA998DC15DF98ADE7E00CC9127055C99ED88D0CF9A1217202E84`）。

#### 15.45.5 还没验证的（不要按已验证验收）

1. **API 的缺省是不聚合**（窗口由调用方显式给）：这是我们**刻意的**选择（写进
   `docs/EVENT-CENTER.md` §3.15），但也就意味着"别人直接调 IPC 时不聚合"这件事只有单测钉着。
2. **聚合组的跨页稳定性**：组是按**当前取回的那一池**算的（每路来源都有读取上限），
   所以同一组在两次查询之间**可能不同**（例如设备侧又多了几条触发）。`groupId` 取最早那条
   让它在多数情况下稳定，但这不是一条被证明的不变式。
3. **一次处置写 N 条**：48 条成员的组就是 96 行（状态 + 流水）。**没有量过大组的写入耗时**。
4. **Incident（人工创建 + 手动关联）还没做** —— 规格 §14.2 的后半，下一轮。

---

### 15.46 相机墙空白格的「+」选择器弹错位置（业主 2026-09-18 报的 bug）

业主原话：「在添加多个设备的时候，在设备总览界面，点击添加视频通道，存在 bug，弹出请选择
相机，但是好像位置被覆盖了，没有显示出来。」

#### 15.46.1 根因：不是样式，是「开在哪里」

上一版每一格的选择器是一个**原生 `<select>`**，藏在整面墙末尾的 `.visually-hidden` 宿主里
（`1×1`、`clip: rect(0 0 0 0)`），点 `+` 时用 `showPicker()` 打开。原生下拉贴在**它自己那个
盒子的边上** —— 这是浏览器的行为，不是我们写的位置 —— 而那个盒子在**页面左上区**，与操作员
点的那一格毫无关系。真窗口里量到的数字（1440×900，`scripts/demo-shot-driver.cjs` 的
`camera picker` 探针，修复前那一次运行）：

| 量到什么 | 值 |
|---|---|
| 隐藏宿主（= 原生下拉的锚点） | `{left: 273, top: 97, width: 1, height: 1}` |
| 点的那一格 | `{left: 834, top: 148, right: 1389, bottom: 460}` |
| 两者相距 | **561px** |

还有第二条退化路径：`showPicker()` 需要**真实用户手势**，拿不到就抛异常，代码退回
`select.focus()` —— 焦点落在一个被裁掉的 1×1 控件上，屏幕上什么都不会发生（探针那条路径
记到的就是这一种，`focusedInstead: "wall-pick-1"`）。

那行「请选择相机」也顺带解释清楚了：它是那个 `<select>` 唯一的**占位** `<option>`。操作员库里
只有一台相机，而总览页的自动起播会先把它放进一格（`autoPlayOnce()` 的第一步就是上墙），于是
空白格里"可选的相机"恰好是 **0** 台 —— 下拉里只剩那一行占位文字。

#### 15.46.2 我们的做法：自绘浮层 + 纯函数定位

- **出处（我们自己的决定）**：`+` 这个入口本身是产品要的（「加号应该在窗口中心」），iVMS 那边
  的投放方式是拖拽 / 双击 / 悬停 ▶ 三种（见 §5.1，我们三条都保留）。`+` 是第四个入口，它的
  清单因此由我们自己决定怎么画 —— 而"怎么画"复用本仓库既有的三条浮层规矩
  （`VideoContextMenu`：**不越界**、**一定关得掉**、**键盘可达**）。
- 浮层是 `CameraCellPicker.vue`：`<Teleport to="body">` + `position: fixed`，位置由
  `placeCameraPicker()`（`lib/cameraWall.ts`，纯函数、7 条单测）算：**贴在被点那一格的下面**，
  下面放不下就**翻到上面**，最后**夹进视口**。水平方向对齐那一格的左边缘。
- 「可选项有哪些」仍然只有一份来源：`optionsForCell()` —— 换掉的是**画法**，不是判断。
- 键盘：`+` 回车打开、↑/↓/Home/End 移动、回车选中、Esc 收起、Tab 收起（浮层挂在 `<body>`
  上，不拦 Tab 会把焦点扔出应用）。点外面 / 滚动 / 改窗口大小都关掉；关掉之后焦点**还给**
  触发它的那个按钮，选中之后焦点交给这一格新出现的设备名按钮。
- 清单为空时画一句短状态词（新词条 `cameraWallUi.pickNoOption`「没有可选的相机」），
  而不是一块空浮层 —— 空的浮层与"还没渲染出来"看起来一模一样。

#### 15.46.3 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；测试 **1882 / 0 失败**（新增 20 条：7 条落点
纯函数 + 13 条源码守卫 `tests/camera-picker.test.ts`）；i18n 缺失键 0、四语言键集一致、孤儿键 0
（删掉了没有读者的 `cameraWallUi.pickPlaceholder`）；`electron-vite build` exit 0。

GUI 探针 `demo-shot --with-data`：**0 problems**。`camera picker` 那一段实测 ——
浮层出现在被点那一格**正下方 4px**、`menuInsideViewport: true`、`menuOnTop: true`
（中心点上最上层的就是它，即"没有被盖住"）、`menuFocused: true`；`legacyHiddenHost: false`
（1×1 隐藏宿主已经不在）；Esc 关掉且那一格未被改动；随后通过**真实右键菜单**「关闭这一格」
腾出相机 → 清单里出现那台相机 → 选中 → 那一格显示它的名字、浮层关闭；离开总览页再回来，
空格数回到 3（探针自己写进去的东西被清掉）。

#### 15.46.4 还没验证的（不要按已验证验收）

1. **探针开不了原生下拉**：合成 `.click()` 没有用户手势，所以"修复前那次原生下拉到底画在
   哪里"没有被**看见**过 —— 依据是宿主几何（1×1、离目标 561px）+ 业主的报告。修好之后的
   浮层是自己画的，探针量得到（上面那一组数字）。
2. **多台相机时的清单长度**：操作员库里只有一台相机，所以清单**永远只有 1 项**。滚动的
   上限（`max-height: 320px`）、以及十台相机时的可读性没有被验证。
3. **最下面那一格翻到上面**那条分支只有单测（`placeCameraPicker` 的 4 条用例）钉着，
   真窗口里没有构造出"下面放不下"的布局（那是 16 分屏 + 高窗口的形状）。
4. **触屏 / 高 DPI 缩放**：浮层用的是视口坐标，只有 100% 缩放 + 1440×900 这一次运行。
5. **「更换相机」那条路**（点设备名打开浮层）在真窗口里没有单独点过 —— 与 `+` 走的是同一个
   `togglePicker()`，单测钉着"两个入口同一个处理器"。

---

### 15.47 应用级失败进告警图标，不再挂在页面顶上（业主 2026-09-18）

业主原话：「认证失败，检测用户名和密码 这些告警内容，直接放在右上角的告警 ICON 内，而不是在
软件中进行顶部添加信息。要确保整体的布局不会因为告警等内容而改变。」

#### 15.47.1 原来长什么样

`devices.error`（设备列表 / 通道表 / 状态刷新这一类**读**失败，认证失败就在其中）被
`AppTopbar` 画成顶栏下面一条**绝对定位**的横幅（`.topbar__error`）。两个后果：

- 它在**每一页**都在 —— 一条「认证失败，请检查用户名和密码（AUTH_FAILED）」就这样挂在所有
  页面上（真窗口的正文里逐字读到过，见 §15.46 那段日志的 `bodyHead`）；
- 它是绝对定位的，所以不推内容，但**盖在内容上**：`position: absolute; top: calc(100% + 4px)`，
  横跨整个窗口宽度。

总览页还**又画了一份**同一个字段（`OverviewView` 的第一行 `<div v-if="devices.error">`），
所以同一个失败在两页上说两遍。

#### 15.47.2 这一轮的口径（我们自己的决定）

一句话：**应用级的事实进告警图标；点一下的结果留在原地。**

| 什么 | 去哪 | 为什么 |
|---|---|---|
| 设备侧的**读**失败（设备列表 / 通道表 / 状态刷新） | 告警图标面板里的「系统消息」 | 它与你"在哪一页、点了什么"无关，是会话级的事实 |
| 增删改设备、保存设置、确认告警…… | **留在原地**（对话框 / 卡片 / 页面那一条） | 那是你刚点的那一下的结果，搬到顶栏等于把话说到了别处 |
| 页面自己的内容说明（本次结果被截断、数据不完整…） | **留在原地** | 它是"这一页此刻的内容"，不是应用级故障 |

实现落点：

- `stores/appNotices.ts`：一张最多 12 条的表。**同一个来源只留一行**（再次报到只更新文案），
  `at` 记的是**第一次**被看到的时刻（反复失败不会把它刷成"刚刚"）；可以逐条忽略，也可以一次
  清空。
- `stores/devices.ts` 的三条读路径各报一条（`devices-list` / `devices-channels` /
  `devices-status`）：读失败时报，**读通了各自撤掉**（通道表读回来不该把"设备列表读不出来"
  那条也撤掉，所以是三个 id）。增删改**不报** —— `DevicesView` / `AddDeviceDialog` 已经在
  它发生的地方就地说明（那两处是 `devices.error` 仅剩的读者，由
  `tests/app-notices.test.ts` 钉住）。
- `AlarmLinkagePanel.vue`：面板最上面多一段「系统消息」，逐条列出（文案 + 第一次出现的时刻 +
  忽略按钮 + 全部清除）。**图标上多一个点**（不是数字）表示"有系统消息"：
  **角标里的数字仍然只是待处理告警条数**（与面板里那份列表同源，这是本仓库既有的硬规矩：
  一个数字配一份别的列表就是界面在说假话），两者不相加。
- `AppTopbar.vue`：那条浮动横幅连同样式一起删掉；`OverviewView.vue` 的第二份也删掉。

**布局为什么不会动**：面板本来就是 `position: absolute`（它一直如此，理由是"打开面板不该挤动
内容"），系统消息那段住在面板里，所以它的出现与消失**不参与页面布局**。探针量的是打开/关闭
面板前后：内容区顶边、页面顶边、页面高度、滚动位置、顶栏高度**逐项相同**。

#### 15.47.3 出处

- **产品要求**（业主 2026-09-18，本节的标题句）+ 更早的一条：2026-09-16「待处理告警与告警图标
  合并」—— 那时就已经定下"告警只有一个入口"，这一轮只是把**应用级失败**也收进同一个入口。
- **iVMS-4200 参考**：这一节的浮层规矩沿用 §3 那三条（不越界 / 一定关得掉 / 键盘可达），
  没有新增第二种浮层行为。iVMS 手册里没有"应用级错误放在哪"的条目 ——
  **手册未说明**，这一条是按业主那句话定的。

#### 15.47.4 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；测试 **1898 / 0 失败**（新增 16 条：
7 条 store 行为 + 9 条摆放位置守卫，`tests/app-notices.test.ts`）；
i18n 缺失键 0、四语言键集一致、孤儿键 0；`electron-vite build` exit 0。

GUI 探针 `demo-shot --with-data`（`alarm panel` 那一段）实测：`.topbar__error` **0 条**；
面板里 `[data-app-notices]` 那一段在、逐条列出；打开/关闭面板前后
`{contentTop, pageTop, pageHeight, scrollTop, topbarHeight}` **逐项相同**；探针先把「告警记录」
页的设备筛选切到一台真设备（`loadChannels` 必失败的一次读）来把那条系统消息**造出来**，
再用同一路 IPC 确认这一次环境确实读不出来（`channelsProbeOk: false`）—— 那条消息于是必须
出现在面板里。

#### 15.47.5 还没做 / 没验证的（不要按已验证验收）

1. **其它页面的横幅没有搬**（`alarms.error` / `samples.error` / `store.error` / `monitor.error`
   / 设置页的 `settings.error` …）。理由是它们**混着两种事**：读失败与"你刚点的那一下失败"
   共用同一个 `error` 字段，整块搬走会把点一下的失败也搬离它发生的地方。要搬得先把那两类
   分开（每个 store 两个字段），那是另一轮的事。
2. **`devices.error` 那个字段仍然被两类事共用**：读路径在失败时写它，增删改失败时也写它，
   而 `DevicesView` / `AddDeviceDialog` 读它当"动作失败"的文案 —— 于是一次"通道表读不出来"
   可能被当成"删除失败"显示出来（历史遗留，本轮没改；本轮只是让读失败**另外**报进系统消息）。
3. **没有"问题解决了就自动清掉"的完整闭环**：三条读路径读通了会撤各自的条目，但如果那条
   读**再也没有发生过**（例如设备删了），消息会留到操作员点忽略为止。
4. **系统消息没有持久化**：重启软件之后那一段是空的，直到下一次读失败。它是"当前状态"，
   不是日志。
5. **面板里的系统消息没有真实多条的样本**：一次性 profile 里通常只有一条（通道表那一读）。
   上限 12 条、多条时的滚动与可读性只有单测钉着。

---

### 15.48 事件中心规格改造 Phase 6 后半：Incident（业主 2026-09-17 第 9 批）

规格 §18.1 的 Phase 6 完成条件是「重复告警聚合；人工 Create Incident；关联 Alert」。
前半（聚合）在 §15.45，这一轮做的是后半 —— 规格 §14.2 自己给的 **V1：人工 Create Incident +
手动关联 Alert**。V2（规则型关联）与 V3（AI 建议 + confidence）**不做**（规格把它们排在 V1 之后，
而且我们连 asset 层与跨传感器设备都没有，见 `docs/EVENT-CENTER.md` §3.1）。

#### 15.48.1 只做规格写了的：Incident 没有生命周期

规格 §2.1 用一句话定义 Incident，但**没有**给它状态/严重度/负责人/关闭条件（§2.2 的状态机是给
Alert 的）。所以 `incidents` 表只有标题、可选备注、创建人、创建与更新时间；没有删除入口，
没有"关闭"。理由与将来怎么补写在 `docs/EVENT-CENTER.md` §3.16。

同一段 §8.2 的 KPI 例子里有一格 `Incidents 5`，我们**不加**：我们的 Incident 只增不减，
而同一段末尾明确写着不要拿"总量"当主要 KPI（§3.17）。

#### 15.48.2 两处我们自己的取值（规格没给数）

| 取值 | 我们的数 | 规格怎么说 | 理由 |
|---|---|---|---|
| 建议卡出现的阈值 | 同一条相关性链上 **≥2** 条告警（含当前这条）——**可调**：抽屉里的下拉四档 2 / 3 / 5 / 10，跟着本机记住 | §13.2 只说"当相关性达到阈值时" | 一条孤立告警没有可建议的内容；取更大的值会让这条入口在只有两三台设备的现场永远不出现。**业主 2026-09-18 要求可调**，所以默认档之外还能改（离散档位，见下） |
| 建议标题 | **设备名 + 「异常情况」** | §14.2 的例子是 `Transformer T03 abnormal condition` | 我们只有设备名（没有 asset 名）；它只是初值，可以整句改掉 |

阈值放在**抽屉「关联」页签**里（建议卡旁边），而不是系统设置：要改的是眼前这一屏的行为，
让操作员为它走开一页是错的。档位是离散的四档而不是自由输入 —— 调低会让建议变多，
离散档位让操作员能预判结果，也不会出现 `0` / `999` 这种没有意义的阈值。
没到阈值时那一段会**说一句为什么**（"同设备上还有 N 条其它告警，未到阈值"），
而不是留一片空白：空白与"软件没做这件事"看起来一模一样。

#### 15.48.3 存法与幂等

- 关联单独一张表 `incident_alerts (incident_id, entry_id, linked_at, linked_by)`，
  **主键 `(incident_id, entry_id)`** + `INSERT OR IGNORE`：同一个关联点两次不会产生两条链接，
  也不报错（`tests/event-center.test.ts` 的 Incident 那一组钉着）。
- `ON DELETE CASCADE`：删掉一个 Incident 时它的链接一起走（这一轮没有删除入口，但不留悬空垃圾）。
- 创建 + 关联在**同一个事务**里：一个建出来却一条都没挂上的 Incident 是空壳，而界面上
  "创建并关联这几条"是**一次**动作。
- 关联的 key 与状态/Activity 完全同一套（`EventCenterEntry.id`）：`alarm:` / `linkage:` /
  `detect:` 前缀；写进去一个认不出前缀的 id 会被**拒绝**（与 `changeStatus` 同一条校验）。
- 建 Incident **不碰任何 Alert 的状态**、也不写 Activity：规格 §13.2 明说"不自动替用户
  关闭/合并"。

#### 15.48.4 界面

抽屉「关联」页签最上面一段：已关联的 Incident（可逐条解除）、够条件时的**建议卡**、
两个入口（创建 / 关联到已有）打开同一个 `IncidentCreateDialog`（规格 §16.1 的组件名）：

- 对话框里两种走向用仓库既有的 `btn` + `btn--primary` + `aria-pressed`（不新造分段控件）；
- 标题校验只有一处：`validateIncidentDraft()`（对话框与主进程共用）—— 两处各判一次迟早分叉，
  表现是"界面说可以、点下去被拒绝"；
- 候选清单**默认全勾、可逐条去掉**（建议只是建议）；
- 回执就地显示在这一段里（不在页面顶上，与 §15.47 同一条口径）。

#### 15.48.5 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；测试 **1942 / 0 失败**（新增 44 条：
schema v14 迁移 8 条、Incident 领域 16 条、服务 10 条、源码守卫 10 条，另加既有测试的更新）；
i18n 缺失键 0、四语言键集一致、孤儿键 0；`electron-vite build` exit 0。

GUI 探针 `demo-shot --with-data` **0 problems**，`events handling` 那一段（写探针）实测：
先把聚合窗口切到「不聚合」（50 行、「Auscultation Box」出现两次以上）→ **建议卡出现** →
对话框（候选 48 条、默认全勾、标题预填）→ 提交 → `incidentsForAlert` 读回 1 条（标题/创建人/
关联 48 条）→ 面板列出那一行 + 回执 → 解除关联 → 再读回 0 条。
**建议阈值可调**：下拉 4 档、改成 10 写回本机（localStorage）、改回 2 也写回；
独占一台设备的告警上**不给建议卡**、而是那句「同设备上还有 0 条其它告警，未到阈值（2 条）…」。
跑完恢复聚合窗口。

#### 15.48.6 还没验证的（不要按已验证验收）

1. **真库升级到 v14 没有发生过**（迁移测试在临时库上）。
2. **没有去重/合并**：两条标题一样的 Incident 会并排出现（合并该保留哪一条是产品决定）。
3. **没有删除 Incident 的入口**（规格 V1 没有这个动作）。
4. **`N 条关联告警` 与队列里的 ×N 不是同一个数**：前者数"关联了几条告警"（一条 ×50 算 1），
   后者数"触发了几次"。
5. **多个 Incident 同屏的排版**没有逐语言看过；**「关联到已有」的下拉**（上限 100 条）在
   攒了几十条之后的样子没有量过。
6. **`incident_alerts` 没有保留策略**（与 `event_activity` 同一条）。
7. **阈值默认档是 2**（我们的取值）。它现在**可调**（抽屉里四档 2/3/5/10、本机记住），
   但"这一页里哪个档最合适"只有你能回答；另外**这一次没有构造出"阈值 2 给建议、10 不给"的
   真窗口翻转**（那一页的设备有 48 条同设备告警，任何档位都给建议），翻转只有单测钉着。
8. **阈值是本机偏好**（`localStorage`，与视图模式同一套），不跟账户走。

---

### 15.49 第 10 批界面要求（业主 2026-09-18，24 条）：本轮做完的第三条 / 第七·十条 / 第十九条

业主这一批给了 24 条（清单里"2"出现两次，其余顺延）。完整的逐条进度表在
`docs/UI-VERIFY.md` 的 **DD 段**；这一节只写**本轮做完的那三条**里值得留档的判断。

#### 15.49.1 侧栏：折叠按钮的位置与收起后的圆形 logo（第 3 条）

- **位置**：按钮从一个"品牌行右侧的图标"变成**导航列的最后一行**（「协议实验室」之后）。
  出处是业主第 3 条原话。它借 `.nav-item` 的行形状（同样的 `--nav-row-height` 与 3px 左边距），
  所以看起来就是导航列的一部分；`data-action="sidebar-toggle"` 与 `aria-expanded` 保留，
  名字仍然随状态在「收起侧栏 / 展开侧栏」之间切换（读屏用户听到的是"按下去会发生什么"）。
- **圆形 logo**：收起后 logo 用一个 **32px 的圆**承载，圆内 `object-fit: contain` 放完整 logo。
  **为什么不是把图裁成圆**：原始素材是 224×120 的长条（`docs/BASELINE.md` §品牌），
  `border-radius: 50%` 直接套上去会把长条切成两半；我们没有圆形版本的素材，也不该为了一个
  折叠态伪造一个。圆底 + 完整 logo 在 64px 宽的一列里读起来仍然是"一个圆形标识"，
  而且展开时它照旧是原来的横排 logo。
- **出处**：两条都来自业主 2026-09-18 第 3 条；"圆形"的具体尺寸（32px）与内边距（5px）是我们的取值。

#### 15.49.2 「安装信息」→「地址信息」，并删掉基准声压级（第 7、10 条）

- 三个界面（**添加设备**对话框 / 设备管理页的**编辑**对话框 / **地址信息**只读卡片）都不再显示
  基准声压级，四语言文案与探针断言同步改。
- **库里的列留着**：`devices.sound_level_db` 是 v11 迁移发布的列，删列要再做一次迁移；
  而它不影响任何界面。旧值原样保留（界面不读），**要不要真删需要业主一句话**。
  这一条与"事件中心不加 `Incidents` KPI"同一条思路：不为一次界面删减去动已经发布过的存储结构。
- **`parseInstallation()` 仍然校验它**：域层、API 与探针（`e2-live-proof` / `demo-shot`）都还
  在写这个字段，所以那条"范围越界"的文案**留着**（`installUi.errSoundLevel`）—— 删掉它等于把
  一个可达的失败路径变成界面上的一串裸 key（本仓库把这种情况当缺陷）。
- **出处**：业主第 7 条（改名 + GIS 显示，显示部分待做）与第 10 条（删基准声压级）。

#### 15.49.3 在线状态用绿点/灰点，删掉那段"尚未接入"的说明（第 19 条）

- 那一句（原 key `monitorUi.sonarLiveUnwired`）原来既是页面顶上的一条横幅，也是机型徽标的悬停
  提示。四个目录一起删掉。
- 替代它的是**设备下拉旁边那个真正的圆点**（`[data-device-status-dot]`，绿=在线、灰=离线/未知）。
  `UNKNOWN` 归灰：绿点会被读成"它在工作"，而"没读到"不是"在工作"（与 `channelState()` 拒绝把
  未知当已启用同一条规矩）。
- 下拉里每一项前面还有 `●`/`○` —— **原生 `<option>` 没有办法上色**，这是"逐项都能区分在线与否"
  的唯一写法。要彩色的逐项圆点，得把下拉换成自绘列表（相机墙那个选择器已经是这个形状）。
  这一条**留给业主确认**（写在 `docs/UI-VERIFY.md` DD 段"要你看的"里）。
- **出处**：业主第 19 条原话（"设备是否在线直接在选择设备时，通过绿点和灰点表示"）。

---

### 15.50 第 10 批（续）：设备管理页的扁平化、十列设备表与编辑设备（业主 2026-09-18）

三条来自业主第 10 批（2b / 8 / 9），加上第 7 条的列名同步。完整的逐条进度表在
`docs/UI-VERIFY.md` 的 DD 段。

#### 15.50.1 扁平化：这一页不要卡片，用线分区（第 2b 条）

设备表外壳从全应用共用的 `.table-wrap`（卡片：边框 + 圆角 + 底色）改成页内的
`.devices-table-flat`：**一条上边线 + 每行一条分隔线 + 一条下边线**，没有圆角、没有卡片底色。
`<table class="table">` 本身留着（表头吸顶、行分隔线、单元格内边距只有一处实现）。
左侧拓扑树那张卡片当时没动 —— 它在 §15.51 里整棵下架了。

#### 15.50.2 设备表的十列（第 8 条；**推翻了 2026-09-17 的八列**）

业主 2026-09-17 给过一份八列清单（设备名称 / 设备IP / 设备类型 / 是否在线 / 告警数量 /
设备通道 / 查看 / 配置），2026-09-18 第 8 条重给了十列：
**序号 / 设备名称 / IP地址 / 设备类型 / 状态 / 告警数量 / 通道数 / 查看 / 设置 / 删除**。
差别：多了「序号」；三列改了字；「配置」拆成「设置」与「删除」两个**图标**列。

两条我们自己的判断：

- **行末的 `⋮` 菜单删掉**。它原来装着"编辑"与"删除"，而这两件事现在各有一列 ——
  同一件事两个入口是这仓库一贯反对的形态。设备改名与凭据修改都进了「设置」（编辑对话框）。
- **"详情/配置页"的入口挂在设备名上**（点名字 → `/devices/:id`）。列清单里没有"详情"这一列，
  但那个页面装着通道配置、告警策略、维护与升级 —— 功能不能在换列的时候消失；
  名字是可点的那一个（带 `title`、键盘可达、hover 变橙加下划线）。
  通道改名也仍然在（详情页的「通道与采样率」表里逐行可改），所以第 4 条把拓扑树拿掉时
  **不会丢掉任何能力**。

**布局的一条实测结论**：十列在 1280×720 下放不下 —— 几何探针第一次跑就报"删除图标被裁掉"
与"内容区横向溢出 1068/1048"。改法：这一页的单元格左右内边距收到 `--space-2`，
设备名与 IP 两列允许省略号截断（全文都在悬停里），「通道数」列只留数字、明细进悬停。

#### 15.50.3 编辑设备：**省略即不动**的凭据写回（第 9 条）

- 界面：显示名称可改；**IP 只读**（`readonly` + 灰底 + 说明句）；IP 与 HTTP 端口同一行；
  用户名与密码同一行、密码框旁一个眼睛按钮（默认隐藏）；经度与纬度同一行（方位角跟在后面）。
- **后端**：`UpdateDeviceInput` 新增可选的 `username` / `password`，`DeviceService.update()` 里
  写进凭据库（OS keyring，按本地设备 id）并**丢掉那台设备缓存的运行时客户端**。
  三条判断值得留档：
  1. **省略 = 不动**：界面从不回显口令，所以空框必须读成"不改"，否则改一次端口就会把口令清掉；
  2. **用户名给了就必须非空**（设备侧没有匿名账号）；空串按"没给"处理；
  3. **凭据变了必须丢缓存会话**：不丢的话后面的请求继续用旧 token，界面显示"改成功了"
     而设备看到的还是旧账号 —— 那正是本仓库最不能接受的"界面说假话"。
- **渲染层拿不到凭据**（spec 14.1 的既有决定：口令只在主进程），所以两个框**都不回显**，
  占位文字是「留空 = 不修改」。**没有**当场验证新口令能不能连上：写完之后由下一次健康检查去试
  （记在 UI-VERIFY 的"没验证"里）。
- **出处**：业主第 9 条原话（逐字给的版式要求）。

#### 15.50.4 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；单测 **1943 / 0 失败**（这个数字后来被
§15.51.5 更正为 1901 —— 它当时把 `.test-build/` 里两份悬空用例也算进去了）；i18n 缺失键 0、
四语言键集一致、孤儿键 0；`electron-vite build` exit 0；
GUI 探针 `demo-shot --with-data` **0 problems**（表头十列、扁平外壳、序号 1/2/3、三个图标列、
IP 只读、三行版式、密码显示切换、单击/双击 IP 的行为，以及四档窗口尺寸下没有裁切与横向溢出）。

### 15.51 第 10 批（再续）：设备管理移除拓扑树、添加设备进标题栏（业主 2026-09-18 第 4 条）

#### 15.51.1 业主原话与它推翻了什么

> 「移除左侧拓扑树，添加设备进标题栏。」

这一条**推翻了两条更早的要求**，所以两条旧断言必须一起改（不是删）：

| 更早的要求 | 当时落到哪 | 现在 |
|---|---|---|
| 业主 2026-09-16：「新增入口属于左侧拓扑树那一栏（参考 ThingsBoard）」 | 「添加设备」挂在树头 | 入口在**顶栏**那一格 |
| 业主 2026-09-17 第 3 条：「左侧一个设备拓扑树，左侧间距和高度间距和总览的改动后的保持一致」 | 两列网格（树 220–280px + 设备表） | **单列**，设备表铺满内容宽度 |

`docs/UI-VERIFY.md` 的 DD 段里第 4 条现在标 ✅；这两条旧口径按"被更新的要求覆盖"处理，
旧断言改成新口径，没有留下"两种说法都在"的状态。

#### 15.51.2 拆掉了什么（含**没有**丢的能力）

- 删文件：`components/DeviceTree.vue`、`stores/deviceTree.ts`、`lib/deviceTree.ts`、
  `components/DeviceRenameDialog.vue`、`tests/device-tree.test.ts`。
- 删 CSS：`.devices-layout`（两列网格与它的 900px 断点）、`.devices-topology`、`.devices-main`
  三条规则一并删掉 —— 留一条没人用的规则，下一个人会顺着它把两列拼回来。
- 删目录键：`deviceTreeUi.*` 与 `deviceRename.*` 两组**四种语言全部删除**。
- **没有丢的能力**（这是这一条最要紧的核对项）：
  - 树的展开/折叠/搜索/拖拽与"双击放进视频墙"**随树一起去掉**了 —— 那些是树自己的交互，
    能力本身（看实时画面、放视频墙）在实时监测页的顶栏下拉与相机墙里都还在；
  - **设备改名**在设备详情页（`config.setDeviceName`），**通道改名**在通道配置里
    （`config.updateChannel`），两条都在 §15.50.2 里记过 —— 所以拿掉树不是拿掉功能。
    两处都由源码守卫钉住（`tests/devices-round.test.ts` 的"改名能力仍然有落点"一节）。

#### 15.51.3 改名的**落点**：一条路径消失了，另一条被写清楚

树在的时候，右键菜单那条改名路径是「**先写本机数据库、再写设备**」，设备侧失败时要用同名写入
把本机改回原名（那份守卫原来叫 `tests/rename-rollback.test.ts`）。树一下架，那条路径**不存在了**：

    设备详情页改名：config.setDeviceName() → 主进程写完设备后 getInfo() 刷新缓存名 → devices.load()

也就是**设备侧是唯一真相，本机那份名字是读回来的**。所以守卫改写成新性质（文件改名
`tests/device-rename.test.ts`）：设备详情页**不许**出现 `devices.update(`（一旦出现，本机名就能
在设备拒绝之后留在新名字上 —— 界面替设备说了一句它没说过的话），失败分支里不许有任何写入，
成功之后必须 `devices.load()`。

**这是一次"守卫跟着实现改"，必须说出来**：旧守卫守的那条路径是**删掉了**，不是"改成绿的"。

#### 15.51.4 「添加设备」为什么放在 `.page` 的第一个子节点

投到 `#topbar-page-slot`（顶栏里标题与右侧指示器之间那一格，`flex: 1 1 50%`），
在那一格里靠右（`margin-left: auto`），紧挨着设备数量/在线/告警三个指示器。
它**不跟设备表一起 `v-if`**：新装的机器一台设备都没有，而空列表那一屏唯一的动作就是"添加设备"。
只有管理员看得到这颗按钮（与删除列同一条口径，主进程另有一次鉴权）。

#### 15.51.5 顺手修掉的验证工具缺陷（决定了上面所有数字可不可信）

`npm run test:build` 原来不清 `.test-build/`，而 `tsc` 不删"源文件已不存在"的旧产物 ——
于是**删掉的测试还在跑，而且还在绿**：它 import 的是 `.test-build/src/` 里那份同样过期的编译产物。
实测证据：删掉 `lib/deviceTree.ts` 与 `tests/device-tree.test.ts` 之后，旧的
`device-tree.test.js` 仍报 **35 通过**（验证的是一份已经不存在的实现）。
修法：`scripts/clean-test-build.cjs` 接到 `test:build` 最前面。修完同一批是 **1901 / 0 失败**，
少的 42 个正是那些悬空用例。**这一条不改界面，但它决定了"单测全绿"这句话有没有意义。**

#### 15.51.6 出处与我们自己的判断

- **出处**：业主 2026-09-18 第 4 条原话（逐字：「移除左侧拓扑树，添加设备进标题栏」）；
  「添加设备」的落点在顶栏（业主说的是"标题栏"，本仓库的标题栏就是顶栏那一行）。
- **我们自己的判断**（手册与业主都没说）：
  1. 按钮在那一格里**靠右**（贴指示器），而不是贴标题 —— 它与"这一屏能加设备"这件事、
     与设备数量/在线/告警是同一组动作；
  2. **入口不受设备数量影响**（空列表时也在，且是 `.page` 的第一个子节点）；
  3. 树自己的交互（展开/折叠/搜索/拖拽）**不迁移到别处**：它们是树这个形态的交互，
     在单列表格上没有对应物，业主这 24 条里也没有要求它们；
  4. 那五个文件与两组目录键**真删**，不留空壳组件、不留没人用的键。
- **`docs/reference/` 里没有一条要求涉及拓扑树**，所以这一条全部出自业主原话 + 上面四条判断。

#### 15.51.7 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；单测 **1901 / 0 失败**（干净重建之后）；
i18n 缺失键 0、四语言键集一致、孤儿键 0；`electron-vite build` exit 0；
GUI 探针 `demo-shot --with-data` **0 problems**（树下架、表是 `.page` 的直接子节点、
左右贴住内容盒、四档尺寸下十列放得下且无裁切、顶栏那颗按钮的 `data-action` 与所在格子）。
逐项实测数字见 `docs/UI-VERIFY.md` DD 段"第 3 轮的验证数字"。

### 15.52 第 10 批（五续）：「点位图」→「地图信息（GIS）」，并挪到设备管理之上（第 12 条）

#### 15.52.1 业主原话

> 「『点位图』改名『地图信息（GIS）』并移到设备管理上方、总览下方。」

两句都是业主给的，**没有**一条来自 `docs/reference/`（那一份手册里没有涉及地图的条目）。

#### 15.52.2 落的四处改动

| 位置 | 改前 | 改后 |
|---|---|---|
| 四本目录的 `app.nav.map` | 点位图 / Device map / Mapa de dispositivos / Cihaz haritası | **地图信息（GIS）** / Map information (GIS) / Información de mapas (GIS) / Harita bilgileri (GIS) |
| 侧栏 `NAV_ITEMS` | 设备管理 → 点位图 → 实时监测 | 总览 → **地图信息（GIS）** → 设备管理 → … |
| 路由表 | `/devices` 之后才是 `/map` | `/map` 排在 `/` 与 `/devices` 之间（与侧栏同序，读代码时不会再以为顺序反了） |
| 页面面板标题 | `mapUi.mapTitle`（「设备点位图」）| 复用 `t('app.nav.map')` |

**路由路径没改**（还是 `/map`）：路径是书签、既有探针与文档里到处引用的稳定标识，
这一条改的是**标签**。

#### 15.52.3 顺手消掉的一处重复名字（我们自己的判断）

改名之后，同一句名字会同时出现在**顶栏**（`meta.titleKey`）、**侧栏**、**页面面板标题**三处。
三处各有一个键就是三份会各自漂移的文案，所以面板标题改成复用 `app.nav.map`。
原来那个 `mapUi.mapTitle` 没有删掉，而是**换成了 `mapUi.canvasLabel`**：
它现在只当那张 SVG 的**无障碍名**，值也改了（「设备落点图」/ "Device positions" /
"Posiciones de los equipos" / "Cihaz konumları"）—— 无障碍名要说的是"这块画的是什么"，
不是"这一页叫什么"。这一处**是我们自己定的**（业主没提无障碍名）。

#### 15.52.4 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；单测 **1902 / 0 失败**；i18n 缺失键 0、
四语言键集一致、孤儿键 0；`electron-vite build` exit 0；GUI 探针 **0 problems**。
新增的守卫在 `tests/ptz-map-round.test.ts`：侧栏与路由表都是"总览 → 地图信息（GIS） → 设备管理"、
面板标题复用 `app.nav.map`、视图里不再出现 `mapUi.mapTitle`、四语言的名字里都带 GIS。
探针那边断言的是侧栏前三项的**路径**（`["/", "/map", "/devices"]`）与 `/map` 标签里带 GIS。
> 这两条探针断言第一次跑误报了两条"问题"：`href` 在 hash 路由下是 `#/map`。
> 实测侧栏顺序与名字都是对的，**红的是探针**；加 `replace(/^#/, "")` 之后重跑通过。

**这一轮还改了探针的等待方式**（不是界面，但它决定了报告可不可信）：修完上面那两条断言之后
连着重跑两次都不是 0 problems，而两次的问题各不相同（一次在实时监测/趋势/事件中心，
一次在设备表单列几何），**没有一条是真的** —— 病根是这台机器上那个不是本项目的
`node` 进程常驻吃 CPU，`layout()` 里固定的 `await sleep(1200)` 在那种负载下不够。
现在 `layout()` 先**等这一页的根节点真的出现**（`.app-content` 里出现 `.page`，最多 20 秒），
再等那 1200ms；判据选"根节点"而不是"文字"（一句"加载中…"也会让文字非空）。
重跑：**0 problems，exit 0**。出处：我们自己的判断（探针的等待时间与断言一样是判据的一部分）。

#### 15.52.5 还没做的（第 13–17 条里剩下的；不要按已完成验收）

第 12 条那一轮只改了名字与位置（版面当时还是"左边地图 + 右边详情卡片"）。
**第 13 条的版面、第 14 条、第 17 条已在 §15.53 做完**，这一节现在只剩：

- 第 13 条的**后半**：底图要能自配 **GIS 服务或平面图**（现在只有我们自己画的经纬度网格）；
- 第 15、16 条：相机与声纹设备**悬停显示基本信息与当前视频流、有告警显示告警、双击进详情**
  （双击已经能进详情了 —— 设备列表那一行；悬停浮层还没做）。

### 15.53 第 10 批（六续）：GIS 页的版面、落点配色与地图下方三张列表（第 13 条版面 / 第 14 条 / 第 17 条）

#### 15.53.1 版面：16:9 占满宽度地图区，下方依次三张列表

```
┌──────────────────────────────────────────────────────────┐
│ 地图信息（GIS）        图上 N 台 / 共 M 台                 │
│ ● 有未确认告警 n   ● 在线 n   ● 离线 n      ← 图例        │
│ ┌──────────────────────────────────────────────────────┐ │
│ │                   16 : 9  画布                        │ │
│ └──────────────────────────────────────────────────────┘ │
│ 未录入点位的设备（k 台）：…                                │
├──────────────────────────────────────────────────────────┤
│ 设备列表（名称/类型/状态/点位/未确认告警）                  │
├──────────────────────────────────────────────────────────┤
│ 告警列表（选中设备：X）＋ 配置/查看/同步告警 ＋ 抓图         │
├──────────────────────────────────────────────────────────┤
│ 实时数据列表（名称/分贝/稳定度/方位）                       │
└──────────────────────────────────────────────────────────┘
```

**「右侧」这个字的读法（我们自己的判断）**：业主原话是「GIS 页**右侧** 16:9 占满宽度地图区」。
这一页**没有左栏**，所以"右侧"只能读成"内容区里那一块主区域"：地图占满整宽、按 16:9 定高。
这与第 17 条的"地图下方依次…"是同一种版面；而"左边一列 + 右边地图"与"下方三张列表"
合不到一起。**若业主要的是左栏版式，改的是这一段。**

三条实现上的取舍：

1. **两处比例必须一致**：画布的逻辑尺寸也改成 16:9（1280×720，原来 760×460），定比例的那一层
   用 `aspect-ratio: 16 / 9`。不一致时 SVG 会按 `preserveAspectRatio` 留白，图上出现两条
   看不懂的边 —— 而那在屏幕上只是"图看起来扁了一点"。
2. **地图区不是卡片**：`.card` 的左右内边距会让图各缩进 16px。实测第一版左右各空 **17px**
   （内边距 + 边框），改成扁平段（上下各一条线）之后是 **0 / 0**。下面三张列表仍是卡片 ——
   业主点名要扁平化的只有设备管理那张表，别的既有口径不在这一条里动。
3. **没有 `max-height`**：加了它，窗口一矮这个盒子就不再是 16:9。代价是页面变长、需要滚动。

#### 15.53.2 落点配色（第 14 条）与一条**我们定的**优先级

在线**绿**（`--color-success`）/ 有告警**红**（`--color-danger`）/ 离线**灰**
（`--color-text-tertiary`）。三档在**同一台设备上可能同时成立**（离线的设备也可能有未确认告警），
所以必须定优先级 —— 我们定的是 **告警 > 在线 > 离线**：这台设备有事，比"它现在连不上"更要紧，
而灰色不传达任何紧迫性。

- `UNKNOWN`（还没探活过）算**灰**不算绿：绿点会被读成"它在工作"，那是界面在说一件没被证实的事
  （与第 19 条那个设备下拉旁边的小圆点同一条口径）。
- **读不到告警数时不当告警**（`-1` = 那一次 IPC 失败，`0` = 真的没有）：不能因为一次查询失败
  就把整张图染红。
- **颜色不单独承载信息**：图例三档各带一个数，设备列表与实时数据列表每一行也有同一个色点
  （两处都用同一个 `markerTone()`，不是各判一次）。色觉差异下这张图仍然读得出来。

#### 15.53.3 地图下方三张列表（第 17 条）

| 列表 | 列 | 交互 |
|---|---|---|
| 设备列表 | 名称 / 类型 / 状态 / 点位 / **未确认告警数** | 单击选中（地图标记同步高亮）、**双击进详情** |
| 告警列表 | 选中设备的告警（时间 / 声压级 / 有无抓图）＋ 抓图 | 点一条看抓图；「同步告警」在这里 |
| 实时数据列表 | 名称 / **分贝** / **稳定度** / **方位** | 只读 |

**旧右侧详情卡片里的东西一件没丢**（状态徽标、点位、方位角、配置、查看、同步告警、
告警列表、抓图三态、声呐说明）—— 全部搬进这三张列表里。

**分贝与方位的出处**（这两列有真实来源，必须写清楚）：
- 分贝 = 该设备**最近一条告警上报的声压级**（`AlarmEvent.spl`）；没有告警时「—」。
- 方位 = **录入的方位角**（`installation.azimuthDeg`）。空气声呐实时帧里的 `energyAzimuth`
  是"当前帧声源朝哪"，与"这台设备装成什么朝向"是两件事，那一项属于实时监测页的能量点表。

#### 15.53.4 「稳定度」那一列：**手册未说明**，而它只能显示「—」

业主第 17 条给的第三列是「稳定度」。前两列与第四列都有真实来源，**这一列没有**：

- `docs/reference/` 里**没有**"稳定度"这个量 —— **手册未说明**；
- 本仓库里唯一的"稳定性"是告警规则里的一个**阈值设置**（`device-config.ts` 的
  `splStabilityThreshold`），那是"超过多少算异常"的**判据**，不是读数；
- 另一个真实存在的测量值叫**平滑度**（`AlarmEvent.smoothness`，界面标签 `metrics.smoothness`），
  它与"稳定度"**不是同一个量**，所以**没有拿它顶替** —— 那会是编造。

所以这一列留着（业主给了这一列），值恒为「—」，并在表头上挂一句说明
（`mapUi.stabilityNoSourceHint`，四语言都有）。**这一条同时是一次用词提醒**：
业主在这一条里写「稳定度」、在 2026-09-18 追加的趋势要求里写「平稳度」、而仓库里这个量
一直叫「平滑度」—— 三个词；本轮**没有改**任何既有标签，等业主给一句话再统一。

#### 15.53.5 出处

- **第 13 条的版面、第 14 条、第 17 条**：业主 2026-09-18 第 10 批原话。
- **我们自己的判断**（业主与手册都没有）：① "右侧"读成"内容区主区域"；② 优先级
  告警 > 在线 > 离线；③ `UNKNOWN` 归灰；④ 地图区改成扁平段（去掉卡片内边距）；
  ⑤ 三张列表的列清单（业主只给了三个列表名）；⑥ 分贝与方位各自的出处。
- **手册未说明**：「稳定度」这个量。

#### 15.53.6 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；单测 **1915 / 0 失败**；i18n 缺失键 0、
四语言键集一致、孤儿键 0；`electron-vite build` exit 0；GUI 探针 **0 problems**。
实测：地图区宽高比 **1.7778**、左右到内容盒 **0/0**、宽 1150 = 内容盒 1150；
三张列表纵坐标 1015 < 1300 < 1426 且都在地图区（top 197）之下；实时列表表头四列、
行数 = 设备行数、「稳定度」列逐行 `—`；图例 `alarm 1 / online 1 / offline 0` 合计 **2**
= 图上标记数 **2**；声呐那一台自己的色调是 `online`。
> 探针位置踩过一次：新版面探针一开始跟在声呐那条**写设备**的流程后面，触发了本仓库
> "写操作的探针必须排在所有只读探针之后"的反面守卫（"5 次 layout"）。修法是把探针**移到**
> 只读区，而不是放宽守卫。移过去之后它在 operator 库上量到 `markerCount: 0`（那三台都没录
> 点位），所以**色调的真凭据放在声呐那一台加进来之后**（读它自己的 `data-marker-tone`
> 与图例三档的合计）—— 否则那一组断言是空过的。

### 15.54 追加要求：趋势页的多通道叠加与多量并排（业主 2026-09-18）

#### 15.54.1 业主原话（它不在这 24 条里）

> 「对于 2 通道，和八通道的设备，应该支持 平稳度，声压级，频带能量比，奇偶次谐波能量比这些数值的
> 趋势变化的同时显示，用不同颜色的折线将多个通道的信号显示在同一个坐标轴上，只是通过点击通道名称
> 实现是显示这个通道还是隐藏这个通道。」

#### 15.54.2 两句话里各有一半，读法要写清楚

这句话有两个"同时"要分开落：

| 业主的话 | 落在哪 | 为什么 |
|---|---|---|
| 「**多个通道**的信号显示在**同一个坐标轴**上，用不同颜色的折线」 | 一张图里：每条通道一条折线，颜色不同，共用一根 Y 轴 | 同一台设备的各通道是**同一个量的同一批测量**，共用刻度是对的 |
| 「这些数值（四个量）的趋势变化的**同时显示**」 | 页面上：每个选中的量**各一张图**，并排 | 四个量里只有声压级是 dB，另外三个是无量纲比值 —— 共用一根轴时两条线的高低关系是刻度造出来的 |
| 「只是通过**点击通道名称**实现是显示这个通道还是隐藏这个通道」 | 通道图例：一排可点亮的通道名，点一下隐藏 | **唯一**的通道入口（原来那个下拉框删掉了，两种入口是这仓库一贯反对的形态） |

**这两条一起读才是完整的**：量多选、通道多选，两者不共用一根轴。

#### 15.54.3 通道配色（**我们定的**，业主只说了"不同颜色"）

`TREND_CHANNEL_COLORS`（8 色）+ `trendChannelColor(index)`，放在 `src/shared/domain/trend.ts`：
它是**纯值、没有依赖**，而单测编译的是 `src/shared/** + tests/**`、编译不到 `src/renderer/**` ——
放在渲染层就只能靠"读源码字符串"断言，放在这里可以真的 import 进来测（循环、去重、不用状态色）。

三条规矩：
1. **不用红/绿**（`#b91c1c` / `#12b76a` 那一档状态色）：它们在这套界面里表示"告警/在线"，
   拿来区分通道会让一条红色的线看起来像"这条通道有故障"；
2. **第一色是品牌橙** `#FF6A1A`：与单条曲线原来的颜色一致，只看一条通道时颜色不该变；
3. **顺序固定、超出循环**：同一条通道两次打开之间颜色不变；16 通道的 SN-16 会循环到第二轮，
   但图例每条都带通道号，仍然分得清。

#### 15.54.4 「点通道名不查库」是一条**实测**的性质，不是实现细节

数据在**查询时**就把该设备的每条通道都取回来了（`channelIds` 的循环，不是 `visibleChannelIds`），
所以点亮/点灭只改"画不画它"。这不是为了快，而是为了**正确**：如果点一下要重新查，那么连点几下就会
把一串 DuckDB 扫描排进队列，而界面看起来完全正常 —— 只是每次点击都越来越慢。

实测证据：诊断行「本次查询条数」在点通道名前后都是 **8**（= 1 个量 × 8 条通道）。
这个诊断数字本身也是这一轮加的：一次筛选变更会打出 `量 × 通道` 条 IPC，看不见它就没人知道慢在哪。

#### 15.54.5 两个下限（**我们定的**）

**至少留一个量、至少留一条通道**。全关掉之后图上什么都没有，而"空图"看起来像"这个设备没有历史
数据" —— 那是界面在说一句错话（与"空的桶画成 0"是同一类错误的另一面）。两个下限都只在 store 里
判一次，视图只把结果画出来。

#### 15.54.6 用词：三个词指的很可能是同一个量

业主在这一条里写**平稳度**、在第 17 条（地图页的实时数据列表）里写**稳定度**、而仓库里这个量
从第一版起就叫**平滑度**（`metrics.smoothness`，设备上报的 `smoothness`）。
这一轮**没有改**任何既有标签：改一个标签会同时改告警记录、实时监测、历史趋势三处，
而这需要业主先给一句话说清是不是同一个量。这一条记在 `docs/UI-VERIFY.md` 的"没验证"清单里。

#### 15.54.7 出处

- **业主 2026-09-18 的追加原话**（上面 §15.54.1 逐字）。
- `docs/reference/` 里没有关于趋势图多通道显示的条目 —— 这一条全部出自业主原话 + 我们自己的判断。
- **我们自己的判断**：① 量多选、每量一图；② 通道配色三条规矩；③ 两个下限；
  ④ 通道下拉框删掉（只留通道名这一种入口）；⑤ 诊断行显示查询条数。

#### 15.54.8 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；单测 **1935 / 0 失败**（新增
`tests/trend-channels.test.ts` 20 条）；i18n 缺失键 0、四语言键集一致、孤儿键 0；
`electron-vite build` exit 0；GUI 探针 **0 problems**。
趋势页实测（AE08，8 通道）：图例 **8** 条、量的按钮 **7** 个、点第 2 条通道后只有它变 `false`、
诊断行 **8 → 8**（不查库）、恢复后全 `true`；多选第 2 个量后选中的是 `["spl","mainFrequency"]`
且**图从 1 张变 2 张**；图内提示行「声压级（平均） · dB · **8 条通道**」与图例一致。
> **诚实边界**：那段历史的 `返回点数 = 1`（只有一个时间桶），所以"8 条线叠在同一根轴上"是按
> **序列条数与提示行**验证的，不是看着多点重叠的折线验证的。要看到重叠曲线需要在有连续历史的
> 机器上再跑一次 —— 记在 `docs/UI-VERIFY.md` 的"没验证"里。

### 15.55 第 10 批（七续）：删掉「相机声学数据」窗口、数据默认实时接收；图谱改 16:9 各占 50%（第 22、23 条）

#### 15.55.1 第 22 条：窗口 → 一行状态

| 原来（一个"窗口"） | 现在 |
|---|---|
| 标题「相机声学数据」 | **删掉**（连目录键 `cameraStreamUi.title` 一起） |
| 状态徽标 | **保留**为一行状态（`.acam__status` / `[data-acam-state]`） |
| 「开始接收」按钮 | **删掉**（连目录键 `cameraStreamUi.start` 一起）—— 选中相机就自动开始 |
| 「停止接收」 | **保留**，只在接收中时出现 |
| 管理员说明 | 保留，只在**非管理员**时出现 |
| 握手方式那一条 | 挪成状态徽标的 `title` |

**为什么状态那一行必须留着**（这是我们顶回来的半个要求）：这一块的**每一张图**都会区分
「未启动 / 尚无数据 / 已停止」，而**空了的面板与安静的房间在屏幕上长得一模一样**。
删掉那一行之后，"流没起来"会被读成"环境很安静"——那正是这个仓库从第一版起就不允许的错。
删的是**窗口**（标题 + 开始按钮），不是"能不能看出流没起来"。

**为什么「停止接收」也留着**：默认开始之后，如果没有停的地方，操作员就没有任何办法关掉它。

**自动开始的两条判断**（都不是可选的）：
1. **先 `refreshState()` 再决定**：主进程可能还留着上一次访问时开的会话，不看就"再开一次"
   是重复订阅 —— 两套 socket 推同一路数据，而界面上完全看不出来；
2. **非管理员不自动开**：主进程对 `fa371Stream.start` 有角色检查。与其打一次注定失败的调用，
   不如把那一句「属于管理员操作」照实显示出来。

**一处语义要说清楚**：那枚徽标说的是**会话**（主进程的 socket 会话在不在），不是"数据在流"。
相机离线时它也可能显示「接收中」，而每张图各自显示「尚无数据 / 数据已停止」——真相在那几张图上。
这是既有语义，这一轮没改。

#### 15.55.2 第 23 条的版面那一半：16:9 各占 50%

五张图**仍然是五张**，排法从"一排五张"（⑧，2026-09-17）改成 **2 + 1 + 2**：

```
┌──────────────────────────┬──────────────────────────┐
│ 声纹图   （16:9, 50%）   │ 频谱     （16:9, 50%）   │
├──────────────────────────┴──────────────────────────┤
│ 音频时域 / 时域波形图（整幅宽）                       │
├──────────────────────────┬──────────────────────────┤
│ 能量点（表）             │ 检测结果（列表）          │
└──────────────────────────┴──────────────────────────┘
```

- 16:9 那一层 `.acam__stage--ratio` **画布与空态共用**：空面板与有数据的面板一样大，
  数据来了页面不跳（原来是靠 `min-height: 240px` 做的 —— 一旦定比例，那个高度就失效）。
- 退化仍然**不由窗口宽度决定**（`auto-fit` 问的是这一排自己的宽度）：这是上一版踩过的坑，
  守卫保留。旧的"一排五张 + 最小列宽 190–210px"守卫**按新口径改写**，没有删。
- **出处**：业主第 24 条原话（「声纹图与频谱图 16:9 各占 50% 放在视频下方」）。
  「时域波形图」在仓库里已经存在（`/pcmData` 的包络图，标题「音频时域」），这一轮把它排到了
  声纹/频谱的下面。

#### 15.55.3 第 23 条的 PRPD 那一半：**还没做**，但手册里**有**

翻手册时找到一条以前没有记录在案的事实（**这一条值得单独留档**）：

| 出处 | 原话 |
|---|---|
| `docs/reference/api-workflow.txt` | 「PRPD Plot / **`/prpdData`** / int binary stream / **1 frame/s**」 |
| `docs/reference/fa371-detect-log-sample.json` | 一条检测记录里带 **`prpd_photo_name`**（`prpd_2026_09_15_17_55_55_655.jpg`） |
| `docs/reference/event-alarm-center-spec-v1.txt` | 「PD 类事件显示 PRPD；**50/60/16.7 Hz 与检测频段**」 |

也就是说：`/prpdData` 是**第六路 WebSocket**，而本仓库只接了五路
（fft / voiceprint / energy / pcm / detectFeedback）。所以 PRPD **不是"手册未说明"**，
而是一整条**还没接的数据通路**。

**为什么不在这一轮顺手接上**：手册只说 "int binary stream"，**没有给矩阵几何，也没有说相位参考
从哪来**（PRPD 的横轴是工频相位 0–360°）。这与 `/voiceprintData` 当初的情况一样 ——
手册未定义、要实测才知道形状。**这一轮界面上没有放任何占位窗口**：挂一个画不出来的图，
是在承诺一件我们做不到的事。这一条记在 `docs/UI-VERIFY.md` 的"没验证"里。

#### 15.55.4 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；单测 **1937 / 0 失败**；i18n 缺失键 0、
四语言键集一致、孤儿键 0；`electron-vite build` exit 0；GUI 探针 **0 problems**。
实测（1440×900，相机）：图谱 **5** 张、第一行 **2** 块、两块宽度 **[567, 567]**（面板 1150px）、
两块那一层宽高比 **[1.778, 1.778]**（16:9）、`acousticWindowPresent: false`、
「开始接收」按钮 **0** 个、状态行 **「数据流接收中」**（探针一次都没点）、
「停止接收」在、并排那一行横向溢出 **0**。
> **诚实边界**：探针里那台相机是**离线**的，所以验证到的是**会话自动起来了**，
> 不是"收到了帧"。相机上线后要看 `scripts/video-proof-driver.cjs` 那条真机流程。

### 15.56 第 10 批（八续）：相机播放器式控制条、音量记忆与翻转（第 20、21 条）

#### 15.56.1 第 21 条：控制条搬到画面下方

| 你要的动作 | 落成什么 | 依据 |
|---|---|---|
| 暂停 / 播放 | **暂停画面 / 播放画面** | 语义见 §15.56.2 |
| 录制 | 手动录像（开始/停止） | 既有动作 |
| 查看 | **查看（抓图）** | 你的「查看」在清单里只有"看一张定格的画面"可对应 |
| 回放 | 本机录像回放对话框 | 既有动作 |
| 告警配置 | 告警配置对话框 | 既有动作 |

另加一颗 **停止视频 / 重试**（原来那颗开始/停止按钮）—— 控制条里不能没有"关掉它"。

两条**我们自己定的**实现判断：

1. **原生 `controls` 关掉**。它自带一条控制条，而业主要的那六个动作它一个都没有
   （录制/抓图/回放/告警配置）：两条控制条并排会让用户点哪条都对、也都不对。
2. **「播放信息」从页面上删掉，但值不丢**：它变成状态徽标的悬停说明
   （已转发字节数 / 正在用哪个地址候选）。删的是"永久占一行的一段诊断"，
   出问题时它仍然是第一条线索 —— 这与 §15.18 删页面标题时"删的是屏幕上那一行，
   不是这个页面的身份"是同一条口径。

#### 15.56.2 「暂停画面」不是「暂停设备」（这一条必须写清楚）

这一路是主进程用 ffmpeg **转封装出来的实时流**：ffmpeg 与 RTSP 会话都在主进程，
渲染层没有、也不该有"暂停设备推流"这件事 —— 暂停它等于**停流**，那就不是暂停而是停止了。

所以这个按钮做的是 `video.pause()`：**冻住眼前这一帧**，再按一下从实时位置继续。
名字里带「画面」两个字就是为了不让它读成"设备停了"（与 §15.13 那条口径一致：
界面不能替设备说一句它没做过的事）。按钮上还加了一层降饱和的视觉信号 ——
静止的画面与"卡住的流"在屏幕上必须看得出来是两件事。

#### 15.56.3 第 20 条：音视频同步是"不拆开"的结果，不是我们做的

这一路的音视频在**同一个容器**里（主进程 ffmpeg 转封装出来的 H.264 + 音频），
所以同步是天然的：**没有代码**，只有"没有把两路拆开"这一个事实。
这一条写在这里，是因为"没有代码"这件事本身需要留档 —— 否则下一个人会去找那个不存在的同步逻辑。

#### 15.56.4 音量可调并记住

- 控制条右侧一个滑杆（0–100%），**按设备各记一份**：两台相机的拾音电平可以差很多
  （一台装机房、一台装车间），记成一个全局值会让"在 A 上刚刚好"把 B 变成爆音或听不见。
  键是 `hertzinno.cameraLive.volume.<设备 id>`，写在 `localStorage` ——
  与 `stores/channelWall.ts` / `composables/useLocale.ts` 同一条既有约定：
  **这是这台机器上这个人的看法，不是设备事实**。
- **取值一律先修再用**（`sanitiseCameraVolume()`，在 `shared/domain/camera-live-prefs.ts`）：
  一个 `NaN` 会让 `<video>.volume = NaN` 抛 `IndexSizeError`，表现是"画面起不来"而看不出原因。
  **静音（0）是用户的选择**，不许被当成"没记住"；空串按无效处理（`Number('')` 是 0，
  会让一次损坏的写入变成静音）。
- **自动起播那一遍一定是静音的**：浏览器的自动播放策略不允许带声音自动播，
  不静音的结果是 `play()` 被拒 → 画面永远不出来，而源码怎么看都是对的。
  "出声"由滑杆那一次手势决定；**记住的是音量值，不是"要不要出声"**。
- 没有画面时滑杆**禁用**并把原因写在 `title` 里：一个按下去什么都不会发生的滑杆比没有它更糟
  （与画面墙 `cameraWallUi.volumeNoPicture` 同一条口径）。

#### 15.56.5 翻转：三个独立开关，90° 必须配 9/16 的缩放

左右 / 上下 / 90° 是**三个独立开关**而不是一个枚举：左右 + 上下 + 90° 可以同时成立
（"左右翻转再转 90°"与"只转 90°"不是同一个画面），枚举会把组合丢掉。

**90° 那一档配 `scale(0.5625)`**：这一块的外框是 16:9，画面转 90° 之后是竖的，不缩就会两头裁掉。
0.5625 = 9/16 是**算出来的**：宽 `w`、高 `9w/16` 的框里放一个旋转 90° 的 `w × 9w/16` 矩形，
需要缩到 `min(w / (9w/16), (9w/16) / w) = 9/16`。裁剪在截图上看起来像"相机的视场变窄了"，
所以这个数不能试。

三个开关**没有持久化**（业主只要求"音量记住"）：翻转是"这一眼怎么看"，
与"这一路声音多大"不是同一类偏好。

#### 15.56.6 「选中即自动播放」与两条既有约束的冲突（**这一条要你一句话**）

`decideCameraAutoPlay()` 里有两条当时为避免"界面向设备反复重开流"定的约束：
**「一次进程一次尝试」**与**「手动停止优先」**。这一轮把自动起播也挂到了"换设备"那条路径上
（与挂载那条走同一份判定），但这两条约束**没有动**：

- 手动点过「停止视频」的相机，再选回来**不会**自动起播；
- 本进程已经为它尝试过一次的相机，再选回来**不会**自动起播。

也就是说：**"选中即自动播放"在每个相机每次进程的第一次选择上成立**，
在那两种情况下不成立（按一下重试即可）。业主这一条没有说要推翻那两条约束，
所以我们按"尽量满足、冲突处照实说"处理 —— **要改成无条件自动起播的话，一句话就改。**

#### 15.56.7 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；单测 **1956 / 0 失败**（新增
`tests/camera-player-round.test.ts` 19 条）；i18n 缺失键 0、四语言键集一致、孤儿键 0；
`electron-vite build` exit 0；GUI 探针 **0 problems**。
实测（1440×900，相机）：控制条顶边 **872** > 画面底边 **848**（确实在下方）、
控制条里 **10** 个控件（六个动作 + 音量 + 三个翻转）、页面上的「播放信息」**0** 处、
音量滑杆值 **60%** 且**禁用**（这台相机没有画面）、画面比例 **1.778**。
> **诚实边界**：那台相机离线，`<video>` 根本没渲染，所以"原生 `controls` 真的关掉了"
> 与"拖滑杆之后 `<video>.volume` 真的变了"只在源码守卫里，探针读数是 `null`
> （没有当成通过）。相机上线后要补量。

### 15.57 第 10 批（九续）：每次打开总览界面默认开启视频流（第 1 条）

#### 15.57.1 病根是**清空时机**，不是判定写错了

判定函数 `decideCameraAutoPlay()`（`shared/domain/camera-autoplay.ts`）本身**不要求**
"相机已经在工作"：设置开着 + 设备在线 + RTSP 不是已知坏的 → 它返回 `start`。
挡住这条要求的是它前面那道一次性守卫：

> `autoPlayAttempted` 活在模块作用域里，清空时机是**一次应用启动**。

于是**第一次进总览**起播过之后，**再进总览永远是「本次已经试过了」**，画面停着不动。
而"一次应用启动只试一次"这条守卫本身是有理由的（绝不进入重试循环），不能整条删掉。

#### 15.57.2 改法：清空时机挪到"进页面"，而且只清一位

| 函数 | 清什么 | 什么时候调 |
|---|---|---|
| `resetAutoPlayAttempts()`（**新增**） | 只清 `autoPlayAttempted` | 进入**总览画面墙**与**实时监测相机页**的 `onMounted` 里，排在自动起播那次调用**之前** |
| `resetAutoPlayGuards()`（原有） | 清全部（含"手动停止"） | 只在测试里模拟"一次新的应用启动" |

三条推理，缺一条这个改法就不成立：

1. **一次停留里仍然只有一次尝试** —— 清的是"上一次进页面试过了吗"，所以一次失败不会自转重试；
2. **`manualStopped` 绝不清** —— 操作员按过「停止视频」的东西，不该因为他换了一次页面就自己回来。
   这是与 `resetAutoPlayGuards()` 的**全部区别**，也是这一位必须单独存在的原因；
3. **已经知道 RTSP 关着的相机不会被反复撞** —— `rtspAvailability` 那一位在 store 里、按进程活着，
   所以"每次进页面"不会变成"每次去设备上撞一次"。

**同一个改法也用在实时监测的相机页**（第 20 条「选中即自动播放」）：上一轮我在文档里留了一处保留
（"手动停过/本进程试过的相机再选回来不会自动起播"），这一轮**解掉了** —— 现在只剩一条约束：
**手动停止优先**。

#### 15.57.3 出处

- **业主原话**：第 1 条「每次打开总览界面默认开启视频流」。
- **我们自己的判断**：① 挪清空时机而不是删守卫；② 只清 `autoPlayAttempted`、保留 `manualStopped`；
  ③ 两页同一条口径。三条都写在上面的推理里，理由是"守卫的**意图**是防重试循环，
  而不是防'用户再来一次'"。

#### 15.57.4 这一轮的验证 + 一处**量不到的边界**

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；单测 **1957 / 0 失败**；i18n 缺失键 0、
四语言键集一致、孤儿键 0；`electron-vite build` exit 0；GUI 探针 **0 problems**。
实测（总览页）：画面墙在、**4** 个格子、有相机那一格的状态词是
**「Acoustic Camera 设备离线 当前格」** —— 一个确定的事实，不是转圈的黑框。

> **"每次进总览都会去起一次流"这一半在这台机器上量不到**：探针里那台相机是**离线**的，
> 判定会在 `offline` 那一步就 skip（刻意的：连不上就不去占相机一条 RTSP 连接），
> 所以起流请求根本不会发出、日志里也不会有那一行。
> **相机上线后的验法**：连续进两次总览，数主进程日志里 `Camera live view requested` 的行数
> （应当 +2）；或者在设置里关掉「开机自动播放」再进一次（应当 +0）。

### 15.58 第 10 批（十续）：地图上的设备悬停浮层（第 15、16 条）

#### 15.58.1 一张浮层，两种设备

地图上每一个落点现在**悬停（或键盘聚焦）出一块浮层**：

| 行 | 相机（第 15 条） | 声纹设备（第 16 条） |
|---|---|---|
| 设备名 / 设备类型 / 状态 / IP 地址 | 有 | 有 |
| **当前视频流** | **有** | **没有**（它没有视频流） |
| 未确认告警 | 有 | 有（第 16 条没点名，但同一张图上两种设备各有各的说法只会更难读） |
| 双击进详情 | 有 | 有 |

- 「当前视频流」那一行的文字**复用**相机页的 `cameraLiveUi.status*`：同一次故障在浮层与
  相机页徽标上必须是**同一句话**。
- 告警那一行与图上落点的颜色**同源**（都用 `alarmFacts` 里那个未确认条数），所以红点与浮层
  不可能对不上；而"没读到"（`-1`）与"没有"（`0`）分开说 —— 与 §15.53.3 同一条口径。

#### 15.58.2 「当前视频流」为什么给的是**状态**，不是画面

业主第 15 条的原话是「悬停显示基本信息与**当前视频流**」。我们把它落成
**"当前视频流的状态"**（播放中 / 未启动 / RTSP 未启用 / 失败 + 诊断原文），
**浮层里不放 `<video>`**。理由是硬事实，不是省事：

> 主进程对**一台相机只有一条会话，而一条会话只有一个观看者**
> （`CameraLiveSession` 的 `res.write` 对象，见 `shared/domain/camera-autoplay.ts` 里
> `heldByAnotherPage` 的注释）。

悬停就去接管那条会话，会把**正在看这一路的人**的画面当场换掉 —— 一个鼠标划过就能踢掉
别人的画面。要真的"悬停出画面"，得先解决"一条会话一个观看者"这件事（那是主进程的会话模型，
不是界面的问题）。**这是我们的取舍，写在这里备查。**

#### 15.58.3 两条实现上的判断

1. **位置用百分比算**（`x / CANVAS.width`、`y / CANVAS.height`），不量盒子：标记坐标就在画布的
   逻辑坐标系里（1280×720），而定比例那一层与画布**恰好同比例**，所以百分比就是它在浮层坐标系
   里的位置。量 `getBoundingClientRect()` 要等一帧，缩放或滚动时会晚一拍。
2. **悬停与键盘焦点走同一套**（`@mouseenter`/`@focus`、`@mouseleave`/`@blur`）：标记本来就有
   `tabindex="0"`，键盘走到它上面时浮层也该出来。浮层本身 `pointer-events: none` ——
   它压在标记上，不这样鼠标会"离开"标记而闪。

#### 15.58.4 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；单测 **1964 / 0 失败**（新增 7 条）；i18n 缺失键 0、
四语言键集一致、孤儿键 0；`electron-vite build` exit 0；GUI 探针 **0 problems**。
实测（声呐那一台真的画在图上）：悬停后浮层**在**，上面的字是
「探针声呐 · 设备类型 听诊盒子 / SN-16 空气声呐 · 状态 在线 · 局域网 IP 地址 127.0.0.1 ·
未确认告警 没有未确认告警 · 双击进这一台的详情页。」；浮层里的 `<video>` **0** 个；
「当前视频流」那一行**不在**（声纹设备）；未确认告警行在、值 `0`；鼠标移开后浮层**关掉**。
> **诚实边界**：第 15 条里**相机**那一半（「当前视频流」真的显示了一台相机的状态）在这台机器上
> **量不到** —— operator 库那台相机没有录 GIS 点位，不在图上。那一行的条件渲染与取状态的 IPC
> 只有源码守卫。只读那一段探针**如实报了 skipped**（图上没有标记），没有把"没量到"当成通过。

### 15.59 第 10 批（十一续）：相机页的检测模式、告警信息与历史告警（第 24 条）

#### 15.59.1 一处**推翻了更早决定**的冲突（这一条必须留档）

第 24 条：「该页（相机页）支持**检测模式**、告警配置、告警信息与历史告警展示」。

其中「检测模式」与本批之前的 ⑨（**2026-09-17**）冲突：那一条把
「检测模式 / 应用模式 / 告警策略 / 维护 / 升级」**搬去了设备管理的配置界面**
（`DeviceDetailView` 的相机页签），实时监测页只留了「检测启停 + 应用场景」。

**第 24 条更晚，所以按它办**：`mode`（工作模式＝局放 / 气体泄漏 / 机械）回到了这一页。
**但设备详情页那几个页签一个都没删** —— `CameraControlPanel` 本来就按 `sections` 取用，
两处共享同一批 IPC 与同一套"读了要写回"的规矩（那个组件文件头写的就是这条理由：
两处各写一份迟早会不一致）。

**维护与升级没有跟着回来**：第 24 条没有要求它们，而它们改的是固件与重启 ——
留在设备详情页更合适。守卫里钉了"不许回到实时页"。

#### 15.59.2 四件事各自的落点

| 你要的 | 落点 |
|---|---|
| 检测模式 | 控制面板的「模式」那一段（`data-camera-panel="mode"`） |
| 告警配置 | 「告警配置」卡片 + 对话框（本来就在） |
| **告警信息** | 那张卡片里**就地列出这一台最近 10 条**（时间 / 声压级 / 有无抓图 / 设备原文），没有时一句空态 |
| **历史告警展示** | 「查看告警记录」带 **`?device=<这一台>`**；告警记录页认这个参数并**预置设备筛选** |

**历史告警那一条为什么算真做了**：原来那个链接指向**不筛任何设备**的 `/alarms` ——
一个从"这一台相机"出发的入口，落到全库列表上，操作员还得自己在下拉里再选一次。
现在 `AlarmsView` 在 `onMounted` 里读 `?device=` 并预置筛选，**只在设备真的存在时才用**
（一个过期的书签不该把列表筛成空的）。

#### 15.59.3 出处

- **业主原话**：第 24 条（上面逐字）。
- **冲突**：与 ⑨（2026-09-17）冲突，按更晚的那一条办，并保留设备详情页的入口。
- **我们自己的判断**：① 告警信息只列 10 条、超过就滚（那是"现在有没有事"的一眼，
  全量在告警记录页）；② `?device=` 要校验存在性；③ 维护/升级不回到这一页。

#### 15.59.4 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；单测 **1968 / 0 失败**；i18n 缺失键 0、
四语言键集一致、孤儿键 0；`electron-vite build` exit 0；GUI 探针 **0 problems**。
实测（相机页）：检测模式那一段**在**；告警信息那块**在**且给出了空态（这台相机在本机还没有告警）；
「查看告警记录」的地址是 `#/alarms?device=dev_0mu245lko009mavhew`；
**那条链的后半段**真的走了一趟 `/alarms?device=<id>` —— 设备筛选**已预置成这一台**
（下拉里 4 个选项，`value` 就是那个 id）。
> **旧守卫按新口径改写**：`tests/page-layout.test.ts` 里那条「实时监测页**只留**
> 「检测启停 + 应用场景」两块」钉的正是被推翻的那条决定，所以改写成
> 「按 sections 限定 + **包含**检测模式 + **不含**维护/升级」，不是删掉。

### 15.60 业主 2026-09-19 的五条更正（都推翻了更早的口径，逐条留档）

#### 15.60.1 地图页的名字：括号与 GIS 去掉（推翻 §15.52）

第 12 条（2026-09-18）业主自己给的名字是「地图信息（**GIS**）」，四个语言的目录都照抄了。
更正第 1 条（2026-09-19）说去掉括号和 GIS。**更晚的那一条更有效**，所以四种语言都改成
不带括号的形式（`地图信息` / `Map information` / `Información de mapas` / `Harita bilgileri`）。

留这一条的原因是：这是**同一件事被业主改过两次**，而两次都是业主的原话。
下一个人看到 §15.52 时不该以为那里写错了 —— 它是当时的正确记录。

#### 15.60.2 两个标题删掉**页内**那一个（更正第 2 条）

业主看到的是顶栏标题 + 页内 `<h3>` 两处「地图信息」。删的是**页内**那一个，理由有二：

1. 外层框架的标题栏写页面名是**全应用从 2026-09-16 起就有的口径**（§15.18：页面内不再画标题）；
2. 更正第 1 条刚刚要求**改**这个名字，说明名字本身要留着 —— 那么该走的是页内那一个。

名字没有丢：它成了地图区 `<section>` 的 `aria-label`（删掉标题之后，读屏走到这一块
只剩一串数字「图上 3 台 / 共 5 台」，那是这一段内容的身份，不能没有）。
**如果业主要删的是顶栏那一个**，那是另一件事（它会与其它页面的做法不一致），一句话就改。

#### 15.60.3 序号列居中 + 每一列一条浅色竖线（更正第 3 条）

- **序号列居中**：`.devices-table__index` 覆盖 `.devices-table__num` 的右对齐。
  序号是一位或两位的数字，右对齐时它与表格左边缘之间会空出一大块；居中让"第几台"读起来
  像一句话的开头。**告警数量/通道数仍然是右对齐**（数字列右对齐才读得成一列）。
- **列分隔线**：每条 `th`/`td` 的**左边**一条 `--color-border`（#e4e7ec）。
  三条取舍写在 `DevicesView.vue` 的注释里：
  ① 用 `--color-border` 而不是 `--color-border-strong`（业主说的是"浅一些"，而这一页的上下
  边线已经是 `--color-border`，竖线比它还重就会抢走横线）；② 只画左边（两侧会让相邻两列
  之间出现双线）；③ **第一列不画**（它左边是表格自己的边框，再画一条就是重影）。
  表头与表体都画，否则列线在表头处断开、看起来像两条列宽不同的表。

#### 15.60.4 页面里那 7 颗「刷新」删掉，顶栏那一颗成为唯一的刷新（更正第 4 条）

删掉的：设备详情、告警记录、事件中心、历史趋势、样本库各一颗，系统设置的「存储」页签两颗
（磁盘占用 / 趋势落盘计数）。

**`AppTopbar` 里本来就有一颗**（业主 2026-09-16：「大标题栏的刷新按钮中的文字删除，只需要保留图标」），
所以这不是"新增一个刷新"，而是**把重复的收成一顆**。它原来只刷新**设备状态**
（`devices.refreshStatus()`），**不刷新当前页面的数据** —— 所以直接删掉那 7 颗会让
"重读当前页"这件事没有入口。补法是 `stores/uiRefresh.ts`：

> 一个自增序号，顶栏刷新时 +1，页面 `watch` 它并按自己的方式重读。

**为什么不是事件总线**：那种做法要在卸载时注销，漏一次就是一片看不见的泄漏
（`MonitorView` 的文件头记着同类教训）。计数器只有一个数字，页面卸载时 watch 自动失效，
**没有需要手动清理的东西**。

系统设置的「存储」页签还多一条：**切到那个页签时重读一次**两个诊断读数 ——
那两个数会随时间变，删掉按钮之后若只在挂载时读一次，操作员切走再回来会看到一个
永远不会变的数字（比没有这个数更糟）。

#### 15.60.5 各页左上间距：量出来本来就是一致的（更正第 5 条）

业主说「每个分页面的布局，内容距离左侧和上侧应该是保持一致的」。逐页量了 **11 个页面**：

| 量的是什么 | 结果 |
|---|---|
| `.page` 相对 `.content` 内容盒的左侧/上侧偏移 | **11 页全部 0 / 0** |
| 第一块**内容**（含组件自己的内边距）的左上起点 | 0–17px，取决于组件家族：卡片 17、扁平设备表 0/1、地图区 0/17（改前是 0/13）、设置页签条 0/0、事件中心提示条 13/11 |

所以"页面容器对齐"这件事**本来就是成立的**；真正做得不一致的是地图区那一段的上内边距
（12px，比别页的卡片少 5px），这一轮提到了卡片那一档（16 + 1 = **17**）。
**左右仍然是 0** —— 那是第 13 条（16:9 占满内容宽度）要的，两条不冲突。

**没有做的那一半**：如果业主说的"内容距离"是**卡片里的文字**要逐一对齐，那还要动四个
组件家族的内边距（扁平表 0、地图区 0、页签条 12、提示条 12 → 全部 16）。那些是逐个被
业主认可过的设计值，所以先报数字、等一句话。

#### 15.60.6 这一轮的验证

`tsc node` / `vue-tsc` / `tsc tests` **0/0/0**；单测 **1968 / 0 失败**；i18n 缺失键 0、
四语言键集一致、孤儿键 0（`trendsUi.querying` 随那颗按钮一起删）；`electron-vite build` exit 0；
GUI 探针 **0 problems**。逐页实测：侧栏地图那一项 = 「地图信息」；11 页里"又写一遍页面名"
的标题 **0**、页面自己的「刷新」按钮 **0**；`.page` 偏移 **11 页全 0/0**；
序号列表头与单元格 `text-align` **center / center**；第二列左边 **0.67px / rgb(228,231,236)**、
第一列左边 **0px**、第二行第二列也是 0.67px；地图区上内边距 **13 → 17px**。

### 15.61 业主 2026-09-19 的四条（二）：告警图标口径、用词、HTTP 推流 / MQTT 调研

#### 15.61.1 告警图标数的是**设备推来的告警**（第 2 条，已实现）

业主原话：「告警条目是指其他设备推送到来的告警都应该显示在右上方那个告警图标按钮上。」

**改动是换数据源**，不是加一个数字：

| | 原来 | 现在 |
|---|---|---|
| 角标数 | `linkage.unacknowledgedCount`（**联动引擎**的待处理项） | 告警表里 `acknowledged = false` 的 **total** |
| 面板列表 | 联动待处理 + 动作结果 | **新增「设备告警」一段**（逐条可确认）+ 联动那一段仍在 |

为什么这样分：联动记录说的是"**我们为这条告警做了什么**"（录像 / 抓帧 / 声光），
不是告警本身；而 `ALARM_SOURCES = ['fa8','e2']` 说明告警表里的行**全部**是设备推上来的
（相机检测日志是**事件**，在事件中心，不在告警表里）。所以"设备推来的告警" =
告警表里未确认的行，一个源、一份列表、一个数字。

**两条口径要记住**（都写在组件注释里）：
1. 角标读的是 `total`（可能远多于列出的 20 行），所以**角标数 ≠ 面板里 `.alarm-item` 的条数** ——
   面板里现在有**两段**列表，把两段加起来才是旧断言的读法。多出来的那一句
   「另有 N 条未列出（到「告警记录」看全部）」就是这件事的出口；
2. 读不到时**不动**上一次的数字与列表：把 IPC 失败显示成"没有告警"是这个仓库最反对的假话。

**相机检测日志仍然不在角标里**：它是事件（`eventCentre` 三路来源之一），事件中心有它自己的
列表。如果业主要它也在角标上，那是一次**口径合并**（事件与告警合数），需要他再说一句。

#### 15.61.2 用词：「平稳度」（第 4 条，已实现）

业主原话：「用平稳度表示。」——这一句解掉了 2026-09-18 起的三词歧义
（他先写「稳定度」、又在趋势要求里写「平稳度」、而仓库里这个量一直叫「平滑度」）。

- `metrics.smoothness` 四种语言都改成**平稳度**（en: Steadiness / es: Estabilidad / tr: Durağanlık）；
- 地图页「实时数据」那一列跟着改名，并且**不再是空列** —— 它取最近一条告警上报的
  `smoothness`，与分贝**同源同刻**；
- **`alarms.type.smoothness`（「平滑度异常」）不动**：它命名的是一种**告警条件**，不是这个量。
  守卫里专门钉了这一条，免得下次一起改掉；
- 「这一列没有数据源」（§15.53.4）那套说明**下架**：当时的判断没错（用词没定之前不拿别的量顶替），
  现在用词定了，那一列就有源了。

#### 15.61.3 HTTP 推流 / MQTT 的调研（第 1 条；**设计已定，代码下一轮**）

> **2026-09-19 补**：这里的设计**已经在第 14 轮实现**（见 §15.62 那张表与"没做的"清单）。
> 本节保留原样的调研结论与设计口径，实现与出入以 §15.62 为准。

业主原话：「HTTP 推流和 MQTT 是类似于 thingsboard 平台接 IOT 设备的逻辑，你去调研，然后开发。」

**调研结论（ThingsBoard 的设备侧接入方式）**：

| 面向 | ThingsBoard 的做法 | 出处 |
|---|---|---|
| HTTP 鉴权 | **access token 放在 URL 路径里**：`http(s)://HOST/api/v1/$ACCESS_TOKEN/telemetry`；`401` = token 无效 | [HTTP Device API Reference](https://thingsboard-github-io-51x.pages.dev/docs/reference/http-api/) |
| HTTP 载荷 | `{"key":"value"}`、`[{"k":"v"}]`，或带时间戳 `{"ts":1451649600512,"values":{…}}`（不带 ts 就用服务端时间） | 同上 |
| HTTP 属性 | 另有 `/api/v1/$ACCESS_TOKEN/attributes`（客户端属性上传 / 读取 / 订阅共享属性） | 同上 |
| MQTT 鉴权 | **access token 当用户名**（密码留空），连 broker 之后发布到 `v1/devices/me/telemetry` | [Access Token authentication for MQTT](https://thingsboard-github-io-51x.pages.dev/docs/paas/user-guide/access-token/) · [MQTT API](https://thingsboard.io/docs/edge/reference/apis-and-sdks/mqtt-api/) |
| 设备凭据 | 每台设备一条 access token，可在设备详情里查看 / 轮换 | [Provisioning - MQTT API](https://thingsboard.io/docs/paas/reference/mqtt-api/provisioning/#access-token) |

**我们的落法（本机是"平台"这一侧，设备是主动推上来的那一侧）**：

1. **HTTP 推流（第 6 条）**：主进程起一个**只监听回环之外可配地址**的 HTTP 服务，
   路径照 ThingsBoard 的形状：`POST /api/v1/<设备秘钥>/telemetry`；
   载荷接受 `{"k":"v"}`、`[{"k":"v"}]`、`{"ts":…,"values":{…}}` 三种；
   token 无效回 `401`，路径不对回 `404`（**逐条照抄它的语义**，这样能接现成的 ThingsBoard
   设备端固件/示例）。
2. **MQTT（第 7 条）**：同一个服务上开一个**最小 MQTT 3.1.1 broker**（`node:net`，
   不新增依赖）：CONNECT（用户名=秘钥）→ CONNACK → SUBSCRIBE / PUBLISH(v1/devices/me/telemetry)
   → PINGREQ/PINGRESP → DISCONNECT。QoS 0 先做（设备端绝大多数遥测是 QoS 0），
   QoS 1 的 PUBACK 也简单，QoS 2 明确**不做**（要四次握手与持久化，收益极低）。
3. **设备秘钥与推流地址（第 6 条原话「取设备秘钥与推流地址」）**：两者都在**添加/编辑设备**
   对话框里给出并可复制（秘钥可轮换），与 ThingsBoard"设备详情里看 token"同一件事。
4. **收到的数据落到哪**：走**已有的**写入路径 —— 时序量进 `TrendStorage`（历史趋势页立刻能看到），
   越过阈值的进告警表（于是第 2 条那条"设备推来的告警上角标"**自动**成立）。
   **不新开第二套存储**。
5. **离线优先不变**：服务默认**关闭**，在系统设置里开；绑定地址与端口可配；
   没有外网也能用（它是**入站**服务，不是联网取数）。

**这一轮为什么没有半成品**：HTTP 服务 + MQTT broker + 秘钥生命周期 + 数据落库 + 界面，
是一个完整功能的五块；只做其中一块进主分支，会是"界面上有推流地址，但没人接"那种承诺。

#### 15.61.4 视频墙四种视图 + **手填 RTSP 地址**（第 3 条）

业主原话：「②『能手填一个 RTSP 地址给第三方相机』」——这是 2026-09-18 第 2 条里
「支持 RTSP 主动取流」那半句的**读法确认**：不是"无条件主动去拉"，而是**给第三方相机
手填一个 RTSP 地址**。

所以第 2 条的完整口径是：视频墙每一格支持 **播放 / 1 秒时域图 / 频域图 / 时频谱图** 四种视图，
并且相机来源可以是**手填的 RTSP 地址**（第三方相机），不只是本应用管理的设备。
与四种视图一起做（两者都要动墙的格子模型），排在 HTTP/MQTT 之后。

### 15.62 HTTP 推流 / MQTT —— 已实现（2026-09-19 第 14 轮）

#### 15.62.1 我们做了什么（一张表）

| 块 | 实现 | 文件 |
|---|---|---|
| 纯规则（秘钥形状 / 载荷解析 / 键对照 / 配置归一化 / 地址拼装） | 32 位小写十六进制秘钥；三种载荷形状；七种固件字段名 + 驼峰；`channel_id`；`alarm_mask` | `src/shared/domain/iot-ingest.ts` |
| HTTP 接入 | `node:http`，`POST /api/v1/<秘钥>/telemetry`（401 / 404 / 400 / 413 / 405），`GET …/attributes` 回 `{}` | `src/main/services/ingest/iot-ingest-service.ts` |
| MQTT broker | `node:net` 上的最小 MQTT **3.1.1**：CONNECT（秘钥当用户名）→ CONNACK → PUBLISH(`v1/devices/me/telemetry`) → PUBACK(QoS 1) / PINGREQ / SUBSCRIBE / UNSUBSCRIBE / DISCONNECT；**QoS 2 明确不支持**（断开并记日志） | `…/mqtt-codec.ts` + `…/iot-ingest-service.ts` |
| 落库 | 认得出的量 → `TrendStorageService.append()`（与实时流同一条路）；带 `alarm_mask` 的行 → `AlarmRepository.insert()`（来源 `fa8`，去重照旧） | `…/telemetry-intake.ts` |
| 秘钥生命周期 | 按设备一条，首次读取时生成（写库 + **读回核对**）；可轮换（旧秘钥立刻失效）；唯一索引挡两台设备共用 | `devices.push_secret`（schema **v15**）+ `DeviceRepository.setPushSecret()` |
| 配置 | 设置里的 `iotIngest`（默认**关闭**、`0.0.0.0`、8080 / 1883）；改完立刻重起监听 | `SettingsService` + `IotIngestService.applyConfig()` |
| 界面 | 设置页第八个页签「数据接入」（开关 / 地址 / 端口 / 路径 / 主题 / 监听状态 / 收数统计 / 本机地址）；设备对话框里的「推流地址与秘钥」（可复制、可轮换） | `SettingsView.vue` + `DevicePushEndpoint.vue` |

#### 15.62.2 为什么是这个形状（业主原话与出处）

业主原话：「HTTP 推流和 MQTT 是类似于 thingsboard 平台接 IOT 设备的逻辑，你去调研，然后开发。」
调研结论与出处见上一节的表（ThingsBoard 的 access token 在 URL 路径里、MQTT 用 token 当用户名）。
**现场那台 FA8 声纹设备自己的 Push 配置就是这个形状** —— `GET /get_date_push` 实测回来的四个地址都是
`http://8.153.195.75:3000/api/v1/dt_<32 位十六进制>/telemetry`（`docs/PROTOCOL-FINDINGS.md` §3.9），
所以"接我们自己的设备"与"接第三方的 ThingsBoard 设备"是同一套接收端。

#### 15.62.3 我们**没有**做的（每一条都有理由）

| 没做 | 为什么 |
|---|---|
| 本机按门限判告警 | 门限在**设备端**的告警档位里，本机没有第二份。自己造一份会与「手册未说明的一律不编」冲突，也会与设备上的档位打架。所以只有载荷里带 `alarm_mask`（FA8 的位图词汇）才落告警 |
| 第三种告警来源 `source = 'iot'` | `alarms.source` 的 CHECK 只允许 `fa8` / `e2`（schema v9），加第三种要重建那张被索引与父表牵着的表；而这里并没有第二套告警词汇需要区分 |
| QoS 2 | 四次握手 + "已收到未释放"状态，收益为零（遥测重复一条没有后果）。**不假装支持** |
| MQTT 遗嘱 / 保留消息 / 会话持久化 | 我们从不给设备发消息，这三样没有落点 |
| 属性通道写入 | 没有客户端属性存储，`GET` 回 `{}` 是如实回答，`POST/PUT` 一律 404（不假装存下了） |
| TLS / 认证加固 | 现场固件只会明文；IP 白名单、速率限制、失败锁定都没做。**默认绑 `0.0.0.0`**（否则设备连不上），所以"局域网里谁能拿到秘钥谁就能写遥测" |
| 把推流地址**写进设备**（`PUT /set_date_push`） | 那是"写设备"，要读回逐字段核对，单独一轮做。现场现在要自己到设备 Web 界面上填地址 |

#### 15.62.4 实测（GUI 探针，2026-09-19）

- 默认关闭；打开之后两个监听都真的起来（HTTP 20528 / MQTT 33915，状态 `listening:true`）；
- 从探针进程发真 HTTP：200（不认识的键）/ 200 且 `trendRows:1`（认得出的键）/
  200 且 `alarmRows:1`（带 `alarm_mask`）/ **401**（秘钥不对）/ **404**（路径不对）；
- 发真 MQTT 字节：CONNECT 回 `20 02 00 00`；
- 页面上七个读数与主进程报的逐项一致（点顶栏刷新之后读到的）；
- 关掉之后两个监听都停、端口还原；
- 推来的那条告警进库了（未确认告警 201 → 202）。

### 15.63 「告警中心」与两档筛选（2026-09-19 第 15 轮）

业主原话三条（同一条消息里）：
1. 「告警记录修改为 告警中心」；
2. 「筛选的卡片放在最上面的」；
3. 「可以做一个简单筛选，和更多筛选内容的区分，更多筛选默认收起」。

#### 15.63.1 改名（四种语言 + 四处引用）

| 键 | 中文 | English | Español | Türkçe |
|---|---|---|---|---|
| `app.nav.alarms`（页面名） | 告警中心 | Alarm center | Centro de alarmas | Alarm merkezi |
| `cameraAlarmUi.goAlarmList`（相机页链接） | 查看告警中心 | Open the alarm center | Abrir el centro de alarmas | Alarm merkezini aç |
| `linkage.deviceAlarmsMore`（面板里那句"到…看全部"） | 到「告警中心」看全部 | see Alarm center for all | vea Centro de alarmas | tümü için Alarm merkezi |
| `domain.permissionScope.viewAlarms`（权限适用范围） | 告警中心、… | Alarm center, … | Centro de alarmas, … | Alarm merkezi, … |
| `samplesUi.empty`（样本库空态里提到的地方） | 可以在「告警中心」… | （en 本来就写 alarm list） | — | — |

`alarmsUi` 里那些讲**数据**的句子（`empty`「没有符合条件的告警记录」、`retention`「告警记录上限」、
`resetConfirmBody`、`restoreKeeps`…）**没有改**：它们说的是"告警记录"这种东西，不是这一页的名字。

#### 15.63.2 页面顺序

```
筛选卡（card，第一个块）
  ├─ 简单筛选：设备 / 告警等级 / 确认状态 ………… 一直显示
  └─ 更多筛选：开始时间 / 结束时间 / 通道 / 告警类型  默认收起（v-if）
计数 + 批量动作（.page-header：共 N 条 / 已选 M 条 / 确认 / 取消确认 / 加入样本库）
提示条 → 表格 → 分页 → 详情抽屉
```

「更多筛选」的开关是 `[data-action=toggle-alarm-filters]`，带 `aria-expanded` 与
`aria-controls="alarm-more-filters"`；收起时它显示生效项数（`alarmsUi.moreFiltersActive`）。

#### 15.63.3 顺手修掉的一个既有缺陷（探针抓到的）

`alarms.applyQuery(patch)` 是**合并补丁**（`{ ...query, ...patch }`），而 `AlarmsView.buildQuery()`
原来写成"有值才带上"。两者配合的结果是：**清空某一格筛选不会生效** —— 那一格根本不在补丁里，
上一次的值原样留在 store 的 query 上。受影响的六格：`severity` / `channelId` / `alarmType` /
`acknowledged` / `from` / `to`；「重置」按钮同样清不掉这六格（界面上看起来清空了，列表还是筛过的）。

现在 `buildQuery()` **每一格都显式给出**（清空 = `undefined`）。探针实测：把「开始时间」设成
2099 年 → 命中 0 条；清空 → 回到 200 条。判据写在 `tests/alarm-center-round.test.ts`
（"每一格必须显式进 query"）与 `tests/alarm-severity-ui.test.ts`（severity 那一格的写法）。

### 15.64 手填 RTSP 地址给第三方相机（2026-09-19 第 16 轮）

业主原话：「② 能手填一个 RTSP 地址给第三方相机」—— 这是第 10 批第 2 条「支持 RTSP 主动取流」
那半句的**读法确认**：不是"无条件主动去拉我们管理的设备"（那条路本来就走 `GET /system/video`），
而是给**第三方相机**手填地址。

| 块 | 实现 | 文件 |
|---|---|---|
| 纯规则 | id 形状（`rtsp:` + 32 位十六进制）、地址形状（只 `rtsp(s)://`）、口令打码、默认名字取主机名 | `src/shared/domain/rtsp-source.ts` |
| 主进程 | `RtspStreamService.startManual(sourceId, url)`：**与设备那条路分开**，复用同一套会话 / 并发预算 / 状态快照；`maskRtspUrl` 现在只有这一处定义（主进程那边重新导出） | `src/main/services/media/rtsp-stream.ts` |
| IPC | `camera-live:start` 的入参改成「`deviceId` 与 `url`+`sourceId` **恰好给一个**」，两个都给 / 都不给都拒 | `src/main/ipc/handlers.ts`、`src/shared/domain/camera-live.ts` |
| 墙的模型 | 手填源与设备**共用槽位**（`rtsp:` 前缀区分）；增 / 改 / 删 / 占格 / 规范化清悬空槽位 / 换档位不丢源 | `src/renderer/src/lib/cameraWall.ts` |
| store | `manualSources` + 四个动作；`syncDevices()` 跳过手填 id（否则一次设备列表刷新会把它们当已删设备清掉）；**不写盘**（地址常带口令） | `src/renderer/src/stores/liveWall.ts` |
| 界面 | 标题行「手填 RTSP 地址…」+ 对话框（表单 / 列表 / 改 / 删 / 放进当前格）；选择器列表里也列出已有手填源（后缀「手填 RTSP」） | `ManualRtspDialog.vue`、`CameraVideoWall.vue` |

**三条口径**：只判形状不判可达性（连不上时那一格显示 ffmpeg 的原文）；地址只在内存里；
它没有"设备离线"这个概念（状态只来自本机那一路会话）。

**实测**：见 `docs/UI-VERIFY.md` 第 16 轮 —— 其中探针抓到并修掉了一个真缺陷：
删掉手填源时没有停主进程那一路会话。

**还没做**：每格的 **4 种视图**（播放 / 1 秒时域图 / 频域图 / 时频谱图）在下 一轮。

### 15.65 视频墙的四种视图（2026-09-19 第 17 轮）

业主原话（2026-09-18 第 10 批第 2 条）：「视频墙支持播放 / 1 秒时域图 / 频域图 / 时频谱图」。
第 16 轮做的是同一句里"RTSP 主动取流"那一半（手填第三方地址），这一轮是**四种画法**。

| 视图 | 数据来源 | 怎么画 | 手册依据 |
|---|---|---|---|
| `play` | RTSP → ffmpeg → 回环 MP4 | `<video>`（原有那一支） | §5.1.6 实时视频 |
| `timedomain` | `pcmData` 包络，拼够 **1 秒**（实测一帧 100 ms ⇒ 10 帧） | canvas：按像素列取极值画竖线 | 手册有 `pcmData`，**没规定画多长**；"1 秒"是业主给的 |
| `spectrum` | `fftData` 的一帧谱线 | canvas：抽稀成 48 根柱子，按帧内最大值归一化 | 手册只写"FFT 数据"，**没规定坐标轴** |
| `spectrogram` | `fftData` 连续 30 帧 | canvas：30 列 × 24 行的瀑布，低频在下 | **手册未说明**（没有"时频谱图"这一路） |

**手册未说明、我们不编的三处**：
1. **频率轴**：实测这台相机没有任何 HTTP 接口能给出采样率，所以没有 `binHz` 时轴上写的是
   「第 N 根谱线」（探针实测 `0 – #48`），**绝不编一个 Hz 轴**；
2. **色标**：手册没有色标，我们用一条固定的冷→暖映射，并且**在界面上写明**「颜色只表示
   同一帧内谱线的相对强弱」（不是声压级）；
3. **时频谱图的列数**：固定 30 列而**不是**"按秒数换算"——渲染层只知道收到了几帧，
   推算秒数要靠推送节奏，而那个节奏设备端不保证。

**哪些源支持哪些视图**：相机四种都有；**手填的第三方 RTSP 源只有画面**（它连设备都不是），
那一格只渲染一颗按钮，悬停说明「第三方 RTSP 源只有画面」。

**订阅口径**（代码在 `stores/cameraCellCharts.ts`）：按**设备**合并 —— 同一台设备的所有图表格
共享一次 `fa371Stream.start`，每台设备最多 `pcmData` + `fftData` **两条**（相机侧 WebSocket
实测约 6 条），离开画面墙立刻停掉。PCM 缓冲 10 帧、FFT 缓冲 30 帧，都是**有界**的。

**实测**：见 `docs/UI-VERIFY.md` 第 17 轮。

### 15.66 没有活数据时说什么（2026-09-19 第 18 轮）

业主原话（2026-09-18 第 10 批第 18 条）：「实时检测无设备时显示该 IP 离线并显示上次内容」。

**六档状态机**（`src/shared/domain/monitor-offline.ts`，纯函数、单测逐档钉住）：

| 档 | 现场事实 | 屏幕上说什么 | 提示条 | 角标 | 是否显示上次内容 |
|---|---|---|---|---|---|
| `no-device` | 一台设备都没加 | 「没有设备」+ 去添加 | — | — | 否（没有 IP、也没有内容） |
| `device-offline` | 这个地址连不上 | 「**{ip} 离线**」 | 红 | 有内容时才有 | 是 |
| `waiting` | 在线，但一帧都还没来 | 「正在等待它推数据…」 | 黄 | 无 | 否 |
| `live` | 有帧而且新鲜 | （不提示） | — | — | 否 |
| `stale` | 曾经有帧，现在停了（> 3 秒） | 「数据已停止更新（最后一帧 {time}）」 | 黄 | 有 | 是 |
| `stopped` | 操作员自己按了停止 | 「已停止（最后一帧 {time}）」 | 黄 | 有 | 是 |

**为什么判据只有一处**：同一屏上提示条、角标、图表各判一次，迟早会出现"提示条说离线、
图表说等待数据"这种自相矛盾的界面。判定顺序就是操作员的心智顺序：
**有没有设备 → 设备通不通 → 有没有数据 → 数据新不新**。

**「上次内容」的两条边界**（`monitorUsesLastContent()`，边界都有单测）：
1. 只对**同一个来源**（同设备 + 同通道）—— 切通道之后那份快照属于上一路，画出来比不画更糟；
2. 只在**没有活数据**时才显示 —— 在线且正在出帧时显示旧数据就是界面在说一件没发生的事。

**手册未说明的三处（不编）**：3 秒的阈值是**我们定的**（手册没有"实时监测页没有数据时显示什么"这一节）；
从来没收到过就说「还没有收到过这台设备的任何数据」，不拿一份空图冒充上次内容；
从没推过数据的设备上**不挂**「上次内容」角标（探针断言了"角标与内容一致"）。

**实测**：见 `docs/UI-VERIFY.md` 第 18 轮（operator 库里五台设备全部离线，正是这一条的现场）。

### 15.67 「地址信息」如何支持 GIS 显示（2026-09-19 第 19 轮）

业主原话（2026-09-18 第 10 批第 7 条）：「『安装信息』改为『地址信息』并**支持 GIS 显示**」。

**口径（离线优先下的"GIS 显示"是什么）**：本机**不联网取瓦片**（渲染层 CSP 也挡在外面），
所以它不是"嵌一张在线地图"，而是**把录进去的点位真的画到「地图信息」页上，并且能从别处一键定位到它**：

| 落点 | 做什么 |
|---|---|
| 地址信息卡片（设备详情页 / 实时监测页共用） | 点位**成对**时多出「**在地图信息里查看**」（→ `/map?device=<id>`）与「**复制坐标**」（复制 `纬度, 经度`，十进制度、逗号分隔 —— 粘进任何 GIS 工具都能用） |
| 「地图信息」页 | 认 `?device=<id>`：进来就**选中那一台**（地图标记 + 右边设备表那一行同时高亮） |

**三条边界**（都有单测）：
1. 只有点位**成对**才给那两个入口（判据直接引用共享层的 `hasMapPoint()`，不重写）；
2. `?device=` **只认字符串**，重复参数/别的类型一律当"没给"；
3. 地图页只在**真有这一台、且它有点位**时才采用那个参数（过期书签不该把选中项换成图上没有的设备）。

**手册未说明**：手册没有"地址信息"这一节（第 1 条本来就是我们自己的数据模型），
所以上面的形状与"复制什么格式"都是我们定的；点位画在我们自己那张 16:9 示意图上
（§15.57 的投影），**真正的外部 GIS 服务/在线瓦片是第 13 条那个决定**，还没做。

### 15.68 地图区：删掉三处文字，右上角加半透明状态栏（2026-09-19 第 11 批第 4 条）

业主原话：

> 地图信息 ： 删除（图上 0 台 / 共 3 台有未确认告警0在线0离线0还没有任何设备录入点位。到「设备管理 → 编辑 → 安装信息」里填经纬度，设备就会落在这张图上。） 这些内容， 直接显示GIS地图的信息， 在地图右上角的位置做一个半透明的状态栏， 显示当前地图上的设备数量信息，告警信息。

**被点名删掉的三块**（括号里那串就是屏幕上连着显示的三段文字）：

| 原来是什么 | 文案键（**连同四种语言的词条一起删了**） | 现在 |
|---|---|---|
| 地图上方那一行读数「图上 N 台 / 共 M 台」 | `mapUi.counts` | 进状态栏 |
| 三个色调的图例（有未确认告警 0 / 在线 0 / 离线 0） | `mapUi.legendAlarm` 保留（它还是实时数据列表那个色点的 `title`），**图例本身删除** | 计数进状态栏 |
| 「还没有任何设备录入点位。到「设备管理 → 编辑 → 安装信息」里填经纬度…」 | `mapUi.noPoints` | 删除；"有没有落点"由状态栏的「图上 0 台」如实说出来 |

**这一条与第 10 批第 14 条的冲突**：第 14 条要求「落点三色 + 图例各带一个数」，
理由是"颜色不单独承载信息"。第 11 批第 4 条把图例删掉之后，颜色只剩两处出口，两处**都带文字或数字**：
地图上的落点（悬停浮层写这一台的名字/状态/告警条数）、实时数据列表每行前面那个带 `title` 的色点。
设备列表按第 5 条只留三列，那里不再放色点。这是这一条唯一一处"信息变少"的地方，如实记在这里。

**状态栏的五个读数**（`[data-map-statusbar]`，绝对定位在画布右上角 8px 处）：

| 读数 | 来源 | 口径 |
|---|---|---|
| 图上 N 台 | `layout.markers.length` | 只数**落点**（经纬度成对那几台） |
| 共 M 台 | `devices.devices.length` | 设备表全部；两数之差就是还没录点位的设备 |
| 在线 K / 离线 J | 设备自己的 `status`（`ONLINE` 才算在线，`UNKNOWN` 归离线） | **与落点颜色不是同一套判据**：颜色说的是"这个点在图上报什么"（告警优先），这里问的是"有几台设备在线" |
| 未确认告警 P | 每台设备 `alarms.query({ acknowledged: false })` 的 `total` 之和 | 读不到（还没读过 / 任一台失败）时显示「—」，**不显示 0** |

**三条实现上的决定**（都有单测与探针断言）：
1. **半透明用 `color-mix(in srgb, var(--color-bg) 78%, transparent)`**，并保留一行
   `rgba(255,255,255,0.78)` 兜底（老引擎丢弃不认识的那一行）；探针读的是**算出来的
   `rgba(...)` 的 alpha**，所以"看起来半透明"不算通过；
2. `pointer-events: none`：状态栏压在画布右上角，而落点是可点的 —— 一条读数不该挡住任何设备；
3. **画布不再取决于有没有落点**："这一页有设备"就画（空的经纬度网格 + 状态栏「图上 0 台」）。
   原来没有落点时整块地图消失、只剩一句话，那看起来像页面坏了。

**手册未说明**：手册没有"地图上要显示什么统计"这一节，五个读数、位置与"半透明"都是业主给的；
颜色 token 全部取自既有语义色（没有新造颜色值）。

**实测**：见 `docs/UI-VERIFY.md` 第 20 轮（探针量了位置、alpha、`pointer-events` 与五个读数的数）。

### 15.69 地图下方：左设备列表（三列、半幅宽、翻页）+ 右告警列表（同高）（第 11 批第 5 条）

业主原话：

> 地图信息页面： 未录入点位设备这个卡片内容删除，设备列表只需要显示序号， 设备名称，状态这三项， 宽度调整为现在的50%。 右侧位置应该是告警列表。 告警列表卡片高度应该始终与左侧设备保持一致。 设备列表默认最大显示10个设备，超过10个设备则翻页。 点击设备名称可以进入到设备详情。

| 要求 | 做法 | 判据/实现 |
|---|---|---|
| 删「未录入点位设备」卡片 | 那一块（`data-map-without-point`）与两条文案键一起删掉。**设备没丢**：设备列表列的是设备表全部，没录点位的照样在里面 | 单测断言那一块与 `layout.withoutPoint` 都不再被引用 |
| 设备列表只留三列 | 序号 / 设备名称 / 状态。**总表里的序号**（第 2 页第一行是 11，不是 1） | 探针读表头，必须逐字是这三项 |
| 宽度 50% | 与告警列表同一个网格（`repeat(auto-fit, minmax(340px, 1fr))`）：宽窗口上两栏各占一半，窄到放不下自动落回上下 | 探针量设备卡宽度 ≈ 内容宽的一半 |
| 右侧是告警列表 | 告警列表整张卡搬到右栏；它仍然是**选中设备**的告警（点设备切换），抓图与同步仍在这张卡里 | 探针量 `devices.right <= alarms.left` |
| **告警卡高度始终与左侧一致** | 见下面那段（纯 CSS，没有量盒子、没有 `ResizeObserver`） | 探针量两张卡 `height` 之差 ≤ 2px |
| 每页 10 台、超过翻页 | `DEVICE_MAP_PAGE_SIZE = 10`，页码在渲染前**每帧夹一次**（`clampListPage`） | 单测钉住 0/负数/NaN/越界；探针断言"控件出现 ⇔ 总数 > 10" |
| 点设备名称进详情 | 名字是一个 `<button data-action="map-device-detail">`（行点击仍然是"选中"） | 单测 + 探针 |

**"两张卡一样高"是怎么做到的**（这是这一条最容易做错的一件事）：

网格项默认 `align-items: stretch`，所以两者本来会被拉成同一高度；问题在于**行高由谁决定** ——
内容为 `auto` 时取两者中更高的那个，告警列表（一次 20 条）通常比设备列表（3 台）长得多，
"一样高"就变成了"一起变高"。所以：

1. 告警卡的内容放进 `.map-block__fill`，**绝对定位**于卡片内部（`position: absolute; inset: 0`）——
   绝对定位的元素**不参与**父级的内容高度计算，行高因此只由设备卡决定；
2. 告警卡被 `stretch` 拉成完全一样的高度，内容超出就在卡片内部滚动（`.map-alarms` 改成
   `flex: 1 1 auto; min-height: 0; overflow: auto`，不再写死 `max-height: 260px`）；
3. 两张卡写**同一个 `min-height: 320px`**：只有一台设备时设备卡很矮，这一条保证告警卡
   不会被压成一条缝（否则"一样高"会一起变得不可用）。

**手册未说明**：iVMS 没有"告警列表与设备列表同高"这条规则，它是业主给的要求；
每页 10 台也是业主给的数（`DEVICE_MAP_PAGE_SIZE`），不是我们挑的。

**实测**：见 `docs/UI-VERIFY.md` 第 20 轮。

### 15.70 设备管理页：回到卡片、四列居中、状态栏去掉「局域网 / 外网」（第 11 批第 6 条）

业主原话：

> 设备管理界面：做个卡片做一个小的区分， 告警数量， 通道数， 查看，设置这些内容都应该居中对齐。 状态这一栏 把局域网或者外网这个内容删除。 类似于实时监控界面的。

**与第 10 批第 2b 条的冲突（这一条是推翻）**：第 2b 条的原话是「不要做成卡片的，而是做成
扁平化设计，用线条分区」，这一页当时因此改成 `.devices-table-flat`（只留上下两条线）。
第 11 批第 6 条要的是**卡片**，而且点名「类似于实时监控界面的」——实时监测页每一块用的就是
全局 `.card`。所以现在：

| 项 | 第 10 批第 2b 条 | 第 11 批第 6 条（现在） |
|---|---|---|
| 外壳 | `.devices-table-flat`（上下两条线，无圆角/底色） | **`.card devices-table-card`**（全局卡片，与实时监测页同一套） |
| 分区 | 靠线（上/下边线 + 每列一条浅色竖线） | 卡片内部**保留**每列的浅色竖线（第 10 批更正第 3 条那一条没有被推翻） |
| 表格 | 全局 `.table` | 不变 |

**四列居中**（告警数量 / 通道数 / 查看 / 设置）：一条规则 `.devices-table__center { text-align: center }`，
放在 `__num`（右对齐）**之后** —— 两者特异性相同，靠顺序取胜，所以"居中的那一列"同时带两个类。
**「删除」也一起居中**：它和查看/设置是同一类图标列，只居中前三列会让这一行出现两种对齐方式。
**序号列**继续居中（第 10 批更正第 3 条），探针另有断言。

**状态那一栏去掉「局域网 / 外网」**：`StatusBadge` 的 `connection-type` 属性在这一页不再传
（绿点 + 「在线 / 离线 / 未知」保留）。理由：局域网/外网说的是"我们怎么够到它"，
而这一列问的是"它现在在不在"；渠道信息在设备详情页仍然查得到。
**注意**：`StatusBadge` 这个属性本身**没有删**——地图页的悬停浮层与设备列表还在用它。

**手册未说明**：iVMS 的设备表没有"局域网/外网"这一栏，所以"删掉它"是业主的口径；
居中对齐也是业主给的排版要求。

**实测**：见 `docs/UI-VERIFY.md` 第 20 轮（探针逐个量了四列的表头与单元格 `text-align`、
卡片圆角，以及状态列里 `.badge` 的个数必须是 0）。

### 15.71 安装包文件名带发布日期 + 小版本号随发布递增（第 11 批第 1 条）

业主原话：「每个发布的软件 应该后缀发布日期，以及小版本号的变动。」

| 项 | 做法 |
|---|---|
| 文件名 | `HERTZINNO Acoustic Box Manager-<版本>-<发布日期>-<架构>-setup.exe`（例：`…-1.0.1-2026-09-19-x64-setup.exe`） |
| 版本号 | `package.json` 的 `version`：**每次发布递增第三位**（这次 `1.0.0 → 1.0.1`） |
| 发布日期 | `package.json` 的 `releaseDate`（这次 `2026-09-16 → 2026-09-19`）；它同时是界面上"发布日期"那个读数 |
| 单一来源 | `scripts/release-stamp.cjs` 读 `package.json` 拼出名字；`electron-builder.offline.cjs` 与 `electron-builder.signed.cjs` 各自覆盖 `win.artifactName` |
| 产品名 | 从 `electron-builder.yml` 的 `productName` 读 —— 文件名与安装向导里的产品名必须是同一个字符串 |

**为什么不让 YAML 自己拼日期**：`electron-builder.yml` 读不到 `package.json` 的自定义字段
`releaseDate`；用 `${env.RELEASE_DATE}` 就必须在每个入口先设环境变量，而 `npm run dist:win`
（直接吃 yml 的那条路）会变成"不设变量就构建失败"。所以 yml 保留一个**不带日期**的兜底名字，
两份发布配置覆盖它。

**判据**（`tests/installer-name.test.ts`）：文件名里真的有版本与日期、形状正确、
日期能被共享层 `parsePlainDate` 原样解析（西半球不会变成前一天）、第三位比上一次发布大、
离线包与签名包的名字完全一致。

**手册未说明**：这是发布流程的要求，与设备协议无关；"小版本号"按第三位（patch）读 ——
业主说的是"小版本号"，不是"大版本"。

### 15.72 「手填 RTSP 地址」的管理界面搬到实时监测页（第 11 批第 2 条）

业主原话：「实时视频墙的手填RTSP地址应该挪到视频管理界面。」**软件里没有叫「视频管理」的页**
（侧栏是 总览/地图信息/设备管理/实时监测/历史趋势/告警中心/事件与告警中心/录音文件/系统设置/协议实验室），
所以这一条先问了一句，业主选定 **实时监测页**（见 `docs/UI-VERIFY.md` 第 20 轮那条问与答）。

| 之前（第 16 轮） | 现在 |
|---|---|
| 画面墙工具条上有个「手填 RTSP 地址…」按钮 | **删掉**（墙上不再有这个入口） |
| 一个对话框（`ManualRtspDialog.vue`）持有表单 + 列表 + 增改删 | 组件**删除**，界面改成实时监测页上的**一张卡片**（`ManualRtspSources.vue`）：表单在上、列表在下 |
| "保存并放到当前格"、"放入当前格" | **删掉**：这一页不碰画面格（放源进格是画面墙自己的事，两处各写一套落点规则迟早分叉） |
| 列表里显示"在第 N 格" | 删掉（在实时监测页时画面墙没挂载，格子总是空的） |

**画面墙那一侧留下的**：点某一格 → 选择器里仍然列出已有的源（名字后缀「手填 RTSP」）→
选中即放进这一格并起流。所以"新建/改名/改地址/删除"在实时监测页，"放进第几格"在画面墙。

**顺手修掉的一个真 bug**：`clearAll()`（离开画面墙时）原来用 `createCameraWallModel()` 重建模型，
那里 `manualSources: []` —— 也就是说**离开画面墙会把所有手填源删光**（它们只在内存里，界面不会说任何话）。
第 16 轮时入口和列表都在墙上，所以没人碰到；入口搬到另一页之后这条路就成了主路径。
现在走 `clearCameraWallCells()`：清格子、**保住源**，并把"清空之前占着格的 id"交给调用方去停会话。

**手册未说明**（沿用第 16 轮那两条，仍然写在界面上）：只判形状不判可达性；地址只在本次运行内有效
（它常带口令，不写盘）。

**实测**：见 `docs/UI-VERIFY.md` 第 20 轮。

### 15.73 「告警记录」改名「告警中心」+ 筛选分两档（第 11 批第 3 条，复核）

业主原话：「告警记录修改为 告警中心， 筛选的卡片放在最上面的， 可以做一个简单筛选， 和更多筛选内容的区分，更多筛选默认收起。」

**这一条在第 15 轮就已经做完了**（业主在 2026-09-19 的清单里又写了一遍，估计是还没拿到那个包），
这一轮只做复核，没有改动：

| 要求 | 现状 |
|---|---|
| 改名「告警中心」 | 侧栏与顶栏标题都是「告警中心」（`app.nav.alarms`） |
| 筛选卡片放最上面 | 筛选卡是 `.page` 的第一个区块 |
| 简单筛选 | 设备 / 告警等级 / 确认状态（`data-alarm-simple-filters`） |
| 更多筛选默认收起 | `v-if="moreOpen"`（`data-alarm-more-filters`）：时间起止 / 通道 / 告警类型；切换按钮带 `aria-expanded`/`aria-controls`，标题上带生效条数 |
| 一条顺带修的 bug | `buildQuery()` 原来只发"有值"的键，于是**清空一个筛选不会生效**（合并补丁语义）——现在每个键都**显式**发出（清空 = `undefined`） |

**实测**：见 `docs/UI-VERIFY.md` 第 15 轮（真窗口里设 2099 年 → 0 条 → 清空 → 回 200 条）。

### 15.74 画面格的播放器控制条：只留六颗（2026-09-19 第 12 批）

业主原话：

> 实时视频墙里面的，播放器窗口，应该只有告警， 全屏， 暂停， 切换录像，音量， 手动录像，
> 音量大小调整应该做成点击后显示出来， 上下调节的方式。

**这一条与第 10 批第 2 条的关系**：第 2 条要的是「视频墙支持播放 / 1 秒时域图 / 频域图 /
时频谱图」，第 17 轮把**四颗视图按钮**放进了控制条。这一轮它们**从控制条上撤走了**，
但**没有被删掉** —— 它们搬进了右键菜单的「显示方式」（见 §15.76）。控制条上因此只剩
业主点名的那六颗，顺序就是他给的顺序：

| # | 控件 | 干什么 | 与右键菜单的关系 |
|---|---|---|---|
| ① | 告警配置 | 打开这一台相机的告警配置对话框 | 与菜单里的「告警配置…」**同一段代码**（同一个对话框状态） |
| ② | 全屏 | 这一格进/出全屏 | 与菜单里的「全屏」同一个函数 |
| ③ | 暂停 | 停掉这一路的直播会话（再按一次重新起流） | 与菜单无对应项（菜单里本来就没有"停/起这一路"） |
| ④ | 切换录像 | 打开这一格的**本机录像回放** | 与菜单里的「回放本机录像」**同一个弹窗** |
| ⑤ | 音量 | 弹出竖条（见 §15.75） | 菜单里没有音量（声音是墙级别的"至多一格出声"） |
| ⑥ | 手动录像 | 开始/停止这一台的手动录像 | 与菜单里的「手动录像 / 停止录像」**同一个函数** |

**「暂停」这个词与它的动作**（一处必须说清的地方）：RTSP 直播**没有真正的暂停** ——
流不会等你，ffmpeg 也不会把已经解出来的一帧留住。这一颗按下去的真实动作仍然是
`toggleCell()`：**停掉这一路会话**（主进程释放 ffmpeg 与那条连接），再按一次重新起流。
词是业主给的（他要一个"播放器式的暂停"），动作是原来那个；**界面不假装画面停住了而流还在跑**
（那会白占相机那有限的连接数）。这一点写在代码注释与这里，不写进界面文案 ——
按钮上的字按业主的意思叫「暂停」。

**手填的第三方 RTSP 源**（§15.64/§15.72）**不是设备**：告警 / 切换录像 / 手动录像这三颗
对它没有意义（`cellHasDevice()` 为假），所以它那一格只有 **全屏 / 暂停 / 音量** 三颗。
**做不到的控件不渲染**，而不是渲染一个灰的 —— 它连设备 id 都没有，没有什么可解释的。

**为什么不是「藏起来并说明原因」**：本文件里那条规矩说的是**设备族做不到**的功能；
这里"做不到"的是"这一格压根没有设备"，不画出来才是诚实的。四颗视图按钮的处理**相反**
（照旧列出、灰显、写原因），因为那是**同一台相机换个画法**，见 §15.76。

### 15.75 音量：点一下弹出**竖条**，上下调节（第 12 批）

| 之前（第 8 批起） | 现在 |
|---|---|
| 控制条上常驻一条 96px 宽的**横滑杆** | 控制条上只有一颗「音量」按钮；点它才弹出浮层 |
| 音量图标按钮 = 开/关这一格的声音 | 点「音量」= 开/收浮层，**并把这一格设为唯一出声的那一格** |
| 滑杆名字 = 「音量」 | 竖条名字 = 「音量大小」；按钮名字 = 「音量」 |
| — | 「关掉声音」搬进浮层里那颗开关（`cell-volume-mute`），语义没丢 |

**浮层的四条实现判断**（都有单测；探针量了前三条）：

1. **竖条用原生 `input[type=range]`**：`writing-mode: vertical-lr` 让它转成竖向，
   `direction: rtl` 把 100 放在**上面**（往上拖 = 调大）。没有自己画一条滑块 ——
   原生控件的键盘行为（方向键、Home/End）是白送的，自绘要再实现一遍。
2. **浮层挂在格子里、控制条之外**：`bottom: 34px` 让开控制条那一行。格子是
   `overflow: hidden`，所以竖条高度取 96px —— **16 分屏（约 285×160 的格子）放得下**，
   这只是"放得下"的边界，不是"任何窗口都好看"（见 `docs/UI-VERIFY.md` FF 段的未验证）。
3. **点外面关掉**（`mousedown` 捕获阶段，与相机选择器、右键菜单同一套）：触发它的那颗按钮
   **不算外面**，否则"再点一次收起"会变成"先关再开"；浮层自己也不算外面，否则拖到一半就没了。
4. **全墙只开一个**：两条竖滑杆一起开着，操作员分不清自己在调哪一格。

**手册未说明**：手册没有"音量控件长什么样"这一节（更不用说"点击后弹出"）；
竖直、96px、"点音量顺带把这一格设为出声格"这三条都是我们定的，写在代码注释里。

### 15.76 四颗视图按钮搬进「显示方式」子菜单（第 12 批）

第 10 批第 2 条要的四种画法（播放 / 1 秒时域图 / 频域图 / 时频谱图）**一个都没有少**，
只是入口从控制条换成了右键菜单 —— 菜单里多一个 `display` 父项，四个子项复用
`cameraWallUi.view*` 那四个名字（菜单与控制条从不说两种话）：

| 项 | 说明 |
|---|---|
| 位置 | 菜单里紧挨着「叠加信息」、**不带分隔线** —— 两项都是"这一格怎么画" |
| ✓ | 当前那一种打勾（`env.cellView`）；切完菜单就关，下次打开 ✓ 跟着走 |
| 手填的第三方 RTSP 源 | 四种**照旧列出**，`播放`可点，另外三种**灰显 + 原因**「第三方 RTSP 源只有画面」 |
| 谁能用 | 只有**画面墙**声明 `capabilities.cellViews`；实时监测页不声明（那一页有自己的一套声学面板，没有"这一格画什么"），菜单里因此不出现一个点了没反应的「显示方式」 |

**与"做不到的不出现"那条规则的关系**：本文件的老规矩是**设备族做不到**的功能整项不出现。
这里四项都是**同一台相机**的画法，做不到的是"这一格的来源不是相机"（手填 RTSP 源）——
那属于"此刻不可用"，所以按另一条规则处理：**灰显 + 写出原因**。四颗按钮刚从控制条上被移走，
操作员点开菜单就是来问"那几张图去哪了"的，整项消失等于拒绝回答。

**探针钩子**：`VideoContextMenu` 的一级与二级菜单项现在都带 `:data-action`，
探针因此不必靠文字去点（这也是这一轮加的那一个属性）。

**实测**：见 `docs/UI-VERIFY.md` 第 21 轮（右键 → 显示方式 → 四项目都在、✓ 在"播放"上、
切频域图之后那一格画的确实是 `spectrum`、切回来图消失）。

### 15.77 「通过 HTTP / MQTT 接入」该怎么设计（2026-09-19 第 13 批第 1、3、4 条）

业主原话（第 13 批第 1 条与第 4 条）：

> 系统设置里面的数据接入， 应该是在设备管理的添加设备功能里面， 增加通过HTTP， MQTT方式接入，
> 直接生成一个对应的秘钥和遥测地址。
>
> 选择HTTP或MQTT的接入后，应该支持增加不同的遥测值，从而显示出来数据（这部分你调研下应该
> 怎么设计比较合适， 一般是增加一个视频流接口，一个数据流接口。参考thingsboard）

**他点名要的调研**（2026-09-19 实查 ThingsBoard 官方文档，逐条给出处）：

| ThingsBoard 的做法 | 出处 | 对本软件的结论 |
|---|---|---|
| 每台设备一条 **access token**，HTTP 用 `POST /api/v1/$ACCESS_TOKEN/telemetry` | [HTTP API](https://thingsboard.io/docs/reference/http-api/) | **已经实现**（第 14 轮）：`/api/v1/<32 位十六进制秘钥>/telemetry` |
| MQTT broker：token 当 **username**，主题固定 `v1/devices/me/telemetry` | [MQTT API](https://thingsboard.io/docs/reference/mqtt-api/) | **已经实现**（第 14 轮）：主题、QoS 0/1、QoS 2 断开 |
| 遥测载荷三种形状：`{k:v}` / `[{k:v}]` / `{ts, values:{…}}`（前两种用服务端时间） | HTTP/MQTT API 的 "Telemetry upload API" | **已经实现**（`parseTelemetryPayload`） |
| 遥测是**无模式**的：任何键都能发，"显示什么"由仪表盘决定 | HTTP API 的 "JSON value support" + 设备档案（Device profile） | **这是关键差异**：我们没有仪表盘，所以要把"这台设备会发哪几个键"**显式记下来** |
| 设备**动态注册**：`POST /api/v1/provision`（deviceName + provisionDeviceKey + provisionDeviceSecret） | HTTP/MQTT API 的 "Device provisioning" | **没做**，也不做：本软件的设备是**人加进来的**（先有设备、再给它接入方式），不需要设备自助注册 |
| 属性 / RPC 通道（`…/attributes`、`…/rpc`） | 同两篇 | **只读属性**（回 `{}`）；RPC 不做（见 §15.62 的诚实清单） |

**我们的设计（第 13 批采纳，分两步做）**

一台设备有一份**接入方案**（`DeviceIngestPlan`，`@shared/domain/iot-ingest`）：

| 字段 | 是什么 | 谁用它 |
|---|---|---|
| `protocol` | `none` / `http` / `mqtt`（**每台设备只选一种**） | 决定本机要不要为它开监听（离线优先：没有设备声明就不开端口） |
| `metricKeys` | **数据流接口**：四个可显示的指标（声压级 / 主频 / 平稳度 / 频带能量比）各由**哪个键**送来，默认就是别名表里那几个规范名 | 趋势页的四条曲线、实时监测页那四张卡 |
| `videoKey` | **视频流接口**：哪一个键装的是视频地址（默认 `video_url`，空串 = 这台设备不推视频） | 画面墙——那个值可以当成一条第三方 RTSP 源放进去（第 16 轮那条路） |

**为什么"数据流接口"只给四个指标、而不是"随便加一个键"**（这一条必须说清，它是一条**限制**）：

本机的趋势表（Parquet 行 = `RealtimeFeature`）**列是固定的七个量**，趋势页与实时监测页画的
就是这四个（其余三个没有图）。让操作员声明一个表里没有的键，除了"收下了但画不出来"之外
什么都得不到 —— 界面会在承诺一件做不到的事。所以"增加遥测值"落成的是：

- **给这四个指标改名/改键**（现场那台设备用的是 `spl` 而不是 `sound_pressure_level`，
  或者它把主频叫 `f0`）；
- **加一条视频流接口**（视频地址那个键）；
- 想加**第五个可显示的键**，需要的是"趋势表加一列 + 一条曲线 + 一个单位"，
  那是另一件事（列在 `docs/UI-VERIFY.md` 的 GG 段"未验证/未做"里，不假装已经支持）。

**落地顺序**（第 22 轮起）：

1. **第 23 轮（已完成，见下）**：添加设备里有了「协议接入方式」区（选 `none` / `http` / `mqtt` +
   **数据流接口**四个指标 ← 键 + **视频流接口**的键 + 本机监听状态），方案**落库**（v16
   `devices.ingest_plan`）；本机监听的开关**由设备声明派生**，设置页那一格变成只读显示。
2. **下一轮**：把端口与收数统计也从设置页搬进这个区（现在端口仍在「系统设置 → 数据接入」，
   那一页只剩"怎么听"和"收到了什么"）；再做**视频地址一键放进画面墙**。

**第 23 轮落地的四件事（与设计一致，逐条实测）**：

| 事 | 怎么落 | 为什么 |
|---|---|---|
| 协议选择 | 添加设备里三个单选项（默认"不接入"）；选了才出现接口清单 | 业主要的是"添加设备时就能选接入方式" |
| 数据流接口 | 四个**能显示出来**的指标各一行（键名可改，默认规范名） | 见上面那段"为什么只给四个指标" |
| 视频流接口 | 一个键名（默认 `video_url`，可留空） | 视频地址与遥测走同一个载荷，键名由设备定 |
| 监听由设备声明派生 | 库里有一台设备声明 http → 本机开 HTTP 监听；最后一台改回 `none` → 关掉 | 离线优先 + 业主"搬进添加流程"的要求（操作员不用再去设置页开开关） |

**两处连带的口径变化**（写进 `docs/UI-VERIFY.md` 第 23 轮）：

1. **设置页那个总开关变成只读**（`disabled` + 一句派生说明）：它现在说的是"有没有设备声明接入"，
   而不是一个可以被改掉的选项；
2. **设备对话框里的推流地址不再被"通道开关"藏起来**：那两个开关现在是派生的，
   而操作员打开这个对话框**正是为了把地址填到设备上** —— 在设备声明之前把地址藏掉，
   他就没有任何东西可以填（`iotUi.httpOff` / `iotUi.mqttOff` 两句因此删除）。
   监听开没开由「本机此刻没有在监听…」那一句统一回答。

**手册未说明**：随附手册里**没有**任何"通过 HTTP/MQTT 接入第三方设备"的章节 ——
整条路是业主 2026-09-19 第 1 条提出来的，形状照抄 ThingsBoard（他点名参考的那个），
所以凡是手册里查不到的，这里一律以"ThingsBoard 文档 + 我们的取舍"写明出处，不写成"手册要求"。

### 15.78 实时监测：那条「没有活数据」的弹窗撤掉了（第 13 批第 1 条）

业主原话：「实时监测里面如果有告警弹窗（192.168.110.90 离线 还没有收到过这台设备的任何数据）
这个内容不用显示。」

括号里那两句**就是**那条提示条在"设备离线且从来没收到过数据"时的正文
（`monitorUi.offlineBanner` + `monitorUi.offlineNoContent`），所以这一条是**按原话撤掉整条**：

| 项 | 之前（第 10 批第 18 条） | 现在 |
|---|---|---|
| 页面顶部那条提示条 | 离线时红条写「{ip} 离线」+「还没有收到过这台设备的任何数据」/「以下是最后一次收到的内容（{time}）」 | **删掉**（四语言那四句正文 + "等待它推数据" + "数据已停止更新" + "已停止" 一共七条词条一起删） |
| 六档状态机（`monitor-offline.ts`） | 提示条、角标、图表各读一次 | **留着**：`stale` / `stopped` / `device-offline` 仍然决定**角标**出不出来 |
| 「上次内容」角标 | 有 | **留着**（它说的是"你正在看的这份数据是什么"，不是那条弹窗；截图发出去时它还在图上） |
| 「上次内容」仍然画在图上 | 是 | **是**（`monitor.content`） |

**这是第 10 批第 18 条的第一次被推翻**：那一条要的是"没有活数据时写出 IP 并显示上次内容"，
业主现在说这个内容不用显示。我们按**最新的一条**改，但只改他点名的那一块 ——
"保留上次内容并继续画"这件事他没有说要撤，所以留着；设备在不在线由设备下拉旁边那个
绿/灰点回答（第 10 批第 19 条），"这份数据是不是实时的"由角标回答。

**手册未说明**：手册没有"实时监测页在没有数据时显示什么"这一节（第 18 轮当时也是我们定的）。
现在界面上不再显示它，所以这一条从"我们的设计"变成了"业主不要"。

### 15.79 添加设备：「地址信息」默认收起（第 13 批第 2 条）

业主原话：「添加设备里面， 地址信息这个按钮默认是收起来的。」

| 之前 | 现在 |
|---|---|
| `<fieldset>` 一直摊开在凭据下面（三个输入框常驻） | 一行**可点标题**（▸ 地址信息 + 右侧小结），内容是 `v-if` 出来的 |
| — | 收起时那一行说清"填了没有"：**未填写** / **点位 31.2304, 121.4737** / **只填了一部分** |
| — | 展开/收起按钮带 `aria-expanded` + `aria-controls`（探针钩子 `data-action="toggle-add-installation"`） |

**三条实现判断**：

1. **内容用 `v-if` 从 DOM 上摘掉**，不是 CSS 藏起来：后者会让收起状态下的输入框仍然被 Tab 走到
   （键盘用户会掉进一段看不见的表单）。
2. **提交路径不看展开状态**：判据仍然是"填了没有"（`hasInstallation`）——
   收起状态下输入的点位照样提交（先填、再收起、再按添加，是这个对话框的正常用法）。
3. **默认收起只是初值**：关窗之后回到收起（下一个操作员打开时看到的是同一屏）。

**手册未说明**：手册里"添加设备"那一节的字段清单没有提折叠，这是业主给的排版要求。

**实测**：见 `docs/UI-VERIFY.md` 第 22 轮（探针量了"收起时输入框 0 个 → 点一下 → 3 个"）。

### 15.80 实时监测：默认开始接收数据 + 每通道特性改成一张表（第 13 批第 3 条）

业主原话（实时监测第 2、3 条）：

> 「选中哪个设备就默认开始接收数据，不用点击开始监测按钮」
> 「右下角每一通道的声纹特性这个卡片修改为高度和左边的一致，8 行 ×（声压级/主频/平稳度/
> 频带能量比）+ 告警，点击告警则显示详细的告警状态，点击这个通道让频谱/时频域/声学波形
> 这三张卡片跟着切通道，并把这个卡片挪到当前的频谱卡片的位置」

#### 15.80.1 「默认开始接收数据」＝ 判定 + 删按钮，缺一不算做完

| 项 | 之前 | 现在 |
|---|---|---|
| 页头按钮 | 「开始监测 / 停止监测」（`monitorUi.start` / `stop`） | **删掉**（四语言两个词条一起删） |
| 会话状态 | 按钮文字 + 徽标 | **只有徽标**（运行中 / 正在启动 / 异常 / 已停止） |
| 进页面 | 选中声纹设备就 `startSession()`（**无条件**） | 走共享判定 `decideMonitorAutoStart()` |
| 换设备 | `if (live) await startSession()` | 同一个判定（换设备时先清零尝试计数） |
| 设备刚上线 | 无 | 在线状态变成 `ONLINE` 时再问一次判定 |

判据落在 `src/shared/domain/monitor-autostart.ts`（纯函数），规则与理由：

| 顺序 | 条件 | 结论 | 为什么 |
|---|---|---|---|
| 1 | 这一支没有我们要订的实时流 | `no-stream` | 相机走自己的直播、SN-16 声呐没有接入实时流；硬开 `/features_stream` 只会把好设备显示成"起不来" |
| 2 | 没选中设备 | `no-device` | 页面自己会显示"请先添加设备" |
| 3 | 会话在跑**且跑的就是这台设备** | `already-live` | 挡住重复 start（重复 start = 断开正在看的画面再重连四条 WS） |
| 4 | 已经试满 `MONITOR_AUTOSTART_MAX_ATTEMPTS`（3） | `attempts-exhausted` | 不做重试循环（离线设备上的重试循环就是日志洪水） |
| 5 | 已经失败过（attempts > 0）**且**设备不是 ONLINE | `device-offline` | 不拿必然超时的连接去撞；等一次状态变化 |
| 6 | 其余 | **开始** | |

**第 3 条里的"且跑的就是这台设备"是要紧的**：换设备是"先 `selectDevice()` 再 `start()`"，
store 的 `state` 直到 `start()` 内部跑起来才变成 `starting`，所以只看会话状态时读到的是
**上一台的** `running` —— 判定会回一句"已经在跑了"，新设备永远开不起来，而按钮已经删了。
第一次尝试**不看在线状态**也是同一类考虑：状态是本机探活的结果，可能慢一拍，
拿它当门槛会让"设备其实是好的"表现成一片空白且没有按钮可点。

**手册未说明**：手册里没有"进入实时监测是否自动开始"这一条（这是业主的交互要求）。

#### 15.80.2 每通道特性：卡片 → 一张表（8 行 × 六列）

| 列 | 来源 |
|---|---|
| 通道 | 通道表（序号 + 名字）+ 通道配置状态徽标 + 读数状态徽标 + 读数时间 |
| 声压级 / 主频 / 平稳度 / 频带能量比 | 该路**最后一次**读数（`monitor.channelFeatureOf()`，与改造前同一份数据） |
| 告警 | `alarms.query({deviceId})` **最近 50 条**（`DEVICE_ALARM_SAMPLE`）按 `channelId` 分组 |

四条实现判断：

1. **数据源不新造**：设备一次只在一路通道上开流（PROTOCOL-FINDINGS 4.3），所以 8 行里
   只有"当前订阅的那一路"是实时的，其余是上次读数 —— 行里那枚状态徽标与**读数时间**就是
   为这件事留的（旧读数不带时间，看起来和实时值没有区别）。
2. **红点只由"没确认的"决定**（`@shared/domain/channel-alarm.ts` 的 `channelIsAlarming()`）：
   告警中心确认过的告警不该在这一页继续标红，否则两页对同一件事给出两种答案。
   已确认的仍然可以在详情里看到（按钮换成不标红的「已确认」）。
3. **那一列是采样窗口**，所以界面上写明了「来自最近 {count} 条告警记录」——
   不写就等于把"这批记录里没有"说成了"历史上从没有过"。
4. **位置与等高**：卡片挪到图谱网格**第一格**（= 原「频谱」那一格），并把 `.graph-grid` 的
   `align-items: start` 去掉（回到网格默认的 `stretch`）—— "和左边一致"在窗口宽度变化时
   "左边"是谁也会变，只有让同一排互相撑齐才在任何宽度下都成立；表体是
   `flex: 1; overflow: auto`，只跟着变高变矮，不会反过来把整行撑爆。

**点击**：整行可点 = 切到这一路（复用 `selectChannel()`，三张图跟着走，未启用的通道点不动）；
告警那一格是**独立按钮**（`@click.stop`），打开详情弹窗：时间 / 等级 / 故障类型 / 是否已确认 /
设备自己的 `alarm_reasons` 原话 / 四项读数，再往下是去「告警中心」（带这台设备）的入口。
"看全部历史"是告警中心的职责，弹窗只回答"这一路现在怎么了"。

**手册未说明**：iVMS-4200 手册没有"每通道特性表"，也没有"通道级告警列"这一节 ——
表格形态、六列的选择、告警列的判据都是本仓库按业主口述做的设计；
`severity` 的来源见 §15.5/§15.6（入库时按位图算好并快照）。

**实测**：见 `docs/UI-VERIFY.md` 第 24 轮。


























