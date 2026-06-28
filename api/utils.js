// api/utils.js — merged: debug + token (saves 1 serverless function slot)
// GET  /api/utils?action=debug  → shows which env vars are set
// GET  /api/utils?action=token  → returns HF token for browser image gen
// GET  /api/utils               → same as debug (default)

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const action = req.query?.action || "debug";

  if (action === "token") {
    const token = process.env.HF_TOKEN;
    if (!token) return res.status(500).json({ error: "HF_TOKEN not set in Vercel env vars." });
    res.setHeader("Cache-Control", "private, max-age=300");
    return res.status(200).json({ token });
  }

  // debug (default)
  const vars = {
    CEREBRAS_API_KEY:   !!process.env.CEREBRAS_API_KEY,
    NVIDIA_API_KEY:     !!process.env.NVIDIA_API_KEY,
    OPENROUTER_API_KEY: !!process.env.OPENROUTER_API_KEY,
    GROQ_API_KEY:       !!process.env.GROQ_API_KEY,
    HF_TOKEN:           !!process.env.HF_TOKEN,
    ELEVENLABS_API_KEY: !!process.env.ELEVENLABS_API_KEY,
    GITHUB_TOKEN:       !!process.env.GITHUB_TOKEN,
    KV_REST_API_URL:    !!process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN:  !!process.env.KV_REST_API_TOKEN,
  };
  const hasAI = vars.CEREBRAS_API_KEY || vars.NVIDIA_API_KEY ||
                vars.OPENROUTER_API_KEY || vars.GROQ_API_KEY || vars.HF_TOKEN;
  return res.status(200).json({
    status:    hasAI ? "✅ Flow can reply" : "❌ No AI provider — add at least one key",
    providers: vars,
    chain:     "Cerebras → NVIDIA → OpenRouter → Groq → HuggingFace",
    note:      "true = set, false = missing. Values never shown.",
  });
}
