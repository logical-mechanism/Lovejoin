#!/usr/bin/env bash
# prep-utxos.sh — split the wallet's funding UTxO into the four shapes the
# bootstrap stages need:
#
#   A (FUNDING_STAGE1):   ~85 ADA  — 01-publish-and-register's funding chain
#   B (COLLATERAL):        ~10 ADA  — collateral for stage 1 (tx 4) + stage 2;
#                                     ada-only, returned by the ledger under
#                                     happy path so it persists across stages
#   C (SEED):               ~7 ADA  — consumed by one_shot_mint in stage 2
#   D (FUNDING_STAGE3):   ~45 ADA  — 03-fund-fee-contract's funding
#
# After this tx confirms, query the wallet (`cardano-cli query utxo`) and copy
# the four UTxO refs into the env vars listed at the bottom.
#
# Idempotency: the script only runs if the wallet has < 4 ada-only UTxOs at
# the bootstrap address. If 4+ already exist, it assumes the split has been
# done and exits 0. (It can't tell which UTxOs are "the right ones" from
# ledger state alone — the operator picks per stage.)
#
# Inputs (env):
#   NETWORK            — preprod | preview (default: preprod)
#   TESTNET_MAGIC      — default 1 (Preprod) — passed via --testnet-magic.
#   CARDANO_NODE_SOCKET_PATH must point to a synced node.
#   BOOTSTRAP_ADDR     — wallet address (from infra/bootstrap/wallets/).
#   PAYMENT_SKEY       — path to payment.skey.
#   SOURCE_UTXO        — UTxO to split (default: the largest ada-only UTxO at
#                        BOOTSTRAP_ADDR — e.g. the faucet drop).
#
# Output sizes can be overridden:
#   STAGE1_LOVELACE    — default 85_000_000
#   COLLATERAL_LOVELACE — default 10_000_000
#   SEED_LOVELACE      — default  7_000_000
#   STAGE3_LOVELACE    — default 45_000_000

set -euo pipefail

__ENV_FILE="$(cd "$(dirname "$0")" && pwd)/.env"
[[ -f "$__ENV_FILE" ]] && { set -a; source "$__ENV_FILE"; set +a; }

NETWORK="${NETWORK:-preprod}"
TESTNET_MAGIC="${TESTNET_MAGIC:-1}"
BOOTSTRAP_ADDR="${BOOTSTRAP_ADDR:?BOOTSTRAP_ADDR required}"
PAYMENT_SKEY="${PAYMENT_SKEY:?PAYMENT_SKEY required}"

STAGE1_LOVELACE="${STAGE1_LOVELACE:-85000000}"
COLLATERAL_LOVELACE="${COLLATERAL_LOVELACE:-10000000}"
SEED_LOVELACE="${SEED_LOVELACE:-7000000}"
STAGE3_LOVELACE="${STAGE3_LOVELACE:-45000000}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ARTIFACTS_DIR="$REPO_ROOT/artifacts/$NETWORK"
mkdir -p "$ARTIFACTS_DIR"

UTXO_JSON="$ARTIFACTS_DIR/prep-utxos.utxo.json"
cardano-cli conway query utxo \
  --testnet-magic "$TESTNET_MAGIC" \
  --address "$BOOTSTRAP_ADDR" \
  --out-file "$UTXO_JSON"

# Idempotency check. Count ada-only UTxOs (no native assets) at BOOTSTRAP_ADDR.
ADA_ONLY_COUNT=$(jq '[to_entries[] | select(.value.value | keys | length == 1)] | length' "$UTXO_JSON")
if [[ "$ADA_ONLY_COUNT" -ge 4 ]]; then
  echo "prep-utxos: $ADA_ONLY_COUNT ada-only UTxOs already at $BOOTSTRAP_ADDR (≥ 4 required)."
  echo "             Assuming the split is done. Re-run with a clean wallet to redo."
  echo
  echo "Current ada-only UTxOs (sorted by lovelace):"
  jq -r '
    to_entries
    | map(select(.value.value | keys | length == 1))
    | map({ ref: .key, lovelace: .value.value.lovelace })
    | sort_by(-.lovelace)[]
    | "  \(.ref)  \(.lovelace) lovelace"
  ' "$UTXO_JSON"
  exit 0
fi

# Pick SOURCE_UTXO if not given: largest ada-only UTxO.
if [[ -z "${SOURCE_UTXO:-}" ]]; then
  SOURCE_UTXO=$(jq -r '
    to_entries
    | map(select(.value.value | keys | length == 1))
    | sort_by(-.value.value.lovelace)
    | .[0].key // empty
  ' "$UTXO_JSON")
  if [[ -z "$SOURCE_UTXO" ]]; then
    echo "prep-utxos: no ada-only UTxOs at $BOOTSTRAP_ADDR — fund the wallet first" >&2
    exit 1
  fi
fi

REQUIRED=$(( STAGE1_LOVELACE + COLLATERAL_LOVELACE + SEED_LOVELACE + STAGE3_LOVELACE + 5000000 ))  # +5 ADA buffer for fee + min-utxo
SOURCE_LOVELACE=$(jq -r --arg ref "$SOURCE_UTXO" '.[$ref].value.lovelace' "$UTXO_JSON")
if [[ "$SOURCE_LOVELACE" -lt "$REQUIRED" ]]; then
  echo "prep-utxos: SOURCE_UTXO ($SOURCE_UTXO) has $SOURCE_LOVELACE lovelace, need at least $REQUIRED" >&2
  exit 1
fi

echo "prep-utxos: splitting $SOURCE_UTXO ($SOURCE_LOVELACE lovelace) at $BOOTSTRAP_ADDR"
echo "  output 0: $STAGE1_LOVELACE lovelace  (FUNDING for 01-publish-and-register)"
echo "  output 1: $COLLATERAL_LOVELACE lovelace  (COLLATERAL for stages 1 & 2)"
echo "  output 2: $SEED_LOVELACE lovelace  (SEED for 02-mint-and-lock)"
echo "  output 3: $STAGE3_LOVELACE lovelace  (FUNDING for 03-fund-fee-contract)"
echo "  output 4: change"

TX_RAW="$ARTIFACTS_DIR/prep-utxos.txraw"
cardano-cli conway transaction build \
  --testnet-magic "$TESTNET_MAGIC" \
  --tx-in "$SOURCE_UTXO" \
  --tx-out "$BOOTSTRAP_ADDR + $STAGE1_LOVELACE lovelace" \
  --tx-out "$BOOTSTRAP_ADDR + $COLLATERAL_LOVELACE lovelace" \
  --tx-out "$BOOTSTRAP_ADDR + $SEED_LOVELACE lovelace" \
  --tx-out "$BOOTSTRAP_ADDR + $STAGE3_LOVELACE lovelace" \
  --change-address "$BOOTSTRAP_ADDR" \
  --out-file "$TX_RAW"

cardano-cli conway transaction sign \
  --tx-body-file "$TX_RAW" \
  --signing-key-file "$PAYMENT_SKEY" \
  --testnet-magic "$TESTNET_MAGIC" \
  --out-file "$ARTIFACTS_DIR/prep-utxos.tx"

cardano-cli conway transaction submit \
  --testnet-magic "$TESTNET_MAGIC" \
  --tx-file "$ARTIFACTS_DIR/prep-utxos.tx"

TX_ID=$(cardano-cli conway transaction txid --tx-file "$ARTIFACTS_DIR/prep-utxos.tx")
echo
echo "prep-utxos: submitted txid $TX_ID"

cat <<EOF

# ---------------------------------------------------------------------------
# Once the prep tx confirms, paste the following into your shell:
# ---------------------------------------------------------------------------

export FUNDING_STAGE1=${TX_ID}#0   # ${STAGE1_LOVELACE} lovelace — stage 1 funding (A)
export COLLATERAL=${TX_ID}#1       # ${COLLATERAL_LOVELACE} lovelace — collateral, reused across stages 1 & 2 (B)
export SEED=${TX_ID}#2             # ${SEED_LOVELACE} lovelace — seed for one_shot_mint, consumed in stage 2 (C)
export FUNDING_STAGE3=${TX_ID}#3   # ${STAGE3_LOVELACE} lovelace — stage 3 funding (D)

# Stage 0 — offline
SEED_UTXO=\$SEED ./infra/bootstrap/00-build-reference.sh

# Stage 1 — publish refs + register cert (chain of 4 txs)
FUNDING_UTXO=\$FUNDING_STAGE1 COLLATERAL_UTXO=\$COLLATERAL \\
  ./infra/bootstrap/01-publish-and-register.sh

# Stage 2 — IRREVERSIBLE mint + lock
SEED_UTXO=\$SEED COLLATERAL_UTXO=\$COLLATERAL \\
  ./infra/bootstrap/02-mint-and-lock.sh

# Stage 3 — fund 10 fee shards
FUNDING_UTXO=\$FUNDING_STAGE3 \\
  ./infra/bootstrap/03-fund-fee-contract.sh
EOF
