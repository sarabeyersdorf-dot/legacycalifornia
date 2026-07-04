// api/curate/[action].js
// Single dispatcher for the agent-facing Curated Search & Story Push module.
// All routes here are AUTH-GATED (agents only) inside each handler.
//   GET    /api/curate/search          → MetroList-lite listing search
//   GET/POST/DELETE /api/curate/saved-searches → named searches per client
//   GET/POST/PATCH/DELETE /api/curate/collections → curate + annotate
//   POST   /api/curate/push            → push a collection via SMS/email
//   GET/PATCH /api/curate/valuations   → agent view of valuation requests
//
// The anonymous CLIENT routes live separately in api/c/[token].js so the
// public surface is trivial to security-review. Counts as ONE function.

import search        from '../_lib/handlers/curate-search.js';
import savedSearches from '../_lib/handlers/curate-saved-searches.js';
import collections   from '../_lib/handlers/curate-collections.js';
import push          from '../_lib/handlers/curate-push.js';
import valuations    from '../_lib/handlers/curate-valuations.js';
import preview       from '../_lib/handlers/curate-preview.js';
import clients       from '../_lib/handlers/curate-clients.js';
import listingMedia  from '../_lib/handlers/curate-listing-media.js';

const TABLE = {
  'search':         search,
  'saved-searches': savedSearches,
  'collections':    collections,
  'push':           push,
  'valuations':     valuations,
  'preview':        preview,
  'clients':        clients,
  'listing-media':  listingMedia
};

export default async function handler(req, res) {
  const action = req.query?.action;
  const fn = TABLE[action];
  if (!fn) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ success: false, error: `unknown curate action: ${action}` }));
  }
  return fn(req, res);
}
