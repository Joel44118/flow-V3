// ═══════════════════════════════════════════
// ui/leads.js — Leads tray, REBUILT per Joel's explicit redesign.
//
// REAL, NEW FLOW:
//   1. One input bar — Joel types plain-text instructions of what to
//      find (e.g. "web design agencies in Lagos"). No domain/company
//      website form anymore — that's gone entirely.
//   2. Real, live step-by-step progress — not a generic "Loading...".
//      Shows "Finding businesses...", then the real list (name + phone)
//      the moment Apify returns, then "Scraping site X (3/12)..." live
//      as each website gets processed automatically (not re-prompted).
//   3. Once emails are found, a SECOND input appears — reach-out
//      instructions (what to say, what it's about). Submitting starts
//      real outreach sending, one at a time, with live progress too.
//   4. Real background survival — this is a genuine job tracked
//      server-side (api/social.js's lead-job-* endpoints). Closing this
//      tray does NOT stop anything: the Electron heartbeat keeps
//      calling the same advance endpoint on its own cadence. Reopening
//      the tray picks the active job back up via a real status poll.
// ═══════════════════════════════════════════

let _panelEl = null;
let _pollTimer = null;
let _activeJobId = null;

function _saveActiveJobId(jobId) {
  try { localStorage.setItem('flow_active_lead_job_id', jobId || ''); } catch (_) {}
}
function _loadActiveJobId() {
  try { return localStorage.getItem('flow_active_lead_job_id') || null; } catch (_) { return null; }
}

function _injectStyles() {
  if (document.getElementById("leads-tray-style")) return;
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
  transition: background 0.15s ease, width 0.15s ease;
}
#leads-tray-tab:hover { background: rgba(50,35,85,0.98); width: 32px; }
#leads-tray-tab .lt-tab-icon { font-size: 15px; line-height: 1; }

#leads-panel {
  position: fixed; top: 52px; left: 0; bottom: 26px;
  width: min(440px, 92vw);
  background: rgba(15,10,30,0.98); border-right: 1px solid rgba(167,139,250,0.4);
  box-shadow: 12px 0 40px rgba(0,0,0,0.5);
  z-index: 9999; display: flex; flex-direction: column;
  font-family: system-ui, sans-serif; color: #e5e7eb;
  overflow: hidden;
  transform: translateX(-100%);
  transition: transform 0.25s ease;
}
#leads-panel.lt-open { transform: translateX(0); }

#leads-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 18px; border-bottom: 1px solid rgba(167,139,250,0.2); flex-shrink: 0;
}
#leads-header .lt-title { font-size: 15px; font-weight: 700; color: #d8d4ff; }
#leads-close-btn {
  background: none; border: none; color: #9ca3af; font-size: 18px; cursor: pointer; padding: 4px 8px;
}
#leads-close-btn:hover { color: #e5e7eb; }

#leads-body { flex: 1; overflow-y: auto; padding: 16px 18px; }

.lt-input-row { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
.lt-input {
  background: rgba(255,255,255,0.04); border: 1px solid rgba(167,139,250,0.25);
  border-radius: 8px; padding: 10px 12px; font-size: 13px; color: #e5e7eb; outline: none;
  resize: vertical; min-height: 42px; font-family: inherit;
}
.lt-input::placeholder { color: rgba(255,255,255,0.3); }
.lt-input:focus { border-color: rgba(167,139,250,0.6); }
.lt-submit-btn {
  border: 1px solid rgba(167,139,250,0.4); background: rgba(167,139,250,0.15); color: #d8d4ff;
  border-radius: 8px; padding: 10px 12px; font-size: 13px; font-weight: 600; cursor: pointer;
}
.lt-submit-btn:hover { background: rgba(167,139,250,0.25); }
.lt-submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.lt-step-banner {
  font-size: 13px; color: #d8d4ff; background: rgba(167,139,250,0.1);
  border: 1px solid rgba(167,139,250,0.25); border-radius: 10px;
  padding: 12px 14px; margin-bottom: 14px; line-height: 1.5;
  display: flex; align-items: center; gap: 10px;
}
.lt-step-spinner {
  width: 14px; height: 14px; border-radius: 50%; flex-shrink: 0;
  border: 2px solid rgba(167,139,250,0.3); border-top-color: #a78bfa;
  animation: lt-spin 0.8s linear infinite;
}
@keyframes lt-spin { to { transform: rotate(360deg); } }

.lt-section-title { font-size: 12px; font-weight: 700; color: #d8d4ff; margin: 4px 0 8px; letter-spacing: 0.02em; }
.lt-empty { font-size: 11px; color: rgba(255,255,255,0.35); font-style: italic; padding: 8px 0; }

.lt-card {
  border: 1px solid rgba(167,139,250,0.2); background: rgba(255,255,255,0.03);
  border-radius: 10px; padding: 10px; margin-bottom: 8px;
}
.lt-card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; gap: 8px; }
.lt-card-name { font-size: 12px; font-weight: 700; color: #a78bfa; }
.lt-card-status { font-size: 10px; color: #9ca3af; white-space: nowrap; }
.lt-card-meta { font-size: 12px; color: #e5e7eb; line-height: 1.4; }

.lt-history-link { font-size: 11px; color: #9ca3af; margin-top: 12px; cursor: pointer; text-decoration: underline; }
.lt-history-link:hover { color: #d8d4ff; }
`;
  document.head.appendChild(style);
}

async function _submitFindInstructions(inputEl, submitBtn, body) {
  const instructions = inputEl.value.trim();
  if (!instructions) return;

  submitBtn.disabled = true;
  inputEl.disabled = true;

  try {
    const res = await fetch("/api/social?platform=lead-job-create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instructions }),
    });
    const data = await res.json();
    if (!data.ok) {
      alert(`Failed to start: ${data.error}`);
      submitBtn.disabled = false;
      inputEl.disabled = false;
      return;
    }
    _activeJobId = data.job.id;
    _saveActiveJobId(_activeJobId);
    _renderJob(body, data.job);
    _startPolling(body);
  } catch (e) {
    alert(`Failed to start: ${e.message}`);
    submitBtn.disabled = false;
    inputEl.disabled = false;
  }
}

async function _submitReachoutInstructions(jobId, inputEl, submitBtn, body) {
  const instructions = inputEl.value.trim();
  if (!instructions) return;

  submitBtn.disabled = true;
  inputEl.disabled = true;

  try {
    const res = await fetch("/api/social?platform=lead-job-set-reachout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, instructions }),
    });
    const data = await res.json();
    if (!data.ok) {
      alert(`Failed: ${data.error}`);
      submitBtn.disabled = false;
      inputEl.disabled = false;
      return;
    }
    _renderJob(body, data.job);
  } catch (e) {
    alert(`Failed: ${e.message}`);
    submitBtn.disabled = false;
    inputEl.disabled = false;
  }
}

async function _pollAndAdvance(body) {
  if (!_activeJobId) return;
  try {
    const res = await fetch("/api/social?platform=lead-job-advance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: _activeJobId }),
    });
    const data = await res.json();
    if (!data.ok) return;
    _renderJob(body, data.job);

    if (data.job.status === 'complete' || data.job.status === 'failed' || data.job.status === 'no_leads_found') {
      _stopPolling();
    }
  } catch (e) {
    console.warn("[Leads] Poll/advance failed (non-fatal):", e.message);
  }
}

function _startPolling(body) {
  _stopPolling();
  _pollTimer = setInterval(() => _pollAndAdvance(body), 2000);
}

function _stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

function _renderJob(body, job) {
  body.innerHTML = "";

  const banner = document.createElement("div");
  banner.className = "lt-step-banner";
  const isActive = job.status === 'scraping_emails' || job.status === 'sending_outreach' || job.status === 'finding_businesses';
  if (isActive) {
    const spinner = document.createElement("div");
    spinner.className = "lt-step-spinner";
    banner.appendChild(spinner);
  }
  const stepText = document.createElement("span");
  stepText.textContent = job.currentStep;
  banner.appendChild(stepText);
  body.appendChild(banner);

  if (job.businesses?.length) {
    const title = document.createElement("div");
    title.className = "lt-section-title";
    title.textContent = `Businesses found (${job.businesses.length})`;
    body.appendChild(title);

    job.businesses.forEach((biz, idx) => {
      const matchedLead = job.leads?.find(l => l.domain === biz.website);
      const card = document.createElement("div");
      card.className = "lt-card";
      const header = document.createElement("div");
      header.className = "lt-card-header";
      const statusLabel = matchedLead ? "✅ Email found" : (job.scrapedCount > idx ? "— no email" : "⏳ pending");
      header.innerHTML = `<span class="lt-card-name">${biz.name}</span><span class="lt-card-status">${statusLabel}</span>`;
      card.appendChild(header);
      const meta = document.createElement("div");
      meta.className = "lt-card-meta";
      meta.textContent = `${biz.phone || "no phone listed"}${matchedLead ? ` · ${matchedLead.email}` : ""}`;
      card.appendChild(meta);
      body.appendChild(card);
    });
  }

  if (job.status === 'awaiting_reachout_instructions') {
    const title = document.createElement("div");
    title.className = "lt-section-title";
    title.textContent = "What should the outreach say?";
    body.appendChild(title);

    const row = document.createElement("div");
    row.className = "lt-input-row";
    const textarea = document.createElement("textarea");
    textarea.className = "lt-input";
    textarea.placeholder = "e.g. Introduce Joelflowstack's web/bot development services, mention we build custom automation tools, keep it warm and low-pressure...";
    const btn = document.createElement("button");
    btn.className = "lt-submit-btn";
    btn.textContent = `📤 Send outreach to ${job.leads.length} lead${job.leads.length === 1 ? "" : "s"}`;
    btn.onclick = () => _submitReachoutInstructions(job.id, textarea, btn, body);
    row.appendChild(textarea);
    row.appendChild(btn);
    body.appendChild(row);
  }

  if (job.status === 'complete') {
    _saveActiveJobId(null);
    _activeJobId = null;
    const newSearchHint = document.createElement("div");
    newSearchHint.className = "lt-history-link";
    newSearchHint.textContent = "Start a new search ↻";
    newSearchHint.onclick = () => _resetToInputForm(body, job);
    body.appendChild(newSearchHint);
  }
  if (job.status === 'failed' || job.status === 'no_leads_found') {
    _saveActiveJobId(null);
    _activeJobId = null;
    const retryHint = document.createElement("div");
    retryHint.className = "lt-history-link";
    retryHint.textContent = "Try a different search ↻";
    retryHint.onclick = () => _resetToInputForm(body, job);
    body.appendChild(retryHint);
  }
}

// REAL FIX for the exact bug Joel reported: "brought the list of leads
// briefly and then snapped to a single bar immediately — no matter
// what I do, reloading, quitting, it all still brings me to that."
// Root cause: once a job legitimately reaches 'failed' or
// 'no_leads_found' (e.g. every scraped site genuinely had no findable
// email), the OLD code cleared straight to a blank, empty input box —
// which looks IDENTICAL to a fresh, never-searched state. Reopening the
// tray later (after the terminal state is already saved) always lands
// on that same blank box, with zero indication a search even ran or
// why it stopped, which reads exactly like Joel described: broken.
// Fix: carry the just-finished job's real summary along and show it as
// a small, dismissible-by-searching-again card ABOVE the fresh input,
// instead of wiping it. This makes the terminal state visually
// distinct from "never searched yet" and honest about what happened.
function _resetToInputForm(body, lastJob) {
  _stopPolling();
  _activeJobId = null;
  _saveActiveJobId(null);
  _renderInputForm(body, lastJob);
}

function _renderInputForm(body, lastJob) {
  body.innerHTML = "";

  if (lastJob) {
    const summary = document.createElement("div");
    summary.className = "lt-step-banner";
    summary.style.opacity = "0.75";
    const scraped = lastJob.scrapedCount ?? lastJob.businesses?.length ?? 0;
    const total = lastJob.businesses?.length ?? 0;
    summary.innerHTML = lastJob.status === 'no_leads_found'
      ? `<span>⚠️ Last search ("${lastJob.niche || lastJob.instructions}") scraped ${scraped}/${total} businesses but found no usable contact emails. Try a different niche or add a location.</span>`
      : `<span>⚠️ Last search ("${lastJob.niche || lastJob.instructions}") didn't complete: ${lastJob.currentStep || 'unknown error'}.</span>`;
    body.appendChild(summary);
  }

  const hint = document.createElement("div");
  hint.className = "lt-empty";
  hint.style.marginBottom = "12px";
  hint.textContent = "Tell Flow what kind of leads to find — a niche, industry, and optionally a location. Flow finds real businesses, scrapes their real contact emails automatically, then asks what the outreach should say.";
  body.appendChild(hint);

  const row = document.createElement("div");
  row.className = "lt-input-row";
  const textarea = document.createElement("textarea");
  textarea.className = "lt-input";
  textarea.placeholder = "e.g. web design agencies in Lagos, small independent shops...";
  const btn = document.createElement("button");
  btn.className = "lt-submit-btn";
  btn.textContent = "🔍 Find leads";
  btn.onclick = () => _submitFindInstructions(textarea, btn, body);
  row.appendChild(textarea);
  row.appendChild(btn);
  body.appendChild(row);
}

export function isLeadsTrayOpen() {
  return !!_panelEl?.classList.contains("lt-open");
}

export async function openLeadsTray() {
  _injectStyles();

  // REAL BUG FIX: this used to short-circuit entirely on a reused panel
  // — just toggling the CSS class and returning, without ever
  // re-checking server state or re-rendering #leads-body. Whatever was
  // left in the body from earlier (a half-finished poll cycle, a stale
  // "no job" render, anything) just stayed there indefinitely — this is
  // almost certainly the real cause of the panel showing nothing but a
  // bare search box with no hint text or button: some prior state left
  // the body in an inconsistent partial-render, and reopening never
  // corrected it. Now every open re-fetches real status and rebuilds
  // the body fresh, regardless of whether the panel element itself is
  // being reused.
  let body;
  if (_panelEl) {
    _panelEl.classList.add("lt-open");
    document.getElementById("leads-tray-tab")?.classList.add("lt-tray-open");
    body = _panelEl.querySelector("#leads-body");
    body.innerHTML = ""; // real, explicit clear before rebuilding — no stale leftovers can survive this
  } else {
    const panel = document.createElement("div");
    panel.id = "leads-panel";

    const header = document.createElement("div");
    header.id = "leads-header";
    header.innerHTML = `<span class="lt-title">💼 Leads</span>`;
    const closeBtn = document.createElement("button");
    closeBtn.id = "leads-close-btn";
    closeBtn.textContent = "✕";
    closeBtn.onclick = () => closeLeadsTray();
    header.appendChild(closeBtn);
    panel.appendChild(header);

    body = document.createElement("div");
    body.id = "leads-body";
    panel.appendChild(body);

    document.body.appendChild(panel);
    _panelEl = panel;
  }

  const savedJobId = _loadActiveJobId();
  if (savedJobId) {
    try {
      const res = await fetch(`/api/social?platform=lead-job-status&jobId=${encodeURIComponent(savedJobId)}`);
      const data = await res.json();
      if (data.ok && data.job && !['complete', 'failed', 'no_leads_found'].includes(data.job.status)) {
        _activeJobId = savedJobId;
        _renderJob(body, data.job);
        _startPolling(body);
      } else {
        _renderInputForm(body, data.ok ? data.job : null);
      }
    } catch (_) {
      _renderInputForm(body);
    }
  } else {
    _renderInputForm(body);
  }

  requestAnimationFrame(() => {
    _panelEl.classList.add("lt-open");
    document.getElementById("leads-tray-tab")?.classList.add("lt-tray-open");
  });
  _bindOutsideClickClose();
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

function _buildToggleButton() {
  const tab = document.createElement("div");
  tab.id = "leads-tray-tab";
  tab.className = "boot-collapsed";
  tab.title = "Leads";
  tab.innerHTML = `<span class="lt-tab-icon">💼</span>`;
  tab.addEventListener("click", () => {
    if (isLeadsTrayOpen()) closeLeadsTray();
    else openLeadsTray();
  });
  document.body.appendChild(tab);
}

export function initLeadsTray() {
  _injectStyles();
  _buildToggleButton();
}
