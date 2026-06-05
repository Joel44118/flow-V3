// ═══════════════════════════════════════════
// api/memory.js — Vercel KV persistent memory
//
// GET  /api/memory?key=flow_memory  → load
// POST /api/memory { key, value }   → save
//
// Uses Vercel KV (free Redis).
// Falls back gracefully if KV not configured.
//
// Setup (one time):
//   1. vercel.com → your project → Storage → Create KV Database
//   2. Click "Connect to Project" → auto-adds env vars
//   3. Redeploy — done.
// ═══════════════════════════════════════════

// Vercel KV client — available automatically when KV is connected
let kv = null;
async function getKV() {
  if (kv) return kv;
  try {
    // Dynamic import so it doesn't crash if KV isn't set up yet
    const mod = await import("@vercel/kv");
    kv = mod.kv;
    return kv;
  } catch(_) {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const store = await getKV();

  // ── No KV configured — tell client gracefully ──
  if (!store) {
    if (req.method === "GET")  return res.status(200).json({ value: null, kv: false });
    if (req.method === "POST") return res.status(200).json({ ok: true, kv: false });
    return res.status(405).end();
  }

  // ── GET: load a value ─────────────────────
  if (req.method === "GET") {
    const { key } = req.query;
    if (!key) return res.status(400).json({ error: "key required" });
    try {
      const value = await store.get(key);
      return res.status(200).json({ value, kv: true });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST: save a value ────────────────────
  if (req.method === "POST") {
    const { key, value } = req.body || {};
    if (!key) return res.status(400).json({ error: "key required" });
    try {
      // Store with no expiry — permanent memory
      await store.set(key, value);
      return res.status(200).json({ ok: true, kv: true });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).end();
}