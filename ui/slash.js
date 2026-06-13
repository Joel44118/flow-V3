// ═══════════════════════════════════════════
// ui/slash.js — Slash Command Palette
//
// ARCHITECTURE (final, definitive):
//   - Palette: fixed div appended to body
//   - Chip: fixed div appended to body (NOT inside input-panel)
//     Positioned above the input bar via CSS bottom value
//   - No insertBefore, no closest(), no mousedown tricks
//   - Works on mouse AND touch
// ═══════════════════════════════════════════

const SKILLS = [
  { cmd:"/image-flux",   icon:"🌄", label:"Photo / Art",      desc:"Realistic or artistic image via FLUX",              ph:"a futuristic Lagos skyline at night, cinematic",    group:"Images"       },
  { cmd:"/image-design", icon:"🎨", label:"Graphic Design",   desc:"Banner, poster, social post with text",             ph:'"Joelflowstack" Twitter promo, dark minimal style',  group:"Images"       },
  { cmd:"/search",       icon:"🔍", label:"Quick Search",     desc:"Search the web for current info",                   ph:"latest AI news in Nigeria 2025",                    group:"Search"       },
  { cmd:"/research",     icon:"📖", label:"Deep Research",    desc:"Multi-source deep dive on any topic",               ph:"how to grow a bot development business",            group:"Search"       },
  { cmd:"/url",          icon:"🌐", label:"Inspect Website",  desc:"Analyse a website — features, tech stack, purpose", ph:"https://example.com",                               group:"Search"       },
  { cmd:"/intel",    icon:"🌍", label:"World Intel",    desc:"Live news, markets, conflicts & tech — what to act on today", ph:"tech trends  or  markets  or  Nigeria  or leave blank for full brief", group:"Search"       },
  { cmd:"/github", icon:"🐙", label:"GitHub Repo",     desc:"Extract code from any GitHub repo or search repos",  ph:"https://github.com/owner/repo  or  YOLO browser implementation", group:"Code" },
  { cmd:"/code",         icon:"💻", label:"Write Code",       desc:"Write or fix code in any language",                 ph:"a JavaScript debounce function",                    group:"Code"         },
  { cmd:"/project", icon:"📁", label:"Projects",       desc:"View, create and manage your project workspaces",   ph:"Flow V3  or  show my projects  or  add project MyApp", group:"Productivity" },
  { cmd:"/alarm",        icon:"⏰", label:"Set Alarm",        desc:"Set a timed reminder",                              ph:"meeting at 3pm",                                    group:"Productivity" },
  { cmd:"/goal",         icon:"🎯", label:"Add Goal",         desc:"Add a task to today's goal list",                   ph:"finish the Joelflowstack landing page",             group:"Productivity" },
  { cmd:"/note",         icon:"📝", label:"Notepad",          desc:"Open Flow's notepad",                               ph:"",                                                  group:"Productivity" },
  { cmd:"/weather",      icon:"🌤️", label:"Weather",          desc:"Current weather + 3-day Ibadan forecast",           ph:"",                                                  group:"Productivity" },
  { cmd:"/camera",       icon:"📷", label:"Camera",           desc:"Open camera — Flow sees you",                       ph:"",                                                  group:"Vision"       },
  { cmd:"/screen",       icon:"🖥️", label:"Share Screen",     desc:"Share screen — Flow reads it",                      ph:"",                                                  group:"Vision"       },
  { cmd:"/yolo",         icon:"🔎", label:"Object Detection", desc:"Live camera with real-time object labels",           ph:"",                                                  group:"Vision"       },
];

// ── DOM refs ──────────────────────────────────────────────────────────────
let _input   = null;
let _palette = null;
let _chip    = null;   // fixed div on body
let _hint    = null;   // fixed div on body
let _onNoArg = null;

// ── State ─────────────────────────────────────────────────────────────────
let _activeCmd = null;
let _filtered  = [];
let _activeIdx = -1;

// ── Init ──────────────────────────────────────────────────────────────────
export function initSlash(inputEl, onNoArg) {
  _input   = inputEl;
  _onNoArg = onNoArg;
  _buildDOM();
  _bindEvents();
}

export function getSlashState() {
  if (!_activeCmd) return null;
  return { cmd: _activeCmd, prompt: _input.textContent.trim() };
}

export function clearSlash() {
  _removeChip();
  _input.textContent = "";
}

// ── Build DOM ─────────────────────────────────────────────────────────────
function _buildDOM() {
  // Palette
  _palette = document.createElement("div");
  _palette.id = "slash-palette";
  document.body.appendChild(_palette);

  // Chip (hidden until a skill is selected)
  _chip = document.createElement("div");
  _chip.id = "slash-chip";
  _chip.style.display = "none";
  _chip.innerHTML = `
    <span id="sc-icon"></span>
    <span id="sc-label"></span>
    <button id="sc-close" tabindex="-1">✕</button>
  `;
  document.body.appendChild(_chip);

  // Hint
  _hint = document.createElement("div");
  _hint.id = "slash-hint";
  document.body.appendChild(_hint);

  // Close chip button
  document.getElementById("sc-close").addEventListener("click", e => {
    e.stopPropagation();
    _removeChip();
    _input.focus();
  });
}

// ── Events ────────────────────────────────────────────────────────────────
function _bindEvents() {
  _input.addEventListener("input", _onInput);
  _input.addEventListener("keydown", _onKeydown, true);

  // Close palette on outside click/tap
  document.addEventListener("pointerdown", e => {
    if (!_palette.contains(e.target) &&
        e.target !== _input &&
        !_chip.contains(e.target)) {
      _closePalette();
    }
  });
}

function _onInput() {
  const val = _input.textContent;

  // Show palette only when no chip active and typing a slash command
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

  // Backspace on empty input with active chip → remove chip
  if (_activeCmd && e.key === "Backspace" && _input.textContent === "") {
    e.preventDefault();
    _removeChip();
  }
}

// ── Select skill ──────────────────────────────────────────────────────────
function _selectSkill(skill) {
  _closePalette();          // hide palette
  _input.textContent = "";        // clear the "/" they typed

  if (!skill.ph) {
    // No-arg skill: fire immediately, no chip needed
    _onNoArg?.(skill.cmd);
    return;
  }

  // Show chip and hint, then focus input for typing
  _showChip(skill);
  _input.focus();
}

// ── Chip (fixed on body, above input bar) ────────────────────────────────
function _showChip(skill) {
  _activeCmd = skill.cmd;

  document.getElementById("sc-icon").textContent  = skill.icon;
  document.getElementById("sc-label").textContent = skill.label;
  _chip.style.display = "flex";
  _chip.classList.add("visible");

  if (skill.ph) {
    _hint.textContent = "💡 e.g. " + skill.ph;
    _hint.classList.add("visible");
  }

  // Glow the input panel
  _input.closest(".input-panel")?.classList.add("slash-active");
}

function _removeChip() {
  _activeCmd = null;
  _chip.style.display = "none";
  _chip.classList.remove("visible");
  _hint.classList.remove("visible");
  _input.closest(".input-panel")?.classList.remove("slash-active");
}

// ── Render palette items ──────────────────────────────────────────────────
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

  // Wire each item — use pointerdown so it works on touch AND mouse
  _palette.querySelectorAll(".slash-item").forEach(el => {
    el.addEventListener("pointerenter", () => {
      _activeIdx = +el.dataset.i;
      _renderPalette();
    });

    el.addEventListener("pointerdown", e => {
      // Prevent the input from losing focus
      e.preventDefault();
    });

    el.addEventListener("pointerup", e => {
      e.stopImmediatePropagation();
      _selectSkill(_filtered[+el.dataset.i]);
    });
  });
}

function _closePalette() {
  _palette.classList.remove("open");
  _activeIdx = -1;
}
