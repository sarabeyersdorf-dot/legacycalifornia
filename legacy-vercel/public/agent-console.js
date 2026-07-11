/* agent-console.js — the agent command bar on top of the client's deal page.
   Renders ONLY for signed-in agents viewing /seller.html?deal=<source_key>
   (detection = the agent-gated timeline API answering 200). Clients on their
   ?t= portal link never load deal= and never see this bar.

   Phase 1 of the command-center/portal merge: approvals, timeline edits, and
   internal notes live here, directly above the exact page the client sees —
   WYSIWYG deal work. Cross-deal views stay in the CRM. */
(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var dealKey = params.get('deal');
  if (!dealKey) return;

  var INK = '#141210', PAPER = '#FAF6EC', GOLD = '#C9A75B', GREEN = '#7FBF9A', RED = '#E08A8A';
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
    bar.style.cssText = 'position:sticky;top:0;z-index:99995;background:' + INK + ';color:' + PAPER + ';font-family:Inter,system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.3);';
    document.body.insertBefore(bar, document.body.firstChild);
    render(bar, data);
  }

  function chip(label, cls, attrs) {
    return '<button ' + (attrs || '') + ' style="background:transparent;border:1px solid rgba(250,246,236,.35);color:' + PAPER + ';border-radius:5px;padding:7px 13px;font-size:12px;font-weight:600;cursor:pointer;' + (cls || '') + '">' + label + '</button>';
  }

  function render(bar, data) {
    var proposals = data.proposals || [];
    var items = data.items || [];
    var openItems = items.filter(function (i) { return ['upcoming', 'action'].indexOf(i.status) >= 0; });
    bar.innerHTML =
      '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:10px 18px;">' +
        '<span style="font-size:10px;font-weight:600;letter-spacing:.2em;color:' + GOLD + ';">AGENT CONSOLE</span>' +
        '<span style="font-size:13.5px;font-weight:600;">' + esc(data.deal.address || dealKey) + '</span>' +
        '<span style="font-size:11px;color:rgba(250,246,236,.65);">' + esc(data.deal.stage || '') + (data.deal.coe_date ? ' · COE ' + fmtD(data.deal.coe_date) : '') + ' · clients never see this bar</span>' +
        '<span style="flex:1;"></span>' +
        (proposals.length ? '<span style="background:#5A0E24;color:#F4E6C8;border-radius:12px;padding:4px 11px;font-size:11px;font-weight:600;">' + proposals.length + ' awaiting your OK</span>' : '') +
        chip('Timeline · ' + openItems.length + ' open', '', 'data-ac-toggle="tl"') +
        chip('Internal notes', '', 'data-ac-toggle="notes"') +
        chip('Open desk', '', 'data-ac-desk') +
      '</div>' +
      '<div data-ac-panel="approvals" style="' + (proposals.length ? '' : 'display:none;') + 'border-top:1px solid rgba(250,246,236,.15);padding:10px 18px;display:' + (proposals.length ? 'flex' : 'none') + ';flex-direction:column;gap:8px;">' +
        proposals.map(function (p) {
          return '<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;font-size:13px;">' +
            '<span style="color:' + GOLD + ';font-size:10.5px;font-weight:600;letter-spacing:.08em;">' + esc((p.item_key || '').replace(/^custom:/, '').replace(/_/g, ' ').toUpperCase()) + '</span>' +
            '<span style="flex:1;min-width:220px;color:rgba(250,246,236,.85);">' + esc(p.reason || 'Proposed update') + '</span>' +
            chip('Approve', 'background:#2E5C3D;border-color:#2E5C3D;', 'data-ac-approve="' + esc(p.id) + '"') +
            chip('Dismiss', '', 'data-ac-reject="' + esc(p.id) + '"') +
          '</div>';
        }).join('') +
      '</div>' +
      '<div data-ac-panel="tl" style="display:none;border-top:1px solid rgba(250,246,236,.15);padding:12px 18px;max-height:300px;overflow:auto;">' +
        items.map(function (it) {
          var stateTxt = it.status === 'done' ? '<span style="color:' + GREEN + ';">✓ done</span>' : it.status === 'waived' ? '<span style="color:rgba(250,246,236,.5);">waived</span>' : '<span style="color:' + GOLD + ';">' + esc(it.status) + '</span>';
          var acts = (it.status === 'done' || it.status === 'waived') ? '' :
            chip('✓ Done', 'padding:4px 10px;font-size:11px;', 'data-ac-done="' + esc(it.id) + '"') + ' ' +
            chip('Waive', 'padding:4px 10px;font-size:11px;', 'data-ac-waive="' + esc(it.id) + '"');
          return '<div style="display:flex;gap:12px;align-items:center;padding:6px 0;border-bottom:1px dashed rgba(250,246,236,.12);font-size:13px;flex-wrap:wrap;">' +
            '<span style="min-width:52px;font-size:10.5px;font-weight:600;color:rgba(250,246,236,.6);">' + fmtD(it.due_date) + '</span>' +
            '<span style="flex:1;min-width:180px;">' + esc(it.title) + '</span>' + stateTxt + '<span>' + acts + '</span></div>';
        }).join('') +
        '<div style="display:flex;gap:8px;padding-top:10px;flex-wrap:wrap;">' +
          '<input data-ac-new-title placeholder="Add a step (e.g. Tenant extension in writing)" style="flex:1;min-width:220px;font:inherit;font-size:13px;padding:7px 10px;border-radius:5px;border:1px solid rgba(250,246,236,.3);background:rgba(250,246,236,.08);color:' + PAPER + ';">' +
          '<input data-ac-new-date type="date" style="font:inherit;font-size:13px;padding:6px 8px;border-radius:5px;border:1px solid rgba(250,246,236,.3);background:rgba(250,246,236,.08);color:' + PAPER + ';">' +
          chip('+ Add step', 'background:#8C6B2E;border-color:#8C6B2E;', 'data-ac-add') +
        '</div>' +
      '</div>' +
      '<div data-ac-panel="notes" style="display:none;border-top:1px solid rgba(250,246,236,.15);padding:12px 18px;">' +
        '<textarea data-ac-notes rows="3" placeholder="Internal notes on this deal — agents only, never on the client page…" style="width:100%;font:inherit;font-size:13.5px;line-height:1.5;padding:9px 11px;border-radius:6px;border:1px solid rgba(250,246,236,.3);background:rgba(250,246,236,.08);color:' + PAPER + ';"></textarea>' +
        '<div style="display:flex;gap:10px;align-items:center;margin-top:8px;">' + chip('Save notes', 'background:#2E5C3D;border-color:#2E5C3D;', 'data-ac-save-notes') + '<span data-ac-notes-st style="font-size:12px;color:rgba(250,246,236,.6);"></span></div>' +
      '</div>';

    // toggles
    bar.addEventListener('click', function (e) {
      var t = e.target.closest('[data-ac-toggle]');
      if (t) {
        var k = t.getAttribute('data-ac-toggle');
        ['tl', 'notes'].forEach(function (p) {
          var el = bar.querySelector('[data-ac-panel="' + p + '"]');
          if (el) el.style.display = (p === k && el.style.display === 'none') ? 'block' : 'none';
        });
        if (k === 'notes') loadNotes();
        return;
      }
      if (e.target.closest('[data-ac-desk]')) { location.href = '/crm.html'; return; }
      var ap = e.target.closest('[data-ac-approve]'), rj = e.target.closest('[data-ac-reject]');
      if (ap || rj) {
        var id = (ap || rj).getAttribute(ap ? 'data-ac-approve' : 'data-ac-reject');
        (ap || rj).disabled = true; (ap || rj).textContent = '…';
        api('/api/crm/timeline', { method: 'POST', body: { op: ap ? 'approve' : 'reject', proposal_id: id } })
          .then(function (r) { if (r.ok) location.reload(); else (ap || rj).textContent = 'Failed'; });
        return;
      }
      var dn = e.target.closest('[data-ac-done]'), wv = e.target.closest('[data-ac-waive]');
      if (dn || wv) {
        var iid = (dn || wv).getAttribute(dn ? 'data-ac-done' : 'data-ac-waive');
        (dn || wv).disabled = true; (dn || wv).textContent = '…';
        api('/api/crm/timeline', { method: 'POST', body: { op: 'update-item', id: iid, patch: { status: dn ? 'done' : 'waived' } } })
          .then(function (r) { if (r.ok) location.reload(); else (dn || wv).textContent = 'Failed'; });
        return;
      }
      if (e.target.closest('[data-ac-add]')) {
        var title = bar.querySelector('[data-ac-new-title]').value.trim();
        var date = bar.querySelector('[data-ac-new-date]').value || null;
        if (!title) return;
        var btn = e.target.closest('[data-ac-add]'); btn.disabled = true; btn.textContent = 'Adding…';
        api('/api/crm/timeline', { method: 'POST', body: { op: 'add-item', deal_id: data.deal.id, title: title, due_date: date, owner: 'seller', kind: 'task', sort_order: 70 } })
          .then(function (r) { if (r.ok) location.reload(); else { btn.disabled = false; btn.textContent = '+ Add step'; } });
        return;
      }
      if (e.target.closest('[data-ac-save-notes]')) {
        var ta = bar.querySelector('[data-ac-notes]'), st = bar.querySelector('[data-ac-notes-st]');
        api('/api/crm/deal-notes', { method: 'POST', body: { source_key: dealKey, notes: ta.value } })
          .then(function (r) { st.textContent = r.ok ? 'Saved.' : ((r.j && r.j.error) || 'Save failed.'); setTimeout(function () { st.textContent = ''; }, 2500); });
        return;
      }
    });

    var notesLoaded = false;
    function loadNotes() {
      if (notesLoaded) return; notesLoaded = true;
      api('/api/crm/deal-notes?deal=' + encodeURIComponent(dealKey), { method: 'GET' })
        .then(function (r) { var ta = bar.querySelector('[data-ac-notes]'); if (ta && r.ok) ta.value = (r.j && r.j.notes) || ''; });
    }
  }
})();
