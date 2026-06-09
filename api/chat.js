// ═══════════════════════════════════════════════════════════════
// api/chat.js — Multi-Provider AI Chain
//
// PROVIDER ORDER (tries each until one works):
//
//  1. OPENROUTER  — multiple free models, big context, no cold-start
//     Env var: OPENROUTER_API_KEY
//     Free models: llama-3.3-70b, qwen-coder, gemini-flash, etc.
//     Token limit: up to 128k context depending on model
//     Get key: openrouter.ai/keys
//
//  2. GROQ  — fastest inference on earth, generous free tier
//     Env var: GROQ_API_KEY
//     Free models: llama-3.3-70b, mixtral-8x7b, gemma2-9b
//     Token limit: 131k context, 30 req/min free
//     Get key: console.groq.com → API Keys → Create key (free)
//
//  3. HUGGINGFACE  — fallback, cold-start issues but always free
//     Env var: HF_TOKEN
//     Get key: huggingface.co/settings/tokens → New token → Read
//
// ADD ALL THREE in Vercel Dashboard → Settings → Environment Variables
// The chain auto-skips any provider whose key isn't set.
// ═══════════════════════════════════════════════════════════════

// ── Intent detection (local regex, zero API calls) ──────────────────────────
function detectIntent(text) {
  const t = text.toLowerCase();
  if (/\b(write|create|build|fix|debug|code|function|script|html|css|javascript|typescript|python|react|component|api|endpoint)\b/.test(t)) return "code";
  if (/\b(research|explain|summarise|summarize|how does|what is|history of|deep dive|analyse|analyze)\b/.test(t)) return "research";
  if (/\b(pdf|document|extract|read this file|summarize this)\b/.test(t)) return "pdf";
  return "chat";
}

// ── Message trimming ─────────────────────────────────────────────────────────
function trimMessages(messages) {
  const system  = messages.find(m => m.role === "system");
  const history = messages.filter(m => m.role !== "system").slice(-12);

  if (!system) return history;

  let sys = system.content;
  if (sys.length > 4000) sys = sys.replace(/KNOWLEDGE BASE[\s\S]*?(?=\nLIVE CONTEXT:)/s, "");
  if (sys.length > 3000) sys = sys.replace(/WHAT I \(FLOW\) CAN DO[\s\S]*?(?=\nI am Flow)/s,
    "I am Flow V3, Joel's personal AI — voice, vision, code, search, alarms, goals, images.\n");
  if (sys.length > 2500) sys = sys.slice(0, 2500) + "\n[trimmed]";

  return [{ role: "system", content: sys }, ...history];
}

function cleanReply(text) {
  return text
    .replace(/<\/?assistant>/gi, "")
    .replace(/<\|eot_id\|>/g, "")
    .replace(/^(assistant|flow)\s*:/i, "")
    .replace(/\*\*/g, "")
    .replace(/^#+\s/gm, "")
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
//  PROVIDER 1: OPENROUTER
//  - No cold starts (always warm)
//  - Best free model variety
//  - Code: Qwen-Coder  |  Research: Llama-70B  |  Chat: Gemma or Llama
// ─────────────────────────────────────────────────────────────────────────────
const OR_MODELS = {
  code:     ["qwen/qwen-2.5-coder-32b-instruct:free", "meta-llama/llama-3.3-70b-instruct:free"],
  research: ["meta-llama/llama-3.3-70b-instruct:free", "google/gemma-3-27b-it:free"],
  pdf:      ["meta-llama/llama-3.1-8b-instruct:free",  "mistralai/mistral-7b-instruct:free"],
  chat:     ["meta-llama/llama-3.1-8b-instruct:free",  "mistralai/mistral-7b-instruct:free"],
};
const OR_TOKENS = { code: 2500, research: 1200, pdf: 1000, chat: 500 };

async function tryOpenRouter(messages, intent, key) {
  const models    = OR_MODELS[intent] || OR_MODELS.chat;
  const maxTokens = OR_TOKENS[intent] || 500;
  const STOP      = ["</s>", "<|eot_id|>", "Human:", "User:", "Assistant:", "</assistant>"];

  for (const model of models) {
    const ctrl    = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method:  "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type":  "application/json",
          "HTTP-Referer":  "https://flow-v3.vercel.app",
          "X-Title":       "Flow V3",
        },
        body:   JSON.stringify({ model, max_tokens: maxTokens, stop: STOP, messages }),
        signal: ctrl.signal,
      });
      clearTimeout(timeout);

      const data = await r.json();
      // Token limit error → trim more aggressively and try next model
      if (data.error?.code === 429 || data.error?.message?.includes("limit")) throw new Error("limit");
      if (!r.ok || !data.choices?.length) throw new Error(data.error?.message || `HTTP ${r.status}`);

      return { reply: cleanReply(data.choices[0].message.content), model: `openrouter/${model}` };
    } catch (e) {
      clearTimeout(timeout);
      console.warn(`[Flow] OpenRouter ${model}: ${e.message}`);
    }
  }
  throw new Error("OpenRouter: all models failed");
}

// ─────────────────────────────────────────────────────────────────────────────
//  PROVIDER 2: GROQ
//  - Sub-second inference (fastest available)
//  - 131k context window on llama-3.3-70b
//  - 30 requests/min free, 6000 req/day free
//  - NEVER cold-starts
// ─────────────────────────────────────────────────────────────────────────────
const GROQ_MODELS = {
  code:     "llama-3.3-70b-versatile",   // big brain for code
  research: "llama-3.3-70b-versatile",
  pdf:      "llama-3.1-8b-instant",      // fast for doc extraction
  chat:     "llama-3.1-8b-instant",      // fastest for conversation
};
const GROQ_TOKENS = { code: 3000, research: 1500, pdf: 1200, chat: 600 };

async function tryGroq(messages, intent, key) {
  const model     = GROQ_MODELS[intent] || "llama-3.1-8b-instant";
  const maxTokens = GROQ_TOKENS[intent] || 600;
  const STOP      = ["</s>", "<|eot_id|>", "Human:", "User:", "Assistant:", "</assistant>"];

  const ctrl    = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method:  "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body:    JSON.stringify({ model, max_tokens: maxTokens, stop: STOP, messages }),
      signal:  ctrl.signal,
    });
    clearTimeout(timeout);

    const data = await r.json();
    if (!r.ok || !data.choices?.length) throw new Error(data.error?.message || `HTTP ${r.status}`);

    return { reply: cleanReply(data.choices[0].message.content), model: `groq/${model}` };
  } catch (e) {
    clearTimeout(timeout);
    throw new Error(`Groq: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  PROVIDER 3: HUGGINGFACE
//  - Last resort, has cold-start issues
//  - But always available, completely free
//  - One attempt, no retries (Vercel 10s limit)
// ─────────────────────────────────────────────────────────────────────────────
const HF_MODELS = [
  "mistralai/Mistral-7B-Instruct-v0.3",   // most popular, stays warm
  "meta-llama/Meta-Llama-3-8B-Instruct",
  "HuggingFaceH4/zephyr-7b-beta",
];

async function tryHuggingFace(messages, intent, token) {
  const maxTokens = intent === "code" ? 1500 : 400;
  const STOP      = ["</s>", "<|eot_id|>", "Human:", "User:", "Assistant:", "</assistant>"];

  for (const model of HF_MODELS) {
    const ctrl    = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 7000);
    try {
      const r = await fetch("https://api-inference.huggingface.co/v1/chat/completions", {
        method:  "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body:    JSON.stringify({ model, max_tokens: maxTokens, stop: STOP, messages }),
        signal:  ctrl.signal,
      });
      clearTimeout(timeout);

      if (r.status === 503) throw new Error("cold");   // skip immediately

      const data = await r.json();
      if (!r.ok || !data.choices?.length) throw new Error(data.error?.message || `HTTP ${r.status}`);

      return { reply: cleanReply(data.choices[0].message.content), model: `hf/${model}` };
    } catch (e) {
      clearTimeout(timeout);
      console.warn(`[Flow] HF ${model}: ${e.message}`);
    }
  }
  throw new Error("HuggingFace: all models cold or failed");
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN HANDLER
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "POST only" });

  const OR_KEY  = process.env.OPENROUTER_API_KEY;
  const GR_KEY  = process.env.GROQ_API_KEY;
  const HF_KEY  = process.env.HF_TOKEN;

  // At least one provider must be configured
  if (!OR_KEY && !GR_KEY && !HF_KEY) {
    return res.status(500).json({
      error: "No AI provider configured. Add at least one in Vercel → Settings → Environment Variables: OPENROUTER_API_KEY, GROQ_API_KEY, or HF_TOKEN",
    });
  }

  const { messages } = req.body || {};
  if (!messages?.length) return res.status(400).json({ error: "messages required" });

  const trimmed  = trimMessages(messages);
  const lastUser = [...trimmed].reverse().find(m => m.role === "user")?.content || "";
  const intent   = detectIntent(lastUser);

  console.log(`[Flow] intent=${intent} providers: OR=${!!OR_KEY} GR=${!!GR_KEY} HF=${!!HF_KEY}`);

  const errors = [];

  // 1. Try OpenRouter first (best free option, no cold-start)
  if (OR_KEY) {
    try {
      const result = await tryOpenRouter(trimmed, intent, OR_KEY);
      console.log(`[Flow] ✓ ${result.model}`);
      return res.status(200).json({ ...result, intent });
    } catch (e) {
      errors.push(`OpenRouter: ${e.message}`);
      console.warn(`[Flow] ✗ ${e.message}`);
    }
  }

  // 2. Try Groq (fastest, generous free, no cold-start)
  if (GR_KEY) {
    try {
      const result = await tryGroq(trimmed, intent, GR_KEY);
      console.log(`[Flow] ✓ ${result.model}`);
      return res.status(200).json({ ...result, intent });
    } catch (e) {
      errors.push(`Groq: ${e.message}`);
      console.warn(`[Flow] ✗ ${e.message}`);
    }
  }

  // 3. HuggingFace last resort
  if (HF_KEY) {
    try {
      const result = await tryHuggingFace(trimmed, intent, HF_KEY);
      console.log(`[Flow] ✓ ${result.model}`);
      return res.status(200).json({ ...result, intent });
    } catch (e) {
      errors.push(`HF: ${e.message}`);
      console.warn(`[Flow] ✗ ${e.message}`);
    }
  }

  return res.status(502).json({
    error: `All providers failed: ${errors.join(" | ")}`,
  });
}
