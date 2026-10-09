---
name: Proxy Farm
description: Your own VPN, turned into many local proxy ports with one fixed exit IP each. Site at proxyfarm.lingoreup.com.
colors:
  green: "#00dd8a"
  green-deep: "#007a48"
  green-ink: "#03150e"
  porcelain-ground: "#eef1f7"
  paper: "#ffffff"
  ink: "#0d1424"
  ink-2: "#2f3a52"
  muted: "#545f78"
  rule: "#d3d9e6"
  plate: "#0a0f1b"
  plate-2: "#111a2b"
  plate-rule: "#233049"
  plate-text: "#e9eef9"
  plate-muted: "#9aa6c2"
  amber: "#f6b53d"
  amber-deep: "#8a5a06"
  provider-hma: "#ffcc33"
  provider-zoogvpn: "#5aa8ff"
  provider-surfshark: "#2fd3c6"
  provider-nordvpn: "#8f9bff"
  provider-expressvpn: "#ff6b6b"
  provider-file: "#a6b2cc"
typography:
  display:
    fontFamily: "'Be Vietnam Pro', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "clamp(2.25rem, 4vw, 3.875rem)"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "'Be Vietnam Pro', ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2rem, 4vw, 3rem)"
    fontWeight: 700
    lineHeight: 1.14
    letterSpacing: "-0.025em"
  title:
    fontFamily: "'Be Vietnam Pro', ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.1875rem"
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: "-0.01em"
  lede:
    fontFamily: "'Be Vietnam Pro', ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.0625rem, 1.4vw, 1.1875rem)"
    fontWeight: 400
    lineHeight: 1.65
  body:
    fontFamily: "'Be Vietnam Pro', ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "'Be Vietnam Pro', ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.5
  mono:
    fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
    fontSize: "0.9em"
    fontWeight: 500
    letterSpacing: "0"
    fontFeature: "'tnum'"
rounded:
  tag: "2px"
  sm: "8px"
  control: "10px"
  button: "12px"
  frame: "16px"
  screen: "18px"
  plate: "20px"
  pill: "999px"
spacing:
  gutter: "clamp(1.25rem, 4vw, 2.5rem)"
  section: "clamp(4.5rem, 10vw, 8.5rem)"
  wrap: "1200px"
  row: "64px"
components:
  button-primary:
    backgroundColor: "{colors.green}"
    textColor: "{colors.green-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.button}"
    padding: "0.7rem 1.25rem"
    height: "48px"
  button-primary-hover:
    backgroundColor: "#14e898"
  button-ghost:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.button}"
    padding: "0.7rem 1.25rem"
    height: "48px"
  button-ghost-on-plate:
    backgroundColor: "transparent"
    textColor: "{colors.plate-text}"
    rounded: "{rounded.button}"
  header-chip:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0.4rem 0.8rem"
    height: "40px"
  rotate-control:
    backgroundColor: "{colors.plate-2}"
    textColor: "{colors.plate-text}"
    rounded: "{rounded.control}"
    size: "40px"
  tag-next:
    backgroundColor: "#fff6de"
    textColor: "{colors.amber-deep}"
    rounded: "{rounded.pill}"
    padding: "0.05rem 0.5rem"
  switchboard-plate:
    backgroundColor: "{colors.plate}"
    textColor: "{colors.plate-text}"
    rounded: "{rounded.plate}"
    padding: "clamp(1rem, 2.4vw, 1.75rem)"
  proxy-string:
    backgroundColor: "{colors.plate}"
    textColor: "{colors.green}"
    typography: "{typography.mono}"
    rounded: "{rounded.sm}"
    padding: "0.5rem 0.8rem"
---

# Design System: Proxy Farm

> **Provenance.** Visual direction was DELEGATED to the agent by the user (team-lead message relaying the user, 2026-10-09: "executive-grade (chuẩn CEO), beautiful, professional; visual direction delegated"). The run was unattended: no decision page was shown and no direction was picked by the user. Chosen form: telephone switchboard (position 7 of the ordered form list, seed 06ce52f9), code-led, no image generation; the only rasters are real app screenshots. The palette is inherited from the desktop app's own tokens (app/src/renderer/styles.css: brand green #00dd8a dark / #009a5b light, navy #080b13 / #0f1524, the provider colours) so site and app read as one brand. This file was written after the build, from site/src/styles/global.css, Landing.astro, Switchboard.astro and the rendered pages; where the direction contract and the build disagree, the build is recorded.

## Overview

**Creative North Star: "The Switchboard Operator's Desk"**

Proxy Farm's site is a light, orderly desk with one instrument on it. The desk is cool porcelain paper ruled with hairlines and heavy ink rules, laid out on a strict tabular grid so every address lines up in its column. The instrument is the ink-navy plate: the switchboard in the hero, the demo screen, the download panel and the footer. On the plate, local ports sit on the left as round jacks, VPN servers on the right grouped by city, and coloured cords run between them in each provider's colour. Brand green is the live line: the lamp on an exit IP, the primary action, the focus ring.

The visual direction was delegated to the agent (2026-10-09, "executive-grade (chuẩn CEO), beautiful, professional") and chosen without a decision page. The world was chosen to stay away from the category default of a dark neon network-globe hero, stat counters and icon-card grids. Nothing in the build uses those, and new surfaces should not bring them in. The palette is not new. It is the desktop app's palette carried to page scale, so the site and the app look like one product. One deliberate shift is that the light-ground action green is deepened to `green-deep` so that green text passes contrast on porcelain.

Density is calm and editorial: generous section padding, one headline per section, lists of facts written as definition rows and tables rather than cards. Motion is sparse and functional. One cord re-patches when the board first comes into view and never again. It also re-patches when a visitor presses a port's Change IP control.

**Key Characteristics:**
- Porcelain desk, ink-navy instrument plate; two grounds, never a third.
- Brand green as the single live-line accent; amber only as a "not yet" lamp.
- Provider colours appear only as small square dots and cords, always next to the provider's name in text.
- Be Vietnam Pro for every word; JetBrains Mono only for ports, IPs, step numbers and proxy strings.
- Structure from rules (1px hairlines, 2px ink heads), not from cards and shadows.

## Colors

An app-inherited palette: cool porcelain and navy neutrals, one electric green and a set of provider colours used as wiring.

### Primary
- **Live-Line Green** (`green`): the lamp colour. Primary button fill, exit IPs on the plate, the "free" server label, links and icons inside dark panels, `::selection`, focus ring on the plate. Comes straight from the app's dark-theme `--acc`.
- **Deep Line Green** (`green-deep`): green that has to sit on porcelain as text or as a small mark. The second line of the hero headline, step numbers, spec group titles, fact bullets and the focus ring on light ground. The app's light-theme accent is #009a5b. The site deepened it to this value so text passes AA on `porcelain-ground`.
- **Green Ink** (`green-ink`): text on green fills, and the "soon" pill inside the primary button.

### Secondary
- **Status Amber** (`amber`) / **Amber Deep** (`amber-deep`): the "coming soon" lamp next to download rows and the "next release" tag (amber-deep text on a cream fill, #e7c779 border). Status only, never decoration.

### Tertiary (provider wiring)
- **HMA Yellow**, **ZoogVPN Blue**, **Surfshark Teal**, **NordVPN Indigo**, **ExpressVPN Red**, **Config-File Grey** (`provider-*`): identical to the app's `--pc-*` tokens. They colour switchboard cords, the 0.55rem square dots in the provider table and board legend, and nothing else. Provider identity is text plus dot; logos are never used.

### Neutral
- **Porcelain Ground** (`porcelain-ground`): page background. Same value as the app's light `--bg`.
- **Paper** (`paper`): raised light bands (providers, use cases), ghost buttons, header chips, screenshot frames.
- **Ink** (`ink`): headings, body text, and the 2px rules that head lists, steps and tables.
- **Ink 2** (`ink-2`): ledes, descriptions and definition text.
- **Muted** (`muted`): captions, footnotes, table heads and secondary nav text.
- **Rule** (`rule`): 1px hairlines between rows, borders of light controls. The hover border on light controls is #aab4c8.
- **Plate / Plate 2** (`plate`, `plate-2`): the instrument navy. The board uses a vertical plate-2 to plate gradient, and full-bleed dark sections use flat `plate`. It sits next to the app's #080b13 / #0f1524.
- **Plate Rule** (`plate-rule`): hairlines and control borders on the plate. The hover border on the plate is #3a4867.
- **Plate Text / Plate Muted** (`plate-text`, `plate-muted`): text on the plate. Headings on the plate are pure white.

### Named Rules
**The One Live Line Rule.** Green means "connected / act here". It fills exactly one kind of control (the primary button) and otherwise appears as text, lamps and focus. Never use it as a section background or decorative wash.

**The Wiring Not Paint Rule.** Provider colours are signal wire: dots and cords only, always labelled with the provider's name. They never colour text, buttons, backgrounds or headings.

**The Two Grounds Rule.** A section is porcelain/paper or it is plate. No third ground: no mid-grey bands and no tinted gradient sections.

## Typography

**Display Font:** Be Vietnam Pro (400 / 500 / 700, Latin + Vietnamese subsets; fallback ui-sans-serif, system-ui)
**Body Font:** Be Vietnam Pro
**Label/Mono Font:** JetBrains Mono 500 (fallback ui-monospace, SF Mono, Menlo)

**Character:** One humanist sans covers every word, chosen first because it sets Vietnamese diacritics cleanly at display weight. Mono is reserved for machine-readable text (addresses, ports, step numbers, proxy strings), so it reads as data, not decoration.

### Hierarchy
- **Display** (700, clamp 2.25rem to 3.875rem, line-height 1.1, -0.035em): the hero headline only. Its second clause sits on its own line in `green-deep`.
- **Headline** (700, clamp 2rem to 3rem, 1.14, -0.025em): one per section, balanced wrap. A reduced step (clamp 1.625rem to 2.25rem) is used for the support block under the download panel.
- **Title** (700, 1.1875rem, 1.35, -0.01em): step, use-case and spec-group titles. Spec group titles drop to 0.9375rem in `green-deep` above a 2px ink rule.
- **Lede** (400, clamp 1.0625rem to 1.1875rem, max 62ch): the one paragraph under each headline.
- **Body** (400, 1.0625rem, 1.65): prose. Definition and table text uses 1rem; FAQ answers cap at 66ch.
- **Label** (500, 0.8125rem to 0.875rem, sentence case): table heads, board head, captions, facts, tags. No uppercase tracking anywhere.
- **Mono** (500, 0.9em of context, tabular numerals, no tracking): ports, IPs, latency, step numbers, `code`.

### Named Rules
**The Mono Is Data Rule.** JetBrains Mono appears only where a user could copy the text into a tool: addresses, ports, proxy strings, numbers. Never for headings, labels or flavour.

**The Size Is Billing Rule.** Each page has one display-scale line. Every other heading steps down to Headline or below.

## Layout

A single centred column `wrap` (`min(100% - 2 × gutter, 1200px)`) with fluid gutters and fluid section padding (`spacing.section`). Inside it, layouts are asymmetric two-column grids in twelfths: the hero is roughly 5.4/6.6 copy-to-board, features and FAQ are 4/7 (sticky heading left, ruled list right), and download and support are 5/6. How-it-works is three equal columns. Use cases are two columns. At 1000px every two-column grid collapses to one column and the sticky heading becomes static. At 1100px the header anchor nav hides. At 640px the provider table becomes stacked rows, primary hero CTAs go full width, and spec rows stack.

The switchboard has its own tabular grid: ports, a cord channel (minmax 56px), and servers, in fixed rows (`spacing.row`, 64px; 58px under 560px). Six port rows span eight server rows, so cords always cross at a slant. Under 560px the board drops the `127.0.0.1:` prefix, latency and dots before it lets anything wrap.

Section heads are a small grid (gap 1rem, max 46rem) of headline + lede, followed by 2.5rem to 4rem of space before content.

### Named Rules
**The Tabular Grid Rule.** Every address, port and fact sits in a row of a real grid, table or definition list and is separated by hairlines. Content is not floated into freeform cards.

## Elevation & Depth

Mostly flat, with depth carried by tone (porcelain against plate) and by rules. Shadows exist in only two jobs. They lift the instrument and real screenshots off the desk with long, soft, negative-spread drops. They also give the primary button a small physical press. Shadows are never hard-edged or offset.

### Shadow Vocabulary
- **Plate lift** (`0 0 0 1px rgb(255 255 255 / 0.04) inset, 0 1px 0 rgb(255 255 255 / 0.08) inset, 0 24px 32px -24px rgb(10 15 27 / 0.6), 0 8px 16px -10px rgb(10 15 27 / 0.4)`): the switchboard plate only. The inset top highlight gives a machined edge.
- **Screenshot lift** (`0 28px 32px -28px rgb(13 20 36 / 0.45), 0 10px 20px -14px rgb(13 20 36 / 0.25)`): framed app screenshots. The step thumbnails use a lighter `0 14px 24px -18px rgb(13 20 36 / 0.35)`.
- **Screen drop** (`0 24px 32px -24px rgb(0 0 0 / 0.7)`): the demo video frame on the plate.
- **Button press** (`0 1px 0 rgb(255 255 255 / 0.4) inset, 0 4px 10px -4px rgb(13 20 36 / 0.3)`): the primary button.

### Named Rules
**The Only Instruments Float Rule.** Only the switchboard, the demo screen and real screenshots cast shadows. Text blocks, lists, tables and sections never do.

## Shapes

Rounded rectangles of graduated radius. The radius grows with the size of the object: 2px for provider dots, 8px for code strips, 10px for small controls (header chips, rotate button, "soon" badge), 12px for buttons and thumbnails, 16px for screenshot frames, 18px for the demo screen and 20px for the switchboard plate (16px on small screens). Pills (999px) are only for the in-button "soon" pill and the "next release" tag.

The world's two native silhouettes are the **jack**, a 14px circle drawn as a dark socket inside a steel ring, and the **cord**, a 2.5px round-capped cubic curve with a horizontal entry and exit. Lists are framed by rules, not boxes: 2px ink above a group, 1px `rule` between rows. The "coming soon" badge uses a dashed border because the thing it stands for does not exist yet.

## Components

### Buttons
Confident, compact, physical.
- **Shape:** gently rounded (12px), minimum height 48px, 18px SVG icon at 0.6rem gap.
- **Primary:** Live-Line Green fill, green-ink text at 700, button-press shadow. It may carry a "soon" pill (green-ink at 12% alpha).
- **Hover / Focus:** hover brightens to #14e898 and lifts 1px; all transitions take 160ms on the house ease-out `cubic-bezier(0.16, 1, 0.3, 1)`. Focus is a 2px `green-deep` outline at 3px offset (Live-Line Green on the plate).
- **Ghost:** paper fill with a 1px `rule` border that darkens to #aab4c8 on hover. On the plate it turns transparent with a `plate-rule` border, and on hover the border becomes #3a4867 and the fill becomes `plate-2`.
- **Text link (GitHub):** 500-weight underlined link whose underline sits in `rule` and turns to currentColor on hover, padded to a 48px target.

### Chips / Tags
- **Header chips** (language switch, GitHub): 40px, 10px radius, paper with `rule` border, 0.875rem 500.
- **Next-release tag:** cream fill (#fff6de), #e7c779 border, `amber-deep` text, pill, 0.75rem. It labels features and providers that are not in the current release.
- **Coming-soon badge:** on the plate, dashed #3a4867 border, `plate-muted` text, preceded by a 7px amber lamp.

### Cards / Containers
There are no content cards. The containers are:
- **Screenshot frame:** 16px radius, 1px `rule` border, paper, screenshot lift.
- **Step thumbnail:** 12px, 4:3, a cropped and zoomed detail of a real screenshot.
- **Demo screen:** 16:9, 18px, `plate-2` with a `plate-rule` border. Until the video ships, it shows a 16%-opacity desaturated screenshot under a radial scrim with a green play mark.

### Inputs / Fields
- **Theme segmented switch:** paper tray with 4px inset and 12px radius. Options are radio inputs styled as 40px labels, and the checked option fills with `ink` and white text. Focus follows the label.
- **FAQ disclosure:** native details/summary rows, 700 at 1.0625rem, a 48px minimum row, and a plus icon that rotates 45° over 300ms. The list is headed by a 2px ink rule.

### Navigation
Header: app icon (36px), "Proxy Farm" in 700, and "by LingoReUp" in muted text after a 1px rule. Anchor nav is 0.9375rem `ink-2` and underlines on hover; it is hidden under 1100px. On the right are the language chip and the GitHub chip. Footer: on the plate, brand row, legal links in `plate-text`, notices in `plate-muted` at 0.8125rem.

### Switchboard (signature)
A `figure` on the plate. It is labelled as an illustration and uses only RFC 5737 documentation addresses. Each **port row** has a 40px rotate control (10px radius, `plate-2`, `plate-rule` border; on hover the border and icon turn green and the arrow turns -120°), the mono `127.0.0.1:` prefix in `plate-muted` with the port in white, and below it the exit IP in Live-Line Green with a provider dot and latency in muted text. A jack sits on the row's right edge. **Server rows** have a jack on the left, the mono IP, and the city with a dot on the first row of each city group, which is set off by a stronger rule. A free server shows a green ring on its jack and a green "free" label. **Cords** are SVG curves in the provider colour at 88% opacity.

Re-patch: the cord dims to 35% while it glides to the new server (620ms, quartic ease-out). Meanwhile the exit IP shows `···`, then the new IP appears in one step, turns white, and the cord lights to full opacity at 4px for 1.4s. The new IP is announced through a polite live region. If no free server exists, the control is aria-disabled and shakes once (360ms). Reduced motion skips straight to the final state. One unprompted re-patch plays 1.6s after the board is 60% visible, once per page load.

### Proxy-string strip
A `code` strip on the plate (8px radius) inside the use-case rows, with green mono text and anywhere-wrapping. It is the light page's one place where a raw proxy string is shown.

## Do's and Don'ts

### Do:
- **Do** take colours from the app's own tokens first; new site tokens must sit next to `app/src/renderer/styles.css` so site and app stay one brand.
- **Do** use `green-deep` for any green text or small mark on porcelain or paper; keep Live-Line Green for fills and for text on the plate.
- **Do** put every address, port and proxy string in JetBrains Mono 500 with tabular numerals, aligned in a grid column.
- **Do** head grouped content with a 2px `ink` rule and separate rows with 1px `rule` hairlines.
- **Do** show a provider as its name plus a 0.55rem square dot in its `provider-*` colour.
- **Do** mark unreleased things with the amber next-release tag or the dashed coming-soon badge, never with a disabled-looking primary button.
- **Do** keep the motion vocabulary to the house ease-out (`cubic-bezier(0.16, 1, 0.3, 1)`), 160ms for controls and 300–620ms for disclosures and re-patches, with a reduced-motion path that jumps to the end state.

### Don't:
- **Don't** use a dark neon network-globe hero, stat counters, or grids of icon cards.
- **Don't** use provider logos; provider identity is text plus colour dot.
- **Don't** introduce a third ground colour or tinted gradient sections between porcelain/paper and plate.
- **Don't** use green as a background wash or put green fills on anything other than the primary action.
- **Don't** put shadows on text blocks, lists or tables; only the instrument, the demo screen and real screenshots lift.
- **Don't** use uppercase tracked labels or small caps above headings; a section opens with its headline.
