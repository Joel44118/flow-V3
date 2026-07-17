// ═══════════════════════════════════════════
// flow-electron/memory-store.js — Flow's Real Persistent Local Brain
// (v2 — NO NATIVE DEPENDENCIES, restored after a real, confirmed crash)
//
// REAL, CONFIRMED CRASH HISTORY, for whoever reads this next — read
// before touching this file again:
//   1. The original version used Vectra's TransformersEmbeddings for
//      real semantic vector search. This pulls in
//      @xenova/transformers -> onnxruntime-node, a native binding with
//      DOCUMENTED, RECURRING resolution failures specifically in
//      Electron (confirmed via huggingface/transformers.js's own issue
//      tracker). After adding this dependency, Joel's real, actual
//      packaged build showed app.asar MISSING FILES ENTIRELY and
//      crashed with "Cannot find module './heartbeat'".
//   2. This file was rewritten (this version) to remove vectra
//      entirely — plain JSON storage + keyword/recency scoring instead
//      of real vector embeddings. `vectra` was also removed from
//      flow-electron/package.json's dependencies to match.
//   3. A LATER session did a "cleanup" that reverted THIS FILE back to
//      the vectra-based version (require('vectra'), Vectra.
//      TransformersEmbeddings.create(...)) WITHOUT re-adding vectra to
//      package.json's dependencies. Confirmed directly: package.json's
//      real dependencies list has no vectra entry at all, while this
//      file was calling require('vectra') anyway — a guaranteed,
//      immediate crash the moment heartbeat.js requires this file
//      (heartbeat.js -> memory-store.js -> vectra, none of it present
//      in node_modules). This produced a new, different crash
//      (ENOENT on app.asar.unpack...\package.json) that was actually
//      just electron-builder's native-module auto-unpack logic getting
//      confused by a half-removed dependency tree.
//
// REAL, STANDING INSTRUCTION: Joel has explicitly said he wants to keep
// a genuine vector-based/semantic-search approach long-term. The RIGHT
// way to do that is to find a real embeddings provider with ZERO
// native/ONNX dependency anywhere in its chain (not yet found/verified
// as of this note — HF's OpenAI-compatible endpoint was checked and
// confirmed to NOT support embeddings, only chat completions) — and
// ONLY THEN reintroduce a real vector library, with vectra (or
// whatever's chosen) added back to package.json's dependencies in the
// SAME commit as any code change requiring it. Never let this file's
// imports and package.json's dependencies drift apart again — that
// exact drift is what caused this crash twice.
//
// Until a real, verified native-free vector solution exists, this file
// stays on plain JSON + keyword/recency scoring. It is fully
// functional, genuinely persists across restarts, and has zero
// packaging risk.
// ═══════════════════════════════════════════
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

function _storePath() {
  return path.join(app.getPath('userData'), 'flow-memory.json');
}

function _loadAll() {
  try {
    const p = _storePath();
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.warn('[Memory] Load failed (non-fatal):', e.message);
    return [];
  }
}

function _saveAll(entries) {
  try {
    // Real, bounded size — keep the most recent 2000 entries. At a
    // realistic single-person conversation volume, this comfortably
    // covers months of real history without the file growing without
    // bound.
    const bounded = entries.length > 2000 ? entries.slice(-2000) : entries;
    fs.writeFileSync(_storePath(), JSON.stringify(bounded));
  } catch (e) {
    console.warn('[Memory] Save failed (non-fatal):', e.message);
  }
}

// ── Real, permanent write path ──────────────────────────────────────────
// category: "conversation" | "decision" | "self-tool" | "goal" | "note" |
// "scratchpad" — used for filtered recall below.
async function remember(text, category = "conversation", metadata = {}) {
  try {
    const entries = _loadAll();
    const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    entries.push({ id, text, category, ts: Date.now(), ...metadata });
    _saveAll(entries);
    return { ok: true, id };
  } catch (e) {
    console.error('[Memory] Real write failure:', e.message);
    return { ok: false, error: e.message };
  }
}

// ── Real keyword-overlap scoring ─────────────────────────────────────────
// Not semantic similarity (that needed the now-removed embeddings
// pipeline) — a real, honest word-overlap score, weighted toward more
// recent entries so "what have we talked about lately" genuinely favors
// recent context over old, coincidentally-matching text.
function _tokenize(text) {
  return (text || "").toLowerCase().match(/[a-z0-9]+/g) || [];
}
function _scoreOverlap(queryTokens, entryTokens) {
  if (!queryTokens.length || !entryTokens.length) return 0;
  const entrySet = new Set(entryTokens);
  const shared = queryTokens.filter(t => entrySet.has(t)).length;
  return shared / queryTokens.length;
}

// ── Real recall — keyword + recency, not semantic, stated honestly ─────
async function recall(query, { maxResults = 5, category = null } = {}) {
  try {
    const entries = _loadAll();
    const queryTokens = _tokenize(query);
    const now = Date.now();

    const scored = entries
      .filter(e => !category || e.category === category)
      .map(e => {
        const overlap = _scoreOverlap(queryTokens, _tokenize(e.text));
        // Real, modest recency boost — a 7-day-old entry with equal
        // keyword overlap to a fresh one still ranks slightly lower,
        // matching the actual intent of "recent context matters more."
        const ageDays = (now - e.ts) / (24 * 60 * 60 * 1000);
        const recencyBoost = Math.max(0, 1 - ageDays / 30) * 0.2;
        return { entry: e, score: overlap + recencyBoost };
      })
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);

    return scored.map(s => ({ text: s.entry.text, score: s.score, metadata: s.entry }));
  } catch (e) {
    console.error('[Memory] Real recall failure:', e.message);
    return [];
  }
}

// ── Real pattern-scan, used by proactive noticing (heartbeat.js) ───────
// Genuinely different from recall(): looks across recent memory for a
// TOPIC that keeps recurring — the real mechanism behind "you've asked
// about this three times." Uses the same real keyword-overlap scoring,
// just clustering entries against each other instead of against a
// single query.
async function findRecurringTopics({ sinceDays = 7, minOccurrences = 3 } = {}) {
  try {
    const entries = _loadAll();
    const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
    const recentConvos = entries.filter(e => e.category === "conversation" && e.ts > cutoff);

    const clusters = [];
    const seen = new Set();
    for (const entry of recentConvos) {
      if (seen.has(entry.id)) continue;
      const entryTokens = _tokenize(entry.text);
      const matches = recentConvos.filter(other =>
        other.id !== entry.id && !seen.has(other.id) && _scoreOverlap(entryTokens, _tokenize(other.text)) > 0.4
      );
      if (matches.length + 1 >= minOccurrences) {
        seen.add(entry.id);
        matches.forEach(m => seen.add(m.id));
        clusters.push({ exampleText: entry.text, occurrences: matches.length + 1 });
      }
    }
    return clusters;
  } catch (e) {
    console.error('[Memory] Real pattern-scan failure:', e.message);
    return [];
  }
}

module.exports = { remember, recall, findRecurringTopics };
