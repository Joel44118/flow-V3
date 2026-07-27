// ═══════════════════════════════════════════
// ui/leads.js — Prospects/Leads tray, extracted from Content Lab per
// Joel's explicit request into its own standalone left-edge tray. Same
// real tray/tab pattern as content-lab.js and thought-log.js (slide-in
// panel, edge-anchored tab, no drag) — just mirrored onto the LEFT edge
// instead of the right, stacked below the new Chats tray (see chat-tray.js).
//
// Real capability, unchanged from when this lived inside Content Lab:
//   1. Manual single-domain lookup — type a domain, Flow resolves a real
//      verified contact via Snov.io and sends the first outreach email
//      automatically (no approval gate — Joel's explicit rule).
//   2. NEW — niche-based discovery via the "/find leads [niche]" chat
//      command (handled in core/commands.js), which runs the real
//      Apify (business discovery) + ScrapeGraphAI (email extraction)
//      pipeline. Results land in the same KV-backed lead list this tray
//      polls, so they show up here automatically — no separate UI
//      needed for that path.
// Every lead's real status (new → outreach_sent → replied) is shown
// live, converging with the same Telegram reply-escalation logic on one
// KV source of truth.
// ═══════════════════════════════════════════

let _panelEl = null;
let _leadPollTimer = null;

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
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; z-index: 9998; color: #a78bfa; font-size: 16px;
  box-shadow: 4px 0 16px rgba(0,0,0,0.35);
  transition: background 0.15s ease, width 0.15s ease;
}
#leads-tray-tab:hover { background: rgba(50,35,85,0.98); width: 32px; }
#leads-tray-tab .lt-tab-arrow { transition: transform 0.2s ease; }
#leads-tray-tab.lt-tray-open .lt-tab-arrow { transform: rotate(180deg); }

#leads-panel {
  position: fixed; top: 0; left: 0; bottom: 0;
  width: min(420px, 92vw);
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

.lt-form { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
.lt-input {
  background: rgba(255,255,255,0.04); border: 1px solid rgba(167,139,250,0.25);
  border-radius: 8px; padding: 9px 11px; font-size: 12px; color: #e5e7eb; outline: none;
}
.lt-input::placeholder { color: rgba(255,255,255,0.3); }
.lt-input:focus { border-color: rgba(167,139,250,0.6); }
.lt-add-btn {
  border: 1px solid rgba(167,139,250,0.4); background: rgba(167,139,250,0.15); color: #d8d4ff;
  border-radius: 8px; padding: 9px 11px; font-size: 12px; font-weight: 600; cursor: pointer;
}
.lt-add-btn:hover { background: rgba(167,139,250,0.25); }
.lt-add-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.lt-form-status { font-size: 11px; color: #9ca3af; min-height: 14px; }

.lt-niche-hint {
  font-size: 11px; color: rgba(255,255,255,0.4); margin-bottom: 12px; line-height: 1.5;
  background: rgba(167,139,250,0.08); border: 1px solid rgba(167,139,250,0.15);
  border-radius: 8px; padding: 10px 12px;
}
.lt-niche-hint code {
  background: rgba(0,0,0,0.3); padding: 1px 5px; border-radius: 4px; color: #a78bfa;
}

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
.lt-card-reply { font-size: 12px; color: #e5e7eb; font-style: italic; margin-top: 6px; }
`;
  document.head.appendChild(style);
}

async function _handleAddLead(domainInput, contextInput, statusEl, listEl, btn) {
  const domain = domainInput.value.trim();
  if (!domain) { statusEl.textContent = "Enter a domain first."; return; }

  btn.disabled = true;
  statusEl.textContent = "🔍 Searching for a real contact...";

  try {
    const searchRes = await fetch("/api/social?platform=lead-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain, context: contextInput.value.trim() || null }),
    });
    const searchData = await searchRes.json();
    if (!searchData.ok) {
      statusEl.textContent = `⚠️ ${searchData.error}`;
      btn.disabled = false;
      return;
    }

    const name = [searchData.lead.firstName, searchData.lead.lastName].filter(Boolean).join(" ") || searchData.lead.email;
    statusEl.textContent = `✅ Found ${name} — sending first outreach...`;

    const outreachRes = await fetch("/api/social?platform=lead-outreach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leadId: searchData.lead.id }),
    });
    const outreachData = await outreachRes.json();
    if (!outreachData.ok) {
      statusEl.textContent = `⚠️ Found contact but outreach failed: ${outreachData.error}`;
    } else {
      statusEl.textContent = `✅ Outreach sent to ${name} (${searchData.lead.email})`;
      domainInput.value = "";
      contextInput.value = "";
    }
    await _pollLeads(listEl);
  } catch (e) {
    statusEl.textContent = `⚠️ ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function _pollLeads(listEl) {
  try {
    const res = await fetch("/api/social?platform=leads-list");
    const data = await res.json();
    if (!data.ok) return;
    _renderLeadCards(listEl, data.leads || []);
  } catch (e) {
    console.warn("[Leads] Poll failed (non-fatal):", e.message);
  }
}

function _renderLeadCards(listEl, leads) {
  if (!leads.length) {
    listEl.innerHTML = `<div class="lt-empty">No prospects yet — add a domain above, or type "/find leads [niche]" in chat to discover a whole list at once.</div>`;
    return;
  }
  listEl.innerHTML = "";
  const statusOrder = { replied: 0, outreach_sent: 1, new: 2 };
  const sorted = [...leads].sort((a, b) => {
    const diff = (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3);
    if (diff !== 0) return diff;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });

  for (const lead of sorted) {
    const card = document.createElement("div");
    card.className = "lt-card";

    const label = lead.status === "replied" ? "💼 Replied — yours now" : lead.status === "outreach_sent" ? "📤 Outreach sent" : "🆕 New";
    const name = [lead.firstName, lead.lastName].filter(Boolean).join(" ") || lead.email;

    const header = document.createElement("div");
    header.className = "lt-card-header";
    header.innerHTML = `<span class="lt-card-name">${name}</span><span class="lt-card-status">${label}</span>`;
    card.appendChild(header);

    const meta = document.createElement("div");
    meta.className = "lt-card-meta";
    meta.textContent = `${lead.companyName || lead.domain}${lead.position ? ` — ${lead.position}` : ""} · ${lead.email}`;
    card.appendChild(meta);

    if (lead.status === "replied" && lead.replySnippet) {
      const replyPreview = document.createElement("div");
      replyPreview.className = "lt-card-reply";
      replyPreview.textContent = `"${lead.replySnippet}"`;
      card.appendChild(replyPreview);
    }

    listEl.appendChild(card);
  }
}

function _startLeadPolling(listEl) {
  _stopLeadPolling();
  _pollLeads(listEl);
  _leadPollTimer = setInterval(() => _pollLeads(listEl), 20 * 1000);
}

function _stopLeadPolling() {
  if (_leadPollTimer) { clearInterval(_leadPollTimer); _leadPollTimer = null; }
}

export function isLeadsTrayOpen() {
  return !!_panelEl?.classList.contains("lt-open");
}

export function openLeadsTray() {
  _injectStyles();

  if (_panelEl) {
    _panelEl.classList.add("lt-open");
    document.getElementById("leads-tray-tab")?.classList.add("lt-tray-open");
    return;
  }

  const panel = document.createElement("div");
  panel.id = "leads-panel";

  const header = document.createElement("div");
  header.id = "leads-header";
  header.innerHTML = `<span class="lt-title">💼 Prospects</span>`;
  const closeBtn = document.createElement("button");
  closeBtn.id = "leads-close-btn";
  closeBtn.textContent = "✕";
  closeBtn.onclick = () => closeLeadsTray();
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const body = document.createElement("div");
  body.id = "leads-body";

  const nicheHint = document.createElement("div");
  nicheHint.className = "lt-niche-hint";
  nicheHint.innerHTML = `Want a whole list at once? Type <code>/find leads [niche]</code> in chat — e.g. <code>/find leads web design agencies in Lagos</code>. Flow finds real businesses and extracts verified contact emails automatically.`;
  body.appendChild(nicheHint);

  const sectionTitle = document.createElement("div");
  sectionTitle.className = "lt-section-title";
  sectionTitle.textContent = "Add a single domain";
  body.appendChild(sectionTitle);

  const leadForm = document.createElement("div");
  leadForm.className = "lt-form";
  const domainInput = document.createElement("input");
  domainInput.type = "text";
  domainInput.placeholder = "company domain, e.g. acmecorp.com";
  domainInput.className = "lt-input";
  const contextInput = document.createElement("input");
  contextInput.type = "text";
  contextInput.placeholder = "context (optional) — where you found them, what they need";
  contextInput.className = "lt-input";
  const addLeadBtn = document.createElement("button");
  addLeadBtn.className = "lt-add-btn";
  addLeadBtn.textContent = "🔍 Find contact & reach out";
  leadForm.appendChild(domainInput);
  leadForm.appendChild(contextInput);
  leadForm.appendChild(addLeadBtn);

  const leadFormStatus = document.createElement("div");
  leadFormStatus.className = "lt-form-status";
  leadForm.appendChild(leadFormStatus);
  body.appendChild(leadForm);

  const leadsListTitle = document.createElement("div");
  leadsListTitle.className = "lt-section-title";
  leadsListTitle.textContent = "Pipeline";
  body.appendChild(leadsListTitle);

  const leadsList = document.createElement("div");
  leadsList.id = "leads-list";
  body.appendChild(leadsList);

  addLeadBtn.onclick = () => _handleAddLead(domainInput, contextInput, leadFormStatus, leadsList, addLeadBtn);

  panel.appendChild(body);
  document.body.appendChild(panel);
  _panelEl = panel;

  _startLeadPolling(leadsList);

  requestAnimationFrame(() => {
    panel.classList.add("lt-open");
    document.getElementById("leads-tray-tab")?.classList.add("lt-tray-open");
  });
}

export function closeLeadsTray() {
  if (_panelEl) _panelEl.classList.remove("lt-open");
  document.getElementById("leads-tray-tab")?.classList.remove("lt-tray-open");
  _stopLeadPolling();
}

function _buildToggleButton() {
  const tab = document.createElement("div");
  tab.id = "leads-tray-tab";
  tab.title = "Prospects";
  tab.innerHTML = `<span class="lt-tab-arrow">▶</span>`;
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
