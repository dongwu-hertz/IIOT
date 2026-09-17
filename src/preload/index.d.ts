/**
 * Typings for the preload bridge, compiled by `tsconfig.web.json`.
 *
 * WHY THIS FILE EXISTS ALONGSIDE `src/renderer/src/types/global.d.ts`
 * The renderer project (`tsconfig.web.json`) includes `src/preload/index.d.ts`
 * but NOT `src/renderer/src/**` from the main/Node project, and vice versa. A
 * `.d.ts` next to the preload source is the conventional place for the shape of
 * what `contextBridge` installs, and it is the file the web build can see.
 *
 * Both this file and the renderer's `global.d.ts` declare `Window.api` /
 * `Window.events`, and both do it by referencing the SAME interfaces from the
 * shared contract (`RendererApi`, `RendererEvents`). Describing the bridge twice
 * and independently is how the two drift apart: a channel added to one and not
 * the other compiles cleanly and then never fires.
 *
 * The payload types are imported from `@shared/*` rather than from `src/main/*`
 * so the renderer never compiles main-process sources — the process boundary in
 * the architecture depends on that direction staying one-way.
 */

import type { RendererApi, RendererEvents } from '@shared/ipc/contract'

declare global {
  interface Window {
    /** Request/response API installed by `src/preload/index.ts`. */
    api: RendererApi
    /** Main -> renderer pushes; every member returns an unsubscribe function. */
    events: RendererEvents
  }
}

export {}
