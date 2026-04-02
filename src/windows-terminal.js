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
  capabilities: Object.freeze({
    list: true,
    resolve: true,
    openWindow: false,
    openTab: false,
    send: true,
    sendWithoutEnter: true,
    press: true,
    pressKeys: [
      "enter",
      "return",
      "esc",
      "tab",
      "backspace",
      "delete",
      "space",
      "up",
      "down",
      "left",
      "right",
      "pageup",
      "pagedown",
      "home",
      "end",
    ],
    pressCombos: ["ctrl+c", "ctrl+d", "ctrl+l", "shift+tab"],
    pressSequence: true,
    pressRepeat: true,
    pressDelay: true,
    capture: true,
    captureMode: "best-effort-visible-text",
    focus: true,
    close: true,
    closeScope: "tab",
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

function normalizePressRequest(request) {
  if (typeof request === "string") {
    return {
      mode: "key",
      key: String(request).toLowerCase(),
      repeat: 1,
      delayMs: 40,
    };
  }

  return {
    mode: request?.mode ?? "key",
    key: request?.key ?? null,
    combo: request?.combo ?? null,
    sequence: Array.isArray(request?.sequence) ? request.sequence : null,
    repeat: Number(request?.repeat ?? 1),
    delayMs: Number(request?.delayMs ?? 40),
  };
}

function normalizePressStep(step) {
  if (step?.type === "combo") {
    return {
      type: "combo",
      key: String(step.key).toLowerCase(),
      modifiers: Array.isArray(step.modifiers) ? step.modifiers : [],
      expression: step.expression ?? null,
    };
  }

  return {
    type: "key",
    key: String(step?.key ?? step).toLowerCase(),
    modifiers: [],
    expression: null,
  };
}

function expandPressSteps(request) {
  const normalized = normalizePressRequest(request);

  if (normalized.mode === "sequence") {
    return (normalized.sequence ?? []).map((step) => normalizePressStep(step));
  }

  if (normalized.mode === "combo") {
    const comboStep = normalizePressStep(normalized.combo);
    return Array.from({ length: normalized.repeat }, () => comboStep);
  }

  const keyStep = normalizePressStep({ type: "key", key: normalized.key });
  return Array.from({ length: normalized.repeat }, () => keyStep);
}

function keyToSendKeysToken(key) {
  const mapping = {
    enter: "~",
    return: "~",
    esc: "{ESC}",
    tab: "{TAB}",
    backspace: "{BACKSPACE}",
    delete: "{DELETE}",
    space: " ",
    up: "{UP}",
    down: "{DOWN}",
    left: "{LEFT}",
    right: "{RIGHT}",
    pageup: "{PGUP}",
    pagedown: "{PGDN}",
    home: "{HOME}",
    end: "{END}",
  };

  if (mapping[key]) {
    return mapping[key];
  }

  if (/^[a-z0-9]$/.test(key)) {
    return key;
  }

  return null;
}

function stepToSendKeysToken(step) {
  const baseToken = keyToSendKeysToken(step.key);
  if (!baseToken) {
    throw new CLIError("Unsupported key for Windows Terminal", {
      code: "UNSUPPORTED_OPTION",
      exitCode: 2,
      details: {
        app: PROVIDER.app,
        action: "press",
        supportedKeys: PROVIDER.capabilities.pressKeys,
        supportedCombos: PROVIDER.capabilities.pressCombos,
      },
    });
  }

  if (step.type !== "combo") {
    return baseToken;
  }

  const modifiers = new Set(step.modifiers ?? []);
  if (modifiers.has("cmd")) {
    throw new CLIError("Windows Terminal does not support cmd modifier in --combo", {
      code: "UNSUPPORTED_OPTION",
      exitCode: 2,
      details: {
        app: PROVIDER.app,
        action: "press",
        requestedCombo: step.expression ?? null,
      },
    });
  }

  const prefix = `${modifiers.has("ctrl") ? "^" : ""}${modifiers.has("alt") ? "%" : ""}${modifiers.has("shift") ? "+" : ""}`;
  return `${prefix}${baseToken}`;
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

export async function pressKeyOnTarget(target, request) {
  const normalized = normalizePressRequest(request);
  const steps = expandPressSteps(normalized);
  if (steps.length === 0) {
    throw new CLIError("press sequence cannot be empty", {
      code: "USAGE_ERROR",
      exitCode: 2,
    });
  }

  const sendKeysTokens = steps.map((step) => stepToSendKeysToken(step));
  const keysLiteral = sendKeysTokens.map((token) => toPowerShellStringLiteral(token)).join(", ");
  const delayMs = Math.max(0, Math.trunc(normalized.delayMs));

  await runWindowsTerminalJson(
    `
$windowHandle = ${target.windowId}
$tabIndex = ${target.tabIndex}
$delayMs = ${delayMs}
$keys = @(${keysLiteral})

if (-not (Select-TermhubTab $windowHandle $tabIndex)) {
  throw "Session not found"
}

for ($i = 0; $i -lt $keys.Count; $i++) {
  Send-TermhubKeys $keys[$i]
  if ($delayMs -gt 0 -and $i -lt ($keys.Count - 1)) {
    Start-Sleep -Milliseconds $delayMs
  }
}

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
    mode: normalized.mode,
    key: normalized.mode === "key" ? normalized.key : null,
    combo: normalized.mode === "combo" ? normalized.combo?.expression ?? null : null,
    sequence:
      normalized.mode === "sequence" ? steps.map((step) => step.expression ?? step.key) : null,
    repeat: normalized.repeat,
    delayMs: normalized.delayMs,
    method: "sendkeys",
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
