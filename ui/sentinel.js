// ui/sentinel.js — Flow Sentinel UI control
// Self-contained: does nothing at all when not running inside the Electron
// desktop app (window.__flowElectron.sentinel won't exist on web/PWA), so
// this is always safe to import everywhere.
//
// Surfaces:
//   - A toggle pill in the top bar: "👁 Sentinel" (off) / pulsing purple (on)
//   - When Sentinel notices something, it's spoken into the chat exactly
//     like any other Flow message, via the same Chat.add() everything else
//     uses — no separate UI surface to maintain.

let _Chat = null;

export function initSentinel(Chat) {
  _Chat = Chat;

  const bridge = window.__flowElectron?.sentinel;
  if (!bridge) return; // not running in Electron — Sentinel doesn't exist here

  bridge.status().then(({ enabled, available }) => {
    if (!available) return; // active-win failed to load on this machine
    _buildToggle(enabled);
  });

  bridge.onObservation((desc) => {
    _Chat.add(`👁 **Sentinel noticed:**\n\n${desc}`, 'bot');
  });

  bridge.onToggled((enabled) => {
    _setToggleState(enabled);
  });
}

let _pillEl = null;

function _buildToggle(initialEnabled) {
  const topBar = document.getElementById('top-bar');
  if (!topBar || document.getElementById('sentinel-toggle')) return;

  const pill = document.createElement('button');
  pill.id = 'sentinel-toggle';
  pill.type = 'button';
  pill.style.cssText = `
    display:flex;align-items:center;gap:6px;
    background:rgba(167,139,250,0.08);
    border:1px solid rgba(167,139,250,0.3);
    color:#a78bfa;font-size:11px;font-weight:600;
    border-radius:20px;padding:5px 12px;cursor:pointer;
    margin-left:8px;font-family:inherit;letter-spacing:.02em;
    transition:background .15s,border-color .15s;
  `;
  pill.innerHTML = `<span id="sentinel-pill-dot" style="width:6px;height:6px;border-radius:50%;background:#a78bfa;"></span><span id="sentinel-pill-label">Sentinel</span>`;

  pill.addEventListener('click', async () => {
    const next = !pill.dataset.enabled || pill.dataset.enabled === 'false';
    window.__flowElectron.sentinel.toggle(next);
    _setToggleState(next);
    _Chat.add(
      next
        ? "👁 Sentinel is on — I'll keep half an eye on what you're working on, and say something if it looks like you've been stuck for a while. You can turn this off any time, here or from the tray icon."
        : "Sentinel is off. I'm not watching the screen anymore.",
      'bot'
    );
  });

  topBar.appendChild(pill);
  _pillEl = pill;
  _setToggleState(initialEnabled);
}

function _setToggleState(enabled) {
  if (!_pillEl) return;
  _pillEl.dataset.enabled = String(enabled);
  const dot = document.getElementById('sentinel-pill-dot');
  if (enabled) {
    _pillEl.style.background = 'rgba(167,139,250,0.22)';
    _pillEl.style.borderColor = 'rgba(167,139,250,0.65)';
    if (dot) dot.style.animation = 'pulse 1.6s ease-in-out infinite';
  } else {
    _pillEl.style.background = 'rgba(167,139,250,0.08)';
    _pillEl.style.borderColor = 'rgba(167,139,250,0.3)';
    if (dot) dot.style.animation = 'none';
  }
}

// Inject the pulse keyframes once
if (!document.getElementById('sentinel-style')) {
  const style = document.createElement('style');
  style.id = 'sentinel-style';
  style.textContent = `@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}`;
  document.head.appendChild(style);
}
