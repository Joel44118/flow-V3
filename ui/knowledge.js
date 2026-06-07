// ═══════════════════════════════════════════
// ui/knowledge.js — Knowledge Base UI
//
// Floating panel to manage Flow's RAG docs.
// Open with 📚 button or say "open knowledge base"
//
// Features:
//   - Upload .txt/.md files as knowledge docs
//   - Type/paste text directly
//   - List all saved docs
//   - Delete docs
// ═══════════════════════════════════════════
import { RAG } from "../core/rag.js";

let _chat   = null;
let _panel  = null;
let _list   = null;
let _open   = false;

export function initKnowledge(chat) {
  _chat = chat;
  _buildPanel();
  _buildButton();
}

function _buildButton() {
  const btn = document.createElement("div");
  btn.id    = "kb-btn";
  btn.title = "Knowledge Base";
  btn.textContent = "📚";
  btn.addEventListener("click", () => _open ? close() : open());
  document.body.appendChild(btn);
}

function _buildPanel() {
  _panel = document.createElement("div");
  _panel.id = "kb-panel";
  _panel.innerHTML = `
    <div id="kb-header">
      <span id="kb-title">📚 KNOWLEDGE BASE</span>
      <button id="kb-close">✕</button>
    </div>
    <div id="kb-body">
      <div id="kb-add">
        <input id="kb-name" type="text" placeholder="Document title..." />
        <textarea id="kb-content" placeholder="Paste text here — or upload a file below..."></textarea>
        <div id="kb-actions">
          <button id="kb-save-btn">SAVE</button>
          <label id="kb-upload-label">UPLOAD FILE
            <input type="file" id="kb-file-input" accept=".txt,.md,.csv,.js,.py,.json" style="display:none">
          </label>
        </div>
        <div id="kb-status"></div>
      </div>
      <div id="kb-divider">SAVED DOCUMENTS</div>
      <div id="kb-list"></div>
    </div>`;
  document.body.appendChild(_panel);

  _list = _panel.querySelector("#kb-list");

  _panel.querySelector("#kb-close").addEventListener("click", close);

  // Save button
  _panel.querySelector("#kb-save-btn").addEventListener("click", async () => {
    const title   = _panel.querySelector("#kb-name").value.trim();
    const content = _panel.querySelector("#kb-content").value.trim();
    if (!title || !content) { _setStatus("Enter a title and content first.", "warn"); return; }
    _setStatus("Saving...", "info");
    const ok = await RAG.save(title, content);
    if (ok) {
      _setStatus(`✓ Saved "${title}"`, "ok");
      _panel.querySelector("#kb-name").value    = "";
      _panel.querySelector("#kb-content").value = "";
      _chat?.add(`Knowledge doc saved: "${title}". I'll use it when relevant.`, "bot");
      refreshList();
    } else {
      _setStatus("Save failed — check Vercel KV is connected.", "error");
    }
  });

  // File upload
  _panel.querySelector("#kb-file-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const content = await file.text();
    const { title } = RAG.parseDocument(file.name, content);
    _panel.querySelector("#kb-name").value    = title;
    _panel.querySelector("#kb-content").value = content;
    _setStatus(`Loaded "${file.name}" — click SAVE to store it.`, "info");
    e.target.value = "";
  });
}

async function refreshList() {
  _list.innerHTML = "<div class='kb-loading'>Loading...</div>";
  const keys = await RAG.list();
  _list.innerHTML = "";
  if (!keys.length) {
    _list.innerHTML = "<div class='kb-empty'>No documents yet. Add one above.</div>";
    return;
  }
  keys.forEach(title => {
    const row = document.createElement("div");
    row.className = "kb-row";
    row.innerHTML = `<span class="kb-doc-title">${title}</span><button class="kb-del" data-title="${title}">✕</button>`;
    row.querySelector(".kb-del").addEventListener("click", async (e) => {
      const t = e.target.dataset.title;
      await RAG.delete(t);
      _chat?.add(`Removed knowledge doc: "${t}".`, "bot");
      refreshList();
    });
    _list.appendChild(row);
  });
}

function _setStatus(msg, type) {
  const el = _panel.querySelector("#kb-status");
  el.textContent  = msg;
  el.className    = `kb-status-${type}`;
  if (type === "ok") setTimeout(() => { el.textContent = ""; }, 3000);
}

export const Knowledge = {
  open() {
    _panel.classList.add("open");
    _open = true;
    refreshList();
  },
  close() {
    _panel.classList.remove("open");
    _open = false;
  },
  toggle() { _open ? close() : open(); },
};

function open()  { Knowledge.open(); }
function close() { Knowledge.close(); }
