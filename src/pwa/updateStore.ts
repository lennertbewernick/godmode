/**
 * The seam between the service-worker lifecycle and the UI.
 *
 * This module deliberately imports nothing. `lifecycle.ts` owns the `virtual:pwa-register`
 * import, and that virtual module does not resolve under Vitest — so if `App.tsx` reached for
 * the lifecycle directly, every UI test would fail to collect. The UI subscribes here instead.
 */

type Listener = (updateReady: boolean) => void;

let updateReady = false;
const listeners = new Set<Listener>();
let applier: (() => void) | null = null;

/**
 * Subscribe to "a newer build is installed and waiting". Fires immediately with the current
 * value so a late subscriber (React mounts after `startPwa()` runs) is never left behind.
 * Returns the unsubscribe.
 */
export function subscribeUpdateReady(listener: Listener): () => void {
  listeners.add(listener);
  listener(updateReady);
  return () => {
    listeners.delete(listener);
  };
}

/** Called by the lifecycle when the plugin reports a waiting worker. */
export function markUpdateReady(): void {
  if (updateReady) return;
  updateReady = true;
  for (const listener of listeners) listener(true);
}

/** Registered by `lifecycle.ts`; this is the only thing that can reload the page. */
export function setUpdateApplier(fn: () => void): void {
  applier = fn;
}

/**
 * Activate the waiting worker and reload. Only ever called from the user's tap — this app
 * never reloads itself, because an unattended reload during a workout throws away reps that
 * Runner.tsx has not written to IndexedDB yet.
 */
export function applyUpdate(): void {
  applier?.();
}

/** Test-only reset; the module is a singleton for the app's lifetime. */
export function resetUpdateStoreForTests(): void {
  updateReady = false;
  listeners.clear();
  applier = null;
}
