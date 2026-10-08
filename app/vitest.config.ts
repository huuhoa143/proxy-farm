import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Renderer/tray tests touch the DOM (React components) or build fake
    // Electron Tray/Menu objects; everything else (providers, engine,
    // controller) stays on the faster node environment.
    environmentMatchGlobs: [
      ['src/renderer/**/*.test.{ts,tsx}', 'jsdom'],
      ['src/main/tray.test.ts', 'node'],
    ],
    setupFiles: ['./src/renderer/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs'],
    exclude: ['node_modules/**', 'dist/**', '.vite/**', 'out/**'],
  },
});
