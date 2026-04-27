#!/usr/bin/env bash
# balance.sh — pretty-print the bootstrap wallet's UTxOs and total balance,
# annotated with the bootstrap-stage role of each UTxO when known.
#
# How the labels work: prep-utxos.sh splits the faucet drop into 4 outputs at
# fixed indices (0..3) of a known tx. After that tx confirms, balance.sh
# reads artifacts/<network>/prep-utxos.tx to learn the txid, then matches it
# against the wallet's UTxOs and labels them:
#
#   <PREP_TXID>#0 → FUNDING_STAGE1
#   <PREP_TXID>#1 → COLLATERAL
#   <PREP_TXID>#2 → SEED
#   <PREP_TXID>#3 → FUNDING_STAGE3
#
# UTxOs not from prep-utxos (the original faucet drop, change from later
# stages, etc.) print without a label.
#
# Inputs (env):
#   NETWORK            — preprod | preview (default: preprod)
#   TESTNET_MAGIC      — default 1 (Preprod)
#   CARDANO_NODE_SOCKET_PATH must point to a synced node.
#   BOOTSTRAP_ADDR     — overrides the address file lookup.

set -euo pipefail

__ENV_FILE="$(cd "$(dirname "$0")" && pwd)/.env"
[[ -f "$__ENV_FILE" ]] && { set -a; source "$__ENV_FILE"; set +a; }

NETWORK="${NETWORK:-preprod}"
TESTNET_MAGIC="${TESTNET_MAGIC:-1}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WALLETS_DIR="$SCRIPT_DIR/wallets"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ARTIFACTS_DIR="$REPO_ROOT/artifacts/$NETWORK"

if [[ -z "${BOOTSTRAP_ADDR:-}" ]]; then
  ADDR_FILE="$WALLETS_DIR/payment.$NETWORK.addr"
  if [[ ! -f "$ADDR_FILE" ]]; then
    echo "balance: $ADDR_FILE not found — run init-wallet.sh first, or set BOOTSTRAP_ADDR" >&2
    exit 1
  fi
  BOOTSTRAP_ADDR=$(cat "$ADDR_FILE")
fi

# Discover the prep-utxos tx (if any) so we can label outputs 0..3.
PREP_TXID=""
PREP_TX_FILE="$ARTIFACTS_DIR/prep-utxos.tx"
if [[ -f "$PREP_TX_FILE" ]]; then
  PREP_TXID=$(cardano-cli conway transaction txid --tx-file "$PREP_TX_FILE" 2>/dev/null || echo "")
fi

UTXO_JSON=$(mktemp)
trap 'rm -f "$UTXO_JSON"' EXIT

cardano-cli conway query utxo \
  --testnet-magic "$TESTNET_MAGIC" \
  --address "$BOOTSTRAP_ADDR" \
  --out-file "$UTXO_JSON"

COUNT=$(jq 'length' "$UTXO_JSON")
if [[ "$COUNT" -eq 0 ]]; then
  echo "balance: no UTxOs at $BOOTSTRAP_ADDR (network=$NETWORK)"
  echo "         Fund this address from the faucet:"
  echo "         $BOOTSTRAP_ADDR"
  exit 0
fi

echo "wallet:  $BOOTSTRAP_ADDR"
echo "network: $NETWORK (magic $TESTNET_MAGIC)"
echo "utxos:   $COUNT"
if [[ -n "$PREP_TXID" ]]; then
  echo "prep:    $PREP_TXID  (outputs 0..3 labeled below)"
fi
echo

# Per-UTxO breakdown sorted by lovelace descending. ada-only UTxOs flagged.
# When a UTxO matches one of prep-utxos's first four outputs, prepend its role.
jq -r --arg prepTxid "$PREP_TXID" '
  def role(ref):
    if $prepTxid == "" then ""
    else
      ref as $r
      | (if   $r == ($prepTxid + "#0") then "FUNDING_STAGE1 "
         elif $r == ($prepTxid + "#1") then "COLLATERAL     "
         elif $r == ($prepTxid + "#2") then "SEED           "
         elif $r == ($prepTxid + "#3") then "FUNDING_STAGE3 "
         else                             "                "
         end)
    end;
  to_entries
  | sort_by(-.value.value.lovelace)
  | .[]
  | "  " + role(.key) + " \(.key)  \(.value.value.lovelace) lovelace" +
    (if (.value.value | keys | length) == 1 then "  *ada-only" else "  +assets(" + ((.value.value | keys | length) - 1 | tostring) + " policies)" end)
' "$UTXO_JSON"

TOTAL=$(jq '[ to_entries[].value.value.lovelace ] | add' "$UTXO_JSON")
ADA_ONLY=$(jq '[ to_entries[] | select(.value.value | keys | length == 1) ] | length' "$UTXO_JSON")
echo
printf "  total:         %s lovelace  (%.2f ADA)\n" "$TOTAL" "$(echo "scale=2; $TOTAL / 1000000" | bc)"
echo "  ada-only:      $ADA_ONLY UTxOs"

# If prep ran, print the four export lines too — copy-pasteable.
if [[ -n "$PREP_TXID" ]]; then
  cat <<EOF

# Bootstrap-stage env vars (paste into your shell):
export FUNDING_STAGE1=${PREP_TXID}#0
export COLLATERAL=${PREP_TXID}#1
export SEED=${PREP_TXID}#2
export FUNDING_STAGE3=${PREP_TXID}#3
EOF
fi
