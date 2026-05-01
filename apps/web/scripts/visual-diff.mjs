#!/usr/bin/env node
/**
 * Visual screenshot diff helper for web PR checks.
 *
 * Compares PNG files in a baseline tree against an actual tree, writing
 * pixelmatch overlays for any file whose changed-pixel ratio exceeds
 * the configured threshold.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pixelmatch from "pixelmatch";
import pngjs from "pngjs";

const { PNG } = pngjs;
const DEFAULT_THRESHOLD_RATIO = 0.005;
const DEFAULT_PIXELMATCH_THRESHOLD = 0.1;

export async function comparePngTrees({
  baselineDir,
  actualDir,
  diffDir,
  thresholdRatio = DEFAULT_THRESHOLD_RATIO,
  pixelmatchThreshold = DEFAULT_PIXELMATCH_THRESHOLD,
} = {}) {
  if (!baselineDir || !actualDir || !diffDir) {
    throw new Error("baselineDir, actualDir, and diffDir are required");
  }

  const baselineFiles = await listPngFiles(baselineDir);
  const failures = [];
  let compared = 0;

  await mkdir(diffDir, { recursive: true });

  for (const relativePath of baselineFiles) {
    const baselinePath = path.join(baselineDir, relativePath);
    const actualPath = path.join(actualDir, relativePath);
    const diffPath = path.join(diffDir, relativePath);

    if (!existsSync(actualPath)) {
      failures.push({
        file: relativePath,
        reason: "missing_actual",
        diffPixels: null,
        totalPixels: null,
        diffRatio: 1,
      });
      continue;
    }

    const result = await comparePngFiles({
      baselinePath,
      actualPath,
      diffPath,
      thresholdRatio,
      pixelmatchThreshold,
    });
    compared += 1;
    if (!result.ok) failures.push({ file: relativePath, ...result });
  }

  return {
    ok: failures.length === 0,
    thresholdRatio,
    compared,
    failures,
  };
}

export async function comparePngFiles({
  baselinePath,
  actualPath,
  diffPath,
  thresholdRatio = DEFAULT_THRESHOLD_RATIO,
  pixelmatchThreshold = DEFAULT_PIXELMATCH_THRESHOLD,
}) {
  const [baselineBuffer, actualBuffer] = await Promise.all([
    readFile(baselinePath),
    readFile(actualPath),
  ]);

  if (hashBuffer(baselineBuffer) === hashBuffer(actualBuffer)) {
    return {
      ok: true,
      reason: "identical",
      diffPixels: 0,
      totalPixels: null,
      diffRatio: 0,
    };
  }

  const baseline = PNG.sync.read(baselineBuffer);
  const actual = PNG.sync.read(actualBuffer);
  const totalPixels = baseline.width * baseline.height;

  if (baseline.width !== actual.width || baseline.height !== actual.height) {
    return {
      ok: false,
      reason: "dimension_mismatch",
      diffPixels: totalPixels,
      totalPixels,
      diffRatio: 1,
      baselineSize: { width: baseline.width, height: baseline.height },
      actualSize: { width: actual.width, height: actual.height },
    };
  }

  const diff = new PNG({ width: baseline.width, height: baseline.height });
  const diffPixels = pixelmatch(
    baseline.data,
    actual.data,
    diff.data,
    baseline.width,
    baseline.height,
    { threshold: pixelmatchThreshold },
  );
  const diffRatio = totalPixels === 0 ? 0 : diffPixels / totalPixels;
  const ok = diffRatio <= thresholdRatio;

  if (!ok) {
    await mkdir(path.dirname(diffPath), { recursive: true });
    await writeFile(diffPath, PNG.sync.write(diff));
  }

  return {
    ok,
    reason: ok ? "within_threshold" : "pixel_diff",
    diffPixels,
    totalPixels,
    diffRatio,
    diffPath: ok ? null : diffPath,
  };
}

export async function listPngFiles(rootDir) {
  const files = [];

  async function walk(currentDir) {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".png")) {
        files.push(path.relative(rootDir, absolutePath));
      }
    }
  }

  if (!existsSync(rootDir)) return files;
  await walk(rootDir);
  files.sort();
  return files;
}

export function parseArgs(argv) {
  const args = {
    thresholdRatio: DEFAULT_THRESHOLD_RATIO,
    pixelmatchThreshold: DEFAULT_PIXELMATCH_THRESHOLD,
    jsonPath: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--baseline") {
      args.baselineDir = next;
      i += 1;
    } else if (arg === "--actual") {
      args.actualDir = next;
      i += 1;
    } else if (arg === "--diff") {
      args.diffDir = next;
      i += 1;
    } else if (arg === "--threshold") {
      args.thresholdRatio = Number(next);
      i += 1;
    } else if (arg === "--pixelmatch-threshold") {
      args.pixelmatchThreshold = Number(next);
      i += 1;
    } else if (arg === "--json") {
      args.jsonPath = next;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.thresholdRatio) || args.thresholdRatio < 0) {
    throw new Error("--threshold must be a non-negative number");
  }
  if (!Number.isFinite(args.pixelmatchThreshold) || args.pixelmatchThreshold < 0) {
    throw new Error("--pixelmatch-threshold must be a non-negative number");
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const result = await comparePngTrees(args);
  const summary = JSON.stringify(result, null, 2);

  if (args.jsonPath) {
    await mkdir(path.dirname(args.jsonPath), { recursive: true });
    await writeFile(args.jsonPath, `${summary}\n`);
  }

  if (result.ok) {
    console.log(
      `[visual-diff] ${result.compared} PNGs matched within ${(result.thresholdRatio * 100).toFixed(2)}%`,
    );
    return;
  }

  console.error(summary);
  process.exitCode = 1;
}

function printUsage() {
  console.log(`Usage:
  node apps/web/scripts/visual-diff.mjs \\
    --baseline /tmp/lumo-visual-baseline/docs/notes \\
    --actual docs/notes \\
    --diff /tmp/lumo-visual-diff \\
    --threshold 0.005 \\
    --json /tmp/lumo-visual-diff/results.json
`);
}

function hashBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

const thisFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile && (await stat(thisFile)).ino === (await stat(invokedFile)).ino) {
  await main();
}
