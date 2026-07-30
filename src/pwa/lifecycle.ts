import { registerSW } from 'virtual:pwa-register';
import {
  UPDATE_CHECK_INTERVAL_MS,
  decideLocalAction,
  isLocalhostHost,
  shouldCheckForUpdate,
} from './policy.js';
import { markUpdateReady, setUpdateApplier } from './updateStore.js';

/**
 * The only file in this repo that imports `virtual:pwa-register`, and the only file that
 * performs a service-worker effect. Every decision it takes comes from `policy.ts`, which is
 * pure and fully tested; there is deliberately no branching logic of its own beyond the switch
 * below, because none of this is reachable from a test runner (jsdom implements neither
 * navigator.serviceWorker nor Cache Storage, and the virtual module does not resolve under
 * Vitest). Effects here are verified in a browser.
 */

/** Survives a reload, dies with the tab. This is what makes a purge unable to loop. */
const PURGED_SENTINEL_KEY = 'godmode.pwa.purged';

let lastCheckedAt: number | undefined;

function readPurgedSentinel(): boolean {
  try {
    return sessionStorage.getItem(PURGED_SENTINEL_KEY) === '1';
  } catch {
    // Private mode / storage blocked. Treat as "not yet purged": one purge is safe, and the
    // worst case without the sentinel is that we do it again on the next load.
    return false;
  }
}

function writePurgedSentinel(): void {
  try {
    sessionStorage.setItem(PURGED_SENTINEL_KEY, '1');
  } catch {
    // Nothing to do. See above.
  }
}

/**
 * Remove every service worker registration and every Cache Storage entry on this origin.
 *
 * It does exactly those two things.
 *
 * It must NEVER reach for the database, the storage-quota API, or local storage. Cache Storage
 * on this origin holds nothing but service-worker precache — the app never writes to it, so
 * deleting it costs a re-download and nothing else. The database holds the entire training log
 * and this device is the only copy of it. Local storage holds the open tab. There is no
 * version of "clear site data" that belongs in this function.
 *
 * (Kept free of the literal API names on purpose: the plan's safety gate greps this directory
 * for them, and a comment must not be able to make that gate pass or fail on prose.)
 */
async function purge(): Promise<void> {
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const registration of registrations) await registration.unregister();
  } catch {
    // A failed unregister must not stop the cache sweep, and must not break the app.
  }
  try {
    if ('caches' in globalThis) {
      const keys = await caches.keys();
      for (const key of keys) await caches.delete(key);
    }
  } catch {
    // Same: best effort. The reset page is the fallback if this ever fails silently.
  }
}

async function probeDevServer(): Promise<boolean> {
  try {
    // Absolute path on purpose: the dev server roots at `/` whatever `base: './'` says.
    // `vite preview` serves static files out of dist and 404s here, which is exactly what
    // makes this a sound discriminator between "a dev server is hiding behind this worker"
    // and "this is a real static build".
    const response = await fetch('/@vite/client', { cache: 'no-store' });
    return response.ok;
  } catch {
    return false;
  }
}

function register(): void {
  const updateSW = registerSW({
    immediate: true,
    // A waiting worker only ever raises a banner. No `onNeedRefresh` reload, and deliberately
    // no `onNeedReload` / `registerType: 'autoUpdate'` — either would reintroduce an
    // unattended reload, which mid-workout destroys reps Runner.tsx has not saved yet.
    onNeedRefresh: () => markUpdateReady(),
    onRegisteredSW: (_swScriptUrl, registration) => {
      if (!registration) return;

      const check = (): void => {
        if (
          !shouldCheckForUpdate({
            visibilityState: document.visibilityState,
            lastCheckedAt,
            now: Date.now(),
            minIntervalMs: UPDATE_CHECK_INTERVAL_MS,
          })
        ) {
          return;
        }
        lastCheckedAt = Date.now();
        void registration.update().catch(() => {
          // Offline, or the host is down. Nothing to report; we try again later.
        });
      };

      window.setInterval(check, UPDATE_CHECK_INTERVAL_MS);
      // This is the hook that actually matters. An iOS home-screen PWA resumes rather than
      // navigates, so without it a group member can sit on a known-broken build for weeks.
      document.addEventListener('visibilitychange', check);
    },
    onRegisterError: () => {
      // Swallowed on purpose: no service worker is a degraded app, but a thrown error here
      // would be an app that does not start at all.
    },
  });

  setUpdateApplier(() => {
    void updateSW();
  });
}

/**
 * Decide and apply this origin's service-worker policy. Call once at boot, fire and forget:
 * it must never block or fail the render.
 */
export async function startPwa(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;

  const isLocalhost = isLocalhostHost(location.hostname);
  // Never probe for dev tooling on a deployed origin — the request has no business leaving
  // the developer's own machine.
  const devServerLive = isLocalhost ? await probeDevServer() : false;

  const action = decideLocalAction({
    isLocalhost,
    hasController: navigator.serviceWorker.controller !== null,
    devServerLive,
    allowLocalRegistration: __SW_ON_LOCALHOST__,
    alreadyPurgedThisSession: readPurgedSentinel(),
  });

  switch (action) {
    case 'register':
      register();
      return;
    case 'purge':
      await purge();
      return;
    case 'purge-and-reload':
      await purge();
      // Set the sentinel before reloading, or the next load makes the same decision forever.
      writePurgedSentinel();
      location.reload();
      return;
    case 'none':
      return;
  }
}
