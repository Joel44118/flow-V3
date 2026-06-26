// ui/gesture.js (v9)
// Hand gesture control using MediaPipe Hands
// FIXED: Use unpkg with proper script loading (no dynamic import, no CORS issues)
//
// Exports:
//   - Gesture: object with start/stop methods
//   - initGesture(Chat, Orb): initialize
//   - start(videoEl): load MediaPipe and begin tracking
//   - stop(): cleanup

import { sendToExtension } from './screencontrol.js';

export const Gesture = {};

let _Chat = null;
let _Orb = null;

export function initGesture(Chat, Orb) {
  _Chat = Chat;
  _Orb = Orb;
  Gesture.Chat = Chat;
  Gesture.Orb = Orb;
}

let _video = null;
let _canvas = null;
let _ctx = null;
let _hands = null;
let _camera = null;
let _animationId = null;
let _active = false;

let _lockedX = 0.5;
let _lockedY = 0.5;

// ────────────────────────────────────────────────────────────────────────────
// START: Load MediaPipe via unpkg script tag
// ────────────────────────────────────────────────────────────────────────────

export async function start(videoEl) {
  try {
    if (_active) return;
    _active = true;
    _video = videoEl;

    if (_Chat) {
      _Chat.add(
        '🎥 **Gesture Control Loading...**\n\n' +
        '**Hand Gestures:**\n' +
        '1️⃣ **1 Finger** = Move cursor\n' +
        '2️⃣ **2 Fingers** = Scroll\n' +
        '3️⃣ **3 Fingers** = Click\n' +
        '5️⃣ **Open Palm** = Right-click\n\n' +
        '_Loading MediaPipe..._',
        'bot'
      );
    }

    // Load MediaPipe hands.js from unpkg
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/@mediapipe/hands@0.4.1646424926/hands.js';
    script.crossOrigin = 'anonymous';
    script.async = true;

    // Wait for script to load
    await new Promise((resolve, reject) => {
      script.onload = () => {
        // Check if Hands and Camera are available
        if (window.Hands && window.Camera) {
          resolve();
        } else {
          reject(new Error('MediaPipe objects not available after script load'));
        }
      };

      script.onerror = () => {
        reject(new Error('Failed to load MediaPipe hands.js'));
      };

      // Add timeout
      setTimeout(() => {
        reject(new Error('MediaPipe script load timeout'));
      }, 15000);

      document.head.appendChild(script);
    });

    // Setup canvas
    _canvas = document.createElement('canvas');
    _canvas.id = 'gesture-canvas';
    _canvas.width = _video.videoWidth || 640;
    _canvas.height = _video.videoHeight || 480;
    _canvas.style.cssText = 'position:absolute;top:0;left:0;z-index:10000;cursor:none;';
    _ctx = _canvas.getContext('2d', { willReadFrequently: true });

    const container = _video.parentElement;
    container.style.position = 'relative';
    container.appendChild(_canvas);

    // Initialize hands detector
    _hands = new window.Hands({
      locateFile: (file) => `https://unpkg.com/@mediapipe/hands@0.4.1646424926/${file}`
    });

    _hands.setOptions({
      maxNumHands: 1,
      modelComplexity: 1,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5
    });

    _hands.onResults(_onResults);

    // Start camera
    const camera = new window.Camera(_video, {
      onFrame: async () => {
        await _hands.send({ image: _video });
      },
      width: 640,
      height: 480
    });

    _camera = camera;
    camera.start();

    if (_Chat) {
      _Chat.add(
        '✅ **Gesture Control Ready!**\n\n' +
        'Show your hand to camera (palm facing).\n\n' +
        '_Say "stop gesture control" to exit._',
        'bot'
      );
    }

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

function _countExtendedFingers(landmarks) {
  const tips = [4, 8, 12, 16, 20];
  const pips = [3, 6, 10, 14, 18];
  let count = 0;

  for (let i = 0; i < tips.length; i++) {
    if (landmarks[tips[i]].y < landmarks[pips[i]].y) {
      count++;
    }
  }

  return count;
}

function _dispatchGesture(fingers, landmarks) {
  const tipX = landmarks[8].x;
  const tipY = landmarks[8].y;

  _lockedX = tipX;
  _lockedY = tipY;

  switch (fingers) {
    case 1:
      sendToExtension('cursor_move', {
        x: Math.round(tipX * window.innerWidth),
        y: Math.round(tipY * window.innerHeight)
      });
      break;
    case 2:
      sendToExtension('scroll', {
        direction: tipY < 0.5 ? 'up' : 'down',
        distance: 80
      });
      break;
    case 3:
      sendToExtension('click', {
        x: Math.round(tipX * window.innerWidth),
        y: Math.round(tipY * window.innerHeight)
      });
      break;
    case 5:
      sendToExtension('right_click', {
        x: Math.round(tipX * window.innerWidth),
        y: Math.round(tipY * window.innerHeight)
      });
      break;
  }
}

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

Gesture.start = start;
Gesture.stop = stop;
