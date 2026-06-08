# Flow V3 — Setup & Configuration

## Environment Variables (Vercel)

Set these in your Vercel project settings:

### Required (for chat & vision)
```
OPENROUTER_API_KEY=sk_or_xxxxx
```
Get from: https://openrouter.ai/keys

### Image Generation (choose one or more)
```
# Option 1: OpenAI DALL-E (best quality, ~$0.08/image)
OPENAI_API_KEY=sk-xxxxx

# Option 2: Hugging Face (free tier + paid, multiple models)
HUGGINGFACE_API_KEY=hf_xxxxx
```

## Features Overview

### 1. **Claude 3.5 Sonnet as Primary AI**
- Best reasoning and understanding
- Fallbacks: Claude Opus, GPT-4o mini, Gemini Flash
- Uses OpenRouter for unified API access

### 2. **Image Generation** (Replaces Pollinations)
- **DALL-E 3**: Highest quality ($0.08/image)
- **Hugging Face Flux**: Free tier + paid options
- Support for: FLUX.1-dev, SDXL, Stable Diffusion 3
- Say: *"Imagine a sunset over the mountains"*

### 3. **Vision System**
- **Camera**: Real-time webcam analysis (describe what you see)
- **Screen Share**: Analyze your screen content
- **YOLO v10**: Object detection (optimized for 0.75s cycle)

### 4. **Performance Improvements**

#### YOLO Optimization
- Downscaled processing (416x416) for faster inference
- Reduced detection frequency (1 detection per 0.75s)
- Non-blocking UI with proper async handling
- Draggable + resizable vision windows
- ~1-2 FPS sustained vs 20+ seconds before

## Commands

### Chat
- "What's the weather?" → Real-time weather
- "Set alarm for 3pm" → Alarms with notifications
- "What time is it?" → Time/date queries

### Vision
- "Open camera" / "Open screen" → Start capturing
- "What do you see?" → Describe current view
- "Start YOLO" → Object detection

### Image Generation
- "Imagine a futuristic city"
- "Generate image of a sunset"
- "Create a portrait of a knight"

### Memory
- "Export brain" → Backup memory
- "Clear memory" → Reset everything

## Architecture Changes

### New Files
- `api/imagine.js` — Image generation endpoint (OpenAI/HF)

### Modified Files
- `api/chat.js` — Claude as primary, image routing
- `ui/vision.js` — Optimized YOLO, better windowing
- `core/commands.js` — Image generation commands
- `styles.css` — Improved vision window styling
- `vercel.json` — Added imagine endpoint config

## Testing Checklist

- [ ] Chat works with Claude
- [ ] Image generation responds (set API keys first)
- [ ] Camera/Screen capture works
- [ ] YOLO runs at reasonable speed (0.75s per detection)
- [ ] Vision windows are draggable/resizable
- [ ] No "Pollinations rate limit" errors

## Troubleshooting

**"YOLO still laggy"**
- Reduce `this._animId = setTimeout(() => this._loop(), 750);` (currently 750ms = 1.33fps)
- Increase to 1000+ for 1fps if needed

**Image generation unavailable**
- Verify `OPENAI_API_KEY` or `HUGGINGFACE_API_KEY` is set in Vercel
- Check logs: `vercel logs`

**Vision windows not resizing**
- Drag from the header to move
- Drag from the bottom-right corner to resize
- Windows should stay positioned where you place them

**Claude not responding**
- Check `OPENROUTER_API_KEY` is valid
- Fallbacks will try GPT-4o mini, Gemini if Claude fails

## Model Fallback Chain
1. **Claude 3.5 Sonnet** (primary)
2. Claude 3 Opus
3. OpenAI GPT-4o mini
4. Google Gemini Flash 1.5
5. Meta Llama 3.1

## Cost Estimates (Monthly)

- **Chat**: ~$0-2 (Claude Sonnet pricing)
- **Vision**: ~$0-1 (gpt-4o-mini vision calls)
- **Images**: $0-10 (depends on DALL-E usage, or free with HF)
- **Total**: Usually under $5/month

---

**Flow V3** — Your AI assistant with vision, memory, and creativity. 🚀
