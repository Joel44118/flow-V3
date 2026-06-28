\# Flow AI Desktop — Setup Guide



\## One-time setup



\### 1. Install Node.js

Download from https://nodejs.org (LTS version)



\### 2. Create the app folder

Create a folder called `flow-electron` anywhere on your PC and put these files in it:

\- `main.js`

\- `preload.js`  

\- `package.json`

\- `icon.png` (copy icon-512.png, rename it icon.png)



\### 3. Open terminal in that folder and run:

```

npm install

npm install @jitsi/robotjs

```



\### 4. Run Flow:

```

npm start

```



That's it. Flow opens as a real desktop app.



\## How gesture control works in the desktop app



When Flow detects it's running inside Electron (`window.\_\_flowElectron` exists):

\- Gesture coordinates map to your \*\*full screen resolution\*\*

\- `cursor\_move` → robotjs moves your actual OS mouse cursor

\- `gesture\_click` → robotjs fires a real left click

\- `scroll` → robotjs scrolls whatever is under the cursor

\- `right\_click` → robotjs fires a real right click

\- \*\*No Chrome extension needed at all\*\*



So you point at any part of your screen — even outside the Flow window — and the dot follows. Pinch to click anything.



\## Build a portable .exe (optional, Windows)

```

npm run build-win

```

Creates a single portable `.exe` in the `dist/` folder you can run anywhere.



\## Updates

The app always loads `https://flow-v3-mu.vercel.app` — so every time you push to Vercel, the desktop app gets the update automatically on next launch. No rebuild needed.

