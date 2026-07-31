# Taskflow Contract — the Cowork loop

**Audience:** Cowork (the morning-briefing automation), plus anyone touching
`agent_tasks`, `cron/sync-deals.js`, or `crm/tasks`. This is the single source of
truth for how tasks flow between the briefing, `deals.json`, the database, and the
CRM. Read it before changing how tasks are written.

**The loop, in one sentence:** Sara and James see Cowork's tasks in the CRM, tick
and reply to them there, and the next morning's briefing reads all of it back
without losing anything.

---

## The two task pools — know which one you're writing

Every row in `agent_tasks` belongs to exactly one pool, distinguished by `source`
and whether `source_key` is NULL:

| Pool | `source` | `source_key` | Written by | Lifecycle |
|---|---|---|---|---|
| **A · deals.json tasks** | `briefing` | **NULL** | Cowork writes `deals.json` `tasks[]` → `sync-deals` | Wiped + rebuilt **every hour**; check-offs preserved |
| **B · keyed briefing tasks** | `briefing` | `brief:<id>` | Cowork POSTs `crm/tasks` (`bulkSync`) | Insert-only; pruned only on an opt-in snapshot |
| **C · checklist** | `checklist` | rule key | `sync-deals` from `checklist_task_definitions.json` | Reconciled (insert + prune) each sync |
| **D · auto** | `auto` | `auto:*` | `crm/tasks` self-heal | Self-completes when its condition resolves |

You (Cowork) write **Pool A** (via `deals.json`) and **Pool B** (via the
`bulkSync` POST). C and D are managed by the app.

> ⚠️ **`source_key IS NULL` is load-bearing.** It is the ONLY thing that scopes the
> hourly wipe of Pool A (`sync-deals.js:708`). Never put a value in `source_key`
> for a Pool-A task, and never backfill it. Do that and the wipe matches zero
> rows while the rebuild re-inserts — a duplicate set of ~114 tasks **every hour**.

---

## Fix 1 — the `key` field keeps a tick attached to its task

**Problem it solves:** Pool A is wiped and rebuilt hourly. The old code re-attached
each rebuilt task's check-off by matching `agent | client | title`. Task titles
carry live countdowns — *"🔴 Baldwin COE 8/3 — 4 days"*. Tomorrow it reads
*"3 days"*, the signature no longer matches, and the tick, reply, and attention
flag are **silently dropped**. James ticks something; it comes back untouched.

**The contract:** give every recurring task a **stable `key`** in `deals.json`:

```json
{ "agent": "james", "client": "Baldwin", "key": "baldwin-coe-call",
  "title": "🔴 COE 8/3 = 3 days — call Kim for loan/appraisal status",
  "due": "Before COE 8/3" }
```

- Format: `<deal-short>-<action-slug>`, e.g. `baldwin-coe-call`, `433-pest-credit`.
- **No date, no countdown, no run-id in the key.** The **same key every day** for
  the same underlying to-do. The title may change freely; the key must not.
- One key = one real task, forever. When the task is truly done and should stop
  recurring, remove it from `deals.json` `tasks[]` (don't reuse its key for
  something else).

The code stores this in the additive `agent_tasks.brief_key` column and matches on
it first, falling back to the old signature for any task without a key — so
nothing breaks mid-migration.

> **Anti-pattern that caused this:** three different key conventions in four days —
> `brfg-433-pest-work-729`, `brfg-433-pest-credit-730`,
> `briefing-433-pest-neriah-reply-20260731`. All date-suffixed, so dedup never
> matched. Pick one slug per task and keep it.

---

## Fix 2 — keyed briefing tasks (Pool B) now prune on a snapshot

**Problem it solves:** Pool B (`bulkSync`) was insert-only and nothing ever pruned
it, so keyed briefing tasks accumulated forever (16 open, growing ~5/day).

**The contract:** when you POST the keyed set to `crm/tasks`, send `prune: true`
**and make the payload a COMPLETE snapshot of every currently-open keyed briefing
task** — across both agents, in one POST:

```
POST /api/crm/tasks?key=<SYNC_SECRET>
{ "prune": true,
  "tasks": [ { "source_key": "brief:coe-call", "agent": "james", "title": "…", "due_label": "Today" },
             { "source_key": "brief:appraisal", "agent": "sara",  "title": "…", "due_label": "Aug 5" } ] }
```

- `prune: true` means **"this list is the whole truth for open keyed tasks."** Any
  open keyed row you omit is treated as resolved and deleted within the hour.
- It is a **snapshot, not a delta.** Never send a partial list with `prune: true`.
- Only **open** rows are pruned — completed history is never destroyed — and an
  **empty payload never prunes** (guard against a malformed POST wiping the board).
- Omit `prune` entirely and behaviour is exactly as before (insert-only). Safe
  default; opt in when you're sending the full snapshot.

This lives in `bulkSync` (`crm-tasks.js`) — the one place that receives the desired
set — **not** in `sync-deals`, which never sees Pool B and has no way to know
what's desired.

---

## Fix 3 — every task has a due date and exactly one owner

- **`due` on every task** (Pool A) / `due_label` on every task (Pool B). ~70% of
  open briefing tasks currently have none; a task with no due never surfaces at the
  right moment. No exceptions.
- **One owner. Retire `"both"`.** `agent` is `"james"` or `"sara"`, never `"both"`
  (0 of 3 "both" tasks were ever completed). If unclear, default to `"sara"`.
- **Stable keys, no date suffix** (see Fix 1).

Supporting columns (additive, from `db/049_taskflow.sql`): `brief_key`, `deal_id`,
`due_date`. `brief_key` is populated now; `deal_id`/`due_date` are available for a
later step and inert until then.

---

## Guardrails — these break production

1. **Never backfill `source_key` or make it `NOT NULL`.** (Load-bearing; see above.)
2. **Never remove `tasks[]` from `deals.json` in this work.** The wipe at
   `sync-deals.js:708` runs unconditionally; an empty `tasks` deletes every open
   Pool-A task and inserts nothing. Retiring that array is a later step, only after
   task generation moves server-side.
3. **The browser never talks to Supabase.** All task reads/writes go through
   `/api/*`. No `/rest/v1/` or Supabase client anywhere in `public/`.
4. **Both `sync-deals` and `publish-from-dropbox` run hourly (`0 * * * *`).** Any
   task change propagates within the hour — not daily.

---

## What Cowork must do differently, starting now

1. Put a **stable `key`** on every recurring `deals.json` task — `<deal>-<slug>`,
   no date suffix, same key every day.
2. Put a **`due`** on every task; assign **one agent** (`james`/`sara`), never
   `both`.
3. When POSTing keyed tasks to `crm/tasks`, send the **full open snapshot** with
   **`prune: true`**.
4. Keep writing `deals.json` `tasks[]` as today — don't empty it, don't add
   `source_key`/`deal` fields to task objects (they'd break the wipe scoping).

## Verification (run once after `db/049` is applied)

1. Tick a task in the CRM. Change **only its title** in `deals.json`. Run
   `sync-deals`. The tick survives. *(Fix 1)*
2. Remove a keyed task from the `bulkSync` snapshot and POST with `prune: true`.
   That open keyed task is gone within the hour; the others remain. *(Fix 2)*
