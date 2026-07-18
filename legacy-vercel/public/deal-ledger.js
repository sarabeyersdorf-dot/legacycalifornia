// deal-ledger.js — the "Deadline Radar" card view on crm.html (Today tab).
//
// Talks to GET/PATCH /api/crm/deal-ledger (api/_lib/handlers/crm-deal-ledger.js),
// and — for linking a real client contact — POST /api/crm/link-deal-party
// (api/_lib/handlers/crm-link-deal-party.js, already existed for the seller
// portal's identity chain; this reuses it rather than building a second way
// to link a lead to a deal). Renders into <div data-ledger-root> inside the
// "deals" section of crm.html.
//
// This replaced the earlier table-style "Ledger" (rows grouped by triage
// bucket, or a flat sortable table) with a single auto-sorted stack of cards,
// one per deal, matching the approved "Deadline Radar" design: a big colored
// countdown on the left, a milestone timeline and contacts in the middle,
// escrow/commission/quick-actions on the right. Deals are always sorted by
// how soon their own countdown is due — the card list itself *is* the triage.
//
// What each card's countdown actually measures:
//   - In escrow (stage='pending'): whichever is soonest of the next
//     contingency deadline, the next scheduled inspection, or the close of
//     escrow date. This is "what do I need to act on for THIS deal next" —
//     not always the closing date.
//   - Not yet in escrow (offer/listing/preparing): days to the listing
//     agreement's expiration (deals.listing_meta.expiration via the API's
//     listing_expiration field). There's no contingency/inspection countdown
//     to race against before there's an accepted offer, so this is the one
//     deadline that actually matters pre-escrow. Not every listing has an
//     expiration date on file — those cards show no countdown badge rather
//     than a made-up one.
//
// Deliberately trimmed vs. the original design mockup:
//   - Contingency/inspection timeline points are read-only — they come from
//     the daily briefing's contract-reading pipeline (deal_timeline_items)
//     and the real Calendar (appointments), not from clicks in this card.
//     Editing an inspection happens on the Calendar tab, which already has
//     real reschedule/cancel support.
//   - Call/Email are real tel:/mailto: links to a LINKED contact's real
//     phone/email (deal_parties → leads) — never to the free-text
//     client_label, since that's just a display label with no phone/email
//     behind it. A deal with no linked contact yet shows "Link client"
//     instead of Call/Email, so nothing on the card ever looks actionable
//     when it isn't.
//   - "Doc" opens the listing's disclosure package link when one's on file
//     (listing_meta.disclosurePackage) — not every listing has one, so the
//     button is simply absent otherwise, same reasoning as Call/Email.
//   - "Open" routes into the deal's real Command Center (window.openDealByKey).
//   - Portal-sharing toggle and "Remove from Ledger" (soft-hide, db/037)
//     carry over from the old table view — they're real, existing features,
//     just relocated into this card's small icon row.

(function () {
  const root = document.querySelector('[data-ledger-root]');
  if (!root) return; // section not present on this page

  const api = async (path, opts = {}) => {
    const res = await fetch('/api/crm/' + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      credentials: 'include',
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch (_) {}
    return { ok: res.ok, status: res.status, json };
  };
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const alpha = (c, a) => c.replace(')', ' / ' + a + ')');

  const SIDE = {
    buy:  { solid: 'oklch(0.55 0.09 155)', deep: 'oklch(0.42 0.08 155)', soft: 'oklch(0.55 0.09 155 / 0.14)', label: 'Buy' },
    sell: { solid: 'oklch(0.58 0.11 45)',  deep: 'oklch(0.46 0.09 45)',  soft: 'oklch(0.58 0.11 45 / 0.14)',  label: 'Sell' },
    dual: { solid: 'oklch(0.53 0.09 285)', deep: 'oklch(0.42 0.08 285)', soft: 'oklch(0.53 0.09 285 / 0.14)', label: 'Dual' }
  };
  const AGENTS = {
    sara:  { initials: 'S', c: 'oklch(0.62 0.1 78)', cd: 'oklch(0.5 0.1 78)' },
    james: { initials: 'J', c: 'oklch(0.55 0.09 250)', cd: 'oklch(0.46 0.09 250)' }
  };
  // Countdown urgency tiers — used for both the big left-hand color block and
  // the "Needs action" filter.
  const TIER = {
    urgent: { bg: 'oklch(0.5 0.16 25)',  fg: 'oklch(0.98 0.006 85)' },
    soon:   { bg: 'oklch(0.56 0.13 55)', fg: 'oklch(0.99 0.006 85)' },
    ok:     { bg: 'oklch(0.42 0.09 155)', fg: 'oklch(0.98 0.006 85)' },
    none:   { bg: 'oklch(0.88 0.008 80)', fg: 'oklch(0.4 0.01 60)' }
  };

  const state = { filter: 'all', deals: [], loading: true, error: null, linkFormOpen: null };

  function fmtUsd(n) {
    if (n == null) return null;
    const v = Math.abs(+n);
    if (v >= 1_000_000) return `$${(+n / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 2)}M`;
    if (v >= 1_000) return `$${Math.round(+n / 1_000)}K`;
    return `$${Math.round(+n)}`;
  }
  function fmtShort(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d)) return null;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  function fmtDateTime(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d)) return null;
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' +
      d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  function daysFrom(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d)) return null;
    return Math.round((d.setHours(12, 0, 0, 0) - new Date().setHours(12, 0, 0, 0)) / 86400000);
  }
  function initialsOf(name) {
    const clean = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!clean.length) return '—';
    if (clean.length === 1) return clean[0].slice(0, 2).toUpperCase();
    return (clean[0][0] + clean[clean.length - 1][0]).toUpperCase();
  }

  // The one countdown that drives a card's left-hand block, its sort order,
  // and the "Needs action" filter. See the file header for what each stage
  // actually counts down to.
  function countdownFor(d) {
    if (d.stage === 'pending') {
      const candidates = [];
      if (d.next_contingency?.due_date) candidates.push({ days: daysFrom(d.next_contingency.due_date), label: 'to Contingency' });
      if (d.next_inspection?.starts_at) candidates.push({ days: daysFrom(d.next_inspection.starts_at), label: 'to Inspection' });
      if (d.coe_date) candidates.push({ days: daysFrom(d.coe_date), label: 'to Close of Escrow' });
      const upcoming = candidates.filter((c) => c.days != null && c.days >= 0).sort((a, b) => a.days - b.days);
      if (upcoming.length) return { ...upcoming[0], tier: upcoming[0].days <= 3 ? 'urgent' : (upcoming[0].days <= 10 ? 'soon' : 'ok') };
      const overdue = candidates.filter((c) => c.days != null).sort((a, b) => a.days - b.days);
      if (overdue.length) return { days: overdue[0].days, label: overdue[0].label.replace('to ', 'overdue: '), tier: 'urgent' };
      return { days: null, label: 'No deadline on file', tier: 'none' };
    }
    // Not yet in escrow — the listing agreement's expiration is the deadline
    // that actually matters (see file header).
    if (d.listing_expiration) {
      const days = daysFrom(d.listing_expiration);
      const tier = days == null ? 'none' : days < 0 ? 'urgent' : days <= 14 ? 'urgent' : days <= 45 ? 'soon' : 'ok';
      return { days, label: 'to Expiration', tier };
    }
    return { days: null, label: 'No expiration on file', tier: 'none' };
  }

  // The card's 4-point milestone timeline. In escrow, this is the deal's
  // real contract timeline (acceptance → inspection → contingency → COE).
  // Pre-escrow there isn't one yet, so it's just the listing lifecycle so
  // far (Listed → In escrow / Inspection / COE, all still open).
  function timelineFor(d) {
    const today = new Date(); today.setHours(12, 0, 0, 0);
    const pointState = (iso) => {
      if (!iso) return 'future';
      const dt = new Date(iso); if (isNaN(dt)) return 'future';
      return dt <= today ? 'done' : 'future';
    };
    if (d.stage === 'pending') {
      const points = [
        // Being in escrow means an offer was already accepted, whether or
        // not acceptance_date happens to be on file — never show this as
        // "future" just because that column is empty (it's null on every
        // live deal today; the milestone still already happened).
        { label: 'Offer',       date: d.acceptance_date, state: 'done' },
        { label: 'Inspection',  date: d.next_inspection?.starts_at || null },
        { label: 'Contingency', date: d.next_contingency?.due_date || null },
        { label: 'COE',         date: d.coe_date }
      ];
      // Mark whichever upcoming point is soonest as "current" (the red dot);
      // everything before it is "done", everything after is "future".
      let currentIdx = -1, soonest = Infinity;
      points.forEach((p, i) => {
        if (p.state || !p.date) return; // Offer's state above is fixed, not date-derived
        const days = daysFrom(p.date);
        if (days != null && days >= 0 && days < soonest) { soonest = days; currentIdx = i; }
      });
      return points.map((p, i) => ({
        ...p,
        state: p.state || (i === currentIdx ? 'current' : (p.date ? pointState(p.date) : 'future'))
      }));
    }
    return [
      { label: 'Listed',     date: d.listing_meta_date_listed || null, state: 'done' },
      { label: 'In escrow',  date: null, state: 'future' },
      { label: 'Inspection', date: d.next_inspection?.starts_at || null, state: d.next_inspection ? 'current' : 'future' },
      { label: 'COE',        date: null, state: 'future' }
    ];
  }

  function matchFilter(d, f) {
    f = f || state.filter;
    if (f === 'all') return true;
    if (f === 'sara') return d.agent === 'sara' || d.co_agent === 'sara';
    if (f === 'james') return d.agent === 'james' || d.co_agent === 'james';
    if (f === 'action') return countdownFor(d).tier === 'urgent';
    if (f === 'closing') { const c = daysFrom(d.coe_date); return c != null && c >= 0 && c <= 31; }
    return true;
  }

  let toastTimer = null;
  function toast(msg) {
    let el = document.querySelector('.dl-toast[data-ledger-toast]');
    if (!el) {
      el = document.createElement('div');
      el.className = 'dl-toast';
      el.setAttribute('data-ledger-toast', '');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), 2600);
  }

  async function patchDeal(deal, patch, successMsg) {
    const { ok, json } = await api('deal-ledger', { method: 'PATCH', body: { deal_id: deal.id, ...patch } });
    if (!ok) { toast((json && json.error) || 'Update failed'); return false; }
    Object.assign(deal, patch);
    toast(successMsg);
    return true;
  }

  async function linkClient(deal, form) {
    const email = form.querySelector('[data-link-email]').value.trim();
    if (!email) { toast('Email is required to link a client'); return false; }
    const body = {
      deal_id: deal.id,
      email,
      first_name: form.querySelector('[data-link-first]').value.trim() || undefined,
      last_name:  form.querySelector('[data-link-last]').value.trim() || undefined,
      phone:      form.querySelector('[data-link-phone]').value.trim() || undefined,
      role:       form.querySelector('[data-link-role]').value
    };
    const { ok, json } = await api('link-deal-party', { method: 'POST', body });
    if (!ok) { toast((json && json.error) || 'Could not link client'); return false; }
    toast('Client linked');
    return true;
  }

  function timelineHTML(points) {
    const dotStyle = (s) => s === 'done'
      ? 'background:oklch(0.5 0.13 155);border-color:oklch(0.5 0.13 155)'
      : s === 'current'
        ? 'background:oklch(0.55 0.16 25);border-color:oklch(0.55 0.16 25)'
        : 'background:oklch(0.995 0.002 85);border-color:oklch(0.82 0.01 80)';
    let h = '<div class="dr-timeline">';
    points.forEach((p, i) => {
      if (i > 0) h += `<div class="dr-tl-line" style="background:${p.state === 'future' ? 'oklch(0.88 0.008 80)' : 'oklch(0.7 0.05 120)'}"></div>`;
      h += `<div class="dr-tl-point">`;
      h += `<span class="dr-tl-label">${esc(p.label)}</span>`;
      h += `<span class="dr-tl-dot" style="${dotStyle(p.state)}"></span>`;
      h += `<span class="dr-tl-date">${esc(fmtShort(p.date) || '—')}</span>`;
      h += `</div>`;
    });
    h += '</div>';
    return h;
  }

  function partiesHTML(d) {
    if (!d.parties || !d.parties.length) return '';
    let h = '<div class="dr-contacts">';
    d.parties.forEach((p) => {
      h += `<span class="dr-contact"><span class="dr-contact-av">${esc(initialsOf(p.name))}</span>${esc(p.name)} <i>${esc(p.role)}</i></span>`;
    });
    h += '</div>';
    return h;
  }

  function actionsHTML(d) {
    const primaryParty = (d.parties || [])[0] || null;
    const docUrl = d.listing_meta_disclosure_url || null;
    let h = '<div class="dr-actrow">';
    if (primaryParty && primaryParty.phone) {
      h += `<a class="dr-actbtn" href="tel:${esc(primaryParty.phone)}" title="Call ${esc(primaryParty.name)}" onclick="event.stopPropagation()">☎</a>`;
    }
    if (primaryParty && primaryParty.email) {
      h += `<a class="dr-actbtn" href="mailto:${esc(primaryParty.email)}" title="Email ${esc(primaryParty.name)}" onclick="event.stopPropagation()">✉</a>`;
    }
    if (!primaryParty) {
      h += `<button class="dr-actbtn dr-linkbtn" data-link-toggle title="Link a client so Call/Email work">Link client</button>`;
    }
    if (docUrl) {
      h += `<a class="dr-actbtn" href="${esc(docUrl)}" target="_blank" rel="noopener" title="Open disclosure package" onclick="event.stopPropagation()">📄</a>`;
    }
    h += '</div>';
    return h;
  }

  function linkFormHTML(d) {
    const roleDefault = d.side === 'buy' ? 'buyer' : 'seller';
    return `
      <div class="dr-linkform" data-link-form onclick="event.stopPropagation()">
        <div class="dr-linkform-row">
          <input data-link-email type="email" placeholder="Client email (required)">
          <select data-link-role>
            <option value="seller"${roleDefault === 'seller' ? ' selected' : ''}>Seller</option>
            <option value="co-seller">Co-seller</option>
            <option value="buyer"${roleDefault === 'buyer' ? ' selected' : ''}>Buyer</option>
            <option value="co-buyer">Co-buyer</option>
          </select>
        </div>
        <div class="dr-linkform-row">
          <input data-link-first type="text" placeholder="First name">
          <input data-link-last type="text" placeholder="Last name">
          <input data-link-phone type="tel" placeholder="Phone">
        </div>
        <div class="dr-linkform-row dr-linkform-actions">
          <button class="dr-linkbtn dr-linkbtn-cancel" data-link-cancel type="button">Cancel</button>
          <button class="dr-linkbtn dr-linkbtn-save" data-link-save type="button">Link client</button>
        </div>
      </div>`;
  }

  function dealCardHTML(d) {
    const S = SIDE[d.side] || SIDE.sell;
    const cd = countdownFor(d);
    const tier = TIER[cd.tier] || TIER.none;
    const dc = window.LegacyDealColors ? window.LegacyDealColors.get(d.source_key) : null;
    const price = fmtUsd(d.price);
    const cityIsDupe = d.city && d.address && d.address.toLowerCase().includes(d.city.toLowerCase().trim());
    const clientName = (d.parties && d.parties[0]) ? d.parties[0].name : (d.client_label || null);

    let h = `<div class="dr-card" data-card="${esc(d.id)}">`;

    // ---- Left: countdown block --------------------------------------------
    h += `<div class="dr-count" style="background:${tier.bg};color:${tier.fg}">`;
    h += cd.days != null
      ? `<div class="dr-count-num">${Math.abs(cd.days)}</div><div class="dr-count-unit">${cd.days < 0 ? 'DAYS OVERDUE' : 'DAYS'}</div><div class="dr-count-label">${esc(cd.label)}</div>`
      : `<div class="dr-count-label dr-count-label-lg">${esc(cd.label)}</div>`;
    h += `</div>`;

    // ---- Middle: deal info + timeline + contacts --------------------------
    h += `<div class="dr-body">`;
    h += `<div class="dr-headline" data-open-deal="${esc(d.source_key || '')}" title="Open this deal's command center">`;
    h += `<span class="dr-spine" style="background:${dc ? dc.border : S.solid}"></span>`;
    h += `<div class="dr-headline-text">`;
    h += `<div class="dr-addr">${esc(d.address || 'Untitled')}</div>`;
    if (d.city && !cityIsDupe) h += `<div class="dr-city">${esc(d.city)}</div>`;
    h += `</div>`;
    h += `<span class="dr-sidechip" style="color:${S.deep};background:${S.soft};border:1px solid ${alpha(S.solid, 0.3)}">${S.label}</span>`;
    const agentKeys = d.co_agent && d.co_agent !== d.agent ? [d.agent, d.co_agent] : [d.agent];
    agentKeys.filter(Boolean).forEach((k) => {
      const a = AGENTS[k]; if (!a) return;
      h += `<span class="dr-agent" style="background:${alpha(a.c, 0.18)};color:${a.cd};border:1.5px solid ${alpha(a.c, 0.4)}">${a.initials}</span>`;
    });
    h += `</div>`;

    h += `<div class="dr-clientline">`;
    h += `<input class="dr-client" data-client-input value="${esc(clientName || '')}" placeholder="Add client name" title="Whose deal is this" ${(d.parties && d.parties[0]) ? 'disabled' : ''}>`;
    h += `<span class="dr-statusdot" style="background:${S.solid}"></span><span class="dr-status">${esc(d.stage_label)}</span>`;
    h += `</div>`;

    h += timelineHTML(timelineFor(d));
    h += partiesHTML(d);
    if (state.linkFormOpen === d.id) h += linkFormHTML(d);
    h += `</div>`;

    // ---- Right: escrow / commission / actions ------------------------------
    h += `<div class="dr-side">`;
    if (d.escrow_company) h += `<div class="dr-escrow">Escrow: ${esc(d.escrow_company)}${d.escrow_order ? ' · ' + esc(d.escrow_order) : ''}</div>`;
    h += `<div class="dr-comm-label">COMMISSION</div>`;
    h += `<div class="dr-comm${price ? '' : ' empty'}">${d.commission_usd != null ? fmtUsd(d.commission_usd) : (price ? '—' : 'TBD')}</div>`;
    h += actionsHTML(d);
    h += `<div class="dr-act2row">`;
    h += `<button class="dr-actbtn2" data-open-deal="${esc(d.source_key || '')}" title="Open deal">⌕</button>`;
    h += `<button class="dr-actbtn2${d.portal_shared ? ' on' : ''}" data-portal-toggle title="${d.portal_shared ? 'Shared on client portal — click to unshare' : 'Share this deal on the client portal'}">◎</button>`;
    h += `<button class="dr-actbtn2 danger" data-remove title="Remove from Ledger">✕</button>`;
    h += `</div>`;
    h += `</div>`;

    h += `</div>`;
    return h;
  }

  function render() {
    if (state.loading) { root.innerHTML = `<div class="dl-empty">Loading deals…</div>`; return; }
    if (state.error) { root.innerHTML = `<div class="dl-empty">Couldn't load the ledger — ${esc(state.error)}</div>`; return; }

    const filterDefs = [['all', 'All'], ['sara', 'Sara'], ['james', 'James'], ['action', 'Needs action'], ['closing', 'Closing this month']];
    const filtersHTML = filterDefs.map(([k, label]) => {
      const n = state.deals.filter((d) => matchFilter(d, k)).length;
      return `<button class="dl-chip${state.filter === k ? ' on' : ''}" data-filter="${k}">${label}<span class="ct">${n}</span></button>`;
    }).join('');
    const sideLegendHTML = ['buy', 'sell', 'dual'].map((k) => `<span class="dl-leg"><i style="background:${SIDE[k].solid}"></i>${SIDE[k].label}</span>`).join('');
    const deadlineLegendHTML = [['ok', 'On track'], ['soon', 'Soon'], ['urgent', 'Urgent']]
      .map(([k, label]) => `<span class="dl-leg"><i style="background:${TIER[k].bg}"></i>${label}</span>`).join('');
    const legendHTML = deadlineLegendHTML + sideLegendHTML;

    const visible = state.deals
      .filter((d) => matchFilter(d))
      .slice()
      .sort((a, b) => {
        const ca = countdownFor(a), cb = countdownFor(b);
        if (ca.days == null && cb.days == null) return 0;
        if (ca.days == null) return 1;
        if (cb.days == null) return -1;
        return ca.days - cb.days;
      });

    let cardsHTML = '';
    if (!visible.length) {
      cardsHTML = `<div class="dl-empty">No deals currently in motion${state.filter !== 'all' ? ' matching this filter' : ''}.</div>`;
    } else {
      visible.forEach((d) => { cardsHTML += dealCardHTML(d); });
    }

    root.innerHTML = `
      <div class="dl">
        <div class="dl-filterbar">
          <div class="dl-filters">${filtersHTML}</div>
          <div class="dl-legend">${legendHTML}</div>
        </div>
        <div class="dr-stack" data-cards>${cardsHTML}</div>
      </div>`;

    bindCardEvents();
  }

  function bindCardEvents() {
    root.querySelectorAll('[data-filter]').forEach((el) => el.addEventListener('click', () => { state.filter = el.dataset.filter; render(); }));

    root.querySelectorAll('[data-card]').forEach((cardEl) => {
      const id = cardEl.getAttribute('data-card');
      const deal = state.deals.find((d) => d.id === id);
      if (!deal) return;

      const clientInput = cardEl.querySelector('[data-client-input]');
      if (clientInput && !clientInput.disabled) {
        clientInput.addEventListener('click', (e) => e.stopPropagation());
        clientInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') clientInput.blur(); });
        clientInput.addEventListener('blur', async () => {
          const val = clientInput.value.trim();
          if (val === (deal.client_label || '')) return;
          await patchDeal(deal, { client_label: val || null }, 'Client name saved');
        });
      }

      const portalBtn = cardEl.querySelector('[data-portal-toggle]');
      if (portalBtn) {
        portalBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const next = !deal.portal_shared;
          const okDone = await patchDeal(deal, { portal_shared: next }, next ? 'Sharing on client portal' : 'No longer sharing on client portal');
          if (okDone) render();
        });
      }

      const removeBtn = cardEl.querySelector('[data-remove]');
      if (removeBtn) {
        removeBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const label = deal.client_label ? `${deal.address} (${deal.client_label})` : deal.address;
          if (!confirm(`Remove "${label}" from the Ledger?\n\nThis just hides it here — nothing is deleted, and it may come back if it's still in the daily sync feed.`)) return;
          const okDone = await patchDeal(deal, { ledger_hidden: true }, 'Removed from Ledger');
          if (okDone) { state.deals = state.deals.filter((x) => x.id !== deal.id); render(); }
        });
      }

      const linkToggle = cardEl.querySelector('[data-link-toggle]');
      if (linkToggle) {
        linkToggle.addEventListener('click', (e) => {
          e.stopPropagation();
          state.linkFormOpen = state.linkFormOpen === deal.id ? null : deal.id;
          render();
        });
      }
      const linkForm = cardEl.querySelector('[data-link-form]');
      if (linkForm) {
        const cancelBtn = linkForm.querySelector('[data-link-cancel]');
        cancelBtn.addEventListener('click', () => { state.linkFormOpen = null; render(); });
        const saveBtn = linkForm.querySelector('[data-link-save]');
        saveBtn.addEventListener('click', async () => {
          const okDone = await linkClient(deal, linkForm);
          if (okDone) { state.linkFormOpen = null; await load(); }
        });
      }
    });
  }

  async function load() {
    state.loading = true; state.error = null; render();
    const { ok, json } = await api('deal-ledger');
    if (!ok) { state.loading = false; state.error = (json && json.error) || 'request failed'; render(); return; }
    state.deals = (json && json.deals) || [];
    state.loading = false;
    render();
  }

  load();
})();
