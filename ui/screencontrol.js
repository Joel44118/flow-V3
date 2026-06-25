// ui/screencontrol.js (v6)
// Routes screen control commands from Flow text/voice to the extension
// Does NOT call chrome.runtime directly (blocked by Chrome security policy)
// All commands route: postMessage → content.js → chrome.runtime → background.js
//
// Exports:
//   - initScreenControl(Chat, Orb, sendToAI): initialize
//   - parseScreenControl(text): detect and route scroll/click/gesture commands
//   - sendToExtension(action, payload): send command to extension

let _extId = null;
let _pendingReplies = new Map();
let _replyTimeouts = new Map();

// ────────────────────────────────────────────────────────────────────────────
// REQUEST EXTENSION ID (from content.js via postMessage)
// ────────────────────────────────────────────────────────────────────────────

async function _requestExtId() {
  const maxRetries = 3;
  for (let i = 0; i < maxRetries; i++) {
    window.postMessage({ source: 'flow-ext-id-request' }, '*');
    await new Promise(r => setTimeout(r, 500 + i * 1000));
    if (_extId) break;
  }
}

window.addEventListener('message', (event) => {
  if (event.data.source === 'flow-ext-id-reply') {
    _extId = event.data.extensionId;
    console.log('[Flow SC] Extension connected ✓ ID:', _extId);
  } else if (event.data.source === 'flow-control-reply') {
    // Route reply to pending handler if exists
    const replyId = event.data.replyId;
    if (_pendingReplies.has(replyId)) {
      const handler = _pendingReplies.get(replyId);
      clearTimeout(_replyTimeouts.get(replyId));
      _pendingReplies.delete(replyId);
      _replyTimeouts.delete(replyId);
      if (handler) handler(event.data);
    }
  }
});

// ────────────────────────────────────────────────────────────────────────────
// SEND TO EXTENSION (via postMessage relay)
// ────────────────────────────────────────────────────────────────────────────

function _send(action, payload, onReply) {
  if (!_extId) {
    console.warn('[Flow SC] Extension not connected. Retrying...');
    _requestExtId().then(() => _send(action, payload, onReply));
    return;
  }

  const replyId = Math.random().toString(36).slice(2, 11);

  try {
    window.postMessage({
      source: 'flow-control-page',
      replyId: replyId,
      action: action,
      payload: payload
    }, '*');

    if (onReply) {
      _pendingReplies.set(replyId, onReply);
      _replyTimeouts.set(replyId, setTimeout(() => {
        _pendingReplies.delete(replyId);
        _replyTimeouts.delete(replyId);
      }, 3000));
    }
  } catch (err) {
    console.error('[Flow SC] Send error:', err.message);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// MODULE EXPORTS
// ────────────────────────────────────────────────────────────────────────────

export async function initScreenControl(Chat, Orb, sendToAI) {
  await _requestExtId();
  return { sendToExtension };
}

export function parseScreenControl(text) {
  // Detect scroll commands: "scroll up", "scroll down", "scroll left", "scroll right"
  const scrollRx = /scroll\s+(up|down|left|right|top|bottom)|\b(up|down|left|right)\s+scroll/i;
  const scrollMatch = text.match(scrollRx);
  if (scrollMatch) {
    const direction = (scrollMatch[1] || scrollMatch[2]).toLowerCase();
    sendToExtension('scroll', { 
      direction: direction,
      distance: 100 
    });
    return true;  // Command was handled
  }

  // Detect click commands: "click", "tap"
  const clickRx = /\bclick\b|\btap\b/i;
  if (clickRx.test(text)) {
    sendToExtension('click', { x: null, y: null });
    return true;
  }

  // Detect gesture control commands: "start gesture control", "stop gesture control"
  if (/start\s+gesture|gesture\s+control|gesture\s+mode/i.test(text)) {
    return 'gesture-setup';  // Signal to trigger gesture.start()
  }

  if (/stop\s+gesture|end\s+gesture/i.test(text)) {
    return 'gesture-stop';  // Signal to trigger gesture.stop()
  }

  // Not a screen control command
  return null;
}

export function sendToExtension(action, payload) {
  _send(action, payload);
}
