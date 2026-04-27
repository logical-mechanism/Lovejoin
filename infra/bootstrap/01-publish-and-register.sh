#!/usr/bin/env bash
# 01-publish-and-register.sh — single script, four chained txs.
#
#   Tx 1: publish mix_box      ref script
#   Tx 2: publish mix_logic    ref script
#   Tx 3: publish fee_contract ref script
#   Tx 4: register mix_logic stake credential
#         (--certificate-tx-in-reference points at tx 2's output)
#
# Chained via change-output: each subsequent tx's --tx-in is the previous
# tx's #1 output (the change). cardano-cli's `transaction build` queries
# the on-ledger UTxO set, NOT the mempool — so we use `transaction
# build-raw` for the chain, computing fee + change manually. All four are
# built and signed offline; we then submit them in order so the local node
# accepts them as a coherent chain.
#
# Inputs (env, typically via .env + prep-utxos exports):
#   NETWORK            — preprod | preview (default: preprod)
#   TESTNET_MAGIC      — default 1 (Preprod)
#   CARDANO_NODE_SOCKET_PATH must point to a synced node.
#   BOOTSTRAP_ADDR     — wallet address (auto-defaulted from wallets/).
#   PAYMENT_SKEY       — bootstrap signing key (auto-defaulted).
#   FUNDING_STAGE1     — UTxO at the wallet that funds the chain. ≈ 85 ADA.
#   COLLATERAL         — separate ada-only UTxO for tx 4's Plutus exec.
#                        Preserved on script success.
#   REF_PUBLISH_LOVELACE  — lovelace per ref-script output (default 25_000_000).
#   PUBLISH_FEE        — fee for each non-Plutus publish tx (default 300_000).
#   CERT_FEE           — fee for the cert-registration tx (default 1_500_000).
#   CERT_EXEC_STEPS / CERT_EXEC_MEM — Plutus exec budget for the cert
#                        validation. Defaults are over-budget so the
#                        trivial publish handler always fits.
#
# Writes: artifacts/<network>/addresses.json (referenceScriptUtxos populated).

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
COLLATERAL="${COLLATERAL:?COLLATERAL required (run ./balance.sh)}"

REF_PUBLISH_LOVELACE="${REF_PUBLISH_LOVELACE:-25000000}"
PUBLISH_FEE="${PUBLISH_FEE:-300000}"
CERT_FEE="${CERT_FEE:-1500000}"
CERT_EXEC_STEPS="${CERT_EXEC_STEPS:-100000000}"
CERT_EXEC_MEM="${CERT_EXEC_MEM:-500000}"

REPO_ROOT="$(cd "$__BOOTSTRAP_DIR/../.." && pwd)"
ARTIFACTS_DIR="$REPO_ROOT/artifacts/$NETWORK"
TMP_DIR="$ARTIFACTS_DIR/tmp"
mkdir -p "$TMP_DIR"

if [[ "$(jq -r '.mixLogicScriptHash // empty' "$ARTIFACTS_DIR/addresses.json")" == "" ]]; then
  echo "01-publish-and-register: addresses.json missing mixLogicScriptHash — run 00-build-reference.sh first" >&2
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
  echo "01-publish-and-register: FUNDING_STAGE1 ($FUNDING_STAGE1) not found at $BOOTSTRAP_ADDR" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
EMPTY_REDEEMER="$ARTIFACTS_DIR/empty-redeemer.json"
echo '{"constructor":0,"fields":[]}' > "$EMPTY_REDEEMER"

txid_of() {
  cardano-cli conway transaction txid --tx-file "$ARTIFACTS_DIR/$1.tx" \
    | grep -oE '[a-f0-9]{64}' | head -n1
}

# Build + sign a publish tx (no Plutus). build-raw because we're chaining
# unconfirmed change outputs.
#
# Args:
#   $1 stage tag    (e.g. "01a-publish-mix-box")
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
# Build all 4 txs offline (no submits yet).
# ---------------------------------------------------------------------------

echo "==> Building tx 1/4: publish mix_box"
TX1_CHANGE=$(publish_step "01a-publish-mix-box" "mix_box.plutus" "$FUNDING_STAGE1" "$FUNDING_LOVELACE")
TX1_ID=$(txid_of "01a-publish-mix-box")
echo "    tx1 = $TX1_ID, change = $TX1_CHANGE lovelace at ${TX1_ID}#1"

echo "==> Building tx 2/4: publish mix_logic"
TX2_CHANGE=$(publish_step "01b-publish-mix-logic" "mix_logic.plutus" "${TX1_ID}#1" "$TX1_CHANGE")
TX2_ID=$(txid_of "01b-publish-mix-logic")
echo "    tx2 = $TX2_ID, change = $TX2_CHANGE lovelace at ${TX2_ID}#1"

echo "==> Building tx 3/4: publish fee_contract"
TX3_CHANGE=$(publish_step "01c-publish-fee-contract" "fee_contract.plutus" "${TX2_ID}#1" "$TX2_CHANGE")
TX3_ID=$(txid_of "01c-publish-fee-contract")
echo "    tx3 = $TX3_ID, change = $TX3_CHANGE lovelace at ${TX3_ID}#1"

echo "==> Building tx 4/4: register mix_logic stake credential"
KEY_DEPOSIT=$(jq -r '.stakeAddressDeposit' "$TMP_DIR/protocol.json")
STAKE_REG_CERT="$ARTIFACTS_DIR/mix_logic-stake-registration.cert"
cardano-cli conway stake-address registration-certificate \
  --stake-script-file "$ARTIFACTS_DIR/mix_logic.plutus" \
  --key-reg-deposit-amt "$KEY_DEPOSIT" \
  --out-file "$STAKE_REG_CERT"

TX4_CHANGE=$((TX3_CHANGE - KEY_DEPOSIT - CERT_FEE))
if [[ $TX4_CHANGE -lt 1500000 ]]; then
  echo "01d: change after deposit + fee = ${TX4_CHANGE} lovelace too low" >&2
  exit 1
fi

cardano-cli conway transaction build-raw \
  --tx-in "${TX3_ID}#1" \
  --tx-in-collateral "$COLLATERAL" \
  --certificate-file "$STAKE_REG_CERT" \
  --certificate-tx-in-reference "${TX2_ID}#0" \
  --certificate-plutus-script-v3 \
  --certificate-reference-tx-in-redeemer-file "$EMPTY_REDEEMER" \
  --certificate-reference-tx-in-execution-units "($CERT_EXEC_STEPS,$CERT_EXEC_MEM)" \
  --tx-out "$BOOTSTRAP_ADDR + $TX4_CHANGE lovelace" \
  --fee "$CERT_FEE" \
  --protocol-params-file "$TMP_DIR/protocol.json" \
  --out-file "$ARTIFACTS_DIR/01d-register-mix-logic.txraw"

cardano-cli conway transaction sign \
  --tx-body-file "$ARTIFACTS_DIR/01d-register-mix-logic.txraw" \
  --signing-key-file "$PAYMENT_SKEY" \
  --testnet-magic "$TESTNET_MAGIC" \
  --out-file "$ARTIFACTS_DIR/01d-register-mix-logic.tx"
TX4_ID=$(txid_of "01d-register-mix-logic")
echo "    tx4 = $TX4_ID"

# ---------------------------------------------------------------------------
# Submit all 4 in order. The local node accepts each because the chain is
# internally consistent (each input is the previous tx's known-shape change).
# ---------------------------------------------------------------------------
echo
echo "==> Submitting chain"
for stage in 01a-publish-mix-box 01b-publish-mix-logic 01c-publish-fee-contract 01d-register-mix-logic; do
  echo "    submitting $stage"
  cardano-cli conway transaction submit \
    --testnet-magic "$TESTNET_MAGIC" \
    --tx-file "$ARTIFACTS_DIR/$stage.tx"
done

# ---------------------------------------------------------------------------
# Persist ref-script UTxOs into addresses.json.
# ---------------------------------------------------------------------------
TMP=$(mktemp)
jq --arg mb "${TX1_ID}#0" --arg ml "${TX2_ID}#0" --arg fc "${TX3_ID}#0" '
  .referenceScriptUtxos = {
    mix_box: $mb,
    mix_logic: $ml,
    fee_contract: $fc
  }
' "$ARTIFACTS_DIR/addresses.json" > "$TMP"
mv "$TMP" "$ARTIFACTS_DIR/addresses.json"

echo
echo "01-publish-and-register: chain submitted (4 txs)."
echo "  mix_box ref:      ${TX1_ID}#0"
echo "  mix_logic ref:    ${TX2_ID}#0"
echo "  fee_contract ref: ${TX3_ID}#0"
echo "  cert reg:         ${TX4_ID}"
echo "Wait for confirmation, then run 02-mint-and-lock.sh."
