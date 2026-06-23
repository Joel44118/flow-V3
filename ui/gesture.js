// ui/gesture.js (v6)
// Uses @mediapipe/hands from unpkg — model assets are co-located on unpkg,
// no Kaggle/storage.googleapis URLs, no signed URL expiry issues.

import { sendToExtension } from "./screencontrol.js";

const MP_HANDS = "https://unpkg.com/@mediapipe/hands@0.4.1675469240/hands.js";
const MP_DRAW  = "https://unpkg.com/@mediapipe/drawing_utils@0.3.1675466124/drawing_utils.js";
const MP_BASE  = "https://unpkg.com/@mediapipe/hands@0.4.1675469240/";

let _chat = null, _orb = null, _running = false;
let _hands = null, _rafId = null, _videoEl = null;
let _canvas = null, _ctx = null, _processing = false;
let _smoothX = 0.5, _smoothY = 0.5;
const SMOOTH = 0.25;
let _lastCursorSend = 0;
const CURSOR_MS = 120;
let _lastGesture = "", _gestureFrames = 0;
let _scrollCd = 0, _clickCd = 0;

export function initGesture(chat, orb) { _chat = chat; _orb = orb; }

export const Gesture = {
  async start(videoEl) {
    if (_running) { this.stop(); return; }
    if (!videoEl) {
      _chat?.addError("Open camera first, then say 'start gesture control'.");
      return;
    }
    if (videoEl.videoWidth === 0) {
      await new Promise(r => { videoEl.addEventListener("loadeddata", r, { once: true }); setTimeout(r, 3000); });
    }
    _videoEl = videoEl;
    _chat?.add("🖐 Loading gesture model...\n\n**1 finger** — move cursor\n**2 fingers** — scroll\n**3 fingers** — click\n**Fist** — pause", "bot");
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
    _canvas?.remove(); _canvas = null; _ctx = null;
    _videoEl = null; _processing = false;
    _smoothX = 0.5; _smoothY = 0.5;
    _lastGesture = ""; _gestureFrames = 0; _scrollCd = 0; _clickCd = 0;
    _chat?.add("Gesture control off.", "bot");
  },
  isRunning() { return _running; },
};

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
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Load failed: " + src));
    document.head.appendChild(s);
  });
}

async function _initHands() {
  _hands = new window.Hands({ locateFile: f => MP_BASE + f });
  _hands.setOptions({ maxNumHands: 1, modelComplexity: 0, minDetectionConfidence: 0.7, minTrackingConfidence: 0.5 });
  _hands.onResults(_onResults);
  await _hands.send({ image: _videoEl }); // triggers model download
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
  if (window.getComputedStyle(parent).position === "static") parent.style.position = "relative";
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

const CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],
  [0,9],[9,10],[10,11],[11,12],[0,13],[13,14],[14,15],[15,16],
  [0,17],[17,18],[18,19],[19,20],[5,9],[9,13],[13,17],
];

function _onResults(r) {
  _processing = false;
  if (!_ctx || !_running) return;
  const W = _canvas.width, H = _canvas.height;
  _ctx.clearRect(0, 0, W, H);

  const lms = r.multiHandLandmarks?.[0];
  if (!lms) { _lastGesture = ""; _gestureFrames = 0; return; }

  // Draw skeleton using drawing_utils if available, else manually
  if (window.drawConnectors && window.HAND_CONNECTIONS) {
    window.drawConnectors(_ctx, lms, window.HAND_CONNECTIONS, { color: "rgba(56,189,248,0.7)", lineWidth: 2 });
    window.drawLandmarks(_ctx, lms, { color: "#38bdf8", lineWidth: 1, radius: 4 });
  } else {
    // Manual fallback
    _ctx.strokeStyle = "rgba(56,189,248,0.7)"; _ctx.lineWidth = 2;
    for (const [a, b] of CONNECTIONS) {
      _ctx.beginPath();
      _ctx.moveTo(lms[a].x * W, lms[a].y * H);
      _ctx.lineTo(lms[b].x * W, lms[b].y * H);
      _ctx.stroke();
    }
    _ctx.fillStyle = "#38bdf8";
    for (const p of lms) { _ctx.beginPath(); _ctx.arc(p.x*W, p.y*H, 4, 0, Math.PI*2); _ctx.fill(); }
  }

  const fingers = _countFingers(lms);
  const gesture = fingers + "f";
  if (gesture === _lastGesture) _gestureFrames++;
  else {
    _lastGesture = gesture; _gestureFrames = 1;
    if (fingers !== 2) _scrollCd = 0;
    if (fingers !== 3) _clickCd = Math.min(_clickCd, 3);
  }

  const tip = lms[8];
  _smoothX += (tip.x - _smoothX) * SMOOTH;
  _smoothY += (tip.y - _smoothY) * SMOOTH;

  // Tip dot
  _ctx.beginPath(); _ctx.arc(_smoothX*W, _smoothY*H, 8, 0, Math.PI*2);
  _ctx.fillStyle = fingers===3?"#34d399":fingers===2?"#f59e0b":"#38bdf8";
  _ctx.strokeStyle="white"; _ctx.lineWidth=2; _ctx.fill(); _ctx.stroke();

  const label = {1:"MOVE",2:"SCROLL",3:"CLICK"}[fingers];
  if (label) {
    _ctx.fillStyle="rgba(2,6,23,0.8)"; _ctx.fillRect(4,4,84,20);
    _ctx.fillStyle="#38bdf8"; _ctx.font="bold 11px monospace";
    _ctx.fillText("✋ "+label, 8, 18);
  }

  if (_scrollCd>0) _scrollCd--;
  if (_clickCd>0)  _clickCd--;
  if (_gestureFrames < 3) return;
  _dispatch(fingers, _smoothX, _smoothY);
}

function _dispatch(f, x, y) {
  if (f === 1) {
    const now = Date.now();
    if (now - _lastCursorSend < CURSOR_MS) return;
    _lastCursorSend = now;
    sendToExtension("cursor_move", {x, y}); return;
  }
  if (f === 2 && _scrollCd === 0) {
    const dy = y - 0.5; if (Math.abs(dy) < 0.08) return;
    sendToExtension("scroll", { direction: dy>0?"down":"up", amount: Math.round(Math.abs(dy)*700) });
    _scrollCd = 6; return;
  }
  if (f === 3 && _clickCd === 0) {
    sendToExtension("gesture_click", {x, y});
    _clickCd = 24;
  }
}

function _countFingers(lms) {
  if (!lms || lms.length < 21) return 0;
  let c = 0;
  if (Math.abs(lms[4].x - lms[3].x) > 0.06) c++;
  const tips=[8,12,16,20], pips=[6,10,14,18];
  for (let i=0;i<4;i++) { if (lms[tips[i]].y < lms[pips[i]].y - 0.025) c++; }
  return c;
}
