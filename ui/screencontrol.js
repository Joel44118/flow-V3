// ui/screencontrol.js (v5)
// Webpage never calls chrome.runtime directly — blocked by Chrome security.
// All commands go: postMessage → content.js → chrome.runtime → background.
// Extension ID still received (for diagnostics) but never used for sendMessage.

let _chat = null, _orb = null, _sendAI = null;
let _extReady = false;
let _replyHandlerSet = false;
let _pendingTimeout = null;

export function initScreenControl(chat, orb, sendAI) {
  _chat = chat; _orb = orb; _sendAI = sendAI;
  _listenForReplies();
  // Listen for extension ID broadcast — sets _extReady flag
  window.addEventListener("message", (e) => {
    if (e.data?.source === "flow-ext-id" && e.data?.extensionId) {
      _extReady = true;
    }
  });
}

// ── Send command via postMessage → content.js ─────────────────────────────
function _send(action, payload = {}) {
  if (!_extReady) {
    _chat?.addError(
      "Extension not connected.\n\n" +
      "Fix:\n" +
      "1. chrome://extensions → Remove 'Flow Screen Control'\n" +
      "2. Load unpacked → select your flow-extension/ folder\n" +
      "3. Refresh this page and try again"
    );
    _orb?.setState("idle");
    return;
  }

  if (_pendingTimeout) clearTimeout(_pendingTimeout);
  if (action !== "cursor_move" && action !== "gesture_click") {
    _pendingTimeout = setTimeout(() => {
      _pendingTimeout = null;
      _orb?.setState("idle");
      _chat?.add("No response from extension — make sure another tab is open to control.", "bot");
    }, 6000);
  }

  // Route through content.js which has chrome.runtime access
  window.postMessage({ source: "flow-control-page", action, payload }, "*");
}

// ── Listen for replies relayed back from content.js ───────────────────────
function _listenForReplies() {
  if (_replyHandlerSet) return;
  _replyHandlerSet = true;

  window.addEventListener("message", (e) => {
    if (e.data?.source !== "flow-ext-reply") return;
    if (_pendingTimeout) { clearTimeout(_pendingTimeout); _pendingTimeout = null; }

    const { ok, action, result, error } = e.data;
    _orb?.setState("idle");

    if (!ok) { _chat?.addError(`Screen control: ${error || "unknown error"}`); return; }

    if (action === "ping") {
      _chat?.add("✅ Flow Screen Control extension connected and working.", "bot");
      return;
    }
    if (action === "read") {
      if (result?.text) {
        _sendAI?.(`Page: ${result.title}\nURL: ${result.url}\n\nContent:\n${result.text.slice(0,4000)}\n\nSummarise this page.`);
      } else {
        _chat?.add("Couldn't read that page.", "bot");
      }
      return;
    }

    const confirms = {
      scroll:   "Done — scrolled.",
      click:    result?.clicked ? `Clicked "${result.clicked}".` : "Couldn't find that element — describe the visible text.",
      type:     result?.typed   ? `Typed "${result.typed}".`    : "Couldn't find an input field.",
      navigate: "Navigating…",
      back:     "Going back.",
      refresh:  "Page refreshing.",
      select:   result?.selected ? `Selected "${result.selected}".` : "Couldn't find that option.",
    };
    _chat?.add(confirms[action] || "Done.", "bot");
  });
}

export async function parseScreenControl(text) {
  const t = text.toLowerCase().trim();

  if (/\bscroll\b/.test(t)) {
    let direction = "down", amount = 400;
    if (/top|beginning|start/.test(t))           direction = "top";
    else if (/bottom|end/.test(t))               direction = "bottom";
    else if (/\bup\b/.test(t))                   direction = "up";
    if (/a\s+lot|far|way\s+(down|up)/.test(t))  amount = 1200;
    if (/a\s+little|bit|slightly/.test(t))       amount = 150;
    _orb?.setState("thinking");
    _send("scroll", { direction, amount });
    return true;
  }

  const clickM = t.match(/\bclick\s+(?:on\s+)?(?:the\s+)?(.+?)(?:\s+button|\s+link|\s+tab|\s+icon|\s+menu)?\s*$/i);
  if (clickM && clickM[1].trim().length > 1) {
    _orb?.setState("thinking");
    _send("click", { target: clickM[1].trim() });
    return true;
  }

  const typeM = t.match(/\b(?:type|write|enter|input|put)\s+(.+?)\s+(?:in(?:to|side)?|on)\s+(?:the\s+)?(.+)/i)
             || t.match(/\b(?:type|write|enter|input)\s+["']?(.+?)["']?\s*$/i);
  if (typeM) {
    const what = typeM[1].trim().replace(/^["']|["']$/g, "");
    if (what.length > 0) {
      _orb?.setState("thinking");
      _send("type", { text: what, field: typeM[2]?.trim() || "" });
      return true;
    }
  }

  if (/\bread\s+(?:the\s+)?(?:page|screen|site)\b|\bwhat\s+does\s+(?:the\s+)?page\s+say\b/i.test(t)) {
    _orb?.setState("thinking"); _send("read", {}); return true;
  }

  const navM = t.match(/\bgo\s+to\s+(https?:\/\/\S+|\S+\.\S+)/i);
  if (navM) {
    let url = navM[1]; if (!url.startsWith("http")) url = "https://" + url;
    _orb?.setState("thinking"); _send("navigate", { url }); return true;
  }

  if (/\bgo\s+back\b|\bprevious\s+page\b/i.test(t)) { _send("back",    {}); return true; }
  if (/\brefresh\b|\breload\s+page\b/i.test(t))      { _send("refresh", {}); return true; }

  const selM = t.match(/\bselect\s+(.+?)\s+(?:from|in)\s+(?:the\s+)?(.+)/i);
  if (selM) {
    _orb?.setState("thinking");
    _send("select", { option: selM[1].trim(), field: selM[2].trim() });
    return true;
  }

  if (/\bextension\s+connected\b|\bcheck\s+extension\b/i.test(t)) {
    if (!_extReady) {
      _chat?.add("Extension not detected — install it and refresh this page.", "bot");
    } else {
      _send("ping", {});
    }
    return true;
  }

  return false;
}

export function sendToExtension(action, payload) { _send(action, payload); }
