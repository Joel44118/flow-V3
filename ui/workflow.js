// ═══════════════════════════════════════════
// ui/workflow.js — REAL, NEW: background workflow panel.
//
// Joel asked to SEE what's running in the background — active, running,
// and failed — like a workflow view, not just trust it's happening.
// REAL, HONEST SCOPE: the only genuine server-tracked job system that
// currently exists in this codebase is the lead-generation pipeline
// (api/social.js's lead-job-* endpoints, backed by real KV records with
// a real status machine: finding_businesses → scraping_emails →
// awaiting_reachout_instructions → sending_outreach → complete/failed/
// no_leads_found). This panel surfaces THAT real data — it does NOT
// fabricate a generic "worker" abstraction for things that don't
// actually have job-tracking today (background research rotation, for
// instance, runs on a timer and saves insights, but has no per-run job
// record to show here). Being honest about that scope now is better
// than building a panel that LOOKS comprehensive but is quietly showing
// nothing for most of what it implies.
//
// Positioned at top:90px, left:0 — deliberately mirrors Content Lab's
// own top:90px/right:0 tab, so the four tray tabs read as two
// symmetrical pairs (Content Lab ↔ Workflow, Thought Log ↔ Leads)
// rather than an unbalanced stack down one side.
// ═══════════════════════════════════════════

let _panelEl = null;
let _pollTimer = null;

function _injectStyles() {
  if (document.getElementById("workflow-tray-style")) return;
  const style = document.createElement("style");
  style.id = "workflow-tray-style";
  style.textContent = `
#workflow-tray-tab {
  position: fixed; top: 90px; left: 0;
  width: 28px; height: 84px;
  background: rgba(30,20,55,0.95); border: 1px solid rgba(167,139,250,0.4);
  border-left: none; border-radius: 0 10px 10px 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
  cursor: pointer; z-index: 9998; color: #a78bfa; font-size: 16px;
  box-shadow: 4px 0 16px rgba(0,0,0,0.35);
  transition: background 0.15s ease, width 0.15s ease;
}
#workflow-tray-tab:hover { background: rgba(50,35,85,0.98); width: 32px; }

#workflow-panel {
  position: fixed; top: 0; left: 0; bottom: 0;
  width: min(440px, 92vw);
  background: rgba(15,10,30,0.98); border-right: 1px solid rgba(167,139,250,0.4);
  box-shadow: 12px 0 40px rgba(0,0,0,0.5);
  z-index: 9999; display: flex; flex-direction: column;
  font-family: system-ui, sans-serif; color: #e5e7eb;
  overflow: hidden;
  transform: translateX(-100%);
  transition: transform 0.25s ease;
}
#workflow-panel.wf-open { transform: translateX(0); }

#workflow-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 18px; border-bottom: 1px solid rgba(167,139,250,0.2); flex-shrink: 0;
}
#workflow-header .wf-title { font-size: 15px; font-weight: 700; color: #d8d4ff; }
#workflow-close-btn { background: none; border: none; color: #9ca3af; font-size: 18px; cursor: pointer; padding: 4px 8px; }
#workflow-close-btn:hover { color: #e5e7eb; }

#workflow-body { flex: 1; overflow-y: auto; padding: 16px 18px; }
#workflow-body::-webkit-scrollbar { display: none; }

.wf-scope-note { font-size: 11px; color: rgba(255,255,255,0.35); font-style: italic; margin-bottom: 14px; line-height: 1.5; }
.wf-empty { font-size: 11px; color: rgba(255,255,255,0.35); font-style: italic; padding: 8px 0; }

.wf-job {
  border: 1px solid rgba(167,139,250,0.2); background: rgba(255,255,255,0.03);
  border-radius: 10px; padding: 12px; margin-bottom: 10px;
}
.wf-job-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.wf-job-name { font-size: 12px; font-weight: 700; color: #d8d4ff; }
.wf-badge { font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 6px; white-space: nowrap; text-transform: uppercase; letter-spacing: 0.03em; }
.wf-badge.running { background: rgba(56,189,248,0.15); color: #38bdf8; border: 1px solid rgba(56,189,248,0.4); }
.wf-badge.complete { background: rgba(74,222,128,0.15); color: #4ade80; border: 1px solid rgba(74,222,128,0.4); }
.wf-badge.failed { background: rgba(248,113,113,0.15); color: #f87171; border: 1px solid rgba(248,113,113,0.4); }
.wf-badge.paused { background: rgba(251,191,36,0.15); color: #fbbf24; border: 1px solid rgba(251,191,36,0.4); }
.wf-job-step { font-size: 12px; color: #e5e7eb; line-height: 1.5; margin-bottom: 8px; }
.wf-progress-track { height: 4px; border-radius: 2px; background: rgba(255,255,255,0.08); overflow: hidden; }
.wf-progress-fill { height: 100%; background: linear-gradient(90deg, #a78bfa, #38bdf8); transition: width 0.3s ease; }
.wf-job-spinner {
  width: 10px; height: 10px; border-radius: 50%; display: inline-block; margin-right: 5px;
  border: 2px solid rgba(56,189,248,0.3); border-top-color: #38bdf8;
  animation: wf-spin 0.8s linear infinite; vertical-align: middle;
}
@keyframes wf-spin { to { transform: rotate(360deg); } }
`;
  document.head.appendChild(style);
}

const RUNNING_STATUSES = ['finding_businesses', 'scraping_emails', 'sending_outreach'];
const PAUSED_STATUSES = ['awaiting_reachout_instructions'];

function _statusMeta(status) {
  if (RUNNING_STATUSES.includes(status)) return { badge: 'running', label: 'Running' };
  if (PAUSED_STATUSES.includes(status)) return { badge: 'paused', label: 'Awaiting input' };
  if (status === 'complete') return { badge: 'complete', label: 'Complete' };
  return { badge: 'failed', label: status === 'no_leads_found' ? 'No leads found' : 'Failed' };
}

function _renderJobs(body, jobs) {
  body.innerHTML = "";

  const note = document.createElement("div");
  note.className = "wf-scope-note";
  note.textContent = "Real, live status from the lead-generation pipeline — the one background job system currently tracked server-side. (Background research rotation runs on a timer without per-run job records, so it doesn't have a row here yet.)";
  body.appendChild(note);

  if (!jobs.length) {
    const empty = document.createElement("div");
    empty.className = "wf-empty";
    empty.textContent = "No lead jobs have run yet.";
    body.appendChild(empty);
    return;
  }

  // Real, most-recent-first — matches how Joel actually thinks about
  // "what's active right now" vs. old finished runs.
  const sorted = [...jobs].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  sorted.forEach(job => {
    const meta = _statusMeta(job.status);
    const card = document.createElement("div");
    card.className = "wf-job";

    const head = document.createElement("div");
    head.className = "wf-job-head";
    const name = document.createElement("span");
    name.className = "wf-job-name";
    name.textContent = job.niche || job.instructions || job.id;
    const badge = document.createElement("span");
    badge.className = `wf-badge ${meta.badge}`;
    badge.textContent = meta.label;
    head.appendChild(name);
    head.appendChild(badge);
    card.appendChild(head);

    const step = document.createElement("div");
    step.className = "wf-job-step";
    if (meta.badge === 'running') {
      const spinner = document.createElement("span");
      spinner.className = "wf-job-spinner";
      step.appendChild(spinner);
    }
    step.appendChild(document.createTextNode(job.currentStep || ""));
    card.appendChild(step);

    const total = job.businesses?.length || 0;
    if (total > 0) {
      const track = document.createElement("div");
      track.className = "wf-progress-track";
      const fill = document.createElement("div");
      fill.className = "wf-progress-fill";
      const pct = job.status === 'complete'
        ? 100
        : Math.round(((job.scrapedCount || 0) / total) * 100);
      fill.style.width = `${pct}%`;
      track.appendChild(fill);
      card.appendChild(track);
    }

    body.appendChild(card);
  });
}

async function _pollJobs(body) {
  try {
    const res = await fetch("/api/social?platform=lead-jobs-list");
    const data = await res.json();
    if (!data.ok) return;
    _renderJobs(body, data.jobs || []);
  } catch (e) {
    console.warn("[Workflow] Poll failed (non-fatal):", e.message);
  }
}

export function isWorkflowTrayOpen() {
  return !!_panelEl?.classList.contains("wf-open");
}

export async function openWorkflowTray() {
  _injectStyles();

  if (_panelEl) {
    _panelEl.classList.add("wf-open");
    document.getElementById("workflow-tray-tab")?.classList.add("wf-tray-open");
    _pollTimer = setInterval(() => _pollJobs(_panelEl.querySelector("#workflow-body")), 3000);
    return;
  }

  const panel = document.createElement("div");
  panel.id = "workflow-panel";

  const header = document.createElement("div");
  header.id = "workflow-header";
  header.innerHTML = `<span class="wf-title">⚙️ Workflow</span>`;
  const closeBtn = document.createElement("button");
  closeBtn.id = "workflow-close-btn";
  closeBtn.textContent = "✕";
  closeBtn.onclick = () => closeWorkflowTray();
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const body = document.createElement("div");
  body.id = "workflow-body";
  panel.appendChild(body);

  document.body.appendChild(panel);
  _panelEl = panel;

  await _pollJobs(body);
  _pollTimer = setInterval(() => _pollJobs(body), 3000);

  requestAnimationFrame(() => {
    panel.classList.add("wf-open");
    document.getElementById("workflow-tray-tab")?.classList.add("wf-tray-open");
  });
  _bindOutsideClickClose();
}

export function closeWorkflowTray() {
  if (_panelEl) _panelEl.classList.remove("wf-open");
  document.getElementById("workflow-tray-tab")?.classList.remove("wf-tray-open");
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

let _outsideClickBound = false;
function _bindOutsideClickClose() {
  if (_outsideClickBound) return;
  _outsideClickBound = true;
  document.addEventListener("mousedown", (e) => {
    if (!_panelEl?.classList.contains("wf-open")) return;
    const tab = document.getElementById("workflow-tray-tab");
    if (_panelEl.contains(e.target) || tab?.contains(e.target)) return;
    closeWorkflowTray();
  });
}

function _buildToggleButton() {
  const tab = document.createElement("div");
  tab.id = "workflow-tray-tab";
  tab.className = "boot-collapsed";
  tab.title = "Workflow";
  tab.innerHTML = `<span>⚙️</span>`;
  tab.addEventListener("click", () => {
    if (isWorkflowTrayOpen()) closeWorkflowTray();
    else openWorkflowTray();
  });
  document.body.appendChild(tab);
}

export function initWorkflowTray() {
  _injectStyles();
  _buildToggleButton();
}
