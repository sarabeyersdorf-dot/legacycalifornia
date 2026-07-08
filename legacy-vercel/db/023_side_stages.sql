-- 023_side_stages.sql
-- Side-aware pipeline status for a contact. A contact can be a buyer, a seller,
-- or BOTH (dual) — a dual client carries a status on each side, so we store
-- them separately. These drive the lead-detail status dropdown(s); the coarse
-- `pipeline_stage` (kanban + header) is derived from them in the API (the
-- more-advanced side wins), so status and pipeline stay one source of truth.
--
-- Buyer stages : new, nurture, showing_homes, writing_offers, in_escrow, closed
-- Seller stages: new, nurture, preparing, on_market, reviewing_offers, in_escrow, closed
--
-- Safe to run repeatedly.

alter table public.leads add column if not exists buyer_stage  text;
alter table public.leads add column if not exists seller_stage text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leads_buyer_stage_check') then
    alter table public.leads add constraint leads_buyer_stage_check
      check (buyer_stage is null or buyer_stage in
        ('new','nurture','showing_homes','writing_offers','in_escrow','closed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'leads_seller_stage_check') then
    alter table public.leads add constraint leads_seller_stage_check
      check (seller_stage is null or seller_stage in
        ('new','nurture','preparing','on_market','reviewing_offers','in_escrow','closed'));
  end if;
end $$;
