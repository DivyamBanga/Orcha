# Graphite — Orcha's design system

The rules every screen follows. Direction chosen by the owner: **Graphite** — monochrome, precise, dense
where it helps, calm everywhere else. The app runs on Electron 45 (Chromium 156), so modern CSS (anchor
positioning, `@starting-style`, `interpolate-size`, `field-sizing`, composited `clip-path` animation,
scroll-driven animation, view transitions) is available and preferred over JavaScript.

## Principles

1. **Colour means state.** Chrome is neutral. Colour appears only for session state (working, waiting on
   you, finished-unseen), errors and destructive actions. No accent colour, no gradients, no glows.
2. **The more often it happens, the less it moves.** Keyboard actions and anything done a hundred times a
   day don't animate; menus are quick; only large spatial changes and the launch get springs.
3. **Terminals never animate.** No transform, opacity, filter, will-change, animation or transition on a
   terminal or any of its ancestors. Tab switches are instant.
4. **Motion is a replacement, never a void.** Reduced motion swaps movement for short fades; state stays
   visible.
5. **Shape carries meaning colour can't.** Git facts, attachments, tool states and memory use glyphs and
   words, not tints.

## Tokens

All tokens live in `@theme` in `main.css`. Colours are OKLCH. Steps of the surface ladder are ≥ 3.5 L apart so
layers read without borders.

### Colour (dark is the base; light flips the ladder)

| Token         | Dark                     | Light                    | Use                                                   |
| ------------- | ------------------------ | ------------------------ | ----------------------------------------------------- |
| `surface-0`   | `oklch(14% 0.004 286)`   | `oklch(99% 0.001 286)`   | window, main content                                  |
| `surface-1`   | `oklch(17.5% 0.004 286)` | `oklch(97% 0.002 286)`   | sidebar, composer, cards                              |
| `surface-2`   | `oklch(21% 0.004 286)`   | `oklch(94.5% 0.003 286)` | hover, user bubble, inputs                            |
| `surface-3`   | `oklch(25% 0.005 286)`   | `oklch(92% 0.004 286)`   | pressed, selected                                     |
| `surface-4`   | `oklch(29% 0.005 286)`   | `oklch(100% 0 0)`        | popovers, menus, dialogs                              |
| `edge`        | white 6.5 %              | ink 7.5 %                | hairlines (as `border`/`outline`, never `box-shadow`) |
| `edge-bright` | white 11 %               | ink 12 %                 | inputs, focus-within                                  |
| `edge-strong` | white 18 %               | ink 20 %                 | focus, dividers that must read                        |
| `fg-1`        | zinc-50                  | zinc-950                 | headings, active rows                                 |
| `fg-2`        | zinc-300                 | zinc-700                 | body text                                             |
| `fg-3`        | `oklch(61% 0.012 286)`   | `oklch(51% 0.014 286)`   | secondary text — must pass 4.5:1 on every surface     |
| `fg-4`        | zinc-600                 | zinc-400                 | disabled, decorative only (never informative text)    |
| `work`        | `#34d399`                | `#059669`                | a session working                                     |
| `wait`        | `#f59e0b`                | `#c2670a`                | waiting on you (light value clears 3:1 on surface-1)  |
| `danger`      | red-400                  | red-600                  | errors, destructive                                   |

Terminals keep the dark palette inside a light window (a framed "dark island").

### Type

Geist (UI), Geist Mono (code, keys, numbers that align). `font-feature-settings: 'ss01'`. Dark mode lowers
weights slightly (400→380, 500→470, 600→565) so text doesn't bloom.

| Role     | Size / line | Weight | Notes                                        |
| -------- | ----------- | ------ | -------------------------------------------- |
| label    | 10.5 / 14   | 500    | caps, +0.04em, eyebrows                      |
| meta     | 11.5 / 16   | 400    | timestamps, counts (`tabular-nums`)          |
| small    | 12.5 / 18   | 400    | secondary UI, tool rows                      |
| ui       | 13 / 20     | 400    | default UI                                   |
| input    | 14 / 22     | 400    | inputs, sidebar titles                       |
| prose    | 15 / 24     | 400    | chat replies (setting 14–17)                 |
| title    | 17 / 24     | 600    | dialog titles, prose h3, −0.01em             |
| page     | 21 / 28     | 600    | page titles, −0.015em                        |
| greeting | 30 / 36     | 500    | home greeting, −0.02em, `text-wrap: balance` |
| code     | 12.5 / 20   | 400    | Geist Mono                                   |

Paragraphs use `text-wrap: pretty`. Reading column 720 px (Wide 880, Full).

### Space, radius, elevation

4 px grid. Radii: **6** rows and chips, **8** buttons and inputs, **12** cards, popovers, dialogs, **16** large
panels, **22** composer, full for round buttons; `corner-shape: squircle` on radii ≥ 16. Shadows only on
floating layers (popover, menu, dialog, toast); flat surfaces separate by tone and a 1 px `edge` border.

### Motion

Durations: `--dur-1` 100 ms (hover, press), `--dur-2` 160 ms (menus, chips, rows), `--dur-3` 240 ms (dialogs,
panels), `--dur-4` 420 ms (spatial: sidebar, artifact panel, mode switch indicator). Exits are ~60 % of enters.

Easings: `--ease-out` `cubic-bezier(.16,1,.3,1)` (default for anything entering or moving), `--ease-std`
`cubic-bezier(.4,0,.2,1)` (colour, opacity), `--ease-in` `cubic-bezier(.4,0,1,1)` (exits only),
`--ease-in-out` `cubic-bezier(.65,0,.35,1)` (repositioning on screen), `--ease-sheet`
`cubic-bezier(.32,.72,0,1)` (drawers).

Springs as `linear()` with their settle times (1 % band):

- `--spring-snap` 240 ms, no overshoot — toggles, segmented indicators
- `--spring-smooth` 360 ms, 0.2 % — panels
- `--spring-settle` 420 ms, 2 % — dialogs, selection glide, mode switch (today's `--ease-spring`)
- `--spring-lively` 480 ms, 5 % — the launch, rare delight
- `--spring-bounce` 620 ms, 12 % — copy-confirmed check only, transform only

(Exact `linear()` stops: research notes, copied into `main.css`.) CSS springs for open/close; for anything
dragged or toggled rapidly (sidebar resize), use JS with velocity hand-off.

Rules: press scale `.97`; never animate from `scale(0)` (start ≥ `.9`, tooltips `.97`); `transform-origin` at
the trigger; stagger 30 ms steps, at most 6 items; no `transition: all`; animate `transform`, `opacity`,
`filter` and `clip-path` (composited on Chromium ≥ 152) — never width, height, top, left or large shadows.
**One ambient loop at a time** in the whole window (the working-session ring, or a thinking shimmer — never both
on the same row).

Motion tiers:

| Tier | What                                                           | Motion                                                         |
| ---- | -------------------------------------------------------------- | -------------------------------------------------------------- |
| T0   | keyboard actions, palette open, list navigation, tab switch    | none                                                           |
| T1   | hover, press, focus ring, colour                               | 100 ms `--ease-std`                                            |
| T2   | tooltip, menu, popover, chip                                   | 140 ms in (`translateY 4px` + `scale .97` + fade), 90 ms out   |
| T3   | dialog, sheet                                                  | 240 ms `--spring-settle` from `scale .96`; backdrop 160/120 ms |
| T4   | sidebar collapse, artifact panel, mode switch, selection glide | 420 ms spring                                                  |
| T5   | launch                                                         | ≤ 700 ms after ready, once per cold start                      |

Reduced motion (Windows setting, or Settings → Appearance → Motion: System / Reduced / Off): transforms,
blur, shimmer and cascades go; fades ≤ 100 ms remain; the state ring and busy ring stay visible (slowed).

## Components

Build each once in `src/renderer/src/ui/` and use it everywhere.

- **Button** — primary (near-white fill on dark, near-black on light, no tint), secondary (surface-2 +
  edge), ghost, danger; sizes 28 / 32 px; icon button with ≥ 24 px hit area and an `aria-label`.
- **Input / Textarea** — 32 px, radius 8, `edge-bright` border, `edge-strong` + 3 % ring on focus;
  `field-sizing: content` for auto-grow.
- **Menu / Popover / Select** — native `popover` + CSS anchor positioning with `position-try-fallbacks`;
  arrow-key navigation, type-ahead, Esc, focus return; enter/exit per T2. Context menus use the same shell.
- **Dialog** — native `<dialog>` with `closedby`, focus trap, inert background and focus restore for free;
  T3 motion; nested dialogs push the lower one back (scale .975, brightness .75).
- **Tooltip / hover card** — `interestfor` with a 400 ms delay (150 ms between neighbours), text only, never
  for essential information.
- **Toast** — bottom centre, T2, auto-dismiss 5 s, **Undo** for anything destructive (replaces every
  `confirm()`), polite live region.
- **Segmented control** — equal segments, an indicator that only translates (`--spring-settle`).
- **Switch, Checkbox** — knob on `--spring-snap`; check drawn by stroke in 180 ms.
- **Kbd** — Geist Mono 10.5 px in a 1 px edge box; shows Ctrl on Windows.
- **Chip** — 24 px, radius 6; appears with `scale .96→1` over 160 ms.
- **State glyphs** — working: rotating ring (bordered div, 2 s); waiting on you: amber ring + dot; finished,
  unseen: emerald check (clears when opened); error: red triangle; idle: hollow ring.
- **Skeleton** — only where layout is known; shown after 150 ms, kept ≥ 300 ms.

## Layout

- **Title bar** 48 px; Windows caption buttons are a native overlay over the right 140 px of the main bar.
- **Sidebar** 260 px (resizable 220–380, remembered), collapsible with Ctrl+B to a 52 px rail (mode switch,
  new chat, search, settings). Collapsing changes the main pane's width instantly — only the sidebar's own
  contents fade (terminals must not refit every frame).
- **Sidebar header**: mark + wordmark, then the **Chat | Code** segmented control. Chat mode: New chat
  (Ctrl+N), Search (Ctrl+K), Incognito, Projects, Starred, Recents (Today / Yesterday / Previous 7 days /
  Older). Code mode: Mission Control (Ctrl+0), **Needs you**, then projects with their sessions (state glyph,
  branch, Ctrl+number hint on hover). Footer: usage glance (Max plan ring + API today), settings, profile.
- **Main column** 720 px with 24 px gutters; composer floats at the bottom inside the column, a 96 px fade above.

## Screens and patterns

- **Home**: greeting (30 px), composer centred at ~42 % height, up to four "Continue …" chips from recent
  chats and projects, the project picker ("in: No project ▾"). On the first send the composer glides to the
  bottom (view transition, 320 ms `--spring-settle`).
- **Conversation**: user turns in a `surface-2` bubble on the right (radius 18, padding 10 × 16, max 85 %);
  replies as open prose (15 / 24). Each turn is `content-visibility: auto` with `contain-intrinsic-size:
auto 160px`. Actions under a reply (copy, retry, branch ‹1/2›, quote) fade in on hover and stay visible on
  the latest turn; a quiet footer names the model, effort and cost on hover.
- **Streaming**: deltas are buffered by a rAF controller that reveals whole words (Intl.Segmenter) at a
  catch-up rate (τ ≈ 120 ms, never more than ~350 ms behind); the newest words fade in with a 2 px rise over
  150 ms (**Soft words**); only the tail (~40 words) is wrapped; finished messages drop the wrappers. Scroll
  pins with CSS (`overflow-anchor` sentinel) — no JS re-pinning; a "Latest ↓" pill appears when you scroll up.
- **Reasoning**: while thinking, one 28 px row "Thinking" with the latest summary line crossfading and an
  elapsed timer, the label shimmering (the row's one ambient loop); when the answer starts it collapses to
  "Thought for 12s ›" (`interpolate-size` height, 160 ms).
- **Tool rows**: 28 px; glyph, verb phrase, target in mono, duration; states by glyph (queued hollow, running
  ring, done check, error text, approval with inline Approve / Deny). Consecutive calls group under
  "Used 5 tools".
- **Citations**: 16 px number pills, a hover card (favicon, title, domain, snippet) after 150 ms, a Sources
  row below the reply; document citations open the in-app viewer at the page and passage.
- **Composer**: radius 22, `surface-1`, `edge-bright` border; textarea grows (52 px → `min(40vh, 320px)`);
  attachment chips inside the border; footer: `+` (attach, tools), model chip (provider glyph, name, effort
  dots), Search off switch, context ring, send / stop (crossfade 140 ms). Enter sends, Shift+Enter newline,
  Esc stops, ↑ edits the last message. Messages sent while busy queue as chips above the composer.
- **Incognito**: a ghost glyph, a dashed composer border and a one-line banner ("Incognito — not saved,
  no memory"); no colour.
- **Model picker**: anchored popover; search first; sections Claude · Max plan, Claude · API, Azure OpenAI,
  Local; 36 px rows with provider glyph, name, one-line description, capability glyphs, context, price per
  1M (or "plan" / "local"), default star; unavailable rows dimmed with the reason; effort as a segmented
  control showing only the levels that model accepts, plus a Thinking switch where it has one.
- **Settings**: a full page (Ctrl+,), searchable, groups You / AI / Work / System; per-chat options in a
  drawer from the chat header.
- **Code mode**: the session header carries project › session, a branch chip (diamond = dirty, ring =
  clean), agent + model + effort, a usage pill, then actions; the terminal sits in a framed dark island with
  12 px padding; the review dock slides in from the right (T4) without resizing the terminal mid-animation
  (it resizes once, at the end).

## Opening: Unfold

The mark — two rounded panes, `x 1.5 w 3.25` and `x 6.25 w 8.25`, `y 2 h 12 r 1` on a 16 grid — echoes the
layout: narrow pane = sidebar, wide pane = main. Unfold makes that literal.

- **Before JavaScript**: `index.html` paints the cover (CSS only — the CSP forbids inline scripts): the window
  surface plus the mark at the centre (56 px), already at its first frame. The window shows immediately
  (`backgroundColor` = surface-0).
- **t = 0 (window shown)**: the mark fades and settles in (180 ms, scale .92 → 1, `--ease-out`).
- **Hold** until ready (shell mounted, last route restored, first data) — never on CLI probes. At least
  300 ms after shown, at most 1.2 s warm / 2 s cold.
- **Unfold (420 ms, `--spring-lively`)**: each pane is a layer sized to its final rectangle — the sidebar
  and the main area — whose `clip-path: inset(… round r)` animates from the mark pane's rectangle to the full
  rectangle (composited on Chromium 156, so radii stay exact). The 1-unit gap between the panes becomes the
  sidebar's hairline. As they land, the pane fills fade to transparent (last 200 ms) and the UI behind cascades
  in (fade + 5 px rise, 240 ms, 30 ms steps, centre-out, max 6 groups).
- **Done** ≤ 700 ms after ready; the cover unmounts; input is live from the start of the unfold (any key or
  click jumps to the end). Cold start only — reopening from the tray shows the window instantly. Reduced
  motion: a 120 ms fade.

## Keyboard

| Keys                   | Action                                                              |
| ---------------------- | ------------------------------------------------------------------- |
| Ctrl+K                 | command palette (search chats, sessions, settings, actions, models) |
| Ctrl+N                 | new chat                                                            |
| Ctrl+. · Alt+1 · Alt+2 | toggle Chat / Code · go to Chat · go to Code                        |
| Ctrl+B                 | collapse the sidebar                                                |
| Ctrl+,                 | settings                                                            |
| Ctrl+F                 | find in chat                                                        |
| Ctrl+Shift+M           | model picker (← → change effort)                                    |
| Esc                    | stop the reply · close the top layer                                |
| ↑ (empty composer)     | edit your last message                                              |
| Ctrl+0 · Ctrl+1–9      | Mission Control · jump to session                                   |
| Ctrl+Alt+Space         | quick chat, from anywhere                                           |

On Windows, a focused terminal keeps its own Ctrl+K, Ctrl+B and Ctrl+F.

## Accessibility (WCAG 2.2 AA, gated in CI)

Text ≥ 4.5:1 (3:1 at ≥ 24 px) on every surface it sits on, in both themes; visible focus rings (2 px, 2 px
offset); every control reachable and operable by keyboard; dialogs and menus with correct roles, focus trap
and focus return; icon-only buttons labelled; live regions for streaming status and toasts; respects
reduced motion, forced colours and high contrast.
