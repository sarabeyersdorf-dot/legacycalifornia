/* agent-console.js — the slim agent PREVIEW bar on a client's deal page.
   Renders ONLY for signed-in agents viewing /seller.html?deal=<source_key>
   (detection = the agent-gated timeline API answering 200). Clients on their
   ?t= portal link never load deal= and never see this bar.

   Deliberately thin: this page is a PREVIEW of what the client sees, not a
   workbench. The only action kept here is clearing Cowork's timeline
   proposals ("awaiting your OK"), because that's the one thing unique to
   looking at the client's page. All other deal work — timeline edits, internal
   notes, linking a client, deal facts — lives in the CRM Command Center, one
   tap away via "Open in CRM". The whole bar collapses to a small pill. */
(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var dealKey = params.get('deal');
  if (!dealKey) return;
  // "View as seller" mode (?as=seller) renders the pure client view — the agent
  // bar must never appear there, or it wouldn't be what the client sees.
  if (/^(seller|client)$/i.test(params.get('as') || '')) return;

  var INK = '#141210', PAPER = '#FAF6EC', GOLD = '#C9A75B', GREEN = '#7FBF9A';
  var COLLAPSE_KEY = 'lgc-ac-collapsed';
  var esc = (function () { var d = document.createElement('div'); return function (s) { d.textContent = s == null ? '' : String(s); return d.innerHTML; }; })();
  var api = function (url, opts) {
    opts = opts || {}; opts.credentials = 'include';
    if (opts.body && typeof opts.body !== 'string') { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(opts.body); }
    return fetch(url, opts).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }).catch(function () { return { ok: r.ok, j: {} }; }); });
  };
  var fmtD = function (d) { if (!d) return 'TBD'; try { return new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }); } catch (e) { return String(d); } };

  fetch('/api/crm/timeline?source_key=' + encodeURIComponent(dealKey), { credentials: 'include' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) { if (data && data.deal) build(data); })
    .catch(function () {});

  function build(data) {
    var bar = document.createElement('div');
    bar.id = 'lgc-agent-console';
    bar.style.cssText = 'position:sticky;top:0;z-index:99995;background:' + INK + ';color:' + PAPER + ';font-family:Inter,system-ui,sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.28);';
    document.body.insertBefore(bar, document.body.firstChild);

    // The collapsed pill lives at the top-left; clicking it restores the bar.
    var pill = document.createElement('button');
    pill.id = 'lgc-agent-pill';
    pill.type = 'button';
    pill.style.cssText = 'position:fixed;top:10px;left:10px;z-index:99996;display:none;align-items:center;gap:7px;background:' + INK + ';color:' + PAPER + ';border:1px solid ' + GOLD + ';border-radius:20px;padding:6px 13px;font-family:Inter,system-ui,sans-serif;font-size:11px;font-weight:600;letter-spacing:.08em;cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,.3);';
    document.body.appendChild(pill);

    render(bar, pill, data);
  }

  function chip(label, extra, attrs) {
    return '<button ' + (attrs || '') + ' style="background:transparent;border:1px solid rgba(250,246,236,.32);color:' + PAPER + ';border-radius:5px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;' + (extra || '') + '">' + label + '</button>';
  }

  function render(bar, pill, data) {
    var d = data.deal || {};
    var proposals = data.proposals || [];
    var n = proposals.length;
    var addr = esc(d.address || dealKey);
    var ctx = esc((d.stage || '') + (d.coe_date ? ' · COE ' + fmtD(d.coe_date) : ''));

    bar.innerHTML =
      '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:7px 16px;">' +
        chip('‹ Back', '', 'data-ac-back title="Back to where you came from"') +
        '<span style="font-size:9.5px;font-weight:700;letter-spacing:.22em;color:' + GOLD + ';">AGENT PREVIEW</span>' +
        '<span style="font-size:13px;font-weight:600;">' + addr + '</span>' +
        (ctx ? '<span style="font-size:11px;color:rgba(250,246,236,.6);">' + ctx + '</span>' : '') +
        '<span style="font-size:11px;color:rgba(250,246,236,.5);">· clients don’t see this bar</span>' +
        '<span style="flex:1;"></span>' +
        (n ? '<button data-ac-toggle-approvals style="background:#5A0E24;color:#F4E6C8;border:none;border-radius:13px;padding:5px 12px;font-size:11px;font-weight:600;cursor:pointer;">' + n + ' to approve ▾</button>' : '') +
        chip('View as seller ↗', 'background:' + GOLD + ';border-color:' + GOLD + ';color:#1A1714;', 'data-ac-as-seller title="Open exactly what the client sees — no agent bar"') +
        chip('Open in CRM', 'background:#2E5C3D;border-color:#2E5C3D;', 'data-ac-desk') +
        '<button data-ac-collapse title="Collapse this bar" style="background:transparent;border:1px solid rgba(250,246,236,.3);color:' + PAPER + ';border-radius:5px;width:27px;height:27px;line-height:1;font-size:16px;cursor:pointer;">–</button>' +
      '</div>' +
      approvalsPanel(proposals, d.id);

    pill.innerHTML = '<span style="color:' + GOLD + ';">●</span> Agent preview' + (n ? ' <span style="background:#5A0E24;color:#F4E6C8;border-radius:9px;padding:1px 7px;">' + n + '</span>' : '');

    // Restore the collapsed state chosen earlier this session.
    if (sessionStorage.getItem(COLLAPSE_KEY) === '1') setCollapsed(bar, pill, true);

    pill.addEventListener('click', function () { setCollapsed(bar, pill, false); });

    bar.addEventListener('click', function (e) {
      if (e.target.closest('[data-ac-collapse]')) { setCollapsed(bar, pill, true); return; }
      if (e.target.closest('[data-ac-desk]')) { location.href = '/crm.html?deal=' + encodeURIComponent(dealKey); return; }
      if (e.target.closest('[data-ac-as-seller]')) { window.open('/seller.html?deal=' + encodeURIComponent(dealKey) + '&as=seller', '_blank', 'noopener'); return; }
      if (e.target.closest('[data-ac-back]')) {
        if (history.length > 1) { history.back(); return; }
        window.close();
        setTimeout(function () { location.href = '/crm.html'; }, 250);
        return;
      }
      if (e.target.closest('[data-ac-toggle-approvals]')) {
        var p = bar.querySelector('[data-ac-panel="approvals"]');
        if (p) p.style.display = (p.style.display === 'none') ? 'flex' : 'none';
        return;
      }
      var rall = e.target.closest('[data-ac-reject-all]');
      if (rall) {
        if (!window.confirm('Reject every pending proposal for this deal? The fix means Cowork won’t re-file the same ones tomorrow.')) return;
        rall.disabled = true; rall.textContent = '…';
        api('/api/crm/timeline', { method: 'POST', body: { op: 'reject-all', deal_id: rall.getAttribute('data-ac-reject-all') } })
          .then(function (r) { if (r.ok) location.reload(); else { rall.disabled = false; rall.textContent = 'Failed'; } });
        return;
      }
      var ap = e.target.closest('[data-ac-approve]');
      if (ap) {
        ap.disabled = true; ap.textContent = '…';
        api('/api/crm/timeline', { method: 'POST', body: { op: 'approve', proposal_id: ap.getAttribute('data-ac-approve') } })
          .then(function (r) { if (r.ok) location.reload(); else ap.textContent = 'Failed'; });
        return;
      }
      var rj = e.target.closest('[data-ac-reject]');
      if (rj) {
        var box = bar.querySelector('[data-ac-reject-box="' + rj.getAttribute('data-ac-reject') + '"]');
        if (box) { box.style.display = 'flex'; var inp = box.querySelector('[data-ac-reject-note]'); if (inp) inp.focus(); }
        return;
      }
      var rs = e.target.closest('[data-ac-reject-send]');
      if (rs) {
        var sid = rs.getAttribute('data-ac-reject-send');
        var sbox = bar.querySelector('[data-ac-reject-box="' + sid + '"]');
        var note = sbox ? (sbox.querySelector('[data-ac-reject-note]').value || '').trim() : '';
        rs.disabled = true; rs.textContent = '…';
        api('/api/crm/timeline', { method: 'POST', body: { op: 'reject', proposal_id: sid, note: note } })
          .then(function (r) { if (r.ok) location.reload(); else rs.textContent = 'Failed'; });
        return;
      }
    });
  }

  // Cowork's proposed timeline updates, awaiting the agent's OK. Collapsed by
  // default; the "N to approve" button expands it.
  function approvalsPanel(proposals, dealId) {
    if (!proposals.length) return '';
    return '<div data-ac-panel="approvals" style="display:none;flex-direction:column;gap:8px;border-top:1px solid rgba(250,246,236,.15);padding:10px 16px;">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">' +
        '<span style="font-size:10px;font-weight:700;letter-spacing:.14em;color:' + GOLD + ';">AWAITING YOUR OK — applies to the client’s page the moment you approve</span>' +
        (dealId ? '<button data-ac-reject-all="' + esc(dealId) + '" title="Reject every pending proposal for this deal" style="background:transparent;border:1px solid rgba(250,246,236,.3);color:' + PAPER + ';border-radius:13px;padding:4px 11px;font-size:10.5px;font-weight:600;cursor:pointer;">Clear all ' + proposals.length + '</button>' : '') +
      '</div>' +
      proposals.map(function (p) {
        var key = esc((p.item_key || '').replace(/^custom:/, '').replace(/_/g, ' ').toUpperCase());
        return '<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;font-size:13px;">' +
          '<span style="color:' + GOLD + ';font-size:10.5px;font-weight:600;letter-spacing:.08em;">' + key + '</span>' +
          '<span style="flex:1;min-width:220px;color:rgba(250,246,236,.85);">' + esc(p.reason || 'Proposed update') + '</span>' +
          chip('Approve', 'background:#2E5C3D;border-color:#2E5C3D;padding:4px 12px;', 'data-ac-approve="' + esc(p.id) + '"') +
          chip('Reject', 'padding:4px 12px;', 'data-ac-reject="' + esc(p.id) + '"') +
          '<div data-ac-reject-box="' + esc(p.id) + '" style="display:none;flex-basis:100%;gap:8px;align-items:center;margin-top:4px;">' +
            '<input data-ac-reject-note placeholder="What’s off? Cowork reads this." style="flex:1;min-width:200px;font:inherit;font-size:12.5px;padding:6px 9px;border-radius:5px;border:1px solid rgba(250,246,236,.3);background:rgba(250,246,236,.08);color:' + PAPER + ';"> ' +
            chip('Send rejection', 'background:#2E5C3D;border-color:#2E5C3D;padding:4px 12px;', 'data-ac-reject-send="' + esc(p.id) + '"') +
          '</div>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  function setCollapsed(bar, pill, collapsed) {
    bar.style.display = collapsed ? 'none' : '';
    pill.style.display = collapsed ? 'inline-flex' : 'none';
    try { collapsed ? sessionStorage.setItem(COLLAPSE_KEY, '1') : sessionStorage.removeItem(COLLAPSE_KEY); } catch (e) {}
  }
})();
