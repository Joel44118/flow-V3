// ui/gesture.js (v5) — TF.js hand-pose-detection, fixed skeleton scaling

import { sendToExtension } from "./screencontrol.js";

const TF_CORE  = "https://cdnjs.cloudflare.com/ajax/libs/tensorflow/4.20.0/tf.min.js";
const TF_HANDS = "https://cdn.jsdelivr.net/npm/@tensorflow-models/hand-pose-detection@2.0.1/dist/hand-pose-detection.min.js";

let _chat = null, _orb = null, _running = false;
let _detector = null, _rafId = null, _videoEl = null;
let _canvas = null, _ctx = null, _lastVideoTime = -1;
let _smoothX = 0.5, _smoothY = 0.5;
const SMOOTH = 0.28;
let _lastCursorSend = 0;
const CURSOR_INTERVAL = 100;
let _lastGesture = "", _gestureFrames = 0;
let _scrollCooldown = 0, _clickCooldown = 0;

export function initGesture(chat, orb) { _chat = chat; _orb = orb; }

export const Gesture = {
  async start(videoEl) {
    if (_running) { this.stop(); return; }
    if (!videoEl) {
      _chat?.addError("Open camera first, then say 'start gesture control'.");
      return;
    }
    // Wait until video has real dimensions
    await new Promise(r => {
      if (videoEl.videoWidth > 0) { r(); return; }
      videoEl.addEventListener("loadeddata", r, { once: true });
      setTimeout(r, 3000);
    });
    _videoEl = videoEl;
    _chat?.add("🖐 Gesture control loading (~5MB first time)...\n\n**1 finger** — move cursor\n**2 fingers** — scroll\n**3 fingers** — click\n**Fist** — pause", "bot");
    try {
      await _loadLibs();
      await _initDetector();
    } catch(e) {
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
    _detector?.dispose?.(); _detector = null;
    _canvas?.remove(); _canvas = null; _ctx = null; _videoEl = null;
    _lastVideoTime = -1; _smoothX = 0.5; _smoothY = 0.5;
    _lastGesture = ""; _gestureFrames = 0; _scrollCooldown = 0; _clickCooldown = 0;
    _chat?.add("Gesture control off.", "bot");
  },
  isRunning() { return _running; },
};

function _loadScript(src, testFn) {
  return new Promise((resolve, reject) => {
    if (testFn()) { resolve(); return; }
    if (document.querySelector(`script[src="${src}"]`)) {
      const p = setInterval(() => { if (testFn()) { clearInterval(p); resolve(); } }, 150);
      setTimeout(() => { clearInterval(p); testFn() ? resolve() : reject(new Error("Timeout: " + src)); }, 25000);
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.onload  = () => resolve();
    s.onerror = () => reject(new Error("Failed: " + src));
    document.head.appendChild(s);
  });
}

async function _loadLibs() {
  await _loadScript(TF_CORE,  () => !!window.tf);
  await _loadScript(TF_HANDS, () => !!window.handPoseDetection);
}

async function _initDetector() {
  const model  = window.handPoseDetection.SupportedModels.MediaPipeHands;
  _detector = await window.handPoseDetection.createDetector(model, {
    runtime: "tfjs", modelType: "lite", maxHands: 1,
  });
}

function _setupCanvas() {
  const parent = _videoEl?.parentElement;
  if (!parent) return;
  parent.querySelector(".gesture-canvas")?.remove();
  _canvas = document.createElement("canvas");
  _canvas.className = "gesture-canvas";
  // Match actual video display size
  const rect = _videoEl.getBoundingClientRect();
  _canvas.width  = rect.width  || _videoEl.videoWidth  || 320;
  _canvas.height = rect.height || _videoEl.videoHeight || 240;
  Object.assign(_canvas.style, {
    position:"absolute", top:"0", left:"0", width:"100%", height:"100%",
    pointerEvents:"none", zIndex:"10", borderRadius:"inherit",
  });
  if (window.getComputedStyle(parent).position === "static") parent.style.position = "relative";
  parent.appendChild(_canvas);
  _ctx = _canvas.getContext("2d");
}

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

const CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],
  [0,9],[9,10],[10,11],[11,12],[0,13],[13,14],[14,15],[15,16],
  [0,17],[17,18],[18,19],[19,20],[5,9],[9,13],[13,17],
];

function _onHands(hands) {
  if (!_ctx || !_running) return;
  const W = _canvas.width, H = _canvas.height;
  _ctx.clearRect(0, 0, W, H);

  const hand = hands?.[0];
  if (!hand?.keypoints?.length) {
    _lastGesture = ""; _gestureFrames = 0; return;
  }

  // keypoints are in VIDEO pixel space — scale to canvas size
  const scaleX = W / (_videoEl.videoWidth  || W);
  const scaleY = H / (_videoEl.videoHeight || H);
  const kp = hand.keypoints.map(p => ({ x: p.x * scaleX, y: p.y * scaleY }));

  // Draw skeleton
  _ctx.strokeStyle = "rgba(56,189,248,0.6)"; _ctx.lineWidth = 1.5;
  for (const [a, b] of CONNECTIONS) {
    if (!kp[a] || !kp[b]) continue;
    _ctx.beginPath(); _ctx.moveTo(kp[a].x, kp[a].y); _ctx.lineTo(kp[b].x, kp[b].y); _ctx.stroke();
  }
  _ctx.fillStyle = "#38bdf8";
  for (const p of kp) { _ctx.beginPath(); _ctx.arc(p.x, p.y, 3, 0, Math.PI*2); _ctx.fill(); }

  // Normalise to 0-1 for gesture logic
  const norm = hand.keypoints.map(p => ({ x: p.x / (_videoEl.videoWidth||320), y: p.y / (_videoEl.videoHeight||240) }));
  const fingers = _countFingers(norm);
  const gesture = fingers + "f";

  if (gesture === _lastGesture) _gestureFrames++;
  else { _lastGesture = gesture; _gestureFrames = 1; if (fingers!==2) _scrollCooldown=0; if (fingers!==3) _clickCooldown=Math.min(_clickCooldown,3); }

  const tip = norm[8] || norm[0];
  _smoothX += (tip.x - _smoothX) * SMOOTH;
  _smoothY += (tip.y - _smoothY) * SMOOTH;

  // Tip dot
  _ctx.beginPath(); _ctx.arc(_smoothX*W, _smoothY*H, 7, 0, Math.PI*2);
  _ctx.fillStyle = fingers===3?"#34d399":fingers===2?"#f59e0b":"#38bdf8";
  _ctx.strokeStyle="rgba(255,255,255,0.9)"; _ctx.lineWidth=2; _ctx.fill(); _ctx.stroke();

  // Label — only show non-PAUSE states
  const labels = {1:"MOVE",2:"SCROLL",3:"CLICK"};
  if (labels[fingers]) {
    _ctx.fillStyle="rgba(2,6,23,0.78)"; _ctx.fillRect(4,4,80,20);
    _ctx.fillStyle="#38bdf8"; _ctx.font="bold 11px monospace";
    _ctx.fillText(`✋ ${labels[fingers]}`, 8, 18);
  }

  if (_scrollCooldown>0) _scrollCooldown--;
  if (_clickCooldown>0)  _clickCooldown--;
  if (_gestureFrames < 3) return;
  _dispatch(fingers, _smoothX, _smoothY);
}

function _dispatch(fingers, x, y) {
  if (fingers === 1) {
    const now = Date.now();
    if (now - _lastCursorSend < CURSOR_INTERVAL) return;
    _lastCursorSend = now;
    sendToExtension("cursor_move", { x, y }); return;
  }
  if (fingers === 2 && _scrollCooldown === 0) {
    const dy = y - 0.5; if (Math.abs(dy) < 0.08) return;
    sendToExtension("scroll", { direction: dy>0?"down":"up", amount: Math.round(Math.abs(dy)*700) });
    _scrollCooldown = 5; return;
  }
  if (fingers === 3 && _clickCooldown === 0) {
    sendToExtension("gesture_click", { x, y });
    _clickCooldown = 22;
  }
}

function _countFingers(norm) {
  if (norm.length < 21) return 0;
  let count = 0;
  if (Math.abs(norm[4].x - norm[3].x) > 0.06) count++;
  const tips=[8,12,16,20], pips=[6,10,14,18];
  for (let i=0; i<4; i++) { if (norm[tips[i]].y < norm[pips[i]].y - 0.025) count++; }
  return count;
}
