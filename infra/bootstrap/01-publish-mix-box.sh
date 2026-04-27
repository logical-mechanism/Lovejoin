#!/usr/bin/env bash
# 01-publish-mix-box.sh — publish mix_box as a CIP-33 reference script.
#
# Single-script-per-tx by convention: keeps per-tx size predictable as the
# validators grow, and isolates failures (a publish that fails costs only its
# own funding + fee, not the whole infrastructure setup).
#
# Inputs (env, in addition to the common ones from _lib.sh):
#   FUNDING_UTXO       — UTxO at BOOTSTRAP_ADDR funding this output + tx fee.
#                        Needs ≈ 30 ADA (mix_box output ~25 ADA + ~1 ADA fee +
#                        change).
#   REF_PUBLISH_LOVELACE  — lovelace per ref-script output (default 25_000_000).
#
# Writes: artifacts/<network>/addresses.json (referenceScriptUtxos.mix_box).

set -euo pipefail
source "$(dirname "$0")/_lib.sh"
bootstrap_init "01-publish-mix-box"

: "${FUNDING_UTXO:?FUNDING_UTXO required}"
publish_reference_script "01-publish-mix-box" "mix_box.plutus" "mix_box" "$FUNDING_UTXO"
