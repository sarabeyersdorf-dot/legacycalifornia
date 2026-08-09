-- 059_timeline_proposal_integrity.sql
-- Structural guards behind the timeline-proposal bug fixes (2026-08-09 report).
--
--   Bug 2 — proposals were auto-approved with decided_at BEFORE created_at (the
--           auto-apply path fabricated an already-decided row). Code now logs to
--           deal_activity instead; this makes decided_at < created_at impossible.
--   Bug 1 — the same rejected change was re-proposed every morning. A partial
--           unique index makes a second PENDING proposal for one (deal_id,
--           item_key) structurally impossible; rejection_count / suppressed_until
--           give the cron a place to record and back off.
--
-- Safe to run more than once. Existing violating rows are healed BEFORE the
-- constraint/index is added, or the DDL would fail.

begin;

-- ── Bug 1 columns ──────────────────────────────────────────────────────────
alter table public.deal_timeline_proposals
  add column if not exists rejection_count integer not null default 0,
  add column if not exists suppressed_until timestamptz;

-- ── Bug 2: heal the 8 rows with decided_at < created_at, then constrain ──────
update public.deal_timeline_proposals
   set decided_at = created_at
 where decided_at is not null
   and decided_at < created_at;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'deal_timeline_proposals_decided_after_created'
  ) then
    alter table public.deal_timeline_proposals
      add constraint deal_timeline_proposals_decided_after_created
      check (decided_at is null or decided_at >= created_at);
  end if;
end$$;

-- ── Bug 1: at most one PENDING proposal per (deal_id, item_key) ──────────────
-- Delete any existing pending duplicates first (keep the newest), so the unique
-- index can be built. Only redundant same-key pending rows are removed; every
-- approved/rejected row (the decision history) is untouched.
delete from public.deal_timeline_proposals p
 using (
   select id,
          row_number() over (partition by deal_id, item_key
                             order by created_at desc, id desc) as rn
   from public.deal_timeline_proposals
   where status = 'pending'
 ) r
 where p.id = r.id and r.rn > 1;

create unique index if not exists deal_timeline_proposals_one_pending
  on public.deal_timeline_proposals (deal_id, item_key)
  where status = 'pending';

commit;
