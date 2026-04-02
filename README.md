# termhub

[中文说明](./README.zh-CN.md)

![termhub cover](./assets/readme-cover.en.png)

`termhub` is an AI-native terminal control tool.

It is designed for this closed loop:

1. AI inspects what terminal sessions are open.
2. AI opens a window or tab when needed.
3. AI launches or targets a Codex session.
4. AI sends the task into that session.
5. AI captures the output and returns it to the user.

- Command: `termhub`
- Alias: `thub`
- npm package: `@duo121/termhub`
- macOS backends: `iTerm2`, `Terminal`
- Windows backends: `Windows Terminal`, `Command Prompt (CMD)`

## Install

```bash
npm install -g @duo121/termhub
```

Or Homebrew (macOS):

```bash
brew tap duo121/termhub https://github.com/duo121/termhub
brew install duo121/termhub/termhub
```

Install from GitHub Releases (without npm):

- `termhub_<version>_macos-arm64.tar.gz`
- `termhub_<version>_windows-x64.zip`

After extraction:

- macOS

```bash
chmod +x termhub
./termhub --version
```

- Windows (PowerShell)

```powershell
.\termhub.exe --version
```

## Quick Start For AI

```bash
termhub --help
termhub spec
termhub list
```

Use `spec` as machine-readable truth and `--help` as human-readable truth.

## SDK Status

`termhub` is currently **CLI-first**, not a stable SDK package.

- You can technically import internal files from `src/`, but that API is not versioned or guaranteed.
- The supported integration surface today is the CLI JSON contract via `termhub spec`.

If you need SDK usage, recommended short-term pattern:

1. Call `termhub` as a subprocess.
2. Parse JSON from `stdout`.
3. Treat `specVersion` and command schemas as compatibility gates.

## Command Map

| Top-Level Command | What It Does | Common Secondary Flags |
| --- | --- | --- |
| `open` | Open terminal window or tab | `--app` `--window` `--tab` `--dry-run` |
| `list` | List running windows/tabs/sessions | `--app` `--compact` |
| `resolve` | Narrow fuzzy target to one exact session | `--title` `--title-contains` `--session` `--current-tab` |
| `send` | Send text to resolved target session | `--text` `--stdin` `--no-enter` `--dry-run` |
| `press` | Send real key/combo/sequence events | `--key` `--combo` `--sequence` `--repeat` `--delay` |
| `capture` | Read visible terminal output | `--session` `--lines` `--app` |
| `focus` | Bring target window/session to front | `--session` `--app` `--dry-run` |
| `close` | Close target tab or window | `--session` `--app` `--dry-run` |
| `doctor` | Check platform/backend/automation readiness | `--app` `--compact` |
| `spec` | Print machine-readable JSON contract | `--compact` |

## AI Usage Rules

1. Always `resolve` to one exact target before mutating commands.
2. Use `--app` when multiple backends are active.
3. Use `--dry-run` before risky operations.
4. Use `send --no-enter` only when you plan a separate real key submit.
5. Never fake submit by appending literal newlines inside `--text` or stdin.

## Press Modes

`press` supports exactly one input mode:

- `--key <key>`
- `--combo <combo>` (for example `ctrl+c`, `cmd+k`)
- `--sequence <steps>` (for example `esc,down*5,enter`)

Extra controls:

- `--repeat <n>`: only for `--key` and `--combo`
- `--delay <ms>`: delay between repeated or sequenced key events

Examples:

```bash
termhub press --session <id|handle> --key enter
termhub press --session <id|handle> --combo ctrl+c
termhub press --session <id|handle> --sequence "esc,down*3,enter" --delay 60
```

## Typical AI Scenarios

Open a new iTerm2 window:

```bash
termhub open --app iterm2 --window
```

List all iTerm2 tabs:

```bash
termhub list --app iterm2
```

Close a specific tab by title:

```bash
termhub resolve --title Task1
termhub close --session <resolved-handle-or-session-id>
```

Read current Terminal tab (last 50 lines):

```bash
termhub resolve --app terminal --current-window --current-tab --current-session
termhub capture --app terminal --session terminal:session:<window-id>:<tab-index> --lines 50
```

Run command in Windows Terminal tab titled `API`:

```bash
termhub resolve --app windows-terminal --title API
termhub send --app windows-terminal --session windows-terminal:session:<window-handle>:<tab-index> --text "npm test"
```

## Notes

- `--session` accepts native session id or namespaced handle.
- Windows `focus/send/capture/close` rely on PowerShell + UI Automation.
- Windows `capture` is best-effort based on visible text accessibility.
