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
  `legacy-vercel/db/*.sql`.
