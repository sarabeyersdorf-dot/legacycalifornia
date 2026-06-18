// api/sequences/[action].js
// Dispatcher — one Vercel function serving:
//   POST /api/sequences/enroll  → manually enroll a lead in a sequence
//   GET  /api/sequences/cron    → hourly Vercel cron (sequences ticker
//                                 + Tuesday seller digest)

import enroll from '../_lib/handlers/sequences-enroll.js';
import cron   from '../_lib/handlers/sequences-cron.js';

const TABLE = {
  'enroll': enroll,
  'cron':   cron
};

export default async function handler(req, res) {
  const action = req.query?.action;
  const fn = TABLE[action];
  if (!fn) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ success: false, error: `unknown sequences action: ${action}` }));
  }
  return fn(req, res);
}
