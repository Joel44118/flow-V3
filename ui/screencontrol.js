// ═══════════════════════════════════════════
// ui/screencontrol.js — Flow Screen Control (v3)
//
// FIX: chrome.runtime.sendMessage() from a webpage
// requires the extension ID as the first argument.
// content.js broadcasts it via window.postMessage
// ({ source:"flow-ext-id", extensionId }) on load.
// We listen for it here and store it — all sendMessage
// calls use _extId as their first argument.
// ═══════════════════════════════════════════

let _chat    = null;
let _orb     = null;
let _sendAI  = null;
let _extId   = null; // set when content.js broadcasts the extension ID
let _replyHandlerSet = false;

export function initScreenControl(chat, orb, sendAI) {
  _chat   = chat;
  _orb    = orb;
  _sendAI = sendAI;
  _listenForExtId();
  _listenForReplies();
}

// ── Wait for content.js to broadcast the extension ID ────────────────────
function _listenForExtId() {
  window.addEventListener("message", (e) => {
    if (e.data?.source === "flow-ext-id" && e.data?.extensionId) {
      _extId = e.data.extensionId;
    }
  });
}

// ── Check extension is installed and ID is known ──────────────────────────
function _hasExt() {
  return typeof chrome !== "undefined"
    && chrome.runtime?.sendMessage
    && !!_extId;
}

// ── Send action to background → target tab ────────────────────────────────
function _send(action, payload = {}) {
  if (!_hasExt()) {
    const reason = !_extId
      ? "Extension ID not received yet — make sure the Flow Screen Control extension is installed and this page is refreshed."
      : "Flow Screen Control extension is not installed.";
    _chat?.addError(
      reason + "\n\n" +
      "To install:\n" +
      "1. Chrome → chrome://extensions\n" +
      "2. Enable Developer mode\n" +
      "3. Load unpacked → select flow-extension/ folder\n" +
      "4. Refresh this page"
    );
    _orb?.setState("idle");
    return;
  }

  // Pass _extId as first argument — required when calling from a webpage
  chrome.runtime.sendMessage(_extId, {
    source: "flow-control-bg",
    action,
    payload,
  }, () => {
    if (chrome.runtime.lastError) {
      console.warn("[Flow SC]", chrome.runtime.lastError.message);
    }
  });
}

// ── Receive replies (content.js relays via window.postMessage) ────────────
function _listenForReplies() {
  if (_replyHandlerSet) return;
  _replyHandlerSet = true;

  window.addEventListener("message", (e) => {
    if (e.data?.source !== "flow-ext-reply") return;

    const { ok, action, result, error } = e.data;
    _orb?.setState("idle");

    if (!ok) {
      _chat?.addError(`Screen control: ${error || "unknown error"}`);
      return;
    }

    if (action === "ping") {
      _chat?.add("✅ Flow Screen Control extension connected. I can scroll, click, type, and read any tab you share.", "bot");
      return;
    }

    if (action === "read") {
      if (result?.text) {
        _sendAI?.(
          `The user asked Flow to read the page they are sharing.\n` +
          `Title: ${result.title || "?"}\nURL: ${result.url || "?"}\n\n` +
          `Content:\n${result.text.slice(0, 4000)}\n\n` +
          `Summarise what this page is about clearly and concisely.`
        );
      } else {
        _chat?.add("Couldn't read that page.", "bot");
      }
      return;
    }

    const confirms = {
      scroll:   "Done — scrolled.",
      click:    result?.clicked ? `Clicked "${result.clicked}".` : "Couldn't find that element — describe the visible text on it.",
      type:     result?.typed   ? `Typed "${result.typed}".`    : "Couldn't find an input field.",
      navigate: "Navigating…",
      back:     "Going back.",
      refresh:  "Page refreshing.",
      select:   result?.selected ? `Selected "${result.selected}".` : "Couldn't find that option.",
    };
    _chat?.add(confirms[action] || "Done.", "bot");
  });
}

// ── Natural language → action ─────────────────────────────────────────────
export async function parseScreenControl(text) {
  const t = text.toLowerCase().trim();

  if (/\bscroll\b/.test(t)) {
    let direction = "down", amount = 400;
    if (/top|beginning|start/.test(t))            direction = "top";
    else if (/bottom|end/.test(t))                direction = "bottom";
    else if (/\bup\b/.test(t))                    direction = "up";
    if (/a\s+lot|far|way\s+(down|up)/.test(t))   amount = 1200;
    if (/a\s+little|bit|slightly/.test(t))        amount = 150;
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
    const what  = typeM[1].trim().replace(/^["']|["']$/g, "");
    const where = typeM[2]?.trim() || "";
    if (what.length > 0) {
      _orb?.setState("thinking");
      _send("type", { text: what, field: where });
      return true;
    }
  }

  if (/\bread\s+(?:the\s+)?(?:page|screen|site|website)\b|\bwhat\s+does\s+(?:the\s+)?(?:page|site)\s+say\b|\bsummarise\s+(?:the\s+)?(?:page|site)\b/i.test(t)) {
    _orb?.setState("thinking");
    _send("read", {});
    return true;
  }

  const navM = t.match(/\bgo\s+to\s+(https?:\/\/\S+|\S+\.\S+)/i);
  if (navM) {
    let url = navM[1];
    if (!url.startsWith("http")) url = "https://" + url;
    _orb?.setState("thinking");
    _send("navigate", { url });
    return true;
  }

  if (/\bgo\s+back\b|\bprevious\s+page\b/i.test(t))        { _send("back",    {}); return true; }
  if (/\brefresh\b|\breload\s+(?:the\s+)?page\b/i.test(t)) { _send("refresh", {}); return true; }

  const selM = t.match(/\bselect\s+(.+?)\s+(?:from|in)\s+(?:the\s+)?(.+)/i);
  if (selM) {
    _orb?.setState("thinking");
    _send("select", { option: selM[1].trim(), field: selM[2].trim() });
    return true;
  }

  if (/\bextension\s+connected\b|\bcheck\s+extension\b|\bscreen\s+control\s+working\b/i.test(t)) {
    if (!_hasExt()) {
      _chat?.add(_extId ? "Extension known but chrome.runtime unavailable." : "Extension not detected — install it and refresh this page.", "bot");
    } else {
      _send("ping", {});
    }
    return true;
  }

  return false;
}

// ── Export send for gesture.js to reuse (same bridge, same ID) ───────────
export function sendToExtension(action, payload) {
  _send(action, payload);
}
