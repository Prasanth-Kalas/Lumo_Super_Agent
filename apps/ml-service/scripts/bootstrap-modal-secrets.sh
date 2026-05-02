#!/usr/bin/env bash
# Bootstrap the `lumo-ml-service` Modal Secret used by modal_app.py.
#
# Inputs (env vars on the operator's machine):
#   LUMO_ML_SERVICE_JWT_SECRET — required. Long random hex; Vercel must hold
#                                the same value or service-to-service JWTs
#                                won't validate.
#   LUMO_DEEPGRAM_API_KEY      — optional. Enables Nova-3 transcription.
#   HF_TOKEN                   — optional. HuggingFace token for downloading
#                                modal_clip model weights.
#   ANTHROPIC_API_KEY          — optional. Reserved for future LLM-backed
#                                tools; current tools don't use it.
#
# To rotate the JWT secret, re-run with a new LUMO_ML_SERVICE_JWT_SECRET and
# update the Vercel env in lockstep — otherwise the orchestrator's signed
# requests will fail validation at the brain.
set -euo pipefail

if [[ -z "${LUMO_ML_SERVICE_JWT_SECRET:-}" ]]; then
  echo "ERROR: set LUMO_ML_SERVICE_JWT_SECRET (e.g. \`openssl rand -hex 32\`)" >&2
  exit 1
fi

ARGS=("LUMO_ML_SERVICE_JWT_SECRET=${LUMO_ML_SERVICE_JWT_SECRET}")
if [[ -n "${HF_TOKEN:-}" ]]; then
  ARGS+=("HF_TOKEN=${HF_TOKEN}")
fi
if [[ -n "${LUMO_DEEPGRAM_API_KEY:-}" ]]; then
  ARGS+=("LUMO_DEEPGRAM_API_KEY=${LUMO_DEEPGRAM_API_KEY}")
fi
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  ARGS+=("ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}")
fi

# `--force` so re-running replaces the existing secret (rotation friendly).
modal secret create lumo-ml-service "${ARGS[@]}" --force

echo "Created/updated Modal Secret 'lumo-ml-service' with $(( ${#ARGS[@]} )) keys."
