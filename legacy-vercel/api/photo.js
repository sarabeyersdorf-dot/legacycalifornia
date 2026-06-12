// api/photo.js
// ─────────────────────────────────────────────────────────────
// GET /api/photo?url=https%3A%2F%2Fcdn.metrolist.com%2F123.jpg
//
// MLS photo proxy:
//   • Hides MetroList photo URLs from the browser (required by some MLS data agreements)
//   • Lets us serve photos from our own origin → no CORS, no mixed-content
//   • Cache-Control header on this route is set in vercel.json to 1 day client / 7 days edge
//
// To keep this safe, we only proxy URLs whose hostname is in the allow-list below.
// ─────────────────────────────────────────────────────────────

import { setCors } from './_metrolist.js';

const ALLOWED_HOSTS = [
  'cdn.metrolistmls.com',
  'media.metrolistmls.com',
  'metrolistmls.com',
  'photos.metrolistmls.com',
  // Vendor CDNs MetroList sometimes uses for photo storage:
  'rets.flexmls.com',
  'photos.flexmls.com',
];

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const u = req.query.url;
  if (!u) return res.status(400).send('Missing ?url=');

  let parsed;
  try { parsed = new URL(u); } catch { return res.status(400).send('Bad URL'); }
  if (!ALLOWED_HOSTS.some(h => parsed.hostname === h || parsed.hostname.endsWith('.' + h))) {
    return res.status(403).send('Host not allowed');
  }

  try {
    const r = await fetch(parsed.toString());
    if (!r.ok) return res.status(r.status).send('Upstream error');
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    const buf = Buffer.from(await r.arrayBuffer());
    res.status(200).send(buf);
  } catch (err) {
    res.status(502).send('Proxy error: ' + err.message);
  }
}
