/* ============================================================
   TOWN PAGE — Interactivity
   ============================================================ */
(function () {
  'use strict';

  /* ── Season scrubber ── */
  const hero = document.querySelector('.town-hero');
  const seasonBtns = document.querySelectorAll('.th-sn');
  const seasonQuote = document.getElementById('seasonQuote');
  seasonBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const s = btn.dataset.s;
      hero.setAttribute('data-season', s);
      seasonBtns.forEach(b => b.classList.toggle('th-sn-on', b === btn));
      const quote = btn.dataset.quote;
      if (seasonQuote && quote) seasonQuote.innerHTML = quote;
    });
  });

  /* ── Jump rail scrollspy ── */
  const jumpLinks = document.querySelectorAll('#jumpRail a');
  const sections = Array.from(jumpLinks).map(a => document.querySelector(a.getAttribute('href'))).filter(Boolean);
  function spy() {
    const y = window.scrollY + 140;
    let activeIdx = 0;
    sections.forEach((sec, i) => { if (sec.offsetTop <= y) activeIdx = i; });
    jumpLinks.forEach((l, i) => l.classList.toggle('jump-on', i === activeIdx));
  }
  window.addEventListener('scroll', spy, { passive: true });
  spy();

  /* ── Main Street map: filter + hover detail ── */
  const filters = document.querySelectorAll('.ms-filter');
  const pins    = document.querySelectorAll('.ms-pin');
  const msTag   = document.getElementById('msTag');
  const msName  = document.getElementById('msName');
  const msDesc  = document.getElementById('msDesc');
  const msList  = document.getElementById('msList');
  const msCount = document.getElementById('msCount');

  const CAT_LBL = { wine: 'Tasting room', eat: 'Restaurant', stay: 'Stay', shop: 'Shop', do: 'To do' };

  function applyFilter(cat) {
    let n = 0;
    pins.forEach(p => {
      const match = (cat === 'all' || p.dataset.cat === cat);
      p.classList.toggle('ms-pin-dim', !match);
      if (match) n++;
    });
    if (msCount) msCount.textContent = n + ' places';
    // populate list
    if (msList) {
      msList.innerHTML = '';
      pins.forEach(p => {
        if (cat !== 'all' && p.dataset.cat !== cat) return;
        const li = document.createElement('li');
        li.textContent = p.dataset.name;
        msList.appendChild(li);
      });
    }
  }
  filters.forEach(f => {
    f.addEventListener('click', () => {
      filters.forEach(x => x.classList.toggle('ms-on', x === f));
      applyFilter(f.dataset.cat);
    });
  });

  function showPin(p) {
    pins.forEach(x => x.classList.toggle('ms-pin-on', x === p));
    if (msTag)  msTag.textContent  = CAT_LBL[p.dataset.cat] || '';
    if (msName) msName.textContent = p.dataset.name;
    if (msDesc) msDesc.textContent = p.dataset.desc;
    if (msList) msList.innerHTML = '';
  }
  pins.forEach(p => {
    p.addEventListener('mouseenter', () => showPin(p));
    p.addEventListener('focus', () => showPin(p));
    p.addEventListener('click', () => showPin(p));
  });

  /* ── Picks tabs ── */
  const pickTabs = document.querySelectorAll('.pick-tab');
  const pickPanes = document.querySelectorAll('.pick-pane');
  pickTabs.forEach(t => {
    t.addEventListener('click', () => {
      const tab = t.dataset.tab;
      pickTabs.forEach(x => x.classList.toggle('pick-tab-on', x === t));
      pickPanes.forEach(p => p.classList.toggle('pick-pane-on', p.dataset.pane === tab));
    });
  });

})();
