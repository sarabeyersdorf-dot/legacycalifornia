// api/seller/[action].js
// Single dispatcher serving all seller portal URLs:
//   GET /api/seller/portal  → full seller portal payload
//
// Counts as ONE serverless function on Vercel.

import portal from '../_lib/handlers/seller-portal.js';

const TABLE = {
  'portal': portal
};

export default async function handler(req, res) {
  const action = req.query?.action;
  const fn = TABLE[action];
  if (!fn) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ success: false, error: `unknown seller action: ${action}` }));
  }
  return fn(req, res);
}
