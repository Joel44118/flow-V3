// ═══════════════════════════════════════════
// ui/gesture.js — Hand Gesture Screen Control (v2)
//
// FIX 1 — Extension ID:
//   Reuses sendToExtension() from screencontrol.js
//   which already handles the ID correctly.
//   No more direct chrome.runtime.sendMessage here.
//
// FIX 2 — Camera conflict:
//   Previous version used `new window.Camera(videoEl)`
//   from MediaPipe's camera_utils, which tried to
//   reopen the camera stream Flow already holds.
//   That made the video container jump/disappear.
//   Now we drive MediaPipe via requestAnimationFrame
//   on the EXISTING <video> element — no new stream,
//   no conflict, camera box stays exactly where it is.
//
// FIX 3 — Skeleton freeze on 1 finger:
//   cursor_move was firing 30x/sec, flooding the
//   extension message channel. The backlog caused
//   MediaPipe's result callback to stall.
//   Now cursor_move is throttled to max 10/sec
//   (one message per 100ms) so the channel stays clear.
//
// GESTURE MAP:
//   1 finger  → move cursor on target tab
//   2 fingers → scroll (hand Y position controls direction)
//   3 fingers → click at cursor
//   fist/0    → idle
// ═══════════════════════════════════════════

import { sendToExtension } from "./screencontrol.js";

const MP_HANDS_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/hands.js";
const MP_DRAW_URL  = "https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils@0.3.1675466124/drawing_utils.js";

let _chat    = null;
let _orb     = null;
let _running = false;
let _hands   = null;
let _rafId   = null;   // requestAnimationFrame handle
let _videoEl = null;
let _canvas  = null;
let _ctx     = null;

// Smoothing
let _smoothX = 0.5, _smoothY = 0.5;
const SMOOTH = 0.3;

// Throttle cursor_move — max 10 messages/sec
let _lastCursorSend = 0;
const CURSOR_INTERVAL = 100; // ms

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
        "Open camera first, then say 'start gesture control'.\n" +
        "Example: 'open camera' → wait for camera → 'start gesture control'"
      );
      return;
    }

    _videoEl = videoEl;
    _chat?.add(
      "🖐 Gesture control loading (~1MB)...\n\n" +
      "**1 finger** — move cursor on target tab\n" +
      "**2 fingers** — scroll (hand above centre = up, below = down)\n" +
      "**3 fingers** — click at cursor position\n" +
      "**Fist** — pause\n\n" +
      "Extension must be installed and another tab must be open.",
      "bot"
    );

    try {
      await _loadMediaPipe();
    } catch (e) {
      _chat?.addError("Failed to load MediaPipe: " + e.message);
      return;
    }

    _setupCanvas();
    _initHands();
    _running = true;
  },

  stop() {
    _running = false;
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    _hands  = null;
    _canvas?.remove();
    _canvas = null;
    _ctx    = null;
    _videoEl = null;
    // Reset state
    _smoothX = 0.5; _smoothY = 0.5;
    _lastGesture = ""; _gestureFrames = 0;
    _scrollCooldown = 0; _clickCooldown = 0;
    _chat?.add("Gesture control off.", "bot");
  },

  isRunning() { return _running; },
};

// ── Load MediaPipe scripts (no camera_utils — we use rAF instead) ─────────
function _loadMediaPipe() {
  return new Promise((resolve, reject) => {
    if (window.Hands) { resolve(); return; }

    // Only need hands.js and drawing_utils — NOT camera_utils
    // (camera_utils would try to reopen the camera stream)
    const scripts = [MP_HANDS_URL, MP_DRAW_URL];
    let loaded = 0;

    scripts.forEach(src => {
      if (document.querySelector(`script[src="${src}"]`)) { loaded++; return; }
      const s    = document.createElement("script");
      s.src      = src;
      s.onload   = () => { if (++loaded === scripts.length) resolve(); };
      s.onerror  = () => reject(new Error("Failed to load: " + src));
      document.head.appendChild(s);
    });

    if (loaded === scripts.length) resolve();
  });
}

// ── Canvas overlay — positioned over the camera video ────────────────────
function _setupCanvas() {
  const parent = _videoEl?.parentElement;
  if (!parent) return;

  // Remove any old canvas from a previous session
  parent.querySelector(".gesture-canvas")?.remove();

  _canvas = document.createElement("canvas");
  _canvas.className = "gesture-canvas";
  _canvas.width  = 320;
  _canvas.height = 240;
  Object.assign(_canvas.style, {
    position:      "absolute",
    top:           "0", left: "0",
    width:         "100%", height: "100%",
    pointerEvents: "none",
    zIndex:        "10",
    borderRadius:  "inherit",
  });

  // Make parent relative so canvas positions correctly over video
  if (window.getComputedStyle(parent).position === "static") {
    parent.style.position = "relative";
  }
  parent.appendChild(_canvas);
  _ctx = _canvas.getContext("2d");
}

// ── Init MediaPipe Hands ──────────────────────────────────────────────────
function _initHands() {
  if (!window.Hands) {
    _chat?.addError("MediaPipe Hands didn't load. Check your connection and try again.");
    _running = false;
    return;
  }

  _hands = new window.Hands({
    locateFile: f =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${f}`,
  });

  _hands.setOptions({
    maxNumHands:            1,
    modelComplexity:        0,   // lite model — fastest
    minDetectionConfidence: 0.75,
    minTrackingConfidence:  0.6,
  });

  _hands.onResults(_onResults);

  // Drive MediaPipe via rAF on the existing video — no new camera stream
  const _loop = async () => {
    if (!_running) return;
    if (_videoEl && _videoEl.readyState >= 2) {
      // send() is async but we don't await it — rAF keeps running at display rate
      _hands.send({ image: _videoEl }).catch(() => {});
    }
    _rafId = requestAnimationFrame(_loop);
  };

  _rafId = requestAnimationFrame(_loop);
  _chat?.add("✅ Gesture control active — show your hand to the camera.", "bot");
}

// ── Process MediaPipe results ─────────────────────────────────────────────
function _onResults(results) {
  if (!_ctx || !_running) return;

  _ctx.clearRect(0, 0, 320, 240);

  if (!results.multiHandLandmarks?.length) {
    // No hand visible — reset consistency counters
    _lastGesture   = "";
    _gestureFrames = 0;
    return;
  }

  const lm      = results.multiHandLandmarks[0];
  const fingers = _countFingers(lm);
  const gesture = fingers + "f";

  // Mirror the skeleton to match what user sees (camera is front-facing)
  if (window.drawConnectors && window.HAND_CONNECTIONS) {
    _ctx.save();
    _ctx.scale(-1, 1);
    _ctx.translate(-320, 0);
    window.drawConnectors(_ctx, lm, window.HAND_CONNECTIONS,
      { color: "rgba(56,189,248,0.55)", lineWidth: 1.5 });
    window.drawLandmarks(_ctx, lm,
      { color: "#38bdf8", lineWidth: 1, radius: 2 });
    _ctx.restore();
  }

  // Track how many consecutive frames the same gesture has been held
  if (gesture === _lastGesture) {
    _gestureFrames++;
  } else {
    _lastGesture   = gesture;
    _gestureFrames = 1;
    // Reset scroll/click cooldowns when gesture changes so new gestures
    // respond immediately instead of waiting out the old cooldown
    if (fingers !== 2) _scrollCooldown = 0;
    if (fingers !== 3) _clickCooldown  = Math.min(_clickCooldown, 3);
  }

  // Index fingertip (landmark 8), X mirrored for natural movement
  const tipX = 1 - lm[8].x;
  const tipY = lm[8].y;

  // EWA smooth
  _smoothX += (tipX - _smoothX) * SMOOTH;
  _smoothY += (tipY - _smoothY) * SMOOTH;

  // Draw fingertip indicator dot
  _ctx.beginPath();
  _ctx.arc(_smoothX * 320, _smoothY * 240, 7, 0, Math.PI * 2);
  _ctx.fillStyle   = fingers === 3 ? "#34d399" : fingers === 2 ? "#f59e0b" : "#38bdf8";
  _ctx.strokeStyle = "rgba(255,255,255,0.9)";
  _ctx.lineWidth   = 2;
  _ctx.fill();
  _ctx.stroke();

  // Label
  const label = fingers === 0 ? "PAUSE" : fingers === 1 ? "MOVE"
              : fingers === 2 ? "SCROLL" : fingers === 3 ? "CLICK" : `${fingers}✋`;
  _ctx.fillStyle = "rgba(2,6,23,0.78)";
  _ctx.fillRect(4, 4, 80, 20);
  _ctx.fillStyle = "#38bdf8";
  _ctx.font      = "bold 11px monospace";
  _ctx.fillText(`✋ ${label}`, 8, 18);

  // Tick cooldowns
  if (_scrollCooldown > 0) _scrollCooldown--;
  if (_clickCooldown  > 0) _clickCooldown--;

  // Require gesture to be held for ≥3 frames before acting (noise filter)
  if (_gestureFrames < 3) return;

  _dispatch(fingers, _smoothX, _smoothY);
}

// ── Gesture → extension action ────────────────────────────────────────────
function _dispatch(fingers, x, y) {

  if (fingers === 1) {
    // FIX 3: throttle to 10/sec — prevents message backlog that froze skeleton
    const now = Date.now();
    if (now - _lastCursorSend < CURSOR_INTERVAL) return;
    _lastCursorSend = now;
    sendToExtension("cursor_move", { x, y });
    return;
  }

  if (fingers === 2 && _scrollCooldown === 0) {
    const dy    = y - 0.5;       // negative = hand above centre = scroll up
    const speed = Math.abs(dy);
    if (speed < 0.08) return;    // dead zone when hand is roughly level
    const amount    = Math.round(speed * 700);
    const direction = dy > 0 ? "down" : "up";
    sendToExtension("scroll", { direction, amount });
    _scrollCooldown = 5;         // ~5 frames ≈ 165ms at 30fps
    return;
  }

  if (fingers === 3 && _clickCooldown === 0) {
    sendToExtension("gesture_click", { x, y });
    _clickCooldown = 22;         // ~730ms debounce
    return;
  }
}

// ── Count extended fingers ────────────────────────────────────────────────
function _countFingers(lm) {
  const tips = [4, 8, 12, 16, 20];
  const pips = [3, 6, 10, 14, 18];
  let count = 0;

  // Thumb: extended sideways (X axis)
  if (Math.abs(lm[4].x - lm[3].x) > 0.06) count++;

  // Four fingers: tip Y above PIP Y (smaller Y = higher on screen)
  for (let i = 1; i < 5; i++) {
    if (lm[tips[i]].y < lm[pips[i]].y - 0.025) count++;
  }

  return count;
}
