/**
 * Network reconfiguration with rollback (spec 11.4, the highest-risk write).
 *
 * THE PROBLEM
 * `PUT /set_network` changes the address the device answers on. The moment it
 * applies, the connection the request travelled over is gone. The device's own
 * web UI responds by clearing its session and reloading the page — if the new
 * address is wrong, the user is simply locked out and their only recovery route
 * is physical access to a device that may be on a substation wall.
 *
 * THE APPROACH
 * Treat it as a transaction with a compensating action:
 *
 *   1. Snapshot the current network configuration.
 *   2. Apply the change.
 *   3. Reconnect on the NEW address, polling until the device answers.
 *   4. On success, verify the device reports the settings we sent.
 *   5. On failure, reconnect on the OLD address and write the snapshot back.
 *   6. Report which of these happened, in terms the user can act on.
 *
 * Step 5 is the one that matters. It is also best-effort by nature: if the device
 * is unreachable on BOTH addresses, nothing can be done from software, and the
 * result says so plainly rather than pretending otherwise.
 */

import { AppError, ErrorCodes } from '@shared/errors'
import { deviceLog } from '../logging/logger'
import type { DeviceApiClient } from './device-api-client'
import type {
  NetworkChangeResult,
  NetworkChangeStage,
  NetworkConfigView
} from '@shared/domain/device-config'

export interface NetworkChangeInput {
  /** The network settings to apply. */
  next: NetworkConfigView
  /**
   * How long to keep polling the new address before giving up.
   * A device that is switching subnets may take a while to come back, so this is
   * generous — but not unbounded, because the user is waiting.
   */
  verifyTimeoutMs?: number
  /** Notified as the steps complete, so the UI can narrate a slow operation. */
  onProgress?: (stage: NetworkChangeStage, detail?: string) => void
}

/**
 * View models shared with the renderer: re-exported from
 * `shared/domain/device-config.ts`. See that file for why they moved.
 */
export type { NetworkChangeResult, NetworkChangeStage } from '@shared/domain/device-config'

const DEFAULT_VERIFY_TIMEOUT_MS = 45_000
const POLL_INTERVAL_MS = 1_500

/** Build `host:port` from a network configuration. */
export function addressOf(config: Pick<NetworkConfigView, 'ip' | 'httpPort'>): string {
  return config.httpPort && config.httpPort !== 80
    ? `${config.ip}:${config.httpPort}`
    : config.ip
}

/**
 * Apply a network change, reconnecting and rolling back as needed.
 *
 * @param client  A client already authenticated against the CURRENT address.
 *   The same client is repointed at the new address, so the existing session is
 *   reused where possible.
 * @param readNetwork Reads the current network config; injected so this module
 *   does not depend on ConfigService and cannot recurse into it.
 */
export async function applyNetworkChange(
  client: DeviceApiClient,
  readNetwork: () => Promise<NetworkConfigView>,
  input: NetworkChangeInput
): Promise<NetworkChangeResult> {
  const verifyTimeoutMs = input.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS
  const progress = input.onProgress ?? ((): void => undefined)

  // ---- 1. Snapshot ---------------------------------------------------------
  let previous: NetworkConfigView
  try {
    previous = await readNetwork()
  } catch (error) {
    throw new AppError(
      ErrorCodes.DEVICE_OFFLINE,
      '无法读取当前网络配置，已取消修改（没有快照就无法回滚）',
      error instanceof Error ? error.message : String(error)
    )
  }

  const oldAddress = client.currentBaseUrl
  const newAddress = addressOf(input.next)

  if (input.next.ip === previous.ip && input.next.httpPort === previous.httpPort) {
    // Same address: no reconnect dance needed, and no risk of lockout.
    progress('applying')
    await client.setNetwork(toWirePayload(input.next))
    progress('applied')
    return {
      success: true,
      stage: 'verified',
      address: newAddress,
      message: '网络配置已更新（地址未变）',
      rolledBack: false,
      unreachable: false,
      observed: input.next
    }
  }

  // ---- 2. Apply ------------------------------------------------------------
  progress('applying', `正在写入 ${newAddress}`)
  deviceLog().warn('Applying network change', { from: oldAddress, to: newAddress })

  await client.setNetwork(toWirePayload(input.next))
  progress('applied')

  // The session is invalid on the new address: the device clears it.
  client.invalidateSession()

  // ---- 3. Reconnect on the new address ------------------------------------
  progress('reconnecting', `正在连接 ${newAddress}`)
  const reachableOnNew = await waitForDevice(client, newAddress, verifyTimeoutMs, progress)

  if (reachableOnNew) {
    // ---- 4. Verify the device agrees --------------------------------------
    progress('verifying')
    const observed = await readNetwork().catch(() => undefined)

    if (observed && !sameNetwork(observed, input.next)) {
      // The device is up but reports something other than what we sent. This is
      // not a lockout, so rollback is optional — but the user must know.
      deviceLog().warn('Device reachable but reports different network settings', {
        expected: input.next,
        observed
      })
      return {
        success: false,
        stage: 'verified',
        address: newAddress,
        message:
          '设备已在新地址上线，但回读的配置与提交值不一致，请核对后再操作',
        rolledBack: false,
        unreachable: false,
        observed
      }
    }

    progress('verified')
    deviceLog().info('Network change applied and verified', { address: newAddress })
    return {
      success: true,
      stage: 'verified',
      address: newAddress,
      message: `网络配置已生效，设备在新地址 ${newAddress} 上响应正常`,
      rolledBack: false,
      unreachable: false,
      ...(observed ? { observed } : {})
    }
  }

  // ---- 5. Roll back --------------------------------------------------------
  progress('rolling-back', `新地址无响应，正在回退到 ${oldAddress}`)
  deviceLog().warn('New address unreachable; attempting rollback', {
    newAddress,
    oldAddress
  })

  client.setBaseUrl(oldAddress)
  const reachableOnOld = await waitForDevice(client, oldAddress, verifyTimeoutMs / 2, progress)

  if (!reachableOnOld) {
    // ---- 6. Neither address answers ---------------------------------------
    progress('unreachable')
    deviceLog().error('Device unreachable on both addresses after a network change', {
      oldAddress,
      newAddress
    })
    return {
      success: false,
      stage: 'unreachable',
      address: newAddress,
      message:
        `设备在旧地址 ${oldAddress} 与新地址 ${newAddress} 上均无响应，且无法回退。` +
        `请通过设备本地界面或串口恢复网络配置。`,
      rolledBack: false,
      unreachable: true
    }
  }

  // Still alive on the old address -> restore the snapshot.
  try {
    await client.setNetwork(toWirePayload(previous))
    progress('rolled-back')

    deviceLog().info('Network change rolled back', { address: oldAddress })
    return {
      success: false,
      stage: 'rolled-back',
      address: oldAddress,
      message:
        `新地址 ${newAddress} 无响应，已自动回退到原配置（${oldAddress}）。` +
        `设备配置未被改变，请检查 IP、子网掩码与网关后重试。`,
      rolledBack: true,
      unreachable: false,
      observed: previous
    }
  } catch (error) {
    progress('unreachable')
    deviceLog().error('Rollback failed', {
      address: oldAddress,
      reason: error instanceof Error ? error.message : String(error)
    })
    return {
      success: false,
      stage: 'unreachable',
      address: oldAddress,
      message:
        `设备在旧地址 ${oldAddress} 上仍有响应，但回写原配置失败。` +
        `当前网络配置可能处于不确定状态，请立即通过设备本地界面核对。`,
      rolledBack: false,
      unreachable: false,
      observed: previous
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Repoint the client and poll until the device answers, or the deadline passes.
 *
 * Polling rather than a single attempt: a device switching subnets needs time to
 * bring its interface and its web server back, and a one-shot probe would report
 * failure for a change that was actually applied correctly.
 */
async function waitForDevice(
  client: DeviceApiClient,
  address: string,
  timeoutMs: number,
  progress: (stage: NetworkChangeStage, detail?: string) => void
): Promise<boolean> {
  client.setBaseUrl(address)

  const deadline = Date.now() + timeoutMs
  let attempts = 0

  while (Date.now() < deadline) {
    attempts += 1
    try {
      // `ping` performs a real authenticated read, so a 200 from a stale server
      // is not mistaken for the device coming back.
      const alive = await client.ping({ timeoutMs: 4_000 })
      if (alive) {
        progress('connected', `${address} 已响应（第 ${attempts} 次尝试）`)
        return true
      }
    } catch {
      // Expected while the interface is down; keep polling until the deadline.
    }
    await sleep(POLL_INTERVAL_MS)
  }

  return false
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Convert the friendly view back to the wire shape the device expects. */
export function toWirePayload(config: NetworkConfigView): {
  dsyIPMode: string
  dsyIPAdder: string
  dsyIPMask: string
  dsyIPGateway: string
  dsyDNSAdder: string
  dsyHTTPPort: number
  dsyRTSPPort: number
  dsyTCPPort: number
} {
  return {
    dsyIPMode: config.mode,
    dsyIPAdder: config.ip,
    dsyIPMask: config.netmask,
    dsyIPGateway: config.gateway,
    dsyDNSAdder: config.dns,
    dsyHTTPPort: config.httpPort,
    dsyRTSPPort: config.rtspPort,
    dsyTCPPort: config.tcpPort
  }
}

/** Compare the fields that affect reachability, ignoring cosmetic differences. */
function sameNetwork(
  observed: NetworkConfigView,
  expected: NetworkConfigView
): boolean {
  return (
    observed.ip.trim() === expected.ip.trim() &&
    observed.netmask.trim() === expected.netmask.trim() &&
    observed.gateway.trim() === expected.gateway.trim() &&
    observed.httpPort === expected.httpPort
  )
}
