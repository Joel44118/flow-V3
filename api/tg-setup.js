// api/tg-setup.js (v3) — Real browser-based Telegram personal-account login.
// NO command prompt, no terminal, no CLI script to run on your PC.
//
// WHY THIS WORKS WITHOUT A PERSISTENT CONNECTION:
// The earlier version explained that the ALWAYS-ON LISTENER (index.js on
// Railway) genuinely needs a persistent MTProto connection Vercel can't
// hold. That's still true and unchanged. But the ONE-TIME LOGIN itself is
// just two quick request/response round trips — send a code, then verify
// it — which is exactly what a stateless serverless function is good at.
// GramJS's high-level client.start() bundles both steps into one callback-
// driven call that expects to stay connected the whole time, which is why
// the earlier CLI script needed a live terminal session. Here, the same
// two steps are done with GramJS's lower-level MTProto calls
// (auth.SendCode, then auth.SignIn / auth.CheckPassword) so each step can
// be its own independent HTTP request. The in-progress phoneCodeHash and
// a live-but-unauthenticated session string are held in KV between the
// two requests, since nothing survives in server memory between them.
//
// FLOW:
//   1. GET  /api/tg-setup            → the login page (this file)
//   2. POST /api/tg-setup?step=send  → { phone } → sends the Telegram code
//   3. POST /api/tg-setup?step=verify → { code, password? } → completes
//      login and returns the final SESSION STRING to save as
//      TELEGRAM_SESSION on Railway.

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram/tl/index.js";
import { computeCheck } from "telegram/Password.js";

const KV_URL = process.env.KV_REST_API_URL;
const KV_KEY = process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  if (!KV_URL || !KV_KEY) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_KEY}` } });
    const d = r.ok ? await r.json() : null;
    return d?.result ?? null;
  } catch (_) { return null; }
}
async function kvSet(key, value, ttlSeconds = 600) {
  if (!KV_URL || !KV_KEY) return;
  try {
    await fetch(`${KV_URL}/set/${encodeURIComponent(key)}?EX=${ttlSeconds}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KV_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  } catch (_) {}
}
async function kvDel(key) {
  if (!KV_URL || !KV_KEY) return;
  try { await fetch(`${KV_URL}/del/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${KV_KEY}` } }); } catch (_) {}
}

function getClient(apiId, apiHash, sessionStr = "") {
  const session = new StringSession(sessionStr);
  return new TelegramClient(session, apiId, apiHash, { connectionRetries: 3 });
}

// ── Step 1: send the login code to Joel's Telegram account ────────────
async function handleSendCode(req, res, apiId, apiHash) {
  const { phone } = req.body || {};
  if (!phone?.trim()) return res.status(400).json({ ok: false, error: "Phone number required (with country code, e.g. +234...)" });

  const client = getClient(apiId, apiHash);
  try {
    await client.connect();
    const sent = await client.invoke(new Api.auth.SendCode({
      phoneNumber: phone.trim(),
      apiId,
      apiHash,
      settings: new Api.CodeSettings({}),
    }));

    // Hold everything needed to finish the login in the NEXT request —
    // this is the bridge across the two stateless HTTP calls.
    await kvSet(`tg_login_${phone.trim()}`, {
      phoneCodeHash: sent.phoneCodeHash,
      sessionStr:    client.session.save(), // unauthenticated but connected session
      apiId, apiHash,
    });

    return res.status(200).json({ ok: true, message: "Code sent — check Telegram on your phone." });
  } catch (e) {
    console.error("[TG Login] send_code error:", e.message);
    return res.status(502).json({ ok: false, error: e.message });
  } finally {
    try { await client.disconnect(); } catch (_) {}
  }
}

// ── Step 2: verify the code (and 2FA password if enabled) ─────────────
async function handleVerifyCode(req, res, apiId, apiHash) {
  const { phone, code, password } = req.body || {};
  if (!phone?.trim() || !code?.trim()) return res.status(400).json({ ok: false, error: "Phone and code are required" });

  const pending = await kvGet(`tg_login_${phone.trim()}`);
  if (!pending?.phoneCodeHash) {
    return res.status(400).json({ ok: false, error: "No pending login found for this number — request a new code first." });
  }

  const client = getClient(apiId, apiHash, pending.sessionStr);
  try {
    await client.connect();

    try {
      await client.invoke(new Api.auth.SignIn({
        phoneNumber:   phone.trim(),
        phoneCodeHash: pending.phoneCodeHash,
        phoneCode:     code.trim(),
      }));
    } catch (e) {
      // 2FA is enabled on the account — Telegram responds with this exact
      // error code, and completing login requires the SRP password check.
      if (e.errorMessage === "SESSION_PASSWORD_NEEDED") {
        if (!password?.trim()) {
          return res.status(200).json({ ok: false, needsPassword: true, message: "This account has 2FA enabled — enter your Telegram password too." });
        }
        const pwInfo = await client.invoke(new Api.account.GetPassword());
        const check  = await computeCheck(pwInfo, password.trim());
        await client.invoke(new Api.auth.CheckPassword({ password: check }));
      } else {
        throw e;
      }
    }

    const finalSession = client.session.save();
    await kvDel(`tg_login_${phone.trim()}`);

    return res.status(200).json({
      ok: true,
      session: finalSession,
      message: "Logged in! Copy the session string below and save it as TELEGRAM_SESSION on Railway.",
    });
  } catch (e) {
    console.error("[TG Login] verify error:", e.message);
    return res.status(502).json({ ok: false, error: e.message });
  } finally {
    try { await client.disconnect(); } catch (_) {}
  }
}

// ── The login page itself ───────────────────────────────────────────────
function renderPage(configured) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Flow — Telegram Personal Login</title>
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
  label{display:block;font-size:12px;color:rgba(255,255,255,.6);margin:16px 0 6px}
  input{width:100%;padding:11px 14px;border-radius:10px;border:1px solid rgba(255,255,255,.18);
        background:rgba(255,255,255,.05);color:#fff;font-size:14px}
  input:focus{outline:none;border-color:#38bdf8}
  button{width:100%;margin-top:20px;padding:12px;border-radius:10px;border:none;
         background:#38bdf8;color:#060a1a;font-weight:700;font-size:14px;cursor:pointer}
  button:hover{filter:brightness(1.1)}
  button:disabled{opacity:.5;cursor:not-allowed}
  .hidden{display:none}
  .session-box{margin-top:16px;padding:14px;background:rgba(74,222,128,0.08);
        border:1px solid rgba(74,222,128,0.3);border-radius:10px;word-break:break-all;
        font-family:monospace;font-size:11px;color:#4ade80;max-height:160px;overflow:auto}
  .note{margin-top:20px;background:rgba(56,189,248,0.08);border:1px solid rgba(56,189,248,0.2);
        border-radius:12px;padding:14px;font-size:12px;line-height:1.6;color:rgba(255,255,255,0.75)}
  .note strong{color:#38bdf8}
  #msg{font-size:13px;margin-top:14px;min-height:18px}
  #msg.error{color:#f87171}
  #msg.success{color:#4ade80}
</style></head>
<body><div class="card">
  <div class="logo">FLOW</div>
  <div class="sub">Telegram Personal Account — Login</div>

  ${configured
    ? '<div class="status ok">✅ TELEGRAM_API_ID / TELEGRAM_API_HASH configured</div>'
    : '<div class="status err">⚠️ Add TELEGRAM_API_ID and TELEGRAM_API_HASH in Vercel env vars first — get them free at my.telegram.org/apps</div>'
  }

  <form id="loginForm" class="${configured ? '' : 'hidden'}">
    <div id="phoneStep">
      <label>Phone number (with country code)</label>
      <input type="tel" id="phone" placeholder="+234..." required>
      <button type="button" id="sendBtn">Send Code</button>
    </div>

    <div id="codeStep" class="hidden">
      <label>Code Telegram just sent you</label>
      <input type="text" id="code" placeholder="12345" inputmode="numeric">
      <div id="pwWrap" class="hidden">
        <label>2FA Password (this account has one enabled)</label>
        <input type="password" id="password" placeholder="Your Telegram password">
      </div>
      <button type="button" id="verifyBtn">Verify & Log In</button>
    </div>
  </form>

  <div id="msg"></div>
  <div id="sessionBox" class="session-box hidden"></div>

  <div class="note">
    <strong>What happens to this:</strong> nothing is ever stored permanently
    here — the code exchange happens live in your browser and this Vercel
    function. Once you see the session string below, copy it and save it as
    <strong>TELEGRAM_SESSION</strong> in your Railway project's environment
    variables (see TELEGRAM_USERBOT_SETUP.md). That session string is what
    makes the always-on listener work — treat it like a password.
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
const msg = (text, cls) => { $('msg').textContent = text; $('msg').className = cls || ''; };

$('sendBtn')?.addEventListener('click', async () => {
  const phone = $('phone').value.trim();
  if (!phone) { msg('Enter your phone number first.', 'error'); return; }
  $('sendBtn').disabled = true;
  msg('Sending code...', '');
  try {
    const r = await fetch('/api/tg-setup?step=send', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ phone }),
    });
    const d = await r.json();
    if (!d.ok) { msg(d.error || 'Failed to send code', 'error'); $('sendBtn').disabled = false; return; }
    $('phoneStep').classList.add('hidden');
    $('codeStep').classList.remove('hidden');
    msg('Code sent — check Telegram on your phone.', 'success');
  } catch (e) {
    msg('Network error: ' + e.message, 'error');
  }
  $('sendBtn').disabled = false;
});

$('verifyBtn')?.addEventListener('click', async () => {
  const phone = $('phone').value.trim();
  const code = $('code').value.trim();
  const password = $('password').value.trim();
  if (!code) { msg('Enter the code Telegram sent you.', 'error'); return; }
  $('verifyBtn').disabled = true;
  msg('Verifying...', '');
  try {
    const r = await fetch('/api/tg-setup?step=verify', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ phone, code, password }),
    });
    const d = await r.json();
    if (d.needsPassword) {
      $('pwWrap').classList.remove('hidden');
      msg(d.message, '');
      $('verifyBtn').disabled = false;
      return;
    }
    if (!d.ok) { msg(d.error || 'Login failed', 'error'); $('verifyBtn').disabled = false; return; }

    msg('✅ Logged in! Copy your session string below.', 'success');
    $('sessionBox').textContent = d.session;
    $('sessionBox').classList.remove('hidden');
    $('codeStep').classList.add('hidden');
  } catch (e) {
    msg('Network error: ' + e.message, 'error');
    $('verifyBtn').disabled = false;
  }
});
</script>
</body></html>`;
}

// ── Main handler ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const apiId   = parseInt(process.env.TELEGRAM_API_ID || "0", 10);
  const apiHash = process.env.TELEGRAM_API_HASH || "";
  const configured = !!(apiId && apiHash);

  if (req.method === "GET") {
    res.setHeader("Content-Type", "text/html");
    return res.status(200).send(renderPage(configured));
  }

  if (req.method === "POST") {
    if (!configured) return res.status(400).json({ ok: false, error: "TELEGRAM_API_ID / TELEGRAM_API_HASH not set" });
    const step = req.query?.step;
    if (step === "send")   return handleSendCode(req, res, apiId, apiHash);
    if (step === "verify") return handleVerifyCode(req, res, apiId, apiHash);
    return res.status(400).json({ ok: false, error: "Unknown step" });
  }

  return res.status(405).json({ ok: false, error: "Method not allowed" });
}
