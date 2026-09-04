-- 100_contact_side_derived.sql
-- STEP 1 of collapsing the contact model (Sara chose "A then B", 2026-09-04).
--
-- THE PROBLEM
-- Four fields on `leads` all answer "which side is this person on":
--   contact_type, lead_type, deal_side, roles[]
-- and three answer "where are they up to": pipeline_stage, buyer_stage,
-- seller_stage. Nothing defined how they relate, so they drifted. On the live
-- book 1,028 of 2,281 active contacts had contact_type and lead_type saying
-- different things.
--
-- crm-actions.js had already noticed and worked around it in a comment:
-- "Effective roles are computed from deal_side + stage at query time so the menu
-- ... stored roles[] column can go stale."
--
-- WHAT THIS DOES
-- Makes `deal_side` and `roles` PURE DERIVED STORAGE. A trigger recomputes both
-- from the fields that actually carry the truth, on every insert and update, so
-- they cannot disagree with anything ever again. Two of the four side fields
-- stop being independent inputs.
--
-- Done as a trigger rather than by editing the dozen application write paths
-- because it covers every writer including ones nobody has found — the hourly
-- Cowork sync, the IDX webhook, the importer, a hand-run SQL fix — instead of
-- covering the ones we happened to grep for today.
--
-- THE RULE
--   holds buyer  = buyer_stage is not null  OR contact_type in ('buyer','both')
--   holds seller = seller_stage is not null OR contact_type in ('seller','both')
--   deal_side    = both | buyer | seller | null
--   roles        = the same, as an array
--
-- A vendor, a counterparty, a do-not-contact or a plain sphere contact holds no
-- side unless a deal actually gave them a stage — so Denis Listengourt, the buyer
-- on OUR Augusta listing, stops carrying deal_side='buyer' and roles={buyer},
-- which read as though he were our buyer.
--
-- NOT touched here: contact_type and lead_type. Those are step 2.
-- Safe to run more than once.

CREATE OR REPLACE FUNCTION public.leads_derive_side() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  holds_buyer  boolean;
  holds_seller boolean;
BEGIN
  holds_buyer  := NEW.buyer_stage  IS NOT NULL OR NEW.contact_type IN ('buyer','both');
  holds_seller := NEW.seller_stage IS NOT NULL OR NEW.contact_type IN ('seller','both');

  NEW.deal_side := CASE
    WHEN holds_buyer AND holds_seller THEN 'both'
    WHEN holds_buyer  THEN 'buyer'
    WHEN holds_seller THEN 'seller'
    ELSE NULL
  END;

  NEW.roles := CASE
    WHEN holds_buyer AND holds_seller THEN ARRAY['buyer','seller']
    WHEN holds_buyer  THEN ARRAY['buyer']
    WHEN holds_seller THEN ARRAY['seller']
    ELSE ARRAY[]::text[]
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_leads_derive_side ON public.leads;
CREATE TRIGGER trg_leads_derive_side
  BEFORE INSERT OR UPDATE OF contact_type, buyer_stage, seller_stage, deal_side, roles
  ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.leads_derive_side();

-- Backfill: a no-op UPDATE fires the trigger and settles every existing row.
UPDATE public.leads SET contact_type = contact_type;

COMMENT ON COLUMN public.leads.deal_side IS
  'DERIVED — do not set by hand. Recomputed by trg_leads_derive_side from contact_type + buyer_stage/seller_stage.';
COMMENT ON COLUMN public.leads.roles IS
  'DERIVED — do not set by hand. Recomputed by trg_leads_derive_side. crm-actions computes effective roles at query time; this column exists for legacy readers.';
