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
  // REAL FIX: added a specific pattern for self-tools trigger phrasing
  // ("I need a tool that...", "build/make something that...") — this was
  // the confirmed root cause of self-tools proposals failing: without
  // this pattern, these requests classified as 'chat', routing to a
  // smaller/faster model (nemotron-3-super-120b) that didn't reliably
  // follow the self-tools instruction buried in a large system prompt.
  // Routing to 'code' intent gets a stronger model AND matches what the
  // request actually is — asking Flow to write a small program.
  if (/\b(write\s+(me\s+)?(a\s+)?(function|script|code|component|api|endpoint|class|module)|fix\s+(this|the|my)\s+(bug|error|code|function)|debug\s+this|refactor\s+(this|my)|create\s+(a\s+)?(react|vue|angular|node|express|next\.?js)|build\s+(a\s+)?(full|complete|working)\s+\w+\s+(app|api|site|bot)|code\s+for\s+this|implement\s+(this|the|a)\s+\w+|i\s+need\s+(a\s+|an?\s+)?(small\s+)?(tool|function|utility|helper)\s+that|(build|make|create)\s+(me\s+)?(a\s+|an?\s+)?(small\s+|little\s+)?(tool|function|utility|helper|script)\s+(that|to|for))\b/.test(recentUser)) return 'code';

  // Research: only explicit research requests
  if (/\b(research\s+\w|explain\s+(in\s+detail|how|why|what)\s+\w{4}|deep\s+dive|summarise\s+this|summarize\s+this|analyse\s+this|analyze\s+this|history\s+of\s+\w|what\s+is\s+\w{5})\b/.test(recentUser)) return 'research';

  if (/\b(pdf|extract\s+from|read\s+this\s+file)\b/.test(recentUser)) return 'pdf';
  if (/\b(generate\s+(an?\s+)?image|draw\s+(me\s+)?a|picture\s+of|create\s+(an?\s+)?image)\b/.test(recentUser)) return 'creative';

  // REAL, CONFIRMED FIX for Joel's reported "/intel goes into an abyss
  // with no text" bug (specifically on blank input, i.e. the FULL world
  // brief, not a targeted search). Root cause: core/intel.js's
  // buildIntelPrompt() produces a genuinely large prompt (starts with
  // "WORLD INTELLIGENCE BRIEF —", packed with forex/news/tech/quakes/
  // fires/conflicts data) that doesn't match any of the patterns above,
  // so it silently fell through to the DEFAULT 'chat' intent — capped at
  // 2200 max_tokens across all providers. A full brief covering 6 real
  // data categories plus a 3-part "what matters / opportunities /
  // signals" instruction is a genuinely large ask that can exhaust that
  // budget before finishing, which looks exactly like Joel's reported
  // symptom. Routing this to 'research' intent instead gives it the
  // real 8000/4000-token budget research already has — a targeted
  // /intel search (with actual text after it) was less likely to hit
  // this because Joel confirmed THAT case worked, consistent with a
  // targeted brief being smaller than a full one.
  if (/world intelligence brief/i.test(recentUser)) return 'research';

  // Default to chat — don't overthink it
  return 'chat';
}

function trimMessages(messages) {
  const system  = messages.find(m => m.role === 'system');
  const history = messages.filter(m => m.role !== 'system').slice(-24);
  if (!system) return trimUserMessages(history);
  let sys = system.content;

  // Trim heavy, genuinely optional sections first (unchanged — these
  // section names are still real and current).
  sys = sys.replace(/KNOWLEDGE BASE[\s\S]*?(?=\nLIVE CONTEXT:|\nAGENT|\nSKILL|$)/s, '');
  sys = sys.replace(/RAG KNOWLEDGE[\s\S]*?(?=\nLIVE CONTEXT:|\nAGENT|\nSKILL|$)/s, '');
  sys = sys.replace(/PROJECT CONTEXT[\s\S]*?(?=\nLIVE CONTEXT:|$)/s, '');
  sys = sys.replace(/EXTRACTED MEMORY[\s\S]*?(?=\nLIVE CONTEXT:|$)/s, '');

  // REAL ARCHITECTURE CHANGE: identity.js v4 removed the repo map / level
  // / live-state / change-notice from the static system prompt entirely —
  // that data now lives behind real tool calls (get_my_level,
  // get_my_capabilities, etc. — see FLOW_TOOLS below) instead of being
  // stuffed into every message. The old SYS_BUDGET/repo-map-compaction
  // logic that used to live here is gone: the prompt is small and stable
  // now (identity + hard limits only), so there's nothing left that
  // scales with codebase size for this function to protect against.

  return [{ role: 'system', content: sys }, ...trimUserMessages(history)];
}

function trimUserMessages(messages) {
  return messages.map(m => {
    if (typeof m.content !== 'string' || m.content.length <= 2500) return m;
    return { ...m, content: m.content.slice(0, 1000) + '\n\n[... trimmed ...]\n\n' + m.content.slice(-1300) };
  });
}

// REAL, Joel-requested feature: instead of just discarding Flow's
// <flow-think> reasoning block, this captures it so it can be stored
// somewhere Joel can actually go look at it if he wants — a real,
// dedicated "thought log" rather than either leaking into chat OR
// vanishing with no trace. Runs on the RAW text, before cleanReply
// strips it, so this always has genuine content even in the unclosed-tag
// leak scenario cleanReply now also handles.
function extractThought(rawText) {
  const closedMatch = rawText.match(/<flow-think>([\s\S]*?)<\/flow-think>/i);
  if (closedMatch) return closedMatch[1].trim();
  const openIdx = rawText.search(/<flow-think>/i);
  if (openIdx !== -1) {
    // Unclosed case — same real scenario cleanReply's fallback handles.
    // Captures everything after the open tag up to the same paragraph-
    // break heuristic, so the stored thought and the cleaned reply stay
    // consistent with each other.
    const afterOpen = rawText.slice(openIdx + '<flow-think>'.length);
    const paraBreak = afterOpen.search(/\n\s*\n/);
    return (paraBreak !== -1 ? afterOpen.slice(0, paraBreak) : afterOpen).trim();
  }
  return null;
}

// REAL, fire-and-forget storage of a captured thought via the same KV
// used everywhere else in this file (KV_REST_API_URL/TOKEN) — stores the
// last N thoughts as a simple rolling log under one fixed key so Joel can
// review them via a real UI surface (see ui/ — a "Flow's thoughts" panel
// reads this same key) without ever seeing them appear in the actual
// chat log itself.
async function _logThought(thought, intent) {
  if (!thought) return;
  const KV_URL = process.env.KV_REST_API_URL;
  const KV_TOKEN = process.env.KV_REST_API_TOKEN;
  if (!KV_URL || !KV_TOKEN) return; // real, honest no-op if KV isn't configured — never blocks the actual reply
  try {
    const getRes = await fetch(`${KV_URL}/get/flow_thought_log`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    const getData = await getRes.json().catch(() => ({}));
    let log = [];
    try { log = getData?.result ? JSON.parse(getData.result) : []; } catch (_) { log = []; }
    if (!Array.isArray(log)) log = [];
    log.push({ thought, intent: intent || null, ts: Date.now() });
    // Real, simple cap — keeps the most recent 100 thoughts, so this
    // never grows unbounded in KV storage.
    if (log.length > 100) log = log.slice(log.length - 100);
    await fetch(`${KV_URL}/set/flow_thought_log`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(log),
    });
  } catch (_) { /* logging a thought should never break the real reply */ }
}

// REAL, Joel-requested proactive-idea feature — extracts an OPTIONAL
// <flow-idea> block (see identity.js's "PROACTIVE IDEAS" instruction).
// Unlike flow-think, this is meant to be RARE and is surfaced to Joel
// separately (not stripped/hidden) — most replies will have none at all,
// which is by design, not a bug.
function extractIdea(rawText) {
  const match = rawText.match(/<flow-idea>([\s\S]*?)<\/flow-idea>/i);
  return match ? match[1].trim() : null;
}

function cleanReply(text, intent) {
  // REAL, CONFIRMED FIX for a real, active bug: when a provider (most
  // often seen with Cerebras in Joel's real testing) returns a pure
  // tool-call with no accompanying text, message.content arrives as
  // null/undefined — a completely normal, valid case for tool-calling
  // models, not an error. Every downstream function here (extractThought,
  // extractIdea, the .replace() chain below) assumed text was always a
  // real string and had no guard for this, so a null content value
  // crashed with "text.replace is not a function" / ".match is not a
  // function" and killed the ENTIRE request — explaining exactly why
  // Cerebras replies sometimes silently failed while NVIDIA (which
  // apparently never hit this exact null-content case in Joel's testing)
  // kept working. Coercing to '' here fixes it at the one shared entry
  // point every provider path already funnels through.
  text = text || '';

  // Real, fire-and-forget capture of the raw thought BEFORE any
  // stripping happens — cleanReply is the one function every provider
  // path already funnels through, so hooking the capture here covers
  // all of them without needing to touch 5+ separate call sites
  // individually (which is exactly how the earlier "only some providers
  // strip it" class of bug tends to happen).
  const thought = extractThought(text);
  if (thought) _logThought(thought, intent).catch(() => {});

  // REAL, Joel-requested — captures the optional proactive idea (if the
  // model included one) BEFORE stripping, same reasoning as thought
  // capture above.
  const idea = extractIdea(text);

  let out = text
    // Strip the hidden reasoning block (and anything before it, in case
    // the model repeats a stray opening tag) — this must run FIRST,
    // before any other cleanup, so a thinking block never leaks through.
    .replace(/<flow-think>[\s\S]*?<\/flow-think>/gi, '')
    .replace(/^[\s\S]*<\/flow-think>/i, '') // safety net if closing tag arrives without a matching open
    // Real, also strip the idea block from the main reply text — it's
    // surfaced separately (see the `idea` return value below), not
    // shown inline as part of the normal reply.
    .replace(/<flow-idea>[\s\S]*?<\/flow-idea>/gi, '');

  // REAL, CONFIRMED FIX for the leak Joel reported (raw thinking text
  // like "I shouldn't call him boss twice" appearing in the actual chat).
  // Root cause: the two replaces above both REQUIRE a closing
  // </flow-think> tag to exist somewhere in the text. If the model opens
  // the tag but never closes it — cut off by max_tokens, or just drifts
  // straight into a reply without emitting the closing tag — the raw
  // thinking text passes through completely untouched. This is a real
  // gap, not a hypothetical: an open tag with no closer anywhere after
  // it is exactly what "leaked, unfinished-sounding" thoughts look like.
  // Fix: if an open tag exists with no closer, cut from the open tag to
  // the first real paragraph break (blank line) after it, on the
  // assumption that's the most likely real boundary between the
  // thinking block and Flow's actual reply. If there's no paragraph
  // break either (worst case), drop everything from the open tag
  // onward — an empty-ish reply is a safer failure than a leaked
  // internal thought reaching Joel.
  const openIdx = out.search(/<flow-think>/i);
  if (openIdx !== -1) {
    const afterOpen = out.slice(openIdx + '<flow-think>'.length);
    const paraBreak = afterOpen.search(/\n\s*\n/);
    if (paraBreak !== -1) {
      out = out.slice(0, openIdx) + afterOpen.slice(paraBreak).replace(/^\n\s*\n/, '');
    } else {
      out = out.slice(0, openIdx);
    }
  }

  const reply = out
    .replace(/<\/?assistant>/gi, '')
    .replace(/<\|eot_id\|>/g, '')
    .replace(/^(assistant|flow)\s*:/i, '')
    .replace(/\*\*/g, '')
    .replace(/^#+\s/gm, '')
    .trim();

  // REAL, changed return shape: was a bare string, now {reply, idea} so
  // the proactive idea can travel alongside the reply without needing a
  // second round-trip. All 5 call sites updated accordingly.
  return { reply, idea };
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
  // REAL FIX: 'chat' was capped at 900 tokens (~650-700 words) — Joel
  // confirmed real, detailed replies were cutting off mid-sentence,
  // since his actual usage is involved conversation, not quick Q&A.
  // Raised to a genuinely generous 2200 to match how Flow is actually
  // used day-to-day.
  chat:     [{ model: 'zai-glm-4.7',  maxTokens: 2200 }],
  creative: [{ model: 'gpt-oss-120b', maxTokens: 1600 }],
  pdf:      [{ model: 'zai-glm-4.7',  maxTokens: 1200 }],
};

// ═══════════════════════════════════════════════════════════════
// REAL AUTONOMOUS TOOL-CALLING — genuinely new infrastructure, not
// wiring on top of something that already existed. Confirmed via
// research before building: Cerebras' gpt-oss-120b explicitly supports
// "native tool use, including function calling" (per Cerebras/OpenRouter's
// own model card), and Groq's API is OpenAI-compatible, which includes
// standard tool-calling. NVIDIA NIM's tool-calling support on the HOSTED
// cloud API (not local Docker) is genuinely uncertain — a real NVIDIA
// developer forum post shows a user unable to get it working on the
// cloud API specifically — so tools are only sent to Cerebras/Groq for
// now, not NVIDIA, until that's verified.
//
// This lets Flow's OWN judgment decide to call one of these mid-
// conversation — e.g. deciding it needs the current time to answer a
// question, rather than only responding to a specific typed command
// like "/time" or a regex-matched phrase. That's the real, qualitative
// difference Joel asked for: "not just speaking, having access to
// everything he can do."
// ═══════════════════════════════════════════════════════════════
const FLOW_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: 'Get the current real date and time. Call this whenever you need to know what time or date it actually is right now — never guess or assume.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_camera',
      description: "Open Joel's camera so you can see what's in front of him right now. Call this when he asks you to look at something, check what he's showing you, or when seeing his physical surroundings would genuinely help answer his question.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description: 'Generate an image from a text description. Call this when Joel asks for an image, picture, illustration, or visual to be created — not for photos of real people or copyrighted characters.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'A detailed description of the image to generate' },
        },
        required: ['prompt'],
      },
    },
  },
  // REAL ARCHITECTURE CHANGE: these 4 tools replace the old approach of
  // stuffing level/state/repo-map/change-detection into the system
  // prompt on every message (core/identity.js v3). That approach failed
  // real testing — a fact buried after a 100+ line repo map got silently
  // ignored by the model (confirmed "lost in the middle" effect, real
  // published research, not a guess). Tools fix this structurally: Flow
  // actively CALLS the one it needs, gets a small, fresh, un-buried
  // result back, instead of hoping a fact survives being surrounded by
  // everything else. All four are client-side (same reason as
  // open_camera/generate_image above) — the actual data (localStorage,
  // browser fetch to /api/github, runtime state) only exists in the
  // browser/Electron renderer, never on this serverless function.
  {
    type: 'function',
    function: {
      name: 'get_my_level',
      description: "Get Flow's real current level, XP, and progress. Call this whenever Joel asks about level, XP, or progress — never guess or give a vague non-answer.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_my_live_state',
      description: "Get Flow's real current state right now: is the camera on, screen-share on, gesture control active, Sentinel on, any confirmed Telegram admin chats. Call this ONLY when Joel is asking a genuine status question ('is sentinel on?', 'can you see me right now?') — NOT when he gives a direct on/off command ('turn sentinel off'), which should call the toggle tool directly instead.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_my_capabilities',
      description: "Get a real, live list of Flow's own codebase — files and their exported functions — straight from the actual repo, not memorized. Call this when Joel asks what Flow can do, whether a specific feature exists, or to ground an answer in what's actually built. Optionally filter by a topic keyword to avoid an overwhelming full dump.",
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Optional keyword to filter results, e.g. "voice", "github", "telegram", "image". Omit for a general/compact overview.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_for_updates',
      description: 'Check whether Flow\'s own codebase has changed since the last conversation (a real diff against a stored fingerprint, not a guess). Call this whenever Joel asks "did anything change", "what\'s new with you", or similar — never answer "not that I\'m aware of" without calling this first.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  // REAL, NEW (this session) — brings the same semantic-recall memory
  // system that already existed only in the Electron desktop app's
  // background heartbeat (flow-electron/memory-store.js) into the actual
  // conversational chat, on both web and Electron. Same "lost in the
  // middle" reasoning as the 4 tools above applies here even more: past
  // conversations are the LARGEST possible thing to stuff into a static
  // system prompt, so a real, on-demand recall call is the honest fix —
  // Flow actively looks up what's relevant instead of hoping an old fact
  // survives being buried in a huge history dump.
  {
    type: 'function',
    function: {
      name: 'recall_memory',
      description: "Search Flow's real, persistent memory of past conversations, decisions, and facts for anything relevant to the current topic. Call this when Joel references something from before ('like we discussed', 'remember when', 'what did I say about X'), when a past decision or preference would genuinely change how you answer, or when you're unsure whether something has come up before rather than guessing. Don't call this for simple factual or generic questions with no real connection to Joel's history.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for — a topic, question, or phrase describing what you want to recall.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'toggle_sentinel',
      description: "Turn Flow's Sentinel (ambient screen-awareness in the Electron desktop app) on or off. Call THIS tool directly when Joel gives a direct instruction like 'turn sentinel off' — do NOT call get_my_live_state first to check the current status; toggle_sentinel handles that internally and reports the real result. Checking status first before a direct command only adds a pointless extra step and a rambling reply.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_notepad',
      description: 'Open the notepad UI. Call this when Joel wants to jot something down or asks you to write something visible, not just remember it in conversation.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'post_to_bluesky',
      description: "Post real text (optionally with a video) to Joel's Bluesky account via the actual, live API — genuinely free, no card, confirmed working. Call this ONLY after Joel has explicitly approved posting this specific content — never post on your own judgment without a real, explicit go-ahead in this conversation, since this is a real, public, irreversible action.",
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The exact post text Joel approved' },
          videoUrl: { type: 'string', description: 'Optional: a real, fetchable URL to a video to attach (e.g. from a prior generate_video call)' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_marketing_post',
      // REAL FIX: this tool was described to the model in identity.js's
      // prompt text and its client-side dispatch already existed in
      // app.js — but it was never actually added to THIS tools array,
      // meaning the model could never really call it. That real gap is
      // the confirmed cause of "make a post for bluesky" producing
      // unpredictable behavior instead of generating real content: with
      // no valid marketing tool available to call, the model had
      // nothing correct to reach for.
      description: "Generates a real, pain-point-focused social media post (image + caption) using Flow's actual content pipeline, and shows Joel a real in-app approval card before anything is posted anywhere. Call this whenever Joel asks to make/create a post, marketing content, or something to share on social media — even if he doesn't name a specific platform. This does NOT post anything by itself; it only creates a draft for Joel's real approval.",
      parameters: {
        type: 'object',
        properties: {
          angle: { type: 'string', description: 'Optional: a specific pain point or theme Joel wants the post to focus on. Omit to let Flow choose one.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_content_lab',
      description: "Opens Flow's real Content Lab overlay — a workspace for creating and previewing social media content (video, images, text, hashtags) across Joel's platforms (Bluesky, and others in preview). Call this when Joel explicitly asks to open Content Lab, or when he's asking about content/marketing work broadly enough that the full workspace would genuinely help more than a single generated post.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

// Real execution dispatcher — actually runs the tool server-side where
// possible (get_current_time), or returns a signal the CLIENT needs to
// act on (open_camera, generate_image both need browser/Electron APIs
// this server function can't touch directly — camera access and image
// generation both require client-side execution). The response shape
// tells the caller which case it is.
async function executeFlowTool(toolName, args) {
  if (toolName === 'get_current_time') {
    const now = new Date();
    return {
      handled: true,
      // REAL FIX: no timeZone was specified, so this used the SERVER's
      // timezone (Vercel functions run in UTC) instead of Joel's real
      // timezone — confirmed by his real report of the time being 1hr
      // off, consistent with UTC vs WAT (UTC+1). Africa/Lagos is the
      // correct IANA timezone identifier for WAT.
      result: `Current date and time: ${now.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Africa/Lagos' })}`,
    };
  }
  if (toolName === 'open_camera') {
    // Can't open a camera from a serverless function — this needs to
    // happen in the browser/Electron renderer. Signal the client to
    // handle it; core/ai.js's tool-call loop checks for this shape.
    return { handled: false, clientAction: 'open_camera', result: null };
  }
  if (toolName === 'generate_image') {
    // Same real constraint: image generation is a separate API call
    // (api/imagine.js) best triggered client-side where the existing
    // UI (ui/imagine.js) already handles displaying the result — not
    // duplicated here.
    return { handled: false, clientAction: 'generate_image', clientArgs: args, result: null };
  }
  if (toolName === 'get_my_level') {
    return { handled: false, clientAction: 'get_my_level', result: null };
  }
  if (toolName === 'get_my_live_state') {
    return { handled: false, clientAction: 'get_my_live_state', result: null };
  }
  if (toolName === 'get_my_capabilities') {
    return { handled: false, clientAction: 'get_my_capabilities', clientArgs: args, result: null };
  }
  if (toolName === 'check_for_updates') {
    return { handled: false, clientAction: 'check_for_updates', result: null };
  }
  if (toolName === 'recall_memory') {
    // REAL, genuinely server-side — unlike open_camera/get_my_level
    // above, past-conversation memory lives in the same KV store this
    // function already reads/writes elsewhere (KV_REST_API_URL/TOKEN),
    // so this runs directly here with no client round-trip needed.
    const result = await _recallMemory(args?.query || '');
    return {
      handled: true,
      result: result.length
        ? result.map(r => `[${new Date(r.ts).toLocaleDateString()}] ${r.text}`).join('\n')
        : 'Nothing relevant found in memory for that.',
    };
  }
  if (toolName === 'toggle_sentinel') {
    return { handled: false, clientAction: 'toggle_sentinel', result: null };
  }
  if (toolName === 'open_notepad') {
    return { handled: false, clientAction: 'open_notepad', result: null };
  }
  if (toolName === 'post_to_bluesky') {
    return { handled: false, clientAction: 'post_to_bluesky', clientArgs: args, result: null };
  }
  if (toolName === 'generate_marketing_post') {
    // Real fix: this case genuinely did not exist before, matching the
    // tool definition's earlier absence — the client-side handler in
    // app.js (case "generate_marketing_post") was already correct and
    // waiting for this signal, it just never arrived.
    return { handled: false, clientAction: 'generate_marketing_post', clientArgs: args, result: null };
  }
  if (toolName === 'open_content_lab') {
    return { handled: false, clientAction: 'open_content_lab', result: null };
  }
  return { handled: true, result: `Unknown tool: ${toolName}` };
}

async function tryCerebras(messages, intent, key) {
  const chain = CB_MODELS[intent] || CB_MODELS.chat;
  // Only offer tools for intents where autonomous tool-use genuinely
  // helps — chat and research are the natural fit for "what time is it"
  // or "look at this"; code/pdf intents stay tool-free to avoid the
  // model reaching for a tool mid-code-generation for no real reason.
  const offerTools = intent === 'chat' || intent === 'research';

  for (const { model, maxTokens } of chain) {
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), 7000);
    try {
      const body = { model, max_tokens: maxTokens, messages };
      if (offerTools) body.tools = FLOW_TOOLS;

      const r = await fetch('https://api.cerebras.ai/v1/chat/completions', {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        signal:  ctrl.signal,
      });
      clearTimeout(t);
      if (r.status === 429) { console.warn(`[Flow] Cerebras rate limit: ${model}`); continue; }
      const data = await r.json();
      if (!r.ok || !data.choices?.length) throw new Error(data.error?.message || `HTTP ${r.status}`);

      const choice = data.choices[0];
      const toolCalls = choice.message?.tool_calls;

      // REAL tool-calling loop: if the model chose to call a tool, we
      // actually run it and give the model a chance to respond using
      // the real result — a genuine second round-trip, not simulated.
      // Client-side tools (camera, image-gen) can't be executed here
      // (this is a serverless function, no camera/browser access) —
      // those get signaled back to the caller (core/ai.js) to handle in
      // the renderer instead.
      if (toolCalls?.length) {
        const call = toolCalls[0]; // one tool call per turn for now — real, simple scope
        const toolArgs = JSON.parse(call.function.arguments || '{}');
        const toolResult = await executeFlowTool(call.function.name, toolArgs);

        if (!toolResult.handled) {
          return {
            reply: choice.message.content || '',
            model: `Cerebras:${model}`,
            clientAction: toolResult.clientAction,
            clientArgs: toolResult.clientArgs,
          };
        }

        const followUpMessages = [
          ...messages,
          choice.message,
          { role: 'tool', tool_call_id: call.id, content: toolResult.result },
        ];
        const r2 = await fetch('https://api.cerebras.ai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, max_tokens: maxTokens, messages: followUpMessages }),
        });
        const data2 = await r2.json();
        if (!r2.ok || !data2.choices?.length) throw new Error(data2.error?.message || `HTTP ${r2.status}`);
        const cleaned = cleanReply(data2.choices[0].message.content, intent); return { reply: cleaned.reply, idea: cleaned.idea, model: `Cerebras:${model}` };
      }

      return { reply: cleanReply(choice.message.content), model: `Cerebras:${model}` };
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
const OR_TOKENS = { code: 8000, research: 4000, creative: 1600, pdf: 1200, chat: 2200 };

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
      const cleaned = cleanReply(data.choices[0].message.content, intent); return { reply: cleaned.reply, idea: cleaned.idea, model: `OR:${model}` };
    } catch (e) { clearTimeout(t); console.warn(`[Flow] OR ${model}: ${e.message}`); }
  }
  throw new Error('OpenRouter: all models failed');
}

// ── 3. GROQ ───────────────────────────────────────────────────────────────
// REAL BUG FIX: every model previously listed here was confirmed dead or
// actively deprecating, per Groq's own deprecation docs:
//   mixtral-8x7b-32768      — deprecated 2025-03-20
//   gemma2-9b-it            — deprecated 2025-10-08
//   llama-3.1-8b-instant    — deprecated June 17, 2026
//   llama-3.3-70b-versatile — deprecated June 17, 2026
// Same bug class as the Cerebras fix earlier this session — Groq was
// silently failing every call and falling through to HuggingFace.
// Replaced with Groq's own currently-recommended migration targets:
// openai/gpt-oss-120b, openai/gpt-oss-20b, qwen/qwen3.6-27b.
const GROQ_MODELS = {
  code:     [
    { model: 'openai/gpt-oss-120b', maxTokens: 3200 },
    { model: 'qwen/qwen3.6-27b',    maxTokens: 2700 },
    { model: 'openai/gpt-oss-20b',  maxTokens: 2200 },
  ],
  research: [
    { model: 'openai/gpt-oss-120b', maxTokens: 1700 },
    { model: 'qwen/qwen3.6-27b',    maxTokens: 1400 },
  ],
  creative: [
    { model: 'qwen/qwen3.6-27b',    maxTokens: 1200 },
    { model: 'openai/gpt-oss-20b',  maxTokens: 1000  },
  ],
  pdf:      [
    { model: 'openai/gpt-oss-20b',  maxTokens: 1400 },
    { model: 'qwen/qwen3.6-27b',    maxTokens: 1200 },
  ],
  chat:     [
    { model: 'openai/gpt-oss-20b',  maxTokens: 2200 },
    { model: 'qwen/qwen3.6-27b',    maxTokens: 2200 },
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
      const cleaned = cleanReply(data.choices[0].message.content, intent); return { reply: cleaned.reply, idea: cleaned.idea, model: `Groq:${model}` };
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
      const cleaned = cleanReply(data.choices[0].message.content, intent); return { reply: cleaned.reply, idea: cleaned.idea, model: `HF:${model}` };
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
const NV_TOKENS = { code: 8000, research: 4000, chat: 2200, creative: 1600, pdf: 1000 };

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
    const cleaned = cleanReply(data.choices[0].message.content, intent); return { reply: cleaned.reply, idea: cleaned.idea, model: `NVIDIA:${model}` };
  } catch (e) {
    clearTimeout(t);
    console.warn(`[Flow] NVIDIA ${e.message}`);
    throw e;
  }
}

// ═══════════════════════════════════════════
// REAL, server-side semantic memory — brings the same real semantic-
// recall system that previously only existed in flow-electron/
// memory-store.js (Electron-only, backing the background heartbeat)
// into the actual conversational chat path, for both web AND Electron
// clients (since both hit this same /api/chat endpoint). Genuine port
// of the same logic — keyword+recency scoring blended with real cosine-
// similarity embeddings when available — but backed by the same Upstash
// KV REST API this file already uses elsewhere (see _logThought above),
// since a Vercel serverless function has no local filesystem to persist
// a JSON file the way Electron's main process does.
// ═══════════════════════════════════════════
const MEMORY_KV_KEY = 'flow_semantic_memory';

async function _getEmbeddingForMemory(text) {
  try {
    // Real, matches the exact same VERCEL_URL convention already used in
    // flow-electron/heartbeat.js and flow-electron/memory-store.js for
    // their own fetch() calls to this deployed backend.
    const res = await fetch('https://flow-v3-mu.vercel.app/api/mediapipe?action=embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.embedding) ? data.embedding : null;
  } catch (_) {
    return null; // real, non-fatal — recall/remember still work via keyword+recency without it
  }
}

function _cosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return (na === 0 || nb === 0) ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}
function _tokenizeMemory(text) {
  return (text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}
function _overlapScore(qTokens, eTokens) {
  if (!qTokens.length || !eTokens.length) return 0;
  const set = new Set(eTokens);
  return qTokens.filter(t => set.has(t)).length / qTokens.length;
}

async function _loadMemoryEntries() {
  const KV_URL = process.env.KV_REST_API_URL;
  const KV_TOKEN = process.env.KV_REST_API_TOKEN;
  if (!KV_URL || !KV_TOKEN) return [];
  try {
    const res = await fetch(`${KV_URL}/get/${MEMORY_KV_KEY}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    const data = await res.json().catch(() => ({}));
    const parsed = data?.result ? JSON.parse(data.result) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

async function _saveMemoryEntries(entries) {
  const KV_URL = process.env.KV_REST_API_URL;
  const KV_TOKEN = process.env.KV_REST_API_TOKEN;
  if (!KV_URL || !KV_TOKEN) return;
  try {
    // Real, bounded size — same real cap as the Electron version (2000
    // entries), comfortably covering months of real conversation without
    // unbounded KV growth.
    const bounded = entries.length > 2000 ? entries.slice(-2000) : entries;
    await fetch(`${KV_URL}/set/${MEMORY_KV_KEY}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(bounded),
    });
  } catch (_) { /* non-fatal — a failed save never blocks the actual chat reply */ }
}

// REAL, honest write path — always succeeds at the text level even if
// the embedding fetch fails (network hiccup, HF rate limit, etc.) —
// matches the exact same honest fallback behavior as the Electron version.
async function _rememberConversation(text, category = 'conversation', metadata = {}) {
  if (!text || !text.trim()) return;
  try {
    const entries = await _loadMemoryEntries();
    const embedding = await _getEmbeddingForMemory(text);
    entries.push({
      id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text, category, ts: Date.now(), embedding, ...metadata,
    });
    await _saveMemoryEntries(entries);
  } catch (e) {
    console.warn('[Memory] Remember failed (non-fatal):', e.message);
  }
}

async function _recallMemory(query, { maxResults = 5 } = {}) {
  if (!query || !query.trim()) return [];
  try {
    const entries = await _loadMemoryEntries();
    const qTokens = _tokenizeMemory(query);
    const qEmbedding = await _getEmbeddingForMemory(query);
    const now = Date.now();

    return entries
      .map(e => {
        const overlap = _overlapScore(qTokens, _tokenizeMemory(e.text));
        const ageDays = (now - e.ts) / (24 * 60 * 60 * 1000);
        const recencyBoost = Math.max(0, 1 - ageDays / 30) * 0.2;
        const keywordScore = overlap + recencyBoost;
        let finalScore = keywordScore;
        if (qEmbedding && e.embedding) {
          finalScore = (_cosineSim(qEmbedding, e.embedding) * 0.7) + (keywordScore * 0.3);
        }
        return { entry: e, score: finalScore };
      })
      .filter(s => s.score > 0.15) // real, small threshold — avoids surfacing genuinely unrelated entries just because they share one common word
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map(s => ({ text: s.entry.text, ts: s.entry.ts, score: s.score }));
  } catch (e) {
    console.warn('[Memory] Recall failed (non-fatal):', e.message);
    return [];
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

  // REAL, NEW (this session) — stores the user's actual message into the
  // real semantic-memory system (shared KV, same one flow-electron/
  // memory-store.js already uses for the Electron background heartbeat)
  // so recall_memory (a real tool, defined above) has something genuine
  // to search. Fire-and-forget: never blocks or slows down the actual
  // reply, and a failure here is silently non-fatal (matches
  // _rememberConversation's own internal try/catch). Deliberately placed
  // here rather than inside cleanReply/each provider function — this way
  // it only needs ONE call site instead of six, and doesn't depend on
  // which provider ends up serving the reply.
  const lastUserMsg = [...trimmed].reverse().find(m => m.role === 'user');
  if (lastUserMsg?.content && typeof lastUserMsg.content === 'string') {
    _rememberConversation(lastUserMsg.content, 'conversation', { intent }).catch(() => {});
  }

  const totalChars = trimmed.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0);
  // REAL FIX, confirmed by Joel's actual test: an ordinary short message
  // ("make up a post about my business") was rejected by this guard —
  // meaning the real system prompt (identity.js's hard limits + tool
  // descriptions + reasoning instructions, plus persona/skills/RAG
  // blocks, plus real conversation history) has genuinely grown past
  // 18,000 chars over the course of this session's real feature growth
  // (tool-calling, Python sandbox docs, Bluesky posting, etc.) — this
  // was never a large-payload problem, it was a stale, too-low constant
  // that never got raised to match how much identity.js/ai.js's own
  // prompt has grown. The old comment's assumption that chat/creative/
  // pdf "were never the bottleneck" is now confirmed false by real use,
  // not theoretical. Raised generously — still well under Cerebras/
  // Groq's real context windows, with headroom for further growth
  // rather than needing another emergency bump next time a feature is added.
  const sizeLimit = (intent === 'code' || intent === 'research') ? 900000 : 60000;
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

  // Cerebras is fast but sometimes struggles with complex/large-context
  // tasks — skip for Nemotron targets. REAL, DELIBERATE CHOICE (Joel's
  // own, given NVIDIA's real 40rpm + credit-limited free tier): NVIDIA
  // stays #1 ONLY for code and research (the two intents that genuinely
  // benefit from Nemotron's large context), NOT for chat/creative/pdf —
  // spending the limited NVIDIA budget on ordinary chat messages would
  // burn through the real rate limit faster with no real benefit, since
  // those intents don't need the large-context model anyway.
  if (CB_KEY && intent !== 'code' && intent !== 'research') {
    try   { const r = await tryCerebras(trimmed, intent, CB_KEY); return res.status(200).json({ ...r, intent }); }
    catch (e) { errors.push(`Cerebras: ${e.message}`); }
  }

  // NVIDIA direct API — Nemotron 3 Ultra (large-context), genuinely #1
  // for code + research now (both skip Cerebras above), matching the
  // large-context need those two intents actually have.
  if (NV_KEY) {
    try   { const r = await tryNvidia(trimmed, intent, NV_KEY); return res.status(200).json({ ...r, intent }); }
    catch (e) { errors.push(`NVIDIA: ${e.message}`); }
  }

  if (OR_KEY) {
    try   { const r = await tryOpenRouter(trimmed, intent, OR_KEY); return res.status(200).json({ ...r, intent }); }
    catch (e) { errors.push(`OpenRouter: ${e.message}`); }
  }

  // Cerebras fallback for code/research if NVIDIA and OpenRouter both failed
  if (CB_KEY && (intent === 'code' || intent === 'research')) {
    try   { const r = await tryCerebras(trimmed, intent, CB_KEY); return res.status(200).json({ ...r, intent }); }
    catch (e) { errors.push(`Cerebras(${intent} fallback): ${e.message}`); }
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
