import { defineConfig } from 'vitest/config'

export default defineConfig({
  // A fixed tsconfig, so vite doesn't look one up per file: the guard tests import the goals plugin's
  // templates (the real tool maps), and the plugin's tsconfig extends types Claude Code generates in place.
  esbuild: { tsconfigRaw: '{"compilerOptions":{"target":"ES2022"}}' },
})
