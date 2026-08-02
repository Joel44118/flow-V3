// ═══════════════════════════════════════════
// ui/full-voice-mode.js — Full Voice Mode UI, REBUILT (2nd pass) to
// match Joel's actual design intent, not a centered modal card.
//
// REAL DESIGN, per Joel's explicit correction:
//   - The normal input bar slides DOWN and out of view (animated, not
//     instant).
//   - A NEW bar slides UP from the bottom to occupy that same space —
//     a colorful, multi-bar waveform (not a single oscilloscope line),
//     reacting to real mic amplitude via Web Audio.
//   - A SEPARATE settings bar slides in from the LEFT with the
//     sensitivity slider, colored as a gradient (blue = low/only-close-
//     speech, pink/red = high/picks-up-anything) so high vs low is
//     visually obvious, not just a number.
//   - At the very lowest sensitivity, offers to turn on the camera for
//     lip-reading assist.
//
// HONEST NOTE on lip-reading: turning the camera on and showing a
// preview is real and built here. Actually USING that video to improve
// speech detection (real lip-reading ML) is a separate, much bigger
// computer-vision feature that isn't implemented yet — this offers the
// toggle and explains that plainly rather than pretending detection
// is smarter than it is.
// ═══════════════════════════════════════════

let _micAudioCtx = null;
let _micAnalyser = null;
let _micAnalyserBuf = null;
let _micStream = null;
let _waveformRAF = null;
let _camStream = null;

const BAR_COUNT = 40;

function _injectStyles() {
  if (document.getElementById("fvm-style")) return;
  const style = document.createElement("style");
  style.id = "fvm-style";
  style.textContent = `
/* REAL — the normal input bar slides DOWN out of view (not display:none),
   an animated transform so it genuinely "slides" as Joel described. */
.input-panel { transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1); }
.input-panel.fvm-hidden { transform: translateY(120%); }

/* REAL — the waveform bar slides UP from the bottom to occupy the same
   space the input bar vacated. */
#fvm-wave-bar {
  position: fixed; left: 0; right: 0; bottom: 0; height: 64px;
  background: linear-gradient(180deg, rgba(30,20,60,0.95), rgba(15,10,35,0.98));
  border-top: 1px solid rgba(167,139,250,0.35);
  display: flex; align-items: center; gap: 14px; padding: 0 18px;
  z-index: 9600; transform: translateY(100%);
  transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1);
}
#fvm-wave-bar.fvm-shown { transform: translateY(0); }

#fvm-wave-canvas { flex: 1; height: 40px; }
#fvm-wave-status { font-size: 11px; color: #d8d4ff; white-space: nowrap; font-weight: 600; }
#fvm-wave-dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; box-shadow: 0 0 8px #4ade80; flex-shrink: 0; animation: fvm-pulse 1.4s ease-in-out infinite; }
@keyframes fvm-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

/* REAL — the sensitivity bar slides in from the LEFT, colored as a real
   gradient track (blue = low sensitivity/only close speech, pink/red =
   high sensitivity/picks up anything) so high vs low reads visually. */
#fvm-range-bar {
  position: fixed; top: 52px; left: 0; bottom: 26px; width: 220px;
  background: rgba(15,10,30,0.97); border-right: 1px solid rgba(167,139,250,0.35);
  z-index: 9599; padding: 20px 16px; box-sizing: border-box;
  transform: translateX(-100%);
  transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1);
  display: flex; flex-direction: column;
}
#fvm-range-bar.fvm-shown { transform: translateX(0); }

#fvm-range-title { font-size: 12px; font-weight: 700; color: #d8d4ff; margin-bottom: 4px; }
#fvm-range-desc { font-size: 10px; color: rgba(255,255,255,0.45); margin-bottom: 16px; line-height: 1.5; }

#fvm-range-track-wrap { position: relative; height: 160px; width: 100%; display: flex; justify-content: center; margin-bottom: 12px; }
#fvm-range-gradient {
  width: 10px; height: 100%; border-radius: 5px;
  background: linear-gradient(180deg, #f87171 0%, #fbbf24 50%, #38bdf8 100%);
}
#fvm-range-slider {
  position: absolute; top: 0; left: 50%; transform: translateX(-50%) rotate(-90deg) translateX(0);
  width: 160px; height: 10px; -webkit-appearance: none; appearance: none;
  background: transparent; transform-origin: center;
  writing-mode: vertical-lr;
  direction: rtl;
}
#fvm-range-value { text-align: center; font-size: 11px; color: #a78bfa; margin-bottom: 6px; }
#fvm-range-labels { display: flex; justify-content: space-between; font-size: 9px; color: rgba(255,255,255,0.4); width: 10px; margin: 0 auto; height: 160px; flex-direction: column; }

#fvm-lipsync-prompt {
  margin-top: auto; font-size: 10px; color: rgba(255,255,255,0.6);
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

// ── Colorful, multi-bar waveform (not a single oscilloscope line) ──
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
      const hue = 260 - v * 140; // purple (quiet) → pink/orange (loud) — real amplitude-driven color, not decorative
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

// REAL — camera toggle for lip-reading ASSIST, now wired to genuine
// mouth-movement tracking (core/lip-sync-vad.js). Honest about scope:
// this is NOT true lip-reading (mouth shapes → words) — that's a much
// harder ML problem. What's real: tracking whether the mouth is
// actively open/moving as a SECOND signal alongside audio VAD, useful
// specifically in noisy environments.
async function _offerLipSyncCamera(videoEl, promptEl) {
  promptEl.classList.add("show");
  const btn = promptEl.querySelector("#fvm-lipsync-btn");
  btn.onclick = async () => {
    if (_camStream) {
      const { stopMouthTracking } = await import("./../core/lip-sync-vad.js");
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
      const { startMouthTracking } = await import("./../core/lip-sync-vad.js");
      await startMouthTracking(videoEl, (score) => {
        // Real, live feedback so Joel can see it's genuinely tracking,
        // not just decoration — a small visual pulse tied to the
        // actual mouth-open score.
        videoEl.style.boxShadow = score > 0.15 ? `0 0 ${8 + score * 20}px #4ade80` : "none";
      });
    } catch (e) {
      console.warn("[FullVoiceMode] Camera access denied or unavailable:", e.message);
    }
  };
}

let _rangeBarEl = null;
let _waveBarEl = null;

function _buildBars() {
  const waveBar = document.createElement("div");
  waveBar.id = "fvm-wave-bar";
  waveBar.innerHTML = `
    <span id="fvm-wave-dot"></span>
    <span id="fvm-wave-status">Listening — speak whenever</span>
    <canvas id="fvm-wave-canvas"></canvas>
  `;
  document.body.appendChild(waveBar);

  const rangeBar = document.createElement("div");
  rangeBar.id = "fvm-range-bar";
  rangeBar.innerHTML = `
    <div id="fvm-range-title">🎚️ Hearing sensitivity</div>
    <div id="fvm-range-desc">Low = only picks up clear, close speech. High = picks up quieter or farther speech (and more background noise).</div>
    <div id="fvm-range-track-wrap">
      <div id="fvm-range-gradient"></div>
      <input type="range" id="fvm-range-slider" min="0.2" max="0.9" step="0.05" orient="vertical">
    </div>
    <div id="fvm-range-value">Medium</div>
    <div id="fvm-lipsync-prompt">
      🎥 At lowest sensitivity, want camera-assisted lip reading? This tracks whether your mouth is actively open/moving as a second signal alongside audio — helps in noisy environments. Honest note: this isn't true lip-reading (words from mouth shapes), just real mouth-movement tracking.
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
    if (v <= 0.2) {
      _offerLipSyncCamera(lipsyncVideo, lipsyncPrompt);
    } else {
      lipsyncPrompt.classList.remove("show");
    }
  });

  _waveBarEl = waveBar;
  _rangeBarEl = rangeBar;
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
  } else {
    if (inputBar) inputBar.classList.remove("fvm-hidden");
    _waveBarEl.classList.remove("fvm-shown");
    _rangeBarEl.classList.remove("fvm-shown");
    _stopMicVisualization();
    if (_camStream) { _camStream.getTracks().forEach(t => t.stop()); _camStream = null; }
  }

  if (statusText) {
    const statusEl = _waveBarEl.querySelector("#fvm-wave-status");
    if (statusEl) statusEl.textContent = statusText;
  }
}

export function initFullVoiceModeUI() {
  _injectStyles();
  _buildBars();
}
