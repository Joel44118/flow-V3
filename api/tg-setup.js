// api/tg-setup.js — Telegram Personal Account setup status page
// (Replaces the earlier placeholder, which implied the full login flow
// could happen on this Vercel page. It can't — Telegram's personal-account
// protocol needs an always-on connection Vercel functions can't hold open.
// The real setup now lives in the telegram-userbot/ folder + Railway.
// This page just shows whether the Vercel-side credentials are configured.)

export default function handler(req, res) {
  const apiId   = process.env.TELEGRAM_API_ID;
  const apiHash = process.env.TELEGRAM_API_HASH;
  const configured = !!(apiId && apiHash);

  res.setHeader("Content-Type", "text/html");
  res.status(200).send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Flow — Telegram Personal Account</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',sans-serif;background:#060a1a;color:#fff;min-height:100vh;
       display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.18);
        border-radius:20px;padding:36px;width:100%;max-width:460px;backdrop-filter:blur(20px)}
  .logo{font-size:26px;font-weight:700;letter-spacing:.3em;color:#38bdf8;margin-bottom:8px}
  .sub{font-size:13px;color:rgba(255,255,255,0.45);margin-bottom:24px;line-height:1.6}
  .status{padding:12px 16px;border-radius:10px;font-size:13px;margin-bottom:20px}
  .ok{background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.3);color:#4ade80}
  .err{background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);color:#f87171}
  .note{background:rgba(56,189,248,0.08);border:1px solid rgba(56,189,248,0.2);
        border-radius:12px;padding:16px;font-size:13px;line-height:1.6;color:rgba(255,255,255,0.8)}
  .note strong{color:#38bdf8}
  code{background:rgba(56,189,248,0.15);border-radius:4px;padding:2px 6px;font-size:12px;color:#38bdf8}
</style></head>
<body><div class="card">
  <div class="logo">FLOW</div>
  <div class="sub">Telegram Personal Account — Status</div>
  ${configured
    ? '<div class="status ok">✅ TELEGRAM_API_ID and TELEGRAM_API_HASH are set on Vercel</div>'
    : '<div class="status err">⚠️ Not yet configured — add TELEGRAM_API_ID and TELEGRAM_API_HASH in Vercel env vars</div>'
  }
  <div class="note">
    The actual login and always-on listening for your personal account runs
    separately on Railway (Telegram's personal-account protocol needs a
    persistent connection Vercel can't hold).<br><br>
    See <strong>TELEGRAM_USERBOT_SETUP.md</strong> in the project files for the
    full step-by-step — it covers the one-time login (run once on your PC) and
    deploying the always-on listener to Railway's free tier.
  </div>
</div></body></html>`);
}
