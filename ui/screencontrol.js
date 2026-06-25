let _extId = null;
let _pendingTimeout = null;
let _lastScrollTime = 0;
const SCROLL_DEBOUNCE_MS = 100;

async function _requestExtId() {
  const maxRetries = 3;
  for (let i = 0; i < maxRetries; i++) {
    window.postMessage({ source: 'flow-ext-id-request' }, '*');
    await new Promise(r => setTimeout(r, 500 + i * 1000));
    if (_extId) break;
  }
}

window.addEventListener('message', (event) => {
  if (event.data.source === 'flow-ext-id-reply') {
    _extId = event.data.extensionId;
    console.log('[Flow SC] Extension ID:', _extId);
  } else if (event.data.source === 'flow-control-reply') {
    if (_pendingTimeout) {
      clearTimeout(_pendingTimeout);
      _pendingTimeout = null;
    }
  }
});

export function sendToExtension(action, payload) {
  if (!_extId) {
    console.warn('[Flow SC] Extension not connected yet. Retrying...');
    _requestExtId();
    return;
  }

  try {
    // Debounce scroll to avoid flooding the channel
    if (action === 'scroll') {
      const now = Date.now();
      if (now - _lastScrollTime < SCROLL_DEBOUNCE_MS) {
        return;
      }
      _lastScrollTime = now;
    }

    // Send via chrome.runtime with extension ID
    chrome.runtime.sendMessage(
      _extId,
      {
        source: 'flow-control-relay',
        action: action,
        payload: payload
      },
      (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[Flow SC] Could not establish connection:', chrome.runtime.lastError.message);
        }
      }
    );

    // Set timeout for no-response case (but don't show to chat)
    if (_pendingTimeout) clearTimeout(_pendingTimeout);
    _pendingTimeout = setTimeout(() => {
      _pendingTimeout = null;
    }, 3000);

  } catch (err) {
    console.error('[Flow SC] Send error:', err.message);
  }
}

export async function initScreenControl() {
  await _requestExtId();
  return { sendToExtension };
}
