import { spawn } from "node:child_process";

import { CLIError } from "./errors.js";
import * as cmd from "./cmd.js";
import * as iTerm2 from "./iterm2.js";
import * as terminal from "./terminal.js";
import * as windowsTerminal from "./windows-terminal.js";
import {
  buildPowerShellJsonCommand,
  getWin32ErrorMessage,
  mapWin32Error,
  runPowerShellJson,
} from "./win32.js";
import { createProviderSnapshot, mergeSnapshots, normalizeAppName } from "./snapshot.js";

const PLATFORM_PROVIDERS = Object.freeze({
  darwin: [iTerm2, terminal],
  win32: [windowsTerminal, cmd],
});

export const CURRENT_PLATFORM = process.platform;
export const SUPPORTED_PLATFORMS = Object.freeze(["darwin", "win32"]);
export const SUPPORTED_APPS = Object.freeze(PLATFORM_PROVIDERS[CURRENT_PLATFORM] ?? []).map(
  (provider) => provider.PROVIDER,
);

const PROVIDERS = SUPPORTED_APPS.map((appInfo) =>
  (PLATFORM_PROVIDERS[CURRENT_PLATFORM] ?? []).find((provider) => provider.PROVIDER.app === appInfo.app),
);

const PROVIDER_MAP = new Map(PROVIDERS.map((provider) => [provider.PROVIDER.app, provider]));

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

function ensureProvider(app) {
  const provider = getProviderByApp(app);

  if (!provider) {
    throw new CLIError(`App is not supported on ${CURRENT_PLATFORM}: ${app}`, {
      code: "UNSUPPORTED_APP",
      exitCode: 2,
      details: {
        platform: CURRENT_PLATFORM,
        supportedApps: SUPPORTED_APPS.map((entry) => entry.app),
      },
    });
  }

  return provider;
}

async function getDarwinFrontmostApp() {
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

async function getWin32FrontmostApp() {
  try {
    const payload = await runPowerShellJson(
      buildPowerShellJsonCommand(
        `
$windowHandle = Get-TermhubForegroundHandle
if ($windowHandle -eq 0) {
  $payload = [pscustomobject]@{
    processName = $null
  }
} else {
  $processId = Get-TermhubProcessIdFromHandle $windowHandle
  $process = if ($processId -eq 0) { $null } else { Get-Process -Id $processId -ErrorAction SilentlyContinue }
  $payload = [pscustomobject]@{
    processName = ConvertTo-TermhubText $process.ProcessName
  }
}

$payload | ConvertTo-Json -Depth 6 -Compress
      `,
        { uiAutomation: false },
      ),
    );

    const processName = String(payload?.processName ?? "").toLowerCase();
    if (!processName) {
      return null;
    }

    const provider = PROVIDERS.find((entry) =>
      Array.isArray(entry.PROVIDER.processNames)
        ? entry.PROVIDER.processNames.some((name) => name.toLowerCase() === processName)
        : false,
    );

    return {
      app: provider?.PROVIDER.app ?? null,
      displayName: provider?.PROVIDER.displayName ?? payload.processName ?? null,
      bundleId: null,
    };
  } catch (error) {
    const mapped = mapWin32Error(getWin32ErrorMessage(error), {
      displayName: "Windows terminal app",
    });
    if (mapped.code === "POWERSHELL_NOT_FOUND" || mapped.code === "POWERSHELL_FAILED") {
      return null;
    }

    return null;
  }
}

export function getProviderByApp(app) {
  return PROVIDER_MAP.get(app) ?? null;
}

export function normalizeAppOption(value) {
  if (value == null) {
    return null;
  }

  const normalized = normalizeAppName(value);
  if (!normalized || !PROVIDER_MAP.has(normalized)) {
    throw new CLIError(`Unknown app: ${value}`, {
      code: "USAGE_ERROR",
      exitCode: 2,
      details: {
        platform: CURRENT_PLATFORM,
        supportedApps: SUPPORTED_APPS.map((provider) => provider.app),
      },
    });
  }

  return normalized;
}

export async function getFrontmostApp() {
  if (CURRENT_PLATFORM === "darwin") {
    return getDarwinFrontmostApp();
  }

  if (CURRENT_PLATFORM === "win32") {
    return getWin32FrontmostApp();
  }

  return null;
}

export async function getSnapshot(options = {}) {
  const app = normalizeAppOption(options.app);
  const selectedProviders = app ? [ensureProvider(app)] : PROVIDERS;
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
  const provider = ensureProvider(target.app);
  return provider.sendTextToTarget(target, text, options);
}

export async function captureTarget(target) {
  const provider = ensureProvider(target.app);
  return provider.captureTarget(target);
}

export async function focusTarget(target) {
  const provider = ensureProvider(target.app);
  return provider.focusTarget(target);
}

export async function closeTarget(target) {
  const provider = ensureProvider(target.app);
  return provider.closeTarget(target);
}
