// flow-extension/content.js (v10)
// Full gesture support: cursor, click, right-click, drag, middle-click,
// scroll, nav history, tab switch, keyboard overlay (in target tab),
// hover highlighting, and cleanup.

function _safeSend(msg) {
  try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch(e) {}
}
function _safePostId() {
  try { window.postMessage({ source: "flow-ext-id", extensionId: chrome.runtime.id }, "*"); } catch(e) {}
}

_safePostId();
_safeSend({ source: "flow-tab-register" });

// ── Relay commands FROM page TO background ────────────────────────────────
window.addEventListener("message", (e) => {
  if (e.data?.source === "flow-ext-id-request") { _safePostId(); return; }
  if (e.data?.source !== "flow-control-page") return;
  try {
    chrome.runtime.sendMessage({
      source:  "flow-control-bg",
      action:  e.data.action,
      payload: e.data.payload,
    }).catch(err => {
      window.postMessage({ source: "flow-ext-reply", ok: false, action: e.data.action, error: "Background error: " + err.message }, "*");
    });
  } catch(e) {
    window.postMessage({ source: "flow-ext-reply", ok: false, action: e.data?.action, error: "Extension context invalidated." }, "*");
  }
});

// ── Relay replies FROM background TO page ─────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.source === "flow-ext-reply-relay") {
    window.postMessage({ source: "flow-ext-reply", ok: msg.ok, action: msg.action, result: msg.result, error: msg.error }, "*");
    sendResponse({ ok: true }); return true;
  }
  if (msg.source === "flow-control") {
    _handle(msg.action, msg.payload || {})
      .then(result => sendResponse({ ok: true, result }))
      .catch(err   => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

// ── Action dispatcher ─────────────────────────────────────────────────────
async function _handle(action, payload) {
  switch (action) {
    case "ping":           return { pong: true };
    case "scroll":         return _scroll(payload);
    case "click":          return _click(payload.target || "");
    case "type":           return _type(payload.text || "", payload.field || "");
    case "read":           return _read();
    case "navigate":       window.location.href = payload.url; return {};
    case "back":           window.history.back(); return {};
    case "refresh":        window.location.reload(); return {};
    case "select":         return _select(payload.option || "", payload.field || "");
    case "cursor_move":    return _cursorMove(payload.x ?? 0.5, payload.y ?? 0.5);
    case "gesture_click":  return _gestureClick(payload.x ?? 0.5, payload.y ?? 0.5);
    case "right_click":    return _rightClick(payload.x ?? 0.5, payload.y ?? 0.5);
    case "middle_click":   return _middleClick(payload.x ?? 0.5, payload.y ?? 0.5);
    case "drag_start":     return _dragStart(payload.x ?? 0.5, payload.y ?? 0.5);
    case "drag_move":      return _dragMove(payload.x ?? 0.5, payload.y ?? 0.5);
    case "drag_end":       return _dragEnd(payload.x ?? 0.5, payload.y ?? 0.5);
    case "nav_history":    return _navHistory(payload.direction || "back");
    case "switch_tab":     return {}; // handled by background.js
    case "show_keyboard":  return _showKeyboard(payload.rows, payload.row ?? 0, payload.col ?? 0);
    case "hide_keyboard":  return _hideKeyboard();
    case "kb_highlight":   return _kbHighlight(payload.row ?? 0, payload.col ?? 0);
    case "key":            return _key(payload.key || "", payload.modifiers || []);
    case "gesture_cleanup":return _gestureCleanup();
    default: throw new Error("Unknown action: " + action);
  }
}

// ── scroll ────────────────────────────────────────────────────────────────
function _scroll({ direction = "down", amount = 400 }) {
  const el = _findScrollable();
  switch (direction) {
    case "top":    el.scrollTo({ top: 0, behavior: "smooth" }); window.scrollTo({ top: 0, behavior: "smooth" }); break;
    case "bottom": el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); break;
    case "up":     el.scrollBy({ top: -amount, behavior: "smooth" }); window.scrollBy({ top: -amount, behavior: "smooth" }); break;
    default:       el.scrollBy({ top:  amount, behavior: "smooth" }); window.scrollBy({ top:  amount, behavior: "smooth" }); break;
  }
  return { direction, amount };
}
function _findScrollable() {
  const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
  for (const el of document.elementsFromPoint(cx, cy)) {
    if (el === document.body || el === document.documentElement) continue;
    const oy = window.getComputedStyle(el).overflowY;
    if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 10) return el;
  }
  return document.documentElement;
}

// ── cursor move + hover highlight ─────────────────────────────────────────
let _dot = null, _dotX = 0, _dotY = 0;
let _hoverHighlight = null;
let _hoverEl = null;

function _ensureDot() {
  if (_dot && document.contains(_dot)) return;
  _dot = document.createElement("div");
  _dot.id = "__flow_gesture_dot__";
  Object.assign(_dot.style, {
    position: "fixed", width: "18px", height: "18px", borderRadius: "50%",
    background: "rgba(56,189,248,0.92)", border: "2.5px solid #fff",
    boxShadow: "0 0 14px rgba(56,189,248,0.85), 0 0 4px #fff",
    pointerEvents: "none", zIndex: "2147483647",
    transform: "translate(-50%,-50%)",
    transition: "left 0.04s linear, top 0.04s linear, background 0.1s",
  });
  document.body.appendChild(_dot);
}
function _ensureHoverHighlight() {
  if (_hoverHighlight && document.contains(_hoverHighlight)) return;
  _hoverHighlight = document.createElement("div");
  _hoverHighlight.id = "__flow_hover_highlight__";
  Object.assign(_hoverHighlight.style, {
    position: "fixed", pointerEvents: "none", zIndex: "2147483646",
    border: "2px solid rgba(56,189,248,0.9)",
    borderRadius: "6px", background: "rgba(56,189,248,0.08)",
    boxShadow: "0 0 10px rgba(56,189,248,0.4)",
    transition: "all 0.08s ease",
    display: "none",
  });
  document.body.appendChild(_hoverHighlight);
}

const INTERACTIVE = "button,a,input,textarea,select,[role=button],[role=link],[role=checkbox],[role=menuitem],label,[tabindex]";

function _updateHover(px, py) {
  _ensureHoverHighlight();
  // Find top interactive element at cursor
  const els = document.elementsFromPoint(px, py);
  let found = null;
  for (const el of els) {
    if (el === _dot || el === _hoverHighlight) continue;
    if (el.matches?.(INTERACTIVE) && _isVisible(el)) { found = el; break; }
  }
  if (found && found !== _hoverEl) {
    _hoverEl = found;
    const r = found.getBoundingClientRect();
    const pad = 3;
    Object.assign(_hoverHighlight.style, {
      display: "block",
      left:   (r.left   - pad) + "px",
      top:    (r.top    - pad) + "px",
      width:  (r.width  + pad*2) + "px",
      height: (r.height + pad*2) + "px",
    });
  } else if (!found && _hoverEl) {
    _hoverEl = null;
    _hoverHighlight.style.display = "none";
  } else if (found && found === _hoverEl) {
    // Update position in case element shifted
    const r = found.getBoundingClientRect();
    const pad = 3;
    Object.assign(_hoverHighlight.style, {
      left:   (r.left   - pad) + "px",
      top:    (r.top    - pad) + "px",
      width:  (r.width  + pad*2) + "px",
      height: (r.height + pad*2) + "px",
    });
  }
}

function _cursorMove(nx, ny) {
  _dotX = nx * window.innerWidth;
  _dotY = ny * window.innerHeight;
  _ensureDot();
  _dot.style.left = _dotX + "px";
  _dot.style.top  = _dotY + "px";
  _updateHover(_dotX, _dotY);
  return { ok: true };
}

// ── gesture clicks ────────────────────────────────────────────────────────
function _gestureClick(nx, ny) {
  _cursorMove(nx, ny);
  _dot.style.background = "rgba(52,211,153,0.95)";
  setTimeout(() => { if (_dot) _dot.style.background = "rgba(56,189,248,0.92)"; }, 200);
  const el = _elementAt(_dotX, _dotY);
  if (!el) return { clicked: null };
  el.focus?.(); el.click();
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: _dotX, clientY: _dotY }));
  return { clicked: el.textContent?.trim().slice(0, 60) || el.tagName };
}
function _rightClick(nx, ny) {
  _cursorMove(nx, ny);
  _dot.style.background = "rgba(248,113,113,0.95)";
  setTimeout(() => { if (_dot) _dot.style.background = "rgba(56,189,248,0.92)"; }, 200);
  const el = _elementAt(_dotX, _dotY);
  if (!el) return { clicked: null };
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: _dotX, clientY: _dotY }));
  return { clicked: el.tagName };
}
function _middleClick(nx, ny) {
  _cursorMove(nx, ny);
  _dot.style.background = "rgba(167,139,250,0.95)";
  setTimeout(() => { if (_dot) _dot.style.background = "rgba(56,189,248,0.92)"; }, 200);
  const el = _elementAt(_dotX, _dotY);
  if (!el) return { clicked: null };
  el.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1, clientX: _dotX, clientY: _dotY }));
  // If it's a link, open in new tab
  const link = el.closest?.("a[href]");
  if (link) { window.open(link.href, "_blank"); }
  return { clicked: el.tagName };
}

// ── drag ─────────────────────────────────────────────────────────────────
let _dragTarget = null;
function _dragStart(nx, ny) {
  _cursorMove(nx, ny);
  _dragTarget = _elementAt(_dotX, _dotY);
  if (!_dragTarget) return { ok: false };
  _dot.style.background = "rgba(251,146,60,0.95)";
  _dragTarget.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: _dotX, clientY: _dotY }));
  return { ok: true };
}
function _dragMove(nx, ny) {
  _cursorMove(nx, ny);
  if (!_dragTarget) return { ok: false };
  const overEl = _elementAt(_dotX, _dotY);
  if (overEl) overEl.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: _dotX, clientY: _dotY }));
  document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true, clientX: _dotX, clientY: _dotY }));
  return { ok: true };
}
function _dragEnd(nx, ny) {
  _cursorMove(nx, ny);
  if (_dot) _dot.style.background = "rgba(56,189,248,0.92)";
  const dropEl = _elementAt(_dotX, _dotY);
  if (dropEl) dropEl.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: _dotX, clientY: _dotY }));
  if (_dragTarget) _dragTarget.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: _dotX, clientY: _dotY }));
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: _dotX, clientY: _dotY }));
  _dragTarget = null;
  return { ok: true };
}

// ── nav history ────────────────────────────────────────────────────────────
function _navHistory(direction) {
  if (direction === "back") window.history.back();
  else window.history.forward();
  return { direction };
}

// ─── Keyboard overlay ─────────────────────────────────────────────────────
// Renders a floating keyboard in the actual controlled tab (NOT the camera).
let _kbOverlay = null, _kbOverlayRows = null, _kbOverlayRowIdx = 0, _kbOverlayColIdx = 0;

function _showKeyboard(rows, row, col) {
  _kbOverlayRowIdx = row; _kbOverlayColIdx = col;
  _kbOverlayRows = rows;

  if (!_kbOverlay || !document.contains(_kbOverlay)) {
    _kbOverlay = document.createElement("div");
    _kbOverlay.id = "__flow_keyboard__";
    Object.assign(_kbOverlay.style, {
      position: "fixed",
      bottom: "24px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: "2147483645",
      background: "rgba(2,6,23,0.96)",
      border: "1.5px solid rgba(56,189,248,0.5)",
      borderRadius: "14px",
      padding: "10px 8px 10px 8px",
      boxShadow: "0 8px 40px rgba(0,0,0,0.7), 0 0 20px rgba(56,189,248,0.2)",
      backdropFilter: "blur(12px)",
      userSelect: "none",
      pointerEvents: "auto",
      minWidth: "340px",
      maxWidth: "520px",
      width: "min(90vw, 520px)",
      cursor: "move",
    });
    // Make draggable
    _makeDraggable(_kbOverlay);
    document.body.appendChild(_kbOverlay);
  }

  _renderKb();
  return { ok: true };
}

function _renderKb() {
  if (!_kbOverlay || !_kbOverlayRows) return;
  const rows = _kbOverlayRows;
  const selR = _kbOverlayRowIdx, selC = _kbOverlayColIdx;

  let html = `<div style="font-family:monospace;font-size:11px;color:rgba(56,189,248,0.6);text-align:center;margin-bottom:6px;letter-spacing:1px;">⌨ GESTURE KEYBOARD</div>`;
  html += `<div style="display:flex;flex-direction:column;gap:4px;">`;
  rows.forEach((row, ri) => {
    html += `<div style="display:flex;gap:3px;justify-content:center;">`;
    row.forEach((key, ci) => {
      const active = ri === selR && ci === selC;
      const isWide = (key === " " || key === "↵" || key === "⌫" || key === "⇧");
      const disp   = key === " " ? "SPACE" : key;
      html += `<div 
        style="
          flex:${isWide ? 1.6 : 1};
          min-width:${isWide ? 40 : 26}px;
          padding:7px 2px;
          text-align:center;
          border-radius:6px;
          background:${active ? "rgba(56,189,248,0.92)" : "rgba(56,189,248,0.12)"};
          color:${active ? "#020617" : "#e2e8f0"};
          font-weight:bold;
          font-size:${isWide ? "9px" : "12px"};
          border:1px solid ${active ? "#fff" : "rgba(56,189,248,0.25)"};
          box-shadow:${active ? "0 0 10px rgba(56,189,248,0.6)" : "none"};
          cursor:pointer;
          transition:background 0.1s;
        "
        data-row="${ri}" data-col="${ci}"
      >${disp}</div>`;
    });
    html += `</div>`;
  });
  html += `</div>`;
  // Close button
  html += `<div id="__flow_kb_close__" style="
    position:absolute;top:6px;right:10px;
    color:rgba(148,163,184,0.8);font-size:14px;cursor:pointer;
    width:20px;height:20px;display:flex;align-items:center;justify-content:center;
    border-radius:50%;background:rgba(255,255,255,0.06);
    font-family:monospace;font-weight:bold;
  ">×</div>`;

  _kbOverlay.innerHTML = html;
  _kbOverlay.style.position = "fixed"; // re-assert after innerHTML

  // Click on keys directly (touch/mouse on PC)
  _kbOverlay.addEventListener("click", (e) => {
    const cell = e.target.closest("[data-row]");
    if (cell) {
      const ri = parseInt(cell.dataset.row), ci = parseInt(cell.dataset.col);
      const key = _kbOverlayRows[ri]?.[ci];
      if (key) _directKbPress(key);
      return;
    }
    if (e.target.id === "__flow_kb_close__") {
      _hideKeyboard();
    }
  });
}

function _directKbPress(key) {
  if (key === "⇧") { return; } // shift handled by gesture.js
  let send = key;
  if (key === "⌫") send = "Backspace";
  if (key === "↵") send = "Enter";
  _key(send, []);
}

function _kbHighlight(row, col) {
  _kbOverlayRowIdx = row; _kbOverlayColIdx = col;
  _renderKb();
  return { ok: true };
}

function _hideKeyboard() {
  _kbOverlay?.remove(); _kbOverlay = null; _kbOverlayRows = null;
  return { ok: true };
}

function _makeDraggable(el) {
  let ox = 0, oy = 0, dragging = false;
  el.addEventListener("mousedown", (e) => {
    if (e.target.closest("[data-row]") || e.target.id === "__flow_kb_close__") return;
    dragging = true;
    ox = e.clientX; oy = e.clientY;
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - ox, dy = e.clientY - oy;
    ox = e.clientX; oy = e.clientY;
    const rect = el.getBoundingClientRect();
    el.style.left   = (rect.left + dx) + "px";
    el.style.bottom = "auto";
    el.style.top    = (rect.top  + dy) + "px";
    el.style.transform = "none";
  });
  document.addEventListener("mouseup", () => { dragging = false; });
  // Touch support for touchscreen PC
  el.addEventListener("touchstart", (e) => {
    if (e.target.closest("[data-row]") || e.target.id === "__flow_kb_close__") return;
    dragging = true; ox = e.touches[0].clientX; oy = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    if (!dragging) return;
    const dx = e.touches[0].clientX - ox, dy = e.touches[0].clientY - oy;
    ox = e.touches[0].clientX; oy = e.touches[0].clientY;
    const rect = el.getBoundingClientRect();
    el.style.left = (rect.left + dx) + "px"; el.style.top = (rect.top + dy) + "px";
    el.style.bottom = "auto"; el.style.transform = "none";
  }, { passive: true });
  document.addEventListener("touchend", () => { dragging = false; });
}

// ── key press ─────────────────────────────────────────────────────────────
function _key(key, modifiers = []) {
  const el = document.activeElement || document.body;
  const opts = {
    key, bubbles: true, cancelable: true,
    ctrlKey:  modifiers.includes("ctrl"),
    shiftKey: modifiers.includes("shift"),
    altKey:   modifiers.includes("alt"),
    metaKey:  modifiers.includes("meta"),
  };
  el.dispatchEvent(new KeyboardEvent("keydown",  opts));
  el.dispatchEvent(new KeyboardEvent("keypress", opts));
  el.dispatchEvent(new KeyboardEvent("keyup",    opts));
  if (key.length === 1 && el.isContentEditable) {
    document.execCommand("insertText", false, key);
  } else if (key.length === 1 && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
    const start = el.selectionStart ?? el.value.length;
    el.value = el.value.slice(0, start) + key + el.value.slice(el.selectionEnd ?? start);
    el.selectionStart = el.selectionEnd = start + 1;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  return { key };
}

// ── cleanup ───────────────────────────────────────────────────────────────
function _gestureCleanup() {
  _dot?.remove(); _dot = null;
  _hoverHighlight?.remove(); _hoverHighlight = null; _hoverEl = null;
  _hideKeyboard();
  return { ok: true };
}

// ── click ─────────────────────────────────────────────────────────────────
function _click(target) {
  const el = _findElement(target);
  if (!el) return { clicked: null };
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.focus?.(); el.click();
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return { clicked: el.textContent?.trim().slice(0, 60) || target };
}

// ── type ──────────────────────────────────────────────────────────────────
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

// ── read ──────────────────────────────────────────────────────────────────
function _read() {
  const clone = document.body.cloneNode(true);
  for (const tag of ["script","style","noscript","svg","iframe","nav","footer","header"])
    clone.querySelectorAll(tag).forEach(n => n.remove());
  const text = (clone.innerText || clone.textContent || "")
    .replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
  return { text: text.slice(0, 8000), title: document.title, url: location.href };
}

// ── select ────────────────────────────────────────────────────────────────
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

// ── element finders ───────────────────────────────────────────────────────
function _elementAt(px, py) {
  const els = document.elementsFromPoint(px, py);
  for (const el of els) {
    if (el === _dot || el === _hoverHighlight || el === _kbOverlay) continue;
    if (!_kbOverlay?.contains(el)) return el;
  }
  return null;
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
    const attrs = [
      el.textContent?.trim().toLowerCase(), el.getAttribute("aria-label")?.toLowerCase(),
      el.getAttribute("title")?.toLowerCase(), el.getAttribute("placeholder")?.toLowerCase(),
      el.id?.toLowerCase(),
    ].filter(Boolean);
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
