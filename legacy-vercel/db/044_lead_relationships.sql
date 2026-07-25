-- 044_lead_relationships.sql
-- Relationships between contacts (spouse, partner, co-buyer, parent, …). Each
-- relationship is stored symmetrically (two rows) so it shows on BOTH contacts'
-- cards. Adding a related contact in the CRM creates that person their own
-- contact card and links the two here.
--
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS lead_relationships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id         uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  related_lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  relationship    text,                 -- 'spouse' | 'partner' | 'co-buyer' | 'parent' | 'child' | 'family' | 'other'
  created_at      timestamptz DEFAULT now(),
  UNIQUE (lead_id, related_lead_id)
);

CREATE INDEX IF NOT EXISTS idx_lead_relationships_lead ON lead_relationships(lead_id);
