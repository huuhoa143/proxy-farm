import path from 'node:path';
import { defineConfig } from 'vite';

// Preload build config.
// Output to .vite/preload/index.js (its own directory, not .vite/build/)
// because the main build entry is also named `index.ts` (src/main/index.ts);
// sharing .vite/build would let one build silently overwrite the other.
// The main process loads this via path.join(__dirname, '../preload/index.js').
export default defineConfig({
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/preload/index.ts'),
      formats: ['cjs'],
      fileName: () => 'index.js',
    },
    outDir: '.vite/preload',
    emptyOutDir: true,
    rollupOptions: {
      external: ['electron'],
    },
    minify: false,
  },
});
