let _flowTabId = null;
let _activeTargetTabId = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    if (msg.source === 'register-flow-tab') {
      _flowTabId = sender.tab.id;
      chrome.storage.session.set({ flowTabId: _flowTabId });
      sendResponse({ success: true });

    } else if (msg.source === 'flow-control-relay') {
      _findAndRouteToTargetTab(msg, sendResponse);

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

chrome.tabs.onActivated.addListener((activeInfo) => {
  if (activeInfo.tabId !== _flowTabId) {
    _activeTargetTabId = activeInfo.tabId;
    chrome.storage.session.set({ activeTargetTabId: _activeTargetTabId });
  }
});

async function _findAndRouteToTargetTab(msg, sendResponse) {
  try {
    // Restore _flowTabId and _activeTargetTabId from session storage in case worker restarted
    const stored = await chrome.storage.session.get(['flowTabId', 'activeTargetTabId']);
    if (stored.flowTabId) _flowTabId = stored.flowTabId;
    if (stored.activeTargetTabId) _activeTargetTabId = stored.activeTargetTabId;

    // If no active target, find the most recently active non-Flow tab
    if (!_activeTargetTabId) {
      const tabs = await chrome.tabs.query({});
      const nonFlowTabs = tabs.filter(t => t.id !== _flowTabId);
      if (nonFlowTabs.length > 0) {
        const sorted = nonFlowTabs.sort((a, b) => b.lastAccessed - a.lastAccessed);
        _activeTargetTabId = sorted[0].id;
      }
    }

    if (!_activeTargetTabId) {
      sendResponse({ success: false, error: 'No target tab found' });
      return;
    }

    // Route the command to the target tab's content script
    chrome.tabs.sendMessage(
      _activeTargetTabId,
      {
        source: 'flow-control-relay',
        action: msg.action,
        payload: msg.payload
      },
      (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse(response || { success: true, action: msg.action });
        }
      }
    );
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'flow-ext-wake') {
    port.disconnect();
  }
});
