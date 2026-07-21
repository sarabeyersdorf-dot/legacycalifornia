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

  // Internal facts the client must never see: price, commission, escrow, links.
  function infoStrip(d) {
    var price = d.sale_price || d.list_price;
    var comm = '';
    if (d.commission) {
      var pct = parseFloat(String(d.commission));
      var val = (price && !isNaN(pct)) ? '$' + Math.round(price * pct / 100).toLocaleString('en-US') + ' (' + String(d.commission).trim() + ')' : String(d.commission);
      comm = '<span><b style="color:' + GOLD + ';">Commission</b> ' + esc(val) + ' · internal</span>';
    }
    var bits = [
      price ? '<span><b style="color:' + GOLD + ';">' + (d.side === 'buyer' ? 'Purchase' : 'Sale') + '</b> $' + Math.round(price).toLocaleString('en-US') + '</span>' : '',
      comm,
      d.mls_number ? '<span><b style="color:' + GOLD + ';">MLS</b> ' + esc(d.mls_number) + '</span>' : '',
      d.escrow_officer ? '<span><b style="color:' + GOLD + ';">Escrow</b> ' + esc(d.escrow_officer) + (d.title_company ? ' · ' + esc(d.title_company) : '') + '</span>' : '',
      d.co_agent ? '<span><b style="color:' + GOLD + ';">Co-op</b> ' + esc(d.co_agent) + '</span>' : '',
      d.disclosure_url ? '<a href="' + esc(d.disclosure_url) + '" target="_blank" rel="noopener" style="color:' + PAPER + ';">Disclosures ↗</a>' : '',
      d.video_url ? '<a href="' + esc(d.video_url) + '" target="_blank" rel="noopener" style="color:' + PAPER + ';">Video ↗</a>' : '',
      d.tour_url ? '<a href="' + esc(d.tour_url) + '" target="_blank" rel="noopener" style="color:' + PAPER + ';">3D tour ↗</a>' : ''
    ].filter(Boolean);
    if (!bits.length) return '';
    return '<div style="display:flex;gap:18px;flex-wrap:wrap;align-items:baseline;padding:7px 18px 9px;border-top:1px solid rgba(250,246,236,.12);font-size:12px;color:rgba(250,246,236,.85);">' + bits.join('') + '</div>';
  }

  function chip(label, cls, attrs) {
    return '<button ' + (attrs || '') + ' style="background:transparent;border:1px solid rgba(250,246,236,.35);color:' + PAPER + ';border-radius:5px;padding:7px 13px;font-size:12px;font-weight:600;cursor:pointer;' + (cls || '') + '">' + label + '</button>';
  }

  // Link-to-portal panel: connect a client to THIS deal without leaving the page.
  // Type-ahead searches the whole CRM; picking a match auto-fills the fields.
  // A brand-new contact is created (and auto-classified as a client) by the
  // /api/crm/link-deal-party endpoint. Role defaults to the deal's own side.
  function linkPanel(deal) {
    var side = deal.side === 'buyer' ? 'buyer' : 'seller';
    var fld = 'font:inherit;font-size:13px;padding:8px 10px;border-radius:5px;border:1px solid rgba(250,246,236,.3);background:rgba(250,246,236,.08);color:' + PAPER + ';';
    var roleOpts = [['seller', 'Seller'], ['co-seller', 'Co-seller'], ['buyer', 'Buyer'], ['co-buyer', 'Co-buyer']]
      .map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === side ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('');
    return '<div data-ac-panel="link" style="display:none;border-top:1px solid rgba(250,246,236,.15);padding:12px 18px;max-width:660px;">' +
      '<div style="font-size:12.5px;color:rgba(250,246,236,.75);line-height:1.5;margin-bottom:9px;">Link a client to <b>' + esc(deal.address || dealKey) + '</b> so they see this portal when they sign in. Search someone already in your CRM, or type a new person — new contacts are auto-added as clients.</div>' +
      '<div style="position:relative;margin-bottom:8px;">' +
        '<input data-ac-link-search autocomplete="off" placeholder="Search your contacts — name, email, phone…" style="width:100%;box-sizing:border-box;' + fld + '">' +
        '<div data-ac-link-matches style="display:none;position:absolute;top:100%;left:0;right:0;z-index:6;background:' + PAPER + ';color:' + INK + ';border-radius:0 0 6px 6px;max-height:220px;overflow:auto;box-shadow:0 10px 24px rgba(0,0,0,.35);"></div>' +
      '</div>' +
      '<input data-ac-link-email type="email" placeholder="Email (required)" style="width:100%;box-sizing:border-box;margin-bottom:8px;' + fld + '">' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">' +
        '<input data-ac-link-first placeholder="First name" style="flex:1;min-width:120px;' + fld + '">' +
        '<input data-ac-link-last placeholder="Last name" style="flex:1;min-width:120px;' + fld + '">' +
        '<input data-ac-link-phone placeholder="Phone" style="flex:1;min-width:120px;' + fld + '">' +
        '<select data-ac-link-role style="' + fld + '">' + roleOpts + '</select>' +
      '</div>' +
      '<label style="display:flex;gap:7px;align-items:flex-start;font-size:12.5px;color:rgba(250,246,236,.8);line-height:1.4;margin-bottom:10px;"><input data-ac-link-provision type="checkbox" checked style="margin-top:2px;"><span>Create their sign-in account now so they can log in immediately (no email sent).</span></label>' +
      '<div style="display:flex;gap:10px;align-items:center;">' + chip('Link to portal', 'background:#2E5C3D;border-color:#2E5C3D;', 'data-ac-link-submit') + '<span data-ac-link-st style="font-size:12.5px;color:rgba(250,246,236,.7);"></span></div>' +
    '</div>';
  }

  function splitName(full) { var p = (full || '').trim().split(/\s+/); return { first: p.shift() || '', last: p.join(' ') || '' }; }

  function render(bar, data) {
    var proposals = data.proposals || [];
    var items = data.items || [];
    var openItems = items.filter(function (i) { return ['upcoming', 'action'].indexOf(i.status) >= 0; });
    bar.innerHTML =
      '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:10px 18px;">' +
        chip('‹ Back', '', 'data-ac-back title="Back to where you came from"') +
        '<span style="font-size:10px;font-weight:600;letter-spacing:.2em;color:' + GOLD + ';">AGENT CONSOLE</span>' +
        '<span style="font-size:13.5px;font-weight:600;">' + esc(data.deal.address || dealKey) + '</span>' +
        '<span style="font-size:11px;color:rgba(250,246,236,.65);">' + esc(data.deal.stage || '') + (data.deal.coe_date ? ' · COE ' + fmtD(data.deal.coe_date) : '') + ' · clients never see this bar</span>' +
        '<span style="flex:1;"></span>' +
        (proposals.length ? '<span style="background:#5A0E24;color:#F4E6C8;border-radius:12px;padding:4px 11px;font-size:11px;font-weight:600;">' + proposals.length + ' awaiting your OK</span>' : '') +
        chip('Timeline · ' + openItems.length + ' open', '', 'data-ac-toggle="tl"') +
        chip('Internal notes', '', 'data-ac-toggle="notes"') +
        chip('＋ Link to portal', 'background:#2E5C3D;border-color:#2E5C3D;', 'data-ac-toggle="link"') +
        chip('Open desk', '', 'data-ac-desk') +
      '</div>' +
      infoStrip(data.deal) +
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
      '</div>' +
      linkPanel(data.deal);

    // toggles
    bar.addEventListener('click', function (e) {
      var t = e.target.closest('[data-ac-toggle]');
      if (t) {
        var k = t.getAttribute('data-ac-toggle');
        ['tl', 'notes', 'link'].forEach(function (p) {
          var el = bar.querySelector('[data-ac-panel="' + p + '"]');
          if (el) el.style.display = (p === k && el.style.display === 'none') ? 'block' : 'none';
        });
        if (k === 'notes') loadNotes();
        if (k === 'link') { var si = bar.querySelector('[data-ac-link-search]'); if (si) setTimeout(function () { si.focus(); }, 0); }
        return;
      }
      if (e.target.closest('[data-ac-desk]')) { location.href = '/crm.html'; return; }
      if (e.target.closest('[data-ac-back]')) {
        // Deal pages usually open in a fresh tab (no history): try closing it
        // so Sara lands back on the CRM tab that opened it; otherwise walk
        // history; otherwise go to the desk.
        if (history.length > 1) { history.back(); return; }
        window.close();
        setTimeout(function () { location.href = '/crm.html'; }, 250);
        return;
      }
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
      if (e.target.closest('[data-ac-link-submit]')) { submitLink(e.target.closest('[data-ac-link-submit]')); return; }
    });

    wireLinkSearch();

    function submitLink(btn) {
      var g = function (s) { var el = bar.querySelector('[data-ac-link-' + s + ']'); return el ? el.value.trim() : ''; };
      var st = bar.querySelector('[data-ac-link-st]');
      var email = g('email');
      if (!email) { st.style.color = RED; st.textContent = 'Enter their email.'; return; }
      var provEl = bar.querySelector('[data-ac-link-provision]');
      var body = {
        deal: dealKey, email: email,
        first_name: g('first') || undefined, last_name: g('last') || undefined,
        phone: g('phone') || undefined,
        role: (bar.querySelector('[data-ac-link-role]') || {}).value || 'seller',
        provision: !!(provEl && provEl.checked)
      };
      btn.disabled = true; btn.textContent = 'Linking…';
      st.style.color = 'rgba(250,246,236,.7)'; st.textContent = 'Working…';
      api('/api/crm/link-deal-party', { method: 'POST', body: body }).then(function (r) {
        btn.disabled = false; btn.textContent = 'Link to portal';
        if (r.ok && r.j && r.j.linked) {
          var who = body.first_name || (r.j.lead && r.j.lead.email) || 'Client';
          var status = r.j.user_provisioned ? ' — they can sign in now.'
            : (r.j.user_linked ? ' — linked to their existing account.'
              : ' — link activates when they first sign in with this email.');
          st.style.color = GREEN;
          st.textContent = '✓ ' + who + ' linked as ' + (r.j.party && r.j.party.role || body.role)
            + (r.j.lead && r.j.lead.created ? ' (new client added)' : '') + status;
          ['search', 'email', 'first', 'last', 'phone'].forEach(function (s) { var el = bar.querySelector('[data-ac-link-' + s + ']'); if (el) el.value = ''; });
        } else {
          st.style.color = RED; st.textContent = '✗ ' + ((r.j && r.j.error) || 'Could not link.');
        }
      });
    }

    // Type-ahead over the whole CRM (GET roster?bucket=all). Picking a match
    // auto-fills the fields so a known contact is linked without retyping.
    function wireLinkSearch() {
      var input = bar.querySelector('[data-ac-link-search]');
      var box = bar.querySelector('[data-ac-link-matches]');
      if (!input || !box) return;
      var timer = null, tok = 0;
      var hide = function () { box.style.display = 'none'; box.innerHTML = ''; box._people = null; };
      var set = function (s, v) { var el = bar.querySelector('[data-ac-link-' + s + ']'); if (el && v != null) el.value = v; };
      input.addEventListener('input', function () {
        var term = input.value.trim();
        if (timer) clearTimeout(timer);
        if (term.length < 2) { hide(); return; }
        var mine = ++tok;
        timer = setTimeout(function () {
          fetch('/api/crm/roster?bucket=all&limit=8&q=' + encodeURIComponent(term), { credentials: 'include' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) {
              if (mine !== tok) return;
              var people = (j && j.people) || [];
              if (!people.length) { box.innerHTML = '<div style="padding:9px 11px;font-size:12.5px;color:#8A7B60;font-style:italic;">No match — fill the fields to add a new contact.</div>'; box.style.display = 'block'; box._people = null; return; }
              box._people = people;
              box.innerHTML = people.slice(0, 8).map(function (p, i) {
                var sub = [p.email, p.phone].filter(Boolean).join(' · ');
                return '<button type="button" data-lpick="' + i + '" style="display:block;width:100%;text-align:left;background:transparent;border:none;border-bottom:1px solid #EFE7D4;padding:9px 11px;cursor:pointer;">'
                  + '<span style="font-size:13.5px;color:' + INK + ';font-weight:600;">' + esc(p.name || '(no name)') + '</span>'
                  + (sub ? '<br><span style="font-size:12px;color:#8A7B60;">' + esc(sub) + '</span>' : '') + '</button>';
              }).join('');
              box.style.display = 'block';
            })
            .catch(function () { if (mine === tok) hide(); });
        }, 180);
      });
      box.addEventListener('click', function (e) {
        var b = e.target.closest('[data-lpick]');
        if (!b || !box._people) return;
        var p = box._people[parseInt(b.getAttribute('data-lpick'), 10)];
        if (!p) return;
        var nm = splitName(p.name);
        set('email', p.email || '');
        if (p.name && p.name !== p.email) { set('first', nm.first); set('last', nm.last); }
        if (p.phone) set('phone', p.phone);
        if (p.type === 'buyer' || p.type === 'seller') { var rl = bar.querySelector('[data-ac-link-role]'); if (rl) rl.value = p.type; }
        input.value = p.name || p.email || '';
        hide();
        var em = bar.querySelector('[data-ac-link-email]'); if (em) em.focus();
      });
      input.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });
    }

    var notesLoaded = false;
    function loadNotes() {
      if (notesLoaded) return; notesLoaded = true;
      api('/api/crm/deal-notes?deal=' + encodeURIComponent(dealKey), { method: 'GET' })
        .then(function (r) { var ta = bar.querySelector('[data-ac-notes]'); if (ta && r.ok) ta.value = (r.j && r.j.notes) || ''; });
    }
  }
})();
