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

## What's been implemented (Phase 1D + 1E + 1F — 2026-02)
- **Phase 1D — CRM live data**: `/api/crm/[action].js` dispatcher routes `morning-brief`, `inbox`, `pipeline`, `lead`, `approve`. AI morning-brief narrative cached in `briefs` table (4h TTL). `legacy-client.js` paints the desk.
- **Phase 1E — Buyer dashboard**: `/api/me/dashboard.js` returns paint-ready buyer payload (greeting, brief, stats, new_matches, saved, tours, messages, digest letter via Anthropic, market snapshot). `dashboard.html` wired through `data-bind` / `data-list`.
- **Phase 1F — Seller portal** (2026-02): `/api/seller/[action].js` → `portal` returns listing hero, KPI strip (page views/uniques/saves/showings/offers), 21-day trend bars, AI seller note (Claude), offers, showings, comp set (same city, sq_ft ±20%, last 90 days), pre-listing checklist, documents from Supabase Storage bucket `seller-docs/<property_id>/`, recent activity, sharing. `db/003_seller_portal.sql` adds `properties.seller_lead_id`, `listing_stats` (manual entry stub), `listing_checklist`. Seller painter appended to `legacy-client.js` (no HTML changes).
- **Tech stack adjustment**: Resend (replaces MailerLite/SendGrid) for transactional email via `_lib/resend.js`.

## Backlog (priority order)
- **P1 — Phase 1G**: sequences cron engine (`/api/sequences/enroll.js`, `/api/cron/sequences.js`)
- **P1 — Phase 1I**: iHomefinder IDX embed in `listings.html`, `/api/idx/{sync, behavioral-webhook}.js`
- **P2 — Phase 2**: delete `/api/fub/sync.js` + `fub_id` logic in January when FUB contract ends

## Next action items
1. **Seller portal setup**: Run `db/003_seller_portal.sql` in Supabase. Create Storage bucket `seller-docs` (private; signed URLs). Set `seller_lead_id` on the seller's property row. Seed `listing_stats` with manual daily numbers (or wire the IDX webhook later) and `listing_checklist` rows.
2. **Phase 1G — Sequences**: build `/api/sequences/enroll.js` (POST: enroll lead in a sequence by trigger_type) + `/api/cron/sequences.js` (GET: tick due steps, draft via AI, write to `messages` as `pending_approval`). Add Vercel cron to vercel.json.
3. **Phase 1I — IDX**: drop iHomefinder embed into `listings.html`, build `/api/idx/sync.js` cron + `/api/idx/behavioral-webhook.js` to write into `properties` and `lead_events`.
4. **Phase 2**: remove FUB sync once contract ends.
