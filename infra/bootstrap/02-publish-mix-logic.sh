#!/usr/bin/env bash
# 02-publish-mix-logic.sh — publish mix_logic as a CIP-33 reference script.
#
# This output is the one 04-register-mix-logic.sh references when it submits
# the stake-credential registration cert: instead of attaching mix_logic.plutus
# inline, the cert's authorizing script is read from this UTxO via
# --tx-in-reference. Cheaper, and it's the same recursive-tx-chain pattern the
# rest of the protocol uses for spends.
#
# Inputs (env):
#   FUNDING_UTXO       — UTxO at BOOTSTRAP_ADDR funding this output + tx fee.
#                        ≈ 30 ADA.
#   REF_PUBLISH_LOVELACE  — lovelace per ref-script output (default 25_000_000).
#
# Writes: artifacts/<network>/addresses.json (referenceScriptUtxos.mix_logic).

set -euo pipefail
source "$(dirname "$0")/_lib.sh"
bootstrap_init "02-publish-mix-logic"

: "${FUNDING_UTXO:?FUNDING_UTXO required}"
publish_reference_script "02-publish-mix-logic" "mix_logic.plutus" "mix_logic" "$FUNDING_UTXO"
