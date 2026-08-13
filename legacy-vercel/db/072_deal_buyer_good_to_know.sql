-- db/072_deal_buyer_good_to_know.sql
-- Buyer-perspective "Good to know" context bullets.
--
-- deals.good_to_know is authored from the SELLER's seat ("Sara represents you as
-- the seller", "Sara is lining up a backup escrow contact"). On a buyer-side /
-- both-sided deal, a buyer must never see those bullets verbatim. Cowork now
-- authors a parallel buyer_good_to_know array (same shape) and the seller portal,
-- for a buyer viewer, reads from it; when it's absent the section is simply empty
-- for the buyer (never the seller's bullets).
--
-- Same jsonb shape as good_to_know: [{ title, body }, …]

alter table public.deals add column if not exists buyer_good_to_know jsonb;
