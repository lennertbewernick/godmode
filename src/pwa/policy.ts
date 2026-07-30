/**
 * Every service-worker *decision* this app makes, as pure functions.
 *
 * Nothing here reads `window`, `navigator`, `document`, `caches` or `location`, and nothing
 * here imports `virtual:pwa-register`. Every input arrives as a parameter. That is what makes
 * this file testable under jsdom — which implements neither `navigator.serviceWorker` nor the
 * Cache Storage API — while the effects live next door in `lifecycle.ts` with no branching
 * logic of their own.
 */

/**
 * How long to wait between `registration.update()` calls.
 *
 * A periodic check exists for one reason: an iOS home-screen PWA resumes rather than
 * navigates, so a group member can stay on one document for weeks and would otherwise never
 * discover that a fixed build exists. An hour is far more often than a bugfix ships and far
 * cheaper than a stranded user.
 */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Hostnames that mean "this machine". Exact matches only — see the test for why. */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Is this hostname the developer's own machine?
 *
 * Exact-match, never `startsWith`/`endsWith`: `localhost.evil.com` resolves to whatever its
 * owner wants, and a prefix test would hand it the local-only code path (purging workers,
 * probing for a dev server) on a hostile origin.
 */
export function isLocalhostHost(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname.trim().toLowerCase());
}

/**
 * Did a request for `/@vite/client` come back from an actual Vite dev server?
 *
 * The status code alone is not enough, and getting this wrong is expensive in both
 * directions. `vite preview` defaults to `appType: 'spa'`, so it answers *any* unknown path
 * with 200 and the built `index.html` — verified by hand on 2026-07-30, against the belief
 * that it 404s. Trusting `response.ok` would therefore report "a dev server is live" on every
 * static preview, purging the worker that `npm run preview:pwa` exists to install and taking
 * offline support down with it.
 *
 * The dev server serves that path as a JavaScript module; a fallback serves HTML. That
 * content-type difference is the discriminator.
 */
export function isDevServerResponse(input: { ok: boolean; contentType: string | null }): boolean {
  if (!input.ok) return false;
  const contentType = (input.contentType ?? '').toLowerCase();
  return contentType.includes('javascript') || contentType.includes('ecmascript');
}

export type LocalAction = 'register' | 'purge-and-reload' | 'purge' | 'none';

export interface LocalActionInput {
  /** `isLocalhostHost(location.hostname)`. */
  isLocalhost: boolean;
  /** `navigator.serviceWorker.controller !== null` — a worker is serving *this* document. */
  hasController: boolean;
  /** A Vite dev server answered on this origin. */
  devServerLive: boolean;
  /** The `GODMODE_SW_LOCAL=1` build flag: deliberate local PWA verification. */
  allowLocalRegistration: boolean;
  /** The sessionStorage sentinel — we have already purged and reloaded once this session. */
  alreadyPurgedThisSession: boolean;
}

/**
 * What should the app do about service workers on this load?
 *
 * The shape of this is driven by one failure: `vite preview` and `vite dev` share a port on
 * purpose (they must share an IndexedDB origin), so a worker installed by preview will serve
 * the previous build's precached `index.html` to the dev server. The developer then edits code
 * that is never fetched. Prevention is the default local preview registering nothing at all;
 * recovery is purging a worker we find in front of a live dev server.
 */
export function decideLocalAction(input: LocalActionInput): LocalAction {
  // A deployed origin always gets a worker. Offline capability is the product.
  if (!input.isLocalhost) return 'register';

  // A second purge in the same session means the first one did not take. Repeating it would
  // reload forever, which is worse than the stale worker it is trying to remove.
  const purgeAction: LocalAction = input.alreadyPurgedThisSession ? 'none' : 'purge-and-reload';

  if (input.devServerLive) {
    // A worker in front of a live dev server is always wrong, flag or no flag.
    return input.hasController ? purgeAction : 'purge';
  }

  // No dev server: this is a static local build. Only `npm run preview:pwa` wants a worker.
  if (input.allowLocalRegistration) return 'register';

  return input.hasController ? purgeAction : 'purge';
}

/**
 * May the "a newer version is ready" banner render?
 *
 * `workoutInProgress` still holds, for a narrower reason than it used to. `Runner.tsx` now
 * writes a draft to IndexedDB after every completed set, so a reload mid-session no longer
 * destroys the reps — the app offers them back on the next launch. What a reload still costs
 * is the session itself: the running rest clock, the set you are standing in, and the reps
 * typed but not yet committed. Interrupting someone mid-workout to install an update is a
 * thing not to do even when it is survivable.
 */
export function shouldOfferUpdate(input: {
  updateReady: boolean;
  workoutInProgress: boolean;
}): boolean {
  return input.updateReady && !input.workoutInProgress;
}

/**
 * Is now a reasonable moment to ask the server whether a newer build exists?
 *
 * Hidden tabs never poll: the check costs a network round trip and nobody is looking.
 */
export function shouldCheckForUpdate(input: {
  visibilityState: 'hidden' | 'visible';
  lastCheckedAt: number | undefined;
  now: number;
  minIntervalMs: number;
}): boolean {
  if (input.visibilityState === 'hidden') return false;
  if (input.lastCheckedAt === undefined) return true;
  return input.now - input.lastCheckedAt >= input.minIntervalMs;
}
