# termhub

[English README](./README.md)

`termhub` 是一个 AI 原生命令行工具，用来通过 AppleScript 检查和控制 macOS 终端标签页。

- 主命令：`termhub`
- 别名：`thub`
- npm 包名：`@duo121/termhub`
- 支持：`iTerm2`、`Terminal.app`

## 安装

```bash
npm install -g @duo121/termhub
```

安装后检查：

```bash
termhub --help
termhub spec
```

## 用户只需要做什么

用户只需要用自然语言对 AI 提需求。

用户**不需要**学习这个 CLI。

典型提问方式：

- “调用 termhub，告诉我我现在开了哪些 iTerm2 标签页。”
- “调用 termhub，把 iTerm2 里标题叫 Task1 的标签页关掉。”
- “调用 termhub，读取我当前 Terminal 标签页最后 50 行。”
- “调用 termhub，在标题叫 API 的标签页里执行 `npm test`。”
- “调用 termhub，把标题叫 logs 的标签页切到前台。”

## AI 调用流程示例

### 1. 列出所有 iTerm2 标签页

用户对 AI 说：

> 调用 termhub，告诉我我现在开了哪些 iTerm2 标签页。

AI 调用：

```bash
termhub list --app iterm2
```

AI 能拿到：

- 窗口
- 标签页
- session handle
- 标签标题
- TTY

### 2. 关闭标题为 `Task1` 的 iTerm2 标签页

用户对 AI 说：

> 调用 termhub，看一下我现在的 iTerm2 标签页，然后把标题叫 Task1 的那个关掉。

AI 调用：

```bash
termhub resolve --app iterm2 --title Task1
termhub close --app iterm2 --session iterm2:session:<resolved-id>
```

规则：

- AI 应该先 `resolve`，再执行动作。
- 如果返回的 `count` 不是 `1`，AI 不应该猜，而应该继续缩小范围。

### 3. 读取当前 Terminal 标签页最后 50 行

用户对 AI 说：

> 调用 termhub，读取我当前 Terminal 标签页最后 50 行。

AI 调用：

```bash
termhub resolve --app terminal --current-window --current-tab --current-session
termhub capture --app terminal --session terminal:session:<resolved-window-id>:<resolved-tab-index> --lines 50
```

### 4. 向标题为 `API` 的标签页发送命令

用户对 AI 说：

> 调用 termhub，在标题叫 API 的标签页里执行 npm test。

AI 调用：

```bash
termhub resolve --title API
termhub send --session <resolved-handle-or-session-id> --text 'npm test'
```

### 5. 把标题为 `logs` 的标签页切到前台

用户对 AI 说：

> 调用 termhub，把标题叫 logs 的标签页切到前台。

AI 调用：

```bash
termhub resolve --title logs
termhub focus --session <resolved-handle-or-session-id>
```

## AI 应该如何使用 termhub

标准模式是：

1. 用户问“现在开了什么”时，用 `list`
2. 用户通过标题、TTY、当前标签页、窗口 id、handle 指目标时，用 `resolve`
3. 目标唯一后，再调用 `send`、`capture`、`focus`、`close`
4. 不确定应用状态或权限时，用 `doctor`

给 AI 的规则：

- 优先读取 `termhub spec`，这是机器可读的命令契约
- 需要文字说明时，读取 `termhub --help` 或 `termhub <command> --help`
- 所有命令结果都会以 JSON 输出到 `stdout`
- `--session` 可以传原生 session id，也可以传 namespaced handle
- 如果 `resolve` 返回 `count: 0` 或 `count > 1`，应该继续缩小条件或追问用户
- 当 `iTerm2` 和 `Terminal` 同时运行时，涉及当前标签页判断时应显式加上 `--app`

## 命令

- `list`：发现 app、窗口、标签页、session、标题、TTY、handle
- `resolve`：把用户描述变成精确匹配的 session
- `send`：向目标标签页发送文本
- `capture`：读取当前可见终端内容
- `focus`：切换到目标标签页
- `close`：关闭已定位目标所属的标签页
- `doctor`：检查平台、运行状态和自动化可用性
- `spec`：输出机器可读的命令与 JSON 契约
