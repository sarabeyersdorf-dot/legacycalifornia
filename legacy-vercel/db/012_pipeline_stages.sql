-- 012_pipeline_stages.sql
-- Side-aware pipeline: richer stages that read correctly for buy-side,
-- sell-side, and dual (both) clients, plus a deal_side tag on every lead.
--
-- New stage set (keys → what they mean per side):
--   new            · just came in
--   nurture        · early relationship / staying in touch
--   consult        · consult booked or met (buyer consult / listing appt)
--   signed         · representation signed (buyer-rep agreement / listing agreement)
--   active         · buyer actively touring / seller on-market
--   under_contract · in escrow (offer accepted, either side)
--   closed         · funded & recorded
--   sphere         · past client / long-term (kept out of the active board)
--
-- Old → new remap: touring→active, offer→under_contract, close→closed.
-- The CHECK keeps the old keys valid too, so nothing can be rejected during
-- the transition; the UPDATEs move existing rows into the new keys.

-- 1. Widen the CHECK to allow the new keys (and keep the old ones for safety).
alter table public.leads drop constraint if exists leads_pipeline_stage_check;
alter table public.leads add  constraint leads_pipeline_stage_check
  check (pipeline_stage in (
    'new','nurture','consult','signed','active','under_contract','closed','sphere',
    'touring','offer','close'   -- legacy keys, remapped just below
  ));

-- 2. Remap existing leads onto the new stage keys.
update public.leads set pipeline_stage = 'active'          where pipeline_stage = 'touring';
update public.leads set pipeline_stage = 'under_contract'  where pipeline_stage = 'offer';
update public.leads set pipeline_stage = 'closed'          where pipeline_stage = 'close';

-- 3. Add the side tag (buyer / seller / both) and backfill from lead_type.
alter table public.leads add column if not exists deal_side text
  check (deal_side in ('buyer','seller','both'));

update public.leads set deal_side = 'seller'
  where deal_side is null and lead_type = 'seller';
update public.leads set deal_side = 'buyer'
  where deal_side is null and lead_type in ('buyer','investor','land');
-- everything else stays null (unknown) until an agent tags it.
