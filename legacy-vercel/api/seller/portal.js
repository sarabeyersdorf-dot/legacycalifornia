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

// Dropbox share links preview with dl=0 and force-download with dl=1. Cowork
// creates these links from the executed files in Dropbox; we derive the right
// variant per action. Non-Dropbox URLs are returned unchanged.
function dbxLink(url, dl) {
  if (!url || !/dropbox\.com/i.test(url)) return url;
  let u = url.replace(/([?&])dl=[01]/i, `$1dl=${dl}`);
  if (!/[?&]dl=/i.test(u)) u += (u.includes('?') ? '&' : '?') + 'dl=' + dl;
  return u;
}

// Map a deal's property type to the right noun so a listing is never
// mis-described (vacant land is not a "home"). Falls back to "property", which
// is correct for anything. Matches on substrings so "single-family residential",
// "vacant land", "commercial building" etc. all resolve.
function propertyNoun(type) {
  const t = String(type || '').toLowerCase();
  if (/land|lot|acre|parcel/.test(t))            return 'land';
  if (/condo|townhome|townhouse/.test(t))        return 'condo';
  if (/commercial|retail|office|industrial|mixed/.test(t)) return 'property';
  if (/multi|duplex|triplex|fourplex|apartment/.test(t))   return 'property';
  if (/resid|home|house|single/.test(t))         return 'home';
  return 'property';
}

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
    const supa = adminClient();
    const token = req.query?.t ? String(req.query.t).trim() : null;

    let user = null, profile = null, isAgent = false, deal = null;
    let portalToken = null, leadId = null;
    let previewKey = null, previewMiss = false;

    if (token) {
      // Private-link access — NO login. Resolve the client by their unguessable
      // portal_token, then their most-recent seller-side deal. A wrong or stale
      // token returns a neutral "link expired" page with zero client data and
      // no detail about why (nothing to probe). The login path is untouched.
      const { data: lead } = await supa.from('leads')
        .select('id, email, portal_token').eq('portal_token', token).maybeSingle();
      if (!lead) return ok(res, { portal: expiredPortal() });
      user = { email: lead.email || '', id: null };
      portalToken = lead.portal_token || token;
      leadId = lead.id;
      const { data: parties } = await supa.from('deal_parties')
        .select('deal_id, role, deals(*)')
        .eq('lead_id', lead.id)
        .in('role', ['seller', 'co-seller', 'buyer', 'co-buyer']);
      const rows = (parties || []).map((p) => p.deals).filter(Boolean);
      rows.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
      deal = rows[0] || null;
    } else {
      const caller = await getCallerProfile(req, res);
      user = caller.user; profile = caller.profile;
      if (!user) return fail(res, 401, 'not authenticated');
      isAgent = /^agent_/.test(profile?.role || '');

      // 1. Resolve which deal to show --------------------------------------
      if (isAgent && req.query?.deal) {
        previewKey = String(req.query.deal);
        // Tolerant lookup: .limit(1) returns an array, so a duplicate
        // source_key (from an earlier upsert path) can't null the row out the
        // way .maybeSingle() would. Match by source_key first, then by id.
        let { data } = await supa.from('deals').select('*')
          .eq('source_key', previewKey)
          .order('updated_at', { ascending: false }).limit(1);
        deal = (data && data[0]) || null;
        if (!deal) {
          const alt = await supa.from('deals').select('*').eq('id', previewKey).limit(1);
          deal = (alt.data && alt.data[0]) || null;
        }
        // Agent asked for a SPECIFIC deal that isn't in the table. Don't fall
        // back to "newest pending" (that's how a listing showed 433's escrow) —
        // return a clear "not found" state instead.
        if (!deal) previewMiss = true;
      }

      if (!deal && !isAgent) {
        // seller: lead -> deal_parties -> deals (most recent pending)
        leadId = profile?.lead_id || null;
        if (!leadId) {
          const { data: l } = await supa.from('leads').select('id, portal_token')
            .eq('email', (user.email || '').toLowerCase()).maybeSingle();
          leadId = l?.id || null;
          portalToken = l?.portal_token || null;
        }
        if (leadId) {
          const { data: parties } = await supa.from('deal_parties')
            .select('deal_id, role, deals(*)')
            .eq('lead_id', leadId)
            .in('role', ['seller', 'co-seller', 'buyer', 'co-buyer']);
          const rows = (parties || []).map((p) => p.deals).filter(Boolean);
          rows.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
          deal = rows[0] || null;
        }
      }

      if (!deal && isAgent && !previewKey) {
        // agent with no ?deal → newest pending seller-side deal
        const { data } = await supa.from('deals').select('*')
          .eq('stage', 'pending').in('side', ['listing', 'seller', 'both'])
          .order('updated_at', { ascending: false }).limit(1).maybeSingle();
        deal = data || null;
      }
    }

    if (!deal && previewMiss) return ok(res, { portal: notFoundPortal(previewKey) });
    if (!deal) return ok(res, { portal: emptyPortal(user) });

    // 1b. Agent-shared items (portal_items) --------------------------------
    // The single source of truth for what a client may see: the SECURITY
    // DEFINER portal_items(token) function returns only rows the agent flipped
    // to client-visible (tasks/events) plus client-safe documents, scoped to
    // this token. An internal row can never surface here even if this code has
    // a bug. Fail-soft — a portal_items hiccup must not blank the portal.
    let sharedTasks = [], sharedEvents = [];
    try {
      if (!portalToken && leadId) {
        const { data: l } = await supa.from('leads').select('portal_token').eq('id', leadId).maybeSingle();
        portalToken = l?.portal_token || null;
      }
      if (portalToken) {
        const { data: items } = await supa.rpc('portal_items', { p_token: portalToken });
        for (const it of (items || [])) {
          if (it.item_type === 'task') {
            sharedTasks.push({ label: sanitize(it.title || 'Update'), when: 'From your agent', status: 'shared' });
          } else if (it.item_type === 'event') {
            const d = it.when_at ? new Date(it.when_at) : null;
            sharedEvents.push({
              date: (d && !isNaN(d)) ? `${MONTHS[d.getMonth()]} ${d.getDate()}` : '',
              label: sanitize(it.title || 'Scheduled'),
              status: 'upcoming',
              description: (d && !isNaN(d)) ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '',
              _at: (d && !isNaN(d)) ? d.getTime() : 0
            });
          }
          // documents from portal_items are already covered by the client-safe
          // deal_documents query below; skip to avoid duplicates.
        }
      }
    } catch (_) { /* stay soft */ }

    // 2. Documents for this deal (client-safe only) ------------------------
    // Prefer selecting doc_url (link to the executed file); fall back if the
    // column isn't there yet (pre-016) so documents never disappear.
    let docRes = await supa.from('deal_documents')
      .select('doc_type, name, sub, status, party_owed, client_safe, doc_url')
      .eq('deal_id', deal.id).eq('client_safe', true);
    if (docRes.error) {
      docRes = await supa.from('deal_documents')
        .select('doc_type, name, sub, status, party_owed, client_safe')
        .eq('deal_id', deal.id).eq('client_safe', true);
    }
    const docs = docRes.data || [];

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

    // "In the file" count. A doc counts as on-file if it's explicitly
    // signed/on_file OR it's a curated flat drop with no workflow status —
    // those are the executed PDFs Sara uploaded, so a listed file IS in the
    // file. Without this, curated portals showed 0 / N (e.g. 0/17) because
    // flat drops carry a null status. Docs with an OPEN status (to_sign /
    // with_seller / pending) are still counted as outstanding.
    const signed = docs.filter((d) => d.status === 'signed' || d.status === 'on_file' || !d.status).length;

    // Stage model. ONLY a 'pending' deal is in escrow — a 'listing' is on the
    // market and must NEVER be described in escrow/closing terms.
    const inEscrow   = deal.stage === 'pending';
    const isListing  = deal.stage === 'listing';
    const isPreparing= deal.stage === 'preparing';
    const isClosed   = deal.stage === 'closed';
    const isBuyerSide = deal.side === 'buyer';

    // Price is stage-correct: a listing shows its LIST price; an in-escrow /
    // closed deal shows the agreed PRICE. Label matches — "List price" while
    // on market, "Purchase price" for a buyer we represent in escrow, else
    // "Sale price". Never label a listing's number "Sale price".
    const price = (isListing || isPreparing)
      ? (deal.list_price ?? deal.sale_price)
      : (deal.sale_price ?? deal.list_price);
    const priceLabel = (isListing || isPreparing) ? 'List price'
                     : inEscrow ? (isBuyerSide ? 'Purchase price' : 'Sale price')
                     : isClosed ? (isBuyerSide ? 'Purchase price' : 'Sale price')
                     : 'Price';
    const STAGE_LABEL = { pending: 'In escrow', listing: 'On the market', preparing: 'Preparing to list', closed: 'Sold' };
    const stageLabel = STAGE_LABEL[deal.stage] || sanitize(deal.stage || '');
    const docsKpi = { label: 'Documents', value: `${signed} / ${docs.length}`, change: docs.length > signed ? `${docs.length - signed} open` : 'complete' };

    // KPIs are stage-appropriate — escrow terms only when actually in escrow.
    const kpis = inEscrow
      ? [
          { label: 'Days to close',   value: dtc != null ? String(dtc) : '—', change: dtc != null && dtc >= 0 ? 'On schedule' : '' },
          { label: priceLabel,        value: fmtUSD(price), change: '' },
          docsKpi,
          { label: 'Close of escrow', value: fmtDate(coe), change: coe ? String(coe.getFullYear()) : '' }
        ]
      : [
          { label: priceLabel, value: fmtUSD(price), change: '' },
          { label: 'Status',   value: stageLabel, change: '' },
          docsKpi
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

    // Fold agent-shared events (inspections, appraisals, meetings) into the
    // timeline in date order, ahead of the close-of-escrow marker.
    if (sharedEvents.length) {
      sharedEvents.sort((a, b) => a._at - b._at);
      const cleaned = sharedEvents.map(({ _at, ...r }) => r);
      const keyIdx = road.findIndex((r) => r.status === 'key');
      if (keyIdx >= 0) road.splice(keyIdx, 0, ...cleaned);
      else road.push(...cleaned);
    }

    // What I need from you = docs the client still owes a signature on,
    // plus any tasks the agent explicitly shared with this client.
    const tasks = docs
      .filter((d) => d.status === 'to_sign' || d.status === 'with_seller' || d.status === 'pending')
      .map((d) => ({ label: `Sign ${d.name}`, when: DOC_STATUS_LABEL[d.status] || 'Open', status: 'open' }))
      .concat(sharedTasks);

    // Team from the deal's contact columns
    const team = [];
    team.push({ name: deal.agent === 'james' ? 'James Beyersdorf' : 'Sara Cooper',
                sub: 'Your agent · Legacy', access: deal.agent === 'james' ? 'Agent' : 'Broker' });
    if (deal.escrow_officer) team.push({ name: sanitize(deal.escrow_officer), sub: 'Escrow / Title', access: 'Escrow' });
    if (deal.co_agent)       team.push({ name: sanitize(deal.co_agent), sub: "Buyer's side", access: 'Buyer side' });

    const documentsArr = docs.map((d) => {
      const raw = (d.doc_url && /^https?:\/\//i.test(d.doc_url)) ? d.doc_url : '';
      return {
        type: (d.doc_type || '').toUpperCase().slice(0, 6),
        name: sanitize(d.name), sub: sanitize(d.sub || ''),
        status: d.status ? (DOC_STATUS_LABEL[d.status] || 'On file') : '',   // optional — blank for flat drops
        view_url:       raw ? dbxLink(raw, 0) : '',   // preview (Dropbox dl=0)
        download_url:   raw ? dbxLink(raw, 1) : '',   // force download (Dropbox dl=1)
        view_label:     raw ? 'View' : '',            // data-optional anchors hide when empty
        download_label: raw ? 'Download ↓' : ''
      };
    });

    // Per-agent portal: James's sellers see James, not Sara. Pull the deal's
    // agent identity from the agents table (fail-soft to sensible defaults).
    let agentRow = null;
    try {
      const { data } = await supa.from('agents').select('name, phone, email, dre_number').eq('agent_key', deal.agent || 'sara').maybeSingle();
      agentRow = data || null;
    } catch (_) { /* agents table optional */ }
    const agentName  = agentRow?.name  || (deal.agent === 'james' ? 'James Beyersdorf' : 'Sara Cooper');
    const agentFirst = (agentName.split(' ')[0]) || 'Sara';
    const agentPhone = agentRow?.phone || (deal.agent === 'james' ? '209-770-7523' : '209-559-4966');

    // 4. Note from the agent — stage-appropriate. The escrow-framed AI note is
    //    used ONLY when the deal is actually in escrow; otherwise we use safe,
    //    deterministic copy so a listing is never described as "in escrow".
    const firstName = sellerFirstName(deal);
    const hi = firstName ? `${firstName} — ` : '';
    const noun = propertyNoun(deal.type);   // home / land / condo / property
    let noteBody;
    if (inEscrow) {
      noteBody = `${hi}we're moving right on schedule and still pointed at a ${fmtDateY(coe)} close. I'll flag anything that needs you the moment it comes up. Call me anytime.`;
      try {
        noteBody = await draftSellerNote({ firstName, deal, coe, dtc, signed, total: docs.length, tasks, agentName, agentPhone, noun, isBuyerSide });
      } catch (_) { /* keep fallback */ }
    } else if (isListing) {
      noteBody = `${hi}your ${noun} is live on the market and getting in front of buyers. I'll keep you posted on showings and feedback, and reach out the moment we have an offer to review. Call me anytime.`;
    } else if (isPreparing) {
      noteBody = `${hi}we're getting everything ready to bring your ${noun} to market — ${noun === 'land' ? 'photos, signage, and pricing' : 'photos, prep, and pricing'}. I'll walk you through each step. Call me anytime.`;
    } else if (isClosed) {
      noteBody = `${hi}congratulations, your sale has closed. It was a pleasure representing you, and I'm here whenever you need anything down the road.`;
    } else {
      noteBody = `${hi}I'll keep this page updated as things move along. Call me anytime with any questions.`;
    }

    // Standing wire-fraud warning — shown ONLY to in-escrow clients (the reason
    // the private-link model exists). Never on a listing that isn't in escrow.
    const security = {
      banner: inEscrow
        ? 'We will never send wire instructions through this portal, by email, or by text. Before wiring funds, always call the title company directly at a phone number you have independently verified.'
        : ''
    };

    // 5. Assemble -----------------------------------------------------------
    const portal = {
      security,
      seller: { first_name: firstName || '', who: sanitize(deal.address) },
      status: {
        label: stageLabel,
        badge: stageLabel,
        address: sanitize(deal.address),
        city: sanitize(deal.city || ''),
        type: sanitize(deal.type || ''),
        price: fmtUSDfull(price),
        price_label: priceLabel,     // "List price" on market · "Purchase/Sale price" in escrow
        headline: isBuyerSide ? 'Your purchase' : 'Your sale',   // sidebar/title, side-aware
        since: inEscrow && coe ? `In escrow · Closing ${fmtDateY(coe)}`
             : isListing ? 'On the market'
             : isClosed ? 'Sale closed'
             : isPreparing ? 'Preparing to list' : '',
        tagline: inEscrow ? 'On track to close.'
               : isListing ? 'Live on the market.'
               : isClosed ? 'Sale complete.'
               : isPreparing ? 'Getting ready to list.' : '',
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
        head: `A note from ${agentFirst} · This week`,
        body: sanitize(noteBody),
        sign: `— ${agentFirst} · ${agentPhone}`
      },
      contact: { name: agentName, first: agentFirst, phone: agentPhone, email: agentRow?.email || null }
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
    security: { banner: '' },
    seller: { first_name: (user?.email || '').split('@')[0] || '', who: '' },
    status: { label: 'No active listing', badge: '', address: '', city: '', type: '', price: '—', since: '', tagline: '' },
    tour: { video_url: null, video_id: null, matterport_url: null },
    nav: { documents: '0', tasks: '0' },
    kpis: [], road: [], documents: [], tasks: [], team: [], activity: [],
    note: { head: 'A note from Sara', body: 'Your listing dashboard will appear here once your sale is under way.', sign: '— Sara · (209) 559-4966' }
  };
}

// Agent preview of a deal key that isn't in the deals table (usually: the
// hourly sync hasn't run since Cowork added it, or the key drifted). This is an
// AGENT-ONLY state, so unlike emptyPortal it names the missing key so Sara can
// tell "not synced yet" from a real empty portal. No client ever sees this.
function notFoundPortal(key) {
  return {
    security: { banner: '' },
    seller: { first_name: '', who: '' },
    status: { label: 'Deal not found', badge: '', address: '', city: '', type: '', price: '—', since: '', tagline: '' },
    tour: { video_url: null, video_id: null, matterport_url: null },
    nav: { documents: '0', tasks: '0' },
    kpis: [], road: [], documents: [], tasks: [], team: [], activity: [],
    note: {
      head: 'This deal isn’t in the CRM yet',
      body: `No deal matching “${sanitize(key || '')}” is in the table yet. If Cowork just added it, run the deals sync (or wait for the next hourly run) and refresh.`,
      sign: ''
    }
  };
}

// A wrong, revoked, or stale private link. Deliberately reveals nothing — same
// shape as an empty portal but with a neutral "link expired" message and zero
// client data. Regenerating a lead's portal_token invalidates every prior link,
// which lands here.
function expiredPortal() {
  return {
    security: { banner: '' },
    seller: { first_name: '', who: '' },
    status: { label: 'Link expired', badge: '', address: '', city: '', type: '', price: '—', since: '', tagline: '' },
    tour: { video_url: null, video_id: null, matterport_url: null },
    nav: { documents: '0', tasks: '0' },
    kpis: [], road: [], documents: [], tasks: [], team: [], activity: [],
    note: {
      head: 'This link is no longer active',
      body: 'This private link has expired or been replaced. Please contact your agent for a current link to your portal.',
      sign: ''
    }
  };
}

async function draftSellerNote({ firstName, deal, coe, dtc, signed, total, tasks, agentName = 'Sara Cooper', agentPhone = '209-559-4966', noun = 'property', isBuyerSide = false }) {
  const clientKind = isBuyerSide ? 'BUYER' : 'SELLER';
  const dealKind   = isBuyerSide ? `${noun} purchase` : `${noun} sale`;
  const SYSTEM = `You write ONE short paragraph as ${agentName} of Legacy Properties, to your ${clientKind} client about their in-escrow ${dealKind}.
Call the property their "${noun}" — never assume it is a house if it is ${noun === 'land' ? 'vacant land' : 'a ' + noun}.
This client is ${isBuyerSide ? 'BUYING' : 'SELLING'} — never mix up the side.
Voice: warm, direct, reassuring, never salesy. Short sentences. No exclamation points. No markdown. No em-dashes. No placeholders.
Hard rules:
1. Your phone is ${agentPhone}. Never invent other contact info.
2. Only mention facts given below. Do NOT mention commission, financing problems, legal matters, or the buyer's private details.
3. 3-4 short sentences. No salutation line, no signoff (those are added separately). Plain prose.`;
  const owed = tasks.length ? tasks.map((t) => t.label.replace(/^Sign /, '')).join(', ') : 'nothing right now';
  const who = firstName || (isBuyerSide ? 'the buyer' : 'the seller');
  const prompt = `Write the weekly note to ${who} about their ${isBuyerSide ? 'purchase' : 'sale'} at ${deal.address}.
Facts: close of escrow ${fmtDateY(coe)} (${dtc != null ? dtc + ' days out' : 'date set'}); ${signed} of ${total} documents in the file; still need from ${isBuyerSide ? 'the buyer' : 'the seller'}: ${owed}.
Reassure them things are on track, note what you need from them if anything, and invite them to call. Under 80 words.`;
  const { text } = await anthropicMessage({
    system: SYSTEM, messages: [{ role: 'user', content: prompt }],
    max_tokens: 260, temperature: 0.6
  });
  return text.trim();
}
