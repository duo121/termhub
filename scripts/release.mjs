#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = process.cwd();
const PACKAGE_JSON_PATH = path.join(ROOT, "package.json");
const FORMULA_REL_PATH = path.join("Formula", "termhub.rb");
const FORMULA_PATH = path.join(ROOT, FORMULA_REL_PATH);

function log(step, message) {
  process.stdout.write(`[release][${step}] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[release][error] ${message}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: options.stdio ?? "inherit",
    encoding: "utf8",
    shell: false,
  });

  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`);
  }

  return result;
}

function runOut(command, args) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function ensureCleanWorktree() {
  const status = runOut("git", ["status", "--porcelain"]);
  if (status !== "") {
    fail("worktree is not clean. Commit or stash changes before release.");
  }
}

function ensureMainSynced() {
  const branch = runOut("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== "main") {
    fail(`current branch is ${branch}. Switch to main before release.`);
  }

  run("git", ["fetch", "origin", "--tags"]);
  const counts = runOut("git", ["rev-list", "--left-right", "--count", "origin/main...HEAD"]);
  const [behind, ahead] = counts.split(/\s+/).map((value) => Number.parseInt(value, 10));
  if (behind !== 0) {
    fail("local main is behind origin/main. Pull/rebase first.");
  }
  if (ahead !== 0) {
    fail("local main is ahead of origin/main. Push or reset before running release.");
  }
}

function readPackageVersion() {
  return JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")).version;
}

function updateFormula(version, sha256) {
  const formula = readFileSync(FORMULA_PATH, "utf8");
  const next = formula
    .replace(
      /url "https:\/\/registry\.npmjs\.org\/@duo121\/termhub\/-\/termhub-[^"]+\.tgz"/,
      `url "https://registry.npmjs.org/@duo121/termhub/-/termhub-${version}.tgz"`,
    )
    .replace(/sha256 "[a-f0-9]{64}"/, `sha256 "${sha256}"`);

  if (next === formula) {
    fail("failed to update Formula/termhub.rb");
  }

  writeFileSync(FORMULA_PATH, next, "utf8");
}

function npmLatest() {
  const payload = runOut("curl", [
    "--retry",
    "8",
    "--retry-delay",
    "1",
    "--retry-all-errors",
    "-sS",
    "https://registry.npmjs.org/@duo121%2Ftermhub/latest",
  ]);
  return JSON.parse(payload);
}

function computeTarballSha256(url, version) {
  const tgzPath = `/tmp/termhub-${version}.tgz`;
  run("curl", [
    "--retry",
    "8",
    "--retry-delay",
    "1",
    "--retry-all-errors",
    "-L",
    url,
    "-o",
    tgzPath,
  ]);
  const out = runOut("shasum", ["-a", "256", tgzPath]);
  return out.split(/\s+/)[0];
}

function ensureTagAbsent(tag) {
  const existing = runOut("git", ["tag", "--list", tag]);
  if (existing === tag) {
    fail(`tag ${tag} already exists locally.`);
  }
}

function main() {
  const type = process.argv[2] ?? "patch";
  if (!["patch", "minor", "major"].includes(type)) {
    fail("usage: npm run release [patch|minor|major]");
  }

  log("preflight", "checking git state");
  ensureCleanWorktree();
  ensureMainSynced();

  log("test", "running npm test");
  run("npm", ["test"]);

  const previousVersion = readPackageVersion();
  log("version", `bumping ${type} from ${previousVersion}`);
  run("npm", ["version", type, "--no-git-tag-version"]);
  const version = readPackageVersion();
  const tag = `v${version}`;
  ensureTagAbsent(tag);

  run("git", ["add", "package.json"]);
  run("git", ["commit", "-m", `chore(release): bump version to ${version}`]);

  log("npm", "publishing package (web confirmation may open in browser)");
  run("npm", ["publish"]);

  const latest = npmLatest();
  if (latest.version !== version) {
    fail(`npm latest mismatch: expected ${version}, got ${latest.version}`);
  }
  log("npm", `published @duo121/termhub@${version}`);

  const sha256 = computeTarballSha256(latest.dist.tarball, version);
  log("brew", `updating Formula/termhub.rb sha256=${sha256}`);
  updateFormula(version, sha256);
  run("git", ["add", FORMULA_REL_PATH]);
  run("git", ["commit", "-m", `chore(brew): update formula for ${tag}`]);

  log("git", "pushing main");
  run("git", ["push", "origin", "main"]);
  log("git", `tagging ${tag}`);
  run("git", ["tag", "-a", tag, "-m", tag]);
  run("git", ["push", "origin", tag]);

  const runId = runOut("gh", [
    "run",
    "list",
    "--workflow",
    "release.yml",
    "--limit",
    "20",
    "--json",
    "databaseId,headBranch,headSha,event,status,displayTitle",
    "--jq",
    `.[] | select(.headBranch == "${tag}" and .event == "push") | .databaseId`,
  ])
    .split("\n")
    .find(Boolean);

  if (!runId) {
    fail("could not find release workflow run id for tag push");
  }

  log("release", `watching workflow run ${runId}`);
  run("gh", ["run", "watch", runId, "--exit-status"]);

  const releaseUrl = runOut("gh", ["release", "view", tag, "--json", "url", "--jq", ".url"]);
  const assets = runOut("gh", ["release", "view", tag, "--json", "assets", "--jq", ".assets[].name"]);

  log("done", `npm: https://www.npmjs.com/package/@duo121/termhub/v/${version}`);
  log("done", `release: ${releaseUrl}`);
  log("done", `assets:\n${assets}`);
}

main();
