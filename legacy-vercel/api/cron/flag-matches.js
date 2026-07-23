// api/cron/flag-matches.js
// GET /api/cron/flag-matches   (Vercel cron — runs shortly after the IDX sync)
//
// For each saved_search, re-runs its exact filters and flags NEW listings —
// ones that weren't present on the previous run. Updates new_match_count /
// last_seen_listing_ids / last_run_at so the Curated screen shows "N new" per
// search. First run for a search is a silent baseline (no flood of "all N new").
// Writes a sync_runs heartbeat so a stalled job is visible, not silent.
//
// AUTO-PUSH (db/028): when a search has auto_push=true and a linked client, the
// NEW matches are also added to a dedicated curated collection and emailed to
// the client automatically — no manual review. Off by default and gated on a
// client email, so nothing reaches a client the agent didn't opt in.

import { adminClient } from '../_lib/supabase.js';
import { runSearch } from '../_lib/handlers/curate-search.js';
import { handleOptions, ok, fail } from '../_lib/cors.js';
import { buildClientPayload, buildPushMessage, agentIdentity } from '../_lib/collection-render.js';
import { sendEmail as sendEmailResend, resendConfigured } from '../_lib/resend.js';
import { sendEmail as sendEmailSendgrid, sendgridConfigured } from '../_lib/sendgrid.js';

// Auto-deliver the fresh matches for one saved search to its linked client:
// maintain a dedicated collection, add the new listings, and email the client
// the new ones. Best-effort — the durable part (adding to the collection) still
// happens even if email isn't configured. Returns a small summary for the log.
export async function autoDeliver(supa, s, freshIds) {
  // 1. Ensure a dedicated collection exists for this search.
  let collId = s.collection_id;
  if (collId) {
    const { data } = await supa.from('curated_collections').select('id').eq('id', collId).maybeSingle();
    if (!data) collId = null;   // it was deleted — recreate below
  }
  if (!collId) {
    const { data: created, error } = await supa.from('curated_collections').insert({
      agent: s.agent,
      title: s.name || 'New matches for you',
      client_lead_id: s.client_lead_id,
      status: 'active',
      intro_note: `New homes matching your “${s.name || 'saved'}” search.`
    }).select('id').single();
    if (error || !created) throw new Error(`collection create: ${error?.message || 'unknown'}`);
    collId = created.id;
    await supa.from('saved_searches').update({ collection_id: collId }).eq('id', s.id);
  }

  // 2. Add the fresh listings to the collection (included → client-visible).
  const { count: existing } = await supa.from('collection_listings')
    .select('id', { count: 'exact', head: true }).eq('collection_id', collId);
  const rows = freshIds.map((pid, i) => ({ collection_id: collId, property_id: pid, included: true, sort_order: (existing || 0) + i }));
  if (rows.length) await supa.from('collection_listings').upsert(rows, { onConflict: 'collection_id,property_id' });

  // 3. Build the client email of just the NEW listings (link shows the full set).
  const { data: coll } = await supa.from('curated_collections')
    .select('*, leads(id,first_name,last_name,email)').eq('id', collId).maybeSingle();
  if (!coll) throw new Error('collection vanished mid-run');
  const clientEmail = coll.leads?.email || null;
  if (coll.status !== 'active') await supa.from('curated_collections').update({ status: 'active' }).eq('id', collId);

  if (!clientEmail) return { added: freshIds.length, emailed: false, reason: 'no client email on file' };

  const agent = await agentIdentity(supa, s.agent);
  const payload = await buildClientPayload(supa, coll);
  const freshSet = new Set(freshIds);
  const freshListings = payload.listings.filter((l) => freshSet.has(l.id));
  const msg = buildPushMessage({
    coll, agent, channel: 'email',
    firstName: coll.leads?.first_name || '',
    subject: `${coll.leads?.first_name ? coll.leads.first_name + ', ' : ''}${freshIds.length} new home${freshIds.length === 1 ? '' : 's'} matched your search`,
    listings: freshListings.length ? freshListings : payload.listings
  });

  // 4. Send via whichever email provider is configured (best-effort).
  const provider = resendConfigured() ? sendEmailResend : (sendgridConfigured() ? sendEmailSendgrid : null);
  let sentOk = false, via = 'none';
  if (provider) {
    const r = await provider({
      agent: s.agent, to: clientEmail,
      toName: [coll.leads?.first_name, coll.leads?.last_name].filter(Boolean).join(' ') || null,
      subject: msg.subject, text: msg.text, html: msg.html
    });
    sentOk = !r.skipped;
    via = resendConfigured() ? 'resend' : 'sendgrid';
  }

  // 5. Log the send so it shows in the inbox / on the contact, and stamp the search.
  const nowIso = new Date().toISOString();
  if (coll.leads?.id) {
    await supa.from('messages').insert({
      lead_id: coll.leads.id, direction: 'outbound', channel: 'email',
      body: `Auto-matched ${freshIds.length} new home${freshIds.length === 1 ? '' : 's'}: ${msg.link}`,
      subject: msg.subject, status: sentOk ? 'sent' : 'failed',
      ai_generated: true, approved_by: s.agent, approved_at: nowIso
    }).then(() => {}, () => {});
    if (sentOk) {
      await supa.from('leads').update({ last_contact_at: nowIso }).eq('id', coll.leads.id).then(() => {}, () => {});
      await supa.from('lead_events').insert({
        lead_id: coll.leads.id, event_type: 'message_sent', source: 'mailerlite',
        event_data: { collection_id: collId, channel: 'email', kind: 'saved_search_auto_push', new_count: freshIds.length }
      }).then(() => {}, () => {});
    }
  }
  await supa.from('saved_searches').update({ last_auto_push_at: nowIso }).eq('id', s.id);
  return { added: freshIds.length, emailed: sentOk, via };
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  // Auth: Vercel cron sends `x-vercel-cron`; if CRON_SECRET is set, also accept
  // `Authorization: Bearer <CRON_SECRET>` (Vercel injects it automatically).
  const cronSecret = process.env.CRON_SECRET;
  const bearer = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const okCron = !!req.headers['x-vercel-cron'] || (cronSecret ? bearer === cronSecret : true);
  if (!okCron) return fail(res, 401, 'cron secret invalid');
  res.setHeader('Cache-Control', 'no-store');

  const supa = adminClient();
  try {
    // Prefer the auto-push columns (db/028); degrade gracefully so the match
    // flagging keeps working on a database where 028 hasn't run yet.
    let searches = null;
    {
      const full = await supa.from('saved_searches')
        .select('id, agent, name, filters, client_lead_id, auto_push, collection_id, last_seen_listing_ids');
      if (full.error) {
        const base = await supa.from('saved_searches').select('id, agent, name, filters, client_lead_id, last_seen_listing_ids');
        searches = (base.data || []).map((s) => ({ ...s, auto_push: false, collection_id: null }));
      } else {
        searches = full.data;
      }
    }

    let scanned = 0, newMatches = 0, autoPushed = 0, autoErrors = 0;
    for (const s of (searches || [])) {
      try {
        const { listings } = await runSearch(supa, s.filters || {}, { limit: 200 });
        const ids = listings.map((l) => l.id);
        const prev = s.last_seen_listing_ids || [];
        const isBaseline = prev.length === 0;              // first run → don't flood
        const seen = new Set(prev);
        const fresh = isBaseline ? [] : ids.filter((id) => !seen.has(id));
        await supa.from('saved_searches').update({
          new_match_count: fresh.length,
          last_seen_listing_ids: ids,
          last_run_at: new Date().toISOString()
        }).eq('id', s.id);
        scanned++; newMatches += fresh.length;

        // Hands-off client delivery — only when opted in, with a linked client
        // and genuinely new matches. Isolated so a delivery failure never stops
        // the scan (the "N new" flag is already saved above regardless).
        if (fresh.length && s.auto_push && s.client_lead_id) {
          try { const r = await autoDeliver(supa, s, fresh); if (r.emailed) autoPushed++; }
          catch (e) { autoErrors++; supa.from('sync_runs').insert({ job: 'saved_search_auto_push', status: 'error', detail: { search: s.id, error: e.message } }).then(() => {}, () => {}); }
        }
      } catch (_) { /* skip a broken filter set, keep going */ }
    }

    supa.from('sync_runs').insert({ job: 'saved_search_match', status: 'ok', detail: { searches: scanned, new_matches: newMatches, auto_pushed: autoPushed, auto_errors: autoErrors } }).then(() => {}, () => {});
    return ok(res, { scanned, new_matches: newMatches, auto_pushed: autoPushed, auto_errors: autoErrors, ran_at: new Date().toISOString() });
  } catch (e) {
    supa.from('sync_runs').insert({ job: 'saved_search_match', status: 'error', detail: { error: e.message } }).then(() => {}, () => {});
    return fail(res, 500, e.message);
  }
}
