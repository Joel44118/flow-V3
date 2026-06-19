// ═══════════════════════════════════════════
// api/imageedit.js — Image editing via HuggingFace img2img
//
// Uses Stable Diffusion XL img2img / instruct-pix2pix style
// editing. Takes a base64 image + a text instruction and
// returns the edited image as base64 PNG.
//
// ENV VAR: HF_TOKEN (same one used for /api/imagine)
// ═══════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "POST only" });

  const HF_KEY = process.env.HF_TOKEN;
  if (!HF_KEY) {
    return res.status(500).json({ error: "HF_TOKEN not set in Vercel environment variables." });
  }

  const { image, instruction } = req.body || {};
  if (!image || !instruction) {
    return res.status(400).json({ error: "image (base64) and instruction required" });
  }

  // instruct-pix2pix is purpose-built for text-instructed image editing
  const MODEL = "timbrooks/instruct-pix2pix";

  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), 25000); // image edits take longer than text

  try {
    const r = await fetch(`https://api-inference.huggingface.co/models/${MODEL}`, {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${HF_KEY}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        inputs: instruction,
        parameters: {
          image: image, // base64 input image
        },
      }),
      signal: ctrl.signal,
    });
    clearTimeout(t);

    if (r.status === 503) {
      return res.status(503).json({ error: "Image edit model is warming up — try again in about 20 seconds." });
    }

    const contentType = r.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      const data = await r.json();
      return res.status(r.status).json({ error: data.error || "Edit failed" });
    }

    if (!r.ok) {
      return res.status(r.status).json({ error: `HTTP ${r.status}` });
    }

    // Response is raw image bytes
    const buffer = Buffer.from(await r.arrayBuffer());
    const base64 = buffer.toString("base64");

    return res.status(200).json({ image: base64 });

  } catch (err) {
    clearTimeout(t);
    if (err.name === "AbortError") {
      return res.status(504).json({ error: "Image edit timed out. Try a simpler instruction or try again." });
    }
    return res.status(500).json({ error: err.message });
  }
}
