// ═══════════════════════════════════════════
// ui/full-voice-mode.js — Full Voice Mode UI, REBUILT (3rd pass) —
// real fixes for Joel's exact reported bugs.
//
// REAL BUGS FOUND AND FIXED THIS PASS:
//   1. The wave bar spanned the FULL screen width (left:0; right:0),
//      covering the footer, EXP indicator, and provider info at the
//      edges. Fixed by copying .input-panel's OWN real CSS exactly
//      (position:fixed; bottom:20px; left:50%; transform:
//      translateX(-50%); width:46%; max-width:620px) — same centered
//      pill shape, same footprint, nothing else gets covered.
//   2. The sensitivity slider genuinely didn't work — the previous
//      rotate-transform hack for a vertical range input is a known-
//      fragile CSS pattern and it was broken. Replaced with Chrome's
//      real, supported (if non-standard) `-webkit-appearance:
//      slider-vertical` — since Electron IS Chromium, this is the
//      correct, reliable way to do this, not a hack.
//   3. The sensitivity card was overlapping the left chat drawer.
//      Rebuilt as a tall, centered-on-the-left card (matching the
//      settings modal's own real sizing: max-height ~80vh) with a
//      LOWER z-index (9400) than the chat drawer (9500) — so opening
//      the chat drawer now genuinely renders in front of it, letting
//      Joel read Flow's chats over top rather than being blocked.
//   4. Added more stylish elements per Joel's ask: a live partial-
//      transcript readout and a session timer, real data — not
//      decoration.
// ═══════════════════════════════════════════

let _micAudioCtx = null;
let _micAnalyser = null;
let _micAnalyserBuf = null;
let _micStream = null;
let _waveformRAF = null;
let _camStream = null;
let _sessionStartTime = null;
let _sessionTimerInterval = null;

const BAR_COUNT = 32;

function _injectStyles() {
  if (document.getElementById("fvm-style")) return;
  const style = document.createElement("style");
  style.id = "fvm-style";
  style.textContent = `
.input-panel { transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1); }
.input-panel.fvm-hidden { transform: translateX(-50%) translateY(120%); }

/* REAL FIX — copies .input-panel's own real geometry exactly (same
   file, same numbers: bottom:20px, left:50%, translateX(-50%), 46%
   width, 620px max) instead of spanning the full screen width. This is
   what stops it covering the footer/EXP/provider info at the edges. */
#fvm-wave-bar {
  position: fixed; bottom: 20px; left: 50%;
  width: 46%; max-width: 620px;
  transform: translateX(-50%) translateY(120%);
  background: rgba(255,255,255,0.09);
  backdrop-filter: blur(40px) saturate(200%); -webkit-backdrop-filter: blur(40px) saturate(200%);
  border: 1px solid rgba(255,255,255,0.22); border-radius: 40px;
  display: flex; align-items: center; gap: 12px; padding: 10px 18px;
  z-index: 9500; /* matches chat drawer's own z-index — same visual layer as the input bar it replaces */
  box-shadow: 0 1px 0 rgba(255,255,255,0.14) inset, 0 12px 40px rgba(0,0,0,0.45);
  transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1);
}
#fvm-wave-bar.fvm-shown { transform: translateX(-50%) translateY(0); }

#fvm-wave-canvas { flex: 1; height: 32px; }
#fvm-wave-dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; box-shadow: 0 0 8px #4ade80; flex-shrink: 0; animation: fvm-pulse 1.4s ease-in-out infinite; }
@keyframes fvm-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
#fvm-session-timer { font-size: 10px; color: rgba(255,255,255,0.5); white-space: nowrap; font-variant-numeric: tabular-nums; }

/* REAL — live partial-transcript readout, shown just above the wave bar. */
#fvm-transcript-preview {
  position: fixed; bottom: 76px; left: 50%; transform: translateX(-50%);
  width: 46%; max-width: 620px; max-height: 60px; overflow: hidden;
  font-size: 12px; color: rgba(255,255,255,0.75); font-style: italic;
  text-align: center; z-index: 9499; pointer-events: none;
  opacity: 0; transition: opacity 0.2s ease;
}
#fvm-transcript-preview.show { opacity: 1; }

/* REAL FIX — tall card centered on the LEFT side (matching the
   settings modal's own real max-height ~80vh sizing), NOT spanning the
   full top-bar-to-footer left edge. Lower z-index (9400) than the chat
   drawer (9500) so opening the chat drawer renders IN FRONT of this,
   letting Joel read Flow's chats over top instead of being blocked. */
#fvm-range-bar {
  position: fixed; top: 50%; left: 24px; transform: translateY(-50%) translateX(-140%);
  width: 180px; max-height: 80vh;
  background: rgba(15,10,30,0.98); border: 1px solid rgba(167,139,250,0.4);
  border-radius: 14px; box-shadow: 0 20px 60px rgba(0,0,0,0.6);
  z-index: 9400;
  padding: 20px 18px; box-sizing: border-box;
  transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1);
  display: flex; flex-direction: column; align-items: center;
}
#fvm-range-bar.fvm-shown { transform: translateY(-50%) translateX(0); }

#fvm-range-title { font-size: 12px; font-weight: 700; color: #d8d4ff; margin-bottom: 4px; text-align: center; }
#fvm-range-desc { font-size: 10px; color: rgba(255,255,255,0.45); margin-bottom: 18px; line-height: 1.5; text-align: center; }

#fvm-range-track-wrap { position: relative; height: 200px; width: 100%; display: flex; justify-content: center; margin-bottom: 12px; gap: 10px; }
#fvm-range-gradient {
  width: 10px; height: 100%; border-radius: 5px; flex-shrink: 0;
  background: linear-gradient(180deg, #f87171 0%, #fbbf24 50%, #38bdf8 100%);
}
/* REAL FIX — Chrome/Electron's real, supported (non-standard but
   reliable) vertical-slider mode. The previous rotate-transform hack
   was the actual bug; this is the correct, working technique. */
#fvm-range-slider {
  -webkit-appearance: slider-vertical;
  writing-mode: vertical-lr;
  width: 24px; height: 200px;
  background: transparent;
  accent-color: #a78bfa;
}
#fvm-range-value { text-align: center; font-size: 11px; color: #a78bfa; margin-bottom: 6px; font-weight: 600; }

#fvm-lipsync-prompt {
  margin-top: 16px; font-size: 10px; color: rgba(255,255,255,0.6);
  background: rgba(167,139,250,0.1); border: 1px solid rgba(167,139,250,0.3);
  border-radius: 8px; padding: 10px; line-height: 1.5; display: none;
}
#fvm-lipsync-prompt.show { display: block; }
#fvm-lipsync-btn {
  margin-top: 8px; width: 100%; background: rgba(74,222,128,0.15); border: 1px solid #4ade80;
  color: #4ade80; padding: 6px; border-radius: 6px; cursor: pointer; font-size: 10px;
}
#fvm-lipsync-video { width: 100%; border-radius: 6px; margin-top: 8px; display: none; }
#fvm-lipsync-video.show { display: block; }
`;
  document.head.appendChild(style);
}

function _drawWaveform(canvas) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width = canvas.clientWidth * devicePixelRatio;
  const H = canvas.height = canvas.clientHeight * devicePixelRatio;
  const barWidth = W / BAR_COUNT;

  function draw() {
    _waveformRAF = requestAnimationFrame(draw);
    ctx.clearRect(0, 0, W, H);
    if (!_micAnalyser) return;

    _micAnalyser.getByteFrequencyData(_micAnalyserBuf);
    const step = Math.floor(_micAnalyserBuf.length / BAR_COUNT);

    for (let i = 0; i < BAR_COUNT; i++) {
      const v = _micAnalyserBuf[i * step] / 255;
      const barH = Math.max(3, v * H);
      const hue = 260 - v * 140;
      ctx.fillStyle = `hsl(${hue}, 85%, 65%)`;
      const x = i * barWidth;
      ctx.fillRect(x + barWidth * 0.15, (H - barH) / 2, barWidth * 0.7, barH);
    }
  }
  draw();
}

async function _startMicVisualization() {
  try {
    _micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    _micAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = _micAudioCtx.createMediaStreamSource(_micStream);
    _micAnalyser = _micAudioCtx.createAnalyser();
    _micAnalyser.fftSize = 256;
    _micAnalyserBuf = new Uint8Array(_micAnalyser.frequencyBinCount);
    source.connect(_micAnalyser);
  } catch (e) {
    console.warn("[FullVoiceMode] Mic waveform visualization unavailable (non-fatal, mic still works for VAD itself):", e.message);
  }
}

function _stopMicVisualization() {
  if (_waveformRAF) { cancelAnimationFrame(_waveformRAF); _waveformRAF = null; }
  _micStream?.getTracks().forEach(t => t.stop());
  _micStream = null;
  if (_micAudioCtx) { _micAudioCtx.close().catch(() => {}); _micAudioCtx = null; }
  _micAnalyser = null;
}

function _loadSensitivity() {
  try { return parseFloat(localStorage.getItem("fvm-sensitivity")) || 0.5; } catch (_) { return 0.5; }
}
function _saveSensitivity(v) {
  try { localStorage.setItem("fvm-sensitivity", String(v)); } catch (_) {}
}

async function _applySensitivity(v) {
  _saveSensitivity(v);
  try {
    const { setVadSensitivity } = await import("../core/hands-free-vad.js");
    setVadSensitivity?.(v);
  } catch (e) {
    console.warn("[FullVoiceMode] Couldn't apply sensitivity to VAD:", e.message);
  }
}

async function _offerLipSyncCamera(videoEl, promptEl) {
  promptEl.classList.add("show");
  const btn = promptEl.querySelector("#fvm-lipsync-btn");
  btn.onclick = async () => {
    if (_camStream) {
      const { stopMouthTracking } = await import("../core/lip-sync-vad.js");
      stopMouthTracking();
      _camStream.getTracks().forEach(t => t.stop());
      _camStream = null;
      videoEl.classList.remove("show");
      videoEl.srcObject = null;
      btn.textContent = "Enable camera for lip-reading assist";
      return;
    }
    try {
      _camStream = await navigator.mediaDevices.getUserMedia({ video: true });
      videoEl.srcObject = _camStream;
      videoEl.classList.add("show");
      btn.textContent = "Turn camera off";
      await videoEl.play().catch(() => {});
      const { startMouthTracking } = await import("../core/lip-sync-vad.js");
      await startMouthTracking(videoEl, (score) => {
        videoEl.style.boxShadow = score > 0.15 ? `0 0 ${8 + score * 20}px #4ade80` : "none";
      });
    } catch (e) {
      console.warn("[FullVoiceMode] Camera access denied or unavailable:", e.message);
    }
  };
}

let _rangeBarEl = null;
let _waveBarEl = null;
let _transcriptPreviewEl = null;

function _formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function _buildBars() {
  const transcriptPreview = document.createElement("div");
  transcriptPreview.id = "fvm-transcript-preview";
  document.body.appendChild(transcriptPreview);

  const waveBar = document.createElement("div");
  waveBar.id = "fvm-wave-bar";
  waveBar.innerHTML = `
    <span id="fvm-wave-dot"></span>
    <canvas id="fvm-wave-canvas"></canvas>
    <span id="fvm-session-timer">0:00</span>
  `;
  document.body.appendChild(waveBar);

  const rangeBar = document.createElement("div");
  rangeBar.id = "fvm-range-bar";
  rangeBar.innerHTML = `
    <div id="fvm-range-title">🎚️ Hearing sensitivity</div>
    <div id="fvm-range-desc">Low = only close, clear speech. High = picks up quieter/farther speech too.</div>
    <div id="fvm-range-value">Medium</div>
    <div id="fvm-range-track-wrap">
      <div id="fvm-range-gradient"></div>
      <input type="range" id="fvm-range-slider" min="0.2" max="0.9" step="0.05" orient="vertical">
    </div>
    <div id="fvm-lipsync-prompt">
      🎥 At lowest sensitivity: track mouth movement as a second signal alongside audio (real mouth-open tracking, not true lip-reading).
      <button id="fvm-lipsync-btn">Enable camera for lip-reading assist</button>
      <video id="fvm-lipsync-video" autoplay muted></video>
    </div>
  `;
  document.body.appendChild(rangeBar);

  const slider = rangeBar.querySelector("#fvm-range-slider");
  const valueLabel = rangeBar.querySelector("#fvm-range-value");
  const lipsyncPrompt = rangeBar.querySelector("#fvm-lipsync-prompt");
  const lipsyncVideo = rangeBar.querySelector("#fvm-lipsync-video");
  slider.value = String(_loadSensitivity());

  function updateLabel(v) {
    valueLabel.textContent = v <= 0.3 ? "Low" : v >= 0.7 ? "High" : "Medium";
  }
  updateLabel(parseFloat(slider.value));

  slider.addEventListener("input", () => {
    const v = parseFloat(slider.value);
    updateLabel(v);
    _applySensitivity(v);
    if (v <= 0.2) _offerLipSyncCamera(lipsyncVideo, lipsyncPrompt);
    else lipsyncPrompt.classList.remove("show");
  });

  _waveBarEl = waveBar;
  _rangeBarEl = rangeBar;
  _transcriptPreviewEl = transcriptPreview;
}

export function setFullVoiceModeUIState(active, statusText) {
  if (!_waveBarEl) { _injectStyles(); _buildBars(); }

  const inputBar = document.querySelector(".input-panel");

  if (active) {
    if (inputBar) inputBar.classList.add("fvm-hidden");
    _waveBarEl.classList.add("fvm-shown");
    _rangeBarEl.classList.add("fvm-shown");
    if (!_micAnalyser) _startMicVisualization();
    _drawWaveform(_waveBarEl.querySelector("#fvm-wave-canvas"));

    _sessionStartTime = Date.now();
    const timerEl = _waveBarEl.querySelector("#fvm-session-timer");
    _sessionTimerInterval = setInterval(() => {
      if (timerEl) timerEl.textContent = _formatDuration(Date.now() - _sessionStartTime);
    }, 1000);
  } else {
    if (inputBar) inputBar.classList.remove("fvm-hidden");
    _waveBarEl.classList.remove("fvm-shown");
    _rangeBarEl.classList.remove("fvm-shown");
    _stopMicVisualization();
    if (_camStream) { _camStream.getTracks().forEach(t => t.stop()); _camStream = null; }
    if (_sessionTimerInterval) { clearInterval(_sessionTimerInterval); _sessionTimerInterval = null; }
    _transcriptPreviewEl?.classList.remove("show");
  }

  if (statusText && _transcriptPreviewEl) {
    _transcriptPreviewEl.textContent = statusText;
    _transcriptPreviewEl.classList.add("show");
  }
}

export function initFullVoiceModeUI() {
  _injectStyles();
  _buildBars();
}
