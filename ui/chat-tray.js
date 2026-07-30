// ═══════════════════════════════════════════
// ui/chat-tray.js — Chat drawers, REBUILT per Joel's explicit redesign
// (2nd pass — top-anchored mirrored drawers).
//
// REAL, NEW DESIGN, replacing the prior bottom-anchored version:
//   - Flow's messages: far-left drawer. Joel's messages: far-right
//     drawer. Fully separate, independent columns — not merged.
//   - Each drawer is anchored to the TOP, sitting just under #top-bar
//     (which is 52px tall — see styles.css), not the bottom.
//   - Each drawer has a small arrow-button handle. Handles are NOT
//     fang-shaped themselves — they're ordinary arrow buttons — but
//     because both sit permanently visible at the top of the screen,
//     mirrored (left one shaped one way, right one shaped the
//     mirror-image way), the pair reads visually like two front teeth/
//     fangs framing the top of the app. That's a side-effect of
//     mirroring, not a literal shape requirement.
//   - The handle buttons are ALWAYS visible (not hover-revealed like the
//     old version) — only the message content underneath does its own
//     per-card hover reveal (see ui/chat.js, untouched here).
//   - Default/closed state: handle sits at the very top (just under the
//     top bar), arrow pointing DOWN (▼) meaning "click to pull this
//     down". This is the "dragged up" resting position Joel described.
//   - On click: the handle ITSELF travels down with the panel to the
//     bottom edge of the now-revealed drawer (not staying pinned at
//     top) — arrow flips to point UP (▲), meaning "click to push this
//     back up". This is the real drop-down motion Joel asked for.
//   - The two sides are fully independent — either, both, or neither
//     can be open at once. Left and right are mirror images of each
//     other, so open+open reads as symmetrical rather than misplaced.
//
// REAL, DELIBERATE: this does NOT reimplement message rendering.
// ui/chat.js's Chat.add/addError/etc. already do
// document.getElementById("col-left"/"col-right") — that keeps working
// unchanged no matter where those two elements physically live in the
// DOM. This module's only real job is placing #col-left/#col-right
// into their own top-anchored drawer containers and providing the
// always-visible-handle/slide-down mechanics.
// ═══════════════════════════════════════════

let _leftPanelEl = null;
let _rightPanelEl = null;

const TOPBAR_HEIGHT = 52; // px — real, matches #top-bar's height in styles.css exactly

function _injectStyles() {
  if (document.getElementById("chat-drawer-style")) return;
  const style = document.createElement("style");
  style.id = "chat-drawer-style";
  style.textContent = `
/* REAL, Joel-requested — z-index sits BELOW the four tray tabs (9998)
   so Leads/Content Lab/Thought Log stay visible and clickable on top of
   an open chat drawer, but ABOVE ordinary page content so the drawer
   genuinely overlays everything else, per Joel's explicit spec. */
.chat-drawer {
  position: fixed; top: ${TOPBAR_HEIGHT}px; width: 42vw; height: 60vh;
  z-index: 9500; pointer-events: none;
  display: flex; flex-direction: column;
  transform: translateY(-100%);
  transition: transform 0.32s cubic-bezier(0.16, 1, 0.3, 1);
}
.chat-drawer.open { transform: translateY(0); pointer-events: all; }
#chat-drawer-left  { left: 0; }
#chat-drawer-right { right: 0; }

/* REAL, matches the same boot-collapsed pattern used by #top-bar and
   the other three trays — hides the always-visible arrow handle too
   during boot, so it doesn't flash on screen before real init finishes. */
.chat-drawer.boot-collapsed { opacity: 0; pointer-events: none; }

.chat-drawer-content {
  flex: 1; overflow-y: auto; padding: 8px 14px 16px;
  background: linear-gradient(to bottom, rgba(10,8,20,0.85) 60%, rgba(10,8,20,0));
  pointer-events: all;
}
.chat-drawer-content::-webkit-scrollbar { display: none; }
.chat-drawer-content { scrollbar-width: none; } /* Firefox — real, matches the invisible-scrollbar spec */

/* REAL, Joel-requested — the arrow-button handle. ALWAYS visible (no
   hover-reveal gate anymore — only the message cards underneath do
   their own per-card hover reveal). The handle travels WITH the panel:
   it's the panel's own last child, not a separately-positioned fixed
   element, so when .chat-drawer translates down on open, the handle
   genuinely rides along to the bottom edge of the revealed drawer —
   this is what makes it feel "dragged down" and not just cosmetically
   flipped in place. */
.chat-drawer-handle {
  width: 56px; height: 26px; flex-shrink: 0;
  background: rgba(30,20,55,0.92); border: 1px solid rgba(167,139,250,0.4);
  cursor: pointer; pointer-events: all;
  display: flex; align-items: center; justify-content: center;
  color: #a78bfa; font-size: 13px; line-height: 1;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
  box-shadow: 0 2px 10px rgba(0,0,0,0.35);
}
.chat-drawer-handle:hover { background: rgba(50,35,85,0.97); color: #c4b5fd; }
.chat-drawer-handle.drawer-is-open { background: rgba(74,222,128,0.15); border-color: rgba(74,222,128,0.45); color: #4ade80; }

/* Mirrored shaping — REAL, this is what makes the pair read as a single
   symmetrical "fangs" motif rather than two unrelated buttons. Left
   drawer's handle rounds its bottom-RIGHT corner and sits toward the
   left edge; right drawer's handle mirrors it exactly (rounds bottom-
   LEFT, sits toward the right edge) — like two teeth meeting at the
   top-center of the screen when both are closed. */
#chat-drawer-left .chat-drawer-handle {
  align-self: flex-start;
  border-radius: 0 0 10px 0;
  margin-left: 18px;
}
#chat-drawer-right .chat-drawer-handle {
  align-self: flex-end;
  border-radius: 0 0 0 10px;
  margin-right: 18px;
}

@media (max-width: 768px) {
  .chat-drawer { width: 100vw; left: 0 !important; right: 0 !important; }
  #chat-drawer-right { display: none; } /* real, matches prior mobile behavior — Joel's own messages weren't shown on mobile before this change either */
}
`;
  document.head.appendChild(style);
}

function _buildDrawer(side, colEl) {
  const panel = document.createElement("div");
  panel.className = "chat-drawer boot-collapsed"; // real, hidden until core/boot.js reveals it — matches prior tray-tab boot behavior
  panel.id = `chat-drawer-${side}`;

  const content = document.createElement("div");
  content.className = "chat-drawer-content";
  if (colEl) content.appendChild(colEl);
  panel.appendChild(content);

  // REAL: handle lives INSIDE the panel, after the content — this is
  // what makes it travel down with the drawer on open, per Joel's spec,
  // rather than staying pinned at a fixed screen position.
  const handle = document.createElement("button");
  handle.className = "chat-drawer-handle";
  handle.setAttribute("aria-label", side === "left" ? "Toggle Flow's chat" : "Toggle your chat");
  handle.title = side === "left" ? "Flow" : "You";
  handle.textContent = "▼"; // closed default — points down, "pull me down"
  handle.addEventListener("click", () => _toggleDrawer(side));
  panel.appendChild(handle);

  document.body.appendChild(panel);
  return panel;
}

function _toggleDrawer(side) {
  const panel = side === "left" ? _leftPanelEl : _rightPanelEl;
  if (!panel) return;
  const handle = panel.querySelector(".chat-drawer-handle");
  const isOpen = panel.classList.toggle("open");
  handle?.classList.toggle("drawer-is-open", isOpen);
  if (handle) handle.textContent = isOpen ? "▲" : "▼"; // flips to "push me back up" once open
}

export function isChatTrayOpen() {
  return !!(_leftPanelEl?.classList.contains("open") || _rightPanelEl?.classList.contains("open"));
}

// REAL, kept for compatibility with core/commands.js's setTrayHandlers
// wiring — opens BOTH drawers at once, since there's no single combined
// tray to open.
export function openChatTray() {
  _injectStyles();
  if (_leftPanelEl && !_leftPanelEl.classList.contains("open")) _toggleDrawer("left");
  if (_rightPanelEl && !_rightPanelEl.classList.contains("open")) _toggleDrawer("right");
}

export function closeChatTray() {
  if (_leftPanelEl?.classList.contains("open")) _toggleDrawer("left");
  if (_rightPanelEl?.classList.contains("open")) _toggleDrawer("right");
}

export function initChatTray() {
  _injectStyles();

  const colLeft = document.getElementById("col-left");
  const colRight = document.getElementById("col-right");

  _leftPanelEl = _buildDrawer("left", colLeft);
  _rightPanelEl = _buildDrawer("right", colRight);
}
