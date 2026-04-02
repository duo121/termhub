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
    throw new CLIError("Unsupported key for Command Prompt", {
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
    throw new CLIError("Command Prompt does not support cmd modifier in --combo", {
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

  await runCmdJson(
    `
$windowHandle = ${target.windowId}
$delayMs = ${delayMs}
$keys = @(${keysLiteral})

if (-not (Set-TermhubForeground $windowHandle)) {
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
