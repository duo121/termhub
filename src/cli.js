#!/usr/bin/env node

import { CLIError, toErrorPayload } from "./errors.js";
import {
  SUPPORTED_APPS,
  captureTarget,
  focusTarget,
  getSnapshot,
  normalizeAppOption,
  sendTextToTarget,
} from "./apps.js";
import { filterSessions, resolveSingleSession } from "./snapshot.js";

const ROOT_HELP = `termhub (alias: thub)

AI-oriented terminal control CLI for macOS.
Supports:
  - iTerm2          (--app iterm2)
  - Apple Terminal  (--app terminal)

Usage:
  termhub list [--app <app>] [--compact]
  termhub resolve [selectors] [--compact]
  termhub send --session <id|handle> (--text <text> | --stdin) [--app <app>] [--no-enter]
  termhub capture --session <id|handle> [--app <app>] [--lines <n>]
  termhub focus --session <id|handle> [--app <app>]
  termhub doctor [--app <app>] [--compact]
  termhub <command> --help

Selectors for resolve:
  --app <app>             Restrict search to one backend.
  --session <id|handle>   Match native session id or namespaced handle.
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
  - iTerm2 sessionId is the native UUID reported by iTerm2.
  - Terminal sessionId is the tab tty, for example /dev/ttys058.
  - Every session also has a namespaced handle such as:
      iterm2:session:<uuid>
      terminal:session:<windowId>:<tabIndex>
  - --session accepts either form.

Output model:
  - list returns:
      frontmostApp
      apps[]
      windows[].tabs[].sessions[]
  - resolve returns:
      count
      matches[]
  - matches include:
      app, sessionId, handle, tty, name, windowId, tabIndex, sessionIndex

Backend notes:
  - When both iTerm2 and Terminal are running, add --app for precise current-* queries.
  - iTerm2 supports send with or without enter.
  - Terminal supports send with enter only; --no-enter is rejected.

Examples:
  termhub list
  termhub list --app terminal
  termhub resolve --app iterm2 --title codex
  termhub send --session iterm2:session:ABC-123 --text 'npm test'
  printf 'echo one\\necho two\\n' | termhub send --session /dev/ttys058 --stdin --app terminal
  termhub capture --session terminal:session:545305:1 --lines 30
  termhub focus --session 44F0F7F2-7777-4D75-A0F0-7C7CE0974EEB

Supported app values:
  ${SUPPORTED_APPS.map((app) => app.app).join(", ")}
`;

const COMMAND_HELP = {
  list: `termhub list

Usage:
  termhub list [--app <app>] [--compact]

Description:
  Enumerate windows, tabs, sessions, titles, handles, and app metadata.
  By default, includes all supported backends that are currently running.

Examples:
  termhub list
  termhub list --app iterm2
  termhub list --app terminal --compact
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
  Return a flat matches[] array for sessions that satisfy all selectors.
  current-* selectors are app-local when multiple backends are running.

Examples:
  termhub resolve --title codex
  termhub resolve --app terminal --tty /dev/ttys058
  termhub resolve --app iterm2 --current-window --current-tab --current-session
`,
  send: `termhub send

Usage:
  termhub send --session <id|handle> (--text <text> | --stdin) [--app <app>] [--no-enter]

Description:
  Send text to a resolved session target.
  --text sends one string argument.
  --stdin reads the full stdin stream and sends it as one payload.
  --no-enter is supported by iTerm2 only.

Examples:
  termhub send --session iterm2:session:<uuid> --text 'npm test'
  termhub send --session /dev/ttys058 --app terminal --text 'echo hello'
  printf 'echo one\\necho two\\n' | termhub send --session /dev/ttys058 --app terminal --stdin
`,
  capture: `termhub capture

Usage:
  termhub capture --session <id|handle> [--app <app>] [--lines <n>]

Description:
  Capture the current visible buffer for a session.
  --lines trims the result to the last N lines after capture.

Examples:
  termhub capture --session iterm2:session:<uuid>
  termhub capture --session terminal:session:545305:1 --lines 40
`,
  focus: `termhub focus

Usage:
  termhub focus --session <id|handle> [--app <app>]

Description:
  Bring the owning window to the front and select the target tab/session.

Examples:
  termhub focus --session iterm2:session:<uuid>
  termhub focus --session terminal:session:545305:1
`,
  doctor: `termhub doctor

Usage:
  termhub doctor [--app <app>] [--compact]

Description:
  Report platform, supported backends, running status, current frontmost app,
  and window/tab/session counts for each inspected backend.

Examples:
  termhub doctor
  termhub doctor --app terminal --compact
`,
};

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
  capture: new Set(["app", "session", "lines"]),
  doctor: new Set(["app"]),
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
  if (!command || command === "help") {
    return ROOT_HELP;
  }

  return COMMAND_HELP[command] ?? ROOT_HELP;
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

async function handleDoctor(options) {
  const snapshot = await getSnapshot({
    app: options.app,
  });

  const checks = [
    {
      name: "platform",
      ok: process.platform === "darwin",
      value: process.platform,
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

async function main() {
  const parsed = parseArgv(process.argv.slice(2));

  if (parsed.command === "help") {
    process.stdout.write(getHelpText("help"));
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
    case "doctor":
      await handleDoctor(parsed.options);
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
