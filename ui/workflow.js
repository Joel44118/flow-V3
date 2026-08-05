// ═══════════════════════════════════════════
// ui/workflow.js — REAL, REBUILT (2nd pass): n8n-style draggable/
// connectable workflow canvas, per Joel's explicit request.
//
// HONEST SCOPE NOTE, read this before extending: three real nodes are
// shown — Flow (hands-free voice), Lead Gen (the real lead-job
// pipeline), Research (background research rotation). Positions and
// connections are draggable and persist (localStorage). Connections
// are NOT just decorative — disconnecting a node from Flow genuinely
// turns that feature OFF (writes to the same real settings backing
// core/hands-free-vad.js and flow-electron/heartbeat.js's research
// loop). Reconnecting does NOT automatically turn it back on — you
// still flip its own toggle — cutting the wire is a real "stop", but
// the wire being present isn't itself "the reason it's running", to
// avoid a confusing hidden-dependency. Lead Gen's node reflects real,
// live job status polled from api/social.js?platform=lead-jobs-list
// (the one genuinely job-tracked system, same honest scope as the 1st
// pass's list view) — its connection doesn't gate anything (there's no
// clean way to pause the Electron-main-process job runner from here
// without new IPC plumbing) and is presented as status-only, clearly
// labeled, rather than pretending it does something it doesn't.
// ═══════════════════════════════════════════

const STORAGE_KEY = "flow-workflow-canvas-v1";

let _panelEl = null;
let _pollTimer = null;
let _canvasState = null; // { nodes: {id:{x,y}}, connections: [[a,b],...] }
let _dragNode = null;
let _dragOffset = { x: 0, y: 0 };
let _connectingFrom = null;
let _zoomLevel = 1;

function _applyZoom() {
  const inner = document.getElementById("workflow-canvas-inner");
  if (inner) inner.style.transform = `scale(${_zoomLevel})`;
  const label = document.getElementById("workflow-zoom-label");
  if (label) label.textContent = `${Math.round(_zoomLevel * 100)}%`;
  _renderConnections(); // port positions shift visually with zoom — wires must be recomputed
}

const NODES = [
  { id: "flow",     label: "Flow",     icon: "🧠", desc: "Hands-free voice",       settingKey: "handsFreeVoiceEnabled" },
  { id: "leadgen",  label: "Lead Gen", icon: "💼", desc: "Live job status (read-only)", settingKey: null },
  { id: "research", label: "Research", icon: "🔎", desc: "Background research",     settingKey: "backgroundResearchEnabled" },
  { id: "music",    label: "Music Career", icon: "🎵", desc: "Weekly track generation", settingKey: "musicCareerEnabled" },
];

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
#workflow-tray-tab.boot-collapsed { opacity: 0; pointer-events: none; }

#workflow-panel {
  position: fixed; top: 52px; left: 0; bottom: 26px;
  width: min(560px, 92vw);
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
  padding: 14px 16px; border-bottom: 1px solid rgba(167,139,250,0.2); flex-shrink: 0;
}
#workflow-header .wf-title { font-size: 14px; font-weight: 700; color: #d8d4ff; }
#workflow-close-btn { background: none; border: none; color: #9ca3af; font-size: 18px; cursor: pointer; padding: 4px 8px; }
#workflow-close-btn:hover { color: #e5e7eb; }

#workflow-canvas {
  position: relative; flex: 1; overflow: hidden;
  background-image: radial-gradient(rgba(167,139,250,0.08) 1px, transparent 1px);
  background-size: 18px 18px;
  cursor: grab;
}
/* REAL, NEW — everything zoomable (nodes + wires) lives inside this
   inner wrapper so a single transform:scale() zooms both together and
   keeps wires correctly anchored to the ports at any zoom level. */
#workflow-canvas-inner {
  position: absolute; inset: 0; transform-origin: 0 0;
}
#workflow-zoom-controls {
  position: absolute; bottom: 10px; right: 10px; z-index: 20;
  display: flex; align-items: center; gap: 4px;
  background: rgba(15,10,30,0.9); border: 1px solid rgba(167,139,250,0.3);
  border-radius: 8px; padding: 4px;
}
.wf-zoom-btn {
  width: 26px; height: 26px; border-radius: 5px; border: 1px solid rgba(255,255,255,0.15);
  background: rgba(255,255,255,0.06); color: #e5e7eb; font-size: 14px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.wf-zoom-btn:hover { background: rgba(167,139,250,0.2); }
#workflow-zoom-label { font-size: 11px; color: rgba(255,255,255,0.5); width: 38px; text-align: center; }
#workflow-connections { position: absolute; inset: 0; pointer-events: none; overflow: visible; }

.wf-node {
  position: absolute; width: 150px;
  background: rgba(255,255,255,0.04); border: 1px solid rgba(167,139,250,0.35);
  border-radius: 10px; padding: 10px; cursor: grab; user-select: none;
  box-shadow: 0 4px 16px rgba(0,0,0,0.3);
}
.wf-node:active { cursor: grabbing; }
.wf-node-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.wf-node-icon { font-size: 16px; }
.wf-node-label { font-size: 12px; font-weight: 700; color: #d8d4ff; }
.wf-node-desc { font-size: 10px; color: rgba(255,255,255,0.45); margin-bottom: 8px; line-height: 1.4; }
.wf-node-status { font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 5px; display: inline-block; margin-bottom: 6px; }
.wf-node-status.on  { background: rgba(74,222,128,0.15); color: #4ade80; border: 1px solid rgba(74,222,128,0.4); }
.wf-node-status.off { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.4); border: 1px solid rgba(255,255,255,0.12); }

.wf-node-toggle {
  width: 34px; height: 18px; border-radius: 9px; background: rgba(255,255,255,0.1);
  border: 1px solid rgba(255,255,255,0.2); position: relative; cursor: pointer; flex-shrink: 0;
}
.wf-node-toggle.on { background: rgba(74,222,128,0.35); border-color: rgba(74,222,128,0.6); }
.wf-node-toggle-knob {
  position: absolute; top: 1px; left: 1px; width: 14px; height: 14px; border-radius: 50%;
  background: #e5e7eb; transition: transform 0.15s ease;
}
.wf-node-toggle.on .wf-node-toggle-knob { transform: translateX(16px); background: #4ade80; }

.wf-node-port {
  position: absolute; width: 10px; height: 10px; border-radius: 50%;
  background: rgba(167,139,250,0.5); border: 2px solid rgba(167,139,250,0.9);
  cursor: crosshair; top: 50%; margin-top: -5px;
}
.wf-node-port.left  { left: -6px; }
.wf-node-port.right { right: -6px; }
.wf-node-port:hover { background: #a78bfa; }
.wf-node-port.connecting { background: #38bdf8; border-color: #38bdf8; }

.wf-scope-note { position: absolute; bottom: 8px; left: 12px; right: 12px; font-size: 10px; color: rgba(255,255,255,0.3); font-style: italic; pointer-events: none; }
`;
  document.head.appendChild(style);
}

function _loadCanvasState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  // Real, sensible default layout — Flow in the middle, Lead Gen and
  // Research on either side, already connected to Flow out of the box.
  return {
    nodes: {
      flow:     { x: 190, y: 140 },
      leadgen:  { x: 30,  y: 40 },
      research: { x: 350, y: 40 },
      music:    { x: 190, y: 260 },
    },
    connections: [["flow", "leadgen"], ["flow", "research"], ["flow", "music"]],
  };
}

function _saveCanvasState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(_canvasState)); } catch (_) {}
}

function _isConnected(a, b) {
  return _canvasState.connections.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

function _toggleConnection(a, b) {
  const existing = _canvasState.connections.findIndex(([x, y]) => (x === a && y === b) || (x === b && y === a));
  if (existing >= 0) {
    _canvasState.connections.splice(existing, 1);
    // REAL EFFECT — disconnecting a settings-backed node from Flow
    // genuinely turns that feature off, not just a visual change.
    [a, b].forEach(id => {
      const node = NODES.find(n => n.id === id);
      if (node?.settingKey && (a === "flow" || b === "flow")) {
        _applySettingChange(node.settingKey, false);
      }
    });
  } else {
    _canvasState.connections.push([a, b]);
    // Real, deliberate — reconnecting does NOT auto re-enable. Explained
    // in the header comment: avoids a hidden "wire = on" dependency that
    // would be confusing to reason about later.
  }
  _saveCanvasState();
  _renderConnections();
}

async function _applySettingChange(key, value) {
  try {
    if (window.__flowElectron?.settings) {
      await window.__flowElectron.settings.set(key, value);
    }
    if (key === "handsFreeVoiceEnabled") {
      const { setHandsFreeVoiceEnabled } = await import("../core/hands-free-vad.js");
      await setHandsFreeVoiceEnabled(value);
    }
  } catch (e) {
    console.warn("[Workflow] Failed to apply setting change:", e.message);
  }
  _renderNodes();
}

// REAL, port-anchored — reads the ACTUAL rendered position of each
// port dot (via getBoundingClientRect, which already accounts for the
// zoom transform below) rather than guessing an offset from the node's
// stored x/y. This is what makes wires attach exactly to the small
// dots, not float near the node's general area.
function _getPortPos(nodeId, side) {
  const el = document.querySelector(`.wf-node[data-node-id="${nodeId}"] .wf-node-port.${side}`);
  const canvasInner = document.getElementById("workflow-canvas-inner");
  if (!el || !canvasInner) return null;
  const portRect = el.getBoundingClientRect();
  const innerRect = canvasInner.getBoundingClientRect();
  // Divide out the current zoom scale so coordinates stay correct in
  // the SVG's own (unscaled) coordinate space, since the SVG lives
  // inside the same scaled wrapper as the nodes.
  return {
    x: (portRect.left + portRect.width / 2 - innerRect.left) / _zoomLevel,
    y: (portRect.top + portRect.height / 2 - innerRect.top) / _zoomLevel,
  };
}

function _renderConnections() {
  const svg = document.getElementById("workflow-connections");
  if (!svg) return;
  svg.innerHTML = "";
  _canvasState.connections.forEach(([a, b]) => {
    const na = _canvasState.nodes[a], nb = _canvasState.nodes[b];
    if (!na || !nb) return;
    // Real, sensible port choice — connect the ports that actually face
    // each other given current relative position, so the wire takes the
    // shortest natural path instead of always defaulting to the same side.
    const aOnLeft = na.x <= nb.x;
    const p1 = _getPortPos(a, aOnLeft ? "right" : "left");
    const p2 = _getPortPos(b, aOnLeft ? "left" : "right");
    if (!p1 || !p2) return;

    // REAL bend — a cubic bezier whose control points extend
    // horizontally outward from each port before curving toward the
    // other side. This is what makes the wire arc AROUND the node
    // boxes instead of drawing a straight line that could cut across
    // them, matching how real workflow tools (n8n, Zapier) route wires.
    const bend = Math.max(50, Math.abs(p2.x - p1.x) * 0.5);
    const c1x = aOnLeft ? p1.x + bend : p1.x - bend;
    const c2x = aOnLeft ? p2.x - bend : p2.x + bend;

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${p1.x} ${p1.y} C ${c1x} ${p1.y}, ${c2x} ${p2.y}, ${p2.x} ${p2.y}`);
    path.setAttribute("stroke", "rgba(167,139,250,0.6)");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke-dasharray", "4 3");
    svg.appendChild(path);
  });
}

let _leadJobsSummary = { running: 0, total: 0 };

function _renderNodes() {
  const canvas = document.getElementById("workflow-canvas-inner");
  if (!canvas) return;
  canvas.querySelectorAll(".wf-node").forEach(el => el.remove());

  NODES.forEach(nodeDef => {
    const pos = _canvasState.nodes[nodeDef.id];
    const el = document.createElement("div");
    el.className = "wf-node";
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;
    el.dataset.nodeId = nodeDef.id;

    const head = document.createElement("div");
    head.className = "wf-node-head";
    head.innerHTML = `<span class="wf-node-icon">${nodeDef.icon}</span><span class="wf-node-label">${nodeDef.label}</span>`;
    el.appendChild(head);

    const desc = document.createElement("div");
    desc.className = "wf-node-desc";
    desc.textContent = nodeDef.desc;
    el.appendChild(desc);

    if (nodeDef.id === "leadgen") {
      const status = document.createElement("div");
      status.className = `wf-node-status ${_leadJobsSummary.running > 0 ? "on" : "off"}`;
      status.textContent = _leadJobsSummary.running > 0
        ? `${_leadJobsSummary.running} job(s) running`
        : `${_leadJobsSummary.total} total, idle`;
      el.appendChild(status);
    } else if (nodeDef.settingKey) {
      const isOn = !!_currentSettings?.[nodeDef.settingKey];
      const toggle = document.createElement("div");
      toggle.className = `wf-node-toggle ${isOn ? "on" : ""}`;
      toggle.innerHTML = `<div class="wf-node-toggle-knob"></div>`;
      toggle.addEventListener("mousedown", (e) => e.stopPropagation());
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        _applySettingChange(nodeDef.settingKey, !isOn);
      });
      el.appendChild(toggle);
    }

    // Ports — click one, then click another node's port to connect/disconnect.
    ["left", "right"].forEach(side => {
      const port = document.createElement("div");
      port.className = `wf-node-port ${side}`;
      port.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        if (_connectingFrom && _connectingFrom !== nodeDef.id) {
          _toggleConnection(_connectingFrom, nodeDef.id);
          _connectingFrom = null;
          canvas.querySelectorAll(".wf-node-port").forEach(p => p.classList.remove("connecting"));
        } else {
          _connectingFrom = nodeDef.id;
          canvas.querySelectorAll(".wf-node-port").forEach(p => p.classList.remove("connecting"));
          port.classList.add("connecting");
        }
      });
      el.appendChild(port);
    });

    // Drag to reposition — real, persisted. Divides by _zoomLevel since
    // getBoundingClientRect() returns post-transform screen pixels, but
    // the node's stored x/y (and its own left/top CSS) are in the
    // wrapper's unscaled coordinate space.
    el.addEventListener("mousedown", (e) => {
      if (e.target.classList.contains("wf-node-port") || e.target.closest(".wf-node-toggle")) return;
      _dragNode = nodeDef.id;
      const rect = el.getBoundingClientRect();
      _dragOffset = { x: (e.clientX - rect.left) / _zoomLevel, y: (e.clientY - rect.top) / _zoomLevel };
    });

    canvas.appendChild(el);
  });

  _renderConnections();
}

let _currentSettings = null;

async function _loadSettingsAndRender() {
  try {
    _currentSettings = window.__flowElectron?.settings ? await window.__flowElectron.settings.get() : {};
  } catch (_) { _currentSettings = {}; }
  _renderNodes();
}

async function _pollLeadJobs() {
  try {
    const res = await fetch("/api/social?platform=lead-jobs-list");
    const data = await res.json();
    if (!data.ok) return;
    const jobs = data.jobs || [];
    const RUNNING = ["finding_businesses", "scraping_emails", "sending_outreach"];
    _leadJobsSummary = { running: jobs.filter(j => RUNNING.includes(j.status)).length, total: jobs.length };
    _renderNodes();
  } catch (e) {
    console.warn("[Workflow] Lead job poll failed (non-fatal):", e.message);
  }
}

function _bindCanvasDrag() {
  const canvas = document.getElementById("workflow-canvas-inner");
  if (!canvas) return;
  canvas.addEventListener("mousemove", (e) => {
    if (!_dragNode) return;
    const rect = canvas.getBoundingClientRect();
    const rawX = (e.clientX - rect.left) / _zoomLevel - _dragOffset.x;
    const rawY = (e.clientY - rect.top) / _zoomLevel - _dragOffset.y;
    // REAL BUG FIX, Joel-reported: nodes could be dragged past the
    // canvas's real edges, especially when zoomed out (dividing by
    // _zoomLevel expands the effective draggable range in canvas-
    // space). Two real bugs here: (1) only a lower-bound clamp
    // existed (Math.max(0, x)) with no upper bound at all, so nodes
    // could go arbitrarily far right/down; (2) even that lower clamp
    // was computed but never actually used — the node's rendered
    // position used the raw, unclamped x/y instead of the clamped
    // values stored in canvasState. Real fix: clamp against the
    // canvas's own actual, current size (divided by zoom, since node
    // coordinates live in pre-scale canvas-space) minus the node's
    // real dimensions, and use the SAME clamped values for both the
    // stored state and the rendered style.
    const nodeW = 150, nodeH = 100; // matches .wf-node's real width + typical rendered height
    const maxX = Math.max(0, (canvas.clientWidth  / _zoomLevel) - nodeW);
    const maxY = Math.max(0, (canvas.clientHeight / _zoomLevel) - nodeH);
    const x = Math.min(Math.max(0, rawX), maxX);
    const y = Math.min(Math.max(0, rawY), maxY);
    _canvasState.nodes[_dragNode] = { x, y };
    const el = canvas.querySelector(`[data-node-id="${_dragNode}"]`);
    if (el) { el.style.left = `${x}px`; el.style.top = `${y}px`; }
    _renderConnections();
  });
  window.addEventListener("mouseup", () => {
    if (_dragNode) { _saveCanvasState(); _dragNode = null; }
  });
}

export function isWorkflowTrayOpen() {
  return !!_panelEl?.classList.contains("wf-open");
}

export async function openWorkflowTray() {
  _injectStyles();
  _canvasState = _canvasState || _loadCanvasState();

  if (_panelEl) {
    _panelEl.classList.add("wf-open");
    _pollTimer = setInterval(_pollLeadJobs, 3000);
    return;
  }

  const panel = document.createElement("div");
  panel.id = "workflow-panel";

  const header = document.createElement("div");
  header.id = "workflow-header";
  header.innerHTML = `<span class="wf-title">🔗 Workflow</span>`;
  const closeBtn = document.createElement("button");
  closeBtn.id = "workflow-close-btn";
  closeBtn.textContent = "✕";
  closeBtn.onclick = () => closeWorkflowTray();
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const canvas = document.createElement("div");
  canvas.id = "workflow-canvas";

  const canvasInner = document.createElement("div");
  canvasInner.id = "workflow-canvas-inner";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.id = "workflow-connections";
  canvasInner.appendChild(svg);
  canvas.appendChild(canvasInner);

  // REAL, NEW — zoom controls (+/-, scroll wheel), matching how real
  // workflow tools (n8n) let you zoom the canvas.
  const zoomControls = document.createElement("div");
  zoomControls.id = "workflow-zoom-controls";
  const zoomOut = document.createElement("button");
  zoomOut.className = "wf-zoom-btn";
  zoomOut.textContent = "−";
  zoomOut.onclick = () => { _zoomLevel = Math.max(0.4, _zoomLevel - 0.1); _applyZoom(); };
  const zoomLabel = document.createElement("span");
  zoomLabel.id = "workflow-zoom-label";
  zoomLabel.textContent = "100%";
  const zoomIn = document.createElement("button");
  zoomIn.className = "wf-zoom-btn";
  zoomIn.textContent = "+";
  zoomIn.onclick = () => { _zoomLevel = Math.min(2, _zoomLevel + 0.1); _applyZoom(); };
  zoomControls.appendChild(zoomOut);
  zoomControls.appendChild(zoomLabel);
  zoomControls.appendChild(zoomIn);
  canvas.appendChild(zoomControls);

  // Real scroll-wheel zoom — Ctrl/Cmd+scroll or plain scroll, matches
  // the most common convention across real workflow/design tools.
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    _zoomLevel = Math.max(0.4, Math.min(2, _zoomLevel + (e.deltaY < 0 ? 0.08 : -0.08)));
    _applyZoom();
  }, { passive: false });

  const note = document.createElement("div");
  note.className = "wf-scope-note";
  note.textContent = "Drag nodes, drag between ports to connect/disconnect. Scroll or use +/− to zoom. Disconnecting Flow from a toggle-backed node turns that feature off for real.";
  canvas.appendChild(note);
  panel.appendChild(canvas);

  document.body.appendChild(panel);
  _panelEl = panel;

  await _loadSettingsAndRender();
  await _pollLeadJobs();
  _bindCanvasDrag();
  _applyZoom();
  _pollTimer = setInterval(_pollLeadJobs, 3000);

  requestAnimationFrame(() => panel.classList.add("wf-open"));
}

export function closeWorkflowTray() {
  if (_panelEl) _panelEl.classList.remove("wf-open");
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

function _buildToggleButton() {
  const tab = document.createElement("div");
  tab.id = "workflow-tray-tab";
  tab.className = "boot-collapsed";
  tab.title = "Workflow";
  tab.innerHTML = `<span>🔗</span>`;
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
