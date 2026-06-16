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

// UI refs injected at init (avoids circular imports)
let _chat = null;
let _orb  = null;
export function setUI(chat, orb) { _chat = chat; _orb = orb; }

// Restore persisted agent on boot
restoreAgent();

function buildPrompt(weather, ragContext, skillContext, extractedMemory) {
  const p = Memory.getProfile();
  const ragBlock = ragContext
    ? `\nKNOWLEDGE BASE (relevant to this query):\n${ragContext}\n`
    : "";

  const extractedBlock = extractedMemory
    ? `\nJOEL'S KNOWN CONTEXT (from past conversations):\n${extractedMemory}\n`
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

  return `${CONFIG.PERSONALITY}

${selfKnowledgeBlock()}
${ragBlock}${agentBlock}${skillBlock}${extractedBlock}${projectsBlock}
LIVE CONTEXT:
Time: ${getTime()}
Date: ${getDate()}
Location: ${p.city}, ${p.country || "Nigeria"}
Weather: ${weather}
Alarms: ${Alarms.list()}
Facts about Joel: ${Memory.factsString()}
Note: ${Storage.get("notes","").slice(0,120) || "none"}
Goals today: ${goalsSummary()}

CAPABILITY FILTER — CRITICAL:
Before responding, check if Joel is asking you to DO something (not just explain it).
If it is something Flow CAN do (listed in WHAT I CAN DO above), respond as Flow doing it.
If it is something Flow CANNOT do, say exactly what you can't do and offer the closest thing you CAN do.
NEVER pretend to do something you haven't actually done. NEVER say "done" or "pushed" or "created" unless Flow's code actually executed it.
Example: if asked to "push files to GitHub" — do NOT say "pushed!" — the push happens through Flow's GitHub functions, not through text.
Stay in character as Flow. Never break the fourth wall.`;
}

export async function sendMessage(overrideText) {
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
  _chat.add(text, "user");
  Memory.add("user", text);

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
    const [weather, ragContext, skillContext] = await Promise.all([
      Weather.get(),
      RAG.search(text),
      getSkillContext(text),
    ]);
    const extractedMemory = getExtractedMemoryContext();

    const messages = [
      { role: "system", content: buildPrompt(weather, ragContext, skillContext, extractedMemory) },
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
    const [weather, ragContext, skillContext] = await Promise.all([
      Weather.get(),
      RAG.search(text),
      getSkillContext(text),
    ]);
    const extractedMemory = getExtractedMemoryContext();

    const messages = [
      { role: "system", content: buildPrompt(weather, ragContext, skillContext, extractedMemory) },
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
    _orb.setState("speaking");
    Speech.speak(data.reply, () => { _orb.setState("idle"); }, _wrap);

  } catch (err) {
    _chat.hideTyping();
    _chat.addError(err.message);
    _orb.setState("idle");
  }
}
