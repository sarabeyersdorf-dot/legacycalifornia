# Seller-portal marketing stats (ListTrac digest + YouTube views)

How the seller portal's **Marketing activity** panel and the video's view count
get their numbers, and what Cowork must write.

## 1. Weekly ListTrac digest → `deals.json` `marketing`

Sara forwards / files the weekly **ListTrac "Your Listing – Weekly Report of
Online Activity"** email (one per active listing). Cowork parses it and writes a
`marketing` object onto the matching deal in `data/deals.json`. The hourly
`sync-deals` cron maps `deal.marketing → deals.marketing_stats` (jsonb, db/067),
and the seller portal renders it. It's authoritative: each week's object
**replaces** the prior week's, so just overwrite it.

```json
{
  "id": "preparing-324-augusta",
  "address": "324 Augusta Ct",
  "…": "…",
  "marketing": {
    "period":      "Jun 25 – Aug 10, 2026",
    "report_date": "2026-08-10",
    "views":       2653,
    "shares":      12,
    "inquiries":   2,
    "callouts": [
      "90% of visitors viewing your listing are new visitors",
      "Your listing attracted more viewers than other listings in its zip code"
    ],
    "top_sites": [
      { "name": "Zillow.com",   "views": 782, "inquiries": 0 },
      { "name": "Realtor.com",  "views": 347, "inquiries": 0 },
      { "name": "Trulia",       "views": 81,  "inquiries": 0 }
    ],
    "top_cities": [
      { "name": "Valley Springs, CA", "views": 11 },
      { "name": "Sacramento, CA",     "views": 11 },
      { "name": "Roseville, CA",      "views": 4 }
    ]
  }
}
```

### Field mapping from the ListTrac email

| ListTrac email                       | `marketing` field           |
| ------------------------------------ | --------------------------- |
| "STATS FOR THE PERIOD" date range    | `period`                    |
| "Report Date"                        | `report_date` (YYYY-MM-DD)  |
| PROPERTY VIEWS                       | `views`                     |
| SHARES                               | `shares`                    |
| INQUIRIES                            | `inquiries`                 |
| The two icon highlight lines         | `callouts[]`                |
| "TOP 10 WEBSITES" rows               | `top_sites[]` (name/views/inquiries) |
| "TOP 10 CITIES" rows                 | `top_cities[]` (name/views) |

### Rules
- All counts are plain numbers (no commas/strings). Missing → omit the key.
- `callouts`, `top_sites`, `top_cities` are optional; each caps at ~10 entries.
- Buy-side deals (`side: buyer`) have no listing marketing — don't author it;
  the portal suppresses the panel anyway.
- Nothing to show (no `marketing`, or all-empty) → the whole panel stays hidden.
- Strings are sanitized server-side (`< >` stripped); no HTML.

## 2. YouTube view count — automatic, no manual entry

The video tour's "N views" is pulled automatically — Cowork does **not** enter it.
A daily cron (`/api/cron/youtube-views`, 14:45 UTC) reads every deal's video URL,
calls the YouTube Data API v3 for the public `viewCount`, and caches it on
`deals.video_views` (db/067, never touched by the deals.json sync). The portal
shows it under the video.

**One-time setup:** set `YOUTUBE_API_KEY` in Vercel (a public Data-API v3 key —
no OAuth). Until it's set the job no-ops and the portal simply omits the count.
The video URL itself still comes from `deals.json` (`video`/`youtube`) or the CRM
listing-media form (agent override).
