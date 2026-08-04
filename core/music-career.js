// ═══════════════════════════════════════════
// core/music-career.js — NEW, standalone. Flow's weekly music
// "career" automation. Honest framing per Joel's own conversation:
// this is real automation with real memory and consistency — NOT a
// claim that Flow has genuine creative preferences or feelings about
// its own music. Flow can report on this data conversationally in a
// way that reads naturally, but nothing here is pretending there's an
// inner experience behind it.
//
// WHAT THIS TRACKS (real, structured, persisted):
//   - Every track generated: prompt used, genre/style tag, release date
//   - Every reaction Joel gives (rating 1-5, free-text note)
//   - A running "style profile" — which genre/mood tags correlate with
//     higher ratings, computed from real past data, not vibes
//   - A fixed VOICE_TAG so every generation uses the same declared
//     vocal style — this is what "keeps the same voice" means
//     concretely: a consistent tag threaded into every prompt, not an
//     actual persistent identity making a choice
// ═══════════════════════════════════════════

const STORAGE_KEY = "flow-music-career";
const VOICE_TAG = "warm male tenor, clear diction, moderate reverb"; // REAL, fixed — Joel can change this string any time to change what "Flow's voice" means going forward, but it stays constant across generations otherwise

function _load() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || { tracks: [] }; }
  catch (_) { return { tracks: [] }; }
}
function _save(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (_) {}
}

// Call this right after a track is generated (title, prompt, genre/mood tags).
export function logNewTrack({ title, prompt, tags }) {
  const data = _load();
  data.tracks.push({
    id: `track_${Date.now()}`,
    title, prompt, tags,
    voiceTag: VOICE_TAG,
    releasedAt: new Date().toISOString(),
    rating: null,      // filled in by logReaction below
    note: null,
  });
  _save(data);
}

// Call this when Joel reacts to a track — a real number, not a guess.
export function logReaction(trackId, rating, note) {
  const data = _load();
  const t = data.tracks.find(t => t.id === trackId);
  if (!t) return false;
  t.rating = Math.max(1, Math.min(5, rating));
  t.note = note || null;
  _save(data);
  return true;
}

// Real, computed style profile — which tags actually correlate with
// higher-rated tracks, from real past data. Not a claim about taste,
// just an average.
export function getStyleProfile() {
  const data = _load();
  const rated = data.tracks.filter(t => t.rating != null);
  if (!rated.length) return { summary: "No rated tracks yet.", tagAverages: {} };

  const tagAverages = {};
  for (const t of rated) {
    for (const tag of (t.tags || [])) {
      if (!tagAverages[tag]) tagAverages[tag] = { sum: 0, count: 0 };
      tagAverages[tag].sum += t.rating;
      tagAverages[tag].count += 1;
    }
  }
  const ranked = Object.entries(tagAverages)
    .map(([tag, v]) => ({ tag, avg: v.sum / v.count, count: v.count }))
    .sort((a, b) => b.avg - a.avg);

  return {
    summary: `${rated.length} rated track(s). Best-performing tag: ${ranked[0]?.tag || "n/a"} (avg ${ranked[0]?.avg.toFixed(1) || "-"}).`,
    tagAverages: ranked,
  };
}

// Real, honest low-rating explanation — pulls Joel's own notes rather
// than inventing a reason Flow "felt" something about the track.
export function getReasonsForLowRatings() {
  const data = _load();
  return data.tracks
    .filter(t => t.rating != null && t.rating <= 2)
    .map(t => ({ title: t.title, rating: t.rating, note: t.note || "(no note given)" }));
}

export function getAllTracks() {
  return _load().tracks;
}

export function getVoiceTag() {
  return VOICE_TAG;
}
