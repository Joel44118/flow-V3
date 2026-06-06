// ═══════════════════════════════════════════
// ui/codeblock.js — Code block renderer
// Supports any language, no downloads needed
// Uses highlight.js from CDN
// ═══════════════════════════════════════════

const HLJS_CSS = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css";
const HLJS_JS  = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js";
let _ready = false;

async function ensureHL() {
  if (_ready) return;
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
}

// Detects ``` fenced code blocks
export function hasCode(text) {
  return /```/.test(text);
}

// Renders text + code blocks into a container element
export async function renderWithCode(text, container) {
  await ensureHL();
  container.innerHTML = "";

  // Split on fenced code blocks: ```lang\ncode```
  const parts = text.split(/(```[\s\S]*?```)/g);

  for (const part of parts) {
    const fence = part.match(/^```(\w*)\n?([\s\S]*?)```$/);
    if (fence) {
      const lang = fence[1]?.trim() || "";
      const src  = fence[2] || "";
      container.appendChild(buildBlock(lang, src));
    } else {
      // Plain prose
      const lines = part.trim();
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
    navigator.clipboard.writeText(src).then(() => {
      copy.textContent = "COPIED ✓";
      setTimeout(() => { copy.textContent = "COPY"; }, 2000);
    }).catch(() => {
      // Fallback for non-HTTPS
      const ta = document.createElement("textarea");
      ta.value = src; document.body.appendChild(ta);
      ta.select(); document.execCommand("copy");
      document.body.removeChild(ta);
      copy.textContent = "COPIED ✓";
      setTimeout(() => { copy.textContent = "COPY"; }, 2000);
    });
  });

  hdr.appendChild(dots);
  hdr.appendChild(lbl);
  hdr.appendChild(copy);

  // ── Code ────────────────────────────────
  const pre    = document.createElement("pre");
  const codeEl = document.createElement("code");

  // highlight.js supports 190+ languages, all loaded — no downloads
  if (window.hljs && lang && window.hljs.getLanguage(lang)) {
    codeEl.innerHTML = window.hljs.highlight(src, { language: lang, ignoreIllegals: true }).value;
    codeEl.className = `language-${lang}`;
  } else if (window.hljs) {
    // Auto-detect language
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
