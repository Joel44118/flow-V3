// ═══════════════════════════════════════════
// flow-extension/background.js
//
// Service worker that bridges Flow (running
// in its own tab) to the currently active tab.
//
// Flow tab → background → active tab's content.js
// content.js result → background → Flow tab
//
// Flow sends: window.postMessage({ source:"flow-control", ... })
// Content script replies via chrome.runtime.sendMessage
// Background relays that reply back to Flow's tab via
// chrome.tabs.sendMessage
// ═══════════════════════════════════════════

// Track which tab Flow is running in
let flowTabId = null;

// Listen for messages from content.js (results of actions)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // Content script reporting an action result back to Flow
  if (msg.source === "flow-ext-result" && flowTabId) {
    chrome.tabs.sendMessage(flowTabId, {
      source:  "flow-ext-relay",
      ok:      msg.ok,
      action:  msg.action,
      result:  msg.result,
      error:   msg.error,
    }).catch(() => {}); // Flow tab may have been closed
    return;
  }

  // Content script in Flow's own tab registering itself
  if (msg.source === "flow-tab-register") {
    flowTabId = sender.tab?.id;
    sendResponse({ ok: true });
    return;
  }

  // Flow tab sending a control command via chrome.runtime.sendMessage
  // (backup path — primary path is via content.js intercepting postMessage)
  if (msg.source === "flow-control-bg") {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      const targetTab = tabs.find(t => t.id !== flowTabId);
      if (!targetTab) {
        if (flowTabId) {
          chrome.tabs.sendMessage(flowTabId, {
            source: "flow-ext-relay", ok: false,
            action: msg.action, error: "No active tab found to control.",
          }).catch(() => {});
        }
        return;
      }
      chrome.tabs.sendMessage(targetTab.id, {
        source:  "flow-control",
        action:  msg.action,
        payload: msg.payload,
      }).catch(e => {
        if (flowTabId) {
          chrome.tabs.sendMessage(flowTabId, {
            source: "flow-ext-relay", ok: false,
            action: msg.action, error: e.message,
          }).catch(() => {});
        }
      });
    });
    return;
  }
});

// When a tab is updated (navigated), re-inject content.js if needed
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete" && tabId !== flowTabId) {
    chrome.scripting.executeScript({
      target: { tabId },
      files:  ["content.js"],
    }).catch(() => {}); // fails silently on chrome:// pages etc.
  }
});
