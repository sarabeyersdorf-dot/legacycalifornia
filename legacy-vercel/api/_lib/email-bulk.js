// api/_lib/email-bulk.js
// The ONE explicit bulk/newsletter deny list — edited here by hand, never a
// heuristic (Cowork 2026-08-27). Shared by:
//   • email-sync    — auto-dismiss at ingest, so bulk never enters the review queue
//   • deal-messages — filter deal correspondence, and return this list so it's auditable
//
// DELIBERATELY CONSERVATIVE. deal_messages' pending_review queue is a MIX of
// newsletters AND genuine deal parties (title, escrow, lenders, co-agents), so a
// domain goes here ONLY if it is unambiguously marketing/automation. Deal-party
// domains (pmz.com, ctt.com, octitle.com, primeres.com, caltel.com, …), free
// mail (gmail.com), and transaction tools (authentisign, dotloop/lwolf, dotloop,
// metrolist) are LEFT OFF on purpose — a false dismiss hides real client mail.

export const DENY_SENDERS = new Set([
  'news@car.org', 'consumer@e.mail.realtor.com', 'notifications-noreply@linkedin.com',
  'thetechbuzz@mail.beehiiv.com', 'nar@mail.nar.realtor'
]);

export const DENY_DOMAINS = new Set([
  // real-estate portals / marketing
  'e.mail.realtor.com', 'mail.realtor.com', 'email.homes.com', 'ml.homes.com',
  'mail.zillow.com', 'e.mail.zillow.com', 'mail.lrmrkt.com', 'listtrac.com',
  'ihomefinder.com', 'pro.crexi.com', 'crexi.com', 'propstream.com', 'homelight.com',
  // associations / newsletters
  'car.org', 'nar.realtor', 'mail.nar.realtor', 'beehiiv.com', 'mail.beehiiv.com',
  'subscriptions.bls.gov', 'mail.vistaprint.com',
  // Lone Wolf "Daily Relationships Pulse" marketing (lwolf.com). NOTE: this is the
  // MARKETING domain only — the signature product sends from authentisign.com,
  // which is a SIGNATURE_SERVICE domain below, NOT denied.
  'lwolf.com',
  // bulk-send infrastructure
  'shared1.ccsend.com', 'ccsend.com', 'mailchimpapp.net', 'linkedin.com'
]);

// E-signature / transaction-form services. NOT bulk — we WANT these — but they're
// automated notices ("Signing complete: ETA2") that often name only a document,
// with no address or escrow number to match on. deal-messages stores their FULL
// body (not just the ~200-char snippet) so the matcher has something to work with,
// and routes any that still don't match to a dedicated `signature_events` bucket
// — so "a document was signed, go look" instead of silent unmatched noise.
export const SIGNATURE_SERVICE_DOMAINS = new Set([
  'authentisign.com', 'notifications.authentisign.com',
  'docusign.net', 'docusign.com', 'mail.docusign.net',
  'ziplogix.com', 'mail.ziplogix.com', 'zipformplus.com', 'ziplogixdigitalink.com',
  'skyslope.com', 'forms.skyslope.com', 'digisign.skyslope.com',
  'dotloop.com', 'mail.dotloop.com',
  'transactiondesk.com', 'instanetforms.com', 'glide.com'
]);

const domainOf = (email) => String(email || '').toLowerCase().split('@')[1] || '';

// Shared subdomain-aware membership test against a domain Set.
function domainInSet(email, set) {
  const dom = domainOf(email);
  if (!dom) return false;
  if (set.has(dom)) return true;
  for (const d of set) if (dom.endsWith('.' + d)) return true;
  return false;
}

// True iff this sender is on the explicit deny list (exact address or domain,
// including subdomains of a denied domain).
export function isBulkSender(email) {
  const e = String(email || '').toLowerCase();
  if (DENY_SENDERS.has(e)) return true;
  return domainInSet(e, DENY_DOMAINS);
}

// True iff this sender is an e-signature / transaction-form service.
export function isSignatureService(email) {
  return domainInSet(String(email || '').toLowerCase(), SIGNATURE_SERVICE_DOMAINS);
}
