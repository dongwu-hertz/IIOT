# FA371 系列：2026-09 两份新手册带来的增补与更正

本文件记录两份额外手册对既有结论的**增补**与**更正**。既有结论散落在
`reference/FA371-api-spec.md`（手册逐条批注）与 `FA371-INTEGRATION.md`（接入记录）里，
其中至少一条被这两份文档**证伪**。工程上重要的不是"补了哪些端点"，而是
**"哪些结论被推翻、我们此前因此做错了什么"**。

## 0. 来源与再生方式

| 文件 | 内容 | 规模 |
|---|---|---|
| `Onboard_Acoustic_Camera_API_Workflow_EN_V1.1.docx` | API 目录与调用流程（HTTP + WebSocket），产品型号写作 `HZ-FA-371 / HZ-FA-36` | 421 行文本 |
| `Online_Acoustic_Camera_Practical_Guide_EN_V1.2_20260915_.docx` | 在线声学成像仪使用指南（型号写作 XS-SCF05），含三种应用模式的作业流程与 FAQ | 615 行文本 |

两份都只有 `.docx`，本仓库读不了 Word，所以转换成了纯文本放在同目录：

- `reference/api-workflow.txt`
- `reference/practical-guide.txt`

转换脚本是仓库根的 `.docx-to-text.cjs`（一次性工具，用完可删）。它把
`word/document.xml` 里的 `<w:tbl>/<w:tr>/<w:tc>` 还原成**制表符分隔的行**，
所以 API 表格在纯文本里仍然是表格，而不是被压成一列。

> **为什么单独写一个转换脚本而不是用 PowerShell 内联命令**：这两份文档的价值全在表格里，
> 而"把所有 `</w:p>` 换成换行"会把每个单元格炸成一行。脚本里的状态机按
> "单元格内段落 → 空格 / 单元格结束 → 制表符 / 行结束 → 换行" 分别处理。
> 另外 PowerShell 会吃掉内联命令里的 `$` 与反引号（本项目已经因此吃过亏）。

## 1. 更正：告警策略**可以**通过开放接口启停（此前的结论是错的）

**新文档的原文**（`api-workflow.txt` 第 340–346 行）：

```
GET  /alarm_strategy_enable   Get the enabled alarm strategy
PUT  /alarm_strategy_enable   Set alarm-strategy enable/disable state
```

第 129–134 行给出了完整流程与一条硬限制：

> In actual production environments, an alarm strategy is usually enabled according to the
> workflow above. First call the query interface (`GET /alarm_strategy_enable`) to check
> whether an alarm strategy is already enabled; then call the update interface
> (`PUT /alarm_strategy_enable`) to enable or disable the required strategy.
> …
> **Note: Due to system-resource limitations, the device can have at most one alarm strategy
> enabled at any given time.**

要启用 B 而当前启用着 A，文档给的顺序是**先停用 A，再启用 B**。
`practical-guide.txt` 的排障表把同一条又说了一遍：策略处于启用状态时被锁定，
"First call `PUT /alarm_strategy_enable` to disable it, then modify it."

**此前为什么判断错了。** 旧手册的字段表里 `Switch` 只出现在**读取**侧，开放接口部分没有
任何启停端点，于是记录成缺口 `C33`「告警策略的启用/禁用接口完全缺失 → 巡航模式无法用
API 配置」。当时的调查还试过一个"看起来对"的写法 —— `PUT /alarm_strategy {"Switch":1}` ——
设备回了 `ret:200`，读回来却仍是 `switch:0`。**一个成功码加一次无效写入，被当成了
"这个能力不存在"的证据**，而真相是端点和字段都不是那个。

这条更正的实际影响有两处，都不是文档层面的：

1. **声学相机的告警联动此前无法端到端验证**，理由是"设备上唯一那条策略是禁用的，而开放
   接口没有启用端点"。这个理由不成立 —— 现在可以启用策略、触发检测、观察真实告警。
2. `POST /turn_on_detect` **在没有任何策略启用时会返回 `ret:-1`**（新文档第 203 行：
   "Before calling the start-detection interface, make sure that one alarm strategy is
   enabled"）。也就是说：**启停策略不是一个附加功能，而是"开始检测"能用的前提**。

## 2. 更正：`detect_id` 是**路径段**（缺口 C14 的前半段）

`api-workflow.txt` 第 304–306 行：

```
GET /detect_logs/{detect_id}    Get detection log / result
```

旧手册在同一处自相矛盾（正文说 Query Param，示例写路径），因此记录成 P0 缺口 `C14`，
客户端甚至保留了一个 `detect_logsQueryStyle` 选项在候选写法之间切换。
**新文档明确了用路径。** 剩下的未解部分只有返回形状（`detect_logs` 数组 vs 示例里的裸对象）。

## 3. 新增：第六路 WebSocket `/prpdData`

第 398–401 行列出 **六路** 数据流，比之前记录的五路多一路：

| 数据流 | 路径 | 格式 | 文档标称频率 |
|---|---|---|---|
| PCM 音频 | `/pcmData` | float32 二进制 | 10 帧/秒，48 kHz |
| FFT | `/fftData` | int16 二进制（前 512 点） | **5 帧/秒** |
| 声纹图 | `/voiceprintData` | int 二进制 | **1 帧/秒** |
| **PRPD 图** | **`/prpdData`** | int 二进制 | **1 帧/秒** |
| 异音定位点 | `/energyData` | int32 二进制 | 按定时周期推送 |
| 检测结果 | `/detectFeedback` | JSON 字符串 | 每次检测后一包 |

`/prpdData` 属于**局部放电**版本（PRPD = Phase-Resolved Partial Discharge）。
我们的客户端目前只认识五路 —— **这一条只是记录，尚未实现**。

**文档频率与真机实测不一致，以实测为准**（§5.3 的实测表）：`/fftData` 文档 5 fps、
真机 **10.06 fps**；`/voiceprintData` 文档 1 fps、真机 **约 10 fps**（JPEG 600×400）。
两份文档描述的可能是不同型号/固件的标称行为，而**我们手上这台的行为已经被测出来了**，
所以坐标轴、抽稀与缓存大小一律按实测值设计，不按手册。

## 4. 已完成，无需改动：WebSocket 心跳

新文档第 377 行：

> Heartbeat: after a successful connection, the client must send any message to the server at
> least once per minute; otherwise, the server considers the connection inactive and disconnects it.

排障表同样列出「WebSocket disconnected ← Heartbeat not sent on time (once per minute)」。

**我们的客户端已经满足这条**：`fa371-ws-client.ts` 里 `FA371_HEARTBEAT_INTERVAL_MS = 30_000`，
并且发送 `{"type":"heartbeat","channel":"<path>"}`。30 秒 < 60 秒，留了一倍余量。
记录在这里是因为这是"新文档提出的要求恰好已经满足"的唯一一条 —— 不要再改它。

## 5. 更正：设备只保留最近 **50** 条检测记录（旧说法是 100）

第 418 行：

> Detection limits: the single-detection duration (detection period) can be set from 1 to 30
> seconds. The device retains only the latest 50 detection records; older records are
> overwritten cyclically.

旧手册（§8.3 E11）说的是 100 条。两处都指向同一件事 —— **检测记录的 id 会被回收**，
这正是告警联动把事件身份定成 `deviceId:logId:startTime` 而不是只用 `logId` 的原因。
**身份设计不受影响，受影响的是"从设备回捞历史"的可回溯深度**：只有最近 50 条。

同时这条给出一个之前不知道的可配置项：**单次检测时长（检测周期）1–30 秒**。

## 6. 两种"检测模式"，别混淆（这一条直接影响产品措辞）

用户口语里的「检测模式」有两个完全不同的所指，而它们一个是软件能改的、一个**不是**：

| | 含义 | 取值 | 软件能否修改 |
|---|---|---|---|
| **运行模式** | 每次检测的行为方式 | `GET/PUT /run_mode`：`1` 单次检测 / `-1` 智能巡航 | ✅ **能**，就是 §5.1.8/§5.1.9 |
| **应用模式** | 产品版本能力 | 局部放电 / 气体泄漏 / 机械异音 | ❌ **不能** |

`practical-guide.txt` 第 60–61 行把后者的边界写得很清楚：

> Select the application mode according to the actual scenario. Three modes are supported:
> partial-discharge detection, compressed-gas external leakage detection, and mechanical
> abnormal-noise detection. **(Note: The device is shipped with only one mode enabled. If
> another mode is required during use, please contact technical support.)**

> 所以：软件可以提供**单次 / 智能巡航**的切换（那是 API 能力）。
>
> ⚠️ **这一段当时的推论是错的，已由 §13 的实测推翻。** 当时的结论是"不能提供
> '把泄漏版切成局放版'这种开关 —— 手册说那要联系技术支持，放一个就是假开关"。
> 实测结果：`PUT /system {"work_mode": N}` **真的能切**，三个模式都验证过。
> **手册那句"请联系技术支持"描述的是商务/服务流程，不是技术限制。**
> 教训写在 §13.3：手册没写 ≠ 设备做不到。

## 7. 升级 / 回滚 / 重启 / 恢复出厂：**手册里没有**，但设备固件里**存在**（未文档化）

> ⚠️ 本节最初的结论是"没有开放接口"。**这个结论只对了一半**，见本节末尾的更正 ——
> 手册里确实没有，但设备的实际固件里有。保留前半段的推理过程，是因为它说明了
> "手册没写"和"设备没有"是两件事。

两份新文档都只把升级放在设备自己的 Web 界面里：

- `practical-guide.txt` 第 614 行：「Firmware upgrades are performed under "System Upgrade."
  Do not power off the device during the upgrade.」
- `practical-guide.txt` 第 611 行：**Restore Initialization** 会把 IP、用户名、口令恢复出厂
  **并删除全部历史数据**（"Use with caution."）。
- `api-workflow.txt` 的 "Safety and Maintenance" 一节（第 419–424 行）同样只讲 Web 界面的
  用户管理、设备日志 `system_logs.log`、设备自检，**没有任何升级端点**。

旧手册的结论也一样（第 180 行、缺口 E10）：这些功能"UI 有、Open Interface 未开放"。

**更正（2026-09，只读拉取设备自带前端 bundle 后）：**"UI 有"不等于"接口不存在"——
它只说明**手册没写**。设备自带的 `main.js`（2.26 MB）里读出了真实的调用链：

```
POST /upload    multipart，前端超时设成 1800 秒
PUT  /reboot
GET  /progress
```

同时 `GET /dev_info` 与 `GET /basic` 也确实可用（未文档化但返回真实 JSON）：
`device_version`、`sdk_version`、`web_version`、`upgrade_time`、`dev_mac`、`dev_type`。
**相机控制面板已经用它们显示固件版本。**

所以准确的表述是：

| 说法 | 是否成立 |
|---|---|
| 手册里没有升级端点 | ✅ 成立 |
| 设备没有升级端点 | ❌ **不成立** |
| 软件里能猜一个端点出来 | ❌ 这是坏主意（§1 的 `PUT /alarm_strategy {"Switch":1}` 返回 `ret:200` 却什么都没做） |
| 端点已知、但**未实现** | ✅ 现状，见 §12 |

**结论修正为**：能力缺口本身是真的（手册未开放），但"因此只能打开设备 Web 界面"这个推论
是**可选方案**而不是**唯一方案** —— 端点已经被读出来，只是本轮没有实现。要不要实现见 §12。


## 8. 两条值得注意的运维事实

- **策略/条件锁定**：已启用的策略与其绑定的条件**不能修改、不能删除**，必须先停用。
  这与我们界面上"读取侧显示启用状态、写入侧不提供切换"的现状直接相关 —— 现在可以提供切换了。
- **设备可主动推送告警**：`api-workflow.txt` 第 241 行描述设备向自定义地址
  （示例 `http://192.168.2.50:8080/logs`）以 JSON 推送告警记录。也就是说告警有
  **"主机轮询"与"设备推送"两条路**，我们目前的联动实现走的是轮询。

## 9. 陷阱：`detect_logs` 的两种传参方式**返回的形状不同**，不要"照手册改默认值"

§2 说手册明确用路径段。真机实测（`V0.5.1.6_251219`）两种都通，但**语义不同**：

| 请求 | 真机返回 | 含义 |
|---|---|---|
| `GET /detect_logs?detect_id=1` | `{"detect_logs":[…]}` | **过滤被忽略**，返回**整批** |
| `GET /detect_logs/1` | `{"detect_log":{…}}` | **真的按 id 过滤**，且键名是**单数** |

所以"手册写的是路径段，那就把默认值改成路径段"是一个**会静默弄坏两处调用**的改动：

- `linkage/detect-logs-poll-source.ts` 用 `getDetectLogs(1)` **轮询整批**日志并按游标去重。
  改成路径段后它只会拿到第 1 条 —— 轮询会安静地退化成"只看一条"，不报错、不告警，
  只是永远漏掉后面的告警。
- `device/device-service.ts` 同样按整批读。
- `device/fa371/detect-library-service.ts` 的 `list()` 也是**整批**语义：它自己的注释就写着
  「真机返回的是整批数组」，并把 `paging: 'none'` 如实带出。

也就是说：**两种调用意图（"整批"与"按 id 取一条"）共用同一个客户端选项**
（`detectLogsQueryStyle`，当前默认 `query_param`），而我们要的是"整批"。因此

**结论：默认值保持不变。** 正确的做法是将来需要"按 id 取一条"时**按调用**指定样式，
而不是改全局默认。本轮**没有做**这个重构：现在没有任何用户可见功能依赖它
（事件中心拿到整批后是按 id 在数组里查的，结果正确，只是多传了一些数据）。

`mappers.mapDetectLogs` 已经同时接受 `detect_logs` 与单数 `detect_log` 两种键，
所以将来做"按调用指定样式"时不需要动映射层。

## 10. 真机探测的两个方法论坑

1. **两种失败形状，别把 200 当"存在"。** 在这台设备的固件上，未知的 `/system/*` 路径返回
   **真正的 404**（约 140 字节的 nginx 页面），而**其它任何**未知路径返回 **200 + SPA 的
   `index.html`**（约 339 字节）。所以"GET 一个猜的路径拿到 200"**完全不能**说明端点存在 ——
   它只说明前端路由接住了这个地址。要判存在，必须同时看**响应体**是不是那个 SPA 页面。
2. **老缺口里有一条对本固件不成立。** §5.1.16 记的是 `/system/detect_status` 是本组唯一
   **没有** `ret`/`msg` 的接口；实测这台固件返回 `{"detect_status":0,"msg":"SUCCESS","ret":200}`，
   两个字段都在。手册描述的是另一个固件版本的形状，**字段是否存在必须按响应判断，不能按手册断言**。

## 11. 探测中确认存在、但本轮**未实现**的端点

下列路径的响应体是**真实 JSON**（不是 SPA 页面），因此确认存在：

| 路径 | 观测到的响应 | 说明 |
|---|---|---|
| `GET /system/detect` | `{"detect_count":1,"detect_duration":10,"detect_interval":0,"msg":"SUCCESS","ret":200}` | **未文档化**。看起来正是手册说的"检测周期 1–30 秒"那组参数。**写方法未探测、未实现** |
| `GET /dev_info` | `{"device_version":"V0.5.1.6_251219","sdk_version":"v8.1.0"}` | 相机控制面板**已使用**（显示固件版本） |
| `GET /basic` | `{"web_version":"WEBV10.2.5","upgrade_time":"2026-09-14_06:56:47","dev_mac":"…","dev_type":"FE128-ROBOT-PLUS",…}` | 同上；`upgrade_time` 是上次升级时间 |
| `POST /upload`（multipart，超时 1800 s）+ `PUT /reboot` + `GET /progress` | 从设备前端 bundle 读出的调用链 | 升级功能的真实路径，见 §12 |
| `/whep`、`/system/soundmap_style`、`/scheduled_restart`、`/self_inspection`、`/user`、`/network`、`/preview`、`/get_detection_record` | 未逐个探测 | 同一个 bundle 里读出的路径，值得后续分类 |

`/system/detect` 尤其值得注意：它是**唯一**观测到的"检测参数"端点，而手册只给了"检测周期
1–30 秒可调"这句话却没有给端点。**但它的写方法没有探测过** —— 在一个未文档化的端点上
盲写，正是 §1 里那次误判的成因，所以本轮只记录、不实现。

## 12. 升级：端点已知，本轮**故意没有实现**（⚠ 该决定已被 §18 推翻，保留原文以存证）

如 §7 所述，`POST /upload` + `PUT /reboot` + `GET /progress` 是从设备自带前端里
读出来的真实升级链路。本轮**没有实现**，理由有两条，都不是"技术上做不到"：

1. **没有任何固件文件可以拿来验证。** 上传一个来路不明的镜像给真机，风险不是"功能不工作"，
   而是**把设备刷成砖**。
2. 即使实现，也只能交付一条**未经真机验证**的刷机路径；而本项目对未验证的东西一律标注、
   不允许默认可用。

因此本轮交付的是：**能力缺口 + 指向设备自带 Web 界面的入口**（相机控制面板里是禁用按钮 +
悬停原因，原因里写明真实端点路径）。要不要实现真正的上传，是一个需要明确同意的决定 ——
它能在软件内把升级做完，代价是一条无法在交付前验证的刷机路径。

## 13. 应用模式（局放 / 泄漏 / 机械异音）：**读得到，也写得动**（实测推翻了我的前一版结论）

第三份手册（`reference/leak-detection-manual.txt`，HZ-FA-371 **气体泄漏版**，文档版本 V6.3，
2025-03-18）与已有的 FA371 规格是同一代 API。它确认了两件事：`/run_mode` 的语义与之一致
（单次检测 / 智能巡航），以及**升级在本代手册里同样只是 Web 界面操作**（§4.7.3：选文件 →
Upload → Update 三步）。它也**没有** `alarm_strategy_enable` —— 那份文档比 2026-08 的
《API Workflow》早，所以这是时间顺序，不是矛盾。

真正的新发现来自设备自己的前端 bundle（`/static/js/main.<hash>.js`，2.26 MB，只读拉取）：

**1. 应用模式有一个未文档化的读取端点。**

```
GET /system   →   {"msg":"SUCCESS","ret":200,"work_mode":1}
```

设备前端里的调用是 `on().then(e => e.data.work_mode)`，而 `on()` 打的就是 `/system`。
`/system/*` 下的任何 `*mode*` 猜想路径都是**确定的 404**（`/system/work_mode`、`/system/app_mode`、
`/system/mode`、`/system/device_mode`、`/system/product_mode`…），也就是说这个端点**只能**通过
读它的代码找到，猜是猜不到的。同一批还捞到 `GET /global_distance_config` → `{"global_distance":1}`。

**2. 数值到名称的映射写在设备自己的界面代码里**，所以这不是推断：

```js
1 == t ? ti.get("PartialDischargeDetectionMode")
       : 2 == t ? ti.get("LeakDetectionMode")
                : ti.get("MechanicalNoiseDetectionMode")
```

即 **1 = 局部放电，2 = 气体泄漏，其它 = 机械异音**。连着的这台设备返回 `work_mode: 1`，
**所以它是局部放电版** —— 这同时把"`TM.PD3` 是不是局放"从猜测变成了结论。

**3. 但它是只读的。** 设备自己的界面只在顶栏**显示**模式名称，旁边那个 `<select>` 是
**语言切换器**（中文 / English，onChange 里写的是 `localStorage.setItem("language", …)`）。
在整个 bundle 里 `work_mode:` **作为请求体键出现 0 次**。也就是说：连设备自家的 UI 都没有
提供切换应用模式的控件，这与两份手册的"出厂只启用一种，需要另一种请联系技术支持"完全一致。

**结论（已由实测更正）**：
- **能读**，也能**写** —— 端点是未文档化的 `PUT /system {"work_mode": N}`。完整实验见 §13.2。
- 三个模式都验证过：`2`（气体泄漏）与 `3`（机械异音）都**真的生效**，且已还原成 `1`。
- 因此软件里**提供**应用模式切换；因为端点未文档化，代码注释与界面文案必须如实说明这一点。

### 13.2 实测：三个应用模式都切得动（2026-09-15）

```
BEFORE   GET /system → {"work_mode":1}   run_mode 1 · acoustic 10–30 kHz · image -30/0/0/1
                                              detect_status 0 · 策略未启用

1 → 2    PUT /system {"work_mode":2} → 200 {"ret":200}   读回 work_mode = 2   ✅ 生效
1 → 3    PUT /system {"work_mode":3} → 200 {"ret":200}   读回 work_mode = 3   ✅ 生效
回 1     PUT /system {"work_mode":1} → 200                读回 work_mode = 1   ✅ 还原

AFTER    六个端点逐个比对：/system、/run_mode、/system/acoustic、/system/image、
         /system/detect_status、/alarm_strategy_enable **全部与 BEFORE 逐字节相同**
```

只写 `work_mode` 一个字段，其余一概没碰（不启停检测、不动 `run_mode`、不动策略、
不动声场与成像参数）。

### 13.3 我为什么判断错了两次同类问题（值得写下来）

本文件 §1 记录了第一次：把"策略启停"误判成"设备不支持"，因为试了一个看起来对的写法
（`PUT /alarm_strategy {"Switch":1}`）拿到 `ret:200` 却没生效，于是把**"我没找到"**
当成了**"不存在"**。

这次是同一个错误的另一个版本，而且更典型：

1. 我在**设备前端 bundle** 里搜 `work_mode` 的写调用，四处全是读 → 于是推断"连设备自家界面
   都不提供，所以没有这个能力"。**这个推理是不成立的**：设备前端没有控件 ≠ 固件没有端点。
   这次的端点恰恰是"前端只读、固件可写"。
2. 更该批评的是**表述**：我写的是"**不能写**（无端点、无手册、无设备端控件）"，
   而当时真实的状态是"**没测过**"。**没有实测过的否定结论，不能写成事实。** 正确的写法是
   "未见写方法，未实测"。
3. 第一次的教训是"别信成功码"；这一次的教训是**"别把搜索的边界当成世界的边界"** ——
   搜索范围（前端代码、手册、猜路径）里的"没有"，不等于设备能力上的"没有"。

**因此形成的规矩**：凡是要断言某个设备能力**不存在**，必须有一行实测记录；
否则只能写"未验证"。

**"切换模式"三层都有结论**：运行模式（单次 / 巡航）可以，已实现并真机验证；
应用模式（局放 / 泄漏 / 机械异音）**也切得动**（`PUT /system {"work_mode": N}`，实测见 §13.2）；
三种应用场景的**成像参数**（频带、目标数、灵敏度、增强）同样写得动
（`PUT /system/acoustic` + `PUT /system/image`）。前两者各自独立 —— 切换应用模式**不会**
自动改成像参数，这是刻意的（见下面 §13.1 的说明）。

### 13.1 更正：厂家自己把这套"调参"叫做**切换模式**

上面那句"那是按场景调参"是我说得太保守了。《API Workflow》第 55–64 行的小节标题就是
**"Quick Start — The complete API workflow for switching modes"**，而它列的步骤是：

```
POST /login
PUT  /alarm_strategy      启用策略 ID=1
PUT  /system/acoustic     把成像频带设为 20 kHz–40 kHz      ← 模式定义就在这里
POST /turn_on_detect
GET  /detect_logs/{detect_id} + /detect_file/{saving_path}/{file_name}
PUT  /alarm_strategy      停用策略 ID=1
```

**20–40 kHz 正是《Practical Guide》里局部放电模式的推荐频带。** 也就是说：厂家文档里
"切换模式"的 API 做法，就是**把目标模式的参数写进去**，而定义模式的那个参数是**成像频带**。
所以"通过 API 切换模式"这句话是**对的**，只是它切的是工作参数，不是固件变体标识：

| 想切的东西 | 是否可切 | 依据 |
|---|---|---|
| 单次检测 ↔ 智能巡航 | ✅ | `PUT /run_mode`（§5.1.8/§5.1.9） |
| 应用场景（局放/泄漏/机械异音）的**工作参数** | ✅ | 厂家的 Quick Start 明写这是"switching modes"：`PUT /system/acoustic` + `PUT /system/image` |
| 固件变体标识 `work_mode` | ❌ | 无端点、无手册、设备自家 UI 也不提供控件 |

同一小节那句括号仍然有效，且必须一起读：**"设备出厂只启用一种运行模式；若需切换模式，
请联系技术支持。"** —— 它说的是**变体**，不是上面那张表里的工作参数。


## 14. 泄漏版专属：泄漏成本估算（我们已经实现）
泄漏版手册里泄漏检测与其它两种应用最大的差别是**成本估算**（第 1482 行）：按泄漏位置估算成本，
参数包括泄漏量、泄漏单位、货币单位、气体价值、能源成本、比功率、工作时间、检测距离。
对应端点 `GET` / `PUT /system/leakage`，真机实测返回：

```json
{"correction_rate":1,"cost_display":0,"energy_cost":1,"leakage_distance":1,"leakage_unit":0,
 "leakage_unit_str":"l/min","monetary_unit":0,"monetary_unit_str":"CNY","specific_power":1,
 "value_of_gas":1,"working_hours":1,"ret":200,"msg":"SUCCESS"}
```

这套参数、以及检测日志里的 `data_1`~`data_4`（泄漏量 / 泄漏成本 / 泄漏单位 / 成本单位）
**本软件早已实现并展示**：`GET/PUT /system/leakage` 在客户端里，事件中心显示
`leakVolume` / `leakCost`，联动面板也带泄漏量。所以泄漏版不需要额外适配才能看泄漏数据。

## 15. 更正 §12：官方升级流程是 **SSH + 自解压包**，不是 HTTP 接口

新拿到的 `HERTZINNO_HZ-FA-371_Software_Release_Notes_V2.0.11.docx` 与
`FE128_ROBOT_PLUS_System_Upgrade_Procedure_EN_V2.0.docx`（2026-08-04）把升级这件事讲清楚了，
而 §12 里"从设备前端 bundle 读到 `POST /upload` + `PUT /reboot` + `GET /progress`"只是
**设备自带 Web 界面**走的那条便利路径。**厂家文档给出的正式流程完全是另一回事**：

| 步骤 | 做法 |
|---|---|
| 准备 | 升级包 `FE128_ROBOT_PLUS_upgrade_pkg_RK3568_v2.0.11`（约 75 MB）+ **MobaXterm**（SSH + SFTP）+ 设备 IP 与账号（文档示例用 `root`） |
| 1 | SFTP 把升级包上传到 `/root/` |
| 2 | `chmod 755 FE128_ROBOT_PLUS_upgrade_pkg_RK3568_v2.0.11` |
| 3 | `./FE128_ROBOT_PLUS_upgrade_pkg_RK3568_v2.0.11` → 自解压安装器：更新 nginx 配置、前端页面、`programs/`、`clib`、相机 iqfiles、网络配置，备份 `conf/` |
| 4 | `./FE128_ROBOT_PLUS_upgrade_pkg_RK3568_v2.0.11 k410_4096` → **单独的 FPGA 固件升级**（进度 0→100%，日志显示约 2.5 分钟） |
| 5 | 重启设备 |

关键含义：

- **升级是两段**（系统 + FPGA），而且第二段需要一个额外参数 `k410_4096`。
- **它是 SSH 上执行一个可执行文件**，不是 HTTP 上传。要在本软件里实现，等于要实现
  SFTP 上传 + 远程命令执行（还要按顺序跑两次、判断成功、再重启）——这比"HTTP 传一个文件"
  大得多，也危险得多。
- 文档明确写了"升级期间不要断电/不要做其它操作"、"升级前备份配置"，并且**升级包必须与硬件平台
  和采样率匹配**（V2.0 系列对应 RK3568 + 200 kHz；其它采样率变体的包不得混用）。
- 因此上一轮"只给入口、不实现上传"的决定**依然成立，而且理由更强了**：现在不只是"没有固件
  文件可验证"，而是"正式流程本身就不是一个适合塞进桌面应用的 HTTP 调用"。

> **⚠ 后续更新（本轮，见 §18）**：上面的推理针对的是**正式流程**（SSH/SFTP + 自解压包），
> 那一条依然不做。负责人随后明确要求实现**设备自带 Web 界面那条 HTTP 路**
> （`POST /upload` + `PUT /reboot` + `GET /progress`），本轮已按那条路实装。
> 交付的是一条**未经真机验证**的刷机路径，这一点在 §18.2 里逐条写明。

### 15.1 顺带确认的设备身份

`FE128` 升级流程适用的型号、以及 release notes 的硬件平台，与真机读到的一致：

```
/basic      dev_type = FE128-ROBOT-PLUS        ← 升级文档的适用型号
/dev_info   device_version = V0.5.1.6_251219    ← release notes 里 V2.0.11 的 FPGA 固件版本
```

即这台设备是 **FE128-ROBOT-PLUS / RK3568 / 200 kHz**，FPGA 已是 `V0.5.1.6_251219`。
（注意：`/dev_info` 的 `device_version` 给的其实是 **FPGA** 版本，软件版本要从
release notes 那套命名去对，别把两者混为一谈。）

## 16. Release Notes V2.0.11 里对我们有意义的几条

| 内容 | 与本软件的关系 |
|---|---|
| 200 kHz 声学采样、最多 3 个声源目标、真实声场可视化（动态范围 0–15 dB、透明度与色板可调） | 成像参数，`PUT /system/image` 的字段集合对应得上 |
| **Band Energy Ratio** 新增为告警条件；主频/频谱比对/频带能量比支持自定义上下限 | 告警条件端点扩展了字段 → 我们的相机告警配置界面**尚未**暴露这三项 |
| **Kurtosis / Crest Factor** 新增为告警条件特征值 | 同上，未暴露 |
| 泄漏估算新增 **correction factor** | `PUT /system/leakage` 的新字段；真机 `/system/leakage` 已经返回 `correction_rate` |
| 时区配置（38 个时区）、自定义 HTTP 服务端口 | 设备侧配置，未暴露 |
| API 兼容性：核心请求/结构保持兼容，部分端点**增加字段或收紧校验**；WebSocket 通道不变 | 解释了"invalid API values are no longer accepted as successful parameter updates"——**与我们"不信任成功码"的做法同向** |

## 17. 检测模式切换的**功能**验证（不只是读回值）

前面所有验证都只证明"写进去、读回来一致"。这一节证明**设备行为真的不同**，
并且顺带拿到了本项目**第一条真实检测日志**。

### 17.1 两种模式的可观测差异（实测）

| 模式 | `POST /turn_on_detect` 返回 | 会不会自己停 | 观察到的 `detect_status` |
|---|---|---|---|
| `1` 单次检测 | `{"detect_id":2,"ret":200}`（**给出记录 id**） | ✅ **会** | `2s=1 … 34s=1 36s=0`（自行结束） |
| `-1` 智能巡航 | `{"detect_id":0,"ret":200}`（id 为 **0**） | ❌ **不会** | `2s=1 … 32s=1`（一直跑，直到 `turn_off_detect`） |

单次模式 36 秒自行结束、巡航模式 32 秒仍在运行 —— 这是"模式切换真的生效"的行为证据，
不是读回值。`detect_id` 在单次模式有真实编号、巡航模式为 `0`，与手册"id 只在单次检测模式返回"一致。

### 17.2 新发现：`PUT /run_mode` 会**清掉已启用的告警策略**

```
PUT /alarm_strategy_enable {switch:1,id:1}   → 200
GET /alarm_strategy_enable                   → [ {…,"switch":1} ]   策略已启用
PUT /run_mode {run_mode:-1}                  → 200
GET /alarm_strategy_enable                   → []                   ← 被清掉了
```

这解释了一次自相矛盾的观察（同一台设备，有时 `turn_on_detect` 成功、有时报
`ret:-1 no available strategies`）：**写 `run_mode` 会把"当前启用的策略"这个指针清空**，
而 `turn_on_detect` 要求有一条已启用策略。

**对软件的影响（需要修）**：界面上的「检测模式」和「告警策略」是两个独立控件，
操作员改了模式之后再点「开始检测」就会失败，而错误信息把责任推给"没有可用策略"——
听起来像策略配错了，实际是被模式写入清掉了。正确做法是**先写模式、再启用策略**，
或在「开始检测」前自动重启用策略。目前面板没有这个顺序保证。

### 17.3 检测带宽的真实规则（实测，也纠正了我自己一次错测）

我一开始写的是"手册自相矛盾"（正文说带宽 ≤20 kHz，而机械异音推荐 2–50 kHz）。
**这个判断是错的，来自一次设计很差的实验**：我把下限固定在 10 而只抬高上限，
于是每一个候选的**宽度**都超过 20 kHz，全部被拒；我还据此差点得出"设备什么都不接受"。

改成保持宽度不变、只平移频带之后，规则就很清楚了：

```
2–22    (宽 20)  ✅ 接受        20–40   (宽 20)  ✅ 接受
25–45   (宽 20)  ✅ 接受        70–90   (宽 20)  ✅ 接受
80–100  (宽 20)  ✅ 接受   ← 100 kHz 上限是真的
2–50    (宽 48)  ❌ 拒绝  {"msg":"[HTTP] Set acousic config error","ret":400}
```

**规则：`freq_up_limit − freq_down_limit ≤ 20 kHz`，频带可以整体放到最高 100 kHz。**
所以：
- 手册里的 "bandwidth ≤20 kHz" 指的是**带宽（宽度）**，不是上限频率 —— 原文没错。
- 100 kHz 的上限与硬件一致：设备上报 `samplerate: 200000`，奈奎斯特正好是 100 kHz。
- **机械异音预设（2–50 kHz，宽 48）会被设备拒绝** —— 这是我们刚交付的预设里的一个真缺陷，见 §17.5。

### 17.4 第一条真实检测日志（`reference/fa371-detect-log-sample.json`）

在此之前 `detect_logs` 一直是空数组，所有映射都建立在手册与夹具上。现在有两条真记录了，
一次解决一批悬案：

- **手册声称存在却从未出现过的告警字段确实存在**：`alarm_level: 2`、`alarm_strategy_id: 1`、
  `is_alarm: false`、`last_alarm_db`、`last_alarm_df`（旧规范 §8.3 C15 就此了结）。
- **结果文件是个体 `*_name` 字段**（`power_spect_photo_name`、`bin_mic_data_name`…），
  不是一个 `result_files` 对象。**我们的映射层早就按这个形状写了**（`mappers.ts` 里
  每个 kind 映射到对应的 `*_name`），所以事件中心的下载路径在真机上是对的 —— 这一条是
  好消息，但之前只是"照着手册写的"，现在有真数据佐证。
- **`data_1..data_4` 全为 0/0/0/1**：泄漏量/成本那几个字段在**局部放电版**上就是空的。
- **`start_time`/`end_time` 是 epoch 秒**（1789466155 → 1789466185，差 30 秒），
  与既有假设一致。

### 17.5 真日志暴露的两个映射问题（需要修）

1. **`65535` 是"没有值"的哨兵，不是数值。** `soundmap_intensity: 65535`、`last_alarm_db: 65535`
   —— 典型的未初始化 uint16。当前映射会把 65535 当成真实强度/声压级显示出来
   （"声场强度 65535"），这跟 `NaN` 的处理原则冲突：**没有数据就不该显示成一个数**。
   应该识别该哨兵并按"缺失"处理（至少对 dB / intensity 这两个量纲不可能到 65535 的字段）。
2. **PRPD 与局放概率字段完全没建模。** 真日志里有 `prpd_photo_name`、`prpd_video_name`、
   `probability_corona/creepage/noise/suspen`、`discharge_type`、`alarm_strategy_name`。
   我们的 `Fa371ResultFileKind` 只有 8 种（power_spectrum / soundmap / voiceprint / bin / wav），
   **没有 prpd** —— 也就是说在**局部放电版**（也就是这台）上，设备最主要的产物
   PRPD 图/视频在事件中心里**根本不会出现下载按钮**。这是功能缺口，不是显示瑕疵。

### 17.6 适用范围与"以后要重测"的清单

§13 / §17 里的每一条**模式与端点结论，都只在这台设备上验证过**：
`FE128-ROBOT-PLUS` / RK3568 / `samplerate 200000` / FPGA `V0.5.1.6_251219` /
`work_mode 1`（局部放电版）。换固件、换硬件变体或换采样率之后**必须重测**，尤其：

| 需要重测的结论 | 为什么不能外推 |
|---|---|
| `GET/PUT /system`（`work_mode` 读写） | 端点**未文档化**，只在设备前端 bundle 里发现 |
| `PUT /run_mode` 会清空已启用策略 | 这是本固件的实现行为，不是协议规定 |
| 频带宽度 ≤20 kHz、上限 100 kHz | 上限与 `samplerate` 相关；换采样率就要重新测 |
| `65535` 是缺失哨兵 | 未初始化 uint16 的取值习惯，换固件可能不同 |
| 检测日志的 `*_name` 结果文件形状 | 手册与真机在此**一致**，但形状仍是固件提供的事实 |
| `/system/detect`（未文档化的检测周期参数） | 只读探测过，**写方法从未验证** |

## 18. 决定**反转**：按"设备自带 Web 界面那条 HTTP 路"实装升级（本轮）

§12 与 §15 的结论是"**刻意不做**升级"，理由写得没错：厂家**正式**流程是 SSH/SFTP +
自解压脚本（还有第二段 `k410_4096` 的 FPGA 升级），那是"远程执行一个可执行文件"，
不该塞进桌面应用。但**设备自带 Web 界面走的是纯 HTTP**（`POST /upload` +
`PUT /reboot` + `GET /progress`），那条路是可以实现的。负责人明确要求做这一项，
所以本轮按**那条 HTTP 路**实装，并把两侧的边界写清楚：

**做的**：

| 动作 | 请求 | 说明 |
|---|---|---|
| 选包 + 读包的事实 | （不碰设备） | 文件名 / 大小 / sha256；文件名是否符合**设备自己**的规则 |
| 上传 | `POST /upload`，`multipart/form-data`，**两个段**：一个**空字段名**携带 `{"file_size":N}`，一个 `file` 携带包本身 | 逐字照抄设备前端；超时 1800 s（同样照抄） |
| 读进度 | `GET /progress` | 设备原样返回 `upgrade_progress` |
| 重启 | `PUT /reboot` | **独立动作**，操作员单独确认；上传**不会**自动重启 |

**没做的**：SSH/SFTP、自解压脚本、第二段 FPGA 参数 `k410_4096` —— 都不在软件里。

### 18.1 本轮新的只读实测（2026-09-15 复核）

```
GET /progress（未认证）      → HTTP **200** + {"msg":"No Auth","ret":401}
GET /progress（带 token）    → HTTP 200 + {"msg":"SUCCESS","ret":200,"upgrade_progress":-2.0}
GET /reboot                  → HTTP 404（nginx 风格 404 页）
OPTIONS /reboot              → HTTP 204（无 Allow 头）
```

第一条是本轮才注意到的形状，而且**有实际后果**：这台设备对未认证请求回的是
**HTTP 200** + 正文里的 `ret:401`，所以 `POST /upload` 只看状态码会把"没认证"
报成"上传成功"。实现的判定因此是三层：非 2xx → 失败；正文是网页 → `INVALID_RESPONSE`；
正文是 JSON 且 `ret ≠ 200` → 带设备 `msg` 的失败。

`GET /reboot` 回的是 404（不是 SPA 兜底那种 200 + `index.html`），说明 `/reboot`
由设备 API 处理、只是不实现 GET —— 这与 bundle 里 `en('/reboot')` 是 PUT 一致。

### 18.2 仍然**没有**验证的东西（不要在交付说明里越过这条线）

- `POST /upload` 与 `PUT /reboot` 的**实际行为**：从未调用过（那会真的刷机）。
  交付的是一条**未经真机验证**的刷机路径，界面上的控件也照此措辞（"未见于设备手册"）。
- `upgrade_progress` 的**量纲**：`-2.0` 在空闲时的含义没有文档，所以界面**不换算**
  成百分比，只显示设备原样给的值。
- 升级包与硬件平台/采样率的匹配（V2.0 系列 = RK3568 + 200 kHz）：软件只按设备自己的
  **文件名规则**做预检，不做平台校验 —— 传错包的责任仍在操作员与厂家文档那一边。






