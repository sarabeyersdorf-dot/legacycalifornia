-- 097_lead_relationships_include_on_comms.sql
-- Per-relationship "include this person on outreach?" flag.
--
-- Why: a spouse or co-buyer is linked to a contact today, but the link is inert —
-- nothing downstream can ask "should Larry be on this email to Bev?". Sara has to
-- remember, per send, who the other half is. That is the single most repeated
-- manual step in working a couple, and it is the one most often forgotten.
--
-- The flag lives on the RELATIONSHIP, not the contact, because the answer is
-- per-pairing: a spouse is nearly always cc'd, an adult child helping a parent
-- downsize usually is not, and the same person can be both to different people.
--
-- Defaults to true because the overwhelmingly common case — spouse / partner /
-- co-buyer — is "yes, include them", and a couple who only ever hears from us
-- through one of them is how a deal loses the other decision-maker.
--
-- Stored symmetrically like the relationship rows themselves: crm-related-contact
-- writes both directions, so "include Larry when I write Bev" and "include Bev
-- when I write Larry" are independently settable.
--
-- Safe to run more than once.

ALTER TABLE public.lead_relationships
  ADD COLUMN IF NOT EXISTS include_on_comms boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.lead_relationships.include_on_comms IS
  'When true, this related contact is offered/auto-added as a recipient on outreach to the primary contact. Per-direction: set independently on each of the two symmetric rows.';
