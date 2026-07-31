/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />
declare module '*.css';

interface ImportMetaEnv {
  /**
   * The URL of the running app's source, for the AGPL §13 "Source code" link. A deployment sets
   * this to its own tree at build time (`server/DEPLOY.md` calls it the repo URL); unset, the app
   * falls back to the JustClose fork. Must be `VITE_`-prefixed to reach the client build.
   */
  readonly VITE_GODMODE_REPO_URL?: string;
  /**
   * The Web Push VAPID **public** key, base64url, provisioned by DevOps (LBV-1481). The client
   * subscribes with it; the matching private key never leaves the sender. A public key is public by
   * definition, so embedding it in the build is correct. Unset, reminders report as unavailable and
   * the opt-in is hidden — the app still works, it just cannot offer push. Must be `VITE_`-prefixed
   * to reach the client build.
   */
  readonly VITE_GODMODE_VAPID_PUBLIC_KEY?: string;
}

/**
 * Build-time define (vite.config.ts). True only for `npm run preview:pwa`, the deliberate
 * local PWA verification mode. A plain local build registers no service worker, so it can
 * never shadow the dev server on the shared port.
 */
declare const __SW_ON_LOCALHOST__: boolean;
