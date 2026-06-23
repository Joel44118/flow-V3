// ui/screencontrol.js (v4)
// Active ID request on init fixes the race where Flow loaded before
// content.js injected and missed the one-time broadcast.

let _chat = null, _orb = null, _sendAI = null;
let _extId = null;
let _replyHandlerSet = false;
let _pendingTimeout = null;

export function initScreenControl(chat, orb, sendAI) {
  _chat = chat; _orb = orb; _sendAI = sendAI;
  _listenForExtId();
  _listenForReplies();
  // Actively request the ID — content.js will respond even if we missed
  // the initial broadcast on page load
  _requestExtId();
}

function _requestExtId() {
  window.postMessage({ source: "flow-ext-id-request" }, "*");
  // Retry a few times in case content.js loads slightly after us
  setTimeout(() => { if (!_extId) window.postMessage({ source: "flow-ext-id-request" }, "*"); }, 500);
  setTimeout(() => { if (!_extId) window.postMessage({ source: "flow-ext-id-request" }, "*"); }, 1500);
  setTimeout(() => { if (!_extId) window.postMessage({ source: "flow-ext-id-request" }, "*"); }, 3000);
}

function _listenForExtId() {
  window.addEventListener("message", (e) => {
    if (e.data?.source === "flow-ext-id" && e.data?.extensionId) {
      _extId = e.data.extensionId;
    }
  });
}

function _hasExt() {
  return typeof chrome !== "undefined" && chrome.runtime?.sendMessage && !!_extId;
}

function _send(action, payload = {}) {
  if (!_hasExt()) {
    if (!_extId) {
      _chat?.addError(
        "Extension not connected. Fix:\n" +
        "1. chrome://extensions → Remove Flow Screen Control\n" +
        "2. Load unpacked → select flow-extension/ folder\n" +
        "3. Refresh this page"
      );
    }
    _orb?.setState("idle");
    return;
  }

  if (_pendingTimeout) clearTimeout(_pendingTimeout);
  _pendingTimeout = setTimeout(() => {
    _pendingTimeout = null;
    _orb?.setState("idle");
    if (action !== "cursor_move" && action !== "gesture_click") {
      _chat?.add("Extension didn't respond — make sure another tab is open.", "bot");
    }
  }, 5000);

  // Wake the service worker first via connect(), then send the message.
  // Direct sendMessage fails with "Receiving end does not exist" when the
  // MV3 worker is sleeping — connect() forces it to start before we send.
  try {
    const port = chrome.runtime.connect(_extId, { name: "flow-wake" });
    port.disconnect(); // immediately disconnect — we only needed the wake
  } catch (_) {}

  // Small delay lets the worker fully initialise after waking
  setTimeout(() => {
    chrome.runtime.sendMessage(_extId, { source: "flow-control-bg", action, payload }, () => {
      if (chrome.runtime.lastError) {
        console.warn("[Flow SC]", chrome.runtime.lastError.message);
        // One retry after another 300ms — worker may still be starting
        setTimeout(() => {
          chrome.runtime.sendMessage(_extId, { source: "flow-control-bg", action, payload }, () => {
            if (chrome.runtime.lastError) {
              clearTimeout(_pendingTimeout); _pendingTimeout = null;
              _orb?.setState("idle");
              if (action !== "cursor_move" && action !== "gesture_click") {
                _chat?.addError("Could not reach extension — try again.");
              }
            }
          });
        }, 300);
      }
    });
  }, 100);
}

function _listenForReplies() {
  if (_replyHandlerSet) return;
  _replyHandlerSet = true;
  window.addEventListener("message", (e) => {
    if (e.data?.source !== "flow-ext-reply") return;
    if (_pendingTimeout) { clearTimeout(_pendingTimeout); _pendingTimeout = null; }
    const { ok, action, result, error } = e.data;
    _orb?.setState("idle");
    if (!ok) { _chat?.addError(`Screen control: ${error || "unknown error"}`); return; }
    if (action === "ping") { _chat?.add("✅ Flow Screen Control extension connected.", "bot"); return; }
    if (action === "read") {
      if (result?.text) _sendAI?.(`Page title: ${result.title}\nURL: ${result.url}\n\nContent:\n${result.text.slice(0,4000)}\n\nSummarise this page clearly.`);
      else _chat?.add("Couldn't read that page.", "bot");
      return;
    }
    const confirms = {
      scroll:  "Done — scrolled.",
      click:   result?.clicked ? `Clicked "${result.clicked}".` : "Couldn't find that element.",
      type:    result?.typed   ? `Typed "${result.typed}".`    : "Couldn't find an input field.",
      navigate:"Navigating…", back: "Going back.", refresh: "Page refreshing.",
      select:  result?.selected ? `Selected "${result.selected}".` : "Couldn't find that option.",
    };
    _chat?.add(confirms[action] || "Done.", "bot");
  });
}

export async function parseScreenControl(text) {
  const t = text.toLowerCase().trim();

  if (/\bscroll\b/.test(t)) {
    let direction = "down", amount = 400;
    if (/top|beginning|start/.test(t))          direction = "top";
    else if (/bottom|end/.test(t))              direction = "bottom";
    else if (/\bup\b/.test(t))                  direction = "up";
    if (/a\s+lot|far|way\s+(down|up)/.test(t)) amount = 1200;
    if (/a\s+little|bit|slightly/.test(t))      amount = 150;
    _orb?.setState("thinking"); _send("scroll", { direction, amount }); return true;
  }

  const clickM = t.match(/\bclick\s+(?:on\s+)?(?:the\s+)?(.+?)(?:\s+button|\s+link|\s+tab|\s+icon|\s+menu)?\s*$/i);
  if (clickM && clickM[1].trim().length > 1) {
    _orb?.setState("thinking"); _send("click", { target: clickM[1].trim() }); return true;
  }

  const typeM = t.match(/\b(?:type|write|enter|input|put)\s+(.+?)\s+(?:in(?:to|side)?|on)\s+(?:the\s+)?(.+)/i)
             || t.match(/\b(?:type|write|enter|input)\s+["']?(.+?)["']?\s*$/i);
  if (typeM) {
    const what = typeM[1].trim().replace(/^["']|["']$/g,"");
    if (what.length > 0) { _orb?.setState("thinking"); _send("type", { text: what, field: typeM[2]?.trim()||"" }); return true; }
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
  if (selM) { _orb?.setState("thinking"); _send("select", { option: selM[1].trim(), field: selM[2].trim() }); return true; }

  if (/\bextension\s+connected\b|\bcheck\s+extension\b/i.test(t)) {
    if (!_hasExt()) {
      _chat?.add(_extId ? "Extension known but runtime unavailable." : "Extension not detected — install it and refresh this page.", "bot");
    } else { _send("ping", {}); }
    return true;
  }

  return false;
}

// Exported for gesture.js to reuse the same bridge + ID
export function sendToExtension(action, payload) { _send(action, payload); }
