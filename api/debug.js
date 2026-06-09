// api/debug.js — Check all provider env vars
// Visit: https://your-app.vercel.app/api/debug
// Shows SET/MISSING without exposing values

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const vars = {
    OPENROUTER_API_KEY: !!process.env.OPENROUTER_API_KEY,
    GROQ_API_KEY:       !!process.env.GROQ_API_KEY,
    HF_TOKEN:           !!process.env.HF_TOKEN,
    KV_REST_API_URL:    !!process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN:  !!process.env.KV_REST_API_TOKEN,
  };

  const hasAI = vars.OPENROUTER_API_KEY || vars.GROQ_API_KEY || vars.HF_TOKEN;

  return res.status(200).json({
    status:    hasAI ? "✅ Flow can reply" : "❌ No AI provider — add at least one key",
    providers: vars,
    priority:  "OpenRouter → Groq → HuggingFace",
    note:      "true = set, false = missing. Values never shown.",
    keys: {
      openrouter: "openrouter.ai/keys (free)",
      groq:       "console.groq.com → API Keys (free, fastest)",
      hf:         "huggingface.co/settings/tokens → Read token (free)",
    },
  });
}
