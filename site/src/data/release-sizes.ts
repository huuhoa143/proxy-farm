import { downloads, release } from './site';

type Download = (typeof downloads)[number];

/**
 * Asset sizes from the GitHub release, read once per build. If GitHub can't be reached
 * or an asset is missing, the fallback size in site.ts is used and the build says so.
 */
export async function withLiveSizes(): Promise<Download[]> {
  const api = `https://api.github.com/repos/huuhoa143/proxy-farm/releases/tags/v${release.version}`;
  try {
    const res = await fetch(api, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { assets: { name: string; size: number }[] };
    return downloads.map((d) => {
      const asset = json.assets.find((a) => a.name === d.file);
      if (!asset) console.warn(`[downloads] ${d.file} is not on release v${release.version}; using the fallback size`);
      return asset ? { ...d, bytes: asset.size } : d;
    });
  } catch (err) {
    console.warn(`[downloads] could not read release v${release.version} (${(err as Error).message}); using fallback sizes`);
    return downloads;
  }
}

const cache = new Map<string, Promise<Download[]>>();
export const getDownloads = () => {
  if (!cache.has(release.version)) cache.set(release.version, withLiveSizes());
  return cache.get(release.version)!;
};

export const formatSize = (bytes: number, lang: 'vi' | 'en') =>
  `${new Intl.NumberFormat(lang === 'vi' ? 'vi-VN' : 'en-US', { maximumFractionDigits: 0 }).format(bytes / 1e6)} MB`;
