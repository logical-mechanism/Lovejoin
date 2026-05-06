#!/usr/bin/env bash
# 02-mint-and-lock.sh — single tx that:
#   * spends SEED from BOOTSTRAP_ADDR (consumed by one_shot_mint policy)
#   * mints exactly 1 NFT under one_shot_mint(SEED)
#   * locks the NFT at reference_holder with the inline ReferenceDatum carrying
#     ProtocolParams.
#
# This is the IRREVERSIBLE moment of the bootstrap. Everything before it
# (00-build-reference, 01a-publish, 01b-register) can be re-run with a
# different seed if you mess up. Once this tx confirms, the protocol's
# parameters live forever at the always-False reference_holder address.
#
# Inputs (env):
#   NETWORK            — "preprod" | "test" (default: preprod)
#   TESTNET_MAGIC      — default 1 (Preprod)
#   CARDANO_NODE_SOCKET_PATH must point to a synced node.
#   BOOTSTRAP_ADDR     — wallet address.
#   SEED               — same value used in 00-build-reference.sh; consumed.
#   COLLATERAL         — separate ada-only UTxO ≥ 5 ADA. MUST NOT overlap
#                        with SEED (ledger forbids overlap).
#   PAYMENT_SKEY       — bootstrap wallet signing key.
#   LOCKED_LOVELACE    — lovelace at the reference UTxO (default 5_000_000;
#                        comfortably above the inline-datum min-UTxO floor).
#
# Reads:
#   artifacts/<network>/{one_shot_mint,reference_holder}.plutus
#   artifacts/<network>/addresses.json
#
# Writes:
#   artifacts/<network>/addresses.json     (referenceUtxoRef populated)
#
# THIS IS A ONE-SHOT IRREVERSIBLE CEREMONY. Practice on a private Preprod
# wallet first.

set -euo pipefail

__ENV_FILE="$(cd "$(dirname "$0")" && pwd)/.env"
[[ -f "$__ENV_FILE" ]] && { set -a; source "$__ENV_FILE"; set +a; }

NETWORK="${NETWORK:-preprod}"
TESTNET_MAGIC="${TESTNET_MAGIC:-1}"
BOOTSTRAP_ADDR="${BOOTSTRAP_ADDR:?}"
SEED="${SEED:?SEED required — must match the value used in 00-build-reference. Run ./balance.sh for the export lines.}"
COLLATERAL="${COLLATERAL:?COLLATERAL required (run ./balance.sh)}"
PAYMENT_SKEY="${PAYMENT_SKEY:?}"
LOCKED_LOVELACE="${LOCKED_LOVELACE:-5000000}"

if [[ "$SEED" == "$COLLATERAL" ]]; then
  echo "02-mint-and-lock: SEED and COLLATERAL must differ (ledger forbids overlap)" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ARTIFACTS_DIR="$REPO_ROOT/artifacts/$NETWORK"

REF_NFT_POLICY=$(jq -r '.referenceNftPolicy' "$ARTIFACTS_DIR/addresses.json")
REF_NFT_NAME=$(jq -r '.referenceNftAssetName' "$ARTIFACTS_DIR/addresses.json")
MIX_LOGIC_HASH=$(jq -r '.mixLogicScriptHash' "$ARTIFACTS_DIR/addresses.json")
MIX_SCRIPT_HASH=$(jq -r '.mixBoxScriptHash' "$ARTIFACTS_DIR/addresses.json")
FEE_SCRIPT_HASH=$(jq -r '.feeScriptHash' "$ARTIFACTS_DIR/addresses.json")
DENOM=$(jq -r '.protocol.denom_lovelace' "$ARTIFACTS_DIR/addresses.json")
MAX_FEE=$(jq -r '.protocol.max_fee_per_mix_lovelace' "$ARTIFACTS_DIR/addresses.json")

if [[ "$REF_NFT_POLICY" == "null" || -z "$REF_NFT_POLICY" ]]; then
  echo "02-mint-and-lock: addresses.json doesn't have referenceNftPolicy yet — run 00-build-reference.sh first" >&2
  exit 1
fi

REF_HOLDER_ADDR=$(cardano-cli address build \
  --payment-script-file "$ARTIFACTS_DIR/reference_holder.plutus" \
  --testnet-magic "$TESTNET_MAGIC")

# Inline ReferenceDatum (flat) — Constr 0 with five fields:
#   [denom, max_fee, mix_script_hash, mix_logic_hash, fee_script_hash]
# `fee_shard_target` was dropped in M4.5 — no validator reads it; the canonical
# 10-shard pool size is off-chain coordination (config/network.<net>.json).
INLINE_DATUM_FILE="$ARTIFACTS_DIR/reference_datum.json"
jq -n \
  --argjson denom "$DENOM" \
  --argjson maxFee "$MAX_FEE" \
  --arg mixHash "$MIX_SCRIPT_HASH" \
  --arg mixLogicHash "$MIX_LOGIC_HASH" \
  --arg feeHash "$FEE_SCRIPT_HASH" '{
    constructor: 0,
    fields: [
      {int: $denom},
      {int: $maxFee},
      {bytes: $mixHash},
      {bytes: $mixLogicHash},
      {bytes: $feeHash}
    ]
  }' > "$INLINE_DATUM_FILE"

EMPTY_REDEEMER_FILE="$ARTIFACTS_DIR/empty-redeemer.json"
echo '{"constructor":0,"fields":[]}' > "$EMPTY_REDEEMER_FILE"

TX_RAW="$ARTIFACTS_DIR/02-mint-and-lock.txraw"

cardano-cli conway transaction build \
  --testnet-magic "$TESTNET_MAGIC" \
  --tx-in "$SEED" \
  --tx-in-collateral "$COLLATERAL" \
  --mint "1 $REF_NFT_POLICY.$REF_NFT_NAME" \
  --mint-script-file "$ARTIFACTS_DIR/one_shot_mint.plutus" \
  --mint-redeemer-file "$EMPTY_REDEEMER_FILE" \
  --tx-out "$REF_HOLDER_ADDR + $LOCKED_LOVELACE lovelace + 1 $REF_NFT_POLICY.$REF_NFT_NAME" \
  --tx-out-inline-datum-file "$INLINE_DATUM_FILE" \
  --change-address "$BOOTSTRAP_ADDR" \
  --out-file "$TX_RAW"

cardano-cli conway transaction sign \
  --tx-body-file "$TX_RAW" \
  --signing-key-file "$PAYMENT_SKEY" \
  --testnet-magic "$TESTNET_MAGIC" \
  --out-file "$ARTIFACTS_DIR/02-mint-and-lock.tx"

cardano-cli conway transaction submit \
  --testnet-magic "$TESTNET_MAGIC" \
  --tx-file "$ARTIFACTS_DIR/02-mint-and-lock.tx"

TX_ID=$(cardano-cli conway transaction txid --tx-file "$ARTIFACTS_DIR/02-mint-and-lock.tx" \
        | grep -oE '[a-f0-9]{64}' | head -n1)
echo "02-mint-and-lock: submitted txid $TX_ID"

# Output index 0 is the NFT output (it's the first --tx-out flag).
TMP=$(mktemp)
jq --arg ref "$TX_ID#0" '.referenceUtxoRef = $ref' "$ARTIFACTS_DIR/addresses.json" > "$TMP"
mv "$TMP" "$ARTIFACTS_DIR/addresses.json"

echo "02-mint-and-lock: reference UTxO ref written to addresses.json"
echo "  ${TX_ID}#0"
echo "Wait for confirmation before running 03-fund-fee-contract.sh."
