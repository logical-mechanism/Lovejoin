#!/usr/bin/env bash
# stamp-start-point.sh — record the bootstrap tx's predecessor block in
# addresses.json so the self-hosted backend's chainsync can skip ahead
# from genesis to a usable intersection.
#
# Run AFTER the bootstrap tx (02-mint-and-lock.sh) has confirmed. Picks
# up the txid from `referenceUtxoRef`, asks Blockfrost for that tx's
# containing block, then asks Blockfrost for the previous block — that
# is the intersection we want, because ogmios's chainsync resumes from
# the block AFTER the intersection point.
#
# Usage:
#   NETWORK=preprod BLOCKFROST_PROJECT_ID=preprod... ./stamp-start-point.sh
#
# Idempotent: re-running just overwrites the field.

set -euo pipefail

NETWORK="${NETWORK:-preprod}"
PROJECT_ID="${BLOCKFROST_PROJECT_ID:-${BLOCKFROST_PROJECT_ID_PREPROD:-}}"

case "$NETWORK" in
  mainnet)  BASE_URL="https://cardano-mainnet.blockfrost.io/api/v0" ;;
  preprod)  BASE_URL="https://cardano-preprod.blockfrost.io/api/v0" ;;
  preview)  BASE_URL="https://cardano-preview.blockfrost.io/api/v0" ;;
  *) echo "stamp-start-point: unknown NETWORK=$NETWORK" >&2; exit 1 ;;
esac

if [ -z "$PROJECT_ID" ]; then
  echo "stamp-start-point: BLOCKFROST_PROJECT_ID (or BLOCKFROST_PROJECT_ID_PREPROD) not set" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ADDRESSES="$ROOT/artifacts/$NETWORK/addresses.json"

if [ ! -f "$ADDRESSES" ]; then
  echo "stamp-start-point: $ADDRESSES not found" >&2
  exit 1
fi

REF=$(jq -r '.referenceUtxoRef // empty' "$ADDRESSES")
if [ -z "$REF" ]; then
  echo "stamp-start-point: referenceUtxoRef missing — run 02-mint-and-lock.sh first" >&2
  exit 1
fi
TX_ID="${REF%%#*}"

# Look up the bootstrap tx's block hash.
TX_JSON=$(curl -sf -H "project_id: $PROJECT_ID" "$BASE_URL/txs/$TX_ID")
BOOTSTRAP_BLOCK=$(echo "$TX_JSON" | jq -r '.block')

# Walk one block back. ogmios's findIntersection sets the intersection
# AT the given point and resumes from the NEXT block, so we need the
# block before the bootstrap to make sure the bootstrap mint itself is
# applied.
BLOCK_JSON=$(curl -sf -H "project_id: $PROJECT_ID" "$BASE_URL/blocks/$BOOTSTRAP_BLOCK")
PREV_HASH=$(echo "$BLOCK_JSON" | jq -r '.previous_block')
PREV_JSON=$(curl -sf -H "project_id: $PROJECT_ID" "$BASE_URL/blocks/$PREV_HASH")
PREV_SLOT=$(echo "$PREV_JSON" | jq -r '.slot')
PREV_HEIGHT=$(echo "$PREV_JSON" | jq -r '.height')

TMP=$(mktemp)
jq \
  --argjson slot "$PREV_SLOT" \
  --arg hash "$PREV_HASH" \
  '.bootstrapStartPoint = {slot: $slot, blockHash: $hash}' \
  "$ADDRESSES" > "$TMP"
mv "$TMP" "$ADDRESSES"

echo "stamp-start-point: bootstrapStartPoint written to $ADDRESSES"
echo "  slot=$PREV_SLOT height=$PREV_HEIGHT hash=$PREV_HASH"
echo "  (block immediately before bootstrap tx $TX_ID)"
