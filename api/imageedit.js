// ═══════════════════════════════════════════
// api/imageedit.js — Image editing via describe + regenerate
//
// Strategy: instruct-pix2pix / img2img on HF free tier is
// unreliable (cold-start, 503s, fetch failures, deprecated
// models). Instead we use a two-step pipeline that reuses
// infrastructure Flow already has working:
//
//  STEP 1 — Describe the original image via OpenRouter vision
//            (same /api/vision approach, just done server-side)
//
//  STEP 2 — Build an enhanced FLUX prompt that combines the
//            image description with the user's edit instruction,
//            then generate via HF router (same as /api/imagine)
//
// This gives consistent, high-quality results with zero
// cold-start issues since both services are already warm.
//
// ENV VARS:
//   HF_TOKEN           — HuggingFace token (same as /api/imagine)
//   OPENROUTER_API_KEY — OpenRouter key    (same as /api/vision)
// ═══════════════════════════════════════════

const FLUX_MODELS = [
  "black-forest-labs/FLUX.1-schnell",
  "black-forest-labs/FLUX.1-dev",
  "stabilityai/stable-diffusion-xl-base-1.0",
];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "POST only" });

  const HF_KEY = process.env.HF_TOKEN;
  const OR_KEY = process.env.OPENROUTER_API_KEY;
  if (!HF_KEY) return res.status(500).json({ error: "HF_TOKEN not set" });
  if (!OR_KEY) return res.status(500).json({ error: "OPENROUTER_API_KEY not set" });

  const { image, instruction } = req.body || {};
  if (!image || !instruction) {
    return res.status(400).json({ error: "image (base64) and instruction required" });
  }

  // ── STEP 1: Describe the original image ─────────────────────────────────
  let description = "";
  try {
    const vRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${OR_KEY}`,
        "Content-Type":  "application/json",
        "HTTP-Referer":  "https://flow-ai.vercel.app",
        "X-Title":       "Flow AI Image Edit",
      },
      body: JSON.stringify({
        model:      "openai/gpt-4o-mini",
        max_tokens: 200,
        messages: [{
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } },
            { type: "text",      text: "Describe this image in precise visual detail — colours, lighting, style, subject, background, composition. Be specific. No markdown." },
          ],
        }],
      }),
    });
    const vData = await vRes.json();
    description = vData.choices?.[0]?.message?.content?.trim() || "";
  } catch (e) {
    console.error("[imageedit] Vision step failed:", e.message);
    // Fall back to using just the instruction if vision fails
  }

  // ── STEP 2: Build FLUX prompt and generate ───────────────────────────────
  // Combine the original scene description with the edit instruction so FLUX
  // keeps everything that should stay the same while applying the change.
  const prompt = description
    ? `${description}. Edit applied: ${instruction}. Photorealistic, high quality, 8K.`
    : `${instruction}. Photorealistic, high quality, 8K.`;

  let lastError = "All image generation models failed.";

  for (const modelId of FLUX_MODELS) {
    try {
      const ctrl = new AbortController();
      const t    = setTimeout(() => ctrl.abort(), 28000);

      const r = await fetch(
        `https://router.huggingface.co/hf-inference/models/${modelId}`,
        {
          method:  "POST",
          headers: {
            "Authorization": `Bearer ${HF_KEY}`,
            "Content-Type":  "application/json",
          },
          body:   JSON.stringify({ inputs: prompt }),
          signal: ctrl.signal,
        }
      );
      clearTimeout(t);

      if (r.status === 503) {
        lastError = `${modelId} warming up — retrying...`;
        console.warn("[imageedit]", lastError);
        continue;
      }

      const ct = r.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const d = await r.json();
        lastError = d.error || `${modelId} error`;
        console.warn("[imageedit]", lastError);
        continue;
      }

      if (!r.ok) {
        lastError = `${modelId} HTTP ${r.status}`;
        console.warn("[imageedit]", lastError);
        continue;
      }

      const buffer = Buffer.from(await r.arrayBuffer());
      if (buffer.length < 1000) {
        lastError = `${modelId} returned empty image`;
        continue;
      }

      return res.status(200).json({
        image:  buffer.toString("base64"),
        model:  modelId,
        prompt: prompt.slice(0, 120),
      });

    } catch (e) {
      clearTimeout?.();
      lastError = e.name === "AbortError"
        ? `${modelId} timed out`
        : e.message;
      console.warn("[imageedit]", modelId, lastError);
    }
  }

  return res.status(502).json({ error: lastError });
}
