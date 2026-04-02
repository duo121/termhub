import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { CLIError } from "./errors.js";
import { createProviderSnapshot } from "./snapshot.js";

export const PROVIDER = Object.freeze({
  app: "terminal",
  displayName: "Terminal",
  bundleId: "com.apple.Terminal",
  platform: "darwin",
  automation: "applescript",
  capabilities: Object.freeze({
    list: true,
    resolve: true,
    openWindow: true,
    openTab: true,
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
    pressCombos: ["ctrl+c", "ctrl+d", "ctrl+l", "cmd+k", "shift+tab"],
    pressSequence: true,
    pressRepeat: true,
    pressDelay: true,
    capture: true,
    captureMode: "native",
    focus: true,
    close: true,
    closeScope: "tab",
    tty: true,
    titleMatch: ["exact", "contains"],
    nameMatch: ["exact", "contains"],
    dryRun: ["open", "send", "press", "focus", "close"],
  }),
});

const FIELD_SEPARATOR = String.fromCharCode(31);

const LIST_SCRIPT = `
on replaceText(findText, replaceWith, inputText)
  set oldDelims to AppleScript's text item delimiters
  set AppleScript's text item delimiters to findText
  set parts to every text item of inputText
  set AppleScript's text item delimiters to replaceWith
  set outputText to parts as text
  set AppleScript's text item delimiters to oldDelims
  return outputText
end replaceText

on sanitizeText(inputValue)
  if inputValue is missing value then
    return ""
  end if

  set textValue to inputValue as text
  set textValue to my replaceText(character id 31, " ", textValue)
  set textValue to my replaceText(return, " ", textValue)
  set textValue to my replaceText(linefeed, " ", textValue)
  return textValue
end sanitizeText

on lastProcessName(processList)
  try
    if (count of processList) is greater than 0 then
      return item -1 of processList as text
    end if
  end try

  return ""
end lastProcessName

if application id "${PROVIDER.bundleId}" is not running then
  error "Terminal is not running" number 1001
end if

tell application id "${PROVIDER.bundleId}"
  set oldDelims to AppleScript's text item delimiters
  set AppleScript's text item delimiters to linefeed
  set outLines to {}
  set frontWindowId to missing value

  if (count of windows) is greater than 0 then
    set frontWindowId to id of front window
  end if

  repeat with wi from 1 to count of windows
    set w to window wi
    set currentSessionId to ""
    set isFrontmost to "0"

    if frontWindowId is not missing value and (id of w as text) is (frontWindowId as text) then
      set isFrontmost to "1"
    end if

    repeat with ti from 1 to number of tabs of w
      set t to tab ti of w
      if selected of t then
        try
          set currentSessionId to tty of t
        end try

        if currentSessionId is "" then
          set currentSessionId to ("window:" & (id of w as text) & ":tab:" & (ti as text))
        end if
      end if
    end repeat

    copy ("W" & character id 31 & (id of w as text) & character id 31 & (wi as text) & character id 31 & isFrontmost & character id 31 & currentSessionId) to end of outLines

    repeat with ti from 1 to number of tabs of w
      set t to tab ti of w
      set isCurrentTab to "0"
      set sessionTty to ""
      set sessionId to ""
      set sessionName to ""
      set tabTitle to ""

      if selected of t then
        set isCurrentTab to "1"
      end if

      try
        set sessionTty to tty of t
      end try

      if sessionTty is not "" then
        set sessionId to sessionTty
      else
        set sessionId to ("window:" & (id of w as text) & ":tab:" & (ti as text))
      end if

      set sessionName to my sanitizeText(my lastProcessName(processes of t))
      set tabTitle to my sanitizeText(custom title of t)

      if tabTitle is "" then
        if sessionName is not "" then
          set tabTitle to sessionName
        else
          set tabTitle to sessionId
        end if
      end if

      copy ("T" & character id 31 & (ti as text) & character id 31 & isCurrentTab & character id 31 & sessionId & character id 31 & tabTitle) to end of outLines
      copy ("S" & character id 31 & "1" & character id 31 & isCurrentTab & character id 31 & sessionId & character id 31 & my sanitizeText(sessionTty) & character id 31 & sessionName) to end of outLines
    end repeat
  end repeat

  set resultText to outLines as text
  set AppleScript's text item delimiters to oldDelims
  return resultText
end tell
`;

const SEND_SCRIPT = `
on run argv
  if (count of argv) is not 3 then
    error "expected window id, tab index, and text" number 1002
  end if

  set targetWindowId to item 1 of argv
  set targetTabIndex to item 2 of argv as integer
  set inputText to item 3 of argv

  if application id "${PROVIDER.bundleId}" is not running then
    error "Terminal is not running" number 1001
  end if

  tell application id "${PROVIDER.bundleId}"
    do script inputText in tab targetTabIndex of window id targetWindowId
    return "ok"
  end tell
end run
`;

const TYPE_SCRIPT = `
on run argv
  if (count of argv) is not 3 then
    error "expected window id, tab index, and text" number 1002
  end if

  set targetWindowId to item 1 of argv
  set targetTabIndex to item 2 of argv as integer
  set inputText to item 3 of argv

  if application id "${PROVIDER.bundleId}" is not running then
    error "Terminal is not running" number 1001
  end if

  tell application id "${PROVIDER.bundleId}"
    set selected of tab targetTabIndex of window id targetWindowId to true
    activate
  end tell

  delay 0.05

  set previousClipboard to missing value
  try
    set previousClipboard to the clipboard
  end try

  set the clipboard to inputText

  tell application "System Events"
    keystroke "v" using command down
  end tell

  delay 0.05

  if previousClipboard is not missing value then
    try
      set the clipboard to previousClipboard
    end try
  end if

  return "ok"
end run
`;

const CAPTURE_SCRIPT = `
on run argv
  if (count of argv) is not 2 then
    error "expected window id and tab index" number 1002
  end if

  set targetWindowId to item 1 of argv
  set targetTabIndex to item 2 of argv as integer

  if application id "${PROVIDER.bundleId}" is not running then
    error "Terminal is not running" number 1001
  end if

  tell application id "${PROVIDER.bundleId}"
    return contents of tab targetTabIndex of window id targetWindowId
  end tell
end run
`;

const FOCUS_SCRIPT = `
on run argv
  if (count of argv) is not 2 then
    error "expected window id and tab index" number 1002
  end if

  set targetWindowId to item 1 of argv
  set targetTabIndex to item 2 of argv as integer

  if application id "${PROVIDER.bundleId}" is not running then
    error "Terminal is not running" number 1001
  end if

  tell application id "${PROVIDER.bundleId}"
    set selected of tab targetTabIndex of window id targetWindowId to true
    activate
    return (id of front window as text)
  end tell
end run
`;

const CLOSE_SCRIPT = `
on run argv
  if (count of argv) is not 2 then
    error "expected window id and tab index" number 1002
  end if

  set targetWindowId to item 1 of argv
  set targetTabIndex to item 2 of argv as integer

  if application id "${PROVIDER.bundleId}" is not running then
    error "Terminal is not running" number 1001
  end if

  tell application id "${PROVIDER.bundleId}"
    set selected of tab targetTabIndex of window id targetWindowId to true
    activate
  end tell

  tell application "System Events"
    keystroke "w" using command down
  end tell

  return "ok"
end run
`;

const OPEN_WINDOW_SCRIPT = `
tell application id "${PROVIDER.bundleId}"
  activate
end tell

delay 0.1

tell application "System Events"
  tell process "Terminal"
    click menu item 1 of menu 1 of menu item 1 of menu "Shell" of menu bar 1
  end tell
end tell

delay 0.2

tell application id "${PROVIDER.bundleId}"
  set targetWindowId to id of front window
  set targetTabIndex to 1

  repeat with ti from 1 to number of tabs of front window
    if selected of tab ti of front window then
      set targetTabIndex to ti
      exit repeat
    end if
  end repeat

  set sessionId to ""
  try
    set sessionId to tty of tab targetTabIndex of front window
  end try

  if sessionId is "" then
    set sessionId to ("window:" & (targetWindowId as text) & ":tab:" & (targetTabIndex as text))
  end if

  return (targetWindowId as text) & character id 31 & (targetTabIndex as text) & character id 31 & sessionId
end tell
`;

const OPEN_TAB_SCRIPT = `
tell application id "${PROVIDER.bundleId}"
  if (count of windows) is 0 then
    error "Terminal has no open windows" number 1004
  end if

  activate
end tell

delay 0.1

tell application "System Events"
  tell process "Terminal"
    click menu item 1 of menu 1 of menu item 2 of menu "Shell" of menu bar 1
  end tell
end tell

delay 0.2

tell application id "${PROVIDER.bundleId}"
  set targetWindowId to id of front window
  set targetTabIndex to 1

  repeat with ti from 1 to number of tabs of front window
    if selected of tab ti of front window then
      set targetTabIndex to ti
      exit repeat
    end if
  end repeat

  set sessionId to ""
  try
    set sessionId to tty of tab targetTabIndex of front window
  end try

  if sessionId is "" then
    set sessionId to ("window:" & (targetWindowId as text) & ":tab:" & (targetTabIndex as text))
  end if

  return (targetWindowId as text) & character id 31 & (targetTabIndex as text) & character id 31 & sessionId
end tell
`;

const RUNNING_SCRIPT = `return (application id "${PROVIDER.bundleId}" is running) as text`;

function runAppleScript(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-", ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        reject(
          new CLIError("osascript is not available", {
            code: "OSASCRIPT_NOT_FOUND",
            exitCode: 5,
          }),
        );
        return;
      }

      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trimEnd());
        return;
      }

      reject(
        mapAppleScriptError(stderr.trim() || stdout.trim() || "AppleScript execution failed"),
      );
    });

    child.stdin.end(script);
  });
}

function mapAppleScriptError(message) {
  if (message.includes("Terminal is not running")) {
    return new CLIError("Terminal is not running", {
      code: "TERMINAL_NOT_RUNNING",
      exitCode: 5,
    });
  }

  if (message.includes("Not authorized") || message.includes("(-1743)")) {
    return new CLIError("Automation permission to control Terminal was denied", {
      code: "AUTOMATION_DENIED",
      exitCode: 5,
      details: message,
    });
  }

  if (message.includes("assistive access") || message.includes("(-1719)")) {
    return new CLIError("Accessibility permission is required for Terminal keyboard automation", {
      code: "ACCESSIBILITY_DENIED",
      exitCode: 5,
      details: message,
    });
  }

  if (message.includes("unsupported key")) {
    return new CLIError("Unsupported key for Terminal", {
      code: "UNSUPPORTED_OPTION",
      exitCode: 2,
      details: {
        app: PROVIDER.app,
        action: "press",
        supportedKeys: PROVIDER.capabilities.pressKeys,
      },
    });
  }

  return new CLIError("AppleScript execution failed", {
    code: "APPLE_SCRIPT_FAILED",
    exitCode: 5,
    details: message,
  });
}

function parseBoolFlag(value) {
  return value === "1";
}

function toNullableText(value) {
  return value === "" ? null : value;
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

  const normalized = {
    mode: request?.mode ?? "key",
    key: request?.key ?? null,
    combo: request?.combo ?? null,
    sequence: Array.isArray(request?.sequence) ? request.sequence : null,
    repeat: Number(request?.repeat ?? 1),
    delayMs: Number(request?.delayMs ?? 40),
  };

  return normalized;
}

function keyCodeForAppleScript(key) {
  const mapping = {
    enter: 76,
    return: 36,
    esc: 53,
    tab: 48,
    backspace: 51,
    delete: 117,
    space: 49,
    up: 126,
    down: 125,
    left: 123,
    right: 124,
    pageup: 116,
    pagedown: 121,
    home: 115,
    end: 119,
  };
  return mapping[key] ?? null;
}

function formatModifier(modifier) {
  if (modifier === "ctrl") {
    return "control down";
  }
  if (modifier === "cmd") {
    return "command down";
  }
  if (modifier === "alt") {
    return "option down";
  }
  if (modifier === "shift") {
    return "shift down";
  }
  return null;
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

function buildPressEventScript(step) {
  const keyCode = keyCodeForAppleScript(step.key);
  const normalizedModifiers = [...new Set(step.modifiers.map(formatModifier).filter(Boolean))];
  const usingClause =
    normalizedModifiers.length > 0 ? ` using {${normalizedModifiers.join(", ")}}` : "";

  if (keyCode != null) {
    return `tell application "System Events"
  key code ${keyCode}${usingClause}
end tell
`;
  }

  if (/^[a-z0-9]$/.test(step.key)) {
    return `tell application "System Events"
  keystroke "${step.key}"${usingClause}
end tell
`;
  }

  throw new CLIError("Unsupported key for Terminal", {
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

export function parseSnapshot(raw) {
  const snapshot = createProviderSnapshot(PROVIDER);

  if (!raw) {
    return snapshot;
  }

  let currentWindow = null;
  let currentTab = null;

  for (const line of raw.split(/\r?\n/)) {
    if (!line) {
      continue;
    }

    const parts = line.split(FIELD_SEPARATOR);
    const recordType = parts[0];

    if (recordType === "W") {
      currentWindow = {
        app: PROVIDER.app,
        displayName: PROVIDER.displayName,
        bundleId: PROVIDER.bundleId,
        windowId: Number(parts[1]),
        windowIndex: Number(parts[2]),
        windowHandle: `${PROVIDER.app}:window:${parts[1]}`,
        isFrontmost: parseBoolFlag(parts[3]),
        currentTabSessionId: parts[4] || null,
        tabs: [],
      };
      currentTab = null;
      snapshot.windows.push(currentWindow);
      snapshot.counts.windows += 1;
      continue;
    }

    if (recordType === "T") {
      if (!currentWindow) {
        throw new CLIError("Malformed Terminal snapshot: tab record without window", {
          code: "SNAPSHOT_PARSE_ERROR",
          exitCode: 5,
        });
      }

      currentTab = {
        tabIndex: Number(parts[1]),
        isCurrent: parseBoolFlag(parts[2]),
        currentSessionId: parts[3] || null,
        title: toNullableText(parts.slice(4).join(FIELD_SEPARATOR)),
        tabHandle: `${PROVIDER.app}:tab:${currentWindow.windowId}:${parts[1]}`,
        sessions: [],
      };
      currentWindow.tabs.push(currentTab);
      snapshot.counts.tabs += 1;
      continue;
    }

    if (recordType === "S") {
      if (!currentTab || !currentWindow) {
        throw new CLIError("Malformed Terminal snapshot: session record without tab", {
          code: "SNAPSHOT_PARSE_ERROR",
          exitCode: 5,
        });
      }

      const sessionId = parts[3];
      const session = {
        sessionIndex: Number(parts[1]),
        isCurrent: parseBoolFlag(parts[2]),
        sessionId,
        tty: toNullableText(parts[4]),
        name: toNullableText(parts.slice(5).join(FIELD_SEPARATOR)),
        handle: `${PROVIDER.app}:session:${currentWindow.windowId}:${currentTab.tabIndex}`,
      };
      currentTab.sessions.push(session);
      snapshot.counts.sessions += 1;
      continue;
    }

    throw new CLIError(`Malformed Terminal snapshot: unknown record type ${recordType}`, {
      code: "SNAPSHOT_PARSE_ERROR",
      exitCode: 5,
    });
  }

  return snapshot;
}

export async function isRunning() {
  const raw = await runAppleScript(RUNNING_SCRIPT);
  return raw.trim() === "true";
}

export async function getSnapshot() {
  const raw = await runAppleScript(LIST_SCRIPT);
  return parseSnapshot(raw);
}

export async function sendTextToTarget(target, text, { newline = true } = {}) {
  if (!newline) {
    await runAppleScript(TYPE_SCRIPT, [String(target.windowId), String(target.tabIndex), text]);
    return {
      ok: true,
      sessionId: target.sessionId,
      newline,
      text,
      method: "system-events-paste",
    };
  }

  await runAppleScript(SEND_SCRIPT, [String(target.windowId), String(target.tabIndex), text]);
  return {
    ok: true,
    sessionId: target.sessionId,
    newline,
    text,
  };
}

export async function captureTarget(target) {
  return runAppleScript(CAPTURE_SCRIPT, [String(target.windowId), String(target.tabIndex)]);
}

export async function focusTarget(target) {
  const windowId = await runAppleScript(FOCUS_SCRIPT, [
    String(target.windowId),
    String(target.tabIndex),
  ]);

  return {
    ok: true,
    sessionId: target.sessionId,
    windowId: Number(windowId),
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

  await runAppleScript(FOCUS_SCRIPT, [String(target.windowId), String(target.tabIndex)]);

  for (let index = 0; index < steps.length; index += 1) {
    await runAppleScript(buildPressEventScript(steps[index]));
    if (normalized.delayMs > 0 && index < steps.length - 1) {
      await delay(normalized.delayMs);
    }
  }

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
    method: "system-events",
  };
}

export async function closeTarget(target) {
  await runAppleScript(CLOSE_SCRIPT, [String(target.windowId), String(target.tabIndex)]);

  return {
    ok: true,
    sessionId: target.sessionId,
    windowId: target.windowId,
    tabIndex: target.tabIndex,
    scope: "tab",
    method: "ui-shortcut",
  };
}

export async function openTarget({ scope = "window" } = {}) {
  const requestedScope = scope === "tab" ? "tab" : "window";
  const running = await isRunning();
  let createdScope = "window";
  let raw = "";

  if (requestedScope === "tab" && running) {
    const snapshot = await getSnapshot();

    if (snapshot.counts.windows > 0) {
      raw = await runAppleScript(OPEN_TAB_SCRIPT);
      createdScope = "tab";
    } else {
      raw = await runAppleScript(OPEN_WINDOW_SCRIPT);
    }
  } else {
    raw = await runAppleScript(OPEN_WINDOW_SCRIPT);
  }

  const [windowId, tabIndex, sessionSpecifier] = raw.split(FIELD_SEPARATOR);

  return {
    ok: true,
    requestedScope,
    createdScope,
    windowId: Number(windowId),
    tabIndex: Number(tabIndex),
    sessionSpecifier:
      sessionSpecifier || `${PROVIDER.app}:session:${windowId}:${tabIndex}`,
  };
}
