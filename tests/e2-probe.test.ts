/**
 * ① 听诊盒子「拉」通道的**端到端探针**自身的守卫（`scripts/demo-shot-driver.cjs` 里的假设备）。
 *
 * WHY THIS FILE EXISTS
 * 这一轮的 ① 是靠一条 GUI 探针证明的：探针进程里起一台假听诊盒子（按手册实现端点），
 * 然后在界面上真的走「添加设备 → 测试连接 → 添加 → 进详情 → 同步告警」。
 * 那条探针的价值完全取决于一件容易悄悄退化的事：**假设备到底实现了哪些端点**。
 * 少实现一个，探针要么报一个假失败，要么（更糟）因为客户端"没问到那里"而**看起来全绿** ——
 * 而"客户端没查日志"正是这一条功能最严重的失效方式。
 *
 * 所以这里把两份清单对起来：
 *   - `E2_ENDPOINTS_BY_VARIANT.auscultation`（协议常量，与 `E2Client` 用的是同一份）；
 *   - 假设备的 `if (url.pathname === ...)` 分支。
 * 任何一边加了端点而另一边没跟上，这条测试就会失败。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { E2_ENDPOINTS_BY_VARIANT } from '../src/shared/domain/e2'

const projectRoot = path.resolve(__dirname, '..', '..')
const driver = fs.readFileSync(
  path.join(projectRoot, 'scripts', 'demo-shot-driver.cjs'),
  'utf8'
)

/**
 * 探针**走到的**那一段链路（假设备必须实现它们）。
 *
 * 与 `E2_ENDPOINTS_BY_VARIANT.auscultation` 的键一一对应，少一个就会在上面那条断言里失败。
 */
const COVERED = [
  'login',
  'system',
  'basic',
  'alarmLogAll',
  'alarmLogConditional',
  'alarmFile'
] as const

/**
 * 这一轮**故意没走**的端点，以及为什么。
 *
 * 三个都和「拉」通道无关，而且**客户端里有实现、探针里没有** —— 这一点必须写清楚，
 * 免得把"探针没覆盖"读成"功能没有"：
 *   - `hbSettings`（`/hb_settings`）：心跳上报设置，`E2Client.readHeartbeatSettings()` 在用，
 *     属于"改设备行为"那一类，不是"把设备上的东西拉下来"；
 *   - `heartbeat`（`/heartbeat`）：设备主动上报心跳的目标地址，同样不是拉通道；
 *   - `reboot`（`/reboot`）：重启设备（`E2Client.reboot()`），是一次**写设备**的维护动作，
 *     而按业主的验收口径，任何写设备的动作都要在真机上单独确认（探针不重启任何东西）。
 *
 * 写成两张清单（而不是让断言放过任何未实现的端点）是关键：**新增一个端点却忘了在探针里
 * 覆盖它**，会因为"每一条都要么在 COVERED、要么在 NOT_COVERED"那条断言而失败。
 */
const NOT_COVERED: Record<string, string> = {
  hbSettings: '心跳上报设置：属于改设备行为，不是「拉」通道',
  heartbeat: '设备上报心跳的目标地址：不是「拉」通道',
  reboot: '重启设备：写设备的维护动作，只在真机上单独确认'
}

describe('E2 端到端探针的假设备：端点覆盖', () => {
  it('端点表里的每一条都**要么**在探针里实现、**要么**在这里写明为什么没实现', () => {
    const endpoints = E2_ENDPOINTS_BY_VARIANT.auscultation
    const keys = Object.keys(endpoints)
    assert.ok(keys.length >= 5, '端点表变小了：' + JSON.stringify(endpoints))
    for (const key of keys) {
      const accounted = (COVERED as readonly string[]).includes(key) || key in NOT_COVERED
      assert.ok(accounted, `${key} 既不在探针覆盖清单里，也没有写明为什么跳过`)
    }
    for (const key of COVERED) {
      const endpoint = (endpoints as Record<string, string>)[key]
      assert.ok(endpoint, `端点表里没有 ${key}`)
      assert.ok(
        driver.includes(`url.pathname === '${endpoint}'`),
        `假设备没有实现 ${key}（${endpoint}）—— 探针覆盖不到这条链路`
      )
    }
    // 没覆盖的那几个不许悄悄出现（写了实现就把它挪进 COVERED）。
    for (const key of Object.keys(NOT_COVERED)) {
      const endpoint = (endpoints as Record<string, string>)[key]
      assert.equal(
        driver.includes(`url.pathname === '${endpoint}'`),
        false,
        `${key} 已经实现了，请把它从 NOT_COVERED 挪进 COVERED`
      )
    }
  })

  it('登录那一路用的是**加盐**摘要，而不是"两种都收"', () => {
    /*
     * 只认加盐摘要，不加盐的回 401：这样"先加盐、401 再换一种"那条路径在探针里是**真的**
     * 走了一遍。两种都收的假设备会让这条路径永远测不到（客户端第一次就成功）。
     */
    assert.ok(driver.includes("update(password + 'lfxs')"), '假设备没有按加盐规则算摘要')
    assert.ok(driver.includes('salted'), '假设备没有区分两种摘要')
    assert.ok(driver.includes('json(401'), '假设备没有对不认识的摘要回 401')
  })

  it('除登录外一律校验 Bearer token（否则"token 到底有没有带上"测不出来）', () => {
    assert.ok(driver.includes('Bearer '), '假设备没有校验 Authorization 头')
    assert.ok(driver.includes("json(401, { ret: -1 })"), '假设备没有对缺 token 的请求回 401')
  })

  it('告警文件回的是**真 WAV 字节**与 JPEG 字节（不是 JSON 占位）', () => {
    assert.ok(driver.includes('makeWavBytes('), '假设备没有造 WAV 字节')
    assert.ok(driver.includes('RIFF'), 'WAV 头没有写 RIFF')
    assert.ok(driver.includes('TINY_JPEG'), '假设备没有准备 JPEG 字节')
    assert.ok(driver.includes("endsWith('alarm.wav')"), '假设备没有按文件名分辨录音')
  })

  it('`/system` 里带 `work_mode`（变体判定就看这个键）', () => {
    assert.ok(driver.includes('work_mode'), '假设备的 /system 没有 work_mode')
  })

  it('假设备**只在这条探针里**跑，且探针结束时被关掉（不留一个监听端口的进程）', () => {
    assert.ok(driver.includes('await startMockE2Device('), '探针没有启动假设备')
    assert.ok(driver.includes('await mockE2.close()'), '探针结束时没有关掉假设备')
    assert.ok(driver.includes('await mockSonar.close()'), '空气声呐那一台假设备没有被关掉')
    /*
     * 这是**写操作**的探针（加设备、改 PTZ 参数、往库里写录音），所以它们必须排在所有只读探针
     * 之后：第一版把听诊盒子那一条插在"添加设备对话框"后面，结果后面的相机探针在设备下拉里
     * 只看到这一台新设备，报了一个"切不到相机"的假失败。
     *
     * 判据：假设备启动之后，整份驱动里**只剩这两条自己**的 `layout()` 调用
     * （2026-09-17 第 8 批加了空气声呐那一条，同样是写操作、同样在最末尾）。
     */
    const mockStart = driver.indexOf('await startMockE2Device(')
    const report = driver.indexOf("log('problems     : ' + problems.length)")
    assert.ok(mockStart > 0 && report > mockStart, '假设备没有在探针里启动')
    const afterMock = driver.slice(mockStart)
    const layoutsAfterMock = (afterMock.match(/await layout\(/g) || []).length
    assert.equal(
      layoutsAfterMock,
      2,
      '假设备启动之后还有别的探针在跑（' + layoutsAfterMock + ' 次 layout）——' +
        '写操作的探针必须排在所有只读探针之后'
    )
    // 两次都是"写操作那两台假设备"的流程，不是别的页面探针。
    assert.ok(afterMock.includes('const e2Flow = await layout('), '听诊盒子那一套不见了')
    assert.ok(afterMock.includes('const sonarFlow = await layout('), '空气声呐那一套不见了')
  })
})

describe('设备管理页与其它列表页一致：列表为空时自己读一次', () => {
  it('DevicesView 在 store 为空时会 load()', () => {
    const view = fs.readFileSync(
      path.join(projectRoot, 'src', 'renderer', 'src', 'views', 'DevicesView.vue'),
      'utf8'
    )
    assert.ok(
      /if \(devices\.devices\.length === 0\) void devices\.load\(\)/.test(view),
      '设备管理页没有在列表为空时自读一次（其它列表页都有这一句）'
    )
  })
})

/**
 * `scripts/mock-air-sonar.cjs`：**真机验证**用的假 SN-16（进程外的 HTTP 设备）。
 *
 * 为什么单独守它一遍：`e2-live-proof.cjs` 走的是真应用的主进程（真 `DeviceService` /
 * `E2Client` / 存储 / 回环端点），它需要一台**独立进程**的假设备 —— 真机不在手上的时候，
 * 只有这个 fixture 能让那条链先跑通。而它是手写的：少实现一个端点，那条验证会在
 * "真机一上线"的那一刻才第一次失败，而那时最不容易排查。
 */
describe('真机验证的假 SN-16（mock-air-sonar.cjs）', () => {
  const fixture = fs.readFileSync(path.join(projectRoot, 'scripts', 'mock-air-sonar.cjs'), 'utf8')

  it('实现了验证链要用的端点（含两代路径与静态文件形态）', () => {
    for (const endpoint of [
      "'/login'",
      "'/system'",
      "'/basic'",
      "'/get_device_basic_params'",
      "'/alarm_log_all'",
      "'/get_all_alarms'",
      "'/alarm_files'",
      "'/saving_alarm_file'",
      "'/static_file/'",
      "'/time_sync_with_nvt'"
    ]) {
      assert.ok(fixture.includes(endpoint), `假设备没有实现 ${endpoint}`)
    }
  })

  it('`PUT /system` **真的改**自己的参数（否则 PTZ 的读回核对只是在读我们自己的请求）', () => {
    assert.ok(
      /request\.method === 'PUT'[\s\S]{0,400}Object\.assign\(params, body\)/.test(fixture),
      '假设备的 PUT /system 只是回 200'
    )
  })

  it('`/workmode` 回 404（空气声呐没有这个端点），并且校验加盐摘要与 Bearer token', () => {
    assert.ok(/\/workmode[\s\S]{0,220}404/.test(fixture), '/workmode 不是回 404')
    assert.ok(fixture.includes("PASSWORD_SALT = 'lfxs'"), '假设备没有用加盐摘要（手册的写法）')
    assert.ok(fixture.includes('Bearer ${TOKEN}'), '假设备没有校验 Bearer token')
  })
})
