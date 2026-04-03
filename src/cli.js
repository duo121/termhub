#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { CLIError, toErrorPayload } from "./errors.js";
import {
  CURRENT_PLATFORM,
  SUPPORTED_APPS,
  SUPPORTED_PLATFORMS,
  captureTarget,
  closeTarget,
  focusTarget,
  getFrontmostApp,
  getSnapshot,
  normalizeAppOption,
  openTarget,
  pressKeyOnTarget,
  sendTextToTarget,
} from "./apps.js";
import { filterSessions, resolveSingleSession } from "./snapshot.js";

const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

const MATCH_FIELDS = [
  "app",
  "displayName",
  "bundleId",
  "windowId",
  "windowIndex",
  "windowHandle",
  "isFrontmostWindow",
  "tabIndex",
  "tabTitle",
  "isCurrentTab",
  "tabHandle",
  "sessionIndex",
  "sessionId",
  "tty",
  "name",
  "isCurrentSession",
  "handle",
];

const SUPPORTED_APP_VALUES = SUPPORTED_APPS.map((app) => app.app);
const TERMHUB_STATE_DIR =
  (process.env.TERMHUB_STATE_DIR && String(process.env.TERMHUB_STATE_DIR).trim()) ||
  path.join(homedir(), ".termhub", "state");
const SEND_CHECKPOINT_VERSION = 1;
const SUPPORTED_PRESS_KEYS = new Set([
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
const SUPPORTED_PRESS_MODIFIERS = new Set(["ctrl", "cmd", "alt", "shift"]);
const PRESS_KEY_ALIASES = Object.freeze({
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

function hasSupportedApp(app) {
  return SUPPORTED_APP_VALUES.includes(app);
}

function getAppMetadata(app) {
  return SUPPORTED_APPS.find((entry) => entry.app === app) ?? null;
}

function canAppOpenScope(app, scope) {
  const appInfo = getAppMetadata(app);
  if (!appInfo) {
    return false;
  }

  if (scope === "tab") {
    return appInfo.capabilities?.openTab === true;
  }

  return appInfo.capabilities?.openWindow === true;
}

function buildSupportedAppsSpec() {
  return SUPPORTED_APPS.map((app) => ({
    app: app.app,
    displayName: app.displayName,
    platform: app.platform ?? CURRENT_PLATFORM,
    automation: app.automation ?? null,
    bundleId: app.bundleId ?? null,
    processNames: app.processNames ?? [],
    capabilities: app.capabilities ?? null,
  }));
}

function buildSendRules() {
  const rules = ["Exactly one of --text or --stdin is required."];
  rules.push("send appends enter by default.");
  rules.push("Pass --no-enter only when the payload should remain staged without submit.");
  rules.push("send stores a per-session checkpoint before writing so capture --since-last-send can return only new output.");
  rules.push("Do not append literal newline characters inside --text or --stdin to simulate submit.");

  if (getAppMetadata("terminal")?.capabilities?.sendWithoutEnter === false) {
    rules.push("Terminal rejects --no-enter.");
  }

  if (hasSupportedApp("windows-terminal") || hasSupportedApp("cmd")) {
    rules.push("Windows backends send input by focusing the target and using keyboard automation.");
  }

  return rules;
}

function buildPressRules() {
  const rules = ["Exactly one of --key, --combo, or --sequence is required."];
  const supportedKeys = [
    ...new Set(
      SUPPORTED_APPS.flatMap((app) =>
        Array.isArray(app.capabilities?.pressKeys) ? app.capabilities.pressKeys : [],
      ),
    ),
  ];

  if (supportedKeys.length > 0) {
    rules.push(`Currently supported key values on this platform: ${supportedKeys.join(", ")}.`);
  }

  rules.push("Use --combo for chords such as ctrl+c or cmd+k.");
  rules.push("Use --sequence for ordered key steps such as esc,esc or down*5,enter.");
  rules.push("--repeat applies to --key/--combo only. --delay sets milliseconds between steps.");

  return rules;
}

function buildCloseNotes() {
  const notes = [];

  if (hasSupportedApp("iterm2")) {
    notes.push("iTerm2 closes the target tab through its native AppleScript close command.");
  }

  if (hasSupportedApp("terminal")) {
    notes.push("Terminal closes the selected tab with the app's standard close shortcut after focusing it.");
    notes.push("Busy Terminal tabs may still trigger the app's own confirmation dialog.");
  }

  if (hasSupportedApp("windows-terminal")) {
    notes.push("Windows Terminal closes the selected tab with its standard Ctrl+Shift+W shortcut after focusing it.");
    notes.push("If the user changed Windows Terminal keybindings, close may fail until the default shortcut is restored or a native automation path is added.");
  }

  if (hasSupportedApp("cmd")) {
    notes.push("Command Prompt closes the target window through CloseMainWindow, with Alt+F4 as a fallback.");
  }

  return notes;
}

function buildCaptureNotes() {
  const notes = [];
  notes.push("Use --since-last-send to return only output added after the latest successful send on the same session.");
  notes.push("Use --wait <ms> to delay capture after send when output is asynchronous.");

  if (hasSupportedApp("windows-terminal") || hasSupportedApp("cmd")) {
    notes.push("Windows capture is best-effort and only reads text that UI Automation can see in the currently visible window.");
  }

  return notes;
}

function buildOpenNotes() {
  const notes = [];

  if (SUPPORTED_APPS.some((app) => app.capabilities?.openWindow || app.capabilities?.openTab)) {
    notes.push("If --tab is requested but the backend has no open windows yet, the backend may create a new window instead.");
  }

  if (hasSupportedApp("windows-terminal") || hasSupportedApp("cmd")) {
    notes.push("Current Windows backends do not yet advertise open support; check supportedApps[].capabilities before calling open.");
  }

  return notes;
}

function buildPressNotes() {
  const notes = [];

  if (SUPPORTED_APPS.some((app) => app.capabilities?.sendWithoutEnter && app.capabilities?.press)) {
    notes.push(
      "For interactive TUIs such as Codex, send the prompt with --no-enter first, then call press --key enter.",
    );
  }

  if (hasSupportedApp("terminal") || hasSupportedApp("iterm2")) {
    notes.push("macOS key presses use System Events and may require Accessibility permission.");
    notes.push("On macOS, enter and return are distinct keys. Use enter for Codex submit and return for a literal newline.");
  }

  if (hasSupportedApp("windows-terminal") || hasSupportedApp("cmd")) {
    notes.push("Windows key presses use PowerShell SendKeys after focusing the resolved target.");
  }

  notes.push("Sequence items support *N repetition, for example down*5,enter.");

  return notes;
}

function buildCliSpec() {
  return {
    ok: true,
    source: "termhub",
    specVersion: 3,
    cli: {
      name: "termhub",
      aliases: ["thub"],
      version: PACKAGE_VERSION,
    },
    purpose:
      "AI-native terminal control CLI for macOS and Windows. It discovers, resolves, opens, focuses, presses keys in, captures, sends to, and closes terminal windows and tabs through AppleScript or PowerShell/UI Automation depending on the backend.",
    platform: CURRENT_PLATFORM,
    supportedPlatforms: SUPPORTED_PLATFORMS,
    supportedApps: buildSupportedAppsSpec(),
    recommendedWorkflow: [
      "Use open when the user asks the AI to create a new terminal window or tab.",
      "Use list when the user asks what is open right now.",
      "Use resolve when the user identifies a target by title, tty, current tab, window id, or handle.",
      "Only call send, capture, focus, or close after you have exactly one target.",
      "send submits by default; only use --no-enter when the text must remain staged.",
      "For interactive TUIs, send text with --no-enter when supported, then call press --key enter.",
      "If resolve returns count 0 or count greater than 1, refine selectors instead of guessing.",
      "Use doctor when app availability, automation permission, or frontmost state are unclear.",
      "Use spec or command --help when the AI needs exact flag names or JSON output fields.",
    ],
    conventions: {
      transport: "stdout JSON",
      selectors: "All resolve selectors are ANDed together.",
      capabilities:
        "Each supported app advertises a capabilities object so the AI can determine whether send, sendWithoutEnter, press, pressKeys, pressCombos, pressSequence, capture, focus, close, tty selectors, contains matching, and dry-run planning are supported before calling a mutating command.",
      sessionSpecifier:
        "--session accepts either a backend session id or a namespaced handle such as iterm2:session:<uuid>, terminal:session:<windowId>:<tabIndex>, windows-terminal:session:<windowHandle>:<tabIndex>, or cmd:session:<pid>.",
      errors: {
        ok: false,
        error: {
          code: "STRING_CODE",
          message: "Human-readable message",
          details: "Optional structured details",
        },
      },
    },
    commands: {
      open: {
        usage: "termhub open [--app <app>] [--window | --tab] [--dry-run] [--compact]",
        purpose: "Open a new terminal window or tab in one backend.",
        options: [
          {
            name: "--app",
            type: "string",
            required: false,
            values: SUPPORTED_APP_VALUES,
            description:
              "Choose one backend explicitly. If omitted, termhub prefers the frontmost supported backend that supports the requested scope and otherwise falls back to the first supported backend on this platform that supports it.",
          },
          {
            name: "--window",
            type: "boolean",
            required: false,
            description: "Open a new window. This is the default if neither --window nor --tab is passed.",
          },
          {
            name: "--tab",
            type: "boolean",
            required: false,
            description: "Open a new tab in the chosen backend. Some backends may fall back to a window.",
          },
          {
            name: "--dry-run",
            type: "boolean",
            required: false,
            description: "Plan the open action and show which backend and scope would be used without executing it.",
          },
          {
            name: "--compact",
            type: "boolean",
            required: false,
            description: "Print JSON without indentation.",
          },
        ],
        notes: buildOpenNotes(),
        output: {
          topLevelFields: ["ok", "action", "dryRun", "plan", "target", "result"],
          targetFields: MATCH_FIELDS,
        },
      },
      list: {
        usage: "termhub list [--app <app>] [--compact]",
        purpose:
          "Discover running terminal apps, windows, tabs, sessions, titles, TTYs, and handles.",
        options: [
          {
            name: "--app",
            type: "string",
            required: false,
            values: SUPPORTED_APP_VALUES,
            description: "Restrict discovery to one backend.",
          },
          {
            name: "--compact",
            type: "boolean",
            required: false,
            description: "Print JSON without indentation.",
          },
        ],
        output: {
          topLevelFields: [
            "ok",
            "source",
            "version",
            "generatedAt",
            "frontmostApp",
            "counts",
            "apps",
            "windows",
          ],
          nestedFields: ["windows[].tabs[].sessions[]"],
        },
      },
      resolve: {
        usage: "termhub resolve [selectors] [--compact]",
        purpose: "Narrow a user-described target to exact session matches.",
        options: [
          {
            name: "--app",
            type: "string",
            required: false,
            values: SUPPORTED_APP_VALUES,
            description: "Restrict matching to one backend.",
          },
          {
            name: "--session",
            type: "string",
            required: false,
            description: "Match a native session id or namespaced handle.",
          },
          { name: "--tty", type: "string", required: false, description: "Match an exact tty path." },
          { name: "--title", type: "string", required: false, description: "Match an exact tab title." },
          {
            name: "--title-contains",
            type: "string",
            required: false,
            description: "Case-insensitive substring match against the tab title.",
          },
          { name: "--name", type: "string", required: false, description: "Match an exact session name." },
          {
            name: "--name-contains",
            type: "string",
            required: false,
            description: "Case-insensitive substring match against the session name.",
          },
          {
            name: "--window-id",
            type: "integer",
            required: false,
            description: "Match a native window id.",
          },
          {
            name: "--window-index",
            type: "integer",
            required: false,
            description: "Match the app-local window index.",
          },
          {
            name: "--tab-index",
            type: "integer",
            required: false,
            description: "Match the app-local tab index.",
          },
          {
            name: "--current-window",
            type: "boolean",
            required: false,
            description: "Match the frontmost window inside each inspected app.",
          },
          {
            name: "--current-tab",
            type: "boolean",
            required: false,
            description: "Match the selected tab inside each inspected app.",
          },
          {
            name: "--current-session",
            type: "boolean",
            required: false,
            description: "Match the selected session inside each inspected app.",
          },
          {
            name: "--compact",
            type: "boolean",
            required: false,
            description: "Print JSON without indentation.",
          },
        ],
        output: {
          topLevelFields: ["ok", "criteria", "count", "matches"],
          matchFields: MATCH_FIELDS,
        },
      },
      send: {
        usage:
          "termhub send --session <id|handle> (--text <text> | --stdin) [--app <app>] [--no-enter] [--dry-run]",
        purpose: "Send text into one resolved target.",
        options: [
          {
            name: "--session",
            type: "string",
            required: true,
            description: "Target session id or namespaced handle.",
          },
          {
            name: "--text",
            type: "string",
            required: false,
            description: "Send one string argument.",
          },
          {
            name: "--stdin",
            type: "boolean",
            required: false,
            description: "Read the full stdin stream and send it as one payload.",
          },
          {
            name: "--app",
            type: "string",
            required: false,
            values: SUPPORTED_APP_VALUES,
            description: "Restrict target lookup to one backend.",
          },
          {
            name: "--no-enter",
            type: "boolean",
            required: false,
            description:
              "Do not append enter. Use this only when the payload should remain staged for a later real key press. Check supportedApps[].capabilities.sendWithoutEnter before using it.",
          },
          {
            name: "--dry-run",
            type: "boolean",
            required: false,
            description: "Resolve the target and print the planned send action without executing it.",
          },
          {
            name: "--compact",
            type: "boolean",
            required: false,
            description: "Print JSON without indentation.",
          },
        ],
        rules: buildSendRules(),
        output: {
          topLevelFields: [
            "ok",
            "action",
            "dryRun",
            "plan",
            "submit",
            "bytes",
            "target",
            "text",
            "checkpoint",
          ],
          targetFields: MATCH_FIELDS,
        },
      },
      press: {
        usage:
          "termhub press --session <id|handle> (--key <key> | --combo <combo> | --sequence <steps>) [--repeat <n>] [--delay <ms>] [--app <app>] [--dry-run]",
        purpose: "Press a real key on one resolved target after focusing it.",
        options: [
          {
            name: "--session",
            type: "string",
            required: true,
            description: "Target session id or namespaced handle.",
          },
          {
            name: "--key",
            type: "string",
            required: false,
            description:
              "Key name to press. Check supportedApps[].capabilities.pressKeys or this command's rules before calling.",
          },
          {
            name: "--combo",
            type: "string",
            required: false,
            description:
              "One key chord, for example ctrl+c, cmd+k, or shift+tab. Check supportedApps[].capabilities.pressCombos before calling.",
          },
          {
            name: "--sequence",
            type: "string",
            required: false,
            description:
              "Comma-separated key steps, for example esc,esc or down*5,enter. Steps may use *N repeat suffix.",
          },
          {
            name: "--repeat",
            type: "integer",
            required: false,
            description: "Repeat count for --key or --combo. Must be at least 1.",
          },
          {
            name: "--delay",
            type: "integer",
            required: false,
            description: "Delay in milliseconds between repeated or sequenced key events. Default: 40.",
          },
          {
            name: "--app",
            type: "string",
            required: false,
            values: SUPPORTED_APP_VALUES,
            description: "Restrict target lookup to one backend.",
          },
          {
            name: "--dry-run",
            type: "boolean",
            required: false,
            description: "Resolve the target and print the planned key press without executing it.",
          },
          {
            name: "--compact",
            type: "boolean",
            required: false,
            description: "Print JSON without indentation.",
          },
        ],
        rules: buildPressRules(),
        notes: buildPressNotes(),
        output: {
          topLevelFields: [
            "ok",
            "action",
            "dryRun",
            "plan",
            "mode",
            "key",
            "combo",
            "sequence",
            "repeat",
            "delayMs",
            "target",
            "result",
          ],
          targetFields: MATCH_FIELDS,
        },
      },
      capture: {
        usage:
          "termhub capture --session <id|handle> [--app <app>] [--lines <n>] [--since-last-send] [--wait <ms>]",
        purpose:
          "Read visible terminal contents from one resolved target, or return only the delta since the latest send checkpoint.",
        options: [
          {
            name: "--session",
            type: "string",
            required: true,
            description: "Target session id or namespaced handle.",
          },
          {
            name: "--app",
            type: "string",
            required: false,
            values: SUPPORTED_APP_VALUES,
            description: "Restrict target lookup to one backend.",
          },
          {
            name: "--lines",
            type: "integer",
            required: false,
            description: "Trim the captured text to the last N lines.",
          },
          {
            name: "--since-last-send",
            type: "boolean",
            required: false,
            description:
              "Return only text added since the latest send checkpoint for this exact session handle.",
          },
          {
            name: "--wait",
            type: "integer",
            required: false,
            description: "Wait this many milliseconds before capturing.",
          },
          {
            name: "--compact",
            type: "boolean",
            required: false,
            description: "Print JSON without indentation.",
          },
        ],
        output: {
          topLevelFields: [
            "ok",
            "action",
            "target",
            "text",
            "sinceLastSend",
            "waitMs",
            "checkpoint",
          ],
          targetFields: MATCH_FIELDS,
        },
        notes: buildCaptureNotes(),
      },
      focus: {
        usage: "termhub focus --session <id|handle> [--app <app>] [--dry-run]",
        purpose: "Bring the owning window and target tab or session to the front.",
        options: [
          {
            name: "--session",
            type: "string",
            required: true,
            description: "Target session id or namespaced handle.",
          },
          {
            name: "--app",
            type: "string",
            required: false,
            values: SUPPORTED_APP_VALUES,
            description: "Restrict target lookup to one backend.",
          },
          {
            name: "--compact",
            type: "boolean",
            required: false,
            description: "Print JSON without indentation.",
          },
          {
            name: "--dry-run",
            type: "boolean",
            required: false,
            description: "Resolve the target and print the planned focus action without executing it.",
          },
        ],
        output: {
          topLevelFields: ["ok", "action", "dryRun", "plan", "target", "result"],
          targetFields: MATCH_FIELDS,
        },
      },
      close: {
        usage: "termhub close --session <id|handle> [--app <app>] [--dry-run]",
        purpose: "Close the owning tab or window for one resolved target.",
        options: [
          {
            name: "--session",
            type: "string",
            required: true,
            description: "Target session id or namespaced handle.",
          },
          {
            name: "--app",
            type: "string",
            required: false,
            values: SUPPORTED_APP_VALUES,
            description: "Restrict target lookup to one backend.",
          },
          {
            name: "--compact",
            type: "boolean",
            required: false,
            description: "Print JSON without indentation.",
          },
          {
            name: "--dry-run",
            type: "boolean",
            required: false,
            description: "Resolve the target and print the planned close action without executing it.",
          },
        ],
        notes: buildCloseNotes(),
        output: {
          topLevelFields: ["ok", "action", "dryRun", "plan", "target", "result"],
          targetFields: MATCH_FIELDS,
        },
      },
      doctor: {
        usage: "termhub doctor [--app <app>] [--compact]",
        purpose: "Check platform, running backends, and automation inspection state.",
        options: [
          {
            name: "--app",
            type: "string",
            required: false,
            values: SUPPORTED_APP_VALUES,
            description: "Restrict inspection to one backend.",
          },
          {
            name: "--compact",
            type: "boolean",
            required: false,
            description: "Print JSON without indentation.",
          },
        ],
        output: {
          topLevelFields: ["ok", "checks", "snapshot"],
        },
      },
      spec: {
        usage: "termhub spec [--compact]",
        purpose: "Print the machine-readable termhub command and JSON contract.",
        options: [
          {
            name: "--compact",
            type: "boolean",
            required: false,
            description: "Print JSON without indentation.",
          },
        ],
        output: {
          topLevelFields: [
            "ok",
            "source",
            "specVersion",
            "cli",
            "purpose",
            "platform",
            "supportedPlatforms",
            "supportedApps",
            "recommendedWorkflow",
            "conventions",
            "commands",
          ],
        },
      },
    },
  };
}

function formatBulletLines(items) {
  return items.map((item) => `  - ${item}`).join("\n");
}

function buildSessionIdentifierNotes() {
  const notes = [];

  if (hasSupportedApp("iterm2")) {
    notes.push("iTerm2 sessionId is the native UUID reported by iTerm2.");
  }

  if (hasSupportedApp("terminal")) {
    notes.push("Terminal sessionId is the tab tty, for example /dev/ttys058.");
  }

  if (hasSupportedApp("windows-terminal")) {
    notes.push("Windows Terminal sessionId is synthetic: <windowHandle>:<tabIndex>.");
  }

  if (hasSupportedApp("cmd")) {
    notes.push("Command Prompt sessionId is the owning cmd.exe process id.");
  }

  const handleExamples = [];
  if (hasSupportedApp("iterm2")) {
    handleExamples.push("iterm2:session:<uuid>");
  }
  if (hasSupportedApp("terminal")) {
    handleExamples.push("terminal:session:<windowId>:<tabIndex>");
  }
  if (hasSupportedApp("windows-terminal")) {
    handleExamples.push("windows-terminal:session:<windowHandle>:<tabIndex>");
  }
  if (hasSupportedApp("cmd")) {
    handleExamples.push("cmd:session:<pid>");
  }

  notes.push(`Namespaced handle examples: ${handleExamples.join(", ")}.`);
  notes.push("--session accepts either the sessionId or the namespaced handle.");
  return notes;
}

function buildRootBackendNotes() {
  const notes = [];

  if (SUPPORTED_APP_VALUES.length > 1) {
    notes.push("When multiple backends are running, add --app for precise current-* queries.");
  }

  notes.push("open is only available on backends whose capabilities advertise openWindow or openTab.");
  notes.push("close targets the owning tab or window of the resolved session.");
  notes.push("Use --dry-run with open, send, press, focus, or close when the AI should preview the exact target and action before execution.");

  if (hasSupportedApp("iterm2")) {
    notes.push("iTerm2 supports send with or without enter.");
  }

  if (hasSupportedApp("terminal")) {
    if (getAppMetadata("terminal")?.capabilities?.sendWithoutEnter === true) {
      notes.push("Terminal supports send without enter through keyboard automation after focusing the target tab.");
    } else {
      notes.push("Terminal supports send with enter only; --no-enter is rejected.");
    }
  }

  if (SUPPORTED_APPS.some((app) => app.capabilities?.press === true)) {
    notes.push("press sends real key events. Use --key, --combo, or --sequence for interactive TUIs.");
  }

  if (hasSupportedApp("windows-terminal")) {
    notes.push("Windows Terminal send, focus, capture, and close use PowerShell plus UI Automation.");
  }

  if (hasSupportedApp("cmd")) {
    notes.push("Command Prompt is modeled as one tab and one session per window.");
  }

  return [...notes, ...buildCaptureNotes(), ...buildCloseNotes()];
}

function buildExamples() {
  const openApp =
    SUPPORTED_APPS.find((appInfo) => appInfo.capabilities?.openWindow === true)?.app ?? "<app>";

  if (hasSupportedApp("windows-terminal")) {
    return {
      listApp: "windows-terminal",
      open: `termhub open --app ${openApp} --window --dry-run`,
      resolve: "termhub resolve --app windows-terminal --title Task1",
      send: "termhub send --session windows-terminal:session:<windowHandle>:1 --text 'npm test'",
      press: "termhub press --session windows-terminal:session:<windowHandle>:1 --key enter",
      pressCombo:
        "termhub press --session windows-terminal:session:<windowHandle>:1 --combo ctrl+c",
      pressSequence:
        "termhub press --session windows-terminal:session:<windowHandle>:1 --sequence 'esc,down*2,enter'",
      capture: "termhub capture --session windows-terminal:session:<windowHandle>:1 --lines 30",
      captureDelta:
        "termhub capture --session windows-terminal:session:<windowHandle>:1 --since-last-send --wait 1500",
      focus: "termhub focus --session windows-terminal:session:<windowHandle>:1",
      close: "termhub close --session windows-terminal:session:<windowHandle>:1",
      stdin:
        "Get-Content .\\commands.txt | termhub send --session cmd:session:<pid> --stdin --app cmd",
      doctorApp: hasSupportedApp("cmd") ? "cmd" : "windows-terminal",
    };
  }

  return {
    listApp: hasSupportedApp("terminal") ? "terminal" : SUPPORTED_APP_VALUES[0] ?? "<app>",
    open: `termhub open --app ${openApp} --window`,
    resolve: hasSupportedApp("iterm2")
      ? "termhub resolve --app iterm2 --title Task1"
      : "termhub resolve --title Task1",
    send: hasSupportedApp("iterm2")
      ? "termhub send --session iterm2:session:<uuid> --text 'npm test'"
      : "termhub send --session <id|handle> --text 'npm test'",
    press: hasSupportedApp("iterm2")
      ? "termhub press --session iterm2:session:<uuid> --key enter"
      : "termhub press --session <id|handle> --key enter",
    pressCombo: hasSupportedApp("iterm2")
      ? "termhub press --session iterm2:session:<uuid> --combo cmd+k"
      : "termhub press --session <id|handle> --combo ctrl+c",
    pressSequence: hasSupportedApp("iterm2")
      ? "termhub press --session iterm2:session:<uuid> --sequence 'esc,down*2,enter'"
      : "termhub press --session <id|handle> --sequence 'esc,down*2,enter'",
    capture: hasSupportedApp("terminal")
      ? "termhub capture --session terminal:session:545305:1 --lines 30"
      : "termhub capture --session iterm2:session:<uuid> --lines 30",
    captureDelta: hasSupportedApp("terminal")
      ? "termhub capture --session terminal:session:545305:1 --since-last-send --wait 1200"
      : "termhub capture --session iterm2:session:<uuid> --since-last-send --wait 1200",
    focus: hasSupportedApp("iterm2")
      ? "termhub focus --session iterm2:session:<uuid>"
      : "termhub focus --session terminal:session:545305:1",
    close: hasSupportedApp("terminal")
      ? "termhub close --session terminal:session:545305:1"
      : "termhub close --session iterm2:session:<uuid>",
    stdin:
      "printf 'echo one\\necho two\\n' | termhub send --session /dev/ttys058 --stdin --app terminal",
    doctorApp: hasSupportedApp("terminal") ? "terminal" : "iterm2",
  };
}

function buildRootHelp() {
  const examples = buildExamples();

  return `termhub (alias: thub)

AI-native terminal control CLI for macOS and Windows.
Use it when an AI needs to inspect, resolve, open, focus, press keys in, capture, send to, or close terminal tabs.

Current platform:
  ${CURRENT_PLATFORM}

Recommended AI workflow:
  1. termhub open ... when the user asks for a new terminal window or tab
  2. termhub list
  3. termhub resolve ...
  4. termhub send ...
  5. termhub press --key/--combo/--sequence ... when the target expects real key events
  6. termhub capture | focus | close ...
  7. termhub doctor when app state or permissions are unclear
  8. termhub spec for the machine-readable command and JSON contract

Usage:
  termhub --version | -v | -V
  termhub open [--app <app>] [--window | --tab] [--dry-run] [--compact]
  termhub list [--app <app>] [--compact]
  termhub resolve [selectors] [--compact]
  termhub send --session <id|handle> (--text <text> | --stdin) [--app <app>] [--no-enter] [--dry-run]
  termhub press --session <id|handle> (--key <key> | --combo <combo> | --sequence <steps>) [--repeat <n>] [--delay <ms>] [--app <app>] [--dry-run]
  termhub capture --session <id|handle> [--app <app>] [--lines <n>] [--since-last-send] [--wait <ms>]
  termhub focus --session <id|handle> [--app <app>] [--dry-run]
  termhub close --session <id|handle> [--app <app>] [--dry-run]
  termhub doctor [--app <app>] [--compact]
  termhub spec [--compact]
  termhub <command> --help

Command roles:
  open     Open a new terminal window or tab in one backend.
  list     Discover open apps, windows, tabs, sessions, titles, TTYs, and handles.
  resolve  Narrow a user-described target to exact session matches.
  send     Send text or stdin into one resolved target.
  press    Press a real key on one resolved target after focusing it.
  capture  Read current visible contents, or the delta since the latest send checkpoint.
  focus    Bring the owning window and tab to the front.
  close    Close the owning tab or window for one resolved target.
  doctor   Diagnose platform, running apps, and automation readiness.
  spec     Print machine-readable command, option, and output schema data.

Selectors for resolve:
  --app <app>             Restrict search to one backend.
  --session <id|handle>   Match a session id or namespaced handle.
  --tty <tty>             Match a tty, for example /dev/ttys055.
  --title <tab-title>     Match tab title.
  --title-contains <txt>  Case-insensitive substring match for tab title.
  --name <session-name>   Match session name.
  --name-contains <txt>   Case-insensitive substring match for session name.
  --window-id <id>        Match native window id.
  --window-index <n>      Match the app-local window index.
  --tab-index <n>         Match the app-local tab index.
  --current-window        Match the current window inside each app.
  --current-tab           Match the selected tab inside each app.
  --current-session       Match the selected session inside each app.

Session ids and handles:
${formatBulletLines(buildSessionIdentifierNotes())}

Output model:
  - list returns:
      frontmostApp
      apps[]
      windows[].tabs[].sessions[]
  - resolve returns:
      count
      matches[]
  - matches include:
      ${MATCH_FIELDS.join(", ")}

Backend notes:
${formatBulletLines(buildRootBackendNotes())}

Examples:
  termhub --version
  termhub -V
  termhub spec
  ${examples.open}
  termhub list
  termhub list --app ${examples.listApp}
  ${examples.resolve}
  ${examples.send}
  ${examples.press}
  ${examples.pressCombo}
  ${examples.pressSequence}
  ${examples.stdin}
  ${examples.capture}
  ${examples.captureDelta}
  ${examples.focus}
  ${examples.close}

Supported app values on this machine:
  ${SUPPORTED_APP_VALUES.join(", ") || "(none)"}
`;
}

function buildCommandHelp() {
  const examples = buildExamples();
  const captureNotes = buildCaptureNotes();
  const closeNotes = buildCloseNotes();
  const tabOpenApp =
    SUPPORTED_APPS.find((appInfo) => appInfo.capabilities?.openTab === true)?.app ?? "<app>";
  const windowOpenApp =
    SUPPORTED_APPS.find((appInfo) => appInfo.capabilities?.openWindow === true)?.app ?? "<app>";

  return {
    open: `termhub open

Usage:
  termhub open [--app <app>] [--window | --tab] [--dry-run] [--compact]

Description:
  Open a new terminal window or tab in one backend.
  If --app is omitted, termhub prefers the frontmost supported backend that supports the requested scope and otherwise falls back to the first supported backend on this platform that supports it.
  --window is the default if neither --window nor --tab is passed.
  --dry-run resolves the backend and scope and prints the planned open without executing it.
${buildOpenNotes().length > 0 ? `\nNotes:\n${formatBulletLines(buildOpenNotes())}` : ""}

Output:
  JSON object with:
    ok, action, dryRun, plan, target, result

Examples:
  ${examples.open}
  termhub open --app ${tabOpenApp} --tab
  termhub open --app ${windowOpenApp} --window --dry-run
`,
    list: `termhub list

Usage:
  termhub list [--app <app>] [--compact]

Description:
  Enumerate running terminal windows, tabs, sessions, titles, TTYs, handles, and app metadata.
  Use this first when the user asks what is open right now.

Output:
  JSON snapshot with:
    ok, source, version, generatedAt, frontmostApp, counts, apps[], windows[]
  Nested fields include:
    windows[].tabs[].sessions[]

Examples:
  termhub list
  termhub list --app ${examples.listApp}
  termhub list --app ${examples.listApp} --compact

Hint:
  Run termhub spec for the machine-readable field list.
`,
    resolve: `termhub resolve

Usage:
  termhub resolve [selectors] [--compact]

Selectors:
  --app <app>
  --session <id|handle>
  --tty <tty>
  --title <tab-title>
  --title-contains <txt>
  --name <session-name>
  --name-contains <txt>
  --window-id <id>
  --window-index <n>
  --tab-index <n>
  --current-window
  --current-tab
  --current-session

Description:
  Narrow a user-described target to exact session matches.
  All selectors are ANDed together.
  If count is 0 or greater than 1, refine selectors instead of guessing.
  current-* selectors are app-local when multiple backends are running.

Output:
  JSON object with:
    ok, criteria, count, matches[]
  match fields include:
    ${MATCH_FIELDS.join(", ")}

Examples:
  termhub resolve --title Task1
  termhub resolve --title-contains task
  ${examples.resolve}
  termhub resolve --app ${examples.listApp} --current-window --current-tab --current-session

Hint:
  Use the returned handle or sessionId as the next command's --session value.
`,
    send: `termhub send

Usage:
  termhub send --session <id|handle> (--text <text> | --stdin) [--app <app>] [--no-enter] [--dry-run]

Description:
  Send text to one resolved session target.
  Usually call resolve first, then pass the exact handle or sessionId.
  --text sends one string argument.
  --stdin reads the full stdin stream and sends it as one payload.
  send appends enter by default.
  Check supportedApps[].capabilities.sendWithoutEnter in termhub spec before using --no-enter.
  --no-enter stages the payload without submit. For interactive TUIs, pair --no-enter with a later press --key enter call.
  send stores a per-session checkpoint before writing so a later capture --since-last-send can return only new output.
  Do not append literal newline characters inside --text or stdin to simulate submit.
  --dry-run resolves the target and prints the planned send without writing to the terminal.

Output:
  JSON object with:
    ok, action, dryRun, plan, submit, bytes, target, text, checkpoint

Examples:
  ${examples.send}
  termhub send --session <id|handle> --text 'analyze this error' --no-enter
  termhub send --session <id|handle> --text 'echo hello' --dry-run
  termhub send --session <id|handle> --text 'echo hello'
  ${examples.stdin}
`,
    press: `termhub press

Usage:
  termhub press --session <id|handle> (--key <key> | --combo <combo> | --sequence <steps>) [--repeat <n>] [--delay <ms>] [--app <app>] [--dry-run]

Description:
  Press a real key on one resolved target after focusing its owning window and tab.
  Use this for interactive TUIs that require an actual key event instead of a literal newline character.
  --key sends one key name.
  --combo sends one key chord such as ctrl+c or cmd+k.
  --sequence sends comma-separated steps such as esc,esc or down*5,enter.
  --repeat applies to --key or --combo.
  Check supportedApps[].capabilities.pressKeys, pressCombos, and pressSequence in termhub spec before calling across platforms.
  --dry-run resolves the target and prints the planned key press without changing the UI.
${buildPressNotes().length > 0 ? `\nNotes:\n${formatBulletLines(buildPressNotes())}` : ""}

Output:
  JSON object with:
    ok, action, dryRun, plan, mode, key, combo, sequence, repeat, delayMs, target, result

Examples:
  ${examples.press}
  ${examples.pressCombo}
  ${examples.pressSequence}
  termhub press --session <id|handle> --key enter --dry-run
`,
    capture: `termhub capture

Usage:
  termhub capture --session <id|handle> [--app <app>] [--lines <n>] [--since-last-send] [--wait <ms>]

Description:
  Capture current visible terminal contents for one resolved target.
  --since-last-send returns only output added after the latest successful send checkpoint on this session.
  --wait delays capture by N milliseconds.
  --lines trims the result to the last N lines after capture.
${captureNotes.length > 0 ? `\nNotes:\n${formatBulletLines(captureNotes)}` : ""}

Output:
  JSON object with:
    ok, action, target, text, sinceLastSend, waitMs, checkpoint

Examples:
  ${examples.capture}
  ${examples.captureDelta}
  termhub capture --session <id|handle> --lines 40
`,
    focus: `termhub focus

Usage:
  termhub focus --session <id|handle> [--app <app>] [--dry-run]

Description:
  Bring the owning window to the front and select the target tab or session.
  --dry-run resolves the target and prints the planned focus without changing the UI.

Output:
  JSON object with:
    ok, action, dryRun, plan, target, result

Examples:
  ${examples.focus}
  termhub focus --session <id|handle> --dry-run
  termhub focus --session <id|handle>
`,
    close: `termhub close

Usage:
  termhub close --session <id|handle> [--app <app>] [--dry-run]

Description:
  Close the owning tab or window for one resolved target.
  Use this when the user asks the AI to close a specific tab.
  --dry-run resolves the target and prints the planned close without executing it.
${closeNotes.length > 0 ? `\nNotes:\n${formatBulletLines(closeNotes)}` : ""}

Output:
  JSON object with:
    ok, action, dryRun, plan, target, result

Examples:
  ${examples.close}
  termhub close --session <id|handle> --dry-run
  termhub close --session <id|handle>
`,
    doctor: `termhub doctor

Usage:
  termhub doctor [--app <app>] [--compact]

Description:
  Report platform, supported backends, running status, current frontmost app,
  and window/tab/session counts for each inspected backend.

Examples:
  termhub doctor
  termhub doctor --app ${examples.doctorApp} --compact
`,
    spec: `termhub spec

Usage:
  termhub spec [--compact]

Description:
  Print the machine-readable termhub command contract for AI callers.
  Includes:
    platform
    supported apps
    recommended workflow
    command usage
    option types
    output fields

Examples:
  termhub spec
  termhub spec --compact
`,
  };
}

const GLOBAL_OPTIONS = new Set(["help", "compact"]);
const COMMAND_OPTIONS = {
  open: new Set(["app", "window", "tab", "dryRun"]),
  list: new Set(["app"]),
  resolve: new Set([
    "app",
    "session",
    "tty",
    "title",
    "titleContains",
    "name",
    "nameContains",
    "windowId",
    "windowIndex",
    "tabIndex",
    "currentWindow",
    "currentTab",
    "currentSession",
  ]),
  send: new Set(["app", "session", "text", "stdin", "enter", "dryRun"]),
  press: new Set(["app", "session", "key", "combo", "sequence", "repeat", "delay", "dryRun"]),
  focus: new Set(["app", "session", "dryRun"]),
  close: new Set(["app", "session", "dryRun"]),
  capture: new Set(["app", "session", "lines", "sinceLastSend", "wait"]),
  doctor: new Set(["app"]),
  spec: new Set([]),
};

function toCamelOption(optionName) {
  return optionName.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function parseArgv(argv) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return {
      command: "help",
      options: {},
      positionals: [],
    };
  }

  if (
    argv[0] === "--version" ||
    argv[0] === "-v" ||
    argv[0] === "-V" ||
    argv[0] === "version"
  ) {
    return {
      command: "version",
      options: {},
      positionals: [],
    };
  }

  if (argv[0] === "help") {
    return {
      command: argv[1] ?? "help",
      options: { help: true },
      positionals: argv.slice(2),
    };
  }

  const [command, ...tokens] = argv;
  const options = {};
  const positionals = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--no-")) {
      options[toCamelOption(token.slice(5))] = false;
      continue;
    }

    const eqIndex = token.indexOf("=");
    if (eqIndex !== -1) {
      const key = toCamelOption(token.slice(2, eqIndex));
      options[key] = token.slice(eqIndex + 1);
      continue;
    }

    const key = toCamelOption(token.slice(2));
    const next = tokens[index + 1];

    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    index += 1;
  }

  return {
    command,
    options,
    positionals,
  };
}

function getHelpText(command) {
  const rootHelp = buildRootHelp();
  const commandHelp = buildCommandHelp();

  if (!command || command === "help") {
    return rootHelp;
  }

  return commandHelp[command] ?? rootHelp;
}

function assertKnownCommand(command) {
  if (!COMMAND_OPTIONS[command]) {
    throw new CLIError(`Unknown command: ${command}`, {
      code: "UNKNOWN_COMMAND",
      exitCode: 2,
    });
  }
}

function assertKnownOptions(command, options, positionals) {
  if (positionals.length > 0) {
    throw new CLIError(`Unexpected positional arguments: ${positionals.join(" ")}`, {
      code: "USAGE_ERROR",
      exitCode: 2,
    });
  }

  const allowed = new Set([...GLOBAL_OPTIONS, ...COMMAND_OPTIONS[command]]);

  for (const option of Object.keys(options)) {
    if (!allowed.has(option)) {
      throw new CLIError(`Unknown option for ${command}: --${option}`, {
        code: "USAGE_ERROR",
        exitCode: 2,
      });
    }
  }
}

function toInt(value, optionName) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    throw new CLIError(`Invalid value for --${optionName}: ${value}`, {
      code: "USAGE_ERROR",
      exitCode: 2,
    });
  }
  return parsed;
}

function getErrorMessage(error) {
  if (error instanceof Error && typeof error.message === "string") {
    return error.message;
  }

  return String(error);
}

function getSessionCheckpointKey(target) {
  return String(target.handle ?? `${target.app}:session:${target.sessionId}`);
}

function getSessionCheckpointPath(target) {
  const key = getSessionCheckpointKey(target);
  const hash = createHash("sha256").update(key).digest("hex");
  return path.join(TERMHUB_STATE_DIR, `send-checkpoint-${hash}.json`);
}

async function saveSessionCheckpoint(target, baselineText) {
  const sessionKey = getSessionCheckpointKey(target);
  const checkpointPath = getSessionCheckpointPath(target);
  const savedAt = new Date().toISOString();
  const payload = {
    version: SEND_CHECKPOINT_VERSION,
    sessionKey,
    app: target.app,
    sessionId: target.sessionId,
    handle: target.handle ?? null,
    savedAt,
    baselineText,
  };

  await mkdir(TERMHUB_STATE_DIR, { recursive: true });
  await writeFile(checkpointPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  return {
    sessionKey,
    checkpointPath,
    savedAt,
  };
}

async function readSessionCheckpoint(target) {
  const sessionKey = getSessionCheckpointKey(target);
  const checkpointPath = getSessionCheckpointPath(target);

  let raw;
  try {
    raw = await readFile(checkpointPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw new CLIError("Failed to read send checkpoint state", {
      code: "STATE_ERROR",
      exitCode: 1,
      details: {
        sessionKey,
        checkpointPath,
        message: getErrorMessage(error),
      },
    });
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new CLIError("Send checkpoint state file is invalid JSON", {
      code: "STATE_ERROR",
      exitCode: 1,
      details: {
        sessionKey,
        checkpointPath,
        message: getErrorMessage(error),
      },
    });
  }

  if (payload?.sessionKey !== sessionKey) {
    return null;
  }

  return {
    sessionKey,
    checkpointPath,
    savedAt: typeof payload.savedAt === "string" ? payload.savedAt : null,
    baselineText: typeof payload.baselineText === "string" ? payload.baselineText : "",
  };
}

function computeCaptureDelta(currentText, baselineText) {
  if (currentText === baselineText) {
    return "";
  }

  if (!baselineText) {
    return currentText;
  }

  if (currentText.startsWith(baselineText)) {
    return currentText.slice(baselineText.length);
  }

  const maxOverlap = Math.min(currentText.length, baselineText.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (baselineText.slice(-overlap) === currentText.slice(0, overlap)) {
      return currentText.slice(overlap);
    }
  }

  return currentText;
}

function normalizeCriteria(options) {
  return {
    app: normalizeAppOption(options.app),
    sessionId: typeof options.session === "string" ? options.session : null,
    tty: typeof options.tty === "string" ? options.tty : null,
    title: typeof options.title === "string" ? options.title : null,
    titleContains: typeof options.titleContains === "string" ? options.titleContains : null,
    name: typeof options.name === "string" ? options.name : null,
    nameContains: typeof options.nameContains === "string" ? options.nameContains : null,
    windowId:
      typeof options.windowId === "string" ? toInt(options.windowId, "window-id") : null,
    windowIndex:
      typeof options.windowIndex === "string"
        ? toInt(options.windowIndex, "window-index")
        : null,
    tabIndex: typeof options.tabIndex === "string" ? toInt(options.tabIndex, "tab-index") : null,
    currentWindow: options.currentWindow === true,
    currentTab: options.currentTab === true,
    currentSession: options.currentSession === true,
  };
}

function hasAnyCriteria(criteria) {
  return Object.values(criteria).some((value) => Boolean(value));
}

function writeJson(payload, options = {}) {
  const spacing = options.compact ? 0 : 2;
  process.stdout.write(`${JSON.stringify(payload, null, spacing)}\n`);
}

function hasPipedStdin() {
  return process.stdin.isTTY !== true;
}

async function readStdinText() {
  if (!hasPipedStdin()) {
    throw new CLIError("send --stdin requires piped stdin", {
      code: "USAGE_ERROR",
      exitCode: 2,
    });
  }

  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return chunks.join("");
}

function requireSessionOption(options, commandName) {
  if (typeof options.session !== "string") {
    throw new CLIError(`${commandName} requires --session <id|handle>`, {
      code: "USAGE_ERROR",
      exitCode: 2,
    });
  }

  return options.session;
}

function requireKeyOption(options) {
  if (typeof options.key !== "string" || options.key.trim() === "") {
    throw new CLIError("press requires --key <key>", {
      code: "USAGE_ERROR",
      exitCode: 2,
    });
  }

  return options.key.trim().toLowerCase();
}

function normalizePressModifier(value) {
  const raw = String(value).trim().toLowerCase();
  return PRESS_KEY_ALIASES[raw] ?? raw;
}

function normalizePressKey(value, options = {}) {
  const allowLiteral = options.allowLiteral === true;
  const raw = String(value).trim().toLowerCase();
  const normalized = PRESS_KEY_ALIASES[raw] ?? raw;
  if (allowLiteral && /^[a-z0-9]$/.test(normalized)) {
    return normalized;
  }
  if (!SUPPORTED_PRESS_KEYS.has(normalized)) {
    throw new CLIError(`Unsupported press key: ${value}`, {
      code: "USAGE_ERROR",
      exitCode: 2,
      details: {
        supportedKeys: [...SUPPORTED_PRESS_KEYS],
        allowLiteral: allowLiteral ? "single letters or digits are also allowed" : null,
      },
    });
  }

  return normalized;
}

function parsePressComboValue(value) {
  const raw = String(value).trim().toLowerCase();
  if (raw === "") {
    throw new CLIError("press --combo value cannot be empty", {
      code: "USAGE_ERROR",
      exitCode: 2,
    });
  }

  const parts = raw.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) {
    throw new CLIError("press --combo must include at least one modifier and one key", {
      code: "USAGE_ERROR",
      exitCode: 2,
    });
  }

  const keyPart = parts[parts.length - 1];
  const modifierParts = parts.slice(0, -1).map(normalizePressModifier);
  const uniqueModifiers = [...new Set(modifierParts)];

  for (const modifier of uniqueModifiers) {
    if (!SUPPORTED_PRESS_MODIFIERS.has(modifier)) {
      throw new CLIError(`Unsupported press modifier in --combo: ${modifier}`, {
        code: "USAGE_ERROR",
        exitCode: 2,
      });
    }
  }

  const key = normalizePressKey(keyPart, { allowLiteral: true });
  return {
    type: "combo",
    key,
    modifiers: uniqueModifiers,
    expression: `${uniqueModifiers.join("+")}+${key}`,
  };
}

function parsePressStepValue(value) {
  const raw = String(value).trim();
  if (raw === "") {
    throw new CLIError("press --sequence contains an empty step", {
      code: "USAGE_ERROR",
      exitCode: 2,
    });
  }

  if (raw.includes("+")) {
    return parsePressComboValue(raw);
  }

  const key = normalizePressKey(raw);
  return {
    type: "key",
    key,
    modifiers: [],
    expression: key,
  };
}

function parsePressSequenceValue(value) {
  const raw = String(value).trim();
  if (raw === "") {
    throw new CLIError("press requires a non-empty --sequence value", {
      code: "USAGE_ERROR",
      exitCode: 2,
    });
  }

  const steps = [];
  const tokens = raw.split(",");
  for (const token of tokens) {
    const trimmed = token.trim();
    if (trimmed === "") {
      throw new CLIError("press --sequence contains an empty step", {
        code: "USAGE_ERROR",
        exitCode: 2,
      });
    }

    const match = /^(.*?)(?:\*(\d+))?$/.exec(trimmed);
    const base = match?.[1]?.trim() ?? "";
    const repeatValue = match?.[2] ? Number.parseInt(match[2], 10) : 1;

    if (base === "" || !Number.isFinite(repeatValue) || repeatValue < 1) {
      throw new CLIError(`Invalid --sequence step: ${trimmed}`, {
        code: "USAGE_ERROR",
        exitCode: 2,
      });
    }

    const parsedStep = parsePressStepValue(base);
    for (let index = 0; index < repeatValue; index += 1) {
      steps.push(parsedStep);
    }
  }

  return steps;
}

function requirePressAction(options) {
  const hasKey = typeof options.key === "string" && options.key.trim() !== "";
  const hasCombo = typeof options.combo === "string" && options.combo.trim() !== "";
  const hasSequence = typeof options.sequence === "string" && options.sequence.trim() !== "";
  const modeCount = Number(hasKey) + Number(hasCombo) + Number(hasSequence);

  if (modeCount !== 1) {
    throw new CLIError("press requires exactly one of --key, --combo, or --sequence", {
      code: "USAGE_ERROR",
      exitCode: 2,
    });
  }

  const delayMs =
    typeof options.delay === "string" ? toInt(options.delay, "delay") : 40;
  if (delayMs < 0) {
    throw new CLIError("press --delay must be zero or a positive integer", {
      code: "USAGE_ERROR",
      exitCode: 2,
    });
  }

  if (hasSequence) {
    if (typeof options.repeat === "string") {
      throw new CLIError("press --repeat cannot be used with --sequence", {
        code: "USAGE_ERROR",
        exitCode: 2,
      });
    }

    const sequence = parsePressSequenceValue(options.sequence);
    return {
      mode: "sequence",
      sequence,
      repeat: 1,
      delayMs,
      descriptor: options.sequence.trim(),
    };
  }

  const repeat = typeof options.repeat === "string" ? toInt(options.repeat, "repeat") : 1;
  if (repeat < 1) {
    throw new CLIError("press --repeat must be at least 1", {
      code: "USAGE_ERROR",
      exitCode: 2,
    });
  }

  if (hasCombo) {
    const combo = parsePressComboValue(options.combo);
    return {
      mode: "combo",
      combo,
      repeat,
      delayMs,
      descriptor: combo.expression,
    };
  }

  const key = normalizePressKey(requireKeyOption(options));
  return {
    mode: "key",
    key,
    repeat,
    delayMs,
    descriptor: key,
  };
}

async function findSessionOrThrow(sessionSpecifier, app) {
  const snapshot = await getSnapshot({ app });
  return resolveSingleSession(snapshot, sessionSpecifier);
}

function buildDryRunPlan(action, target, extra = {}) {
  const appInfo = getAppMetadata(target.app);
  const capabilities = appInfo?.capabilities ?? null;

  if (action === "send") {
    return {
      app: target.app,
      automation: appInfo?.automation ?? null,
      capability: "send",
      sendWithoutEnter: capabilities?.sendWithoutEnter ?? null,
      description:
        extra.submit === false
          ? "Would send text without submit."
          : "Would send text and submit with enter.",
    };
  }

  if (action === "focus") {
    return {
      app: target.app,
      automation: appInfo?.automation ?? null,
      capability: "focus",
      description: "Would focus the target window and select the resolved tab or session.",
    };
  }

  if (action === "press") {
    return {
      app: target.app,
      automation: appInfo?.automation ?? null,
      capability: "press",
      pressKeys: capabilities?.pressKeys ?? [],
      pressCombos: capabilities?.pressCombos ?? [],
      pressSequence: capabilities?.pressSequence ?? false,
      mode: extra.mode ?? "key",
      key: extra.key ?? null,
      combo: extra.combo ?? null,
      sequence: extra.sequence ?? null,
      repeat: extra.repeat ?? 1,
      delayMs: extra.delayMs ?? null,
      description:
        extra.mode === "combo"
          ? `Would focus the target and press combo ${extra.combo ?? "requested"}.`
          : extra.mode === "sequence"
            ? "Would focus the target and press the requested key sequence."
            : `Would focus the target and press the ${extra.key ?? "requested"} key.`,
    };
  }

  if (action === "close") {
    return {
      app: target.app,
      automation: appInfo?.automation ?? null,
      capability: "close",
      closeScope: capabilities?.closeScope ?? null,
      destructive: true,
      description:
        capabilities?.closeScope === "window"
          ? "Would close the owning window for the resolved target."
          : "Would close the owning tab for the resolved target.",
    };
  }

  return {
    app: target.app,
    automation: appInfo?.automation ?? null,
    description: "Would execute the planned action.",
  };
}

function resolveOpenScope(options) {
  if (options.window === true && options.tab === true) {
    throw new CLIError("open accepts only one of --window or --tab", {
      code: "USAGE_ERROR",
      exitCode: 2,
    });
  }

  return options.tab === true ? "tab" : "window";
}

function assertOpenSupported(app, scope) {
  const appInfo = getAppMetadata(app);
  const supported = canAppOpenScope(app, scope);

  if (supported) {
    return appInfo;
  }

  throw new CLIError(`Open ${scope} is not supported for ${appInfo?.displayName ?? app}`, {
    code: "UNSUPPORTED_ACTION",
    exitCode: 2,
    details: {
      app,
      action: "open",
      requestedScope: scope,
      capabilities: appInfo?.capabilities ?? null,
    },
  });
}

async function resolveOpenApp(options, scope) {
  const requestedApp = normalizeAppOption(options.app);
  if (requestedApp) {
    return requestedApp;
  }

  const frontmostApp = normalizeAppOption((await getFrontmostApp())?.app);
  if (frontmostApp && canAppOpenScope(frontmostApp, scope)) {
    return frontmostApp;
  }

  const fallbackApp = SUPPORTED_APPS.find((appInfo) => canAppOpenScope(appInfo.app, scope))?.app;
  if (fallbackApp) {
    return fallbackApp;
  }

  return frontmostApp ?? SUPPORTED_APP_VALUES[0] ?? null;
}

function buildOpenPlan(app, scope) {
  const appInfo = getAppMetadata(app);
  const capabilities = appInfo?.capabilities ?? null;
  const mayFallbackToWindow = scope === "tab";

  return {
    app,
    automation: appInfo?.automation ?? null,
    capability: scope === "tab" ? "openTab" : "openWindow",
    requestedScope: scope,
    mayFallbackToWindow,
    description:
      scope === "tab"
        ? "Would request a new tab. The backend may create a new window instead if no window is available."
        : "Would request a new terminal window.",
    supports: {
      openWindow: capabilities?.openWindow ?? false,
      openTab: capabilities?.openTab ?? false,
    },
  };
}

function resolveOpenedTargetFromSnapshot(snapshot, app, result) {
  if (result.sessionSpecifier) {
    const matches = filterSessions(snapshot, {
      app,
      sessionId: result.sessionSpecifier,
    });

    if (matches.length === 1) {
      return matches[0];
    }
  }

  const fallbackMatches = filterSessions(snapshot, {
    app,
    windowId: result.windowId,
    tabIndex: result.tabIndex,
  });

  if (fallbackMatches.length === 1) {
    return fallbackMatches[0];
  }

  return null;
}

async function findOpenedTargetWithRetry(app, result) {
  const attempts = 6;
  const delayMs = 150;
  let lastSnapshot = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const snapshot = await getSnapshot({ app });
    lastSnapshot = snapshot;

    const target = resolveOpenedTargetFromSnapshot(snapshot, app, result);
    if (target) {
      return target;
    }

    if (attempt < attempts - 1) {
      await delay(delayMs);
    }
  }

  throw new CLIError("Opened target could not be resolved from the latest snapshot", {
    code: "OPEN_TARGET_NOT_FOUND",
    exitCode: 5,
    details: {
      app,
      requestedScope: result.requestedScope,
      createdScope: result.createdScope,
      windowId: result.windowId,
      tabIndex: result.tabIndex,
      sessionSpecifier: result.sessionSpecifier ?? null,
      counts: lastSnapshot?.counts ?? null,
    },
  });
}

async function handleOpen(options) {
  const scope = resolveOpenScope(options);
  const app = await resolveOpenApp(options, scope);

  if (!app) {
    throw new CLIError(`No supported terminal backends are available on ${CURRENT_PLATFORM}`, {
      code: "UNSUPPORTED_PLATFORM",
      exitCode: 2,
      details: {
        platform: CURRENT_PLATFORM,
        supportedApps: SUPPORTED_APPS.map((provider) => provider.app),
      },
    });
  }

  assertOpenSupported(app, scope);

  if (options.dryRun === true) {
    writeJson(
      {
        ok: true,
        action: "open",
        dryRun: true,
        plan: buildOpenPlan(app, scope),
      },
      options,
    );
    return;
  }

  const result = await openTarget(app, { scope });
  const target = await findOpenedTargetWithRetry(app, result);

  writeJson(
    {
      ok: true,
      action: "open",
      dryRun: false,
      target,
      result,
    },
    options,
  );
}

async function handleList(options) {
  const snapshot = await getSnapshot({
    app: options.app,
  });
  writeJson(snapshot, options);
}

async function handleResolve(options) {
  const snapshot = await getSnapshot({
    app: options.app,
  });
  const criteria = normalizeCriteria(options);

  if (!hasAnyCriteria(criteria)) {
    throw new CLIError("resolve requires at least one selector", {
      code: "USAGE_ERROR",
      exitCode: 2,
    });
  }

  const matches = filterSessions(snapshot, criteria);
  writeJson(
    {
      ok: true,
      criteria,
      count: matches.length,
      matches,
    },
    options,
  );
}

async function handleSend(options) {
  if (options.enter === true) {
    throw new CLIError(
      "send no longer accepts --enter; send submits by default, or pass --no-enter to stage without submit",
      {
        code: "USAGE_ERROR",
        exitCode: 2,
      },
    );
  }

  const app = normalizeAppOption(options.app);
  const sessionId = requireSessionOption(options, "send");
  const usingText = typeof options.text === "string";
  const usingStdin = options.stdin === true;

  if (usingText === usingStdin) {
    throw new CLIError("send requires exactly one of --text or --stdin", {
      code: "USAGE_ERROR",
      exitCode: 2,
    });
  }

  const text = usingText ? options.text : await readStdinText();
  const target = await findSessionOrThrow(sessionId, app);
  const submit = options.enter !== false;

  if (options.dryRun === true) {
    writeJson(
      {
        ok: true,
        action: "send",
        dryRun: true,
        plan: buildDryRunPlan("send", target, { submit }),
        submit,
        bytes: Buffer.byteLength(text, "utf8"),
        target,
        text,
        checkpoint: {
          planned: true,
          mode: "save-before-send",
        },
      },
      options,
    );
    return;
  }

  let checkpoint = {
    saved: false,
    sessionKey: getSessionCheckpointKey(target),
    checkpointPath: getSessionCheckpointPath(target),
    savedAt: null,
    error: null,
  };

  try {
    const baselineText = await captureTarget(target);
    const savedCheckpoint = await saveSessionCheckpoint(target, baselineText);
    checkpoint = {
      saved: true,
      sessionKey: savedCheckpoint.sessionKey,
      checkpointPath: savedCheckpoint.checkpointPath,
      savedAt: savedCheckpoint.savedAt,
      error: null,
    };
  } catch (error) {
    checkpoint = {
      ...checkpoint,
      error: getErrorMessage(error),
    };
  }

  await sendTextToTarget(target, text, { newline: submit });

  writeJson(
    {
      ok: true,
      action: "send",
      dryRun: false,
      submit,
      bytes: Buffer.byteLength(text, "utf8"),
      target,
      text,
      checkpoint,
    },
    options,
  );
}

async function handlePress(options) {
  const app = normalizeAppOption(options.app);
  const sessionId = requireSessionOption(options, "press");
  const press = requirePressAction(options);
  const target = await findSessionOrThrow(sessionId, app);

  if (options.dryRun === true) {
    const key = press.mode === "key" ? press.key : null;
    const combo = press.mode === "combo" ? press.combo.expression : null;
    const sequence =
      press.mode === "sequence" ? press.sequence.map((step) => step.expression) : null;
    writeJson(
      {
        ok: true,
        action: "press",
        dryRun: true,
        plan: buildDryRunPlan("press", target, {
          mode: press.mode,
          key,
          combo,
          sequence,
          repeat: press.repeat,
          delayMs: press.delayMs,
        }),
        mode: press.mode,
        key,
        combo,
        sequence,
        repeat: press.repeat,
        delayMs: press.delayMs,
        target,
      },
      options,
    );
    return;
  }

  const result = await pressKeyOnTarget(target, press);

  writeJson(
    {
      ok: true,
      action: "press",
      dryRun: false,
      mode: press.mode,
      key: press.mode === "key" ? press.key : null,
      combo: press.mode === "combo" ? press.combo.expression : null,
      sequence: press.mode === "sequence" ? press.sequence.map((step) => step.expression) : null,
      repeat: press.repeat,
      delayMs: press.delayMs,
      target,
      result,
    },
    options,
  );
}

async function handleCapture(options) {
  const app = normalizeAppOption(options.app);
  const sessionId = requireSessionOption(options, "capture");
  const target = await findSessionOrThrow(sessionId, app);

  const waitMs = options.wait != null ? toInt(options.wait, "wait") : 0;
  if (waitMs < 0) {
    throw new CLIError("capture --wait must be greater than or equal to 0", {
      code: "USAGE_ERROR",
      exitCode: 2,
    });
  }

  if (waitMs > 0) {
    await delay(waitMs);
  }

  const sinceLastSend = options.sinceLastSend === true;
  let checkpoint = null;
  let text = await captureTarget(target);
  if (sinceLastSend) {
    checkpoint = await readSessionCheckpoint(target);
    if (!checkpoint) {
      throw new CLIError(
        "capture --since-last-send requires a checkpoint from a previous successful send on this session",
        {
          code: "CHECKPOINT_NOT_FOUND",
          exitCode: 3,
          details: {
            session: target.handle ?? target.sessionId,
            hint: "Run termhub send on this same session first.",
          },
        },
      );
    }
    text = computeCaptureDelta(text, checkpoint.baselineText);
  }

  if (options.lines != null) {
    const lineCount = toInt(options.lines, "lines");
    if (lineCount < 0) {
      throw new CLIError("capture --lines must be greater than or equal to 0", {
        code: "USAGE_ERROR",
        exitCode: 2,
      });
    }
    text = lineCount === 0 ? "" : text.split(/\r?\n/).slice(-lineCount).join("\n");
  }

  writeJson(
    {
      ok: true,
      action: "capture",
      target,
      text,
      sinceLastSend,
      waitMs,
      checkpoint: checkpoint
        ? {
            sessionKey: checkpoint.sessionKey,
            checkpointPath: checkpoint.checkpointPath,
            savedAt: checkpoint.savedAt,
          }
        : null,
    },
    options,
  );
}

async function handleFocus(options) {
  const app = normalizeAppOption(options.app);
  const sessionId = requireSessionOption(options, "focus");
  const target = await findSessionOrThrow(sessionId, app);

  if (options.dryRun === true) {
    writeJson(
      {
        ok: true,
        action: "focus",
        dryRun: true,
        plan: buildDryRunPlan("focus", target),
        target,
      },
      options,
    );
    return;
  }

  const result = await focusTarget(target);
  const focusedTarget = await findSessionOrThrow(sessionId, app);

  writeJson(
    {
      ok: true,
      action: "focus",
      dryRun: false,
      target: focusedTarget,
      result,
    },
    options,
  );
}

async function handleClose(options) {
  const app = normalizeAppOption(options.app);
  const sessionId = requireSessionOption(options, "close");
  const target = await findSessionOrThrow(sessionId, app);

  if (options.dryRun === true) {
    writeJson(
      {
        ok: true,
        action: "close",
        dryRun: true,
        plan: buildDryRunPlan("close", target),
        target,
      },
      options,
    );
    return;
  }

  const result = await closeTarget(target);

  writeJson(
    {
      ok: true,
      action: "close",
      dryRun: false,
      target,
      result,
    },
    options,
  );
}

async function handleDoctor(options) {
  const snapshot = await getSnapshot({
    app: options.app,
  });

  const checks = [
    {
      name: "platform",
      ok: SUPPORTED_PLATFORMS.includes(CURRENT_PLATFORM),
      value: CURRENT_PLATFORM,
    },
    {
      name: "supported_apps",
      ok: true,
      value: SUPPORTED_APPS,
    },
    {
      name: "frontmost_app",
      ok: true,
      value: snapshot.frontmostApp,
    },
  ];

  for (const appInfo of snapshot.apps) {
    checks.push({
      name: `app:${appInfo.app}`,
      ok: true,
      value: {
        running: appInfo.running,
        counts: appInfo.counts,
      },
    });
  }

  writeJson(
    {
      ok: checks.every((check) => check.ok),
      checks,
      snapshot: {
        frontmostApp: snapshot.frontmostApp,
        counts: snapshot.counts,
        apps: snapshot.apps,
      },
    },
    options,
  );
}

async function handleSpec(options) {
  writeJson(buildCliSpec(), options);
}

async function main() {
  const parsed = parseArgv(process.argv.slice(2));

  if (parsed.command === "help") {
    process.stdout.write(getHelpText("help"));
    return;
  }

  if (parsed.command === "version") {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }

  assertKnownCommand(parsed.command);

  if (parsed.options.help) {
    process.stdout.write(getHelpText(parsed.command));
    return;
  }

  assertKnownOptions(parsed.command, parsed.options, parsed.positionals);

  switch (parsed.command) {
    case "open":
      await handleOpen(parsed.options);
      return;
    case "list":
      await handleList(parsed.options);
      return;
    case "resolve":
      await handleResolve(parsed.options);
      return;
    case "send":
      await handleSend(parsed.options);
      return;
    case "press":
      await handlePress(parsed.options);
      return;
    case "capture":
      await handleCapture(parsed.options);
      return;
    case "focus":
      await handleFocus(parsed.options);
      return;
    case "close":
      await handleClose(parsed.options);
      return;
    case "doctor":
      await handleDoctor(parsed.options);
      return;
    case "spec":
      await handleSpec(parsed.options);
      return;
    default:
      throw new CLIError(`Unknown command: ${parsed.command}`, {
        code: "UNKNOWN_COMMAND",
        exitCode: 2,
      });
  }
}

main().catch((error) => {
  const payload = toErrorPayload(error);
  writeJson(payload, { compact: false });
  process.exit(error instanceof CLIError ? error.exitCode : 1);
});
