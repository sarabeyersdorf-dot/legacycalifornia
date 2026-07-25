-- 043_deal_attributes.sql
-- Compliance intake facts per deal, written by Cowork from the contract +
-- disclosure package (see data/ATTRIBUTES-INTAKE.md). Powers the agent
-- workflow checklist's conditional (trigger) tasks and the deal-card
-- "Intake ✓ / ⚠ needed" chip.
--
-- Shape (all keys optional; Cowork fills what the documents establish):
--   {
--     "year_built": 1962,          -- < 1978 → Lead-Based Paint disclosure
--     "hoa": true,                 -- → HOA document tasks
--     "solar": true,               -- → solar disclosure
--     "solar_leased": false,       -- with solar → lease/PPA assumption task
--     "tenant_occupied": false,    -- → tenant estoppel certificate
--     "mello_roos": false,         -- → Mello-Roos / special-tax disclosure
--     "seller_type": "standard",   -- "reo"|"foreclosure"|"probate" → exemptions
--     "financing": "conventional", -- "cash" → appraisal/loan exemptions
--     "appraisal_waived": false,
--     "loan_waived": false,
--     "inspection_waived": false
--   }
--
-- Safe to run more than once.

ALTER TABLE deals ADD COLUMN IF NOT EXISTS attributes jsonb;

COMMENT ON COLUMN deals.attributes IS
  'Compliance intake facts (year_built, hoa, solar, tenant_occupied, mello_roos, seller_type, financing, *_waived) written by Cowork from the contract + disclosures. Drives the workflow checklist conditional tasks. See data/ATTRIBUTES-INTAKE.md.';
