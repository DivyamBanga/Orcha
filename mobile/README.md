# Orcha Mobile

Orcha in your pocket: see every project and session at a glance, get a push the moment a
session needs your answer (with the actual question), answer it in two taps — or straight
from the notification shade — read sessions as clean chat, and dispatch new tasks from
AI-suggested next steps.

Native Android app (Expo / React Native) talking to the desktop app's companion server
(port 4680) with a baked-in pairing token. Everything is free: no accounts are required
to use it, and the optional extras below all have free tiers.

## Install (the whole setup)

1. Get `mobile/Orcha.apk` onto the phone — either plug the phone in (USB debugging on)
   and run `npm run build:apk` here, which auto-installs, or just copy the file over
   (Quick Share / Drive / USB) and tap it.
2. Open the app. It auto-connects to this PC — the pairing was baked in at build time.
   (If it can't reach the PC it falls back to a QR scan: Orcha → Settings → Phone.)

That's it for use at home (phone and PC on the same WiFi).

## Optional upgrades

### Work from anywhere — Tailscale (free, ~5 min)

Install [Tailscale](https://tailscale.com/download) on PC + phone, sign in to the same
account on both. Then run `npm run build:apk` once more so the stable Tailscale address
gets baked in (or re-pair via QR) — after that the app reaches your PC from anywhere,
with nothing exposed to the internet.

### Push notifications — Firebase (free, ~5 min + a rebuild)

Without this the app still shows everything live when you open it; with it, your phone
buzzes when a session is blocked (question in the notification, inline Reply) and pings
quietly when work finishes.

1. [console.firebase.google.com](https://console.firebase.google.com) → Add project
   (any name, Analytics off).
2. Add app → Android → package name **`com.orcha.mobile`** → download
   **`google-services.json`** into this `mobile/` folder (it's gitignored).
3. `npm run build:apk` again and reinstall — updates keep your pairing and settings.

## Rebuilding

`npm run build:apk` does everything: bakes the current pairing/addresses, regenerates the
native project, builds, and installs if the phone's plugged in. It uses the JDK and
Android SDK already on this machine — no Expo account, no cloud. (If you'd rather build
in the cloud: `eas build -p android --profile preview` with a free [Expo](https://expo.dev)
account works too; `eas.json` is set up for it.)

## Notes

- Pushes are suppressed while you're actively at the PC, mirror the desktop's
  blocked/finished classification, and never spam progress.
- **Next steps** chips regenerate automatically when a session finishes (a tiny haiku
  call against your plan — the only ongoing "cost" of any of this), or on demand with ↻.
  Tapping a chip opens the full prompt for editing before anything is sent.
- The **▣** button in a session shows the live read-only terminal; **◼** sends Esc to
  interrupt a runaway session.
- The companion server binds all interfaces on port 4680 behind the pairing token. On an
  untrusted LAN, treat the token like a password (delete the `mobile:token` row in
  orcha.db to rotate it, then rebuild/re-pair).
- ADB/file-copy installs are exempt from Google's 2026 sideloading verification; the APK
  never expires.
