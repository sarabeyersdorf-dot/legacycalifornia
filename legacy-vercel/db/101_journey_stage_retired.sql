-- 101_journey_stage_retired.sql
-- STEP 2 of collapsing the contact model (Sara chose "A then B", 2026-09-04).
-- db/100 made deal_side and roles derived. This retires `journey_stage`.
--
-- WHY
-- journey_stage was a second ladder for a question buyer_stage already answers:
-- discovering / narrowing / touring / ready_to_offer. On the live book it is set
-- on 2 contacts out of 2,281 — because only the website forms ever wrote it,
-- while the CRM, the kanban, the pipeline and the deal reconciler all read and
-- write buyer_stage.
--
-- Two ladders for one fact is what produced every drift bug this week, and this
-- one was quietly costing money: ai-score-lead added +30 for 'ready_to_offer'
-- and +20 for 'touring' off journey_stage, so a buyer the CRM had genuinely
-- moved to writing_offers scored no higher than a cold import.
--
-- WHAT CHANGED IN CODE (this migration only documents it)
--   • The forms still POST journey_stage — their JavaScript is cached in
--     visitors' browsers and must keep working. api/leads/intake.js translates
--     it to buyer_stage + contact_type on the way in (_lib/lead-stage.js) and
--     stores nothing in this column.
--   • Every reader now uses buyer_stage / seller_stage: the scorer, the AI
--     prompts, the FUB tags, the morning brief, the pipeline and roster SELECTs.
--
-- The column is left in place rather than dropped: it still holds the 2 values,
-- dropping it is irreversible, and nothing reads it any more so it costs
-- nothing to keep until the next clean-up. Safe to run more than once.

COMMENT ON COLUMN public.leads.journey_stage IS
  'RETIRED 2026-09-04 (db/101). Nothing reads or writes this. Buyer progress lives in buyer_stage; intake translates the forms'' journey_stage into it. Safe to drop once no report references it.';
