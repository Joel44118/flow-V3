// ═══════════════════════════════════════════
// core/projects.js — Phase 3: Project Workspaces
//
// Stores active projects with full context:
//   name, description, stack, status, repo,
//   goals, notes, last worked on, files, clients
//
// Projects persist in localStorage + Vercel KV
// and are injected into every system prompt so
// Flow always knows what you're working on.
// ═══════════════════════════════════════════
import { Storage } from "./storage.js";

const KEY = "projects_v1";

function load() { return Storage.get(KEY, []); }
function save(projects) { Storage.set(KEY, projects); }

// ── CRUD ──────────────────────────────────────────────────────────────────
export const Projects = {

  all() { return load(); },

  get(name) {
    return load().find(p => p.name.toLowerCase() === name.toLowerCase()) || null;
  },

  // Create or fully update a project
  save(data) {
    const projects = load();
    const idx = projects.findIndex(p => p.name.toLowerCase() === data.name.toLowerCase());
    const project = {
      name:        data.name,
      description: data.description || "",
      stack:       data.stack       || "",
      status:      data.status      || "active",
      repo:        data.repo        || "",
      client:      data.client      || "",
      goals:       data.goals       || [],
      notes:       data.notes       || "",
      files:       data.files       || [],
      createdAt:   data.createdAt   || Date.now(),
      updatedAt:   Date.now(),
    };
    if (idx >= 0) { projects[idx] = { ...projects[idx], ...project }; }
    else { projects.push(project); }
    save(projects);
    return project;
  },

  // Patch specific fields without overwriting everything
  patch(name, fields) {
    const projects = load();
    const idx = projects.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
    if (idx < 0) return null;
    projects[idx] = { ...projects[idx], ...fields, updatedAt: Date.now() };
    save(projects);
    return projects[idx];
  },

  addNote(name, note) {
    const p = this.get(name);
    if (!p) return null;
    const notes = p.notes ? p.notes + "\n\n" + note : note;
    return this.patch(name, { notes });
  },

  addGoal(name, goal) {
    const p = this.get(name);
    if (!p) return null;
    const goals = [...(p.goals || []), { text: goal, done: false, addedAt: Date.now() }];
    return this.patch(name, { goals });
  },

  completeGoal(name, goalIdx) {
    const p = this.get(name);
    if (!p) return null;
    const goals = p.goals.map((g, i) => i === goalIdx ? { ...g, done: true, doneAt: Date.now() } : g);
    return this.patch(name, { goals });
  },

  setStatus(name, status) {
    return this.patch(name, { status });
  },

  delete(name) {
    const projects = load().filter(p => p.name.toLowerCase() !== name.toLowerCase());
    save(projects);
  },

  // Format active projects for AI system prompt injection
  toPromptContext() {
    const active = load().filter(p => p.status !== "archived");
    if (!active.length) return null;

    const lines = ["JOEL'S ACTIVE PROJECTS:"];
    active.forEach(p => {
      lines.push(`\n▸ ${p.name}${p.status !== "active" ? ` [${p.status.toUpperCase()}]` : ""}`);
      if (p.description) lines.push(`  What: ${p.description}`);
      if (p.stack)       lines.push(`  Stack: ${p.stack}`);
      if (p.repo)        lines.push(`  Repo: ${p.repo}`);
      if (p.client)      lines.push(`  Client: ${p.client}`);
      if (p.goals?.length) {
        const open = p.goals.filter(g => !g.done);
        if (open.length) lines.push(`  Open goals: ${open.map(g => g.text).join(", ")}`);
      }
      if (p.notes) lines.push(`  Notes: ${p.notes.slice(0, 200)}${p.notes.length > 200 ? "..." : ""}`);
    });
    return lines.join("\n");
  },

  // Parse natural language project commands
  // Returns { action, project, field, value } or null
  parse(text) {
    const t = text.toLowerCase().trim();

    // "show/list my projects"
    if (/\b(show|list|what are my|view)\b.*\bprojects?\b/.test(t)) return { action: "list" };

    // "switch to / open / work on <project>"
    const switchM = t.match(/\b(switch to|open project|work on|continue|load project)\s+(.+)/);
    if (switchM) return { action: "switch", name: switchM[2].trim() };

    // "add project <name>"
    const addM = t.match(/\b(add|create|new)\s+project\s+(.+)/);
    if (addM) return { action: "add", name: addM[2].trim() };

    // "add note to <project>: <note>"
    const noteM = t.match(/\badd\s+note\s+to\s+(.+?):\s*(.+)/);
    if (noteM) return { action: "note", name: noteM[1].trim(), value: noteM[2].trim() };

    // "add goal to <project>: <goal>"
    const goalM = t.match(/\badd\s+goal\s+to\s+(.+?):\s*(.+)/);
    if (goalM) return { action: "goal", name: goalM[1].trim(), value: goalM[2].trim() };

    // "mark <project> as done/paused/active/archived"
    const statusM = t.match(/\bmark\s+(.+?)\s+as\s+(done|paused|active|archived|complete)/);
    if (statusM) return { action: "status", name: statusM[1].trim(), value: statusM[2] };

    // "delete/remove project <name>"
    const delM = t.match(/\b(delete|remove)\s+project\s+(.+)/);
    if (delM) return { action: "delete", name: delM[2].trim() };

    return null;
  },

  // Format a single project as readable card
  formatCard(p) {
    if (!p) return "Project not found.";
    const lines = [`📁 ${p.name} [${p.status.toUpperCase()}]`];
    if (p.description) lines.push(`${p.description}`);
    if (p.stack)       lines.push(`Stack: ${p.stack}`);
    if (p.repo)        lines.push(`Repo: ${p.repo}`);
    if (p.client)      lines.push(`Client: ${p.client}`);
    if (p.goals?.length) {
      const open = p.goals.filter(g => !g.done);
      const done = p.goals.filter(g => g.done);
      if (open.length) lines.push(`Goals (open): ${open.map((g,i) => `${i+1}. ${g.text}`).join(", ")}`);
      if (done.length) lines.push(`Goals (done): ${done.length}`);
    }
    if (p.notes) lines.push(`Notes: ${p.notes}`);
    lines.push(`Last updated: ${new Date(p.updatedAt).toLocaleDateString()}`);
    return lines.join("\n");
  },

  formatList() {
    const all = load();
    if (!all.length) return "No projects yet. Say 'add project <name>' to create one.";
    return all.map(p => {
      const open = p.goals?.filter(g => !g.done).length || 0;
      return `▸ ${p.name} [${p.status}]${p.stack ? ` — ${p.stack}` : ""}${open ? ` — ${open} open goal(s)` : ""}`;
    }).join("\n");
  }
};
