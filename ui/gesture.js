// ui/gesture.js (v7)
// Hand gesture control using MediaPipe Hands
// Detects finger positions and converts to browser/tab control actions
// Model: @mediapipe/hands@0.4.1646424926 (unpkg CDN - verified accessible)
//
// Exports:
//   - Gesture: object with start/stop methods, wired by app.js
//   - initGesture(Chat, Orb): initialize with UI refs for setup messages
//   - start(videoEl): load MediaPipe, begin hand tracking
//   - stop(): cleanup canvas, stop camera

import { sendToExtension } from './screencontrol.js';

// ────────────────────────────────────────────────────────────────────────────
// MODULE EXPORTS
// ────────────────────────────────────────────────────────────────────────────

export const Gesture = {};

let _Chat = null;
let _Orb = null;

export function initGesture(Chat, Orb) {
  _Chat = Chat;
  _Orb = Orb;
  Gesture.Chat = Chat;
  Gesture.Orb = Orb;
}

// ────────────────────────────────────────────────────────────────────────────
// STATE & CONFIGURATION
// ────────────────────────────────────────────────────────────────────────────

let _video = null;
let _canvas = null;
let _ctx = null;
let _hands = null;
let _camera = null;
let _animationId = null;
let _active = false;

// Cursor locked position (persists when hand leaves frame)
let _lockedX = 0.5;
let _lockedY = 0.5;

// ────────────────────────────────────────────────────────────────────────────
// START: Load MediaPipe and begin tracking
// ────────────────────────────────────────────────────────────────────────────

export async function start(videoEl) {
  try {
    if (_active) return;
    _active = true;
    _video = videoEl;

    // Send setup message to Flow UI
    if (_Chat) {
      _Chat.add(
        '🎥 **Gesture Control Loading...**\n\n' +
        '**Hand Gestures:**\n' +
        '1️⃣ **1 Finger** = Move cursor\n' +
        '2️⃣ **2 Fingers** = Scroll (vertical)\n' +
        '3️⃣ **3 Fingers** = Click\n' +
        '5️⃣ **Open Palm** = Right-click\n' +
        '✊ **Fist** = Lock cursor\n\n' +
        '_Loading MediaPipe model from CDN..._',
        'bot'
      );
    }

    // Load MediaPipe script from unpkg CDN (verified: hands.js + wasm binary accessible)
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/@mediapipe/hands@0.4.1646424926/hands.js';
    script.crossOrigin = 'anonymous';

    let scriptReady = false;
    script.onload = () => { scriptReady = true; };
    script.onerror = () => {
      throw new Error('Failed to load MediaPipe hands.js from unpkg CDN');
    };

    document.head.appendChild(script);

    // Wait for script to load (with 10s timeout)
    await Promise.race([
      new Promise(r => {
        const check = setInterval(() => {
          if (scriptReady && window.Hands) {
            clearInterval(check);
            r();
          }
        }, 100);
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('MediaPipe SDK load timeout')), 10000)
      )
    ]);

    // Setup canvas for skeleton/dot drawing
    _canvas = document.createElement('canvas');
    _canvas.id = 'gesture-canvas';
    _canvas.width = _video.videoWidth || 640;
    _canvas.height = _video.videoHeight || 480;
    _canvas.style.cssText = `
      position: absolute; top: 0; left: 0; z-index: 10000; cursor: none;
    `;
    _ctx = _canvas.getContext('2d', { willReadFrequently: true });

    const container = _video.parentElement;
    container.style.position = 'relative';
    container.appendChild(_canvas);

    // Initialize Hands detector
    _hands = new window.Hands({
      locateFile: (file) => 
        `https://unpkg.com/@mediapipe/hands@0.4.1646424926/${file}`
    });

    _hands.setOptions({
      maxNumHands: 1,
      modelComplexity: 1,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5
    });

    _hands.onResults(_onResults);

    // Start camera feed
    const camera = new window.Camera(_video, {
      onFrame: async () => {
        await _hands.send({ image: _video });
      },
      width: 640,
      height: 480
    });

    _camera = camera;
    camera.start();

    // Send success message
    if (_Chat) {
      _Chat.add(
        '✅ **Gesture Control Ready!**\n\n' +
        'Show your hand to camera (palm facing). ' +
        'Spread fingers for detection.\n\n' +
        '_Tip: Say "stop gesture control" to exit._',
        'bot'
      );
    }

    // Start animation loop
    _animate();

  } catch (err) {
    console.error('[Gesture] Load error:', err.message);
    if (_Chat) {
      _Chat.add(`⚠️ Gesture setup failed: ${err.message}`, 'bot');
    }
    _active = false;
    throw err;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// HAND DETECTION & GESTURE DISPATCH
// ────────────────────────────────────────────────────────────────────────────

function _onResults(results) {
  if (!_active || !_canvas) return;

  _ctx.clearRect(0, 0, _canvas.width, _canvas.height);

  const landmarks = results.multiHandLandmarks?.[0];

  if (!landmarks) {
    _drawLabel('👋 Show hand');
    return;
  }

  const fingers = _countExtendedFingers(landmarks);
  _dispatchGesture(fingers, landmarks);

  _drawSkeleton(landmarks);
  _drawCursor();
  _drawLabel(`${fingers} finger${fingers !== 1 ? 's' : ''}`);
}

// Count how many fingers are extended (open) vs folded
function _countExtendedFingers(landmarks) {
  const tips = [4, 8, 12, 16, 20];      // Thumb, index, middle, ring, pinky tips
  const pips = [3, 6, 10, 14, 18];      // PIP (middle knuckle) of each finger
  let count = 0;

  for (let i = 0; i < tips.length; i++) {
    if (landmarks[tips[i]].y < landmarks[pips[i]].y) {
      count++;
    }
  }

  return count;
}

// Route detected gesture to extension
function _dispatchGesture(fingers, landmarks) {
  const tipX = landmarks[8].x;  // Index finger tip
  const tipY = landmarks[8].y;

  // Update locked cursor position based on hand movement
  _lockedX = tipX;
  _lockedY = tipY;

  switch (fingers) {
    case 1:
      // 1 finger = move cursor
      sendToExtension('cursor_move', {
        x: Math.round(tipX * window.innerWidth),
        y: Math.round(tipY * window.innerHeight)
      });
      break;

    case 2:
      // 2 fingers = scroll
      sendToExtension('scroll', {
        direction: tipY < 0.5 ? 'up' : 'down',
        distance: 80
      });
      break;

    case 3:
      // 3 fingers = click
      sendToExtension('click', {
        x: Math.round(tipX * window.innerWidth),
        y: Math.round(tipY * window.innerHeight)
      });
      break;

    case 5:
      // Open palm (all 5) = right-click
      sendToExtension('right_click', {
        x: Math.round(tipX * window.innerWidth),
        y: Math.round(tipY * window.innerHeight)
      });
      break;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// DRAWING
// ────────────────────────────────────────────────────────────────────────────

function _drawSkeleton(landmarks) {
  const connections = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [0, 9], [9, 10], [10, 11], [11, 12],
    [0, 13], [13, 14], [14, 15], [15, 16],
    [0, 17], [17, 18], [18, 19], [19, 20]
  ];

  _ctx.strokeStyle = '#0f0';
  _ctx.lineWidth = 2;
  _ctx.fillStyle = '#0f0';

  connections.forEach(([start, end]) => {
    const p1 = landmarks[start];
    const p2 = landmarks[end];
    _ctx.beginPath();
    _ctx.moveTo(p1.x * _canvas.width, p1.y * _canvas.height);
    _ctx.lineTo(p2.x * _canvas.width, p2.y * _canvas.height);
    _ctx.stroke();
  });

  landmarks.forEach((lm) => {
    _ctx.beginPath();
    _ctx.arc(lm.x * _canvas.width, lm.y * _canvas.height, 4, 0, Math.PI * 2);
    _ctx.fill();
  });
}

function _drawCursor() {
  const screenX = _lockedX * _canvas.width;
  const screenY = _lockedY * _canvas.height;

  _ctx.fillStyle = 'rgba(0, 150, 255, 0.6)';
  _ctx.beginPath();
  _ctx.arc(screenX, screenY, 12, 0, Math.PI * 2);
  _ctx.fill();

  _ctx.strokeStyle = 'rgba(0, 200, 255, 1)';
  _ctx.lineWidth = 3;
  _ctx.beginPath();
  _ctx.arc(screenX, screenY, 12, 0, Math.PI * 2);
  _ctx.stroke();
}

function _drawLabel(text) {
  _ctx.fillStyle = 'rgba(0, 150, 255, 0.9)';
  _ctx.font = 'bold 16px sans-serif';
  _ctx.textAlign = 'left';
  _ctx.fillText(text, 10, 30);
}

// ────────────────────────────────────────────────────────────────────────────
// ANIMATION & CLEANUP
// ────────────────────────────────────────────────────────────────────────────

function _animate() {
  if (!_active) return;
  _animationId = requestAnimationFrame(_animate);
}

export function stop() {
  _active = false;

  if (_animationId) cancelAnimationFrame(_animationId);
  if (_camera) _camera.stop();
  if (_canvas) _canvas.remove();

  _video = null;
  _canvas = null;
  _ctx = null;
  _hands = null;
  _camera = null;
}

// Wire start/stop to Gesture export
Gesture.start = start;
Gesture.stop = stop;
