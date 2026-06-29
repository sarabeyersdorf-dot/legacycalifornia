/* ============================================================
   town-map.js — Legacy Properties interactive town map
   Real Leaflet map (CARTO Positron tiles) with draggable,
   category-filtered markers. Pin positions persist to
   localStorage so Sara can place them and they stick; the
   "Copy coordinates" control exports the final layout as JSON
   to bake into the page for everyone.

   Requires: Leaflet (CSS + JS) loaded before this file.
   Usage:
     LegacyTownMap.init({
       town: 'murphys',
       center: [38.1378, -120.4585], zoom: 15,
       unit: 'spots',
       catMeta: { wine:{label:'Tasting rooms', letter:'W', color:'#8C6E3D'}, ... },
       pois: [ { name, cat, desc, lat, lng }, ... ]
     });
   ============================================================ */
window.LegacyTownMap = (function () {
  function init(cfg) {
    var canvas = document.getElementById('townMapCanvas');
    if (!canvas || typeof L === 'undefined') return;

    var storeKey = 'legacy:townmap:' + cfg.town;
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem(storeKey) || '{}'); } catch (e) { saved = {}; }

    var map = L.map(canvas, {
      center: cfg.center, zoom: cfg.zoom,
      scrollWheelZoom: false, zoomControl: true
    });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap &copy; CARTO',
      subdomains: 'abcd', maxZoom: 19
    }).addTo(map);

    var rail = {
      tag:  document.getElementById('msTag'),
      name: document.getElementById('msName'),
      desc: document.getElementById('msDesc'),
      count:document.getElementById('msCount')
    };

    var markers = [];
    var activeCat = 'all';

    function meta(cat){ return cfg.catMeta[cat] || { label:'', letter:'•', color:'#8C6E3D' }; }

    function icon(cat){
      var m = meta(cat);
      return L.divIcon({
        className: 'tm-pin-wrap',
        html: '<span class="tm-pin" style="background:' + m.color + '">' + m.letter + '</span>',
        iconSize: [30, 30], iconAnchor: [15, 15]
      });
    }

    function showInRail(p){
      var m = meta(p.cat);
      if (rail.tag)  rail.tag.textContent = m.label;
      if (rail.name) rail.name.textContent = p.name;
      if (rail.desc) rail.desc.textContent = p.desc;
    }

    cfg.pois.forEach(function (p) {
      var pos = saved[p.name] || [p.lat, p.lng];
      var mk = L.marker(pos, { icon: icon(p.cat), draggable: true, keyboard: true });
      mk._poi = p;
      mk.addTo(map);
      mk.on('mouseover', function(){ showInRail(p); });
      mk.on('click',     function(){ showInRail(p); });
      mk.on('dragend', function(){
        var ll = mk.getLatLng();
        saved[p.name] = [ +ll.lat.toFixed(6), +ll.lng.toFixed(6) ];
        try { localStorage.setItem(storeKey, JSON.stringify(saved)); } catch(e){}
        flash('Saved “' + p.name + '” · ' + saved[p.name][0] + ', ' + saved[p.name][1]);
      });
      mk.bindTooltip(p.name, { direction: 'top', offset: [0, -14], className: 'tm-tip' });
      markers.push(mk);
    });

    // Frame all pins — but only once the container actually has a size.
    // (The map sits far down the page; fitting before layout breaks the view.)
    function frameToPins(){
      if (!cfg.fitToPins || !markers.length) return;
      try {
        map.invalidateSize(true);
        map.fitBounds(L.featureGroup(markers).getBounds(), { padding: [40, 40], maxZoom: cfg.fitMaxZoom || 13 });
      } catch (e) {}
    }
    function frameWhenSized(tries){
      var el = canvas;
      if (el && el.clientHeight > 50) { frameToPins(); return; }
      if (tries > 0) setTimeout(function(){ frameWhenSized(tries - 1); }, 120);
    }

    function applyFilter(cat){
      activeCat = cat;
      var n = 0;
      markers.forEach(function(mk){
        var on = (cat === 'all' || mk._poi.cat === cat);
        if (on) { mk.addTo(map); n++; } else { map.removeLayer(mk); }
      });
      if (rail.count) rail.count.textContent = n + ' ' + (cfg.unit || 'spots');
    }

    // Wire existing .ms-filter buttons
    var filters = document.querySelectorAll('.ms-filter');
    filters.forEach(function(btn){
      btn.addEventListener('click', function(){
        filters.forEach(function(b){ b.classList.toggle('ms-on', b === btn); });
        applyFilter(btn.dataset.cat);
      });
    });
    applyFilter('all');

    // ── Editor bar (drag-to-place helper for Sara) ──────────────
    var bar = document.getElementById('tmEditor');
    if (bar) {
      var msg = bar.querySelector('.tm-editor-msg');
      var copyBtn = bar.querySelector('[data-act="copy"]');
      var resetBtn = bar.querySelector('[data-act="reset"]');
      window.__tmFlash = msg;
      if (copyBtn) copyBtn.addEventListener('click', function(){
        // Merge saved overrides onto defaults → full layout
        var out = cfg.pois.map(function(p){
          var pos = saved[p.name] || [p.lat, p.lng];
          return { name: p.name, cat: p.cat, lat: pos[0], lng: pos[1] };
        });
        var json = JSON.stringify(out, null, 2);
        navigator.clipboard && navigator.clipboard.writeText(json).then(
          function(){ flash('Copied ' + out.length + ' pin coordinates to clipboard.'); },
          function(){ window.prompt('Copy these coordinates:', json); }
        );
      });
      if (resetBtn) resetBtn.addEventListener('click', function(){
        try { localStorage.removeItem(storeKey); } catch(e){}
        saved = {};
        markers.forEach(function(mk){ mk.setLatLng([mk._poi.lat, mk._poi.lng]); });
        flash('Reset to default positions.');
      });
    }

    function flash(t){
      if (window.__tmFlash) {
        window.__tmFlash.textContent = t;
        window.__tmFlash.classList.add('on');
        clearTimeout(flash._t);
        flash._t = setTimeout(function(){ window.__tmFlash.classList.remove('on'); }, 3200);
      }
    }

    map.whenReady(function(){
      setTimeout(function(){ map.invalidateSize(true); frameWhenSized(30); }, 120);
    });
    window.addEventListener('load', function(){ map.invalidateSize(true); frameWhenSized(20); });
    // Refit once the canvas first becomes visible / sized (covers tabs, lazy layout)
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function(){
        if (canvas.clientHeight > 50) { map.invalidateSize(true); frameToPins(); ro.disconnect(); }
      });
      ro.observe(canvas);
    }
  }

  return { init: init };
})();
