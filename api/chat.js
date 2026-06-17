// ═══════════════════════════════════════════════════════════════
// api/chat.js — Multi-Provider AI Chain
//
// Provider order: MiniMax → OpenRouter → Groq → HuggingFace
//
// MiniMax: 1M token context, best for coding + long conversations
// OpenRouter: free frontier models per intent
// Groq: ultra-fast fallback
// HuggingFace: last resort
//
// ENV VARS (Vercel Dashboard → Settings → Environment Variables):
//   MINIMAX_API_KEY     platform.minimaxi.com → API Keys
//   OPENROUTER_API_KEY  openrouter.ai/keys
//   GROQ_API_KEY        console.groq.com → API Keys (free)
//   HF_TOKEN            huggingface.co/settings/tokens → Read
// ═══════════════════════════════════════════════════════════════

function detectIntent(text) {
  const t = text.toLowerCase();
  if (/\b(write|create|build|fix|debug|code|function|script|html|css|javascript|typescript|python|react|component|api|endpoint|error|bug)\b/.test(t)) return "code";
  if (/\b(research|explain|summarise|summarize|how does|what is|history of|deep dive|analyse|analyze)\b/.test(t)) return "research";
  if (/\b(pdf|document|extract|read this file)\b/.test(t)) return "pdf";
  if (/\b(image|generate|draw|create.*image|picture of)\b/.test(t)) return "creative";
  return "chat";
}

function trimMessages(messages) {
  const system  = messages.find(m => m.role === "system");
  const history = messages.filter(m => m.role !== "system").slice(-14);
  if (!system) return trimUserMessages(history);
  let sys = system.content;
  if (sys.length > 6000) sys = sys.replace(/KNOWLEDGE BASE[\s\S]*?(?=\nLIVE CONTEXT:)/s, "");
  if (sys.length > 4000) sys = sys.replace(/WHAT I \(FLOW\) CAN DO[\s\S]*?(?=\nI am Flow)/s,
    "I am Flow V3, Joel\'s personal AI — voice, vision, code, search, alarms, goals, images.\n");
  if (sys.length > 3000) sys = sys.slice(0, 3000) + "\n[trimmed]";
  return [{ role: "system", content: sys }, ...trimUserMessages(history)];
}

// Trim oversized user/assistant messages (e.g. huge repo dumps, long code pastes)
// Keeps the last 12000 chars of any message that exceeds the limit
function trimUserMessages(messages) {
  const MAX_MSG = 12000; // chars per message — well within all provider limits
  return messages.map(m => {
    if (typeof m.content !== "string" || m.content.length <= MAX_MSG) return m;
    // For repo content: keep the first 2000 (context/intent) + last 10000 (most relevant files)
    const trimmed = m.content.slice(0, 2000) + "\n\n[... content trimmed for length ...]\n\n" + m.content.slice(-10000);
    return { ...m, content: trimmed };
  });
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

const STOP4 = ["</s>", "<|eot_id|>", "Human:", "User:"];

// ── MINIMAX ───────────────────────────────────────────────────────────────────
// MiniMax-Text-01: 1M token context, strong at code and long conversations
// Use for: coding (deep context), chat (full history), research
const MM_TOKENS = { code: 4000, research: 2000, creative: 1000, pdf: 1500, chat: 800 };

async function tryMiniMax(messages, intent, key) {
  const maxTokens = MM_TOKENS[intent] || 800;
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch("https://api.minimax.chat/v1/text/chatcompletion_v2", {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        model:      "MiniMax-Text-01",
        max_tokens: maxTokens,
        messages,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const data = await r.json();
    if (!r.ok || !data.choices?.length) throw new Error(data.base_resp?.status_msg || data.error?.message || `HTTP ${r.status}`);
    return { reply: cleanReply(data.choices[0].message.content), model: "MiniMax:MiniMax-Text-01" };
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

// ── OPENROUTER ────────────────────────────────────────────────────────────────
const OR_MODELS = {
  code:     [
    "qwen/qwen-2.5-coder-32b-instruct:free",
    "deepseek/deepseek-r1-0528:free",
    "meta-llama/llama-3.1-8b-instruct:free",
  ],
  research: [
    "meta-llama/llama-3.3-70b-instruct:free",
    "deepseek/deepseek-r1-0528:free",
    "meta-llama/llama-3.1-8b-instruct:free",
  ],
  creative: [
    "meta-llama/llama-3.3-70b-instruct:free",
    "mistralai/mistral-7b-instruct:free",
  ],
  pdf:      [
    "meta-llama/llama-3.1-8b-instruct:free",
    "mistralai/mistral-7b-instruct:free",
  ],
  chat:     [
    "meta-llama/llama-3.1-8b-instruct:free",
    "mistralai/mistral-7b-instruct:free",
    "qwen/qwen-2.5-7b-instruct:free",
  ],
};
const OR_TOKENS = { code: 2500, research: 1200, creative: 800, pdf: 1000, chat: 500 };

async function tryOpenRouter(messages, intent, key) {
  const models    = OR_MODELS[intent] || OR_MODELS.chat;
  const maxTokens = OR_TOKENS[intent] || 500;
  for (const model of models) {
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), 8500);
    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method:  "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type":  "application/json",
          "HTTP-Referer":  "https://flow-v3.vercel.app",
          "X-Title":       "Flow V3",
        },
        body:   JSON.stringify({ model, max_tokens: maxTokens, stop: STOP4, messages }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const data = await r.json();
      if (data.error?.message?.includes("Prompt tokens limit")) throw new Error("token_limit");
      if (r.status === 429)  throw new Error("rate_limit");
      if (r.status === 404 || data.error?.code === 404) { console.warn(`[Flow] OR 404: ${model}`); continue; }
      if (!r.ok || !data.choices?.length) throw new Error(data.error?.message || `HTTP ${r.status}`);
      return { reply: cleanReply(data.choices[0].message.content), model: `OR:${model}` };
    } catch (e) {
      clearTimeout(t);
      if (e.message === "token_limit" || e.message === "rate_limit") throw e;
      console.warn(`[Flow] OR ${model}: ${e.message}`);
    }
  }
  throw new Error("OpenRouter: all models failed");
}

// ── GROQ ──────────────────────────────────────────────────────────────────────
const GROQ_MODELS = {
  code:     [
    { model: "mixtral-8x7b-32768",      maxTokens: 3000 },
    { model: "llama-3.3-70b-versatile", maxTokens: 2500 },
    { model: "llama-3.1-8b-instant",    maxTokens: 2000 },
  ],
  research: [
    { model: "llama-3.3-70b-versatile", maxTokens: 1500 },
    { model: "llama-3.1-70b-versatile", maxTokens: 1500 },
    { model: "gemma2-9b-it",            maxTokens: 1200 },
  ],
  creative: [
    { model: "llama-3.3-70b-versatile", maxTokens: 1000 },
    { model: "gemma2-9b-it",            maxTokens: 800  },
  ],
  pdf:      [
    { model: "llama-3.1-8b-instant",    maxTokens: 1200 },
    { model: "gemma2-9b-it",            maxTokens: 1000 },
  ],
  chat:     [
    { model: "llama-3.1-8b-instant",    maxTokens: 600  },
    { model: "gemma2-9b-it",            maxTokens: 600  },
    { model: "mixtral-8x7b-32768",      maxTokens: 600  },
  ],
};

async function tryGroq(messages, intent, key) {
  const chain = GROQ_MODELS[intent] || GROQ_MODELS.chat;
  for (const { model, maxTokens } of chain) {
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), 6000);
    try {
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method:  "POST",
        headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body:    JSON.stringify({ model, max_tokens: maxTokens, stop: STOP4, messages }),
        signal:  ctrl.signal,
      });
      clearTimeout(t);
      const data = await r.json();
      if (r.status === 404 || data.error?.code === "model_not_found") { console.warn(`[Flow] Groq 404: ${model}`); continue; }
      if (r.status === 429) { console.warn(`[Flow] Groq rate limit: ${model}`); continue; }
      if (!r.ok || !data.choices?.length) throw new Error(data.error?.message || `HTTP ${r.status}`);
      return { reply: cleanReply(data.choices[0].message.content), model: `Groq:${model}` };
    } catch (e) {
      clearTimeout(t);
      console.warn(`[Flow] Groq ${model}: ${e.message}`);
    }
  }
  throw new Error("Groq: all models failed");
}

// ── HUGGINGFACE ───────────────────────────────────────────────────────────────
const HF_MODELS = [
  "mistralai/Mistral-7B-Instruct-v0.3",
  "HuggingFaceH4/zephyr-7b-beta",
];

async function tryHuggingFace(messages, intent, token) {
  const maxTokens = intent === "code" ? 1200 : 350;
  for (const model of HF_MODELS) {
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), 5000);
    try {
      const r = await fetch("https://api-inference.huggingface.co/v1/chat/completions", {
        method:  "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body:    JSON.stringify({ model, max_tokens: maxTokens, messages }),
        signal:  ctrl.signal,
      });
      clearTimeout(t);
      if (r.status === 503) { console.warn(`[Flow] HF cold: ${model}`); continue; }
      const data = await r.json();
      if (!r.ok || !data.choices?.length) throw new Error(data.error?.message || `HTTP ${r.status}`);
      return { reply: cleanReply(data.choices[0].message.content), model: `HF:${model}` };
    } catch (e) {
      clearTimeout(t);
      console.warn(`[Flow] HF ${model}: ${e.message}`);
    }
  }
  throw new Error("HF: all models cold or failed");
}

// ── HANDLER ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "POST only" });

  const MM_KEY = process.env.MINIMAX_API_KEY;
  const OR_KEY = process.env.OPENROUTER_API_KEY;
  const GR_KEY = process.env.GROQ_API_KEY;
  const HF_KEY = process.env.HF_TOKEN;

  if (!MM_KEY && !OR_KEY && !GR_KEY && !HF_KEY) {
    return res.status(500).json({ error: "No AI provider configured. Add MINIMAX_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY, or HF_TOKEN in Vercel → Settings → Environment Variables" });
  }

  const { messages } = req.body || {};
  if (!messages?.length) return res.status(400).json({ error: "messages required" });

  const trimmed  = trimMessages(messages);
  const lastUser = [...trimmed].reverse().find(m => m.role === "user")?.content || "";
  const intent   = detectIntent(lastUser);

  // Hard guard: if total payload is still massive after trimming, reject early with helpful message
  const totalChars = trimmed.reduce((s, m) => s + (m.content?.length || 0), 0);
  if (totalChars > 28000) {
    return res.status(200).json({
      reply: "That content is too large for me to process in one go, Boss. Try asking about a specific file or section instead of the whole thing.",
      model: "Flow:size-guard",
      intent,
    });
  }

  console.log(`[Flow] intent=${intent} | MM=${!!MM_KEY} OR=${!!OR_KEY} Groq=${!!GR_KEY} HF=${!!HF_KEY}`);

  const errors = [];

  // MiniMax first — best for coding (4K tokens) and long conversations (1M context)
  // Get MINIMAX_API_KEY from platform.minimaxi.com → API Keys (JWT token format)
  if (MM_KEY && MM_KEY.length > 10) {
    try   { const r = await tryMiniMax(trimmed, intent, MM_KEY); return res.status(200).json({ ...r, intent }); }
    catch (e) { errors.push(`MiniMax: ${e.message}`); console.warn("[Flow] MiniMax failed:", e.message); }
  }
  if (OR_KEY) {
    try   { const r = await tryOpenRouter(trimmed, intent, OR_KEY); return res.status(200).json({ ...r, intent }); }
    catch (e) { errors.push(`OpenRouter: ${e.message}`); }
  }
  if (GR_KEY) {
    try   { const r = await tryGroq(trimmed, intent, GR_KEY); return res.status(200).json({ ...r, intent }); }
    catch (e) { errors.push(`Groq: ${e.message}`); }
  }
  if (HF_KEY) {
    try   { const r = await tryHuggingFace(trimmed, intent, HF_KEY); return res.status(200).json({ ...r, intent }); }
    catch (e) { errors.push(`HF: ${e.message}`); }
  }

  return res.status(502).json({
    error: `All providers failed: ${errors.join(" | ")}`,
  });
}
