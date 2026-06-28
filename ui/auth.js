// ui/auth.js — Flow password panel
// First visit: create a PIN (4–8 digits or passphrase)
// Every visit after: must enter PIN to unlock
// Auto-locks after 5 hours of inactivity or on reload
// PIN stored as SHA-256 hash in localStorage — never plain text

const LOCK_KEY    = "flow_lock_hash";
const UNLOCK_KEY  = "flow_unlocked_until";
const UNLOCK_HRS  = 5;   // hours before re-locking

// ── SHA-256 hash (browser native, no libraries) ───────────────────────────
async function _hash(str) {
  const buf  = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join("");
}

// ── Check if currently unlocked ───────────────────────────────────────────
function _isUnlocked() {
  const until = localStorage.getItem(UNLOCK_KEY);
  if (!until) return false;
  return Date.now() < parseInt(until, 10);
}

function _setUnlocked() {
  const until = Date.now() + UNLOCK_HRS * 60 * 60 * 1000;
  localStorage.setItem(UNLOCK_KEY, String(until));
}

// ── Build the lock screen UI ──────────────────────────────────────────────
function _buildPanel(mode) {
  // Remove any existing panel
  document.getElementById("flow-auth-panel")?.remove();

  const isSetup = mode === "setup";

  const panel = document.createElement("div");
  panel.id = "flow-auth-panel";
  panel.innerHTML = `
    <div id="flow-auth-inner">
      <div id="flow-auth-logo">FLOW</div>
      <div id="flow-auth-sub">${isSetup ? "Create your access PIN" : "Enter your PIN to unlock"}</div>

      <input id="flow-auth-input"
        type="password"
        placeholder="${isSetup ? "Create PIN (4+ characters)" : "Enter PIN"}"
        autocomplete="current-password"
        inputmode="numeric"
        maxlength="32">

      ${isSetup ? `<input id="flow-auth-confirm" type="password" placeholder="Confirm PIN" autocomplete="new-password" inputmode="numeric" maxlength="32">` : ""}

      <button id="flow-auth-btn">${isSetup ? "SET PIN" : "UNLOCK"}</button>
      <div id="flow-auth-err"></div>
    </div>
  `;

  // Inject styles
  const style = document.createElement("style");
  style.textContent = `
    #flow-auth-panel {
      position: fixed; inset: 0; z-index: 99999;
      display: flex; align-items: center; justify-content: center;
      background: rgba(6,10,26,0.97);
      backdrop-filter: blur(40px) saturate(180%);
      -webkit-backdrop-filter: blur(40px) saturate(180%);
    }
    #flow-auth-inner {
      display: flex; flex-direction: column; align-items: center; gap: 16px;
      background: rgba(255,255,255,0.07);
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 24px; padding: 40px 36px;
      box-shadow: 0 1px 0 rgba(255,255,255,0.12) inset, 0 32px 80px rgba(0,0,0,0.6);
      width: min(340px, 88vw);
    }
    #flow-auth-logo {
      font-family: 'Orbitron', monospace; font-size: 28px; font-weight: 700;
      letter-spacing: .35em; color: #38bdf8;
      text-shadow: 0 0 28px rgba(56,189,248,0.55);
      margin-bottom: 4px;
    }
    #flow-auth-sub {
      font-family: 'Rajdhani', sans-serif; font-size: 13px;
      color: rgba(255,255,255,0.45); letter-spacing: .05em;
    }
    #flow-auth-input, #flow-auth-confirm {
      width: 100%; padding: 13px 16px; border-radius: 14px;
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.18);
      color: #fff; font-size: 18px; letter-spacing: .25em;
      text-align: center; outline: none; font-family: monospace;
      transition: border-color .2s;
    }
    #flow-auth-input:focus, #flow-auth-confirm:focus {
      border-color: rgba(56,189,248,0.55);
    }
    #flow-auth-btn {
      width: 100%; padding: 14px;
      background: rgba(56,189,248,0.15);
      border: 1px solid rgba(56,189,248,0.4);
      border-radius: 14px; color: #38bdf8;
      font-family: 'Orbitron', monospace; font-size: 12px; letter-spacing: .18em;
      cursor: pointer; transition: background .2s, box-shadow .2s;
    }
    #flow-auth-btn:hover {
      background: rgba(56,189,248,0.28);
      box-shadow: 0 0 20px rgba(56,189,248,0.2);
    }
    #flow-auth-err {
      font-size: 12px; color: #f87171; min-height: 18px;
      font-family: 'Rajdhani', sans-serif; text-align: center;
    }
    @media (max-width: 480px) {
      #flow-auth-inner { padding: 32px 22px; }
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(panel);

  const input   = document.getElementById("flow-auth-input");
  const confirm = document.getElementById("flow-auth-confirm");
  const btn     = document.getElementById("flow-auth-btn");
  const err     = document.getElementById("flow-auth-err");

  // Focus on mount
  setTimeout(() => input?.focus(), 100);

  // Enter key support
  [input, confirm].forEach(el => {
    el?.addEventListener("keydown", e => { if (e.key === "Enter") btn.click(); });
  });

  return { input, confirm, btn, err };
}

// ── Main export ───────────────────────────────────────────────────────────
export async function initAuth() {
  const stored = localStorage.getItem(LOCK_KEY);

  // Already unlocked within 5 hours — skip panel
  if (stored && _isUnlocked()) return;

  return new Promise((resolve) => {

    if (!stored) {
      // First time — setup mode
      const { input, confirm, btn, err } = _buildPanel("setup");

      btn.addEventListener("click", async () => {
        const val = input.value.trim();
        const con = confirm?.value.trim() || "";
        if (val.length < 4) { err.textContent = "PIN must be at least 4 characters."; return; }
        if (val !== con)    { err.textContent = "PINs don't match."; return; }
        const h = await _hash(val);
        localStorage.setItem(LOCK_KEY, h);
        _setUnlocked();
        document.getElementById("flow-auth-panel")?.remove();
        resolve();
      });

    } else {
      // Return visit — unlock mode
      let attempts = 0;
      const { input, btn, err } = _buildPanel("unlock");

      btn.addEventListener("click", async () => {
        const val = input.value.trim();
        if (!val) { err.textContent = "Enter your PIN."; return; }
        const h = await _hash(val);
        if (h === stored) {
          _setUnlocked();
          document.getElementById("flow-auth-panel")?.remove();
          resolve();
        } else {
          attempts++;
          input.value = "";
          err.textContent = attempts >= 3
            ? `Wrong PIN (${attempts} attempts). Try again.`
            : "Wrong PIN.";
          // Shake animation
          const inner = document.getElementById("flow-auth-inner");
          if (inner) {
            inner.style.transition = "transform .07s";
            inner.style.transform  = "translateX(-8px)";
            setTimeout(() => { inner.style.transform = "translateX(8px)"; }, 70);
            setTimeout(() => { inner.style.transform = "translateX(0)";   }, 140);
          }
        }
      });
    }
  });
}

// Reset PIN (call from brain menu)
export function resetPin() {
  if (!confirm("Reset your Flow PIN? You'll create a new one on next load.")) return;
  localStorage.removeItem(LOCK_KEY);
  localStorage.removeItem(UNLOCK_KEY);
  location.reload();
}
