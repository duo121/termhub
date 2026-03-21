# termhub

[中文说明](./README.zh-CN.md)

`termhub` is an AI-native CLI for inspecting and controlling terminal windows, tabs, sessions, handles, and titles.

- Command: `termhub`
- Alias: `thub`
- npm package: `@duo121/termhub`
- macOS backends: `iTerm2`, `Terminal`
- Windows backends: `Windows Terminal`, `Command Prompt (CMD)`

## Install

```bash
npm install -g @duo121/termhub
```

Then let the AI read the contract:

```bash
termhub --help
termhub spec
```

## What The User Needs To Do

The user only needs to ask the AI in natural language.

The user does not need to learn the CLI.

Typical requests:

- "Use termhub to show me every iTerm2 tab I have open."
- "Use termhub to close the tab named Task1."
- "Use termhub to read the last 50 lines from my current Terminal tab."
- "Use termhub to run `npm test` in the Windows Terminal tab called API."
- "Use termhub to bring the CMD window named deploy to the front."

## Scenario 1: Show Everything That Is Open

User asks the AI:

> Use termhub to show me every iTerm2 tab I have open.

AI workflow:

```bash
termhub list --app iterm2
```

The AI gets JSON with:

- windows
- tabs
- sessions
- handles
- tab titles
- TTYs when the backend exposes them

## Scenario 2: Close One Specific Tab

User asks the AI:

> Use termhub to close the tab named Task1.

AI workflow:

```bash
termhub resolve --title Task1
termhub close --session <resolved-handle-or-session-id>
```

The AI should not guess.

If `resolve` returns `count: 0` or `count > 1`, the AI should refine the selector or ask a follow-up question.

## Scenario 3: Read The Current Tab

User asks the AI:

> Use termhub to read the last 50 lines from my current Terminal tab.

AI workflow:

```bash
termhub resolve --app terminal --current-window --current-tab --current-session
termhub capture --app terminal --session terminal:session:<window-id>:<tab-index> --lines 50
```

## Scenario 4: Send A Command Into Windows Terminal

User asks the AI:

> Use termhub to run npm test in the Windows Terminal tab called API.

AI workflow:

```bash
termhub resolve --app windows-terminal --title API
termhub send --app windows-terminal --session windows-terminal:session:<window-handle>:<tab-index> --text "npm test"
```

## Scenario 5: Focus A CMD Window

User asks the AI:

> Use termhub to bring the CMD window named deploy to the front.

AI workflow:

```bash
termhub resolve --app cmd --title deploy
termhub focus --app cmd --session cmd:session:<pid>
```

## How The AI Should Use termhub

The standard pattern is:

1. Use `list` when the user asks what is open.
2. Use `resolve` when the user describes a target by title, TTY, current tab, window id, or handle.
3. Use `send`, `capture`, `focus`, or `close` only after the target is exact.
4. Use `doctor` when platform, permissions, or automation state are unclear.

Rules the AI should follow:

- `termhub spec` is the machine-readable source of truth.
- `termhub --help` and `termhub <command> --help` are the human-readable source of truth.
- All command results are printed as JSON to `stdout`.
- `--session` accepts either a session id or a namespaced handle.
- When multiple terminal backends are running, the AI should add `--app` for deterministic targeting.
- Apple Terminal rejects `--no-enter`.
- Windows Terminal and CMD use PowerShell/UI Automation for focus, send, capture, and close.
- Windows capture is best-effort and depends on visible text being readable through UI Automation.
