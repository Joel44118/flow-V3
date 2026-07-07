// ═══════════════════════════════════════════
// core/ai.js — Calls /api/chat (Vercel proxy)
// Key stays on server. Never in browser.
// Now includes RAG context injection.
// ═══════════════════════════════════════════
import { Memory }        from "./memory.js";
import { Weather }       from "./weather.js";
import { Alarms }        from "./alarms.js";
import { Storage }       from "./storage.js";
import { CONFIG }        from "./config.js";
import { parseCommand, getTime, getDate } from "./commands.js";
import { goalsSummary } from "./goals.js";
import { selfKnowledgeBlock } from "./identity.js";
import { Speech }        from "./speech.js";
import { RAG }           from "./rag.js";
import { getSkillContext } from "./skills.js";
import { getExtractedMemoryContext } from "./memextract.js";
import { Projects } from "./projects.js";
import { getAgentContext, restoreAgent } from "./agent.js";
import { getFeedbackContext } from "./feedback.js";
import { awardCasualLearningXp } from "./leveling.js";
import { getPersonaPromptBlock, recordJoelMessage } from "./persona.js";
import { runtimeStateBlock } from "./runtime.js";

// UI refs injected at init (avoids circular imports)
let _chat = null;
let _orb  = null;
export function setUI(chat, orb) { _chat = chat; _orb = orb; }

// Restore persisted agent on boot
restoreAgent();

function buildPrompt(weather, ragContext, skillContext, extractedMemory, feedbackCtx, personaBlock) {
  const p = Memory.getProfile();
  const ragBlock = ragContext
    ? `\nKNOWLEDGE BASE (relevant to this query):\n${ragContext}\n`
    : "";

  const extractedBlock = extractedMemory
    ? `\nJOEL'S KNOWN CONTEXT (from past conversations):\n${extractedMemory}\n`
    : "";

  const feedbackBlock = feedbackCtx
    ? `\nJOEL'S FEEDBACK (learn from this — highest priority):\n${feedbackCtx}\n`
    : "";

  const projectsCtx = Projects.toPromptContext();
  const projectsBlock = projectsCtx
    ? `\n${projectsCtx}\n`
    : "";

  const agentCtx   = getAgentContext();
  const agentBlock  = agentCtx
    ? `\nAGENT MODE ACTIVE — ${agentCtx.icon} ${agentCtx.name.toUpperCase()}:\n${agentCtx.content}\n`
    : "";

  const skillBlock = !agentCtx && skillContext
    ? `\nSKILL CONTEXT — you are acting as a ${skillContext.name} specialist for this response:\n${skillContext.content}\n`
    : "";

  return `${CONFIG.PERSONALITY}${personaBlock || ""}

${selfKnowledgeBlock()}
${feedbackBlock}${ragBlock}${agentBlock}${skillBlock}${extractedBlock}${projectsBlock}
LIVE CONTEXT:
Time: ${getTime()}
Date: ${getDate()}
Location: ${p.city}, ${p.country || "Nigeria"}
Weather: ${weather}
Alarms: ${Alarms.list()}
Facts about Joel: ${Memory.factsString()}
Note: ${Storage.get("notes","").slice(0,120) || "none"}
Goals today: ${goalsSummary()}

FLOW'S ACTUAL CURRENT STATE — read this, not just the capability list above:
${runtimeStateBlock()}

CAPABILITY FILTER — CRITICAL:
Before responding, check if Joel is asking you to DO something (not just explain it).
If it is something Flow CAN do (listed in WHAT I CAN DO above), respond as Flow doing it.
If it is something Flow CANNOT do, say exactly what you can't do and offer the closest thing you CAN do.
NEVER pretend to do something you haven't actually done. NEVER say "done" or "pushed" or "created" unless Flow's code actually executed it.
Example: if asked to "push files to GitHub" — do NOT say "pushed!" — the push happens through Flow's GitHub functions, not through text.
Your CURRENT STATE above is real, checked truth — not a guess. If the camera is OFF, do not act like you can see Joel. If it's ON, you genuinely can, right now, and should act like it without being reminded. If you have no confirmed Telegram admin rights listed, do not claim you're an admin anywhere — say you're not sure and offer to check, rather than assume.
Stay in character as Flow. Never break the fourth wall.

REASONING STEP — REQUIRED BEFORE EVERY RESPONSE:
Before writing your actual reply, think through the request first inside a
<flow-think>...</flow-think> block: what is Joel actually asking, what's the
right approach, any risk of getting it wrong, and what you're going to check
or do. Keep this block short — a few lines, not an essay. Immediately after
the closing </flow-think> tag, write your real, final reply as normal — this
is the ONLY part Joel or anyone else will ever see, since the thinking block
is stripped out before delivery. Never mention the thinking block exists,
never reference it in the reply, never skip it.`;
}

// ── Self-judged casual learning ──────────────────────────────────────────
// Runs after EVERY reply, fire-and-forget (never awaited by the caller, so
// it can never slow down or block a response reaching Joel). Asks a small,
// fast model a narrow, skeptical yes/no question: did Joel just state
// something genuinely new — a correction or a fact Flow didn't already
// know — in this specific exchange? This is DELIBERATELY separate from the
// explicit 👎-correction flow in feedback.js, which still exists and still
// awards its own (higher) XP tier unchanged.
//
// WHY THE CONFIDENCE THRESHOLD MATTERS: an LLM asked "did you just learn
// something?" will say yes far more often than is true, because agreeing
// sounds helpful. Without a real skepticism bias and a confidence cutoff,
// XP would inflate on ordinary small talk within days and the whole system
// would stop meaning anything. The threshold below (0.7) is the actual
// guardrail — do not lower it without expecting more false awards.
async function judgeAndAwardLearning(userText, replyText) {
  try {
    const JUDGE_SYSTEM = `You are a strict, skeptical judge — not Flow, not an assistant, just a classifier.
Given ONE exchange between Joel and Flow, decide: did Joel's message state a genuinely NEW, SPECIFIC fact or correction that Flow did not already know?
Casual conversation, questions, opinions, jokes, or vague statements do NOT count — default to "no" unless it's clearly a real new piece of information or a real correction.
Reply with ONLY raw JSON, nothing else, no markdown fences:
{"learned": true|false, "category": "correction"|"fact"|"none", "confidence": 0.0-1.0, "summary": "under 12 words"}`;

    const r = await fetch("/api/chat", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: JUDGE_SYSTEM },
          { role: "user", content: `Joel said: "${userText.slice(0, 500)}"\nFlow replied: "${replyText.slice(0, 500)}"` },
        ],
        // Hint to chat.js this is a small classification call, not a real
        // conversational turn — keeps it cheap and fast on the Groq/Cerebras
        // "chat" tier rather than routing through heavier code/research models.
        force_intent: "chat",
      }),
    });
    if (!r.ok) return;
    const data = await r.json();
    if (!data.reply) return;

    let parsed;
    try {
      parsed = JSON.parse(data.reply.trim().replace(/^```json\s*|\s*```$/g, ""));
    } catch (_) {
      return; // judge didn't return clean JSON — skip silently, never throw into the main flow
    }

    if (parsed.learned === true && parsed.confidence >= 0.7 && parsed.category !== "none") {
      awardCasualLearningXp(parsed.summary || userText.slice(0, 60));
      console.log(`[Flow] Self-judged learning: ${parsed.category} (confidence ${parsed.confidence}) — ${parsed.summary}`);
    }
  } catch (e) {
    console.warn("[Flow] judgeAndAwardLearning failed silently:", e.message);
  }
}

export async function sendMessage(overrideText, opts = {}) {
  // Always query DOM fresh — never cache
  const inputEl = document.getElementById("user-input");
  let text = "";

  if (typeof overrideText === "string" && overrideText.trim()) {
    text = overrideText.trim();
  } else if (inputEl?.textContent.trim()) {
    text = inputEl.textContent.trim();
  }

  if (!text) { console.warn("[Flow] send() — no text"); return; }
  if (inputEl) inputEl.textContent = "";

  console.log("[Flow] →", text);
  // skipEcho: caller (flowSend in app.js) already rendered the user bubble
  // and recorded it to Memory before running its own local-command parsing,
  // so the AI path here doesn't duplicate it.
  if (!opts.skipEcho) {
    _chat.add(text, "user");
    Memory.add("user", text);
  }

  // Local commands — no API needed
  const local = await parseCommand(text);
  if (local !== false) {
    if (local !== null) {
      _chat.add(local, "bot");
      Memory.add("assistant", local);
      Speech.speak(local);
    }
    return;
  }

  // API call
  _orb.setState("thinking");
  _chat.showTyping();

  try {
    // Run weather + RAG search in parallel
    const [weather, ragContext, skillContext, personaBlock] = await Promise.all([
      Weather.get(),
      RAG.search(text),
      getSkillContext(text),
      getPersonaPromptBlock(window.location.origin),
    ]);
    const extractedMemory = getExtractedMemoryContext();
    recordJoelMessage(window.location.origin, text); // fire-and-forget — feeds the style profile, never blocks

    const messages = [
      { role: "system", content: buildPrompt(weather, ragContext, skillContext, extractedMemory, getFeedbackContext(), personaBlock) },
      ...Memory.forAPI(),
    ];

    const res = await fetch("/api/chat", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ messages, max_tokens: CONFIG.MAX_TOKENS }),
    });

    const data = await res.json();
    if (!res.ok || !data.reply) throw new Error(data.error || `Server error ${res.status}`);

    console.log("[Flow] ←", data.reply.slice(0,60), `(${data.model}, intent: ${data.intent || "?"})`);
    _chat.hideTyping();
    const _wrap = _chat.add(data.reply, "bot");
    Memory.add("assistant", data.reply);
    judgeAndAwardLearning(text, data.reply); // fire-and-forget, never awaited — see function above
    _orb.setState("speaking");
    Speech.speak(data.reply, () => { _orb.setState("idle"); }, _wrap);

  } catch(err) {
    _chat.hideTyping();
    console.error("[Flow] Error:", err.message);
    _chat.addError(err.message);
    _orb.setState("idle");
  }
}

// ── Direct AI call — skips ALL local command parsing ────────────────────
// Used by search/URL results so website content doesn't trigger
// weather/alarm/vision commands accidentally
export async function sendToAI(text) {
  if (!text?.trim()) return;

  _orb.setState("thinking");
  _chat.showTyping();

  try {
    const [weather, ragContext, skillContext, personaBlock] = await Promise.all([
      Weather.get(),
      RAG.search(text),
      getSkillContext(text),
      getPersonaPromptBlock(window.location.origin),
    ]);
    const extractedMemory = getExtractedMemoryContext();
    recordJoelMessage(window.location.origin, text); // fire-and-forget — feeds the style profile, never blocks

    const messages = [
      { role: "system", content: buildPrompt(weather, ragContext, skillContext, extractedMemory, getFeedbackContext(), personaBlock) },
      ...Memory.forAPI(),
      { role: "user", content: text },
    ];

    const res  = await fetch("/api/chat", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ messages, max_tokens: CONFIG.MAX_TOKENS }),
    });
    const data = await res.json();
    if (!res.ok || !data.reply) throw new Error(data.error || `Server error ${res.status}`);

    _chat.hideTyping();
    const _wrap = _chat.add(data.reply, "bot");
    Memory.add("assistant", data.reply);
    judgeAndAwardLearning(text, data.reply); // fire-and-forget, never awaited — see function above
    _orb.setState("speaking");
    Speech.speak(data.reply, () => { _orb.setState("idle"); }, _wrap);

  } catch (err) {
    _chat.hideTyping();
    _chat.addError(err.message);
    _orb.setState("idle");
  }
}
