// flow-extension/content.js (v6)
// ARCHITECTURE CHANGE: webpage never calls chrome.runtime directly.
// Flow sends commands via window.postMessage → content.js picks them up
// and forwards to background via chrome.runtime.sendMessage.
// This bypasses the externally_connectable restriction entirely.

// Tell the page what extension ID we are (still useful for diagnostics)
window.postMessage({ source: "flow-ext-id", extensionId: chrome.runtime.id }, "*");

// Register with background so it knows our tab ID
chrome.runtime.sendMessage({ source: "flow-tab-register" }).catch(() => {});

// ── Relay commands FROM the page TO background ────────────────────────────
window.addEventListener("message", (e) => {
  if (e.data?.source !== "flow-control-page") return;
  chrome.runtime.sendMessage({
    source:  "flow-control-bg",
    action:  e.data.action,
    payload: e.data.payload,
  }).catch(err => {
    // Background not ready — send error back to page
    window.postMessage({
      source: "flow-ext-reply",
      ok:     false,
      action: e.data.action,
      error:  "Background not ready: " + err.message,
    }, "*");
  });
});

// ── Relay replies FROM background TO page ─────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.source === "flow-ext-reply-relay") {
    window.postMessage({
      source: "flow-ext-reply",
      ok:     msg.ok,
      action: msg.action,
      result: msg.result,
      error:  msg.error,
    }, "*");
    sendResponse({ ok: true });
    return true;
  }

  if (msg.source === "flow-control") {
    _handle(msg.action, msg.payload || {})
      .then(result => sendResponse({ ok: true, result }))
      .catch(err   => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

async function _handle(action, payload) {
  switch (action) {
    case "ping":          return { pong: true };
    case "scroll":        return _scroll(payload);
    case "click":         return _click(payload.target || "");
    case "type":          return _type(payload.text || "", payload.field || "");
    case "read":          return _read();
    case "navigate":      window.location.href = payload.url; return {};
    case "back":          window.history.back(); return {};
    case "refresh":       window.location.reload(); return {};
    case "select":        return _select(payload.option || "", payload.field || "");
    case "cursor_move":   return _cursorMove(payload.x ?? 0.5, payload.y ?? 0.5);
    case "gesture_click": return _gestureClick(payload.x ?? 0.5, payload.y ?? 0.5);
    default: throw new Error("Unknown action: " + action);
  }
}

function _scroll({ direction = "down", amount = 400 }) {
  switch (direction) {
    case "top":    window.scrollTo({ top: 0, behavior: "smooth" }); break;
    case "bottom": window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }); break;
    case "up":     window.scrollBy({ top: -amount, behavior: "smooth" }); break;
    default:       window.scrollBy({ top:  amount, behavior: "smooth" }); break;
  }
  return { direction, amount };
}

function _click(target) {
  const el = _findElement(target);
  if (!el) return { clicked: null };
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.focus?.(); el.click();
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return { clicked: el.textContent?.trim().slice(0, 60) || target };
}

function _type(text, fieldHint) {
  let input = fieldHint ? _findInput(fieldHint) : null;
  if (!input && document.activeElement) {
    const ae = document.activeElement;
    if (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable) input = ae;
  }
  if (!input) input = _findInput("") || document.querySelector(
    "input:not([type=hidden]):not([type=submit]):not([type=button]):not([disabled]),textarea:not([disabled])"
  );
  if (!input) return { typed: null };
  input.scrollIntoView({ behavior: "smooth", block: "center" });
  input.focus();
  if (input.isContentEditable) {
    input.textContent = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    const proto = input.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(input, text); else input.value = text;
    input.dispatchEvent(new Event("input",  { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return { typed: text };
}

function _read() {
  const clone = document.body.cloneNode(true);
  for (const tag of ["script","style","noscript","svg","iframe","nav","footer","header"])
    clone.querySelectorAll(tag).forEach(n => n.remove());
  const text = (clone.innerText || clone.textContent || "")
    .replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
  return { text: text.slice(0, 8000), title: document.title, url: location.href };
}

function _select(optionText, fieldHint) {
  const sel = (fieldHint ? _findElement(fieldHint, "select") : null) || document.querySelector("select");
  if (!sel) return { selected: null };
  const opt = Array.from(sel.options).find(o =>
    o.text.toLowerCase().includes(optionText.toLowerCase()) ||
    o.value.toLowerCase().includes(optionText.toLowerCase())
  );
  if (!opt) return { selected: null };
  sel.value = opt.value;
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  return { selected: opt.text };
}

let _dot = null, _dotX = 0, _dotY = 0;
function _ensureDot() {
  if (_dot) return;
  _dot = document.createElement("div");
  Object.assign(_dot.style, {
    position: "fixed", width: "18px", height: "18px", borderRadius: "50%",
    background: "rgba(56,189,248,0.85)", border: "2px solid #fff",
    boxShadow: "0 0 12px rgba(56,189,248,0.6)", pointerEvents: "none",
    zIndex: "2147483647", transform: "translate(-50%,-50%)",
    transition: "left .04s linear, top .04s linear",
  });
  document.body.appendChild(_dot);
}
function _cursorMove(nx, ny) {
  _dotX = nx * window.innerWidth; _dotY = ny * window.innerHeight;
  _ensureDot(); _dot.style.left = _dotX + "px"; _dot.style.top = _dotY + "px";
  return { ok: true };
}
function _gestureClick(nx, ny) {
  _cursorMove(nx, ny); _ensureDot();
  _dot.style.background = "rgba(52,211,153,0.9)";
  setTimeout(() => { if (_dot) _dot.style.background = "rgba(56,189,248,0.85)"; }, 250);
  const el = document.elementFromPoint(_dotX, _dotY);
  if (!el || el === _dot) return { clicked: null };
  el.focus?.(); el.click();
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: _dotX, clientY: _dotY }));
  return { clicked: el.textContent?.trim().slice(0, 60) || el.tagName };
}

function _findElement(target, tagFilter = null) {
  const t = (target || "").toLowerCase().trim();
  if (!t) return null;
  const scope = tagFilter ? document.querySelectorAll(tagFilter) : document.querySelectorAll(
    "button,a,[role=button],[role=link],input[type=submit],input[type=button],label,h1,h2,h3,li,td,th,span,div,p"
  );
  let best = null, bestScore = 0;
  for (const el of scope) {
    if (!_isVisible(el)) continue;
    const attrs = [el.textContent?.trim().toLowerCase(), el.getAttribute("aria-label")?.toLowerCase(),
      el.getAttribute("title")?.toLowerCase(), el.getAttribute("placeholder")?.toLowerCase(), el.id?.toLowerCase()].filter(Boolean);
    for (const a of attrs) {
      const score = a === t ? 10 : a.startsWith(t) ? 7 : a.includes(t) ? 4 : 0;
      if (score > bestScore) { bestScore = score; best = el; }
    }
  }
  return bestScore > 0 ? best : null;
}
function _findInput(hint) {
  const h = (hint || "").toLowerCase().trim();
  const inputs = document.querySelectorAll(
    "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]):not([disabled])," +
    "textarea:not([disabled]),[contenteditable=true]"
  );
  if (!h) return Array.from(inputs).find(_isVisible) || null;
  let best = null, bestScore = 0;
  for (const el of inputs) {
    if (!_isVisible(el)) continue;
    const label = el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent.toLowerCase() : null;
    const attrs = [el.placeholder?.toLowerCase(), el.name?.toLowerCase(), el.id?.toLowerCase(),
      el.getAttribute("aria-label")?.toLowerCase(), label].filter(Boolean);
    for (const a of attrs) {
      const score = a === h ? 10 : a.startsWith(h) ? 7 : a.includes(h) ? 4 : 0;
      if (score > bestScore) { bestScore = score; best = el; }
    }
  }
  return bestScore > 0 ? best : null;
}
function _isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const s = window.getComputedStyle(el);
  return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
}
