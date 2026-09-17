# FA371 在线声学相机（泄漏检测型）开放接口规格

> **设备**：HZ-FA-371 Online Acoustic Camera（Gas leak instruction manual，泄漏检测型）
> **唯一来源**：`docs/reference/FA371-manual-en.txt`（由 `FA371_Online acoustic camera user manual of Leak detetion model_v6.2.4_En.docx` 转换而来的纯文本，共 2342 行）
> **本文性质**：从手册**抽取**的可实现规格，不是实测报告。手册未写明之处一律标注 `手册未说明`，并在 §6 汇总。
>
> **版本注记（需向固件方确认）**：任务给定版本为 `v6.2.4`；但源文件正文首部写 `Document version V6.3` / `software version V6.3` / `Released March 18, 2025`，
> 修订记录两条均记为 `V6.2`（`2025.02.19 New real-time audio acquisition interface`、`2025.03.18 Updating the interface`）。
> 即**手册自身对"当前版本"表述不一致**。本文按源文件内容为准。
>
> **重要局限**：源文本中**所有插图均为空**（仅保留 `Figure 4-16 User Management` 之类的图题）。
> 凡是只能靠插图才能确定的字段（坐标单位、图形化配置项、页面布局），本文一律不猜，列入 §6。
>
> **本项目约定**：本规格中的任何 `手册未说明` 条目**不得靠推断实现**，必须在 Protocol Lab 页面上对真机实测后回填。

---

## 1. 约定

- 手册中所有示例均以 `http://localhost/...` 形式给出，`localhost` 应替换为设备 IP（默认 `192.168.2.168`）。
- 手册的 JSON 示例是**从 Word 复制后损坏的**：键值分隔符大量出现 `.` 而非 `,`，且缺少逗号、括号不配对。
  本文在引用时**逐字保留原样**（放入 `手册原文示例` 代码块），并在 `规范化示例` 中给出修复后可解析的等价 JSON。
  **这两者不可混用**：前者是证据，后者是实现参考。
- 手册请求头一律写 `Content-Type: application/JSON`（大小写不规则）。实现时应发标准 `application/json`，但需实测设备是否大小写敏感（见 §6）。
- 所有 HTTP 接口的通用返回字段（除个别例外）为：
  | 字段 | 类型 | 含义 |
  |---|---|---|
  | `ret` | integer | 返回码，`200` 表示成功；部分接口定义 `-1` 为业务失败 |
  | `msg` | String | 返回信息，成功时为 `"SUCCESS"` |
- **保留原样拼写**：本文严格保留手册中的键名与大小写，包括疑似笔误处：
  `target_numbe`（返回表）、`targe`（§4.3.2 正文）、`diagosisn`（§5.1.23）、`clarification`（大量表头）、
  `Times` / `Switch`（§5.1.22 大写开头）、`Notes`、`discharge_switch`。
  **不要"修正"它们**，前后端必须按原样匹配。

---

## 2. 认证机制（§5.1.1 + §4.1 + §4.7.4）

### 2.1 登录流程

| 项 | 值 |
|---|---|
| 方法 | `POST` |
| 路径 | `/login`（手册原文 `Request method and URL: POST /login`） |
| 完整示例 | `http://localhost/login` |
| 请求体 | 有 |
| 必需请求头 | `Content-Type: application/JSON`（手册 `compulsory` 列写 `necessarily`） |

**手册原文示例（逐字保留，注意分隔符是 `.` 不是 `,`）**：

```
Example of a ciphertext request:
{
"username": "admin".
"password": "********************"
}
```

**规范化示例（可解析）**：

```json
{
  "username": "admin",
  "password": "********************"
}
```

**请求字段**（手册字段表列 `parameter name / typology / clarification`，**没有"是否必需"列**）：

| 键 | 类型 | 说明（手册原文） | 必需 |
|---|---|---|---|
| `username` | `string` | `user ID` | 手册未说明（字段表无 compulsory 列） |
| `password` | `string` | `Password + lfxs MD5 encrypted ciphertext, 32 bit lowercase` | 手册未说明 |

> `password` 的派生规则（手册唯一一处说明）：
> 明文口令**拼接固定盐字符串 `lfxs`** 后取 **MD5**，输出 **32 位小写十六进制**。
> 手册未给出测试向量，也未说明拼接顺序是否为 `明文 + "lfxs"`（与 `"lfxs" + 明文`），见 §6。

**响应体**：

**手册原文示例**：

```
The interface returns JSON data as follows:
{
"token": "***************************"
}
```

| 键 | 类型 | 说明 |
|---|---|---|
| `token` | `string` | 手册称其为"encrypted token value"（"return encrypted token value"，§5.1.1 功能描述） |

- **token 字段名就是 `token`**（小写，无前缀）。
- 手册将其描述为 **encrypted**（加密的），但**未说明加密算法、是否就是 password 的 MD5 值本身、是否含过期时间**。
- 响应**没有** `ret` / `msg` 字段（与其余接口不同）。
- 登录失败时的响应体与状态码：手册未说明（仅笼统地说"authentication fails → 401"，见下）。

### 2.2 后续请求如何携带 token

手册原文（§5.1.1，第 371 行）：

> `All subsequent interfaces require a token in the HTTP header to be attached to the Authorization for authentication. If authentication fails or the token is invalid, a 401 error is returned.`

即：

- **请求头名称**：`Authorization`
- **头的值**：token 本身
- **是否带 `Bearer ` 前缀**：手册未说明（**这是实现的第一等风险项**，见 §6；本项目其它设备曾因加了 `Bearer ` 前缀被拒）
- **是否还需要额外的自定义头**（如 `token:`）：手册未说明

### 2.3 401 的含义

| 情形 | 行为 |
|---|---|
| 认证失败 | 返回 401 |
| token 无效 | 返回 401 |

手册**没有**：
- token 有效期 / 过期时间；
- refresh token 机制或续期接口；
- 登出 / 注销 / 吊销 token 的接口；
- 401 响应体格式；
- 401 后是否需重新 `POST /login`。

以上全部 `手册未说明`，见 §6。

---

## 3. HTTP 接口总览（§5.1.1 – §5.1.32，共 32 个）

**统计结论**：
- 手册目录（TOC）**列出 32 个** HTTP 接口，编号 5.1.1 – 5.1.32。
- 正文中**同样出现 32 个小节标题**，顺序与 TOC 完全一一对应。
- 因此 **已文档化 = 32 个，命名但未文档化 = 0 个**。
- 但注意：其中 **§5.1.15 `POST /turn_off_detect` 明确写"不返回内容"**，属于"有端点、无响应体"；
  **§5.1.15 / §5.1.18 / §5.1.19 / §5.1.24 / §5.1.29 / §5.1.32 等缺少完整请求示例或响应示例**。
  详细缺口见每个接口的"缺口"行与 §6。

| # | 方法 | 精确路径 | 用途 |
|---|---|---|---|
| 5.1.1 | `POST` | `/login` | 获取认证 token |
| 5.1.2 | `GET` | `/system/acoustic` | 获取声场配置（采样率、分析频带上/下限） |
| 5.1.3 | `PUT` | `/system/acoustic` | 设置声场配置 |
| 5.1.4 | `GET` | `/system/image` | 获取成像配置 |
| 5.1.5 | `PUT` | `/system/image` | 设置成像配置 |
| 5.1.6 | `GET` | `/system/video` | 获取视频与 RTSP 配置 |
| 5.1.7 | `PUT` | `/system/video` | 设置视频与 RTSP 配置 |
| 5.1.8 | `GET` | `/run_mode` | 获取运行模式 |
| 5.1.9 | `PUT` | `/run_mode` | 设置运行模式 |
| 5.1.10 | `GET` | `/system/leakage` | 获取泄漏估算配置 |
| 5.1.11 | `PUT` | `/system/leakage` | 设置泄漏估算配置 |
| 5.1.12 | `GET` | `/system/scan_area` | 获取检测区域 |
| 5.1.13 | `PUT` | `/system/scan_area` | 设置检测区域 |
| 5.1.14 | `POST` | `/turn_on_detect` | 开始检测任务 |
| 5.1.15 | `POST` | `/turn_off_detect` | 结束检测任务（无响应内容） |
| 5.1.16 | `GET` | `/system/detect_status` | 获取当前检测状态 |
| 5.1.17 | `GET` | `/detect_logs` | 获取检测日志 |
| 5.1.18 | `GET` | `/detect_file/{log.saving_path}/{logs.file_name}` | 下载检测结果文件 |
| 5.1.19 | `DELETE` | `/detect_logs` | 删除检测日志 |
| 5.1.20 | `GET` | `/system_time` | 获取系统时间 |
| 5.1.21 | `PUT` | `/time_set_manually` | 手动设置系统时间 |
| 5.1.22 | `GET` | `/alarm_strategy` | 获取告警策略 |
| 5.1.23 | `POST` | `/alarm_strategy` | 新建告警策略 |
| 5.1.24 | `DELETE` | `/alarm_strategy` | 删除告警策略 |
| 5.1.25 | `PUT` | `/alarm_strategy` | 修改告警策略 |
| 5.1.26 | `GET` | `/alarm_condition` | 获取告警条件 |
| 5.1.27 | `POST` | `/alarm_condition` | 新增告警条件 |
| 5.1.28 | `PUT` | `/alarm_condition` | 修改告警条件 |
| 5.1.29 | `DELETE` | `/alarm_condition` | 删除告警条件 |
| 5.1.30 | `POST` | `/upload_nc` | 上传噪声比对文件 |
| 5.1.31 | `GET` | `/nc_filelist` | 获取比对文件列表 |
| 5.1.32 | `DELETE` | `/nc_file` | 删除比对文件 |

> **路径拼写注意**：手册用 `snake_case`（`/system/scan_area`、`/turn_on_detect`、`/system_time`、`/time_set_manually`、`/nc_filelist`、`/upload_nc`）。
> **不要改写成 camelCase 或 kebab-case**。注意两处"看似笔误但必须保留"：
> 5.1.16 的路径是 `/system/detect_status`（手册把 `HYPERLINK "http://localhost/detect%20status"` 与正文 `http://localhost/system/detect_status` 并列给出，**以 `Request method and URL` 行为准**）；
> 5.1.21 的功能描述里写 `Request format: http://localhost/system_time`，但实际路径是 `/time_set_manually`。
>
> **本组接口未在手册中出现**（UI 有、Open Interface 未开放）：修改密码、网络配置读写、设备重命名、升级/回滚、重启/恢复出厂、定时重启、系统信息读取。
> 这些只存在于 §4.x 的 Web UI 描述中。见 §5 与 §6。

---

## 4. HTTP 接口详述

### 5.1.2 `GET /system/acoustic` — 获取声场配置

- 请求体：无。
- 用途：读取 MIC 阵列采样率、分析频带上限/下限。

**手册原文示例**：

```
{
"freq_up_limit": 25,
"freq_down_limit": 20,
"samplerate": 13200.
"ret": 200,
"msg": "SUCCESS".
}
```

| 键 | 手册类型 | 必需 | 单位 | 说明 |
|---|---|---|---|---|
| `freq_up_limit` | integer | necessarily | KHz | 分析频带上限 |
| `freq_down_limit` | integer | necessarily | KHz | 分析频带下限 |
| `samplerate` | integer | necessarily | KHz | MIC 阵列采样率 |
| `ret` | integer | necessarily | — | 返回码 |
| `msg` | String | necessarily | — | 返回信息 |

**缺口**：
- 示例中 `samplerate: 13200` 与 §5.1.3 的取值范围（`96000` 或 `132000`）**量纲矛盾**（示例疑似少一个 0，且"单位 KHz"与数值 96000 亦不自洽）。
- `freq_up_limit: 25` / `freq_down_limit: 20` 是合法示例，但示例里没有 `imaging_*` 类字段。

### 5.1.3 `PUT /system/acoustic` — 设置声场配置

- 请求体：有。Header `Content-Type: application/JSON`（necessarily）。
- 手册给出的硬约束（正文，第 453 行）：
  - 分析频带可调范围 `2~65KHz`，**必须为整数**；
  - **上下限之差不能大于 20、不能小于 2**；
  - **上限必须大于下限**；
  - MIC 采样率支持 `96KHz` 与 `132KHz` 两种，**使用中不建议修改**。

**手册原文示例**：

```
{
"freq_up_limit": 25,
"freq_down_limit": 20,
"samplerate": 132000.
}
```

| 键 | 类型 | 必需 | 取值范围 | 说明 |
|---|---|---|---|---|
| `freq_up_limit` | integer | non-essential | `4~65` 整数（KHz） | 分析频带上限 |
| `freq_down_limit` | integer | non-essential | `2~63` 整数（KHz） | 分析频带下限 |
| `samplerate` | integer | non-essential | `96000` 或 `132000` | MIC 阵列采样率 |

**缺口**：
- 字段表写 `non-essential`（非必需），但正文约束是"上下限之差 2~20 且上限>下限"——**只发单个字段时如何校验**手册未说明。
- 值为 `96000` 时手册字段说明写"in KHz"，数值与单位不自洽（应为 Hz？）→ §6。
- 响应体未给出（推测为 `ret`/`msg`，但**手册未说明**）。

### 5.1.4 `GET /system/image` — 获取成像配置

- 请求体：无。

**手册原文示例**：

```
{
"energy_threshold": 25,
"target_number": 1,
"ret": 200,
"msg": "SUCCESS".
}
```

| 键 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `energy_threshold` | integer | necessarily | 成像阈值 |
| `target_numbe` | integer | necessarily | 目标数量（**手册字段表拼作 `target_numbe`，示例 JSON 里是 `target_number`**） |
| `imaging_sensitivity` | integer | necessarily | 成像滤波灵敏度（滤波档位），范围 `[0,2]` |
| `imaging_enhance` | integer | necessarily | 成像增强，范围 `[0,2]`，`0` 表示关闭 |
| `ret` | integer | necessarily | 返回码 |
| `msg` | String | necessarily | 返回信息 |

**缺口（重要）**：字段表声明有 `imaging_sensitivity` 与 `imaging_enhance`，但**示例 JSON 中完全没有这两个键**；
且字段表里的键名是 `target_numbe`（漏了 `r`），示例里是 `target_number`。**到底哪个是设备真实键名，必须实测**（§6）。

### 5.1.5 `PUT /system/image` — 设置成像配置

- 请求体：有。
- 正文约束：成像阈值用于调节检测门限；现场环境能量值高于阈值时状态变为异常并实时成像；
  **检测目标数量当前最多支持 3 个**。

**手册原文示例**：

```
{
"energy_threshold": 25,
"target_number": 1,
}
```

| 键 | 类型 | 必需 | 范围/默认 | 说明 |
|---|---|---|---|---|
| `energy_threshold` | integer | necessarily | 手册未说明范围 | 成像阈值 |
| `target_numbe` | integer | necessarily | 最多 3（手册正文），示例 `1` | 目标数量 |
| `imaging_sensitivity` | integer | necessarily | `[0,2]` | 成像滤波灵敏度 |
| `imaging_enhance` | integer | necessarily | `[0,2]`，`0`=off | 成像增强 |

**缺口**：`energy_threshold` 的取值范围/单位（dB？）手册未说明；响应体未给出。

### 5.1.6 `GET /system/video` — 获取视频与 RTSP 配置

- 请求体：无。

**手册原文示例**：

```
{
    "rtsp_client_limit": 6,
    "rtsp_connected_num": 1,
    "rtsp_enabled": 1,
    "video_bit_rate": 4096,
    "video_flip_model": 0,
    "video_fps": 30,
    "video_height": 1080,
    "video_port": 443,
    "video_url": "live",
    "video_width": 1920.
    "msg": "SUCCESS".
    "ret": 200,

}
```

**规范化示例**：

```json
{
  "rtsp_client_limit": 6,
  "rtsp_connected_num": 1,
  "rtsp_enabled": 1,
  "video_bit_rate": 4096,
  "video_flip_model": 0,
  "video_fps": 30,
  "video_height": 1080,
  "video_port": 443,
  "video_url": "live",
  "video_width": 1920,
  "msg": "SUCCESS",
  "ret": 200
}
```

| 键 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `video_bit_rate` | integer | necessarily | 视频码率，固定取值 `4096 / 2048 / 1024 / 512` |
| `video_fps` | integer | necessarily | 视频帧率，**仅支持 30** |
| `video_height` | integer | necessarily | 分辨率高 |
| `video_width` | integer | necessarily | 分辨率宽 |
| `video_flip_model` | integer | necessarily | 翻转模式：`0` 默认，`1` 垂直翻转，`2` 水平翻转，`3` 180° 翻转 |
| `video_port` | integer | necessarily | RTSP 服务端口（示例 `443`） |
| `video_url` | **手册标注 integer** | necessarily | RTSP 服务 url（**示例值却是字符串 `"live"`** → 类型自相矛盾，§6） |
| `rtsp_connected_num` | integer | necessarily | 当前已建立的 RTSP 连接数 |
| `rtsp_client_limit` | integer | necessarily | RTSP 客户端上限，整数范围 `[1,6]` |
| `rtsp_enabled` | integer | necessarily | RTSP 服务开关，`0`-off，`1`-on |
| `ret` | integer | necessarily | 返回码 |
| `msg` | String | necessarily | 返回信息（手册字段表未给这两行的说明文字） |

- 备注（手册原文）：`Note: The resolution takes a fixed value: 1920 * 1080, 1280 * 720`
- §4.3.3 补充：视频编码默认 `H.264`；视频帧率默认 `30fps` 且**不可修改**。

### 5.1.7 `PUT /system/video` — 设置视频与 RTSP 配置

- 请求体：有。**设置分辨率时必须同时传 `video_height` 与 `video_width`，且取固定值。**

**手册原文示例**：

```
{
    "rtsp_client_limit": 4,
    "rtsp_connected_num": 1,
    "rtsp_enabled": 1,
    "video_bit_rate": 4096,
    "video_flip_model": 0,
    "video_fps": 30,
    "video_height": 1080,
    "video_port": 443,
    "video_url": "live",
    "video_width": 1920.

}
```

| 键 | 类型 | 必需 | 范围/取值 |
|---|---|---|---|
| `video_height` | integer | non-essential | 固定值 `1080` / `720`（须与 `video_width` 成对） |
| `video_width` | integer | non-essential | 固定值 `1920` / `1280`（须与 `video_height` 成对） |
| `video_fps` | integer | non-essential | 仅支持 `30` |
| `video_bit_rate` | integer | non-essential | 固定值 `4096 / 2048 / 1024 / 512` |
| `video_flip_model` | integer | non-essential | `0` 默认 / `1` 垂直翻转 / `2` 水平翻转 / `3` 180° 翻转 |
| `video_port` | integer | non-essential | RTSP 服务端口 |
| `video_url` | 手册标注 integer | non-essential | RTSP 服务 url（示例字符串 `"live"`） |
| `rtsp_client_limit` | integer | non-essential | `[1,6]` |
| `rtsp_enabled` | integer | non-essential | `0`-off / `1`-on |

**缺口**：
- 请求字段表**未列 `rtsp_connected_num`**，但示例里发了它（只读计数，发它是否有副作用手册未说明）。
- **合法分辨率组合校验规则**：手册说"固定值 1920\*1080、1280\*720"，但未说明混搭（如 1920+720）是否被拒。
- 响应体未给出。
- 无 RTSP 用户名/口令字段 → RTSP 是否需鉴权，手册未说明（§6）。

### 5.1.8 `GET /run_mode` — 获取运行模式

**手册原文示例**：

```
{
"run_mode": 1,
"ret": 200,
"msg": "SUCCESS".
}
```

| 键 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `run_mode` | integer | necessarily | 检测模式：`1` = Single detection mode（单次检测模式）；`-1` = Intelligent cruise mode（智能巡航模式） |
| `ret` | integer | necessarily | 返回码 |
| `msg` | String | necessarily | 返回信息 |

### 5.1.9 `PUT /run_mode` — 设置运行模式

**手册原文示例**：

```
{
"run_mode": 1,
}
```

| 键 | 类型 | 必需 | 取值 |
|---|---|---|---|
| `run_mode` | integer | necessarily | `1` 单次检测模式；`-1` 智能巡航模式 |

**缺口**：模式切换失败的返回码、切模式是否中断正在进行的检测、响应体形状 → 手册未说明。

### 5.1.10 `GET /system/leakage` — 获取泄漏估算配置

**手册原文示例**：

```
{
    "cost_display": 1,
    "leakage_distance": 1,
    "leakage_unit": 1,
    "leakage_unit_str": "l/min",
    "monetary_unit": 1,
    "monetary_unit_str": "CNY",
"energy_cost": 1,
    "specific_power": 1,
"value_of_gas": 1,
    "working_hours": 1
"ret": 200,
"msg": "SUCCESS".

}
```

| 键 | 类型 | 必需 | 单位 | 说明 |
|---|---|---|---|---|
| `cost_display` | integer | necessarily | — | 是否在 web 端展示泄漏成本估算结果：`0` 不展示，`1` 展示 |
| `leakage_distance` | integer | necessarily | 米 | 泄漏估算距离，范围 `[1~50]` |
| `leakage_unit` | integer | necessarily | — | 泄漏估算与显示单位：`0`--`l/min`，`1`--`ml/s` |
| `leakage_unit_str` | string | necessarily | — | 单位字符串，`l/min` 或 `ml/s` |
| `monetary_unit` | integer | necessarily | — | 货币单位：`0`-¥(CNY)、`1`-£(GBP)、`2`-$(USD)、`3`-€(EUR)、`4`-₽(RUB) |
| `monetary_unit_str` | string | necessarily | — | 货币单位字符串：`CNY / GBP / USD / EUR / RUB` |
| `value_of_gas` | float | necessarily | 货币单位/m³ | 气体价值 |
| `energy_cost` | float | necessarily | 货币单位/kWh | 能源成本 |
| `specific_power` | float | necessarily | kW/(m³/min) | 比功率 |
| `working_hours` | integer | necessarily | h/年 | 年均工作时长 |
| `ret` | integer | necessarily | — | 返回码 |
| `msg` | String | necessarily | — | 返回信息 |

**缺口**：
- 示例中 `leakage_unit: 1` 与 `leakage_unit_str: "l/min"` **枚举不一致**（按定义 `1` 应配 `ml/s`）；同理 `monetary_unit: 1` 配 `"CNY"`（按定义 `1` 应为 GBP）。示例值显然未与枚举对齐。
- `value_of_gas` / `energy_cost` / `specific_power` / `working_hours` 的**取值范围与默认值**手册未说明。
- `data_1`~`data_4`（§5.1.17）与本节字段的对应关系部分靠猜（见 §6）。

### 5.1.11 `PUT /system/leakage` — 设置泄漏估算配置

- 请求体：有。手册原文说明："parameter name is the same as above, and **the corresponding field is sent separately if a parameter needs to be configured at the time of the request**"（即支持部分字段更新）。

**手册原文示例**（注意：示例里**没有** `leakage_unit_str` / `monetary_unit_str`）：

```
{
    "cost_display": 1,
    "leakage_distance": 1,
    "leakage_unit": 1,
    "monetary_unit": 1,
"energy_cost": 1,
    "specific_power": 1,
"value_of_gas": 1,
    "working_hours": 1
}
```

| 键 | 类型 | 必需 | 范围/单位 |
|---|---|---|---|
| `cost_display` | integer | non-essential | `0` / `1` |
| `leakage_distance` | integer | non-essential | `[1~50]` 米 |
| `leakage_unit` | integer | non-essential | `0`=`l/min`，`1`=`ml/s` |
| `monetary_unit` | integer | non-essential | `0`~`4`（见上表） |
| `value_of_gas` | float | non-essential | 货币单位/m³ |
| `energy_cost` | float | non-essential | 货币单位/kWh |
| `specific_power` | float | non-essential | kW/(m³/min) |
| `working_hours` | integer | non-essential | h/年 |

**缺口**：两个 `*_str` 是否可由客户端设置（还是设备回显）、响应体 → 手册未说明。

### 5.1.12 `GET /system/scan_area` — 获取检测区域

**手册原文示例**（原文括号与逗号严重损坏，逐字保留）：

```
{
    "areas": [
        {
            "area_height": 168.
            "area_width": 240,
            "detect_area_status": 1,
            "left_top_x": 12,
            "left_top_y": 12
        }, }
        {
            "area_height": 168.
            "area_width": 240,
            "detect_area_status": 1,
            "left_top_x": 257.
            "left_top_y": 185
        }, }
        {
            "area_height": 168.
            "area_width": 240,
            "detect_area_status": 1,
            "left_top_x": 502,
            "left_top_y": 358
        }, }
        {
            "area_height": 168.
            "area_width": 240,
            "detect_area_status": 1,
            "left_top_x": 747,
            "left_top_y": 531
        }, }
        {
            "area_height": 168.
            "area_width": 240,
            "detect_area_status": 1,
            "left_top_x": 992,
            "left_top_y": 704
        }
    ],
    "center_focus": 2,
    "msg": "SUCCESS".
    "ret": 200
}
```

**规范化示例**：

```json
{
  "areas": [
    { "area_height": 168, "area_width": 240, "detect_area_status": 1, "left_top_x": 12,  "left_top_y": 12  },
    { "area_height": 168, "area_width": 240, "detect_area_status": 1, "left_top_x": 257, "left_top_y": 185 },
    { "area_height": 168, "area_width": 240, "detect_area_status": 1, "left_top_x": 502, "left_top_y": 358 },
    { "area_height": 168, "area_width": 240, "detect_area_status": 1, "left_top_x": 747, "left_top_y": 531 },
    { "area_height": 168, "area_width": 240, "detect_area_status": 1, "left_top_x": 992, "left_top_y": 704 }
  ],
  "center_focus": 2,
  "msg": "SUCCESS",
  "ret": 200
}
```

| 键 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `areas` | object[] | （字段表按子字段列出，未单独标注） | 矩形区域数组 |
| `areas[].area_height` | integer | necessarily | 矩形高 |
| `areas[].area_width` | integer | necessarily | 矩形宽 |
| `areas[].detect_area_status` | integer | necessarily | 检测区绘制状态：`0` 隐藏，`1` 显示 |
| `areas[].left_top_x` | integer | necessarily | 左上角横坐标 |
| `areas[].left_top_y` | integer | necessarily | 左上角纵坐标 |
| `center_focus` | integer | necessarily | 框选模式：`1` 中心聚焦模式，`2` 框选模式 |
| `ret` / `msg` | integer / String | necessarily | 返回码 / 返回信息 |

**缺口（重点）**：
- `areas` **数组长度、最大值**未说明；示例给了 5 个，但 §4.3.5 的"分区模式（Partition Mode）"未给数量上限。
- 坐标**单位与参考系**未说明（像素？相对 1920×1080？示例坐标最大到 992+240=1232，暗示横轴基准约 1920；
  **垂直方向 704+168=872，与 1080 不吻合**，无法确认）→ Protocol Lab 必须实测。
- 两个模式（`center_focus` 1/2）下 `areas` 各自是否被忽略，手册未说明。

### 5.1.13 `PUT /system/scan_area` — 设置检测区域

- 请求体：有。**手册明确要求"all fields need to be sent when requesting"（所有字段都必须发送）。**

**手册原文示例**：

```
{
 "areas":[
 {"area_height":432,.
 "area_width":768,
 "detect_area_status":1,
 "left_top_x":576.
 "left_top_y":324}].
 "center_focus":1,
}
```

**规范化示例**：

```json
{
  "areas": [
    { "area_height": 432, "area_width": 768, "detect_area_status": 1, "left_top_x": 576, "left_top_y": 324 }
  ],
  "center_focus": 1
}
```

| 键 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `areas[].area_height` | integer | necessarily | 矩形高 |
| `areas[].area_width` | integer | necessarily | 矩形宽 |
| `areas[].detect_area_status` | integer | necessarily | `0` 隐藏 / `1` 显示 |
| `areas[].left_top_x` | integer | necessarily | 左上角横坐标 |
| `areas[].left_top_y` | integer | necessarily | 左上角纵坐标 |
| `center_focus` | integer | necessarily | `1` 中心聚焦模式 / `2` 框选模式 |

**缺口**：示例中 `area_height=432, area_width=768`（16:9 的一半）与 GET 示例中 `168×240`（非 16:9）不一致；
坐标的合法边界（是否必须 `left_top_x + area_width <= 1920`）未说明；响应体未给出。

### 5.1.14 `POST /turn_on_detect` — 开始检测

- 请求体：**无**。
- 语义（手册原文）：
  - **单次检测模式**：启动后只检测一次，返回本次检测结果数据 id，结束后可在数据页查看；
  - **智能巡航模式**：启动后对已开启的告警策略循环检测，**只有检测到异常才会记录检测结果**。

**手册原文示例**：

```
{
"detect_id": 1,
"ret": 200,
"msg": "SUCCESS".
}
```

| 键 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `detect_id` | integer | non-essential | 检测 id（**仅在单次检测模式开启时返回**） |
| `ret` | integer | necessarily | 返回码，**`-1` 表示当前没有可用策略** |
| `msg` | String | necessarily | 返回信息 |

**缺口**：`ret` 除 `200`/`-1` 外的其它错误码、智能巡航模式下 `detect_id` 是缺失还是 `0` → 手册未说明。

### 5.1.15 `POST /turn_off_detect` — 结束检测

- 请求体：**无**。
- **响应：无内容。** 手册原文：

> `Used to end the detection task (currently all detection results are transmitted asynchronously via websocket, so the end of the detection request does not return content, see 5.2.3 for details)`

**缺口**：HTTP 状态码是否有语义（200/204）、重复调用是否报错、未在检测中调用是否报错 → 手册未说明。

### 5.1.16 `GET /system/detect_status` — 获取检测状态

**手册原文示例**（注意：**只有这一个字段，没有 `ret` / `msg`**）：

```
{
    "detect_status": 0
}
```

| 键 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `detect_status` | **boolean**（手册字段表） | necessarily | 是否正在检测：`0` 未检测，`1` 正在检测 |

**缺口**：字段表类型写 `boolean`，但取值语义是 `0`/`1`（等价于 integer）。响应**缺少 `ret`/`msg`**，
是本组接口中唯一如此者 → 实现时必须容错（§6）。

### 5.1.17 `GET /detect_logs` — 获取检测日志

- **路径参数通过 Query Param 传递**（手册原文：`The request parameters need to be put into the Query Param of the HTTP request`）。

| 参数 | 必需 | 默认值 | 说明 |
|---|---|---|---|
| `detect_id` | non-essential | `1` | 检测日志 id |

> 手册同时给出 `Request format: http://localhost/detect_logs/{detect_id}`（路径式），
> 与"Query Param"说明**互相矛盾** → §6。分页参数（page/page_size）**未说明**。

**手册原文示例**（结构与 §5.2.3 相同，但此处外层缺 `detect_logs` 数组包装，且首行 `bin_mic_data_name` 后多了一个 `{`）：

```
{
	 "bin_mic_data_name": "mic_data_2019_06_20_20_30_39_940.bin",
	"data_1": 0.0,
	"data_2": -1.0,
	"data_3": 0.0,
	"data_4": 0.0,
	"detect_mode": 2,
	"end_time": 1561033842,
	"files_status": 1,
	"id": 7.
	"power_spect_photo_name": "power_spectrum_2019_06_20_20_30_39_940.jpg",
	"power_spect_video_name": "power_spectrum_2019_06_20_20_30_39_940.mp4",
	"saving_path": "2019_06_20_20_30_39_940/",
	"soundmap_intensity": 20.4,
	"soundmap_photo_name": "sound_2019_06_20_20_30_39_940.jpg",
	"soundmap_video_name": "sound_2019_06_20_20_30_39_940.mp4",
	"start_time": 1561033839.
	"status": 1.
	"voiceprint_photo_name": "voiceprint_2019_06_20_20_30_39_940.jpg",
	"voiceprint_video_name": "voiceprint_2019_06_20_20_30_39_940.mp4",
	"wav_mic_data_name": "mic_data_2019_06_20_20_30_39_940.wav"
 },
 "msg": "SUCCESS",
 "ret": 200
 }
```

| 键 | 手册类型 | 说明 |
|---|---|---|
| `detect_logs` | array | 日志组（**字段表声明此键，但示例中未出现**——示例直接是一个裸对象） |
| `id` | int | 日志编号 |
| `detect_mode` | int | 检测模式 |
| `start_time` | **string**（手册字段表；示例为整数 `1561033839`） | 检测开始时间 |
| `end_time` | **string**（手册字段表；示例为整数 `1561033842`） | 检测结束时间 |
| `status` | int | 检测状态 |
| `soundmap_intensity` | int（示例 `20.4` 为浮点） | 声场强度 |
| `files_status` | （键，字段表写作 `file_status`） | 文件保存状态：`0`-Deleted，`1`-Saved |
| `saving_path` | string | 以开始时间命名的文件夹，记录文件保存路径 |
| `power_spect_video_name` | string | 标识谱图视频文件名 |
| `power_spect_photo_name` | string | 标识谱图图片文件名 |
| `soundmap_video_name` | string | 声场成像视频文件名 |
| `soundmap_photo_name` | string | 声场成像图片文件名 |
| `voiceprint_video_name` | string | 声纹视频文件名 |
| `voiceprint_photo_name` | string | 声纹图片文件名 |
| `bin_mic_data_name` | string | 声场音频文件名（bin 格式） |
| `wav_mic_data_name` | string | 声场音频文件名（wav 格式） |
| `data_1` | number | 泄漏量（§5.2.3 表格同位置写作 `spill`） |
| `data_2` | number | 泄漏成本 |
| `data_3` | number | 泄漏单位 |
| `data_4` | number | 泄漏成本单位 |
| `alarm_strategy_id` | int | 策略 ID |
| `alarm_level` | int | 告警等级（与策略 `level` 相同） |
| `nc_file` | string | 比对样本文件名 |
| `last_alarm_db` | number | dB 告警值 |
| `last_alarm_df` | number | 主频告警值 |
| `last_alarm_nc` | number | 样本文件方差 |
| `is_alarm` | number | 是否告警：`0` 否，`1` 是 |
| `nc_file_path` | string | 样本文件路径 |
| `nc_file_fft_photo_name` | string | 样本文件 fft 图 |

**缺口（重点）**：
- 字段表列了 `alarm_strategy_id`、`alarm_level`、`nc_file`、`last_alarm_db`、`last_alarm_df`、`last_alarm_nc`、`is_alarm`、`nc_file_path`、`nc_file_fft_photo_name`，**但示例 JSON 中一个都没有**。
- `files_status`（示例）vs `file_status`（字段表）拼写冲突；`soundmap_intensity` 类型 int vs 示例浮点。
- 时间戳单位/时区未说明（示例 `1561033839` 是 10 位秒级 Unix 时间戳，但手册未写明）。
- 返回是"单条日志"还是"日志数组"——字段表说 array，示例说 object → §6。

### 5.1.18 `GET /detect_file/{log.saving_path}/{logs.file_name}` — 下载检测结果文件

- 请求体：无。
- 返回：对应的视频或图片文件（二进制）。手册示例：

```
http://192.168.2.204/detect_file/2023_04_07_14_31_29_133/sound_2023_04_07_14_31_29_133.jpg
```

**缺口**：
- 占位符 `{log.saving_path}` / `{logs.file_name}` 的手册命名不统一（`log` vs `logs`）；
  `saving_path` 自带结尾 `/`（见 §5.1.17 示例 `"2019_06_20_20_30_39_940/"`），拼接时是否会产生双斜杠未说明。
- **没有下载鉴权说明**：是否必须带 `Authorization` 头，浏览器直接打开 URL 是否可用 → 手册未说明。
- 支持的扩展名集合、Content-Type、Content-Disposition → 手册未说明。

### 5.1.19 `DELETE /detect_logs` — 删除检测日志

- 请求体：有。Header `Content-Type: application/JSON`。

**手册原文示例**（**原文缺右花括号，逐字保留**）：

```
{
    "id": [2,3]
```

| 键 | 手册类型 | 必需 | 说明 |
|---|---|---|---|
| `id` | **string**（手册字段表写 string，实际为数组） | non-essential | 待删除日志 id 数组 |

**缺口**：字段表 `typology` 写 `string` 但示例是 `[2,3]`（数组）→ 类型自相矛盾；响应体未给出。

### 5.1.20 `GET /system_time` — 获取系统时间

**手册原文示例**：

```
{
    "sys_time": 17220332
}
```

| 键 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `sys_time` | number | necessarily | 系统时间戳 |

**缺口**：
- **单位未说明**（秒还是毫秒？示例 `17220332` 既不像 10 位秒级也不像 13 位毫秒级，只有 8 位 → 疑似示例被截断）。
- 时区 / UTC 偏移未说明。
- 响应**缺少 `ret` / `msg`**（与 §5.1.16 同类例外）。

### 5.1.21 `PUT /time_set_manually` — 手动设置系统时间

- 请求体：有。Header `Content-Type: application/JSON`。
- 注意：手册"Request format"行写 `http://localhost/system_time`，但 `Request method and URL` 行是 `PUT /time_set_manually`
  → **以 `/time_set_manually` 为准**（路径不一致列入 §6）。

**手册原文示例**：

```
{
    "time": 12345678,
}
```

| 键 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `time` | number | necessarily | 系统时间戳 |

**缺口**：`time` 与 `sys_time` **键名不同**（读用 `sys_time`、写用 `time`）；单位未说明；响应体未给出。

### 5.1.22 `GET /alarm_strategy` — 获取告警策略

| Query 参数 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `page` | integer | necessarily | 请求页码 |

**返回结构**（手册字段表）：

| 键 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `alarm_strategy_list` | object[] | necessarily | 元素类型 object |
| `alarm_strategy_list[].id` | **string** | necessarily | 策略 id（手册写 string，但 §5.1.25 `PUT` 里 `id` 是 integer → 冲突） |
| `alarm_strategy_list[].name` | string | necessarily | 策略名 |
| `alarm_strategy_list[].alias` | string | necessarily | 昵称 |
| `alarm_strategy_list[].alarm_condition_id` | integer | necessarily | 关联的告警条件 id |
| `alarm_strategy_list[].alarm_condition_name` | string | necessarily | 关联的告警条件名 |
| `alarm_strategy_list[].interval_time` | integer | necessarily | 间隔时间 |
| `alarm_strategy_list[].Times` | integer | necessarily | 序号（**注意是大写 `Times`**） |
| `alarm_strategy_list[].timeout_duration` | integer | necessarily | 超时周期 |
| `alarm_strategy_list[].sensitivity` | number | necessarily | 灵敏度 |
| `alarm_strategy_list[].level` | integer | necessarily | 等级 `0, 1, 2, 3`（**注意：与 `POST`/`PUT` 的 `1,2,3,4` 不一致**） |
| `alarm_strategy_list[].diagnosis` | string | necessarily | 诊断说明 |
| `alarm_strategy_list[].Switch` | integer | necessarily | 开关，`1` 开 `0` 关（**注意是大写 `Switch`**） |
| `page_total` | integer | necessarily | 总页数 |

**缺口**：`page` 是 Query Param 还是 Request Body 未说明；每页条数未说明；**本节完全没有返回示例 JSON**（只有字段表）。
`id` 类型 string vs `PUT` 的 integer 冲突；`level` 取值集合与 §5.1.23/25 冲突。均列入 §6。

### 5.1.23 `POST /alarm_strategy` — 新建告警策略

- 请求体：有。
- 手册注意事项（原文）：
  1. 一个策略只能关联**一个**告警条件，通过 `alarm_id` 字段绑定；
  2. 告警策略的逻辑条件包括：**sound pressure level alarm（声压级告警）、main frequency alarm（主频告警）、spectrum comparison（频谱比对）**。

| 键 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `name` | string | necessarily | 策略名，`1~20` 字符。例：`"Strategy One"` |
| `alias` | string | necessarily | 昵称 |
| `alarm_id` | integer | necessarily | 告警条件 id（**注意：写入用 `alarm_id`，读取用 `alarm_condition_id`**） |
| `level` | integer | necessarily | 等级 `1, 2, 3, 4`，标记紧迫/重要程度 |
| `interval_time` | integer | necessarily | 间隔时间。两次告警之间的间隔长度；智能巡航模式下"策略运行一次 → SLEEP 该时长 → 下一次检测" |
| `times` | integer | necessarily | 序号（**小写 `times`**，与读取的 `Times` 不一致） |
| `timeout_duration` | integer | necessarily | 检测周期，`1~30` 秒 |
| `sensitivity` | number | necessarily | 灵敏度 `0-1`，衡量一个策略周期内对异常信号的敏感度 |
| `diagosisn` | string | necessarily | 诊断说明（**键名是 `diagosisn`，是 `diagnosis` 的笔误——必须按原样发送**） |

**返回**：

| 键 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `ret` | integer | necessarily | 返回码 |
| `msg` | String | necessarily | 返回信息 |

**缺口**：
- **本节没有请求示例 JSON**，也没有成功时 `ret` 的具体值/`id` 回传方式（新建后如何拿到新策略 id 未说明）。
- `times` 的语义（"ordinal number / 序号"）不足以判断它是"重复次数"还是"排序号"；取值范围未说明。
- `interval_time` 取值范围未说明。
- `diagosisn` 是否为设备真实键名，或字段表本身写错 → 必须实测（§6）。

### 5.1.24 `DELETE /alarm_strategy` — 删除告警策略

- 请求体：有。

| 参数 | 手册类型 | 说明 |
|---|---|---|
| （手册未给字段名） | `integer []` / arrays | 待删除的告警策略 id 数组。示例：`[1,2]` |

**返回**：`ret`（integer，necessarily）、`msg`（String，necessarily）。

**缺口**：
- **请求字段名缺失**（表格第一行只有类型 `integer[]`，没有 parameter name）。
  参照 §5.1.19 的 `id`，推测也是裸数组或 `{"id": [...]}`，但**手册未说明** → 必须实测。
- 没有请求示例；删除失败返回码未说明。

### 5.1.25 `PUT /alarm_strategy` — 修改告警策略

- 请求体：有。
- **注意事项（原文）：`Enabled policies cannot be modified.`（已启用的策略不能被修改。）**

| 键 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `id` | integer | necessarily | 待修改策略的 ID |
| `name` | string | necessarily | 策略名，`1~20` 字符 |
| `alias` | string | necessarily | 昵称 |
| `alarm_id` | integer | necessarily | 告警条件 id |
| `level` | integer | necessarily | 等级 `1, 2, 3, 4` |
| `interval_time` | integer | necessarily | 间隔时间 |
| `times` | integer | necessarily | 序号 |
| `timeout_duration` | integer | necessarily | 检测周期，`1~30` 秒 |
| `sensitivity` | number | necessarily | 灵敏度 `0-1` |
| `diagnosis` | string | necessarily | 诊断说明（**注意：这里是 `diagnosis`，而 `POST` 里是 `diagosisn`**） |

**返回**：

| 键 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `ret` | integer | necessarily | 返回码。**`-1`：当前策略为开启状态，修改失败** |
| `msg` | String | necessarily | 返回信息 |

**缺口**：`POST` 用 `diagosisn`、`PUT` 用 `diagnosis`，是否同一字段两种拼写都能接受 → 手册未说明（§6）。
没有请求示例。

### 5.1.26 `GET /alarm_condition` — 获取告警条件

| Query 参数 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `page` | integer | necessarily | 请求页码 |

| 键 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `alarm_condition_list` | object[] | necessarily | 元素类型 object |
| `alarm_condition_list[].id` | integer | necessarily | 告警条件 ID |
| `alarm_condition_list[].name` | string | necessarily | 告警条件别名 |
| `alarm_condition_list[].decibel_thr` | integer | necessarily | dB 告警值（**范围/单位未说明**） |
| `alarm_condition_list[].db_arithmetic_operator` | integer | necessarily | 分贝算术运算符 `(0-4)` 对应 `>, <, =, >=, <=` |
| `alarm_condition_list[].db_switch` | integer | necessarily | 分贝告警开关 `0` off `1` on |
| `alarm_condition_list[].dominant_freq_thr` | integer | necessarily | 主频告警值（**范围/单位未说明**） |
| `alarm_condition_list[].df_arithmetic_operator` | integer | necessarily | 主频算术运算符 `(0-4)` 对应 `>, <, =, >=, <=` |
| `alarm_condition_list[].df_switch` | integer | necessarily | 主频开关 `0` off `1` on |
| `alarm_condition_list[].df_logical_operator` | integer | necessarily | 主频逻辑运算符 `0`=`||`，`1`=`&&` |
| `alarm_condition_list[].noise_comparison_file_id` | integer | necessarily | 噪声比对文件 id |
| `alarm_condition_list[].noise_comparison_thr` | number | necessarily | 噪声相似度 `0-1` |
| `alarm_condition_list[].nc_switch` | integer | necessarily | 噪声比对开关 `0` off `1` on |
| `alarm_condition_list[].nc_logical_operator` | integer | necessarily | 噪声比对逻辑运算符 `0`=`||`，`1`=`&&` |
| `alarm_condition_list[].nc_arithmetic_operator` | integer | necessarily | 噪声比对算术运算符 `>`、`<` |
| `alarm_condition_list[].Notes` | string | necessarily | 备注（**大写 `Notes`**） |
| `page_total` | integer | necessarily | 总页数 |

**缺口**：`decibel_thr` 的合法区间、`dominant_freq_thr` 的单位（Hz 还是 kHz）与区间
——手册在 §4.3.1 / §5.1.3 明文给了频率"2~65KHz"的约束，但**没有说明 `dominant_freq_thr` 用哪个单位**。
`nc_arithmetic_operator` 只写了 `>`、`<` 两个符号却未给数字枚举（对比 `db_arithmetic_operator` 给了 `0-4`）→ §6。
本节**无返回示例 JSON**。

### 5.1.27 `POST /alarm_condition` — 新增告警条件

- 请求体：有。
- 手册注意事项（原文，**编号从 2 跳到 4，缺 3**）：
  1. 一个告警条件对应绑定一个策略，策略是检测单元；
  2. 告警策略的逻辑条件包括声压级告警、主频告警、频谱比对，可按需自由组合；
  4. **声压级阈值告警**：以声压级阈值判断，检测到的声压级与你设定的值匹配时触发，可调运算符与阈值；
  5. **主频阈值告警**：判断环境检测的主频阈值，匹配时触发，可调运算符与主频值；
  6. **频谱比对告警**：与目标文件的频谱图比对差异，相似度匹配你设定的值时触发，可调运算符与相似度；
  7. **告警条件如下：对应的开关使能对应字段才生效**（switch 未开的字段无效）；
  8. 比对文件见"比对文件新增接口"（即 §5.1.30）。

| 键 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `name` | string | necessarily | 名称，`1~20` 字符。例：`"Condition 1"` |
| `decibel_thr` | integer | necessarily | dB 告警值 |
| `db_arithmetic_operator` | integer | necessarily | `(0-4)` → `>, <, =, >=, <=` |
| `db_switch` | integer | necessarily | `0` off `1` on |
| `dominant_freq_thr` | integer | necessarily | 主频告警值 |
| `df_arithmetic_operator` | integer | necessarily | `(0-4)` → `>, <, =, >=, <=` |
| `df_switch` | integer | necessarily | `0` off `1` on |
| `df_logical_operator` | integer | necessarily | `0`=`||`，`1`=`&&` |
| `noise_comparison_file_id` | integer | necessarily | 噪声比对文件 |
| `noise_comparison_thr` | number | necessarily | 噪声相似度 `0-1` |
| `nc_switch` | integer | necessarily | `0` off `1` on |
| `nc_logical_operator` | integer | necessarily | `0`=`||`，`1`=`&&` |
| `nc_arithmetic_operator` | integer | necessarily | **`0` 表示 `>`，`1` 表示 `<`**（此处给了枚举） |
| `discharge_switch` | **string**（手册类型） | necessarily | 放电开关 `0` off `1` on（**类型标 string，值是 0/1，矛盾**） |
| `discharge_logical_operator` | integer | necessarily | 逻辑运算符 `0 || 1 &&` |
| `discharge_type` | integer | necessarily | 放电类型：`0` 电晕(corona)、`1` 悬浮(suspension)、`2` 沿面(along the surface)、`4` 放电(discharge)（**缺 `3`**） |
| `notes` | string | necessarily | 备注 |

**返回**：`ret`（integer）、`msg`（String）。

**缺口（重点）**：
- `discharge_*` 三个字段在 §4.4 的 UI 描述里**完全没有出现**（§4.4 只提"decibel alarm / main frequency alarm / spectrum comparison"），
  而 §5.1.26 的读取字段表里也**没有** `discharge_*`。即：**写入有、读取无** → 不对称，列入 §6。
- `discharge_type` 枚举缺 `3`，`discharge_switch` 类型标 string。
- §4.4 提到的 "Detection cycle 1–30 秒" 与 "Sensitivity" 是**策略**字段而非条件字段，此处正确未出现。
- **本节没有请求示例 JSON**；新建成功后如何拿到条件 `id` 未说明。

### 5.1.28 `PUT /alarm_condition` — 修改告警条件

- 请求体：有。
- **注意事项（原文）：`The conditions for binding an enabled policy cannot be modified.`（被已启用策略绑定的条件不能修改。）**

字段列表与 §5.1.27 **相同**（含 `discharge_switch`、`discharge_logical_operator`、`discharge_type`、`notes`）。

**返回**：`ret`（integer）、`msg`（String）。

**缺口（重点）**：
- **请求字段表里没有 `id`** —— 无法得知要修改哪一条条件。对比 §5.1.25 `PUT /alarm_strategy` 明确带 `id`。
  这是本规格中最严重的"无法实现"缺口之一 → §6。
- 没有请求示例；修改失败的返回码未说明。

### 5.1.29 `DELETE /alarm_condition` — 删除告警条件

- 请求体：有。

| 参数 | 手册类型 | 说明 |
|---|---|---|
| （手册未给字段名） | `integer []` / arrays | 待删除的告警条件 id 数组。示例：`[1,2]` |

**返回**：

| 键 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `ret` | integer | necessarily | **`-1`：删除失败，当前条件被策略绑定，不能删除** |
| `msg` | String | necessarily | 返回信息 |

**缺口**：请求字段名同样缺失（与 §5.1.24 一样）。

### 5.1.30 `POST /upload_nc` — 上传噪声比对文件

- 请求方法/路径：`POST /upload_nc`，`http://localhost/upload_nc`
- 注意事项（原文）：
  - **一个告警条件只能绑定一个比对文件**；
  - **比对文件是系统生成的 bin 文件**。

| 请求头 | 值 | 必需 |
|---|---|---|
| `Content-Type` | `multipart/form-data` | 是（手册 `compulsory` 列写 `be`） |

| 表单字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `nc_file` | file | 是 | 比对文件 |
| `notes` | text | 是 | 备注 |

**手册原文 multipart 片段**：

```
{ Content-Disposition:form-data;name="nc_file";filename="mic_data_2019_06_22_23_26_47_953.bin"
Content-Type: application/octet-stream
}
```

**返回参数**（手册表格中 `default value`、`note`、`Other information` 三列均为空）：

| 键 | 类型 | 必需 |
|---|---|---|
| `ret` | integer | necessarily |
| `msg` | string | necessarily |

**缺口**：
- **返回的 `ret`/`msg` 具体取值、是否回传新文件 id 均未说明** → 下游无法直接拿到 `noise_comparison_file_id`。
- 文件大小上限、采样率要求、`samplerate` 是否来自 bin 文件头 —— 手册未说明。
- 上传成功的 HTTP 状态码未说明。

### 5.1.31 `GET /nc_filelist` — 获取比对文件列表

| Query 参数 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `page` | integer | necessarily | 请求页码 |

| 键 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `nc_file_list` | object[] | necessarily | 样本文件列表，**默认 10**（每页 10 条） |
| `nc_file_list[].id` | integer | necessarily | 文件 id |
| `nc_file_list[].file_name` | string | necessarily | 文件名 |
| `nc_file_list[].file_size` | integer | necessarily | 文件大小（**单位未说明**） |
| `nc_file_list[].samplerate` | integer | necessarily | 采样率（**单位未说明**） |
| `nc_file_list[].Duration` | integer | necessarily | 时长（**大写 `Duration`，单位未说明**） |
| `nc_file_list[].Notes` | string | necessarily | 备注（**大写 `Notes`**） |
| `page_total` | integer | necessarily | 总页数 |

**缺口**：本节**无返回示例 JSON**；`file_size` / `samplerate` / `Duration` 单位均未说明。

### 5.1.32 `DELETE /nc_file` — 删除比对文件

- 路径：`DELETE /nc_file`，`http://localhost/nc_file`
- 功能描述行原文误写为 `Function Delete an alarm condition.`（**复制粘贴错误**，实际是删除比对文件）。

| 参数 | 手册类型 | 说明 |
|---|---|---|
| （手册未给字段名） | `integer []` / arrays | 待删除的比对文件 id 数组。示例：`[1,2]` |

**返回**：

| 键 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `ret` | integer | necessarily | **`-1`：删除失败，当前条件被策略绑定，不能删除** |
| `msg` | String | necessarily | 返回信息 |

**缺口**：请求字段名缺失；"被策略绑定不能删除"这句话在比对文件上是否成立（应为"被条件绑定"）语义可疑 → §6。

---

## 5. WebSocket 接口（§5.2.1 – §5.2.5）

### 5.0 公共约定（§5.2 引言，原文）

> `In order to ensure real-time data transmission, device parameters are obtained using Websocket protocol on port 80.`
> `device parameters are obtained according to a customized communication protocol after the connection is established.`
> `Request Format ws://localhost:port`
> `Heartbeat mode is set to ensure a correct and secure websocket connection. After connecting to the device's websocket server, all clients in normal use are required to send arbitrary messages (with unlimited content) to the server every minute to ensure that the connection is not interrupted. Otherwise, the server will determine that the client is not in use and forcibly interrupt the connection.`

要点：

| 项 | 值 |
|---|---|
| 协议 | **`ws://`**（**明写 `ws://`，全篇无 `wss://` / TLS 说明**） |
| 端口 | 正文说 `port 80`；URL 写 `ws://localhost:port`（占位符 `port`）。**默认端口应以 80 为准**，但手册未把 `port` 与 `80` 明确绑定 |
| 认证 | **手册完全未说明**。§5.1.1 只说"all subsequent interfaces"需要 `Authorization` 头——WebSocket 握手是否算"subsequent interface"、token 放 header 还是 URL query，**均未说明** |
| 订阅/启动消息 | **未说明**。所有 5 个接口都是"连接后设备主动推送"，手册**没有要求客户端发送任何 subscribe/start JSON** |
| 心跳 | **必须每分钟至少发一条任意内容的消息**，否则服务端判定客户端空闲并强制断开。内容不限，**未规定格式**（不是标准 ping/pong 帧） |
| 文本/二进制 | 各接口分别说明（见下），无统一约定 |
| 推送频率 | 各接口分别说明 |

### 5.2.1 `ws://<host>:<port>/fftData` — 获取 FFT 数据

| 项 | 值 |
|---|---|
| 路径 | `/fftData`（**camelCase，注意大小写**） |
| 推送频率 | **平均每秒 5 次**（`on average five times per second`） |
| 帧类型 | **二进制流**（binary） |
| 数据格式 | **16-bit int** 二进制流；"the first half of the FFT, the length of 512"——即**取 FFT 前半段，长度 512** |
| 解析方式 | 按字节序（byte order）解析 |
| 订阅消息 | 无需（手册未要求） |

**缺口**：
- **字节序（大端/小端）未说明** —— "parse in byte order" 不足以确定。
- **512 是"每帧 512 个采样点"还是"字节长度 512"未说明**（若为 16-bit 且 512 点，则单帧应 1024 字节）。
- **FFT 的频率范围/分辨率、是否含幅度单位（dBFS？Pa？）未说明**。
- 是否满帧、丢帧如何处理未说明。

### 5.2.2 `ws://<host>:<port>/voiceprintData` — 获取声纹图

| 项 | 值 |
|---|---|
| 路径 | `/voiceprintData` |
| 推送频率 | **平均每秒 1 帧**（`one frame of voiceprint image data per second on average`） |
| 帧类型 | **二进制流** |
| 数据格式 | **int 型二进制流**（`the return form is int-type binary stream`） |
| 解析方式 | 按字节序解析 |

**缺口（重点）**：
- **"int" 到底是 8/16/32 位、有无符号，未说明**（对比 §5.2.4 明确写了 "32-bit int"、§5.2.1 明确写了 "16-bit int"，此处只说 int）。
- **图像宽度、高度、通道数、像素格式（灰度？RGB？伪彩？）、每帧是否带帧头全部未说明** → 这正是"需要插图才能确定"的典型，图上可能画了排布，但源文本无图。
- 每秒 1 帧是否为滚动的时频图（时间×频率）未说明。

### 5.2.3 `ws://<host>:<port>/detectFeedback` — 获取检测结果

| 项 | 值 |
|---|---|
| 路径 | `/detectFeedback` |
| 触发时机 | **每次检测结束后推送一包结果** |
| 帧类型 | **JSON 字符串**（`in the form of JSON strings`），但手册又说 "parsed in byte order" |
| 订阅消息 | 无需 |

**手册原文示例**（结构与 §5.1.17 相同，但**正确地带了 `detect_log` 外层包装**；首行同样多一个 `{`）：

```
{
 "detect_log": {
	 "bin_mic_data_name": "mic_data_2019_06_20_20_30_39_940.bin", {
	"data_1": 0.0,
	"data_2": -1.0,
	"data_3": 0.0,
	"data_4": 0.0,
	"detect_mode": 2,
	"end_time": 1561033842,
	"files_status": 1,
	"id": 7.
	"power_spect_photo_name": "power_spectrum_2019_06_20_20_30_39_940.jpg",
	"power_spect_video_name": "power_spectrum_2019_06_20_20_30_39_940.mp4",
	"saving_path": "2019_06_20_20_30_39_940/",
	"soundmap_intensity": 20.4,
	"soundmap_photo_name": "sound_2019_06_20_20_30_39_940.jpg",
	"soundmap_video_name": "sound_2019_06_20_20_30_39_940.mp4",
	"start_time": 1561033839.
	"status": 1.
	"voiceprint_photo_name": "voiceprint_2019_06_20_20_30_39_940.jpg",
	"voiceprint_video_name": "voiceprint_2019_06_20_20_30_39_940.mp4",
	"wav_mic_data_name": "mic_data_2019_06_20_20_30_39_940.wav"
 },
 "msg": "SUCCESS",
 "ret": 200
 }
```

**规范化示例**：

```json
{
  "detect_log": {
    "bin_mic_data_name": "mic_data_2019_06_20_20_30_39_940.bin",
    "data_1": 0.0, "data_2": -1.0, "data_3": 0.0, "data_4": 0.0,
    "detect_mode": 2, "end_time": 1561033842, "files_status": 1,
    "id": 7,
    "power_spect_photo_name": "power_spectrum_2019_06_20_20_30_39_940.jpg",
    "power_spect_video_name": "power_spectrum_2019_06_20_20_30_39_940.mp4",
    "saving_path": "2019_06_20_20_30_39_940/",
    "soundmap_intensity": 20.4,
    "soundmap_photo_name": "sound_2019_06_20_20_30_39_940.jpg",
    "soundmap_video_name": "sound_2019_06_20_20_30_39_940.mp4",
    "start_time": 1561033839, "status": 1,
    "voiceprint_photo_name": "voiceprint_2019_06_20_20_30_39_940.jpg",
    "voiceprint_video_name": "voiceprint_2019_06_20_20_30_39_940.mp4",
    "wav_mic_data_name": "mic_data_2019_06_20_20_30_39_940.wav"
  },
  "msg": "SUCCESS",
  "ret": 200
}
```

**外层与字段**：

| 键 | 类型 | 说明 |
|---|---|---|
| `detect_log` | object | 本次检测结果（**注意键名是单数 `detect_log`，而 §5.1.17 的字段表写 `detect_logs`**） |
| `msg` / `ret` | String / integer | 返回信息 / 返回码 |

`detect_log` 内字段与 §5.1.17 的字段表**完全一致**，但 §5.2.3 的字段表把 `data_1` 的说明写作 **`spill`**（§5.1.17 写 `Leak volume`）。
两处字段表都列了 `alarm_strategy_id`、`alarm_level`、`nc_file`、`last_alarm_db`、`last_alarm_df`、`last_alarm_nc`、`is_alarm`、`nc_file_path`、`nc_file_fft_photo_name`，
**而两处的示例 JSON 里都没有这些字段**。

**缺口**：
- 事务性：一次检测是否恰好一包、异常时是否推 `ret != 200`、多策略巡航时是否连续推送多包 → 手册未说明。
- 帧实际是 WebSocket **文本帧**还是**二进制帧**（"JSON strings" vs "parsed in byte order" 矛盾）→ §6。

### 5.2.4 `ws://<host>:<port>/energyData` — 获取异音点信息

| 项 | 值 |
|---|---|
| 路径 | `/energyData` |
| 触发时机 | **定期返回**（`regularly`，具体周期未说明） |
| 帧类型 | **二进制流** |
| 数据格式 | **32-bit int** 二进制流；按字节序解析 |
| 订阅消息 | 无需 |

**数据排布（手册原文明确给出）**：

> `Transmit several groups of target point information according to the number of targets set at present, the target point information is arranged in order, if the number of targets is 3, the information is arranged as follows: [ [target 1 information], [target 2 information], [target 3 information]], and the data in each group of information is arranged as follows: [energy, pixel transverse coordinate, pixel longitudinal coordinate, swath angle, azimuth angle].`

即：每组目标点 = **5 个 32-bit int**，顺序为：

| 序号 | 含义 | 单位 |
|---|---|---|
| 1 | `energy` 能量 | 手册未说明 |
| 2 | `pixel transverse coordinate` 像素横坐标 | 像素 |
| 3 | `pixel longitudinal coordinate` 像素纵坐标 | 像素 |
| 4 | `swath angle` 扫描角 | 手册未说明（度？） |
| 5 | `azimuth angle` 方位角 | 手册未说明（度？） |

- 组数 = **当前设置的目标数量**（对应 §5.1.5 的 `target_numbe`，最多 3）。

**缺口**：推送周期未说明；`energy` 的标度/单位未说明；两个角度的单位与符号约定未说明；
坐标是否与 §5.1.12 的 `left_top_x/left_top_y` 同一坐标系未说明；**32-bit int 的字节序未说明**。

### 5.2.5 `ws://<host>:<port>/pcmData` — 获取实时音频数据

| 项 | 值 |
|---|---|
| 路径 | `/pcmData` |
| 触发时机 | **每秒返回一次**（`every second`） |
| 帧类型 | **二进制流** |
| 数据格式 | **float32** 二进制流 |
| 采样率 | **48 KHz（48000）** ← 手册明确给出 |
| 解析方式 | 按字节序解析 |

**缺口（重点）**：
- **声道数未说明**（单声道？128 麦阵列的多通道？）。
- **每帧采样点数未说明**（"每秒 1 次"与"48000 采样率"不能推出单帧长度，除非假定 1 秒整）。
- **float32 的字节序未说明**（小端/大端）。
- 归一化范围（`[-1,1]` 还是原始声压）未说明。
- 是否需要 `Content-Type`/子协议（subprotocol）未说明。
- 该接口是本手册 `V6.2 (2025.02.19)` 修订项"New real-time audio acquisition interface"。

---

### 5.3 【实测】五路 WebSocket 的真实行为（2026-09-15）

> **本节不是手册内容，是对一台真机的测量记录。**设备：`192.168.110.235`，HTTP 端口 80，
> 账号 `admin`，口令线上形式 `md5(明文 + 'lfxs')`。测量方式：对每一路单独开一个
> WebSocket，6 秒窗口内统计到达帧数与总字节数，并打印每帧长度分布与前 16 字节。
> 只做连接与读取，**未对设备写入任何配置**。

#### 5.3.1 帧率与帧长

| 通道 | 手册声明 | 实测帧率 | 实测帧长 | 实测字节/秒 | 与手册/mock 的差别 |
|---|---|---|---|---|---|
| `/fftData` | 5 次/秒 | **10.06 帧/秒** | **2052 B（全部 59 帧恒定）** | ≈20 643 | 手册的 "length of 512" 与"每秒 5 次"都不成立 |
| `/voiceprintData` | 1 帧/秒 | **10.07 帧/秒** | **约 45 200 B，逐帧变化（44 853–45 460）** | ≈452 000 | 帧长不固定 → 是**压缩图像**，不是定长矩阵 |
| `/energyData` | "regularly" | **29.92 帧/秒** | **20 B（全部 179 帧恒定）** | ≈598 | 手册未给频率；实测接近 30 Hz |
| `/pcmData` | 1 次/秒 | **10.00 帧/秒** | **19 200 B（全部 60 帧恒定）** | 192 000 | "每秒 1 次"不成立；总字节率恰好也是 192000 B/s |
| `/detectFeedback` | 每次检测结束一包 | **6 秒内 0 帧** | — | — | 事件流，窗口内没有检测完成，因此**未能实测帧类型** |

#### 5.3.2 帧内容（每帧前 16 字节，十六进制）

| 通道 | 首 16 字节 | 判读 |
|---|---|---|
| `/fftData` | `00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00` | 前 4 字节在 40 帧连续采样中**恒为 0**（按 u32 大小端读都是 0，不是计数器/时间戳）；其余是数据 |
| `/voiceprintData` | `ff d8 ff e0 00 10 4a 46 49 46 00 01 01 00 00 01` | **JPEG**：`FFD8` = SOI，`FFE0` = APP0，`"JFIF"` 明文可见 |
| `/energyData` | `10 00 00 00 7f 03 00 00 55 00 00 00 0e 00 00 00` | 小端 int32：`[16, 895, 85, 14, …]`，与手册"每组 5 个 32-bit int"一致 |
| `/pcmData` | `03 00 9e 38 b3 aa 89 37 f9 ff 1f 38 03 00 16 38` | float32 小端：`[7.5e-5, 1.6e-5, 3.8e-5, 3.6e-5, …]`，量级为 1e-4 的音频 |
| `/detectFeedback` | — | 窗口内 0 帧 |

#### 5.3.3 由帧长推出的载荷布局（已落进客户端默认候选）

| 通道 | 推导 | 结论 |
|---|---|---|
| `/fftData` | 2052 = **4 + 1024 × 2** | 4 字节前缀 + **1024 个 int16**。手册说的 512 既不是点数也不是字节数 |
| `/voiceprintData` | `FF D8 FF E0 … JFIF`，SOF0 声明精度 8、**高 400、宽 600、3 分量**，采样因子 1:2×2 / 2:1×1 / 3:1×1（4:2:0 基线），帧尾 `FFD9` | **设备推的是它自己渲染好的 600×400 JPEG 图像**，不是"int 型"数值矩阵。按手册假设的 128×256×int32 矩阵应为恒定 131 072 B/帧，实测是浮动的 ~45 kB |
| `/energyData` | 20 = **5 × 4** | 5 个 int32；目标组数由帧长除 5 得到（实测每帧恰好 1 组） |
| `/pcmData` | 19200 = **4800 × 4** | **4800 个 float32**；10 帧/秒 × 4800 = **48 000 样本/秒**，与手册 §5.2.5 的 48 kHz 自洽；即**每帧 100 ms**，不是 1 秒 |
| `/detectFeedback` | 无帧 | 帧类型仍未证实；客户端两种帧（文本/二进制）都解 |

#### 5.3.4 握手认证（§8.4 D1 的实测答案）

对 `ws://192.168.110.235/fftData` 单独跑了四个候选，每个 6 秒窗口：

| 候选 | 结果（6 秒窗口） |
|---|---|
| 不带任何认证 | open → 无帧阶段 → **60 帧 / 123 120 字节** |
| `?token=` | **60 帧 / 123 120 字节** |
| `?Authorization=` | **60 帧 / 123 120 字节** |
| `?access_token=` | **60 帧 / 123 120 字节** |

四条**逐字节相同**，因此：**这台固件的 WebSocket 握手不需要认证**，客户端默认候选取
`none` 是正确且成本最低的选择。候选表仍然保留 `?Authorization=` 与 `?token=` 两条：
实测只覆盖这一台固件/这一批机器，"这一批不需要认证"不能当成"所有固件都不需要"。

#### 5.3.5 采样率接口缺失（影响频谱坐标轴）

`GET /get_samplingrate`（以及 `/system/settings`、`/system/info`、`/system/status`）在这台设备上
**不返回 JSON**：未匹配到 API 的路径一律回落为 Web 界面的 SPA HTML（`<div id="root">`）。
也就是说**这台相机没有任何可用的 HTTP 采样率接口**，客户端因此**不填** `binHz`，
界面把频谱横轴标成"谱线序号"并注明频率刻度未知——一个编造的 Hz 轴比没有轴更糟。

（手册 §5.1.2 `samplerate` 的合法值是 `96000` / `132000`，而任务描述中设备上报 `200000`；
两者不一致本身是 §8.3 C1 的一个新证据。本次测量无法独立复核该数值，故不据此换算。）

**未做到的事**（如实记录）：`/detectFeedback` 在窗口内没有收到任何一帧，因此**没有**证实它
是文本帧还是二进制帧；测量期间也没有触发一次真实检测。该项仍是"手册 + mock"的读法。

---

## 6. 设备默认值与用户模型

### 6.1 网络默认值

| 项 | 值 | 出处 |
|---|---|---|
| 默认 IP | **`192.168.2.168`** | §3.2 Note 与 §4.7.2 两处一致 |
| 默认网段要求 | 计算机须与设备同网段 | §3.2 |
| HTTP/Web UI 端口 | 手册未说明（URL 用裸 `http://localhost/...`，未出现 `:port`） | §5.1 |
| WebSocket 端口 | **正文写 `port 80`**；URL 写占位符 `ws://localhost:port` | §5.2 引言 |
| RTSP 端口 | `video_port` 字段，**示例值为 `443`** | §5.1.6 示例 |
| 数据 UDP/其它端口 | 手册未说明 | — |
| 数据链路 | Ethernet（§2.2 `Data transmission: Ethernet`） | §2.2 |

> 注意：RTSP 示例端口 `443` 是 HTTPS 惯用端口。手册**没有任何一处解释为什么 RTSP 用 443**，
> 也没说明该值是否只是样例。见 §7。

### 6.2 RTSP URL 格式

手册**没有给出完整的 RTSP URL 拼装规则**，只散落给了三个成分：

| 成分 | 来源 |
|---|---|
| `video_port` | §5.1.6 / §5.1.7，RTSP 服务端口，示例 `443` |
| `video_url` | §5.1.6 / §5.1.7，RTSP 服务 url，示例字符串 `"live"` |
| `rtsp_enabled` | `0` off / `1` on |
| `rtsp_client_limit` | `[1,6]`，**默认示例 `6`** |
| `rtsp_connected_num` | 当前连接数（只读） |

**推断的标准形式**（**手册未逐字给出，属于推断，实现前必须实测**）：

```
rtsp://<device-ip>:<video_port>/<video_url>
例：rtsp://192.168.2.168:443/live
```

**手册未说明**：
- 是否需要用户名/口令（`rtsp://user:pass@host:port/path`）；
- 是否支持 `wss`/`rtsps`（`video_port=443` 是否意味着 TLS）；
- 除 `live` 外是否还有其它 `video_url` 取值；
- 音视频轨道构成（是否有音频轨）；
- 编码（§4.3.3 只说"视频编码默认 H.264"，未说是否可改）。

**实测补充（2026-09-15，设备 `192.168.110.235`，服务端 ZLMediaKit git 7b1f8fe / 2025-05-02）**：

- 上表的推断形式**成立**：`rtsp://192.168.110.235:443/live` 可以直接读到画面（无凭据也能读）。
- 用「应用的真实参数」`-rtsp_transport tcp -i <url> -c:v copy -f mp4
  -movflags frag_keyframe+empty_moov+default_base_moof -t 3` 得到 **1 417 832 字节**、头部 `ftypiso5`、零错误。
- **陷阱**：给 RTSP 输入加 `-timeout`（或 `-stimeout`）会让本机这份 ffmpeg 构建进入 RTSP **listen** 模式并直接失败
  （`Unable to open RTSP for listening`）。不要为了"让错误地址早点失败"而加超时参数。
- `rtsp_enabled = 0` 是**设备侧开关**的事实，不等于本机不可达；两者都要以实测为准。
  详见 `docs/FA371-INTEGRATION.md` §7.1（含逐条命令行与字节数）。

### 6.3 用户管理（§4.7.4）—— 逐条对照

**手册 §4.7.4 全文只有两句**：

> `Click Change Password, users can change the login password and confirm it after change.`
> `Default account: admin (not modifiable) Password: 123456`

**§4.1 全文**：

> `The user name and password defaults are as follows:`
> `Default User Name: admin`
> `Default Password: 123456`

逐项结论：

| 问题 | 手册是否记载 | 原文 / 结论 |
|---|---|---|
| 默认账号 | ✅ | **`admin`**，且 **`(not modifiable)`——不可修改** |
| 默认口令 | ✅ | **`123456`** |
| 账号是否可改 | ✅ 明确不可改 | "Default account: admin (not modifiable)" |
| 口令是否可改 | ✅ | §4.7.4 "Click Change Password"（**仅 UI 路径**） |
| 是否存在"普通用户 / common user / normal user"角色 | ❌ **手册完全未提及** | 全篇只出现 `admin` 一个账号 |
| 是否存在多账号列表（新增/删除用户） | ❌ **手册完全未提及** | §4.7.4 只有"改密码"一句 |
| 角色/权限模型（RBAC） | ❌ **手册完全未提及** | — |
| 密码复杂度规则（长度/字符集/历史） | ❌ **手册完全未提及** | 源文本对 `password` 只说明派生算法，未说规则 |
| 密码找回 / 重置机制 | ❌ **手册完全未提及** | 无"忘记密码"、无邮箱/密保、无恢复码 |
| **"超级密码" / super password** | ❌ **手册完全未提及** | 全篇无 "super" 字样 |
| 恢复出厂后凭据是否回到默认 | ✅ | §4.7.6 `Restore`："IP, username password and other information will be reset to the default value and all historical data will be deleted" |
| 修改密码的 **HTTP 接口** | ❌ **§5 未提供** | 只有 UI；Open Interface 未开放改密接口 |
| 会话/并发登录限制 | ❌ 未提及 | — |

**重要结论**：本设备在手册范围内是**严格单账号模型**（唯一 `admin`，不可改名，仅可改密）。
如果本项目需要"普通用户"或"多用户"，那**必须靠本项目自己的账户体系实现，设备侧无对应概念**。
"超级密码"在本手册中**不存在**（不能假设有后门/维护口令）。

---

## 7. 告警模型（§4.4 + §5.1.22 – §5.1.29）

### 7.1 三层结构

```
告警条件 (alarm_condition)  ←1:1→  告警策略 (alarm_strategy)  →  被智能巡航模式周期性执行
        ↑                                    ↑
   绑定比对文件 (nc_file，最多 1 个)      携带 等级/周期/灵敏度/开关
```

- **一个策略只能关联一个告警条件**（§5.1.23 注意 1，通过 `alarm_id` 绑定）。
- **一个告警条件同一时间只能被一个策略绑定**——手册写的是"An alarm condition corresponds to binding a policy. A policy is a detection unit."
  （§5.1.27 注意 1），并在删除时给出 `ret: -1` 的"被策略绑定不能删除"（§5.1.29）。
  即**绑定关系是独占的**（手册措辞如此，但是否允许 1 个条件被 N 个策略引用，措辞不够明确 → §8）。
- 删除约束（手册明确给出 `ret = -1` 的三种业务失败）：
  - 策略已启用 → 不能修改（§5.1.25）；
  - 条件被已启用策略绑定 → 不能修改（§5.1.28）；
  - 条件被策略绑定 → 不能删除（§5.1.29）。

### 7.2 告警条件包含什么

三大类（§4.4 与 §5.1.23/27 一致）：

| 类型 | 手册英文名 | 阈值字段 | 开关字段 | 运算符字段 | 逻辑字段 |
|---|---|---|---|---|---|
| 声压级/分贝告警 | `decibel alarm` / `sound pressure level alarm` | `decibel_thr` (integer) | `db_switch` (0/1) | `db_arithmetic_operator` 0-4 → `>,<,=,>=,<=` | — |
| 主频告警 | `main frequency alarm` / `Main Frequency Threshold Alarm` | `dominant_freq_thr` (integer) | `df_switch` (0/1) | `df_arithmetic_operator` 0-4 → `>,<,=,>=,<=` | `df_logical_operator` 0=`||`,1=`&&` |
| 频谱比对 | `spectrum comparison` / `Spectrum Comparison Alert` | `noise_comparison_thr` (number, 0-1，相似度) | `nc_switch` (0/1) | `nc_arithmetic_operator` 0=`>`,1=`<` | `nc_logical_operator` 0=`||`,1=`&&` |

外加（**仅出现在写入接口 `POST`/`PUT /alarm_condition`，读取接口没有**）：

| 字段 | 类型 | 取值 |
|---|---|---|
| `discharge_switch` | 手册标 string | `0` off `1` on |
| `discharge_logical_operator` | integer | `0`=`||`，`1`=`&&` |
| `discharge_type` | integer | `0` 电晕 / `1` 悬浮 / `2` 沿面 / `4` 放电 |

- 比对文件通过 `noise_comparison_file_id` 关联（§5.1.30 上传得到）。
- **开关语义（关键）**：手册 §5.1.27 注意 7 —— `the corresponding switch enables the corresponding field to take effect`，
  即**开关为 0 的字段一律不参与判定**。这是实现告警逻辑时的核心规则。

### 7.3 告警策略包含什么

| 字段（写） | 字段（读） | 类型 | 单位/取值 | UI 名（§4.4） |
|---|---|---|---|---|
| `name` | `name` | string | 1~20 字符 | Strategy Name |
| `alias` | `alias` | string | 手册未说明 | （无对应，手册只写 nickname） |
| `alarm_id` | `alarm_condition_id` | integer | 关联条件 | Alarm conditions |
| `level` | `level` | integer | 写 `1,2,3,4`；读文档写 `0,1,2,3` | Alert Level |
| `interval_time` | `interval_time` | integer | 手册未说明范围 | （UI 未单独列出） |
| `times` | `Times` | integer | 手册未说明范围（"序号"） | （UI 未单独列出） |
| `timeout_duration` | `timeout_duration` | integer | **1~30 秒** | Detection cycle |
| `sensitivity` | `sensitivity` | number | **0-1** | Sensitivity |
| `diagosisn`（POST）/ `diagnosis`（PUT） | `diagnosis` | string | 备注 | Diagnostic Description |
| （无） | `Switch` | integer | `1` 开 `0` 关 | （UI 未列出开关，但巡航模式依赖它） |
| （无） | `alarm_condition_name` | string | 只读 | — |
| `id`（仅 PUT） | `id` | integer/string | 手册类型冲突 | — |

- 策略开关 `Switch` **只出现在读取接口**，写入接口没有对应字段 →
  **手册没有给出"启用/禁用策略"的接口**，而"启用"又是修改/删除的前置条件（§5.1.25/28），
  这是**告警模型的致命缺口**（见 §8）。
- §4.3.1 明确：**智能巡航模式**下，"the alarm policies that are set to be turned on will be detected automatically and cyclically"，
  即巡航只跑**已开启**的策略。

### 7.4 创建 / 修改 / 删除 / 启停 —— 端点对照

| 操作 | 端点 | 关键约束 |
|---|---|---|
| 获取策略 | `GET /alarm_strategy?page=` | 分页，`page_total` 返回总页数 |
| **新建**策略 | `POST /alarm_strategy` | 需 `alarm_id` 绑定已有条件；`level` 1-4；`timeout_duration` 1-30 |
| **修改**策略 | `PUT /alarm_strategy` | **已启用策略不可改**；失败返回 `ret=-1` |
| **删除**策略 | `DELETE /alarm_strategy` | body 为 id 数组（**字段名手册缺失**） |
| **启用/禁用**策略 | **手册无对应端点** | ❌ 见 §8 |
| 获取条件 | `GET /alarm_condition?page=` | 分页 |
| **新增**条件 | `POST /alarm_condition` | 开关未开的字段不生效 |
| **修改**条件 | `PUT /alarm_condition` | **被已启用策略绑定的条件不可改**；**请求无 `id` 字段** ❌ |
| **删除**条件 | `DELETE /alarm_condition` | 被策略绑定则 `ret=-1`；**字段名手册缺失** |
| 上传比对文件 | `POST /upload_nc` | `multipart/form-data`，字段 `nc_file` + `notes`；一个条件只能绑一个 |
| 列出比对文件 | `GET /nc_filelist?page=` | 每页默认 10 条 |
| 删除比对文件 | `DELETE /nc_file` | id 数组；**字段名手册缺失** |

---

## 8. UNDEFINED / AMBIGUOUS BEHAVIOUR（必测清单）

> 本节是交付物，不是免责声明。**所有条目在 Protocol Lab 实测前不得靠推断实现。**
> 分级：**P0** = 不实测就无法写出可运行代码；**P1** = 会导致行为错误或数据不一致；**P2** = 稳健性问题。

### 8.1 认证与会话（P0）

| # | 级别 | 未定义项 | 手册现状 |
|---|---|---|---|
| A1 | **P0** | `Authorization` 头的**值格式** | 只说"attach token to Authorization"，**是否需 `Bearer ` 前缀未说明**。本项目其它设备曾因加前缀被拒 |
| A2 | **P0** | 是否还需自定义头（如 `token: <token>`） | 未说明 |
| A3 | **P0** | 密码派生：拼接顺序是否 `明文 + "lfxs"` | 只写 `Password + lfxs MD5 encrypted ciphertext, 32 bit lowercase`，**无测试向量** |
| A4 | **P0** | `token` 与密码 MD5 是否同一值 | 称 token 是 "encrypted"，**算法未说明**；本项目其它设备实测 token == MD5(password+salt) |
| A5 | P1 | token 有效期 / 过期时间 / 刷新机制 | 完全未说明 |
| A6 | P1 | 401 的响应体、401 后是否必须重新登录 | 未说明 |
| A7 | P1 | 登录失败的 HTTP 状态码（401？200+ret？） | 未说明；`/login` 响应**没有 `ret`/`msg`** |
| A8 | P1 | 是否有登出/吊销接口 | §5 无 |
| A9 | P2 | 并发登录数、会话是否互踢 | 未说明 |
| A10 | P2 | §4.7.2 改 IP 后"sessions 自动断开"如何影响已发 token | 只说自动断开当前登录会话 |
| A11 | P2 | `Content-Type: application/JSON` 大小写是否敏感 | 手册全篇这么写；标准应为 `application/json` |

### 8.2 HTTP 通用（P0/P1）

| # | 级别 | 未定义项 |
|---|---|---|
| B1 | **P0** | **手册的 JSON 示例普遍损坏**（`.` 代替 `,`、逗号缺失、括号不配对、`}, }` 多余）。**无法从示例唯一确定真实报文**，全部需实测 |
| B2 | **P0** | 绝大多数 `PUT`/`POST` 接口**未给出成功响应体**（只有 `ret`/`msg` 的字段表，无示例、无具体 `ret` 值） |
| B3 | P1 | `ret`/`msg` 的**完整错误码集合**只在 4 处给出（`-1` 三种语义 + `200`），其余任何失败码未知 |
| B4 | P1 | 未定义任何 `page_size`/分页上限；`page` 越界行为未说明 |
| B5 | P1 | 时间戳的**单位与时区**（`sys_time`、`time`、`start_time`、`end_time`）全部未说明 |
| B6 | P1 | 并发/线程安全：多个客户端同时写配置是否冲突未说明 |
| B7 | P2 | HTTP 是否支持 HTTPS/TLS；是否有 CORS 头 | 未说明（RTSP 示例端口 443 让 TLS 问题更可疑） |

### 8.3 逐接口缺口（P0 标 **粗**）

| # | 级别 | 接口 | 缺口 |
|---|---|---|---|
| C1 | **P0** | `GET /system/acoustic` | 示例 `samplerate: 13200` 与合法值 `96000/132000` **量纲矛盾**（少一位）；字段说明"单位 KHz"与数值 96000 不自洽 |
| C2 | **P0** | `GET/PUT /system/image` | 字段表键 `target_numbe`（漏 `r`）vs 示例键 `target_number`；**`imaging_sensitivity`/`imaging_enhance` 在字段表有、示例无** —— 真实键名未知 |
| C3 | P1 | `GET /system/image`（PUT 同） | `energy_threshold` 取值范围/单位（dB？）未说明 |
| C4 | **P0** | `GET /system/video` | `video_url` 字段表标 **integer**、示例是**字符串** `"live"` |
| C5 | P1 | `PUT /system/video` | 请求字段表**未列 `rtsp_connected_num`**（只读？），但示例发了它；分辨率混搭是否被拒未说明 |
| C6 | P1 | `PUT /system/video` | 响应体未给出 |
| C7 | P1 | `GET /system/leakage` | 示例 `leakage_unit: 1` 配 `"l/min"`（应为 `ml/s`）、`monetary_unit: 1` 配 `"CNY"`（应为 GBP）—— **示例与枚举不一致，无法判断设备真实回显规则** |
| C8 | P1 | `GET/PUT /system/leakage` | `value_of_gas`/`energy_cost`/`specific_power`/`working_hours` 的取值范围与默认值未说明；两个 `*_str` 是否可写未说明 |
| C9 | **P0** | `GET/PUT /system/scan_area` | **坐标单位与参考系未知**（示例横轴到 1232、纵轴到 872，与 1920×1080 不吻合；两个接口的 `area_width/height` 还不一致：240×168 vs 768×432） |
| C10 | **P0** | `PUT /system/scan_area` | `areas` 数组长度上下限未知（示例 GET 给 5 组、PUT 给 1 组）；`center_focus=1` 时 `areas` 是否被忽略未知 |
| C11 | P1 | `POST /turn_on_detect` | `ret` 除 `200`/`-1` 外的码未知；巡航模式下 `detect_id` 是缺字段还是 `0` 未知 |
| C12 | P1 | `POST /turn_off_detect` | 响应状态码语义、重复调用、未检测时调用的行为未说明 |
| C13 | **P0** | `GET /detect_status` | 字段表类型写 `boolean`、取值是 `0/1`；**响应缺 `ret`/`msg`**（全组唯一） |
| C14 | **P0** | `GET /detect_logs` | "Query Param 传 `detect_id`" 与 "路径 `{detect_id}`" **自相矛盾**；字段表说返回 `detect_logs` **数组**，示例却是一个**裸对象** —— **传参方式已由 2026-09 的《API Workflow》文档解决：`detect_id` 是路径段（`GET /detect_logs/{detect_id}`）。返回形状（数组 vs 对象）仍未解决。见 `FA371-API-DELTA.md`** |
| C15 | **P0** | `GET /detect_logs` / `detectFeedback` | 字段表列了 `alarm_strategy_id`、`alarm_level`、`nc_file`、`last_alarm_db`、`last_alarm_df`、`last_alarm_nc`、`is_alarm`、`nc_file_path`、`nc_file_fft_photo_name`，**两处示例 JSON 里一个都没有** |
| C16 | P1 | `GET /detect_logs` | `files_status`（示例）vs `file_status`（字段表）拼写冲突；`start_time`/`end_time` 类型 string vs 示例整数；`soundmap_intensity` int vs 示例 `20.4` 浮点；`detect_mode: 2` 的枚举含义未说明 |
| C17 | P1 | `GET /detect_file/...` | 占位符命名 `{log.saving_path}` vs `{logs.file_name}` 不统一；`saving_path` 自带尾斜杠是否导致双斜杠；**下载是否需要 `Authorization` 头**未说明 |
| C18 | P1 | `DELETE /detect_logs` | 字段表 `id` 类型写 `string`、示例是数组 `[2,3]`；**示例缺右花括号**；响应体未给出 |
| C19 | **P0** | `GET /system_time` | `sys_time: 17220332` **只有 8 位**，既不是秒级也不是毫秒级 10/13 位 Unix 时间戳 —— 示例疑似截断，单位未说明 |
| C20 | P1 | `PUT /time_set_manually` | 路径与功能描述行给的 `http://localhost/system_time` **不一致**；写用 `time`、读用 `sys_time`，键名不对称；响应未给出 |
| C21 | **P0** | `GET /alarm_strategy` | 字段表 `id` 是 **string**，`PUT` 里 `id` 是 **integer**；`level` 读侧 `0,1,2,3` vs 写侧 `1,2,3,4` |
| C22 | **P0** | `POST /alarm_strategy` | 键名 **`diagosisn`**（`POST`）vs **`diagnosis`**（`PUT`/读取）—— 哪个是设备真实键名未知；**本节无请求示例**；成功后如何获得新策略 `id` 未说明 |
| C23 | P1 | `POST/PUT /alarm_strategy` | `times`（"序号"）语义与范围未说明；`interval_time` 范围未说明；`alias` 的规则/默认未说明 |
| C24 | **P0** | `DELETE /alarm_strategy` | **请求字段名缺失**（表格只给了类型 `integer[]`）—— 无法构造请求 |
| C25 | **P0** | `PUT /alarm_condition` | **请求字段表里没有 `id`** —— 无法指定修改哪一条条件（对比 `PUT /alarm_strategy` 有 `id`） |
| C26 | **P0** | `POST/PUT /alarm_condition` | `discharge_switch`/`discharge_logical_operator`/`discharge_type` **只出现在写入接口**，§5.1.26 读取字段表与 §4.4 UI 描述均无 —— 写读不对称；`discharge_switch` 类型标 **string** 但取值 `0/1` |
| C27 | P1 | `POST /alarm_condition` | `discharge_type` 枚举 **缺 `3`**（`0,1,2,4`）；注意事项编号 **从 2 跳到 4**（缺第 3 条） |
| C28 | P1 | `GET /alarm_condition` | `decibel_thr` 的合法区间未给；`dominant_freq_thr` **单位未给**（Hz / kHz？）；`nc_arithmetic_operator` 读取侧只写符号 `>`、`<`，**未给数字枚举**（写入侧给了 0/1） |
| C29 | **P0** | `DELETE /alarm_condition` | **请求字段名缺失** |
| C30 | **P0** | `DELETE /nc_file` | **请求字段名缺失**；功能描述行**误写为 "Delete an alarm condition"** |
| C31 | P1 | `POST /upload_nc` | **返回的 `ret`/`msg` 取值、是否回传新文件 id 未说明** —— 上传后拿不到 `noise_comparison_file_id`，无法给条件绑定比对文件；文件大小上限、bin 格式/采样率要求未说明 |
| C32 | P1 | `GET /nc_filelist` | `file_size`/`samplerate`/`Duration` **单位全部未说明**；`Duration` 与 `Notes` 大写首字母；本节无返回示例 |
| C33 | ~~P1~~ **已解决（结论有误）** | 全组 | ~~**告警策略的"启用/禁用"接口完全缺失**~~ —— **本条结论是错的**。2026-09 的《API Workflow》文档列出了 `GET /alarm_strategy_enable` 与 `PUT /alarm_strategy_enable`，且说明设备**同时只能启用一条策略**，启用顺序是"先停用当前那条，再启用目标那条"。当时的调查试过 `PUT /alarm_strategy {Switch:1}`：设备回 `ret:200` 但读回仍是 `switch:0`，于是被误判成"没有这个能力"。正确端点是 `/alarm_strategy_enable`。见 `FA371-API-DELTA.md` |
| C34 | P1 | 全组 | §5.1.18 / §5.1.19 / §5.1.24 / §5.1.29 / §5.1.32 等多处**示例 JSON 缺右花括号或完全缺失** |

### 8.4 WebSocket（P0）

| # | 级别 | 未定义项 |
|---|---|---|
| D1 | **P0** | **WebSocket 如何认证**：握手是否需要 `Authorization` 头、token 是否走 URL query（`?token=`）、未认证连接的拒绝方式 —— §5.2 全篇未说明 |
| D2 | **P0** | **二进制字节序（大端/小端）全部未说明**：`/fftData`(16-bit int)、`/voiceprintData`(int)、`/energyData`(32-bit int)、`/pcmData`(float32) 都只说"parse in byte order" |
| D3 | **P0** | `/fftData` 的 "length of 512" 是**采样点数**还是**字节数**未说明；FFT 频率分辨率/范围、幅度单位未说明 |
| D4 | **P0** | `/voiceprintData` 只说 "int-type"（**位宽未知**），**图像宽度/高度/通道/像素格式/是否有帧头全部未说明**（原图仅在插图中，源文本无图） |
| D5 | **P0** | `/pcmData` **声道数未说明**（单声道还是 128 通道）、**每帧采样点数未说明**、float32 归一化范围未说明；虽给出了 48 KHz 采样率 |
| D6 | P1 | `/energyData` 推送**周期未说明**；`energy` 单位/标度未说明；`swath angle`/`azimuth angle` 单位与符号约定未说明 |
| D7 | P1 | `/detectFeedback` 帧类型矛盾：说是 "JSON strings" 又说 "parsed in byte order" —— **文本帧还是二进制帧未知**；一次检测是否恰好一包、多策略时是否连推多包未说明 |
| D8 | P1 | 心跳：要求"每分钟发任意消息"，但**未规定内容/帧类型**；服务端判定超时的具体阈值（60s？）未说明；未说明客户端是否需回应服务端的 ping |
| D9 | P1 | `port` 占位符：正文说 `port 80`，URL 写 `ws://localhost:port`，**是否与 HTTP 同端口未明确绑定**；是否支持 `wss://` 未说明 |
| D10 | P2 | 是否需子协议（`Sec-WebSocket-Protocol`）；连接数上限；断线重连策略未说明 |
| D11 | P2 | `/detectFeedback` 中的 `detect_log` 与 `GET /detect_logs` 的关系（增量推送 vs 全量）未说明；`detect_log`（单数）vs `detect_logs`（字段表）键名冲突 |

### 8.5 设备默认值 / RTSP / 用户模型（P0/P1）

| # | 级别 | 未定义项 |
|---|---|---|
| E1 | P1 | **HTTP 端口未说明**（URL 用裸 `localhost`）；HTTPS 支持未知 |
| E2 | **P0** | **RTSP URL 拼装规则未逐字给出**，只能从 `video_port` + `video_url` 推断为 `rtsp://<ip>:<port>/<video_url>`；**是否需用户名口令未说明** |
| E3 | P1 | RTSP 示例端口 **`443`** 是否意味着 TLS（`rtsps`）未说明；`rtsp_client_limit` 默认值（示例 6）是否为出厂值未说明 |
| E4 | P1 | `video_url` 除 `"live"` 外是否有其它取值未说明；是否有音频轨未说明；编码是否可改为 H.265 未说明（§4.3.3 只说默认 H.264） |
| E5 | **P0** | **无"普通用户/普通账号"角色** —— 手册全篇只有 `admin`（且不可改名），无多账号列表、无角色权限模型 |
| E6 | **P0** | **无"超级密码"** —— 全篇无 super/master/recovery 类凭据。不得假设存在维护后门口令 |
| E7 | **P0** | **无密码找回/重置机制** —— 唯一的恢复途径是 §4.7.6 `Restore`（恢复出厂，**会删除全部历史数据**） |
| E8 | **P0** | **修改密码无 HTTP 接口** —— §4.7.4 只描述 UI 操作；Open Interface 未开放 |
| E9 | P1 | 密码复杂度规则（长度/字符集/是否禁弱口令）完全未说明 |
| E10 | P1 | 网络配置（改 IP/掩码/网关/DNS）**无 HTTP 接口**；升级、重启、恢复出厂、设备重命名、系统信息读取同样**只有 UI**，§5 未开放 |
| E11 | P1 | 数据保留策略：§4.5 说"只保留最近 **100** 次检测，超出则删除最早记录循环存储" —— 但**该上限是否可配、`DELETE /detect_logs` 是否影响循环计数未说明** |
| E12 | P2 | §4.7.5 "Timed Reboot"（定时重启）**无接口**，且手册未说明重启期间 HTTP/WS 的行为 |
| E13 | P2 | 设备自述版本混乱：正文 `V6.3` vs 修订表两条 `V6.2` vs 任务给定 `v6.2.4` —— **无法从手册确定当前固件版本**；`GET` 系统版本接口不存在，只能靠 UI 或 WebSocket 无 |
| E14 | P1 | §7 告警模型：**"一个条件是否可被多个策略引用"**措辞不清（§5.1.27 写"an alarm condition corresponds to binding a policy"，删除时又按"被绑定"整体拒绝） |

---

## 9. Protocol Lab 实测优先级建议

按"不测就写不出代码"排序（P0 子集，共 22 项）：

1. **A1/A2** `Authorization` 头确切格式（先试裸 token，再试 `Bearer `，再试 `token:` 自定义头）。
2. **A3/A4** 用已知明文验证 `MD5(明文 + "lfxs")`，并确认 `token` 是否等于该值。
3. **C2** `/system/image` 的真实键名：`target_numbe` 还是 `target_number`；`imaging_sensitivity`/`imaging_enhance` 是否存在。
4. **C4** `/system/video` 的 `video_url` 到底是 string 还是 integer。
5. **C9/C10** `/system/scan_area` 坐标系与 `areas` 长度上限（**必须抓真机 GET 响应**）。
6. **C13** `/system/detect_status` 是否真的没有 `ret`/`msg`。
7. **C14/C15/C16** `/detect_logs` 的真实返回形状（数组 vs 对象）与告警字段是否真的存在。
8. **C19** `/system_time` 时间戳真实位数与单位。
9. **C21/C22** `alarm_strategy` 的 `id` 类型、`level` 取值域、`diagosisn` 键名。
10. **C24/C29/C30** 三个 `DELETE` 接口的请求体形状（裸数组 vs `{"id":[...]}`）。
11. **C25** `PUT /alarm_condition` 如何指定目标条件（是否接受 `id`）。
12. ~~**C33** 策略启停：是否存在未文档化的开关接口（如 `PUT /alarm_strategy` 带 `Switch` 字段）。~~ **已由 2026-09 的《API Workflow》文档回答：端点是 `GET/PUT /alarm_strategy_enable`。** 仍需在真机上确认请求体形状与"同时只允许一条启用"这条限制。见 `FA371-API-DELTA.md`。
13. **C31** `POST /upload_nc` 的返回是否含新文件 id。
14. **D1** WebSocket 握手认证方式。→ **已实测（2026-09-15）：这台固件不需要认证**，
    见 §5.3.4。候选集保留，`none` 为默认。
15. **D2** 全部二进制接口的字节序。→ **未定论**：真机上大小端都能解出自洽数字，
    而手册未定义标度/单位，故仍沿用 mock 的 little，并在源码里如实标注为"未证实"。
16. **D3** `/fftData` 单帧长度（512 点 vs 512 字节）。→ **已实测：都不是**。
    实测 2052 B = 4 字节前缀 + **1024 个 int16**，见 §5.3.3。
17. **D4** `/voiceprintData` 图像尺寸与格式。→ **已实测：600×400 基线 JPEG（4:2:0）**，
    不是数值矩阵，见 §5.3.3。
18. **D5** `/pcmData` 声道数与每帧采样点数。→ **已实测：每帧 4800 点、10 帧/秒
    （= 100 ms/帧，48000 样本/秒）**；声道数仍按手册的 48 kHz 单声道读，未独立证实。
19. **D6** `/energyData` 推送周期与角度单位。→ **周期已实测：约 30 帧/秒**；
    角度单位仍未知（手册未定义，本软件不做换算）。
20. **D7** `/detectFeedback` 帧类型（text/binary）。→ **仍未证实**：6 秒窗口内 0 帧
    （事件流，无检测即无帧）。客户端两种帧都解。
21. **E2** RTSP URL 可播放性与是否需凭据。→ 本批实测中 RTSP 在任何端口都不可达，
    因此界面以五路 WebSocket 声学数据为主，见 `docs/FA371-INTEGRATION.md`。
22. **E8** 修改密码是否有未文档化接口（否则本项目自管凭据）。

---

*本文件由 `docs/reference/FA371-manual-en.txt` 抽取生成。ALL `手册未说明` 标记处均不得推断实现。
本文件未修改任何其它仓库文件。*
