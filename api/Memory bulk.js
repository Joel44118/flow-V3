// ═══════════════════════════════════════════
// api/memory-bulk.js — batch save on tab close
// Uses KV REST API directly, no npm package
// ═══════════════════════════════════════════

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  if (!KV_URL || !KV_TOKEN)  return res.status(200).end();

  try {
    const body = req.body || {};
    await Promise.all(
      Object.entries(body).map(([key, value]) =>
        fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
          method:  "POST",
          headers: {
            Authorization: `Bearer ${KV_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(value),
        })
      )
    );
    return res.status(200).end();
  } catch(e) { return res.status(500).json({ error: e.message }); }
}
