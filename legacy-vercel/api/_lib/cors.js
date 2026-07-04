// api/_lib/cors.js
// Lightweight CORS + JSON helpers for Vercel Node functions.
// Same-origin in production; permissive in development.

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);

// CORS that fails SAFE: credentials are only ever granted to an explicitly
// allow-listed origin. In wildcard mode (ALLOWED_ORIGINS unset or '*') we send
// `Allow-Origin: *` WITHOUT credentials — so a random site a logged-in user
// visits can't make credentialed calls and read their CRM/portal data. The real
// app is served from the same origin as /api, so it never needs CORS creds.
export function applyCors(req, res) {
  const reqOrigin = req.headers.origin || '';
  const wildcard  = ALLOWED_ORIGINS.includes('*');
  const allowed   = reqOrigin && !wildcard && ALLOWED_ORIGINS.includes(reqOrigin);

  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', reqOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  } else if (wildcard) {
    // Open mode (dev / public GETs): any origin, but NO credentials.
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else {
    // Configured allow-list but this origin isn't on it: don't reflect it,
    // don't grant credentials. Cross-origin reads are refused by the browser.
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS[0] || 'null');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

export function handleOptions(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(req, res);
    res.status(204).end();
    return true;
  }
  applyCors(req, res);
  return false;
}

export function json(res, status, payload) {
  res.setHeader('Content-Type', 'application/json');
  res.status(status).send(JSON.stringify(payload));
}

export function fail(res, status, message, extra = {}) {
  json(res, status, { success: false, error: message, ...extra });
}

export function ok(res, payload = {}) {
  json(res, 200, { success: true, ...payload });
}

/** Parse a Vercel Node request body whether it arrived as object, string, or buffer. */
export async function readJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  // Stream fallback
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end',  () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}
