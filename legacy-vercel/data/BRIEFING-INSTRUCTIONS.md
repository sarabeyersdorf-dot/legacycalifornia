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

Finally, pull the **updates log** — the free-text notes Sara & James file from
the CRM and from the seller portal (texts they got, verbal updates, "I already
sent the FHDS", "mark this task done"). **You must read this every run** — it is
where their live corrections come from:

```
GET https://legacycalifornia.vercel.app/api/crm/agent-updates?op=feed&key=<SYNC_SECRET>
```

Same key. Returns only entries you haven't read yet, and **reading it marks them
read** (so each note reaches you exactly once — no repeats). Each entry has
`agent`, `deal` (a deals.json id when tagged), `content`, and `created_at`. Act
on every one, then reflect it in `deals.json`:
- A **`Seller-portal note — <address>: …`** entry → fold that fact into the deal
  (update `notes`, `agentNote`, a milestone `desc`, or `goodToKnow` as fits) so
  the portal shows it going forward.
- A **`Seller portal … I marked "<task>" complete — please drop it …`** entry →
  **remove that task from that deal's `clientTasks[]`** (it's done). This is how
  a ticked-off task actually disappears — until you remove it from `clientTasks`,
  it stays on the list.
- Any other update → treat like an agent_note: act on it and adjust the day.

Because the feed marks these read as you pull them, they won't show up again —
so the agent's note/tick "stays current" instead of repeating day after day.

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

> **One-time backfill — do this on your next run:** go through **every** deal in
> the array and make sure each one has a top-level `"client"` field with the
> client's full name(s), pulled from that deal's executed documents. Most deals
> are missing it today. This is what lets the CRM auto-attach each contact to
> their deal, so an agent never has to link them by hand. Match the CRM contact's
> spelling exactly (full first + last name). After this, keep setting `"client"`
> on every new deal as it comes in.

Find the deal by `"address"` (or `"id"`) and update:

| Field | Meaning |
|---|---|
| `"agent"` | **`"sara"` or `"james"`** — whose deal it is. **Always set this.** Routes the deal to the right desk / seller portal. |
| `"client"` | **REQUIRED on every deal — the client's full name(s).** On a BUYER-side deal, the buyer(s); on a listing, the seller(s); on a dual deal, the primary client. **Pull this from the executed documents** (the RPA / purchase agreement names the parties). Use each person's **full legal name** exactly as it appears in the CRM contact (first + last), so the CRM can auto-match it — e.g. `"client": "Shomari Turner"`; two people as `"client": "Roger & Kristin Quillen"`. This is what auto-links the contact to their deal: once the name matches a CRM contact, that contact's card shows the deal (and the deal shows the client). A deal with no `client` can't auto-link — the agent has to wire it by hand. Shows on the Deals/Listings roster and the briefing calendar. |
| `"side"` | `"listing"`/`"seller"` = sell-side · `"buyer"` = buy-side · `"both"` = dual agency |
| `"stage"` | `"offer"` = we have an offer out/in on it, not yet accepted · `"listing"` = on market · `"pending"` = in escrow · `"closed"` = funded · `"preparing"` = future listing |
| `"stage": "offer"` | **Use for any property we have an offer on that isn't accepted yet** — an offer we WROTE for a buyer client (set `"side": "buyer"`), or an offer RECEIVED on one of our listings (`"side": "listing"`). These show under the **Offers** tab of the Deals and Offers view. When the offer is accepted, either set `"stage": "pending"` here, or Sara flips it with the card's "Mark accepted → escrow" toggle (that override self-heals once you move it to `"pending"` in this file). |
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
- **⚠ BACKFILL — do this on your next run:** review every active escrow's
  executed CRs and set `remaining`/`removed` on each. This was under-maintained,
  so the calendar and Deadline Watch have been showing already-removed
  contingencies. Known example: **433 E Hwy 4** — CRB (Buyer Contingency Removal)
  No. 2 removes everything **except the loan**, so set
  `"remaining": ["loan"]` on 433's timeline. Do the same for the others from
  each deal's executed CRs.
  - **Confirm the backfill in that run's briefing.** Add a short
    **"Contingency backfill"** section that lists every active escrow with the
    `remaining` you set and the source (e.g. `433 E Hwy 4 → remaining:["loan"]
    (CRB No. 2, 2026-07-…)`; `7230 Latigo → remaining:["appraisal","loan"] (CR1)`).
    For any deal you could NOT resolve (doc unreadable / unsure), list it under
    **"Needs Sara's eyes"** with why, and file a pending proposal rather than
    guessing. Sara asked to spot-check this, so make it explicit, one line per
    escrow.
- **When you can't read a doc or aren't sure a contingency cleared, do NOT guess.**
  Leave it in `remaining` (so the deadline keeps showing) and file a *pending*
  timeline proposal (`op:'propose'`) describing what you think happened — the
  agent decides. Guessing wrong hides a live deadline; a pending proposal is the
  safe fallback.
- **Read the agent's rejections.** `GET /api/crm/briefing-feedback` now returns a
  `rejected_proposals` array: each is a proposal the agent **rejected**, with your
  original `reason`, the change you `proposed`, and the agent's correction in
  `agent_note` (e.g. "CRB No. 2 removes all but the loan"). Treat each as a
  directive: fix the deal's `timeline` (or docs) to match the note, and don't
  re-file the same proposal. This is the loop that lets the agent reply to your
  scan when you misread a document.
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

## 1c. Deal team contacts (`"contacts"`) — pull from email comms

Add a `"contacts"` object to the **deal** so the client portal's **Your team**
block can show reachable contact info for the escrow officer and co-op agent.
**Harvest these from the deal's email threads** — the escrow officer's signature,
the title company's opening email (which carries the **escrow / file number**),
and the buyer's-agent emails. As soon as you see an email address, phone number,
or escrow number in a deal's correspondence, capture it here. All keys optional:

```json
"contacts": {
  "escrow":       "Jane Ramirez",
  "escrowEmail":  "jramirez@fidelitytitle.com",
  "escrowPhone":  "209-555-0100",
  "escrowNumber": "ESC-2026-0433",
  "title":        "Fidelity National Title",
  "coAgent":      "John Smith",
  "coAgentEmail": "john@remax.com",
  "coAgentPhone": "209-555-0200"
}
```

- The **agent's** own email + phone always show (from the agents table) — no
  exceptions — so you don't need to add Sara/James here.
- `escrowNumber` renders as the escrow member's **File #** in the portal.
- Only what you provide shows a Call / Email link; a member with just a name
  shows name + role. Fill in email/phone the moment a deal's emails reveal them.

## 1d. Compliance intake — the `"attributes"` object (lights up disclosure tasks)

Add an `"attributes"` object to each **deal**, pulled from the contract +
disclosure package. It drives the workflow checklist's *conditional* disclosure
tasks (Lead-Based Paint, HOA, solar, tenant estoppel, Mello-Roos) and the
deal-card **Intake ✓ / ⚠** chip. Until a deal has it, the CRM shows a
**"⚠ Confirm compliance facts"** reminder for that deal; the moment you add the
block, the reminder clears and the right disclosure tasks appear.

```json
"attributes": {
  "year_built": 1965,        // < 1978 → Lead-Based Paint disclosure
  "hoa": true,               // → HOA document tasks
  "solar": true,             // → solar disclosure
  "solar_leased": false,     // with solar → lease/PPA assumption task
  "tenant_occupied": false,  // → tenant estoppel certificate
  "mello_roos": false,       // → Mello-Roos / special-tax disclosure
  "seller_type": "standard", // "reo" | "foreclosure" | "probate" → exemptions
  "financing": "conventional", // "cash" → drops appraisal/loan tasks
  "appraisal_waived": false,
  "loan_waived": false,
  "inspection_waived": false
}
```

All keys optional — fill what the documents establish. A conditional task fires
**only** when its fact is present AND true (the CRM never guesses a legal
disclosure from prose), and an exemption only drops a task when you've stated the
fact. Any non-empty `attributes` object clears the intake reminder, so add it
once you know the core facts (year built, HOA, tenant, seller type).

*(The same guidance, with a fuller field table, also lives in
`legacy-vercel/data/ATTRIBUTES-INTAKE.md` — note the exact upper-case filename.)*

## 2. Listing media (so photos / videos load in the CRM)

Add to the **deal** object:

The CRM card/roster/portal photo comes from the FIRST of these that's present:
**`"photo"` → MetroList (by `"mls"`) → the `"video"` tour's YouTube thumbnail.**
So a deal with a `"video"` always shows an image even if MetroList isn't wired
up. For a deal with none of the three, the card shows a "No photo yet" tile.

- `"photo"` — a direct image URL. **The most reliable option** — always shows,
  no MetroList/env dependency. Use this for any deal that has no video tour
  (e.g. a buyer-side purchase, land, or a listing whose MLS photos aren't
  syncing). Any public image URL works (hosted file, Cloudinary, etc.).
- `"mls"` — the MLS number (MetroList ListingId, e.g. `"226071603"`). Set this
  on a sell-side listing; the CRM pulls the photo from MetroList by this number
  **only if the MetroList API keys are configured on the deployment.**
- `"video"` — the YouTube tour link (auto-counts views AND supplies a thumbnail
  photo fallback).
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

## 2c. Commission — populate it on EVERY active deal (buyer AND seller side)

The Today page's **"Closing soon"** panel and its expected-income totals need a
commission per deal. Put a top-level **`"commission"`** on the deal (works for
buyer-side too — it does NOT have to be inside the `listing` block):

```json
{ "id": "7230-latigo", "side": "buyer", "salePrice": 615000,
  "commission": "2.5%" }        // percent of price → CRM computes the dollars
```

- **Where to read it:** the **accepted offer / RPA** carries the buyer-broker
  compensation (buyer side); the **listing agreement** carries the listing
  commission (seller side). Pull it from those executed docs.
- **Percent or dollars — both work.** `"2.5%"` (a `%` or a bare number ≤ 100) is
  a percent applied to the sale price. `"$15,375"` (a `$` or a number > 100) is a
  flat dollar amount — use this straight off the **commission demand you send to
  escrow** when you want the exact figure rather than a computed estimate.
- A deal with no `commission` shows **"commission n/a"** and is left out of the
  income totals — so fill it in for every active escrow.
- **⚠ Backfill this now** alongside the contingency backfill: set `commission`
  on all five active escrows (e.g. **7230 Latigo → its buyer-broker % from the
  accepted offer**, or the exact dollars from Sara's commission demand).
- **While you're in Latigo:** its close-of-escrow is showing **stale "Delayed"**
  text to the seller. Fix BOTH places (they're independent):
  1. `timeline.coeNote` — still says "COE DELAYED … revised date TBD." Clear or
     rewrite it; Latigo now closes **7/28**.
  2. the **`milestones` entry** `{"label":"Close of Escrow", "badge":"Delayed",
     "col":"closing", "desc":"COE DELAYED beyond 7/24…"}` — change `badge` to a
     current value (e.g. `"Closing today"` / `"On track"`, or `"Done"` once it
     records) and rewrite the `desc`. **This milestone badge is what renders
     "Delayed" on the seller portal's road-to-close**, so the note alone isn't
     enough — the milestone must be updated too.
- **General rule:** milestone `badge`/`desc` and `coeNote` are *authored text* you
  own in deals.json. The site's crons only republish them verbatim — they never
  auto-correct stale wording. Whenever a date slips or un-slips, update the
  milestone and the note in the same pass so the portal never shows a stale state.

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

**Missing documents — set the token to `null`.** The CRM now surfaces file
gaps: any known document token you include with a **null** (or empty) value is
shown as **"Not on file"** in that deal's Command Center Documents panel, and
the deal's ledger row gets a red **"N docs missing"** chip. This is how your
compliance scan (e.g. "433 is missing TDS, SPQ, NHD, AVID, FHDS") becomes
visible and actionable inside the CRM instead of only in the briefing. So when
a required disclosure/document is expected but not yet in the Ex folder, include
its token with `null` rather than omitting it:

```json
"docs": {
  "RPA": "executed",
  "TDS": null,        // expected, not on file → shows as "Not on file"
  "SPQ": null,
  "AVID": "received"
}
```

Only tokens with a human label are shown (RPA, TDS, SPQ, NHD, AVID, FHDS/WFA,
EMD, prelim, contingencyRemoval, etc. — the same vocabulary you already use).
A token you omit entirely is treated as "not tracked," not "missing" — so to
flag a gap, null it explicitly. Once the document lands, change the value to its
status (`"received"`, `"signed"`, …) and the gap clears automatically.

## 3b. Portal visibility — what you own vs. the CRM's live toggles

There are two ways things reach a client's portal, and they don't overlap —
stay in your lane so nothing gets clobbered:

- **You (Cowork) own DOCUMENTS.** `clientDocuments` (§3) and the `docs`
  checklist are yours. Sara asks you to add/rename/remove files; you write them
  to `deals.json`. The CRM does not touch documents.
- **Sara owns per-item visibility, live in the CRM.** Inside a deal's Command
  Center she flips individual **appointments, showings, and tasks** between
  Private and Shared with a toggle (backed by `/api/crm/visibility`, which
  refuses to share anything containing wire/payment language). That's a
  real-time agent action — **not** something you set from `deals.json`.

Two things that follow, so you don't fight the CRM:

- **Don't try to mark briefing items "client-visible" from `deals.json`.** The
  `tasks` you write (§4) are rebuilt from scratch on every sync and land
  **internal by default with no client link** — that's intended. If Sara wants a
  task or appointment shown to a client, she toggles it in the Command Center;
  a value you write here would be wiped on the next sync anyway.
- **Never put wire/payment/banking details in `notes`, `tasks`, or anything
  client-facing.** Wire instructions go by phone through the title company only.

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

- Every deal gets an `"agent"` AND a `"client"` (full name, matching the CRM contact so it auto-links); every task gets an `"agent"`.
- Numbers are bare (no `$`, no commas). Dates are `"YYYY-MM-DD"`.
- Change only what Sara mentioned; leave everything else intact.
- Always bump `"version"` + `"lastUpdated"`, and keep valid JSON.
