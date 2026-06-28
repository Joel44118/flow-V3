// ═══════════════════════════════════════════
// core/cloud.js — Cloud memory sync
// Reads dirty flag from Memory module (no circular)
// ═══════════════════════════════════════════

const KEYS = {
  memory:  "flow_memory",
  profile: "flow_profile",
  facts:   "flow_facts",
  notes:   "flow_notes",
};

async function cloudGet(key) {
  try {
    const res  = await fetch(`/api/memory?key=${key}`);
    const data = await res.json();
    return data.value ?? null;
  } catch(_) { return null; }
}

async function cloudSet(key, value) {
  try {
    await fetch("/api/memory", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ key, value }),
    });
  } catch(_) {}
}

export async function loadFromCloud() {
  for (const [name, key] of Object.entries(KEYS)) {
    const cloud = await cloudGet(key);
    if (!cloud) continue;
    const localRaw = localStorage.getItem("flow_v3_" + name);
    const local    = localRaw ? JSON.parse(localRaw) : null;
    // Cloud wins if it has more history entries
    if (!local || (Array.isArray(cloud) && cloud.length >= (local?.length ?? 0))) {
      localStorage.setItem("flow_v3_" + name, JSON.stringify(cloud));
    }
  }
}

export async function syncToCloud() {
  for (const [name, key] of Object.entries(KEYS)) {
    const raw = localStorage.getItem("flow_v3_" + name);
    if (raw) await cloudSet(key, JSON.parse(raw));
  }
}

export function startAutoSync() {
  // Sync every 30s
  setInterval(syncToCloud, 30_000);

  // Sync on tab close
  window.addEventListener("beforeunload", () => {
    const payload = {};
    for (const [name, key] of Object.entries(KEYS)) {
      const raw = localStorage.getItem("flow_v3_" + name);
      if (raw) payload[key] = JSON.parse(raw);
    }
    navigator.sendBeacon("/api/memory", JSON.stringify({ bulk: payload }));
  });
}
