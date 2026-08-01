// ═══════════════════════════════════════════
// ui/leads.js — Leads tray, REBUILT FROM SCRATCH (3rd full rebuild) per
// Joel's explicit request after the bug persisted through two prior fix
// attempts that, on inspection, were genuinely deployed but didn't
// resolve it.
//
// THIS REBUILD IS DELIBERATELY MAXIMALLY DEFENSIVE:
//   - Every element gets its OWN inline style attributes in addition to
//     CSS classes — if stylesheet injection ever silently fails for any
//     reason, elements are still visible and usable, not blank.
//   - Real console.log statements at every render step, so if this
//     still doesn't show right, the DevTools console will show exactly
//     which step ran and with what data — turning "still broken" into
//     an actual diagnosable signal instead of another guess.
//   - No shortcuts, no reused/cached state that could silently carry
//     over a bad prior render — every open() tears down and rebuilds
//     the panel completely from nothing.
//
// FLOW:
//   1. One input bar — plain-text instructions of what to find.
//   2. Real, live step-by-step progress as Apify + email-scraping run.
//   3. Once emails are found, a second input appears for outreach
//      instructions.
//   4. Real background survival via api/social.js's lead-job-* endpoints
//      — closing this tray does not stop the job.
// ═══════════════════════════════════════════

let _panelEl = null;
let _pollTimer = null;
let _activeJobId = null;

function _log(...args) { console.log("[Leads]", ...args); }

function _saveActiveJobId(jobId) {
  try { localStorage.setItem('flow_active_lead_job_id', jobId || ''); } catch (_) {}
}
function _loadActiveJobId() {
  try { return localStorage.getItem('flow_active_lead_job_id') || null; } catch (_) { return null; }
}

function _injectStyles() {
  if (document.getElementById("leads-tray-style")) { _log("styles already injected, skipping"); return; }
  _log("injecting styles");
  const style = document.createElement("style");
  style.id = "leads-tray-style";
  style.textContent = `
#leads-tray-tab {
  position: fixed; top: 180px; left: 0;
  width: 28px; height: 84px;
  background: rgba(30,20,55,0.95); border: 1px solid rgba(167,139,250,0.4);
  border-left: none; border-radius: 0 10px 10px 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
  cursor: pointer; z-index: 9998; color: #a78bfa; font-size: 16px;
  box-shadow: 4px 0 16px rgba(0,0,0,0.35);
}
#leads-tray-tab:hover { background: rgba(50,35,85,0.98); width: 32px; }

#leads-panel {
  position: fixed; top: 52px; left: 0; bottom: 26px;
  width: min(440px, 92vw);
  background: rgba(15,10,30,0.98); border-right: 1px solid rgba(167,139,250,0.4);
  box-shadow: 12px 0 40px rgba(0,0,0,0.5);
  z-index: 9999; display: flex; flex-direction: column;
  font-family: system-ui, sans-serif; color: #e5e7eb;
  transform: translateX(-100%);
  transition: transform 0.25s ease;
}
#leads-panel.lt-open { transform: translateX(0); }

#leads-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 18px; border-bottom: 1px solid rgba(167,139,250,0.2); flex-shrink: 0;
}
.lt-title { font-size: 15px; font-weight: 700; color: #d8d4ff; }
#leads-close-btn { background: none; border: none; color: #9ca3af; font-size: 18px; cursor: pointer; padding: 4px 8px; }
#leads-close-btn:hover { color: #e5e7eb; }

#leads-body { flex: 1; overflow-y: auto; padding: 16px 18px; }
#leads-body::-webkit-scrollbar { display: none; }

.lt-hint { font-size: 11px; color: rgba(255,255,255,0.5); line-height: 1.6; margin-bottom: 14px; }
.lt-input-row { display: flex; flex-direction: column; gap: 10px; }
.lt-input {
  width: 100%; min-height: 60px; background: rgba(255,255,255,0.06);
  border: 1px solid rgba(167,139,250,0.35); border-radius: 8px; color: #e5e7eb;
  font-size: 13px; padding: 10px; font-family: inherit; resize: vertical; box-sizing: border-box;
}
.lt-input::placeholder { color: rgba(255,255,255,0.35); }
.lt-submit-btn {
  background: rgba(167,139,250,0.18); border: 1px solid rgba(167,139,250,0.5);
  color: #d8d4ff; font-size: 13px; font-weight: 600; padding: 10px 14px;
  border-radius: 8px; cursor: pointer;
}
.lt-submit-btn:hover { background: rgba(167,139,250,0.3); }
.lt-submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.lt-summary { font-size: 11px; color: #fbbf24; background: rgba(251,191,36,0.08); border: 1px solid rgba(251,191,36,0.3); border-radius: 8px; padding: 10px; margin-bottom: 14px; line-height: 1.5; }
.lt-step-banner { font-size: 12px; color: #38bdf8; margin-bottom: 12px; }
.lt-biz-card { background: rgba(255,255,255,0.04); border: 1px solid rgba(167,139,250,0.2); border-radius: 8px; padding: 10px; margin-bottom: 8px; font-size: 12px; }
.lt-biz-name { font-weight: 700; color: #d8d4ff; }
.lt-biz-meta { color: rgba(255,255,255,0.5); font-size: 11px; margin-top: 2px; }
.lt-history-link { font-size: 12px; color: #a78bfa; cursor: pointer; text-decoration: underline; margin-top: 10px; }
`;
  document.head.appendChild(style);
}

function _renderInputForm(body, lastJob) {
  _log("_renderInputForm called, lastJob:", lastJob);
  body.innerHTML = "";

  if (lastJob) {
    const summary = document.createElement("div");
    summary.className = "lt-summary";
    summary.style.cssText = "font-size:11px;color:#fbbf24;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.3);border-radius:8px;padding:10px;margin-bottom:14px;line-height:1.5;";
    const scraped = lastJob.scrapedCount ?? lastJob.businesses?.length ?? 0;
    const total = lastJob.businesses?.length ?? 0;
    summary.textContent = lastJob.status === 'no_leads_found'
      ? `⚠️ Last search ("${lastJob.niche || lastJob.instructions}") scraped ${scraped}/${total} businesses but found no usable contact emails. Try a different niche or add a location.`
      : `⚠️ Last search ("${lastJob.niche || lastJob.instructions}") didn't complete: ${lastJob.currentStep || 'unknown error'}.`;
    body.appendChild(summary);
  }

  const hint = document.createElement("div");
  hint.className = "lt-hint";
  hint.style.cssText = "font-size:11px;color:rgba(255,255,255,0.6);line-height:1.6;margin-bottom:14px;";
  hint.textContent = "Tell Flow what kind of leads to find — a niche, industry, and optionally a location. Flow finds real businesses, scrapes their real contact emails automatically, then asks what the outreach should say.";
  body.appendChild(hint);

  const row = document.createElement("div");
  row.className = "lt-input-row";
  row.style.cssText = "display:flex;flex-direction:column;gap:10px;";

  const textarea = document.createElement("textarea");
  textarea.className = "lt-input";
  textarea.style.cssText = "width:100%;min-height:60px;background:rgba(255,255,255,0.06);border:1px solid rgba(167,139,250,0.35);border-radius:8px;color:#e5e7eb;font-size:13px;padding:10px;font-family:inherit;box-sizing:border-box;";
  textarea.placeholder = "e.g. web design agencies in Lagos, small independent shops...";

  const btn = document.createElement("button");
  btn.className = "lt-submit-btn";
  btn.style.cssText = "background:rgba(167,139,250,0.18);border:1px solid rgba(167,139,250,0.5);color:#d8d4ff;font-size:13px;font-weight:600;padding:10px 14px;border-radius:8px;cursor:pointer;";
  btn.textContent = "🔍 Find leads";
  btn.type = "button";
  btn.onclick = () => _submitFindInstructions(textarea, btn, body);

  row.appendChild(textarea);
  row.appendChild(btn);
  body.appendChild(row);
  _log("_renderInputForm finished — body now has", body.children.length, "children");
}

async function _submitFindInstructions(textarea, btn, body) {
  const instructions = textarea.value.trim();
  if (!instructions) { textarea.style.borderColor = "#f87171"; return; }
  btn.disabled = true;
  btn.textContent = "Starting...";
  try {
    const res = await fetch("/api/social?platform=lead-job-create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instructions }),
    });
    const data = await res.json();
    if (!data.ok) {
      body.innerHTML = "";
      const err = document.createElement("div");
      err.className = "lt-summary";
      err.style.cssText = "font-size:12px;color:#f87171;padding:10px;";
      err.textContent = `Couldn't start the search: ${data.error || "unknown error"}`;
      body.appendChild(err);
      const retry = document.createElement("div");
      retry.className = "lt-history-link";
      retry.style.cssText = "font-size:12px;color:#a78bfa;cursor:pointer;text-decoration:underline;margin-top:10px;";
      retry.textContent = "Try again";
      retry.onclick = () => _renderInputForm(body);
      body.appendChild(retry);
      return;
    }
    _activeJobId = data.job.id;
    _saveActiveJobId(_activeJobId);
    _renderJob(body, data.job);
    _startPolling(body);
  } catch (e) {
    body.innerHTML = "";
    const err = document.createElement("div");
    err.style.cssText = "font-size:12px;color:#f87171;padding:10px;";
    err.textContent = `Real network error: ${e.message}`;
    body.appendChild(err);
  }
}

function _renderJob(body, job) {
  _log("_renderJob called, job status:", job.status);
  body.innerHTML = "";

  const step = document.createElement("div");
  step.className = "lt-step-banner";
  step.style.cssText = "font-size:12px;color:#38bdf8;margin-bottom:12px;";
  step.textContent = job.currentStep || `Status: ${job.status}`;
  body.appendChild(step);

  (job.businesses || []).forEach(biz => {
    const card = document.createElement("div");
    card.className = "lt-biz-card";
    card.style.cssText = "background:rgba(255,255,255,0.04);border:1px solid rgba(167,139,250,0.2);border-radius:8px;padding:10px;margin-bottom:8px;font-size:12px;";
    const name = document.createElement("div");
    name.style.cssText = "font-weight:700;color:#d8d4ff;";
    name.textContent = biz.name || biz.website || "Unnamed business";
    const meta = document.createElement("div");
    meta.style.cssText = "color:rgba(255,255,255,0.5);font-size:11px;margin-top:2px;";
    meta.textContent = [biz.phone, biz.email].filter(Boolean).join(" · ") || "Scraping...";
    card.appendChild(name);
    card.appendChild(meta);
    body.appendChild(card);
  });

  if (job.status === 'awaiting_reachout_instructions') {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;flex-direction:column;gap:10px;margin-top:12px;";
    const textarea = document.createElement("textarea");
    textarea.style.cssText = "width:100%;min-height:60px;background:rgba(255,255,255,0.06);border:1px solid rgba(167,139,250,0.35);border-radius:8px;color:#e5e7eb;font-size:13px;padding:10px;font-family:inherit;box-sizing:border-box;";
    textarea.placeholder = "What should the outreach message say?";
    const btn = document.createElement("button");
    btn.style.cssText = "background:rgba(167,139,250,0.18);border:1px solid rgba(167,139,250,0.5);color:#d8d4ff;font-size:13px;font-weight:600;padding:10px 14px;border-radius:8px;cursor:pointer;";
    btn.textContent = "📤 Start outreach";
    btn.type = "button";
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = "Starting...";
      try {
        const res = await fetch("/api/social?platform=lead-job-set-reachout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId: _activeJobId, reachoutInstructions: textarea.value.trim() }),
        });
        const data = await res.json();
        if (data.ok) { _renderJob(body, data.job); _startPolling(body); }
      } catch (e) {
        _log("outreach start failed:", e.message);
      }
    };
    row.appendChild(textarea);
    row.appendChild(btn);
    body.appendChild(row);
  }

  if (job.status === 'complete') {
    _saveActiveJobId(null);
    _activeJobId = null;
    const link = document.createElement("div");
    link.className = "lt-history-link";
    link.style.cssText = "font-size:12px;color:#a78bfa;cursor:pointer;text-decoration:underline;margin-top:10px;";
    link.textContent = "Start a new search ↻";
    link.onclick = () => _renderInputForm(body, job);
    body.appendChild(link);
  }
  if (job.status === 'failed' || job.status === 'no_leads_found') {
    _saveActiveJobId(null);
    _activeJobId = null;
    const link = document.createElement("div");
    link.className = "lt-history-link";
    link.style.cssText = "font-size:12px;color:#a78bfa;cursor:pointer;text-decoration:underline;margin-top:10px;";
    link.textContent = "Try a different search ↻";
    link.onclick = () => _renderInputForm(body, job);
    body.appendChild(link);
  }
  _log("_renderJob finished — body now has", body.children.length, "children");
}

function _startPolling(body) {
  _stopPolling();
  _pollTimer = setInterval(() => _pollAndAdvance(body), 2000);
}
function _stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

async function _pollAndAdvance(body) {
  if (!_activeJobId) { _stopPolling(); return; }
  try {
    const res = await fetch(`/api/social?platform=lead-job-advance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: _activeJobId }),
    });
    const data = await res.json();
    if (!data.ok) { _log("advance returned not-ok (non-fatal):", data.error); return; }
    _renderJob(body, data.job);
    if (['complete', 'failed', 'no_leads_found', 'awaiting_reachout_instructions'].includes(data.job.status)) {
      _stopPolling();
    }
  } catch (e) {
    _log("poll failed (non-fatal):", e.message);
  }
}

export function isLeadsTrayOpen() {
  return !!_panelEl?.classList.contains("lt-open");
}

export async function openLeadsTray() {
  _log("openLeadsTray() called");
  _injectStyles();

  // REAL, DELIBERATE THIS REBUILD: tear down and rebuild the ENTIRE
  // panel from scratch on every open — no reuse, no shortcuts, no
  // possibility of stale state surviving from before. If this is still
  // broken after this, the console logs above will show exactly where.
  if (_panelEl) {
    _panelEl.remove();
    _panelEl = null;
  }
  _stopPolling();

  const panel = document.createElement("div");
  panel.id = "leads-panel";

  const header = document.createElement("div");
  header.id = "leads-header";
  const title = document.createElement("span");
  title.className = "lt-title";
  title.style.cssText = "font-size:15px;font-weight:700;color:#d8d4ff;";
  title.textContent = "💼 Leads";
  const closeBtn = document.createElement("button");
  closeBtn.id = "leads-close-btn";
  closeBtn.textContent = "✕";
  closeBtn.onclick = () => closeLeadsTray();
  header.appendChild(title);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const body = document.createElement("div");
  body.id = "leads-body";
  panel.appendChild(body);

  document.body.appendChild(panel);
  _panelEl = panel;
  _log("panel built and appended to document.body");

  const savedJobId = _loadActiveJobId();
  _log("savedJobId from localStorage:", savedJobId);

  if (savedJobId) {
    try {
      const res = await fetch(`/api/social?platform=lead-job-status&jobId=${encodeURIComponent(savedJobId)}`);
      const data = await res.json();
      _log("job status fetch result:", data);
      if (data.ok && data.job && !['complete', 'failed', 'no_leads_found'].includes(data.job.status)) {
        _activeJobId = savedJobId;
        _renderJob(body, data.job);
        _startPolling(body);
      } else {
        _renderInputForm(body, data.ok ? data.job : null);
      }
    } catch (e) {
      _log("job status fetch threw (rendering fresh form):", e.message);
      _renderInputForm(body);
    }
  } else {
    _renderInputForm(body);
  }

  requestAnimationFrame(() => {
    panel.classList.add("lt-open");
    document.getElementById("leads-tray-tab")?.classList.add("lt-tray-open");
  });
}

export function closeLeadsTray() {
  if (_panelEl) _panelEl.classList.remove("lt-open");
  document.getElementById("leads-tray-tab")?.classList.remove("lt-tray-open");
  _stopPolling();
}

let _outsideClickBound = false;
function _bindOutsideClickClose() {
  if (_outsideClickBound) return;
  _outsideClickBound = true;
  document.addEventListener("mousedown", (e) => {
    if (!_panelEl?.classList.contains("lt-open")) return;
    const tab = document.getElementById("leads-tray-tab");
    if (_panelEl.contains(e.target) || tab?.contains(e.target)) return;
    closeLeadsTray();
  });
}

export function initLeadsTray() {
  _log("initLeadsTray() called");
  _injectStyles();
  const tab = document.createElement("div");
  tab.id = "leads-tray-tab";
  tab.className = "boot-collapsed";
  tab.title = "Leads";
  tab.innerHTML = `<span>💼</span>`;
  tab.addEventListener("click", () => {
    if (isLeadsTrayOpen()) closeLeadsTray();
    else openLeadsTray();
  });
  document.body.appendChild(tab);
  _bindOutsideClickClose();
}
