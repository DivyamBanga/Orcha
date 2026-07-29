# Orcha Mobile

Orcha in your pocket: see every project and session at a glance, get a push the moment a
session needs your answer (with the actual question), answer it in two taps — or straight
from the notification shade — read sessions as clean chat, and dispatch new tasks from
AI-suggested next steps.

Native Android app (Expo / React Native). It talks to the desktop app's companion server
(port 4680) over Tailscale, so it works from anywhere with nothing exposed to the internet.

## One-time setup

### 1. Tailscale (connects phone ↔ PC)

- Install [Tailscale](https://tailscale.com/download) on the PC and the phone
  (Play Store), sign in to the **same account** on both (Google/GitHub login works).
- That's it — the PC gets a stable private address the phone can always reach.

### 2. Firebase (powers push notifications)

- Go to [console.firebase.google.com](https://console.firebase.google.com) → Add project
  (any name, Analytics off is fine).
- In the project: Add app → Android, package name **`com.orcha.mobile`**.
- Download **`google-services.json`** and drop it into this `mobile/` folder.
  (It's gitignored; without it the app still works, just without push.)

### 3. Build the APK

You need a free [Expo](https://expo.dev) account. From this `mobile/` folder:

```bash
npm install
npx expo install --fix     # aligns native package versions with the Expo SDK
npm install -g eas-cli
eas login
eas init                   # links the project (gives push its projectId)
eas build -p android --profile preview
```

`eas build` runs in Expo's cloud — no Android Studio needed. When it finishes it prints a
link to download the APK. Either open that link on the phone and install directly, or:

```bash
adb install <downloaded>.apk    # with USB debugging enabled on the phone
```

(If you'd rather build locally, install Android Studio + JDK 17 and run
`npx expo run:android --variant release` with the phone plugged in.)

### 4. Pair

- On the PC: Orcha → **Settings → Phone**.
- On the phone: open Orcha, scan the QR. Done — the pairing survives restarts on both ends.

## Notes

- **Pushes** arrive when a session is blocked on you (buzzes, question in the body) or
  finishes real work (silent) — and never while you're actively at the PC. The blocked
  notification has an inline **Reply** action: answer without opening the app.
- **Next steps** chips regenerate automatically when a session finishes (a tiny haiku call
  against your plan), or on demand with ↻. Tapping a chip opens the full prompt for editing
  before anything is sent.
- The **▣** button in a session shows the live read-only terminal; **◼** sends Esc to
  interrupt a runaway session.
- Rebuilding the app is only needed when `mobile/` changes; the APK never expires.
  ADB installs remain exempt from Google's 2026 sideloading verification.
- The companion server binds all interfaces on port 4680 with a bearer token (the QR).
  Tailscale is the intended transport; on an untrusted LAN, treat the QR like a password
  (regenerate by deleting the `mobile:token` row in orcha.db if it ever leaks).
