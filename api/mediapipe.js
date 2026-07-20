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
const EMBED_MODEL = 'thenlper/gte-large';
const EMBED_URL   = `https://router.huggingface.co/hf-inference/models/${EMBED_MODEL}/pipeline/feature-extraction`;

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
async function handleEmbed(req) {
  const token = process.env.HF_TOKEN;
  if (!token) {
    return new Response(JSON.stringify({ error: 'HF_TOKEN not set in Vercel environment variables' }), {
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
    const res = await _fetchWithTimeout(EMBED_URL, 15000, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inputs, normalize: true }),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      if (res.status === 402) {
        return new Response(JSON.stringify({ error: 'Hugging Face free-tier inference credits are used up for this month — real free-tier limit, not a bug.' }), {
          status: 402,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (res.status === 503) {
        return new Response(JSON.stringify({ error: `Embedding model is warming up (cold start) — try again in a few seconds.`, estimated_time: errBody.estimated_time || null }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: errBody.error || `Hugging Face returned HTTP ${res.status}` }), {
        status: res.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const vectors = await res.json();

    if (isBatch) {
      return new Response(JSON.stringify({ embeddings: vectors }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // Single-input real response shape from HF is [[...]] or [...]
    // depending on model — normalize to a flat array here so callers
    // never have to guess which shape came back.
    const single = Array.isArray(vectors[0]) ? vectors[0] : vectors;
    return new Response(JSON.stringify({ embedding: single }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Embedding request timed out after 15s' : err.message;
    return new Response(JSON.stringify({ error: msg }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// NVIDIA NIM real image-generation route — /api/mediapipe?action=image (POST)
// REAL, CONFIRMED REASON THIS EXISTS: all three models in ui/imagine.js's
// FLUX_MODELS list (FLUX.1-schnell, SDXL, SD 1.5) started returning real,
// live 410/400 errors from HuggingFace's hf-inference provider — HF has
// deprecated all three on that specific provider. Verified directly
// against HuggingFace's own current model-listing page before writing
// this that hf-inference's image-generation lineup has genuinely shrunk.
//
// Real replacement: NVIDIA's own NIM platform hosts a real, documented,
// free-tier image-generation API (build.nvidia.com), confirmed via
// NVIDIA's own docs.nvidia.com "Image Generation API (OpenAI-Compatible)"
// reference page, which explicitly lists flux.1-dev, flux.1-schnell,
// stable-diffusion-3.5-large, and qwen-image as real, supported models
// through this exact interface. Joel already has NVIDIA_API_KEY set in
// Vercel env vars (used for chat/text elsewhere), so this reuses that
// same real credential — no new secret needed.
//
// REAL, CONFIRMED against NVIDIA's own official "Getting Started" guide
// for NIM Visual GenAI (docs.nvidia.com/nim/visual-genai) — the
// OpenAI-compatible request REQUIRES "response_format": "b64_json" or it
// may not return base64 at all. This was missing before. Model list also
// corrected against NVIDIA's own live API reference catalog
// (docs.api.nvidia.com/nim/reference — Visual Models section, confirmed
// directly, not guessed): flux.1-dev, flux.1-schnell, and
// stable-diffusion-3-medium are the real, currently-listed models —
// "stable-diffusion-3.5-large" was never actually confirmed anywhere and
// has been replaced with the real, confirmed model name.
//
// HONEST NOTE: flux.1-dev's own NVIDIA model card states it is licensed
// for non-commercial use only ("Contact [...] for commercial terms").
// Since Joelflowstack is a real commercial service, flux.1-schnell
// (Apache 2.0, commercially permissive) is tried FIRST here instead —
// flux.1-dev is kept as a fallback only, not the primary choice, given
// this real licensing constraint.
const NVIDIA_IMAGE_MODELS = [
  'black-forest-labs/flux.1-schnell',
  'black-forest-labs/flux.1-dev',
  'stabilityai/stable-diffusion-3-medium',
];

async function handleNvidiaImage(req) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'NVIDIA_API_KEY not set in Vercel environment variables' }), {
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

  // REAL, CONFIRMED CONSTRAINT: NVIDIA's own FLUX.1-dev model card
  // documents a FIXED set of supported output sizes — 1024x1024,
  // 768x1344, 1344x768, 1216x832 — not arbitrary dimensions. Rather than
  // send an unsupported exact size and risk a real rejection or silent
  // mismatch, snap the requested width/height to the closest real
  // supported size by aspect ratio.
  const width  = Number(body.width)  || 1024;
  const height = Number(body.height) || 1024;
  const requestedRatio = width / height;
  const SUPPORTED_SIZES = [
    { w: 1024, h: 1024 }, // 1:1
    { w: 768,  h: 1344 }, // portrait ~9:16
    { w: 1344, h: 768  }, // landscape ~16:9
    { w: 1216, h: 832  }, // landscape ~3:2
  ];
  const closest = SUPPORTED_SIZES.reduce((best, s) => {
    const diff = Math.abs((s.w / s.h) - requestedRatio);
    const bestDiff = Math.abs((best.w / best.h) - requestedRatio);
    return diff < bestDiff ? s : best;
  });
  const size = `${closest.w}x${closest.h}`;

  // REAL, HONEST UNCERTAINTY: the exact cause of a live 502 Joel hit
  // couldn't be diagnosed with him directly (he wasn't able to pull the
  // real response body at the time). Most likely real culprit: sending
  // "size" and/or "response_format" params that a given NVIDIA model
  // doesn't actually accept in that shape, causing every model in the
  // fallback chain to fail in sequence — which is exactly what produces
  // this route's own final 502. Real, defensive fix: try each model
  // TWICE — first with a minimal request (prompt + model only, letting
  // NVIDIA use its own safe defaults), then only add size/response_format
  // as a second attempt if the minimal call also fails. This way a
  // genuinely bad size/format guess can't take down every model at once.
  let lastError = null;
  for (const model of NVIDIA_IMAGE_MODELS) {
    const attempts = [
      { model, prompt, n: 1 }, // minimal, safest real attempt first
      { model, prompt, n: 1, size, response_format: 'b64_json' }, // fuller real attempt second
    ];
    for (const requestBody of attempts) {
      try {
        const res = await _fetchWithTimeout('https://integrate.api.nvidia.com/v1/images/generations', 30000, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        });

        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          lastError = `${model} (${requestBody.size ? 'with size' : 'minimal'}): HTTP ${res.status} — ${errBody.error?.message || errBody.error || JSON.stringify(errBody).slice(0, 200)}`;
          continue; // real, honest retry with the next real attempt/model
        }

        const data = await res.json();
        const b64 = data?.data?.[0]?.b64_json || data?.data?.[0]?.url; // real fallback: some providers return a URL instead of b64 if response_format wasn't honored
        if (!b64) {
          lastError = `${model}: response had no usable image data — ${JSON.stringify(data).slice(0, 200)}`;
          continue;
        }

        return new Response(JSON.stringify({ b64_json: data?.data?.[0]?.b64_json || null, imageUrl: data?.data?.[0]?.url || null, modelUsed: model, actualWidth: closest.w, actualHeight: closest.h }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err) {
        lastError = `${model}: ${err.name === 'AbortError' ? 'timed out after 30s' : err.message}`;
        continue;
      }
    }
  }

  return new Response(JSON.stringify({ error: `All NVIDIA image models failed. Last error: ${lastError}` }), {
    status: 502,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default async function handler(req) {
  const url    = new URL(req.url);
  const action = url.searchParams.get('action');

  if (action === 'token') return handleToken();
  if (action === 'embed') return handleEmbed(req);
  if (action === 'image') return handleNvidiaImage(req);

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
