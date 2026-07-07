// api/memory.js — merged: single + bulk KV operations
// Saves 1 serverless function slot (replaces memory.js + memory-bulk.js)
//
// GET  /api/memory?key=x           → load single key
// POST /api/memory { key, value }  → save single key
// POST /api/memory { bulk: {k:v} } → save multiple keys at once

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  const res  = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  const data = await res.json();
  let result = data.result ?? null;

  // Self-healing for data already corrupted by the bug below, written
  // before this fix existed: if a stored string is itself a JSON-encoded
  // value (starts with a literal quote, [, or { character), unwrap it
  // once so old double-encoded values (PIN hashes, recovery answers,
  // arrays like flow_joel_style_samples, etc. saved before/around this
  // fix) still compare and behave correctly instead of permanently
  // failing every check against them.
  //
  // WIDENED from the original version, which only checked for a
  // quote-wrapped STRING (e.g. '"somehash"' -> "somehash"). That missed
  // the equally-real case of an ARRAY or OBJECT value that Upstash
  // handed back as a raw JSON-shaped string instead of an already-parsed
  // structure — e.g. persona.js's flow_joel_style_samples key came back
  // as the literal string '["hey flow"]' instead of a real array,
  // which broke samples.push() downstream since strings don't have
  // that method. Any value starting with ", [, or { is now attempted
  // as JSON — if it doesn't actually parse, it's left completely as-is,
  // so this can never turn a genuinely plain string into something else.
  if (typeof result === "string" && result.length >= 2) {
    const first = result[0];
    if (first === '"' || first === '[' || first === '{') {
      try { result = JSON.parse(result); } catch (_) { /* leave as-is if not actually valid JSON */ }
    }
  }
  return result;
}

async function kvSet(key, value) {
  // THE ACTUAL BUG, confirmed by direct reproduction: JSON.stringify on
  // an already-plain string (e.g. a SHA-256 hash like
  // "59d53da6...") wraps it in literal quote characters —
  // '"59d53da6..."' — before sending as the POST body. Upstash's REST
  // API treats that raw body as the literal value to store, so it saved
  // exactly that quoted string, verbatim. Every read back then compared
  // a real hash against a value with extra quote characters baked in,
  // which can never match — this is what made a newly-set PIN and
  // recovery answer look "wrong" immediately after being saved, with no
  // visible error anywhere, because the write itself "succeeded" — it
  // just stored the wrong thing.
  //
  // Fix: only JSON.stringify values that actually need it (objects,
  // arrays, numbers, booleans) — plain strings are sent through raw, so
  // what goes in is exactly what comes back out.
  const body = typeof value === "string" ? value : JSON.stringify(value);
  await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method:  "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body,
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!KV_URL || !KV_TOKEN) {
    if (req.method === "GET")  return res.status(200).json({ value: null, kv: false });
    if (req.method === "POST") return res.status(200).json({ ok: true,   kv: false });
    return res.status(405).end();
  }

  if (req.method === "GET") {
    const { key } = req.query;
    if (!key) return res.status(400).json({ error: "key required" });
    try {
      return res.status(200).json({ value: await kvGet(key), kv: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  if (req.method === "POST") {
    const body = req.body || {};

    // Bulk mode — { bulk: { key: value, ... } }
    if (body.bulk && typeof body.bulk === "object") {
      try {
        await Promise.all(
          Object.entries(body.bulk).map(([k, v]) => kvSet(k, v))
        );
        return res.status(200).json({ ok: true, kv: true });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }

    // Single mode — { key, value }
    const { key, value } = body;
    if (!key) return res.status(400).json({ error: "key required" });
    try {
      await kvSet(key, value);
      return res.status(200).json({ ok: true, kv: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(405).end();
}
