#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const range = process.argv[2] ?? process.env.COMMIT_RANGE ?? "HEAD~1..HEAD";

const RUNTIME_PATHS = [
  /^apps\/web\/app\/api\//,
  /^apps\/web\/config\/agents\.registry/,
  /^db\/migrations\//,
  /^apps\/web\/lib\//,
  /^apps\/web\/middleware\.ts$/,
];

const BRAND_OR_GLOBAL_UI_PATHS = [
  /^apps\/web\/app\/globals\.css$/,
  /^apps\/web\/components\/BrandMark\.tsx$/,
  /^apps\/web\/public\//,
  /^scripts\/build-wordmark\./,
  /wordmark/i,
];

const BROAD_UI_PATHS = [
  /^apps\/web\/app\/.*\.(tsx|css)$/,
  /^apps\/web\/components\/.*\.tsx$/,
];

// Subject-prefix exception: commits whose primary purpose is a structural
// move (monorepo conversion, directory reorg) legitimately touch runtime
// and UI surfaces in the same commit. Reviewers acknowledge this by
// using one of these prefixes; the rule is then skipped for that commit.
const STRUCTURAL_EXEMPT_PREFIXES = [
  /^chore\(monorepo\)/i,
  /^chore\(repo-structure\)/i,
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
  if (STRUCTURAL_EXEMPT_PREFIXES.some((pattern) => pattern.test(subject))) {
    continue;
  }
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
