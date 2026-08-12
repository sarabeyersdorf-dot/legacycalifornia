-- db/067_marketing_and_video_stats.sql
-- Seller-portal marketing metrics.
--
--  marketing_stats (jsonb)  — the weekly ListTrac "Online Activity" digest.
--     Authored by Cowork from the ListTrac email and written through the hourly
--     deals.json sync (sync-deals maps deal.marketing → this column), so the
--     latest weekly numbers replace the prior week's. Shape:
--       {
--         "period":      "Jun 25 – Aug 10, 2026",
--         "report_date": "2026-08-10",
--         "views":       2653,
--         "shares":      12,
--         "inquiries":   2,
--         "callouts":    ["90% of visitors are new visitors", "..."],
--         "top_sites":   [{"name":"Zillow.com","views":782,"inquiries":0}, ...],
--         "top_cities":  [{"name":"Valley Springs, CA","views":11}, ...]
--       }
--
--  video_views / video_views_synced_at — YouTube public view count, refreshed by
--     the daily /api/cron/youtube-views job (YouTube Data API v3). NOT written by
--     the deals.json sync, so it survives every sync (same reasoning as the
--     override columns). Null until the first cron run / no YOUTUBE_API_KEY set.

alter table public.deals add column if not exists marketing_stats        jsonb;
alter table public.deals add column if not exists video_views            integer;
alter table public.deals add column if not exists video_views_synced_at  timestamptz;
