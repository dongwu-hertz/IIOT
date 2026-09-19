/**
 * 本机可用于"设备往这里推"的地址。
 *
 * 与"本机有哪些网卡"分开一个文件，是因为它碰 `node:os`（系统调用），而接入服务本身要能在
 * 单测里用一个假的地址表跑 —— 测试机器上有几张网卡、地址是什么，与协议行为无关。
 *
 * 三条过滤规则，每条都有理由：
 *   - **只要 IPv4**：现场设备端固件的推流地址是 IPv4 字面量（`GET /get_date_push` 实测回来的
 *     就是 `http://8.153.195.75:3000/...`），给一个 IPv6 地址没有任何设备会用得上，而它会
 *     在界面上把真正能用的那一条挤下去；
 *   - **跳过回环**：`127.0.0.1` 不是设备能连的目标（它指的是设备自己）；
 *   - **去重**：多张网卡拿到同一个地址（虚拟网卡、桥接）只列一次，否则界面上会出现两条一模
 *     一样的"推流地址"，让人以为有两台不同的入口。
 */
import { networkInterfaces } from 'node:os'

export interface LocalAddress {
  /** IPv4 字面量。 */
  address: string
  /** 网卡名字（Windows 上是"以太网"/"WLAN"这类），供界面区分多网卡。 */
  iface: string
}

export function listLocalAddresses(): LocalAddress[] {
  const result: LocalAddress[] = []
  const seen = new Set<string>()
  let interfaces: ReturnType<typeof networkInterfaces>
  try {
    interfaces = networkInterfaces()
  } catch {
    // 极端情况下取网卡表会抛（权限/平台差异）：如实回一个空表，
    // 界面会说"没有可用于设备的地址"，而不是让接入服务整个起不来。
    return result
  }

  for (const [iface, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      if (seen.has(entry.address)) continue
      seen.add(entry.address)
      result.push({ address: entry.address, iface })
    }
  }
  return result
}
