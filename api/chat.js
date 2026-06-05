// ═══════════════════════════════════════════
// api/chat.js — Vercel serverless function
// API key NEVER leaves this file.
// Browser never sees the key.
// ═══════════════════════════════════════════

const MODELS = [
  "meta-llama/llama-3.1-8b-instruct:free",
  "google/gemini-flash-1.5",
  "openai/gpt-4o-mini",
  "anthropic/claude-sonnet-4-5",
];

const STOP = ["</assistant>","<|eot_id|>","Human:","User:","Assistant:"];

function clean(text) {
  return text
    .replace(/<\/?assistant>/gi,"")
    .replace(/<\|eot_id\|>/g,"")
    .replace(/^(assistant|flow)\s*:/i,"")
    .replace(/\*\*/g,"")
    .replace(/^#+\s/gm,"")
    .replace(/^[-•]\s/gm,"")
    .trim();
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return res.status(500).json({
    error: "OPENROUTER_API_KEY not set in Vercel environment variables."
  });

  const { messages, max_tokens = 350 } = req.body || {};
  if (!messages?.length) return res.status(400).json({ error: "messages required" });

  let lastErr = "All models failed";

  for (const model of MODELS) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type":  "application/json",
          "HTTP-Referer":  req.headers.origin || "https://flow-ai.vercel.app",
          "X-Title":       "Flow AI V3",
        },
        body: JSON.stringify({ model, max_tokens, stop: STOP, messages }),
      });

      const data = await r.json();
      if (!r.ok || !data.choices?.length) {
        lastErr = data?.error?.message || `HTTP ${r.status}`;
        continue;
      }

      return res.status(200).json({
        reply: clean(data.choices[0].message.content),
        model,
      });
    } catch(e) { lastErr = e.message; }
  }

  return res.status(502).json({ error: lastErr });
}