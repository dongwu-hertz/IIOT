# AO01 气井泄漏监测装置：接入记录（2026-11-12 真机）

设备：`192.168.110.200`，账号 `admin / 123456`（实测可登录）。
固件：`dev_version v2.0.0.2025-11-04`，`web_version V1.1.0.2026-11-02`，
MAC `32:D4:35:DC:D2:F5`。

> 接口文档与固件有多处不一致；下面以**真机实测**为准。

## 1. 真机协议

| 项 | 接口文档 | 真机实测 |
|---|---|---|
| `/login` | `password = md5(明文 + 'lfxs')` | **明文密码**。传哈希返回 `{result:3,"Incorrect username or password.-2"}`；token 只认 `Authorization: <token>`，`token:` 头返回 `{"message":"Token is invalid","result":1}` |
| `/get_passageway` | 0–7 共 8 路 | **只有 2 路**（`chinfoSize:2`；ch1 启用，ch2 关闭） |
| `/get_samplingrate` | 48000/96000/192000 | 48000 |
| `/get_alarm_audio` | `alertArray` / `dal*` | 一致；`dalStartTime` 是**秒**、`dalDuration` 是**秒**；当前 43 条 |
| `/audio?alert_id` | `audioArray` | 一致；文件在 `dauFilePath`（如 `/mic/2026_11_06/`）+ `dauFileName` |
| 音频下载 | `/download_audio/<name>` | 实际是 `/download_audio/<dauFilePath 去掉前导斜杠>/<dauFileName>`；返回 HTTP 200 + RIFF/WAVE |
| `/detect_model` | `modelArray` | 3 个模型：default / default_20251015 / default_20251111 |
| `/get_alarm_system` | `alarmparaArray` | 2 个策略（default_strategy / 1015model） |
| `/auto_record` | 有 | 启用，间隔 0，单次 30 s |
| `/query_detect` `/run_detect` `/stop_detect` `/channel_select` `/get_cur_ch` | 文档有 | 当前固件返回 **405 / SPA HTML**，未实现；web bundle 里虽有调用，但设备上没有对应路由 |
| WebSocket `/features_stream` `/audio_stream` `/freq_domain` `/time_freq_domain` | 文档有 | 四个都能完成握手，但 **0 帧**。设备自己的 `/preview` 页面在 Chrome 里用 CDP 实测同样 0 帧；`system_log` 里 TORCH 模型仍在每 10 s 输出 `noise_val/leakage_val/airflow_val` |

## 2. 已接入（真机验证）

- **认证**：新增 `raw-auth-header-plaintext` 候选（明文口令 + `Authorization: <token>`）。
  AO01 自动识别为 `acousticBox`，无需新增 `DeviceKind`。
- **2 路通道**：`replaceForDevice()` 现在会删除设备未返回的多余通道；添加时 seed 的
  8 路被真机 2 路替换。真机添加结果：CH1 `ch1` 启用、CH2 `ch2` 关闭。
- **告警录音**：`alertArray` / `dal*` 映射进 `recordings`；再按 `dalId` 调
  `GET /audio?alert_id` 取文件名；播放/下载走 `/download_audio/<相对路径>`。
  - 真机 `syncDeviceRecordings()`：43 条，1.2 s 完成；
  - 单条 10 s WAV 下载成功（1,920,044 字节，RIFF/WAVE，可播放）。
- **回归测试**：
  - `tests/ao01-integration.test.ts`：自动识别 + 明文认证 + 2 路通道取代 8 路 seed；
  - `tests/ao01-alarm-mapping.test.ts`：`alertArray` / `dal*` / `/audio?alert_id` /
    `recordings` 行映射（含 `dalAbnoType=1` 不当作 SPL 位）。

## 3. 未接入 / 设备侧限制

- **实时监测没有数据**：四个 WebSocket 在设备自己的 web UI 里也不推帧。这是固件 /
  设备侧问题，不是本软件的接入问题；实时监测页会显示 2 路通道，但波形、频谱、时频图
  与四张指标卡会是空态，直到固件修复或提供别的实时接口。
- **「告警」页没有 AO01 泄漏事件**：AO01 的 `dalAbnoType` 是 0/1 事件标志，不是 AE08
  的 14 位故障位图；硬套会显示成错误的 SPL 告警。目前 43 条泄漏告警只进「录音/录像」
  页（可播放）。如果要在「告警」页显示「气体泄漏」类型，需要新增独立的 alarm
  source/type，而不是复用现有位图。
- **告警参数 / 检测模型 / 自动录音**没有 UI 映射；`/query_detect` 等当前固件不可用。
- `/system_log` 里的 `leakage_val` 不是正式 API，未接。

## 4. 下一步（可选）

1. 新增 `gasLeak` 告警类型/source，把 `alertArray` 同时写入 `alarms` 表并在「告警」页
   显示「气体泄漏」；
2. 若厂商提供实时泄漏值/模型输出的正式接口，再接实时卡片（当前只有日志里有）；
3. 告警参数页按 AO01 的 `alarmparaArray`（模型 + 灵敏度 + 录音）单独适配。
## 5. UI branch (2026-11-12)

- Live monitoring: AO01 now renders `GasLeakMonitorPanel` instead of the voiceprint
  four charts. The panel shows device status, leak alarm count, latest alarm, enabled
  channels, a sync button, and the local recording timeline. No features/audio WS is opened.
- Verified in the dev build: AO01 page showed 43 leak alarms and latest 11/6/26, with no
  "Stream error" and no empty "Waiting for..." charts.
- Overview video wall now stops sessions on leave but keeps every cell assignment; on
  return `resumeAssignedCells()` restarts them. Verified with .235 and .236: both cells
  survived navigation and were playing on return.
- The camera cell status badge title now carries the main-process diagnostic, so an
  error is explainable instead of only showing "Stream error".
