#!/usr/bin/env bash
# Shared helpers for the bootstrap scripts. Source this from each stage.
#
# All bootstrap scripts use cardano-cli for tx submission, which requires a
# synced cardano-node socket exported via CARDANO_NODE_SOCKET_PATH.

set -euo pipefail

bootstrap_init() {
  : "${NETWORK:=preprod}"
  : "${TESTNET_MAGIC:=1}"
  : "${BOOTSTRAP_ADDR:?BOOTSTRAP_ADDR required}"
  : "${PAYMENT_SKEY:?PAYMENT_SKEY (path to .skey) required}"

  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  ARTIFACTS_DIR="$REPO_ROOT/artifacts/$NETWORK"

  if [[ ! -d "$ARTIFACTS_DIR" ]]; then
    echo "$1: $ARTIFACTS_DIR missing — run contracts/build.sh + 00-build-reference.sh first" >&2
    exit 1
  fi
}

# Publish a single validator as a CIP-33 reference script. Each call is its
# own tx — keeping per-tx size predictable as the validators grow.
#
# Args: $1 stage-id (for log messages)  e.g. "01-publish-mix-box"
#       $2 script-file basename         e.g. "mix_box.plutus"
#       $3 referenceScriptUtxos key     e.g. "mix_box"
#       $4 funding UTxO ref             e.g. "abc...def#0"
#
# Side effect: writes addresses.json's referenceScriptUtxos[$3] = "<txid>#0".
publish_reference_script() {
  local stage="$1" script="$2" key="$3" funding="$4"
  local lovelace="${REF_PUBLISH_LOVELACE:-25000000}"

  local raw="$ARTIFACTS_DIR/$stage.txraw"
  cardano-cli conway transaction build \
    --testnet-magic "$TESTNET_MAGIC" \
    --tx-in "$funding" \
    --tx-out "$BOOTSTRAP_ADDR + $lovelace lovelace" \
    --tx-out-reference-script-file "$ARTIFACTS_DIR/$script" \
    --change-address "$BOOTSTRAP_ADDR" \
    --out-file "$raw"

  cardano-cli conway transaction sign \
    --tx-body-file "$raw" \
    --signing-key-file "$PAYMENT_SKEY" \
    --testnet-magic "$TESTNET_MAGIC" \
    --out-file "$ARTIFACTS_DIR/$stage.tx"

  cardano-cli conway transaction submit \
    --testnet-magic "$TESTNET_MAGIC" \
    --tx-file "$ARTIFACTS_DIR/$stage.tx"

  local tx_id
  tx_id=$(cardano-cli conway transaction txid --tx-file "$ARTIFACTS_DIR/$stage.tx")
  echo "$stage: submitted txid $tx_id"

  local tmp
  tmp=$(mktemp)
  jq --arg key "$key" --arg ref "$tx_id#0" '.referenceScriptUtxos[$key] = $ref' "$ARTIFACTS_DIR/addresses.json" > "$tmp"
  mv "$tmp" "$ARTIFACTS_DIR/addresses.json"

  echo "$stage: $key reference script published at $tx_id#0"
}
