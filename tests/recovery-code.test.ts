/**
 * The support tool and the application must agree on recovery codes.
 *
 * `scripts/recovery-code.cjs` deliberately duplicates the derivation, because a
 * support engineer's machine has Node and nothing else — it cannot import the
 * application's TypeScript. That duplication is a real drift risk with a nasty
 * failure mode: support reads out a code, the operator types it, and the app says
 * "wrong super password" with no way for either side to tell who is right.
 *
 * So the duplicate is not trusted: this test RUNS the script and compares its
 * output with the application's own `recoveryCodeFor`, and checks that the two
 * accept and reject the same candidates.
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, it } from 'node:test'

import { recoveryCodeFor, verifyRecoveryCode } from '../src/main/services/auth/super-password'

const projectRoot = path.resolve(__dirname, '..', '..')
const script = path.join(projectRoot, 'scripts', 'recovery-code.cjs')

/** Run the support tool and return its stdout. */
function runTool(args: string[]): string {
  return execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' })
}

describe('recovery-code support tool', () => {
  const ids = ['AB12CD34EF567890', '0000000000000000', 'DEADBEEFCAFEF00D']

  it('issues exactly the code the application expects', () => {
    for (const id of ids) {
      const output = runTool([id])
      const expected = recoveryCodeFor(id)
      assert.ok(
        output.includes(expected),
        `tool disagreed with the app for ${id}: expected ${expected} in\n${output}`
      )
    }
  })

  it('accepts the same grouping and case the application accepts', () => {
    // The id is copied off a screen as `AB12-CD34-EF56-7890`; the tool must
    // normalise it the same way the app does.
    const grouped = 'AB12-CD34-EF56-7890'
    const bare = 'AB12CD34EF567890'
    assert.equal(recoveryCodeFor(bare), recoveryCodeFor(grouped))
    assert.ok(runTool([grouped]).includes(recoveryCodeFor(bare)))
    assert.ok(runTool([bare.toLowerCase()]).includes(recoveryCodeFor(bare)))
  })

  it('verifies a code it issued', () => {
    const id = 'AB12CD34EF567890'
    const code = recoveryCodeFor(id)
    const output = runTool(['--verify', id, code])
    assert.match(output, /^OK/m)
  })

  it('rejects a code issued for a different installation', () => {
    const output = (() => {
      try {
        return runTool(['--verify', 'AB12CD34EF567890', recoveryCodeFor('SOMETHINGELSE')])
      } catch (error) {
        // A non-zero exit is the tool's way of saying "no"; check the message.
        const failure = error as { stdout?: string }
        return failure.stdout ?? ''
      }
    })()
    assert.match(output, /^FAIL/m)
    // And the application agrees, so neither side is the odd one out.
    assert.equal(verifyRecoveryCode('AB12CD34EF567890', recoveryCodeFor('SOMETHINGELSE')), false)
  })
})
