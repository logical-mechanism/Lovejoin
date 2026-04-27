#!/usr/bin/env bash
# Build Lovejoin Aiken contracts and emit per-validator artifacts.
#
# Usage:
#   ./build.sh                                    # defaults to network.test.json
#   ./build.sh contracts/config/network.preprod.json
#
# Two-stage flow:
#
# Stage 1 (this script): runs `aiken build` to produce contracts/plutus.json,
# then copies it and a per-validator CBOR slice into artifacts/<network>/. We
# emit the *unparameterized* blueprint here because the parameterization chain
# (one_shot_mint(seed) → policy_id → mix_logic(NFT) → mix_box(mix_logic_cred) →
# fee_contract(NFT)) needs a concrete seed UTxO that only the bootstrap wallet
# knows. Stage 2 fills that in.
#
# Stage 2 (infra/bootstrap/00-build-reference.sh): picks a seed UTxO, calls
# `aiken blueprint apply` to parameterize each validator, then rewrites
# artifacts/<network>/addresses.json with the resolved hashes plus the
# reference UTxO ref once 01-mint-and-lock.sh has run.

set -euo pipefail

CONFIG="${1:-config/network.test.json}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Resolve config path: try as-given, then relative to repo root.
if [[ -f "$CONFIG" ]]; then
  CONFIG_PATH="$CONFIG"
elif [[ -f "$REPO_ROOT/$CONFIG" ]]; then
  CONFIG_PATH="$REPO_ROOT/$CONFIG"
else
  echo "build.sh: config not found at $CONFIG (or $REPO_ROOT/$CONFIG)" >&2
  exit 1
fi

NETWORK=$(jq -r '.network' "$CONFIG_PATH")
ARTIFACTS_DIR="$REPO_ROOT/artifacts/$NETWORK"
mkdir -p "$ARTIFACTS_DIR"

# Stage 1: aiken build → plutus.json blueprint (unparameterized templates).
( cd "$SCRIPT_DIR" && aiken build )

cp "$SCRIPT_DIR/plutus.json" "$ARTIFACTS_DIR/blueprint.json"

# Extract each validator's compiledCode into its own .plutus file in the
# standard Cardano TextEnvelope shape, so cardano-cli can ingest them.
emit_plutus() {
  local title="$1"
  local out="$2"
  local cbor
  cbor=$(jq -r --arg t "$title" '.validators[] | select(.title == $t) | .compiledCode' "$ARTIFACTS_DIR/blueprint.json")
  if [[ -z "$cbor" || "$cbor" == "null" ]]; then
    echo "build.sh: blueprint missing validator '$title'" >&2
    return 1
  fi
  jq -n --arg cbor "$cbor" --arg title "$title" '{
    type: "PlutusScriptV3",
    description: ("lovejoin: " + $title),
    cborHex: $cbor
  }' > "$ARTIFACTS_DIR/$out"
}

emit_plutus "reference_holder.reference_holder.spend" "reference_holder.plutus"
emit_plutus "one_shot_mint.one_shot_mint.mint"        "one_shot_mint.plutus"
emit_plutus "mix_box.mix_box.spend"                   "mix_box.plutus"
emit_plutus "mix_logic.mix_logic.withdraw"            "mix_logic.plutus"
emit_plutus "fee_contract.fee_contract.spend"         "fee_contract.plutus"

# addresses.json — seed offline-derivable fields, preserve post-bootstrap fields.
ADDRESSES_FILE="$ARTIFACTS_DIR/addresses.json"
if [[ -f "$ADDRESSES_FILE" ]]; then
  EXISTING=$(cat "$ADDRESSES_FILE")
else
  EXISTING='{}'
fi

jq -n \
  --arg network "$NETWORK" \
  --argjson denom "$(jq '.denom_lovelace' "$CONFIG_PATH")" \
  --argjson maxFee "$(jq '.max_fee_per_mix_lovelace' "$CONFIG_PATH")" \
  --argjson feeShardTarget "$(jq '.fee_shard_target' "$CONFIG_PATH")" \
  --argjson existing "$EXISTING" '
{
  network: $network,
  protocol: {
    denom_lovelace: $denom,
    max_fee_per_mix_lovelace: $maxFee,
    fee_shard_target: $feeShardTarget
  },
  referenceNftPolicy: ($existing.referenceNftPolicy // null),
  referenceNftAssetName: ($existing.referenceNftAssetName // null),
  referenceUtxoRef: ($existing.referenceUtxoRef // null),
  referenceHolderScriptHash: ($existing.referenceHolderScriptHash // null),
  mixLogicScriptHash: ($existing.mixLogicScriptHash // null),
  mixBoxScriptHash: ($existing.mixBoxScriptHash // null),
  feeScriptHash: ($existing.feeScriptHash // null),
  feeShardUtxos: ($existing.feeShardUtxos // []),
  referenceScriptUtxos: ($existing.referenceScriptUtxos // {})
}' > "$ADDRESSES_FILE"

echo "build.sh: wrote $ARTIFACTS_DIR/{blueprint.json, *.plutus, addresses.json}"
