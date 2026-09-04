// api/_lib/handlers/crm-roster.js
// GET /api/crm/roster?bucket=leads|clients|past|sphere|all&q=&limit=
// Browsable people lists behind the sidebar roster items.
//
// Buckets are decided in code (not a SQL WHERE) so that:
//   • a contact lands in exactly ONE browse bucket (no leak — e.g. a closed
//     client never also shows under Leads), and
//   • a NULL contact_type / mixed stage value can never accidentally hide
//     someone. The old handler filtered Leads on status=active with no stage
//     filter (so clients showed under Leads) and required status=active for
//     Clients (so closed clients, often archived, vanished from Clients).
//
// bucket=all is a separate typeahead mode for contact-tagging: no bucket at all,
// requires a search term, searches everyone (any status/stage) at the DB level.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail } from '../cors.js';

const COLS = 'id, first_name, last_name, email, phone, temperature, score, lead_type, contact_type, pipeline_stage, journey_stage, buyer_stage, seller_stage, status, last_contact_at, created_at, source';

// A contact is a CLIENT once they're under contract or have closed — read from
// the coarse pipeline_stage OR either side stage (in case one wasn't rolled up).
const CLIENT_STAGES = new Set(['signed', 'active', 'under_contract', 'offer', 'closed', 'close']);
const CLIENT_SIDE   = new Set(['in_escrow', 'closed']);

// Exactly one browse bucket per contact ('' = shown in none of the four lists).
function classify(l) {
  const ct = l.contact_type, ps = l.pipeline_stage, status = l.status;
  if (status === 'do_not_contact' || ct === 'do_not_call' || ct === 'do_not_contact') return '';
  // A title rep or another agent is a working contact, not a lead and not
  // sphere — before 'vendor' existed they could only be filed as sphere, which
  // put them in marketing lists. Shown in none of the four browse buckets.
  if (ct === 'vendor') return '';
  if (ct === 'past_client') return 'past';
  if (ct === 'sphere' || ps === 'sphere') return 'sphere';
  if (ct === 'closed' || CLIENT_STAGES.has(ps) || CLIENT_SIDE.has(l.buyer_stage) || CLIENT_SIDE.has(l.seller_stage)) return 'clients';
  if (status === 'archived') return '';   // archived, not a client → dormant, not browsed
  return 'leads';                          // active and still in the funnel
}

const shape = (l) => ({
  id: l.id,
  name: [l.first_name, l.last_name].filter(Boolean).join(' ') || l.email || '(no name)',
  email: l.email, phone: l.phone,
  temperature: l.temperature, score: l.score,
  side: l.contact_type || '',   // buyer/seller/both/past_client/sphere/do_not_contact — for the inline roster side picker
  stage: l.pipeline_stage, journey: l.journey_stage, type: l.lead_type,
  last_contact_at: l.last_contact_at, source: l.source
});

const byRecency = (a, b) => {
  const at = a.last_contact_at ? Date.parse(a.last_contact_at) : 0;
  const bt = b.last_contact_at ? Date.parse(b.last_contact_at) : 0;
  if (bt !== at) return bt - at;
  return (b.created_at ? Date.parse(b.created_at) : 0) - (a.created_at ? Date.parse(a.created_at) : 0);
};

// Page through the ENTIRE leads book. Each page requests <= PostgREST max-rows so
// the server never truncates a page; stop on a short page. Ordered by id for a
// stable scan. 20-page (20k) runaway guard, far above a boutique book.
async function fetchAllLeads(supa, cols) {
  const PAGE = 1000;
  const all = [];
  for (let page = 0; page < 20; page++) {
    const from = page * PAGE;
    const { data, error } = await supa
      .from('leads').select(cols)
      .order('id', { ascending: true }).range(from, from + PAGE - 1);
    if (error) return { data: null, error };
    all.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return { data: all, error: null };
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');
  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');
  const supa = adminClient();

  try {
    const bucket = ['leads', 'clients', 'past', 'sphere', 'all'].includes(req.query?.bucket) ? req.query.bucket : 'leads';
    const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 200, 1), 500);
    const term = (req.query?.q || '').toString().trim();

    // ---- typeahead mode: search everyone, DB-side, needs a term ------------
    if (bucket === 'all') {
      if (term.length < 2) return ok(res, { bucket, count: 0, people: [] });
      let q = supa.from('leads').select(COLS, { count: 'exact' });
      const t = term.replace(/[%(),]/g, ' ').trim();
      if (t) {
        const clauses = [`first_name.ilike.%${t}%`, `last_name.ilike.%${t}%`, `email.ilike.%${t}%`, `phone.ilike.%${t}%`];
        const words = t.split(/\s+/).filter(Boolean);
        if (words.length > 1) {
          const w1 = words[0], w2 = words.slice(1).join(' ');
          clauses.push(`and(first_name.ilike.%${w1}%,last_name.ilike.%${w2}%)`);
          clauses.push(`and(first_name.ilike.%${w2}%,last_name.ilike.%${w1}%)`);
        }
        q = q.or(clauses.join(','));
      }
      const { data, error, count } = await q.order('last_contact_at', { ascending: false, nullsFirst: false }).limit(limit);
      if (error) return fail(res, 500, error.message);
      return ok(res, { bucket, count: count || 0, people: (data || []).map(shape) });
    }

    // ---- browse buckets: classify the whole book in code ------------------
    // Pull the roster once and bucket in JS so null contact_type / mixed stage
    // values can't hide anyone. Page through EVERYTHING — a plain .select() is
    // capped by PostgREST's max-rows (1000 default) and the old .limit(3000) still
    // truncated a book past 3000, silently dropping the tail (newest contacts,
    // manual adds) from every browse list.
    const { data, error } = await fetchAllLeads(supa, COLS);
    if (error) return fail(res, 500, error.message);

    // Count every browse bucket in ONE pass over the full book, so the sidebar
    // pills can be primed all at once and stay consistent no matter which bucket
    // is open. These are unfiltered totals (independent of any search term) —
    // exactly what each list shows when opened without a query.
    const counts = { leads: 0, clients: 0, past: 0, sphere: 0 };
    for (const l of (data || [])) { const b = classify(l); if (counts[b] != null) counts[b]++; }

    let people = (data || []).filter((l) => classify(l) === bucket);

    if (term) {
      const t = term.toLowerCase();
      people = people.filter((l) => {
        const name = [l.first_name, l.last_name].filter(Boolean).join(' ').toLowerCase();
        return name.includes(t) || (l.email || '').toLowerCase().includes(t) || (l.phone || '').toLowerCase().includes(t);
      });
    }

    people.sort(byRecency);
    const count = people.length;
    return ok(res, { bucket, count, counts, people: people.slice(0, limit).map(shape) });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
