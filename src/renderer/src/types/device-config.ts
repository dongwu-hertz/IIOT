/**
 * Device-configuration view types, re-exported for the renderer.
 *
 * WHY THIS FILE STILL EXISTS
 * The authoritative shapes (`ChannelConfigView`, `AlarmProfileConfig`, …) are
 * declared by the main-process service that produces them, and
 * `RendererApi['config']` is typed with them. They are deliberately NOT copied
 * into the renderer: a second copy would drift, and a drifted field name fails
 * silently at runtime (the store reads `undefined` and the form renders blank).
 *
 * They now come from `@shared/ipc/contract`, which re-exports them. That is the
 * important change: this module used to import them straight from the
 * main-process service files, which forced the renderer's TypeScript project to
 * compile main-process sources — quietly dissolving the process boundary the
 * architecture depends on. Going through the shared contract keeps the
 * dependency one-way.
 *
 * RULE: nothing in the renderer may import from the main-process source tree.
 * If a type is needed here, it belongs in `src/shared/domain/`.
 *
 * This file remains as the single, discoverable place the renderer obtains those
 * types, so every component imports from one path.
 *
 * `export type` (not `import` + `export`) matters: nothing here survives into the
 * renderer bundle, so no main-process code can be pulled into the SPA.
 */

export type {
  AlarmProfileConfig,
  ChannelConfigView,
  ModbusConfigView,
  NetworkChangeResult,
  NetworkChangeStage,
  NetworkConfigView,
  PushConfigView,
  Rs485ConfigView,
  TimeConfigView
} from '@shared/ipc/contract'
