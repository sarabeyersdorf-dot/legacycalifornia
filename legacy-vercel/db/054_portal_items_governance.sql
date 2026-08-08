-- 054_portal_items_governance.sql
-- Portal document model, part 3: make the SECURITY DEFINER read path
-- (portal_items) governance-aware and FAIL CLOSED.
--
-- Replaces the document branch of portal_items() (db/015). Before, it gated on
-- deal_documents.client_safe = true — a flag that DEFAULTS TRUE and is rebuilt
-- hourly (fails open). Now it gates on deal_document_governance (db/053):
--
--   * effective visibility = the grant's visibility, or 'agent_only' on any miss
--     (no grant, or a key-reuse fingerprint mismatch) → fail closed.
--   * audience is the viewer's ROLE on the deal (deal_parties.role): a buyer sees
--     'buyer'/'both', a seller sees 'seller'/'both'. A buyer never sees a
--     seller-only document and vice-versa.
--   * a document with no doc_key can't be governed, so it is never shown.
--
-- Tasks/events branches are unchanged. Idempotent (create or replace).

create or replace function public.portal_items(p_token uuid)
returns table (item_type text, item_id uuid, title text, when_at timestamptz, meta jsonb)
language sql
security definer
set search_path = public
as $$
  with c as (
    select id from public.leads where portal_token = p_token
  ),
  d as (
    -- carry the party's role so documents can be audience-scoped
    select dp.deal_id, dp.role from public.deal_parties dp join c on dp.lead_id = c.id
  )
  -- Tasks tied to this client, marked client-visible
  select 'task'::text, t.id, coalesce(t.client_label, t.title), t.created_at,
         jsonb_build_object('done', t.done)
    from public.agent_tasks t join c on t.lead_id = c.id
   where t.visibility = 'client'
  union all
  -- Events: tours
  select 'event', e.id, coalesce(e.client_label, initcap(e.tour_type) || ' tour'), e.scheduled_at,
         jsonb_build_object('status', e.status)
    from public.tours e join c on e.lead_id = c.id
   where e.visibility = 'client'
  union all
  -- Events: appointments
  select 'event', a.id, coalesce(a.client_label, a.title), a.starts_at,
         jsonb_build_object('location', a.location)
    from public.appointments a join c on a.lead_id = c.id
   where a.visibility = 'client'
  union all
  -- Documents on this client's deal(s), gated by the governance table and the
  -- viewer's role. LEFT JOIN + coalesce('agent_only') = fail closed. The
  -- fingerprint match is the key-reuse guard: a grant only applies while the
  -- document's name is unchanged, so a recycled key can't inherit visibility.
  select 'document', doc.id, coalesce(doc.client_label, doc.name), doc.updated_at,
         jsonb_build_object('status', doc.status, 'scope', doc.scope)
    from public.deal_documents doc
    join d on doc.deal_id = d.deal_id
    left join public.deal_document_governance g
      on  g.deal_id = doc.deal_id
      and g.doc_key = doc.doc_key
      and g.doc_fingerprint is not distinct from lower(btrim(doc.name))
   where doc.doc_key is not null
     and case
           when d.role ~ 'buyer' then coalesce(g.visibility, 'agent_only') in ('buyer', 'both')
           else                       coalesce(g.visibility, 'agent_only') in ('seller', 'both')
         end;
$$;

grant execute on function public.portal_items(uuid) to anon, authenticated;
