/* client-chat.js — the "message Sara" drawer that lives on every client page
   (seller portal, curated collections). One thread per client, channel='portal',
   polled while open so the agent's replies appear without a refresh.

   Usage: LegacyChat.init({
     fetchThread: async () => [{direction,body,created_at}, ...],
     sendMessage: async (text) => true,
     agentName: 'Sara', accent: '#B08D57'
   });
   Pages that can't identify a client simply never call init — no button shows. */
(function () {
  'use strict';
  var open = false, timer = null, lastCount = -1;

  function el(tag, css, html) {
    var n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (html != null) n.innerHTML = html;
    return n;
  }
  var escDiv = document.createElement('div');
  function esc(s) { escDiv.textContent = s == null ? '' : String(s); return escDiv.innerHTML; }
  function clock(iso) {
    try { return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
    catch (e) { return ''; }
  }

  window.LegacyChat = {
    init: function (cfg) {
      var agent = cfg.agentName || 'Sara';
      var accent = cfg.accent || '#B08D57';
      var ink = '#1A1714', paper = '#FAF6EC';

      var btn = el('button',
        'position:fixed;right:22px;bottom:22px;z-index:99990;background:' + ink + ';color:' + paper + ';border:none;border-radius:999px;padding:14px 22px;font-family:Georgia,serif;font-size:15px;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.25);display:flex;align-items:center;gap:9px;',
        '<span style="width:9px;height:9px;border-radius:50%;background:' + accent + ';display:inline-block;"></span> Message ' + esc(agent));
      btn.setAttribute('aria-label', 'Message ' + agent);

      var panel = el('div',
        'position:fixed;right:22px;bottom:84px;z-index:99991;width:min(360px, calc(100vw - 44px));max-height:70vh;background:' + paper + ';border:1px solid #D9CFB7;border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.28);display:none;flex-direction:column;overflow:hidden;font-family:Georgia,serif;color:' + ink + ';');
      panel.innerHTML =
        '<div style="padding:13px 16px;background:' + ink + ';color:' + paper + ';display:flex;justify-content:space-between;align-items:center;">' +
          '<div><div style="font-size:15px;">' + esc(agent) + ' Cooper</div><div style="font-family:monospace;font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:' + accent + ';">Legacy Properties · replies land right here</div></div>' +
          '<button data-lgc-x style="background:none;border:none;color:' + paper + ';font-size:18px;cursor:pointer;" aria-label="Close">×</button>' +
        '</div>' +
        '<div data-lgc-thread style="flex:1;overflow-y:auto;padding:14px 14px 6px;display:flex;flex-direction:column;gap:9px;min-height:120px;max-height:44vh;"></div>' +
        '<div style="padding:10px 12px 12px;border-top:1px solid #D9CFB7;display:flex;gap:8px;">' +
          '<textarea data-lgc-in rows="2" placeholder="Write to ' + esc(agent) + '…" style="flex:1;font:inherit;font-size:14px;padding:9px 11px;border:1px solid #C9BEA8;border-radius:8px;background:#fff;resize:none;"></textarea>' +
          '<button data-lgc-send style="background:' + ink + ';color:' + paper + ';border:none;border-radius:8px;padding:0 18px;font-family:monospace;font-size:11px;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;">Send</button>' +
        '</div>';
      document.body.appendChild(btn);
      document.body.appendChild(panel);

      var threadEl = panel.querySelector('[data-lgc-thread]');
      var input = panel.querySelector('[data-lgc-in]');
      var sendBtn = panel.querySelector('[data-lgc-send]');

      function paint(rows) {
        if (!rows.length) {
          threadEl.innerHTML = '<div style="font-style:italic;font-size:13.5px;color:#7C6A4D;padding:8px 2px;">No messages yet — say hello. ' + esc(agent) + ' reads everything herself and usually replies fast.</div>';
          return;
        }
        threadEl.innerHTML = rows.map(function (m) {
          var mine = m.direction === 'inbound';
          return '<div style="align-self:' + (mine ? 'flex-end' : 'flex-start') + ';max-width:85%;">' +
            '<div style="background:' + (mine ? ink : '#fff') + ';color:' + (mine ? paper : ink) + ';border:1px solid ' + (mine ? ink : '#D9CFB7') + ';border-radius:12px;padding:9px 13px;font-size:14px;line-height:1.5;white-space:pre-wrap;">' + esc(m.body) + '</div>' +
            '<div style="font-family:monospace;font-size:8.5px;letter-spacing:.08em;color:#A79A80;margin:3px 4px 0;text-align:' + (mine ? 'right' : 'left') + ';">' + (mine ? 'You' : esc(agent)) + ' · ' + esc(clock(m.created_at)) + '</div>' +
          '</div>';
        }).join('');
        if (rows.length !== lastCount) threadEl.scrollTop = threadEl.scrollHeight;
        lastCount = rows.length;
      }

      async function refresh() {
        try { paint(await cfg.fetchThread() || []); } catch (e) { /* keep last */ }
      }

      function setOpen(v) {
        open = v;
        panel.style.display = v ? 'flex' : 'none';
        if (v) { refresh(); timer = setInterval(refresh, 20000); input.focus(); }
        else if (timer) { clearInterval(timer); timer = null; }
      }
      btn.addEventListener('click', function () { setOpen(!open); });
      panel.querySelector('[data-lgc-x]').addEventListener('click', function () { setOpen(false); });

      async function send() {
        var text = input.value.trim();
        if (!text) return;
        sendBtn.disabled = true; sendBtn.textContent = '…';
        try {
          var okSend = await cfg.sendMessage(text);
          if (okSend) { input.value = ''; await refresh(); }
        } catch (e) { /* leave text for retry */ }
        sendBtn.disabled = false; sendBtn.textContent = 'Send';
      }
      sendBtn.addEventListener('click', send);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      });
    }
  };
})();
