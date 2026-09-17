# FA371 真机探测记录：检测模式、策略启停与"升级"这一项到底有没有接口

本文件记录**一次只读探测**（外加两次可逆写入）的原始结果，用于回答产品需求
「对于声学相机来说，在软件上应支持修改检测模式，支持升级等功能」里那句
**"支持升级"** —— 设备到底有没有开放接口。

- 目标设备：`192.168.110.235:80`，账号 `admin`，口令 `123456`
  （线口令 `md5('123456' + 'lfxs')`，`POST /login` 返回 32 位 hex token，
  以**裸** `Authorization: <token>` 发送；实测三种携带方式里只有裸头发被接受）。
- 设备自报固件：`V0.5.1.6_251219`，SDK `v8.1.0`，Web 界面 `WEBV10.2.5`。
- 探测时间：2026-09-15。全部为 `GET`；唯一的状态改变是两次
  `/run_mode` 写入与两次 `/alarm_strategy_enable` 写入，**都已还原并复读验证**。
- **纪律**：没有发送任何固件字节，没有调用 `/upload`、`/reboot`，没有改任何配置。

## 1. 未知路径在这个设备上有**两种**失败形状（重要）

这一点决定了"探测结果怎么读"，所以先写：

| 路径 | 方法 | HTTP | 正文前若干字节 |
|---|---|---|---|
| `/system/upgrade` | GET | **404** | `<!DOCTYPE html> <html> <head> <title>404 Not Found</title> ...` |
| `/system/version` | GET | **404** | 同上（140 字节的 nginx 风格 404 页） |
| `/definitely_not_a_real_path_zz9` | GET | **200** | `<!doctype html><html lang="en"><head><meta charset="utf-8"/><link rel="icon" href="/favico...` |
| `/upgrade` | GET | **200** | 同上（339 字节的 SPA `index.html`） |
| `/detect_mode` | GET | **200** | 同上（SPA `index.html`） |
| `/get_devinfo` | GET | **200** | 同上（SPA `index.html`） |

即：**`/system/*` 命名空间由设备 API 处理，不认识的路径回真正的 404；
其它路径全部落到 SPA 的兜底路由，回 HTTP 200 + `index.html`。**
所以"200 且返回网页"= 路径不存在，"404" = 路径不存在（另一种写法），
两者都不能当成功。客户端 `fa371-api-client.call()` 里那段 HTML 守卫正是为此。

## 2. 任务清单里的候选路径（逐个实测）

| 路径 | 方法 | HTTP | 正文前若干字节 |
|---|---|---|---|
| `/system/upgrade` | GET | 404 | nginx 风格 404 页 |
| `/upgrade` | GET | 200 | SPA `index.html` |
| `/system/version` | GET | 404 | nginx 风格 404 页 |
| `/system/info` | GET | 404 | nginx 风格 404 页 |
| `/system/reboot` | GET | 404 | nginx 风格 404 页 |
| `/system/factory_reset` | GET | 404 | nginx 风格 404 页 |
| `/system/detect_mode` | GET | 404 | nginx 风格 404 页 |
| `/system/detect` | GET | **200** | `{"detect_count":1,"detect_duration":10,"detect_interval":0,"msg":"SUCCESS","ret":200}` |
| `/detect_mode` | GET | 200 | SPA `index.html` |
| `/reboot` | GET | 404 | nginx 风格 404 页 |
| `/system/detect_status`（对照，文档内接口） | GET | 200 | `{"detect_status":0,"msg":"SUCCESS","ret":200}` |

**两个意外发现**：

1. `/system/detect` **存在**且是只读的：它回的是检测参数
   （`detect_count` / `detect_duration` / `detect_interval`），**不含**运行模式。
   手册的 32 个接口里没有它。本功能没有用它（运行模式的权威来源仍是 `/run_mode`），
   记在这里是因为"手册没有"不等于"设备没有"。
2. `GET /system/detect_status` 在**本固件上带了 `ret`/`msg`** —— 旧手册把
   §5.1.16 写成"全组唯一没有 `ret`/`msg` 的接口"，实测不符。
   `Fa371DetectStatus.retPresent` 就是用来暴露这种差异的。

补充扫描（17 个更像"版本/升级"的名字，全部只读）：

`/system/version_info`、`/system/firmware`、`/system/update`、`/system/upgrade_status`、
`/system/device_info`、`/system/devinfo`、`/system/maintenance`、`/system/system_info`、
`/system/device`、`/system/run_mode`、`/system/detect_config`、`/system/detect_param`、
`/system/detect_setting`、`/system/backup`、`/system/log`、`/system/diagnose`
→ **一律 404**；`/get_devinfo` → 200 + SPA（不存在）。

> 结论的强度：在一个"不认识就回 404"的命名空间里，17 个额外候选全部 404，
> 加上旧手册第 180 行、旧缺口 E10、新手册 `api-workflow.txt` §Safety and Maintenance、
> `practical-guide.txt` 的排障表（"Firmware upgrades are performed under
> 'System Upgrade'"）三处文字证据 —— "升级/回滚/重启/恢复出厂**没有开放接口**"
> 这个结论是可信的。

## 3. 但设备自己的 Web 界面确实有升级 —— 用的是未公开接口

设备自带 Web 界面是一个 Vue SPA（`/static/js/main.2fe3455f.js`，2.26 MB）。
把它拉下来做静态分析（**只读 GET**）后，恢复出 66 个带引号的 API 路径，
其中与"维护"直接相关的：

| 界面调用的路径 | 方法（从 bundle 代码读出） | 用途 |
|---|---|---|
| `/upload` | **POST**，`Content-Type: multipart/form-data`，`timeout: 1800s`，带 `onUploadProgress` | 上传升级包 |
| `/reboot` | PUT（`en("/reboot", e)`） | 重启 |
| `/progress` | GET | 升级进度 |
| `/dev_info` | GET | 版本（`device_version`、`sdk_version`） |
| `/basic` | GET | 基础信息（`web_version`、`upgrade_time`、`dev_mac`、`dev_type`） |
| `/user`、`/network`、`/scheduled_restart`、`/self_inspection`、`/recovery` | GET/PUT | 用户管理、网络、定时重启、自检、恢复 |

界面文案里也确认了升级这条路：`SystemUpgrade`（系统升级）、
`AFirmwareVersion`（固件版本）、`PDTUuupgradepackage`（正在上传升级包文件，请勿断电）、
`Equipmentisbeingupgraded`（设备正在升级）。

**本软件当时不做 `POST /upload` / `PUT /reboot`**：它们未公开、改变设备状态，
而"传输固件包"这个动作的失败代价是把设备刷成砖。所以升级在界面上是
**禁用控件 + 原因（"升级在设备自带 Web 界面里做，本软件不代传固件包"）**，
旁边保留真实可用的「打开相机 Web 界面」入口。

> **⚠ 该决定后来被推翻**（负责人要求实现**设备自带 Web 界面那条 HTTP 路**）：
> 升级与重启已按 `POST /upload` + `PUT /reboot` + `GET /progress` 实装，见
> `FA371-API-DELTA.md` §18 与本文件 §8。上面那段描述的是**当时**的界面。
> 那条 HTTP 路依旧**没有在真机上调用过**（一次调用就是一次刷机），
> 所以界面上的措辞是"未见于设备手册"，而不是"受支持"。

### 只读实测（这两个接口被本软件真的用上了）

```
GET /dev_info -> HTTP 200
  {"device_version":"V0.5.1.6_251219","msg":"SUCCESS","ret":200,"sdk_version":"v8.1.0"}

GET /basic    -> HTTP 200
  {"basic_server_version":"TM.PD3.2637.ZXC.438e225.2026-09-14_week38.xsuser",
   "dev_mac":"70:19:88:a3:29:9e","dev_name":"FE128-ROBOT-PLUS001","dev_type":"FE128-ROBOT-PLUS",
   "dev_version":"TM.PD3.2637.ZXC.438e225.2026-09-14_week38.xsuser",
   "push_enable":0,"push_url":"","upgrade_time":"2026-09-14_06:56:47",
   "web_version":"WEBV10.2.5","msg":"SUCCESS","ret":200}

GET /progress -> HTTP 200
  {"msg":"SUCCESS","ret":200,"upgrade_progress":-2.0}
```

`upgrade_progress: -2.0` 的**含义没有文档**（界面在"设备正在升级"时才显示进度），
所以本软件**没有**实现进度显示：不知道量纲的数字不该渲染成一个进度条。
`/dev_info` 与 `/basic` 被 `camera-control-service.readMaintenance()` 用来填
"固件版本 / SDK 版本 / Web 界面版本 / 上次升级"。

## 4. `/run_mode`：写进去了，而且**真的**变了

可逆写入（写另一个模式 → 复读 → 写回原值 → 复读）：

| 步骤 | 请求 | 响应 |
|---|---|---|
| 读（before） | `GET /run_mode` | `{"msg":"SUCCESS","ret":200,"run_mode":1}` |
| 写 | `PUT /run_mode {"run_mode":-1}` | `{"msg":"SUCCESS","ret":200}` |
| 复读 | `GET /run_mode` | `{"msg":"SUCCESS","ret":200,"run_mode":-1}` |
| 还原 | `PUT /run_mode {"run_mode":1}` | `{"msg":"SUCCESS","ret":200}` |
| 复读 | `GET /run_mode` | `{"msg":"SUCCESS","ret":200,"run_mode":1}` |

**before = 1 → 写入 -1 → 复读 -1 → 还原 1 → 复读 1：已还原为原值。**

注意这与 `PUT /alarm_strategy {Switch:1}`（`ret:200` 却忽略）**不是**同一回事：
`/run_mode` 的写入是生效的。但"应答 200 却没生效"这个先例已经足够说明
**成功码不是证据**，所以服务的写方法一律"写后重读 + `applied`"。

## 5. `/alarm_strategy_enable`：策略启停是**真的**（旧结论 C33 是错的）

旧规格记的缺口 C33「告警策略的启停接口完全缺失」已被新手册证伪
（`api-workflow.txt` 第 129–134、340–346 行），更正记录见 `FA371-API-DELTA.md` §1。
发包形状来自设备自带 Web 界面：`{ switch: t ? 1 : 0, id: e.id }`。

真机可逆写入（探测前设备上**没有任何**策略启用，探测后也是）：

| 步骤 | 请求 | 响应 |
|---|---|---|
| 读（before） | `GET /alarm_strategy_enable` | `{"alarm_strategy_list":[],"msg":"SUCCESS","ret":200}` |
| 目标策略 | `GET /alarm_strategy?page=1` | `[{"id":1,"name":"策略一","switch":0}]`（另有 `timeout_duration:10`、`sensitivity:0.05`） |
| 启用 | `PUT /alarm_strategy_enable {"switch":1,"id":1}` | `{"msg":"SUCCESS","ret":200}` |
| 复读 | `GET /alarm_strategy_enable` | `{"alarm_strategy_list":[{ ... "id":1,"switch":1 ... }],"msg":"SUCCESS","ret":200}` |
| 还原 | `PUT /alarm_strategy_enable {"switch":0,"id":1}` | `{"msg":"SUCCESS","ret":200}` |
| 复读 | `GET /alarm_strategy_enable` | `{"alarm_strategy_list":[],"msg":"SUCCESS","ret":200}` |
| 检测状态 | `GET /system/detect_status`（前后各一次） | 两次都是 `{"detect_status":0,...}` |

**启用 → 复读确实变成 `switch:1` → 停用 → 复读回到空数组：已还原为原状态。**

`GET /alarm_strategy_enable` 的返回体与 `/alarm_strategy` 同形
（`alarm_strategy_list` 里是完整策略对象），所以映射直接复用
`mapAlarmStrategyPage`，不新增第二套映射。

## 6. 本软件据此做了什么、没做什么

做：

- `GET`/`PUT /run_mode` 的读、写（写后重读 + `applied`）；
- `POST /turn_on_detect` / `/turn_off_detect` + `GET /system/detect_status` 复读；
- `GET`/`PUT /alarm_strategy_enable`，启用时按手册顺序**先停用旧的、再启用新的**；
- `GET /dev_info` + `GET /basic` 的版本读取；
- 「打开相机 Web 界面」入口（升级的唯一可用路径）。

没做，并且理由写进能力表：

- ~~固件上传 / 回滚 / 重启 / 恢复出厂：开放接口没有，设备自用接口未公开且改变状态；~~
  **（本轮更新，见 §8：上传与重启已实装；回滚与恢复出厂仍然不做）**
- 升级进度：当时因为 `upgrade_progress` 的量纲与取值含义无文档而不显示；
  现在也只**原样显示设备给的值**，不换算成百分比（见 §8）；
- **应用模式**（局放 / 泄漏 / 机械异音）切换：那是产品版本能力，
  `practical-guide.txt` 第 60–61 行明说"出货只启用一种，需要另一种请联系技术支持"，
  软件里放一个这样的开关只能是假开关（`FA371-API-DELTA.md` §6）。

## 7. 未验证（本次没有做，也不该在共享设备上做）

- `POST /turn_on_detect` / `POST /turn_off_detect`：会真的让相机跑一个检测周期
  （本机策略周期 10 秒），且可能有人正在用这台相机，所以**没有**在真机上触发。
  `ret:-1`（没有可用策略）这条路径由单元测试用真实 `Fa371ApiClient` + 假传输层覆盖。
- `POST /upload`、`PUT /reboot` 的实际行为：只从 bundle 里读到调用形状，**没有调用**
  （`GET /progress` 是只读的，已在 §8 里补测）。
- 设备是否真的会在"已启用策略"时拒绝 `PUT /alarm_strategy`（手册与排障表都说会）：
  没有在真机上试过改已启用的策略。

## 8. 续探（本轮，仍然是只读）：`/progress` 与 `/reboot` 的两个形状

升级实装（见 `FA371-API-DELTA.md` §18）之后重新做了一次**只读**复核。两个形状值得
记下来，因为它们都能把人骗过去：

```
GET /progress（**未认证**） → HTTP **200** + {"msg":"No Auth","ret":401}
GET /progress（带 token）   → HTTP 200 + {"msg":"SUCCESS","ret":200,"upgrade_progress":-2.0}
GET /reboot                 → HTTP 404（nginx 风格 404 页，140 字节）
OPTIONS /reboot             → HTTP 204（没有 Allow 头）
```

1. **未认证的失败是"HTTP 200 + 正文里的 `ret:401`"**，不是 401 状态码。只看状态码的
   客户端会把"根本没认证"当成成功 —— 而在 `POST /upload` 那边，同一个形状意味着
   "以为传上去了、其实什么都没发生"。升级服务的判定因此有三层：非 2xx → 失败；
   正文是网页 → `INVALID_RESPONSE`；正文是 JSON 且 `ret ≠ 200` → 带设备 `msg` 的失败。
2. **`GET /reboot` 回 404 而不是 SPA 兜底**（对照 §1：不存在的路径回 200 + `index.html`）。
   这说明 `/reboot` 是设备 API 命名空间里的真实路径、只是不实现 GET ——
   与 bundle 里 `en('/reboot')` 是 PUT 相互印证。
3. **`upgrade_progress: -2.0` 依旧没有文档**。界面上它只是一个"设备返回 -2"的数字，
   外加一句"该数值的含义设备没有文档说明"。**要画成进度条，先得有厂商说明。**

本轮**没有**调用 `POST /upload`、也**没有**调用 `PUT /reboot`（它们会真的刷机 / 重启），
所以这两个接口的**实际行为**仍然未知 —— 这一点在交付说明里必须留着。
