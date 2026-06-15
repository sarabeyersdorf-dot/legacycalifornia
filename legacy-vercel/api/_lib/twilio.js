// api/_lib/twilio.js
// Minimal Twilio REST helper — no SDK dependency.
// Used in Phase 1C to alert Sara when a ready_to_offer lead arrives.

const TWILIO_SID    = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM   = process.env.TWILIO_PHONE_NUMBER;

const SARA_PHONE = '+12095594966'; // hardcoded per spec — Sara's mobile

export function twilioConfigured() {
  return !!(TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM);
}

export async function sendSMS({ to, body }) {
  if (!twilioConfigured()) {
    return { skipped: true, reason: 'Twilio env not set' };
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`;
  const params = new URLSearchParams({ From: TWILIO_FROM, To: to, Body: body });
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
