#!/usr/bin/env bash
# 03-fund-fee-contract.sh — seed N fee shards at the fee_contract address,
# each carrying SHARD_LOVELACE and an inline () datum. The SDK + backend
# pick a shard uniformly at random per Mix tx, so N controls the
# concurrency ceiling. The protocol calls for N=10.
#
# All N shards are minted in a single tx (one funding input → N script
# outputs at positions 0..N-1, plus a change output to BOOTSTRAP_ADDR).
# That keeps fee overhead low and makes the resulting feeShardUtxos
# trivially `[<txid>#0, …, <txid>#(N-1)]`.
#
# Inputs (env or first positional):
#   NETWORK            — preprod | preview | mainnet | test (default: preprod).
#                        mainnet requires LOVEJOIN_MAINNET_CONFIRM=yes. The
#                        per-network cardano-cli flag is derived in
#                        _lib/network.sh.
#   BOOTSTRAP_ADDR     — wallet supplying lovelace; receives the change
#   PAYMENT_SKEY       — bootstrap wallet signing key
#   FUNDING_STAGE3     — "<txid>#<idx>" funding UTxO; the rest goes to change.
#                        Must hold ≥ N × SHARD_LOVELACE + tx fee (≈ 1 ADA).
#   SHARD_LOVELACE     — lovelace at each shard (default: 5_000_000 = 5 ADA)
#   SHARD_COUNT        — number of shards to seed (default: 10).
#                        Also accepted as the first positional arg:
#                        `./03-fund-fee-contract.sh 5` → SHARD_COUNT=5.
#
# Reads:
#   artifacts/<network>/{fee_contract.plutus, addresses.json}
#
# Writes:
#   artifacts/<network>/addresses.json
#     feeShardUtxos = ["<txid>#0", "<txid>#1", …, "<txid>#(N-1)"]

set -euo pipefail

__BOOTSTRAP_DIR="$(cd "$(dirname "$0")" && pwd)"
__ENV_FILE="$__BOOTSTRAP_DIR/.env"
[[ -f "$__ENV_FILE" ]] && { set -a; source "$__ENV_FILE"; set +a; }
# shellcheck source=_lib/network.sh
source "$__BOOTSTRAP_DIR/_lib/network.sh"

BOOTSTRAP_ADDR="${BOOTSTRAP_ADDR:?}"
PAYMENT_SKEY="${PAYMENT_SKEY:?}"
FUNDING_STAGE3="${FUNDING_STAGE3:?FUNDING_STAGE3 required (run ./balance.sh to see the four export lines)}"

SHARD_LOVELACE="${SHARD_LOVELACE:-5000000}"
SHARD_COUNT="${SHARD_COUNT:-${1:-10}}"

if ! [[ "$SHARD_COUNT" =~ ^[1-9][0-9]*$ ]]; then
  echo "03-fund-fee-contract: SHARD_COUNT must be a positive integer (got: $SHARD_COUNT)" >&2
  exit 1
fi

REPO_ROOT="$(cd "$__BOOTSTRAP_DIR/../.." && pwd)"
ARTIFACTS_DIR="$REPO_ROOT/artifacts/$NETWORK"

FEE_ADDR=$(cardano-cli address build \
  --payment-script-file "$ARTIFACTS_DIR/fee_contract.plutus" \
  "${CARDANO_CLI_NETWORK_FLAGS[@]}")

UNIT_DATUM_FILE="$ARTIFACTS_DIR/unit-datum.json"
echo '{"constructor":0,"fields":[]}' > "$UNIT_DATUM_FILE"

# Build N tx-out args, each with the inline () datum. cardano-cli applies
# `--tx-out-inline-datum-file` to the most-recently-emitted `--tx-out`,
# so they have to be paired in order.
TX_OUT_ARGS=()
for ((i = 0; i < SHARD_COUNT; i++)); do
  TX_OUT_ARGS+=(--tx-out "$FEE_ADDR + $SHARD_LOVELACE lovelace" --tx-out-inline-datum-file "$UNIT_DATUM_FILE")
done

TX_RAW="$ARTIFACTS_DIR/03-fund-fee-contract.txraw"
cardano-cli conway transaction build \
  "${CARDANO_CLI_NETWORK_FLAGS[@]}" \
  --tx-in "$FUNDING_STAGE3" \
  "${TX_OUT_ARGS[@]}" \
  --change-address "$BOOTSTRAP_ADDR" \
  --out-file "$TX_RAW"

cardano-cli conway transaction sign \
  --tx-body-file "$TX_RAW" \
  --signing-key-file "$PAYMENT_SKEY" \
  "${CARDANO_CLI_NETWORK_FLAGS[@]}" \
  --out-file "$ARTIFACTS_DIR/03-fund-fee-contract.tx"

cardano-cli conway transaction submit \
  "${CARDANO_CLI_NETWORK_FLAGS[@]}" \
  --tx-file "$ARTIFACTS_DIR/03-fund-fee-contract.tx"

TX_ID=$(cardano-cli conway transaction txid --tx-file "$ARTIFACTS_DIR/03-fund-fee-contract.tx" \
        | grep -oE '[a-f0-9]{64}' | head -n1)
echo "03-fund-fee-contract: submitted txid $TX_ID"

# feeShardUtxos = ["<txid>#0", …, "<txid>#(N-1)"]. The change output is at
# position SHARD_COUNT and is NOT a fee shard — it stays in the bootstrap
# wallet for follow-up ops.
TMP=$(mktemp)
jq --arg txid "$TX_ID" --argjson n "$SHARD_COUNT" '
  .feeShardUtxos = [range(0; $n) | "\($txid)#\(.)"]
' "$ARTIFACTS_DIR/addresses.json" > "$TMP"
mv "$TMP" "$ARTIFACTS_DIR/addresses.json"

TOTAL_LOVELACE=$((SHARD_COUNT * SHARD_LOVELACE))
echo "03-fund-fee-contract: $SHARD_COUNT shards funded at $SHARD_LOVELACE lovelace each (total $TOTAL_LOVELACE)"
echo "  feeShardUtxos: ${TX_ID}#0 .. ${TX_ID}#$((SHARD_COUNT - 1))"
