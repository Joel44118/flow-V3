// ═══════════════════════════════════════════
// api/debug.js — Check environment variables
//
// Visit: https://your-app.vercel.app/api/debug
// Shows which env vars are SET (not their values)
// Safe to visit — values are never exposed
// ═══════════════════════════════════════════

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const checks = {
    HF_TOKEN:           !!process.env.HF_TOKEN,
    OPENROUTER_API_KEY: !!process.env.OPENROUTER_API_KEY,
    KV_REST_API_URL:    !!process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN:  !!process.env.KV_REST_API_TOKEN,
  };

  const allGood = checks.HF_TOKEN;
  const status  = allGood ? "✅ Ready" : "❌ HF_TOKEN missing — Flow cannot reply";

  return res.status(200).json({
    status,
    env: checks,
    note: "true = set, false = missing. Values are never shown.",
    action: checks.HF_TOKEN ? null : "Go to Vercel Dashboard → Settings → Environment Variables → Add HF_TOKEN",
  });
}
