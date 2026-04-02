import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import {
  CURRENT_PLATFORM,
  SUPPORTED_APPS,
  captureTarget,
  closeTarget,
  focusTarget,
  getFrontmostApp,
  getSnapshot,
  normalizeAppOption,
  openTarget,
  pressKeyOnTarget,
  sendTextToTarget,
} from "../apps.js";
import { filterSessions, resolveSingleSession } from "../snapshot.js";
import { TermhubSDKError, toSDKError } from "./errors.js";

const PRESS_KEYS = new Set([
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
]);
const PRESS_MODIFIERS = new Set(["ctrl", "cmd", "alt", "shift"]);
const PRESS_ALIASES = Object.freeze({
  escape: "esc",
  pgup: "pageup",
  pageup: "pageup",
  pgdn: "pagedown",
  pagedown: "pagedown",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  control: "ctrl",
  command: "cmd",
  option: "alt",
});

const PROCESS_NAME_BY_APP = Object.freeze({
  terminal: "Terminal",
  iterm2: "iTerm2",
});

function assertString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TermhubSDKError(`${fieldName} must be a non-empty string`, {
      code: "ERR_SDK_USAGE",
    });
  }
}

function toInt(value, fieldName) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    throw new TermhubSDKError(`${fieldName} must be an integer`, {
      code: "ERR_SDK_USAGE",
      details: { fieldName, value },
    });
  }
  return parsed;
}

function canAppOpenScope(app, scope) {
  const metadata = SUPPORTED_APPS.find((entry) => entry.app === app);
  if (!metadata) {
    return false;
  }

  if (scope === "tab") {
    return metadata.capabilities?.openTab === true;
  }

  return metadata.capabilities?.openWindow === true;
}

async function resolveOpenApp(preferredApp, scope) {
  const requestedApp = normalizeAppOption(preferredApp);
  if (requestedApp) {
    return requestedApp;
  }

  const frontmost = normalizeAppOption((await getFrontmostApp())?.app);
  if (frontmost && canAppOpenScope(frontmost, scope)) {
    return frontmost;
  }

  const fallback = SUPPORTED_APPS.find((entry) => canAppOpenScope(entry.app, scope))?.app;
  if (fallback) {
    return fallback;
  }

  return frontmost ?? SUPPORTED_APPS[0]?.app ?? null;
}

function normalizeCriteria(criteria = {}) {
  return {
    app: normalizeAppOption(criteria.app ?? null),
    sessionId: criteria.sessionId ?? criteria.session ?? null,
    tty: criteria.tty ?? null,
    title: criteria.title ?? null,
    titleContains: criteria.titleContains ?? criteria.title_contains ?? null,
    name: criteria.name ?? null,
    nameContains: criteria.nameContains ?? criteria.name_contains ?? null,
    windowId: criteria.windowId != null ? toInt(criteria.windowId, "windowId") : null,
    windowIndex: criteria.windowIndex != null ? toInt(criteria.windowIndex, "windowIndex") : null,
    tabIndex: criteria.tabIndex != null ? toInt(criteria.tabIndex, "tabIndex") : null,
    currentWindow: criteria.currentWindow === true,
    currentTab: criteria.currentTab === true,
    currentSession: criteria.currentSession === true,
  };
}

function normalizePressModifier(value) {
  const raw = String(value).trim().toLowerCase();
  return PRESS_ALIASES[raw] ?? raw;
}

function normalizePressKey(value, { allowLiteral = false } = {}) {
  const raw = String(value).trim().toLowerCase();
  const normalized = PRESS_ALIASES[raw] ?? raw;

  if (allowLiteral && /^[a-z0-9]$/.test(normalized)) {
    return normalized;
  }

  if (!PRESS_KEYS.has(normalized)) {
    throw new TermhubSDKError(`Unsupported key: ${value}`, {
      code: "ERR_SDK_USAGE",
      details: { supportedKeys: [...PRESS_KEYS] },
    });
  }

  return normalized;
}

function parsePressComboValue(value) {
  const raw = String(value).trim().toLowerCase();
  if (!raw) {
    throw new TermhubSDKError("combo must be non-empty", { code: "ERR_SDK_USAGE" });
  }

  const parts = raw.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) {
    throw new TermhubSDKError("combo must include modifier + key", {
      code: "ERR_SDK_USAGE",
    });
  }

  const key = normalizePressKey(parts[parts.length - 1], { allowLiteral: true });
  const modifiers = [...new Set(parts.slice(0, -1).map((item) => normalizePressModifier(item)))];

  for (const modifier of modifiers) {
    if (!PRESS_MODIFIERS.has(modifier)) {
      throw new TermhubSDKError(`Unsupported combo modifier: ${modifier}`, {
        code: "ERR_SDK_USAGE",
      });
    }
  }

  return {
    type: "combo",
    key,
    modifiers,
    expression: `${modifiers.join("+")}+${key}`,
  };
}

function parsePressStepValue(value) {
  if (value.includes("+")) {
    return parsePressComboValue(value);
  }

  const key = normalizePressKey(value);
  return {
    type: "key",
    key,
    modifiers: [],
    expression: key,
  };
}

function parsePressSequenceValue(sequenceInput) {
  const raw = String(sequenceInput).trim();
  if (!raw) {
    throw new TermhubSDKError("sequence must be non-empty", { code: "ERR_SDK_USAGE" });
  }

  const steps = [];
  for (const token of raw.split(",")) {
    const trimmed = token.trim();
    if (!trimmed) {
      throw new TermhubSDKError("sequence contains an empty step", {
        code: "ERR_SDK_USAGE",
      });
    }

    const match = /^(.*?)(?:\*(\d+))?$/.exec(trimmed);
    const base = match?.[1]?.trim() ?? "";
    const repeat = match?.[2] ? Number.parseInt(match[2], 10) : 1;

    if (!base || !Number.isFinite(repeat) || repeat < 1) {
      throw new TermhubSDKError(`Invalid sequence step: ${trimmed}`, {
        code: "ERR_SDK_USAGE",
      });
    }

    const step = parsePressStepValue(base);
    for (let index = 0; index < repeat; index += 1) {
      steps.push(step);
    }
  }

  return steps;
}

function normalizePressInput(input = {}) {
  const hasKey = typeof input.key === "string" && input.key.trim() !== "";
  const hasCombo = typeof input.combo === "string" && input.combo.trim() !== "";
  const hasSequence =
    Array.isArray(input.sequence) || (typeof input.sequence === "string" && input.sequence.trim() !== "");

  const modeCount = Number(hasKey) + Number(hasCombo) + Number(hasSequence);
  if (modeCount !== 1) {
    throw new TermhubSDKError("press requires exactly one of key, combo, or sequence", {
      code: "ERR_SDK_USAGE",
    });
  }

  const delayMs = input.delayMs != null ? toInt(input.delayMs, "delayMs") : 40;
  if (delayMs < 0) {
    throw new TermhubSDKError("delayMs must be >= 0", { code: "ERR_SDK_USAGE" });
  }

  if (hasSequence) {
    if (input.repeat != null) {
      throw new TermhubSDKError("repeat cannot be used with sequence", {
        code: "ERR_SDK_USAGE",
      });
    }

    const sequence = Array.isArray(input.sequence)
      ? input.sequence.map((step) =>
          typeof step === "string" ? parsePressStepValue(step) : parsePressStepValue(step.expression ?? step.key),
        )
      : parsePressSequenceValue(input.sequence);

    return {
      mode: "sequence",
      sequence,
      repeat: 1,
      delayMs,
    };
  }

  const repeat = input.repeat != null ? toInt(input.repeat, "repeat") : 1;
  if (repeat < 1) {
    throw new TermhubSDKError("repeat must be >= 1", { code: "ERR_SDK_USAGE" });
  }

  if (hasCombo) {
    return {
      mode: "combo",
      combo: parsePressComboValue(input.combo),
      repeat,
      delayMs,
    };
  }

  return {
    mode: "key",
    key: normalizePressKey(input.key),
    repeat,
    delayMs,
  };
}

function runAppleScript(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-", ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      reject(new Error(stderr.trim() || stdout.trim() || "AppleScript execution failed"));
    });

    child.stdin.end(script);
  });
}

async function clickFrontWindowCenter(target) {
  if (CURRENT_PLATFORM !== "darwin") {
    throw new TermhubSDKError("mouse.click is currently supported on macOS only", {
      code: "ERR_SDK_UNSUPPORTED",
      details: {
        platform: CURRENT_PLATFORM,
      },
    });
  }

  const processName = PROCESS_NAME_BY_APP[target.app];
  if (!processName) {
    throw new TermhubSDKError(`mouse.click is not supported for app: ${target.app}`, {
      code: "ERR_SDK_UNSUPPORTED",
      details: {
        app: target.app,
      },
    });
  }

  const script = `
on run argv
  set bundleId to item 1 of argv
  set procName to item 2 of argv

  if application id bundleId is not running then
    error "target app is not running"
  end if

  tell application id bundleId to activate
  delay 0.05

  tell application "System Events"
    tell process procName
      set frontWin to front window
      set winPos to position of frontWin
      set winSize to size of frontWin
      set clickX to (item 1 of winPos) + ((item 1 of winSize) div 2)
      set clickY to (item 2 of winPos) + ((item 2 of winSize) div 2)
      click at {clickX, clickY}
    end tell
  end tell

  return "ok"
end run
`;

  await runAppleScript(script, [target.bundleId, processName]);
}

async function findOpenedTargetWithRetry(app, result, attempts, delayMs) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const snapshot = await getSnapshot({ app });

    if (result.sessionSpecifier) {
      const bySession = filterSessions(snapshot, {
        app,
        sessionId: result.sessionSpecifier,
      });
      if (bySession.length === 1) {
        return bySession[0];
      }
    }

    const byWindowTab = filterSessions(snapshot, {
      app,
      windowId: result.windowId,
      tabIndex: result.tabIndex,
    });

    if (byWindowTab.length === 1) {
      return byWindowTab[0];
    }

    if (attempt < attempts - 1) {
      await delay(delayMs);
    }
  }

  throw new TermhubSDKError("Unable to resolve opened target from latest snapshots", {
    code: "ERR_SDK_OPEN_TARGET_NOT_FOUND",
    details: {
      app,
      result,
    },
  });
}

export function getPlatformCapabilities() {
  return {
    platform: CURRENT_PLATFORM,
    supportsMouseClick: CURRENT_PLATFORM === "darwin",
    supportsKeyboardPress: true,
    supportsOpen: SUPPORTED_APPS.some(
      (app) => app.capabilities?.openWindow === true || app.capabilities?.openTab === true,
    ),
    apps: SUPPORTED_APPS.map((app) => ({
      app: app.app,
      displayName: app.displayName,
      platform: app.platform,
      capabilities: app.capabilities,
    })),
  };
}

export function createTermhubClient(options = {}) {
  const defaultApp = normalizeAppOption(options.app ?? null);
  const openRetryAttempts = options.openRetryAttempts ?? 6;
  const openRetryDelayMs = options.openRetryDelayMs ?? 150;

  async function snapshotWithDefault(appOverride = null) {
    return getSnapshot({ app: normalizeAppOption(appOverride ?? defaultApp) });
  }

  async function resolveTarget(sessionSpecifier, appOverride = null) {
    assertString(sessionSpecifier, "session");
    const snapshot = await snapshotWithDefault(appOverride);
    return resolveSingleSession(snapshot, sessionSpecifier);
  }

  return {
    platform: CURRENT_PLATFORM,

    capabilities() {
      return getPlatformCapabilities();
    },

    async spec() {
      try {
        return {
          ok: true,
          platform: CURRENT_PLATFORM,
          supportedApps: SUPPORTED_APPS,
        };
      } catch (error) {
        throw toSDKError(error, "Failed to read termhub SDK spec");
      }
    },

    async list(options = {}) {
      try {
        return snapshotWithDefault(options.app ?? null);
      } catch (error) {
        throw toSDKError(error, "Failed to list terminal sessions");
      }
    },

    async find(criteria = {}) {
      try {
        const normalized = normalizeCriteria({ ...criteria, app: criteria.app ?? defaultApp });
        const snapshot = await getSnapshot({ app: normalized.app });
        return {
          ok: true,
          criteria: normalized,
          matches: filterSessions(snapshot, normalized),
        };
      } catch (error) {
        throw toSDKError(error, "Failed to find terminal sessions");
      }
    },

    async findOne(criteria = {}) {
      const result = await this.find(criteria);
      if (result.matches.length !== 1) {
        throw new TermhubSDKError("findOne requires exactly one match", {
          code: "ERR_SDK_MATCH_COUNT",
          details: {
            count: result.matches.length,
            criteria: result.criteria,
          },
        });
      }

      return result.matches[0];
    },

    async open(options = {}) {
      try {
        const scope = options.scope === "tab" ? "tab" : "window";
        const app = await resolveOpenApp(options.app ?? defaultApp, scope);

        if (!app) {
          throw new TermhubSDKError("No supported backend available for open", {
            code: "ERR_SDK_UNSUPPORTED",
            details: { platform: CURRENT_PLATFORM },
          });
        }

        if (!canAppOpenScope(app, scope)) {
          throw new TermhubSDKError(`Open ${scope} is not supported for ${app}`, {
            code: "ERR_SDK_UNSUPPORTED",
            details: { app, scope },
          });
        }

        const result = await openTarget(app, { scope });
        const target = await findOpenedTargetWithRetry(
          app,
          result,
          openRetryAttempts,
          openRetryDelayMs,
        );

        return {
          ok: true,
          action: "open",
          target,
          result,
        };
      } catch (error) {
        throw toSDKError(error, "Failed to open terminal target");
      }
    },

    async send(options = {}) {
      try {
        const session = options.session ?? options.sessionId;
        assertString(session, "session");
        assertString(options.text, "text");

        const target = await resolveTarget(session, options.app ?? null);
        const newline = options.newline !== false;
        await sendTextToTarget(target, options.text, { newline });

        return {
          ok: true,
          action: "send",
          target,
          submit: newline,
          text: options.text,
        };
      } catch (error) {
        throw toSDKError(error, "Failed to send text to terminal target");
      }
    },

    async press(options = {}) {
      try {
        const session = options.session ?? options.sessionId;
        assertString(session, "session");

        const press = normalizePressInput(options);
        const target = await resolveTarget(session, options.app ?? null);
        const result = await pressKeyOnTarget(target, press);

        return {
          ok: true,
          action: "press",
          target,
          result,
        };
      } catch (error) {
        throw toSDKError(error, "Failed to press key on terminal target");
      }
    },

    async capture(options = {}) {
      try {
        const session = options.session ?? options.sessionId;
        assertString(session, "session");

        const target = await resolveTarget(session, options.app ?? null);
        let text = await captureTarget(target);

        if (options.lines != null) {
          const lineCount = toInt(options.lines, "lines");
          text = text.split(/\r?\n/).slice(-lineCount).join("\n");
        }

        return {
          ok: true,
          action: "capture",
          target,
          text,
        };
      } catch (error) {
        throw toSDKError(error, "Failed to capture terminal output");
      }
    },

    async focus(options = {}) {
      try {
        const session = options.session ?? options.sessionId;
        assertString(session, "session");

        const target = await resolveTarget(session, options.app ?? null);
        const result = await focusTarget(target);

        return {
          ok: true,
          action: "focus",
          target,
          result,
        };
      } catch (error) {
        throw toSDKError(error, "Failed to focus terminal target");
      }
    },

    async close(options = {}) {
      try {
        const session = options.session ?? options.sessionId;
        assertString(session, "session");

        const target = await resolveTarget(session, options.app ?? null);
        const result = await closeTarget(target);

        return {
          ok: true,
          action: "close",
          target,
          result,
        };
      } catch (error) {
        throw toSDKError(error, "Failed to close terminal target");
      }
    },

    async mouseClick(options = {}) {
      try {
        const session = options.session ?? options.sessionId;
        assertString(session, "session");

        const button = options.button ?? "left";
        if (button !== "left") {
          throw new TermhubSDKError("mouseClick currently supports button='left' only", {
            code: "ERR_SDK_UNSUPPORTED",
            details: { button },
          });
        }

        const target = await resolveTarget(session, options.app ?? null);
        await focusTarget(target);
        await clickFrontWindowCenter(target);

        return {
          ok: true,
          action: "mouseClick",
          target,
          button,
          method: CURRENT_PLATFORM === "darwin" ? "system-events-click" : "unsupported",
        };
      } catch (error) {
        throw toSDKError(error, "Failed to click terminal target");
      }
    },
  };
}
