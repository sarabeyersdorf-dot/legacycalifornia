-- 030_party_reconciled_at.sql
-- Close the Cowork loop for deal party edits.
--
-- Agents edit people/escrow into deals.party_details (db/029) — a sync-safe
-- overlay. Those edits otherwise live in the CRM forever while deals.json (the
-- SSOT Cowork owns) never learns about them, so the two drift. This column
-- tracks when an overlay was last RECONCILED back into deals.json:
--
--   • null (with a non-empty overlay) → edits are PENDING — Cowork hasn't
--     folded them into deals.json yet. The morning brief nudges on these.
--   • a timestamp → the overlay has been reconciled (either the sync detected
--     deals.json now reflects it, or someone marked it done). Drops off the nudge.
--
-- Any new party edit resets this to null (there's fresh work to reconcile).
-- Safe to run repeatedly.

alter table public.deals add column if not exists party_reconciled_at timestamptz;
