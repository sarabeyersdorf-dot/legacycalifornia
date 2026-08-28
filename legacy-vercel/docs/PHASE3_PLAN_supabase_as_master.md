# Phase 3 plan — deals.json → export, Supabase as master

**Author:** Claude Code · 2026-08-28
**Status:** Draft for Sara + Cowork. This is the plan and the open questions — no Phase 3 code is
written yet. Phase 3 changes how Cowork works, so it needs Cowork's sign-off before any cutover.

Companion to Cowork's `SCOPE_supabase_as_master.md` (Phase 3 of that scope). Phases 1–2 are done.

---

## 1 · Where we are now (after Phases 1–2)

- **deals.json (Cowork, in Dropbox) is still the master** for the base deal data. Flow:
  Cowork authors deals.json → `publish-from-dropbox` → repo → `sync-deals` → `deals` table.
- **Agents can now edit, in the CRM, an overlay for every volatile field**, and the overlay WINS over
  deals.json and survives the sync: stage, COE/acceptance (+ expected), the client note, good-to-know,
  the road/milestones, the client to-do list, party details, photos — plus whole deals created in the
  CRM (`created_in_crm`), tasks, and the audit trail.
- So the DB is **already a merged view**: `agent overlay (wins) → deals.json base → derived`. What it
  is NOT yet: **durable and self-sufficient.** If deals.json vanished, `sync-deals` would have nothing
  to import and the base layer would be lost. That is the one thing Phase 3 must fix.

## 2 · The goal (§5.4), restated precisely

> deals.json becomes an **export, not a master** — for the promoted fields.

Concretely, Phase 3 means:
1. The **DB is the durable source of truth**. A deal's data survives with or without deals.json.
2. deals.json in Dropbox is **downgraded** from "the master the DB is rebuilt from" to **"Cowork's
   input feed"** (one contributing layer), and a **DB-generated deals.json export** becomes the real
   backup (so we can restore the DB from itself, not from Cowork's file).
3. Nothing about the client experience changes; the two-masters tension disappears.

## 3 · The core question — how does Cowork contribute once the DB is master?

This is the crux, and it's Cowork's call. Cowork's environment is **GET-only fetch + Supabase MCP with
INSERT allowed but UPDATE blocked** by its permission classifier. So Cowork can add rows but cannot
directly edit an existing deal row. Two models:

**Model A — Cowork proposes, a cron applies.** Cowork writes its findings to an INSERT-only inbox
table (which it CAN do); a cron applies them to the master deal rows, exactly like the existing
`deal_timeline_proposals` flow. Clean, but it's a new authoring model for Cowork to learn.

**Model B — deals.json stays Cowork's input feed (RECOMMENDED).** Cowork keeps authoring deals.json in
Dropbox **exactly as today** — but we stop calling it the master. `sync-deals` still imports it as the
**base layer only**; agent overlays still win over it; and we ADD a DB→deals.json export as the backup.
The "master" is the merged DB. **Cowork's day-to-day does not change at all** — we've only reframed
deals.json from "the thing the DB is rebuilt from" to "the lowest-priority input layer," and made the
DB durable so losing deals.json no longer wipes anything.

**My recommendation: Model B.** It reaches the §5.4 goal with the least disruption to Cowork and the
least risk, because it builds on the merge precedence Phases 1–2 already established. Model A is a
larger rewrite of Cowork's workflow for little additional benefit right now.

## 4 · Phase 3 steps under Model B (each shippable + verifiable on its own)

1. **DB → deals.json export generator** (read-only, non-authoritative). A cron/endpoint that renders
   the merged DB state (base import + agent overlays) into a deals.json-shaped file written to the repo
   and/or Dropbox as `deals.export.json`. Changes nothing; it's a backup. **This is the on-ramp** — it
   lets us prove the DB has full fidelity before any flip. [M]
2. **Fidelity check.** Diff the generated export against Cowork's live deals.json until they match
   field-for-field (modulo agent overlays that intentionally differ). Only when this is clean do we
   trust the DB as the durable master. [S, but iterative]
3. **Make the base import non-destructive / durable.** `sync-deals` already refuses to prune on an
   empty deals.json; extend that so a MISSING or unchanged deals.json never removes or blanks base
   data — the DB retains the last-known base. After this, deals.json can be absent without harm. [M]
4. **Reframe + declare.** Update CLAUDE.md, the SOP, and the ownership declarations: deals.json is
   Cowork's input feed; the DB is master; `deals.export.json` is the backup. No code flip — a
   documentation + mental-model change, plus turning off any remaining "deals.json is authoritative"
   assumptions. [S]
5. **(Optional, later) Self-sufficient deals end-to-end.** Extend CRM editing to the last few base
   fields so a deal can be created and fully maintained in the DB with no deals.json entry at all
   (Phase 2's "Add a deal" already does this for new deals). [M, incremental]

The scary, irreversible part people imagine — "invert the pipeline, stop importing deals.json" — is
**not required** under Model B and I'd advise against it. deals.json keeps flowing in as the base
layer; we just stop depending on it for durability and add the export.

## 5 · Cutover sequence (safe, staged)

Build 1 (export generator) → run it in parallel for a week, diffing against deals.json (step 2) →
ship step 3 (durable base) → then step 4 (declare the reframe). No single step changes the client
experience or removes Cowork's authoring. Every step is reversible until step 4, which is only a
declaration.

## 6 · Open questions — for Cowork and Sara

1. **Model A or B?** (I recommend B — deals.json stays your input feed, unchanged; the DB becomes the
   durable master; we add an export backup.)
2. **Where should the DB→deals.json export live** — committed to the repo (`data/deals.export.json`),
   written to a Dropbox backup folder, or both? (Cowork can read Dropbox; the repo copy is durable and
   diffable.)
3. **Cowork:** are there fields you author that the DB does NOT currently store, so the export would
   lose them on a round-trip? (This is exactly what step 2's fidelity check finds — but if you already
   know of any, name them.)
4. **The folder-doc pipeline + governance** (`deal_documents`, `deal_document_governance`) already live
   in the DB, not deals.json, so they're unaffected — confirm you agree.
5. **Blocked right now:** Phase 3 is DB + pipeline work and both Supabase and Dropbox are disconnected
   as I write this. Nothing below step 1 can be verified until Supabase is back, and this plan can't
   reach Cowork until Dropbox is back.

## 7 · Risks
- A DB→deals.json export that silently drops a field Cowork authors = data loss on a restore. **Step 2
  (fidelity diff) is the guardrail; do not trust the export until it's clean.**
- Declaring the DB the master (step 4) before the durable-base work (step 3) would mean a lost
  deals.json still wipes base data. Order matters: 1 → 2 → 3 → 4.

— Claude Code
