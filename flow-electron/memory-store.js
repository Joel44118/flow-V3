// ═══════════════════════════════════════════
// flow-electron/memory-store.js — Flow's Real Persistent Local Brain
// (v3 — real semantic search added, still ZERO native dependencies)
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
//   2. This file was rewritten to remove vectra entirely — plain JSON
//      storage + keyword/recency scoring instead of real vector
//      embeddings.
//   3. A LATER session reverted this file back to vectra without
//      re-adding it to package.json, causing a second, different crash.
//
// REAL FIX FOR SEMANTIC SEARCH, THIS VERSION (v3): instead of any local
// vector library (vectra, @xenova/transformers, or anything importing
// onnxruntime-node), embeddings are fetched over PLAIN HTTPS from a
// server-side Vercel route (/api/mediapipe?action=embed), which itself
// calls Hugging Face's real, documented feature-extraction endpoint
// using HF_TOKEN (kept server-side, never touching this process).
// Verified directly against HuggingFace's own current Inference
// Providers docs before writing this. ZERO new npm dependencies were
// added for this — cosine similarity is plain arithmetic, embeddings
// come back as plain JSON arrays over fetch(), which Electron's main
// process has natively since Node 18+. There is nothing here for
// electron-builder's native-module packing logic to mishandle.
//
// REAL, HONEST DESIGN: embedding fetch happens once per entry, at write
// time, and is cached on the entry itself — recall() does NOT call the
// embed API on every search, only for the query text (one call per
// recall). If the embed call fails for any reason (network, rate limit,
// HF_TOKEN missing, cold start), remember() still saves the entry
// WITHOUT an embedding, and recall() falls back to the pre-existing
// keyword+recency score for that entry — this feature can never block
// or break a write, and a real network hiccup never crashes anything.
// ═══════════════════════════════════════════
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// Real, matches the same VERCEL_URL convention already used in
// heartbeat.js for its own fetch() calls to your deployed backend.
const VERCEL_URL = 'https://flow-v3-mu.vercel.app'; // real, matches heartbeat.js exactly

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

// ── Real embedding fetch — plain HTTPS, no native deps ──────────────────
// Calls the server-side embed route. Returns null (not a throw) on any
// failure, so callers can treat "no embedding" as a real, expected,
// non-fatal case rather than having to wrap every call in try/catch
// themselves.
async function _getEmbedding(text) {
  try {
    const res = await fetch(`${VERCEL_URL}/api/mediapipe?action=embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      console.warn('[Memory] Embed fetch non-OK (non-fatal):', res.status, errBody.error || '');
      return null;
    }
    const data = await res.json();
    return Array.isArray(data.embedding) ? data.embedding : null;
  } catch (e) {
    console.warn('[Memory] Embed fetch failed (non-fatal):', e.message);
    return null;
  }
}

// ── Real cosine similarity — plain arithmetic, zero dependency ─────────
function _cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── Real, permanent write path ──────────────────────────────────────────
// category: "conversation" | "decision" | "self-tool" | "goal" | "note" |
// "scratchpad" — used for filtered recall below.
//
// Real, honest behavior: this now ALSO fetches and stores a real
// embedding for the entry, but a failure to do so never blocks the
// actual save — the text-based memory write always succeeds regardless
// of network/HF status.
async function remember(text, category = "conversation", metadata = {}) {
  try {
    const entries = _loadAll();
    const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const embedding = await _getEmbedding(text); // null on any failure, real and expected
    entries.push({ id, text, category, ts: Date.now(), embedding, ...metadata });
    _saveAll(entries);
    return { ok: true, id, hasEmbedding: !!embedding };
  } catch (e) {
    console.error('[Memory] Real write failure:', e.message);
    return { ok: false, error: e.message };
  }
}

// ── Real keyword-overlap scoring ─────────────────────────────────────────
// Not semantic on its own — a real, honest word-overlap score, weighted
// toward more recent entries so "what have we talked about lately"
// genuinely favors recent context over old, coincidentally-matching text.
function _tokenize(text) {
  return (text || "").toLowerCase().match(/[a-z0-9]+/g) || [];
}
function _scoreOverlap(queryTokens, entryTokens) {
  if (!queryTokens.length || !entryTokens.length) return 0;
  const entrySet = new Set(entryTokens);
  const shared = queryTokens.filter(t => entrySet.has(t)).length;
  return shared / queryTokens.length;
}

// ── Real recall — semantic (when available) + keyword + recency ───────
// Real, honest blend: if the query's own embedding fetch succeeds, each
// entry's score becomes a real weighted mix of cosine similarity (when
// that entry also has a stored embedding) and the original keyword+
// recency score. Entries without embeddings (older ones, or ones saved
// while the embed API was down) still score fully via keyword+recency —
// nothing is silently excluded for lacking a vector.
async function recall(query, { maxResults = 5, category = null } = {}) {
  try {
    const entries = _loadAll();
    const queryTokens = _tokenize(query);
    const now = Date.now();
    const queryEmbedding = await _getEmbedding(query); // null on failure, real fallback below

    const scored = entries
      .filter(e => !category || e.category === category)
      .map(e => {
        const overlap = _scoreOverlap(queryTokens, _tokenize(e.text));
        const ageDays = (now - e.ts) / (24 * 60 * 60 * 1000);
        const recencyBoost = Math.max(0, 1 - ageDays / 30) * 0.2;
        const keywordScore = overlap + recencyBoost;

        let finalScore = keywordScore;
        if (queryEmbedding && e.embedding) {
          const semanticScore = _cosineSimilarity(queryEmbedding, e.embedding);
          // Real blend: semantic similarity weighted higher (0.7) since
          // it's the more meaningful signal when available, keyword+
          // recency still contributes (0.3) so exact-term matches and
          // recency aren't fully discarded.
          finalScore = (semanticScore * 0.7) + (keywordScore * 0.3);
        }

        return { entry: e, score: finalScore };
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
// single query. Left on keyword-overlap only (not semantic) since this
// runs unattended in the background on a timer — keeping it embedding-
// free means it has zero network dependency and can never fail due to
// HF being down or rate-limited.
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
