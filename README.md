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

Or via Homebrew (macOS):

```bash
brew tap duo121/termhub https://github.com/duo121/termhub
brew install duo121/termhub/termhub
```

### Install From GitHub Release (no npm)

Download the archive for your platform from GitHub Releases:

- `termhub_<version>_macos-arm64.tar.gz`
- `termhub_<version>_macos-x64.tar.gz`
- `termhub_<version>_windows-x64.zip`

Extract and run:

- macOS:

  ```bash
  chmod +x termhub
  ./termhub --version
  ```

- Windows (PowerShell):

  ```powershell
  .\termhub.exe --version
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

- "Use termhub to open a fresh iTerm2 window for me."
- "Use termhub to show me every iTerm2 tab I have open."
- "Use termhub to close the tab named Task1."
- "Use termhub to read the last 50 lines from my current Terminal tab."
- "Use termhub to run `npm test` in the Windows Terminal tab called API."

## Scenario 1: Open A New Terminal For Me

User asks the AI:

> Use termhub to open a fresh iTerm2 window for me.

AI workflow:

```bash
termhub open --app iterm2 --window
```

The AI gets JSON with:

- the resolved `target`
- the backend `result`
- a reusable `handle` / `sessionId` for the new terminal

## Scenario 2: Show Everything That Is Open

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

## Scenario 3: Close One Specific Tab

User asks the AI:

> Use termhub to close the tab named Task1.

AI workflow:

```bash
termhub resolve --title Task1
termhub close --session <resolved-handle-or-session-id>
```

The AI should not guess.

If `resolve` returns `count: 0` or `count > 1`, the AI should refine the selector or ask a follow-up question.

## Scenario 4: Read The Current Tab

User asks the AI:

> Use termhub to read the last 50 lines from my current Terminal tab.

AI workflow:

```bash
termhub resolve --app terminal --current-window --current-tab --current-session
termhub capture --app terminal --session terminal:session:<window-id>:<tab-index> --lines 50
```

## Scenario 5: Send A Command Into Windows Terminal

User asks the AI:

> Use termhub to run npm test in the Windows Terminal tab called API.

AI workflow:

```bash
termhub resolve --app windows-terminal --title API
termhub send --app windows-terminal --session windows-terminal:session:<window-handle>:<tab-index> --text "npm test"
```

## How The AI Should Use termhub

The standard pattern is:

1. Use `open` when the user asks the AI to create a new terminal window or tab.
2. Use `list` when the user asks what is open.
3. Use `resolve` when the user describes a target by title, TTY, current tab, window id, or handle.
4. Use `send`, `capture`, `focus`, or `close` only after the target is exact.
5. Use `doctor` when platform, permissions, or automation state are unclear.

Rules the AI should follow:

- `termhub spec` is the machine-readable source of truth.
- `termhub --help` and `termhub <command> --help` are the human-readable source of truth.
- All command results are printed as JSON to `stdout`.
- `open` should prefer a backend whose capabilities advertise `openWindow` / `openTab`.
- If `--app` is omitted for `open`, termhub prefers the frontmost supported backend that supports the requested scope.
- `--session` accepts either a session id or a namespaced handle.
- On `send`, submit is the default behavior.
- Use `--no-enter` only when the payload should remain staged for a later real key press such as `press --key enter`.
- The AI must not append `\n` or other literal newline characters inside `--text` or stdin to simulate submit.
- `--title-contains` and `--name-contains` are safer when the user gives an approximate label instead of an exact title.
- When multiple terminal backends are running, the AI should add `--app` for deterministic targeting.
- Use `--dry-run` before `open`, `send`, `focus`, or `close` when the user wants confirmation or when the action is high-risk.
- Apple Terminal supports `--no-enter`, but the AI should only use it when it intends to submit separately.
- Windows Terminal and CMD use PowerShell/UI Automation for focus, send, capture, and close.
- Windows capture is best-effort and depends on visible text being readable through UI Automation.
