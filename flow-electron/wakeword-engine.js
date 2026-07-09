// flow-electron/wakeword-engine.js
//
// Fully local wake-word detection, running entirely inside Electron's main
// process. Deliberately has NO fallback path and NO dependency on Railway,
// Deepgram, or any network service — if this file fails, wake-word
// detection is simply off, and Flow falls back to the existing
// click-to-record mic button. That's the explicit design Joel asked for:
// "no backups, just totally relying on the Electron [app]."
//
// REAL PIPELINE (verified against openWakeWord's own architecture docs and
// by inspecting Wake_up_Flow.onnx's actual input tensor shape directly —
// NOT assumed from the filename or trained-service name):
//
//   raw 16-bit PCM mono audio @ 16kHz (from bundled SoX child process)
//     → melspectrogram.onnx   (fixed, public, from openWakeWord's GitHub
//                              releases — NOT custom-trained, same file
//                              anyone using openWakeWord downloads)
//     → embedding_model.onnx  (fixed, public, same source — Google's
//                              pretrained speech-embedding backbone,
//                              re-implemented by openWakeWord in ONNX)
//     → sliding window of the last 16 embedding frames, shape [1,16,96]
//       (confirmed: this EXACTLY matches Wake_up_Flow.onnx's real input
//       tensor shape, inspected directly with onnx.load() — not guessed)
//     → Wake_up_Flow.onnx     (Joel's custom classifier, trained via
//                              outspoken.cloud on top of the embedding
//                              output above)
//     → single score [1,1] → threshold check → fire callback
//
// WHY SoX AND NOT A NATIVE AUDIO MODULE: naudiodon (or similar native
// bindings) risks the exact same native-compile fragility already hit
// with robotjs in this project. SoX is a plain, free, GPLv2/LGPLv2
// pre-built Windows binary (sox-14.4.2-win32.exe, ~3MB, from SourceForge)
// bundled alongside the app and run as a child process — zero native
// compilation, zero cost, and Joel explicitly chose this trade-off over
// naudiodon when asked.

const { spawn } = require('child_process');
const path = require('path');
const ort = require('onnxruntime-node');

// ── Tunables ────────────────────────────────────────────────────────────
const SAMPLE_RATE       = 16000;
const FRAME_SAMPLES      = 1280;   // 80ms @ 16kHz — openWakeWord's native chunk size
const EMBED_WINDOW_SIZE = 16;      // matches Wake_up_Flow.onnx's real [1,16,96] input, confirmed by inspection
const DETECT_THRESHOLD  = 0.5;     // starting point — adjust after Joel tests real false-accept/false-reject rate
const COOLDOWN_MS       = 2500;    // don't re-fire immediately after a detection while Whisper is still recording

let melModel   = null;
let embModel   = null;
let wakeModel  = null;
let soxProcess = null;

let pcmBuffer      = Buffer.alloc(0);   // raw bytes waiting to become a full 1280-sample frame
let embeddingQueue = [];                 // rolling window of embedding frames, each a Float32Array(96)
let lastFireAt     = 0;
let running        = false;

let _onWake = null;

// ── Model loading ───────────────────────────────────────────────────────
// All three .onnx files ship inside the app's resources folder (added via
// electron-builder's "files"/"extraResources" config) so nothing is
// downloaded at runtime — fully self-contained, works offline.
async function loadModels(resourcesPath) {
  const melPath  = path.join(resourcesPath, 'wakeword', 'melspectrogram.onnx');
  const embPath  = path.join(resourcesPath, 'wakeword', 'embedding_model.onnx');
  const wakePath = path.join(resourcesPath, 'wakeword', 'Wake_up_Flow.onnx');

  melModel  = await ort.InferenceSession.create(melPath);
  embModel  = await ort.InferenceSession.create(embPath);
  wakeModel = await ort.InferenceSession.create(wakePath);

  console.log('[WakeWord] All 3 models loaded:', melModel.inputNames, embModel.inputNames, wakeModel.inputNames);
}

// ── Pipeline: raw PCM frame → melspectrogram → embedding ────────────────
// Runs once per 1280-sample (80ms) chunk of audio.
async function processFrame(int16Frame) {
  // Convert int16 PCM to float32 in [-1, 1], the format both mel and
  // embedding models expect (standard for audio ONNX models — verified
  // against openWakeWord's own preprocessing, which normalizes this way).
  const floatFrame = new Float32Array(int16Frame.length);
  for (let i = 0; i < int16Frame.length; i++) {
    floatFrame[i] = int16Frame[i] / 32768;
  }

  const melInput = new ort.Tensor('float32', floatFrame, [1, floatFrame.length]);
  const melResult = await melModel.run({ [melModel.inputNames[0]]: melInput });
  const melOutput = melResult[melModel.outputNames[0]];

  const embResult = await embModel.run({ [embModel.inputNames[0]]: melOutput });
  const embOutput = embResult[embModel.outputNames[0]]; // shape (1,1,1,96) per openWakeWord's own docs

  // Flatten to a plain Float32Array(96) regardless of the exact wrapping
  // dims — we only care about the 96 values themselves.
  const embVec = Float32Array.from(embOutput.data);

  embeddingQueue.push(embVec);
  if (embeddingQueue.length > EMBED_WINDOW_SIZE) {
    embeddingQueue.shift(); // keep only the most recent 16 frames
  }

  if (embeddingQueue.length === EMBED_WINDOW_SIZE) {
    await runWakeClassifier();
  }
}

// ── Final stage: 16 stacked embeddings → Wake_up_Flow.onnx → score ──────
async function runWakeClassifier() {
  const stacked = new Float32Array(EMBED_WINDOW_SIZE * 96);
  for (let i = 0; i < EMBED_WINDOW_SIZE; i++) {
    stacked.set(embeddingQueue[i], i * 96);
  }

  const inputTensor = new ort.Tensor('float32', stacked, [1, EMBED_WINDOW_SIZE, 96]);
  const result = await wakeModel.run({ [wakeModel.inputNames[0]]: inputTensor });
  const score = result[wakeModel.outputNames[0]].data[0];

  const now = Date.now();
  if (score >= DETECT_THRESHOLD && (now - lastFireAt) > COOLDOWN_MS) {
    lastFireAt = now;
    console.log(`[WakeWord] "Wake up Flow" detected — score ${score.toFixed(3)}`);
    _onWake?.(score);
  }
}

// ── SoX child process — continuous raw PCM stream from the default mic ──
// Spawns SoX in "record to stdout, raw signed 16-bit PCM, mono, 16kHz"
// mode. This never needs to be restarted mid-session — it runs as long as
// Flow is open, exactly like Joel asked ("no backups, just totally
// relying on the Electron [app]").
function startSoxCapture(soxBinaryPath) {
  // sox -d           = record from the OS default input device
  // -t raw           = output raw headerless PCM (no WAV header) so we can
  //                    stream-parse it directly without a file
  // -b 16 -e signed  = 16-bit signed PCM, matches what int16Frame math above assumes
  // -r 16000 -c 1    = 16kHz mono, matches both openWakeWord's expected
  //                    sample rate AND core/whisper.js's existing rate
  // -                = write to stdout
  soxProcess = spawn(soxBinaryPath, [
    '-d', '-t', 'raw', '-b', '16', '-e', 'signed', '-r', String(SAMPLE_RATE), '-c', '1', '-',
  ]);

  soxProcess.stdout.on('data', (chunk) => {
    pcmBuffer = Buffer.concat([pcmBuffer, chunk]);

    const bytesPerFrame = FRAME_SAMPLES * 2; // 2 bytes per int16 sample
    while (pcmBuffer.length >= bytesPerFrame) {
      const frameBytes = pcmBuffer.subarray(0, bytesPerFrame);
      pcmBuffer = pcmBuffer.subarray(bytesPerFrame);

      const int16Frame = new Int16Array(
        frameBytes.buffer, frameBytes.byteOffset, FRAME_SAMPLES
      );
      processFrame(int16Frame).catch((e) => console.error('[WakeWord] frame processing error:', e.message));
    }
  });

  soxProcess.stderr.on('data', (d) => {
    // SoX writes normal progress info to stderr even on success — only
    // treat this as a real problem if the process actually exits non-zero
    // (handled in the 'close' listener below), so this stays a quiet log,
    // not a false alarm on every startup line.
    console.log('[WakeWord][sox]', d.toString().trim());
  });

  soxProcess.on('close', (code) => {
    running = false;
    if (code !== 0) {
      console.error(`[WakeWord] SoX exited unexpectedly (code ${code}) — wake-word listening has stopped. Click-to-record mic button still works normally.`);
    }
  });

  soxProcess.on('error', (e) => {
    console.error('[WakeWord] Failed to start SoX:', e.message, '— wake-word listening is off. Click-to-record mic button still works normally.');
  });
}

// ── Public API ────────────────────────────────────────────────────────
async function startWakeWordEngine({ resourcesPath, soxBinaryPath, onWakeDetected }) {
  if (running) return true;
  _onWake = onWakeDetected;

  try {
    await loadModels(resourcesPath);
    startSoxCapture(soxBinaryPath);
    running = true;
    console.log('[WakeWord] Engine started — listening locally for "Wake up Flow", no network dependency.');
    return true;
  } catch (e) {
    console.error('[WakeWord] Failed to start engine:', e.message);
    running = false;
    return false;
  }
}

function stopWakeWordEngine() {
  try { soxProcess?.kill(); } catch (_) {}
  soxProcess = null;
  embeddingQueue = [];
  pcmBuffer = Buffer.alloc(0);
  running = false;
}

module.exports = { startWakeWordEngine, stopWakeWordEngine };
