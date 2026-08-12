-- db/068_portal_items_deal_scoped_events.sql
-- Deal-scoped calendar sharing.
--
-- Until now a shared appointment reached exactly ONE portal — the lead it was
-- linked to (portal_items joined appointments on a.lead_id = the viewer's lead).
-- So sharing an inspection with both the seller AND the buyer meant creating the
-- event twice, once per party.
--
-- This adds a second path: an appointment shared to the whole DEAL (deal_id set,
-- lead_id NULL, visibility 'client') is returned to EVERY party of that deal.
-- The viewer's deals are already computed in the `d` CTE (deal_parties), so one
-- shared inspection now shows on the seller's and the buyer's portals at once.
-- Lead-linked shares still work exactly as before; the new branch requires
-- lead_id IS NULL so a lead-linked event is never returned twice.
--
-- Everything else is byte-for-byte db/062.

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
  -- Appointments linked to THIS viewer's lead. NEVER fall back to a.title
  -- (buyer names live there); a shared event without a curated client_label
  -- shows a neutral placeholder.
  select 'event', a.id, coalesce(nullif(btrim(a.client_label), ''), 'Scheduled event'), a.starts_at,
         jsonb_build_object('location', a.location, 'note', a.seller_note)
    from public.appointments a join c on a.lead_id = c.id
   where a.visibility = 'client'
  union all
  -- Deal-scoped shared appointments: shared once to the whole deal, seen by every
  -- party. lead_id IS NULL so a lead-linked event above is never duplicated here.
  select 'event', a.id, coalesce(nullif(btrim(a.client_label), ''), 'Scheduled event'), a.starts_at,
         jsonb_build_object('location', a.location, 'note', a.seller_note)
    from public.appointments a join d on a.deal_id = d.deal_id
   where a.visibility = 'client'
     and a.lead_id is null
  union all
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
     and not (doc.scope = 'transaction' and doc.escrow_id is not null
              and coalesce(esc.status, '') <> 'active')
     and case
           when d.role ~ 'buyer' then coalesce(g.visibility, 'agent_only') in ('buyer', 'both')
           else                       coalesce(g.visibility, 'agent_only') in ('seller', 'both')
         end;
$$;

grant execute on function public.portal_items(uuid) to anon, authenticated;
