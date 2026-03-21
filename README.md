# termhub

[中文说明](./README.zh-CN.md)

`termhub` is a macOS CLI for AI agents, scripts, and developers who need to inspect and control terminal sessions through AppleScript.

- Main command: `termhub`
- Short alias: `thub`
- npm package: `@duo121/termhub`
- Supported apps: `iTerm2`, `Terminal.app`
- Primary output format: JSON

## What It Does

`termhub` gives one command surface for both iTerm2 and Apple Terminal.

With it, you can:

- list windows, tabs, sessions, titles, TTYs, and handles
- resolve a target session from metadata
- send text into a session
- capture session contents
- focus a target window and tab
- query the local environment with `doctor`

## Install

Install globally with npm:

```bash
npm install -g @duo121/termhub
```

After installation:

```bash
termhub --help
thub --help
```

## Core Concepts

### App

`termhub` supports two backends:

- `iterm2`
- `terminal`

Use `--app` when you want to restrict a command to one backend.

### Session

The primary operation target is a session.

`--session` accepts either:

- a native session id
- a namespaced handle

Examples:

```text
iterm2:session:<UUID>
terminal:session:<windowId>:<tabIndex>
```

### Current State

`--current-window`, `--current-tab`, and `--current-session` are evaluated within each supported app.

If both iTerm2 and Terminal are running, add `--app` for deterministic results.

## Quick Start

List known sessions:

```bash
termhub list
termhub list --app terminal
```

Resolve a target:

```bash
termhub resolve --title codex
termhub resolve --app iterm2 --window-id 543005 --tab-index 2
termhub resolve --app terminal --current-window --current-tab --current-session
```

Send text:

```bash
termhub send --session iterm2:session:<UUID> --text 'npm test'
printf 'echo one\necho two\n' | termhub send --session /dev/ttys058 --stdin --app terminal
```

Capture contents:

```bash
termhub capture --session terminal:session:545305:1 --lines 50
```

Focus a target:

```bash
termhub focus --session terminal:session:545305:1
```

Check the environment:

```bash
termhub doctor
```

## Help

Every command supports `--help`:

```bash
termhub --help
termhub list --help
termhub resolve --help
termhub send --help
termhub capture --help
termhub focus --help
termhub doctor --help
```

## Output

`termhub list` returns a nested JSON tree with:

- `frontmostApp`
- `apps[]`
- `windows[].tabs[].sessions[]`

`termhub resolve` returns a flat `matches[]` array. Each match includes fields such as:

- `app`
- `sessionId`
- `handle`
- `tty`
- `name`
- `windowId`
- `tabIndex`
- `sessionIndex`

## Behavior Notes

- Add `--app` when both iTerm2 and Terminal are running and you need precise current-state queries
- iTerm2 supports send with or without enter
- Terminal supports send with enter only; `--no-enter` is rejected
- Main command results are printed to `stdout` as JSON
