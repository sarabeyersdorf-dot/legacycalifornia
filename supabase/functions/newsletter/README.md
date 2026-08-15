# `newsletter` — monthly newsletter sender (SendGrid)

The bulk newsletter path. Sends from the **root** domain `legacycalifornia.com`
via **SendGrid**, deliberately separate from the CRM's transactional mail (which
sends from `send.legacycalifornia.com` via Resend). Separate domains + providers
= isolated reputations, so a rough newsletter week can't hurt magic-link delivery.

**It sends nothing on its own.** No cron, no schedule. Every send is an explicit,
authenticated, batched call. This is intentional — warm-up and consent are
human-gated.

## Content source

Reuses the existing **`ledger_issues`** model. The email is a short teaser (title +
`dek`) that links to the web version at `/ledger.html?slug=<slug>`. Author/publish
the issue as before; this function only sends it. An issue must be `status =
'published'` to send.

## Secrets (Supabase → Project → Edge Functions → Secrets)

| Name | Notes |
|---|---|
| `NEWSLETTER_SECRET` | required on every call (`?key=` or `Authorization: Bearer`) |
| `SENDGRID_API_KEY` | the Mail-Send-scoped key `legacy-ledger-send-2` |
| `SENDGRID_FROM_EMAIL` | default `sara@legacycalifornia.com` |
| `SENDGRID_FROM_NAME` | default `Sara Cooper · Legacy Properties` |
| `SENDGRID_REPLY_TO` | default `sarasellscalifornia@gmail.com` |
| `PUBLIC_SITE_URL` | default `https://legacycalifornia.com` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | auto-injected by Supabase |

The SendGrid key lives **only** here — never in Vercel (that keeps the CRM's
inert SendGrid fallback inert). Keep SendGrid **Subscription Tracking OFF**: this
function sets its own one-click `List-Unsubscribe` pointing at the CRM's
`/api/unsubscribe`, so opt-outs stay in one place (`leads.email_opt_out`).

## Deploy

Source of truth is this file. Deploy it to Supabase from here (no CLI setup needed
on Sara's side — Claude Code pushes it). Requires the `db/073_newsletter_sends.sql`
migration to have applied first (it does on merge to `main`).

## Invoking (who runs it)

Sara doesn't run this by hand. When she says *"send the June issue, batch of 200,"*
Claude Code calls it. Modes:

```
POST /functions/v1/newsletter    (Authorization: Bearer <NEWSLETTER_SECRET>)

# 1) Count who would get it — no send:
{ "mode": "resolve", "issue_slug": "june-2026" }
  → { contactable, already_sent, remaining, sample }

# 2) Preview one batch — still no send:
{ "mode": "send", "issue_slug": "june-2026", "limit": 200, "dry_run": true }
  → { would_send, subject, sample }

# 3) Actually send one batch:
{ "mode": "send", "issue_slug": "june-2026", "limit": 200 }
  → { sent, failed, remaining, errors }
```

Every recipient is re-checked against the opt-out gates at send time, must have a
`unsubscribe_token`, and is recorded in `newsletter_sends` so re-invoking never
double-sends. Call `send` repeatedly to drain the list a batch at a time.

## Warm-up ramp (cold domain — do NOT skip)

`legacycalifornia.com` has effectively never sent bulk. Ramp the FIRST issue over
several days, most-engaged first, growing the ceiling across the first 2–3 issues:

| Day | Batch |
|---|---|
| 1 | ~200 |
| 2 | ~400 |
| 3 | ~800 |
| 4 | remainder |

Each `send` call caps at 300 internally; use several calls per day rather than one
big burst. Confirm SendGrid shows the domain authenticated (green) before the first
send, and — per counsel's note — confirm list-consent recency before sending at all.

## Not included here

Recipient targeting is currently "everyone contactable." Segment support, an Event
Webhook (bounce/complaint capture), and a CRM "send" button can be added later.
