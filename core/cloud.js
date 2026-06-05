// ═══════════════════════════════════════════
// core/cloud.js — Cloud memory sync
//
// Syncs Flow's memory to Vercel KV so it
// persists across devices and deployments.
//
// Strategy:
//   - On boot: load from cloud → merge with localStorage
//   - On every message: save to localStorage immediately
//   - Every 30s (and on page close): sync to cloud
//   - Cloud is source of truth on fresh devices
// ═══════════════════════════════════════════

const KEYS = {
  memory:   "flow_memory",
  profile:  "flow_profile",
  facts:    "flow_facts",
  notes:    "flow_notes",
};

const SYNC_INTERVAL = 30_000; // 30 seconds
let   _dirty = false;         // true if local changes not yet synced

// ── Load from cloud ───────────────────────
async function cloudGet(key) {
  try {
    const res  = await fetch(`/api/memory?key=${key}`);
    const data = await res.json();
    return data.value ?? null;
  } catch(_) { return null; }
}

// ── Save to cloud ─────────────────────────
async function cloudSet(key, value) {
  try {
    await fetch("/api/memory", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ key, value }),
    });
  } catch(_) {} // silent — localStorage is always the backup
}

// ── Boot: load cloud memory into localStorage ──
export async function loadFromCloud() {
  console.log("[Flow Cloud] Loading memory...");
  let loaded = false;

  for (const [name, key] of Object.entries(KEYS)) {
    const cloud = await cloudGet(key);
    if (!cloud) continue;

    // Merge strategy: cloud wins for history (more complete),
    // but never overwrite if local is newer
    const local = JSON.parse(localStorage.getItem("flow_v3_" + name) || "null");

    if (!local || _isCloudNewer(cloud, local, name)) {
      localStorage.setItem("flow_v3_" + name, JSON.stringify(cloud));
      loaded = true;
      console.log(`[Flow Cloud] Loaded ${name} from cloud`);
    }
  }

  return loaded;
}

function _isCloudNewer(cloud, local, name) {
  // For arrays (memory), cloud is newer if it has more entries
  if (Array.isArray(cloud) && Array.isArray(local)) {
    return cloud.length >= local.length;
  }
  return false;
}

// ── Sync local → cloud ────────────────────
export async function syncToCloud() {
  if (!_dirty) return;
  console.log("[Flow Cloud] Syncing...");

  for (const [name, key] of Object.entries(KEYS)) {
    const raw = localStorage.getItem("flow_v3_" + name);
    if (raw) await cloudSet(key, JSON.parse(raw));
  }

  _dirty = false;
  console.log("[Flow Cloud] Sync complete");
}

// ── Mark dirty (call after every message save) ──
export function markDirty() { _dirty = true; }

// ── Auto-sync every 30s + on page close ──────
export function startAutoSync() {
  setInterval(syncToCloud, SYNC_INTERVAL);

  // Sync before tab closes
  window.addEventListener("beforeunload", () => {
    if (!_dirty) return;
    // Use sendBeacon for reliable fire-and-forget on close
    const payload = {};
    for (const [name, key] of Object.entries(KEYS)) {
      const raw = localStorage.getItem("flow_v3_" + name);
      if (raw) payload[key] = JSON.parse(raw);
    }
    navigator.sendBeacon("/api/memory-bulk",
      JSON.stringify(payload)
    );
  });
}