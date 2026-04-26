#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const range = process.argv[2] ?? process.env.COMMIT_RANGE ?? "HEAD~1..HEAD";

const RUNTIME_PATHS = [
  /^app\/api\//,
  /^config\/agents\.registry/,
  /^db\/migrations\//,
  /^lib\//,
  /^middleware\.ts$/,
];

const BRAND_OR_GLOBAL_UI_PATHS = [
  /^app\/globals\.css$/,
  /^components\/BrandMark\.tsx$/,
  /^public\//,
  /^scripts\/build-wordmark\./,
  /wordmark/i,
];

const BROAD_UI_PATHS = [
  /^app\/.*\.(tsx|css)$/,
  /^components\/.*\.tsx$/,
];

const failures = [];
const commits = git(["rev-list", "--reverse", range])
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

for (const commit of commits) {
  const files = git([
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-r",
    commit,
  ])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const subject = git(["log", "--format=%s", "-n", "1", commit]).trim();
  const touchesRuntime = files.some((file) => matchesAny(file, RUNTIME_PATHS));
  const touchesBrandOrGlobalUi = files.some((file) =>
    matchesAny(file, BRAND_OR_GLOBAL_UI_PATHS),
  );
  const broadUiFiles = files.filter((file) => matchesAny(file, BROAD_UI_PATHS));
  const runtimeFiles = files.filter((file) => matchesAny(file, RUNTIME_PATHS));

  if (touchesBrandOrGlobalUi && touchesRuntime) {
    failures.push({
      commit,
      subject,
      reason:
        "brand/global UI assets are bundled with runtime, registry, API, or orchestrator files",
      files,
    });
  }

  if (runtimeFiles.length > 0 && broadUiFiles.length >= 8) {
    failures.push({
      commit,
      subject,
      reason:
        "large UI surface is bundled with runtime, registry, API, or orchestrator files",
      files,
    });
  }
}

if (failures.length > 0) {
  console.error(`Commit-shape check failed for ${range}.\n`);
  for (const failure of failures) {
    console.error(`- ${failure.commit.slice(0, 12)} ${failure.subject}`);
    console.error(`  ${failure.reason}.`);
    console.error("  Split into separate commits or document an explicit exception.");
    for (const file of failure.files.slice(0, 20)) {
      console.error(`    - ${file}`);
    }
    if (failure.files.length > 20) {
      console.error(`    ... ${failure.files.length - 20} more`);
    }
  }
  process.exit(1);
}

console.log(`Commit-shape check passed for ${range}.`);

function matchesAny(file, patterns) {
  return patterns.some((pattern) => pattern.test(file));
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}
