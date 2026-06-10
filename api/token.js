// ═══════════════════════════════════════════
// api/token.js — Secure token bridge
//
// WHY THIS EXISTS:
//   Image generation now runs browser-side
//   (to bypass Vercel's 10s function limit).
//   But we can't hardcode HF_TOKEN in JS files
//   (they'd be public on GitHub).
//   This endpoint reads from Vercel env vars
//   and hands the token to the browser at runtime.
//
// SECURITY: This is acceptable because:
//   - HF Read tokens can only READ models (not write, not bill)
//   - The token is already sent to HF on every image request anyway
//   - Anyone who can inspect network requests could see it regardless
//   - It's no different from an API key in a mobile app
//
// GET /api/token → { token: "hf_..." }
// ═══════════════════════════════════════════

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const token = process.env.HF_TOKEN;
  if (!token) {
    return res.status(500).json({
      error: "HF_TOKEN not set. Add it in Vercel → Settings → Environment Variables.",
    });
  }

  // Short cache — browser caches for 5min so it's not fetched on every image
  res.setHeader("Cache-Control", "private, max-age=300");
  return res.status(200).json({ token });
}
