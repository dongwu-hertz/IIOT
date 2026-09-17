#!/usr/bin/env node
/**
 * Report remaining hard-coded Chinese in the renderer.
 *
 * Used to drive the i18n migration (README §8.6) and to check progress without
 * reading every file. Deliberately reports COMMENT hits separately from
 * user-facing text: the codebase's explanatory comments are written in Chinese
 * by convention and are not part of the UI, so counting them as untranslated
 * work would be misleading.
 *
 * USAGE
 *   node scripts/i18n-progress.cjs             # summary by file
 *   node scripts/i18n-progress.cjs --file X.vue  # per-line detail for one file
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const rendererRoot = path.join(projectRoot, 'src', 'renderer', 'src')

const CJK = /[\u4e00-\u9fff]/

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(vue|ts)$/.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * Classify a line.
 *
 * `template`  — markup text, always user-facing.
 * `script`    — a string literal or template literal in a <script> block.
 * `comment`   — a `//`, `*` or `<!--` line, or a `<style>` block: not user-facing.
 *
 * The split is heuristic, not a parser, but it is accurate enough to separate
 * "real remaining work" from "comments we are not translating". HTML comments
 * count as comments too: a Chinese `<!-- 编辑 / 新增 -->` inside a template is
 * documentation for the next developer, not text a user can ever see.
 *
 * `line` is the LIVE part of the line only: `analyse()` strips anything that
 * began inside a multi-line comment before calling this, so the prefix tests
 * below still see the opener of a one-line comment (which is the point) but
 * never a continuation line.
 */
function classify(line, inTemplate) {
  const trimmed = line.trim()
  if (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('<!--')
  ) {
    return 'comment'
  }
  // Only count CJK that sits inside quotes, backticks or markup text.
  const inString = /(['"`])[^'"`]*[\u4e00-\u9fff]/.test(line)
  if (!inString && !inTemplate) return 'comment'
  return inTemplate ? 'template' : 'script'
}

function analyse(file) {
  const source = fs.readFileSync(file, 'utf8')
  const lines = source.split('\n')
  /**
   * Template NESTING DEPTH, not a boolean.
   *
   * REGRESSION: this used to be `if (trimmed === '</template>') inTemplate = false`,
   * which is wrong for any component that uses `<template v-if>` / `<template #slot>`
   * — the FIRST nested closing tag turned the flag off, so everything after it was
   * classified as a comment (a bare Chinese sentence has no quotes, and
   * `classify()` calls an unquoted non-template line a comment). The tool therefore
   * reported 0 remaining on files that still had hard-coded Chinese in them, which
   * is the worst possible failure for a progress meter: it says "done".
   *
   * Counting depth fixes it and keeps the outer `<template>`/`</template>` pair
   * working, because the SFC's own tags are balanced.
   */
  let templateDepth = 0
  /**
   * Multi-line comment state: `'html'` inside an HTML comment block, `'block'`
   * inside a C-style one. `null` when not inside either.
   *
   * REGRESSION (mirror image of the one above): `classify()` only looks at how a
   * line STARTS, so the opening line of a `<!-- ... -->` block was a comment while
   * every continuation line was not. A prose comment with no `*` gutter — the style
   * this codebase uses for its long "why" blocks — was therefore reported as
   * untranslated user-facing text. That is the opposite failure (it invents work
   * instead of hiding it), and it is just as useless: the number stops meaning
   * anything. Tracking the block fixes it.
   *
   * A block only opens when the opener starts the trimmed live line, which keeps a
   * `/*` or `<!--` inside a string literal from opening one. When the terminator is
   * on the line too, the remainder after it is classified normally, so `--> real
   * text` can still be reported.
   */
  let blockComment = null
  const counts = { template: 0, script: 0, comment: 0 }
  const details = []

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const trimmed = line.trim()
    if (/^<template(\s|>)/.test(trimmed)) templateDepth += 1
    if (/^<\/template>/.test(trimmed)) templateDepth = Math.max(0, templateDepth - 1)
    const inTemplate = templateDepth > 0

    // 1) A line that begins inside a block comment is a comment, whatever it
    //    starts with. Only the text after the terminator is live.
    let live = line
    if (blockComment !== null) {
      const terminator = blockComment === 'html' ? '-->' : '*/'
      const end = line.indexOf(terminator)
      if (end === -1) {
        if (CJK.test(line)) counts.comment += 1
        continue
      }
      live = line.slice(end + terminator.length)
      blockComment = null
    }

    // 2) Does this line OPEN a block that continues past it?
    const liveTrimmed = live.trim()
    if (liveTrimmed.startsWith('<!--')) {
      if (!liveTrimmed.slice(4).includes('-->')) blockComment = 'html'
    } else if (liveTrimmed.startsWith('/*')) {
      if (!liveTrimmed.slice(2).includes('*/')) blockComment = 'block'
    }

    if (!CJK.test(live)) {
      // A one-line comment (`<!-- 新增 -->`) has all of its Chinese inside the
      // comment and nothing live left; count it so the comment total stays honest.
      if (CJK.test(line)) counts.comment += 1
      continue
    }
    const kind = classify(live, inTemplate)
    counts[kind] += 1
    if (kind !== 'comment') details.push({ line: i + 1, kind, text: liveTrimmed.slice(0, 110) })
  }
  return { counts, details }
}

const targetFile = process.argv.includes('--file')
  ? process.argv[process.argv.indexOf('--file') + 1]
  : null

if (targetFile) {
  const full = path.isAbsolute(targetFile) ? targetFile : path.join(rendererRoot, targetFile)
  const { counts, details } = analyse(full)
  console.log(`${targetFile}: template=${counts.template} script=${counts.script} comments=${counts.comment}`)
  for (const d of details) console.log(`  ${String(d.line).padStart(4)} [${d.kind}] ${d.text}`)
  process.exit(0)
}

const files = walk(rendererRoot)
const analysed = files.map((file) => ({ file: path.relative(rendererRoot, file), ...analyse(file) }))
const results = analysed
  .filter((r) => r.counts.template + r.counts.script > 0)
  .sort((a, b) => b.counts.template + b.counts.script - (a.counts.template + a.counts.script))

let totalText = 0
let totalComments = 0
console.log('remaining user-facing Chinese (template + script), by file:\n')
for (const r of results) {
  const text = r.counts.template + r.counts.script
  totalText += text
  console.log(
    `  ${String(text).padStart(4)}  ${r.file}` +
      (r.counts.comment ? `   (${r.counts.comment} comment lines ignored)` : '')
  )
}

// Counted over every file, not just the ones still listed above: once the
// migration is complete this number is the only thing left to report, and a
// silent 0 would hide whether comments are being classified at all.
for (const r of analysed) totalComments += r.counts.comment

console.log(`\nfiles with remaining text: ${results.length}`)
console.log(`user-facing lines remaining: ${totalText}`)
console.log(`comment lines (not translated by design): ${totalComments}`)
