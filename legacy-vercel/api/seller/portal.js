// api/seller/portal.js
// GET /api/seller/portal   (optionally ?deal=<source_key> for agent preview)
//
// The signed-in seller's listing/transaction portal payload for seller.html.
// Identity comes from the session cookie. A seller sees only their own deal
// (resolved via deal_parties -> their lead). An agent (role agent_sara /
// agent_james) may pass ?deal=<source_key> to preview any deal's portal.
//
// Returns display-ready strings under a `portal` key so the painter in
// legacy-client.js lifts them straight into [data-bind] / [data-list] nodes:
//
//   Scalars:  seller.*, nav.*, status.*, note.*
//   Lists:    kpis[], road[], documents[], tasks[], team[], activity[]
//
// Money/dates are pre-formatted. The "note from Sara" is the only AI call,
// fail-soft to a template. Reads via the service-role client and scopes in
// code (same pattern as api/me/dashboard.js).

import { adminClient } from '../_lib/supabase.js';
import { getCallerProfile } from '../_lib/auth.js';
import { anthropicMessage } from '../_lib/anthropic.js';
import { handleOptions, ok, fail } from '../_lib/cors.js';
import { extractYouTubeId } from '../_lib/youtube.js';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
const fmtUSD = (n) => {
  if (n == null || !Number.isFinite(+n)) return '—';
  const v = Math.abs(+n);
  if (v >= 1_000_000) return `$${(+n / 1_000_000).toFixed(v % 1_000_000 === 0 ? 1 : 2)}M`;
  if (v >= 1_000)     return `$${Math.round(+n / 1_000)}K`;
  return `$${Math.round(+n)}`;
};
const fmtUSDfull = (n) =>
  (n == null || !Number.isFinite(+n)) ? '—'
  : '$' + Math.round(+n).toLocaleString('en-US');

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const asDate = (s) => { const d = s ? new Date(s + 'T00:00:00') : null; return d && !isNaN(d) ? d : null; };
const fmtDate = (d) => d ? `${MONTHS[d.getMonth()]} ${d.getDate()}` : '—';
const fmtDateY = (d) => d ? `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}` : '—';
const daysBetween = (a, b) => (a && b) ? Math.round((b - a) / 86400000) : null;
const sanitize = (s) => (s || '').replace(/[<>]/g, '');

// Party owed / status → client label
const DOC_STATUS_LABEL = {
  signed: 'Signed', on_file: 'On file', to_sign: 'To sign',
  with_seller: 'With seller', sent: 'Sent', pending: 'Pending'
};

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');

  try {
    const { user, profile } = await getCallerProfile(req, res);
    if (!user) return fail(res, 401, 'not authenticated');

    const supa = adminClient();
    const isAgent = /^agent_/.test(profile?.role || '');

    // 1. Resolve which deal to show ----------------------------------------
    let deal = null;

    if (isAgent && req.query?.deal) {
      const { data } = await supa.from('deals').select('*')
        .eq('source_key', String(req.query.deal)).maybeSingle();
      deal = data || null;
    }

    if (!deal && !isAgent) {
      // seller: lead -> deal_parties -> deals (most recent pending)
      let leadId = profile?.lead_id || null;
      if (!leadId) {
        const { data: l } = await supa.from('leads').select('id')
          .eq('email', (user.email || '').toLowerCase()).maybeSingle();
        leadId = l?.id || null;
      }
      if (leadId) {
        const { data: parties } = await supa.from('deal_parties')
          .select('deal_id, role, deals(*)')
          .eq('lead_id', leadId)
          .in('role', ['seller', 'co-seller']);
        const rows = (parties || []).map((p) => p.deals).filter(Boolean);
        rows.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
        deal = rows[0] || null;
      }
    }

    if (!deal && isAgent) {
      // agent with no ?deal → newest pending seller-side deal
      const { data } = await supa.from('deals').select('*')
        .eq('stage', 'pending').in('side', ['listing', 'seller', 'both'])
        .order('updated_at', { ascending: false }).limit(1).maybeSingle();
      deal = data || null;
    }

    if (!deal) return ok(res, { portal: emptyPortal(user) });

    // 2. Documents for this deal (client-safe only) ------------------------
    const { data: docRows } = await supa.from('deal_documents')
      .select('doc_type, name, sub, status, party_owed, client_safe')
      .eq('deal_id', deal.id).eq('client_safe', true);
    const docs = docRows || [];

    // Hero photo + tour media — driven from deals.json ("photo" / "video" /
    // "matterport"), with a property-photo and YouTube-thumbnail fallback so a
    // real client never sees a stock or blank hero. Fail-soft.
    const videoId = extractYouTubeId(deal.video_url);
    let heroPhoto = deal.photo_url || null;
    try {
      if (!heroPhoto && deal.property_id) {
        const { data: prop } = await supa.from('properties').select('photos').eq('id', deal.property_id).maybeSingle();
        heroPhoto = (prop?.photos && prop.photos[0]) || null;
      }
    } catch (_) { /* stay soft — a missing photo must never break the portal */ }
    if (!heroPhoto && videoId) heroPhoto = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

    // 3. Derived pieces ----------------------------------------------------
    const coe   = asDate(deal.coe_date);
    const open  = asDate(deal.escrow_open_date);
    const today = new Date(); today.setHours(0,0,0,0);
    const dtc   = daysBetween(today, coe);
    const price = deal.sale_price || deal.list_price;

    const signed = docs.filter((d) => d.status === 'signed' || d.status === 'on_file').length;

    const kpis = [
      { label: 'Days to close', value: dtc != null ? String(dtc) : '—', change: dtc != null && dtc >= 0 ? 'On schedule' : '' },
      { label: 'Sale price',    value: fmtUSD(price), change: '' },
      { label: 'Documents',     value: `${signed} / ${docs.length}`, change: docs.length > signed ? `${docs.length - signed} open` : 'complete' },
      { label: 'Close of escrow', value: fmtDate(coe), change: coe ? String(coe.getFullYear()) : '' }
    ];

    // Road to closing (built from the dates we hold; enrich later via deal_milestones)
    const road = [];
    if (open) road.push({ date: fmtDate(open), label: 'Escrow opened', status: 'done',
                          description: [deal.title_company, deal.escrow_officer].filter(Boolean).join(' · ') || 'Escrow opened.' });
    if (docs.some((d) => /inspection/i.test(d.name) && (d.status === 'signed' || d.status === 'on_file')))
      road.push({ date: '', label: 'Inspections', status: 'done', description: 'Inspection reports received.' });
    if (docs.length)
      road.push({ date: '', label: 'Disclosures & documents', status: signed >= docs.length ? 'done' : 'next',
                  description: `${signed} of ${docs.length} documents in the file.` });
    if (coe) {
      const walk = new Date(coe); walk.setDate(walk.getDate() - 5);
      road.push({ date: fmtDate(walk), label: 'Final walk-through', status: 'upcoming', description: 'A final look before closing.' });
      road.push({ date: fmtDate(coe), label: 'Close of escrow', status: 'key', description: 'Deed records and proceeds release.' });
    }

    // What I need from you = docs the client still owes a signature on
    const tasks = docs
      .filter((d) => d.status === 'to_sign' || d.status === 'with_seller' || d.status === 'pending')
      .map((d) => ({ label: `Sign ${d.name}`, when: DOC_STATUS_LABEL[d.status] || 'Open', status: 'open' }));

    // Team from the deal's contact columns
    const team = [];
    team.push({ name: deal.agent === 'james' ? 'James Beyersdorf' : 'Sara Cooper',
                sub: 'Your agent · Legacy', access: deal.agent === 'james' ? 'Agent' : 'Broker' });
    if (deal.escrow_officer) team.push({ name: sanitize(deal.escrow_officer), sub: 'Escrow / Title', access: 'Escrow' });
    if (deal.co_agent)       team.push({ name: sanitize(deal.co_agent), sub: "Buyer's side", access: 'Buyer side' });

    const documentsArr = docs.map((d) => ({
      type: (d.doc_type || '').toUpperCase().slice(0, 6),
      name: sanitize(d.name), sub: sanitize(d.sub || ''),
      status: DOC_STATUS_LABEL[d.status] || 'On file'
    }));

    // 4. Note from Sara (AI, fail-soft) ------------------------------------
    const firstName = sellerFirstName(deal);
    let noteBody = `${firstName ? firstName + ' — ' : ''}we're moving right on schedule and still pointed at a ${fmtDateY(coe)} close. I'll flag anything that needs you the moment it comes up. Call me anytime.`;
    try {
      noteBody = await draftSellerNote({ firstName, deal, coe, dtc, signed, total: docs.length, tasks });
    } catch (_) { /* keep fallback */ }

    // 5. Assemble -----------------------------------------------------------
    const portal = {
      seller: { first_name: firstName || '', who: sanitize(deal.address) },
      status: {
        label: deal.stage === 'pending' ? 'In escrow' : sanitize(deal.stage || ''),
        badge: deal.stage === 'pending' ? 'In escrow' : sanitize(deal.stage || ''),
        address: sanitize(deal.address),
        city: sanitize(deal.city || ''),
        type: sanitize(deal.type || ''),
        price: fmtUSDfull(price),
        since: coe ? `In escrow · Closing ${fmtDateY(coe)}` : '',
        photo: heroPhoto
      },
      tour: {
        video_url:      deal.video_url || null,
        video_id:       videoId,
        matterport_url: deal.matterport_url || null
      },
      nav: { documents: String(docs.length), tasks: String(tasks.length) },
      kpis, road, documents: documentsArr, tasks, team,
      activity: [],
      note: {
        head: 'A note from Sara · This week',
        body: sanitize(noteBody),
        sign: '— Sara · (209) 559-4966'
      }
    };

    return ok(res, { portal });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}

// ---------------------------------------------------------------------------
// Sub-helpers
// ---------------------------------------------------------------------------
function sellerFirstName(deal) {
  // Best effort from stored notes/first party; safe fallback to ''.
  const m = /Sellers?\s+([A-Z][a-z]+)/.exec(deal.notes_internal || '');
  return m ? m[1] : '';
}

function emptyPortal(user) {
  return {
    seller: { first_name: (user.email || '').split('@')[0] || '', who: '' },
    status: { label: 'No active listing', badge: '', address: '', city: '', type: '', price: '—', since: '' },
    nav: { documents: '0', tasks: '0' },
    kpis: [], road: [], documents: [], tasks: [], team: [], activity: [],
    note: { head: 'A note from Sara', body: 'Your listing dashboard will appear here once your sale is under way.', sign: '— Sara · (209) 559-4966' }
  };
}

async function draftSellerNote({ firstName, deal, coe, dtc, signed, total, tasks }) {
  const SYSTEM = `You write ONE short paragraph as Sara Cooper, Broker-Owner of Legacy Properties, to her SELLER client about their in-escrow home sale.
Voice: warm, direct, reassuring, never salesy. Short sentences. No exclamation points. No markdown. No em-dashes. No placeholders.
Hard rules:
1. Sara's phone is 209-559-4966. Never invent other contact info.
2. Only mention facts given below. Do NOT mention commission, financing problems, legal matters, or the buyer's private details.
3. 3-4 short sentences. No salutation line, no signoff (those are added separately). Plain prose.`;
  const owed = tasks.length ? tasks.map((t) => t.label.replace(/^Sign /, '')).join(', ') : 'nothing right now';
  const prompt = `Write the weekly note to ${firstName || 'the seller'} about their sale at ${deal.address}.
Facts: close of escrow ${fmtDateY(coe)} (${dtc != null ? dtc + ' days out' : 'date set'}); ${signed} of ${total} documents in the file; still need from the seller: ${owed}.
Reassure them things are on track, note what you need from them if anything, and invite them to call. Under 80 words.`;
  const { text } = await anthropicMessage({
    system: SYSTEM, messages: [{ role: 'user', content: prompt }],
    max_tokens: 260, temperature: 0.6
  });
  return text.trim();
}
