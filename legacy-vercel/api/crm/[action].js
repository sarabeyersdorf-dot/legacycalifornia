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
//   GET   /api/crm/deal-client     → a deal's linked client(s) + message thread
//   GET   /api/crm/deal-visibility → a deal's client-toggleable portal items
//   GET   /api/crm/sequences      → drip sequences for the Sequences tab
//   GET   /api/crm/calendar       → week of tours/appointments for the Calendar tab
//   GET   /api/crm/agent-updates  → shared "notes to Claude" log (Sara/James free-text updates)
//   POST  /api/crm/agent-updates  → log a new update
//   POST  /api/crm/discard-draft  → delete a pending AI-suggested reply Sara doesn't want
//   GET   /api/crm/deals-lite     → minimal deals list for pickers (e.g. Notes tab deal dropdown)
//   GET   /api/crm/email-oauth-start    → begin Google OAuth for a mailbox (Phase 2D)
//   GET   /api/crm/email-oauth-callback → Google OAuth redirect target (Phase 2D, unauthenticated)
//   GET   /api/crm/email-accounts       → per-owner connected-mailbox status (Phase 2D)
//
// Counts as ONE serverless function on Vercel.

import morningBrief  from '../_lib/handlers/crm-morning-brief.js';
import inbox         from '../_lib/handlers/crm-inbox.js';
import pipeline      from '../_lib/handlers/crm-pipeline.js';
import leadDetail    from '../_lib/handlers/crm-lead-detail.js';
import approve       from '../_lib/handlers/crm-approve.js';
import messageSend   from '../_lib/handlers/crm-message-send.js';
import bulkSend      from '../_lib/handlers/crm-bulk-send.js';
import noteCreate    from '../_lib/handlers/crm-note-create.js';
import importLeads   from '../_lib/handlers/crm-import-leads.js';
import metrics       from '../_lib/handlers/crm-metrics.js';
import testEmail     from '../_lib/handlers/crm-test-email.js';
import linkDealParty from '../_lib/handlers/crm-link-deal-party.js';
import relatedContact from '../_lib/handlers/crm-related-contact.js';
import tagging from '../_lib/handlers/crm-tagging.js';
import sequences     from '../_lib/handlers/crm-sequences.js';
import calendar      from '../_lib/handlers/crm-calendar.js';
import broker        from '../_lib/handlers/crm-broker.js';
import createLead    from '../_lib/handlers/crm-create-lead.js';
import me            from '../_lib/handlers/crm-me.js';
import listings      from '../_lib/handlers/crm-listings.js';
import tasks         from '../_lib/handlers/crm-tasks.js';
import actions       from '../_lib/handlers/crm-actions.js';
import visibility    from '../_lib/handlers/crm-visibility.js';
import briefingFeedback from '../_lib/handlers/crm-briefing-feedback.js';
import briefingCalendar from '../_lib/handlers/crm-briefing-calendar.js';
import driftCheck        from '../_lib/handlers/crm-drift-check.js';
import briefingBundle    from '../_lib/handlers/crm-briefing-bundle.js';
import dealStage        from '../_lib/handlers/crm-deal-stage.js';
import dealEdit         from '../_lib/handlers/crm-deal-edit.js';
import reviewQueue      from '../_lib/handlers/crm-review-queue.js';
import dealPhoto        from '../_lib/handlers/crm-deal-photo.js';
import dealClient       from '../_lib/handlers/crm-deal-client.js';
import dealParties      from '../_lib/handlers/crm-deal-parties.js';
import dealVisibility    from '../_lib/handlers/crm-deal-visibility.js';
import documentVisibility from '../_lib/handlers/crm-document-visibility.js';
import dealNotes         from '../_lib/handlers/crm-deal-notes.js';
import dealNotePublish   from '../_lib/handlers/crm-deal-note-publish.js';
import dealPortalNotes   from '../_lib/handlers/crm-deal-portal-notes.js';
import leadHygiene       from '../_lib/handlers/crm-lead-hygiene.js';
import timeline          from '../_lib/handlers/crm-timeline.js';
import roster            from '../_lib/handlers/crm-roster.js';
import agentUpdates      from '../_lib/handlers/crm-agent-updates.js';
import discardDraft      from '../_lib/handlers/crm-discard-draft.js';
import dealsLite         from '../_lib/handlers/crm-deals-lite.js';
import dealsUnified       from '../_lib/handlers/crm-deals.js';
import dealsMotion        from '../_lib/handlers/crm-deals-motion.js';
import messages           from '../_lib/handlers/crm-messages.js';
import messageDelete      from '../_lib/handlers/crm-message-delete.js';
import deadlines          from '../_lib/handlers/crm-deadlines.js';
import emailOauthStart    from '../_lib/handlers/crm-email-oauth-start.js';
import emailOauthCallback from '../_lib/handlers/crm-email-oauth-callback.js';
import emailAccounts      from '../_lib/handlers/crm-email-accounts.js';
import idxStatus          from '../_lib/handlers/crm-idx-status.js';
import logContact         from '../_lib/handlers/crm-log-contact.js';
import followUps           from '../_lib/handlers/crm-follow-ups.js';
import showcase            from '../_lib/handlers/crm-showcase.js';
import reconcile           from '../_lib/handlers/crm-reconcile.js';
import dealMessages        from '../_lib/handlers/crm-deal-messages.js';
import dealDates           from '../_lib/handlers/crm-deal-dates.js';
import dealCreate          from '../_lib/handlers/crm-deal-create.js';
import dealNoteSuggest     from '../_lib/handlers/crm-deal-note-suggest.js';
import dealGoodToKnow      from '../_lib/handlers/crm-deal-good-to-know.js';
import dealClientTasks     from '../_lib/handlers/crm-deal-client-tasks.js';
import dealMilestones      from '../_lib/handlers/crm-deal-milestones.js';
import dealsExport         from '../_lib/handlers/crm-deals-export.js';
import recentlyActive      from '../_lib/handlers/crm-recently-active.js';

const TABLE = {
  'lead-hygiene':    leadHygiene,
  'timeline':        timeline,
  'roster':          roster,
  'morning-brief':   morningBrief,
  'inbox':           inbox,
  'pipeline':        pipeline,
  'lead':            leadDetail,
  'approve':         approve,
  'message':         messageSend,
  'bulk-send':       bulkSend,
  'note':            noteCreate,
  'import-leads':    importLeads,
  'metrics':         metrics,
  'test-email':      testEmail,
  'link-deal-party': linkDealParty,
  'related-contact': relatedContact,
  'tagging':         tagging,
  'sequences':       sequences,
  'calendar':        calendar,
  'broker':          broker,
  'create-lead':     createLead,
  'me':              me,
  'listings':        listings,
  'tasks':           tasks,
  'actions':         actions,
  'visibility':      visibility,
  'briefing-feedback': briefingFeedback,
  'briefing-calendar': briefingCalendar,
  'drift-check':       driftCheck,
  'briefing-bundle':   briefingBundle,
  'deal-stage':        dealStage,
  'deal-edit':         dealEdit,
  'review-queue':      reviewQueue,
  'deal-photo':        dealPhoto,
  'deal-client':       dealClient,
  'deal-parties':      dealParties,
  'deal-visibility':   dealVisibility,
  'document-visibility': documentVisibility,
  'deal-notes':        dealNotes,
  'deal-note-publish': dealNotePublish,
  'deal-portal-notes': dealPortalNotes,
  'agent-updates':     agentUpdates,
  'discard-draft':     discardDraft,
  'deals':             dealsUnified,
  'deals-lite':        dealsLite,
  'deals-motion':      dealsMotion,
  'messages':          messages,
  'message-delete':    messageDelete,
  'deadlines':         deadlines,
  'email-oauth-start':    emailOauthStart,
  'email-oauth-callback': emailOauthCallback,
  'email-accounts':       emailAccounts,
  'idx-status':           idxStatus,
  'log-contact':          logContact,
  'follow-ups':           followUps,
  'showcase':             showcase,
  'reconcile':            reconcile,
  'deal-messages':        dealMessages,
  'deal-dates':           dealDates,
  'deal-create':          dealCreate,
  'deal-note-suggest':    dealNoteSuggest,
  'deal-good-to-know':    dealGoodToKnow,
  'deal-milestones':      dealMilestones,
  'deal-client-tasks':    dealClientTasks,
  'deals-export':         dealsExport,
  'recently-active':      recentlyActive
};

export default async function handler(req, res) {
  const action = req.query?.action;
  const fn = TABLE[action];
  if (!fn) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ success: false, error: `unknown crm action: ${action}` }));
  }
  // CRM data is live and per-agent. Without an explicit no-store, a browser or
  // the Vercel edge can cache a read response and serve it stale — e.g. one
  // agent's board showing a lead list from before a new lead synced (Ryan Vega
  // visible to Sara but not James), or a "pending today" list that lags reality.
  // Set it for the whole CRM surface here so no individual handler can forget;
  // a handler that needs different caching can still override after this.
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  return fn(req, res);
}
