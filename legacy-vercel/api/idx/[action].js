// api/idx/[action].js
// Dispatcher — one Vercel function serving:
//   POST /api/idx/behavioral-webhook  → iHomefinder behavioural webhook
//   GET  /api/idx/sync                → 4-hour Vercel cron for listings

import webhook from '../_lib/handlers/idx-behavioral-webhook.js';
import sync    from '../_lib/handlers/idx-sync.js';

const TABLE = {
  'behavioral-webhook': webhook,
  'sync':               sync
};

export default async function handler(req, res) {
  const action = req.query?.action;
  const fn = TABLE[action];
  if (!fn) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ success: false, error: `unknown idx action: ${action}` }));
  }
  return fn(req, res);
}
