#!/usr/bin/env bash
# 03-fund-fee-contract.sh — seed a single 5-ADA UTxO at the fee_contract
# address with an inline () datum. We're not seeding the full
# fee_shard_target (=10) shard pool yet — one shard is enough to test the
# Deposit / Mix / Withdraw flows end-to-end. The full pool gets seeded in a
# later milestone once the SDK can pick a shard at random.
#
# Inputs (env):
#   NETWORK            — "preprod" | "test" (default: preprod)
#   TESTNET_MAGIC      — default 1 (Preprod)
#   BOOTSTRAP_ADDR     — wallet supplying lovelace; receives the change
#   PAYMENT_SKEY       — bootstrap wallet signing key
#   FUNDING_STAGE3     — "<txid>#<idx>" funding UTxO; the rest goes to change
#   SHARD_LOVELACE     — lovelace at the seeded shard (default: 5_000_000)
#
# Reads:
#   artifacts/<network>/{fee_contract.plutus, addresses.json}
#
# Writes:
#   artifacts/<network>/addresses.json     (feeShardUtxos = ["<txid>#0"])

set -euo pipefail

__ENV_FILE="$(cd "$(dirname "$0")" && pwd)/.env"
[[ -f "$__ENV_FILE" ]] && { set -a; source "$__ENV_FILE"; set +a; }

NETWORK="${NETWORK:-preprod}"
TESTNET_MAGIC="${TESTNET_MAGIC:-1}"
BOOTSTRAP_ADDR="${BOOTSTRAP_ADDR:?}"
PAYMENT_SKEY="${PAYMENT_SKEY:?}"
FUNDING_STAGE3="${FUNDING_STAGE3:?FUNDING_STAGE3 required (run ./balance.sh to see the four export lines)}"

SHARD_LOVELACE="${SHARD_LOVELACE:-5000000}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ARTIFACTS_DIR="$REPO_ROOT/artifacts/$NETWORK"

FEE_ADDR=$(cardano-cli address build \
  --payment-script-file "$ARTIFACTS_DIR/fee_contract.plutus" \
  --testnet-magic "$TESTNET_MAGIC")

UNIT_DATUM_FILE="$ARTIFACTS_DIR/unit-datum.json"
echo '{"constructor":0,"fields":[]}' > "$UNIT_DATUM_FILE"

TX_RAW="$ARTIFACTS_DIR/03-fund-fee-contract.txraw"
cardano-cli conway transaction build \
  --testnet-magic "$TESTNET_MAGIC" \
  --tx-in "$FUNDING_STAGE3" \
  --tx-out "$FEE_ADDR + $SHARD_LOVELACE lovelace" \
  --tx-out-inline-datum-file "$UNIT_DATUM_FILE" \
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

TMP=$(mktemp)
jq --arg ref "$TX_ID#0" '.feeShardUtxos = [$ref]' "$ARTIFACTS_DIR/addresses.json" > "$TMP"
mv "$TMP" "$ARTIFACTS_DIR/addresses.json"

echo "03-fund-fee-contract: 1 shard funded at $SHARD_LOVELACE lovelace (${TX_ID}#0)"
