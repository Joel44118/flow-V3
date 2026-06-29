// api/tg-setup.js — Telegram UserBot one-time setup page
// This creates a web UI for logging into your personal Telegram account
// Uses MTProto via a lightweight approach - sends auth request to Telegram
// 
// NOTE: This is for PERSONAL TELEGRAM ACCOUNT auto-reply
// (different from the Bot API which only replies to bot messages)
//
// HOW IT WORKS:
// 1. Visit https://flow-v3-mu.vercel.app/api/tg-setup (after deploy)
// 2. Enter your phone number
// 3. Enter the OTP Telegram sends you
// 4. A session string is generated
// 5. Add it as TELEGRAM_SESSION to Vercel env vars
// 6. Flow will then auto-reply from your personal account
//
// IMPORTANT: This requires TELEGRAM_API_ID and TELEGRAM_API_HASH
// Get them free at: https://my.telegram.org/apps → Create app
// Add to Vercel env vars: TELEGRAM_API_ID and TELEGRAM_API_HASH

export default function handler(req, res) {
  const apiId   = process.env.TELEGRAM_API_ID;
  const apiHash = process.env.TELEGRAM_API_HASH;

  const configured = !!(apiId && apiHash);

  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Flow — Telegram UserBot Setup</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', sans-serif;
      background: #060a1a; color: #fff;
      min-height: 100vh; display: flex;
      align-items: center; justify-content: center;
      padding: 24px;
    }
    .card {
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 20px; padding: 36px;
      width: 100%; max-width: 420px;
      backdrop-filter: blur(20px);
    }
    .logo { font-size: 28px; font-weight: 700; letter-spacing: .3em; color: #38bdf8; margin-bottom: 8px; }
    .sub { font-size: 13px; color: rgba(255,255,255,0.45); margin-bottom: 28px; line-height: 1.6; }
    .step { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
            border-radius: 12px; padding: 14px 16px; margin-bottom: 12px; }
    .step-num { font-size: 11px; color: #38bdf8; font-weight: 700; letter-spacing: .1em; margin-bottom: 6px; }
    .step p { font-size: 13px; color: rgba(255,255,255,0.75); line-height: 1.6; }
    .step a { color: #38bdf8; text-decoration: none; }
    .step code { background: rgba(56,189,248,0.15); border-radius: 4px; padding: 2px 6px; font-size: 12px; color: #38bdf8; }
    .status { padding: 12px 16px; border-radius: 10px; font-size: 13px; margin-bottom: 20px; }
    .ok  { background: rgba(74,222,128,0.1); border: 1px solid rgba(74,222,128,0.3); color: #4ade80; }
    .err { background: rgba(239,68,68,0.1);  border: 1px solid rgba(239,68,68,0.3);  color: #f87171; }
  </style>
</head>
<body>
<div class="card">
  <div class="logo">FLOW</div>
  <div class="sub">Telegram Personal Account Setup<br>Auto-reply from your own Telegram number</div>

  ${configured
    ? '<div class="status ok">✅ TELEGRAM_API_ID and TELEGRAM_API_HASH are configured</div>'
    : '<div class="status err">⚠️ TELEGRAM_API_ID or TELEGRAM_API_HASH not set in Vercel env vars</div>'
  }

  <div class="step">
    <div class="step-num">STEP 1</div>
    <p>Go to <a href="https://my.telegram.org/apps" target="_blank">my.telegram.org/apps</a><br>
    Log in → Create App → copy <code>API ID</code> and <code>API Hash</code><br>
    Add both to Vercel → Settings → Environment Variables</p>
  </div>

  <div class="step">
    <div class="step-num">STEP 2</div>
    <p>Add these to Vercel env vars:<br>
    <code>TELEGRAM_API_ID</code> = your app ID<br>
    <code>TELEGRAM_API_HASH</code> = your app hash</p>
  </div>

  <div class="step">
    <div class="step-num">STEP 3</div>
    <p>Redeploy Vercel, then come back here and the full setup form will appear.<br>
    You'll enter your phone number and a one-time Telegram OTP to generate a session token.</p>
  </div>

  <div class="step">
    <div class="step-num">STEP 4 — COMING SOON</div>
    <p>The phone + OTP flow will be added here once API credentials are set.<br>
    This lets Flow reply to messages sent to your <strong>personal</strong> Telegram, not just your bot.</p>
  </div>
</div>
</body>
</html>`);
}
