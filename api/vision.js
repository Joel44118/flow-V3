// ═══════════════════════════════════════════
// api/vision.js — Vercel serverless function
//
// Receives a base64 image frame + prompt
// Sends to gpt-4o-mini vision (cheapest vision model)
// Returns a text description
//
// Cost: ~$0.001 per image (essentially free)
// Key stays server-side — never in browser
// ═══════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "POST only" });

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return res.status(500).json({ error: "OPENROUTER_API_KEY not set" });

  const { image, prompt } = req.body || {};
  if (!image) return res.status(400).json({ error: "image (base64) required" });

  try {
    const res2 = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type":  "application/json",
        "HTTP-Referer":  req.headers.origin || "https://flow-ai.vercel.app",
        "X-Title":       "Flow AI V3 Vision",
      },
      body: JSON.stringify({
        // gpt-4o-mini — cheapest model with vision capability
        model: "openai/gpt-4o-mini",
        max_tokens: 300,
        messages: [
          {
            role: "system",
            content: "You are Flow's eyes. Describe what you see clearly and concisely. No markdown, plain text only. Be specific about objects, people, text, and context visible in the image.",
          },
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${image}` },
              },
              {
                type: "text",
                text:  prompt || "What do you see in this image?",
              },
            ],
          },
        ],
      }),
    });

    const data = await res2.json();
    if (!res2.ok || !data.choices?.length) {
      throw new Error(data.error?.message || `Vision API HTTP ${res2.status}`);
    }

    return res.status(200).json({
      description: data.choices[0].message.content.trim(),
    });

  } catch(e) {
    console.error("[Flow Vision API]", e.message);
    return res.status(502).json({ error: e.message });
  }
}