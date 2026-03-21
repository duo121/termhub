import { spawn } from "node:child_process";

import { CLIError } from "./errors.js";
import * as iTerm2 from "./iterm2.js";
import * as terminal from "./terminal.js";
import { createProviderSnapshot, mergeSnapshots, normalizeAppName } from "./snapshot.js";

const PROVIDERS = [iTerm2, terminal];
const PROVIDER_MAP = new Map(PROVIDERS.map((provider) => [provider.PROVIDER.app, provider]));

export const SUPPORTED_APPS = PROVIDERS.map((provider) => provider.PROVIDER);

function runAppleScript(script) {
  return new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      reject(new Error(stderr.trim() || stdout.trim() || "AppleScript execution failed"));
    });
  });
}

export function getProviderByApp(app) {
  return PROVIDER_MAP.get(app) ?? null;
}

export function normalizeAppOption(value) {
  if (value == null) {
    return null;
  }

  const normalized = normalizeAppName(value);
  if (!normalized) {
    throw new CLIError(`Unknown app: ${value}`, {
      code: "USAGE_ERROR",
      exitCode: 2,
      details: {
        supportedApps: SUPPORTED_APPS.map((provider) => provider.app),
      },
    });
  }

  return normalized;
}

export async function getFrontmostApp() {
  try {
    const [bundleId, name] = await Promise.all([
      runAppleScript(
        'tell application "System Events" to get bundle identifier of first application process whose frontmost is true',
      ),
      runAppleScript(
        'tell application "System Events" to get name of first application process whose frontmost is true',
      ),
    ]);

    const provider = PROVIDERS.find((entry) => entry.PROVIDER.bundleId === bundleId);
    return {
      app: provider?.PROVIDER.app ?? null,
      displayName: provider?.PROVIDER.displayName ?? name ?? null,
      bundleId,
    };
  } catch {
    return null;
  }
}

export async function getSnapshot(options = {}) {
  const app = normalizeAppOption(options.app);
  const selectedProviders = app ? [getProviderByApp(app)] : PROVIDERS;
  const frontmostApp = await getFrontmostApp();
  const snapshots = [];

  for (const provider of selectedProviders) {
    const running = await provider.isRunning();

    if (!running) {
      snapshots.push(
        createProviderSnapshot({
          ...provider.PROVIDER,
          running: false,
        }),
      );
      continue;
    }

    snapshots.push(await provider.getSnapshot());
  }

  return mergeSnapshots(snapshots, { frontmostApp });
}

export async function sendTextToTarget(target, text, options = {}) {
  const provider = getProviderByApp(target.app);
  return provider.sendTextToTarget(target, text, options);
}

export async function captureTarget(target) {
  const provider = getProviderByApp(target.app);
  return provider.captureTarget(target);
}

export async function focusTarget(target) {
  const provider = getProviderByApp(target.app);
  return provider.focusTarget(target);
}
