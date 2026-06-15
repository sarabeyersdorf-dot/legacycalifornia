// api/ai/[action].js
// Single dispatcher serving all AI URLs:
//   POST /api/ai/welcome      → ai-welcome
//   POST /api/ai/draft-reply  → ai-draft-reply
//   POST /api/ai/score-lead   → ai-score-lead
//
// Counts as ONE serverless function on Vercel.

import welcome   from '../_lib/handlers/ai-welcome.js';
import draftRep  from '../_lib/handlers/ai-draft-reply.js';
import score     from '../_lib/handlers/ai-score-lead.js';

const TABLE = {
  'welcome':     welcome,
  'draft-reply': draftRep,
  'score-lead':  score
};

export default async function handler(req, res) {
  const action = req.query?.action;
  const fn = TABLE[action];
  if (!fn) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ success: false, error: `unknown ai action: ${action}` }));
  }
  return fn(req, res);
}
