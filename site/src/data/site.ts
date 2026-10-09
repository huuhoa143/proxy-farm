export const SITE_URL = 'https://proxyfarm.lingoreup.com';

const REPO = 'https://github.com/huuhoa143/proxy-farm';

export const links = {
  repo: REPO,
  releases: `${REPO}/releases`,
  discussions: `${REPO}/discussions`,
  issues: `${REPO}/issues`,
  securityReport: `${REPO}/security/advisories/new`,
  security: `${REPO}/blob/main/SECURITY.md`,
  support: `${REPO}/blob/main/SUPPORT.md`,
  privacy: `${REPO}/blob/main/PRIVACY.md`,
  disclaimer: `${REPO}/blob/main/DISCLAIMER.md`,
  license: `${REPO}/blob/main/LICENSE`,
  changelog: `${REPO}/blob/main/CHANGELOG.md`,
  thirdParty: `${REPO}/blob/main/THIRD_PARTY_NOTICES.md`,
};

/**
 * The current release. For the next release, change `version`: asset names and URLs
 * derive from it. Sizes are read from the GitHub release at build time; `bytes` is the
 * fallback used when GitHub can't be reached, so refresh it when convenient.
 */
export const release = {
  version: '0.2.0',
  assets: {
    'mac-arm64': { file: (v: string) => `ProxyFarm-darwin-arm64-${v}.dmg`, bytes: 145_413_281 },
    'mac-x64': { file: (v: string) => `ProxyFarm-darwin-x64-${v}.dmg`, bytes: 155_535_377 },
    'win-x64': { file: (v: string) => `Proxy.Farm.Setup.${v}.exe`, bytes: 120_702_529 },
  },
};

export type TargetId = keyof typeof release.assets;

export const releaseUrl = `${REPO}/releases/tag/v${release.version}`;

/** Download targets in display order, with the URL each button points at. */
export const downloads = (Object.keys(release.assets) as TargetId[]).map((id) => {
  const file = release.assets[id].file(release.version);
  return { id, file, url: `${REPO}/releases/download/v${release.version}/${file}`, bytes: release.assets[id].bytes };
});

/**
 * Demo media. The poster and captions are static files in public/media/. The mp4 and
 * webm are hosted on TeleCloud (LingoReUp's file host, which serves byte ranges, so
 * Safari and iOS can play and seek them); see site/README.md to replace them.
 */
export const media = {
  video: 'https://telecloud.lingoreup.com/dl/f1c53537-6c94-4390-9228-77839c1b1254_fbb9696bd6ec9000aac9830fe154d3ab',
  webm: 'https://telecloud.lingoreup.com/dl/2ca21ecd-9197-4315-9ce5-82629b930845_9bb237463f4f3acdf3bb6f3476ec9c8f',
  poster: '/media/proxy-farm-demo-poster.jpg',
  tracks: { vi: '/media/proxy-farm-demo.vi.vtt', en: '/media/proxy-farm-demo.en.vtt' },
  /** The video files are remote, so the build can't check public/ for them. */
  videoRemote: true,
};
