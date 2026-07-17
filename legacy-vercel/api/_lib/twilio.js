// api/_lib/twilio.js
// Minimal Twilio REST helper — no SDK dependency.
// Used in Phase 1C to alert Sara when a ready_to_offer lead arrives.

const TWILIO_SID    = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM   = process.env.TWILIO_PHONE_NUMBER;

const SARA_PHONE = '+12095594966'; // hardcoded per spec — Sara's mobile

// Defensive E.164 normalizer for outbound From/To numbers. Strips everything
// but digits, then assumes US/Canada (matches this business's region) when
// given a bare 10-digit number missing the country code — e.g. a
// TWILIO_PHONE_NUMBER env var pasted as "2097293939" or "(209) 729-3939"
// instead of "+12097293939". Without this, Twilio parses a "+"-prefixed
// 10-digit US number under the wrong country's numbering plan and rejects it
// with error 21659 ("'From' ... country mismatch"). Anything already in a
// plausible E.164 shape (11 digits starting with 1, or longer/international)
// is passed through unchanged rather than guessed at.
export function normalizeE164(n) {
  const digits = String(n || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits ? `+${digits}` : '';
}

export function twilioConfigured() {
  return !!(TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM);
}

export async function sendSMS({ to, body }) {
  if (!twilioConfigured()) {
    return { skipped: true, reason: 'Twilio env not set' };
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`;
  const params = new URLSearchParams({ From: normalizeE164(TWILIO_FROM), To: normalizeE164(to), Body: body });
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type':  'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Twilio ${res.status}: ${text}`);
  }
  return JSON.parse(text);
}

export async function alertSara(message) {
  return sendSMS({ to: SARA_PHONE, body: message });
}
