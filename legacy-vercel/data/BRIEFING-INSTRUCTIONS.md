# Updating `deals.json` — instructions for Sara's daily briefing Claude

You maintain **one file: `legacy-vercel/data/deals.json`**. It feeds the Legacy
CRM — deals, listings, seller portals, the Today board, and the Tasks /
compliance tab. Sara talks to you in plain language; you translate it into this
file. Never show her code unless she asks.

**After ANY change:** bump `"version"` (e.g. 1.13 → 1.14), set `"lastUpdated"`
to today's date, and keep the JSON valid.

---

## 0. Start of run — read what James & Sara sent back

Before you rebuild the agenda, **fetch the CRM feedback** so you can carry
their notes forward:

```
GET https://legacycalifornia.vercel.app/api/crm/briefing-feedback?key=<SYNC_SECRET>
```

(Use Sara's real site domain + the `SYNC_SECRET`.) The response tells you, per
task: `done`, `needs_attention`, and the free-text `agent_note` James or Sara
typed on the Tasks board — plus a `needs_review` list of just the flagged /
annotated ones.

Also pull the **week ahead** so the agenda reflects what's actually scheduled:

```
GET https://legacycalifornia.vercel.app/api/crm/briefing-calendar?key=<SYNC_SECRET>&days=7
```

Read-only, same key. `days` defaults to 7 (max 30). Returns `events[]` from today
through today+days — showings/tours, listing appointments, inspections, and
escrow deadlines / close-of-escrow — each with `start`, `end`, `all_day`,
`agent`, `client`, `deal` (matching a deals.json id when it's escrow-related),
`type`, `location`, and `notes`, sorted earliest-first.

Use it to tune the day:
- A task marked **done** → don't repeat it; if it closes a loop, note the
  outcome and drop it.
- A task flagged **needs_attention** or carrying an **agent_note** → act on
  what they said (reword it, add the follow-up they asked for, re-assign, or
  escalate). Reflect their note in the deal/task you write back.
- If a note answers a question you'd have asked, use the answer directly.

You don't edit their notes — you *respond* to them by updating `deals.json`.
Their checkmarks and notes survive the sync automatically, so you never wipe
them.

---

## 1. Deals — the `"deals"` array (one object per transaction)

Find the deal by `"address"` (or `"id"`) and update:

| Field | Meaning |
|---|---|
| `"agent"` | **`"sara"` or `"james"`** — whose deal it is. **Always set this.** Routes the deal to the right desk / seller portal. |
| `"side"` | `"listing"`/`"seller"` = sell-side · `"buyer"` = buy-side · `"both"` = dual agency |
| `"stage"` | `"listing"` = on market · `"pending"` = in escrow · `"closed"` = funded |
| `"listPrice"` / `"salePrice"` | numbers only — no `$`, no commas |
| `"openEscrowDate"` / `"closingDate"` | `"YYYY-MM-DD"` |
| `"notes"` | free-text context about the deal (shows on the deal / seller portal) |
| `"alerts"` | array of short strings — time-sensitive deal alerts |

## 1b. Deal timeline — RPA deadlines (`"timeline"`)

For an **in-escrow** deal, add a `"timeline"` object so the briefing calendar
(`/api/crm/briefing-calendar`) computes contingency + close-of-escrow deadlines
the **CA RPA** way: **acceptance is Day 0** (final signature on the last
counter), NOT escrow open. All keys optional; keep it as accurate as you can:

```json
"timeline": {
  "acceptance": "2026-06-19",      // Day 0 — REQUIRED for real deadlines
  "coe": "2026-08-10",             // contract COE (auto-rolls off weekends/holidays)
  "overrides": { "loan": 25 },     // per-contingency day overrides (default is 17)
  "remaining": ["appraisal","loan"],   // after a partial CR — only these still run
  "removed":   ["inspection","insurance","title"],  // OR list what was removed
  "clockStart": null               // present & null = clocks PAUSED (see below)
}
```

- Standard contingencies (all **17 days** from acceptance unless overridden):
  `inspection`, `appraisal`, `loan`, `insurance`, `title`.
- **Contingency removal (CR):** when a CR is executed, set `"remaining"` to just
  the contingencies still active (e.g. 7230 Latigo CR1 → `["appraisal","loan"]`),
  or `"removed"` to the ones taken out. Removed ones stop generating deadlines.
- **Overrides / COE:** e.g. 433 E Hwy 4 has a 25-day loan (`"overrides":{"loan":25}`)
  and COE 8/10. COE never lands on a weekend/holiday — the calendar rolls it to
  the next business day automatically (so an 8/1 Saturday COE shows 8/3).
- **Paused clock (court/approval sales):** if periods only start on a written
  notice (e.g. 9985 Wendell, a bankruptcy sale per ADM1), set
  `"clockStart": null`. While null, NO deadlines are emitted — only an
  "Awaiting court-approval notice — all clocks paused" marker. When the notice
  arrives, set `"clockStart"` to that date (it becomes Day 0), or move the date
  into `"acceptance"` and drop `clockStart`.
- If you only know escrow-open (no acceptance), the calendar still estimates
  deadlines but flags them `(basis: escrow open — verify)` — add `"acceptance"`
  as soon as you have it to make them authoritative.

## 2. Listing media (so photos / videos load in the CRM)

Add to the **deal** object:

- `"mls"` — the MLS number (MetroList ListingId, e.g. `"226071603"`).
  **ALWAYS set this on a sell-side listing.** The CRM pulls the listing's photo
  straight from MetroList by this number — without it, no photo shows.
- `"photo"` — a direct image URL (overrides IDX).
- `"video"` — the YouTube tour link (the portal auto-counts views).
- `"matterport"` — the 3D-tour link.

## 2b. Listing roster metadata (the CRM "Listings" view)

For sell-side listings, add a `"listing"` object with whatever's on the listing
sheet. It shows on the **Listings** roster (filterable by agent, with a
Preparing-to-list tab). Everything is optional; include what you have:

```json
"listing": {
  "client": "Laura Redding",
  "apn": "226-071-603",
  "beds": 3, "baths": 2, "sqft": 1200, "lotAcres": 5.11, "yearBuilt": 1979,
  "dateListed": "2026-06-04", "expiration": "2027-01-31",
  "commission": "3%", "preEscrow": "P-706807",
  "disclosurePackage": "https://app.disclosures.io/link/..."
}
```

Future listings you're tracking before they hit the market: set the deal
`"stage": "preparing"` — they appear under the roster's **Preparing** tab.

## 3. Documents in the client portal

### The simple way — just drop the files in (use this for most transactions)

When Sara says *"put [deal]'s documents in the client portal"*, follow these
steps **in order** — do NOT write anything to `deals.json` until she confirms:

1. **List the folder.** Open that deal's **Dropbox folder** and list every
   file you find. Show Sara a numbered list with (a) the real Dropbox filename
   and (b) the clean, client-facing name you propose (tidy it up: drop file
   extensions, dates, and version tags; use Title Case — e.g. `RPA_signed_v2.pdf`
   → **"Purchase Agreement"**).

2. **Offer to rename + drop.** Tell her: *"Here are the N files I'll add. Tell
   me any to rename, and any to leave out."* Wait for her reply. Let her rename
   any file or exclude internal ones (commission, broker memos, etc.).

3. **Only after she confirms:** make a Dropbox **share link** for each kept
   file and write the flat `"clientDocuments"` array on the deal — the final
   (possibly renamed) name + the link per file:

```json
"clientDocuments": [
  { "name": "Purchase Agreement",  "url": "https://www.dropbox.com/…/rpa.pdf" },
  { "name": "Seller Disclosures",  "url": "https://www.dropbox.com/…/tds.pdf" },
  { "name": "Preliminary Title Report", "url": "https://www.dropbox.com/…/prelim.pdf" }
]
```

4. Bump `"version"` + `"lastUpdated"`, keep the JSON valid, and tell her it's
   in — the portal updates on the next sync.

Notes:
- Everything in `clientDocuments` shows in the portal with **View** and
  **Download** links. The portal handles the Dropbox `dl=0`/`dl=1`
  preview-vs-download automatically.
- Only include files the **client should see**; internal files stay out.
- `"status"` and `"sub"` are optional; skip them unless she asks.
- Prefer Dropbox links set to **expire** for anything sensitive.
- If she just says *"add the executed purchase agreement for [deal]: [link]"*,
  skip the folder listing and append that one entry.

### The detailed way — the compliance checklist (`"docs"`)

The `"docs"` object is the compliance checklist (status per named document).
A value can also carry a link: `{ "status": "signed", "url": "…" }`. Use this
only when Sara is tracking document *status*; for "just show the client the
files," use `clientDocuments` above.

## 4. Tasks / compliance — the top-level `"tasks"` array

Sara's daily task & compliance checklist. Shows on the CRM **Tasks** tab and at
the top of each person's **Today**. When she says *"add a task for James…"* or
gives you compliance flags, write them here:

```json
"tasks": [
  { "agent": "james", "client": "Wendell",
    "title": "no BRBC in the EX folder (James owes); file a copy if signed",
    "note": "James will provide and update his Ex file", "done": true },
  { "agent": "james", "client": "Baldwin",
    "title": "no fire-hardening disclosure (FHDS/WFA) on file; chase from listing side (Allyson)",
    "note": "flag for james" },
  { "agent": "sara", "title": "Send Patricia the CMA", "note": "due tonight" }
]
```

- `"agent"` — **required**: `"james"`, `"sara"`, or `"both"`. How it reaches the
  right person. If Sara doesn't say whose, ask or default to `"sara"`.
- `"client"` — the badge (a last name); optional but nice.
- `"title"` — the task / flag text.
- `"note"` — the "+ note" line; optional.
- `"done"` — `true`/`false`; defaults to false. If James checks something off in
  the CRM it stays checked — don't flip it back to false unless Sara says it's
  re-opened.

**Note vs task:** a deal `"notes"` = context on that transaction. A `"tasks"`
entry = a to-do on someone's Today / Tasks screen. For "James needs to do X,"
use a **task**.

---

## Rules of thumb

- Every deal gets an `"agent"`; every task gets an `"agent"`.
- Numbers are bare (no `$`, no commas). Dates are `"YYYY-MM-DD"`.
- Change only what Sara mentioned; leave everything else intact.
- Always bump `"version"` + `"lastUpdated"`, and keep valid JSON.
