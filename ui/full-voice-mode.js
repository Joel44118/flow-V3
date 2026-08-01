// ═══════════════════════════════════════════
// ui/full-voice-mode.js — REAL, NEW: Full Voice Mode's UI overhaul.
//
// Shows/hides based on the SAME handsFreeVoiceEnabled state that
// core/hands-free-vad.js already controls — this file only owns the
// VISUALS (waveform, hearing-sensitivity control, hiding the input
// box), not the listening logic itself.
//
// REAL, HONEST NOTE on "hearing range... sync with only my lips" — true
// lip-sync would need visual lip-reading via camera, a different
// feature entirely. What's real and built here instead: a sensitivity
// slider on the VAD's actual speech-detection threshold
// (positiveSpeechThreshold) — turning it up means only clearly louder/
// closer speech triggers listening, which is the real, audio-domain
// equivalent of "only pick up what's close to me."
// ═══════════════════════════════════════════

let _overlayEl = null;
let _micAudioCtx = null;
let _micAnalyser = null;
let _micAnalyserBuf = null;
let _micStream = null;
let _waveformRAF = null;
let _sensitivity = 0.5; // maps to VAD's positiveSpeechThreshold

function _injectStyles() {
  if (document.getElementById("fvm-style")) return;
  const style = document.createElement("style");
  style.id = "fvm-style";
  style.textContent = `
#fvm-overlay {
  position: fixed; top: 52px; left: 0; right: 0; bottom: 26px;
  z-index: 9700; display: none; flex-direction: column; align-items: center; justify-content: center;
  background: rgba(8,5,18,0.55); backdrop-filter: blur(2px);
  pointer-events: none;
}
#fvm-overlay.fvm-active { display: flex; }

#fvm-waveform-card {
  width: min(520px, 80vw); background: rgba(15,10,30,0.9);
  border: 1px solid rgba(167,139,250,0.4); border-radius: 16px;
  padding: 20px 24px; pointer-events: all;
  box-shadow: 0 12px 40px rgba(0,0,0,0.5);
}
#fvm-title { font-size: 13px; font-weight: 700; color: #d8d4ff; margin-bottom: 4px; display: flex; align-items: center; gap: 8px; }
#fvm-title .fvm-dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; box-shadow: 0 0 8px #4ade80; }
#fvm-status-text { font-size: 11px; color: rgba(255,255,255,0.5); margin-bottom: 14px; }

#fvm-canvas { width: 100%; height: 70px; display: block; border-radius: 8px; }

#fvm-sensitivity-row { margin-top: 16px; display: flex; align-items: center; gap: 10px; }
#fvm-sensitivity-row label { font-size: 11px; color: rgba(255,255,255,0.6); white-space: nowrap; }
#fvm-sensitivity-slider { flex: 1; accent-color: #a78bfa; }
#fvm-sensitivity-value { font-size: 11px; color: #a78bfa; width: 32px; text-align: right; }

#fvm-hint { font-size: 10px; color: rgba(255,255,255,0.35); margin-top: 10px; line-height: 1.5; font-style: italic; }
`;
  document.head.appendChild(style);
}

function _drawWaveform(canvas) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width = canvas.clientWidth * devicePixelRatio;
  const H = canvas.height = canvas.clientHeight * devicePixelRatio;

  function draw() {
    _waveformRAF = requestAnimationFrame(draw);
    ctx.clearRect(0, 0, W, H);
    if (!_micAnalyser) return;

    _micAnalyser.getByteTimeDomainData(_micAnalyserBuf);
    ctx.beginPath();
    ctx.strokeStyle = "#a78bfa";
    ctx.lineWidth = 2 * devicePixelRatio;
    const sliceWidth = W / _micAnalyserBuf.length;
    let x = 0;
    for (let i = 0; i < _micAnalyserBuf.length; i++) {
      const v = _micAnalyserBuf[i] / 128.0;
      const y = (v * H) / 2;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      x += sliceWidth;
    }
    ctx.stroke();
  }
  draw();
}

async function _startMicVisualization() {
  try {
    _micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    _micAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = _micAudioCtx.createMediaStreamSource(_micStream);
    _micAnalyser = _micAudioCtx.createAnalyser();
    _micAnalyser.fftSize = 512;
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
  _sensitivity = v;
  _saveSensitivity(v);
  try {
    const { setVadSensitivity } = await import("../core/hands-free-vad.js");
    setVadSensitivity?.(v);
  } catch (e) {
    console.warn("[FullVoiceMode] Couldn't apply sensitivity to VAD:", e.message);
  }
}

function _buildOverlay() {
  const overlay = document.createElement("div");
  overlay.id = "fvm-overlay";

  const card = document.createElement("div");
  card.id = "fvm-waveform-card";

  const title = document.createElement("div");
  title.id = "fvm-title";
  title.innerHTML = `<span class="fvm-dot"></span> Full Voice Mode`;
  card.appendChild(title);

  const status = document.createElement("div");
  status.id = "fvm-status-text";
  status.textContent = "Listening — no hotkey needed. Speak whenever.";
  card.appendChild(status);

  const canvas = document.createElement("canvas");
  canvas.id = "fvm-canvas";
  card.appendChild(canvas);

  const sensRow = document.createElement("div");
  sensRow.id = "fvm-sensitivity-row";
  const label = document.createElement("label");
  label.textContent = "Sensitivity";
  const slider = document.createElement("input");
  slider.type = "range"; slider.id = "fvm-sensitivity-slider";
  slider.min = "0.2"; slider.max = "0.9"; slider.step = "0.05";
  slider.value = String(_loadSensitivity());
  const valueLabel = document.createElement("span");
  valueLabel.id = "fvm-sensitivity-value";
  valueLabel.textContent = slider.value;
  slider.addEventListener("input", () => {
    valueLabel.textContent = slider.value;
    _applySensitivity(parseFloat(slider.value));
  });
  sensRow.appendChild(label);
  sensRow.appendChild(slider);
  sensRow.appendChild(valueLabel);
  card.appendChild(sensRow);

  const hint = document.createElement("div");
  hint.id = "fvm-hint";
  hint.textContent = "Higher sensitivity picks up quieter/farther speech (and more background noise); lower sensitivity only reacts to clear, close speech.";
  card.appendChild(hint);

  overlay.appendChild(card);
  document.body.appendChild(overlay);
  return overlay;
}

export function setFullVoiceModeUIState(active, statusText) {
  if (!_overlayEl) { _injectStyles(); _overlayEl = _buildOverlay(); }

  const inputBar = document.querySelector(".input-panel");

  if (active) {
    _overlayEl.classList.add("fvm-active");
    if (inputBar) inputBar.style.display = "none";
    if (!_micAnalyser) _startMicVisualization();
    _drawWaveform(_overlayEl.querySelector("#fvm-canvas"));
    _applySensitivity(_loadSensitivity());
  } else {
    _overlayEl.classList.remove("fvm-active");
    if (inputBar) inputBar.style.display = "";
    _stopMicVisualization();
  }

  if (statusText) {
    const statusEl = _overlayEl.querySelector("#fvm-status-text");
    if (statusEl) statusEl.textContent = statusText;
  }
}

export function initFullVoiceModeUI() {
  _injectStyles();
  _overlayEl = _buildOverlay();
}
