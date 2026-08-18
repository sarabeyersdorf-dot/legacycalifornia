// api/_lib/lead-intake.js
// Detect portal lead-notification emails landing in a synced Gmail inbox and
// normalise them into a hot lead. Called from api/cron/email-sync.js.
//
// Sources (learned from Sara's real inbox, 2026-08):
//   • Realtor.com direct  — no-reply@realtorpro.io, subject
//       "New inquiry: <Name> <phone> <email>." → name/phone/email are IN the
//       subject; the body carries the property + message.
//   • Realtor.com direct  — leads@email.realtor.com, subject
//       "New realtor.com lead - <Name>" → name in subject, contact in body.
//   • Follow Up Boss      — leads@followupboss.com, subject "Lead Alert…"/
//       "New Lead…". FUB aggregates Zillow, Homes.com AND Realtor.com and
//       forwards a clean, normalised body (name / origin portal / property /
//       phone / email / message). This is the highest-value single source.
//   • Homes.com direct    — noreply@homes.com, subject "New Lead from Homes.com"
//       (thin: phone + message only; FUB usually carries the same lead richer).
//
// The SAME lead commonly arrives via several of these at once, so the caller
// dedups on the unique leads.email (falling back to phone) — every parser here
// only has to be best-effort; redundancy + dedup make the pipeline robust.
//
// Deliberately excludes the noise that shares these senders: saved-search
// alerts (consumer@e.mail.realtor.com, my-saved-home@mail.zillow.com), FUB
// digests ("Hot Sheet", weekly production emails), and portal marketing.

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /(?:\+?1[\s.\-]?)?\(?([2-9]\d{2})\)?[\s.\-]?(\d{3})[\s.\-]?(\d{4})/;
// Relay / vendor domains whose addresses are NEVER the prospect's own email.
const RELAY_DOMAIN_RE = /(?:realtor\.com|realtorpro\.io|move\.com|followupboss\.com|zillow\.com|homes\.com|costar\.com|sendgrid\.net|google\.com|example\.com)$/i;

const PORTAL_LABEL = {
  realtor_com: 'Realtor.com',
  homes_com:   'Homes.com',
  zillow:      'Zillow',
  fub:         'Follow Up Boss',
};

// Which lead-source (if any) does an inbox message represent? Returns a source
// key or null. Precise on purpose — a false positive would create a junk lead.
export function detectLeadSource(senderEmail, subject) {
  const s = String(senderEmail || '').toLowerCase().trim();
  const subj = String(subject || '');
  if (s === 'no-reply@realtorpro.io') {
    // "New inquiry: …" is a lead; "New text reply/message from …" is an existing
    // contact replying, not a new lead.
    return /^\s*new inquiry:/i.test(subj) ? 'realtor_com' : null;
  }
  if (s === 'leads@email.realtor.com') {
    return /new .*realtor\.com lead/i.test(subj) ? 'realtor_com' : null;
  }
  if (s === 'leads@followupboss.com') {
    // Per-lead alerts only — never the Hot Sheet or the weekly production digest.
    if (/hot sheet|weekly|you'?re behind|production goal|\bupdate\b|activity/i.test(subj)) return null;
    return /^\s*(lead alert|new lead)\b/i.test(subj) ? 'fub' : null;
  }
  if (s === 'noreply@homes.com') {
    return /new lead/i.test(subj) ? 'homes_com' : null;
  }
  return null;
}

function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

function splitName(full) {
  const t = clean(full);
  if (!t || /^(text lead|homes\.com|zillow|realtor\.com|new lead)/i.test(t)) return { first: null, last: null };
  const parts = t.split(' ');
  const first = parts.shift() || null;
  return { first, last: parts.join(' ') || null };
}

function normPhone(text) {
  const m = PHONE_RE.exec(String(text || ''));
  return m ? `${m[1]}${m[2]}${m[3]}` : null;
}

// Trim trailing punctuation the subject line leaves on an address (e.g. the
// "…@graybar.com." period) so it matches the stored unique leads.email.
function cleanEmail(e) {
  const t = String(e || '').trim().toLowerCase().replace(/^[(<]+/, '').replace(/[).,;:>]+$/, '');
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? t : null;
}

// First email in the text that isn't a relay/vendor address = the prospect's.
function leadEmail(text) {
  const found = String(text || '').match(EMAIL_RE) || [];
  for (const raw of found) {
    const e = cleanEmail(raw);
    if (!e) continue;
    const dom = e.split('@')[1] || '';
    if (!RELAY_DOMAIN_RE.test(dom)) return e;
  }
  return null;
}

// Pull a property address out of "…interested in <ADDR> ($price)" / "property at
// <ADDR>" / "Property <ADDR>" — best-effort, trimmed to something sane.
function pickProperty(text) {
  const t = String(text || '');
  const m = /(?:interested in|property at|Property)\s+([0-9][^\n|]{5,90}?)(?:\s*[\(|]|\.\s|\n|$)/i.exec(t);
  return m ? clean(m[1]).replace(/[.,\s]+$/, '') : null;
}

// Parse one detected lead email into a normalised shape. `body` should be the
// full plain-text body (falls back to the snippet when that's all we have).
export function parseLead(source, { subject = '', body = '' } = {}) {
  const subj = String(subject);
  const text = `${subj}\n${body}`;

  let name = null, email = null, phone = null;

  if (source === 'realtor_com' && /^\s*new inquiry:/i.test(subj)) {
    // Subject: "New inquiry: <Name> <phone> <email>."
    const m = /^\s*New inquiry:\s*(.+?)\s+(\+?\(?\d[\d().\-\s]{6,}\d)\s+([^\s@]+@[^\s@]+\.[^\s@]+)\.?\s*$/i.exec(subj);
    if (m) { name = m[1]; phone = normPhone(m[2]); email = cleanEmail(m[3]); }
    else {
      const nm = /New inquiry:\s*([^0-9]+?)(?:\s+\d|\s*$)/i.exec(subj);
      name = nm ? nm[1] : null;
    }
  } else if (source === 'realtor_com') {
    // leads@email.realtor.com — "New realtor.com lead - <Name>"
    const nm = /realtor\.com lead\s*[-–—]\s*(.+)$/i.exec(subj);
    name = nm ? nm[1] : null;
  } else if (source === 'fub') {
    // "Lead alert for <Name> from <Portal> interested in <Property> ($price) …"
    const nm = /(?:lead alert for|new lead named)\s+(.+?)\s+from\s+/i.exec(text);
    name = nm ? nm[1] : null;
  }
  // Homes.com direct has no name in the body — leave null.

  if (!email) email = leadEmail(text);
  if (!phone) phone = normPhone(body || subj);

  // Origin portal — for FUB read the real portal out of "from <Portal> interested".
  let portal = source;
  if (source === 'fub') {
    const pm = /from\s+([A-Za-z][A-Za-z.\s]*?)\s+interested/i.exec(text);
    const p = pm ? clean(pm[1]).toLowerCase() : '';
    portal = /homes/.test(p) ? 'homes_com' : /zillow/.test(p) ? 'zillow' : /realtor/.test(p) ? 'realtor_com' : 'fub';
  }

  const property = pickProperty(text);

  // Message: prefer a quoted line; else the "Message …" block.
  let message = null;
  const q = /["“”]([^"“”]{6,300})["“”]/.exec(text);
  if (q) message = clean(q[1]);
  else {
    const mm = /Message\s*[|:]?\s*(.+?)(?:\s*(?:View details|Property\b|Your Listing|Note:|Open Lead|$))/is.exec(text);
    if (mm) message = clean(mm[1]).slice(0, 300);
  }

  const { first, last } = splitName(name);
  if (!email && !phone) return null;   // nothing to act on

  return {
    first_name: first, last_name: last,
    email: email || null, phone: phone || null,
    portal, portal_label: PORTAL_LABEL[portal] || 'a portal',
    property: property || null, message: message || null,
  };
}
