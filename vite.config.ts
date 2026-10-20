import { defineConfig } from 'vitest/config';

// GitHub Pages serves the site from /map2print/
export default defineConfig(({ command }) => ({
  base: command === 'build' ? './' : '/',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 60000 },
}));
