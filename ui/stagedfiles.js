// ═══════════════════════════════════════════
// ui/stagedfiles.js — File staging tray
//
// Holds selected files (images, video, docs, code) above the
// input bar with an X button per file. Nothing is sent or
// processed until the user hits send — multiple files can be
// queued together and go out in one message.
// ═══════════════════════════════════════════

let _tray      = null;
let _staged    = [];   // [{ id, file, kind, previewUrl }]
let _onChange  = null; // callback fired whenever staged list changes

export function initStagedFiles(onChangeFn) {
  _onChange = onChangeFn || null;
  _buildTray();
}

function _buildTray() {
  if (_tray) return;
  _tray = document.createElement("div");
  _tray.id = "staged-tray";
  _tray.style.display = "none";

  // #staged-tray is position:fixed (see styles.css) — .input-panel is
  // ALSO position:fixed, so inserting the tray as a normal-flow sibling
  // would NOT make it sit next to the input bar (it would just render
  // wherever it falls in the page's normal flow, i.e. up near the top).
  // Append straight to body and let _reposition() pin it via JS instead.
  document.body.appendChild(_tray);

  _wireReposition();
}

// ── Keep the tray pinned just above the input bar, and stacked above ───────
// the skill chip (#slash-chip from ui/slash.js) whenever it's also showing,
// so the two never overlap. Uses plain DOM lookups (no import of slash.js)
// to avoid introducing a cross-module dependency.
function _reposition() {
  if (!_tray) return;
  const panel = document.querySelector(".input-panel");
  if (!panel) return;

  const gap  = 10;
  const rect = panel.getBoundingClientRect();
  let bottomPx = window.innerHeight - rect.top + gap;

  const chip = document.getElementById("slash-chip");
  if (chip && chip.style.display === "flex") {
    bottomPx += chip.getBoundingClientRect().height + gap;
  }

  _tray.style.bottom = bottomPx + "px";
}

function _wireReposition() {
  window.addEventListener("resize", _reposition);

  const panel = document.querySelector(".input-panel");
  if (panel && window.ResizeObserver) {
    new ResizeObserver(_reposition).observe(panel);
  }

  // The chip's own visibility toggles via inline style (set in ui/slash.js),
  // so watch for that to re-stack the tray above/below it as needed.
  const chip = document.getElementById("slash-chip");
  if (chip && window.MutationObserver) {
    new MutationObserver(_reposition).observe(chip, { attributes: true, attributeFilter: ["style"] });
  }

  _reposition();
}

// ── Classify a file ─────────────────────────────────────────────────────
function _kindOf(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (/^image\//.test(file.type) || ["jpg","jpeg","png","gif","webp","bmp","svg"].includes(ext)) return "image";
  if (/^video\//.test(file.type) || ["mp4","mov","webm","avi","mkv"].includes(ext)) return "video";
  if (/^audio\//.test(file.type) || ["mp3","wav","ogg","m4a"].includes(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  return "file";
}

const ICONS = { image: "🖼️", video: "🎬", audio: "🎵", pdf: "📄", file: "📎" };

// ── Add files to the tray (does NOT send or process them) ────────────────
export function stageFiles(fileList) {
  const files = Array.from(fileList);
  for (const file of files) {
    const kind = _kindOf(file);
    const id   = "f" + Date.now() + Math.random().toString(36).slice(2, 7);
    const entry = { id, file, kind, previewUrl: null };
    _staged.push(entry);

    if (kind === "image") {
      const reader = new FileReader();
      reader.onload = e => {
        entry.previewUrl = e.target.result;
        _render();
      };
      reader.readAsDataURL(file);
    } else if (kind === "video") {
      // Create the blob URL once, up front, and reuse it on every re-render.
      // Previously this was created fresh inside _render() on every single
      // staging change (adding/removing ANY file re-renders the whole tray)
      // and the old URL was never revoked — each upload leaked another
      // blob URL, and the UI got progressively laggier the more you staged.
      entry.previewUrl = URL.createObjectURL(file);
    }
  }
  _render();
}

// ── Remove a staged file by id ────────────────────────────────────────────
function _remove(id) {
  const entry = _staged.find(f => f.id === id);
  if (entry?.kind === "video" && entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
  _staged = _staged.filter(f => f.id !== id);
  _render();
}

// ── Clear all staged files (called after send) ───────────────────────────
export function clearStaged() {
  for (const entry of _staged) {
    if (entry.kind === "video" && entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
  }
  _staged = [];
  _render();
}

// ── Get current staged files (for sending) ────────────────────────────────
export function getStagedFiles() {
  return _staged.map(f => f.file);
}

export function hasStagedFiles() {
  return _staged.length > 0;
}

// ── Render the tray ────────────────────────────────────────────────────────
function _render() {
  if (!_tray) return;
  _tray.innerHTML = "";

  if (!_staged.length) {
    _tray.style.display = "none";
    _onChange?.(_staged.length);
    return;
  }

  _tray.style.display = "flex";
  _reposition();

  for (const entry of _staged) {
    const card = document.createElement("div");
    card.className = "staged-card";
    card.dataset.kind = entry.kind;

    const closeBtn = document.createElement("button");
    closeBtn.className = "staged-x";
    closeBtn.textContent = "✕";
    closeBtn.title = "Remove";
    closeBtn.addEventListener("click", (e) => { e.stopPropagation(); _remove(entry.id); });

    if (entry.kind === "image" && entry.previewUrl) {
      const img = document.createElement("img");
      img.src = entry.previewUrl;
      img.className = "staged-thumb";
      card.appendChild(img);
    } else if (entry.kind === "video") {
      const vid = document.createElement("video");
      vid.src = entry.previewUrl || "";
      vid.className = "staged-thumb";
      vid.muted = true;
      card.appendChild(vid);
      const badge = document.createElement("span");
      badge.className = "staged-badge";
      badge.textContent = "🎬";
      card.appendChild(badge);
    } else {
      const iconWrap = document.createElement("div");
      iconWrap.className = "staged-icon-wrap";
      iconWrap.textContent = ICONS[entry.kind] || "📎";
      card.appendChild(iconWrap);
    }

    const name = document.createElement("div");
    name.className = "staged-name";
    name.textContent = entry.file.name.length > 16
      ? entry.file.name.slice(0, 13) + "..."
      : entry.file.name;
    card.appendChild(name);
    card.appendChild(closeBtn);
    _tray.appendChild(card);
  }

  _onChange?.(_staged.length);
}
