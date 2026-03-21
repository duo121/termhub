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
  app: "windows-terminal",
  displayName: "Windows Terminal",
  bundleId: null,
  platform: "win32",
  automation: "powershell-uiautomation",
  processNames: ["WindowsTerminal", "WindowsTerminalPreview"],
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

function createSessionId(windowId, tabIndex) {
  return `${windowId}:${tabIndex}`;
}

function mapProviderError(error) {
  throw mapWin32Error(getWin32ErrorMessage(error), {
    displayName: PROVIDER.displayName,
  });
}

async function runWindowsTerminalJson(body, options = {}) {
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

function processNamesLiteral() {
  return PROVIDER.processNames.map((name) => toPowerShellStringLiteral(name)).join(", ");
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

    const parsedWindow = {
      app: PROVIDER.app,
      displayName: PROVIDER.displayName,
      bundleId: PROVIDER.bundleId,
      windowId,
      windowIndex: Number(windowRecord.windowIndex ?? snapshot.counts.windows + 1),
      windowHandle: `${PROVIDER.app}:window:${windowId}`,
      isFrontmost: windowRecord.isFrontmost === true,
      currentTabSessionId: null,
      tabs: [],
    };

    const tabRecords = toArray(windowRecord.tabs);
    for (const tabRecord of tabRecords) {
      const tabIndex = Number(tabRecord.tabIndex ?? parsedWindow.tabs.length + 1);
      const sessionId = createSessionId(windowId, tabIndex);
      const isCurrent = tabRecord.isCurrent === true;
      const title = toNullableText(tabRecord.title) ?? `Tab ${tabIndex}`;

      const parsedTab = {
        tabIndex,
        isCurrent,
        currentSessionId: sessionId,
        title,
        tabHandle: `${PROVIDER.app}:tab:${windowId}:${tabIndex}`,
        sessions: [
          {
            sessionIndex: 1,
            isCurrent,
            sessionId,
            tty: null,
            name: toNullableText(tabRecord.name) ?? title,
            handle: `${PROVIDER.app}:session:${windowId}:${tabIndex}`,
          },
        ],
      };

      if (isCurrent && parsedWindow.currentTabSessionId == null) {
        parsedWindow.currentTabSessionId = sessionId;
      }

      parsedWindow.tabs.push(parsedTab);
      snapshot.counts.tabs += 1;
      snapshot.counts.sessions += 1;
    }

    if (parsedWindow.tabs.length === 0) {
      const sessionId = createSessionId(windowId, 1);
      parsedWindow.tabs.push({
        tabIndex: 1,
        isCurrent: true,
        currentSessionId: sessionId,
        title: "Windows Terminal",
        tabHandle: `${PROVIDER.app}:tab:${windowId}:1`,
        sessions: [
          {
            sessionIndex: 1,
            isCurrent: true,
            sessionId,
            tty: null,
            name: "Windows Terminal",
            handle: `${PROVIDER.app}:session:${windowId}:1`,
          },
        ],
      });
      parsedWindow.currentTabSessionId = sessionId;
      snapshot.counts.tabs += 1;
      snapshot.counts.sessions += 1;
    }

    if (parsedWindow.currentTabSessionId == null) {
      parsedWindow.currentTabSessionId = parsedWindow.tabs[0].currentSessionId;
      parsedWindow.tabs[0].isCurrent = true;
      parsedWindow.tabs[0].sessions[0].isCurrent = true;
    }

    snapshot.windows.push(parsedWindow);
    snapshot.counts.windows += 1;
  }

  return snapshot;
}

export async function isRunning() {
  const payload = await runWindowsTerminalJson(
    `
$payload = [pscustomobject]@{
  running = (@(Get-Process -Name @(${processNamesLiteral()}) -ErrorAction SilentlyContinue)).Count -gt 0
}

$payload | ConvertTo-Json -Depth 6 -Compress
    `,
    { uiAutomation: false },
  );

  return payload?.running === true;
}

export async function getSnapshot() {
  const payload = await runWindowsTerminalJson(`
$processMap = @{}
foreach ($process in @(Get-Process -Name @(${processNamesLiteral()}) -ErrorAction SilentlyContinue)) {
  $processMap[[int]$process.Id] = $process
}

$foregroundHandle = Get-TermhubForegroundHandle
$windows = @()
$windowIndex = 0

foreach ($windowInfo in @(Get-TermhubTopLevelWindows)) {
  $process = $processMap[[int]$windowInfo.processId]
  if ($null -eq $process) {
    continue
  }

  $windowHandle = [int64]$windowInfo.windowHandle
  if ($windowHandle -eq 0) {
    continue
  }

  $windowIndex += 1
  $tabs = @()
  $tabInfos = @(Get-TermhubTabInfos $windowHandle)

  if ($tabInfos.Count -eq 0) {
    $fallbackTitle = ConvertTo-TermhubText $windowInfo.title
    if ($null -eq $fallbackTitle) {
      $fallbackTitle = ConvertTo-TermhubText $process.MainWindowTitle
    }
    if ($null -eq $fallbackTitle) {
      $fallbackTitle = 'Windows Terminal'
    }

    $tabInfos = @(
      [pscustomobject]@{
        tabIndex = 1
        title = $fallbackTitle
        isCurrent = $true
      }
    )
  }

  foreach ($tabInfo in $tabInfos) {
    $tabIndex = [int]$tabInfo.tabIndex
    $tabTitle = ConvertTo-TermhubText $tabInfo.title
    if ($null -eq $tabTitle) {
      $tabTitle = "Tab $tabIndex"
    }

    $tabs += [pscustomobject]@{
      tabIndex = $tabIndex
      title = $tabTitle
      isCurrent = [bool]$tabInfo.isCurrent
    }
  }

  if (-not ($tabs | Where-Object { $_.isCurrent })) {
    $tabs[0].isCurrent = $true
  }

  $windows += [pscustomobject]@{
    windowId = $windowHandle
    windowIndex = $windowIndex
    isFrontmost = $windowHandle -eq $foregroundHandle
    tabs = @($tabs)
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
  await runWindowsTerminalJson(
    `
$windowHandle = ${target.windowId}
$tabIndex = ${target.tabIndex}

if (-not (Select-TermhubTab $windowHandle $tabIndex)) {
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
  const payload = await runWindowsTerminalJson(`
$windowHandle = ${target.windowId}
$tabIndex = ${target.tabIndex}

if (-not (Select-TermhubTab $windowHandle $tabIndex)) {
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
  await runWindowsTerminalJson(`
$windowHandle = ${target.windowId}
$tabIndex = ${target.tabIndex}

if (-not (Select-TermhubTab $windowHandle $tabIndex)) {
  throw "Session not found"
}

$payload = [pscustomobject]@{
  ok = $true
  windowId = $windowHandle
  tabIndex = $tabIndex
}

$payload | ConvertTo-Json -Depth 6 -Compress
  `);

  return {
    ok: true,
    sessionId: target.sessionId,
    windowId: target.windowId,
    tabIndex: target.tabIndex,
  };
}

export async function closeTarget(target) {
  await runWindowsTerminalJson(
    `
$windowHandle = ${target.windowId}
$tabIndex = ${target.tabIndex}

if (-not (Select-TermhubTab $windowHandle $tabIndex)) {
  throw "Session not found"
}

Send-TermhubKeys '^+w'

$payload = [pscustomobject]@{
  ok = $true
  windowId = $windowHandle
  tabIndex = $tabIndex
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
    scope: "tab",
    method: "ui-shortcut",
  };
}
