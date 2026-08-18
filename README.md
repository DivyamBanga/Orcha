# Orcha

Run multiple Claude Code sessions across your GitHub projects from one clean desktop app. Built for Windows, inspired by [Conductor](https://conductor.build).

[![Orcha in 35 seconds](video/orcha-intro.gif)](video/orcha-intro.mp4)

<sup>The whole idea in 35 seconds — [full-quality MP4](video/orcha-intro.mp4), rendered entirely from code you can remix in [`video/`](video/README.md).</sup>

## What it does

Every project in the sidebar is a real Claude Code terminal running in that repo's folder, with full permissions so it can just work. You switch between projects like tabs. A pinned chat called Mission Control watches over all of them: ask it what every session is doing, tell it to send a prompt to any session, or have it create a whole new repo and put a session to work on it.

## Features

- **New project in seconds.** Type a name and Orcha creates the GitHub repo, clones it to `Desktop\Projects`, and starts the Claude session.
- **Open anything.** Pick a repo from your GitHub list or open a local folder. Reopening a project resumes its last conversation.
- **Parallel sessions.** Need two features going on one repo? The project menu adds a worktree session on its own branch as another tab, so sessions never collide.
- **Git without leaving.** Branch and status in the header, one-click Commit + Push, a Pull button when the remote is ahead, PRs for branch sessions, and an "Ask Claude" button that tells the session to commit for you.
- **Mission Control.** A chat that lists sessions, reads their recent activity, types prompts into their terminals, and creates projects or parallel sessions on request.
- **Your real usage, live.** The ring in the sidebar shows the same 5-hour window Claude's own `/usage` reports — click it for the full picture: every plan limit, your burn rate with an ETA to the cap, which projects are eating the window, and what the week would have cost on the API.
- **Share a live view.** One click gives you a link anyone can open in a browser to watch that session's terminal live, read-only. No install on their end; stop sharing anytime. (First share downloads a small tunnel helper once.)
- **Connect your phone.** The Phone button hooks a session up to Claude's official Remote Control: scan the QR and keep steering the same session from the Claude app or claude.ai/code. Needs a claude.ai Pro/Max login.
- **Orcha on your phone.** A native Android companion app shows every project and session, pushes the actual question when a session is blocked (answer straight from the notification shade), renders sessions as clean chat, and suggests tappable next steps per project. Connects over Tailscale; pair from Settings → Phone — setup guide in [`mobile/README.md`](mobile/README.md).
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

Two sibling projects live in the repo: the Android companion app ([`mobile/`](mobile/README.md)) and the intro video as code ([`video/`](video/README.md)).
