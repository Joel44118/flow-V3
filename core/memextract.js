// ═══════════════════════════════════════════
// core/memextract.js — Phase 2: Structured memory extraction
//
// After every AI reply, runs a lightweight background call
// that extracts structured facts from the conversation and
// stores them in localStorage under dedicated keys:
//   flow_v3_projects    — active projects + stack + status
//   flow_v3_preferences — Joel's coding/design/work preferences
//   flow_v3_decisions   — decisions made ("decided to use X for Y")
//   flow_v3_clients     — client names, businesses, notes
//   flow_v3_entities    — people, tools, services mentioned repeatedly
//
// These are injected into the system prompt by ai.js so Flow
// always knows Joel's context without re-reading full history.
// ═══════════════════════════════════════════

import { Storage } from "./storage.js";

// ── Keys ─────────────────────────────────────────────────────────────────
const K = {
  projects:    "projects",
  preferences: "preferences",
  decisions:   "decisions",
  clients:     "clients",
  entities:    "entities",
  lastRun:     "memextract_last",
};

// ── Throttle: run at most once every 5 minutes ───────────────────────────
function shouldRun() {
  const last = Storage.get(K.lastRun, 0);
  return Date.now() - last > 5 * 60 * 1000;
}

// ── Main extraction call ──────────────────────────────────────────────────
// Called after every AI reply. Runs silently in background.
export async function extractMemory(recentMessages) {
  if (!shouldRun()) return;
  if (!recentMessages?.length) return;

  // Only look at last 10 messages to keep it cheap
  const snippet = recentMessages
    .slice(-10)
    .map(m => `${m.role === "user" ? "Joel" : "Flow"}: ${m.content}`)
    .join("\n");

  if (snippet.length < 100) return;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          {
            role: "system",
            content: `You are a structured data extractor. Extract facts from conversation snippets and return ONLY valid JSON. No explanation, no markdown, no backticks.`
          },
          {
            role: "user",
            content: `Extract structured facts from this conversation. Return a JSON object with these keys (only include keys where you found relevant info, leave others out):

{
  "projects": [{"name": "...", "description": "...", "stack": "...", "status": "...", "repo": "..."}],
  "preferences": [{"category": "coding|design|tools|workflow", "preference": "..."}],
  "decisions": [{"topic": "...", "decision": "...", "reason": "..."}],
  "clients": [{"name": "...", "business": "...", "notes": "..."}],
  "entities": [{"name": "...", "type": "tool|person|service|platform", "context": "..."}]
}

Conversation:
${snippet}

Return only the JSON object.`
          }
        ],
        max_tokens: 1000,  // was 600 — a busy 10-message snippet with several
                            // projects/decisions can genuinely need more room;
                            // if the JSON gets cut off mid-object, JSON.parse
                            // throws exactly the "Expected ',' or '}'" error
                            // flagged as unresolved in the handoff notes.
        _skipMemory: true  // prevent infinite loop
      })
    });

    if (!res.ok) return;
    const data = await res.json();
    // REAL, DEFENSIVE FIX: previously `data.reply || data.content || ""`
    // only protects against null/undefined/empty-string — if data.reply
    // somehow arrived as a non-string truthy value (an object, for
    // instance, from an upstream response-shape bug), it would pass this
    // check and then crash on raw.replace(...) below with exactly
    // "raw.replace is not a function". Explicit typeof check ensures raw
    // is always a real string before anything touches it.
    let raw = data.reply || data.content || "";
    if (typeof raw !== "string") raw = "";
    if (!raw) return;

    // Parse the extracted JSON. Real fix for the "Expected ',' or '}'"
    // parse error flagged as unresolved in the handoff notes: the previous
    // version assumed the ENTIRE response (after stripping ```json fences)
    // was valid JSON with nothing else around it. LLMs commonly add a
    // preamble ("Here's the extracted data:") or trailing note even when
    // told not to — that extra text isn't invalid JSON syntax by itself,
    // but it means JSON.parse() is being handed "some text {...} more text"
    // instead of just "{...}", which throws exactly this kind of error.
    // Fix: extract the outermost {...} substring specifically, ignoring
    // anything before/after it, rather than assuming the whole string is
    // clean.
    const clean = raw.replace(/```json|```/g, "").trim();
    const firstBrace = clean.indexOf("{");
    const lastBrace  = clean.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
      console.warn("[MemExtract] no JSON object found in response, skipping this cycle");
      return;
    }
    const jsonSlice = clean.slice(firstBrace, lastBrace + 1);

    let parsed;
    try {
      parsed = JSON.parse(jsonSlice);
    } catch (parseErr) {
      // Still failed even after isolating the {...} slice — this means the
      // JSON itself is genuinely malformed (e.g. truncated mid-object by
      // max_tokens, or the model produced invalid syntax), not just
      // wrapped in extra text. Log it clearly and skip this cycle rather
      // than crash — losing one extraction cycle is fine, since this runs
      // again in 5 minutes; crashing the whole chat flow over a background
      // memory task would not be.
      console.warn("[MemExtract] JSON.parse failed on isolated object:", parseErr.message, "— skipping this cycle. Raw snippet:", jsonSlice.slice(0, 200));
      return;
    }

    // Merge into existing stored facts (don't overwrite, accumulate)
    _merge(K.projects,    parsed.projects,    "name");
    _merge(K.preferences, parsed.preferences, "preference");
    _merge(K.decisions,   parsed.decisions,   "topic");
    _merge(K.clients,     parsed.clients,     "name");
    _merge(K.entities,    parsed.entities,    "name");

    Storage.set(K.lastRun, Date.now());

    // REAL FIX: previously this data lived ONLY in the browser's
    // localStorage (via the Storage wrapper) — Echo, running as a
    // separate Node process on Railway, had no way to read it at all.
    // Confirmed by checking: nothing anywhere in the codebase ever wrote
    // this data to the shared server-side KV that Echo's memGet reads
    // from. Pushing a copy here, under a distinct key name
    // (flow_shared_extracted_memory) so it's clearly a synced copy, not
    // confused with any browser-local key.
    try {
      const summary = getExtractedMemoryContext();
      if (summary) {
        await fetch("/api/memory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: "flow_shared_extracted_memory", value: { summary, updatedAt: Date.now() } }),
        });
      }
    } catch (e) {
      console.warn("[MemExtract] Failed to sync to shared KV (Echo won't see this update):", e.message);
    }
    console.log("[MemExtract] extraction complete");

  } catch(e) {
    // Silent fail — memory extraction is background, never blocks UX
    console.warn("[MemExtract] failed:", e.message);
  }
}

// Merge new items into stored array, deduplicating by key field
function _merge(storageKey, newItems, dedupeField) {
  if (!newItems?.length) return;
  const existing = Storage.get(storageKey, []);
  const map = {};

  // Index existing by dedupe field
  existing.forEach(item => {
    if (item[dedupeField]) map[item[dedupeField].toLowerCase()] = item;
  });

  // Merge new items (overwrite if same key, else add)
  newItems.forEach(item => {
    if (!item[dedupeField]) return;
    const key = item[dedupeField].toLowerCase();
    map[key] = { ...map[key], ...item, updatedAt: Date.now() };
  });

  // Keep latest 50 per category
  const merged = Object.values(map).slice(-50);
  Storage.set(storageKey, merged);
}

// ── Read extracted memory as a formatted context string ───────────────────
// Called by ai.js to inject into system prompt
export function getExtractedMemoryContext() {
  const projects    = Storage.get(K.projects,    []);
  const preferences = Storage.get(K.preferences, []);
  const decisions   = Storage.get(K.decisions,   []);
  const clients     = Storage.get(K.clients,     []);
  const entities    = Storage.get(K.entities,    []);

  const lines = [];

  if (projects.length) {
    lines.push("ACTIVE PROJECTS:");
    projects.slice(-8).forEach(p =>
      lines.push(`  • ${p.name}${p.stack ? ` [${p.stack}]` : ""}${p.status ? ` — ${p.status}` : ""}${p.repo ? ` (${p.repo})` : ""}`)
    );
  }

  if (clients.length) {
    lines.push("CLIENTS:");
    clients.slice(-6).forEach(c =>
      lines.push(`  • ${c.name}${c.business ? ` (${c.business})` : ""}${c.notes ? ` — ${c.notes}` : ""}`)
    );
  }

  if (decisions.length) {
    lines.push("DECISIONS MADE:");
    decisions.slice(-6).forEach(d =>
      lines.push(`  • ${d.topic}: ${d.decision}${d.reason ? ` (${d.reason})` : ""}`)
    );
  }

  if (preferences.length) {
    lines.push("JOEL'S PREFERENCES:");
    preferences.slice(-8).forEach(p =>
      lines.push(`  • [${p.category}] ${p.preference}`)
    );
  }

  if (entities.length) {
    lines.push("TOOLS / SERVICES JOEL USES:");
    entities.slice(-8).forEach(e =>
      lines.push(`  • ${e.name} (${e.type})${e.context ? ` — ${e.context}` : ""}`)
    );
  }

  return lines.length ? lines.join("\n") : null;
}

// ── Expose for brain UI (show what's been extracted) ─────────────────────
export function getExtractedMemory() {
  return {
    projects:    Storage.get(K.projects,    []),
    preferences: Storage.get(K.preferences, []),
    decisions:   Storage.get(K.decisions,   []),
    clients:     Storage.get(K.clients,     []),
    entities:    Storage.get(K.entities,    []),
  };
}

// ── Clear extracted memory ─────────────────────────────────────────────────
export function clearExtractedMemory() {
  Object.values(K).forEach(k => Storage.remove(k));
}
