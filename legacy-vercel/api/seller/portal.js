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

// Resolve a stored document link to something the client's browser can actually
// open. Our own files live in public/docs and are served at /docs/... on the
// app's real origin — but many rows store an ABSOLUTE url to legacycalifornia.com,
// a domain that isn't connected to this deployment, so those 404. Rewrite any
// "/docs/..." link (whatever host it was saved with) to a same-origin relative
// path so it works on the actual portal domain (vercel.app today, a custom
// domain later). Dropbox links get the dl=0/1 preview/download flag; anything
// else external is passed through untouched.
function portalDocUrl(url, forDownload) {
  if (!url) return '';
  if (/dropbox\.com/i.test(url)) return dbxLink(url, forDownload ? 1 : 0);
  const m = /^https?:\/\/[^/]+(\/docs\/.+)$/i.exec(url);   // absolute → /docs/... path
  if (m) return m[1];
  if (/^\/docs\//i.test(url)) return url;                  // already relative
  return url;
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
    // "View as seller" preview: an agent can render the PURE client view of a
    // ?deal= preview (?as=seller) — exactly what the seller sees, with no agent
    // console, no Completed list, no private note. Authorization still uses the
    // agent session; only the presentation switches to the client's.
    const clientView = /^(seller|client)$/i.test(String(req.query?.as || ''));

    let user = null, profile = null, isAgent = false, deal = null;
    let portalToken = null, leadId = null;
    let previewKey = null, previewMiss = false;
    let viewerRole = null;   // this viewer's party role on the deal (seller/buyer) —
                             // drives doc audience so a buyer never sees seller docs
                             // even on a both-sided in-house deal.

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
      const pr = (parties || []).filter((p) => p.deals);
      pr.sort((a, b) => new Date(b.deals.updated_at || 0) - new Date(a.deals.updated_at || 0));
      deal = pr[0]?.deals || null;
      viewerRole = pr[0]?.role || null;
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
          const pr = (parties || []).filter((p) => p.deals);
          pr.sort((a, b) => new Date(b.deals.updated_at || 0) - new Date(a.deals.updated_at || 0));
          deal = pr[0]?.deals || null;
          viewerRole = pr[0]?.role || null;
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

    // Presentation gate: agent extras (console, Completed list, private note)
    // show only for a real agent viewer who is NOT in "view as seller" mode.
    const showAgent = isAgent && !clientView;

    if (!deal && previewMiss) return ok(res, { portal: notFoundPortal(previewKey) });
    if (!deal) return ok(res, { portal: emptyPortal(user) });

    // 1b. Agent-shared items (portal_items) --------------------------------
    // The single source of truth for what a client may see: the SECURITY
    // DEFINER portal_items(token) function returns only rows the agent flipped
    // to client-visible (tasks/events) plus client-safe documents, scoped to
    // this token. An internal row can never surface here even if this code has
    // a bug. Fail-soft — a portal_items hiccup must not blank the portal.
    let sharedTasks = [], sharedEvents = [], showingsRaw = [];
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
            const at = (d && !isNaN(d)) ? d.getTime() : 0;
            const meta = it.meta || {};
            // A showing (portal_items already scopes these to the seller side) is
            // pulled into its own list — who toured + an auto-count per agent —
            // rather than the closing road.
            if (meta.kind === 'showing') {
              showingsRaw.push({
                _at: at,
                date: (d && !isNaN(d)) ? `${MONTHS[d.getMonth()]} ${d.getDate()}` : '',
                time: (d && !isNaN(d)) ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '',
                agent: sanitize(meta.showing_agent || '') || null
              });
            } else {
              sharedEvents.push({
                date: (d && !isNaN(d)) ? `${MONTHS[d.getMonth()]} ${d.getDate()}` : '',
                label: sanitize(it.title || 'Scheduled'),
                status: 'upcoming',
                description: (d && !isNaN(d)) ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '',
                _at: at
              });
            }
          }
          // documents from portal_items are already covered by the client-safe
          // deal_documents query below; skip to avoid duplicates.
        }
      }
    } catch (_) { /* stay soft */ }

    // Showings for the seller: one row per agent with an auto-count ("how many
    // times each agent has shown") + their most recent visit. Named outside
    // agents rank first; our own team's showings roll up under "Legacy
    // Properties". Front-end binds `agent` + `count_label`; empty ⇒ section hides.
    let showings = [];
    if (showingsRaw.length) {
      showingsRaw.sort((a, b) => a._at - b._at);  // ascending, so last write = most recent
      const counts = new Map(), lastDate = new Map();
      for (const s of showingsRaw) {
        const key = s.agent || 'Legacy Properties';
        counts.set(key, (counts.get(key) || 0) + 1);
        if (s.date) lastDate.set(key, s.date);
      }
      showings = [...counts.entries()].map(([agent, count]) => {
        const label = (count === 1 ? '1 showing' : `${count} showings`)
          + (lastDate.get(agent) ? ` · last ${lastDate.get(agent)}` : '');
        return { agent, count, is_outside: agent !== 'Legacy Properties', count_label: label };
      }).sort((a, b) => (b.is_outside - a.is_outside) || (b.count - a.count));
    }

    // Escrow records for this property (Slice 2/3). Fetched once; used to scope
    // documents by escrow, to suppress the escrow road when back on market, and to
    // build the back-on-market banner + history below. Fail-soft (pre-055).
    let escrowRows = [];
    try {
      const { data } = await supa.from('deal_escrows')
        .select('*').eq('deal_id', deal.id).order('sort', { ascending: true });
      escrowRows = data || [];
    } catch (_) { escrowRows = []; }
    const activeEscrow = escrowRows.find((e) => e.status === 'active') || null;
    const noActiveEscrow = escrowRows.length > 0 && !activeEscrow;
    const escrowStatusById = new Map(escrowRows.map((e) => [e.id, e.status]));
    // A transaction document tied to a NON-active escrow is archived with that
    // escrow: it's kept out of the live document list (and, for a buyer, hidden
    // entirely — SPEC test 2: a new buyer never sees the prior escrow's RPA). It
    // resurfaces only under that escrow's collapsed history for the seller.
    const isArchivedEscrowDoc = (doc) =>
      doc.scope === 'transaction' && doc.escrow_id && escrowStatusById.get(doc.escrow_id) !== 'active';

    // 2. Documents for this deal ---------------------------------------------
    // A SELLER sees their own file by default: any client-safe document shows,
    // without waiting on per-doc folder governance (every deal has a different
    // set — there's no fixed checklist). An explicit grant still wins, so a
    // document can be pinned to a specific audience or hidden (agent_only), and a
    // doc marked client_safe = false never shows.
    //
    // A BUYER stays locked down: they see ONLY documents explicitly granted to
    // buyer/both, so a buyer can never pick up a stray seller-side file (e.g. the
    // listing agreement, or a prior escrow's paperwork). db/053 governance.
    //
    //   audience  — follows the VIEWER's role first: a buyer-party is always a
    //               buyer audience, even on a both-sided in-house deal (side
    //               'both'), so the buyer never picks up the seller's client-safe
    //               files (listing agreement, seller disclosures, etc.). Falls
    //               back to the deal side for the agent preview / logged-in seller.
    //   fail-open guard — a grant's fingerprint must still match the document's
    //               name, so a reused doc_key can't inherit an old grant.
    const isBuyerViewer = /buyer/.test(String(viewerRole || '').toLowerCase());
    const audience = (isBuyerViewer || /buyer/.test(String(deal.side || '').toLowerCase())) ? 'buyer' : 'seller';
    const normName = (s) => String(s || '').trim().toLowerCase();
    let allDocs = [];
    {
      let dr = await supa.from('deal_documents')
        .select('doc_type, name, sub, status, party_owed, doc_url, doc_key, scope, escrow_id, client_safe')
        .eq('deal_id', deal.id);
      if (dr.error) {
        // pre-052/055 (no scope/doc_key/escrow_id columns): degrade to the minimal
        // set. A seller still sees their client-safe docs; a buyer sees none
        // (no doc_key to match a grant), which stays safe.
        dr = await supa.from('deal_documents')
          .select('doc_type, name, sub, status, party_owed, doc_url, client_safe')
          .eq('deal_id', deal.id);
      }
      allDocs = dr.data || [];
    }
    let govByKey = new Map();
    try {
      const { data: gov } = await supa.from('deal_document_governance')
        .select('doc_key, visibility, doc_fingerprint').eq('deal_id', deal.id);
      govByKey = new Map((gov || []).map((g) => [g.doc_key, g]));
    } catch (_) { /* pre-053: no grants → seller default below still applies */ }
    // Visibility + audience gate (shared by the live list and escrow history).
    const maySee = (doc) => {
      // Buyer hard guardrail: the seller's listing agreement (and its
      // modifications) is NEVER a buyer document — it belongs to the listing
      // relationship, not the purchase. Block it for a buyer even if a grant was
      // mistakenly set to buyer/both. Purchase Agreement / counters classify as
      // 'contract' (checked first in docCategory), so this only ever hits the
      // listing agreement family.
      if (audience === 'buyer' && docCategory(doc.doc_type, doc.name) === 'listing') return false;
      // An explicit grant (fingerprint-matched) always wins — it can widen,
      // narrow, or hide (agent_only) a document for either audience.
      if (doc.doc_key) {
        const g = govByKey.get(doc.doc_key);
        if (g && normName(g.doc_fingerprint) === normName(doc.name)) {
          const v = g.visibility || 'agent_only';
          return v === 'both' || v === audience;
        }
      }
      // Prior-sale guardrail (fail closed for trust): the previous buyer's
      // contract file is NEVER a default client document. A transaction-scope
      // doc tied to a cancelled/closed escrow — or any transaction-scope doc
      // once the deal has no active escrow (back on market) — belongs to a
      // prior sale. Without this, a governance seed that never tightened (the
      // seeds are insert-only) let the seller pick the prior buyer's RPA,
      // counters and addenda straight out of the live list and the escrow
      // history. An explicit seller/both grant (handled above) still opts a
      // specific document back in; everything else stays hidden.
      const priorSaleDoc = String(doc.scope || '') === 'transaction' &&
        (doc.escrow_id ? escrowStatusById.get(doc.escrow_id) !== 'active' : !activeEscrow);
      if (priorSaleDoc) return false;
      // No explicit grant: the SELLER sees their own client-safe documents by
      // default; a BUYER sees nothing ungoverned (fail closed for buyers).
      if (audience !== 'seller') return false;
      return doc.client_safe !== false;
    };
    // Live list: visible docs that are NOT archived with a dead/other escrow.
    const docs = allDocs.filter((doc) => maySee(doc) && !isArchivedEscrowDoc(doc));

    // Hero photo + tour media — driven from deals.json ("photo" / "video" /
    // "matterport"), with a property-photo and YouTube-thumbnail fallback so a
    // real client never sees a stock or blank hero. Fail-soft.
    // Agent CRM overrides (db/066): a video / 3D-tour link set in the CRM
    // (deals.agent_overrides) wins over the deals.json value, so an agent can
    // attach listing media to a deal and the seller portal shows it immediately,
    // surviving the hourly sync — without waiting on Cowork.
    const _ov = (deal.agent_overrides && typeof deal.agent_overrides === 'object' && !Array.isArray(deal.agent_overrides)) ? deal.agent_overrides : {};
    const effVideoUrl = (_ov.video_url != null && _ov.video_url !== '') ? _ov.video_url : deal.video_url;
    const effMatterportUrl = (_ov.matterport_url != null && _ov.matterport_url !== '') ? _ov.matterport_url : deal.matterport_url;
    // The listing's public marketing page (agent-set, survives sync via
    // agent_overrides). Seller-side only — it's their home's showcase; a buyer's
    // purchase portal has no use for "your home's marketing page".
    const effShowcaseUrl = (_ov.showcase_url != null && _ov.showcase_url !== '') ? String(_ov.showcase_url) : null;
    // The listing's vertical marketing reel (agent-set, survives sync via
    // agent_overrides). A self-hosted page on our own site (e.g.
    // /showcase/<id>/reel.html) that the portal embeds. Seller-side only — a
    // buyer's purchase portal has no listing reel.
    const effReelUrl = (_ov.reel_url != null && _ov.reel_url !== '') ? String(_ov.reel_url) : null;
    const videoId = extractYouTubeId(effVideoUrl);
    // The agent's uploaded photo (photo_override) wins over everything — same
    // priority as the CRM listing card — so a replaced photo binds here too.
    let heroPhoto = deal.photo_override || deal.photo_url || null;
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
    // Buyer-vs-seller FRAMING follows the viewer's role (audience), not just the
    // deal side — so a buyer-party on a both-sided in-house deal (side 'both')
    // gets the purchase view: no listing marketing, "Your purchase" framing, and
    // (below) their own agent's note + contact. A seller-party still gets the
    // sale view. This drives price label, marketing, headline, note, is_buyer.
    const isBuyerSide = audience === 'buyer';

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
    // Documents KPI shows the ACTUAL number of documents in this deal's portal —
    // never a fixed "X / Y" (there's no predetermined checklist; every deal has a
    // different set). Omitted entirely when there are none, so a deal with no
    // shared docs shows no misleading "0 / 0" tile — the Documents section below
    // simply lists what's there (or a short empty note).
    const docsKpi = docs.length
      ? { label: 'Documents', value: String(docs.length),
          change: signed < docs.length ? `${docs.length - signed} to sign` : 'all in' }
      : null;

    // KPIs are stage-appropriate — escrow terms only when actually in escrow.
    const kpis = (inEscrow
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
        ]).filter(Boolean);

    // Road to closing. Preferred source: the curated deal_timeline_items —
    // the plain-English contractual timeline the agent approves updates to
    // (seeded from the CA RPA template, dates per contract). Falls back to
    // the original date-heuristic road when a deal hasn't been seeded yet.
    let road = [];
    let timelineTasks = null;
    // A buyer viewer prefers Cowork's buyer-authored milestones (db/070) when
    // present; those are already written from the buyer's seat, so they skip the
    // heuristic buyerizeRoad() re-frame later. Otherwise fall back to the seller
    // milestones (which buyerizeRoad softens for a buyer).
    const buyerMs = (isBuyerSide && Array.isArray(deal.buyer_milestones) && deal.buyer_milestones.length) ? deal.buyer_milestones : null;
    let usedBuyerMilestones = false;
    const msSource = buyerMs || (Array.isArray(deal.milestones) ? deal.milestones : null);

    // Preferred source: the deals.json milestones (v1.5 — each carries a full
    // `desc` paragraph, a `badge` chip, a status dot and an At-a-Glance `col`).
    // This is Cowork's maintained source of truth and matches the Today board.
    // Suppressed when back on market (no active escrow) — see noActiveEscrow.
    if (!noActiveEscrow && msSource && msSource.length) {
      usedBuyerMilestones = !!buyerMs;
      const msLabel = (d) => {
        const s = /^(\d{4}-\d{2}-\d{2})/.exec(String(d || ''));
        return s ? new Date(s[1] + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';
      };
      // Safety net for a stale "Delayed" close: authored milestone text can lag
      // reality (a COE slips, then un-slips, but Cowork hasn't rewritten the
      // badge yet). If a closing milestone still reads "Delayed" but the deal's
      // COE is actually today or in the future, show a current state instead so
      // the seller never sees a contradiction. Pacific calendar-day comparison.
      const laToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const dayNum = (s) => Date.UTC(+String(s).slice(0, 4), +String(s).slice(5, 7) - 1, +String(s).slice(8, 10));
      const coeStr = deal.coe_date ? String(deal.coe_date).slice(0, 10) : null;
      const coeDays = coeStr ? Math.round((dayNum(coeStr) - dayNum(laToday)) / 86400000) : null;
      road = msSource.map((m) => {
        const item = {
          date: msLabel(m && m.date),
          label: sanitize((m && m.label) || ''),
          description: sanitize((m && (m.desc || m.description)) || ''),
          status: ['done', 'next', 'upcoming', 'key'].includes(m && m.status) ? m.status : 'upcoming',
          badge: sanitize((m && m.badge) || ''),
          col: (m && m.col) || null
        };
        const isClosing = item.col === 'closing' || /close of escrow|escrow clos|closing/i.test(item.label);
        const looksDelayed = /delay/i.test(item.badge) || /delay/i.test(item.description);
        if (isClosing && looksDelayed && item.status !== 'done' && coeDays != null && coeDays >= 0) {
          item.badge = coeDays === 0 ? 'Closing today' : 'On track';
          if (/delay/i.test(item.description)) {
            const coeLabel = coeStr ? msLabel(coeStr) : '';
            item.description = coeDays === 0
              ? `On track to close today${coeLabel ? ` (${coeLabel})` : ''}.`
              : `On track to close${coeLabel ? ` ${coeLabel}` : ''}.`;
          }
        }
        return item;
      });
    }

    // Next: the curated deal_timeline_items (rich contractual timeline) for a deal
    // that isn't on the milestones model yet. Also suppressed when back on market.
    if (!road.length && !noActiveEscrow) try {
      const { data: tlItems } = await supa
        .from('deal_timeline_items')
        .select('*')
        .eq('deal_id', deal.id).eq('client_visible', true)
        .neq('status', 'na')   // retired escrow artifacts (sync-deals) never render
        .order('sort_order').order('due_date', { ascending: true, nullsFirst: false });
      if (tlItems && tlItems.length) {
        const OWNER_LABEL = { seller: 'your side', buyer: "the buyer's side", escrow: 'escrow', agent: 'Sara', both: 'everyone' };
        const dayLabel = (d) => d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z')
          .toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';
        let nextMarked = false;
        road = tlItems.map((it) => {
          let status = '';
          if (it.status === 'done') status = 'done';
          else if (it.status === 'action') status = 'key';
          else if (!nextMarked && it.status === 'upcoming') { status = 'next'; nextMarked = true; }
          const bits = [];
          if (it.plain)  bits.push(sanitize(it.plain));
          if (it.detail) bits.push(sanitize(it.detail));
          if (it.status === 'done') bits.push('Done.');
          else if (it.status === 'waived') bits.push('Waived — not needed for this sale.');
          else if (it.due_date) bits.push(`Expected ${dayLabel(it.due_date)} — ${OWNER_LABEL[it.owner] || it.owner}.`);
          return {
            date: dayLabel(it.status === 'done' && it.done_at ? it.done_at : it.due_date),
            label: sanitize(it.title),
            description: bits.join(' '),
            status
          };
        });
        timelineTasks = tlItems
          .filter((it) => ['seller', 'both'].includes(it.owner) && ['upcoming', 'action'].includes(it.status))
          .map((it) => ({
            label: sanitize(it.title),
            when: it.status === 'action' ? 'Needs you now' : (it.due_date ? `Due ${dayLabel(it.due_date)}` : 'When ready'),
            status: 'open'
          }));
      }
    } catch (_) { /* table may not exist yet — fall through to the heuristic road */ }

    if (!road.length) {
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
    } // end heuristic fallback

    // Fold agent-shared events (inspections, appraisals, meetings) into the
    // timeline in date order, ahead of the close-of-escrow marker.
    if (sharedEvents.length) {
      sharedEvents.sort((a, b) => a._at - b._at);
      const cleaned = sharedEvents.map(({ _at, ...r }) => r);
      const keyIdx = road.findIndex((r) => r.status === 'key');
      if (keyIdx >= 0) road.splice(keyIdx, 0, ...cleaned);
      else road.push(...cleaned);
    }

    // Colour each road dot by CATEGORY (marketing / paperwork / inspection /
    // money / closing), not just by status. Preferred source is the milestone's
    // At-a-Glance `col`; otherwise we infer it from the label/description text so
    // timeline- and heuristic-sourced roads get colour too. `dotclass` bundles
    // the status + the category so the seller-portal binding engine's
    // data-add-class can drop both classes on the dot in one pass.
    const roadCategory = (r) => {
      const col = String((r && r.col) || '').toLowerCase();
      if (['marketing', 'paperwork', 'inspection', 'money', 'closing'].includes(col)) return col;
      if (['financing', 'finance', 'loan', 'lender'].includes(col)) return 'money';
      if (['escrow', 'title', 'docs', 'contract'].includes(col)) return 'paperwork';
      const t = `${(r && r.label) || ''} ${(r && r.description) || ''}`.toLowerCase();
      if (/close of escrow|escrow clos|\bclosing\b|final walk|record(s|ed|ing)?\b|possession|hand.?over|\bkeys\b/.test(t)) return 'closing';
      if (/loan|financ|lender|underwrit|apprais|fund(s|ing|ed)?\b|deposit|earnest|proceeds|payoff|\bwire\b|down ?payment/.test(t)) return 'money';
      if (/inspection|walk-?through|contingenc|repair|pest|termite|roof|sewer/.test(t)) return 'inspection';
      if (/photo|market|listing|\blist\b|showing|\bmls\b|open house|stag(e|ing)|yard sign/.test(t)) return 'marketing';
      if (/disclosure|document|paperwork|signature|sign(ed|ing)?\b|escrow open|\btitle\b|contract|addend|amend|counter/.test(t)) return 'paperwork';
      return 'milestone';
    };
    road = road.map((r) => {
      const category = roadCategory(r);
      const dotclass = `${r && r.status ? r.status + ' ' : ''}cat-${category}`;
      return { ...r, category, dotclass };
    });

    // What I need from you. Preferred: the deal's curated clientTasks[] (v1.5,
    // from deals.json) — the real to-do list, so a deal with genuine tasks no
    // longer shows the empty state just because no doc is owed. Fall back to the
    // owed-docs + timeline derivation when clientTasks isn't present.
    const mapTask = (t) => ({
      label:  sanitize((t && t.label) || ''),
      when:   sanitize((t && t.when) || 'Open'),
      status: (t && t.status === 'done') ? 'done' : 'open'
    });
    let tasks;
    if (isBuyerSide) {
      // A BUYER never sees the seller's to-do list — deal.client_tasks are written
      // from the seller's seat ("watch for the buyer's inspection", "review the
      // seller net sheet"). Use Cowork's buyer-authored tasks (deal.buyer_tasks)
      // when present; otherwise show nothing but the friendly empty state. We also
      // skip the owed-docs derivation, since those are the seller's documents.
      const bt = Array.isArray(deal.buyer_tasks) ? deal.buyer_tasks : [];
      tasks = bt.map(mapTask).filter((t) => t.label).concat(sharedTasks);
    } else if (Array.isArray(deal.client_tasks) && deal.client_tasks.length) {
      tasks = deal.client_tasks.map(mapTask).filter((t) => t.label).concat(sharedTasks);
    } else {
      tasks = (timelineTasks || [])
        .concat(docs
          .filter((d) => d.status === 'to_sign' || d.status === 'with_seller' || d.status === 'pending')
          .map((d) => ({ label: `Sign ${d.name}`, when: DOC_STATUS_LABEL[d.status] || 'Open', status: 'open' })))
        .concat(sharedTasks);
    }
    // Agent-managed completion (db/040): a task whose label the agent ticked on
    // the portal is 'done'. Completed tasks drop off the main "What I need from
    // you" list for EVERYONE — a done ask should never read as still-open. The
    // agent additionally gets them in a separate, collapsed "Completed" list so a
    // mistaken tick can be undone; the client gets none.
    const doneSet = new Set(Array.isArray(deal.client_task_done) ? deal.client_task_done : []);
    tasks = tasks.map((t) => doneSet.has(t.label) ? { ...t, status: 'done' } : t);
    const tasksDone = showAgent ? tasks.filter((t) => t.status === 'done') : [];
    tasks = tasks.filter((t) => t.status !== 'done');

    // "What I need from you" copy is side-aware: the intro and the empty-state
    // line both read from the viewer's seat (buyer vs seller), so a buyer never
    // sees seller-flavoured phrasing like "needs your signature" on a listing.
    const tasksIntro = isBuyerSide
      ? 'Anything I need from you during your purchase shows up here. I’ll text you too, so nothing slips through.'
      : 'I only reach out when something genuinely needs your signature. Those requests land right here — and I’ll text you too.';
    const tasksEmpty = tasks.length ? '' : (isBuyerSide
      ? 'Nothing needed from you right now. I’m on the next steps and will reach out the moment something needs you.'
      : 'Nothing needs your signature right now. I’ll post anything the moment it comes up.');

    // "Good to know" — titled context bullets shown alongside the agent note
    // (v1.5, from deals.json goodToKnow[]). These are authored from the SELLER's
    // seat ("Sara represents you as the seller", "Sara is lining up a backup"), so
    // a BUYER must never see them verbatim. A buyer reads Cowork's buyer-authored
    // buyer_good_to_know (db/072) when present; otherwise the section is simply
    // empty for the buyer — never the seller's bullets.
    const gtkSource = isBuyerSide
      ? (Array.isArray(deal.buyer_good_to_know) ? deal.buyer_good_to_know : [])
      : (Array.isArray(deal.good_to_know) ? deal.good_to_know : []);
    const goodToKnow = gtkSource
      .map((g) => ({ title: sanitize((g && g.title) || ''), body: sanitize((g && g.body) || '') }))
      .filter((g) => g.title || g.body);

    // Agent identity (real contact info) — fetched up front so the team block
    // carries the agent's email + phone. Fail-soft to sensible defaults.
    // The VIEWER's agent: on a both-sided in-house deal (side 'both') deal.agent
    // is the LISTING agent; the OTHER Legacy agent represents the buyer, so a
    // buyer viewer sees their own agent (James), their note, and their contact.
    const agentKey = (isBuyerSide && deal.side === 'both')
      ? (deal.agent === 'james' ? 'sara' : 'james')
      : (deal.agent || 'sara');
    let agentRow = null;
    try {
      const { data } = await supa.from('agents').select('name, phone, email, title, dre_number').eq('agent_key', agentKey).maybeSingle();
      agentRow = data || null;
    } catch (_) { /* agents table optional */ }
    const agentName  = agentRow?.name  || (agentKey === 'james' ? 'James Beyersdorf' : 'Sara Cooper');
    const agentFirst = (agentName.split(' ')[0]) || 'Sara';
    const agentPhone = agentRow?.phone || (agentKey === 'james' ? '209-770-7523' : '209-559-4966');
    const agentEmail = agentRow?.email || (agentKey === 'james' ? 'JamesSellsCalifornia@gmail.com' : 'SaraSellsCalifornia@gmail.com');

    // Team — one distinct-colored box per member, each reachable in one tap. The
    // agent ALWAYS carries email + phone; escrow / co-agent / lender show whatever
    // the deal stores. Cowork fills structured contact fields from email comms
    // (see BRIEFING §1c); we ALSO parse an email / order-# out of the older
    // free-text strings so existing deals render fully without waiting on a re-sync.
    const telHref = (p) => p ? 'tel:' + String(p).replace(/[^\d+]/g, '') : '';
    const firstEmail = (s) => { const m = /[\w.+-]+@[\w-]+\.[\w.-]+\.\w+|[\w.+-]+@[\w-]+\.\w+/.exec(String(s || '')); return m ? m[0] : ''; };
    const firstOrderNo = (s) => { const m = /(?:order|file|escrow)\s*#?\s*([A-Za-z]{0,3}-?\d[\w-]{3,})/i.exec(String(s || '')); return m ? m[1].replace(/^-+/, '') : ''; };
    // A clean display name from a blob: keep the part before the first separator
    // ( "(", "/", ",", "—", " - " ) so a box shows "Kelly Haakma", not the whole note.
    const cleanName = (s) => sanitize(String(s || '').split(/\s+[–—-]\s+|[(/,]/)[0]).trim();

    const teamMember = (m) => {
      const email = sanitize(m.email || '');
      const phone = sanitize(m.phone || '');
      const nm = sanitize(m.name || '');
      return {
        name: nm, sub: m.sub || '', accent: m.accent || '#4a7a55',
        initial: (nm.trim().charAt(0) || '·').toUpperCase(),
        phone, email,
        phone_href: telHref(phone), email_href: email ? 'mailto:' + email : '',
        file_no: m.file_no ? ('Escrow #' + sanitize(String(m.file_no)).replace(/^Escrow\s*#?\s*/i, '')) : ''
      };
    };
    // Escrow / co-agent / lender contact details come from the deal's `contacts`.
    const ct = (deal.contacts && typeof deal.contacts === 'object' && !Array.isArray(deal.contacts)) ? deal.contacts : {};
    const lm = (deal.listing_meta && typeof deal.listing_meta === 'object' && !Array.isArray(deal.listing_meta)) ? deal.listing_meta : {};

    const team = [];
    team.push(teamMember({
      name: agentName,
      sub: (agentRow?.title || (agentKey === 'james' ? 'Agent' : 'Broker-Owner')) + ' · Legacy',
      accent: '#4a7a55',                                   // green — your agent
      phone: agentPhone, email: agentEmail
    }));

    // The counterparty team — the other side's agent, escrow/title, and lender —
    // only exists while a deal is genuinely in an active transaction. On a
    // listing, a deal in preparation, or a cancelled/closed deal there is no live
    // counterparty, so none of these render even if a stale contact string still
    // lingers in the data. This is an agency-representation statement, not a
    // label: never show a buyer's-side agent on a deal with no live buyer
    // (Cowork flag 2026-08-16 — 324 Augusta cancelled but still listed James as
    // the buyer's agent). The escrow-history section carries any past record.
    const hasCounterparty = inEscrow || deal.stage === 'offer';

    const escrowRaw = ct.escrow || deal.escrow_officer;
    if (hasCounterparty && escrowRaw) {
      const house = ct.escrowCompany || ct.title || deal.title_company;
      const fileNo = ct.escrowNumber || firstOrderNo(escrowRaw) || firstOrderNo(deal.escrow_officer) || lm.preEscrow || '';
      team.push(teamMember({
        name: cleanName(escrowRaw) || 'Escrow / Title',
        sub: (house ? cleanName(house) + ' · ' : '') + 'Escrow / Title',
        accent: '#b26a1f',                                 // amber — escrow / title
        phone: ct.escrowPhone, email: ct.escrowEmail || firstEmail(escrowRaw),
        file_no: fileNo
      }));
    }

    // The OTHER side's agent. Labelled from the viewer's seat — a seller sees the
    // buyer's-side agent, a buyer sees the listing-side agent. Skipped when it
    // resolves to the viewer's own agent (on a both-sided in-house deal the
    // co-agent field holds the other Legacy agent, already shown above).
    const coRaw = ct.coAgent || deal.co_agent;
    const coClean = cleanName(coRaw);
    if (hasCounterparty && coRaw && normName(coClean) !== normName(agentName)) {
      team.push(teamMember({
        name: coClean || (isBuyerSide ? 'Listing agent' : "Buyer's agent"),
        sub: (ct.coAgentCompany ? cleanName(ct.coAgentCompany) + ' · ' : '') + (isBuyerSide ? 'Listing side' : "Buyer's side"),
        accent: '#597ea3',                                 // blue — the other side
        phone: ct.coAgentPhone, email: ct.coAgentEmail || firstEmail(coRaw)
      }));
    }

    const lenderRaw = ct.lender;
    if (hasCounterparty && lenderRaw) {
      team.push(teamMember({
        name: cleanName(lenderRaw) || 'Lender',
        sub: (ct.lenderCompany ? cleanName(ct.lenderCompany) + ' · ' : '') + 'Lender',
        accent: '#6b5a86',                                 // purple — lender
        phone: ct.lenderPhone, email: ct.lenderEmail || firstEmail(lenderRaw)
      }));
    }

    const documentsArr = docs.map((d) => {
      const raw = (d.doc_url && /^(https?:\/\/|\/docs\/)/i.test(d.doc_url)) ? d.doc_url : '';
      return {
        type: (d.doc_type || '').toUpperCase().slice(0, 6),
        cat: docCategory(d.doc_type, d.name),   // colour class for the type badge
        name: sanitize(d.name), sub: sanitize(d.sub || ''),
        status: d.status ? (DOC_STATUS_LABEL[d.status] || 'On file') : '',   // optional — blank for flat drops
        view_url:       raw ? portalDocUrl(raw, false) : '',   // same-origin /docs or Dropbox dl=0
        download_url:   raw ? portalDocUrl(raw, true)  : '',   // same-origin /docs or Dropbox dl=1
        view_label:     raw ? 'View' : '',            // data-optional anchors hide when empty
        download_label: raw ? 'Download ↓' : ''
      };
    });

    // (Agent identity — agentName / agentFirst / agentPhone / agentEmail — was
    // resolved above with the team block.)

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

    // A PUBLISHED agent note (deals.json agentNote, author-attributed) is the
    // exact words the agent signed off on — it overrides the auto-note. Draft /
    // approved notes stay agent-only (never shown to the client) until published,
    // so the client only ever sees copy an agent has explicitly released.
    const anote = deal.agent_note;
    const notePublished = !!(anote && anote.status === 'published' && typeof anote.body === 'string' && anote.body.trim());
    if (notePublished) noteBody = anote.body.trim();

    // Standing wire-fraud warning — shown ONLY to in-escrow clients (the reason
    // the private-link model exists). Never on a listing that isn't in escrow.
    const security = {
      banner: inEscrow
        ? 'We will never send wire instructions through this portal, by email, or by text. Before wiring funds, always call the title company directly at a phone number you have independently verified.'
        : ''
    };

    // 4b. Escrow history (Slice 2) -----------------------------------------
    // A property can carry cancelled/closed escrows plus (maybe) an active one.
    // With NO active escrow, a seller listing says "back on market" plainly
    // instead of showing silence or a stale timeline. Prior escrows are exposed
    // as collapsed history. Fail-soft: pre-055 (no table) → no history/banner.
    let escrowHistory = [];
    let backOnMarket = null;
    try {
      const list = escrowRows;   // fetched once above (reused, not refetched)
      const activeEsc = activeEscrow;
      escrowHistory = list.filter((e) => e.status !== 'active').map((e) => ({
        label: sanitize(e.label || 'Escrow'),
        status: e.status,
        buyer: sanitize(e.buyer_name || ''),
        when: e.cancelled_at ? `Cancelled ${fmtDateY(asDate(e.cancelled_at))}`
            : e.closed_at    ? `Closed ${fmtDateY(asDate(e.closed_at))}`
            : (e.status === 'cancelled' ? 'Cancelled' : e.status === 'closed' ? 'Closed' : ''),
        // The escrow's own transaction documents the viewer may see — kept out of
        // the live list, surfaced here as the escrow's record (SPEC: prior escrows
        // expandable to their documents). Buyers never reach this section.
        documents: allDocs
          .filter((doc) => doc.escrow_id === e.id && maySee(doc))
          .map((doc) => ({
            name: sanitize(doc.name || 'Document'),
            view_url: doc.doc_url || '',
            view_label: doc.doc_url ? 'View' : ''
          }))
      }));
      if (!activeEsc && list.length && !isBuyerSide && (isListing || isPreparing)) {
        const lastCancel = list
          .filter((e) => e.status === 'cancelled')
          .sort((a, b) => String(b.cancelled_at || '').localeCompare(String(a.cancelled_at || '')))[0];
        const when = lastCancel && lastCancel.cancelled_at ? fmtDateY(asDate(lastCancel.cancelled_at)) : null;
        backOnMarket = {
          headline: 'Back on market',
          body: when
            ? `Escrow with the previous buyer was cancelled ${when}. Your disclosures remain on file and will be provided to the next buyer.`
            : 'This listing is back on the market. Your disclosures remain on file and will be provided to the next buyer.'
        };
      }
    } catch (_) { /* pre-055 — no escrow records → no history/banner (safe) */ }

    // Weekly ListTrac marketing digest (db/067). Cowork parses the ListTrac
    // "Online Activity" email into deals.marketing_stats; we sanitize + coerce it
    // into a display-safe shape. Listing-only — a buy-side deal has no listing
    // marketing, so it's suppressed (the front-end also hides the panel).
    const ms = (deal.marketing_stats && typeof deal.marketing_stats === 'object' && !Array.isArray(deal.marketing_stats)) ? deal.marketing_stats : null;
    let marketing = null;
    if (ms && !isBuyerSide) {
      const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
      const str = (v) => (typeof v === 'string' ? sanitize(v).slice(0, 160) : null);
      const sites = Array.isArray(ms.top_sites) ? ms.top_sites.slice(0, 10)
        .map((s) => ({ name: str(s && s.name), views: num(s && s.views) || 0, inquiries: num(s && s.inquiries) || 0 }))
        .filter((s) => s.name) : [];
      const cities = Array.isArray(ms.top_cities) ? ms.top_cities.slice(0, 10)
        .map((c) => ({ name: str(c && c.name), views: num(c && c.views) || 0 }))
        .filter((c) => c.name) : [];
      const callouts = Array.isArray(ms.callouts) ? ms.callouts.map(str).filter(Boolean).slice(0, 4) : [];
      const views = num(ms.views), shares = num(ms.shares), inquiries = num(ms.inquiries);
      if (views != null || shares != null || inquiries != null || sites.length || cities.length || callouts.length) {
        marketing = {
          period: str(ms.period), report_date: str(ms.report_date),
          views, shares, inquiries, callouts, top_sites: sites, top_cities: cities
        };
      }
    }
    const videoViews = Number.isFinite(+deal.video_views) ? +deal.video_views : null;

    // ListTrac / MetroList weekly seller report (deals.json v8.1, carried in
    // listing_meta). A compact "your listing is getting seen" card shown at the
    // top of the seller portal, beside the tour. Listing-side only — a buyer has
    // no listing to report on, so it's suppressed for a buyer viewer.
    const lt = (lm.listTrac && typeof lm.listTrac === 'object' && !Array.isArray(lm.listTrac)) ? lm.listTrac : null;
    let listTrac = null;
    if (lt && !isBuyerSide) {
      const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
      const s = (v) => (typeof v === 'string' ? sanitize(v).slice(0, 220) : null);
      const views = n(lt.views), last30 = n(lt.last30), shares = n(lt.shares),
            inquiries = n(lt.inquiries), favorites = n(lt.favorites), newPct = n(lt.newPct);
      if (views != null || last30 != null || shares != null || inquiries != null || favorites != null) {
        listTrac = {
          views, last30, shares, inquiries, favorites, new_pct: newPct,
          since: s(lt.since), note: s(lt.note),
          report_date: s(lt.reportDate), source: s(lt.source) || 'ListTrac · MetroList weekly report'
        };
      }
    }

    // The seller milestones are authored from the SELLER's seat. For a buyer
    // viewer we re-frame them (drop listing-only steps, flip perspective) — UNLESS
    // Cowork already gave us buyer-authored milestones (db/070), which are correct
    // as written.
    if (isBuyerSide && !usedBuyerMilestones) road = buyerizeRoad(road);

    // 5. Assemble -----------------------------------------------------------
    const portal = {
      security,
      // 0-or-1 array so the front-end data-list hides the whole section when absent.
      back_on_market: backOnMarket ? [backOnMarket] : [],
      // Prior escrows are the SELLER's listing history (a cancelled buyer, etc.) —
      // never shown to a buyer, who only has their own purchase.
      escrow_history: isBuyerSide ? [] : escrowHistory,
      seller: { first_name: firstName || '', who: sanitize(deal.address) },
      status: {
        label: stageLabel,
        badge: stageLabel,
        // Product label in the top bar + document title, side-aware so a buyer
        // never sees "Seller portal".
        product_label: isBuyerSide ? 'Buyer portal' : 'Seller portal',
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
        video_url:      effVideoUrl || null,
        video_id:       videoId,
        matterport_url: effMatterportUrl || null,
        video_views:    videoViews,
        showcase_url:   (effShowcaseUrl && !isBuyerSide) ? effShowcaseUrl : null,
        reel_url:       (effReelUrl && !isBuyerSide) ? effReelUrl : null
      },
      // Weekly ListTrac marketing digest (null when there's nothing to show).
      marketing,
      // Compact ListTrac headline stats card shown at the top, beside the tour.
      list_trac: listTrac,
      // Showings for the seller: who toured the home + an auto-count per agent.
      // Empty for a buyer (portal_items scopes showings to the seller side).
      showings: isBuyerSide ? [] : showings,
      nav: { documents: docs.length ? String(docs.length) : '', tasks: String(tasks.length) },
      // Side-aware "What I need from you" copy (buyer vs seller seat).
      tasks_intro: tasksIntro,
      tasks_empty: tasksEmpty,
      // Shown in the Documents section only when there are none, so the section
      // never sits empty or implies a fixed checklist.
      documents_empty: docs.length ? '' : 'No documents have been shared here yet — they’ll appear as your file comes together.',
      kpis, road, documents: documentsArr, tasks, team,
      good_to_know: goodToKnow,
      // Agent-preview affordances (db/040): only an agent viewing gets the
      // tickable checkboxes + the private note-for-Cowork; the client never does.
      viewer_is_agent: !!showAgent,
      // Buy-side transactions have no listing marketing — the front-end hides
      // the "campaign" recap when this is true.
      is_buyer: isBuyerSide,
      source_key: deal.source_key || null,
      seller_note: showAgent ? (deal.portal_seller_note || null) : null,
      tasks_done: tasksDone,
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

// Re-frame the seller-authored road for a BUYER. The milestones live in
// deals.json written from the seller's seat ("Listed at…", "Offer received",
// "Your home went on the market"). For a buyer we (1) drop listing-only steps,
// (2) relabel the offer/acceptance steps to their point of view, and (3) swap the
// seller-facing phrasing in the descriptions. Heuristic but safe — it only ever
// softens perspective wording, never invents facts.
function buyerizeRoad(road) {
  if (!Array.isArray(road)) return road;
  const amt = (s) => { const m = String(s || '').match(/\$[\d,]+/); return m ? m[0] : ''; };
  const cap = (s) => { s = String(s || '').trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; };
  const flip = (s) => String(s || '')
    .replace(/\byour home\b/gi, 'the home')
    .replace(/\byour listing\b/gi, 'the home')
    // Conjugate "the buyer <verb>" → "you <verb>" BEFORE the bare-noun swap, so we
    // never produce ungrammatical "you has" / "you is".
    .replace(/\bthe buyer has\b/gi, 'you have')
    .replace(/\bthe buyer is\b/gi, 'you are')
    .replace(/\bthe buyer was\b/gi, 'you were')
    .replace(/\bthe buyer does\b/gi, 'you do')
    .replace(/\bthe buyer needs\b/gi, 'you need')
    .replace(/\bthe buyer gets\b/gi, 'you get')
    .replace(/\bthe buyer will\b/gi, 'you will')
    .replace(/\bthe buyer countered\b/gi, 'you countered')
    .replace(/\bbuyer countered\b/gi, 'you countered')
    .replace(/\ban offer came in\b/gi, 'you made an offer')
    .replace(/\boffer received\b/gi, 'your offer')
    .replace(/\btheir highest and best\b/gi, 'your highest and best')
    .replace(/\bbuyer-signed\b/gi, 'signed')
    .replace(/\bthe buyer'?s\b/gi, 'your')
    .replace(/\bbuyer'?s\b/gi, 'your')
    .replace(/\bthe buyer\b/gi, 'you');
  // Remove seller closing-prep phrasing a buyer shouldn't see — most importantly
  // the seller's home warranty, which is the seller's cost, not the buyer's.
  const stripSeller = (s) => String(s || '')
    .replace(/,?\s*and\s+(?:the\s+)?home warranty[^.!?]*/gi, '')                 // "..., and the home warranty ... AHS"
    .replace(/(^|[.!?]\s+)[^.!?]*home warranty[^.!?]*[.!?]/gi, '$1')             // a whole sentence about it
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,])/g, '$1')
    .trim();
  const out = [];
  for (const m of road) {
    const label = String(m && m.label || '');
    const desc  = String(m && m.description || '');
    const col   = m && m.col;
    // Drop listing / marketing steps — they're about the seller's listing, not
    // the buyer's purchase.
    const isListingStep = col === 'marketing'
      || /\blisted\b|on the market|went on the market|listing agreement|price (?:drop|reduc)/i.test(label + ' ' + desc);
    if (isListingStep) continue;
    let newLabel;
    if (/contingenc/i.test(label)) {
      // "Buyer's contingency period ends" → the buyer's own contingencies, framed
      // personally.
      newLabel = 'Your contingency period';
    } else if (/\baccepted\b|under contract|mutual|ratified|in escrow/i.test(label)) {
      newLabel = 'Your offer was accepted' + (amt(label) ? ' at ' + amt(label) : '');
    } else if (/offer received|offer came in|an offer came/i.test(label)) {
      newLabel = 'Your offer' + (amt(label) ? ' — ' + amt(label) : '');
    } else {
      newLabel = cap(flip(label));
    }
    out.push({ ...m, label: newLabel, description: cap(stripSeller(flip(desc))) });
  }
  return out;
}

// Colour category for a document's little type badge, from its doc_type + name.
// Grouped so related paperwork shares a hue (contract, title/escrow, money,
// disclosures, inspections, listing). Everything else stays neutral ('doc').
function docCategory(docType, name) {
  const s = (String(docType || '') + ' ' + String(name || '')).toLowerCase();
  if (/\brpa\b|purchase agreement|counter|\boffer\b|addendum|amendment/.test(s)) return 'contract';
  if (/prelim|\btitle\b|escrow|commitment|grant deed|\bdeed\b/.test(s))          return 'title';
  if (/\bemd\b|earnest|deposit|commission|closing statement|settlement|\bhud\b|proceeds/.test(s)) return 'money';
  if (/inspect|\bpest\b|termite|\broof\b|apprais|walk-?through|\breport\b|septic|\bwell\b|sewer|chimney/.test(s)) return 'inspection';
  if (/\btds\b|\bspq\b|disclosur|advisory|\bsbsa\b|\bavid\b|\bnhd\b|\blead\b|firpta|questionnaire|carbon|smoke|water heater/.test(s)) return 'disclosure';
  if (/listing|agreement|modification/.test(s))                                  return 'listing';
  return 'doc';
}

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
    kpis: [], road: [], documents: [], tasks: [], tasks_done: [], team: [], good_to_know: [], activity: [],
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
3. 3-4 short sentences. No salutation line, no signoff (those are added separately). Plain prose.${isBuyerSide ? `
4. This is the BUYER's note. NEVER reference a seller net sheet, the listing, a listing agreement, showings, seller proceeds, or a home warranty — those belong to the seller, not your buyer. Speak only to their purchase: escrow, inspections, appraisal, loan, contingencies, and closing.` : ''}`;
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
