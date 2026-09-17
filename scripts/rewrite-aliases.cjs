#!/usr/bin/env node
/**
 * Rewrite the `@shared/*` TypeScript path alias into relative requires in
 * compiled test output.
 *
 * WHY THIS EXISTS
 * The source tree uses the `@shared/*` alias (configured in the tsconfig files
 * and in electron-vite) so that main-process code and shared code can reference
 * each other without long `../../../` chains. TypeScript does NOT rewrite path
 * aliases on emit, and electron-vite normally handles that for the app build.
 *
 * The test build bypasses electron-vite (it just runs `tsc`), so the emitted
 * CommonJS still contains `@shared/...` specifiers that Node cannot resolve.
 * Node's own `imports` field only supports `#`-prefixed subpaths, so an alias
 * cannot be declared in package.json.
 *
 * Rather than distort the production tsconfig or the shared code to suit the
 * tests, this script fixes up the OUTPUT. The alternative — adding a test-only
 * alias to the real configs — would mean the tests exercise a slightly
 * different module graph than the app.
 */

const fs = require('node:fs')
const path = require('node:path')

const BUILD_DIR = path.resolve(__dirname, '..', '.test-build')
const ALIASES = [
  { prefix: '@shared/', target: 'src/shared/' },
  { prefix: '@main/', target: 'src/main/' }
]

/**
 * Relative prefix that takes a file in `fromDir` back to BUILD_DIR.
 *
 * `path.relative` already yields the correct number of `..` segments, so we
 * only need to guarantee a trailing separator (`./` for the root itself).
 */
function relativePrefix(fromDir) {
  const relative = path.relative(fromDir, BUILD_DIR)
  if (relative === '') return './'
  return `${relative.split(path.sep).join('/')}/`
}

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(full))
    else if (entry.name.endsWith('.js')) files.push(full)
  }
  return files
}

function rewrite(file) {
  const original = fs.readFileSync(file, 'utf8')
  let updated = original
  const fromDir = path.dirname(file)
  const up = relativePrefix(fromDir)

  for (const { prefix, target } of ALIASES) {
    // Match both `require("@shared/x")` and `from "@shared/x"` forms.
    const pattern = new RegExp(`(["'])${prefix.replace(/[/\\]/g, '\\$&')}([^"']+)\\1`, 'g')
    updated = updated.replace(pattern, (_match, quote, rest) => {
      return `${quote}${up}${target}${rest}${quote}`
    })
  }

  if (updated !== original) {
    fs.writeFileSync(file, updated)
    return true
  }
  return false
}

function main() {
  if (!fs.existsSync(BUILD_DIR)) {
    console.error(`[rewrite-aliases] build directory not found: ${BUILD_DIR}`)
    process.exit(1)
  }

  const files = walk(BUILD_DIR)
  let changed = 0
  for (const file of files) {
    if (rewrite(file)) changed += 1
  }
  console.log(`[rewrite-aliases] rewrote ${changed}/${files.length} compiled files`)
}

main()
