// ui/screencontrol.js — v8 DEFINITIVE
// Architecture: Flow page → window.postMessage → content.js → chrome.runtime → background → target tab
// The Flow webpage NEVER calls chrome.runtime directly (Chrome blocks it from webpages)
// Everything goes through the content script which IS allowed to call chrome.runtime

let _extReady  = false;
let _chatAdd   = null;
let _orb       = null;
let _pending   = new Map();   // action -> { resolve, reject, timer }
let _msgId     = 0;

// ── Init ─────────────────────────────────────────────────────────────────────
export function initScreenControl(chatModule, orbModule) {
  _chatAdd = chatModule?.addMessage?.bind(chatModule);
  _orb     = orbModule;

  // Listen for replies relayed from content.js
  window.addEventListener("message", _onMessage);

  // Listen for extension ID broadcast from content.js
  window.addEventListener("message", (e) => {
    if (e.data?.source === "flow-ext-id") {
      _extReady = true;
      console.log("[Flow SC] Extension connected ✓ ID:", e.data.extensionId);
    }
  });

  // Ask content.js for its ID (handles the race where page loads first)
  _requestId();
}

function _requestId() {
  window.postMessage({ source: "flow-ext-id-request" }, "*");
  // Retry a few times in case content.js isn't injected yet
  setTimeout(() => { if (!_extReady) window.postMessage({ source: "flow-ext-id-request" }, "*"); }, 800);
  setTimeout(() => { if (!_extReady) window.postMessage({ source: "flow-ext-id-request" }, "*"); }, 2000);
  setTimeout(() => { if (!_extReady) window.postMessage({ source: "flow-ext-id-request" }, "*"); }, 4000);
}

function _onMessage(e) {
  if (e.data?.source !== "flow-ext-reply") return;
  const { action, ok, result, error, msgId } = e.data;
  const key = msgId ?? action;
  const pending = _pending.get(key);
  if (!pending) return;
  clearTimeout(pending.timer);
  _pending.delete(key);
  if (ok) pending.resolve(result);
  else pending.reject(new Error(error || "Extension action failed"));
}

// ── Send to extension (with timeout) ────────────────────────────────────────
export function send(action, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!_extReady) {
      reject(new Error("NOT_CONNECTED"));
      return;
    }
    const id = ++_msgId;
    const timer = setTimeout(() => {
      _pending.delete(id);
      reject(new Error("TIMEOUT"));
    }, 5000);
    _pending.set(id, { resolve, reject, timer });

    window.postMessage({
      source:  "flow-control-page",
      msgId:   id,
      action,
      payload,
    }, "*");
  });
}

// ── sendDirect: fire-and-forget for cursor_move (no reply needed) ────────────
export function sendDirect(action, payload = {}) {
  if (!_extReady) return;
  window.postMessage({ source: "flow-control-page", msgId: 0, action, payload }, "*");
}

// ── isReady ──────────────────────────────────────────────────────────────────
export function isReady() { return _extReady; }

// ── Public command API (called from commands.js) ─────────────────────────────
export async function runCommand(text, chatAdd) {
  const chat = chatAdd || _chatAdd;

  if (!_extReady) {
    chat?.("bot", "⚠️ Extension not connected. Fix:\n1. chrome://extensions → Remove 'Flow Screen Control'\n2. Load unpacked → select your flow-extension/ folder\n3. Set site access to **On all sites**\n4. Refresh this page and try again");
    return;
  }

  const t = text.toLowerCase().trim();
  let action, payload, msg;

  // SCROLL
  if (/scroll (up|top|down|bottom|left|right)/.test(t) || /scroll (a (bit|little)|back to top)/.test(t)) {
    const dir = t.includes("top") || t.includes("back to top") ? "top"
              : t.includes("bottom") ? "bottom"
              : t.includes("up")     ? "up"
              : t.includes("left")   ? "left"
              : t.includes("right")  ? "right"
              : "down";
    const amount = t.includes("bit") || t.includes("little") ? 150 : 400;
    action = "scroll"; payload = { direction: dir, amount }; msg = null; // silent

  // CLICK
  } else if (/^click\b/.test(t) || /^press\b/.test(t) || /^tap\b/.test(t)) {
    const target = t.replace(/^(click|press|tap)\s+(on\s+)?/i, "").trim();
    action = "click"; payload = { target }; msg = `🖱️ Clicking "${target}"...`;

  // TYPE
  } else if (/^type\b/.test(t) || /^write\b/.test(t) || /^enter\b/.test(t)) {
    const raw   = t.replace(/^(type|write|enter)\s+/i, "");
    const field = raw.match(/\bin\s+(?:the\s+)?(.+?)\s+(?:field|box|input)$/i)?.[1] || "";
    const text2 = field ? raw.replace(/\bin\s+(?:the\s+)?.+?\s+(?:field|box|input)$/i, "").trim() : raw;
    action = "type"; payload = { text: text2, field }; msg = `⌨️ Typing "${text2}"${field ? ` in "${field}"` : ""}...`;

  // READ
  } else if (/^read\b/.test(t) || /^what('s| is) on( the)? (page|screen)\b/.test(t)) {
    action = "read"; payload = {}; msg = "📖 Reading page...";

  // NAVIGATE
  } else if (/^(go to|navigate to|open)\b/.test(t)) {
    let url = t.replace(/^(go to|navigate to|open)\s+/i, "").trim();
    if (!url.startsWith("http")) url = "https://" + url;
    action = "navigate"; payload = { url }; msg = `🌐 Navigating to ${url}...`;

  // BACK / REFRESH
  } else if (/^go back\b/.test(t) || /^back\b/.test(t)) {
    action = "back"; payload = {}; msg = "⬅️ Going back...";
  } else if (/^refresh\b/.test(t) || /^reload\b/.test(t)) {
    action = "refresh"; payload = {}; msg = "🔄 Refreshing...";

  // SELECT
  } else if (/^select\b/.test(t) || /^choose\b/.test(t)) {
    const m = t.match(/^(?:select|choose)\s+(.+?)\s+from\s+(.+)$/i);
    action = "select"; payload = { option: m?.[1] || t, field: m?.[2] || "" };
    msg = `📋 Selecting "${m?.[1] || t}"...`;

  // PING
  } else if (/^(is the extension|extension) connected/.test(t)) {
    try {
      await send("ping", {});
      chat?.("bot", "✅ Extension is connected and working.");
    } catch {
      chat?.("bot", "❌ Extension is installed but not responding. Reload it in chrome://extensions.");
    }
    return;

  } else {
    return; // Not a screen control command
  }

  if (msg) _orb?.setState?.("thinking");
  if (msg) chat?.("bot", msg);

  try {
    const result = await send(action, payload);
    _orb?.setState?.("idle");
    if (action === "read" && result?.text) {
      chat?.("bot", `📄 **${result.title || "Page"}** (${result.url})\n\n${result.text.slice(0, 2000)}${result.text.length > 2000 ? "\n\n_(truncated — ask me about a specific part)_" : ""}`);
    } else if (action === "click") {
      chat?.("bot", result?.clicked ? `✅ Clicked: "${result.clicked}"` : "⚠️ Couldn't find that element.");
    } else if (action === "type") {
      chat?.("bot", result?.typed ? `✅ Typed: "${result.typed}"` : "⚠️ Couldn't find an input field.");
    }
    // scroll/navigate/back/refresh are silent
  } catch (err) {
    _orb?.setState?.("idle");
    if (err.message === "NOT_CONNECTED") {
      chat?.("bot", "⚠️ Extension disconnected. Refresh the page.");
    } else if (err.message === "TIMEOUT") {
      chat?.("bot", `⚠️ No response from extension (timeout). The target tab may not have a content script. Try refreshing the target tab.`);
    } else {
      chat?.("bot", `⚠️ ${err.message}`);
    }
  }
}

// ── parseScreenControl (imported by app.js, called from commands.js) ────────
export function parseScreenControl(text) {
  return runCommand(text, null);
}
