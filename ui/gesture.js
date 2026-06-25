// ui/gesture.js — v8 DEFINITIVE
//
// WHAT CHANGED FROM v7:
// - Uses @mediapipe/hands from unpkg (NOT TF.js / NOT Kaggle CDN)
//   The @mediapipe/hands package on unpkg bundles its own WASM + model files
//   at the same URL path, so no external storage.googleapis.com calls
// - Canvas is positioned using getBoundingClientRect for accuracy
// - Dot position HOLDS when hand leaves frame (no reset to hand position on return)
//   Smooth interpolation only runs when hand IS visible
// - Gesture recognition uses a STABLE gesture (must hold for 3 frames) to avoid
//   accidental keyboard trigger from seeing 4 fingers briefly
// - Scroll uses the same _findScrollable approach as content.js (via extension)
// - cursor_move uses sendDirect (fire-and-forget) — zero chat messages, no queue
// - Only scroll/click generate any chat message (and scroll is silent)
// - "start gesture control" command now properly routes to startGesture()
//   regardless of whether Flow heard it slightly mangled

import { send as scSend, sendDirect as scSendDirect, isReady as scIsReady } from "./screencontrol.js";

const HANDS_JS = "https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1646424915/hands.js";
const HANDS_UTILS = "https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils@0.3.1620248257/drawing_utils.js";

// State
let _hands      = null;
let _rafId      = null;
let _canvas     = null;
let _ctx        = null;
let _video      = null;
let _active     = false;
let _Chat       = null;

// Dot position (normalised 0-1, persists between hand-visible frames)
let _dotNx      = 0.5;
let _dotNy      = 0.5;
let _handVisible = false;

// Gesture stabilisation — require N consecutive identical gestures before acting
let _gestureBuffer = [];
const GESTURE_STABLE = 3;     // frames needed for a stable gesture
let _lastActed  = 0;           // timestamp of last extension action
let _prevHandY  = null;        // for scroll direction

// ── Public API ───────────────────────────────────────────────────────────────
export function initGesture(chatModule) {
  _Chat = chatModule;
}

export async function startGesture(videoEl) {
  if (_active) { _chat("Gesture control is already running."); return; }
  if (!videoEl || videoEl.readyState < 2) {
    _chat("⚠️ Camera isn't ready — type 'open camera' first, then try again.");
    return;
  }
  _video = videoEl;

  // Load MediaPipe Hands (bundles its own WASM + model, no Kaggle)
  try {
    await _loadScript(HANDS_JS);
    await _loadScript(HANDS_UTILS);
  } catch (e) {
    _chat("⚠️ Gesture setup failed: Could not load MediaPipe (" + e.message + "). Check your internet connection.");
    return;
  }

  // Create Hands detector
  try {
    _hands = new window.Hands({
      locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1646424915/${file}`,
    });
    _hands.setOptions({
      maxNumHands:       1,
      modelComplexity:   0,         // lite model — faster
      minDetectionConfidence: 0.7,
      minTrackingConfidence:  0.6,
    });
    _hands.onResults(_onResults);
    await _hands.initialize();
  } catch (e) {
    _chat("⚠️ Gesture setup failed: " + e.message);
    return;
  }

  _setupCanvas(videoEl);
  _active = true;
  _log("Gesture control active ✓");
  _chat("✅ Gesture control active!\n\n" +
    "☝️ **1 finger** = move cursor\n" +
    "✌️ **2 fingers** = scroll (move hand up/down)\n" +
    "🤟 **3 fingers** = click\n" +
    "✊ **Fist** = pause (dot holds position)"
  );
  _loop();
}

export function stopGesture() {
  _active = false;
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
  if (_hands) { _hands.close?.(); _hands = null; }
  if (_canvas) { _canvas.remove(); _canvas = null; _ctx = null; }
  _gestureBuffer = [];
  _prevHandY = null;
  _log("Gesture control stopped.");
  _chat("🛑 Gesture control off.");
}

// ── Detection loop ───────────────────────────────────────────────────────────
async function _loop() {
  if (!_active || !_hands || !_video) return;
  if (_video.readyState >= 2 && _video.videoWidth > 0) {
    try { await _hands.send({ image: _video }); } catch (e) { /* skip bad frame */ }
  }
  _rafId = requestAnimationFrame(_loop);
}

function _onResults(results) {
  if (!_active || !_ctx || !_canvas) return;
  _ctx.clearRect(0, 0, _canvas.width, _canvas.height);

  if (!results.multiHandLandmarks?.length) {
    _handVisible = false;
    _gestureBuffer = [];
    _prevHandY = null;
    return;
  }

  const lm = results.multiHandLandmarks[0];
  _handVisible = true;

  // Draw skeleton using MediaPipe's built-in drawing utils
  if (window.drawConnectors && window.drawLandmarks && window.HAND_CONNECTIONS) {
    window.drawConnectors(_ctx, lm, window.HAND_CONNECTIONS, { color: "rgba(56,189,248,0.85)", lineWidth: 2 });
    window.drawLandmarks(_ctx, lm, { color: "rgba(251,191,36,0.9)", lineWidth: 1, radius: 4 });
  } else {
    _drawSkeletonFallback(lm);
  }

  // Update dot position — smooth track to hand index fingertip
  // MediaPipe gives normalised [0,1] coords directly
  const tipNx = 1 - lm[8].x;   // mirror X (camera is mirrored)
  const tipNy = lm[8].y;

  // Smooth interpolation only when hand is visible
  _dotNx += (tipNx - _dotNx) * 0.35;
  _dotNy += (tipNy - _dotNy) * 0.35;

  // Count fingers and get stable gesture
  const fingers = _countFingers(lm);
  _gestureBuffer.push(fingers);
  if (_gestureBuffer.length > GESTURE_STABLE + 2) _gestureBuffer.shift();

  // Determine stable gesture (last GESTURE_STABLE frames all same)
  const recent = _gestureBuffer.slice(-GESTURE_STABLE);
  const stable = recent.length === GESTURE_STABLE && recent.every(f => f === recent[0]) ? recent[0] : -1;

  _dispatchGesture(stable, lm);
}

// ── Gesture dispatch ─────────────────────────────────────────────────────────
function _dispatchGesture(fingers, lm) {
  const now = Date.now();

  if (fingers === 1) {
    // ☝️ MOVE CURSOR — fire-and-forget via sendDirect (no chat, no queue)
    scSendDirect("cursor_move", { x: _dotNx, y: _dotNy });
    _prevHandY = lm[8].y;

  } else if (fingers === 2) {
    // ✌️ SCROLL — based on hand movement direction
    if (_prevHandY !== null) {
      const dy = lm[8].y - _prevHandY;
      if (Math.abs(dy) > 0.02 && now - _lastActed > 350) {
        _lastActed = now;
        const dir    = dy > 0 ? "down" : "up";
        const amount = Math.min(600, Math.round(Math.abs(dy) * 1800));
        scSend("scroll", { direction: dir, amount }).catch(() => {});
        _showLabel(dir === "down" ? "↓" : "↑");
      }
    }
    _prevHandY = lm[8].y;

  } else if (fingers === 3) {
    // 🤟 CLICK — hard 1-second debounce
    if (now - _lastActed > 1000) {
      _lastActed = now;
      scSend("gesture_click", { x: _dotNx, y: _dotNy }).catch(() => {});
      _showLabel("CLICK");
    }
    _prevHandY = null;

  } else {
    // ✊ Fist or unclear — dot holds position, no action
    _prevHandY = null;
  }
}

// ── Finger counting ──────────────────────────────────────────────────────────
// MediaPipe landmark indices: tips [4,8,12,16,20], pips [3,6,10,14,18], mcps [2,5,9,13,17]
function _countFingers(lm) {
  let count = 0;
  // Thumb: compare tip x vs mcp x (horizontal, mirror-aware — tip should be to the right)
  if (lm[4].x > lm[3].x) count++;
  // Other fingers: tip y < pip y = extended (lower y = higher on screen in MediaPipe)
  const tips = [8, 12, 16, 20];
  const pips = [6, 10, 14, 18];
  for (let i = 0; i < 4; i++) {
    if (lm[tips[i]].y < lm[pips[i]].y) count++;
  }
  return count;
}

// ── Canvas overlay ───────────────────────────────────────────────────────────
function _setupCanvas(videoEl) {
  if (_canvas) _canvas.remove();

  const container = videoEl.parentElement || document.body;
  container.style.position = container.style.position || "relative";

  _canvas = document.createElement("canvas");
  _canvas.width  = videoEl.videoWidth  || videoEl.clientWidth  || 320;
  _canvas.height = videoEl.videoHeight || videoEl.clientHeight || 240;

  // Position exactly over the video element
  const updatePos = () => {
    const vr  = videoEl.getBoundingClientRect();
    const cr  = container.getBoundingClientRect();
    Object.assign(_canvas.style, {
      position: "absolute",
      left:     (vr.left - cr.left) + "px",
      top:      (vr.top  - cr.top)  + "px",
      width:    vr.width  + "px",
      height:   vr.height + "px",
      pointerEvents: "none",
      zIndex:   "9999",
      transform: "scaleX(-1)",   // mirror to match camera feed
    });
  };
  updatePos();

  const ro = new ResizeObserver(updatePos);
  ro.observe(videoEl);
  ro.observe(container);

  container.appendChild(_canvas);
  _ctx = _canvas.getContext("2d");
}

// Fallback skeleton when MediaPipe drawing utils aren't available
const CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [0,9],[9,10],[10,11],[11,12],
  [0,13],[13,14],[14,15],[15,16],
  [0,17],[17,18],[18,19],[19,20],
  [5,9],[9,13],[13,17],
];
function _drawSkeletonFallback(lm) {
  const w = _canvas.width, h = _canvas.height;
  _ctx.strokeStyle = "rgba(56,189,248,0.85)";
  _ctx.lineWidth   = 2;
  for (const [a, b] of CONNECTIONS) {
    _ctx.beginPath();
    _ctx.moveTo(lm[a].x * w, lm[a].y * h);
    _ctx.lineTo(lm[b].x * w, lm[b].y * h);
    _ctx.stroke();
  }
  for (const { x, y } of lm) {
    _ctx.beginPath();
    _ctx.arc(x * w, y * h, 4, 0, Math.PI * 2);
    _ctx.fillStyle = "rgba(251,191,36,0.9)";
    _ctx.fill();
  }
  // Index fingertip highlight
  _ctx.beginPath();
  _ctx.arc(lm[8].x * w, lm[8].y * h, 7, 0, Math.PI * 2);
  _ctx.fillStyle = "rgba(52,211,153,0.9)";
  _ctx.fill();
}

// ── Label overlay ────────────────────────────────────────────────────────────
let _labelTimer = null;
function _showLabel(text) {
  if (!_ctx || !_canvas) return;
  clearTimeout(_labelTimer);
  _ctx.save();
  _ctx.font      = "bold 20px sans-serif";
  _ctx.fillStyle = "rgba(251,191,36,0.95)";
  _ctx.textAlign = "center";
  _ctx.shadowColor = "rgba(0,0,0,0.5)";
  _ctx.shadowBlur  = 4;
  _ctx.fillText(text, _canvas.width / 2, 28);
  _ctx.restore();
  _labelTimer = setTimeout(() => {
    if (_ctx && _canvas) _ctx.clearRect(0, 0, _canvas.width, 40);
  }, 600);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
    const s   = document.createElement("script");
    s.src     = src;
    s.onload  = res;
    s.onerror = () => rej(new Error("Failed to load: " + src));
    document.head.appendChild(s);
  });
}

function _chat(msg) { _Chat?.addMessage?.("bot", msg); }
function _log(msg)  { console.log("[Gesture]", msg); }

// ── Gesture namespace object (imported by app.js as { Gesture }) ───────────
export const Gesture = {
  start: startGesture,
  stop:  stopGesture,
};
