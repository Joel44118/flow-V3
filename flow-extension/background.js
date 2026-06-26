// flow-extension/background.js (v4)
// Service worker — routes commands from content.js to target tab
// FIX: listen for 'flow-control-bg' (what content.js actually sends)
//      and send 'flow-control' to target tab (what target content.js listens for)

let _flowTabId        = null;
let _activeTargetTabId = null;

// Restore state from session storage on wake
async function _restoreState() {
  const stored = await chrome.storage.session.get(['flowTabId', 'activeTargetTabId']);
  if (stored.flowTabId)         _flowTabId        = stored.flowTabId;
  if (stored.activeTargetTabId) _activeTargetTabId = stored.activeTargetTabId;
}

_restoreState();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    // Flow tab registers itself
    if (msg.source === 'flow-tab-register') {
      _flowTabId = sender.tab?.id ?? null;
      if (_flowTabId) chrome.storage.session.set({ flowTabId: _flowTabId });
      sendResponse({ success: true });

    // Command from content.js (relayed from Flow page)
    } else if (msg.source === 'flow-control-bg') {
      _routeToTarget(msg, sender, sendResponse);

    } else if (msg.source === 'set-active-target-tab') {
      _activeTargetTabId = msg.tabId;
      chrome.storage.session.set({ activeTargetTabId: _activeTargetTabId });
      sendResponse({ success: true });
    }
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }

  return true; // keep channel open for async response
});

// Track which non-Flow tab was last active
chrome.tabs.onActivated.addListener((activeInfo) => {
  if (activeInfo.tabId !== _flowTabId) {
    _activeTargetTabId = activeInfo.tabId;
    chrome.storage.session.set({ activeTargetTabId: _activeTargetTabId });
  }
});

async function _routeToTarget(msg, sender, sendResponse) {
  try {
    await _restoreState();

    // Find target tab (last non-Flow tab)
    if (!_activeTargetTabId) {
      const tabs = await chrome.tabs.query({});
      const nonFlow = tabs.filter(t => t.id !== _flowTabId && t.url && !t.url.startsWith('chrome'));
      if (!nonFlow.length) { sendResponse({ success: false, error: 'No target tab' }); return; }
      nonFlow.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      _activeTargetTabId = nonFlow[0].id;
    }

    const flowTabId = sender.tab?.id ?? _flowTabId;

    // Send action to target tab's content.js
    chrome.tabs.sendMessage(
      _activeTargetTabId,
      { source: 'flow-control', action: msg.action, payload: msg.payload },
      (resp) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
          return;
        }

        // Relay result back to Flow tab's content.js → Flow page
        if (flowTabId) {
          chrome.tabs.sendMessage(flowTabId, {
            source: 'flow-ext-reply-relay',
            msgId:  msg.msgId,
            ok:     resp?.ok ?? true,
            action: msg.action,
            result: resp?.result ?? resp,
            error:  resp?.error
          }, () => { if (chrome.runtime.lastError) {} });
        }

        sendResponse(resp || { success: true });
      }
    );
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

// Wake handler
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'flow-wake') port.disconnect();
});
