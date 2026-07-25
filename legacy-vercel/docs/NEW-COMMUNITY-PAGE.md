# Legacy Properties — Building a New Community (Town) Page

**Purpose:** hand this whole file to the design session so it can create new
community/town pages that match the existing site exactly. It covers the design
system, the anatomy of a town page, the shared assets, the image convention, and
every place a new town must be registered.

**Repo:** `legacycalifornia` · site lives in `legacy-vercel/public/`. Every path
below is relative to `public/`. Live site deploys from `main` at
`legacycalifornia.vercel.app`.

---

## 0. How the site is built (read first)

- **Static, hand-authored HTML — no framework, no build step, no CMS.** Each town
  page is a self-contained `town-<slug>.html` file.
- **No per-town data file and no central town registry.** The *only* per-town
  "data object" is one inline `LegacyTownMap.init({...})` call at the bottom of
  each town page (it feeds the interactive map — see §3). Everything else (prose,
  stats, market numbers) is typed directly into that page's HTML.
- Shared styling/behavior comes from a few files every town page links:
  `legacy.css` (design system), `town.css` (all town-page styles),
  `town-map.css` + `town-map.js` (the Leaflet map), `town.js` (season scrubber,
  scrollspy, tabs).
- **Listings** are pulled live from iHomeFinder / Kestrel (MLS IDX). The embed is
  shared boilerplate with one **shared** activation token — not per-town.
- **To add a town = create one HTML file + drop in images + hand-edit 3 index/
  footer locations.** No nav dropdown to touch, no sitemap.

> ⚠️ **Two gotchas up front:**
> 1. The **footer is copy-pasted into every page** (no include). A new town's link
>    must be added to the footer "Communities" column across the site.
> 2. The **IDX listings gallery only renders on the deployed domain**
>    (`legacycalifornia.vercel.app`), not in local preview — that's expected.

---

## 1. Design system (`legacy.css`)

Every page loads `legacy.css` **first**, and marketing pages use
`<body class="paper" …>` (the `paper` class turns on the paper-grain texture via
`body.paper::before`). Fonts load from a Google Fonts `@import` at the top of
`legacy.css` (Fraunces, Inter, Libre Caslon Text, Source Sans 3, Poppins,
Montserrat, JetBrains Mono).

### Tokens — the exact `:root` block

```css
:root {
  /* Surface (warm, light) */
  --parchment:    #F2ECDF;   /* page bg */
  --vellum:       #E8DFCC;   /* secondary surface */
  --shell:        #FAF6EC;   /* cards / panels */
  --linen:        #EFE7D6;   /* alternate stripe */

  /* Ink (warm dark) */
  --ink:          #1B1813;
  --ink-2:        #2E2A22;
  --ink-soft:     #4A4136;
  --ink-mute:     #7A6F60;
  --ink-faint:    #A89C8A;

  /* Accent */
  --brass:        #8C6E3D;   /* primary accent — antique brass */
  --brass-warm:   #A6824A;
  --brass-bright: #C99E5A;
  --moss:         #3A4A38;   /* secondary — sierra moss */
  --oxblood:      #6E2A20;   /* tertiary — almost never */

  /* Hairlines */
  --rule:        rgba(27,24,19,0.10);
  --rule-soft:   rgba(27,24,19,0.06);
  --rule-strong: rgba(27,24,19,0.20);

  /* States */
  --hot: #B85A3E; --warm: #C99E5A; --cold: #7A6F60;
  --positive: #4A6A3D; --negative: #8B3A2A;

  /* Layout */
  --max: 1320px; --gutter: 48px; --radius: 0px;  /* sharp, editorial — no rounded corners */

  /* Type */
  --serif:     'Fraunces', Georgia, serif;
  --sans:      'Inter', system-ui, sans-serif;
  --mono:      'JetBrains Mono', ui-monospace, monospace;
  --serif-doc: 'Libre Caslon Text', Georgia, serif;
  --sans-doc:  'Source Sans 3', system-ui, sans-serif;
}
```

### Reusable primitives (all defined in `legacy.css` — use these, don't reinvent)
- Type: `.eyebrow`, `.h-section`, `.lede`, `.label-cap`, `.hairline-brass`
- Buttons: `.btn` + `.btn-ink` / `.btn-ghost` / `.btn-brass` / `.btn-sm`
- Brand: `.wordmark` (with `.wordmark-word` + `.wordmark-sub`)
- Section backgrounds are set inline with `style="background:var(--parchment)"`,
  `var(--vellum)`, or `var(--ink)` (for dark sections).

**Design character:** editorial "Gold Country survey" feel — sharp corners
(`--radius:0`), antique brass accent, warm parchment/ink palette, Fraunces serif
display + Inter body + JetBrains Mono for labels/eyebrows. Keep it restrained and
print-like.

---

## 2. Anatomy of a town page (sections, in order)

Copy `public/town-murphys.html` as the template (it's the most complete, ~817
lines). Sections top-to-bottom, marked **[per-town]** (edit the content) or
**[shared]** (copy verbatim):

1. **`<head>`** — `<title>` **[per-town]**. Stylesheet order (keep exactly):
   `legacy.css`, `town.css`, `idx-theme.css`, Leaflet CSS (unpkg, keep the
   `integrity`/`crossorigin`), `town-map.css`. Then the Kestrel loader + inline
   `ihfKestrel.config` **[shared — copy verbatim, token below]**.
2. **`<body class="paper" data-screen-label="Town · <Name>">`** — the label is
   **[per-town]**; `class="paper"` is required.
3. **Top nav** `<header class="topnav">` **[shared]** — identical on every page
   (tagline + phone/email; nav links + centered `.wordmark`). Set the
   `Communities` link to `class="active"`. Flat link row — **no dropdown, towns
   are not listed in the nav.**
4. **Breadcrumb** `.town-breadcrumb` **[per-town]** — change the `.cur` name (and
   the decorative `.mono.small` "plate" line if you like).
5. **Hero** `.town-hero[data-season]` **[per-town]** — the seasonal-frame system:
   four `<div class="th-frame th-frame-spring|summer|fall|winter" style="background-image:url('art/towns/…')">`
   + `.th-veil`. `data-season` sets the initial active frame; CSS cross-fades. Then
   `.th-eyebrow` (county/elevation/established), `<h1 class="th-title">` (with an
   `<span class="it">` italic word), `.th-tag` tagline, four `.th-meta-row`
   (`.label-cap` + `.num`), and the **season scrubber** `.th-season` → four
   `.th-sn` buttons each with `data-s="spring|…"` and `data-quote="…"` (HTML
   allowed) feeding `#seasonQuote`.
6. **Jump rail** `<nav class="town-jump" id="jumpRail">` **[per-town]** — anchor
   links to the sections below. `id="jumpRail"` is required (scrollspy). Anchor
   `href`s must match the section `id`s you keep.
7. **Story** `.town-story#story` **[per-town]** — `.story-grid` (`.story-side`
   eyebrow/heading + `.story-body` prose), then a `.fit-strip` with four
   `.fit-card` ("who fits here").
8. **Vitals** `.town-vitals#vitals` **[per-town]** — market data typed into HTML
   (no feed): median-price card with a hand-authored inline `<svg class="vc-spark">`
   sparkline, plus mini cards (days on market, active listings `.bar-fill` width%,
   sale-to-list `.dial` SVG arc, $/sqft, buyer origin, liveability `.dots`). Edit
   numbers, bar widths, and SVG paths.
9. **Main Street map** `.town-mainst#mainst` — structure **[shared, copy verbatim]**
   (filters `.ms-filter[data-cat]`, the `#tmEditor` drag-to-place bar, the
   `#townMapCanvas` map mount, and the `#msTag/#msName/#msDesc/#msList/#msCount`
   detail rail). **Content is data-driven** by the inline `LegacyTownMap.init`
   at the page bottom (§3). Only the `.ms-filter` labels/counts are per-town.
10. **Signature section** `.town-wine#wine` **[per-town — most town-specific]** —
    dark theme (`style="background:var(--ink);color:var(--shell)"`). For Murphys
    it's wineries; for a new town, replace with that town's defining feature
    (lakes, pines, skiing, historic district…). Rename the `id`, eyebrow, and
    cards, and update the matching jump-rail anchor.
11. **Sara's Picks** `.town-picks#picks` **[per-town]** — tabbed
    (`.pick-tab[data-tab]` ↔ `.pick-pane[data-pane]`), rows of recommendations.
12. **Listings** `.section#listings` — headline/CTA **[per-town]**; the embed is
    **[shared, verbatim]**:
    ```html
    <div class="idx-embed idx-feature-gallery">
      <script>
        document.currentScript.replaceWith(ihfKestrel.render({
          component: "gallerySliderWidget"
        }));
      </script>
    </div>
    ```
    Followed by a `.btn.btn-ghost` to `property-search.html`. (Renders only on the
    live domain.)
13. **Letter from Sara** `.town-letter#letter` **[per-town prose]** — layout
    shared; photo is the global `art/sara-headshot.png` (do **not** duplicate per
    town). Contact links: tel, mailto, find-my-match.
14. **Neighboring towns** `.section` with `.nearby-grid` **[per-town]** — one
    `.nearby-card` per *other* town (image via inline `background-image`, distance,
    name, blurb). For a new town, also add a reciprocal `.nearby-card` into the
    other towns' pages if you want it to appear there too (optional but tidy).
15. **CTA** `.cta` **[per-town copy]** — reused component.
16. **Footer** `<footer class="footer">` **[shared, verbatim]** — four columns;
    the **Communities** column lists every town (a registration surface — §5).
17. **Scripts (bottom)** — keep the trio: `town.js`, Leaflet JS (unpkg, keep
    `integrity`/`crossorigin`), `town-map.js`, then the inline
    `LegacyTownMap.init({...})` **[per-town data — §3]**.

**Shared Kestrel token** (identical everywhere — copy verbatim):
`activationToken: "d77ab7ae-7afe-403d-89cf-61bd60bbf806"`, `platform: "custom"`.

---

## 3. Shared assets & the one per-town data object

- **`town.css`** — all town-page styles (`.town-*`, `.th-*`, `.vc-*`, `.fit-*`,
  `.wine-*`, `.pick-*`, `.letter-*`, `.nearby-*`, `.cta`) incl. the seasonal
  cross-fade keyed off `.town-hero[data-season]`. Generic — don't edit.
- **`town-map.css`** — Leaflet skin (map canvas, lettered brass pins, tooltips,
  the drag-to-place editor bar). Generic.
- **`town.js`** — season scrubber, jump-rail scrollspy, Picks tabs. **No per-town
  data.** Generic — don't edit.
- **`town-map.js`** — exposes `window.LegacyTownMap.init(cfg)`; builds the Leaflet
  map on `#townMapCanvas`, draggable category-filtered markers, writes hovered POI
  into the detail rail, and gives Sara a localStorage-persisted "drag pins → Copy
  coordinates" editor. Generic engine; **all map data comes from the `cfg` you
  pass.**

### The per-town map config (the ONLY per-town data object)

At the very bottom of each town page:

```js
LegacyTownMap.init({
  "town": "murphys",                 // unique slug (also the localStorage key)
  "center": [38.1376, -120.4632],    // [lat, lng]
  "zoom": 16,
  "unit": "places",                  // noun shown in the count, e.g. "places"/"spots"
  "catMeta": {                       // one entry per category you use
    "wine": { "label": "Tasting room", "letter": "W", "color": "#8C6E3D" },
    "eat":  { "label": "Restaurant",   "letter": "E", "color": "#5E7886" },
    "stay": { "label": "Stay",         "letter": "S", "color": "#4F6B4A" },
    "shop": { "label": "Shop",         "letter": "P", "color": "#A6824A" },
    "do":   { "label": "To do",        "letter": "D", "color": "#6E5732" }
  },
  "pois": [
    { "name": "Ironstone Vineyards", "cat": "wine",
      "desc": "Estate winery & amphitheater.", "lat": 38.128869, "lng": -120.462341 },
    { "name": "Querencia", "cat": "stay",
      "desc": "Adults-only boutique inn.", "lat": 38.145189, "lng": -120.472644 }
    // …one entry per point of interest…
  ]
  // optional: "fitToPins": true, "fitMaxZoom": 16  → auto-frame all pins
});
```

For a new town change: `town`, `center`, `zoom`, `unit`, the `catMeta` keys you
actually use, and the full `pois[]` (each `{name, cat, desc, lat, lng}`; every
`cat` must match a `catMeta` key **and** a `.ms-filter[data-cat]` button in the
Main Street section). **Easiest workflow:** deploy with a rough `pois` list, then
Sara drags each pin to the right spot on the live map and clicks **"Copy
coordinates"** — paste that regenerated JSON back into this call.

---

## 4. Image convention (`art/towns/`)

- Directory: `public/art/towns/`. Naming: **`<slug>-<descriptor>[-<season>].jpg`**,
  all lowercase, hyphenated. Slug = town name (`sutter-creek`, `murphys`; the
  River & Mountain lifestyle page uses `rm-`).
- **Minimum for a new town: four seasonal hero images** — the
  `-spring` / `-summer` / `-fall` / `-winter` suffix is the only load-bearing part
  of the name (the four `.th-frame-*` divs reference them). If you can't supply all
  four seasons, point multiple `.th-frame-*` divs at the same file.
- **Reuse one image** as the town's card art — it's referenced from `towns.html`
  (`.town-tile{--bg}`), `index.html` (`.comm-card .comm-bg`), and each other
  town's `.nearby-card .nb-img`.
- Existing sets range 3–8 images/town (Murphys has 8: mainst spring/summer,
  vineyard fall, hotel winter, plus historic/garden variants).
- Global shared image (not per-town): `art/sara-headshot.png` (letter section).

---

## 5. Registration — where a new town must be added

Edit **three** locations (plus the footer, which repeats across pages):

**(A) `towns.html` — the Communities hub** (this is what the nav "Communities"
link points to; `communities.html` is a *different* thing — see note below).
- Add a `.town-tile` anchor in `.hub-index` (size class `.tt-feature` / `.tt-half`
  / `.tt-third`):
  ```html
  <a href="town-<slug>.html" class="town-tile tt-third"
     style="--bg: url('art/towns/<slug>-<hero>.jpg');">
    <div class="tt-inner">
      <div><span class="tt-num">VII · <County></span></div>
      <div class="tt-foot">
        <div class="tt-name"><Name></div>
        <div class="tt-meta"><div>Median<strong>$XXXK</strong></div>…</div>
        <div class="tt-arrow"><one-line blurb> →</div>
      </div>
    </div>
  </a>
  ```
- Add a compare-table row in `.hub-compare tbody`:
  ```html
  <tr>
    <td class="town"><a href="town-<slug>.html" style="text-decoration:none;color:inherit;"><Name></a></td>
    <td><County></td><td class="price">$XXX,000</td>
    <td><span class="chg up">+X.X%</span></td><td>XX d</td><td><known for></td>
  </tr>
  ```
- Bump the "Towns covered" count in `.hub-meta-strip` and the hero copy
  ("Six towns…").

**(B) `index.html` — homepage communities grid.** Add a `.comm-card` in the
`#communities` `.comm-grid`:
```html
<a href="town-<slug>.html" class="comm-card">
  <div class="comm-bg" style="background-image:url('art/towns/<slug>-<hero>.jpg');"></div>
  <div class="comm-overlay"></div>
  <div class="comm-stat">Median<strong>$XXXK</strong></div>
  <div class="comm-content">
    <span class="comm-name"><Name></span>
    <span class="comm-meta"><one-line character></span>
  </div>
</a>
```
(The first card uses `comm-card comm-card-large`.)

**(C) Footer "Communities" column — on EVERY page.** The footer is copy-pasted
into each HTML file. Add `<a href="town-<slug>.html"><Name></a>` to the
Communities `<div>` wherever it appears (grep the repo for the Communities footer
block and add the line everywhere so the footer stays consistent).

**Not needed:**
- **`communities.html`** — despite the name, this is a bare full-page IDX property
  search, no town cards. Nothing town-specific to add.
- **Top nav** — flat 5-link row, no per-town entries, no dropdown.
- **Sitemap** — there is no `sitemap.xml`.

> `river-mountain.html` is a "lifestyle category" page (not a `town-*.html`) but
> is listed alongside towns in these indexes — mirror its entries if you add
> similar category pages.

---

## 6. Checklist — "add community X"

1. **Copy** `public/town-murphys.html` → `public/town-x.html`. Per-town edits:
   `<title>`, `data-screen-label`, breadcrumb `.cur`, hero (frame image URLs +
   eyebrow + `<h1>` + tagline + four `.th-meta-row` + four `.th-sn` `data-quote` +
   initial `data-season`), jump-rail anchors, story + `.fit-card`s, all
   `.vitals-card` numbers/SVG paths, `.ms-filter` categories+counts, the signature
   section, `.pick-*` panes, listings headline, letter prose, `.nearby-card`s
   (link the *other* towns), CTA copy, footer Communities column. **Keep verbatim:**
   `<head>` stylesheet order, the `ihfKestrel.config` token, the IDX gallery embed,
   the bottom script trio.
2. **Add images** to `public/art/towns/` — `x-<descriptor>-spring|summer|fall|winter.jpg`
   (≥4 seasonal), matching the hero `url()`s; reuse one as the card image.
3. **Set the map data** — edit the inline `LegacyTownMap.init({...})`: new `town`
   slug, `center`, `zoom`, `unit`, `catMeta`, `pois[]`. (Drag pins live → "Copy
   coordinates" to finalize.)
4. **Register:** `.town-tile` + compare `<tr>` in `towns.html` (bump the town
   count + hero copy); `.comm-card` in `index.html #communities`; `<a>` in the
   footer **Communities** column across pages.
5. **Deploy to `main`** and verify on `legacycalifornia.vercel.app` (the IDX
   gallery only renders there).

---

## 7. Recent site updates (so the design session is current)

Almost all recent work has been in the **agent-facing CRM** (`crm.html`,
`seller.html`, the `/api/*` handlers) — calendar, contacts, deal tooling,
compliance checklist, messaging. Those do **not** affect the public marketing
site or the town-page recipe.

The one **public marketing** change worth knowing:
- **Commute calculator** on `property-search.html` — a "from any town → any town"
  drive-time widget above the IDX search, backed by `/api/commute` (a
  provider-flexible endpoint: built-in Gold-Country matrix → Google → OpenRoute).
  Curated client collections can optionally show a per-listing commute to the
  client's destination. If a new community page wants a commute readout, that
  widget/pattern already exists to reuse.

Nothing else on the public site changed — the design system, town template, and
registration surfaces above are current.
