# Orcha

Run multiple Claude Code sessions across your GitHub projects from one clean desktop app. Built for Windows, inspired by [Conductor](https://conductor.build).

## What it does

Every project in the sidebar is a real Claude Code terminal running in that repo's folder, with full permissions so it can just work. You switch between projects like tabs. A pinned chat called Mission Control watches over all of them: ask it what every session is doing, tell it to send a prompt to any session, or have it create a whole new repo and put a session to work on it.

## Features

- **New project in seconds.** Type a name and Orcha creates the GitHub repo, clones it to `Desktop\Projects`, and starts the Claude session.
- **Open anything.** Pick a repo from your GitHub list or open a local folder. Reopening a project resumes its last conversation.
- **Parallel sessions.** Need two features going on one repo? The project menu adds a worktree session on its own branch as another tab, so sessions never collide.
- **Git without leaving.** Branch and status in the header, one-click Commit + Push, a Pull button when the remote is ahead, PRs for branch sessions, and an "Ask Claude" button that tells the session to commit for you.
- **Mission Control.** A chat that lists sessions, reads their recent activity, types prompts into their terminals, and creates projects or parallel sessions on request.
- **Everything survives restarts.** Conversations live in Claude Code's own session files, so closing the app or rebooting loses nothing.

## First run

Orcha checks that GitHub CLI and Claude Code are signed in. If either is missing it opens a terminal in the app and walks you through the login.

## Shortcuts

| Keys | Action |
| --- | --- |
| `Ctrl+0` | Mission Control |
| `Ctrl+1` to `9` | Jump to a session |
| Right click or `⋯` | Session and project menus |

## Development

```bash
npm install        # also rebuilds native modules for Electron
npm run dev        # run with hot reload
npm run build:win  # installer lands in dist/
```

Needs Windows 10 1809 or newer, Node 16+, git, the [GitHub CLI](https://cli.github.com/), and a signed-in [Claude Code](https://claude.com/claude-code).
