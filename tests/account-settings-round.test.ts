/**
 * 这一轮（手册 §17.1 / §17.2.7 / §17.2.8 / §17.2）的三块新功能的测试。
 *
 * 覆盖三件互相独立的事，各自有各自的"容易写错且看不出来"的地方：
 *
 *   1. **账号权限**（§17.1）：复选框的勾选态**存下来了**没有、管理员是不是恒为全权、
 *      管理员专属权限能不能被塞给操作员、删除账户会不会留下孤儿权限、手册的
 *      「最多 50 个账号」与「用户名不得含 `/ \ : * ? " < > |`」是不是真的拦住了；
 *   2. **告警声音库**（§17.2.7）：非 `.wav` 会不会被清掉（手册第 5448 行的硬约束）、
 *      六种预定义类型是不是永远都在、归一化会不会把坏输入变成一份合法的完整对象；
 *   3. **一键恢复默认**（§17.2 第 5227 行）：**范围**是不是只有那十四个系统设置项 ——
 *      这一条最重要，因为一个"恢复默认"把设备或账号清掉是灾难性的，
 *      而它在界面上看起来和"重置几个数字"一模一样。
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import path from 'node:path'

import { openDatabase } from '../src/main/services/database/schema'
import {
  AppMetaRepository,
  UserRepository
} from '../src/main/services/database/user-repository'
import { AuthService } from '../src/main/services/auth/auth-service'
import { AccountPermissionStore } from '../src/main/services/auth/account-permission-store'
import { SettingsService, RESTORABLE_SETTING_KEYS, DEFAULT_SETTINGS } from '../src/main/services/settings/settings-service'
import { AppError } from '../src/shared/errors'
import {
  ADMIN_PERMISSIONS,
  MAX_USER_ACCOUNTS,
  OPERATOR_DEFAULT_PERMISSIONS,
  PASSWORD_MIN_LENGTH,
  PERMISSION_OPERATIONS,
  PERMISSION_WITHOUT_ENFORCEMENT,
  USERNAME_FORBIDDEN_CHARACTERS,
  USER_PERMISSION_KEYS,
  defaultPermissionsForRole,
  normalisePermissionSet,
  usernameProblemKey
} from '../src/shared/domain/auth'
import { IpcChannels } from '../src/shared/ipc/contract'
import {
  ALARM_SOUND_FILE_EXTENSION,
  ALARM_SOUND_TYPE_KEYS,
  DEFAULT_ALARM_SOUND_ID,
  defaultAlarmSoundLibrary,
  isAcceptableAlarmSoundFile,
  normaliseAlarmSoundLibrary
} from '../src/shared/domain/alarm-sound'
import { zhCN } from '../src/shared/i18n/messages/zh-CN'
import { en } from '../src/shared/i18n/messages/en'
import { es } from '../src/shared/i18n/messages/es'
import { tr } from '../src/shared/i18n/messages/tr'

const DEFAULT_STORAGE_ROOT = 'C:\\HERTZINNO\\storage'

function freshAuth(): {
  auth: AuthService
  users: UserRepository
  meta: AppMetaRepository
  permissions: AccountPermissionStore
  db: ReturnType<typeof openDatabase>
} {
  const db = openDatabase({ file: ':memory:' })
  const users = new UserRepository(db)
  const meta = new AppMetaRepository(db)
  const permissions = new AccountPermissionStore(meta)
  const auth = new AuthService({ users, meta, permissions })
  auth.ensureSeedAccount()
  return { auth, users, meta, permissions, db }
}

function codeOf(error: unknown): string {
  assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`)
  return error.code
}

function signInAsAdmin(auth: AuthService): void {
  auth.login({ username: 'admin', password: 'Hz@123456' })
}

// ---------------------------------------------------------------------------
// §17.1 账号管理
// ---------------------------------------------------------------------------

describe('账号管理（手册 §17.1）', () => {
  it('操作员出厂只带只读权限，写入类一律未勾选', () => {
    // 手册写的是「操作员默认无权限」，本仓库刻意只读放行（理由写在
    // `OPERATOR_DEFAULT_PERMISSIONS` 的注释里）。这一条把那个折中钉死：
    // 只读的多，写入的一个都没有。
    const operator = normalisePermissionSet('operator', defaultPermissionsForRole('operator'))
    for (const key of USER_PERMISSION_KEYS) {
      const readOnly = key.startsWith('view')
      assert.equal(
        operator[key],
        readOnly,
        `${key} 对操作员的出厂勾选态应为 ${String(readOnly)}`
      )
    }
    assert.equal(OPERATOR_DEFAULT_PERMISSIONS.every((key) => key.startsWith('view')), true)
    // 「没有条目」与「明确取消全部可选权限」是两件事，不能混成一个。
    assert.deepEqual(
      normalisePermissionSet('operator', undefined),
      normalisePermissionSet('operator', defaultPermissionsForRole('operator')),
      '没有条目时按出厂默认'
    )
    assert.deepEqual(
      USER_PERMISSION_KEYS.filter((key) => normalisePermissionSet('operator', [])[key]),
      [],
      '空数组 = 全部未勾选'
    )
  })

  it('管理员恒为全权，且与角色默认值逐项一致', () => {
    const admin = normalisePermissionSet('admin', undefined)
    assert.deepEqual(
      USER_PERMISSION_KEYS.filter((key) => !admin[key]),
      []
    )
    assert.deepEqual(defaultPermissionsForRole('admin'), [...ADMIN_PERMISSIONS])
  })

  it('管理员专属权限对操作员恒为 false（勾不上）', () => {
    // 就算输入里硬塞进来，生效权限里也不会出现 —— 这是"角色规则没有被权限表绕过"的证据。
    const operator = normalisePermissionSet('operator', ['manageAccounts', 'manageSystemSettings', 'viewDevices'])
    assert.equal(operator.manageAccounts, false)
    assert.equal(operator.manageSystemSettings, false)
    assert.equal(operator.viewDevices, true)
  })

  it('用户名不得包含 / \\ : * ? " < > |（手册第 5198 行）', () => {
    for (const character of USERNAME_FORBIDDEN_CHARACTERS) {
      assert.equal(usernameProblemKey(`oper${character}ator`), 'forbidden', `"${character}" 应被拒绝`)
    }
    assert.equal(usernameProblemKey('operator-1'), '')
    assert.equal(usernameProblemKey('  '), 'empty')
    assert.equal(usernameProblemKey('a'.repeat(33)), 'tooLong')
  })

  it('服务端也拒绝含非法字符的用户名', () => {
    const { auth } = freshAuth()
    signInAsAdmin(auth)
    assert.equal(
      codeOf(
        (() => {
          try {
            auth.createUser({ username: 'bad/name', password: 'good-password', role: 'operator' })
            return undefined
          } catch (error) {
            return error
          }
        })()
      ),
      'VALIDATION_ERROR'
    )
  })

  it('密码不得少于 6 个字符（手册第 5199 行），5 位被拒、6 位通过', () => {
    assert.equal(PASSWORD_MIN_LENGTH, 6)
    const { auth } = freshAuth()
    signInAsAdmin(auth)
    assert.throws(
      () => auth.createUser({ username: 'op5', password: '12345', role: 'operator' }),
      (error: unknown) => codeOf(error) === 'AUTH_PASSWORD_POLICY'
    )
    const created = auth.createUser({ username: 'op6', password: '123456', role: 'operator' })
    assert.equal(created.username, 'op6')
  })

  it('最多 50 个账号（手册第 5205 行）', () => {
    const { auth, users } = freshAuth()
    signInAsAdmin(auth)
    // 出厂已有 1 个管理员，再造 49 个正好到上限。
    for (let index = 0; index < MAX_USER_ACCOUNTS - 1; index += 1) {
      auth.createUser({ username: `op${index}`, password: 'good-password', role: 'operator' })
    }
    assert.equal(users.count(), MAX_USER_ACCOUNTS)
    assert.throws(
      () => auth.createUser({ username: 'overflow', password: 'good-password', role: 'operator' }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'VALIDATION_ERROR')
        assert.match((error as AppError).message, /50/)
        return true
      }
    )
  })

  it('权限真的存下来了，并且能读回来（不是只改了内存）', () => {
    const { auth, meta } = freshAuth()
    signInAsAdmin(auth)
    const operator = auth.createUser({
      username: 'ops',
      password: 'good-password',
      role: 'operator',
      permissions: ['viewDevices', 'configureDevices']
    })
    assert.equal(operator.permissions?.viewDevices, true)
    assert.equal(operator.permissions?.configureDevices, true)
    assert.equal(operator.permissions?.manageDevices, false)

    // 从 `app_meta` 里直接读：这一条才是"落库"的证据（`auth.listUsers()` 可能只是
    // 把刚提交的东西回显回来）。
    const raw = meta.get('account.permissions')
    assert.ok(raw, 'app_meta 里应有权限那一格')
    const parsed = JSON.parse(String(raw)) as Record<string, string[]>
    assert.deepEqual(parsed[operator.id], ['configureDevices', 'viewDevices'])
  })

  it('改权限：管理员专属项塞不进操作员，管理员的权限不可逐项改', () => {
    const { auth } = freshAuth()
    signInAsAdmin(auth)
    const operator = auth.createUser({ username: 'ops', password: 'good-password', role: 'operator' })

    const updated = auth.updateUserPermissions({
      userId: operator.id,
      permissions: ['manageAccounts', 'viewAlarms']
    })
    assert.equal(updated.permissions?.manageAccounts, false, '管理员专属项塞不进去')
    assert.equal(updated.permissions?.viewAlarms, true)

    const admin = auth.listUsers().find((user) => user.username === 'admin')
    assert.ok(admin)
    assert.throws(
      () => auth.updateUserPermissions({ userId: admin.id, permissions: ['viewDevices'] }),
      (error: unknown) => codeOf(error) === 'VALIDATION_ERROR'
    )
  })

  it('「从…复制权限」把来源的生效权限搬到目标，且拒绝自己复制给自己', () => {
    const { auth } = freshAuth()
    signInAsAdmin(auth)
    const source = auth.createUser({
      username: 'source',
      password: 'good-password',
      role: 'operator',
      permissions: ['viewDevices', 'controlCameras', 'deleteRecordings']
    })
    const target = auth.createUser({ username: 'target', password: 'good-password', role: 'operator' })

    const copied = auth.copyPermissions({ sourceUserId: source.id, targetUserId: target.id })
    assert.equal(copied.permissions?.controlCameras, true)
    assert.equal(copied.permissions?.deleteRecordings, true)
    assert.equal(copied.permissions?.manageSystemSettings, false)

    assert.throws(
      () => auth.copyPermissions({ sourceUserId: target.id, targetUserId: target.id }),
      (error: unknown) => codeOf(error) === 'VALIDATION_ERROR'
    )

    // 从**管理员**复制：管理员专属项仍然进不去，其余按生效权限照搬。
    const admin = auth.listUsers().find((user) => user.username === 'admin')
    assert.ok(admin)
    const fromAdmin = auth.copyPermissions({ sourceUserId: admin.id, targetUserId: target.id })
    assert.equal(fromAdmin.permissions?.manageAccounts, false)
    assert.equal(fromAdmin.permissions?.configureDevices, true)
  })

  it('删除账户会把它的权限条目一起删掉（不留孤儿）', () => {
    const { auth, meta } = freshAuth()
    signInAsAdmin(auth)
    const operator = auth.createUser({
      username: 'gone',
      password: 'good-password',
      role: 'operator',
      permissions: ['viewDevices', 'controlCameras']
    })
    assert.ok(meta.get('account.permissions')?.includes(operator.id))
    auth.deleteUser(operator.id)
    assert.ok(
      !String(meta.get('account.permissions')).includes(operator.id),
      '权限表里不应再出现被删账户的 id'
    )
  })

  it('内置管理员不可删除，但密码可以改', () => {
    const { auth } = freshAuth()
    signInAsAdmin(auth)
    const admin = auth.listUsers().find((user) => user.username === 'admin')
    assert.ok(admin)
    // 出厂只有一个管理员 -> 它是内置的那一个。
    assert.throws(
      () => auth.deleteUser(admin.id),
      (error: unknown) => codeOf(error) === 'AUTH_LAST_ADMIN'
    )
    // 密码可改（手册第 5214 行：only the password of the super user can be edited）。
    const changed = auth.changePassword({
      currentPassword: 'Hz@123456',
      newPassword: 'a-new-password'
    })
    assert.equal(changed.mustChangePassword, false)
    assert.equal(auth.login({ username: 'admin', password: 'a-new-password' }).session.user.username, 'admin')
  })

  it('操作员只能改自己的密码：改别人的账户需要管理员', () => {
    const { auth } = freshAuth()
    signInAsAdmin(auth)
    const operator = auth.createUser({ username: 'ops', password: 'good-password', role: 'operator' })
    auth.logout()
    auth.login({ username: 'ops', password: 'good-password' })

    // 自己的密码：要当前口令，改得动。
    const changed = auth.changePassword({ currentPassword: 'good-password', newPassword: 'another-pass' })
    assert.equal(changed.username, 'ops')

    // 别人的密码：`resetUserPassword` 是管理员通道。
    assert.throws(
      () => auth.resetUserPassword({ userId: operator.id, newPassword: 'forced-pass' }),
      (error: unknown) => codeOf(error) === 'FORBIDDEN'
    )
    // 权限也改不动。
    assert.throws(
      () => auth.updateUserPermissions({ userId: operator.id, permissions: ['manageDevices'] }),
      (error: unknown) => codeOf(error) === 'FORBIDDEN'
    )
    // 账号列表也读不到（管理员才读得到）。
    assert.throws(
      () => auth.listUsers(),
      (error: unknown) => codeOf(error) === 'FORBIDDEN'
    )
  })
  it('权限目录与 handlers.ts 的 requirePermission() 逐条对齐（不是装饰）', () => {
    /**
     * 这一条是本轮最重要的一条**防漂移**断言。
     *
     * `PERMISSION_OPERATIONS`（共享层）说"这一项管哪些操作"，`handlers.ts` 里的
     * `requirePermission()` 说"这些操作真的被拦"。两者是两份必须一致的数据：
     * 加了一项权限却没人拦它，复选框就是装饰；给一条通道加了拦截却忘了写进表里，
     * 界面就会少说一句实话。所以这里**读源码**把它们逐条比。
     *
     * 读的是 `src/main/ipc/handlers.ts`：那条路径不受 tsconfig 的 include 影响，
     * 测试跑在 Node 里，文件就在工程里。
     */
    /**
     * 判定的落点有**两处**，都是主进程代码：
     *   - `handlers.ts`：一条通道一个 `requirePermission()`；
     *   - `auth-service.ts`：账号管理那一组八个入口共用
     *     `requireAccountManagement()`（它内部调 `requirePermission('manageAccounts')`）。
     *     写在服务里而不是八个调用点上，是为了「加了第九个入口却忘了加守卫」不可能发生。
     * 所以两张源码一起搜，并把 `requireAccountManagement` 当作 `manageAccounts` 的别名。
     */
    const source = [
      readFileSync(path.resolve(__dirname, '..', '..', 'src', 'main', 'ipc', 'handlers.ts'), 'utf8'),
      readFileSync(
        path.resolve(__dirname, '..', '..', 'src', 'main', 'services', 'auth', 'auth-service.ts'),
        'utf8'
      )
    ].join('\n')

    /** 通道名（`IpcChannels` 的取值）-> 权限。`PERMISSION_OPERATIONS` 是权威方向。 */
    const expected = new Map<string, string>()
    for (const key of USER_PERMISSION_KEYS) {
      for (const channel of PERMISSION_OPERATIONS[key]) {
        // 表里的通道名必须是 `IpcChannels` 真的有的那一个（手打错了在这里就失败）。
        const known = Object.values(IpcChannels) as readonly string[]
        assert.ok(known.includes(channel), `PERMISSION_OPERATIONS.${key} 里的 "${channel}" 不是已知通道`)
        assert.equal(expected.has(channel), false, `通道 ${channel} 被两项权限同时声明`)
        expected.set(channel, key)
      }
    }

    /** 源码里实际出现的守卫：按**通道块**（到下一个 `ipcMain.handle` 为止）搜。 */
    const actual = new Map<string, string>()
    /**
     * `IpcChannels` 的**键**（`SETTINGS_UPDATE`）与它的**值**（`settings:update`）都要
     * 用上：`PERMISSION_OPERATIONS` 里写的是值（通道名，给人看的），而源码里出现的是
     * 键（`IpcChannels.SETTINGS_UPDATE`）。用值去搜源码一个都找不到。
     */
    const channelNames = Object.entries(IpcChannels) as Array<[string, string]>
    for (const [key, channel] of channelNames) {
      const start = source.indexOf(`IpcChannels.${key}`)
      if (start === -1) continue
      /**
       * 从 `IpcChannels.<这个通道>` **往后**切到下一个 `ipcMain.handle(`，那一段就是
       * 这个 handler 的完整实现。用 `ipcMain.handle(` 而不是只找通道名，是因为
       * 通道名在文件别处也会出现（注释、别的 handler 里的比较）。
       */
      const nextHandler = source.indexOf('ipcMain.handle(', start + 1)
      const block = source.slice(start, nextHandler === -1 ? source.length : nextHandler)
      const permissionMatch = block.match(/requirePermission\('([a-zA-Z]+)'\)/)
      if (permissionMatch) actual.set(channel, permissionMatch[1] as string)
    }
    /**
     * 八个账号管理入口在服务里共用 `requireAccountManagement()`（`manageAccounts`
     * 的别名）：这是**一个**落点，写在服务里而不是八个调用点上。
     */
    const serviceGuard = /private requireAccountManagement\(\)[\s\S]{0,200}requirePermission\('manageAccounts'\)/.test(
      source
    )
    assert.ok(serviceGuard, 'auth-service.ts 的 requireAccountManagement() 必须包含 manageAccounts 的权限检查')
    for (const channel of PERMISSION_OPERATIONS.manageAccounts) actual.set(channel, 'manageAccounts')

    const missing = [...expected.entries()].filter(([channel]) => !actual.has(channel))
    assert.deepEqual(
      missing.map(([channel, permission]) => `${channel} (${permission})`),
      [],
      '这些操作声明了自己被某项权限管住，但 handlers.ts 里没有 requirePermission()'
    )
    const wrong = [...actual.entries()].filter(
      ([channel, permission]) => expected.get(channel) !== permission
    )
    assert.deepEqual(
      wrong.map(([channel, permission]) => `${channel}: ${permission} != ${expected.get(channel)}`),
      [],
      '这些操作拦的权限与 PERMISSION_OPERATIONS 声明的不一致'
    )
  })

  it('每一项权限都至少管一个操作，只有一处例外被显式豁免', () => {
    const empty = USER_PERMISSION_KEYS.filter((key) => PERMISSION_OPERATIONS[key].length === 0)
    assert.deepEqual(empty, [...PERMISSION_WITHOUT_ENFORCEMENT])
    assert.deepEqual([...PERMISSION_WITHOUT_ENFORCEMENT], ['deleteRecordings'])
  })

  it('requirePermission() 对操作员真的生效：勾了就通过，没勾就拒绝', () => {
    const { auth } = freshAuth()
    signInAsAdmin(auth)
    const operator = auth.createUser({
      username: 'ops',
      password: 'good-password',
      role: 'operator',
      permissions: ['viewDevices', 'configureDevices']
    })
    auth.logout()
    auth.login({ username: 'ops', password: 'good-password' })

    // 勾上的那一项通过（这里只验判定本身；真正的写路径还要过 `requireAdministrator()`，
    // 那是角色规则，不在这一条的范围内）。
    assert.doesNotThrow(() => auth.requirePermission('configureDevices'))
    assert.equal(auth.hasPermission('configureDevices'), true)
    // 没勾的被拒绝，理由里带上缺的是哪一项（排查时需要这个）。
    assert.throws(
      () => auth.requirePermission('controlCameras'),
      (error: unknown) => {
        assert.equal(codeOf(error), 'FORBIDDEN')
        assert.match((error as AppError).detail ?? '', /permission=controlCameras/)
        return true
      }
    )
    assert.equal(auth.hasPermission('controlCameras'), false)
    // 管理员专属项对操作员永远是 false，即使有人手改了库也一样。
    assert.equal(auth.hasPermission('manageAccounts'), false)
    assert.throws(() => auth.requirePermission('manageAccounts'), (error: unknown) => codeOf(error) === 'FORBIDDEN')
    // 顺带证明：`operator.id` 之外的那份权限没被这次登录改掉。
    assert.deepEqual(operator.permissions?.configureDevices, true)
  })
})

// ---------------------------------------------------------------------------
// §17.2.7 告警声音库
// ---------------------------------------------------------------------------
describe('告警声音库（手册 §17.2.7）', () => {
  it('出厂有六种预定义类型，都没有选文件，默认声音是运动侦测', () => {
    const library = defaultAlarmSoundLibrary()
    assert.equal(library.items.length, ALARM_SOUND_TYPE_KEYS.length)
    assert.deepEqual(
      library.items.map((item) => item.id),
      [...ALARM_SOUND_TYPE_KEYS]
    )
    assert.equal(library.items.every((item) => item.filePath === ''), true)
    assert.equal(library.defaultSoundId, DEFAULT_ALARM_SOUND_ID)
    assert.ok(ALARM_SOUND_TYPE_KEYS.includes(DEFAULT_ALARM_SOUND_ID as never))
  })

  it('只接受 .wav，大小写不敏感', () => {
    assert.equal(isAcceptableAlarmSoundFile('C:\\sounds\\alarm.wav'), true)
    assert.equal(isAcceptableAlarmSoundFile('C:\\sounds\\ALARM.WAV'), true)
    assert.equal(isAcceptableAlarmSoundFile('/tmp/alarm.WaV'), true)
    assert.equal(isAcceptableAlarmSoundFile('C:\\sounds\\alarm.mp3'), false)
    assert.equal(isAcceptableAlarmSoundFile('C:\\sounds\\alarm.wav.bak'), false)
    assert.equal(isAcceptableAlarmSoundFile(''), false)
    assert.equal(ALARM_SOUND_FILE_EXTENSION, '.wav')
  })

  it('非 .wav 的文件在归一化时被清掉，并把字段名交回来', () => {
    const { library, issues } = normaliseAlarmSoundLibrary({
      items: [
        { id: 'motionDetection', type: 'motionDetection', filePath: 'C:\\a\\good.wav' },
        { id: 'videoLoss', type: 'videoLoss', filePath: 'C:\\a\\bad.mp3' }
      ]
    })
    const motion = library.items.find((item) => item.id === 'motionDetection')
    const loss = library.items.find((item) => item.id === 'videoLoss')
    assert.equal(motion?.filePath, 'C:\\a\\good.wav')
    assert.equal(motion?.fileName, 'good.wav')
    assert.equal(loss?.filePath, '', '非 wav 必须被清掉')
    assert.equal(loss?.fileName, '')
    assert.deepEqual(issues, ['items[1].filePath(.wav)'])
  })

  it('六种预定义类型永远都在，且排在最前（输入里漏掉也不会消失）', () => {
    const { library } = normaliseAlarmSoundLibrary({ items: [] })
    assert.deepEqual(
      library.items.map((item) => item.id),
      [...ALARM_SOUND_TYPE_KEYS]
    )
    const partial = normaliseAlarmSoundLibrary({
      items: [{ id: 'videoLoss', type: 'videoLoss', filePath: 'C:\\v.wav' }]
    }).library
    assert.equal(partial.items.length, ALARM_SOUND_TYPE_KEYS.length)
    assert.equal(partial.items.find((item) => item.id === 'videoLoss')?.filePath, 'C:\\v.wav')
  })

  it('自定义项保留名字与文件，默认声音指向不存在的 id 时回落', () => {
    const { library, issues } = normaliseAlarmSoundLibrary({
      items: [
        { id: 'custom:1', type: null, label: '我的告警声', filePath: 'D:\\x\\mine.wav' }
      ],
      defaultSoundId: 'custom:nope',
      selectedId: 'custom:1'
    })
    const custom = library.items.find((item) => item.id === 'custom:1')
    assert.equal(custom?.label, '我的告警声')
    assert.equal(custom?.fileName, 'mine.wav')
    assert.equal(custom?.type, null)
    assert.equal(library.defaultSoundId, DEFAULT_ALARM_SOUND_ID)
    assert.equal(library.selectedId, 'custom:1')
    assert.deepEqual(issues, ['defaultSoundId'])
  })

  it('坏输入（不是对象、数组、垃圾项）回落成一份合法的完整对象，绝不抛异常', () => {
    for (const input of [null, 42, 'nope', [], { items: 'nope' }, { items: [null, 1, {}] }]) {
      const { library } = normaliseAlarmSoundLibrary(input)
      assert.equal(library.items.length, ALARM_SOUND_TYPE_KEYS.length)
      assert.equal(library.defaultSoundId, DEFAULT_ALARM_SOUND_ID)
    }
  })
})

// ---------------------------------------------------------------------------
// §17.2 一键恢复默认值
// ---------------------------------------------------------------------------

describe('一键恢复默认值（手册 §17.2 第 5227 行）', () => {
  function freshSettings(): { settings: SettingsService; db: ReturnType<typeof openDatabase> } {
    const db = openDatabase({ file: ':memory:' })
    const settings = new SettingsService({ db, defaultStorageRoot: DEFAULT_STORAGE_ROOT })
    return { settings, db }
  }

  it('把被改过的系统设置项改回出厂值，并且是读回来的', () => {
    const { settings } = freshSettings()
    settings.update({
      retentionDays: 7,
      healthCheckIntervalMs: 1_500,
      preAlarmSeconds: 3,
      autoPlayCameraLive: false,
      maxConcurrentCameraStreams: 2
    })
    assert.equal(settings.get().retentionDays, 7)

    const { settings: restored, rejected } = settings.restoreDefaults()
    assert.deepEqual(rejected, [])
    assert.equal(restored.retentionDays, DEFAULT_SETTINGS.retentionDays)
    assert.equal(restored.healthCheckIntervalMs, DEFAULT_SETTINGS.healthCheckIntervalMs)
    assert.equal(restored.preAlarmSeconds, DEFAULT_SETTINGS.preAlarmSeconds)
    assert.equal(restored.autoPlayCameraLive, DEFAULT_SETTINGS.autoPlayCameraLive)
    assert.equal(restored.maxConcurrentCameraStreams, DEFAULT_SETTINGS.maxConcurrentCameraStreams)
    // 内存里的那一份与读回来的一致。
    assert.deepEqual(settings.get(), restored)

    // 再读一次（新的 SettingsService = 模拟重启）仍然是默认值：落库了。
    const reloaded = new SettingsService({
      db: (settings as unknown as { db: ReturnType<typeof openDatabase> }).db,
      defaultStorageRoot: DEFAULT_STORAGE_ROOT
    })
    assert.equal(reloaded.get().retentionDays, DEFAULT_SETTINGS.retentionDays)
  })

  it('存储路径也回到平台默认（它只改设置里的那一格路径，不动磁盘）', () => {
    const { settings } = freshSettings()
    settings.update({ storageRoot: 'D:\\elsewhere' })
    assert.equal(settings.get().storageRoot, 'D:\\elsewhere')
    const { settings: restored } = settings.restoreDefaults()
    assert.equal(restored.storageRoot, DEFAULT_STORAGE_ROOT)
  })

  it('告警声音库里选择的文件也被重置（它在范围之内）', () => {
    const { settings } = freshSettings()
    settings.update({
      alarmSounds: {
        items: [{ id: 'motionDetection', type: 'motionDetection', label: '', filePath: 'C:\\a\\x.wav', fileName: 'x.wav' }],
        selectedId: 'motionDetection',
        defaultSoundId: 'videoLoss'
      }
    })
    assert.equal(settings.get().alarmSounds.items[0]?.filePath, 'C:\\a\\x.wav')
    const { settings: restored } = settings.restoreDefaults()
    assert.equal(restored.alarmSounds.items[0]?.filePath, '')
    assert.equal(restored.alarmSounds.defaultSoundId, DEFAULT_ALARM_SOUND_ID)
  })

  it('范围**只有**那十四个键，而且 i18n 的清单与它逐项对应', () => {
    /**
     * 2026-09-19 起是**十四个**：多了 `iotIngest`（业主第 1 条的数据接入）。
     *
     * 这一条断言守的是"有一项会被重置却没说"：范围由主进程的
     * `RESTORABLE_SETTING_KEYS` 定义，而确认对话框逐项列出它，两边的项数必须一样。
     * 恢复默认会把接入总开关**关掉**（出厂默认是关闭），所以那一项必须在清单里写出来。
     */
    assert.equal(RESTORABLE_SETTING_KEYS.length, 14)
    // 确认对话框逐项列出它们；项数不一致意味着"有一项会被重置却没说"。
    const zhItems = Object.keys(zhCN.settingsUi).filter((key) => key.startsWith('restoreItem'))
    assert.equal(
      zhItems.length,
      RESTORABLE_SETTING_KEYS.length,
      `settingsUi.restoreItem* 有 ${zhItems.length} 条，主进程的范围是 ${RESTORABLE_SETTING_KEYS.length} 项`
    )
    // 每一项名字都在四种语言里存在（账号管理/声音库/邮件那三块也一样）。
    for (const locale of [en, es, tr]) {
      const items = Object.keys(locale.settingsUi).filter((key) => key.startsWith('restoreItem'))
      assert.equal(items.length, RESTORABLE_SETTING_KEYS.length)
    }
  })

  it('恢复默认**不碰**账号、账号权限与 app_meta 里的其它事实', () => {
    const db = openDatabase({ file: ':memory:' })
    const settings = new SettingsService({ db, defaultStorageRoot: DEFAULT_STORAGE_ROOT })
    const users = new UserRepository(db)
    const meta = new AppMetaRepository(db)
    const permissions = new AccountPermissionStore(meta)
    const auth = new AuthService({ users, meta, permissions })
    auth.ensureSeedAccount()
    auth.login({ username: 'admin', password: 'Hz@123456' })
    const operator = auth.createUser({
      username: 'ops',
      password: 'good-password',
      role: 'operator',
      permissions: ['viewDevices', 'controlCameras']
    })
    const installId = auth.installId()
    const permissionRowBefore = meta.get('account.permissions')

    // 顺带改一个系统设置项，保证这次恢复确实**做了事**（否则"什么都没变"是空断言）。
    settings.update({ retentionDays: 11 })
    const { settings: restored } = settings.restoreDefaults()
    assert.equal(restored.retentionDays, DEFAULT_SETTINGS.retentionDays)

    // 账号还在、权限还在、install id 还在。
    assert.equal(users.count(), 2)
    assert.equal(meta.get('account.permissions'), permissionRowBefore)
    assert.equal(auth.installId(), installId)
    // 权限表里 `controlCameras` 必须仍然勾着。
    assert.deepEqual(permissions.forUser(operator.id), ['controlCameras', 'viewDevices'])
  })

  it('默认值本身过得了校验器（否则"恢复默认"会自己失败）', () => {
    const { settings } = freshSettings()
    const { rejected } = settings.restoreDefaults()
    assert.deepEqual(rejected, [], '出厂默认值必须全部合法')
  })
})
