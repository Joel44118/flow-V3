// ═══════════════════════════════════════════
// core/rag.js — RAG Knowledge Base Manager
//
// STORAGE STRATEGY:
//   Primary:  Vercel KV via /api/rag (cloud, persists everywhere)
//   Fallback: localStorage (works offline, per-device)
//
// If KV isn't connected, saves to localStorage automatically.
// No error shown to user — it just works.
// ═══════════════════════════════════════════

import { awardKnowledgeXp } from "./leveling.js";

const LS_KEY = "flow_rag_docs";

// ── localStorage helpers ──────────────────
function lsGetAll() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch { return {}; }
}
function lsSet(title, content) {
  const all = lsGetAll();
  all[title] = { content, saved: Date.now() };
  localStorage.setItem(LS_KEY, JSON.stringify(all));
}
function lsDel(title) {
  const all = lsGetAll();
  delete all[title];
  localStorage.setItem(LS_KEY, JSON.stringify(all));
}

// ── Simple keyword scoring ────────────────
function score(query, chunk) {
  const q = query.toLowerCase();
  const c = chunk.toLowerCase();
  const words = q.split(/\s+/).filter(w => w.length > 3);
  if (!words.length) return 0;
  return words.filter(w => c.includes(w)).length / words.length;
}

function searchLocal(query) {
  const all    = lsGetAll();
  const chunks = [];
  for (const [title, doc] of Object.entries(all)) {
    if (!doc.content) continue;
    const words = doc.content.split(/\s+/);
    for (let i = 0; i < words.length; i += 150) {
      const chunk = words.slice(i, i + 200).join(" ");
      chunks.push({ title, text: chunk, s: score(query, chunk) });
    }
  }
  const top = chunks.filter(c => c.s > 0.1).sort((a, b) => b.s - a.s).slice(0, 3);
  if (!top.length) return null;
  return top.map(c => `[From "${c.title}"]\n${c.text}`).join("\n\n---\n\n");
}

export const RAG = {

  // Search — tries KV first, falls back to localStorage
  async search(query) {
    // Try KV
    try {
      const res  = await fetch("/api/rag", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ action: "search", query }),
      });
      const data = await res.json();
      if (res.ok && data.context) {
        console.log(`[RAG/KV] ${data.found} chunk(s) for: "${query.slice(0,40)}"`);
        return data.context;
      }
    } catch(_) {}

    // Fallback to localStorage
    const local = searchLocal(query);
    if (local) console.log("[RAG/local] found context for:", query.slice(0, 40));
    return local;
  },

  // Save — tries KV first, falls back to localStorage
  async save(title, content) {
    // Try KV
    try {
      const res  = await fetch("/api/rag", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ action: "save", title, content }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        lsSet(title, content); // also save locally as backup
        console.log(`[RAG/KV] Saved: "${title}"`);
        awardKnowledgeXp(title);
        return true;
      }
    } catch(_) {}

    // Fallback to localStorage only
    lsSet(title, content);
    console.log(`[RAG/local] Saved: "${title}" (${content.length} chars)`);
    awardKnowledgeXp(title);
    return true; // always succeeds locally
  },

  // List all docs
  async list() {
    try {
      const res  = await fetch("/api/rag");
      const data = await res.json();
      if (res.ok && data.keys?.length) {
        return data.keys.map(k => k.replace("rag:", "").replace(/_/g, " "));
      }
    } catch(_) {}
    // Fallback to localStorage
    return Object.keys(lsGetAll());
  },

  // Delete
  async delete(title) {
    lsDel(title);
    try {
      await fetch("/api/rag", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ action: "delete", title }),
      });
    } catch(_) {}
    return true;
  },

  // Parse filename into a clean title
  parseDocument(filename, content) {
    const title = filename.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");
    return { title, content };
  },
};
