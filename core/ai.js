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
import { getToolsPromptContext, parseToolProposal } from "./selftools.js";

// UI refs injected at init (avoids circular imports)
let _chat = null;
let _orb  = null;
export function setUI(chat, orb) { _chat = chat; _orb = orb; }

// Restore persisted agent on boot
restoreAgent();

function buildPrompt(weather, ragContext, skillContext, extractedMemory, feedbackCtx, personaBlock) {
  const p = Memory.getProfile();
  const ragBlock = ragContext
    ? `\nKNOWLEDGE BASE (relevant to this query — Joel specifically saved this content for you to use; you MUST draw on it directly rather than answering generically, and should reference specific details from it, not just acknowledge it exists):\n${ragContext}\n`
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

  const existingTools = getToolsPromptContext();
  const selfToolsBlock = `
SELF-TOOLS — restricted, Joel-approved only. READ CAREFULLY, this is a
FREQUENTLY MISSED instruction:
Whenever Joel asks you to build/create/make a small reusable JS
capability — phrases like "I need a tool that...", "can you build
something that...", "make a function that..." — you MUST use the
tagged proposal format below INSTEAD OF just writing the code as plain
text in your reply. Do NOT just answer with code in a normal message —
that skips Joel's approval step entirely, which defeats the whole point
of this feature.
Example trigger: "I need a small tool that converts Celsius to
Fahrenheit" → propose it via the tag below, do NOT just write Python/JS
code inline as a casual answer.
${existingTools ? `\nTools you ALREADY have (call these directly in your reasoning if relevant — do not re-propose them):\n${existingTools}\n` : "You have no self-created tools yet."}
To propose a NEW tool, output EXACTLY this tagged block, with nothing
else inside it besides valid JSON — Joel will see this as an
Approve/Reject prompt, and NOTHING runs or saves until he approves:
[SELFTOOL_PROPOSAL]
{"name": "toolName", "description": "one plain sentence explaining what it does", "params": ["paramName1", "paramName2"], "code": "return paramName1 + paramName2;"}
[/SELFTOOL_PROPOSAL]
The code must be plain JavaScript only — no filesystem, network,
GitHub, or OS access — that restriction is deliberate and Joel-approved.
Write your normal conversational reply around this block as usual — Joel
will still see your regular text, just with the approval prompt attached.
Never say a tool was "created" or is "ready to use" unless Joel has
actually approved it — that would be exactly the kind of false claim the
HARD LIMITS section above forbids.
`;

  const skillBlock = !agentCtx && skillContext
    ? `\nSKILL CONTEXT — you are acting as a ${skillContext.name} specialist for this response:\n${skillContext.content}\n`
    : "";

  return `${CONFIG.PERSONALITY}${personaBlock || ""}

${selfKnowledgeBlock()}
${feedbackBlock}${ragBlock}${agentBlock}${skillBlock}${extractedBlock}${projectsBlock}${selfToolsBlock}
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

    // REAL BUG FIX: res.json() was called unconditionally here — but a
    // Vercel-level timeout (504) or similar infra error returns plain
    // text/HTML (e.g. "An error occurred..."), not JSON. Blindly parsing
    // that as JSON threw a confusing "Unexpected token 'A'..." error
    // instead of telling Joel what actually happened. Checking the
    // content-type first gives a clear, specific message instead.
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      if (res.status === 504) {
        throw new Error("The request timed out (504) — this can happen with large repo-analysis or code-editing requests. Try again, or narrow the request to fewer files.");
      }
      throw new Error(`Server returned a non-JSON error (status ${res.status}).`);
    }

    const data = await res.json();
    if (!res.ok || !data.reply) throw new Error(data.error || `Server error ${res.status}`);

    console.log("[Flow] ←", data.reply.slice(0,60), `(${data.model}, intent: ${data.intent || "?"})`);
    _chat.hideTyping();

    // Check for a self-tool proposal BEFORE displaying the reply normally
    // — if Flow proposed a new tool, show the approval UI instead of the
    // raw tagged JSON block, using the cleaned (tag-stripped) text for the
    // conversational part of the reply.
    let proposal = parseToolProposal(data.reply);
    let finalReply = data.reply;

    // REAL SAFETY NET: confirmed via real testing that even with correct
    // intent routing (code) and the self-tools instruction present in the
    // prompt, larger models sometimes still answer with plain code
    // instead of using the proposal tag — a genuine instruction-following
    // gap, not a routing bug (both were verified correct). If the user's
    // message looks like a self-tools request AND the model's reply
    // contains a code block but NO proposal tag, retry once with an
    // explicit correction rather than silently letting the approval step
    // get bypassed — mirrors the retry-with-error-fed-back pattern
    // already used in /edit's syntax validation.
    const looksLikeToolRequest = /\b(i\s+need\s+(a\s+|an?\s+)?(small\s+)?(tool|function|utility|helper)\s+that|(build|make|create)\s+(me\s+)?(a\s+|an?\s+)?(small\s+|little\s+)?(tool|function|utility|helper|script)\s+(that|to|for))\b/i.test(text);
    const replyHasCodeButNoTag = !proposal && /```/.test(data.reply);

    if (looksLikeToolRequest && replyHasCodeButNoTag) {
      console.log("[Flow] Self-tool request answered with plain code, not the proposal tag — retrying once with a correction.");
      try {
        const retryRes = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [
              ...messages,
              { role: "assistant", content: data.reply },
              { role: "user", content: "You answered with plain code instead of using the [SELFTOOL_PROPOSAL] tagged format. Re-answer this SAME request using ONLY the tagged proposal format as instructed in your system prompt — do not explain, just use the tag." },
            ],
            force_intent: "code",
          }),
        });
        const retryContentType = retryRes.headers.get("content-type") || "";
        if (retryContentType.includes("application/json")) {
          const retryData = await retryRes.json();
          if (retryRes.ok && retryData.reply) {
            const retryProposal = parseToolProposal(retryData.reply);
            if (retryProposal) {
              proposal = retryProposal;
              finalReply = retryData.reply;
              console.log("[Flow] Retry succeeded — got a real proposal this time.");
            }
          }
        }
      } catch (e) {
        console.warn("[Flow] Self-tool retry failed, showing original reply:", e.message);
      }
    }

    const displayText = proposal ? proposal.cleanedReply : finalReply;

    const _wrap = _chat.add(displayText, "bot");
    if (proposal && _chat.addToolProposal) {
      _chat.addToolProposal(proposal);
    }
    Memory.add("assistant", displayText);
    judgeAndAwardLearning(text, displayText); // fire-and-forget, never awaited — see function above
    _orb.setState("speaking");
    Speech.speak(displayText, () => { _orb.setState("idle"); }, _wrap);

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
    const contentType2 = res.headers.get("content-type") || "";
    if (!contentType2.includes("application/json")) {
      if (res.status === 504) {
        throw new Error("The request timed out (504) — try again, or narrow the request.");
      }
      throw new Error(`Server returned a non-JSON error (status ${res.status}).`);
    }
    const data = await res.json();
    if (!res.ok || !data.reply) throw new Error(data.error || `Server error ${res.status}`);

    _chat.hideTyping();

    const proposal = parseToolProposal(data.reply);
    const displayText = proposal ? proposal.cleanedReply : data.reply;

    const _wrap = _chat.add(displayText, "bot");
    if (proposal && _chat.addToolProposal) {
      _chat.addToolProposal(proposal);
    }
    Memory.add("assistant", displayText);
    judgeAndAwardLearning(text, displayText); // fire-and-forget, never awaited — see function above
    _orb.setState("speaking");
    Speech.speak(displayText, () => { _orb.setState("idle"); }, _wrap);

  } catch (err) {
    _chat.hideTyping();
    _chat.addError(err.message);
    _orb.setState("idle");
  }
}
