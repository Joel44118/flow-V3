// ═══════════════════════════════════════════
// ui/slash.js — Slash Command Palette
// ═══════════════════════════════════════════

const SKILLS = [
  { cmd:"/image-flux",   icon:"🌄", label:"Photo / Art",      desc:"Realistic or artistic image via FLUX",              ph:"a futuristic Lagos skyline at night, cinematic",    group:"Images"       },
  { cmd:"/image-design", icon:"🎨", label:"Graphic Design",   desc:"Banner, poster, social post with text",             ph:'"Joelflowstack" Twitter promo, dark minimal style',  group:"Images"       },
  { cmd:"/search",       icon:"🔍", label:"Quick Search",     desc:"Search the web for current info",                   ph:"latest AI news in Nigeria 2025",                    group:"Search"       },
  { cmd:"/research",     icon:"📖", label:"Deep Research",    desc:"Multi-source deep dive on any topic",               ph:"how to grow a bot development business",            group:"Search"       },
  { cmd:"/url",          icon:"🌐", label:"Inspect Website",  desc:"Analyse a website — features, tech stack, purpose", ph:"https://example.com",                               group:"Search"       },
  { cmd:"/code",         icon:"💻", label:"Write Code",       desc:"Write or fix code in any language",                 ph:"a JavaScript debounce function",                    group:"Code"         },
  { cmd:"/alarm",        icon:"⏰", label:"Set Alarm",        desc:"Set a timed reminder",                              ph:"meeting at 3pm",                                    group:"Productivity" },
  { cmd:"/goal",         icon:"🎯", label:"Add Goal",         desc:"Add a task to today's goal list",                   ph:"finish the Joelflowstack landing page",             group:"Productivity" },
  { cmd:"/note",         icon:"📝", label:"Notepad",          desc:"Open Flow's notepad",                               ph:"",                                                  group:"Productivity" },
  { cmd:"/weather",      icon:"🌤️", label:"Weather",          desc:"Current weather + 3-day Ibadan forecast",           ph:"",                                                  group:"Productivity" },
  { cmd:"/camera",       icon:"📷", label:"Camera",           desc:"Open camera — Flow sees you",                       ph:"",                                                  group:"Vision"       },
  { cmd:"/screen",       icon:"🖥️", label:"Share Screen",     desc:"Share screen — Flow reads it",                      ph:"",                                                  group:"Vision"       },
  { cmd:"/yolo",         icon:"🔎", label:"Object Detection", desc:"Live camera with real-time object labels",           ph:"",                                                  group:"Vision"       },
];

// ── DOM refs ──────────────────────────────────────────────────────────────
let _input    = null;
let _palette  = null;
let _chip     = null;
let _hint     = null;
let _wrap     = null;
let _onNoArg  = null;

// ── State ─────────────────────────────────────────────────────────────────
let _activeCmd  = null;
let _filtered   = [];
let _activeIdx  = -1;
let _selecting  = false;  // blocks outside-click handler during selection

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
  _palette = document.createElement("div");
  _palette.id = "slash-palette";
  document.body.appendChild(_palette);

  _hint = document.createElement("div");
  _hint.id = "slash-hint";
  document.body.appendChild(_hint);
}

// ── Events ────────────────────────────────────────────────────────────────
function _bindEvents() {
  _input.addEventListener("input", _onInput);
  _input.addEventListener("keydown", _onKeydown, true);

  document.addEventListener("mousedown", e => {
    // _selecting means a palette item mousedown is mid-flight — ignore completely
    if (_selecting) return;
    if (!_palette.contains(e.target) && e.target !== _input) {
      _closePalette();
    }
  });
}

function _onInput() {
  const val = _input.value;
  if (!_activeCmd && val.startsWith("/") && !val.includes(" ")) {
    const q = val.slice(1).toLowerCase();
    _filtered  = q
      ? SKILLS.filter(s =>
          s.cmd.slice(1).includes(q) ||
          s.label.toLowerCase().includes(q) ||
          s.group.toLowerCase().includes(q))
      : SKILLS;
    _activeIdx = _filtered.length ? 0 : -1;
    _renderPalette();
    _palette.classList.add("open");
  } else {
    _closePalette();
  }
}

function _onKeydown(e) {
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
      e.preventDefault(); e.stopImmediatePropagation();
      if (_activeIdx >= 0) _selectSkill(_filtered[_activeIdx]);
      else _closePalette();
    } else if (e.key === "Escape") {
      e.preventDefault();
      _closePalette();
    }
    return;
  }

  if (_activeCmd && e.key === "Backspace" && _input.value === "") {
    e.preventDefault();
    _removeChip();
  }
}

// ── Select a skill ────────────────────────────────────────────────────────
function _selectSkill(skill) {
  // Set flag BEFORE closing palette so the outside-click handler ignores this event
  _selecting = true;

  _closePalette();
  _input.value = "";

  if (!skill.ph) {
    _onNoArg?.(skill.cmd);
    _selecting = false;
    return;
  }

  _insertChip(skill);
  _input.focus();

  // Clear the flag after the entire event chain has settled
  setTimeout(() => { _selecting = false; }, 0);
}

// ── Chip ──────────────────────────────────────────────────────────────────
function _insertChip(skill) {
  _removeChip();
  _activeCmd = skill.cmd;

  _chip = document.createElement("div");
  _chip.className = "slash-chip";
  _chip.innerHTML = `
    <span class="sc-icon">${skill.icon}</span>
    <span class="sc-label">${skill.label}</span>
    <button class="sc-close" tabindex="-1" title="Remove">✕</button>
  `;

  _chip.querySelector(".sc-close").addEventListener("mousedown", e => {
    e.preventDefault();
    e.stopPropagation();
    _removeChip();
    _input.focus();
  });

  // Insert BEFORE the input so it appears left of the text field
  _wrap.insertBefore(_chip, _input);
  _wrap.classList.add("slash-active");

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

// ── Render palette ────────────────────────────────────────────────────────
function _renderPalette() {
  if (!_filtered.length) {
    _palette.innerHTML = `<div class="slash-empty">No commands match</div>`;
    return;
  }

  const groups = {};
  _filtered.forEach((s, i) => { (groups[s.group] ??= []).push({ s, i }); });

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

    // Use mousedown (not click) so it fires before input blur
    // e.preventDefault() keeps input focused
    el.addEventListener("mousedown", e => {
      e.preventDefault();
      e.stopImmediatePropagation();
      _selectSkill(_filtered[+el.dataset.i]);
    });
  });
}

function _closePalette() {
  _palette.classList.remove("open");
  _activeIdx = -1;
}
