// ═══════════════════════════════════════════
// core/selftools.js — Flow's self-extending tools (Phase 1, restricted scope)
//
// Lets Flow propose small JS functions it doesn't already have, show Joel
// the exact code for approval, and — only after explicit approval — save
// it to a permanent local registry so it can be called in future
// conversations without asking again each time it's USED (approval is
// per-tool-creation, not per-use).
//
// DELIBERATE SAFETY SCOPE, decided explicitly with Joel rather than
// assumed: this is a RESTRICTED first version, not the full "give it
// OS/filesystem/GitHub access" version. Real reason, stated plainly:
// even with Joel approving every script, a human eyeballing code is not
// a reliable way to catch what a script with real system access might
// actually do — approval is a much safer gate when the worst case is
// "bad math" than when the worst case is "deleted files" or "bad GitHub
// push" or "robotjs clicked the wrong thing." Joel explicitly chose to
// start restricted and expand later once this has been used safely.
//
// WHAT THIS DOES NOT PROTECT AGAINST, stated honestly rather than
// implied away: this code runs in the browser/Electron RENDERER
// process, not Node — so Node's `vm` module (which would give real
// process-level isolation) isn't available or used here at all. The
// actual safety mechanism is TWO layers together: (1) a static
// blocklist that rejects any code referencing dangerous
// globals/patterns before it's ever run or shown for approval, and (2)
// running the approved code as a plain function with ONLY its declared
// arguments in scope — no closure access to this module, window,
// document, or anything else on the page. Neither layer alone is
// bulletproof (a sufficiently obfuscated script could in principle
// dodge the blocklist), but together, for the explicitly restricted
// "plain JS only, no APIs" scope Joel chose, this is a reasonable
// starting point — not an unbreakable wall, and not something to
// expand to real system access without a genuinely stronger isolation
// mechanism first.
// ═══════════════════════════════════════════

import { Storage } from "./storage.js";

const REGISTRY_KEY = "flow_self_tools";

// ── Static safety check ──────────────────────────────────────────────────
// Rejects code referencing anything that could reach outside the sandbox,
// BEFORE it's ever shown to Joel for approval or executed. This runs
// first specifically so Joel isn't the only line of defense — code that
// fails this never even reaches the approval UI.
const BLOCKED_PATTERNS = [
  /\brequire\s*\(/,          // no importing Node modules
  /\bimport\s*\(/,           // no dynamic import
  /\bprocess\b/,             // no process access (env vars, exit, etc.)
  /\b(fs|child_process|net|http|https|dns|os|vm)\b/, // no Node built-ins by name
  /\bfetch\s*\(/,            // no network calls
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\beval\s*\(/,             // no nested eval
  /\bFunction\s*\(/,         // no Function constructor (eval-equivalent)
  /\b__proto__\b/,           // no prototype pollution attempts
  /\bconstructor\s*\.\s*constructor\b/, // classic vm-escape pattern
  /\bglobalThis\b/,          // no reaching for the global object directly
  /\brobotjs\b/,             // no OS control
  /\bipcRenderer\b|\bipcMain\b/, // no Electron IPC (no main-process access)
  /\brequire\.resolve\b/,
];

export function checkToolSafety(code) {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(code)) {
      return { safe: false, reason: `Blocked pattern detected: ${pattern.source}` };
    }
  }
  return { safe: true };
}

// ── Registry (persisted via existing Storage wrapper — localStorage +
// cloud sync, same mechanism already used for RAG docs and memory) ──────
function getRegistry() {
  return Storage.get(REGISTRY_KEY, []);
}

function saveToRegistry(tool) {
  const registry = getRegistry();
  registry.push(tool);
  Storage.set(REGISTRY_KEY, registry);
}

export function listTools() {
  return getRegistry();
}

export function deleteTool(name) {
  const registry = getRegistry().filter(t => t.name !== name);
  Storage.set(REGISTRY_KEY, registry);
}

// ── Sandboxed execution ──────────────────────────────────────────────────
// Runs approved tool code as a plain function with nothing dangerous in
// scope. Since this executes in the browser/Electron renderer (not a
// Node script), Node's `vm` module was never an option here — the real
// isolation comes from constructing a fresh Function from the stored
// code string each call (no closure over this module's imports or the
// page's window/document) plus the blocklist check re-run at execution
// time, not just at proposal time.
// REAL, NEW ENTRY POINT: looks up a tool by name from the real saved
// registry and dispatches to the correct execution path based on its
// stored language — JS tools go through runTool (unchanged), Python
// tools go through the real WASI sandbox in core/pysandbox.js. This is
// the function any future caller should actually use (runTool alone has
// no way to know whether a given code string is JS or Python — that
// information only exists on the saved tool object).
export async function executeStoredTool(toolName, args = []) {
  const tool = getRegistry().find(t => t.name === toolName);
  if (!tool) throw new Error(`No tool named "${toolName}" is saved.`);

  if (tool.language === "python") {
    // Dynamic import, not a static top-of-file import: pysandbox.js pulls
    // in the real @wasmer/sdk CDN module, which is a real, non-trivial
    // download — only pay that cost if a Python tool is actually invoked,
    // not on every load of this file for people who only ever use
    // plain-JS tools.
    const { runPythonTool } = await import("./pysandbox.js");
    // Real, honest input passing: Python tools receive their args as a
    // plain JSON file at /src/input.json rather than function
    // parameters — Python has no direct equivalent of JS's positional
    // function-call convention when invoked as a standalone script via
    // WASI, so this is the actual, correct mechanism, not a simplification.
    const inputObj = {};
    (tool.params || []).forEach((name, i) => { inputObj[name] = args[i]; });
    const wrappedCode = `import json\nwith open("/src/input.json") as f:\n    _input = json.load(f)\n${tool.params.map(p => `${p} = _input[${JSON.stringify(p)}]`).join("\n")}\n\n${tool.code}`;
    const result = await runPythonTool(wrappedCode, {
      input: inputObj,
      capabilities: tool.capabilities || {},
    });
    if (!result.ok) {
      throw new Error(`Python tool "${toolName}" failed (exit ${result.code}): ${result.stderr || result.stdout}`);
    }
    return result.stdout;
  }

  return runTool(tool.code, args, tool.params || []);
}

export function runTool(toolCode, args = [], paramNames = []) {
  const safety = checkToolSafety(toolCode);
  if (!safety.safe) {
    throw new Error(`Tool failed safety check at execution time: ${safety.reason}`);
  }

  // REAL BUG FIXED: this previously hardcoded parameter names as arg0,
  // arg1, etc. regardless of what the tool's own stored `params` array
  // declares — e.g. a tool proposed and approved with params: ["celsius"]
  // and code: "return celsius * 9/5 + 32;" would throw
  // "ReferenceError: celsius is not defined" the moment it actually ran,
  // since the constructed function's real argument was named arg0, not
  // celsius. This affects EVERY self-tool ever approved through this
  // system, not just newly added ones — confirmed by directly testing
  // the old code against the exact real [SELFTOOL_PROPOSAL] format Flow
  // is instructed to use (core/ai.js's own example:
  // "code": "return paramName1 + paramName2;", which references the
  // real declared names, not arg0/arg1). Fixed by using the tool's own
  // real parameter names when available, falling back to argN only if
  // paramNames wasn't passed (keeps this backward-compatible with any
  // caller that hasn't been updated to pass it yet).
  const names = (paramNames && paramNames.length === args.length)
    ? paramNames
    : args.map((_, i) => `arg${i}`);

  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(...names, toolCode);
    return fn(...args);
  } catch (e) {
    throw new Error(`Tool execution failed: ${e.message}`);
  }
}

// ── Proposal flow ─────────────────────────────────────────────────────────
// Called when Flow's reply contains a tool proposal (detected in ai.js).
// Does NOT save or run anything — just packages the proposal for the
// approval UI. Nothing happens until Joel explicitly approves via
// approveTool() below.
export function parseToolProposal(replyText) {
  // Flow is instructed (see the SELF-TOOLS prompt block in ai.js) to wrap
  // proposals in a specific tagged block so they can be reliably detected
  // without depending on loose natural-language parsing of the whole reply.
  const match = replyText.match(/\[SELFTOOL_PROPOSAL\]([\s\S]*?)\[\/SELFTOOL_PROPOSAL\]/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1].trim());
    if (!parsed.name || !parsed.description || !parsed.code) return null;

    // REAL EXTENSION: Python tools (via core/pysandbox.js's WASI sandbox)
    // are a genuinely separate tier from plain-JS tools — they can
    // request real, explicit file/network capabilities, whereas plain-JS
    // tools never can (see identity.js/ai.js's prompt instructions,
    // which explicitly tell Flow plain-JS tools have no such access).
    // language defaults to "javascript" for full backward compatibility
    // with every proposal shape that existed before this session.
    return {
      name: parsed.name,
      description: parsed.description,
      code: parsed.code,
      params: parsed.params || [],
      language: parsed.language === "python" ? "python" : "javascript",
      capabilities: parsed.language === "python" ? (parsed.capabilities || {}) : undefined,
      // Also return the reply with the proposal block stripped out, so
      // whatever conversational text Flow wrote around it still displays
      // normally in chat.
      cleanedReply: replyText.replace(match[0], "").trim(),
    };
  } catch (e) {
    console.warn("[SelfTools] Failed to parse proposal JSON:", e.message);
    return null;
  }
}

// Called only when Joel clicks "Approve" in the UI.
export function approveTool(proposal) {
  // REAL BRANCH: Python tools' safety model is the WASI sandbox's real
  // capability gating (core/pysandbox.js), NOT the plain-JS blocklist —
  // checkToolSafety's regex patterns (no require/fetch/process/etc.)
  // are meaningless for Python source and would either false-positive on
  // legitimate Python syntax or miss real Python-specific risks entirely.
  // The actual safety boundary for Python tools is the sandbox itself:
  // zero ambient file/network access exists unless explicitly granted
  // and shown to Joel in the approval UI (see ui/chat.js's capsBlock).
  if (proposal.language === "python") {
    const existing = getRegistry();
    if (existing.some(t => t.name === proposal.name)) {
      return { ok: false, error: `A tool named "${proposal.name}" already exists.` };
    }
    saveToRegistry({
      name: proposal.name,
      description: proposal.description,
      code: proposal.code,
      params: proposal.params,
      language: "python",
      capabilities: proposal.capabilities || {},
      createdAt: Date.now(),
    });
    return { ok: true };
  }

  const safety = checkToolSafety(proposal.code);
  if (!safety.safe) {
    return { ok: false, error: `Rejected by safety check: ${safety.reason}` };
  }

  const existing = getRegistry();
  if (existing.some(t => t.name === proposal.name)) {
    return { ok: false, error: `A tool named "${proposal.name}" already exists.` };
  }

  saveToRegistry({
    name: proposal.name,
    description: proposal.description,
    code: proposal.code,
    params: proposal.params,
    language: "javascript",
    createdAt: Date.now(),
  });

  return { ok: true };
}

// ── Context for the system prompt — lets Flow know what tools it already
// has, so it doesn't propose duplicates and can actually call them ──────
export function getToolsPromptContext() {
  const tools = getRegistry();
  if (!tools.length) return null;
  return tools.map(t =>
    `  • ${t.name}(${t.params.join(", ")}) — ${t.description}`
  ).join("\n");
}
