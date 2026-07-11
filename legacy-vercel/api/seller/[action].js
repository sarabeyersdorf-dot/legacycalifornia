// api/seller/[action].js
// Single dispatcher serving seller portal URLs:
//   GET /api/seller/listing → on-market LISTING portal (traffic, offers,
//                             showings, comps, checklist). Served here.
//
// Note: the in-escrow portal is a separate concrete file, api/seller/portal.js,
// which serves GET /api/seller/portal (it shadows this dispatcher for that path).
// The two are different journey stages: on-market vs in-escrow.
//
// Counts as ONE serverless function on Vercel.

import listingPortal from '../_lib/handlers/seller-portal.js';
import sellerMessages from '../_lib/handlers/seller-messages.js';

const TABLE = {
  'listing': listingPortal,
  'messages': sellerMessages
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
