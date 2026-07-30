/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />
declare module '*.css';

/**
 * Build-time define (vite.config.ts). True only for `npm run preview:pwa`, the deliberate
 * local PWA verification mode. A plain local build registers no service worker, so it can
 * never shadow the dev server on the shared port.
 */
declare const __SW_ON_LOCALHOST__: boolean;
