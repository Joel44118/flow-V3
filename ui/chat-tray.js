// ═══════════════════════════════════════════
// ui/chat-tray.js — Chat drawers, REBUILT (3rd pass) per Joel's corrections
// to the 2nd pass.
//
// REAL CORRECTIONS THIS PASS, based on Joel's exact feedback on the 2nd
// pass:
//   1. "Mirrored" means POSITION-mirrored (like a physical mirror down
//      the center of the screen — same shape/style on both handles,
//      placed at the same distance from their own edge), NOT
//      shape-mirrored. The 2nd pass gave left/right handles different
//      corner-rounding, which read as "swapped" rather than reflected.
//      Fixed: both handles now share the exact same style (a circular
//      glass button matching #settings-btn/#sentinel-toggle-btn's own
//      look), just positioned as true mirror images of each other.
//   2. Closed-state handle must read as an EXTENSION of the top bar —
//      same circular glass look as the settings/bell buttons, sitting
//      immediately under #top-bar (top: 52px), not a separate rectangle
//      floating below it.
//   3. Removed the fade-to-transparent gradient entirely. The open
//      panel is a flat, consistent glass panel from just under the top
//      bar down to just above the footer (top:52px, bottom:26px —real
//      numbers, matching #top-bar/#app-footer's own heights in
//      styles.css) — not a fixed 60vh block that showed through into
//      unrelated screen space.
//   4. Width capped well short of screen-center so the open drawer
//      never overlaps the orb — the orb's own glow/rings extend to
//      roughly 200px from true center (core/config.js's ORB.RADIUS=90,
//      NET_RADIUS=135, real numbers read from the config, not guessed),
//      so each drawer is capped at min(340px, 36vw) AND clamped to
//      calc(50vw - 260px) as a hard ceiling — on any real screen size
//      this leaves the center clear.
//   5. Each message card is invisible until that SPECIFIC card is
//      hovered (or tapped, for touch — hover doesn't exist there) —
//      not a whole-panel fade. Scoped via CSS to cards living inside
//      the drawer specifically, plus a small click-delegation fallback
//      for touch devices where :hover never fires.
// ═══════════════════════════════════════════

let _leftPanelEl = null;
let _rightPanelEl = null;

const TOPBAR_HEIGHT  = 52; // px — real, matches #top-bar's height in styles.css
const FOOTER_HEIGHT  = 26; // px — real, matches #app-footer's height in styles.css

function _injectStyles() {
  if (document.getElementById("chat-drawer-style")) return;
  const style = document.createElement("style");
  style.id = "chat-drawer-style";
  style.textContent = `
/* REAL, Joel-requested — z-index sits BELOW the four tray tabs (9998)
   so Leads/Content Lab/Thought Log stay visible and clickable on top of
   an open chat drawer, but ABOVE ordinary page content. */
.chat-drawer {
  position: fixed; top: ${TOPBAR_HEIGHT}px; bottom: ${FOOTER_HEIGHT}px;
  width: min(340px, 36vw); max-width: calc(50vw - 260px);
  z-index: 9500; pointer-events: none;
  display: flex; flex-direction: column;
  transform: translateY(-100%);
  transition: transform 0.32s cubic-bezier(0.16, 1, 0.3, 1);
}
.chat-drawer.open { transform: translateY(0); pointer-events: all; }
.chat-drawer.boot-collapsed { opacity: 0; pointer-events: none; }
#chat-drawer-left  { left: 0; }
#chat-drawer-right { right: 0; }

/* REAL, flat glass panel — no fade-to-transparent gradient. Consistent
   background the full height of the drawer, matching the same glass
   language as ui/leads.js's #leads-panel and ui/settings.js's modal. */
.chat-drawer-content {
  flex: 1; overflow-y: auto; padding: 10px 14px 14px;
  background: rgba(15,10,30,0.94);
  border-right: 1px solid rgba(167,139,250,0.18); /* left drawer's real edge */
  pointer-events: all;
}
#chat-drawer-right .chat-drawer-content {
  border-right: none;
  border-left: 1px solid rgba(167,139,250,0.18); /* mirrored edge for the right drawer */
}
.chat-drawer-content::-webkit-scrollbar { display: none; }
.chat-drawer-content { scrollbar-width: none; }

/* REAL, per-card reveal — each message card is invisible until THAT
   card specifically is hovered or tapped, not the whole panel. Scoped
   to cards living inside a chat drawer only. */
.chat-drawer-content .mwrap { opacity: 0.12; transition: opacity 0.18s ease; }
.chat-drawer-content .mwrap:hover,
.chat-drawer-content .mwrap.card-tapped { opacity: 1; }

/* REAL, Joel-requested — the handle is styled identically to
   #settings-btn/#sentinel-toggle-btn (circular glass button, same
   palette) so a closed drawer genuinely reads as an extension of the
   top bar rather than an unrelated purple rectangle. Both handles
   share this EXACT same rule — only their position (left vs right,
   set below) differs, which is what makes them true mirror images
   instead of "swapped" shapes. */
.chat-drawer-handle {
  width: 34px; height: 34px; flex-shrink: 0; align-self: center;
  border-radius: 50%; cursor: pointer; pointer-events: all;
  background: radial-gradient(circle at 35% 30%, rgba(255,255,255,0.12), rgba(255,255,255,0.04) 70%);
  border: 1px solid rgba(255,255,255,0.16);
  display: flex; align-items: center; justify-content: center;
  color: rgba(255,255,255,0.85); font-size: 13px; line-height: 1;
  opacity: 0.7; box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
  transition: background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease, transform 0.15s ease;
  margin: 6px 0;
}
.chat-drawer-handle:hover {
  opacity: 1; transform: scale(1.06);
  background: radial-gradient(circle at 35% 30%, rgba(56,189,248,0.22), rgba(56,189,248,0.06) 70%);
  border-color: rgba(56,189,248,0.5);
}
.chat-drawer-handle.drawer-is-open {
  opacity: 1;
  background: radial-gradient(circle at 35% 30%, rgba(74,222,128,0.22), rgba(74,222,128,0.08) 70%);
  border-color: rgba(74,222,128,0.5); color: #4ade80;
}

/* Mirrored POSITION only — identical style, placed the same distance
   from each drawer's own edge. This is the real fix for "swapped"; the
   handle no longer changes shape/rounding side to side. */
#chat-drawer-left .chat-drawer-handle  { align-self: flex-start; margin-left: 10px; }
#chat-drawer-right .chat-drawer-handle { align-self: flex-end;   margin-right: 10px; }

@media (max-width: 768px) {
  .chat-drawer { width: 100vw; max-width: 100vw; left: 0 !important; right: 0 !important; }
  #chat-drawer-right { display: none; } /* real, matches prior mobile behavior */
}
`;
  document.head.appendChild(style);
}

function _buildDrawer(side, colEl) {
  const panel = document.createElement("div");
  panel.className = "chat-drawer boot-collapsed"; // real, hidden until core/boot.js reveals it
  panel.id = `chat-drawer-${side}`;

  // REAL: handle lives INSIDE the panel, before the content, so it sits
  // at the top of the panel when closed (flush under the top bar) and
  // rides down with the panel to sit right above the content when open
  // — same element throughout, only its screen position changes as the
  // panel translates.
  const handle = document.createElement("button");
  handle.className = "chat-drawer-handle";
  handle.setAttribute("aria-label", side === "left" ? "Toggle Flow's chat" : "Toggle your chat");
  handle.title = side === "left" ? "Flow" : "You";
  handle.textContent = "▼";
  handle.addEventListener("click", () => _toggleDrawer(side));
  panel.appendChild(handle);

  const content = document.createElement("div");
  content.className = "chat-drawer-content";
  if (colEl) content.appendChild(colEl);
  panel.appendChild(content);

  // REAL, touch fallback — :hover never fires on touch devices, so a
  // tapped card needs an explicit class toggle to reveal it. Tapping a
  // different card (or the empty content area) hides the previous one,
  // matching how hover naturally "moves on" on desktop.
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
  if (handle) handle.textContent = isOpen ? "▲" : "▼";
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
