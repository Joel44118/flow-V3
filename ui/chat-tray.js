// ═══════════════════════════════════════════
// ui/chat-tray.js — Chat drawers, REBUILT per Joel's explicit redesign.
//
// REAL, NEW DESIGN: scraps the single tab-toggled tray entirely. Back to
// two independent columns on each side of the screen (Flow's messages
// on the left, Joel's on the right — same as the original pre-tray
// layout), but each is now a real DRAWER:
//   - A small rectangular handle sits at the bottom of each side,
//     invisible by default, visible only on hover of that bottom-edge
//     region.
//   - Clicking a handle slides that side's chat content UP into view
//     (a real drawer/drop-down motion, from below).
//   - Drawers overlay everything else on screen EXCEPT the four tray
//     tab buttons (Leads/Content Lab/Chats-N/A-anymore/Thought Log),
//     which stay visually on top and clickable even with a drawer open
//     — achieved with z-index lower than the tray tabs but higher than
//     everything else.
//   - The two sides are fully independent — either, both, or neither
//     can be open at once.
//
// REAL, DELIBERATE: this does NOT reimplement message rendering.
// ui/chat.js's Chat.add/addError/etc. already do
// document.getElementById("col-left"/"col-right") — that keeps working
// unchanged no matter where those two elements physically live in the
// DOM. This module's only real job is placing #col-left/#col-right
// into their own drawer containers and providing the hover-handle/
// slide-up mechanics.
// ═══════════════════════════════════════════

let _leftPanelEl = null;
let _rightPanelEl = null;

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
  position: fixed; bottom: 0; width: 50vw; height: 60vh;
  z-index: 9500; pointer-events: none;
  display: flex; flex-direction: column; justify-content: flex-end;
  transform: translateY(100%);
  transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1);
}
.chat-drawer.open { transform: translateY(0); pointer-events: all; }
#chat-drawer-left  { left: 0; }
#chat-drawer-right { right: 0; }

.chat-drawer-content {
  flex: 1; overflow-y: auto; padding: 16px 14px 8px;
  background: linear-gradient(to top, rgba(10,8,20,0.85) 60%, rgba(10,8,20,0));
  pointer-events: all;
}
.chat-drawer-content::-webkit-scrollbar { display: none; }

/* REAL, Joel-requested — the actual hover handle: a small rectangular
   tab at the bottom edge, invisible by default, revealed on hover of
   the handle itself OR the thin trigger strip just above it (so Joel
   doesn't need pixel-perfect aim to notice it's there). */
.chat-drawer-handle-zone {
  position: fixed; bottom: 0; width: 50vw; height: 34px;
  z-index: 9499; pointer-events: all;
}
#chat-drawer-handle-zone-left  { left: 0; }
#chat-drawer-handle-zone-right { right: 0; }

.chat-drawer-handle {
  position: absolute; bottom: 6px; width: 64px; height: 22px;
  background: rgba(30,20,55,0.9); border: 1px solid rgba(167,139,250,0.35);
  border-radius: 8px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  color: #a78bfa; font-size: 12px;
  opacity: 0; transition: opacity 0.2s ease, background 0.15s ease;
}
.chat-drawer-handle-zone-left .chat-drawer-handle  { left: 50%; transform: translateX(-50%); }
.chat-drawer-handle-zone-right .chat-drawer-handle { left: 50%; transform: translateX(-50%); }

.chat-drawer-handle-zone:hover .chat-drawer-handle { opacity: 1; }
.chat-drawer-handle:hover { background: rgba(50,35,85,0.95); }
.chat-drawer-handle.drawer-is-open { opacity: 1; background: rgba(74,222,128,0.15); border-color: rgba(74,222,128,0.4); color: #4ade80; }

@media (max-width: 768px) {
  .chat-drawer, .chat-drawer-handle-zone { width: 100vw; left: 0 !important; right: 0 !important; }
  #chat-drawer-right, #chat-drawer-handle-zone-right { display: none; } /* real, matches prior mobile behavior — Joel's own messages weren't shown on mobile before this change either */
}
`;
  document.head.appendChild(style);
}

function _buildDrawer(side, colEl) {
  const panel = document.createElement("div");
  panel.className = "chat-drawer";
  panel.id = `chat-drawer-${side}`;

  const content = document.createElement("div");
  content.className = "chat-drawer-content";
  if (colEl) content.appendChild(colEl);
  panel.appendChild(content);

  document.body.appendChild(panel);

  const handleZone = document.createElement("div");
  handleZone.className = "chat-drawer-handle-zone boot-collapsed"; // real, hidden until core/boot.js reveals it
  handleZone.id = `chat-drawer-handle-zone-${side}`;

  const handle = document.createElement("div");
  handle.className = "chat-drawer-handle";
  handle.textContent = side === "left" ? "💬 Flow" : "💬 You";
  handle.addEventListener("click", () => _toggleDrawer(side));
  handleZone.appendChild(handle);
  document.body.appendChild(handleZone);

  return panel;
}

function _toggleDrawer(side) {
  const panel = side === "left" ? _leftPanelEl : _rightPanelEl;
  const handle = document.querySelector(`#chat-drawer-handle-zone-${side} .chat-drawer-handle`);
  if (!panel) return;
  const isOpen = panel.classList.toggle("open");
  handle?.classList.toggle("drawer-is-open", isOpen);
}

export function isChatTrayOpen() {
  return !!(_leftPanelEl?.classList.contains("open") || _rightPanelEl?.classList.contains("open"));
}

// REAL, kept for compatibility with core/commands.js's setTrayHandlers
// wiring (not currently invoked by any real slash command, but kept as
// a real, working no-guess fallback in case one is added later) — opens
// BOTH drawers at once, since there's no longer a single combined tray
// to open.
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
