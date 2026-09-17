/**
 * Tests for `StorageService.resolve()`.
 *
 * WHY THIS FILE EXISTS
 * `resolve()` is the guard that stops a tampered database row from reading or
 * writing outside the storage root. During Phase 11 it turned out to have the
 * opposite failure mode from the one it was written to prevent: it assumed its
 * input was always a RELATIVE path, so handing it an absolute one stripped the
 * leading separator and re-joined the whole thing onto the root. The result was
 * a file written to `<root>/var/folders/.../<root>/metrics/...` — silently, with
 * no error, while the query layer looked in the correct place and found nothing.
 *
 * Both directions are therefore pinned here: absolute input must pass through
 * unchanged, relative input must resolve against the root, and anything that
 * escapes the root must throw.
 */

import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { StorageService } from '../src/main/services/storage/storage-service'
import { openDatabase } from '../src/main/services/database/schema'
import { AppError } from '../src/shared/errors'
import type { Database as SqliteDatabase } from 'better-sqlite3'

let root: string
let db: SqliteDatabase
let storage: StorageService

/**
 * Assertions about the SHAPE of a path must not depend on the host separator.
 *
 * `metricsFile` returns an absolute path built with `path.join`, which on
 * Windows contains `\`. A literal `includes('/metrics/')` therefore fails on
 * Windows while the code is behaving correctly — the check was asserting the
 * developer's platform, not the behaviour. Normalising to POSIX separators
 * before matching keeps the intent (segment order and naming) intact, and is
 * what `buildClipPaths` already does for the paths it stores.
 */
function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'hz-storage-test-'))
  db = openDatabase({ file: ':memory:' })
  storage = new StorageService({
    db,
    getStorageRoot: () => root,
    getMinFreeBytes: () => 0
  })
})

after(async () => {
  try {
    db.close()
  } catch {
    // Already closed.
  }
  await fs.rm(root, { recursive: true, force: true })
})

describe('StorageService.resolve', () => {
  it('resolves a relative path against the storage root', () => {
    const resolved = storage.resolve('audio/dev/2026/01/01/CH01/alarm/x.wav')
    assert.equal(resolved, path.join(root, 'audio/dev/2026/01/01/CH01/alarm/x.wav'))
  })

  it('returns an absolute path INSIDE the root unchanged', () => {
    // THE REGRESSION. `metricsFile()` and `buildClipPaths()` both return absolute
    // paths, and passing one back used to prefix the root a second time.
    const absolute = path.join(root, 'metrics', 'dev', '2026', '2026-01-01.parquet')
    assert.equal(storage.resolve(absolute), absolute)
  })

  it('round-trips every path builder through resolve', () => {
    // These are exactly the pairings the writers use, so a regression here would
    // break trend and audio writes at the same time.
    const cases = [
      storage.metricsFile('mac:aa:bb:cc:dd:ee:ff', Date.UTC(2026, 0, 1)),
      storage.buildClipPaths({
        deviceUid: 'mac:aa:bb:cc:dd:ee:ff',
        channelIndex: 0,
        kind: 'alarm',
        startTime: Date.UTC(2026, 0, 1),
        extension: 'wav'
      }).absolutePath
    ]

    for (const built of cases) {
      const resolved = storage.resolve(built)
      assert.equal(resolved, built, `resolve() mangled an absolute path: ${built}`)
      // The specific failure mode, asserted directly: the root must not appear
      // twice in the result.
      assert.equal(
        resolved.split(path.join(root, '')).length - 1,
        1,
        `root appears more than once: ${resolved}`
      )
    }
  })

  it('normalises . and .. segments inside the root', () => {
    const resolved = storage.resolve('audio/./dev/../dev/x.wav')
    assert.equal(resolved, path.join(root, 'audio', 'dev', 'x.wav'))
  })

  it('rejects a relative path that escapes the root', () => {
    assert.throws(
      () => storage.resolve('../../etc/passwd'),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.equal(error.code, 'STORAGE_ERROR')
        return true
      }
    )
  })

  it('rejects an absolute path outside the root', () => {
    assert.throws(
      () => storage.resolve('/etc/passwd'),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.equal(error.code, 'STORAGE_ERROR')
        return true
      }
    )
  })

  it('accepts the root itself', () => {
    assert.equal(storage.resolve(root), path.resolve(root))
  })

  it('does not treat a sibling directory as inside the root', () => {
    // A naive prefix check passes for `/data/root-evil` when the root is
    // `/data/root`. The separator check in `resolve` must catch this.
    assert.throws(() => storage.resolve(`${root}-evil/file.wav`))
  })

  it('preserves file names containing characters that are legal on POSIX', () => {
    // The previous implementation rewrote backslashes, corrupting such names.
    const name = 'audio/dev/weird\\name.wav'
    const resolved = storage.resolve(name)
    assert.ok(resolved.startsWith(path.resolve(root) + path.sep))
    assert.ok(resolved.endsWith('weird\\name.wav'))
  })
})

describe('StorageService.writeFile', () => {
  it('writes inside the root and creates parent directories', async () => {
    const target = path.join(root, 'export', 'nested', 'deep', 'file.bin')
    await storage.writeFile(target, new Uint8Array([1, 2, 3]))

    const written = await fs.readFile(target)
    assert.deepEqual(Array.from(written), [1, 2, 3])
  })

  it('leaves no .part file behind on success', async () => {
    const target = path.join(root, 'export', 'atomic.bin')
    await storage.writeFile(target, new Uint8Array([9]))

    const entries = await fs.readdir(path.join(root, 'export'))
    assert.ok(!entries.some((entry) => entry.endsWith('.part')), 'a temporary file survived')
  })

  it('refuses to write outside the root', async () => {
    await assert.rejects(
      () => storage.writeFile(path.join(root, '..', 'escape.bin'), new Uint8Array([1])),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.equal(error.code, 'STORAGE_ERROR')
        return true
      }
    )
  })
})

describe('StorageService path layout', () => {
  it('builds the spec directory layout for clips', () => {
    // Spec 4.4: audio/<uid>/<YYYY>/<MM>/<DD>/CH<nn>/<kind>/
    const built = storage.buildClipPaths({
      deviceUid: 'mac:aa:bb:cc:dd:ee:ff',
      channelIndex: 2,
      kind: 'alarm',
      startTime: new Date(2026, 1, 26, 14, 5, 33).getTime(),
      extension: 'wav'
    })

    // The uid is sanitised, so the colon must not survive into the directory.
    assert.ok(built.relativePath.includes('mac_aa_bb_cc_dd_ee_ff'), built.relativePath)
    assert.ok(built.relativePath.includes('/2026/02/26/'), built.relativePath)
    assert.ok(built.relativePath.includes('CH03'), built.relativePath)
    assert.ok(built.relativePath.includes('/alarm/'), built.relativePath)
    assert.ok(built.relativePath.endsWith('.wav'), built.relativePath)
    // Stored paths are ALWAYS relative, so the root can be moved (spec 4.1).
    assert.ok(!path.isAbsolute(built.relativePath), 'relativePath must not be absolute')
  })

  it('builds a per-device per-day metrics file', () => {
    const file = storage.metricsFile('mac:aa:bb:cc:dd:ee:ff', new Date(2026, 1, 26).getTime())
    const normalised = toPosix(file)
    assert.ok(normalised.includes('/metrics/'), file)
    assert.ok(normalised.includes('mac_aa_bb_cc_dd_ee_ff'), file)
    assert.ok(normalised.endsWith('2026-02-26.parquet'), file)
  })

  it('sanitises a device uid that would otherwise break the path', () => {
    // UIDs come from the database, and a MAC fallback contains colons, which are
    // illegal in a Windows path.
    const built = storage.buildClipPaths({
      deviceUid: 'aa:bb:cc:dd:ee:ff',
      channelIndex: 0,
      kind: 'manual',
      startTime: Date.now(),
      extension: 'wav'
    })
    assert.ok(!built.relativePath.includes(':'), 'a colon survived into a path')
  })
})
