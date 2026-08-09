// api/cron/buyer-matches.js — GET /api/cron/buyer-matches?key=<PUBLISH_SECRET>
//
// The "dynamic organism": for each buyer, quietly find new active listings that
// match their live preferences (their brief STRETCHED toward what they've
// actually favorited) and email a short, personal "I found these for you" note.
// It never repeats a home (listing_alert_sends) and won't email a buyer more
// than once every CADENCE_DAYS.
//
// SAFETY GATES — this stays inert until you have a real listing feed:
//   * BUYER_ALERTS_ENABLED must equal "true" (set it in Vercel once a feed is on)
//   * it refuses to send if properties holds fewer than MIN_FEED active rows
//     (so it can't spam matches out of the sparse saved-only table)
// Configure the feed first (iHomefinder IDX sync or MetroList RESO — see
// idx-sync.js / _metrolist.js), then flip the flag.

import { adminClient } from '../_lib/supabase.js';
import { pickEmailProvider, unsubscribeFooter } from '../_lib/email-html.js';
import { derivePrefs, matchPct, fmtSpecs, reasonFor } from '../_lib/match.js';

const BATCH = 15;          // buyers processed per run
const N = 4;               // homes per email
const THRESHOLD = 70;      // min match % to include
const CADENCE_DAYS = 5;    // don't email the same buyer more often than this
const MIN_FEED = 30;       // won't send unless the active feed is really populated

const AGENTS = {
  sara:  { name: 'Sara Cooper',       title: 'Owner · Broker',  dre_number: '02141987', phone: '(209) 559-4966', first: 'Sara' },
  james: { name: 'James Beyersdorf',  title: 'REALTOR®',   dre_number: null,        phone: '(209) 770-7523', first: 'James' }
};

const money = (n) => (n == null ? '' : '$' + Math.round(n).toLocaleString('en-US'));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function listingUrl(p) {
  const id = p.ihomefinder_idx_id || p.mls_number;
  return id ? `https://legacycalifornia.com/listing.html?id=${encodeURIComponent(id)}` : 'https://legacycalifornia.com/property-search.html';
}

// A warm, branded HTML letter with a photo card per home. Feels hand-picked.
function renderEmail(agent, first, homes, token) {
  const cards = homes.map((h) => {
    const img = h.photo
      ? `<a href="${esc(h.url)}" style="display:block;"><img src="${esc(h.photo)}" alt="" width="536" style="width:100%;max-width:536px;height:auto;border-radius:8px;display:block;"></a>`
      : '';
    const reason = h.reason ? `<div style="font-size:13px;color:#7C6A4D;font-style:italic;margin:2px 0 0;">${esc(h.reason)}</div>` : '';
    return `<div style="margin:0 0 26px;">
      ${img}
      <div style="margin-top:9px;">
        <div style="font-size:18px;color:#1A1714;font-weight:600;">${esc(h.price)}${h.specs ? ` <span style="font-weight:400;color:#4A4136;font-size:14px;">&middot; ${esc(h.specs)}</span>` : ''}</div>
        <div style="font-size:14px;color:#4A4136;">${esc(h.address)}</div>
        ${reason}
        <a href="${esc(h.url)}" style="display:inline-block;margin-top:8px;font-size:12px;font-weight:600;letter-spacing:.04em;color:#8C6E3D;text-decoration:none;">See this one &rarr;</a>
      </div>
    </div>`;
  }).join('');

  const sig = [esc(agent.name), agent.title ? esc(agent.title) : null, agent.dre_number ? `DRE #${esc(agent.dre_number)}` : null, agent.phone ? esc(agent.phone) : null].filter(Boolean).join(' &middot; ');

  const intro = `Hi ${esc(first)}, I keep an eye out for you between our chats &mdash; and a few just came up that feel like your kind of place. Here's what caught my eye:`;
  const outro = `Want to walk through any of these? Just reply to this note and I'll set it up. And if they're not quite it, tell me why &mdash; it helps me hunt.`;

  return `<div style="font-family:Georgia,'Cormorant Garamond',serif;color:#1A1714;max-width:560px;margin:0 auto;padding:32px 28px;background:#FAF6EC;">
    <div style="font-family:'Courier New',monospace;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#7C6A4D;margin-bottom:18px;">Legacy Properties &middot; Homes picked for you</div>
    <p style="font-size:15px;line-height:1.6;color:#3A332B;margin:0 0 20px;">${intro}</p>
    ${cards}
    <p style="font-size:15px;line-height:1.6;color:#3A332B;margin:6px 0 16px;">${outro}</p>
    <hr style="border:none;border-top:1px solid #D9CFB7;margin:18px 0 14px;">
    <p style="font-size:13px;line-height:1.55;color:#7C6A4D;margin:0;">${sig}<br><a href="https://legacycalifornia.com" style="color:#7C6A4D;">legacycalifornia.com</a></p>
    ${unsubscribeFooter(token)}
  </div>`;
}

function renderText(agent, first, homes) {
  const lines = homes.map((h, i) => `${i + 1}. ${h.price}${h.specs ? ' · ' + h.specs : ''}\n   ${h.address}${h.reason ? '\n   ' + h.reason : ''}\n   ${h.url}`).join('\n\n');
  return `Hi ${first}, a few homes just came up that feel like your kind of place:\n\n${lines}\n\nWant to walk through any of these? Just reply and I'll set it up.\n\n— ${agent.first}`;
}

export default async function handler(req, res) {
  if (!process.env.PUBLISH_SECRET || req.query.key !== process.env.PUBLISH_SECRET) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }
  if (process.env.BUYER_ALERTS_ENABLED !== 'true') {
    return res.status(200).json({ success: true, disabled: true, note: 'set BUYER_ALERTS_ENABLED=true once a listing feed is configured' });
  }
  const supa = adminClient();
  const provider = pickEmailProvider();
  if (!provider) return res.status(200).json({ success: true, note: 'no email provider configured' });

  // Candidate universe: active listings. Refuse to run on a sparse table.
  const { data: actives } = await supa.from('properties')
    .select('id, mls_number, ihomefinder_idx_id, address, city, price, bedrooms, bathrooms, sq_ft, lot_acres, photos, created_at')
    .eq('status', 'active').limit(1000);
  const universe = actives || [];
  if (universe.length < MIN_FEED) {
    return res.status(200).json({ success: true, note: `listing feed not populated yet (${universe.length} active) — no alerts sent` });
  }

  // Buyers due for an alert.
  const cutoff = new Date(Date.now() - CADENCE_DAYS * 86400000).toISOString();
  const { data: leads } = await supa.from('leads')
    .select('id, first_name, email, price_min, price_max, areas, must_haves, lead_type, assigned_agent, unsubscribe_token, last_match_alert_at')
    .in('lead_type', ['buyer', 'both', 'land', 'relocation'])
    .eq('status', 'active').eq('email_opt_out', false).eq('not_interested', false)
    .not('email', 'is', null)
    .or(`last_match_alert_at.is.null,last_match_alert_at.lt.${cutoff}`)
    .order('last_match_alert_at', { ascending: true, nullsFirst: true })
    .limit(BATCH);

  let emailed = 0, homesSent = 0, skippedNoMatch = 0;

  for (const lead of (leads || [])) {
    // Their favorites + already-alerted homes.
    const [{ data: savedRows }, { data: alerted }] = await Promise.all([
      supa.from('saved_properties').select('property_id, properties(*)').eq('lead_id', lead.id),
      supa.from('listing_alert_sends').select('property_id').eq('lead_id', lead.id)
    ]);
    const savedIds = new Set((savedRows || []).map((r) => r.property_id));
    const alertedIds = new Set((alerted || []).map((r) => r.property_id));

    const prefs = derivePrefs(lead, savedRows);
    const picks = universe
      .filter((p) => !savedIds.has(p.id) && !alertedIds.has(p.id) && p.price)
      .map((p) => ({ p, pct: matchPct(prefs, p) }))
      .filter((x) => x.pct >= THRESHOLD)
      .sort((a, b) => b.pct - a.pct)
      .slice(0, N);

    if (!picks.length) { skippedNoMatch++; continue; }

    const agentKey = lead.assigned_agent === 'james' ? 'james' : 'sara';
    const agent = AGENTS[agentKey];
    const first = lead.first_name || 'there';
    const homes = picks.map(({ p }) => ({
      price: money(p.price), specs: fmtSpecs(p),
      address: [p.address, p.city].filter(Boolean).join(', '),
      photo: (p.photos && p.photos[0]) || null,
      reason: reasonFor(prefs, p), url: listingUrl(p)
    }));

    try {
      const r = await provider.send({
        agent: agentKey, to: lead.email, toName: lead.first_name || null,
        subject: `${first}, ${homes.length} home${homes.length === 1 ? '' : 's'} I think you'll love`,
        text: renderText(agent, first, homes),
        html: renderEmail(agent, first, homes, lead.unsubscribe_token)
      });
      if (r && r.skipped) continue;
      // Record so we never repeat these homes; stamp cadence.
      const rows = picks.map(({ p }) => ({ lead_id: lead.id, property_id: p.id }));
      await supa.from('listing_alert_sends').upsert(rows, { onConflict: 'lead_id,property_id' }).then(() => {}, () => {});
      await supa.from('leads').update({ last_match_alert_at: new Date().toISOString(), last_contact_at: new Date().toISOString() }).eq('id', lead.id).then(() => {}, () => {});
      emailed++; homesSent += homes.length;
    } catch (_) { /* next buyer */ }
  }

  return res.status(200).json({ success: true, emailed, homesSent, skippedNoMatch, considered: (leads || []).length });
}
