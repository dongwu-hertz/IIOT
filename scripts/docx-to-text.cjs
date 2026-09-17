#!/usr/bin/env node
'use strict'
/**
 * Convert a Word `.docx` into readable plain text.
 *
 * WHY THIS EXISTS
 * This project receives its device manuals as `.docx`, and nothing in the
 * repository can read Word. The manuals' value is concentrated in their TABLES
 * (endpoint catalogues, field lists, troubleshooting matrices), so a naive
 * conversion is actively harmful: `.docx` stores every table cell's content as a
 * sequence of `<w:p>` paragraphs, and "turn every `</w:p>` into a newline" explodes
 * one table row into one line per cell — an endpoint table then arrives as an
 * unreadable column.
 *
 * So the XML is walked token by token with a cell-depth counter:
 *   inside a cell, a paragraph break becomes a SPACE
 *   at cell end, a TAB
 *   at row end, a NEWLINE
 *   outside tables, a paragraph break is a newline again
 *
 * USAGE
 *   node scripts/docx-to-text.cjs <input.docx> [output.txt]
 *   node scripts/docx-to-text.cjs manual.docx docs/reference/manual.txt
 *
 * With no output path the text is written next to the input with a `.txt`
 * extension. The output is text only: images, layout, columns and styling are
 * lost, and the header of the generated file says so.
 */

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const os = require('node:os')

const TOKEN_RE =
  /<\/w:p>|<\/w:tc>|<\/w:tr>|<w:tc(?:\s[^>]*)?>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g

function decodeEntities(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
}

function documentToText(xml) {
  let out = ''
  let cellDepth = 0
  let rowBuffer = ''

  const flushRow = () => {
    // Trailing tabs (an empty last cell) carry no information.
    out += rowBuffer.replace(/\t+$/g, '') + '\n'
    rowBuffer = ''
  }

  TOKEN_RE.lastIndex = 0
  let match
  while ((match = TOKEN_RE.exec(xml)) !== null) {
    const token = match[0]
    if (token.startsWith('<w:t')) {
      const run = decodeEntities(match[1] ?? '')
      if (cellDepth > 0) rowBuffer += run
      else out += run
      continue
    }
    if (token.startsWith('<w:tab')) {
      if (cellDepth > 0) rowBuffer += ' '
      else out += '\t'
      continue
    }
    if (token.startsWith('<w:br')) {
      if (cellDepth > 0) rowBuffer += ' '
      else out += '\n'
      continue
    }
    if (token.startsWith('<w:tc')) {
      cellDepth += 1
      continue
    }
    if (token === '</w:tc>') {
      cellDepth = Math.max(0, cellDepth - 1)
      rowBuffer += '\t'
      continue
    }
    if (token === '</w:tr>') {
      cellDepth = 0
      flushRow()
      continue
    }
    if (token === '</w:p>') {
      if (cellDepth > 0) rowBuffer += ' '
      else out += '\n'
    }
  }
  if (rowBuffer.trim()) flushRow()

  return out
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
}

/**
 * Read `word/document.xml` out of the .docx.
 *
 * A .docx is a ZIP. Rather than pull in a zip dependency for one read, the archive
 * is expanded with the platform's own tooling: PowerShell's `Expand-Archive` on
 * Windows, `unzip` elsewhere. `Expand-Archive` insists on a `.zip` extension, hence
 * the copy into a temp directory. The temp directory is removed afterwards.
 */
function readDocumentXml(docxPath) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-to-text-'))
  try {
    if (process.platform === 'win32') {
      const zip = path.join(temp, 'document.zip')
      fs.copyFileSync(docxPath, zip)
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Expand-Archive -LiteralPath ${JSON.stringify(zip)} -DestinationPath ${JSON.stringify(
            path.join(temp, 'x')
          )} -Force`
        ],
        { stdio: 'pipe' }
      )
    } else {
      execFileSync('unzip', ['-q', '-o', docxPath, '-d', path.join(temp, 'x')], { stdio: 'pipe' })
    }
    return fs.readFileSync(path.join(temp, 'x', 'word', 'document.xml'), 'utf8')
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

const [, , input, output] = process.argv
if (!input) {
  console.error('usage: node scripts/docx-to-text.cjs <input.docx> [output.txt]')
  process.exit(2)
}
if (!fs.existsSync(input)) {
  console.error(`not found: ${input}`)
  process.exit(2)
}

const xml = readDocumentXml(input)
const text = documentToText(xml)
const target = output ?? input.replace(/\.docx$/i, '') + '.txt'
const header =
  `# ${path.basename(input)}\n` +
  `# Extracted from the .docx (word/document.xml) — text only; images and layout are lost.\n` +
  `# Regenerate with: node scripts/docx-to-text.cjs <input.docx> <output.txt>\n` +
  `# Tables are TAB-separated rows, one row per line.\n\n`

fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true })
fs.writeFileSync(target, header + text, 'utf8')
console.log(`${text.length} chars, ${text.split('\n').length} lines -> ${target}`)
