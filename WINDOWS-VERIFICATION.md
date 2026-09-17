# Windows 验证指南

> 目标：在 **Windows 10 / 11 x64** 上验证本软件可以正常构建、启动、连接设备并出包。
>
> 当前开发机是 macOS，因此下列内容**尚未在 Windows 上执行过**。
> 这份指南给出的是**可执行的步骤与预期结果**，不是已验证的结论。

---

## 0. 先明确：为什么要单独在 Windows 上验证

有三件事**只能在 Windows 上确认**，在 macOS 上无论怎么测都得不到结论：

| 能力 | 为什么必须 Windows |
|---|---|
| **DPAPI 凭据加密** | `safeStorage` 在 Windows 上走 DPAPI，在 macOS 上走 Keychain。两条代码路径不同，Keychain 通过不代表 DPAPI 通过。 |
| **win32-x64 原生模块** | `better-sqlite3` 与 `duckdb` 都是按 **ABI + 平台**编译的。macOS 上加载成功（实测 ABI 139）不能证明 Windows 上也能加载。 |
| **安装包与图标** | NSIS 安装程序、`build/icon.ico` 在任务栏/资源管理器中的实际显示，只能在这台机器上看到。 |

其余能力（协议、映射、UI 逻辑、Parquet/DuckDB 查询语义）已在本仓库的 271 项测试与真机验收中覆盖，
在 Windows 上重跑一遍即可，预期结果相同。

---

## 1. 环境准备

### 1.1 Node.js

需要 **Node ≥ 22**（`better-sqlite3` 13 的 `engines` 要求）。

```powershell
node --version    # 应 ≥ v22
npm --version
```

### 1.2 🔴 仓库路径**不能含空格**

这是最容易踩、且报错信息最误导人的一条。

```
✗ C:\Users\张三\My Documents\hertzinno-manager\      ← 含空格，node-gyp 会失败
✓ C:\src\hertzinno-manager\                          ← 推荐
```

原因：`node-gyp` 无法在含空格的路径下编译原生模块，报错指向 node-gyp 而不是真实原因。

**为什么现在还没炸**：`better-sqlite3` 与 `duckdb` 都自带预编译二进制，
编译失败会静默回落到预编译产物。但一旦需要真正编译（升级 Electron、新增原生依赖），
就会失败。所以**首次在 Windows 上搭建时就直接用无空格路径**，省得以后迁移。

### 1.3 安装依赖

```powershell
cd C:\src\hertzinno-manager
npm install
```

`postinstall` 会执行 `electron-builder install-app-deps`，为 Electron 准备原生模块。
这个过程需要几分钟。

### 1.4 不需要的东西

- **不需要 Visual Studio / MSVC 工具链**（除非要自己编译原生模块）
- **不需要 Python**（同上）
- **不需要 Docker / 数据库服务** —— 规格书 §2 明确要求轻依赖

---

## 2. 平台验证（一条命令）

```powershell
npm run platform-check
```

它会构建并逐项检查 **30 项**，覆盖：主机工具链、品牌资源、原生模块（**在 Electron 运行时内**）、
DPAPI 凭据加密、存储目录解析、构建产物、应用启动。

预期输出：

```
主机与工具链
  ✓ 平台 win32 / x64  目标平台
  ✓ 仓库路径不含空格  C:\src\hertzinno-manager
  ✓ Node 版本 ≥ 22     v22.x.x
  ✓ 依赖已安装

品牌资源
  ✓ Windows 应用图标（多尺寸）  build/icon.ico · 21002 字节
  ✓ ICO 含多种尺寸（Windows 需要 256px）  7 个尺寸

原生模块（必须在 Electron 运行时内验证）
  ✓ Electron 运行时  electron 38.8.6 · node 22.22.0 · ABI 139
  ✓ better-sqlite3 可加载并查询  SQLite 3.53.4
  ✓ duckdb 可加载并查询  SELECT 42 返回 42

凭据加密（Windows 上走 DPAPI）
  ✓ OS 凭据加密可用  后端：dpapi        ← macOS 上这里显示 "(not reported)"
  ✓ 加解密往返一致
  ✓ 密文中不含明文

存储目录解析
  ✓ D: 盘存在性已探测
  ✓ 存储根目录可写

构建产物
  ✓ logo 已被打包  hertzinno-logo-XXXXXXXX.png

应用启动
  ✓ preload 桥接可用  api=true events=true
  ✓ Vue 应用挂载
  ✓ 品牌 logo 渲染
  ✓ 版本与发布信息  v1.0.0 (2026-09-16) · https://www.hertzinno.com

结果  30 通过
```

### 逐项失败时的排查

| 失败项 | 含义与处理 |
|---|---|
| `better-sqlite3 可加载` 失败 | ABI 不匹配。运行 `npm run rebuild`；若报路径含空格，先迁移仓库 |
| `duckdb 可加载` 失败 | 同样是 ABI 问题。DuckDB 有预编译产物，`npm rebuild duckdb` 通常即可 |
| `OS 凭据加密可用` 失败 | DPAPI 不可用（罕见，通常是被组策略禁用）。**这不是崩溃** —— 应用按规格书 §14.1 降级为"凭据仅存内存"，绝不落明文 |
| `品牌 logo 渲染` 失败 | 图片 `naturalWidth === 0`，即路径错误或被构建排除。检查 `out/renderer/assets/` 下是否存在 `hertzinno-logo-*.png` |
| `版本与发布信息` 失败 | 构建时未注入元数据。确认 `electron.vite.config.ts` 的 `define` 生效 |

---

## 3. 功能验证

### 3.1 无设备时的自检

```powershell
npm test              # 271 项，预期 271 通过
npm run smoke         # 启动冒烟，11 项全通过
npm run mock-device   # 另开一个终端，起一台模拟 FA8 设备
```

### 3.2 有真机时

把电脑接到与设备同一网段，然后：

```powershell
npm run device-check -- --ip <设备IP> --user admin --pass <密码>
```

预期 **37 项通过**，覆盖认证、四路实时流、录音落盘、告警录音、配置读取、Parquet/DuckDB 查询。

### 3.3 界面检查（人工）

```powershell
npm run dev
```

需要肉眼确认的几项：

- [ ] 侧边栏页脚显示 **版本号 · 发布日期 · www.hertzinno.com · info@hertzinno.com**
- [ ] 侧边栏顶部的 logo 正常显示（不是破图）
- [ ] 点击网址 → **系统默认浏览器**打开官网
- [ ] 点击邮箱 → **系统默认邮件客户端**打开
- [ ] Settings → 关于：logo、产品名、版本、发布日期、构建日期齐全
- [ ] 窗口标题栏与任务栏图标是 HERTZINNO 图标（**不是默认 Electron 图标**）

> ⚠️ 外链是经主进程 `shell.openExternal` 打开的，且只允许 `http/https/mailto`。
> 若点击无反应，检查主进程日志里的拒绝原因。

---

## 4. 出包

```powershell
npm run dist:win
```

产物在 `release\` 下，形如 `HERTZINNO Acoustic Box Manager-1.0.0-x64-setup.exe`。

出包后需要验证：

- [ ] 安装程序图标是 HERTZINNO 图标
- [ ] 安装后桌面/开始菜单快捷方式图标正确
- [ ] **任务栏与资源管理器大图标正确**（`icon.ico` 含 256px 才正常）
- [ ] 安装后启动，重复第 3.3 节的界面检查
- [ ] **卸载不会删除音频库**（`deleteAppDataOnUninstall: false`；音频在存储根目录，不在安装目录）
- [ ] 首次启动若弹出 Windows SmartScreen 警告 —— 这是**预期行为**，因为当前未做代码签名

> 关于签名的说明：正式对外分发前需要购买代码签名证书，否则用户首次运行会看到
> "Windows 已保护你的电脑"。这是 `electron-builder.yml` 中的已知取舍，不是缺陷。

---

## 5. 常见问题

### Q: `npm install` 报 `Attempting to build a module with a space in the path`

路径含空格。迁移仓库到 `C:\src\...`。当前依靠预编译产物可绕过，但不要依赖这一点。

### Q: 应用启动后窗口一片空白

运行 `npm run platform-check`，看"应用启动"一节。
若 `渲染层加载完成` 通过但 `Vue 应用挂载` 失败，说明渲染层抛异常 ——
检查 `%TEMP%` 下临时用户数据目录里的 `app-*.log`。

### Q: 日志在哪里

默认在**存储根目录**下的 `logs\`：

- `D:\HertzinnoData\logs\`（D 盘存在时）
- 否则 `%USERPROFILE%\Documents\HertzinnoData\logs\`

三路分流：`app-*.log` / `device-*.log` / `storage-*.log`。

### Q: 修改存储目录后已有录音会失效吗

不会。数据库里存的是**相对路径**，这是规格书 §4.1 的硬性要求，
也是 `tests/storage-paths.test.ts` 专门保护的不变量。

### Q: 防火墙提示

应用**只发起出站连接**（访问设备 HTTP/WebSocket），不监听任何端口，
因此不需要放行入站规则。若 Windows 弹出防火墙对话框，可以取消。

---

## 6. 验证结果记录表

建议把结果填在这里，方便日后回归对照。

| 项目 | 命令 | 预期 | 实测 | 日期 |
|---|---|---|---|---|
| 平台自检 | `npm run platform-check` | 30 通过 | | |
| 单元测试 | `npm test` | 271 通过 | | |
| 启动冒烟 | `npm run smoke` | 11 通过 | | |
| 真机验收 | `npm run device-check -- ...` | 37 通过 | | |
| 界面品牌 | 人工 | 6 项 | | |
| 安装包 | `npm run dist:win` | 6 项 | | |

---

## 7. 尚未覆盖的项（如实记录）

以下内容**当前会话未在 Windows 上验证**，因此不能声称通过：

- DPAPI 实际后端是否报告为 `dpapi`
- win32-x64 下两个原生模块的实际加载
- `build/icon.ico` 在任务栏与资源管理器中的显示
- NSIS 安装/卸载流程
- Windows 下的路径分隔符行为（代码统一使用 `node:path`，但未经实机确认）
- Windows 防火墙/杀毒软件对 Electron 应用的影响
