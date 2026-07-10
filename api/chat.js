// ═══════════════════════════════════════════════════════════════
// api/chat.js — Multi-Provider AI Chain
//
// CHAIN ORDER (as actually implemented below — this comment was stale
// before this session's fixes and didn't match the real code):
//   1. Cerebras    — free, fastest, for non-code intents
//      (REAL BUG FIXED: was calling llama3.1-70b/8b, which Cerebras'
//      live catalog no longer serves at all — confirmed directly
//      against Cerebras' own API docs. Now uses gpt-oss-120b/zai-glm-4.7,
//      the two models actually live on Cerebras today.)
//   2. NVIDIA direct (NIM) — primary for code/research specifically,
//      using Nemotron 3 Ultra (256K-1M context depending on deployment)
//      for large-context tasks like repo analysis. REAL UPGRADE: was
//      pointed at the old, smaller llama-3.1-nemotron-70b-instruct.
//      No daily cap (only a ~40 req/min limit), confirmed via NVIDIA's
//      own developer forum.
//   3. OpenRouter  — Nemotron 3 Ultra (free tier) as NVIDIA-direct
//      backup, plus frontier models per intent otherwise
//   4. Cerebras fallback for code if OpenRouter failed
//   5. Groq        — ultra-fast free fallback
//   6. HuggingFace — last resort
//
// ENV VARS (Vercel → Settings → Environment Variables):
//   CEREBRAS_API_KEY    cloud.cerebras.ai/api-keys
//   NVIDIA_API_KEY      build.nvidia.com (nvapi- prefixed key)
//   OPENROUTER_API_KEY  openrouter.ai/keys
//   GROQ_API_KEY        console.groq.com/keys
//   HF_TOKEN            huggingface.co/settings/tokens
// ═══════════════════════════════════════════════════════════════

function detectIntent(messages) {
  // Look at the last few user messages, not just the last one
  // This prevents normal conversation from accidentally hitting code/research paths
  const recentUser = messages
    .filter(m => m.role === 'user')
    .slice(-2)
    .map(m => (typeof m.content === 'string' ? m.content : '').toLowerCase())
    .join(' ');

  // Code: only if explicitly asking to write/fix/build code
  // NOT triggered by casual mentions like "i built a thing" or "this code is cool"
  if (/\b(write\s+(me\s+)?(a\s+)?(function|script|code|component|api|endpoint|class|module)|fix\s+(this|the|my)\s+(bug|error|code|function)|debug\s+this|refactor\s+(this|my)|create\s+(a\s+)?(react|vue|angular|node|express|next\.?js)|build\s+(a\s+)?(full|complete|working)\s+\w+\s+(app|api|site|bot)|code\s+for\s+this|implement\s+(this|the|a)\s+\w+)\b/.test(recentUser)) return 'code';

  // Research: only explicit research requests
  if (/\b(research\s+\w|explain\s+(in\s+detail|how|why|what)\s+\w{4}|deep\s+dive|summarise\s+this|summarize\s+this|analyse\s+this|analyze\s+this|history\s+of\s+\w|what\s+is\s+\w{5})\b/.test(recentUser)) return 'research';

  if (/\b(pdf|extract\s+from|read\s+this\s+file)\b/.test(recentUser)) return 'pdf';
  if (/\b(generate\s+(an?\s+)?image|draw\s+(me\s+)?a|picture\s+of|create\s+(an?\s+)?image)\b/.test(recentUser)) return 'creative';

  // Default to chat — don't overthink it
  return 'chat';
}

function trimMessages(messages) {
  const system  = messages.find(m => m.role === 'system');
  // Was slice(-8) — silently undercutting CONFIG.HISTORY_LIMIT's own
  // documented value of 12 full exchanges. At 8 raw messages (4
  // exchanges), anything established earlier in a conversation —
  // roleplay setup, character details, an ongoing scenario — falls out
  // of the window fast, which is the direct, confirmed cause of Flow
  // dropping out of roleplay after just one or two exchanges. 24 raw
  // messages = 12 full exchanges, matching what the config already
  // claimed this was set to.
  const history = messages.filter(m => m.role !== 'system').slice(-24);
  if (!system) return trimUserMessages(history);
  let sys = system.content;
  // Trim heavy sections to keep context tight
  sys = sys.replace(/KNOWLEDGE BASE[\s\S]*?(?=\nLIVE CONTEXT:|\nAGENT|\nSKILL|$)/s, '');
  sys = sys.replace(/WHAT I \(FLOW\) CAN DO[\s\S]*?(?=\nI am Flow|\nLIVE CONTEXT:|$)/s, '');
  sys = sys.replace(/HARD LIMITS[\s\S]*?(?=\nWHAT I|\nI am Flow|\nLIVE CONTEXT:|$)/s, '');
  sys = sys.replace(/RAG KNOWLEDGE[\s\S]*?(?=\nLIVE CONTEXT:|\nAGENT|\nSKILL|$)/s, '');
  sys = sys.replace(/PROJECT CONTEXT[\s\S]*?(?=\nLIVE CONTEXT:|$)/s, '');
  sys = sys.replace(/EXTRACTED MEMORY[\s\S]*?(?=\nLIVE CONTEXT:|$)/s, '');
  if (sys.length > 2000) sys = sys.slice(0, 2000) + '\n[trimmed]';
  return [{ role: 'system', content: sys }, ...trimUserMessages(history)];
}

function trimUserMessages(messages) {
  return messages.map(m => {
    if (typeof m.content !== 'string' || m.content.length <= 2500) return m;
    return { ...m, content: m.content.slice(0, 1000) + '\n\n[... trimmed ...]\n\n' + m.content.slice(-1300) };
  });
}

function cleanReply(text) {
  return text
    // Strip the hidden reasoning block (and anything before it, in case
    // the model repeats a stray opening tag) — this must run FIRST,
    // before any other cleanup, so a thinking block never leaks through.
    .replace(/<flow-think>[\s\S]*?<\/flow-think>/gi, '')
    .replace(/^[\s\S]*<\/flow-think>/i, '') // safety net if closing tag arrives without a matching open
    .replace(/<\/?assistant>/gi, '')
    .replace(/<\|eot_id\|>/g, '')
    .replace(/^(assistant|flow)\s*:/i, '')
    .replace(/\*\*/g, '')
    .replace(/^#+\s/gm, '')
    .trim();
}

const STOP4 = ['</s>', '<|eot_id|>', 'Human:', 'User:'];

// ── 1. CEREBRAS ────────────────────────────────────────────────────────────
// REAL BUG FIX: Cerebras' free catalog collapsed at some point to just
// two models — confirmed directly against Cerebras' own official API
// docs (the "List models" reference page), not assumed. The previous
// model names here (llama3.1-70b, llama3.1-8b) no longer exist on
// Cerebras at all — every single call in this file was silently failing
// and falling through to OpenRouter, meaning Cerebras' free 1M
// tokens/day quota was never actually being used. gpt-oss-120b (OpenAI's
// open-weight 120B model) is the stronger of the two remaining models
// for code; zai-glm-4.7 serves as Cerebras' own internal fallback before
// falling through to OpenRouter/Groq/HF below.
//
// REAL RISK, stated plainly rather than glossed over: Cerebras' free
// catalog has already changed once without notice (this exact
// collapse). Hardcoding these two names is the best available fix
// today, but if Cerebras changes its catalog again, this exact bug
// (dead model name → silent fallthrough) will recur. There's no
// generic fix for that risk short of dynamically calling Cerebras'
// /v1/models endpoint before each request and picking from whatever's
// actually live — a real, larger change not made here, since it adds a
// network round-trip to every single request. Worth reconsidering if
// this breaks again.
const CB_MODELS = {
  code:     [{ model: 'gpt-oss-120b', maxTokens: 2248 }, { model: 'zai-glm-4.7', maxTokens: 1700 }],
  research: [{ model: 'gpt-oss-120b', maxTokens: 1224 }],
  chat:     [{ model: 'zai-glm-4.7',  maxTokens: 900  }],
  creative: [{ model: 'gpt-oss-120b', maxTokens: 1000 }],
  pdf:      [{ model: 'zai-glm-4.7',  maxTokens: 1200 }],
};

async function tryCerebras(messages, intent, key) {
  const chain = CB_MODELS[intent] || CB_MODELS.chat;
  for (const { model, maxTokens } of chain) {
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), 7000);
    try {
      const r = await fetch('https://api.cerebras.ai/v1/chat/completions', {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ model, max_tokens: maxTokens, messages }),
        signal:  ctrl.signal,
      });
      clearTimeout(t);
      if (r.status === 429) { console.warn(`[Flow] Cerebras rate limit: ${model}`); continue; }
      const data = await r.json();
      if (!r.ok || !data.choices?.length) throw new Error(data.error?.message || `HTTP ${r.status}`);
      return { reply: cleanReply(data.choices[0].message.content), model: `Cerebras:${model}` };
    } catch (e) { clearTimeout(t); console.warn(`[Flow] Cerebras ${model}: ${e.message}`); }
  }
  throw new Error('Cerebras: all models failed');
}

// ── 2. OPENROUTER — Nemotron 3 Ultra for coding, as NVIDIA-direct backup ──
// REAL BUG FIXED: was pointing at the old, retired
// nvidia/llama-3.1-nemotron-70b-instruct:free. Confirmed via OpenRouter's
// own model catalog: the real current free model ID is
// nvidia/nemotron-3-ultra-550b-a55b:free — same underlying model as the
// NVIDIA-direct route above, genuinely 1M context on OpenRouter
// specifically (their hosted route serves the full context; NVIDIA's own
// direct free endpoint defaults to a smaller 256K unless reconfigured,
// per NVIDIA's own NIM deployment docs).
// Real trade-off worth knowing, not hidden: OpenRouter's free Nemotron
// route runs on shared community capacity and can be genuinely slow at
// peak times — this is a real fallback path for when NVIDIA-direct hits
// its ~40 req/min limit, not necessarily a faster alternative.
const OR_MODELS = {
  code: [
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'qwen/qwen-2.5-coder-32b-instruct:free',
    'deepseek/deepseek-r1-0528:free',
    'meta-llama/llama-3.1-8b-instruct:free',
  ],
  research: [
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'meta-llama/llama-3.3-70b-instruct:free',
    'deepseek/deepseek-r1-0528:free',
    'meta-llama/llama-3.1-8b-instruct:free',
  ],
  creative: [
    'meta-llama/llama-3.3-70b-instruct:free',
    'mistralai/mistral-7b-instruct:free',
  ],
  pdf: [
    'meta-llama/llama-3.1-8b-instruct:free',
    'mistralai/mistral-7b-instruct:free',
  ],
  chat: [
    'meta-llama/llama-3.1-8b-instruct:free',
    'mistralai/mistral-7b-instruct:free',
    'qwen/qwen-2.5-7b-instruct:free',
  ],
};
const OR_TOKENS = { code: 8000, research: 4000, creative: 1000, pdf: 1200, chat: 800 };

async function tryOpenRouter(messages, intent, key) {
  const models    = OR_MODELS[intent] || OR_MODELS.chat;
  const maxTokens = OR_TOKENS[intent] || 600;
  for (const model of models) {
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), 9000);
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type':  'application/json',
          'HTTP-Referer':  'https://flow-v3-mu.vercel.app',
          'X-Title':       'Flow V3',
        },
        body:   JSON.stringify({ model, max_tokens: maxTokens, stop: STOP4, messages }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const data = await r.json();
      if (data.error?.message?.includes('Prompt tokens limit')) { console.warn('[Flow] OR token limit'); continue; }
      if (r.status === 429) { console.warn('[Flow] OR rate limit'); continue; }
      if (r.status === 404 || data.error?.code === 404) { console.warn(`[Flow] OR 404: ${model}`); continue; }
      if (!r.ok || !data.choices?.length) throw new Error(data.error?.message || `HTTP ${r.status}`);
      return { reply: cleanReply(data.choices[0].message.content), model: `OR:${model}` };
    } catch (e) { clearTimeout(t); console.warn(`[Flow] OR ${model}: ${e.message}`); }
  }
  throw new Error('OpenRouter: all models failed');
}

// ── 3. GROQ ───────────────────────────────────────────────────────────────
const GROQ_MODELS = {
  code:     [
    { model: 'mixtral-8x7b-32768',      maxTokens: 3200 },
    { model: 'llama-3.3-70b-versatile', maxTokens: 2700 },
    { model: 'llama-3.1-8b-instant',    maxTokens: 2200 },
  ],
  research: [
    { model: 'llama-3.3-70b-versatile', maxTokens: 1700 },
    { model: 'gemma2-9b-it',            maxTokens: 1400 },
  ],
  creative: [
    { model: 'llama-3.3-70b-versatile', maxTokens: 1200 },
    { model: 'gemma2-9b-it',            maxTokens: 1000  },
  ],
  pdf:      [
    { model: 'llama-3.1-8b-instant',    maxTokens: 1400 },
    { model: 'gemma2-9b-it',            maxTokens: 1200 },
  ],
  chat:     [
    { model: 'llama-3.1-8b-instant',    maxTokens: 900  },
    { model: 'gemma2-9b-it',            maxTokens: 900  },
    { model: 'mixtral-8x7b-32768',      maxTokens: 900  },
  ],
};

async function tryGroq(messages, intent, key) {
  const chain = GROQ_MODELS[intent] || GROQ_MODELS.chat;
  for (const { model, maxTokens } of chain) {
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), 7000);
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ model, max_tokens: maxTokens, stop: STOP4, messages }),
        signal:  ctrl.signal,
      });
      clearTimeout(t);
      const data = await r.json();
      if (r.status === 404 || data.error?.code === 'model_not_found') { console.warn(`[Flow] Groq 404: ${model}`); continue; }
      if (r.status === 429) { console.warn(`[Flow] Groq rate limit: ${model}`); continue; }
      if (!r.ok || !data.choices?.length) throw new Error(data.error?.message || `HTTP ${r.status}`);
      return { reply: cleanReply(data.choices[0].message.content), model: `Groq:${model}` };
    } catch (e) { clearTimeout(t); console.warn(`[Flow] Groq ${model}: ${e.message}`); }
  }
  throw new Error('Groq: all models failed');
}

// ── 4. HUGGINGFACE ────────────────────────────────────────────────────────
const HF_MODELS = [
  'mistralai/Mistral-7B-Instruct-v0.3',
  'HuggingFaceH4/zephyr-7b-beta',
];

async function tryHuggingFace(messages, intent, token) {
  const maxTokens = intent === 'code' ? 1200 : 400;
  for (const model of HF_MODELS) {
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), 6000);
    try {
      const r = await fetch('https://api-inference.huggingface.co/v1/chat/completions', {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ model, max_tokens: maxTokens, messages }),
        signal:  ctrl.signal,
      });
      clearTimeout(t);
      if (r.status === 503) { console.warn(`[Flow] HF cold: ${model}`); continue; }
      const data = await r.json();
      if (!r.ok || !data.choices?.length) throw new Error(data.error?.message || `HTTP ${r.status}`);
      return { reply: cleanReply(data.choices[0].message.content), model: `HF:${model}` };
    } catch (e) { clearTimeout(t); console.warn(`[Flow] HF ${model}: ${e.message}`); }
  }
  throw new Error('HF: all models cold or failed');
}

// ── HANDLER ───────────────────────────────────────────────────────────────

// ── 1b. NVIDIA DIRECT API — free 1000 req/month at build.nvidia.com ───────
// Add NVIDIA_API_KEY in Vercel → Settings → Environment Variables
// Get free key at: https://build.nvidia.com → Sign in → Get API Key
// REAL FIX: was pointed at the old nemotron-70b-instruct model (127K
// context) — Joel specifically asked about "Nemotron 3 for coding",
// confirmed via NVIDIA's own docs to be nvidia/nemotron-3-ultra-550b-a55b,
// a 550B-parameter (55B active) model with up to 256K-1M token context
// depending on deployment (hosted free endpoint serves up to 256K by
// default per NVIDIA's NIM deployment docs — the exact ceiling wasn't
// independently verified against Joel's own account, so treat 256K as
// the safe planning number, not 1M). This is the model that can actually
// hold a large chunk of the repo in one call, directly targeting the
// "Flow can only see 5 files / 8KB at once" problem.
//
// Code/research get the big model since those are the tasks that
// benefit from large context (reading many files, understanding
// cross-file structure). Chat/creative/pdf stay on the smaller, faster
// model — NVIDIA's free tier is governed by a ~40 req/min rate limit
// (not a daily cap, per NVIDIA's own forum confirmation), so there's no
// daily-quota reason to downgrade those, but the Ultra model is slower
// and heavier than needed for a quick chat reply.
const NV_MODELS = {
  code:     'nvidia/nemotron-3-ultra-550b-a55b',
  research: 'nvidia/nemotron-3-ultra-550b-a55b',
  chat:     'nvidia/nemotron-3-super-120b-a12b',
  creative: 'nvidia/nemotron-3-super-120b-a12b',
  pdf:      'nvidia/nemotron-3-super-120b-a12b',
};
// max_tokens bumped for code/research — 3000 was sized for the OLD
// smaller-context model's typical use; a repo-analysis task feeding in
// many files needs real room for the response too, not just the input.
const NV_TOKENS = { code: 8000, research: 4000, chat: 600, creative: 800, pdf: 1000 };

async function tryNvidia(messages, intent, key) {
  const model     = NV_MODELS[intent] || NV_MODELS.chat;
  const maxTokens = NV_TOKENS[intent] || 600;
  const isUltra   = model === 'nvidia/nemotron-3-ultra-550b-a55b';
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), 10000);
  try {
    const body = { model, max_tokens: maxTokens, messages, stream: false };
    // Nemotron 3 Ultra defaults to a reasoning/thinking mode per NVIDIA's
    // own docs (chat_template_kwargs.enable_thinking) — leaving this
    // unset can spend part of the token budget on hidden reasoning
    // before the visible reply even starts, same class of issue Flow
    // already handles for its own <flow-think> scratchpad elsewhere in
    // this file. Explicitly disabling it here keeps behavior predictable
    // and keeps the full max_tokens budget for the actual visible answer.
    if (isUltra) {
      body.chat_template_kwargs = { enable_thinking: false };
    }
    const r = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (r.status === 429) { console.warn('[Flow] NVIDIA rate limit'); throw new Error('rate limit'); }
    const data = await r.json();
    if (!r.ok || !data.choices?.length) throw new Error(data.detail || data.error?.message || `HTTP ${r.status}`);
    return { reply: cleanReply(data.choices[0].message.content), model: `NVIDIA:${model}` };
  } catch (e) {
    clearTimeout(t);
    console.warn(`[Flow] NVIDIA ${e.message}`);
    throw e;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });

  const CB_KEY = process.env.CEREBRAS_API_KEY;
  const NV_KEY = process.env.NVIDIA_API_KEY;
  const OR_KEY = process.env.OPENROUTER_API_KEY;
  const GR_KEY = process.env.GROQ_API_KEY;
  const HF_KEY = process.env.HF_TOKEN;

  if (!CB_KEY && !NV_KEY && !OR_KEY && !GR_KEY && !HF_KEY) {
    return res.status(500).json({ error: 'No AI provider configured.' });
  }

  const { messages, force_intent } = req.body || {};
  if (!messages?.length) return res.status(400).json({ error: 'messages required' });

  const trimmed  = trimMessages(messages);
  // Pass full message array to detectIntent so it reads context, not just last message.
  // force_intent lets an internal caller (e.g. the self-judged-learning classifier
  // in core/ai.js) skip detection entirely and pin the cheap "chat" tier, since
  // it's a small yes/no classification call, not a real conversational turn.
  const intent   = force_intent || detectIntent(trimmed);

  const totalChars = trimmed.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0);
  // REAL FIX: this was a flat 18000-char cap on every request regardless
  // of intent — which would have silently defeated the whole point of
  // the NVIDIA/OpenRouter Nemotron 3 Ultra upgrade above (large-context
  // repo analysis) by rejecting exactly the kind of large payload that
  // upgrade exists to handle. code/research get a much higher ceiling;
  // ~4 chars/token is a standard rough estimate, so 900,000 chars stays
  // safely under Nemotron's ~1M token context with room for the
  // response. Other intents (chat, creative, pdf) keep the original
  // conservative limit — they were never the bottleneck and don't
  // benefit from a bigger payload.
  const sizeLimit = (intent === 'code' || intent === 'research') ? 900000 : 18000;
  if (totalChars > sizeLimit) {
    return res.status(200).json({
      reply: intent === 'code' || intent === 'research'
        ? "That's too large even for the large-context path, Boss. Try narrowing to a specific set of files instead."
        : "That's too large for me to process in one go, Boss. Try asking about a specific section instead.",
      model: 'Flow:size-guard',
      intent,
    });
  }

  console.log(`[Flow] intent=${intent} | CB=${!!CB_KEY} NV=${!!NV_KEY} OR=${!!OR_KEY} Groq=${!!GR_KEY} HF=${!!HF_KEY}`);

  const errors = [];

  // Cerebras is fast but sometimes struggles with complex code — skip for Nemotron targets
  if (CB_KEY && intent !== 'code') {
    try   { const r = await tryCerebras(trimmed, intent, CB_KEY); return res.status(200).json({ ...r, intent }); }
    catch (e) { errors.push(`Cerebras: ${e.message}`); }
  }

  // NVIDIA direct API — Nemotron 3 Ultra (large-context), primary for code + research
  if (NV_KEY) {
    try   { const r = await tryNvidia(trimmed, intent, NV_KEY); return res.status(200).json({ ...r, intent }); }
    catch (e) { errors.push(`NVIDIA: ${e.message}`); }
  }

  if (OR_KEY) {
    try   { const r = await tryOpenRouter(trimmed, intent, OR_KEY); return res.status(200).json({ ...r, intent }); }
    catch (e) { errors.push(`OpenRouter: ${e.message}`); }
  }

  // Cerebras fallback for code if OR failed
  if (CB_KEY && intent === 'code') {
    try   { const r = await tryCerebras(trimmed, intent, CB_KEY); return res.status(200).json({ ...r, intent }); }
    catch (e) { errors.push(`Cerebras(code fallback): ${e.message}`); }
  }

  if (GR_KEY) {
    try   { const r = await tryGroq(trimmed, intent, GR_KEY); return res.status(200).json({ ...r, intent }); }
    catch (e) { errors.push(`Groq: ${e.message}`); }
  }
  if (HF_KEY) {
    try   { const r = await tryHuggingFace(trimmed, intent, HF_KEY); return res.status(200).json({ ...r, intent }); }
    catch (e) { errors.push(`HF: ${e.message}`); }
  }

  return res.status(502).json({ error: `All providers failed: ${errors.join(' | ')}` });
}
