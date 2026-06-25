let _flowTabId = null;
let _lastHighlightedEl = null;

window.addEventListener('message', (event) => {
  if (event.source !== window) return;

  if (event.data.source === 'flow-ext-id-request') {
    try {
      window.postMessage({
        source: 'flow-ext-id-reply',
        extensionId: chrome.runtime.id
      }, '*');
    } catch (err) {
      // Extension context invalidated
    }
  }
});

window.addEventListener('message', (event) => {
  if (event.source !== window) return;

  if (event.data.source === 'flow-control-page') {
    try {
      chrome.runtime.sendMessage({
        source: 'flow-control-relay',
        action: event.data.action,
        payload: event.data.payload
      }, (response) => {
        if (chrome.runtime.lastError) {
          return;
        }
        if (response) {
          window.postMessage({
            source: 'flow-control-reply',
            action: response.action,
            success: response.success,
            message: response.message
          }, '*');
        }
      });
    } catch (err) {
      // Extension context invalidated
    }
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    if (msg.source === 'register-flow-tab') {
      _flowTabId = sender.tab.id;
      sendResponse({ success: true });
    } else if (msg.source === 'flow-control-relay') {
      _handleScreenControl(msg.action, msg.payload, sendResponse);
    }
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }

  return true;
});

function _handleScreenControl(action, payload, sendResponse) {
  try {
    switch (action) {
      case 'scroll':
        _scroll(payload);
        sendResponse({ action: 'scroll', success: true });
        break;

      case 'click':
        _click(payload);
        sendResponse({ action: 'click', success: true });
        break;

      case 'right_click':
        _rightClick(payload);
        sendResponse({ action: 'right_click', success: true });
        break;

      case 'cursor_move':
        _moveCursor(payload);
        sendResponse({ action: 'cursor_move', success: true });
        break;

      case 'drag':
        _drag(payload);
        sendResponse({ action: 'drag', success: true });
        break;

      case 'type':
        _type(payload);
        sendResponse({ action: 'type', success: true });
        break;

      case 'key_press':
        _pressKey(payload);
        sendResponse({ action: 'key_press', success: true });
        break;

      case 'navigate':
        _navigate(payload);
        sendResponse({ action: 'navigate', success: true });
        break;

      case 'go_back':
        window.history.back();
        sendResponse({ action: 'go_back', success: true });
        break;

      case 'refresh':
        window.location.reload();
        sendResponse({ action: 'refresh', success: true });
        break;

      case 'read_page':
        const text = document.body.innerText;
        sendResponse({ action: 'read_page', success: true, content: text });
        break;

      default:
        sendResponse({ action, success: false, error: 'Unknown action' });
    }
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

function _scroll(payload) {
  const { direction, distance } = payload;
  const scrollAmount = direction === 'up' ? -(distance || 60) : (distance || 60);

  const scrollable = _findScrollable();
  if (scrollable) {
    scrollable.scrollBy({ top: scrollAmount, behavior: 'smooth' });
  }
}

function _findScrollable() {
  if (window.innerHeight < document.documentElement.scrollHeight) {
    return window;
  }

  const centerX = window.innerWidth / 2;
  const centerY = window.innerHeight / 2;
  const elements = document.elementsFromPoint(centerX, centerY);

  for (let el of elements) {
    const overflow = getComputedStyle(el).overflow;
    if (overflow === 'auto' || overflow === 'scroll') {
      if (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth) {
        return el;
      }
    }
  }

  return window;
}

function _click(payload) {
  const { x, y } = payload;
  const el = document.elementFromPoint(x, y);

  if (el) {
    el.click();
    _highlightElement(el, '#0f0');
  }
}

function _rightClick(payload) {
  const { x, y } = payload;
  const el = document.elementFromPoint(x, y);

  if (el) {
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y
    });
    el.dispatchEvent(event);
    _highlightElement(el, '#f80');
  }
}

function _moveCursor(payload) {
  const { x, y } = payload;
  const el = document.elementFromPoint(x, y);

  _highlightElement(el, '#0ff');
  _drawCursorDot(x, y);
}

function _drag(payload) {
  const { fromX, fromY, toX, toY } = payload;
  const el = document.elementFromPoint(fromX, fromY);

  if (el) {
    const mouseDownEvent = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: fromX,
      clientY: fromY
    });
    el.dispatchEvent(mouseDownEvent);

    const mouseMoveEvent = new MouseEvent('mousemove', {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: toX,
      clientY: toY
    });
    document.dispatchEvent(mouseMoveEvent);

    const mouseUpEvent = new MouseEvent('mouseup', {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: toX,
      clientY: toY
    });
    document.dispatchEvent(mouseUpEvent);

    _highlightElement(el, '#f0f');
  }
}

function _highlightElement(el, color) {
  if (_lastHighlightedEl && _lastHighlightedEl !== el) {
    _lastHighlightedEl.style.outline = '';
    _lastHighlightedEl.style.outlineOffset = '';
  }

  if (!el) return;

  if (el.tagName.match(/^(BUTTON|A|INPUT|TEXTAREA|SELECT)$/) || el.onclick) {
    el.style.outline = `3px solid ${color}`;
    el.style.outlineOffset = '2px';
    _lastHighlightedEl = el;
  }
}

function _drawCursorDot(x, y) {
  let dot = document.querySelector('#gesture-cursor-dot');

  if (!dot) {
    dot = document.createElement('div');
    dot.id = 'gesture-cursor-dot';
    dot.style.position = 'fixed';
    dot.style.zIndex = '9999';
    dot.style.pointerEvents = 'none';
    document.body.appendChild(dot);
  }

  dot.style.left = (x - 8) + 'px';
  dot.style.top = (y - 8) + 'px';
  dot.style.width = '16px';
  dot.style.height = '16px';
  dot.style.borderRadius = '50%';
  dot.style.backgroundColor = 'rgba(0, 100, 255, 0.5)';
  dot.style.border = '2px solid #0f0';
}

function _type(payload) {
  const { text } = payload;
  const el = document.activeElement;

  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
    el.value += text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function _pressKey(payload) {
  const { key } = payload;

  const keyMap = {
    'Backspace': 'Backspace',
    'Enter': 'Enter',
    'Shift': 'Shift',
    ' ': ' ',
    '?': '?'
  };

  const keyCode = keyMap[key] || key;
  const el = document.activeElement;

  if (keyCode === 'Backspace') {
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
      el.value = el.value.slice(0, -1);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } else if (keyCode === 'Enter') {
    if (el && el.tagName === 'TEXTAREA') {
      el.value += '\n';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } else {
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
      el.value += keyCode;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
}

function _navigate(payload) {
  const { url } = payload;
  window.location.href = url;
}

try {
  chrome.runtime.sendMessage({
    source: 'register-flow-tab'
  });
} catch (err) {
  // Extension not ready
}
