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
| GitHub links, download targets, demo video paths | `src/data/site.ts` |
| Page sections | `src/components/Landing.astro` |
| Hero switchboard illustration | `src/components/Switchboard.astro` |
| `<head>`: SEO, hreflang, Open Graph, JSON-LD | `src/layouts/Base.astro` |
| Open Graph images | `public/og/og-{vi,en}.png`, rendered by `scripts/og/render.sh` from `scripts/og/og.html` |
| Security and cache headers | `public/_headers` |

## Publishing downloads

The download buttons show "Sắp ra mắt / Coming soon" while their `url` is `null`.
To publish a build, set the url in `src/data/site.ts` to the GitHub release asset:

```ts
{ id: 'mac-arm64', url: 'https://github.com/huuhoa143/proxy-farm/releases/download/v0.2.0/<asset>.dmg' },
```

When any url is set, the hero button drops its "coming soon" pill.

## Demo video

Put these files in `public/media/` and rebuild. The demo section switches from the
placeholder to the player at build time when the mp4 exists:

- `proxy-farm-demo.mp4` (H.264, 16:9)
- `proxy-farm-demo-poster.jpg` (16:9)
- `proxy-farm-demo.vi.vtt` and `proxy-farm-demo.en.vtt` (captions; each is optional)

## Custom domain

The Worker serves proxyfarm.lingoreup.com through the `routes` entry in
`wrangler.jsonc` (a Workers custom domain on the `lingoreup.com` zone), and the
workers.dev URL stays available as a preview. `npx wrangler deploy` updates both;
Cloudflare manages the DNS record and certificate.

After going live, submit `https://proxyfarm.lingoreup.com/sitemap-index.xml` in Google
Search Console.
