// ui/screencontrol.js (v7)
// Routes screen control commands from Flow text/voice to the extension
// All commands route: postMessage → content.js → chrome.runtime → background.js
//
// FIX: Listen for 'flow-ext-id' (what content.js actually broadcasts),
//      not 'flow-ext-id-reply' (old name that never fired)
//
// Exports:
//   - initScreenControl(Chat, Orb, sendToAI): initialize
//   - parseScreenControl(text): detect and route commands
//   - sendToExtension(action, payload): send command to extension

let _extId         = null;
let _extReady      = false;
let _pendingReplies  = new Map();
let _replyTimeouts   = new Map();

// ────────────────────────────────────────────────────────────────────────────
// LISTEN FOR MESSAGES FROM CONTENT.JS / BACKGROUND RELAY
// ────────────────────────────────────────────────────────────────────────────

window.addEventListener('message', (event) => {
  if (!event.data) return;

  // content.js broadcasts this on load AND on request — this is the real source name
  if (event.data.source === 'flow-ext-id') {
    _extId    = event.data.extensionId;
    _extReady = true;
    console.log('[Flow SC] Extension connected ✓ ID:', _extId);
    return;
  }

  // Reply from background via content.js relay
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

// ────────────────────────────────────────────────────────────────────────────
// REQUEST EXTENSION ID
// ────────────────────────────────────────────────────────────────────────────

async function _requestExtId() {
  for (let i = 0; i < 5; i++) {
    if (_extReady) return;
    window.postMessage({ source: 'flow-ext-id-request' }, '*');
    await new Promise(r => setTimeout(r, 600 + i * 500));
    if (_extReady) return;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// SEND TO EXTENSION (via postMessage → content.js → background.js)
// ────────────────────────────────────────────────────────────────────────────

function _send(action, payload, onReply) {
  if (!_extReady || !_extId) {
    console.warn('[Flow SC] Extension not connected. Retrying...');
    _requestExtId().then(() => {
      if (_extReady) _send(action, payload, onReply);
      else console.error('[Flow SC] Extension unavailable — install the Flow extension.');
    });
    return;
  }

  const msgId = Math.random().toString(36).slice(2, 11);

  try {
    window.postMessage({
      source:  'flow-control-page',
      msgId,
      action,
      payload
    }, '*');

    if (onReply) {
      _pendingReplies.set(msgId, onReply);
      _replyTimeouts.set(msgId, setTimeout(() => {
        _pendingReplies.delete(msgId);
        _replyTimeouts.delete(msgId);
      }, 5000));
    }
  } catch (err) {
    console.error('[Flow SC] Send error:', err.message);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────────────────

export async function initScreenControl(Chat, Orb, sendToAI) {
  await _requestExtId();
  return { sendToExtension };
}

export function parseScreenControl(text) {
  const scrollRx = /scroll\s+(up|down|left|right|top|bottom)|\b(up|down|left|right)\s+scroll/i;
  const scrollMatch = text.match(scrollRx);
  if (scrollMatch) {
    const direction = (scrollMatch[1] || scrollMatch[2]).toLowerCase();
    sendToExtension('scroll', { direction, amount: 400 });
    return true;
  }

  const clickRx = /\bclick\b|\btap\b/i;
  if (clickRx.test(text)) {
    sendToExtension('click', { target: '' });
    return true;
  }

  if (/start\s+gesture|gesture\s+control|gesture\s+mode/i.test(text)) {
    return 'gesture-setup';
  }

  if (/stop\s+gesture|end\s+gesture/i.test(text)) {
    return 'gesture-stop';
  }

  return null;
}

export function sendToExtension(action, payload) {
  _send(action, payload);
}
