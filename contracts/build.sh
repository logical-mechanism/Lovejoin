#!/usr/bin/env bash
# Build Lovejoin Aiken contracts. Stub for M0 — real artifact emission lands in M2
# alongside `infra/bootstrap/00-build-reference.sh` (see docs/spec/03-contracts.md §4).
#
# Usage: ./build.sh [path/to/network.json]
set -euo pipefail

cd "$(dirname "$0")"

aiken check
aiken build || true   # validators arrive in M2; tolerate empty validators/ for now

echo "contracts/build.sh: M0 stub — no plutus artifacts emitted yet."
