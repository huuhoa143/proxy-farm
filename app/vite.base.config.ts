import type { Plugin, ViteDevServer } from 'vite';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface Process {
      viteDevServers?: Record<string, ViteDevServer>;
    }
  }
}

// Exposes each renderer's dev server on `process.viteDevServers` so the main
// process build (vite.main.config.ts) can reach it in dev mode. Copied from
// the lingoreup/electron-forge-plugin-vite default template.
export const pluginExposeRenderer = (name: string): Plugin => {
  return {
    name: `expose-renderer-${name}`,
    configureServer(server) {
      process.viteDevServers ??= {};
      process.viteDevServers[name] = server;
    },
  };
};
