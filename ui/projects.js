// ═══════════════════════════════════════════
// ui/projects.js — Project Workspace Panel
// ═══════════════════════════════════════════
import { Projects } from "../core/projects.js";

let _chat    = null;
let _sendFn  = null;
let _panel   = null;
let _btn     = null;
let _open    = false;
let _active  = null;  // currently selected project name

export function initProjects(chat, sendFn) {
  _chat   = chat;
  _sendFn = sendFn;
  _build();
}

export function handleProjectCommand(parsed) {
  switch (parsed.action) {
    case "list":
      _chat.add(Projects.formatList(), "bot");
      return true;

    case "switch": {
      const p = Projects.get(parsed.name);
      if (!p) {
        _chat.add(`No project named "${parsed.name}". Say "add project ${parsed.name}" to create it.`, "bot");
      } else {
        _active = p.name;
        _chat.add(`Switched to ${p.name}.\n\n${Projects.formatCard(p)}`, "bot");
        _refresh();
      }
      return true;
    }

    case "add": {
      // Ask Flow to gather details then save
      _sendFn(`You are helping Joel create a new project workspace called "${parsed.name}". Ask him for: description, tech stack, GitHub repo URL (optional), client name (optional). Keep it short — one message, bullet list of questions.`);
      return true;
    }

    case "note": {
      const result = Projects.addNote(parsed.name, parsed.value);
      _chat.add(result ? `Note added to ${parsed.name}.` : `Project "${parsed.name}" not found.`, "bot");
      _refresh();
      return true;
    }

    case "goal": {
      const result = Projects.addGoal(parsed.name, parsed.value);
      _chat.add(result ? `Goal added to ${parsed.name}: "${parsed.value}"` : `Project "${parsed.name}" not found.`, "bot");
      _refresh();
      return true;
    }

    case "status": {
      const result = Projects.setStatus(parsed.name, parsed.value);
      _chat.add(result ? `${parsed.name} marked as ${parsed.value}.` : `Project "${parsed.name}" not found.`, "bot");
      _refresh();
      return true;
    }

    case "delete": {
      Projects.delete(parsed.name);
      _chat.add(`Project "${parsed.name}" deleted.`, "bot");
      if (_active?.toLowerCase() === parsed.name.toLowerCase()) _active = null;
      _refresh();
      return true;
    }
  }
  return false;
}

// ── Build UI ──────────────────────────────────────────────────────────────
function _build() {
  // Button
  _btn = document.createElement("div");
  _btn.id        = "proj-btn";
  _btn.title     = "Project Workspaces";
  _btn.textContent = "📁";
  _btn.addEventListener("click", () => _open ? _close() : _openPanel());
  document.body.appendChild(_btn);

  // Panel
  _panel = document.createElement("div");
  _panel.id = "proj-panel";
  _panel.innerHTML = `
    <div id="proj-header">
      <span id="proj-title">📁 PROJECTS</span>
      <button id="proj-close">✕</button>
    </div>
    <div id="proj-body">
      <div id="proj-list-wrap"></div>
      <div id="proj-detail-wrap" style="display:none"></div>
    </div>
    <div id="proj-footer">
      <input id="proj-new-input" placeholder="New project name..." />
      <button id="proj-new-btn">+ Add</button>
    </div>
  `;
  document.body.appendChild(_panel);

  document.getElementById("proj-close").addEventListener("click", _close);
  document.getElementById("proj-new-btn").addEventListener("click", _addNew);
  document.getElementById("proj-new-input").addEventListener("keydown", e => {
    if (e.key === "Enter") _addNew();
  });
}

function _openPanel() {
  _open = true;
  _panel.classList.add("open");
  _btn.classList.add("active");
  _refresh();
}

function _close() {
  _open = false;
  _panel.classList.remove("open");
  _btn.classList.remove("active");
}

function _refresh() {
  if (!_open) return;
  const projects = Projects.all();
  const listWrap = document.getElementById("proj-list-wrap");

  if (!projects.length) {
    listWrap.innerHTML = `<div class="proj-empty">No projects yet.<br>Add one below.</div>`;
    return;
  }

  listWrap.innerHTML = projects.map(p => `
    <div class="proj-item${_active === p.name ? " proj-active" : ""}" data-name="${p.name}">
      <div class="proj-item-name">
        <span class="proj-item-icon">${_statusIcon(p.status)}</span>
        ${p.name}
      </div>
      <div class="proj-item-meta">${p.stack || ""}${p.client ? ` · ${p.client}` : ""}</div>
      <div class="proj-item-goals">${_goalsLine(p)}</div>
    </div>
  `).join("");

  listWrap.querySelectorAll(".proj-item").forEach(el => {
    el.addEventListener("click", () => {
      const name = el.dataset.name;
      _active = name;
      _showDetail(Projects.get(name));
      _refresh();
    });
  });
}

function _showDetail(p) {
  if (!p) return;
  const detailWrap = document.getElementById("proj-detail-wrap");
  const listWrap   = document.getElementById("proj-list-wrap");

  const openGoals = p.goals?.filter(g => !g.done) || [];
  const doneGoals = p.goals?.filter(g => g.done)  || [];

  detailWrap.style.display = "block";
  listWrap.style.display   = "none";

  detailWrap.innerHTML = `
    <div class="proj-detail-header">
      <button id="proj-back">← Back</button>
      <span class="proj-detail-name">${p.name}</span>
      <select id="proj-status-sel">
        ${["active","paused","complete","archived"].map(s =>
          `<option value="${s}"${p.status===s?" selected":""}>${s}</option>`
        ).join("")}
      </select>
    </div>
    ${p.description ? `<div class="proj-detail-desc">${p.description}</div>` : ""}
    <div class="proj-detail-meta">
      ${p.stack  ? `<span>🔧 ${p.stack}</span>` : ""}
      ${p.repo   ? `<a href="${p.repo}" target="_blank">📦 Repo</a>` : ""}
      ${p.client ? `<span>👤 ${p.client}</span>` : ""}
    </div>

    <div class="proj-section-label">GOALS</div>
    <div id="proj-goals">
      ${openGoals.map((g,i) => `
        <div class="proj-goal" data-i="${i}">
          <input type="checkbox" class="proj-goal-cb"> ${g.text}
        </div>`).join("")}
      ${doneGoals.map(g => `<div class="proj-goal done">✓ ${g.text}</div>`).join("")}
    </div>
    <div class="proj-add-row">
      <input id="proj-goal-input" placeholder="Add goal..." />
      <button id="proj-goal-btn">+</button>
    </div>

    <div class="proj-section-label">NOTES</div>
    <textarea id="proj-notes-ta" placeholder="Project notes...">${p.notes || ""}</textarea>
    <button id="proj-notes-save">Save notes</button>

    <button id="proj-ask-flow">💬 Ask Flow about this project</button>
    <button id="proj-delete" class="proj-danger">🗑 Delete project</button>
  `;

  document.getElementById("proj-back").addEventListener("click", () => {
    detailWrap.style.display = "none";
    listWrap.style.display   = "block";
    _active = null;
  });

  document.getElementById("proj-status-sel").addEventListener("change", e => {
    Projects.setStatus(p.name, e.target.value);
  });

  document.getElementById("proj-goal-btn").addEventListener("click", () => {
    const val = document.getElementById("proj-goal-input").value.trim();
    if (!val) return;
    Projects.addGoal(p.name, val);
    document.getElementById("proj-goal-input").value = "";
    _showDetail(Projects.get(p.name));
  });

  document.getElementById("proj-goal-input").addEventListener("keydown", e => {
    if (e.key === "Enter") document.getElementById("proj-goal-btn").click();
  });

  detailWrap.querySelectorAll(".proj-goal-cb").forEach((cb, i) => {
    cb.addEventListener("change", () => {
      Projects.completeGoal(p.name, i);
      _showDetail(Projects.get(p.name));
    });
  });

  document.getElementById("proj-notes-save").addEventListener("click", () => {
    const notes = document.getElementById("proj-notes-ta").value;
    Projects.patch(p.name, { notes });
    _chat.add(`Notes saved for ${p.name}.`, "bot");
  });

  document.getElementById("proj-ask-flow").addEventListener("click", () => {
    _close();
    const proj = Projects.get(p.name);
    _sendFn(`I want to talk about my project: ${proj.name}.\n${Projects.formatCard(proj)}\n\nWhat should I focus on next?`);
  });

  document.getElementById("proj-delete").addEventListener("click", () => {
    if (!confirm(`Delete project "${p.name}"?`)) return;
    Projects.delete(p.name);
    _active = null;
    detailWrap.style.display = "none";
    listWrap.style.display   = "block";
    _refresh();
  });
}

function _addNew() {
  const input = document.getElementById("proj-new-input");
  const name  = input.value.trim();
  if (!name) return;
  Projects.save({ name });
  input.value = "";
  _chat.add(`Project "${name}" created. You can add details by clicking it in the panel, or tell me: "add project ${name}: description here, stack: React, repo: https://github.com/..."`, "bot");
  _refresh();
}

function _statusIcon(status) {
  return { active:"🟢", paused:"🟡", complete:"✅", archived:"📦" }[status] || "🔵";
}

function _goalsLine(p) {
  const open = p.goals?.filter(g => !g.done).length || 0;
  const done = p.goals?.filter(g => g.done).length  || 0;
  if (!p.goals?.length) return "";
  return `${open} open · ${done} done`;
}
