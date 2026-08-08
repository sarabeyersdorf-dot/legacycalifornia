-- 056_portal_items_escrow_scope.sql
-- Portal document model, Slice 3: escrow-scope the token read path.
--
-- A transaction-scoped document tied to a NON-active escrow is archived with that
-- escrow — it must not appear in the live portal, and a new buyer must never see a
-- prior escrow's RPA/addenda (SPEC test 2). Property docs (escrow_id null) survive
-- every escrow and are unaffected.
--
-- Adds one condition to the document branch of portal_items(): a transaction doc
-- with an escrow_id whose escrow isn't 'active' is excluded. Everything else is
-- unchanged from db/054. Idempotent (create or replace).

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
    select dp.deal_id, dp.role from public.deal_parties dp join c on dp.lead_id = c.id
  )
  select 'task'::text, t.id, coalesce(t.client_label, t.title), t.created_at,
         jsonb_build_object('done', t.done)
    from public.agent_tasks t join c on t.lead_id = c.id
   where t.visibility = 'client'
  union all
  select 'event', e.id, coalesce(e.client_label, initcap(e.tour_type) || ' tour'), e.scheduled_at,
         jsonb_build_object('status', e.status)
    from public.tours e join c on e.lead_id = c.id
   where e.visibility = 'client'
  union all
  select 'event', a.id, coalesce(a.client_label, a.title), a.starts_at,
         jsonb_build_object('location', a.location)
    from public.appointments a join c on a.lead_id = c.id
   where a.visibility = 'client'
  union all
  -- Documents: governed + role-scoped (db/054) AND escrow-scoped (this migration).
  select 'document', doc.id, coalesce(doc.client_label, doc.name), doc.updated_at,
         jsonb_build_object('status', doc.status, 'scope', doc.scope)
    from public.deal_documents doc
    join d on doc.deal_id = d.deal_id
    left join public.deal_document_governance g
      on  g.deal_id = doc.deal_id
      and g.doc_key = doc.doc_key
      and g.doc_fingerprint is not distinct from lower(btrim(doc.name))
    left join public.deal_escrows esc
      on esc.id = doc.escrow_id
   where doc.doc_key is not null
     -- archived with a dead/other escrow → never in the live portal
     and not (doc.scope = 'transaction' and doc.escrow_id is not null
              and coalesce(esc.status, '') <> 'active')
     and case
           when d.role ~ 'buyer' then coalesce(g.visibility, 'agent_only') in ('buyer', 'both')
           else                       coalesce(g.visibility, 'agent_only') in ('seller', 'both')
         end;
$$;

grant execute on function public.portal_items(uuid) to anon, authenticated;
