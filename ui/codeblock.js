// ═══════════════════════════════════════════
// ui/codeblock.js — Code block renderer
// ═══════════════════════════════════════════

const HLJS_CSS = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css";
const HLJS_JS  = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js";
let _ready = false;
let _loading = false;

async function ensureHL() {
  if (_ready) return;
  if (_loading) {
    await new Promise(res => {
      const t = setInterval(() => { if (_ready) { clearInterval(t); res(); } }, 50);
    });
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

export function hasCode(text) {
  return /```/.test(text);
}

// Split text into prose and fenced code parts.
// Uses indexOf for reliability instead of regex with g flag.
function splitParts(text) {
  const parts = [];
  let cursor = 0;

  while (cursor < text.length) {
    const openIdx = text.indexOf("```", cursor);

    if (openIdx === -1) {
      // No more code blocks — rest is prose
      const prose = text.slice(cursor).trim();
      if (prose) parts.push({ type: "prose", text: prose });
      break;
    }

    // Prose before the opening ```
    if (openIdx > cursor) {
      const prose = text.slice(cursor, openIdx).trim();
      if (prose) parts.push({ type: "prose", text: prose });
    }

    // Extract language tag on the same line as ```
    const afterOpen  = openIdx + 3;
    const lineEnd    = text.indexOf("\n", afterOpen);
    const lang       = lineEnd === -1
      ? text.slice(afterOpen).trim()
      : text.slice(afterOpen, lineEnd).trim();

    // Code content starts after the language line
    const codeStart  = lineEnd === -1 ? text.length : lineEnd + 1;

    // Find the closing ```
    const closeIdx   = text.indexOf("```", codeStart);

    if (closeIdx === -1) {
      // Unclosed block — take everything to end of string
      const src = text.slice(codeStart);
      parts.push({ type: "code", lang, src });
      cursor = text.length;
    } else {
      const src = text.slice(codeStart, closeIdx);
      parts.push({ type: "code", lang, src });
      cursor = closeIdx + 3;
      // Skip trailing newline after closing ```
      if (text[cursor] === "\n") cursor++;
    }
  }

  return parts;
}

export async function renderWithCode(text, container) {
  // Show plain text immediately so message is never invisible
  container.textContent = text;

  try {
    await ensureHL();
  } catch(e) {
    // highlight.js failed to load — leave plain text visible
    console.warn("[Flow] highlight.js failed:", e);
    return;
  }

  const parts = splitParts(text);

  // Only replace content if we actually found code blocks
  if (!parts.some(p => p.type === "code")) {
    // No blocks found even though hasCode() passed — leave plain text
    return;
  }

  container.innerHTML = "";
  container.classList.add("has-code");

  for (const part of parts) {
    if (part.type === "code") {
      container.appendChild(buildBlock(part.lang, part.src));
    } else {
      if (!part.text.trim()) continue;
      const div = document.createElement("div");
      div.className   = "code-prose";
      div.textContent = part.text;
      container.appendChild(div);
    }
  }
}

function buildBlock(lang, src) {
  const wrap = document.createElement("div");
  wrap.className = "code-block";

  // Header
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
    if (navigator.clipboard) {
      navigator.clipboard.writeText(src).then(() => {
        copy.textContent = "COPIED ✓";
        setTimeout(() => { copy.textContent = "COPY"; }, 2000);
      }).catch(() => fallbackCopy(src, copy));
    } else {
      fallbackCopy(src, copy);
    }
  });

  hdr.appendChild(dots);
  hdr.appendChild(lbl);
  hdr.appendChild(copy);

  // Code
  const pre    = document.createElement("pre");
  const codeEl = document.createElement("code");

  const trimmed = src.replace(/\n$/, ""); // strip trailing newline

  if (window.hljs) {
    if (lang && window.hljs.getLanguage(lang)) {
      codeEl.innerHTML = window.hljs.highlight(trimmed, { language: lang, ignoreIllegals: true }).value;
      codeEl.className = `language-${lang}`;
    } else {
      const result = window.hljs.highlightAuto(trimmed);
      codeEl.innerHTML = result.value;
      codeEl.className = `language-${result.language || "plaintext"}`;
      if (!lang) lbl.textContent = (result.language || "CODE").toUpperCase();
    }
  } else {
    codeEl.textContent = trimmed;
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
