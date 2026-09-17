/**
 * Application account tests.
 *
 * These cover the parts of authentication that are easy to get subtly wrong and
 * expensive to notice: the derivation is one-way, verification actually rejects,
 * the throttling window is real, and the authorisation rules (last administrator,
 * cannot delete yourself) hold.
 *
 * The hashing tests are deliberately slow-ish (scrypt at N=32768 is ~50 ms), so a
 * single derivation is shared rather than repeated per assertion.
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { openDatabase, SCHEMA_VERSION } from '../src/main/services/database/schema'
import { AppMetaRepository, UserRepository } from '../src/main/services/database/user-repository'
import { AuthService } from '../src/main/services/auth/auth-service'
import { hashPassword, verifyPassword } from '../src/main/services/auth/password'
import {
  groupCode,
  normaliseCode,
  recoveryCodeFor,
  verifyRecoveryCode
} from '../src/main/services/auth/super-password'
import { AppError } from '../src/shared/errors'
import {
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_ADMIN_USERNAME,
  PASSWORD_MIN_LENGTH
} from '../src/shared/domain/auth'

function freshAuth(now?: () => number): {
  auth: AuthService
  users: UserRepository
  meta: AppMetaRepository
} {
  const db = openDatabase({ file: ':memory:' })
  const users = new UserRepository(db)
  const meta = new AppMetaRepository(db)
  const auth = new AuthService({ users, meta, ...(now ? { now } : {}) })
  return { auth, users, meta }
}

/** A seeded installation: one factory administrator. */
function seeded(now?: () => number): ReturnType<typeof freshAuth> {
  const context = freshAuth(now)
  context.auth.ensureSeedAccount()
  return context
}

function codeOf(error: unknown): string {
  assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`)
  return error.code
}

describe('password derivation', () => {
  const stored = hashPassword('correct horse battery staple')

  it('never stores the password itself', () => {
    // The whole point: the application must be able to VERIFY, never recover.
    assert.ok(!stored.includes('correct horse battery staple'))
    assert.match(stored, /^scrypt\$/)
  })

  it('is salted, so the same password hashes differently every time', () => {
    assert.notEqual(hashPassword('same-password'), hashPassword('same-password'))
  })

  it('records its own parameters, so a future cost increase cannot invalidate it', () => {
    // Self-describing format: verification reads N/r/p out of the hash instead of
    // assuming today's constants, which is what makes raising the cost safe.
    const [algorithm, n, r, p] = stored.split('$')
    assert.equal(algorithm, 'scrypt')
    assert.ok(Number(n) >= 16384, `cost too low: ${n}`)
    assert.ok(Number(r) > 0 && Number(p) > 0)
  })

  it('accepts the right password', () => {
    assert.equal(verifyPassword('correct horse battery staple', stored), true)
  })

  it('rejects a wrong password', () => {
    assert.equal(verifyPassword('correct horse battery stapl', stored), false)
    assert.equal(verifyPassword('', stored), false)
    assert.equal(verifyPassword('CORRECT HORSE BATTERY STAPLE', stored), false)
  })

  it('normalises unicode, so a composed and a decomposed spelling both work', () => {
    // A password typed on a phone may arrive decomposed; refusing it would look
    // like a wrong password.
    const composed = 'pässwörd-mit-ümlaut'
    const decomposed = composed.normalize('NFD')
    assert.notEqual(composed, decomposed)
    assert.equal(verifyPassword(decomposed, hashPassword(composed)), true)
  })

  it('treats a malformed stored hash as a failure, never a crash', () => {
    for (const broken of ['', 'nonsense', 'scrypt$1$2$3$4', 'bcrypt$1$1$1$a$b', 'scrypt$x$y$z$a$b']) {
      assert.equal(verifyPassword('anything', broken), false, `threw or passed on ${broken}`)
    }
  })
})

describe('installation recovery code', () => {
  it('is deterministic for an installation', () => {
    assert.equal(recoveryCodeFor('AB12CD34'), recoveryCodeFor('AB12CD34'))
  })

  it('differs between installations', () => {
    // The property that makes a leaked code useless elsewhere — the whole reason
    // this is not one factory password.
    assert.notEqual(recoveryCodeFor('AB12CD34'), recoveryCodeFor('AB12CD35'))
  })

  it('is formatted for reading aloud', () => {
    const code = recoveryCodeFor('AB12CD34')
    assert.match(code, /^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/)
    assert.equal(groupCode('ABCDEFGH'), 'ABCD-EFGH')
  })

  it('verifies regardless of case, spacing and dashes', () => {
    // These get typed by a human reading them off a phone call.
    const code = recoveryCodeFor('AB12CD34')
    assert.ok(verifyRecoveryCode('AB12CD34', code))
    assert.ok(verifyRecoveryCode('AB12CD34', code.toLowerCase()))
    assert.ok(verifyRecoveryCode('AB12CD34', normaliseCode(code)))
    assert.ok(verifyRecoveryCode('AB12CD34', ` ${code.replace(/-/g, ' ')} `))
  })

  it('rejects a wrong or truncated code', () => {
    const code = recoveryCodeFor('AB12CD34')
    assert.equal(verifyRecoveryCode('AB12CD34', 'AAAA-AAAA-AAAA-AAAA'.slice(0, 19)), false)
    assert.equal(verifyRecoveryCode('AB12CD34', code.slice(0, -1)), false)
    assert.equal(verifyRecoveryCode('AB12CD34', 'AAAA-AAAA-AAAA-AAAA'), false)
  })

  it('rejects a code issued for a different installation', () => {
    assert.equal(verifyRecoveryCode('AB12CD34', recoveryCodeFor('ZZZZZZZZ')), false)
  })
})

describe('schema 4', () => {
  it('brings the database to at least the accounts version', () => {
    const db = openDatabase({ file: ':memory:' })
    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION)
    // `>= 4`, NOT `=== 4`.
    //
    // This was pinned to an exact number, and that pinned number then became an
    // obstacle: an unrelated feature needed a migration of its own, and this test
    // — which is about ACCOUNTS — would have failed for a reason that has nothing
    // to do with accounts. What this test is entitled to assert is that the
    // migration that introduced `users` has run, i.e. that the accounts schema is
    // present. Any later version still satisfies that.
    assert.ok(SCHEMA_VERSION >= 4, `accounts migration missing: SCHEMA_VERSION=${SCHEMA_VERSION}`)
  })

  it('rejects a role the application does not know', () => {
    const { users } = freshAuth()
    assert.throws(() =>
      users.insert({
        username: 'x',
        // @ts-expect-error deliberately invalid role, to prove the CHECK fires
        role: 'superuser',
        passwordHash: 'scrypt$1$1$1$a$b',
        mustChangePassword: false
      })
    )
  })

  it('treats usernames case-insensitively', () => {
    // Otherwise `Admin` becomes a second administrator nobody notices.
    const { users } = freshAuth()
    users.insert({
      username: 'Admin',
      role: 'admin',
      passwordHash: 'scrypt$1$1$1$a$b',
      mustChangePassword: false
    })
    assert.ok(users.findByUsername('admin'))
    assert.ok(users.findByUsername('ADMIN'))
    assert.throws(() =>
      users.insert({
        username: 'admin',
        role: 'operator',
        passwordHash: 'scrypt$1$1$1$a$b',
        mustChangePassword: false
      })
    )
  })
})

describe('factory account seeding', () => {
  it('creates exactly one administrator on an empty database', () => {
    const { auth, users } = freshAuth()
    const result = auth.ensureSeedAccount()
    assert.equal(result.created, true)
    assert.equal(users.count(), 1)
    assert.equal(users.list()[0]?.username, DEFAULT_ADMIN_USERNAME)
    assert.equal(users.list()[0]?.role, 'admin')
  })

  it('marks the factory password as needing a change', () => {
    const { auth, users } = seeded()
    assert.equal(users.list()[0]?.mustChangePassword, true)
    const outcome = auth.login({ username: DEFAULT_ADMIN_USERNAME, password: DEFAULT_ADMIN_PASSWORD })
    assert.equal(outcome.mustChangePassword, true)
  })

  it('does not re-seed while any account exists', () => {
    // ensureSeedAccount runs on every startup; it must only ever fire once, or a
    // deliberately renamed/removed administrator would come back at each launch.
    const { auth, users } = seeded()
    const admin = users.list()[0]
    assert.ok(admin)
    const operator = users.insert({
      username: 'operator1',
      role: 'operator',
      passwordHash: hashPassword('operator-password'),
      mustChangePassword: false
    })
    users.remove(admin.id)

    assert.equal(auth.ensureSeedAccount().created, false)
    assert.deepEqual(users.list().map((user) => user.username), [operator.username])
  })

  it('re-seeds only when EVERY account is gone, as the way back in', () => {
    // The service refuses to delete the last administrator, so this state is only
    // reachable by editing the database directly — and re-creating the factory
    // account is then the correct recovery rather than an empty installation
    // nobody can administer.
    const { auth, users } = seeded()
    const admin = users.list()[0]
    assert.ok(admin)
    users.remove(admin.id)
    assert.equal(auth.ensureSeedAccount().created, true)
    assert.equal(users.count(), 1)
  })
})

describe('login', () => {
  it('accepts the factory credentials', () => {
    const { auth } = seeded()
    const outcome = auth.login({ username: 'admin', password: DEFAULT_ADMIN_PASSWORD })
    assert.equal(outcome.session.user.username, 'admin')
    assert.equal(outcome.session.user.role, 'admin')
    assert.equal(auth.currentSession()?.user.id, outcome.session.user.id)
  })

  it('is case-insensitive about the username', () => {
    const { auth } = seeded()
    assert.equal(auth.login({ username: 'ADMIN', password: DEFAULT_ADMIN_PASSWORD }).session.user.username, 'admin')
  })

  it('rejects a wrong password without revealing whether the account exists', () => {
    const { auth } = seeded()
    assert.equal(codeOf(catchError(() => auth.login({ username: 'admin', password: 'nope' }))), 'AUTH_FAILED')
    assert.equal(codeOf(catchError(() => auth.login({ username: 'ghost', password: 'nope' }))), 'AUTH_FAILED')
  })

  it('never puts a password hash in the session', () => {
    const { auth } = seeded()
    const outcome = auth.login({ username: 'admin', password: DEFAULT_ADMIN_PASSWORD })
    assert.ok(!JSON.stringify(outcome).includes('scrypt'))
    // `permissions` 是手册 §17.1 的权限目录，**不是**秘密：它是"这个账户能做什么"，
    // 而界面必须能逐项渲染它。这一条断言防的是 `passwordHash` 那一类东西漏出去，
    // 所以清单里每出现一个新字段都必须是**有意**加进来的。
    assert.deepEqual(Object.keys(outcome.session.user).sort(), [
      'createdAt',
      'displayName',
      'id',
      'mustChangePassword',
      'permissions',
      'role',
      'username'
    ])
    // 管理员出厂即全权（手册 §17.1）。
    assert.equal(
      Object.values(outcome.session.user.permissions ?? {}).every((granted) => granted === true),
      true
    )
  })

  it('records the last login time', () => {
    let clock = 1_000
    const { auth, users } = seeded(() => clock)
    auth.login({ username: 'admin', password: DEFAULT_ADMIN_PASSWORD })
    assert.equal(users.list()[0]?.lastLoginAt, 1_000)
    clock = 2_000
    auth.login({ username: 'admin', password: DEFAULT_ADMIN_PASSWORD })
    assert.equal(users.list()[0]?.lastLoginAt, 2_000)
  })

  it('clears the session on logout', () => {
    const { auth } = seeded()
    auth.login({ username: 'admin', password: DEFAULT_ADMIN_PASSWORD })
    auth.logout()
    assert.equal(auth.currentSession(), undefined)
  })
})

describe('login throttling', () => {
  it('locks the account after five failures and unlocks after the window', () => {
    let clock = 0
    const { auth } = seeded(() => clock)

    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal(codeOf(catchError(() => auth.login({ username: 'admin', password: 'wrong' }))), 'AUTH_FAILED')
    }

    // Even the CORRECT password is refused while locked: otherwise the lockout
    // would only slow an attacker who is guessing badly.
    //
    // AUTH_LOCKED, not FORBIDDEN: the login screen translates by code, and a
    // lockout reported as "you are not allowed to do that" told the user the
    // opposite of what had happened (their password was wrong; waiting fixes it).
    const locked = catchError(() => auth.login({ username: 'admin', password: DEFAULT_ADMIN_PASSWORD }))
    assert.equal(codeOf(locked), 'AUTH_LOCKED')
    // The delay is the actionable part and must survive to the renderer.
    assert.match((locked as AppError).detail ?? '', /retryAfterSeconds=\d+/)

    clock += 61_000
    assert.equal(auth.login({ username: 'admin', password: DEFAULT_ADMIN_PASSWORD }).session.user.username, 'admin')
  })

  it('does not lock a different account', () => {
    const { auth, users } = seeded()
    const admin = users.list()[0]
    assert.ok(admin)
    users.insert({
      username: 'operator1',
      role: 'operator',
      passwordHash: hashPassword('operator-password'),
      mustChangePassword: false
    })

    for (let attempt = 0; attempt < 5; attempt += 1) {
      catchError(() => auth.login({ username: 'operator1', password: 'wrong' }))
    }
    assert.equal(auth.login({ username: 'admin', password: DEFAULT_ADMIN_PASSWORD }).session.user.role, 'admin')
  })

  it('clears the failure count on a successful login', () => {
    const { auth } = seeded()
    for (let attempt = 0; attempt < 4; attempt += 1) {
      catchError(() => auth.login({ username: 'admin', password: 'wrong' }))
    }
    auth.login({ username: 'admin', password: DEFAULT_ADMIN_PASSWORD })
    for (let attempt = 0; attempt < 4; attempt += 1) {
      catchError(() => auth.login({ username: 'admin', password: 'wrong' }))
    }
    // Still not locked: the counter restarted.
    assert.equal(codeOf(catchError(() => auth.login({ username: 'admin', password: 'wrong' }))), 'AUTH_FAILED')
  })
})

describe('changing a password', () => {
  it('requires the current password', () => {
    const { auth } = seeded()
    auth.login({ username: 'admin', password: DEFAULT_ADMIN_PASSWORD })
    assert.equal(
      codeOf(catchError(() => auth.changePassword({ currentPassword: 'wrong', newPassword: 'brand-new-pass' }))),
      'AUTH_FAILED'
    )
  })

  it('clears mustChangePassword and lets the new password work', () => {
    const { auth, users } = seeded()
    auth.login({ username: 'admin', password: DEFAULT_ADMIN_PASSWORD })
    const updated = auth.changePassword({
      currentPassword: DEFAULT_ADMIN_PASSWORD,
      newPassword: 'brand-new-pass'
    })
    assert.equal(updated.mustChangePassword, false)
    assert.equal(users.list()[0]?.mustChangePassword, false)
    assert.equal(auth.login({ username: 'admin', password: 'brand-new-pass' }).mustChangePassword, false)
    assert.equal(codeOf(catchError(() => auth.login({ username: 'admin', password: DEFAULT_ADMIN_PASSWORD }))), 'AUTH_FAILED')
  })

  it('enforces the policy', () => {
    const { auth } = seeded()
    auth.login({ username: 'admin', password: DEFAULT_ADMIN_PASSWORD })
    /**
     * 下限从 8 改成 6 是**照手册**（§17.1 第 5199 行：the length of the password
     * cannot be less than 6 characters），所以"短"的样本也从 `'short1'`（6 位，现在
     * 合法）改成 `'short'`（5 位）。这里把**边界**两侧都钉住，而不是只钉"某一句被拒"。
     */
    assert.equal(PASSWORD_MIN_LENGTH, 6, '手册写死 6，界面文案的 {min} 也取这个常量')
    const cases: Array<[string, string]> = [
      ['short', 'AUTH_PASSWORD_POLICY'],
      ['admin-password-1', 'AUTH_PASSWORD_POLICY'],
      [' padded-password ', 'AUTH_PASSWORD_POLICY']
    ]
    for (const [candidate, expected] of cases) {
      assert.equal(
        codeOf(catchError(() =>
          auth.changePassword({ currentPassword: DEFAULT_ADMIN_PASSWORD, newPassword: candidate })
        )),
        expected,
        `expected ${JSON.stringify(candidate)} to be rejected`
      )
    }
    // A password that satisfies every rule is accepted, so the policy is not
    // simply rejecting everything.
    assert.doesNotThrow(() =>
      auth.changePassword({
        currentPassword: DEFAULT_ADMIN_PASSWORD,
        newPassword: 'x'.repeat(PASSWORD_MIN_LENGTH)
      })
    )
  })

  it('refuses to reuse the current password', () => {
    const { auth } = seeded()
    auth.login({ username: 'admin', password: DEFAULT_ADMIN_PASSWORD })
    assert.equal(
      codeOf(catchError(() =>
        auth.changePassword({
          currentPassword: DEFAULT_ADMIN_PASSWORD,
          newPassword: DEFAULT_ADMIN_PASSWORD
        })
      )),
      'VALIDATION_ERROR'
    )
  })

  it('refuses without a session', () => {
    const { auth } = seeded()
    assert.equal(
      codeOf(catchError(() => auth.changePassword({ currentPassword: 'a', newPassword: 'bbbbbbbbb' }))),
      'AUTH_FAILED'
    )
  })
})

describe('recovery with the super password', () => {
  it('resets the password of an existing account without a session', () => {
    const { auth } = seeded()
    const code = recoveryCodeFor(normaliseCode(auth.installId()))

    const updated = auth.recoverAccount({
      username: 'admin',
      superPassword: code,
      newPassword: 'recovered-pass'
    })
    assert.equal(updated.mustChangePassword, false)
    assert.equal(auth.login({ username: 'admin', password: 'recovered-pass' }).session.user.username, 'admin')
  })

  it('rejects a wrong super password', () => {
    const { auth } = seeded()
    assert.equal(
      codeOf(catchError(() =>
        auth.recoverAccount({ username: 'admin', superPassword: 'AAAA-AAAA-AAAA-AAAA', newPassword: 'whatever-pass' })
      )),
      'AUTH_FAILED'
    )
  })

  it('rejects a code belonging to another installation', () => {
    const { auth } = seeded()
    assert.equal(
      codeOf(catchError(() =>
        auth.recoverAccount({
          username: 'admin',
          superPassword: recoveryCodeFor('SOMEONE-ELSE'),
          newPassword: 'whatever-pass'
        })
      )),
      'AUTH_FAILED'
    )
  })

  it('cannot create an account, only reset one that exists', () => {
    const { auth, users } = seeded()
    const code = recoveryCodeFor(normaliseCode(auth.installId()))
    assert.equal(
      codeOf(catchError(() =>
        auth.recoverAccount({ username: 'brand-new', superPassword: code, newPassword: 'whatever-pass' })
      )),
      'VALIDATION_ERROR'
    )
    assert.equal(users.count(), 1)
  })

  it('cannot change a role', () => {
    const { auth, users } = seeded()
    const operator = users.insert({
      username: 'operator1',
      role: 'operator',
      passwordHash: hashPassword('operator-password'),
      mustChangePassword: false
    })
    const code = recoveryCodeFor(normaliseCode(auth.installId()))
    const updated = auth.recoverAccount({
      username: 'operator1',
      superPassword: code,
      newPassword: 'recovered-pass'
    })
    assert.equal(updated.role, 'operator')
    assert.equal(users.findById(operator.id)?.role, 'operator')
  })

  it('clears an active lockout, because a locked-out administrator is who it is for', () => {
    let clock = 0
    const { auth } = seeded(() => clock)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      catchError(() => auth.login({ username: 'admin', password: 'wrong' }))
    }
    assert.equal(
      codeOf(catchError(() => auth.login({ username: 'admin', password: DEFAULT_ADMIN_PASSWORD }))),
      'AUTH_LOCKED'
    )

    auth.recoverAccount({
      username: 'admin',
      superPassword: recoveryCodeFor(normaliseCode(auth.installId())),
      newPassword: 'recovered-pass'
    })
    assert.equal(auth.login({ username: 'admin', password: 'recovered-pass' }).session.user.username, 'admin')
  })

  it('is stable across a restart, because the install id is persisted', () => {
    // If the id were regenerated the previously issued code would stop working
    // and support would have to reissue it.
    const db = openDatabase({ file: ':memory:' })
    const users = new UserRepository(db)
    const meta = new AppMetaRepository(db)
    const first = new AuthService({ users, meta })
    first.ensureSeedAccount()
    const installId = first.installId()

    const second = new AuthService({ users, meta })
    assert.equal(second.installId(), installId)
    assert.ok(
      verifyRecoveryCode(normaliseCode(installId), recoveryCodeFor(normaliseCode(installId)))
    )
  })
})

describe('account management', () => {
  function withOperator(): ReturnType<typeof seeded> & { operatorId: string } {
    const context = seeded()
    context.auth.login({ username: 'admin', password: DEFAULT_ADMIN_PASSWORD })
    const created = context.auth.createUser({
      username: 'operator1',
      password: 'operator-password',
      role: 'operator'
    })
    return { ...context, operatorId: created.id }
  }

  it('requires an administrator', () => {
    const { auth, operatorId } = withOperator()
    // Sign the operator in and try to manage accounts.
    auth.logout()
    auth.login({ username: 'operator1', password: 'operator-password' })
    assert.equal(codeOf(catchError(() => auth.listUsers())), 'FORBIDDEN')
    assert.equal(codeOf(catchError(() => auth.deleteUser(operatorId))), 'FORBIDDEN')
    assert.equal(
      codeOf(catchError(() => auth.createUser({ username: 'x', password: 'long-enough', role: 'operator' }))),
      'FORBIDDEN'
    )
  })

  it('rejects a duplicate username with its own code', () => {
    const { auth } = withOperator()
    assert.equal(
      codeOf(catchError(() =>
        auth.createUser({ username: 'OPERATOR1', password: 'another-password', role: 'operator' })
      )),
      'AUTH_USERNAME_TAKEN'
    )
  })

  it('makes a new account change its password at first login', () => {
    const { auth, users } = withOperator()
    const created = auth.listUsers().find((user) => user.username === 'operator1')
    assert.ok(created)
    assert.equal(created.mustChangePassword, true)
    assert.equal(users.findByUsername('operator1')?.mustChangePassword, true)
  })

  it('refuses to delete the account you are signed in with', () => {
    const { auth } = withOperator()
    const me = auth.currentSession()?.user
    assert.ok(me)

    // On your own, the last-administrator rule fires first (see the ordering note
    // in `deleteUser`), so add a second administrator to reach the self-delete
    // rule itself.
    auth.createUser({ username: 'admin2', password: 'second-admin-pass', role: 'admin' })
    assert.equal(codeOf(catchError(() => auth.deleteUser(me.id))), 'VALIDATION_ERROR')
  })

  it('refuses to remove or demote the last administrator', () => {
    const { auth } = withOperator()
    const admin = auth.currentSession()?.user
    assert.ok(admin)
    // Signed in as the only administrator: deleting yourself is refused because
    // at least one must remain (reported as such, not as "you cannot delete
    // yourself" — the first is the reason that actually matters).
    assert.equal(codeOf(catchError(() => auth.deleteUser(admin.id))), 'AUTH_LAST_ADMIN')
    assert.equal(codeOf(catchError(() => auth.setUserRole(admin.id, 'operator'))), 'AUTH_LAST_ADMIN')
  })

  it('allows deleting another administrator once a second exists', () => {
    const { auth } = withOperator()
    const second = auth.createUser({
      username: 'admin2',
      password: 'second-admin-pass',
      role: 'admin'
    })
    assert.doesNotThrow(() => auth.deleteUser(second.id))
    assert.equal(auth.listUsers().filter((user) => user.role === 'admin').length, 1)
  })

  it('allows demoting an administrator once another exists', () => {
    const { auth } = withOperator()
    const second = auth.createUser({
      username: 'admin2',
      password: 'second-admin-pass',
      role: 'admin'
    })
    const demoted = auth.setUserRole(second.id, 'operator')
    assert.equal(demoted.role, 'operator')
    assert.equal(auth.listUsers().filter((user) => user.role === 'admin').length, 1)
  })

  it('resets another account password and forces a change', () => {
    const { auth, operatorId } = withOperator()
    const updated = auth.resetUserPassword({ userId: operatorId, newPassword: 'reset-password' })
    assert.equal(updated.mustChangePassword, true)
    const outcome = auth.login({ username: 'operator1', password: 'reset-password' })
    assert.equal(outcome.mustChangePassword, true)
  })

  it('keeps the session in step when ANOTHER administrator changes your role', () => {
    const { auth } = withOperator()
    const firstAdmin = auth.currentSession()?.user
    assert.ok(firstAdmin)
    auth.createUser({
      username: 'admin2',
      password: 'second-admin-pass',
      role: 'admin'
    })

    // Sign in as the second administrator and demote the first one.
    auth.logout()
    auth.login({ username: 'admin2', password: 'second-admin-pass' })
    const demoted = auth.setUserRole(firstAdmin.id, 'operator')
    assert.equal(demoted.role, 'operator')
    assert.equal(auth.listUsers().filter((user) => user.role === 'admin').map((u) => u.username).join(), 'admin2')
  })
})

/** Run a throwing call and hand back the error, for code assertions. */
function catchError(operation: () => unknown): unknown {
  try {
    operation()
    return undefined
  } catch (error) {
    return error
  }
}
