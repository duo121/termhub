# termhub

[English README](./README.md)

`termhub` 是一个 AI 原生命令行工具，用来检查和控制终端窗口、标签页、session、handle 和标题。

- 主命令：`termhub`
- 别名：`thub`
- npm 包名：`@duo121/termhub`
- macOS 后端：`iTerm2`、`Terminal`
- Windows 后端：`Windows Terminal`、`Command Prompt (CMD)`

## 安装

```bash
npm install -g @duo121/termhub
```

安装后，让 AI 先读取契约：

```bash
termhub --help
termhub spec
```

## 用户只需要做什么

用户只需要用自然语言对 AI 提需求。

用户不需要学习这个 CLI。

典型提问方式：

- “调用 termhub，告诉我我现在开了哪些 iTerm2 标签页。”
- “调用 termhub，把标题叫 Task1 的标签页关掉。”
- “调用 termhub，读取我当前 Terminal 标签页最后 50 行。”
- “调用 termhub，在 Windows Terminal 里标题叫 API 的标签页执行 `npm test`。”
- “调用 termhub，把标题叫 deploy 的 CMD 窗口切到前台。”

## 场景 1：看现在都开了什么

用户对 AI 说：

> 调用 termhub，告诉我我现在开了哪些 iTerm2 标签页。

AI 调用：

```bash
termhub list --app iterm2
```

AI 会拿到 JSON，里面有：

- 窗口
- 标签页
- session
- handle
- 标签标题
- 后端可提供时对应的 TTY

## 场景 2：关闭一个明确的标签页

用户对 AI 说：

> 调用 termhub，把标题叫 Task1 的标签页关掉。

AI 调用：

```bash
termhub resolve --title Task1
termhub close --session <resolved-handle-or-session-id>
```

AI 不能猜。

如果 `resolve` 返回 `count: 0` 或 `count > 1`，AI 应该继续缩小条件，或者追问用户。

## 场景 3：读取当前标签页

用户对 AI 说：

> 调用 termhub，读取我当前 Terminal 标签页最后 50 行。

AI 调用：

```bash
termhub resolve --app terminal --current-window --current-tab --current-session
termhub capture --app terminal --session terminal:session:<window-id>:<tab-index> --lines 50
```

## 场景 4：向 Windows Terminal 发送命令

用户对 AI 说：

> 调用 termhub，在 Windows Terminal 里标题叫 API 的标签页执行 npm test。

AI 调用：

```bash
termhub resolve --app windows-terminal --title API
termhub send --app windows-terminal --session windows-terminal:session:<window-handle>:<tab-index> --text "npm test"
```

## 场景 5：聚焦一个 CMD 窗口

用户对 AI 说：

> 调用 termhub，把标题叫 deploy 的 CMD 窗口切到前台。

AI 调用：

```bash
termhub resolve --app cmd --title deploy
termhub focus --app cmd --session cmd:session:<pid>
```

## AI 应该如何使用 termhub

标准模式是：

1. 用户问“现在开了什么”时，用 `list`
2. 用户通过标题、TTY、当前标签页、窗口 id、handle 描述目标时，用 `resolve`
3. 目标唯一后，再调用 `send`、`capture`、`focus`、`close`
4. 不确定平台、权限或自动化状态时，用 `doctor`

AI 应该遵守这些规则：

- `termhub spec` 是机器可读的事实来源
- `termhub --help` 和 `termhub <command> --help` 是人类可读的事实来源
- 所有命令结果都会以 JSON 输出到 `stdout`
- `--session` 可以传 session id，也可以传 namespaced handle
- 当多个终端后端同时运行时，AI 应该显式加上 `--app`，避免误判
- Apple Terminal 不支持 `--no-enter`
- Windows Terminal 和 CMD 的 `focus`、`send`、`capture`、`close` 依赖 PowerShell / UI Automation
- Windows 上的 `capture` 是 best-effort，前提是可见文本能被 UI Automation 读取到
