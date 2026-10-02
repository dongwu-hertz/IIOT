# 存储方案设计：设备侧存储配置 + PC 存储池（解耦）

> 状态：**方案（未实施）**。业主 2026-09-26 提出需求：
> 「对于声学相机和一些录音的接入，需要相机支持存储配置，支持接入 IPSAN、NAS、云存储等不同的模式，
> 如果需要在 PC 上建立存储池，那么这个软件应该是和管理软件解耦的。你看看应该怎么去做」

---

## 0. 结论摘要（先看这一段）

1. **需求其实是两件互不相干的事，必须分开做**：
   - **A. 设备侧存储**：让*相机自己*录到 SD / NAS / IPSAN / 云。这需要**相机固件提供接口** ——
     现有 FA371 **文档里零命中**（无 SD/容量/格式化/NAS/iSCSI/云/FTP/录像计划/ONVIF），
     且**没有连续录像**，设备侧只有"每次检测的产物文件 + 环形覆盖"（见 §1.1）。
     所以 A 的第 0 步不是写代码，而是**真机探测 + 出固件接口规格**。
     ⚠️ **措辞纪律**：仓库自己的规矩是"断言某能力**不存在**必须有一行实测记录"
     （`docs/FA371-API-DELTA.md:345-346`），所以本文对 NAS/iSCSI/云一律写
     **"文档零命中 / 未探测"**，不写"设备不支持"。
   - **B. PC 侧存储**：我们的录像/抓图/录音落在 PC 侧的哪里。这一半**现在就能做**，
     而且有一大块**零代码即可交付**：把存储根指到 Windows 已经挂好的 NAS/iSCSI 卷就能用（§3.1）。
2. **"PC 存储池"要做成独立服务**（`hais-storage`），HAIS 只是它的一个客户端 —— 这是业主
   说的"解耦"，也是唯一能让"管理软件升级/重启"不打断录像与第三方录音接入的形态（§4）。
   ⚠️ **但仓库里已经有一条劝退决策要先对齐**：iVMS 的「云 / P2P / 注册管理服务器 / 流媒体服务器」
   已被明确不抄（`Ivms4200-UX-REFERENCE.md:571` C2，理由是它会推翻 `connect-src 'none'`
   这条"单设备直连"的安全设计）。所以**"挂载卷 / 业主自建本地池 / 公有云"是三件不同的事**，
   结论分别是"现在就能用 / 需业主点头 / 不做或改判" —— 见 **§4.0**，这一节必须先读。
3. **抽象只做到文件系统这一层**（本地盘 / NAS 挂载卷 / iSCSI 卷都算），**不要**把对象存储
   （S3/OSS）混进同一个接口：对象存储没有 `rename`，而现在的落盘靠"写临时文件 + rename"
   保证"不会留下半截可播放的录音"（`storage-service.ts:255-262`）。云存储按**冷层归档同步器**做（§4.4）。
4. 分四阶段：**探测（1 天）→ 抽象与设置（1–2 周）→ 独立池服务（2–3 周）→ 云归档 + 设备侧（看固件排期）**（§6）。
5. **改造不许放宽既有硬规则**：录像/抓图/录音的命名（时间戳在前、字典序 == 时间序、**永不覆盖**）、
   入库只存**存储根相对路径**、保留天数与最小剩余空间的磁盘护栏 —— 文档明确写着
   "我们比 iVMS 严格，**不要往回退**"（`Ivms4200-UX-REFERENCE.md:486,513,596`）。

---

## 1. 现状事实（都是仓库里已经确证的东西，带出处）

### 1.1 设备侧：文档里零命中存储配置，且没有连续录像

| 事实 | 出处 |
|---|---|
| FA371 的 API 规格里**没有**任何存储/NAS/iSCSI/云相关端点；与"存储"沾边的只有 `POST /upload_nc`（上传噪声比对文件） | `docs/reference/FA371-api-spec.md`（5.1.30；全文件搜 sd/disk/storage/record/ftp/upload 只命中它） |
| 相机手册正文里搜不到 SD 卡 / TF 卡 / NAS / iSCSI / 云存储 / FTP 上传的任何字样（`FTP` 0 命中；6 处 `SFTP` 全在升级流程里） | `docs/reference/FA371-manual-en.txt`、`manual-v7-extracted.txt`、`leak-detection-manual.txt`、`practical-guide.txt` |
| 设备侧存储的**唯一原文**："limited storage space … only keep the file information of the last **100** detections … cyclic storage"（另一份文档写 **50**，两处数字冲突且是否可配未知） | `FA371-manual-en.txt:310`；`api-workflow.txt:419`；`FA371-api-spec.md:1638`（E11） |
| 手册自己就建议外部归档："plan external archiving if longer retention is required"、"Implement external archival before the device record ring reaches its retention limit" | `manual-v7-extracted.txt:323`、`:593`；`practical-guide.txt:602-604` |
| **「FA371 没有连续录像存储」**、手动录像是操作员自己的文件而不是设备的录像计划 | `docs/Ivms4200-UX-REFERENCE.md:332`、`:482`；`docs/USER-MANUAL.zh-CN.md:644` |
| 相机固件是自研的（RK3568 + nginx + SPA + `programs/`/`clib`/FPGA），**没有** ISAPI/ONVIF/GB28181 的痕迹 —— 也就是说没有现成的 OEM 存储层可以蹭 | `docs/FA371-API-DELTA.md:246,409,435`、`docs/FA371-MAINTENANCE-PROBE.md` |
| 设备侧**反向写文件**只有两条：`POST /upload`（固件包）与 `POST /upload_nc`（比对文件），**都从未在真机调用**；没有通用文件写入 | `FA371-API-DELTA.md:167-190,585-592`；`FA371-api-spec.md:1038-1072` |
| 相机侧确实有文件系统（能下载"检测结果文件"），但那是检测产物（jpg/mp4/bin/wav），不是录像时间轴 | `src/shared/domain/camera-nvr.ts:44-47`（`download-detect`）；`FA371-api-spec.md:733-740` |
| 声纹盒（AE08）侧的告警音频文件在设备上形如 `/media/sdcard0/audio_library/...`，**仅供展示、不可 web 访问**，只能通过 `/get_alarm_audio` 列表 + `/download_audio/{file}` 拉下来 | `docs/PROTOCOL-FINDINGS.md:631,644,649-686` |

**"从设备回捞"的三条路都已经存在且形状已知**（这是 A 与 B 之间唯一现成可复用的机制）：

| 设备族 | 列表 | 取文件 |
|---|---|---|
| 声学相机 FA371 | `GET /detect_logs`（实测通过） | `GET /detect_file/{saving_path}/{file_name}`（仅手册） |
| 声纹盒 AE08 | `PUT /get_alarm_audio`（实测通过） | `GET /download_audio/{dauFileName}`（实测通过） |
| 声呐 SN-16 / 听诊 E2 | `GET /alarm_log_all`（实测通过） | `GET /static_file/<saving_path>alarm.wav` / `1..3.jpg`（真机抓图 0 张，见 `UI-VERIFY.md:633`） |

**结论**：A（设备侧存储配置）目前**无接口可调**（文档层面零命中，真机未探测）。
可做且有明确价值的是**把设备产物按策略回捞并归档到 PC 侧的池**（手册自己就建议外部归档）——
它绕开环形覆盖，且完全用现有接口。不要把"界面上放一个 NAS 配置表单"当成已实现：
没有固件支持，那个表单无处可写。

### 1.2 PC 侧：一个可迁移的存储根 + 相对路径入库（这块底子是好的）

| 事实 | 出处 |
|---|---|
| 布局固定：`<root>\{audio,video,snapshot,detect,metrics,spectrum_cache,spectrogram_cache,export,logs}\` | `src/main/services/storage/storage-service.ts:37-63` |
| DB 里存的是**相对 `<root>` 的路径**，所以"换一块大盘"是**设置变更而不是数据迁移** | `storage-service.ts:18-21`；`recordings.relative_path`（`db/alarm-repository.ts:472,543`） |
| 落盘用"临时文件 + rename"保证不出现半截文件；有路径越界守卫 | `storage-service.ts:255-262`、`:241-252` |
| 磁盘不足有 `DISK_FULL` 拦截（相机录像前判一次） | `src/main/services/media/camera-capture.ts:332` |
| 存储根是设置项，改了会广播 `storage-root-changed` | `src/main/services/settings/settings-service.ts:409,418-419` |
| 第三方接入（`services/ingest`）目前**只收遥测**（HTTP/MQTT JSON），**不支持文件/音频接入** | `src/main/services/ingest/{iot-ingest-service,telemetry-intake,mqtt-codec}.ts`（搜 audio/file/upload/multipart 无命中） |
| **保留策略已经有了**：录音保留天数 + 最小剩余空间（GB，低于阈值自动暂停非必要录音并提示）+ 磁盘占用（已用/总量/本程序占用） | `docs/USER-MANUAL.zh-CN.md:575`、`:649`；`docs/BASELINE.md:100-106` |
| **命名与寻址是硬规则，不许放宽**：`<root>/<kind>/<DEVICE_UID>/<YYYY>/<MM>/<DD>/<时间戳>[_标签][_序号].<ext>`，时间戳在前（字典序 == 时间序）、**永不覆盖**、入库只存存储根相对路径 —— 文档明确写着"我们比 iVMS 严格，**不要往回退**" | `docs/Ivms4200-UX-REFERENCE.md:486,513,596`；`docs/BASELINE.md:100-102` |
| `alarms.snapshot_dir`（v12）把抓图目录也按**存储根相对**落库，并有"有图 / 设备本来就没拍 / 库里记着但盘上没了"三态 | `Ivms4200-UX-REFERENCE.md:3378-3390` |

**结论**：B 缺的不是"写文件的能力"，甚至不是保留策略（那些**已经有了**），而是三件东西：
**（1）"存储目标"这个概念**（现在只是一个路径输入框，没有"这是本地盘 / 网络卷 / 池"的语义）、
**（2）网络存储的诚实性**（卷掉线、写满、rename 语义变化时怎么表现；"临时文件 + rename"在 SMB 上是否仍原子**未验证**）、
**（3）池与共享**（多盘、多客户端、集中保留、第三方录音不经管理软件入库）。
改造时**必须原样保住**上面那两条硬规则（命名/寻址、相对路径入库）与既有的保留/磁盘护栏。

---

### 1.3 改造面：注入点、必须一起动的调用者、以及现在就不一致的地方

只读勘察（本文件写作当天）得到的精确改造面 —— 这决定"抽象与设置"那一阶段到底要动多少地方：

| 项 | 事实 |
|---|---|
| **唯一注入点** | `new StorageService({ db, getStorageRoot: () => string, getMinFreeBytes: () => number })`（`storage-service.ts:67-73`）。根与阈值都是**闭包现读**，所以"换目标"不需要重建服务；但**要新增一个后端参数**，就要改这个 options 与两处构造（`app-services.ts:287-291` 引导实例、`:389-393` 真正的那个） |
| **持有者** | 10 个服务以具体类 `StorageService` 注入：录音、回放、告警、相机采集、检测库、E2 同步、E2 设备、告警联动（+联动动作）、趋势落盘、趋势查询。改成接口要一起动（或者保留类名、把实现换成后端委托，改动面更小） |
| **已有的鸭子类型缝隙** | 仅 1 处：`EventCenterService` 只依赖 `{ resolve(relativePath): string }`（`events/event-center-service.ts:135,285`）—— 说明"窄接口"这条改写路子在本仓库是可行的 |
| **绕过 StorageService、直接拼存储根的写路径** | **2 处**：趋势 CSV（`handlers.ts:2885`）与地图瓦片缓存（`map/tile-cache-service.ts:104-105`）；日志目录也直拼（`app-services.ts:294`）。**这三处不纳入后端抽象，池就会静默漏掉它们** |
| **目录清单与真实写入不一致** | 声明了 `export`（单数，`storage-service.ts:61`）但**没有任何写入方**；真实趋势 CSV 落在 `exports/trends/`（复数）。另外 `spectrum_cache/`、`spectrogram_cache/` 只被创建与清理，**全仓无写入方** |
| **保留策略的真实语义（2026-10-01 起）** | 启动 + **周期清扫**（`RETENTION_SWEEP_INTERVAL_MS`）；容量优先三档 + 非保护告警按天；`manual` 永不自动删；`TrendQueryService.enforceRetentionForAllDevices()` 已接入启动/周期清扫，见 §9.9 |
| **换根后的动作** | `SettingsService` 会 emit `storage-root-changed`，但**全仓无订阅者**；实际动作只有 IPC handler 调一次 `ensureLayout()`（`handlers.ts:599`）。不迁移、不校验新根、不保护进行中的写入 —— 网络卷掉线时今天**没有任何提示** |
| **磁盘护栏的不一致** | `diskUsage()` 在 `statfs` 失败时**降级为"永不拦"**（`freeBytes = MAX_SAFE_INTEGER`）；`usedByAppBytes` **只统计 `<root>/audio`**；**无护栏**的写盘路径有 5 条（相机抓图、检测库下载、趋势 parquet、瓦片缓存、趋势 CSV）；另有两处 `DISK_FULL` 判据实际不可达（`canRecord('manual')` 恒 true） |
| **删除能力** | **没有"删除录像"功能**（`deleteRecordings` 权限在 `PERMISSION_WITHOUT_ENFORCEMENT` 名单里，界面文案自认"还没有这条通道"）；`RECORDING_DOWNLOAD` 通道**无 handler**，是死通道；唯一另存是 `RECORDING_EXPORT`（copyFile 到用户选定路径） |

**对方案的含义**：阶段 1 的正确做法是**保留 `StorageService` 这个类名与调用面**，把它的内部实现改成
"委托给一个 `StorageBackend`"（默认 `LocalDirBackend`，行为逐字不变），顺手把上面那 2 条绕过路径
收编进来；而不是去改 10 个持有者的类型。这样阶段 1 的验收就真的能是"现有行为零变化"。

---

## 2. 需求拆解（把两件事的边界先钉死）

```
                    ┌──────────────────────── 现场 ────────────────────────┐
  ┌──────────┐      │  ┌────────────┐        ┌──────────────────────────┐  │
  │ 声学相机 │──────┼─▶│ 设备侧存储 │  A:    │ SD / NAS / IPSAN / 云    │  │
  │ FA371    │ RTSP │  │ （固件）   │  待固件 └──────────────────────────┘  │
  └──────────┘      │  └────────────┘                                      │
                    └──────────────────────────────────────────────────────┘
  ┌──────────┐        ┌──────────────────────────────────────────────────┐
  │ 声纹盒   │───────▶│  PC 侧：HAIS 采集/接收                            │
  │ AE08     │ HTTP/WS│   音频(告警/手动) · 相机录像 MP4 · 抓图 JPEG      │
  └──────────┘        │   检测结果文件 · 趋势 parquet · 导出              │
  ┌──────────┐        └───────────────┬──────────────────────────────────┘
  │ 第三方   │  文件  ┌───────────────▼───────────────┐   B: 现在就能做
  │ 录音设备 │───────▶│  hais-storage（独立服务）      │
  └──────────┘        │  池 · 水位 · 保留 · 校验 · 归档│──▶ S3/OSS（冷层）
                      └───────────────────────────────┘
```

- **A 的验收人是设备/固件方**：接口有没有、按不按连接分通道式的"设备自己录"。
- **B 的验收人是我们**：录下来的东西在哪儿、掉线/写满时说不说实话、第三方录音能不能不经过管理软件就进来。

---

## 3. 方案 A：设备侧存储配置

### 3.1 第一步永远是探测，不是写界面

现成工具链就能做（仓库里已有 `scripts/device-check.cjs` / `scripts/verify-fa371.cjs` /
协议实验室的"自定义路径探测"，**只读**）。但**必须绕开这台固件的探测陷阱**：

> ⚠️ **`FA371-MAINTENANCE-PROBE.md:15-30`：未定义路径有两种失败形状** —— `/system/*` 回**真 404**，
> **其它任何路径回 `200` + SPA `index.html`**。也就是说"猜一个 `/storage` 拿到 200"**完全不能**
> 说明端点存在（`PROTOCOL-FINDINGS.md:651-654` 的 `/audio_file/{filename}` 就是这么骗过一次的）。
> 所以探测的判据必须是**响应体形状**（JSON / 明确的字段），不是状态码；命中 HTML 一律记"不存在"。

建议的探测清单（按可能性排序，命中就以 JSON 形状为准）：

```
/storage  /storage/info  /storage/status  /disk  /disk_info  /get_disk  /sd  /sdcard
/record  /record_conf  /recorder_conf  /record_plan  /playback  /video_file
/nas  /nfs  /smb  /cifs  /iscsi  /iscsi_conf  /cloud  /ftp_conf
ISAPI 风格：/ISAPI/ContentMgmt/Storage  /ISAPI/System/Network/...   （本固件无 ISAPI 痕迹，权重低）
ONVIF：    /onvif/device_service  /onvif/media_service              （同上）
```

顺带要抓的两件事（都直接决定方案）：

1. **设备写检测产物时的行为**：检测结束后立刻调 `GET /detect_logs` 可能拿不到记录
   （分析 + 保存需数百毫秒，1–10 秒后更稳，`FA371-API-DELTA.md:236-238`）—— 回捞归档的调度要按这个来。
2. **取文件的鉴权形态**：`GET /detect_file/...` 是否需要 `Authorization` 头**文档未说明**（C17）；
   而声纹盒的 `GET /download_audio/{file}` **完全不需要认证**（`PROTOCOL-FINDINGS.md:685,1128`）——
   这是固件侧的认证缺口，归档功能的凭据设计要按"设备可能不许鉴权"来做。

把结论写进 `docs/PROTOCOL-FINDINGS.md`（新增一节 §6A "存储能力探测"）：
**无论"有"还是"没有"都要写** —— 按仓库规矩（`FA371-API-DELTA.md:345-346`），
"没有"必须有一行实测记录才算结论。

### 3.2 若固件要加：给厂家的接口规格（建议草案）

模式不同，语义差别很大，接口应当按"目标 + 测试 + 容量 + 状态"四件事给：

```
GET    /storage/info            -> { media: [{ id, kind: 'sd'|'usb'|'internal',
                                              totalBytes, freeBytes, fsType, health }],
                                     activeTargetId }
GET    /storage/targets         -> [{ id, kind: 'sd'|'smb'|'nfs'|'iscsi'|'s3', enabled, params, state }]
PUT    /storage/targets/{id}      body { kind, params: {...}, enabled }      # 幂等写
POST   /storage/targets/{id}/test -> { ok, latencyMs, writeBytes, reason }    # **必须能"测试连接"**
DELETE /storage/targets/{id}
POST   /storage/format            body { mediaId }                            # 破坏性：要二次确认
GET    /record/plan             -> { enabled, mode: 'continuous'|'event'|'manual',
                                     targetId, preSeconds, postSeconds, retentionDays }
PUT    /record/plan                                                           # 录像计划
GET    /record/clips?from&to&channel -> [{ id, channel, startAt, endAt, bytes, targetId }]
GET    /record/clips/{id}/download  (Range 支持)                              # 远程回放/下载
```

各模式的参数（**要在界面上分开写清，不能混成一句"存储地址"**）：

| 模式 | 参数 | 谁挂载 | 备注 |
|---|---|---|---|
| SD / USB | 无（只读容量 + 格式化） | 设备 | 容量小、寿命有限；**格式化是破坏性操作**，必须二次确认 |
| SMB/NAS | `host, share, subPath, username, password, domain, smbVersion` | **设备** | 共享必须是设备能写的路径；凭据在设备上落盘 = 安全面 |
| NFS | `host, exportPath, version, uid/gid` | **设备** | 无凭据，靠 IP 白名单 |
| IPSAN/iSCSI | `portal, targetIqn, lun, chapUser/Secret` | **设备** | 拿到的是**裸 LUN**，通常要先由设备格式化；**PC 与相机不能同时挂同一 LUN** |
| 云/S3 兼容 | `endpoint, bucket, prefix, region, ak/sk, pathStyle` | 设备直传 | 需断点续传与失败重试；带宽/费用要算 |

> ⚠️ **产品语义的关键分叉**：`IPSAN/NAS` 由**设备**挂载 ⇒ 数据在设备侧、PC 只是看客；
> 由 **PC** 挂载 ⇒ 数据在 PC 侧、走我们自己的录像（就是方案 B）。
> 这两种在界面上必须是两种东西，否则"我把 NAS 配上去了，为什么 HAIS 里还是没录像"这类问题无解。

### 3.3 界面上的位置（现在就能留好）

设备详情页加一张**「存储」卡**，能力驱动：
- 相机没这个能力（今天的 FA371）→ 显示"本机/设备未提供设备侧存储配置"，并给出**本机录像**入口
  （现在的行为，见 §1.2）；
- 有该能力 → 渲染上面的表单 + "测试连接" + 容量水位 + 最近写入状态。

仓库已有能力驱动的先例（`camera-nvr.ts` 的可选能力 `localPlayback`/`detectDownload`：能力不声明
时菜单不出现，避免死项），照同一条规矩做。

---

## 4. 方案 B：PC 存储池，做成独立服务

### 4.0 先对齐：仓库里已经有一条劝退决策（不读这一节会撞车）

`docs/Ivms4200-UX-REFERENCE.md` §11「明确劝退的部分」里写着：

> **C2** 云 / P2P / Hik-Connect 那一整套（`Add Offline Device`、EHome、HiDDNS、
> **注册管理服务器、流媒体服务器**）—— "我们是**单设备直连**（`connect-src 'none'`，
> 渲染层结构上无法触达设备 IP）。引入任何「云/中转」都会**推翻这条架构约束**，
> 而它是本仓库最值钱的一条安全设计"（`:571`）
>
> **C13** `Instant Playback` —— "它依赖**设备侧/存储服务器上的连续录像**。
> FA371 没有录像存储…"（`:582`）

所以"支持 NAS / IPSAN / 云存储"必须拆成**三件事**，它们的结论完全不同：

| 形态 | 与既有决策的关系 | 结论 |
|---|---|---|
| **① 指向操作系统已挂好的卷**<br>（SMB/NFS 映射盘、iSCSI 卷，`storageRoot` 指过去） | **不新增任何网络服务、不新增信任面**：写文件仍然是本地 `fs`，只是那块盘在网络上 | ✅ **第一优先，现在就能用**（零新组件，见 §1.2 的"设置变更而非迁移"） |
| **② 业主自建的本地存储服务**<br>（机房内网、业主自己部署、只被**主进程**访问） | 它**不是** C2 说的那种"云/中转/注册服务器"：没有公网、没有第三方、不转发码流；但它确实**多了一个网络服务** | ⚠️ **可做，但必须先取得业主明确确认**，并满足下面四条约束 |
| **③ 公有云 / P2P / 厂商中转** | 正面撞上 C2 | ❌ **不做**，除非业主明确改判。若业主想要"设备直传云"，那是**设备固件**的事（不经过我们的客户端，也就没有这条信任面问题） |

② 必须满足的四条约束（全部沿用仓库现有安全模型，不新开口子）：

1. **渲染层仍然 `connect-src 'none'`**：存储服务只被**主进程**访问 —— 与今天主进程访问
   设备 IP 的方式完全一致；绝不让渲染层直接打存储服务的地址（这也是本仓库把
   "本机文件给界面的唯一一条路"做成主进程回环 HTTP 的同一条思路，`BASELINE.md:103-106`）。
2. **不成为"第二套存储"**（`Ivms4200-UX-REFERENCE.md:5122`）：池是既有 `StorageService` 的
   一个**后端实现**，收到的数据仍然走既有写入路径、既有登记表、既有保留策略与磁盘护栏。
3. **不引入设备录像计划 / 远程回放的语义**（C13 + `:482`）：界面口径仍然是"本机文件"，
   那句「只回放本机文件（设备侧没有连续录像）」**必须留着**。
4. **不引入第三方依赖或公网中转**：服务由业主部署在受控网段，凭据用一次性配对令牌
   （可选 mTLS），不经公网、不做 NAT 穿透。

**给业主的选择顺序（建议照这个顺序问）**：

```
只要"盘更大 / 放在网络盘上"        → ① 挂载卷：零新组件，今天就能验收
要多客户端共享 + 集中保留 + 第三方
录音不经管理软件入库               → ② 本地池服务：需业主确认后开工
要公有云                           → ③ 需业主改判；更合理的是让设备自己传云（我们不做中转）
```

### 4.1 为什么要解耦（这是业主问题的正面回答）

| 不解耦（写进管理软件） | 解耦成独立服务 |
|---|---|
| 管理软件升级/重启 → 录像写入或接入中断 | 池服务独立运行，升级 HAIS 不影响正在落盘的录像 |
| 池只能装在装了管理软件的那台机器 | 池可以装在机房的存储服务器上，多台 HAIS 共用 |
| 第三方录音必须"经过管理软件"才能入库 | 第三方设备直接 `POST /objects` 到池，HAIS 只是索引/展示的一个读者 |
| 容量策略、抹除、审计的权限边界与设备管理混在一起 | 权限、审计、保留策略归池服务；HAIS 不删文件，只请求 |

**红线（解耦的判据）**：把 HAIS 整个关掉，池服务仍能接收并保存现场推上来的录音；
HAIS 重新打开后能在列表里看到这些文件。做不到这条，就还是耦合的。

### 4.2 形态与契约（建议）

- **进程形态**：独立可执行程序/Windows 服务（`hais-storage.exe`，"存储服务端"），
  带一个极小的本地配置页（托盘程序或本地网页），**不依赖 Electron、不依赖管理软件的数据库**。
- **协议**：HTTP + JSON（`/api/v1`），本机或局域网；鉴权用一次性配对令牌换长期 token，
  可选 mTLS。**不用 gRPC**：现场排障要能 `curl`。
- **核心端点**：

```
GET    /health                      -> { version, uptime, pools: n }
GET    /pools                       -> [{ id, name, kind: 'jbod'|'raid'|'mounted',
                                           totalBytes, freeBytes, state, watermark }]
GET    /pools/{id}                  -> 详情（盘位、健康、水位、保留策略）
PUT    /pools/{id}/retention        body { mode: 'days'|'capacity', value, keepAlarms }
POST   /objects                     multipart 上传（幂等 key + sha256 + 断点续传）
GET    /objects/{key}               Range 支持（播放器/ffmpeg 直接读）
HEAD   /objects/{key}               -> 长度、sha256、mtime
GET    /objects?prefix&from&to&limit  列表（HAIS 用它做索引对账）
DELETE /objects/{key}               （或按策略自动；HAIS 默认无权删）
POST   /leases                      body { bytes, ttlMs }  -> { id }   # 预留空间，避免写一半写满
GET    /events                      SSE：object.created / pool.threshold / pool.degraded
```

- **挂载卷也算一种池**：`kind: 'mounted'` 表示"这块空间是操作系统已经挂好的
  SMB/NFS/iSCSI 卷"，池服务只负责水位/保留/校验，不负责挂载。**这一步让 NAS/IPSAN 在
  第一阶段就能用**（见 §6 阶段 2），不必等设备侧固件。

### 4.3 HAIS 侧怎么接

1. **设置项升级**：`storageRoot: string` → `storageTarget`：
   ```ts
   type StorageTarget =
     | { mode: 'local'; root: string }                                  // 今天的行为，默认
     | { mode: 'pool'; endpoint: string; token: string; poolId: string; cacheRoot: string }
   ```
   老配置按 `{ mode: 'local', root: storageRoot }` 兼容读取（**不迁移数据，只改解释**）。
2. **后端抽象（文件系统这一层）**：
   ```ts
   interface StorageBackend {
     ensureLayout(): Promise<void>
     buildPath(kind, deviceUid, stamp, …): { key: string; absolutePath?: string }
     write(key: string, bytes: Uint8Array): Promise<void>   // 本地=临时文件+rename；池=PUT+校验
     read(key: string, range?): Promise<ReadableStream>     // 回放/下载
     stat(key): Promise<{ bytes: number; sha256?: string; mtime: number }>
     remove(key): Promise<void>
     capacity(): Promise<{ totalBytes: number; freeBytes: number; state: 'ok'|'low'|'offline' }>
     resolveForPlayback(key): Promise<string>               // 返回本地路径或可给 ffmpeg 的 URL
   }
   ```
   - `LocalDirBackend`：把今天 `storage-service.ts` 的能力原样搬进来（**行为零变化**）；
   - `PoolBackend`：走 §4.2 的 HTTP；`resolveForPlayback` 返回 `http://pool/api/v1/objects/<key>`，
     由播放器/ffmpeg 直接 Range 读；断网时降级为"写本地缓存 + 待同步队列"，并在界面上说清
     **"尚未入池"**，绝不说"已保存"。
3. **DB**：`recordings` 增加 `storage_backend`、`storage_key`、`sync_state`
   （`local` / `pooled` / `pending` / `archived`）；`relative_path` 语义保留给 `local` 模式。
4. **容量与 `DISK_FULL`**：判据从"取本盘剩余空间"改成 `backend.capacity()`；池水位事件
   （`pool.threshold`）进入现有告警通道（复用 `DISK_FULL` 与告警中心，不新造一套）。

### 4.4 云存储（冷层）怎么放

**先划边界（照 §4.0）**：能谈的只有**业主自建、内网可达的 S3 兼容对象存储**（例如自建 MinIO），
它属于形态 ②；**公有云 / 厂商托管 = 形态 ③，需业主明确改判**。
若业主真的想要公有云，更合理的产品形态是**设备固件直传**（数据不经过我们的客户端），
我们只在界面上显示"设备已上传 N 个"，而不是自己做中转。

在这个边界内，对象存储**不进** `StorageBackend`，而是独立的一个**归档同步器**：
- 触发：文件关闭且 `sync_state='pooled'`（或本地/池内超过 N 天）；
- 行为：上传 → 校验 sha256 → 在 DB 里记 `archived` + 远端 key；**本地/池内文件是否删除由保留策略决定**；
- 回放：优先本地/池；只有归档副本时，`resolveForPlayback` 走"先拉到缓存再播"，并在界面上写明
  "正在从云端取回"（不要假装是本地文件）。
- 断网/失败：进重试队列（指数退避），界面上显示"待归档 N 个"，**不影响实时录像**。

---

## 5. 明确不做（避免范围膨胀）

1. **不做公有云 / P2P / 厂商中转**（形态 ③）：正面撞 `Ivms4200-UX-REFERENCE.md:571`（C2）
   已劝退的那一条；要动它必须业主明确改判（§4.0）。
2. **不让渲染层访问存储服务**：`connect-src 'none'` 这条安全设计不动 —— 存储服务的访问
   只发生在主进程，和今天访问设备 IP 同一条规矩。
3. **不把 S3/OSS 伪装成目录**（没有 rename、没有 seek 语义；硬做会把"原子写入"这条安全性质丢掉）。
4. **不让 HAIS 直接管盘阵/RAID**（那是存储服务的事；HAIS 只问容量、只发保留请求）。
5. **不做"设备侧录像计划"的界面**，除非 §3.1 探到固件真支持 —— 否则那是一个点不动的按钮；
   也不引入"远程回放/即时回放"这类依赖设备侧连续录像的模块（C13 已劝退）。
6. **不做"PC 与相机同时挂同一个 iSCSI LUN"**：会损坏文件系统，必须在界面上拦住（选中 IPSAN 时提示
   "该 LUN 只能被一端挂载"）。
7. **不在本机存储池服务里引入分布式共识/多副本**（v1 只做单机池 + 挂载卷；多副本属于存储产品的范围）。
8. **不新开第二套存储通路**（`Ivms4200-UX-REFERENCE.md:5122`）：池后端接进既有的
   `StorageService`/登记表/保留策略，不为池单独写一套写入与清理。
9. **不放宽既有硬规则**：命名（时间戳在前、永不覆盖）、相对路径入库、保留天数与最小剩余空间护栏
   （"我们比 iVMS 严格，不要往回退"）。

---

## 6. 分阶段落地（每阶段都能独立验收）

| 阶段 | 内容 | 验收（可量化） | 预估 |
|---|---|---|---|
| **0. 探测** | 对真机做 §3.1 的只读探测（判据是**响应体形状**，不是状态码）；抓一次相机在写入检测结果时的网络行为；把结论写进 PROTOCOL-FINDINGS | 一份带出处的结论表：有哪些存储端点、有没有录像能力、"没有"也要有**一行实测记录** | 1 天（需真机可达） |
| **1. 挂载卷 + 抽象与设置** | ① 把"指向已挂好的 NAS/iSCSI 卷"这条走通并写进手册（零新组件）；② `storageTarget` + `StorageBackend`（只实现 `LocalDirBackend`）+ 设置页升级 + 老配置兼容 + 单测 | ① 网络卷上录像→回放→保留策略全通，拔盘有明确报错；② 现有行为**零变化**（全部探针仍 0 问题），`storageRoot` 老配置照旧工作 | 1–2 周 |
| **2. 独立池服务（需业主先确认形态 ②）** | `hais-storage` + `PoolBackend` + 水位/保留/事件 + 断网降级 + 第三方 `POST /objects` 接入 | ① HAIS 全关，池仍能接住第三方上传；② NAS/iSCSI 卷作为池写入后能回放；③ 拔网线 → 界面显示"待同步"，不显示"已保存"；④ 水位到 90% 走告警；⑤ 渲染层 `connect-src` 仍是 `'none'` | 2–3 周 |
| **3. 内网对象存储归档 + 设备侧** | 自建 S3 兼容归档同步器（形态 ② 内）；设备产物**回捞归档**（`detect_logs`→`detect_file` 等三条路，绕开设备环形覆盖）；设备侧存储配置界面（**取决于阶段 0 / 固件排期**） | 归档后 DB 有远端 key、能取回播放；回捞后设备环形覆盖不再丢证据；设备侧有接口则端到端配一次并实测写入 | 2 周 +（等固件） |

> 阶段 3 里的"设备产物回捞归档"是**现在就能做、且手册自己就建议做**的事
> （`manual-v7-extracted.txt:323,593`："plan external archiving if longer retention is required"），
> 三条取文件的路都已存在（§1.1 表），值得从 A 里单独摘出来先做。

---

## 7. 需要业主/厂家确认的问题（会改变方案的问题）

0. **先确认形态**：你要的是 ① 网络卷（零新组件，今天能用）/ ② 业主自建本地池服务（需你确认，
   会多一个网络服务）/ ③ 公有云（仓库已劝退，需你明确改判）—— 选错方向，后面全是白做（§4.0）。
1. **相机固件到底有没有存储配置接口？** 有没有内部版本/计划？（决定 A 是本项目做还是厂家做）
2. **"相机支持存储配置"的目标形态**：是"相机自己按计划连续录到 NAS/iSCSI"，
   还是"HAIS 把相机流录到 NAS/iSCSI"？两者产品语义、验收方式完全不同（§3.2 末尾的警告）。
3. **IPSAN 谁来挂**：相机挂（裸 LUN 由相机格式化）还是 PC 挂（PC 当普通盘用）？
4. **云存储是哪一种**：自建 S3 兼容（MinIO 等，属 ②）/ 公有云（属 ③，需改判）？是否需要
   断点续传、加密（KMS）？
5. **PC 存储池的部署形态**：同一台机器上的独立进程，还是机房里另一台存储服务器（多客户端共用）？
   有没有既有的存储服务器/盘阵要对接？
6. **"一些录音的接入"具体指什么**：第三方录音软件？现场录音笔？设备推送？—— 这决定池服务要不要
   做"接收端点 + 目录监视（watch folder）"两种入口。
7. **保留与合规**：录像/录音保留多久？谁有权删除？是否需要"删不掉"的审计留痕？

---

## 8. 未验证 / 风险

1. 相机固件是否真的没有任何存储接口（阶段 0 才能确证；本文件里的"没有"来自**文档层面**的穷举，
   不是真机穷举）。⚠️ 探测本身受 `FA371-MAINTENANCE-PROBE.md:15-30` 的陷阱约束：
   未定义路径**可能回 200 + SPA 页面**，"GET 到 200"不能当端点存在的证据。
2. NAS/iSCSI 挂载卷上，现在的"临时文件 + rename"是否仍然原子（SMB 上 rename 语义与本地不同；
   NFS 上通常 OK）—— **必须在真实共享上做一次写入中断实验**，否则"不会出现半截文件"这条结论
   在换了后端之后不成立。
3. 网络卷掉线时的**写失败窗口**：Windows 映射盘断开后 `fs.writeFile` 的报错形态与耗时（可能
   长时间阻塞）—— 需要实测，因为它决定"降级到本地缓存"是否来得及。
4. 池服务与 HAIS 的版本兼容策略（契约版本化 + 最低支持版本）需要在阶段 2 定死。

---

## 9. 追加范围：先不做设备侧，只做"RTSP 取流存储 + 历史数据 + 回放"（业主 2026-09-26）

> 业主原话：「先不走真机，可以做一个 RTSP 的取流存储，以及历史数据的存储，回放 可以吗」

**答：可以，而且这是当前唯一不依赖真机、不依赖固件、也不新增信任面的方向** ——
它完全落在 §4.0 形态 ① 之内（本地/已挂载卷 + 我们自己的进程），不触碰 C2 劝退的那一类。

### 9.1 底层已经具备的部分（不需要改数据模型）

| 已有 | 出处 / 含义 |
|---|---|
| **录像表已经能表达"片段"** | `recordings` 有 `start_time / end_time / duration_ms`，且 `recording_type` 枚举里**已经有 `scheduled`**（`database/schema.ts` recordings DDL；`models.ts:566`；`RecordingsView.vue:37` 已在筛选它；i18n 已有"定时录音"）→ 连续录像 = 大量 `scheduled` 行，**不用改 schema** |
| **按时间的检索已经建好索引** | `idx_recordings_time(start_time DESC)`、`idx_recordings_device_time(device_id, start_time DESC)`、`idx_recordings_type(recording_type, start_time DESC)` → "取某台相机某时间段的片段"是索引查询 |
| **RTSP → 文件的正确姿势已经验证过** | `buildManualRecordArgs()`：`-rtsp_transport tcp -i <url> -an -c:v copy -f mp4 -movflags frag_keyframe+empty_moov+default_base_moof` —— **分片 MP4，进程任意时刻被杀都留下可播放文件**（`media/camera-capture.ts:64-80`）。连续录像就是把它变成"按时间切片、切片之间无缝、断了自动重来" |
| **子进程有唯一出口** | `spawnFfmpeg()`：全局注册表保证退出时不会漏掉 ffmpeg（`media/ffmpeg.ts`）—— 常驻录像器的生命周期可以直接挂在这套机制上 |
| **RTSP 连接预算的概念已经有了** | `rtsp-stream.ts` 有 `maxConcurrentStreams`；实时预览/画面墙/抓图/联动录像各自占用预算。设备实测上报 `rtsp_client_limit: 10`（手册写范围 `[1,6]`）→ **录像必须纳入同一份预算**，否则"开着画面墙点录像"会抢不到连接 |
| **回放的时间轴几何已经写好** | `lib/playbackTimeline.ts`（窗口/缩放/`segmentAt`/`stepEvent`/锚点 seek，27–35 条断言）与 `lib/recordingTimeline.ts` + `MonitorRecordingTimeline.vue`（**已在监测页接线**） |
| **历史数据（趋势）已经在按天落盘** | `metrics/<DEVICE_UID>/<YYYY>/<YYYY-MM-DD>.parquet`（`TrendStorageService`，DuckDB 查询在 `TrendQueryService`） |
| **告警 ↔ 录像的关联已在位** | `alarms.recording_id` + `RecordingRepository.linkRecording`；跳转回放用 `anchorSeek()` 并**如实返回差额** |

### 9.2 要补的五件事（这是真正的工作量）

1. **常驻录像器**：按时间切片（建议 1–5 分钟/片）、片间无缝、断流自动重连（指数退避）、
   **看门狗**（进程存活 + 文件增长速率；只判"进程还在"会漏掉"进程在但没数据"）、
   崩溃/断电后**未收尾片段仍可播**（分片 MP4 已经保证）、启动时把遗留片段补登记。
2. **连接预算**：录像占 1 路 RTSP，必须与实时预览/画面墙/抓图/联动录像共享同一份预算并给出
   "谁让路"的策略（建议：**录像优先**，画面墙降格或提示；这一条要业主定）。
3. **保留与水位**：现在的 `enforceRetention()` **只在启动时跑一次**、且**只删 `recording_type='alarm'`**
   （`manual`/`scheduled` 永不自动删）——连续录像会无上限增长，必须：
   ① 把 `scheduled` 纳入保留；② 改成**周期性**清扫（不能只靠重启）；③ 水位到达阈值要有**界面告警**
   （现在 `diskUsage()` 在 `statfs` 失败时降级为"永不拦"，且渲染层没有全局磁盘提示）；
   ④ 顺手接线已经写好却**没有调用者**的 `TrendQueryService.enforceRetention()`。
4. **回放体验**：跨片段连续播放（播完自动接下一片）、缺口如实呈现（录像器没开/断流就是空白，
   不许画成"有录像"）、时间轴与**告警/声学数据同轴**（相机没有设备侧录像，回放的价值就在于
   把"视频片段 + 那一刻的告警 + 那一刻的声学趋势"对到同一条时间轴上）。
5. **谁在录**（见 §9.3 决策）：这决定"历史数据"有没有断点。

### 9.3 需要业主定的三件事

| # | 问题 | 影响 |
|---|---|---|
| 1 | **录像怎么触发**：7×24 连续 / 只录告警前后 / 指定时间段 / 手动？ | 决定磁盘预算与保留策略。⚠️ 注：业主此前已明确**不做布防时间表**（`Ivms4200-UX-REFERENCE.md:759-760`），若现在要"时间段录像"请明确，因为那会重新引入时间闸门概念 |
| 2 | **保留多久 / 多大**：按天数（如 30 天）还是按容量上限（如 500 GB）？超了删最旧还是停录？ | 连续录像的量级：按 2 Mbps 估约 **21 GB/天/路**，4 Mbps 约 **43 GB/天/路**（实际码率要实测）——30 天单路就是 0.6–1.3 TB |
| 3 | **谁在录**：管理软件运行期间录（实现简单，但关掉界面/软件升级期间**断录**），还是**独立的录像/存储服务**常驻（7×24 必需，也是 §4 那条"解耦"的自然延伸）？ | 若答案是"必须 7×24 不断"，那录像器从一开始就应当按**独立进程**的边界来写，而不是先塞进主进程以后再拆 |

### 9.4 建议的落地顺序（每步都能独立验收）

| 步 | 内容 | 验收 |
|---|---|---|
| **S1** | 录像器内核：RTSP → 分片 MP4 → `recordings(scheduled)` 登记；断流重连 + 看门狗；单元测试用**假 ffmpeg/mock RTSP** 覆盖（不依赖真机） | 拔掉 RTSP 源能自动重连；杀掉 ffmpeg 能重启；已写出的片段**每一个都可播放**；进程被 kill -9 后留下的最后一片仍可播 |
| **S2** | 保留与水位：`scheduled` 纳入保留 + 周期性清扫 + 水位告警 + 趋势保留接线 | 造 200% 容量的假片段，跑清扫后水位回到阈值下；`manual` 仍不被自动删 |
| **S3** | 回放：跨片段续播 + 缺口呈现 + 时间轴与告警/趋势同轴（复用 `playbackTimeline.ts`，把它的 UI 接线补上） | 选一个 30 分钟区间能连续看完；中间关掉录像器的时段显示为缺口；点告警能跳到对应片段的那一秒 |
| **S4** | （按 §9.3-3 的答案）把录像器搬到独立进程/服务，HAIS 变成客户端 | 关掉 HAIS，录像不停；重开 HAIS 能在列表里看到期间的片段 |

> **两台机器上的验证都不需要真机**：`scripts/mock-fa371.cjs` 已经能提供 RTSP 侧的行为，
> 而 S1 的断流/看门狗/崩溃恢复完全可以用**注入式假源**（本地文件循环推流或直接替换 ffmpeg 调用）
> 跑真窗口验证 —— 这几条恰好是最容易出错的几条。

### 9.5 实施状态（2026-09-30 更新）

| 步 | 状态 | 证据 |
|---|---|---|
| **S1 录像器内核** | ✅ 已实现 | `shared/domain/recorder.ts`（纯规则）+ `main/services/recorder/rtsp-recorder-service.ts`（进程形状边界，依赖全注入）+ `buildRecorderArgs()`（`-f segment` + 内层分片 MP4） |
| S1 切片入库 | ✅ 已实现 | `RecordingRepository.insertContinuousVideo()`：`recording_type='scheduled'`，幂等键 `continuous:<文件名>`，数据库级唯一索引 |
| S1 设置 | ✅ 已实现 | `AppSettings.recorder { enabledDeviceIds, segmentSeconds }`，**默认谁都不录**、切片 5 分钟 |
| S1 源解析 | ✅ 已实现 | `CameraLiveService.resolveRecorderSource()`：不开直播会话也能拿地址，与直播共用候选顺序 |
| S1 IPC + preload | ✅ 已实现 | `RECORDER_STATUS` / `RECORDER_SET_ENABLED`，顺序为"先解析地址 → 再落库 → 最后拉起" |
| S1 真窗口验证 | ✅ 通过（problems 0） | `scripts/verify-recorder.cjs`：真 ffmpeg + 合成源，6 片全可播、断流后换轮重启、停止时补登记 —— 见 `docs/UI-VERIFY.md` MM |
| **S1 界面（开关 + 状态行）** | ✅ 已实现（真窗口点击未验） | `CameraRecorderBar.vue` 接入 MonitorView 相机分支：开关走 `window.api.recorder.setEnabled`，状态行原样显示 starting/recording/waiting/backoff + 已请求未运行；六语言文案与源码守卫见 `tests/recorder-ui.test.ts` |
| S2 保留与水位 | ✅ 已实现 | `shared/domain/retention.ts` + `StorageService.enforceRetention()` 周期清扫 + `TrendQueryService.enforceRetentionForAllDevices()` + 设置页配额与超额提示；见 §9.9 |
| S3 回放 | ❌ 没做 | 跨片段续播 / 缺口呈现 / 与告警趋势同轴 |
| S4 搬到独立服务 | ❌ 没做 | 录像器的依赖已全部注入，具备搬家条件 |

**本机验证的边界（重要）**：S1 的验证用的是**合成源**（`HZ_RECORDER_SOURCE=lavfi`），
不碰真机 RTSP —— 地址拼装与 `rtsp_enabled` 判据由真机探针负责。另外**切片边界取决于相机的
GOP**（分段复用器只在关键帧上切），真机上的实际边界要实测。


### 9.6 S1 收尾结论（2026-09-30，12 轮预算用尽时的真实状态）

**已实现并验过的（S1 内核）**

| 项 | 证据 |
|---|---|
| 按时间切片持续录成分片 MP4 | 真窗口探针（真 ffmpeg + 合成源）：10 秒切片、26 秒 3 片、30 秒后 6 片 |
| 断流自动重连 | 杀 ffmpeg 后换轮重启（`runStartedAt` 变化）并继续在长 |
| 看门狗（进程存活 **+ 文件增长**） | `recorderStalled()` 按"文件不长了"判，不按"进程还在"；状态区分 `recording`/`waiting` |
| 崩溃/断电后补登记 | 启动扫最近两天目录补登记；停止/重启/跨天先 `closeOpen` 收尾（盘上 6 片 / 库里 4 → 6 条） |
| 每个片段可播放 | 6 片文件头均为 `ftyp`/`iso5` |
| `recording_type='scheduled'` 入库 | 幂等键 `continuous:<文件名>` + 数据库级唯一索引 |

**已实现但证据不足**

- **启动恢复（`resumeEnabled`）**：逻辑层有单测（配置里三台含一台不存在 → 拉起两台、如实报一台失败、幂等），
  但**真窗口证据缺失** —— 探针调用它时挂住，两轮排查未定位（`docs/UI-VERIFY.md` MM.5）。
  已排除：录像器自身 `start→stop→start`、`settings.update()`。剩余嫌疑：`resumeEnabled` 内部，
  或"真 ffmpeg 刚被 taskkill 之后再拉起一轮"这条组合。

**没做**

- 界面（开关 + 状态行）：已在相机实时画面卡内接线（`CameraRecorderBar.vue`），开关走 IPC、状态行显示录像器四态；真窗口点击/状态刷新仍放在下一轮探针。
- S2 保留与水位、S3 回放、S4 搬到独立服务。

### 9.7 ⚠️ 需要业主决策：连续录像的保留策略（做 S2 前必须定）

现在的自动清扫（`StorageService.enforceRetention()`）**只删 `recording_type='alarm'`**，而且
**只在启动时跑一次**（`app-services.ts:897-910`，注释明确 "never on a timer"）。
连续录像登记的是 `scheduled`，所以它**永不自动删除** —— 一路 2 Mbps 一天约 21 GB，
30 天就是 0.6 TB，开着不管一定把盘写满。

三个必须由业主定的点（我不擅自替你决定"删用户录下来的东西"）：

1. **按天数还是按容量**：保留 30 天（与录音同口径）还是"整个存储不超过 N GB"？
2. **超限时删最旧还是停录**：删最旧（继续录，但证据会消失）还是停录并告警（保住已有证据）？
3. **`scheduled` 与 `manual` 的关系**：手动录像现在是"永不自动删"，连续录像显然不能沿用这条 ——
   要不要在界面上把"连续录像会被自动清理"写清楚（我倾向：必须写清，且给一个"锁定某一片"的能力留出位置）。

在这三条定下来之前，**不要**把 `scheduled` 加进清扫白名单：一个"悄悄地删掉用户以为留着的录像"
的实现，比"盘满了让他自己清理"更糟。
### 9.8 S2 保留策略：业主决策（2026-09-30）与实现规格

业主对 §9.7 三条的回答：

1. **优先级是容量**（不是天数）；
2. 超限时**删除最旧的**；
3. **只有严重/告警级（warning 以上）的告警录像进入"永久保存"区，该区占配额的 10%**；
4. 手动录像**不自动删**（维持现状），但**计入总容量**；盘满时**先删连续录像**。

#### 配额与档位（实现规格）

| 档 | 内容 | 删除规则 |
|---|---|---|
| **P（保留区）** | `recording_type='alarm'` 且**关联告警等级 ≥ warning** 的录像 | **不自动删**；但保留区**封顶 = 配额 × 10%**，超出部分按**最旧优先**删除 |
| **C（滚动区）** | `recording_type='scheduled'` 的连续录像切片（+ 等级低于 warning 的告警录像） | 总占用超配额时**最旧优先**删除 |
| **M（手动区）** | `recording_type='manual'` | **永不自动删**；只计入总占用 |

- **总占用 > 配额**时：先删 C 档最旧的，直到回到配额以内；
- **C 档删完仍然超**（只剩 P 与 M）：**不删**，并在界面上如实报告"已超出配额，只剩永久告警与手动录像；
  请清理手动录像或调大配额" —— 悄悄删掉用户以为留着的证据，比让他自己清理更糟；
- **配额设置**：`AppSettings.storageQuotaBytes`，界面按 **GB** 填，**默认 50 GB**；
- **保留区比例**：`retentionAlarmReserveRatio`，默认 **0.1**（10%）。

#### 与既有 `retentionDays` 的关系（必须写清，否则两套策略互相打脸）

现有 `StorageService.enforceRetention(retentionDays)` 只删 `recording_type='alarm'` 且早于 cutoff 的行，
**只在启动时跑一次**。这条与"warning 以上的告警永久保存"直接冲突，所以：

- **P 档豁免** `retentionDays`（永久就是不按天删）；
- 其余告警录像仍可被别人按天清理，但**容量优先**：容量清扫先跑，跑完仍超再按天；
- 清扫**必须从"只在启动跑一次"改成周期性**（连续录像随时在增长，重启才清理等于不清理）。

#### 数据前提（实现时要动的地方）

- 判"等级 ≥ warning"需要 `alarms.severity` —— 录像行通过 `alarms.recording_id` 关联，清扫的查询要 LEFT JOIN；
- 判"总占用"不能只看 `recordings.file_size` 之和（`manual` 与设备镜像也在里面），
  实现时按 `recording_type` 分档统计，并把**非录像类数据**（趋势 parquet、日志、缓存）计入总占用，
  否则"配额 50 GB"与磁盘实际占用会对不上；
- 删除要**先删文件再删行**（或反之但要有补偿），沿用现有 `expiredAlarmRecordings()` 那套写法的顺序与容错。

> **现状（2026-10-01）**：纯策略、周期清扫、配额设置与超额提示都已实现，见 §9.9；仍未接线的是 `TrendQueryService.enforceRetention()`（趋势 parquet 按天删）。

### 9.9 S2 实现记录（2026-10-01）

- `AppSettings.storageQuotaBytes`（默认 50 GB）与 `retentionAlarmReserveRatio`（默认 0.1）已由设置页「存储」卡承接；`0` = 不限制。全新安装用出厂 50 GB；旧装设置表里没有这一格时按 0 启动，避免升级后第一次清扫就把旧录像删掉。
- 纯策略 `shared/domain/retention.ts` 已接进 `StorageService.enforceRetention({ retentionDays, quotaBytes, alarmReserveRatio })`：
  - 超配额时先清可重建缓存；C 档（`scheduled` + 低于 warning 的 `alarm`）按最旧优先删到配额以内；P 档封顶 = 配额 × 比例，超出照样按最旧淘汰；M 档（`manual`）永不进待删队列。
  - 删除顺序是先文件后行；文件被锁/无权限时保留行和文件，下一轮重试，不做「删行造成孤儿文件」。
  - 配额占用按存储根下全部文件统计（录像 + 趋势 + 日志 + 缓存 + 导出）。设置页走专用的 `quotaUsage()`；录音保存热路径仍用轻量的 `diskUsage()`（只扫 `audio`），避免每次落盘都全树扫描。
  - 清扫在启动时跑一次，此后每 `RETENTION_SWEEP_INTERVAL_MS`（10 分钟）一次；`app-services.dispose()` 会清掉定时器。
  - P 档豁免按天；非保护告警仍按 `retentionDays` 删。`DiskUsage.remainingOverQuotaBytes > 0` 时设置页如实提示「已超出配额，只剩永久告警与手动录像」。
- 集成回归：`tests/storage-retention-sweep.test.ts`（容量删最旧、P/M 保护、非录像计入、缓存优先、缺文件补删）。
- 趋势 parquet 的按天保留已接线：`TrendQueryService.enforceRetentionForAllDevices(retentionDays)` 扫描 `metrics/` 下**所有设备目录**（包括设备已删除后留下的孤儿目录），逐个复用 `enforceRetention()` 单设备逻辑。
- 启动与周期清扫都**先清趋势、再跑录像容量策略**：过期 parquet 在配额眼里属于不可删数据，先删掉它，才不会为了凑配额误删一段本来可以留的录像。
