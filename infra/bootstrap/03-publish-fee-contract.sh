#!/usr/bin/env bash
# 03-publish-fee-contract.sh — publish fee_contract as a CIP-33 reference script.
#
# Inputs (env):
#   FUNDING_UTXO       — UTxO at BOOTSTRAP_ADDR funding this output + tx fee.
#                        ≈ 30 ADA.
#   REF_PUBLISH_LOVELACE  — lovelace per ref-script output (default 25_000_000).
#
# Writes: artifacts/<network>/addresses.json (referenceScriptUtxos.fee_contract).

set -euo pipefail
source "$(dirname "$0")/_lib.sh"
bootstrap_init "03-publish-fee-contract"

: "${FUNDING_UTXO:?FUNDING_UTXO required}"
publish_reference_script "03-publish-fee-contract" "fee_contract.plutus" "fee_contract" "$FUNDING_UTXO"
