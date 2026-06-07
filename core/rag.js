// ═══════════════════════════════════════════
// core/rag.js — RAG Knowledge Base Manager
//
// Flow's "training" system. You upload docs,
// Flow searches them before every AI reply
// and injects relevant context into the prompt.
//
// Usage:
//   RAG.save("My business", "Joelflowstack builds bots...")
//   RAG.search("how do I grow my bot business?")
//   RAG.list()
// ═══════════════════════════════════════════

const CACHE = new Map(); // title → content (session cache)

export const RAG = {

  // Search knowledge base — returns context string or null
  async search(query) {
    try {
      const res  = await fetch("/api/rag", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ action: "search", query }),
      });
      const data = await res.json();
      if (!res.ok || !data.context) return null;
      console.log(`[RAG] Found ${data.found} relevant chunk(s) for: "${query.slice(0,40)}"`);
      return data.context;
    } catch(e) {
      console.warn("[RAG] Search failed:", e.message);
      return null;
    }
  },

  // Save a knowledge document
  async save(title, content) {
    try {
      const res  = await fetch("/api/rag", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ action: "save", title, content }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      CACHE.set(title, content);
      console.log(`[RAG] Saved: "${title}" (${content.length} chars)`);
      return true;
    } catch(e) {
      console.error("[RAG] Save failed:", e.message);
      return false;
    }
  },

  // List all knowledge documents
  async list() {
    try {
      const res  = await fetch("/api/rag");
      const data = await res.json();
      return (data.keys || []).map(k => k.replace("rag:", "").replace(/_/g, " "));
    } catch(e) {
      console.warn("[RAG] List failed:", e.message);
      return [];
    }
  },

  // Delete a knowledge document
  async delete(title) {
    try {
      await fetch("/api/rag", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ action: "delete", title }),
      });
      CACHE.delete(title);
      return true;
    } catch(e) {
      return false;
    }
  },

  // Parse uploaded file content into knowledge
  // Called by fileupload.js when user uploads .txt/.md files
  parseDocument(filename, content) {
    // Use filename (minus extension) as the title
    const title = filename.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");
    return { title, content };
  },
};
