#!/usr/bin/env node

import { readFileSync } from "node:fs";

import { CLIError, toErrorPayload } from "./errors.js";
import {
  CURRENT_PLATFORM,
  SUPPORTED_APPS,
  SUPPORTED_PLATFORMS,
  captureTarget,
  closeTarget,
  focusTarget,
  getSnapshot,
  normalizeAppOption,
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

function hasSupportedApp(app) {
  return SUPPORTED_APP_VALUES.includes(app);
}

function buildSupportedAppsSpec() {
  return SUPPORTED_APPS.map((app) => ({
    app: app.app,
    displayName: app.displayName,
    platform: app.platform ?? CURRENT_PLATFORM,
    automation: app.automation ?? null,
    bundleId: app.bundleId ?? null,
    processNames: app.processNames ?? [],
  }));
}

function buildSendRules() {
  const rules = ["Exactly one of --text or --stdin is required."];

  if (hasSupportedApp("terminal")) {
    rules.push("Terminal rejects --no-enter.");
  }

  if (hasSupportedApp("windows-terminal") || hasSupportedApp("cmd")) {
    rules.push("Windows backends send input by focusing the target and using keyboard automation.");
  }

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

  if (hasSupportedApp("windows-terminal") || hasSupportedApp("cmd")) {
    notes.push("Windows capture is best-effort and only reads text that UI Automation can see in the currently visible window.");
  }

  return notes;
}

function buildCliSpec() {
  return {
    ok: true,
    source: "termhub",
    specVersion: 1,
    cli: {
      name: "termhub",
      aliases: ["thub"],
      version: PACKAGE_VERSION,
    },
    purpose:
      "AI-native terminal control CLI for macOS and Windows. It discovers, resolves, focuses, captures, sends to, and closes terminal windows and tabs through AppleScript or PowerShell/UI Automation depending on the backend.",
    platform: CURRENT_PLATFORM,
    supportedPlatforms: SUPPORTED_PLATFORMS,
    supportedApps: buildSupportedAppsSpec(),
    recommendedWorkflow: [
      "Use list when the user asks what is open right now.",
      "Use resolve when the user identifies a target by title, tty, current tab, window id, or handle.",
      "Only call send, capture, focus, or close after you have exactly one target.",
      "If resolve returns count 0 or count greater than 1, refine selectors instead of guessing.",
      "Use doctor when app availability, automation permission, or frontmost state are unclear.",
      "Use spec or command --help when the AI needs exact flag names or JSON output fields.",
    ],
    conventions: {
      transport: "stdout JSON",
      selectors: "All resolve selectors are ANDed together.",
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
          { name: "--name", type: "string", required: false, description: "Match an exact session name." },
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
          "termhub send --session <id|handle> (--text <text> | --stdin) [--app <app>] [--no-enter]",
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
              "Do not append enter. Apple Terminal rejects this option; iTerm2 and Windows backends accept it.",
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
          topLevelFields: ["ok", "action", "newline", "bytes", "target", "text"],
          targetFields: MATCH_FIELDS,
        },
      },
      capture: {
        usage: "termhub capture --session <id|handle> [--app <app>] [--lines <n>]",
        purpose: "Read the current visible terminal contents from one resolved target.",
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
            name: "--compact",
            type: "boolean",
            required: false,
            description: "Print JSON without indentation.",
          },
        ],
        output: {
          topLevelFields: ["ok", "action", "target", "text"],
          targetFields: MATCH_FIELDS,
        },
        notes: buildCaptureNotes(),
      },
      focus: {
        usage: "termhub focus --session <id|handle> [--app <app>]",
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
        ],
        output: {
          topLevelFields: ["ok", "action", "target", "result"],
          targetFields: MATCH_FIELDS,
        },
      },
      close: {
        usage: "termhub close --session <id|handle> [--app <app>]",
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
        ],
        notes: buildCloseNotes(),
        output: {
          topLevelFields: ["ok", "action", "target", "result"],
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

  notes.push("close targets the owning tab or window of the resolved session.");

  if (hasSupportedApp("iterm2")) {
    notes.push("iTerm2 supports send with or without enter.");
  }

  if (hasSupportedApp("terminal")) {
    notes.push("Terminal supports send with enter only; --no-enter is rejected.");
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
  if (hasSupportedApp("windows-terminal")) {
    return {
      listApp: "windows-terminal",
      resolve: "termhub resolve --app windows-terminal --title Task1",
      send: "termhub send --session windows-terminal:session:<windowHandle>:1 --text 'npm test' --no-enter",
      capture: "termhub capture --session windows-terminal:session:<windowHandle>:1 --lines 30",
      focus: "termhub focus --session windows-terminal:session:<windowHandle>:1",
      close: "termhub close --session windows-terminal:session:<windowHandle>:1",
      stdin:
        "Get-Content .\\commands.txt | termhub send --session cmd:session:<pid> --stdin --app cmd",
      doctorApp: hasSupportedApp("cmd") ? "cmd" : "windows-terminal",
    };
  }

  return {
    listApp: hasSupportedApp("terminal") ? "terminal" : SUPPORTED_APP_VALUES[0] ?? "<app>",
    resolve: hasSupportedApp("iterm2")
      ? "termhub resolve --app iterm2 --title Task1"
      : "termhub resolve --title Task1",
    send: hasSupportedApp("iterm2")
      ? "termhub send --session iterm2:session:<uuid> --text 'npm test'"
      : "termhub send --session <id|handle> --text 'npm test'",
    capture: hasSupportedApp("terminal")
      ? "termhub capture --session terminal:session:545305:1 --lines 30"
      : "termhub capture --session iterm2:session:<uuid> --lines 30",
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
Use it when an AI needs to inspect, resolve, focus, capture, send to, or close terminal tabs.

Current platform:
  ${CURRENT_PLATFORM}

Recommended AI workflow:
  1. termhub list
  2. termhub resolve ...
  3. termhub send | capture | focus | close ...
  4. termhub doctor when app state or permissions are unclear
  5. termhub spec for the machine-readable command and JSON contract

Usage:
  termhub --version
  termhub list [--app <app>] [--compact]
  termhub resolve [selectors] [--compact]
  termhub send --session <id|handle> (--text <text> | --stdin) [--app <app>] [--no-enter]
  termhub capture --session <id|handle> [--app <app>] [--lines <n>]
  termhub focus --session <id|handle> [--app <app>]
  termhub close --session <id|handle> [--app <app>]
  termhub doctor [--app <app>] [--compact]
  termhub spec [--compact]
  termhub <command> --help

Command roles:
  list     Discover open apps, windows, tabs, sessions, titles, TTYs, and handles.
  resolve  Narrow a user-described target to exact session matches.
  send     Send text or stdin into one resolved target.
  capture  Read the current visible contents from one resolved target.
  focus    Bring the owning window and tab to the front.
  close    Close the owning tab or window for one resolved target.
  doctor   Diagnose platform, running apps, and automation readiness.
  spec     Print machine-readable command, option, and output schema data.

Selectors for resolve:
  --app <app>             Restrict search to one backend.
  --session <id|handle>   Match a session id or namespaced handle.
  --tty <tty>             Match a tty, for example /dev/ttys055.
  --title <tab-title>     Match tab title.
  --name <session-name>   Match session name.
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
  termhub spec
  termhub list
  termhub list --app ${examples.listApp}
  ${examples.resolve}
  ${examples.send}
  ${examples.stdin}
  ${examples.capture}
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

  return {
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
  --name <session-name>
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
  ${examples.resolve}
  termhub resolve --app ${examples.listApp} --current-window --current-tab --current-session

Hint:
  Use the returned handle or sessionId as the next command's --session value.
`,
    send: `termhub send

Usage:
  termhub send --session <id|handle> (--text <text> | --stdin) [--app <app>] [--no-enter]

Description:
  Send text to one resolved session target.
  Usually call resolve first, then pass the exact handle or sessionId.
  --text sends one string argument.
  --stdin reads the full stdin stream and sends it as one payload.
  Apple Terminal rejects --no-enter. Other current backends accept it.

Output:
  JSON object with:
    ok, action, newline, bytes, target, text

Examples:
  ${examples.send}
  termhub send --session <id|handle> --text 'echo hello'
  ${examples.stdin}
`,
    capture: `termhub capture

Usage:
  termhub capture --session <id|handle> [--app <app>] [--lines <n>]

Description:
  Capture the current visible terminal contents for one resolved target.
  --lines trims the result to the last N lines after capture.
${captureNotes.length > 0 ? `\nNotes:\n${formatBulletLines(captureNotes)}` : ""}

Output:
  JSON object with:
    ok, action, target, text

Examples:
  ${examples.capture}
  termhub capture --session <id|handle> --lines 40
`,
    focus: `termhub focus

Usage:
  termhub focus --session <id|handle> [--app <app>]

Description:
  Bring the owning window to the front and select the target tab or session.

Output:
  JSON object with:
    ok, action, target, result

Examples:
  ${examples.focus}
  termhub focus --session <id|handle>
`,
    close: `termhub close

Usage:
  termhub close --session <id|handle> [--app <app>]

Description:
  Close the owning tab or window for one resolved target.
  Use this when the user asks the AI to close a specific tab.
${closeNotes.length > 0 ? `\nNotes:\n${formatBulletLines(closeNotes)}` : ""}

Output:
  JSON object with:
    ok, action, target, result

Examples:
  ${examples.close}
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
  list: new Set(["app"]),
  resolve: new Set([
    "app",
    "session",
    "tty",
    "title",
    "name",
    "windowId",
    "windowIndex",
    "tabIndex",
    "currentWindow",
    "currentTab",
    "currentSession",
  ]),
  send: new Set(["app", "session", "text", "stdin", "enter"]),
  focus: new Set(["app", "session"]),
  close: new Set(["app", "session"]),
  capture: new Set(["app", "session", "lines"]),
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

  if (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version") {
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

function normalizeCriteria(options) {
  return {
    app: normalizeAppOption(options.app),
    sessionId: typeof options.session === "string" ? options.session : null,
    tty: typeof options.tty === "string" ? options.tty : null,
    title: typeof options.title === "string" ? options.title : null,
    name: typeof options.name === "string" ? options.name : null,
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

async function findSessionOrThrow(sessionSpecifier, app) {
  const snapshot = await getSnapshot({ app });
  return resolveSingleSession(snapshot, sessionSpecifier);
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
  const newline = options.enter !== false;

  await sendTextToTarget(target, text, { newline });

  writeJson(
    {
      ok: true,
      action: "send",
      newline,
      bytes: Buffer.byteLength(text, "utf8"),
      target,
      text,
    },
    options,
  );
}

async function handleCapture(options) {
  const app = normalizeAppOption(options.app);
  const sessionId = requireSessionOption(options, "capture");
  const target = await findSessionOrThrow(sessionId, app);

  let text = await captureTarget(target);
  if (typeof options.lines === "string") {
    const lineCount = toInt(options.lines, "lines");
    text = text.split(/\r?\n/).slice(-lineCount).join("\n");
  }

  writeJson(
    {
      ok: true,
      action: "capture",
      target,
      text,
    },
    options,
  );
}

async function handleFocus(options) {
  const app = normalizeAppOption(options.app);
  const sessionId = requireSessionOption(options, "focus");
  const target = await findSessionOrThrow(sessionId, app);
  const result = await focusTarget(target);
  const focusedTarget = await findSessionOrThrow(sessionId, app);

  writeJson(
    {
      ok: true,
      action: "focus",
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
  const result = await closeTarget(target);

  writeJson(
    {
      ok: true,
      action: "close",
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
    case "list":
      await handleList(parsed.options);
      return;
    case "resolve":
      await handleResolve(parsed.options);
      return;
    case "send":
      await handleSend(parsed.options);
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
