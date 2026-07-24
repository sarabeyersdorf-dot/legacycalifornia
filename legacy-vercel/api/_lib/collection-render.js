// api/_lib/collection-render.js
// Single source of truth for BOTH what a client SEES (the collection page
// payload) and what a client is SENT (the push SMS/email). The live send path
// (api/c/[token].js, curate-push.js) and the agent preview (curate-preview.js)
// all import from here, so an agent's preview can never drift from reality.

import { shapeListing } from './handlers/curate-search.js';

export const BROKERAGE = { name: 'Legacy Properties', broker: 'Sara Cooper', broker_title: 'Broker-Owner', broker_dre: '02141987' };
// The share links in outgoing SMS/email are built from this. It MUST be a
// domain this app actually serves — legacycalifornia.com is not connected to
// the Vercel project (client links there 404), so default to the production
// .vercel.app domain and let PUBLIC_SITE_URL take over when a custom domain
// is wired up.
export const SITE = (process.env.PUBLIC_SITE_URL || 'https://legacycalifornia.vercel.app').replace(/\/+$/, '');

export function disclaimer(agentName, dre) {
  const who = dre ? `${agentName}, DRE #${dre}` : agentName;
  return `Listing information is deemed reliable but not guaranteed. Any price range, valuation, or opinion provided here is preliminary. ${who} must personally view a property to provide a truly accurate listing or valuation price range. ${BROKERAGE.name} | ${BROKERAGE.broker}, ${BROKERAGE.broker_title} | DRE #${BROKERAGE.broker_dre}`;
}

export async function agentIdentity(supa, agentKey) {
  const { data } = await supa.from('agents').select('name, title, dre_number, phone, email, photo_url').eq('agent_key', agentKey).maybeSingle();
  return data || { name: agentKey === 'james' ? 'James Beyersdorf' : 'Sara Cooper', title: 'Agent', dre_number: null, phone: null, email: null, photo_url: null };
}

// The exact payload the client page renders. `coll` must already include a
// `leads(first_name)` join. Returns `_agent` for callers that need phone/dre;
// strip it before sending to an anonymous client.
export async function buildClientPayload(supa, coll) {
  const agent = await agentIdentity(supa, coll.agent);

  const { data: cls } = await supa
    .from('collection_listings')
    .select('*, properties(*)')
    .eq('collection_id', coll.id).eq('included', true)
    .order('priority', { ascending: false })
    .order('sort_order', { ascending: true });

  const listings = (cls || [])
    .filter((row) => row.properties)
    .map((row) => ({
      ...shapeListing(row.properties),
      agent_note: row.agent_note || '',
      note_style: row.note_style || 'sticky',
      why_note: row.why_note || '',
      priority: !!row.priority
    }));

  return {
    collection: {
      title: coll.title || '', intro_note: coll.intro_note || '', closing_note: coll.closing_note || '',
      // Per-listing commute readout, when the agent turned it on and set a
      // destination (the client's work/school address).
      show_commute: (coll.show_commute === true) && !!(coll.commute_dest && String(coll.commute_dest).trim()),
      commute_dest: coll.commute_dest || ''
    },
    client: { first_name: coll.leads?.first_name || '' },
    agent: { name: agent.name, title: agent.title, dre_number: agent.dre_number, phone: agent.phone, email: agent.email, photo_url: agent.photo_url },
    brokerage: BROKERAGE,
    disclaimer: disclaimer(agent.name, agent.dre_number),
    listings,
    valuation: { enabled: true },
    _agent: agent
  };
}

function escapeHtml(s) { return (s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

export function emailHtml({ firstName, agentName, dre, phone, link, intro, listings = [], collectionTitle = '' }) {
  const INK = '#1A1714', PAPER = '#FAF6EC', PAGE = '#EFE7D6', GOLD = '#B08D57', TAUPE = '#7C6A4D', RULE = '#DDD3BC', MAROON = '#5A0E24', CREAM = '#F4E6C8';
  const label = "'Helvetica Neue',Helvetica,Arial,sans-serif";
  const sans  = "'Helvetica Neue',Helvetica,Arial,sans-serif";
  const serif = "Georgia,'Times New Roman',serif";

  const shown = (listings || []).filter((l) => l && (l.address || l.price_label)).slice(0, 3);
  const more = Math.max(0, (listings || []).length - shown.length);

  const meta = (l) => [
    l.beds != null ? `${l.beds} bd` : null,
    l.baths != null ? `${l.baths} ba` : null,
    l.sqft ? `${Number(l.sqft).toLocaleString('en-US')} sqft` : null
  ].filter(Boolean).join(' &nbsp;·&nbsp; ');

  const card = (l) => `
      <tr><td style="padding:0 0 10px;">
        <a href="${link}" style="text-decoration:none;color:${INK};">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1px solid ${RULE};border-radius:3px;">
            ${l.photo ? `<tr><td><img src="${l.photo}" width="544" alt="${escapeHtml(l.address || 'Listing photo')}" style="display:block;width:100%;max-height:300px;object-fit:cover;border-radius:3px 3px 0 0;"></td></tr>` : ''}
            <tr><td style="padding:14px 18px 4px;font-family:${serif};font-size:23px;font-weight:bold;color:${INK};">${escapeHtml(l.price_label || '')}</td></tr>
            <tr><td style="padding:0 18px;font-family:${sans};font-size:14.5px;color:${INK};">${escapeHtml([l.address, [l.city, l.state].filter(Boolean).join(', ')].filter(Boolean).join(' · '))}</td></tr>
            ${meta(l) ? `<tr><td style="padding:6px 18px 0;font-family:${label};font-size:11.5px;letter-spacing:.07em;font-weight:600;text-transform:uppercase;color:${TAUPE};">${meta(l)}</td></tr>` : ''}
            ${l.why_note ? `<tr><td style="padding:10px 18px 2px;font-family:${serif};font-size:15.5px;font-style:italic;line-height:1.5;color:#40381F;">&ldquo;${escapeHtml(l.why_note)}&rdquo;</td></tr>` : ''}
            <tr><td style="padding:0 0 14px;"></td></tr>
          </table>
        </a>
      </td></tr>`;

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:${PAGE};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE};padding:28px 12px;"><tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${PAPER};border:1px solid ${RULE};border-radius:4px;">
      <tr><td style="padding:30px 28px 22px;" align="center">
        <div style="font-family:${serif};font-size:29px;letter-spacing:.01em;color:${INK};">Legacy&nbsp;Properties</div>
        <div style="font-family:${label};font-size:11px;letter-spacing:.26em;font-weight:600;text-transform:uppercase;color:${GOLD};padding-top:6px;">Every Home Has A Story</div>
      </td></tr>
      <tr><td style="padding:0 28px;"><hr style="border:none;border-top:1px solid ${RULE};margin:0;"></td></tr>
      <tr><td style="padding:26px 28px 6px;font-family:${serif};font-size:19px;line-height:1.5;color:${INK};">${firstName ? escapeHtml(firstName) + ' &mdash;' : 'Hello &mdash;'}</td></tr>
      <tr><td style="padding:0 28px 22px;font-family:${sans};font-size:15.5px;line-height:1.65;color:${INK};">${escapeHtml(intro || "I hand-picked a few homes I think you'll want to see. Take a look and tell me what you think — I'd love to hear which ones speak to you.")}</td></tr>
      ${shown.length ? `<tr><td style="padding:0 28px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="font-family:${label};font-size:11px;letter-spacing:.2em;font-weight:600;text-transform:uppercase;color:${TAUPE};padding:0 0 12px;">${escapeHtml(collectionTitle || 'Picked for you')} &nbsp;·&nbsp; ${(listings || []).length} home${(listings || []).length === 1 ? '' : 's'}</td></tr>
          ${shown.map(card).join('')}
          ${more ? `<tr><td style="font-family:${sans};font-size:13.5px;color:${TAUPE};padding:2px 0 8px;" align="center">&hellip;and ${more} more inside</td></tr>` : ''}
        </table>
      </td></tr>` : ''}
      <tr><td align="center" style="padding:10px 28px 30px;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td align="center" bgcolor="${MAROON}" style="border-radius:3px;">
            <a href="${link}" style="display:inline-block;padding:15px 34px;font-family:${label};font-size:13px;letter-spacing:.12em;font-weight:600;text-transform:uppercase;text-decoration:none;color:${CREAM} !important;background:${MAROON};border-radius:3px;"><span style="color:${CREAM} !important;">View your collection</span></a>
          </td>
        </tr></table>
        <div style="font-family:${sans};font-size:12.5px;color:${TAUPE};padding-top:12px;">or copy this link: <a href="${link}" style="color:${TAUPE};">${link}</a></div>
      </td></tr>
      <tr><td style="padding:0 28px;"><hr style="border:none;border-top:1px solid ${RULE};margin:0;"></td></tr>
      <tr><td style="padding:18px 28px 8px;font-family:${sans};font-size:13.5px;line-height:1.6;color:${INK};">
        ${escapeHtml(agentName)}<br>
        <span style="color:${TAUPE};">${[dre ? 'DRE #' + escapeHtml(dre) : null, phone ? escapeHtml(phone) : null].filter(Boolean).join(' &nbsp;·&nbsp; ')}</span><br>
        <a href="${SITE}" style="color:${TAUPE};">${SITE.replace(/^https?:\/\//, '')}</a>
      </td></tr>
      <tr><td style="padding:6px 28px 24px;font-family:${sans};font-size:10.5px;line-height:1.5;color:#8F8267;">Listing information is deemed reliable but not guaranteed. ${escapeHtml(BROKERAGE.name)} &middot; ${escapeHtml(BROKERAGE.broker)}, ${escapeHtml(BROKERAGE.broker_title)} &middot; DRE #${escapeHtml(BROKERAGE.broker_dre)}</td></tr>
    </table>
  </td></tr></table>
  </body></html>`;
}

// The exact message that push() sends — reused by the preview so they match.
// `listings` (shaped, from buildClientPayload) powers the photo cards in the
// email; SMS stays short and link-first.
export function buildPushMessage({ coll, agent, channel, firstName, message, subject, listings = [] }) {
  const link = `${SITE}/c/${coll.share_token}`;
  const agentName = agent?.name || (coll.agent === 'james' ? 'James Beyersdorf' : 'Sara Cooper');
  if (channel === 'sms') {
    const body = (message && String(message).trim())
      || `${firstName ? firstName + ', ' : ''}${agentName.split(' ')[0]} at Legacy Properties picked a few homes for you. Take a look and tell me what you think: ${link}`;
    return { channel: 'sms', link, body };
  }
  const bodyText = (message && String(message).trim()) || coll.intro_note || '';
  return {
    channel: 'email', link,
    subject: (subject && String(subject).trim()) || `${firstName ? firstName + ', a' : 'A'} few homes I picked for you`,
    text: `${bodyText ? bodyText + '\n\n' : ''}View your collection: ${link}`,
    html: emailHtml({
      firstName, agentName, dre: agent?.dre_number, phone: agent?.phone, link,
      intro: bodyText, listings, collectionTitle: coll.title || ''
    })
  };
}
