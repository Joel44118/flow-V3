// ═══════════════════════════════════════════
// ui/chat-tray.js — Chats tray, per Joel's explicit request to move the
// chat log off being permanently on-screen (previously: two fixed side
// columns, invisible until hover) into its own toggleable left-edge
// tray, matching the same real slide-in pattern as content-lab.js and
// leads.js. Positioned ABOVE the Leads tray on the left edge.
//
// REAL, DELIBERATE DESIGN: this module does NOT reimplement chat
// rendering. ui/chat.js's Chat.add/addError/etc. already do
// document.getElementById("col-left"/"col-right") and append messages —
// that keeps working unchanged no matter where those two elements
// physically live in the DOM. This module's only real job is to move
// the existing #col-left/#col-right elements (defined in index.html)
// into a new tray container at init time, and provide the tray
// shell/tab. Nothing about message rendering, tool proposals, or the
// typing indicator needed to change.
// ═══════════════════════════════════════════

let _panelEl = null;

function _injectStyles() {
  if (document.getElementById("chat-tray-style")) return;
  const style = document.createElement("style");
  style.id = "chat-tray-style";
  style.textContent = `
#chat-tray-tab {
  position: fixed; top: 90px; left: 0;
  width: 28px; height: 84px;
  background: rgba(30,20,55,0.95); border: 1px solid rgba(167,139,250,0.4);
  border-left: none; border-radius: 0 10px 10px 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
  cursor: pointer; z-index: 9998; color: #a78bfa; font-size: 16px;
  box-shadow: 4px 0 16px rgba(0,0,0,0.35);
  transition: background 0.15s ease, width 0.15s ease;
}
#chat-tray-tab:hover { background: rgba(50,35,85,0.98); width: 32px; }
#chat-tray-tab .ct-tab-icon { font-size: 15px; line-height: 1; }
#chat-tray-tab .ct-tab-arrow { font-size: 11px; transition: transform 0.2s ease; }
#chat-tray-tab.ct-tray-open .ct-tab-arrow { transform: rotate(180deg); }
`;
  document.head.appendChild(style);
}

export function isChatTrayOpen() {
  return !!_panelEl?.classList.contains("ct-open");
}

export function openChatTray() {
  _injectStyles();

  if (_panelEl) {
    _panelEl.classList.add("ct-open");
    document.getElementById("chat-tray-tab")?.classList.add("ct-tray-open");
    return;
  }

  // Build the tray shell and move the EXISTING col-left/col-right
  // elements into it — real, deliberate choice over recreating them, so
  // every other module that already holds a reference or does
  // getElementById("col-left") keeps working with zero changes.
  const panel = document.createElement("div");
  panel.id = "chat-tray-panel";

  const colLeft = document.getElementById("col-left");
  const colRight = document.getElementById("col-right");
  if (colLeft) panel.appendChild(colLeft);
  if (colRight) panel.appendChild(colRight);

  document.body.appendChild(panel);
  _panelEl = panel;

  requestAnimationFrame(() => {
    panel.classList.add("ct-open");
    document.getElementById("chat-tray-tab")?.classList.add("ct-tray-open");
  });
}

// REAL, Joel-requested — tapping anywhere outside the tray (and outside
// its own tab button) closes it. Bound once at init, not per-open, since
// initChatTray() already builds the panel eagerly.
let _outsideClickBound = false;
function _bindOutsideClickClose() {
  if (_outsideClickBound) return;
  _outsideClickBound = true;
  document.addEventListener("mousedown", (e) => {
    if (!_panelEl?.classList.contains("ct-open")) return;
    const tab = document.getElementById("chat-tray-tab");
    if (_panelEl.contains(e.target) || tab?.contains(e.target)) return;
    closeChatTray();
  });
}

export function closeChatTray() {
  if (_panelEl) _panelEl.classList.remove("ct-open");
  document.getElementById("chat-tray-tab")?.classList.remove("ct-tray-open");
}

function _buildToggleButton() {
  const tab = document.createElement("div");
  tab.id = "chat-tray-tab";
  tab.title = "Chat";
  tab.innerHTML = `<span class="ct-tab-icon">💬</span><span class="ct-tab-arrow">▶</span>`;
  tab.addEventListener("click", () => {
    if (isChatTrayOpen()) closeChatTray();
    else openChatTray();
  });
  document.body.appendChild(tab);
}

export function initChatTray() {
  _injectStyles();
  _buildToggleButton();
  // Real, deliberate: build the tray shell (and move col-left/col-right
  // into it) immediately at init, not lazily on first open — messages
  // can arrive (e.g. Flow's proactive/self-initiated messages) before
  // Joel ever opens the tray for the first time, and Chat.add() needs
  // col-left/col-right to already exist wherever they're going to live.
  const panel = document.createElement("div");
  panel.id = "chat-tray-panel";
  const colLeft = document.getElementById("col-left");
  const colRight = document.getElementById("col-right");
  if (colLeft) panel.appendChild(colLeft);
  if (colRight) panel.appendChild(colRight);
  document.body.appendChild(panel);
  _panelEl = panel;
  _bindOutsideClickClose();
}
