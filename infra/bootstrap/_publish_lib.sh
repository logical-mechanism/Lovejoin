#!/usr/bin/env bash
# Helpers shared by 01a/01b/01c-publish-*.sh.
#
# Each per-stage script sources this. We follow the canonical pattern from the
# logical-mechanism deployments:
#   1. Source infra/bootstrap/.env (NETWORK, TESTNET_MAGIC, paths, etc.).
#   2. Query protocol parameters into ./tmp/protocol.json.
#   3. Query wallet UTxOs at BOOTSTRAP_ADDR.
#   4. Combine ALL wallet UTxOs except SEED + COLLATERAL into a single
#      `--tx-in <ref> --tx-in <ref> …` string for the build.
#   5. `cardano-cli transaction build` with `--change-address $BOOTSTRAP_ADDR`
#      so it picks fees + change automatically. (No `build-raw` mathematics —
#      we let cardano-cli do its job and submit immediately.)
#   6. Sign with PAYMENT_SKEY, submit.
#
# Operator runs each stage in sequence. Wait for confirmation between scripts
# (./balance.sh shows when the previous tx's outputs land).

set -euo pipefail

# Resolve the network + wallet paths once.
__BOOTSTRAP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
__ENV_FILE="$__BOOTSTRAP_DIR/.env"
[[ -f "$__ENV_FILE" ]] && { set -a; source "$__ENV_FILE"; set +a; }

NETWORK="${NETWORK:-preprod}"
TESTNET_MAGIC="${TESTNET_MAGIC:-1}"

WALLETS_DIR="$__BOOTSTRAP_DIR/wallets"
: "${BOOTSTRAP_ADDR:=$([[ -f "$WALLETS_DIR/payment.$NETWORK.addr" ]] && cat "$WALLETS_DIR/payment.$NETWORK.addr" || echo '')}"
: "${PAYMENT_SKEY:=$WALLETS_DIR/payment.skey}"

REPO_ROOT="$(cd "$__BOOTSTRAP_DIR/../.." && pwd)"
ARTIFACTS_DIR="$REPO_ROOT/artifacts/$NETWORK"
TMP_DIR="$ARTIFACTS_DIR/tmp"
mkdir -p "$TMP_DIR"

REF_PUBLISH_LOVELACE="${REF_PUBLISH_LOVELACE:-25000000}"

# txid from a signed tx file. cardano-cli outputs JSON {"txhash":"…"} on
# newer releases; grep extracts the 64-char hex.
txid_of_file() {
  cardano-cli conway transaction txid --tx-file "$1" \
    | grep -oE '[a-f0-9]{64}' | head -n1
}

# Pre-flight checks shared by every publish stage.
require_ready_addresses() {
  if [[ "$(jq -r '.mixLogicScriptHash // empty' "$ARTIFACTS_DIR/addresses.json")" == "" ]]; then
    echo "$1: addresses.json missing mixLogicScriptHash — run 00-build-reference.sh first" >&2
    exit 1
  fi
}

# Query protocol params (build-fee math + cost model) into tmp/protocol.json.
fetch_protocol_params() {
  cardano-cli conway query protocol-parameters \
    --testnet-magic "$TESTNET_MAGIC" \
    --out-file "$TMP_DIR/protocol.json"
}

# Snapshot the wallet's UTxOs into tmp/wallet.utxo.json.
fetch_wallet_utxos() {
  cardano-cli conway query utxo \
    --testnet-magic "$TESTNET_MAGIC" \
    --address "$BOOTSTRAP_ADDR" \
    --out-file "$TMP_DIR/wallet.utxo.json"
  if [[ "$(jq 'length' "$TMP_DIR/wallet.utxo.json")" == "0" ]]; then
    echo "$1: wallet has no UTxOs at $BOOTSTRAP_ADDR" >&2
    exit 1
  fi
}

# Build a `--tx-in <ref> --tx-in <ref> …` string of every wallet UTxO except
# SEED and COLLATERAL (those are reserved for stages 02 and 04 respectively).
# Echoes the joined string. Caller embeds it into `cardano-cli transaction build`.
collect_spendable_inputs() {
  local seed="${SEED:-}"
  local collat="${COLLATERAL:-}"
  jq -r \
    --arg seed "$seed" \
    --arg collat "$collat" \
    'to_entries
     | map(.key | select(. != $seed and . != $collat))
     | map("--tx-in " + .)
     | join(" ")' \
    "$TMP_DIR/wallet.utxo.json"
}

# Common build + sign + submit pipeline for the three ref-script publish
# stages (no Plutus execution, no collateral).
#
# Args:
#   $1 stage tag  (e.g. "01a-publish-mix-box")
#   $2 plutus filename inside ARTIFACTS_DIR
publish_ref_script() {
  local stage="$1" script="$2"
  fetch_protocol_params
  fetch_wallet_utxos "$stage"
  local tx_in_args
  tx_in_args=$(collect_spendable_inputs)
  if [[ -z "$tx_in_args" ]]; then
    echo "$stage: no spendable UTxOs at $BOOTSTRAP_ADDR (after excluding SEED + COLLATERAL)" >&2
    exit 1
  fi

  local tx_raw="$ARTIFACTS_DIR/$stage.txraw"

  # shellcheck disable=SC2086
  cardano-cli conway transaction build \
    --testnet-magic "$TESTNET_MAGIC" \
    $tx_in_args \
    --tx-out "$BOOTSTRAP_ADDR + $REF_PUBLISH_LOVELACE lovelace" \
    --tx-out-reference-script-file "$ARTIFACTS_DIR/$script" \
    --change-address "$BOOTSTRAP_ADDR" \
    --out-file "$tx_raw"

  cardano-cli conway transaction sign \
    --tx-body-file "$tx_raw" \
    --signing-key-file "$PAYMENT_SKEY" \
    --testnet-magic "$TESTNET_MAGIC" \
    --out-file "$ARTIFACTS_DIR/$stage.tx"

  cardano-cli conway transaction submit \
    --testnet-magic "$TESTNET_MAGIC" \
    --tx-file "$ARTIFACTS_DIR/$stage.tx"

  local tx_id
  tx_id=$(txid_of_file "$ARTIFACTS_DIR/$stage.tx")
  echo "$stage: submitted txid $tx_id"
  echo "  ref UTxO: ${tx_id}#0"

  # Persist into addresses.json.
  local key="$3"
  local tmp
  tmp=$(mktemp)
  jq --arg key "$key" --arg ref "$tx_id#0" '
    .referenceScriptUtxos = (.referenceScriptUtxos // {})
    | .referenceScriptUtxos[$key] = $ref
  ' "$ARTIFACTS_DIR/addresses.json" > "$tmp"
  mv "$tmp" "$ARTIFACTS_DIR/addresses.json"
}
