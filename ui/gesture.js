// ui/gesture.js (v13)
// Gestures: point-to-move, pinch-to-click, pinch-slide-to-scroll
// Camera box stays visible — canvas overlaid as sibling wrapper

import { sendToExtension } from './screencontrol.js';

export const Gesture = {};
let _Chat = null, _Orb = null;
export function initGesture(Chat, Orb) { _Chat = Chat; _Orb = Orb; Gesture.Chat = Chat; Gesture.Orb = Orb; }

let _video = null, _canvas = null, _ctx = null;
let _hands = null, _camera = null, _animId = null;
let _active = false, _wrapper = null;

// Gesture state
let _curX = 0.5, _curY = 0.5;
let _pinching      = false;
let _pinchStartY   = null;
let _pinchCooldown = 0;
let _scrollLock    = false;
let _scrollDir     = null;
let _lastFingers   = 0;

const PROXY        = '/api/mediapipe?f=';
const PINCH_DIST   = 0.055;  // thumb-index distance threshold for pinch
const SCROLL_DIST  = 0.06;   // min pinch-slide distance to trigger scroll
const CLICK_FRAMES = 6;      // frames pinch must hold to register click

let _pinchHoldFrames = 0;

function _loadScript(filename) {
  const src = PROXY + filename;
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-mp="${filename}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src; s.dataset.mp = filename; s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load MediaPipe: ${filename}`));
    document.head.appendChild(s);
  });
}

export async function start(videoEl) {
  try {
    if (_active) return;
    _active = true;
    _video = videoEl;

    if (_Chat) _Chat.add(
      '🎥 **Gesture Control Loading...**\n\n' +
      '**Gestures:**\n' +
      '☝️ **Point (1 finger)** = Move cursor\n' +
      '🤏 **Pinch & hold** = Click\n' +
      '🤏↕ **Pinch & slide** = Scroll up/down\n' +
      '✋ **Open palm** = Right-click\n\n' +
      '_Loading MediaPipe..._', 'bot');

    await _loadScript('hands.js');
    await _loadScript('camera_utils.js');
    if (!window.Hands || !window.Camera) throw new Error('MediaPipe not available');

    // Overlay wrapper — inserted AFTER the video as a sibling, never inside it
    const vw = _video.offsetWidth  || 320;
    const vh = _video.offsetHeight || 240;

    _wrapper = document.createElement('div');
    Object.assign(_wrapper.style, {
      position: 'absolute', pointerEvents: 'none', zIndex: '10000',
      top: _video.offsetTop + 'px', left: _video.offsetLeft + 'px',
      width: vw + 'px', height: vh + 'px',
    });
    _video.parentElement.style.position = 'relative';
    _video.after(_wrapper);

    _canvas = document.createElement('canvas');
    _canvas.id = 'gesture-canvas';
    _canvas.width = vw; _canvas.height = vh;
    Object.assign(_canvas.style, { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' });
    _ctx = _canvas.getContext('2d', { willReadFrequently: true });
    _wrapper.appendChild(_canvas);

    _hands = new window.Hands({ locateFile: f => PROXY + f });
    _hands.setOptions({ maxNumHands: 1, modelComplexity: 1, minDetectionConfidence: 0.6, minTrackingConfidence: 0.5 });
    _hands.onResults(_onResults);

    _camera = new window.Camera(_video, {
      onFrame: async () => { await _hands.send({ image: _video }); },
      width: 640, height: 480
    });
    await _camera.start();

    if (_Chat) _Chat.add(
      '✅ **Gesture Control Ready!**\n\n' +
      'Show your hand to the camera.\n' +
      '• Point with 1 finger → moves cursor\n' +
      '• Pinch (thumb+index) → click\n' +
      '• Pinch + slide up/down → scroll\n' +
      '• Open palm → right-click\n\n' +
      '_Say "stop gesture control" to exit._', 'bot');

    _animate();
  } catch (err) {
    console.error('[Gesture] Load error:', err.message);
    if (_Chat) _Chat.add(`⚠️ Gesture setup failed: ${err.message}`, 'bot');
    _active = false;
    throw err;
  }
}

function _dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function _onResults(results) {
  if (!_active || !_canvas) return;
  _ctx.clearRect(0, 0, _canvas.width, _canvas.height);

  const lm = results.multiHandLandmarks?.[0];
  if (!lm) { _pinching = false; _pinchStartY = null; _pinchHoldFrames = 0; _drawLabel('👋 Show hand'); return; }

  const indexTip  = lm[8];
  const thumbTip  = lm[4];
  const pinchDist = _dist(thumbTip, indexTip);
  const isPinch   = pinchDist < PINCH_DIST;
  const extCount  = _countExtended(lm);

  // ── Move cursor (1 extended finger, not pinching) ─────────────────────
  if (!isPinch && extCount === 1) {
    _curX = indexTip.x;
    _curY = indexTip.y;
    sendToExtension('cursor_move', {
      x: Math.round(_curX * window.screen.width),
      y: Math.round(_curY * window.screen.height)
    });
  }

  // ── Pinch detection ────────────────────────────────────────────────────
  if (isPinch && _pinchCooldown <= 0) {
    if (!_pinching) {
      // Pinch just started
      _pinching      = true;
      _pinchStartY   = indexTip.y;
      _pinchHoldFrames = 0;
      _scrollLock    = false;
      _scrollDir     = null;
    } else {
      _pinchHoldFrames++;
      const deltaY = indexTip.y - _pinchStartY;

      // Slide threshold — treat as scroll
      if (!_scrollLock && Math.abs(deltaY) > SCROLL_DIST) {
        _scrollLock = true;
        _scrollDir  = deltaY < 0 ? 'up' : 'down';
      }

      if (_scrollLock) {
        // Keep scrolling while pinching and sliding
        const currentDelta = indexTip.y - _pinchStartY;
        const dir = currentDelta < 0 ? 'up' : 'down';
        sendToExtension('scroll', { direction: dir, amount: 120 });
        _drawLabel(`🤏↕ Scroll ${dir}`);
      } else if (_pinchHoldFrames >= CLICK_FRAMES) {
        // Held pinch without slide = click
        sendToExtension('gesture_click', {
          x: Math.round(_curX * window.screen.width),
          y: Math.round(_curY * window.screen.height)
        });
        _pinchCooldown  = 20;
        _pinching       = false;
        _pinchStartY    = null;
        _pinchHoldFrames = 0;
        _drawClickFlash();
      }
    }
  } else if (!isPinch && _pinching) {
    // Pinch released
    _pinching      = false;
    _pinchStartY   = null;
    _pinchHoldFrames = 0;
    _scrollLock    = false;
    _pinchCooldown = 8;
  }

  if (_pinchCooldown > 0) _pinchCooldown--;

  // ── Open palm = right-click ────────────────────────────────────────────
  if (extCount === 5 && _lastFingers !== 5) {
    sendToExtension('right_click', {
      x: Math.round(_curX * window.screen.width),
      y: Math.round(_curY * window.screen.height)
    });
  }
  _lastFingers = extCount;

  // ── Draw ───────────────────────────────────────────────────────────────
  _drawSkeleton(lm);
  _drawCursor(isPinch);
  if (!_scrollLock) _drawLabel(isPinch ? '🤏 Pinching...' : `${extCount} finger${extCount !== 1 ? 's' : ''}`);
}

function _countExtended(lm) {
  const tips = [4, 8, 12, 16, 20];
  const pips = [3, 6, 10, 14, 18];
  let n = 0;
  for (let i = 0; i < tips.length; i++) {
    if (lm[tips[i]].y < lm[pips[i]].y) n++;
  }
  return n;
}

function _drawSkeleton(lm) {
  const C = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],
             [0,9],[9,10],[10,11],[11,12],[0,13],[13,14],[14,15],[15,16],
             [0,17],[17,18],[18,19],[19,20]];
  _ctx.strokeStyle = '#0f0'; _ctx.lineWidth = 2; _ctx.fillStyle = '#0f0';
  C.forEach(([s, e]) => {
    _ctx.beginPath();
    _ctx.moveTo(lm[s].x * _canvas.width, lm[s].y * _canvas.height);
    _ctx.lineTo(lm[e].x * _canvas.width, lm[e].y * _canvas.height);
    _ctx.stroke();
  });
  lm.forEach(p => {
    _ctx.beginPath();
    _ctx.arc(p.x * _canvas.width, p.y * _canvas.height, 4, 0, Math.PI * 2);
    _ctx.fill();
  });
}

function _drawCursor(pinching) {
  const sx = _curX * _canvas.width;
  const sy = _curY * _canvas.height;
  const color = pinching ? 'rgba(74,222,128,' : 'rgba(56,189,248,';
  _ctx.fillStyle = color + '0.5)';
  _ctx.beginPath(); _ctx.arc(sx, sy, pinching ? 16 : 12, 0, Math.PI * 2); _ctx.fill();
  _ctx.strokeStyle = color + '1)'; _ctx.lineWidth = 3;
  _ctx.beginPath(); _ctx.arc(sx, sy, pinching ? 16 : 12, 0, Math.PI * 2); _ctx.stroke();
}

function _drawClickFlash() {
  const sx = _curX * _canvas.width;
  const sy = _curY * _canvas.height;
  _ctx.fillStyle = 'rgba(74,222,128,0.85)';
  _ctx.beginPath(); _ctx.arc(sx, sy, 22, 0, Math.PI * 2); _ctx.fill();
  _ctx.fillStyle = '#fff'; _ctx.font = 'bold 14px sans-serif'; _ctx.textAlign = 'center';
  _ctx.fillText('CLICK', sx, sy + 5);
}

function _drawLabel(text) {
  _ctx.fillStyle = 'rgba(0,150,255,0.9)'; _ctx.font = 'bold 15px sans-serif'; _ctx.textAlign = 'left';
  _ctx.fillText(text, 10, 26);
}

function _animate() { if (!_active) return; _animId = requestAnimationFrame(_animate); }

export function stop() {
  _active = false;
  if (_animId)   cancelAnimationFrame(_animId);
  if (_camera)   _camera.stop();
  if (_wrapper)  _wrapper.remove();
  _video = _canvas = _ctx = _hands = _camera = _wrapper = null;
}

Gesture.start = start;
Gesture.stop  = stop;
