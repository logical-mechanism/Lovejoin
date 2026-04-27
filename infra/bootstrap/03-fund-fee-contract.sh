#!/usr/bin/env bash
# 03-fund-fee-contract.sh — create exactly fee_shard_target (=10) UTxOs at the
# fee_contract address, each carrying SHARD_LOVELACE lovelace and an inline ()
# datum. PayMixFee and Replenish both preserve the shard count, so seeding the
# pool here is a one-time event.
#
# Inputs (env):
#   NETWORK            — "preprod" | "test" (default: preprod)
#   TESTNET_MAGIC      — default 1 (Preprod)
#   BOOTSTRAP_ADDR     — wallet supplying lovelace
#   PAYMENT_SKEY       — bootstrap wallet signing key
#   FUNDING_STAGE3     — "<txid>#<idx>" with enough lovelace to fund 10 shards
#                        + tx fee
#   SHARD_LOVELACE     — per-shard lovelace (default: max_fee_per_mix * 5 so a
#                        shard can absorb ~5 Mix txs before needing replenish).
#
# Reads:
#   artifacts/<network>/{fee_contract.plutus, addresses.json}
#
# Writes:
#   artifacts/<network>/addresses.json     (feeShardUtxos array populated)

set -euo pipefail

__ENV_FILE="$(cd "$(dirname "$0")" && pwd)/.env"
[[ -f "$__ENV_FILE" ]] && { set -a; source "$__ENV_FILE"; set +a; }

NETWORK="${NETWORK:-preprod}"
TESTNET_MAGIC="${TESTNET_MAGIC:-1}"
BOOTSTRAP_ADDR="${BOOTSTRAP_ADDR:?}"
PAYMENT_SKEY="${PAYMENT_SKEY:?}"
FUNDING_STAGE3="${FUNDING_STAGE3:?FUNDING_STAGE3 required (run ./balance.sh to see the four export lines)}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ARTIFACTS_DIR="$REPO_ROOT/artifacts/$NETWORK"

MAX_FEE=$(jq -r '.protocol.max_fee_per_mix_lovelace' "$ARTIFACTS_DIR/addresses.json")
SHARD_TARGET=$(jq -r '.protocol.fee_shard_target' "$ARTIFACTS_DIR/addresses.json")
SHARD_LOVELACE="${SHARD_LOVELACE:-$((MAX_FEE * 5))}"

FEE_ADDR=$(cardano-cli address build \
  --payment-script-file "$ARTIFACTS_DIR/fee_contract.plutus" \
  --testnet-magic "$TESTNET_MAGIC")

# Inline () datum file for each shard.
UNIT_DATUM_FILE="$ARTIFACTS_DIR/unit-datum.json"
echo '{"constructor":0,"fields":[]}' > "$UNIT_DATUM_FILE"

# Build the tx with N --tx-out flags, one per shard.
TX_RAW="$ARTIFACTS_DIR/03-fund-fee-contract.txraw"
TX_OUT_ARGS=()
for ((i = 0; i < SHARD_TARGET; i++)); do
  TX_OUT_ARGS+=(
    --tx-out "$FEE_ADDR + $SHARD_LOVELACE lovelace"
    --tx-out-inline-datum-file "$UNIT_DATUM_FILE"
  )
done

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

# Persist the shard refs (output indices 0..SHARD_TARGET-1).
TMP=$(mktemp)
jq --arg txId "$TX_ID" --argjson n "$SHARD_TARGET" '
  .feeShardUtxos = [range(0; $n) | "\($txId)#\(.)" ]
' "$ARTIFACTS_DIR/addresses.json" > "$TMP"
mv "$TMP" "$ARTIFACTS_DIR/addresses.json"

echo "03-fund-fee-contract: $SHARD_TARGET shards funded at $SHARD_LOVELACE lovelace each"
