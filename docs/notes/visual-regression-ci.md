# Web Visual Regression CI

WEB-VISUAL-REGRESSION-CI-1 wires the existing Playwright screenshot capture scripts into pull-request CI.

## What Runs

The workflow lives at `.github/workflows/visual-regression.yml` and runs on PRs that touch:

- `apps/web/**`
- `scripts/*capture*.mjs`
- `docs/notes/**-screenshots/**`
- the workflow itself

It starts the Next.js dev server with `LUMO_WEB_DISABLE_AUTH_GATE=1` under `NODE_ENV=development`, runs every root-level `scripts/*capture*.mjs` file, and compares the regenerated PNGs under `docs/notes/**` against the committed baseline captured before the scripts ran.

The comparator is `apps/web/scripts/visual-diff.mjs`. It uses `pixelmatch` and fails when any PNG changes by more than `0.5%` of pixels. Diff overlays and the dev-server log are uploaded as the `visual-regression-diffs` artifact on failure.

## Updating Baselines

When a visual change is intentional:

1. Run the relevant capture script locally against `apps/web`.
2. Inspect the updated PNGs under `docs/notes/*-screenshots/`.
3. Commit the PNG changes with the UI code.

This keeps screenshot baselines reviewable as normal diffs instead of hiding them in CI artifacts.

## Temporary Override

Add the PR label `skip-visual-regression` to skip the workflow. Use this only for urgent infrastructure fixes or PRs where the browser runner is unrelated to the change; remove the label before merging UI work.

## Local Comparator Check

```bash
node apps/web/scripts/visual-diff.mjs \
  --baseline /tmp/lumo-visual-baseline/notes \
  --actual docs/notes \
  --diff /tmp/lumo-visual-diff \
  --threshold 0.005
```
