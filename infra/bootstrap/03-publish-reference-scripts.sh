#!/usr/bin/env bash
# 03-publish-reference-scripts.sh — publish mix_box, mix_logic, and fee_contract
# as CIP-33 reference scripts so Mix txs don't have to attach the script bytes
# inline. Reference scripts live forever at a burn-tier address; the spend-time
# cost goes from "inline 5 KiB of CBOR" to "include 1 reference input."
#
# Inputs (env):
#   NETWORK            — "preprod" | "test" (default: preprod)
#   TESTNET_MAGIC      — default 1 (Preprod)
#   BOOTSTRAP_ADDR     — wallet supplying lovelace + change recipient
#   PAYMENT_SKEY       — bootstrap wallet signing key
#   FUNDING_UTXO       — "<txid>#<idx>" with enough lovelace to cover the
#                        published outputs + fee. The reference outputs are
#                        deliberately at the bootstrap address (no datum) —
#                        making them spendable by the bootstrap key, but
#                        anyone can already use them as reference inputs
#                        without spending them.
#   PUBLISH_LOVELACE   — lovelace per reference output (default: 30_000_000;
#                        reference scripts have a high min-UTxO floor).
#
# Reads:
#   artifacts/<network>/{mix_box,mix_logic,fee_contract}.plutus
#
# Writes:
#   artifacts/<network>/addresses.json     (referenceScriptUtxos populated)

set -euo pipefail

NETWORK="${NETWORK:-preprod}"
TESTNET_MAGIC="${TESTNET_MAGIC:-1}"
BOOTSTRAP_ADDR="${BOOTSTRAP_ADDR:?}"
PAYMENT_SKEY="${PAYMENT_SKEY:?}"
FUNDING_UTXO="${FUNDING_UTXO:?}"
PUBLISH_LOVELACE="${PUBLISH_LOVELACE:-30000000}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ARTIFACTS_DIR="$REPO_ROOT/artifacts/$NETWORK"

TX_RAW="$ARTIFACTS_DIR/03-publish-reference-scripts.txraw"

cardano-cli conway transaction build \
  --testnet-magic "$TESTNET_MAGIC" \
  --tx-in "$FUNDING_UTXO" \
  --tx-out "$BOOTSTRAP_ADDR + $PUBLISH_LOVELACE lovelace" \
  --tx-out-reference-script-file "$ARTIFACTS_DIR/mix_box.plutus" \
  --tx-out "$BOOTSTRAP_ADDR + $PUBLISH_LOVELACE lovelace" \
  --tx-out-reference-script-file "$ARTIFACTS_DIR/mix_logic.plutus" \
  --tx-out "$BOOTSTRAP_ADDR + $PUBLISH_LOVELACE lovelace" \
  --tx-out-reference-script-file "$ARTIFACTS_DIR/fee_contract.plutus" \
  --change-address "$BOOTSTRAP_ADDR" \
  --out-file "$TX_RAW"

cardano-cli conway transaction sign \
  --tx-body-file "$TX_RAW" \
  --signing-key-file "$PAYMENT_SKEY" \
  --testnet-magic "$TESTNET_MAGIC" \
  --out-file "$ARTIFACTS_DIR/03-publish-reference-scripts.tx"

cardano-cli conway transaction submit \
  --testnet-magic "$TESTNET_MAGIC" \
  --tx-file "$ARTIFACTS_DIR/03-publish-reference-scripts.tx"

TX_ID=$(cardano-cli conway transaction txid --tx-file "$ARTIFACTS_DIR/03-publish-reference-scripts.tx")
echo "03-publish-reference-scripts: submitted txid $TX_ID"

# Persist the reference script UTxO refs (output indices 0..2 in build order).
TMP=$(mktemp)
jq --arg txId "$TX_ID" '
  .referenceScriptUtxos = {
    mix_box: "\($txId)#0",
    mix_logic: "\($txId)#1",
    fee_contract: "\($txId)#2"
  }
' "$ARTIFACTS_DIR/addresses.json" > "$TMP"
mv "$TMP" "$ARTIFACTS_DIR/addresses.json"

echo "03-publish-reference-scripts: published mix_box / mix_logic / fee_contract"
