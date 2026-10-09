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
 * Download targets. While `url` is null the button renders as "Coming soon".
 * To publish a build, set its url to the GitHub release asset, e.g.
 *   url: 'https://github.com/huuhoa143/proxy-farm/releases/download/v0.2.0/Proxy-Farm-0.2.0-arm64.dmg',
 */
export const downloads: { id: 'mac-arm64' | 'mac-x64' | 'win-x64'; url: string | null }[] = [
  { id: 'mac-arm64', url: null },
  { id: 'mac-x64', url: null },
  { id: 'win-x64', url: null },
];

export const anyDownloadLive = downloads.some((d) => d.url);

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
