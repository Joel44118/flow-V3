// flow-extension/background.js (v4)
// KEY FIX: MV3 service workers lose all variables when they go inactive.
// flowTabId was null every time the worker woke up, so _replyToFlow()
// was always a no-op. Now stored in chrome.storage.session which persists
// across service worker restarts within the same browser session.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.source === "flow-tab-register") {
    const url = sender.tab?.url || "";
    if (url.includes("localhost") || url.includes("vercel.app") || url.includes("flow")) {
      // Persist so it survives worker sleep/wake cycles
      chrome.storage.session.set({ flowTabId: sender.tab.id });
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.source === "flow-control-bg") {
    const { action, payload } = msg;
    sendResponse({ received: true });

    // Get flowTabId from session storage (survives worker restarts)
    chrome.storage.session.get("flowTabId", ({ flowTabId }) => {
      chrome.tabs.query({ active: true }, (tabs) => {
        const targetTab = tabs.find(
          t => t.id !== flowTabId && !t.url?.startsWith("chrome://")
        );
        if (targetTab) { _forwardToTab(targetTab.id, action, payload, flowTabId); return; }

        chrome.tabs.query({}, (allTabs) => {
          const candidates = allTabs.filter(t =>
            t.id !== flowTabId &&
            !t.url?.startsWith("chrome://") &&
            !t.url?.startsWith("chrome-extension://")
          );
          candidates.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
          if (candidates[0]) {
            _forwardToTab(candidates[0].id, action, payload, flowTabId);
          } else {
            _replyToFlow({ ok: false, action, error: "No controllable tab found." }, flowTabId);
          }
        });
      });
    });
    return true;
  }

  return false;
});

function _forwardToTab(tabId, action, payload, flowTabId) {
  chrome.tabs.sendMessage(tabId, { source: "flow-control", action, payload }, (result) => {
    if (chrome.runtime.lastError) {
      chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }, () => {
        if (chrome.runtime.lastError) {
          _replyToFlow({ ok: false, action, error: "Cannot inject into that page." }, flowTabId);
          return;
        }
        setTimeout(() => {
          chrome.tabs.sendMessage(tabId, { source: "flow-control", action, payload }, (r2) => {
            if (chrome.runtime.lastError || !r2) {
              _replyToFlow({ ok: false, action, error: "Injection retry failed." }, flowTabId);
            } else {
              _replyToFlow({ ok: r2.ok, action, result: r2.result, error: r2.error }, flowTabId);
            }
          });
        }, 300);
      });
      return;
    }
    _replyToFlow({ ok: result?.ok ?? false, action, result: result?.result, error: result?.error }, flowTabId);
  });
}

function _replyToFlow(data, flowTabId) {
  if (!flowTabId) return;
  chrome.tabs.sendMessage(flowTabId, { source: "flow-ext-reply-relay", ...data }).catch(() => {});
}
