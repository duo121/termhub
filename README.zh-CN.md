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

或者通过 Homebrew（macOS）安装：

```bash
brew tap duo121/termhub https://github.com/duo121/termhub
brew install duo121/termhub/termhub
```

### 从 GitHub Release 安装（不走 npm）

到 GitHub Releases 下载你平台对应的压缩包：

- `termhub_<version>_macos-arm64.tar.gz`
- `termhub_<version>_macos-x64.tar.gz`
- `termhub_<version>_windows-x64.zip`

解压后直接调用：

- macOS：

  ```bash
  chmod +x termhub
  ./termhub --version
  ```

- Windows（PowerShell）：

  ```powershell
  .\termhub.exe --version
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

- “调用 termhub，帮我新开一个 iTerm2 窗口。”
- “调用 termhub，告诉我我现在开了哪些 iTerm2 标签页。”
- “调用 termhub，把标题叫 Task1 的标签页关掉。”
- “调用 termhub，读取我当前 Terminal 标签页最后 50 行。”
- “调用 termhub，在 Windows Terminal 里标题叫 API 的标签页执行 `npm test`。”

## 场景 1：帮我新开一个终端

用户对 AI 说：

> 调用 termhub，帮我新开一个 iTerm2 窗口。

AI 调用：

```bash
termhub open --app iterm2 --window
```

AI 会拿到 JSON，里面有：

- 新终端对应的 `target`
- 后端返回的 `result`
- 后续还能继续复用的 `handle` / `sessionId`

## 场景 2：看现在都开了什么

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

## 场景 3：关闭一个明确的标签页

用户对 AI 说：

> 调用 termhub，把标题叫 Task1 的标签页关掉。

AI 调用：

```bash
termhub resolve --title Task1
termhub close --session <resolved-handle-or-session-id>
```

AI 不能猜。

如果 `resolve` 返回 `count: 0` 或 `count > 1`，AI 应该继续缩小条件，或者追问用户。

## 场景 4：读取当前标签页

用户对 AI 说：

> 调用 termhub，读取我当前 Terminal 标签页最后 50 行。

AI 调用：

```bash
termhub resolve --app terminal --current-window --current-tab --current-session
termhub capture --app terminal --session terminal:session:<window-id>:<tab-index> --lines 50
```

## 场景 5：向 Windows Terminal 发送命令

用户对 AI 说：

> 调用 termhub，在 Windows Terminal 里标题叫 API 的标签页执行 npm test。

AI 调用：

```bash
termhub resolve --app windows-terminal --title API
termhub send --app windows-terminal --session windows-terminal:session:<window-handle>:<tab-index> --text "npm test"
```

## AI 应该如何使用 termhub

标准模式是：

1. 用户让 AI 新开一个终端窗口或标签页时，用 `open`
2. 用户问“现在开了什么”时，用 `list`
3. 用户通过标题、TTY、当前标签页、窗口 id、handle 描述目标时，用 `resolve`
4. 目标唯一后，再调用 `send`、`capture`、`focus`、`close`
5. 不确定平台、权限或自动化状态时，用 `doctor`

AI 应该遵守这些规则：

- `termhub spec` 是机器可读的事实来源
- `termhub --help` 和 `termhub <command> --help` 是人类可读的事实来源
- 所有命令结果都会以 JSON 输出到 `stdout`
- 调用 `open` 前，先看目标 backend 的 capabilities 里是否有 `openWindow` / `openTab`
- 当 `open` 没传 `--app` 时，termhub 会优先选择当前前台且支持该 scope 的 backend
- `--session` 可以传 session id，也可以传 namespaced handle
- 对 `send`，默认行为就是提交执行
- 只有当文本需要先停留在输入框里、后面再配合 `press --key enter` 时，才用 `--no-enter`
- AI 不应该往 `--text` 或 stdin 里塞字面量换行字符来模拟提交
- 当用户给的是模糊标题时，优先用 `--title-contains` 和 `--name-contains`
- 当多个终端后端同时运行时，AI 应该显式加上 `--app`，避免误判
- 当动作有风险，或者用户希望先确认时，先对 `open`、`send`、`focus`、`close` 使用 `--dry-run`
- Apple Terminal 支持 `--no-enter`，但只有当 AI 打算后续单独提交时才应该使用
- Windows Terminal 和 CMD 的 `focus`、`send`、`capture`、`close` 依赖 PowerShell / UI Automation
- Windows 上的 `capture` 是 best-effort，前提是可见文本能被 UI Automation 读取到
