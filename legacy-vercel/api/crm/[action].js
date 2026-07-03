// api/crm/[action].js
// Single dispatcher serving all CRM URLs:
//   GET   /api/crm/morning-brief  → morning brief snapshot
//   GET   /api/crm/inbox          → message stream (filtered)
//   GET   /api/crm/pipeline       → leads grouped by stage
//   GET   /api/crm/lead           → full lead detail (?id=<uuid>)
//   PATCH /api/crm/lead           → update pipeline_stage / assigned_agent
//   POST  /api/crm/approve        → approve & send a draft
//   POST  /api/crm/message        → manual outbound from an agent
//   POST  /api/crm/note           → agent-only note on a lead
//   POST  /api/crm/link-deal-party → link a client (lead) to their deal
//
// Counts as ONE serverless function on Vercel.

import morningBrief  from '../_lib/handlers/crm-morning-brief.js';
import inbox         from '../_lib/handlers/crm-inbox.js';
import pipeline      from '../_lib/handlers/crm-pipeline.js';
import leadDetail    from '../_lib/handlers/crm-lead-detail.js';
import approve       from '../_lib/handlers/crm-approve.js';
import messageSend   from '../_lib/handlers/crm-message-send.js';
import noteCreate    from '../_lib/handlers/crm-note-create.js';
import importLeads   from '../_lib/handlers/crm-import-leads.js';
import metrics       from '../_lib/handlers/crm-metrics.js';
import testEmail     from '../_lib/handlers/crm-test-email.js';
import linkDealParty from '../_lib/handlers/crm-link-deal-party.js';

const TABLE = {
  'morning-brief':   morningBrief,
  'inbox':           inbox,
  'pipeline':        pipeline,
  'lead':            leadDetail,
  'approve':         approve,
  'message':         messageSend,
  'note':            noteCreate,
  'import-leads':    importLeads,
  'metrics':         metrics,
  'test-email':      testEmail,
  'link-deal-party': linkDealParty
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
