// ═══════════════════════════════════════════════════════════════
// api/imagine.js — HuggingFace Image Generation
//
// NO POLLINATIONS — fully HuggingFace powered.
//
// MODES:
//   text-to-image  → generate from prompt (default)
//   img-to-img     → transform an existing image
//   remove-bg      → remove image background (BRIA-RMBG)
//
// MODEL CHAIN (text-to-image):
//   1. black-forest-labs/FLUX.1-schnell  — best quality, fast
//   2. stabilityai/stable-diffusion-xl-base-1.0  — reliable fallback
//
// ENV VAR: HF_TOKEN (huggingface.co/settings/tokens → Read)
//
// GET  /api/imagine?prompt=...&w=1024&h=1024&model=flux&steps=4
// POST /api/imagine  body: { prompt, w, h, model, mode, imageBase64 }
// ═══════════════════════════════════════════════════════════════

const HF = "https://api-inference.huggingface.co/models";

// ── Model chain — tried in order until one works ──────────────────────────
const IMAGE_MODELS = [
  {
    id:    "black-forest-labs/FLUX.1-schnell",
    steps: 4,     // FLUX only needs 4 steps
    cfg:   0,     // FLUX uses cfg=0
  },
  {
    id:    "stabilityai/stable-diffusion-xl-base-1.0",
    steps: 20,
    cfg:   7.5,
  },
];

// ── Call HF image model ───────────────────────────────────────────────────
async function callHFImage(modelId, body, token) {
  const ctrl    = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 25000); // images take longer

  try {
    const r = await fetch(`${HF}/${modelId}`, {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type":  "application/json",
        "x-use-cache":   "false",
      },
      body:   JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timeout);

    // 503 = model loading cold start
    if (r.status === 503) {
      const err = await r.json().catch(() => ({}));
      const wait = err.estimated_time || 20;
      throw new Error(`loading:${Math.ceil(wait)}`);
    }

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${r.status}`);
    }

    const ct = r.headers.get("content-type") || "";
    if (!ct.startsWith("image/")) {
      const text = await r.text();
      throw new Error(`Unexpected response: ${text.slice(0, 100)}`);
    }

    return { buffer: await r.arrayBuffer(), contentType: ct };

  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

// ── Text → Image ──────────────────────────────────────────────────────────
async function textToImage(prompt, width, height, preferModel, token) {
  const errors = [];

  for (const model of IMAGE_MODELS) {
    // If user specified a model, try to match it
    if (preferModel === "realistic" && model.id.includes("FLUX")) {
      // Skip FLUX for realistic — use SDXL which is more photographic
      continue;
    }

    const body = {
      inputs: prompt,
      parameters: {
        width,
        height,
        num_inference_steps: model.steps,
        guidance_scale:      model.cfg,
      },
    };

    try {
      console.log(`[Imagine] Trying ${model.id}...`);
      const result = await callHFImage(model.id, body, token);
      console.log(`[Imagine] ✓ ${model.id}`);
      return { ...result, model: model.id };
    } catch (e) {
      console.warn(`[Imagine] ✗ ${model.id}: ${e.message}`);
      errors.push(`${model.id}: ${e.message}`);
    }
  }

  // Last resort: try realistic model even if not requested
  if (preferModel !== "realistic") {
    const sdxl = IMAGE_MODELS.find(m => m.id.includes("stable-diffusion"));
    if (sdxl) {
      try {
        const result = await callHFImage(sdxl.id, {
          inputs: prompt,
          parameters: { width, height, num_inference_steps: sdxl.steps, guidance_scale: sdxl.cfg },
        }, token);
        return { ...result, model: sdxl.id };
      } catch (e) {
        errors.push(`fallback: ${e.message}`);
      }
    }
  }

  throw new Error(errors.join(" | "));
}

// ── Background Removal ────────────────────────────────────────────────────
async function removeBackground(imageBase64, token) {
  const ctrl    = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 20000);

  try {
    // Convert base64 to binary
    const binary = Buffer.from(imageBase64, "base64");

    const r = await fetch(`${HF}/briaai/RMBG-1.4`, {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type":  "image/jpeg",
      },
      body:   binary,
      signal: ctrl.signal,
    });
    clearTimeout(timeout);

    if (!r.ok) throw new Error(`BG removal failed: HTTP ${r.status}`);

    return { buffer: await r.arrayBuffer(), contentType: "image/png" };
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

// ── Handler ───────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const token = process.env.HF_TOKEN;
  if (!token) {
    return res.status(500).json({
      error: "HF_TOKEN not set. Add it in Vercel → Settings → Environment Variables.",
    });
  }

  // Support both GET (simple) and POST (full options)
  const params = req.method === "POST" ? req.body : req.query;

  const {
    prompt,
    w           = "1024",
    h           = "1024",
    model       = "flux",
    mode        = "text",   // "text" | "remove-bg"
    imageBase64 = null,
  } = params || {};

  // Background removal mode
  if (mode === "remove-bg") {
    if (!imageBase64) return res.status(400).json({ error: "imageBase64 required for remove-bg mode" });
    try {
      const result = await removeBackground(imageBase64, token);
      res.setHeader("Content-Type", result.contentType);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).send(Buffer.from(result.buffer));
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
  }

  // Text-to-image mode
  if (!prompt) return res.status(400).json({ error: "prompt required" });

  const width  = Math.max(256, Math.min(parseInt(w)  || 1024, 1440));
  const height = Math.max(256, Math.min(parseInt(h)  || 1024, 1440));

  // FLUX works best with dimensions divisible by 64
  const fw = Math.round(width  / 64) * 64;
  const fh = Math.round(height / 64) * 64;

  try {
    const result = await textToImage(prompt, fw, fh, model, token);
    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("X-Model-Used",  result.model);
    return res.status(200).send(Buffer.from(result.buffer));
  } catch (e) {
    console.error("[Imagine] All models failed:", e.message);

    // Tell the client what happened with enough detail to debug
    const isLoading = e.message.includes("loading:");
    return res.status(502).json({
      error:   isLoading
        ? `Image model is warming up. Try again in ${e.message.split(":")[1] || 20} seconds.`
        : `Image generation failed: ${e.message}`,
      loading: isLoading,
    });
  }
}
