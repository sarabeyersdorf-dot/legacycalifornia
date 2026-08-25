// api/sequences/[action].js
// Dispatcher — one Vercel function serving:
//   POST /api/sequences/enroll  → manually enroll a lead in a sequence
//   GET  /api/sequences/cron    → hourly Vercel cron (sequences ticker
//                                 + Tuesday seller digest)

import enroll from '../_lib/handlers/sequences-enroll.js';
import cron   from '../_lib/handlers/sequences-cron.js';
import importExpired from '../_lib/handlers/sequences-import-expired.js';
import preview from '../_lib/handlers/sequences-preview.js';
import pendingFirst from '../_lib/handlers/sequences-pending-first.js';
import edit from '../_lib/handlers/sequences-edit.js';
import aiSuggest from '../_lib/handlers/sequences-ai-suggest.js';
import status from '../_lib/handlers/sequences-status.js';

const TABLE = {
  'enroll':         enroll,
  'cron':           cron,
  'import-expired': importExpired,
  'preview':        preview,
  'pending-first':  pendingFirst,
  'edit':           edit,
  'ai-suggest':     aiSuggest,
  'status':         status
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
