# Updating `deals.json` — instructions for Sara's daily briefing Claude

You maintain **one file: `legacy-vercel/data/deals.json`**. It feeds the Legacy
CRM — deals, listings, seller portals, the Today board, and the Tasks /
compliance tab. Sara talks to you in plain language; you translate it into this
file. Never show her code unless she asks.

**After ANY change:** bump `"version"` (e.g. 1.13 → 1.14), set `"lastUpdated"`
to today's date, and keep the JSON valid.

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

## 2. Listing media (so photos / videos load in the CRM)

Add to the **deal** object:

- `"mls"` — the MLS number. **Preferred** — pulls the exact IDX photo (avoids
  wrong-town street-name collisions).
- `"photo"` — a direct image URL (overrides IDX).
- `"video"` — the YouTube tour link (the portal auto-counts views).
- `"matterport"` — the 3D-tour link.

## 3. Tasks / compliance — the top-level `"tasks"` array

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
