-- db/078_showing_agent_seller_scoped.sql
-- Outside-agent showings, surfaced to the SELLER only.
--
-- Two things:
--   1. appointments.showing_agent — free-text name (+ brokerage) of the agent who
--      showed the home, when it wasn't Sara or James. Null for our own showings.
--   2. portal_items: a shared showing (kind='showing', deal-scoped) must reach the
--      SELLER side of the deal only — never a buyer party. Sellers want to know
--      who toured their home and how often; a buyer should never see another
--      buyer's agent. Non-showing deal-scoped appointments (e.g. inspections)
--      still reach everyone on the deal, exactly as before. We also expose
--      `kind` and `showing_agent` in the event meta so the seller portal can
--      label the showing and count per agent.
--
-- Everything else in portal_items is byte-for-byte db/068.
-- Idempotent.

begin;

alter table public.appointments
  add column if not exists showing_agent text;

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
         jsonb_build_object('location', a.location, 'note', a.seller_note,
                            'kind', a.kind, 'showing_agent', a.showing_agent)
    from public.appointments a join c on a.lead_id = c.id
   where a.visibility = 'client'
  union all
  -- Deal-scoped shared appointments: shared once to the whole deal, seen by every
  -- party. lead_id IS NULL so a lead-linked event above is never duplicated here.
  -- EXCEPTION: a showing reaches the SELLER side only — a buyer party never sees
  -- who toured the listing. Other kinds still reach everyone on the deal.
  select 'event', a.id, coalesce(nullif(btrim(a.client_label), ''), 'Scheduled event'), a.starts_at,
         jsonb_build_object('location', a.location, 'note', a.seller_note,
                            'kind', a.kind, 'showing_agent', a.showing_agent)
    from public.appointments a join d on a.deal_id = d.deal_id
   where a.visibility = 'client'
     and a.lead_id is null
     and (a.kind is distinct from 'showing' or d.role !~* 'buyer')
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

commit;
