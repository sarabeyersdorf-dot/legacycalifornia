// api/crm/[action].js
// Single dispatcher serving all CRM URLs:
//   GET  /api/crm/morning-brief  → morning brief snapshot
//   GET  /api/crm/inbox          → message stream (filtered)
//   GET  /api/crm/pipeline       → leads grouped by stage
//   GET  /api/crm/lead           → full lead detail (?id=<uuid>)
//   POST /api/crm/approve        → approve & send a draft
//
// Counts as ONE serverless function on Vercel.

import morningBrief from '../_lib/handlers/crm-morning-brief.js';
import inbox        from '../_lib/handlers/crm-inbox.js';
import pipeline     from '../_lib/handlers/crm-pipeline.js';
import leadDetail   from '../_lib/handlers/crm-lead-detail.js';
import approve      from '../_lib/handlers/crm-approve.js';

const TABLE = {
  'morning-brief': morningBrief,
  'inbox':         inbox,
  'pipeline':      pipeline,
  'lead':          leadDetail,
  'approve':       approve
};

export default async function handler(req, res) {
  const action = req.query?.action;
  const fn = TABLE[action];
  if (!fn) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ success: false, error: `unknown crm action: ${action}` }));
  }
  return fn(req, res);
}
