import { CLIError } from "./errors.js";
import { createProviderSnapshot } from "./snapshot.js";
import {
  buildPowerShellJsonCommand,
  getWin32ErrorMessage,
  mapWin32Error,
  runPowerShellJson,
  toPowerShellBooleanLiteral,
  toPowerShellStringLiteral,
} from "./win32.js";

export const PROVIDER = Object.freeze({
  app: "cmd",
  displayName: "Command Prompt",
  bundleId: null,
  platform: "win32",
  automation: "powershell-uiautomation",
  processNames: ["cmd"],
  capabilities: Object.freeze({
    list: true,
    resolve: true,
    openWindow: false,
    openTab: false,
    send: true,
    sendWithoutEnter: true,
    press: true,
    pressKeys: ["enter", "return"],
    capture: true,
    captureMode: "best-effort-visible-text",
    focus: true,
    close: true,
    closeScope: "window",
    tty: false,
    titleMatch: ["exact", "contains"],
    nameMatch: ["exact", "contains"],
    dryRun: ["send", "press", "focus", "close"],
  }),
});

function toArray(value) {
  if (value == null) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function toNullableText(value) {
  if (value == null || value === "") {
    return null;
  }

  return String(value);
}

function toWindowId(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapProviderError(error) {
  throw mapWin32Error(getWin32ErrorMessage(error), {
    displayName: PROVIDER.displayName,
  });
}

async function runCmdJson(body, options = {}) {
  const script = buildPowerShellJsonCommand(body, {
    sendKeys: options.sendKeys === true,
    uiAutomation: options.uiAutomation !== false,
  });

  try {
    return await runPowerShellJson(script);
  } catch (error) {
    mapProviderError(error);
  }
}

export function parseSnapshot(raw) {
  const snapshot = createProviderSnapshot(PROVIDER);

  if (!raw || !raw.windows) {
    return snapshot;
  }

  for (const windowRecord of toArray(raw.windows)) {
    const windowId = toWindowId(windowRecord.windowId);
    if (!windowId) {
      continue;
    }

    const sessionId = String(windowRecord.sessionId ?? "");
    if (!sessionId) {
      continue;
    }

    const title = toNullableText(windowRecord.title) ?? "Command Prompt";
    const parsedWindow = {
      app: PROVIDER.app,
      displayName: PROVIDER.displayName,
      bundleId: PROVIDER.bundleId,
      windowId,
      windowIndex: Number(windowRecord.windowIndex ?? snapshot.counts.windows + 1),
      windowHandle: `${PROVIDER.app}:window:${windowId}`,
      isFrontmost: windowRecord.isFrontmost === true,
      currentTabSessionId: sessionId,
      tabs: [
        {
          tabIndex: 1,
          isCurrent: true,
          currentSessionId: sessionId,
          title,
          tabHandle: `${PROVIDER.app}:tab:${windowId}:1`,
          sessions: [
            {
              sessionIndex: 1,
              isCurrent: true,
              sessionId,
              tty: null,
              name: title,
              handle: `${PROVIDER.app}:session:${sessionId}`,
            },
          ],
        },
      ],
    };

    snapshot.windows.push(parsedWindow);
    snapshot.counts.windows += 1;
    snapshot.counts.tabs += 1;
    snapshot.counts.sessions += 1;
  }

  return snapshot;
}

export async function isRunning() {
  const payload = await runCmdJson(
    `
$payload = [pscustomobject]@{
  running = (@(Get-Process -Name ${toPowerShellStringLiteral("cmd")} -ErrorAction SilentlyContinue)).Count -gt 0
}

$payload | ConvertTo-Json -Depth 6 -Compress
    `,
    { uiAutomation: false },
  );

  return payload?.running === true;
}

export async function getSnapshot() {
  const payload = await runCmdJson(`
$foregroundHandle = Get-TermhubForegroundHandle
$windows = @()
$windowIndex = 0
$windowMap = @{}

foreach ($windowInfo in @(Get-TermhubTopLevelWindows)) {
  $windowMap[[int64]$windowInfo.windowHandle] = $windowInfo
}

foreach ($process in @(Get-Process -Name ${toPowerShellStringLiteral("cmd")} -ErrorAction SilentlyContinue)) {
  $windowHandle = [int64]$process.MainWindowHandle
  if ($windowHandle -eq 0) {
    continue
  }

  $windowIndex += 1
  $title = ConvertTo-TermhubText $process.MainWindowTitle
  if ($null -eq $title) {
    $windowInfo = $windowMap[$windowHandle]
    if ($null -ne $windowInfo) {
      $title = ConvertTo-TermhubText $windowInfo.title
    }
  }
  if ($null -eq $title) {
    $title = 'Command Prompt'
  }

  $windows += [pscustomobject]@{
    windowId = $windowHandle
    windowIndex = $windowIndex
    isFrontmost = $windowHandle -eq $foregroundHandle
    sessionId = [string]$process.Id
    title = $title
  }
}

$payload = [pscustomobject]@{
  windows = @($windows)
}

$payload | ConvertTo-Json -Depth 8 -Compress
  `);

  return parseSnapshot(payload);
}

export async function sendTextToTarget(target, text, { newline = true } = {}) {
  await runCmdJson(
    `
$windowHandle = ${target.windowId}

if (-not (Set-TermhubForeground $windowHandle)) {
  throw "Session not found"
}

Send-TermhubInput ${toPowerShellStringLiteral(text)} ${toPowerShellBooleanLiteral(newline)}

$payload = [pscustomobject]@{
  ok = $true
  sessionId = ${toPowerShellStringLiteral(target.sessionId)}
}

$payload | ConvertTo-Json -Depth 6 -Compress
    `,
    { sendKeys: true },
  );

  return {
    ok: true,
    sessionId: target.sessionId,
    newline,
    text,
  };
}

export async function captureTarget(target) {
  const payload = await runCmdJson(`
$windowHandle = ${target.windowId}

if (-not (Set-TermhubForeground $windowHandle)) {
  throw "Session not found"
}

Start-Sleep -Milliseconds 120
$text = Get-TermhubTextFromHandle $windowHandle

$payload = [pscustomobject]@{
  text = if ($null -eq $text) { '' } else { $text }
}

$payload | ConvertTo-Json -Depth 6 -Compress
  `);

  return payload?.text ?? "";
}

export async function focusTarget(target) {
  await runCmdJson(`
$windowHandle = ${target.windowId}

if (-not (Set-TermhubForeground $windowHandle)) {
  throw "Session not found"
}

$payload = [pscustomobject]@{
  ok = $true
  windowId = $windowHandle
}

$payload | ConvertTo-Json -Depth 6 -Compress
  `);

  return {
    ok: true,
    sessionId: target.sessionId,
    windowId: target.windowId,
  };
}

export async function pressKeyOnTarget(target, key) {
  const requestedKey = String(key).toLowerCase();
  const normalizedKey = requestedKey === "return" ? "enter" : requestedKey;
  if (normalizedKey !== "enter") {
    throw new CLIError("Unsupported key for Command Prompt", {
      code: "UNSUPPORTED_OPTION",
      exitCode: 2,
      details: {
        app: PROVIDER.app,
        action: "press",
        supportedKeys: PROVIDER.capabilities.pressKeys,
      },
    });
  }

  await runCmdJson(
    `
$windowHandle = ${target.windowId}

if (-not (Set-TermhubForeground $windowHandle)) {
  throw "Session not found"
}

Send-TermhubKeys '~'

$payload = [pscustomobject]@{
  ok = $true
  windowId = $windowHandle
}

$payload | ConvertTo-Json -Depth 6 -Compress
  `,
    { sendKeys: true },
  );

  return {
    ok: true,
    sessionId: target.sessionId,
    windowId: target.windowId,
    tabIndex: target.tabIndex,
    key: normalizedKey,
    method: "sendkeys",
  };
}

export async function closeTarget(target) {
  await runCmdJson(`
$windowHandle = ${target.windowId}
$process = Get-Process -Id ${target.sessionId} -ErrorAction Stop

if (-not $process.CloseMainWindow()) {
  if (-not (Set-TermhubForeground $windowHandle)) {
    throw "Session not found"
  }

  Send-TermhubKeys '%{F4}'
}

$payload = [pscustomobject]@{
  ok = $true
  windowId = $windowHandle
}

$payload | ConvertTo-Json -Depth 6 -Compress
  `, { sendKeys: true });

  return {
    ok: true,
    sessionId: target.sessionId,
    windowId: target.windowId,
    tabIndex: target.tabIndex,
    scope: "window",
    method: "close-main-window",
  };
}
