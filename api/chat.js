// ═══════════════════════════════════════════
// api/chat.js — HuggingFace Inference API
//
// VERCEL HOBBY PLAN FIX:
//   Hobby plan caps ALL functions at 10 seconds.
//   Previous version had retries that added up to 30s+ → timeout → "fetch failed"
//   Now: 7s AbortController timeout per model, instant fallback, zero retries.
//   Total worst case: 3 models × 7s = 21s... but Vercel kills at 10s.
//   So: 1 model attempt, 7s budget, fallback to next if it fails. Fast.
//
// HF_TOKEN: huggingface.co/settings/tokens → New token → Read → Copy
// Add in: Vercel Dashboard → Settings → Environment Variables → HF_TOKEN
// ═══════════════════════════════════════════

const HF_API = "https://api-inference.huggingface.co/v1/chat/completions";

// Intent detected by regex — zero extra API call
function detectIntent(text) {
  const t = text.toLowerCase();
  if (/\b(write|create|build|fix|debug|code|function|script|html|css|javascript|python|component|api endpoint)\b/.test(t)) return "code";
  if (/\b(research|explain|summarise|summarize|how does|what is|history|deep dive)\b/.test(t)) return "research";
  if (/\b(pdf|document|extract|read this file)\b/.test(t)) return "pdf";
  return "chat";
}

const INTENT_TOKENS = { code: 2000, research: 800, pdf: 800, chat: 400 };

// Models ordered: warmest/fastest first
// These are the highest-traffic models on HF — almost always warm
const MODEL_CHAIN = [
  "mistralai/Mistral-7B-Instruct-v0.3",      // #1 most used — almost always warm
  "meta-llama/Meta-Llama-3-8B-Instruct",     // very popular fallback
  "HuggingFaceH4/zephyr-7b-beta",            // reliable fallback
];

// Code gets a better model when budget allows
const CODE_CHAIN = [
  "Qwen/Qwen2.5-Coder-32B-Instruct",
  "mistralai/Mistral-7B-Instruct-v0.3",      // fallback if Qwen cold
];

const STOP_TOKENS = ["</s>", "<|eot_id|>", "Human:", "User:", "Assistant:", "</assistant>"];

function cleanReply(text) {
  return text
    .replace(/<\/?assistant>/gi, "")
    .replace(/<\|eot_id\|>/g, "")
    .replace(/^(assistant|flow)\s*:/i, "")
    .replace(/\*\*/g, "")
    .replace(/^#+\s/gm, "")
    .trim();
}

function trimMessages(messages) {
  const system  = messages.find(m => m.role === "system");
  const history = messages.filter(m => m.role !== "system").slice(-10);

  if (!system) return history;

  let sys = system.content;
  // Aggressively trim system prompt to stay under token limits
  if (sys.length > 3500) sys = sys.replace(/KNOWLEDGE BASE[\s\S]*?(?=\nLIVE CONTEXT:)/s, "");
  if (sys.length > 2500) sys = sys.replace(/WHAT I \(FLOW\) CAN DO[\s\S]*?(?=\nI am Flow)/s,
    "I am Flow V3, Joel's personal AI — voice, vision, code, search, alarms, goals, images.\n");
  if (sys.length > 2000) sys = sys.slice(0, 2000) + "\n[trimmed]";

  return [{ role: "system", content: sys }, ...history];
}

// Single attempt with AbortController — no retries, no blocking
async function tryModel(messages, maxTokens, model, token) {
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 7000); // 7s hard limit per model

  try {
    const r = await fetch(HF_API, {
      method:  "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body:    JSON.stringify({ model, max_tokens: maxTokens, stop: STOP_TOKENS, messages }),
      signal:  controller.signal,
    });

    clearTimeout(timeout);

    // 503 = model loading (cold start) — skip immediately, try next
    if (r.status === 503) throw new Error("cold");

    const data = await r.json();
    if (!r.ok || !data.choices?.length) {
      const msg = typeof data?.error === "string" ? data.error : data?.error?.message || `HTTP ${r.status}`;
      throw new Error(msg);
    }

    return cleanReply(data.choices[0].message.content);

  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "POST only" });

  const token = process.env.HF_TOKEN;
  if (!token) {
    return res.status(500).json({
      error: "HF_TOKEN not set. Vercel Dashboard → Settings → Environment Variables → add HF_TOKEN. Get a free token at huggingface.co/settings/tokens",
    });
  }

  const { messages } = req.body || {};
  if (!messages?.length) return res.status(400).json({ error: "messages required" });

  const trimmed   = trimMessages(messages);
  const lastUser  = [...trimmed].reverse().find(m => m.role === "user")?.content || "";
  const intent    = detectIntent(lastUser);
  const maxTokens = INTENT_TOKENS[intent] || 400;
  const chain     = intent === "code" ? CODE_CHAIN : MODEL_CHAIN;

  console.log(`[Flow] intent=${intent} tokens=${maxTokens} models=${chain[0]}`);

  for (const model of chain) {
    try {
      const reply = await tryModel(trimmed, maxTokens, model, token);
      console.log(`[Flow] ✓ ${model}`);
      return res.status(200).json({ reply, model, intent });
    } catch (e) {
      console.warn(`[Flow] ✗ ${model}: ${e.message}`);
    }
  }

  return res.status(502).json({
    error: "All models busy or cold-starting. Wait 30 seconds and try again — they warm up quickly after first use.",
  });
}
