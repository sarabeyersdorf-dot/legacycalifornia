# Compliance Intake — the `attributes` block on each deal

**For:** Cowork (the process that maintains `data/deals.json`)
**Why:** the agent workflow checklist (in the CRM Tasks tab) fires the
*conditional* disclosure tasks — Lead-Based Paint, HOA docs, solar, tenant
estoppel, Mello-Roos — only when it knows the property's facts. Those facts
live in an `attributes` object you add to each deal, exactly the way you
already add `timeline`, `contacts`, and `milestones`.

Until a deal has this block, the CRM shows a **"⚠ Confirm compliance facts"**
reminder for it (and its deal card shows an **Intake ⚠** chip). The moment the
block lands, the reminder clears itself, the chip flips to **Intake ✓**, and the
relevant disclosure tasks appear on their real due dates.

## Where it goes

One `attributes` object per deal in `deals.json`, alongside the existing keys:

```json
{
  "id": "8235-baldwin",
  "address": "8235 Baldwin St",
  "stage": "pending",
  "side": "buyer",
  "timeline": { "acceptance": "2026-06-17", "coe": "2026-08-01" },
  "attributes": {
    "year_built": 1965,
    "hoa": true,
    "solar": true,
    "solar_leased": false,
    "tenant_occupied": false,
    "mello_roos": false,
    "seller_type": "standard",
    "financing": "conventional",
    "appraisal_waived": false,
    "loan_waived": false,
    "inspection_waived": false
  }
}
```

## Fields (all optional — fill what the contract + disclosure package establish)

| Field | Type | Fill from | Drives |
|---|---|---|---|
| `year_built` | integer | MLS / listing / appraisal | `< 1978` → **Lead-Based Paint disclosure** tasks |
| `hoa` | boolean | TDS/SPQ, HOA name in file | **HOA document** request + delivery + buyer review |
| `solar` | boolean | disclosures, utility bills | **Solar system disclosure** |
| `solar_leased` | boolean | solar agreement (owned vs leased/PPA) | with `solar` → **Solar lease/PPA assumption** review |
| `tenant_occupied` | boolean | listing / SPQ / lease in file | **Tenant estoppel certificate** review |
| `mello_roos` | boolean | tax bill / NHD report | **Mello-Roos / special-tax disclosure** |
| `seller_type` | string | who the seller is | exemptions — see below |
| `financing` | string | RPA financing terms | `"cash"` → drops appraisal/loan tasks |
| `appraisal_waived` | boolean | RPA / counter | drops appraisal-contingency tasks |
| `loan_waived` | boolean | RPA / counter | drops loan-contingency tasks |
| `inspection_waived` | boolean | RPA / counter | drops inspection-contingency tasks |

### `seller_type` values

- `"standard"` — normal individual seller (default; no exemptions).
- `"reo"` — bank-owned. Exempts TDS/SPQ delivery.
- `"foreclosure"` — exempts TDS/SPQ.
- `"probate"` (or `"probate_court"`) — court/estate sale. Exempts TDS.

## Rules the CRM applies

- **A conditional task fires only when its fact is present AND true.** If
  `attributes` is missing, no conditional tasks fire for that deal — the CRM
  never *guesses* a legal disclosure trigger from prose. That's why the block
  matters: an unstated HOA means the HOA tasks silently won't appear.
- **Exemptions only drop a task when you've stated the fact** (`seller_type`,
  `financing`, `*_waived`). An unverifiable exemption never removes a required
  disclosure — the safe default is to keep it.
- **Only the fields you provide are used.** A partial block is fine; add facts
  as the documents confirm them. Any non-empty `attributes` object clears the
  intake reminder, so prefer to add the block once you know the core facts
  (year built, HOA, tenant, seller type) rather than leaving it empty.

## How you'll know it landed

After the next deal-sync: the deal's **Intake ⚠** chip becomes **Intake ✓**, its
"Confirm compliance facts" task disappears from the Tasks tab, and its triggered
disclosure tasks appear with due dates computed from `timeline.acceptance`.
