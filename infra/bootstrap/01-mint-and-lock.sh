#!/usr/bin/env bash
# 01-mint-and-lock.sh — single tx that:
#   * spends SEED_UTXO from BOOTSTRAP_ADDR
#   * mints exactly 1 NFT under one_shot_mint(SEED_UTXO)
#   * locks the NFT at reference_holder with an inline ReferenceDatum
#   * registers the mix_logic stake credential (so withdraw-zero is valid going
#     forward) — the registration cert is bundled into the same tx for atomicity.
#
# Inputs (env):
#   NETWORK            — "preprod" | "test" (default: preprod)
#   CARDANO_NODE_SOCKET_PATH or use --testnet-magic via cardano-cli
#   TESTNET_MAGIC      — default 1 (Preprod)
#   BOOTSTRAP_ADDR     — bootstrap wallet address holding the seed UTxO
#   SEED_UTXO          — same value used in 00-build-reference.sh
#   PAYMENT_SKEY       — path to bootstrap wallet's signing key (.skey)
#   STAKE_VKEY         — path to a stake verification key (used for the
#                        mix_logic stake credential — typically derived from
#                        BOOTSTRAP_ADDR's stake key, but you can also use a
#                        dedicated key per network).
#   STAKE_SKEY         — corresponding stake signing key
#
# Reads:
#   artifacts/<network>/{one_shot_mint,reference_holder,mix_logic}.plutus
#   artifacts/<network>/addresses.json
#   contracts/config/network.<network>.json
#
# Writes (after submission + confirmation):
#   artifacts/<network>/addresses.json     (referenceUtxoRef populated)
#
# THIS IS A ONE-SHOT IRREVERSIBLE CEREMONY. Practice on a private Preprod
# wallet first. See docs/spec/12-build-guide.md §Risk 4.

set -euo pipefail

NETWORK="${NETWORK:-preprod}"
TESTNET_MAGIC="${TESTNET_MAGIC:-1}"
BOOTSTRAP_ADDR="${BOOTSTRAP_ADDR:?BOOTSTRAP_ADDR required}"
SEED_UTXO="${SEED_UTXO:?SEED_UTXO required (must match 00-build-reference.sh)}"
PAYMENT_SKEY="${PAYMENT_SKEY:?PAYMENT_SKEY (path to .skey) required}"
STAKE_VKEY="${STAKE_VKEY:?STAKE_VKEY (path to .vkey for mix_logic) required}"
STAKE_SKEY="${STAKE_SKEY:?STAKE_SKEY (path to .skey for mix_logic) required}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ARTIFACTS_DIR="$REPO_ROOT/artifacts/$NETWORK"
CONFIG="$REPO_ROOT/config/network.$NETWORK.json"

REF_NFT_POLICY=$(jq -r '.referenceNftPolicy' "$ARTIFACTS_DIR/addresses.json")
REF_NFT_NAME=$(jq -r '.referenceNftAssetName' "$ARTIFACTS_DIR/addresses.json")
MIX_LOGIC_HASH=$(jq -r '.mixLogicScriptHash' "$ARTIFACTS_DIR/addresses.json")
REF_HOLDER_HASH=$(jq -r '.referenceHolderScriptHash' "$ARTIFACTS_DIR/addresses.json")
MIX_SCRIPT_HASH=$(jq -r '.mixBoxScriptHash' "$ARTIFACTS_DIR/addresses.json")
FEE_SCRIPT_HASH=$(jq -r '.feeScriptHash' "$ARTIFACTS_DIR/addresses.json")
DENOM=$(jq -r '.protocol.denom_lovelace' "$ARTIFACTS_DIR/addresses.json")
MAX_FEE=$(jq -r '.protocol.max_fee_per_mix_lovelace' "$ARTIFACTS_DIR/addresses.json")
MAX_N=$(jq -r '.protocol.max_n' "$ARTIFACTS_DIR/addresses.json")
SHARD_TARGET=$(jq -r '.protocol.fee_shard_target' "$ARTIFACTS_DIR/addresses.json")

if [[ "$REF_NFT_POLICY" == "null" || -z "$REF_NFT_POLICY" ]]; then
  echo "01-mint-and-lock: addresses.json doesn't have referenceNftPolicy yet — run 00-build-reference.sh first" >&2
  exit 1
fi

# Build the reference_holder address from its script hash (network header byte
# is 00 for testnet; 01 for mainnet — we never touch mainnet from this script).
REF_HOLDER_ADDR=$(cardano-cli address build \
  --payment-script-file "$ARTIFACTS_DIR/reference_holder.plutus" \
  --testnet-magic "$TESTNET_MAGIC")

# Inline datum CBOR for ReferenceDatum { protocol: ProtocolParams { ... } }.
# Constr 0 [Constr 0 [denom, max_fee, max_n, mix_script_hash, mix_logic_hash, fee_script_hash, shard_target]].
INLINE_DATUM_FILE="$ARTIFACTS_DIR/reference_datum.json"
jq -n \
  --argjson denom "$DENOM" \
  --argjson maxFee "$MAX_FEE" \
  --argjson maxN "$MAX_N" \
  --arg mixHash "$MIX_SCRIPT_HASH" \
  --arg mixLogicHash "$MIX_LOGIC_HASH" \
  --arg feeHash "$FEE_SCRIPT_HASH" \
  --argjson shardTarget "$SHARD_TARGET" '{
    constructor: 0,
    fields: [{
      constructor: 0,
      fields: [
        {int: $denom},
        {int: $maxFee},
        {int: $maxN},
        {bytes: $mixHash},
        {bytes: $mixLogicHash},
        {bytes: $feeHash},
        {int: $shardTarget}
      ]
    }]
  }' > "$INLINE_DATUM_FILE"

# Stake registration cert for mix_logic credential. Cardano needs a stake
# credential to be registered before withdrawals from it become valid; we
# bundle the cert into this same tx so the protocol is fully operational
# the moment 01-mint-and-lock confirms.
STAKE_REG_CERT="$ARTIFACTS_DIR/mix_logic-stake-registration.cert"
cardano-cli stake-address registration-certificate \
  --stake-script-file "$ARTIFACTS_DIR/mix_logic.plutus" \
  --out-file "$STAKE_REG_CERT"

# Build the tx. cardano-cli figures out fee + change automatically with --change-address.
TX_RAW="$ARTIFACTS_DIR/01-mint-and-lock.txraw"

# The reference NFT is sent ONLY to the reference_holder address with min UTxO
# lovelace. We over-allocate slightly (3_000_000 lovelace) so the on-chain
# UTxO is comfortably above the network's min-UTxO floor for inline datums.
LOCKED_LOVELACE="${LOCKED_LOVELACE:-3000000}"

cardano-cli conway transaction build \
  --testnet-magic "$TESTNET_MAGIC" \
  --tx-in "$SEED_UTXO" \
  --tx-in-collateral "$SEED_UTXO" \
  --mint "1 $REF_NFT_POLICY.$REF_NFT_NAME" \
  --mint-script-file "$ARTIFACTS_DIR/one_shot_mint.plutus" \
  --mint-redeemer-value '{}' \
  --tx-out "$REF_HOLDER_ADDR + $LOCKED_LOVELACE lovelace + 1 $REF_NFT_POLICY.$REF_NFT_NAME" \
  --tx-out-inline-datum-file "$INLINE_DATUM_FILE" \
  --certificate-file "$STAKE_REG_CERT" \
  --change-address "$BOOTSTRAP_ADDR" \
  --out-file "$TX_RAW"

cardano-cli conway transaction sign \
  --tx-body-file "$TX_RAW" \
  --signing-key-file "$PAYMENT_SKEY" \
  --signing-key-file "$STAKE_SKEY" \
  --testnet-magic "$TESTNET_MAGIC" \
  --out-file "$ARTIFACTS_DIR/01-mint-and-lock.tx"

cardano-cli conway transaction submit \
  --testnet-magic "$TESTNET_MAGIC" \
  --tx-file "$ARTIFACTS_DIR/01-mint-and-lock.tx"

TX_ID=$(cardano-cli conway transaction txid --tx-file "$ARTIFACTS_DIR/01-mint-and-lock.tx")
echo "01-mint-and-lock: submitted txid $TX_ID"

# Persist the reference UTxO ref in addresses.json. Output index 0 is the NFT
# output (we put it first in --tx-out order).
TMP=$(mktemp)
jq --arg ref "$TX_ID#0" '.referenceUtxoRef = $ref' "$ARTIFACTS_DIR/addresses.json" > "$TMP"
mv "$TMP" "$ARTIFACTS_DIR/addresses.json"

echo "01-mint-and-lock: reference UTxO ref written to addresses.json"
echo "  ${TX_ID}#0"
