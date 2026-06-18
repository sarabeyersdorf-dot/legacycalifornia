# Legacy Properties — PRD

## Problem statement (verbatim, condensed)
Wire real backends into the fully-designed Legacy Platform prototype hosted at
`legacycalifornia.vercel.app` to replace Ylopo ($2K/mo) and Follow Up Boss with
a single owned system. Build on Vercel + Supabase + direct Anthropic API.
Never modify HTML/CSS — add backend functionality only.

## Tech stack (locked by spec)
- Hosting: Vercel
- DB / Auth / Storage: Supabase
- AI: direct `https://api.anthropic.com/v1/messages`, model `claude-sonnet-4-6` (no wrappers, no emergentintegrations)
- SMS: Twilio
- Email: MailerLite
- IDX: MetroListPRO Optima IDX (account #230389)
- Temporary mirror: Follow Up Boss (deleted in January)

## User personas
- **Sara Cooper** — broker-owner, primary CRM user
- **James Cooper** — partner agent
- **Buyer** — magic-link auth, dashboard view
- **Seller** — magic-link auth, seller portal view

## What's been implemented (Phase 1A + 1B + 1C — 2026-01)
- **DB**: `db/schema.sql`, `db/rls_policies.sql`, `db/seed_sequences.sql` (7 default sequences)
- **Auth**: `/api/auth/{login, magic-link, callback, session, logout, config}.js`
- **Lead intake**: `/api/leads/intake.js` (single endpoint for every form on the site)
- **AI**: `/api/ai/{welcome, draft-reply, score-lead}.js` — direct Anthropic, drafts saved as `pending_approval`
- **Twilio alert**: hot-lead SMS to Sara at +1 209-559-4966 when `journey_stage = ready_to_offer`
- **FUB sync** (Phase 1 only): `/api/fub/sync.js`
- **Shared libs**: `api/_lib/{supabase, anthropic, auth, twilio, cors}.js`
- **Frontend wiring**: single `public/legacy-client.js` added via one `<script>` tag per page; no HTML/CSS structure changes. Wires: homepage journey selector, Find My Match (every page), Message Sara, Book a tour, listing.html tour scheduler + Send to Sara, auth gates for /crm.html, /dashboard.html, /seller.html.
- **DRE fix**: `#0214187` → `#02141987` across 16 HTML pages
- **`package.json`**: adds `@supabase/supabase-js`, declares ESM (`type: module`)
- **`.env.example`**: documents every required Vercel env var
- **README.md**: full Phase 1 setup + deploy guide

## Static / locked
- Visual design — every HTML/CSS file
- Schema field names — match spec exactly
- Direct Anthropic API only

## What's been implemented (Phase 1D–1I — 2026-02)
- **Phase 1D — CRM live data**: `/api/crm/[action].js` dispatcher routes `morning-brief`, `inbox`, `pipeline`, `lead`, `approve`. AI morning-brief narrative cached in `briefs` table (4h TTL). `legacy-client.js` paints the desk.
- **Phase 1E — Buyer dashboard**: `/api/me/dashboard.js` returns paint-ready buyer payload (greeting, brief, stats, new_matches, saved, tours, messages, digest letter via Anthropic, market snapshot). `dashboard.html` wired through `data-bind` / `data-list`. Fixed Sara headshot path (was returning bare filename, now `art/sara-headshot.png`). Mock-flash eliminated: painter calls `enterLoading()` + `clearScalars()` synchronously on DOMContentLoaded.
- **Phase 1F — Seller portal**: `/api/seller/[action].js` → `portal` returns listing hero, KPI strip, 21-day trend bars, AI seller note (Claude), offers, showings, comp set (same city, sq_ft ±20%, last 90 days), pre-listing checklist, documents from Supabase Storage bucket `seller-docs/<property_id>/`, recent activity, sharing. `db/003_seller_portal.sql` adds `properties.seller_lead_id`, `listing_stats`, `listing_checklist`. Seller painter in `legacy-client.js`.
- **Phase 1G — Sequences engine**: `/api/sequences/[action].js` → `enroll` (agents-only POST) + `cron` (hourly Vercel cron). Ticker auto-pauses on inbound replies, drafts next step via direct Anthropic (`claude-sonnet-4-6`) → `messages.status='pending_approval'`. Never auto-sends. Tuesday 14:00 UTC seller digest via Resend (de-duped per 6-day window). `db/004_sequence_pacing.sql` adds `leads.sequence_next_due_at`.
- **Phase 1I — iHomefinder IDX**: `/api/idx/[action].js` → `behavioral-webhook` (POST: normalises events, finds/creates lead by email, writes `lead_events`, re-scores, drafts hot-lead SMS when score crosses 75 → `messages.pending_approval`) + `sync` (4h Vercel cron: HTTP Basic, configurable base/path/agent scope, tolerant field mapping, upserts `properties` by `mls_number`).
- **Auth UX**: `gate()` rewritten as a synchronously-injected full-screen overlay (no mock flash). Sign-in card morphs in for unauthed sessions; dismisses for authed.
- **Vercel function count: 12/12** (Hobby tier ceiling reached). All future endpoints must go through the existing `[action].js` dispatchers.
- **Tech stack adjustment**: Resend (replaces MailerLite/SendGrid) for transactional email via `_lib/resend.js`.

## Backlog (priority order)
- **P2 — Phase 2**: delete `/api/fub/sync.js` + `fub_id` column when FUB contract ends.
- **P2 — Enrichment**: deeper iHomefinder feed mapping once we see real payloads (only the common aliases are wired today).

## Next action items
1. **Run pending SQL migrations in Supabase** (in order): `db/003_seller_portal.sql`, `db/004_sequence_pacing.sql`.
2. **Set Vercel env vars** for Phase 1I:
   - `IHOMEFINDER_API_USER` + `IHOMEFINDER_API_PASS` (or `IHOMEFINDER_API_KEY` as basic-user fallback)
   - Optional: `IHOMEFINDER_API_BASE`, `IHOMEFINDER_LISTINGS_PATH`, `IHOMEFINDER_AGENT_ID`, `IHOMEFINDER_OFFICE_ID`, `IHOMEFINDER_WEBHOOK_SECRET`
   - Optional: `CRON_SECRET` (gates `/api/sequences/cron` + `/api/idx/sync`)
3. **Configure iHomefinder webhook** to POST to `https://<domain>/api/idx/behavioral-webhook?secret=<CRON_SECRET_OR_WEBHOOK_SECRET>`.
4. **Smoke test**: deploy → trigger `/api/idx/sync` manually (or wait 4h) → confirm a few properties land in Supabase → POST a sample webhook payload and verify a `lead_events` row + score change appear.
