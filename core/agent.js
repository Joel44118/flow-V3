// ═══════════════════════════════════════════
// core/agent.js — Phase 4 Agent Mode system
//
// Agents are persistent specialist modes that
// inject deep context into EVERY prompt until
// deactivated. Unlike skills (per-message),
// agents stay active across the whole session.
//
// No imports from commands.js, ai.js, or cloud.js
// — keeps the module graph clean.
// ═══════════════════════════════════════════
import { Storage } from "./storage.js";

// ── Agent definitions ─────────────────────────────────────────────────────
export const AGENTS = {
  coding: {
    id:    "coding",
    name:  "Coding Agent",
    icon:  "💻",
    color: "#38bdf8",
    file:  "/skills/agent_coding.md",
    activationRx: /\b(coding\s*agent|code\s*mode|dev\s*mode|developer\s*mode|enter\s*coding|coding\s*specialist)\b/i,
    deactivationRx: /\b(exit|stop|leave|end|deactivate|turn\s*off)\s*(coding\s*)?(agent|mode)\b/i,
  },
  research: {
    id:    "research",
    name:  "Research Agent",
    icon:  "🔬",
    color: "#a78bfa",
    file:  "/skills/agent_research.md",
    activationRx: /\b(research\s*agent|research\s*mode|analyst\s*mode|enter\s*research|deep\s*research\s*mode)\b/i,
    deactivationRx: /\b(exit|stop|leave|end|deactivate|turn\s*off)\s*(research\s*)?(agent|mode)\b/i,
  },
  content: {
    id:    "content",
    name:  "Content Agent",
    icon:  "✍️",
    color: "#34d399",
    file:  "/skills/agent_content.md",
    activationRx: /\b(content\s*agent|content\s*mode|writer\s*mode|creative\s*mode|enter\s*content|copywriter\s*mode)\b/i,
    deactivationRx: /\b(exit|stop|leave|end|deactivate|turn\s*off)\s*(content\s*)?(agent|mode)\b/i,
  },
  business: {
    id:    "business",
    name:  "Business Agent",
    icon:  "📈",
    color: "#fb923c",
    file:  "/skills/agent_business.md",
    activationRx: /\b(business\s*agent|business\s*mode|ceo\s*mode|strategy\s*mode|enter\s*business|growth\s*mode)\b/i,
    deactivationRx: /\b(exit|stop|leave|end|deactivate|turn\s*off)\s*(business\s*)?(agent|mode)\b/i,
  },
};

// ── State ─────────────────────────────────────────────────────────────────
let _activeId      = Storage.get("agent_active", null);
let _activeContent = null; // cached .md file content
let _onChangeFn    = null; // UI callback

// ── Load agent skill file ─────────────────────────────────────────────────
async function _loadFile(agent) {
  try {
    const res = await fetch(agent.file);
    if (!res.ok) throw new Error(res.status);
    return await res.text();
  } catch (e) {
    console.warn(`[Agent] Failed to load ${agent.file}:`, e.message);
    return null;
  }
}

// ── Activate an agent ─────────────────────────────────────────────────────
export async function activateAgent(id) {
  const agent = AGENTS[id];
  if (!agent) return false;
  _activeId      = id;
  _activeContent = await _loadFile(agent);
  Storage.set("agent_active", id);
  _onChangeFn?.(agent);
  console.log(`[Agent] Activated: ${agent.name}`);
  return agent;
}

// ── Deactivate current agent ──────────────────────────────────────────────
export function deactivateAgent() {
  _activeId      = null;
  _activeContent = null;
  Storage.remove("agent_active");
  _onChangeFn?.(null);
  console.log("[Agent] Deactivated");
}

// ── Get active agent context for prompt injection ─────────────────────────
export function getAgentContext() {
  if (!_activeId || !_activeContent) return null;
  const agent = AGENTS[_activeId];
  return { id: _activeId, name: agent.name, icon: agent.icon, content: _activeContent };
}

// ── Get active agent object ───────────────────────────────────────────────
export function getActiveAgent() {
  return _activeId ? AGENTS[_activeId] : null;
}

// ── Register UI change callback ───────────────────────────────────────────
export function onAgentChange(fn) { _onChangeFn = fn; }

// ── Parse text for agent activation/deactivation ─────────────────────────
// Returns { action: "activate"|"deactivate"|null, id }
export function parseAgentCommand(text) {
  // Check deactivation first
  for (const agent of Object.values(AGENTS)) {
    if (agent.deactivationRx.test(text)) return { action: "deactivate", id: agent.id };
  }
  // Check activation
  for (const agent of Object.values(AGENTS)) {
    if (agent.activationRx.test(text)) return { action: "activate", id: agent.id };
  }
  // Generic: "exit agent mode"
  if (/\b(exit|stop|leave|end)\s*(agent|mode)\b/i.test(text)) return { action: "deactivate", id: null };
  return { action: null, id: null };
}

// ── Restore persisted agent on boot ──────────────────────────────────────
export async function restoreAgent() {
  if (_activeId && AGENTS[_activeId]) {
    _activeContent = await _loadFile(AGENTS[_activeId]);
    console.log(`[Agent] Restored: ${AGENTS[_activeId].name}`);
  }
}
