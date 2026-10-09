# proxyfarm.lingoreup.com

Marketing site for Proxy Farm. Static Astro, deployed as Cloudflare Workers static assets.
Vietnamese is the default at `/`, English is at `/en/`.

## Commands

Run everything from `site/`:

```bash
pnpm install
pnpm dev               # http://localhost:4321
pnpm build             # writes dist/
pnpm preview           # serves dist/
npx wrangler deploy    # uploads dist/ to the proxy-farm-site Worker (workers.dev preview)
```

`pnpm run deploy` builds and deploys in one step.

## Where things live

| What | File |
|---|---|
| All page copy, vi and en | `src/i18n/copy.ts` |
| GitHub links, the current release (version and assets), demo video paths | `src/data/site.ts` |
| Page sections | `src/components/Landing.astro` |
| Hero switchboard illustration | `src/components/Switchboard.astro` |
| `<head>`: SEO, hreflang, Open Graph, JSON-LD | `src/layouts/Base.astro` |
| Open Graph images | `public/og/og-{vi,en}.png`, rendered by `scripts/og/render.sh` from `scripts/og/og.html` |
| Security and cache headers | `public/_headers` |

## Publishing a release

The release lives in one place, `release` in `src/data/site.ts`. For a new release,
change one line:

```ts
version: '0.2.1',
```

The asset names, download URLs, JSON-LD `softwareVersion`/`downloadUrl` and every
"Phiên bản / Version" label derive from it. The asset names must still follow the
release workflow's pattern (`ProxyFarm-darwin-{arm64,x64}-<v>.dmg`,
`Proxy.Farm.Setup.<v>.exe`). If the pattern changes, edit the `file` functions in the
same block.

File sizes are read from the GitHub release when the site builds
(`src/data/release-sizes.ts`). If GitHub can't be reached, or an asset is missing from
the release, the build prints a `[downloads]` warning and shows the fallback `bytes`
from `site.ts`. Update those when convenient.

The hero button picks the visitor's OS in the browser. Macs get Apple silicon with the
Intel build next to it, because the browser can't tell the CPU apart. Windows gets the
`.exe`. Other devices, and browsers without JavaScript, link to the download section.
To show a note under the Windows row (for example about SmartScreen), set
`download.winNote` for each language in `src/i18n/copy.ts`.

## Demo video

The poster and captions are static files in `public/media/`:

- `proxy-farm-demo-poster.jpg` (16:9)
- `proxy-farm-demo.vi.vtt` and `proxy-farm-demo.en.vtt` (captions)

The video files (`proxy-farm-demo.mp4`, H.264 16:9, and `proxy-farm-demo.webm`) are not in
git. They are hosted on TeleCloud (telecloud.lingoreup.com, folder `proxy-farm-site`),
which serves byte ranges (HTTP 206); Safari and iOS need those to play and seek a
`<video>`, and Workers static assets answer 200 only. Their links are in
`src/data/site.ts` (`media.video`, `media.webm`), and `public/_headers` allows the host
in `media-src`.

To replace a video, upload it with the TeleCloud upload API (`POST /api/upload-api/upload`,
fields `file`, `path=proxy-farm-site`, `share=public`) and put the returned `direct_link`
in `site.ts`. Upload files larger than a few MB from the TeleCloud host itself
(`http://127.0.0.1:8091` on the server): through Cloudflare the request times out
after 100 s (HTTP 524).

## Custom domain

The Worker serves proxyfarm.lingoreup.com through the `routes` entry in
`wrangler.jsonc` (a Workers custom domain on the `lingoreup.com` zone), and the
workers.dev URL stays available as a preview. `npx wrangler deploy` updates both;
Cloudflare manages the DNS record and certificate.

After going live, submit `https://proxyfarm.lingoreup.com/sitemap-index.xml` in Google
Search Console.
