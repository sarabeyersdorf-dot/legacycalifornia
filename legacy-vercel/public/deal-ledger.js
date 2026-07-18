// deal-ledger.js — the "Deals in motion" Ledger table on crm.html (Today tab).
//
// Talks to GET/PATCH /api/crm/deal-ledger (api/_lib/handlers/crm-deal-ledger.js).
// Renders into <div data-ledger-root> inside the "deals" section of crm.html.
//
// Deliberately trimmed vs. the original design mockup:
//   - No per-row Message/Update/Schedule quick-actions or bulk toolbar — the
//     mockup's versions only ever showed a fake success toast. This is the
//     real CRM, so a button that *looks* like it sent something but didn't
//     would be a trap, not a shortcut. "Open" routes into the deal's real
//     Command Center (window.openDealByKey), where sending is real.
//   - Contingency cell is read-only. Contingencies come from the daily
//     briefing's contract-reading pipeline (deal_timeline_items via
//     deals.json), not from clicks in this table — editing them here would
//     silently be overwritten by the next sync.
//   - Inspection cell is read-only. It's pulled from the real Calendar
//     (public.appointments); editing an inspection happens on the Calendar
//     tab, which already has real reschedule/cancel support — this table
//     just links there via "Open" so there isn't a second, conflicting way
//     to edit the same event.
//   - client name and "share on client portal" ARE real and editable here —
//     they're new fields that exist only for this table (db/036), so
//     there's nothing else to conflict with.
//   - "Remove" hides a deal from this table (db/037: ledger_hidden) rather
//     than deleting the underlying deal — see that migration's comments.

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
  const GROUP_META = {
    action:     { name: 'Action today', icon: '!', tint: 'oklch(0.55 0.15 25)', hint: 'Overdue or a 48-hour deadline' },
    closing:    { name: 'Closing soon', icon: '⚑', tint: 'oklch(0.46 0.09 155)', hint: 'Close of escrow within a week' },
    contweek:   { name: 'Contingencies this week', icon: '●', tint: 'oklch(0.5 0.09 45)', hint: 'Next contingency within 10 days' },
    inspection: { name: 'Upcoming inspections', icon: '▲', tint: 'oklch(0.5 0.09 250)', hint: 'Inspection within 10 days' },
    later:      { name: 'In motion', icon: '○', tint: 'oklch(0.5 0.02 60)', hint: 'Moving normally' }
  };
  const GROUP_ORDER = ['action', 'closing', 'contweek', 'inspection', 'later'];

  const state = { mode: 'ledger', filter: 'all', deals: [], loading: true, error: null };

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

  function bucketOf(d) {
    const nc = d.next_contingency, ncDays = nc ? daysFrom(nc.due_date) : null;
    if (nc && ncDays != null && ncDays <= 2) return 'action';
    const coeDays = daysFrom(d.coe_date);
    if (coeDays != null && coeDays <= 7 && coeDays >= 0) return 'closing';
    if (ncDays != null && ncDays <= 10) return 'contweek';
    const ni = d.next_inspection, niDays = ni ? daysFrom(ni.starts_at) : null;
    if (niDays != null && niDays <= 10) return 'inspection';
    return 'later';
  }
  function matchFilter(d, f) {
    f = f || state.filter;
    if (f === 'all') return true;
    if (f === 'sara') return d.agent === 'sara' || d.co_agent === 'sara';
    if (f === 'james') return d.agent === 'james' || d.co_agent === 'james';
    if (f === 'action') return bucketOf(d) === 'action';
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

  function dealRowHTML(d) {
    const S = SIDE[d.side] || SIDE.sell;
    const nc = d.next_contingency, ni = d.next_inspection;
    const ncDays = nc ? daysFrom(nc.due_date) : null;
    const overdue = ncDays != null && ncDays < 0;
    const coeDays = daysFrom(d.coe_date);
    const price = fmtUsd(d.price);
    const dc = window.LegacyDealColors ? window.LegacyDealColors.get(d.source_key) : null;

    let h = `<div class="dl-row" data-row="${esc(d.id)}">`;
    h += `<div class="dl-deal" data-open-deal="${esc(d.source_key || '')}" title="Open this deal's command center">`;
    h += `<div class="dl-spine" style="background:${dc ? dc.border : S.solid}"></div>`;
    h += `<span class="dl-avatar" style="background:${S.soft};color:${S.deep}">${esc(initialsOf(d.client_label || d.address))}</span>`;
    h += `<div style="min-width:0">`;
    h += `<div class="dl-addr">${esc(d.address || 'Untitled')}${d.city ? ' <span style=\'font-weight:400;color:oklch(0.55 0.01 60);\'>· ' + esc(d.city) + '</span>' : ''}</div>`;
    h += `<div class="dl-clientline">`;
    h += `<input class="dl-client" data-client-input value="${esc(d.client_label || '')}" placeholder="Add client name" title="Whose deal is this">`;
    h += `<span class="dl-statusdot" style="background:${S.solid}"></span><span class="dl-status">${esc(d.stage_label)}</span></div>`;
    h += `<div class="dl-touchline"><span class="dl-touch">Updated ${esc(fmtShort(d.last_touch) || '—')}</span></div>`;
    h += `</div></div>`;

    h += `<div class="dl-side"><span class="dl-sidechip" style="color:${S.deep};background:${S.soft};border:1px solid ${alpha(S.solid, 0.3)}">${S.label}</span><div class="dl-agents">`;
    const agentKeys = d.co_agent && d.co_agent !== d.agent ? [d.agent, d.co_agent] : [d.agent];
    agentKeys.filter(Boolean).forEach((k) => {
      const a = AGENTS[k]; if (!a) return;
      h += `<span class="dl-agent" style="background:${alpha(a.c, 0.18)};color:${a.cd};border:1.5px solid ${alpha(a.c, 0.4)}">${a.initials}</span>`;
    });
    h += `</div></div>`;

    h += `<div class="dl-price${price ? '' : ' empty'}">${price || 'TBD'}</div>`;

    h += `<div class="dl-cont" data-open-deal="${esc(d.source_key || '')}" title="Open this deal's timeline">`;
    h += `<div class="dl-cell">`;
    if (nc) {
      const chip = overdue ? { label: 'Overdue', c: 'oklch(0.55 0.16 25)' } : (ncDays != null && ncDays <= 3 ? { label: 'Due soon', c: 'oklch(0.56 0.12 65)' } : { label: 'On track', c: 'oklch(0.5 0.09 155)' });
      h += `<div class="dl-cell-top"><span class="dl-state" style="color:${chip.c};background:${alpha(chip.c, 0.13)}">${chip.label}</span><span class="dl-celllabel">${esc(nc.label)}</span></div>`;
      h += `<div class="dl-contdate" style="color:${overdue || (ncDays != null && ncDays <= 3) ? 'oklch(0.52 0.15 25)' : 'oklch(0.5 0.09 45)'}">${esc(fmtShort(nc.due_date) || '—')}</div>`;
    } else {
      h += `<div class="dl-cell-top"><span class="dl-celllabel">None on file</span></div>`;
    }
    h += `</div></div>`;

    h += `<div class="dl-insp" data-open-deal="${esc(d.source_key || '')}" title="Open this deal's calendar">`;
    h += `<div class="dl-cell">`;
    if (ni) {
      h += `<div class="dl-cell-top"><span class="dl-celllabel">${esc(ni.label)}</span></div>`;
      h += `<div class="dl-inspdate">${esc(fmtDateTime(ni.starts_at) || '—')}</div>`;
    } else {
      h += `<div class="dl-cell-top"><span class="dl-celllabel">—</span></div>`;
    }
    h += `</div></div>`;

    h += `<div class="dl-coe"><div class="dl-coeshort">${esc(fmtShort(d.coe_date) || '—')}</div>`;
    h += coeDays != null ? `<div class="dl-coecount" style="color:${coeDays <= 7 ? 'oklch(0.52 0.15 25)' : 'oklch(0.55 0.01 60)'}">${coeDays}d</div>` : '';
    h += `</div>`;

    h += `<div class="dl-portal-wrap"><button class="dl-portal${d.portal_shared ? ' on' : ''}" data-portal-toggle title="${d.portal_shared ? 'Shared on client portal — click to unshare' : 'Share this deal on the client portal'}"></button></div>`;

    h += `<div class="dl-act">`;
    h += `<button class="dl-actbtn" data-open-deal="${esc(d.source_key || '')}" title="Open deal">⌕</button>`;
    h += `<button class="dl-actbtn danger" data-remove title="Remove from Ledger">✕</button>`;
    h += `</div>`;
    h += `</div>`;
    return h;
  }

  function render() {
    if (state.loading) { root.innerHTML = `<div class="dl-empty">Loading deals…</div>`; return; }
    if (state.error) { root.innerHTML = `<div class="dl-empty">Couldn't load the ledger — ${esc(state.error)}</div>`; return; }

    const modesHTML = [['ledger', 'Ledger'], ['triage', 'By triage']].map(([k, label]) =>
      `<button class="dl-mode${state.mode === k ? ' on' : ''}" data-mode="${k}">${label}</button>`).join('');

    const filterDefs = [['all', 'All'], ['sara', 'Sara'], ['james', 'James'], ['action', 'Needs action'], ['closing', 'Closing this month']];
    const filtersHTML = filterDefs.map(([k, label]) => {
      const n = state.deals.filter((d) => matchFilter(d, k)).length;
      return `<button class="dl-chip${state.filter === k ? ' on' : ''}" data-filter="${k}">${label}<span class="ct">${n}</span></button>`;
    }).join('');

    const legendHTML = ['buy', 'sell', 'dual'].map((k) => `<span class="dl-leg"><i style="background:${SIDE[k].solid}"></i>${SIDE[k].label}</span>`).join('');

    const visible = state.deals.filter((d) => matchFilter(d));
    let rowsHTML = '';
    if (!visible.length) {
      rowsHTML = `<div class="dl-empty">No deals currently in motion${state.filter !== 'all' ? ' matching this filter' : ''}.</div>`;
    } else if (state.mode === 'triage') {
      const groups = {}; GROUP_ORDER.forEach((k) => (groups[k] = []));
      visible.forEach((d) => groups[bucketOf(d)].push(d));
      GROUP_ORDER.forEach((k) => {
        const list = groups[k]; if (!list.length) return;
        const g = GROUP_META[k];
        rowsHTML += `<div class="dl-group" style="background:${alpha(g.tint, 0.15)};border-top:1px solid ${alpha(g.tint, 0.22)};border-bottom:1px solid ${alpha(g.tint, 0.3)}">` +
          `<span class="dl-group-icon" style="background:${alpha(g.tint, 0.2)};color:${g.tint}">${g.icon}</span>` +
          `<span class="dl-group-name">${g.name}</span>` +
          `<span class="dl-group-count" style="background:${alpha(g.tint, 0.2)};color:${g.tint}">${list.length}</span>` +
          `<span class="dl-group-hint">${g.hint}</span></div>`;
        list.forEach((d) => { rowsHTML += dealRowHTML(d); });
      });
    } else {
      visible.forEach((d) => { rowsHTML += dealRowHTML(d); });
    }

    root.innerHTML = `
      <div class="dl">
        <div class="dl-toolbar"><div class="dl-modes">${modesHTML}</div></div>
        <div class="dl-filterbar">
          <div class="dl-filters">${filtersHTML}</div>
          <div class="dl-legend">${legendHTML}</div>
        </div>
        <div class="dl-card"><div class="dl-scroll"><div class="dl-inner">
          <div class="dl-head">
            <span>Deal &middot; Client</span>
            <span>Side &middot; Agent</span>
            <span>Price</span>
            <span>Next contingency</span>
            <span>Next inspection</span>
            <span>COE</span>
            <span>Portal</span>
            <span></span>
          </div>
          <div data-rows>${rowsHTML}</div>
        </div></div></div>
      </div>`;

    bindRowEvents();
  }

  function bindRowEvents() {
    root.querySelectorAll('[data-mode]').forEach((el) => el.addEventListener('click', () => { state.mode = el.dataset.mode; render(); }));
    root.querySelectorAll('[data-filter]').forEach((el) => el.addEventListener('click', () => { state.filter = el.dataset.filter; render(); }));

    root.querySelectorAll('[data-row]').forEach((rowEl) => {
      const id = rowEl.getAttribute('data-row');
      const deal = state.deals.find((d) => d.id === id);
      if (!deal) return;

      const clientInput = rowEl.querySelector('[data-client-input]');
      if (clientInput) {
        clientInput.addEventListener('click', (e) => e.stopPropagation());
        clientInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') clientInput.blur(); });
        clientInput.addEventListener('blur', async () => {
          const val = clientInput.value.trim();
          if (val === (deal.client_label || '')) return;
          await patchDeal(deal, { client_label: val || null }, 'Client name saved');
        });
      }

      const portalBtn = rowEl.querySelector('[data-portal-toggle]');
      if (portalBtn) {
        portalBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const next = !deal.portal_shared;
          const okDone = await patchDeal(deal, { portal_shared: next }, next ? 'Sharing on client portal' : 'No longer sharing on client portal');
          if (okDone) render();
        });
      }

      const removeBtn = rowEl.querySelector('[data-remove]');
      if (removeBtn) {
        removeBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const label = deal.client_label ? `${deal.address} (${deal.client_label})` : deal.address;
          if (!confirm(`Remove "${label}" from the Ledger?\n\nThis just hides it here — nothing is deleted, and it may come back if it's still in the daily sync feed.`)) return;
          const okDone = await patchDeal(deal, { ledger_hidden: true }, 'Removed from Ledger');
          if (okDone) { state.deals = state.deals.filter((x) => x.id !== deal.id); render(); }
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
