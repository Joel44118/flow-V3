// ═══════════════════════════════════════════
// ui/settings.js — Flow's Settings panel. Real, Joel-requested: a place
// to toggle background behaviors on/off, starting with background
// research (content/sales/mindset rotation). A simple modal, not a full
// slide-in tray — settings are a few toggles, not a growing feed of
// content, so a tray's polling/live-update machinery would be overkill.
//
// HONEST SCOPE: real settings storage lives in flow-electron/heartbeat.js
// (a small JSON file in userData), reached via IPC — so these toggles
// only actually persist/take effect in the Electron desktop build. On
// the plain web build (window.__flowElectron doesn't exist), the panel
// still opens but shows an honest note instead of pretending a toggle
// took effect when it didn't.
// ═══════════════════════════════════════════

let _modalEl = null;

function _injectStyles() {
  if (document.getElementById("settings-modal-style")) return;
  const style = document.createElement("style");
  style.id = "settings-modal-style";
  style.textContent = `
#settings-overlay {
  /* REAL, Joel-requested fix elsewhere: the rotating light stripe
     (body::after in styles.css) was raised to z-index:10000 so it
     rotates OVER the tray tabs/panels instead of under them. Settings'
     own modal is bumped to 10500 here specifically so it stays above
     BOTH the trays AND the light stripe — a real dialog should still
     win over a decorative effect. */
  position: fixed; inset: 0; z-index: 10500;
  background: rgba(4,6,13,0.7); backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center;
  opacity: 0; pointer-events: none; transition: opacity 0.2s ease;
}
#settings-overlay.open { opacity: 1; pointer-events: all; }

#settings-modal {
  width: min(420px, 90vw); max-height: 80vh; overflow-y: auto;
  background: rgba(15,10,30,0.98); border: 1px solid rgba(167,139,250,0.4);
  border-radius: 14px; box-shadow: 0 20px 60px rgba(0,0,0,0.6);
  padding: 20px 22px; color: #e5e7eb; font-family: system-ui, sans-serif;
  transform: scale(0.96); transition: transform 0.2s ease;
}
#settings-overlay.open #settings-modal { transform: scale(1); }

#settings-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 16px;
}
#settings-header h2 { font-size: 16px; font-weight: 700; color: #d8d4ff; margin: 0; }
#settings-close-btn { background: none; border: none; color: #9ca3af; font-size: 18px; cursor: pointer; padding: 4px 8px; }
#settings-close-btn:hover { color: #e5e7eb; }

.settings-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 0; border-bottom: 1px solid rgba(167,139,250,0.12);
}
.settings-row:last-child { border-bottom: none; }
.settings-row-label { font-size: 13px; color: #e5e7eb; }
.settings-row-desc { font-size: 11px; color: rgba(255,255,255,0.4); margin-top: 3px; }

.settings-toggle {
  position: relative; width: 40px; height: 22px; flex-shrink: 0;
  background: rgba(255,255,255,0.15); border-radius: 999px; cursor: pointer;
  transition: background 0.2s ease;
}
.settings-toggle.on { background: #4ade80; }
.settings-toggle-knob {
  position: absolute; top: 2px; left: 2px; width: 18px; height: 18px;
  background: #fff; border-radius: 50%; transition: transform 0.2s ease;
}
.settings-toggle.on .settings-toggle-knob { transform: translateX(18px); }

#settings-web-note {
  font-size: 11px; color: rgba(245,158,11,0.9); background: rgba(245,158,11,0.1);
  border: 1px solid rgba(245,158,11,0.25); border-radius: 8px; padding: 10px 12px;
  margin-bottom: 14px; line-height: 1.4;
}
`;
  document.head.appendChild(style);
}

async function _getSettings() {
  if (!window.__flowElectron?.settings) return null; // real, honest — not available on web build
  try { return await window.__flowElectron.settings.get(); } catch (_) { return null; }
}

async function _setSetting(key, value) {
  if (!window.__flowElectron?.settings) return;
  try { await window.__flowElectron.settings.set(key, value); } catch (_) {}
}

function _buildToggleRow({ key, label, desc, checked, onChange }) {
  const row = document.createElement("div");
  row.className = "settings-row";

  const textWrap = document.createElement("div");
  const labelEl = document.createElement("div");
  labelEl.className = "settings-row-label";
  labelEl.textContent = label;
  const descEl = document.createElement("div");
  descEl.className = "settings-row-desc";
  descEl.textContent = desc;
  textWrap.appendChild(labelEl);
  textWrap.appendChild(descEl);

  const toggle = document.createElement("div");
  toggle.className = "settings-toggle" + (checked ? " on" : "");
  toggle.dataset.key = key;
  const knob = document.createElement("div");
  knob.className = "settings-toggle-knob";
  toggle.appendChild(knob);

  toggle.addEventListener("click", async () => {
    const newState = !toggle.classList.contains("on");
    toggle.classList.toggle("on", newState);
    await onChange(newState);
  });

  row.appendChild(textWrap);
  row.appendChild(toggle);
  return row;
}

async function _buildModalContent(body) {
  body.innerHTML = "";

  const settings = await _getSettings();
  if (!settings) {
    const note = document.createElement("div");
    note.id = "settings-web-note";
    note.textContent = "⚠️ Real settings storage lives in the Electron desktop app — on the web version, toggles here won't actually persist. Open Flow's desktop app to change these for real.";
    body.appendChild(note);
  }

  const effectiveSettings = settings || { backgroundResearchEnabled: true };

  body.appendChild(_buildToggleRow({
    key: "backgroundResearchEnabled",
    label: "Background research",
    desc: "Flow rotates through content, sales-conversation, and business-mindset research while online, silently earning EXP — no notification, just the level bar growing.",
    checked: effectiveSettings.backgroundResearchEnabled,
    onChange: async (val) => { await _setSetting("backgroundResearchEnabled", val); },
  }));

  // REAL, NEW — hands-free voice via continuous VAD (core/hands-free-
  // vad.js), no hotkey or wake word needed. Defaults OFF: without a
  // wake word, this transcribes ANY speech while it's on, not just
  // speech meant for Flow — an honest trade-off Joel opts into
  // deliberately rather than something silently always-on.
  body.appendChild(_buildToggleRow({
    key: "handsFreeVoiceEnabled",
    label: "Hands-free voice",
    desc: "Flow listens continuously and transcribes whenever it detects speech — no hotkey, no wake word. Real trade-off: it can't tell if speech is meant for it, so it reacts to anything spoken while this is on.",
    checked: !!effectiveSettings.handsFreeVoiceEnabled,
    onChange: async (val) => {
      await _setSetting("handsFreeVoiceEnabled", val);
      try {
        const { setHandsFreeVoiceEnabled } = await import("../core/hands-free-vad.js");
        await setHandsFreeVoiceEnabled(val);
      } catch (e) {
        console.warn("[Settings] Hands-free voice toggle failed:", e.message);
      }
    },
  }));
}

export async function openSettings() {
  _injectStyles();

  if (!_modalEl) {
    const overlay = document.createElement("div");
    overlay.id = "settings-overlay";

    const modal = document.createElement("div");
    modal.id = "settings-modal";

    const header = document.createElement("div");
    header.id = "settings-header";
    header.innerHTML = `<h2>⚙️ Settings</h2>`;
    const closeBtn = document.createElement("button");
    closeBtn.id = "settings-close-btn";
    closeBtn.textContent = "✕";
    closeBtn.onclick = closeSettings;
    header.appendChild(closeBtn);
    modal.appendChild(header);

    const body = document.createElement("div");
    body.id = "settings-body";
    modal.appendChild(body);

    overlay.appendChild(modal);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) closeSettings(); });
    document.body.appendChild(overlay);
    _modalEl = overlay;
  }

  await _buildModalContent(_modalEl.querySelector("#settings-body"));
  requestAnimationFrame(() => _modalEl.classList.add("open"));
}

export function closeSettings() {
  if (_modalEl) _modalEl.classList.remove("open");
}

export function initSettings() {
  document.getElementById("settings-btn")?.addEventListener("click", openSettings);
}
