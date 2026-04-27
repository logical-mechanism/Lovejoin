#!/usr/bin/env bash
# balance.sh — pretty-print the bootstrap wallet's UTxOs and total balance.
#
# Useful for: confirming the faucet drop arrived, picking which UTxO to use
# as SOURCE for prep-utxos, sanity-checking the wallet between bootstrap
# stages, and confirming the change UTxO from a stage made it back.
#
# Inputs (env):
#   NETWORK            — preprod | preview (default: preprod). Used only to
#                        find the address file under wallets/.
#   TESTNET_MAGIC      — default 1 (Preprod).
#   CARDANO_NODE_SOCKET_PATH must point to a synced node.
#   BOOTSTRAP_ADDR     — overrides the address file lookup.
#
# Usage:
#   ./balance.sh                      # current network's wallet
#   NETWORK=preview ./balance.sh
#   BOOTSTRAP_ADDR=addr_test1... ./balance.sh

set -euo pipefail

NETWORK="${NETWORK:-preprod}"
TESTNET_MAGIC="${TESTNET_MAGIC:-1}"

WALLETS_DIR="$(cd "$(dirname "$0")" && pwd)/wallets"

if [[ -z "${BOOTSTRAP_ADDR:-}" ]]; then
  ADDR_FILE="$WALLETS_DIR/payment.$NETWORK.addr"
  if [[ ! -f "$ADDR_FILE" ]]; then
    echo "balance: $ADDR_FILE not found — run init-wallet.sh first, or set BOOTSTRAP_ADDR" >&2
    exit 1
  fi
  BOOTSTRAP_ADDR=$(cat "$ADDR_FILE")
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
echo

# Per-UTxO breakdown sorted by lovelace descending. ada-only UTxOs are flagged
# (* on the right) so prep-utxos's "≥ 4 ada-only required" is easy to verify.
jq -r '
  to_entries
  | sort_by(-.value.value.lovelace)
  | .[]
  | "  \(.key)  \(.value.value.lovelace) lovelace" +
    (if (.value.value | keys | length) == 1 then "  *ada-only" else "  +assets(" + ((.value.value | keys | length) - 1 | tostring) + " policies)" end)
' "$UTXO_JSON"

TOTAL=$(jq '[ to_entries[].value.value.lovelace ] | add' "$UTXO_JSON")
ADA_ONLY=$(jq '[ to_entries[] | select(.value.value | keys | length == 1) ] | length' "$UTXO_JSON")
echo
printf "  total:         %s lovelace  (%.2f ADA)\n" "$TOTAL" "$(echo "scale=2; $TOTAL / 1000000" | bc)"
echo "  ada-only:      $ADA_ONLY UTxOs"
