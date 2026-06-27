// ui/screencontrol.js (v9)
// FIX: Intent-aware parsing — only triggers on clear commands, not in conversation
// FIX: Ping target tab before action to detect timeout early and give clear error
// FIX: Better error messages telling user to open extension + switch to target tab

let _extId          = null;
let _extReady       = false;
let _chatAdd        = null;
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
    await new Promise(r => setTimeout(r, 600 + i * 400));
    if (_extReady) return;
  }
}

function _send(action, payload, onReply) {
  if (!_extReady) {
    _requestExtId().then(() => {
      if (_extReady) _send(action, payload, onReply);
      else {
        _chatAdd?.(
          '⚠️ Flow extension not connected.\n\n' +
          '1. Install the Flow extension in Chrome\n' +
          '2. Open the tab you want to control\n' +
          '3. Come back to Flow and try again',
          'bot'
        );
        onReply?.({ ok: false, error: 'Extension not connected' });
      }
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
      onReply({
        ok:    false,
        error: 'No response from target tab. Make sure you have another tab open and it\'s not a chrome:// page.',
      });
    }, 8000));
  }
}

// Ping the target tab first — fast check before executing
function _pingThenSend(action, payload, onReply) {
  _send('ping', {}, (pingResult) => {
    if (!pingResult.ok) {
      onReply?.({
        ok:    false,
        error: 'Target tab not reachable. Open a regular web page in another tab first.',
      });
      return;
    }
    _send(action, payload, onReply);
  });
}

export async function initScreenControl(Chat, Orb, sendToAI) {
  _chatAdd = Chat?.add?.bind(Chat);
  await _requestExtId();
  return { sendToExtension };
}

// ── Intent guard ───────────────────────────────────────────────────────────
// Returns true only if the message is clearly a direct screen control command
// Prevents "I scrolled through Twitter today" from triggering scroll
function _isScreenCommand(text) {
  const t = text.trim();

  // Must be a short, imperative sentence (not a paragraph or question in context)
  if (t.length > 120) return false;

  // Must start with or be purely a command verb pattern
  const COMMAND_PATTERNS = [
    /^(scroll|go\s+(up|down|back|to)|page\s+(up|down))\b/i,
    /^click\s+(on\s+)?\S/i,
    /^tap\s+\S/i,
    /^type\s+.{2,}/i,
    /^read\s+(the\s+)?(page|screen)$/i,
    /^what('s|\s+is)\s+on\s+(the\s+)?page$/i,
    /^go\s+to\s+https?:\/\//i,
    /^go\s+to\s+\w[\w.-]+\.\w{2,}/i,
    /^(refresh|reload)\s*$/i,
    /^go\s+back\s*$/i,
    /^(start|stop|open|close)\s+gesture/i,
  ];

  return COMMAND_PATTERNS.some(rx => rx.test(t));
}

// ── Command parser ─────────────────────────────────────────────────────────
export function parseScreenControl(text) {
  // Only trigger if this looks like a real command, not casual conversation
  if (!_isScreenCommand(text)) return null;

  const t = text.toLowerCase().trim();

  // Gesture
  if (/start\s+gesture|gesture\s+(control|mode)|open\s+gesture/i.test(t)) return 'gesture-setup';
  if (/stop\s+gesture|end\s+gesture|close\s+gesture/i.test(t))            return 'gesture-stop';

  // Scroll
  const scrollM = t.match(/^scroll\s+(up|down|left|right|top|bottom)|^go\s+(up|down)|^page\s+(up|down)/i);
  if (scrollM) {
    const dir    = (scrollM[1] || scrollM[2] || scrollM[3]).toLowerCase();
    const amount = /top|bottom/.test(dir) ? 9999 : 500;
    _chatAdd?.(`🖱️ Scrolling ${dir}…`, 'bot');
    _pingThenSend('scroll', { direction: dir, amount }, (r) => {
      if (!r.ok) _chatAdd?.(`⚠️ Scroll failed: ${r.error}`, 'bot');
    });
    return true;
  }

  // Click
  const clickM = text.match(/^click(?:\s+on)?\s+(.+)/i) || text.match(/^tap\s+(.+)/i);
  if (clickM) {
    const target = clickM[1].trim();
    _chatAdd?.(`🖱️ Clicking "${target}"…`, 'bot');
    _pingThenSend('click', { target }, (r) => {
      if (r.ok) _chatAdd?.(`✅ Clicked "${r.result?.clicked || target}"`, 'bot');
      else      _chatAdd?.(`⚠️ Click failed: ${r.error}`, 'bot');
    });
    return true;
  }

  // Type
  const typeM = text.match(/^type\s+(.+?)(?:\s+in(?:to)?\s+(.+))?$/i);
  if (typeM) {
    const txt   = typeM[1].trim();
    const field = typeM[2]?.trim() || '';
    _chatAdd?.(`⌨️ Typing "${txt}"…`, 'bot');
    _pingThenSend('type', { text: txt, field }, (r) => {
      if (r.ok) _chatAdd?.(`✅ Typed "${txt}"`, 'bot');
      else      _chatAdd?.(`⚠️ Type failed: ${r.error}`, 'bot');
    });
    return true;
  }

  // Read page
  if (/^read\s+(the\s+)?(page|screen)$|^what('s|\s+is)\s+on\s+(the\s+)?page$/i.test(t)) {
    _chatAdd?.('📖 Reading the page…', 'bot');
    _pingThenSend('read', {}, (r) => {
      if (!r.ok) { _chatAdd?.(`⚠️ Read failed: ${r.error}`, 'bot'); return; }
      const content = r.result?.text || '';
      const title   = r.result?.title || 'Page';
      _chatAdd?.(`📄 **${title}**\n\n${content.slice(0, 1200)}${content.length > 1200 ? '\n\n_(truncated)_' : ''}`, 'bot');
    });
    return true;
  }

  // Navigate to URL
  const navM = text.match(/^go\s+to\s+(https?:\/\/\S+|\S+\.\S+)/i);
  if (navM) {
    const url = navM[1].startsWith('http') ? navM[1] : 'https://' + navM[1];
    _chatAdd?.(`🌐 Navigating to ${url}…`, 'bot');
    _pingThenSend('navigate', { url }, (r) => {
      if (!r.ok) _chatAdd?.(`⚠️ Navigate failed: ${r.error}`, 'bot');
    });
    return true;
  }

  // Back / refresh
  if (/^go\s+back$/i.test(t)) {
    _pingThenSend('back', {}, r => { if (!r.ok) _chatAdd?.(`⚠️ ${r.error}`, 'bot'); else _chatAdd?.('⬅️ Went back', 'bot'); });
    return true;
  }
  if (/^(refresh|reload)$/i.test(t)) {
    _pingThenSend('refresh', {}, r => { if (!r.ok) _chatAdd?.(`⚠️ ${r.error}`, 'bot'); else _chatAdd?.('🔄 Refreshed', 'bot'); });
    return true;
  }

  return null;
}

export function sendToExtension(action, payload, onReply) {
  _send(action, payload || {}, onReply);
}
