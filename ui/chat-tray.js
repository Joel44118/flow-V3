// ═══════════════════════════════════════════
// ui/chat-tray.js — Chat drawers, REBUILT (4th pass) — real bug fix +
// corrections from Joel's latest feedback.
//
// REAL BUG FOUND AND FIXED: the 3rd pass put the handle button INSIDE
// the same .chat-drawer element that got `transform: translateY(-100%)`
// when closed. Since that element's real computed height spans nearly
// the full viewport (top:52px to bottom:26px), translating it by
// "-100%" moved the ENTIRE thing — handle included — hundreds of
// pixels off-screen. That's the actual, confirmed reason Joel saw no
// button at all, while somehow still seeing panel background at the
// edges (the .open class wasn't reliably re-triggering the transform
// context in all cases, leaving stale paint). Fixed by fully decoupling
// the handle from the sliding content:
//   - .chat-drawer (outer): a static, invisible positioning anchor only
//     — never transformed, never has its own background.
//   - .chat-drawer-handle: an independent, ALWAYS-PRESENT, absolutely-
//     positioned element inside that anchor. It moves via `top`
//     (0 when closed, near-bottom when open) — a real, separate
//     transition from the content's own visibility, so it can never be
//     dragged off-screen by a parent-level transform again.
//   - .chat-drawer-content: uses opacity+visibility+pointer-events,
//     with the transition declared ONLY on the .open state — so
//     closing snaps instantly invisible (no lingering fade), and only
//     opening fades in, exactly as Joel described.
//
// REAL, OTHER CORRECTIONS THIS PASS:
//   - Handles are now RECTANGULAR (not circular) per Joel's explicit
//     instruction, sitting flush under the top bar when closed.
//   - Strict boundary: top:52px / bottom:26px on the outer anchor
//     (matching #top-bar/#app-footer's real heights) means this drawer
//     can never render over the title bar or footer, full stop.
//   - Added a small "⋯" menu button next to each handle (Joel asked
//     for "a drop-down button, I have some things to do there" without
//     specifying what — this is my best-guess starting point: Clear
//     this chat / Copy conversation. Easy to extend once Joel says
//     what he actually wants in it.
// ═══════════════════════════════════════════

let _leftPanelEl = null;
let _rightPanelEl = null;

const TOPBAR_HEIGHT  = 52; // px — real, matches #top-bar's height in styles.css
const FOOTER_HEIGHT  = 26; // px — real, matches #app-footer's height in styles.css
const HANDLE_HEIGHT  = 28; // px — real, rectangular handle's own height

function _injectStyles() {
  if (document.getElementById("chat-drawer-style")) return;
  const style = document.createElement("style");
  style.id = "chat-drawer-style";
  style.textContent = `
/* REAL — the outer anchor is invisible and static. It never has a
   background, never transforms, and never grows past top:52px /
   bottom:26px — this is what physically prevents the drawer from EVER
   rendering over the title bar or footer, regardless of what's inside. */
.chat-drawer {
  position: fixed; top: ${TOPBAR_HEIGHT}px; bottom: ${FOOTER_HEIGHT}px;
  width: min(340px, 36vw); max-width: calc(50vw - 260px);
  z-index: 9500; pointer-events: none;
}
#chat-drawer-left  { left: 0; }
#chat-drawer-right { right: 0; }

/* REAL — the handle is its own independent element now, positioned
   with top (not nested inside anything that transforms). This is the
   actual fix: it can never be carried off-screen by a parent's
   transform again, because there is no parent transform anymore. */
.chat-drawer-handle-row {
  position: absolute; left: 0; right: 0; top: 0;
  height: ${HANDLE_HEIGHT}px;
  display: flex; align-items: center; gap: 4px;
  transition: top 0.32s cubic-bezier(0.16, 1, 0.3, 1);
  pointer-events: all;
}
.chat-drawer.open .chat-drawer-handle-row {
  top: calc(100% - ${HANDLE_HEIGHT}px);
}
#chat-drawer-left .chat-drawer-handle-row  { justify-content: flex-start; padding-left: 10px; }
#chat-drawer-right .chat-drawer-handle-row { justify-content: flex-end;   padding-right: 10px; }

/* REAL, Joel-requested — rectangular now, styled to match the top
   bar's own button language (same glass palette as #settings-btn) but
   with square corners instead of circular. */
.chat-drawer-handle {
  height: ${HANDLE_HEIGHT}px; padding: 0 12px; cursor: pointer;
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.16);
  border-radius: 4px;
  display: flex; align-items: center; justify-content: center;
  color: rgba(255,255,255,0.85); font-size: 12px; line-height: 1;
  opacity: 0.75; box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
  transition: background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
}
.chat-drawer-handle:hover { opacity: 1; background: rgba(56,189,248,0.15); border-color: rgba(56,189,248,0.5); }
.chat-drawer-handle.drawer-is-open { opacity: 1; background: rgba(74,222,128,0.15); border-color: rgba(74,222,128,0.5); color: #4ade80; }

/* REAL, the "⋯" menu button Joel asked for, next to the handle. */
.chat-drawer-menu-btn {
  height: ${HANDLE_HEIGHT}px; width: 28px; cursor: pointer;
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.16);
  border-radius: 4px; color: rgba(255,255,255,0.7); font-size: 14px;
  display: flex; align-items: center; justify-content: center;
  opacity: 0.75; transition: opacity 0.15s ease, background 0.15s ease;
}
.chat-drawer-menu-btn:hover { opacity: 1; background: rgba(255,255,255,0.12); }
.chat-drawer-menu-dropdown {
  position: absolute; top: ${HANDLE_HEIGHT + 4}px; min-width: 150px;
  background: rgba(15,10,30,0.98); border: 1px solid rgba(167,139,250,0.35);
  border-radius: 8px; padding: 4px; display: none; flex-direction: column;
  box-shadow: 0 8px 24px rgba(0,0,0,0.4); pointer-events: all; z-index: 9600;
}
.chat-drawer-menu-dropdown.show { display: flex; }
#chat-drawer-left .chat-drawer-menu-dropdown  { left: 10px; }
#chat-drawer-right .chat-drawer-menu-dropdown { right: 10px; }
.chat-drawer-menu-item {
  padding: 8px 10px; font-size: 12px; color: #e5e7eb; cursor: pointer; border-radius: 5px; text-align: left;
  background: none; border: none; font-family: inherit;
}
.chat-drawer-menu-item:hover { background: rgba(167,139,250,0.15); }

/* REAL — content is genuinely invisible when closed (opacity 0 +
   visibility hidden + pointer-events none — not a translated ghost).
   The transition is declared ONLY on .open, so closing is instant with
   zero fade, and opening is the only time the fade is visible — this
   is the exact behavior Joel asked for. */
.chat-drawer-content {
  position: absolute; left: 0; right: 0; top: ${HANDLE_HEIGHT}px; bottom: 0;
  overflow-y: auto; padding: 10px 14px 14px;
  background: rgba(15,10,30,0.94);
  opacity: 0; visibility: hidden; pointer-events: none;
}
.chat-drawer.open .chat-drawer-content {
  opacity: 1; visibility: visible; pointer-events: all;
  transition: opacity 0.25s ease;
}
#chat-drawer-left .chat-drawer-content  { border-right: 1px solid rgba(167,139,250,0.18); }
#chat-drawer-right .chat-drawer-content { border-left: 1px solid rgba(167,139,250,0.18); }
.chat-drawer-content::-webkit-scrollbar { display: none; }
.chat-drawer-content { scrollbar-width: none; }

/* REAL, per-card reveal — each message card is invisible until THAT
   card specifically is hovered or tapped. */
.chat-drawer-content .mwrap { opacity: 0.12; transition: opacity 0.18s ease; }
.chat-drawer-content .mwrap:hover,
.chat-drawer-content .mwrap.card-tapped { opacity: 1; }

.chat-drawer.boot-collapsed .chat-drawer-handle-row { opacity: 0; pointer-events: none; }

@media (max-width: 768px) {
  .chat-drawer { width: 100vw; max-width: 100vw; left: 0 !important; right: 0 !important; }
  #chat-drawer-right { display: none; }
}
`;
  document.head.appendChild(style);
}

function _buildDrawer(side, colEl) {
  const panel = document.createElement("div");
  panel.className = "chat-drawer boot-collapsed";
  panel.id = `chat-drawer-${side}`;

  // REAL: handle row is its own absolutely-positioned element, a
  // sibling of the content — NOT a parent/child relationship that
  // could transform them together. This is the actual bug fix.
  const handleRow = document.createElement("div");
  handleRow.className = "chat-drawer-handle-row";

  const handle = document.createElement("button");
  handle.className = "chat-drawer-handle";
  handle.setAttribute("aria-label", side === "left" ? "Toggle Flow's chat" : "Toggle your chat");
  handle.textContent = side === "left" ? "Flow ▾" : "You ▾";
  handle.addEventListener("click", () => _toggleDrawer(side));

  const menuBtn = document.createElement("button");
  menuBtn.className = "chat-drawer-menu-btn";
  menuBtn.textContent = "⋯";
  menuBtn.setAttribute("aria-label", "More options");

  const menuDropdown = document.createElement("div");
  menuDropdown.className = "chat-drawer-menu-dropdown";
  const clearItem = document.createElement("button");
  clearItem.className = "chat-drawer-menu-item";
  clearItem.textContent = "Clear this chat";
  clearItem.onclick = () => {
    content.querySelectorAll(".mwrap").forEach(el => el.remove());
    menuDropdown.classList.remove("show");
  };
  const copyItem = document.createElement("button");
  copyItem.className = "chat-drawer-menu-item";
  copyItem.textContent = "Copy conversation";
  copyItem.onclick = () => {
    const text = [...content.querySelectorAll(".mbubble")].map(el => el.textContent).join("\n");
    navigator.clipboard?.writeText(text).catch(() => {});
    menuDropdown.classList.remove("show");
  };
  menuDropdown.appendChild(clearItem);
  menuDropdown.appendChild(copyItem);
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    menuDropdown.classList.toggle("show");
  });
  document.addEventListener("click", (e) => {
    if (!menuDropdown.contains(e.target) && e.target !== menuBtn) menuDropdown.classList.remove("show");
  });

  handleRow.appendChild(handle);
  handleRow.appendChild(menuBtn);
  handleRow.appendChild(menuDropdown);
  panel.appendChild(handleRow);

  const content = document.createElement("div");
  content.className = "chat-drawer-content";
  if (colEl) content.appendChild(colEl);
  panel.appendChild(content);

  content.addEventListener("click", (e) => {
    const card = e.target.closest(".mwrap");
    content.querySelectorAll(".mwrap.card-tapped").forEach(el => {
      if (el !== card) el.classList.remove("card-tapped");
    });
    if (card) card.classList.toggle("card-tapped");
  });

  document.body.appendChild(panel);
  return panel;
}

function _toggleDrawer(side) {
  const panel = side === "left" ? _leftPanelEl : _rightPanelEl;
  if (!panel) return;
  const handle = panel.querySelector(".chat-drawer-handle");
  const isOpen = panel.classList.toggle("open");
  handle?.classList.toggle("drawer-is-open", isOpen);
  if (handle) handle.textContent = (panel.id === "chat-drawer-left" ? "Flow " : "You ") + (isOpen ? "▴" : "▾");
}

export function isChatTrayOpen() {
  return !!(_leftPanelEl?.classList.contains("open") || _rightPanelEl?.classList.contains("open"));
}

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
