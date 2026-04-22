# Contributing

Thanks for your interest in improving **Terminal for AI Agents**.

## Ground rules

- Be respectful. This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
- Small, focused PRs merge faster than large, speculative ones.
- For anything larger than a bug fix or typo, **open an issue first** so we can agree on
  the approach before you write code.

## Dev setup

```bash
git clone https://github.com/<REPO_SLUG>.git
cd terminal-for-ai-agents
npm install
npm run dev
```

`npm install` triggers `electron-builder install-app-deps`, which rebuilds native
modules (`better-sqlite3`, `ssh2`) against the Electron ABI. If you switch Node or
Electron versions and get cryptic native-module errors, rerun `npm install`.

## Before opening a PR

Every PR must pass these locally (CI runs the same):

```bash
npm run typecheck   # no errors
npm run lint        # no errors (warnings are fine for now)
npm run build       # clean build
```

If your change touches the UI, include a screenshot or short screen recording in the PR
description.

## Commit style

We don't enforce Conventional Commits, but something close makes the changelog easier:

```
feat: add Codex agent support in environment settings
fix: reconnect SSH pool when resuming from sleep
refactor: extract tmux session naming helper
docs: clarify remote requirements in README
```

Keep the summary line under ~72 chars. Use the body for the *why*.

## Project layout

See the **Architecture** section of [README.md](README.md). TL;DR:

- `src/main/` — privileged process (SQLite, SSH, tmux, spawning agents)
- `src/preload/` — narrow typed IPC bridge
- `src/renderer/` — React UI
- `src/shared/` — types shared across processes

## Reporting bugs

Please include:

- macOS version
- Node version (`node -v`)
- App version (`package.json`)
- A minimal repro, or the steps you took and what you expected vs. what happened
- Anything suspicious in the Electron DevTools console (⌘⌥I in dev mode)

## Reporting security issues

**Do not** open a public issue for security vulnerabilities. Email the maintainer
privately (see `package.json` → `author`). We'll acknowledge within a few days.
