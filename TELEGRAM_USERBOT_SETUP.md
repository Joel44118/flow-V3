# Flow — Telegram Personal Account Setup (Real, Working Version)

## Why this is a separate piece from the Telegram Bot

You already have a Telegram **Bot** (`@YourBotName`) working — that replies to
people who message the bot directly. That part runs on Vercel and needs
nothing further from you.

This guide sets up a DIFFERENT thing: Flow auto-replying when someone messages
**your own personal Telegram number/@username** directly — like Flow is you.

**Important technical reality:** Telegram's personal-account protocol (MTProto)
requires a constantly-open connection listening for messages — unlike the Bot
API, which just pings a URL when something happens. Vercel's functions switch
off between requests, so they can't hold that connection. This needs one small
always-on process. Railway.app's free tier (500 hrs/month) covers this
comfortably for a single lightweight listener — no other paid service.

## Step 1 — Get your API credentials (skip if already done)

1. Go to https://my.telegram.org/apps
2. Log in with your phone number, enter the OTP
3. Click "API development tools" → fill in any app name → Create application
4. Copy the **App api_id** (a number) and **App api_hash** (a long string)

## Step 2 — One-time login (run on your own PC, not Railway)

This step needs to be interactive (it asks for your phone + OTP), so it runs
locally once. After this, you never need to log in again — a session string is
generated that Railway uses forever.

1. Download the `telegram-userbot` folder
2. Open a terminal inside it
3. Run:
   ```
   npm install
   ```
4. Run (replace with your real values):
   ```
   TELEGRAM_API_ID=12345678 TELEGRAM_API_HASH=your_hash_here npm run login
   ```
5. Enter your phone number when asked (with country code, e.g. `+234...`)
6. Enter the OTP Telegram sends you
7. If you have 2FA password enabled, enter it; otherwise press Enter
8. Copy the **SESSION STRING** it prints — save it somewhere safe, this is
   effectively a login token for your account, treat it like a password

## Step 3 — Deploy the always-on listener to Railway (free)

1. Go to https://railway.app → sign up free (GitHub login is easiest)
2. New Project → Deploy from GitHub repo → connect this repo
3. Set the **root directory** to `telegram-userbot` in Railway's settings
4. Add these Variables in Railway:
   - `TELEGRAM_API_ID` = your API ID
   - `TELEGRAM_API_HASH` = your API hash
   - `TELEGRAM_SESSION` = the session string from Step 2
   - `FLOW_SITE_URL` = `https://flow-v3-mu.vercel.app`
5. Deploy — Railway will run `node index.js` automatically (configured in
   `railway.json`)
6. Check the deploy logs — you should see:
   ```
   ✅ Connected — listening for personal messages.
   👂 Flow is now listening on Joel's personal Telegram.
   ```

## How it behaves

- Replies only to **direct/private messages** sent to your personal account,
  not group chats
- Ignores messages you send yourself (so it doesn't reply to your own texts)
- Has an 8-second cooldown per sender to avoid double-replying if someone
  sends several messages in quick succession
- Shows a "typing..." indicator before replying, for realism
- Every reply also pushes a notification to Flow's 🔔 bell (same system the
  Bot integration already uses) so you see a summary even when offline

## What this does NOT do (be aware)

- It does not currently scan images sent to your personal account (the Bot
  integration on Vercel already does this for the Bot — extending it here is
  a small follow-up if you want it)
- It replies to literally anyone who messages you privately — there's no
  allowlist/blocklist yet. If you want it to only reply to strangers and stay
  silent for close contacts, that's a follow-up filter to add
