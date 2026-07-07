// ═══════════════════════════════════════════════════════════════
// api/chat.js — Multi-Provider AI Chain
//
// CHAIN ORDER:
//   1. Cerebras    — free, fastest, llama3.1-70b/8b
//   2. OpenRouter  — Nemotron for code, frontier models per intent
//   3. Groq        — ultra-fast free fallback
//   4. HuggingFace — last resort
//
// ENV VARS (Vercel → Settings → Environment Variables):
//   CEREBRAS_API_KEY    cloud.cerebras.ai/api-keys
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
const CB_MODELS = {
  code:     [{ model: 'llama3.1-70b', maxTokens: 2048 }, { model: 'llama3.1-8b', maxTokens: 1500 }],
  research: [{ model: 'llama3.1-70b', maxTokens: 1024 }],
  chat:     [{ model: 'llama3.1-8b',  maxTokens: 700  }],
  creative: [{ model: 'llama3.1-70b', maxTokens: 800  }],
  pdf:      [{ model: 'llama3.1-8b',  maxTokens: 1000 }],
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

// ── 2. OPENROUTER — Nemotron for coding ───────────────────────────────────
const OR_MODELS = {
  code: [
    // Nemotron 70B — NVIDIA's best coding model, free on OR
    'nvidia/llama-3.1-nemotron-70b-instruct:free',
    'qwen/qwen-2.5-coder-32b-instruct:free',
    'deepseek/deepseek-r1-0528:free',
    'meta-llama/llama-3.1-8b-instruct:free',
  ],
  research: [
    'nvidia/llama-3.1-nemotron-70b-instruct:free',
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
const OR_TOKENS = { code: 3000, research: 1500, creative: 800, pdf: 1000, chat: 600 };

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
    { model: 'mixtral-8x7b-32768',      maxTokens: 3000 },
    { model: 'llama-3.3-70b-versatile', maxTokens: 2500 },
    { model: 'llama-3.1-8b-instant',    maxTokens: 2000 },
  ],
  research: [
    { model: 'llama-3.3-70b-versatile', maxTokens: 1500 },
    { model: 'gemma2-9b-it',            maxTokens: 1200 },
  ],
  creative: [
    { model: 'llama-3.3-70b-versatile', maxTokens: 1000 },
    { model: 'gemma2-9b-it',            maxTokens: 800  },
  ],
  pdf:      [
    { model: 'llama-3.1-8b-instant',    maxTokens: 1200 },
    { model: 'gemma2-9b-it',            maxTokens: 1000 },
  ],
  chat:     [
    { model: 'llama-3.1-8b-instant',    maxTokens: 700  },
    { model: 'gemma2-9b-it',            maxTokens: 700  },
    { model: 'mixtral-8x7b-32768',      maxTokens: 700  },
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
const NV_MODELS = {
  code:     'nvidia/llama-3.1-nemotron-70b-instruct',
  research: 'nvidia/llama-3.1-nemotron-70b-instruct',
  chat:     'nvidia/llama-3.1-nemotron-70b-instruct',
  creative: 'nvidia/llama-3.1-nemotron-70b-instruct',
  pdf:      'nvidia/llama-3.1-nemotron-70b-instruct',
};
const NV_TOKENS = { code: 3000, research: 1500, chat: 600, creative: 800, pdf: 1000 };

async function tryNvidia(messages, intent, key) {
  const model     = NV_MODELS[intent] || NV_MODELS.chat;
  const maxTokens = NV_TOKENS[intent] || 600;
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages, stream: false }),
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
  if (totalChars > 18000) {
    return res.status(200).json({
      reply: "That's too large for me to process in one go, Boss. Try asking about a specific section instead.",
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

  // OpenRouter first for code (Nemotron), fallback for others
  // NVIDIA direct API — Nemotron 70B, best for code + research
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
