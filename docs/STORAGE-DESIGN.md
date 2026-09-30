# 存储方案设计：设备侧存储配置 + PC 存储池（解耦）

> 状态：**方案（未实施）**。业主 2026-09-26 提出需求：
> 「对于声学相机和一些录音的接入，需要相机支持存储配置，支持接入 IPSAN、NAS、云存储等不同的模式，
> 如果需要在 PC 上建立存储池，那么这个软件应该是和管理软件解耦的。你看看应该怎么去做」

---

## 0. 结论摘要（先看这一段）

1. **需求其实是两件互不相干的事，必须分开做**：
   - **A. 设备侧存储**：让*相机自己*录到 SD / NAS / IPSAN / 云。这需要**相机固件提供接口** ——
     现有 FA371 固件里**一个存储配置端点都没有**，也没有连续录像能力（见 §1.1）。
     所以 A 的第 0 步不是写代码，而是**探测 + 出固件接口规格**。
   - **B. PC 侧存储**：我们的录像/抓图/录音落在 PC 侧的哪里。这一半**现在就能做**，
     而且有一大块**零代码即可交付**：把存储根指到 Windows 已经挂好的 NAS/iSCSI 卷就能用（§3.1）。
2. **"PC 存储池"要做成独立服务**（`hais-storage`），HAIS 只是它的一个客户端 —— 这是业主
   说的"解耦"，也是唯一能让"管理软件升级/重启"不打断录像与第三方录音接入的形态（§4）。
3. **抽象只做到文件系统这一层**（本地盘 / NAS 挂载卷 / iSCSI 卷都算），**不要**把对象存储
   （S3/OSS）混进同一个接口：对象存储没有 `rename`，而现在的落盘靠"写临时文件 + rename"
   保证"不会留下半截可播放的录音"（`storage-service.ts:255-262`）。云存储按**冷层归档同步器**做（§4.3）。
4. 分四阶段：**探测（1 天）→ 抽象与设置（1–2 周）→ 独立池服务（2–3 周）→ 云归档 + 设备侧（看固件排期）**（§6）。

---

## 1. 现状事实（都是仓库里已经确证的东西，带出处）

### 1.1 设备侧：相机没有存储配置，也没有连续录像

| 事实 | 出处 |
|---|---|
| FA371 的 API 规格里**没有**任何存储/NAS/iSCSI/云相关端点；与"存储"沾边的只有 `POST /upload_nc`（上传噪声比对文件） | `docs/reference/FA371-api-spec.md`（5.1.30；全文件搜 sd/disk/storage/record/ftp/upload 只命中它） |
| 相机手册正文里搜不到 SD 卡 / TF 卡 / NAS / iSCSI / 云存储 / FTP 上传的任何字样 | `docs/reference/FA371-manual-en.txt`、`manual-v7-extracted.txt`、`leak-detection-manual.txt` |
| **「FA371 没有连续录像存储」**、手动录像是操作员自己的文件而不是设备的录像计划 | `docs/Ivms4200-UX-REFERENCE.md:332`、`:482` |
| 相机固件是自研的（RK3568 + nginx + SPA + `programs/`/`clib`/FPGA），**没有** ISAPI/ONVIF/GB28181 的痕迹 —— 也就是说没有现成的 OEM 存储层可以蹭 | `docs/FA371-API-DELTA.md:246,409,435`、`docs/FA371-MAINTENANCE-PROBE.md` |
| 相机侧确实有文件系统（能下载"检测结果文件"），但那是检测结果，不是录像 | `src/shared/domain/camera-nvr.ts:44-47`（`download-detect`）；`storage-service.ts:49-57`（`detect/` 目录） |
| 声纹盒（AE08）侧的告警音频文件在设备上形如 `/media/sdcard0/audio_library/...`，**不可 web 访问**，只能通过 `/get_alarm_audio` 拉下来 | `docs/PROTOCOL-FINDINGS.md:631,644` |

**结论**：A（设备侧存储配置）目前**无接口可调**。要么等固件加，要么把"存储"落在 PC 侧。
不要把"界面上放一个 NAS 配置表单"当成已实现 —— 没有固件支持，那个表单无处可写。

### 1.2 PC 侧：一个可迁移的存储根 + 相对路径入库（这块底子是好的）

| 事实 | 出处 |
|---|---|
| 布局固定：`<root>\{audio,video,snapshot,detect,metrics,spectrum_cache,spectrogram_cache,export,logs}\` | `src/main/services/storage/storage-service.ts:37-63` |
| DB 里存的是**相对 `<root>` 的路径**，所以"换一块大盘"是**设置变更而不是数据迁移** | `storage-service.ts:18-21`；`recordings.relative_path`（`db/alarm-repository.ts:472,543`） |
| 落盘用"临时文件 + rename"保证不出现半截文件；有路径越界守卫 | `storage-service.ts:255-262`、`:241-252` |
| 磁盘不足有 `DISK_FULL` 拦截（相机录像前判一次） | `src/main/services/media/camera-capture.ts:332` |
| 存储根是设置项，改了会广播 `storage-root-changed` | `src/main/services/settings/settings-service.ts:409,418-419` |
| 第三方接入（`services/ingest`）目前**只收遥测**（HTTP/MQTT JSON），**不支持文件/音频接入** | `src/main/services/ingest/{iot-ingest-service,telemetry-intake,mqtt-codec}.ts`（搜 audio/file/upload/multipart 无命中） |

**结论**：B 的改造面比想象中小 —— 缺的不是"写文件的能力"，而是
**（1）"存储目标"这个概念**（现在只是一个路径输入框）、
**（2) 网络存储的诚实性**（卷掉线/写满时怎么表现）、
**（3) 池与共享**（多客户端/多盘/保留策略）。

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

现成工具链就能做（仓库里已有）：

1. `node scripts/device-check.cjs --ip <相机IP>` / `scripts/verify-fa371.cjs` / 协议实验室的
   "自定义路径探测" —— 先把可能的隐藏端点打一遍（**只读**）：
   `/storage`、`/storage/info`、`/disk`、`/disk_info`、`/get_disk`、`/sdcard`、`/record`、
   `/record_conf`、`/recorder_conf`、`/nas`、`/nfs`、`/smb`、`/iscsi`、`/cloud`、`/ftp_conf`，
   以及 ISAPI 风格 `/ISAPI/ContentMgmt/Storage`、`/ISAPI/System/Network/...` 与 ONVIF
   `/onvif/device_service`（**即便手册没写，也值得打一遍**：这台固件的"未知路径"行为是
   "200 + SPA 页面"，与真 404（140 字节 nginx 页）可区分，见 `FA371-API-DELTA.md:232`）。
2. 把结论写进 `docs/PROTOCOL-FINDINGS.md`（新增一节 §6A "存储能力探测"），
   无论结果是"有"还是"没有"——**"没有"同样是结论**，它把 A 推到固件需求上。

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

对象存储**不进** `StorageBackend`，而是独立的一个**归档同步器**：
- 触发：文件关闭且 `sync_state='pooled'`（或本地/池内超过 N 天）；
- 行为：上传 → 校验 sha256 → 在 DB 里记 `archived` + 远端 key；**本地/池内文件是否删除由保留策略决定**；
- 回放：优先本地/池；只有归档副本时，`resolveForPlayback` 走"先拉到缓存再播"，并在界面上写明
  "正在从云端取回"（不要假装是本地文件）。
- 断网/失败：进重试队列（指数退避），界面上显示"待归档 N 个"，**不影响实时录像**。

---

## 5. 明确不做（避免范围膨胀）

1. **不把 S3/OSS 伪装成目录**（没有 rename、没有 seek 语义；硬做会把"原子写入"这条安全性质丢掉）。
2. **不让 HAIS 直接管盘阵/RAID**（那是存储服务的事；HAIS 只问容量、只发保留请求）。
3. **不做"设备侧录像计划"的界面**，除非 §3.1 探到固件真支持 —— 否则那是一个点不动的按钮。
4. **不做"PC 与相机同时挂同一个 iSCSI LUN"**：会损坏文件系统，必须在界面上拦住（选中 IPSAN 时提示
   "该 LUN 只能被一端挂载"）。
5. **不在本机存储池服务里引入分布式共识/多副本**（v1 只做单机池 + 挂载卷；多副本属于存储产品的范围）。

---

## 6. 分阶段落地（每阶段都能独立验收）

| 阶段 | 内容 | 验收（可量化） | 预估 |
|---|---|---|---|
| **0. 探测** | 对真机做 §3.1 的只读探测；抓一次相机在写入检测结果时的网络行为；把结论写进 PROTOCOL-FINDINGS | 一份带出处的结论表：有哪些存储端点、有没有录像能力、"没有"也要有证据 | 1 天（需真机可达） |
| **1. 抽象与设置** | `storageTarget` + `StorageBackend`（只实现 `LocalDirBackend`）+ 设置页升级 + 老配置兼容 + 单测 | 现有行为**零变化**（全部探针仍 0 问题）；`storageRoot` 老配置照旧工作；非法/不可写/掉线路径有明确报错 | 1–2 周 |
| **2. 独立池服务（含挂载卷池）** | `hais-storage` + `PoolBackend` + 水位/保留/事件 + 断网降级 + 第三方 `POST /objects` 接入 | ① HAIS 全关，池仍能接住第三方上传；② NAS/iSCSI 卷作为池写入后能回放；③ 拔网线 → 界面显示"待同步"，不显示"已保存"；④ 水位到 90% 走告警 | 2–3 周 |
| **3. 云归档 + 设备侧** | S3/OSS 归档同步器；设备侧存储配置界面（**取决于阶段 0 / 固件排期**） | 归档后 DB 有远端 key、能取回播放；设备侧有接口则端到端配一次并实测写入 | 2 周 +（等固件） |

---

## 7. 需要业主/厂家确认的问题（会改变方案的问题）

1. **相机固件到底有没有存储配置接口？** 有没有内部版本/计划？（决定 A 是本项目做还是厂家做）
2. **"相机支持存储配置"的目标形态**：是"相机自己按计划连续录到 NAS/iSCSI"，
   还是"HAIS 把相机流录到 NAS/iSCSI"？两者产品语义、验收方式完全不同（§3.2 末尾的警告）。
3. **IPSAN 谁来挂**：相机挂（裸 LUN 由相机格式化）还是 PC 挂（PC 当普通盘用）？
4. **云存储是哪一种**：自建 S3 兼容（MinIO 等）/ 公有云（阿里 OSS、腾讯 COS、AWS S3）？是否需要
   断点续传、内网穿透、加密（KMS）？
5. **PC 存储池的部署形态**：同一台机器上的独立进程，还是机房里另一台存储服务器（多客户端共用）？
   有没有既有的存储服务器/盘阵要对接？
6. **"一些录音的接入"具体指什么**：第三方录音软件？现场录音笔？设备推送？—— 这决定池服务要不要
   做"接收端点 + 目录监视（watch folder）"两种入口。
7. **保留与合规**：录像/录音保留多久？谁有权删除？是否需要"删不掉"的审计留痕？

---

## 8. 未验证 / 风险

1. 相机固件是否真的没有任何存储接口（阶段 0 才能确证；本文件里的"没有"来自**文档层面**的穷举，
   不是真机穷举）。
2. NAS/iSCSI 挂载卷上，现在的"临时文件 + rename"是否仍然原子（SMB 上 rename 语义与本地不同；
   NFS 上通常 OK）—— **必须在真实共享上做一次写入中断实验**，否则"不会出现半截文件"这条结论
   在换了后端之后不成立。
3. 网络卷掉线时的**写失败窗口**：Windows 映射盘断开后 `fs.writeFile` 的报错形态与耗时（可能
   长时间阻塞）—— 需要实测，因为它决定"降级到本地缓存"是否来得及。
4. 池服务与 HAIS 的版本兼容策略（契约版本化 + 最低支持版本）需要在阶段 2 定死。
