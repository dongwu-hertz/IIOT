# 构建与开发环境说明

本文件记录 **规格书没有写、但实际会绊倒人的工程约束**。规格书是需求基线，
这里是环境基线。

---

## 1. 已固定的依赖版本矩阵

刻意避开了几个"最新版"，因为它们目前组合不稳定或有破坏性变更：

| 包 | 版本 | 为什么不用最新 |
|---|---|---|
| electron | 38.8.6 | 44.x 过新，原生模块 prebuild 覆盖不全 |
| vite | 7.3.6 | Vite 8 尚在生态适配期；electron-vite 5 的 peer 上限是 ^7 |
| @vitejs/plugin-vue | 6.0.8 | 5.x 的 peer 只到 Vite 6，与 Vite 7 冲突 |
| vue-router | 4.6.4 | 5.x 引入了 `@pinia/colada` 数据加载器，架构变更大且非本项目所需 |
| pinia | 3.0.4 | 4.x 依赖 vue-router 5 生态 |
| typescript | 5.9.3 | TS 7 是原生重写版，`vue-tsc` 尚未跟进 |
| better-sqlite3 | 13.0.3 | — |
| @duckdb/node-api | 1.4.4-r.4 | Node-API 预编译，**不需要 node-gyp**（见第 2.2 节） |
| @ffmpeg-installer/ffmpeg | 1.1.0 | **相机实时视频的唯一方案**：npm 包内自带预编译二进制，不需要编译器、也不下载 GitHub release（见下表） |

> 升级任何一项前，先跑 `npm run typecheck && npm run build` 验证。

### 1.1 随包分发的二进制：`@ffmpeg-installer/ffmpeg`

相机（FA371）只通过 **RTSP** 发布 H.264，而 Chromium/Electron **不能播 RTSP**：没有对应的解复用器，
`<video src="rtsp://…">` 是直接失败，不是降级。要在应用内看画面，必须有人去拉流并重新封装成浏览器
认识的容器（分片 MP4），这件事由 ffmpeg 做。

| 项 | 值 | 影响 |
|---|---|---|
| npm 包 | `@ffmpeg-installer/ffmpeg@1.1.0`（`dependencies`） | `npm install` 即可，**无 install 脚本、无 GitHub 下载** |
| 平台包 | `@ffmpeg-installer/win32-x64@4.1.0`（前者的 optionalDependency，自动安装） | 需按平台/架构匹配，electron-builder 只收当前平台那一份 |
| 二进制 | `ffmpeg.exe`，**64,458,752 字节 ≈ 64.5 MB** | 安装包里最大的单个文件，约等于此前 105.5 MB 安装包的六成（压缩后） |
| 版本 | ffmpeg `N-92722-gf22fcd4483`（2018-12-17 构建） | `libx264` 在编译配置里，所以重编码回退可用 |
| 许可证 | 包装包 LGPL-2.1，**里面的二进制是 GPLv3**（`--enable-gpl --enable-version3`） | 安装包内含 GPLv3 二进制：发布时须附 GPLv3 文本与对应源码的书面提供；不要换成不带 libx264 的 LGPL 构建而不重测回退路径 |
| 打包要求 | 必须 `asarUnpack`（见 `electron-builder.yml`） | 可执行文件**不能**从 asar 内运行，且 asar 内路径 `existsSync` 为真，漏配只会得到 `spawn` 的 ENOENT |
| 验证方式 | `npm run verify:packaged` 有两项 ffmpeg 检查 | 一项查 `app.asar.unpacked` 里的 PE 文件，一项是**打包进程内**跑 `-version` 的探针 |

代码只有一个入口：`src/main/services/media/ffmpeg.ts`。**不要**在别处再拼一次路径或再 `spawn` 一次
ffmpeg —— 那个文件顶部的注释同时记录了许可证、体积与"为什么不能直接用 `require(...).path`"。

### 1.2 多语言安装向导（安装时选择语言）

产品要求「安装软件时应该支持选择语言」，所以安装包是**多语言**的，四种语言与应用一致：

```yaml
nsis:
  multiLanguageInstaller: true
  displayLanguageSelector: true
  installerLanguages: [zh_CN, en_US, es_ES, tr_TR]
  # nsis.language 刻意不设 —— 见下
```

| 事实 | 依据 |
|---|---|
| 四个语言码合法 | 用固定版本的 electron-builder 自己的语言表验过：`app-builder-lib/out/util/langs` 把 `en_US → English`、`zh_CN → SimpChinese`、`es_ES → SpanishInternational`、`tr_TR → Turkish`。写错一个码会在**构建期**抛 `Language name is unknown for <x>`，所以拼错不会悄悄产出一个只有英文的安装包。 |
| 选择器真的会被编译进去 | `displayLanguageSelector: true` 让 electron-builder 定义 `DISPLAY_LANG_SELECTOR`；模板 `templates/nsis/installer.nsi` 第 59–61 行是 `!ifdef DISPLAY_LANG_SELECTOR` → `!insertmacro MUI_LANGDLL_DISPLAY`。也就是说这个对话框由该配置**条件编译**，不是"希望它出现"。 |
| **产出的安装包里确实有这个对话框** | 完整证据链，每一环都可复核：① `electron-builder.yml` 写 `displayLanguageSelector: true` → ② electron-builder 源码 `if (options.displayLanguageSelector === true) defines.DISPLAY_LANG_SELECTOR = null` → ③ `templates/nsis/installer.nsi:59-61` 只在有该 define 时 `!insertmacro MUI_LANGDLL_DISPLAY` → ④ NSIS 自带的 `Contrib/Modern UI 2/Localization.nsh:74` 定义该宏，宏体调用 `LangDLL::LangDialog`（第 111/113 行）→ ⑤ 这个插件调用会把 `LangDLL` 打进 `$PLUGINSDIR` → ⑥ **用 7-Zip 列出产出的安装包，`$PLUGINSDIR\LangDLL.dll`（2122 B）确实在里面**。本构建的模板里没有任何其它地方用到 LangDLL，所以它的存在只可能来自这个选项。命令：`& node_modules\electron-winstaller\vendor\7z-x64.exe l 'release\*.exe'`（该目录下的 `7z-x64.exe` 会去找 `7z.dll`，而那里放的是 arm64 版；把 `7z-x64.dll` 复制成同目录的 `7z.dll` 再到该目录下运行即可）。 |
| `nsis.language` 为什么没设 | 读源码：这个键只用于安装包 VERSIONINFO 资源的 `/LANG=<lcid>`（`NsisTarget.computeVersionKey`），**不是**向导的默认页语言。设了它看起来像配置、实际做的是另一件事。默认值 1033 也正好与 `electron-builder.yml` 里全英文的 productName / copyright / description 相配。 |

**仍未做**：没有实机跑过安装向导，所以"对话框长什么样、默认选中哪种语言、四种语言的按钮文案"没有实测证据。
上面的证据链只证明对话框**会被显示**，以及它出现的原因就是这个选项。要补上这一步，需要在一台干净机器上
跑一次安装包并截图。

**踩过的坑（记下来免得再犯）**：安装包载荷是 LZMA 压缩的，**在 exe 里搜字符串得不到任何结论**——搜不到不等于没编进去。我第一次就是这么判断错的；正确的做法是列出归档内容（看 `$PLUGINSDIR` 里有哪个插件），而不是在二进制里找文本。

**已知限制**：安装向导里选的语言**不会**传给应用。应用自己按
`localStorage` → 操作系统语言（主进程的 `app.getLocale()`）→ 产品默认（中文）的顺序决定界面语言，
入口在 `src/renderer/src/composables/useLocale.ts`，用户也可以在「系统设置 → 界面语言」里随时改。
把向导的选择接过去需要 NSIS 脚本写出一个应用会读的值，目前没有做。


---

## 2. 原生模块与 Windows 工具链（已实机验证）

### 2.1 哪些依赖需要编译

**结论先行：一个都不需要。** 本项目在 Windows 上不需要 C++ 工具链。

| 依赖 | 形态 | 需要 C++ 工具链吗 |
|---|---|---|
| `@duckdb/node-api` | Node-API 预编译（`@duckdb/node-bindings-win32-x64`） | ❌ |
| `better-sqlite3` 13.x | **Node-API 预编译**（`prebuilds/win32-x64.node`） | ❌ |
| `hyparquet` / `hyparquet-writer` | 纯 JavaScript | ❌ |
| `@ffmpeg-installer/ffmpeg` | 包内自带的 `ffmpeg.exe`（预编译二进制，无需构建） | ❌ |

**关键事实（实测，且容易被误判）**：`better-sqlite3` 13.x 虽然历史上是 V8-ABI
插件，**现在已经是 Node-API**。实测其 `prebuilds/win32-x64.node` 内含
`napi_register_module_v1` 等 **72 个 `napi_` 符号**，因此与 V8 ABI 无关：

```
Window  ABI  | 结果
------------|--------------------------------------
Node 24  137 | ✅ SQLite 3.53.4
Electron 38 139 | ✅ SQLite 3.53.4   （同一个二进制）
```

`lib/binding.js` 的解析顺序也印证了这一点：**先找 `prebuilds/`，找不到才回落到
`build/Release/`**。

> **踩过的坑（记录下来避免重复）**：看到 `prebuilds/` 就断言"这是给标准 Node 的
> ABI、Electron 用不了"，然后去写 node-gyp 编译链（VS2026 / v145 工具集 /
> `--force_build=1` / `node.lib` 路径…），是**把力气花在了不存在的问题上**。
> 判断一个原生模块是否 ABI 敏感，看它导出的符号（`napi_*` vs
> `node_register_module_v1`），不要靠包名和历史印象猜。

### 2.2 DuckDB：为什么是 `@duckdb/node-api` 而不是 `duckdb`

旧包 `duckdb@1.4.4` 的 `install` 脚本走 `node-pre-gyp`，实测：

- `npm rebuild duckdb` **不会**命中预编译产物，而是走源码编译；
- 其内置的 DuckDB 源码在当代 MSVC 下编不过，至少两处硬阻塞：
  1. 内置 `fmt` 用了 `stdext::checked_array_iterator` —— 该类型已被 VS2022 17.0
     起从 MS 标准库**移除**，但 `_SECURE_SCL` 仍然定义，于是分支必然编译失败；
  2. 修掉第 1 条后继续推进，`window_distinct_aggregator.cpp` 等文件又在
     MSVC 14.51 下报类型解析错误（`prev_idcs` 未声明等）。

修一条会冒出下一条，属于"用不受支持的编译器编旧源码"。

**因此改用官方 Node-API 包**：预编译、ABI 稳定、零编译。

### 2.3 路径仍不宜含空格

`node-gyp` 对含空格路径的支持一直不牢靠。本机实测路径
`E:\hertzinno-acoustic-box-manager\...` 不含空格，因此不触发该问题。
虽然本项目已不需要 node-gyp，**仍建议**把仓库放在无空格路径下，
以免将来新增原生依赖时再遇到。

---

## 2.4 依赖补丁机制：`scripts/patch-native-deps.cjs`

`node_modules/` 归 npm 所有，任何 `npm install` / `npm ci` / `npm rebuild`
都会覆盖手改内容。因此针对依赖源码的任何改动都必须**脚本化**。

**当前状态**：项目已不需要任何依赖补丁 —— 两个原生依赖都是 Node-API 预编译。
脚本保留三件事：

| 补丁 | 状态 | 说明 |
|---|---|---|
| `duckdb/fmt checked_array_iterator` | `skipped` | 依赖已移除 |
| `node-gyp/Visual Studio 2026 support` | 视需要 | 仅在必须用 node-gyp 时相关 |
| `node-gyp/VS2026 v145 toolset` | 视需要 | 同上 |

```bash
node scripts/patch-native-deps.cjs            # 应用
node scripts/patch-native-deps.cjs --check     # 只检查，缺失则退出码 1
node scripts/patch-native-deps.cjs --revert    # 还原备份
```

已接入 `postinstall` / `prebuild` / `rebuild`。脚本**幂等**，目标不存在时报告
`skipped` 而不失败。

> 保留机制而非直接删除的理由：它是"依赖需要改造时"的唯一受控入口，
> 且成本为零（全 `skipped` 时退出码 0）。将来若真的新增 V8-ABI 原生依赖，
> 不必重新发明。

---

## 3. 平台差异：在哪里开发，在哪里出包

规格书目标平台是 **Windows 10 / 11 x64**，已在 **Windows 11 x64** 上完成
开发链、运行链与**打包链**的实机验证。

| 能力 | 状态 |
|---|---|
| Vue UI / Pinia / Router | ✅ 10 个页面实际渲染，0 console 错误 |
| Services / Mappers / SQLite 逻辑 | ✅ 863 项测试全通过 |
| 设备 HTTP / 流协议联调 | ✅ Mock FA8 端到端通过（6 种 Token 载体全部自动发现） |
| 声学相机（FA371）真机 | ✅ 认证、§5.1 读取端点、五路 WebSocket、RTSP 取流均实测通过 |
| `better-sqlite3` | ✅ Node-API 预编译，Node 与 Electron 下均可用，**无需编译** |
| `@duckdb/node-api` | ✅ 预编译，真实 Parquet + `time_bucket()` 查询通过 |
| DPAPI 凭据加密 | ✅ 加解密往返一致 |
| 未打包目录（`pack:dir`） | ✅ **已产出并验证**：`npm run verify:packaged` 20 项 |
| NSIS 安装包（`dist:win` / `dist:win:signed`） | ✅ **已产出**：`HERTZINNO Acoustic Box Manager-1.0.0-x64-setup.exe · 120.9 MB`（`npm run dist:win`，**未签名**——按产品决定先不签，见第 8 节）。**2026-09-19 起文件名带发布日期**：`…-<版本>-<发布日期>-x64-setup.exe`（见第 4 节与 §第 5 节） |
| 静默安装 → 运行 → 卸载 | ✅ 已实测：安装后应用 25 项验证全通过；卸载后安装目录与注册表项清除，**用户数据保留** |
| 代码签名 | ⏸ **本轮按产品要求不签**：`npm run dist:win` 产出 NotSigned 安装包。签名链路（CA 云端签名 / SimplySign + RFC3161 时间戳）已在早前版本验通，`npm run dist:win:signed` 与 `scripts/sign-preflight.cjs` 保持可用。见第 8 节 |

安装包验证是**端到端**的，不是"构建成功"：

```
静默安装到干净目录           installer exit 0，卸载器生成
对安装目录跑 verify-packaged  25 通过 / 0 失败
  含：打包进程内 better-sqlite3 (ABI 139) + DuckDB 真实加载并查询
      内置 ffmpeg 的 PE 存在性 + 打包进程内 -version 探针
      四种语言在真实 DOM 上渲染互不相同、htmlLang 同步、无 app.* 键漏出
卸载                        exit 0
  安装目录           → 已完全移除
  HKCU 卸载注册表项   → 已清除
  用户音频库（安装目录之外）→ 完好无损（deleteAppDataOnUninstall: false 生效）
```

> 用未签名安装包跑这一步时，`verify:packaged` 会把签名从「硬性失败」降级为提示。
> 想让它重新变成硬性条件：`$env:HERTZINNO_REQUIRE_SIGNATURE='1'; npm run verify:packaged`。

> **`verify:packaged` 覆盖不到的一件事**：打包产物里的相机视频从没跑过
> `scripts/video-proof.cjs`（那个探针跑的是 `out/` 目录构建）。要对**装完之后的应用**
> 做这一步，需要让探针指向安装目录的 `resources/app.asar` 对应的构建——目前没有做，
> 所以"安装包里画面能出"这句话在 README §1 的"尚未验证"里如实列着。

### 打包期的三个坑（实测）

1. **electron-builder 会重新下载 Electron**，不复用 `node_modules/electron/dist`。
   直连 GitHub 会超时。用镜像解决：

   ```powershell
   $env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
   $env:ELECTRON_CUSTOM_DIR='{{ version }}'
   ```

   （NSIS 与 winCodeSign 工具链会缓存到
   `%LOCALAPPDATA%\electron-builder\Cache`，只需下载一次。）

2. **不要靠启动检查来验证原生模块**。`@duckdb/node-api` 是**惰性加载**
   （在 `TrendQueryService.runQuery` 里才 `require`），任何启动检查都不可能
   发现它加载失败 —— 只有用户点开「历史趋势」并查询才会暴露。
   因此 `attachSmokeTestProbes` 增加了一条 `native-modules` 探针，
   在打包进程内**真实加载并使用**两个原生模块，由
   `npm run verify:packaged` 断言。

   **多语言也一样**：目录测试只能证明四个文件完整，证明不了它们被打进了安装包、
   证明不了用户的选择能从 `localStorage` 读回来、也证明不了一个组件真的渲染了
   译文而不是旧常量。同一组探针里的 `locales` 因此会把窗口**逐语言重载一次**
   （每次等 `did-finish-load` 再读 DOM，避免读到旧上下文），把渲染结果交给
   `verify:packaged` 断言：四种语言文案互不相同、`htmlLang` 同步、没有
   `app.*` 键名漏出、非中文下发布日期不含「年/月/日」。

3. **没有证书时 `signAndEditExecutable: true` 不会报错，产物只是 `NotSigned`**。
   构建日志照样打印 `signing with signtool.exe`，很容易被当成"已签名"。
   **必须用 `Get-AuthenticodeSignature` 实际检查**，不能看日志：

   ```powershell
   Get-AuthenticodeSignature "release\HERTZINNO Acoustic Box Manager-1.0.0-x64-setup.exe" | Select Status
   # Status: NotSigned  -> 客户首次安装会遇 SmartScreen 告警
   ```

**代码中所有路径拼接统一使用 `node:path`，禁止手写分隔符。**

---

## 4. 常用命令

```bash
npm run dev              # 启动 Electron + Vue 热更新开发
npm run typecheck        # 主进程 + 渲染进程双工程类型检查
npm run build            # 类型检查 + 三进程构建到 out/
npm test                 # 863 项单元 / 集成测试
npm run smoke            # 无头启动冒烟（含登录闸门与设备状态推送链路）
npm run platform-check   # 平台自检（30 项，含 Electron 内加载原生模块）

npm run pack:dir         # 产出未打包目录 release/win-unpacked（快）
npm run verify:packaged  # 验证打包产物：asar 解包 + 打包进程内加载原生模块 + 四种语言渲染 + 签名（25 项，含内置 ffmpeg 的 -version 探针）
npm run verify:fa371     # 端到端验证声学相机路径（自起 mock FA371 + 临时 profile，不改工作区）
npm run dist:win         # 产出 Windows x64 安装包（慢，含 NSIS），未签名
npm run dist:win:signed  # 同上，但走 CA 云端签名（需先设置证书环境变量，见第 8 节）

npm run rebuild          # 重新拉取原生依赖（当前无需编译，见第 2 节）
node scripts/recovery-code.cjs <安装标识>   # 签发应用账户的超级密码（支持侧工具，见 docs/ACCOUNTS.md）
npm run patch:native     # 应用依赖补丁（当前全部 skipped）
```

**两条只能在真机上回答、且不需要人盯着屏幕的验证**（都需先 `npm run build`）：

```bash
node scripts/video-proof.cjs --route /monitor --seconds 25
# 启动真实构建 + 临时 profile，加真实相机，读 Chromium 自己的数字：
#   readyState / videoWidth / totalVideoFrames / currentTime / <video>.error
# 判定标准是「解出一帧」（readyState ≥ 2 且 videoWidth > 0），
# 并且额外观察 2.2 s 确认 currentTime 与解码帧计数**在推进**——
# 单次非零读数可能只是一帧冻住的画面。

node scripts/video-proof.cjs --route / --observe-only
# 不按任何按钮，只观察：产品要求「软件打开如果是相机有在工作就自动播放视频」。
# 会自动按按钮的探针分不出「自动起播」和「我替它按了」——那是两个不同的结论。

node scripts/camera-load.cjs --streams 1,2,4 --seconds 10
# 用应用原样的 ffmpeg 参数并发拉 1/2/4 路，报告每路 CPU（ffmpeg -benchmark 的
# utime+stime/rtime）、ffmpeg 进程常驻内存峰值与取样次数、每路码流大小。
# 注意：`-benchmark` 的 `bench:` 行是 INFO 级，配 `-loglevel error` 会得到一个
# 全是 "n/a" 的 CPU 列而每路都"成功"——一个什么都没测到却看起来正常的测量工具。
```

`scripts/video-proof-driver.cjs` 是跑在 Electron 主进程里的那一半，**必须是一个真实
文件**：它曾经是一个大模板字符串，四轮里坏了四次且没有任何工具看得见（细节见该文件
顶部与 README §11）。要改它就直接改，`node --check scripts/video-proof-driver.cjs`
会在花掉一次浏览器启动之前告诉你语法对不对。

**出包前建议顺序**：`typecheck` → `test` → `smoke` → `pack:dir` →
`verify:packaged` → `dist:win` → 对安装目录再跑一次
`verify:packaged --dir <安装目录>`。最后一步能同时覆盖"安装是否完整"
与"装完能不能跑"。

> `dist:win` 需要网络下载 Electron（见第 3 节的镜像设置）。
> 若只想快速确认打包没问题，用 `pack:dir` + `verify:packaged`，省掉 NSIS 环节。
>
> 发布正式版本时用 `dist:win:signed`，并用
> `$env:HERTZINNO_REQUIRE_SIGNATURE='1'; npm run verify:packaged`
> 把"签名"从提示变成硬性失败条件（见第 8 节）。

### 发布版本号与安装包文件名（业主 2026-09-19 第 11 批第 1 条）

业主的要求：「每个发布的软件 应该后缀发布日期，以及小版本号的变动。」落法是**每次发布改两处
`package.json` 字段**，其余全自动：

```jsonc
{
  "version": "1.0.1",          // 每次发布把第三位 +1（"小版本号"按 patch 读）
  "releaseDate": "2026-09-19"  // 改成发布当天；它同时是界面上"发布日期"那个读数
}
```

安装包的名字由 `scripts/release-stamp.cjs` 从这两个字段拼出（产品名取自
`electron-builder.yml` 的 `productName`，保证与安装向导里的产品名是同一个字符串）：

```
HERTZINNO Acoustic Box Manager-1.0.1-2026-09-19-x64-setup.exe
```

| 谁用这个名字 | 怎么拿到 |
|---|---|
| `npm run dist:win:offline`（**离线出包，正式发布走这条**） | `scripts/electron-builder.offline.cjs` 覆盖 `win.artifactName` |
| `npm run dist:win:signed`（签名出包） | `scripts/electron-builder.signed.cjs` 覆盖同一个键 |
| `npm run dist:win`（不吃独立配置的老路） | `electron-builder.yml` 里那个**不带日期**的兜底名字 |

为什么不让 YAML 自己拼：`electron-builder.yml` 读不到 `package.json` 的 `releaseDate`，
而 `${env.RELEASE_DATE}` 会让不吃独立配置的 `dist:win` 变成"不设环境变量就构建失败"。
判据在 `tests/installer-name.test.ts`：文件名里有版本与日期、日期原样可解析、第三位比上一次发布大、
离线包与签名包名字完全一致。细节与冲突记录见 `docs/Ivms4200-UX-REFERENCE.md` §15.71。

---

## 5. 品牌资源

软件内使用的公司标识与应用图标来自官方品牌素材，**不经过任何再加工**以保证品牌一致性。

| 文件 | 来源 | 用途 |
|---|---|---|
| `src/renderer/src/assets/branding/hertzinno-logo.png` | `Hertzinno Logo_web_trans.png`（224×120 RGBA） | 侧边栏与「关于」面板的文字标识 |
| `build/icon.png` | `蓝底白色.png`（2000×2000） | macOS / Linux 应用图标 |
| `build/icon.ico` | 同上，由 `icon.png` 生成 | Windows 应用图标 |

**关于 `icon.ico`**：它由脚本从 `icon.png` 用 LANCZOS 重采样生成，
含 **16 / 24 / 32 / 48 / 64 / 128 / 256** 七种尺寸。
256 px 是必需的——Windows 资源管理器「超大图标」视图与安装程序都要求它，
缺少会回退到默认的 Electron 图标。`sips` 无法产出多尺寸 ICO，因此用 PIL 生成。

**关于 logo 的引用方式**：渲染层用 `import` 引入（而非写死路径），
由 Vite 输出带内容哈希的文件名。这是它能**在打包进 asar 后仍正确加载**的原因——
手写的 `/assets/...` 路径在开发模式下正常，安装后会 404。

**品牌信息出现在两处**（均通过 `src/shared/release.ts` 读取同一份元数据）：

- **侧边栏页脚**：版本号 · 发布日期 · `www.hertzinno.com` · `info@hertzinno.com`
- **Settings → 关于**：logo、完整产品名、版本号、发布日期、构建日期、网站与支持邮箱

版本号与发布日期来自 `package.json` 的 `version` / `releaseDate`，
经 `electron.vite.config.ts` 的 `define` 在**构建时内联**——打包后的应用没有可靠路径
回读 `package.json`，而内联的值与 electron-builder 写入安装程序的是同一个来源。

> ⚠️ **不要用 `app.getVersion()`**：未打包运行时它返回的是 **Electron 自身版本**
> （实测显示 `38.8.6`），而不是应用版本。冒烟测试已加入断言防止回归。

**外链打开方式**：渲染层的 CSP 是 `default-src 'self'`，会阻止跳转外部站点，
因此网站与邮箱以 `<button>` 渲染并通过 IPC 交给主进程处理。
主进程对协议做白名单校验（仅 `http:` / `https:` / `mailto:`）——
`shell.openExternal` 会乐意把 `file://` 或自定义协议交给操作系统，
限制协议意味着即使渲染层被攻破也无法用它拉起任意本地处理器。

---

## 6. Windows 验证

在 Windows 上验证的完整步骤见 **[WINDOWS-VERIFICATION.md](./WINDOWS-VERIFICATION.md)**。

一条命令完成平台自检（原生模块、DPAPI、存储根目录、应用启动、品牌资源）：

```powershell
npm run platform-check
```

---

## 7. 首次启动前

应用需要写入 OS 凭据库（`safeStorage`）。若该能力不可用，程序**不会**降级为
明文存储，而是把凭据仅保留在内存中并在日志中告警（见 `credential-store.ts`）。
这是规格书 14.1 的强制要求，不要为了"能用"而改成明文落盘。

---

## 8. 代码签名（CA 云端签名）

### 8.1 为什么必须签

不签名不是"少一个装饰"：

| | 未签名 | 已签名（OV 或 EV） |
|---|---|---|
| 首次安装 | "Windows 已保护你的电脑"，需点"仍要运行" | 仍提示"未识别"，但**显示已验证的发布者名称** |
| Windows 11 Smart App Control | **直接阻止运行**，不是提示 | 允许 |
| 新版本声誉 | **每个版本从零开始** | 按**证书主体**累积，新版本可继承 |
| 企业策略 | 常被直接禁止 | 可被 allow-list |

[微软现行文档](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
已明确 **EV 不再绕过 SmartScreen，OV 与 EV 行为相同** —— 只为免警告而加价买 EV 已无意义。
但要预期：**签名后第一批用户仍会看到警告**，声誉需要"数周 + 数百次来自广泛用户的干净安装"。
唯一完全无警告的路径是走 Microsoft Store 或 Azure Artifact Signing。

### 8.2 云端签名怎么接（本项目的做法）

CA 的云端签名**通过一个 KSP（Key Storage Provider）虚拟卡暴露给 Windows 的 CryptoAPI**：
证书出现在本机证书存储里，私钥留在 CA 的 HSM 中，因此 `signtool` 无需任何改造即可工作。
本项目用的 **SimplySign**（Certum / GlobalSign 等云的签名客户端）正是这个模式：

- Certum：[云代码签名证书使用 SimplySign 签名教程](https://www.certumca.cn/help-center/deploy-guide/25.html)
  （登录后从托盘 → Manage certificates 取指纹，然后 `signtool /sha1 <指纹>`）
- DigiCert KeyLocker：[用 KSP 库让 SignTool 签名](https://docs.digicert.com/it/digicert-keylocker/code-signing/sign-with-third-party-signing-tools/windows-applications/sign-authenticode-files-with-signtool-using-ksp-library.html)
- SSL.com eSigner：[eSigner CKA + SignTool](https://www.ssl.com/how-to/automate-ev-code-signing-with-signtool-or-certutil-esigner/)

所以本项目**不写自定义签名脚本**，只用 electron-builder 内置的 signtool 路径按指纹/主体
挑证书 —— 私钥不出 CA 的 HSM，仓库里也不存在任何 `.pfx`。

```powershell
# 1. 确认 SimplySign Desktop 已安装并已登录（邮箱 + 手机 APP 上的 token），
#    然后列出本机可用的代码签名证书
Get-ChildItem -Recurse Cert: -CodeSigningCert |
  Select-Object Subject, Thumbprint, HasPrivateKey, @{n='NotAfter';e={$_.NotAfter.ToString('yyyy-MM-dd')}}

# 2. 用【指纹】指定证书（推荐；理由见 8.3 第 4 条）
$env:HERTZINNO_CERT_SHA1 = 'DB24261F59F98579A03CB6E9D965866FD109077F'

# 3. 出签名包（先跑 preflight，证书不在就 2 秒内失败，而不是打包 2 分钟后才失败）
npm run dist:win:signed

# 4. 断言签名、时间戳、发布者（强制模式：未签名即失败）
$env:HERTZINNO_REQUIRE_SIGNATURE = '1'
$env:HERTZINNO_EXPECTED_PUBLISHER = 'Shanghai Hertzinno'
npm run verify:packaged
```

证书标识来自环境变量而不是提交进仓库，因为**证书会换**；`scripts/sign-preflight.cjs`
在签名前核对证书是否存在、是否有私钥、是否唯一，`scripts/electron-builder.signed.cjs`
在变量为空时直接拒绝构建 —— 静默产出未签名安装包比构建失败更糟。

> `publisherName` 默认**不设置**：electron-builder 会自己从证书读 CN，而手写一个猜的
> 名字只会写错。只有在需要同时校验更新签名时才用 `HERTZINNO_PUBLISHER` 显式指定。


### 8.3 实测得到的坑

1. **`win.certificateSubjectName` 这种扁平写法会被直接拒绝。**
   electron-builder 官网文档与搜索结果里仍是扁平写法，但 26.15.3 的 schema 只认
   `win.signtoolOptions.*`（已用它的 `validateConfiguration` 实测：扁平写法报
   `configuration.win should be one of these: null`）。证书选项一律写在
   `win.signtoolOptions` 下。

2. **配置了证书但机器上找不到证书，构建会直接失败**（`Cannot find certificate ...`）。
   这正是签名配置**不放进 `electron-builder.yml`** 的原因：那个文件必须在任何机器上
   都能出未签名包。签名配置单独放 `scripts/electron-builder.signed.cjs`，
   用 `extends: file:electron-builder.yml` 深合并（已验证 `win.icon` /
   `win.target` / `nsis` / `asarUnpack` / `files` 全部保留）。

3. **绝不要用 `ELECTRON_BUILDER_OFFLINE=true` 出正式版本**：它会**跳过时间戳**。
   没有 RFC3161 时间戳的签名只在证书有效期内有效 —— 证书一到期，
   所有已分发的安装包同时失效。`verify:packaged` 会把"有效签名但没有时间戳"
   判为**失败**，而不是通过。

4. **同名证书有两张时，必须用指纹指定。** `certificateSubjectName` 是**子串匹配**，
   electron-builder 静默取**第一张**；机构续签后新旧两张证书同 CN 并存很常见，
   而 SmartScreen 声誉是按**证书身份**累积的 —— 在新旧之间来回签会把它摊薄，
   更糟的是可能一直用着下个月就过期的那张。`sign-preflight.cjs` 因此把
   "匹配到多张"当作**错误**并直接给出该设的指纹。
   （本机实测：两张 `Shanghai Hertzinno Technology Co., Ltd.`，分别 2027-09-03 与
   2029-07-09 到期；另有 `上海烁炎声科技有限公司` 一张。主体名里的 CN 可能带引号，
   例如 `CN="Shanghai Hertzinno Technology Co., Ltd.", O="..."`，子串匹配仍可用。）

5. **证书主体含中文时，PowerShell 的输出编码必须强制成 UTF-8。**
   PowerShell 5.1 把重定向的 stdout 按控制台代码页（中文 Windows 是 GBK）输出，
   中文主体名读进 Node 就是乱码 —— 而主体名正是用来**匹配**的值，
   一张完全正常的证书会被判为"找不到"。两个脚本都已加
   `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8`。

> **构建日志不能证明签名。** electron-builder 对每个文件都会打印
> `signing with signtool.exe`，即便没有配置任何证书 —— 它打印的是"意图"。
> 本项目就产出过一个 105 MB 的安装包：日志里 4 行 `signing with signtool.exe`，
> 而 `Get-AuthenticodeSignature` 报 `NotSigned`。唯一的判据是
> `npm run verify:packaged` 里对**文件本身**的签名读取。

---
