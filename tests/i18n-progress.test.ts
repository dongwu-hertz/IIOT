/**
 * `scripts/i18n-progress.cjs` is the only thing that tells us whether the i18n
 * migration is finished, and it has now been wrong in BOTH directions:
 *
 *   1. `</template>` used to switch the template flag off, so everything after the
 *      first nested `<template v-if>` was called a comment — the meter said
 *      "0 remaining" on files that still had hard-coded Chinese. It said "done".
 *   2. `classify()` only looked at how a line STARTS, so the continuation lines of
 *      a multi-line `<!-- ... -->` prose comment were reported as user-facing text
 *      — the meter invented 25 lines of work that did not exist.
 *
 * Both make the number meaningless, and both were found by hand rather than by a
 * test. A progress meter with no test is a progress meter that lies, so this file
 * pins the classifier's behaviour on fixtures for every shape that appears in this
 * codebase, and then asserts the real renderer tree reports zero remaining.
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

const projectRoot = path.resolve(__dirname, '..', '..')
const script = path.join(projectRoot, 'scripts', 'i18n-progress.cjs')
const rendererRoot = path.join(projectRoot, 'src', 'renderer', 'src')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-progress-'))
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

interface Counts {
  template: number
  script: number
  comment: number
  details: string[]
}

/** Analyse one fixture through the real script (absolute `--file` bypasses rendererRoot). */
function analyse(name: string, lines: string[]): Counts {
  const file = path.join(tempRoot, `${name}.vue`)
  // Fixtures are ASCII + CJK only; no encoding surprises.
  fs.writeFileSync(file, lines.join('\n'), 'utf8')
  const output = execFileSync(process.execPath, [script, '--file', file], { encoding: 'utf8' })
  const header = /template=(\d+) script=(\d+) comments=(\d+)/.exec(output)
  assert.ok(header, `unrecognised script output for ${name}:\n${output}`)
  return {
    template: Number(header[1]),
    script: Number(header[2]),
    comment: Number(header[3]),
    details: output.split('\n').filter((line) => /^\s+\d+ \[/.test(line))
  }
}

describe('i18n progress scanner', () => {
  it('does not count prose inside a multi-line HTML comment', () => {
    // The exact shape that produced the phantom 25 lines: a comment opener on its
    // own line, prose with no `*` gutter, then the terminator.
    const counts = analyse('html-comment', [
      '<template>',
      '  <!-- ------------------------------------------------------------------',
      '       这一块只回答一个问题：现在能不能直接看到相机画面。',
      '       唯一的 video 只在该有地址的时候存在。',
      '  ------------------------------------------------------------------ -->',
      "  <p>{{ t('live.title') }}</p>",
      '</template>'
    ])
    assert.equal(counts.template, 0)
    assert.equal(counts.script, 0)
    // Two prose lines plus the opener: the opener carries no CJK, so two.
    assert.equal(counts.comment, 2)
  })

  it('does not count prose inside a multi-line style comment', () => {
    const counts = analyse('style-comment', [
      '<template>',
      "  <p>{{ t('x') }}</p>",
      '</template>',
      '<style scoped>',
      '/* ------------------------------------------------------------------',
      '   样式注释散文也不算用户可见文案。',
      '------------------------------------------------------------------ */',
      '.a { color: red; }',
      '</style>'
    ])
    assert.equal(counts.template, 0)
    assert.equal(counts.script, 0)
    assert.ok(counts.comment >= 1, 'style comment prose should be counted as comment')
  })

  it('ignores a one-line HTML comment', () => {
    const counts = analyse('one-line-comment', [
      '<template>',
      '  <!-- 编辑 / 新增 -->',
      "  <p>{{ t('x') }}</p>",
      '</template>'
    ])
    assert.equal(counts.template, 0)
    assert.equal(counts.script, 0)
  })

  it('still reports hard-coded text in markup', () => {
    const counts = analyse('markup', [
      '<template>',
      '  <p>硬编码文本</p>',
      '</template>'
    ])
    assert.equal(counts.template, 1)
    assert.equal(counts.script, 0)
  })

  it('still reports hard-coded text in a script string', () => {
    const counts = analyse('script-string', [
      '<script setup lang="ts">',
      "const label = '硬编码脚本文本'",
      '</script>'
    ])
    assert.equal(counts.template, 0)
    assert.equal(counts.script, 1)
  })

  it('reports text that follows a comment terminator on the same line', () => {
    // Stripping a block must not swallow the rest of the line: `--> 真实文本` is
    // markup a user can read.
    const counts = analyse('after-terminator', [
      '<template>',
      '  <!--',
      '       注释散文',
      '  --> 真实文本',
      '</template>'
    ])
    assert.equal(counts.template, 1)
  })

  it('counts markup after a nested template block closes', () => {
    // Regression 1: `<template v-if>` must not switch the template flag off.
    const counts = analyse('nested-template', [
      '<template>',
      '  <div>',
      '    <template v-if="a">',
      '      <span>硬编码</span>',
      '    </template>',
      '    <p>也应该被统计</p>',
      '  </div>',
      '</template>'
    ])
    assert.equal(counts.template, 2)
  })

  it('reports zero remaining user-facing Chinese in the renderer tree', () => {
    // The real guard. If this fails, the listed lines are text a user can read in
    // one language and not in the other three.
    const output = execFileSync(process.execPath, [script], {
      encoding: 'utf8',
      cwd: projectRoot
    })
    const remaining = /user-facing lines remaining: (\d+)/.exec(output)
    assert.ok(remaining, `unrecognised summary output:\n${output}`)
    assert.equal(Number(remaining[1]), 0, output)
    // A scanner that classified everything as a comment would also print 0, so
    // prove it is still reading the tree at all.
    const comments = /comment lines \(not translated by design\): (\d+)/.exec(output)
    assert.ok(comments, `unrecognised summary output:\n${output}`)
    assert.ok(Number(comments[1]) > 500, `scanner read almost nothing:\n${output}`)
    assert.ok(rendererRoot.length > 0)
  })
})
