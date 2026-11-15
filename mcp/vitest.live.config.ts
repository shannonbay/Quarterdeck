import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'url'

/**
 * The live tests: the bundled server (plugins/quarterdeck-goals/server/quarterdeck-mcp.mjs)
 * over stdio, with a database file of its own. `npm run test:live` builds the bundle first.
 * They are `*.live.ts`, so `npm test` (vitest.config.ts) leaves them out.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/tests/live/**/*.live.ts'],
    // Each file starts a server and plays whole goals through it
    testTimeout: 120_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
  resolve: {
    // Only for what the tests read themselves (the Database class, the defaults): the server is the bundle
    alias: { '@quarterdeck/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) },
  },
})
