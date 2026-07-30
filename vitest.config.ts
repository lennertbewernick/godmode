import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // `server/` holds the SQLite persistence layer. Its tests open a real database through
    // `node:sqlite`, so they opt into the node environment with a `@vitest-environment` docblock
    // rather than inheriting jsdom from here.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'server/**/*.test.ts'],
    setupFiles: ['./src/test-setup.ts'],
  },
})
