// ═══════════════════════════════════════════
// ui/screencontrol.js — Flow Screen Control (v2)
//
// FIXED ARCHITECTURE:
// Previous version used window.postMessage which only
// talks to listeners IN THE SAME PAGE — so commands
// were hitting Flow's own DOM, not the target tab.
//
// Correct path:
//   Flow → chrome.runtime.sendMessage (to extension)
//        → background.js finds the active non-Flow tab
//        → chrome.tabs.sendMessage to that tab's content.js
//        → content.js executes the action
//        → replies via chrome.runtime.sendMessage back
//        → background.js relays to Flow tab
//        → content.js in Flow tab fires window.postMessage
//        → screencontrol.js receives the reply here
//
// chrome.runtime is only available when the extension is
// installed — we guard every call with a _hasExt() check
// and show a clear install message if it's missing.
// ═══════════════════════════════════════════

let _chat   = null;
let _orb    = null;
let _sendAI = null;
let _replyHandlerSet = false;

export function initScreenControl(chat, orb, sendAI) {
  _chat   = chat;
  _orb    = orb;
  _sendAI = sendAI;
  _listenForReplies();
}

// ── Check extension is installed ─────────────────────────────────────────
function _hasExt() {
  return typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage;
}

// ── Send action to extension background → target tab ─────────────────────
function _send(action, payload = {}) {
  if (!_hasExt()) {
    _chat?.addError(
      "Flow Screen Control extension is not installed.\n\n" +
      "To install:\n" +
      "1. Chrome → chrome://extensions\n" +
      "2. Enable Developer mode (top-right toggle)\n" +
      "3. Click 'Load unpacked'\n" +
      "4. Select the flow-extension/ folder in your Flow V3 project\n" +
      "5. Refresh Flow — then try again."
    );
    _orb?.setState("idle");
    return;
  }

  // Send to background.js which will forward to the active target tab
  chrome.runtime.sendMessage({
    source:  "flow-control-bg",
    action,
    payload,
  }, (response) => {
    // Immediate ack from background — actual result comes via window.postMessage
    if (chrome.runtime.lastError) {
      _chat?.addError("Extension error: " + chrome.runtime.lastError.message);
      _orb?.setState("idle");
    }
  });
}

// ── Receive replies from the extension ───────────────────────────────────
// content.js (in Flow's own tab) receives the relay from background.js
// and forwards it here via window.postMessage
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
          `Page title: ${result.title || "unknown"}\n` +
          `URL: ${result.url || "unknown"}\n\n` +
          `Page content:\n${result.text.slice(0, 4000)}\n\n` +
          `Summarise what this page is about clearly and concisely.`
        );
      } else {
        _chat?.add("Couldn't read that page — it may be blocking content extraction.", "bot");
      }
      return;
    }

    // All other action confirmations
    const confirms = {
      scroll:   "Done — scrolled.",
      click:    result?.clicked
        ? `Clicked "${result.clicked}".`
        : "Couldn't find that element — try describing the visible text on it.",
      type:     result?.typed
        ? `Typed "${result.typed}".`
        : "Couldn't find an input field — try naming it (e.g. 'type hello in the search box').",
      navigate: "Navigating…",
      back:     "Going back.",
      refresh:  "Page refreshing.",
      select:   result?.selected
        ? `Selected "${result.selected}".`
        : "Couldn't find that option.",
    };
    _chat?.add(confirms[action] || "Done.", "bot");
  });
}

// ── Natural language → action ─────────────────────────────────────────────
export async function parseScreenControl(text) {
  const t = text.toLowerCase().trim();

  // ── Scroll ──────────────────────────────────────────────────────────────
  if (/\bscroll\b/.test(t)) {
    let direction = "down", amount = 400;
    if (/top|beginning|start/.test(t))             direction = "top";
    else if (/bottom|end/.test(t))                 direction = "bottom";
    else if (/up/.test(t))                         direction = "up";
    if (/a\s+lot|far|way\s+(down|up)/.test(t))    amount = 1200;
    if (/a\s+little|bit|slightly/.test(t))         amount = 150;
    _orb?.setState("thinking");
    _send("scroll", { direction, amount });
    return true;
  }

  // ── Click ────────────────────────────────────────────────────────────────
  const clickM = t.match(/\bclick\s+(?:on\s+)?(?:the\s+)?(.+?)(?:\s+button|\s+link|\s+tab|\s+icon|\s+menu)?\s*$/i);
  if (clickM && clickM[1].trim().length > 1) {
    _orb?.setState("thinking");
    _send("click", { target: clickM[1].trim() });
    return true;
  }

  // ── Type ─────────────────────────────────────────────────────────────────
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

  // ── Read page ─────────────────────────────────────────────────────────────
  if (/\bread\s+(?:the\s+)?(?:page|screen|site|website)\b|\bwhat\s+does\s+(?:the\s+)?(?:page|site)\s+say\b|\bsummarise\s+(?:the\s+)?(?:page|site)\b/i.test(t)) {
    _orb?.setState("thinking");
    _send("read", {});
    return true;
  }

  // ── Navigate ─────────────────────────────────────────────────────────────
  const navM = t.match(/\bgo\s+to\s+(https?:\/\/\S+|\S+\.\S+)/i);
  if (navM) {
    let url = navM[1];
    if (!url.startsWith("http")) url = "https://" + url;
    _orb?.setState("thinking");
    _send("navigate", { url });
    return true;
  }

  // ── Back / refresh ────────────────────────────────────────────────────────
  if (/\bgo\s+back\b|\bprevious\s+page\b/i.test(t))        { _send("back",    {}); return true; }
  if (/\brefresh\b|\breload\s+(?:the\s+)?page\b/i.test(t)) { _send("refresh", {}); return true; }

  // ── Select dropdown ───────────────────────────────────────────────────────
  const selM = t.match(/\bselect\s+(.+?)\s+(?:from|in)\s+(?:the\s+)?(.+)/i);
  if (selM) {
    _orb?.setState("thinking");
    _send("select", { option: selM[1].trim(), field: selM[2].trim() });
    return true;
  }

  // ── Extension connection check ────────────────────────────────────────────
  if (/\bextension\s+connected\b|\bcheck\s+extension\b|\bscreen\s+control\s+working\b/i.test(t)) {
    if (!_hasExt()) {
      _chat?.add("Extension not detected. Make sure you loaded the flow-extension/ folder in chrome://extensions.", "bot");
    } else {
      _send("ping", {});
    }
    return true;
  }

  return false;
}
