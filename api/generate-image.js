// ═══════════════════════════════════════════
// api/generate-image.js — Image generation via OpenRouter
// Uses OpenRouter's native image API (Grok, DALL-E, etc.)
// No Pollinations, no rate limits, free with OPENROUTER_API_KEY
// ═══════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { prompt, width = 1024, height = 1024, model = "grok" } = req.body || {};
  if (!prompt) return res.status(400).json({ error: "prompt required" });

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return res.status(500).json({
    error: "OPENROUTER_API_KEY not set in Vercel environment."
  });

  try {
    // Model mapping for OpenRouter image generation
    const modelMap = {
      "grok": "openrouter/auto",  // Grok Imagine via OpenRouter router
      "dall-e": "openai/dall-e-3",
      "flux": "black-forest-labs/FLUX.1-pro",
      "auto": "openrouter/auto",
    };

    const selectedModel = modelMap[model] || "openrouter/auto";

    // OpenRouter text-to-image endpoint
    const res2 = await fetch("https://api.openrouter.ai/v1/images/generations", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": req.headers.origin || "https://flow-v3-mu.vercel.app",
        "X-Title": "Flow V3 Image Generation",
      },
      body: JSON.stringify({
        model: selectedModel,
        prompt: prompt.slice(0, 1000),
        size: `${width}x${height}`,
        n: 1,
        quality: "standard",
      }),
    });

    const data = await res2.json();
    
    if (!res2.ok) {
      throw new Error(data.error?.message || `OpenRouter HTTP ${res2.status}`);
    }

    if (!data.data?.[0]?.url) {
      throw new Error("No image in response");
    }

    return res.status(200).json({
      url: data.data[0].url,
      provider: "openrouter",
      model: selectedModel,
      width,
      height,
    });

  } catch(e) {
    console.error("[Image Generation]", e.message);
    return res.status(502).json({ error: e.message });
  }
}
