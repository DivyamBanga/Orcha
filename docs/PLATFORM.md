# Orcha 1.0 — the platform plan

Orcha grows from a fleet manager for Claude Code / Codex sessions into a personal AI platform: a **Chat**
mode with everything claude.ai and ChatGPT offer, across Claude (Max plan and API keys), every OpenAI model on
an Azure AI Foundry resource and local Ollama models, beside the existing **Code** mode. Windows only.
Friends stay on 0.3 (their relay keeps working; the 1.x updater channel never reaches them).

Every decision below was made by the owner (October 2026). Research notes behind them live outside the repo.

## Decisions

### Providers and billing

- **Connections**: Anthropic Console API keys (several, named; a default; choose per chat/project; per-key
  budget and usage), the Claude **Max plan** (Agent SDK; the default for Claude chats), one **Azure AI
  Foundry** resource (endpoint + key, deployments found by probing known model names, manual add), and
  **Ollama** (fully managed: discover, pull, delete, load/unload; auto-start; context sized from memory and
  always sent as `num_ctx`; 5-minute keep-alive).
- **Failover asks first**: a key out of credit / rate limited, or Max limits reached, offers the next key in a
  prompt; it never switches silently, and only between turns.
- **Keys** live in the OS keychain through Electron's async `safeStorage`; they never cross IPC in plaintext,
  never enter logs, settings exports or backups.
- Default new-chat model: **Claude Opus 5.5 on the Max plan**. Chores (titles, summaries): local qwen when
  Ollama is up, else Claude Haiku 5.5. Memory writing: Haiku 5.5 on an API key (local models proved unsafe).

### Chat

- Switch providers freely mid-chat (earlier turns carry over as visible text).
- Composer: model picker (current models + "More models", provider sections, capability glyphs, prices),
  **per-model effort menu** showing only the levels a model supports (remembered per model), web search off
  switch, tools menu, context meter, send/stop. Messages sent while a reply runs are **queued**.
- Reasoning shows collapsed with a live one-line summary ("Thought for 14s ›"). Streaming text reveals with
  **soft words** (each new word fades in with a 2 px rise; buffered, tail-only).
- Per-chat drawer: GPT verbosity, and sampling only where the model accepts it (Claude rejects sampling
  parameters since API version 2026-10-21).
- **Incognito**: chosen per chat as _Personalized_ (instructions, read-only memory) or _Clean slate_; never
  saved; files deleted on close; allowed: web search, attachments, "Keep this chat"; Undo on close; not inside
  projects; Fable 5.1 unavailable (30-day retention).
- Quote-reply on selection, branch into a new chat, exclude a message from context, find in chat.
- Long cloud chats auto-compact with a visible divider; long local chats summarise older turns.
- Delete = Undo toast + 30-day trash (no confirm dialogs). Sidebar: Projects, Starred, dated Recents.
- Compare mode (2–4 models side by side), prompt library and `/` commands (shared with Claude Code through
  `~/.claude/commands`), `@` presets (model + effort + instructions + tools + knowledge).
- Confirm before: a research run over its cap, a message estimated over $1, high-quality images, max/xhigh
  effort on Fable, Opus or GPT-6 Astra via keys.
- Notifications only for long replies (> ~30 s), research runs and scheduled tasks.

### Memory, projects, files

- Memory: in-chat saves (with Undo) plus a background pass that tidies into editable **Topics**; global plus
  per project. Changes apply automatically, except anything learned from web pages, files or tool output,
  which waits for approval. Sensitive topics are excluded unless asked; secrets never.
- Past chats: a search tool models can call (scoped to the project inside one; incognito never indexed).
- Projects: knowledge goes in whole when small, through a local search index when large (capacity bar); a
  project **Library** collects what its chats make; repo projects read `CLAUDE.md` and Claude Code's memory,
  with "Promote to CLAUDE.md".
- Files: every common type parsed (PDF, Office, spreadsheets, slides, EPUB, HTML, e-mail, archives, images,
  audio, video); up to **500 MB**; click-through citations that open an in-app viewer at the page and
  passage. Embeddings local (qwen3-embedding) with Azure fallback.

### Tools and agents

- Web search: provider-native (Anthropic, Azure) plus **Ollama web search** for local models; models search
  when they decide it helps.
- Code execution: Anthropic sandbox / Azure code interpreter / local Pyodide (also for Max-plan chats).
- Image generation and editing with the Azure image deployments. Dictation with local Whisper.
- Deep research (default engine: Claude on the Max plan), MCP connectors (any server, trusted once; read-only
  tools run silently, changes ask; Claude Code's MCP servers imported read-only), scheduled tasks, Skills
  shared with Claude Code (`~/.claude/skills`).
- Quick chat window (Ctrl+Alt+Space; saved like any chat; can grab a screenshot, selected text, clipboard).
- Import Claude history, export everything, daily local backups (no attachments), locked chats (Windows Hello
  - PIN; key in the OS keychain). No app lock, no full-database encryption.
- Remote images in replies load on click; unfamiliar links in chats that read web pages or files confirm.

### Look and feel

- Direction **Graphite**: monochrome, precise; colour still means session state only.
- Opening **Unfold**: the mark's two panes grow into the sidebar and main area while the app loads; cold
  start only; never waits on CLI probes; reduced motion gets a short fade.
- Chat | Code switch at the top of the sidebar (Ctrl+. toggles, Alt+1 / Alt+2). Sidebar collapsible
  (Ctrl+B) and resizable. Quiet user bubble on the right; 720 px column, 15 px chat text.
- Home: greeting, composer, up to four "continue" chips. Full-page Settings with search (Ctrl+,).
- Motion follows Windows, with an in-app Full / Reduced / Off. WCAG 2.2 AA, enforced in CI.
- Close keeps Orcha in the tray; it starts hidden at sign-in.

### Code mode

- Behaviour stays; the frame gets the Graphite refresh. Terminals never animate and stay dark; tab switches
  are instant.
- Codex tabs run directly on the Azure key. Claude Code tabs: Max plan by default, per-tab API key.
- Bundled ConPTY (`useConptyDll`) so Claude Code reports its own status (OSC 7501), behind a full regression
  pass. Sidebar: projects plus a "Needs you" section; a green check marks finished-but-unseen sessions.
- Review dock (diff by unstaged / staged / branch / last turn; line comments sent to the agent). Hand-off
  both ways (Continue in Code / Ask in chat). Mission Control gains a model and effort picker. Taskbar shows
  progress colour. Live share links expire (2 h default). Phone companion hardened (re-pair once); chats on
  the phone come later.

### Usage

- One local, append-only ledger of every model call (chat, chores, research, Mission Control, Claude Code,
  Codex, local). Max plan shown as its real limit meters plus a separate "plan value" tile, never mixed into
  cash. Budgets are off until set; then warn at 50/80/95 % and ask before going over. The price book updates
  itself (Azure Retail Prices API; Anthropic prices ship with releases) with a change log, and past costs keep
  their price. Local models show tokens and speed only. USD with a CAD toggle.

### Process

- Electron 39 → 45 first. Every milestone is committed and pushed to `main`; a GitHub release only when the
  owner says so, published with `--latest=false`, version **1.0.0**. Live API tests stay under $5 in total on
  cheap models.

## Milestones

| #   | Milestone  | Contents                                                                                                                                                                                                                                                                       |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0   | Foundation | Electron 45 (+ better-sqlite3 13, async clipboard), test harness (Playwright `_electron`, fake providers, DB seams), secrets vault, connections + model catalog + price book, usage ledger and a corrected transcript scanner, guest side removed, SDK upgrades, IPC hardening |
| 1   | Shell      | Graphite tokens and primitives, mode switch, new sidebars, Unfold opening, full-page Settings, palette, startup speed, tray                                                                                                                                                    |
| 2   | Chat       | Direct Anthropic, Azure and Ollama adapters plus the Max plan; picker, effort, reasoning, soft-word streaming, queue, incognito, compare, presets, prompt library, context and compaction, conversation tools                                                                  |
| 3   | Knowledge  | File pipeline and viewer, project index and Library, memory Topics, past-chat search                                                                                                                                                                                           |
| 4   | Tools      | Async tool runner and approvals, search, fetch, code execution, images, MCP, Skills, research, schedules, dictation                                                                                                                                                            |
| 5   | Usage      | Dashboard, budgets, inline cost surfaces                                                                                                                                                                                                                                       |
| 6   | Code mode  | Bundled ConPTY + status, refresh, review dock, Codex on Azure, per-tab keys, hand-off, Mission Control picker                                                                                                                                                                  |
| 7   | Desktop    | Quick chat, locked chats, Claude import, export and backups, notifications, phone hardening                                                                                                                                                                                    |
| 8   | Release    | 1.x update channel, README, 1.0.0                                                                                                                                                                                                                                              |
