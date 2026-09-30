#!/usr/bin/env node
'use strict'
/*
 * 连续录像（S1）的真窗口验证 launcher。
 *
 * 为什么这样验：业主的要求是"先不走真机"，而连续录像最容易错的三条（断流重连、看门狗、
 * 崩溃补登记）恰恰都发生在**没有相机**的时候 —— 用真机根本没法稳定复现（拔网线要人在现场）。
 * 所以这里让录像器用 `HZ_RECORDER_SOURCE=lavfi`（本机合成源）跑**真的 ffmpeg**、
 * 真的切片、真的入库，然后由 driver 在真窗口里逐条量：
 *   - 片段是不是真的落盘、真的能播（读文件头 12 字节看 `ftyp`）；
 *   - 杀掉 ffmpeg 之后会不会退避重连，并且**文件重新在长**；
 *   - 停止时最后一片有没有被登记（这条曾经真的丢过）；
 *   - 盘上遗留的片段会不会在下次启动时补登记（崩溃恢复）。
 *
 * ⚠️ 它验的是"录像器这一层"：RTSP 那一层（地址怎么拼、rtsp_enabled 怎么拒）由真机与
 * 既有探针负责，这里刻意用假源替换掉，不去假装验过真机取流。
 *
 * USAGE
 *   node scripts/verify-recorder.cjs
 */

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const mainEntry = path.join(projectRoot, 'out', 'main', 'index.js')
const driver = path.join(projectRoot, 'scripts', 'verify-recorder-driver.cjs')

if (!fs.existsSync(mainEntry)) {
  console.error('[rec] 没有构建产物：' + mainEntry + '（先 npm run build）')
  process.exit(2)
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-rec-'))
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-rec-profile-'))
const storageRoot = path.join(userDataDir, 'HertzinnoData')
fs.mkdirSync(storageRoot, { recursive: true })

const wrapper = path.join(workDir, '_wrapper.cjs')
fs.writeFileSync(
  wrapper,
  "'use strict'\n" +
    '// 在真实应用入口之前挂上 driver：它要在应用起来之后拿到主进程的服务对象。\n' +
    'require(' + JSON.stringify(driver) + ')\n' +
    'require(' + JSON.stringify(mainEntry) + ')\n'
)

const electronBinary = require('electron')
console.log('[rec] electron : ' + electronBinary)
console.log('[rec] storage  : ' + storageRoot)
console.log('[rec] 源       : 本机合成源（HZ_RECORDER_SOURCE=lavfi）—— 不是真机取流')

const isWindows = process.platform === 'win32'
const result = spawnSync(electronBinary, [wrapper, '--user-data-dir=' + userDataDir], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    HERTZINNO_STORAGE_ROOT: storageRoot,
    HZ_RECORDER_SOURCE: 'lavfi',
    HZ_RECORDER_PROBE: '1',
    HZ_RECORDER_PROBE_ROOT: storageRoot
  },
  shell: isWindows && /\.(cmd|bat)$/i.test(electronBinary)
})

if (result.error) {
  console.error('[rec] 启动 electron 失败：' + result.error.message)
  process.exit(1)
}
console.log('[rec] electron exit : ' + result.status)
process.exit(result.status ?? 1)
