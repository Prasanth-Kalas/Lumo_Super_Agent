/**
 * Held-out classifier eval harness (Phase 1.5).
 *
 * Loads a JSONL dataset of labelled inbox-style messages and scores each row
 * with the pure heuristic classifier from `lib/lead-scoring.ts`. Emits a
 * confusion matrix plus precision / recall / F1 / accuracy and a per-category
 * breakdown so we can spot regressions before swapping in the ML classifier.
 *
 * Usage:
 *   node --experimental-strip-types eval/held-out-classifier/run.mjs
 *   node --experimental-strip-types eval/held-out-classifier/run.mjs \
 *     --dataset eval/held-out-classifier/dataset/synthetic.jsonl \
 *     --threshold 0.7
 *
 * Exit codes:
 *   0 — eval ran cleanly (metrics printed). Threshold gating is intentionally
 *       OFF for the scaffold; CI can opt in by passing `--min-f1`.
 *   1 — dataset missing/unparseable, or `--min-f1` gate failed.
 *
 * IMPORTANT: this harness does not call the ML classifier. The held-out signal
 * we care about today is "does the heuristic baseline still land where we
 * expect on a frozen dataset?" Once the ML path lands behind a feature flag,
 * this script grows a `--source ml` mode that posts to the existing
 * `/api/tools/classify` endpoint.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LEAD_SCORE_THRESHOLD,
  scoreLeadHeuristic,
} from "../../lib/lead-scoring.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function parseArgs(argv) {
  const args = {
    dataset: path.join(__dirname, "dataset", "synthetic.jsonl"),
    threshold: LEAD_SCORE_THRESHOLD,
    minF1: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--dataset" && next) {
      args.dataset = path.isAbsolute(next) ? next : path.resolve(process.cwd(), next);
      i += 1;
    } else if (flag === "--threshold" && next) {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        throw new Error(`--threshold must be a number in [0,1], got "${next}"`);
      }
      args.threshold = parsed;
      i += 1;
    } else if (flag === "--min-f1" && next) {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        throw new Error(`--min-f1 must be a number in [0,1], got "${next}"`);
      }
      args.minF1 = parsed;
      i += 1;
    } else if (flag === "--json") {
      args.json = true;
    } else if (flag === "--help" || flag === "-h") {
      printHelp();
      process.exit(0);
    } else if (flag.startsWith("--")) {
      throw new Error(`Unknown flag: ${flag}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Held-out classifier eval

Flags:
  --dataset <path>   JSONL dataset (default: eval/held-out-classifier/dataset/synthetic.jsonl)
  --threshold <num>  Decision threshold in [0,1] (default: ${LEAD_SCORE_THRESHOLD})
  --min-f1 <num>     If set, exit non-zero when F1 falls below this gate
  --json             Emit JSON-only output (suppresses pretty tables)
`);
}

async function loadDataset(absPath) {
  if (!existsSync(absPath)) {
    throw new Error(`dataset not found: ${absPath}`);
  }
  const raw = await readFile(absPath, "utf8");
  const rows = [];
  let lineNo = 0;
  for (const line of raw.split(/\r?\n/)) {
    lineNo += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(
        `dataset parse error on line ${lineNo}: ${(err && err.message) || err}`,
      );
    }
    if (typeof parsed.id !== "string") {
      throw new Error(`row ${lineNo} missing string id`);
    }
    if (typeof parsed.text !== "string") {
      throw new Error(`row ${lineNo} missing string text`);
    }
    if (typeof parsed.label !== "boolean") {
      throw new Error(`row ${lineNo} missing boolean label`);
    }
    rows.push({
      id: parsed.id,
      text: parsed.text,
      label: parsed.label,
      category: typeof parsed.category === "string" ? parsed.category : "uncategorized",
      source: typeof parsed.source === "string" ? parsed.source : "synthetic",
    });
  }
  return rows;
}

function evaluate(rows, threshold) {
  const perRow = [];
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  const categoryStats = new Map();

  for (const row of rows) {
    const heuristic = scoreLeadHeuristic(row.text);
    const predicted = heuristic.score >= threshold;
    const actual = row.label;
    const correct = predicted === actual;
    let outcome;
    if (predicted && actual) {
      tp += 1;
      outcome = "TP";
    } else if (predicted && !actual) {
      fp += 1;
      outcome = "FP";
    } else if (!predicted && actual) {
      fn += 1;
      outcome = "FN";
    } else {
      tn += 1;
      outcome = "TN";
    }
    const bucket = categoryStats.get(row.category) ?? {
      category: row.category,
      n: 0,
      correct: 0,
      tp: 0,
      fp: 0,
      tn: 0,
      fn: 0,
    };
    bucket.n += 1;
    if (correct) bucket.correct += 1;
    bucket[outcome.toLowerCase()] += 1;
    categoryStats.set(row.category, bucket);

    perRow.push({
      id: row.id,
      category: row.category,
      label: actual,
      predicted,
      score: heuristic.score,
      reasons: heuristic.reasons,
      outcome,
      correct,
    });
  }

  const total = tp + fp + tn + fn;
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const accuracy = total === 0 ? 0 : (tp + tn) / total;

  return {
    confusion: { tp, fp, tn, fn },
    metrics: {
      total,
      precision: round(precision),
      recall: round(recall),
      f1: round(f1),
      accuracy: round(accuracy),
    },
    perCategory: Array.from(categoryStats.values()).map((bucket) => ({
      category: bucket.category,
      n: bucket.n,
      accuracy: round(bucket.correct / bucket.n),
      tp: bucket.tp,
      fp: bucket.fp,
      tn: bucket.tn,
      fn: bucket.fn,
    })).sort((a, b) => a.category.localeCompare(b.category)),
    perRow,
  };
}

function round(value) {
  return Number(Number(value).toFixed(4));
}

function printConfusionMatrix(confusion) {
  const { tp, fp, tn, fn } = confusion;
  const cell = (n) => String(n).padStart(5);
  console.log("Confusion matrix");
  console.log("                 predicted");
  console.log("                 lead    not-lead");
  console.log(`actual lead     ${cell(tp)}    ${cell(fn)}`);
  console.log(`actual not-lead ${cell(fp)}    ${cell(tn)}`);
}

function printPerCategory(perCategory) {
  if (perCategory.length === 0) return;
  console.log("\nPer-category accuracy");
  for (const bucket of perCategory) {
    const acc = (bucket.accuracy * 100).toFixed(1).padStart(5);
    const line = `  ${bucket.category.padEnd(14)} n=${String(bucket.n).padStart(2)}  acc=${acc}%  TP=${bucket.tp} FP=${bucket.fp} TN=${bucket.tn} FN=${bucket.fn}`;
    console.log(line);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const datasetRel = path.relative(REPO_ROOT, args.dataset);

  const rows = await loadDataset(args.dataset);
  if (rows.length === 0) {
    console.error("dataset is empty");
    process.exit(1);
  }
  const result = evaluate(rows, args.threshold);

  if (args.json) {
    console.log(JSON.stringify(
      {
        eval: "held-out-classifier",
        dataset: datasetRel,
        threshold: args.threshold,
        confusion: result.confusion,
        metrics: result.metrics,
        perCategory: result.perCategory,
      },
      null,
      2,
    ));
  } else {
    console.log(`Held-out classifier eval`);
    console.log(`  dataset:   ${datasetRel}`);
    console.log(`  rows:      ${rows.length}`);
    console.log(`  threshold: ${args.threshold}`);
    console.log("");
    printConfusionMatrix(result.confusion);
    console.log("");
    console.log("Metrics");
    console.log(`  precision: ${result.metrics.precision}`);
    console.log(`  recall:    ${result.metrics.recall}`);
    console.log(`  f1:        ${result.metrics.f1}`);
    console.log(`  accuracy:  ${result.metrics.accuracy}`);
    printPerCategory(result.perCategory);
  }

  if (args.minF1 !== null && result.metrics.f1 < args.minF1) {
    console.error(
      `\nF1 ${result.metrics.f1} < required ${args.minF1} — failing eval.`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
