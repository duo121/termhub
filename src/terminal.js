import { spawn } from "node:child_process";

import { CLIError } from "./errors.js";
import { createProviderSnapshot } from "./snapshot.js";

export const PROVIDER = Object.freeze({
  app: "terminal",
  displayName: "Terminal",
  bundleId: "com.apple.Terminal",
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
    tell window id targetWindowId to select
    tell tab targetTabIndex of window id targetWindowId to select
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
    tell window id targetWindowId
      set selected of tab targetTabIndex to true
      select
    end tell
    activate
  end tell

  tell application "System Events"
    keystroke "w" using command down
  end tell

  return "ok"
end run
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
    return new CLIError("Accessibility permission is required to close Terminal tabs", {
      code: "ACCESSIBILITY_DENIED",
      exitCode: 5,
      details: message,
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
    throw new CLIError("Terminal does not support send without enter via AppleScript", {
      code: "UNSUPPORTED_OPTION",
      exitCode: 2,
      details: {
        app: PROVIDER.app,
        option: "--no-enter",
      },
    });
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
