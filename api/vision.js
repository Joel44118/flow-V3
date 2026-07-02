// ═══════════════════════════════════════════
// api/vision.js — Vercel serverless function
//
// Receives a base64 image frame + prompt, returns a text description.
// PROVIDER CHAIN: OpenRouter (gpt-4o-mini) first, Hugging Face Router
// (free vision model) as fallback if OpenRouter fails or hits its limit.
// This mirrors the same fallback-chain pattern already used in api/chat.js
// (Cerebras → OpenRouter → Groq → HuggingFace) so vision behaves
// consistently with the rest of Flow rather than being a single point of
// failure on one paid account's rate limit.
//
// Key stays server-side — never in browser.
// ═══════════════════════════════════════════

const VISION_SYSTEM_PROMPT =
  "You are Flow's eyes. Describe what you see clearly and concisely. No markdown, plain text only. Be specific about objects, people, text, and context visible in the image.";

// Wraps a provider call with its own timeout so a hanging/slow first
// provider can never eat the whole function's time budget and starve the
// fallback of any chance to run — this was the actual cause of the 504:
// OpenRouter had no timeout of its own, so if it hung, Vercel's 10s
// function cap fired first and killed the whole request before Hugging
// Face ever got a turn.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function tryOpenRouter(image, prompt, origin) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;

  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type":  "application/json",
      "HTTP-Referer":  origin || "https://flow-ai.vercel.app",
      "X-Title":       "Flow AI V3 Vision",
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      max_tokens: 300,
      messages: [
        { role: "system", content: VISION_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } },
            { type: "text", text: prompt || "What do you see in this image?" },
          ],
        },
      ],
    }),
  });

  const data = await r.json();
  if (!r.ok || !data.choices?.length) {
    // Rate-limit / quota errors surface here — throw so the caller falls
    // through to Hugging Face instead of failing the whole request.
    throw new Error(data.error?.message || `OpenRouter vision HTTP ${r.status}`);
  }
  return data.choices[0].message.content.trim();
}

async function tryHuggingFace(image, prompt) {
  const key = process.env.HF_TOKEN;
  if (!key) return null;

  // Hugging Face's router is OpenAI-compatible for chat completion,
  // including vision via the same image_url content-block format —
  // this is a genuine drop-in fallback, not a different code path to
  // maintain. zai-org/GLM-4.5V is a current, actively-served vision model
  // on the free router tier.
  const r = await fetch("https://router.huggingface.co/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      model: "zai-org/GLM-4.5V",
      max_tokens: 300,
      messages: [
        { role: "system", content: VISION_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } },
            { type: "text", text: prompt || "What do you see in this image?" },
          ],
        },
      ],
    }),
  });

  const data = await r.json();
  if (!r.ok || !data.choices?.length) {
    throw new Error(data.error?.message || `Hugging Face vision HTTP ${r.status}`);
  }
  return data.choices[0].message.content.trim();
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "POST only" });

  const { image, prompt } = req.body || {};
  if (!image) return res.status(400).json({ error: "image (base64) required" });

  const errors = [];

  try {
    const desc = await withTimeout(tryOpenRouter(image, prompt, req.headers.origin), 6000, "OpenRouter");
    if (desc) return res.status(200).json({ description: desc, provider: "openrouter" });
  } catch (e) {
    console.warn("[Flow Vision] OpenRouter failed, trying Hugging Face:", e.message);
    errors.push(`openrouter: ${e.message}`);
  }

  try {
    const desc = await withTimeout(tryHuggingFace(image, prompt), 6000, "Hugging Face");
    if (desc) return res.status(200).json({ description: desc, provider: "huggingface" });
  } catch (e) {
    console.error("[Flow Vision] Hugging Face also failed:", e.message);
    errors.push(`huggingface: ${e.message}`);
  }

  return res.status(502).json({
    error: errors.length
      ? `All vision providers failed — ${errors.join(" | ")}`
      : "No vision provider configured — set OPENROUTER_API_KEY and/or HUGGINGFACE_API_KEY",
  });
}
