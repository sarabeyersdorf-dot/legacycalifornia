# Legacy California — CRM / Platform API Contract

**Purpose:** the exact endpoints, payloads, and responses the *existing frontend*
expects, so a full-stack agent (Claude Code / Emergent) can build `api/` + `db/`
and the CRM goes live without any frontend rewrites.

**Derived from:** `public/legacy-client.js`, `public/crm.html`,
`public/dashboard.html`, `public/find-my-match.html` (as shipped).

**Commit destination (suggested):** repo root as `API-CONTRACT.md`.

---

## 0. Current state

Built and working:
- `GET /api/listings`, `GET /api/listing?id=`, `GET /api/photo?url=` (IDX layer)

**Missing — everything below.** The frontend already calls these; they 404 today.
The CRM never renders because `gate()` calls `GET /api/auth/session` first, gets
404, and falls back to the sign-in card; sign-in then fails because
`/api/auth/login` doesn't exist either.

`db/` is empty — the Supabase schema has to be authored as part of this work.

---

## 1. Conventions

- **Base:** same origin, `/api/...`, JSON in / JSON out.
- **Auth:** session is cookie-based. `credentials: 'include'` is sent on every
  request. Server derives identity from the cookie — **the client never sends a
  user id**. Endpoints must scope all data to the caller.
- **Success envelope:** `2xx`. Lead intake specifically expects
  `{ "success": true, ... }` (the client checks `json.success`).
- **Error envelope:** non-2xx with `{ "error": "human readable message" }`.
  The client surfaces `json.error` verbatim in the UI.
- **Roles:** `buyer`, `seller`, `agent_sara`, `agent_james`, `admin`.
  Agent-only endpoints must reject non-agent roles with `403`.

### Status legend
- ✅ **wired + painted** — frontend calls it AND renders the response. Build to spec and it works.
- 🟡 **called, not painted** — frontend calls it; response is only partly consumed. Safe to build; UI wiring can follow.
- 🔴 **not called yet** — feature is static HTML waiting on an endpoint *and* a small frontend painter (flagged per item).

---

## 2. Data model (minimum tables)

Inferred from the fields the frontend reads. Backend owns final schema/types;
these are the columns the UI depends on.

**users / profiles**
- `id`, `email`, `role` (enum above), `display_name`

**leads**
- `id`, `first_name`, `last_name`, `email`, `phone`
- `lead_type` (`buyer` | `seller`), `journey_stage`
  (`discovering` | `narrowing` | `touring` | `ready_to_offer`)
- `temperature` (`hot` | `warm` | `cold` | `new`)
- `score` (int), `source`, `owner_agent` (which agent)
- `areas` (text[]), `price_max` (int), `created_at`, `last_contact_at`
- pipeline `stage` (`new` | `nurture` | `touring` | `offer` | `close`)

**messages** (email/SMS, incl. AI drafts)
- `id`, `lead_id`, `channel` (`email` | `sms`), `subject`, `body`
- `status` (`draft` | `sent` | ...), `ai_draft_reasoning`
- `created_at`, `sent_at`

**deals**
- `id`, `source_key` (e.g. `433-hwy4`), `address`, `price`, stage/contingency dates

**deal_parties**
- `id`, `deal_id`, `lead_id`, `role` (`seller`|`co-seller`|`buyer`|`co-buyer`)

**tours / appointments**
- `id`, `lead_id`, `property_mls`, `property_id`, `scheduled_at`, `tour_type` (`video`|`in_person`)

---

## 3. Auth — `/api/auth/*`  (build first; unblocks the CRM)

### `GET /api/auth/session` ✅
Returns the current session or 401.
```json
{ "profile": { "role": "agent_sara", "display_name": "Sara Cooper", "email": "sara@..." } }
```
Client reads `json.profile.role` (gate) and `json.profile.display_name` (greeting).

### `POST /api/auth/session` ✅
Persists tokens as httpOnly cookies after login. Body:
```json
{ "access_token": "...", "refresh_token": "..." }
```

### `POST /api/auth/login` ✅  (agents — password)
Body `{ "email", "password" }` →
```json
{ "session": { "access_token": "...", "refresh_token": "..." } }
```
On failure: `{ "error": "..." }` (client shows it).

### `POST /api/auth/magic-link` ✅  (buyers/sellers — passwordless)
Body `{ "email" }`. `2xx` = "link sent". Uses Resend.

### `POST /api/auth/signout` 🔴  (needed)
Clears the session cookie. Wired to `[data-sign-out]` in the CRM sidebar —
**needs a ~3-line click handler** added to the frontend once the endpoint exists.

---

## 4. Leads — `/api/leads/*`

### `POST /api/leads/intake` ✅  (public — the whole website funnel)
Called by every marketing-page form and modal. Full payload shape:
```json
{
  "source": "website_form",
  "first_name": "Renee", "last_name": "Dawson",
  "email": "renee@...", "phone": "209...",
  "lead_type": "buyer",
  "journey_stage": "touring",
  "areas": ["Murphys", "Arnold"],
  "price_max": 625000,
  "message": "free text or null",
  "property_mls": "MLS# or null",
  "property_id": "id or null",
  "tour": { "scheduled_at": "ISO-8601", "tour_type": "in_person" }
}
```
Every field except `source` is optional depending on the form. **Must return**
`{ "success": true }` (client checks this exact flag). May echo `email`.
Side effects: create/update lead, notify agent (Resend/Twilio), score the lead.

---

## 5. CRM — `/api/crm/*`  (agent-only, `403` otherwise)

### `GET /api/crm/morning-brief` ✅
```json
{ "narrative": "Two hot replies overnight; one offer clock at 8 days.",
  "drafts": [ /* same objects as inbox messages */ ] }
```
Painted into the "Today" brief header (`data-bind-narrative`, greeting, date).

### `GET /api/crm/inbox?filter=&limit=` ✅
Query: `filter` (`awaiting_reply` | `all` | `hot` | `warm` | `new`), `limit`.
```json
{ "messages": [ {
    "id": "uuid",
    "channel": "email",
    "subject": "Saturday walk-through",
    "body": "draft text…",
    "created_at": "ISO",
    "ai_draft_reasoning": "why this angle (optional)",
    "leads": {
      "first_name": "Renee", "last_name": "Dawson", "email": "renee@...",
      "temperature": "hot", "lead_type": "buyer", "score": 92
    }
} ] }
```
Painted as the "Needs you" draft cards. `leads` is a nested object per message.

### `POST /api/crm/approve` ✅
Body `{ "message_id", "edited_body?", "edited_subject?" }` →
```json
{ "status": "sent", "provider": { "via": "twilio" } }
```
Sends via Resend (email) or Twilio (sms). Client shows "✓ Sent via {via}".

### `GET /api/crm/pipeline` 🟡
Currently only `total_estimated_value` is read (one big number). Return the full
shape so the Pipeline tab and header stats can be painted:
```json
{
  "total_estimated_value": 4200000,
  "counts": { "new": 5, "nurture": 8, "touring": 6, "offer": 3, "close": 2 },
  "stats": { "in_flight": "$4.2M", "expected_month": "$1.1M",
             "closing_week": "$480K", "tour_to_offer_rate": "38%" },
  "stages": {
    "new":     [ { "id","name","email","temperature","score","summary" } ],
    "nurture": [ ... ], "touring": [ ... ], "offer": [ ... ], "close": [ ... ]
  }
}
```
Feeds `data-bind-pipe-*`, `data-stage-count`, `data-kanban` columns —
**needs a painter** (kanban cards + header stats are static now).

### `POST /api/crm/link-deal-party` ✅  (agent-only)
Fully wired modal in `crm.html`. Body:
```json
{ "deal":"433-hwy4", "email":"client@...", "first_name":"", "last_name":"",
  "phone":"", "role":"seller", "provision": true }
```
Response:
```json
{ "linked": true, "user_provisioned": true, "user_linked": false,
  "deal": { "address": "433 E Highway 4" },
  "party": { "role": "seller" },
  "lead": { "created": true } }
```

### `POST /api/crm/import-leads` 🔴  (needed — CSV importer)
Wired to `[data-open-importer]` (modal not yet built). Accepts CSV rows →
bulk create leads. Return `{ "imported": N, "skipped": N, "errors": [...] }`.
**Needs frontend modal + handler.**

### `POST /api/crm/test-email` 🔴  (needed)
Wired to `[data-send-test-email]`. Sends a Resend test to the agent.
`{ "sent": true }`. **Needs a small handler.**

---

## 6. Roster counts & Today dashboard  (🔴 need endpoints + painters)

These sidebar/tab badges and Today-view sections are **static placeholders** (`—`)
with data hooks but no fetch/painter yet.

### `GET /api/crm/roster-counts` 🔴
Feeds every `data-roster-*` badge (sidebar + tab strip):
```json
{ "today": 5, "inbox": 12, "pipeline": 24, "calendar": 3, "calendar_week": 9,
  "leads": 41, "clients": 18, "past": 63, "listings": 7 }
```

### `GET /api/crm/today` 🔴
One call to paint the rest of the Today view. Suggested shape:
```json
{
  "hours":  [ { "time":"9:00 AM", "label":"Rivera inspection", "now":false } ],
  "signals":[ { "title":"", "detail":"", "tag":"" } ],   // overnight signal cards
  "deals":  [ { "address":"", "price":"", "stage":"", "clock":"" } ],
  "day_list": [ { "title":"", "detail":"", "time":"5 min", "done":false } ],
  "day_total": "55 min · done by 7:38 AM",
  "day_stats": { "emails_sent":23, "drafts":"14 · 12 approved",
                 "showings":3, "new_leads":4, "pipeline_added":"$2.4M",
                 "inbox_handled":"98%" }
}
```
Hooks: `data-hours-body`, `data-signal-grid`, `data-deal-grid`, `data-day-list`,
`data-day-total`, `data-day-stats`. **Market-pulse + weather in the brief are
decorative — leave static unless you want a data source.**

---

## 7. Inbox / lead detail  (🔴 need endpoints + painters)

The Inbox tab has a 3-pane layout (list / conversation / profile) with hooks but
no wiring beyond the loading placeholder.

### `GET /api/crm/leads?filter=&q=` 🔴
List for the left rail. `filter` matches the chips (`all|hot|warm|new|awaiting_reply`),
`q` is the search box.
```json
{ "counts": { "all":41,"hot":6,"warm":12,"new":9 },
  "leads": [ { "id","first_name","last_name","email","temperature","score",
               "last_message","last_contact_at","tags":[] } ] }
```
Hooks: `data-lead-list`, `data-count="<filter>"`.

### `GET /api/crm/lead?id=` 🔴
Full detail for the center + right panes (`data-lead-detail`, `data-lead-profile`):
conversation thread, profile facts, activity, saved searches, deal links.

---

## 8. Calendar / Sequences / Reports  (🔴 later)

Static tabs today. When you're ready:
- `GET /api/crm/calendar?week=` → appointments/tours for the week grid.
- `GET /api/crm/sequences` + `POST /api/crm/sequences/:id/enroll` → drip automation.
- `GET /api/crm/reports` → the numbers behind the Reports tab (closings, GCI, etc.).

Each needs a painter; none block the core CRM.

---

## 9. Buyer dashboard — `GET /api/me/dashboard` 🟡

`dashboard.html` ships a generic data-binding painter (`[data-bind]`,
`[data-list]`, `[data-row]`, `[data-toggle]`, `[data-sign]`). Return the buyer's
own data (server derives identity from cookie) as:
```json
{ "dashboard": { /* dotted paths matching the data-bind attrs in dashboard.html */ } }
```
Read `dashboard.html`'s `data-bind`/`data-list` attributes for the exact key
paths — the painter maps them 1:1, so the JSON keys must match those strings.

---

## 10. Build order (recommended)

1. **Schema** (§2) in Supabase + `db/schema.sql`.
2. **Auth** (§3) — unblocks the entire CRM gate.
3. **Leads intake** (§4) — turns on the whole website funnel immediately.
4. **CRM core** already-painted: morning-brief, inbox, approve, pipeline value (§5 ✅/🟡).
5. **Roster counts + Today** (§6) — high visible payoff, small painters.
6. **Inbox detail** (§7), then Calendar/Sequences/Reports (§8), dashboard (§9).

Items marked "needs a painter" are small frontend additions I can write once the
endpoint shapes are locked — hand me the final JSON and I'll wire the DOM.
