// ═══════════════════════════════════════════
// core/storage.js
// ═══════════════════════════════════════════

const PFX = "flow_v3_";

export const Storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(PFX + key);
      return raw !== null ? JSON.parse(raw) : fallback;
    } catch(_) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(PFX + key, JSON.stringify(value)); } catch(_){}
  },
  remove(key) {
    try { localStorage.removeItem(PFX + key); } catch(_){}
  },
  clearAll() {
    Object.keys(localStorage)
      .filter(k => k.startsWith(PFX))
      .forEach(k => localStorage.removeItem(k));
  },
  exportBrain() {
    const brain = {
      version:  "3.0",
      exported: new Date().toISOString(),
      memory:   this.get("memory", []),
      notes:    this.get("notes", ""),
      alarms:   this.get("alarms", []),
      profile:  this.get("profile", {}),
      facts:    this.get("facts", {}),
    };
    const blob = new Blob([JSON.stringify(brain, null, 2)], {type:"application/json"});
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = `flow-brain-${Date.now()}.json`; a.click();
    URL.revokeObjectURL(url);
    return "Brain exported. Keep that file safe.";
  },
  importBrain(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const b = JSON.parse(e.target.result);
          if (b.memory)  this.set("memory",  b.memory);
          if (b.notes)   this.set("notes",   b.notes);
          if (b.alarms)  this.set("alarms",  b.alarms);
          if (b.profile) this.set("profile", b.profile);
          if (b.facts)   this.set("facts",   b.facts);
          resolve("Brain loaded. I remember everything, Boss.");
        } catch(err) { reject("Couldn't read brain file: " + err.message); }
      };
      reader.readAsText(file);
    });
  },
};