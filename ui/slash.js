// ═══════════════════════════════════════════
// ui/slash.js — Slash Command Palette
//
// HOW IT WORKS (final approach):
//   1. Type "/" → palette opens above input
//   2. Click or Enter → palette closes,
//      a chip appears ABOVE the input bar
//      (like Claude/ChatGPT's mention chips)
//   3. User types their prompt in the input normally
//   4. Send button reads: chip cmd + input text
//   5. Chip has ✕ to dismiss
//
// The chip is a separate DOM element — never
// touches input.value — so no accidental sends.
// ═══════════════════════════════════════════

const SKILLS = [
  { cmd:"/image-flux",   icon:"🌄", label:"Photo / Art",      desc:"Realistic or artistic image via FLUX",                     ph:"a futuristic Lagos skyline at night, cinematic",   group:"Images"       },
  { cmd:"/image-design", icon:"🎨", label:"Graphic Design",   desc:"Banner, poster, social post with text",                    ph:'"Joelflowstack" Twitter promo, dark minimal style', group:"Images"       },
  { cmd:"/search",       icon:"🔍", label:"Quick Search",     desc:"Search the web for current info",                          ph:"latest AI news in Nigeria 2025",                    group:"Search"       },
  { cmd:"/research",     icon:"📖", label:"Deep Research",    desc:"Multi-source deep dive on any topic",                      ph:"how to grow a bot development business",            group:"Search"       },
  { cmd:"/url",          icon:"🌐", label:"Inspect Website",  desc:"Analyse a website — features, tech stack, purpose",        ph:"https://example.com",                               group:"Search"       },
  { cmd:"/code",         icon:"💻", label:"Write Code",       desc:"Write or fix code in any language",                        ph:"a JavaScript debounce function",                    group:"Code"         },
  { cmd:"/alarm",        icon:"⏰", label:"Set Alarm",        desc:"Set a timed reminder",                                     ph:"meeting at 3pm",                                    group:"Productivity"  },
  { cmd:"/goal",         icon:"🎯", label:"Add Goal",         desc:"Add a task to today's goal list",                          ph:"finish the Joelflowstack landing page",             group:"Productivity"  },
  { cmd:"/note",         icon:"📝", label:"Notepad",          desc:"Open Flow's notepad",                                      ph:"",                                                  group:"Productivity"  },
  { cmd:"/weather",      icon:"🌤️", label:"Weather",          desc:"Current weather + 3-day Ibadan forecast",                  ph:"",                                                  group:"Productivity"  },
  { cmd:"/camera",       icon:"📷", label:"Camera",           desc:"Open camera — Flow sees you",                              ph:"",                                                  group:"Vision"        },
  { cmd:"/screen",       icon:"🖥️", label:"Share Screen",     desc:"Share screen — Flow reads it",                             ph:"",                                                  group:"Vision"        },
  { cmd:"/yolo",         icon:"🔎", label:"Object Detection", desc:"Live camera with real-time object labels",                  ph:"",                                                  group:"Vision"        },
];

// ── DOM refs ──────────────────────────────────────────────────────────────
let _input     = null;   // the <input type="text">
let _palette   = null;   // dropdown
let _chip      = null;   // the active chip element (or null)
let _hint      = null;   // hint label
let _wrap      = null;   // .input-panel wrapper
let _onNoArg   = null;   // callback for no-arg skills

// ── Active command ────────────────────────────────────────────────────────
let _activeCmd  = null;  // e.g. "/image-flux"
let _filtered   = [];
let _activeIdx  = -1;

// ── Init ──────────────────────────────────────────────────────────────────
export function initSlash(inputEl, onNoArg) {
  _input   = inputEl;
  _wrap    = inputEl.closest(".input-panel");
  _onNoArg = onNoArg;
  _buildDOM();
  _bindEvents();
}

// ── Read current slash state (called by app.js on send) ──────────────────
export function getSlashState() {
  if (!_activeCmd) return null;
  return { cmd: _activeCmd, prompt: _input.value.trim() };
}

// ── Clear after send ──────────────────────────────────────────────────────
export function clearSlash() {
  _removeChip();
  _input.value = "";
}

// ── Build DOM ─────────────────────────────────────────────────────────────
function _buildDOM() {
  // Palette
  _palette = document.createElement("div");
  _palette.id = "slash-palette";
  document.body.appendChild(_palette);

  // Hint label (example prompt shown when chip is active)
  _hint = document.createElement("div");
  _hint.id = "slash-hint";
  document.body.appendChild(_hint);
}

// ── Events ────────────────────────────────────────────────────────────────
function _bindEvents() {
  _input.addEventListener("input", _onInput);
  _input.addEventListener("keydown", _onKeydown, true); // capture — fires before send

  // Close palette on outside click
  document.addEventListener("mousedown", e => {
    if (!_palette.contains(e.target) && e.target !== _input) {
      _closePalette();
    }
  });
}

function _onInput() {
  const val = _input.value;

  // Only show palette if no chip is active and input starts with "/"
  if (!_activeCmd && val.startsWith("/") && !val.includes(" ")) {
    const q = val.slice(1).toLowerCase();
    _filtered  = q
      ? SKILLS.filter(s => s.cmd.slice(1).includes(q) || s.label.toLowerCase().includes(q) || s.group.toLowerCase().includes(q))
      : SKILLS;
    _activeIdx = _filtered.length ? 0 : -1;
    _renderPalette();
    _palette.classList.add("open");
  } else {
    _closePalette();
  }
}

function _onKeydown(e) {
  // If palette is open — intercept arrow keys and Enter
  if (_palette.classList.contains("open")) {
    if (e.key === "ArrowDown") {
      e.preventDefault(); e.stopImmediatePropagation();
      _activeIdx = (_activeIdx + 1) % _filtered.length;
      _renderPalette();
    } else if (e.key === "ArrowUp") {
      e.preventDefault(); e.stopImmediatePropagation();
      _activeIdx = (_activeIdx - 1 + _filtered.length) % _filtered.length;
      _renderPalette();
    } else if (e.key === "Enter") {
      e.preventDefault(); e.stopImmediatePropagation(); // NEVER let this reach sendBtn
      if (_activeIdx >= 0) _selectSkill(_filtered[_activeIdx]);
      else _closePalette();
    } else if (e.key === "Escape") {
      e.preventDefault();
      _closePalette();
    }
    return;
  }

  // If chip is active and user presses Backspace on empty input → remove chip
  if (_activeCmd && e.key === "Backspace" && _input.value === "") {
    e.preventDefault();
    _removeChip();
  }
}

// ── Select a skill ────────────────────────────────────────────────────────
function _selectSkill(skill) {
  _closePalette();
  _input.value = ""; // clear the "/" they typed

  if (!skill.ph) {
    // No-arg — fire immediately, no chip
    _onNoArg?.(skill.cmd);
    return;
  }

  // Insert chip
  _insertChip(skill);
  _input.focus();
}

// ── Chip: floats inside the input-panel, left of the input ───────────────
function _insertChip(skill) {
  _removeChip(); // clear any existing chip

  _activeCmd = skill.cmd;

  _chip = document.createElement("div");
  _chip.className = "slash-chip";
  _chip.innerHTML = `
    <span class="sc-icon">${skill.icon}</span>
    <span class="sc-label">${skill.label}</span>
    <button class="sc-close" tabindex="-1" title="Remove (Backspace)">✕</button>
  `;

  // Remove chip on ✕
  _chip.querySelector(".sc-close").addEventListener("mousedown", e => {
    e.preventDefault();
    e.stopPropagation();
    _removeChip();
    _input.focus();
  });

  // Insert chip before the input inside .input-panel
  _wrap.insertBefore(_chip, _input);
  _wrap.classList.add("slash-active");

  // Show hint
  if (skill.ph) {
    _hint.textContent = "💡 e.g. " + skill.ph;
    _hint.classList.add("visible");
  }
}

function _removeChip() {
  if (_chip) { _chip.remove(); _chip = null; }
  _activeCmd = null;
  _wrap?.classList.remove("slash-active");
  _hint?.classList.remove("visible");
}

// ── Render palette items ──────────────────────────────────────────────────
function _renderPalette() {
  if (!_filtered.length) {
    _palette.innerHTML = `<div class="slash-empty">No commands match</div>`;
    return;
  }

  const groups = {};
  _filtered.forEach((s, i) => {
    (groups[s.group] ??= []).push({ s, i });
  });

  let html = "";
  for (const [g, items] of Object.entries(groups)) {
    html += `<div class="slash-group-label">${g}</div>`;
    for (const { s, i } of items) {
      html += `<div class="slash-item${i === _activeIdx ? " active" : ""}" data-i="${i}">
        <span class="slash-icon">${s.icon}</span>
        <div class="slash-info">
          <div class="slash-label">${s.label}</div>
          <div class="slash-desc">${s.desc}</div>
        </div>
        <span class="slash-cmd">${s.cmd}</span>
      </div>`;
    }
  }
  _palette.innerHTML = html;

  _palette.querySelectorAll(".slash-item").forEach(el => {
    el.addEventListener("mouseenter", () => {
      _activeIdx = +el.dataset.i;
      _renderPalette();
    });
    el.addEventListener("mousedown", e => {
      e.preventDefault();          // don't blur the input
      e.stopImmediatePropagation();
      _selectSkill(_filtered[+el.dataset.i]);
    });
  });
}

function _closePalette() {
  _palette.classList.remove("open");
  _activeIdx = -1;
}
