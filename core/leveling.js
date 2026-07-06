// core/leveling.js — Flow's XP / Level system
//
// WHAT THIS TRACKS, AND WHY EACH ONE COUNTS AS REAL LEARNING:
//   - New fact learned about Joel (Memory.addFact) — Flow now knows
//     something about Joel it didn't before.
//   - New knowledge-base entry saved (RAG.save) — Flow's reference
//     material genuinely grew.
//   - A correction after a 👎 (feedback.js) — the clearest, highest-value
//     signal there is: Joel told Flow it was wrong AND what right looks
//     like. Weighted heaviest of all four.
//   - A new project created (Projects.save, only on genuine creation,
//     not every edit) — Flow took on new scope to track.
//
// WHAT THIS DOES NOT DO, STATED PLAINLY: it does not compare Flow's
// actual capability against any other model (Claude Fable 5 or anything
// else). A local XP counter has no way to honestly measure that — it can
// only measure how much NEW, non-repeated information Flow has
// accumulated through real use. Level 100 means "extensively used and
// taught," not "smarter than a specific external model." Framing it as
// the former is honest; framing it as the latter would not be.
//
// THINGS FLOW ALREADY KNOWS DON'T ADD XP: every award function below
// checks for genuine novelty before granting anything — re-saving a fact
// with the same value, searching the knowledge base (vs. adding to it),
// or updating an existing project's minor fields all correctly grant
// zero XP. Only real, new information counts.
//
// XP CURVE — deliberately escalating, exactly as requested:
// XP required for level N = 50 * N^1.6
// Level 1 → 50 XP (a single good session)
// Level 10 → ~8,600 XP cumulative (a few weeks of real use)
// Level 50 → ~516,000 XP cumulative (many months)
// Level 100 → ~3,090,000 XP cumulative (a genuine long-term milestone)
// Each level asks meaningfully more than the last — never flat, never
// front-loaded.

const STORAGE_KEY = "flow_level_state";
const KV_KEY       = "flow_level_state";

const XP_VALUES = {
  fact:       12,   // a new fact learned about Joel
  knowledge:  25,   // a new knowledge-base entry
  correction: 45,   // Joel corrected Flow — highest value, real course-correction
  project:    150,  // a genuinely new project created
};

function xpForLevel(level) {
  return Math.round(50 * Math.pow(level, 1.6));
}

function _load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : { level: 0, xp: 0, totalXp: 0, history: [] };
  } catch (_) {
    return { level: 0, xp: 0, totalXp: 0, history: [] };
  }
}

function _save(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  // Best-effort cloud backup, same pattern as everything else in the
  // project — never blocks the UI, never throws if it fails.
  fetch("/api/memory", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: KV_KEY, value: state }),
  }).catch(() => {});
}

async function _loadFromCloudIfNewer(local) {
  try {
    const r = await fetch(`/api/memory?key=${KV_KEY}`);
    if (!r.ok) return local;
    const d = await r.json();
    // Re-read the CURRENT module state right before deciding, not the
    // snapshot passed in at call time — an award could have legitimately
    // happened during this fetch's round trip (e.g. Flow saved a fact
    // moments after boot). Comparing against the live _state rather than
    // a stale local variable prevents that real award from being
    // silently overwritten by an older cloud value.
    const current = _state;
    if (d.value && typeof d.value === "object" && (d.value.totalXp || 0) > (current.totalXp || 0)) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(d.value));
      return d.value;
    }
  } catch (_) {}
  return _state; // always return the live, current state — never a stale snapshot
}

let _state = _load();
let _onLevelUp = null; // set via initLeveling
let _onXpChange = null; // fires on every award, even without a level-up, so the bar visibly fills incrementally

export async function initLeveling(onLevelUp, onXpChange) {
  _onLevelUp = onLevelUp;
  _onXpChange = onXpChange;
  _state = await _loadFromCloudIfNewer(_state);
  return _state;
}

export function getLevelState() {
  const needed = xpForLevel(_state.level + 1);
  return {
    level:        _state.level,
    xp:           _state.xp,
    xpNeeded:     needed,
    percent:      Math.min(100, Math.round((_state.xp / needed) * 100)),
    totalXp:      _state.totalXp,
  };
}

// Core award function — every specific award below funnels through this,
// so level-up detection and persistence only live in one place.
function _awardXp(amount, reason) {
  if (amount <= 0) return; // zero-XP events (already-known info) never even reach here in practice, but guard anyway
  _state.xp += amount;
  _state.totalXp += amount;
  _state.history = [...(_state.history || []).slice(-49), { amount, reason, ts: Date.now() }];

  let leveledUp = false;
  let newLevel = _state.level;
  // A single big award (e.g. a project) can cross more than one level
  // threshold at once — loop rather than assume just one.
  while (_state.xp >= xpForLevel(_state.level + 1)) {
    _state.xp -= xpForLevel(_state.level + 1);
    _state.level += 1;
    newLevel = _state.level;
    leveledUp = true;
  }

  _save(_state);

  if (leveledUp && _onLevelUp) {
    _onLevelUp(newLevel, reason);
  } else if (_onXpChange) {
    _onXpChange();
  }
}

// ── Specific award functions — call these from the real signal sources ──

// Call from Memory.addFact's call site, but ONLY when the fact is
// genuinely new or its value actually changed — not on every call.
export function awardFactXp(key, newValue, previousValue) {
  if (previousValue !== undefined && previousValue === newValue) return; // no real change, no XP
  _awardXp(XP_VALUES.fact, `Learned: ${key}`);
}

// Call from RAG.save's call site — every save here is a genuine new or
// updated knowledge-base entry, which is real learning either way.
export function awardKnowledgeXp(title) {
  _awardXp(XP_VALUES.knowledge, `Knowledge base: ${title}`);
}

// Call specifically from the correction-recording path in feedback.js —
// the highest-value signal, since it's Joel directly teaching Flow the
// right answer after a wrong one.
export function awardCorrectionXp(topic) {
  _awardXp(XP_VALUES.correction, `Correction: ${(topic || "").slice(0, 40)}`);
}

// Call from Projects.save ONLY when idx === -1 (a genuinely new project,
// not an edit to an existing one).
export function awardProjectXp(projectName) {
  _awardXp(XP_VALUES.project, `New project: ${projectName}`);
}
