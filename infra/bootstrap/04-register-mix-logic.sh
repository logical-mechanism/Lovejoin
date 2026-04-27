#!/usr/bin/env bash
# 04-register-mix-logic.sh — register the mix_logic stake credential.
#
# The credential is script-based (Plutus). The cert MUST be paired with the
# script + a redeemer; mix_logic.publish accepts only RegisterCredential and
# rejects everything else (in particular UnregisterCredential — de-registration
# would brick every mix_box spend forever).
#
# Recursive-chain detail: this tx attaches mix_logic *as a reference input*
# (from the UTxO 02-publish-mix-logic.sh published) instead of inlining the
# script bytes. So the tx body stays small and we exercise the same
# reference-input shape the production Mix txs will use.
#
# Inputs (env):
#   FUNDING_UTXO       — UTxO at BOOTSTRAP_ADDR funding the cert deposit + fee.
#                        Needs ≈ 5 ADA (cert deposit ~2 ADA + fee + change).
#   COLLATERAL_UTXO    — separate ada-only UTxO ≥ 5 ADA. Plutus execution
#                        requires collateral; mix_logic.publish is trivially
#                        True for RegisterCredential, so the collateral is
#                        never seized in practice.
#
# Writes: nothing to addresses.json; the cert registration's effect is on-chain
# state (the credential is now registered).

set -euo pipefail
source "$(dirname "$0")/_lib.sh"
bootstrap_init "04-register-mix-logic"

: "${FUNDING_UTXO:?FUNDING_UTXO required}"
: "${COLLATERAL_UTXO:?COLLATERAL_UTXO required}"

if [[ "$FUNDING_UTXO" == "$COLLATERAL_UTXO" ]]; then
  echo "04-register-mix-logic: FUNDING_UTXO and COLLATERAL_UTXO must differ" >&2
  exit 1
fi

MIX_LOGIC_REF=$(jq -r '.referenceScriptUtxos.mix_logic // empty' "$ARTIFACTS_DIR/addresses.json")
if [[ -z "$MIX_LOGIC_REF" ]]; then
  echo "04-register-mix-logic: addresses.json doesn't have referenceScriptUtxos.mix_logic — run 02-publish-mix-logic.sh first and wait for confirmation" >&2
  exit 1
fi

EMPTY_REDEEMER_FILE="$ARTIFACTS_DIR/empty-redeemer.json"
echo '{"constructor":0,"fields":[]}' > "$EMPTY_REDEEMER_FILE"

STAKE_REG_CERT="$ARTIFACTS_DIR/mix_logic-stake-registration.cert"
KEY_DEPOSIT=$(cardano-cli conway query protocol-parameters --testnet-magic "$TESTNET_MAGIC" | jq -r '.stakeAddressDeposit')
cardano-cli conway stake-address registration-certificate \
  --stake-script-file "$ARTIFACTS_DIR/mix_logic.plutus" \
  --key-reg-deposit-amt "$KEY_DEPOSIT" \
  --out-file "$STAKE_REG_CERT"

TX_RAW="$ARTIFACTS_DIR/04-register-mix-logic.txraw"

cardano-cli conway transaction build \
  --testnet-magic "$TESTNET_MAGIC" \
  --tx-in "$FUNDING_UTXO" \
  --tx-in-collateral "$COLLATERAL_UTXO" \
  --certificate-file "$STAKE_REG_CERT" \
  --certificate-tx-in-reference "$MIX_LOGIC_REF" \
  --certificate-plutus-script-v3 \
  --certificate-redeemer-file "$EMPTY_REDEEMER_FILE" \
  --change-address "$BOOTSTRAP_ADDR" \
  --out-file "$TX_RAW"

cardano-cli conway transaction sign \
  --tx-body-file "$TX_RAW" \
  --signing-key-file "$PAYMENT_SKEY" \
  --testnet-magic "$TESTNET_MAGIC" \
  --out-file "$ARTIFACTS_DIR/04-register-mix-logic.tx"

cardano-cli conway transaction submit \
  --testnet-magic "$TESTNET_MAGIC" \
  --tx-file "$ARTIFACTS_DIR/04-register-mix-logic.tx"

TX_ID=$(cardano-cli conway transaction txid --tx-file "$ARTIFACTS_DIR/04-register-mix-logic.tx")
echo "04-register-mix-logic: submitted txid $TX_ID"
echo "04-register-mix-logic: mix_logic stake credential registered. Withdraw-zero spends are now valid."
