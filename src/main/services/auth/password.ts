/**
 * Password derivation for APPLICATION accounts.
 *
 * WHY NOT THE DEVICE'S SCHEME
 * The devices hash their login password with `md5(plaintext + 'lfxs')` —
 * `md5`, a fixed, published salt, and no stretching. That is a protocol quirk
 * forced by firmware and it is documented as NOT being a security control
 * (`auth-strategy.ts`). Nothing here may copy it: these are OUR accounts, on a
 * machine we control, so there is no excuse for a reversible-speed hash.
 *
 * WHAT IS USED INSTEAD
 * `scrypt` from `node:crypto` — memory-hard, in the standard library (no new
 * dependency, which this project does not take lightly), with a per-password
 * random salt and the parameters stored IN the hash string so a future increase
 * can be applied to new passwords without invalidating old ones.
 *
 * FORMAT: `scrypt$<N>$<r>$<p>$<saltBase64>$<hashBase64>`
 * Self-describing on purpose: a stored hash records how it was produced, so
 * verification never has to guess from a constant in the code that may have
 * changed since.
 *
 * WHAT THIS DOES NOT PROTECT AGAINST
 * An attacker with the database file AND the ability to run code on the machine
 * can brute-force an 8-character human password offline. That is why the app also
 * rate-limits interactive attempts, and why the threat model here is "somebody at
 * an unattended console" rather than a remote service breach.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/** Cost parameters. `N` is the CPU/memory cost; 2^15 ≈ 32 MB and ~50 ms here. */
const PARAMS = { N: 32768, r: 8, p: 1 } as const

/** Derived key length in bytes. */
const KEY_LENGTH = 64

/**
 * scrypt memory budget, in bytes.
 *
 * REQUIRED, not tuning: `node:crypto` defaults `maxmem` to 32 MiB, and this cost
 * needs `128 * N * r = 128 * 32768 * 8` bytes — exactly 32 MiB. The check is a
 * strict `>`, so it is a coin flip away from
 * `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` at module load, which is how this surfaced:
 * the whole auth module failed to import. Passing the budget explicitly also
 * documents the actual cost of a login.
 */
function memoryBudget(n: number, r: number): number {
  return 128 * n * r + 1024 * 1024
}

/**
 * Largest cost accepted when VERIFYING.
 *
 * The cost is read out of the stored hash, and a corrupted (or maliciously edited)
 * row must not be able to make the app allocate gigabytes. Anything above this is
 * treated as a failed verification, like any other malformed hash.
 */
const MAX_ACCEPTED_COST = 1 << 20

const ALGORITHM = 'scrypt'

/** A fresh password hash, safe to store. */
export function hashPassword(plaintext: string, salt: Buffer = randomBytes(16)): string {
  const derived = scryptSync(plaintext.normalize('NFKC'), salt, KEY_LENGTH, {
    ...PARAMS,
    maxmem: memoryBudget(PARAMS.N, PARAMS.r)
  })
  return [
    ALGORITHM,
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64')
  ].join('$')
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false for a malformed hash rather than throwing: a corrupt row must
 * read as "cannot log in", never as a crash that an attacker could distinguish
 * from a rejected password.
 *
 * The comparison is timing-safe. `scryptSync` dominates the runtime, so this is
 * belt-and-braces rather than load-bearing — but a non-constant-time comparison
 * on the final byte is exactly the kind of thing that gets copied into a context
 * where it does matter.
 */
export function verifyPassword(plaintext: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== ALGORITHM) return false

  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts
  const n = Number(nRaw)
  const r = Number(rRaw)
  const p = Number(pRaw)
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false
  if (n <= 1 || r <= 0 || p <= 0) return false
  if (n > MAX_ACCEPTED_COST) return false

  let expected: Buffer
  let salt: Buffer
  try {
    salt = Buffer.from(saltRaw as string, 'base64')
    expected = Buffer.from(hashRaw as string, 'base64')
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false

  let actual: Buffer
  try {
    actual = scryptSync(plaintext.normalize('NFKC'), salt, expected.length, {
      N: n,
      r,
      p,
      // Derived from the STORED parameters, so a hash written with a different
      // cost still verifies (and a corrupted one still cannot allocate wildly).
      maxmem: memoryBudget(n, r)
    })
  } catch {
    // An absurd stored cost parameter (a corrupted row) must not take the app
    // down; treat it as a failed verification.
    return false
  }

  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
