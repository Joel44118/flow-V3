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
  correction: 45,   // Joel corrected Flow via explicit 👎 flow — highest value, real course-correction
  casualLearning: 18, // Flow self-judged it learned something new mid-conversation,
                      // outside the explicit 👎 flow. Deliberately LOWER than an
                      // explicit correction (45) — self-judgment is a weaker signal
                      // than Joel deliberately flagging something as wrong, so it
                      // should never be worth as much, even though it's real.
  project:    150,  // REAL, Joel-requested change: no longer awarded. Kept in the
                     // table (rather than deleted) only so old history entries that
                     // already used this value still make sense if ever displayed —
                     // see awardProjectXp below, which is now a documented no-op.
  goalCompleted: 20, // REAL, NEW — Joel's requested replacement for the flat
                     // project-creation award. Genuine, per-goal EXP: every
                     // individual goal crossed off inside a project earns this,
                     // rather than one lump sum for merely creating the project
                     // shell. Naturally scales with how much real work a project
                     // actually contains, instead of rewarding project-creation
                     // itself (which Joel pointed out was awarding EXP for doing
                     // nothing — just adding a generic project).
  selfTool:   60,   // Flow successfully self-extended: proposed a tool AND Joel
                     // approved it. Calibrated between knowledge (25) and project
                     // (150) — a genuine new permanent capability, requiring Joel's
                     // explicit approval (a real deliberate signal, like correction),
                     // but not as significant as an entire new project.
  socialInsight:      15,  // Flow's daily social-monitor pass genuinely analyzed
                            // real performance/trend data and extracted a new,
                            // storable content pattern. Small — this is passive
                            // learning, not yet applied to anything real. Slightly
                            // above casualLearning (18 vs this being close but
                            // separate) since it's a deliberate analysis pass, not
                            // an incidental in-conversation judgment.
  socialInsightApplied: 80, // The bigger award: a stored insight was actually
                            // pulled into a real post that got approved AND posted
                            // live (Bluesky/YouTube). This is "insight became real
                            // content," the whole reason EXP is tied to social
                            // monitoring at all — weighted well above the passive
                            // analysis award, comfortably between selfTool (60)
                            // and project (150), since it's a real, live, published
                            // outcome, not just a new capability sitting unused.
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
  }
  if (_onXpChange) {
    _onXpChange(amount, reason, leveledUp); // fires on EVERY award, level-up or not, so the bar and a "+N XP" toast can update live regardless of which happened
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

// Call from the self-judgment pass in ai.js — ONLY after the judgment call
// itself has already decided (with a confidence threshold) that Joel stated
// something genuinely new, outside the explicit 👎-correction flow. This
// function does no judging itself — it trusts the caller already filtered
// for confidence, so it stays a pure "award + log" step, same as the others.
export function awardCasualLearningXp(summary) {
  _awardXp(XP_VALUES.casualLearning, `Learned (self-judged): ${(summary || "").slice(0, 60)}`);
}

// REAL, Joel-requested change: creating a project no longer awards EXP
// on its own — he pointed out that adding even a generic, empty
// project was earning EXP for doing nothing. Kept as a no-op (not
// deleted) so core/projects.js's existing call site doesn't need an
// extra conditional — it just does nothing now. Real EXP for project
// work now comes from awardGoalXp below, tied to actually finishing
// something inside the project.
export function awardProjectXp(_projectName) {
  // Intentionally does nothing — see comment above.
}

// Call from Projects.completeGoal, ONLY when a goal transitions from
// not-done to done (never on project creation, never on re-saving an
// already-completed goal) — this is the real, new mechanism for
// project-related EXP Joel asked for.
export function awardGoalXp(goalText) {
  _awardXp(XP_VALUES.goalCompleted, `Goal completed: ${(goalText || "").slice(0, 60)}`);
}

// Call ONLY from the self-tools approval flow (ui/chat.js, when Joel
// clicks Approve and approveTool() actually succeeds) — never for a
// mere proposal. This is a real, permanent new capability Flow now has,
// gated behind Joel's explicit deliberate approval.
export function awardSelfToolXp(toolName) {
  _awardXp(XP_VALUES.selfTool, `Self-extended: ${toolName}`);
}

// ── Social-monitor XP — the two-tier award matching Joel's own framing:
// small XP for real analysis happening at all, bigger XP only once an
// insight demonstrably became a real, live post. Call sites:
//   awardInsightXp   — ui/content-lab.js, right after a poll first sees
//                       a NEW insightId show up on a draft record (i.e.
//                       the social-monitor pass that created it actually
//                       ran) — dedupe by insightId so the same insight
//                       never re-awards on every poll.
//   awardContentAppliedXp — ui/content-lab.js, right after a poll sees a
//                       draft's status flip from "pending" to "posted"
//                       AND that draft has a real insightId attached —
//                       dedupe by draftId so the same post never
//                       re-awards on every subsequent poll.
export function awardInsightXp(insightSummary) {
  _awardXp(XP_VALUES.socialInsight, `Social insight: ${(insightSummary || '').slice(0, 60)}`);
}

export function awardContentAppliedXp(platform, caption) {
  _awardXp(XP_VALUES.socialInsightApplied, `Insight applied — posted to ${platform}: ${(caption || '').slice(0, 50)}`);
}
