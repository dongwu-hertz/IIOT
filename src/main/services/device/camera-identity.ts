/**
 * Identity of an FA371 acoustic camera.
 *
 * THE PROBLEM
 * Spec section 6 rule: "IP is not a device identity". Every other device this app
 * supports can honour that rule, because the firmware tells us who it is —
 * an acoustic box answers `GET /get_devinfo` with a Device ID / SN, and that value
 * is stored as `devices.device_uid` so that a device which moves to a new address
 * is recognised as the same box rather than duplicated.
 *
 * The FA371 documents 32 open-interface endpoints
 * (`docs/reference/FA371-api-spec.md`) and **not one of them returns identity**.
 * Its `/system/*` endpoints return acoustic, imaging and video *configuration*;
 * there is no version, serial or device-name readout, and no endpoint that reports
 * the MAC. Login returns a token and nothing else. So at the time of writing the
 * camera CANNOT satisfy the "identity is not the address" rule, and pretending
 * otherwise would be the dishonest option.
 *
 * WHAT THIS DOES INSTEAD
 * Mints a deterministic, self-describing uid from the address, and records the
 * limitation where a developer will actually meet it. Two consequences, both
 * deliberate and both visible in the UI flow:
 *
 *   1. Re-adding the SAME address is recognised as the same camera (idempotent, so
 *      the Add dialog can say "已注册" instead of creating a second row).
 *   2. Moving a camera to a new IP creates a SECOND device row. The operator sees
 *      a new entry rather than a silent merge, which is recoverable by hand;
 *      silently merging two different cameras that happen to reuse an address
 *      would be far worse.
 *
 * The `fa371:` prefix keeps these uids from ever colliding with a firmware-issued
 * one, and it is legible in the database: seeing `fa371:192.168.2.168:80` tells a
 * developer immediately that identity was minted locally, not measured.
 *
 * WHEN THIS GETS BETTER: the manual is the only source so far. A real camera may
 * well answer an undocumented `/get_devinfo` (the firmware family clearly shares
 * DNA with the acoustic box — same `md5(password + 'lfxs')` login salt). That is
 * exactly what the Protocol Lab page exists to measure; when it does, prefer the
 * device-reported value and keep this as the fallback. See
 * `docs/reference/FA371-api-spec.md` section 9.
 */

const CAMERA_UID_PREFIX = 'fa371'

/** Default HTTP port for the camera's web UI / open interface. */
export const FA371_DEFAULT_HTTP_PORT = 80

/**
 * Deterministic uid for a camera at an address.
 *
 * Pure and total: a missing port falls back to the protocol default rather than
 * producing `fa371:host:undefined`, which would create a second row for the same
 * device depending on which code path built the input.
 */
export function cameraDeviceUid(ip: string, httpPort?: number): string {
  const host = ip.trim().toLowerCase()
  const port = isUsablePort(httpPort) ? httpPort : FA371_DEFAULT_HTTP_PORT
  return `${CAMERA_UID_PREFIX}:${host}:${port}`
}

/**
 * True when a uid was minted locally rather than reported by a device.
 *
 * Used to keep the two identity regimes from being confused in logs and in the
 * Add dialog's "already registered" check.
 */
export function isMintedCameraUid(deviceUid: string): boolean {
  return deviceUid.startsWith(`${CAMERA_UID_PREFIX}:`)
}

/** Fallback label, used when the operator supplies no name of their own. */
export function cameraFallbackName(ip: string): string {
  return `Acoustic Camera ${ip.trim()}`
}

/** Default HTTP port for the auscultation family's web UI / open interface. */
export const E2_DEFAULT_HTTP_PORT = 80

/**
 * 听诊盒子族（E2 / FA100 / FA110）的**兜底** uid。
 *
 * 与相机不同，这一族**通常不需要兜底**：`GET /basic` 的 `equip_number`
 * （手册："Device identifier code, not modifiable"）就是设备自己的标识，优先用它。
 * 只有在固件没填 `equip_number` 时才退到这里 —— 那时 uid 只能按地址编，而
 * "IP 不是设备身份"这条规则就**做不到**了，所以前缀是 `e2ip:` 而不是 `e2:`：
 * 一眼能看出这一个身份是**按地址编的**，不是设备给的（`e2:<equip_number>` 才是）。
 */
export function e2FallbackUid(ip: string, httpPort?: number): string {
  const host = ip.trim().toLowerCase()
  const port = isUsablePort(httpPort) ? httpPort : E2_DEFAULT_HTTP_PORT
  return `e2ip:${host}:${port}`
}

/** 设备自己报的标识（`/basic` 的 `equip_number`）。 */
export function e2DeviceUid(equipNumber: string): string {
  return `e2:${equipNumber.trim()}`
}

/** 这一族的 uid 是不是按地址编出来的（而不是设备给的）。 */
export function isMintedE2Uid(deviceUid: string): boolean {
  return deviceUid.startsWith('e2ip:')
}

/** Fallback label, used when the operator supplies no name of their own. */
export function auscultationFallbackName(ip: string): string {
  return `Auscultation Box ${ip.trim()}`
}

function isUsablePort(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535
}
