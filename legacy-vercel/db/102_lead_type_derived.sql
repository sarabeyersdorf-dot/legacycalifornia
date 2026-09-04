-- 102_lead_type_derived.sql
-- STEP 3 — the last of the four side fields (Sara chose "A then B", 2026-09-04).
--   db/100  deal_side + roles  -> derived
--   db/101  journey_stage      -> retired
--   db/102  lead_type          -> derived  (this file)
-- What is left is what Sara asked for: contact_type says WHO they are to us,
-- buyer_stage/seller_stage say WHERE they are. Everything else follows.
--
-- THE PROBLEM WITH lead_type
-- It answered the same question as contact_type and disagreed with it on 1,028
-- of 2,281 contacts. The disagreement is almost entirely one shape:
--
--   contact_type   lead_type   rows   where from
--   sphere         buyer        909   the 2026-06-24 import
--   sphere         seller       109   the 2026-06-24 import
--
-- Neither field was wrong. The import carried a real fact — these people came
-- over as buyer and seller leads — and wrote it to lead_type, while
-- contact_type took its default of 'sphere' for everyone. So the CRM has 900
-- buyers filed as "someone we know", which is why filtering Contacts by buyer
-- returns 17 people out of a book of 2,281.
--
-- WHAT THIS DOES
--   1. Keeps a full snapshot first, so this is reversible.
--   2. Moves the fact into contact_type wherever contact_type says nothing
--      specific ('sphere' or empty). A curated type — past_client, client,
--      vendor, counterparty, do_not_contact — is NEVER overwritten.
--   3. Makes lead_type derived, like deal_side and roles: the trigger from
--      db/100 now fills it too, so the two can never disagree again.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
-- Nobody's STAGE changes. buyer_stage stays null for all of them, so nothing
-- moves into an active pipeline, the kanban is untouched, and no sequence
-- starts. These contacts stay exactly as cold as they were — they are just
-- findable now.
--
-- 'land' and 'relocation' were legal lead_type values and are not legal
-- contact_type values. There are zero rows carrying either, so nothing is lost;
-- the mapping below folds them to 'buyer' should any appear.
-- ('investor' was an option in the CRM's New Lead form and was never a legal
-- lead_type at all — picking it failed the check constraint. Fixed in the form.)
--
-- Safe to run more than once.

-- 1. Reversal snapshot. Taken once; a re-run must not overwrite it with the
--    post-change state.
CREATE TABLE IF NOT EXISTS public.leads_type_backup_20260904 AS
  SELECT id, contact_type, lead_type, deal_side, roles, now() AS snapshot_at
  FROM public.leads;

-- 2. Move the stated side into contact_type where contact_type says nothing.
UPDATE public.leads
SET contact_type = CASE lead_type
                     WHEN 'seller' THEN 'seller'
                     WHEN 'both'   THEN 'both'
                     ELSE 'buyer'          -- buyer, land, relocation
                   END
WHERE lead_type IS NOT NULL
  AND (contact_type IS NULL OR contact_type IN ('', 'sphere', 'lead'));

-- 3. lead_type becomes a mirror of the derived side. Same trigger as db/100 —
--    replacing the function is enough, the trigger keeps pointing at it — plus
--    lead_type in the UPDATE OF list so a hand edit of that column is corrected
--    rather than accepted.
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

  -- Same answer, kept in the legacy column so old readers (the FUB sync, the
  -- import report) keep working while they are migrated off it.
  NEW.lead_type := NEW.deal_side;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_leads_derive_side ON public.leads;
CREATE TRIGGER trg_leads_derive_side
  BEFORE INSERT OR UPDATE OF contact_type, buyer_stage, seller_stage, deal_side, roles, lead_type
  ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.leads_derive_side();

-- Backfill: a no-op UPDATE fires the trigger and settles every existing row.
UPDATE public.leads SET contact_type = contact_type;

COMMENT ON COLUMN public.leads.lead_type IS
  'DERIVED — do not set by hand. Mirrors deal_side, recomputed by trg_leads_derive_side (db/102). contact_type is the field to set.';
