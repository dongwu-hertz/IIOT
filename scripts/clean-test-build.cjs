/*
 * Delete `.test-build/` before a test build.
 *
 * WHY THIS EXISTS
 * `tsc -p tsconfig.tests.json` writes into `.test-build/` and **never removes an output whose
 * source file is gone**. Deleting or renaming a test (or a module it imports) therefore left the
 * old `.js` behind, and `node --test ".test-build/tests/**\/*.test.js"` kept running it — against
 * a stale compiled copy of the deleted module, so it kept passing.
 *
 * That is not a cosmetic annoyance: it means "the suite is green" could be true while the code it
 * claims to cover no longer exists. This project deletes code on purpose (every UI round removes
 * something), so the build has to start from an empty directory for the test run to mean anything.
 *
 * `fs.rmSync(..., { force: true })` is a no-op when the directory is already absent, so this is
 * safe to run on a fresh checkout.
 */
const fs = require('node:fs')
const path = require('node:path')

const target = path.resolve(__dirname, '..', '.test-build')
fs.rmSync(target, { recursive: true, force: true })
console.log(`[clean-test-build] removed ${target}`)
