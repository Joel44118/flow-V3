// ui/screencontrol.js (v9)
// FIX: Intent-aware parsing — only triggers on clear commands, not in conversation
// FIX: Ping target tab before action to detect timeout early and give clear error
// FIX: Better error messages telling user to open extension + switch to target tab

// ── Electron-native OS control ──────────────────────────────────────────
// The real gap this fixes: gesture control already proves robot.js can
// move the mouse, click, scroll, and type at the OS level inside
// Electron — but text/voice commands ("scroll down", "click login") were
// ALWAYS routed through the Chrome-extension relay below, regardless of
// whether Flow was even running in a browser tab. In Electron there is no
// extension to connect to, so every single command failed with
// "extension not connected" — exactly what was reported, and a structural
// bug, not a flaky one.
//
// HONEST LIMITATION: scroll maps cleanly to OS-level (robot.scrollMouse
// doesn't care what's on screen). Click-by-label ("click login") does NOT
// map cleanly — there's no DOM to search at the OS level, only pixels.
// For that, this reuses the existing vision pipeline: screenshot → ask
// where the labeled thing is on screen → click those coordinates. This
// is meaningfully less reliable than clicking a DOM element by exact
// text match (which the old extension approach did), and says so if
// vision can't pin down a confident location, rather than guessing.
const IS_ELECTRON = !!window.__flowElectron;

async function _electronScroll(direction, amount) {
  window.__flowElectron.send('scroll', { direction, amount });
  return { ok: true };
}

async function _electronClick(target) {
  const sentinel = window.__flowElectron.sentinel;
  if (!sentinel) return { ok: false, error: 'Screen control bridge not available in this build.' };

  const shot = await sentinel.rawScreenshot();
  if (!shot.ok) return { ok: false, error: `Couldn't see the screen: ${shot.error}` };

  // Ask vision specifically for a coordinate — most vision models can give
  // an approximate position when asked directly and clearly for one.
  const r = await fetch('/api/vision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image: shot.image,
      prompt: `Find "${target}" on this screen. Respond with ONLY two numbers separated by a comma — the x,y pixel coordinate of its center — nothing else. If you genuinely cannot find it, respond with exactly: NOT_FOUND`,
    }),
  }).then(r => r.json()).catch(() => null);

  const coordMatch = r?.description?.match(/(\d+)\s*,\s*(\d+)/);
  if (!coordMatch) return { ok: false, error: `Couldn't pinpoint "${target}" on screen confidently enough to click it safely.` };

  const [, x, y] = coordMatch;
  window.__flowElectron.sentinel.replayExecute('click', Number(x), Number(y));
  return { ok: true, result: { clicked: target } };
}

async function _electronType(text) {
  // Types wherever the OS cursor/focus currently is — there's no DOM
  // field to target at this level, so this only works right after a
  // click has placed focus somewhere, same real limitation any OS-level
  // automation has (this is exactly how gesture control's type already
  // behaves, so it's at least a consistent, already-proven behavior).
  window.__flowElectron.send('type_text', { text });
  return { ok: true };
}

// ── Chrome extension relay (browser tab / non-Electron only) ───────────
let _extReady       = false;
let _extId          = null; // REAL BUG FIX: this was assigned at line ~76
                             // below but never declared anywhere in the
                             // file — in an ES module (strict mode by
                             // default), assigning to an undeclared
                             // variable throws ReferenceError: _extId is
                             // not defined, exactly the bug flagged in
                             // the original handoff notes and never
                             // fixed until now.
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
    if (IS_ELECTRON) {
      _electronScroll(dir, amount);
    } else {
      _pingThenSend('scroll', { direction: dir, amount }, (r) => {
        if (!r.ok) _chatAdd?.(`⚠️ Scroll failed: ${r.error}`, 'bot');
      });
    }
    return true;
  }

  // Click
  const clickM = text.match(/^click(?:\s+on)?\s+(.+)/i) || text.match(/^tap\s+(.+)/i);
  if (clickM) {
    const target = clickM[1].trim();
    _chatAdd?.(`🖱️ Clicking "${target}"…`, 'bot');
    if (IS_ELECTRON) {
      _electronClick(target).then((r) => {
        if (r.ok) _chatAdd?.(`✅ Clicked "${target}"`, 'bot');
        else      _chatAdd?.(`⚠️ Click failed: ${r.error}`, 'bot');
      });
    } else {
      _pingThenSend('click', { target }, (r) => {
        if (r.ok) _chatAdd?.(`✅ Clicked "${r.result?.clicked || target}"`, 'bot');
        else      _chatAdd?.(`⚠️ Click failed: ${r.error}`, 'bot');
      });
    }
    return true;
  }

  // Type
  const typeM = text.match(/^type\s+(.+?)(?:\s+in(?:to)?\s+(.+))?$/i);
  if (typeM) {
    const txt   = typeM[1].trim();
    const field = typeM[2]?.trim() || '';
    _chatAdd?.(`⌨️ Typing "${txt}"…`, 'bot');
    if (IS_ELECTRON) {
      _electronType(txt);
      _chatAdd?.(`✅ Typed "${txt}" — wherever the cursor currently has focus (click a field first if this typed in the wrong place).`, 'bot');
    } else {
      _pingThenSend('type', { text: txt, field }, (r) => {
        if (r.ok) _chatAdd?.(`✅ Typed "${txt}"`, 'bot');
        else      _chatAdd?.(`⚠️ Type failed: ${r.error}`, 'bot');
      });
    }
    return true;
  }

  // Read page
  if (/^read\s+(the\s+)?(page|screen)$|^what('s|\s+is)\s+on\s+(the\s+)?page$/i.test(t)) {
    if (IS_ELECTRON) {
      _chatAdd?.('📖 Reading the screen…', 'bot');
      window.__flowElectron.sentinel.askNow().then((r) => {
        if (!r.ok) _chatAdd?.(`⚠️ Read failed: ${r.error}`, 'bot');
        else       _chatAdd?.(`📄 ${r.description}`, 'bot');
      });
    } else {
      _chatAdd?.('📖 Reading the page…', 'bot');
      _pingThenSend('read', {}, (r) => {
        if (!r.ok) { _chatAdd?.(`⚠️ Read failed: ${r.error}`, 'bot'); return; }
        const content = r.result?.text || '';
        const title   = r.result?.title || 'Page';
        _chatAdd?.(`📄 **${title}**\n\n${content.slice(0, 1200)}${content.length > 1200 ? '\n\n_(truncated)_' : ''}`, 'bot');
      });
    }
    return true;
  }

  // Navigate to URL — genuinely requires a browser tab, no OS-level
  // equivalent exists. Says so plainly in Electron rather than trying the
  // extension relay (which will never connect there) and producing a
  // confusing error.
  const navM = text.match(/^go\s+to\s+(https?:\/\/\S+|\S+\.\S+)/i);
  if (navM) {
    if (IS_ELECTRON) {
      _chatAdd?.("Navigating to a URL needs an actual browser tab open — that only works when Flow is running in a Chrome tab with the extension, not in the desktop app. You can still open links manually.", 'bot');
      return true;
    }
    const url = navM[1].startsWith('http') ? navM[1] : 'https://' + navM[1];
    _chatAdd?.(`🌐 Navigating to ${url}…`, 'bot');
    _pingThenSend('navigate', { url }, (r) => {
      if (!r.ok) _chatAdd?.(`⚠️ Navigate failed: ${r.error}`, 'bot');
    });
    return true;
  }

  // Back / refresh — same limitation as navigate
  if (/^go\s+back$/i.test(t)) {
    if (IS_ELECTRON) { _chatAdd?.("Browser back/forward needs an actual browser tab — not available in the desktop app.", 'bot'); return true; }
    _pingThenSend('back', {}, r => { if (!r.ok) _chatAdd?.(`⚠️ ${r.error}`, 'bot'); else _chatAdd?.('⬅️ Went back', 'bot'); });
    return true;
  }
  if (/^(refresh|reload)$/i.test(t)) {
    if (IS_ELECTRON) { _chatAdd?.("Page refresh needs an actual browser tab — not available in the desktop app.", 'bot'); return true; }
    _pingThenSend('refresh', {}, r => { if (!r.ok) _chatAdd?.(`⚠️ ${r.error}`, 'bot'); else _chatAdd?.('🔄 Refreshed', 'bot'); });
    return true;
  }

  return null;
}

export function sendToExtension(action, payload, onReply) {
  _send(action, payload || {}, onReply);
}
