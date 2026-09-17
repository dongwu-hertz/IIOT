/**
 * Global renderer typings.
 *
 * `window.api` is the ONE door out of the renderer (spec appendix C rules 3/4).
 * It is installed by the preload script via contextBridge and typed as
 * `RendererApi`, so every call site is checked against the IPC contract.
 *
 * `window.events` carries main -> renderer PUSHES: device reachability from the
 * health monitor (spec 13.2), the realtime streams of both device families
 * (spec 9 for the acoustic box, manual §5.2 for the FA371 camera), and the
 * application session. Pushing matters because polling the device from the UI
 * would duplicate work the main process already does, and would make the
 * displayed values drift from the frames the main process actually measured.
 *
 * THE SHAPE ITSELF LIVES IN THE CONTRACT
 * `RendererEvents` in `@shared/ipc/contract` declares every member, and
 * `src/preload/index.d.ts` declares the same global against the same interface.
 * This file must not re-list the members: two hand-maintained copies of one
 * bridge is exactly how a channel ends up pushed but never subscribed.
 *
 * UNSUBSCRIBE DISCIPLINE (the single most likely leak in this app):
 * every member returns an unsubscribe function. The preload bridge holds the
 * callback in its own IPC listener list, so a component that subscribes and
 * forgets to call the returned function keeps its closure — and the whole
 * decoding path behind it — alive for the lifetime of the window. The monitor
 * store stores these handles and releases them in `unsubscribe()`.
 */

import type { RendererApi, RendererEvents } from '@shared/ipc/contract'

/** What every `window.events.on*` member returns. Call it on unmount. */
export type EventUnsubscribe = () => void

/** Shape shared by every push subscription on the bridge. */
export type EventSubscription<TEvent> = (
  callback: (event: TEvent) => void
) => EventUnsubscribe

declare global {
  interface Window {
    api: RendererApi
    events: RendererEvents
  }
}

export {}
