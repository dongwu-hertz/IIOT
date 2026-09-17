/**
 * The "super password" that gets a locked-out operator back in.
 *
 * THE DESIGN CHOICE, AND WHY IT IS NOT A FIXED PASSWORD
 * Two options were available:
 *
 *   (a) one factory super password, documented, the same in every installation;
 *   (b) a PER-INSTALLATION recovery code, derived from a factory secret and an
 *       install id that this copy of the app generates once.
 *
 * (a) is simpler to support and is what several products in this category do. It
 * was rejected because a single published string that resets any account on any
 * installation is a backdoor with a support number attached: the moment it leaks
 * — and a password printed in a manual leaks — every deployment is exposed at
 * once, including ones that never needed a reset.
 *
 * (b) keeps the same operational story ("call support with the id from your login
 * screen and they read you a code") while making a leaked code useless on any
 * other machine.
 *
 * WHAT THIS HONESTLY IS NOT
 * The factory secret below ships inside the application, so this is not protection
 * against somebody who has both the binary and the install id — they can compute
 * the code. It IS protection against:
 *   - one leaked code unlocking every other installation;
 *   - reading the code out of the database file (it is never stored; only the
 *     install id is);
 *   - a technician memorising "the" super password and reusing it forever.
 *
 * The install id is displayed on the login screen precisely because the user is
 * meant to read it out. It is an identifier, not a secret.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Factory secret used to derive recovery codes.
 *
 * Changing this string invalidates every previously issued recovery code. That is
 * the intended behaviour if it ever leaks: bump it, and installations fall back to
 * the id-plus-support path with newly issued codes.
 */
const FACTORY_SECRET = 'hertzinno-acoustic-box-manager/recovery/v1'

/** Alphabet without look-alike characters: these codes get read aloud over a phone. */
const ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY34679'

const CODE_LENGTH = 16
const GROUP_SIZE = 4

/**
 * Derive the recovery code for an installation.
 *
 * Deterministic, so support can reproduce it from the install id alone, and
 * truncated to 16 characters — about 74 bits — which is far beyond guessing for a
 * code that is additionally rate-limited at the point of use.
 *
 * NORMALISES ITS INPUT. The id is displayed grouped (`AB12-CD34-EF56-7890`) and is
 * also legitimately passed ungrouped by the service, and a derivation that treats
 * those as two different installations would issue codes that the app then
 * rejects. `tests/recovery-code.test.ts` compares this function against the
 * standalone support script for exactly this reason — and it caught the original
 * version of this function, which hashed the raw string.
 */
export function recoveryCodeFor(installId: string): string {
  const digest = createHmac('sha256', FACTORY_SECRET).update(normaliseCode(installId)).digest()
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += ALPHABET[digest[i]! % ALPHABET.length]
  }
  return groupCode(code)
}

/**
 * Compare a candidate code with the one this installation should accept.
 *
 * Accepts the code with or without its grouping dashes and in any case, because
 * it will be typed by a human reading it off a screen or a phone call — refusing
 * `abcd-efgh...` when `ABCD-EFGH...` was meant would be a defect, not security.
 */
export function verifyRecoveryCode(installId: string, candidate: string): boolean {
  const normalised = normaliseCode(candidate)
  if (normalised.length !== CODE_LENGTH) return false
  const expected = normaliseCode(recoveryCodeFor(installId))
  const a = Buffer.from(normalised)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Strip grouping and case, so comparison is about the code, not its formatting. */
export function normaliseCode(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

/** `ABCDEFGHJKLMNPQR` -> `ABCD-EFGH-JKLM-NPQR`. */
export function groupCode(code: string): string {
  const groups: string[] = []
  for (let i = 0; i < code.length; i += GROUP_SIZE) groups.push(code.slice(i, i + GROUP_SIZE))
  return groups.join('-')
}
