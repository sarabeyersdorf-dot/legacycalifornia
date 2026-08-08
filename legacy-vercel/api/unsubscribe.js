// api/unsubscribe.js — GET /api/unsubscribe?token=<uuid>
//
// One-click opt-out behind every bulk / newsletter email. Flips
// leads.email_opt_out using the per-contact leads.unsubscribe_token, then shows
// a plain confirmation page. No auth (the token IS the credential).

import { adminClient } from './_lib/supabase.js';

function page(title, msg) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Legacy Properties</title>
<style>body{margin:0;font-family:Georgia,'Cormorant Garamond',serif;background:#F2ECDF;color:#1B1813;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
.card{max-width:460px;background:#FAF6EC;border:1px solid rgba(27,24,19,.12);border-radius:12px;padding:38px 32px;text-align:center;box-shadow:0 12px 34px -18px rgba(27,24,19,.4)}
.ey{font-family:'Courier New',monospace;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#8C6E3D;margin-bottom:14px}
h1{font-style:italic;font-weight:500;font-size:26px;margin:0 0 12px;line-height:1.15}
p{font-size:15px;line-height:1.6;color:#4A4136;margin:0 0 10px}a{color:#8C6E3D}</style></head>
<body><div class="card"><div class="ey">Legacy Properties</div><h1>${title}</h1><p>${msg}</p>
<p><a href="https://legacycalifornia.com">Return to Legacy Properties &rarr;</a></p></div></body></html>`;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const token = String(req.query.token || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    res.status(400).send(page('Invalid link', 'That unsubscribe link is missing or malformed.'));
    return;
  }
  try {
    const supa = adminClient();
    const { data: lead } = await supa.from('leads').select('id').eq('unsubscribe_token', token).maybeSingle();
    if (!lead) { res.status(404).send(page('Not found', 'We couldn’t find that subscription — you may already be off the list.')); return; }
    await supa.from('leads').update({ email_opt_out: true, updated_at: new Date().toISOString() }).eq('id', lead.id);
    res.status(200).send(page('You’re unsubscribed', 'You won’t receive any more emails from Legacy Properties. Changed your mind? Reply to any past email and we’ll add you back.'));
  } catch (_) {
    res.status(500).send(page('Something went wrong', 'Please try again, or email SaraSellsCalifornia@gmail.com to be removed.'));
  }
}
