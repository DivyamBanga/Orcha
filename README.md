# Orcha

A Windows desktop cockpit for orchestrating parallel Claude Code sessions — inspired by [Conductor](https://conductor.build), rebuilt for Windows and reimagined around one idea: **leverage AI, don't babysit code**.

Each **workspace** is an isolated git worktree with its own Claude Code session and terminal. A pinned **Mission Control** session commands the whole fleet: it can list workspaces, read their activity, dispatch prompts, and spin up new workspaces on its own.

## How it works

- **Projects** point at local git repos. Workspaces are created as `git worktree add` under `~/.orcha/worktrees/<project>/<name>` on a branch `orcha/<name>` — parallel sessions never collide.
- **Sessions** are real Claude Code sessions via the Agent SDK, using your existing Claude login. They run full-auto (`bypassPermissions`), stream into a chat UI with compact tool rows, and survive app restarts (transcripts persist in `~/.claude/projects`, resumed by id).
- **Mission Control** is a dedicated session with in-process MCP tools: `list_workspaces`, `get_workspace_activity`, `send_prompt_to_workspace` (async dispatch), `create_workspace`.
- **Git actions** stay minimal: status chip, one-click Commit + Push, "Ask Claude" to commit, PR via `gh`.
- **Terminal tab** per workspace (ConPTY + xterm) for dev servers and manual testing; shells keep running while you switch around.

## Shortcuts

- `Ctrl+0` — Mission Control
- `Ctrl+1..9` — jump to workspace
- `Ctrl+T` — toggle Chat / Terminal

## Development

```bash
npm install        # also rebuilds native modules for Electron
npm run dev        # run with HMR
npm run build:win  # NSIS installer in dist/
```

Requires: Windows 10 1809+, Node 16+, git, [gh](https://cli.github.com/) (for PRs), and a logged-in [Claude Code](https://claude.com/claude-code) install.
