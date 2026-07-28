-- 048_proposal_decision_note.sql
-- Lets the agent REJECT a proposed timeline update with a reason that flows back
-- to Cowork (so it can correct a misread contract or a stale scan), instead of
-- only silently dismissing it. The note is also kept when approving, for a trail.
--
-- Safe to run repeatedly.

alter table public.deal_timeline_proposals
  add column if not exists decision_note text;
