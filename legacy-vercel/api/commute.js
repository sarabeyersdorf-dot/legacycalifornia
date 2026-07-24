// api/commute.js
// GET /api/commute?from=<address|town>&to=<address|destination>&depart=<band>
//
// Universal drive-time lookup for the public commute widget and curated
// searches. Answers in this priority:
//   1. Sara's real-log matrix (commute-data) when BOTH ends are a modelled
//      foothill town → modelled destination — her honest, time-of-day numbers.
//   2. A live routing provider for anything else (any CA address → any CA
//      address), if a key is configured:
//        • Google Maps  (GOOGLE_MAPS_API_KEY) — traffic-aware, time-of-day.
//        • OpenRouteService (ORS_API_KEY) — free, free-flow (no live traffic).
//   3. Otherwise { configured:false } so the widget shows a friendly setup note
//      (the modelled town pairs still work with zero configuration).
//
// Public endpoint (clients hit it from the search page) — no auth.

import { handleOptions, ok, fail } from './_lib/cors.js';

// ---- Sara's honest matrix (kept in sync with public/commute-data.js) --------
const DEST_KEYS = ['sfo', 'oak', 'sjc', 'sac', 'sf', 'reno'];
const DEST_META = {
  sfo:  { label: 'SFO',         lat: 37.6213, lng: -122.3790 },
  oak:  { label: 'OAK',         lat: 37.7126, lng: -122.2197 },
  sjc:  { label: 'SJC',         lat: 37.3639, lng: -121.9289 },
  sac:  { label: 'Sacramento (SMF)', lat: 38.6951, lng: -121.5908 },
  sf:   { label: 'Downtown SF', lat: 37.7946, lng: -122.3999 },
  reno: { label: 'Reno (RNO)',  lat: 39.4991, lng: -119.7681 }
};
const DEST_ALIAS = {
  sfo: 'sfo', oak: 'oak', oakland: 'oak', sjc: 'sjc', 'san jose': 'sjc',
  sac: 'sac', sacramento: 'sac', smf: 'sac', sf: 'sf', 'san francisco': 'sf',
  'downtown sf': 'sf', reno: 'reno', tahoe: 'reno', rno: 'reno'
};
const BANDS = ['morning', 'midday', 'evening', 'friday'];
const CM_DATA = {
  murphys: { town: 'Murphys',      lat: 38.1385, lng: -120.4610, cells: [[198,140,222,185],[168,124,194,158],[204,146,228,190],[92,78,106,98],[214,140,238,198],[190,184,198,220]] },
  arnold:  { town: 'Arnold',       lat: 38.2555, lng: -120.3508, cells: [[225,168,250,212],[196,150,222,186],[230,172,254,218],[112,98,128,118],[240,168,264,224],[148,142,158,178]] },
  angels:  { town: 'Angels Camp',  lat: 38.0682, lng: -120.5388, cells: [[182,126,206,170],[152,108,178,142],[188,130,212,174],[80,68,94,86],[198,126,222,182],[174,168,182,202]] },
  copper:  { town: 'Copperopolis', lat: 37.9805, lng: -120.6388, cells: [[166,114,190,154],[136,96,162,128],[172,118,196,160],[68,58,80,74],[182,114,206,166],[164,158,172,192]] },
  sutter:  { town: 'Sutter Creek', lat: 38.3927, lng: -120.8022, cells: [[156,110,182,148],[126,94,156,122],[164,112,188,152],[58,48,70,64],[174,110,198,160],[182,176,190,210]] }
};
const TOWN_ALIAS = {
  murphys: 'murphys', arnold: 'arnold', 'angels camp': 'angels', angels: 'angels',
  copperopolis: 'copper', copper: 'copper', 'sutter creek': 'sutter', sutter: 'sutter'
};
function townKey(s) {
  const k = String(s || '').trim().toLowerCase();
  if (!k) return null;
  if (CM_DATA[k]) return k;
  if (TOWN_ALIAS[k]) return TOWN_ALIAS[k];
  for (const a in TOWN_ALIAS) if (k.indexOf(a) === 0) return TOWN_ALIAS[a];
  return null;
}
function destKey(s) {
  const k = String(s || '').trim().toLowerCase();
  return DEST_ALIAS[k] || (DEST_META[k] ? k : null);
}
const bandIdx = (b) => { const i = BANDS.indexOf(String(b || 'midday').toLowerCase()); return i < 0 ? 1 : i; };

// ---- provider helpers -------------------------------------------------------
async function jget(url, headers) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { headers: headers || {}, signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; } finally { clearTimeout(t); }
}

// Next future Unix seconds for a departure band (US Pacific-ish, server local).
function departUnix(band) {
  const now = new Date();
  const d = new Date(now.getTime());
  const setT = (h, m) => { d.setHours(h, m || 0, 0, 0); if (d <= now) d.setDate(d.getDate() + 1); };
  if (band === 'morning') setT(8, 0);
  else if (band === 'evening') setT(17, 15);
  else if (band === 'friday') { setT(16, 30); while (d.getDay() !== 5) d.setDate(d.getDate() + 1); }
  else setT(12, 30); // midday / default
  return Math.floor(d.getTime() / 1000);
}

async function googleGeocode(key, q) {
  const u = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&region=us&components=country:US&key=${key}`;
  const j = await jget(u);
  const g = j?.results?.[0];
  return g ? { lat: g.geometry.location.lat, lng: g.geometry.location.lng, label: g.formatted_address } : null;
}
async function googleDrive(key, from, to, band) {
  const dep = departUnix(band);
  const u = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${from.lat},${from.lng}&destinations=${to.lat},${to.lng}`
    + `&mode=driving&departure_time=${dep}&traffic_model=pessimistic&units=imperial&key=${key}`;
  const j = await jget(u);
  const el = j?.rows?.[0]?.elements?.[0];
  if (!el || el.status !== 'OK') return null;
  const secs = (el.duration_in_traffic || el.duration)?.value;
  const meters = el.distance?.value;
  return secs ? { minutes: Math.round(secs / 60), distance_mi: meters ? Math.round(meters / 1609.34) : null } : null;
}
async function orsGeocode(key, q) {
  const u = `https://api.openrouteservice.org/geocode/search?api_key=${key}&text=${encodeURIComponent(q)}&boundary.country=US&size=1`;
  const j = await jget(u);
  const f = j?.features?.[0];
  return f ? { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], label: f.properties?.label || q } : null;
}
async function orsDrive(key, from, to) {
  const u = `https://api.openrouteservice.org/v2/directions/driving-car?api_key=${key}`
    + `&start=${from.lng},${from.lat}&end=${to.lng},${to.lat}`;
  const j = await jget(u);
  const sum = j?.features?.[0]?.properties?.summary;
  if (!sum) return null;
  return { minutes: Math.round(sum.duration / 60), distance_mi: sum.distance ? Math.round(sum.distance / 1609.34) : null };
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');

  const from = (req.query?.from || '').toString().trim();
  const to   = (req.query?.to || '').toString().trim();
  const band = (req.query?.depart || 'midday').toString().trim().toLowerCase();
  if (!from || !to) return fail(res, 400, 'from and to are required');

  try {
    // 1. Honest-log answer when both ends are modelled ---------------------
    const tk = townKey(from), dk = destKey(to);
    if (tk && dk) {
      const di = DEST_KEYS.indexOf(dk);
      const row = CM_DATA[tk].cells[di];
      const bands = BANDS.map((b, i) => ({ key: b, minutes: row[i] }));
      return ok(res, {
        ok: true, provider: 'legacy-logs',
        from: { label: CM_DATA[tk].town, town: tk },
        to:   { label: DEST_META[dk].label, dest: dk },
        minutes: row[bandIdx(band)],
        bands,
        distance_mi: null,
        note: "Sara's real-log time — time-of-day aware, from actual drives."
      });
    }

    // 2. Live routing provider --------------------------------------------
    const gkey = process.env.GOOGLE_MAPS_API_KEY;
    const okey = process.env.ORS_API_KEY;
    // Let a modelled endpoint resolve to its known coordinates without geocoding.
    const resolveEnd = async (q, geocode) => {
      const t = townKey(q); if (t) return { lat: CM_DATA[t].lat, lng: CM_DATA[t].lng, label: CM_DATA[t].town };
      const d = destKey(q); if (d) return { lat: DEST_META[d].lat, lng: DEST_META[d].lng, label: DEST_META[d].label };
      return geocode ? await geocode(q) : null;
    };

    if (gkey) {
      const a = await resolveEnd(from, (q) => googleGeocode(gkey, q));
      const b = await resolveEnd(to,   (q) => googleGeocode(gkey, q));
      if (!a || !b) return ok(res, { ok: false, error: 'could_not_locate', from_ok: !!a, to_ok: !!b });
      const dr = await googleDrive(gkey, a, b, band);
      if (!dr) return ok(res, { ok: false, error: 'no_route' });
      return ok(res, { ok: true, provider: 'google', from: { label: a.label }, to: { label: b.label }, minutes: dr.minutes, distance_mi: dr.distance_mi, bands: null });
    }
    if (okey) {
      const a = await resolveEnd(from, (q) => orsGeocode(okey, q));
      const b = await resolveEnd(to,   (q) => orsGeocode(okey, q));
      if (!a || !b) return ok(res, { ok: false, error: 'could_not_locate', from_ok: !!a, to_ok: !!b });
      const dr = await orsDrive(okey, a, b);
      if (!dr) return ok(res, { ok: false, error: 'no_route' });
      return ok(res, { ok: true, provider: 'ors', from: { label: a.label }, to: { label: b.label }, minutes: dr.minutes, distance_mi: dr.distance_mi, bands: null, note: 'Free-flow drive time (no live traffic).' });
    }

    // 3. No provider configured -------------------------------------------
    return ok(res, {
      ok: false, configured: false,
      error: 'commute_lookup_not_configured',
      note: 'Statewide lookups need a Google Maps or OpenRouteService key. The five foothill towns work without one.'
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
