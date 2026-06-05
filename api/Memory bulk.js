// ═══════════════════════════════════════════
// api/memory-bulk.js
// Receives multiple keys at once via sendBeacon
// (fired on tab close — must be fast)
// ═══════════════════════════════════════════

let kv = null;
async function getKV() {
  if (kv) return kv;
  try { const m = await import("@vercel/kv"); kv = m.kv; return kv; }
  catch(_) { return null; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const store = await getKV();
  if (!store) return res.status(200).end(); // KV not set up yet — silent

  try {
    const body = req.body || {};
    // Save all keys in parallel
    await Promise.all(
      Object.entries(body).map(([key, value]) => store.set(key, value))
    );
    return res.status(200).end();
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}