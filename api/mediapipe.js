// api/mediapipe.js
// Proxy for MediaPipe assets — fetches from npm CDN and returns same-origin
// Solves CORS: hands.js (loaded same-origin) uses locateFile → /api/mediapipe?f=filename
// Vercel Edge runtime for fast streaming of large WASM/data files

export const config = { runtime: 'edge' };

const VERSION  = '0.4.1675469240';
const CAM_VER  = '0.3.1675466862';
const BASE     = `https://cdn.jsdelivr.net/npm/@mediapipe/hands@${VERSION}`;
const CAM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils@${CAM_VER}`;

const CAM_FILES = new Set(['camera_utils.js']);

export default async function handler(req) {
  const url  = new URL(req.url);
  const file = url.searchParams.get('f') || '';

  // Only allow known MediaPipe filenames — no path traversal
  if (!file || !/^[\w\-\.]+$/.test(file) || file.includes('..')) {
    return new Response('Bad request', { status: 400 });
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
