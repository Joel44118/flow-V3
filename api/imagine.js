// ═══════════════════════════════════════════
// api/imagine.js — Image generation endpoint
// Supports: OpenAI DALL-E, Hugging Face Flux/SDXL
// Replaces Pollinations API with better providers
// ═══════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { prompt, model = "dall-e-3" } = req.body || {};
  if (!prompt) return res.status(400).json({ error: "prompt required" });

  try {
    // Try OpenAI DALL-E first (best quality but needs API key)
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey && (model === "dall-e-3" || model === "openai")) {
      return await generateWithDallE(openaiKey, prompt, res);
    }

    // Fallback to Hugging Face Inference (free tier available)
    const hfKey = process.env.HUGGINGFACE_API_KEY;
    if (hfKey && (model === "flux" || model === "huggingface")) {
      return await generateWithHuggingFace(hfKey, prompt, model, res);
    }

    // If no keys available, return error with instructions
    if (!openaiKey && !hfKey) {
      return res.status(503).json({
        error: "Image generation unavailable. Set OPENAI_API_KEY or HUGGINGFACE_API_KEY in Vercel environment variables.",
        providers: ["dall-e-3", "flux", "stable-diffusion-xl"],
      });
    }

  } catch(e) {
    console.error("[Image Generation]", e.message);
    return res.status(502).json({ error: e.message });
  }
}

// ─────────────────────────────────────────
// OpenAI DALL-E 3 — Highest quality
// ~$0.08 per image (premium, but best results)
// ─────────────────────────────────────────
async function generateWithDallE(apiKey, prompt, res) {
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "dall-e-3",
      prompt: prompt.slice(0, 4000), // DALL-E limit
      n: 1,
      size: "1024x1024",
      quality: "standard",
    }),
  });

  const data = await response.json();
  if (!response.ok || !data.data?.length) {
    throw new Error(data.error?.message || `OpenAI HTTP ${response.status}`);
  }

  return res.status(200).json({
    url: data.data[0].url,
    provider: "dalle-3",
    revised_prompt: data.data[0].revised_prompt,
  });
}

// ─────────────────────────────────────────
// Hugging Face Inference API
// Free tier + paid options, multiple models available
// Models: black-forest-labs/FLUX.1-dev, runwayml/stable-diffusion-v1-5, etc.
// ─────────────────────────────────────────
async function generateWithHuggingFace(apiKey, prompt, model, res) {
  // Map friendly names to actual Hugging Face model IDs
  const modelMap = {
    "flux": "black-forest-labs/FLUX.1-dev",
    "flux-pro": "black-forest-labs/FLUX.1-pro",
    "sdxl": "stabilityai/stable-diffusion-xl-base-1.0",
    "stable-diffusion-3": "stabilityai/stable-diffusion-3-medium",
    "huggingface": "black-forest-labs/FLUX.1-dev", // default
  };

  const modelId = modelMap[model] || "black-forest-labs/FLUX.1-dev";

  const response = await fetch(
    `https://api-inference.huggingface.co/models/${modelId}`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: prompt.slice(0, 1000),
      }),
    }
  );

  // Hugging Face returns binary image data directly
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HuggingFace HTTP ${response.status}: ${text}`);
  }

  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");
  const imageUrl = `data:image/jpeg;base64,${base64}`;

  return res.status(200).json({
    url: imageUrl,
    provider: "huggingface",
    model: modelId,
  });
}
