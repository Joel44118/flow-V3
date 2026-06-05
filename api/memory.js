// ═══════════════════════════════════════════
// api/memory.js — Vercel KV via REST API
//
// Uses Vercel KV REST API directly with fetch —
// no npm package needed, works out of the box.
//
// Vercel auto-provides these env vars when you
// connect a KV database in the dashboard:
//   KV_REST_API_URL
//   KV_REST_API_TOKEN
//
// GET  /api/memory?key=flow_memory  → load
// POST /api/memory { key, value }   → save
// ═══════════════════════════════════════════

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  const res = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  const data = await res.json();
  return data.result ?? null;
}

async function kvSet(key, value) {
  await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method:  "POST",
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(value),
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // KV not connected yet — return graceful fallback
  if (!KV_URL || !KV_TOKEN) {
    if (req.method === "GET")  return res.status(200).json({ value: null, kv: false });
    if (req.method === "POST") return res.status(200).json({ ok: true, kv: false });
    return res.status(405).end();
  }

  if (req.method === "GET") {
    const { key } = req.query;
    if (!key) return res.status(400).json({ error: "key required" });
    try {
      const value = await kvGet(key);
      return res.status(200).json({ value, kv: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  if (req.method === "POST") {
    const { key, value } = req.body || {};
    if (!key) return res.status(400).json({ error: "key required" });
    try {
      await kvSet(key, value);
      return res.status(200).json({ ok: true, kv: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(405).end();
}
