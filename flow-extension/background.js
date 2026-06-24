// flow-extension/background.js (v6)
// Changes:
//  • switch_tab action: activates prev/next tab relative to current
//  • Gesture actions (cursor_move, gesture_click, right_click, etc.) are
//    forwarded to the LAST FOCUSED non-Flow tab, not just "active" tab.
//    This lets you gesture-control any tab you've previously visited,
//    even when you switch back to Flow to trigger gestures.
//  • flowTabId persisted in chrome.storage.session (survives worker sleep).

// Store last non-Flow tab ID so gestures always reach the targeted tab
// even when user switches back to the Flow tab.
let _lastNonFlowTabId = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "flow-wake") port.disconnect();
});

// Track which tab the user is actively looking at (for gesture forwarding)
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.storage.session.get("flowTabId", ({ flowTabId }) => {
    if (tabId !== flowTabId) {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) return;
        if (!tab.url?.startsWith("chrome://") && !tab.url?.startsWith("chrome-extension://")) {
          _lastNonFlowTabId = tabId;
          chrome.storage.session.set({ lastNonFlowTabId: tabId });
        }
      });
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── Tab registration ──────────────────────────────────────────────────
  if (msg.source === "flow-tab-register") {
    const url = sender.tab?.url || "";
    if (url.includes("localhost") || url.includes("vercel.app") || url.includes("flow")) {
      chrome.storage.session.set({ flowTabId: sender.tab.id });
    }
    sendResponse({ ok: true });
    return true;
  }

  // ── Control commands ──────────────────────────────────────────────────
  if (msg.source === "flow-control-bg") {
    const { action, payload } = msg;
    sendResponse({ received: true });

    // switch_tab: change active tab without forwarding to content
    if (action === "switch_tab") {
      _handleSwitchTab(payload?.direction || "right");
      return true;
    }

    chrome.storage.session.get(["flowTabId", "lastNonFlowTabId"], (data) => {
      const flowTabId = data.flowTabId;
      const savedLastTab = data.lastNonFlowTabId;
      if (savedLastTab) _lastNonFlowTabId = savedLastTab;

      // For gesture real-time actions, prefer the last non-Flow tab
      // (so gestures follow you to whichever tab you're controlling)
      const isGestureAction = [
        "cursor_move","gesture_click","right_click","middle_click",
        "drag_start","drag_move","drag_end","show_keyboard","hide_keyboard",
        "kb_highlight","gesture_cleanup","key","scroll","nav_history",
      ].includes(action);

      if (isGestureAction && _lastNonFlowTabId) {
        // Try last known non-Flow tab first
        _forwardToTab(_lastNonFlowTabId, action, payload, flowTabId);
        return;
      }

      // Fallback: find any active non-Flow tab
      chrome.tabs.query({ active: true }, (tabs) => {
        const targetTab = tabs.find(
          t => t.id !== flowTabId && !t.url?.startsWith("chrome://")
        );
        if (targetTab) {
          if (!flowTabId || targetTab.id !== flowTabId) {
            _lastNonFlowTabId = targetTab.id;
            chrome.storage.session.set({ lastNonFlowTabId: targetTab.id });
          }
          _forwardToTab(targetTab.id, action, payload, flowTabId);
          return;
        }

        // Last resort: any non-Flow tab
        chrome.tabs.query({}, (allTabs) => {
          const candidates = allTabs.filter(t =>
            t.id !== flowTabId &&
            !t.url?.startsWith("chrome://") &&
            !t.url?.startsWith("chrome-extension://")
          );
          candidates.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
          if (candidates[0]) {
            _lastNonFlowTabId = candidates[0].id;
            chrome.storage.session.set({ lastNonFlowTabId: candidates[0].id });
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

// ── Switch tab left/right ─────────────────────────────────────────────────
function _handleSwitchTab(direction) {
  chrome.tabs.query({ currentWindow: true }, (tabs) => {
    if (!tabs || tabs.length < 2) return;
    tabs.sort((a, b) => a.index - b.index);
    const activeIdx = tabs.findIndex(t => t.active);
    if (activeIdx < 0) return;
    let nextIdx;
    if (direction === "left") {
      nextIdx = activeIdx > 0 ? activeIdx - 1 : tabs.length - 1;
    } else {
      nextIdx = activeIdx < tabs.length - 1 ? activeIdx + 1 : 0;
    }
    chrome.tabs.update(tabs[nextIdx].id, { active: true });
  });
}

// ── Forward to tab ────────────────────────────────────────────────────────
function _forwardToTab(tabId, action, payload, flowTabId) {
  chrome.tabs.sendMessage(tabId, { source: "flow-control", action, payload }, (result) => {
    if (chrome.runtime.lastError) {
      // Try injecting content.js first
      chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }, () => {
        if (chrome.runtime.lastError) {
          // Only show error for non-cursor/non-cleanup actions
          if (action !== "cursor_move" && action !== "gesture_cleanup") {
            _replyToFlow({ ok: false, action, error: "Cannot inject into that page." }, flowTabId);
          }
          return;
        }
        setTimeout(() => {
          chrome.tabs.sendMessage(tabId, { source: "flow-control", action, payload }, (r2) => {
            if (chrome.runtime.lastError || !r2) {
              if (action !== "cursor_move" && action !== "gesture_cleanup") {
                _replyToFlow({ ok: false, action, error: "Injection retry failed." }, flowTabId);
              }
            } else {
              _replyToFlow({ ok: r2.ok, action, result: r2.result, error: r2.error }, flowTabId);
            }
          });
        }, 300);
      });
      return;
    }
    // Suppress noisy cursor_move replies
    if (action !== "cursor_move" && action !== "drag_move") {
      _replyToFlow({ ok: result?.ok ?? false, action, result: result?.result, error: result?.error }, flowTabId);
    }
  });
}

function _replyToFlow(data, flowTabId) {
  if (!flowTabId) return;
  chrome.tabs.sendMessage(flowTabId, { source: "flow-ext-reply-relay", ...data }).catch(() => {});
}
