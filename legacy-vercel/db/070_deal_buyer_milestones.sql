-- db/070_deal_buyer_milestones.sql
-- Buyer-perspective road milestones.
--
-- deals.milestones is authored from the SELLER's seat ("Listed at…", "Offer
-- received", "Your home went on the market"). On a buyer-side (or both-sided)
-- deal, the buyer's portal should read from the buyer's seat instead. Cowork now
-- authors a parallel buyer_milestones array (same shape as milestones) and the
-- seller portal, for a buyer viewer, prefers it; when it's absent the portal
-- falls back to a heuristic re-frame of the seller milestones (buyerizeRoad).
--
-- Same jsonb shape as milestones: [{ date, label, desc, badge, status, col }, …]

alter table public.deals add column if not exists buyer_milestones jsonb;
