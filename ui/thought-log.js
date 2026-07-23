// ui/thought-log.js
//
// REAL, Joel-requested feature: a dedicated place to see Flow's internal
// <flow-think> reasoning that gets stripped from replies before they
// reach the chat (see api/chat.js's cleanReply/_logThought, added
// earlier this session to fix a real leak bug). Rather than either
// leaking into the chat OR vanishing with no trace, every stripped
// thought gets logged server-side to a real KV key
// (flow_thought_log), and this module gives Joel an actual UI to browse
// it whenever he wants — entirely separate from the normal chat log.

let _panelEl = null;

function _injectStyles() {
  if (document.getElementById("thought-log-style")) return;
  const style = document.createElement("style");
  style.id = "thought-log-style";
  style.textContent = `
#thought-log-tab {
  position: fixed; top: 50%; right: 0; transform: translateY(calc(-50% + 100px));
  width: 24px; height: 64px;
  background: rgba(30,20,55,0.9); border: 1px solid rgba(167,139,250,0.3);
  border-right: none; border-radius: 10px 0 0 10px;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; z-index: 9997; color: #8b7cc9; font-size: 13px;
  box-shadow: -3px 0 12px rgba(0,0,0,0.3);
}
#thought-log-tab:hover { background: rgba(50,35,85,0.95); }

#thought-log-panel {
  position: fixed; top: 0; right: 0; bottom: 0;
  width: min(420px, 90vw);
  background: rgba(12,8,24,0.98); border-left: 1px solid rgba(167,139,250,0.3);
  box-shadow: -12px 0 40px rgba(0,0,0,0.5);
  z-index: 9996; display: flex; flex-direction: column;
  font-family: system-ui, sans-serif; color: #e5e7eb;
  transform: translateX(100%); transition: transform 0.25s ease;
}
#thought-log-panel.tl-open { transform: translateX(0); }

#thought-log-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 16px; border-bottom: 1px solid rgba(167,139,250,0.2);
  background: rgba(139,124,201,0.08); flex-shrink: 0;
}
#thought-log-header h3 { margin: 0; font-size: 13px; font-weight: 700; color: #8b7cc9; letter-spacing: .03em; }
#thought-log-close { background: none; border: none; color: #9ca3af; font-size: 18px; cursor: pointer; padding: 2px 6px; }
#thought-log-close:hover { color: #f87171; }
#thought-log-refresh { background: none; border: 1px solid rgba(167,139,250,0.3); border-radius: 6px; color: #d8d4ff; font-size: 11px; cursor: pointer; padding: 4px 8px; margin-right: 8px; }
#thought-log-refresh:hover { background: rgba(167,139,250,0.15); }

#thought-log-list { flex: 1; overflow-y: auto; padding: 12px 16px; }
.tl-entry {
  border: 1px solid rgba(167,139,250,0.15); border-radius: 8px;
  padding: 10px; margin-bottom: 8px; background: rgba(255,255,255,0.02);
}
.tl-entry-meta { font-size: 10px; color: #8b7cc9; margin-bottom: 4px; display: flex; justify-content: space-between; }
.tl-entry-text { font-size: 12px; color: rgba(255,255,255,0.8); white-space: pre-wrap; word-wrap: break-word; overflow-wrap: anywhere; }
.tl-empty { text-align: center; color: rgba(255,255,255,0.35); font-size: 12px; padding: 40px 20px; font-style: italic; }
`;
  document.head.appendChild(style);
}

async function _fetchThoughtLog() {
  try {
    const res = await fetch("/api/memory?key=flow_thought_log");
    if (!res.ok) return [];
    const data = await res.json();
    const log = Array.isArray(data.value) ? data.value : [];
    // Real, most-recent-first — a thought log is most useful read newest-to-oldest.
    return [...log].reverse();
  } catch (_) {
    return [];
  }
}

async function _renderList(listEl) {
  listEl.innerHTML = `<div class="tl-empty">Loading...</div>`;
  const entries = await _fetchThoughtLog();
  if (!entries.length) {
    listEl.innerHTML = `<div class="tl-empty">No thoughts logged yet.<br>This fills in as Flow's internal reasoning gets captured during real conversations.</div>`;
    return;
  }
  listEl.innerHTML = "";
  entries.forEach((entry) => {
    const div = document.createElement("div");
    div.className = "tl-entry";
    const meta = document.createElement("div");
    meta.className = "tl-entry-meta";
    const date = new Date(entry.ts || Date.now());
    meta.innerHTML = `<span>${date.toLocaleString()}</span><span>${entry.intent ? entry.intent : ""}</span>`;
    const text = document.createElement("div");
    text.className = "tl-entry-text";
    text.textContent = entry.thought || "(empty)";
    div.appendChild(meta);
    div.appendChild(text);
    listEl.appendChild(div);
  });
}

export function openThoughtLog() {
  _injectStyles();
  if (_panelEl) {
    _panelEl.classList.add("tl-open");
    _renderList(_panelEl.querySelector("#thought-log-list"));
    return;
  }

  const panel = document.createElement("div");
  panel.id = "thought-log-panel";

  const header = document.createElement("div");
  header.id = "thought-log-header";
  header.innerHTML = `<h3>🧠 Flow's Thoughts</h3>`;

  const refreshBtn = document.createElement("button");
  refreshBtn.id = "thought-log-refresh";
  refreshBtn.textContent = "↻ Refresh";
  header.appendChild(refreshBtn);

  const closeBtn = document.createElement("button");
  closeBtn.id = "thought-log-close";
  closeBtn.textContent = "✕";
  closeBtn.onclick = closeThoughtLog;
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const list = document.createElement("div");
  list.id = "thought-log-list";
  panel.appendChild(list);

  refreshBtn.onclick = () => _renderList(list);

  document.body.appendChild(panel);
  _panelEl = panel;
  requestAnimationFrame(() => panel.classList.add("tl-open"));
  document.getElementById("thought-log-tab")?.classList.add("tl-tray-open");

  _renderList(list);
}

export function closeThoughtLog() {
  if (_panelEl) _panelEl.classList.remove("tl-open");
}

export function isThoughtLogOpen() {
  return !!_panelEl?.classList.contains("tl-open");
}

export function initThoughtLog() {
  _injectStyles();
  const tab = document.createElement("div");
  tab.id = "thought-log-tab";
  tab.title = "Flow's Thoughts";
  tab.textContent = "🧠";
  tab.addEventListener("click", () => {
    if (isThoughtLogOpen()) closeThoughtLog();
    else openThoughtLog();
  });
  document.body.appendChild(tab);
}
