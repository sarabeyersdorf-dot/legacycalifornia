# Legacy Properties — Website (Vercel) + Phase 1 Backend

Boutique real estate platform for the California Gold Country (Calaveras · Amador · Tuolumne).

## Folder layout

```
public/        ← static pages, CSS, JS, images, hero video, legacy-client.js
api/           ← Vercel serverless functions
  _lib/        ← shared helpers (supabase, anthropic, twilio, auth, cors)
  auth/        ← login, magic-link, callback, session, logout, config
  leads/       ← intake
  ai/          ← welcome, draft-reply, score-lead
  fub/         ← sync (Phase 1 only — remove January)
  _metrolist.js, listings.js, listing.js, photo.js  ← MetroList RESO Web API
db/            ← Supabase SQL (run in this order: schema → rls → seed)
vercel.json    ← function + caching config
.env.example   ← required environment variables
```

## Phase 1A — Supabase setup (one-time)

1. **Create a Supabase project** at https://supabase.com → New Project → name it `legacy-properties`.
2. Open **SQL editor** and run, in order:
   - `db/schema.sql`
   - `db/rls_policies.sql`
   - `db/seed_sequences.sql`
3. **Auth providers**: Settings → Authentication → enable **Email** with magic link AND password (Sara/James will sign in with password; buyers/sellers with magic link).
4. **Create agent accounts**: Authentication → Users → Invite (or insert via SQL):
   ```sql
   -- After creating the auth users in the dashboard, set their role:
   update public.users set role = 'agent_sara',  display_name = 'Sara Cooper'  where id = '<sara-auth-uid>';
   update public.users set role = 'agent_james', display_name = 'James Cooper' where id = '<james-auth-uid>';
   ```
5. Copy **Settings → API → Project URL, anon public key, service_role key** into Vercel env vars.

## Phase 1B/1C — Vercel deploy

1. Push this repo to GitHub.
2. Vercel → **Add New → Project → Import**.
3. Framework: **Other**. Build/output: empty (Vercel serves `public/`).
4. **Settings → Environment Variables**: copy every key from `.env.example` and fill in real values. At minimum for Phase 1 you need:
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`
   - `ANTHROPIC_API_KEY`  *(direct Anthropic — model `claude-sonnet-4-6`)*
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` *(used to alert Sara on hot leads)*
5. Deploy. Every push to GitHub auto-deploys.

## What Phase 1 ships

| Endpoint | Purpose |
|---|---|
| `POST /api/leads/intake`     | Single intake for every form on the site (homepage journey, Find My Match, Message Sara, tour booking) |
| `POST /api/ai/welcome`       | Drafts welcome SMS + email in Sara's voice; alerts Sara directly on `ready_to_offer` |
| `POST /api/ai/draft-reply`   | Drafts a contextual reply on demand using full lead history |
| `POST /api/ai/score-lead`    | Recalculates lead score 0–100 + temperature |
| `POST /api/fub/sync`         | Mirrors a lead into Follow Up Boss (Phase 1 only) |
| `POST /api/auth/login`       | Email + password sign-in (Sara, James) |
| `POST /api/auth/magic-link`  | Sends a magic link (buyers, sellers) |
| `GET /api/auth/callback`     | Exchanges magic-link code → session cookies |
| `GET/POST/DELETE /api/auth/session` | Current session + cookie management |
| `POST /api/auth/logout`      | Clears session cookies |
| `GET /api/auth/config`       | Public Supabase URL + anon key for client JS |

## Frontend wiring

A single `public/legacy-client.js` is included on every page that needs it.
It does **not** modify the existing HTML/CSS — it only:

- Opens dynamically-built modals when the user clicks existing buttons
  (Save my place / Find My Match / Message Sara / Book a tour / Send to Sara).
- Wires the tour scheduler on `listing.html` to POST `/api/leads/intake`
  with a `tour: { scheduled_at }` payload that also creates a `tours` row.
- Guards `crm.html` (agents only), `dashboard.html` (buyers + agents),
  `seller.html` (sellers + agents) by rendering an inline sign-in card if
  there is no session.

## AI guardrails

- All AI calls go directly to `https://api.anthropic.com/v1/messages`.
  No SDK wrappers, no third-party middleware.
- Default model: **`claude-sonnet-4-6`** (configurable via `model` arg).
- Drafted messages are **never auto-sent**. They are saved to
  `messages` with `status = 'pending_approval'` for Sara to review in the CRM
  inbox. The single exception is the SMS alert to Sara herself for
  `journey_stage = 'ready_to_offer'` leads.

## DRE number

Corrected `#0214187` → `#02141987` across all public HTML pages.

## Local development

```
npm install -g vercel
yarn install
vercel dev      # serves public/ + api/ at http://localhost:3000
```

## Next phases (not in this build)

- **1D** — Live CRM data (morning brief, inbox, pipeline, approve-message)
- **1E** — Buyer dashboard live data
- **1F** — Seller portal live data
- **1G** — Sequences cron engine
- **1H** — FUB sync (already stubbed in `api/fub/sync.js`; remove in January)
- **1I** — MetroListPRO Optima IDX behavioral webhook

