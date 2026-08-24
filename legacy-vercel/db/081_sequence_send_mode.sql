-- 081_sequence_send_mode.sql
-- Approve-first-then-auto-send for cold sequences, absolute pacing, and a link
-- from a sent message back to its sequence (so the cold CAN-SPAM footer is
-- attached only to sequence/cold mail, not to 1:1 replies).
--
-- send_mode on a sequence:
--   'draft'            → every step drafts to pending_approval (existing default;
--                        the agent approves each). Unchanged behavior.
--   'auto_after_first' → step 1 drafts to pending_approval and HOLDS; when the
--                        agent approves it, auto-send is armed and steps 2..n
--                        send automatically on schedule, still halting on reply.
--
-- Pacing is absolute from sequence_started_at (step.delay_hours = hours from
-- enrollment), so the Expired sequence lands on Day 0 / 3.5 / 7 / 13 exactly
-- rather than compounding step-to-step. Safe to change: no leads are mid-sequence.
--
-- Idempotent.

alter table public.sequences add column if not exists send_mode text not null default 'draft';
alter table public.leads     add column if not exists sequence_started_at timestamptz;
alter table public.leads     add column if not exists sequence_autosend   boolean not null default false;
alter table public.messages  add column if not exists sequence_id uuid references public.sequences(id) on delete set null;

update public.sequences set send_mode = 'auto_after_first' where name = 'expired_listing';
