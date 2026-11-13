# HAIS 声学监测平台 / Acoustic Monitoring System
## 使用说明书 / User Manual

文档版本 / Document version: 1.0  
软件版本 / Software version: 1.0.49  
发布日期 / Release date: 2026-11-13  
上海贺驰智能科技有限公司 / Shanghai Hertzinno Technology Co., Ltd.

<!-- pagebreak -->

# 目录 / Contents

## Part I  中文使用说明书

1. 快速开始
2. 系统概述
3. 登录与主界面
4. 总览与视频墙
5. 地图信息
6. 设备管理
7. 实时监测
8. 趋势分析
9. 告警中心
10. 事件中心
11. 录音管理
12. 设置与协议诊断
13. 常见问题与排障
14. 安全、维护与数据管理
15. 附录

## Part II  English User Manual

1. Quick Start
2. System Overview
3. Sign-in and Main Window
4. Overview and Video Wall
5. Map Information
6. Device Management
7. Live Monitoring
8. Trends
9. Alarm Center
10. Event Center
11. Recordings
12. Settings and Protocol Lab
13. Troubleshooting
14. Security, Maintenance and Data
15. Appendix

<!-- pagebreak -->

# Part I  中文使用说明书

## 1. 快速开始

本系统用于声学相机、声纹设备、空气声呐和气井泄漏监测设备的接入、实时监测、地图定位、告警管理和趋势分析。
首次使用建议按以下顺序完成配置。

1. 使用管理员或操作员账号登录系统。
2. 进入设备管理，添加设备并填写 IP 地址、端口、设备用户名和密码。
3. 在安装信息中填写或手动输入经纬度，并确认安装方位角。
4. 打开地图信息，确认设备点位、当前告警和历史告警。
5. 打开总览，为视频墙分配相机并保存显示布局。
6. 进入实时监测选择设备，查看实时视频、声学图和音频。
7. 在趋势分析中查询历史趋势；在告警中心处理告警。

> **注意：** 设备密码是设备本身的登录密码，不是本软件账号密码。若修改了设备密码，必须同步更新本软件中的设备凭据。

## 2. 系统概述

HAIS 是面向工业声学监测的桌面应用，支持设备管理、GIS 地图、视频墙、实时声学分析、告警录音、趋势查询和事件处置。

### 2.1 支持的设备类型

| 设备类型 | 主要能力 | 典型用途 |
|---|---|---|
| 声学相机 Acoustic Camera | 实时视频、频谱、声纹、SPL 趋势、告警抓拍 | 局放、泄漏等可视化声学检测 |
| 声纹设备 Acoustic Box | 多通道实时趋势、频谱、声纹、实时/录音回放 | 8 通道等振动与声纹监测 |
| 空气声呐 Air Sonar / SN-16 | 16 通道、GIS 指向范围、告警方向、SPL 趋势、PTZ 联动 | 声源方向定位与告警复核 |
| 气井泄漏监测 AO01 | 设备端泄漏检测、告警录音同步、告警历史 | 气井泄漏告警与录音取证 |
| 推送设备 Push Device | HTTP/MQTT 数据上报、遥测与告警接入 | 第三方设备接入 |

### 2.2 界面结构

- 左侧导航栏：地图信息、总览、设备管理、实时监测、趋势分析、告警中心、事件中心、录音、设置和协议诊断。
- 顶部栏：当前设备选择、刷新、系统消息/告警入口、用户信息。
- 页面主体：按业务页面显示地图、视频墙、表格、图表和详情。
- 弹窗/侧栏：用于设备编辑、告警详情、选点和设置。

> **注意：** 不同账户权限看到的菜单和操作可能不同。管理员拥有设备配置、用户管理和删除等更高权限。

## 3. 登录与主界面

### 3.1 登录

1. 启动 HAIS。
2. 输入系统账号和密码。
3. 点击登录。首次登录或密码被重置后，按系统要求修改密码。

登录成功后进入上次或默认页面。顶部栏会显示当前登录用户；点击用户区域可退出登录。

### 3.2 顶部栏与设备选择

- 设备下拉框：在实时监测、地图和趋势页面切换当前设备。
- 刷新按钮：重新读取当前页面数据。
- 告警/消息入口：查看未处理告警和系统消息。
- 用户菜单：账号信息、修改密码和退出登录。

### 3.3 左侧导航

从 v1.0.49 起，导航顺序为：地图信息 → 总览 → 设备管理 → 实时监测 → 趋势分析 → 告警中心 → 事件中心 → 录音 → 设置 → 协议诊断。

<!-- pagebreak -->

## 4. 总览与视频墙

总览页面用于集中查看多路相机视频，不显示设备状态和告警状态列表。

### 4.1 配置视频墙

1. 进入总览。
2. 选择 1 / 4 / 9 / 16 分屏档位。
3. 点击空白画面的加号，从相机列表选择设备。
4. 按需要切换每一格的显示方式：视频、1 秒时域图、频谱图或时频谱图。
5. 点击音量图标可设置该格声音；同一时间只允许一格出声。
6. 完成配置后系统自动保存档位、格子分配和视图类型。

### 4.2 自动播放

再次打开总览时，视频墙会自动恢复上次配置，并自动启动在线相机的实时视频。离线设备显示离线状态，不会伪造成正在播放。

### 4.3 常用操作

- 双击设备或点击格子可进入全屏。
- 右键画面可打开录像、抓图、显示方式和声音等菜单。
- 点击相机选择器可替换当前格设备。
- 相机工作状态由图标和状态文字表示；没有画面时不会显示黑矩形。

> **注意：** 切走页面会释放页面内的视频请求。重新打开总览时由视频墙自动恢复会话；不需要手工重新配置。

## 5. 地图信息

地图信息页是设备位置和告警态势的统一视图。页面上方是 GIS 地图，下方是当前告警、历史告警和设备列表。

### 5.1 地图操作

- 鼠标滚轮：缩放地图。
- 按住左键拖动：平移地图。
- 点击设备标记：选中并查看设备详情。
- 使用地图控制条放大、缩小、回到全设备视野或定位当前设备。
- 可在设置中启用在线瓦片，也可导入平面图并部署设备点位。

### 5.2 状态与告警

- 在线、离线、有未确认告警分别用不同颜色标记；告警优先于在线状态。
- 右上角状态栏显示设备数量、在线数量和未确认告警数量。
- 当前告警列表显示设备、通道和告警时间。
- 历史告警列表支持查看最近记录；设备列表显示 IP 和通道数。
- 点击告警行或设备行会将地图焦点定位到对应设备。

### 5.3 点位与设备详情

设备详情面板显示设备名称、状态、IP、通道数、点位坐标和安装方位。点击实时监测可进入该设备的实时页面。

> **注意：** 地图信息页不再显示视频墙；视频墙在总览页。

## 6. 设备管理

### 6.1 添加设备

1. 点击添加设备。
2. 选择设备类型和接入方式。
3. 填写设备名称、IP 地址、HTTP 端口和设备用户名/密码。
4. 点击探测/测试连接，确认设备可达且认证成功。
5. 填写或选择安装点位、方位角等安装信息。
6. 保存设备。

### 6.2 编辑与删除

在设备列表中点击编辑可修改名称、网络参数、设备凭据和安装信息；删除设备会移除本机配置和缓存，不会恢复设备端数据。

### 6.3 坐标录入

安装点位支持两种录入方式：

- 直接输入纬度、经度，适合已知精确坐标的场景。
- 点击在地图上选点，在弹窗中点击地图；弹窗也支持手动输入经纬度并点击定位，确认后回填。

### 6.4 设备详情

设备详情页显示设备信息、通道、告警参数、网络、时间、维护等页签。设备位置地图不再嵌入设备详情页；查看地图请使用地图信息页面。

### 6.5 关于 AUTH_FAILED

AUTH_FAILED 表示设备侧拒绝了登录凭据，不是当前软件账号登录失败。常见原因包括：设备密码被修改、设备账户被禁用、保存的凭据与设备不一致、设备返回 401/403。

1. 编辑该设备，重新输入设备用户名和密码。
2. 使用设备 Web 页面确认该账户可以正常登录。
3. 确认设备没有被其他客户端锁定或会话数已满。
4. 如设备仅在高负载时短暂不可用，应检查设备 HTTP 服务，而不是反复改密码。

> **注意：** 设备暂时超时、HTTP 503、接口返回异常等属于设备错误，不应与认证失败混为一谈。设备通道读取成功后，系统会清除以前残留的就地错误提示。

<!-- pagebreak -->

## 7. 实时监测

在顶部栏选择设备后进入实时监测。不同设备类型显示不同内容。

### 7.1 声学相机

- 实时视频与相机控制：播放/暂停、全屏、录像、抓图、检测区域和声音。
- 声纹图、频谱图和检测模式面板。
- 视频下方提供 SPL 趋势卡，显示最近 1 小时声压级变化。
- 可一键将当前相机添加到总览视频墙。
- 相机设置按钮位于页面顶部标题栏右侧。

### 7.2 声纹设备 Acoustic Box

- 实时趋势：SPL、主频、平稳度、频带能量比等指标。
- 通道切换：对多通道设备按通道查看。
- 频谱、声纹和音频/录音回放。
- 时间轴回放默认显示最近 1 小时，支持滚轮缩放、拖动平移、上一段/下一段。
- 播放器音量按钮弹出竖直音量滑条。

### 7.3 16 路空气声呐 Air Sonar

- 左侧 GIS 地图显示设备位置和 1 度指向性范围扇面；方向由最近告警方向加安装方位校准。
- Device 卡标题行提供音频通道选择、播放最近录音、拉取实时音频、同步告警录音。
- 最后一次告警横向显示日期、方向、告警类型，点击可进入告警中心详情。
- 历史告警支持日期筛选、每页 20/50/100/200 条、翻页；筛选和页大小改变后自动应用。
- 右侧告警详情显示选中告警的抓拍图、时间、方向、类型和录音。
- 页面底部提供 SPL 趋势。
- PTZ 卡可选择已登记相机并播放实时视频。

### 7.4 气井泄漏 AO01

- 地图占 70%，右侧泄漏检测卡占 30%，两者等高。
- 右侧显示累积告警、最近一次、启用通道和手动录音/同步入口。
- 地图不显示方位；地图和告警历史显示 CH 通道与气井名称。
- 告警历史支持自动同步、手动同步、播放、下载、删除、处理和标记。
- 告警下方保留时间轴回放。

> **注意：** AO01 不提供实时音频/频谱流。页面显示的是设备端检测结果和同步到本机的告警录音，不伪造实时波形。

## 8. 趋势分析

趋势分析页用于查询和比较历史声学指标。

### 8.1 查询步骤

1. 在顶部选择设备。
2. 选择时间范围或输入自定义起止时间。
3. 选择指标（如 SPL、主频、频带能量比等）和通道。
4. 图表自动刷新；可用缩放条或鼠标滚轮调整时间窗口。
5. 需要留存时点击导出 CSV。

### 8.2 设备能力

- 声纹设备支持多通道指标趋势。
- 声学相机支持 SPL、主频和频带能量比；SPL 无趋势存储时可由告警 SPL 补点。
- 16 路空气声呐支持 SPL 趋势，并按多通道处理。
- 不支持趋势的设备不会显示趋势内容。

> **注意：** 曲线中的断点表示该时间桶没有设备数据，不表示声压级为 0。

## 9. 告警中心

### 9.1 查询与筛选

可按设备、时间范围、告警类型、严重等级、确认状态和关键字筛选告警。列表显示时间、设备、通道、类型、SPL、方向和录音状态。

### 9.2 告警处理

- 播放录音：有本地录音时可直接播放。
- 下载录音：把录音另存到本机。
- 处理/确认：标记该告警已处理，可取消。
- 标记：给告警添加操作员备注。
- 等级：改判告警严重等级。
- 删除：永久删除选中的告警记录（需要管理员权限）。

### 9.3 详情与深链

点击告警行打开详情。实时监测页的最后一次告警带有深链，点击后自动筛选对应设备并打开该条告警详情。

> **注意：** 告警记录和录音是两类数据。删除告警记录不一定删除本机录音文件；录音文件请在录音管理中处理。

## 10. 事件中心

事件中心合并设备告警、联动事件和其他业务事件，用于跨设备统一查看和处置。可按时间、设备、状态和关键字筛选。

- 打开事件可查看来源、设备、时间、严重等级、证据和处理记录。
- 支持将关联告警归并为事件/事故并记录处置过程。
- 与告警中心的分工：告警中心面向单条声学告警，事件中心面向跨系统事件时间线。

## 11. 录音管理

录音管理列出本机已同步或手工保存的录音。

- 按设备和时间筛选录音。
- 点击播放，使用自定义播放器：播放/暂停、拖动进度、音量。
- 音量滑条为竖向；点击音量按钮后弹出。
- 支持另存/导出录音到本机。
- 支持按存储策略清理过期录音；永久告警录音与人工录音的保留策略可能不同。

> **注意：** 设备端录音需要先同步到本机才能离线播放。同步失败时请检查设备连接、凭据和存储空间。

## 12. 设置与协议诊断

### 12.1 系统设置

- 存储：选择存储根目录、容量配额、保留天数和最低剩余空间。
- 地图：选择在线瓦片服务、缓存和默认中心；离线时仍可使用网格和选点。
- 相机直播：设置并发路数和自动播放。
- 界面与语言：切换简体中文、繁体中文、英语、西班牙语、俄语、土耳其语。
- 用户与权限：管理员可新增用户、重置密码、设置角色和细项权限。

### 12.2 协议诊断

协议诊断用于测试设备端点、认证方式和数据格式。输入设备、路径、方法和参数后执行探针，查看 HTTP 状态、响应头、原始响应和解析结果。

> **注意：** 协议诊断只用于排障，不应在生产设备上执行未知的写操作。

## 13. 常见问题与排障

### 13.1 设备认证失败 AUTH_FAILED

检查设备用户名和密码、设备账户状态、设备是否返回 401/403、设备会话数是否已满。超时或 503 是设备暂不可用，不应按密码错误处理。

### 13.2 实时视频不显示

- 确认设备在线且 RTSP 已启用。
- 确认视频墙/相机的并发路数未超过设置上限。
- 检查相机 IP、端口和账号密码。
- 查看页面状态和诊断日志中的 ffmpeg 错误。
- 确认本机网络可以访问相机。

### 13.3 没有实时音频或频谱

确认设备型号支持该能力。AO01 不提供实时音频/频谱；Air Sonar 实时音频能力取决于固件和通道。没有数据时应显示明确空态，而不是伪造曲线。

### 13.4 没有趋势图

趋势数据来自设备回调或历史存储。若设备不支持该指标、没有历史记录或时间范围为空，页面会显示空态。声学相机和 Air Sonar 的 SPL 可从趋势库或告警 SPL 读取。

### 13.5 没有告警抓拍图或录音

抓拍图和录音需要设备端生成并同步到本机。请先在告警页或录音页执行同步；设备只保留有限历史，过期数据可能已被删除。

### 13.6 时间轴没有录像

时间轴只显示本机已登记的录像。确认设备录音已同步、时间窗口正确，并使用滚轮/拖动调整时间范围。时间轴默认最近 1 小时。

### 13.7 视频墙没有自动播放

- 确认相机在线且已分配到格子。
- 确认设置中的自动播放相机未关闭。
- 检查并发上限和相机 RTSP 连接限制。
- 离线设备不会自动起播，恢复在线后重新打开总览或手动启动。

### 13.8 PTZ 没有画面

在 16 路空气声呐页面的 PTZ 卡中选择已登记的相机；确认相机在线、RTSP 可用，且相机允许的客户端数量未耗尽。

## 14. 安全、维护与数据管理

- 定期备份设备配置、告警录音和重要导出文件。
- 设备密码使用操作系统凭据保护；不要把密码写入共享文档或截图。
- 按存储容量设置保留天数、配额和最低剩余空间，避免磁盘写满。
- 升级软件前先导出版本信息和重要数据；不要在录音写入高峰期重启。
- 发现设备时间异常时，先同步设备时间；时间偏差会影响告警和趋势排序。
- 保留应用日志和设备日志用于故障分析；提交问题时附上时间点、设备名和错误码。

> **注意：** 删除、覆盖和容量清理可能不可恢复。执行前确认备份和数据保留策略。

## 15. 附录

### 15.1 常用错误码

| 错误码 | 含义 | 建议处理 |
|---|---|---|
| AUTH_FAILED | 设备凭据被拒绝 | 检查设备用户名/密码和账户状态 |
| TIMEOUT | 设备或网络超时 | 检查网络、设备负载和端口 |
| NETWORK_ERROR | 网络连接失败 | 检查 IP、路由、防火墙 |
| DEVICE_ERROR | 设备接口返回错误 | 查看响应和协议诊断结果 |
| NOT_IMPLEMENTED | 设备/固件不支持该操作 | 确认设备型号与固件版本 |
| VALIDATION_ERROR | 输入参数不合法 | 检查表单和数值范围 |

### 15.2 版本与支持

软件版本：1.0.49。发布日期：2026-11-13。技术支持：上海贺驰智能科技有限公司。

提交问题时请提供：软件版本、设备型号与固件、发生时间、设备名称、错误码、截图/日志和复现步骤。

<!-- pagebreak -->

# Part II  English User Manual

## 1. Quick Start

HAIS connects acoustic cameras, voiceprint devices, air sonar units and gas-leak monitors, then provides live monitoring, GIS mapping, alarm management and trend analysis. For first-time use, follow this order.

1. Sign in with an administrator or operator account.
2. Open Devices, add the device and enter its IP address, port, device username and password.
3. Enter or pick the latitude/longitude and confirm the installation azimuth.
4. Open Map information and verify the device marker, current alarms and history.
5. Open Overview, assign cameras to the video wall and arrange the layout.
6. Open Live monitoring, select the device and check video, acoustic charts and audio.
7. Use Trends for history and Alarm center for alarm processing.

> **Note:** The device password is the password of the device itself, not the HAIS account password. If the device password changes, update the saved device credentials.

## 2. System Overview

HAIS provides device management, GIS mapping, a live video wall, real-time acoustic analysis, alarm recordings, historical trends and event handling.

### 2.1 Supported device types

| Device type | Main capabilities | Typical use |
|---|---|---|
| Acoustic Camera | Live video, spectrum, voiceprint, SPL trend, alarm snapshots | Visual acoustic inspection such as partial discharge or leakage |
| Acoustic Box | Multi-channel trends, spectrum, voiceprint, live and recorded audio | 8-channel vibration/acoustic monitoring |
| Air Sonar (SN-16) | 16 channels, GIS directional range, alarm direction, SPL trend, PTZ linkage | Sound-source localisation and alarm verification |
| Gas leak monitor (AO01) | On-device leak detection, alarm-audio sync, alarm history | Gas-well leak alarms and recorded evidence |
| Push Device | HTTP/MQTT telemetry and alarm ingestion | Third-party integration |

### 2.2 Interface layout

- Left navigation: Map information, Overview, Devices, Live monitoring, Trends, Alarm center, Event centre, Recordings, Settings and Protocol Lab.
- Top bar: current-device selector, refresh, alarm/system notices and user menu.
- Main area: maps, video wall, tables, charts and detail panels.
- Dialogs/side panels: device editing, alarm details and map point picking.

> **Note:** Visible menus and actions depend on the signed-in role. Administrators have higher-risk permissions such as device configuration, user management and deletion.

## 3. Sign-in and Main Window

### 3.1 Sign in

1. Start HAIS.
2. Enter the system account and password.
3. Select Sign in. If required, change the initial or reset password.

After a successful sign-in the application opens the last or default page. The top bar shows the current user; use the user area to sign out.

### 3.2 Top bar and device selector

- Device selector: changes the current device on monitoring, map and trend pages.
- Refresh: reloads data for the current page.
- Alarm/system notice icon: unhandled alarms and system messages.
- User menu: account information, change password and sign out.

### 3.3 Navigation

As of v1.0.49 the order is: Map information, Overview, Devices, Live monitoring, Trends, Alarm center, Event centre, Recordings, Settings and Protocol Lab.

## 4. Overview and Video Wall

The Overview page is dedicated to multi-camera video. It intentionally omits device-status and alarm-status list cards.

### 4.1 Configure the wall

1. Open Overview.
2. Choose a 1 / 4 / 9 / 16 split layout.
3. Click the plus tile and select a camera.
4. Choose the display mode for each tile: video, 1-second time domain, spectrum or spectrogram.
5. Use the volume control to choose which tile produces sound; only one tile can be audible at a time.
6. The layout, assignments and view modes are saved automatically.

### 4.2 Auto-play

The next time Overview is opened, the wall restores the saved configuration and automatically starts live video for online cameras. Offline cameras show an offline state; the UI never pretends that they are playing.

### 4.3 Common actions

- Double-click a tile or use the fullscreen control for fullscreen.
- Right-click a video for recording, snapshot, display mode and audio actions.
- Click a camera selector to replace the source in a tile.
- Camera state is shown by status icons and text. Empty tiles are not rendered as unexplained black rectangles.

> **Note:** Leaving the page releases page-owned video requests. Reopening Overview restores the session automatically; no manual reconfiguration is required.

## 5. Map Information

Map information is the single view for device locations and alarm posture. GIS mapping is at the top; current alarms, alarm history and the device list are below it.

### 5.1 Map controls

- Mouse wheel: zoom.
- Left-button drag: pan.
- Click a marker: select the device and open its detail panel.
- Use the map controls to zoom in/out, fit all devices or focus the selected device.
- Online map tiles can be enabled in Settings; a floor plan can also be imported with device positions.

### 5.2 Status and alarms

- Online, offline and unacknowledged-alarm states use different colours; alarm state takes priority over online state.
- The overlay at the upper-right reports mapped devices, online devices and unacknowledged alarms.
- The current-alarm list shows device, channel and time.
- The history list shows recent alarms; the device list shows IP address and channel count.
- Clicking an alarm or device row focuses the corresponding device on the map.

### 5.3 Installation point and device detail

The detail panel shows name, status, IP, channel count, coordinates and installation azimuth. Live monitoring opens the real-time page for that device.

> **Note:** The video wall is not embedded in Map information. It belongs to the separate Overview page.

## 6. Device Management

### 6.1 Add a device

1. Select Add device.
2. Choose the device type and connection method.
3. Enter the name, IP address, HTTP port and device username/password.
4. Run Probe/Test connection to confirm reachability and authentication.
5. Enter or pick the installation point and azimuth.
6. Save the device.

### 6.2 Edit and delete

Use Edit to change the name, network parameters, device credentials and installation data. Delete removes local configuration and cached data; it does not erase data stored on the device.

### 6.3 Enter coordinates

Two methods are available:

- Type latitude and longitude directly when precise coordinates are known.
- Select Pick on map, click the map, or type latitude/longitude in the picker and select Locate; confirm to fill the form.

### 6.4 Device detail

Device detail contains tabs for identity, channels, alarm parameters, network, time and maintenance. The embedded location map has been removed from Device detail; use Map information to view it.

### 6.5 About AUTH_FAILED

AUTH_FAILED means that the device rejected the saved device credentials. It is not a failure of the HAIS account. Typical causes are a changed device password, a disabled device account, stale saved credentials, or an HTTP 401/403 response from the device.

1. Edit the device and re-enter its username and password.
2. Use the device web UI to verify that the account can sign in.
3. Check whether the device has reached its client/session limit.
4. If the device is only busy or temporarily unavailable, investigate its HTTP service rather than repeatedly changing the password.

> **Note:** Timeouts, HTTP 503 and malformed endpoint responses are device errors, not credential failures. Successful channel reads now clear stale in-place errors left by earlier failures.

## 7. Live Monitoring

Select a device in the top bar and open Live monitoring. The page content depends on the device type.

### 7.1 Acoustic Camera

- Live video and camera controls: play/pause, fullscreen, recording, snapshot, detection regions and audio.
- Voiceprint, spectrum and detection-mode panels.
- An SPL trend card below the video shows the last hour of sound-pressure level.
- One click adds the camera to the Overview video wall.
- Camera settings are available from the gear button at the right of the page header.

### 7.2 Acoustic Box / voiceprint devices

- Live trends for SPL, dominant frequency, steadiness and band-energy ratio.
- Channel tabs for multi-channel devices.
- Spectrum, voiceprint and audio/recording playback.
- The playback timeline defaults to one hour and supports wheel zoom, drag pan and previous/next segment.
- The player volume control opens a vertical volume slider.

### 7.3 16-channel Air Sonar

- The GIS map shows the device and a 1-degree directional sector. Direction is calibrated from the latest alarm direction plus installation azimuth.
- The Device header row contains channel selection, play-latest-audio, live-audio pull and alarm-recording sync.
- The latest alarm displays date, direction and alarm type horizontally; click it to open the alarm detail.
- Alarm history supports date filters, page sizes of 20/50/100/200 and paging; changes apply automatically.
- The right detail card shows the selected alarm's snapshot, time, direction, type and recording.
- A SPL trend is available at the bottom of the page.
- The PTZ card can select any registered camera and play its live video.

### 7.4 Gas leak monitor (AO01)

- Map occupies 70%, the leak-detection card 30%, with equal height.
- The card shows cumulative alarms, latest alarm, enabled channels and manual recording/sync.
- The map has no direction sector; map and alarm rows show the CH number and channel/well name.
- Alarm history supports automatic/manual sync, play, download, delete, acknowledge and mark.
- The playback timeline remains below the alarm history.

> **Note:** AO01 does not provide a real-time audio/spectrum stream. The page shows on-device detection results and alarm recordings synced to this computer; it does not fabricate a live waveform.

## 8. Trends

The Trends page queries and compares historical acoustic metrics.

### 8.1 Query steps

1. Select a device from the top bar.
2. Choose a time range or enter custom start/end times.
3. Choose metrics (for example SPL, dominant frequency, band-energy ratio) and channels.
4. The chart updates automatically; use the zoom control or mouse wheel to change the time window.
5. Select Export CSV when a file is needed.

### 8.2 Device capabilities

- Acoustic Box devices support multi-channel metric trends.
- Acoustic cameras support SPL, dominant frequency and band-energy ratio; SPL can be supplemented from alarm SPL when no trend rows exist.
- 16-channel Air Sonar supports SPL trends and is treated as a multi-channel device.
- Devices that do not support trends do not display trend content.

> **Note:** A gap in a curve means that no device sample existed for that time bucket. It does not mean that the sound level was zero.

## 9. Alarm Center

### 9.1 Query and filter

Filter alarms by device, time range, alarm type, severity, acknowledgement state and keyword. Rows show time, device, channel, type, SPL, direction and recording state.

### 9.2 Alarm actions

- Play: play the local recording when available.
- Download: save the recording to a local file.
- Handle/Acknowledge: mark the alarm handled; the action can be reversed.
- Mark: add an operator note to the alarm.
- Severity: change the alarm severity manually.
- Delete: permanently remove selected alarm rows (administrator permission required).

### 9.3 Detail and deep links

Click a row to open alarm detail. The latest alarm area on the live-monitoring page includes a deep link that filters the Alarm center to that device and opens the corresponding alarm.

> **Note:** Alarm rows and recording files are separate objects. Deleting an alarm row does not necessarily delete the local recording file; manage recording files from Recordings.

## 10. Event Center

Event centre combines device alarms, linkage events and other business events into one timeline for cross-device review.

- Event detail shows source, device, time, severity, evidence and handling history.
- Related alarms can be grouped into incidents with a recorded handling process.
- Alarm center focuses on individual acoustic alarms; Event centre focuses on the cross-system event timeline.

## 11. Recordings

Recordings lists audio/video files that have been synced or saved locally.

- Filter by device and time.
- Play with the built-in player: play/pause, seek and volume.
- The volume slider is vertical and opens from the volume button.
- Export/save a recording to another location.
- Retention policies may remove expired files; permanent alarm recordings and manual recordings can have different retention rules.

> **Note:** Device-side recordings must be synced before they can play offline. If sync fails, check device connectivity, credentials and free storage.

## 12. Settings and Protocol Lab

### 12.1 System settings

- Storage: storage root, capacity quota, retention days and minimum free space.
- Maps: online tile service, cache and default centre; grid and point-picking remain available offline.
- Camera live: concurrent stream limit and auto-play.
- Language and appearance: Simplified Chinese, Traditional Chinese, English, Spanish, Russian and Turkish.
- Users and permissions: administrators can add users, reset passwords, assign roles and configure granular permissions.

### 12.2 Protocol Lab

Protocol Lab tests device endpoints, authentication methods and data formats. Select a device, enter the path/method/parameters and run a probe to inspect HTTP status, headers, raw response and parse results.

> **Note:** Protocol Lab is a diagnostic tool. Do not send unknown write operations to production devices.

## 13. Troubleshooting

### 13.1 AUTH_FAILED

Check the device username/password, account status, HTTP 401/403 responses and session limits. A timeout or HTTP 503 means the device is temporarily unavailable and must not be treated as a wrong password.

### 13.2 No live video

- Confirm the camera is online and RTSP is enabled.
- Check the configured concurrent-stream limit.
- Verify camera IP, port and credentials.
- Inspect camera and ffmpeg diagnostics.
- Confirm that this computer can reach the camera network.

### 13.3 No live audio or spectrum

Confirm that the device model supports the capability. AO01 does not provide live audio/spectrum. Air Sonar live-audio support depends on firmware and channel. A missing source must be shown as an explicit empty state, never as fabricated data.

### 13.4 No trend chart

Trend data comes from device callbacks or historical storage. If the device does not support the metric, has no history, or the selected range is empty, an empty state is shown. Acoustic-camera and Air-Sonar SPL can be read from trend storage or alarm SPL records.

### 13.5 No alarm snapshot or recording

Snapshots and recordings must be generated by the device and synced locally. Run sync from the alarm or recordings page. Device storage is limited, so older evidence may already be gone.

### 13.6 Timeline is empty

The timeline shows only locally registered recordings. Confirm that device recordings are synced, the time window is correct, and use wheel/drag to adjust the range. The default window is the last hour.

### 13.7 Video wall did not auto-play

- Confirm the camera is online and assigned to a tile.
- Confirm camera auto-play is enabled in Settings.
- Check the concurrent-stream limit and camera RTSP client limit.
- Offline cameras do not start automatically; reopen Overview or start the tile manually after they come online.

### 13.8 No PTZ video

On the 16-channel Air Sonar page, select a registered camera in the PTZ card. Confirm that it is online, RTSP is available and its client limit has not been reached.

## 14. Security, Maintenance and Data

- Back up device configuration, alarm recordings and important exports regularly.
- Device passwords are protected by operating-system credentials; never write them into shared documents or screenshots.
- Set retention days, quota and minimum free space to avoid filling the disk.
- Before upgrading, export version information and important data; avoid restarting during heavy recording.
- If device time is wrong, synchronise it first; clock skew affects alarm and trend ordering.
- Keep application and device logs for troubleshooting; include time, device name and error code in support requests.

> **Note:** Deletion, overwrite and retention cleanup may be irreversible. Confirm backups and retention requirements before proceeding.

## 15. Appendix

### 15.1 Common error codes

| Code | Meaning | Recommended action |
|---|---|---|
| AUTH_FAILED | Device credentials rejected | Check device username/password and account status |
| TIMEOUT | Device or network timed out | Check network, device load and port |
| NETWORK_ERROR | Network connection failed | Check IP, route and firewall |
| DEVICE_ERROR | Device endpoint returned an error | Inspect response and Protocol Lab result |
| NOT_IMPLEMENTED | Device/firmware does not support the operation | Confirm model and firmware version |
| VALIDATION_ERROR | Invalid input | Check form values and ranges |

### 15.2 Version and support

Software version: 1.0.49. Release date: 2026-11-13. Support: Shanghai Hertzinno Technology Co., Ltd.

When reporting a problem, include software version, device model/firmware, time of occurrence, device name, error code, screenshots/logs and reproduction steps.

— End of document / 文档结束 —
