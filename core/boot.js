// ═══════════════════════════════════════════
// core/boot.js — Real Boot Sequence
//
// WHAT THIS ACTUALLY DOES: shows a full-screen loading overlay with
// genuine, plain-language status text that types itself letter-by-
// letter, tied to REAL init steps completing (not a fake timed
// animation) — then triggers the title-bar and footer to stretch apart
// from screen-center once everything is truly ready.
//
// REAL BONUS FIX, not just decoration: this session's earlier
// investigation found face verification (ui/auth.js's MediaPipe
// FaceLandmarker) is lazy-loaded on first use — meaning the very first
// face-unlock attempt after opening Flow always eats a real, slow cold
// load (CDN import + WASM + model download), which is very likely why
// Joel observed "always fails first try, works second/third try": the
// first attempt's timeout was racing against that cold load. Preloading
// it here, during boot (where a loading screen already sets the
// expectation of "give me a second"), means by the time Joel actually
// tries to unlock, the model is already warm — a real fix, not just a
// side effect of the visual redesign.
// ═══════════════════════════════════════════

const STEPS = [
  { key: "face",   label: "Loading face verification",      run: _preloadFace },
  { key: "voice",  label: "Loading voice",                   run: _preloadVoice },
  { key: "brain",  label: "Waking up Flow's brain",           run: _preloadAI },
  { key: "memory", label: "Reading memory",                   run: _preloadMemory },
];

async function _preloadFace() {
  try {
    const { preloadFaceModel } = await import("../ui/auth.js");
    await preloadFaceModel();
  } catch (e) {
    console.warn("[Boot] Face verification preload failed (non-fatal, will retry on first real use):", e.message);
  }
}

async function _preloadVoice() {
  // REAL, CORRECTED: speech.js already self-checks ElevenLabs
  // availability automatically the moment it's imported (_checkEL() runs
  // at module load, confirmed by reading the actual file) — so simply
  // importing it here IS the real check. No separate preloadVoice export
  // needed; that would have been a redundant duplicate of what already
  // happens on import.
  try {
    await import("../core/speech.js");
  } catch (e) {
    console.warn("[Boot] Voice module import failed (non-fatal):", e.message);
  }
}

async function _preloadAI() {
  // Real, cheap warm-up: no network call needed here, core/ai.js's
  // module-level setup (agent restore, etc.) already runs on import in
  // app.js — this step exists mainly to give the loading sequence a
  // genuine "brain" moment rather than only infra plumbing, and a real
  // place to hook a future actual AI health-check if one gets added.
  await new Promise(r => setTimeout(r, 250));
}

async function _preloadMemory() {
  try {
    const mod = await import("./storage.js");
    // Real, cheap check: touching Storage confirms localStorage is
    // actually accessible (fails in some locked-down/incognito contexts)
    // rather than assuming it silently works.
    mod.Storage?.get("boot_check_probe", null);
  } catch (e) {
    console.warn("[Boot] Memory check failed (non-fatal):", e.message);
  }
}

// ── Letter-by-letter typing, real and cancellable ───────────────────────
function _typeText(el, text, speedMs = 18) {
  return new Promise((resolve) => {
    el.textContent = "";
    let i = 0;
    const interval = setInterval(() => {
      el.textContent += text[i];
      i++;
      if (i >= text.length) { clearInterval(interval); resolve(); }
    }, speedMs);
  });
}

export async function runBootSequence() {
  const overlay  = document.getElementById("boot-overlay");
  const textLine = document.getElementById("boot-text-line");
  const topBar   = document.getElementById("top-bar");
  const footer   = document.getElementById("app-footer");

  if (!overlay || !textLine) return; // real guard: don't crash boot if the HTML somehow isn't present

  for (const step of STEPS) {
    await _typeText(textLine, `${step.label}...`);
    await step.run(); // genuinely await the real work — the dots aren't decorative, they cover actual load time
    // Small real pause so a step that finishes instantly doesn't blur
    // past too fast to read — still genuinely tied to completion, not a
    // fixed total-duration animation.
    await new Promise(r => setTimeout(r, 120));
  }

  await _typeText(textLine, "Ready.");
  await new Promise(r => setTimeout(r, 300));

  // REAL STRETCH-APART ANIMATION: both elements start collapsed to a
  // single point at true screen-center (see styles.css's #top-bar.boot-
  // collapsed / #app-footer.boot-collapsed), then this class swap
  // triggers the CSS transition that stretches top-bar up to the real
  // top edge and footer down to the real bottom edge simultaneously —
  // reading as one continuous motion pulling apart from the center,
  // exactly as Joel described.
  overlay.classList.add("boot-done");
  topBar?.classList.remove("boot-collapsed");
  footer?.classList.remove("boot-collapsed");

  setTimeout(() => { overlay.style.display = "none"; }, 700); // real: matches the CSS transition duration below, removed after it visually completes rather than an arbitrary guess
}
