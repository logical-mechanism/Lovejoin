#!/usr/bin/env bash
# 01a-publish.sh — chain three publish txs offline:
#
#   Tx 1: publish mix_box      ref script
#   Tx 2: publish mix_logic    ref script
#   Tx 3: publish fee_contract ref script
#
# Chained via change-output: each subsequent tx's --tx-in is the previous
# tx's #1 output (the change). cardano-cli's `transaction build` queries the
# on-ledger UTxO set, NOT the mempool — so we use `transaction build-raw`
# for the chain, computing fee + change manually. All three are built and
# signed offline; we then submit them in order so the local node accepts
# them as a coherent chain.
#
# Inputs (env, typically via .env + prep-utxos exports):
#   NETWORK            — preprod | preview (default: preprod)
#   TESTNET_MAGIC      — default 1 (Preprod)
#   CARDANO_NODE_SOCKET_PATH must point to a synced node.
#   BOOTSTRAP_ADDR     — wallet address (auto-defaulted from wallets/).
#   PAYMENT_SKEY       — bootstrap signing key (auto-defaulted).
#   FUNDING_STAGE1     — UTxO at the wallet that funds the chain. ≈ 85 ADA.
#   REF_PUBLISH_LOVELACE — lovelace per ref-script output (default 25_000_000).
#   PUBLISH_FEE        — fee for each publish tx (default 300_000).
#
# Writes:
#   artifacts/<network>/01a-{mix-box,mix-logic,fee-contract}.tx
#   artifacts/<network>/addresses.json
#     .referenceScriptUtxos = { mix_box, mix_logic, fee_contract }
#     .stage1ChangeUtxo     = "<txid>#1"   ← consumed by 01b-register.sh

set -euo pipefail

__BOOTSTRAP_DIR="$(cd "$(dirname "$0")" && pwd)"
__ENV_FILE="$__BOOTSTRAP_DIR/.env"
[[ -f "$__ENV_FILE" ]] && { set -a; source "$__ENV_FILE"; set +a; }

NETWORK="${NETWORK:-preprod}"
TESTNET_MAGIC="${TESTNET_MAGIC:-1}"
WALLETS_DIR="$__BOOTSTRAP_DIR/wallets"
: "${BOOTSTRAP_ADDR:=$([[ -f "$WALLETS_DIR/payment.$NETWORK.addr" ]] && cat "$WALLETS_DIR/payment.$NETWORK.addr" || echo '')}"
: "${PAYMENT_SKEY:=$WALLETS_DIR/payment.skey}"

FUNDING_STAGE1="${FUNDING_STAGE1:?FUNDING_STAGE1 required (run ./balance.sh)}"

REF_PUBLISH_LOVELACE="${REF_PUBLISH_LOVELACE:-25000000}"
PUBLISH_FEE="${PUBLISH_FEE:-350000}"

REPO_ROOT="$(cd "$__BOOTSTRAP_DIR/../.." && pwd)"
ARTIFACTS_DIR="$REPO_ROOT/artifacts/$NETWORK"
TMP_DIR="$ARTIFACTS_DIR/tmp"
mkdir -p "$TMP_DIR"

if [[ "$(jq -r '.mixLogicScriptHash // empty' "$ARTIFACTS_DIR/addresses.json")" == "" ]]; then
  echo "01a-publish: addresses.json missing mixLogicScriptHash — run 00-build-reference.sh first" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Pre-flight: protocol params + the FUNDING_STAGE1 lovelace amount.
# ---------------------------------------------------------------------------
cardano-cli conway query protocol-parameters \
  --testnet-magic "$TESTNET_MAGIC" \
  --out-file "$TMP_DIR/protocol.json"

cardano-cli conway query utxo \
  --testnet-magic "$TESTNET_MAGIC" \
  --address "$BOOTSTRAP_ADDR" \
  --out-file "$TMP_DIR/wallet.utxo.json"

FUNDING_LOVELACE=$(jq -r --arg ref "$FUNDING_STAGE1" '.[$ref].value.lovelace' "$TMP_DIR/wallet.utxo.json")
if [[ -z "$FUNDING_LOVELACE" || "$FUNDING_LOVELACE" == "null" ]]; then
  echo "01a-publish: FUNDING_STAGE1 ($FUNDING_STAGE1) not found at $BOOTSTRAP_ADDR" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
txid_of() {
  cardano-cli conway transaction txid --tx-file "$ARTIFACTS_DIR/$1.tx" \
    | grep -oE '[a-f0-9]{64}' | head -n1
}

# Build + sign a publish tx (no Plutus). build-raw because we're chaining
# unconfirmed change outputs.
#
# Args:
#   $1 stage tag    (e.g. "01a-mix-box")
#   $2 plutus filename in ARTIFACTS_DIR
#   $3 funding UTxO ref ("<txid>#<idx>")
#   $4 funding UTxO lovelace (caller knows from prior step's change)
#
# Echoes the change-output lovelace amount for the next link to use.
publish_step() {
  local stage="$1" script="$2" funding_ref="$3" funding_lovelace="$4"
  local change_lovelace=$((funding_lovelace - REF_PUBLISH_LOVELACE - PUBLISH_FEE))
  if [[ $change_lovelace -lt 1500000 ]]; then
    echo "$stage: change=${change_lovelace} lovelace too low (need ≥ 1.5 ADA min-utxo)" >&2
    return 1
  fi

  cardano-cli conway transaction build-raw \
    --tx-in "$funding_ref" \
    --tx-out "$BOOTSTRAP_ADDR + $REF_PUBLISH_LOVELACE lovelace" \
    --tx-out-reference-script-file "$ARTIFACTS_DIR/$script" \
    --tx-out "$BOOTSTRAP_ADDR + $change_lovelace lovelace" \
    --fee "$PUBLISH_FEE" \
    --out-file "$ARTIFACTS_DIR/$stage.txraw"

  cardano-cli conway transaction sign \
    --tx-body-file "$ARTIFACTS_DIR/$stage.txraw" \
    --signing-key-file "$PAYMENT_SKEY" \
    --testnet-magic "$TESTNET_MAGIC" \
    --out-file "$ARTIFACTS_DIR/$stage.tx"

  echo "$change_lovelace"
}

# ---------------------------------------------------------------------------
# Build all 3 txs offline (no submits yet).
# ---------------------------------------------------------------------------

echo "==> Building tx 1/3: publish mix_box"
TX1_CHANGE=$(publish_step "01a-mix-box" "mix_box.plutus" "$FUNDING_STAGE1" "$FUNDING_LOVELACE")
TX1_ID=$(txid_of "01a-mix-box")
echo "    tx1 = $TX1_ID, change = $TX1_CHANGE lovelace at ${TX1_ID}#1"

echo "==> Building tx 2/3: publish mix_logic"
TX2_CHANGE=$(publish_step "01a-mix-logic" "mix_logic.plutus" "${TX1_ID}#1" "$TX1_CHANGE")
TX2_ID=$(txid_of "01a-mix-logic")
echo "    tx2 = $TX2_ID, change = $TX2_CHANGE lovelace at ${TX2_ID}#1"

echo "==> Building tx 3/3: publish fee_contract"
TX3_CHANGE=$(publish_step "01a-fee-contract" "fee_contract.plutus" "${TX2_ID}#1" "$TX2_CHANGE")
TX3_ID=$(txid_of "01a-fee-contract")
echo "    tx3 = $TX3_ID, change = $TX3_CHANGE lovelace at ${TX3_ID}#1"

# ---------------------------------------------------------------------------
# Submit all 3 in order. The local node accepts each because the chain is
# internally consistent (each input is the previous tx's known-shape change).
# ---------------------------------------------------------------------------
echo
echo "==> Submitting chain"
for stage in 01a-mix-box 01a-mix-logic 01a-fee-contract; do
  echo "    submitting $stage"
  cardano-cli conway transaction submit \
    --testnet-magic "$TESTNET_MAGIC" \
    --tx-file "$ARTIFACTS_DIR/$stage.tx"
done

# ---------------------------------------------------------------------------
# Persist ref-script UTxOs + final-change ref into addresses.json. 01b reads
# stage1ChangeUtxo as its funding input.
# ---------------------------------------------------------------------------
TMP=$(mktemp)
jq \
  --arg mb "${TX1_ID}#0" \
  --arg ml "${TX2_ID}#0" \
  --arg fc "${TX3_ID}#0" \
  --arg change "${TX3_ID}#1" '
  .referenceScriptUtxos = {
    mix_box: $mb,
    mix_logic: $ml,
    fee_contract: $fc
  }
  | .stage1ChangeUtxo = $change
' "$ARTIFACTS_DIR/addresses.json" > "$TMP"
mv "$TMP" "$ARTIFACTS_DIR/addresses.json"

echo
echo "01a-publish: chain submitted (3 txs)."
echo "  mix_box ref:      ${TX1_ID}#0"
echo "  mix_logic ref:    ${TX2_ID}#0"
echo "  fee_contract ref: ${TX3_ID}#0"
echo "  stage1 change:    ${TX3_ID}#1  (${TX3_CHANGE} lovelace, consumed by 01b)"
echo "Wait for confirmation (./balance.sh), then run 01b-register.sh."
