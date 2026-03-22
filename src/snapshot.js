import { CLIError } from "./errors.js";

export const APP_ALIASES = Object.freeze({
  iterm2: "iterm2",
  iterm: "iterm2",
  terminal: "terminal",
  appleterminal: "terminal",
  "apple-terminal": "terminal",
  "apple_terminal": "terminal",
  "windows-terminal": "windows-terminal",
  windows_terminal: "windows-terminal",
  windowsterminal: "windows-terminal",
  wt: "windows-terminal",
  cmd: "cmd",
  "cmd.exe": "cmd",
  cmdexe: "cmd",
  commandprompt: "cmd",
  "command-prompt": "cmd",
  command_prompt: "cmd",
});

export function normalizeAppName(value) {
  if (value == null) {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();
  return APP_ALIASES[normalized] ?? null;
}

export function createProviderSnapshot({
  app,
  displayName,
  bundleId = null,
  capabilities = null,
  running = true,
}) {
  return {
    ok: true,
    app,
    displayName,
    bundleId,
    capabilities,
    running,
    counts: {
      windows: 0,
      tabs: 0,
      sessions: 0,
    },
    windows: [],
  };
}

export function mergeSnapshots(providerSnapshots, { frontmostApp = null } = {}) {
  const merged = {
    ok: true,
    source: "termhub",
    version: 2,
    generatedAt: new Date().toISOString(),
    frontmostApp,
    counts: {
      apps: providerSnapshots.length,
      runningApps: providerSnapshots.filter((snapshot) => snapshot.running).length,
      windows: 0,
      tabs: 0,
      sessions: 0,
    },
    apps: providerSnapshots.map((snapshot) => ({
      app: snapshot.app,
      displayName: snapshot.displayName,
      bundleId: snapshot.bundleId,
      capabilities: snapshot.capabilities,
      running: snapshot.running,
      counts: snapshot.counts,
    })),
    windows: [],
  };

  for (const providerSnapshot of providerSnapshots) {
    merged.counts.windows += providerSnapshot.counts.windows;
    merged.counts.tabs += providerSnapshot.counts.tabs;
    merged.counts.sessions += providerSnapshot.counts.sessions;
    merged.windows.push(...providerSnapshot.windows);
  }

  return merged;
}

export function flattenSessions(snapshot) {
  const matches = [];

  for (const window of snapshot.windows) {
    for (const tab of window.tabs) {
      for (const session of tab.sessions) {
        matches.push({
          app: window.app,
          displayName: window.displayName,
          bundleId: window.bundleId,
          windowId: window.windowId,
          windowIndex: window.windowIndex,
          windowHandle: window.windowHandle,
          isFrontmostWindow: window.isFrontmost,
          tabIndex: tab.tabIndex,
          tabTitle: tab.title,
          isCurrentTab: tab.isCurrent,
          tabHandle: tab.tabHandle,
          sessionIndex: session.sessionIndex,
          sessionId: session.sessionId,
          tty: session.tty,
          name: session.name,
          isCurrentSession: session.isCurrent,
          handle: session.handle,
        });
      }
    }
  }

  return matches;
}

export function filterSessions(snapshot, criteria) {
  const toFoldedText = (value) =>
    value == null ? null : String(value).trim().toLocaleLowerCase();

  const matchesContains = (value, search) => {
    if (!search) {
      return true;
    }

    const foldedValue = toFoldedText(value);
    const foldedSearch = toFoldedText(search);

    if (!foldedValue || !foldedSearch) {
      return false;
    }

    return foldedValue.includes(foldedSearch);
  };

  return flattenSessions(snapshot).filter((session) => {
    if (
      criteria.sessionId &&
      session.sessionId !== criteria.sessionId &&
      session.handle !== criteria.sessionId
    ) {
      return false;
    }

    if (criteria.app && session.app !== criteria.app) {
      return false;
    }

    if (criteria.tty && session.tty !== criteria.tty) {
      return false;
    }

    if (criteria.title && session.tabTitle !== criteria.title) {
      return false;
    }

    if (!matchesContains(session.tabTitle, criteria.titleContains)) {
      return false;
    }

    if (criteria.name && session.name !== criteria.name) {
      return false;
    }

    if (!matchesContains(session.name, criteria.nameContains)) {
      return false;
    }

    if (criteria.windowId && session.windowId !== criteria.windowId) {
      return false;
    }

    if (criteria.windowIndex && session.windowIndex !== criteria.windowIndex) {
      return false;
    }

    if (criteria.tabIndex && session.tabIndex !== criteria.tabIndex) {
      return false;
    }

    if (criteria.currentWindow && !session.isFrontmostWindow) {
      return false;
    }

    if (criteria.currentTab && !session.isCurrentTab) {
      return false;
    }

    if (criteria.currentSession && !session.isCurrentSession) {
      return false;
    }

    return true;
  });
}

export function resolveSingleSession(snapshot, sessionSpecifier) {
  const matches = filterSessions(snapshot, {
    sessionId: sessionSpecifier,
  });

  if (matches.length === 0) {
    throw new CLIError("Session not found", {
      code: "SESSION_NOT_FOUND",
      exitCode: 3,
      details: {
        session: sessionSpecifier,
      },
    });
  }

  if (matches.length > 1) {
    throw new CLIError("Session selector is ambiguous", {
      code: "SESSION_AMBIGUOUS",
      exitCode: 4,
      details: {
        session: sessionSpecifier,
        matches,
      },
    });
  }

  return matches[0];
}
