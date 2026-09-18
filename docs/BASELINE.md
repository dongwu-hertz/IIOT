# 分叉基线（BASELINE）—— 2026-09-17 收盘状态

这份文档是给**要在这个仓库上开新分支的人（包括未来的我）**看的：当前软件是什么样、
东西都在哪、哪些已经验证过、哪些没有、以及**开新版本时必须继承的规矩**。

- 想核对界面/功能：`docs/UI-VERIFY.md`（人工核对清单 + 未验证清单 + 明天真机怎么跑）
- 想知道某个设计**为什么**这样：`docs/Ivms4200-UX-REFERENCE.md`（按 §15.x 分段，逐条写出处）
- 想知道协议细节与实测发现：`docs/PROTOCOL-FINDINGS.md`、`docs/FA371-*.md`、`docs/reference/`
- **事件中心改造（业主 2026-09-17 新规格）做到哪一步**：`docs/EVENT-CENTER.md`
  （规格逐节对照：要求 → 现状 → 我们的做法；Phase 1–5 已完成，Phase 6 前半（重复触发聚合）已完成，
  Phase 6 后半（人工 Create Incident + 手动关联 Alert）待做）

---

## 1. 一句话状态

一个**离线优先**的 Windows 桌面软件（Electron + Vue 3 + SQLite/DuckDB），管理四种声学设备：
**声纹设备（AE08/FA8）**、**声学相机（FA371）**、**听诊盒子（E2/FA100/FA110）**、
**空气声呐（SN-16，声源定位 + 球机联动）**。设备数据一律经**主进程**取（渲染层不联网）。

| 项目 | 值 |
|---|---|
| 版本 / 产物 | `release\HERTZINNO Acoustic Box Manager-1.0.0-x64-setup.exe`，**127,065,780 B**，sha256 `E61BF6AA2DFF74C01FB661ADEAFB4FA45B799EC374B52CC9D4FB713492139E07`（未签名 → SmartScreen 提示） |
| 技术栈 | Electron 38.8.6 · Vue 3.5.42 · vue-router 4.6.4 · Pinia 3.0.4 · vue-i18n 11.2.1 · TypeScript 5.9.3 · electron-vite 5.0.0 · better-sqlite3 13.0.3（SQLite 3.53.4）· DuckDB 1.4.4 + parquet（趋势）· echarts 6.1.0 · 内置 GPLv3 ffmpeg |
| 业务库 | SQLite，**schema v12**（12 条迁移，见第 5 节） |
| IPC | `src/shared/ipc/contract.ts` 里 **171** 个通道；主进程逐一登记权限 |
| 界面语言 | **四本目录必须同步**：`zh-CN` / `en` / `es` / `tr` |
| 单测基线 | **1693 / 0 失败**（`npm test`） |

> 上面这两行是**分叉当时**（2026-09-17 收盘）的快照，不是最新一轮的数字：分叉之后又做了
> 事件中心 Phase 1–6（schema **v14**：v13 加了处置工作流，v14 加了 Incident）、
> 相机选择器那个 bug、"应用级失败进告警图标"，以及业主 2026-09-18 第 10 批（24 条）的前三条。
> **当前**数字每轮都写在 `docs/UI-VERIFY.md` 对应的那一段里 —— 截至 2026-09-18 第 10 批：
> 单测 **1942 / 0 失败**、schema **v14**、安装包 sha256
> `5E0D04686C14A018E1D331C5466349758E204F120ADA71EA5CF1DC947D2643B3`（见该文 AA / BB / CC / DD 段）。

---

## 2. 四种设备族（协议层是这一节，别的都是外壳）

| 机型 | `DeviceKind` | 协议客户端 | 读通道 | 写通道 | 现成能力 |
|---|---|---|---|---|---|
| 声纹设备 AE08/FA8 | `acousticBox` | `device/device-api-client.ts` | `/get_devinfo`、`/get_passageway`、WebSocket 四条流 | `/set_devinfo`、`/set_passageway`、告警参数、网络/时间/RS485/Modbus | 实时监测（通道墙、趋势、四张图谱、每通道声纹特性、音频回放）、历史趋势（DuckDB）、录音 |
| 声学相机 FA371 | `acousticCamera` | `device/fa371/fa371-api-client.ts` | 检测状态/日志、策略、RTSP、`/detectFeedback` 等 | 检测启停、模式、策略 CRUD、升级 | 单路 16:9 直播（主进程 ffmpeg 转封装 + 回环端点）、五张声学图、检测记录下载与播放 |
| 听诊盒子 E2/FA100/FA110（2023 版） | `auscultationBox` | `device/e2/e2-client.ts`（变体 `auscultation`） | `/workmode`、`/system`、`/basic`、`/alarm_log_all` | 参数 `PUT /system`、改名、心跳设置、重启 | 参数与告警同步（含 10 张时频谱图）、实时检测页的"拉"通道那一屏 |
| **空气声呐 SN-16**（Air Sonar V3.2/真机 V3.4.0） | `auscultationBox`（变体 `airSonar`） | 同上（同一客户端，**按设备回话判代次**） | `/system`（球机那组 `cam_*`）、`/basic`、`/alarm_log_all`、静态文件 `/static_file/` | `PUT /system`（整份回写）、`PUT /time_sync_with_nvt`、`/reboot` | **PTZ 联动配置页**（唯一页签）、告警 + 球机抓图（3 张、落库并可看图）、点位图 |

**判代次不按型号名猜**：`shared/domain/e2.ts` 的 `detectE2Variant()` 看 `/system` 里有哪些键
（有 `cam_enable`/`cur_realtime_channel`… ⇒ 空气声呐；有 `work_mode` ⇒ 2023 版），判出来的结果
落在 `devices.e2_variant`（v12），界面按它决定给哪一组页签。

**真机实测过、与手册不一样的地方**（改代码时别"改回手册"）：那台 SN-16（V3.4.0.2024-11-27）
的 `/get_*` 路径**全是 404**，实际用 `/alarm_log_all`、`/alarm_log`、`/basic` + 静态文件
`/static_file/<saving_path>alarm.wav|1..3.jpg`；客户端按"设备回话说了算"逐条 404 回退并**记住路径**
（见 `docs/Ivms4200-UX-REFERENCE.md` §15.37）。

---

## 3. 代码地图

```
src/
  shared/                     ← 主进程与渲染层共用的**契约与纯函数**（唯一真相）
    ipc/contract.ts           ← 171 条通道 + 所有 IPC 形状
    domain/models.ts          ← Device / AlarmEvent / Channel / 安装信息 …
    domain/e2.ts  e2-ptz.ts   ← 听诊盒子族：变体、端点表、PTZ 字段与归一化/读回比对（纯函数）
    domain/device-installation.ts ← 点位/方位角/分贝的解析与范围（界面与主进程共用）
    domain/device-map.ts      ← 点位图投影（等距圆柱 + cos(纬度) 压缩，纯函数、有单测）
    domain/sample-*.ts        ← 样本库/标签/AI/本地分类器（**AI 训练版的主战场**，见第 8 节）
    domain/camera-*.ts        ← 相机策略/直播/画面墙/检测文件
    i18n/messages/{zh-CN,en,es,tr}.ts ← 四本目录（必须有同样的键）
  main/
    index.ts                  ← 窗口、CSP、回环服务生命周期
    ipc/handlers.ts           ← 每个通道：权限 + 参数收窄（业务逻辑不写在这里）
    services/app-services.ts  ← 组装：谁依赖谁（新服务在这里挂）
    services/device/          ← device-service.ts（三族客户端 + 探活 + 健康检查）
                                 device-api-client.ts（FA8）· fa371/* · e2/*
    services/database/        ← schema.ts（迁移）· *-repository.ts（SQL 只在这里）
    services/storage/         ← 存储根、相对/绝对路径换算、写盘（临时文件 + rename）
    services/media/           ← video-file-server.ts（本机 mp4/jpg 的回环端点）· rtsp-stream.ts
    services/trend/           ← DuckDB + parquet（历史趋势）
    services/sample/          ← 样本库 / 标签 / AI 打标 / 数据集导出（见第 8 节）
    services/linkage/         ← 告警联动（录像/弹窗/提示/邮件 SMTP）
  preload/index.ts            ← window.api.*（渲染层唯一的出口）
  renderer/src/
    views/                    ← 12 个路由页面（总览/设备管理/设备详情/**点位图**/实时监测/
                                 告警/事件中心/录音/样本库/趋势/设置/协议实验室）
    components/               ← 面板与对话框（AddDeviceDialog、AirSonarPtzPanel、
                                 AuscultationPanel、DeviceInstallationCard、CameraXxx…）
    stores/                   ← Pinia：只放"界面状态 + 调用 IPC"，不放业务规则
    lib/                      ← 纯函数（格式化、通道状态、投影调用、音频预览…）
scripts/                      ← 验证工具（第 7 节）：探针、假设备、打包校验、i18n 审计
tests/                        ← node:test 单测（跑在编译产物 .test-build/ 上）
```

---

## 4. 存储与路径

- **存储根**（设置里可改，默认 `D:\HertzinnoData`）下有 `audio/ video/ snapshot/ detect/ metrics/ export/ logs/`。
- 入库一律**存储根相对路径**（`audio/<deviceUid>/<YYYY>/<MM>/<DD>/CHxx/<kind>/…`），
  写盘用绝对路径；换存储根目录不会让旧记录失效。`StorageService.resolve()` 有越界保护。
- **本机文件给界面**只有一条路：主进程回环 HTTP（`127.0.0.1` + 路径里的每会话令牌）。
  `media-src`/`img-src` 为此放行 `http://127.0.0.1:*`；`connect-src` **仍然是 `'none'`**。
- 相机直播/录像走 `rtsp-stream.ts`（ffmpeg 转封装 + Range），本机 mp4 与告警抓图走
  `video-file-server.ts`（同一个实例，两条安全推理只维护一处）。

---

## 5. 数据库：迁移规矩（分叉加表/加列时照这个来）

`schema.ts` 的 `MIGRATIONS` 是**只增不改**的列表，`SCHEMA_VERSION` 必须等于最高版本：

| 版本 | 名称 | 加了什么 |
|---|---|---|
| v1–v5 | 初版 → 认证策略 → 机型 → 账号 → 录像容器格式 | — |
| v6 | 告警等级与备注 | `alarms.severity/note` |
| v7 | 样本库 | `samples` |
| v8 | 标签两维 | `sample_labels`、`samples` 重建 |
| v9 | 听诊盒子族载荷 | `alarms.source/device_alarm_value/device_reason/files_status/device_raw` |
| v10 | 第三种机型 | `devices.kind` 的 CHECK 放宽（**重建父表**：必须 `foreignKeysOff`，否则级联删子行） |
| v11 | 安装信息 | `devices.gis_latitude/gis_longitude/azimuth_deg/sound_level_db` |
| v12 | 代次 + 抓图目录 | `devices.e2_variant`、`alarms.snapshot_dir` |

四条规矩：

1. **加列用 `ALTER TABLE ADD COLUMN`**，可空、**不加 CHECK**（范围校验在应用层一处，写死进 SQL 会出现两套判据）。
2. **改 CHECK 必须重建表**：外键打开时 `DROP TABLE` 会先做隐式 DELETE 并级联删子行 ——
   迁移器有 `foreignKeysOff` 开关，重建后必须 `PRAGMA foreign_key_check` 为空才算过。
3. 每条迁移都要有单测：老库升上来、**老数据一行不少**、可重复执行。
4. 业主的硬规矩：**每个写设备的操作必须读回验证**（写库的也一样：写完再读一次再断言）。

---

## 6. 必须继承的硬规矩（写在代码注释与文档里的约定）

1. **手册未说明的一律标注「手册未说明」**，绝不编造；我们自己的设计必须写明出处。
2. **不新增依赖**（除非业主同意）；渲染层**不联网**（CSP `connect-src 'none'` 是硬约束）。
3. **四本语言目录同步**：新增文案必须 `zh-CN/en/es/tr` 都加，`node scripts/i18n-orphans.cjs` 必须 0 缺失/0 可删。
4. **协议 DTO → mapper → 领域模型 → 界面**：固件字段名只能出现在 `dto.ts` / `mappers.ts`。
5. **写操作的探针排在所有只读探针之后**（探针之间不许互相影响）。
6. **界面不写解释性散文**：一句状态说明可以，成段的"为什么"写在文档里。
7. **颜色只用 `main.css` 的 CSS 变量**；表格/按钮/卡片用既有类（`.table-wrap` `.btn` `.card`…）。

---

## 7. 验证手段（改完代码照这个顺序跑）

| 命令 | 通过判据 | 说明 |
|---|---|---|
| `node .\node_modules\typescript\bin\tsc --noEmit -p tsconfig.node.json` | exit 0 | 主进程 |
| `node .\node_modules\vue-tsc\bin\vue-tsc.js --noEmit -p tsconfig.web.json` | exit 0 | 渲染层 |
| `npm test` | `fail 0` | 单测（先 `tsc -p tsconfig.tests.json` + `rewrite-aliases.cjs`） |
| `node scripts\i18n-orphans.cjs` | 缺失 0 / 可删 0 / 键集一致 | 四语言 |
| `node .\node_modules\electron-vite\bin\electron-vite.js build` | `✓ built` | 出 `out/` |
| `node scripts\demo-shot.cjs --with-data --out .demo-shots` | `problems : 0` | **GUI 探针**：真窗口里点、量 DOM、截图；用真库副本（只读复制） |
| `node scripts\verify-packaged.cjs` | 25 通过 / 0 | 打包产物冒烟（原生模块、ffmpeg、登录、四语言、IPC） |
| `npm run dist:win:offline` | 出 setup.exe | NSIS 安装包（约 6–8 分钟） |

**假设备**（探针外场就用它们，不需要真机）：

- `node scripts\mock-device.cjs` —— FA8（故意别扭：非显然的 token 载体、字段类型乱）
- `node scripts\mock-fa371.cjs` —— 相机
- `node scripts\mock-air-sonar.cjs --port 9301 --password admin123` —— **SN-16 空气声呐**（本轮新增，
  含 `/system` 可写、`/alarm_log_all`、`/static_file/` 抓图、`/workmode` 回 404）
- `node scripts\e2-live-proof.cjs --ip 127.0.0.1 --port 9301 --password admin123 --spectrograms`
  —— 走**真应用主进程**对着上面那台假设备跑整条链（探活 → 加设备 → 安装信息读回 →
  状态 → 同步 → **抓图取回** → **PTZ 原值写回并读回**），通过判据 `problems : 0`。

> 真机那一条：`node scripts\e2-live-proof.cjs --ip 192.168.110.234 --password <口令>`，
> 预期与每种失败的含义写在 `docs/UI-VERIFY.md` §八。**2026-09-17 当天设备不在线，未跑成。**

---

## 8. AI 训练版：**现在已有什么、缺什么、建议从哪接**

这一节是给下一个任务（"增加 AI 训练版本"）的地基盘点。**大部分地基已经在了** ——
不是从零开始，但离"能用的训练版"还有明确的一段。

### 8.1 已经有的（都在这条链上，已编译进当前包）

| 资产 | 位置 | 现状 |
|---|---|---|
| 样本库（本机异常声纹样本） | 表 `samples`（v7/v8）+ `services/sample/sample-library-service.ts` + `views/SamplesView.vue` | 可从**告警**或**手动录音**入库；带特征向量（`SAMPLE_FEATURE_METRICS`）与两次标签 |
| 两个标签维度 | `shared/domain/sample-library.ts`（`equipment` / `fault`）+ `sample-label-service.ts` + `sample_labels` 表 | 标签来源三档：`device`（设备弱标签）/ `human`（人工，真值）/ `ai`（候选） |
| **训练（本机、无依赖）** | `shared/domain/sample-classifier.ts` + `SAMPLE_TRAIN` IPC（`sample:train`） | 标准化 + 逻辑回归式分类器 + **留一法评估**；指标**带着局限一起回报**（合同里写明） |
| 训练集口径 | `isTrainable()` | **只认人工标签**；AI 标签**不进训练集**、也不覆盖人工标签（这是刻意的） |
| AI 打标 | `shared/domain/sample-ai.ts` + `services/sample/sample-ai-label-service.ts` | **OpenAI 兼容 chat**（操作员自己填 endpoint/model/key）；一次最多 50 条、超时 20s、prompt 版本 1；**只发特征与标签文本，不发音频** |
| AI 配置存储 | `sample-ai-store.ts` | 密钥 `safeStorage` 加密后落盘；系统加密不可用时**失败关闭** |
| 数据集导出 | `services/sample/sample-dataset-export.ts` | 写出 `samples.jsonl`（每行同键、缺的写 `null`）+ `samples.csv`（带 BOM）+ `dataset-info.json`（版本/时间/条数），可选复制音频 |
| 界面 | `views/SamplesView.vue` + `stores/samples.ts` | 样本列表/筛选/打标/入库/导出/AI 打标的入口 |

### 8.2 已知的缺口与**未验证**（新任务要正面处理的就是这些）

1. **从来没有对着一个真实的大模型端点跑过**（`docs/Ivms4200-UX-REFERENCE.md` §15.24.3/.4 明写）。
   所以 `buildLabelMessages` / `parseLabelReply` 只有单测，没有一次真回话。
2. **训练只有"评估"，没有"模型产物"**：`sample:train` 返回指标（`SampleTrainingReport`），
   但分类器**没有落盘、没有版本、没有再用它预测**的路径 —— 这正是"训练版"最该补的一段。
3. **特征只有统计量**（SPL/主频/平滑度/带能量比 + 扩展指标），**没有音频本身进模型**：
   现在的 AI 打标与分类器都只看这些数。要做声纹级训练（频谱图/嵌入）需要新的特征管线。
4. **样本量**：训练集要求人工标签；现场能不能攒够样本是产品问题（`countByLabel` 能给出分布）。
5. **AI 标签的可信度**：`ai` 标签不进训练集这条规矩要不要在训练版里改（例如"人工确认后转正"），
   是一个**产品决定**，不是实现细节。

### 8.3 建议的接法（按最小改动排序，供新任务参考）

1. **先把"训练产物"落地**：新增迁移 v13（`models` 表：id/名称/算法/特征版本/训练集快照摘要/
   指标/创建时间/文件相对路径），`sample:train` 增加"保存为模型"，存储写 `models/`；
   再给一条 `sample:predict(modelId, sampleId)` 走同一份 `predict()`。
2. **再接"用模型给新样本打候选标签"**：复用 `LabelSource = 'ai'` 的纪律（不进训练集、不覆盖人工），
   界面标出"来自本机模型 v1"而不是来自大模型 —— 两个来源必须在界面上分得开。
3. **然后才是特征升级**（频谱图/嵌入）与外部训练框架：那一步要业主先定
   "训练在哪跑、模型给谁用、要不要联网"，因为它会撞上第 6 节的"渲染层不联网"和"不新增依赖"。
4. **验证照抄这一套**：纯函数进 `tests/`（分类器与解析器已经有测试），
   跨进程的进 `demo-shot` 探针（样本库那一页已有探针），
   涉及设备/文件的给一条独立 proof 脚本（照 `e2-live-proof.cjs` 的形状）。

---

## 9. 当前未验证清单（**别按已验证验收**）

| 未验证的事 | 在哪记着 |
|---|---|
| **真机 PTZ 写入（SN-16 上这一次原值写回）** —— 2026-09-17 设备全天不在线（4 次探活全超时） | `UI-VERIFY.md` §七.1 + §八（明天在公司的第一条） |
| 「与球机对时」按钮的真实效果（手册未写请求体，我们发空对象） | §七.2 |
| 真机上的告警抓图（那台设备上 1001 条告警里 6 条 `files_status=1`，连它们的 `1.jpg` 也是 404） | §七.3/.4 |
| 邮件端到端（没有可用 SMTP）、两处声音只有数学层证据 | §六（第 7 批）/§七 |
| 声呐的实时流（手册给的三条 WebSocket 路径，一条都没接） | `UI-VERIFY.md` §六.1 |
| 机型自动识别会先发若干**注定失败**的登录（是否触发设备锁定策略未验证） | §六 末注 |
| **AI 打标从未对着真实大模型端点跑过** | `Ivms4200-UX-REFERENCE.md` §15.24 |

---

## 10. 开分叉时的实务提醒

- **基线提交已经打好了**：`621fd23`「基线：四种设备族 + schema v12（业主 2026-09-17 第 8 批收尾）」
  —— 本仓库的**第一个** commit（354 个文件，190,361 行）。分叉就从它开始：
  ```
  git switch -c feature/ai-training      # 在基线上开分支
  ```
  在此之前工作树里所有文件都是未跟踪状态，没有可回溯的基点。
- 根目录历次探针的 `*.proof-*.log` / `.demo-*.log` 是原始输出，`.gitignore` 已忽略 `*.log`；
  截图目录（`.demo-shots*/`）、`.e2-live-proof*/`、`.remember-proof/` 与 `*.tsbuildinfo`
  也一并忽略了（2026-09-17 整理时补的规则）。
- 新版本请**接着 v12 往后加迁移**，不要修改已发布的迁移；`SCHEMA_VERSION` 与
  `MIGRATIONS` 最高版本必须一致（有单测钉着）。
- 界面新增文案四语言一起加；新增权限要在 `shared/domain/auth.ts` 的 `PERMISSION_OPERATIONS`
  登记（`tests/account-settings-round.test.ts` 会检查"每一项权限都至少管一个操作"）。
