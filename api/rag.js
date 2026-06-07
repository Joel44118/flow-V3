// ═══════════════════════════════════════════
// api/rag.js — RAG knowledge base search
// Searches Flow's knowledge files stored in
// Vercel KV, returns relevant context chunks.
// ═══════════════════════════════════════════

// Simple keyword-based similarity (no embeddings needed — free)
function score(query, chunk) {
  const q = query.toLowerCase();
  const c = chunk.toLowerCase();
  const words = q.split(/\s+/).filter(w => w.length > 3);
  if (!words.length) return 0;
  const hits = words.filter(w => c.includes(w)).length;
  return hits / words.length;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const KV_URL   = process.env.KV_REST_API_URL;
  const KV_TOKEN = process.env.KV_REST_API_TOKEN;

  // ── GET: retrieve all knowledge keys ──
  if (req.method === "GET") {
    try {
      const r = await fetch(`${KV_URL}/keys/rag:*`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` }
      });
      const data = await r.json();
      return res.status(200).json({ keys: data.result || [] });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST: search or save ───────────────
  if (req.method !== "POST") return res.status(405).json({ error: "POST or GET only" });

  const { action, query, title, content } = req.body || {};

  // Save a knowledge document
  if (action === "save") {
    if (!title || !content) return res.status(400).json({ error: "title and content required" });
    const key   = `rag:${title.replace(/\s+/g, "_").toLowerCase()}`;
    const value = JSON.stringify({ title, content, saved: Date.now() });
    try {
      await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
        method:  "POST",
        headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ value })
      });
      return res.status(200).json({ ok: true, key });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Search knowledge base
  if (action === "search" && query) {
    try {
      // Get all RAG keys
      const keysRes = await fetch(`${KV_URL}/keys/rag:*`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` }
      });
      const keysData = await keysRes.json();
      const keys = keysData.result || [];

      if (!keys.length) return res.status(200).json({ context: null, found: 0 });

      // Fetch all docs
      const docs = await Promise.all(keys.map(async k => {
        try {
          const r    = await fetch(`${KV_URL}/get/${encodeURIComponent(k)}`, {
            headers: { Authorization: `Bearer ${KV_TOKEN}` }
          });
          const data = await r.json();
          return data.result ? JSON.parse(data.result) : null;
        } catch { return null; }
      }));

      // Chunk each doc into ~200-word pieces and score against query
      const chunks = [];
      for (const doc of docs) {
        if (!doc?.content) continue;
        const words = doc.content.split(/\s+/);
        for (let i = 0; i < words.length; i += 150) {
          const chunk = words.slice(i, i + 200).join(" ");
          chunks.push({ title: doc.title, text: chunk, s: score(query, chunk) });
        }
      }

      // Top 3 most relevant chunks
      const top = chunks
        .filter(c => c.s > 0.1)
        .sort((a, b) => b.s - a.s)
        .slice(0, 3);

      if (!top.length) return res.status(200).json({ context: null, found: 0 });

      const context = top
        .map(c => `[From "${c.title}"]\n${c.text}`)
        .join("\n\n---\n\n");

      return res.status(200).json({ context, found: top.length });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Delete a knowledge doc
  if (action === "delete" && title) {
    const key = `rag:${title.replace(/\s+/g, "_").toLowerCase()}`;
    try {
      await fetch(`${KV_URL}/del/${encodeURIComponent(key)}`, {
        method:  "POST",
        headers: { Authorization: `Bearer ${KV_TOKEN}` }
      });
      return res.status(200).json({ ok: true });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: "Invalid action" });
}
