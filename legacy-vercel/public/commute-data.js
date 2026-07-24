/* commute-data.js — Legacy Properties commute intelligence, shared across pages.
   Attaches window.LegacyCommute. No build step (plain <script>), same pattern
   as idx-client.js.

   TWO layers:
   1. Sara's real-log matrix (CM_DATA) — honest, time-of-day drive times from
      the foothill towns she works, sourced from actual client drives, NOT a
      maps API's optimistic midday number. Add more towns here anytime — the
      widget and curated commute both read from this first.
   2. Universal fallback — for any origin/destination not in the matrix, the
      /api/commute endpoint fills in live drive times from a routing provider
      (Google Maps / OpenRouteService) once a key is configured.

   TO ADD A TOWN: add an entry to CM_DATA (6 destinations × 4 time-of-day bands,
   minutes) and, optionally, a CM_SARA note. Keep the destination/band order. */
(function (root) {
  'use strict';

  // Destinations — order matches every CM_DATA `cells` row.
  var DESTS = [
    { key: 'sfo',  label: 'SFO',         sub: "SF Int'l Airport",  lat: 37.6213, lng: -122.3790 },
    { key: 'oak',  label: 'OAK',         sub: 'Oakland Airport',   lat: 37.7126, lng: -122.2197 },
    { key: 'sjc',  label: 'SJC',         sub: 'San Jose · downtown', lat: 37.3639, lng: -121.9289 },
    { key: 'sac',  label: 'SAC',         sub: 'Sacramento (SMF)',  lat: 38.6951, lng: -121.5908 },
    { key: 'sf',   label: 'Downtown SF', sub: 'Financial District', lat: 37.7946, lng: -122.3999 },
    { key: 'reno', label: 'Reno-Tahoe',  sub: 'Reno Airport (RNO)', lat: 39.4991, lng: -119.7681 }
  ];

  // Time-of-day bands — order matches each destination's 4-value array.
  var BANDS = [
    { key: 'morning', label: 'Morning peak',       sub: '7–9 a.m.' },
    { key: 'midday',  label: 'Mid-day',            sub: 'baseline' },
    { key: 'evening', label: 'Evening peak',       sub: '4–6:30 p.m.' },
    { key: 'friday',  label: 'Fri p.m. escape',    sub: '2:30–7 p.m.' }
  ];

  // Sara's real-log matrix. cells[destIdx][bandIdx] = minutes.
  var CM_DATA = {
    murphys: { town: 'Murphys',      from: 'Murphys, CA · 2,140 ft',   lat: 38.1385, lng: -120.4610,
      cells: [[198,140,222,185],[168,124,194,158],[204,146,228,190],[92,78,106,98],[214,140,238,198],[190,184,198,220]] },
    arnold:  { town: 'Arnold',       from: 'Arnold, CA · 4,100 ft',    lat: 38.2555, lng: -120.3508,
      cells: [[225,168,250,212],[196,150,222,186],[230,172,254,218],[112,98,128,118],[240,168,264,224],[148,142,158,178]] },
    angels:  { town: 'Angels Camp',  from: 'Angels Camp, CA · 1,380 ft', lat: 38.0682, lng: -120.5388,
      cells: [[182,126,206,170],[152,108,178,142],[188,130,212,174],[80,68,94,86],[198,126,222,182],[174,168,182,202]] },
    copper:  { town: 'Copperopolis', from: 'Copperopolis, CA · 780 ft', lat: 37.9805, lng: -120.6388,
      cells: [[166,114,190,154],[136,96,162,128],[172,118,196,160],[68,58,80,74],[182,114,206,166],[164,158,172,192]] },
    sutter:  { town: 'Sutter Creek', from: 'Sutter Creek, CA · 1,200 ft', lat: 38.3927, lng: -120.8022,
      cells: [[156,110,182,148],[126,94,156,122],[164,112,188,152],[58,48,70,64],[174,110,198,160],[182,176,190,210]] }
  };

  var CM_SARA = {
    murphys: 'If you only need the East Bay twice a week, this is workable — leave at 6:15 a.m. and you beat the metering. The brutal trip is Friday evening, Oakland → home; budget three-plus hours. SAC is the surprise: the most reliable airport from up here.',
    arnold:  'The honest answer: from Arnold the Bay commute is for emergencies and Tuesdays, not daily. SAC, on the other hand, is under two hours and basically traffic-proof.',
    angels:  'Angels Camp is the geographic sweet spot — quickest to the Bay, quickest to SAC, still in the foothills. If your job mandates 3+ in-office days, look here first.',
    copper:  'Copperopolis is the most commute-friendly in the county, and it shows in the price. If you\'re still doing 4 days in-office, Copper is the most rational pick by a wide margin.',
    sutter:  'Sutter routes through Jackson and HWY 88 — faster to Sacramento than Murphys, slower to the Bay. The Amador wineries are a meaningful trade-off the other direction.'
  };

  function minsToHM(n) {
    if (n == null || isNaN(n)) return '—';
    var h = Math.floor(n / 60), m = Math.round(n % 60);
    return h > 0 ? (h + ':' + String(m).padStart(2, '0')) : (m + ' min');
  }
  // Congestion level for colour bands: good | okay | tough | bad.
  function level(n) {
    if (n == null) return 'na';
    if (n < 90)  return 'good';
    if (n < 150) return 'good';
    if (n < 180) return 'okay';
    if (n < 210) return 'tough';
    return 'bad';
  }

  // Normalise a free-text city/town string to a CM_DATA key (or null).
  var ALIAS = {
    murphys: 'murphys', arnold: 'arnold', 'angels camp': 'angels', angels: 'angels',
    copperopolis: 'copper', copper: 'copper', 'sutter creek': 'sutter', sutter: 'sutter'
  };
  function normTown(s) {
    var k = String(s || '').trim().toLowerCase();
    if (!k) return null;
    if (CM_DATA[k]) return k;
    if (ALIAS[k]) return ALIAS[k];
    // loose contains match (e.g. "Murphys, CA")
    for (var alias in ALIAS) if (k.indexOf(alias) === 0) return ALIAS[alias];
    return null;
  }
  function destIndex(destKey) {
    for (var i = 0; i < DESTS.length; i++) if (DESTS[i].key === destKey) return i;
    return -1;
  }
  function bandIndex(bandKey) {
    for (var i = 0; i < BANDS.length; i++) if (BANDS[i].key === bandKey) return i;
    return 1; // default mid-day
  }

  // Honest-matrix lookup: minutes for a town→destination at a band, or null.
  function lookup(townKey, destKey, bandKey) {
    var t = CM_DATA[normTown(townKey) || townKey];
    var di = destIndex(destKey);
    if (!t || di < 0) return null;
    var bi = bandIndex(bandKey);
    var row = t.cells[di];
    return row ? row[bi] : null;
  }

  var TOWNS = Object.keys(CM_DATA).map(function (k) {
    return { key: k, town: CM_DATA[k].town, from: CM_DATA[k].from, lat: CM_DATA[k].lat, lng: CM_DATA[k].lng };
  });

  root.LegacyCommute = {
    CM_DATA: CM_DATA, CM_SARA: CM_SARA, DESTS: DESTS, BANDS: BANDS, TOWNS: TOWNS,
    minsToHM: minsToHM, level: level, normTown: normTown, lookup: lookup,
    destIndex: destIndex, bandIndex: bandIndex
  };
})(typeof window !== 'undefined' ? window : this);
