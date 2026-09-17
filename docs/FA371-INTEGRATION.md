# FA371 声学相机接入状态

> 本文是**进行中**的接入记录，不是完成报告。每轮结束更新。
>
> - 协议规格（从厂商手册抽取，含全部"手册未说明"清单）：`docs/reference/FA371-api-spec.md`
> - 手册纯文本（图题在、插图不在）：`docs/reference/FA371-manual-en.txt`
> - 离线 mock：`scripts/mock-fa371.cjs`
> - 端到端验证：`npm run verify:fa371`

---

## 1. 两个产品族，一套设备表

从数据库 schema 3 开始，`devices` 表带 `kind` 列（`acousticBox` / `acousticCamera`），
默认与回填值都是 `acousticBox`——因为在这一列存在之前，表里每一行**确实**都是声纹盒子，
这不是"图方便"，是唯一正确的回填。

两个族**共享的东西极少**，这正是必须显式区分的原因：

| | 声纹设备（AE08/FA8） | 声学相机（FA371） |
|---|---|---|
| 身份 | `GET /get_devinfo` 返回 Device ID/SN | **没有任何身份接口** → 由地址派生（见 §2） |
| 通道 | 8 路，`GET /get_passageway` | 无通道概念 |
| 存活判定 | `GET /get_devinfo` | `GET /system/detect_status` |
| 端点族 | `/features_stream`、`/audio_stream`、告警位掩码 | `/system/*`、`/run_mode`、`/alarm_strategy`、`/alarm_condition`、检测任务 |
| 登录 | `md5(明文 + 'lfxs')` | **同一个盐**（手册 §2.1，与 AE08 同源） |

**认证已经不用猜**：`shared/.../auth-strategy.ts` 里的 `derivePassword`（`md5(明文+'lfxs')`）
和 `Authorization: <token>`（无 `Bearer` 前缀）都是真机实测过的结论，FA371 手册也写了同一个盐。
mock 的 `--auth-mode raw|bearer|both` 就是用来演练手册 §2.2 那处未定义风险的。

## 2. 相机的身份是"铸造"出来的，这一点必须让用户看见

规格 §6 的结论：手册列了 32 个开放接口，**没有一个返回身份或版本**。
因此相机无法满足本仓库的"身份不是 IP"规则，`camera-identity.ts` 的做法是：

```
device_uid = fa371:<ip>:<port>
```

- 同一地址重复添加 → 识别为同一台，更新地址，不产生第二行；
- **改 IP → 识别为新设备**（新的一行）。

第二条是刻意的：设备无法自证"我还是我"，静默合并两台恰好复用了同一 IP 的相机，
比多出一行严重得多。Add 对话框因此在选中"声学相机"时显示这条提示
（`addDeviceUi.cameraIdentityNote`，四种语言）。

**待办**：真机到位后用 Protocol Lab 试探是否存在未文档化的身份接口（同一固件族既然共用
`lfxs` 盐，很可能有 `/get_devinfo`）。一旦摸到，改为优先使用设备自报值，把铸造值降为兜底。

## 3. 已完成

| 项 | 位置 | 验证方式 |
|---|---|---|
| 设备族模型 + `isDeviceKind` 守卫 | `shared/domain/models.ts` | `tests/device-kind.test.ts` |
| schema 3 迁移（`kind` 列 + CHECK） | `main/services/database/schema.ts` | 同上（含幂等、非法值被拒） |
| 仓库层：单一写入实现 + 相机路径 | `device-repository.ts` | 同上（盒子仍 seed 8 通道；相机清空通道） |
| 相机身份策略 | `main/services/device/camera-identity.ts` | 同上（大小写、端口兜底、前缀可识别） |
| `probe/add` 分族 + 相机存活判定 | `device-service.ts` | `npm run verify:fa371` |
| 协议客户端（全部 32 端点 + 候选策略） | `main/services/device/fa371/` | `tests/fa371-*.test.ts`（106 项） |
| 离线 mock（含 `--ws`、`--persist`、`--seed`） | `scripts/mock-fa371.cjs` | 自带 43 项断言 |
| Add 对话框族选择器 + 相机提示 | `components/AddDeviceDialog.vue` | GUI 探针（2 个族、语言切换、提示仅在选中相机时出现） |
| **实时视频（RTSP → 内置 ffmpeg → 回环 HTTP → `<video>`）** | `main/services/media/`、`views/MonitorView.vue` | `tests/rtsp-stream.test.ts`（32 项，含真实二进制跑 `testsrc`）+ `npm run verify:packaged`（打包进程内 `-version` 探针） |

## 4. 未完成（后续轮次的顺序）

1. **应用内登录**（管理员 / 普通用户 + 超级密码）——相机是单账号模型（手册只有 `admin`、
   无角色、无找回、改密也没有接口），所以这一条**只能**是应用自己的账户体系。
2. **右键报警配置**——`alarm_strategy` / `alarm_condition` 的增删改查已在客户端就位，
   缺 UI 与 IPC 暴露。
3. **相机页面**——实时声场/成像、检测任务、检测日志与结果文件下载；
   WebSocket 五路（`/fftData`、`/voiceprintData`、`/detectFeedback`、`/energyData`、`/pcmData`）
   尚未接入（客户端已交出 `authHeaders()` 供握手用，但**握手如何鉴权手册未说明**）。
4. **真机联调**——上面每一项的"手册未说明"都必须实测回填；优先：
   `Authorization` 头确切格式、WS 握手鉴权、`PUT /alarm_condition` 的目标条件标识。

## 5. 真机实测结果（192.168.110.235，2026-09-14）

只做了**读操作**：`POST /login` + 若干 `GET`。没有写任何配置。

### 5.1 认证：规格 §2.2 的"第一风险"其实不存在

```
POST /login  {"username":"admin","password":"7cb8406e5a99c917a60681762d7952c2"}
  -> 200 {"token":"870ec7d996f5c5b8f419a036808e1ee0"}
```

- 密码**确实是** `md5(明文 + 'lfxs')`，本机用 `123456` 得到上面那个 hash，登录成功。
- token 是 **32 位十六进制**（形态与 md5 相同），与手册"encrypted token value"一致。
- 后续请求的携带方式——**四种全部被接受**：

| 携带方式 | 结果 |
|---|---|
| `Authorization: <token>` | 200 |
| `Authorization: Bearer <token>` | 200 |
| `token: <token>` | 200 |
| `X-Token: <token>` | 200 |

即这台固件对 token 载体是**宽松**的。客户端仍保留候选顺序（raw → bearer → token:），
因为"宽松"是这台固件的实测结论，不能假设所有批次都如此；但第一候选即命中，首次连接
不再有失败往返。

### 5.2 身份：确认没有身份接口，而且"不存在的路径"返回 200 + 网页

```
GET /get_devinfo      -> 200  <!doctype html>…  (Web UI 的 index.html)
GET /api/get_devinfo  -> 200  <!doctype html>…
GET /system/info      -> 404
```

**这台设备的 SPA 对所有未定义路径返回 `index.html` 且 HTTP 200**，不是 404。
这条比"没有身份接口"更重要，因为它是一个陷阱：

- `response.json` 会是 `undefined`，`unwrap` 会把 `undefined` 当成成功结果交给调用方
  ——"读成功但什么都没读到"，比报错难查得多；
- 这种响应**没有 `ret`**，而"`ret` 缺失即成功"是三个接口（§5.1.15/16/20）的既定规则，
  所以包络校验也拦不住它。

因此客户端 `call()` 增加了显式拒绝：`json === undefined` 且正文以 HTML 开头 → 抛
`INVALID_RESPONSE`。这与下载路径上早已存在的 `looksLikeWave`（同样是为了挡 SPA 的
index.html）是同一个教训的第二次应用。

→ **身份结论不变**：仍由 `fa371:<ip>:<port>` 铸造（§2）。但"找不到身份接口"现在有了
实测依据，而不只是"手册没写"。

### 5.3 手册写错或漏写的地方（实测值）

| 项 | 手册/规格 | **真机实测** |
|---|---|---|
| `GET /system/acoustic` `samplerate` | 示例 13200；合法集 {96000,132000} | **200000**；`freq_down_limit=10`、`freq_up_limit=30` |
| `GET /system/image` 目标数量键名 | 字段表 `target_numbe` vs 示例 `target_number` | **`target_number`**（示例对，字段表错） |
| `GET /system/image` 其它键 | 表中有 `imaging_sensitivity`/`imaging_enhance` | 实测都有，另有手册未提及的 **`energy_threshold`** |
| `GET /system/time` `sys_time` | 8 位，单位未说明 | **10 位 = 秒**；另有手册未提及的 `sys_time_str: "2026-09-14_16-52-04"` |
| `GET /system/detect_status` | 规格称"无包络" | 实测**带** `{"detect_status":0,"msg":"SUCCESS","ret":200}` |
| `GET /system/video` | `video_port` 示例 443 | 实测 `video_port=443`、`video_url="live"`、`rtsp_enabled=0` |

→ 对客户端的直接影响：`samplerate` 的**单位仍未知**（数值 200000 只可能是 Hz，
但那意味着 200 kHz 采样率，与"分析频段 10–30 kHz"并不矛盾）；`sys_time` 应取**秒**；
`target_number` 是唯一正确键名；ENDPOINTS 里三个"无 `ret`"的假设在真机上不成立——
不要把"无 `ret`"当成判据，`ret` 缺失只在真机确认的接口上才允许视为成功。

### 5.4 还没有实测的（下一步优先级）

1. 写接口的响应形状（`PUT /system/*` 的返回体手册一个都没给）。
2. 告警策略/条件的键名（`diagosisn` vs `diagnosis`）与 `id` 类型（string vs integer）。
3. `/system/scan_area` 的坐标参考系（手册 GET 示例 240×168 与 PUT 示例 768×432 不一致）。
4. WebSocket 五路的握手鉴权与二进制字节序。
5. `POST /turn_on_detect` 在智能巡航模式下是否返回 `detect_id`。

> 上述为"读"的部分已由 `.probe-real.cjs` 式的一次性脚本验证；**写操作必须在现场、
> 经确认后再做**，因为它们会改变设备的实际配置。

---

## 6. 怎么在离线状态下开发

```bash
# 1. 起 mock（自行选空闲端口，banner 里有 URL 与"猜过的字段"清单）
node scripts/mock-fa371.cjs --seed --verbose

# 2. 端到端验证（自带 mock、自带临时 Electron profile，不改工作区）
npm run build && npm run verify:fa371

# 3. 对真机跑同一套验证（只读；跳过"错误密码"那一步，因为真机可能锁账号）
npm run build && node scripts/verify-fa371.cjs --host 192.168.110.235

# 4. 演练"Bearer 前缀"这一未定义风险
node scripts/mock-fa371.cjs --auth-mode bearer
```

两个目标都已实测通过：

| 目标 | 结果 |
|---|---|
| mock | `add` 成功 → `kind=acousticCamera`、`fa371:127.0.0.1:<port>`、`ONLINE`；重复添加仍为 1 台；健康检查后仍 `ONLINE`；错误密码 → `AUTH_FAILED` 且不落库 |
| **真机 192.168.110.235** | 同上，`deviceUid=fa371:192.168.110.235:80`，`ONLINE`，健康检查后仍 `ONLINE` |

mock 启动时的 `GUESSED / UNVERIFIED FIELDS` 段落列出每一处它不得不猜的地方及其规格编号，
**不要**把这些当成设备真实行为；它们的作用是让"猜"变得显眼，而不是让它隐形。
（其中若干项已被真机实测取代，见 §5.3；mock 的默认值仍保留"未验证"取向，因为插件的
其他批次未必与这台一致。）

---

## 7. "码流回去"：能做什么、不能做什么

需求里的"支持码流回去"要落到这台相机上，先要分清它有三种"码流"：

| 码流 | 通道 | 本软件能否直接取回 |
|---|---|---|
| **声学实时数据** | WS `/fftData`、`/voiceprintData`、`/energyData`、`/pcmData`、`/detectFeedback` | ✅ **能**，这是主路径：声纹图、实时音频、频谱、能量点、检测反馈 |
| **检测结果文件** | HTTP `GET /detect_file/{saving_path}/{file_name}` | ✅ 能，走已有的下载 + 落盘路径 |
| **视频（H.264 over RTSP）** | `rtsp://<ip>:<video_port>/<video_url>` | ✅ **能在应用内看**：主进程用内置 ffmpeg 转封装成本机回环上的分片 MP4，由 `<video>` 播放（见 §7.1） |

### 7.1 视频：这一轮做了什么，以及为什么这次接受了一个二进制依赖

**为什么不能"直接播"**：Electron/Chromium **不支持 RTSP**，没有对应的解复用器。
`<video src="rtsp://…">` 会直接失败，不会降级成"只有声音"或"一帧静止画面"——它就是一个黑框。
所以必须在应用内把码流重新封装成浏览器认识的容器。

**这一轮的实现**（`src/main/services/media/`）：

```
相机 ──RTSP/TCP──▶ ffmpeg（-c:v copy → 分片 MP4）──管道──▶ 仅回环 HTTP 服务
                                                              │
                     渲染层 <video src="http://127.0.0.1:<临时端口>/<随机令牌>/stream.mp4">
```

- `rtsp-stream.ts`：一台相机一个会话。RTSP 地址来自 `GET /system/video`（`video_port` + `video_url`），
  并复用 `mappers.buildRtspUrlCandidates()` 已有的**具名候选**（无凭据 / 带凭据 / `port=443` 时的 `rtsps`），
  逐个尝试并记录用的是哪一条 —— 与认证载体、WS 握手同一套"探测而不是猜"的做法（另见规格 §8.5 E2/E3）。
- 主路径是**转封装而不是转码**：`-rtsp_transport tcp -i <url> -c:v copy -f mp4
  -movflags frag_keyframe+empty_moov+default_base_moof pipe:1`。`-c:v copy` 不花 CPU、不引入编码延迟、
  不掉画质；它唯一需要额外解决的只有"MP4 必须先写出 moov"，而 `frag_keyframe+empty_moov` 正是为此：
  每个关键帧一个分片，播放器不必等文件结束就能起播。
  重编码（`-c:v libx264 -preset ultrafast -tune zerolatency`）**只作为一次显式、写日志的回退**，
  触发条件写在 `shouldFallbackToTranscode()` 里：只有在**一个字节都没输出**且 stderr 命中
  "Could not find codec parameters / non-existing PPS / Could not write header"这类
  **容器或编解码兼容性**错误时才升级；网络错误不算，已经出过画面也不算。
- 字节流只经过管道，**不落盘、不做额外缓冲**：客户端跟不上时暂停从 ffmpeg 读（背压），
  而不是在 Node 进程里排队。
- 回环服务只绑 `127.0.0.1`，端口由系统临时分配，路径里带每会话随机令牌；令牌不对返回 403 并记日志。
  渲染层侧只放开了 CSP 的 `media-src http://127.0.0.1:*`（以及 `onBeforeRequest` 里对应的回环豁免），
  `connect-src 'none'` 等其余项一字未动 —— `media-src` 只授权媒体加载，不是 fetch/XHR 通道。

**为什么这次接受了新增依赖**（此前本文件明确写过"不引入 ffmpeg"）：

| 顾虑 | 这次的结论 |
|---|---|
| 需要转封装组件 | ✅ 确实需要，没有别的办法让 Chromium 播 RTSP |
| 需要编译器 / 从 GitHub 下载 | ❌ 不存在：`@ffmpeg-installer/ffmpeg` 的二进制**就在 npm 包里**，与本项目"只接受预编译、零工具链"的既定原则一致（BUILD.md §2） |
| 体积 | 约 **64.5 MB**，是安装包里最大的单个文件 —— 为"能实时查看"付的明码代价 |
| 许可证 | 包是 LGPL-2.1，但**里面的二进制是 GPLv3**（`--enable-gpl`）。以独立进程 + 管道方式调用不改变本软件的许可；但发布时须随附 GPLv3 文本与对应源码的书面提供 |
| 崩溃面 | 被框在 `media/ffmpeg.ts` 一个文件里：路径解析、`-version` 探针（结果缓存，失败必成可读状态）、`spawn` 与 kill 保证（含退出时的孤儿清理） |
| 黑框风险 | ffmpeg 缺失或不可运行会上报为**状态**（`ffmpeg-missing`），界面写明原因与它查找过的路径，绝不静默 |

**当前真机状态（2026-09-15 更正）**：此前本文件写过「这台相机的 `rtsp_enabled = 0`，设备侧 RTSP 是关的」，
**那个结论是错的**——错的不是设备，是探针：探测脚本给 RTSP 输入加了 `-timeout`，而本机这份 ffmpeg 构建
把 `-timeout` 当成 RTSP **listen** 模式。实测如下（设备 `192.168.110.235`，服务端 **ZLMediaKit git 7b1f8fe / 2025-05-02**）：

| 命令行 | 结果 |
|---|---|
| `-i rtsp://192.168.110.235:443/live` | 正常，读出一帧真实 JPEG（142 786 字节） |
| `-rtsp_transport tcp -i <同上>` | 正常（141 982 字节） |
| `-timeout 5000000 -i <同上>` | **失败**：`Unable to open RTSP for listening` |
| `-rtsp_transport tcp -timeout … -i <同上>` | **失败**：同上 |
| 应用的真实参数：`-rtsp_transport tcp -i <url> -c:v copy -f mp4 -movflags frag_keyframe+empty_moov+default_base_moof -t 3` | 正常，**1 417 832 字节**，头部 `ftypiso5`，零错误 |

结论与纪律：

1. **绝不给 RTSP 输入加任何 timeout 参数**（`-timeout` / `-stimeout` 都不行）。`rtsp-stream.ts` 的
   「一个错误地址最坏 3 个候选 × 10 秒」那条注释仍然成立，也不要用超时参数去"加快"它。
2. `buildRtspRemuxArgs()` 的参数**本来就是对的**，不需要改动。
3. 手动录像与抓图可以在**真机**上验证（不再只能靠合成源）：`camera-capture.ts` 用同一个
   `-c:v copy` 写 MP4（分片，任意时刻被杀掉都可播放），抓图则是 `-frames:v 1` 一帧 JPEG。
   离线可重复的那部分是 `tests/camera-nvr.test.ts` 里的真二进制用例（`testsrc` 合成源），
   真机一次性验证脚本见 `.camera-nvr-live-check.cjs`。
4. 设备侧的 RTSP 开关（`rtsp_enabled`）读到 0 时仍按「设备事实」处理（不 spawn 一个注定连不上的 ffmpeg）；
   但这**不代表**本机没开通——请以实际 `rtsp_enabled` 读数为准，并以本节命令行为准。

**另一条能力说明**：本机这份 ffmpeg 构建对 lavfi 合成源的编码速度约 **328x 实时**
（`testsrc=320x240@10` → 30 秒素材约 90 ms 编完），所以任何"录一段合成源"的测试都必须用 `-re`
按真实帧率喂数据，否则测到的是「杀掉一个已经结束的进程」。

### 7.2 声学码流：五个通道，两处未定义

WS 通道的**握手鉴权方式**与**二进制负载布局**手册都没写（规格 §6 D1–D8）。
所以实现里这两件事都是**具名候选 + 实测选择**，而不是写死一个猜测：

- 握手鉴权：候选集合按顺序尝试，命中后记住（与 `auth-strategy.ts` 的 token 载体同一套思路）；
- 负载布局：每个通道的元素类型/字节序/尺寸是可选项，**默认值已换成真机实测值**（见 §7.3）；
- `/pcmData` 是 48 kHz，192 000 字节/秒 —— 全速推给渲染层会淹掉 IPC，
  因此音频要按可配置的比例抽取后再上抛，音频缓冲有上限，且上限是显式的。

上一轮遗留的一条硬约束仍然有效：**手册未说明的事项不得靠推断实现**，
要么做成可探测的候选，要么列入 Protocol Lab 的待实测清单。

### 7.3 【实测】五路通道的真实布局，以及客户端默认值改了什么

**测量时间**：2026-09-15。**设备**：`192.168.110.235`（HTTP 80，`admin`）。
**方法**：每一路单独开一个 WebSocket，6 秒窗口统计帧数与字节数，并打印帧长分布与前 16 字节。
**只读**：除 `POST /login` 外没有对设备发出任何写入请求。
完整数据（含逐字节判读与 SVG-less 的 JPEG 头解析）记在
`docs/reference/FA371-api-spec.md` §5.3，此处只讲结论与客户端因此改了什么。

| 通道 | 实测帧率 | 实测每帧字节 | 由字节推出的布局 | mock 的假设（已被推翻） |
|---|---|---|---|---|
| `/fftData` | 10.06 /s | **2052（恒定）** | 4 B 前缀 + **1024 × int16** | 512 × int16 = 1024 B @5/s |
| `/voiceprintData` | 10.07 /s | **~45 200（浮动）** | **JPEG 图像，600×400，4:2:0** | 128×256×int32 矩阵 = 131 072 B |
| `/energyData` | 29.92 /s | **20（恒定）** | 5 × int32（与手册一致） | 5 × int32（一致） |
| `/pcmData` | 10.00 /s | **19 200（恒定）** | **4800 × float32 = 100 ms** | 48000 × float32 = 192 000 B @1/s |
| `/detectFeedback` | 窗口内 0 帧 | — | 未证实（事件流） | 文本 JSON（未证实） |

握手鉴权：四个候选（无认证 / `?token=` / `?Authorization=` / `?access_token=`）
在同一窗口内给出**逐字节相同**的结果（60 帧 / 123 120 字节），
因此**这台固件的握手不需要认证**，`none` 胜出并成为默认。
候选表不删——实测只覆盖这一批固件，"这一批不需要"不等于"永远不需要"。

客户端因此改了三处默认值，并把 mock 的那份假设降级为非默认备选：

1. `fftData`：`int16-le-512` → **`int16-le-1024-h4`**（新增 `headerBytes: 4`）。
   1024 而不是 512，且要跳过 4 字节前缀——真机那 4 个字节在 40 帧里恒为 0，
   本实现**不假装知道它是什么**，只如实跳过并记录。
2. `voiceprintData`：`int32-le-128x256x1` → **`jpeg-image-600x400`**。
   设备推的是它自己渲染好的 JPEG，因此**不做数值解码**，原字节以 base64 走 IPC
   交给 `<img>`（与 AE08 的时频图同一条路）。数值候选仍然保留，mock 与测试用它。
3. `pcmData`：`float32-le-mono-48000` → **`float32-le-mono-4800`**。
   每帧 100 ms 而不是 1 秒；总字节率恰好也是 192 000 B/s，但**帧率是 10 倍**，
   所以 IPC 上的"每秒整块拷贝次数"从 1 变成 10。

**另外加了一道闸门**：`checkFrameLayout()` 把"帧长与所选候选是否一致"变成可见事实
（`Fa371StreamStatus.layoutWarning` / `layoutNote`，以及会话状态里的 `layoutWarnings`），
帧长不符时日志是 warn 级并带出期望值、实际值与帧首字节。原因很直接：实测已经推翻过
一份几何假设，而**帧长是运行期唯一能证伪假设的证据**；没有这道闸门，用错候选的症状就是
"图上有一条看起来挺合理的曲线"。JPEG 与"每帧点数由帧长决定"两种候选显式声明为
不可校验，因此不会误报。

界面上这五路现在有了自己的面板（见 §7.4）。

### 7.4 界面：五路声学数据第一次有了渲染层

在此之前 `MonitorView` 对 `acousticCamera` 只渲染"实时视频"面板，五路 WebSocket
数据在主进程收到了却**没有任何界面**。现在 `CameraAcousticPanel.vue` 提供：

| 面板 | 内容 | 空/错/停的区分 |
|---|---|---|
| 声纹图 | 设备的 JPEG（`<img>`）；数值候选时回落为 canvas 幅度图 | 四种状态各一句文案 |
| 实时音频 | 512 点包络 + peak/rms/峰值因数 + 经 WebAudio 的**可听回放** | 只有收到帧才画波形 |
| 频谱 | 1024 条谱线；设备未上报采样率时横轴标"谱线序号"并说明频率刻度未知 | 同上 |
| 能量点 | 原始整数表（能量/像素横纵/扫描角/方位角），不做单位换算 | "该帧不含目标点"与"尚无数据"分开 |
| 检测结果 | 文本帧列表 | "两次检测之间没有数据是正常的"写进说明 |

"没有数据"与"环境安静"被刻意区分成四种状态：**未启动 / 尚无数据 / 接收中 / 数据已停止
（stale，3 秒没有新帧）**，外加"通道错误"。任何面板都不会为缺失的数据画一条平直的线。
启停按钮走 `window.api.fa371Stream`，**管理员校验在主进程**（与 `cameraLive` 一致），
渲染层只负责把拒绝显示出来。

