#!/usr/bin/env node
/*
 * 逐文件把编译好的测试跑一遍，**不起子进程**。
 *
 * WHY THIS EXISTS
 * `npm test` 是 `node --test ".test-build/tests/**`/*.test.js"`。Node 的测试运行器
 * 默认**每个测试文件开一个子进程**（process isolation），而它的子进程走的是
 * piped stdio —— 在本项目的沙箱/受限环境里被挡住：报 `Error: spawn EPERM`
 * （`node:internal/test_runner/runner:454`），一个断言都跑不到，却看起来像"测试全挂"。
 *
 * 2026-09-20（第 40、41 轮）都在这里卡过：`docs/UI-VERIFY.md` 里写的是"改用同一批
 * `.test-build` 文件逐个执行"，但**那份执行方式没有落到仓库里** —— 每轮都要重新手搓
 * 一遍 PowerShell 循环，而且手搓的版本容易漏文件、不会汇总、失败也不报退出码。
 * 所以把这件事写成脚本：**同一份产物、同一套断言，只是换一个跑法**。
 *
 * 怎么跑
 *   1. `npm run test:build`   （产出 `.test-build/`，并把 `@shared/*` 改写成相对路径）
 *   2. `node scripts/run-tests-inproc.cjs`
 *
 * 与 `npm test` 的差别（说清楚，免得被当成"等价替代"）
 *   - **没有进程隔离**：一个文件里的崩溃 / `process.exit` 会带走它自己那个进程。
 *     正常的断言失败仍然只影响它自己（`node:test` 在进程内捕获），所以判据依然可用。
 *   - 每个文件单独一个 `node` 进程（抓文本输出，不开共享命名管道），因此模块级状态不会在
 *     文件之间互相污染 —— 这一条与原运行器一致。
 *   - 汇总口径对齐 `node --test` 的尾巴，**两种报告格式都认**：
 *     `# pass 22`（TAP：`node --test` 往管道里写的那种）与
 *     `ℹ pass 22`（spec：`node <file>` 直接跑、输出是终端时用的那种）。
 *     少了后者会出现"22 条断言全过、脚本却说这个文件没跑起来"的假崩溃。
 *
 * 用法
 *   node scripts/run-tests-inproc.cjs              跑全部；有失败或崩溃则 exit 1
 *   node scripts/run-tests-inproc.cjs --filter map 只跑文件名含 `map` 的
 *   node scripts/run-tests-inproc.cjs --quiet      只打印汇总与失败清单
 *   node scripts/run-tests-inproc.cjs --timeout 20000  单个文件的超时（毫秒，默认 120000）
 *
 * 每个文件都有超时：卡死的测试（本项目真发生过：渲染 + patch 死循环）在超时后会被杀掉
 * 并计入"崩溃文件"，整轮不会跟着一起挂住。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const TESTS_DIR = path.join(ROOT, '.test-build', 'tests')
/** 每个文件的 TAP 落到这里，父进程读回来 —— 见主循环里"为什么走文件不走管道"。 */
const LOG_DIR = path.join(ROOT, '.test-build', 'tap')

const argv = process.argv.slice(2)
const quiet = argv.includes('--quiet')
const filterIndex = argv.indexOf('--filter')
const filter = filterIndex === -1 ? '' : (argv[filterIndex + 1] ?? '')
const timeoutIndex = argv.indexOf('--timeout')
const timeout = timeoutIndex === -1 ? 120_000 : Number(argv[timeoutIndex + 1] ?? 120_000)

function collect(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collect(full, out)
    else if (entry.name.endsWith('.test.js')) out.push(full)
  }
  return out
}

/** 从尾巴里取计数；两种报告格式都认（见文件头）。取不到就是"这个文件根本没跑起来"。 */
function parseCounts(output) {
  const pick = (name) => {
    const match = output.match(new RegExp(`^[#ℹ] ${name} (\\d+)\\s*$`, 'm'))
    return match ? Number(match[1]) : undefined
  }
  return { pass: pick('pass'), fail: pick('fail'), skipped: pick('skip') }
}

function main() {
  if (!fs.existsSync(TESTS_DIR)) {
    console.error(`[run-tests-inproc] 找不到 ${TESTS_DIR} —— 先跑 \`npm run test:build\``)
    process.exit(1)
  }

  const files = collect(TESTS_DIR)
    .filter((file) => (filter === '' ? true : file.includes(filter)))
    .sort()

  if (files.length === 0) {
    console.error(`[run-tests-inproc] 没有匹配的测试文件（--filter ${filter}）`)
    process.exit(1)
  }

  // 上一轮的 TAP 会盖住这一轮：先清空，免得"读到了上次的绿"这种假证据。
  fs.rmSync(LOG_DIR, { recursive: true, force: true })
  fs.mkdirSync(LOG_DIR, { recursive: true })

  const failures = []
  const crashes = []
  let pass = 0
  let fail = 0
  let skipped = 0

  for (const file of files) {
    const relative = path.relative(ROOT, file)
    /*
     * 为什么输出走**文件**而不是管道：
     * 受限环境挡住的正是"把命名管道当子进程的 stdio" —— 传 `stdio:'pipe'`（或让
     * `spawnSync` 默认开管道）会直接 `EPERM`、`stdout` 为空串、`status` 是 `null`，
     * 看起来像"105 个测试文件全崩"。把三条 fd 全指向文件（或 `ignore`）就没有管道。
     * 报错信息也不丢：`node --test-reporter=tap --test-reporter-destination=<file>`
     * 把 TAP 写进文件，父进程再读回来。
     */
    const logFile = path.join(LOG_DIR, `${path.basename(file, '.test.js')}.tap`)
    const result = spawnSync(
      process.execPath,
      ['--test-reporter=tap', `--test-reporter-destination=${logFile}`, file],
      {
        cwd: ROOT,
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout
      }
    )
    const output = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
    const counts = parseCounts(output)

    if (counts.pass === undefined && counts.fail === undefined) {
      const why =
        result.error?.code === 'ETIMEDOUT'
          ? `超过 ${timeout}ms 没结束`
          : result.error
            ? `${result.error.code}`
            : `exit ${result.status}`
      crashes.push({ relative, code: result.status, output, why })
      if (!quiet) console.log(`✖ ${relative} —— 没有跑出汇总（${why}）`)
      continue
    }

    pass += counts.pass ?? 0
    fail += counts.fail ?? 0
    skipped += counts.skipped ?? 0
    if ((counts.fail ?? 0) > 0) {
      failures.push({ relative, counts, output })
      console.log(`✖ ${relative} —— pass ${counts.pass} / fail ${counts.fail}`)
    } else if (!quiet) {
      console.log(`✔ ${relative} —— pass ${counts.pass}`)
    }
  }

  console.log('')
  for (const crash of crashes) {
    console.log(`===== 崩溃：${crash.relative}（${crash.why}）=====`)
    const tail = crash.output.trim().split('\n').slice(-25).join('\n')
    if (tail !== '') console.log(tail)
    console.log('')
  }
  for (const failure of failures) {
    console.log(`===== 失败：${failure.relative} =====`)
    const lines = failure.output.split('\n')
    const start = lines.findIndex((line) => /^not ok /.test(line))
    console.log(lines.slice(start === -1 ? 0 : start, (start === -1 ? 0 : start) + 40).join('\n'))
    console.log('')
  }

  console.log(
    `[run-tests-inproc] 文件 ${files.length} 个 · pass ${pass} / fail ${fail} / skipped ${skipped}` +
      ` · 崩溃文件 ${crashes.length} 个`
  )

  process.exit(fail > 0 || crashes.length > 0 ? 1 : 0)
}

main()
