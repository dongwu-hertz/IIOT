# AO01 气井泄漏监测装置：接入评估与验证计划（2026-11-12）

业主给的接口文档：`C:\Users\wudon\Desktop\气井泄漏监测装置接口文档.md`
目标设备：`192.168.110.200`（账号按文档 mock 为 `admin`，密码 `123456`）。

> **当前状态：设备不可达。** 2026-11-12 本机对 `192.168.110.200` 的 80/81/443/554/
> 3000/5000/8000/8001/8080/8081/8088/8888/9000/27001/28001/28003 全部 TCP 连接超时，
> ICMP 也不通。因此下面的结论来自**接口文档形状**与本地回归，不是真机实测。

## 1. 结论先说

AO01 的协议与现有 **AE08 / FA8 声纹设备族**同源：

- `/login` 的请求体是 `{ msgBody: { username, password: md5(明文 + 'lfxs') } }`；
- 会话 token 在 `msgBody.token`，受保护请求带 `token: <token>` 头；
- `/get_devinfo`、`/get_passageway`、`/get_samplingrate`、`/get_network`、
  `/get_timeset`、`/set_passageway`、`/audio_stream`、`/freq_domain`、
  `/time_freq_domain` 的路径与包络都与 AE08 一致。

因此**不需要新增 `DeviceKind`**：按现有 `acousticBox` 接入即可。已用文档里的逐字段
形状做了一条端到端回归 `tests/ao01-integration.test.ts`：

- 自动识别为 `acousticBox`；
- 设备名取设备自己的 `devname`（`AO01`）；
- 身份取 `dev_mac`；
- `/get_passageway` 的 8 路里 `dchEn=1` 落在 `dchId=4/7`（CH5/CH8），落库为
  `channelIndex=[4,7]`，名称 `name5/name8`，传感器类型 0/1；
- 认证策略落库为 `token-header`。

## 2. 文档里与 AE08 不同、需要真机确认的地方

| 项 | AO01 文档 | 软件现状 | 风险 |
|---|---|---|---|
| `/features_stream` | **文档未列出** | 实时监测的四张指标卡（声压级/平稳度/能量比/主频）依赖它 | 可能四张卡无数据；音频/频谱/时频图不受影响 |
| `/channel_select` | **文档未列出** | 切通道时软件会调它（失败只记日志，不阻断开流） | 特征流/频谱跟随设备当前通道，切页签可能不切数据 |
| `/get_alarm_audio` | 返回 `msgBody.alertArray`，字段 `dalId/dalChId/dalAbnoType/dalStartTime/dalduration` | 软件按 AE08 的 `audioArray` + `dau*` 映射 | 告警库现在会同步不到；`dalAbnoType` 文档写 0 正常/1 异常，**不是** 14 位 alarm mask |
| 告警音频文件 | `GET /audio?alert_id=<dalId>` 返回 `audioArray`（`dauFileName` 等） | 软件没有这条按 alert_id 取文件的路径 | 告警记录没有可下载文件名 |
| `/run_detect` / `/stop_detect` / `/query_detect` | 存在；`recorder` 为通道号数组 | 软件没有接这三个接口 | 检测启停/状态可能需要；否则只能靠设备默认行为 |
| `/detect_model` | 模型数组（`dmodelId/dmodelName`） | 软件没有接 | 告警策略/模型选择可能缺上下文 |
| `/auto_record` | 自动录音使能/间隔/时长 | 软件没有接 | 设备侧自动录音无法从软件配置 |
| `/get_alarm_system` | `alarmparaArray`（`dalModeId/dalModeName/dalRecord/dalDeteSen/dalId/dalName`） | 软件按 AE08 的阈值型告警参数映射 | 告警参数页可能字段对不上 |

> 其中**告警模型**是最需要真机数据的一项：`dalAbnoType=1` 究竟代表「异常/泄漏」还是
> 某个模型 id，文档没有给出枚举；按现有 `AlarmType` 的 14 位 bitmask 硬套会显示成
> 错误的告警类型，所以没有在设备上线前猜。

## 3. 设备上线后的验证步骤（按顺序）

1. 确认能 ping 通 `192.168.110.200`，且 80 端口可连；
2. 跑通用诊断（只读，不改设备）：

   ```powershell
   $env:ACOUSTIC_BOX_PASSWORD = '123456'
   node scripts/protocol-diagnose.cjs --ip 192.168.110.200 --user admin
   ```

3. 用 `admin/123456` 在软件里「添加设备」——不需要选机型，自动识别应显示
   「已识别为：声纹设备」，设备名 `AO01`；
4. 抓取下面几条原始响应（只读）：

   - `POST /login`（确认 token 在 `msgBody.token`）
   - `GET /get_devinfo`
   - `GET /get_passageway`
   - `GET /detect_model`
   - `GET /query_detect`
   - `PUT /get_alarm_audio`（`msgBody:{page_start:0,page_size:10}`）
   - 对一条告警 id 执行 `GET /audio?alert_id=<dalId>`
   - `/audio_stream`、`/freq_domain`、`/time_freq_domain` 各抓一帧（确认帧格式与 AE08
     的 Float32/JPEG 假设一致）

5. 依据真实响应补：
   - `extractAlarmAudio` / `mapAlarmRecording` 的 AO01 分支（或新增独立告警模型）；
   - `/audio?alert_id` 的下载路径；
   - `/run_detect` / `/stop_detect` / `/query_detect` 的启停与状态；
   - 若确实没有 `/features_stream`：实时监测页对 AO01 隐藏四张指标卡并说明原因，
     而不是让它们永远空着。

## 4. 当前已经交付的

- `tests/ao01-integration.test.ts`：文档形状下的自动识别 + 添加 + 通道表回归；
- 本文档：兼容性结论、差异清单、上线后的抓包与补丁顺序。

未交付：告警库/检测启停/自动录音/检测模型的接线 —— 需要设备在线后的真实响应，
按本仓库「不猜设备字段」的规矩，先不写。