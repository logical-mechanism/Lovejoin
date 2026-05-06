#!/usr/bin/env bash
# 00-build-reference.sh — parameterize every validator with the chosen seed
# UTxO and emit deployable .plutus TextEnvelopes + script hashes into
# artifacts/<network>/.
#
# Spec: docs/spec/03-contracts.md §4.
#
# Parameter chain (each step's hash flows into the next):
#
#     one_shot_mint(seed_tx_id, seed_idx)            → policy_id (= reference NFT policy)
#     mix_logic(reference_nft_policy, asset_name)    → mix_logic_script_hash
#     mix_box(mix_logic_script_hash)                 → mix_box_script_hash
#     fee_contract(reference_nft_policy, asset_name) → fee_script_hash
#     reference_holder                               → reference_holder_script_hash (no params)
#
# Every validator takes flat scalar params (ByteArray / Int) so that
# `aiken blueprint apply` can supply each one as a single CBOR atom — that's
# the official tool for parameterization. Hand-rolling Constr-wrapped CBOR for
# struct params doesn't work reliably across aiken versions.
#
# Inputs (env or first positional):
#   SEED                 — "<txid>#<idx>" of an unspent UTxO at BOOTSTRAP_ADDR.
#   NETWORK              — "preprod" | "test" (default: preprod)
#   REF_NFT_ASSET_NAME   — hex-encoded asset name for the reference NFT.
#                          Default = "lovejoin" hex-encoded → 6c6f76656a6f696e.
#                          Audit F-17 (next-redeploy bundle Q-2): the
#                          validator now bakes this literal in. The env
#                          var remains as a cross-check — if you override
#                          it to anything other than 6c6f76656a6f696e the
#                          mint tx will be rejected by `one_shot_mint` at
#                          submission time. Treat any deviation here as a
#                          configuration mistake, not a feature.
#
# Tool deps:
#   aiken (1.1.21)        — `aiken build`, `aiken blueprint apply`,
#                            `aiken blueprint convert`.
#   cardano-cli (Conway)  — `cardano-cli conway transaction policyid` to derive
#                            script hashes from the .plutus files.
#   python3 + cbor2       — used to encode int / bytes parameters as CBOR.
#                           `pip install cbor2` if missing.
#
# Writes:
#   contracts/plutus.json (parameterized — every `aiken blueprint apply` call
#                          mutates it in place; this script always starts from
#                          a fresh `aiken build`)
#   artifacts/<network>/{one_shot_mint,reference_holder,mix_logic,mix_box,
#                        fee_contract}.plutus
#   artifacts/<network>/{one_shot_mint,reference_holder,mix_logic,mix_box,
#                        fee_contract}.hash
#   artifacts/<network>/addresses.json    (referenceNftPolicy, *ScriptHash)

set -euo pipefail

__ENV_FILE="$(cd "$(dirname "$0")" && pwd)/.env"
[[ -f "$__ENV_FILE" ]] && { set -a; source "$__ENV_FILE"; set +a; }

NETWORK="${NETWORK:-preprod}"
SEED="${SEED:-${1:-}}"
if [[ -z "$SEED" ]]; then
  echo "00-build-reference: SEED is required (env var or first positional)." >&2
  echo "  format: <txid>#<idx>  e.g. abc123…#2  (no quotes needed)" >&2
  echo "  hint:   ./balance.sh prints the four export lines you need." >&2
  exit 1
fi

REF_NFT_ASSET_NAME="${REF_NFT_ASSET_NAME:-6c6f76656a6f696e}"

# Defensive cross-check: the on-chain `one_shot_mint` validator pins the
# asset name to "lovejoin" (audit F-17). Refuse to bootstrap with anything
# else — the mint tx would just bounce, but failing here saves a wasted
# round-trip to the chain.
if [[ "$REF_NFT_ASSET_NAME" != "6c6f76656a6f696e" ]]; then
  echo "00-build-reference: REF_NFT_ASSET_NAME must be 6c6f76656a6f696e (\"lovejoin\");" >&2
  echo "  the on-chain one_shot_mint validator rejects any other name. (got: $REF_NFT_ASSET_NAME)" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ARTIFACTS_DIR="$REPO_ROOT/artifacts/$NETWORK"
mkdir -p "$ARTIFACTS_DIR"

SEED_TX_ID="${SEED%#*}"
SEED_IDX="${SEED#*#}"

if ! [[ "$SEED_TX_ID" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "00-build-reference: SEED txid must be 64 lowercase hex chars (got: $SEED_TX_ID)" >&2
  exit 1
fi
if ! [[ "$SEED_IDX" =~ ^[0-9]+$ ]]; then
  echo "00-build-reference: SEED idx must be a non-negative integer (got: $SEED_IDX)" >&2
  exit 1
fi

# Sanity: cbor2 importable?
if ! python3 -c "import cbor2" 2>/dev/null; then
  echo "00-build-reference: python3 cbor2 not installed (pip install cbor2)" >&2
  exit 1
fi

echo "==> Compiling contracts (fresh aiken build)"
( cd "$REPO_ROOT/contracts" && aiken build )

# --- helpers ---------------------------------------------------------------
encode_bytes_cbor() {
  python3 -c "import cbor2,sys;print(cbor2.dumps(bytes.fromhex(sys.argv[1])).hex())" "$1"
}
encode_int_cbor() {
  python3 -c "import cbor2,sys;print(cbor2.dumps(int(sys.argv[1])).hex())" "$1"
}

# Apply N cbor-hex parameters to validator $1, then convert to TextEnvelope and
# derive its script hash via cardano-cli policyid.
parameterize() {
  local validator="$1"; shift
  local stage_label="$1"; shift   # human-readable label for the log line
  cd "$REPO_ROOT/contracts"
  for cbor_hex in "$@"; do
    aiken blueprint apply -o plutus.json -m "$validator" "$cbor_hex" >/dev/null
  done
  aiken blueprint convert -m "$validator" > "$ARTIFACTS_DIR/$validator.plutus"
  cardano-cli conway transaction policyid \
    --script-file "$ARTIFACTS_DIR/$validator.plutus" \
    > "$ARTIFACTS_DIR/$validator.hash"
  cd - >/dev/null
  printf "    %-16s %s\n" "$stage_label" "$(cat "$ARTIFACTS_DIR/$validator.hash")"
}

# --- step 1: one_shot_mint(seed_tx_id, seed_idx) ---------------------------
echo "==> Parameterizing one_shot_mint(seed_tx_id, seed_idx)"
SEED_TX_ID_CBOR=$(encode_bytes_cbor "$SEED_TX_ID")
SEED_IDX_CBOR=$(encode_int_cbor "$SEED_IDX")
parameterize one_shot_mint "policy_id =" "$SEED_TX_ID_CBOR" "$SEED_IDX_CBOR"

REF_NFT_POLICY=$(cat "$ARTIFACTS_DIR/one_shot_mint.hash")
REF_NFT_POLICY_CBOR=$(encode_bytes_cbor "$REF_NFT_POLICY")
REF_NFT_NAME_CBOR=$(encode_bytes_cbor "$REF_NFT_ASSET_NAME")

# --- step 2: mix_logic(reference_nft_policy, asset_name) -------------------
echo "==> Parameterizing mix_logic(reference_nft_policy, asset_name)"
parameterize mix_logic "mix_logic =" "$REF_NFT_POLICY_CBOR" "$REF_NFT_NAME_CBOR"
MIX_LOGIC_HASH=$(cat "$ARTIFACTS_DIR/mix_logic.hash")

# --- step 3: mix_box(mix_logic_script_hash) --------------------------------
echo "==> Parameterizing mix_box(mix_logic_script_hash)"
MIX_LOGIC_HASH_CBOR=$(encode_bytes_cbor "$MIX_LOGIC_HASH")
parameterize mix_box "mix_box =" "$MIX_LOGIC_HASH_CBOR"
MIX_BOX_HASH=$(cat "$ARTIFACTS_DIR/mix_box.hash")

# --- step 4: fee_contract(reference_nft_policy, asset_name) ----------------
echo "==> Parameterizing fee_contract(reference_nft_policy, asset_name)"
parameterize fee_contract "fee_contract =" "$REF_NFT_POLICY_CBOR" "$REF_NFT_NAME_CBOR"
FEE_HASH=$(cat "$ARTIFACTS_DIR/fee_contract.hash")

# --- step 5: reference_holder(reference_nft_policy, asset_name) -----------
# Parameterized with the NFT identity so each protocol deployment gets a
# unique reference_holder address even though the body is always-False.
echo "==> Parameterizing reference_holder(reference_nft_policy, asset_name)"
parameterize reference_holder "reference =" "$REF_NFT_POLICY_CBOR" "$REF_NFT_NAME_CBOR"
REF_HOLDER_HASH=$(cat "$ARTIFACTS_DIR/reference_holder.hash")

# --- update addresses.json --------------------------------------------------
# Also propagate `dapp_stake_key_hash` from config/network.<net>.json into
# `addresses.json.dappStakeKeyHashHex` so the SDK builds base addresses
# (script payment + dApp stake key) for every mix-box output. Without this
# the field stays null, the SDK falls back to enterprise addresses, and the
# pool's locked ADA stops earning operator-pool rewards.
NETWORK_CONFIG="$REPO_ROOT/config/network.$NETWORK.json"
DAPP_STAKE_KEY_HASH=""
if [[ -f "$NETWORK_CONFIG" ]]; then
  DAPP_STAKE_KEY_HASH=$(jq -r '.dapp_stake_key_hash // empty' "$NETWORK_CONFIG")
fi

TMP=$(mktemp)
jq \
  --arg refNftPolicy "$REF_NFT_POLICY" \
  --arg refNftAssetName "$REF_NFT_ASSET_NAME" \
  --arg refHolderHash "$REF_HOLDER_HASH" \
  --arg mixLogicHash "$MIX_LOGIC_HASH" \
  --arg mixBoxHash "$MIX_BOX_HASH" \
  --arg feeHash "$FEE_HASH" \
  --arg dappStakeKey "$DAPP_STAKE_KEY_HASH" '
  .referenceNftPolicy = $refNftPolicy
  | .referenceNftAssetName = $refNftAssetName
  | .referenceHolderScriptHash = $refHolderHash
  | .mixLogicScriptHash = $mixLogicHash
  | .mixBoxScriptHash = $mixBoxHash
  | .feeScriptHash = $feeHash
  | (if $dappStakeKey == "" then . else .dappStakeKeyHashHex = $dappStakeKey end)
' "$ARTIFACTS_DIR/addresses.json" > "$TMP"
mv "$TMP" "$ARTIFACTS_DIR/addresses.json"

echo
echo "00-build-reference: $NETWORK addresses.json updated."
echo "  reference NFT:    $REF_NFT_POLICY.$REF_NFT_ASSET_NAME"
echo "  reference_holder: $REF_HOLDER_HASH"
echo "  mix_logic:        $MIX_LOGIC_HASH"
echo "  mix_box:          $MIX_BOX_HASH"
echo "  fee_contract:     $FEE_HASH"
if [[ -n "$DAPP_STAKE_KEY_HASH" ]]; then
  echo "  dApp stake key:   $DAPP_STAKE_KEY_HASH"
else
  echo "  dApp stake key:   (none — pool outputs will be enterprise addresses)"
fi
