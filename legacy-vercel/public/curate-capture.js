/* CRM "curate" capture overlay — shared by property-search.html and listing.html.
   Inert for public visitors: it only activates when the CRM opens the page with
   ?capture=<collectionId> (the agent picking listings for a client collection).
   The target collection is stashed in sessionStorage (Kestrel rewrites the query
   string as it navigates, so the param can't be trusted to persist) and our
   params are stripped from the URL so iHomefinder's own routing is untouched.

   IMPORTANT: Kestrel renders the whole widget inside an OPEN SHADOW ROOT on
   div.ihf-container. document.querySelectorAll() never sees the listing cards,
   and a MutationObserver on document.body never fires for widget re-renders —
   both must target the shadow root itself. Listing cards carry stable classes
   (.ihf-listing-result-cell, .ihf-listing-result-price, …) and each card links
   to /listing?id=<MLS>_<board>, which is the most reliable source of the MLS#. */
(function () {
  'use strict';
  var KEY = 'legacyCaptureCollection';
  var qs = new URLSearchParams(location.search);

  // Seed sessionStorage from the launch URL, then remove our params so they
  // don't interfere with Kestrel's query-string routing.
  if (qs.has('capture')) {
    try {
      sessionStorage.setItem(KEY, JSON.stringify({
        id: qs.get('capture') || '',
        title: qs.get('title') || 'this collection'
      }));
    } catch (e) {}
    qs.delete('capture'); qs.delete('title');
    var clean = location.pathname + (qs.toString() ? '?' + qs.toString() : '') + location.hash;
    try { history.replaceState(null, '', clean); } catch (e) {}
  }

  var target = null;
  try { target = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) {}
  if (!target || !target.id) return; // public visitor — do nothing at all.

  var isDetailPage = /^\/listing(\.html)?$/.test(location.pathname);

  // ---- capture bar ----------------------------------------------------------
  var bar = document.createElement('div');
  bar.style.cssText = 'position:sticky;top:0;z-index:99998;display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 16px;background:#1A1714;color:#FAF6EC;box-shadow:0 2px 12px rgba(0,0,0,.25);font-family:system-ui,sans-serif;';
  bar.innerHTML =
    '<b style="font-size:14px;">Add to collection</b>' +
    '<span style="color:#C9BEA8;font-size:12px;">“' + String(target.title).replace(/</g, '&lt;') + '”</span>' +
    '<span style="flex:1 1 40px;"></span>' +
    (isDetailPage
      ? '<button type="button" id="lgcCaptureThis" style="background:#B08D57;color:#1A1714;border:none;border-radius:8px;padding:8px 15px;font-size:12px;font-weight:600;cursor:pointer;">＋ Add this listing</button>'
      : '<span style="color:#C9BEA8;font-size:12px;">Click “＋ Add to collection” on any listing</span>') +
    '<label id="lgcHideWrap" style="display:none;align-items:center;gap:6px;font-size:12px;color:#C9BEA8;cursor:pointer;">' +
      '<input type="checkbox" id="lgcHideRejected" style="cursor:pointer;"> Hide rejected &amp; already sent</label>' +
    '<span id="lgcCaptureCount" style="font-size:12px;font-weight:700;color:#8FCF9F;">0 added</span>' +
    '<button type="button" id="lgcCaptureStop" style="background:#2E5C3D;color:#FAF6EC;border:none;border-radius:8px;padding:8px 15px;font-size:12px;font-weight:600;cursor:pointer;">Done — back to collection</button>';
  document.body.insertBefore(bar, document.body.firstChild);

  var addedCount = 0;
  function bumpCount() {
    addedCount++;
    var el = bar.querySelector('#lgcCaptureCount');
    if (el) el.textContent = addedCount + ' added';
  }

  bar.querySelector('#lgcCaptureStop').addEventListener('click', function () {
    try { sessionStorage.removeItem(KEY); } catch (e) {}
    // Return to THIS collection in the CRM so the new picks are visible right
    // away — no more guessing whether anything landed, and no stale picker page
    // pointed at an old/deleted collection.
    location.href = '/crm.html?curate=' + encodeURIComponent(target.id);
  });
  var detailBtn = bar.querySelector('#lgcCaptureThis');
  if (detailBtn) detailBtn.addEventListener('click', function () { onAdd(null, detailBtn); });

  function toast(msg, good) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:100000;padding:11px 18px;border-radius:10px;font-size:13px;color:#FAF6EC;box-shadow:0 6px 24px rgba(0,0,0,.3);background:' + (good ? '#2E5C3D' : '#8A3B2B') + ';';
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2600);
  }

  // ---- shadow-root plumbing -------------------------------------------------
  function widgetRoots() {
    var out = [];
    document.querySelectorAll('.ihf-container').forEach(function (host) {
      if (host.shadowRoot) out.push(host.shadowRoot);
    });
    return out;
  }

  // ---- scraping ---------------------------------------------------------------
  function txt(scope, sel) {
    var n = scope.querySelector(sel);
    return n ? (n.textContent || '').trim() : null;
  }
  function num(v) { return v ? (String(v).replace(/[^0-9.]/g, '') || null) : null; }

  // A URL that is the widget's own logo / "no photo" placeholder, NOT a home's
  // photo. The IDX grid lazy-loads images and shows the MetroList logo until the
  // real photo arrives, so a naive scrape captures the logo (324 Augusta / Bev's
  // lakefront collection: 7 of 8 tiles showed the red MetroList mark).
  function isPlaceholderPhoto(u) {
    // Skip the IDX logo/"no photo" placeholder (idx-logos.idxhome.com/…) but NOT
    // a real listing photo — real MetroList photos live at mediarem.metrolist.net
    // and their URL contains "metrolist", so never key off that word.
    return !u || /^data:|idx-logos|\blogo\b|logos?\/|placeholder|no[-_ ]?photo|no[-_ ]?image|coming[-_ ]?soon|\/blank|spacer|1x1/i.test(u);
  }
  function absUrl(u) {
    try { return u.indexOf('http') === 0 ? u : new URL(u, location.href).href; } catch (e) { return u; }
  }
  // Pull a url(...) out of an element's computed background-image. IDX grid cards
  // paint the hero as a CSS background on a <div> (NOT an <img>), so a photo that
  // is plainly visible on screen has no <img> to read — this is why captures made
  // with the photo clearly showing still landed with no photo. We read the
  // background too. background-image can hold multiple layers / gradients;
  // take the first real image url.
  function bgUrl(el) {
    try {
      var bg = getComputedStyle(el).backgroundImage || '';
      var m = bg.match(/url\((['"]?)(.*?)\1\)/);
      return m ? m[2] : '';
    } catch (e) { return ''; }
  }
  // Grab the REAL listing photo. Look in three places, first real hit wins:
  //   1) <img> — prefer the lazy-load target (data-src / srcset) over the visible
  //      src (often the placeholder); also read <picture><source srcset>.
  //   2) CSS background-image on the card and its descendants (the grid cards).
  // Skip any URL that looks like a logo/placeholder. Returns null when only a
  // placeholder is present, so we never store the logo as a home's photo.
  function pickPhoto(scope) {
    var imgs = scope.querySelectorAll('img, source');
    for (var i = 0; i < imgs.length; i++) {
      var im = imgs[i];
      var cand = im.getAttribute('data-src') || im.getAttribute('data-lazy-src') || im.getAttribute('data-original') || '';
      var ss = im.getAttribute('srcset') || im.getAttribute('data-srcset');
      if (ss) { var parts = ss.split(',').map(function (s) { return s.trim().split(/\s+/)[0]; }).filter(Boolean); if (parts.length) cand = parts[parts.length - 1]; }
      if (!cand) cand = im.currentSrc || im.getAttribute('src') || '';
      if (cand && !isPlaceholderPhoto(cand)) return absUrl(cand);
    }
    // No usable <img> — try background-image on the card, then its descendants.
    var b = bgUrl(scope);
    if (b && !isPlaceholderPhoto(b)) return absUrl(b);
    var kids = scope.querySelectorAll('*');
    for (var k = 0; k < kids.length; k++) {
      var kb = bgUrl(kids[k]);
      if (kb && !isPlaceholderPhoto(kb)) return absUrl(kb);
    }
    return null;
  }

  // Just the MLS number off a result card. Split out of scrapeCard because the
  // history badges re-read every visible card on each widget re-render, and
  // scrapeCard also runs pickPhoto, which walks every descendant of the card —
  // far too heavy to repeat across a whole grid several times a minute.
  function cardMls(card) {
    var a = card.querySelector('a[href*="listing"]');
    var idm = a ? (a.getAttribute('href') || '').match(/[?&]id=([A-Za-z0-9]+)/) : null;
    return idm ? idm[1].split('_')[0]
               : ((txt(card, '.ihf-listing-result-number') || '').replace(/[^A-Za-z0-9-]/g, '') || null);
  }

  function scrapeCard(card) {
    var mls = cardMls(card);
    var streets = card.querySelectorAll('.ihf-gallery-street-name');
    var cityLine = streets[1] ? (streets[1].textContent || '').trim() : '';
    var cm = cityLine.match(/^(.*?),\s*([A-Z]{2})\s+(\d{5})/);
    var photo = pickPhoto(card);
    return {
      mls_number: mls,
      address: streets[0] ? (streets[0].textContent || '').trim() : null,
      city: cm ? cm[1].trim() : null,
      state: cm ? cm[2] : 'CA',
      zip: cm ? cm[3] : null,
      price: txt(card, '.ihf-listing-result-price'),
      beds: num(txt(card, '.ihf-listing-result-bed')),
      baths: num(txt(card, '.ihf-listing-result-bath')),
      sqft: num(txt(card, '.ihf-listing-result-sqft')),
      photo: photo
    };
  }

  // Detail page: the MLS# is in the URL (?id=<MLS>_<board>) and the address is
  // the document title ("324 Augusta Court Valley Springs, CA 95252").
  function scrapeDetail() {
    var idm = location.search.match(/[?&]id=([A-Za-z0-9]+)/);
    var mls = idm ? idm[1].split('_')[0] : null;
    var root = widgetRoots()[0];
    // Address comes as two elements: .listing-address-1 ("467 Skyline Drive")
    // and .listing-address-2 ("Arnold, CA 95223"). The document title mashes
    // them together with no comma, so it can't be split reliably.
    var street = root ? txt(root, '.listing-address-1') : null;
    var line2 = (root ? txt(root, '.listing-address-2') : null) || '';
    var cm = line2.match(/^(.*?),\s*([A-Z]{2})\s+(\d{5})/);
    // The detail layout has semantic containers (.bedrooms, .bathrooms,
    // .square-feet, .list-price) whose text is "<value><label>", e.g.
    // "1Bedrooms" / "110Square Feet" / "List Price$89,500". Never regex the
    // whole shadow text — it concatenates without spaces, so "Listing
    // #2260716031Bedrooms" would bleed the MLS# into the bed count.
    function field(sel, re) {
      if (!root) return null;
      var n = root.querySelector(sel);
      if (!n) return null;
      var x = (n.textContent || '').match(re);
      return x ? x[1].replace(/,/g, '') : null;
    }
    return {
      mls_number: mls || (field('.listing-number', /#\s*([A-Za-z0-9-]+)/) || null),
      address: street || (document.title || '').trim() || null,
      city: cm ? cm[1].trim() : null,
      state: cm ? cm[2] : 'CA',
      zip: cm ? cm[3] : null,
      price: field('.list-price', /(\$[\d,]{3,})/),
      beds: field('.bedrooms', /^\s*(\d{1,2})/),
      baths: field('.bathrooms', /^\s*(\d{1,2}(?:\.\d+)?)/),
      sqft: field('.square-feet', /^\s*([\d,]{2,})/),
      photo: root ? pickPhoto(root) : null
    };
  }

  // ---- add ------------------------------------------------------------------
  function onAdd(card, btn) {
    var listing = card ? scrapeCard(card) : scrapeDetail();
    if (!listing.mls_number && !listing.address) {
      toast('Couldn’t read that listing — open its Details page and add from there.', false);
      return;
    }
    var orig = btn.textContent; btn.textContent = 'Adding…'; btn.disabled = true;
    fetch('/api/curate/collections', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'capture-listing', collection_id: target.id, listing: listing })
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; }).catch(function () { return { ok: r.ok, status: r.status, j: {} }; }); })
      .then(function (r) {
        if (r.ok && r.j && r.j.listing) {
          btn.textContent = '✓ Added'; btn.style.background = '#2E5C3D'; btn.style.color = '#FAF6EC';
          bumpCount();
          toast('Added ' + (listing.address || listing.mls_number || 'listing') + ' to “' + target.title + '”.', true);
        } else if (r.status === 401) {
          btn.textContent = orig; btn.disabled = false;
          toast('Sign in to the CRM in this browser first, then try again.', false);
        } else if (r.status === 404) {
          // The target collection no longer exists (deleted, or this is a stale
          // picker page). Say so loudly — nothing is being saved — and point back
          // to the CRM to reopen "Add listings" on the live collection.
          btn.textContent = orig; btn.disabled = false;
          var c = bar.querySelector('#lgcCaptureCount');
          if (c) { c.textContent = 'collection is gone'; c.style.color = '#F0A58A'; }
          toast('This collection was deleted — go back to the CRM and click “Add listings” on the current one.', false);
        } else {
          btn.textContent = orig; btn.disabled = false;
          toast((r.j && r.j.error) || 'Could not add that listing.', false);
        }
      })
      .catch(function () { btn.textContent = orig; btn.disabled = false; toast('Network error — try again.', false); });
  }

  // ---- decorate results cards -------------------------------------------------
  // ---- client history on the result cards -----------------------------------
  // Mark a card the client has already turned down (red ✕) or already been sent
  // (muted tag), so the agent doesn't re-pick it. Flags are fetched in one batch
  // per set of newly-seen MLS numbers and cached for the life of the page.
  var flagCache = {};        // mls -> {rejected, rejected_at, already_sent}
  var flagPending = {};      // mls -> true while in flight
  var hideRejected = false;

  function fmtDate(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch (e) { return ''; }
  }

  function paintCard(card) {
    var mls = card.getAttribute('data-lgc-mls');
    var f = mls ? flagCache[mls] : null;
    var wrap = bar.querySelector('#lgcHideWrap');
    if (!f || (!f.rejected && !f.already_sent)) {
      var old = card.querySelector('[data-lgc-flag]');
      if (old) old.remove();
      card.style.opacity = '';
      card.style.display = '';
      return;
    }
    if (wrap) wrap.style.display = 'flex';   // there IS history worth filtering
    if (!card.querySelector('[data-lgc-flag]')) {
      var tag = document.createElement('div');
      tag.setAttribute('data-lgc-flag', '1');
      var rejected = !!f.rejected;
      var when = fmtDate(f.rejected_at);
      tag.textContent = rejected
        ? ('\u2715 Rejected' + (when ? ' \u00b7 ' + when : ''))
        : 'Already sent';
      tag.title = rejected
        ? 'This client marked this home "Not for me"' + (when ? ' on ' + when : '')
        : 'This home has already gone out to this client in another collection';
      tag.style.cssText = 'position:absolute;top:8px;right:8px;z-index:9999;border-radius:8px;padding:6px 10px;'
        + 'font-family:monospace;font-size:11px;letter-spacing:.05em;text-transform:uppercase;'
        + 'box-shadow:0 2px 10px rgba(0,0,0,.35);'
        + (rejected ? 'background:#9B2C2C;color:#fff;' : 'background:#EDE9E1;color:#6B6459;');
      card.appendChild(tag);
    }
    // Rejected cards are dimmed so they read as "seen and turned down" even with
    // the filter off; already-sent stays full strength (it's re-sendable).
    card.style.opacity = f.rejected ? '.55' : '';
    card.style.display = (hideRejected && (f.rejected || f.already_sent)) ? 'none' : '';
  }

  function repaintAll() {
    widgetRoots().forEach(function (root) {
      root.querySelectorAll('.ihf-listing-result-cell[data-lgc-mls]').forEach(paintCard);
    });
  }

  function fetchFlags(mlsList) {
    var want = mlsList.filter(function (m) { return m && !(m in flagCache) && !flagPending[m]; });
    if (!want.length) return;
    want.forEach(function (m) { flagPending[m] = true; });
    fetch('/api/curate/collections', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'listing-flags', collection_id: target.id, mls_numbers: want })
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var flags = (j && j.flags) || {};
        // Cache a miss as "clean" too, so a home with no history isn't re-asked
        // on every widget re-render.
        want.forEach(function (m) { flagCache[m] = flags[m] || { rejected: false, rejected_at: null, already_sent: false }; delete flagPending[m]; });
        repaintAll();
      })
      .catch(function () { want.forEach(function (m) { delete flagPending[m]; }); });
  }

  var hideBox = bar.querySelector('#lgcHideRejected');
  if (hideBox) hideBox.addEventListener('change', function () { hideRejected = !!hideBox.checked; repaintAll(); });

  function decorate() {
    var newMls = [];
    widgetRoots().forEach(function (root) {
      root.querySelectorAll('.ihf-listing-result-cell').forEach(function (card) {
        // Re-read the MLS number on every pass: Kestrel recycles card elements
        // between renders, so a card already decorated can now hold a different
        // listing and would otherwise keep the previous home's badge.
        var mls = null;
        try { mls = cardMls(card); } catch (e) {}
        if (mls && card.getAttribute('data-lgc-mls') !== mls) {
          card.setAttribute('data-lgc-mls', mls);
          var stale = card.querySelector('[data-lgc-flag]');
          if (stale) stale.remove();
        }
        if (mls) { newMls.push(mls); paintCard(card); }

        if (card.getAttribute('data-lgc-dec')) return;
        card.setAttribute('data-lgc-dec', '1');
        try { if (getComputedStyle(card).position === 'static') card.style.position = 'relative'; } catch (e) {}
        var btn = document.createElement('button');
        btn.type = 'button'; btn.textContent = '＋ Add to collection';
        btn.setAttribute('data-lgc-addbtn', '1');
        btn.style.cssText = 'position:absolute;top:8px;left:8px;z-index:9999;background:#1A1714;color:#FAF6EC;border:none;border-radius:8px;padding:8px 12px;font-family:monospace;font-size:11px;letter-spacing:.05em;text-transform:uppercase;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.35);';
        btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); onAdd(card, btn); });
        card.appendChild(btn);
      });
    });
    if (newMls.length) fetchFlags(newMls);
  }

  // Kestrel builds its shadow DOM asynchronously and re-renders on every
  // in-widget navigation (it's a React app routed off the query string, no page
  // reloads). Watch each shadow root once it exists; a light poll catches the
  // root appearing in the first place, and is also the safety net if a
  // mutation slips past the observer. Debounced so we run AFTER a re-render.
  var observed = [];
  var seen = typeof WeakSet === 'function' ? new WeakSet() : { has: function () { return false; }, add: function () {} };
  var t = null;
  function ensure() {
    widgetRoots().forEach(function (root) {
      if (seen.has(root)) return;
      seen.add(root);
      var obs = new MutationObserver(function () {
        clearTimeout(t); t = setTimeout(decorate, 400);
      });
      obs.observe(root, { childList: true, subtree: true });
      observed.push(obs);
    });
    decorate();
  }
  var pollTimer = setInterval(ensure, 1000);
  ensure();
})();
