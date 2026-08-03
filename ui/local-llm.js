// ═══════════════════════════════════════════
// ui/local-llm.js — NEW, standalone. Lets Joel download a local LLM
// (Gemma 3 4B, GGUF, from Hugging Face directly — NOT GitHub, which
// caps files at 2GB) as an extra offline fallback for when the online
// provider chain (Cerebras/OpenRouter/Groq/NVIDIA/HF) is down.
//
// OFF BY DEFAULT, NEVER AUTO-STARTS: this only ever runs when Joel
// clicks the toggle himself. No download happens on app boot, no
// background auto-trigger anywhere in this file.
//
// SEPARATE, NON-INTERFERING UI: its own small pill + panel, own
// z-index band (9300, below the voice-mode UI at 9400/9500 and the
// chat drawer at 9500/9600), so it can never visually compete with
// anything already built.
// ═══════════════════════════════════════════

const MODEL_URL  = "https://huggingface.co/google/gemma-3-4b-it-GGUF/resolve/main/gemma-3-4b-it-Q4_K_M.gguf";
const MODEL_NAME = "gemma-3-4b-it-Q4_K_M.gguf";

function _injectStyles() {
  if (document.getElementById("local-llm-style")) return;
  const s = document.createElement("style");
  s.id = "local-llm-style";
  s.textContent = `
#local-llm-pill {
  position: fixed; bottom: 32px; right: 78px; z-index: 9300;
  background: rgba(255,255,255,0.09); border: 1px solid rgba(255,255,255,0.2);
  border-radius: 20px; padding: 6px 12px; font-size: 11px; color: rgba(255,255,255,0.7);
  cursor: pointer; backdrop-filter: blur(20px); user-select: none;
}
#local-llm-pill:hover { color: #fff; background: rgba(255,255,255,0.15); }
#local-llm-panel {
  position: fixed; bottom: 70px; right: 78px; z-index: 9300;
  width: 260px; background: rgba(15,10,30,0.98); border: 1px solid rgba(167,139,250,0.4);
  border-radius: 14px; padding: 16px; box-shadow: 0 20px 60px rgba(0,0,0,0.6);
  display: none; box-sizing: border-box;
}
#local-llm-panel.show { display: block; }
#local-llm-title { font-size: 12px; font-weight: 700; color: #d8d4ff; margin-bottom: 6px; }
#local-llm-desc { font-size: 10px; color: rgba(255,255,255,0.5); line-height: 1.5; margin-bottom: 12px; }
#local-llm-progress-wrap { width: 100%; height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden; margin-bottom: 8px; display: none; }
#local-llm-progress-wrap.show { display: block; }
#local-llm-progress-bar { height: 100%; width: 0%; background: #a78bfa; transition: width 0.2s ease; }
#local-llm-status { font-size: 10px; color: rgba(255,255,255,0.6); margin-bottom: 10px; }
#local-llm-toggle-btn {
  width: 100%; background: rgba(74,222,128,0.15); border: 1px solid #4ade80; color: #4ade80;
  padding: 8px; border-radius: 8px; cursor: pointer; font-size: 11px;
}
#local-llm-toggle-btn.stop { background: rgba(248,113,113,0.15); border-color: #f87171; color: #f87171; }
`;
  document.head.appendChild(s);
}

let _downloading = false;

function _buildUI() {
  if (document.getElementById("local-llm-pill")) return;

  const pill = document.createElement("div");
  pill.id = "local-llm-pill";
  pill.textContent = "🧠 Local LLM";
  document.body.appendChild(pill);

  const panel = document.createElement("div");
  panel.id = "local-llm-panel";
  panel.innerHTML = `
    <div id="local-llm-title">Local LLM (offline fallback)</div>
    <div id="local-llm-desc">Downloads Gemma 3 4B directly from Hugging Face (~2.5GB) so Flow has an offline option if all online providers are down. This does NOT start automatically — only when you toggle it on. Uses your mobile data if not on Wi-Fi.</div>
    <div id="local-llm-progress-wrap"><div id="local-llm-progress-bar"></div></div>
    <div id="local-llm-status">Not downloaded.</div>
    <button id="local-llm-toggle-btn">Download &amp; enable</button>
  `;
  document.body.appendChild(panel);

  pill.addEventListener("click", () => panel.classList.toggle("show"));

  const btn = panel.querySelector("#local-llm-toggle-btn");
  const statusEl = panel.querySelector("#local-llm-status");
  const barWrap = panel.querySelector("#local-llm-progress-wrap");
  const bar = panel.querySelector("#local-llm-progress-bar");

  async function refreshStatus() {
    if (!window.__flowElectron?.localLLM) { statusEl.textContent = "Only available in the desktop app."; btn.disabled = true; return; }
    const status = await window.__flowElectron.localLLM.status();
    if (status?.downloaded) {
      statusEl.textContent = status.enabled ? "✅ Downloaded and active." : "✅ Downloaded (currently off).";
      btn.textContent = status.enabled ? "Turn off" : "Turn on";
      btn.classList.toggle("stop", !!status.enabled);
    } else {
      statusEl.textContent = "Not downloaded.";
      btn.textContent = "Download & enable";
      btn.classList.remove("stop");
    }
  }

  btn.addEventListener("click", async () => {
    if (!window.__flowElectron?.localLLM) return;
    const status = await window.__flowElectron.localLLM.status();

    if (status?.downloaded) {
      // Already downloaded — this click just toggles on/off, no re-download.
      const next = !status.enabled;
      await window.__flowElectron.localLLM.setEnabled(next);
      await refreshStatus();
      return;
    }

    if (_downloading) return;
    _downloading = true;
    btn.disabled = true;
    barWrap.classList.add("show");
    statusEl.textContent = "Downloading...";

    window.__flowElectron.localLLM.onProgress?.((pct) => {
      bar.style.width = pct + "%";
      statusEl.textContent = `Downloading... ${pct}%`;
    });

    try {
      await window.__flowElectron.localLLM.download();
      await window.__flowElectron.localLLM.setEnabled(true);
      statusEl.textContent = "✅ Downloaded and active.";
    } catch (e) {
      statusEl.textContent = `❌ Download failed: ${e.message}`;
    } finally {
      _downloading = false;
      btn.disabled = false;
      barWrap.classList.remove("show");
      await refreshStatus();
    }
  });

  refreshStatus();
}

export function initLocalLLMUI() {
  _injectStyles();
  _buildUI();
}
