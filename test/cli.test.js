import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function runCli(args) {
  return execFileSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
  });
}

test("root help advertises AI workflow, open, close, and spec", () => {
  const help = runCli(["--help"]);

  assert.match(help, /Recommended AI workflow:/);
  assert.match(help, /macOS and Windows/);
  assert.match(help, /termhub --version \| -v \| -V/);
  assert.match(help, /termhub open \[--app <app>\] \[--window \| --tab\] \[--dry-run\] \[--compact\]/);
  assert.match(help, /open\s+Open a new terminal window or tab in one backend\./);
  assert.match(
    help,
    /termhub press --session <id\|handle> \(\--key <key> \| --combo <combo> \| --sequence <steps>\) \[--repeat <n>\] \[--delay <ms>\] \[--app <app>\] \[--dry-run\]/,
  );
  assert.match(help, /press\s+Press a real key on one resolved target after focusing it\./);
  assert.match(help, /--title-contains <txt>/);
  assert.match(help, /--dry-run/);
  assert.match(help, /termhub close --session <id\|handle> \[--app <app>\]/);
  assert.match(help, /termhub spec \[--compact\]/);
});

test("spec command returns machine-readable command contract", () => {
  const payload = JSON.parse(runCli(["spec", "--compact"]));

  assert.equal(payload.ok, true);
  assert.equal(payload.cli.name, "termhub");
  assert.deepEqual(payload.cli.aliases, ["thub"]);
  assert.match(payload.cli.version, /^\d+\.\d+\.\d+$/);
  assert.equal(payload.platform, process.platform);
  assert.equal(payload.supportedPlatforms.includes("win32"), true);
  assert.equal(payload.supportedApps[0].capabilities.send, true);
  assert.equal(payload.supportedApps[0].capabilities.press, true);
  assert.equal(payload.supportedApps[0].capabilities.pressKeys.includes("enter"), true);
  assert.equal(Array.isArray(payload.supportedApps[0].capabilities.pressCombos), true);
  assert.equal(payload.supportedApps[0].capabilities.pressSequence, true);
  assert.equal(payload.supportedApps[0].capabilities.dryRun.includes("press"), true);
  assert.equal(typeof payload.supportedApps[0].capabilities.openWindow, "boolean");
  assert.equal(typeof payload.supportedApps[0].capabilities.openTab, "boolean");
  assert.equal(
    payload.recommendedWorkflow.includes(
      "Use open when the user asks the AI to create a new terminal window or tab.",
    ),
    true,
  );
  assert.equal(
    payload.commands.open.usage,
    "termhub open [--app <app>] [--window | --tab] [--dry-run] [--compact]",
  );
  assert.equal(
    payload.commands.open.options.some((option) => option.name === "--tab"),
    true,
  );
  assert.equal(
    payload.commands.resolve.options.some((option) => option.name === "--title-contains"),
    true,
  );
  assert.equal(
    payload.commands.send.options.some((option) => option.name === "--dry-run"),
    true,
  );
  assert.equal(
    payload.commands.send.options.some((option) => option.name === "--no-enter"),
    true,
  );
  assert.equal(
    payload.commands.send.rules.includes(
      "Do not append literal newline characters inside --text or --stdin to simulate submit.",
    ),
    true,
  );
  assert.equal(
    payload.commands.press.usage,
    "termhub press --session <id|handle> (--key <key> | --combo <combo> | --sequence <steps>) [--repeat <n>] [--delay <ms>] [--app <app>] [--dry-run]",
  );
  assert.equal(
    payload.commands.press.rules.includes("Exactly one of --key, --combo, or --sequence is required."),
    true,
  );
  assert.equal(
    payload.commands.press.options.some((option) => option.name === "--combo"),
    true,
  );
  assert.equal(
    payload.commands.press.options.some((option) => option.name === "--sequence"),
    true,
  );
  assert.equal(
    payload.commands.press.options.some((option) => option.name === "--delay"),
    true,
  );
  assert.equal(
    payload.commands.close.usage,
    "termhub close --session <id|handle> [--app <app>] [--dry-run]",
  );
  assert.equal(payload.commands.resolve.output.matchFields.includes("handle"), true);
  assert.equal(payload.commands.send.rules.includes("Exactly one of --text or --stdin is required."), true);
});

test("close help explains terminal-specific behavior", () => {
  const help = runCli(["close", "--help"]);

  if (process.platform === "darwin") {
    assert.match(help, /Terminal closes the selected tab with the app's standard close shortcut/);
    assert.match(help, /Busy Terminal tabs may still trigger the app's own confirmation dialog/);
    return;
  }

  assert.match(help, /Windows Terminal closes the selected tab with its standard Ctrl\+Shift\+W shortcut/);
  assert.match(help, /Command Prompt closes the target window through CloseMainWindow/);
});

test("open help explains scope selection and dry-run", () => {
  const help = runCli(["open", "--help"]);

  assert.match(help, /termhub open \[--app <app>\] \[--window \| --tab\] \[--dry-run\] \[--compact\]/);
  assert.match(help, /Open a new terminal window or tab in one backend\./);
  assert.match(help, /--window is the default if neither --window nor --tab is passed\./);
  assert.match(help, /--dry-run resolves the backend and scope and prints the planned open without executing it\./);
});

test("press help explains real keypress workflow", () => {
  const help = runCli(["press", "--help"]);

  assert.match(
    help,
    /termhub press --session <id\|handle> \(\--key <key> \| --combo <combo> \| --sequence <steps>\) \[--repeat <n>\] \[--delay <ms>\] \[--app <app>\] \[--dry-run\]/,
  );
  assert.match(help, /Press a real key on one resolved target after focusing its owning window and tab\./);
  assert.match(help, /--combo sends one key chord/);
  assert.match(help, /--sequence sends comma-separated steps/);
  assert.match(help, /interactive TUIs/);
  assert.match(help, /--combo (ctrl\+c|cmd\+k)/);
});

test("send help explains explicit enter and staged send modes", () => {
  const help = runCli(["send", "--help"]);

  assert.match(help, /\[--no-enter\]/);
  assert.match(help, /send appends enter by default/);
  assert.match(help, /--no-enter stages the payload without submit/);
  assert.match(help, /Do not append literal newline characters inside --text or stdin to simulate submit/);
});

test("send rejects deprecated explicit enter flag", () => {
  assert.throws(
    () => runCli(["send", "--enter"]),
    (error) =>
      error &&
      typeof error.stdout === "string" &&
      /send no longer accepts --enter; send submits by default, or pass --no-enter to stage without submit/.test(
        error.stdout,
      ),
  );
});

test("press requires exactly one key mode", () => {
  assert.throws(
    () => runCli(["press", "--session", "x"]),
    (error) =>
      error &&
      typeof error.stdout === "string" &&
      /press requires exactly one of --key, --combo, or --sequence/.test(error.stdout),
  );
});

test("press rejects repeat with sequence", () => {
  assert.throws(
    () => runCli(["press", "--session", "x", "--sequence", "esc,enter", "--repeat", "2"]),
    (error) =>
      error &&
      typeof error.stdout === "string" &&
      /press --repeat cannot be used with --sequence/.test(error.stdout),
  );
});

test("version flag prints the package version as plain text", () => {
  const version = runCli(["--version"]).trim();

  assert.match(version, /^\d+\.\d+\.\d+$/);
});

test("capital version flag prints the package version as plain text", () => {
  const version = runCli(["-V"]).trim();

  assert.match(version, /^\d+\.\d+\.\d+$/);
});
