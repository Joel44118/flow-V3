// telegram-userbot/login.js — ONE-TIME setup script
// Run this once on your own PC (not Vercel — needs interactive terminal input)
// It logs into YOUR personal Telegram account and generates a session string
// that the always-on listener (index.js) uses forever after, with no
// further login needed.
//
// HOW TO RUN (one time, on your PC):
//   1. cd telegram-userbot
//   2. npm install
//   3. Set environment variables (or paste values when prompted):
//      TELEGRAM_API_ID, TELEGRAM_API_HASH (from my.telegram.org/apps)
//   4. npm run login
//   5. Enter your phone number when asked
//   6. Enter the OTP Telegram sends you
//   7. Copy the SESSION STRING it prints at the end
//   8. Save that string somewhere safe — you'll add it to Railway as
//      TELEGRAM_SESSION when deploying index.js

const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");

const apiId   = parseInt(process.env.TELEGRAM_API_ID || "0", 10);
const apiHash = process.env.TELEGRAM_API_HASH || "";

if (!apiId || !apiHash) {
  console.error("\n❌ Missing TELEGRAM_API_ID or TELEGRAM_API_HASH.");
  console.error("Get them free at https://my.telegram.org/apps");
  console.error("Then run again with:");
  console.error('  TELEGRAM_API_ID=12345 TELEGRAM_API_HASH=abc123 npm run login\n');
  process.exit(1);
}

(async () => {
  console.log("\n🔐 Flow Telegram Personal Account Login\n");

  const session = new StringSession(""); // blank = new login
  const client  = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text("📱 Your phone number (with country code, e.g. +234...): "),
    password:    async () => await input.text("🔑 Your 2FA password (press Enter if none): "),
    phoneCode:   async () => await input.text("📩 Code Telegram just sent you: "),
    onError:     (err) => console.error(err),
  });

  console.log("\n✅ Logged in successfully!\n");
  console.log("━".repeat(60));
  console.log("YOUR SESSION STRING (save this — treat it like a password):");
  console.log("━".repeat(60));
  console.log(client.session.save());
  console.log("━".repeat(60));
  console.log("\nNext step: add this as TELEGRAM_SESSION when you deploy");
  console.log("index.js to Railway (or wherever you host the always-on listener).\n");

  await client.disconnect();
  process.exit(0);
})();
