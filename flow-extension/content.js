// ═══════════════════════════════════════════
// flow-extension/content.js
//
// Injected into every tab. Listens for
// flow-control messages and executes them
// inside the page context.
//
// Actions: scroll, click, type, read,
//          navigate, back, refresh, select
// ═══════════════════════════════════════════

// ── Register this tab with background.js ─────────────────────────────────
// If this is Flow's tab, background.js records its ID so it knows where
// to send replies. Harmless on other tabs.
chrome.runtime.sendMessage({ source: "flow-tab-register" }).catch(() => {});

// ── Listen for commands relayed from background.js ────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.source !== "flow-control") return;
  _handle(msg.action, msg.payload || {})
    .then(result => sendResponse({ ok: true,  result }))
    .catch(err  => sendResponse({ ok: false, error: err.message }));
  return true; // keep channel open for async response
});

// ── Also listen for window.postMessage from Flow's own page ───────────────
// When Flow and the target are in the same tab (rare but possible),
// this catches commands directly without going through background.js.
window.addEventListener("message", async (e) => {
  if (e.data?.source !== "flow-control") return;
  try {
    const result = await _handle(e.data.action, e.data.payload || {});
    window.postMessage({ source: "flow-ext-reply", ok: true,  action: e.data.action, result }, "*");
  } catch (err) {
    window.postMessage({ source: "flow-ext-reply", ok: false, action: e.data.action, error: err.message }, "*");
  }
});

// ── Action dispatcher ─────────────────────────────────────────────────────
async function _handle(action, payload) {
  switch (action) {

    case "ping":
      return { pong: true };

    case "scroll":
      return _scroll(payload);

    case "click":
      return _click(payload.target || "");

    case "type":
      return _type(payload.text || "", payload.field || "");

    case "read":
      return _read();

    case "navigate":
      if (payload.url) window.location.href = payload.url;
      return {};

    case "back":
      window.history.back();
      return {};

    case "refresh":
      window.location.reload();
      return {};

    case "select":
      return _select(payload.option || "", payload.field || "");

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

// ── scroll ────────────────────────────────────────────────────────────────
function _scroll({ direction = "down", amount = 400 }) {
  switch (direction) {
    case "top":    window.scrollTo({ top: 0,                        behavior: "smooth" }); break;
    case "bottom": window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }); break;
    case "up":     window.scrollBy({ top: -amount,                  behavior: "smooth" }); break;
    default:       window.scrollBy({ top:  amount,                  behavior: "smooth" }); break;
  }
  return { direction, amount };
}

// ── click ─────────────────────────────────────────────────────────────────
// Finds an element by visible text, aria-label, placeholder, title, or
// id/class fragment. Tries multiple strategies in order.
function _click(target) {
  const el = _findElement(target);
  if (!el) return { clicked: null };

  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.focus?.();
  el.click();

  // For anchors/buttons that use JS click handlers not bound to <a href>
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return { clicked: el.textContent?.trim().slice(0, 60) || el.getAttribute("aria-label") || target };
}

// ── type ──────────────────────────────────────────────────────────────────
function _type(text, fieldHint) {
  // Find the right input — either by fieldHint or just the focused/visible one
  let input = null;

  if (fieldHint) {
    input = _findInput(fieldHint);
  }

  // Fallback: use currently focused element if it's an input
  if (!input && document.activeElement &&
      ["INPUT","TEXTAREA","[contenteditable]"].some(s =>
        document.activeElement.matches?.(s) || document.activeElement.isContentEditable
      )) {
    input = document.activeElement;
  }

  // Fallback: find the first visible, interactable input on the page
  if (!input) {
    input = _findInput("") || document.querySelector(
      "input:not([type=hidden]):not([disabled]), textarea:not([disabled])"
    );
  }

  if (!input) return { typed: null };

  input.scrollIntoView({ behavior: "smooth", block: "center" });
  input.focus();

  // Works for both regular inputs and contenteditable elements
  if (input.isContentEditable) {
    input.textContent = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    // Trigger React/Vue synthetic events by setting value via descriptor
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value"
    )?.set || Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, "value"
    )?.set;

    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(input, text);
    } else {
      input.value = text;
    }

    input.dispatchEvent(new Event("input",  { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  return { typed: text };
}

// ── read ──────────────────────────────────────────────────────────────────
// Returns the page's meaningful text content, stripped of nav/scripts/style
function _read() {
  // Clone to avoid mutating the live DOM
  const clone = document.body.cloneNode(true);

  // Remove noise nodes
  for (const tag of ["script","style","noscript","svg","iframe","nav","footer","header"]) {
    clone.querySelectorAll(tag).forEach(n => n.remove());
  }

  const raw = clone.innerText || clone.textContent || "";
  // Collapse excessive whitespace
  const text = raw.replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
  return { text: text.slice(0, 8000), title: document.title, url: location.href };
}

// ── select ────────────────────────────────────────────────────────────────
// Selects an <option> from a <select> by label/value
function _select(optionText, fieldHint) {
  let sel = fieldHint ? _findElement(fieldHint, "select") : null;
  if (!sel) sel = document.querySelector("select");
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

// ── Element finders ───────────────────────────────────────────────────────

function _findElement(target, tagFilter = null) {
  const t = target.toLowerCase().trim();
  if (!t) return null;

  const candidates = tagFilter
    ? document.querySelectorAll(tagFilter)
    : document.querySelectorAll("button, a, [role=button], [role=link], input[type=submit], label, h1, h2, h3, li, td, th, span, div");

  // Score each element — exact match wins, partial match is ok
  let best = null, bestScore = 0;

  for (const el of candidates) {
    if (!_isVisible(el)) continue;

    const texts = [
      el.textContent?.trim().toLowerCase(),
      el.getAttribute("aria-label")?.toLowerCase(),
      el.getAttribute("title")?.toLowerCase(),
      el.getAttribute("placeholder")?.toLowerCase(),
      el.id?.toLowerCase(),
      el.name?.toLowerCase(),
    ].filter(Boolean);

    for (const txt of texts) {
      let score = 0;
      if (txt === t)             score = 10; // exact
      else if (txt.startsWith(t)) score = 7;  // starts with
      else if (txt.includes(t))   score = 4;  // contains

      if (score > bestScore) { bestScore = score; best = el; }
    }
  }

  return bestScore > 0 ? best : null;
}

function _findInput(hint) {
  const h = hint.toLowerCase().trim();
  const inputs = document.querySelectorAll(
    "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]):not([disabled]), textarea:not([disabled]), [contenteditable=true]"
  );

  if (!h) return Array.from(inputs).find(_isVisible) || null;

  let best = null, bestScore = 0;

  for (const el of inputs) {
    if (!_isVisible(el)) continue;

    const texts = [
      el.placeholder?.toLowerCase(),
      el.name?.toLowerCase(),
      el.id?.toLowerCase(),
      el.getAttribute("aria-label")?.toLowerCase(),
      // Also check the associated <label>
      el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent.toLowerCase() : null,
    ].filter(Boolean);

    for (const txt of texts) {
      let score = 0;
      if (txt === h)              score = 10;
      else if (txt.startsWith(h)) score = 7;
      else if (txt.includes(h))   score = 4;
      if (score > bestScore) { bestScore = score; best = el; }
    }
  }

  return bestScore > 0 ? best : null;
}

function _isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const style = window.getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}
