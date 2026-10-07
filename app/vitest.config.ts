import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    exclude: ['node_modules/**', 'dist/**', '.vite/**', 'out/**'],
  },
});
