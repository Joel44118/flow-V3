// ui/screencontrol.js (v8)
// FIX: parseScreenControl now handles read/type/click/scroll with _chatAdd feedback
// All commands: postMessage → content.js → background.js → target tab

let _extId       = null;
let _extReady    = false;
let _chatAdd     = null;
let _pendingReplies = new Map();
let _replyTimeouts  = new Map();

window.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.source === 'flow-ext-id') {
    _extId    = event.data.extensionId;
    _extReady = true;
    console.log('[Flow SC] Extension connected ✓ ID:', _extId);
    return;
  }
  if (event.data.source === 'flow-ext-reply') {
    const { msgId } = event.data;
    if (_pendingReplies.has(msgId)) {
      const handler = _pendingReplies.get(msgId);
      clearTimeout(_replyTimeouts.get(msgId));
      _pendingReplies.delete(msgId);
      _replyTimeouts.delete(msgId);
      if (handler) handler(event.data);
    }
  }
});

async function _requestExtId() {
  for (let i = 0; i < 6; i++) {
    if (_extReady) return;
    window.postMessage({ source: 'flow-ext-id-request' }, '*');
    await new Promise(r => setTimeout(r, 700 + i * 400));
    if (_extReady) return;
  }
}

function _send(action, payload, onReply) {
  if (!_extReady) {
    _requestExtId().then(() => {
      if (_extReady) _send(action, payload, onReply);
      else _chatAdd?.('⚠️ Flow extension not connected. Make sure it\'s installed and reload.', 'bot');
    });
    return;
  }

  const msgId = Math.random().toString(36).slice(2, 11);
  window.postMessage({ source: 'flow-control-page', msgId, action, payload }, '*');

  if (onReply) {
    _pendingReplies.set(msgId, onReply);
    _replyTimeouts.set(msgId, setTimeout(() => {
      _pendingReplies.delete(msgId);
      _replyTimeouts.delete(msgId);
      onReply({ ok: false, error: 'Timeout — no response from target tab' });
    }, 7000));
  }
}

export async function initScreenControl(Chat, Orb, sendToAI) {
  _chatAdd = Chat?.add?.bind(Chat);
  await _requestExtId();
  return { sendToExtension };
}

// ── Command parser ─────────────────────────────────────────────────────────

export function parseScreenControl(text) {
  const t = text.toLowerCase().trim();

  // Gesture triggers
  if (/start\s+gesture|gesture\s+control|gesture\s+mode|open\s+gesture/i.test(t)) return 'gesture-setup';
  if (/stop\s+gesture|end\s+gesture|close\s+gesture/i.test(t))                    return 'gesture-stop';

  // Scroll — match "scroll up/down", "scroll to top/bottom", "go up/down"
  const scrollM = t.match(/scroll\s+(up|down|left|right|top|bottom)|go\s+(up|down)|page\s+(up|down)/i);
  if (scrollM) {
    const dir = (scrollM[1] || scrollM[2] || scrollM[3]).toLowerCase();
    const amount = /top|bottom/.test(dir) ? 9999 : 500;
    sendToExtension('scroll', { direction: dir, amount });
    _chatAdd?.(`⬆️ Scrolling ${dir}…`, 'bot');
    return true;
  }

  // Click — "click [target]"
  const clickM = t.match(/\bclick(?:\s+on)?\s+(.+)|^tap\s+(.+)/i);
  if (clickM) {
    const target = (clickM[1] || clickM[2] || '').trim();
    sendToExtension('click', { target }, (r) => {
      _chatAdd?.(r.ok ? `✅ Clicked "${r.result?.clicked || target}"` : `⚠️ Click failed: ${r.error}`, 'bot');
    });
    _chatAdd?.(`🖱️ Clicking "${target || 'focused element'}"…`, 'bot');
    return true;
  }

  // Type — "type [text]" or "type [text] in [field]"
  const typeM = t.match(/\btype\s+(.+?)(?:\s+in(?:to)?\s+(.+))?$/i);
  if (typeM) {
    const txt   = typeM[1].trim();
    const field = typeM[2]?.trim() || '';
    sendToExtension('type', { text: txt, field }, (r) => {
      _chatAdd?.(r.ok ? `⌨️ Typed "${txt}"` : `⚠️ Type failed: ${r.error}`, 'bot');
    });
    _chatAdd?.(`⌨️ Typing "${txt}"…`, 'bot');
    return true;
  }

  // Read page
  if (/\bread\s+(the\s+)?page|\bread\s+(the\s+)?screen|what(?:'s|\s+is)\s+on\s+(the\s+)?page/i.test(t)) {
    sendToExtension('read', {}, (r) => {
      if (!r.ok) { _chatAdd?.(`⚠️ Read failed: ${r.error}`, 'bot'); return; }
      const content = r.result?.text || '';
      const title   = r.result?.title || '';
      _chatAdd?.(`📄 **${title}**\n\n${content.slice(0, 1200)}${content.length > 1200 ? '\n\n_…(truncated)_' : ''}`, 'bot');
    });
    _chatAdd?.('📖 Reading the page…', 'bot');
    return true;
  }

  // Navigate
  const navM = t.match(/\bgo\s+to\s+(?:https?:\/\/)?([^\s]+\.[^\s]+)/i);
  if (navM) {
    const url = navM[1].startsWith('http') ? navM[1] : 'https://' + navM[1];
    sendToExtension('navigate', { url }, (r) => {
      _chatAdd?.(r.ok ? `🌐 Navigating to ${url}` : `⚠️ Navigate failed: ${r.error}`, 'bot');
    });
    _chatAdd?.(`🌐 Going to ${url}…`, 'bot');
    return true;
  }

  // Back / refresh
  if (/\bgo\s+back\b/i.test(t))   { sendToExtension('back',    {}, r => _chatAdd?.(r.ok ? '⬅️ Went back' : `⚠️ ${r.error}`, 'bot')); return true; }
  if (/\brefresh\b|\breload\b/i.test(t)) { sendToExtension('refresh', {}, r => _chatAdd?.(r.ok ? '🔄 Refreshed' : `⚠️ ${r.error}`, 'bot')); return true; }

  return null;
}

export function sendToExtension(action, payload, onReply) {
  _send(action, payload || {}, onReply);
}
