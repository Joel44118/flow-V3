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
import { getToolsPromptContext, parseToolProposal } from "./selftools.js";

// UI refs injected at init (avoids circular imports)
let _chat = null;
let _orb  = null;
let _onClientAction = null;
export function setUI(chat, orb) { _chat = chat; _orb = orb; }
// Registers a callback for real autonomous tool-use client actions
// (camera, image generation) that Flow's own judgment decided to
// trigger — see the clientAction handling in sendMessage below.
export function setClientActionHandler(fn) { _onClientAction = fn; }

// Restore persisted agent on boot
restoreAgent();

async function buildPrompt(weather, ragContext, skillContext, extractedMemory, feedbackCtx, personaBlock) {
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

${await selfKnowledgeBlock()}
${selfToolsBlock}
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

PROACTIVE UI SUGGESTIONS — be genuinely useful, not just reactive:
You have real, live visibility into your own UI state (see MY REAL LIVE STATE above). Use it to actively suggest actions when it clearly fits the moment — don't wait to always be asked:
- If Joel mentions being away from his desk, wants an alert on something, or seems to want ambient awareness, and Sentinel is currently OFF: offer "Want me to turn on Sentinel?" rather than just answering generically.
- If Joel dictates a thought or asks you to "remember this for later" in a way that suggests he wants it visibly written down, not just stored in memory: offer "Should I put that in the notepad for you?" (the notepad is always available — this isn't a toggle, just a helpful nudge).
- If Joel references needing to see something visual (a document, his screen, a product): offer camera/screen-share if currently off, e.g. "Want me to turn on the camera so I can see that?"
- If a self-tool, agent mode, or other real toggle in your live state would obviously help the current request and is low-risk/reversible: suggest it by name, don't just describe what it would do in the abstract.
- Never suggest a toggle that's already ON — check MY REAL LIVE STATE first. Never suggest something not listed there.
- Suggestions should read as one natural, brief offer woven into your reply — not a bullet list of every possible toggle every time. Read the moment; if nothing genuinely fits, don't force one.`;
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

    const systemPrompt = await buildPrompt(weather, ragContext, skillContext, extractedMemory, getFeedbackContext(), personaBlock);
    const messages = [
      { role: "system", content: systemPrompt },
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
        throw new Error("The request timed out (504) — the model took too long to respond. This is less likely now that the server timeout has been raised to 60s, but can still happen on a slow provider response. Try again.");
      }
      throw new Error(`Server returned a non-JSON error (status ${res.status}).`);
    }

    const data = await res.json();
    // REAL BUG FIXED: a successful tool-call response legitimately has an
    // EMPTY reply string by design (api/chat.js returns `reply:
    // choice.message.content || ''` when the model calls a client-side
    // tool and says nothing else) — this guard used to throw
    // "Server error 200" on that exact case, before the clientAction
    // handling below ever ran. Confirmed via real testing: "what's your
    // level" and "did anything change" both hit this, since those tool
    // calls produce genuinely empty first-pass replies. Only throw when
    // there's truly nothing usable — no reply AND no clientAction to
    // follow up on.
    if (!res.ok || (!data.reply && !data.clientAction)) throw new Error(data.error || `Server error ${res.status}`);

    console.log("[Flow] ←", (data.reply || "(tool call, no initial text)").slice(0,60), `(${data.model}, intent: ${data.intent || "?"})`);
    _chat.hideTyping();

    // REAL AUTONOMOUS TOOL-USE: if the model's own judgment chose to
    // call a client-side tool, api/chat.js signals that via clientAction
    // rather than pretending to have done it server-side (which is
    // structurally impossible — a serverless function has no camera,
    // browser fetch, or localStorage access). Dispatched via a callback
    // (_onClientAction) that app.js registers, rather than importing UI
    // modules directly here — core/ai.js importing UI would be a
    // backwards architectural dependency (UI should depend on core, not
    // the reverse).
    //
    // TWO REAL SHAPES, by design:
    //   - Action tools (open_camera, generate_image, toggle_sentinel,
    //     open_notepad): fire-and-forget. app.js's handler does the
    //     thing and prints its own canned confirmation line — there's
    //     nothing for the model to say beyond what already happened.
    //   - Info tools (get_my_level, get_my_live_state,
    //     get_my_capabilities, check_for_updates): the handler in app.js
    //     returns the real fetched data as a string. When it does, THIS
    //     function does a genuine second round-trip to /api/chat with
    //     that real result appended as a tool message — so Flow's actual
    //     reply is grounded in fresh data ("You're at Level 5, 200/500
    //     XP"), not silence or a guess. This mirrors exactly how
    //     get_current_time already works server-side — same real
    //     mechanism, just resolved in the browser because the data
    //     (localStorage, repo map fetch) only exists there.
    if (data.clientAction && _onClientAction) {
      const toolResult = await _onClientAction(data.clientAction, data.clientArgs);
      if (typeof toolResult === "string" && toolResult) {
        const followUpMessages = [
          ...messages,
          { role: "assistant", content: data.reply || "" },
          { role: "user", content: `[Real tool result for ${data.clientAction}]: ${toolResult}\n\nNow answer Joel's actual question using this real data.` },
        ];
        try {
          const res2 = await fetch("/api/chat", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ messages: followUpMessages, max_tokens: CONFIG.MAX_TOKENS }),
          });
          const data2 = await res2.json();
          if (res2.ok && data2.reply) {
            data.reply = data2.reply; // real, grounded reply replaces the original tool-call stub
          }
        } catch (e) {
          console.warn("[Flow] Tool follow-up round-trip failed:", e.message);
          // Fall through and show whatever data.reply already was — a
          // real network failure here shouldn't crash the whole turn.
        }
      }
    }

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
    // REAL BUG FIX: this used to also require /```/ (a literal triple-
    // backtick code fence) in the reply before retrying — but real
    // testing showed the model can answer with plain prose / inline
    // code / no fence at all and still skip the proposal tag. The
    // robust check is simpler: if the request looked like a tool
    // request and there's no proposal tag AT ALL, retry — regardless of
    // what specific format the missed reply happened to use.
    const missedProposal = looksLikeToolRequest && !proposal;

    if (missedProposal) {
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

    const systemPrompt2 = await buildPrompt(weather, ragContext, skillContext, extractedMemory, getFeedbackContext(), personaBlock);
    const messages = [
      { role: "system", content: systemPrompt2 },
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
    // Same real bug fix as sendMessage above — empty reply + a
    // clientAction is a legitimate successful tool-call response, not an
    // error.
    if (!res.ok || (!data.reply && !data.clientAction)) throw new Error(data.error || `Server error ${res.status}`);

    // Same real clientAction handling as sendMessage above — this path
    // (voice/search-triggered messages) was calling /api/chat with the
    // same tools offered, but never actually dispatched a resulting
    // clientAction at all. A genuine pre-existing gap: a tool call made
    // via this path would previously do nothing.
    if (data.clientAction && _onClientAction) {
      const toolResult = await _onClientAction(data.clientAction, data.clientArgs);
      if (typeof toolResult === "string" && toolResult) {
        const followUpMessages = [
          ...messages,
          { role: "assistant", content: data.reply || "" },
          { role: "user", content: `[Real tool result for ${data.clientAction}]: ${toolResult}\n\nNow answer Joel's actual question using this real data.` },
        ];
        try {
          const res2 = await fetch("/api/chat", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ messages: followUpMessages, max_tokens: CONFIG.MAX_TOKENS }),
          });
          const data2 = await res2.json();
          if (res2.ok && data2.reply) data.reply = data2.reply;
        } catch (e) {
          console.warn("[Flow] Tool follow-up round-trip failed:", e.message);
        }
      }
    }

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
