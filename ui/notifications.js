// ui/notifications.js — Notification bell with red dot + dropdown
// Receives notifications from Telegram/WhatsApp webhooks via KV store
// Auto-polls every 30s when Flow is open

const NOTIF_KEY = 'flow_notifications';
const MAX_NOTIFS = 50;

let _bell = null, _dot = null, _dropdown = null, _panel = null;
let _pollTimer = null;
let _chatAdd = null;

export function initNotifications(Chat) {
  _chatAdd = (t) => Chat.add(t, 'bot');
  _buildUI();
  _startPolling();
}

function _buildUI() {
  // Bell button — injected into top bar
  const topBar = document.getElementById('top-bar');
  if (!topBar) return;

  const wrap = document.createElement('div');
  wrap.id = 'notif-wrap';
  wrap.style.cssText = 'position:relative;display:flex;align-items:center;';

  _bell = document.createElement('button');
  _bell.id = 'notif-bell';
  _bell.innerHTML = '🔔';
  _bell.title = 'Notifications';
  _bell.style.cssText = `
    background:transparent;border:none;font-size:18px;cursor:pointer;
    padding:6px 8px;border-radius:50%;position:relative;
    transition:background .15s;color:rgba(255,255,255,0.65);
  `;
  _bell.addEventListener('mouseenter', () => _bell.style.background = 'rgba(255,255,255,0.1)');
  _bell.addEventListener('mouseleave', () => _bell.style.background = 'transparent');
  _bell.addEventListener('click', _toggleDropdown);

  _dot = document.createElement('span');
  _dot.id = 'notif-dot';
  _dot.style.cssText = `
    position:absolute;top:4px;right:4px;width:9px;height:9px;
    border-radius:50%;background:#ef4444;border:2px solid #060a1a;
    display:none;animation:pulseDot 2s infinite;
  `;

  // Pulse animation
  const style = document.createElement('style');
  style.textContent = `
    @keyframes pulseDot {
      0%,100%{transform:scale(1);opacity:1}
      50%{transform:scale(1.3);opacity:0.7}
    }
    #notif-dropdown {
      position:absolute;top:calc(100% + 8px);right:0;
      width:320px;max-height:420px;
      background:rgba(255,255,255,0.1);
      backdrop-filter:blur(40px) saturate(200%);
      -webkit-backdrop-filter:blur(40px) saturate(200%);
      border:1px solid rgba(255,255,255,0.2);
      border-radius:18px;overflow:hidden;
      box-shadow:0 1px 0 rgba(255,255,255,0.14) inset, 0 20px 60px rgba(0,0,0,0.55);
      z-index:10000;display:none;flex-direction:column;
    }
    #notif-dropdown.open{display:flex;}
    #notif-header{
      display:flex;justify-content:space-between;align-items:center;
      padding:12px 16px 10px;border-bottom:1px solid rgba(255,255,255,0.1);
    }
    #notif-header-title{
      font-family:'Orbitron',monospace;font-size:9px;letter-spacing:.18em;
      color:rgba(255,255,255,0.5);
    }
    #notif-clear-btn{
      background:transparent;border:none;color:rgba(255,255,255,0.3);
      font-size:10px;cursor:pointer;font-family:'Rajdhani',sans-serif;
      letter-spacing:.06em;
    }
    #notif-clear-btn:hover{color:#f87171;}
    #notif-list{overflow-y:auto;max-height:300px;scrollbar-width:none;}
    #notif-list::-webkit-scrollbar{display:none;}
    .notif-item{
      display:flex;gap:10px;padding:10px 16px;
      border-bottom:1px solid rgba(255,255,255,0.06);
      cursor:pointer;transition:background .15s;
      align-items:flex-start;
    }
    .notif-item:hover{background:rgba(255,255,255,0.07);}
    .notif-item.unread{background:rgba(56,189,248,0.06);}
    .notif-icon{font-size:18px;flex-shrink:0;margin-top:2px;}
    .notif-body{flex:1;min-width:0;}
    .notif-source{
      font-family:'Orbitron',monospace;font-size:8px;letter-spacing:.12em;
      color:rgba(255,255,255,0.4);text-transform:uppercase;margin-bottom:2px;
    }
    .notif-text{
      font-family:'Rajdhani',sans-serif;font-size:13px;font-weight:600;
      color:rgba(255,255,255,0.85);line-height:1.4;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    }
    .notif-time{
      font-size:10px;color:rgba(255,255,255,0.3);margin-top:2px;
      font-family:'Rajdhani',sans-serif;
    }
    .notif-empty{
      padding:24px;text-align:center;
      color:rgba(255,255,255,0.25);font-family:'Rajdhani',sans-serif;font-size:13px;
    }
    #notif-see-all{
      display:block;width:100%;padding:12px;
      background:rgba(255,255,255,0.05);border:none;
      border-top:1px solid rgba(255,255,255,0.08);
      color:rgba(56,189,248,0.7);font-family:'Orbitron',monospace;
      font-size:9px;letter-spacing:.14em;cursor:pointer;
      transition:background .15s;text-align:center;
    }
    #notif-see-all:hover{background:rgba(255,255,255,0.1);color:#38bdf8;}
  `;
  document.head.appendChild(style);

  _dropdown = document.createElement('div');
  _dropdown.id = 'notif-dropdown';
  _dropdown.innerHTML = `
    <div id="notif-header">
      <span id="notif-header-title">NOTIFICATIONS</span>
      <button id="notif-clear-btn">Clear all</button>
    </div>
    <div id="notif-list"></div>
    <button id="notif-see-all">SEE ALL NOTIFICATIONS →</button>
  `;

  wrap.appendChild(_bell);
  wrap.appendChild(_dot);
  wrap.appendChild(_dropdown);
  topBar.appendChild(wrap);

  document.getElementById('notif-clear-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _clearAll();
  });

  document.getElementById('notif-see-all')?.addEventListener('click', () => {
    _showFullPage();
    _toggleDropdown();
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#notif-wrap')) {
      _dropdown.classList.remove('open');
    }
  });

  _renderList();
}

function _toggleDropdown() {
  if (!_dropdown) return;
  const isOpen = _dropdown.classList.toggle('open');
  if (isOpen) {
    _markAllRead();
    _renderList();
  }
}

function _getNotifs() {
  try { return JSON.parse(localStorage.getItem(NOTIF_KEY) || '[]'); } catch { return []; }
}

function _saveNotifs(notifs) {
  localStorage.setItem(NOTIF_KEY, JSON.stringify(notifs.slice(-MAX_NOTIFS)));
}

function _renderList() {
  const list = document.getElementById('notif-list');
  if (!list) return;
  const notifs = _getNotifs();

  if (!notifs.length) {
    list.innerHTML = '<div class="notif-empty">No notifications yet</div>';
    return;
  }

  list.innerHTML = notifs
    .slice().reverse().slice(0, 15)
    .map(n => `
      <div class="notif-item ${n.read ? '' : 'unread'}" data-id="${n.id}">
        <span class="notif-icon">${_sourceIcon(n.source)}</span>
        <div class="notif-body">
          <div class="notif-source">${n.source || 'Flow'}</div>
          <div class="notif-text">${_escape(n.text)}</div>
          <div class="notif-time">${_timeAgo(n.ts)}</div>
        </div>
      </div>`)
    .join('');
}

function _sourceIcon(source) {
  if (!source) return '🔔';
  const s = source.toLowerCase();
  if (s.includes('telegram')) return '✈️';
  if (s.includes('whatsapp')) return '💬';
  if (s.includes('instagram')) return '📸';
  if (s.includes('twitter') || s.includes('x.com')) return '🐦';
  return '🔔';
}

function _escape(t) {
  return (t || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').slice(0, 100);
}

function _timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff/60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff/3600000) + 'h ago';
  return new Date(ts).toLocaleDateString();
}

function _markAllRead() {
  const notifs = _getNotifs().map(n => ({ ...n, read: true }));
  _saveNotifs(notifs);
  if (_dot) _dot.style.display = 'none';
}

function _clearAll() {
  _saveNotifs([]);
  _renderList();
  if (_dot) _dot.style.display = 'none';
}

function _showFullPage() {
  // Remove existing page
  document.getElementById('notif-page')?.remove();

  const page = document.createElement('div');
  page.id = 'notif-page';
  page.style.cssText = `
    position:fixed;inset:0;z-index:50000;
    background:rgba(6,10,26,0.97);
    backdrop-filter:blur(30px);
    display:flex;flex-direction:column;
    padding:60px 24px 24px;
    overflow-y:auto;
  `;

  const notifs = _getNotifs().slice().reverse();
  page.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;">
      <span style="font-family:'Orbitron',monospace;font-size:14px;letter-spacing:.2em;color:#38bdf8;">ALL NOTIFICATIONS</span>
      <button id="notif-page-close" style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.18);color:#fff;font-size:14px;padding:6px 16px;border-radius:12px;cursor:pointer;font-family:'Orbitron',monospace;font-size:9px;letter-spacing:.14em;">CLOSE</button>
    </div>
    <div id="notif-page-list">
      ${notifs.length ? notifs.map(n => `
        <div class="notif-item" style="border-radius:12px;margin-bottom:8px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.09);">
          <span class="notif-icon">${_sourceIcon(n.source)}</span>
          <div class="notif-body">
            <div class="notif-source">${n.source || 'Flow'}</div>
            <div class="notif-text" style="white-space:normal;">${_escape(n.text)}</div>
            <div class="notif-time">${_timeAgo(n.ts)}</div>
          </div>
        </div>`).join('') : '<div class="notif-empty">No notifications yet</div>'}
    </div>
  `;
  document.body.appendChild(page);
  document.getElementById('notif-page-close')?.addEventListener('click', () => page.remove());
}

// Called by Telegram/WhatsApp webhook response relayed to client
export function addNotification({ source, text, ts }) {
  const notifs = _getNotifs();
  notifs.push({ id: Date.now(), source, text, ts: ts || Date.now(), read: false });
  _saveNotifs(notifs);
  _updateDot();
  _renderList();
  // Also add to Flow chat
  _chatAdd?.(`📨 **${source}:** ${text}`);
}

function _updateDot() {
  const unread = _getNotifs().filter(n => !n.read).length;
  if (_dot) _dot.style.display = unread ? 'block' : 'none';
}

// Poll KV for new notifications from webhooks
async function _startPolling() {
  const poll = async () => {
    try {
      const r = await fetch('/api/memory?key=flow_pending_notifs');
      if (!r.ok) return;
      const d = await r.json();
      if (!d.value || !Array.isArray(d.value)) return;
      const pending = d.value;
      if (!pending.length) return;
      // Add each pending notification
      pending.forEach(n => addNotification(n));
      // Clear the queue
      await fetch('/api/memory', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ key: 'flow_pending_notifs', value: [] }),
      });
    } catch(_) {}
  };

  await poll();
  _pollTimer = setInterval(poll, 30000);  // check every 30s
}

export function stopNotifications() {
  if (_pollTimer) clearInterval(_pollTimer);
}
