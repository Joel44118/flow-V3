// ═══════════════════════════════════════════
// ui/slash.js — Slash Command Palette
//
// Type "/" in the input to open the menu.
// Click or arrow-key select a skill.
// Skill fills the input with a prefix + placeholder.
// User types their prompt and sends normally.
//
// SKILLS:
//   /image-flux    → FLUX photorealistic image
//   /image-design  → AI HTML graphic (text/banners/promos)
//   /search        → Web search
//   /research      → Deep research
//   /url           → Inspect a website URL
//   /code          → Write code
//   /alarm         → Set an alarm
//   /goal          → Add a daily goal
//   /note          → Open notepad
//   /weather       → Current weather
//   /camera        → Open camera
//   /screen        → Share screen
//   /yolo          → Object detection
// ═══════════════════════════════════════════

const SKILLS = [
  // ── Images ──────────────────────────────
  {
    cmd:         "/image-flux",
    icon:        "🌄",
    label:       "Photo / Art Image",
    description: "Realistic photo or artistic image via FLUX AI",
    placeholder: "a futuristic cityscape at night, neon lights reflecting on rain",
    group:       "Images",
  },
  {
    cmd:         "/image-design",
    icon:        "🎨",
    label:       "Graphic Design",
    description: "Banner, poster, social post, text overlay — AI-designed HTML graphic",
    placeholder: '"Your text here" Twitter promotion, minimalist dark theme 1216x704',
    group:       "Images",
  },

  // ── Search & Research ────────────────────
  {
    cmd:         "/search",
    icon:        "🔍",
    label:       "Quick Search",
    description: "Search the web for current info",
    placeholder: "latest news about AI in Nigeria",
    group:       "Search",
  },
  {
    cmd:         "/research",
    icon:        "📖",
    label:       "Deep Research",
    description: "Multi-source deep dive on any topic",
    placeholder: "how to grow a bot development business in 2025",
    group:       "Search",
  },
  {
    cmd:         "/url",
    icon:        "🌐",
    label:       "Inspect Website",
    description: "Analyse any website — features, purpose, tech stack",
    placeholder: "https://example.com",
    group:       "Search",
  },

  // ── Code ────────────────────────────────
  {
    cmd:         "/code",
    icon:        "💻",
    label:       "Write Code",
    description: "Write or fix code in any language",
    placeholder: "a JavaScript function that debounces API calls",
    group:       "Code",
  },

  // ── Productivity ─────────────────────────
  {
    cmd:         "/alarm",
    icon:        "⏰",
    label:       "Set Alarm",
    description: "Set a timed reminder",
    placeholder: "meeting at 3pm",
    group:       "Productivity",
  },
  {
    cmd:         "/goal",
    icon:        "🎯",
    label:       "Add Goal",
    description: "Add a daily goal to track",
    placeholder: "finish the Joelflowstack landing page",
    group:       "Productivity",
  },
  {
    cmd:         "/note",
    icon:        "📝",
    label:       "Open Notepad",
    description: "Open Flow's notepad to jot something down",
    placeholder: "", // no prompt needed
    group:       "Productivity",
  },
  {
    cmd:         "/weather",
    icon:        "🌤️",
    label:       "Weather",
    description: "Current weather and 3-day forecast for Ibadan",
    placeholder: "", // no prompt needed
    group:       "Productivity",
  },

  // ── Vision ───────────────────────────────
  {
    cmd:         "/camera",
    icon:        "📷",
    label:       "Camera",
    description: "Open camera — Flow sees you",
    placeholder: "",
    group:       "Vision",
  },
  {
    cmd:         "/screen",
    icon:        "🖥️",
    label:       "Share Screen",
    description: "Share your screen — Flow reads it",
    placeholder: "",
    group:       "Vision",
  },
  {
    cmd:         "/yolo",
    icon:        "🔎",
    label:       "Object Detection",
    description: "Live camera with real-time object labels",
    placeholder: "",
    group:       "Vision",
  },
];

// ── State ────────────────────────────────────────────────────────────────
let _input      = null;
let _palette    = null;
let _activeIdx  = -1;
let _filtered   = [];
let _onSelect   = null;   // callback(cmd, placeholder)

// ── Init ─────────────────────────────────────────────────────────────────
export function initSlash(inputEl, onSelect) {
  _input    = inputEl;
  _onSelect = onSelect;
  _buildPalette();
  _bindInput();
}

// ── Build palette DOM ─────────────────────────────────────────────────────
let _hint = null;

function _buildPalette() {
  _palette = document.createElement("div");
  _palette.id = "slash-palette";
  _palette.setAttribute("aria-label", "Slash commands");
  document.body.appendChild(_palette);

  _hint = document.createElement("div");
  _hint.id = "slash-hint";
  document.body.appendChild(_hint);
}

// ── Bind input events ─────────────────────────────────────────────────────
function _bindInput() {
  _input.addEventListener("input", _onInput);
  _input.addEventListener("keydown", _onKeydown);
  document.addEventListener("click", e => {
    if (!_palette.contains(e.target) && e.target !== _input) _close();
  });
  // Hide hint when input is fully cleared
  _input.addEventListener("input", () => {
    if (!_input.value && _hint) _hint.classList.remove("visible");
  });
}

function _onInput() {
  const val = _input.value;
  if (val === "/" || val.startsWith("/")) {
    const query = val.slice(1).toLowerCase();
    _filtered = SKILLS.filter(s =>
      s.cmd.slice(1).includes(query) ||
      s.label.toLowerCase().includes(query) ||
      s.group.toLowerCase().includes(query)
    );
    _activeIdx = _filtered.length ? 0 : -1;
    _render();
    _show();
  } else {
    _close();
  }
}

function _onKeydown(e) {
  if (!_palette.classList.contains("open")) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    e.stopPropagation();
    _activeIdx = (_activeIdx + 1) % _filtered.length;
    _render();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    e.stopPropagation();
    _activeIdx = (_activeIdx - 1 + _filtered.length) % _filtered.length;
    _render();
  } else if (e.key === "Enter") {
    // Always intercept Enter when palette is open
    e.preventDefault();
    e.stopPropagation();
    if (_activeIdx >= 0) _selectSkill(_filtered[_activeIdx]);
  } else if (e.key === "Escape") {
    e.preventDefault();
    _close();
  }
}

// ── Render items ──────────────────────────────────────────────────────────
function _render() {
  if (!_filtered.length) {
    _palette.innerHTML = `<div class="slash-empty">No matching commands</div>`;
    return;
  }

  // Group by category
  const groups = {};
  _filtered.forEach((s, i) => {
    if (!groups[s.group]) groups[s.group] = [];
    groups[s.group].push({ skill: s, idx: i });
  });

  let html = "";
  for (const [groupName, items] of Object.entries(groups)) {
    html += `<div class="slash-group-label">${groupName}</div>`;
    for (const { skill, idx } of items) {
      const active = idx === _activeIdx ? "active" : "";
      html += `
        <div class="slash-item ${active}" data-idx="${idx}">
          <span class="slash-icon">${skill.icon}</span>
          <div class="slash-info">
            <div class="slash-label">${skill.label}</div>
            <div class="slash-desc">${skill.description}</div>
          </div>
          <span class="slash-cmd">${skill.cmd}</span>
        </div>`;
    }
  }
  _palette.innerHTML = html;

  // Click handlers
  _palette.querySelectorAll(".slash-item").forEach(el => {
    el.addEventListener("mouseenter", () => {
      _activeIdx = parseInt(el.dataset.idx);
      _render();
    });
    el.addEventListener("click", () => {
      _selectSkill(_filtered[parseInt(el.dataset.idx)]);
    });
  });
}

// ── Select a skill ────────────────────────────────────────────────────────
function _selectSkill(skill) {
  _close();

  if (skill.placeholder) {
    // Fill input with cmd prefix
    _input.value = skill.cmd + " ";
    // Set placeholder as hint text (not overflow — shown when field appears empty after cmd)
    _input.placeholder = "Talk to Flow, Boss...";
    _input.dataset.slashCmd = skill.cmd;
    // Highlight the input panel
    _input.closest(".input-panel")?.classList.add("slash-active");
    // Show hint label above input (wraps properly unlike placeholder)
    if (_hint) {
      _hint.textContent = "💡 e.g. " + skill.placeholder;
      _hint.classList.add("visible");
    }
    // Focus and move cursor to end
    _input.focus();
    const len = _input.value.length;
    _input.setSelectionRange(len, len);

    // Hide hint and restore when user clears or sends
    const restore = () => {
      if (!_input.value.startsWith("/")) {
        _input.placeholder = "Talk to Flow, Boss...";
        delete _input.dataset.slashCmd;
        _input.closest(".input-panel")?.classList.remove("slash-active");
        if (_hint) _hint.classList.remove("visible");
        _input.removeEventListener("input", restore);
      }
    };
    _input.addEventListener("input", restore);
  } else {
    // No-arg skills: fire immediately
    _input.value = "";
    _input.placeholder = "Talk to Flow, Boss...";
    _onSelect?.(skill.cmd, "");
  }
}

function _show() {
  _palette.classList.add("open");
  _render();
}

function _close() {
  _palette.classList.remove("open");
  _activeIdx = -1;
  // Don't hide hint here — keep it visible while user is typing their prompt
}

// ── Parse slash prefix from input text ───────────────────────────────────
// Called by app.js before sending — extracts cmd and actual prompt
export function parseSlashCommand(text) {
  const t = text.trim();
  for (const skill of SKILLS) {
    if (t.toLowerCase().startsWith(skill.cmd + " ") || t.toLowerCase() === skill.cmd) {
      const prompt = t.slice(skill.cmd.length).trim();
      return { cmd: skill.cmd, prompt };
    }
  }
  return null;
}
