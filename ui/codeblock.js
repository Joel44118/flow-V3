// ═══════════════════════════════════════════
// ui/codeblock.js — Sci-fi code renderer
//
// Detects code in Flow's replies and renders
// them as styled blocks with:
//  - Language label
//  - Copy button
//  - Syntax highlighting via highlight.js CDN
//  - Sci-fi dark terminal aesthetic
// ═══════════════════════════════════════════

let _hlReady = false;

async function _loadHighlightJS() {
  if (_hlReady || window.hljs) { _hlReady = true; return; }
  await Promise.all([
    _loadScript("https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"),
    _loadStyle("https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css"),
  ]);
  _hlReady = true;
}

// ── Detect if text contains code blocks ──
export function hasCode(text) {
  return /```[\s\S]*?```/m.test(text);
}

// ── Render message with code blocks ──────
export async function renderWithCode(text, bubbleEl) {
  await _loadHighlightJS();

  // Split on ```lang ... ``` blocks
  const parts = text.split(/(```[\w]*\n[\s\S]*?```)/m);

  bubbleEl.innerHTML = "";
  bubbleEl.classList.add("has-code");

  parts.forEach(part => {
    const codeMatch = part.match(/^```([\w]*)\n([\s\S]*?)```$/m);
    if (codeMatch) {
      const lang = codeMatch[1] || "plaintext";
      const code = codeMatch[2];
      bubbleEl.appendChild(_buildCodeBlock(lang, code));
    } else if (part.trim()) {
      const p = document.createElement("p");
      p.className   = "code-prose";
      p.textContent = part.trim();
      bubbleEl.appendChild(p);
    }
  });
}

function _buildCodeBlock(lang, code) {
  const wrap = document.createElement("div");
  wrap.className = "code-block";

  // Header bar
  const header = document.createElement("div");
  header.className = "code-header";

  const dots = document.createElement("div");
  dots.className = "code-dots";
  dots.innerHTML = `<span></span><span></span><span></span>`;

  const label = document.createElement("span");
  label.className   = "code-lang";
  label.textContent = lang.toUpperCase() || "CODE";

  const copyBtn = document.createElement("button");
  copyBtn.className   = "code-copy";
  copyBtn.textContent = "COPY";
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(code).then(() => {
      copyBtn.textContent = "COPIED ✓";
      setTimeout(() => { copyBtn.textContent = "COPY"; }, 2000);
    });
  };

  header.appendChild(dots);
  header.appendChild(label);
  header.appendChild(copyBtn);

  // Code content
  const pre  = document.createElement("pre");
  const codeEl = document.createElement("code");

  if (window.hljs && lang && window.hljs.getLanguage(lang)) {
    codeEl.innerHTML = window.hljs.highlight(code, { language: lang }).value;
  } else {
    codeEl.textContent = code;
  }

  pre.appendChild(codeEl);
  wrap.appendChild(header);
  wrap.appendChild(pre);
  return wrap;
}

function _loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}
function _loadStyle(href) {
  return new Promise((res) => {
    if (document.querySelector(`link[href="${href}"]`)) { res(); return; }
    const l = document.createElement("link");
    l.rel  = "stylesheet"; l.href = href;
    l.onload = res; document.head.appendChild(l);
  });
}
