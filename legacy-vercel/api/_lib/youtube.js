// api/_lib/youtube.js
// Minimal YouTube Data API v3 helper — public video statistics only, so a plain
// API key is enough (no OAuth). Set YOUTUBE_API_KEY in Vercel.
//   Docs: https://developers.google.com/youtube/v3/docs/videos/list

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const API = 'https://www.googleapis.com/youtube/v3/videos';

export function youtubeConfigured() {
  return !!YOUTUBE_API_KEY;
}

// Pull an 11-char video id out of any common YouTube URL form (watch, youtu.be,
// embed, shorts) — or accept a bare id.
export function extractYouTubeId(url) {
  if (!url) return null;
  const s = String(url).trim();
  let m;
  if ((m = s.match(/[?&]v=([a-zA-Z0-9_-]{11})/)))                 return m[1];
  if ((m = s.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/)))           return m[1];
  if ((m = s.match(/\/(?:embed|shorts|v|live)\/([a-zA-Z0-9_-]{11})/))) return m[1];
  if (/^[a-zA-Z0-9_-]{11}$/.test(s))                             return s;
  return null;
}

/**
 * Fetch public view (and like) counts for a video.
 * @returns {{ skipped?: boolean, views?: number|null, likes?: number|null, reason?: string }}
 */
export async function getVideoStats(videoId) {
  if (!youtubeConfigured()) return { skipped: true, reason: 'YOUTUBE_API_KEY not set' };
  if (!videoId)             return { skipped: true, reason: 'no video id' };

  const url = `${API}?part=statistics&id=${encodeURIComponent(videoId)}&key=${YOUTUBE_API_KEY}`;
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`YouTube ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);

  const item = (j.items || [])[0];
  if (!item) return { views: null, likes: null, reason: 'video not found or private' };
  const st = item.statistics || {};
  return {
    views: st.viewCount != null ? parseInt(st.viewCount, 10) : null,
    likes: st.likeCount != null ? parseInt(st.likeCount, 10) : null
  };
}
