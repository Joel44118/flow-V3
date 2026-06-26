// flow-extension/background.js (v5)
// FIX: Don't use onActivated to track _activeTargetTabId before _flowTabId is known.
//      Instead, find the target tab dynamically at command time — most recently active
//      non-Flow, non-chrome tab. This is reliable regardless of load order.

let _flowTabId        = null;
let _activeTargetTabId = null;

async function _restoreState() {
  const stored = await chrome.storage.session.get(['flowTabId', 'activeTargetTabId']);
  if (stored.flowTabId)         _flowTabId        = stored.flowTabId;
  if (stored.activeTargetTabId) _activeTargetTabId = stored.activeTargetTabId;
}

_restoreState();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    if (msg.source === 'flow-tab-register') {
      _flowTabId = sender.tab?.id ?? null;
      if (_flowTabId) chrome.storage.session.set({ flowTabId: _flowTabId });
      sendResponse({ success: true });

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
  return true;
});

// Only track activated tabs AFTER we know the Flow tab ID
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  // Restore in case worker restarted
  if (!_flowTabId) {
    const stored = await chrome.storage.session.get(['flowTabId']);
    if (stored.flowTabId) _flowTabId = stored.flowTabId;
  }
  // Only record as target if it's NOT the Flow tab
  if (_flowTabId && activeInfo.tabId !== _flowTabId) {
    _activeTargetTabId = activeInfo.tabId;
    chrome.storage.session.set({ activeTargetTabId: _activeTargetTabId });
  }
});

async function _routeToTarget(msg, sender, sendResponse) {
  try {
    await _restoreState();

    const flowTabId = sender.tab?.id ?? _flowTabId;

    // Find target: prefer tracked tab, else most-recent non-Flow non-chrome tab
    let targetId = _activeTargetTabId;

    if (!targetId || targetId === flowTabId) {
      const tabs = await chrome.tabs.query({});
      const candidates = tabs.filter(t =>
        t.id !== flowTabId &&
        t.url &&
        !t.url.startsWith('chrome') &&
        !t.url.startsWith('about')
      );
      if (!candidates.length) {
        sendResponse({ success: false, error: 'No target tab found. Open a tab to control.' });
        return;
      }
      candidates.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      targetId = candidates[0].id;
      _activeTargetTabId = targetId;
      chrome.storage.session.set({ activeTargetTabId: targetId });
    }

    // Send action to target tab
    chrome.tabs.sendMessage(
      targetId,
      { source: 'flow-control', action: msg.action, payload: msg.payload },
      (resp) => {
        const err = chrome.runtime.lastError;
        if (err) {
          // content.js may not be injected — try scripting.executeScript fallback
          _injectAndRetry(targetId, msg, flowTabId, sendResponse);
          return;
        }

        // Relay result back to Flow tab's content.js → page
        if (flowTabId) {
          chrome.tabs.sendMessage(flowTabId, {
            source: 'flow-ext-reply-relay',
            msgId:  msg.msgId,
            ok:     resp?.ok ?? true,
            action: msg.action,
            result: resp?.result ?? resp,
            error:  resp?.error
          }, () => { chrome.runtime.lastError; /* suppress */ });
        }

        sendResponse(resp || { success: true });
      }
    );
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

// Fallback: inject content.js if it wasn't auto-injected (e.g. tabs opened before extension install)
async function _injectAndRetry(tabId, msg, flowTabId, sendResponse) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files:  ['content.js']
    });
    setTimeout(() => {
      chrome.tabs.sendMessage(
        tabId,
        { source: 'flow-control', action: msg.action, payload: msg.payload },
        (resp) => {
          chrome.runtime.lastError;
          if (flowTabId) {
            chrome.tabs.sendMessage(flowTabId, {
              source: 'flow-ext-reply-relay',
              msgId:  msg.msgId,
              ok:     resp?.ok ?? true,
              action: msg.action,
              result: resp?.result ?? resp,
              error:  resp?.error
            }, () => { chrome.runtime.lastError; });
          }
          sendResponse(resp || { success: true });
        }
      );
    }, 300);
  } catch (err) {
    sendResponse({ success: false, error: 'Cannot inject into this tab: ' + err.message });
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'flow-wake') port.disconnect();
});
