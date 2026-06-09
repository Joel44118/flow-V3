// ═══════════════════════════════════════════
// api/chat.js — HuggingFace Inference API
//
// ROOT CAUSE OF 502 FIXED:
//   Old version made 2 HF calls (classify + generate).
//   Each cold-starts independently = timeout.
//   Now: intent detected by REGEX locally (0ms),
//   then ONE HF call with retry on 503.
//   Total time budget: well within 30s limit.
//
// VERCEL ENV VAR:
//   HF_TOKEN  ← huggingface.co/settings/tokens
//              Create a "Read" token (free account is fine)
//              Name it anything e.g. "flow-v3"
//
// MODEL CHAIN (one call, right model per intent):
//   code     → Qwen/Qwen2.5-Coder-32B-Instruct
//   research → meta-llama/Llama-3.3-70B-Instruct
//   chat     → mistralai/Mistral-7B-Instruct-v0.3  ← fastest, stays warm
//   creative → mistralai/Mistral-7B-Instruct-v0.3
//   pdf      → meta-llama/Llama-3.1-8B-Instruct
// ═══════════════════════════════════════════

const HF_API = "https://api-inference.huggingface.co/v1/chat/completions";

const INTENT_MODEL = {
  code:     "Qwen/Qwen2.5-Coder-32B-Instruct",
  research: "meta-llama/Llama-3.3-70B-Instruct",
  pdf:      "meta-llama/Llama-3.1-8B-Instruct",
  creative: "mistralai/Mistral-7B-Instruct-v0.3",
  chat:     "mistralai/Mistral-7B-Instruct-v0.3",
};

const TOKEN_LIMIT = {
  code:     2500,
  research: 1200,
  pdf:      1200,
  creative: 700,
  chat:     500,
};

// Fallbacks — ordered warmest first
const FALLBACKS = [
  "mistralai/Mistral-7B-Instruct-v0.3",
  "meta-llama/Llama-3.1-8B-Instruct",
  "HuggingFaceH4/zephyr-7b-beta",
];

const STOP_TOKENS = ["</s>", "<|eot_id|>", "Human:", "User:", "Assistant:", "</assistant>"];

// ── INTENT DETECTION (pure regex, 0ms, no extra API call) ──────────────────
function detectIntent(text) {
  const t = text.toLowerCase();
  if (/\b(code|function|script|write.*code|build.*app|html|css|javascript|python|debug|fix.*bug|component|api)\b/.test(t)) return "code";
  if (/\b(research|explain|summarise|summarize|deep dive|tell me about|how does|what is|why does|history of)\b/.test(t)) return "research";
  if (/\b(pdf|document|file|upload|extract|read this)\b/.test(t)) return "pdf";
  if (/\b(write.*story|poem|creative|imagine|fictional|roleplay)\b/.test(t)) return "creative";
  return "chat";
}

// ── CLEAN REPLY ─────────────────────────────────────────────────────────────
function cleanReply(text) {
  return text
    .replace(/<\/?assistant>/gi, "")
    .replace(/<\|eot_id\|>/g, "")
    .replace(/^(assistant|flow)\s*:/i, "")
    .replace(/\*\*/g, "")
    .replace(/^#+\s/gm, "")
    .trim();
}

// ── TRIM MESSAGES (prevents token overflow) ──────────────────────────────────
function trimMessages(messages) {
  const system  = messages.find(m => m.role === "system");
  const history = messages.filter(m => m.role !== "system").slice(-14);

  if (!system) return history;

  let sys = system.content;

  // Strip RAG block if prompt is long
  if (sys.length > 4500) {
    sys = sys.replace(/KNOWLEDGE BASE[\s\S]*?(?=\nLIVE CONTEXT:)/s, "");
  }
  // Condense identity block if still long
  if (sys.length > 3000) {
    sys = sys.replace(/WHAT I \(FLOW\) CAN DO[\s\S]*?(?=\nI am Flow)/s,
      "I am Flow V3, Joel's personal AI — voice, vision, code, web search, alarms, goals, images.\n");
  }
  // Hard cap at 2800 chars for the system prompt
  if (sys.length > 2800) {
    sys = sys.slice(0, 2800) + "\n[context trimmed]";
  }

  return [{ role: "system", content: sys }, ...history];
}

// ── GENERATE (single attempt, retry only on 503 cold-start) ─────────────────
async function generate(messages, maxTokens, model, token) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await fetch(HF_API, {
      method:  "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body:    JSON.stringify({ model, max_tokens: maxTokens, stop: STOP_TOKENS, messages }),
    });

    if (r.status === 503) {
      // Model cold-starting — wait once then retry
      if (attempt === 1) {
        console.log(`[Flow] ${model} cold-starting, waiting 3s...`);
        await new Promise(res => setTimeout(res, 3000));
        continue;
      }
      throw new Error(`${model} still loading — try again in 30 seconds`);
    }

    const data = await r.json();

    if (!r.ok || !data.choices?.length) {
      const msg = typeof data?.error === "string"
        ? data.error
        : data?.error?.message || `HTTP ${r.status}`;
      throw new Error(`${model}: ${msg}`);
    }

    return { reply: cleanReply(data.choices[0].message.content), model };
  }
}

// ── HANDLER ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "POST only" });

  const token = process.env.HF_TOKEN;
  if (!token) {
    return res.status(500).json({
      error: "HF_TOKEN missing. Vercel Dashboard → Settings → Environment Variables → add HF_TOKEN (get free token at huggingface.co/settings/tokens)",
    });
  }

  const { messages } = req.body || {};
  if (!messages?.length) return res.status(400).json({ error: "messages required" });

  const trimmed  = trimMessages(messages);
  const lastUser = [...trimmed].reverse().find(m => m.role === "user")?.content || "";

  // Detect intent locally — no extra API call
  const intent    = detectIntent(lastUser);
  const maxTokens = TOKEN_LIMIT[intent] || 500;
  const primary   = INTENT_MODEL[intent];

  console.log(`[Flow] intent=${intent} → ${primary} (${maxTokens} tokens)`);

  // Try primary model then fallbacks
  const queue   = [primary, ...FALLBACKS.filter(m => m !== primary)];
  let   lastErr = "All models failed";

  for (const model of queue) {
    try {
      const result = await generate(trimmed, maxTokens, model, token);
      console.log(`[Flow] ✓ replied via ${result.model}`);
      return res.status(200).json({ ...result, intent });
    } catch (e) {
      lastErr = e.message;
      console.warn(`[Flow] ✗ ${model}: ${e.message}`);
    }
  }

  return res.status(502).json({ error: lastErr });
}
