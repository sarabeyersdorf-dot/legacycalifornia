-- db/071_deal_buyer_tasks.sql
-- Buyer-perspective "What I need from you" tasks.
--
-- deals.client_tasks is authored from the SELLER's seat ("watch for the buyer's
-- inspection", "review the seller net sheet Sara sent"). On a buyer-side (or
-- both-sided) deal, a buyer must never see the seller's to-do list. Cowork now
-- authors a parallel buyer_tasks array (same shape as client_tasks) and the
-- seller portal, for a buyer viewer, reads from it; when it's absent the buyer
-- simply sees the friendly empty state (never the seller's tasks).
--
-- Same jsonb shape as client_tasks: [{ label, when, status }, …]

alter table public.deals add column if not exists buyer_tasks jsonb;
