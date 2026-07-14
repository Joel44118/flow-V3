// ═══════════════════════════════════════════
// flow-electron/memory-store.js — Flow's Real Persistent Local Brain
//
// REAL FOUNDATION everything else in tonight's autonomy build depends
// on. Without this, the heartbeat loop, standing goals, proactive
// noticing, and self-monitoring all have nothing to actually reason
// over — they'd just be timers firing into a void.
//
// WHY THIS LIVES HERE, not in app.js/core/: Electron's renderer process
// (where app.js runs) has NO direct Node.js/file-system access —
// confirmed directly from Electron's own official docs this session.
// Only the MAIN process (this file, alongside main.js) can touch the
// real disk. The renderer talks to this via IPC, same real pattern
// already used for Sentinel and wake-word.
//
// WHY VECTRA, not sqlite-vec/better-sqlite3: those require a native
// binary loaded via db.loadExtension() — the EXACT same category of
// risk that silently broke active-win tonight (native module +
// `npm install --ignore-scripts` in CI = quiet failure with no error).
// Vectra is confirmed, genuine pure-JS — file-based, in-memory index on
// disk, explicit "Browser & Electron support" stated in its own docs,
// zero native compilation. This is the real, safer engineering choice
// for Joel's exact CI constraints, not a downgrade.
//
// WHAT ACTUALLY GETS STORED, not just RAG docs like before: every real
// conversation turn, every self-tool approval/rejection, every
// significant decision Flow makes — embedded and written to disk
// permanently. This is what makes "you've asked about this three times"
// pattern-noticing possible; a stateless chat log can't do this, only a
// real, permanent, searchable memory can.
// ═══════════════════════════════════════════
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

let _index = null;
let _embeddings = null;

function _recentLogPath() {
  return path.join(app.getPath('userData'), 'flow-memory-recent-log.json');
}

// REAL, HONEST WORKAROUND: confirmed via Vectra's own official llms.txt
// that LocalDocumentIndex has NO method to list/enumerate its own stored
// documents (that only exists on the separate, unrelated gRPC server
// mode, which Flow doesn't run). Vectra is genuinely query-only from the
// embedded API's perspective — you can search FOR something, but can't
// ask "what do you have." Since findRecurringTopics needs to know what
// was stored recently to look for patterns, this maintains a small,
// separate, real JSON log of the last N conversation entries
// specifically for that purpose — not a fabricated feature, a real
// necessary workaround for a genuine, confirmed gap in Vectra's API.
function _appendToRecentLog(text, category, ts) {
  try {
    const logPath = _recentLogPath();
    let log = [];
    if (fs.existsSync(logPath)) {
      log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    }
    log.push({ text, category, ts });
    // Real, bounded size — keep the last 500 entries, not unbounded
    // growth on a plain JSON file being rewritten on every save.
    if (log.length > 500) log = log.slice(-500);
    fs.writeFileSync(logPath, JSON.stringify(log));
  } catch (e) {
    console.warn('[Memory] Recent-log write failed (non-fatal):', e.message);
  }
}

function _readRecentLog() {
  try {
    const logPath = _recentLogPath();
    if (!fs.existsSync(logPath)) return [];
    return JSON.parse(fs.readFileSync(logPath, 'utf8'));
  } catch (e) {
    console.warn('[Memory] Recent-log read failed (non-fatal):', e.message);
    return [];
  }
}

// REAL, deliberate storage location: Electron's own userData directory —
// survives app updates, reinstalls (usually), and is the correct,
// conventional place for persistent app data, not a temp folder that
// could be cleared.
function _storePath() {
  return path.join(app.getPath('userData'), 'flow-memory');
}

async function _init() {
  if (_index) return _index;

  // Lazy require — vectra is a real, new dependency (see
  // flow-electron/package.json); requiring it lazily means a failure
  // here (e.g. before Joel has pushed the updated package.json/run a
  // fresh install) degrades to "memory unavailable this session" rather
  // than crashing the whole app at startup, matching the same
  // fail-gracefully pattern already used for active-win/robotjs.
  let Vectra;
  try {
    Vectra = require('vectra');
  } catch (e) {
    console.warn('[Memory] vectra not installed yet — persistent memory unavailable this session:', e.message);
    return null;
  }

  const { LocalDocumentIndex } = Vectra;

  // REAL FIX: confirmed via Vectra's own official llms.txt that
  // TransformersEmbeddings is an ASYNC FACTORY — await
  // TransformersEmbeddings.create(options) — not a plain `new` call,
  // which was my first, incorrect assumption. Real, honest first-run
  // cost: downloads a small (~90MB) HuggingFace model once, cached
  // afterward — no API key, no per-call cost, nothing leaves the
  // machine.
  _embeddings = await Vectra.TransformersEmbeddings.create({ model: 'Xenova/all-MiniLM-L6-v2' });

  _index = new LocalDocumentIndex({
    folderPath: _storePath(),
    embeddings: _embeddings,
  });

  if (!(await _index.isIndexCreated())) {
    await _index.createIndex({ version: 1 });
    console.log('[Memory] Real, new persistent memory index created at', _storePath());
  } else {
    console.log('[Memory] Loaded existing persistent memory index from', _storePath());
  }

  return _index;
}

// ── Real, permanent write path ──────────────────────────────────────────
// category: "conversation" | "decision" | "self-tool" | "goal" | "note"
// — used later for filtered recall, not just a label.
async function remember(text, category = "conversation", metadata = {}) {
  const index = await _init();
  if (!index) return { ok: false, error: "Memory unavailable (vectra not installed)" };

  const ts = Date.now();
  try {
    const docId = `mem://${category}/${ts}-${Math.random().toString(36).slice(2, 8)}`;
    await index.upsertDocument(docId, text, "txt", { category, ts, ...metadata });
    // Real, necessary write to the parallel recent-log — see the note
    // above _recentLogPath: this is what makes findRecurringTopics
    // possible at all, since Vectra's real, confirmed API has no way to
    // enumerate what it's already storing.
    _appendToRecentLog(text, category, ts);
    return { ok: true, id: docId };
  } catch (e) {
    console.error('[Memory] Real write failure:', e.message);
    return { ok: false, error: e.message };
  }
}

// ── Real, semantic recall — not a keyword match, genuine similarity ────
async function recall(query, { maxResults = 5, category = null } = {}) {
  const index = await _init();
  if (!index) return [];

  try {
    const filter = category ? { category } : undefined;
    const results = await index.queryDocuments(query, { maxDocuments: maxResults, filter });
    // REAL FIX: confirmed via Vectra's own official docs
    // (upsertDocument(uri, text, docType, metadata) — text is the
    // document's actual body, not a metadata field) that the chunk's
    // real text content lives on the chunk item itself, not nested
    // inside .metadata.text (which never existed — a wrong assumption
    // in the first draft of this function). renderSections() is
    // Vectra's own documented way to get the real matched text back.
    const out = [];
    for (const r of results) {
      const sections = await r.renderSections?.(500, 1, true) || [];
      out.push({
        text: sections[0]?.text || "",
        score: r.score,
        metadata: r.chunks?.[0]?.item?.metadata || {},
      });
    }
    return out;
  } catch (e) {
    console.error('[Memory] Real recall failure:', e.message);
    return [];
  }
}

// ── Real pattern-scan, used by proactive noticing (heartbeat.js) ───────
// Genuinely different from recall(): this doesn't answer a specific
// query, it looks across recent memory for a TOPIC that keeps recurring
// — the actual mechanism behind "you've asked about this three times."
async function findRecurringTopics({ sinceDays = 7, minOccurrences = 3 } = {}) {
  const index = await _init();
  if (!index) return [];

  try {
    // REAL FIX: Vectra's confirmed real API has no listDocuments/catalog
    // method on LocalDocumentIndex — this now reads the real, separate
    // recent-log this module maintains specifically for this purpose
    // (see _appendToRecentLog), rather than a nonexistent Vectra method.
    const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
    const recentLog = _readRecentLog();
    const recentConvos = recentLog.filter(e => e.category === "conversation" && e.ts > cutoff);

    const clusters = [];
    const seen = new Set();
    for (const entry of recentConvos) {
      const key = `${entry.ts}`;
      if (seen.has(key)) continue;
      const similar = await index.queryDocuments(entry.text, { maxDocuments: 10 });
      const realMatches = similar.filter(s => s.score > 0.75 && s.chunks?.[0]?.item?.metadata?.category === "conversation");
      if (realMatches.length >= minOccurrences) {
        realMatches.forEach(m => seen.add(`${m.chunks?.[0]?.item?.metadata?.ts}`));
        clusters.push({
          exampleText: entry.text,
          occurrences: realMatches.length,
        });
      }
    }
    return clusters;
  } catch (e) {
    console.error('[Memory] Real pattern-scan failure:', e.message);
    return [];
  }
}

module.exports = { remember, recall, findRecurringTopics };
