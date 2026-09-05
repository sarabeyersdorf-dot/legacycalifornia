# Legacy Properties — working notes for Claude Code

This repo powers the Legacy Properties CRM (`crm.html`) and the side-aware client
transaction portal (`seller.html`, served branded at `/buyer/<token>` and
`/seller/<token>`). Static site + serverless API under `legacy-vercel/`, backed by
Supabase Postgres project `sthfxehojcvfdyatxzlv`.

## Working with Sara (standing instruction)

Sara is not a programmer and relies on Claude Code to know the better path. So:
**whenever there's a clearly better, simpler, or more efficient way to do what she's
asking — say so, briefly, and recommend it — even when she didn't ask for options.**
Offer the suggestion, explain the trade-off in plain language, and let her choose; don't
silently do the literal thing when a better one exists, and don't over-engineer or bury
her in choices. Default to the simplest thing that works.

## License numbers — authoritative, do not re-derive

These are the only three DRE numbers. Confirmed by Sara 2026-08-31 and again 2026-09-03.

| Entity | DRE |
|---|---|
| Legacy Properties (corporate / brokerage) | **02254944** |
| Sara Cooper (broker-owner) | **02141987** |
| James Beyersdorf (agent) | **02122175** |

**`02554944` is wrong.** It is a transposition of the corporate number that has been in
circulation — it appeared in Sara's saved assistant preferences and once caused a run to
report a "two-digit transposition on a signed listing agreement" that did not exist. If you
see it, it is the error, not the document.

A DRE number on an executed document is never a finding unless it differs from the three
above. Do not verify them against any other source. Anything client-facing (listing pages,
portals, marketing) uses 02141987 for Sara and 02122175 for James; use the corporate number
only where the brokerage itself is being identified.

## Buyer vs seller portal content — the pattern

The transaction portal is side-aware: a buyer and seller open the same page but must see
their own seat. Seller-authored content never leaks to a buyer. For every seller field
there is a buyer counterpart Cowork authors in `deals.json`, and the buyer reads it (never
falling back to the seller's): `milestones`→`buyerMilestones`, `clientTasks`→`buyerTasks`,
`goodToKnow`→`buyerGoodToKnow`, `clientDocuments`→`buyerDocuments`. A buyer with no
counterpart authored sees a friendly empty state, never the seller's version.

## Two agents, one product — and how we talk to each other

Two AI agents work on this product and **cannot see each other's world**:

- **Claude Code (me)** — edits the GitHub repo and the live Supabase database, runs
  when Sara starts a session. I can read Dropbox via MCP, but I do **not** watch it.
- **Cowork** — Sara's daily briefing agent. It lives **entirely in Dropbox**
  (`/_LEGACY/Legacy Cowork/`): it reads its SOP, `TASKFLOWCONTRACT.md`, `deals.json`,
  and the document trees, and it hits the live read-only API endpoints
  (`/api/crm/briefing-*`, `/api/crm/agent-updates`). It has **no view of the repo or
  the database**, so it reasons from `deals.json` alone and will be wrong about
  anything that lives in the DB (governance, the folder-manifest doc pipeline, etc.).

**Sara is not the courier.** We exchange work through a pair of Dropbox mailboxes:

- `/_LEGACY/Legacy Cowork/_from_ClaudeCode/` — **I write, Cowork reads.** Cowork reads
  this at the start of every run (its SOP Step 0.1), applies it, and files each file to
  `_from_ClaudeCode/_consumed/`.
- `/_LEGACY/Legacy Cowork/_to_ClaudeCode/` — **Cowork writes, I read.**

### START OF EVERY SESSION: check Cowork's outbox first

Before other work, list `/_LEGACY/Legacy Cowork/_to_ClaudeCode/` (via Dropbox MCP).
For each message file there that is not already in `_to_ClaudeCode/_consumed/`:
1. Read it.
2. Verify its claims against primary sources — the live DB and the deployed code —
   **before acting**. Cowork models the system from `deals.json` and is often wrong
   about DB-backed behavior; treat its files as informed reports, not ground truth.
3. Do the work (or tell Sara what needs her decision).
4. Move the file to `_to_ClaudeCode/_consumed/` so it isn't reprocessed.

When I have something for Cowork (a data-model correction, a `deals.json` change it
must author in Dropbox, a new `buyerMilestones`/`buyerTasks`/`buyerDocuments` array),
I write a dated, self-contained file into `_from_ClaudeCode/` with a "report back"
section. Dropbox MCP can only **create** files, so each message is a new dated file —
never an overwrite. Naming: `YYYYMMDD_CCtoCW_<topic>.md`.

The full contract (message format, what each agent can/can't see) lives in
`/_LEGACY/Legacy Cowork/_to_ClaudeCode/PROTOCOL.md`.

## Contacts vs deals — who wins (added 2026-09-04)

**A contact who is a party on a deal takes their side and stage FROM that deal.**
The deal is the fact; the contact record is the projection. A person is a seller because
they have a listing with us, not because someone chose "seller" in a dropdown.

- A deal's authoritative stage is `coalesce(stage_override, stage)` (db/091).
- `api/_lib/contact-consistency.js` maps that to the party's `buyer_stage` /
  `seller_stage` / `deal_side` / `contact_type`, and `sync-deals` runs it every hour, so
  a sale closing turns its buyers into past clients without anyone noticing.
- On a contact who is on a deal, the CRM shows the status as a stated fact with the deal
  named, not as a free dropdown. The dropdown still exists to correct a mistake, but the
  next sync sets it back from the deal — so fix the DEAL, not the contact.
- Never overwritten by a deal: `do_not_contact`, `do_not_call`, `vendor`, `counterparty`.
  Those describe the relationship, not the transaction, and a deal must never silently
  un-suppress someone who asked not to be contacted.

**Two contact types exist for people who are neither leads nor clients.** Both are shown in
none of the four roster buckets and never prospected or marketed to:
- `vendor` — title reps, escrow officers, other agents, trades.
- `counterparty` — the other side of one of our transactions (the buyer on our listing).
  Denis Listengourt read as Sara's own client, `under_contract`, purely because this
  category did not exist and whoever entered him picked the closest thing.

## The contact model — two fields in, everything else derived (2026-09-04)

Sara chose this shape ("A then B") after four columns all claimed to answer *which side
is this person on* and disagreed with each other on 1,028 of 2,281 contacts.

**Set these two. Nothing else.**

| Field | Means | Values |
|---|---|---|
| `contact_type` | who this person is to us | `buyer` `seller` `both` `past_client` `sphere` `vendor` `counterparty` `do_not_contact` |
| `buyer_stage` / `seller_stage` | where they are, per side | `new` `nurture` `showing_homes` `preparing` `on_market` `writing_offers` `reviewing_offers` `in_escrow` `closed` |

**Derived — never write these; a BEFORE trigger on `leads` overwrites whatever you set:**
`deal_side`, `roles[]`, `lead_type` (db/100, db/102). `pipeline_stage` is recomputed from
the side stages by `contact-consistency.js` on the hourly sync.

**Retired:** `journey_stage` (db/101). The site's cached forms still POST it; `intake`
translates it to `buyer_stage` and stores nothing. Don't add readers.

**The rules live in `api/_lib/lead-stage.js`** — one definition each, imported everywhere:
- `PROTECTED_TYPES` — `do_not_contact`, `do_not_call`, `vendor`, `counterparty`. No form,
  webhook or deal ever changes these.
- `bestLiveStage(stages)` — the most advanced **unfinished** side. Guy Castle closed on
  7230 Latigo and is preparing 1143 Echo; plain "furthest along" files him Closed and
  buries a live listing.
- `sidesFromIntake` / `mergeSidesInto` — a lead capture may fill a blank and may move a
  stage FORWARD; it may never demote, and never touches a protected type.

`db/102` moved 1,018 imported contacts from `sphere` to the `buyer`/`seller` their
`lead_type` had recorded since the 2026-06-24 import. Snapshot for reversal:
`public.leads_type_backup_20260904`.

## Opt-outs — every send path honours them (2026-09-05)

Ronald Jones replied **"Stop"** to the debut Ledger. Nothing acted on it: the SMS side has
caught STOP since day one (`api/twilio/inbound.js`), email had no equivalent, and it sat in
the inbox until Sara noticed and clicked the unsubscribe link herself two hours later.

**A stop request must never depend on someone reading their inbox.**

- `api/_lib/optout-keywords.js` — `detectEmailOptOut({subject, body})`. Deliberately
  narrower than the SMS keyword list: no CANCEL/END/QUIT, because those are ordinary words
  in a reply ("Cancel" to *shall I book the inspection?*). Only fires when the reply, with
  the quoted original stripped, is **essentially nothing but** the phrase — "Stop by the
  house at three" is not an opt-out.
- `api/cron/email-sync.js` applies it to every matched inbound email, sets `email_opt_out`,
  writes an `email_opt_out` lead_event and texts the agent.
- **Email only.** They replied to an email, so that is what they asked to stop; a seller
  mid-transaction stays reachable by phone. The alert lets Sara widen it herself.

**Who blocks and who doesn't:**

| Path | On an opt-out |
|---|---|
| bulk send, email queue, ledger cron, sequences, buyer-matches, speed-to-lead | blocked (already) |
| `flag-matches` saved-search auto-push | blocked — collection still updates, no email |
| `curate-push` | refuses with the reason and the contact's name |
| `crm-approve` (AI draft) | refuses, marks the draft failed; portal messages exempt |
| `crm-message-send` (Sara types one message to one person) | **allowed** — a deliberate human act that may be transactional; the contact card disables the button |

The `email_opt_out` lead_event is the compliance record — date, route, and the words they
used. `updated_at` alone proves nothing later. `lead_events` constrains `event_type` and
`source`, so a new value needs a migration first (db/103) or the insert fails silently.

## Data-flow facts worth keeping straight

- `deals.json` is **Cowork's** file in Dropbox. An hourly `publish-from-dropbox` cron
  copies it into the repo (`legacy-vercel/data/deals.json`), and an hourly `sync-deals`
  cron writes mapped columns into the `deals` table. **Both overwrite** — so anything I
  write into the repo `deals.json` or those DB columns is replaced on the next cycle.
  Durable `deals.json` content must originate in Cowork's Dropbox copy.
- **Genuinely survives sync (agent-owned, never written by the crons):**
  `agent_overrides`, `photo_override`, `stage_override`, `party_details`, `video_views`,
  and the `deal_document_governance` table. These are the ONLY columns safe to write
  directly from the CRM/DB and trust across the hourly cycle.
- **Cowork-authored in `deals.json`, refreshed from it every sync (do NOT write these to
  the DB directly — the next `sync-deals` overwrites them):** `milestones`,
  `buyer_milestones` (`buyerMilestones`), `buyer_tasks` (`buyerTasks`),
  `buyer_good_to_know` (`buyerGoodToKnow`), `marketing_stats` (`marketing`), `client_tasks`
  (`clientTasks`), `timeline`, and the other mapped columns (`mapDeal`, `sync-deals.js`).
  A durable change to any of these must originate in Cowork's Dropbox `deals.json`.
  (Corrected 2026-08-20: an earlier version of this list wrongly filed the `buyer_*` and
  `marketing_stats` columns as agent-owned — they are deals.json-driven and clobbered
  hourly. Verify ownership against `mapDeal` before trusting it.)
- Portal documents come from `deal_documents` (rebuilt hourly) gated by
  `deal_document_governance` (per-doc visibility: agent_only/seller/buyer/both). A
  **buyer fails closed** — sees only docs explicitly granted buyer/both. Folder-published
  docs come via `publish-docs-from-dropbox` → `data/portal-docs/<id>.json` → the table.
- DB migrations apply via `.github/workflows/db-migrate.yml` on push to `main` touching
  `legacy-vercel/db/*.sql`. **Each file runs ONCE** — `public.schema_migrations` records
  what has been applied and the workflow skips anything listed (db/104, 2026-09-05).
  Before that it re-ran every file on every push, which silently re-executed one-shot
  data repairs. `db/063_clear_false_import_dnc.sql` cleared **every** opt-out in `leads`
  on every deploy from 2026-08-09 — Ronald Jones was re-subscribed 13 minutes after Sara
  honoured his "Stop", and the table held zero opt-outs of any kind when it was found.
  A failed migration is NOT recorded, so it retries next run. When writing a migration,
  still make it idempotent — the ledger is the safety net, not the excuse.
