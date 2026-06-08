// ═══════════════════════════════════════════
// api/imagine.js — AI image generation
//
// PRIMARY: HuggingFace Inference API (free)
//   Model: black-forest-labs/FLUX.1-schnell
//   Requires: HF_TOKEN env var (free account)
//   Get yours: https://huggingface.co/settings/tokens
//
// FALLBACK: Pollinations.ai redirect URL
//   (no proxy — direct browser URL, avoids rate limit)
//
// GET /api/imagine?prompt=...&w=1024&h=768&model=flux
// ═══════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { prompt, w = 1024, h = 1024, model = "flux" } = req.query;
  if (!prompt) return res.status(400).json({ error: "prompt required" });

  const width  = Math.min(parseInt(w)  || 1024, 1440);
  const height = Math.min(parseInt(h)  || 1024, 1440);

  // ── Attempt 1: HuggingFace Inference API ─
  // Free with HF_TOKEN — get one at huggingface.co/settings/tokens
  const hfToken = process.env.HF_TOKEN;

  if (hfToken) {
    try {
      // Pick HF model based on requested style
      // flux-schnell: fastest free model, great quality
      // stable-diffusion-xl: larger, slower but very detailed
      const hfModel = model === "realistic"
        ? "stabilityai/stable-diffusion-xl-base-1.0"
        : "black-forest-labs/FLUX.1-schnell";

      const hfRes = await fetch(
        `https://api-inference.huggingface.co/models/${hfModel}`,
        {
          method:  "POST",
          headers: {
            "Authorization": `Bearer ${hfToken}`,
            "Content-Type":  "application/json",
            "x-use-cache":   "false",
          },
          body: JSON.stringify({
            inputs: prompt,
            parameters: {
              width,
              height,
              num_inference_steps: model === "turbo" ? 4 : 8,
              guidance_scale: 0,
            },
          }),
        }
      );

      if (hfRes.ok) {
        const contentType = hfRes.headers.get("content-type") || "";
        if (contentType.startsWith("image/")) {
          const buffer = await hfRes.arrayBuffer();
          res.setHeader("Content-Type", contentType);
          res.setHeader("Cache-Control", "public, max-age=3600");
          return res.status(200).send(Buffer.from(buffer));
        }
        // Model loading — HF returns 503 while model warms up
        const errData = await hfRes.json().catch(() => ({}));
        if (hfRes.status === 503) {
          console.warn("[Imagine] HF model loading, falling back...");
        } else {
          console.warn("[Imagine] HF error:", errData?.error || hfRes.status);
        }
      }
    } catch(e) {
      console.warn("[Imagine] HF failed:", e.message);
    }
  }

  // ── Attempt 2: Pollinations redirect (no proxy) ─
  // Return the URL directly — browser loads it without hitting our server
  // This avoids the "Queue full for IP" error since it's a direct browser request
  const cleanPrompt = prompt.replace(/[^\w\s,.-]/g, " ").trim();
  const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(cleanPrompt)}?width=${width}&height=${height}&model=flux&nologo=true&seed=${Date.now() % 99999}`;

  return res.status(200).json({
    url:      pollinationsUrl,
    fallback: true,
    provider: "pollinations",
    note:     hfToken ? "HF model was loading, used fallback" : "Set HF_TOKEN in Vercel env for better images",
  });
}
