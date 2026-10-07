import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, copyFile, chmod, cp } from 'node:fs/promises';
import path from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

// Single source of truth for the auto-update feed. Both the Forge publisher
// (build/upload time) and the runtime `app-update.yml` shipped inside the
// packaged app (written by the packageAfterCopy hook below) read from here,
// so they cannot drift apart. Pattern copied from lingoreup.
const UPDATER = {
  provider: 'github' as const,
  owner: process.env.UPDATER_REPO_OWNER || 'huuhoa143',
  repo: process.env.UPDATER_REPO_NAME || 'proxy-farm',
  // Used by electron-updater to locate the per-user cache dir.
  updaterCacheDirName: 'proxyfarm-updater',
};

// Hand-rolled YAML keeps the build hook dependency-free. electron-updater's
// js-yaml loader is permissive — required fields are listed first so
// failures surface clearly.
const APP_UPDATE_YML = [
  `provider: ${UPDATER.provider}`,
  `owner: ${UPDATER.owner}`,
  `repo: ${UPDATER.repo}`,
  `updaterCacheDirName: ${UPDATER.updaterCacheDirName}`,
  '',
].join('\n');

const APP_UPDATE_REQUIRED_KEYS = ['provider:', 'owner:', 'repo:', 'updaterCacheDirName:'] as const;

// Maps an electron-packager (platform, arch) pair to the asset key used in
// scripts/singbox.pins.json / app/resources/sing-box/<key>/. This is what
// makes packaging per-arch-correct: a darwin/x64 build bundles the amd64
// binary, a darwin/arm64 build bundles the arm64 one, never both — unlike a
// static `packagerConfig.extraResource` array (which can't vary per build,
// since forge.config.ts is evaluated once regardless of --platform/--arch).
const SINGBOX_PLATFORM_KEYS: Record<string, string> = {
  'darwin-arm64': 'darwin-arm64',
  'darwin-x64': 'darwin-amd64',
  'win32-x64': 'windows-amd64',
};

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    // Go 1.26 (sing-box's toolchain) floors at macOS 12. Set explicitly so
    // the release pipeline's min-macOS check (spec §9) verifies a value this
    // config controls, rather than one Electron happened to default to.
    extendInfo: { LSMinimumSystemVersion: '12.0' },
  },
  rebuildConfig: {},
  hooks: {
    // packageAfterCopy fires before electron-packager copies any
    // extraResource, but the Resources dir already exists at this point, so
    // it's safe to write files directly under it here.
    packageAfterCopy: async (_forgeConfig, buildPath, _electronVersion, platform, arch) => {
      const resourcesDir = path.resolve(buildPath, '..');

      // ── app-update.yml (electron-updater feed, read by the packaged app) ──
      const ymlPath = path.join(resourcesDir, 'app-update.yml');
      await writeFile(ymlPath, APP_UPDATE_YML, 'utf8');
      const written = await readFile(ymlPath, 'utf8');
      for (const key of APP_UPDATE_REQUIRED_KEYS) {
        if (!written.includes(key)) {
          throw new Error(`app-update.yml is missing required field "${key.slice(0, -1)}" at ${ymlPath}`);
        }
      }

      // ── sing-box binary for THIS build's platform/arch only (spec §6, §9) ──
      // Hard-fails rather than silently shipping an app with no VPN engine:
      // a packaged app missing sing-box is a worse failure mode than a build
      // that refuses to proceed, and it would otherwise only be caught much
      // later by sign-proxyfarm-bundle.sh's own hard gate (defense in depth,
      // not a replacement for it — that gate stays, in case this hook is
      // ever bypassed, e.g. a manual `electron-packager` invocation).
      const platformKey = SINGBOX_PLATFORM_KEYS[`${platform}-${arch}`];
      if (!platformKey) {
        throw new Error(
          `No sing-box platform mapping for ${platform}/${arch}. ` +
            `Supported: darwin/arm64, darwin/x64, win32/x64 (see SINGBOX_PLATFORM_KEYS).`,
        );
      }
      const pinsPath = path.resolve(process.cwd(), 'scripts', 'singbox.pins.json');
      const pins = JSON.parse(await readFile(pinsPath, 'utf8'));
      const pin = pins.assets?.[platformKey];
      if (!pin) {
        throw new Error(`No sing-box pin for platform "${platformKey}" in ${pinsPath}`);
      }
      const srcBinary = path.resolve(process.cwd(), 'resources', 'sing-box', platformKey, pin.binaryName);
      if (!existsSync(srcBinary)) {
        throw new Error(
          `sing-box binary missing: ${srcBinary}\n` +
            `Run: node scripts/prebuild-singbox.mjs${platform === process.platform && arch === process.arch ? '' : ' --all'}` +
            ` (fetches the pinned binary for ${platformKey})`,
        );
      }
      const destDir = path.join(resourcesDir, 'sing-box', platformKey);
      await mkdir(destDir, { recursive: true });
      const destBinary = path.join(destDir, pin.binaryName);
      await copyFile(srcBinary, destBinary);
      if (platform !== 'win32') {
        await chmod(destBinary, 0o755);
      }

      // ── provider resources: public CA files + bundled catalogs (spec §5) ──
      // Read at runtime from <Resources>/{ca,catalogs} (src/main/resources-root.ts);
      // they can't live inside app.asar's Vite bundle because providers read them
      // with fs at runtime. Hard-fail if absent, same reasoning as sing-box above.
      for (const dir of ['ca', 'catalogs']) {
        const src = path.resolve(process.cwd(), 'resources', dir);
        if (!existsSync(src)) throw new Error(`provider resources missing: ${src}`);
        await cp(src, path.join(resourcesDir, dir), { recursive: true });
      }
    },
  },
  makers: [
    // Windows installer: NSIS (via @electron-addons/electron-forge-maker-nsis,
    // which wraps electron-builder's NSIS target). Per-user install, UTF-8
    // native, works with electron-updater's GitHub-releases feed.
    {
      name: '@electron-addons/electron-forge-maker-nsis',
      config: {
        // Unsigned for now (no certificate yet); a signing hook can be added
        // to this config later without changing the maker.
        updater: {
          url: `https://github.com/${UPDATER.owner}/${UPDATER.repo}/releases/latest/download`,
          updaterCacheDirName: UPDATER.updaterCacheDirName,
          channel: 'latest',
        },
      },
      platforms: ['win32'],
    },
    new MakerZIP({}, ['darwin']),
  ],
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: { owner: UPDATER.owner, name: UPDATER.repo },
        prerelease: false,
        draft: false,
      },
    },
  ],
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds: main process, preload
      // scripts, worker process, etc.
      build: [
        {
          entry: 'src/main/index.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/index.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality at
    // package time, before code signing the application.
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
