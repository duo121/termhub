import { spawn } from "node:child_process";

import { CLIError } from "./errors.js";
import { createProviderSnapshot } from "./snapshot.js";

export const PROVIDER = Object.freeze({
  app: "iterm2",
  displayName: "iTerm2",
  bundleId: "com.googlecode.iterm2",
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
    pressKeys: ["enter", "return"],
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

if application id "${PROVIDER.bundleId}" is not running then
  error "iTerm2 is not running" number 1001
end if

tell application id "${PROVIDER.bundleId}"
  set oldDelims to AppleScript's text item delimiters
  set AppleScript's text item delimiters to linefeed
  set outLines to {}
  set frontWindowId to missing value

  if (count of windows) is greater than 0 then
    set frontWindowId to id of current window
  end if

  repeat with wi from 1 to count of windows
    set w to window wi
    set currentTabSessionId to id of current session of current tab of w
    set isFrontmost to "0"
    if frontWindowId is not missing value and (id of w as text) is (frontWindowId as text) then
      set isFrontmost to "1"
    end if

    copy ("W" & character id 31 & (id of w as text) & character id 31 & (wi as text) & character id 31 & isFrontmost & character id 31 & currentTabSessionId) to end of outLines

    repeat with ti from 1 to count of tabs of w
      set t to tab ti of w
      set tabCurrentSessionId to id of current session of t
      set isCurrentTab to "0"
      if tabCurrentSessionId is currentTabSessionId then
        set isCurrentTab to "1"
      end if

      copy ("T" & character id 31 & (ti as text) & character id 31 & isCurrentTab & character id 31 & tabCurrentSessionId & character id 31 & my sanitizeText(title of t)) to end of outLines

      repeat with si from 1 to count of sessions of t
        set s to session si of t
        set sessionTty to ""
        set isCurrentSession to "0"

        try
          set sessionTty to tty of s
        end try

        if (id of s) is tabCurrentSessionId then
          set isCurrentSession to "1"
        end if

        copy ("S" & character id 31 & (si as text) & character id 31 & isCurrentSession & character id 31 & (id of s) & character id 31 & my sanitizeText(sessionTty) & character id 31 & my sanitizeText(name of s)) to end of outLines
      end repeat
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
    error "expected session id, text, and newline flag" number 1002
  end if

  set targetSessionId to item 1 of argv
  set inputText to item 2 of argv
  set newlineFlag to item 3 of argv
  set shouldSendNewline to true
  if newlineFlag is "false" then
    set shouldSendNewline to false
  end if

  if application id "${PROVIDER.bundleId}" is not running then
    error "iTerm2 is not running" number 1001
  end if

  tell application id "${PROVIDER.bundleId}"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (id of s) is targetSessionId then
            tell s to write text inputText newline shouldSendNewline
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell

  error "session not found" number 1003
end run
`;

const CAPTURE_SCRIPT = `
on run argv
  if (count of argv) is not 1 then
    error "expected session id" number 1002
  end if

  set targetSessionId to item 1 of argv

  if application id "${PROVIDER.bundleId}" is not running then
    error "iTerm2 is not running" number 1001
  end if

  tell application id "${PROVIDER.bundleId}"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (id of s) is targetSessionId then
            return contents of s
          end if
        end repeat
      end repeat
    end repeat
  end tell

  error "session not found" number 1003
end run
`;

const FOCUS_SCRIPT = `
on run argv
  if (count of argv) is not 3 then
    error "expected window id, tab index, and session index" number 1002
  end if

  set targetWindowId to item 1 of argv
  set targetTabIndex to item 2 of argv as integer
  set targetSessionIndex to item 3 of argv as integer

  if application id "${PROVIDER.bundleId}" is not running then
    error "iTerm2 is not running" number 1001
  end if

  tell application id "${PROVIDER.bundleId}"
    tell window id targetWindowId to select
    tell tab targetTabIndex of window id targetWindowId to select
    tell session targetSessionIndex of tab targetTabIndex of window id targetWindowId to select
    activate
    return (id of current window as text)
  end tell
end run
`;

const PRESS_SCRIPT = `
on run argv
  if (count of argv) is not 4 then
    error "expected window id, tab index, session index, and key" number 1002
  end if

  set targetWindowId to item 1 of argv
  set targetTabIndex to item 2 of argv as integer
  set targetSessionIndex to item 3 of argv as integer
  set targetKey to item 4 of argv

  if application id "${PROVIDER.bundleId}" is not running then
    error "iTerm2 is not running" number 1001
  end if

  tell application id "${PROVIDER.bundleId}"
    tell window id targetWindowId to select
    tell tab targetTabIndex of window id targetWindowId to select
    tell session targetSessionIndex of tab targetTabIndex of window id targetWindowId to select
    activate
  end tell

  delay 0.05

  tell application "System Events"
    if targetKey is "enter" then
      key code 76
      return "ok"
    end if

    if targetKey is "return" then
      key code 36
      return "ok"
    end if
  end tell

  error "unsupported key" number 1004
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
    error "iTerm2 is not running" number 1001
  end if

  tell application id "${PROVIDER.bundleId}"
    close (tab targetTabIndex of window id targetWindowId)
    return "ok"
  end tell
end run
`;

const OPEN_SCRIPT = `
on run argv
  if (count of argv) is not 1 then
    error "expected open mode" number 1002
  end if

  set openMode to item 1 of argv
  set createdScope to "window"
  set targetTabIndex to 1

  tell application id "${PROVIDER.bundleId}"
    if openMode is "tab" and (count of windows) is greater than 0 then
      set targetWindow to current window
      tell targetWindow
        set newTab to (create tab with default profile)
      end tell
      set createdScope to "tab"
      set targetWindowId to id of targetWindow
      set targetSessionId to id of current session of newTab
    else
      set newWindow to (create window with default profile)
      set targetWindowId to id of newWindow
      set targetSessionId to id of current session of current tab of newWindow
    end if

    activate

    repeat with ti from 1 to count of tabs of window id targetWindowId
      if (id of current session of tab ti of window id targetWindowId) is targetSessionId then
        set targetTabIndex to ti
        exit repeat
      end if
    end repeat

    return createdScope & character id 31 & (targetWindowId as text) & character id 31 & (targetTabIndex as text) & character id 31 & targetSessionId
  end tell
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
  if (message.includes("iTerm2 is not running")) {
    return new CLIError("iTerm2 is not running", {
      code: "ITERM_NOT_RUNNING",
      exitCode: 5,
    });
  }

  if (message.includes("session not found")) {
    return new CLIError("Session not found", {
      code: "SESSION_NOT_FOUND",
      exitCode: 3,
    });
  }

  if (message.includes("Not authorized") || message.includes("(-1743)")) {
    return new CLIError("Automation permission to control iTerm2 was denied", {
      code: "AUTOMATION_DENIED",
      exitCode: 5,
      details: message,
    });
  }

  if (message.includes("assistive access") || message.includes("(-1719)")) {
    return new CLIError("Accessibility permission is required to press keys in iTerm2", {
      code: "ACCESSIBILITY_DENIED",
      exitCode: 5,
      details: message,
    });
  }

  if (message.includes("unsupported key")) {
    return new CLIError("Unsupported key for iTerm2", {
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
        throw new CLIError("Malformed iTerm2 snapshot: tab record without window", {
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
        throw new CLIError("Malformed iTerm2 snapshot: session record without tab", {
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
        handle: `${PROVIDER.app}:session:${sessionId}`,
      };
      currentTab.sessions.push(session);
      snapshot.counts.sessions += 1;
      continue;
    }

    throw new CLIError(`Malformed iTerm2 snapshot: unknown record type ${recordType}`, {
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
  await runAppleScript(SEND_SCRIPT, [target.sessionId, text, String(newline)]);
  return {
    ok: true,
    sessionId: target.sessionId,
    newline,
    text,
  };
}

export async function captureTarget(target) {
  return runAppleScript(CAPTURE_SCRIPT, [target.sessionId]);
}

export async function focusTarget(target) {
  const windowId = await runAppleScript(FOCUS_SCRIPT, [
    String(target.windowId),
    String(target.tabIndex),
    String(target.sessionIndex),
  ]);

  return {
    ok: true,
    sessionId: target.sessionId,
    windowId: Number(windowId),
  };
}

export async function pressKeyOnTarget(target, key) {
  await runAppleScript(PRESS_SCRIPT, [
    String(target.windowId),
    String(target.tabIndex),
    String(target.sessionIndex),
    String(key).toLowerCase(),
  ]);

  return {
    ok: true,
    sessionId: target.sessionId,
    windowId: target.windowId,
    tabIndex: target.tabIndex,
    sessionIndex: target.sessionIndex,
    key: String(key).toLowerCase(),
    method: "system-events-key-code",
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
    method: "native",
  };
}

export async function openTarget({ scope = "window" } = {}) {
  const requestedScope = scope === "tab" ? "tab" : "window";
  const raw = await runAppleScript(OPEN_SCRIPT, [requestedScope]);
  const [createdScope, windowId, tabIndex, sessionId] = raw.split(FIELD_SEPARATOR);

  return {
    ok: true,
    requestedScope,
    createdScope,
    windowId: Number(windowId),
    tabIndex: Number(tabIndex),
    sessionSpecifier: sessionId,
  };
}
