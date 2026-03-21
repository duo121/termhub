import test from "node:test";
import assert from "node:assert/strict";

import { parseSnapshot as parseCmdSnapshot } from "../src/cmd.js";
import { normalizeAppName } from "../src/snapshot.js";
import { parseSnapshot as parseWindowsTerminalSnapshot } from "../src/windows-terminal.js";

const WINDOWS_TERMINAL_SAMPLE = {
  windows: [
    {
      windowId: 197622,
      windowIndex: 1,
      isFrontmost: true,
      tabs: [
        {
          tabIndex: 1,
          isCurrent: true,
          title: "Task1",
        },
        {
          tabIndex: 2,
          isCurrent: false,
          title: "Logs",
        },
      ],
    },
  ],
};

const CMD_SAMPLE = {
  windows: [
    {
      windowId: 550122,
      windowIndex: 1,
      isFrontmost: true,
      sessionId: "9012",
      title: "Admin: build",
    },
  ],
};

test("Windows Terminal parser builds synthetic tab and session handles", () => {
  const snapshot = parseWindowsTerminalSnapshot(WINDOWS_TERMINAL_SAMPLE);

  assert.equal(snapshot.app, "windows-terminal");
  assert.equal(snapshot.counts.windows, 1);
  assert.equal(snapshot.counts.tabs, 2);
  assert.equal(snapshot.counts.sessions, 2);
  assert.equal(snapshot.windows[0].windowHandle, "windows-terminal:window:197622");
  assert.equal(snapshot.windows[0].tabs[0].tabHandle, "windows-terminal:tab:197622:1");
  assert.equal(
    snapshot.windows[0].tabs[0].sessions[0].handle,
    "windows-terminal:session:197622:1",
  );
  assert.equal(snapshot.windows[0].tabs[0].sessions[0].sessionId, "197622:1");
});

test("Command Prompt parser models one tab and one session per window", () => {
  const snapshot = parseCmdSnapshot(CMD_SAMPLE);

  assert.equal(snapshot.app, "cmd");
  assert.equal(snapshot.counts.windows, 1);
  assert.equal(snapshot.counts.tabs, 1);
  assert.equal(snapshot.counts.sessions, 1);
  assert.equal(snapshot.windows[0].windowHandle, "cmd:window:550122");
  assert.equal(snapshot.windows[0].tabs[0].title, "Admin: build");
  assert.equal(snapshot.windows[0].tabs[0].sessions[0].handle, "cmd:session:9012");
});

test("app aliases normalize Windows backend names", () => {
  assert.equal(normalizeAppName("wt"), "windows-terminal");
  assert.equal(normalizeAppName("windows_terminal"), "windows-terminal");
  assert.equal(normalizeAppName("cmd.exe"), "cmd");
  assert.equal(normalizeAppName("command-prompt"), "cmd");
});
