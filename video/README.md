# video/

The Orcha intro, written as code (Remotion). 35s · 1920×1080 · 30fps. Every scene is the
real UI redrawn from Orcha's own design tokens, every cut rides the boot-reveal seam, and
the soundtrack is synthesized by `scripts/make-music.mjs` — 120 BPM, one impact per cut,
so the edit is beat-locked by construction.

The finished renders live next to this file: `orcha-intro.mp4` (full quality) and
`orcha-intro.gif` (the README preview).

## Re-rendering

```bash
npm install
node scripts/make-music.mjs   # generates public/audio.wav (gitignored)
npm run studio                # live preview, scrub the timeline
npm run render                # out/orcha-intro.mp4
```

Scene timings are the `AT` map in `src/Main.tsx`; scene content is `src/scenes.tsx`;
Orcha's design tokens are `src/theme.ts`. If you change a cut time, change the matching
impact in `scripts/make-music.mjs` (`CUTS`) and regenerate the audio — or swap in any
120 BPM track over `public/audio.wav`.
