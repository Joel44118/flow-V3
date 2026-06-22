// flow-extension/background.js (v3)
// ONE onMessage listener — fixes gray extension / inactive service worker

let flowTabId = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.source === "flow-tab-register") {
    const url = sender.tab?.url || "";
    if (url.includes("localhost") || url.includes("vercel.app") || url.includes("flow")) {
      flowTabId = sender.tab.id;
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.source === "flow-control-bg") {
    const { action, payload } = msg;

    chrome.tabs.query({ active: true }, (tabs) => {
      const targetTab = tabs.find(
        t => t.id !== flowTabId && !t.url?.startsWith("chrome://")
      );

      if (targetTab) {
        _forwardToTab(targetTab.id, action, payload);
        return;
      }

      chrome.tabs.query({}, (allTabs) => {
        const candidates = allTabs.filter(
          t => t.id !== flowTabId &&
               !t.url?.startsWith("chrome://") &&
               !t.url?.startsWith("chrome-extension://")
        );
        candidates.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
        const fallback = candidates[0];
        if (fallback) {
          _forwardToTab(fallback.id, action, payload);
        } else {
          _replyToFlow({
            ok: false, action,
            error: "No controllable tab found — open another tab first.",
          });
        }
      });
    });

    sendResponse({ received: true });
    return true;
  }

  return false;
});

function _forwardToTab(tabId, action, payload) {
  chrome.tabs.sendMessage(
    tabId,
    { source: "flow-control", action, payload },
    (result) => {
      if (chrome.runtime.lastError) {
        chrome.scripting.executeScript(
          { target: { tabId }, files: ["content.js"] },
          () => {
            if (chrome.runtime.lastError) {
              _replyToFlow({ ok: false, action, error: "Cannot inject into that page." });
              return;
            }
            setTimeout(() => {
              chrome.tabs.sendMessage(
                tabId,
                { source: "flow-control", action, payload },
                (r2) => {
                  if (chrome.runtime.lastError || !r2) {
                    _replyToFlow({ ok: false, action, error: "Injection retry failed." });
                  } else {
                    _replyToFlow({ ok: r2.ok, action, result: r2.result, error: r2.error });
                  }
                }
              );
            }, 300);
          }
        );
        return;
      }
      _replyToFlow({
        ok:     result?.ok ?? false,
        action,
        result: result?.result,
        error:  result?.error,
      });
    }
  );
}

function _replyToFlow(data) {
  if (!flowTabId) return;
  chrome.tabs.sendMessage(flowTabId, {
    source: "flow-ext-reply-relay",
    ...data,
  }).catch(() => {});
}
