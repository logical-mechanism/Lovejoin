#!/usr/bin/env bash
# prep-utxos.sh — split the wallet's funding UTxO into the four shapes the
# bootstrap stages need:
#
#   A (FUNDING_STAGE1):   ~85 ADA  — funds 01a-publish's chain (and 01b-register
#                                     picks up the chain's final change UTxO)
#   B (COLLATERAL):        ~10 ADA  — collateral for 01b-register + 02-mint-and-lock;
#                                     ada-only, returned by the ledger under
#                                     happy path so it persists across stages
#   C (SEED):               ~7 ADA  — consumed by one_shot_mint in stage 2
#   D (FUNDING_STAGE3):   ~55 ADA  — 03-fund-fee-contract's funding
#                                   (10 shards × 5 ADA + ~5 ADA buffer
#                                   for tx fee + change min-utxo).
#
# After this tx confirms, query the wallet (`cardano-cli query utxo`) and copy
# the four UTxO refs into the env vars listed at the bottom.
#
# Idempotency: the script only runs if the wallet has < 4 ada-only UTxOs at
# the bootstrap address. If 4+ already exist, it assumes the split has been
# done and exits 0. (It can't tell which UTxOs are "the right ones" from
# ledger state alone — the operator picks per stage.)
#
# Reset mode (--reset, or RESET=1): consolidate every ada-only UTxO at the
# bootstrap address into a fresh A/B/C/D split in one tx. Use this if a prior
# bootstrap stage half-completed and the wallet's UTxO shape is unrecoverable
# from the operator side. Native-asset UTxOs (e.g. the protocol NFT) are
# left alone.
#
# Inputs (env):
#   NETWORK            — preprod | preview | mainnet | test (default: preprod).
#                        mainnet requires LOVEJOIN_MAINNET_CONFIRM=yes. The
#                        per-network cardano-cli flag is derived in
#                        _lib/network.sh.
#   CARDANO_NODE_SOCKET_PATH must point to a synced node.
#   BOOTSTRAP_ADDR     — wallet address (from infra/bootstrap/wallets/).
#   PAYMENT_SKEY       — path to payment.skey.
#   SOURCE_UTXO        — UTxO to split (default: the largest ada-only UTxO at
#                        BOOTSTRAP_ADDR — e.g. the faucet drop). Ignored in
#                        reset mode.
#   RESET              — set to 1 (or pass --reset) to spend every ada-only
#                        UTxO at BOOTSTRAP_ADDR and redo the split.
#
# Output sizes can be overridden:
#   STAGE1_LOVELACE    — default 85_000_000
#   COLLATERAL_LOVELACE — default 10_000_000
#   SEED_LOVELACE      — default  7_000_000
#   STAGE3_LOVELACE    — default 55_000_000

set -euo pipefail

RESET="${RESET:-0}"
for arg in "$@"; do
  case "$arg" in
    --reset) RESET=1 ;;
    *) echo "prep-utxos: unknown arg: $arg" >&2; exit 1 ;;
  esac
done

__BOOTSTRAP_DIR="$(cd "$(dirname "$0")" && pwd)"
__ENV_FILE="$__BOOTSTRAP_DIR/.env"
[[ -f "$__ENV_FILE" ]] && { set -a; source "$__ENV_FILE"; set +a; }
# shellcheck source=_lib/network.sh
source "$__BOOTSTRAP_DIR/_lib/network.sh"

BOOTSTRAP_ADDR="${BOOTSTRAP_ADDR:?BOOTSTRAP_ADDR required}"
PAYMENT_SKEY="${PAYMENT_SKEY:?PAYMENT_SKEY required}"

STAGE1_LOVELACE="${STAGE1_LOVELACE:-85000000}"
COLLATERAL_LOVELACE="${COLLATERAL_LOVELACE:-10000000}"
SEED_LOVELACE="${SEED_LOVELACE:-7000000}"
STAGE3_LOVELACE="${STAGE3_LOVELACE:-55000000}"

REPO_ROOT="$(cd "$__BOOTSTRAP_DIR/../.." && pwd)"
ARTIFACTS_DIR="$REPO_ROOT/artifacts/$NETWORK"
mkdir -p "$ARTIFACTS_DIR"

UTXO_JSON="$ARTIFACTS_DIR/prep-utxos.utxo.json"
cardano-cli conway query utxo \
  "${CARDANO_CLI_NETWORK_FLAGS[@]}" \
  --address "$BOOTSTRAP_ADDR" \
  --out-file "$UTXO_JSON"

REQUIRED=$(( STAGE1_LOVELACE + COLLATERAL_LOVELACE + SEED_LOVELACE + STAGE3_LOVELACE + 5000000 ))  # +5 ADA buffer for fee + min-utxo
ADA_ONLY_COUNT=$(jq '[to_entries[] | select(.value.value | keys | length == 1)] | length' "$UTXO_JSON")

# Build the --tx-in list. In reset mode, sweep every ada-only UTxO at the
# wallet so transaction-build's coin selection sees the full ada balance,
# regardless of how the funds got fragmented in a half-failed prior run.
TX_IN_ARGS=()
if [[ "$RESET" == "1" ]]; then
  if [[ "$ADA_ONLY_COUNT" -eq 0 ]]; then
    echo "prep-utxos: --reset requested but no ada-only UTxOs at $BOOTSTRAP_ADDR" >&2
    exit 1
  fi
  TOTAL_ADA_ONLY=$(jq -r '[to_entries[] | select(.value.value | keys | length == 1) | .value.value.lovelace] | add' "$UTXO_JSON")
  if [[ "$TOTAL_ADA_ONLY" -lt "$REQUIRED" ]]; then
    echo "prep-utxos: --reset would consolidate $TOTAL_ADA_ONLY lovelace, need at least $REQUIRED" >&2
    exit 1
  fi
  echo "prep-utxos: --reset consolidating $ADA_ONLY_COUNT ada-only UTxOs (${TOTAL_ADA_ONLY} lovelace) at $BOOTSTRAP_ADDR"
  while IFS= read -r ref; do
    TX_IN_ARGS+=( --tx-in "$ref" )
  done < <(jq -r 'to_entries | map(select(.value.value | keys | length == 1)) | .[].key' "$UTXO_JSON")
else
  # Idempotency check. Count ada-only UTxOs (no native assets) at BOOTSTRAP_ADDR.
  if [[ "$ADA_ONLY_COUNT" -ge 4 ]]; then
    echo "prep-utxos: $ADA_ONLY_COUNT ada-only UTxOs already at $BOOTSTRAP_ADDR (≥ 4 required)."
    echo "             Assuming the split is done. Pass --reset (or RESET=1) to redo."
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

  SOURCE_LOVELACE=$(jq -r --arg ref "$SOURCE_UTXO" '.[$ref].value.lovelace' "$UTXO_JSON")
  if [[ "$SOURCE_LOVELACE" -lt "$REQUIRED" ]]; then
    echo "prep-utxos: SOURCE_UTXO ($SOURCE_UTXO) has $SOURCE_LOVELACE lovelace, need at least $REQUIRED" >&2
    exit 1
  fi

  echo "prep-utxos: splitting $SOURCE_UTXO ($SOURCE_LOVELACE lovelace) at $BOOTSTRAP_ADDR"
  TX_IN_ARGS=( --tx-in "$SOURCE_UTXO" )
fi

echo "  output 0: $STAGE1_LOVELACE lovelace  (FUNDING for 01a-publish)"
echo "  output 1: $COLLATERAL_LOVELACE lovelace  (COLLATERAL for stages 1 & 2)"
echo "  output 2: $SEED_LOVELACE lovelace  (SEED for 02-mint-and-lock)"
echo "  output 3: $STAGE3_LOVELACE lovelace  (FUNDING for 03-fund-fee-contract)"
echo "  output 4: change"

TX_RAW="$ARTIFACTS_DIR/prep-utxos.txraw"
cardano-cli conway transaction build \
  "${CARDANO_CLI_NETWORK_FLAGS[@]}" \
  "${TX_IN_ARGS[@]}" \
  --tx-out "$BOOTSTRAP_ADDR + $STAGE1_LOVELACE lovelace" \
  --tx-out "$BOOTSTRAP_ADDR + $COLLATERAL_LOVELACE lovelace" \
  --tx-out "$BOOTSTRAP_ADDR + $SEED_LOVELACE lovelace" \
  --tx-out "$BOOTSTRAP_ADDR + $STAGE3_LOVELACE lovelace" \
  --change-address "$BOOTSTRAP_ADDR" \
  --out-file "$TX_RAW"

cardano-cli conway transaction sign \
  --tx-body-file "$TX_RAW" \
  --signing-key-file "$PAYMENT_SKEY" \
  "${CARDANO_CLI_NETWORK_FLAGS[@]}" \
  --out-file "$ARTIFACTS_DIR/prep-utxos.tx"

cardano-cli conway transaction submit \
  "${CARDANO_CLI_NETWORK_FLAGS[@]}" \
  --tx-file "$ARTIFACTS_DIR/prep-utxos.tx"

TX_ID=$(cardano-cli conway transaction txid --tx-file "$ARTIFACTS_DIR/prep-utxos.tx" \
        | grep -oE '[a-f0-9]{64}' | head -n1)
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

# Stage 0 — offline (env vars are read directly; no renaming)
./infra/bootstrap/00-build-reference.sh

# Stage 1a — publish 3 ref scripts (chain of 3 txs via build-raw)
./infra/bootstrap/01a-publish.sh

# Wait for confirmation, then register the mix_logic stake credential
./infra/bootstrap/01b-register.sh

# Stage 2 — IRREVERSIBLE mint + lock
./infra/bootstrap/02-mint-and-lock.sh

# Stage 3 — fund 10 fee shards
./infra/bootstrap/03-fund-fee-contract.sh
EOF
