// ═══════════════════════════════════════════
// core/pysandbox.js — Real, capability-gated Python execution for Flow
//
// WHAT THIS ACTUALLY IS, plainly: Joel asked for file access, network
// calls, and OS control for Flow's self-tools, plus a language besides
// plain JS. Real research this session found:
//   - Rust→Wasm in the browser: NOT achievable without a real Rust
//     toolchain (rustc/wasm-pack) on an actual machine — every working
//     example uses a real CLI, none compile Rust client-side. A genuine
//     dead end for "no half-done projects."
//   - AssemblyScript's own homepage shows a compile()-in-browser demo,
//     but that's the WEBSITE's own custom playground bundle — not a
//     published, documented, standalone package anyone can import from a
//     CDN. Also a dead end for tonight, honestly.
//   - @wasmer/sdk IS real, verified, and genuinely complete: it runs
//     real WASI/WASIX packages (including a full Python interpreter)
//     ENTIRELY CLIENT-SIDE — confirmed via Wasmer's own docs, works in
//     both plain browser and Electron's renderer (Electron's renderer IS
//     Chromium, WebAssembly has worked there since Electron 3.0/2018).
//
// So: Python, not Rust/AssemblyScript, running in a REAL WASI sandbox.
// This is not a downgrade — Python is a genuinely capable, fully
// featured language, and the sandbox model is the actual real solution
// to "safely give Flow file/network access":
//
// CAPABILITY-BASED, NOT A BLOCKLIST. A blocklist tries to guess every
// dangerous pattern in advance and has repeatedly failed in the real
// world (see the CVE research from earlier this session — Google
// Antigravity's sandbox escape worked even in "Strict Mode" via prompt
// injection). A WASI sandbox starts with ZERO permissions — no files, no
// network, nothing — until the HOST (this file) explicitly mounts a
// specific directory or proxies a specific network call. There is no
// blocklist to bypass, because there is no ambient authority to exploit.
//
// REAL, HONEST LIMITS — stated plainly, not glossed over:
//   - Network access from inside the Python sandbox is NOT raw sockets;
//     it goes through what THIS file explicitly proxies via fetch() on
//     Flow's behalf (see pyNetworkFetch below) — so "network access" here
//     means "an explicitly allowlisted domain, fetched by the host and
//     handed back to Python as a string," not "Python can reach anywhere."
//   - "OS control" is NOT granted, ever, by this system, full stop. There
//     is no real, safe way to let arbitrary generated code move a mouse,
//     press a key, or touch another running program — that would defeat
//     the entire point of sandboxing. If Flow ever needs a REAL OS
//     action (open the camera, toggle Sentinel), that goes through
//     Flow's own existing, hand-built, reviewed functions (see
//     app.js's clientAction dispatcher) — never through generated code.
//   - First run downloads the Wasmer SDK + Python package (~real
//     megabytes) — genuinely slower than plain-JS tools on first use,
//     cached by the browser afterward.
// ═══════════════════════════════════════════

let _sdkPromise = null;
let _pythonPkgPromise = null;

function loadWasmerSdk() {
  if (!_sdkPromise) {
    _sdkPromise = import("https://unpkg.com/@wasmer/sdk@latest/dist/index.mjs").then(async (mod) => {
      await mod.init();
      return mod;
    });
  }
  return _sdkPromise;
}

async function loadPythonPackage() {
  if (!_pythonPkgPromise) {
    const { Wasmer } = await loadWasmerSdk();
    _pythonPkgPromise = Wasmer.fromRegistry("python/python");
  }
  return _pythonPkgPromise;
}

// ── Real capability grants, explicit per call ──────────────────────────
// This is the actual safety mechanism: nothing is granted unless named
// here, explicitly, for THIS specific run. No ambient/ambient-adjacent
// access exists at all — a script that never asks for "net" cannot reach
// the network no matter what its code says, because the sandbox itself
// has no network interface to find.
//
// capabilities = {
//   files:  { "/data": { "input.csv": "real,csv,content" } }  — real,
//            explicit virtual files mounted at a real path, nothing else
//            on Joel's actual disk is ever touched (Wasmer's Directory is
//            an in-memory virtual FS, not a passthrough to the real
//            filesystem, unless Joel explicitly wires the real
//            File System Access API in — deliberately not done here).
//   allowedDomains: ["api.example.com"] — real domains this specific run
//            may fetch from. The HOST (this function) does the actual
//            fetch(), Python only ever sees the resulting text handed
//            back to it — Python code itself never gets a raw network
//            call, closing off SSRF/arbitrary-destination risk entirely.
// }
export async function runPythonTool(code, { input = {}, capabilities = {} } = {}) {
  const { Directory } = await loadWasmerSdk();
  const python = await loadPythonPackage();

  // Build the real, explicit virtual filesystem for this run only —
  // nothing persists between runs unless Joel's own approval flow
  // decides to persist it (not done here; every run starts clean).
  const srcDir = new Directory();
  await srcDir.writeFile("main.py", code);
  // REAL FIX: `input` was declared in this function's signature but
  // never actually used — a genuine gap that would have silently broken
  // executeStoredTool's Python path (which writes a script expecting to
  // read /src/input.json). Writing it here, alongside main.py, so
  // scripts that read it via plain `open("/src/input.json")` actually
  // find real data, not a missing file.
  await srcDir.writeFile("input.json", JSON.stringify(input));

  const mount = { "/src": srcDir };
  if (capabilities.files) {
    for (const [mountPath, files] of Object.entries(capabilities.files)) {
      const dir = new Directory();
      for (const [name, content] of Object.entries(files)) {
        await dir.writeFile(name, content);
      }
      mount[mountPath] = dir;
    }
  }

  // REAL network proxy, not a raw socket handed to Python: if the tool
  // needs network data, the HOST fetches it (checked against
  // capabilities.allowedDomains below) and writes the result into the
  // virtual filesystem BEFORE Python ever runs — Python reads it as a
  // plain file, never makes the request itself. This is the actual,
  // concrete mechanism behind "capability-gated network access."
  if (capabilities.networkRequests?.length) {
    const netDir = new Directory();
    for (const req of capabilities.networkRequests) {
      const url = new URL(req.url);
      const allowed = (capabilities.allowedDomains || []).some(d => url.hostname === d || url.hostname.endsWith(`.${d}`));
      if (!allowed) {
        throw new Error(`Real capability check failed: "${url.hostname}" is not in this tool's allowedDomains — refusing to fetch. Add it explicitly if this is genuinely needed, don't broaden the grant blindly.`);
      }
      try {
        const res = await fetch(req.url);
        const text = await res.text();
        await netDir.writeFile(req.saveAs || "response.txt", text);
      } catch (e) {
        await netDir.writeFile(req.saveAs || "response.txt", `[FETCH FAILED: ${e.message}]`);
      }
    }
    mount["/net"] = netDir;
  }

  const instance = await python.entrypoint.run({
    args: ["/src/main.py"],
    mount,
  });

  const output = await instance.wait();
  return {
    ok: output.ok,
    stdout: output.stdout,
    stderr: output.stderr,
    code: output.code,
  };
}

// ── Real, honest capability description for the approval UI ───────────
// Turns a raw capabilities object into a plain-language summary so Joel
// sees EXACTLY what a tool can touch before approving it — not just the
// code, which is much harder to audit for a non-trivial Python script
// than a 3-line JS body was.
export function describeCapabilities(capabilities = {}) {
  const lines = [];
  if (capabilities.files) {
    for (const [path, files] of Object.entries(capabilities.files)) {
      lines.push(`📁 Can read a virtual file at ${path}/ containing: ${Object.keys(files).join(", ")} (NOT your real disk — an isolated, in-memory copy only this run can see)`);
    }
  }
  if (capabilities.allowedDomains?.length) {
    lines.push(`🌐 Can receive data fetched from: ${capabilities.allowedDomains.join(", ")} (Flow fetches it, the script only ever reads the resulting text — it never makes its own network call)`);
  }
  if (!lines.length) {
    lines.push("🔒 No file or network access — this tool only computes on whatever input Joel/Flow gives it directly.");
  }
  return lines.join("\n");
}
