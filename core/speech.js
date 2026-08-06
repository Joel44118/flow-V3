// core/speech.js (v3)
// ONE consistent voice across ALL devices via Edge TTS (api/tts.js).
//
// REAL, Joel-requested CHANGE: the browser-native speechSynthesis
// fallback (the classic robotic "default" OS voice) is REMOVED
// entirely. Previously, any real Edge TTS failure — including the kind
// of intermittent issue flagged honestly when Edge TTS was first wired
// in (it depends on a real WebSocket connection, which can behave
// differently under Vercel's serverless execution model than a plain
// fetch() call) — silently fell back to speechSynthesis, meaning Flow's
// voice would randomly, unpredictably switch to a generic, low-quality
// system voice mid-use with zero indication why. Per Joel's explicit
// instruction: Flow now ONLY ever uses Edge TTS. If it fails, Flow just
// doesn't speak that reply out loud (the text is still visible in
// chat), rather than jarringly switching voices.

let _isSpeaking   = false;
let _isPaused     = false;
let _envelope     = 0;
let _lastBoundary = 0;
let _activeWrap   = null;
let _onDone       = null;
let _fullText     = "";
let _charOffset   = 0;
let _audioEl      = null;

// REAL BUG FIX — the orb's amplitude envelope was previously a
// synthetic sine wave decaying off a word-boundary timestamp
// (`Math.sin(performance.now() * 0.025)` with a 260ms decay window) —
// it had NO relationship to the actual audio playing, which is exactly
// why the orb never looked in sync with what Flow was actually saying:
// it was just a generic wobble running on its own clock regardless of
// the real waveform. Replaced with genuine Web Audio API amplitude
// analysis of the real _audioEl — the orb now pulses with the actual
// loudness of the actual speech, moment to moment.
let _audioCtx  = null;
let _analyser  = null;
let _analyserBuf = null;

function _wireAnalyser(audioEl) {
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === "suspended") _audioCtx.resume().catch(() => {});
    // A MediaElementSourceNode can only be created ONCE per <audio>
    // element (a real Web Audio constraint) — since _speakEdgeTTS
    // creates a brand-new `new Audio(url)` for every reply, this is
    // always a first-time call for that element, so no dedup needed.
    const source = _audioCtx.createMediaElementSource(audioEl);
    _analyser = _audioCtx.createAnalyser();
    _analyser.fftSize = 256;
    _analyserBuf = new Uint8Array(_analyser.frequencyBinCount);
    // REAL — must still connect to destination, or intercepting the
    // stream through the analyser would silently mute playback.
    source.connect(_analyser);
    _analyser.connect(_audioCtx.destination);
  } catch (e) {
    console.warn("[Speech] Real-time envelope analysis unavailable (non-fatal, orb will stay still while speaking):", e.message);
    _analyser = null;
  }
}

let _rollingPeakRms = 0.05; // real, adaptive — starting floor prevents divide-by-near-zero on the very first frames

setInterval(() => {
  if (!_isSpeaking || _isPaused || !_analyser) { _envelope *= 0.82; return; }
  _analyser.getByteTimeDomainData(_analyserBuf);
  // Real RMS (root-mean-square) of the actual waveform this instant —
  // the standard, genuine way to turn a raw PCM buffer into a single
  // "how loud is it right now" number, normalized to roughly 0..1.
  let sumSquares = 0;
  for (let i = 0; i < _analyserBuf.length; i++) {
    const centered = (_analyserBuf[i] - 128) / 128;
    sumSquares += centered * centered;
  }
  const rms = Math.sqrt(sumSquares / _analyserBuf.length);

  // REAL FIX for the orb going still after switching to William's voice
  // — the previous fixed "rms * 4" gain was calibrated against Guy's
  // specific loudness profile. Different Edge TTS voices genuinely have
  // different average loudness/dynamic range, so a hardcoded multiplier
  // that suited one voice can under-drive another into looking
  // "unreactive" even though real audio is playing. Replaced with a
  // real auto-gain: tracks a slowly-decaying rolling peak and
  // normalizes against THAT, so any voice's own dynamic range maps to
  // a full, visible 0..1 envelope regardless of its absolute loudness.
  _rollingPeakRms = Math.max(rms, _rollingPeakRms * 0.995);
  _envelope = Math.min(1, rms / _rollingPeakRms);
}, 16);

function stripForSpeech(text) {
  if (!text) return "";
  return text
    .replace(/```[\s\S]*?```/g, "here is the code")
    .replace(/```[\s\S]*/g,     "here is the code")
    .replace(/`[^`]+`/g, "")
    .replace(/`/g, "")
    .replace(/\*\*/g, "")
    .replace(/^#+\s/gm, "")
    .replace(/^[-•]\s/gm, "")
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/\s+/g, " ")
    .trim();
}

function _setButtons(wrap, state) {
  if (!wrap) return;
  const play   = wrap.querySelector(".msg-play-btn");
  const cancel = wrap.querySelector(".msg-cancel-btn");
  const reread = wrap.querySelector(".msg-reread-btn");
  if (!play) return;
  if (state === "playing") {
    play.textContent = "⏸"; play.title = "Pause"; play.dataset.state = "playing";
    if (cancel) cancel.style.display = "flex";
    if (reread) reread.style.display = "none";
  } else if (state === "paused") {
    play.textContent = "▶"; play.title = "Resume"; play.dataset.state = "paused";
    if (cancel) cancel.style.display = "flex";
    if (reread) reread.style.display = "flex";
  } else {
    play.textContent = "▶"; play.title = "Read aloud"; play.dataset.state = "idle";
    if (cancel) cancel.style.display = "none";
    if (reread) reread.style.display = "none";
  }
}

function _resetState(runOnDone = true) {
  _isSpeaking = false;
  _isPaused   = false;
  _envelope   = 0;
  _charOffset = 0;
  _setButtons(_activeWrap, "idle");
  _activeWrap = null;
  if (runOnDone && _onDone) _onDone();
  _onDone = null;
}

// REAL, NEW — a generation counter so overlapping _speakEdgeTTS calls
// (e.g. two replies landing close together, common with the VAD
// misfires seen in tonight's logs) can tell a genuinely broken
// playback apart from one that was simply superseded by a newer reply
// starting. Without this, pausing an older _audioEl mid-play() throws
// "interrupted by a call to pause()" on the OLDER call — which was
// expected and fine — but the resulting console noise made real
// failures indistinguishable, and in the worst case a race between
// which play() call actually "won" could silence the NEWEST reply
// instead of the old one, matching exactly what Joel reported.
let _playGeneration = 0;

// ── Edge TTS via api/tts.js — the ONLY voice path now ─────────────────────
async function _speakEdgeTTS(text, onDone, wrap) {
  const myGeneration = ++_playGeneration;
  try {
    const res = await fetch("/api/tts", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ text: text.slice(0, 3000) }),
    });
    if (!res.ok) throw new Error("TTS API " + res.status);

    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);

    // REAL — if a NEWER call has already started while this one was
    // still fetching, bail out cleanly instead of fighting over
    // _audioEl. The newer call is the one that should actually speak.
    if (myGeneration !== _playGeneration) { URL.revokeObjectURL(url); return false; }

    if (_audioEl) {
      // REAL FIX — pausing the previous element is intentional and
      // expected here (a newer reply is taking over), not a failure.
      // Wrapped so it can never throw synchronously into this call.
      try { _audioEl.pause(); _audioEl.src = ""; } catch (_) { /* expected during handoff */ }
    }
    _audioEl = new Audio(url);
    _wireAnalyser(_audioEl);

    _audioEl.onplay  = () => {
      if (myGeneration !== _playGeneration) return; // stale, a newer call already took over
      _isSpeaking = true;
      _setButtons(wrap, "playing");
      // REAL — notified here, at the actual playback lifecycle point,
      // rather than at each of the many Speech.speak() call sites
      // scattered through app.js. This guarantees hands-free-vad.js's
      // barge-in check always reflects Flow's real audio state,
      // regardless of which call site triggered this reply.
      import("./hands-free-vad.js").then(m => m.setFlowSpeakingState(true)).catch(() => {});
      import("./streaming-asr.js").then(m => m.setFlowSpeakingState(true)).catch(() => {});
    };
    _audioEl.onended = () => {
      URL.revokeObjectURL(url);
      if (myGeneration !== _playGeneration) return; // stale — a newer call already owns state
      import("./hands-free-vad.js").then(m => m.setFlowSpeakingState(false)).catch(() => {});
      import("./streaming-asr.js").then(m => m.setFlowSpeakingState(false)).catch(() => {});
      _resetState(true);
      if (onDone) onDone();
    };
    // REAL, Joel-requested CHANGE: previously fell back to browser TTS
    // here. Now a real playback error just logs and stops cleanly — the
    // reply stays visible in chat as text either way, so nothing is
    // actually lost, but Flow's voice never unexpectedly switches to a
    // generic robotic one.
    _audioEl.onerror = () => {
      URL.revokeObjectURL(url);
      if (myGeneration !== _playGeneration) return; // stale — expected, not a real failure, don't warn or reset newer state
      console.warn("[Flow TTS] Edge TTS playback failed — not speaking this reply aloud (text is still in chat).");
      _resetState(true);
    };

    _activeWrap = wrap;
    _onDone     = onDone;
    await _audioEl.play();
    return true;
  } catch (e) {
    // REAL FIX — the specific "interrupted by a call to pause()"
    // browser error is EXPECTED when a newer reply has superseded this
    // one (myGeneration will have moved on by the time this settles).
    // Only warn for genuine failures, not this expected handoff case.
    if (myGeneration !== _playGeneration && /interrupted by a call to pause/i.test(e.message || "")) {
      return false;
    }
    console.warn("[Flow TTS] Edge TTS request failed:", e.message, "— not speaking this reply aloud (text is still in chat).");
    if (myGeneration === _playGeneration) _resetState(true); // only reset shared state if this call still actually owns it
    return false;
  }
}

// ── Public Speech API ─────────────────────────────────────────────────────
export const Speech = {

  async speak(text, onDone, wrap) {
    const clean = stripForSpeech(text);
    if (!clean || clean === "here is the code") { if (onDone) onDone(); return; }

    // ── Stop everything currently playing — one clean slate ──────────────
    _isSpeaking = false;
    _isPaused   = false;
    if (_audioEl) {
      try { _audioEl.pause(); _audioEl.src = ''; } catch(_) {}
      _audioEl = null;
    }

    if (_activeWrap && _activeWrap !== wrap) _setButtons(_activeWrap, 'idle');
    _fullText   = clean;
    _charOffset = 0;
    _activeWrap = wrap;
    _onDone     = onDone || null;

    // ── LOCK speaking immediately (synchronous) before any await ──────────
    _isSpeaking = true;

    await _speakEdgeTTS(clean, onDone, wrap);
  },

  pause() {
    if (!_isSpeaking || _isPaused) return;
    _isPaused = true;
    _envelope = 0;
    const savedWrap = _activeWrap;
    const savedDone = _onDone;
    if (_audioEl) { _audioEl.pause(); _isSpeaking = true; _setButtons(savedWrap, "paused"); return; }
    _isSpeaking = true;
    _isPaused   = true;
    _activeWrap = savedWrap;
    _onDone     = savedDone;
    _setButtons(savedWrap, "paused");
  },

  resume() {
    if (!_isPaused) return;
    _isPaused = false;
    if (_audioEl && _audioEl.paused) { _audioEl.play(); _setButtons(_activeWrap, "playing"); }
    // REAL, honest note: mid-utterance resume-from-a-specific-character
    // isn't possible anymore now that speechSynthesis (which supported
    // resuming from a live boundary event) is gone — Audio elements
    // don't have an equivalent word-boundary API. Resuming just
    // continues the same audio clip from where it was paused, which
    // Audio.play() already does natively above.
  },

  cancel() {
    if (_audioEl) { _audioEl.pause(); _audioEl.src = ""; _audioEl = null; }
    // REAL — cancel() pauses directly rather than letting the clip
    // reach its natural end, so onended (where this is normally
    // cleared) never fires here. Without this, a barge-in-triggered
    // cancel would leave hands-free-vad.js thinking Flow is still
    // speaking indefinitely.
    import("./hands-free-vad.js").then(m => m.setFlowSpeakingState(false)).catch(() => {});
    import("./streaming-asr.js").then(m => m.setFlowSpeakingState(false)).catch(() => {});
    _resetState(false);
  },

  reread(wrap) {
    this.cancel();
    const bubble = wrap?.querySelector?.(".mbubble");
    if (bubble) this.speak(bubble.textContent || "", null, wrap);
  },

  isSpeaking()  { return _isSpeaking && !_isPaused; },
  isPaused()    { return _isPaused; },
  getEnvelope() { return _envelope; },
};
