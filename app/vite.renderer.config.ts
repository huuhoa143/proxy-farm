import path from 'node:path';
import type { ConfigEnv, UserConfig } from 'vite';
import { defineConfig } from 'vite';
import { pluginExposeRenderer } from './vite.base.config';

// https://vitejs.dev/config
export default defineConfig(async (env) => {
  const forgeEnv = env as ConfigEnv<'renderer'>;
  const { mode, forgeConfigSelf } = forgeEnv;
  const name = forgeConfigSelf.name ?? '';

  const { default: react } = await import('@vitejs/plugin-react');

  return {
    // The renderer's own tree lives under src/renderer (index.html, main.tsx),
    // not at the project root — override Forge-vite's default root so Vite
    // finds index.html there in both dev and build.
    root: path.resolve(__dirname, 'src/renderer'),
    mode,
    base: './',
    plugins: [react(), pluginExposeRenderer(name)],
    build: {
      // Absolute path: `root` above is nested two levels under the project
      // root, so a relative outDir would land inside src/renderer instead of
      // alongside the main/preload builds.
      outDir: path.resolve(__dirname, '.vite/renderer', name),
    },
    resolve: {
      preserveSymlinks: true,
    },
    clearScreen: false,
  } as UserConfig;
});
