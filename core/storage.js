// core/storage.js (v2) — localStorage + Supabase cloud sync
// Supabase free tier: 500MB PostgreSQL, unlimited reads, 2GB bandwidth
//
// SETUP (one time, 2 minutes):
// 1. Go to supabase.com → New project (free)
// 2. Project Settings → API → copy "Project URL" and "anon public" key
// 3. In Vercel → Settings → Environment Variables add:
//    VITE_SUPABASE_URL = your project URL
//    VITE_SUPABASE_KEY = your anon key
// 4. In Supabase → SQL Editor, run:
//    CREATE TABLE flow_data (key text PRIMARY KEY, value jsonb, updated_at timestamptz DEFAULT now());
//    ALTER TABLE flow_data ENABLE ROW LEVEL SECURITY;
//    CREATE POLICY "public read write" ON flow_data FOR ALL USING (true) WITH CHECK (true);
// That's it — Flow will sync automatically

const PFX = 'flow_';

// Supabase config — reads from meta tags injected by Vercel (client-safe)
// These are PUBLIC keys (anon), safe to expose in frontend code
let _sbUrl = null;
let _sbKey = null;

async function _initSB() {
  if (_sbUrl) return !!_sbUrl;
  try {
    // Try to get Supabase config from our API endpoint
    const r = await fetch('/api/memory?key=__sb_config');
    if (r.ok) {
      const d = await r.json();
      if (d.value?.url) {
        _sbUrl = d.value.url;
        _sbKey = d.value.key;
        return true;
      }
    }
  } catch(_) {}
  return false;
}

async function _sbGet(key) {
  if (!_sbUrl) return null;
  try {
    const r = await fetch(
      `${_sbUrl}/rest/v1/flow_data?key=eq.${encodeURIComponent(key)}&select=value`,
      { headers: { apikey: _sbKey, Authorization: `Bearer ${_sbKey}` } }
    );
    if (!r.ok) return null;
    const d = await r.json();
    return d?.[0]?.value ?? null;
  } catch(_) { return null; }
}

async function _sbSet(key, value) {
  if (!_sbUrl) return;
  try {
    await fetch(`${_sbUrl}/rest/v1/flow_data`, {
      method: 'POST',
      headers: {
        apikey: _sbKey,
        Authorization: `Bearer ${_sbKey}`,
        'Content-Type':  'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
    });
  } catch(_) {}
}

// ── Sync queue — batches writes to avoid hammering Supabase ──────────────
const _syncQueue = new Map();
let _syncTimer   = null;

function _queueSync(key, value) {
  _syncQueue.set(key, value);
  if (_syncTimer) return;
  _syncTimer = setTimeout(async () => {
    _syncTimer = null;
    const sbReady = await _initSB();
    if (!sbReady) return;
    for (const [k, v] of _syncQueue) {
      await _sbSet(k, v);
    }
    _syncQueue.clear();
  }, 2000);  // batch writes every 2s
}

export const Storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(PFX + key);
      return raw !== null ? JSON.parse(raw) : fallback;
    } catch(_) { return fallback; }
  },

  set(key, value) {
    try {
      localStorage.setItem(PFX + key, JSON.stringify(value));
      _queueSync(key, value);  // async cloud backup
    } catch(_) {}
  },

  remove(key) {
    try { localStorage.removeItem(PFX + key); } catch(_) {}
  },

  clearAll() {
    Object.keys(localStorage)
      .filter(k => k.startsWith(PFX))
      .forEach(k => localStorage.removeItem(k));
  },

  // Pull latest data from Supabase (call on app boot for cross-device sync)
  async syncFromCloud() {
    const sbReady = await _initSB();
    if (!sbReady) return false;
    try {
      const r = await fetch(
        `${_sbUrl}/rest/v1/flow_data?select=key,value`,
        { headers: { apikey: _sbKey, Authorization: `Bearer ${_sbKey}` } }
      );
      if (!r.ok) return false;
      const rows = await r.json();
      // Only sync important keys, don't overwrite local-only prefs
      const SYNC_KEYS = ['memory', 'profile', 'facts', 'goals', 'alarms', 'notes', 'flow_pin_hash'];
      rows.forEach(({ key, value }) => {
        if (SYNC_KEYS.includes(key) && value !== null) {
          const local = this.get(key);
          // Use whichever is newer/longer (simple conflict resolution)
          if (!local || (Array.isArray(value) && value.length > (local?.length ?? 0))) {
            localStorage.setItem(PFX + key, JSON.stringify(value));
          }
        }
      });
      return true;
    } catch(_) { return false; }
  },

  exportBrain() {
    const data = {
      exported: new Date().toISOString(),
      memory:   this.get('memory',  []),
      notes:    this.get('notes',   ''),
      alarms:   this.get('alarms',  []),
      profile:  this.get('profile', {}),
      facts:    this.get('facts',   {}),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `flow-brain-${Date.now()}.json`; a.click();
    URL.revokeObjectURL(url);
    return 'Brain exported. Keep that file safe.';
  },

  importBrain(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const b = JSON.parse(e.target.result);
        if (b.memory)  this.set('memory',  b.memory);
        if (b.notes)   this.set('notes',   b.notes);
        if (b.alarms)  this.set('alarms',  b.alarms);
        if (b.profile) this.set('profile', b.profile);
        if (b.facts)   this.set('facts',   b.facts);
        location.reload();
      } catch(_) { alert('Invalid brain file.'); }
    };
    reader.readAsText(file);
  },
};
