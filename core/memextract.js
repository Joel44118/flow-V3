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
        max_tokens: 600,
        _skipMemory: true  // prevent infinite loop
      })
    });

    if (!res.ok) return;
    const data = await res.json();
    const raw  = data.reply || data.content || "";
    if (!raw) return;

    // Parse the extracted JSON
    const clean   = raw.replace(/```json|```/g, "").trim();
    const parsed  = JSON.parse(clean);

    // Merge into existing stored facts (don't overwrite, accumulate)
    _merge(K.projects,    parsed.projects,    "name");
    _merge(K.preferences, parsed.preferences, "preference");
    _merge(K.decisions,   parsed.decisions,   "topic");
    _merge(K.clients,     parsed.clients,     "name");
    _merge(K.entities,    parsed.entities,    "name");

    Storage.set(K.lastRun, Date.now());
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
