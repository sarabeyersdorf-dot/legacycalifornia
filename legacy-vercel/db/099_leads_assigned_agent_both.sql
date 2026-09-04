-- 099_leads_assigned_agent_both.sql
-- Let a lead be assigned to BOTH agents.
--
-- Sara, asked how website leads should be split between her and James: "send to
-- both of us always."
--
-- The SMS and email alert already reaches both — alertAgents loops every agent
-- key. What did not was the follow-up list: crm-follow-ups filters a non-broker
-- to `assigned_agent = me`, and nothing in the intake path set the column, so
-- every website lead landed on Sara's default and James's day never showed one.
-- That is the same reason his book stood at 49 contacts against her 2,230.
--
-- 'both' is safe to introduce because every OTHER reader of this column routes
-- with the shape `assigned_agent === 'james' ? 'james' : 'sara'` — the seller
-- portal's reply-to, the browsing alert, note authorship, deal-party linking.
-- A value of 'both' falls through those to Sara, which is the right default for
-- "who signs this", while the follow-up lanes (the only place that FILTERS)
-- learn to treat it as matching either agent.
--
-- The backfill is deliberately narrow: only leads that came from the website
-- form, which are exactly the ones this rule is about. The 2,000-odd hand-added
-- contacts keep their existing assignment — reassigning someone's whole book on
-- the back of a routing question would be well beyond what was asked.
--
-- Safe to run more than once.

ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_assigned_agent_check;

ALTER TABLE public.leads ADD CONSTRAINT leads_assigned_agent_check
  CHECK (assigned_agent = ANY (ARRAY['sara'::text, 'james'::text, 'both'::text]));

UPDATE public.leads
   SET assigned_agent = 'both'
 WHERE source = 'website_form'
   AND assigned_agent IS DISTINCT FROM 'both';

COMMENT ON COLUMN public.leads.assigned_agent IS
  'sara | james | both. "both" puts the lead on the follow-up list of each agent; readers that must pick one person to sign as fall through to sara.';
