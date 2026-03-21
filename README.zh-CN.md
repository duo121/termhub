# termhub

[English README](./README.md)

`termhub` 是一个面向 macOS 的命令行工具，供 AI、脚本和开发者通过 AppleScript 检查并控制终端会话。

- 主命令：`termhub`
- 短别名：`thub`
- npm 包名：`@duo121/termhub`
- 支持：`iTerm2`、`Terminal.app`
- 主要输出格式：JSON

## 它能做什么

`termhub` 用一套命令同时覆盖 iTerm2 和苹果官方 Terminal。

你可以用它：

- 列出窗口、标签页、会话、标题、TTY 和句柄
- 根据元数据定位目标会话
- 向目标会话发送文本
- 抓取会话内容
- 聚焦到目标窗口和标签页
- 用 `doctor` 检查本机环境

## 安装

使用 npm 全局安装：

```bash
npm install -g @duo121/termhub
```

安装后验证：

```bash
termhub --help
thub --help
```

## 核心概念

### App

`termhub` 支持两个后端：

- `iterm2`
- `terminal`

如果你想把命令限制在某一个终端里执行，使用 `--app`。

### Session

`termhub` 的主要操作对象是 session。

`--session` 同时支持两种值：

- 原生 session id
- namespaced handle

例如：

```text
iterm2:session:<UUID>
terminal:session:<windowId>:<tabIndex>
```

### 当前状态

`--current-window`、`--current-tab`、`--current-session` 都是在各自终端应用内部判断的。

如果 iTerm2 和 Terminal 同时运行，建议显式加上 `--app`，结果会更确定。

## 快速开始

列出当前已知会话：

```bash
termhub list
termhub list --app terminal
```

定位目标会话：

```bash
termhub resolve --title codex
termhub resolve --app iterm2 --window-id 543005 --tab-index 2
termhub resolve --app terminal --current-window --current-tab --current-session
```

发送文本：

```bash
termhub send --session iterm2:session:<UUID> --text 'npm test'
printf 'echo one\necho two\n' | termhub send --session /dev/ttys058 --stdin --app terminal
```

抓取内容：

```bash
termhub capture --session terminal:session:545305:1 --lines 50
```

聚焦目标：

```bash
termhub focus --session terminal:session:545305:1
```

检查环境：

```bash
termhub doctor
```

## 帮助

每个命令都支持 `--help`：

```bash
termhub --help
termhub list --help
termhub resolve --help
termhub send --help
termhub capture --help
termhub focus --help
termhub doctor --help
```

## 输出

`termhub list` 返回嵌套 JSON，主要包含：

- `frontmostApp`
- `apps[]`
- `windows[].tabs[].sessions[]`

`termhub resolve` 返回扁平化的 `matches[]` 数组。每个 match 通常包含：

- `app`
- `sessionId`
- `handle`
- `tty`
- `name`
- `windowId`
- `tabIndex`
- `sessionIndex`

## 使用说明

- 当 iTerm2 和 Terminal 同时运行时，如果你需要精确的当前状态查询，请加 `--app`
- iTerm2 支持带回车和不带回车发送
- Terminal 只支持带回车发送，`--no-enter` 会被拒绝
- 主要命令结果会以 JSON 输出到 `stdout`
