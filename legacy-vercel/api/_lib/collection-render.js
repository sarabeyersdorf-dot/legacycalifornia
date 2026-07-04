// api/_lib/collection-render.js
// Single source of truth for BOTH what a client SEES (the collection page
// payload) and what a client is SENT (the push SMS/email). The live send path
// (api/c/[token].js, curate-push.js) and the agent preview (curate-preview.js)
// all import from here, so an agent's preview can never drift from reality.

import { shapeListing } from './handlers/curate-search.js';

export const BROKERAGE = { name: 'Legacy Properties', broker: 'Sara Cooper', broker_title: 'Broker-Owner', broker_dre: '02141987' };
export const SITE = (process.env.PUBLIC_SITE_URL || 'https://legacycalifornia.com').replace(/\/+$/, '');

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
    collection: { title: coll.title || '', intro_note: coll.intro_note || '', closing_note: coll.closing_note || '' },
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

export function emailHtml({ firstName, agentName, dre, phone, link, intro }) {
  return `<div style="font-family:Georgia,'Cormorant Garamond',serif;color:#1A1714;max-width:560px;margin:0 auto;padding:32px 28px;background:#FAF6EC;">
    <div style="font-family:'Courier New',monospace;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#7C6A4D;margin-bottom:18px;">Legacy Properties · Every Home Has A Story</div>
    <p style="font-size:16px;line-height:1.6;margin:0 0 16px;">${firstName ? escapeHtml(firstName) + ' —' : 'Hello —'}</p>
    <p style="font-size:15px;line-height:1.6;margin:0 0 20px;">${escapeHtml(intro || "I hand-picked a few homes I think you'll want to see. Tap below to look through them and tell me what you think.")}</p>
    <p style="margin:0 0 24px;"><a href="${link}" style="display:inline-block;background:#5A0E24;color:#F4E6C8;text-decoration:none;padding:13px 26px;border-radius:2px;font-family:'Courier New',monospace;font-size:12px;letter-spacing:.12em;text-transform:uppercase;">View your collection</a></p>
    <hr style="border:none;border-top:1px solid #D9CFB7;margin:8px 0 16px;">
    <p style="font-size:13px;line-height:1.55;color:#7C6A4D;margin:0;">${escapeHtml(agentName)}${dre ? ' · DRE #' + escapeHtml(dre) : ''}${phone ? ' · ' + escapeHtml(phone) : ''}<br><a href="${SITE}" style="color:#7C6A4D;">legacycalifornia.com</a></p>
  </div>`;
}

// The exact message that push() sends — reused by the preview so they match.
export function buildPushMessage({ coll, agent, channel, firstName, message, subject }) {
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
    html: emailHtml({ firstName, agentName, dre: agent?.dre_number, phone: agent?.phone, link, intro: bodyText })
  };
}
