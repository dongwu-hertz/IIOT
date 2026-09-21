# FA8 / AE08 真实协议实测报告

> **来源**：对真机 `192.168.110.90`（`devname: AE08`）的只读实测
> **方式**：结合设备原生 Web UI 前端代码（`/static/js/main.*.js`）静态分析 + 实际 HTTP/WebSocket 请求验证
> **结论**：规格书 §19 列出的 7 项未知**已全部确定**；其中 **6 项与规格书假设不符**
>
> **更新（触发真实告警后）**：风险 6 与附录 B 告警位映射**亦已实测确认**。
> 目前仅剩"公网告警音频需固件改造"一项属固件方范围。

本文档是**实现基线**。规格书是需求基线；两者冲突时，**以本文档为准**——
因为它是实测的，规格书是推断的。

---

## 0. 最重要的结论：规格书的协议假设大部分是错的

规格书依据的是 `05_FA8 API_20250207_v1.0` 与 `04_Acoustic Box HTTP Explanation_20260226`。
真机固件版本为 `567E68F.2026-06-26_WEEK26.XSUSER.V.1.0.8`，实际协议与之差异很大。

如果按规格书直接实现，**登录就会失败**——这正是我们实测时第一次遇到的情况：
用规格书假设的 `{username, password}` 登录，设备返回 `{"message":"Incorrect username or password.","result":2}`。

---

## 1. 认证协议（规格书风险 1 — 已解决）

### 1.1 登录请求

```http
POST /login
Content-Type: application/json

{ "msgBody": { "username": "admin", "password": "<MD5(明文密码 + 'lfxs')>" } }
```

**两个关键点，规格书都没写：**

1. **请求体被 `msgBody` 包裹**，不是裸的 `{username, password}`
2. **密码是 `MD5(明文 + "lfxs")`** —— 拼接固定盐 `"lfxs"` 后取 MD5，十六进制小写

```
明文 123456
→ MD5("123456lfxs")
→ 7cb8406e5a99c917a60681762d7952c2
```

> 上例为**测试向量**（弱口令），保留在此是为了让哈希算法可被独立复核，
> **不是任何在用设备的凭据**。生产环境的密码应通过应用内「添加设备」对话框录入，
> 由 OS 凭据库加密存储（规格书 §14.1），不得写入代码或文档。

### 1.2 登录响应

```json
{ "message": "ok", "msgBody": { "token": "7cb8406e5a99c917a60681762d7952c2" }, "result": 0 }
```

**实测发现：返回的 token 就是密码哈希本身**（`token === MD5(password + "lfxs")`）。
这不是一个独立的会话令牌，而是口令派生物。安全性影响见 §1.5。

### 1.3 后续请求携带 token（规格书风险 1 的答案）

设备的请求拦截器（取自其前端代码，实测有效）：

```js
headers = {
  token:         sessionStorage.token,   // 自定义头
  Authorization: sessionStorage.token,   // 同时放这里，且【没有 "Bearer " 前缀】
  "Content-Type": "application/json"
}
```

**设备同时接受两种形态**。实测确认两种都能通过认证。

对应到本项目的 `DeviceAuthStrategy` 候选：

| 候选 id | 是否命中 | 说明 |
|---|---|---|
| `bearer-header` | ❌ | 加了 `Bearer ` 前缀，设备拒绝 |
| **`raw-auth-header`** | ✅ | `Authorization: <token>` |
| **`token-header`** | ✅ | `token: <token>` |
| `x-token-header` | ❌ | 头名不对 |
| `cookie-session` | ❌ | 设备不用 cookie |
| `query-token` | ❌ | 设备不读 URL 参数 |

**解析器的候选顺序会先试 `bearer-header` 并失败，然后命中 `raw-auth-header`**——
所以现有代码可以工作，但每次都会浪费一次失败尝试。
应把 `token-header` 提到最前，或在发现设备为 AE08/FA8 时直接使用该策略。

### 1.4 统一响应信封（全部端点）

```json
{ "message": "ok" | "<错误描述>", "msgBody": { ... }, "result": 0 }
```

- `result === 0` 表示成功；非 0 表示失败（登录失败为 `2`，查询失败为 `1`）
- **数据在 `msgBody` 里**，不是规格书假设的 `data`
- 错误信息在 `message` 里（英文）

**这是本项目 Mapper 必须修改的地方**：现有 `unwrap()` 找的是 `code`/`data`，找不到 `msgBody`。

### 1.5 安全提示（应反馈给固件方）

- Token 是密码哈希的**确定性函数**：同一密码永远得到同一 token，无过期、无随机数
- 因此 token 一旦泄露等于密码泄露（可直接反查弱口令）
- 密码盐 `"lfxs"` 是**全局固定值**，前端 JS 中明文可见，不提供实际防护
- 传输为**明文 HTTP**，token 在每个请求的头部反复出现

V1 客户端无法修复这些，但**必须在文档中记录**，并建议固件方改为随机会话令牌 + HTTPS。

---

## 2. 设备端点清单（实测）

### 2.1 规格书附录 A 中**确实存在**的端点

`/login` `/get_devinfo` `/get_network` `/set_network` `/get_passageway` `/set_passageway`
`/get_samplingrate` `/set_samplingrate` `/get_alarm_system` `/add_alarm_system`
`/del_alarm_system` `/get_timeset` `/set_timeset` `/get_rs485` `/get_all_available_serial`
`/set_rs485` `/get_modbus_para` `/set_modbus_para` `/upload` `/system_control`
`/get_date_push` `/set_date_push` `/get_audio` `/get_alarm_audio` `/dele_audio`
`/dele_alarm_audio` `/features_stream` `/audio_stream` `/freq_domain` `/time_freq_domain`

### 2.2 规格书**遗漏**的端点（真机存在）

| 端点 | 方法 | 用途 |
|---|---|---|
| `/set_devinfo` | PUT | 修改设备名称等（规格书只有 get） |
| `/get_cur_ch` | PUT | 读取当前选中通道 |
| `/channel_select` | PUT | 切换当前通道 |
| `/recorder_conf` | PUT | 录音配置 |
| `/preview` | — | 预览 |
| `/system_log` | — | 系统日志（实测 405，可能需要不同方法） |
| `/user` | — | 实测 404，前端引用了但设备未实现 |

### 2.3 规格书附录 A 中**不存在**的端点

- `/tcp_pcm` —— 真机无此端点（TCP RAW 推送可能已废弃或改名）
- `/voiceprintAnalyse`、`/voiceprintDataCollect` —— 未在真机前端出现
- `/audio_file/{filename}` —— 未验证到；录音下载路径需另行确认（见 §5）

### 2.4 方法差异

- `/get_audio`、`/get_alarm_audio`、`/get_cur_ch`、`/channel_select`、`/recorder_conf`
  使用 **PUT**（与规格书一致 ✅）
- `/get_devinfo`、`/get_network`、`/get_passageway`、`/get_samplingrate`、
  `/get_alarm_system`、`/get_timeset`、`/get_rs485`、`/get_modbus_para`、`/get_date_push`
  使用 **GET**（与规格书一致 ✅）

---

## 3. 真实字段名（Mapper 必须按此修改）

### 3.1 `GET /get_devinfo`

```json
{
  "message": "ok",
  "msgBody": {
    "dev_mac": "02:EF:A2:52:F1:C5",
    "dev_version": "567E68F.2026-06-26_WEEK26.XSUSER.V.1.0.8",
    "devname": "AE08",
    "fpga_version": "V2.1.2_20260601.16BIT",
    "web_version": "V2.1.0.WEB.2025-06-05"
  },
  "result": 0
}
```

| 域模型字段 | **真实字段** | 规格书假设（错误） |
|---|---|---|
| `name` | `devname` | `name` / `device_name` |
| `mac` | `dev_mac` | `mac` / `mac_address` |
| `firmwareVersion` | `dev_version` | `device_version` |
| `fpgaVersion` | `fpga_version` | ✅ 一致 |
| `webVersion` | `web_version` | ✅ 一致 |
| `deviceUid` | ⚠️ **无 SN / device_id 字段** | 规格书假设有 |

**重要**：设备**不提供 SN 或 device_id**。可用的稳定身份只有 `dev_mac`。
这直接印证规格书 §6.1 的降级策略：`device_uid` 用 MAC，且必须加 `mac:` 前缀避免与 SN 冲突
（现有 `resolveDeviceUid()` 已经这样做了 ✅）。

也**没有 `channel_num` 字段** —— 通道数需从 `/get_passageway` 的数组长度推导。

### 3.2 `GET /get_network`（风险 7 — 已解决）

```json
{
  "message": "ok",
  "msgBody": {
    "dsyDNSAdder": "223.5.5.5",
    "dsyHTTPPort": 80,
    "dsyIPAdder": "192.168.110.90",
    "dsyIPGateway": "192.168.110.1",
    "dsyIPMask": "255.255.255.0",
    "dsyIPMode": "manual",
    "dsyRTSPPort": 28003,
    "dsyTCPPort": 28001
  },
  "result": 0
}
```

| 域模型字段 | **真实字段** |
|---|---|
| `ip` | `dsyIPAdder` |
| `netmask` | `dsyIPMask` |
| `gateway` | `dsyIPGateway` |
| `dns` | `dsyDNSAdder` |
| `httpPort` | `dsyHTTPPort` |
| `rtspPort` | `dsyRTSPPort` |
| `tcpPort` | `dsyTCPPort` |
| `mac` | ❌ 此端点不返回，需从 `/get_devinfo` 的 `dev_mac` 取 |
| （新增）`ipMode` | `dsyIPMode` —— `"manual"` / 可能还有 `"dhcp"` |

**风险 7 结论**：真机上端口不是 `0`，而是真实值（HTTP 80 / RTSP 28003 / TCP 28001）。
规格书样例中的 `0` 很可能是**设备的"未修改"占位值**或在旧固件上的表现。
本项目的 `mapNetwork` **原样保留 0 的做法是正确的**，但现在应补上 `dsy*` 字段名。

新增字段 `dsyIPMode` 很重要：它表示手动/自动（DHCP）模式，
现有 `NetworkConfig` 有 `dhcp?: boolean` 但无法表达三态，建议改为 `ipMode: string`。

### 3.3 `GET /get_passageway`

```json
{
  "message": "ok",
  "msgBody": {
    "chinfoArray": [
      { "dchAlarmPara": 1, "dchEn": 1, "dchId": 0, "dchName": "name1", "dchSensorType": 0 },
      ...
    ]
  },
  "result": 0
}
```

| 域模型字段 | **真实字段** |
|---|---|
| `channelIndex` | `dchId` |
| `channelName` | `dchName` |
| `sensorType` | `dchSensorType` （0=Microphone, 1=Conduction ✅ 与规格书一致） |
| `enabled` | `dchEn` |
| `alarmProfileId` | `dchAlarmPara` → 对应 `dalId` |

**数组键是 `chinfoArray`**，不是规格书假设的 `passageway`/`channels`。
现有 `mapChannels()` 的候选键列表里**没有 `chinfoArray`**，会返回空数组。

实测真机 8 通道状态：ch0/ch1 启用，ch2–ch7 禁用（`dchEn: 0`）。

### 3.4 `GET /get_samplingrate`

```json
{ "message": "ok", "msgBody": { "samplingrate": 96000 }, "result": 0 }
```

✅ 字段名与规格书一致，单位是 **Hz**（不是 kHz）。
真机当前值 **96000 Hz**。

### 3.5 `GET /get_alarm_system`（规格书 §11.3 提到的 `dalFBETThre` 在此）

```json
{
  "message": "ok",
  "msgBody": {
    "alarmparaArray": [
      {
        "dalId": 1,
        "dalName": "defPara1",
        "dalDetecType": 0,
        "dalDeteSen": 10,
        "dalSensitivity": 10,
        "dalIntInhLeve": 10,
        "dalMainFreqEn": 1,
        "dalMFLower": 10,
        "dalMFUpper": 5000,
        "dalFBETEn": 1,
        "dalFBETThre": 0.5,
        "dalFBETLo": 15000,
        "dalFBETUp": 24000,
        "dalSPLODEn": 1,
        "dalSPLODThre": 120,
        "dalSPLSDDEn": 0,
        "dalSPLSDDThre": 20,
        "dalSPLSIDEn": 0,
        "dalSPLSIDThre": 20,
        "dalSPLStaDetEN": 1,
        "dalSPLStaDetThre": 150
      }
    ],
    "alarmparaSize": 1
  },
  "result": 0
}
```

字段语义（`En`=使能, `Thre`=阈值）：

| 字段 | 含义 | 对应规格书概念 |
|---|---|---|
| `dalId` | 告警参数 ID | `remote_alarm_id` |
| `dalName` | 名称 | 告警 Profile 名称 |
| `dalDetecType` | 检测模式 | Detection Mode (0=Characteristic, 1=AI) |
| `dalDeteSen` / `dalSensitivity` | 检测灵敏度 | Detection Sensitivity |
| `dalIntInhLeve` | 干扰抑制等级 | Interference Suppression |
| `dalMainFreqEn` / `dalMFLower` / `dalMFUpper` | 主频使能 / 下限 / 上限 | Main Frequency |
| `dalFBETEn` / `dalFBETThre` / `dalFBETLo` / `dalFBETUp` | 频带能量比 使能/阈值/下限/上限 | Band Energy Ratio |
| `dalSPLODEn` / `dalSPLODThre` | SPL **过载** 使能/阈值 | SPL overload |
| `dalSPLSDDEn` / `dalSPLSDDThre` | SPL **突降** 使能/阈值 | SPL drop |
| `dalSPLSIDEn` / `dalSPLSIDThre` | SPL **突升** 使能/阈值 | SPL surge |
| `dalSPLStaDetEN` / `dalSPLStaDetThre` | SPL **稳定性** 使能/阈值 | SPL stability |

**数组键是 `alarmparaArray`**，规格书未提及。
这些 `dal*` 名称**绝不允许出现在 UI 层**（规格书 §11.3 明确要求），必须经 Mapper 转成友好名称。

### 3.6 `GET /get_timeset`

```json
{
  "message": "ok",
  "msgBody": {
    "cur_time": 1789104356236,
    "dsyNTPAdder": "cn.pool.ntp.org",
    "dsyNTPEN": 0,
    "dsyNTPInterval": 64
  },
  "result": 0
}
```

- `cur_time` 是**毫秒**时间戳 ✅（现有 `toEpochMs` 的幅值判断能正确处理）
- `dsyNTPEN` 0=关闭
- `dsyNTPInterval` 单位未确认（可能是分钟）

### 3.7 `GET /get_rs485` 与 `/get_all_available_serial`

```json
{ "msgBody": { "dsySeriBaud": 9600, "dsySeriDateBit": 8, "dsySeriMode": 0,
               "dsySeriPortL": "", "dsySeriRserAddr": "" } }

{ "msgBody": { "all_available_dev": ["/dev/ttyS3","/dev/ttyS0","/dev/ttyFIQ0","/dev/ttyS4"],
               "all_available_size": 4 } }
```

注意 `dsySeriPortL` 与 `dsySeriRserAddr` 当前为空字符串，`dsySeriMode` 的取值含义未知。

### 3.8 `GET /get_modbus_para`

```json
{ "msgBody": { "modbus_baud": 9600, "modbus_crc": 0, "modbus_dbit": 8,
               "modbus_post": 502, "modbus_sbit": 1, "modbus_slave": 200,
               "modbus_type": 0 } }
```

⚠️ 注意字段名是 **`modbus_post`**（不是 `port`），容易写错。

### 3.9 `GET /get_date_push`（风险 4 — 部分解决）

```json
{
  "message": "ok",
  "msgBody": {
    "dsyAlarmInfoAdder": "http://8.153.195.75:3000/api/v1/dt_5e48c0a91f776d7b6a924f4ab893cd72/telemetry",
    "dsyAlarmInfoEN": 1,
    "dsyFeatDataAdder": "http://8.153.195.75:3000/api/v1/dt_5e48c0a91f776d7b6a924f4ab893cd72/telemetry",
    "dsyFeatDataEN": 1,
    "dsyGraphDataAdder": "http://8.153.195.75:3000/api/v1/dt_5e48c0a91f776d7b6a924f4ab893cd72/telemetry",
    "dsyGraphDataEN": 1,
    "dsyHeatAdder": "http://8.153.195.75:3000/api/v1/dt_5e48c0a91f776d7b6a924f4ab893cd72/telemetry",
    "dsyHeatContent": "HEAT",
    "dsyHeatEN": 1,
    "dsyHeatInterval": 60,
    "dsyManualRecordingAddr": "",
    "dsyManualRecordingEN": 0
  },
  "result": 0
}
```

**风险 4 的答案比规格书预期的好**：Push URL 路径中含有一个**设备唯一标识**
`dt_5e48c0a91f776d7b6a924f4ab893cd72`（32 位十六进制，很可能是设备云端 ID 或 MAC 的哈希）。

所以在公网 Server 模式下，**可以通过 URL 路径区分设备**，不必依赖 payload 里新增 `device_id` 字段。
但更稳妥的做法仍是让固件在 payload 中显式携带 `device_id`（规格书 §15.2 的建议依然成立）。

⚠️ **重要运维发现**：真机当前配置为向 `http://8.153.195.75:3000` **主动推送数据且已启用**
（`dsyFeatDataEN: 1`、`dsyAlarmInfoEN: 1`、`dsyGraphDataEN: 1`、`dsyHeatEN: 1`）。
这是**现场设备正在向一个公网地址上报数据**。部署本软件时需要注意：
- 若客户不希望数据外流，应关闭这些开关
- Manager 的 Push 配置页面应把当前 Push 目标**显著展示**出来

---

## 4. 实时流：全部是 WebSocket（风险 2 与 3 — 已解决）

### 4.1 这是规格书最大的错误

规格书附录 A 把这四个端点列为 `GET`：

```
/features_stream    GET    实时特征流
/audio_stream       GET    实时 PCM 音频流
/freq_domain        GET    实时频域数据
/time_freq_domain   GET    实时时频域数据
```

**实测：这四个端点在 HTTP 上一律返回 404。它们是 WebSocket 端点。**

```
ws://<device-ip>/features_stream
ws://<device-ip>/audio_stream
ws://<device-ip>/freq_domain
ws://<device-ip>/time_freq_domain
```

如果按规格书用 HTTP 实现，这四个功能**一个都做不出来**。

### 4.2 订阅协议（客户端主动 ping）

设备**不会主动推流**，客户端必须周期性发送订阅消息：

```json
{ "type": "ping", "channel": "0" }
```

| 端点 | ping 间隔 | ping 内容 |
|---|---|---|
| `/features_stream` | 1000 ms | `{"type": "ping", }` ← 注意逗号后为空，无 channel |
| `/audio_stream` | **100 ms** | `{"type": "ping", "channel": "0"}` |
| `/freq_domain` | 1000 ms | `{"type": "ping", "channel": "0"}` |
| `/time_freq_domain` | 1000 ms | `{"type": "ping", "channel": "0"}` |

⚠️ `channel` 的值是**字符串** `"0"`，不是数字。

### 4.3 各流的帧格式

**全部为 WebSocket 二进制帧**（`onmessage` 收到 Blob，需按 ArrayBuffer 处理）。

#### `/features_stream` — JSON 文本装在二进制帧里

帧大小 139–143 字节，内容是可解析的 UTF-8 JSON：

```json
{"cur_ch":0,"freq_band_energy_ratio":0.03,"hr_f":613.3,"main_freq":0.0,
 "sc_f":6.5,"smoothness":1.51,"sound_pressure_level":57.1,"sv_f":0.0}
```

| 域模型字段 | **真实字段** |
|---|---|
| `channelId` | `cur_ch` ← 不是 `ch_id` |
| `spl` | `sound_pressure_level` ✅ |
| `mainFrequency` | `main_freq` ✅ |
| `smoothness` | `smoothness` ✅ |
| `bandEnergyRatio` | `freq_band_energy_ratio` ✅ |
| `oddEvenHarmonicRatio` | `hr_f` ✅ |
| `spectralComplexity` | `sc_f` ✅ |
| `fingerprintVariation` | `sv_f` ✅ |
| `timestamp` | ⚠️ **payload 中没有**，必须客户端打时间戳 |

**帧内没有时间戳**——现有 `mapFeatureFrame` 的 `nowMs` 回退逻辑是必需的 ✅。

#### `/audio_stream` — Float32 原始 PCM（**单通道，已确认**）

- **帧大小恒为 38400 字节**
- 内容：**Float32 小端**，无任何文件头或元数据
- 前端代码直接 `new Float32Array(msg.data)`，证实无头部

**几何：单通道，每帧 100 ms。这是实测确认的结论，不是推断。**

推导：

```
38400 字节 ÷ 4 (Float32) = 9600 个样本
设备采样率 96000 Hz
9600 ÷ 96000            = 0.100 s = 100 ms   ← 精确
```

即 **每帧 = 100 ms × 采样率 个 Float32 样本，代表一个通道**。
一般式：`帧字节数 = sampleRate × 0.1 × 4`（96kHz→38400，192kHz→76800，48kHz→19200）。

**→ 与规格书 §9.3「每 100 ms 推送 100 ms 数据」完全一致**，
但规格书 §4.3 设想的「8 通道完整 Ring Buffer」**无法用单条连接实现**。

##### 判定为单通道的证据（三项独立验证）

1. **排除 8 通道交织**：若为交织，步长为 8 的相邻样本应高度相关（差值趋近 0）。
   实测 8-步长平均差为 `0.00058`（ch0）与 `0.00177`（ch1），**远不为零**，排除交织。

2. **不同通道订阅得到不同信号**：
   | 订阅 | RMS | 值域 |
   |---|---|---|
   | channel 0 | 0.001733 | [-0.0052, 0.0058] |
   | channel 1 | 0.002708 | [-0.0096, 0.0154] |

   两者 RMS 相差 56%，采样序列完全不同 → 是两路独立的物理信号。

3. **帧大小恒定**：无论订阅哪个通道，均为 38400 字节。若帧内打包 8 通道，
   大小会随启用通道数变化（实测设备仅 CH1/CH2 启用）。

##### 对实现的影响（Phase 5 必须遵循）

- **监控 N 个通道需要开 N 条 WebSocket 连接**，每条订阅一个 `channel`
- 音频帧率达到约 **10 帧/秒/通道**（与 100 ms/帧 一致）
- Ring Buffer 按**单通道**维护，与规格书 §4.3「V1 只对当前监控通道维护完整音频
  Ring Buffer」的意图一致；若要多通道并行，就是多连接 × 多 Buffer，内存按通道数线性增长
- ⚠️ **192 kHz 下 8 通道并行录音的内存代价**：
  `192000 × 0.1 × 4 B × 8 ch × 60 s = 约 3.7 GB`。
  这解释了为什么规格书 §4.3 要把 Ring Buffer 限制在当前通道，
  也说明「8 通道并行 Ring Buffer」在 V1 不应默认开启。

#### `/freq_domain` — Float32 频谱数组（已确认）

- 帧大小 **4096 字节** = 1024 × Float32
- 即 **1024 个频点**的幅度谱，无头部，直接 `new Float32Array(msg.data)`
- 实测帧率约 **1.4 帧/秒**

维度确认：`4096 ÷ 4 = 1024` 个 Float32 值，与前端代码一致。

#### `/time_freq_domain` — 🔥 JPEG 图像（已确认）

- 帧大小约 **38652–40337 字节**（随图像内容变化，符合 JPEG 压缩特征）
- 起始字节 `FF D8 FF E0 00 10 4A 46 49 46` = **JPEG/JFIF 文件头**
- 前端直接 `readAsDataURL(blob)` 后作为 `<img src>` 显示
- 实测帧率约 **1.5 帧/秒**

**时频图不是数值矩阵，而是设备端渲染好的 JPEG 图片。**

这大幅简化了 Phase 7：不需要自己做 STFT，也**不能**用 ECharts 画热力图，
而应该用 `<img>` 标签直接显示。前端保留最近 5 帧做动画。

规格书 §9.1 要求「图表：Spectrogram」，实现方式应改为**图片序列**而非图表。

---

## 4A. 补充实测：采样率与时序（Phase 4-8 实施期间发现）

### 4A.1 采样率 96 kHz —— 三个独立来源确认

| 来源 | 值 |
|---|---|
| `GET /get_samplingrate` | `96000` |
| `/get_alarm_audio` 的 `dauSmp` | `96000` |
| **设备自己写的 WAV 头** `sampleRate` | `96000`（且 `data=3840000B` = 10s × 96000 × 4B，自洽） |

第三个来源最有说服力：设备自己生成的文件声明 96 kHz，
且 `data` 块大小与「10 秒 × 96000 × 4 字节」精确吻合。

### 4A.2 帧几何 vs 交付速率 —— 两者不同，不要混淆

实测（60 帧采样，5.47 秒窗口）：

```
每帧样本数    = 9600（恒定，60 帧全部相同）
字节速率      = 411.6 KB/s
实测帧率      = 10.79 帧/秒
帧间隔        = 最小 39ms / 中位 50ms / 最大 563ms   ← 不规则，有突发
```

按 96 kHz 计算，9600 样本 = **100 ms 音频**。
但 10.79 帧/秒 × 100 ms = 1.079，即**交付速率约为实时的 1.08 倍**。

**结论与影响：**

- ✅ **帧几何是可信的**：38400 字节 = 9600 样本 = 100 ms @96 kHz，恒定不变。
  这是解码器可以依赖的事实。
- ⚠️ **交付节奏不是实时的**，且有突发（帧间隔 39–563 ms）。
  因此：
  - Ring Buffer 与录音必须按**样本数**计时，不能用墙钟
  - 若用墙钟计时，界面计时器与保存文件的时长会不一致（约 8% 偏差）
  - 本项目的 `AudioRecorder.elapsedMs` 与 `StreamManager.recordingElapsedMs`
    均为**音频锚定**（样本数 ÷ 采样率），正是为此

**未确认**：偏差来源是设备时钟、网络抖动还是帧重复。
不影响样本内容，但若未来要做精确时间对齐，需要与固件方确认。

### 4A.3 一个被误诊为"设备限制"的问题 —— 实为我方 bug

**经过**：实施 Phase 5 时观察到——只要录音进行中，
`/freq_domain` 与 `/time_freq_domain` 就收到 **0 帧**，且事件循环延迟正常
（最大 28 ms，无阻塞）。据此曾判定为「设备在高速音频被消费时停止推送慢速流」，
并写入了代码注释与文档。

**真相**：`StreamManager.startRecording()` 调用了
`start(['audio','features'], channelId)`，而 `start()` 的语义是
**「这是期望的完整流集合」**，于是它把频谱与时频图两个流**关掉了**，
且没有任何逻辑再把它们拉起来。

**为什么这个错误很隐蔽**：症状（录音时慢速流无数据）与"设备限制"完全一致，
且具备可复现性。只有做**对照实验**（四路同开 + 录音，检查慢速流帧率）才暴露出来——
实测录音期间频谱/时频各收到 3 帧，完全正常。

**教训**：一个"看起来像外部限制"的症状，在归因于外部之前必须先做对照实验。
本项目已把 `start()` 的语义在文档注释中明确化，并要求任何收窄集合的调用都不得
用于"确保某一路在运行"这一目的。

**保留的防护**：慢速流的静默看门狗仍然保留——无论原因是什么，
一个打开却收不到数据的 socket 对用户而言都等同于故障，界面应能如实显示"已暂停"。

## 5. 告警录音与告警位映射（风险 6 — 已解决）

### 5.1 查询告警录音：`PUT /get_alarm_audio`

**请求体必须包 `msgBody` 并带分页参数**，三种错误写法会产生三种不同的失败：

| 请求体 | 结果 | 误导性 |
|---|---|---|
| `{}` | `{"message":"Failed to obtain audio record.","result":1}` | 🔴 看起来像"没有录音"，实为请求格式错误 |
| `{page_start:0, page_size:12}`（无 `msgBody`） | nginx 错误页 | 🟡 尚可察觉 |
| `{msgBody:{page_start:0, page_size:12}}` | ✅ 正常返回 | — |

```json
{ "message": "ok",
  "msgBody": {
    "allSize": 10000,
    "audioArray": [ { ... } ]
  },
  "result": 0 }
```

数组键是 **`audioArray`**，总数是 **`allSize`** —— 规格书均未提及。

### 5.2 单条记录字段（实测）

```json
{ "ContinuousAlert": 0,
  "dauAbnoType": 1,
  "dauAlarmTime": 1789105315658,
  "dauAudionLeng": 10,
  "dauChId": 0, "dauChName": "name1", "dauChSenType": 0,
  "dauFBET": 0,
  "dauFileName": "1_alarm_20260911134155.wav",
  "dauFilePath": "/media/sdcard0/audio_library/auwh/audio/1_alarm_20260911134155.wav",
  "dauId": 39178,
  "dauMainFreq": 93, "dauSPL": 62.48, "dauStati": 4.88, "dauStatus": 1,
  "dauSmp": 96000 }
```

| 域概念 | 真实字段 | 单位/说明 |
|---|---|---|
| **告警位掩码** | `dauAbnoType` | ⚠️ **就是附录 B 的位掩码** |
| 录音时间 | `dauAlarmTime` | **毫秒**（已按真实时间戳核对） |
| 时长 | `dauAudionLeng` | **秒**（值 10 对应 10.00s 文件） |
| 通道 | `dauChId` / `dauChName` / `dauChSenType` | 0-7 / 名称 / 传感器类型 |
| **下载键** | `dauFileName` | 含扩展名，**不是** `dauId` |
| 设备路径 | `dauFilePath` | `/media/sdcard0/...`，仅供展示，**不可 web 访问** |
| 采样率 | `dauSmp` | Hz |
| 特征值 | `dauSPL` / `dauMainFreq` / `dauFBET` / `dauStati` | SPL / 主频 / 频带能量比 / 稳定性 |
| 记录 ID | `dauId` | 单调递增，仅作元数据 |

### 5.3 下载录音：`GET /download_audio/{dauFileName}`

**规格书的 `/audio_file/{filename}` 不存在。**

失败方式极具欺骗性：该路径返回 **HTTP 200 + SPA 的 index.html**，
调用方看到的是"成功"，正文却是 HTML。

实测正确调用：

```js
// 设备前端源码里的真实写法
fetch("/download_audio/" + e.dauFileName, { method:"GET",
  headers:{"Content-Type":"application/json"} })
const blob = await r.blob()
window.URL.createObjectURL(blob)
```

实测下载结果：

```
HTTP 200 · application/octet-stream · 3,840,080 字节
RIFF/WAVE 有效
audioFormat=3 (IEEE Float)  channels=1  sampleRate=96000  bits=32
data 块 3,840,000 字节 = 10.00 秒
chunk 顺序: RIFF → fmt → fact → PEAK → data
```

**三个必须注意的点：**

1. **`bits=32` 且 `audioFormat=3`** —— 是 **32 位 IEEE 浮点**，不是 16 位 PCM。
   按 16 位解析会得到噪声而不是报错。与实时流 `/audio_stream` 的 Float32 编码一致。
2. **`channels=1`** —— 单声道，与实时流的单通道结论**互相印证**。
3. **`fmt` 与 `data` 之间有 `fact`、`PEAK` 块** ——
   任何假设"44 字节固定头"的解析器都会把元数据当音频读。
   必须按 chunk 遍历。

⚠️ **安全发现**：该端点**不需要认证**，无 token 也能下载。
不应把凭据当作保护这些数据的手段。

### 5.4 附录 B 告警位映射（已实测确认）

真实告警数据交叉验证：

| `dauAbnoType` | 二进制 | 触发通道 | 伴随值 | 结论 |
|---|---|---|---|---|
| `1` | `0b00000001` | CH1 | SPL=62.7, 主频=93 | **Bit0 = SPL** ✅ |
| `2` | `0b00000010` | CH2 | SPL=41.89, 主频=0 | **Bit1 = Main Frequency** ✅ |

统计分布：掩码 `1` 出现 10 次，掩码 `2` 出现 2 次。

**语义自洽性佐证**：CH2 那条 `主频=0` 却报"主频异常"看似矛盾，
但该条 `SPL=41.89` 远低于 SPL 触发阈值，
说明设备正是**按主频判据**而非 SPL 触发的——掩码语义与实测数据互相印证。

**Bit2–Bit13 仍未经现场验证**（需对应类型的真实告警），
但 Bit0/Bit1 与规格书附录 B 完全一致，其余位有较强理由认为也正确。
`decodeAlarmMask()` 的实现已按附录 B 完成，待更多告警类型出现时自然验证。

### 5.5 仍未确认的项（均为非阻塞）

| 项 | 状态 | 影响 |
|---|---|---|
| `/get_audio` 是否可用 | ⚠️ 本固件返回 nginx 404 | 低——`/get_alarm_audio` 已覆盖需求 |
| `dsyHeatInterval` 单位 | ⚠️ 未知（值 60） | 低——仅影响 Push 间隔显示 |
| `dsySeriMode` / `modbus_type` 取值含义 | ⚠️ 未知 | 低——枚举待补 |
| `dauStatus` / `ContinuousAlert` 语义 | ⚠️ 未知 | 低——不影响核心功能 |
| 告警 Bit2–Bit13 现场验证 | ⚠️ 需对应类型告警 | 低——已按附录 B 实现 |
| 公网告警音频回读 | ⚠️ 属固件改造 | 中——仅影响未来 Server 模式 |
| 写操作协议 | ✅ **已确证**（见 §5A；其中 7 个端点的信封是**真机实测**的，见 §5A.0） | — |
| 写操作在真机的实际效果 | ✅ **7 个写端点已真机执行**（值保持 + 读回 + 还原，见 §5A.0）；`set_network` / `system_control` / 三个删除端点**未执行**，见文末附录与「未验证」清单 | 剩余风险集中在破坏性与会断连的那几个 |
| `control_type` 语义 | ✅ **已确证**（1=出厂 2=重启 3=升级） | — |
| 特征/频谱流的通道来源 | ✅ **已确证**（跟随设备当前通道，需 `/channel_select`） | — |
| 固件上传格式 | ✅ **已确证**（`file` 字段的 multipart） | — |

## 4B. 通道选择：`/features_stream` 只推「设备当前通道」（重要）

### 4B.1 问题

四个流的订阅机制**并不一致**，这一点规格书没有提及：

| 端点 | 订阅 ping | 数据来源 |
|---|---|---|
| `/audio_stream` | `{"type":"ping","channel":"N"}` | **按订阅参数**，各连接独立 |
| `/time_freq_domain` | `{"type":"ping","channel":"N"}` | **按订阅参数** |
| `/freq_domain` | `{"type":"ping","channel":"N"}` | ⚠️ 实测跟随**设备当前通道** |
| `/features_stream` | `{"type":"ping", }` | ⚠️ **无 channel 参数**，只推设备当前通道 |

后果：**界面上点击 CH2，`/features_stream` 仍然上报 CH1 的数据**，
若照原样显示，就会在 "CH2" 标题下展示 CH1 的数值——这是会误导运维的错误。

### 4B.2 解法：先切换设备当前通道

设备提供了一对端点控制其当前通道（规格书未记载）：

```
GET  /get_cur_ch          → { "message":"ok", "msgBody":{ "cur_ch":0 }, "result":0 }
PUT  /channel_select      body: { "msgBody": { "cur_ch": 1 } }   → { "result": 0 }
```

⚠️ **方法容易搞错**：`/get_cur_ch` 必须是 **GET**；
用 PUT 会得到 nginx 的 `501 Not Implemented`。而 `/channel_select` 是 **PUT**。

实测验证：

```
设备当前通道: CH1
selectChannel(2) -> features_stream 上报 cur_ch=[2]  ✓ 一致
selectChannel(3) -> features_stream 无数据           ✗ CH3 已禁用，设备拒绝
```

### 4B.3 实现约定

`StreamManager` 在通道变更时会：

1. 通过 `/get_passageway` 校验目标通道**存在且已启用**，否则抛出明确错误
   （而不是让界面静默显示错误通道的数据）
2. 调用 `PUT /channel_select` 切换设备当前通道
3. 重建 socket

⚠️ **副作用**：这会改变**设备本身**的当前通道，因此设备原生 Web 界面
下次打开时会停在同一通道。这是可接受的（用户意图就是看该通道），但需知晓。

**若切换失败**（例如通道被禁用），不会阻断监测：流仍会打开，
管理器记录一条告警，界面会看到数据但通道可能与选择不符。

## 5A. 写操作协议（Phase 9-10 实施期间实测）

所有写操作都是 **PUT + `{msgBody:{...}}`**，与读操作同一信封。
以下载荷均取自设备自身前端代码，并在真机上以「读回对比」方式验证。

### 5A.0 信封是**逐条实测**的，不是推断（2026 年取证 + 值保持写探针）

先有结论：**七个写端点的 `msgBody` 信封都是在真机上证明的**（把设备当前的值原样送回去，
所以一次成功的写入不改变任何值；成败由**读回**判定，不看 `result`）：

| 端点 | 我们当时的体（无信封） | 设备原文 | 加 `msgBody` 后 | 判定 |
|---|---|---|---|---|
| `set_samplingrate` | `{"samplingrate":96000}` | `Failed to set sampling rate.` `result:1` | `ok` `result:0`，读回 96000 | **缺信封** |
| `set_passageway` | `{"chinfoArray":[8 条]}` | `Failed, Please check the integrity of the data format.` `result:1` | 单对象 + 信封 → `ok`（见 §5A.2） | **缺信封 + 容器类型错** |
| `set_timeset` | `{"cur_time":…,…}` | `Failed to set time parameters.` `result:1` | `ok` `result:0`，NTP 三字段读回不变 | **缺信封** |
| `set_rs485` | `{"dsySeriBaud":…,…}` | `Failed to set RS485 parameters.` `result:1` | `ok` `result:0`，读回不变 | **缺信封** |
| `set_modbus_para` | `{"modbus_post":…,…}` | `Failed to set Modbus parameters.` `result:1` | `ok` `result:0`，读回不变 | **缺信封** |
| `set_date_push` | `{"dsyFeatDataAdder":…,…12 字段}` | `Failed to set data push parameters.` `result:1` | `ok` `result:0`，读回逐字节不变 | **缺信封** |
| `set_devinfo` | `{"devname":"AE08"}` | `Failed to modify device name.` `result:1` | `ok` `result:0`（见 §5A.10） | **缺信封** |
| `add_alarm_system` | `{"alarmparaArray":[{…dalId:1…}]}` | `Add/Update Alarm parameters Failed, Please check the integrity of the data format.` `result:1` | `This parameter dalName is Duplicate or empty.` `result:2` | **未验证**（见 §5A.3） |

**未做写探针、因此没有任何结论的端点**：`set_network`、`system_control`、
`del_alarm_system`、`dele_audio`、`dele_alarm_audio`。它们是同一类代码模式，**可能**同样
需要信封，但那是**推断**；在真机上证明它们要么会切断连接、要么会毁掉真实数据，所以本轮
刻意不做（见文末「未验证」清单）。

### 5A.1 `PUT /set_samplingrate`

```json
{ "msgBody": { "samplingrate": 96000 } }
```

实测（值保持：把当前 96000 送回去）：裸对象被答成
`{"message":"Failed to set sampling rate.","result":1}`；加上 `msgBody` 后
`{"message":"ok","result":0}`，读回仍是 96000。

### 5A.2 `PUT /set_passageway`

```json
{ "msgBody": { "chinfoArray": {
  "dchId":0, "dchName":"name1", "dchSensorType":0, "dchEn":1, "dchAlarmPara":2
} } }
```

**两个形状都要对：根上必须有 `msgBody`，而且 `chinfoArray` 是单个通道对象，不是数组。**

#### 这个形状是怎么定下来的（后来者可以照着复核）

1. **设备自己的前端源码**：设备把 source map 一起发布了 ——
   `GET /static/js/main.1defb5ea.js.map`（14 078 783 B，含 `sourcesContent` 里
   **1757 个原始源文件**）。还原出来的 `pages/Preference/PreferenceF.js:183-205` 里，
   设备自己改一行通道名时发的是：

   ```js
   record.dchName = value;
   setPassagewayApi({ msgBody: { chinfoArray: record } })   // ← 单个 record 对象
   ```

   `record` 是表格的一行；`api.js` 里 `setPassagewayApi = data => apiPut('/set_passageway', data)`。
2. **真机值保持写探针**（把设备当前的值送回去，逐形状试）：

   ```
   {chinfoArray:[8×5字段]}                        → integrity 错误 result:1
   {msgBody:{chinfoArray:[8×5字段]}}               → integrity 错误 result:1
   {msgBody:{chinfoArray:[单个对象]}}（一元素数组） → integrity 错误 result:1
   {msgBody:{chinfoArray: 单个对象}}               → {"message":"ok","result":0}   ✅
   ```

   我们还试过 `chinfoSize`、换 key（`chArray`/`passagewayArray`）、根即数组等共 12 种候选，
   只有上面这一种成功。

#### 这一点**曾经写错过**（重要的历史）

本节早先写的是「`chinfoArray` 必须回传完整的 8 个通道」，并断言「只传一个会静默重置其余
通道」。那句话是**当年从压缩后的 bundle 里静态读出来的**，而这个端点当时**从未在真机上
执行过**（见文末附录）。源映射 + 真机探针一起证明它是错的：八条数组正是**失败**的那一种
形状。旧句子已删除，不要照着它改回来。

#### 真机实测（值保持写 + 一次真改名并还原）

```
值保持（ch0 送自己的 name1，单对象 + 信封） → result:0
  读回：chinfoSize=8，8 行与基线逐字节一致
真改名 ch0: name1 → chtmp_probe → result:0
  读回 ch0 = "chtmp_probe"，ch1..ch7（name2…name8）与 chinfoSize 均不变
还原 ch0 → name1 → result:0
  读回与基线逐字节一致
```

所以「单行 `chinfoArray` 不会清空其余通道」这一点是**实测**的（ch1 在 ch0 改名时保持
`name2`/`dchSensorType:1`/`dchEn:1`）。固件内部到底是「按 `dchId` 合并」还是「整体替换后
回写其余行」，从外部无法区分 —— 这部分仍然是**未验证**（见文末），实现因此保留
「先读回全部通道、只在被改行上合并用户编辑」的写法。

内容约束（单条形状下实测，均成功并已还原）：`"通道一"`、`"aaaaaaaaaaaaaaaa"`(16)、
`"ok_name"`。→ **「integrity of the data format」只由形状触发，不由值触发。**
（设备 UI 的输入框 `maxLength:15`，`PreferenceF.js:264` —— 客户端约束，非服务端强制。）

### 5A.3 `PUT /add_alarm_system` 与 `PUT /del_alarm_system`

新增/修改（`dalId` 缺省即新建，存在即修改）：

```json
{ "msgBody": {
    "dalName":"...", "dalDetecType":0, "dalDeteSen":10, "dalSensitivity":10, "dalIntInhLeve":10,
    "dalSPLODEn":1, "dalSPLODThre":120,
    "dalSPLSIDEn":0, "dalSPLSIDThre":20,
    "dalSPLSDDEn":0, "dalSPLSDDThre":20,
    "dalSPLStaDetEN":1, "dalSPLStaDetThre":150,
    "dalMainFreqEn":1, "dalMFLower":10, "dalMFUpper":5000,
    "dalFBETEn":1, "dalFBETLo":15000, "dalFBETUp":24000, "dalFBETThre":0.5 } }
```

删除：

```json
{ "msgBody": { "dalId": 1 } }
```

⚠️ **这两个端点的信封与删除形状都仍是未验证**（2026 年这一轮只对 `add_alarm_system`
做了**一次**值保持写探针，用的是设备自己那一行）：

```
{alarmparaArray:[{…dalId:1…}]}            → "Add/Update Alarm parameters Failed,
                                             Please check the integrity of the data format."  result:1
{msgBody:{alarmparaArray:[{…dalId:1…}]}}  → "This parameter dalName is Duplicate or empty."   result:2
```

两次都失败，而且**都不是同一句错误**：加了信封之后形状错误消失了，换成一句语义错误
（名字重复）。这只说明「信封被接受」，**没有**证明带信封的形状可用，也**没有**证明它就是
正确形状 —— 所以本仓库**按原样保留**（不带信封），并把结论记在这里。删除端点一次都没试：
它会真的抹掉一条保护定值，而设备上的两条配置都在被通道引用。

（另注：把一条**已存在**的配置整行送回时设备报 `dalName is Duplicate`，这意味着
「带 `dalId` 即更新」这条规格书推断本身也值得怀疑。真机上的更新形状**未验证**。）

### 5A.4 `PUT /set_network`

```json
{ "msgBody": {
    "dsyIPMode":"manual", "dsyIPAdder":"192.168.1.50", "dsyIPMask":"255.255.255.0",
    "dsyIPGateway":"192.168.1.1", "dsyDNSAdder":"192.168.1.1",
    "dsyHTTPPort":80, "dsyRTSPPort":28003, "dsyTCPPort":28001 } }
```

⚠️ **最高风险写操作**：改 IP 会立即断开当前连接。
设备前端保存成功后强制 `sessionStorage.clear()` 并重载页面。
本软件必须：修改前明确警告 → 修改后按新 IP 自动重连 → 重连失败时给出可操作的提示。

⚠️ **信封未验证**：本节这个 `msgBody` 形状取自设备前端代码，**没有**在真机上执行过
（改 IP 会切断我们自己的连接，回滚失败时设备只能现场恢复）。2026 年那一轮证明了其它
七个写端点全部必须 `msgBody`，所以这里**很可能**同样需要 —— 但这是**推断**。
在证明之前不改代码：一次猜测的改动不会让这个端点变得可用，只会把「形状错」换成另一种
失败。**在真机上执行 `set_network` 之前，请先按 §5A.0 的方法做一次值保持写探针。**

### 5A.5 `PUT /set_timeset`

```json
{ "msgBody": { "cur_time": 1789104356236, "dsyNTPAdder":"cn.pool.ntp.org",
               "dsyNTPEN":0, "dsyNTPInterval":64 } }
```

`cur_time` 为**毫秒**时间戳。这是对时操作，可用于把设备时间校准到本机时间。

实测（值保持：把设备自己读到的时间送回去）：裸对象被答成
`{"message":"Failed to set time parameters.","result":1}`；加 `msgBody` 后
`{"message":"ok","result":0}`，三个 NTP 字段读回逐字节不变。
（`cur_time` 本身必然在动：回读比送进去的值早 0.5–0.6 秒。写入前后设备时钟与本机时钟的
差都在亚秒级 —— 这台设备 NTP 关闭，这一点在动手前应当知道。）

### 5A.6 `PUT /set_rs485`

```json
{ "msgBody": { "dsySeriBaud":9600, "dsySeriDateBit":8, "dsySeriMode":0,
               "dsySeriPortL":"/dev/ttyS3", "dsySeriPortR":"", "dsySeriRserAddr":"1" } }
```

注意 `dsySeriPortR`（右端口）在读接口 `/get_rs485` 中**未返回**，但写接口需要。
读-改-写时必须保留读不到但写需要的字段，否则会清空设备配置。

实测（值保持）：裸对象 → `{"message":"Failed to set RS485 parameters.","result":1}`；
加 `msgBody` → `{"message":"ok","result":0}`，读回逐字节不变。

### 5A.7 `PUT /set_modbus_para`

```json
{ "msgBody": { "modbus_post":502, "modbus_type":0, "modbus_baud":9600,
               "modbus_dbit":8, "modbus_sbit":1, "modbus_slave":200 } }
```

`modbus_crc` 读接口返回但写接口**不需要**传。

实测（值保持）：裸对象 → `{"message":"Failed to set Modbus parameters.","result":1}`；
加 `msgBody` → `{"message":"ok","result":0}`，读回逐字节不变。

### 5A.8 `PUT /system_control` —— 破坏性操作，语义已确证

```json
{ "msgBody": { "control_type": 1 | 2 | 3 } }
```

| 值 | 操作 | 确证依据（设备前端代码） |
|---|---|---|
| `1` | **恢复出厂设置** | 成功后提示 `DeviceRecoveryInitializationSucceeded` |
| `2` | **重启设备** | 成功后提示 `DeviceRestartSuccessful` |
| `3` | **系统升级** | 处理器名为 `Set_sys_upgrade` |

与规格书 §11.5 一致。**这三项必须各自二次确认**，恢复出厂建议要求输入 `RESET`。

⚠️ 设备前端在执行 1 或 2 之后会 `sessionStorage.clear()` + 重载页面，
说明这两个操作会使当前会话失效。

⚠️ **信封未验证**：本节这个 `{msgBody:{control_type}}` 形状同样只在设备前端代码里读到过，
**没有**在真机上执行（重启会中断监测，恢复出厂会抹掉全部历史数据）。与 `set_network`
同一条纪律：在证明之前不改代码，也**不要**在没有验证的情况下依赖它。

### 5A.9 `POST /upload` —— 固件上传（规格书未给出格式）

实测自设备前端：使用**裸 `XMLHttpRequest`**，`POST /upload`，
`FormData` 中字段名为 **`file`**，并带 `upload.onprogress` 用于进度显示。

⚠️ **该上传请求未携带任何认证头**（设备前端代码中没有任何 `setRequestHeader`）。
与 `/download_audio/{file}` 一样，这属于固件侧的认证缺口，应反馈给固件方。
本软件实现时仍会携带认证头，并在文档中记录该端点不校验认证这一事实。

### 5A.10 `PUT /set_devinfo` —— 规格书遗漏的端点

```json
{ "msgBody": { "devname": "新设备名" } }
```

规格书只列出了 `get_devinfo`，真机支持修改设备名。

**信封是实测必需的**（同一轮的值保持写探针，设备名始终 `AE08`）：

```
{"devname":"AE08"}          (= 我们当时的客户端) → {"message":"Failed to modify device name.","result":1}
{"msgBody":{"devname":"AE08"}}                   → {"message":"OK","result":0}   读回 devname 仍为 AE08
```

设备自己的前端也这么写：`pages/Preference/SystemSettingsF.js:753-813` 里
`setDevinfoApi({ "msgBody": { devname: devinfoDateInfo.devname } })`；
`fpga_version` / `dev_version` / `dev_mac` / `web_version` **不是必填**。
`devname` 只认 `msgBody` 包裹 —— 这一条在 2026 年由真机探针再次确认。

### 5A.11 读-改-写是唯一安全的模式

除 `set_devinfo` 与 `system_control` 外，**所有写操作都要求提交完整对象**，
而不是增量补丁。因此实现统一采用：

```
读接口获取当前值 → 在内存中合并用户的修改 → 提交完整对象
```

直接构造"看起来合理"的完整对象是危险的：`dsySeriPortR` 这类
**读不到但写需要的字段**会因此被清空。

唯一实测的例外是 `set_passageway`：它的 `chinfoArray` 是**单行**（§5A.2），设备按
`dchId` 合并。即便如此，那一行的五个字段**全部来自读回**（`getChannels()`），用户只改
其中一两个 —— 「不动的字段用设备自己的值」这条规矩没有变，只是提交的行数从 8 变成 1。

### 5A.12 `PUT /set_date_push` —— 信封实测必需

```json
{ "msgBody": { "dsyFeatDataEN":1, "dsyFeatDataAdder":"http://…",
               "dsyAlarmInfoEN":1, "dsyAlarmInfoAdder":"http://…",
               "dsyGraphDataEN":1, "dsyGraphDataAdder":"http://…",
               "dsyHeatEN":1, "dsyHeatAdder":"http://…", "dsyHeatContent":"HEAT",
               "dsyHeatInterval":60,
               "dsyManualRecordingEN":0, "dsyManualRecordingAddr":"" } }
```

实测（值保持：把 `/get_date_push` 读到的十二个字段原样送回）：裸对象 →
`{"message":"Failed to set data push parameters.","result":1}`；`{msgBody:<同一对象>}` →
`{"message":"ok","result":0}`，读回逐字节不变。

⚠️ 本仓库目前**没有**任何地方调用这个端点（推送目标只读不写），所以这条修复只是把形状
钉正确，没有界面行为跟着变。十二个字段是否全部必填**未验证**（实测到的只是「信封必需」）。

## 6. 对现有代码的修改清单

按优先级排序。**第 1、2 项不修则软件完全无法连接真机。**

| # | 文件 | 修改 |
|---|---|---|
| 1 | `protocol/dto.ts` | ✅ 已改：`msgBody` 信封；`dev_*` / `dsy*` / `dch*` / `dal*` / `modbus_*` 字段名 |
| 2 | `protocol/mappers.ts` | ✅ 已改：`msgBody` 解包；`devname`/`dev_mac`/`dev_version`；`dsy*`；`chinfoArray` + `dch*`；`cur_ch` |
| 3 | `auth-resolver.ts` | ✅ 已改：登录包裹 `{msgBody:{...}}`；递归收集登录字段名 |
| 4 | `auth-strategy.ts` | ✅ 已改：`derivePassword()` 实现 `md5(pass+'lfxs')`；候选顺序按实测调整 |
| 5 | `device-api-client.ts` | ✅ 已改：`isSuccess()` 识别 `result === 0`；优先取 `msgBody` |
| 6 | **新增** `services/stream/websocket-stream.ts` | ✅ 已建：WebSocket 客户端、ping 订阅、重连退避、`sampleStream()` 探测原语 |
| 7 | **新增** `services/audio/wave-parser.ts` | ✅ 已建：RIFF chunk 遍历、32 位浮点解码、格式校验 |
| 8 | `alarm-service.ts` | ✅ 已改：录音同步走 `msgBody` 分页；新增 `downloadRecording()` |
| 9 | `device-api-client.ts` | ✅ 已改：`queryAlarmAudio()` 自带正确信封；`downloadRecording()` 用实测路径 |
| 10 | `storage-service.ts` | ✅ 已改：新增原子写入（临时文件 + rename） |
| 11 | `protocol-lab.ts` | ⬜ 待改：四个流式端点改为 WebSocket 探测 |
| 12 | `domain/models.ts` | ⬜ 待改：`NetworkConfig.ipMode`（mapper 层已实现，域模型待同步） |
| 13 | `protocol/dto.ts` + `device-api-client.ts` + `config-service.ts` | ✅ 已改（2026 年轮次）：`set_passageway` 的 `chinfoArray` 改为**单个通道对象**；`set_devinfo` 补 `msgBody`；并给**实测证明必需**的 `set_samplingrate` / `set_timeset` / `set_rs485` / `set_modbus_para` / `set_date_push` 补上 `msgBody` 信封（见 §5A.0） |
| 14 | `renderer/views/DevicesView.vue` | ✅ 已改（2026 年轮次）：声纹设备改名时**设备侧失败就回滚本机那一半**，并把「设备的原文 + 本机已恢复原名」一起说给操作员（此前只显示设备错误、本机留在新名字上，界面与设备从此不一致） |

**已验证**：上述 1–6 项修改后，用项目自身代码连接真机，
`token-header` 策略**首次尝试即命中**（81 ms），设备信息 / 网络 / 8 通道 / 采样率
全部正确映射为域模型。

### 需要向上游反馈的固件问题

1. **Token 设计不安全** —— token 等于密码哈希、无过期、盐固定且前端可见、明文 HTTP
2. **`/audio_stream` 语义需明确** —— 到底是单通道还是 8 通道交织
3. **`abnormal_type` 位定义需文档化** —— 附录 B 未经证实
4. **录音下载接口需明确** —— `/audio_file` 未在真机前端出现
5. **建议 payload 增加显式 `device_id`** —— 目前只能靠 Push URL 中的 `dt_*` 标识
6. **`/download_audio/{file}` 无需认证** —— 知道文件名即可下载任意告警录音
7. **`/get_audio` 在真机上返回 nginx 404** —— 前端仍引用该端点，应清理或实现
8. **`/get_alarm_audio` 的失败语义有误导性** —— 请求格式错误与"无录音"返回同一错误

---

*本报告基于 2026-09-11 对固件 `567E68F.2026-06-26_WEEK26.XSUSER.V.1.0.8` 的实测。*
*固件升级后应重新运行 `npm run diagnose` 复核。*


---

## 附录：为什么有些写操作没有在真机上执行

最早那一轮实测只做了**大量只读探测**和**一次受控的写入验证**，Phase 9 的配置写入与
Phase 10 的破坏性操作**当时一个都没在真机上执行**。**2026 年那一轮改变了这个局面**：
用「值保持写探针」（把设备当前的值原样送回去，所以一次成功的写入不改变任何值，成败由
**读回**判定）**实际执行了七个写端点**，并在 §5A.0 给出逐条矩阵。

**到 2026 年为止，已经在真机上执行过写探针的端点**：

| 端点 | 为什么现在可以安全执行 |
|---|---|
| `set_samplingrate` | 送当前值（96000）。会重启采集，但值不变 |
| `set_passageway` | 单行 + 信封；改名后读回整张表并还原（§5A.2） |
| `set_devinfo` | 送当前设备名；再改回 |
| `set_timeset` | 送设备自己的时间（NTP 关闭，时钟本身在亚秒级漂移） |
| `set_rs485` / `set_modbus_para` | 送当前值 |
| `set_date_push` | 送当前十二个字段 |

**仍然没有执行、也刻意不执行的端点**：

| 操作 | 不执行的原因 |
|---|---|
| `set_network` | 改 IP 会立即断开当前连接。若新地址不可达且回滚也失败，设备将失联，只能现场恢复 |
| `system_control` 1/2/3 | 恢复出厂会清空设备全部配置；重启会中断监测 |
| `del_alarm_system` / `dele_audio` / `dele_alarm_audio` | 删除是破坏性的：真机上两条告警配置都在被通道引用，`dele_audio*` 会抹掉真实录音 |
| `add_alarm_system`（更新既有配置） | **试过一次**（§5A.3）：带信封后设备答 `dalName is Duplicate`，没有可用的值保持形状；再试下去就有真的改到保护定值的风险 |
| `POST /upload` | 固件刷写失败可能使设备变砖 |

**历史修正**：本节原先写着 `set_passageway` / `set_samplingrate` 等都因为「会影响现场」
而没有执行过 —— 那时它们的形状是从压缩后的 bundle 里静态读出来的，也正是因此
`set_passageway` 的形状写错了（八条数组）。**只读源码不足以确定写形状**：必须真机执行
一次值保持写入。这条教训是本次修正的核心。

**执行建议**（仍然成立，只是范围小了）：
1. 告警配置的**更新/删除**形状仍待验证 —— 请在可现场接触设备的环境下，对照设备原生 Web
   界面做一次；先建一条**不被任何通道引用**的临时配置再删它，比改现有两条安全
2. 网络变更与 `system_control` 最后做，并**事先确认可以通过设备本地界面或串口恢复**

本软件的 `ConfigService` 已实现完整的读-改-写与网络回滚逻辑，
网络变更失败时会自动回退并在界面显示可操作的提示。


---

## 附录一之二：2026 年轮次新增的**未验证**清单

这一轮只相信自己量到的东西。下面每一条都是**没有测量**的，任何实现都不应据此改动：

1. `set_network` / `system_control` / `del_alarm_system` / `dele_audio` /
   `dele_alarm_audio` 是否同样必须 `msgBody` —— **未验证**（同一代码模式，
   **很可能**需要，但没有测）。代码按原样保留。
2. `add_alarm_system` **更新**一条既有配置的正确形状 —— **未验证**。已知：去掉信封报
   integrity 错误，加上信封报 `dalName is Duplicate or empty`（`result:2`）。
3. `add_alarm_system` 删除/更新时 `dalId` 的语义（「有 `dalId` 即更新」是规格书推断）
   —— **未验证**。
4. 单行 `chinfoArray` 在固件内是**按 `dchId` 合并**还是**整体替换后回写其余行**
   —— 从外部无法区分，**未验证**。只确认了「改一路之后其余七路与 `chinfoSize` 不变」。
5. `set_samplingrate` / `set_timeset` / `set_rs485` / `set_modbus_para` / `set_date_push`
   的内层字段**是否全部必填** —— **未验证**（实测的是「信封必需」+「按原值送回不改变
   任何值」）。
6. `set_timeset` 的 `dsyNTPInterval` 单位 —— **未验证**（值 64）。
7. `devname` 的固件侧最小长度/字符集 —— **未验证**（64 字符与中文通道名通过；
   `[0-9a-zA-Z_]` 那条正则来自改密表单，**不是** `devname` 的约束）。
8. 设备 443/HTTPS 与其它端口 —— **未探测**（只用了 80）。
9. 固件错误文案的完整成因（integrity 错误的内部判定条件）—— **未验证**，
   只能从输入输出反推。
10. `set_samplingrate` 会「重启采集」这一点**没有在写入前后量过流**（写入本身成功且值
    未变），所以「重启」是文档推断而非本轮实测。


---

## 附录二：实施期间发现的自身缺陷（按严重度）

这些不是设备协议问题，是**本软件自身的 bug**，均在真机验证中被发现。
记录在此是为了让后来者知道这些坑存在过，以及它们为什么难以察觉。

### 1. `DeviceService.probe()` 传了无 scheme 的地址（致命）

**症状**：输入 IP 点击"测试连接"必然失败，错误信息为
`无法连接到设备: 192.168.110.90/login`，看起来像网络不通。

**原因**：`normaliseAddress()` 返回 `host:port`（不含 `http://`），
而 `fetch()` 需要完整 URL。该函数在 `probe()` 中被直接使用。

**影响**：**添加设备功能完全不可用** —— 即整个软件不可用。

**为什么难以察觉**：单元测试用 mock transport，不做真实 URL 解析；
手动探测脚本从命令行传入的是完整 URL，走的是另一条路径。
只有把 `DeviceService.add()` 作为整体在真机上跑才会暴露。

**修复**：`probe()` 中统一经 `normaliseBaseUrl()` 规范化。
`normaliseAddress()` 的文档注释已改为明确警示"这不是 URL"。

### 2. `StorageService.resolve()` 重复拼接根目录（严重）

**症状**：Parquet 文件被写到 `<root>/var/folders/.../<root>/metrics/...`，
而查询层在正确位置找不到任何文件——写入"成功"但数据凭空消失。

**原因**：该函数假设输入一定是相对路径，对绝对路径会剥掉开头 `/`
再当作相对路径拼接到 root 上。

**影响**：**路径安全守卫本身产出错误路径**，且完全静默。

**修复**：同时正确处理绝对与相对输入；越界检查保留。
新增 `tests/storage-paths.test.ts`（15 项）覆盖两个方向。

### 3. `startRecording()` 收窄了流集合（严重，且曾被误诊为设备限制）

**症状**：录音期间频谱与时频图收到 0 帧。

**误诊过程**：该症状与"设备固件限制"完全吻合、可稳定复现，
且事件循环延迟正常（28ms）排除了本地阻塞。
曾据此写下"设备在录音时停止推送慢速流"的结论**并写入代码注释与文档**。

**真相**：`startRecording()` 调用了 `start(['audio','features'], channelId)`，
而 `start()` 的语义是"这是期望的完整流集合"，于是它**关掉了**频谱与时频图，
且没有任何逻辑再把它们拉起来。

**为什么难以察觉**：症状看起来完全像外部限制，且我做的两个对照实验
（并发上限、事件循环阻塞）都正确地排除了自己——真正的 bug 在第三个地方。

**修复**：`startRecording` 不再收窄集合；恢复逻辑改为基于录音前的快照
（而非"我们主动挂起了哪些"），这样即使看门狗没触发也能恢复。

**教训**：**一个"看起来像外部限制"的症状，在归因于外部之前必须先做对照实验。**

### 4. 主进程事件桥接缺失（中等）

**症状**：趋势数据永远不写入，历史页面永远为空。

**原因**：特征事件由 `StreamManager` 发出，但 `DeviceService` 没有转发，
而趋势写入器订阅的是 `DeviceService`。

**修复**：新增 `bridgeManagerEvents()`，并在停止监测时成对解除。

### 5. 重复的 IPC 处理器注册（中等，启动即崩）

**症状**：主进程启动失败 `Attempted to register a second handler for 'config:get-sample-rate'`。

**原因**：Phase 2 的占位处理器未被清理干净。

**修复**：删除占位；**冒烟测试捕获了它**——这正是该测试存在的意义。

### 6. 类型布局破坏进程边界（架构性）

**症状**：`tsconfig.web.json` 需要把 `src/main/**` 纳入 `include` 才能通过
渲染层类型检查，`@main/*` 别名被引入渲染层。

**原因**：`shared/ipc/contract.ts` 从主进程服务文件**类型导入**视图模型。
类型导入并非零成本——TypeScript 会跟随文件，该文件的**运行时导入**
（`AppError`、logger、协议 DTO）随之被拉入渲染层项目。

**修复**：视图模型移到 `src/shared/domain/{device-config,trend}.ts`。
依赖方向变为 `主进程服务 ──实现──▶ 共享视图模型 ◀──消费── 渲染层`，
`src/main/**` 已从渲染层项目中移除。
