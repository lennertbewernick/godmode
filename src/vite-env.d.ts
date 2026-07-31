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
}

/**
 * Build-time define (vite.config.ts). True only for `npm run preview:pwa`, the deliberate
 * local PWA verification mode. A plain local build registers no service worker, so it can
 * never shadow the dev server on the shared port.
 */
declare const __SW_ON_LOCALHOST__: boolean;
