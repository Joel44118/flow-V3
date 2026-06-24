// ui/gesture.js (v10)
// Complete rewrite with:
//  • Cursor LOCK — position persists when hand leaves; on return,
//    it "picks up" from locked position and moves relative to where hand went
//  • NO 4-finger keyboard trigger — dedicated PINCH gesture instead
//  • Full gesture suite: move, scroll, click, right-click, drag, middle-click,
//    zoom, tab-switch, back/forward, media keys
//  • Keyboard appears in target tab (via extension), NOT in camera panel
//  • Hover highlighting of buttons/inputs via extension
//  • Gesture debounce hierarchy so they never bleed into each other

import { sendToExtension } from "./screencontrol.js";

const MP_HANDS = "https://unpkg.com/@mediapipe/hands@0.4.1675469240/hands.js";
const MP_DRAW  = "https://unpkg.com/@mediapipe/drawing_utils@0.3.1675466124/drawing_utils.js";
const MP_BASE  = "https://unpkg.com/@mediapipe/hands@0.4.1675469240/";

let _chat = null, _orb = null, _running = false;
let _hands = null, _rafId = null, _videoEl = null;
let _canvas = null, _ctx = null, _processing = false;

// ─── Cursor state ────────────────────────────────────────────────────────────
// We maintain a LOCKED absolute position (0-1) that stays frozen when hand
// is absent or in non-MOVE gesture.  When the hand returns, we compute delta
// from the hand's re-entry point to avoid teleporting.
let _lockedX = 0.5, _lockedY = 0.5;   // the "persistent" cursor
let _prevHandX = -1, _prevHandY = -1;  // last known hand tip position
let _handPresent = false;               // whether hand is currently visible
let _entryX = -1, _entryY = -1;        // hand position at moment of return

const SMOOTH = 0.30;  // How fast the cursor chases the finger (lower = slower)

// ─── Gesture tracking ────────────────────────────────────────────────────────
let _lastGesture = "", _gestureFrames = 0;
let _lastCursorSend = 0;
const CURSOR_MS = 60;  // max 16fps cursor updates (smooth enough)

// Cooldowns per gesture type (in frames at ~15fps)
let _scrollCd    = 0;
let _clickCd     = 0;
let _rclickCd    = 0;
let _dragCd      = 0;
let _kbToggleCd  = 0;
let _tabCd       = 0;
let _backCd      = 0;
let _mediaCd     = 0;
let _zoomCd      = 0;
let _pinchCd     = 0;

// ─── Drag state ──────────────────────────────────────────────────────────────
let _dragging      = false;
let _dragStartX    = 0.5, _dragStartY = 0.5;
let _dragFrames    = 0;

// ─── Keyboard state ──────────────────────────────────────────────────────────
// Keyboard now lives in the TARGET TAB (injected via extension), not camera panel
let _kbMode      = false;
let _kbRow       = 0, _kbCol = 0;
let _kbShift     = false;
// Canvas-side mini indicator only (shows which key is highlighted)
let _kbCanvas    = null, _kbCtx = null;

export function initGesture(chat, orb) { _chat = chat; _orb = orb; }

export const Gesture = {
  async start(videoEl) {
    if (_running) { this.stop(); return; }
    if (!videoEl) {
      _chat?.addError("Open camera first, then say 'start gesture control'.");
      return;
    }
    if (videoEl.videoWidth === 0) {
      await new Promise(r => {
        videoEl.addEventListener("loadeddata", r, { once: true });
        setTimeout(r, 3000);
      });
    }
    _videoEl = videoEl;
    _chat?.add(
      "🖐 Loading gesture model…\n\n" +
      "**Gestures (don't combine):**\n" +
      "• **1 finger (index)** — Move cursor\n" +
      "• **2 fingers (index+middle)** — Scroll up/down\n" +
      "• **3 fingers** — Click\n" +
      "• **Fist** — Pause / lock cursor\n" +
      "• **✌️ V + hold 3s** — Drag (hold = drag, release = drop)\n" +
      "• **👍 Thumb only** — Right-click\n" +
      "• **🤙 Pinch (thumb+index close)** — Toggle keyboard\n" +
      "• **4 fingers (no thumb)** — Middle-click\n" +
      "• **Open palm** — Scroll to top\n" +
      "• **Swipe left (2f fast)** — Browser back\n" +
      "• **Swipe right (2f fast)** — Browser forward\n" +
      "• **Swipe left (1f fast)** — Switch tab left\n" +
      "• **Swipe right (1f fast)** — Switch tab right",
      "bot"
    );
    try {
      await _load(MP_HANDS, () => !!window.Hands);
      await _load(MP_DRAW,  () => !!window.drawConnectors);
      await _initHands();
    } catch(e) {
      console.error("[Gesture]", e);
      _chat?.addError("Gesture setup failed: " + e.message);
      return;
    }
    _setupCanvas();
    _running = true;
    _rafId = requestAnimationFrame(_loop);
    _chat?.add("✅ Gesture control active — show your hand to the camera.", "bot");
  },

  stop() {
    _running = false;
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    _hands?.close?.(); _hands = null;
    _canvas?.remove();  _canvas = null; _ctx = null;
    _kbCanvas?.remove(); _kbCanvas = null; _kbCtx = null;
    _videoEl = null; _processing = false;
    _resetState();
    _chat?.add("Gesture control off.", "bot");
    // Tell target tab to remove cursor dot & keyboard
    sendToExtension("gesture_cleanup", {});
  },

  isRunning() { return _running; },
};

function _resetState() {
  _lockedX = 0.5; _lockedY = 0.5;
  _prevHandX = -1; _prevHandY = -1;
  _handPresent = false; _entryX = -1; _entryY = -1;
  _lastGesture = ""; _gestureFrames = 0;
  _scrollCd = 0; _clickCd = 0; _rclickCd = 0; _dragCd = 0;
  _kbToggleCd = 0; _tabCd = 0; _backCd = 0; _mediaCd = 0;
  _zoomCd = 0; _pinchCd = 0;
  _dragging = false; _dragFrames = 0;
  _kbMode = false; _kbRow = 0; _kbCol = 0; _kbShift = false;
}

// ─── Script loader ────────────────────────────────────────────────────────────
function _load(src, ready) {
  return new Promise((resolve, reject) => {
    if (ready()) { resolve(); return; }
    if (document.querySelector(`script[src="${src}"]`)) {
      const iv = setInterval(() => { if (ready()) { clearInterval(iv); resolve(); } }, 200);
      setTimeout(() => { clearInterval(iv); ready() ? resolve() : reject(new Error("Timeout: " + src)); }, 20000);
      return;
    }
    const s = document.createElement("script");
    s.src = src; s.crossOrigin = "anonymous";
    s.onload  = () => resolve();
    s.onerror = () => reject(new Error("Load failed: " + src));
    document.head.appendChild(s);
  });
}

async function _initHands() {
  _hands = new window.Hands({ locateFile: f => MP_BASE + f });
  _hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 0,
    minDetectionConfidence: 0.72,
    minTrackingConfidence:  0.55,
  });
  _hands.onResults(_onResults);
  await _hands.send({ image: _videoEl });
}

function _setupCanvas() {
  const parent = _videoEl?.parentElement;
  if (!parent) return;
  parent.querySelector(".gesture-canvas")?.remove();
  _canvas = document.createElement("canvas");
  _canvas.className = "gesture-canvas";
  _canvas.width  = _videoEl.videoWidth  || 320;
  _canvas.height = _videoEl.videoHeight || 240;
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

function _loop() {
  if (!_running) return;
  _rafId = requestAnimationFrame(_loop);
  if (!_videoEl || _videoEl.readyState < 2 || !_hands || _processing) return;
  _processing = true;
  _hands.send({ image: _videoEl }).catch(() => { _processing = false; });
}

// ─── Skeleton connections ─────────────────────────────────────────────────────
const CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],
  [0,9],[9,10],[10,11],[11,12],[0,13],[13,14],[14,15],[15,16],
  [0,17],[17,18],[18,19],[19,20],[5,9],[9,13],[13,17],
];

// ─── Gesture history for swipe detection ─────────────────────────────────────
const HISTORY_LEN = 12;
let _tipHistory = []; // [{x,y,t}]

function _pushHistory(x, y) {
  const now = Date.now();
  _tipHistory.push({ x, y, t: now });
  if (_tipHistory.length > HISTORY_LEN) _tipHistory.shift();
}

// Returns {dx, dy} velocity over last ~0.35s or null
function _swipeVelocity() {
  if (_tipHistory.length < 4) return null;
  const old = _tipHistory[0], cur = _tipHistory[_tipHistory.length - 1];
  const dt = (cur.t - old.t) / 1000;
  if (dt < 0.05 || dt > 0.5) return null;
  return { dx: (cur.x - old.x) / dt, dy: (cur.y - old.y) / dt };
}

// ─── Main result handler ──────────────────────────────────────────────────────
function _onResults(r) {
  _processing = false;
  if (!_ctx || !_running) return;

  const W = _canvas.width, H = _canvas.height;
  _ctx.clearRect(0, 0, W, H);

  const lms = r.multiHandLandmarks?.[0];

  // ── No hand visible ───────────────────────────────────────────────────────
  if (!lms) {
    _handPresent = false;
    _entryX = -1; _entryY = -1;
    _lastGesture = ""; _gestureFrames = 0;
    _tipHistory = [];
    // Cursor stays at _lockedX / _lockedY — send a keep-alive move every 2s
    // so dot doesn't disappear on target tab
    const now2 = Date.now();
    if (now2 - _lastCursorSend > 2000) {
      _lastCursorSend = now2;
      sendToExtension("cursor_move", { x: _lockedX, y: _lockedY });
    }
    // Draw locked dot on camera canvas
    _drawLockedDot(W, H);
    return;
  }

  // ── Hand visible ──────────────────────────────────────────────────────────
  const tip = lms[8]; // index fingertip

  if (!_handPresent) {
    // Hand just appeared — record entry position
    _entryX = tip.x; _entryY = tip.y;
    _handPresent = true;
  }

  // Draw skeleton
  if (window.drawConnectors && window.HAND_CONNECTIONS) {
    window.drawConnectors(_ctx, lms, window.HAND_CONNECTIONS,
      { color: "rgba(56,189,248,0.6)", lineWidth: 2 });
    window.drawLandmarks(_ctx, lms,
      { color: "#38bdf8", lineWidth: 1, radius: 3 });
  } else {
    _ctx.strokeStyle = "rgba(56,189,248,0.6)"; _ctx.lineWidth = 2;
    for (const [a, b] of CONNECTIONS) {
      _ctx.beginPath();
      _ctx.moveTo(lms[a].x * W, lms[a].y * H);
      _ctx.lineTo(lms[b].x * W, lms[b].y * H);
      _ctx.stroke();
    }
    _ctx.fillStyle = "#38bdf8";
    for (const p of lms) {
      _ctx.beginPath(); _ctx.arc(p.x*W, p.y*H, 3, 0, Math.PI*2); _ctx.fill();
    }
  }

  const gesture = _classifyGesture(lms);

  if (gesture === _lastGesture) _gestureFrames++;
  else { _lastGesture = gesture; _gestureFrames = 1; }

  // ── Cursor position update ────────────────────────────────────────────────
  // Only move the locked cursor when in MOVE gesture.
  // Use relative-delta approach: when hand returns, entry point maps to
  // locked position, and movement is added as delta from that entry.
  if (gesture === "MOVE") {
    if (_entryX >= 0) {
      // Relative mode: dx/dy from entry point
      const dx = tip.x - _entryX;
      const dy = tip.y - _entryY;
      // Map hand range to screen range with sensitivity multiplier
      const SENS = 2.2;
      let nx = _lockedX + dx * SENS;
      let ny = _lockedY + dy * SENS;
      // Clamp
      nx = Math.max(0.01, Math.min(0.99, nx));
      ny = Math.max(0.01, Math.min(0.99, ny));
      // Smooth towards target
      _lockedX += (nx - _lockedX) * SMOOTH;
      _lockedY += (ny - _lockedY) * SMOOTH;
      // Update entry reference so next frame delta is relative to NOW
      _entryX = tip.x; _entryY = tip.y;
    }

    _pushHistory(_lockedX, _lockedY);

    const now = Date.now();
    if (now - _lastCursorSend >= CURSOR_MS) {
      _lastCursorSend = now;
      sendToExtension("cursor_move", { x: _lockedX, y: _lockedY });
    }
  } else {
    // Non-move gesture — reset entry so next MOVE transition starts relative
    _entryX = tip.x; _entryY = tip.y;
  }

  // Draw dot at locked position on camera canvas
  const dotCx = _lockedX * W, dotCy = _lockedY * H;
  _ctx.beginPath(); _ctx.arc(dotCx, dotCy, 9, 0, Math.PI*2);
  _ctx.fillStyle   = _gestureColor(gesture);
  _ctx.strokeStyle = "white"; _ctx.lineWidth = 2;
  _ctx.fill(); _ctx.stroke();

  // Label
  const labelText = gesture === "FIST" ? "⏸ PAUSE" : "✋ " + gesture;
  _ctx.fillStyle = "rgba(2,6,23,0.82)";
  _ctx.fillRect(4, 4, 100, 20);
  _ctx.fillStyle = "#38bdf8"; _ctx.font = "bold 11px monospace";
  _ctx.fillText(labelText, 8, 18);

  // Tick down cooldowns
  if (_scrollCd   > 0) _scrollCd--;
  if (_clickCd    > 0) _clickCd--;
  if (_rclickCd   > 0) _rclickCd--;
  if (_dragCd     > 0) _dragCd--;
  if (_kbToggleCd > 0) _kbToggleCd--;
  if (_tabCd      > 0) _tabCd--;
  if (_backCd     > 0) _backCd--;
  if (_mediaCd    > 0) _mediaCd--;
  if (_zoomCd     > 0) _zoomCd--;
  if (_pinchCd    > 0) _pinchCd--;

  if (_gestureFrames < 3) return;  // wait for stable gesture
  _dispatch(gesture, lms);
}

function _drawLockedDot(W, H) {
  if (!_ctx) return;
  const cx = _lockedX * W, cy = _lockedY * H;
  // Pulsing ring to show it's locked
  _ctx.beginPath(); _ctx.arc(cx, cy, 11, 0, Math.PI*2);
  _ctx.strokeStyle = "rgba(56,189,248,0.4)"; _ctx.lineWidth = 2; _ctx.stroke();
  _ctx.beginPath(); _ctx.arc(cx, cy, 7, 0, Math.PI*2);
  _ctx.fillStyle = "rgba(56,189,248,0.7)"; _ctx.strokeStyle = "white";
  _ctx.lineWidth = 1.5; _ctx.fill(); _ctx.stroke();
}

function _gestureColor(g) {
  return {
    MOVE:    "#38bdf8",
    SCROLL:  "#f59e0b",
    CLICK:   "#34d399",
    RCLICK:  "#f87171",
    DRAG:    "#fb923c",
    MCLICK:  "#a78bfa",
    PINCH:   "#e879f9",
    PALM:    "#67e8f9",
    FIST:    "rgba(148,163,184,0.8)",
    "4F":    "#c084fc",
  }[g] || "#38bdf8";
}

// ─── Gesture classifier ───────────────────────────────────────────────────────
// Returns a string name for the current hand pose.
// Priority order matters — more specific checks first.
function _classifyGesture(lms) {
  const fingers  = _countFingers(lms);
  const thumb    = _thumbUp(lms);
  const fist     = fingers === 0 && !thumb;
  const pinch    = _isPinch(lms);
  const palm     = fingers === 4 && thumb;   // all 5 = open palm

  if (fist)   return "FIST";
  if (pinch)  return "PINCH";
  if (palm)   return "PALM";

  if (fingers === 1 && !thumb) return "MOVE";
  if (fingers === 2 && !thumb) return "SCROLL";
  if (fingers === 3 && !thumb) return "CLICK";
  if (fingers === 4 && !thumb) return "4F";      // 4 fingers no thumb = middle-click
  if (fingers === 0 &&  thumb) return "RCLICK";  // thumb only
  if (fingers === 1 &&  thumb) return "DRAG";    // thumb + index = drag

  return "MOVE"; // fallback
}

function _countFingers(lms) {
  // Count extended fingers (index, middle, ring, pinky)
  const tips = [8, 12, 16, 20], pips = [6, 10, 14, 18];
  let c = 0;
  for (let i = 0; i < 4; i++) {
    if (lms[tips[i]].y < lms[pips[i]].y - 0.03) c++;
  }
  return c;
}

function _thumbUp(lms) {
  // Thumb extended: tip is clearly to the side of the hand
  return Math.abs(lms[4].x - lms[2].x) > 0.07;
}

function _isPinch(lms) {
  // Thumb tip (4) close to index tip (8)
  const dx = lms[4].x - lms[8].x;
  const dy = lms[4].y - lms[8].y;
  return Math.sqrt(dx*dx + dy*dy) < 0.07;
}

// ─── Gesture dispatcher ───────────────────────────────────────────────────────
function _dispatch(gesture, lms) {
  const x = _lockedX, y = _lockedY;
  const vel = _swipeVelocity();

  switch (gesture) {

    // ── MOVE ─────────────────────────────────────────────────────────────────
    case "MOVE":
      // In keyboard mode, MOVE navigates keys instead of moving cursor
      if (_kbMode) { _kbNavigate(x, y); break; }
      // Swipe left/right with 1 finger = switch tab
      if (vel && Math.abs(vel.dx) > 1.8 && Math.abs(vel.dx) > Math.abs(vel.dy)*2 && _tabCd === 0) {
        sendToExtension("switch_tab", { direction: vel.dx < 0 ? "left" : "right" });
        _tabCd = 25; _tipHistory = [];
      }
      break;

    // ── SCROLL ───────────────────────────────────────────────────────────────
    case "SCROLL":
      if (_scrollCd === 0) {
        // Swipe left/right with 2 fingers = back/forward
        if (vel && Math.abs(vel.dx) > 2.0 && Math.abs(vel.dx) > Math.abs(vel.dy)*1.5 && _backCd === 0) {
          sendToExtension("nav_history", { direction: vel.dx < 0 ? "back" : "forward" });
          _backCd = 30; _scrollCd = 10; _tipHistory = [];
          break;
        }
        // Vertical scroll
        const tip = lms[8];
        const dy = tip.y - 0.5;
        if (Math.abs(dy) > 0.05) {
          sendToExtension("scroll", {
            direction: dy > 0 ? "down" : "up",
            amount: Math.round(Math.abs(dy) * 900),
          });
          _scrollCd = 4;
        }
      }
      break;

    // ── CLICK ────────────────────────────────────────────────────────────────
    case "CLICK":
      if (_kbMode && _kbToggleCd === 0) {
        _kbPress(); _clickCd = 22; break;
      }
      if (_clickCd === 0) {
        sendToExtension("gesture_click", { x, y });
        _clickCd = 24;
      }
      break;

    // ── RIGHT-CLICK (thumb only) ─────────────────────────────────────────────
    case "RCLICK":
      if (_rclickCd === 0) {
        sendToExtension("right_click", { x, y });
        _rclickCd = 30;
      }
      break;

    // ── DRAG (thumb + index) ─────────────────────────────────────────────────
    case "DRAG":
      if (_dragCd === 0) {
        if (!_dragging) {
          _dragging = true;
          _dragStartX = x; _dragStartY = y;
          _dragFrames = 0;
          sendToExtension("drag_start", { x, y });
        } else {
          _dragFrames++;
          if (_dragFrames % 3 === 0) {  // throttle drag updates
            sendToExtension("drag_move", { x, y });
          }
        }
      }
      break;

    // ── MIDDLE-CLICK (4 fingers, no thumb) ───────────────────────────────────
    case "4F":
      if (_clickCd === 0) {
        sendToExtension("middle_click", { x, y });
        _clickCd = 30;
      }
      break;

    // ── PINCH → toggle keyboard ──────────────────────────────────────────────
    case "PINCH":
      if (_pinchCd === 0) {
        _toggleKeyboard();
        _pinchCd = 35;
      }
      break;

    // ── OPEN PALM → scroll to top ─────────────────────────────────────────────
    case "PALM":
      if (_scrollCd === 0) {
        sendToExtension("scroll", { direction: "top", amount: 0 });
        _scrollCd = 30;
      }
      break;

    // ── FIST → lock cursor (cursor stays, no movement) ───────────────────────
    case "FIST":
      // End drag if was dragging
      if (_dragging) {
        sendToExtension("drag_end", { x, y });
        _dragging = false; _dragFrames = 0;
        _dragCd = 20;
      }
      break;
  }

  // Cancel drag if gesture changed away from DRAG
  if (gesture !== "DRAG" && _dragging) {
    sendToExtension("drag_end", { x, y });
    _dragging = false; _dragFrames = 0;
    _dragCd = 10;
  }
}

// ─── Keyboard ─────────────────────────────────────────────────────────────────
// The keyboard itself renders in the TARGET TAB via the extension injection.
// We only show a tiny HUD on the camera canvas showing the current selection.

const KB_ROWS_LOWER = [
  ["q","w","e","r","t","y","u","i","o","p"],
  ["a","s","d","f","g","h","j","k","l","⌫"],
  ["z","x","c","v","b","n","m"," ","↵","⇧"],
];
const KB_ROWS_UPPER = [
  ["Q","W","E","R","T","Y","U","I","O","P"],
  ["A","S","D","F","G","H","J","K","L","⌫"],
  ["Z","X","C","V","B","N","M"," ","↵","⇧"],
];
function _kbRows() { return _kbShift ? KB_ROWS_UPPER : KB_ROWS_LOWER; }

function _toggleKeyboard() {
  _kbMode = !_kbMode;
  if (_kbMode) {
    // Tell target tab to show keyboard overlay
    sendToExtension("show_keyboard", { rows: _kbRows(), row: _kbRow, col: _kbCol });
    _drawKbHud();
  } else {
    sendToExtension("hide_keyboard", {});
    _kbCanvas?.remove(); _kbCanvas = null; _kbCtx = null;
  }
}

function _drawKbHud() {
  // Small HUD on camera canvas showing current key
  if (!_canvas) return;
  const parent = _canvas.parentElement;
  if (!parent) return;
  if (!_kbCanvas) {
    _kbCanvas = document.createElement("canvas");
    _kbCanvas.className = "gesture-keyboard-hud";
    _kbCanvas.width  = _canvas.width;
    _kbCanvas.height = 30;
    Object.assign(_kbCanvas.style, {
      position: "absolute", bottom: "0", left: "0",
      width: "100%", height: "30px",
      pointerEvents: "none", zIndex: "11",
    });
    parent.appendChild(_kbCanvas);
    _kbCtx = _kbCanvas.getContext("2d");
  }
  const C = _kbCtx, W = _kbCanvas.width;
  C.clearRect(0, 0, W, 30);
  C.fillStyle = "rgba(2,6,23,0.88)";
  C.fillRect(0, 0, W, 30);
  const rows = _kbRows();
  const key = rows[_kbRow]?.[_kbCol] ?? "?";
  const disp = key === " " ? "SPACE" : key === "↵" ? "ENTER" : key === "⌫" ? "BKSP" : key.toUpperCase();
  C.fillStyle = "#38bdf8"; C.font = "bold 13px monospace";
  C.textAlign = "left"; C.textBaseline = "middle";
  C.fillText("⌨️  Selected: " + disp + "  [3-finger = type]", 8, 15);
}

// Called on MOVE gesture while in kb mode — navigate keys
function _kbNavigate(nx, ny) {
  const col = Math.floor(nx * 10);
  const row = Math.floor(ny * 3);
  const newRow = Math.max(0, Math.min(2, row));
  const newCol = Math.max(0, Math.min(9, col));
  if (newRow !== _kbRow || newCol !== _kbCol) {
    _kbRow = newRow; _kbCol = newCol;
    sendToExtension("kb_highlight", { row: _kbRow, col: _kbCol });
    _drawKbHud();
  }
}

function _kbPress() {
  const rows = _kbRows();
  const key  = rows[_kbRow]?.[_kbCol];
  if (!key) return;
  if (key === "⇧") { _kbShift = !_kbShift; sendToExtension("show_keyboard", { rows: _kbRows(), row: _kbRow, col: _kbCol }); return; }
  let send = key;
  if (key === "⌫") send = "Backspace";
  if (key === " ") send = " ";
  if (key === "↵") send = "Enter";
  sendToExtension("key", { key: send });
  if (_kbShift && key.length === 1) _kbShift = false; // auto-unshift after one char
  _drawKbHud();
}
