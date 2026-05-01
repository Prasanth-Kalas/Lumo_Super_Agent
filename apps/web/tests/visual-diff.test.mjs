/**
 * WEB-VISUAL-REGRESSION-CI-1 — visual diff comparator smoke tests.
 *
 * Run: node --experimental-strip-types tests/visual-diff.test.mjs
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pngjs from "pngjs";
import { comparePngTrees } from "../scripts/visual-diff.mjs";

const { PNG } = pngjs;

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n    ${e.message}`);
  }
};

console.log("\nvisual diff comparator");

await t("passes identical PNG trees", async () => {
  const tmp = await makeFixtureDirs();
  try {
    await writeSolidPng(path.join(tmp.baseline, "same.png"), [20, 40, 60, 255]);
    await writeSolidPng(path.join(tmp.actual, "same.png"), [20, 40, 60, 255]);

    const result = await comparePngTrees({
      baselineDir: tmp.baseline,
      actualDir: tmp.actual,
      diffDir: tmp.diff,
      thresholdRatio: 0,
    });

    assert.equal(result.ok, true);
    assert.equal(result.compared, 1);
    assert.deepEqual(result.failures, []);
  } finally {
    await rm(tmp.root, { recursive: true, force: true });
  }
});

await t("fails different PNG trees and writes diff overlay", async () => {
  const tmp = await makeFixtureDirs();
  try {
    const baseline = path.join(tmp.baseline, "screens", "changed.png");
    const actual = path.join(tmp.actual, "screens", "changed.png");
    await writeSolidPng(baseline, [20, 40, 60, 255]);
    await writeSolidPng(actual, [210, 30, 90, 255]);

    const result = await comparePngTrees({
      baselineDir: tmp.baseline,
      actualDir: tmp.actual,
      diffDir: tmp.diff,
      thresholdRatio: 0.005,
    });

    assert.equal(result.ok, false);
    assert.equal(result.compared, 1);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].file, "screens/changed.png");
    assert.equal(result.failures[0].reason, "pixel_diff");
    assert.ok(result.failures[0].diffRatio > 0.005);
    const diffBuffer = await readFile(path.join(tmp.diff, "screens", "changed.png"));
    assert.ok(diffBuffer.length > 0);
  } finally {
    await rm(tmp.root, { recursive: true, force: true });
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

async function makeFixtureDirs() {
  const root = await mkdtemp(path.join(os.tmpdir(), "lumo-visual-diff-test-"));
  return {
    root,
    baseline: path.join(root, "baseline"),
    actual: path.join(root, "actual"),
    diff: path.join(root, "diff"),
  };
}

async function writeSolidPng(filePath, rgba) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const png = new PNG({ width: 8, height: 8 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgba[0];
    png.data[i + 1] = rgba[1];
    png.data[i + 2] = rgba[2];
    png.data[i + 3] = rgba[3];
  }
  await writeFile(filePath, PNG.sync.write(png));
}
