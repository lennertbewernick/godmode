import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'

/**
 * The port is pinned deliberately, and it is the same port for `dev` and `preview`.
 *
 * In a browser the origin — scheme, host AND port — owns the IndexedDB. `localhost:5173` and
 * `localhost:5174` are two different databases. So Vite's two normal behaviours are both traps
 * for this app: it silently falls forward to the next free port when one is busy, and `preview`
 * defaults to 4173 while `dev` defaults to 5173.
 *
 * Either one leaves your history sitting in an origin you are no longer visiting. Nothing is
 * lost, but the app opens on the Welcome screen as if you had never used it, and there is no
 * clue as to why. `strictPort` turns that into a startup error instead.
 *
 * Override per machine with GODMODE_PORT in a local `.env` — see `.env.example`. Changing it
 * moves you to a new, empty origin, so export a backup first.
 */
const DEFAULT_PORT = 5173

function resolvePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    // Never fall back to the default here: a typo would silently move the whole database.
    throw new Error(
      `GODMODE_PORT must be an integer from 1 to 65535, received "${raw}". ` +
        'The port is part of the origin that owns your IndexedDB, so guessing one would ' +
        'point the app at a different (empty) database.',
    )
  }
  return port
}

export default defineConfig(({ mode }) => {
  // Empty prefix: the port is a local concern and has no business being exposed to the client.
  // process.env wins over the .env file, so `GODMODE_PORT=5200 npm run dev` works inline.
  const env = loadEnv(mode, process.cwd(), '')
  const port = resolvePort(env.GODMODE_PORT)

  // Unset means localhost only. Set to 0.0.0.0 to reach the dev server from a phone on the
  // same network — useful, but note that over plain HTTP iOS will not register a service
  // worker, so there is no home-screen install and nothing works offline.
  const host = env.GODMODE_HOST?.trim() || undefined

  return {
    base: './',
    define: {
      /**
       * The deliberate-verification escape hatch: `npm run preview:pwa` sets GODMODE_SW_LOCAL=1
       * so a local build registers a real service worker and offline can be tested.
       *
       * A plain `npm run preview` registers nothing. That is the fix for the dev-server
       * shadowing bug — see the port comment above: `dev` and `preview` share one origin on
       * purpose, so a worker installed by preview would otherwise serve the previous build's
       * precached index.html to the dev server, and the developer would edit code the browser
       * never fetches.
       */
      __SW_ON_LOCALHOST__: JSON.stringify(env.GODMODE_SW_LOCAL === '1'),
    },
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: { port, strictPort: true, ...(host === undefined ? {} : { host }) },
    preview: { port, strictPort: true, ...(host === undefined ? {} : { host }) },
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        /**
         * 'prompt', not 'autoUpdate'.
         *
         * Under 'autoUpdate' the plugin sets skipWaiting + clientsClaim, so a new worker takes
         * over a live page on its own schedule, and the plugin's own register client calls
         * window.location.reload() on activation with no idea whether a workout is running.
         * Runner.tsx holds the session's reps in React state until the workout is saved, so
         * that reload silently destroys them. Under 'prompt' the new worker waits until the app
         * asks — which only happens on the user's tap — so the guard is structural.
         */
        registerType: 'prompt',
        /**
         * The app registers the worker itself (src/pwa/lifecycle.ts). Letting the plugin also
         * inject registerSW.js would give us two registration paths that disagree about the
         * policy, and the injected one runs first.
         */
        injectRegister: false,
        includeAssets: ['favicon.svg'],
        manifest: {
          name: 'GodMode: No More Later',
          short_name: 'GodMode',
          description: 'Progressive bodyweight challenge planner. Local-first, no accounts.',
          theme_color: '#0f172a',
          background_color: '#0f172a',
          display: 'standalone',
          orientation: 'portrait',
          start_url: './',
          icons: [
            { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
          navigateFallback: 'index.html',
          /**
           * Already the plugin's default and already present in dist/sw.js — restated so a
           * future default change cannot silently strand a previous build's precache on a
           * group member's phone, where storage is scarce and eviction is the real risk.
           */
          cleanupOutdatedCaches: true,
          /**
           * reset-sw.html must never be answered from the precache. It is the recovery page,
           * so it is needed exactly when the installed worker is the problem; navigateFallback
           * would otherwise hand back index.html and the page would be unreachable.
           * Suffix-anchored and prefix-free, so it holds at any deploy subpath.
           */
          navigateFallbackDenylist: [/reset-sw\.html$/],
          /** Same reason: it is a network tool and has no offline job. */
          globIgnores: ['reset-sw.html'],
        },
      }),
    ],
  }
})
