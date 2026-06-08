// ═══════════════════════════════════════════
// api/chat.js — Vercel serverless function
// API key NEVER leaves this file.
// Browser never sees the key.
// ═══════════════════════════════════════════

const MODELS = [
  "anthropic/claude-3.5-sonnet",      // PRIMARY: Claude Sonnet 3.5 — best reasoning
  "anthropic/claude-3-opus",           // Fallback: Claude Opus — highest capability
  "openai/gpt-4o-mini",                // Fallback: GPT-4o mini — fast and reliable
  "google/gemini-flash-1.5",           // Fallback: Gemini Flash — very fast
  "meta-llama/llama-3.1-8b-instruct:free", // Fallback: Llama 3.1
];

const STOP = ["</assistant>","<|eot_id|>","Human:","User:","Assistant:"];

function clean(text) {
  return text
    .replace(/<\/?assistant>/gi,"")
    .replace(/<\|eot_id\|>/g,"")
    .replace(/^(assistant|flow|claude)\s*:/i,"")
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

  const { messages, max_tokens = 350, action = "chat" } = req.body || {};
  if (!messages?.length) return res.status(400).json({ error: "messages required" });

  // Route image generation requests
  if (action === "imagine") {
    const lastMsg = messages[messages.length - 1]?.content || "";
    const imagineMatch = lastMsg.match(/(?:imagine|generate|create|draw)\s+(?:an?\s+)?(?:image|picture|photo)?\s*(?:of\s+)?(.+)/i);
    if (imagineMatch) {
      const prompt = imagineMatch[1];
      try {
        // Call imagine API
        const imagineRes = await fetch("https://flow-v3-mu.vercel.app/api/imagine", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, model: "dall-e-3" }),
        });
        const imagineData = await imagineRes.json();
        if (imagineRes.ok && imagineData.url) {
          return res.status(200).json({
            reply: `Generated image: ![Image](${imagineData.url})`,
            imageUrl: imagineData.url,
            provider: imagineData.provider,
            model: "imagine",
          });
        }
      } catch(e) {
        console.error("[Imagine routing]", e.message);
      }
    }
  }

  // Standard chat flow with Claude as primary
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
