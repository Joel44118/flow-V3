import { sendToExtension } from './screencontrol.js';

// Export as a Gesture object for app.js compatibility
export const Gesture = {};

// Initialize gesture control and wire it into Chat/Orb
export function initGesture(Chat, Orb) {
  Gesture.Chat = Chat;
  Gesture.Orb = Orb;
  // Called at app startup, actual gesture.start() fires on "start gesture control" command
}

let _video = null;
let _canvas = null;
let _ctx = null;
let _hands = null;
let _camera = null;
let _animationId = null;
let _active = false;
let _kbMode = false;

// Dot position — STAYS where you leave it
let _dotAbsX = null;
let _dotAbsY = null;
let _handVisible = false;

// Gesture state
let _currentGesture = null;
let _gestureFrames = 0;
let _fourFingerCooldown = 0;
const FOUR_FINGER_DEBOUNCE_MS = 800;

// Scroll state
let _lastScrollY = 0;
let _scrollThreshold = 30;

// Keyboard
let _kbContainer = null;
let _selectedKeyIndex = 0;

const KEYS = [
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', '⌫'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '↵'],
  ['⇧', '⎵', '⎵', '⎵', '⎵', '⎵', '⎵', '⎵', '?!', '↵']
];

export async function start(videoEl) {
  try {
    if (_active) return;
    _active = true;
    _video = videoEl;

    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1646424926/hands.min.js';
    script.crossOrigin = 'anonymous';

    let scriptReady = false;
    script.onload = () => { scriptReady = true; };

    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('SDK load timeout')), 10000)
    );

    document.head.appendChild(script);
    await Promise.race([
      new Promise(r => {
        const check = setInterval(() => {
          if (scriptReady && window.Hands) {
            clearInterval(check);
            r();
          }
        }, 100);
      }),
      timeout
    ]);

    _canvas = document.createElement('canvas');
    _canvas.id = 'gesture-canvas';
    _canvas.width = _video.videoWidth || 640;
    _canvas.height = _video.videoHeight || 480;
    _canvas.style.position = 'absolute';
    _canvas.style.top = '0';
    _canvas.style.left = '0';
    _canvas.style.zIndex = '10000';
    _canvas.style.cursor = 'none';
    _ctx = _canvas.getContext('2d', { willReadFrequently: true });

    const container = _video.parentElement;
    container.style.position = 'relative';
    container.appendChild(_canvas);

    _hands = new window.Hands({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1646424926/${file}`
    });

    _hands.setOptions({
      maxNumHands: 1,
      modelComplexity: 1,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5
    });

    _hands.onResults(_onResults);

    const camera = new window.Camera(_video, {
      onFrame: async () => {
        await _hands.send({ image: _video });
      },
      width: 640,
      height: 480
    });

    _camera = camera;
    camera.start();

    _animate();
  } catch (err) {
    console.error('[Gesture] Error:', err.message);
    throw err;
  }
}

function _onResults(results) {
  if (!_active || !_canvas) return;

  const landmarks = results.multiHandLandmarks?.[0];
  _drawCanvas();

  if (!landmarks || landmarks.length === 0) {
    _handVisible = false;
    _currentGesture = null;
    _gestureFrames = 0;
    _fourFingerCooldown = Math.max(0, _fourFingerCooldown - 16);
    _drawDotAtPosition();
    _drawLabel(0);
    return;
  }

  _handVisible = true;
  const fingers = _countFingers(landmarks);

  if (fingers === 4) {
    if (_fourFingerCooldown <= 0) {
      _fourFingerCooldown = FOUR_FINGER_DEBOUNCE_MS;
      _dispatchGesture(4, landmarks);
    }
    _fourFingerCooldown = Math.max(0, _fourFingerCooldown - 16);
  } else {
    _fourFingerCooldown = 0;
    _gestureFrames++;

    if (_gestureFrames >= 3) {
      if (fingers !== _currentGesture) {
        _currentGesture = fingers;
        _gestureFrames = 0;
      } else {
        _dispatchGesture(fingers, landmarks);
      }
    }
  }

  _drawSkeleton(landmarks);
  _drawDot(landmarks, fingers);
  _drawLabel(fingers);
}

function _countFingers(landmarks) {
  const tips = [4, 8, 12, 16, 20];
  let count = 0;

  for (let i = 0; i < tips.length; i++) {
    const tip = landmarks[tips[i]];
    const pip = landmarks[tips[i] - 2];
    if (tip.y < pip.y) count++;
  }

  return count;
}

function _dispatchGesture(fingers, landmarks) {
  if (_kbMode) {
    _handleKeyboardGesture(fingers, landmarks);
    return;
  }

  const tipX = landmarks[8].x;
  const tipY = landmarks[8].y;

  switch (fingers) {
    case 1:
      _dotAbsX = Math.round(tipX * window.innerWidth);
      _dotAbsY = Math.round(tipY * window.innerHeight);
      sendToExtension('cursor_move', { x: _dotAbsX, y: _dotAbsY });
      break;

    case 2:
      const scrollY = Math.round(tipY * window.innerHeight);
      if (Math.abs(scrollY - _lastScrollY) > _scrollThreshold) {
        const direction = scrollY > _lastScrollY ? 'down' : 'up';
        sendToExtension('scroll', { direction, distance: 80 });
        _lastScrollY = scrollY;
      }
      break;

    case 3:
      if (_dotAbsX !== null && _dotAbsY !== null) {
        sendToExtension('click', { x: _dotAbsX, y: _dotAbsY });
      }
      break;

    case 5:
      if (_dotAbsX !== null && _dotAbsY !== null) {
        sendToExtension('right_click', { x: _dotAbsX, y: _dotAbsY });
      }
      break;

    case 4:
      _kbMode = !_kbMode;
      if (_kbMode) {
        _initKeyboard();
      } else {
        _closeKeyboard();
      }
      break;
  }
}

function _handleKeyboardGesture(fingers, landmarks) {
  const tipX = landmarks[8].x;
  const tipY = landmarks[8].y;

  if (fingers === 1) {
    const cols = KEYS[0].length;
    const rows = KEYS.length;
    const col = Math.floor(tipX * cols);
    const row = Math.floor(tipY * rows);
    _selectedKeyIndex = Math.min(col + row * cols, KEYS.flat().length - 1);
    _drawKeyboard();
  } else if (fingers === 3) {
    const keys = KEYS.flat();
    const key = keys[_selectedKeyIndex];
    _pressKey(key);
  } else if (fingers === 4) {
    _kbMode = false;
    _closeKeyboard();
  }
}

function _initKeyboard() {
  if (_kbContainer) return;

  _kbContainer = document.createElement('div');
  _kbContainer.id = 'gesture-keyboard-container';
  _kbContainer.style.position = 'fixed';
  _kbContainer.style.bottom = '120px';
  _kbContainer.style.right = '20px';
  _kbContainer.style.zIndex = '10001';
  _kbContainer.style.width = '380px';
  _kbContainer.style.backgroundColor = '#1a1a1a';
  _kbContainer.style.border = '2px solid #0f0';
  _kbContainer.style.borderRadius = '8px';
  _kbContainer.style.padding = '10px';
  _kbContainer.style.boxShadow = '0 4px 16px rgba(0,0,0,0.7)';
  _kbContainer.style.fontFamily = 'monospace';
  document.body.appendChild(_kbContainer);

  _drawKeyboard();
}

function _drawKeyboard() {
  if (!_kbContainer) return;

  let html = '';
  const keys = KEYS.flat();
  let keyIdx = 0;

  KEYS.forEach((row) => {
    html += '<div style="display: flex; gap: 4px; margin-bottom: 4px;">';

    row.forEach((key) => {
      const idx = keyIdx++;
      const isSelected = idx === _selectedKeyIndex;
      const bgColor = isSelected ? '#0f0' : '#333';
      const textColor = isSelected ? '#000' : '#0f0';

      html += `<button data-key-idx="${idx}" style="
        flex: 1;
        padding: 8px;
        backgroundColor: ${bgColor};
        color: ${textColor};
        border: 1px solid #0f0;
        borderRadius: 4px;
        font: bold 11px monospace;
        cursor: pointer;
        transition: all 0.1s;
      ">${key}</button>`;
    });

    html += '</div>';
  });

  _kbContainer.innerHTML = html;

  _kbContainer.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.keyIdx);
      const key = KEYS.flat()[idx];
      _pressKey(key);
    });
  });
}

function _pressKey(key) {
  const keyMap = {
    '⌫': 'Backspace',
    '⎵': ' ',
    '↵': 'Enter',
    '⇧': 'Shift',
    '?!': '?'
  };

  const keyCode = keyMap[key] || key;
  sendToExtension('key_press', { key: keyCode });
}

function _closeKeyboard() {
  if (_kbContainer) {
    _kbContainer.remove();
    _kbContainer = null;
  }
  _selectedKeyIndex = 0;
}

function _drawCanvas() {
  _ctx.clearRect(0, 0, _canvas.width, _canvas.height);
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
    _ctx.arc(lm.x * _canvas.width, lm.y * _canvas.height, 3, 0, Math.PI * 2);
    _ctx.fill();
  });
}

function _drawDot(landmarks, fingers) {
  if (fingers === 1) {
    const tipX = landmarks[8].x;
    const tipY = landmarks[8].y;
    _dotAbsX = Math.round(tipX * window.innerWidth);
    _dotAbsY = Math.round(tipY * window.innerHeight);
  }

  _drawDotAtPosition();
}

function _drawDotAtPosition() {
  if (_dotAbsX === null || _dotAbsY === null) return;

  const screenX = (_dotAbsX / window.innerWidth) * _canvas.width;
  const screenY = (_dotAbsY / window.innerHeight) * _canvas.height;

  _ctx.fillStyle = 'rgba(0, 100, 255, 0.7)';
  _ctx.beginPath();
  _ctx.arc(screenX, screenY, 10, 0, Math.PI * 2);
  _ctx.fill();

  _ctx.strokeStyle = 'rgba(0, 200, 255, 1)';
  _ctx.lineWidth = 2.5;
  _ctx.beginPath();
  _ctx.arc(screenX, screenY, 10, 0, Math.PI * 2);
  _ctx.stroke();
}

function _drawLabel(fingers) {
  const labels = {
    0: _handVisible ? '✋ PAUSE' : '👋 SHOW HAND',
    1: _kbMode ? '🔤 SELECT KEY' : '🎯 MOVE DOT',
    2: '🔄 SCROLL',
    3: '👆 CLICK',
    4: '⌨️ KEYBOARD',
    5: '🖱️ RIGHT-CLICK'
  };

  _ctx.fillStyle = 'rgba(0, 150, 255, 0.9)';
  _ctx.font = 'bold 14px sans-serif';
  _ctx.textAlign = 'left';
  _ctx.fillText(labels[fingers] || '', 10, 30);

  if (_kbMode && fingers === 1) {
    _ctx.fillText('← 1=select  3=press  4=close →', 10, 50);
  }
}

function _animate() {
  if (!_active) return;
  _animationId = requestAnimationFrame(_animate);
}

async function _start(videoEl) {
  return start(videoEl);
}

function _stop() {
  return stop();
}

// Wire functions to Gesture object
Gesture.start = _start;
Gesture.stop = _stop;

export function stop() {
  _active = false;
  _kbMode = false;

  if (_animationId) cancelAnimationFrame(_animationId);
  if (_camera) _camera.stop();
  if (_canvas) _canvas.remove();
  if (_kbContainer) _kbContainer.remove();

  _video = null;
  _canvas = null;
  _ctx = null;
  _hands = null;
  _camera = null;
  _dotAbsX = null;
  _dotAbsY = null;
  _currentGesture = null;
  _gestureFrames = 0;
  _handVisible = false;
}
