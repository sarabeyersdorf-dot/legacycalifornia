-- 062_seller_portal_activity.sql
-- "Seller Portal Activity" spec (Sara, 2026-08-09), reconciled with the LIVE
-- architecture. The spec assumed sellers read appointments directly, linked by a
-- [deal:...] substring in notes. In reality the seller portal reads shared items
-- through the SECURITY DEFINER function portal_items(token), which scopes by the
-- token's lead. Two things follow:
--   * the curated label column already exists (client_label) — we don't add a
--     redundant seller_label; and
--   * linkage for the READ is by lead_id inside portal_items, not the notes
--     string — but we still add a real deal_id FK (the spec's #1 ask) for correct
--     linkage and future deal-scoped sharing.
--
-- What this migration does, in safety order:
--   1. CLOSE THE LEAK: portal_items fell back to appointments.title when
--      client_label was null. Titles carry buyer names ("Showing Denis Augusta").
--      Drop the fallback → a shared-but-unlabeled event shows a neutral
--      placeholder, never the raw title. (A fallback that shows LESS can only be
--      safer — no row can newly appear.)
--   2. RETIRE any currently-leaky rows: an appointment shared
--      (visibility <> 'internal') with no client_label is set back to 'internal'
--      until an agent re-shares it WITH a label.
--   3. seller_note (optional agent note to the seller on an event) + deal_id FK
--      with backfill from the legacy [deal:...] notes tag.
--   4. ENFORCE "can't share without a label" so the leak cannot recur.
-- Idempotent.

begin;

-- ── 3a. Columns ─────────────────────────────────────────────────────────────
alter table public.appointments
  add column if not exists seller_note text,
  add column if not exists deal_id uuid references public.deals(id);
create index if not exists appointments_deal_id_starts_idx
  on public.appointments (deal_id, starts_at desc);

-- ── 3b. Backfill deal_id from the legacy notes tag: [deal:<source_key> · addr] ─
update public.appointments a
   set deal_id = d.id
  from public.deals d
 where a.deal_id is null
   and a.notes ~ '\[deal:'
   and substring(a.notes from '\[deal:([a-z0-9\-]+)') = d.source_key;

-- ── 2. Retire currently-leaky shared rows (no curated label) to internal ─────
update public.appointments
   set visibility = 'internal'
 where visibility is not null
   and visibility <> 'internal'
   and (client_label is null or btrim(client_label) = '');

-- ── 4. Can't share without a label (mirrors the spec's constraint, using the
--        real curated column). Runs AFTER the cleanup above so no existing row
--        violates it. ────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'appointments_shared_needs_label') then
    alter table public.appointments add constraint appointments_shared_needs_label
      check (visibility = 'internal' or (client_label is not null and btrim(client_label) <> ''));
  end if;
end$$;

-- ── 1. Rebuild portal_items: appointment label no longer falls back to title,
--        and the event carries the optional seller_note. Everything else is
--        byte-for-byte db/056. ─────────────────────────────────────────────────
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
  -- Appointments: NEVER fall back to a.title (buyer names live there). A shared
  -- event without a curated client_label shows a neutral placeholder. The
  -- shared_needs_label constraint makes the null-label case unreachable for new
  -- shares; the coalesce is belt-and-suspenders.
  select 'event', a.id, coalesce(nullif(btrim(a.client_label), ''), 'Scheduled event'), a.starts_at,
         jsonb_build_object('location', a.location, 'note', a.seller_note)
    from public.appointments a join c on a.lead_id = c.id
   where a.visibility = 'client'
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
