#!/usr/bin/env bash
# 03-fund-fee-contract.sh — seed N fee shards at the fee_contract address,
# each carrying SHARD_LOVELACE and an inline () datum. The SDK + backend
# pick a shard uniformly at random per Mix tx, so N controls the
# concurrency ceiling. Spec calls for N=10 (docs/spec/03-contracts.md §3),
# matched by docs/next-redeploy.md and infra/bootstrap/README.md.
#
# All N shards are minted in a single tx (one funding input → N script
# outputs at positions 0..N-1, plus a change output to BOOTSTRAP_ADDR).
# That keeps fee overhead low and makes the resulting feeShardUtxos
# trivially `[<txid>#0, …, <txid>#(N-1)]`.
#
# Inputs (env):
#   NETWORK            — "preprod" | "test" (default: preprod)
#   TESTNET_MAGIC      — default 1 (Preprod)
#   BOOTSTRAP_ADDR     — wallet supplying lovelace; receives the change
#   PAYMENT_SKEY       — bootstrap wallet signing key
#   FUNDING_STAGE3     — "<txid>#<idx>" funding UTxO; the rest goes to change.
#                        Must hold ≥ N × SHARD_LOVELACE + tx fee (≈ 1 ADA).
#   SHARD_LOVELACE     — lovelace at each shard (default: 5_000_000 = 5 ADA)
#   SHARD_COUNT        — number of shards to seed (default: 10)
#
# Reads:
#   artifacts/<network>/{fee_contract.plutus, addresses.json}
#
# Writes:
#   artifacts/<network>/addresses.json
#     feeShardUtxos = ["<txid>#0", "<txid>#1", …, "<txid>#(N-1)"]

set -euo pipefail

__ENV_FILE="$(cd "$(dirname "$0")" && pwd)/.env"
[[ -f "$__ENV_FILE" ]] && { set -a; source "$__ENV_FILE"; set +a; }

NETWORK="${NETWORK:-preprod}"
TESTNET_MAGIC="${TESTNET_MAGIC:-1}"
BOOTSTRAP_ADDR="${BOOTSTRAP_ADDR:?}"
PAYMENT_SKEY="${PAYMENT_SKEY:?}"
FUNDING_STAGE3="${FUNDING_STAGE3:?FUNDING_STAGE3 required (run ./balance.sh to see the four export lines)}"

SHARD_LOVELACE="${SHARD_LOVELACE:-5000000}"
SHARD_COUNT="${SHARD_COUNT:-10}"

if ! [[ "$SHARD_COUNT" =~ ^[1-9][0-9]*$ ]]; then
  echo "03-fund-fee-contract: SHARD_COUNT must be a positive integer (got: $SHARD_COUNT)" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ARTIFACTS_DIR="$REPO_ROOT/artifacts/$NETWORK"

FEE_ADDR=$(cardano-cli address build \
  --payment-script-file "$ARTIFACTS_DIR/fee_contract.plutus" \
  --testnet-magic "$TESTNET_MAGIC")

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
  --testnet-magic "$TESTNET_MAGIC" \
  --tx-in "$FUNDING_STAGE3" \
  "${TX_OUT_ARGS[@]}" \
  --change-address "$BOOTSTRAP_ADDR" \
  --out-file "$TX_RAW"

cardano-cli conway transaction sign \
  --tx-body-file "$TX_RAW" \
  --signing-key-file "$PAYMENT_SKEY" \
  --testnet-magic "$TESTNET_MAGIC" \
  --out-file "$ARTIFACTS_DIR/03-fund-fee-contract.tx"

cardano-cli conway transaction submit \
  --testnet-magic "$TESTNET_MAGIC" \
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
