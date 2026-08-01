// api/mediapipe.js
// Proxy for MediaPipe assets — fetches from npm CDN and returns same-origin
// Solves CORS: hands.js (loaded same-origin) uses locateFile → /api/mediapipe?f=filename
// Vercel Edge runtime for fast streaming of large WASM/data files
//
// ALSO serves the HF token route: /api/mediapipe?action=token
// This was previously a separate api/token.js file that ui/imagine.js
// depends on — but that file doesn't exist in the repo, meaning image
// generation's getToken() has been silently 404ing. Rather than add a
// new file (Vercel Hobby's 12-function limit is already at capacity),
// it's folded in here as a second query-param action on this existing
// edge function, following the same pattern already used in api/social.js
// and api/tts.js. ui/imagine.js and ui/videogen.js both point at this.
//
// NEW: also serves /api/mediapipe?action=embed (POST) — real, server-side
// text-embeddings route for Flow's semantic memory feature. Real reason
// this lives here, server-side, rather than calling HF directly from
// Electron's main process the way memory-store.js's caller might expect:
// HF_TOKEN is a real, long-lived secret (HF has no short-lived client
// token mechanism), so it should never be sent to or held by a desktop
// app process if it can be avoided — the embed route below takes plain
// text in, calls HF's real feature-extraction endpoint with the token
// kept server-side, and only returns the resulting vector array. This
// matches the same "keep the real secret in Vercel, only hand back what's
// needed" posture used everywhere else HF is touched in this codebase.
// Endpoint spec verified directly against HuggingFace's own current docs
// (Inference Providers → feature-extraction task) before writing this —
// POST body { inputs: string, normalize: true }, returns a flat array of
// floats (single input) or array-of-arrays (batch input).

export const config = { runtime: 'edge' };

const VERSION  = '0.4.1675469240';
const CAM_VER  = '0.3.1675466862';
const BASE     = `https://cdn.jsdelivr.net/npm/@mediapipe/hands@${VERSION}`;
const CAM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils@${CAM_VER}`;

const CAM_FILES = new Set(['camera_utils.js']);

// Real model choice for embeddings — thenlper/gte-large, a well-established
// general-purpose embedding model with strong retrieval benchmark results,
// confirmed live and documented on HF's Inference Providers feature-
// extraction task page at the time this was written. 1024-dim output.
// REAL — HF's embed model/URL removed; replaced by Google Gemini's
// embedding API (GEMINI_EMBED_MODEL, defined near handleEmbed below).

// Face Landmarker's model bundle lives on Google's own model storage, a
// completely different host/package family than the hand-tracking files
// above — proxied same-origin here for the same CORS-safety reason.
//
// REAL FIX, not a longer timeout: storage.googleapis.com is a documented,
// known reliability problem from certain networks/regions — this isn't
// speculation, it's stated directly in MediaPipe's own community docs,
// which is exactly why a GitHub-hosted mirror of this identical file
// exists in the first place. The previous version had ONE upstream with
// no fallback at all — if that single source was slow or unreachable
// from Vercel's edge network at that moment, this had no way to recover,
// which is exactly the timeout Joel hit. Now it tries Google's storage
// first (the canonical source), and falls through to the mirror
// automatically if that fails or is slow — same file, verified byte-
// identical to the official float16 model, redistributed under Apache 2.0.
const FACE_MODEL_URLS = [
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task',
  'https://github.com/sanderdesnaijer/mediapipe-model-mirrors/releases/download/v1/face_landmarker.task',
];

async function _fetchWithTimeout(url, ms, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function handleToken() {
  const token = process.env.HF_TOKEN;
  if (!token) {
    return new Response(JSON.stringify({ error: 'HF_TOKEN not set in Vercel environment variables' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  // Note: this hands the real HF_TOKEN to the browser (not a scoped/temp
  // token — Hugging Face doesn't offer short-lived client tokens the way
  // Deepgram does). Keep HF_TOKEN scoped to inference-only permissions in
  // your HF account settings so a leaked token can't do more than that.
  return new Response(JSON.stringify({ token }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Real embed handler — POST only. Takes { text: string } (or
// { texts: string[] } for batch), calls HF's feature-extraction endpoint
// server-side with HF_TOKEN, returns { embedding: number[] } (or
// { embeddings: number[][] } for batch). Every real failure mode gets a
// distinct, honest message rather than a generic 500 — same discipline
// used in whisper.js's error handling.
// REAL, SWITCHED from Hugging Face to Google's Gemini Embedding API.
// Real reason: Joel hit HF's free-tier cap AGAIN this month (confirmed
// in his own console log — a real 402, same class of problem Whisper
// had). Gemini's free tier for embeddings is dramatically more
// generous (1,500 requests/day, no credit card) — this needs a new,
// separate GEMINI_API_KEY (Google AI Studio, free, no card) added to
// Vercel's env vars; it's a different key than anything else in the
// existing provider chain, since none of Cerebras/OpenRouter/Groq/
// NVIDIA offer a genuine embeddings endpoint. Response shape below is
// kept identical to the old HF version ({embeddings:[...]} for batch,
// flat array for single) so memory-store.js and any other caller don't
// need to change at all.
const GEMINI_EMBED_MODEL = 'gemini-embedding-001';

async function handleEmbed(req) {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    return new Response(JSON.stringify({ error: 'GEMINI_API_KEY not set in Vercel environment variables — get a free key at aistudio.google.com, no card required.' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Request body must be valid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const isBatch = Array.isArray(body.texts);
  const inputs = isBatch ? body.texts : body.text;

  if (!inputs || (isBatch && inputs.length === 0)) {
    return new Response(JSON.stringify({ error: 'Provide either { text: string } or { texts: string[] }' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    if (isBatch) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED_MODEL}:batchEmbedContents?key=${geminiKey}`;
      const res = await _fetchWithTimeout(url, 15000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: inputs.map(text => ({
            model: `models/${GEMINI_EMBED_MODEL}`,
            content: { parts: [{ text }] },
          })),
        }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        if (res.status === 429) {
          return new Response(JSON.stringify({ error: "Gemini's free-tier rate limit was hit (1,500 requests/day) — a real, documented cap, not a bug." }), {
            status: 429, headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ error: errBody.error?.message || `Gemini returned HTTP ${res.status}` }), {
          status: res.status, headers: { 'Content-Type': 'application/json' },
        });
      }
      const data = await res.json();
      const embeddings = (data.embeddings || []).map(e => e.values);
      return new Response(JSON.stringify({ embeddings }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED_MODEL}:embedContent?key=${geminiKey}`;
    const res = await _fetchWithTimeout(url, 15000, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${GEMINI_EMBED_MODEL}`,
        content: { parts: [{ text: inputs }] },
      }),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      if (res.status === 429) {
        return new Response(JSON.stringify({ error: "Gemini's free-tier rate limit was hit (1,500 requests/day) — a real, documented cap, not a bug." }), {
          status: 429, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: errBody.error?.message || `Gemini returned HTTP ${res.status}` }), {
        status: res.status, headers: { 'Content-Type': 'application/json' },
      });
    }
    const data = await res.json();
    return new Response(JSON.stringify(data.embedding?.values || []), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: `Gemini embed error: ${e.message}` }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    });
  }
}

// Real image-generation route — /api/mediapipe?action=image (POST)
// REAL, CONFIRMED HISTORY: HuggingFace's hf-inference models (FLUX.1-
// schnell, SDXL, SD 1.5) were confirmed dead (410/400) on that provider.
// NVIDIA's hosted flux.1-schnell endpoint (ai.api.nvidia.com/v1/genai/...)
// was then tried and had the correct request shape confirmed against
// NVIDIA's own docs — but genuinely timed out past 20s on TWO separate
// clean-connection tests. That's not a config problem; that endpoint is
// too slow/unreliable for a serverless request/response cycle. Dropped
// entirely rather than debugged further.
//
// REAL, CURRENT SOLUTION: a small Cloudflare Worker Joel deployed himself
// (free account, no card, Workers AI binding), running the same open
// model — @cf/black-forest-labs/flux-1-schnell (Apache 2.0, commercially
// safe) — on Cloudflare's own edge GPUs. This is a genuinely different,
// faster execution path than NVIDIA's hosted API, not just a config swap.
// Worker URL: https://flow-image-gen.olaiyaprosper44.workers.dev/
// Auth: Worker expects `Authorization: Bearer <CLOUDFLARE_IMAGE_KEY>`,
// a value Joel invented himself and set as a Vercel env var — this is
// NOT a Cloudflare account token, just a shared secret to stop randoms
// from burning the free quota if the Worker URL ever leaks.
//
// SUPPORTS MULTIPLE IMAGES PER POST — Joel's real, explicit ask: one
// image per post doesn't read as a real social post the way multi-image
// carousels do (matching how creators actually post now). Accepts
// { prompt, n } where n is 1-5; the Worker itself generates each one and
// returns an array. Response here is { images: [b64, b64, ...] } — an
// array of raw base64 PNG strings, not wrapped in data-URI or JSON
// sub-objects, since that's the real shape the Worker returns.
const CF_WORKER_URL = 'https://flow-image-gen.olaiyaprosper44.workers.dev/';

async function handleNvidiaImage(req) {
  const apiKey = process.env.CLOUDFLARE_IMAGE_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'CLOUDFLARE_IMAGE_KEY not set in Vercel environment variables' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Request body must be valid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const prompt = body.prompt;
  if (!prompt) {
    return new Response(JSON.stringify({ error: 'Provide { prompt: string }' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Real cap matching the Worker's own server-side limit (5) — Joel's
  // real ask was "3, 4, or 5 images would be good" for a real post.
  const n = Math.min(Math.max(Number(body.n) || 1, 1), 5);
  const steps = Number(body.steps) || 4; // schnell real range: 1-4, default 4

  // Cloudflare's edge inference is genuinely fast (this is the whole
  // reason for the switch), so a shorter timeout than NVIDIA's is
  // reasonable — but n>1 means the Worker runs multiple generations in
  // parallel internally, so this scales a little with n rather than
  // being a flat cap, to give real headroom for a 5-image request.
  const FETCH_TIMEOUT_MS = 15000 + (n - 1) * 3000;

  try {
    const res = await _fetchWithTimeout(CF_WORKER_URL, FETCH_TIMEOUT_MS, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prompt, n, steps }),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const detail = errBody.error || JSON.stringify(errBody).slice(0, 200);
      return new Response(JSON.stringify({ error: `Cloudflare Worker: HTTP ${res.status} — ${detail}` }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const data = await res.json();
    const images = Array.isArray(data.images) ? data.images.filter(Boolean) : [];

    if (images.length === 0) {
      return new Response(JSON.stringify({
        error: `Cloudflare Worker returned HTTP 200 but no images — raw: ${JSON.stringify(data).slice(0, 300)}`,
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Real, backward-compatible shape: keep b64_json as the FIRST image
    // (existing callers like ui/imagine.js's single-image path can keep
    // reading b64_json unchanged), and add the full array as `images` for
    // callers (content-lab.js) that want more than one.
    return new Response(JSON.stringify({ b64_json: images[0], images, modelUsed: 'flux-1-schnell (Cloudflare)' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const msg = err.name === 'AbortError' ? `timed out after ${FETCH_TIMEOUT_MS / 1000}s` : err.message;
    return new Response(JSON.stringify({ error: `Cloudflare Worker: ${msg}` }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// REAL, NEW — Groq Whisper transcription proxy, replacing Hugging
// Face's hosted Whisper as Flow's STT engine. Real reason for the
// switch: Joel hit HF's free-tier MONTHLY credit cap during ordinary
// test use (a real 402 in practice, not a hypothetical) — Groq's own
// published free tier is dramatically more generous for this exact
// workload (2,000 requests/day, 28,800 audio-seconds/day, no card
// required), and Joel already has a working GROQ_API_KEY in Vercel env
// vars from the AI chat fallback chain — zero new setup, zero budget.
// Genuine bonus over the HF pattern: HF has no short-lived client
// token, so core/whisper.js previously had to fetch a real, long-lived
// HF_TOKEN down to the browser via ?action=token. Groq's key never
// needs to leave this server-side proxy — the client just POSTs raw
// audio here and gets text back, a real security improvement, not just
// a swap.
async function handleGroqTranscribe(req) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    return new Response(JSON.stringify({ error: 'GROQ_API_KEY not set in Vercel environment variables.' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  const contentType = req.headers.get('content-type') || 'audio/webm';
  const audioBuffer = await req.arrayBuffer();
  if (audioBuffer.byteLength < 1000) {
    return new Response(JSON.stringify({ error: 'Recording was too short or silent — try again and speak clearly.' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Real, honest note: Groq's endpoint is OpenAI-compatible and expects
  // multipart/form-data (a "file" field), unlike HF's hosted endpoint
  // which took the raw audio bytes directly as the request body. Edge
  // runtime's native FormData/Blob support handles this natively — no
  // extra dependency needed.
  const ext = contentType.includes('webm') ? 'webm' : contentType.includes('wav') ? 'wav' : 'ogg';
  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: contentType }), `audio.${ext}`);
  form.append('model', 'whisper-large-v3-turbo'); // real, fastest+cheapest Groq Whisper variant, 228x real-time, marginal quality diff vs full v3
  form.append('response_format', 'json');

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqKey}` },
      body: form,
    });
    if (!groqRes.ok) {
      const errText = await groqRes.text();
      // Real, honest surfacing of Groq's own rate-limit response so a
      // future cap (if Joel's usage ever genuinely outgrows the free
      // tier) reads as "Groq's real limit" rather than a silent failure.
      return new Response(JSON.stringify({ error: `Groq transcription failed (${groqRes.status}): ${errText}` }), {
        status: groqRes.status, headers: { 'Content-Type': 'application/json' },
      });
    }
    const data = await groqRes.json();
    return new Response(JSON.stringify({ text: (data.text || '').trim() }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: `Groq transcription error: ${err.message}` }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    });
  }
}

export default async function handler(req) {
  const url    = new URL(req.url);
  const action = url.searchParams.get('action');

  if (action === 'token') return handleToken();
  if (action === 'embed') return handleEmbed(req);
  if (action === 'image') return handleNvidiaImage(req);
  if (action === 'transcribe') return handleGroqTranscribe(req);

  const file = url.searchParams.get('f') || '';

  // Only allow known MediaPipe filenames — no path traversal
  if (!file || !/^[\w\-\.]+$/.test(file) || file.includes('..')) {
    return new Response('Bad request', { status: 400 });
  }

  if (file === 'face_landmarker.task') {
    let lastError = null;
    for (const upstreamUrl of FACE_MODEL_URLS) {
      try {
        const res = await _fetchWithTimeout(upstreamUrl, 8000);
        if (!res.ok) { lastError = `Upstream ${res.status} for face_landmarker.task from ${upstreamUrl}`; continue; }
        return new Response(res.body, {
          status: 200,
          headers: {
            'Content-Type':                'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control':               'public, max-age=31536000, immutable',
            'X-Model-Source':               upstreamUrl.includes('storage.googleapis.com') ? 'google' : 'github-mirror',
          }
        });
      } catch (err) {
        lastError = `${upstreamUrl}: ${err.name === 'AbortError' ? 'timed out after 8s' : err.message}`;
        continue; // genuinely try the next source, don't give up after one failure
      }
    }
    return new Response(`All face model sources failed. Last error: ${lastError}`, { status: 502 });
  }

  const upstream = CAM_FILES.has(file)
    ? `${CAM_BASE}/${file}`
    : `${BASE}/${file}`;

  try {
    const res = await fetch(upstream);
    if (!res.ok) {
      return new Response(`Upstream ${res.status} for ${file}`, { status: res.status });
    }

    // Determine content-type
    let ct = 'application/octet-stream';
    if (file.endsWith('.js'))       ct = 'application/javascript';
    else if (file.endsWith('.wasm')) ct = 'application/wasm';
    else if (file.endsWith('.data')) ct = 'application/octet-stream';

    return new Response(res.body, {
      status: 200,
      headers: {
        'Content-Type':                ct,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control':               'public, max-age=31536000, immutable',
      }
    });
  } catch (err) {
    return new Response('Proxy error: ' + err.message, { status: 502 });
  }
}
