// api/_lib/optout-keywords.js
// Recognise "please stop emailing me" in a REPLY, so a person who asks to be
// removed is removed without an agent having to notice and click something.
//
// WHY THIS EXISTS
// On 2026-09-04 the debut Legacy Ledger went out. Ronald Jones replied with a
// single word — "Stop" — at 14:45 the next morning. It landed in the CRM inbox
// as an ordinary inbound email and NOTHING happened: the SMS side has caught
// STOP since day one (api/twilio/inbound.js), but the email side had no
// equivalent, so an unsubscribe request sat in a list waiting to be spotted.
// Sara spotted it two hours later and clicked the unsubscribe link herself.
//
// That is a compliance job that must not depend on someone reading their inbox.
// CAN-SPAM requires an opt-out to be honoured however it is expressed, and the
// only safe assumption is that nobody is watching.
//
// DELIBERATELY NARROWER THAN THE SMS LIST
// Twilio's keywords include CANCEL, END and QUIT because the carriers mandate
// them. In email those words are ordinary: "cancel" is a plausible reply to
// "shall I book the inspection?", and suppressing a client mid-transaction over
// it would be worse than the problem. So this list holds only phrases that
// cannot mean anything else in a reply to us.
//
// It also only fires when the reply is ESSENTIALLY NOTHING BUT the phrase.
// "Stop by the house around three" is not an opt-out; "Stop" is.

// Quoted history markers. Gmail's snippet inlines the original as
// "Stop On Fri, Sep 4, 2026, 10:05 AM Sara Cooper ... wrote:" with no line
// break, which is why a plain first-line read would miss it.
const QUOTE_MARKERS = [
  /\bOn\s.{0,160}?\bwrote:/is,          // Gmail / Apple Mail
  /-{2,}\s*Original Message\s*-{2,}/i,  // Outlook
  /^\s*From:\s.+$/im,                   // forwarded / Outlook header block
  /^\s*>/m,                             // classic quote prefix
  /\bSent from my \w+/i                 // mobile signature ahead of the quote
];

/** Everything the person actually typed, with the quoted original removed. */
export function stripQuotedReply(text) {
  let s = String(text == null ? '' : text);
  for (const re of QUOTE_MARKERS) {
    const m = s.match(re);
    if (m && m.index != null) s = s.slice(0, m.index);
  }
  return s.replace(/\s+/g, ' ').trim();
}

// Each must match the WHOLE cleaned reply. Anchored on both ends on purpose.
const OPT_OUT = [
  /^stop(\s+(all|please|emails?|emailing( me)?))?$/,
  /^unsubscribe(\s+me)?(\s+please)?$/,
  /^opt\s?-?\s?out(\s+of\s+everything)?$/,
  /^(please\s+)?(remove|delete)\s+me(\s+from\s+(your\s+)?(email\s+|mailing\s+)?list)?$/,
  /^(please\s+)?take\s+me\s+off(\s+(of\s+)?(your\s+)?(email\s+|mailing\s+)?list)?$/,
  /^no\s+more\s+emails?$/,
  /^(please\s+)?(stop|do\s?n[o']?t)\s+(email|emailing|contact|contacting)\s+me(\s+any\s?more)?$/
];

// A long message is a conversation, not a keyword — even one that opens with
// "stop". The cap is generous enough for "Please take me off your mailing list,
// thank you" and far short of a real reply.
const MAX_KEYWORD_LENGTH = 60;

/**
 * Is this inbound email asking to be taken off the list?
 *
 * @param {{subject?: string, body?: string}} msg
 * @returns {{matched: true, phrase: string, where: 'body'|'subject'} | null}
 */
export function detectEmailOptOut(msg) {
  const candidates = [
    ['body',    stripQuotedReply(msg && msg.body)],
    // Some people put it in the subject line instead and send an empty body.
    ['subject', String((msg && msg.subject) || '').replace(/^\s*(re|fwd?)\s*:\s*/i, '').trim()]
  ];

  for (const [where, raw] of candidates) {
    if (!raw || raw.length > MAX_KEYWORD_LENGTH) continue;
    // Drop trailing punctuation and courtesy so "Stop." and "Unsubscribe,
    // thanks" both land. Anything left over still has to match in full.
    const cleaned = raw
      .toLowerCase()
      .replace(/[.!,;:"'*]+/g, ' ')
      .replace(/\b(thanks|thank you|thx|please|regards|sincerely)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) continue;
    for (const re of OPT_OUT) {
      if (re.test(cleaned)) return { matched: true, phrase: raw, where };
    }
  }
  return null;
}

/**
 * Honour an opt-out found in an inbound email: flip the flag, write the
 * compliance record, tell the agent.
 *
 * Lives here rather than inline in the cron so the thing that runs in
 * production is the thing that can be run in a test. It is called from
 * api/cron/email-sync.js for every matched inbound message.
 *
 * Returns {applied:false, reason} when there is nothing to do — no keyword, no
 * matched contact, or already opted out — so the caller can count applications
 * and suppress its own "they replied, go and reply back" alert, which is the
 * wrong instruction for someone who just said stop.
 *
 * NEVER THROWS. This runs inside the mailbox sync; an opt-out that cannot be
 * recorded must not take the sync down with it.
 *
 * @param supa admin client
 * @param {{contactId: string, subject?: string, content?: string, senderEmail?: string}} msg
 * @param {{alert?: (text: string) => Promise<any>}} [opts] alert hook; omit to stay silent
 */
export async function applyEmailOptOut(supa, msg, opts = {}) {
  const { contactId, subject, content, senderEmail } = msg || {};
  if (!contactId) return { applied: false, reason: 'no matched contact' };

  const optOut = detectEmailOptOut({ subject, body: content });
  if (!optOut) return { applied: false, reason: 'no opt-out keyword' };

  try {
    const { data: before } = await supa.from('leads')
      .select('first_name, last_name, email, email_opt_out')
      .eq('id', contactId).maybeSingle();
    if (!before) return { applied: false, reason: 'contact vanished' };
    if (before.email_opt_out) return { applied: false, reason: 'already opted out', match: optOut };

    const { error: updErr } = await supa.from('leads')
      .update({ email_opt_out: true, updated_at: new Date().toISOString() })
      .eq('id', contactId);
    if (updErr) return { applied: false, reason: `update failed: ${updErr.message}` };

    // The event IS the compliance record — who, when, and the words they used.
    // updated_at alone proves nothing later. Best-effort so a failure here can
    // never make the opt-out itself fail, but the reason is returned rather
    // than swallowed, so a rejected insert is visible instead of silent.
    const event = {
      lead_id:    contactId,
      event_type: 'email_opt_out',
      source:     'inbound_email',
      event_data: {
        via:     'reply keyword',
        phrase:  optOut.phrase,
        where:   optOut.where,
        subject: subject || null,
        from:    senderEmail || null
      }
    };
    const { error: evtErr } = await supa.from('lead_events').insert(event);

    const who = [before.first_name, before.last_name].filter(Boolean).join(' ')
              || before.email || senderEmail || 'A contact';
    const text = `\u270B ${who} replied "${optOut.phrase}" — unsubscribed from email automatically. `
               + 'They can still be called or texted; open their card to change that.';
    if (typeof opts.alert === 'function') { try { await opts.alert(text); } catch (_) {} }

    return { applied: true, match: optOut, who, alert: text, event, event_error: evtErr ? evtErr.message : null };
  } catch (e) {
    return { applied: false, reason: `threw: ${e && e.message}` };
  }
}
