// ui/gesture.js (v15)
// FIXES:
// - EMA smoothing on all landmarks — eliminates wobble
// - Strict gesture state machine — point vs pinch vs scroll never bleed
// - Purple skeleton (#a78bfa) + cyan joints (#38bdf8)
// - Electron IPC for OS cursor when available, extension fallback for browser

import { sendToExtension } from './screencontrol.js';

export const Gesture = {};
let _Chat = null, _Orb = null;
export function initGesture(Chat, Orb) {
  _Chat = Chat; _Orb = Orb;
  Gesture.Chat = Chat; Gesture.Orb = Orb;
}

let _video = null, _canvas = null, _ctx = null;
let _hands = null, _camera = null, _animId = null;
let _active = false, _wrapper = null;

// ── EMA smoothing ─────────────────────────────────────────────────────────
// Reduces landmark jitter without adding lag
const EMA_ALPHA = 0.35;  // lower = smoother but laggier; 0.35 is a good balance
let _smoothed = null;    // smoothed landmark array, same shape as MediaPipe output

function _smooth(landmarks) {
  if (!_smoothed || _smoothed.length !== landmarks.length) {
    // First frame — initialise directly
    _smoothed = landmarks.map(p => ({ x: p.x, y: p.y, z: p.z }));
    return _smoothed;
  }
  for (let i = 0; i < landmarks.length; i++) {
    _smoothed[i].x += EMA_ALPHA * (landmarks[i].x - _smoothed[i].x);
    _smoothed[i].y += EMA_ALPHA * (landmarks[i].y - _smoothed[i].y);
    _smoothed[i].z += EMA_ALPHA * ((landmarks[i].z || 0) - (_smoothed[i].z || 0));
  }
  return _smoothed;
}

// ── Gesture state machine ─────────────────────────────────────────────────
// States: IDLE → POINTING → PINCH_HOLD → SCROLL → PALM
// Strict transitions prevent bleed between gestures
const STATE = { IDLE: 0, POINTING: 1, PINCH_HOLD: 2, SCROLL: 3, PALM: 4 };
let _state          = STATE.IDLE;
let _pinchFrames    = 0;      // consecutive frames thumb+index are close
let _releasedFrames = 0;      // consecutive frames pinch is open (debounce)
let _pinchAnchorY   = null;   // y at which pinch started (for scroll delta)
let _lastScrollDir  = null;
let _palmCooldown   = 0;
let _curX           = 0.5;    // normalised cursor position (0..1)
let _curY           = 0.5;

// Tuning constants — tested values
const PINCH_ON_DIST    = 0.048;  // thumb-index dist to enter pinch
const PINCH_OFF_DIST   = 0.072;  // must open wider than this to exit pinch
const CLICK_FRAMES_MIN = 8;      // hold pinch this many frames for click
const SCROLL_TRIGGER_Y = 0.055;  // y-travel while pinched before entering scroll
const SCROLL_STEP      = 100;    // pixels per scroll event
const RELEASE_FRAMES   = 4;      // open frames before exiting pinch state
const POINT_MIN_EXT    = 1;      // at least 1 finger extended to move cursor
const POINT_MAX_EXT    = 2;      // allow 1 or 2 fingers for pointing

const PROXY = '/api/mediapipe?f=';
const IS_ELECTRON = !!window.__flowElectron;

function _sendGesture(action, payload) {
  if (IS_ELECTRON) window.__flowElectron.send(action, payload);
  else sendToExtension(action, payload);
}

// ── Script loader ─────────────────────────────────────────────────────────
function _loadScript(filename) {
  const src = PROXY + filename;
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-mp="${filename}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src; s.dataset.mp = filename; s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load: ${filename}`));
    document.head.appendChild(s);
  });
}

// ── START ─────────────────────────────────────────────────────────────────
export async function start(videoEl) {
  try {
    if (_active) return;
    _active = true;
    _video  = videoEl;
    _smoothed = null;
    _state    = STATE.IDLE;

    if (_Chat) _Chat.add(
      '🎥 **Gesture Control Loading...**\n\n' +
      (IS_ELECTRON ? '🖥️ **Electron mode** — controls OS cursor\n\n' : '') +
      '**Gestures:**\n' +
      '☝️ **1–2 fingers** = Move cursor\n' +
      '🤏 **Pinch & hold** = Click\n' +
      '🤏↕ **Pinch & slide** = Scroll\n' +
      '✋ **Open palm** = Right-click\n\n' +
      '_Loading MediaPipe..._', 'bot');

    await _loadScript('hands.js');
    await _loadScript('camera_utils.js');
    if (!window.Hands || !window.Camera) throw new Error('MediaPipe not available after load');

    // Canvas wrapper — appended INSIDE the video's parent (vision-window div)
    // using inset:0 so it perfectly overlays the video regardless of where
    // the floating window is on screen.
    // NEVER use offsetLeft/offsetTop here — vision-window is position:fixed
    // so those values are always 0 → causes the jump-to-far-left bug.
    const videoParent = _video.parentElement;  // the .vision-window div
    videoParent.style.position = 'relative';

    const vw = _video.offsetWidth  || 320;
    const vh = _video.offsetHeight || 240;

    _wrapper = document.createElement('div');
    Object.assign(_wrapper.style, {
      position: 'absolute', pointerEvents: 'none', zIndex: '10000',
      inset: '0',           // fills the container perfectly, no coordinate math
    });
    videoParent.appendChild(_wrapper);  // child of vision-window, not a sibling

    _canvas = document.createElement('canvas');
    // Use actual video resolution once loaded; fall back to offsetWidth
    _canvas.width  = _video.videoWidth  || vw;
    _canvas.height = _video.videoHeight || vh;
    Object.assign(_canvas.style, {
      position: 'absolute', top: 0, left: 0, width: '100%', height: '100%'
    });
    _ctx = _canvas.getContext('2d', { willReadFrequently: true });
    _wrapper.appendChild(_canvas);

    _hands = new window.Hands({ locateFile: f => PROXY + f });
    _hands.setOptions({
      maxNumHands: 1,
      modelComplexity: 1,
      minDetectionConfidence: 0.7,
      minTrackingConfidence: 0.6,
    });
    _hands.onResults(_onResults);

    _camera = new window.Camera(_video, {
      onFrame: async () => { if (_active) await _hands.send({ image: _video }); },
      width: 640, height: 480,
    });
    await _camera.start();

    if (_Chat) _Chat.add(
      '✅ **Gesture Control Ready!**\n\n' +
      '• ☝️ Point (1–2 fingers) → move cursor\n' +
      '• 🤏 Pinch + hold still → click\n' +
      '• 🤏↕ Pinch + slide up/down → scroll\n' +
      '• ✋ Open palm → right-click\n\n' +
      '_Say "stop gesture control" to exit._', 'bot');

    _animate();
  } catch (err) {
    console.error('[Gesture]', err.message);
    if (_Chat) _Chat.add(`⚠️ Gesture setup failed: ${err.message}`, 'bot');
    _active = false;
    throw err;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function _dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function _countExtended(lm) {
  // Thumb: compare tip x vs IP x (mirrored video)
  const thumbExt = lm[4].x < lm[3].x;
  let n = thumbExt ? 1 : 0;
  // Other fingers: tip y < pip y means extended
  const tips = [8, 12, 16, 20];
  const pips = [6, 10, 14, 18];
  for (let i = 0; i < tips.length; i++) {
    if (lm[tips[i]].y < lm[pips[i]].y) n++;
  }
  return n;
}

// ── Results handler ───────────────────────────────────────────────────────
function _onResults(results) {
  if (!_active || !_canvas) return;
  _ctx.clearRect(0, 0, _canvas.width, _canvas.height);

  const raw = results.multiHandLandmarks?.[0];
  if (!raw) {
    _smoothed = null;
    _state = STATE.IDLE;
    _pinchFrames = 0; _releasedFrames = 0;
    _drawLabel('👋 Show hand');
    return;
  }

  const lm  = _smooth(raw);   // EMA-smoothed landmarks
  const ext = _countExtended(lm);
  const pd  = _dist(lm[4], lm[8]);  // thumb-index distance
  const sw  = IS_ELECTRON ? screen.width  : window.innerWidth;
  const sh  = IS_ELECTRON ? screen.height : window.innerHeight;

  // ── State machine ────────────────────────────────────────────────────
  switch (_state) {

    case STATE.IDLE:
    case STATE.POINTING: {
      if (pd < PINCH_ON_DIST) {
        // Entering pinch
        _state = STATE.PINCH_HOLD;
        _pinchFrames  = 1;
        _releasedFrames = 0;
        _pinchAnchorY = lm[8].y;
      } else if (ext === 5 && _palmCooldown <= 0) {
        // Open palm
        _state = STATE.PALM;
        _sendGesture('right_click', { x: Math.round(_curX * sw), y: Math.round(_curY * sh) });
        _palmCooldown = 30;
        setTimeout(() => { _state = STATE.IDLE; }, 500);
      } else if (ext >= POINT_MIN_EXT && ext <= POINT_MAX_EXT) {
        // Pointing — update cursor
        _state = STATE.POINTING;
        _curX = lm[8].x;
        _curY = lm[8].y;
        _sendGesture('cursor_move', {
          x: Math.round(_curX * sw),
          y: Math.round(_curY * sh),
        });
      } else {
        _state = STATE.IDLE;
      }
      break;
    }

    case STATE.PINCH_HOLD: {
      if (pd > PINCH_OFF_DIST) {
        _releasedFrames++;
        if (_releasedFrames >= RELEASE_FRAMES) {
          // Pinch released — fire click if we never entered scroll
          _sendGesture('gesture_click', {
            x: Math.round(_curX * sw),
            y: Math.round(_curY * sh),
          });
          _state = STATE.IDLE;
          _pinchFrames = 0; _releasedFrames = 0;
          _pinchAnchorY = null;
        }
      } else {
        _releasedFrames = 0;
        _pinchFrames++;
        const dy = lm[8].y - _pinchAnchorY;
        if (Math.abs(dy) > SCROLL_TRIGGER_Y) {
          // Slid enough — switch to scroll mode
          _state = STATE.SCROLL;
          _lastScrollDir = dy < 0 ? 'up' : 'down';
        }
      }
      break;
    }

    case STATE.SCROLL: {
      if (pd > PINCH_OFF_DIST) {
        _releasedFrames++;
        if (_releasedFrames >= RELEASE_FRAMES) {
          _state = STATE.IDLE;
          _pinchFrames = 0; _releasedFrames = 0;
          _pinchAnchorY = null;
        }
      } else {
        _releasedFrames = 0;
        const dy = lm[8].y - _pinchAnchorY;
        const dir = dy < 0 ? 'up' : 'down';
        _lastScrollDir = dir;
        _sendGesture('scroll', { direction: dir, amount: SCROLL_STEP });
      }
      break;
    }

    case STATE.PALM:
      // Wait for cooldown to reset (handled above)
      break;
  }

  if (_palmCooldown > 0) _palmCooldown--;

  // ── Draw ─────────────────────────────────────────────────────────────
  _drawSkeleton(lm);
  _drawCursor();
  _drawLabel(_stateLabel(ext, pd));
}

function _stateLabel(ext, pd) {
  switch (_state) {
    case STATE.POINTING:   return `☝️ ${ext} finger${ext !== 1 ? 's' : ''}`;
    case STATE.PINCH_HOLD: return `🤏 Hold to click…`;
    case STATE.SCROLL:     return `↕ Scroll ${_lastScrollDir || ''}`;
    case STATE.PALM:       return `✋ Right-click`;
    default:               return `${ext} finger${ext !== 1 ? 's' : ''}`;
  }
}

// ── Draw helpers ──────────────────────────────────────────────────────────
const CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [0,9],[9,10],[10,11],[11,12],
  [0,13],[13,14],[14,15],[15,16],
  [0,17],[17,18],[18,19],[19,20],
  [5,9],[9,13],[13,17],
];

function _drawSkeleton(lm) {
  const cw = _canvas.width, ch = _canvas.height;
  // Bones — Flow purple
  _ctx.strokeStyle = '#a78bfa';
  _ctx.lineWidth   = 2.5;
  _ctx.lineCap     = 'round';
  for (const [s, e] of CONNECTIONS) {
    _ctx.beginPath();
    _ctx.moveTo(lm[s].x * cw, lm[s].y * ch);
    _ctx.lineTo(lm[e].x * cw, lm[e].y * ch);
    _ctx.stroke();
  }
  // Joints — cyan
  for (const p of lm) {
    const x = p.x * cw, y = p.y * ch;
    _ctx.fillStyle = '#38bdf8';
    _ctx.beginPath(); _ctx.arc(x, y, 4.5, 0, Math.PI * 2); _ctx.fill();
    // White core
    _ctx.fillStyle = 'rgba(255,255,255,0.9)';
    _ctx.beginPath(); _ctx.arc(x, y, 1.8, 0, Math.PI * 2); _ctx.fill();
  }
  // Fingertip highlight — slightly bigger
  for (const tip of [4, 8, 12, 16, 20]) {
    const x = lm[tip].x * cw, y = lm[tip].y * ch;
    _ctx.strokeStyle = '#a78bfa';
    _ctx.lineWidth   = 1.5;
    _ctx.beginPath(); _ctx.arc(x, y, 7, 0, Math.PI * 2); _ctx.stroke();
  }
}

function _drawCursor() {
  const cx = _curX * _canvas.width;
  const cy = _curY * _canvas.height;
  const pinching = _state === STATE.PINCH_HOLD || _state === STATE.SCROLL;
  const scrolling = _state === STATE.SCROLL;

  const color = scrolling  ? '#facc15'
              : pinching   ? '#4ade80'
              : '#a78bfa';

  // Outer ring
  _ctx.strokeStyle = color;
  _ctx.lineWidth   = 2.5;
  _ctx.globalAlpha = 0.85;
  _ctx.beginPath(); _ctx.arc(cx, cy, pinching ? 18 : 13, 0, Math.PI * 2); _ctx.stroke();
  // Fill
  _ctx.fillStyle   = color;
  _ctx.globalAlpha = 0.2;
  _ctx.beginPath(); _ctx.arc(cx, cy, pinching ? 18 : 13, 0, Math.PI * 2); _ctx.fill();
  // Inner dot
  _ctx.globalAlpha = 1;
  _ctx.fillStyle   = '#fff';
  _ctx.beginPath(); _ctx.arc(cx, cy, 3.5, 0, Math.PI * 2); _ctx.fill();
}

function _drawLabel(text) {
  _ctx.globalAlpha = 1;
  // Pill background
  const metrics = _ctx.measureText(text);
  const pw = metrics.width + 20, ph = 26, px = 8, py = 8;
  _ctx.fillStyle = 'rgba(0,0,0,0.45)';
  _roundRect(px, py, pw, ph, 8);
  _ctx.fill();
  // Text
  _ctx.fillStyle = '#a78bfa';
  _ctx.font      = 'bold 13px system-ui,sans-serif';
  _ctx.textAlign = 'left';
  _ctx.textBaseline = 'middle';
  _ctx.fillText(text, px + 10, py + ph / 2);
  _ctx.textBaseline = 'alphabetic';
}

function _roundRect(x, y, w, h, r) {
  _ctx.beginPath();
  _ctx.moveTo(x + r, y);
  _ctx.lineTo(x + w - r, y);
  _ctx.arcTo(x + w, y, x + w, y + r, r);
  _ctx.lineTo(x + w, y + h - r);
  _ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  _ctx.lineTo(x + r, y + h);
  _ctx.arcTo(x, y + h, x, y + h - r, r);
  _ctx.lineTo(x, y + r);
  _ctx.arcTo(x, y, x + r, y, r);
  _ctx.closePath();
}

function _animate() { if (_active) _animId = requestAnimationFrame(_animate); }

export function stop() {
  _active = false;
  if (_animId)  cancelAnimationFrame(_animId);
  if (_camera)  _camera.stop();
  if (_wrapper) _wrapper.remove();
  _smoothed = null;
  _state    = STATE.IDLE;
  _video = _canvas = _ctx = _hands = _camera = _wrapper = null;
}

Gesture.start = start;
Gesture.stop  = stop;
