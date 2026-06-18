-- =============================================================================
-- Phase 1G — Sequences pacing
-- =============================================================================
-- Adds the per-lead "when is the next sequence step due?" pointer that the
-- hourly cron reads. We do NOT touch leads.last_contact_at because that's
-- driven by approved outbound messages, not by drafts.
--
-- Run after schema.sql, rls_policies.sql, seed_sequences.sql,
-- 002_briefs_table.sql, 003_seller_portal.sql.
-- =============================================================================

alter table public.leads
  add column if not exists sequence_next_due_at timestamptz;

create index if not exists leads_sequence_due_idx
  on public.leads (sequence_next_due_at)
  where sequence_id is not null and sequence_paused = false;
