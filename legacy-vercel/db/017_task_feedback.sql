-- 017_task_feedback.sql
-- Two-way task loop: James and Sara annotate briefing tasks in the CRM, and
-- Cowork reads those notes back (via /api/crm/briefing-feedback) to tune the
-- next agenda.
--
--   agent_note     — free-text note the agent writes back to the briefing
--   attention      — flag: this task needs the briefing's attention
--   agent_note_by  — who wrote it ('sara' / 'james')
--   agent_note_at  — when
--
-- These are PRESERVED across the hourly deals.json sync (matched by
-- agent|client|title), exactly like the done-checkmark, so a re-sync never
-- wipes an agent's note.
--
-- Safe to run multiple times.

alter table public.agent_tasks add column if not exists agent_note    text;
alter table public.agent_tasks add column if not exists attention     boolean not null default false;
alter table public.agent_tasks add column if not exists agent_note_by text;
alter table public.agent_tasks add column if not exists agent_note_at timestamptz;
