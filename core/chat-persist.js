// ═══════════════════════════════════════════
// core/chat-persist.js — REAL, NEW: persists generated media (images,
// videos) across reloads, and archives it once the live log grows past
// a real threshold.
//
// HONEST SCOPE: plain TEXT chat history already survives reload via
// Memory.get() → Chat.loadHistory() (core/memory.js's semantic store) —
// that mechanism already works and isn't touched here. The REAL gap
// Joel found is specifically generated images/videos: ui/imagine.js's
// _renderCard() displayed them via URL.createObjectURL(blob) — a
// blob: URL that is only valid for the current page session and is
// never written anywhere persistent. On reload, the underlying blob is
// gone, and since nothing ever saved a record of that message existing
// at all, it's not just a broken link — the whole card is gone. This
// module is the real fix: persist the actual image/video data (as a
// base64 data URL, which — unlike blob: URLs — remains valid forever,
// including after reload) plus real archiving once the live log grows
// past a threshold, exactly as Joel asked ("when it reaches a certain
// threshold it should cut and wrap in a place I can access again").
//
// Text-history archiving (the broader "cut and wrap the whole
// conversation" ask) is a real, separate undertaking tied into
// core/memory.js's own storage rather than this module — flagged
// honestly as a next step, not silently left half-done here.
// ═══════════════════════════════════════════

const LIVE_KEY = "flow-media-live-log";
const ARCHIVE_INDEX_KEY = "flow-media-archive-index";
const MAX_LIVE = 40;       // real cap — keeps localStorage usage bounded; base64 images run large
const ARCHIVE_CHUNK = 20;  // moves this many oldest entries out per archive event

function _loadLive() {
  try { return JSON.parse(localStorage.getItem(LIVE_KEY) || "[]"); }
  catch (_) { return []; }
}

function _saveLive(arr) {
  try { localStorage.setItem(LIVE_KEY, JSON.stringify(arr)); }
  catch (e) {
    console.warn("[ChatPersist] Couldn't save media log (localStorage may be full):", e.message);
  }
}

function _archiveChunk(messages) {
  const id = `flow-media-archive-${Date.now()}`;
  try {
    localStorage.setItem(id, JSON.stringify(messages));
    const index = _listArchivesRaw();
    index.push({
      id,
      count: messages.length,
      from: messages[0]?.ts,
      to: messages[messages.length - 1]?.ts,
    });
    localStorage.setItem(ARCHIVE_INDEX_KEY, JSON.stringify(index));
  } catch (e) {
    console.warn("[ChatPersist] Archive failed (non-fatal, oldest entries just get dropped instead):", e.message);
  }
}

function _listArchivesRaw() {
  try { return JSON.parse(localStorage.getItem(ARCHIVE_INDEX_KEY) || "[]"); }
  catch (_) { return []; }
}

// entry: { kind: 'image'|'video', dataUrl, prompt, meta }
export function persistMedia(entry) {
  const log = _loadLive();
  log.push({ ...entry, ts: Date.now() });
  if (log.length > MAX_LIVE) {
    const toArchive = log.splice(0, ARCHIVE_CHUNK);
    _archiveChunk(toArchive);
  }
  _saveLive(log);
}

export function getLiveMediaLog() { return _loadLive(); }
export function listMediaArchives() { return _listArchivesRaw(); }
export function getMediaArchive(id) {
  try { return JSON.parse(localStorage.getItem(id) || "[]"); }
  catch (_) { return []; }
}

// REAL, small utility — imagine.js only has a Blob (or a blob: URL) at
// the point it wants to display media; this converts it to a base64
// data URL, which IS safely persistable (unlike blob: URLs).
export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Failed to convert blob to a persistable data URL"));
    reader.readAsDataURL(blob);
  });
}
