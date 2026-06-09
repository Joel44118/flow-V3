// ═══════════════════════════════════════════════════════════════
// api/chat.js — Multi-Provider AI Chain
//
// FIXES:
//   1. Groq stop array capped at 4 (was 6 → rejected every time)
//   2. OpenRouter models updated + 404 handling per model
//   3. HuggingFace: no stop tokens (HF rejects them), smaller max_tokens
//
// ENV VARS → Vercel Dashboard → Settings → Environment Variables:
//   OPENROUTER_API_KEY  openrouter.ai/keys
//   GROQ_API_KEY        console.groq.com → API Keys (free, fastest)
//   HF_TOKEN            huggingface.co/settings/tokens → Read
// ═══════════════════════════════════════════════════════════════

function detectIntent(text) {
  const t = text.toLowerCase();
  if (/\b(write|create|build|fix|debug|code|function|script|html|css|javascript|typescript|python|react|component|api|endpoint)\b/.test(t)) return "code";
  if (/\b(research|explain|summarise|summarize|how does|what is|history of|deep dive|analyse|analyze)\b/.test(t)) return "research";
  if (/\b(pdf|document|extract|read this file)\b/.test(t)) return "pdf";
  return "chat";
}

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

// Exactly 4 stop tokens — Groq's hard limit, works on all providers
const STOP4 = ["</s>", "<|eot_id|>", "Human:", "User:"];

// ── OPENROUTER ───────────────────────────────────────────────────────────────
const OR_MODELS = {
  code:     ["qwen/qwen-2.5-coder-32b-instruct:free", "meta-llama/llama-3.1-8b-instruct:free"],
  research: ["meta-llama/llama-3.3-70b-instruct:free", "meta-llama/llama-3.1-8b-instruct:free"],
  pdf:      ["meta-llama/llama-3.1-8b-instruct:free", "mistralai/mistral-7b-instruct:free"],
  chat:     ["meta-llama/llama-3.1-8b-instruct:free", "mistralai/mistral-7b-instruct:free"],
};
const OR_TOKENS = { code: 2500, research: 1200, pdf: 1000, chat: 500 };

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
  throw new Error("all OR models failed");
}

// ── GROQ ─────────────────────────────────────────────────────────────────────
const GROQ_MODELS = {
  code: "llama-3.3-70b-versatile", research: "llama-3.3-70b-versatile",
  pdf:  "llama-3.1-8b-instant",    chat:     "llama-3.1-8b-instant",
};
const GROQ_TOKENS = { code: 3000, research: 1500, pdf: 1200, chat: 600 };

async function tryGroq(messages, intent, key) {
  const model     = GROQ_MODELS[intent] || "llama-3.1-8b-instant";
  const maxTokens = GROQ_TOKENS[intent] || 600;

  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), 8500);
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method:  "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body:    JSON.stringify({ model, max_tokens: maxTokens, stop: STOP4, messages }),
      signal:  ctrl.signal,
    });
    clearTimeout(t);
    const data = await r.json();
    if (!r.ok || !data.choices?.length) throw new Error(data.error?.message || `HTTP ${r.status}`);
    return { reply: cleanReply(data.choices[0].message.content), model: `Groq:${model}` };
  } catch (e) {
    clearTimeout(t);
    throw new Error(`Groq: ${e.message}`);
  }
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
    const t    = setTimeout(() => ctrl.abort(), 7000);
    try {
      const r = await fetch("https://api-inference.huggingface.co/v1/chat/completions", {
        method:  "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        // No stop tokens for HF — it rejects them unpredictably
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

  const OR_KEY = process.env.OPENROUTER_API_KEY;
  const GR_KEY = process.env.GROQ_API_KEY;
  const HF_KEY = process.env.HF_TOKEN;

  if (!OR_KEY && !GR_KEY && !HF_KEY) {
    return res.status(500).json({ error: "No AI provider set. Add OPENROUTER_API_KEY, GROQ_API_KEY, or HF_TOKEN in Vercel → Settings → Environment Variables" });
  }

  const { messages } = req.body || {};
  if (!messages?.length) return res.status(400).json({ error: "messages required" });

  const trimmed  = trimMessages(messages);
  const lastUser = [...trimmed].reverse().find(m => m.role === "user")?.content || "";
  const intent   = detectIntent(lastUser);

  console.log(`[Flow] intent=${intent} | OR=${!!OR_KEY} Groq=${!!GR_KEY} HF=${!!HF_KEY}`);

  const errors = [];

  if (OR_KEY) {
    try   { const r = await tryOpenRouter(trimmed, intent, OR_KEY); return res.status(200).json({ ...r, intent }); }
    catch (e) { errors.push(e.message); }
  }
  if (GR_KEY) {
    try   { const r = await tryGroq(trimmed, intent, GR_KEY); return res.status(200).json({ ...r, intent }); }
    catch (e) { errors.push(e.message); }
  }
  if (HF_KEY) {
    try   { const r = await tryHuggingFace(trimmed, intent, HF_KEY); return res.status(200).json({ ...r, intent }); }
    catch (e) { errors.push(e.message); }
  }

  const missing = [!OR_KEY && "OPENROUTER_API_KEY", !GR_KEY && "GROQ_API_KEY", !HF_KEY && "HF_TOKEN"].filter(Boolean);
  return res.status(502).json({
    error: `All providers failed: ${errors.join(" | ")}${missing.length ? ` | Missing: ${missing.join(", ")}` : ""}`,
  });
}
