#!/usr/bin/env node
/**
 * Insert (or replace) top-level message blocks in every catalogue at once.
 *
 * WHY THIS IS A SCRIPT AND NOT EIGHT HAND EDITS PER LANGUAGE
 * A page's strings have to land in zh-CN, en, es and tr identically or the
 * parity test fails. Doing that by hand is 4x the edits and 4x the chance of a
 * typo that only shows up as a missing key at runtime. Passing the same literal
 * to one script makes the four catalogues structurally identical by construction.
 *
 * It also has to handle the case where a block ALREADY exists: adding a section
 * one at a time means revisiting the same block, so the script replaces an
 * existing top-level block rather than appending a duplicate key (a duplicate
 * object key is legal TypeScript and would silently shadow the first).
 *
 * USAGE
 *   node scripts/catalogue-block.cjs <blocks.json>
 *
 * `blocks.json` is `{ "en": { "configTime": "{ ... }" }, ... }` — the VALUE is
 * the literal block text including its trailing comma, or `null` to delete the
 * block. Because the payload is data rather than a template literal in this
 * file, catalogue text containing backticks or `${` cannot break the script.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const payloadPath = process.argv[2]
if (!payloadPath) {
  console.error('usage: node scripts/catalogue-block.cjs <blocks.json>')
  process.exit(1)
}

const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'))
const dir = path.join(__dirname, '..', 'src', 'shared', 'i18n', 'messages')

/** Find a top-level `  name: {` … matching `  },` block by brace depth. */
function findBlock(lines, name) {
  const start = lines.findIndex((line) => line === `  ${name}: {`)
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < lines.length; i += 1) {
    for (const ch of lines[i]) {
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) return { start, end: i }
      }
    }
  }
  return null
}

for (const [locale, blocks] of Object.entries(payload)) {
  const file = path.join(dir, `${locale}.ts`)
  const lines = fs.readFileSync(file, 'utf8').split('\n')

  for (const [name, text] of Object.entries(blocks)) {
    const existing = findBlock(lines, name)

    if (text === null) {
      if (!existing) {
        console.log(`${locale}.${name}: nothing to delete`)
        continue
      }
      // Swallow one trailing blank line so removals do not leave gaps behind.
      let removeTo = existing.end
      if (lines[removeTo + 1] === '') removeTo += 1
      lines.splice(existing.start, removeTo - existing.start + 1)
      console.log(`${locale}.${name}: removed`)
      continue
    }

    const inserted = text.replace(/\s+$/, '').split('\n')
    if (existing) {
      let removeTo = existing.end
      if (lines[removeTo + 1] === '') removeTo += 1
      lines.splice(existing.start, removeTo - existing.start + 1, ...inserted)
      console.log(`${locale}.${name}: replaced`)
    } else {
      // Keep the file's convention: insert before the trailing `domain:` block so
      // the taxonomy blocks stay at the bottom.
      const anchor = lines.findIndex((line) => line === '  domain: {')
      if (anchor === -1) throw new Error(`${locale}: domain anchor not found`)
      lines.splice(anchor, 0, ...inserted, '')
      console.log(`${locale}.${name}: inserted`)
    }
  }

  fs.writeFileSync(file, lines.join('\n'), 'utf8')
}
