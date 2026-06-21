-- =============================================================================
-- Phase 1J — Consent flags + sphere pipeline stage + do_not_contact status
-- =============================================================================
-- Adds the four per-channel opt-out booleans on leads, expands the
-- pipeline_stage and status CHECK constraints, and adds the fub_id index
-- the legacy import + ongoing CSV import use for dedupe.
--
-- Sara runs this ONCE in the Supabase SQL editor. Every other piece of the
-- consent rollout (CSV import, consent-flag application, test-row deletion,
-- sequences-cron gating, lead-detail badges) is automated downstream.
-- =============================================================================

-- 1. Per-channel opt-outs ---------------------------------------------------
alter table public.leads
  add column if not exists call_opt_out   boolean not null default false,
  add column if not exists sms_opt_out    boolean not null default false,
  add column if not exists email_opt_out  boolean not null default false,
  add column if not exists not_interested boolean not null default false;

-- 2. Expand pipeline_stage CHECK to include 'sphere' -----------------------
alter table public.leads drop constraint if exists leads_pipeline_stage_check;
alter table public.leads add  constraint leads_pipeline_stage_check
  check (pipeline_stage in ('new','nurture','touring','offer','close','sphere'));

-- 3. Expand status CHECK to include 'do_not_contact' -----------------------
alter table public.leads drop constraint if exists leads_status_check;
alter table public.leads add  constraint leads_status_check
  check (status in ('active','archived','lost','do_not_contact'));

-- 4. Fast dedupe on fub_id during imports ----------------------------------
create index if not exists leads_fub_id_idx on public.leads (fub_id);

-- 5. Convenience: a partial index that lets the sequences cron skip
--    leads that should never be contacted with two cheap predicate checks.
create index if not exists leads_contactable_idx
  on public.leads (sequence_next_due_at)
  where sequence_id is not null
    and sequence_paused = false
    and status not in ('do_not_contact','archived','lost')
    and not_interested = false
    and pipeline_stage <> 'sphere';
