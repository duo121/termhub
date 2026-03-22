import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const CLI_PATH = new URL("../src/cli.js", import.meta.url);

function runCli(args) {
  return execFileSync(process.execPath, [CLI_PATH.pathname, ...args], {
    encoding: "utf8",
  });
}

test("root help advertises AI workflow, close, and spec", () => {
  const help = runCli(["--help"]);

  assert.match(help, /Recommended AI workflow:/);
  assert.match(help, /macOS and Windows/);
  assert.match(help, /termhub --version/);
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
  assert.equal(payload.commands.close.usage, "termhub close --session <id|handle> [--app <app>]");
  assert.equal(payload.commands.resolve.output.matchFields.includes("handle"), true);
  assert.equal(payload.commands.send.rules.includes("Exactly one of --text or --stdin is required."), true);
});

test("close help explains terminal-specific behavior", () => {
  const help = runCli(["close", "--help"]);

  assert.match(help, /Terminal closes the selected tab with the app's standard close shortcut/);
  assert.match(help, /Busy Terminal tabs may still trigger the app's own confirmation dialog/);
});

test("version flag prints the package version as plain text", () => {
  const version = runCli(["--version"]).trim();

  assert.match(version, /^\d+\.\d+\.\d+$/);
});
