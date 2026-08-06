// ui/skills-tray.js — NEW, Joel-requested: a real UI panel listing
// every recorded Watch & Learn skill by name, with one-click Run and
// Delete, using the same Apple-dock hover-reveal pattern as the leads/
// workflow/content-lab tabs (see ui/dock-reveal.js — this tab is added
// to that same selector list in app.js, not a separate mechanism).

const PANEL_ID = "skills-tray-panel";
const TAB_ID = "skills-tray-tab";

function _injectStyles() {
  if (document.getElementById("skills-tray-styles")) return;
  const style = document.createElement("style");
  style.id = "skills-tray-styles";
  style.textContent = `
    #${TAB_ID} {
      position: fixed; right: 0; top: 50%; transform: translateY(-50%);
      width: 40px; height: 40px; border-radius: 8px 0 0 8px;
      background: rgba(30,30,35,0.9); border: 1px solid rgba(255,255,255,0.1);
      border-right: none; display: flex; align-items: center; justify-content: center;
      cursor: pointer; z-index: 9200; font-size: 18px;
    }
    #${PANEL_ID} {
      position: fixed; right: 0; top: 52px; bottom: 26px; width: 320px;
      background: rgba(20,20,24,0.97); border-left: 1px solid rgba(255,255,255,0.1);
      z-index: 9199; display: none; flex-direction: column; overflow: hidden;
    }
    #${PANEL_ID}.open { display: flex; }
    #${PANEL_ID} .skills-header {
      padding: 14px 16px; font-size: 13px; font-weight: 600; color: #fff;
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    #${PANEL_ID} .skills-list { flex: 1; overflow-y: auto; padding: 8px; }
    #${PANEL_ID} .skill-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 12px; margin-bottom: 6px; border-radius: 8px;
      background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06);
    }
    #${PANEL_ID} .skill-name { color: #fff; font-size: 13px; font-weight: 500; }
    #${PANEL_ID} .skill-date { color: rgba(255,255,255,0.4); font-size: 10px; margin-top: 2px; }
    #${PANEL_ID} .skill-actions { display: flex; gap: 6px; }
    #${PANEL_ID} .skill-btn {
      border: none; border-radius: 6px; padding: 6px 10px; font-size: 12px;
      cursor: pointer; color: #fff;
    }
    #${PANEL_ID} .skill-run { background: rgba(74,222,128,0.2); }
    #${PANEL_ID} .skill-run:hover { background: rgba(74,222,128,0.35); }
    #${PANEL_ID} .skill-delete { background: rgba(248,113,113,0.15); }
    #${PANEL_ID} .skill-delete:hover { background: rgba(248,113,113,0.3); }
    #${PANEL_ID} .skills-empty { color: rgba(255,255,255,0.4); font-size: 12px; padding: 20px; text-align: center; }
  `;
  document.head.appendChild(style);
}

async function _renderSkills(listEl) {
  if (!window.__flowElectron?.osControl?.listSkills) {
    listEl.innerHTML = `<div class="skills-empty">Only available in the desktop app.</div>`;
    return;
  }
  const skills = await window.__flowElectron.osControl.listSkills();
  if (!skills?.length) {
    listEl.innerHTML = `<div class="skills-empty">No skills recorded yet — toggle Sentinel's Watch & Learn, do the task once, and it'll show up here.</div>`;
    return;
  }
  listEl.innerHTML = "";
  skills
    .slice()
    .sort((a, b) => (b.recordedAt || 0) - (a.recordedAt || 0))
    .forEach((skill) => {
      const row = document.createElement("div");
      row.className = "skill-row";
      const when = skill.recordedAt ? new Date(skill.recordedAt).toLocaleString() : "";
      row.innerHTML = `
        <div>
          <div class="skill-name">${skill.name}</div>
          <div class="skill-date">${when}</div>
        </div>
        <div class="skill-actions">
          <button class="skill-btn skill-run">Run</button>
          <button class="skill-btn skill-delete">✕</button>
        </div>
      `;
      row.querySelector(".skill-run").addEventListener("click", () => {
        // REAL, NEW — one-click invoke without typing, exactly what
        // Joel asked for. Fires the same client action path as a
        // spoken/typed "run X" request, so it gets the same real
        // confirmation-preview safety step, not a silent bypass.
        window.dispatchEvent(new CustomEvent("flow:run-skill", { detail: { skillName: skill.name } }));
      });
      row.querySelector(".skill-delete").addEventListener("click", async () => {
        if (!window.confirm(`Delete the skill "${skill.name}"? This can't be undone.`)) return;
        await window.__flowElectron.osControl.deleteSkill(skill.name);
        _renderSkills(listEl); // real refresh, not a stale list
      });
      listEl.appendChild(row);
    });
}

export function initSkillsTray() {
  _injectStyles();

  const tab = document.createElement("div");
  tab.id = TAB_ID;
  tab.textContent = "🧠";
  tab.title = "Recorded skills";
  document.body.appendChild(tab);

  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <div class="skills-header">Recorded Skills</div>
    <div class="skills-list"></div>
  `;
  document.body.appendChild(panel);

  const listEl = panel.querySelector(".skills-list");

  tab.addEventListener("click", () => {
    const isOpen = panel.classList.toggle("open");
    if (isOpen) _renderSkills(listEl);
  });

  // Real, live refresh whenever a new skill gets saved elsewhere
  // (app.js dispatches this right after saveSkill succeeds) — so the
  // panel never shows a stale list if it's already open.
  window.addEventListener("flow:skills-updated", () => {
    if (panel.classList.contains("open")) _renderSkills(listEl);
  });

  return { tabSelector: `#${TAB_ID}` };
}
