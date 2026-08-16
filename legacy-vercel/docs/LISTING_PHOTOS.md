# How listing photos actually work (curated collections & CRM)

Durable facts about where listing photos come from in this product, written down
so we stop re-deriving them. Current as of 2026-08-16.

## The one-line truth

**There is no MetroList RESO API available to Legacy.** Sara does not have (and
is not offered) a MetroList RESO Web API account — no token URL, client ID, or
client secret. So any server-side "fetch the photo by MLS number" path is a dead
end. Photos come from the **browser**, scraped from the iHomefinder (Kestrel)
IDX widget, or not at all.

## Where photos come from, by surface

- **Curated-collection captures** (`properties.photos`): scraped **client-side**
  by `public/curate-capture.js` from the iHomefinder widget when the agent clicks
  "＋ Add to collection". The real image is hosted at `mediarem.metrolist.net`
  (MetroList's media CDN) and, unlike the RESO photo hosts, it loads directly in
  an `<img>`/background with no proxy needed. This scrape is the **only** source
  of a curated home's photo.
- **CRM deal cards / public site**: the code (`api/_metrolist.js`,
  `api/listing.js`, `api/_lib/handlers/crm-listings.js`) is written to pull photos
  from a MetroList **RESO** feed by MLS `ListingId`. That feed is **not
  configured** (the `METROLIST_*` env vars are absent in Vercel), so
  `isConfigured()` is `false` and every one of those paths **fails soft to no
  photo**. This is scaffolding for a feed we don't have; leave it dormant, don't
  build new features on top of it expecting it to fire.
- **iHomefinder IDX sync** (`api/_lib/handlers/idx-sync.js`, cron `/api/idx/sync`):
  populates `public.properties` from the iHomefinder **Client API**, but it is
  **agent/office-scoped** — it only returns *Sara's own* listings. It cannot
  fetch an arbitrary home another brokerage listed (e.g. the homes Sara curates
  for a buyer), so it is not a photo source for curated collections either.

## Why a capture sometimes lands with no photo

The IDX grid cards paint the hero photo as a **CSS `background-image` on a
`<div>`**, not as an `<img>`. The original `pickPhoto()` only read `<img>` tags,
so a photo that was **plainly visible on screen** still scraped as empty (the
"all the photos were showing when I clicked add" case). Fixed 2026-08-16:
`pickPhoto()` now also reads computed `background-image` on the card and its
descendants, and `<picture><source>` srcset — first real (non-placeholder) URL
wins.

Secondary cause (already handled): the grid **lazy-loads** images, so a card
scrolled far below the fold may genuinely have only the placeholder logo in the
DOM. `isPlaceholderPhoto()` drops the IDX logo / "no photo" mark
(`idx-logos.idxhome.com/…`, `logo`, `placeholder`, `coming-soon`, `spacer`,
`1x1`) but must **never** match on the word `metrolist` — real photos live at
`mediarem.metrolist.net` and contain that word.

## The placeholder-drop / non-clobber rules (server)

In `curate-collections.js` `op:capture-listing`:
- A scraped photo is stored only if it is **not** a placeholder
  (`isPlaceholderPhoto` is the shared regex, exported from `curate-search.js`).
- On upsert-by-MLS, `photos` is written **only when we have a real one**, so a
  later empty capture can never blank out a photo an earlier capture stored.

## What we tried that does NOT work (don't repeat)

- **Server-side "backfill photos by MLS" via MetroList RESO** — built and merged
  (#115), then removed the same day once confirmed there is no MetroList RESO API.
  `photosByMls()`, the `/api/cron/photo-backfill` endpoint, and its cron were all
  reverted. If a real photo feed is ever acquired, that is the pattern to
  resurrect — but only after the credentials exist.

## If a home still shows no photo

The reliable manual path: open that listing's **Details page** in the widget and
click "＋ Add this listing" — the detail hero is an eager-loaded `<img>`, so the
scrape gets it. Re-capturing the home from its detail page will fill the photo.
