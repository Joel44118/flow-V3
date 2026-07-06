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

export const config = { runtime: 'edge' };

const VERSION  = '0.4.1675469240';
const CAM_VER  = '0.3.1675466862';
const BASE     = `https://cdn.jsdelivr.net/npm/@mediapipe/hands@${VERSION}`;
const CAM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils@${CAM_VER}`;

const CAM_FILES = new Set(['camera_utils.js']);

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

async function _fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
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

export default async function handler(req) {
  const url    = new URL(req.url);
  const action = url.searchParams.get('action');

  if (action === 'token') return handleToken();

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
