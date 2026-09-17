#!/usr/bin/env node
/**
 * Re-apply the local patches this repository needs to build its native
 * dependencies on a modern Windows toolchain.
 *
 * WHY A SCRIPT INSTEAD OF HAND-EDITED FILES
 * Everything patched here lives under `node_modules/`, which npm owns and
 * rewrites. A hand edit therefore survives exactly until the next
 * `npm install`, `npm ci` or `npm rebuild`, and then the Windows build breaks
 * again with an error that looks nothing like its actual cause. Encoding the
 * patch as a script makes it reproducible, reviewable and idempotent.
 *
 * USAGE
 *   node scripts/patch-native-deps.cjs           # apply
 *   node scripts/patch-native-deps.cjs --check   # report only, exit 1 if unpatched
 *   node scripts/patch-native-deps.cjs --revert  # restore backups
 *
 * Run it after any dependency install. `npm run build` and the Electron native
 * rebuild both invoke it automatically (see package.json / BUILD.md).
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const nodeModules = path.join(projectRoot, 'node_modules')

// ---------------------------------------------------------------------------
// Patch definitions
// ---------------------------------------------------------------------------

/**
 * duckdb bundles a fork of {fmt} whose `checked_ptr` helper is gated on
 * `_SECURE_SCL`. VS2022 17.0 removed `stdext::checked_array_iterator` but still
 * defines `_SECURE_SCL`, so that branch no longer compiles:
 *
 *   format.h: error C2039: "checked_array_iterator": is not a member of "stdext"
 *   format.h: error C2061: syntax error: identifier "checked_array_iterator"
 *
 * Gate it on the toolset version that removed the type instead, so old toolsets
 * keep their behaviour and modern ones take the plain-pointer path.
 */
const FMT_CHECKED_ITERATOR = {
  id: 'duckdb/fmt checked_array_iterator',
  // INACTIVE as of the @duckdb/node-api migration: the `duckdb` package is no
  // longer a dependency, so this reports `skipped`. It is kept because the
  // migration is recent and reverting it would immediately need this patch
  // again; the script reports `skipped` rather than failing, so keeping it
  // costs nothing. Delete this entry once the migration is considered settled.
  file: path.join(
    nodeModules,
    'duckdb',
    'src',
    'duckdb',
    'third_party',
    'fmt',
    'include',
    'fmt',
    'format.h'
  ),
  marker: 'voiceprint-local-patch: fmt checked_ptr',
  find: `#ifdef _SECURE_SCL
// Make a checked iterator to avoid MSVC warnings.
template <typename T> using checked_ptr = stdext::checked_array_iterator<T*>;
template <typename T> checked_ptr<T> make_checked(T* p, std::size_t size) {
  return {p, size};
}
#else
template <typename T> using checked_ptr = T*;
template <typename T> inline T* make_checked(T* p, std::size_t) { return p; }
#endif`,
  replace: `// ${'voiceprint-local-patch: fmt checked_ptr'}
//
// VS2022 17.0 (MSVC 1930) removed stdext::checked_array_iterator from the
// Microsoft STL while STILL defining _SECURE_SCL, so the branch below could
// never compile on a modern toolset. The checked iterator only ever silenced an
// /W4 truncation warning, so a plain pointer is the correct modern equivalent.
// Bound to the toolset version rather than to _SECURE_SCL so older compilers
// keep their original behaviour.
#if defined(_SECURE_SCL) && defined(_MSC_VER) && _MSC_VER < 1930
// Make a checked iterator to avoid MSVC warnings.
template <typename T> using checked_ptr = stdext::checked_array_iterator<T*>;
template <typename T> checked_ptr<T> make_checked(T* p, std::size_t size) {
  return {p, size};
}
#else
template <typename T> using checked_ptr = T*;
template <typename T> inline T* make_checked(T* p, std::size_t) { return p; }
#endif`
}

/**
 * node-gyp does not recognise Visual Studio 2026.
 *
 * Its version table stops at VS2022 and `getVersionInfo()` returns an empty
 * object for major version 18, so a machine whose ONLY toolchain is VS2026
 * fails with "Could not find any Visual Studio installation to use" even with
 * `--msvs_version` supplied. Map major 18 onto the 2022 code path (VS2026 ships
 * MSVC 14.5x, which is the same toolset family) and report the toolset that
 * actually exists.
 *
 * This is required by `scripts/build-native-electron.cmd`, which is the
 * documented way to rebuild `better-sqlite3` for Electron's ABI on this project.
 */
const NODE_GYP_VS2026 = {
  id: 'node-gyp/Visual Studio 2026 support',
  file: path.join(nodeModules, 'node-gyp', 'lib', 'find-visualstudio.js'),
  marker: 'voiceprint-local-patch: VS2026',
  find: `    if (ret.versionMajor === 17) {
      ret.versionYear = 2022
      return ret
    }
    this.log.silly('- unsupported version:', ret.versionMajor)`,
  replace: `    if (ret.versionMajor === 17) {
      ret.versionYear = 2022
      return ret
    }
    // voiceprint-local-patch: VS2026
    // Visual Studio 2026 reports major version 18 and ships the v145 toolset
    // (MSVC 14.5x). node-gyp has no entry for it, so without this branch a
    // machine whose only toolchain is VS2026 fails with "Could not find any
    // Visual Studio installation to use".
    if (ret.versionMajor === 18) {
      ret.versionYear = 2022
      return ret
    }
    this.log.silly('- unsupported version:', ret.versionMajor)`
}

/**
 * The toolset for the VS2026 path is v145, NOT the v143 that the 2022 branch
 * assumes. Without this, generation succeeds but the build fails with
 * `MSB8020: cannot find the build tools for Visual Studio 2022 (v143)`.
 */
const NODE_GYP_V145_TOOLSET = {
  id: 'node-gyp/VS2026 v145 toolset',
  file: path.join(nodeModules, 'node-gyp', 'lib', 'find-visualstudio.js'),
  marker: 'voiceprint-local-patch: v145 toolset',
  find: `    if (versionYear === 2017) {
      return 'v141'
    } else if (versionYear === 2019) {
      return 'v142'
    } else if (versionYear === 2022) {
      return 'v143'
    }`,
  replace: `    if (versionYear === 2017) {
      return 'v141'
    } else if (versionYear === 2019) {
      return 'v142'
    } else if (versionYear === 2022) {
      // voiceprint-local-patch: v145 toolset
      // VS2026 is mapped onto the 2022 branch above but ships v145, not v143.
      // Returning v143 here fails with MSB8020 because that toolset is not
      // installed. The version string is what distinguishes the two.
      if (info.versionMajor === 18 || /^18\\./.test(info.version)) {
        return 'v145'
      }
      return 'v143'
    }`
}

const PATCHES = [FMT_CHECKED_ITERATOR, NODE_GYP_VS2026, NODE_GYP_V145_TOOLSET]

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const mode = process.argv.includes('--check')
  ? 'check'
  : process.argv.includes('--revert')
    ? 'revert'
    : 'apply'

/**
 * Backups are taken PER FILE, not per patch.
 *
 * Several patches can touch the same file (node-gyp's VS2026 support is two
 * edits to `find-visualstudio.js`). A per-patch backup scheme breaks on the
 * second one: by then the file already contains the first patch, so the "clean"
 * copy being preserved is not clean at all, and a revert brings the first patch
 * back from the dead. The first backup taken for a file wins; subsequent patches
 * to that file reuse it.
 */
function backupPath(file) {
  return `${file}.prepatch`
}

function ensureBackup(file) {
  const backup = backupPath(file)
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(file, backup)
  }
  return backup
}

function applyPatch(patch) {
  if (!fs.existsSync(patch.file)) {
    return { id: patch.id, status: 'skipped', detail: 'file not present' }
  }
  const source = fs.readFileSync(patch.file, 'utf8')

  if (source.includes(patch.marker)) {
    return { id: patch.id, status: 'already' }
  }
  if (!source.includes(patch.find)) {
    return {
      id: patch.id,
      status: 'unmatched',
      detail: 'expected source text not found — dependency version changed?'
    }
  }

  if (mode === 'check') {
    return { id: patch.id, status: 'needed' }
  }

  ensureBackup(patch.file)
  fs.writeFileSync(patch.file, source.replace(patch.find, patch.replace))
  return { id: patch.id, status: 'applied' }
}

// Reverting touches files, not individual patch texts, so collapse to one
// operation per file BEFORE reverting to avoid restoring the same backup twice.
function revertAll() {
  const files = [...new Set(PATCHES.map((patch) => patch.file))]
  const results = []
  for (const file of files) {
    const patchesForFile = PATCHES.filter((patch) => patch.file === file)
    const backup = backupPath(file)
    if (!fs.existsSync(file)) {
      for (const patch of patchesForFile) {
        results.push({ id: patch.id, status: 'skipped', detail: 'file not present' })
      }
      continue
    }
    if (!fs.existsSync(backup)) {
      for (const patch of patchesForFile) {
        results.push({ id: patch.id, status: 'no-backup' })
      }
      continue
    }
    fs.copyFileSync(backup, file)
    fs.rmSync(backup, { force: true })
    for (const patch of patchesForFile) {
      results.push({ id: patch.id, status: 'reverted' })
    }
  }
  return results
}

const results = mode === 'revert' ? revertAll() : PATCHES.map((patch) => applyPatch(patch))

for (const result of results) {
  const suffix = result.detail ? ` (${result.detail})` : ''
  console.log(`[patch-native-deps] ${result.status.padEnd(9)} ${result.id}${suffix}`)
}

const needsAttention = results.some(
  (r) => r.status === 'unmatched' || (mode === 'check' && r.status === 'needed')
)
if (needsAttention) {
  if (mode === 'check') {
    console.error(
      '\n[patch-native-deps] Patches are missing. Run: node scripts/patch-native-deps.cjs'
    )
  }
  process.exit(1)
}
