/* ==========================================================================
   LEGACY UI — motion runtime
   Legacy Properties · legacycalifornia.com
   Companion to legacy-ui.css. Built 2026-07-29 from Ledger_August_2026.

   WHAT THIS DOES
   ---------------------------------------------------------------------------
   1. Marks <html class="lg-js"> so CSS knows JS is alive (see note below)
   2. Sets data-season from the current month, so the palette follows the year
   3. Reveals .lg-rv elements on scroll (IntersectionObserver)
   4. Wipes .lg-stat__value into view — WITHOUT ever altering the digits
   5. Parallaxes .lg-ridge layers in the hero
   6. Drives the .lg-progress reading bar
   7. Duplicates .lg-ticker__track content for a seamless loop
   8. Wires the mobile nav toggle

   WHY THE lg-js CLASS MATTERS
   ---------------------------------------------------------------------------
   .lg-rv starts at opacity 0. If this file 404s or throws, every revealed
   element on the page would be permanently invisible — a blank site. So the
   hiding rule in CSS is scoped to .lg-js, which only exists once this script
   runs. No JS, blocked JS, or a syntax error in a future edit all degrade to
   "everything visible, nothing animated". Keep it that way.

   HOW TO LOAD
   ---------------------------------------------------------------------------
   <script src="/legacy-ui.js" defer></script>
   defer, not async — needs the DOM. Safe to load on every page; it no-ops on
   pages with none of these classes. It attaches exactly one scroll listener,
   rAF-throttled, and disconnects each observer after it fires.

   WHAT THIS DOES NOT DO
   ---------------------------------------------------------------------------
   No data fetching, no form handling, no routing, no DOM restructuring. It
   never reads or writes text content except the ticker clone. It does not
   touch anything with a data-bind attribute. Keep it that way — legacy-client.js
   owns behaviour, this file owns motion, and the two must not overlap.
========================================================================== */
(function () {
  'use strict';

  var root    = document.documentElement;
  var REDUCED = window.matchMedia &&
                window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  root.classList.add('lg-js');

  /* ------------------------------------------------------------------
     1. SEASON
     Northern-hemisphere foothills. Override by hard-coding data-season
     on <html> in the markup — an explicit attribute always wins.
  ------------------------------------------------------------------ */
  function applySeason() {
    if (root.hasAttribute('data-season') || document.body.hasAttribute('data-season')) return;
    var m = new Date().getMonth() + 1;               // 1-12
    var s = (m >= 3 && m <= 5)  ? 'spring'
          : (m >= 6 && m <= 8)  ? 'summer'
          : (m >= 9 && m <= 11) ? 'autumn'
          :                       'winter';
    root.setAttribute('data-season', s);
  }

  /* ------------------------------------------------------------------
     2. REVEALS
     Exported as window.lgReveal so pages that inject markup after load
     (search results, listing grids, dashboard panels) can re-scan just
     their new subtree: lgReveal(container).
  ------------------------------------------------------------------ */
  function reveal(scope) {
    var els = (scope || document).querySelectorAll('.lg-rv:not(.is-in)');
    if (!els.length) return;

    if (REDUCED || !('IntersectionObserver' in window)) {
      for (var i = 0; i < els.length; i++) els[i].classList.add('is-in');
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.classList.add('is-in');
        io.unobserve(en.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });

    for (var j = 0; j < els.length; j++) io.observe(els[j]);
  }

  /* ------------------------------------------------------------------
     3. STAT VALUES

     *** DO NOT ADD A COUNT-UP HERE ***
     We built one, shipped it to review, and pulled it. Mid-animation a
     $500,000 median displayed as "$482,590". A reader glancing while
     scrolling, or screenshotting to send to someone, or an AI crawler
     reading the page, could all capture a figure that was never true —
     under a licensed agent's name, on a page whose whole promise is that
     the numbers are sourced.

     The animation is on the CONTAINER: the value is clipped and offset,
     then wipes up. The text node is never written to. Correct in frame
     one, correct in every frame after.

     If someone later asks for "the numbers to count up", the answer is
     no, and this comment is why.

     *** AND DO NOT OBSERVE THE VALUE ELEMENT ITSELF ***
     The first version of this did, and it deadlocked. `.lg-stat__value`
     starts at `clip-path: inset(0 0 100% 0)`. Chrome factors an element's
     own clip-path into its intersection rectangle, so a fully on-screen
     value reported intersectionRatio 0 — forever. The element hid itself,
     which stopped the observer from ever noticing it, which meant it was
     never unhidden. Result: a By the Numbers section with no numbers in it,
     which shipped to review before it was caught.

     So: observe the CONTAINER (.lg-stat — unclipped, has real area) and set
     the class on the value inside it. Any future "reveal by clipping"
     effect has the same trap. Observe an unclipped ancestor.
  ------------------------------------------------------------------ */
  function stats(scope) {
    var tiles = (scope || document).querySelectorAll('.lg-stat');
    if (!tiles.length) return;

    function show(tile) {
      var vals = tile.querySelectorAll('.lg-stat__value');
      for (var k = 0; k < vals.length; k++) vals[k].classList.add('is-shown');
    }

    if (REDUCED || !('IntersectionObserver' in window)) {
      for (var i = 0; i < tiles.length; i++) show(tiles[i]);
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        show(en.target);                       // class only. never textContent.
        io.unobserve(en.target);
      });
    }, { threshold: 0.25 });

    for (var j = 0; j < tiles.length; j++) io.observe(tiles[j]);
  }

  /* ------------------------------------------------------------------
     4. TICKER
     The CSS slides the track -50%, which only loops seamlessly if the
     content is present exactly twice. We clone here rather than asking
     every template to duplicate its own markup.
     aria-hidden because a screen reader should not read a marquee twice;
     make sure the same information exists in real content elsewhere.
  ------------------------------------------------------------------ */
  function ticker() {
    var tracks = document.querySelectorAll('.lg-ticker__track:not([data-lg-cloned])');
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      if (!t.children.length) continue;
      t.setAttribute('data-lg-cloned', '1');
      t.innerHTML += t.innerHTML;
      var wrap = t.closest('.lg-ticker');
      if (wrap) wrap.setAttribute('aria-hidden', 'true');
    }
  }

  /* ------------------------------------------------------------------
     5. SCROLL — progress bar + hero parallax
     One listener, passive, rAF-throttled. Parallax stops once the hero
     is off-screen so we are not writing transforms down a long page.
  ------------------------------------------------------------------ */
  function scroller() {
    var bar    = document.querySelector('.lg-progress');
    var ridges = REDUCED ? [] : [].slice.call(document.querySelectorAll('.lg-ridge'));
    if (!bar && !ridges.length) return;

    var queued = false;

    function run() {
      queued = false;
      var y = window.scrollY || window.pageYOffset || 0;

      if (bar) {
        var h = document.documentElement.scrollHeight - window.innerHeight;
        bar.style.width = (h > 0 ? Math.min(100, (y / h) * 100) : 0) + '%';
      }
      if (ridges.length && y < window.innerHeight * 1.2) {
        for (var i = 0; i < ridges.length; i++) {
          var d = parseFloat(ridges[i].getAttribute('data-depth') || '0');
          ridges[i].style.transform = 'translate3d(0,' + (y * d * 0.42) + 'px,0)';
        }
      }
    }
    function onScroll() { if (!queued) { queued = true; requestAnimationFrame(run); } }

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    run();
  }

  /* ------------------------------------------------------------------
     6. HERO VIDEO
     The homepage hero is real drone footage. Two jobs here:

     a) Reduced motion — CSS already hides the video and reveals the still
        illustration underneath, but hidden video can still download and
        decode. pause() and drop the source so we stop spending the
        visitor's bandwidth, not just their attention.
     b) Failure — if the file 404s or the codec is unsupported, remove the
        video element so the illustration underneath is what shows. A black
        rectangle is a worse homepage than a drawing.

     Deliberately NOT doing: pausing when scrolled out of view. Browsers
     already throttle offscreen video, and a pause/play cycle on scroll
     causes visible stutter when you scroll back up.
  ------------------------------------------------------------------ */
  function heroVideo() {
    var vids = document.querySelectorAll('.lg-hero__art video');
    for (var i = 0; i < vids.length; i++) {
      var v = vids[i];

      // Reveal the still illustration (hidden by default) whenever the video
      // won't be playing — reduced-motion here, or a load failure below.
      var reveal = function (el) {
        var host = el && el.parentNode;
        if (host && host.classList) host.classList.add('show-fallback');
      };

      if (REDUCED) {
        reveal(v);
        try { v.pause(); v.removeAttribute('autoplay'); v.removeAttribute('src');
              while (v.firstChild) v.removeChild(v.firstChild); } catch (e) {}
        continue;
      }
      /* Catching a failed video is fiddlier than it looks, and a naive
         addEventListener('error') misses most real failures:
           · this script is `defer`, so it runs AFTER parsing — a 404 on the
             video may have already fired its error before we attached
           · with a child <source>, the error event fires on the <source>
             and does not bubble to the <video>
         So: check for an already-failed element, listen on both the video and
         its sources, and re-check shortly after in case the failure is still
         in flight. NETWORK_NO_SOURCE (3) is the state a video lands in when
         nothing playable was found. */
      var drop = function (el, show) {
        var host = el && el.parentNode;
        return function () { show(el); if (host && host.contains(el)) host.removeChild(el); };
      }(v, reveal);

      var failed = function (el) {
        return el.error !== null || el.networkState === 3;   /* NETWORK_NO_SOURCE */
      };

      if (failed(v)) { drop(); continue; }

      v.addEventListener('error', drop);
      var srcs = v.getElementsByTagName('source');
      for (var s = 0; s < srcs.length; s++) srcs[s].addEventListener('error', drop);

      /* Re-check once the network has had a moment. Cheap, and it catches the
         common case of a wrong path in production. */
      setTimeout(function (el, isFailed, remove) {
        return function () { if (el.parentNode && isFailed(el)) remove(); };
      }(v, failed, drop), 2500);

      /* Some mobile browsers refuse autoplay even when muted. Asking and
         ignoring the rejection is correct — the poster/illustration shows. */
      if (v.play) { var pr = v.play(); if (pr && pr.catch) pr.catch(function () {}); }
    }
  }

  /* ------------------------------------------------------------------
     8. MOBILE NAV
     Delegated, so it survives markup changes. Put on the button:
       <button class="lg-navtoggle" data-lg-nav="#siteNav" aria-expanded="false">Menu</button>
     aria-expanded is kept in sync — do not drop it.
  ------------------------------------------------------------------ */
  function nav() {
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-lg-nav]');
      if (!btn) return;
      var target = document.querySelector(btn.getAttribute('data-lg-nav'));
      if (!target) return;
      var open = target.classList.toggle('is-open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  /* ------------------------------------------------------------------
     boot
  ------------------------------------------------------------------ */
  function init() {
    applySeason();
    ticker();
    reveal();
    stats();
    scroller();
    heroVideo();
    nav();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* for dynamically injected content */
  window.lgReveal = function (scope) { reveal(scope); stats(scope); };
})();
