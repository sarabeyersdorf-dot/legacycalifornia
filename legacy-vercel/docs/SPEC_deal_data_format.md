# Spec — Structured `commission` & `timeline` for deals.json

**Owner:** Cowork (authors deals.json) + CRM sync/readers
**Status:** proposed
**Why:** commission and contingency dates are stored as prose and re-parsed on
every read. Parsing prose is guesswork that fails on the deal worded
differently — e.g. a commission written `"3% — seller pays 1%, buyer pays 2%"`
had its digits concatenated to `312` and rendered as **312% = $530,400** on a
$170K home. Structured fields delete that whole class of bug.

Both readers accept the **old and new shapes at once**, so deals can be migrated
one at a time. Nothing breaks on the day this ships.

---

## 1. `commission`

Lives at a deal's `listing.commission` (or top-level `commission` for buy-side
deals). Today it's a string. Replace it with an object.

### Format
```json
"commission": {
  "pct": 3,
  "usd": null,
  "note": "3% total — seller pays 1%, buyer pays 2% per BRBC ($5,100 on $170,000)"
}
```

### Rules
- Set **exactly one** of `pct` (a number, percent of the price) or `usd` (an
  exact dollar figure). If both are set, `usd` wins. If the fee is unknown, omit
  the block.
- `pct` is applied to `sale_price`, falling back to `list_price`.
- `pct`/`usd` is the commission **the brokerage earns on this deal** (the total
  GCI) — not the split. Who pays which side goes in `note`.
- `note` is free text for humans and is **never parsed**. Put the split,
  who-pays, and clause references here.

### Before → after (real deals)
| Deal | Today (string) | Structured |
|---|---|---|
| 8235 Baldwin | `"3%"` | `{ "pct": 3, "note": "3% buyer-broker per BCO1 (seller pays)" }` |
| 695 Feather | `"3% — seller pays 1%, buyer (Ashley Robinson) pays 2%"` | `{ "pct": 3, "note": "seller 1% + buyer 2% per BRBC; $5,100 on $170,000" }` |
| flat fee | `"$15,375"` | `{ "usd": 15375 }` |

### Reader change — `api/_lib/handlers/crm-morning-brief.js`
Add a structured branch **before** the existing (fixed) string parser:
```js
const commRaw = d.listing_meta && d.listing_meta.commission;
let commPct = null, commUsd = null;
if (commRaw && typeof commRaw === 'object') {
  // Structured (preferred)
  if (Number.isFinite(+commRaw.usd) && +commRaw.usd > 0) commUsd = Math.round(+commRaw.usd);
  else if (Number.isFinite(+commRaw.pct)) { commPct = +commRaw.pct; commUsd = price ? Math.round(price * commPct / 100) : null; }
} else if (commRaw != null && String(commRaw).trim() !== '') {
  // Legacy string — the first-number parser stays as the fallback
  const s = String(commRaw).trim();
  const m = s.match(/\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/);
  const num = m ? parseFloat(m[1].replace(/,/g, '')) : NaN;
  if (Number.isFinite(num)) {
    if (/\$/.test(s) || (!/%/.test(s) && num > 100)) commUsd = Math.round(num);
    else { commPct = num; commUsd = price ? Math.round(price * num / 100) : null; }
  }
}
```

---

## 2. `timeline`

One consistent shape that replaces every current way of expressing a contingency
date: `loanContingency`, `extensions.loan`, `overrides.loan`, `remaining`,
`removed`.

### Format
```json
"timeline": {
  "acceptance": "2026-06-17",
  "escrowOpen": "2026-06-20",
  "coe":        "2026-08-17",
  "contingencies": {
    "inspection": "2026-07-04",
    "appraisal":  "2026-07-04",
    "loan":       "2026-08-12",
    "insurance":  "2026-07-04",
    "title":      "2026-07-04"
  },
  "clockStart": null,
  "note": "Loan extended to 8/12 per ETA No. 3 (executed 7/24)"
}
```

### Rules
- **`acceptance`** (ISO `YYYY-MM-DD`) = Day 0, the anchor for all date math.
  Required for a full timeline. If genuinely unknown, set `escrowOpen` and it's
  used as the basis (flagged "verify"); if only `coe` is known, the close +
  walk-through still render.
- **`coe`** (ISO) = close of escrow. Falls back to the deal's `closingDate` if
  omitted.
- **`escrowOpen`** (ISO) = optional; defaults to acceptance + 3 days.
- **`contingencies`** = the five standard keys — `inspection`, `appraisal`,
  `loan`, `insurance`, `title`. Each value is one of:
  - an **ISO date** — the deadline;
  - **`"waived"`** (or `null`) — removed / not applicable → drops off the
    timeline entirely;
  - **omitted** — defaults to `acceptance + 17 days`.
- **Store the resolved date.** Do the extension / day-count math once when you
  author it (`acceptance + N days` = the date). Do **not** store day-counts or a
  separate `extensions`/`overrides` block — the date is the single source.
- **`clockStart`**: present-and-`null` = the contract clock is paused (e.g. a
  court-approval sale — no deadlines run yet). Omit for normal deals.
- **`note`** = free text (ETA history, context). **Never parsed** for dates.

### Before → after (real deals)
```jsonc
// 8235 Baldwin — was: {"acceptance":"2026-06-17","coe":"2026-08-17","loanContingency":"2026-08-12"}
{ "acceptance": "2026-06-17", "coe": "2026-08-17",
  "contingencies": { "loan": "2026-08-12" } }   // other 4 omitted → default 17d (7/04)

// 433 E Highway 4 — was: {acceptance, overrides:{loan:47,appraisal:27}, coe, extensions:{loan:"2026-08-05",appraisal:"2026-07-17",...}}
{ "acceptance": "2026-06-19", "coe": "2026-08-10",
  "contingencies": { "loan": "2026-08-05", "appraisal": "2026-07-17" },
  "note": "ETA No.3 executed 7/24: loan → 8/5, appraisal → 7/17" }

// 695 Feather — was: (no timeline; synthesized by fallback)
{ "acceptance": "2026-07-15", "coe": "2026-08-14",
  "contingencies": { "appraisal": "waived", "loan": "waived" } }   // cash deal
```

### Reader change — `api/_lib/deal-timeline.js` (`dealTimelineInput`)
Prefer the structured `contingencies` map; keep the legacy shapes as fallback:
```js
let contingencyDates = explicitContingencyDates(tl);           // legacy: extensions/<c>Contingency
let removed = Array.isArray(tl.removed) ? tl.removed : null;   // legacy
if (tl.contingencies && typeof tl.contingencies === 'object') {
  contingencyDates = {}; removed = [];
  for (const c of STANDARD_CONTINGENCIES) {
    const v = tl.contingencies[c];
    if (v === 'waived' || v === null) removed.push(c);
    else if (isDateStr(v)) contingencyDates[c] = String(v).slice(0, 10);
    // omitted → left to computeTimeline's 17-day default
  }
}
// …pass contingencyDates + removed into the returned input as today.
```
`computeTimeline` already applies explicit per-contingency dates and honors
`removed`, so no change is needed there.

---

## 3. Backward compatibility & migration

- **Readers accept both shapes** (object → structured path; string/legacy keys →
  the existing path). Ship the reader changes first; nothing breaks.
- **Migrate deal-by-deal** in deals.json. A converted deal uses the clean path
  immediately; an unconverted one behaves exactly as today.
- **Priority order:** convert active in-escrow deals first (they drive the Today
  banner and client timelines), then listings, then closed deals (cosmetic).
- Once every active deal is converted, the legacy branches can be deleted.

---

## 4. Validation — extend `drift-check`

Flag a deal (don't silently accept it) when:
- `commission` is an object but has neither a numeric `pct` (0 < pct ≤ 100) nor a
  numeric `usd` (> 0); or is a string whose first token isn't a number.
- `timeline.acceptance` / `coe` / `escrowOpen` is present but not `YYYY-MM-DD`.
- a `contingencies` value is anything other than an ISO date, `"waived"`, or
  `null`.
- an unknown key appears under `contingencies` (typo guard).
- a deal in `pending`/`offer` has no resolvable `coe` (already a `data_gaps`
  entry).

A loud "Baldwin's commission won't parse" at ingest beats a silent $536K on the
board.

---

## 5. For Cowork — the rules in one paragraph

> **Commission:** write it as an object — `{ "pct": 3 }` for a percentage or
> `{ "usd": 15375 }` for a flat fee, never a sentence. Put the split, who-pays,
> and clause references in `note`.
>
> **Timeline:** write it as `{ "acceptance": "<ISO>", "coe": "<ISO>",
> "contingencies": { … } }`. A contingency's value is its **deadline date**, or
> `"waived"` if it's been removed, or leave it out for the standard 17-day
> default. Do the extension math yourself and store the **final date** — no
> day-counts, no `extensions`/`overrides` blocks. Put the ETA history in `note`.
