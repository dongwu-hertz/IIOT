#!/usr/bin/env node
/**
 * Issue the super password for one installation.
 *
 * This is the SUPPORT side of password recovery: the operator reads the
 * installation id off their login screen, support runs this and reads back a
 * 16-character code, and the operator enters it to set a new password. The code
 * can only reset an existing account's password — it cannot log in, create
 * anything, change a role, or unlock a different machine.
 *
 * WHY THE DERIVATION IS DUPLICATED HERE
 * The application's implementation lives in TypeScript
 * (`src/main/services/auth/super-password.ts`) and cannot be required from a plain
 * Node script without building the project first — and this tool has to run on a
 * support machine that has nothing but Node. The alternative, shipping the code
 * through the packaged app, would mean a code could only be issued by somebody
 * holding the same version of the binary.
 *
 * A duplicated derivation is a drift risk, so `tests/recovery-code.test.ts`
 * executes this script and compares its output with the application's own
 * function for several ids. If the two ever disagree, the test suite fails.
 *
 * USAGE
 *   node scripts/recovery-code.cjs AB12-CD34-EF56-7890
 *   node scripts/recovery-code.cjs --verify AB12CD34EF567890 ABCD-EFGH-JKLM-NPQR
 */

'use strict'

const { createHmac, timingSafeEqual } = require('node:crypto')

/** MUST stay byte-identical to FACTORY_SECRET in super-password.ts. */
const FACTORY_SECRET = 'hertzinno-acoustic-box-manager/recovery/v1'

/** Look-alike-free alphabet: these get read aloud over a phone. */
const ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY34679'

const CODE_LENGTH = 16
const GROUP_SIZE = 4

function recoveryCodeFor(installId) {
  const digest = createHmac('sha256', FACTORY_SECRET).update(installId.trim().toUpperCase()).digest()
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += ALPHABET[digest[i] % ALPHABET.length]
  }
  return groupCode(code)
}

function normaliseCode(value) {
  return value.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

function groupCode(code) {
  const groups = []
  for (let i = 0; i < code.length; i += GROUP_SIZE) groups.push(code.slice(i, i + GROUP_SIZE))
  return groups.join('-')
}

function verify(installId, candidate) {
  const a = Buffer.from(normaliseCode(candidate))
  const b = Buffer.from(normaliseCode(recoveryCodeFor(installId)))
  return a.length === b.length && timingSafeEqual(a, b)
}

const argv = process.argv.slice(2)

if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
  console.log(
    [
      '用法:',
      '  node scripts/recovery-code.cjs <安装标识>              # 签发超级密码',
      '  node scripts/recovery-code.cjs --verify <安装标识> <超级密码>  # 校验',
      '',
      '安装标识显示在登录页「忘记密码」里，形如 AB12-CD34-EF56-7890。',
      '超级密码只能重置已存在账户的密码，不能登录、不能创建账户、不能改角色。'
    ].join('\n')
  )
  process.exit(argv.length === 0 ? 1 : 0)
}

if (argv[0] === '--verify') {
  const [, installId, candidate] = argv
  if (!installId || !candidate) {
    console.error('用法: node scripts/recovery-code.cjs --verify <安装标识> <超级密码>')
    process.exit(1)
  }
  const ok = verify(installId, candidate)
  console.log(ok ? 'OK 超级密码与该安装标识匹配' : 'FAIL 超级密码与该安装标识不匹配')
  process.exit(ok ? 0 : 1)
}

const installId = normaliseCode(argv[0])
if (installId.length < 8) {
  console.error('安装标识看起来太短，请从登录页原样复制（形如 AB12-CD34-EF56-7890）。')
  process.exit(1)
}

console.log(`安装标识  ${groupCode(installId)}`)
console.log(`超级密码  ${recoveryCodeFor(installId)}`)
console.log('')
console.log('请让用户在这个界面上输入上面这串超级密码，并设置一个新密码。')
