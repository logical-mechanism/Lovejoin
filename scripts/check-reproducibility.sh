#!/usr/bin/env bash
# scripts/check-reproducibility.sh — verify the contract build is byte-deterministic.
#
# Spec: docs/spec/09-milestones.md M7 — "Reproducible-build verification: re-build
# from a tag and assert byte-identical contract artifacts."
#
# What it does: runs contracts/build.sh twice from a clean state (rm -rf
# contracts/build && contracts/plutus.json between runs) and verifies that
# every emitted .plutus envelope is byte-identical across the two runs.
#
# Exit codes:
#   0  — all artifacts byte-identical across runs (reproducible)
#   1  — at least one artifact differs (NOT reproducible)
#   2  — toolchain prerequisite missing (aiken / jq / shasum)
#
# This catches:
#   - aiken bumps that introduce non-determinism
#   - source changes that leak environment state (timestamps, paths, $RANDOM)
#   - build.sh edits that bake in non-deterministic values
#
# Local dev: run from repo root. Default network is `test` so the script
# doesn't depend on a live Preprod bootstrap. Override via $NETWORK_CONFIG.
#
#   ./scripts/check-reproducibility.sh
#   NETWORK_CONFIG=config/network.preprod.json ./scripts/check-reproducibility.sh

set -euo pipefail

NETWORK_CONFIG="${NETWORK_CONFIG:-config/network.test.json}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "check-reproducibility: missing prerequisite '$1' on PATH" >&2
    exit 2
  fi
}

require_cmd aiken
require_cmd jq

# Pick a sha256 tool that's available on both macOS (shasum) and Linux (sha256sum).
if command -v sha256sum >/dev/null 2>&1; then
  SHA="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  SHA="shasum -a 256"
else
  echo "check-reproducibility: need sha256sum or shasum on PATH" >&2
  exit 2
fi

if [[ ! -f "$NETWORK_CONFIG" ]]; then
  echo "check-reproducibility: network config not found at $NETWORK_CONFIG" >&2
  exit 2
fi

NETWORK=$(jq -r '.network' "$NETWORK_CONFIG")
ARTIFACTS_DIR="$REPO_ROOT/artifacts/$NETWORK"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

run_build_and_hash() {
  local out="$1"
  rm -rf "$REPO_ROOT/contracts/build" "$REPO_ROOT/contracts/plutus.json"
  ( "$REPO_ROOT/contracts/build.sh" "$NETWORK_CONFIG" ) >/dev/null
  # Hash every .plutus file the build emits — these are the artifacts that
  # downstream tooling (cardano-cli, on-chain reference scripts) consumes.
  ( cd "$ARTIFACTS_DIR" && $SHA *.plutus ) | sort > "$out"
}

echo "check-reproducibility: building $NETWORK contracts (run 1/2)…"
run_build_and_hash "$WORKDIR/run1.sha256"

echo "check-reproducibility: building $NETWORK contracts (run 2/2)…"
run_build_and_hash "$WORKDIR/run2.sha256"

echo
echo "Run 1 hashes:"
cat "$WORKDIR/run1.sha256"
echo
echo "Run 2 hashes:"
cat "$WORKDIR/run2.sha256"
echo

if diff -u "$WORKDIR/run1.sha256" "$WORKDIR/run2.sha256"; then
  echo
  echo "check-reproducibility: PASS — every .plutus artifact is byte-identical across rebuilds"
  exit 0
else
  echo
  echo "check-reproducibility: FAIL — at least one .plutus artifact changed between runs" >&2
  echo "Aiken version: $(aiken --version)" >&2
  exit 1
fi
