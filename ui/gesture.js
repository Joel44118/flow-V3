// ═══════════════════════════════════════════
// ui/gesture.js — Hand Gesture Control (v3)
//
// COMPLETE REWRITE — switched from @mediapipe/hands@0.4
// (broken CDN package — .tflite assets missing from jsDelivr,
//  causes "Failed to read palm_detection_lite.tflite" crash)
// to @mediapipe/tasks-vision (Google's current maintained SDK).
//
// @mediapipe/tasks-vision loads via a single CDN script,
// bundles its own WASM and model assets at a known URL,
// and works reliably in browser context without any Camera
// utility or separate asset files.
//
// GESTURE MAP:
//   1 finger  (index up)      → move cursor on target tab
//   2 fingers (index+middle)  → scroll (Y position = direction)
//   3 fingers                 → click at cursor position
//   fist / 0 fingers          → idle / pause
//
// sendToExtension() is imported from screencontrol.js
// which already handles the extension ID correctly.
// ═══════════════════════════════════════════

import { sendToExtension } from "./screencontrol.js";

// @mediapipe/tasks-vision — current, maintained, works from CDN
const TASKS_VISION_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.12/wasm/vision_bundle.js";

// The WASM assets live alongside the JS bundle at this base URL
const WASM_BASE =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.12/wasm";

// Hand landmark model (full — more accurate than lite)
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

let _chat    = null;
let _orb     = null;
let _running = false;
let _landmarker = null;  // MediaPipe HandLandmarker instance
let _rafId   = null;
let _videoEl = null;
let _canvas  = null;
let _ctx     = null;
let _lastVideoTime = -1;

// Smoothing
let _smoothX = 0.5, _smoothY = 0.5;
const SMOOTH = 0.28;

// Throttle cursor_move — max 10/sec to avoid blocking extension
let _lastCursorSend = 0;
const CURSOR_INTERVAL = 100;

// Gesture debounce
let _lastGesture   = "";
let _gestureFrames = 0;
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
      _chat?.addError(
        "Open camera first, then say 'start gesture control'."
      );
      return;
    }

    _videoEl = videoEl;
    _chat?.add(
      "🖐 Gesture control loading...\n\n" +
      "**1 finger** — move cursor on target tab\n" +
      "**2 fingers** — scroll up/down\n" +
      "**3 fingers** — click at cursor position\n" +
      "**Fist** — pause\n\n" +
      "Extension must be installed and another tab open.",
      "bot"
    );

    try {
      await _loadSDK();
      await _initLandmarker();
    } catch (e) {
      _chat?.addError("Gesture setup failed: " + e.message);
      console.error("[Gesture]", e);
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
    _landmarker?.close?.();
    _landmarker = null;
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

// ── Load @mediapipe/tasks-vision from CDN ─────────────────────────────────
function _loadSDK() {
  return new Promise((resolve, reject) => {
    // Already loaded
    if (window.MediaPipeTasksVision || window.HandLandmarker) {
      resolve(); return;
    }
    // Check if script already injected
    if (document.querySelector(`script[data-mp-tasks]`)) {
      // Wait for it to finish loading
      const poll = setInterval(() => {
        if (window.MediaPipeTasksVision || window.HandLandmarker) {
          clearInterval(poll); resolve();
        }
      }, 100);
      setTimeout(() => { clearInterval(poll); reject(new Error("SDK load timeout")); }, 15000);
      return;
    }
    const s = document.createElement("script");
    s.src = TASKS_VISION_URL;
    s.setAttribute("data-mp-tasks", "1");
    s.onload  = () => resolve();
    s.onerror = () => reject(new Error("Failed to load MediaPipe tasks-vision from CDN"));
    document.head.appendChild(s);
  });
}

// ── Create HandLandmarker instance ────────────────────────────────────────
async function _initLandmarker() {
  // tasks-vision exposes HandLandmarker on the module object
  const { HandLandmarker, FilesetResolver } = window.MediaPipeTasksVision
    || await import(TASKS_VISION_URL);

  const vision = await FilesetResolver.forVisionTasks(WASM_BASE);

  _landmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: MODEL_URL,
      delegate: "GPU",  // falls back to CPU automatically
    },
    runningMode:        "VIDEO",
    numHands:           1,
    minHandDetectionConfidence: 0.6,
    minHandPresenceConfidence:  0.5,
    minTrackingConfidence:      0.5,
  });
}

// ── Canvas overlay over the camera feed ───────────────────────────────────
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
    pointerEvents: "none", zIndex: "10",
    borderRadius: "inherit",
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

  if (!_videoEl || _videoEl.readyState < 2 || !_landmarker) return;

  // Only process a frame if the video has actually advanced
  const now = performance.now();
  if (_videoEl.currentTime === _lastVideoTime) return;
  _lastVideoTime = _videoEl.currentTime;

  try {
    const result = _landmarker.detectForVideo(_videoEl, now);
    _onResults(result);
  } catch (e) {
    // Swallow transient errors (video not ready, GPU reset, etc.)
  }
}

// ── Process landmarks ─────────────────────────────────────────────────────
function _onResults(result) {
  if (!_ctx || !_running) return;

  _ctx.clearRect(0, 0, 320, 240);

  const lms = result?.landmarks?.[0];
  if (!lms?.length) {
    _lastGesture = ""; _gestureFrames = 0;
    return;
  }

  // Draw skeleton
  _drawSkeleton(lms);

  const fingers = _countFingers(lms);
  const gesture = fingers + "f";

  if (gesture === _lastGesture) {
    _gestureFrames++;
  } else {
    _lastGesture   = gesture;
    _gestureFrames = 1;
    if (fingers !== 2) _scrollCooldown = 0;
    if (fingers !== 3) _clickCooldown  = Math.min(_clickCooldown, 3);
  }

  // Index fingertip landmark 8 — mirror X for natural movement
  const tipX = 1 - lms[8].x;
  const tipY = lms[8].y;

  _smoothX += (tipX - _smoothX) * SMOOTH;
  _smoothY += (tipY - _smoothY) * SMOOTH;

  // Fingertip dot
  _ctx.beginPath();
  _ctx.arc(_smoothX * 320, _smoothY * 240, 7, 0, Math.PI * 2);
  _ctx.fillStyle   = fingers === 3 ? "#34d399" : fingers === 2 ? "#f59e0b" : "#38bdf8";
  _ctx.strokeStyle = "rgba(255,255,255,0.9)";
  _ctx.lineWidth   = 2;
  _ctx.fill(); _ctx.stroke();

  // Label
  const label = ["PAUSE","MOVE","SCROLL","CLICK"][fingers] || `${fingers}✋`;
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

// ── Draw hand skeleton manually (no drawConnectors needed) ────────────────
// tasks-vision doesn't bundle drawing_utils — draw it ourselves
const CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],       // thumb
  [0,5],[5,6],[6,7],[7,8],       // index
  [0,9],[9,10],[10,11],[11,12],  // middle
  [0,13],[13,14],[14,15],[15,16],// ring
  [0,17],[17,18],[18,19],[19,20],// pinky
  [5,9],[9,13],[13,17],          // palm
];

function _drawSkeleton(lms) {
  if (!_ctx) return;
  _ctx.save();
  // Mirror to match camera
  _ctx.scale(-1, 1);
  _ctx.translate(-320, 0);

  _ctx.strokeStyle = "rgba(56,189,248,0.55)";
  _ctx.lineWidth   = 1.5;
  for (const [a, b] of CONNECTIONS) {
    _ctx.beginPath();
    _ctx.moveTo(lms[a].x * 320, lms[a].y * 240);
    _ctx.lineTo(lms[b].x * 320, lms[b].y * 240);
    _ctx.stroke();
  }

  _ctx.fillStyle = "#38bdf8";
  for (const lm of lms) {
    _ctx.beginPath();
    _ctx.arc(lm.x * 320, lm.y * 240, 2, 0, Math.PI * 2);
    _ctx.fill();
  }
  _ctx.restore();
}

// ── Gesture → extension action ────────────────────────────────────────────
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
// tasks-vision uses same 21-landmark layout as old MediaPipe
function _countFingers(lms) {
  const tips = [4, 8, 12, 16, 20];
  const pips = [3, 6, 10, 14, 18];
  let count = 0;
  if (Math.abs(lms[4].x - lms[3].x) > 0.06) count++; // thumb
  for (let i = 1; i < 5; i++) {
    if (lms[tips[i]].y < lms[pips[i]].y - 0.025) count++;
  }
  return count;
}
