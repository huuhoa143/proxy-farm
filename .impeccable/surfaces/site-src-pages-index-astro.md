---
version: 1
slug: "site-src-pages-index-astro"
primary_target: "site/src/pages/index.astro"
related_targets: ["site/src/pages/en/index.astro"]
---

# Surface brief: proxyfarm.lingoreup.com landing (vi at /, en at /en/)

Mode: Persuade. Audience: people who already pay for a VPN; MMO/multi-account operators; scraping/research; dev/QA. Mostly Vietnamese.
Job: understand "your own VPN becomes many local proxy ports, one fixed IP per port", trust it (local, open source, no telemetry, honest about ToS), then act: download (coming soon), watch the demo, or open GitHub.
Proof on hand: real app screenshots (docs/screenshots/v2), demo video (pending files), README/CHANGELOG facts. No testimonials, counts, logos, pricing.
Constraints: no provider logos (text names); unreleased features labelled as next release; download buttons "Sắp ra mắt / Coming soon" driven by one data file.
Visual direction: delegated to the agent by the user (team-lead message, 2026-10-09); unattended run, decision page skipped by instruction.

## Direction contract

THESIS: The page is a telephone switchboard for IPs: local ports on one side, VPN servers on the other, one cord per port. It refuses the category default of a dark neon "network globe" hero with stat counters and icon-card grids.

OWN-WORLD: The app's own palette carried to page scale: cool porcelain ground (#eef1f7 family), ink-navy instrument plate (#080b13 / #0f1524) for the switchboard, brand green (#00dd8a / #009a5b) as the live-line lamp and primary action, amber/red only as status lamps. Cords take the app's provider colours (HMA yellow, ZoogVPN blue, Surfshark teal, NordVPN indigo, ExpressVPN red). Be Vietnam Pro for all prose and display; JetBrains Mono only for ports, IPs and proxy strings. Jacks are round, labels are banded strips (port · location · provider · latency), rules are 1px hairlines on a strict tabular grid.

STORY: Visitor sees ports wired to servers, presses Change IP, watches one cord re-patch and its exit IP change; understands BYO VPN, local and free; then reads how it works, providers and limits, sees real screenshots, finds their use case, reads honest FAQ, and leaves via Download (coming soon) or GitHub.

FIRST VIEWPORT: Left 5/12: name, headline at display scale (~4.5rem desktop), one-paragraph mechanism, primary green "Download, coming soon" with OS line, secondary "Watch demo" and GitHub. Right 7/12: the switchboard plate, six jacks 127.0.0.1:29001–29006 left, server lines grouped by city right, SVG cords between, exit IP per row, a Change IP control; labelled "illustration". Header: icon, Proxy Farm by LingoReUp, anchors, VI/EN, GitHub.

FORM: Telephone switchboard, position 7 of the ordered list (1 patch panel, 2 app dashboard, 3 proxy list file, 4 departures board, 5 newsroom city clocks, 6 container yard, 7 switchboard). Seed key 06ce52f9. Raises: from depot blind, state changes step rather than glide (exit IP digits re-type in one step); from teletext, strict tabular cell alignment for every address; from Kraftwerk (competitive), a re-patched cord lights from dim to full like current reaching a lamp; from Bollywood poster, size is billing: one headline at decisive scale; from pickling calendar, every cord carries a banded label of its metadata.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
