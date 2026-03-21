import test from "node:test";
import assert from "node:assert/strict";

import { parseSnapshot as parseItermSnapshot } from "../src/iterm2.js";
import { filterSessions, flattenSessions, mergeSnapshots } from "../src/snapshot.js";
import { parseSnapshot as parseTerminalSnapshot } from "../src/terminal.js";

const SEP = String.fromCharCode(31);
const ITERM_SAMPLE = [
  ["W", "543005", "1", "1", "session-a"].join(SEP),
  ["T", "2", "1", "session-a", "codex"].join(SEP),
  ["S", "1", "1", "session-a", "/dev/ttys055", "zsh"].join(SEP),
  ["S", "2", "0", "session-b", "/dev/ttys056", "npm test"].join(SEP),
  ["T", "3", "0", "session-c", "logs"].join(SEP),
  ["S", "1", "1", "session-c", "/dev/ttys057", "tail -f"].join(SEP),
].join("\n");

const TERMINAL_SAMPLE = [
  ["W", "545305", "1", "1", "/dev/ttys058"].join(SEP),
  ["T", "1", "1", "/dev/ttys058", "终端"].join(SEP),
  ["S", "1", "1", "/dev/ttys058", "/dev/ttys058", "-zsh"].join(SEP),
].join("\n");

test("iTerm2 parser builds nested window/tab/session structure", () => {
  const snapshot = parseItermSnapshot(ITERM_SAMPLE);

  assert.equal(snapshot.app, "iterm2");
  assert.equal(snapshot.counts.windows, 1);
  assert.equal(snapshot.counts.tabs, 2);
  assert.equal(snapshot.counts.sessions, 3);
  assert.equal(snapshot.windows[0].windowHandle, "iterm2:window:543005");
  assert.equal(snapshot.windows[0].tabs[0].tabHandle, "iterm2:tab:543005:2");
  assert.equal(snapshot.windows[0].tabs[0].sessions[0].handle, "iterm2:session:session-a");
});

test("flattenSessions returns provider-aware records", () => {
  const snapshot = parseItermSnapshot(ITERM_SAMPLE);
  const sessions = flattenSessions(snapshot);

  assert.equal(sessions.length, 3);
  assert.deepEqual(sessions[0], {
    app: "iterm2",
    displayName: "iTerm2",
    bundleId: "com.googlecode.iterm2",
    windowId: 543005,
    windowIndex: 1,
    windowHandle: "iterm2:window:543005",
    isFrontmostWindow: true,
    tabIndex: 2,
    tabTitle: "codex",
    isCurrentTab: true,
    tabHandle: "iterm2:tab:543005:2",
    sessionIndex: 1,
    sessionId: "session-a",
    tty: "/dev/ttys055",
    name: "zsh",
    isCurrentSession: true,
    handle: "iterm2:session:session-a",
  });
});

test("filterSessions supports multiple selectors", () => {
  const snapshot = parseItermSnapshot(ITERM_SAMPLE);

  const byTitle = filterSessions(snapshot, {
    title: "codex",
  });
  assert.equal(byTitle.length, 2);

  const currentOnly = filterSessions(snapshot, {
    currentTab: true,
    currentSession: true,
  });
  assert.equal(currentOnly.length, 1);
  assert.equal(currentOnly[0].sessionId, "session-a");

  const byExactSession = filterSessions(snapshot, {
    sessionId: "session-c",
    windowId: 543005,
    tabIndex: 3,
  });
  assert.equal(byExactSession.length, 1);
});

test("Terminal parser builds terminal-specific handles", () => {
  const snapshot = parseTerminalSnapshot(TERMINAL_SAMPLE);

  assert.equal(snapshot.app, "terminal");
  assert.equal(snapshot.counts.windows, 1);
  assert.equal(snapshot.counts.tabs, 1);
  assert.equal(snapshot.counts.sessions, 1);
  assert.equal(snapshot.windows[0].windowHandle, "terminal:window:545305");
  assert.equal(snapshot.windows[0].tabs[0].tabHandle, "terminal:tab:545305:1");
  assert.equal(snapshot.windows[0].tabs[0].sessions[0].handle, "terminal:session:545305:1");
});

test("filterSessions can match namespaced handles across providers", () => {
  const aggregate = mergeSnapshots([
    parseItermSnapshot(ITERM_SAMPLE),
    parseTerminalSnapshot(TERMINAL_SAMPLE),
  ]);

  const matches = filterSessions(aggregate, {
    app: "terminal",
    sessionId: "terminal:session:545305:1",
  });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].app, "terminal");
  assert.equal(matches[0].sessionId, "/dev/ttys058");
});
