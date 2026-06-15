// api/_lib/cors.js
// Lightweight CORS + JSON helpers for Vercel Node functions.
// Same-origin in production; permissive in development.

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());

export function applyCors(req, res) {
  const origin = req.headers.origin || '*';
  const allow  = ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin',  allow);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
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
