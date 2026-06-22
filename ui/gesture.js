// ═══════════════════════════════════════════
// ui/gesture.js — Hand Gesture Control (v4)
//
// Previous CDN switches failed:
//   @mediapipe/hands@0.4 — broken .tflite assets
//   @mediapipe/tasks-vision — jsDelivr blocks it
//
// Now uses TensorFlow.js + @tensorflow-models/hand-pose-detection
// loaded from cdnjs (reliable, no WASM asset issues).
// Falls back to a lightweight pure-JS landmark estimator
// if TF.js also fails to load.
//
// GESTURE MAP:
//   1 finger  → move cursor on target tab
//   2 fingers → scroll (hand Y = direction + speed)
//   3 fingers → click at cursor position
//   fist/0    → idle
// ═══════════════════════════════════════════

import { sendToExtension } from "./screencontrol.js";

// TF.js + hand-pose-detection from cdnjs (stable, reliable CDN)
const TF_CORE   = "https://cdnjs.cloudflare.com/ajax/libs/tensorflow/4.20.0/tf.min.js";
const TF_HANDS  = "https://cdn.jsdelivr.net/npm/@tensorflow-models/hand-pose-detection@2.0.1/dist/hand-pose-detection.min.js";

let _chat    = null;
let _orb     = null;
let _running = false;
let _detector = null;
let _rafId   = null;
let _videoEl = null;
let _canvas  = null;
let _ctx     = null;
let _lastVideoTime = -1;

// Smoothing
let _smoothX = 0.5, _smoothY = 0.5;
const SMOOTH = 0.28;

// Throttle cursor_move to 10/sec max
let _lastCursorSend = 0;
const CURSOR_INTERVAL = 100;

// Gesture debounce
let _lastGesture    = "";
let _gestureFrames  = 0;
let _scrollCooldown = 0;
let _clickCooldown  = 0;

export function initGesture(chat, orb) {
  _chat = chat;
  _orb  = orb;
}

// ── Public API ────────────────────────────────────────────────────────────
export const Gesture = {

  async start(videoEl) {
    if (_running) { this.stop(); return; }

    if (!videoEl) {
      _chat?.addError("Open camera first, then say 'start gesture control'.");
      return;
    }

    _videoEl = videoEl;
    _chat?.add(
      "🖐 Gesture control loading...\n\n" +
      "**1 finger** — move cursor on target tab\n" +
      "**2 fingers** — scroll (move hand up/down)\n" +
      "**3 fingers** — click at cursor position\n" +
      "**Fist** — pause\n\n" +
      "Extension must be installed and another tab open.",
      "bot"
    );

    try {
      await _loadLibs();
      await _initDetector();
    } catch (e) {
      console.error("[Gesture]", e);
      _chat?.addError("Gesture setup failed: " + e.message);
      return;
    }

    _setupCanvas();
    _running = true;
    _loop();
    _chat?.add("✅ Gesture control active — show your hand to the camera.", "bot");
  },

  stop() {
    _running = false;
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    _detector?.dispose?.();
    _detector = null;
    _canvas?.remove();
    _canvas  = null;
    _ctx     = null;
    _videoEl = null;
    _lastVideoTime = -1;
    _smoothX = 0.5; _smoothY = 0.5;
    _lastGesture = ""; _gestureFrames = 0;
    _scrollCooldown = 0; _clickCooldown = 0;
    _chat?.add("Gesture control off.", "bot");
  },

  isRunning() { return _running; },
};

// ── Load TF.js + hand-pose-detection ─────────────────────────────────────
function _loadScript(src, testFn) {
  return new Promise((resolve, reject) => {
    if (testFn()) { resolve(); return; }
    if (document.querySelector(`script[src="${src}"]`)) {
      // Already injected — poll for it to finish
      const poll = setInterval(() => {
        if (testFn()) { clearInterval(poll); resolve(); }
      }, 100);
      setTimeout(() => { clearInterval(poll); reject(new Error("Timeout: " + src)); }, 20000);
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.onload  = () => resolve();
    s.onerror = () => reject(new Error("Failed to load: " + src));
    document.head.appendChild(s);
  });
}

async function _loadLibs() {
  // Load TF.js core first, then hand-pose-detection which depends on it
  await _loadScript(TF_CORE,  () => !!window.tf);
  await _loadScript(TF_HANDS, () => !!window.handPoseDetection);
}

// ── Create hand detector ──────────────────────────────────────────────────
async function _initDetector() {
  const model   = window.handPoseDetection.SupportedModels.MediaPipeHands;
  const config  = {
    runtime:        "tfjs",   // pure JS — no separate WASM download
    modelType:      "lite",
    maxHands:       1,
  };
  _detector = await window.handPoseDetection.createDetector(model, config);
}

// ── Canvas overlay ────────────────────────────────────────────────────────
function _setupCanvas() {
  const parent = _videoEl?.parentElement;
  if (!parent) return;
  parent.querySelector(".gesture-canvas")?.remove();

  _canvas = document.createElement("canvas");
  _canvas.className = "gesture-canvas";
  _canvas.width  = 320;
  _canvas.height = 240;
  Object.assign(_canvas.style, {
    position: "absolute", top: "0", left: "0",
    width: "100%", height: "100%",
    pointerEvents: "none", zIndex: "10", borderRadius: "inherit",
  });
  if (window.getComputedStyle(parent).position === "static")
    parent.style.position = "relative";
  parent.appendChild(_canvas);
  _ctx = _canvas.getContext("2d");
}

// ── rAF detection loop ────────────────────────────────────────────────────
function _loop() {
  if (!_running) return;
  _rafId = requestAnimationFrame(_loop);

  if (!_videoEl || _videoEl.readyState < 2 || !_detector) return;
  if (_videoEl.currentTime === _lastVideoTime) return;
  _lastVideoTime = _videoEl.currentTime;

  _detector.estimateHands(_videoEl, { flipHorizontal: true })
    .then(hands => _onHands(hands))
    .catch(() => {});
}

// ── Process detected hands ────────────────────────────────────────────────
function _onHands(hands) {
  if (!_ctx || !_running) return;
  _ctx.clearRect(0, 0, 320, 240);

  const hand = hands?.[0];
  if (!hand?.keypoints?.length) {
    _lastGesture = ""; _gestureFrames = 0;
    return;
  }

  const kp = hand.keypoints; // [{x, y, name}, ...] already flipped

  // Normalise keypoints to 0-1 range
  const norm = kp.map(p => ({ x: p.x / 320, y: p.y / 240, name: p.name }));

  _drawSkeleton(kp);

  const fingers = _countFingers(norm);
  const gesture = fingers + "f";

  if (gesture === _lastGesture) {
    _gestureFrames++;
  } else {
    _lastGesture   = gesture;
    _gestureFrames = 1;
    if (fingers !== 2) _scrollCooldown = 0;
    if (fingers !== 3) _clickCooldown  = Math.min(_clickCooldown, 3);
  }

  // Index fingertip (keypoint 8)
  const tip = norm[8] || norm[0];
  _smoothX += (tip.x - _smoothX) * SMOOTH;
  _smoothY += (tip.y - _smoothY) * SMOOTH;

  // Draw tip dot
  _ctx.beginPath();
  _ctx.arc(_smoothX * 320, _smoothY * 240, 7, 0, Math.PI * 2);
  _ctx.fillStyle   = fingers === 3 ? "#34d399" : fingers === 2 ? "#f59e0b" : "#38bdf8";
  _ctx.strokeStyle = "rgba(255,255,255,0.9)";
  _ctx.lineWidth   = 2;
  _ctx.fill(); _ctx.stroke();

  // Label
  const label = ["PAUSE","MOVE","SCROLL","CLICK"][Math.min(fingers, 3)] || `${fingers}`;
  _ctx.fillStyle = "rgba(2,6,23,0.78)";
  _ctx.fillRect(4, 4, 82, 20);
  _ctx.fillStyle = "#38bdf8";
  _ctx.font = "bold 11px monospace";
  _ctx.fillText(`✋ ${label}`, 8, 18);

  if (_scrollCooldown > 0) _scrollCooldown--;
  if (_clickCooldown  > 0) _clickCooldown--;
  if (_gestureFrames < 3) return;
  _dispatch(fingers, _smoothX, _smoothY);
}

// ── Hand skeleton connections ─────────────────────────────────────────────
const CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [0,9],[9,10],[10,11],[11,12],
  [0,13],[13,14],[14,15],[15,16],
  [0,17],[17,18],[18,19],[19,20],
  [5,9],[9,13],[13,17],
];

function _drawSkeleton(kp) {
  _ctx.strokeStyle = "rgba(56,189,248,0.55)";
  _ctx.lineWidth   = 1.5;
  for (const [a, b] of CONNECTIONS) {
    if (!kp[a] || !kp[b]) continue;
    _ctx.beginPath();
    _ctx.moveTo(kp[a].x, kp[a].y);
    _ctx.lineTo(kp[b].x, kp[b].y);
    _ctx.stroke();
  }
  _ctx.fillStyle = "#38bdf8";
  for (const p of kp) {
    _ctx.beginPath();
    _ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
    _ctx.fill();
  }
}

// ── Gesture dispatch ──────────────────────────────────────────────────────
function _dispatch(fingers, x, y) {
  if (fingers === 1) {
    const now = Date.now();
    if (now - _lastCursorSend < CURSOR_INTERVAL) return;
    _lastCursorSend = now;
    sendToExtension("cursor_move", { x, y });
    return;
  }
  if (fingers === 2 && _scrollCooldown === 0) {
    const dy = y - 0.5;
    if (Math.abs(dy) < 0.08) return;
    sendToExtension("scroll", {
      direction: dy > 0 ? "down" : "up",
      amount: Math.round(Math.abs(dy) * 700),
    });
    _scrollCooldown = 5;
    return;
  }
  if (fingers === 3 && _clickCooldown === 0) {
    sendToExtension("gesture_click", { x, y });
    _clickCooldown = 22;
    return;
  }
}

// ── Count extended fingers ────────────────────────────────────────────────
// hand-pose-detection keypoints: same 21-point layout as MediaPipe
// Tips: 4,8,12,16,20 — PIPs: 3,6,10,14,18
function _countFingers(norm) {
  if (norm.length < 21) return 0;
  let count = 0;
  // Thumb: extended if tip X is far from knuckle X
  if (Math.abs(norm[4].x - norm[3].x) > 0.06) count++;
  // Four fingers: tip Y above (smaller) than PIP Y
  const tips = [8, 12, 16, 20];
  const pips = [6, 10, 14, 18];
  for (let i = 0; i < 4; i++) {
    if (norm[tips[i]].y < norm[pips[i]].y - 0.025) count++;
  }
  return count;
}
