# termhub

[中文说明](./README.zh-CN.md)

`termhub` is an AI-native macOS CLI for inspecting and controlling terminal tabs through AppleScript.

- Command: `termhub`
- Alias: `thub`
- npm package: `@duo121/termhub`
- Supported apps: `iTerm2`, `Terminal.app`

## Install

```bash
npm install -g @duo121/termhub
```

Then check:

```bash
termhub --help
termhub spec
```

## What The User Needs To Do

The user should speak to the AI in natural language.

The user does **not** need to learn the CLI.

Typical user requests:

- "Use termhub to show me all my open iTerm2 tabs."
- "Use termhub to close the iTerm2 tab titled Task1."
- "Use termhub to read the last 50 lines from my current Terminal tab."
- "Use termhub to send `npm test` to the tab titled API."
- "Use termhub to focus the tab titled logs."

## Example AI Workflows

### 1. List all open iTerm2 tabs

User asks the AI:

> Use termhub to show me all my open iTerm2 tabs.

AI workflow:

```bash
termhub list --app iterm2
```

What the AI gets back:

- Windows
- Tabs
- Session handles
- Tab titles
- TTYs

### 2. Close the iTerm2 tab titled `Task1`

User asks the AI:

> Use termhub to look at my iTerm2 tabs and close the one titled Task1.

AI workflow:

```bash
termhub resolve --app iterm2 --title Task1
termhub close --app iterm2 --session iterm2:session:<resolved-id>
```

Rule:

- The AI should resolve the target first.
- If `count` is not `1`, the AI should refine the selector instead of guessing.

### 3. Read the last 50 lines from the current Terminal tab

User asks the AI:

> Use termhub to read the last 50 lines from my current Terminal tab.

AI workflow:

```bash
termhub resolve --app terminal --current-window --current-tab --current-session
termhub capture --app terminal --session terminal:session:<resolved-window-id>:<resolved-tab-index> --lines 50
```

### 4. Send a command into the tab titled `API`

User asks the AI:

> Use termhub to run npm test in the tab titled API.

AI workflow:

```bash
termhub resolve --title API
termhub send --session <resolved-handle-or-session-id> --text 'npm test'
```

### 5. Bring the tab titled `logs` to the front

User asks the AI:

> Use termhub to focus the tab titled logs.

AI workflow:

```bash
termhub resolve --title logs
termhub focus --session <resolved-handle-or-session-id>
```

## How The AI Should Use termhub

The standard pattern is:

1. `list` when the user asks what is open.
2. `resolve` when the user names a target by title, tty, current tab, window id, or handle.
3. `send`, `capture`, `focus`, or `close` only after the target is unambiguous.
4. `doctor` when the app state or automation permissions are unclear.

Rules for the AI:

- Prefer `termhub spec` for the machine-readable command contract.
- Use `termhub --help` or `termhub <command> --help` for human-readable clarification.
- All command results are printed as JSON to `stdout`.
- `--session` accepts either a native session id or a namespaced handle.
- If `resolve` returns `count: 0` or `count > 1`, refine selectors or ask a follow-up question.
- When both `iTerm2` and `Terminal` are running, add `--app` for deterministic current-tab queries.

## Commands

- `list`: discover apps, windows, tabs, sessions, titles, TTYs, and handles
- `resolve`: turn user intent into exact session matches
- `send`: send text into one target
- `capture`: read visible terminal contents
- `focus`: select a target tab and bring it forward
- `close`: close the owning tab of a resolved target
- `doctor`: inspect platform, running apps, and automation readiness
- `spec`: print the machine-readable command and JSON contract
