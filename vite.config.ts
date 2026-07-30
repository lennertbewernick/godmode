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
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: { port, strictPort: true, ...(host === undefined ? {} : { host }) },
    preview: { port, strictPort: true, ...(host === undefined ? {} : { host }) },
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
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
        },
      }),
    ],
  }
})
