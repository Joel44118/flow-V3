// ═══════════════════════════════════════════
// ui/gesture.js — Hand Gesture Screen Control
//
// Uses MediaPipe Hands (CDN) on the camera feed.
// Runs entirely in the browser — no server calls.
//
// GESTURE MAP:
//   1 finger (index up)      → move cursor
//   2 fingers (index+middle) → scroll
//   3 fingers                → click
//   fist / 0 fingers         → pause / idle
//
// Works by sending commands through the same
// chrome.runtime.sendMessage bridge as screencontrol.js
// — so the extension must be installed.
//
// CURSOR MOVEMENT:
//   The extension injects a floating dot cursor
//   onto the target tab that mirrors your index
//   fingertip position (mapped from camera space
//   to screen space). When you switch to 3 fingers
//   the cursor position is clicked. This means you
//   never have to leave the target tab to control it.
//
// SCROLL:
//   2-finger vertical movement → scroll up/down
//   Speed scales with how fast you move your hand.
// ═══════════════════════════════════════════

// MediaPipe Hands is loaded lazily from CDN on first gesture.start()
// so it doesn't impact Flow's initial load time at all.
const MP_HANDS_URL  = "https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/hands.js";
const MP_CAMERA_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils@0.3.1675466862/camera_utils.js";
const MP_DRAW_URL   = "https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils@0.3.1675466124/drawing_utils.js";

let _chat    = null;
let _orb     = null;
let _running = false;
let _hands   = null;
let _mpCam   = null;
let _videoEl = null;
let _canvas  = null;
let _ctx     = null;
let _overlay = null;

// Smoothing — raw landmark coordinates are jittery; we EWA-smooth them
let _smoothX = 0.5, _smoothY = 0.5;
const SMOOTH  = 0.35; // lower = smoother but laggier

// Scroll state
let _prevScrollY  = null;
let _scrollCooldown = 0;

// Click state — debounce so one "3 fingers" doesn't fire 30 clicks
let _clickCooldown = 0;
let _lastGesture   = "";
let _gestureFrames = 0; // how many consecutive frames the same gesture held

export function initGesture(chat, orb) {
  _chat = chat;
  _orb  = orb;
}

// ── Public API ────────────────────────────────────────────────────────────
export const Gesture = {

  async start(videoEl) {
    if (_running) { this.stop(); return; }

    if (!videoEl) {
      _chat?.addError("Gesture control needs the camera. Say 'open camera' first, then 'start gesture control'.");
      return;
    }

    _videoEl = videoEl;
    _chat?.add(
      "🖐 Gesture control starting...\n\n" +
      "**1 finger** → move cursor on target tab\n" +
      "**2 fingers** → scroll (move hand up/down)\n" +
      "**3 fingers** → click at cursor position\n" +
      "**Fist** → pause\n\n" +
      "Make sure the Flow extension is installed and you have another tab open.",
      "bot"
    );

    await _loadMediaPipe();
    _setupCanvas();
    _initHands();
    _running = true;
  },

  stop() {
    _running = false;
    _mpCam?.stop();
    _mpCam  = null;
    _hands  = null;
    _overlay?.remove();
    _overlay = null;
    _canvas?.remove();
    _canvas = null;
    _ctx    = null;
    _chat?.add("Gesture control stopped.", "bot");
  },

  isRunning() { return _running; },
};

// ── Load MediaPipe scripts lazily ─────────────────────────────────────────
function _loadMediaPipe() {
  return new Promise((resolve, reject) => {
    if (window.Hands) { resolve(); return; }

    const scripts = [MP_HANDS_URL, MP_DRAW_URL, MP_CAMERA_URL];
    let loaded = 0;

    scripts.forEach(src => {
      const s = document.createElement("script");
      s.src = src;
      s.onload  = () => { if (++loaded === scripts.length) resolve(); };
      s.onerror = () => reject(new Error("Failed to load MediaPipe from CDN"));
      document.head.appendChild(s);
    });
  });
}

// ── Canvas overlay on top of the camera feed ─────────────────────────────
function _setupCanvas() {
  // Find the camera container Flow already rendered
  const camContainer = document.querySelector(".flow-cam-container, #cam-container, .cam-wrap")
    || _videoEl?.parentElement;

  if (!camContainer) return;

  _canvas = document.createElement("canvas");
  _canvas.width  = 320;
  _canvas.height = 240;
  _canvas.style.cssText = [
    "position:absolute", "top:0", "left:0",
    "width:100%", "height:100%",
    "pointer-events:none", "z-index:10",
    "border-radius:inherit",
  ].join(";");

  camContainer.style.position = "relative";
  camContainer.appendChild(_canvas);
  _ctx = _canvas.getContext("2d");
}

// ── Init MediaPipe Hands ──────────────────────────────────────────────────
function _initHands() {
  if (!window.Hands) {
    _chat?.addError("MediaPipe failed to load. Check your internet connection.");
    return;
  }

  _hands = new window.Hands({
    locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${f}`
  });

  _hands.setOptions({
    maxNumHands:      1,
    modelComplexity:  0,   // 0 = lite, fastest
    minDetectionConfidence: 0.75,
    minTrackingConfidence:  0.6,
  });

  _hands.onResults(_onResults);

  if (window.Camera) {
    _mpCam = new window.Camera(_videoEl, {
      onFrame: async () => {
        if (!_running) return;
        await _hands.send({ image: _videoEl });
      },
      width: 320, height: 240,
    });
    _mpCam.start();
    _chat?.add("✅ Gesture control active. Show your hand to the camera.", "bot");
  } else {
    _chat?.addError("MediaPipe Camera utils didn't load. Try refreshing.");
  }
}

// ── Process each frame result ─────────────────────────────────────────────
function _onResults(results) {
  if (!_ctx || !_running) return;

  _ctx.clearRect(0, 0, 320, 240);

  if (!results.multiHandLandmarks?.length) {
    _lastGesture   = "";
    _gestureFrames = 0;
    _prevScrollY   = null;
    return;
  }

  const lm      = results.multiHandLandmarks[0];
  const fingers = _countFingers(lm);
  const gesture = `${fingers}f`;

  // Draw skeleton on canvas
  if (window.drawConnectors && window.HAND_CONNECTIONS) {
    _ctx.save();
    _ctx.scale(-1, 1);
    _ctx.translate(-320, 0);
    window.drawConnectors(_ctx, lm, window.HAND_CONNECTIONS, { color: "rgba(56,189,248,0.6)", lineWidth: 1.5 });
    window.drawLandmarks(_ctx, lm, { color: "#38bdf8", lineWidth: 1, radius: 2 });
    _ctx.restore();
  }

  // Track gesture consistency — require N frames to avoid flickering
  if (gesture === _lastGesture) {
    _gestureFrames++;
  } else {
    _lastGesture   = gesture;
    _gestureFrames = 1;
  }

  // Index fingertip (landmark 8) — mirrored X for natural feel
  const tipX = 1 - lm[8].x; // mirror horizontally
  const tipY = lm[8].y;

  // EWA smooth
  _smoothX += (tipX - _smoothX) * SMOOTH;
  _smoothY += (tipY - _smoothY) * SMOOTH;

  // Draw fingertip dot
  _ctx.beginPath();
  _ctx.arc(_smoothX * 320, _smoothY * 240, 6, 0, Math.PI * 2);
  _ctx.fillStyle   = fingers === 3 ? "#34d399" : fingers === 2 ? "#f59e0b" : "#38bdf8";
  _ctx.strokeStyle = "white";
  _ctx.lineWidth   = 2;
  _ctx.fill();
  _ctx.stroke();

  // Draw gesture label
  const label = fingers === 1 ? "MOVE" : fingers === 2 ? "SCROLL" : fingers === 3 ? "CLICK" : "PAUSE";
  _ctx.fillStyle = "rgba(2,6,23,0.75)";
  _ctx.fillRect(4, 4, 72, 20);
  _ctx.fillStyle = "#38bdf8";
  _ctx.font      = "bold 11px monospace";
  _ctx.fillText(`✋ ${label}`, 8, 18);

  // Tick cooldowns
  if (_scrollCooldown > 0) _scrollCooldown--;
  if (_clickCooldown  > 0) _clickCooldown--;

  // Only act after the gesture has been held for a few frames (reduces noise)
  if (_gestureFrames < 3) return;

  _dispatchGesture(fingers, _smoothX, _smoothY);
}

// ── Map finger count → action ─────────────────────────────────────────────
function _dispatchGesture(fingers, x, y) {
  if (fingers === 1) {
    // Move the injected cursor on the target tab
    _sendToExtension("cursor_move", { x, y });
    return;
  }

  if (fingers === 2 && _scrollCooldown === 0) {
    // Scroll based on Y position relative to screen centre
    // Above centre → scroll up, below → scroll down
    const dy     = y - 0.5;          // -0.5 to +0.5
    const speed  = Math.abs(dy);
    if (speed < 0.08) return;        // dead zone — don't scroll when hand is level

    const amount    = Math.round(speed * 800);
    const direction = dy > 0 ? "down" : "up";
    _sendToExtension("scroll", { direction, amount });
    _prevScrollY    = y;
    _scrollCooldown = 4; // ~4 frames ≈ 130ms at 30fps
    return;
  }

  if (fingers === 3 && _clickCooldown === 0) {
    // Click at current cursor position
    _sendToExtension("gesture_click", { x, y });
    _clickCooldown = 20; // ~650ms debounce — prevents double-click on one gesture
    return;
  }
}

// ── Send to extension background → target tab ────────────────────────────
function _sendToExtension(action, payload) {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
  chrome.runtime.sendMessage({
    source:  "flow-control-bg",
    action,
    payload,
  }).catch(() => {});
}

// ── Count extended fingers ────────────────────────────────────────────────
// Uses landmark tip vs PIP joint heights — works reliably for most hand poses.
// Thumb uses X-axis (it extends sideways, not vertically).
function _countFingers(lm) {
  // Fingertip landmark indices: thumb=4, index=8, middle=12, ring=16, pinky=20
  // PIP (middle knuckle) indices:        thumb=3, index=6,  middle=10, ring=14, pinky=18
  const tips = [4, 8, 12, 16, 20];
  const pips = [3, 6, 10, 14, 18];

  let count = 0;

  // Thumb: extended if tip X is further from palm than knuckle
  // (for right hand: tip.x < pip.x means extended left/outward)
  const thumbExtended = Math.abs(lm[4].x - lm[3].x) > 0.05;
  if (thumbExtended) count++;

  // Other four fingers: extended if tip Y is above (smaller Y) than PIP joint
  for (let i = 1; i < 5; i++) {
    if (lm[tips[i]].y < lm[pips[i]].y - 0.02) count++;
  }

  return count;
}
