// ui/dashboard.js — NEW, Joel-requested "worth the rebuild" feature.
// A single real command-center view pulling from tonight's actual
// built systems: XP/level (core/leveling.js), music career
// (core/music-career.js), the active leads job (same real endpoint
// leads.js already polls), and recorded skills (the same bridge
// skills-tray.js already uses). Every number here is real, pulled
// live — nothing here is placeholder or invented.

const PANEL_ID = "dashboard-panel";
const TAB_ID = "dashboard-tray-tab";

function _injectStyles() {
  if (document.getElementById("dashboard-styles")) return;
  const style = document.createElement("style");
  style.id = "dashboard-styles";
  style.textContent = `
    #${TAB_ID} {
      position: fixed; right: 0; top: calc(50% + 52px); transform: translateY(-50%);
      width: 40px; height: 40px; border-radius: 8px 0 0 8px;
      background: rgba(30,30,35,0.9); border: 1px solid rgba(255,255,255,0.1);
      border-right: none; display: flex; align-items: center; justify-content: center;
      cursor: pointer; z-index: 9200; font-size: 18px;
    }
    #${PANEL_ID} {
      position: fixed; right: 0; top: 52px; bottom: 26px; width: 360px;
      background: rgba(20,20,24,0.97); border-left: 1px solid rgba(255,255,255,0.1);
      z-index: 9199; display: none; flex-direction: column; overflow-y: auto;
      padding: 18px 16px;
    }
    #${PANEL_ID}.open { display: flex; }
    #${PANEL_ID} .dash-header {
      font-size: 15px; font-weight: 700; color: #fff; margin-bottom: 16px;
      display: flex; align-items: center; gap: 8px;
    }
    #${PANEL_ID} .dash-card {
      background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.07);
      border-radius: 12px; padding: 14px; margin-bottom: 12px;
    }
    #${PANEL_ID} .dash-card-title {
      font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;
      color: rgba(255,255,255,0.45); margin-bottom: 8px; display: flex;
      align-items: center; justify-content: space-between;
    }
    #${PANEL_ID} .dash-card-body { color: #fff; font-size: 13px; line-height: 1.5; }
    #${PANEL_ID} .dash-bar-bg {
      height: 6px; border-radius: 3px; background: rgba(255,255,255,0.08);
      margin-top: 8px; overflow: hidden;
    }
    #${PANEL_ID} .dash-bar-fill {
      height: 100%; border-radius: 3px;
      background: linear-gradient(90deg, #38bdf8, #4f46e5);
      transition: width 0.4s ease;
    }
    #${PANEL_ID} .dash-empty { color: rgba(255,255,255,0.35); font-size: 12px; font-style: italic; }
    #${PANEL_ID} .dash-link {
      color: #86efac; font-size: 12px; cursor: pointer; margin-top: 8px; display: inline-block;
    }
    #${PANEL_ID} .dash-refresh {
      background: none; border: none; color: rgba(255,255,255,0.4); cursor: pointer;
      font-size: 14px; padding: 0;
    }
  `;
  document.head.appendChild(style);
}

async function _renderDashboard(body) {
  body.innerHTML = `<div class="dash-header">📊 Flow Dashboard <button class="dash-refresh" title="Refresh">↻</button></div>`;

  // ── Level / XP — real, synchronous, same source get_my_level uses ──
  try {
    const { getLevelState } = await import("../core/leveling.js");
    const lvl = getLevelState();
    const card = document.createElement("div");
    card.className = "dash-card";
    card.innerHTML = `
      <div class="dash-card-title"><span>Level</span></div>
      <div class="dash-card-body">
        Level ${lvl.level} — ${lvl.totalXp} total XP
        <div class="dash-bar-bg"><div class="dash-bar-fill" style="width:${lvl.percent}%"></div></div>
        <div style="margin-top:4px;font-size:11px;color:rgba(255,255,255,0.4)">${lvl.xp}/${lvl.xpNeeded} XP to next level</div>
      </div>
    `;
    body.appendChild(card);
  } catch (e) {
    console.warn("[Dashboard] Level card failed:", e.message);
  }

  // ── Music career — real tracks + style profile, same source music_career_status uses ──
  try {
    const { getAllTracks, getStyleProfile } = await import("../core/music-career.js");
    const tracks = getAllTracks();
    const profile = getStyleProfile();
    const card = document.createElement("div");
    card.className = "dash-card";
    if (!tracks.length) {
      card.innerHTML = `<div class="dash-card-title"><span>🎵 Music Career</span></div><div class="dash-card-body dash-empty">No tracks yet — Flow hasn't started making music.</div>`;
    } else {
      const rated = tracks.filter(t => t.rating != null);
      const avgRating = rated.length ? (rated.reduce((s, t) => s + t.rating, 0) / rated.length).toFixed(1) : "—";
      const topTags = (profile?.tagAverages || []).slice(0, 3).map(t => t.tag);
      card.innerHTML = `
        <div class="dash-card-title"><span>🎵 Music Career</span></div>
        <div class="dash-card-body">
          ${tracks.length} track${tracks.length === 1 ? "" : "s"} made · avg rating ${avgRating}/5
          ${topTags.length ? `<div style="margin-top:6px;font-size:11px;color:rgba(255,255,255,0.5)">Best-performing style: ${topTags.join(", ")}</div>` : ""}
        </div>
      `;
    }
    body.appendChild(card);
  } catch (e) {
    console.warn("[Dashboard] Music career card failed:", e.message);
  }

  // ── Leads pipeline — real, live poll of whatever job is actually active ──
  const card3 = document.createElement("div");
  card3.className = "dash-card";
  card3.innerHTML = `<div class="dash-card-title"><span>📇 Leads</span></div><div class="dash-card-body dash-empty">Checking...</div>`;
  body.appendChild(card3);
  try {
    const jobId = localStorage.getItem("flow_active_lead_job_id");
    if (!jobId) {
      card3.querySelector(".dash-card-body").innerHTML = `<span class="dash-empty">No active search.</span> <span class="dash-link" id="dash-open-leads">Start one →</span>`;
    } else {
      const res = await fetch(`/api/social?platform=lead-job-status&jobId=${encodeURIComponent(jobId)}`);
      const data = await res.json();
      if (data.ok && data.job) {
        card3.querySelector(".dash-card-body").innerHTML = `
          ${data.job.leads?.length || 0} lead${(data.job.leads?.length || 0) === 1 ? "" : "s"} found so far
          <div style="margin-top:4px;font-size:11px;color:rgba(255,255,255,0.5)">${data.job.currentStep || data.job.status}</div>
        `;
      } else {
        card3.querySelector(".dash-card-body").innerHTML = `<span class="dash-empty">No active search.</span>`;
      }
    }
  } catch (e) {
    card3.querySelector(".dash-card-body").innerHTML = `<span class="dash-empty">Couldn't check right now.</span>`;
  }

  // ── Skills — real, same bridge skills-tray.js uses ──
  const card4 = document.createElement("div");
  card4.className = "dash-card";
  card4.innerHTML = `<div class="dash-card-title"><span>🧠 Recorded Skills</span></div><div class="dash-card-body dash-empty">Checking...</div>`;
  body.appendChild(card4);
  try {
    if (window.__flowElectron?.osControl?.listSkills) {
      const skills = await window.__flowElectron.osControl.listSkills();
      card4.querySelector(".dash-card-body").innerHTML = skills?.length
        ? `${skills.length} skill${skills.length === 1 ? "" : "s"} recorded: ${skills.slice(0, 3).map(s => s.name).join(", ")}${skills.length > 3 ? "…" : ""}`
        : `<span class="dash-empty">None recorded yet.</span>`;
    } else {
      card4.querySelector(".dash-card-body").innerHTML = `<span class="dash-empty">Only available in the desktop app.</span>`;
    }
  } catch (e) {
    card4.querySelector(".dash-card-body").innerHTML = `<span class="dash-empty">Couldn't check right now.</span>`;
  }

  body.querySelector(".dash-refresh")?.addEventListener("click", () => _renderDashboard(body));
  body.querySelector("#dash-open-leads")?.addEventListener("click", () => document.getElementById("leads-tray-tab")?.click());
}

export function initDashboard() {
  _injectStyles();

  const tab = document.createElement("div");
  tab.id = TAB_ID;
  tab.textContent = "📊";
  tab.title = "Flow Dashboard";
  document.body.appendChild(tab);

  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  document.body.appendChild(panel);

  tab.addEventListener("click", () => {
    const isOpen = panel.classList.toggle("open");
    if (isOpen) _renderDashboard(panel);
  });

  // Real, live refresh whenever a skill gets saved elsewhere — same
  // event skills-tray.js already dispatches, so this stays honest
  // without needing its own separate polling loop.
  window.addEventListener("flow:skills-updated", () => {
    if (panel.classList.contains("open")) _renderDashboard(panel);
  });

  return { tabSelector: `#${TAB_ID}` };
}
