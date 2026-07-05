import { sendToExtension } from './screencontrol.js';
import { setRuntimeState } from '../core/runtime.js';

export const Gesture = {};
let _Chat = null, _Orb = null;
export function initGesture(Chat, Orb) {
  _Chat = Chat; _Orb = Orb;
  Gesture.Chat = Chat; Gesture.Orb = Orb;
}

let _video = null, _canvas = null, _ctx = null;
let _previewInterval = null;
let _hands = null, _camera = null, _animId = null;
let _active = false, _wrapper = null;
let _videoParent = null, _dragObserver = null;

// ── EMA smoothing ─────────────────────────────────────────────────────────
const EMA = 0.5;   // higher = snappier but slightly more jitter
let _smoothed = null;

function _smooth(lm) {
  if (!_smoothed || _smoothed.length !== lm.length) {
    _smoothed = lm.map(p => ({ x: p.x, y: p.y, z: p.z || 0 }));
    return _smoothed;
  }
  for (let i = 0; i < lm.length; i++) {
    _smoothed[i].x += EMA * (lm[i].x - _smoothed[i].x);
    _smoothed[i].y += EMA * (lm[i].y - _smoothed[i].y);
    _smoothed[i].z += EMA * ((lm[i].z || 0) - _smoothed[i].z);
  }
  return _smoothed;
}

// ── Gesture state machine ─────────────────────────────────────────────────
// IDLE → POINTING (1 finger) → PINCH_HOLD → (release) → click fired
//       → TWO_FINGER (scroll)
//       → PALM → right-click
const G = { IDLE: 0, POINTING: 1, PINCH_HOLD: 2, TWO_FINGER: 3, PALM: 4 };
let _state         = G.IDLE;
let _pinchFrames   = 0;
let _releaseFrames = 0;
let _palmCooldown  = 0;
let _twoFingerBase = null;  // y position where two-finger gesture started
let _curX = 0.5, _curY = 0.5;

// Constants
const PINCH_ON    = 0.045;   // thumb-index normalised distance to enter pinch
const PINCH_OFF   = 0.075;   // must open wider than this to exit pinch
const CLICK_HOLD  = 7;       // frames to hold pinch before firing click
const REL_FRAMES  = 4;       // open frames to confirm pinch released
const SCROLL_DEAD = 0.02;    // minimum y-travel for two-finger scroll trigger

const PROXY = '/api/mediapipe?f=';
const IS_ELECTRON = !!window.__flowElectron;

// Screen dimensions — resolved once, updated if Electron responds
let _sw = window.innerWidth;
let _sh = window.innerHeight;

async function _resolveScreenSize() {
  if (IS_ELECTRON) {
    try {
      const sz = await window.__flowElectron.getScreenSize();
      _sw = sz.width;
      _sh = sz.height;
      console.log('[Gesture] Electron screen:', _sw, 'x', _sh);
    } catch (_) {}
  } else {
    _sw = window.screen.width;
    _sh = window.screen.height;
  }
}

function _act(action, payload) {
  if (IS_ELECTRON) window.__flowElectron.send(action, payload);
  else             sendToExtension(action, payload);
}

function _loadScript(filename) {
  const src = PROXY + filename;
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-mp="${filename}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src; s.dataset.mp = filename; s.async = true;
    s.onload  = resolve;
    s.onerror = () => reject(new Error(`Failed to load: ${filename}`));
    document.head.appendChild(s);
  });
}

// Waits for the video element to report real, non-zero dimensions.
// Polls every 50ms, up to 2 seconds — if it genuinely never resolves
// (camera permission denied mid-stream, etc.), falls back to 320x240
// rather than hanging the whole gesture-start sequence forever.
async function _waitForVideoDimensions(video) {
  for (let i = 0; i < 40; i++) {
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      return { w: video.videoWidth, h: video.videoHeight };
    }
    await new Promise(r => setTimeout(r, 50));
  }
  console.warn('[Gesture] video dimensions never became available — falling back to 320x240');
  return { w: 320, h: 240 };
}

// ── START ─────────────────────────────────────────────────────────────────

// Sync canvas overlay position to match video element (handles dragging)
function _syncWrapperPos() {
  if (!_wrapper || !_video) return;
  const r = _video.getBoundingClientRect();
  Object.assign(_wrapper.style, {
    left:   r.left   + 'px',
    top:    r.top    + 'px',
    width:  r.width  + 'px',
    height: r.height + 'px',
  });
}

export async function start(videoEl) {
  try {
    if (_active) return;
    _active   = true;
    setRuntimeState('gestureActive', true);
    _video    = videoEl;
    _smoothed = null;
    _state    = G.IDLE;

    await _resolveScreenSize();

    if (_Chat) _Chat.add(
      '🎥 **Gesture Control Loading...**\n\n' +
      (IS_ELECTRON ? '🖥️ **Desktop mode** — controls OS cursor\n\n' : '') +
      '**Gestures:**\n' +
      '☝️ **1 finger** = Move cursor\n' +
      '🤏 **Pinch** = Click\n' +
      '✌️ **2 fingers swipe** = Scroll up/down\n' +
      '✋ **Open palm** = Right-click\n\n' +
      '_Loading MediaPipe..._', 'bot');

    await _loadScript('hands.js');
    await _loadScript('camera_utils.js');
    if (!window.Hands || !window.Camera) throw new Error('MediaPipe not available after load');

    // ── Canvas overlay ────────────────────────────────────────────────────
    // The vision-window is position:fixed — we CANNOT set position:relative on it
    // as that breaks its CSS layout. Instead we position the wrapper as fixed too,
    // matching the video element's bounding rect exactly using getBoundingClientRect.
    const videoParent = _video.parentElement;  // .vision-window div

    // Store reference so we can update position when window is dragged
    _videoParent = videoParent;

    const vw = _video.offsetWidth  || 320;
    const vh = _video.offsetHeight || 240;

    _wrapper = document.createElement('div');
    Object.assign(_wrapper.style, {
      position:      'fixed',
      pointerEvents: 'none',
      zIndex:        '10001',
    });
    _syncWrapperPos();  // set initial position
    document.body.appendChild(_wrapper);  // append to body, not inside vision-window

    _canvas = document.createElement('canvas');
    // videoWidth/videoHeight are genuinely 0 at this exact point — the
    // camera stream hasn't started producing frames yet when start() first
    // runs, it's still asynchronously initializing. Sizing the canvas off
    // that 0 (even with the `|| vw` fallback, since 0 is falsy so the
    // fallback DOES trigger — but vw/vh themselves come from
    // _video.offsetWidth/Height, which can ALSO still be 0 on a
    // freshly-inserted video element before layout has run) was producing
    // a canvas with zero real pixel area in practice: everything drawn
    // onto it "succeeds" with no error, but is completely invisible.
    // Fix: wait for the video to actually report real dimensions before
    // creating the canvas, with a bounded retry rather than trusting
    // whatever's available at this exact instant.
    const realVW = await _waitForVideoDimensions(_video);
    _canvas.width  = realVW.w;
    _canvas.height = realVW.h;
    Object.assign(_canvas.style, {
      position: 'absolute', top: 0, left: 0, width: '100%', height: '100%'
    });
    _ctx = _canvas.getContext('2d', { willReadFrequently: true });
    _wrapper.appendChild(_canvas);

    // Keep overlay in sync when vision-window is dragged
    _dragObserver = setInterval(_syncWrapperPos, 60);

    // ── MediaPipe Hands — complexity 0 for real-time speed ────────────────
    _hands = new window.Hands({ locateFile: f => PROXY + f });
    _hands.setOptions({
      maxNumHands:            1,
      modelComplexity:        0,    // 0 = fast, 1 = accurate — use 0 for real-time
      minDetectionConfidence: 0.65,
      minTrackingConfidence:  0.55,
    });
    _hands.onResults(_onResults);

    _camera = new window.Camera(_video, {
      onFrame: async () => { if (_active) await _hands.send({ image: _video }); },
      width: 640, height: 480,
    });
    await _camera.start();

    // Forward a small preview frame to the Electron overlay window so
    // there's an actual live camera-in-corner view visible across every
    // app on the PC — not just the tracking dot. A MediaStream can't be
    // shared directly across separate Electron BrowserWindows, so this
    // draws the video to a small offscreen canvas and sends JPEG frames
    // over IPC instead. 8fps is plenty for a preview thumbnail and keeps
    // this cheap — the actual hand-tracking loop above runs at full rate
    // independently of this.
    if (IS_ELECTRON) {
      const previewCanvas = document.createElement('canvas');
      previewCanvas.width = 160; previewCanvas.height = 120;
      const previewCtx = previewCanvas.getContext('2d');
      _previewInterval = setInterval(() => {
        if (!_active || !_video || _video.readyState < 2) return;
        try {
          previewCtx.drawImage(_video, 0, 0, 160, 120);
          window.__flowElectron.send('camera_frame', { dataUrl: previewCanvas.toDataURL('image/jpeg', 0.55) });
        } catch (_) {}
      }, 125); // ~8fps
    }

    if (_Chat) _Chat.add(
      '✅ **Gesture Control Ready!**\n\n' +
      '• ☝️ Point (1 finger) → move cursor\n' +
      '• 🤏 Pinch thumb+index → click\n' +
      '• ✌️ Two fingers + swipe up/down → scroll\n' +
      '• ✋ Open palm → right-click\n\n' +
      '_Say "stop gesture control" to exit._', 'bot');

    _animate();
    if (IS_ELECTRON) window.__flowElectron.send('gesture_start', {});
  } catch (err) {
    console.error('[Gesture]', err.message);
    if (_Chat) _Chat.add(`⚠️ Gesture setup failed: ${err.message}`, 'bot');
    _active = false;
    throw err;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function _d(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

// Count fingers: which fingertips are above their PIP joint
// Index=8, Middle=12, Ring=16, Pinky=20 / PIPs: 6,10,14,18
// Thumb counted separately (x-axis comparison, works mirrored)
function _fingers(lm) {
  const thumbExt = lm[4].x < lm[3].x;   // mirrored feed: tip left of IP = extended
  let n = thumbExt ? 1 : 0;
  const tips = [8, 12, 16, 20];
  const pips = [6, 10, 14, 18];
  for (let i = 0; i < 4; i++) if (lm[tips[i]].y < lm[pips[i]].y - 0.02) n++;
  return n;
}

// Check specifically: index + middle extended, ring + pinky closed, no thumb
// = the "peace / scroll" gesture
function _isTwoFingerScroll(lm) {
  const thumbClosed = lm[4].x > lm[3].x;
  const indexExt    = lm[8].y  < lm[6].y  - 0.02;
  const middleExt   = lm[12].y < lm[10].y - 0.02;
  const ringClosed  = lm[16].y > lm[14].y;
  const pinkyClosed = lm[20].y > lm[18].y;
  return thumbClosed && indexExt && middleExt && ringClosed && pinkyClosed;
}

// ── Results ───────────────────────────────────────────────────────────────
function _onResults(results) {
  if (!_active || !_canvas) return;
  _ctx.clearRect(0, 0, _canvas.width, _canvas.height);

  const raw = results.multiHandLandmarks?.[0];
  if (!raw) {
    // Hand left — hold cursor at last known position, just reset gesture state
    _smoothed = null; _state = G.IDLE;
    _pinchFrames = 0; _releaseFrames = 0; _twoFingerBase = null;
    _ctx.clearRect(0, 0, _canvas.width, _canvas.height);
    // Draw dashed ring to show where cursor is held
    const hx = _curX * _canvas.width, hy = _curY * _canvas.height;
    _ctx.globalAlpha = 0.55;
    _ctx.strokeStyle = '#a78bfa'; _ctx.lineWidth = 1.5;
    _ctx.setLineDash([4, 5]);
    _ctx.beginPath(); _ctx.arc(hx, hy, 13, 0, Math.PI * 2); _ctx.stroke();
    _ctx.setLineDash([]);
    _ctx.fillStyle = 'rgba(167,139,250,0.7)';
    _ctx.beginPath(); _ctx.arc(hx, hy, 3, 0, Math.PI * 2); _ctx.fill();
    _ctx.globalAlpha = 1;
    _syncWrapperPos();
    if (IS_ELECTRON) {
      window.__flowElectron.send('cursor_held', { x: _curX * _sw, y: _curY * _sh });
    }
    return;  // cursor stays at _curX/_curY — no cursor_move sent
  }

  const lm  = _smooth(raw);
  const pd  = _d(lm[4], lm[8]);
  const ext = _fingers(lm);
  const twoFinger = _isTwoFingerScroll(lm);

  // ── State machine ────────────────────────────────────────────────────
  switch (_state) {

    case G.IDLE:
    case G.POINTING: {
      if (twoFinger) {
        _state = G.TWO_FINGER;
        _twoFingerBase = lm[8].y;
      } else if (pd < PINCH_ON) {
        _state = G.PINCH_HOLD;
        _pinchFrames   = 1;
        _releaseFrames = 0;
      } else if (ext === 5 && _palmCooldown <= 0) {
        _state = G.PALM;
        _act('right_click', { x: Math.round(_curX * _sw), y: Math.round(_curY * _sh) });
        _palmCooldown = 25;
        setTimeout(() => { if (_state === G.PALM) _state = G.IDLE; }, 500);
      } else if (ext >= 1 && ext <= 2 && !twoFinger) {
        _state = G.POINTING;
        _curX  = lm[8].x;
        _curY  = lm[8].y;
        // Magnetic snap: if hovering near a button/link, lock cursor to it
        const snapPt = _snapToInteractive(_curX * _sw, _curY * _sh);
        _act('cursor_move', { x: Math.round(snapPt.x), y: Math.round(snapPt.y) });
      } else {
        _state = G.IDLE;
      }
      break;
    }

    case G.PINCH_HOLD: {
      if (pd > PINCH_OFF) {
        _releaseFrames++;
        if (_releaseFrames >= REL_FRAMES) {
          // Released — fire click
          _act('gesture_click', { x: Math.round(_curX * _sw), y: Math.round(_curY * _sh) });
          _state = G.IDLE; _pinchFrames = 0; _releaseFrames = 0;
          _drawClickFlash();
        }
      } else {
        _releaseFrames = 0;
        _pinchFrames++;
      }
      break;
    }

    case G.TWO_FINGER: {
      if (!twoFinger) {
        // Left the two-finger gesture
        _state = G.IDLE; _twoFingerBase = null;
      } else {
        const dy = lm[8].y - _twoFingerBase;
        if (Math.abs(dy) > SCROLL_DEAD) {
          const dir = dy < 0 ? 'up' : 'down';
          _act('scroll', { direction: dir, amount: 120 });
          // Rolling anchor — scroll continuously as finger moves
          _twoFingerBase += dy * 0.3;
        }
      }
      break;
    }

    case G.PALM:
      // hold briefly then reset
      break;
  }

  if (_palmCooldown > 0) _palmCooldown--;

  _drawSkeleton(lm);
  _drawCursor();
  _drawLabel(_label(ext, twoFinger, pd));
}

function _label(ext, two, pd) {
  if (two) return '✌️ Scroll';
  switch (_state) {
    case G.POINTING:   return `☝️ ${ext} finger${ext !== 1 ? 's' : ''}`;
    case G.PINCH_HOLD: return `🤏 Click (${_pinchFrames}/${CLICK_HOLD})`;
    case G.PALM:       return '✋ Right-click';
    default:           return `${ext} finger${ext !== 1 ? 's' : ''}`;
  }
}

// ── Drawing ───────────────────────────────────────────────────────────────
const BONES = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [0,9],[9,10],[10,11],[11,12],
  [0,13],[13,14],[14,15],[15,16],
  [0,17],[17,18],[18,19],[19,20],
  [5,9],[9,13],[13,17],
];

function _drawSkeleton(lm) {
  const cw = _canvas.width, ch = _canvas.height;
  _ctx.strokeStyle = '#a78bfa';
  _ctx.lineWidth   = 1.5;
  _ctx.lineCap     = 'round';
  for (const [s, e] of BONES) {
    _ctx.beginPath();
    _ctx.moveTo(lm[s].x * cw, lm[s].y * ch);
    _ctx.lineTo(lm[e].x * cw, lm[e].y * ch);
    _ctx.stroke();
  }
  for (const p of lm) {
    const x = p.x * cw, y = p.y * ch;
    _ctx.fillStyle = '#38bdf8';
    _ctx.beginPath(); _ctx.arc(x, y, 2, 0, Math.PI * 2); _ctx.fill();
    _ctx.fillStyle = 'rgba(255,255,255,0.9)';
    _ctx.beginPath(); _ctx.arc(x, y, 1, 0, Math.PI * 2); _ctx.fill();
  }
  for (const tip of [4, 8, 12, 16, 20]) {
    const x = lm[tip].x * cw, y = lm[tip].y * ch;
    _ctx.strokeStyle = '#c4b5fd'; _ctx.lineWidth = 1.5;
    _ctx.beginPath(); _ctx.arc(x, y, 3.5, 0, Math.PI * 2); _ctx.stroke();
  }
}


function _drawCursorHeld() {
  const cx = _curX * _canvas.width;
  const cy = _curY * _canvas.height;
  // Dashed ring to show held position
  _ctx.globalAlpha = 0.5;
  _ctx.strokeStyle = '#a78bfa';
  _ctx.lineWidth   = 1.5;
  _ctx.setLineDash([4, 4]);
  _ctx.beginPath(); _ctx.arc(cx, cy, 13, 0, Math.PI * 2); _ctx.stroke();
  _ctx.setLineDash([]);
  _ctx.globalAlpha = 1;
  _ctx.fillStyle = 'rgba(167,139,250,0.6)';
  _ctx.beginPath(); _ctx.arc(cx, cy, 3, 0, Math.PI * 2); _ctx.fill();
}

function _drawCursor() {
  const cx = _curX * _canvas.width;
  const cy = _curY * _canvas.height;
  const scrolling = _state === G.TWO_FINGER;
  const clicking  = _state === G.PINCH_HOLD;
  const color     = scrolling ? '#facc15' : clicking ? '#4ade80' : '#a78bfa';
  const radius    = clicking ? 18 : 13;

  _ctx.globalAlpha = 0.85;
  _ctx.strokeStyle = color; _ctx.lineWidth = 2.5;
  _ctx.beginPath(); _ctx.arc(cx, cy, radius, 0, Math.PI * 2); _ctx.stroke();
  _ctx.fillStyle = color; _ctx.globalAlpha = 0.18;
  _ctx.beginPath(); _ctx.arc(cx, cy, radius, 0, Math.PI * 2); _ctx.fill();
  _ctx.globalAlpha = 1;
  _ctx.fillStyle = '#fff';
  _ctx.beginPath(); _ctx.arc(cx, cy, 3, 0, Math.PI * 2); _ctx.fill();
}

function _drawClickFlash() {
  const cx = _curX * _canvas.width, cy = _curY * _canvas.height;
  _ctx.globalAlpha = 0.85;
  _ctx.fillStyle = '#4ade80';
  _ctx.beginPath(); _ctx.arc(cx, cy, 22, 0, Math.PI * 2); _ctx.fill();
  _ctx.globalAlpha = 1;
  _ctx.fillStyle = '#fff'; _ctx.font = 'bold 12px system-ui'; _ctx.textAlign = 'center'; _ctx.textBaseline = 'middle';
  _ctx.fillText('CLICK', cx, cy);
  _ctx.textBaseline = 'alphabetic';
}

function _drawLabel(text) {
  _ctx.globalAlpha = 1;
  const pad = 10, ph = 24, py = 8;
  _ctx.font = 'bold 13px system-ui,sans-serif';
  const pw = _ctx.measureText(text).width + pad * 2;
  _ctx.fillStyle = 'rgba(0,0,0,0.42)';
  _roundRect(8, py, pw, ph, 8); _ctx.fill();
  _ctx.fillStyle = '#a78bfa'; _ctx.textAlign = 'left'; _ctx.textBaseline = 'middle';
  _ctx.fillText(text, 8 + pad, py + ph / 2);
  _ctx.textBaseline = 'alphabetic';
}

function _roundRect(x, y, w, h, r) {
  _ctx.beginPath();
  _ctx.moveTo(x+r,y); _ctx.lineTo(x+w-r,y); _ctx.arcTo(x+w,y,x+w,y+r,r);
  _ctx.lineTo(x+w,y+h-r); _ctx.arcTo(x+w,y+h,x+w-r,y+h,r);
  _ctx.lineTo(x+r,y+h); _ctx.arcTo(x,y+h,x,y+h-r,r);
  _ctx.lineTo(x,y+r); _ctx.arcTo(x,y,x+r,y,r); _ctx.closePath();
}


// Magnetic snap — cursor sticks slightly to buttons/links within 18px radius
// Makes pinch-clicking much easier; cursor won't drift off the target
let _snapTarget = null;
function _snapToInteractive(px, py) {
  // We can't query the target tab's DOM from here (different window)
  // Instead we send a special message to content.js to do the DOM query
  // and return the nearest interactive element center
  // For now: return coords as-is; the content.js handles snapping on its side
  return { x: px, y: py };
}

function _animate() { if (_active) _animId = requestAnimationFrame(_animate); }

export function stop() {
  _active = false;
  setRuntimeState('gestureActive', false);
  if (_animId)      cancelAnimationFrame(_animId);
  if (_dragObserver) clearInterval(_dragObserver);
  if (_previewInterval) clearInterval(_previewInterval);
  if (_camera)       _camera.stop();
  if (_wrapper)      _wrapper.remove();
  _smoothed = null; _state = G.IDLE;
  _dragObserver = null; _videoParent = null; _previewInterval = null;
  _video = _canvas = _ctx = _hands = _camera = _wrapper = null;
  if (IS_ELECTRON) window.__flowElectron.send('gesture_stop', {});
}

export function isActive() { return _active; }

Gesture.start = start;
Gesture.stop  = stop;
Gesture.isActive = isActive;
