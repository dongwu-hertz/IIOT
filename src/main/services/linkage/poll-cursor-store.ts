/**
 * 轮询游标的持久化（`<userData>/linkage/poll-cursors.json`）。
 *
 * 游标是「不重启重放」这条要求的落点：引擎的内存去重表在进程结束时消失，
 * 而一台应用每天重启一次是常态。因此「我已经处理到哪个日志编号」必须落盘。
 *
 * 三条实现取舍：
 *   1. **同步读写。** 这是一个几十字节的文件、一次轮询写一次（默认 10 秒一次），
 *      异步反而会让「事务性」这件事需要额外的锁；`writeFileSync` 到临时文件
 *      再 `renameSync` 是原子的，且不会在两次写入之间留下半截 JSON。
 *   2. **坏文件不致命。** 解析失败时从空游标开始，也就是「下次轮询重新建立基线、
 *      不对历史记录联动」——这是安全的失败方向（宁可漏掉重启期间的一两条，
 *      也不能开机就对最近 100 次检测各发一封邮件）。
 *   3. **失败要说话。** 读失败/写失败都会写应用日志；静默的游标丢失会让用户
 *      在下次重启后收到一批重复告警，而日志里什么都没有。
 */

import fs from 'node:fs'
import path from 'node:path'
import { appLog } from '../logging/logger'
import type { PollCursor, PollCursorStore } from './detect-logs-poll-source'

interface CursorFile {
  version: 1
  cursors: Record<string, PollCursor>
}

export class FilePollCursorStore implements PollCursorStore {
  private readonly file: string
  private cache: Record<string, PollCursor> | undefined

  constructor(directory: string) {
    this.file = path.join(directory, 'linkage', 'poll-cursors.json')
  }

  load(deviceId: string): PollCursor | undefined {
    const all = this.read()
    const cursor = all[deviceId]
    return cursor ? { ...cursor } : undefined
  }

  save(deviceId: string, cursor: PollCursor): void {
    const all = this.read()
    all[deviceId] = { ...cursor }
    this.cache = all
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const temporary = `${this.file}.tmp`
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, cursors: all } satisfies CursorFile), 'utf8')
      fs.renameSync(temporary, this.file)
    } catch (error) {
      appLog().warn('FA371 轮询游标写入失败（下次重启可能重复处理最近的检测日志）', {
        file: this.file,
        deviceId,
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /** 删除一台设备的游标（设备被移除时）。 */
  forget(deviceId: string): void {
    const all = this.read()
    if (!(deviceId in all)) return
    delete all[deviceId]
    this.cache = all
    try {
      fs.writeFileSync(this.file, JSON.stringify({ version: 1, cursors: all } satisfies CursorFile), 'utf8')
    } catch {
      // 尽力而为：一个多余的游标不会造成错误行为。
    }
  }

  private read(): Record<string, PollCursor> {
    if (this.cache) return this.cache
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as CursorFile
      if (parsed.version === 1 && parsed.cursors && typeof parsed.cursors === 'object') {
        this.cache = parsed.cursors
        return this.cache
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        appLog().warn('FA371 轮询游标读取失败，将重新建立基线', {
          file: this.file,
          reason: error instanceof Error ? error.message : String(error)
        })
      }
    }
    this.cache = {}
    return this.cache
  }
}
