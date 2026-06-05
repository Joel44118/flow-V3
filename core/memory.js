// ═══════════════════════════════════════════
// core/memory.js
// ═══════════════════════════════════════════
import { Storage } from "./storage.js";
import { markDirty } from "./cloud.js";
import { CONFIG }  from "./config.js";

let history = Storage.get("memory", []);

export const Memory = {
  get() { return history; },

  add(role, content) {
    history.push({ role, content, ts: Date.now() });
    history = history.slice(-CONFIG.MEMORY_LIMIT);
    Storage.set("memory", history);
    markDirty();
  },

  // Clean array for API — only role + content
  forAPI() {
    return history.slice(-CONFIG.HISTORY_LIMIT).map(m => ({
      role:    m.role,
      content: m.content,
    }));
  },

  clear() { history = []; Storage.remove("memory"); },

  getProfile() {
    return Storage.get("profile", CONFIG.USER);
  },

  setProfile(key, value) {
    const p = this.getProfile();
    p[key] = value;
    Storage.set("profile", p);
  },

  getFacts() { return Storage.get("facts", {}); },

  addFact(key, value) {
    const f = this.getFacts();
    f[key] = { value, ts: Date.now() };
    Storage.set("facts", f);
  },

  factsString() {
    const f    = this.getFacts();
    const keys = Object.keys(f);
    if (!keys.length) return "None yet.";
    return keys.map(k => `${k}: ${f[k].value}`).join("\n");
  },
};
