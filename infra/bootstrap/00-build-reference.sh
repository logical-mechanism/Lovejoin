#!/usr/bin/env bash
# 00-build-reference.sh — Stage 2 of the build. Picks the seed UTxO, parameterizes
# every validator, and writes the resolved hashes into artifacts/<net>/addresses.json.
#
# Inputs (env):
#   NETWORK              — "preprod" | "test" (default: preprod)
#   SEED_UTXO            — "<txid>#<idx>" of an unspent UTxO at BOOTSTRAP_ADDR
#                          that 01-mint-and-lock.sh will consume in the same tx
#                          as the one_shot_mint policy fires.
#   REF_NFT_ASSET_NAME   — hex-encoded asset name (default 6c6f76656a6f696e =
#                          "lovejoin").
#
# Reads:
#   contracts/config/network.<network>.json
#   artifacts/<network>/blueprint.json     (produced by contracts/build.sh)
#
# Writes:
#   artifacts/<network>/{one_shot_mint,mix_logic,mix_box,fee_contract}.plutus
#       (parameterized; overwrites the unparameterized templates from Stage 1)
#   artifacts/<network>/addresses.json     (referenceNftPolicy, *ScriptHash)
#
# Spec: docs/spec/03-contracts.md §4 (build chain).

set -euo pipefail

NETWORK="${NETWORK:-preprod}"
SEED_UTXO="${SEED_UTXO:?SEED_UTXO must be set to <txid>#<idx>}"
REF_NFT_ASSET_NAME="${REF_NFT_ASSET_NAME:-6c6f76656a6f696e}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ARTIFACTS_DIR="$REPO_ROOT/artifacts/$NETWORK"

if [[ ! -f "$ARTIFACTS_DIR/blueprint.json" ]]; then
  echo "00-build-reference: $ARTIFACTS_DIR/blueprint.json missing — run contracts/build.sh first" >&2
  exit 1
fi

SEED_TX_ID="${SEED_UTXO%#*}"
SEED_IDX="${SEED_UTXO#*#}"

cd "$REPO_ROOT/contracts"

# Step 1: parameterize one_shot_mint(seed) → derive policy_id.
#
# `aiken blueprint apply` takes a CBOR-encoded parameter and rewrites the
# blueprint slot in place. The parameter is `OutputReference { tx_id, idx }`,
# which encodes as Constr 0 [ByteArray, Int].
#
# Per docs/spec/03-contracts.md §4 the chain is:
#   one_shot_mint(seed) → policy_id        (this step)
#   mix_logic(NFT)      → mix_logic hash   (after policy_id known)
#   mix_box(mix_logic_credential) → mix_box hash
#   fee_contract(NFT)   → fee_script hash
# This script computes the four hashes and writes them to addresses.json.

OUT_REF_CBOR=$(printf 'd8799f5820%s%02xff' "$SEED_TX_ID" "$SEED_IDX")

aiken blueprint apply \
  -m one_shot_mint.one_shot_mint.mint \
  -v "$OUT_REF_CBOR" \
  > "$ARTIFACTS_DIR/one_shot_mint.json"

ONE_SHOT_HASH=$(jq -r '.validators[] | select(.title=="one_shot_mint.one_shot_mint.mint") | .hash' "$ARTIFACTS_DIR/one_shot_mint.json")

REF_NFT_POLICY="$ONE_SHOT_HASH"

# Step 2: parameterize mix_logic(reference_nft).
REF_PARAMS_CBOR=$(printf 'd8799f581c%s4c%s00ff' "$REF_NFT_POLICY" "$REF_NFT_ASSET_NAME")

aiken blueprint apply \
  -m mix_logic.mix_logic.withdraw \
  -v "$REF_PARAMS_CBOR" \
  > "$ARTIFACTS_DIR/mix_logic.json"

MIX_LOGIC_HASH=$(jq -r '.validators[] | select(.title=="mix_logic.mix_logic.withdraw") | .hash' "$ARTIFACTS_DIR/mix_logic.json")

# Step 3: parameterize mix_box(Script(mix_logic_hash)). Credential::Script
# is the second constructor → Constr 1.
MIX_LOGIC_CRED_CBOR=$(printf 'd87a9f581c%sff' "$MIX_LOGIC_HASH")

aiken blueprint apply \
  -m mix_box.mix_box.spend \
  -v "$MIX_LOGIC_CRED_CBOR" \
  > "$ARTIFACTS_DIR/mix_box.json"

MIX_BOX_HASH=$(jq -r '.validators[] | select(.title=="mix_box.mix_box.spend") | .hash' "$ARTIFACTS_DIR/mix_box.json")

# Step 4: parameterize fee_contract(reference_nft).
aiken blueprint apply \
  -m fee_contract.fee_contract.spend \
  -v "$REF_PARAMS_CBOR" \
  > "$ARTIFACTS_DIR/fee_contract.json"

FEE_HASH=$(jq -r '.validators[] | select(.title=="fee_contract.fee_contract.spend") | .hash' "$ARTIFACTS_DIR/fee_contract.json")

# reference_holder is unparameterized.
REF_HOLDER_HASH=$(jq -r '.validators[] | select(.title=="reference_holder.reference_holder.spend") | .hash' "$ARTIFACTS_DIR/blueprint.json")

# Re-emit per-validator TextEnvelope .plutus files (now parameterized).
emit_plutus() {
  local title="$1" src="$2" out="$3"
  local cbor
  cbor=$(jq -r --arg t "$title" '.validators[] | select(.title == $t) | .compiledCode' "$src")
  jq -n --arg cbor "$cbor" --arg title "$title" '{
    type: "PlutusScriptV3",
    description: ("lovejoin: " + $title + " (parameterized)"),
    cborHex: $cbor
  }' > "$out"
}

emit_plutus "reference_holder.reference_holder.spend" "$ARTIFACTS_DIR/blueprint.json"      "$ARTIFACTS_DIR/reference_holder.plutus"
emit_plutus "one_shot_mint.one_shot_mint.mint"        "$ARTIFACTS_DIR/one_shot_mint.json"  "$ARTIFACTS_DIR/one_shot_mint.plutus"
emit_plutus "mix_logic.mix_logic.withdraw"            "$ARTIFACTS_DIR/mix_logic.json"      "$ARTIFACTS_DIR/mix_logic.plutus"
emit_plutus "mix_box.mix_box.spend"                   "$ARTIFACTS_DIR/mix_box.json"        "$ARTIFACTS_DIR/mix_box.plutus"
emit_plutus "fee_contract.fee_contract.spend"         "$ARTIFACTS_DIR/fee_contract.json"   "$ARTIFACTS_DIR/fee_contract.plutus"

# Update addresses.json with the resolved hashes (preserving any existing
# referenceUtxoRef / feeShardUtxos / referenceScriptUtxos that later bootstrap
# scripts may have populated).
TMP=$(mktemp)
jq \
  --arg refNftPolicy "$REF_NFT_POLICY" \
  --arg refNftAssetName "$REF_NFT_ASSET_NAME" \
  --arg refHolderHash "$REF_HOLDER_HASH" \
  --arg mixLogicHash "$MIX_LOGIC_HASH" \
  --arg mixBoxHash "$MIX_BOX_HASH" \
  --arg feeHash "$FEE_HASH" '
  .referenceNftPolicy = $refNftPolicy
  | .referenceNftAssetName = $refNftAssetName
  | .referenceHolderScriptHash = $refHolderHash
  | .mixLogicScriptHash = $mixLogicHash
  | .mixBoxScriptHash = $mixBoxHash
  | .feeScriptHash = $feeHash
' "$ARTIFACTS_DIR/addresses.json" > "$TMP"
mv "$TMP" "$ARTIFACTS_DIR/addresses.json"

echo "00-build-reference: parameterized $NETWORK"
echo "  reference NFT policy: $REF_NFT_POLICY"
echo "  reference NFT name:   $REF_NFT_ASSET_NAME (hex)"
echo "  reference_holder:     $REF_HOLDER_HASH"
echo "  mix_logic:            $MIX_LOGIC_HASH"
echo "  mix_box:              $MIX_BOX_HASH"
echo "  fee_contract:         $FEE_HASH"
