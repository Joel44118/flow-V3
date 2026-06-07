// ═══════════════════════════════════════════
// ui/codeblock.js — Code block renderer
// Supports any language, no downloads needed
// Uses highlight.js from CDN
//
// FIXES:
//   - Handles unclosed ``` blocks (truncated responses)
//   - Sets plain text immediately, async-replaces with highlight
//   - Regex handles newlines in fenced blocks correctly
// ═══════════════════════════════════════════

const HLJS_CSS = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css";
const HLJS_JS  = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js";
let _ready = false;
let _loading = false;

async function ensureHL() {
  if (_ready) return;
  if (_loading) {
    // Wait for existing load
    await new Promise(res => { const t = setInterval(() => { if (_ready) { clearInterval(t); res(); } }, 100); });
    return;
  }
  _loading = true;
  if (!document.querySelector(`link[href="${HLJS_CSS}"]`)) {
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = HLJS_CSS;
    document.head.appendChild(l);
  }
  if (!window.hljs) {
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = HLJS_JS; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  _ready = true;
  _loading = false;
}

// Detects ``` fenced code blocks (including unclosed ones from truncated responses)
export function hasCode(text) {
  return /```/.test(text);
}

// Split text into prose and code parts
// Handles both closed (``` ... ```) and unclosed (``` ... EOF)
function splitParts(text) {
  const parts = [];
  // Match: ```lang\ncode``` OR ```lang\ncode (unclosed at end)
  const re = /```(\w*)\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let match;

  while ((match = re.exec(text)) !== null) {
    // Prose before this block
    if (match.index > last) {
      parts.push({ type: "prose", text: text.slice(last, match.index) });
    }
    parts.push({ type: "code", lang: match[1]?.trim() || "", src: match[2] || "" });
    last = match.index + match[0].length;
  }

  // Remaining prose after last match
  if (last < text.length) {
    const remaining = text.slice(last);
    if (remaining.trim()) parts.push({ type: "prose", text: remaining });
  }

  return parts;
}

// Renders text + code blocks into a container element
export async function renderWithCode(text, container) {
  // Set plain text immediately so message is always visible
  container.textContent = text;

  // Then async-upgrade with highlighting
  await ensureHL();
  container.innerHTML = "";

  const parts = splitParts(text);

  for (const part of parts) {
    if (part.type === "code") {
      container.appendChild(buildBlock(part.lang, part.src));
    } else {
      const lines = part.text.trim();
      if (!lines) continue;
      const p = document.createElement("div");
      p.className   = "code-prose";
      p.textContent = lines;
      container.appendChild(p);
    }
  }
  container.classList.add("has-code");
}

function buildBlock(lang, src) {
  const wrap = document.createElement("div");
  wrap.className = "code-block";

  // ── Header ──────────────────────────────
  const hdr  = document.createElement("div");
  hdr.className = "code-header";

  const dots = document.createElement("div");
  dots.className = "code-dots";
  dots.innerHTML = "<span></span><span></span><span></span>";

  const lbl  = document.createElement("span");
  lbl.className   = "code-lang";
  lbl.textContent = lang.toUpperCase() || "CODE";

  const copy = document.createElement("button");
  copy.className   = "code-copy";
  copy.textContent = "COPY";
  copy.addEventListener("click", () => {
    const copyText = src;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(copyText).then(() => {
        copy.textContent = "COPIED ✓";
        setTimeout(() => { copy.textContent = "COPY"; }, 2000);
      }).catch(() => fallbackCopy(copyText, copy));
    } else {
      fallbackCopy(copyText, copy);
    }
  });

  hdr.appendChild(dots);
  hdr.appendChild(lbl);
  hdr.appendChild(copy);

  // ── Code ────────────────────────────────
  const pre    = document.createElement("pre");
  const codeEl = document.createElement("code");

  if (window.hljs && lang && window.hljs.getLanguage(lang)) {
    codeEl.innerHTML = window.hljs.highlight(src, { language: lang, ignoreIllegals: true }).value;
    codeEl.className = `language-${lang}`;
  } else if (window.hljs) {
    const result = window.hljs.highlightAuto(src);
    codeEl.innerHTML  = result.value;
    codeEl.className  = `language-${result.language || "plaintext"}`;
    if (!lang) lbl.textContent = (result.language || "CODE").toUpperCase();
  } else {
    codeEl.textContent = src;
  }

  pre.appendChild(codeEl);
  wrap.appendChild(hdr);
  wrap.appendChild(pre);
  return wrap;
}

function fallbackCopy(text, btn) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;opacity:0;";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } catch(_) {}
  document.body.removeChild(ta);
  btn.textContent = "COPIED ✓";
  setTimeout(() => { btn.textContent = "COPY"; }, 2000);
}
