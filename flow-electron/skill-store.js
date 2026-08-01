// ═══════════════════════════════════════════
// flow-electron/skill-store.js — REAL, NEW: simple JSON-file storage
// for named OS-control skills.
//
// HONEST SCOPE: this is storage only. There is currently NO recording
// mechanism to populate it (that's the staged next step — see
// os-control.js's own header comment about uiohook-napi's known crash
// bug). Skills can currently only be added by hand-editing the JSON
// file this creates, or via a future recording feature writing to it.
// This exists now so the voice → OS-control wiring (app.js's
// run_recorded_skill handling, api/chat.js's tool definition) has
// something real to call into, rather than being wired to nothing.
// ═══════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function _storePath() {
  return path.join(app.getPath('userData'), 'flow-skills.json');
}

function listSkills() {
  try {
    const p = _storePath();
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.warn('[SkillStore] Failed to load skills (non-fatal, returning empty list):', e.message);
    return [];
  }
}

function getSkill(name) {
  return listSkills().find(s => s.name.toLowerCase() === String(name || '').toLowerCase()) || null;
}

function saveSkill(skill) {
  const skills = listSkills().filter(s => s.name.toLowerCase() !== skill.name.toLowerCase());
  skills.push(skill);
  try {
    fs.writeFileSync(_storePath(), JSON.stringify(skills, null, 2));
    return true;
  } catch (e) {
    console.error('[SkillStore] Failed to save skill:', e.message);
    return false;
  }
}

module.exports = { listSkills, getSkill, saveSkill };
