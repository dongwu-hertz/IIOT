/**
 * Vite client typings.
 *
 * `vite/client` declares `import.meta.env` and the `*.vue` module shape, so this
 * reference is what makes both `import.meta.env.VITE_*` and component imports
 * type-check.
 */

/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Set to '1' by the headless smoke test to enable a read-only self-check
   * probe on `window`, letting the smoke test verify the device-status push
   * chain from outside the renderer.
   *
   * Absent (treated as '0') in normal dev and production builds, so no probe
   * exists in a shipped binary.
   */
  readonly VITE_SMOKE_PROBE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
