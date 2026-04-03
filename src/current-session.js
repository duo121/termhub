import { execFileSync } from "node:child_process";

import { CURRENT_PLATFORM, getSnapshot, normalizeAppOption } from "./apps.js";
import { filterSessions } from "./snapshot.js";

function getErrorMessage(error) {
  if (error instanceof Error && typeof error.message === "string") {
    return error.message;
  }

  return String(error);
}

function getCurrentTtyPath() {
  if (CURRENT_PLATFORM !== "darwin") {
    return null;
  }

  try {
    const tty = execFileSync("tty", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (!tty || tty === "not a tty") {
      return null;
    }

    return tty;
  } catch {
    return null;
  }
}

function buildCurrentSessionContextFromTarget(target, method, tty) {
  return {
    ok: true,
    method,
    app: target.app,
    session: target.handle ?? target.sessionId,
    sessionId: target.sessionId,
    handle: target.handle ?? null,
    tty: tty ?? target.tty ?? null,
    target,
  };
}

function buildCurrentSessionUnavailableContext(reason, tty) {
  return {
    ok: false,
    reason,
    tty: tty ?? null,
    session: null,
    sessionId: null,
    handle: null,
    app: null,
    method: null,
    target: null,
  };
}

export async function resolveCurrentSessionContext() {
  const tty = getCurrentTtyPath();

  try {
    const snapshot = await getSnapshot();
    const frontmostApp = normalizeAppOption(snapshot.frontmostApp?.app);

    if (tty) {
      const ttyMatches = filterSessions(snapshot, { tty });
      if (ttyMatches.length === 1) {
        return buildCurrentSessionContextFromTarget(ttyMatches[0], "tty", tty);
      }
    }

    const currentCriteria = {
      currentWindow: true,
      currentTab: true,
      currentSession: true,
      app: frontmostApp,
    };
    let currentMatches = filterSessions(snapshot, currentCriteria);

    if (currentMatches.length === 0 && frontmostApp) {
      currentMatches = filterSessions(snapshot, {
        currentWindow: true,
        currentTab: true,
        currentSession: true,
      });
    }

    if (currentMatches.length === 1) {
      return buildCurrentSessionContextFromTarget(
        currentMatches[0],
        frontmostApp ? "frontmost-current" : "current",
        tty,
      );
    }

    if (currentMatches.length > 1) {
      return buildCurrentSessionUnavailableContext(
        "Ambiguous current session. Add --app when resolving targets.",
        tty,
      );
    }

    return buildCurrentSessionUnavailableContext(
      "No active current session found. Start or focus a supported terminal first.",
      tty,
    );
  } catch (error) {
    return buildCurrentSessionUnavailableContext(
      `Unable to inspect current session: ${getErrorMessage(error)}`,
      tty,
    );
  }
}

export function formatCurrentSessionHelpBlock(currentSessionContext) {
  if (currentSessionContext?.ok && currentSessionContext?.session) {
    return `Current session for AI (--session copy):
  ${currentSessionContext.session}
`;
  }

  return `Current session for AI (--session copy):
  (unavailable)
`;
}
