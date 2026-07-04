# Orcha

A Windows desktop cockpit for running multiple native Claude Code sessions across your GitHub projects — inspired by [Conductor](https://conductor.build), rebuilt terminal-first for Windows.

**Each project is a tab running the real Claude Code TUI** (`claude --dangerously-skip-permissions`) in that repo's folder, wrapped with the controls that matter: git status, one-click Commit + Push, PR, model/effort pickers, restart. **Mission Control** is a chat that commands the whole fleet — it can report what every session is doing, type prompts into any of them, create new GitHub repos, and spin up parallel sessions.

## The workflow

- **New project**: type a name → Orcha creates the GitHub repo (`gh repo create`, private by default), clones it to `Desktop\Projects\<name>`, and boots the Claude session. Seconds from idea to working agent.
- **Existing project**: pick from your GitHub repo list (auto-clone) or open a local folder. Reopening a project auto-resumes its last conversation (`--continue`).
- **Parallel work on one repo**: "+ Parallel session" adds a git worktree + branch as another tab, so a second Claude works the same repo without collisions.
- **Mission Control** (`Ctrl+0`): "what's everyone doing?" / "tell orcha-flow-test to add tests" / "create a repo called my-idea and have it scaffold a Next.js app".

## First run

Orcha checks that `gh` and Claude Code are connected and walks you through both logins in an embedded terminal if not.

## Development

```bash
npm install        # also rebuilds native modules for Electron
npm run dev        # run with HMR
npm run build:win  # NSIS installer in dist/
```

Requires: Windows 10 1809+, Node 16+, git, [gh](https://cli.github.com/), and [Claude Code](https://claude.com/claude-code).
