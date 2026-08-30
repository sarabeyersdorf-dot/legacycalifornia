-- 095_sync_runs.sql
-- Ensure the generic job-run log exists, and document that sync-deals writes to it.
--
-- NOTE (2026-08-30): a `sync_runs` table ALREADY existed in the live DB with a
-- generic shape — {id uuid, created_at, job text, status text, detail jsonb} —
-- used by saved_search_match. So rather than a bespoke columns-per-metric table,
-- sync-deals writes ONE row per run into this generic log:
--   job='sync-deals', status='ok'|'error', detail=<full run summary jsonb>.
-- /api/crm/reconcile surfaces the newest job='sync-deals' row at sync.last_run,
-- so it rides the briefing-bundle's db_truth (readable via ?sections=db_truth).
--
-- Why: sync-deals sends its JSON summary only at the very end, so a heavy run
-- finishes after the caller's fetch times out and the manual ?key= body is lost
-- (0 bytes, no headers — the transport is unobservable from Cowork). The row here
-- makes "did it run and what did it do" a single SELECT, independent of the body.

create table if not exists public.sync_runs (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  job        text not null,
  status     text not null default 'ok',
  detail     jsonb
);

create index if not exists sync_runs_job_created_idx on public.sync_runs (job, created_at desc);
