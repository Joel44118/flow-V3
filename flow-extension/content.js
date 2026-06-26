// flow-extension/content.js (v10) — DEFINITIVE
// Role A (Flow tab): broadcast extension ID to page, relay replies back to Flow page
// Role B (target tab): execute scroll/click/type/etc actions
//
// FIX: registerTab uses 'flow-tab-register' (matches background.js)
//      _wakeAndRetry uses port name 'flow-wake' (matches background.js onConnect)

(function () {
  "use strict";

  // ── Broadcast extension ID to the page ──────────────────────────────────
  function broadcastId() {
    try {
      window.postMessage({
        source:      "flow-ext-id",      // screencontrol.js listens for this exact name
        extensionId: chrome.runtime.id,
      }, "*");
    } catch (e) { /* extension context gone */ }
  }
  broadcastId();

  // Register this tab as the Flow tab with the background worker
  function registerTab() {
    try {
      chrome.runtime.sendMessage({ source: "flow-tab-register" }, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      });
    } catch (e) { /* ignore */ }
  }
  registerTab();

  // ── Listen for messages from the Flow page ───────────────────────────────
  window.addEventListener("message", (e) => {
    if (!e.data) return;

    // ID request — reply immediately
    if (e.data.source === "flow-ext-id-request") {
      broadcastId();
      return;
    }

    // Screen control command from Flow page
    if (e.data.source === "flow-control-page") {
      const { msgId, action, payload } = e.data;
      try {
        chrome.runtime.sendMessage(
          { source: "flow-control-bg", msgId, action, payload },
          (resp) => {
            if (chrome.runtime.lastError) {
              // Background worker asleep — wake it and retry once
              _wakeAndRetry(msgId, action, payload);
            }
            // Actual result comes back via flow-ext-reply-relay from background
          }
        );
      } catch (err) {
        _replyError(msgId, action, err.message);
      }
      return;
    }
  });

  function _wakeAndRetry(msgId, action, payload) {
    try {
      const port = chrome.runtime.connect({ name: "flow-wake" });
      port.disconnect();
      setTimeout(() => {
        try {
          chrome.runtime.sendMessage(
            { source: "flow-control-bg", msgId, action, payload },
            () => { if (chrome.runtime.lastError) _replyError(msgId, action, "Worker unavailable"); }
          );
        } catch (e) { _replyError(msgId, action, e.message); }
      }, 200);
    } catch (e) { _replyError(msgId, action, e.message); }
  }

  function _replyError(msgId, action, error) {
    window.postMessage({ source: "flow-ext-reply", msgId, action, ok: false, error }, "*");
  }

  // ── Listen for messages from background worker → relay to Flow page ───────
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      // Background sends this to Flow tab to relay result back to page
      if (msg.source === "flow-ext-reply-relay") {
        window.postMessage({
          source: "flow-ext-reply",
          msgId:  msg.msgId,
          ok:     msg.ok,
          action: msg.action,
          result: msg.result,
          error:  msg.error,
        }, "*");
        sendResponse({ ok: true });
        return true;
      }

      // Background sends this to TARGET tab to execute action
      if (msg.source === "flow-control") {
        _handle(msg.action, msg.payload || {})
          .then(result => { try { sendResponse({ ok: true,  result }); } catch (e) {} })
          .catch(err   => { try { sendResponse({ ok: false, error: err.message }); } catch (e) {} });
        return true;
      }
    });
  } catch (e) { /* extension context invalidated */ }

  // ── Action handler ────────────────────────────────────────────────────────
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
      case "right_click":   return _rightClick(payload.x ?? 0.5, payload.y ?? 0.5);
      default: throw new Error("Unknown action: " + action);
    }
  }

  // ── Scroll ─────────────────────────────────────────────────────────────────
  function _scroll({ direction = "down", amount = 400 }) {
    const el = _findScrollable();
    switch (direction) {
      case "top":
        (el || document.documentElement).scrollTo({ top: 0, behavior: "smooth" });
        window.scrollTo({ top: 0, behavior: "smooth" });
        break;
      case "bottom":
        if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
        window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
        break;
      case "up":
        if (el) el.scrollBy({ top: -amount, behavior: "smooth" });
        window.scrollBy({ top: -amount, behavior: "smooth" });
        break;
      case "left":
        if (el) el.scrollBy({ left: -amount, behavior: "smooth" });
        window.scrollBy({ left: -amount, behavior: "smooth" });
        break;
      case "right":
        if (el) el.scrollBy({ left: amount, behavior: "smooth" });
        window.scrollBy({ left: amount, behavior: "smooth" });
        break;
      default:
        if (el) el.scrollBy({ top: amount, behavior: "smooth" });
        window.scrollBy({ top: amount, behavior: "smooth" });
    }
    return { direction, amount };
  }

  function _findScrollable() {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const hits = document.elementsFromPoint(cx, cy) || [];
    for (const el of hits) {
      if (el === document.body || el === document.documentElement) continue;
      const s  = window.getComputedStyle(el);
      const ov = s.overflow + s.overflowY;
      if (/(auto|scroll)/.test(ov) && el.scrollHeight > el.clientHeight + 4) return el;
    }
    if (document.documentElement.scrollHeight > document.documentElement.clientHeight + 4)
      return document.documentElement;
    return null;
  }

  // ── Click ──────────────────────────────────────────────────────────────────
  function _click(target) {
    const el = _findElement(target);
    if (!el) return { clicked: null };
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.focus?.();
    el.click();
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return { clicked: el.textContent?.trim().slice(0, 60) || target };
  }

  // ── Type ───────────────────────────────────────────────────────────────────
  function _type(text, fieldHint) {
    let input = fieldHint ? _findInput(fieldHint) : null;
    if (!input && document.activeElement) {
      const ae = document.activeElement;
      if (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable) input = ae;
    }
    if (!input) {
      input = _findInput("") || document.querySelector(
        "input:not([type=hidden]):not([type=submit]):not([type=button]):not([disabled]),textarea:not([disabled])"
      );
    }
    if (!input) return { typed: null };
    input.scrollIntoView({ behavior: "smooth", block: "center" });
    input.focus();
    if (input.isContentEditable) {
      input.textContent = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      const proto  = input.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(input, text); else input.value = text;
      input.dispatchEvent(new Event("input",  { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return { typed: text };
  }

  // ── Read ───────────────────────────────────────────────────────────────────
  function _read() {
    const clone = document.body.cloneNode(true);
    for (const tag of ["script","style","noscript","svg","iframe","nav","footer","header"])
      clone.querySelectorAll(tag).forEach(n => n.remove());
    const text = (clone.innerText || clone.textContent || "")
      .replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
    return { text: text.slice(0, 8000), title: document.title, url: location.href };
  }

  // ── Select ─────────────────────────────────────────────────────────────────
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

  // ── Gesture cursor dot ─────────────────────────────────────────────────────
  let _dot = null, _dotX = window.innerWidth / 2, _dotY = window.innerHeight / 2;
  let _hoveredEl = null;

  function _ensureDot() {
    if (_dot && document.body.contains(_dot)) return;
    _dot = document.createElement("div");
    Object.assign(_dot.style, {
      position:      "fixed",
      width:         "20px",
      height:        "20px",
      borderRadius:  "50%",
      background:    "rgba(56,189,248,0.85)",
      border:        "2px solid #fff",
      boxShadow:     "0 0 14px rgba(56,189,248,0.7)",
      pointerEvents: "none",
      zIndex:        "2147483647",
      transform:     "translate(-50%,-50%)",
      transition:    "left .05s linear, top .05s linear, background .15s",
    });
    document.body.appendChild(_dot);
  }

  function _cursorMove(nx, ny) {
    _dotX = Math.max(0, Math.min(1, nx)) * window.innerWidth;
    _dotY = Math.max(0, Math.min(1, ny)) * window.innerHeight;
    _ensureDot();
    _dot.style.left = _dotX + "px";
    _dot.style.top  = _dotY + "px";
    _dot.style.display = "none";
    const el = document.elementFromPoint(_dotX, _dotY);
    _dot.style.display = "";
    if (el !== _hoveredEl) {
      if (_hoveredEl) _hoveredEl.style.outline = _hoveredEl._origOutline || "";
      _hoveredEl = el;
      if (el && el !== document.body && el !== document.documentElement) {
        el._origOutline = el.style.outline;
        el.style.outline = "2px solid rgba(56,189,248,0.85)";
      }
    }
    return { ok: true };
  }

  function _gestureClick(nx, ny) {
    _cursorMove(nx, ny);
    _ensureDot();
    _dot.style.background = "rgba(52,211,153,0.9)";
    setTimeout(() => { if (_dot) _dot.style.background = "rgba(56,189,248,0.85)"; }, 250);
    _dot.style.display = "none";
    const el = document.elementFromPoint(_dotX, _dotY);
    _dot.style.display = "";
    if (!el || el === document.body) return { clicked: null };
    el.focus?.();
    el.click();
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: _dotX, clientY: _dotY }));
    return { clicked: el.textContent?.trim().slice(0, 60) || el.tagName };
  }

  function _rightClick(nx, ny) {
    const x = Math.max(0, Math.min(1, nx)) * window.innerWidth;
    const y = Math.max(0, Math.min(1, ny)) * window.innerHeight;
    const el = document.elementFromPoint(x, y);
    if (!el) return { ok: false };
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    return { ok: true };
  }

  // ── Element finders ────────────────────────────────────────────────────────
  function _findElement(target, tagFilter = null) {
    const t = (target || "").toLowerCase().trim();
    if (!t) return null;
    const scope = tagFilter
      ? document.querySelectorAll(tagFilter)
      : document.querySelectorAll("button,a,[role=button],[role=link],input[type=submit],input[type=button],label,h1,h2,h3,li,td,th,span,div,p");
    let best = null, bestScore = 0;
    for (const el of scope) {
      if (!_isVisible(el)) continue;
      const attrs = [
        el.textContent?.trim().toLowerCase(),
        el.getAttribute("aria-label")?.toLowerCase(),
        el.getAttribute("title")?.toLowerCase(),
        el.getAttribute("placeholder")?.toLowerCase(),
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

})();
