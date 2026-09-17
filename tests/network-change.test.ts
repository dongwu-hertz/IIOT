/**
 * Tests for the network-change transaction.
 *
 * WHY THIS IS THE MOST IMPORTANT SUITE IN THE PROJECT
 * `PUT /set_network` changes the address a device answers on. If the new address
 * is wrong and nothing recovers, the device is unreachable and the only fix is
 * physical access — on equipment that may be mounted in a substation. The device's
 * own web UI simply reloads the page and hopes.
 *
 * So the behaviour under test is not "does it send the right payload" but:
 *
 *   - does it roll back to the snapshot when the new address never answers?
 *   - does it say plainly when it cannot recover at all?
 *   - does it avoid the reconnect dance entirely when the address is unchanged?
 *
 * A fake client models the address switching, because that is the state machine
 * that actually matters and it cannot be reproduced against real hardware without
 * risking the device.
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  addressOf,
  applyNetworkChange,
  toWirePayload
} from '../src/main/services/device/network-change'
import type { NetworkConfigView } from '../src/main/services/device/config-service'
import type { DeviceApiClient } from '../src/main/services/device/device-api-client'

// ---------------------------------------------------------------------------

const ORIGINAL: NetworkConfigView = {
  mode: 'manual',
  ip: '192.168.1.50',
  netmask: '255.255.255.0',
  gateway: '192.168.1.1',
  dns: '192.168.1.1',
  httpPort: 80,
  rtspPort: 28003,
  tcpPort: 28001
}

/** A device that moves to a new address when told to, and answers where it is. */
function fakeDevice(options: {
  /** Whether the device comes up on the new address after a change. */
  reachableOnNew?: boolean
  /** Whether the device stays reachable on the old address after a change. */
  reachableOnOld?: boolean
  /** Make the rollback write itself fail. */
  failRollback?: boolean
  /** Make the initial network read fail. */
  failInitialRead?: boolean
  /** Report these settings when read back, instead of what was written. */
  observedOverride?: Partial<NetworkConfigView>
} = {}): {
  client: DeviceApiClient
  writes: Array<Record<string, unknown>>
  addressLog: string[]
  current: () => NetworkConfigView
} {
  let config: NetworkConfigView = { ...ORIGINAL }
  let address = '192.168.1.50'
  let changed = false

  const writes: Array<Record<string, unknown>> = []
  const addressLog: string[] = []

  const reachableOnNew = options.reachableOnNew ?? true
  const reachableOnOld = options.reachableOnOld ?? true

  const api = {
    get currentBaseUrl() {
      return `http://${address}`
    },
    setBaseUrl(next: string) {
      address = next.replace(/^https?:\/\//, '')
      addressLog.push(address)
    },
    invalidateSession() {
      // The device clears its session on a network change; nothing to model.
    },
    /** The device answers only where it actually is. */
    async ping(): Promise<boolean> {
      if (!changed) return true
      if (address === config.ip) return reachableOnNew
      return reachableOnOld
    },
    async setNetwork(body: Record<string, unknown>) {
      writes.push(body)
      if (options.failRollback && writes.length > 1) {
        throw new Error('simulated rollback write failure')
      }
      // The device adopts whatever it was sent.
      config = {
        mode: String(body.dsyIPMode),
        ip: String(body.dsyIPAdder),
        netmask: String(body.dsyIPMask),
        gateway: String(body.dsyIPGateway),
        dns: String(body.dsyDNSAdder),
        httpPort: Number(body.dsyHTTPPort),
        rtspPort: Number(body.dsyRTSPPort),
        tcpPort: Number(body.dsyTCPPort)
      }
      changed = true
    }
  }

  const readNetwork = async (): Promise<NetworkConfigView> => {
    if (options.failInitialRead && writes.length === 0) {
      throw new Error('simulated read failure')
    }
    return options.observedOverride ? { ...config, ...options.observedOverride } : { ...config }
  }

  return {
    client: api as unknown as DeviceApiClient,
    writes,
    addressLog,
    current: () => ({ ...config }),
    // `readNetwork` is returned through a side channel below.
  } as never as {
    client: DeviceApiClient
    writes: Array<Record<string, unknown>>
    addressLog: string[]
    current: () => NetworkConfigView
  } & { readNetwork: typeof readNetwork }
}

/** Build a fake plus its paired reader in one call. */
function scenario(options: Parameters<typeof fakeDevice>[0] = {}): {
  client: DeviceApiClient
  readNetwork: () => Promise<NetworkConfigView>
  writes: Array<Record<string, unknown>>
  current: () => NetworkConfigView
} {
  let config: NetworkConfigView = { ...ORIGINAL }
  let address = '192.168.1.50'
  let changed = false

  const writes: Array<Record<string, unknown>> = []
  const reachableOnNew = options.reachableOnNew ?? true
  const reachableOnOld = options.reachableOnOld ?? true
  let readCount = 0

  const client = {
    get currentBaseUrl() {
      return `http://${address}`
    },
    setBaseUrl(next: string) {
      address = next.replace(/^https?:\/\//, '')
    },
    invalidateSession() {
      /* no session state to clear in the fake */
    },
    async ping(): Promise<boolean> {
      if (!changed) return true
      return address === config.ip ? reachableOnNew : reachableOnOld
    },
    async setNetwork(body: Record<string, unknown>) {
      writes.push(body)
      if (options.failRollback && writes.length > 1) {
        throw new Error('simulated rollback write failure')
      }
      config = {
        mode: String(body.dsyIPMode),
        ip: String(body.dsyIPAdder),
        netmask: String(body.dsyIPMask),
        gateway: String(body.dsyIPGateway),
        dns: String(body.dsyDNSAdder),
        httpPort: Number(body.dsyHTTPPort),
        rtspPort: Number(body.dsyRTSPPort),
        tcpPort: Number(body.dsyTCPPort)
      }
      changed = true
    }
  } as unknown as DeviceApiClient

  const readNetwork = async (): Promise<NetworkConfigView> => {
    readCount += 1
    if (options.failInitialRead && readCount === 1) throw new Error('simulated read failure')
    return options.observedOverride ? { ...config, ...options.observedOverride } : { ...config }
  }

  return { client, readNetwork, writes, current: () => ({ ...config }) }
}

/** A no-op progress sink; tests that care pass their own. */
const noProgress = (): void => undefined

/** Short timeouts so the suite does not spend 45 s per rollback case. */
const FAST = { verifyTimeoutMs: 300 }

// ---------------------------------------------------------------------------

describe('addressOf / toWirePayload', () => {
  it('omits the default HTTP port', () => {
    assert.equal(addressOf({ ip: '10.0.0.1', httpPort: 80 }), '10.0.0.1')
  })

  it('includes a non-default port', () => {
    assert.equal(addressOf({ ip: '10.0.0.1', httpPort: 8080 }), '10.0.0.1:8080')
  })

  it('maps the view model back to the exact wire field names', () => {
    const wire = toWirePayload(ORIGINAL)
    assert.deepEqual(wire, {
      dsyIPMode: 'manual',
      dsyIPAdder: '192.168.1.50',
      dsyIPMask: '255.255.255.0',
      dsyIPGateway: '192.168.1.1',
      dsyDNSAdder: '192.168.1.1',
      dsyHTTPPort: 80,
      dsyRTSPPort: 28003,
      dsyTCPPort: 28001
    })
    // A view-model key must never reach the wire.
    assert.ok(!Object.keys(wire).some((key) => key === 'ip' || key === 'netmask'))
  })
})

describe('applyNetworkChange', () => {
  it('applies, reconnects and verifies a successful change', async () => {
    const { client, readNetwork, writes } = scenario({ reachableOnNew: true })
    const stages: string[] = []

    const result = await applyNetworkChange(client, readNetwork, {
      next: { ...ORIGINAL, ip: '192.168.1.77' },
      ...FAST,
      onProgress: (stage) => stages.push(stage)
    })

    assert.equal(result.success, true)
    assert.equal(result.stage, 'verified')
    assert.equal(result.address, '192.168.1.77')
    assert.equal(result.rolledBack, false)
    assert.equal(result.unreachable, false)

    // Exactly one write: no speculative rollback on the happy path.
    assert.equal(writes.length, 1)
    assert.equal(writes[0]?.dsyIPAdder, '192.168.1.77')
    // The full payload is sent, so nothing else is reset.
    assert.equal(writes[0]?.dsyIPMask, '255.255.255.0')
    assert.equal(writes[0]?.dsyRTSPPort, 28003)

    // Progress must narrate the reconnect, not jump straight to done.
    assert.ok(stages.includes('applying'))
    assert.ok(stages.includes('reconnecting'))
    assert.ok(stages.includes('verified'))
  })

  it('skips the reconnect dance when the address is unchanged', async () => {
    const { client, readNetwork, writes } = scenario()

    const result = await applyNetworkChange(client, readNetwork, {
      next: { ...ORIGINAL, dns: '8.8.8.8' },
      ...FAST,
      onProgress: noProgress
    })

    assert.equal(result.success, true)
    // A same-address change cannot lock anyone out, so no polling is warranted.
    assert.equal(writes.length, 1)
    assert.equal(writes[0]?.dsyDNSAdder, '8.8.8.8')
    assert.match(result.message, /地址未变/)
  })

  it('rolls back when the new address never answers', async () => {
    // The critical case: the device took the write but is not reachable where it
    // was told to be, while still answering on the old address.
    const { client, readNetwork, writes, current } = scenario({
      reachableOnNew: false,
      reachableOnOld: true
    })

    const result = await applyNetworkChange(client, readNetwork, {
      next: { ...ORIGINAL, ip: '192.168.9.9' },
      ...FAST,
      onProgress: noProgress
    })

    assert.equal(result.success, false)
    assert.equal(result.stage, 'rolled-back')
    assert.equal(result.rolledBack, true)
    assert.equal(result.unreachable, false)

    // Two writes: the change, then the compensating restore.
    assert.equal(writes.length, 2)
    assert.equal(writes[0]?.dsyIPAdder, '192.168.9.9')
    assert.equal(writes[1]?.dsyIPAdder, ORIGINAL.ip, 'the rollback did not restore the original IP')

    // And the device is genuinely back where it started, including every field
    // the caller never touched.
    assert.deepEqual(current(), ORIGINAL)
    assert.match(result.message, /已自动回退/)
  })

  it('reports plainly when the device answers on neither address', async () => {
    const { client, readNetwork } = scenario({ reachableOnNew: false, reachableOnOld: false })

    const result = await applyNetworkChange(client, readNetwork, {
      next: { ...ORIGINAL, ip: '10.1.2.3' },
      ...FAST,
      onProgress: noProgress
    })

    assert.equal(result.success, false)
    assert.equal(result.stage, 'unreachable')
    assert.equal(result.unreachable, true)
    assert.equal(result.rolledBack, false)
    // The message must name both addresses and point at a recovery route, because
    // this is the case where the user genuinely needs instructions.
    assert.match(result.message, /10\.1\.2\.3/)
    assert.match(result.message, /192\.168\.1\.50/)
    assert.match(result.message, /本地界面|串口/)
  })

  it('reports an uncertain state when the rollback write itself fails', async () => {
    const { client, readNetwork } = scenario({
      reachableOnNew: false,
      reachableOnOld: true,
      failRollback: true
    })

    const result = await applyNetworkChange(client, readNetwork, {
      next: { ...ORIGINAL, ip: '10.4.5.6' },
      ...FAST,
      onProgress: noProgress
    })

    assert.equal(result.success, false)
    assert.equal(result.stage, 'unreachable')
    // Crucially NOT reported as rolled back: the snapshot write did not land, so
    // the device's configuration is unknown and the user must check it.
    assert.equal(result.rolledBack, false)
    assert.match(result.message, /不确定|核对/)
  })

  it('surfaces a mismatch when the device is up but reports other settings', async () => {
    const { client, readNetwork } = scenario({
      reachableOnNew: true,
      // The device answers, but claims a different netmask than it was sent.
      observedOverride: { netmask: '255.0.0.0' }
    })

    const result = await applyNetworkChange(client, readNetwork, {
      next: { ...ORIGINAL, ip: '192.168.1.88' },
      ...FAST,
      onProgress: noProgress
    })

    assert.equal(result.success, false)
    assert.equal(result.stage, 'verified')
    assert.equal(result.rolledBack, false)
    assert.equal(result.unreachable, false)
    assert.match(result.message, /不一致/)
  })

  it('refuses to act when the current settings cannot be read', async () => {
    // Without a snapshot there is nothing to roll back to, so proceeding would be
    // reckless. The refusal must say why.
    const { client, readNetwork } = scenario({ failInitialRead: true })

    await assert.rejects(
      () =>
        applyNetworkChange(client, readNetwork, {
          next: { ...ORIGINAL, ip: '192.168.1.99' },
          ...FAST,
          onProgress: noProgress
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /快照|回滚/)
        return true
      }
    )
  })

  it('names the new address and no rollback on a verified success', async () => {
    const { client, readNetwork } = scenario({ reachableOnNew: true })
    const result = await applyNetworkChange(client, readNetwork, {
      next: { ...ORIGINAL, ip: '192.168.1.123' },
      ...FAST,
      onProgress: noProgress
    })

    assert.match(result.message, /192\.168\.1\.123/)
    assert.match(result.message, /生效/)
  })

  it('carries the edited netmask and gateway into both the write and the rollback', async () => {
    const { client, readNetwork, writes, current } = scenario({
      reachableOnNew: false,
      reachableOnOld: true
    })

    await applyNetworkChange(client, readNetwork, {
      next: { ...ORIGINAL, ip: '192.168.2.10', netmask: '255.255.0.0', gateway: '192.168.2.1' },
      ...FAST,
      onProgress: noProgress
    })

    assert.equal(writes[0]?.dsyIPMask, '255.255.0.0')
    assert.equal(writes[0]?.dsyIPGateway, '192.168.2.1')
    // The rollback restores the ORIGINAL values, not the attempted ones.
    assert.equal(writes[1]?.dsyIPMask, '255.255.255.0')
    assert.equal(writes[1]?.dsyIPGateway, '192.168.1.1')
    assert.deepEqual(current(), ORIGINAL)
  })
})
