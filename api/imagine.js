// ═══════════════════════════════════════════
// api/imagine.js — AI image generation
//
// Uses Pollinations.ai — completely FREE,
// no API key, no sign-up, unlimited images.
// Supports custom dimensions.
//
// GET /api/imagine?prompt=...&w=1024&h=768
// ═══════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { prompt, w = 1024, h = 1024, model = "flux" } = req.query;
  if (!prompt) return res.status(400).json({ error: "prompt required" });

  // Pollinations.ai — free, no key, supports custom sizes
  // Models: flux (best quality), turbo (fastest), flux-realism
  const encoded = encodeURIComponent(prompt);
  const url = `https://image.pollinations.ai/prompt/${encoded}?width=${w}&height=${h}&model=${model}&nologo=true&enhance=true`;

  try {
    // Fetch the image and proxy it back
    const imgRes = await fetch(url);
    if (!imgRes.ok) throw new Error(`Image service returned ${imgRes.status}`);

    const buffer = await imgRes.arrayBuffer();
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.status(200).send(Buffer.from(buffer));
  } catch(e) {
    // Fallback: return the URL directly so browser can load it
    return res.status(200).json({ url, fallback: true });
  }
}
