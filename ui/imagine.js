// ═══════════════════════════════════════════
// ui/imagine.js — Image generation UI
// Calls /api/generate-image with proper error handling
// ═══════════════════════════════════════════

let _chat = null;
let _orb = null;

export function initImagine(chat, orb) {
  _chat = chat;
  _orb = orb;
}

// Parse dimension requests: "1920x1080", "square", "landscape", etc.
function parseDimensions(text) {
  const dimensionPresets = {
    "square": { w: 1024, h: 1024 },
    "landscape": { w: 1024, h: 576 },
    "portrait": { w: 576, h: 1024 },
    "banner": { w: 1920, h: 1080 },
    "wallpaper": { w: 2560, h: 1440 },
    "instagram": { w: 1080, h: 1080 },
    "twitter": { w: 1024, h: 512 },
    "thumbnail": { w: 1280, h: 720 },
    "poster": { w: 800, h: 1200 },
  };

  // Check for presets
  for (const [preset, dims] of Object.entries(dimensionPresets)) {
    if (text.toLowerCase().includes(preset)) {
      return dims;
    }
  }

  // Check for explicit WxH format
  const match = text.match(/(\d{3,4})\s*[x×]\s*(\d{3,4})/i);
  if (match) {
    return { w: parseInt(match[1]), h: parseInt(match[2]) };
  }

  // Default
  return { w: 1024, h: 1024 };
}

export async function generateImage(prompt) {
  try {
    _orb?.setState("thinking");
    _chat?.showTyping();

    const { w, h } = parseDimensions(prompt);

    const res = await fetch("/api/generate-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: prompt.slice(0, 1000),
        width: w,
        height: h,
        model: "grok", // Use Grok Imagine by default
      }),
    });

    _chat?.hideTyping();

    const data = await res.json();

    if (!res.ok || !data.url) {
      throw new Error(data.error || "Image generation failed");
    }

    // Create image card with preview
    const card = document.createElement("div");
    card.className = "img-card";
    card.innerHTML = `
      <img src="${data.url}" alt="Generated image" style="max-width:100%; border-radius:10px; cursor:pointer;" />
      <div class="img-meta">
        ${w}×${h} • ${data.provider}
      </div>
      <div style="display:flex; gap:8px; padding:8px 12px;">
        <a class="img-dl-btn" href="${data.url}" download="flow-image.jpg" target="_blank">
          DOWNLOAD
        </a>
        <button class="img-dl-btn" style="background:transparent; border:none; color:var(--cyan); cursor:pointer;" onclick="window.open('${data.url}', '_blank')">
          OPEN FULL
        </button>
      </div>
    `;

    _chat?.add(card.outerHTML, "bot");
    _orb?.setState("idle");

  } catch(e) {
    _chat?.hideTyping();
    _chat?.addError("Image generation failed: " + e.message);
    _orb?.setState("idle");
  }
}
