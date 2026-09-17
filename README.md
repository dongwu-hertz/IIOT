# HERTZINNO Acoustic Box Manager — Windows V1.0

面向 HERTZINNO Acoustic Box / FA8 系列设备的**永久免费** Windows 桌面管理软件。
V1 以局域网（LAN）管理为核心，同时在架构上预留未来公网 Server 集中管理。

> 本仓库是 [`HERTZINNO_Acoustic_Box_Manager_Windows_V1.0_Development_Spec_CN.docx`](../HERTZINNO_Acoustic_Box_Manager_Windows_V1.0_Development_Spec_CN.docx)
> 的实现。规格书是**需求基线**，本 README 是**实现基线与进度台账**。

> ### 先看这三份（2026-09-17 整理）
>
> 这份 README 是按 **V1 规格书**的章节写的，**下面的 §1「当前状态」是 V1 当年的台账**，
> 不反映今天的样子。今天的软件已经管**四种设备**：声纹设备（AE08/FA8）、声学相机（FA371）、
> 听诊盒子（E2/FA100/FA110）、**空气声呐（SN-16，含球机联动 PTZ 与离线点位图）**。
>
> | 你想干什么 | 看哪份 |
> |---|---|
> | **了解现在的状态、代码在哪、开新分支**（例如 AI 训练版） | `docs/BASELINE.md` |
> | **人工核对 / 真机验证** | `docs/UI-VERIFY.md` |
> | 查某个设计**为什么**这样（含出处） | `docs/Ivms4200-UX-REFERENCE.md`（顶部有 §15 逐节导航） |
> | 协议实测发现 | `docs/PROTOCOL-FINDINGS.md`、`docs/FA371-*.md`、`docs/reference/` |

---

## 目录

- [1. 当前状态](#1-当前状态)
- [2. 架构与不变量](#2-架构与不变量)
- [3. 快速开始](#3-快速开始)
- [4. 代码结构](#4-代码结构)
- [5. 开发路线图](#5-开发路线图)
- [6. 协议未知项与验证方法](#6-协议未知项与验证方法)
- [7. V1 验收清单](#7-v1-验收清单)
- [8. 多语言（i18n）](#8-多语言i18n)
- [9. 应用账户与权限](#9-应用账户与权限)
- [10. 声学相机（FA371）与事件中心](#10-声学相机fa371与事件中心)
- [11. 给后续开发者的话](#11-给后续开发者的话)

---

## 1. 当前状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| — | 工程骨架、构建链、类型契约 | ✅ 完成 |
| — | SQLite Schema + 迁移 + 仓储层 | ✅ 完成 |
| — | DTO → Mapper → Domain Model 三层分离 | ✅ 完成 |
| — | DeviceAuthStrategy + 运行时策略发现 | ✅ 完成 |
| — | DeviceApiClient（附录 A 全部端点） | ✅ 完成 |
| — | DeviceService + 在线状态监测 | ✅ 完成 |
| — | 存储服务（目录布局、磁盘保护、Retention） | ✅ 完成 |
| — | 日志与密钥脱敏（三路分流已验证） | ✅ 完成 |
| — | 协议诊断探针（Protocol Lab 后端 + CLI） | ✅ 完成 |
| — | Mock FA8 设备 + 端到端诊断验证 | ✅ 完成 |
| — | 测试（863 项） | ✅ 完成 |
| — | 设备状态实时推送（主进程 → 渲染层） | ✅ 完成并验证 |
| Phase 1 | 主窗口、导航、Settings | ✅ 完成 |
| Phase 2 | Device API Layer | 🔄 代码完成，待真机验证 |
| Phase 3 | Device Management | ✅ 完成 |
| Phase 4 | Realtime Feature（`/features_stream`） | ✅ 完成（真机验证 6 帧/6s） |
| Phase 5 | Audio（`/audio_stream`、Ring Buffer、录音落盘） | ✅ 完成（真机录制并验证 WAV） |
| Phase 6 | Spectrum（`/freq_domain`） | ✅ 完成（真机验证 6 帧/6s） |
| Phase 7 | Spectrogram（`/time_freq_domain`） | ✅ 完成（JPEG 序列显示） |
| Phase 8 | Alarm & Recording（告警中心、录音下载与播放） | ✅ 完成（真机下载并解码） |
| Phase 9 | Configuration（通道/采样率/告警/网络/RS485/Modbus） | ✅ 后端+UI 完成，全链路真机验证 |
| Phase 10 | Maintenance（固件上传/重启/恢复出厂） | ✅ 后端+UI 完成（破坏性操作未在真机执行） |
| Phase 11 | Historical Storage（Parquet + DuckDB） | ✅ 完成并端到端验证（含趋势页 UI） |
| — | **相机实时视频**（`GET /system/video` → RTSP → 内置 ffmpeg 转封装 → 本机回环 HTTP → `<video>`） | ✅ 完成：真机取流并**在界面里解出 1920×1080 画面**（`rtsp://192.168.110.235:443/live`，`readyState=4`、2.2 s 内 +29～55 帧、丢帧 0） |
| — | **声学相机接入（FA371）**：HTTP `/login` + Token 鉴权、§5.1 全部端点、§5.2 五路 WebSocket | ✅ 完成：五路真机实测帧率/帧长见 §11 |
| — | **应用账户与权限**：管理员 / 普通用户、强制改密、厂家超级密码找回 | ✅ 完成（见 §9 与 `docs/ACCOUNTS.md`） |
| — | **告警联动**：录像 / 弹窗 / 提示 / 邮件四路动作（默认关） | ✅ 完成：邮件走自研 SMTP，对本地 stub 服务器断言信封与附件字节 |
| — | **事件与告警中心**（`/events`）：相机检测日志 + 联动结果 + 本地告警三源合并 | ✅ 完成：26 项测试，含"三源皆空"的诚实空态与单源失败降级 |
| — | **多路视频墙与设备树**：相机墙 1/4/9/16、通道墙按设备真实通道数给档位（8 路 = 1/2/4/8，2 路 = 1/2）、左侧拓扑选设备 | ✅ 完成：并发上限默认 4，真机 1/2/4 路实测见 §11.4。「共 N 路通道」里的 N 只数**通道**（相机格不算：8 路盒子 + 1 台相机是 8，不是 9） |
| — | **画面格右键菜单**（参考 iVMS-4200）：手动录像 / 抓图 / 全屏 / 复制 RTSP 地址 / 外部播放器 / 叠加信息 / **回放本机录像** / **下载检测记录** / 关闭这一格 / 告警配置 | ✅ 完成：菜单项与按钮**同源**（一个纯函数），不可用则禁用并**在菜单里写出原因**；空格子不开相机菜单。真机实测手动录像启停并登记（8.8 s / 1.9 MB）；回放与下载弹窗**只做了结构接线，未点击实测** |
| — | **画面格外观**：底部播放器控制条（播放/停止、全屏、音量图标 + 滑块）、空格子右侧一个大 `+`（无任何文字）、档位控件右对齐 | ✅ 完成：运行中的窗口里实测控件 `aria-label == title`、空格子文本节点 0 且无可见 `<select>`、`+` 为 44 px 两笔 SVG、档位组 `rightGapPx = 0` |
| — | **界面布局**：设备拓扑归入设备管理、语言开关移入系统设置、右侧底部页脚（版权/网站/版本） | ✅ 完成：四项都由 `demo-shot` 的布局探针在**运行中的窗口**里逐条断言，见 §3.3 |
| — | **界面文案**：删除全部解释性内容（页面副标题、字段提示、说明段落） | ✅ 完成：四种语言共删除 **137 个键**；判定规则与被保留的"功能性文字"清单见 §3.3 |
| — | **总览**：相机墙 1 / 4 / **9** / 16 分屏（通道墙按设备真实通道数给档位：8 路 = 1 / 2 / 4 / 8，2 路 = 1 / 2）；设备总数、在线数、告警数改为右上角图标 + 数字 | ✅ 完成：五张统计卡删除；数字只保留一处，不再与侧栏重复 |
| — | **声学相机控制**：修改检测模式（`GET/PUT /run_mode`）、检测启停、策略启停、固件信息 | ✅ 完成：真机写入并读回验证（见 §10.5）；面板已实测在监测页渲染 |
| — | 多语言安装向导（安装时选择语言，zh-CN / en / es / tr） | ✅ 完成：安装包内确认含 `$PLUGINSDIR\LangDLL.dll`（该插件只服务于 `MUI_LANGDLL_DISPLAY`）；**未**实机跑过向导界面，见 BUILD.md §1.2 |

### 已实测验证的证据

不是"应该能跑"，是**跑过了**：

```
$ npm run typecheck      # 主进程 + 渲染进程双工程，0 错误
$ npm test               # 994 tests / 994 pass / 0 fail
$ npm run build          # out/main · out/preload · out/renderer + 按视图分包
$ npm run smoke
  ✓ main process logged startup
  ✓ IPC handlers registered
  ✓ database created (4096 bytes)
  ✓ logger wrote: app-2026-09-10.log
  ✓ WAL mode active
  ✓ renderer finished loading
  ✓ preload bridge exposed + Vue shell mounted
  ✓ 登录前不挂载外壳（登录闸门真的生效）
  ✓ device-status push channel verified
$ npm run verify:packaged  # 打包产物 25 项全通过（含打包进程内原生模块 + ffmpeg + 四种语言渲染）
```

### 相机：从 RTSP 到屏幕上的一帧，逐段实测

这条链路有五段，每一段都能单独失败；下面每一行都是**跑出来的**，不是推断的：

```
① 设备侧     GET /system/video → video_port=443, video_url="live", rtsp_client_limit=10
② RTSP       rtsp://192.168.110.235:443/live 取到 JPEG 帧 142 KB（ZLMediaKit 2025-05）
③ ffmpeg     应用的原样参数 → 1,417,832 B / 3 s，头部 ftypiso5
④ 回环 HTTP  http://127.0.0.1:<临时端口>/<每会话 token>/stream.mp4（只监听回环）
⑤ 界面解码   node scripts/video-proof.cjs
             readyState 3 → 4 · videoWidth 1920 · videoHeight 1080
             currentTime 0 → 2.03 · totalVideoFrames 4 → 59（2.2 s 内 +55）
             droppedVideoFrames 0 · MediaError null · problems 0
```

⑤ 是唯一无法靠离线测试替代的一段：`<video>` 拿着一个合法地址却解不出画面，
从主进程看和正常播放**一模一样**。所以它有一个专门的 GUI 探针（`scripts/video-proof.cjs`），
它启动真实构建、加真实相机、按真实按钮，然后读 Chromium 自己的数字。

**本次由该探针发现并修掉的真实缺陷**：自动起播只写在总览页当时的单路播放器里，
而设备树的「实时视频」打开的是 `/monitor` —— 同一个产品需求在两条入口上表现不同：
总览页自动出画面，实时监测页停在「视频未启动」等操作员按按钮。现在两页共用同一个
`decideCameraAutoPlay()`，`--observe-only` 模式（不按任何按钮）在两页都是 0 问题。

**总览页的相机区域现在是多格视频墙**（`CameraVideoWall`，1 / 4 / 9 / 16 分屏，每格一台相机，
没有画面的格子是一块**有边框的占位区**而不是黑矩形；空白格右侧只有一个 `+`，
不写任何说明文字）。原本的单路播放器组件已删除 ——
它不再被任何页面渲染，而"测试还在读它的源码"不是保留死代码的理由，所以那三条模板断言
（地址是 `<video>` 的唯一开关、没有地址时同位置渲染占位、切换当前设备不得起流）
改为指向视频墙。自动起播仍只走 `decideCameraAutoPlay()` 一处：总览由视频墙的 `auto-play`
属性调用，监测页有自己那一次。

**并发实测**（`node scripts/camera-load.cjs --streams 1,2,4`，同一台真机、同一台 22 核机器）：

```
streams  ok  峰值 ffmpeg 常驻内存   单路 CPU（utime+stime）/rtime   每路 10 s 码流
      1   1  16.9 MiB               1.2%                            4.2 MB
      2   2  49.7 MiB               0.8% / 0.6%                     4.2 MB / 4.2 MB
      4   4  99.5 MiB               0.7% / 0.9% / 0.4% / 0.5%       3.9 MB × 4
```

`-c:v copy` 不重编码，所以代价几乎只有内存（约 25 MiB/路）与约 0.6% 单核 CPU；
4 路合计约 2.5% 单核。`peakRSS` 由 `Get-Process` 取样，取样次数一并打印——
只有一次取样的"峰值"和二十次取样的"峰值"不是同一个结论。

### 界面布局：四件事"改完了"和"看得见"是两回事

一次产品改动把四样东西搬了家。每一样都可以在源码里"做完"而屏幕上仍然是错的
（组件被 import 却没渲染、拓扑搬了位置却带着侧栏的内边距、页脚画在了滚动容器里面
于是跟着内容滚走）。所以 `scripts/demo-shot.cjs` 里加了一组布局探针，读的是
**运行中窗口的 DOM**，并且用产品的说法来写断言：

```
layout /        : treeInSidebar=false  treeOnOverview=false
                  footerPresent=true  footerIsLastChild=true
                  footerInsideScroller=false  footerBottomGap=0
                  footerText="版权所有 © 2026 HERTZINNO·www.hertzinno.com·info@hertzinno.com v1.0.0·2026年9月11日"
layout /devices : treeOnDevices=true  treeInsidePage=true  treeInSidebar=false  twoColumn=true
layout /settings: langOnSettings=true  langInsidePage=true  langInSidebar=false  options=4
brand probe     : found=true  naturalWidth=224  rendered=45x24  wordmarkPresent=false
problems        : 0
```

四条对应四个要求：拓扑在设备管理内容里、语言开关在系统设置里、页脚贴底且含版权与
版本号、侧栏只留 logo。`footerBottomGap=0` 是"贴底"的度量而不是"看起来差不多"；
`footerInsideScroller=false` 是"不会跟着内容滚走"的度量；`naturalWidth=224` 证明
logo 这张位图**真的解码了**——`complete` 本身不保证这一点，而一张加载失败的图片
既没有控制台报错也没有布局异常，只是不见了，「logo 没了」正是这个改动的风险。

**一处判断，供你否决**：登录页左上角还有同一组文字（`app.title` + `app.tagline`，
即 "HERTZINNO Acoustic Box Manager" / "设备管理软件"）。这一轮**没动它**——第 4 条
说的是应用左上角，而登录页是另一屏。要去掉说一声。

`npm run smoke` 不只是"能启动"检查。主进程健康 ≠ UI 能用：渲染层异常、
preload 桥断裂、Vue 挂载失败都会让主进程日志一切正常而窗口一片空白。所以它同时验证：

- preload 的 `window.api` / `window.events` 真的跨过了 context 边界
- Vue 外壳真的挂载到了 DOM（`.app-shell` 存在）
- **设备状态推送链路真的通**（订阅存活、未知设备 ID 被正确忽略而不抛异常）
- 渲染层没有 console error、没有 preload 错误、渲染进程没有崩溃

同一组探针还负责**多语言**：`npm run verify:packaged` 会在打包后的应用里逐语言
重载窗口并读真实 DOM，断言四种语言文案互不相同、`htmlLang` 同步、没有 `app.*`
键名漏出、发布日期随语言变化（§8.6）。

推送验证通过 `VITE_SMOKE_PROBE=1` 编译进去的自检探针完成，**生产构建中该探针被
死代码消除**（已实测：`window.__hertzinnoSelfCheck` 在 `out/renderer/` 中出现 0 次）。

**六种 Token 携带方式全部端到端自动发现成功**（Mock 设备强制只接受其中一种，
解析器必须自己找出是哪一种）：

```
bearer-header      -> bearer-header
raw-auth-header    -> raw-auth-header
token-header       -> token-header
x-token-header     -> x-token-header
cookie-session     -> cookie-session
query-token        -> query-token
```

**三路日志精确分流已验证**：`app-*.log` / `device-*.log` / `storage-*.log`
各自只收到本作用域的消息。

**告警与录音全链路已在真机验证**（触发真实告警后）：

```
同步元数据          166ms · allSize=10000 · 本页 12 条
域模型映射          CH1 掩码=1 (0b00000001) → 声压级异常  SPL=62.7  主频=93
                    CH2 掩码=2 (0b00000010) → 主频异常    SPL=41.89 主频=0
下载录音            540ms · 3,840,080 B
                    ★ WAV 1ch 96000Hz 32bit IEEE Float, 10.00s
解码                960,000 个 Float32 样本 · RMS=0.002610 → 有真实音频
告警位交叉验证      掩码 1 ×10 次 → SPL 异常
                    掩码 2 × 2 次 → 主频异常
```

**语义自洽佐证**：CH2 那条 `主频=0` 却报"主频异常"看似矛盾，但该条 `SPL=41.89`
远低于 SPL 触发阈值 —— 正说明设备是**按主频判据**触发的，掩码语义与数据互相印证。

**Phase 4-8 真机验收（`npm run device-check`）**

```
认证与身份        ✓ token-header · AE08 · 96 kHz · 8 通道 · 网络
实时流 Phase 4-7  ✓ 特征 6 帧/6s · 音频 60 帧 · 频谱 6 帧 · 时频 6 帧
录音落盘 Phase 5  ✓ 3.0s / 288000 样本 · 有效 WAV · SHA-256 一致 · 相对路径
告警录音 Phase 8  ✓ 10000 条 · 位掩码解码 · 下载 10.00s WAV · 解码有信号
结果              23 通过 / 0 失败
```

音频预览载荷 **3002 字节/帧**，相比原始 38400 字节压缩 **12.8 倍**，
这是渲染层能流畅绘图的关键。

### 尚未验证

诚实清单——这些是**没做过**的，不是"应该没问题"：

1. **打包产物里的相机视频**没有跑过 `video-proof`（探针跑的是 `out/` 目录构建）。
2. **真实告警触发的联动**没跑过 —— 但**原因已经查清并且可以排除**：当时记的理由是
   "设备上唯一那条策略是禁用的，而开放接口没有启停端点"，**这个理由已被 2026-09 的
   《API Workflow》手册证伪**：端点是 `GET/PUT /alarm_strategy_enable`，设备同时只允许启用
   一条策略。所以这条现在从"做不到"变成"还没做"：启用策略 → 触发检测 → 观察真实告警。
   详见 [docs/FA371-API-DELTA.md](docs/FA371-API-DELTA.md) §1。
3. **`detect_logs` 恒为空**：真机返回 `{"detect_logs":[],"logs_count":0}`，所以事件中心
   的相机检测源**没有见过一条真实日志**，`/detectFeedback` 在 9 s 与 15 s 窗口内各 0 帧。
   字段形状来自手册与 Mock，不是真机样本。
4. **`alarm_level` 的枚举**未确认（§8.3 C15：字段在字段表里、示例里从未出现），
   所以严重级别对相机事件一律是 `unknown`。
5. **声学相机之外的第二台真机**：所有分页/多设备结论都建立在 1 台相机 + Mock 上。

见 [BUILD.md](./BUILD.md)。

---

## 2. 架构与不变量

### 2.1 进程与数据流

```
┌──────────────────────────────────────────────┐
│  Vue 3 Renderer                              │
│  · 无网络权限（CSP connect-src 'none'）       │
│  · 无 Node 权限（sandbox: true）              │
│  · 只认 Domain Model                          │
└────────────────┬─────────────────────────────┘
                 │  IPC（白名单，无通用 invoke）
┌────────────────▼─────────────────────────────┐
│  Electron Main Process                       │
│  DeviceService ──► DeviceRepository(抽象)     │
│       │                    ├─ LanDeviceRepository    ✅
│       │                    └─ RemoteDeviceRepository ⬜
│       ├── DeviceApiClient ──► HttpTransport ──► FA8 REST
│       ├── AlarmService / RecordingService     │
│       └── StorageService / SettingsService    │
└────────────────┬─────────────────────────────┘
                 │
      ┌──────────┼──────────┬──────────────┐
      ▼          ▼          ▼              ▼
   SQLite     Parquet     NTFS 音频     日志
  (元数据)   (长期趋势)   (WAV/FLAC)
```

### 2.2 七条硬性不变量

这些不是风格偏好，是**架构约束**。破坏其中任何一条，后期切 Server 模式就会变成重写。

| # | 不变量 | 强制方式 |
|---|---|---|
| 1 | 音频绝不进 SQLite BLOB | Schema 中不存在 BLOB 列；`recordings` 只存相对路径 |
| 2 | 协议 DTO 与业务模型分离 | `protocol/dto.ts` 与 `protocol/mappers.ts` 是唯一同时认识两套词汇的文件 |
| 3 | Renderer 绝不直连设备 | CSP `connect-src 'none'` + preload 无通用 `invoke` + 主进程 `webRequest` 拦截 |
| 4 | 所有设备通信经 DeviceService | `DeviceApiClient` 是唯一构造设备 URL 的地方 |
| 5 | IP 不是设备身份 | `device_uid` 唯一索引；`resolveDeviceUid()` 显式拒绝回退到 IP |
| 6 | 实时音频内存优先 | Ring Buffer 在内存；默认只落盘告警/手动/定时录音 |
| 7 | 认证行为可配置 | `DeviceAuthStrategy` 七种候选，运行时发现后按设备持久化 |

不变量 3 是**四层防御**，任何一层单独失效都不足以打破它：

1. 渲染层 CSP `connect-src 'none'` —— 浏览器引擎层面禁止发起连接
2. preload 只暴露具名方法，**没有** `invoke(channel, ...)` 这种通用逃生口
3. 主进程 `webRequest.onBeforeRequest` 拦截一切非应用自身的请求
4. `DeviceApiClient` 是唯一构造设备 URL 的模块

已实测：渲染层源码中 `fetch` / `XMLHttpRequest` / `WebSocket` 的**实际调用数为 0**
（仅有的两处匹配是解释这条规则的注释），协议字段名泄漏 0 处，组件内告警位运算 0 处。

### 2.3 一个关键设计：把"未知"建模出来

规格书 §19 列了 5 项协议未定义行为，其中 3 项是 High 风险。这些**不能猜**
（附录 C 第 9 条明确禁止假设）。本项目不把它们藏在代码注释里，而是：

1. **显式建模** — `AuthStrategy` 类型本身描述"载体未知"这件事；
2. **运行时发现** — `AuthStrategyResolver` 依次尝试候选并验证，胜出者按设备持久化；
3. **可测量** — Protocol Lab 对真实设备跑只读诊断，把 framing、字段名、路径规则变成数据。

这带来一个反直觉但重要的后果：**规格书里"未定义"的部分，在本项目里是一等公民**。
新增固件行为时，应扩展候选列表或探针，而不是在业务代码里加 `if`。

---

## 3. 快速开始

### 3.1 环境要求

- Node.js ≥ 22
- npm ≥ 10
- **仓库路径不能含空格**（`node-gyp` 限制）。详见 [BUILD.md](./BUILD.md)

### 3.2 首次登录（出厂账户）

安装后启动，会先出**登录界面**。出厂只有一个账户：

| 用户名 | 出厂密码 |
|---|---|
| `admin` | `Hz@123456` |

**首次登录会强制修改密码**（出厂密码是公开信息，继续使用等于没有门禁）。
这组凭据**刻意不显示在登录界面上** —— 印在屏幕上等于告诉站在机器前的任何人怎么进去；
它只出现在文档里，由安装者读一次。

忘记密码时：登录页点「忘记密码」，页面上会显示本机**安装标识**，
把它交给厂家支持换取一串 16 位**超级密码**（每台机器不同）：

```bash
node scripts/recovery-code.cjs AB12-CD34-EF56-7890   # 支持侧签发
```

完整规则（角色权限、密码存储、防爆破、哪些操作需要管理员）见
[docs/ACCOUNTS.md](./docs/ACCOUNTS.md)。

### 3.3 命令

```bash
npm install          # 安装依赖（会自动为 Electron 准备原生模块）
npm run dev          # 开发模式，Vue 热更新 + Electron

npm run typecheck    # 主进程 + 渲染进程双工程类型检查
npm test             # 863 项单元 / 集成测试
npm run build        # 类型检查 + 构建产物到 out/

npm run smoke        # 无头启动冒烟测试（验证主进程真能起来）
npm run diagnose -- --ip 192.168.1.50 --user admin --pass secret   # 真机协议诊断
npm run mock-device  # 启动 Mock FA8 设备（用于离线联调）
npm run device-check -- --ip 192.168.1.50 --user admin --pass <密码>   # 真机验收（37 项）
npm run verify:fa371 -- --host 192.168.110.235 --user admin --pass 123456   # 声学相机验收
npm run platform-check                                  # 平台自检（30 项，Windows 上必跑）

# 只在真机上才能回答的两个问题（都不需要人看着屏幕）
node scripts/video-proof.cjs --route /monitor --seconds 25   # 界面到底解出画面了没有
node scripts/video-proof.cjs --route / --observe-only        # 自动起播（不按任何按钮）
node scripts/camera-load.cjs --streams 1,2,4 --seconds 10    # 1/2/4 路并发的 CPU 与内存

# 界面：逐页截图 + 布局断言 + 四种语言在真实 DOM 上的渲染
node scripts/demo-shot.cjs                                   # 全部路由
node scripts/demo-shot.cjs --route /devices                  # 只跑一个路由

npm run pack:dir     # 未打包目录，用于快速验证原生依赖
npm run dist:win     # Windows x64 安装包（需在 Windows 上执行）
```

### 3.4 没有真机也能联调

```bash
# 终端 1：启动 Mock FA8 设备（故意返回各种"不规范"的响应）
npm run mock-device -- --auth token-header --port 9411

# 终端 2：对 Mock 设备跑完整诊断
npm run diagnose -- --ip 127.0.0.1 --port 9411 --user admin --pass secret
```

Mock 设备刻意模拟真实固件的坏习惯：字段名拼写不一致、数值用字符串返回、
时间戳混用秒与毫秒、单位混用 Hz 与 kHz、报文外层包裹键不固定、
流式端点 framing 与文档不符。**如果诊断工具能描述清楚这台设备，就能描述真机。**

`--auth` 可取值：`bearer-header`、`raw-auth-header`、`token-header`、
`x-token-header`、`cookie-session`、`query-token`。

### 3.5 首次使用

1. 启动后进入 **Settings**，确认 **音频存储目录** 指向大容量磁盘
   （规格书 §4.2：8 通道 192 kHz 原始 PCM 约 **22 GB/小时**，切勿放在系统盘）。
2. 进入 **Devices → 添加设备**，输入设备 IP、端口、用户名、密码。
3. 点击 **测试连接** —— 这一步会真正登录并读取 `/get_devinfo`，
   同时自动发现该设备接受的 Token 携带方式。
4. 添加成功后，**强烈建议先打开 Protocol Lab 运行一次诊断**（见第 6 节）。

---

## 4. 代码结构

```
src/
├── shared/                        # 主进程与渲染进程共享（无环境依赖）
│   ├── domain/
│   │   ├── models.ts              # ★ Domain Model —— UI 唯一认可的数据形状
│   │   └── alarm-mask.ts          # ★ 告警位解码（附录 B 强制单一实现）
│   ├── ipc/contract.ts            # ★ IPC 契约 + RendererApi 接口
│   └── errors.ts                  # 统一错误模型（规格书 §14.2）
│
├── main/                          # Electron 主进程
│   ├── index.ts                   # 入口、窗口、安全策略、退出清理
│   ├── ipc/handlers.ts            # ★ 信任边界
│   └── services/
│       ├── app-services.ts        # 组合根（依赖装配顺序在这里可审计）
│       ├── database/
│       │   ├── schema.ts          # SQLite Schema + 版本化迁移（当前 v5）
│       │   ├── device-repository.ts
│       │   ├── user-repository.ts # ★ 应用账户 + app_meta（超级密码的 installId）
│       │   └── alarm-repository.ts
│       ├── auth/                  # ★ 应用自身账户：scrypt、强制改密、厂家超级密码
│       │   ├── password.ts        #   scrypt 参数与内存预算写在这里
│       │   ├── super-password.ts  #   HMAC(FACTORY_SECRET, installId) → 16 位分组码
│       │   ├── auth-service.ts    #   会话在主进程；事件推送而非轮询
│       │   └── user-repository.ts
│       ├── device/
│       │   ├── device-api-client.ts   # 附录 A 全部端点的唯一封装
│       │   ├── auth-strategy.ts       # ★ 七种 Token 载体候选
│       │   ├── auth-resolver.ts       # ★ 运行时策略发现
│       │   ├── credential-store.ts    # OS 凭据库加密（规格书 §14.1）
│       │   ├── http-transport.ts      # 超时 / 取消 / 错误归一
│       │   ├── device-service.ts      # ★ 业务唯一入口 + 在线监测
│       │   ├── camera-identity.ts     # ★ 相机没有身份端点 → uid 由 ip:port 铸造
│       │   ├── protocol-lab.ts        # ★ 未知协议行为的测量工具
│       │   ├── fa371/                 # ★ 声学相机（FA371）接入层
│       │   │   ├── fa371-api-client.ts    # /login + Token + §5.1 全部端点
│       │   │   ├── fa371-ws-client.ts     # §5.2 五路 WebSocket
│       │   │   ├── fa371-stream-service.ts
│       │   │   ├── camera-alarm-service.ts
│       │   │   ├── detect-library-service.ts  # 检测日志与结果文件下载
│       │   │   └── dto.ts / mappers.ts
│       │   └── protocol/
│       │       ├── dto.ts             # 线上格式（唯一允许出现 hp_spl 等）
│       │       └── mappers.ts         # ★ DTO → Domain
│       ├── alarm/alarm-service.ts     # 告警 / 录音 / Overview
│       ├── events/event-center-service.ts # ★ 三源合并（设备日志 / 联动 / 本地告警）
│       ├── linkage/                   # ★ 设备告警 → 本机动作
│       │   ├── alarm-linkage-engine.ts    #   冷却、分片限流、去重
│       │   ├── alarm-linkage-service.ts
│       │   ├── detect-logs-poll-source.ts #   主动源：轮询 /detect_logs（带游标）
│       │   ├── detect-feedback-source.ts  #   加速源：挂载在既有 WS 上，不开新连接
│       │   ├── smtp-client.ts             #   无依赖 SMTP（net/tls 手写）
│       │   └── linkage-actions.ts         #   录像 / 弹窗 / 提示 / 邮件
│       ├── storage/storage-service.ts # 目录布局、磁盘保护、Retention
│       ├── settings/settings-service.ts
│       ├── media/                     # ★ 相机实时视频：唯一认识 ffmpeg 的地方
│       │   ├── ffmpeg.ts              #   路径解析（dev / app.asar.unpacked）+ -version 探针 + spawn
│       │   ├── rtsp-stream.ts         #   RTSP → 转封装 → 仅回环 HTTP，一路相机一个会话
│       │   ├── camera-capture.ts      #   手动录像 / 抓图
│       │   └── video-file-server.ts   #   录像回放（回环 HTTP + Range）
│       └── logging/logger.ts          # 三路日志 + 密钥脱敏
│
├── preload/index.ts               # contextBridge 白名单桥
└── renderer/                      # Vue 3 SPA
    └── src/{views,components,stores,router,composables}
        ├── components/AppShell.vue    # 侧栏 + 顶栏 + 内容区 + 页脚（四块布局）
        ├── components/AppSidebar.vue  # 品牌（**只有 logo**）+ 页面导航 + 账户
        ├── components/AppFooter.vue   # 版权 / 网站 / 邮箱 / 版本号（贴窗口底部）
        └── components/DeviceTree.vue  # 设备拓扑；挂在 `/devices` 页内，不在侧栏

tests/                             # 863 项测试
scripts/rewrite-aliases.cjs        # 测试产物的路径别名重写
scripts/mock-fa371.cjs             # 声学相机 Mock（--auth-mode / --ws / --seed / --persist）
scripts/video-proof.cjs            # ★ 「界面真的解出画面了吗」——只能靠 GUI 回答
scripts/video-proof-driver.cjs     #   跑在 Electron 主进程里的那一半
scripts/camera-load.cjs            # ★ 1/2/4 路并发的 CPU / 内存 / 码率实测
scripts/demo-shot.cjs              # 逐页截图 + 布局断言 + 四语言渲染（薄启动器）
scripts/demo-shot-driver.cjs       #   ★ 跑在 Electron 主进程里的那一半
scripts/docx-to-text.cjs           # 手册是 .docx 时的转换工具（表格→制表符分隔的行）
scripts/pdf-to-text.py             # 手册是 .pdf 时的转换工具（优先用 pypdf，没有就用标准库 zlib）

docs/FA371-INTEGRATION.md          # 声学相机接入记录
docs/FA371-API-DELTA.md            # ★ 三份新手册带来的增补与**更正**（含被证伪的旧结论、模式真相）
docs/reference/FA371-api-spec.md   # 旧手册逐条批注（1598 行）
docs/reference/api-workflow.txt    # 新《API Workflow》手册全文（由 docx 转出）
docs/reference/practical-guide.txt # 新《Practical Guide》手册全文（由 docx 转出）
docs/reference/leak-detection-manual.txt # 泄漏版手册全文（由 pdf 转出，1.0 MB 文本）
docs/reference/fa371-release-notes.txt   # 软件 Release Notes V2.0.11（200 kHz / 3 目标 / 新告警项）
docs/reference/fe128-upgrade-procedure.txt # 官方升级流程：SSH + 自解压包（系统 + FPGA 两段）
```

> **两个 `*-driver.cjs` 必须保持是普通文件。** 它们曾经都是各自启动器里的一个
> 大模板字符串，也就是「没有任何工具看得见的程序」。这个仓库为此连坏三轮才改过来
> （反引号提前结束外层字面量、转义序列在途中被折叠成真换行、拼接出来的片段挤成一行
> 导致自动分号插入不生效）。注入渲染层的短片段仍然是字符串，但每一个都显式以 `;`
> 结尾，并且先在主进程用 `vm.Script` 编译一遍再发过去。

★ = 承载关键架构决策的文件，改动前请先读该文件顶部的注释。

> **随包分发的第三方二进制**：`@ffmpeg-installer/ffmpeg` 是 `dependencies` 成员，安装包里因此有
> 一个约 **64.5 MB** 的 `ffmpeg.exe`（**GPLv3** 构建：`--enable-gpl --enable-version3`）。
> 它只被 `src/main/services/media/ffmpeg.ts` 以「独立进程 + 管道」的方式调用，用于把相机 RTSP
> 码流转封装成浏览器可播的 MP4。体积与许可证后果记录在 BUILD.md §1 与该文件顶部的注释里，
> 不要在别处再建第二个 ffmpeg 调用点。

---

## 5. 开发路线图

规格书 §17 的开发顺序要求：

> **先把 DeviceApiClient + DeviceRepository + SQLite Schema 打稳，再写实时监控 UI。
> 严禁以页面驱动方式先堆大量 fetch 调用。**

本仓库严格遵循该顺序。下面每一阶段给出**可验证的完成标准**，而不是笼统的描述。

### Phase 4 — 实时特征

**前置**：Protocol Lab 必须先跑通 `/features_stream`，确认 framing（风险 2）。

- `FeatureStreamService`：连接、逐帧解析、断线重连（指数退避）
- `RealtimeFeature` 经 IPC 推送到渲染进程（新增 push 通道，复用 `device:status-changed` 模式）
- 替换 `useSimulatedRealtime` 为真实数据源
- **完成标准**：拔掉网线 10 秒再插回，UI 自动恢复且不重复累积数据点

### Phase 5 — 音频

**前置**：Protocol Lab 必须先确认 `/audio_stream` 的 framing 与采样格式（风险 2，最高优先级）。

- `AudioStreamService`：PCM 解码、Ring Buffer（默认 60 s）
- 播放通道、音量、静音
- 手动录音；告警触发时保存 pre 10 s + post 20 s
- **完成标准**：告警录音文件可用系统播放器正常播放；连续运行 1 小时内存无增长

### Phase 6 / 7 — 频谱与时频图

**前置**：`/freq_domain`、`/time_freq_domain` 的 payload 结构完全缺失（风险 3），
必须先由 Protocol Lab 测出结构或补充协议文档。

### Phase 8 — 告警与录音（音频部分）

- 设备录音下载（`/audio_file/{filename}` 规则待验证，风险 6）
- 本地播放器、频谱回放
- 告警详情页完整化

### Phase 9 — 设备配置 ✅ 已实现

- 通道、采样率、告警参数（**页面只显示友好名称，禁止出现 `dalFBETThre`**）✅
- 网络修改需明确警告断连，并自动尝试连接新 IP ✅ **含失败回滚**
- NTP、RS485、Modbus ✅
- **完成标准**：修改网络参数后，应用能自动在新 IP 上重新连上设备

> 写操作的载荷形状取自设备自身前端代码并已确证（`docs/PROTOCOL-FINDINGS.md` §5A）。
> **未在真机执行写操作**——原因见该文档附录。读路径已全链路真机验证。

### Phase 10 — 设备维护 ✅ 已实现

- 固件上传（`POST /upload`，multipart `file` 字段）、重启、系统升级 ✅
- 恢复出厂设置需**二次确认并要求输入 `RESET`** ✅
- **完成标准**：每个破坏性操作都有确认保护，且确认文案说明后果

> `control_type` 语义已按设备前端的成功提示文案确证（1=出厂 2=重启 3=升级）。
> **未在真机执行**任何破坏性操作。

### Phase 11 — 历史存储 ✅ 已实现

**依赖选择（实测确定，且刻意规避了原生编译）**：

| 用途 | 方案 | 是否需要 node-gyp |
|---|---|---|
| Parquet 写入 | `hyparquet-writer`（纯 JS） | ❌ 不需要 |
| Parquet 读回 | `hyparquet`（纯 JS） | ❌ 不需要 |
| 查询引擎 | `@duckdb/node-api`（官方 **Node-API 预编译**二进制） | ❌ 不需要 |

这**绕开了"路径含空格 / 缺少 C++ 工具链导致 node-gyp 失败"的已知陷阱**
（见 [BUILD.md](./BUILD.md) 第 2 节）。

> **为什么不是 `duckdb` 包**：旧的 `duckdb@1.4.4` 是 V8-ABI 插件，必须为
> Electron 的 ABI 重编；其实测会走**源码编译**（而非命中预编译），而其内置
> DuckDB 源码在当代 MSVC 下编不过（首要是 `fmt` 使用了已被移除的
> `stdext::checked_array_iterator`）。改用 Node-API 包后，同一个预编译二进制
> 在 Node 与 Electron 下都能加载，**彻底移除了对编译器的依赖**。
> 详细实测记录见 BUILD.md 第 2.2 节。

- `TrendStorageService`：内存 Buffer + 批量 Flush（60 秒或 1000 条，禁止每秒开关文件）✅
- DuckDB 查询 + 自动降采样（跨度自适应，1 秒 → 7 天粒度阶梯）✅
- Retention 与磁盘保护联动 ✅
- **端到端测试**：真实 Parquet 读写 + `time_bucket()` 分桶聚合已纳入测试套件
  （`tests/trend-query.test.ts`，5 项），因为 Node-API binding 在纯 Node 下也能加载 ✅

**列类型的关键约束（实测）**：`timestamp` 必须写成 **`TIMESTAMP` 逻辑类型 + BigInt**。
写成 INT64 或 DOUBLE 时，DuckDB 的 `time_bucket()` 会报
`Unimplemented type for cast` —— 即**按时间降采样会直接失效**：

| 写法 | DuckDB 类型 | 时间降采样 |
|---|---|---|
| `TIMESTAMP` + BigInt | TIMESTAMP | ✅ 可用 |
| `INT64` + BigInt | BIGINT | ❌ 转换失败 |
| `DOUBLE` + Number | DOUBLE | ❌ 转换失败 |

---

## 6. 协议未知项与验证方法

> ## ✅ 已完成真机实测
>
> 2026-09-11 对真机 `192.168.110.90`（`devname: AE08`，固件
> `567E68F.2026-06-26_WEEK26.XSUSER.V.1.0.8`）完成只读实测。
> **规格书 §19 的 7 项未知已全部确定。**
>
> **完整报告见 [`docs/PROTOCOL-FINDINGS.md`](./docs/PROTOCOL-FINDINGS.md)。**
>
> ### 最重要的结论：规格书的协议假设大部分是错的
>
> 按规格书直接实现，**连登录都过不了**。实测发现的差异：
>
> | 项 | 规格书假设 | 真机实际 |
> |---|---|---|
> | 登录请求体 | `{username, password}` | **`{msgBody:{username, password}}`** |
> | 密码 | 明文 | **`md5(明文 + "lfxs")`** |
> | 响应信封 | `{code, msg, data}` | **`{message, msgBody, result}`** |
> | 成功判定 | `code === 0` | **`result === 0`** |
> | 实时流 | HTTP `GET` | **WebSocket**（HTTP 返回 404） |
> | 时频图 | 数值矩阵 | **JPEG 图片** |
> | 设备身份 | Device ID / SN | **只有 MAC**（无 SN） |
> | 录音下载 | `/audio_file/{名}` | **`/download_audio/{文件名}`**（错误的路径返回 200 + HTML） |
> | 录音查询体 | 未定义 | **必须 `{msgBody:{page_start,page_size}}`**（空体假装"无录音"） |
> | 写操作信封 | 未定义 | **七个写端点的 `msgBody` 都在真机上证明必需**（值保持写 + 读回）；`set_passageway` 的 `chinfoArray` 是**单个通道对象**，不是 8 条数组（见 `docs/PROTOCOL-FINDINGS.md` §5A.0） |
> | 设备/通道改名 | 规格书未定义 | **`PUT /set_devinfo {msgBody:{devname}}`** 与 **`PUT /set_passageway {msgBody:{chinfoArray:<单个通道对象>}}`**：真机改名、读回、还原均已验证 |
> | 录音编码 | 假设 WAV/16bit | **WAV 32 位 IEEE 浮点、单声道** |
>
> ### 七项风险的处理结果
>
> | # | 未知项 | 结论 |
> |---|---|---|
> | 1 | Token 携带方式 | ✅ `token` 头 或 `Authorization`（**无 Bearer 前缀**）；解析器首次尝试即命中 |
> | 2 | `/audio_stream` framing | ✅ **WebSocket 二进制帧，Float32 小端，单通道，每帧 100 ms** |
> | 3 | `/freq_domain`、`/time_freq_domain` schema | ✅ 前者是 **1024 个 Float32 频点**；后者是 **JPEG 图像** |
> | 4 | 公网 Push 缺 device_id | ✅ Push URL 路径含 `dt_<32hex>` 设备标识；仍建议固件加显式字段 |
> | 5 | 公网告警音频 | ⚠️ 属固件侧改造，非本软件范围 |
> | 6 | 录音下载 URL 规则 | ✅ **`GET /download_audio/{dauFileName}`**（规格书的 `/audio_file/` 不存在） |
> | B | 附录 B 告警 Bit 映射 | ✅ **Bit0=SPL、Bit1=Main Frequency 已实测确认**（掩码 1 出现 10 次、掩码 2 出现 2 次） |
> | 7 | `set_network` 端口 0 语义 | ✅ 真机端口是实值（80 / 28003 / 28001）；`0` 是"未设置"占位 |
>
> ### ⚠️ 实测中发现的运维问题
>
> 真机 `/get_date_push` 显示**四个 Push 通道全部启用**，且都指向公网地址
> `http://8.153.195.75:3000/...`。即**现场设备正在向公网主动上报数据**。
> 部署本软件时应向客户明确指出这一点，Settings 页面也需显著展示当前 Push 目标。
>
> ### ⚠️ 实测中发现的固件安全问题
>
> 1. **Token = `md5(密码 + 固定盐)`**，即 token 是口令派生物，**无过期、无随机数**
> 2. 盐 `"lfxs"` 是**全局固定值**，明文写在前端 JS 里，不提供实际防护
> 3. 全程**明文 HTTP**，token 在每个请求头部反复出现
>
> V1 客户端无法修复，但已记录并建议固件方改为随机会话令牌 + HTTPS。

### 如何自行复现实测

```bash
# 启动 Mock 设备（无需真机）
npm run mock-device

# 或对真机运行只读诊断
npm run diagnose -- --ip <设备IP> --user admin --pass <密码>
```

诊断全程**只读**，不会修改设备任何配置。

---

## 7. V1 验收清单

对应规格书 §18。**每一项都必须用真实设备验证**，不得仅凭单元测试勾选。

### Device

- [ ] 输入 IP 可添加设备
- [ ] 自动读取设备信息（名称、版本、MAC、通道数）
- [ ] 可保存多台设备
- [ ] 在线/离线判断稳定（连续 3 次失败才离线）
- [ ] **IP 改变不生成重复设备**（用同一设备换 IP 后重新添加验证）

### Monitoring

- [ ] CH1–CH8 切换
- [ ] SPL / Main Frequency / Smoothness / Band Energy Ratio 实时显示
- [ ] hr_f / sc_f / sv_f 实时显示
- [ ] 频谱图可用
- [ ] 时频图可用
- [ ] 实时音频可播放

### Alarm

- [ ] 可读取告警
- [ ] Alarm Bit 正确解析（对照附录 B 逐位验证）
- [ ] Alarm Detail 可查看
- [ ] 关联音频可播放

### Configuration

- [ ] Channel 可读可写
- [ ] Sample Rate 可读可写
- [ ] Alarm Parameters 可读可写
- [ ] Network 可读可写（且修改后能自动连回新 IP）
- [ ] NTP 可读可写
- [ ] RS485 可读可写
- [ ] Modbus 可读可写

### Maintenance

- [ ] Firmware Upload 可用
- [ ] Reboot 可用且有确认
- [ ] Factory Reset 可用且需输入 `RESET` 二次确认

### Storage

- [ ] 音频不进入 SQLite BLOB
- [ ] WAV / FLAC 以文件方式存储
- [ ] SQLite 仅存元数据
- [ ] 趋势数据写入 Parquet
- [ ] DuckDB 可查历史趋势
- [ ] Storage Path 可修改且已有数据不失效
- [ ] Disk Protection 生效（低于阈值停止非必要录音）

### Robustness

- [ ] 设备断网/恢复可自动处理
- [ ] 网络请求超时不会导致 UI 卡死
- [ ] App 关闭后无残留连接（检查进程与端口）
- [ ] 日志可追踪错误（三路日志均可用）

### 性能（规格书未量化，本项目的工程目标）

- [ ] TB 级音频文件存在时，数据库体积保持轻量（元数据行数 = 录音数，无 BLOB）
- [ ] 设备列表 50 台时，Overview 加载 < 1 秒
- [ ] 连续实时监测 8 小时，内存增长 < 100 MB

---

## 8. 多语言（i18n）

支持 **简体中文（zh-CN，默认）· English · Español · Türkçe** 四种语言。

### 8.1 架构决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 引擎 | `vue-i18n` 11（纯 JS） | 复数、插值、日期数字格式化现成；无原生依赖，符合本项目约束 |
| 默认语言 | 中文 | 不因升级而改变现有用户看到的语言；其他语言是显式选择 |
| 首次启动检测 | 主进程 `app.getPreferredSystemLanguages()` | Electron 的 OS 语言比渲染层 `navigator.language` 准确 |
| 主进程文案 | **只发错误码，渲染层翻译** | 见下 |
| 语言选择持久化 | `localStorage` + `document.documentElement.lang` | `lang` 会影响断行与字体回退，不只是装饰 |

### 8.2 主进程的 2074 处中文为什么不用逐条改

`shared/errors.ts` 的错误模型本来就带**稳定错误码**（`AUTH_FAILED` 等），
而渲染层所有 IPC 失败都汇聚到**唯一出口** `renderer/src/lib/result.ts`。
因此按错误码翻译这一个函数，就本地化了所有主进程失败 —— 不必把四套语言
打包进一个不渲染 UI 的进程，也不必让语言选择跨越 IPC 边界。

设备自己返回的文本（`DEVICE_ERROR`）**不翻译**：那是诊断信息，用 `deviceDetail`
标注来源后原样呈现，编造一句通用文案反而会掩盖原因。

### 8.3 漏译是编译错误，不是运行时惊喜

四种语言的目录都以中文为参考**强类型**（`shared/i18n/schema.ts`）。
漏一个键 → `vue-tsc` 直接失败。

类型覆盖不到的由 `tests/i18n.test.ts`（22 项）兜住：

- **键集一致**、**占位符一致**（`{count}` 写成 `{sayi}` 能过类型检查，却会把
  字面量 `{count}` 渲染给用户）
- **非参考语言确实翻译过**（防止照抄中文文件后忘记翻译）
- **每种语言都用母语自称**（`Español` 而非「西班牙语」—— 需要切换语言的人
  正在看一个他可能读不懂的界面）
- **域枚举全覆盖**：告警类型、传感器类型、检测模式、录音类型、流类型中
  **每一个成员在四种语言里都有条目**（见 8.6 的键映射表）
- **页面标题守卫**：见 8.5

### 8.4 如何新增一种语言

1. `shared/i18n/locales.ts` 加进 `LOCALES` 与 `LOCALE_DESCRIPTORS`（含**母语名称**）
2. 复制 `messages/zh-CN.ts` 为 `messages/<code>.ts` 并翻译
3. `renderer/src/i18n/index.ts` 的 `messages` 里注册
4. `npm run typecheck && npm test` —— 键集/占位符/未翻译检查会自动校验

### 8.5 已修复的 i18n 缺陷（记录以免重犯）

`AppTopbar` 的标题曾写成 `computed(() => t(route.meta.titleKey))`。
在路由**首次解析完成之前**，`route.meta` 是空的 `START_LOCATION`，
`titleKey` 为 `undefined` —— 而 vue-i18n 不会说"键是 undefined"，
它抛出一个**只有数字位置的 `SyntaxError: 17`，没有调用点**，表现为每次启动
都出现的未捕获组件错误，极难反查。

现在统一走带守卫的 `pageTitle()` / `documentTitle()`，并有回归测试锁住。

**共享层的「中文标签表」** —— `models.ts` 原有 `ALARM_TYPE_LABELS` /
`SENSOR_TYPE_LABELS` / `DETECTION_TYPE_LABELS`、`monitoring.ts` 的
`STREAM_KIND_LABELS`、`release.ts` 的 `formatReleaseDate`。它们都是**中文硬编码**，
却位于一个拿不到当前语言的层：任何页面一旦 import，英文界面里就会冒出中文，
而且 TypeScript 完全不会报错。

现已改为**只导出稳定键**，文本一律由渲染层查表：

| 共享层（键） | 渲染层（文本） |
|---|---|
| `alarmTypeKey()` → `ALARM_TYPE_KEYS` | `alarms.type.<key>`，经 `lib/labels.ts` |
| `SENSOR_TYPE_KEYS` | `domain.sensorType.<key>` |
| `DETECTION_TYPE_KEYS` | `domain.detectionMode.<key>` |
| `RECORDING_TYPES`（联合类型成员即键） | `domain.recordingType.<key>` |
| `STREAM_KINDS`（联合类型成员即键） | `domain.streamKind.<key>` |
| `parsePlainDate()`（纯解析，无语言） | `Intl` 格式化，见下 |

`shared/domain/alarm-mask.ts` 也因此只解码出**类型与键**，不再解码出文案 ——
「UI 不得自己判定位」的规则不变，「UI 自己决定用哪种语言」也得以成立。

发布日期的教训单独记一笔：`formatReleaseDate` 把 `2026-09-11` 渲染成
`2026 年 9 月 11 日`，四种语言都是这一句。替换过程中还发现真正调用它的地方用了
`new Date('2026-09-11')` —— 那是 **UTC 午夜**，格林威治以西会少一天（墨西哥城显示
`10 sept 2026`）。现在由共享层 `parsePlainDate()` 按字段拆开、用本地时区重建
（返回 `Date`，不含任何文案），渲染层再用 `Intl` 格式化：

```
zh-CN  v1.0.0·2026年9月11日     en  v1.0.0·Sep 11, 2026
es     v1.0.0·11 sept 2026      tr  v1.0.0·11 Eyl 2026
```

（上表是 `scripts/demo-shot.cjs` 语言探针在真实窗口里读出来的文本，探针同时断言
非中文语言下**不得**再出现「年/月/日」。）

### 8.6 当前进度与已知限制

**迁移已完成。** `node scripts/i18n-progress.cjs` 的结论是：

```
files with remaining text: 0
user-facing lines remaining: 0
comment lines (not translated by design): 71
```

已迁移区域：

| 区域 | 说明 |
|---|---|
| 侧边栏 / 顶栏 / 路由标题 / 窗口标题 | 含语言切换控件 |
| 总览页 | 指标卡、最近告警、设备状态 |
| 设备管理页 | 卡片、编辑/删除对话框、添加设备对话框 |
| 系统设置页 | 存储、探测、环形缓冲、磁盘占用、趋势存储、关于 |
| 告警记录页 | 筛选、表格、批量确认、详情抽屉 |
| 录音文件页 | 筛选、表格、同步、下载状态、录音播放器 |
| 实时监测页 | 数据流状态条、指标卡、音频、趋势/频谱/时频图、当前帧 |
| 历史趋势页 | 工具栏、图表轴标题、聚合提示、统计、三种空状态 |
| 设备详情页 | 面包屑、8 个配置页签、概览、重命名、设备页面说明 |
| 协议实验室页 | 五项未文档化行为的风险结论、端点探测表、原始样本、诊断报告 |
| 设备配置：全部 8 个子组件 | 时间/NTP、Modbus、RS485、Push、网络、通道/采样率、告警参数、维护 |
| 小组件 | 状态徽章、音频电平表、时频图查看器、模态框、顶栏 |
| 全部错误消息 | 经 `lib/result.ts` 按错误码翻译；各 store 的校验消息亦已迁移 |
| 数字 / 日期 / 相对时间 / 时长 / 时间桶 | 走 `Intl` 与目录，西语土耳其语格式正确 |
| 指标名 / 聚合名 / 告警类型 / 录音类型 / 流状态 / 传感器类型 / 检测模式 / 设备状态 / 连接类型 | 渲染层查表，键来自共享层 |
| 共享域枚举 | 不再含中文标签，只导出稳定键（见 8.5） |

**已知限制**（不打算在本次范围内解决）：

| 限制 | 说明 |
|---|---|
| 说明性注释仍是中文 | 仓库惯例，且不是用户可见文案；进度脚本单独计数 |
| `DEFAULT_ERROR_MESSAGES`（`shared/errors.ts`）仍是中文 | 它是**兜底**：目录里查不到某个错误码时才会用到，是「该补翻译了」的可见信号 |
| `main` 进程的日志/异常文案仍是中文 | 主进程不渲染 UI，且只发错误码；文案仅用于日志与诊断 |
| 设备自己返回的文本不翻译 | `DEVICE_ERROR` 原样呈现并标注来源，见 8.2 |
| 尚无 `de` / `fr` 等语言 | 加一种语言只需 4 步，见 8.4 |

> **进展可自助测量**：`node scripts/i18n-progress.cjs` 按文件汇总剩余的用户可见
> 中文，`--file <路径>` 可列出具体行。它把**注释**与**用户可见文案**分开计数
> —— 本仓库的说明性注释按惯例是中文，不算未翻译工作量；`<!-- -->` 里的中文
> 同样按注释处理。
>
> `demo-shot` 的语言探针会在**真实渲染的 DOM** 上校验：四种语言确实输出不同
> 导航文案、`htmlLang` 同步、没有出现未翻译的键名、且发布日期的格式随语言变化
> （非中文下不得出现「年/月/日」）。`verify:packaged` 则在**打包后的安装版**里
> 做同一件事。

### 8.7 迁移一个页面的标准流程

前三轮反复走同一条路径,记录下来避免每次重新摸索:

1. 在 `messages/zh-CN.ts` 加该页面的 `xxxUi` 块(页面自己的文案)
2. 用 `scripts/catalogue-block.cjs` 把同样的键写入 `en/es/tr` —— 手工同步四种语言必然漏
3. `npm run typecheck && npm test` —— 键集/占位符/未翻译三项检查会报出任何遗漏
4. 组件里 `const { t } = useI18n()`,把文案换成 `t('xxxUi.key')`
5. **标签类数据存键不存文本**:列表/选项/图表轴若在模块顶层构建,存渲染后的
   字符串会冻结在启动语言上
6. `node scripts/i18n-progress.cjs --file <路径>` 应显示 `template=0 script=0`
7. 构建 + `demo-shot` 确认语言切换仍然通过

> **共享文案归 `app.*` / `metrics.*` / `domain.*` / `configCommon.*`,不要放进页面块。**
> 例如"波特率""数据位""停止位"Modbus 与 RS485 都要用,"设备时间/本机时间/偏差"
> 属于时间配置,"传感器类型"来自共享域枚举 —— 放进具体页面就会出现同一概念的多处
> 定义并逐渐漂移。

> **含 `<strong>` 的文案拆成 `...Before` / `...Strong` / `...After` 三段,不要用 `v-html`。**
> 本项目的 CSP 是严格模式,就是为了让"把数据当标记渲染"不成为习惯。中文用全角括号、
> 英文用半角,所以括号本身也应留在各语言的文案里,而不是共享的模板拼接。

> **共享层不要再出现任何 `Record<枚举, string>` 的中文标签表。**
> 它拿不到当前语言 —— 一旦被页面 import,英文界面里就会出现中文,而且**类型检查不会报错**。
> 共享层只导出稳定键(`alarmTypeKey()` / `SENSOR_TYPE_KEYS` / `STREAM_KINDS` / `parsePlainDate()`),
> 文本一律由渲染层查表。`tests/i18n.test.ts` 的 "domain enum coverage" 会在四种语言里
> 逐个校验这些键是否都有条目。

---

## 9. 应用账户与权限

软件有自己的登录：出厂只有一个账户 `admin` / `Hz@123456`，首次登录必须改密。
管理员可以做全部操作；普通用户（`operator`）只能查看与监测，**不能**增删设备、
不能改设备配置、不能进入维护操作。

- 密码用 `scrypt` 存哈希（每密码独立盐，参数写进哈希串），**不是**设备那套 `md5(明文+'lfxs')`
  ——那是固件强制的协议怪癖，仓库里明确标注它不是安全措施。
- 连续 5 次失败锁定 60 秒；锁定期间即使密码正确也拒绝。
- 忘记密码用**每台机器不同**的超级密码找回，由厂家按登录页上的「安装标识」签发：
  `node scripts/recovery-code.cjs <安装标识>`。
- 会话由**主进程**持有；需要权限的 IPC 在主进程重新判定，渲染层说自己是管理员不作数。

完整设计（含"为什么不是一个固定超级密码"、哪些 handler 受保护、审计范围、
以及"恶意渲染层仍可读"这条已知局限）见 **[docs/ACCOUNTS.md](docs/ACCOUNTS.md)**。
FA371 声学相机的接入现状见 **[docs/FA371-INTEGRATION.md](docs/FA371-INTEGRATION.md)**。

---

## 10. 声学相机（FA371）与事件中心

相机与声学箱（AE08）是**两个设备族**，共用一张 `devices` 表，靠 `kind` 区分
（`'acousticBox'` / `'acousticCamera'`）。区别不只是协议：相机没有 `/get_devinfo`
那样的身份端点，所以它的 `device_uid` 由 `ip:port` 铸造（`fa371:<ip>:<port>`），
IP 改了就是另一台设备——这一点与声学箱相反，写在 `camera-identity.ts` 顶部。

### 10.1 接入层的形状

- **HTTP**：`POST /login` 的密码是 `md5(明文 + 'lfxs')`（固件强制，**不是**安全措施），
  返回 32 位十六进制 Token；携带方式仍走既有的运行时策略发现，真机实测接受**裸**
  `Authorization: <token>`，`Bearer` / `token:` / `X-Token:` 也都被接受。
- **WebSocket**：手册 §5.2 五路，握手**不需要鉴权**。真机实测：

  | 通道 | 帧率 | 帧长 | 结构 |
  |---|---|---|---|
  | `/fftData` | 10.06 fps | 2052 B | 4 字节头 + 1024 × int16 LE |
  | `/voiceprintData` | ~10 fps | ~45 KB | **JPEG 600×400** |
  | `/energyData` | 29.92 fps | 20 B | 5 × int32 |
  | `/pcmData` | 10 fps | 19200 B | 4800 × float32（48 kHz，100 ms/帧） |
  | `/detectFeedback` | **0 帧** | — | 类型未确认（见"尚未验证"） |

- **码流**：`/system/video` 给 `video_port=443`、`video_url="live"`、`rtsp_client_limit=10`，
  于是地址是 `rtsp://<ip>:443/live`。`live_rtsp` 这个字段**不可写**（写了不生效）。
  详见 **[docs/FA371-INTEGRATION.md](docs/FA371-INTEGRATION.md)**，
  手册原文与逐条批注在 `docs/reference/FA371-api-spec.md`（1598 行）；
  2026-09 两份新手册带来的增补与**更正**集中在 **[docs/FA371-API-DELTA.md](docs/FA371-API-DELTA.md)**。

### 10.1.1 相机控制面板（`/monitor` 上选中相机时出现）

真机写入并读回验证（192.168.110.235，固件 `V0.5.1.6_251219`，每一步都还原成原值）：

```
检测模式      run_mode  1 → PUT -1 → 读回 -1 → PUT 1 → 读回 1      （真的生效）
告警策略      []  → PUT {switch:1,id:1} → 读回 switch:1
                  → PUT {switch:0,id:1} → 读回 []                 （真的生效）
固件信息      /dev_info → V0.5.1.6_251219 · sdk v8.1.0
              /basic    → WEBV10.2.5 · 上次升级 2026-09-14_06:56:47
```

**"检测模式"有三个层次，都能改** —— 但入口不同，别混为一谈：

| 层次 | 含义 | 端点 | 软件能否修改 |
|---|---|---|---|
| **运行模式** | 每次检测的行为方式 | `GET/PUT /run_mode`：`1` 单次检测 / `-1` 智能巡航 | ✅ 能 |
| **应用模式** | 设备工作在哪一类应用上 | `GET/PUT /system`：`work_mode` `1` 局放 / `2` 气体泄漏 / `3` 机械异音 | ✅ 能（**端点未文档化，实测确认**） |
| **场景参数** | 该类应用的推荐成像参数 | `PUT /system/acoustic` + `PUT /system/image` | ✅ 能（三个场景预设） |

```
应用模式实测（2026-09-15，每一步都还原）
1 → PUT /system {"work_mode":2} → 读回 2  ✅
1 → PUT /system {"work_mode":3} → 读回 3  ✅
  → PUT /system {"work_mode":1} → 读回 1  ✅ 还原
六个端点逐字节比对：其余配置全部未变
```

**这里我犯过一次必须记下来的错误。** 早先的结论是"应用模式**不能**改"，理由是：两份手册都写
「出厂只启用一种，需要另一种请联系技术支持」，猜的路径全 404，而且设备自家前端里
`work_mode` 的四处引用**全是读**。**这些观察都是真的，但推论是错的** —— 设备前端没有控件
≠ 固件没有端点。更该批评的是**表述**：当时写的是"不能写"，而真实状态只是"**没测过**"。
**没有实测过的否定结论，不能写成事实。** 后来按用户要求做了一次可逆实测，一次就推翻了。
详见 [docs/FA371-API-DELTA.md](docs/FA371-API-DELTA.md) §13.2 / §13.3。

另外三点：
- **切换应用模式不会自动改成像参数**，这是刻意的 —— 一次模式切换顺手改写客户的成像配置
  是个很坏的意外。面板上两者是分开的两个控件。
- 手册那句"请联系技术支持"描述的是**商务/服务流程**，不是技术限制。
- `/dev_info` 的 `device_version` 给的其实是 **FPGA** 版本（`V0.5.1.6_251219` = Release Notes
  V2.0.11 那一版的 FPGA），不要当成软件版本。

**写入一律不信任成功码。** 每次写操作之后都**重新读取**设备的值，并把它交给界面；
返回的形状是 `{ requested, before, after, applied }`，`applied = after === requested`。
这不是洁癖：这台设备曾经对 `PUT /alarm_strategy {"Switch":1}` 回过 `ret:200` 而什么都不做，
而那次误信成功码直接导致我们把"策略启停"整条能力误判成"设备不支持"（见
[docs/FA371-API-DELTA.md](docs/FA371-API-DELTA.md) §1）。面板在读回值与请求不一致时
明确显示「设备应答成功但没有生效」。

**「开始检测」被禁用是有原因的**：手册要求调用前必须有一条已启用的策略，否则
`POST /turn_on_detect` 返回 `ret:-1`。面板因此把"启用策略"作为前置条件，而不是让按钮点了失败。

**升级没有做，这是有意的。** 端点确实存在（`POST /upload` + `PUT /reboot` + `GET /progress`，
从设备自带前端 bundle 里读出来的），但**手册没有写**，而且**没有任何固件文件可以验证** ——
一条无法在交付前验证的刷机路径，风险不是"功能不工作"而是"把设备刷成砖"。
面板因此给出禁用按钮 + 悬停原因，并保留「打开相机 Web 界面」入口。
要真正实现上传，需要一个明确的决定，见 [docs/FA371-API-DELTA.md](docs/FA371-API-DELTA.md) §12。

### 10.2 事件与告警中心（`/events`）

一页看全三类事件，按时间倒序合并：

| 源 | 来自 | 谁能确认 |
|---|---|---|
| `deviceDetect` | 相机 `GET /detect_logs` | **不能**——设备没有"确认"这个端点，界面如实说 `unsupported` |
| `linkage` | 主进程的联动结果（`PendingAlarmRecord`） | 可以（`AlarmLinkageService.acknowledge`） |
| `localAlarm` | 声学箱自己的 `alarms` 表 | 可以（`AlarmRepository`） |

三源合并在**主进程**里做，不是一条 SQL：三个源分属三个所有者（设备 HTTP / 内存里的
待处理列表 / 本地 SQLite），只有最后一个是可 SQL 分页的。逐源有上限，超限时
`truncated` 如实置位，绝不静默丢。任一源不可达时另外两源照常渲染，
失败以**逐源状态**返回，不吞掉也不让整页变空。

「视频手动下载」在这里：某条检测日志若带 `result_files`，每个文件一个下载按钮，
落盘后经 `upsertRemote({ remoteRecordingId: 'detect:<logId>:<kind>' })` 登记，
所以重复下载是幂等的、已有文件不会被覆盖。容器格式只按扩展名判定，
认不出来就存 `unknown`——**不猜**。

### 10.3 告警联动（默认关闭）

设备告警在本机触发的四个动作：**录像**（ffmpeg 截一段 MP4）、**弹窗**
（`focusable: false` + `showInactive()`，抢不走键盘）、**提示**（主进程持久化的待处理
列表，跨页面存活）、**邮件**（无依赖的手写 SMTP，带抓帧附件）。

事件身份是 `deviceId:logId:startTime`，**不是**到达时间：到达时间是观察者的属性，
轮询源与 WebSocket 源会得出不同的值，去重就失效了。`start_time` 参与是因为手册 §8.3 E11
说设备只保留最近 100 条并回收 id。两个源共用同一个身份函数，引擎里的那个 Set 是唯一的判定点。

### 10.4 数据库：v5 迁移把一句假话删掉了

v5 之前，一段相机 MP4 在这张表里只能写成 `audio_format = 'wav'`——因为 migration 1
的 CHECK 只允许 `wav`/`flac`，而 SQLite 不能就地放宽 CHECK。代价是**这一列在说谎**，
于是每个读取方都必须知道它在说谎（靠 `event_type` 自由文本 + 路径扩展名两侧兜底）。

v5 重建了 `recordings`：`audio_format` 变成**可空**（非音频文件存 `NULL`，这是"已知的没有"，
不是"不知道"），新增 `container_format` 说明磁盘上到底是什么，两者都保留 CHECK。
`'unknown'` 是**合法取值**——否则代码又会被逼回猜测，而那正是这次迁移要消除的东西。
迁移过程有测试：手工造一个 v4 库、塞进视频行与音频行，再迁移，断言只剩音频行还带 `audio_format`。

---

## 11. 给后续开发者的话
五条最容易踩的坑，都写在这里省得你踩：

1. **不要在 Vue 组件里加 `fetch`。** 哪怕只是"临时调试一下"。
   CSP 会直接拦掉它，而且它会绕开整个 Repository 抽象 —— 这正是规格书
   反复警告的"后续远程模式会导致大规模重构"。

2. **不要在 UI 里判断告警位。** 一律用 `@shared/domain/alarm-mask` 的函数。
   位运算分散到各处后，附录 B 的变更就变成了考古工作。

3. **不要把 `0` 当成"没有数据"。** 映射器对缺失指标返回 `NaN`，
   UI 对 `NaN` 显示 `—`。这是刻意的：SPL 缺失显示成 `0 dB`
   会让运维误判为"设备很安静"，而真相是"设备没上报"。

4. **不要用模板字符串生成一个程序。** 不是风格问题，是它**没有任何工具看着它**：
   类型检查、lint、编辑器的解析都看不到生成的代码。这个仓库为此付过学费——
   `scripts/video-proof.cjs` 曾经把跑在 Electron 里的驱动写成一个大模板字符串，
   连着四轮以四种不同方式坏掉（反引号提前结束外层字面量、`\n` 在途中被折叠成真换行、
   拼接出来的片段挤成一行导致 ASI 不生效、以及 Electron 把那一切都报成
   "Script failed to execute"）。现在驱动是 `scripts/video-proof-driver.cjs`，
   一个 `node --check` 看得见的普通文件；真正生成出来的只剩两行 wrapper。
   注入渲染层的片段仍然是字符串（它们只能是字符串），所以每一句都显式写 `;`，
   并且**先在主进程用 `vm.Script` 编译一遍**再发过去。

5. **不要用 PowerShell 内联命令做校验。** PowerShell 会把反引号当转义字符，
   于是那条命令会被悄悄改写成另一条——它可能通过，而它本该检查的文件是坏的。
   （真的发生过：`node -e` 里带正则的驱动检查"通过"了，文件其实是坏的。）
   要检查代码就写一个 `.cjs` 文件去跑，或者用 `node --check <文件>`。

遇到规格书未定义的行为，**不要猜**。先扩展 Protocol Lab 去测量它。
